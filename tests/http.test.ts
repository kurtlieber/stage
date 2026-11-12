import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { FileSceneStore } from '../src/core/scene-store.ts'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { LOCAL, buildMcp, startMcpHttp, type McpHttpServer } from '../src/cli/mcp.ts'
import { sceneToken, startServer, type StageServer } from '../src/cli/server.ts'

// The shared server: MCP over HTTP with scenes by name, beside a viewer that
// serves the same folder. Nothing here needs a browser.

const PUBLIC = 'https://viewer.example'
let root: string
let viewer: StageServer
let mcp: McpHttpServer
let client: Client

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'stage-http-'))
  viewer = await startServer(0, { store: new FileSceneStore(root), allowedHosts: ['viewer.example'] })
  mcp = await startMcpHttp({ root, port: 0, publicUrl: PUBLIC, viewerUrl: viewer.url, allowedHosts: ['mcp.example'] })
  client = new Client({ name: 'stage-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)))
})

after(async () => {
  await client?.close()
  await mcp?.close()
  await viewer?.close()
})

type Reply = { text: string; isError: boolean }
async function call(name: string, args: Record<string, unknown>): Promise<Reply> {
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean }
    return { text: result.content.map((c) => c.text ?? '').join('\n'), isError: result.isError === true }
  } catch (error) {
    return { text: (error as Error).message, isError: true }
  }
}

// A raw request, so the test can send any Host header.
function raw(url: string, options: { method?: string; host?: string; body?: string } = {}): Promise<{ status: number; body: string }> {
  const target = new URL(url)
  return new Promise((done, fail) => {
    const req = request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: options.method ?? 'GET', headers: { host: options.host ?? target.host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => done({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', fail)
    req.end(options.body)
  })
}

async function allFiles(folder: string): Promise<string[]> {
  return (await readdir(folder, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(folder.length + 1)).sort()
}

test('no tool takes a file path, and every scene argument must be a name', async () => {
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  for (const expected of ['new_scene', 'scenes', 'open_viewer', 'show', 'check', 'render', 'query', 'read_scene', 'set', 'remove', 'write_scene', 'export', 'fetch_model']) assert.ok(names.includes(expected), expected)
  for (const tool of tools) {
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, { pattern?: string; type?: string }>
    for (const forbidden of ['path', 'out', 'file', 'plan', 'image']) assert.ok(!(forbidden in properties), `${tool.name} takes "${forbidden}"`)
    if ('scene' in properties) assert.ok(properties.scene.pattern, `${tool.name}'s scene has no pattern`)
  }
  const { prompts } = await client.listPrompts()
  assert.ok(!prompts.some((p) => p.name === 'from-floor-plan'), 'the floor plan prompt needs a local file')
  assert.match(client.getInstructions() ?? '', /^# This Stage server/)
})

test('a scene is built by name over HTTP', async () => {
  assert.match((await call('scenes', {})).text, /no scenes yet/)
  const created = await call('new_scene', { scene: 'house/main', name: 'House', from: 'room' })
  assert.equal(created.isError, false, created.text)
  assert.ok(existsSync(join(root, 'house', 'main', 'scene.json')))

  const set = await call('set', { scene: 'house/main', collection: 'items', entity: { id: 'desk', asset: 'table/desk', room: 'room', at: [1, 1] } })
  assert.equal(set.isError, false, set.text)
  assert.doesNotMatch(set.text, /error/, set.text)
  assert.match((await call('read_scene', { scene: 'house/main' })).text, /"desk"/)
  assert.equal((await call('check', { scene: 'house/main' })).isError, false)
  assert.equal((await call('query', { scene: 'house/main', question: 'rooms' })).isError, false)
  assert.match((await call('scenes', {})).text, /^house\/main$/m)

  const removed = await call('remove', { scene: 'house/main', id: 'desk' })
  assert.equal(removed.isError, false, removed.text)
  assert.doesNotMatch((await call('read_scene', { scene: 'house/main' })).text, /"desk"/)

  const again = await call('new_scene', { scene: 'house/main' })
  assert.equal(again.isError, true)
  assert.match(again.text, /already exists/)
  assert.doesNotMatch(again.text, new RegExp(root))
})

test('paths and climbing names are refused, and nothing is written', async () => {
  const before = await allFiles(root)
  for (const scene of ['/tmp/stage-escape/scene.json', '../escape', 'house/../../escape', join(root, 'house/main/scene.json'), 'house', 'House/Main']) {
    for (const [tool, args] of [
      ['new_scene', { scene }],
      ['read_scene', { scene }],
      ['set', { scene, collection: 'items', entity: { id: 'x', asset: 'table/desk', at: [0, 0] } }],
      ['write_scene', { scene, json: '{"version":1}' }],
      ['open_viewer', { scene }],
    ] as const) {
      const reply = await call(tool, args)
      assert.equal(reply.isError, true, `${tool} ${scene}: ${reply.text}`)
    }
  }
  assert.deepEqual(await allFiles(root), before)
  assert.ok(!existsSync('/tmp/stage-escape'))
})

test('open_viewer hands out a link on the public viewer', async () => {
  await call('new_scene', { scene: 'house/link' })
  const reply = await call('open_viewer', { scene: 'house/link' })
  assert.equal(reply.isError, false, reply.text)
  assert.equal(JSON.parse(reply.text).url, `${PUBLIC}/?scene=house/link`)
  assert.match((await call('open_viewer', { scene: 'house/missing' })).text, /no scene is called "house\/missing"/)
})

test('writes that arrive together all land', async () => {
  await call('new_scene', { scene: 'house/busy', from: 'room' })
  const replies = await Promise.all(
    Array.from({ length: 12 }, (_, i) => call('set', { scene: 'house/busy', collection: 'items', entity: { id: `chair-${i}`, asset: 'chair/dining', room: 'room', at: [1 + (i % 3) * 0.6, 1 + Math.floor(i / 3) * 0.5] } })),
  )
  for (const reply of replies) assert.equal(reply.isError, false, reply.text)
  const scene = JSON.parse((await call('read_scene', { scene: 'house/busy' })).text)
  assert.equal(scene.items.filter((item: { id: string }) => item.id.startsWith('chair-')).length, 12)
})

test('show reaches a viewer that has the scene open', async () => {
  await call('new_scene', { scene: 'house/shown', from: 'room' })
  assert.match((await call('show', { scene: 'house/shown', camera: 'plan' })).text, /no viewer has this scene open/)
  const events = new URL(`${viewer.url.replace(/\/$/, '')}/api/events?path=house/shown`)
  const received: string[] = []
  const stream = request({ hostname: events.hostname, port: events.port, path: events.pathname + events.search })
  await new Promise<void>((done, fail) => {
    stream.on('response', (res) => {
      res.on('data', (chunk) => {
        received.push(String(chunk))
        if (received.join('').includes('event: hello')) done()
      })
    })
    stream.on('error', fail)
    stream.end()
  })
  try {
    assert.match((await call('show', { scene: 'house/shown', camera: 'plan' })).text, /shown in 1 viewer$/)
    await new Promise((done) => setTimeout(done, 50))
    assert.match(received.join(''), /event: control\ndata: \{"camera":"plan"\}/)
  } finally {
    stream.destroy()
  }
})

test('the MCP server answers only its own hosts, and only POST', async () => {
  const health = `${mcp.url.replace(/\/mcp$/, '')}/health`
  assert.equal((await raw(health)).status, 200)
  assert.equal((await raw(health, { host: 'mcp.example' })).status, 200)
  assert.equal((await raw(health, { host: 'mcp.example:443' })).status, 200)
  assert.equal((await raw(health, { host: 'evil.example' })).status, 403)
  assert.equal((await raw(mcp.url, { method: 'POST', host: 'evil.example', body: '{}' })).status, 403)
  const get = await raw(mcp.url)
  assert.equal(get.status, 405)
  assert.equal((await raw(mcp.url, { method: 'DELETE' })).status, 405)
  assert.equal((await raw(`${health.replace(/\/health$/, '')}/other`)).status, 404)
})

test('the viewer serves scenes by name and no file outside the folder', async () => {
  await call('new_scene', { scene: 'house/served', from: 'room' })
  const base = viewer.url.replace(/\/$/, '')
  const ok = await raw(`${base}/api/scene?path=house/served`)
  assert.equal(ok.status, 200)
  assert.ok(JSON.parse(ok.body).scene)
  const missing = JSON.parse((await raw(`${base}/api/scene?path=house/nope`)).body)
  assert.match(missing.error, /^house\/nope: /)
  assert.ok(!missing.error.includes(root), missing.error)
  const absolute = join(root, 'house/served/scene.json')
  assert.equal((await raw(`${base}/api/scene?path=${encodeURIComponent(absolute)}`)).status, 400)
  assert.equal((await raw(`${base}/api/scene?path=../escape`)).status, 400)
  assert.equal((await raw(`${base}/files/${sceneToken(absolute)}/scene.json`)).status, 404)
  assert.equal((await raw(`${base}/files/${sceneToken('/etc/passwd')}/passwd`)).status, 404)
  assert.equal((await raw(`${base}/files/${sceneToken('house/served')}/scene.json`)).status, 200)
  assert.equal((await raw(`${base}/files/${sceneToken('house/served')}/..%2F..%2Fother%2Fscene.json`)).status, 404)
  assert.equal((await raw(`${base}/api/scene?path=house/served`, { host: 'viewer.example' })).status, 200)
  assert.equal((await raw(`${base}/api/scene?path=house/served`, { host: 'evil.example' })).status, 403)
})

test('the local server keeps file paths, as before', async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = buildMcp(LOCAL)
  await server.connect(serverSide)
  const local = new Client({ name: 'stage-test', version: '1' })
  await local.connect(clientSide)
  try {
    const { tools } = await local.listTools()
    const byName = new Map(tools.map((t) => [t.name, (t.inputSchema.properties ?? {}) as Record<string, { pattern?: string }>]))
    assert.ok(!byName.has('scenes'))
    assert.ok('path' in byName.get('new_scene')!)
    assert.ok('out' in byName.get('export')!)
    assert.equal(byName.get('set')!.scene.pattern, undefined)
    assert.ok((await local.listPrompts()).prompts.some((p) => p.name === 'from-floor-plan'))
    assert.doesNotMatch(local.getInstructions() ?? '', /^# This Stage server/)

    const folder = await mkdtemp(join(tmpdir(), 'stage-local-'))
    const reply = (await local.callTool({ name: 'new_scene', arguments: { path: join(folder, 'flat'), from: 'room' } })) as { content: { text: string }[]; isError?: boolean }
    assert.ok(!reply.isError, reply.content[0].text)
    assert.equal(JSON.parse(reply.content[0].text).scene, join(folder, 'flat', 'scene.json'))
  } finally {
    await local.close()
    await server.close()
  }
})
