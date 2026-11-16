import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Design, designsIn, groupByRoom, latestRevision, partOfNode } from '../src/core/design.ts'
import { listDesigns } from '../src/core/design-store.ts'
import { formatMillimeters } from '../src/core/units.ts'

// Designs: furniture a CAD pipeline writes beside the scenes, which Stage
// lists and shows but never changes.

const FIXTURE = new URL('./fixtures/designs/oak-shelf/', import.meta.url)
const fixture = async () => JSON.parse(await readFile(new URL('design.json', FIXTURE), 'utf8'))
const minimal = (id: string, extra: Record<string, unknown> = {}) => ({ stage_design: 1, id, name: id, project: 'flat', size: [1, 0.5, 2], status: 'draft', ...extra })

test('the fixture design reads, and what it leaves out is filled in', async () => {
  const design = Design.parse(await fixture())
  assert.equal(design.parts.length, 2)
  assert.equal(latestRevision(design)?.letter, 'A')
  const bare = Design.parse(minimal('bare'))
  assert.deepEqual([bare.summary, bare.rooms, bare.placements, bare.parts, bare.revisions], ['', [], [], [], []])
  assert.deepEqual(bare.files, { model: 'model.glb', package: [] })
  assert.equal(latestRevision(bare), undefined)
})

test('a design is refused for a bad id, status, size or a file outside its folder', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['an id', minimal('Office Desk')],
    ['a status', minimal('a', { status: 'built' })],
    ['a size', minimal('a', { size: [1, 2] })],
    ['a format', minimal('a', { stage_design: 2 })],
    ['a climbing file', minimal('a', { files: { package: [{ label: 'x', file: '../other/secret.pdf' }] } })],
    ['an absolute file', minimal('a', { files: { model: '/etc/passwd' } })],
    ['a revision file', minimal('a', { revisions: [{ letter: 'A', status: 'issued-for-build', files: [{ label: 'x', file: 'revisions/A/../../../x' }] }] })],
  ]
  for (const [what, raw] of bad) assert.equal(Design.safeParse(raw).success, false, what)
})

test('the designs folder lists every valid design by name, and skips the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stage-designs-'))
  assert.deepEqual(await listDesigns(root), [], 'no folder, no designs')
  const designs = join(root, 'designs')
  await cp(FIXTURE, join(designs, 'oak-shelf'), { recursive: true })
  const write = async (folder: string, value: unknown) => {
    await mkdir(join(designs, folder), { recursive: true })
    await writeFile(join(designs, folder, 'design.json'), typeof value === 'string' ? value : JSON.stringify(value))
  }
  await write('a-bench', minimal('a-bench', { name: 'Bench' }))
  await write('broken', '{ not json')
  await write('wrong-status', minimal('wrong-status', { status: 'done' }))
  await write('moved', minimal('elsewhere'))
  await write('.hidden', minimal('hidden'))
  await mkdir(join(designs, 'empty'))
  const warnings: string[] = []
  const found = await listDesigns(root, (m) => warnings.push(m))
  assert.deepEqual(found.map((d) => d.id), ['a-bench', 'oak-shelf'])
  assert.equal(warnings.length, 3)
  assert.match(warnings.join('\n'), /broken: .*JSON/)
  assert.match(warnings.join('\n'), /wrong-status: status:/)
  assert.match(warnings.join('\n'), /moved: its id is "elsewhere"/)
})

test('designs group by room, in the scene\'s room order, the roomless last', () => {
  const [a, b, c, d] = [
    Design.parse(minimal('a', { rooms: ['kitchen'] })),
    Design.parse(minimal('b', { rooms: ['living', 'kitchen'] })),
    Design.parse(minimal('c')),
    Design.parse(minimal('d', { rooms: ['attic'] })),
  ]
  assert.deepEqual(designsIn([a, b, c, d], 'kitchen').map((x) => x.id), ['a', 'b'])
  const groups = groupByRoom([a, b, c, d], ['living', 'kitchen', 'bedroom'])
  assert.deepEqual(groups.map((g) => [g.room, g.designs.map((x) => x.id)]), [['living', ['b']], ['kitchen', ['a', 'b']], ['attic', ['d']], ['', ['c']]])
})

test('a model node finds its Part by id, copy number or not', async () => {
  const { parts } = Design.parse(await fixture())
  assert.equal(partOfNode('side', parts)?.id, 'side')
  assert.equal(partOfNode('side_2', parts)?.id, 'side')
  assert.equal(partOfNode('shelf_3', parts)?.id, 'shelf')
  assert.equal(partOfNode('oak-shelf', parts), undefined)
  assert.equal(partOfNode('Panel_A1', [{ id: 'Panel A1', name: '', qty: 1 }])?.id, 'Panel A1')
})

test('furniture sizes read in millimeters, or inches to the sixteenth', () => {
  assert.equal(formatMillimeters([720, 450, 660], 'm'), '720 × 450 × 660 mm')
  assert.equal(formatMillimeters([720, 450, 18], 'ft'), '28 3/8″ × 17 11/16″ × 11/16″')
  assert.equal(formatMillimeters([2438.4, 25.4, 3740], 'ft'), '8′ 0″ × 1″ × 12′ 3 1/4″')
})
