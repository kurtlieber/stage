import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calibrate, checkDistance, measure, toPixel, toPlan } from '../src/core/calibrate.ts'
import { describeDiff, diffScenes, sharedRoom } from '../src/core/diff.ts'

// The maths behind calibrate_plan and compare. Synthetic numbers only.

const close = (actual: number, expected: number, what = '') => assert.ok(Math.abs(actual - expected) < 1e-9, `${what} ${actual} is not ${expected}`)

test('two pixels and their distance give the scale, and the first pixel the origin', () => {
  const c = calibrate([100, 500], [600, 500], 10)
  close(c.scale, 50)
  assert.deepEqual(c.origin, [100, 500])
  assert.deepEqual(toPlan(c, [600, 500]), [10, 0])
  // Up the page is north: a pixel 250 rows higher is 5 m further north.
  assert.deepEqual(toPlan(c, [100, 250]), [0, 5])
})

test('a dimension that does not start at the plan origin', () => {
  const c = calibrate([100, 500], [100, 300], 4, [2, 3])
  close(c.scale, 50)
  assert.deepEqual(c.origin, [0, 650])
  assert.deepEqual(toPlan(c, [100, 500]), [2, 3])
  assert.deepEqual(toPlan(c, [100, 300]), [2, 7])
})

test('a slanted dimension measures along its length', () => {
  const c = calibrate([0, 0], [30, 40], 1)
  close(c.scale, 50)
  close(measure(c, [10, 10], [40, 50]), 1)
})

test('toPixel undoes toPlan', () => {
  const c = calibrate([37.5, 912.25], [1290.5, 912.25], 31.2, [-1.5, 0.25])
  for (const pixel of [[0, 0], [37.5, 912.25], [1999, 3], [640.4, 480.6]] as [number, number][]) {
    const back = toPixel(c, toPlan(c, pixel))
    close(back[0], pixel[0], 'x')
    close(back[1], pixel[1], 'y')
  }
})

test('a check measures another labeled dimension and says how far off it is', () => {
  const c = calibrate([100, 100], [1100, 100], 20)
  const good = checkDistance(c, { a: [200, 100], b: [200, 600], distance: 10 })
  close(good.measured, 10)
  close(good.error, 0)
  const long = checkDistance(c, { a: [200, 100], b: [200, 600], distance: 9.8 })
  close(long.error, 0.2 / 9.8)
  assert.ok(long.error > 0.01, 'about 2% long, past a 1% tolerance')
  const short = checkDistance(c, { a: [200, 100], b: [200, 600], distance: 10.05 })
  assert.ok(Math.abs(short.error) < 0.01, 'half a percent short is within 1%')
  assert.ok(short.error < 0)
})

test('a calibration needs two different pixels and a real distance', () => {
  assert.throws(() => calibrate([5, 5], [5, 5], 3), /the two points are the same pixel/)
  assert.throws(() => calibrate([0, 0], [10, 0], 0), /more than 0 meters/)
  assert.throws(() => calibrate([0, 0], [10, 0], -2), /more than 0 meters/)
  assert.throws(() => calibrate([0, 0], [10, 0], Number.NaN), /more than 0 meters/)
  assert.throws(() => checkDistance(calibrate([0, 0], [10, 0], 1), { a: [0, 0], b: [1, 0], distance: 0 }), /more than 0 meters/)
})

const base = {
  stage: '0.1',
  name: 'Flat',
  rooms: [
    { id: 'office', floor: [[0, 0], [3, 0], [3, 3], [0, 3]] },
    { id: 'hall', floor: [[3, 0], [5, 0], [5, 3], [3, 3]] },
  ],
  openings: [{ id: 'window', type: 'window', wall: { room: 'office', edge: 0 }, at: 1, width: 1 }],
  items: [
    { id: 'desk', asset: 'table/desk', room: 'office', at: [1, 1] },
    { id: 'chair', asset: 'chair/office', room: 'office', at: [1, 1.6] },
  ],
  materials: [{ id: 'oak', color: '#a07040' }],
}
const copy = () => structuredClone(base) as typeof base & Record<string, unknown>

test('the same scene has no differences', () => {
  assert.deepEqual(diffScenes(base, copy()), [])
  assert.equal(describeDiff([], 'house/a', 'house/b'), 'house/a and house/b are the same')
})

test('a moved desk, a new lamp, and a removed chair, all in one room', () => {
  const b = copy()
  b.items = [{ ...base.items[0], at: [2, 2.5] }, { id: 'lamp', asset: 'lamp/floor', room: 'office', at: [0.4, 2.6] }] as typeof base.items
  const changes = diffScenes(base, b)
  assert.deepEqual(
    changes.map((c) => [c.kind, c.collection, c.id]),
    [
      ['changed', 'items', 'desk'],
      ['removed', 'items', 'chair'],
      ['added', 'items', 'lamp'],
    ],
  )
  assert.deepEqual(changes[0].fields, [{ field: 'at', from: [1, 1], to: [2, 2.5] }])
  assert.equal(sharedRoom(changes), 'office')
  assert.equal(describeDiff(changes, 'house/a', 'house/b'), ['from house/a to house/b:', '~ item desk: at [1,1] -> [2,2.5]', '- item chair: only in house/a', '+ item lamp: only in house/b'].join('\n'))
})

test('a window counts in its wall room, and a field added or dropped shows as (none)', () => {
  const b = copy()
  b.openings = [{ ...base.openings[0], at: 2, sill: 0.9 } as (typeof base.openings)[number]]
  const changes = diffScenes(base, b)
  assert.equal(sharedRoom(changes), 'office')
  assert.match(describeDiff(changes, 'a', 'b'), /~ opening window: at 1 -> 2; sill \(none\) -> 0.9/)
})

test('changes in two rooms, or with no room, frame no one room', () => {
  const twoRooms = copy()
  twoRooms.items = [{ ...base.items[0], room: 'hall', at: [4, 1] }, base.items[1]]
  const moved = diffScenes(base, twoRooms)
  assert.deepEqual(moved[0].rooms, ['office', 'hall'])
  assert.equal(sharedRoom(moved), undefined)

  const material = copy()
  material.materials = [{ id: 'oak', color: '#806040' }]
  material.items = [{ ...base.items[0], at: [2, 2] }, base.items[1]]
  assert.equal(sharedRoom(diffScenes(base, material)), undefined)

  const renamed = copy()
  renamed.name = 'Other'
  const changes = diffScenes(base, renamed)
  assert.deepEqual(changes.map((c) => [c.collection, c.id, c.fields.map((f) => f.field)]), [['scene', 'scene', ['name']]])
  assert.match(describeDiff(changes, 'a', 'b'), /~ scene: name "Flat" -> "Other"/)
})

test('a long value is cut short on its line', () => {
  const b = copy()
  b.rooms = [{ ...base.rooms[0], floor: Array.from({ length: 20 }, (_, i) => [i, i]) }, base.rooms[1]]
  const line = describeDiff(diffScenes(base, b), 'a', 'b').split('\n')[1]
  assert.ok(line.length < 200, line)
  assert.match(line, /\.\.\.$/)
})
