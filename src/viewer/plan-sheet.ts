import { roomDimensions, type FloorPlan, type LineKind } from '../core/floor-plan.ts'
import { area, pointInPolygon, type Point } from '../core/geometry.ts'
import { roomName } from '../core/room-facts.ts'
import type { Scene } from '../core/schema.ts'
import { formatArea, formatLength, type Units } from '../core/units.ts'

// Plan mode's sheet: the floor plan drawn over the canvas as an SVG, so a
// wall is a crisp solid shape and a dimension a thin line at any zoom. It
// follows the plan camera, so a click on it still lands on the room the 3D
// view has under it. The drawing (the architects' image) can show under it.

const SVG = 'http://www.w3.org/2000/svg'
// From a wall's inner face to its dimension line, in pixels.
const DIMENSION_GAP = 16

// Room names and dimension figures in pixels, at the interface's own two
// small steps (style.css), so they follow the reader's font size.
const textSizes = () => {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14
  return { name: rem * 0.93, figure: rem * 0.86 }
}

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}
const overlap = (p: Box, q: Box) => p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom

export interface Drawing {
  // The image as the scene names it, and where it is served.
  image: string
  url: string
  // Pixels per meter, and the pixel that sits at plan [0, 0].
  scale: number
  origin: Point
}

// Where the sheet looks: the plan point at its middle, and pixels per meter.
export interface SheetView {
  x: number
  y: number
  scale: number
  width: number
  height: number
}

const make = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] => {
  const element = document.createElementNS(SVG, tag)
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value))
  parent?.append(element)
  return element
}

// A polygon or polyline as path data, north up.
const pathData = (points: Point[], closed: boolean) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(4)} ${(-y).toFixed(4)}`).join('') + (closed ? 'Z' : '')

export class PlanSheet {
  readonly element: SVGSVGElement
  private readonly world: SVGGElement
  private readonly drawings: SVGGElement
  private readonly model: SVGGElement
  private readonly mark: SVGPathElement
  private readonly labels: SVGGElement
  private readonly dimensions: SVGGElement
  private scene?: Scene
  private floorPlan?: FloorPlan
  private view?: SheetView
  private room?: string
  private units: Units = 'm'
  private labelsOn = true
  private shownAt = 0
  // The drawings of this storey that did not load.
  missing: Drawing[] = []
  // Hears of a drawing that does not load.
  private readonly onMissing: (drawing: Drawing) => void

  constructor(after: Element, onMissing: (drawing: Drawing) => void) {
    this.onMissing = onMissing
    this.element = make('svg', { class: 'plan-sheet', 'aria-hidden': 'true' })
    make('rect', { class: 'paper', width: '100%', height: '100%' }, this.element)
    this.world = make('g', {}, this.element)
    this.drawings = make('g', { class: 'drawings' }, this.world)
    this.model = make('g', { class: 'model' }, this.world)
    this.mark = make('path', { class: 'mark' })
    const screen = make('g', {}, this.element)
    this.dimensions = make('g', { class: 'dimensions' }, screen)
    this.labels = make('g', { class: 'labels' }, screen)
    after.after(this.element)
  }

  // Shown in Plan mode. Once it has covered the canvas a moment, the 3D
  // view under it need not be drawn.
  show(on: boolean, now: number) {
    if (on === this.element.classList.contains('shown')) return
    this.element.classList.toggle('shown', on)
    this.shownAt = on ? now : 0
  }
  covers(now: number): boolean {
    return this.shownAt > 0 && now - this.shownAt > 250
  }

  // The storey to draw, and the drawings that go under it.
  draw(scene: Scene, floorPlan: FloorPlan, drawings: Drawing[]) {
    this.scene = scene
    this.floorPlan = floorPlan
    this.drawings.replaceChildren()
    this.missing = []
    for (const drawing of drawings) {
      // Sized once the image says how big it is; its top-left pixel lands
      // at plan [-ox, +oy] over its scale.
      const image = make('image', { href: drawing.url, x: -drawing.origin[0] / drawing.scale, y: -drawing.origin[1] / drawing.scale, preserveAspectRatio: 'none' }, this.drawings)
      const probe = new Image()
      probe.onload = () => {
        image.setAttribute('width', String(probe.naturalWidth / drawing.scale))
        image.setAttribute('height', String(probe.naturalHeight / drawing.scale))
      }
      probe.onerror = () => {
        if (this.floorPlan !== floorPlan) return
        this.missing.push(drawing)
        this.onMissing(drawing)
      }
      probe.src = drawing.url
    }
    this.element.classList.toggle('has-drawing', drawings.length > 0)

    this.model.replaceChildren()
    const floors = make('g', { class: 'floors' }, this.model)
    for (const floor of floorPlan.floors) make('path', { class: floor.kind, d: pathData(floor.polygon, true) }, floors)
    this.model.append(this.mark)
    // Lines by kind, each kind one path: furniture under the walls, door
    // swings and window frames over them.
    const lines = (kinds: LineKind[]) => {
      const group = make('g', {}, this.model)
      for (const kind of kinds) {
        const d = floorPlan.lines.filter((line) => line.kind === kind).map((line) => pathData(line.points, !!line.closed)).join('')
        if (d) make('path', { class: kind, d }, group)
      }
    }
    lines(['furniture', 'tread', 'above', 'void'])
    const walls = make('g', { class: 'walls' }, this.model)
    for (const low of [true, false]) {
      const d = floorPlan.walls.filter((wall) => wall.low === low).map((wall) => pathData(wall.polygon, true)).join('')
      if (d) make('path', { class: low ? 'low' : 'cut', d }, walls)
    }
    lines(['frame', 'panel', 'glass', 'leaf', 'swing'])
    this.markRoom()
    this.drawScreen()
  }

  // The drawing under the floor plan, or not.
  showDrawing(on: boolean) {
    this.element.classList.toggle('drawing', on)
  }

  setView(view: SheetView) {
    const last = this.view
    if (last && last.x === view.x && last.y === view.y && last.scale === view.scale && last.width === view.width && last.height === view.height) return
    this.view = view
    this.element.setAttribute('viewBox', `0 0 ${view.width} ${view.height}`)
    const s = view.scale
    this.world.setAttribute('transform', `matrix(${s} 0 0 ${s} ${view.width / 2 - view.x * s} ${view.height / 2 + view.y * s})`)
    this.drawScreen()
  }

  // The current room, tinted and dimensioned, and the units its numbers
  // are in; names follow the L key.
  setRoom(room: string | undefined, units: Units, labelsOn: boolean) {
    if (room === this.room && units === this.units && labelsOn === this.labelsOn) return
    this.room = room
    this.units = units
    this.labelsOn = labelsOn
    this.markRoom()
    this.drawScreen()
  }

  private markRoom() {
    const floor = this.floorPlan?.floors.find((f) => f.room === this.room)
    this.mark.setAttribute('d', floor ? pathData(floor.polygon, true) : '')
  }

  // Plan points on the screen, in pixels.
  private toScreen([x, y]: Point): Point {
    const view = this.view!
    return [view.width / 2 + (x - view.x) * view.scale, view.height / 2 - (y - view.y) * view.scale]
  }

  // Room names and the current room's dimensions, at a constant size on
  // the screen, so they are redrawn as the view moves.
  private drawScreen() {
    this.labels.replaceChildren()
    this.dimensions.replaceChildren()
    const { scene, floorPlan, view } = this
    if (!scene || !floorPlan || !view) return
    const rooms = new Map(scene.rooms.map((room) => [room.id, room]))
    const sizes = textSizes()
    // Where the current room's name is, on the screen.
    let named: Box | undefined
    if (this.labelsOn) {
      for (const label of floorPlan.labels) {
        const room = rooms.get(label.room)
        if (!room || room.well) continue
        const name = roomName(room)
        const size = formatArea(area(room.floor), this.units)
        // Only where the whole name fits inside the room, but always the
        // current room's.
        const current = label.room === this.room
        const wide = Math.max(name.length, size.length) * sizes.name * 0.58 + 8
        const tall = sizes.name * 2.6
        const [dx, dy] = [wide / 2 / view.scale, tall / 2 / view.scale]
        const corners: Point[] = [[-dx, -dy], [dx, -dy], [dx, dy], [-dx, dy]]
        if (!current && !corners.every(([cx, cy]) => pointInPolygon([label.at[0] + cx, label.at[1] + cy], room.floor))) continue
        const [x, y] = this.toScreen(label.at)
        const text = make('text', { x, y: y - 2, class: current ? 'current' : '' }, this.labels)
        make('tspan', { x, class: 'name' }, text).textContent = name
        make('tspan', { x, dy: sizes.name * 1.25, class: 'area' }, text).textContent = size
        if (current) named = { left: x - wide / 2, right: x + wide / 2, top: y - tall / 2, bottom: y + tall / 2 }
      }
    }
    if (!this.room || !floorPlan.floors.some((f) => f.room === this.room)) return
    for (const side of roomDimensions(scene, this.room)) {
      const offset = side.face * view.scale + DIMENSION_GAP
      const shift = (p: Point): Point => {
        const [x, y] = this.toScreen(p)
        return [x + side.inward[0] * offset, y - side.inward[1] * offset]
      }
      const a = shift(side.a)
      const b = shift(side.b)
      const length = Math.hypot(b[0] - a[0], b[1] - a[1])
      const figure = formatLength(side.length, this.units)
      // Half the figure's length along the line, with a little air.
      const half = (figure.length * sizes.figure * 0.6) / 2 + 4
      const ux = (b[0] - a[0]) / length
      const uy = (b[1] - a[1]) / length
      // The figure goes in the middle of the line, or as near it as keeps
      // clear of the room's name; a side too short for it has none.
      const across = sizes.figure / 2 + 2
      const at = (t: number): Point => [a[0] + ux * length * t, a[1] + uy * length * t]
      const clear = (t: number) => {
        if (length * Math.min(t, 1 - t) < half + 8) return false
        if (!named) return true
        const [x, y] = at(t)
        const ex = Math.abs(ux) * half + Math.abs(uy) * across
        const ey = Math.abs(uy) * half + Math.abs(ux) * across
        return !overlap({ left: x - ex, right: x + ex, top: y - ey, bottom: y + ey }, named)
      }
      const places = [0.5]
      for (let d = 0.05; d < 0.5; d += 0.05) places.push(0.5 - d, 0.5 + d)
      const t = places.find(clear)
      if (t === undefined) continue
      const [mx, my] = at(t)
      // The line breaks for the figure; ticks across each end at 45
      // degrees, as drawn by hand.
      const tick = ([x, y]: Point) => `M${x - (ux + uy) * 4} ${y - (uy - ux) * 4}L${x + (ux + uy) * 4} ${y + (uy - ux) * 4}`
      const d = `M${a[0]} ${a[1]}L${mx - ux * half} ${my - uy * half}M${mx + ux * half} ${my + uy * half}L${b[0]} ${b[1]}`
      make('path', { class: 'line', d: d + tick(a) + tick(b) }, this.dimensions)
      // The figure on the line, reading upright.
      let angle = (Math.atan2(uy, ux) * 180) / Math.PI
      if (angle > 90.5) angle -= 180
      if (angle <= -89.5) angle += 180
      make('text', { x: mx, y: my, transform: `rotate(${angle.toFixed(2)} ${mx} ${my})` }, this.dimensions).textContent = figure
    }
  }
}
