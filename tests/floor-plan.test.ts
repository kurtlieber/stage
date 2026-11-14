import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CUT_HEIGHT, floorPlan, labelPoint, roomDimensions } from '../src/core/floor-plan.ts'
import { distanceToSegment, pointInPolygon, type Point } from '../src/core/geometry.ts'
import { Scene } from '../src/core/schema.ts'
import { readScene } from '../src/core/store.ts'

// A hall and a study side by side, a terrace beyond the study.
const scene = () =>
  Scene.parse({
    stage: '0.1',
    name: 'plan test',
    rooms: [
      { id: 'hall', floor: [[0, 0], [4, 0], [4, 3], [0, 3]] },
      { id: 'study', floor: [[4, 0], [7, 0], [7, 3], [4, 3]] },
      { id: 'terrace', open: true, floor: [[7, 0], [9, 0], [9, 3], [7, 3]] },
    ],
    openings: [
      { id: 'front', wall: { room: 'hall', edge: 0 }, at: 1, type: 'door', width: 0.9, height: 2.1 },
      { id: 'back', wall: { room: 'hall', edge: 0 }, at: 2.5, type: 'door', width: 0.8, height: 2.1, swing: 'out-right' },
      { id: 'view', wall: { room: 'hall', edge: 2 }, at: 1, type: 'window', width: 1.2, height: 1.2 },
    ],
    items: [
      { id: 'chest', asset: 'mystery', room: 'study', at: [5.5, 1.5], facing: 90, size: [2, 1, 0.8] },
      { id: 'shelf', asset: 'mystery', room: 'study', at: [5.5, 2.8], elevation: 1.6, size: [1, 0.3, 0.3] },
    ],
  })

const inWall = (plan: ReturnType<typeof floorPlan>, p: Point) => plan.walls.find((wall) => pointInPolygon(p, wall.polygon))
const near = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6

test('walls the cut passes through are solid, with a gap at each doorway', () => {
  const plan = floorPlan(scene(), ['ground'])
  assert.equal(inWall(plan, [0.5, 0])?.low, false)
  assert.equal(inWall(plan, [1.45, 0]), undefined, 'the front doorway is open')
  assert.equal(inWall(plan, [2.9, 0]), undefined, 'the back doorway is open')
  assert.equal(inWall(plan, [3.5, 0])?.low, false)
  // An outside wall is 23 cm thick and its corner closes.
  assert.ok(inWall(plan, [0.5, -0.11]))
  assert.ok(inWall(plan, [-0.11, -0.11]))
})

test('a terrace parapet, lower than the cut, is a low wall', () => {
  const plan = floorPlan(scene(), ['ground'])
  assert.ok(CUT_HEIGHT > 1)
  assert.equal(inWall(plan, [9, 1.5])?.low, true)
  assert.equal(inWall(plan, [7, 1.5])?.low, false, 'the study wall stands full height')
})

test('a door opens to the left of its wall when it swings in, hinged at the start', () => {
  const plan = floorPlan(scene(), ['ground'])
  const leaves = plan.lines.filter((line) => line.kind === 'leaf')
  const swings = plan.lines.filter((line) => line.kind === 'swing')
  assert.equal(leaves.length, 2)
  assert.equal(swings.length, 2)
  // in-left by default: hinge at x 1 on the inside face, leaf into the hall.
  const front = leaves.find((line) => Math.abs(line.points[0][0] - 1) < 1e-6)!
  assert.ok(near(front.points[0], [1, 0.115]))
  assert.ok(near(front.points[1], [1, 1.015]))
  const arc = swings.find((line) => near(line.points[0], [1, 1.015]))!
  assert.ok(near(arc.points.at(-1)!, [1.9, 0.115]), 'the swing ends on the closed position')
  // out-right: hinge at the far end on the outside face, leaf outdoors.
  const back = leaves.find((line) => Math.abs(line.points[0][0] - 3.3) < 1e-6)!
  assert.ok(near(back.points[0], [3.3, -0.115]))
  assert.ok(near(back.points[1], [3.3, -0.915]))
})

test('a window draws its frame and glass across the wall', () => {
  const plan = floorPlan(scene(), ['ground'])
  const glass = plan.lines.filter((line) => line.kind === 'glass')
  assert.equal(glass.length, 1)
  // Edge 2 of the hall runs west along y 3, so the window is x 3 to 1.8.
  const xs = glass[0].points.map((p) => p[0]).sort()
  assert.deepEqual(xs.map((x) => +x.toFixed(6)), [1.8, 3])
  assert.equal(plan.lines.filter((line) => line.kind === 'frame').length, 1)
  assert.equal(inWall(plan, [2.4, 3]), undefined)
})

test('furniture is outlined where it stands, and what hangs above the cut is hidden', () => {
  const plan = floorPlan(scene(), ['ground'])
  const outlines = plan.lines.filter((line) => line.kind === 'furniture')
  assert.equal(outlines.length, 1)
  // Turned to face east, the 2 m wide chest runs north to south.
  const xs = outlines[0].points.map((p) => +p[0].toFixed(6))
  const ys = outlines[0].points.map((p) => +p[1].toFixed(6))
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [5, 6, 0.5, 2.5])
  assert.equal(plan.lines.filter((line) => line.kind === 'above').length, 1)
})

test('every room gets a floor and a label point inside it, outdoors drawn first', () => {
  const plan = floorPlan(scene(), ['ground'])
  assert.deepEqual(
    plan.floors.map((floor) => [floor.room, floor.kind]),
    [['terrace', 'open'], ['hall', 'room'], ['study', 'room']],
  )
  const hall = plan.labels.find((label) => label.room === 'hall')!
  assert.ok(near(hall.at, [2, 1.5]), 'a rectangle is labelled in its middle')
})

test('a garden is drawn under the porch in it, and named where no room covers it', () => {
  const plan = floorPlan(
    Scene.parse({
      stage: '0.1',
      name: 'garden test',
      rooms: [
        { id: 'hall', floor: [[0, 0], [4, 0], [4, 3], [0, 3]] },
        { id: 'porch', open: true, floor: [[4, 0], [6, 0], [6, 3], [4, 3]] },
        { id: 'garden', open: true, floor: [[-2, -2], [10, -2], [10, 5], [-2, 5]] },
      ],
    }),
    ['ground'],
  )
  assert.deepEqual(plan.floors.map((floor) => floor.room), ['garden', 'porch', 'hall'])
  const garden = plan.labels.find((label) => label.room === 'garden')!.at
  for (const room of ['hall', 'porch']) {
    const floor = plan.floors.find((f) => f.room === room)!.polygon
    assert.ok(!pointInPolygon(garden, floor), `the garden's name is not in the ${room}`)
  }
})

test("an L-shaped room's label sits in the L, clear of the walls", () => {
  const floor: Point[] = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]]
  const at = labelPoint(floor)
  assert.ok(pointInPolygon(at, floor))
  const clearance = Math.min(...floor.map((p, i) => distanceToSegment(at, p, floor[(i + 1) % floor.length])))
  assert.ok(clearance > 0.9, `clearance ${clearance}`)
})

test("a room's dimensions are its centerline sides, drawn inside the wall's face", () => {
  const sides = roomDimensions(scene(), 'hall')
  assert.deepEqual(sides.map((side) => +side.length.toFixed(6)), [4, 3, 4, 3])
  assert.deepEqual(sides[0].inward.map((n) => +n.toFixed(6) + 0), [0, 1])
  assert.equal(sides[0].face, 0.115, 'an outside wall')
  assert.equal(sides[1].face, 0.0575, 'the wall shared with the study')
  assert.deepEqual(roomDimensions(scene(), 'nowhere'), [])
})

test('a storey draws only its own rooms, and every door on it', async () => {
  const two = Scene.parse(await readScene(new URL('../examples/two-storey/scene.json', import.meta.url).pathname))
  const ground = two.levels.find((level) => level.id === 'ground')!
  const plan = floorPlan(two, [ground.id])
  const rooms = two.rooms.filter((room) => room.level === ground.id)
  assert.deepEqual(new Set(plan.floors.map((floor) => floor.room)), new Set(rooms.map((room) => room.id)))
  const doors = two.openings.filter((opening) => opening.type === 'door' && rooms.some((room) => room.id === opening.wall.room))
  assert.ok(doors.length > 0)
  assert.equal(plan.lines.filter((line) => line.kind === 'leaf').length, doors.length)
})
