import * as THREE from 'three'
import { centroid, roomElevation, type Point } from '../core/geometry.ts'
import { roomUnder } from '../core/room-facts.ts'
import type { Scene } from '../core/schema.ts'
import type { Built } from './build.ts'

// Room mode: the current room alone, circled from outside, ceiling off and
// the rest of the house hidden. The walls between the camera and the room
// open up one of two ways, the person's choice: cut down to a low strip,
// or turned to glass.

export type Walls = 'low' | 'glass'

// The low strip, above the room's own floor.
const STRIP = 0.15

// The cut face on top of a cut wall, dark so the cut reads as a cut.
const CUT = new THREE.MeshBasicMaterial({ color: '#2b2622' })
const GLASS = new THREE.MeshStandardMaterial({ color: '#e4ecf2', transparent: true, opacity: 0.16, depthWrite: false, roughness: 0.15 })

// Doors and windows in a cut wall are cut at the strip too, not hidden, so
// the strip shows where they are. One plane: Room mode shows one room.
const CLIP = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)
const clippedCopies = new Map<THREE.Material, THREE.Material>()
function clipped(material: THREE.Material): THREE.Material {
  let copy = clippedCopies.get(material)
  if (!copy) {
    copy = material.clone()
    copy.clippingPlanes = [CLIP]
    copy.clipShadows = true
    clippedCopies.set(material, copy)
  }
  return copy
}

type Look = 'full' | 'cut' | 'glass' | 'clip'
// What each changed mesh looked like, to put back on leaving.
const originals = new Map<THREE.Mesh, { material: THREE.Material | THREE.Material[]; castShadow: boolean }>()

function setLook(mesh: THREE.Mesh, look: Look) {
  if ((mesh.userData.look ?? 'full') === look) return
  if (!originals.has(mesh)) originals.set(mesh, { material: mesh.material, castShadow: mesh.castShadow })
  const { material: original, castShadow } = originals.get(mesh)!
  mesh.castShadow = look === 'glass' ? false : castShadow
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
  } else if (look === 'glass') {
    mesh.material = GLASS
  }
  mesh.userData.look = look
}

// Puts every wall back as it was built. The house's own cutaway then takes
// over the walls' sizes again.
export function leaveRoomMode() {
  for (const [mesh, { material, castShadow }] of originals) {
    mesh.material = material
    mesh.castShadow = castShadow
    mesh.userData.look = 'full'
  }
  originals.clear()
}

// Cuts a wall's pieces at a world height, or leaves them whole at Infinity.
// A piece that ends at the floor, a sill under an archway, is left out:
// its top lies in the floor and flickers against it. A wall left with
// nothing standing goes, baseboards and all.
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

// Called every frame in Room mode, in place of the house's own cutaway,
// since which walls are near changes as the camera circles.
export function applyRoomMode(built: Built, scene: Scene, roomId: string, walls: Walls, camera: THREE.Camera) {
  const room = scene.rooms.find((r) => r.id === roomId)
  if (!room) return
  const floor = roomElevation(scene, room)
  CLIP.constant = floor + STRIP
  const eye: Point = [camera.position.x, -camera.position.z]
  const centre = centroid(room.floor)
  const rooms = new Set(scene.rooms.map((r) => r.id))
  const itemRoom = new Map(scene.items.map((i) => [i.id, i.room]))
  const overlays = new Set<THREE.Object3D>(built.overlays.values())
  built.labels.visible = false
  for (const object of built.indoor) object.visible = false

  for (const child of built.root.children) {
    const wall = child.userData.wall as { a: Point; b: Point; rooms: string[] } | undefined
    if (wall) {
      child.visible = wall.rooms.includes(roomId)
      if (!child.visible) continue
      // Near: the camera is on the far side of the wall's line from the
      // room's middle, so the wall stands between the camera and the room.
      const length = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]) || 1
      let n: Point = [-(wall.b[1] - wall.a[1]) / length, (wall.b[0] - wall.a[0]) / length]
      const mid: Point = [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2]
      if ((centre[0] - mid[0]) * n[0] + (centre[1] - mid[1]) * n[1] > 0) n = [-n[0], -n[1]]
      const near = (eye[0] - mid[0]) * n[0] + (eye[1] - mid[1]) * n[1] > 0.05
      if (walls === 'low') cutTo(child, near ? floor + STRIP : Infinity, 'full', floor)
      // Doors and windows in a glass wall stay, so you see where they are.
      else cutTo(child, Infinity, near ? 'glass' : 'full', floor)
      continue
    }
    if (overlays.has(child)) child.visible = false
    else if (rooms.has(child.name)) child.visible = child.name === roomId
    else if (itemRoom.has(child.name)) child.visible = itemRoom.get(child.name) === roomId
    else if (child.userData.object) child.visible = objectsIn(scene, built, roomId).has(child)
  }
}

// Free objects standing in the room: given to it, or standing on its floor.
let objectsCache: { built: Built; roomId: string; objects: Set<THREE.Object3D> } | undefined
function objectsIn(scene: Scene, built: Built, roomId: string): Set<THREE.Object3D> {
  if (objectsCache?.built === built && objectsCache.roomId === roomId) return objectsCache.objects
  const objects = new Set<THREE.Object3D>()
  for (const child of built.root.children) {
    if (!child.userData.object) continue
    const given = scene.objects.find((o) => o.id === child.name)?.room
    const p = child.position
    if (given ? given === roomId : roomUnder(scene, [p.x, -p.z], p.y + 0.05) === roomId) objects.add(child)
  }
  objectsCache = { built, roomId, objects }
  return objects
}
