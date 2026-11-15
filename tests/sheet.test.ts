import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Scene } from '../src/core/schema.ts'
import { facadeBreaks, floorPlanSheet, storeyLevels, ZONE_COLORS } from '../src/core/sheet.ts'
import { readScene } from '../src/core/store.ts'

// A house on two floors with a split level a few steps up from the
// ground floor, in two zones, standing in a garden.
const scene = (...more: object[]) =>
  Scene.parse({
    stage: '0.1',
    name: 'Sheet test',
    levels: [
      { id: 'ground', elevation: 0 },
      { id: 'step', elevation: 0.45, grade: true },
      { id: 'first', elevation: 3 },
    ],
    rooms: [
      { id: 'garden', open: true, floor: [[-20, -20], [30, -20], [30, 20], [-20, 20]] },
      { id: 'living', name: 'Living', zone: 'A', floor: [[0, 0], [8, 0], [8, 6], [0, 6]] },
      { id: 'study', name: 'Study', zone: 'A', level: 'step', floor: [[8, 0], [12, 0], [12, 4], [8, 4]] },
      { id: 'wc', name: 'Downstairs cloakroom', zone: 'B', floor: [[12, 0], [13, 0], [13, 1], [12, 1]] },
      { id: 'terrace', name: 'Terrace', zone: 'B', open: true, floor: [[0, -4], [8, -4], [8, 0], [0, 0]] },
      { id: 'bedroom', level: 'first', floor: [[0, 0], [5, 0], [5, 4], [0, 4]] },
      ...more,
    ],
  })

test('a sheet draws the storey with the most indoor floor, split levels with it', () => {
  assert.deepEqual(storeyLevels(scene()), ['ground', 'step'])
  assert.deepEqual(storeyLevels(scene(), 'step'), ['ground', 'step'])
  assert.deepEqual(storeyLevels(scene(), 'first'), ['first'])
  assert.throws(() => storeyLevels(scene(), 'attic'), /no level "attic"/)
})

test('the indoor area leaves out outdoor rooms, and each zone gives its own', () => {
  const sheet = floorPlanSheet(scene(), { date: '2026-01-01' })
  assert.equal(sheet.indoorArea, 48 + 16 + 1)
  assert.deepEqual(sheet.zones, [
    { zone: 'A', color: ZONE_COLORS[0], area: 64 },
    { zone: 'B', color: ZONE_COLORS[1], area: 1 },
  ])
  assert.match(sheet.svg, /Indoor area: 65\.0 m²/)
  assert.match(sheet.svg, />Zone A</)
  assert.match(sheet.svg, />64\.0 m²</)
})

test('a zone is in the legend only where it has floor on the storey', () => {
  const stairwell = { id: 'stairwell', level: 'first', zone: 'C', well: true, floor: [[0, 4], [2, 4], [2, 5], [0, 5]] }
  assert.deepEqual(floorPlanSheet(scene(stairwell), { level: 'first' }).zones, [])
  assert.deepEqual(floorPlanSheet(scene(stairwell)).zones.map((z) => z.zone), ['A', 'B'])
})

test('the house sets the scale, not the garden it stands in', () => {
  // 13 m by 10 m with the terrace: 1:50 would be 260 mm wide, so 1:100.
  // The 50 m garden round it would need 1:250.
  assert.equal(floorPlanSheet(scene()).scale, 100)
  const big = scene()
  big.rooms.find((room) => room.id === 'living')!.floor = [[0, 0], [60, 0], [60, 6], [0, 6]]
  assert.equal(floorPlanSheet(big).scale, 250)
})

test('each room is named with its area where the name fits, and only there', () => {
  const svg = floorPlanSheet(scene()).svg
  assert.match(svg, /<tspan class="name">Living<\/tspan><tspan class="area"[^>]*>48\.0 m²<\/tspan>/)
  assert.doesNotMatch(svg, /Downstairs cloakroom/, 'a long name in a 1 m room is left out')
})

test('a name keeps clear of the walls, or is left out', () => {
  // At 1:100 "Pantry" at the smallest size is 0.6 m long, but not in a
  // 0.8 m room once it stands clear of both walls.
  const pantry = { id: 'pantry', name: 'Pantry', floor: [[13, 0], [13.8, 0], [13.8, 3], [13, 3]] }
  assert.doesNotMatch(floorPlanSheet(scene(pantry)).svg, />Pantry</)
  const wider = { ...pantry, floor: [[13, 0], [14.2, 0], [14.2, 3], [13, 3]] }
  assert.match(floorPlanSheet(scene(wider)).svg, />Pantry</)
})

test('the sheet is an A3 page in millimeters, its text escaped', () => {
  const sheet = floorPlanSheet(scene(), { title: 'Option <2> & more', date: '2026-01-01' })
  assert.match(sheet.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="420mm" height="297mm" viewBox="0 0 420 297">/)
  assert.match(sheet.svg, /OPTION &lt;2&gt; &amp; MORE/)
  assert.match(sheet.svg, /2026-01-01/)
})

test('a dimension string breaks where the outside wall steps, seen from its side', () => {
  // An L: a deep room and a shallower one east of it.
  const floors = [
    [[0, 0], [4, 0], [4, 3], [0, 3]],
    [[4, 0], [7, 0], [7, 2], [4, 2]],
  ] as [number, number][][]
  assert.deepEqual(facadeBreaks(floors, 'north'), [0, 4, 7])
  assert.deepEqual(facadeBreaks(floors, 'south'), [0, 4, 7])
  // From the east, the deep room shows only above the shallow one.
  assert.deepEqual(facadeBreaks(floors, 'east'), [0, 2, 3])
  assert.deepEqual(facadeBreaks(floors, 'west'), [0, 3])
  // Clockwise corners read the same.
  assert.deepEqual(facadeBreaks(floors.map((floor) => [...floor].reverse()), 'east'), [0, 2, 3])
})

test('outdoor rooms have no dimension string of their own', () => {
  const sheet = floorPlanSheet(scene())
  const south = sheet.strings.filter((string) => string.side === 'south')
  // The terrace stands south of the living room, but the string measures
  // the walls: living, study and cloakroom, 13 m in all.
  assert.deepEqual(south.at(-1)!.lengths, [13])
})

test('the example house prints at 1:50, its storeys one sheet each', async () => {
  const two = Scene.parse(await readScene(new URL('../examples/two-storey/scene.json', import.meta.url).pathname))
  const ground = floorPlanSheet(two, { date: '2026-01-01' })
  assert.deepEqual(ground.levels, ['ground'])
  assert.equal(ground.scale, 50)
  assert.equal(ground.zones.length, 0)
  const first = floorPlanSheet(two, { level: 'first', date: '2026-01-01' })
  assert.deepEqual(first.levels, ['first'])
})
