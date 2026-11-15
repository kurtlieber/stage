import { floorPlan, type LineKind } from './floor-plan.ts'
import { area, bounds, centroid, levelsByElevation, pointInPolygon, storeys, type Point } from './geometry.ts'
import { roomName } from './room-facts.ts'
import type { Room, Scene } from './schema.ts'
import { formatArea, formatLength, formatLevel, type Units } from './units.ts'

// A floor plan sheet: one storey on an A3 page, at a standard scale, the
// way an architect presents a scheme. On the left the title, the indoor
// area and the zones with theirs; on the right the floor plan, every room
// named with its area, each zone tinted, and dimension strings round the
// outside. Plain SVG text in millimeters, so it prints true to scale.

// A3 landscape, in millimeters.
export const SHEET = { width: 420, height: 297 }
const MARGIN = 10
// The title block's width, and the gap between it and the plan.
const PANEL = 92
const GUTTER = 8
// From the drawing to its first dimension string, and between strings.
const STRING_GAP = 8
const STRING_STEP = 7
// The scales a drawing is printed at: 1:50, 1:100, and so on.
const SCALES = [20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000]
// Zone tints in the order zones sort: blue, rose, amber, then more.
export const ZONE_COLORS = ['#4f75d0', '#d9506f', '#e3ac2a', '#3e9a6c', '#8b62c9', '#d9793c', '#2f9cab', '#7f8a2c']
const FONT = "Inter, 'Helvetica Neue', Arial, 'DejaVu Sans', sans-serif"
// A character's width, as a share of its size, for fitting names.
const CHAR = 0.6

export interface SheetOptions {
  // Any level of the storey to draw; its split levels come with it. By
  // default the storey with the most indoor floor.
  level?: string
  // Over the scene's name.
  title?: string
  units?: Units
  // Printed in the corner, like 2026-11-15; today by default.
  date?: string
}

export interface Sheet {
  svg: string
  // Millimeters.
  width: number
  height: number
  // The scale the plan is printed at, as 1:scale.
  scale: number
  levels: string[]
  indoorArea: number
  zones: { zone: string; color: string; area: number }[]
  // Each dimension string, by side, as its run of lengths in meters.
  strings: { side: Side; lengths: number[] }[]
}

export type Side = 'north' | 'east' | 'south' | 'west'

// The levels drawn together as one storey: the level asked for and its
// split levels, or the storey with the most indoor floor.
export function storeyLevels(scene: Scene, level?: string): string[] {
  const levels = levelsByElevation(scene)
  const index = storeys(scene)
  const storeyOf = new Map(levels.map((l, i) => [l.id, index[i]]))
  let pick: number
  if (level !== undefined) {
    const found = storeyOf.get(level)
    if (found === undefined) throw new Error(`there is no level "${level}"; the levels are ${levels.map((l) => l.id).join(', ')}`)
    pick = found
  } else {
    const totals = new Map<number, number>()
    for (const room of scene.rooms) {
      const storey = storeyOf.get(room.level)
      if (storey === undefined || !indoor(room)) continue
      totals.set(storey, (totals.get(storey) ?? 0) + area(room.floor))
    }
    pick = [...totals].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0]?.[0] ?? 0
  }
  return levels.filter((l) => storeyOf.get(l.id) === pick).map((l) => l.id)
}

// Indoor floor: neither outdoors nor a hole in the floor.
const indoor = (room: Room) => !room.open && !room.well

// Every zone in the scene, in order, with its tint.
export function zoneColors(scene: Scene): Map<string, string> {
  const zones = [...new Set(scene.rooms.map((room) => room.zone).filter((zone): zone is string => !!zone))]
  zones.sort((p, q) => p.localeCompare(q, undefined, { numeric: true }))
  return new Map(zones.map((zone, i) => [zone, ZONE_COLORS[i % ZONE_COLORS.length]]))
}

export function floorPlanSheet(scene: Scene, options: SheetOptions = {}): Sheet {
  const units = options.units ?? 'm'
  const levels = storeyLevels(scene, options.level)
  const wanted = new Set(levels)
  const rooms = scene.rooms.filter((room) => wanted.has(room.level))
  if (!rooms.length) throw new Error(`the storey with ${levels.join(', ')} has no rooms to draw`)
  const plan = floorPlan(scene, levels)
  const byId = new Map(rooms.map((room) => [room.id, room]))

  // An outdoor room with an indoor room inside it is the ground the house
  // stands in, like a garden: the sheet frames the house, and the ground
  // shows round it as far as the paper goes.
  const site = (room: Room) => !!room.open && rooms.some((other) => indoor(other) && pointInPolygon(centroid(other.floor), room.floor))
  const framed = rooms.filter((room) => !site(room))

  // The largest standard scale the house and its dimension strings fit.
  const { min, max } = bounds((framed.length ? framed : rooms).flatMap((room) => room.floor))
  const extent = { minX: min[0], minY: min[1], maxX: max[0], maxY: max[1] }
  const reserve = STRING_GAP + STRING_STEP * 2
  const box = { left: MARGIN + PANEL + GUTTER + reserve, right: SHEET.width - MARGIN - reserve, top: MARGIN + reserve, bottom: SHEET.height - MARGIN - reserve }
  const spanX = Math.max(extent.maxX - extent.minX, 0.01)
  const spanY = Math.max(extent.maxY - extent.minY, 0.01)
  const scale = SCALES.find((s) => (spanX * 1000) / s <= box.right - box.left && (spanY * 1000) / s <= box.bottom - box.top) ?? SCALES.at(-1)!
  const k = 1000 / scale
  const ox = (box.left + box.right) / 2 - ((extent.minX + extent.maxX) / 2) * k
  const oy = (box.top + box.bottom) / 2 + ((extent.minY + extent.maxY) / 2) * k
  const px = (x: number) => ox + x * k
  const py = (y: number) => oy - y * k
  const path = (points: Point[], closed: boolean) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${n(px(x))} ${n(py(y))}`).join('') + (closed ? 'Z' : '')
  const drawing = { left: px(extent.minX), right: px(extent.maxX), top: py(extent.maxY), bottom: py(extent.minY) }

  const out: string[] = []
  const colors = zoneColors(scene)

  // The plan's paper, the floors, and each zone's rooms tinted.
  const paper = { x: MARGIN + PANEL + GUTTER, y: MARGIN, width: SHEET.width - 2 * MARGIN - PANEL - GUTTER, height: SHEET.height - 2 * MARGIN }
  const onPaper = ([x, y]: Point) => x >= paper.x && x <= paper.x + paper.width && y >= paper.y && y <= paper.y + paper.height
  const paperBox = `x="${n(paper.x)}" y="${n(paper.y)}" width="${n(paper.width)}" height="${n(paper.height)}"`
  out.push(`<clipPath id="paper"><rect ${paperBox}/></clipPath>`)
  out.push(`<rect class="plan-paper" ${paperBox}/>`)
  out.push('<g clip-path="url(#paper)">')
  out.push('<g class="floors">')
  for (const floor of plan.floors) out.push(`<path class="${floor.kind}" d="${path(floor.polygon, true)}"/>`)
  out.push('</g><g class="zones">')
  for (const floor of plan.floors) {
    const zone = byId.get(floor.room)?.zone
    if (zone && floor.kind !== 'well') out.push(`<path fill="${colors.get(zone)}" d="${path(floor.polygon, true)}"/>`)
  }
  out.push('</g>')
  const lines = (kinds: LineKind[]) => {
    for (const kind of kinds) {
      const d = plan.lines.filter((line) => line.kind === kind).map((line) => path(line.points, !!line.closed)).join('')
      if (d) out.push(`<path class="${kind}" d="${d}"/>`)
    }
  }
  lines(['furniture', 'tread', 'above', 'void'])
  for (const low of [true, false]) {
    const d = plan.walls.filter((wall) => wall.low === low).map((wall) => path(wall.polygon, true)).join('')
    if (d) out.push(`<path class="${low ? 'low' : 'cut'}" d="${d}"/>`)
  }
  lines(['frame', 'panel', 'glass', 'leaf', 'swing'])

  // Each room's name and area, as large as fits inside it; a room too
  // small for the smallest size has none.
  out.push('<g class="labels">')
  for (const label of plan.labels) {
    const room = byId.get(label.room)
    if (!room || room.well) continue
    const name = roomName(room)
    const size = formatArea(area(room.floor), units)
    for (const height of [2.2, 1.8, 1.5, 1.2]) {
      const wide = (Math.max(name.length, size.length * 0.85) * height * CHAR + 1) / k
      const tall = (height * 2.3) / k
      const corners: Point[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => [label.at[0] + (sx * wide) / 2, label.at[1] + (sy * tall) / 2])
      if (!corners.every((corner) => pointInPolygon(corner, room.floor) && onPaper([px(corner[0]), py(corner[1])]))) continue
      const [x, y] = [px(label.at[0]), py(label.at[1])]
      out.push(`<text x="${n(x)}" y="${n(y - height * 0.2)}" font-size="${height}"><tspan class="name">${esc(name)}</tspan><tspan class="area" x="${n(x)}" dy="${n(height * 1.15)}">${esc(size)}</tspan></text>`)
      break
    }
  }
  out.push('</g></g>')

  // Dimension strings: along each side, the breaks in the outside walls
  // seen from that side, and outside it the overall length.
  const strings: Sheet['strings'] = []
  out.push('<g class="dimensions">')
  const enclosed = rooms.filter(indoor).map((room) => room.floor)
  for (const side of ['north', 'east', 'south', 'west'] as Side[]) {
    const breaks = facadeBreaks(enclosed, side)
    if (breaks.length < 2) continue
    const overall = [breaks[0], breaks.at(-1)!]
    const runs = breaks.length > 2 ? [breaks, overall] : [overall]
    runs.forEach((run, i) => {
      const offset = STRING_GAP + STRING_STEP * i
      strings.push({ side, lengths: run.slice(1).map((v, j) => v - run[j]) })
      out.push(dimensionString(run, side, offset, drawing, side === 'north' || side === 'south' ? px : py, units))
    })
  }
  out.push('</g>')

  // The title block.
  const indoorArea = rooms.filter(indoor).reduce((sum, room) => sum + area(room.floor), 0)
  // A zone shows where it is tinted: on any floor of this storey but a well.
  const zones = [...colors].filter(([zone]) => rooms.some((room) => room.zone === zone && !room.well)).map(([zone, color]) => ({ zone, color, area: rooms.filter((room) => room.zone === zone && indoor(room)).reduce((sum, room) => sum + area(room.floor), 0) }))
  const left = MARGIN + 6
  const block: string[] = []
  // A band down the sheet's edge, in the zones' colors.
  const band = zones.length ? zones.map((z) => z.color) : ['#26262a']
  band.forEach((color, i) => {
    const h = (SHEET.height - 2 * MARGIN) / band.length
    block.push(`<rect x="${MARGIN}" y="${n(MARGIN + i * h)}" width="2.2" height="${n(h)}" fill="${color}"/>`)
  })
  let y = MARGIN + 14
  block.push(`<text class="title" x="${left}" y="${y}">Floor Plan</text>`)
  y += 8.5
  for (const line of wrap((options.title ?? scene.name).toUpperCase(), 30)) {
    block.push(`<text class="subtitle" x="${left}" y="${n(y)}">${esc(line)}</text>`)
    y += 5.6
  }
  y += 1.4
  block.push(`<text class="lead" x="${left}" y="${n(y)}">Indoor area: ${esc(formatArea(indoorArea, units))}</text>`)
  y += 11
  if (zones.length) {
    block.push(`<text class="heading" x="${left}" y="${n(y)}">ZONES</text>`)
    y += 6
    for (const zone of zones) {
      block.push(`<rect x="${left}" y="${n(y - 3.4)}" width="7" height="4.4" rx="0.6" fill="${zone.color}" fill-opacity="0.45" stroke="${zone.color}" stroke-width="0.25"/>`)
      block.push(`<text class="row" x="${left + 10}" y="${n(y)}">${esc(zoneName(zone.zone))}</text>`)
      block.push(`<text class="row figure" x="${MARGIN + PANEL - 4}" y="${n(y)}">${esc(formatArea(zone.area, units))}</text>`)
      y += 6.4
    }
    y += 5
  }
  block.push(`<text class="heading" x="${left}" y="${n(y)}">LEVELS</text>`)
  y += 6
  for (const level of levelsByElevation(scene).filter((l) => wanted.has(l.id))) {
    block.push(`<text class="row" x="${left}" y="${n(y)}">${esc(level.name ?? level.id)}</text>`)
    block.push(`<text class="row figure" x="${MARGIN + PANEL - 4}" y="${n(y)}">${esc(formatLevel(level.elevation, units))}</text>`)
    y += 5.6
  }

  // North arrow and scale bar, at the foot of the block.
  const foot = SHEET.height - MARGIN - 30
  block.push(northArrow(left + 6, foot - 4))
  block.push(scaleBar(left + 20, foot, k, scale, units))
  block.push(`<text class="note" x="${left}" y="${SHEET.height - MARGIN - 10}">Areas are measured to wall centerlines.</text>`)
  block.push(`<text class="note" x="${left}" y="${SHEET.height - MARGIN - 5.5}">Drawn by Stage · ${esc(options.date ?? new Date().toISOString().slice(0, 10))}</text>`)

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET.width}mm" height="${SHEET.height}mm" viewBox="0 0 ${SHEET.width} ${SHEET.height}">`,
    `<title>${esc(`Floor Plan: ${options.title ?? scene.name}`)}</title>`,
    `<style>${STYLE}</style>`,
    `<rect width="${SHEET.width}" height="${SHEET.height}" fill="#fff"/>`,
    ...block,
    ...out,
    '</svg>',
  ].join('\n')
  return { svg, width: SHEET.width, height: SHEET.height, scale, levels, indoorArea, zones, strings }
}

// Along one side, where the outside walls seen from that side break: the
// ends of each stretch of wall nothing stands in front of, and the walls
// that meet it. In meters along the side, west to east or south to north.
export function facadeBreaks(floors: Point[][], side: Side): number[] {
  // Turned so the side faces north; turning keeps the winding.
  const turn = { north: ([x, y]: Point): Point => [x, y], east: ([x, y]: Point): Point => [-y, x], south: ([x, y]: Point): Point => [-x, -y], west: ([x, y]: Point): Point => [y, -x] }[side]
  const polygons = floors.map((floor) => {
    const turned = floor.map(turn)
    return signedArea(turned) < 0 ? turned.reverse() : turned
  })
  const found: number[] = []
  for (const polygon of polygons) {
    polygon.forEach((a, i) => {
      const b = polygon[(i + 1) % polygon.length]
      // Counter-clockwise, an edge running west has the room south of it.
      if (Math.abs(a[1] - b[1]) > 1e-6 || b[0] >= a[0]) return
      const y = a[1]
      // What stands north of it hides it.
      let visible: [number, number][] = [[b[0], a[0]]]
      for (const other of polygons) {
        const hidden = northOf(other, y + 0.01)
        if (hidden) visible = visible.flatMap(([from, to]) => cut(from, to, hidden[0], hidden[1]))
      }
      for (const [from, to] of visible) {
        if (to - from < 0.01) continue
        found.push(from, to)
        // Walls meeting the stretch: corners of any floor on it.
        for (const p of polygons) for (const [x, py] of p) if (Math.abs(py - y) < 0.01 && x > from && x < to) found.push(x)
      }
    })
  }
  found.sort((p, q) => p - q)
  const merged: number[] = []
  for (const value of found) if (!merged.length || value - merged.at(-1)! > 0.03) merged.push(value)
  // Back to the side's own direction: west to east along the north and
  // south, south to north along the east and west.
  const back = { north: (u: number) => u, south: (u: number) => -u, east: (u: number) => -u, west: (u: number) => u }[side]
  return merged.map(back).sort((p, q) => p - q).map((v) => Math.round(v * 1e4) / 1e4)
}

// The stretch of x a polygon covers north of y, or nothing.
function northOf(polygon: Point[], y: number): [number, number] | undefined {
  const xs: number[] = []
  polygon.forEach((a, i) => {
    const b = polygon[(i + 1) % polygon.length]
    if (a[1] > y) xs.push(a[0])
    if ((a[1] - y) * (b[1] - y) < 0) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]))
  })
  return xs.length ? [Math.min(...xs), Math.max(...xs)] : undefined
}

// [from, to] less the open stretch (hideFrom, hideTo).
function cut(from: number, to: number, hideFrom: number, hideTo: number): [number, number][] {
  if (hideTo <= from + 1e-6 || hideFrom >= to - 1e-6) return [[from, to]]
  const left: [number, number][] = hideFrom > from ? [[from, hideFrom]] : []
  const right: [number, number][] = hideTo < to ? [[hideTo, to]] : []
  return [...left, ...right]
}

function signedArea(polygon: Point[]): number {
  let sum = 0
  polygon.forEach(([x1, y1], i) => {
    const [x2, y2] = polygon[(i + 1) % polygon.length]
    sum += x1 * y2 - x2 * y1
  })
  return sum / 2
}

// One dimension string outside the drawing: a line, a tick at each break,
// and each length over its stretch where the figure fits.
function dimensionString(run: number[], side: Side, offset: number, drawing: { left: number; right: number; top: number; bottom: number }, place: (v: number) => number, units: Units): string {
  const horizontal = side === 'north' || side === 'south'
  const at = { north: drawing.top - offset, south: drawing.bottom + offset, west: drawing.left - offset, east: drawing.right + offset }[side]
  const point = (v: number): Point => (horizontal ? [place(v), at] : [at, place(v)])
  const parts: string[] = []
  const [a, b] = [point(run[0]), point(run.at(-1)!)]
  let d = `M${n(a[0])} ${n(a[1])}L${n(b[0])} ${n(b[1])}`
  for (const v of run) {
    const [x, y] = point(v)
    d += `M${n(x - 0.7)} ${n(y + 0.7)}L${n(x + 0.7)} ${n(y - 0.7)}`
    // A short extension line across the string.
    d += horizontal ? `M${n(x)} ${n(y - 1.2)}L${n(x)} ${n(y + 1.2)}` : `M${n(x - 1.2)} ${n(y)}L${n(x + 1.2)} ${n(y)}`
  }
  parts.push(`<path d="${d}"/>`)
  const size = 1.9
  for (let i = 1; i < run.length; i++) {
    const length = run[i] - run[i - 1]
    const figure = units === 'm' ? length.toFixed(2) : formatLength(length, units)
    const [p, q] = [point(run[i - 1]), point(run[i])]
    const span = Math.hypot(q[0] - p[0], q[1] - p[1])
    if (span < figure.length * size * CHAR + 0.8) continue
    const [mx, my] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
    // Read from below or from the right, as drawings are.
    parts.push(horizontal ? `<text x="${n(mx)}" y="${n(my - 0.9)}" font-size="${size}">${esc(figure)}</text>` : `<text x="${n(mx - 0.9)}" y="${n(my)}" font-size="${size}" transform="rotate(-90 ${n(mx - 0.9)} ${n(my)})">${esc(figure)}</text>`)
  }
  return parts.join('')
}

function northArrow(x: number, y: number): string {
  return `<g class="north"><path d="M${x} ${y - 7}L${x + 3} ${y + 3}L${x} ${y + 1}L${x - 3} ${y + 3}Z"/><text x="${x}" y="${y - 8.6}" font-size="3">N</text></g>`
}

// A bar of four round lengths, at most 60 mm long, labelled, and the scale.
function scaleBar(x: number, y: number, k: number, scale: number, units: Units): string {
  const unit = units === 'm' ? 1 : 0.3048
  const steps = [0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]
  const step = steps.filter((s) => s * unit * k * 4 <= 60).at(-1) ?? steps[0]
  const parts = [`<g class="scale">`]
  for (let i = 0; i < 4; i++) parts.push(`<rect x="${n(x + i * step * unit * k)}" y="${y - 1.2}" width="${n(step * unit * k)}" height="1.2" class="${i % 2 ? 'light' : 'dark'}"/>`)
  for (let i = 0; i <= 4; i += 2) parts.push(`<text x="${n(x + i * step * unit * k)}" y="${y - 2.4}" font-size="2.2">${i * step}${i === 4 ? (units === 'm' ? ' m' : ' ft') : ''}</text>`)
  parts.push(`<text class="ratio" x="${x}" y="${y + 5}" font-size="2.6">Scale 1:${scale} at A3</text>`)
  parts.push('</g>')
  return parts.join('')
}

// "A" reads as Zone A; a longer name stands as it is.
const zoneName = (zone: string) => (zone.length <= 2 ? `Zone ${zone}` : zone)

function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  for (const word of text.split(/\s+/)) {
    const last = lines.at(-1)
    if (last !== undefined && (last + ' ' + word).length <= width) lines[lines.length - 1] = last + ' ' + word
    else lines.push(word)
  }
  return lines
}

const n = (value: number) => (Math.round(value * 100) / 100).toString()
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The viewer's Plan mode ink and paper, at print weights in millimeters.
const STYLE = `
text { font-family: ${FONT}; fill: #26262a; text-anchor: middle; font-variant-numeric: tabular-nums; }
.plan-paper { fill: #f6f4ef; }
.floors .room { fill: #fff; }
.floors .open { fill: #eceae4; stroke: #85817a; stroke-width: 0.1; }
.floors .well { fill: #f6f4ef; }
.zones path { fill-opacity: 0.3; }
.cut { fill: #26262a; }
.low { fill: #8a867f; }
.furniture, .tread { fill: none; stroke: #85817a; stroke-width: 0.1; }
.above { fill: none; stroke: #85817a; stroke-width: 0.1; stroke-dasharray: 0.8 0.6; }
.void { fill: none; stroke: #8a867f; stroke-width: 0.1; stroke-dasharray: 1.2 0.8; }
.frame, .panel { fill: #fff; stroke: #26262a; stroke-width: 0.1; }
.glass { fill: none; stroke: #26262a; stroke-width: 0.1; }
.leaf { fill: none; stroke: #26262a; stroke-width: 0.15; }
.swing { fill: none; stroke: #26262a; stroke-width: 0.08; }
.labels .name { font-weight: 600; }
.labels .area { fill: #57544f; font-size: 0.85em; }
.dimensions path { fill: none; stroke: #26262a; stroke-width: 0.12; }
.title { font-size: 11px; font-weight: 700; text-anchor: start; }
.subtitle { font-size: 4.6px; letter-spacing: 0.3px; text-anchor: start; }
.lead { font-size: 4.2px; text-anchor: start; }
.heading { font-size: 2.6px; font-weight: 700; letter-spacing: 0.5px; fill: #57544f; text-anchor: start; }
.row { font-size: 3.4px; text-anchor: start; }
.row.figure { text-anchor: end; }
.note { font-size: 2.4px; fill: #57544f; text-anchor: start; }
.north path { fill: #26262a; }
.north text { font-weight: 700; }
.scale .dark { fill: #26262a; }
.scale .light { fill: #fff; stroke: #26262a; stroke-width: 0.15; }
.scale .ratio { text-anchor: start; }
`
