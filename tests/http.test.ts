import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
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
import { newScene } from '../src/cli/ops.ts'

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
function raw(url: string, options: { method?: string; host?: string; body?: string } = {}): Promise<{ status: number; body: string; location?: string; type?: string }> {
  const target = new URL(url)
  return new Promise((done, fail) => {
    const req = request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: options.method ?? 'GET', headers: { host: options.host ?? target.host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => done({ status: res.statusCode ?? 0, body, location: res.headers.location, type: res.headers['content-type'] }))
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
  for (const expected of ['guide', 'new_scene', 'scenes', 'open_viewer', 'show', 'check', 'render', 'query', 'read_scene', 'set', 'remove', 'write_scene', 'export', 'fetch_model', 'history', 'undo', 'restore', 'variants', 'create_variant', 'delete_variant', 'compare', 'calibrate_plan']) assert.ok(names.includes(expected), expected)
  for (const tool of tools) {
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, { pattern?: string; type?: string }>
    for (const forbidden of ['path', 'out', 'file', 'plan', 'image']) assert.ok(!(forbidden in properties), `${tool.name} takes "${forbidden}"`)
    for (const name of ['scene', 'a', 'b']) if (name in properties && properties[name].type === 'string') assert.ok(properties[name].pattern, `${tool.name}'s ${name} has no pattern`)
    if ('scene' in properties) assert.ok(properties.scene.pattern, `${tool.name}'s scene has no pattern`)
  }
  const { prompts } = await client.listPrompts()
  assert.ok(!prompts.some((p) => p.name === 'from-floor-plan'), 'the floor plan prompt needs a local file')
  assert.match(client.getInstructions() ?? '', /^# This Stage server/)
})

// claude.ai never shows the model a server's instructions or its resources;
// a tool's result is the one thing every client passes on.
test('the guide is also a tool, listed first, that returns the instructions word for word', async () => {
  const { tools } = await client.listTools()
  const tool = tools[0]
  assert.equal(tool.name, 'guide')
  assert.deepEqual(tool.inputSchema.properties ?? {}, {})
  assert.equal(tool.annotations?.readOnlyHint, true)
  assert.match(tool.description ?? '', /Stage/)
  assert.match(tool.description ?? '', /before any other/)
  const reply = await call('guide', {})
  assert.equal(reply.isError, false)
  assert.equal(reply.text, client.getInstructions())
  assert.match(reply.text, /^# This Stage server/)
  assert.ok(reply.text.length > 5000, `only ${reply.text.length} characters`)
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

test('history, undo and restore over HTTP, with the note kept', async () => {
  await call('new_scene', { scene: 'versions/main', from: 'room' })
  const desk = { id: 'desk', asset: 'table/desk', room: 'room', at: [1, 1] }
  assert.equal((await call('set', { scene: 'versions/main', collection: 'items', entity: desk, note: 'a desk to start' })).isError, false)
  assert.equal((await call('set', { scene: 'versions/main', collection: 'items', entity: { ...desk, at: [2, 1] } })).isError, false)
  const history = (await call('history', { scene: 'versions/main' })).text.split('\n')
  assert.match(history[0], /^3 \(current\) .* set items desk, undo goes to 2$/)
  assert.match(history[1], /^2 .* set items desk: a desk to start, undo goes to 1$/)
  assert.match(history[2], /^1 .* created$/)

  const undo = await call('undo', { scene: 'versions/main' })
  assert.match(undo.text, /^undo: back to version 2; versions\/main is now version 4/)
  assert.match((await call('read_scene', { scene: 'versions/main' })).text, /"at": \[\s*1,\s*1\s*\]/)
  assert.match((await call('restore', { scene: 'versions/main', version: 1 })).text, /^restored version 1; versions\/main is now version 5/)
  assert.doesNotMatch((await call('read_scene', { scene: 'versions/main' })).text, /"desk"/)
  assert.match((await call('restore', { scene: 'versions/main', version: 5 })).text, /already the current one/)
  assert.match((await call('history', { scene: 'versions/main', limit: 2 })).text, /\.\.\. 3 older$/)
})

test('variants over HTTP: copy, list, keep apart, and keep one', async () => {
  await call('new_scene', { scene: 'cabin/main', from: 'room' })
  const created = await call('create_variant', { scene: 'cabin/main', variant: 'bunks' })
  assert.equal(created.isError, false, created.text)
  assert.deepEqual(JSON.parse(created.text), { scene: 'cabin/bunks', viewer: `${PUBLIC}/?scene=cabin/bunks` })
  await call('set', { scene: 'cabin/bunks', collection: 'items', entity: { id: 'bed', asset: 'bed/single', room: 'room', at: [1, 1] } })
  assert.doesNotMatch((await call('read_scene', { scene: 'cabin/main' })).text, /"bed"/)
  const listed = (await call('variants', { project: 'cabin' })).text.split('\n')
  assert.match(listed[0], /^cabin\/bunks {2}version 2, .*: set items bed$/)
  assert.match(listed[1], /^cabin\/main {2}version 1, .*: created$/)
  assert.match((await call('variants', { project: 'nope' })).text, /no project is called "nope"/)
  assert.equal((await call('variants', { project: '../x' })).isError, true)
  assert.equal((await call('create_variant', { scene: 'cabin/main', variant: '../x' })).isError, true)
  assert.match((await call('create_variant', { scene: 'cabin/main', variant: 'bunks' })).text, /already exists/)

  assert.match((await call('delete_variant', { scene: 'cabin/bunks' })).text, /^deleted cabin\/bunks/)
  const last = await call('delete_variant', { scene: 'cabin/main' })
  assert.equal(last.isError, true)
  assert.match(last.text, /the only variant of cabin/)
  assert.doesNotMatch((await call('scenes', {})).text, /cabin\/bunks/)
})

test('calibrate_plan writes the scale only when every check agrees', async () => {
  await call('new_scene', { scene: 'drawn/main', from: 'room' })
  await mkdir(join(root, 'drawn', 'main', 'plans'), { recursive: true })
  await writeFile(join(root, 'drawn', 'main', 'plans', 'ground.png'), 'not really a png')
  const level = JSON.parse((await call('read_scene', { scene: 'drawn/main' })).text).levels[0].id
  const base = { scene: 'drawn/main', level, drawing: 'plans/ground.png', a: [100, 500], b: [600, 500], distance: 10 }

  const off = await call('calibrate_plan', { ...base, checks: [{ a: [100, 500], b: [100, 0], distance: 9.7 }] })
  assert.match(off.text, /check 9.7 m: measured 10.000 m, 3.09% TOO FAR OFF/)
  assert.match(off.text, /nothing written/)
  assert.equal(JSON.parse((await call('read_scene', { scene: 'drawn/main' })).text).levels[0].plan, undefined)

  const good = await call('calibrate_plan', { ...base, checks: [{ a: [100, 500], b: [100, 0], distance: 10.02 }], opacity: 0.5 })
  assert.equal(good.isError, false, good.text)
  assert.match(good.text, /^scale 50.000 px\/m, origin \[100.0, 500.0\]/)
  assert.deepEqual(JSON.parse((await call('read_scene', { scene: 'drawn/main' })).text).levels[0].plan, { image: 'plans/ground.png', scale: 50, origin: [100, 500], opacity: 0.5 })
  assert.match((await call('history', { scene: 'drawn/main' })).text, /calibrated the drawing of level/)

  for (const drawing of ['../../../etc/passwd', 'plans/missing.png', '/etc/passwd']) {
    const reply = await call('calibrate_plan', { ...base, drawing })
    assert.equal(reply.isError, true, drawing)
    assert.match(reply.text, /beside the scene/)
  }
  assert.match((await call('calibrate_plan', { ...base, level: 'roof' })).text, /no level is called "roof"/)
})

test('compare names the differences between two variants', async () => {
  await call('new_scene', { scene: 'study/a', from: 'room' })
  await call('set', { scene: 'study/a', collection: 'items', entity: { id: 'desk', asset: 'table/desk', room: 'room', at: [1, 1] } })
  await call('create_variant', { scene: 'study/a', variant: 'b' })
  await call('set', { scene: 'study/b', collection: 'items', entity: { id: 'desk', asset: 'table/desk', room: 'room', at: [2, 1] } })
  // Only the text: a broken scene stops before any render, so no browser.
  await call('write_scene', { scene: 'study/b', json: JSON.stringify({ ...JSON.parse((await call('read_scene', { scene: 'study/b' })).text), items: [{ id: 'desk', asset: 'table/desk', room: 'nowhere', at: [2, 1] }] }) })
  const reply = await call('compare', { a: 'study/a', b: 'study/b' })
  assert.match(reply.text, /^from study\/a to study\/b:\n~ item desk: room "room" -> "nowhere"; at \[1,1\] -> \[2,1\]/)
  assert.match(reply.text, /study\/b has errors, so neither is rendered/)
  assert.equal((await call('compare', { a: 'study/a', b: '../x' })).isError, true)
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

  // The list behind the viewer's scene picker.
  const list = await raw(`${base}/api/scenes`)
  assert.equal(list.status, 200)
  assert.ok(JSON.parse(list.body).scenes.includes('house/served'))
  const single = await startServer(0)
  try {
    assert.equal((await raw(`${single.url.replace(/\/$/, '')}/api/scenes`)).status, 404)
  } finally {
    await single.close()
  }
})

// Opened bare, with no ?scene=, the page takes itself for a share bundle and
// looks for scene.json beside it. A server of named scenes sends a bare
// visit to a scene instead, and says so when it has none.
test('the bare address of a viewer of named scenes opens a scene', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'stage-home-'))
  const store = new FileSceneStore(folder)
  const home = await startServer(0, { store })
  try {
    const base = home.url.replace(/\/$/, '')
    const empty = await raw(`${base}/`)
    assert.equal(empty.status, 200)
    assert.match(empty.type ?? '', /^text\/plain/)
    assert.match(empty.body, /No scenes yet/)

    await newScene('house/office', 'Office', 'room', store)
    const onlyOffice = await raw(`${base}/`)
    assert.equal(onlyOffice.status, 302)
    assert.equal(onlyOffice.location, '/?scene=house/office')

    await newScene('house/main', 'House', 'room', store)
    await newScene('barn/loft', 'Loft', 'room', store)
    assert.equal((await raw(`${base}/`)).location, '/?scene=house/main')
    assert.equal((await raw(`${base}/?scene=&walk`)).location, '/?scene=house/main&walk=')
    const opened = await raw(`${base}/?scene=house/office`)
    assert.equal(opened.status, 200)
    assert.match(opened.body, /^<!doctype html>/i)
  } finally {
    await home.close()
  }
  const single = await startServer(0)
  try {
    assert.equal((await raw(`${single.url.replace(/\/$/, '')}/`)).status, 200)
  } finally {
    await single.close()
  }
})

// claude.ai loads a few tools at a time by search, so whichever ones it
// loads must say they are Stage's and point at the guide.
test('every other tool says it is Stage and points at the guide', async () => {
  const { tools } = await client.listTools()
  assert.ok(tools.length > 20)
  for (const tool of tools.slice(1)) {
    assert.match(tool.description ?? '', /[.)] Part of Stage, the 3D scene tool\. If the Stage guide is not in your context yet, call the `guide` tool first\.$/, tool.name)
    assert.equal((tool.description ?? '').match(/Part of Stage/g)?.length, 1, tool.name)
  }
  assert.doesNotMatch(tools[0].description ?? '', /Part of Stage/)
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
    assert.equal(tools[0].name, 'guide')
    const guide = (await local.callTool({ name: 'guide', arguments: {} })) as { content: { text: string }[]; isError?: boolean }
    assert.ok(!guide.isError)
    assert.equal(guide.content[0].text, local.getInstructions())
    for (const tool of tools.slice(1)) assert.match(tool.description ?? '', /call the `guide` tool first\.$/, tool.name)

    const folder = await mkdtemp(join(tmpdir(), 'stage-local-'))
    const reply = (await local.callTool({ name: 'new_scene', arguments: { path: join(folder, 'flat'), from: 'room' } })) as { content: { text: string }[]; isError?: boolean }
    assert.ok(!reply.isError, reply.content[0].text)
    assert.equal(JSON.parse(reply.content[0].text).scene, join(folder, 'flat', 'scene.json'))
  } finally {
    await local.close()
    await server.close()
  }
})
