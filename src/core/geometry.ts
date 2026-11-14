import { objectCorners } from './objects.ts'
import type { Level, Opening, Room, Scene } from './schema.ts'

// Pure plan geometry: no renderer here. The viewer turns these results into
// meshes and the command line answers queries from them, so both agree.

export type Point = [number, number]

export interface Edge {
  index: number
  a: Point
  b: Point
  length: number
}

export interface WallOpening {
  opening: Opening
  // Along the wall from its own `a`, whichever room the opening was given on.
  from: number
  to: number
  // Above the wall's own bottom.
  bottom: number
  top: number
}

// One straight piece of wall over one vertical span. Rooms stacked on
// different levels, or a tall room beside a short one, produce several
// walls on the same edge, one above the other.
export interface Wall {
  id: string
  a: Point
  b: Point
  length: number
  thickness: number
  height: number
  elevation: number
  // Rooms on each side; one room means an exterior wall. An open room
  // (a terrace, a garden) counts as outside.
  rooms: string[]
  exterior: boolean
  openings: WallOpening[]
}

// A solid piece of wall between and around openings, in wall coordinates:
// `from` and `to` along the wall, `bottom` and `top` above the wall's bottom.
export interface WallPiece {
  from: number
  to: number
  bottom: number
  top: number
}

export const INTERIOR_THICKNESS = 0.115
export const EXTERIOR_THICKNESS = 0.23
export const DEFAULT_SILL = 0.9
const EPSILON = 1e-6

export function edges(room: Room): Edge[] {
  const n = room.floor.length
  return room.floor.map((a, index) => {
    const b = room.floor[(index + 1) % n]
    return { index, a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1]) }
  })
}

export function area(polygon: Point[]): number {
  let sum = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]
    const [x2, y2] = polygon[(i + 1) % polygon.length]
    sum += x1 * y2 - x2 * y1
  }
  return Math.abs(sum) / 2
}

export function centroid(polygon: Point[]): Point {
  let x = 0
  let y = 0
  for (const [px, py] of polygon) {
    x += px
    y += py
  }
  return [x / polygon.length, y / polygon.length]
}

export interface Bounds {
  min: Point
  max: Point
}

export function bounds(points: Point[]): Bounds {
  const min: Point = [Infinity, Infinity]
  const max: Point = [-Infinity, -Infinity]
  for (const [x, y] of points) {
    min[0] = Math.min(min[0], x)
    min[1] = Math.min(min[1], y)
    max[0] = Math.max(max[0], x)
    max[1] = Math.max(max[1], y)
  }
  return { min, max }
}

// Everything on the plan: room floors and the footprints of free objects.
// An empty scene is a small square around the origin.
export function sceneBounds(scene: Scene): Bounds {
  const points = [...scene.rooms.flatMap((room) => room.floor), ...objectCorners(scene)]
  return points.length ? bounds(points) : { min: [-2, -2], max: [2, 2] }
}

// Ray casting, with points on an edge counted as inside, so an item pushed
// flush against a wall is still in its room.
export function pointInPolygon([x, y]: Point, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (distanceToSegment([x, y], [xi, yi], [xj, yj]) < EPSILON) return true
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (crosses) inside = !inside
  }
  return inside
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSquared = dx * dx + dy * dy
  let t = lengthSquared === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

// ---- Levels ----------------------------------------------------------------

// Levels from the lowest up, whatever order the file lists them in.
export function levelsByElevation(scene: Scene): Level[] {
  return [...scene.levels].sort((p, q) => p.elevation - q.elevation)
}

export function levelOf(scene: Scene, room: Room): Level | undefined {
  return scene.levels.find((l) => l.id === room.level)
}

export function roomHeight(scene: Scene, room: Room): number {
  return room.height ?? levelOf(scene, room)?.height ?? 2.7
}

export function roomElevation(scene: Scene, room: Room): number {
  return levelOf(scene, room)?.elevation ?? 0
}

// Each level's storey, in levelsByElevation order: a grade level belongs to
// the storey it stands in, so its split levels show and hide together.
export function storeys(scene: Scene): number[] {
  let storey = -1
  return levelsByElevation(scene).map((level) => (level.grade && storey >= 0 ? storey : ++storey))
}

// The next level up that stands over this one. A grade level is a split
// level beside the storey on the ground, a few steps up or down, so it is
// never the floor above anything.
export function levelAbove(scene: Scene, level: Level): Level | undefined {
  const ordered = levelsByElevation(scene)
  return ordered.slice(ordered.indexOf(level) + 1).find((l) => !l.grade)
}

// The slab a room's walls rise through above its ceiling: the floor slab
// of the next level up, or this level's own when it is the top.
export function slabAbove(scene: Scene, room: Room): number {
  const level = levelOf(scene, room)
  if (!level) return 0
  return levelAbove(scene, level)?.slab ?? level.slab
}

// Whether a room stands on the ground: it is on the lowest level with a
// closed room (a site level of gardens and drives below doesn't count), or
// on a grade level.
export function onGround(scene: Scene, room: Room): boolean {
  if (levelOf(scene, room)?.grade) return true
  const lowest = levelsByElevation(scene).find((level) => scene.rooms.some((r) => !r.open && r.level === level.id))
  return lowest?.id === room.level
}

// Where a room's walls start: down at the ground for a room that stands on
// it, so a house on a plinth, or a wing a few steps up, doesn't float.
export function wallBottom(scene: Scene, room: Room): number {
  const elevation = roomElevation(scene, room)
  if (room.open) return elevation
  return onGround(scene, room) && elevation > 0 ? 0 : elevation
}

export function wallTop(scene: Scene, room: Room): number {
  const elevation = roomElevation(scene, room)
  if (room.open) return elevation + room.parapet
  // A hair under the slab top, so a terrace floor above never fights the
  // wall tops for the same pixels.
  return elevation + roomHeight(scene, room) + slabAbove(scene, room) - 0.004
}

// ---- Walls -----------------------------------------------------------------

function edgeKey(a: Point, b: Point): string {
  const p = `${a[0].toFixed(4)},${a[1].toFixed(4)}`
  const q = `${b[0].toFixed(4)},${b[1].toFixed(4)}`
  return p < q ? `${p}|${q}` : `${q}|${p}`
}

interface Contribution {
  room: Room
  // Of the original edge: where this piece starts and ends along it.
  edge: Edge
  pieceFrom: number
  pieceTo: number
  bottom: number
  top: number
  // Where the room's own ceiling is; above it is slab.
  ceiling: number
}

interface Piece {
  key: string
  a: Point
  b: Point
  contributions: Contribution[]
}

// Every room edge, split where any other corner in the scene lies on it, so
// two rooms that meet along part of an edge share that part and the rest is
// built once, not twice. An agent writes rectangles; this finds the joints.
function pieces(scene: Scene): Map<string, Piece> {
  const corners = scene.rooms.flatMap((room) => room.floor)
  const byKey = new Map<string, Piece>()
  for (const room of scene.rooms) {
    const bottom = wallBottom(scene, room)
    const top = wallTop(scene, room)
    const ceiling = roomElevation(scene, room) + roomHeight(scene, room)
    for (const edge of edges(room)) {
      if (edge.length < EPSILON) continue
      const dx = (edge.b[0] - edge.a[0]) / edge.length
      const dy = (edge.b[1] - edge.a[1]) / edge.length
      const cuts = new Set<number>([0, edge.length])
      for (const corner of corners) {
        const along = (corner[0] - edge.a[0]) * dx + (corner[1] - edge.a[1]) * dy
        if (along <= EPSILON || along >= edge.length - EPSILON) continue
        if (distanceToSegment(corner, edge.a, edge.b) < 1e-4) cuts.add(Math.round(along * 1e4) / 1e4)
      }
      const stops = [...cuts].sort((p, q) => p - q)
      for (let i = 0; i + 1 < stops.length; i++) {
        const a: Point = [edge.a[0] + dx * stops[i], edge.a[1] + dy * stops[i]]
        const b: Point = [edge.a[0] + dx * stops[i + 1], edge.a[1] + dy * stops[i + 1]]
        const key = edgeKey(a, b)
        let piece = byKey.get(key)
        if (!piece) {
          piece = { key, a, b, contributions: [] }
          byKey.set(key, piece)
        }
        piece.contributions.push({ room, edge, pieceFrom: stops[i], pieceTo: stops[i + 1], bottom, top, ceiling })
      }
    }
  }
  return byKey
}

// One wall per straight piece of edge and vertical span. Rooms that share
// a piece over a span share that wall; a wall with one room on it faces
// outside. Open rooms (terraces, gardens) get a parapet where nothing else
// stands, and none where they meet each other.
export function walls(scene: Scene): Wall[] {
  const result: Wall[] = []
  for (const piece of pieces(scene).values()) {
    const stops = [...new Set(piece.contributions.flatMap((c) => [c.bottom, c.top]))].sort((p, q) => p - q)
    const spans: { bottom: number; top: number; covering: Contribution[]; exterior: boolean }[] = []
    for (let i = 0; i + 1 < stops.length; i++) {
      const bottom = stops[i]
      const top = stops[i + 1]
      if (top - bottom < 1e-4) continue
      const covering = piece.contributions.filter((c) => c.bottom <= bottom + EPSILON && c.top >= top - EPSILON)
      if (covering.length === 0) continue
      const closed = covering.filter((c) => !c.room.open)
      // Two open rooms meeting: a lawn beside a path. No wall at all, even
      // when one has a parapet and the other none.
      const openNeighbors = piece.contributions.filter((c) => c.room.open && c.bottom <= bottom + EPSILON && c.bottom + 3 >= top)
      if (closed.length === 0 && openNeighbors.length > 1) continue
      const rooms = closed.length > 0 ? closed : covering
      // The slab band of one room where others share the edge below or
      // above is the edge of a floor, not a wall facing outside.
      const slabBand = rooms.length === 1 && !rooms[0].room.open && bottom >= rooms[0].ceiling - EPSILON && piece.contributions.length > 1
      const exterior = rooms.length === 1 && !slabBand
      const last = spans.at(-1)
      if (last && Math.abs(last.top - bottom) < EPSILON && last.exterior === exterior && sameRooms(last.covering, rooms)) {
        last.top = top
        continue
      }
      spans.push({ bottom, top, covering: rooms, exterior })
    }
    for (const span of spans) {
      const wall: Wall = {
        id: `${span.covering[0].room.id}/${span.covering[0].edge.index}@${span.bottom.toFixed(2)}`,
        a: piece.a,
        b: piece.b,
        length: Math.hypot(piece.b[0] - piece.a[0], piece.b[1] - piece.a[1]),
        thickness: Math.max(span.exterior ? EXTERIOR_THICKNESS : INTERIOR_THICKNESS, ...span.covering.map((c) => c.room.thickness ?? 0)),
        height: span.top - span.bottom,
        elevation: span.bottom,
        rooms: span.covering.map((c) => c.room.id),
        exterior: span.exterior,
        openings: [],
      }
      for (const c of piece.contributions) placeOpenings(scene, wall, c)
      wall.openings.sort((p, q) => p.from - q.from)
      result.push(wall)
    }
  }
  return result
}

function sameRooms(p: Contribution[], q: Contribution[]): boolean {
  return p.length === q.length && p.every((c) => q.some((d) => d.room === c.room))
}

// Lands the room's openings on this edge onto the wall, clipped to the
// piece of edge and the vertical span the wall covers.
function placeOpenings(scene: Scene, wall: Wall, c: Contribution): void {
  const elevation = roomElevation(scene, c.room)
  for (const opening of scene.openings) {
    if (opening.wall.room !== c.room.id || opening.wall.edge !== c.edge.index) continue
    if (wall.openings.some((o) => o.opening === opening)) continue
    const start = Math.max(opening.at, c.pieceFrom)
    const end = Math.min(opening.at + opening.width, c.pieceTo)
    if (end - start < 1e-4) continue
    const sill = opening.type === 'window' ? (opening.sill ?? DEFAULT_SILL) : 0
    const bottom = Math.max(0, elevation + sill - wall.elevation)
    const top = Math.min(wall.height, elevation + sill + opening.height - wall.elevation)
    if (top - bottom < 1e-4) continue
    // Along the wall from its own `a`; the piece may run the other way.
    const sameDirection = Math.hypot(wall.a[0] - (c.edge.a[0] + ((c.edge.b[0] - c.edge.a[0]) * c.pieceFrom) / c.edge.length), wall.a[1] - (c.edge.a[1] + ((c.edge.b[1] - c.edge.a[1]) * c.pieceFrom) / c.edge.length)) < 1e-4
    const from = sameDirection ? start - c.pieceFrom : c.pieceTo - end
    wall.openings.push({ opening, from, to: from + (end - start), bottom, top })
  }
}

// Solid pieces of a wall: full height between openings, a lintel above each
// opening, and a sill piece below a window. No CSG needed.
export function wallPieces(wall: Wall): WallPiece[] {
  const pieces: WallPiece[] = []
  let cursor = 0
  for (const hole of wall.openings) {
    const from = Math.max(0, Math.min(wall.length, hole.from))
    const to = Math.max(0, Math.min(wall.length, hole.to))
    // A sliver narrower than a millimeter is rounding, not wall.
    if (from > cursor + 1e-3) pieces.push({ from: cursor, to: from, bottom: 0, top: wall.height })
    if (hole.top < wall.height - 1e-4) pieces.push({ from, to, bottom: hole.top, top: wall.height })
    if (hole.bottom > 1e-4) pieces.push({ from, to, bottom: 0, top: hole.bottom })
    cursor = Math.max(cursor, to)
  }
  if (cursor < wall.length - 1e-3) pieces.push({ from: cursor, to: wall.length, bottom: 0, top: wall.height })
  return pieces.filter((p) => p.to - p.from > 1e-3 && p.top - p.bottom > 1e-3)
}

// Plan coordinates of a point `along` a wall from `a`.
export function alongWall(wall: Wall, along: number): Point {
  const t = wall.length === 0 ? 0 : along / wall.length
  return [wall.a[0] + (wall.b[0] - wall.a[0]) * t, wall.a[1] + (wall.b[1] - wall.a[1]) * t]
}

export function wallAngle(wall: Wall): number {
  return Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0])
}
