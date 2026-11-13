import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { z } from 'zod'
import { check, type CheckResult } from '../core/check.ts'
import { Camera, Item, Level, Light, Opening, Room, type Collection, CustomMaterial, SceneObject } from '../core/schema.ts'
import { PathSceneStore, type SceneStore } from '../core/scene-store.ts'
import { DEFAULT_PORT, healthy, viewerUrl } from './server.ts'

// What the command line and the MCP server both do to a scene, so the two
// can never drift apart.

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const EXAMPLES = join(ROOT, 'examples')
const CLI = join(ROOT, 'src/cli/index.ts')

export const SCHEMAS: Record<Collection, z.ZodType> = {
  levels: Level,
  rooms: Room,
  openings: Opening,
  materials: CustomMaterial,
  items: Item,
  objects: SceneObject,
  lights: Light,
  cameras: Camera,
}

// Scenes named by file path: the command line and the local MCP server.
export const PATHS: SceneStore = new PathSceneStore()

// Starts a scene and returns its name in the store (for paths, the file).
export async function newScene(path: string, name: string, from = 'empty', store: SceneStore = PATHS): Promise<string> {
  return store.create(path, await starterScene(name, from))
}

// What a new scene holds. Empty is the ground and the sun, nothing else: a
// thing can be built with no building around it. "room" starts a building
// instead, and an example is a copy of it, byte for byte.
export async function starterScene(name: string, from = 'empty'): Promise<unknown> {
  if (from !== 'empty' && from !== 'room') {
    const example = join(EXAMPLES, from, 'scene.json')
    if (!existsSync(example)) throw new Error(`no example is called "${from}"; examples: flat, flat-with-bedroom, two-storey, desk, room, or empty`)
    return readFile(example, 'utf8')
  }
  return {
    stage: '0.1',
    name,
    units: 'm',
    levels: [{ id: 'ground', elevation: 0, height: 2.7 }],
    rooms: from === 'room' ? [{ id: 'room', level: 'ground', name: 'Room', floor: [[0, 0], [4, 0], [4, 3], [0, 3]] }] : [],
    openings: from === 'room' ? [{ id: 'door', wall: { room: 'room', edge: 0 }, at: 0.5, type: 'door', width: 0.9, height: 2.1 }] : [],
    items: [],
    objects: [],
    lights: [{ id: 'sun', type: 'sun', azimuth: 220, elevation: 35, intensity: 1 }],
    cameras: [{ id: 'plan', type: 'plan' }],
  }
}

export async function checkScene(path: string, store: SceneStore = PATHS): Promise<CheckResult> {
  return check(await store.read(path))
}

// Adds an entity, or replaces the one with the same id. The entity is
// validated alone first, and nothing is written if it is malformed;
// problems with the scene as a whole are written and reported, so an agent
// can build up a scene in any order.
export async function upsert(path: string, collection: Collection, entity: unknown, store: SceneStore = PATHS, note?: string): Promise<{ replaced: boolean; result: CheckResult }> {
  const parsed = SCHEMAS[collection].safeParse(entity)
  if (!parsed.success) {
    throw new Error(`not a valid ${collection.slice(0, -1)}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(entity)'}: ${i.message}`).join('; ')}`)
  }
  const { replaced, raw } = await store.mutate(path, (raw) => {
    const list = ((raw as Record<string, unknown[]>)[collection] ??= [])
    const id = (entity as { id: string }).id
    const index = list.findIndex((e) => (e as { id?: string }).id === id)
    if (index >= 0) list[index] = entity
    else list.push(entity)
    return { replaced: index >= 0, raw }
  }, note ?? `set ${collection} ${(entity as { id: string }).id}`)
  return { replaced, result: check(raw) }
}

export async function removeEntity(path: string, id: string, store: SceneStore = PATHS, note?: string): Promise<{ collection: string; result: CheckResult }> {
  const { collection, raw } = await store.mutate(path, (raw) => {
    for (const collection of ['items', 'objects', 'openings', 'rooms', 'cameras', 'lights', 'materials', 'levels']) {
      const list = raw[collection]
      if (!Array.isArray(list)) continue
      const index = list.findIndex((e) => (e as { id?: string }).id === id)
      if (index < 0) continue
      list.splice(index, 1)
      return { collection, raw }
    }
    throw new Error(`nothing in ${path} has the id "${id}"`)
  }, note ?? `removed ${id}`)
  return { collection, result: check(raw) }
}

// The live viewer runs as its own small background process, so it outlives
// any one command and every client (CLI, MCP, a person) talks to the same one.
export async function ensureLiveServer(port = DEFAULT_PORT): Promise<string> {
  const url = `http://127.0.0.1:${port}`
  if (await healthy(port)) return url
  const logs = join(homedir(), '.cache', 'stage')
  mkdirSync(logs, { recursive: true })
  const log = openSync(join(logs, 'server.log'), 'a')
  const child = spawn(process.execPath, ['--no-warnings', CLI, 'serve', '--port', String(port)], {
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  for (let i = 0; i < 50; i++) {
    if (await healthy(port)) return url
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`the viewer server did not start; see ${join(logs, 'server.log')}`)
}

export function openInBrowser(url: string): void {
  const launcher = existsSync('/usr/share/omarchy/bin/omarchy-launch-browser') ? 'omarchy-launch-browser' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(launcher, [url], { detached: true, stdio: 'ignore' }).unref()
}

export async function openViewer(scene: string, browser = true): Promise<string> {
  const base = await ensureLiveServer()
  const url = viewerUrl(base, scene)
  if (browser) openInBrowser(url)
  return url
}

// Asks every open viewer of this scene to switch camera or focus an entity.
export async function control(scene: string, message: { camera?: string; focus?: string; level?: string }): Promise<number> {
  const base = await ensureLiveServer()
  const response = await fetch(`${base}/api/control?path=${encodeURIComponent(resolve(scene))}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  })
  const body = (await response.json()) as { viewers?: number; error?: string }
  if (body.error) throw new Error(body.error)
  return body.viewers ?? 0
}
