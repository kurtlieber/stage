// PROTOTYPE, throwaway (dotfiles#664 step 1). Room mode: the current room
// alone, circled from outside, with three ways of opening the near walls,
// switched by ?variant=A|B|C and the bar at the bottom. The winner is
// rewritten properly in step 2; this file stays on prototype/room-mode.
import * as THREE from 'three'
import { roomElevation, type Point } from '../core/geometry.ts'
import type { Scene } from '../core/schema.ts'
import type { Built } from './build.ts'

export type Variant = 'A' | 'B' | 'C'
export const VARIANTS: { key: Variant; name: string }[] = [
  { key: 'A', name: 'Low strip' },
  { key: 'B', name: 'Glass walls' },
  { key: 'C', name: 'Section in context' },
]

// A: the near walls drop to a strip this high above the room's floor; the
// far walls stand.
const STRIP = 0.15
// C: every wall on the floor is cut at this height above the room's floor,
// like a drawn plan.
const SECTION = 1.2

const CUT = new THREE.MeshBasicMaterial({ color: '#2b2622' })
const GHOST = new THREE.MeshStandardMaterial({ color: '#e4ecf2', transparent: true, opacity: 0.16, depthWrite: false, roughness: 0.15 })
const MUTED = new THREE.MeshStandardMaterial({ color: '#cfccc6', roughness: 0.95 })

// Doors and windows in a cut wall are clipped at the cut, not hidden, so
// they read like a drawn plan. One plane: Room mode has one cut height.
const CLIP = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)
const clippedCopies = new Map<THREE.Material, THREE.Material>()
function clipped(material: THREE.Material) {
  let copy = clippedCopies.get(material)
  if (!copy) {
    copy = material.clone()
    copy.clippingPlanes = [CLIP]
    copy.clipShadows = true
    clippedCopies.set(material, copy)
  }
  return copy
}

type Look = 'full' | 'cut' | 'ghost' | 'muted' | 'clip'
const originals = new Map<THREE.Mesh, { material: THREE.Material | THREE.Material[]; castShadow: boolean }>()

function setLook(mesh: THREE.Mesh, look: Look) {
  if ((mesh.userData.look ?? 'full') === look) return
  if (!originals.has(mesh)) originals.set(mesh, { material: mesh.material, castShadow: mesh.castShadow })
  const { material: original, castShadow } = originals.get(mesh)!
  mesh.castShadow = look === 'ghost' ? false : castShadow
  if (look === 'full') {
    mesh.material = original
    originals.delete(mesh)
  } else if (look === 'clip') {
    mesh.material = Array.isArray(original) ? original.map(clipped) : clipped(original)
  } else if (look === 'cut' && Array.isArray(original)) {
    // Box faces: +x, -x, +y (the top, where the cut shows), -y, +z, -z.
    const faces = original.slice()
    faces[2] = CUT
    mesh.material = faces
  } else if (look === 'ghost') {
    mesh.material = GHOST
  } else if (look === 'muted') {
    mesh.material = MUTED
  }
  mesh.userData.look = look
}

export function leaveRoomMode() {
  for (const [mesh, { material, castShadow }] of originals) {
    mesh.material = material
    mesh.castShadow = castShadow
    mesh.userData.look = 'full'
  }
  originals.clear()
}

// Cuts a wall's pieces at a world height, or back to full with Infinity.
// A piece that ends at the floor, a sill under an archway, is left out: its
// top lies in the floor and flickers against it; a wall left with nothing
// standing goes, baseboards and all.
function cutTo(group: THREE.Object3D, height: number, look: Look, floor: number) {
  let standing = false
  for (const child of group.children) {
    if (child.userData.roof) {
      child.visible = height === Infinity
      continue
    }
    if (child.userData.opening) {
      child.visible = true
      child.traverse((o) => {
        if (o instanceof THREE.Mesh) setLook(o, height === Infinity ? 'full' : 'clip')
      })
      continue
    }
    const cut = child.userData.cutaway as { bottom: number; top: number; base: number } | undefined
    if (!cut) continue
    const top = Math.min(cut.top, height - cut.base)
    const h = top - cut.bottom
    child.visible = h > 0.01 && cut.base + top > floor + 0.01
    if (!child.visible) continue
    standing = true
    child.scale.y = h / (cut.top - cut.bottom)
    child.position.y = cut.base + cut.bottom + h / 2
    setLook(child as THREE.Mesh, top < cut.top ? 'cut' : look)
  }
  group.visible = standing
}

// Called every frame in Room mode, in place of the house's own cutaway.
export function applyRoomMode(built: Built, scene: Scene, roomId: string, variant: Variant, camera: THREE.Camera, sameFloor: (level: number) => boolean) {
  const room = scene.rooms.find((r) => r.id === roomId)
  if (!room) return
  const floor = roomElevation(scene, room)
  CLIP.constant = floor + (variant === 'C' ? SECTION : STRIP)
  const eye: Point = [camera.position.x, -camera.position.z]
  const centre = centroid(room.floor)
  const rooms = new Set(scene.rooms.map((r) => r.id))
  const itemRoom = new Map(scene.items.map((i) => [i.id, i.room]))
  const overlays = new Set(built.overlays.values())
  built.labels.visible = false
  for (const object of built.indoor) object.visible = false

  for (const child of built.root.children) {
    const wall = child.userData.wall as { a: Point; b: Point } | undefined
    if (wall) {
      const mine = (child.userData.rooms as string[] | undefined)?.includes(roomId) ?? false
      if (!mine) {
        child.visible = variant === 'C' && sameFloor(child.userData.level ?? 0)
        if (child.visible) cutTo(child, floor + SECTION, 'full', floor)
        continue
      }
      child.visible = true
      if (variant === 'C') {
        cutTo(child, floor + SECTION, 'full', floor)
        continue
      }
      // Near: the camera stands on the far side of the wall's line from
      // the room, so the wall is between the camera and the room.
      const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]) || 1
      let n: Point = [-(wall.b[1] - wall.a[1]) / len, (wall.b[0] - wall.a[0]) / len]
      const mid: Point = [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2]
      if ((centre[0] - mid[0]) * n[0] + (centre[1] - mid[1]) * n[1] > 0) n = [-n[0], -n[1]]
      const near = (eye[0] - mid[0]) * n[0] + (eye[1] - mid[1]) * n[1] > 0.05
      if (variant === 'A') cutTo(child, near ? floor + STRIP : Infinity, 'full', floor)
      // Doors and windows in a glass wall stay, so you see where they are.
      else cutTo(child, Infinity, near ? 'ghost' : 'full', floor)
      continue
    }
    if (overlays.has(child as THREE.Mesh)) {
      child.visible = false
      continue
    }
    if (rooms.has(child.name)) {
      const current = child.name === roomId
      child.visible = current || (variant === 'C' && sameFloor(child.userData.level ?? 0))
      // In C the other rooms' floors go grey, so the current one stands out.
      child.traverse((o) => {
        if (o instanceof THREE.Mesh && !o.userData.roof && o.geometry.type !== 'BoxGeometry') setLook(o, current || variant !== 'C' ? 'full' : 'muted')
      })
      continue
    }
    const owner = itemRoom.get(child.name)
    if (owner !== undefined) child.visible = owner === roomId || (variant === 'C' && sameFloor(child.userData.level ?? 0))
  }
}

function centroid(points: Point[]): Point {
  let x = 0
  let y = 0
  for (const p of points) {
    x += p[0]
    y += p[1]
  }
  return [x / points.length, y / points.length]
}

// The floating bar that flips between the variants: ← and → keys too,
// outside Walk mode, where the arrows turn you.
export function variantSwitcher(current: Variant, onChange: (v: Variant) => void, arrowsFree: () => boolean) {
  const bar = document.createElement('div')
  bar.className = 'proto-switcher'
  const prev = document.createElement('button')
  prev.textContent = '←'
  prev.setAttribute('aria-label', 'Previous variant')
  const label = document.createElement('span')
  const next = document.createElement('button')
  next.textContent = '→'
  next.setAttribute('aria-label', 'Next variant')
  bar.append(prev, label, next)
  document.body.append(bar)
  let index = Math.max(0, VARIANTS.findIndex((v) => v.key === current))
  const show = () => {
    const v = VARIANTS[index]
    label.textContent = `Prototype ${v.key} · ${v.name}`
    const url = new URL(location.href)
    url.searchParams.set('variant', v.key)
    history.replaceState(null, '', url)
  }
  const step = (by: number) => {
    index = (index + by + VARIANTS.length) % VARIANTS.length
    show()
    onChange(VARIANTS[index].key)
  }
  prev.addEventListener('click', () => step(-1))
  next.addEventListener('click', () => step(1))
  window.addEventListener('keydown', (event) => {
    const t = event.target as HTMLElement | null
    if (t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable)) return
    if (!arrowsFree() || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'ArrowLeft') step(-1)
    else if (event.key === 'ArrowRight') step(1)
  })
  show()
}
