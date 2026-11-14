import { findAsset } from './assets.ts'
import { DEFAULT_SILL, area, edges, levelAbove, levelsByElevation, pointInPolygon, roomElevation, roomHeight, type Point } from './geometry.ts'
import { MATERIALS } from './materials.ts'
import { sliderLayout } from './slider.ts'
import { stair } from './stairs.ts'
import { floorToFloor } from './walk.ts'
import { parentLoops, placeObjects } from './objects.ts'
import { COLLECTIONS, Scene } from './schema.ts'

// What `stage check` reports. Every problem names an entity and a path,
// and an error says how to fix it, so an agent can act without reading
// the whole file.
export interface Problem {
  severity: 'error' | 'warning'
  path: string
  entity?: string
  message: string
}

export interface CheckResult {
  ok: boolean
  scene?: Scene
  problems: Problem[]
}

export function check(input: unknown): CheckResult {
  const parsed = Scene.safeParse(input)
  if (!parsed.success) {
    const problems: Problem[] = parsed.error.issues.map((issue) => ({
      severity: 'error',
      path: issue.path.map(String).join('.') || '(root)',
      entity: entityAt(input, issue.path.map(String)),
      message: issue.message,
    }))
    return { ok: false, problems }
  }
  const scene = parsed.data
  const problems: Problem[] = [...uniqueIds(scene), ...references(scene), ...spatial(scene)]
  return { ok: !problems.some((p) => p.severity === 'error'), scene, problems }
}

function entityAt(input: unknown, path: string[]): string | undefined {
  if (typeof input !== 'object' || input === null || path.length < 2) return undefined
  const list = (input as Record<string, unknown>)[path[0]]
  if (!Array.isArray(list)) return undefined
  const entity = list[Number(path[1])]
  return entity && typeof entity === 'object' && typeof entity.id === 'string' ? entity.id : undefined
}

function uniqueIds(scene: Scene): Problem[] {
  const problems: Problem[] = []
  const seen = new Map<string, string>()
  for (const collection of COLLECTIONS) {
    scene[collection].forEach((entity, index) => {
      const earlier = seen.get(entity.id)
      if (earlier) {
        problems.push({
          severity: 'error',
          path: `${collection}.${index}.id`,
          entity: entity.id,
          message: `"${entity.id}" is already used by ${earlier}; ids must be unique across the file.`,
        })
      } else {
        seen.set(entity.id, `${collection}.${index}`)
      }
    })
  }
  return problems
}

function references(scene: Scene): Problem[] {
  const problems: Problem[] = []
  const levels = new Set(scene.levels.map((l) => l.id))
  const rooms = new Map(scene.rooms.map((r) => [r.id, r]))

  scene.rooms.forEach((room, index) => {
    if (!levels.has(room.level)) {
      problems.push({
        severity: 'error',
        path: `rooms.${index}.level`,
        entity: room.id,
        message: `level "${room.level}" does not exist; levels are ${[...levels].join(', ')}.`,
      })
    }
    for (const [slot, name] of Object.entries(room.materials ?? {})) {
      if (name && !MATERIALS[name] && !scene.materials.some((m) => m.id === name)) {
        problems.push({
          severity: 'warning',
          path: `rooms.${index}.materials.${slot}`,
          entity: room.id,
          message: `material "${name}" is neither built in nor in "materials", so it renders as the default; built-in materials are ${Object.keys(MATERIALS).join(', ')}.`,
        })
      }
    }
  })

  scene.openings.forEach((opening, index) => {
    const room = rooms.get(opening.wall.room)
    if (!room) {
      problems.push({
        severity: 'error',
        path: `openings.${index}.wall.room`,
        entity: opening.id,
        message: `room "${opening.wall.room}" does not exist; rooms are ${[...rooms.keys()].join(', ')}.`,
      })
    } else if (opening.wall.edge >= room.floor.length) {
      problems.push({
        severity: 'error',
        path: `openings.${index}.wall.edge`,
        entity: opening.id,
        message: `room "${room.id}" has edges 0 to ${room.floor.length - 1}; edge ${opening.wall.edge} does not exist.`,
      })
    }
  })

  scene.items.forEach((item, index) => {
    if (!rooms.has(item.room)) {
      problems.push({
        severity: 'error',
        path: `items.${index}.room`,
        entity: item.id,
        message: `room "${item.room}" does not exist; rooms are ${[...rooms.keys()].join(', ')}.`,
      })
    }
    const info = findAsset(item.asset)
    if (info && item.size && !info.resizable) {
      problems.push({
        severity: 'warning',
        path: `items.${index}.size`,
        entity: item.id,
        message: `"${item.asset}" has a fixed size of ${info.size.join(' x ')} m, so "size" on "${item.id}" is ignored; use "scale" to resize it.`,
      })
    }
    if (!info && !item.asset.startsWith('./')) {
      problems.push({
        severity: item.size ? 'warning' : 'error',
        path: `items.${index}.asset`,
        entity: item.id,
        message: item.size
          ? `asset "${item.asset}" is not in the library, so "${item.id}" renders as a labeled box of its size; find a match with: stage assets search <words>.`
          : `asset "${item.asset}" is not in the library and "${item.id}" has no "size" to build a placeholder from; add "size": [width, depth, height] or pick an asset with: stage assets search <words>.`,
      })
    }
  })

  scene.cameras.forEach((camera, index) => {
    if (camera.level && !levels.has(camera.level)) {
      problems.push({
        severity: 'error',
        path: `cameras.${index}.level`,
        entity: camera.id,
        message: `level "${camera.level}" does not exist; levels are ${[...levels].join(', ')}.`,
      })
    }
    if (camera.type === 'perspective' && (!camera.at || !camera.look)) {
      problems.push({
        severity: 'error',
        path: `cameras.${index}`,
        entity: camera.id,
        message: `a perspective camera needs "at": [x, y, z] and "look": [x, y, z].`,
      })
    }
  })

  const objectIds = new Set(scene.objects.map((o) => o.id))
  const loops = new Set(parentLoops(scene))
  scene.objects.forEach((object, index) => {
    if (object.parent && !objectIds.has(object.parent)) {
      problems.push({
        severity: 'error',
        path: `objects.${index}.parent`,
        entity: object.id,
        message: `parent "${object.parent}" is not an object; objects are ${[...objectIds].join(', ') || 'none'}.`,
      })
    }
    if (object.parent === object.id || loops.has(object.id)) {
      problems.push({ severity: 'error', path: `objects.${index}.parent`, entity: object.id, message: `"${object.id}" is its own ancestor through "parent"; break the loop.` })
    }
    if (object.room && !rooms.has(object.room)) {
      problems.push({ severity: 'error', path: `objects.${index}.room`, entity: object.id, message: `room "${object.room}" does not exist; rooms are ${[...rooms.keys()].join(', ') || 'none'}; leave "room" out to stand on the ground.` })
    }
    if (object.material && !MATERIALS[object.material] && !scene.materials.some((m) => m.id === object.material)) {
      problems.push({
        severity: 'warning',
        path: `objects.${index}.material`,
        entity: object.id,
        message: `material "${object.material}" is neither built in nor in "materials", so it renders grey; built-in materials are ${Object.keys(MATERIALS).join(', ')}, or give a "color".`,
      })
    }
    if (object.kind === 'asset' && !findAsset(object.asset) && !object.size) {
      problems.push({ severity: 'warning', path: `objects.${index}.asset`, entity: object.id, message: `"${object.asset}" is not in the library, so it renders as a labeled box; search with the assets tool, or give it a "size".` })
    }
    if (object.kind === 'model' && !/^https?:\/\//.test(object.file) && (object.file.startsWith('/') || object.file.includes('..'))) {
      problems.push({ severity: 'error', path: `objects.${index}.file`, entity: object.id, message: `"file" must be a path beside the scene file, like "models/duck.glb", or an https URL.` })
    }
  })
  return problems
}

function spatial(scene: Scene): Problem[] {
  const problems: Problem[] = []
  const rooms = new Map(scene.rooms.map((r) => [r.id, r]))

  const ordered = levelsByElevation(scene)
  ordered.forEach((level, i) => {
    const below = ordered[i - 1]
    // A grade level stands beside the others, a few steps up or down.
    if (!below || level.grade) return
    const top = below.elevation + below.height + level.slab
    if (level.elevation < top - 1e-6) {
      problems.push({
        severity: 'warning',
        path: `levels.${scene.levels.indexOf(level)}.elevation`,
        entity: level.id,
        message: `"${level.id}" starts at ${level.elevation} m, inside "${below.id}" (floor ${below.elevation}, height ${below.height}, slab ${level.slab}); raise it to ${top.toFixed(3)} or lower the height of "${below.id}".`,
      })
    }
  })

  scene.rooms.forEach((room, index) => {
    if (area(room.floor) < 0.5) {
      problems.push({
        severity: 'error',
        path: `rooms.${index}.floor`,
        entity: room.id,
        message: `the floor of "${room.id}" has an area of ${area(room.floor).toFixed(2)} m²; the corners probably repeat or lie on a line.`,
      })
    }
    const hasWayIn = room.open || room.well || scene.openings.some((o) => o.wall.room === room.id) || sharesOpening(scene, room.id)
    if (!hasWayIn) {
      problems.push({
        severity: 'warning',
        path: `rooms.${index}`,
        entity: room.id,
        message: `"${room.id}" has no door or opening on any wall, so there is no way in.`,
      })
    }
  })

  scene.openings.forEach((opening, index) => {
    const room = rooms.get(opening.wall.room)
    if (!room) return
    const edge = edges(room)[opening.wall.edge]
    if (!edge) return
    const end = opening.at + opening.width
    if (end > edge.length + 1e-6) {
      const maxAt = Math.max(0, edge.length - opening.width)
      problems.push({
        severity: 'error',
        path: `openings.${index}`,
        entity: opening.id,
        message: `width ${opening.width} m from "at" ${opening.at} runs past the end of wall ${room.id}/edge ${opening.wall.edge} (${edge.length.toFixed(2)} m); lower "at" to ${maxAt.toFixed(2)} or less, or "width" to ${(edge.length - opening.at).toFixed(2)} or less.`,
      })
    }
    const bottom = opening.type === 'window' ? (opening.sill ?? DEFAULT_SILL) : 0
    const height = room.open ? room.parapet : roomHeight(scene, room)
    if (bottom + opening.height > height + 1e-6) {
      problems.push({
        severity: 'error',
        path: `openings.${index}.height`,
        entity: opening.id,
        message: `the top of "${opening.id}" is at ${(bottom + opening.height).toFixed(2)} m, above the ${height} m ceiling of "${room.id}"; lower "height"${opening.type === 'window' ? ' or "sill"' : ''}.`,
      })
    }
    if (opening.type !== 'window' && opening.sill) {
      problems.push({
        severity: 'warning',
        path: `openings.${index}.sill`,
        entity: opening.id,
        message: `"sill" only applies to windows; a ${opening.type} starts at the floor.`,
      })
    }
  })

  // A door needs 70 cm clear on both sides; an item standing there blocks it.
  const CLEAR = 0.7
  scene.openings.forEach((opening) => {
    // Windows, and wide openings that are really a missing wall, don't need a clear path.
    if (opening.type === 'window' || (opening.type === 'opening' && opening.width > 1.5)) return
    const room = rooms.get(opening.wall.room)
    const edge = room && edges(room)[opening.wall.edge]
    if (!room || !edge || edge.length === 0) return
    const ux = (edge.b[0] - edge.a[0]) / edge.length
    const uy = (edge.b[1] - edge.a[1]) / edge.length
    // Only the open panels of a slider need to stay clear.
    const clear = opening.type === 'slider' ? sliderLayout(opening.width, opening.height).gap : { from: 0, to: opening.width }
    const clearWidth = clear.to - clear.from
    const center: Point = [edge.a[0] + ux * (opening.at + (clear.from + clear.to) / 2), edge.a[1] + uy * (opening.at + (clear.from + clear.to) / 2)]
    const floor = roomElevation(scene, room)
    scene.items.forEach((item, index) => {
      const info = findAsset(item.asset)
      // Lift doors and railings belong in an opening.
      if (info?.passable || PASSABLE.has(item.asset) || info?.category === 'lift' || info?.category === 'railing') return
      const size = info && !info.resizable ? info.size : (item.size ?? info?.size)
      if (!size) return
      const itemRoom = rooms.get(item.room)
      const base = (itemRoom ? roomElevation(scene, itemRoom) : 0) + item.elevation
      if (base > floor + opening.height || base + size[2] * item.scale < floor + 0.25) return
      const zone = { x: center[0], y: center[1], halfW: clearWidth / 2, halfD: CLEAR, angle: Math.atan2(uy, ux) }
      const box = { x: item.at[0], y: item.at[1], halfW: (size[0] * item.scale) / 2 + 0.05, halfD: (size[1] * item.scale) / 2 + 0.05, angle: (-item.facing * Math.PI) / 180 }
      if (!rectanglesOverlap(zone, box)) return
      problems.push({
        severity: 'warning',
        path: `items.${index}.at`,
        entity: item.id,
        message: `"${item.id}" stands in the way of ${opening.type} "${opening.id}" (${opening.wall.room}, edge ${opening.wall.edge}); keep ${CLEAR} m clear on both sides of it.`,
      })
    })
  })

  // A wardrobe or a wall TV placed on a window covers it.
  scene.openings.forEach((opening) => {
    if (opening.type !== 'window') return
    const room = rooms.get(opening.wall.room)
    const edge = room && edges(room)[opening.wall.edge]
    if (!room || !edge || edge.length === 0) return
    const ux = (edge.b[0] - edge.a[0]) / edge.length
    const uy = (edge.b[1] - edge.a[1]) / edge.length
    const center: Point = [edge.a[0] + ux * (opening.at + opening.width / 2), edge.a[1] + uy * (opening.at + opening.width / 2)]
    const floor = roomElevation(scene, room)
    const sill = opening.sill ?? DEFAULT_SILL
    scene.items.forEach((item, index) => {
      const info = findAsset(item.asset)
      // Low pieces and things that belong under a window are fine there.
      if (['railing', 'plant', 'lamp', 'chair', 'seating', 'sofa', 'bench', 'bed', 'table', 'stairs', 'rug'].includes(info?.category ?? '')) return
      const size = info && !info.resizable ? info.size : (item.size ?? info?.size)
      if (!size) return
      const itemRoom = rooms.get(item.room)
      if (itemRoom && roomElevation(scene, itemRoom) !== floor) return
      const base = (itemRoom ? roomElevation(scene, itemRoom) : 0) + item.elevation
      // Only pieces that rise above the sill and stand against the wall.
      if (base + size[2] * item.scale < floor + sill + 0.3 || base > floor + sill + opening.height) return
      const halfD = (size[1] * item.scale) / 2
      const zone = { x: center[0], y: center[1], halfW: opening.width / 2, halfD: 0.3, angle: Math.atan2(uy, ux) }
      const box = { x: item.at[0], y: item.at[1], halfW: (size[0] * item.scale) / 2, halfD, angle: (-item.facing * Math.PI) / 180 }
      if (!rectanglesOverlap(zone, box)) return
      problems.push({
        severity: 'warning',
        path: `items.${index}.at`,
        entity: item.id,
        message: `"${item.id}" stands against window "${opening.id}" (${opening.wall.room}, edge ${opening.wall.edge}) and covers it; move one of them along the wall.`,
      })
    })
  })

  scene.items.forEach((item, index) => {
    const room = rooms.get(item.room)
    if (!room) return
    if (!pointInPolygon(item.at, room.floor)) {
      const c = room.floor.reduce<[number, number]>((acc, p) => [acc[0] + p[0] / room.floor.length, acc[1] + p[1] / room.floor.length], [0, 0])
      problems.push({
        severity: 'error',
        path: `items.${index}.at`,
        entity: item.id,
        message: `"${item.id}" at [${item.at.join(', ')}] is outside "${room.id}", whose center is [${c[0].toFixed(2)}, ${c[1].toFixed(2)}]; move it inside or change "room".`,
      })
    }
  })

  // Two solid pieces in the same place: a sofa through a table, a bed into
  // a wardrobe. Rugs, wall pieces, and things on different levels never
  // collide.
  const pieces = scene.items
    .map((item, index) => ({ item, index, info: findAsset(item.asset), room: rooms.get(item.room) }))
    .filter((s) => s.room && !s.info?.passable && !PASSABLE.has(s.item.asset) && !['stairs', 'railing', 'person'].includes(s.info?.category ?? ''))
    .map((s) => {
      const size = s.info && !s.info.resizable ? s.info.size : (s.item.size ?? s.info?.size)
      const base = roomElevation(scene, s.room!) + s.item.elevation
      return size ? { ...s, box: footprint(s.item, size), bottom: base, top: base + size[2] * s.item.scale } : undefined
    })
    .filter((s): s is NonNullable<typeof s> => !!s)
  type Solid = { id: string; path: string; where: string; category?: string; box: Rect; bottom: number; top: number }
  const solids: Solid[] = pieces.map((s) => ({ id: s.item.id, path: `items.${s.index}.at`, where: s.item.room, category: s.info?.category, box: s.box, bottom: s.bottom, top: s.top }))
  // Free solid objects too, except planes and groups, and except parts of
  // one assembly, which touch by design.
  const placed = placeObjects(scene)
  const ancestors = (id: string): Set<string> => {
    const out = new Set<string>()
    let at = scene.objects.find((o) => o.id === id)?.parent
    while (at && !out.has(at)) {
      out.add(at)
      at = scene.objects.find((o) => o.id === at)?.parent
    }
    return out
  }
  const family = new Map(placed.map((p) => [p.object.id, ancestors(p.object.id)]))
  for (const p of placed) {
    if (!p.object.solid || p.object.kind === 'plane' || p.object.kind === 'group') continue
    solids.push({ id: p.object.id, path: `objects.${p.index}.at`, where: p.object.parent ? `in ${p.object.parent}` : (p.object.room ?? 'the world'), box: p.footprint, bottom: p.box.min[2], top: p.box.max[2] })
  }
  const related = (a: string, b: string) => family.get(a)?.has(b) || family.get(b)?.has(a) || [...(family.get(a) ?? [])].some((x) => family.get(b)?.has(x))
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const p = solids[i]
      const q = solids[j]
      if (p.bottom >= q.top - 0.02 || q.bottom >= p.top - 0.02) continue
      if (related(p.id, q.id)) continue
      // A chair slides under its table, and kitchen units join at corners.
      const pair = [p.category, q.category]
      if ((pair.includes('chair') && pair.includes('table')) || (pair[0] && pair[0] === pair[1] && ['kitchen', 'wall'].includes(pair[0]))) continue
      // A couple of centimeters of touching is placement, not a collision.
      const shrink = (r: Rect) => ({ ...r, halfW: Math.max(0.01, r.halfW - 0.03), halfD: Math.max(0.01, r.halfD - 0.03) })
      if (!rectanglesOverlap(shrink(p.box), shrink(q.box))) continue
      problems.push({
        severity: 'warning',
        path: q.path,
        entity: q.id,
        message: `"${q.id}" runs into "${p.id}" (${p.where}); move one of them apart.`,
      })
    }
  }

  // Doors and drawers need room to open: 60 cm clear in front of a
  // wardrobe, cabinet, fridge, or kitchen unit, inside the room.
  const OPENS = new Set(['wardrobe', 'shelf', 'cabinet', 'kitchen', 'appliance', 'wash'])
  for (const s of pieces) {
    if (!s.info || !OPENS.has(s.info.category) || s.info.category === 'kitchen' && s.item.asset === 'kitchen/island-two-meter') continue
    const reach = 0.6
    const a = (s.item.facing * Math.PI) / 180
    // Facing turns the piece clockwise from north; its front points this way.
    const front: Point = [Math.sin(a), Math.cos(a)]
    const zone: Rect = { x: s.item.at[0] + front[0] * (s.box.halfD + reach / 2), y: s.item.at[1] + front[1] * (s.box.halfD + reach / 2), halfW: s.box.halfW, halfD: reach / 2, angle: s.box.angle }
    const outside = corners(zone).filter((c) => !pointInPolygon(c, s.room!.floor))
    if (outside.length > 0) {
      problems.push({
        severity: 'warning',
        path: `items.${s.index}.facing`,
        entity: s.item.id,
        message: `"${s.item.id}" faces a wall of "${s.room!.id}" closer than ${reach} m, so it cannot open; turn it with "facing" so its front points into the room.`,
      })
      continue
    }
    const blocker = pieces.find((o) => o !== s && o.room === s.room && !(o.info?.category === 'kitchen' && s.info?.category === 'kitchen') && o.bottom < s.top && o.top > s.bottom + 0.3 && rectanglesOverlap(zone, o.box))
    if (blocker) {
      problems.push({
        severity: 'warning',
        path: `items.${s.index}.at`,
        entity: s.item.id,
        message: `"${blocker.item.id}" stands in front of "${s.item.id}", which needs ${reach} m clear to open.`,
      })
    }
  }

  // A stair climbing under the floor above needs 2 m of headroom on every
  // step, unless that floor has a well over the stair.
  scene.items.forEach((item, index) => {
    const info = findAsset(item.asset)
    const room = rooms.get(item.room)
    if (!info || info.category !== 'stairs' || !room) return
    const size = item.size ?? info.size
    const level = scene.levels.find((l) => l.id === room.level)
    const above = level && levelAbove(scene, level)
    if (!above) return
    const rise = item.size?.[2] ?? floorToFloor(scene, room.level)
    const base = roomElevation(scene, room) + item.elevation
    const a = (item.facing * Math.PI) / 180
    const c = Math.cos(a)
    const n = Math.sin(a)
    const flight = stair(item.asset, size[0] * item.scale, size[1] * item.scale, rise)
    let worst: { headroom: number; step: number; under: string } | undefined
    flight.treads.forEach((tread, step) => {
      const lx = tread.polygon.reduce((sum, p) => sum + p[0], 0) / tread.polygon.length
      const ly = tread.polygon.reduce((sum, p) => sum + p[1], 0) / tread.polygon.length
      const world: Point = [item.at[0] + lx * c + ly * n, item.at[1] - lx * n + ly * c]
      const over = scene.rooms.find((r) => r.level === above.id && !r.well && pointInPolygon(world, r.floor))
      if (!over) return
      const headroom = above.elevation - above.slab - (base + tread.top)
      if (headroom < 2.0 && (!worst || headroom < worst.headroom)) worst = { headroom, step: step + 1, under: over.id }
    })
    if (worst) {
      problems.push({
        severity: 'warning',
        path: `items.${index}`,
        entity: item.id,
        message: `"${item.id}" has only ${worst.headroom.toFixed(2)} m of headroom at step ${worst.step}, under the floor of "${worst.under}"; make "${worst.under}" a well (or cut it back) over the stair, or move the stair.`,
      })
    }
  })

  return problems
}

// An item's footprint on the plan, as a rotated rectangle.
function footprint(item: Scene['items'][number], size: [number, number, number]): Rect {
  return { x: item.at[0], y: item.at[1], halfW: (size[0] * item.scale) / 2, halfD: (size[1] * item.scale) / 2, angle: (-item.facing * Math.PI) / 180 }
}

const PASSABLE = new Set(['rug/area', 'kitchen/wall-cabinets', 'tv/wall', 'screen/projection'])

// Two rectangles, each by center, half sizes, and turn: the separating
// axis test on their four edge directions.
interface Rect {
  x: number
  y: number
  halfW: number
  halfD: number
  angle: number
}
function corners(r: Rect): Point[] {
  const c = Math.cos(r.angle)
  const s = Math.sin(r.angle)
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([i, j]) => [r.x + i * r.halfW * c - j * r.halfD * s, r.y + i * r.halfW * s + j * r.halfD * c])
}
export function rectanglesOverlap(p: Rect, q: Rect): boolean {
  const a = corners(p)
  const b = corners(q)
  for (const poly of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = poly[i]
      const [x2, y2] = poly[(i + 1) % 4]
      const nx = -(y2 - y1)
      const ny = x2 - x1
      const project = (points: Point[]) => points.map(([x, y]) => x * nx + y * ny)
      const pa = project(a)
      const pb = project(b)
      if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false
    }
  }
  return true
}

// A room reached through a neighbor's opening on the shared wall.
function sharesOpening(scene: Scene, roomId: string): boolean {
  const room = scene.rooms.find((r) => r.id === roomId)
  if (!room) return false
  const mine = new Set(edges(room).map((e) => key(e.a, e.b)))
  return scene.openings.some((opening) => {
    const other = scene.rooms.find((r) => r.id === opening.wall.room)
    if (!other || other.id === roomId) return false
    const edge = edges(other)[opening.wall.edge]
    return edge ? mine.has(key(edge.a, edge.b)) : false
  })
}

function key(a: [number, number], b: [number, number]): string {
  const p = `${a[0].toFixed(4)},${a[1].toFixed(4)}`
  const q = `${b[0].toFixed(4)},${b[1].toFixed(4)}`
  return p < q ? `${p}|${q}` : `${q}|${p}`
}

export function formatProblem(problem: Problem): string {
  const where = problem.entity ? `${problem.path} "${problem.entity}"` : problem.path
  return `${problem.severity}: ${where}: ${problem.message}`
}
