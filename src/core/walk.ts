import { findAsset } from './assets.ts'
import { alongWall, levelAbove, pointInPolygon, roomElevation, wallPieces, walls, type Point, sceneBounds } from './geometry.ts'
import { footprintCorners, placeObjects } from './objects.ts'
import type { Scene } from './schema.ts'
import { stair, type Stair } from './stairs.ts'
import { RAIL_OFFSET, sliderLayout } from './slider.ts'

// Walking through a scene: what stops a person, how they slide off it, and
// what they stand on, floor by floor and up the stairs. Pure plan geometry,
// so the viewer walks with it and the tests check it.

export const BODY_RADIUS = 0.18
// How much room furniture gets beyond its footprint.
const FURNITURE_MARGIN = 0.08
// The most a step can climb or drop without a stair.
export const STEP = 0.45

export interface Obstacles {
  walls: { a: Point; b: Point; half: number; bottom: number; top: number }[]
  solids: { x: number; y: number; halfW: number; halfD: number; angle: number; bottom: number; top: number }[]
  floors: { polygon: Point[]; elevation: number }[]
  stairs: { x: number; y: number; angle: number; elevation: number; stair: Stair }[]
}

// Pieces flat on the floor or hung above head height don't stop anyone.
const PASSABLE = new Set(['rug/area', 'kitchen/wall-cabinets', 'tv/wall', 'screen/projection'])

export function obstacles(scene: Scene): Obstacles {
  const result: Obstacles = { walls: [], solids: [], floors: [], stairs: [] }
  for (const wall of walls(scene)) {
    for (const piece of wallPieces(wall)) {
      result.walls.push({ a: alongWall(wall, piece.from), b: alongWall(wall, piece.to), half: wall.thickness / 2, bottom: wall.elevation + piece.bottom, top: wall.elevation + piece.top })
    }
    // The closed panels of a sliding door stop a person; the gap does not.
    for (const hole of wall.openings) {
      if (hole.opening.type !== 'slider') continue
      const { gap } = sliderLayout(hole.to - hole.from, hole.top - hole.bottom)
      for (const [from, to] of [[hole.from, hole.from + gap.from], [hole.from + gap.to, hole.to]]) {
        if (to - from < 1e-3) continue
        result.walls.push({ a: alongWall(wall, from), b: alongWall(wall, to), half: RAIL_OFFSET + 0.02, bottom: wall.elevation + hole.bottom, top: wall.elevation + hole.top })
      }
    }
  }
  const rooms = new Map(scene.rooms.map((room) => [room.id, room]))
  for (const room of scene.rooms) {
    if (!room.well) result.floors.push({ polygon: room.floor, elevation: roomElevation(scene, room) })
  }
  for (const item of scene.items) {
    const room = rooms.get(item.room)
    const base = (room ? roomElevation(scene, room) : 0) + item.elevation
    const info = findAsset(item.asset)
    const size = info && !info.resizable ? info.size : (item.size ?? info?.size)
    if (!size) continue
    const angle = (item.facing * Math.PI) / 180
    if (info?.category === 'stairs') {
      const rise = item.size?.[2] ?? (room ? floorToFloor(scene, room.level) : size[2])
      result.stairs.push({ x: item.at[0], y: item.at[1], angle, elevation: base, stair: stair(item.asset, size[0] * item.scale, size[1] * item.scale, rise) })
      continue
    }
    if (PASSABLE.has(item.asset) || info?.passable) continue
    result.solids.push({ x: item.at[0], y: item.at[1], halfW: (size[0] * item.scale) / 2, halfD: (size[1] * item.scale) / 2, angle, bottom: base, top: base + size[2] * item.scale })
  }
  // Free objects: a solid one stops a person, and the flat top of anything
  // is a place to stand when it is within a step. A plane is only a top.
  let outside = scene.rooms.length === 0
  for (const placed of placeObjects(scene)) {
    const { object, footprint, box } = placed
    if (!object.room) outside = true
    if (object.kind === 'group' || !object.solid) continue
    if (object.kind !== 'plane') result.solids.push({ ...footprint, bottom: box.min[2], top: box.max[2] })
    if (placed.flat) result.floors.push({ polygon: footprintCorners(footprint), elevation: box.max[2] })
  }
  // With no rooms, or objects standing outside them, the ground itself
  // holds a person up, well past everything.
  if (outside) {
    const b = sceneBounds(scene)
    const pad = 12
    result.floors.push({ polygon: [[b.min[0] - pad, b.min[1] - pad], [b.max[0] + pad, b.min[1] - pad], [b.max[0] + pad, b.max[1] + pad], [b.min[0] - pad, b.max[1] + pad]], elevation: 0 })
  }
  return result
}

// From a level's floor to the next level's floor, or to its own roof.
export function floorToFloor(scene: Scene, levelId: string): number {
  const level = scene.levels.find((l) => l.id === levelId)
  if (!level) return 2.7
  const above = levelAbove(scene, level)
  return above ? above.elevation - level.elevation : level.height + level.slab
}

function closestOnSegment([x, y]: Point, a: Point, b: Point): Point {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared))
  return [a[0] + t * dx, a[1] + t * dy]
}

// Into an item's own frame: facing turns it clockwise from north.
function toLocal([x, y]: Point, s: { x: number; y: number; angle: number }): Point {
  const c = Math.cos(s.angle)
  const n = Math.sin(s.angle)
  return [(x - s.x) * c - (y - s.y) * n, (x - s.x) * n + (y - s.y) * c]
}

// Whether something spanning bottom..top is in the way of a person whose
// feet are at `foot`: anything from a step's height up to head height. A
// plinth under a doorway, or a kerb, is stepped onto, not walked into.
function inTheWay(bottom: number, top: number, foot: number, over = STEP): boolean {
  return bottom < foot + 1.4 && top > foot + over
}

// Pushes a position out of every wall and piece of furniture it overlaps,
// along the shortest way out. Walking into a wall at an angle then glides
// along it, and no position is ever stuck: a step is never refused, only
// corrected. Only what is at the person's own height counts.
export function resolve(p: Point, { walls, solids }: Obstacles, radius = BODY_RADIUS, foot = 0): Point {
  let [x, y] = p
  for (let pass = 0; pass < 4; pass++) {
    let moved = false
    for (const w of walls) {
      if (!inTheWay(w.bottom, w.top, foot)) continue
      // The wall is a rectangle `half` across; the person a circle. Past
      // the end of a piece, at a doorway, only the corner pushes, so a
      // door is as wide as it is, not narrowed by the wall's thickness.
      const dx = w.b[0] - w.a[0]
      const dy = w.b[1] - w.a[1]
      const length = Math.hypot(dx, dy)
      if (length < 1e-9) continue
      const ux = dx / length
      const uy = dy / length
      const along = (x - w.a[0]) * ux + (y - w.a[1]) * uy
      const across = (x - w.a[0]) * -uy + (y - w.a[1]) * ux
      const outAlong = along < 0 ? along : along > length ? along - length : 0
      const outAcross = Math.abs(across) - w.half
      if (outAlong === 0) {
        // Beside the wall: push straight off its face.
        if (outAcross >= radius) continue
        const sign = across >= 0 ? 1 : -1
        const want = sign * (w.half + radius)
        x += (want - across) * -uy
        y += (want - across) * ux
      } else {
        // Past an end: inside the wall's band, push back along the wall;
        // off to the side, push away from the corner.
        const dir = along < 0 ? -1 : 1
        if (outAcross <= 0) {
          if (Math.abs(outAlong) >= radius) continue
          const push = radius - Math.abs(outAlong)
          x += dir * ux * push
          y += dir * uy * push
        } else {
          const d = Math.hypot(outAlong, outAcross)
          if (d >= radius || d < 1e-9) continue
          const cornerAlong = along < 0 ? 0 : length
          const cornerAcross = across >= 0 ? w.half : -w.half
          const cx = w.a[0] + ux * cornerAlong + -uy * cornerAcross
          const cy = w.a[1] + uy * cornerAlong + ux * cornerAcross
          const px = x - cx
          const py = y - cy
          const pl = Math.hypot(px, py) || 1
          x = cx + (px / pl) * radius
          y = cy + (py / pl) * radius
        }
      }
      moved = true
    }
    for (const s of solids) {
      // A coffee table is walked around, not over.
      if (!inTheWay(s.bottom, s.top, foot, 0.25)) continue
      const c = Math.cos(s.angle)
      const n = Math.sin(s.angle)
      let [lx, ly] = toLocal([x, y], s)
      const hw = s.halfW + FURNITURE_MARGIN + radius * 0.5
      const hd = s.halfD + FURNITURE_MARGIN + radius * 0.5
      if (Math.abs(lx) >= hw || Math.abs(ly) >= hd) continue
      if (hw - Math.abs(lx) < hd - Math.abs(ly)) lx = Math.sign(lx || 1) * hw
      else ly = Math.sign(ly || 1) * hd
      x = s.x + lx * c + ly * n
      y = s.y - lx * n + ly * c
      moved = true
    }
    if (!moved) break
  }
  return [x, y]
}

// What a person standing at `p` with their feet at `foot` would stand on
// after a step: the nearest floor or stair within a step's reach, or
// undefined over a well, a void, or off the edge of a mezzanine. Stairs
// win ties, so stepping onto the first tread climbs.
export function ground(p: Point, { floors, stairs }: Obstacles, foot: number): number | undefined {
  let best: number | undefined
  let bestGap = STEP
  for (const s of stairs) {
    const h = s.stair.height(toLocal(p, s))
    if (h === undefined) continue
    const gap = Math.abs(s.elevation + h - foot)
    if (gap < bestGap + 0.2) {
      best = s.elevation + h
      bestGap = gap - 0.2
    }
  }
  // Of the floors within a step, the highest: a low platform or a box top
  // is stepped onto, and stepping off it lands on the ground below.
  let highest: number | undefined
  for (const f of floors) {
    if (Math.abs(f.elevation - foot) >= STEP || !pointInPolygon(p, f.polygon)) continue
    if (highest === undefined || f.elevation > highest) highest = f.elevation
  }
  if (highest !== undefined && Math.abs(highest - foot) < bestGap) best = highest
  return best
}
