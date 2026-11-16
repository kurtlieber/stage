import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { STATUS_LABEL, designsIn, groupByRoom, latestRevision, partOfNode, type Design, type DesignPart } from '../core/design.ts'
import { roomName } from '../core/room-facts.ts'
import type { Scene } from '../core/schema.ts'
import { formatMillimeters, type Units } from '../core/units.ts'
import { loadModelFrom } from './library.ts'

// Designs: the furniture and cabinetry drawn for a project, beside its
// scenes. A button in the top bar opens the gallery; a design opens alone
// on a studio floor, with its parts, the rooms it stands in, and its files.
// Read-only, like the rest of the viewer: the CAD pipeline writes designs.

export interface DesignHost {
  canvas: HTMLCanvasElement
  renderer: THREE.WebGLRenderer
  camera: THREE.PerspectiveCamera
  orbit: { target: THREE.Vector3; update(): void; minDistance: number; maxDistance: number }
  // The scene on screen, its name, and the room every mode centres on.
  scene(): Scene | undefined
  scenePath: string
  currentRoom(): string | undefined
  units(): Units
  setUnits(units: Units): void
  // The viewer steps aside for a design, and comes back as it was.
  enter(): void
  leave(restore: boolean): void
  // The placed object in Room mode, if this scene has it; false if not.
  showInRoom(room: string, object: string): boolean
  setStatus(text: string): void
}

const ACCENT = new THREE.Color('#e8b43a')
// The studio: a pale, even backdrop the floor fades into, so the piece
// reads on its own, lit from the front and a little above, as a
// photographer would.
const BACKDROP = '#d4d1cb'

export class Designs {
  readonly studio = new THREE.Scene()
  private all: Design[] = []
  private open: Design | undefined
  private model: THREE.Object3D | undefined
  private meshes = new Map<string, THREE.Mesh[]>()
  private hovered: string | undefined
  private pinned: string | undefined
  private shown: string | undefined
  private showAll = false
  private offsetFor = ''
  private loading = 0
  private readonly key = new THREE.DirectionalLight('#fff8ee', 2.1)
  private readonly floor: THREE.Mesh
  private readonly raycaster = new THREE.Raycaster()
  private readonly button = document.getElementById('designs-button') as HTMLButtonElement
  private readonly gallery = document.getElementById('gallery')!
  private readonly panel = document.getElementById('design-panel')!
  private readonly back = document.getElementById('design-back') as HTMLButtonElement

  private readonly host: DesignHost

  constructor(host: DesignHost) {
    this.host = host
    const studio = this.studio
    studio.background = new THREE.Color(BACKDROP)
    const pmrem = new THREE.PMREMGenerator(host.renderer)
    studio.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    studio.environmentIntensity = 0.55
    studio.add(new THREE.HemisphereLight('#f4f1ea', '#9c958a', 0.7))
    this.key.castShadow = true
    this.key.shadow.mapSize.set(2048, 2048)
    this.key.shadow.bias = -0.0004
    this.key.shadow.normalBias = 0.01
    studio.add(this.key, this.key.target)
    // Only the shadows show on the floor, so it melts into the backdrop.
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: 0.22 }))
    this.floor.rotation.x = -Math.PI / 2
    this.floor.receiveShadow = true
    studio.add(this.floor)

    this.button.addEventListener('click', () => this.toggleGallery())
    this.back.addEventListener('click', () => this.close())
    this.hover()
  }

  get viewing(): boolean {
    return !!this.open
  }

  get galleryOpen(): boolean {
    return !this.gallery.classList.contains('hidden')
  }

  // The designs of the scene's project, from the server. A server of one
  // scene file, or a share bundle, has none, and the button stays hidden.
  async refresh(): Promise<void> {
    const response = await fetch('./api/designs', { cache: 'no-store' }).catch(() => undefined)
    if (!response?.ok) return
    const list = (await response.json().catch(() => [])) as Design[]
    if (!Array.isArray(list)) return
    this.all = list
    this.render()
    // The design on screen was written again: show the new one.
    const open = this.open
    if (open) {
      const next = list.find((d) => d.id === open.id)
      if (!next) this.close()
      else if (JSON.stringify(next) !== JSON.stringify(open)) void this.show(next.id, false)
    }
  }

  // Everything that depends on the room, the units, or the list.
  render() {
    this.renderButton()
    if (this.galleryOpen) this.renderGallery()
    if (this.open) this.renderPanel()
  }

  private project(): string | undefined {
    return this.host.scenePath.includes('/') && !this.host.scenePath.startsWith('/') ? this.host.scenePath.split('/')[0] : undefined
  }

  private mine(): Design[] {
    const project = this.project()
    return this.all.filter((design) => design.project === project)
  }

  private roomLabel(id: string): string {
    const room = this.host.scene()?.rooms.find((r) => r.id === id)
    return room ? roomName(room) : roomName({ id } as Scene['rooms'][number])
  }

  // ---- The button and the gallery --------------------------------------------

  private renderButton() {
    const designs = this.mine()
    const room = this.host.currentRoom()
    this.button.classList.toggle('hidden', designs.length === 0)
    const count = room ? designsIn(designs, room).length : designs.length
    // A phone shows only the glyph and the count, so the modes still fit.
    const glyph = document.createElement('span')
    glyph.className = 'glyph'
    glyph.setAttribute('aria-hidden', 'true')
    glyph.innerHTML = CABINET
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = 'Designs'
    this.button.replaceChildren(glyph, label)
    if (room) {
      const where = document.createElement('span')
      where.className = 'where'
      where.textContent = ` · ${this.roomLabel(room)}`
      this.button.append(where)
    }
    this.button.append(` (${count})`)
    this.button.setAttribute('aria-label', room ? `Designs in ${this.roomLabel(room)}: ${count}` : `Designs: ${count}`)
    if (designs.length === 0 && this.galleryOpen) this.toggleGallery(false)
  }

  toggleGallery(show = !this.galleryOpen) {
    this.gallery.classList.toggle('hidden', !show)
    this.button.setAttribute('aria-expanded', String(show))
    document.body.classList.toggle('gallery-open', show)
    if (!show) {
      if (this.gallery.contains(document.activeElement)) this.button.focus()
      return
    }
    const room = this.host.currentRoom()
    this.showAll = !room || designsIn(this.mine(), room).length === 0
    this.renderGallery()
    this.gallery.querySelector<HTMLElement>('.card')?.focus()
  }

  private renderGallery() {
    const designs = this.mine()
    const room = this.host.currentRoom()
    const inRoom = room ? designsIn(designs, room) : []
    const focused = document.activeElement instanceof HTMLElement && this.gallery.contains(document.activeElement) ? (document.activeElement.dataset.key ?? '') : undefined
    this.gallery.replaceChildren()

    const head = add(this.gallery, 'div', undefined, 'head')
    const title = add(head, 'h2', 'Designs')
    title.id = 'gallery-title'
    const close = add(head, 'button', '×', 'close')
    close.type = 'button'
    close.title = 'Close (Esc)'
    close.setAttribute('aria-label', 'Close the designs')
    close.dataset.key = 'close'
    close.addEventListener('click', () => this.toggleGallery(false))

    if (room) {
      const switcher = add(this.gallery, 'div', undefined, 'units scope')
      switcher.setAttribute('role', 'group')
      switcher.setAttribute('aria-label', 'Which designs')
      for (const [all, text] of [[false, `${this.roomLabel(room)} (${inRoom.length})`], [true, `All designs (${designs.length})`]] as const) {
        const button = add(switcher, 'button', text)
        button.type = 'button'
        button.dataset.key = `scope-${all}`
        button.setAttribute('aria-pressed', String(this.showAll === all))
        button.addEventListener('click', () => {
          this.showAll = all
          this.renderGallery()
        })
      }
    }

    if (room && !this.showAll) {
      if (inRoom.length === 0) add(this.gallery, 'p', `Nothing is designed for ${this.roomLabel(room)} yet.`, 'empty-note')
      this.cards(this.gallery, inRoom, room)
    } else {
      const order = this.host.scene()?.rooms.map((r) => r.id) ?? []
      // A room's designs first when there is one, then the rest by room.
      const groups = groupByRoom(designs, order)
      if (room) groups.sort((a, b) => Number(b.room === room) - Number(a.room === room))
      for (const group of groups) {
        add(this.gallery, 'h3', group.room ? this.roomLabel(group.room) : 'Not in a room')
        this.cards(this.gallery, group.designs, group.room)
      }
    }
    if (focused !== undefined) this.gallery.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus()
  }

  private cards(parent: HTMLElement, designs: Design[], group: string) {
    const list = add(parent, 'ul', undefined, 'cards')
    const units = this.host.units()
    for (const design of designs) {
      const card = add(add(list, 'li'), 'button', undefined, 'card')
      card.type = 'button'
      card.dataset.key = `${group}/${design.id}`
      card.addEventListener('click', () => void this.show(design.id, true))
      card.append(thumbnail(design))
      const text = add(card, 'span', undefined, 'text')
      add(text, 'span', design.name, 'name')
      if (design.rooms.length) add(text, 'span', design.rooms.map((r) => this.roomLabel(r)).join(', '), 'rooms')
      const meta = add(text, 'span', undefined, 'meta')
      meta.append(statusChip(design))
      add(meta, 'span', revisionText(design), 'rev')
      add(text, 'span', formatMillimeters(design.size.map((m) => m * 1000), units), 'dims')
    }
  }

  // ---- The design view -------------------------------------------------------

  // Opens a design alone on the studio floor. `fresh` frames the camera on
  // it; a design written again while open keeps the camera where it is.
  async show(id: string, fresh: boolean): Promise<void> {
    const design = this.all.find((d) => d.id === id)
    if (!design) {
      this.host.setStatus(`No design is called "${id}".`)
      return
    }
    if (this.galleryOpen) this.toggleGallery(false)
    const first = !this.open
    this.open = design
    if (first) this.host.enter()
    document.body.classList.add('designing')
    this.back.classList.remove('hidden')
    this.hovered = undefined
    if (fresh) this.pinned = undefined
    const url = new URL(location.href)
    url.searchParams.set('design', id)
    history.replaceState(null, '', url)
    this.renderPanel()
    if (first) this.panel.querySelector<HTMLElement>('h2')?.focus()

    const ticket = ++this.loading
    const loaded = await loadModelFrom(fileUrl(design, design.files.model))
    if (ticket !== this.loading || this.open !== design) return
    if (this.model) this.studio.remove(this.model)
    this.model = undefined
    this.meshes.clear()
    if (!loaded) {
      this.host.setStatus(`Unable to load the model of ${escapeText(design.name)}.`)
      return
    }
    // A copy with its own materials, so lighting up a part touches only it.
    const model = loaded.clone(true)
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) object.material = Array.isArray(object.material) ? object.material.map((m) => m.clone()) : object.material.clone()
    })
    this.model = model
    this.studio.add(model)
    model.updateMatrixWorld(true)
    for (const part of design.parts) this.meshes.set(part.id, [])
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      const part = this.partOf(object)
      if (part) this.meshes.get(part.id)!.push(object)
    })
    this.light(fresh || first)
    this.highlight()
    this.renderPanel()
  }

  // The part a mesh belongs to: its own node's name, or the nearest
  // ancestor's that names a part.
  private partOf(object: THREE.Object3D): DesignPart | undefined {
    for (let o: THREE.Object3D | null = object; o && o !== this.model; o = o.parent) {
      const part = partOfNode(o.name, this.open?.parts ?? [])
      if (part) return part
    }
    return undefined
  }

  // Lights the piece for its size and, for a new one, frames it from the
  // front (the model's −Z side) and a little to the left, from above.
  private light(frame: boolean) {
    if (!this.model) return
    const box = new THREE.Box3().setFromObject(this.model)
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(0.3, box.getSize(new THREE.Vector3()).length() / 2)
    this.key.target.position.copy(center).setY(0)
    this.key.position.copy(center).add(new THREE.Vector3(-0.9, 1.8, -1.3).normalize().multiplyScalar(radius * 4))
    const shadow = this.key.shadow.camera
    shadow.left = shadow.bottom = -radius * 1.6
    shadow.right = shadow.top = radius * 1.6
    shadow.near = radius
    shadow.far = radius * 8
    shadow.updateProjectionMatrix()
    const { camera, orbit } = this.host
    orbit.minDistance = Math.max(0.15, radius * 0.25)
    orbit.maxDistance = radius * 12
    if (!frame) return
    camera.fov = 35
    camera.updateProjectionMatrix()
    // Fit the piece's sphere to the part of the canvas the panel leaves.
    const free = this.free()
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    const half = Math.atan(Math.min((tan * free.height) / window.innerHeight, (tan * camera.aspect * free.width) / window.innerWidth))
    const distance = (radius / Math.sin(half)) * 1.04
    orbit.target.copy(center)
    camera.position.copy(center).add(new THREE.Vector3(-0.42, 0.38, -1).normalize().multiplyScalar(distance))
    orbit.update()
    this.offsetFor = ''
  }

  // The canvas the top bar and the panel leave free: beside the panel on a
  // wide screen, above it on a phone.
  private free(): { left: number; top: number; width: number; height: number } {
    const width = window.innerWidth
    const height = window.innerHeight
    const rect = this.panel.getBoundingClientRect()
    const top = 56
    if (!rect.width) return { left: 0, top, width, height: height - 2 * top }
    if (rect.left > width / 2) return { left: 0, top, width: rect.left - 8, height: height - 2 * top }
    return { left: 0, top, width, height: Math.max(80, rect.top - 8 - top) }
  }

  // Back to where the person was: the view, the room, the camera.
  close(restore = true) {
    if (!this.open) return
    this.open = undefined
    this.loading++
    if (this.model) this.studio.remove(this.model)
    this.model = undefined
    this.meshes.clear()
    this.hovered = this.pinned = this.shown = undefined
    this.offsetFor = ''
    this.host.camera.clearViewOffset()
    this.panel.classList.add('hidden')
    this.panel.replaceChildren()
    this.back.classList.add('hidden')
    document.body.classList.remove('designing')
    const url = new URL(location.href)
    url.searchParams.delete('design')
    history.replaceState(null, '', url)
    this.host.leave(restore)
    if (restore && !this.button.classList.contains('hidden')) this.button.focus()
  }

  // Each frame of the design view: the picture moved so the piece sits in
  // the middle of the free part of the canvas, not under the panel.
  frame() {
    const free = this.free()
    const width = window.innerWidth
    const height = window.innerHeight
    const key = `${width}x${height}:${free.left},${free.top},${free.width},${free.height}`
    if (key === this.offsetFor) return
    this.offsetFor = key
    const x = width / 2 - (free.left + free.width / 2)
    const y = height / 2 - (free.top + free.height / 2)
    if (Math.abs(x) + Math.abs(y) < 1) this.host.camera.clearViewOffset()
    else this.host.camera.setViewOffset(width, height, x, y, width, height)
  }

  // A part lit up while the pointer is on it, or in its row of the list, or
  // after a click on either, until the next.
  private hover() {
    const { canvas } = this.host
    let down: { x: number; y: number } | undefined
    let queued: PointerEvent | undefined
    const pick = (event: PointerEvent): string | undefined => {
      if (!this.model) return undefined
      const rect = canvas.getBoundingClientRect()
      const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
      this.raycaster.setFromCamera(pointer, this.host.camera)
      for (const hit of this.raycaster.intersectObject(this.model, true)) {
        const part = this.partOf(hit.object)
        if (part) return part.id
      }
      return undefined
    }
    canvas.addEventListener('pointermove', (event) => {
      if (!this.open || event.buttons || event.pointerType === 'touch') return
      // One pick a frame, however fast the pointer moves.
      if (!queued)
        requestAnimationFrame(() => {
          if (queued && this.open) this.setHovered(pick(queued), true)
          queued = undefined
        })
      queued = event
    })
    canvas.addEventListener('pointerleave', () => this.open && this.setHovered(undefined, false))
    canvas.addEventListener('pointerdown', (event) => (down = { x: event.clientX, y: event.clientY }))
    canvas.addEventListener('click', (event) => {
      if (!this.open || !down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return
      const part = pick(event as PointerEvent)
      this.pin(part === this.pinned ? undefined : part, true)
    })
  }

  private setHovered(id: string | undefined, fromModel: boolean) {
    if (id === this.hovered) return
    this.hovered = id
    this.highlight(fromModel)
  }

  private pin(id: string | undefined, fromModel: boolean) {
    this.pinned = id
    for (const row of this.panel.querySelectorAll<HTMLButtonElement>('.parts button')) row.setAttribute('aria-pressed', String(row.dataset.part === id))
    this.highlight(fromModel)
  }

  // Tints the shown part's meshes with the accent, and marks its row.
  private highlight(scroll = false) {
    const id = this.hovered ?? this.pinned
    if (id !== this.shown) {
      for (const mesh of this.meshes.get(this.shown ?? '') ?? []) tint(mesh, false)
      for (const mesh of this.meshes.get(id ?? '') ?? []) tint(mesh, true)
      this.shown = id
    }
    for (const row of this.panel.querySelectorAll<HTMLElement>('.parts button')) {
      const on = row.dataset.part === id
      row.classList.toggle('lit', on)
      if (on && scroll) row.scrollIntoView({ block: 'nearest' })
    }
  }

  private renderPanel() {
    const design = this.open
    if (!design) return
    const units = this.host.units()
    const panel = this.panel
    const focused = document.activeElement instanceof HTMLElement && panel.contains(document.activeElement) ? (document.activeElement.dataset.key ?? 'title') : undefined
    panel.classList.remove('hidden')
    panel.replaceChildren()

    const title = add(panel, 'h2', design.name)
    title.id = 'design-title'
    title.tabIndex = -1
    title.dataset.key = 'title'
    const status = add(panel, 'div', undefined, 'meta')
    status.append(statusChip(design))
    add(status, 'span', revisionText(design), 'rev')
    if (design.summary) add(panel, 'p', design.summary, 'summary')

    const facts = add(panel, 'dl', undefined, 'facts')
    const fact = (term: string, value: string) => {
      add(facts, 'dt', term)
      add(facts, 'dd', value)
    }
    const [w, d, h] = design.size.map((m) => formatMillimeters([m * 1000], units))
    fact('Width', w)
    fact('Depth', d)
    fact('Height', h)
    if (design.updated) fact('Updated', design.updated.slice(0, 10))

    if (design.parts.length) {
      add(panel, 'h3', `Parts (${design.parts.reduce((n, p) => n + p.qty, 0)})`)
      const list = add(panel, 'ul', undefined, 'parts')
      for (const part of design.parts) {
        const row = add(add(list, 'li'), 'button')
        row.type = 'button'
        row.dataset.part = part.id
        row.dataset.key = `part-${part.id}`
        row.setAttribute('aria-pressed', String(this.pinned === part.id))
        add(row, 'span', part.name || part.id, 'name')
        add(row, 'span', part.qty > 1 ? `×${part.qty}` : '', 'qty')
        // The part id, as the cut list and the drawings label it, leads the
        // second line, then what it is made of and its size.
        const line = add(row, 'span', undefined, 'dims')
        add(line, 'span', part.id, 'id')
        const detail = [part.material, part.size_mm && formatMillimeters(part.size_mm, units)].filter(Boolean)
        if (detail.length) line.append(` · ${detail.join(' · ')}`)
        row.addEventListener('mouseenter', () => this.setHovered(part.id, false))
        row.addEventListener('mouseleave', () => this.setHovered(undefined, false))
        row.addEventListener('focus', () => this.setHovered(part.id, false))
        row.addEventListener('blur', () => this.setHovered(undefined, false))
        row.addEventListener('click', () => this.pin(this.pinned === part.id ? undefined : part.id, false))
      }
    }

    if (design.placements.length) {
      add(panel, 'h3', 'In the house')
      const list = add(panel, 'ul', undefined, 'placements')
      for (const placement of design.placements) {
        const button = add(add(list, 'li'), 'button', `See in ${this.roomLabel(placement.room)}`, 'link')
        button.type = 'button'
        button.dataset.key = `place-${placement.object}`
        button.addEventListener('click', () => void this.seeInRoom(design, placement))
      }
    }

    const downloads = add(panel, 'div', undefined, 'downloads')
    if (design.files.package.length) {
      add(downloads, 'h3', 'Downloads')
      files(downloads, design, design.files.package)
    }
    for (const revision of [...design.revisions].reverse()) {
      const heading = [`Rev ${revision.letter}`, STATUS_LABEL[revision.status].toLowerCase(), revision.date].filter(Boolean).join(' · ')
      add(downloads, 'h3', heading, 'revision')
      if (revision.holds) add(downloads, 'div', `${revision.holds} hold${revision.holds === 1 ? '' : 's'} open`, 'holds')
      files(downloads, design, revision.files)
    }

    const switcher = add(panel, 'div', undefined, 'units')
    switcher.setAttribute('role', 'group')
    switcher.setAttribute('aria-label', 'Units')
    for (const [value, label] of [['m', 'Millimeters'], ['ft', 'Inches']] as const) {
      const button = add(switcher, 'button', value === 'm' ? 'mm' : 'in')
      button.type = 'button'
      button.title = `${label} (U)`
      button.dataset.key = `units-${value}`
      button.setAttribute('aria-pressed', String(units === value))
      button.addEventListener('click', () => this.host.setUnits(value))
    }
    this.highlight()
    if (focused) panel.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus()
  }

  // The house scene the design stands in, in Room mode, framed on it: this
  // scene when it holds the object, else the project's main scene or the
  // first that does.
  private async seeInRoom(design: Design, placement: { room: string; object: string }) {
    const scene = this.host.scene()
    if (this.project() === design.project && scene?.objects.some((o) => o.id === placement.object)) {
      this.close(false)
      if (this.host.showInRoom(placement.room, placement.object)) return
    }
    const response = await fetch('./api/scenes', { cache: 'no-store' }).catch(() => undefined)
    const names = ((await response?.json().catch(() => ({})))?.scenes ?? []) as string[]
    const ours = names.filter((name) => name.startsWith(`${design.project}/`))
    ours.sort((a, b) => Number(b.endsWith('/main')) - Number(a.endsWith('/main')))
    for (const name of ours) {
      const body = await (await fetch(`./api/scene?path=${encodeURIComponent(name)}`, { cache: 'no-store' })).json().catch(() => ({}))
      if (body.scene?.objects?.some((o: { id?: string }) => o.id === placement.object)) {
        location.search = `?scene=${name}&room=${encodeURIComponent(placement.room)}&select=${encodeURIComponent(placement.object)}`
        return
      }
    }
    this.host.setStatus(`No scene of ${escapeText(design.project)} holds <code>${escapeText(placement.object)}</code> yet.`)
  }
}

// ---- Pieces ------------------------------------------------------------------

// A two-door cabinet, drawn in the text colour.
const CABINET = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="1.5" width="11" height="12" rx="1"/><path d="M8 1.5v12M6 7v2M10 7v2M4 13.5v1.5M12 13.5v1.5"/></svg>'

function add<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  parent.append(element)
  return element
}

function escapeText(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

// A file of a design, at a URL that changes when the design does, so a
// new model or picture is never an old one from the cache.
function fileUrl(design: Design, file: string): string {
  return `./designs/${design.id}/${file.split('/').map(encodeURIComponent).join('/')}${design.updated ? `?v=${encodeURIComponent(design.updated)}` : ''}`
}

function revisionText(design: Design): string {
  const revision = latestRevision(design)
  return revision ? `Rev ${revision.letter}` : 'No revision yet'
}

function statusChip(design: Design): HTMLElement {
  const chip = document.createElement('span')
  chip.className = `status ${design.status}`
  chip.textContent = STATUS_LABEL[design.status]
  return chip
}

// The gallery picture, or a drawn stand-in while there is none.
function thumbnail(design: Design): HTMLElement {
  const frame = document.createElement('span')
  frame.className = 'thumb'
  const empty = () => {
    frame.classList.add('empty')
    frame.innerHTML = '<svg viewBox="0 0 40 30" aria-hidden="true"><rect x="9" y="4" width="22" height="22" rx="1"/><path d="M9 11h22M9 18h22M20 18v8"/></svg>'
  }
  if (!design.files.thumbnail) {
    empty()
    return frame
  }
  const image = document.createElement('img')
  image.alt = ''
  image.decoding = 'async'
  image.addEventListener('error', () => {
    image.remove()
    empty()
  })
  image.src = fileUrl(design, design.files.thumbnail)
  frame.append(image)
  return frame
}

function files(parent: HTMLElement, design: Design, list: { label: string; file: string }[]) {
  const ul = add(parent, 'ul', undefined, 'files')
  for (const { label, file } of list) {
    const link = add(add(ul, 'li'), 'a', label)
    link.href = fileUrl(design, file)
    link.dataset.key = `file-${file}`
    link.setAttribute('download', '')
    add(link, 'span', file.split('.').pop()!.toUpperCase(), 'type')
  }
}

function tint(mesh: THREE.Mesh, on: boolean) {
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
    if (!(material instanceof THREE.MeshStandardMaterial)) continue
    material.userData.emissive ??= material.emissive.clone()
    material.userData.emissiveIntensity ??= material.emissiveIntensity
    if (on) {
      material.emissive.copy(ACCENT)
      material.emissiveIntensity = 0.45
    } else {
      material.emissive.copy(material.userData.emissive)
      material.emissiveIntensity = material.userData.emissiveIntensity
    }
  }
}
