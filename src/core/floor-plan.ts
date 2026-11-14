import { findAsset } from './assets.ts'
import { alongWall, area, bounds, centroid, distanceToSegment, edges, pointInPolygon, roomElevation, walls, type Point, type Wall } from './geometry.ts'
import { footprintCorners, placeObjects } from './objects.ts'
import type { Room, Scene } from './schema.ts'
import { RAIL_OFFSET, sliderLayout } from './slider.ts'
import { stair } from './stairs.ts'
import { floorToFloor } from './walk.ts'

// Plan mode's floor plan, drawn the way an architect draws one: a storey
// cut through 1.2 m above its floor and seen from above. Walls the cut
// passes through are solid; lower ones (a parapet, a garden wall) are
// lighter. Doors show their swing, windows their frame and glass, and
// furniture its outline. Pure plan geometry: the viewer draws it and the
// tests check it. Openings and swings follow the 3D build exactly, so the
// plan and the house agree.

export const CUT_HEIGHT = 1.2
const EPSILON = 1e-4
// Segments in a door's quarter circle.
const ARC_STEPS = 16

export type FloorKind = 'room' | 'open' | 'well'
// frame and glass: a window or a slider's frame. leaf and swing: a door
// standing open and the path its edge sweeps. panel: a slider's glass
// panel. furniture, or above when it hangs over the cut. tread: a step.
// void: the edge of a well and its cross.
export type LineKind = 'frame' | 'glass' | 'leaf' | 'swing' | 'panel' | 'furniture' | 'above' | 'tread' | 'void'

export interface FloorPlan {
  // In drawing order: outdoors first, then rooms from the lowest up, then
  // wells over them.
  floors: { room: string; polygon: Point[]; kind: FloorKind }[]
  walls: { polygon: Point[]; low: boolean }[]
  // Thin lines; `closed` ones are outlines.
  lines: { points: Point[]; kind: LineKind; closed?: boolean }[]
  // Where each room's name goes: well inside it, clear of its walls.
  labels: { room: string; at: Point }[]
}

// The floor plan of the levels given, which are one storey: a split level
// and the floor it steps up from draw together.
export function floorPlan(scene: Scene, levelIds: string[]): FloorPlan {
  const wanted = new Set(levelIds)
  const rooms = scene.rooms.filter((room) => wanted.has(room.level))
  const byId = new Map(rooms.map((room) => [room.id, room]))
  const plan: FloorPlan = { floors: [], walls: [], lines: [], labels: [] }

  // Outdoors first, then rooms, then wells; low before high, and large
  // before small, so a porch shows on the garden it stands in.
  const order = (room: Room) => (room.well ? 2 : room.open ? 0 : 1)
  const sorted = [...rooms].sort((p, q) => order(p) - order(q) || roomElevation(scene, p) - roomElevation(scene, q) || area(q.floor) - area(p.floor))
  sorted.forEach((room, index) => {
    plan.floors.push({ room: room.id, polygon: room.floor, kind: room.well ? 'well' : room.open ? 'open' : 'room' })
    if (room.well) {
      plan.lines.push({ points: room.floor, kind: 'void', closed: true })
      if (room.floor.length === 4) {
        plan.lines.push({ points: [room.floor[0], room.floor[2]], kind: 'void' })
        plan.lines.push({ points: [room.floor[1], room.floor[3]], kind: 'void' })
      }
    }
    // A garden's name goes on the garden, not on the house drawn over it.
    const box = bounds(room.floor)
    const over = sorted.slice(index + 1).map((other) => other.floor).filter((floor) => overlaps(box, bounds(floor)))
    plan.labels.push({ room: room.id, at: labelPoint(room.floor, over) })
  })

  // One straight piece of edge can carry several walls, one over the
  // other. Those the cut passes through draw as one, with every opening
  // any of them has; the rest, if they stand on the floor, are low walls.
  const cut = new Map<string, Wall[]>()
  const low = new Map<string, Wall[]>()
  for (const wall of walls(scene)) {
    let through = false
    let under = false
    for (const id of wall.rooms) {
      const room = byId.get(id)
      if (!room) continue
      const floor = roomElevation(scene, room)
      const top = wall.elevation + wall.height
      if (wall.elevation <= floor + CUT_HEIGHT + EPSILON && top >= floor + CUT_HEIGHT - EPSILON) through = true
      else if (top < floor + CUT_HEIGHT && top > floor + 0.01 && wall.elevation <= floor + 0.01) under = true
    }
    const key = pieceKey(wall)
    if (through) cut.set(key, [...(cut.get(key) ?? []), wall])
    else if (under) low.set(key, [...(low.get(key) ?? []), wall])
  }
  for (const group of cut.values()) drawWall(plan, group, false)
  for (const [key, group] of low) if (!cut.has(key)) drawWall(plan, group, true)

  furniture(scene, plan, rooms, wanted)
  return plan
}

function pieceKey(wall: Wall): string {
  const p = `${wall.a[0].toFixed(4)},${wall.a[1].toFixed(4)}`
  const q = `${wall.b[0].toFixed(4)},${wall.b[1].toFixed(4)}`
  return p < q ? `${p}|${q}` : `${q}|${p}`
}

// A wall as solid pieces between its openings, each a rectangle on the
// centerline. The ends go on half the thickness, as in the 3D build, so
// corners close; a doorway's sides stop where it starts.
function drawWall(plan: FloorPlan, group: Wall[], low: boolean) {
  const wall = group.reduce((p, q) => (q.thickness > p.thickness ? q : p))
  const half = wall.thickness / 2
  // Every opening of the group, along this wall's own direction. Each is
  // drawn on the wall that carries it, since its swing follows that one.
  const holes: { from: number; to: number; hole: Wall['openings'][number]; on: Wall }[] = []
  for (const other of group) {
    const reversed = Math.hypot(other.a[0] - wall.a[0], other.a[1] - wall.a[1]) > EPSILON
    for (const hole of other.openings) {
      if (holes.some((h) => h.hole.opening === hole.opening)) continue
      const from = reversed ? wall.length - hole.to : hole.from
      const to = reversed ? wall.length - hole.from : hole.to
      holes.push({ from, to, hole, on: other })
    }
  }
  holes.sort((p, q) => p.from - q.from)
  let cursor = 0
  const solid = (from: number, to: number) => {
    if (to - from < 1e-3) return
    const start = from <= EPSILON ? -half : from
    const end = to >= wall.length - EPSILON ? wall.length + half : to
    plan.walls.push({ polygon: band(wall, start, end, -half, half), low })
  }
  for (const { from, to } of holes) {
    solid(cursor, Math.max(cursor, from))
    cursor = Math.max(cursor, to)
  }
  solid(cursor, wall.length)
  // Wall pieces under the cut don't show what's in their openings.
  if (low) return
  for (const { hole, on } of holes) opening(plan, on, hole, half)
}

// A rectangle along a wall: `from` and `to` along it, `left` and `right`
// across it, left being the side to the left looking from `a` to `b`.
function band(wall: Wall, from: number, to: number, right: number, left: number): Point[] {
  const [dx, dy] = direction(wall)
  const at = (along: number, across: number): Point => {
    const [x, y] = alongWall(wall, along)
    return [x - dy * across, y + dx * across]
  }
  return [at(from, right), at(to, right), at(to, left), at(from, left)]
}

function direction(wall: Wall): Point {
  const length = wall.length || 1
  return [(wall.b[0] - wall.a[0]) / length, (wall.b[1] - wall.a[1]) / length]
}

function opening(plan: FloorPlan, wall: Wall, hole: Wall['openings'][number], half: number) {
  const { opening } = hole
  const width = hole.to - hole.from
  if (width < 1e-3) return
  if (opening.type === 'window') {
    plan.lines.push({ points: band(wall, hole.from, hole.to, -half, half), kind: 'frame', closed: true })
    plan.lines.push({ points: [alongWall(wall, hole.from), alongWall(wall, hole.to)], kind: 'glass' })
    return
  }
  if (opening.type === 'slider') {
    plan.lines.push({ points: band(wall, hole.from, hole.to, -half, half), kind: 'frame', closed: true })
    // Rail 0 on the left of the wall, rail 1 on the right, as built.
    const { panels } = sliderLayout(width, hole.top - hole.bottom)
    for (const panel of panels) {
      const offset = panel.rail === 0 ? RAIL_OFFSET : -RAIL_OFFSET
      const from = hole.from + panel.at
      plan.lines.push({ points: band(wall, from, from + (panel.to - panel.from), offset - 0.02, offset + 0.02), kind: 'panel', closed: true })
    }
    return
  }
  if (opening.type === 'door') {
    // Hinged at the wall's `a` end of the doorway for a left swing, and
    // opening to the left of the wall for an inward one, as built: drawn
    // fully open, with the quarter circle its edge sweeps.
    const hingeLeft = opening.swing?.endsWith('left') ?? true
    const inward = opening.swing?.startsWith('in') ?? true
    const [dx, dy] = direction(wall)
    const side: Point = inward ? [-dy, dx] : [dy, -dx]
    const [hx, hy] = alongWall(wall, hingeLeft ? hole.from : hole.to)
    const hinge: Point = [hx + side[0] * half, hy + side[1] * half]
    const along: Point = hingeLeft ? [dx, dy] : [-dx, -dy]
    const tip: Point = [hinge[0] + side[0] * width, hinge[1] + side[1] * width]
    plan.lines.push({ points: [hinge, tip], kind: 'leaf' })
    const arc: Point[] = []
    for (let i = 0; i <= ARC_STEPS; i++) {
      const t = ((i / ARC_STEPS) * Math.PI) / 2
      arc.push([hinge[0] + (side[0] * Math.cos(t) + along[0] * Math.sin(t)) * width, hinge[1] + (side[1] * Math.cos(t) + along[1] * Math.sin(t)) * width])
    }
    plan.lines.push({ points: arc, kind: 'swing' })
  }
  // A plain opening is the gap itself.
}

// Furniture and free objects as outlines, stairs as their treads. Whatever
// hangs above the cut (wall cabinets, a shelf) is drawn as hidden.
function furniture(scene: Scene, plan: FloorPlan, rooms: Room[], wanted: Set<string>) {
  const byId = new Map(scene.rooms.map((room) => [room.id, room]))
  const turn = (facing: number, at: Point, [x, y]: Point): Point => {
    // Facing turns a thing clockwise from north.
    const a = (-facing * Math.PI) / 180
    return [at[0] + x * Math.cos(a) - y * Math.sin(a), at[1] + x * Math.sin(a) + y * Math.cos(a)]
  }
  for (const item of scene.items) {
    const room = byId.get(item.room)
    if (!room || !wanted.has(room.level)) continue
    const info = findAsset(item.asset)
    const size = info && !info.resizable ? info.size : (item.size ?? info?.size)
    if (!size) continue
    const w = size[0] * item.scale
    const d = size[1] * item.scale
    if (info?.category === 'stairs') {
      const rise = item.size?.[2] ?? floorToFloor(scene, room.level)
      for (const tread of stair(item.asset, w, d, rise).treads) plan.lines.push({ points: tread.polygon.map((p) => turn(item.facing, item.at, p)), kind: 'tread', closed: true })
      continue
    }
    const corners: Point[] = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
    plan.lines.push({ points: corners.map((p) => turn(item.facing, item.at, p)), kind: item.elevation >= CUT_HEIGHT ? 'above' : 'furniture', closed: true })
  }
  // Free objects by the room they stand in, or else by height: on this
  // storey if they stand between its lowest floor and its highest ceiling.
  const floors = rooms.map((room) => roomElevation(scene, room))
  const lowest = floors.length ? Math.min(...floors) : 0
  const levels = scene.levels.filter((level) => wanted.has(level.id))
  const highest = levels.length ? Math.max(...levels.map((level) => level.elevation + level.height)) : lowest + 2.7
  for (const placed of placeObjects(scene)) {
    const { object, footprint, box } = placed
    if (object.kind === 'group') continue
    const room = object.room ? byId.get(object.room) : undefined
    const here = room ? wanted.has(room.level) : box.min[2] >= lowest - 0.05 && box.min[2] < highest
    if (!here) continue
    const base = room ? roomElevation(scene, room) : lowest
    plan.lines.push({ points: footprintCorners(footprint), kind: box.min[2] >= base + CUT_HEIGHT ? 'above' : 'furniture', closed: true })
  }
}

// A point well inside a floor for its name: the middle when that is
// comfortably inside, else the point farthest from every edge, so an L or
// a U gets its name in its widest part rather than over a wall. Floors
// drawn over this one (`over`) are left out, edges and all.
export function labelPoint(polygon: Point[], over: Point[][] = []): Point {
  const shapes = [polygon, ...over]
  const clearance = (p: Point) => {
    let d = Infinity
    for (const shape of shapes) for (let i = 0; i < shape.length; i++) d = Math.min(d, distanceToSegment(p, shape[i], shape[(i + 1) % shape.length]))
    return d
  }
  const free = (p: Point) => pointInPolygon(p, polygon) && !over.some((floor) => pointInPolygon(p, floor))
  const b = bounds(polygon)
  const steps = 24
  let best: Point = centroid(polygon)
  let bestClearance = free(best) ? clearance(best) : -1
  let cell = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) / steps
  const middle = areaCentroid(polygon)
  const middleClearance = free(middle) ? clearance(middle) : -1
  // Grid search, then a finer one around the best point.
  for (let pass = 0; pass < 2; pass++) {
    const [cx, cy] = pass === 0 ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2] : best
    const span = pass === 0 ? steps / 2 : 4
    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        const p: Point = [cx + i * cell, cy + j * cell]
        if (!free(p)) continue
        const c = clearance(p)
        if (c > bestClearance) {
          best = p
          bestClearance = c
        }
      }
    }
    cell /= 4
  }
  // Covered all over: the plain answer, and the sheet hides what won't fit.
  if (bestClearance < 0 && over.length) return labelPoint(polygon)
  return middleClearance >= bestClearance * 0.8 ? middle : best
}

const overlaps = (p: { min: Point; max: Point }, q: { min: Point; max: Point }) => p.min[0] < q.max[0] && q.min[0] < p.max[0] && p.min[1] < q.max[1] && q.min[1] < p.max[1]

// The centre of mass of the floor, not the average of its corners.
function areaCentroid(polygon: Point[]): Point {
  let x = 0
  let y = 0
  let twice = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]
    const [x2, y2] = polygon[(i + 1) % polygon.length]
    const cross = x1 * y2 - x2 * y1
    x += (x1 + x2) * cross
    y += (y1 + y2) * cross
    twice += cross
  }
  return Math.abs(twice) < 1e-9 ? centroid(polygon) : [x / (3 * twice), y / (3 * twice)]
}

export interface Dimension {
  a: Point
  b: Point
  // Along the edge's centerline, the length the room panel gives.
  length: number
  // A unit vector into the room.
  inward: Point
  // From the centerline to the wall's inner face; 0 where there is none.
  face: number
}

// The current room's sides as a drawing dimensions them: each edge from
// corner to corner on the wall centerlines, to be drawn just inside the
// wall's inner face.
export function roomDimensions(scene: Scene, id: string): Dimension[] {
  const room = scene.rooms.find((r) => r.id === id)
  if (!room) return []
  // Corners counterclockwise put the room on each edge's left.
  let signed = 0
  for (let i = 0; i < room.floor.length; i++) {
    const [x1, y1] = room.floor[i]
    const [x2, y2] = room.floor[(i + 1) % room.floor.length]
    signed += x1 * y2 - x2 * y1
  }
  const left = signed > 0
  const all = walls(scene).filter((wall) => wall.rooms.includes(id))
  return edges(room)
    .filter((edge) => edge.length > 1e-3)
    .map((edge) => {
      const dx = (edge.b[0] - edge.a[0]) / edge.length
      const dy = (edge.b[1] - edge.a[1]) / edge.length
      const on = all.filter((wall) => distanceToSegment(wall.a, edge.a, edge.b) < EPSILON && distanceToSegment(wall.b, edge.a, edge.b) < EPSILON)
      const face = on.length ? Math.max(...on.map((wall) => wall.thickness)) / 2 : 0
      return { a: edge.a, b: edge.b, length: edge.length, inward: (left ? [-dy, dx] : [dy, -dx]) as Point, face }
    })
}

