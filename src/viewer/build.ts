import * as THREE from 'three'
import { alongWall, area, bounds, centroid, distanceToSegment, levelsByElevation, onGround, pointInPolygon, roomElevation, roomHeight, wallAngle, wallPieces, walls, type Point, type Wall } from '../core/geometry.ts'
import { FIXTURES, findAsset } from '../core/assets.ts'
import { DEFAULT_MATERIALS, MATERIALS, materialSpec } from '../core/materials.ts'
import { placeObjects } from '../core/objects.ts'
import type { Scene } from '../core/schema.ts'
import { RAIL_OFFSET, sliderLayout } from '../core/slider.ts'
import { floorToFloor } from '../core/walk.ts'
import { buildItem, textSprite } from './furniture.ts'
import { fitModel, hasModel, loadModel, loadModelFrom, loadPlanImage, textureSet } from './library.ts'
import { boxInMeters, planks, speckle, tiles } from './textures.ts'

// Plan coordinates [x, y] (y north) become three.js [x, -z] with y up, so
// north is -z. Everything the agent writes is in plan terms; this file is
// the only place that knows about the renderer's axes.
export const toWorld = ([x, y]: Point, height = 0) => new THREE.Vector3(x, height, -y)

const GLASS = new THREE.MeshPhysicalMaterial({ color: '#cfe3ee', roughness: 0.05, metalness: 0, transparent: true, opacity: 0.28 })
const FRAME = new THREE.MeshStandardMaterial({ color: '#f4f2ec', roughness: 0.5 })
const DOOR = new THREE.MeshStandardMaterial({ color: '#b08a62', roughness: 0.6 })
const TRIM = new THREE.MeshStandardMaterial({ color: '#f3f1ec', roughness: 0.45 })
const FIXTURE = new THREE.MeshStandardMaterial({ color: '#fffaf0', emissive: '#fff1d6', emissiveIntensity: 2.2, roughness: 0.4 })

// A photographed texture set, when downloaded. Every surface carries UVs
// in meters, so it lands at the size Poly Haven measured.
// The scene's own materials, set before each build; name lookups try
// them first.
let custom: Scene['materials'] = []
export function useCustomMaterials(materials: Scene['materials']): void {
  const changed = JSON.stringify(materials) !== JSON.stringify(custom)
  custom = materials
  if (changed) {
    materialCache.clear()
    floorCache.clear()
  }
}
const spec = (name: string | undefined) => materialSpec(name, custom)

function photographed(spec: (typeof MATERIALS)[string]): THREE.MeshStandardMaterial | undefined {
  const set = textureSet(spec.texture, spec.size)
  if (!set) return undefined
  return new THREE.MeshStandardMaterial({
    // Paint keeps its own color: only the plaster's relief and sheen show
    // through, the way paint on a real wall looks.
    color: spec.tint ? spec.color : (spec.shade ?? '#ffffff'),
    map: spec.tint ? null : set.color,
    normalMap: set.normal,
    // Poly Haven's "arm" packs ambient occlusion, roughness, and metalness
    // in red, green, and blue: the channels three.js reads for each.
    aoMap: set.arm,
    aoMapIntensity: spec.tint ? 0.4 : 0.8,
    roughnessMap: set.arm,
    roughness: 1,
    metalness: 0,
  })
}

const materialCache = new Map<string, THREE.MeshStandardMaterial>()
export function material(name: string | undefined, fallback: string): THREE.MeshStandardMaterial {
  const key = name && spec(name) ? name : fallback
  let m = materialCache.get(key)
  if (!m) {
    const s = spec(key) ?? MATERIALS[fallback]
    m = photographed(s) ?? new THREE.MeshStandardMaterial({ color: s.color, roughness: s.roughness, metalness: s.metalness ?? 0 })
    materialCache.set(key, m)
  }
  return m
}

// Floors: the photographed set, or a pattern drawn at its real size. Seen
// from both sides, so a terrace over an open porch has an underside.
const floorCache = new Map<string, THREE.MeshStandardMaterial>()
export function floorMaterial(name: string | undefined, fallback = DEFAULT_MATERIALS.floor): THREE.MeshStandardMaterial {
  const key = name && spec(name) ? name : fallback
  let m = floorCache.get(key)
  if (m) return m
  const chosen = materialSpec(key, custom) ?? MATERIALS[fallback]
  m = photographed(chosen)
  if (!m) {
    m = new THREE.MeshStandardMaterial({ roughness: chosen.roughness, metalness: chosen.metalness ?? 0 })
    if (chosen.pattern === 'planks') m.map = planks(chosen.color)
    else if (chosen.pattern === 'tiles') m.map = tiles(chosen.color, chosen.tile ?? 0.6)
    else if (chosen.pattern === 'speckle') m.map = speckle(chosen.color, 1)
    else m.color.set(chosen.color)
  }
  m.side = THREE.DoubleSide
  floorCache.set(key, m)
  return m
}

function lit(material: THREE.Material): THREE.Material {
  const glowing = material.clone() as THREE.MeshStandardMaterial
  glowing.emissive = new THREE.Color('#fff1d8')
  glowing.emissiveIntensity = 1.6
  return glowing
}

// Built scenes are cached by material name, so a rebuild after an edit
// reuses textures already on the GPU; a new library means new materials.
export function resetMaterials() {
  materialCache.clear()
  floorCache.clear()
}

export interface Built {
  root: THREE.Group
  // Every entity's objects by id, for highlighting and focusing.
  entities: Map<string, THREE.Object3D>
  labels: THREE.Group
  // Gable roofs, shown while walking and from cameras, never from above.
  roofs: THREE.Object3D[]
  // Ceilings and their lights: shown at eye level, hidden in the overviews
  // so a person can see into every room from above.
  indoor: THREE.Object3D[]
  // The drawing under each level's plan view, by level id.
  overlays: Map<string, THREE.Object3D>
  // Every ceiling light's place and strength. The viewer lights the few
  // nearest the camera from a small pool, so the shaders stay small.
  fixtures: { position: THREE.Vector3; intensity: number; level: number }[]
  sun?: THREE.DirectionalLight
}

export interface BuildOptions {
  // Turns a file named in the scene (a plan image) into a URL.
  fileUrl?: (relative: string) => string
}

// Lays a floor polygon's UVs in meters.
function floorShape(floor: Point[]): THREE.Shape {
  return new THREE.Shape(floor.map(([x, y]) => new THREE.Vector2(x, y)))
}

export function buildScene(scene: Scene, options: BuildOptions = {}): Built {
  useCustomMaterials(scene.materials)
  const root = new THREE.Group()
  const labels = new THREE.Group()
  const entities = new Map<string, THREE.Object3D>()
  const indoor: THREE.Object3D[] = []
  const overlays = new Map<string, THREE.Object3D>()
  const fixtures: Built['fixtures'] = []
  const roofs: THREE.Object3D[] = []
  root.add(labels)
  const levels = levelsByElevation(scene)
  const levelIndex = (id: string) => Math.max(0, levels.findIndex((l) => l.id === id))
  const lowest = levels[0]?.id

  for (const room of scene.rooms) {
    const group = new THREE.Group()
    group.name = room.id
    group.userData.level = levelIndex(room.level)
    const elevation = roomElevation(scene, room)
    const level = levels.find((l) => l.id === room.level)
    const shape = floorShape(room.floor)
    if (!room.well) {
      // A floor that stands on the ground above it is solid down to it: a
      // porch a few steps up, a raised wing.
      const slab = elevation <= 0.05 ? 0 : onGround(scene, room) ? elevation : room.level === lowest ? 0 : (level?.slab ?? 0)
      const finish = floorMaterial(room.materials?.floor, room.open ? DEFAULT_MATERIALS.ground : DEFAULT_MATERIALS.floor)
      if (slab > 0) {
        // Upper floors are slabs: a terrace over a porch has an underside
        // and an edge, plastered like a ceiling.
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: slab, bevelEnabled: false })
        const underside = material(DEFAULT_MATERIALS.ceiling, DEFAULT_MATERIALS.ceiling)
        const floor = new THREE.Mesh(geometry, [finish, underside])
        // ExtrudeGeometry: group 0 is the caps, 1 the sides. Both caps get
        // the finish; the top is what shows.
        floor.rotation.x = -Math.PI / 2
        floor.position.y = elevation - slab
        floor.castShadow = true
        floor.receiveShadow = true
        group.add(floor)
      } else {
        const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), finish)
        // The shape is drawn in plan x/y; lay it down so plan y becomes -z.
        floor.rotation.x = -Math.PI / 2
        floor.position.y = elevation
        floor.receiveShadow = true
        group.add(floor)
      }
    }
    root.add(group)
    entities.set(room.id, group)

    const height = roomHeight(scene, room)
    if (!room.open && room.ceiling) {
      // A thin ceiling just under the slab above, so the room's own paint
      // shows from inside and the slab's underside from an open porch.
      const ceiling = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.01, bevelEnabled: false }), material(room.materials?.ceiling, DEFAULT_MATERIALS.ceiling))
      ceiling.rotation.x = -Math.PI / 2
      ceiling.position.y = elevation + height - 0.012
      ceiling.castShadow = true
      ceiling.receiveShadow = true
      group.add(ceiling)
      indoor.push(ceiling)

      // Ceiling lights: one, or a grid of them in a big room.
      for (const [lx, ly] of lightSpots(room.floor)) {
        const fixture = new THREE.Group()
        fixture.position.copy(toWorld([lx, ly], elevation))
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 32), FIXTURE)
        disc.position.y = height - 0.03
        fixture.add(disc)
        group.add(fixture)
        indoor.push(fixture)
        // A globe pendant once downloaded, its glass at 2.15 m so nobody
        // walks into it; any cord longer than that disappears into the ceiling.
        const globeBottom = Math.min(2.15, height - 0.45)
        if (hasModel(FIXTURES.ceilingLamp)) {
          loadModel(FIXTURES.ceilingLamp).then((model) => {
            if (!model) return
            fixture.remove(disc)
            const pendant = fitModel(model, [0.43, 0.43, 0.95], 0)
            pendant.position.y = globeBottom
            // The globe glows: it is the light. Its material is cloned, so
            // the glow stays on lit fixtures and off the shared model.
            pendant.traverse((object) => {
              if (!(object instanceof THREE.Mesh)) return
              object.castShadow = false
              const glows = (m: THREE.Material) => /glass|globe/i.test(m.name)
              object.material = Array.isArray(object.material)
                ? object.material.map((m) => (glows(m) ? lit(m) : m))
                : glows(object.material) ? lit(object.material) : object.material
            })
            fixture.add(pendant)
          })
        }
        const share = area(room.floor) / lightSpots(room.floor).length
        fixtures.push({
          position: toWorld([lx, ly], elevation + (hasModel(FIXTURES.ceilingLamp) ? globeBottom + 0.2 : height - 0.35)),
          intensity: 5 * Math.sqrt(Math.max(4, share)),
          level: group.userData.level as number,
        })
      }
    }

    const [cx, cy] = centroid(room.floor)
    const extent = bounds(room.floor)
    const label = textSprite(`${room.name ?? room.id}  ${(extent.max[0] - extent.min[0]).toFixed(1)} × ${(extent.max[1] - extent.min[1]).toFixed(1)} m`, 0.05, 0.42)
    label.position.copy(toWorld([cx, cy], elevation + 0.05))
    label.userData.room = room.id
    label.userData.level = group.userData.level
    labels.add(label)
  }

  // A gable roof over a level's closed rooms: a triangular profile
  // extruded along the ridge, tiles on the slopes, the house's skin on the
  // gable ends. Shown only from outside and while walking, like openings.
  for (const level of levels) {
    if (level.roof?.kind !== 'gable') continue
    const covered = scene.rooms.filter((r) => r.level === level.id && !r.open && !r.well)
    if (covered.length === 0) continue
    const box = bounds(covered.flatMap((r) => r.floor))
    const over = level.roof.overhang
    const minX = box.min[0] - over
    const maxX = box.max[0] + over
    const minY = box.min[1] - over
    const maxY = box.max[1] + over
    const alongX = maxX - minX >= maxY - minY
    const span = alongX ? maxY - minY : maxX - minX
    const length = alongX ? maxX - minX : maxY - minY
    const rise = (span / 2) * Math.tan((level.roof.pitch * Math.PI) / 180)
    const profile = new THREE.Shape([new THREE.Vector2(-span / 2, 0), new THREE.Vector2(span / 2, 0), new THREE.Vector2(0, rise)])
    const geometry = new THREE.ExtrudeGeometry(profile, { depth: length, bevelEnabled: false })
    const roof = new THREE.Mesh(geometry, [material(DEFAULT_MATERIALS.exterior, DEFAULT_MATERIALS.exterior), floorMaterial('roof-tile', 'roof-tile')])
    // The profile stands in x/y and extrudes along +z; turn that along the
    // ridge, eaves at the top of the walls.
    const eaves = level.elevation + level.height + 0.02
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    if (alongX) {
      roof.rotation.y = Math.PI / 2
      roof.position.copy(toWorld([minX, cy], eaves))
    } else {
      roof.position.copy(toWorld([cx, maxY], eaves))
    }
    roof.castShadow = true
    roof.receiveShadow = true
    roof.userData.roof = true
    roof.userData.level = levelIndex(level.id)
    roofs.push(roof)
    const home = entities.get(covered[0].id)
    if (home) home.add(roof)
  }

  // The drawing under each level, for the plan view.
  for (const level of levels) {
    if (!level.plan || !options.fileUrl) continue
    const plan = level.plan
    const texture = loadPlanImage(options.fileUrl(plan.image), (loaded) => {
      const w = loaded.image.width / plan.scale
      const h = loaded.image.height / plan.scale
      mesh.geometry.dispose()
      mesh.geometry = new THREE.PlaneGeometry(w, h)
      // The image's top-left pixel lands at plan [-ox, +oy] over its scale.
      mesh.position.copy(toWorld([-plan.origin[0] / plan.scale + w / 2, plan.origin[1] / plan.scale - h / 2], level.elevation + 0.03))
    })
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 8
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: plan.opacity, depthWrite: false }))
    mesh.rotation.x = -Math.PI / 2
    mesh.renderOrder = 2
    mesh.visible = false
    mesh.userData.level = levelIndex(level.id)
    root.add(mesh)
    overlays.set(level.id, mesh)
  }

  const roomsById = new Map(scene.rooms.map((r) => [r.id, r]))
  for (const wall of walls(scene)) {
    const group = buildWall(wall, roomsById, (id) => roomElevation(scene, roomsById.get(id)!))
    const level = levels.filter((l) => l.elevation <= wall.elevation + 0.02).at(-1) ?? levels[0]
    group.userData.level = levelIndex(level.id)
    root.add(group)
    for (const hole of wall.openings) {
      const opening = buildOpening(wall, hole)
      if (opening) group.add(opening)
      entities.set(hole.opening.id, opening ?? group)
    }
  }

  for (const item of scene.items) {
    const room = roomsById.get(item.room)
    const info = findAsset(item.asset)
    const rise = info?.category === 'stairs' ? (item.size?.[2] ?? (room ? floorToFloor(scene, room.level) : info.size[2])) : undefined
    const group = buildItem(item.asset, item.id, item.size, { rise })
    group.name = item.id
    group.userData.level = room ? levelIndex(room.level) : 0
    group.scale.setScalar(item.scale)
    group.position.copy(toWorld(item.at, (room ? roomElevation(scene, room) : 0) + item.elevation))
    // Facing is clockwise from north; three.js rotates counterclockwise.
    group.rotation.y = -THREE.MathUtils.degToRad(item.facing)
    root.add(group)
    entities.set(item.id, group)
  }

  buildObjects(scene, root, entities, levels.map((l) => l.elevation), options)

  let sun: THREE.DirectionalLight | undefined
  const lights = scene.lights.length > 0 ? scene.lights : [{ id: 'default-sun', type: 'sun' as const, azimuth: 220, elevation: 35, intensity: 1 }]
  for (const light of lights) {
    if (light.type === 'sun') {
      sun = new THREE.DirectionalLight(light.color ?? '#fff4e0', 2.6 * light.intensity)
      const azimuth = THREE.MathUtils.degToRad(light.azimuth)
      const elevation = THREE.MathUtils.degToRad(light.elevation)
      // Azimuth is the compass direction the sun is in, clockwise from north.
      sun.position.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation)).multiplyScalar(60)
      sun.castShadow = true
      sun.shadow.mapSize.set(2048, 2048)
      sun.shadow.bias = -0.0004
      sun.shadow.normalBias = 0.03
      root.add(sun)
      root.add(sun.target)
      entities.set(light.id, sun)
    } else {
      const point = new THREE.PointLight(light.color ?? '#ffe2b8', 6 * light.intensity, 8, 1.6)
      const [x, y, z] = light.at ?? [0, 0, 2.4]
      point.position.copy(toWorld([x, y], z))
      point.castShadow = true
      root.add(point)
      entities.set(light.id, point)
    }
  }

  return { root, entities, labels, roofs, indoor, overlays, fixtures, sun }
}

// Free objects: each kind as a mesh anchored at its bottom center, in a
// group that carries the object's own turn and scale, inside its parent's
// group when it has one, so the world placement matches core/objects.ts.
function buildObjects(scene: Scene, root: THREE.Group, entities: Map<string, THREE.Object3D>, elevations: number[], options: BuildOptions): void {
  const groups = new Map<string, THREE.Group>()
  const placed = new Map(placeObjects(scene).map((p) => [p.object.id, p]))
  for (const object of scene.objects) {
    const group = new THREE.Group()
    group.name = object.id
    groups.set(object.id, group)
    entities.set(object.id, group)
    const world = placed.get(object.id)
    const z = world?.position[2] ?? object.at[2]
    group.userData.level = Math.max(0, elevations.filter((e) => e <= z + 0.02).length - 1)
    group.userData.object = true

    const room = object.room ? scene.rooms.find((r) => r.id === object.room) : undefined
    const lift = room && !object.parent ? roomElevation(scene, room) : 0
    group.position.copy(toWorld([object.at[0], object.at[1]], object.at[2] + lift))
    // Facing clockwise from north, then the front up, then the right side
    // down: Y, then X, then Z in three.js's frame, with the signs flipped
    // where its axes run the other way.
    group.rotation.set(THREE.MathUtils.degToRad(object.pitch), -THREE.MathUtils.degToRad(object.facing), -THREE.MathUtils.degToRad(object.roll), 'YXZ')
    const scale = typeof object.scale === 'number' ? [object.scale, object.scale, object.scale] : object.scale
    group.scale.set(scale[0], scale[2], scale[1])

    const surface = objectMaterial(object)
    const shaded = (mesh: THREE.Mesh) => {
      mesh.castShadow = object.kind !== 'plane'
      mesh.receiveShadow = true
      group.add(mesh)
    }
    switch (object.kind) {
      case 'box': {
        const [w, d, h] = object.size
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), surface)
        mesh.position.y = h / 2
        shaded(mesh)
        break
      }
      case 'sphere': {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(object.radius, 48, 32), surface)
        mesh.position.y = object.radius
        shaded(mesh)
        break
      }
      case 'cylinder': {
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(object.top ?? object.radius, object.radius, object.height, 48), surface)
        mesh.position.y = object.height / 2
        shaded(mesh)
        break
      }
      case 'plane': {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(object.size[0], object.size[1]), surface)
        mesh.rotation.x = -Math.PI / 2
        mesh.position.y = 0.002
        surface.side = THREE.DoubleSide
        shaded(mesh)
        break
      }
      case 'extrude': {
        const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(floorShape(object.polygon), { depth: object.height, bevelEnabled: false }), surface)
        mesh.rotation.x = -Math.PI / 2
        shaded(mesh)
        break
      }
      case 'asset': {
        const info = findAsset(object.asset)
        const piece = buildItem(object.asset, object.id, object.size ?? info?.size)
        // Library fronts face south at facing 0, like items.
        group.add(piece)
        break
      }
      case 'model': {
        const size = object.size ?? [1, 1, 1]
        const stand = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[2], size[1]), new THREE.MeshStandardMaterial({ color: '#b9b4aa', roughness: 0.8, transparent: true, opacity: 0.4 }))
        stand.position.y = size[2] / 2
        group.add(stand)
        const url = /^https?:\/\//.test(object.file) ? object.file : options.fileUrl?.(object.file)
        if (url) {
          loadModelFrom(url).then((model) => {
            if (!model) return
            group.remove(stand)
            group.add(object.size ? fitModel(model, object.size, 0) : standModel(model))
          })
        }
        break
      }
      case 'group':
        break
    }

    if (object.label) {
      const top = world ? world.box.max[2] - world.position[2] : 0
      const sprite = textSprite(object.label, 0, 0.11)
      sprite.position.y = Math.max(0.1, top / Math.max(1e-6, scale[2]) + 0.12)
      sprite.scale.multiplyScalar(1 / Math.max(scale[0], scale[1], scale[2]))
      sprite.userData.objectLabel = true
      group.add(sprite)
    }
  }
  for (const object of scene.objects) {
    const group = groups.get(object.id)!
    const parent = object.parent ? groups.get(object.parent) : undefined
    // A parent that is missing or looped (check says so) leaves the
    // object standing in the world.
    if (parent && !hasAncestor(groups, object.id)) parent.add(group)
    else root.add(group)
  }
  function hasAncestor(all: Map<string, THREE.Group>, id: string): boolean {
    const seen = new Set<string>()
    let at: string | undefined = scene.objects.find((o) => o.id === id)?.parent
    while (at && all.has(at)) {
      if (seen.has(at) || at === id) return true
      seen.add(at)
      at = scene.objects.find((o) => o.id === at)?.parent
    }
    return false
  }
}

// A named material, a plain color, or the default grey; opacity, glow and
// the roughness overrides on top of either.
function objectMaterial(object: Scene['objects'][number]): THREE.MeshStandardMaterial {
  const base = object.material ? material(object.material, DEFAULT_MATERIALS.exterior).clone() : new THREE.MeshStandardMaterial({ color: object.color ?? '#b9b4aa', roughness: 0.6, metalness: 0 })
  if (object.material && object.color) base.color.set(object.color)
  if (object.roughness !== undefined) base.roughness = object.roughness
  if (object.metalness !== undefined) base.metalness = object.metalness
  if (object.opacity !== undefined && object.opacity < 1) {
    base.transparent = true
    base.opacity = object.opacity
  }
  if (object.glow) {
    base.emissive = new THREE.Color(object.glow)
    base.emissiveIntensity = 1.4
  }
  return base
}

// A model at its own scale, centered on the anchor and standing on it.
function standModel(model: THREE.Object3D): THREE.Group {
  const holder = new THREE.Group()
  const instance = model.clone(true)
  holder.add(instance)
  holder.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(holder)
  const center = box.getCenter(new THREE.Vector3())
  instance.position.set(-center.x, -box.min.y, -center.z)
  return holder
}

// Where a room's ceiling lights go: its center, or a grid about 4.5 m
// apart in a big room, keeping only spots inside the floor.
function lightSpots(floor: Point[]): Point[] {
  const b = bounds(floor)
  const w = b.max[0] - b.min[0]
  const d = b.max[1] - b.min[1]
  const cols = Math.max(1, Math.round(w / 4.5))
  const rows = Math.max(1, Math.round(d / 4.5))
  if (cols === 1 && rows === 1) return [centroid(floor)]
  const spots: Point[] = []
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const p: Point = [b.min[0] + ((i + 0.5) * w) / cols, b.min[1] + ((j + 0.5) * d) / rows]
      if (pointInPolygon(p, floor)) spots.push(p)
    }
  }
  return spots.length > 0 ? spots : [centroid(floor)]
}

// One box per solid piece, with a material per face: the room's wall paint
// on each room side and the exterior finish outside.
function buildWall(wall: Wall, rooms: Map<string, Scene['rooms'][number]>, floorOf: (id: string) => number): THREE.Group {
  const group = new THREE.Group()
  group.name = wall.id
  const angle = wallAngle(wall)
  const exterior = material(DEFAULT_MATERIALS.exterior, DEFAULT_MATERIALS.exterior)
  // Which room is on the left (+normal) side of the wall, looking from a to b.
  const normal: Point = [-(wall.b[1] - wall.a[1]) / wall.length, (wall.b[0] - wall.a[0]) / wall.length]
  const mid = alongWall(wall, wall.length / 2)
  let leftRoom: string | undefined
  let rightRoom: string | undefined
  for (const id of wall.rooms) {
    const room = rooms.get(id)
    if (!room) continue
    const [cx, cy] = centroid(room.floor)
    const side = (cx - mid[0]) * normal[0] + (cy - mid[1]) * normal[1]
    if (side > 0) leftRoom = id
    else rightRoom = id
  }
  const paint = (id: string | undefined) => {
    const room = id ? rooms.get(id) : undefined
    return room && !room.open ? material(room.materials?.walls, DEFAULT_MATERIALS.walls) : exterior
  }
  const left = paint(leftRoom)
  const right = paint(rightRoom)
  // For the dollhouse cutaway: the side with no closed room is outside.
  const closedLeft = leftRoom && !rooms.get(leftRoom)?.open
  const closedRight = rightRoom && !rooms.get(rightRoom)?.open
  const outward: Point | undefined = closedLeft && closedRight ? undefined : closedLeft ? [-normal[0], -normal[1]] : [normal[0], normal[1]]
  group.userData.wall = { a: wall.a, b: wall.b, half: wall.thickness / 2, base: wall.elevation, height: wall.height, outward: wall.exterior || !closedLeft || !closedRight ? outward : undefined } satisfies WallInfo

  for (const piece of wallPieces(wall)) {
    // Pieces at either end of the wall reach half a thickness past it, so
    // corners close without gaps.
    const extendStart = piece.from <= 1e-6 ? wall.thickness / 2 : 0
    const extendEnd = piece.to >= wall.length - 1e-6 ? wall.thickness / 2 : 0
    const length = piece.to - piece.from + extendStart + extendEnd
    const height = piece.top - piece.bottom
    if (length <= 1e-4 || height <= 1e-4) continue
    // Local box axes: x along the wall, y up, z across it. In world space
    // local +z points to the plan's right side of a -> b.
    const faces = [exterior, exterior, exterior, exterior, right, left]
    const mesh = new THREE.Mesh(boxInMeters(length, height, wall.thickness), faces)
    const center = alongWall(wall, (piece.from - extendStart + piece.to + extendEnd) / 2)
    mesh.position.copy(toWorld(center, wall.elevation + piece.bottom + height / 2))
    mesh.rotation.y = angle
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.cutaway = { bottom: piece.bottom, top: piece.top, base: wall.elevation }
    group.add(mesh)

    if (piece.bottom === 0 && piece.to - piece.from > 0.02 && wall.height > 1.5) {
      // Baseboards, 8 cm, on each side that has a room. Local +z is the
      // plan's right side of a -> b.
      const across = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle))
      const middle = alongWall(wall, (piece.from + piece.to) / 2)
      for (const [room, sign] of [[rightRoom, 1], [leftRoom, -1]] as const) {
        if (!room || rooms.get(room)?.open) continue
        const floor = Math.max(wall.elevation, floorOf(room))
        const board = new THREE.Mesh(new THREE.BoxGeometry(piece.to - piece.from, 0.08, 0.014), TRIM)
        board.position.copy(toWorld(middle, floor + 0.04)).addScaledVector(across, sign * (wall.thickness / 2 + 0.007))
        board.rotation.y = angle
        board.receiveShadow = true
        group.add(board)
      }
    }
  }
  return group
}

// The height exterior walls drop to when they face the camera from outside.
export const CUTAWAY_HEIGHT = 0.9

interface WallInfo {
  a: Point
  b: Point
  half: number
  base: number
  height: number
  outward?: Point
}

// Gets walls out of the camera's way, by where the camera is rather than
// which view is chosen:
// - a camera inside a wall, or touching it, hides that wall, so nothing is
//   ever seen sliced open;
// - from outside, an exterior wall facing the camera within 1.5 m is
//   hidden, so you look straight into the room;
// - from farther outside, walls facing the camera drop to waist height,
//   the way a dollhouse opens, and the rest of the house stays standing.
// Openings and trim go with their wall. Walking never triggers the first
// two: a person keeps 20 cm from every wall face. The dollhouse rules run
// only in the overview; a camera the scene places outside sees the whole
// facade. Walls on levels above `cap` stay hidden.
export function applyCutaway(root: THREE.Object3D, camera: THREE.Camera, outside: boolean, touching: boolean, dollhouse: boolean, cap = Infinity) {
  const eye: Point = [camera.position.x, -camera.position.z]
  for (const group of root.children) {
    const w = group.userData.wall as WallInfo | undefined
    if (!w) continue
    if ((group.userData.level ?? 0) > cap) {
      group.visible = false
      continue
    }
    let mode: 'full' | 'cut' | 'hidden' = 'full'
    if (touching || dollhouse) {
      const level = camera.position.y > w.base - 0.3 && camera.position.y < w.base + w.height + 0.3
      const gap = distanceToSegment(eye, w.a, w.b) - w.half
      if (touching && gap < 0.15 && level) mode = 'hidden'
      else if (dollhouse && outside && w.outward) {
        const mid = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2]
        const dx = eye[0] - mid[0]
        const dy = eye[1] - mid[1]
        const facing = (w.outward[0] * dx + w.outward[1] * dy) / (Math.hypot(dx, dy) || 1) > 0.15
        // Only walls near the camera's own height open up: looking down
        // on a house from above, the whole facade stands.
        const near = camera.position.y < w.base + w.height + 2.5
        if (facing && near) mode = gap < 1.5 && level ? 'hidden' : 'cut'
      }
    }
    group.visible = mode !== 'hidden'
    if (mode === 'hidden') continue
    for (const child of group.children) {
      const cut = child.userData.cutaway as { bottom: number; top: number; base: number } | undefined
      if (child.userData.opening || child.userData.roof) {
        child.visible = mode === 'full'
        continue
      }
      if (!cut) continue
      const top = mode === 'cut' ? Math.min(cut.top, CUTAWAY_HEIGHT) : cut.top
      const height = top - cut.bottom
      child.visible = height > 0.01
      if (!child.visible) continue
      child.scale.y = height / (cut.top - cut.bottom)
      child.position.y = cut.base + cut.bottom + height / 2
    }
  }
}

function buildOpening(wall: Wall, hole: Wall['openings'][number]): THREE.Object3D | undefined {
  const { opening } = hole
  const group = new THREE.Group()
  group.name = opening.id
  group.userData.opening = true
  const width = hole.to - hole.from
  const height = hole.top - hole.bottom
  const center = alongWall(wall, (hole.from + hole.to) / 2)
  group.position.copy(toWorld(center, wall.elevation + hole.bottom))
  group.rotation.y = wallAngle(wall)

  if (opening.type === 'window') {
    const frame = 0.05
    const glass = new THREE.Mesh(new THREE.BoxGeometry(width - frame, height - frame, 0.01), GLASS)
    glass.position.y = height / 2
    group.add(glass)
    const bar = (w: number, h: number, x: number, y: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.06), FRAME)
      mesh.position.set(x, y, 0)
      mesh.castShadow = true
      group.add(mesh)
    }
    bar(width, frame, 0, frame / 2)
    bar(width, frame, 0, height - frame / 2)
    bar(frame, height, -width / 2 + frame / 2, height / 2)
    bar(frame, height, width / 2 - frame / 2, height / 2)
    // Mullions every meter or so, so a wide window reads as panes.
    const panes = Math.max(1, Math.round(width / 0.9))
    for (let i = 1; i < panes; i++) bar(0.03, height, -width / 2 + (i * width) / panes, height / 2)
    const sill = new THREE.Mesh(new THREE.BoxGeometry(width + 0.08, 0.03, wall.thickness + 0.06), TRIM)
    sill.position.y = -0.015
    sill.receiveShadow = true
    group.add(sill)
    return group
  }

  if (opening.type === 'door') {
    // Hinged on one side and standing open, so a walk-through can pass.
    const hingeLeft = opening.swing?.endsWith('left') ?? true
    const inward = opening.swing?.startsWith('in') ?? true
    const hinge = new THREE.Group()
    hinge.position.x = hingeLeft ? -width / 2 : width / 2
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(width - 0.02, height - 0.01, 0.04), DOOR)
    leaf.position.set(hingeLeft ? width / 2 : -width / 2, height / 2, 0)
    leaf.castShadow = true
    hinge.add(leaf)
    const sign = (hingeLeft ? 1 : -1) * (inward ? 1 : -1)
    hinge.rotation.y = sign * THREE.MathUtils.degToRad(70)
    group.add(hinge)
    // A 7 cm casing on both faces, standing 1.5 cm proud of the wall.
    const depth = wall.thickness + 0.03
    const jamb = (x: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.07, height + 0.07, depth), TRIM)
      mesh.position.set(x, (height + 0.07) / 2, 0)
      mesh.castShadow = true
      group.add(mesh)
    }
    jamb(-width / 2 - 0.035)
    jamb(width / 2 + 0.035)
    const head = new THREE.Mesh(new THREE.BoxGeometry(width + 0.14, 0.07, depth), TRIM)
    head.position.set(0, height + 0.035, 0)
    group.add(head)
    return group
  }

  if (opening.type === 'slider') {
    // Glass panels on two rails, the middle ones slid open; a fixed transom
    // above tall ones, with its mullions on the panel lines.
    const { panels, panelTop } = sliderLayout(width, height)
    const frame = 0.045
    const depth = wall.thickness + 0.03
    const bar = (w: number, h: number, d: number, x: number, y: number, z: number, material = FRAME) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
      mesh.position.set(x, y, z)
      mesh.castShadow = true
      group.add(mesh)
    }
    // Threshold track, head, and jambs.
    bar(width, 0.02, depth, 0, 0.01, 0, TRIM)
    bar(width + 0.12, 0.06, depth, 0, panelTop + 0.03, 0, TRIM)
    bar(0.06, height + 0.06, depth, -width / 2 - 0.03, (height + 0.06) / 2, 0, TRIM)
    bar(0.06, height + 0.06, depth, width / 2 + 0.03, (height + 0.06) / 2, 0, TRIM)
    for (const panel of panels) {
      const w = panel.to - panel.from
      const x = -width / 2 + panel.at + w / 2
      const z = (panel.rail === 0 ? -1 : 1) * RAIL_OFFSET
      const glass = new THREE.Mesh(new THREE.BoxGeometry(w - frame, panelTop - 0.02 - frame, 0.01), GLASS)
      glass.position.set(x, 0.02 + (panelTop - 0.02) / 2, z)
      group.add(glass)
      bar(w, frame, 0.04, x, 0.02 + frame / 2, z)
      bar(w, frame, 0.04, x, panelTop - frame / 2, z)
      bar(frame, panelTop - 0.02, 0.04, x - w / 2 + frame / 2, 0.02 + (panelTop - 0.02) / 2, z)
      bar(frame, panelTop - 0.02, 0.04, x + w / 2 - frame / 2, 0.02 + (panelTop - 0.02) / 2, z)
    }
    const transom = height - panelTop - 0.06
    if (transom > 0.1) {
      const base = panelTop + 0.06
      const glass = new THREE.Mesh(new THREE.BoxGeometry(width - frame, transom - frame, 0.01), GLASS)
      glass.position.set(0, base + transom / 2, 0)
      group.add(glass)
      bar(width, frame, 0.06, 0, base + transom - frame / 2, 0)
      for (const panel of panels.slice(1)) bar(0.04, transom, 0.06, -width / 2 + panel.from, base + transom / 2, 0)
    }
    return group
  }

  return group
}
