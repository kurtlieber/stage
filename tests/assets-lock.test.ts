import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// The cache is read from the environment when the module loads, so point it
// at a temporary folder first.
process.env.XDG_CACHE_HOME = await mkdtemp(join(tmpdir(), 'stage-lock-'))
const { CACHE_LOCK, LOCK_PATH, readLock, writeLock } = await import('../src/cli/assets.ts')

test('writing an unchanged lock leaves the repository lock untouched', async () => {
  // In the Docker image the repository lock belongs to root, and fetching
  // what a scene needs must not have to rewrite it.
  const before = await stat(LOCK_PATH)
  const text = await readFile(LOCK_PATH, 'utf8')
  await writeLock(await readLock())
  const after = await stat(LOCK_PATH)
  assert.equal(after.ino, before.ino, 'the file was replaced')
  assert.equal(after.mtimeMs, before.mtimeMs, 'the file was written')
  assert.equal(await readFile(LOCK_PATH, 'utf8'), text)
  assert.ok(CACHE_LOCK.startsWith(process.env.XDG_CACHE_HOME!))
  assert.deepEqual(JSON.parse(await readFile(CACHE_LOCK, 'utf8')), { version: 1, textures: {}, skies: {}, models: {} })
})
