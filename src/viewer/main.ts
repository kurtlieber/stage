import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { findAsset } from '../core/assets.ts'
import { check, type Problem } from '../core/check.ts'
import { findCamera } from '../core/cameras.ts'
import { bounds, centroid, levelsByElevation, pointInPolygon, roomElevation, roomHeight, sceneBounds, storeys, type Point } from '../core/geometry.ts'
import { STEP, ground, obstacles, resolve as resolveWalk, type Obstacles } from '../core/walk.ts'
import { SKY } from '../core/materials.ts'
import { roomFacts, roomName, roomUnder, stepRoom } from '../core/room-facts.ts'
import type { Scene } from '../core/schema.ts'
import { formatLength, formatSize, type Units } from '../core/units.ts'
import { applyCutaway, buildScene, floorMaterial, toWorld, type Built } from './build.ts'
import { useSurfaces } from './furniture.ts'
import { loadLibrary, loadSky, progress, settled, type Sky } from './library.ts'
import { applyRoomMode, leaveRoomMode, type Walls } from './room-mode.ts'
import { renderRoomPanel } from './room-panel.ts'
import { speckle } from './textures.ts'

// The viewer. The same page serves a person in a browser and the command
// line's headless renders (?headless), so the agent and the person always
// see the same pixels.

const params = new URLSearchParams(location.search)
// Opened without a scene, the page is a share bundle: the scene, library,
// and files sit beside it, and nothing is live.
const bundled = !params.get('scene')
const scenePath = params.get('scene') ?? 'scene.json'
const headless = params.has('headless')
if (bundled) document.body.dataset.bundle = '1'
const BUILD = document.querySelector<HTMLMetaElement>('meta[name="stage-build"]')?.content ?? ''
const $ = (id: string) => document.getElementById(id)!
if (headless) document.body.classList.add('headless')

// Eye height and lens for walking: a 1.75 m adult's eyes, and about a 24 mm
// lens, which reads as natural on a screen without stretching the room.
const EYE = 1.6
const WALK_FOV = 58
const WALK_SPEED = 1.4
const RUN_SPEED = 3

const canvas = $('view') as HTMLCanvasElement
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: headless })
renderer.setPixelRatio(headless ? 1 : Math.min(window.devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.1
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.shadowMap.autoUpdate = false
// Room mode cuts the doors and windows in a low wall at the strip.
renderer.localClippingEnabled = true

const world = new THREE.Scene()
const pmrem = new THREE.PMREMGenerator(renderer)
world.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
// Low: a bright studio reflection washes floors out at low angles.
world.environmentIntensity = 0.18
const hemisphere = new THREE.HemisphereLight('#e3ecf7', '#8d8270', 0.9)
// Room lights come from a small pool that follows the camera: the few
// fixtures nearest you are lit. A fixed count keeps the shaders compiled
// once; a light per room would put seventy lights in every one.
const LIGHT_POOL = 6
const lightPool = Array.from({ length: LIGHT_POOL }, () => {
  const light = new THREE.PointLight('#ffe6c4', 0, 0, 2)
  world.add(light)
  return light
})
let lightsPlaced = 0
function placeLights(now: number) {
  if (!built || now - lightsPlaced < 150) return
  lightsPlaced = now
  const eye = perspective.position
  const nearest = built.fixtures
    .filter((f) => f.level <= reach(cap) && Math.abs(f.position.y - eye.y) < 4.5)
    .map((f) => ({ f, d: f.position.distanceToSquared(eye) }))
    .sort((p, q) => p.d - q.d)
    .slice(0, LIGHT_POOL)
  lightPool.forEach((light, i) => {
    const pick = nearest[i]
    if (!pick || !inside) {
      light.intensity = 0
      return
    }
    light.position.copy(pick.f.position)
    light.intensity = pick.f.intensity
  })
}

// The sun's shadows are drawn again only when something changed: a
// rebuild, a level shown or hidden, a ceiling appearing. Walking around
// moves nothing, so every frame reuses them.
function shadowsChanged() {
  renderer.shadowMap.needsUpdate = true
}
world.add(hemisphere)
// A drawn gradient until the photographed sky loads.
const dome = sky()
world.add(dome)
const lawnMesh = lawn()
world.add(lawnMesh)

function sky(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      zenith: { value: new THREE.Color('#6f9ccf') },
      horizon: { value: new THREE.Color('#e6edf2') },
      below: { value: new THREE.Color('#b4bfa6') },
    },
    vertexShader: 'varying vec3 vDirection; void main() { vDirection = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader:
      'uniform vec3 zenith; uniform vec3 horizon; uniform vec3 below; varying vec3 vDirection; void main() { float h = vDirection.y; vec3 c = h > 0.0 ? mix(horizon, zenith, pow(h, 0.55)) : mix(horizon, below, pow(-h, 0.35)); gl_FragColor = vec4(c, 1.0); \n#include <colorspace_fragment>\n }',
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(420, 32, 16), material)
  mesh.renderOrder = -1
  return mesh
}

// A lawn with UVs in meters, so its texture reads at real size.
function lawn(): THREE.Mesh {
  const size = 300
  const geometry = new THREE.PlaneGeometry(size, size)
  const uv = geometry.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * size, uv.getY(i) * size)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: speckle('#7c9160', 2, 0.1, 5), roughness: 1 }))
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = -0.02
  mesh.receiveShadow = true
  return mesh
}

const perspective = new THREE.PerspectiveCamera(WALK_FOV, 1, 0.05, 900)
const plan = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500)
let active: THREE.Camera = perspective
const orbit = new OrbitControls(perspective, canvas)
// The glide after a drag is motion the person didn't ask for.
orbit.enableDamping = !headless && !matchMedia('(prefers-reduced-motion: reduce)').matches
orbit.maxPolarAngle = Math.PI * 0.495
// First-person looking: a yaw and a pitch the mouse (locked, or dragged),
// the arrow keys, or a touch turn. No pointer lock is needed; it is used
// when the browser grants it, for the smoothest look.
let yaw = 0
let pitch = 0
// The place the person is at or was last sent to, for the menu and for
// next and previous.
let currentPlace: string | undefined
const locked = () => document.pointerLockElement === canvas
function applyLook() {
  perspective.rotation.set(pitch, yaw, 0, 'YXZ')
}
function lookFrom(from: THREE.Vector3, to: THREE.Vector3) {
  const d = to.clone().sub(from)
  yaw = Math.atan2(-d.x, -d.z)
  pitch = Math.max(-1.4, Math.min(1.4, Math.atan2(d.y, Math.hypot(d.x, d.z))))
  applyLook()
}
function turn(dx: number, dy: number) {
  yaw -= dx * 0.0025
  pitch = Math.max(-1.4, Math.min(1.4, pitch - dy * 0.0025))
  applyLook()
}

// Ambient occlusion: the darkening where walls meet floors and under
// furniture, which direct light alone never gives. Perspective views only.
const composer = new EffectComposer(renderer)
const renderPass = new RenderPass(world, perspective)
const ao = new GTAOPass(world, perspective, 1280, 720)
ao.updateGtaoMaterial({ radius: 0.3, distanceExponent: 2, thickness: 0.6, scale: 1, samples: 16 })
ao.blendIntensity = 0.85
composer.addPass(renderPass)
composer.addPass(ao)
composer.addPass(new OutputPass())

// High quality until frames get slow (a machine without a GPU), then fast:
// no ambient occlusion, one pixel per pixel. F switches by hand.
let quality: 'high' | 'fast' = params.get('quality') === 'fast' ? 'fast' : 'high'
let slowFrames = 0
function setQuality(next: 'high' | 'fast', why: string) {
  quality = next
  slowFrames = 0
  renderer.setPixelRatio(headless || next === 'fast' ? 1 : Math.min(window.devicePixelRatio, 2))
  resize()
  setStatus(why)
}

let skyImage: Sky | undefined
async function applySky() {
  skyImage = await loadSky(SKY)
  if (!skyImage) return
  world.remove(dome)
  world.background = skyImage.texture
  world.environment = pmrem.fromEquirectangular(skyImage.texture).texture
  alignSky()
  applyView(view, $('camera').textContent ?? '')
}

// Turns the photographed sky so its sun stands where the scene's sun does,
// and the light from the sky agrees with the shadows.
function alignSky() {
  if (!skyImage || !scene) return
  const sun = scene.lights.find((light) => light.type === 'sun')
  const azimuth = THREE.MathUtils.degToRad(sun?.azimuth ?? 220)
  const turn = skyImage.sunAngle - Math.atan2(-Math.cos(azimuth), Math.sin(azimuth))
  world.environmentRotation.y = turn
  world.backgroundRotation.y = turn
}

// What the camera is doing. The person sees four modes (GLOSSARY.md):
// Plan is 'plan', Room is 'room', Walk is 'walk', and House is the
// overview, 'orbit', along with the two views the agent sets, a named
// camera and a thing framed close up.
type View = 'orbit' | 'plan' | 'camera' | 'walk' | 'focus' | 'room'
type Mode = 'plan' | 'house' | 'room' | 'walk'
const modeOf = (v: View): Mode => (v === 'plan' || v === 'room' || v === 'walk' ? v : 'house')
let view: View = 'orbit'
let scene: Scene | undefined
// Levels from the lowest up, and the highest one shown: everything above
// it is hidden, so an overview or a plan looks into that floor.
let levels: Scene['levels'] = []
// Each level's storey, by its index in levels.
let storeyIndex: number[] = []
let cap = Infinity
let planLevel = 0
let built: Built | undefined
let previous = new Map<string, string>()
const highlights: { helper: THREE.BoxHelper; until: number }[] = []
let labelsOn = true
let selected: string | undefined
let lastUpdate = 0
// The room every mode centres on: picked by the person, or in Walk mode the
// room they stand in.
let currentRoom: string | undefined
// The person's own settings, kept in this browser between visits: how Room
// mode opens the near walls, and the units every number is printed in.
let walls: Walls = setting('walls', ['low', 'glass'], 'low')
let units: Units = setting('units', ['m', 'ft'], 'm')
// The camera's move from one view to the next.
let flight: { from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; fromFov: number; toFov: number; start: number } | undefined
// Whether the first view is up, so later moves fly to the next one.
let landed = false

function setting<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  let value = params.get(name)
  if (value === null && !headless) {
    try {
      value = localStorage.getItem(`stage:${name}`)
    } catch {}
  }
  return allowed.includes(value as T) ? (value as T) : fallback
}
function keepSetting(name: string, value: string) {
  try {
    localStorage.setItem(`stage:${name}`, value)
  } catch {}
}

function resize() {
  const width = headless ? Number(params.get('w') ?? 1280) : window.innerWidth
  const height = headless ? Number(params.get('h') ?? 720) : window.innerHeight
  renderer.setSize(width, height, !headless)
  composer.setPixelRatio(renderer.getPixelRatio())
  composer.setSize(width, height)
  perspective.aspect = width / height
  perspective.updateProjectionMatrix()
  fitPlan()
}
window.addEventListener('resize', resize)

function fitPlan() {
  if (!scene) return
  const b = sceneBounds(scene)
  // The top of the plan's storey, split levels and all.
  const level = levels[Math.min(reach(planLevel), levels.length - 1)]
  const margin = 1
  const cx = (b.min[0] + b.max[0]) / 2
  const cy = (b.min[1] + b.max[1]) / 2
  let halfW = (b.max[0] - b.min[0]) / 2 + margin
  let halfH = (b.max[1] - b.min[1]) / 2 + margin
  if (halfW / halfH > perspective.aspect) halfH = halfW / perspective.aspect
  else halfW = halfH * perspective.aspect
  plan.left = -halfW
  plan.right = halfW
  plan.top = halfH
  plan.bottom = -halfH
  // Just above the level's ceiling; the levels above are hidden anyway.
  const top = level ? level.elevation + level.height + 3 : 50
  plan.position.copy(toWorld([cx, cy], top))
  plan.near = 0.1
  plan.far = top + 20
  plan.up.set(0, 0, -1)
  plan.lookAt(toWorld([cx, cy], 0))
  plan.updateProjectionMatrix()
}

// Hides everything on levels above the cap, and shows the plan drawing
// of the level a plan view looks at.
function applyLevelCap() {
  if (!built) return
  shadowsChanged()
  const shown = reach(cap)
  const show = (object: THREE.Object3D) => {
    const level = object.userData.level as number | undefined
    if (level !== undefined) object.visible = level <= shown
  }
  for (const child of built.root.children) if (!child.userData.wall) show(child)
  // A plan labels its own storey; the overview labels the highest storey it
  // shows, so a tall house isn't buried in tags. A storey's split levels
  // count as one.
  const top = storeyOf(view === 'plan' ? planLevel : Math.min(cap, levels.length - 1))
  for (const label of built.labels.children) {
    const level = label.userData.level as number | undefined
    label.visible = level === undefined || storeyOf(level) === top
  }
  for (const [id, overlay] of built.overlays) overlay.visible = view === 'plan' && storeyOf(levelIndexOf(id) ?? -1) === storeyOf(planLevel)
  const select = document.querySelector<HTMLSelectElement>('#levels')
  if (select) select.value = String(Math.min(cap, levels.length - 1))
}

function storeyOf(index: number): number {
  return storeyIndex[index] ?? index
}

// The highest level a cap shows: the top of the cap's storey, so a split
// level a few steps up shows with the rest of its floor.
function reach(index: number): number {
  if (index === Infinity) return Infinity
  const storey = storeyIndex[index]
  return storey === undefined ? index : storeyIndex.lastIndexOf(storey)
}

function levelIndexOf(id: string | null | undefined): number | undefined {
  if (!id) return undefined
  const index = levels.findIndex((l) => l.id === id)
  return index >= 0 ? index : undefined
}

function setCap(index: number) {
  cap = index >= levels.length - 1 ? Infinity : Math.max(0, index)
  if (view === 'plan') {
    planLevel = Math.min(index, levels.length - 1)
    fitPlan()
    $('camera').textContent = planLabel()
  }
  applyLevelCap()
}

function planLabel(): string {
  return levels.length > 1 ? `Plan · ${levels[planLevel]?.name ?? levels[planLevel]?.id}` : 'Plan'
}

// What each view shows: ceilings and room lights inside, room labels and
// the dollhouse cutaway from above.
// Labels float over the things they name; in a picture framed on one
// thing they would cover it, so they step aside for those views.
function applyLabelVisibility(view: View, label: string) {
  if (!built) return
  const inspecting = view === 'camera' && label.startsWith('camera: object:')
  built.root.traverse((o) => {
    if (o.userData.objectLabel) o.visible = !inspecting
  })
}

function applyView(next: View, label: string) {
  if (next !== view) flight = undefined
  if (view === 'room' && next !== 'room') leaveRoomMode()
  roomControls(next === 'room')
  applyLabelVisibility(next, label)
  view = next
  if (built) built.labels.visible = labelsOn && (view === 'plan' || view === 'orbit')
  if (built) for (const roof of built.roofs) roof.visible = view === 'walk' || view === 'camera'
  inside = undefined
  $('camera').textContent = label
  const mode = modeOf(view)
  document.body.classList.toggle('walking', view === 'walk')
  document.body.dataset.mode = mode
  applyLevelCap()
  for (const button of document.querySelectorAll<HTMLButtonElement>('#modes button')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
  for (const button of document.querySelectorAll<HTMLButtonElement>('#menu button[data-place]')) button.classList.toggle('active', view === 'walk' && button.dataset.place === currentPlace)
  showModeHint()
}

// Whether the camera stands inside a room, below its ceiling: that, not the
// chosen view, decides ceilings, room lights, and how much sky light there
// is, so orbiting up out of a room or out through a window just works.
let inside: boolean | undefined
function updateInside() {
  if (!built || !scene) return
  const p = perspective.position
  const room =
    active === perspective
      ? scene.rooms.find((r) => {
          if (r.open || !pointInPolygon([p.x, -p.z], r.floor)) return false
          const floor = roomElevation(scene!, r)
          return p.y > floor - 0.3 && p.y < floor + roomHeight(scene!, r) - 0.02
        })
      : undefined
  const now = !!room
  if (now === inside) return
  inside = now
  for (const object of built.indoor) object.visible = now
  shadowsChanged()
  // Outside, the sky fills the house; inside, windows and room lights do
  // the work, and sky light that would leak through the walls is cut.
  hemisphere.intensity = skyImage ? (now ? 0.5 : 0.45) : now ? 0.55 : 0.9
  world.environmentIntensity = skyImage ? (now ? 0.55 : 0.85) : 0.18
}

interface Pose {
  position: THREE.Vector3
  target: THREE.Vector3
  fov: number
}

// The whole house: from the southwest, high enough to see into every room,
// or from the side given, at the same height.
function overviewPose(side?: THREE.Vector3): Pose | undefined {
  if (!scene) return undefined
  const b = sceneBounds(scene)
  const cx = (b.min[0] + b.max[0]) / 2
  const cy = (b.min[1] + b.max[1]) / 2
  const top = levels[Math.min(levels.length - 1, cap)] ?? levels.at(-1)
  const height = top ? top.elevation + top.height : 3
  const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], height * 1.6, 4)
  const target = toWorld([cx, cy], Math.min(height / 2, 2))
  const direction = side ? side.clone().setY(0).setLength(Math.hypot(0.42, 0.66)).setY(0.8).normalize() : new THREE.Vector3(-0.42, 0.8, 0.66).normalize()
  return { position: target.clone().add(direction.multiplyScalar(size * 1.35)), target, fov: 40 }
}

function overview() {
  const pose = overviewPose()
  if (!pose) return
  perspective.fov = pose.fov
  perspective.updateProjectionMatrix()
  orbit.target.copy(pose.target)
  perspective.position.copy(pose.position)
}

function useCamera(id: string) {
  if (!scene) return
  if (locked()) document.exitPointerLock()
  rememberWalk()
  // "plan:first" or "orbit:first" looks at that level and the ones below.
  // "room:kitchen" is one camera; "plan:first" is the plan of a level.
  const [name, levelId] = id.startsWith('room:') || id.startsWith('object:') ? [id, undefined] : id.split(':')
  const camera = findCamera(scene, name)
  const wanted = levelIndexOf(levelId ?? camera?.level)
  if (id.startsWith('object:') && camera?.at && camera.look) {
    // Framed on a thing, from the same place the agent's render is.
    active = perspective
    orbit.enabled = true
    perspective.fov = camera.fov
    perspective.updateProjectionMatrix()
    perspective.position.copy(toWorld([camera.at[0], camera.at[1]], camera.at[2]))
    orbit.target.copy(toWorld([camera.look[0], camera.look[1]], camera.look[2]))
    orbit.update()
    applyView('camera', `camera: ${id}`)
    return
  }
  if (name === 'plan' || camera?.type === 'plan') {
    active = plan
    orbit.enabled = false
    view = 'plan'
    planLevel = wanted ?? (cap === Infinity ? levels.length - 1 : Math.min(cap, levels.length - 1))
    cap = planLevel >= levels.length - 1 ? Infinity : planLevel
    fitPlan()
    applyView('plan', planLabel())
    return
  }
  active = perspective
  orbit.enabled = true
  if (name === 'orbit' || !camera?.at || !camera.look) {
    if (wanted !== undefined) cap = wanted >= levels.length - 1 ? Infinity : wanted
    overview()
    applyView('orbit', 'House')
  } else if (!headless) {
    // A person goes to the place and stands there, feet on the floor.
    walkTo(camera.id)
    return
  } else {
    perspective.fov = camera.fov
    perspective.updateProjectionMatrix()
    perspective.position.copy(toWorld([camera.at[0], camera.at[1]], camera.at[2]))
    orbit.target.copy(toWorld([camera.look[0], camera.look[1]], camera.look[2]))
    applyView('camera', `camera: ${id}`)
  }
  orbit.update()
}

// ---- Modes and the current room ---------------------------------------------

const reducedMotion = () => !headless && matchMedia('(prefers-reduced-motion: reduce)').matches

// Moves the camera to a pose: a short flight between two views from
// outside, a cut everywhere else and for a person who asks for less motion.
function flyTo(pose: Pose, smooth: boolean) {
  if (!smooth || headless || reducedMotion()) {
    flight = undefined
    perspective.fov = pose.fov
    perspective.updateProjectionMatrix()
    perspective.position.copy(pose.position)
    orbit.target.copy(pose.target)
    orbit.update()
    return
  }
  flight = { from: perspective.position.clone(), to: pose.position, fromTarget: orbit.target.clone(), toTarget: pose.target, fromFov: perspective.fov, toFov: pose.fov, start: performance.now() }
}

// One frame of a flight: seven tenths of a second, easing in and out.
function fly(now: number) {
  if (!flight) return
  const t = Math.min(1, (now - flight.start) / 700)
  const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2
  perspective.position.lerpVectors(flight.from, flight.to, e)
  orbit.target.lerpVectors(flight.fromTarget, flight.toTarget, e)
  perspective.fov = flight.fromFov + (flight.toFov - flight.fromFov) * e
  perspective.updateProjectionMatrix()
  perspective.lookAt(orbit.target)
  if (t >= 1) flight = undefined
}

// Whether the camera now circles from outside, so a move to another such
// view can fly.
const circling = () => landed && active === perspective && (view === 'orbit' || view === 'focus' || view === 'room')

// Room mode lets the camera in close, to an outlet on the far wall, and
// zooms toward the pointer rather than the room's middle.
function roomControls(on: boolean) {
  orbit.minDistance = on ? 0.2 : 0
  orbit.zoomToCursor = on
}

function setMode(mode: Mode) {
  if (!scene) return
  if (mode === 'plan') useCamera(currentRoom ? `plan:${scene.rooms.find((r) => r.id === currentRoom)?.level ?? ''}` : 'plan')
  else if (mode === 'house') showHouse()
  else if (mode === 'room') enterRoom(currentRoom ?? scene.rooms[0]?.id)
  else if (view !== 'walk') startWalk()
}

function showHouse() {
  if (!scene) return
  if (locked()) document.exitPointerLock()
  rememberWalk()
  const side = view === 'room' ? perspective.position.clone().sub(orbit.target).setY(0) : undefined
  const pose = overviewPose(side && side.lengthSq() > 0.01 ? side : undefined)
  if (!pose) return
  const smooth = circling()
  active = perspective
  orbit.enabled = true
  applyView('orbit', 'House')
  flyTo(pose, smooth)
}

// Room mode: the current room alone, circled around its middle from
// outside and above, close enough in to see an outlet, 20 cm at the
// nearest.
function enterRoom(id: string | undefined) {
  if (!scene || !built || !id) return
  const room = scene.rooms.find((r) => r.id === id)
  if (!room) return
  if (locked()) document.exitPointerLock()
  rememberWalk()
  // The sphere around the look point that holds the floor and the walls'
  // full height, since the far walls stand.
  const b = bounds(room.floor)
  const half = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2
  const radius = Math.max(1.5, Math.hypot(half, roomHeight(scene, room) - 0.6))
  const target = toWorld(centroid(room.floor), roomElevation(scene, room) + 0.6)
  // Keep the side the person looks from; from elsewhere, start from the
  // southwest like the house.
  const smooth = circling()
  const keep = smooth ? perspective.position.clone().sub(orbit.target).setY(0) : undefined
  const along = keep && keep.lengthSq() > 0.01 ? keep.normalize() : new THREE.Vector3(-0.6, 0, 0.8)
  // Far enough back that the whole room fits the picture, looking down at
  // about 48 degrees.
  const distance = (radius / Math.sin(THREE.MathUtils.degToRad(45 / 2))) * 1.1
  const position = target.clone().add(along.multiplyScalar(0.67).add(new THREE.Vector3(0, 0.74, 0)).normalize().multiplyScalar(distance))
  active = perspective
  orbit.enabled = true
  setCurrentRoom(id)
  applyView('room', `Room · ${roomName(room)}`)
  flyTo({ position, target, fov: 45 }, smooth)
  select(undefined)
}

function setCurrentRoom(id: string | undefined) {
  if (id === currentRoom) return
  currentRoom = id
  showCurrentRoom()
}

// Everything that shows the current room: the room panel, the mark on its
// floor, and the room list.
function showCurrentRoom() {
  renderRoomPanel($('room-panel'), scene, currentRoom, units, { goToRoom, walkTo, placeName, setUnits })
  markRoom()
  for (const button of document.querySelectorAll<HTMLButtonElement>('#menu button[data-room]')) {
    if (button.dataset.room !== currentRoom) button.removeAttribute('aria-current')
    else {
      button.setAttribute('aria-current', 'true')
      button.scrollIntoView({ block: 'nearest' })
    }
  }
}

// A click in Plan or House mode picks a room without leaving the mode. A
// plan turns to the room's own floor.
function pickRoom(id: string) {
  setCurrentRoom(id)
  const index = levelIndexOf(scene?.rooms.find((r) => r.id === id)?.level)
  if (view === 'plan' && index !== undefined && storeyOf(index) !== storeyOf(planLevel)) useCamera(`plan:${levels[index].id}`)
}

// Going to a room, from the list, a door in the room panel, previous and
// next, or a double-click: House mode opens it in Room mode; Plan, Room and
// Walk modes stay as they are and go to it.
function goToRoom(id: string | undefined) {
  if (!scene || !id || !scene.rooms.some((r) => r.id === id)) return
  const mode = modeOf(view)
  if (mode === 'plan') pickRoom(id)
  else if (mode === 'walk') walkIntoRoom(id)
  else enterRoom(id)
}

// Standing in a room: at its first place, else a step in from its far
// corner looking across it, else in its middle.
function walkIntoRoom(id: string) {
  const room = scene?.rooms.find((r) => r.id === id)
  if (!scene || !room) return
  setCurrentRoom(id)
  const place = roomFacts(scene, id)?.places[0]
  const corner = findCamera(scene, `room:${id}`)
  if (place) walkTo(place)
  else if (corner?.at && corner.look) beginWalk([corner.at[0], corner.at[1]], roomElevation(scene, room), toWorld([corner.look[0], corner.look[1]], corner.look[2]))
  else beginWalk(pointInside(room.floor), roomElevation(scene, room))
}

// A point inside a floor: its middle, or for an L or a U, which may not
// hold its middle, the first point halfway to a corner that is inside.
function pointInside(floor: Point[]): Point {
  const middle = centroid(floor)
  if (pointInPolygon(middle, floor)) return middle
  for (const corner of floor) {
    const p: Point = [(corner[0] + middle[0]) / 2, (corner[1] + middle[1]) / 2]
    if (pointInPolygon(p, floor)) return p
  }
  return floor[0]
}

// In Walk mode the current room is the one underfoot, looked up a few
// times a second. Outside, it stays the last room walked through.
let followed = 0
function followRoom(now: number) {
  if (!scene || now - followed < 250) return
  followed = now
  const id = roomUnder(scene, [perspective.position.x, -perspective.position.z], foot + 0.05)
  if (id) setCurrentRoom(id)
}

// The current room marked on its floor in Plan and House modes: a tint and
// an edge, the edge as flat strips since lines draw one pixel wide. A plan
// draws it over the drawing; the house, under its walls.
const MARK = new THREE.MeshBasicMaterial({ color: '#e8b43a', transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 })
const MARK_EDGE = new THREE.MeshBasicMaterial({ color: '#e8b43a', side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 })
function showMark() {
  marker.visible = (view === 'plan' || view === 'orbit') && (marker.userData.level ?? 0) <= reach(view === 'plan' ? planLevel : cap)
  MARK.depthTest = MARK_EDGE.depthTest = view !== 'plan'
}
const marker = new THREE.Group()
world.add(marker)
function markRoom() {
  for (const child of marker.children) (child as THREE.Mesh).geometry.dispose()
  marker.clear()
  const room = scene?.rooms.find((r) => r.id === currentRoom)
  if (!scene || !room) return
  const y = roomElevation(scene, room) + 0.03
  const fill = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(room.floor.map(([x, z]) => new THREE.Vector2(x, z)))), MARK)
  fill.rotation.x = -Math.PI / 2
  fill.position.y = y
  fill.renderOrder = 10
  marker.add(fill)
  room.floor.forEach((a, i) => {
    const b = room.floor[(i + 1) % room.floor.length]
    const edge = new THREE.Mesh(new THREE.PlaneGeometry(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.12), MARK_EDGE)
    edge.renderOrder = 11
    edge.rotation.set(-Math.PI / 2, 0, Math.atan2(b[1] - a[1], b[0] - a[0]))
    edge.position.copy(toWorld([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], y + 0.005))
    marker.add(edge)
  })
  marker.userData.level = levelIndexOf(room.level) ?? 0
}

// The room under a point on the screen, in Plan and House modes.
function roomAtPointer(event: MouseEvent): string | undefined {
  if (!scene) return undefined
  const hit = hitsAt(event)[0]
  return hit ? roomUnder(scene, [hit.point.x, -hit.point.z], hit.point.y + 0.05) : undefined
}

function setWalls(next: Walls) {
  walls = next
  keepSetting('walls', next)
  showModeHint()
  setStatus(`Room mode walls: ${next === 'low' ? 'cut low' : 'glass'}.`)
}

function setUnits(next: Units) {
  units = next
  keepSetting('units', next)
  showCurrentRoom()
  describe(selected)
  setStatus(`Numbers in ${next === 'm' ? 'meters' : 'feet and inches'}.`)
}

// One line on how to get around in the mode the person is in. Room mode's
// also holds the switch for its walls.
const HINTS: Record<Mode, string> = {
  plan: 'Click a room to pick it, double-click to open it · <kbd>[</kbd> <kbd>]</kbd> level down or up · <kbd>N</kbd> <kbd>B</kbd> next or previous room',
  house: 'Drag or arrow keys to circle · scroll or <kbd>+</kbd> <kbd>−</kbd> to zoom · click a room to pick it, double-click to open it',
  room: 'Drag or arrow keys to circle · scroll or <kbd>+</kbd> <kbd>−</kbd> to zoom · <kbd>N</kbd> <kbd>B</kbd> next or previous room',
  walk: '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · drag or <kbd>←</kbd> <kbd>→</kbd> to turn · double-click to lock the mouse · <kbd>N</kbd> <kbd>B</kbd> next or previous room',
}
function showModeHint() {
  const mode = modeOf(view)
  const hint = $('mode-hint')
  const refocus = hint.contains(document.activeElement)
  hint.innerHTML = HINTS[mode]
  if (mode !== 'room') return
  const group = document.createElement('span')
  group.className = 'walls'
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'Walls')
  group.append('Walls ')
  for (const [value, text] of [['low', 'Low'], ['glass', 'Glass']] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = text
    button.title = value === 'low' ? 'Near walls cut low (G)' : 'Near walls of glass (G)'
    button.setAttribute('aria-pressed', String(walls === value))
    button.addEventListener('click', () => setWalls(value))
    group.append(button)
  }
  hint.prepend(group, ' · ')
  if (refocus) group.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus()
}

function showHelp(show: boolean) {
  $('help').classList.toggle('hidden', !show)
  $('help-toggle').setAttribute('aria-expanded', String(show))
}
$('help-toggle').addEventListener('click', () => showHelp($('help').classList.contains('hidden')))

// Circling and zooming from the keyboard in House and Room modes: the
// arrows go around the middle and over it, + and − go nearer and farther.
const spherical = new THREE.Spherical()
function keyOrbit(delta: number) {
  const around = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0)
  const over = (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0)
  if (around === 0 && over === 0) return
  const offset = perspective.position.clone().sub(orbit.target)
  spherical.setFromVector3(offset)
  spherical.theta += around * 1.4 * delta
  spherical.phi = THREE.MathUtils.clamp(spherical.phi + over * 0.9 * delta, 0.05, orbit.maxPolarAngle)
  perspective.position.copy(orbit.target).add(offset.setFromSpherical(spherical))
}
function zoomBy(factor: number) {
  if (!orbit.enabled || active !== perspective) return
  flight = undefined
  const offset = perspective.position.clone().sub(orbit.target)
  offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, Math.max(orbit.minDistance, 0.2), orbit.maxDistance))
  perspective.position.copy(orbit.target).add(offset)
}

// ---- Walking --------------------------------------------------------------

let blocking: Obstacles = { walls: [], solids: [], floors: [], stairs: [] }
// Where the feet are: the floor or stair under the person, in meters.
let foot = 0
let eyeHeight = EYE
const resolve = (p: Point) => resolveWalk(p, blocking, undefined, foot)

function insideAnyRoom(p: Point): boolean {
  return !!scene?.rooms.some((room) => pointInPolygon(p, room.floor))
}

// The floor nearest a height, for a person arriving from a camera.
function standOn(p: Point, near: number): number {
  let best = near
  let gap = Infinity
  for (const f of blocking.floors) {
    const d = Math.abs(f.elevation - near)
    if (d < gap && pointInPolygon(p, f.polygon)) {
      best = f.elevation
      gap = d
    }
  }
  return best
}

// Where the person last stood, so leaving for the overview and coming
// back continues the walk.
let lastWalk: { position: THREE.Vector3; yaw: number; pitch: number; foot: number; flying: boolean } | undefined
// The up and down arrows lift and lower the person, free of the floor,
// until they come back down onto one: the third axis, for looking at a
// roof, a tall thing, or the whole scene from a chosen spot.
let flying = false

function beginWalk(at: Point, z: number, lookAt?: THREE.Vector3, label = 'walk') {
  if (!scene) return
  if (orbit.enabled) orbit.enabled = false
  active = perspective
  perspective.fov = WALK_FOV
  perspective.updateProjectionMatrix()
  velocity.set(0, 0)
  foot = standOn(at, z)
  perspective.position.copy(toWorld(resolve(at), foot + EYE))
  eyeHeight = foot + EYE
  if (lookAt) lookFrom(perspective.position, lookAt)
  else applyLook()
  currentPlace = label === 'walk' ? currentPlace : label
  applyView('walk', label === 'walk' ? 'Walk' : `Walk · ${placeName(label)}`)
}

// Stand at a place the scene names, looking where its camera looks.
function walkTo(id: string) {
  const camera = scene ? findCamera(scene, id) : undefined
  if (!camera?.at || !camera.look) return
  beginWalk([camera.at[0], camera.at[1]], camera.at[2] - EYE, toWorld([camera.look[0], camera.look[1]], camera.look[2]), id)
}

// Walk: from where you left off if that is in the current room, else into
// the current room, else from the first place, else from the middle of the
// first room.
function startWalk() {
  if (!scene) return
  if (view === 'walk') {
    canvas.requestPointerLock?.()
    return
  }
  if (lastWalk && (!currentRoom || roomUnder(scene, [lastWalk.position.x, -lastWalk.position.z], lastWalk.foot + 0.05) === currentRoom)) {
    yaw = lastWalk.yaw
    pitch = lastWalk.pitch
    beginWalk([lastWalk.position.x, -lastWalk.position.z], lastWalk.foot)
    if (lastWalk.flying) {
      flying = true
      foot = lastWalk.foot
      eyeHeight = foot + EYE
      perspective.position.y = eyeHeight
    }
    return
  }
  if (currentRoom) return walkIntoRoom(currentRoom)
  const camera = scene.cameras.find((c) => c.type === 'perspective' && c.at && c.look)
  if (camera) walkTo(camera.id)
  else if (scene.rooms.length > 0) beginWalk(centroid(scene.rooms[0].floor), roomElevation(scene, scene.rooms[0]))
  else {
    // No rooms: stand south of everything, looking at the middle of it.
    const b = sceneBounds(scene)
    const middle: Point = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
    beginWalk([middle[0], b.min[1] - 2.5], 0, toWorld(middle, 1.0))
  }
}

function rememberWalk() {
  if (view === 'walk') lastWalk = { position: perspective.position.clone(), yaw, pitch, foot, flying }
}

const keys = new Set<string>()
// Meters per second in plan; it eases toward what the keys ask for, so
// starting and stopping feel like a person, not a switch.
const velocity = new THREE.Vector2()
function walkStep(delta: number) {
  const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED
  // Arrow keys turn and look; Q and E turn too, for a hand on WASD.
  const turnRate = 1.8 * delta
  if (keys.has('ArrowLeft') || keys.has('KeyQ')) turn(-turnRate / 0.0025, 0)
  if (keys.has('ArrowRight') || keys.has('KeyE')) turn(turnRate / 0.0025, 0)
  if (keys.has('PageUp')) turn(0, -turnRate / 0.0025 / 2)
  if (keys.has('PageDown')) turn(0, turnRate / 0.0025 / 2)
  const forward = new THREE.Vector2(-Math.sin(yaw), Math.cos(yaw))
  const right = new THREE.Vector2(forward.y, -forward.x)
  let f = 0
  let r = 0
  if (keys.has('KeyW')) f += 1
  if (keys.has('KeyS')) f -= 1
  if (keys.has('KeyD')) r += 1
  if (keys.has('KeyA')) r -= 1
  // Up and down take off; the floor is left behind until it is met again.
  let lift = 0
  if (keys.has('ArrowUp')) lift += 1
  if (keys.has('ArrowDown')) lift -= 1
  if (lift !== 0) {
    flying = true
    foot = Math.max(-0.5, foot + lift * speed * delta)
  }
  const wanted = forward.multiplyScalar(f).add(right.multiplyScalar(r))
  if (wanted.lengthSq() > 0) wanted.setLength(speed)
  velocity.lerp(wanted, 1 - Math.exp(-delta * 10))
  if (velocity.lengthSq() < 1e-5) velocity.set(0, 0)
  if (velocity.lengthSq() === 0 && lift === 0 && !flying) return
  const here: Point = [perspective.position.x, -perspective.position.z]
  let next = velocity.lengthSq() === 0 ? here : resolve([here[0] + velocity.x * delta, here[1] + velocity.y * delta])
  const below = ground(next, blocking, foot)
  if (flying) {
    // Coming level with a floor, from above or along it, is a landing;
    // anywhere else is air, down to the ground at zero.
    if (below !== undefined && foot <= below + 0.05 && foot >= below - STEP && lift <= 0) {
      foot = below
      flying = false
    } else if (below === undefined && foot < 0) foot = 0
  } else if (below === undefined || Math.abs(below - foot) > STEP) {
    // Nothing to stand on, or a drop or climb bigger than a step: stay put.
    // A railing would stop you in a real house; here the edge itself does.
    next = here
    velocity.set(0, 0)
  } else {
    foot = below
  }
  // What the walls took away is gone from the velocity too, so pressing
  // into a wall doesn't build up speed that jerks you along when it ends.
  if (velocity.lengthSq() > 0) velocity.set((next[0] - here[0]) / delta, (next[1] - here[1]) / delta)
  // The eyes follow the feet with a little lag, so stairs feel like stairs
  // rather than a lift.
  eyeHeight += (foot + EYE - eyeHeight) * (1 - Math.exp(-delta * 14))
  perspective.position.set(next[0], eyeHeight, -next[1])
}

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) return
  keys.add(event.code)
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (event.code.startsWith('Arrow') || event.code === 'PageUp' || event.code === 'PageDown') event.preventDefault()
  const key = event.key.toLowerCase()
  // Zoom repeats while the key is held; the rest act once a press.
  if (key === '+' || key === '=') return zoomBy(0.85)
  if (key === '-' || key === '_') return zoomBy(1 / 0.85)
  if (event.repeat) return
  if (key === 'n' || key === 'b') goToRoom(scene && stepRoom(scene, currentRoom, key === 'n' ? 1 : -1))
  else if (key === 'c') cyclePlace(1)
  else if (key === 'p' || key === '1') setMode('plan')
  else if (key === 'h' || key === 'o' || key === '2') setMode('house')
  else if (key === 'r' || key === '3') setMode('room')
  else if (key === 'v') startWalk()
  else if (key === '4') setMode('walk')
  else if (key === 'g') setWalls(walls === 'low' ? 'glass' : 'low')
  else if (key === 'u') setUnits(units === 'm' ? 'ft' : 'm')
  else if (key === '[' || key === ']') setCap(Math.min(cap, levels.length - 1) + (key === ']' ? 1 : -1))
  else if (key === 'f') setQuality(quality === 'high' ? 'fast' : 'high', quality === 'high' ? 'Fast rendering: press F for high quality.' : 'High quality.')
  else if (key === 'l') {
    labelsOn = !labelsOn
    applyView(view, $('camera').textContent ?? '')
  } else if (event.key === '?') showHelp($('help').classList.contains('hidden'))
  else if (event.key === 'Escape') showHelp(false)
})
window.addEventListener('keyup', (event) => keys.delete(event.code))
window.addEventListener('blur', () => keys.clear())

// Looking around: the locked pointer, or a drag on the canvas. A double
// click asks for the pointer lock; Esc gives it back.
let dragging: { x: number; y: number; moved: number } | undefined
canvas.addEventListener('mousedown', (event) => {
  if (view !== 'walk' || locked() || event.button !== 0) return
  dragging = { x: event.clientX, y: event.clientY, moved: 0 }
})
window.addEventListener('mousemove', (event) => {
  if (view !== 'walk') return
  if (locked()) {
    turn(event.movementX, event.movementY)
  } else if (dragging) {
    turn(event.clientX - dragging.x, event.clientY - dragging.y)
    dragging.moved += Math.abs(event.clientX - dragging.x) + Math.abs(event.clientY - dragging.y)
    dragging.x = event.clientX
    dragging.y = event.clientY
  }
})
window.addEventListener('mouseup', () => {
  setTimeout(() => (dragging = undefined), 0)
})
// A double-click in Plan or House mode opens the room under it in Room mode.
canvas.addEventListener('dblclick', (event) => {
  if (view === 'walk') canvas.requestPointerLock?.()
  else if (view === 'plan' || modeOf(view) === 'house') enterRoom(roomAtPointer(event))
})
document.addEventListener('pointerlockchange', () => document.body.classList.toggle('locked', locked()))
let touch: { x: number; y: number } | undefined
canvas.addEventListener('touchstart', (event) => {
  if (view !== 'walk' || event.touches.length !== 1) return
  touch = { x: event.touches[0].clientX, y: event.touches[0].clientY }
}, { passive: true })
canvas.addEventListener('touchmove', (event) => {
  if (view !== 'walk' || !touch || event.touches.length !== 1) return
  turn(event.touches[0].clientX - touch.x, event.touches[0].clientY - touch.y)
  touch = { x: event.touches[0].clientX, y: event.touches[0].clientY }
}, { passive: true })

// The places a scene names, in file order, with the room each stands in.
function places(): { id: string; name: string; room?: string }[] {
  if (!scene) return []
  return scene.cameras.filter((c) => c.type === 'perspective' && c.at && c.look).map((c) => ({ id: c.id, name: placeName(c.id), room: roomUnder(scene!, [c.at![0], c.at![1]], c.at![2]) }))
}

function placeName(id: string): string {
  const room = id.startsWith('room:')
  return id.replace(/^room:/, '').replace(/-view$/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) + (room ? ' (room)' : '')
}

// Next or previous place, around and around.
function cyclePlace(step: number) {
  const list = places()
  if (list.length === 0) return
  const index = list.findIndex((p) => p.id === currentPlace)
  walkTo(list[(index + step + list.length) % list.length].id)
}

// The sidebar: which levels show, every room in the scene's order with
// previous and next, and the places that stand outside any room (a room's
// own places are in its panel).
function buildSidebar() {
  if (!scene) return
  const menu = $('menu')
  menu.replaceChildren()
  const button = (text: string, onClick: () => void, title?: string) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = text
    if (title) b.title = title
    b.addEventListener('click', onClick)
    return b
  }
  const heading = (text: string, className = 'section') => {
    const h = document.createElement('div')
    h.className = className
    h.textContent = text
    menu.append(h)
  }

  if (levels.length > 1) {
    heading('Levels')
    const select = document.createElement('select')
    select.id = 'levels'
    select.title = 'Show this level and the ones below it ([ and ] keys)'
    select.setAttribute('aria-label', 'Levels shown')
    levels.forEach((level, index) => {
      const option = document.createElement('option')
      option.value = String(index)
      option.textContent = index === levels.length - 1 ? 'All levels' : `Up to ${level.name ?? level.id}`
      select.append(option)
    })
    select.value = String(Math.min(cap, levels.length - 1))
    select.addEventListener('change', () => setCap(Number(select.value)))
    menu.append(select)
  }

  if (scene.rooms.length > 0) {
    heading('Rooms')
    const steps = document.createElement('div')
    steps.className = 'row'
    const step = (by: number) => () => goToRoom(scene && stepRoom(scene, currentRoom, by))
    steps.append(button('‹ Previous', step(-1), 'Previous room (B)'), button('Next ›', step(1), 'Next room (N)'))
    menu.append(steps)
    // Headed by level when each level's rooms come together; a tour that
    // goes up and down a split-level house would repeat them every few rooms.
    const runs = scene.rooms.filter((r, i) => i === 0 || r.level !== scene!.rooms[i - 1].level).map((r) => r.level)
    const grouped = levels.length > 1 && new Set(runs).size === runs.length
    let lastLevel: string | undefined
    for (const room of scene.rooms) {
      if (grouped && room.level !== lastLevel) {
        const level = levels.find((l) => l.id === room.level)
        heading(level?.name ?? level?.id ?? room.level, 'level')
        lastLevel = room.level
      }
      const b = button(roomName(room), () => goToRoom(room.id))
      b.dataset.room = room.id
      menu.append(b)
    }
  }

  const outside = places().filter((p) => !p.room)
  if (outside.length > 0) {
    heading('Places')
    for (const place of outside) {
      const b = button(place.name, () => walkTo(place.id))
      b.dataset.place = place.id
      menu.append(b)
    }
  }
}
$('menu-toggle').addEventListener('click', () => {
  const collapsed = $('sidebar').classList.toggle('collapsed')
  $('menu-toggle').setAttribute('aria-expanded', String(!collapsed))
})
for (const button of document.querySelectorAll<HTMLButtonElement>('#modes button')) button.addEventListener('click', () => setMode(button.dataset.mode as Mode))

// ---- Selecting and showing -------------------------------------------------

// Click an item to learn its id, so a person can say "move the sofa" and
// the agent knows exactly which entity that is.
// In Plan and House modes the click picks the room under it too; a room
// itself is not selected, since the room panel already says what it is.
const raycaster = new THREE.Raycaster()
let pressed: { x: number; y: number } | undefined
canvas.addEventListener('pointerdown', (event) => {
  pressed = { x: event.clientX, y: event.clientY }
  flight = undefined
})
canvas.addEventListener('wheel', () => (flight = undefined), { passive: true })
canvas.addEventListener('click', (event) => {
  if (!built || !scene || locked() || (dragging && dragging.moved > 6)) return
  // The end of a drag that circled the house is not a click.
  if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 5) return
  const hits = hitsAt(event)
  if (view === 'plan' || modeOf(view) === 'house') {
    const room = hits[0] && roomUnder(scene, [hits[0].point.x, -hits[0].point.z], hits[0].point.y + 0.05)
    if (room) pickRoom(room)
  }
  const ids = new Set(built.entities.keys())
  for (const hit of hits) {
    let object: THREE.Object3D | null = hit.object
    while (object && !(object.name && ids.has(object.name))) object = object.parent
    if (object) return select(scene.rooms.some((r) => r.id === object!.name) ? undefined : object.name)
  }
  select(undefined)
})

// What a point on the screen hits, nearest first, of what is shown.
function hitsAt(event: MouseEvent): THREE.Intersection[] {
  if (!built) return []
  const rect = canvas.getBoundingClientRect()
  const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
  raycaster.setFromCamera(pointer, active)
  const shown = (object: THREE.Object3D) => {
    for (let o: THREE.Object3D | null = object; o; o = o.parent) if (!o.visible) return false
    return true
  }
  return raycaster.intersectObjects(built.root.children, true).filter((hit) => shown(hit.object))
}

function select(id: string | undefined) {
  selected = id
  describe(id)
  if (id) highlight([id], 1600)
}

// The selection panel: the thing's id and what it is, in the person's units.
function describe(id: string | undefined) {
  const panel = $('selection')
  if (!id || !scene) {
    panel.classList.add('hidden')
    return
  }
  const item = scene.items.find((i) => i.id === id)
  const room = scene.rooms.find((r) => r.id === id)
  const opening = scene.openings.find((o) => o.id === id)
  const object = scene.objects.find((o) => o.id === id)
  const size = item ? (findAsset(item.asset)?.size ?? item.size) : undefined
  const detail = item
    ? `${findAsset(item.asset)?.name ?? item.asset} in ${item.room} at [${item.at.join(', ')}]${size ? `, ${formatSize(size, units)}` : ''}`
    : room
      ? `room${room.name ? `, ${room.name}` : ''}`
      : opening
        ? `${opening.type} on ${opening.wall.room} edge ${opening.wall.edge}, ${formatLength(opening.width, units)} wide`
        : object
          ? `${object.kind}${object.name ? `, ${object.name}` : ''} at [${object.at.join(', ')}]${object.parent ? ` in ${object.parent}` : ''}`
          : ''
  panel.innerHTML = `<code>${escape(id)}</code> ${escape(detail)}`
  panel.classList.remove('hidden')
}

function highlight(ids: string[], duration: number) {
  if (!built) return
  for (const id of ids) {
    const object = built.entities.get(id)
    if (!object || object instanceof THREE.Light) continue
    const helper = new THREE.BoxHelper(object, new THREE.Color('#e8b43a'))
    world.add(helper)
    highlights.push({ helper, until: performance.now() + duration })
  }
}

function focus(id: string) {
  if (!built || !scene) return
  const object = built.entities.get(id)
  if (!object) return
  if (locked()) document.exitPointerLock()
  rememberWalk()
  active = perspective
  orbit.enabled = true
  const framed = findCamera(scene, `object:${id}`)
  if (framed?.at && framed.look) {
    // The same framing the agent's render uses.
    perspective.fov = framed.fov
    perspective.updateProjectionMatrix()
    perspective.position.copy(toWorld([framed.at[0], framed.at[1]], framed.at[2]))
    orbit.target.copy(toWorld([framed.look[0], framed.look[1]], framed.look[2]))
  } else {
    const box = new THREE.Box3().setFromObject(object)
    const center = box.getCenter(new THREE.Vector3())
    const size = Math.max(2.5, box.getSize(new THREE.Vector3()).length() * 1.6)
    perspective.fov = 45
    perspective.updateProjectionMatrix()
    orbit.target.copy(center)
    perspective.position.copy(center).add(new THREE.Vector3(-0.5, 0.75, 0.9).normalize().multiplyScalar(size))
  }
  orbit.update()
  applyView('focus', `focus: ${id}`)
  select(id)
}

function entityFingerprints(s: Scene): Map<string, string> {
  const map = new Map<string, string>()
  for (const list of [s.rooms, s.openings, s.items, s.objects, s.lights, s.cameras]) {
    for (const entity of list) map.set(entity.id, JSON.stringify(entity))
  }
  return map
}

function showProblems(problems: Problem[]) {
  const panel = $('problems')
  if (problems.length === 0) {
    panel.classList.add('hidden')
    return
  }
  panel.innerHTML = problems
    .map((p) => `<div class="${p.severity}">${p.severity}: ${p.entity ? `<code>${escape(p.entity)}</code> ` : ''}${escape(p.message)}</div>`)
    .join('')
  panel.classList.remove('hidden')
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

// ---- Loading and live updates ----------------------------------------------

async function load(first: boolean): Promise<void> {
  const response = await fetch(bundled ? './scene.json' : `./api/scene?path=${encodeURIComponent(scenePath)}`, { cache: 'no-store' })
  if (bundled && !response.ok) throw new Error('scene.json is missing beside this page')
  const body: { scene?: unknown; error?: string } = bundled ? { scene: await response.json() } : await response.json()
  if (body.error) throw new Error(body.error)
  const result = check(body.scene)
  showProblems(result.problems)
  if (!result.scene) {
    // Keep showing the last good build; the problems say what to fix.
    setStatus(first ? 'The scene has errors and cannot be built yet.' : 'The last change has errors; showing the previous version.')
    if (first) throw new Error(result.problems.map((p) => p.message).join('; '))
    return
  }

  const next = result.scene
  const fingerprints = entityFingerprints(next)
  const changed = first ? [] : [...fingerprints].filter(([id, json]) => previous.get(id) !== json).map(([id]) => id)
  previous = fingerprints

  // Room mode's changes belong to the old build.
  if (view === 'room') leaveRoomMode()
  if (built) world.remove(built.root)
  scene = next
  levels = levelsByElevation(next)
  storeyIndex = storeys(next)
  if (cap !== Infinity && cap >= levels.length - 1) cap = Infinity
  planLevel = Math.min(planLevel, levels.length - 1)
  built = buildScene(next, { fileUrl: (relative) => (bundled ? `./files/${relative}` : `./files/${btoa(unescape(encodeURIComponent(scenePath))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}/${relative.split('/').map(encodeURIComponent).join('/')}`) })
  world.add(built.root)
  shadowsChanged()
  // Compile every shader now, so the first turn of the head doesn't stall.
  renderer.compile(world, perspective)
  blocking = obstacles(next)
  alignSky()
  if (built.sun) {
    const b = sceneBounds(next)
    const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2 + 3
    const cx = (b.min[0] + b.max[0]) / 2
    const cy = (b.min[1] + b.max[1]) / 2
    built.sun.target.position.copy(toWorld([cx, cy], 0))
    built.sun.position.add(built.sun.target.position)
    const shadow = built.sun.shadow.camera
    shadow.left = -size
    shadow.right = size
    shadow.top = size
    shadow.bottom = -size
    shadow.far = 80
    shadow.updateProjectionMatrix()
  }
  $('title').textContent = next.name
  document.title = `${next.name} · Stage`
  buildSidebar()

  if (first) {
    resize()
    const wanted = levelIndexOf(params.get('level'))
    if (wanted !== undefined) cap = wanted >= levels.length - 1 ? Infinity : wanted
    const room = params.get('room')
    if (!restoreView()) {
      if (room && next.rooms.some((r) => r.id === room)) enterRoom(room)
      else useCamera(params.get('camera') ?? 'orbit')
    }
    landed = true
  } else {
    // The current room is gone from the scene: back out to the house.
    if (currentRoom && !next.rooms.some((r) => r.id === currentRoom)) {
      currentRoom = undefined
      if (view === 'room') showHouse()
    }
    fitPlan()
    applyView(view, $('camera').textContent ?? '')
    if (changed.length > 0) highlight(changed, 2500)
    if (selected && !fingerprints.has(selected)) select(undefined)
  }
  ;($('modes').querySelector('[data-mode="room"]') as HTMLButtonElement).disabled = next.rooms.length === 0
  showCurrentRoom()
  lastUpdate = Date.now()
  setStatus(changed.length > 0 ? `Changed: ${changed.map((id) => `<code>${escape(id)}</code>`).join(', ')}` : '')
  if (!first) {
    $('status').classList.add('flash')
    setTimeout(() => $('status').classList.remove('flash'), 900)
  }
}

// The view survives a reload (a new build, or F5), so iterating doesn't
// throw the person back to the overview every time.
const stateKey = `stage:view:${scenePath}`
function saveView() {
  if (headless || !scene) return
  try {
    sessionStorage.setItem(stateKey, JSON.stringify({ view, label: $('camera').textContent, position: perspective.position.toArray(), target: orbit.target.toArray(), fov: perspective.fov, cap: cap === Infinity ? null : cap, planLevel, yaw, pitch, foot, place: currentPlace, room: currentRoom }))
  } catch {}
}
function restoreView(): boolean {
  if (headless || params.has('camera') || params.has('room')) return false
  try {
    const saved = JSON.parse(sessionStorage.getItem(stateKey) ?? 'null') as { view: View; label: string; position: number[]; target: number[]; fov: number; cap: number | null; planLevel?: number; yaw?: number; pitch?: number; foot?: number; place?: string; room?: string } | null
    if (!saved) return false
    cap = saved.cap === null || saved.cap === undefined ? Infinity : saved.cap
    currentRoom = scene?.rooms.some((r) => r.id === saved.room) ? saved.room : undefined
    if (saved.view === 'room' && !currentRoom) return false
    if (saved.view === 'plan') {
      useCamera(`plan:${levels[saved.planLevel ?? levels.length - 1]?.id ?? ''}`)
      return true
    }
    if (saved.view === 'walk') {
      yaw = saved.yaw ?? 0
      pitch = saved.pitch ?? 0
      beginWalk([saved.position[0], -saved.position[2]], saved.foot ?? saved.position[1] - EYE, undefined, saved.place ?? 'walk')
      return true
    }
    active = perspective
    orbit.enabled = true
    perspective.fov = saved.fov
    perspective.updateProjectionMatrix()
    perspective.position.fromArray(saved.position)
    orbit.target.fromArray(saved.target)
    orbit.update()
    applyView(saved.view, saved.label)
    return true
  } catch {
    return false
  }
}
setInterval(saveView, 1000)

// A thin bar across the top while textures and models arrive.
let progressShown = -1
function showProgress() {
  if (headless) return
  const left = progress.started - progress.done
  const fraction = progress.started === 0 ? 1 : progress.done / progress.started
  if (fraction === progressShown) return
  progressShown = fraction
  const bar = $('progress')
  bar.style.width = `${Math.round(fraction * 100)}%`
  bar.parentElement!.classList.toggle('hidden', left === 0)
  const label = $('progress-label')
  label.textContent = left === 0 ? '' : `Loading ${progress.done} of ${progress.started}`
}

let statusDetail = ''
function setStatus(detail: string) {
  statusDetail = detail
  renderStatus()
}
function renderStatus() {
  const ago = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : 0
  const when = lastUpdate ? (ago < 2 ? 'updated just now' : ago < 60 ? `updated ${ago}s ago` : `updated ${Math.round(ago / 60)} min ago`) : ''
  $('status').innerHTML = `<span class="live">● Live</span> ${when}${statusDetail ? ` · ${statusDetail}` : ''}`
}
setInterval(() => !headless && renderStatus(), 1000)

function listen() {
  if (bundled) return
  if (!scenePath) return
  const events = new EventSource(`./api/events?path=${encodeURIComponent(scenePath)}`)
  events.addEventListener('change', () => load(false).catch((error) => setStatus(escape(String(error.message ?? error)))))
  events.addEventListener('control', (event) => {
    const message = JSON.parse((event as MessageEvent).data) as { camera?: string; focus?: string; level?: string }
    const wanted = levelIndexOf(message.level)
    if (wanted !== undefined && !message.camera) setCap(wanted)
    if (message.camera) useCamera(wanted !== undefined && !message.camera.includes(':') ? `${message.camera}:${message.level}` : message.camera)
    if (message.focus) focus(message.focus)
  })
  // A new viewer build reloads the page, keeping the view.
  events.addEventListener('hello', (event) => {
    const { build } = JSON.parse((event as MessageEvent).data) as { build?: string }
    if (build && BUILD && build !== BUILD) {
      saveView()
      location.reload()
    }
  })
}

const clock = new THREE.Clock()
const lastView = new THREE.Matrix4()
let stillSince = 0
function frame() {
  const delta = Math.min(clock.getDelta(), 0.1)
  const now = performance.now()
  if (flight) fly(now)
  else if (view === 'walk') {
    walkStep(delta)
    followRoom(now)
  } else if (orbit.enabled) {
    keyOrbit(delta)
    orbit.update()
  }
  for (let i = highlights.length - 1; i >= 0; i--) {
    const h = highlights[i]
    if (now > h.until) {
      world.remove(h.helper)
      highlights.splice(i, 1)
    } else {
      h.helper.update()
    }
  }
  updateInside()
  placeLights(now)
  if (built && scene && view === 'room' && currentRoom) applyRoomMode(built, scene, currentRoom, walls, perspective)
  else if (built) applyCutaway(built.root, active, !inside, active === perspective, view === 'orbit' || view === 'focus', reach(cap))
  if (view === 'orbit' || view === 'focus' || view === 'room') shadowsChanged()
  showMark()
  showProgress()
  // Ambient occlusion only once the view holds still: moving stays smooth,
  // and the finished picture fills in a fifth of a second after you stop.
  perspective.updateMatrixWorld()
  if (!lastView.equals(perspective.matrixWorld)) {
    lastView.copy(perspective.matrixWorld)
    stillSince = now
  }
  const still = headless || now - stillSince > 200
  if (quality === 'high' && active === perspective && still) {
    renderPass.camera = perspective
    ao.camera = perspective
    composer.render(delta)
  } else {
    renderer.render(world, active)
  }
  // Slow even without ambient occlusion: draw fewer pixels.
  if (!headless && quality === 'high' && !still) {
    slowFrames = delta > 0.05 ? slowFrames + 1 : Math.max(0, slowFrames - 2)
    if (slowFrames > 90) setQuality('fast', 'Switched to fast rendering because this machine draws slowly. Press F for high quality.')
  }
}

// The built scene as one binary glTF, base64 in window.__stageGlb for
// the command line to read: walls, floors, and furniture with their
// materials; not the labels, drawings, or sky.
async function exportGlb() {
  if (!built) return
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js')
  built.labels.visible = false
  for (const overlay of built.overlays.values()) overlay.visible = false
  const glb = (await new GLTFExporter().parseAsync(built.root, { binary: true, onlyVisible: true })) as ArrayBuffer
  const bytes = new Uint8Array(glb)
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[])
  ;(window as unknown as { __stageGlb: string }).__stageGlb = btoa(text)
}

// Every camera named, as tiles with labels on one canvas: the contact
// sheet behind `stage render --all-cameras`. Each tile is the renderer's
// own size; the page is sized to the sheet by the renderer.
function renderSheet(ids: string[]) {
  const tileW = Number(params.get('w') ?? 640)
  const tileH = Number(params.get('h') ?? 360)
  const labelH = 28
  const cols = Math.ceil(Math.sqrt(ids.length))
  const rows = Math.ceil(ids.length / cols)
  const sheet = document.createElement('canvas')
  sheet.width = cols * tileW
  sheet.height = rows * (tileH + labelH)
  const context = sheet.getContext('2d')!
  context.fillStyle = '#15171a'
  context.fillRect(0, 0, sheet.width, sheet.height)
  ids.forEach((id, i) => {
    useCamera(id)
    shadowsChanged()
    frame()
    frame()
    const x = (i % cols) * tileW
    const y = Math.floor(i / cols) * (tileH + labelH)
    context.drawImage(renderer.domElement, x, y + labelH, tileW, tileH)
    context.fillStyle = '#e8e6e1'
    context.font = '600 15px system-ui, sans-serif'
    context.fillText(id, x + 8, y + 19)
  })
  canvas.style.display = 'none'
  sheet.style.cssText = 'display:block;position:fixed;left:0;top:0'
  document.body.appendChild(sheet)
}

// A server of named scenes lists them all, so a person can switch to
// another variant, or another project, from the top bar. A page opened on a
// file, a share bundle, and a headless render have no list.
async function showScenePicker(): Promise<void> {
  if (bundled || headless) return
  const response = await fetch('./api/scenes', { cache: 'no-store' }).catch(() => undefined)
  if (!response?.ok) return
  const { scenes } = (await response.json().catch(() => ({}))) as { scenes?: string[] }
  if (!scenes || scenes.length < 2 || !scenes.includes(scenePath)) return
  const picker = $('scenes') as HTMLSelectElement
  const projects = new Map<string, string[]>()
  for (const name of scenes) {
    const project = name.split('/')[0]
    projects.set(project, [...(projects.get(project) ?? []), name])
  }
  for (const [project, names] of projects) {
    const group = document.createElement('optgroup')
    group.label = project
    for (const name of names) {
      const option = document.createElement('option')
      option.value = name
      option.textContent = name
      group.append(option)
    }
    picker.append(group)
  }
  picker.value = scenePath
  picker.addEventListener('change', () => {
    location.search = `?scene=${picker.value}`
  })
  picker.classList.remove('hidden')
}

async function start() {
  void showScenePicker()
  try {
    // Each phase is recorded, so a render that times out says where it stopped.
    const phase = (name: string) => (document.body.dataset.phase = name)
    resize()
    phase('library')
    await loadLibrary()
    useSurfaces()
    lawnMesh.material = floorMaterial('grass')
    phase('scene')
    await load(true)
    phase('sky')
    await applySky()
    if (headless && params.has('export')) {
      phase('models')
      await settled()
      phase('export')
      await exportGlb()
      document.body.dataset.ready = '1'
      return
    }
    if (headless) {
      phase('textures')
      await settled()
      phase('frames')
      // A few frames: the first fills the shadow maps.
      frame()
      frame()
      await new Promise((resolve) => requestAnimationFrame(resolve))
      frame()
      if (params.get('sheet')) renderSheet(params.get('sheet')!.split(',').filter(Boolean))
      document.body.dataset.ready = '1'
    } else {
      listen()
      renderer.setAnimationLoop(frame)
    }
  } catch (error) {
    document.body.dataset.ready = 'error'
    document.body.dataset.error = String((error as Error).message ?? error)
    setStatus(escape(document.body.dataset.error))
  }
}

start()
