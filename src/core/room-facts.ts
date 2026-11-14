import { area, bounds, DEFAULT_SILL, edges, levelOf, pointInPolygon, roomElevation, roomHeight, type Point } from './geometry.ts'
import type { Opening, Room, Scene } from './schema.ts'

// What the room panel says about a room, worked out from the scene alone,
// so the viewer and any other reader agree.

export interface OpeningFact {
  id: string
  type: Opening['type']
  // The room on the other side, or undefined for outside.
  to?: string
  width: number
  height: number
  // Above the room's floor; windows only.
  sill?: number
}

export interface RoomFacts {
  id: string
  name: string
  level: string
  // Two sides of a rectangle, longer first; for any other shape, the box it
  // fits in, and `overall` says so.
  size: [number, number]
  overall: boolean
  area: number
  // Floor to ceiling; undefined for a room open to the sky.
  ceiling?: number
  // The floor against the level called "ground", the way drawings mark
  // levels: −0.75 is three quarters of a meter below it.
  floor: number
  openings: OpeningFact[]
  places: string[]
}

export function roomName(room: Room): string {
  return room.name ?? room.id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

export function roomFacts(scene: Scene, id: string): RoomFacts | undefined {
  const room = scene.rooms.find((r) => r.id === id)
  if (!room) return undefined
  const level = levelOf(scene, room)
  const datum = scene.levels.find((l) => l.id === 'ground')?.elevation ?? 0
  const { size, overall } = measure(room.floor)
  return {
    id: room.id,
    name: roomName(room),
    level: level?.name ?? level?.id ?? room.level,
    size,
    overall,
    area: area(room.floor),
    ceiling: room.open ? undefined : roomHeight(scene, room),
    floor: roomElevation(scene, room) - datum,
    openings: openingsOf(scene, room),
    places: scene.cameras.filter((c) => c.type === 'perspective' && c.at && c.look && roomUnder(scene, [c.at[0], c.at[1]], c.at[2]) === room.id).map((c) => c.id),
  }
}

// The room under a point in plan: of the rooms whose floor holds it, the
// one whose floor is nearest below the height, or a little above it.
export function roomUnder(scene: Scene, p: Point, height: number): string | undefined {
  let best: { id: string; gap: number } | undefined
  for (const room of scene.rooms) {
    if (!pointInPolygon(p, room.floor)) continue
    const gap = height - roomElevation(scene, room)
    if (gap < -0.3) continue
    if (!best || gap < best.gap) best = { id: room.id, gap }
  }
  return best?.id
}

// Rooms one after another, around and around, in the scene's order: the
// order the agent wrote them in is the order of a tour of the house.
export function stepRoom(scene: Scene, from: string | undefined, step: number): string | undefined {
  const rooms = scene.rooms
  if (rooms.length === 0) return undefined
  const index = rooms.findIndex((r) => r.id === from)
  if (index < 0) return rooms[step > 0 ? 0 : rooms.length - 1].id
  return rooms[(index + step + rooms.length) % rooms.length].id
}

function measure(floor: Point[]): { size: [number, number]; overall: boolean } {
  const sides = floor.map((a, i) => {
    const b = floor[(i + 1) % floor.length]
    return [b[0] - a[0], b[1] - a[1]] as Point
  })
  const square = sides.length === 4 && sides.every((s, i) => {
    const t = sides[(i + 1) % 4]
    return Math.abs(s[0] * t[0] + s[1] * t[1]) < 1e-3 * Math.hypot(...s) * Math.hypot(...t)
  })
  if (square) {
    const [p, q] = [Math.hypot(...sides[0]), Math.hypot(...sides[1])]
    return { size: [Math.max(p, q), Math.min(p, q)], overall: false }
  }
  const b = bounds(floor)
  const [w, d] = [b.max[0] - b.min[0], b.max[1] - b.min[1]]
  return { size: [Math.max(w, d), Math.min(w, d)], overall: true }
}

// Every door, window and opening in the room's walls, its own and those
// given on the room next door, each with the room it leads to.
function openingsOf(scene: Scene, room: Room): OpeningFact[] {
  const order: Opening['type'][] = ['door', 'slider', 'opening', 'window']
  const facts: OpeningFact[] = []
  for (const opening of scene.openings) {
    const sides = sidesOf(scene, opening)
    if (!sides || !sides.includes(room.id)) continue
    const other = sides.find((s) => s !== room.id)
    const window = opening.type === 'window'
    facts.push({ id: opening.id, type: opening.type, to: window ? undefined : other, width: opening.width, height: opening.height, sill: window ? (opening.sill ?? DEFAULT_SILL) : undefined })
  }
  return facts.sort((p, q) => order.indexOf(p.type) - order.indexOf(q.type))
}

// The rooms on both sides of an opening: its own, and whatever room a step
// through it lands in (none, outside).
function sidesOf(scene: Scene, opening: Opening): string[] | undefined {
  const own = scene.rooms.find((r) => r.id === opening.wall.room)
  const edge = own && edges(own)[opening.wall.edge]
  if (!own || !edge || edge.length === 0) return undefined
  const dx = (edge.b[0] - edge.a[0]) / edge.length
  const dy = (edge.b[1] - edge.a[1]) / edge.length
  const along = Math.min(edge.length, opening.at + opening.width / 2)
  const middle: Point = [edge.a[0] + dx * along, edge.a[1] + dy * along]
  // Past the thickest wall, on each side.
  const reach = 0.3
  const left: Point = [middle[0] - dy * reach, middle[1] + dx * reach]
  const right: Point = [middle[0] + dy * reach, middle[1] - dx * reach]
  const outside = pointInPolygon(left, own.floor) ? right : left
  const height = roomElevation(scene, own) + 1
  const other = roomUnder(scene, outside, height)
  return other && other !== own.id ? [own.id, other] : [own.id]
}
