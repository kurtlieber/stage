import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FileSceneStore } from '../src/core/scene-store.ts'

// History and variants in the shared store: every write keeps the scene it
// replaces, undo and restore bring one back as a new version, and a variant
// is a copy with a history of its own.

const temp = () => mkdtemp(join(tmpdir(), 'stage-history-'))
const scene = (name: string) => ({ version: 1, name, items: [] as unknown[] })
const nameOf = async (store: FileSceneStore, name: string) => ((await store.read(name)) as { name: string }).name
const rename = (to: string) => (raw: Record<string, unknown>) => {
  raw.name = to
}

test('every write keeps the scene it replaces, with what changed', async () => {
  const store = new FileSceneStore(await temp())
  await store.create('house/main', scene('A'))
  await store.mutate('house/main', rename('B'), 'renamed to B')
  await store.write('house/main', scene('C'), 'rewrote as C')
  await store.mutate('house/main', rename('D'))

  const { current, versions } = await store.history('house/main')
  assert.equal(current, 4)
  assert.deepEqual(
    versions.map((v) => [v.version, v.change, v.back]),
    [
      [4, 'changed the scene', 3],
      [3, 'rewrote as C', 2],
      [2, 'renamed to B', 1],
      [1, 'created', null],
    ],
  )
  for (const [version, name] of [[1, 'A'], [2, 'B'], [3, 'C'], [4, 'D']] as const) assert.equal(((await store.version('house/main', version)) as { name: string }).name, name)
  const folder = join(store.root, 'house', 'main', 'history')
  assert.deepEqual((await readdir(folder)).sort(), ['1.json', '2.json', '3.json', 'log.json'])
})

test('a write that changes nothing is not a new version', async () => {
  const store = new FileSceneStore(await temp())
  await store.create('house/main', scene('A'))
  await store.mutate('house/main', () => {})
  await store.write('house/main', scene('A'))
  assert.equal((await store.history('house/main')).current, 1)
  assert.ok(!existsSync(join(store.root, 'house', 'main', 'history', '1.json')))
})

test('undo walks back, and a restore is a new version that loses nothing', async () => {
  const store = new FileSceneStore(await temp())
  await store.create('house/main', scene('A'))
  await store.mutate('house/main', rename('B'))
  await store.mutate('house/main', rename('C'))

  assert.deepEqual(await store.undo('house/main'), { ...(await store.history('house/main')).versions[0], version: 4, change: 'undo: back to version 2', back: 1 })
  assert.equal(await nameOf(store, 'house/main'), 'B')
  assert.equal((await store.undo('house/main')).version, 5)
  assert.equal(await nameOf(store, 'house/main'), 'A')
  await assert.rejects(store.undo('house/main'), /nothing to undo: version 5 of house\/main is the first/)

  const restored = await store.restore('house/main', 3)
  assert.deepEqual([restored.version, restored.change, restored.back], [6, 'restored version 3', 2])
  assert.equal(await nameOf(store, 'house/main'), 'C')
  // Undo after a restore goes to what came before the restored version.
  await store.undo('house/main')
  assert.equal(await nameOf(store, 'house/main'), 'B')

  const { versions } = await store.history('house/main')
  assert.equal(versions.length, 7)
  for (const [version, name] of [[1, 'A'], [2, 'B'], [3, 'C'], [4, 'B'], [5, 'A'], [6, 'C'], [7, 'B']] as const) assert.equal(((await store.version('house/main', version)) as { name: string }).name, name, `version ${version}`)
})

test('undo is still a step when the scene already matches', async () => {
  const store = new FileSceneStore(await temp())
  await store.create('house/main', scene('A'))
  await store.mutate('house/main', rename('B'))
  await store.mutate('house/main', rename('A'))
  // Version 3 reads as version 1 did, so undo to 2 changes the text, and a
  // second undo to 1 brings back text equal to version 3's: still recorded.
  await store.undo('house/main')
  const step = await store.undo('house/main')
  assert.deepEqual([step.version, step.back], [5, null])
  assert.equal(await nameOf(store, 'house/main'), 'A')
  assert.equal(((await store.version('house/main', 4)) as { name: string }).name, 'B')
})

test('restore refuses the current version and one that never was, naming the scene', async () => {
  const store = new FileSceneStore(await temp())
  await store.create('house/main', scene('A'))
  await store.mutate('house/main', rename('B'))
  await assert.rejects(store.restore('house/main', 2), /version 2 is already the current one of house\/main/)
  await assert.rejects(store.restore('house/main', 9), (error: Error) => {
    assert.match(error.message, /house\/main has no version 9; it has versions 1 to 2/)
    assert.ok(!error.message.includes(store.root), error.message)
    return true
  })
  await assert.rejects(store.history('house/nope'), /no scene is called "house\/nope"/)
})

test('a scene from before history was kept starts as version 1', async () => {
  const store = new FileSceneStore(await temp())
  const file = store.locate('house/old')
  await mkdir(join(store.root, 'house', 'old'), { recursive: true })
  await writeFile(file, `${JSON.stringify(scene('Old'))}\n`)
  const before = await readFile(file, 'utf8')
  assert.deepEqual(
    (await store.history('house/old')).versions.map((v) => [v.version, v.change]),
    [[1, 'as it was before history was kept']],
  )
  await store.mutate('house/old', rename('New'), 'renamed')
  assert.equal((await store.history('house/old')).current, 2)
  await store.undo('house/old')
  assert.equal(await readFile(file, 'utf8'), before)
})

test('writes that arrive together each become a version', async () => {
  const store = new FileSceneStore(await temp())
  await store.create('house/main', scene('A'))
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.mutate('house/main', (raw) => void (raw.items as unknown[]).push({ id: `item-${i}` }), `added item-${i}`)))
  const { current, versions } = await store.history('house/main')
  assert.equal(current, 11)
  assert.deepEqual(versions.map((v) => v.version), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
  for (let n = 1; n <= 10; n++) assert.equal(((await store.version('house/main', n)) as { items: unknown[] }).items.length, n - 1)
})

test('a variant is a copy with its own history, and the two stay apart', async () => {
  const store = new FileSceneStore(await temp())
  await store.create('house/main', scene('Main'))
  await store.mutate('house/main', rename('Main 2'))
  const folder = join(store.root, 'house', 'main')
  await mkdir(join(folder, 'plans'), { recursive: true })
  await writeFile(join(folder, 'plans', 'ground.png'), 'drawing')
  await mkdir(join(folder, 'exports'), { recursive: true })
  await writeFile(join(folder, 'exports', 'house.glb'), 'model')

  assert.equal(await store.createVariant('house/main', 'open-kitchen'), 'house/open-kitchen')
  const copy = join(store.root, 'house', 'open-kitchen')
  assert.equal(await readFile(join(copy, 'plans', 'ground.png'), 'utf8'), 'drawing')
  assert.ok(!existsSync(join(copy, 'exports')), 'exports are rebuilt, not copied')
  assert.deepEqual(await readdir(join(copy, 'history')), ['log.json'])
  assert.deepEqual(
    (await store.history('house/open-kitchen')).versions.map((v) => [v.version, v.change, v.back]),
    [[1, 'copied from house/main version 2', null]],
  )
  assert.equal(await nameOf(store, 'house/open-kitchen'), 'Main 2')

  await store.mutate('house/open-kitchen', rename('Open'))
  assert.equal(await nameOf(store, 'house/main'), 'Main 2')
  await store.mutate('house/main', rename('Main 3'))
  assert.equal(await nameOf(store, 'house/open-kitchen'), 'Open')
  assert.equal((await store.history('house/main')).current, 3)
  assert.equal((await store.history('house/open-kitchen')).current, 2)

  assert.deepEqual(await store.variants('house'), ['house/main', 'house/open-kitchen'])
  assert.deepEqual(await store.variants('cabin'), [])
  await assert.rejects(store.variants('../x'), /is not a project name/)
  await assert.rejects(store.createVariant('house/main', 'open-kitchen'), /a variant called "house\/open-kitchen" already exists/)
  await assert.rejects(store.createVariant('house/main', 'main'), /already exists/)
  for (const bad of ['../x', 'Open', 'a/b', '', '.hidden']) await assert.rejects(store.createVariant('house/main', bad), /is not a variant name/, bad)
  await assert.rejects(store.createVariant('house/nope', 'x'), /no scene is called "house\/nope"/)
  assert.deepEqual(await store.list(), ['house/main', 'house/open-kitchen'])
})

test('a deleted variant is set aside, and the last one is refused', async () => {
  const store = new FileSceneStore(await temp())
  await store.create('house/main', scene('Main'))
  await store.createVariant('house/main', 'b')
  await store.createVariant('house/main', 'c')

  const kept = await store.deleteVariant('house/b')
  assert.match(kept, /^\.deleted\/house\/b-\d{4}-/)
  assert.ok(existsSync(join(store.root, kept, 'scene.json')))
  assert.deepEqual(await store.list(), ['house/c', 'house/main'])
  await assert.rejects(store.read('house/b'), /no scene is called "house\/b"/)

  // Two deletes at once cannot take a project's last two variants.
  const results = await Promise.allSettled([store.deleteVariant('house/main'), store.deleteVariant('house/c')])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
  assert.match(refused.reason.message, /is the only variant of house; a project keeps at least one/)
  assert.equal((await store.list()).length, 1)
})
