import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import { Renderer } from '../src/cli/render.ts'

// Renders through headless Chromium, so slower than the core tests. Run
// with: npm run test:render

const scene = new URL('../examples/flat/scene.json', import.meta.url).pathname
let renderer: Renderer

before(async () => {
  renderer = await Renderer.start()
})

after(async () => {
  await renderer.close()
})

test('the same scene renders the same pixels', async () => {
  const hash = (png: Buffer) => createHash('sha256').update(png).digest('hex')
  const first = await renderer.render(scene, { camera: 'plan', width: 640, height: 360, timeout: 90000 })
  const second = await renderer.render(scene, { camera: 'plan', width: 640, height: 360, timeout: 90000 })
  assert.ok(first.length > 20000, 'a real image, not a blank frame')
  assert.equal(hash(first), hash(second))
})

test('a plan of one level renders over the levels below', async () => {
  const house = new URL('../examples/two-storey/scene.json', import.meta.url).pathname
  const png = await renderer.render(house, { camera: 'plan:first', width: 480, height: 270, timeout: 90000 })
  assert.ok(png.length > 10000)
})

test('every example camera renders', async () => {
  for (const camera of ['orbit', 'plan', 'from-door', 'kitchen-view']) {
    const png = await renderer.render(scene, { camera, width: 480, height: 270, timeout: 90000 })
    assert.ok(png.length > 10000, `${camera} rendered an image`)
  }
})

// Golden renders: every example, from above and from the overview, against
// the images in tests/golden. A missing golden is written; set
// UPDATE_GOLDENS=1 to rewrite them all after a deliberate change.
test('every example matches its golden renders', async () => {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const { meanDifference } = await import('./png.ts')
  const dir = new URL('./golden/', import.meta.url).pathname
  await mkdir(dir, { recursive: true })
  for (const example of ['flat', 'flat-with-bedroom', 'two-storey', 'desk']) {
    for (const camera of ['orbit', 'plan']) {
      const path = `${dir}${example}-${camera}.png`
      const png = await renderer.render(new URL(`../examples/${example}/scene.json`, import.meta.url).pathname, { camera, width: 480, height: 270, timeout: 120000 })
      if (!existsSync(path) || process.env.UPDATE_GOLDENS) {
        await writeFile(path, png)
        continue
      }
      const difference = meanDifference(await readFile(path), png)
      assert.ok(difference < 8, `${example} from ${camera} drifted from its golden by ${difference.toFixed(1)} (of 255); UPDATE_GOLDENS=1 if that was intended`)
    }
  }
})

// A level's drawing lies under the plan view. The drawing here is plain
// magenta, so any magenta in the render is the drawing.
test("a level's drawing shows in the plan view", async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { decodePng, encodePng } = await import('./png.ts')
  const { starterScene } = await import('../src/cli/ops.ts')
  const folder = await mkdtemp(join(tmpdir(), 'stage-drawing-'))
  await writeFile(join(folder, 'plan.png'), encodePng(200, 160, () => [255, 0, 255]))
  const magenta = (png: Buffer) => {
    const { data, channels } = decodePng(png)
    let count = 0
    for (let i = 0; i < data.length; i += channels) if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] > 180) count++
    return count
  }
  const scene = (await starterScene('Drawn', 'room')) as { levels: Record<string, unknown>[] }
  const file = join(folder, 'scene.json')
  await writeFile(file, JSON.stringify(scene))
  const bare = await renderer.render(file, { camera: 'plan:ground', width: 480, height: 270, timeout: 90000 })
  assert.equal(magenta(bare), 0)
  // 20 px a meter, plan [0, 0] at pixel (40, 120): the drawing spans -2 to
  // 8 m east and -2 to 6 m north, all of the 4 by 3 m room and around it.
  scene.levels[0].plan = { image: 'plan.png', scale: 20, origin: [40, 120], opacity: 1 }
  await writeFile(file, JSON.stringify(scene))
  const drawn = await renderer.render(file, { camera: 'plan:ground', width: 480, height: 270, timeout: 90000 })
  assert.ok(magenta(drawn) > 480 * 270 * 0.2, `the drawing covers ${magenta(drawn)} pixels`)
  const orbit = await renderer.render(file, { camera: 'orbit', width: 480, height: 270, timeout: 90000 })
  assert.equal(magenta(orbit), 0, 'the drawing is for the plan view only')
})

// compare renders both variants from one camera, side by side.
test('compare shows two variants side by side', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const { startMcpHttp } = await import('../src/cli/mcp.ts')
  const { decodePng } = await import('./png.ts')
  const mcp = await startMcpHttp({ root: await mkdtemp(join(tmpdir(), 'stage-compare-')), port: 0 })
  const client = new Client({ name: 'stage-test', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)))
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string; data?: string }[]; isError?: boolean }
    await call('new_scene', { scene: 'study/a', from: 'room' })
    await call('set', { scene: 'study/a', collection: 'items', entity: { id: 'desk', asset: 'table/desk', room: 'room', at: [1, 1] } })
    await call('create_variant', { scene: 'study/a', variant: 'b' })
    await call('set', { scene: 'study/b', collection: 'items', entity: { id: 'desk', asset: 'table/desk', room: 'room', at: [2.5, 1.5] } })
    const reply = await call('compare', { a: 'study/a', b: 'study/b', width: 400, height: 300 })
    assert.ok(!reply.isError, reply.content[0].text)
    assert.match(reply.content[0].text!, /~ item desk: at \[1,1\] -> \[2.5,1.5\]/)
    assert.match(reply.content[0].text!, /camera object:room:top$/)
    const image = reply.content.find((c) => c.type === 'image')!
    const { width, height } = decodePng(Buffer.from(image.data!, 'base64'))
    assert.deepEqual([width, height], [808, 332])
  } finally {
    await client.close()
    await mcp.close()
  }
})
