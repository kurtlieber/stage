import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FileSceneStore, PathSceneStore, SCENE_NAME } from '../src/core/scene-store.ts'
import { checkScene, newScene, removeEntity, upsert } from '../src/cli/ops.ts'
import { format } from '../src/core/store.ts'

const temp = () => mkdtemp(join(tmpdir(), 'stage-store-'))
const scene = (name = 'Test') => ({ version: 1, name, items: [] })

// Every file under a folder, relative to it.
async function files(root: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name).slice(root.length + 1))
  }
  return found.sort()
}

test('a scene name is project/variant and nothing else', () => {
  for (const good of ['house/main', 'house/plan-b', 'h2/v1', 'a/b']) assert.ok(SCENE_NAME.test(good), good)
  for (const bad of ['', 'house', 'a/b/c', '/abs/scene.json', '/house/main', '../x', 'house/..', '../house/main', 'House/main', 'house/main.json', '.cache/x', 'house/.git', 'a//b', '-a/b', 'house/main/', 'house\\main', 'house/main\n']) {
    assert.ok(!SCENE_NAME.test(bad), JSON.stringify(bad))
  }
})

test('a named store keeps each scene in its own folder inside the root', async () => {
  const root = await temp()
  const store = new FileSceneStore(root)
  assert.equal(store.locate('house/main'), join(root, 'house', 'main', 'scene.json'))
  for (const bad of ['../outside/x', '/etc/passwd', 'house/../../x', join(root, 'house/main/scene.json')]) {
    assert.throws(() => store.locate(bad), /is not a scene name; a scene name is project\/variant/, bad)
    await assert.rejects(store.read(bad), /is not a scene name/)
    await assert.rejects(store.create(bad, scene()), /is not a scene name/)
    await assert.rejects(store.write(bad, scene()), /is not a scene name/)
  }
  assert.deepEqual(await files(root), [])
})

test('a named store creates a scene once, and names it in errors', async () => {
  const root = await temp()
  const store = new FileSceneStore(root)
  assert.equal(await store.create('house/main', scene()), 'house/main')
  assert.deepEqual(await store.read('house/main'), scene())
  await assert.rejects(store.create('house/main', scene('Other')), /a scene called "house\/main" already exists/)
  assert.deepEqual(await store.read('house/main'), scene())

  await assert.rejects(store.read('house/nope'), (error: Error) => {
    assert.match(error.message, /house\/nope/)
    assert.ok(!error.message.includes(root), `the error shows the server's folder: ${error.message}`)
    return true
  })
  await assert.rejects(store.mutate('house/nope', () => {}), /no scene is called "house\/nope"/)

  await writeFile(store.locate('house/main'), '{ not json')
  await assert.rejects(store.read('house/main'), (error: Error) => !error.message.includes(root))
})

test('writers to one scene take turns, so every change lands', async () => {
  const root = await temp()
  const store = new FileSceneStore(root)
  await store.create('house/main', scene())
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.mutate('house/main', async (raw) => {
        const items = raw.items as unknown[]
        await new Promise((done) => setTimeout(done, Math.random() * 5))
        items.push({ id: `item-${i}` })
      }),
    ),
  )
  const items = ((await store.read('house/main')) as { items: { id: string }[] }).items
  assert.equal(items.length, 20)
  assert.deepEqual(new Set(items.map((item) => item.id)).size, 20)
  assert.deepEqual(await files(root), ['house/main/scene.json'])
})

test('a change that throws writes nothing, and the next one still runs', async () => {
  const root = await temp()
  const store = new FileSceneStore(root)
  await store.create('house/main', scene())
  const before = await readFile(store.locate('house/main'), 'utf8')
  await assert.rejects(
    store.mutate('house/main', (raw) => {
      raw.name = 'Changed'
      throw new Error('no')
    }),
    /no/,
  )
  assert.equal(await readFile(store.locate('house/main'), 'utf8'), before)
  await store.mutate('house/main', (raw) => {
    raw.name = 'After'
  })
  assert.equal(((await store.read('house/main')) as { name: string }).name, 'After')
  assert.deepEqual(await files(root), ['house/main/scene.json'])
})

test('a store refuses a scene file that holds no JSON object', async () => {
  const root = await temp()
  const store = new FileSceneStore(root)
  await store.create('house/main', scene())
  await writeFile(store.locate('house/main'), '[1, 2]')
  await assert.rejects(store.mutate('house/main', () => {}), /house\/main is not a scene/)
})

test('the list is every scene by name, and skips hidden or odd folders', async () => {
  const root = await temp()
  const store = new FileSceneStore(root)
  assert.deepEqual(await store.list(), [])
  await store.create('house/main', scene())
  await store.create('house/alt', scene())
  await store.create('cabin/main', scene())
  await mkdir(join(root, '.cache', 'stage'), { recursive: true })
  await writeFile(join(root, '.cache', 'stage', 'scene.json'), '{}')
  await mkdir(join(root, 'house', 'empty'), { recursive: true })
  await mkdir(join(root, 'Upper', 'main'), { recursive: true })
  await writeFile(join(root, 'Upper', 'main', 'scene.json'), '{}')
  assert.deepEqual(await store.list(), ['cabin/main', 'house/alt', 'house/main'])
  assert.deepEqual(await new FileSceneStore(join(root, 'missing')).list(), [])
})

test('an example is copied byte for byte, and a template is canonical', async () => {
  const root = await temp()
  const store = new FileSceneStore(root)
  for (const example of ['flat', 'two-storey', 'desk']) {
    await newScene(`copy/${example}`, 'ignored', example, store)
    const copy = await readFile(store.locate(`copy/${example}`), 'utf8')
    assert.equal(copy, await readFile(new URL(`../examples/${example}/scene.json`, import.meta.url), 'utf8'), example)
  }
  await newScene('copy/room', 'Room', 'room', store)
  const text = await readFile(store.locate('copy/room'), 'utf8')
  assert.equal(text, format(JSON.parse(text)))
  await assert.rejects(newScene('copy/nope', 'x', 'nope', store), /no example is called "nope"/)
  assert.ok(!existsSync(join(root, 'copy', 'nope')))
})

test('the path store keeps the command line working with file paths', async () => {
  const root = await temp()
  const store = new PathSceneStore()
  assert.equal(store.named, false)
  const file = await store.create(join(root, 'flat'), scene())
  assert.equal(file, join(root, 'flat', 'scene.json'))
  assert.equal(await store.create(join(root, 'other.json'), scene()), join(root, 'other.json'))
  await assert.rejects(store.create(join(root, 'flat'), scene()), /already exists/)
  await assert.rejects(store.list(), /cannot be listed/)
})

test('the scene operations work on a named store', async () => {
  const root = await temp()
  const store = new FileSceneStore(root)
  assert.equal(await newScene('house/main', 'House', 'room', store), 'house/main')
  assert.equal((await checkScene('house/main', store)).ok, true)
  const desk = { id: 'desk', asset: 'table/desk', room: 'room', at: [1, 1] }
  const added = await upsert('house/main', 'items', desk, store)
  assert.equal(added.replaced, false)
  assert.equal((await upsert('house/main', 'items', { ...desk, at: [1.5, 1] }, store)).replaced, true)
  const items = ((await store.read('house/main')) as { items: { id: string; at: number[] }[] }).items
  assert.deepEqual(items.find((item) => item.id === 'desk')?.at, [1.5, 1])
  assert.equal((await removeEntity('house/main', 'desk', store)).collection, 'items')
  await assert.rejects(removeEntity('house/main', 'desk', store), /nothing in house\/main has the id "desk"/)
  assert.deepEqual(await files(root), ['house/main/scene.json'])
})

test('remove finds objects and materials too', async () => {
  const root = await temp()
  const store = new FileSceneStore(root)
  await newScene('house/main', 'House', 'empty', store)
  await store.mutate('house/main', (raw) => {
    raw.objects = [{ id: 'box', parts: [{ shape: 'box', size: [1, 1, 1] }] }]
    raw.materials = [{ id: 'oak', color: '#a07040' }]
  })
  assert.equal((await removeEntity('house/main', 'box', store)).collection, 'objects')
  assert.equal((await removeEntity('house/main', 'oak', store)).collection, 'materials')
})
