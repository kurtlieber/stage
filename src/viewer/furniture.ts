import * as THREE from 'three'
import { findAsset } from '../core/assets.ts'
import { MATERIALS } from '../core/materials.ts'
import { fitModel, hasModel, loadModel, textureSet } from './library.ts'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { boxInMeters, contactShadow, cylinderInMeters, projectInMeters } from './textures.ts'
import { stair as stairGeometry } from '../core/stairs.ts'

// Furniture built from primitives, by asset id. Each builder returns a group
// with its footprint centered on the origin, the floor at y = 0, and the
// front of the piece toward -z (north in plan), which is facing 0.
// Pieces with a CC0 model use it once downloaded; these stand in until
// then, and remain for pieces no CC0 model covers, in photographed
// wood, linen, and wool where the library has them.

export interface BuildItemOptions {
  // For stairs: how far they climb.
  rise?: number
}

type Builder = (size: [number, number, number], options: BuildItemOptions) => THREE.Group

const mat = (color: string, roughness = 0.8, metalness = 0) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness })

let FABRIC = mat('#6f7f8f', 0.95)
let FABRIC_WARM = mat('#a8836a', 0.95)
let WOOD = mat('#a07850', 0.6)
let WOOD_DARK = mat('#5a3d2b', 0.55)
const WHITE = mat('#f2f0ea', 0.4)
const METAL = mat('#8a8d91', 0.35, 0.8)
const BLACK = mat('#1c1d20', 0.3)
let LINEN = mat('#e8e2d6', 0.95)
let DUVET = mat('#7d8fa3', 0.95)
let RUG_FIELD = mat('#e3d2b8', 1)
let RUG_BORDER = mat('#9b5d4a', 1)
const LEAF = mat('#3e6b3a', 0.85)
const POT = mat('#c4a484', 0.8)
let SHADE = new THREE.MeshStandardMaterial({ color: '#f4ead2', roughness: 0.9, side: THREE.DoubleSide, emissive: '#ffdcaa', emissiveIntensity: 0.9 })
let PILLOW = mat('#f4f1ea', 0.95)
let HEADBOARD = mat('#8a8278', 0.95)
// Metals and glass look right only with something to reflect, which the
// photographed sky now gives them.
const STEEL = mat('#c8cbcf', 0.28, 0.9)
const BRASS = mat('#b08a4a', 0.3, 0.9)
const MATTE_BLACK = mat('#1b1c1f', 0.6)
const SCREEN = new THREE.MeshPhysicalMaterial({ color: '#06070a', roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.04 })
const WORKTOP = new THREE.MeshPhysicalMaterial({ color: '#2c2e33', roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.2 })
const OVEN_GLASS = new THREE.MeshPhysicalMaterial({ color: '#0d0e10', roughness: 0.08, clearcoat: 1 })
const FRONTS = mat('#efece5', 0.45)

// A photographed surface from the library, tinted, or the plain material
// when that texture set isn't downloaded.
function surface(name: string, fallback: THREE.MeshStandardMaterial, tint = '#ffffff'): THREE.MeshStandardMaterial {
  const set = textureSet(MATERIALS[name]?.texture)
  if (!set) return fallback
  return new THREE.MeshStandardMaterial({ color: MATERIALS[name]?.shade ?? tint, map: set.color, normalMap: set.normal, roughnessMap: set.arm, aoMap: set.arm, roughness: 1, metalness: 0 })
}

// Called once the library has loaded, before the first build.
export function useSurfaces() {
  WOOD = surface('oak-veneer', WOOD)
  WOOD_DARK = surface('walnut-veneer', WOOD_DARK, '#8a6a52')
  LINEN = surface('linen', LINEN, '#f4f0e8')
  DUVET = surface('linen', DUVET, '#8797aa')
  FABRIC = surface('wool-herringbone', FABRIC, '#7d8b99')
  FABRIC_WARM = surface('wool-herringbone', FABRIC_WARM, '#b08c70')
  RUG_FIELD = surface('wool-herringbone', RUG_FIELD, '#ece2d0')
  RUG_BORDER = surface('wool-herringbone', RUG_BORDER, '#9b5d4a')
  PILLOW = surface('linen', PILLOW, '#fbf8f2')
  HEADBOARD = surface('wool-herringbone', HEADBOARD, '#8f877c')
  const shade = surface('linen', SHADE, '#f6ecd8')
  if (shade !== SHADE) {
    shade.side = THREE.DoubleSide
    shade.emissive = new THREE.Color('#ffdcaa')
    shade.emissiveIntensity = 0.9
    SHADE = shade
  }
}

// A box with softened edges, for anything upholstered or stuffed.
function soft(group: THREE.Group, material: THREE.Material, w: number, h: number, d: number, radius: number, x = 0, y = 0, z = 0) {
  const r = Math.min(radius, w / 2, h / 2, d / 2) * 0.999
  const mesh = new THREE.Mesh(projectInMeters(new RoundedBoxGeometry(w, h, d, 4, r)), material)
  mesh.position.set(x, y + h / 2, z)
  mesh.castShadow = true
  mesh.receiveShadow = true
  group.add(mesh)
  return mesh
}

// A box whose bottom sits at `y`, centered on x and z, with UVs in meters.
function box(group: THREE.Group, material: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(boxInMeters(w, h, d), material)
  mesh.position.set(x, y + h / 2, z)
  mesh.castShadow = true
  mesh.receiveShadow = true
  group.add(mesh)
  return mesh
}

function cylinder(group: THREE.Group, material: THREE.Material, radiusTop: number, radiusBottom: number, h: number, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(cylinderInMeters(radiusTop, radiusBottom, h), material)
  mesh.position.set(x, y + h / 2, z)
  mesh.castShadow = true
  mesh.receiveShadow = true
  group.add(mesh)
  return mesh
}

function legs(group: THREE.Group, material: THREE.Material, w: number, d: number, h: number, inset: number, thickness = 0.04) {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(group, material, thickness, h, thickness, sx * (w / 2 - inset), 0, sz * (d / 2 - inset))
    }
  }
}

const sofa = (fabric: THREE.Material): Builder => ([w, d, h]) => {
  const g = new THREE.Group()
  const arm = 0.18
  box(g, WOOD_DARK, w - 0.1, 0.12, d - 0.1, 0, 0, 0)
  box(g, fabric, w - 2 * arm, 0.3, d * 0.75, 0, 0.12, -d * 0.1)
  box(g, fabric, w, h - 0.12, 0.22, 0, 0.12, d / 2 - 0.11)
  box(g, fabric, arm, 0.5, d, -(w / 2 - arm / 2), 0.12, 0)
  box(g, fabric, arm, 0.5, d, w / 2 - arm / 2, 0.12, 0)
  return g
}

const BUILDERS: Record<string, Builder> = {
  'sofa/three-seat': sofa(FABRIC),
  'sofa/two-seat': sofa(FABRIC_WARM),
  'chair/armchair': sofa(FABRIC_WARM),
  'chair/dining': ([w, d, h]) => {
    const g = new THREE.Group()
    legs(g, WOOD, w, d, 0.45, 0.03, 0.035)
    box(g, WOOD, w, 0.04, d, 0, 0.45, 0)
    box(g, WOOD, w, h - 0.49, 0.04, 0, 0.49, d / 2 - 0.02)
    return g
  },
  'table/dining-six': ([w, d, h]) => {
    const g = new THREE.Group()
    legs(g, WOOD_DARK, w, d, h - 0.04, 0.08, 0.06)
    box(g, WOOD, w, 0.04, d, 0, h - 0.04, 0)
    return g
  },
  'table/coffee': ([w, d, h]) => {
    const g = new THREE.Group()
    legs(g, WOOD_DARK, w, d, h - 0.04, 0.06)
    box(g, WOOD, w, 0.04, d, 0, h - 0.04, 0)
    return g
  },
  'table/desk': ([w, d, h]) => {
    const g = new THREE.Group()
    legs(g, METAL, w, d, h - 0.03, 0.05, 0.035)
    box(g, WHITE, w, 0.03, d, 0, h - 0.03, 0)
    return g
  },
  'table/desk-to-measure': ([w, d, h]) => {
    const g = new THREE.Group()
    legs(g, METAL, w, d, h - 0.03, 0.05, 0.035)
    box(g, WHITE, w, 0.03, d, 0, h - 0.03, 0)
    return g
  },
  'cabinet/credenza': ([w, d, h]) => {
    // Wood doors on a dark plinth, under a dark top; the front faces -z.
    const g = new THREE.Group()
    const plinth = 0.08
    box(g, MATTE_BLACK, w - 0.04, plinth, d - 0.06, 0, 0, 0.03)
    box(g, WOOD, w, h - plinth - 0.03, d - 0.02, 0, plinth, 0.01)
    box(g, WOOD_DARK, w + 0.01, 0.03, d, 0, h - 0.03, 0)
    const doors = Math.max(1, Math.round(w / 0.5))
    for (let i = 1; i < doors; i++) box(g, WOOD_DARK, 0.004, h - plinth - 0.09, 0.004, -w / 2 + (i * w) / doors, plinth + 0.03, -d / 2 + 0.01)
    return g
  },
  'bed/double': bed,
  'bed/single': bed,
  'plant/fiddle-leaf': ([w, , h]) => {
    const g = new THREE.Group()
    cylinder(g, POT, w * 0.32, w * 0.26, 0.35)
    cylinder(g, WOOD_DARK, 0.02, 0.025, h * 0.5, 0, 0.35)
    const leaves = new THREE.SphereGeometry(1, 16, 12)
    const spots: [number, number, number, number][] = [
      [0, h * 0.78, 0, w * 0.42],
      [w * 0.18, h * 0.65, w * 0.1, w * 0.3],
      [-w * 0.16, h * 0.68, -w * 0.12, w * 0.32],
      [w * 0.05, h * 0.92, -w * 0.05, w * 0.28],
    ]
    for (const [x, y, z, r] of spots) {
      const mesh = new THREE.Mesh(leaves, LEAF)
      mesh.position.set(x, y, z)
      mesh.scale.set(r, r * 0.85, r)
      mesh.castShadow = true
      g.add(mesh)
    }
    return g
  },
  'lamp/floor': ([w, , h]) => {
    // A linen drum on a brass pole, and the warm light it gives.
    const g = new THREE.Group()
    cylinder(g, MATTE_BLACK, w * 0.4, w * 0.42, 0.025)
    cylinder(g, BRASS, 0.011, 0.011, h - 0.36, 0, 0.025)
    const shade = new THREE.Mesh(cylinderInMeters(w * 0.42, w * 0.48, 0.34, 40, true), SHADE)
    shade.position.y = h - 0.17
    g.add(shade)
    const light = new THREE.PointLight('#ffd6a0', 2.2, 0, 2)
    light.position.y = h - 0.2
    g.add(light)
    return g
  },
  'kitchen/counter-two-meter': counter,
  'kitchen/island-two-meter': counter,
  'kitchen/wall-cabinets': wallCabinets,
  'person/standing': person,
  'kitchen/fridge': ([w, d, h]) => {
    // Stainless doors, a freezer drawer below, and the dark seals between.
    const g = new THREE.Group()
    soft(g, STEEL, w, h, d, 0.02)
    box(g, MATTE_BLACK, w - 0.01, 0.008, 0.004, 0, h * 0.34, -d / 2 - 0.001)
    box(g, MATTE_BLACK, 0.004, h - h * 0.34 - 0.02, 0.004, 0, h * 0.34 + 0.01, -d / 2 - 0.001)
    for (const x of [-0.05, 0.05]) box(g, STEEL, 0.022, 0.55, 0.035, x, h * 0.52, -d / 2 - 0.025)
    box(g, STEEL, w * 0.6, 0.022, 0.035, 0, h * 0.28, -d / 2 - 0.025)
    return g
  },
  'shelf/bookcase': ([w, d, h]) => {
    const g = new THREE.Group()
    const t = 0.025
    box(g, WOOD, t, h, d, -w / 2 + t / 2)
    box(g, WOOD, t, h, d, w / 2 - t / 2)
    box(g, WOOD, w, t, d, 0, h - t)
    box(g, WOOD, w, h, 0.012, 0, 0, d / 2 - 0.006)
    const shelves = 5
    const colors = ['#8c3b2f', '#2f4c6e', '#c8a24a', '#4d6b4a', '#6b4f7a', '#d9d2c1']
    for (let i = 0; i < shelves; i++) {
      const y = (i * (h - t)) / shelves
      box(g, WOOD, w - 2 * t, t, d, 0, y)
      // Books: a fixed pattern, so every render of the same scene matches.
      let x = -w / 2 + t + 0.02
      let k = i
      while (x < w / 2 - t - 0.08) {
        const bw = 0.03 + ((k * 7) % 4) * 0.008
        const bh = 0.2 + ((k * 5) % 5) * 0.025
        box(g, mat(colors[k % colors.length], 0.8), bw, Math.min(bh, (h - t) / shelves - 0.04), d * 0.8, x + bw / 2, y + t)
        x += bw + 0.004
        k++
      }
    }
    return g
  },
  'rug/area': ([w, d, h]) => {
    const g = new THREE.Group()
    box(g, RUG_BORDER, w, h, d).castShadow = false
    box(g, RUG_FIELD, w - 0.2, h + 0.002, d - 0.2).castShadow = false
    return g
  },
  'tv/stand': ([w, d, h]) => {
    // A walnut console, a soundbar, and a 55-inch screen (1.22 by 0.69 m,
    // 16:9) whose glass reflects the room the way a real one does.
    const g = new THREE.Group()
    const console = 0.45
    soft(g, WOOD_DARK, w, console - 0.08, d, 0.012, 0, 0.08)
    for (const x of [-w / 2 + 0.08, w / 2 - 0.08]) box(g, MATTE_BLACK, 0.03, 0.08, d - 0.08, x)
    for (let i = 1; i < 3; i++) box(g, MATTE_BLACK, 0.003, console - 0.14, 0.003, -w / 2 + (i * w) / 3, 0.11, -d / 2 - 0.001)
    soft(g, MATTE_BLACK, 0.9, 0.06, 0.09, 0.025, 0, console, -d / 2 + 0.1)
    const screenW = Math.min(1.22, w * 0.85)
    const screenH = (screenW * 9) / 16
    const bottom = Math.min(h - screenH, console + 0.1)
    for (const x of [-screenW * 0.35, screenW * 0.35]) box(g, MATTE_BLACK, 0.04, 0.09, 0.16, x, console, 0.04)
    box(g, MATTE_BLACK, screenW, screenH, 0.03, 0, bottom, 0.06)
    box(g, SCREEN, screenW - 0.012, screenH - 0.012, 0.002, 0, bottom + 0.006, 0.044)
    return g
  },
  'wardrobe/double': ([w, d, h]) => {
    // Oak veneer doors on a recessed plinth, with slim black pulls.
    const g = new THREE.Group()
    box(g, MATTE_BLACK, w - 0.04, 0.06, d - 0.04)
    box(g, WOOD, w, h - 0.06, d, 0, 0.06)
    box(g, MATTE_BLACK, 0.003, h - 0.1, 0.003, 0, 0.08, -d / 2 - 0.001)
    for (const x of [-0.03, 0.03]) box(g, MATTE_BLACK, 0.012, 0.4, 0.025, x, h * 0.45, -d / 2 - 0.012)
    return g
  },
  'bath/toilet': ([w, d, h]) => {
    const g = new THREE.Group()
    box(g, WHITE, w * 0.9, 0.4, d * 0.65, 0, 0, -d * 0.1)
    box(g, WHITE, w, h - 0.4, 0.18, 0, 0.4, d / 2 - 0.09)
    return g
  },
  'bath/basin': ([w, d, h]) => {
    const g = new THREE.Group()
    box(g, WOOD, w, h - 0.12, d)
    box(g, WHITE, w, 0.12, d, 0, h - 0.12)
    box(g, METAL, 0.03, 0.18, 0.03, 0, h, d / 2 - 0.08)
    return g
  },
  'bath/tub': ([w, d, h]) => {
    const g = new THREE.Group()
    box(g, WHITE, w, h, d)
    box(g, mat('#dfe9ee', 0.1), w - 0.12, 0.01, d - 0.12, 0, h - 0.04)
    return g
  },

  'bed/king': bed,
  'kitchen/counter': counter,
  'table/round-small': ([w, , h]) => {
    const g = new THREE.Group()
    cylinder(g, MATTE_BLACK, w * 0.3, w * 0.3, 0.02)
    cylinder(g, MATTE_BLACK, 0.025, 0.025, h - 0.05, 0, 0.02)
    cylinder(g, WOOD, w / 2, w / 2, 0.03, 0, h - 0.03)
    return g
  },
  'wardrobe/sliding': ([w, d, h]) => {
    const g = new THREE.Group()
    box(g, MATTE_BLACK, w - 0.04, 0.06, d - 0.04)
    box(g, WOOD, w, h - 0.06, d, 0, 0.06)
    const doors = Math.max(2, Math.round(w / 0.9))
    for (let i = 0; i < doors; i++) {
      const dw = w / doors
      const front = i % 2 === 0 ? -d / 2 - 0.012 : -d / 2 - 0.032
      box(g, i % 2 === 0 ? WOOD : WHITE, dw - 0.01, h - 0.12, 0.02, -w / 2 + (i + 0.5) * dw, 0.08, front)
    }
    box(g, MATTE_BLACK, w, 0.04, 0.05, 0, h - 0.04, -d / 2 - 0.03)
    return g
  },
  'wash/washing-machine': ([w, d, h]) => {
    const g = new THREE.Group()
    soft(g, WHITE, w, h, d, 0.02)
    const door = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.03, 32), OVEN_GLASS)
    door.rotation.x = Math.PI / 2
    door.position.set(0, h * 0.48, -d / 2 - 0.01)
    g.add(door)
    box(g, MATTE_BLACK, w - 0.06, 0.08, 0.01, 0, h - 0.12, -d / 2 - 0.005)
    return g
  },
  'bath/shower': ([w, d, h]) => {
    // A tiled tray, two glass sides, and a rain head on a chrome riser.
    const g = new THREE.Group()
    box(g, WHITE, w, 0.05, d)
    const glass = new THREE.MeshPhysicalMaterial({ color: '#d9ecf3', roughness: 0.03, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
    box(g, glass, w, h - 0.05, 0.008, 0, 0.05, -d / 2 + 0.004).castShadow = false
    box(g, glass, 0.008, h - 0.05, d, -w / 2 + 0.004, 0.05, 0).castShadow = false
    box(g, STEEL, w, 0.03, 0.03, 0, h - 0.03, -d / 2 + 0.015)
    cylinder(g, STEEL, 0.012, 0.012, h - 0.4, w / 2 - 0.08, 0.3, d / 2 - 0.08)
    cylinder(g, STEEL, 0.12, 0.12, 0.02, w / 2 - 0.2, h - 0.12, d / 2 - 0.2)
    return g
  },
  'bath/jacuzzi': ([w, d, h]) => {
    const g = new THREE.Group()
    soft(g, WHITE, w, h, d, 0.04)
    const water = new THREE.MeshPhysicalMaterial({ color: '#7fc4d8', roughness: 0.08, transparent: true, opacity: 0.75 })
    box(g, water, w - 0.3, 0.01, d - 0.3, 0, h - 0.08).castShadow = false
    for (const z of [-d / 2 + 0.25, d / 2 - 0.25]) box(g, mat('#e8eef0', 0.4), w - 0.4, 0.04, 0.3, 0, h - 0.3, z)
    return g
  },
  'bath/steam-cabin': ([w, d, h]) => {
    const g = new THREE.Group()
    box(g, mat('#d8d4cc', 0.6), w, 0.04, d)
    const glass = new THREE.MeshPhysicalMaterial({ color: '#dceef4', roughness: 0.04, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    box(g, glass, w, h - 0.04, 0.008, 0, 0.04, -d / 2 + 0.004).castShadow = false
    box(g, glass, 0.008, h - 0.04, d, w / 2 - 0.004, 0.04, 0).castShadow = false
    box(g, STEEL, 0.02, h - 0.04, 0.02, -w / 2 + 0.01, 0.04, -d / 2 + 0.01)
    box(g, STEEL, 0.02, h - 0.04, 0.02, w / 2 - 0.01, 0.04, -d / 2 + 0.01)
    box(g, WOOD, w - 0.1, 0.05, 0.4, 0, 0.42, d / 2 - 0.22)
    box(g, WOOD, 0.05, 0.4, 0.4, -w / 2 + 0.1, 0.04, d / 2 - 0.22)
    box(g, WOOD, 0.05, 0.4, 0.4, w / 2 - 0.1, 0.04, d / 2 - 0.22)
    return g
  },
  'seating/floor': ([w, d, h]) => {
    // A low platform with a long cushion and a row of bolsters: a baithak.
    const g = new THREE.Group()
    box(g, WOOD, w, 0.18, d)
    soft(g, FABRIC_WARM, w - 0.04, 0.12, d - 0.04, 0.04, 0, 0.18)
    const n = Math.max(2, Math.round(w / 0.6))
    for (let i = 0; i < n; i++) soft(g, PILLOW, Math.min(0.5, w / n - 0.06), h - 0.3, 0.14, 0.05, -w / 2 + (i + 0.5) * (w / n), 0.3, d / 2 - 0.1)
    return g
  },
  'theatre/recliner-row': ([w, d, h]) => {
    const g = new THREE.Group()
    const n = Math.max(1, Math.round(w / 0.85))
    const sw = w / n
    const leather = mat('#4a2c25', 0.55)
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + (i + 0.5) * sw
      soft(g, MATTE_BLACK, sw - 0.06, 0.12, d - 0.1, 0.02, x, 0, 0)
      soft(g, leather, sw - 0.1, 0.3, d * 0.72, 0.08, x, 0.12, -d * 0.1)
      soft(g, leather, sw - 0.1, h - 0.15, 0.26, 0.09, x, 0.15, d / 2 - 0.15)
      for (const s of [-1, 1]) soft(g, leather, 0.1, 0.5, d * 0.78, 0.04, x + s * (sw / 2 - 0.08), 0.12, -0.02)
    }
    return g
  },
  'screen/projection': ([w, , h]) => {
    const g = new THREE.Group()
    box(g, MATTE_BLACK, w, h, 0.03, 0, 0, 0.02)
    box(g, new THREE.MeshStandardMaterial({ color: '#f2f2f0', roughness: 0.6, emissive: '#dfe3ea', emissiveIntensity: 0.25 }), w - 0.12, h - 0.12, 0.01, 0, 0.06, 0).castShadow = false
    return g
  },
  'tv/wall': ([w, , h]) => {
    const g = new THREE.Group()
    box(g, MATTE_BLACK, w, h, 0.03, 0, 0, 0.03)
    box(g, SCREEN, w - 0.012, h - 0.012, 0.002, 0, 0.006, 0.013).castShadow = false
    return g
  },
  'railing/glass': ([w, , h]) => {
    // Glass panels between slim steel posts, a round handrail on top.
    const g = new THREE.Group()
    const glass = new THREE.MeshPhysicalMaterial({ color: '#dbeaf0', roughness: 0.03, transparent: true, opacity: 0.22, side: THREE.DoubleSide })
    box(g, glass, w - 0.02, h - 0.12, 0.012, 0, 0.02).castShadow = false
    const posts = Math.max(2, Math.round(w / 1.2) + 1)
    for (let i = 0; i < posts; i++) box(g, STEEL, 0.03, h - 0.04, 0.03, -w / 2 + 0.03 + (i * (w - 0.06)) / (posts - 1), 0)
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, w, 12), STEEL)
    rail.rotation.z = Math.PI / 2
    rail.position.y = h - 0.02
    rail.castShadow = true
    g.add(rail)
    return g
  },
  'lift/doors': ([w, d, h]) => {
    const g = new THREE.Group()
    const brushed = mat('#b9bcc0', 0.35, 0.85)
    box(g, brushed, w / 2 - 0.004, h, 0.04, -w / 4, 0, 0)
    box(g, brushed, w / 2 - 0.004, h, 0.04, w / 4, 0, 0)
    box(g, MATTE_BLACK, w + 0.16, 0.08, d, 0, h, 0)
    box(g, MATTE_BLACK, 0.08, h, d, -w / 2 - 0.04, 0, 0)
    box(g, MATTE_BLACK, 0.08, h, d, w / 2 + 0.04, 0, 0)
    box(g, new THREE.MeshStandardMaterial({ color: '#fff4dc', emissive: '#ffd27a', emissiveIntensity: 1.5 }), 0.05, 0.05, 0.01, w / 2 + 0.2, 1.05, -d / 2)
    return g
  },
  'column/round': ([w, , h]) => {
    const g = new THREE.Group()
    cylinder(g, mat('#d8d3c8', 0.85), w / 2, w / 2, h)
    return g
  },
  'hut/pavilion': ([w, d, h]) => {
    // Four posts on a deck under a hipped roof: a place to sit outside.
    const g = new THREE.Group()
    box(g, WOOD, w, 0.12, d)
    const postH = h - 0.9
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, WOOD_DARK, 0.12, postH, 0.12, sx * (w / 2 - 0.15), 0.12, sz * (d / 2 - 0.15))
    const roofBase = 0.12 + postH
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 1, 0.9, 4, 1), surface('roof-tile', mat('#6a4a34', 0.8)))
    roof.rotation.y = Math.PI / 4
    roof.scale.set((w + 0.4) / Math.SQRT2, 1, (d + 0.4) / Math.SQRT2)
    roof.position.y = roofBase + 0.45
    roof.castShadow = true
    roof.receiveShadow = true
    g.add(roof)
    box(g, WOOD_DARK, w + 0.3, 0.08, d + 0.3, 0, roofBase - 0.08)
    return g
  },
  'statue/buddha': ([w, , h]) => {
    const g = new THREE.Group()
    // A seated figure in stone: plinth, lotus base, folded legs, torso,
    // shoulders, head and topknot. Read as a Buddha from across a garden.
    const stone = mat('#8f8a80', 0.9)
    box(g, stone, w, 0.45, w)
    const blob = (r: number, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), stone)
      mesh.scale.set(sx, sy, sz)
      mesh.position.set(x, y, z)
      mesh.castShadow = true
      g.add(mesh)
    }
    const k = h / 1.7
    blob(w * 0.46, 1, 0.3, 1, 0, 0.5 * k, 0)
    blob(w * 0.4, 1.1, 0.42, 0.75, 0, 0.62 * k, 0.02)
    blob(w * 0.24, 1, 1.35, 0.72, 0, 0.98 * k, -0.02)
    for (const s of [-1, 1]) blob(w * 0.1, 1, 1.9, 1, s * w * 0.27, 1.0 * k, 0)
    blob(w * 0.17, 0.9, 1, 1, 0, 1.33 * k, 0)
    blob(w * 0.13, 1, 1.1, 1, 0, 1.4 * k, 0)
    blob(w * 0.05, 1, 1.3, 1, 0, 1.56 * k, 0)
    return g
  },
  'rock/boulder': ([w, d, h]) => {
    const g = new THREE.Group()
    // Faceted, sunk a little into the ground, and never the same twist.
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5, 0), mat('#7d7a72', 0.95, 0).clone())
    rock.scale.set(w, h * 1.25, d)
    rock.position.y = h * 0.4
    rock.rotation.set(0.35 + w, 0.6 + d * 2, 0.2 + h)
    rock.castShadow = true
    rock.receiveShadow = true
    g.add(rock)
    return g
  },
  'plant/shrub': ([w, d, h]) => {
    const g = new THREE.Group()
    const leaf = mat('#4a7a3c', 0.9)
    for (const [x, z, r] of [[0, 0, 0.5], [0.25, 0.15, 0.36], [-0.22, 0.2, 0.34], [0.1, -0.25, 0.38], [-0.15, -0.18, 0.3]]) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 9), leaf)
      m.scale.set(r * w, r * h * 1.1, r * d)
      m.position.set(x * w, h * 0.5, z * d)
      m.castShadow = true
      g.add(m)
    }
    return g
  },
  'tree/small': (size) => tree(size, 0.42),
  'tree/round': (size) => tree(size, 0.3),
  'car/sedan': ([w, d, h]) => {
    const g = new THREE.Group()
    const paint = new THREE.MeshPhysicalMaterial({ color: '#2b3540', roughness: 0.3, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.08 })
    soft(g, paint, w, h * 0.42, d, 0.08, 0, 0.22)
    soft(g, paint, w * 0.88, h * 0.4, d * 0.5, 0.12, 0, 0.22 + h * 0.4, -d * 0.05)
    const glass = new THREE.MeshPhysicalMaterial({ color: '#1a2630', roughness: 0.1, clearcoat: 1 })
    soft(g, glass, w * 0.86, h * 0.3, d * 0.46, 0.08, 0, 0.22 + h * 0.46, -d * 0.05)
    for (const sx of [-1, 1]) for (const z of [-d * 0.32, d * 0.32]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.22, 20), MATTE_BLACK)
      wheel.rotation.z = Math.PI / 2
      wheel.position.set(sx * (w / 2 - 0.1), 0.33, z)
      wheel.castShadow = true
      g.add(wheel)
    }
    for (const sx of [-0.3, 0.3]) box(g, new THREE.MeshStandardMaterial({ color: '#fff8e0', emissive: '#fff2c0', emissiveIntensity: 0.8 }), 0.3, 0.1, 0.02, sx * w, 0.22 + h * 0.25, -d / 2)
    return g
  },
  'bench/garden': ([w, d, h]) => {
    const g = new THREE.Group()
    for (const x of [-w / 2 + 0.08, w / 2 - 0.08]) {
      box(g, MATTE_BLACK, 0.05, 0.42, d, x, 0)
      box(g, MATTE_BLACK, 0.05, h - 0.42, 0.05, x, 0.42, d / 2 - 0.03)
    }
    for (let i = 0; i < 4; i++) box(g, WOOD, w, 0.03, 0.09, 0, 0.42, -d / 2 + 0.05 + i * 0.12)
    for (let i = 0; i < 3; i++) box(g, WOOD, w, 0.08, 0.03, 0, 0.5 + i * 0.12, d / 2 - 0.03)
    return g
  },
  'wall/boundary': ([w, d, h]) => {
    // A rendered masonry wall with a coping on top.
    const g = new THREE.Group()
    box(g, surface('stucco-warm', mat('#e3d3bb', 0.9), '#e3d3bb'), w, h - 0.05, d)
    box(g, mat('#cfc8bc', 0.8), w + 0.04, 0.05, d + 0.08, 0, h - 0.05)
    return g
  },
  'stairs/horseshoe': (size, options) => stairs(size, options, 'stairs/horseshoe'),
  'stairs/straight': (size, options) => stairs(size, options, 'stairs/straight'),
}

// A tree from a tapered trunk, three leaning branches, and a crown of
// overlapping leaf balls in two greens. Light enough to plant a street of.
function tree([w, d, h]: [number, number, number], trunkShare: number): THREE.Group {
  const g = new THREE.Group()
  const bark = mat('#5e4a3a', 0.95)
  const trunkH = h * trunkShare
  cylinder(g, bark, 0.06 * h / 4, 0.1 * h / 4, trunkH)
  for (const [angle, lean] of [[0.3, 0.5], [2.4, 0.45], [4.3, 0.55]]) {
    const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.05, h * 0.35, 7), bark)
    branch.position.set(Math.cos(angle) * w * 0.12, trunkH + h * 0.12, Math.sin(angle) * d * 0.12)
    branch.rotation.set(Math.sin(angle) * lean, 0, -Math.cos(angle) * lean)
    branch.castShadow = true
    g.add(branch)
  }
  const greens = [mat('#4d7c3a', 0.9), mat('#5f8f45', 0.9), mat('#3f6a33', 0.9)]
  const crownBottom = trunkH + h * 0.08
  const crownH = h - crownBottom
  const balls: [number, number, number, number][] = [[0, 0.5, 0, 0.5], [0.32, 0.4, 0.1, 0.36], [-0.3, 0.45, -0.12, 0.38], [0.08, 0.72, -0.22, 0.34], [-0.12, 0.3, 0.3, 0.33], [0.22, 0.62, 0.28, 0.3], [-0.26, 0.7, 0.12, 0.3]]
  balls.forEach(([x, y, z, r], i) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 9), greens[i % greens.length])
    m.scale.set(r * w, r * crownH * 1.1, r * d)
    m.position.set(x * w, crownBottom + y * crownH, z * d)
    m.castShadow = true
    g.add(m)
  })
  return g
}

// Stairs from the same geometry the walker climbs: solid treads with a
// stepped underside, a landing slab under the first steps, and a handrail
// on the open side. `rise` is a full floor unless the item says otherwise.
function stairs([w, d, h]: [number, number, number], options: BuildItemOptions, kind = 'stairs/horseshoe'): THREE.Group {
  const g = new THREE.Group()
  const s = stairGeometry(kind, w, d, options.rise ?? h)
  const concrete = mat('#d9d4cb', 0.85)
  const nosing = mat('#b9b2a6', 0.7)
  // Plan x/y laid flat the same way floors are: the extrusion then runs up.
  const shape = (polygon: [number, number][]) => new THREE.Shape(polygon.map(([x, y]) => new THREE.Vector2(x, y)))
  for (const tread of s.treads) {
    const bottom = Math.max(0, tread.top - 0.3)
    const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape(tread.polygon), { depth: tread.top - bottom, bevelEnabled: false }), concrete)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.y = bottom
    mesh.castShadow = true
    mesh.receiveShadow = true
    g.add(mesh)
  }
  if (s.landing.length >= 3) {
    const slab = new THREE.Mesh(new THREE.ExtrudeGeometry(shape(s.landing), { depth: 0.15, bevelEnabled: false }), concrete)
    slab.rotation.x = -Math.PI / 2
    slab.position.y = -0.15
    slab.receiveShadow = true
    g.add(slab)
  }
  // Handrails on both edges: a post per tread, a rail between. The outer
  // one sits a little in from the edge, clear of any wall.
  const railH = 0.95
  for (const edge of ['inner', 'outer'] as const) {
    let previous: THREE.Vector3 | undefined
    for (const tread of s.treads) {
      const [a, b] = edge === 'inner' ? tread.inner : [tread.polygon[1], tread.polygon[tread.polygon.length - 2]]
      const p = edge === 'inner' ? a : [a[0] + (tread.inner[0][0] - a[0]) * 0.08, a[1] + (tread.inner[0][1] - a[1]) * 0.08]
      void b
      const post = new THREE.Vector3(p[0], tread.top, -p[1])
      const top = post.clone().setY(tread.top + railH)
      cylinder(g, STEEL, 0.012, 0.012, railH, post.x, post.y, post.z)
      if (previous) {
        const length = previous.distanceTo(top)
        const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, length, 10), STEEL)
        rail.position.copy(previous).lerp(top, 0.5)
        rail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(previous).normalize())
        g.add(rail)
      }
      previous = top
    }
  }
  // Nosing strips make the steps read from a distance.
  for (const tread of s.treads) {
    const [a, b] = [tread.polygon[0], tread.polygon[1]]
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    const strip = new THREE.Mesh(new THREE.BoxGeometry(length, 0.012, 0.04), nosing)
    strip.position.set((a[0] + b[0]) / 2, tread.top + 0.004, -(a[1] + b[1]) / 2)
    strip.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0])
    g.add(strip)
  }
  return g
}

// A standing adult, 1.75 m, eyes at about 1.63 m: the scale figure that
// lets a viewer judge every other size at a glance. One matte finish, the
// way architects draw scale figures, so it reads as a measure rather than
// a character next to photographed furniture.
function person([, , h]: [number, number, number]): THREE.Group {
  const g = new THREE.Group()
  const k = h / 1.75
  const figure = mat('#d9d6d0', 0.55)
  const skin = figure
  const top = figure
  const trousers = figure
  const shoes = mat('#bdb9b2', 0.6)
  const hair = figure
  const capsule = (material: THREE.Material, radius: number, length: number, x: number, y: number, z = 0, tilt = 0, scaleZ = 1) => {
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius * k, length * k, 6, 16), material)
    mesh.position.set(x * k, y * k, z * k)
    mesh.rotation.z = tilt
    mesh.scale.z = scaleZ
    mesh.castShadow = true
    g.add(mesh)
    return mesh
  }
  for (const side of [-1, 1]) {
    box(g, shoes, 0.1 * k, 0.07 * k, 0.26 * k, side * 0.1 * k, 0, -0.04 * k)
    capsule(trousers, 0.068, 0.72, side * 0.1, 0.07 + 0.068 + 0.36)
    capsule(top, 0.05, 0.46, side * 0.235, 1.15, 0, side * 0.08)
    capsule(skin, 0.042, 0.04, side * 0.255, 0.86, 0)
  }
  capsule(trousers, 0.16, 0.06, 0, 0.94, 0, 0, 0.7)
  capsule(top, 0.19, 0.3, 0, 1.22, 0, 0, 0.62)
  cylinder(g, skin, 0.05 * k, 0.055 * k, 0.09 * k, 0, 1.46 * k)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1 * k, 24, 16), skin)
  head.scale.set(0.92, 1.18, 1)
  head.position.set(0, 1.63 * k, 0)
  head.castShadow = true
  g.add(head)
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.106 * k, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hair)
  hairCap.scale.set(0.94, 1.12, 1.04)
  hairCap.position.set(0, 1.645 * k, 0.012 * k)
  g.add(hairCap)
  return g
}

function bed([w, d, h]: [number, number, number]): THREE.Group {
  // An oak frame, a soft mattress, a duvet that falls over the sides and
  // folds back at the top, two pillows, and an upholstered headboard.
  const g = new THREE.Group()
  box(g, WOOD, w, 0.26, d, 0, 0.04)
  for (const x of [-w / 2 + 0.06, w / 2 - 0.06]) for (const z of [-d / 2 + 0.06, d / 2 - 0.12]) box(g, WOOD, 0.05, 0.04, 0.05, x, 0, z)
  soft(g, LINEN, w - 0.06, 0.22, d - 0.14, 0.06, 0, 0.3, 0.03)
  const cover = d * 0.66
  const coverZ = -d / 2 + cover / 2 + 0.02
  soft(g, DUVET, w + 0.04, 0.07, cover, 0.035, 0, 0.47, coverZ)
  for (const x of [-(w / 2 + 0.01), w / 2 + 0.01]) soft(g, DUVET, 0.035, 0.24, cover, 0.016, x, 0.27, coverZ)
  soft(g, DUVET, w + 0.04, 0.24, 0.035, 0.016, 0, 0.27, -d / 2 + 0.03)
  soft(g, DUVET, w + 0.04, 0.1, 0.24, 0.05, 0, 0.47, coverZ + cover / 2 - 0.1)
  const pillows = w > 1.2 ? [-w / 4, w / 4] : [0]
  for (const x of pillows) soft(g, PILLOW, Math.min(0.62, w / pillows.length - 0.08), 0.15, 0.42, 0.07, x, 0.5, d / 2 - 0.33)
  soft(g, HEADBOARD, w + 0.08, h - 0.08, 0.09, 0.035, 0, 0.08, d / 2 - 0.045)
  return g
}

function counter([w, d, h]: [number, number, number]): THREE.Group {
  const g = new THREE.Group()
  const plinth = 0.1
  box(g, MATTE_BLACK, w - 0.04, plinth, d - 0.08, 0, 0, 0.04)
  box(g, FRONTS, w, h - 0.04 - plinth, d - 0.02, 0, plinth, 0.01)
  box(g, WORKTOP, w + 0.02, 0.04, d, 0, h - 0.04)
  const doors = Math.max(1, Math.round(w / 0.6))
  for (let i = 1; i < doors; i++) box(g, mat('#cfcbc3', 0.5), 0.003, h - 0.18 - plinth, 0.003, -w / 2 + (i * w) / doors, plinth + 0.04, -d / 2 + 0.01)
  for (let i = 0; i < doors; i++) box(g, STEEL, 0.14, 0.012, 0.02, -w / 2 + ((i + 0.5) * w) / doors, h - 0.16, -d / 2 - 0.006)
  if (w >= 1.2 && d < 0.8) {
    // A stainless sink on the left, a hob over an oven on the right, and
    // a tiled splashback behind.
    box(g, STEEL, 0.52, 0.006, 0.42, -w / 4, h, -0.02)
    box(g, mat('#9da1a6', 0.35, 0.85), 0.46, 0.004, 0.36, -w / 4, h + 0.004, -0.02)
    cylinder(g, STEEL, 0.013, 0.013, 0.28, -w / 4, h, d / 2 - 0.08)
    box(g, STEEL, 0.022, 0.022, 0.18, -w / 4, h + 0.26, d / 2 - 0.16)
    box(g, OVEN_GLASS, 0.58, 0.006, 0.5, w / 4, h, -0.02)
    for (const [x, z] of [[-0.14, -0.12], [0.14, -0.12], [-0.14, 0.1], [0.14, 0.1]]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.003, 6, 40), mat('#55595f', 0.4))
      ring.rotation.x = -Math.PI / 2
      ring.position.set(w / 4 + x, h + 0.008, -0.02 + z)
      g.add(ring)
    }
    box(g, MATTE_BLACK, 0.58, 0.6, 0.006, w / 4, plinth + 0.06, -d / 2 - 0.004)
    box(g, OVEN_GLASS, 0.46, 0.34, 0.004, w / 4, plinth + 0.14, -d / 2 - 0.008)
    box(g, STEEL, 0.44, 0.02, 0.03, w / 4, plinth + 0.56, -d / 2 - 0.03)
    box(g, mat('#e9e6df', 0.25), w, 0.55, 0.012, 0, h, d / 2 - 0.006)
  }
  return g
}

function wallCabinets([w, d]: [number, number, number]): THREE.Group {
  const g = new THREE.Group()
  const bottom = 1.45
  const height = 0.7
  box(g, mat('#e9e6df', 0.5), w, height, d, 0, bottom)
  const doors = Math.max(1, Math.round(w / 0.5))
  for (let i = 1; i < doors; i++) box(g, mat('#c9c5bc', 0.5), 0.004, height - 0.04, 0.004, -w / 2 + (i * w) / doors, bottom + 0.02, -d / 2 - 0.001)
  for (let i = 0; i < doors; i++) box(g, METAL, 0.012, 0.1, 0.02, -w / 2 + ((i + 0.5) * w) / doors + (i % 2 ? -0.18 : 0.18) * (w / doors), bottom + 0.06, -d / 2 - 0.008)
  // Under-cabinet light on the worktop.
  box(g, new THREE.MeshStandardMaterial({ color: '#fff4dc', emissive: '#fff0d0', emissiveIntensity: 1.2 }), w - 0.1, 0.01, 0.03, 0, bottom - 0.01, -d / 2 + 0.05)
  return g
}

function standIn([w, d, h]: [number, number, number]): THREE.Group {
  const g = new THREE.Group()
  box(g, mat('#d9d6d0', 0.8), w * 0.9, h * 0.9, d * 0.9).castShadow = false
  return g
}

// A labeled box for an asset the library doesn't have, so the scene always
// builds and the agent can finish the layout before resolving the asset.
function placeholder(label: string, [w, d, h]: [number, number, number]): THREE.Group {
  const g = new THREE.Group()
  const mesh = box(g, new THREE.MeshStandardMaterial({ color: '#e0b84a', roughness: 0.8, transparent: true, opacity: 0.85 }), w, h, d)
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: '#7a5c10' }))
  edges.position.copy(mesh.position)
  g.add(edges)
  g.add(textSprite(label, h + 0.25))
  return g
}

export function textSprite(text: string, y: number, scale = 0.35): THREE.Sprite {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')!
  const font = '600 48px system-ui, sans-serif'
  context.font = font
  const width = Math.ceil(context.measureText(text).width) + 40
  canvas.width = width
  canvas.height = 80
  context.font = font
  context.fillStyle = 'rgba(20, 20, 24, 0.82)'
  context.beginPath()
  context.roundRect(0, 0, width, 80, 16)
  context.fill()
  context.fillStyle = '#ffffff'
  context.textBaseline = 'middle'
  context.fillText(text, 20, 42)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }))
  sprite.scale.set((scale * width) / 80, scale, 1)
  sprite.position.y = y
  sprite.renderOrder = 10
  return sprite
}

// Pieces that rest on something else, or lie flat, cast no contact shadow.
const NO_CONTACT = new Set(['rug/area', 'kitchen/wall-cabinets', 'railing/glass', 'lift/doors'])

export function buildItem(asset: string, label: string, size?: [number, number, number], options: BuildItemOptions = {}): THREE.Group {
  const info = findAsset(asset)
  const builder = BUILDERS[asset]
  const measure = info ? (info.resizable && size ? size : info.size) : (size ?? [0.5, 0.5, 0.5])
  // A piece with a model but no primitive stands in as a plain block, not
  // a labeled placeholder, for the moment before the model arrives.
  const group = info && builder ? builder(measure, options) : info?.model && hasModel(info.model) ? standIn(measure) : placeholder(label, measure)
  const [w, d] = measure
  if (info?.model && hasModel(info.model)) {
    // The primitive piece stands in until the model arrives, then steps
    // aside; glTF fronts face +z, so the default turn is half a circle.
    const stand = [...group.children]
    loadModel(info.model).then((model) => {
      if (!model) return
      for (const child of stand) group.remove(child)
      group.add(fitModel(model, measure, info.yaw ?? 180))
    })
  }
  if (!NO_CONTACT.has(asset) && !info?.passable && info?.category !== 'column') {
    // Interior lights cast no shadows (too slow), so a soft dark patch
    // under each piece keeps it from looking like it floats.
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 1.25, d * 1.25),
      new THREE.MeshBasicMaterial({ map: contactShadow(), color: '#000000', transparent: true, opacity: asset.startsWith('person/') ? 0.3 : 0.4, depthWrite: false }),
    )
    shadow.rotation.x = -Math.PI / 2
    shadow.position.y = 0.004
    shadow.renderOrder = 1
    group.add(shadow)
  }
  return group
}
