import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { ASSETS, searchAssets } from '../core/assets.ts'
import { formatProblem, type CheckResult } from '../core/check.ts'
import { ANGLES, allCameras, findCamera, turntable } from '../core/cameras.ts'
import { materialNames } from '../core/materials.ts'
import { QUESTIONS, query } from '../core/query.ts'
import { FileSceneStore, SCENE_NAME, SCENE_NAME_HELP, type SceneStore } from '../core/scene-store.ts'
import { COLLECTIONS, jsonSchema, type Collection } from '../core/schema.ts'
import { format } from '../core/store.ts'
import { EXAMPLES, PATHS, ROOT, SCHEMAS, checkScene, control, newScene, openViewer, removeEntity, upsert } from './ops.ts'
import { SOURCES, available, fetchModelBesideScene, findModels, remember, thumbnailImage } from './models.ts'
import { Renderer } from './render.ts'
import { DEFAULT_PORT, VERSION, hostAllowed, sceneToken } from './server.ts'

// The same operations as the command line, as MCP tools. `render` returns
// the image itself, so the model sees the result in the same turn, and every
// write lands in the file the person's open viewer is watching. The server's
// instructions are the agent guide (src/skill.md), so a client that has
// never seen Stage knows the format and the order of work before its first
// call; the guide, the schema, and the examples are also resources.
//
// Two ways to run it. Over stdio, for an agent on the same machine, a scene
// is a file path and open_viewer opens the person's browser. Over HTTP, for
// a client elsewhere, a scene is a name inside one data root (see
// scene-store.ts), no tool takes a file path, and open_viewer returns a link.

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

const text = (value: unknown): Content => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) })
const problems = (result: CheckResult): string =>
  result.problems.length === 0 ? 'check: no problems' : `check: ${result.ok ? 'ok with warnings' : 'errors'}\n${result.problems.map(formatProblem).join('\n')}`

async function guarded(work: () => Promise<Content[]>): Promise<{ content: Content[]; isError?: boolean }> {
  try {
    return { content: await work() }
  } catch (error) {
    return { content: [text(`stage: ${(error as Error).message}`)], isError: true }
  }
}

// One headless browser, started on the first render and closed again
// after two idle minutes, so it never sits on a gigabyte between calls.
// A browser that died takes its promise with it.
let renderer: Promise<Renderer> | undefined
let idle: NodeJS.Timeout | undefined
const getRenderer = () => (renderer ??= Renderer.start().catch((error) => {
  renderer = undefined
  throw error
}))
// Renders take turns: one page cannot draw two cameras at once, and a
// client may call render twice in one go.
let queue: Promise<unknown> = Promise.resolve()
async function withRenderer<T>(work: (r: Renderer) => Promise<T>): Promise<T> {
  const turn = queue.then(() => renderNow(work), () => renderNow(work))
  queue = turn.catch(() => {})
  return turn
}
async function renderNow<T>(work: (r: Renderer) => Promise<T>): Promise<T> {
  clearTimeout(idle)
  const r = await getRenderer()
  try {
    return await work(r)
  } catch (error) {
    if (/connect|closed|socket|target/i.test(String((error as Error).message))) {
      renderer = undefined
      await r.close().catch(() => {})
    }
    throw error
  } finally {
    idle = setTimeout(() => {
      const closing = renderer
      renderer = undefined
      closing?.then((r) => r.close()).catch(() => {})
    }, 120_000)
  }
}

const EXAMPLE_NAMES = ['flat', 'flat-with-bedroom', 'two-storey', 'desk'] as const
const EXAMPLE_BLURB: Record<(typeof EXAMPLE_NAMES)[number], string> = {
  flat: 'a furnished two-room flat with two eye-level cameras',
  'flat-with-bedroom': 'the flat with a bedroom and a person standing in each room',
  'two-storey': 'a house: hall, kitchen and living below, bedrooms above, a stair through a well, and a roof terrace',
  desk: 'no rooms at all: a desk with a monitor, keyboard and lamp, and a rubber duck built from spheres and a cone, all free objects with parents',
}

// What an entity of each collection looks like, so `set` can be called
// without a trip to the schema.
const EXAMPLE_ENTITY: Record<Collection, string> = {
  levels: '{"id":"first","name":"First floor","elevation":3.0,"height":2.7,"slab":0.3}',
  rooms: '{"id":"kitchen","level":"ground","name":"Kitchen","floor":[[0,0],[4,0],[4,3],[0,3]],"materials":{"floor":"oak-plank"}}',
  openings: '{"id":"kitchen-door","wall":{"room":"kitchen","edge":0},"at":1.5,"type":"door","width":0.9,"height":2.1} (window: "sill":0.9; slider: a sliding glass wall)',
  items: '{"id":"table","asset":"table/dining-six","room":"kitchen","at":[2,1.5],"facing":0}',
  objects: '{"id":"crate","kind":"box","size":[0.6,0.4,0.5],"at":[1,2,0],"facing":30,"color":"#8a6a3c"}. Kinds: box (size), sphere (radius), cylinder (radius, height; top 0 for a cone), plane (size [w, d], flat), extrude (polygon, height), model (file: a glb beside the scene or an https URL; size to fit), asset (a library piece outside the rooms), group (nothing, to hang parts on). "parent" places it in another object\'s frame so an assembly moves as one; "pitch" and "roll" tilt it; "label" floats text above it; "room" stands it on that room\'s floor. No rooms are needed at all.',
  lights: '{"id":"sun","type":"sun","azimuth":220,"elevation":35,"intensity":1}',
  cameras: '{"id":"from-door","type":"perspective","at":[0.5,0.5,1.6],"look":[2,2,1.2],"fov":55}',
  materials: '{"id":"lime-plaster","color":"#e9e2d3","roughness":0.9} or {"id":"slate","color":"#55585c","texture":"<Poly Haven id>","size":1.5}',
}

const QUESTION_HELP = [
  'rooms (every room with its level, size and area)',
  'room <id> (each edge with its direction, length, neighbor and openings, plus the items inside)',
  'items in <room>',
  'walls <room>',
  'openings',
  'cameras (including the automatic room:<id> ones)',
  'bounds',
  'adjacent <room> (shared walls, doors through, rooms above and below)',
  'areas [level]',
  'free <room> (clear floor, the largest free rectangle, the longest free run along each wall)',
  'fits <asset> in <room> (positions where a piece stands back to a wall, clear of doors and other pieces)',
]

const scenePath = z.string().describe('Path to the scene file, ideally absolute, e.g. /home/me/stage-scenes/flat/scene.json')
const sceneName = z.string().regex(SCENE_NAME, SCENE_NAME_HELP).describe("The scene's name, project/variant, like house/main")

let guideText: string | undefined
const guide = () => (guideText ??= readFileSync(join(ROOT, 'src/skill.md'), 'utf8').replace(/^---[\s\S]*?---\n/, ''))

// Read before the guide by a client of named scenes, since the guide is
// written for scenes as files.
const NAMED_PREAMBLE = `# This Stage server

This server is shared over the network and keeps its scenes by name. A scene is named project/variant, like house/main: pass that name wherever the guide below says scene or path, and never a file path. The scenes tool lists them. Files a scene refers to (a level's plan drawing, models fetched with fetch_model) sit in the scene's own folder on the server; name them relative to the scene, as the guide says. open_viewer returns a link to give the person; it opens nothing by itself. export writes exports/scene.glb beside the scene and returns a link that downloads it. The command line the guide mentions is not available here; use the tools.

`

// What differs between a local server and a shared one.
export interface McpContext {
  store: SceneStore
  /** A link to the scene in the viewer. A local server also opens it in the person's browser. */
  openViewer(scene: string): Promise<string>
  /** Points every open viewer of the scene at a camera, level, or entity, and says how many there were. */
  control(scene: string, message: { camera?: string; focus?: string; level?: string }): Promise<number>
  /** Named scenes: where export writes, and the link that downloads it. */
  exportFile?(scene: string): { file: string; url: string }
}

export const LOCAL: McpContext = {
  store: PATHS,
  openViewer: (scene) => openViewer(resolve(scene)),
  control: (scene, message) => control(resolve(scene), message),
}

// A shared server. `publicUrl` is the viewer as the person reaches it (the
// links handed out), `viewerUrl` is the viewer as this process reaches it
// (to point it at things); they differ behind a proxy.
export function namedContext(store: SceneStore, urls: { publicUrl: string; viewerUrl: string }): McpContext {
  const publicUrl = urls.publicUrl.replace(/\/+$/, '')
  const viewerUrl = urls.viewerUrl.replace(/\/+$/, '')
  return {
    store,
    async openViewer(scene) {
      await store.read(scene)
      return `${publicUrl}/?scene=${scene}`
    },
    async control(scene, message) {
      store.locate(scene)
      let response: Response
      try {
        response = await fetch(`${viewerUrl}/api/control?path=${scene}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message), signal: AbortSignal.timeout(5000) })
      } catch {
        throw new Error(`the viewer is not running at ${viewerUrl}`)
      }
      const body = (await response.json()) as { viewers?: number; error?: string }
      if (body.error) throw new Error(body.error)
      return body.viewers ?? 0
    },
    exportFile(scene) {
      return { file: join(dirname(store.locate(scene)), 'exports', 'scene.glb'), url: `${publicUrl}/files/${sceneToken(scene)}/exports/scene.glb` }
    },
  }
}

// The tools, resources, and prompts, for one connection (stdio) or one
// request (stateless HTTP).
export function buildMcp(context: McpContext): McpServer {
  const { store } = context
  const named = store.named
  const sceneArg = named ? sceneName : scenePath
  const server = new McpServer({ name: 'stage', version: VERSION }, { instructions: named ? NAMED_PREAMBLE + guide() : guide() })
  const categories = [...new Set(ASSETS.map((a) => a.category))].sort()
  const starts = `"empty" is the ground and the sun with nothing on it, for a thing built from objects; "room" is one 4 × 3 m room with a door, for a building; the examples are ${EXAMPLE_NAMES.map((n) => `"${n}" (${EXAMPLE_BLURB[n]})`).join(', ')}`
  const newSceneOptions = { name: z.string().default('Untitled scene'), from: z.enum(['empty', 'room', ...EXAMPLE_NAMES]).default('empty') }
  const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }

  if (named) {
    server.registerTool(
      'new_scene',
      {
        title: 'New scene',
        description: `Start a scene, named project/variant (like house/main): ${starts}. Refuses to overwrite. Follow with open_viewer and give the person the link, so they watch it take shape.`,
        inputSchema: { scene: sceneName, ...newSceneOptions },
        annotations: writes,
      },
      ({ scene, name, from }) => guarded(async () => [text({ scene: await newScene(scene, name, from, store) })]),
    )
    server.registerTool(
      'scenes',
      {
        title: 'List the scenes',
        description: 'Every scene on this server, by name (project/variant).',
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      () => guarded(async () => {
        const names = await store.list()
        return [text(names.length ? names.join('\n') : 'no scenes yet; start one with new_scene')]
      }),
    )
  } else {
    server.registerTool(
      'new_scene',
      {
        title: 'New scene',
        description: `Start a scene file: ${starts}. Refuses to overwrite. When the person named no path, use ~/stage-scenes/<name>/scene.json. Follow with open_viewer so they watch it take shape.`,
        inputSchema: { path: scenePath, ...newSceneOptions },
        annotations: writes,
      },
      ({ path, name, from }) => guarded(async () => [text({ scene: await newScene(path, name, from) })]),
    )
  }

  server.registerTool(
    'open_viewer',
    {
      title: 'Open the viewer',
      description: named
        ? "A link to the scene in the viewer, for the person to open. The page updates live whenever the scene changes and outlines what changed; they can walk through it at eye level (V), see the plan (P) or the overview (O). Give them the link once per scene, early."
        : "Open the scene in the person's browser. The page updates live whenever the file changes and outlines what changed; they can walk through it at eye level (V), see the plan (P) or the overview (O). Call once per scene, early.",
      inputSchema: { scene: sceneArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ scene }) => guarded(async () => [text({ url: await context.openViewer(scene) })]),
  )

  server.registerTool(
    'show',
    {
      title: 'Show the person',
      description: "Point the person's open viewer at what you are talking about: a camera id ('orbit', 'plan', 'plan:<level>', 'room:<room id>', 'object:<id>[:angle][:close]' framed exactly as render frames it, or one of the scene's), a level (that one and the ones below it), or an entity to fly to and outline. Use it when you describe a change or ask them to look.",
      inputSchema: { scene: sceneArg, camera: z.string().optional(), level: z.string().optional().describe('A level id: show it and the levels below it'), focus: z.string().optional().describe('An entity id to fly to and outline') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ scene, camera, level, focus }) =>
      guarded(async () => {
        const viewers = await context.control(scene, { camera, level, focus })
        return [text(viewers ? `shown in ${viewers} viewer${viewers === 1 ? '' : 's'}` : 'no viewer has this scene open; call open_viewer first')]
      }),
  )

  server.registerTool(
    'check',
    {
      title: 'Check the scene',
      description: 'Validate the scene: schema, references, and spatial rules (objects or pieces that run into each other, a parent that is missing or loops, doors that do not fit their wall, wardrobes with no room to open, things standing on windows, stairs without headroom, rooms that overlap). Every problem names the entity and how to fix it. Errors stop renders; warnings do not.',
      inputSchema: { scene: sceneArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ scene }) => guarded(async () => [text(problems(await checkScene(scene, store)))]),
  )

  server.registerTool(
    'render',
    {
      title: 'Render an image',
      description: "Render the scene headlessly and return the image, which you look at before going on; it is the only truth about how the scene looks. Cameras: 'orbit' (overview from the southwest, the default), 'plan' (top-down with room names and sizes, over the level's drawing when it has one), 'plan:<level>' (one level), 'room:<room id>' (standing in that room at eye height), 'object:<id>' (framed on an object with everything hung on it, an item, or a room; add ':front', ':back', ':left', ':right', ':top', ':front-left' and the other corners, or a compass bearing like ':120'; add ':close' for a tight crop), or any camera id in the scene. `around` renders a turntable of one thing: every side, the top, and a close view, as one sheet; nothing you build is done until you have looked at its turntable and fixed what is wrong. `sheet` tiles every camera and one per room into one image: the fastest way to look at a whole house. Pass `level` to see a level with the ones above hidden. Call fetch_assets with the scene once first, so models and surfaces are the real ones.",
      inputSchema: {
        scene: sceneArg,
        camera: z.string().optional(),
        level: z.string().optional().describe('A level id: show it and the levels below it'),
        width: z.number().int().min(320).max(1920).default(1024),
        height: z.number().int().min(240).max(1080).default(640),
        quality: z.enum(['high', 'fast']).optional().describe('fast skips ambient occlusion and shadows for a quick look'),
        sheet: z.boolean().optional().describe('Every camera, plus one standing in each room, as one contact sheet of small tiles'),
        around: z.string().optional().describe('An object, item, or room id: a turntable sheet of it from every side, the top, and up close'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ scene, camera, level, width, height, quality, sheet, around }) =>
      guarded(async () => {
        const result = await checkScene(scene, store)
        if (!result.ok) return [text(`${problems(result)}\nfix the errors before rendering`)]
        if (camera?.startsWith('object:') && !findCamera(result.scene!, camera)) return [text(`${camera}: nothing is called "${camera.split(':')[1]}", or the angle is not one of ${ANGLES.join(', ')}, a bearing, or close.`)]
        const cameras = around ? turntable(result.scene!, around) : sheet ? allCameras(result.scene!).filter((c) => c.type === 'perspective').map((c) => c.id).concat('orbit', 'plan') : undefined
        const png = await withRenderer((r) => r.render(store.locate(scene), { camera, level, quality, width: cameras ? 480 : width, height: cameras ? 270 : height, sheet: cameras }))
        return [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, text(problems(result))]
      }),
  )

  server.registerTool(
    'query',
    {
      title: 'Ask about the scene',
      description: `Ask about the scene instead of reading the whole file. Questions:\n${QUESTION_HELP.map((q) => `- ${q}`).join('\n')}\nBefore placing furniture, "room <id>" then "fits <asset> in <id>"; after moving walls, "rooms".`,
      inputSchema: { scene: sceneArg, question: z.string().describe('e.g. "room kitchen", "fits sofa/three-seat in living", "adjacent hall"') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ scene, question }) =>
      guarded(async () => {
        const result = await checkScene(scene, store)
        if (!result.scene) return [text(problems(result))]
        return [text(query(result.scene, question.trim().split(/\s+/)))]
      }),
  )

  server.registerTool(
    'read_scene',
    {
      title: 'Read the scene file',
      description: 'The whole scene file, in canonical form. Rarely needed: query answers most questions in a fraction of the tokens.',
      inputSchema: { scene: sceneArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ scene }) => guarded(async () => [text(format(await store.read(scene)))]),
  )

  server.registerTool(
    'set',
    {
      title: 'Add or replace an entity',
      description: `Add an entity to a collection, or replace the one with the same id (so a move is a set with a new "at"). The entity is validated first; the scene is then checked as a whole, written, and its problems reported. One entity per call keeps the person's view following along. Shapes:\n${COLLECTIONS.map((c) => `- ${c}: ${EXAMPLE_ENTITY[c]}`).join('\n')}\nMeters and degrees; [x, y] with x east, y north; facing 0 = north, 90 = east. Ids are lowercase with hyphens, unique across the file. The schema tool has every field.`,
      inputSchema: {
        scene: sceneArg,
        collection: z.enum(COLLECTIONS),
        entity: z.record(z.string(), z.unknown()).describe('The whole entity, including its id'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ scene, collection, entity }) =>
      guarded(async () => {
        const { replaced, result } = await upsert(scene, collection as Collection, entity, store)
        const look = collection === 'objects' || collection === 'items' ? `\nlook at it: render camera "object:${String(entity.id)}", and around: "${String(entity.id)}" for every side before you call it done.` : ''
        return [text(`${replaced ? 'replaced' : 'added'} ${String(entity.id)}${look}\n${problems(result)}`)]
      }),
  )

  server.registerTool(
    'remove',
    {
      title: 'Remove an entity',
      description: 'Remove the entity with this id from whichever collection holds it. Removing a room leaves its openings and items dangling; check names them.',
      inputSchema: { scene: sceneArg, id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ scene, id }) =>
      guarded(async () => {
        const { collection, result } = await removeEntity(scene, id, store)
        return [text(`removed ${id} from ${collection}\n${problems(result)}`)]
      }),
  )

  server.registerTool(
    'write_scene',
    {
      title: 'Write the whole scene',
      description: 'Replace the whole scene file. Use it for a new layout, several rooms at once, or a rewrite; prefer set and remove for small changes. Malformed JSON is refused and nothing is written; a scene with errors is written and the errors reported.',
      inputSchema: { scene: sceneArg, json: z.string().describe('The complete scene as JSON text') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ scene, json }) =>
      guarded(async () => {
        const raw = JSON.parse(json)
        await store.write(scene, raw)
        return [text(`written\n${problems(await checkScene(scene, store))}`)]
      }),
  )

  server.registerTool(
    'assets',
    {
      title: 'Search the library',
      description: `Search the built-in library (${ASSETS.length} CC0 pieces: furniture, fixtures, plants, people, vehicles) by words that must all match, or by category: ${categories.join(', ')}. A piece goes in a room as an item, or anywhere as an object of kind "asset". Sizes are width × depth × height in meters at facing 0; the front of a piece faces north at facing 0. Empty words list everything in a category. For anything else, find_model searches the open libraries. A piece not in the library can still be placed with a "size" and shows as a labeled box.`,
      inputSchema: { words: z.string().default(''), category: z.enum(categories as [string, ...string[]]).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ words, category }) => guarded(async () => [text(searchAssets(words, { category }).map((a) => ({ id: a.id, name: a.name, size: a.size })))]),
  )

  server.registerTool(
    'fetch_assets',
    {
      title: 'Fetch models and textures',
      description: 'Download CC0 models and texture sets from Poly Haven into the local cache (~/.cache/stage): everything the scene uses (its items with models, the textures of its own materials), or the ids given (asset ids like "chair/armchair", or Poly Haven ids). Until fetched, renders show stand-ins built from primitives. Needs the network; takes seconds to a minute.',
      inputSchema: { scene: sceneArg.optional(), ids: z.array(z.string()).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ scene, ids }) =>
      guarded(async () => {
        const { fetchAssets, sceneAssetIds } = await import('./assets.ts')
        const wanted = [...(ids ?? [])]
        if (scene) wanted.push(...sceneAssetIds((await checkScene(scene, store)).scene ?? { items: [] }))
        const lines: string[] = []
        await fetchAssets({ ids: wanted, log: (line) => lines.push(line) })
        return [text(lines.length ? lines.join('\n') : 'nothing new to fetch')]
      }),
  )

  server.registerTool(
    'find_model',
    {
      title: 'Find a model in the open libraries',
      description: `Search the free, openly licensed 3D model libraries for anything the built-in library lacks: a shoe, a bicycle, a dinosaur, a laptop. Returns up to \`limit\` hits with id, license, author, triangle count where known, and their thumbnails as images, so look at them and pick. Sources: ${SOURCES.map((s) => `${s.id} (${s.about})`).join('; ')}. Search first; build from primitives only when nothing fits; generate never. Then fetch_model with the source and id.`,
      inputSchema: {
        words: z.string().describe('What to look for, e.g. "rubber duck", "office chair", "oak tree"'),
        source: z.enum(SOURCES.map((s) => s.id) as [string, ...string[]]).optional().describe('One source; every available one by default'),
        limit: z.number().int().min(1).max(20).default(8),
        license: z.enum(['cc0', 'any']).default('any').describe('cc0: public domain only; any: also CC-BY, which the scene credits'),
        thumbnails: z.boolean().default(true).describe('Return each hit\'s thumbnail as an image'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ words, source, limit, license, thumbnails }) =>
      guarded(async () => {
        const { hits, skipped } = await findModels(words, { source, limit, license })
        remember(hits)
        const lines = hits.map((h, i) => `${i + 1}. ${h.source}:${h.id}  ${h.name}  [${h.license}${h.credit ? `, ${h.credit}` : ''}]${h.triangles ? `  ${h.triangles.toLocaleString()} tris` : ''}${h.size ? `  ${h.size.join(' × ')} m` : ''}  ${h.url}`)
        const content: Content[] = [text(hits.length ? `${lines.join('\n')}\n\nfetch_model with source and id places one. Sources searched: ${available().map((s) => s.id).join(', ')}${hits.some((h) => h.source === 'polyhaven') ? ' (powered by Poly Haven)' : ''}.${skipped.length ? ` Not searched: ${skipped.join('; ')}.` : ''}` : `nothing found for "${words}"${skipped.length ? ` (not searched: ${skipped.join('; ')})` : ''}; try other words, or build it from primitives.`)]
        if (thumbnails) {
          const images = await Promise.all(hits.map((h) => thumbnailImage(h)))
          images.forEach((image, i) => {
            if (!image) return
            content.push(text(`${i + 1}. ${hits[i].source}:${hits[i].id}`))
            content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
          })
        }
        return content
      }),
  )

  server.registerTool(
    'fetch_model',
    {
      title: 'Fetch a model beside the scene',
      description: 'Download a model found with find_model into a models/ folder beside the scene file, measure it, and, with `place`, add it to the scene as a `model` object in one go (its size, license, author and source are recorded on the object). Without `place`, returns the file and size for a set call of your own.',
      inputSchema: {
        scene: sceneArg,
        source: z.enum(SOURCES.map((s) => s.id) as [string, ...string[]]),
        id: z.string().describe('The id find_model gave'),
        place: z
          .object({
            id: z.string().describe('The object id to give it'),
            at: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
            facing: z.number().default(0),
            parent: z.string().optional(),
            room: z.string().optional(),
            size: z.tuple([z.number(), z.number(), z.number()]).optional().describe('Fit it into this box instead of its own size'),
            label: z.string().optional(),
          })
          .optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ scene, source, id, place }) =>
      guarded(async () => {
        const fetched = await fetchModelBesideScene(store.locate(scene), source, id)
        const biggest = Math.max(...fetched.size)
        const note = biggest > 12 || biggest < 0.03 ? ` The model's own size is ${fetched.size.join(' × ')} m, which looks like the wrong units; pass place.size (or set "size") to fit it to the size the real thing has.` : ''
        if (!place) return [text({ ...fetched, note: note || undefined, next: `set objects {"id": ..., "kind": "model", "file": "${fetched.file}", "size": ${JSON.stringify(fetched.size)}, "at": [x, y, z]}` })]
        const entity = { id: place.id, kind: 'model', file: fetched.file, size: place.size ?? fetched.size, at: place.at, facing: place.facing, parent: place.parent, room: place.room, label: place.label, source: fetched.source, license: fetched.license, credit: fetched.credit || undefined }
        const { replaced, result } = await upsert(scene, 'objects', JSON.parse(JSON.stringify(entity)), store)
        return [text(`${replaced ? 'replaced' : 'added'} ${place.id}: ${fetched.file}, ${(place.size ?? fetched.size).join(' × ')} m, ${fetched.license}${fetched.credit ? ` by ${fetched.credit}` : ''}.${place.size ? '' : note}\nlook at it: render camera "object:${place.id}" (the model's front may need "facing").\n${problems(result)}`)]
      }),
  )

  server.registerTool(
    'materials',
    {
      title: 'List materials',
      description: 'The built-in material names for floors, walls, and ceilings (a room\'s "materials": {"floor", "walls", "ceiling"}). A scene adds its own under its "materials" collection.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guarded(async () => [text(materialNames())]),
  )

  server.registerTool(
    'schema',
    {
      title: 'The scene format',
      description: 'The scene format as JSON Schema: the whole file, or one collection\'s entity. Ask for it when a field is in doubt; the guide in the server instructions covers the common cases.',
      inputSchema: { collection: z.enum(COLLECTIONS).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ collection }) => guarded(async () => [text(collection ? z.toJSONSchema(SCHEMAS[collection as Collection]) : jsonSchema())]),
  )

  const exportDescription = 'Write the built scene (walls, floors, openings, furniture) as a binary glTF file, for Blender, a game engine, or any 3D viewer. Fetch assets first so the models are the real ones.'
  const exportScene = async (scene: string, target: string): Promise<number> => {
    const result = await checkScene(scene, store)
    if (!result.ok) throw new Error(`${problems(result)}\nfix the errors before exporting`)
    const glb = await withRenderer((r) => r.export(store.locate(scene)))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, glb)
    return glb.length
  }
  if (context.exportFile) {
    const exportFile = context.exportFile
    server.registerTool(
      'export',
      {
        title: 'Export glTF',
        description: `${exportDescription} It is written to exports/scene.glb beside the scene, replacing the last export, and the reply has a link that downloads it.`,
        inputSchema: { scene: sceneArg },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      ({ scene }) =>
        guarded(async () => {
          const { file, url } = exportFile(scene)
          return [text({ download: url, bytes: await exportScene(scene, file) })]
        }),
    )
  } else {
    server.registerTool(
      'export',
      {
        title: 'Export glTF',
        description: exportDescription,
        inputSchema: { scene: sceneArg, out: z.string().describe('Path of the .glb to write') },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      ({ scene, out }) =>
        guarded(async () => {
          const target = resolve(out)
          return [text({ file: target, bytes: await exportScene(scene, target) })]
        }),
    )
  }

  // The guide, the schema, and the examples, for clients that read
  // resources before they call tools.
  server.registerResource('guide', 'stage://guide', { title: 'How to build scenes with Stage', description: 'The agent guide: the format, several floors, and the order of work', mimeType: 'text/markdown' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guide() }],
  }))
  server.registerResource('schema', 'stage://schema', { title: 'Scene format', description: 'The scene file as JSON Schema', mimeType: 'application/json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(jsonSchema(), null, 2) }],
  }))
  server.registerResource(
    'example',
    new ResourceTemplate('stage://examples/{name}', {
      list: async () => ({ resources: EXAMPLE_NAMES.map((name) => ({ uri: `stage://examples/${name}`, name, description: EXAMPLE_BLURB[name], mimeType: 'application/json' })) }),
    }),
    { title: 'Example scene', description: 'A complete scene to read or start from' },
    async (uri, { name }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: readFileSync(join(EXAMPLES, String(name), 'scene.json'), 'utf8') }] }),
  )

  // Two ways in that people ask for most, as prompts a client can offer.
  // The floor plan one needs an image on this machine, so it is local only.
  if (!named) server.registerPrompt(
    'from-floor-plan',
    {
      title: 'Build a home from a floor plan',
      description: 'Turn a floor plan image into a scene the person can walk through',
      argsSchema: { plan: z.string().describe('Path to the floor plan image (png or jpg)'), scene: z.string().describe('Where to write the scene file'), notes: z.string().optional().describe('Anything known: scale, which way is north, what the rooms are for') },
    },
    ({ plan, scene, notes }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Build a Stage scene from the floor plan at ${plan}, written to ${scene}, and open it in my browser.`,
              '',
              '1. Look at the drawing first. Find its scale (a labeled dimension or a scale bar), which way is north, and every room with its name and labeled size. Write the sizes down before drawing anything.',
              '2. new_scene at the path, then set the level\'s "plan": { "image": <path relative to the scene file>, "scale": <pixels per meter>, "origin": [px, py] }, with origin the pixel at plan [0, 0]; a corner of the building is a good [0, 0].',
              '3. Rooms first: one room per space, corners in meters, sharing edges where rooms meet; closed rooms get walls, "open": true is outdoors. Then check, render camera plan:<level>, and compare the walls with the drawing under them. Fix until they line up and every labeled size matches.',
              '4. Doors and windows on the edges the drawing shows. Then furniture with query "fits", then a camera in the main rooms. Render a sheet and look at every tile.',
              '5. fetch_assets with the scene once, open_viewer, and tell me what to look at.',
              notes ? `\nWhat I know: ${notes}` : '',
            ].join('\n'),
          },
        },
      ],
    }),
  )
  server.registerPrompt(
    'furnish',
    {
      title: 'Furnish a room',
      description: 'Lay out one room with pieces that fit, clear of its doors',
      argsSchema: { scene: z.string().describe(named ? 'The scene name, project/variant' : 'The scene file'), room: z.string().describe('The room id'), brief: z.string().optional().describe('What the room is for and what it should hold') },
    },
    ({ scene, room, brief }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Furnish room "${room}" in ${scene}${brief ? ` as ${brief}` : ''}. Start with query "room ${room}" for its edges, neighbors, and openings, and query "free ${room}" for the clear floor. Pick pieces with assets, and place each with query "fits <asset> in ${room}", backs to walls, doors clear. check after every few pieces, render room:${room}, and look before you go on.`,
          },
        },
      ],
    }),
  )

  return server
}

async function closeRenderer(): Promise<void> {
  const running = renderer
  renderer = undefined
  clearTimeout(idle)
  if (running) await running.then((r) => r.close()).catch(() => {})
}

// Over stdio, for an agent on this machine.
export async function runMcp(): Promise<void> {
  await buildMcp(LOCAL).connect(new StdioServerTransport())
  const shutdown = async () => {
    await closeRenderer()
    process.exit(0)
  }
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

export interface McpHttpOptions {
  /** The data root that holds the scenes. */
  root: string
  port: number
  /** The address to bind; 127.0.0.1 by default. */
  host?: string
  /** The viewer as the person reaches it, for the links handed out. */
  publicUrl?: string
  /** The viewer as this process reaches it, for show. */
  viewerUrl?: string
  /** Host names to answer to besides localhost. */
  allowedHosts?: readonly string[]
}

export interface McpHttpServer {
  url: string
  port: number
  close(): Promise<void>
}

const rpcError = (response: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

// Over Streamable HTTP at /mcp, stateless: every POST gets its own server and
// transport, and the reply is plain JSON. The scenes, the renderer, and the
// one-writer-at-a-time rule are shared across requests.
export async function startMcpHttp(options: McpHttpOptions): Promise<McpHttpServer> {
  const local = `http://127.0.0.1:${DEFAULT_PORT}`
  const context = namedContext(new FileSceneStore(options.root), { publicUrl: options.publicUrl ?? local, viewerUrl: options.viewerUrl ?? local })
  const allowed = options.allowedHosts ?? []
  const http = createServer(async (request, response) => {
    if (!hostAllowed(request.headers.host ?? '', allowed)) return rpcError(response, 403, 'stage only answers on the hosts it is configured for')
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ stage: VERSION }))
    }
    if (path !== '/mcp') return rpcError(response, 404, 'not found; the MCP endpoint is /mcp')
    if (request.method !== 'POST') return rpcError(response, 405, 'method not allowed; this server is stateless, so only POST', { allow: 'POST' })
    const server = buildMcp(context)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(request, response)
    } catch (error) {
      console.error('stage mcp:', error)
      if (!response.headersSent) rpcError(response, 500, 'internal server error')
    }
  })
  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((done, fail) => {
    http.once('error', fail)
    http.listen(options.port, host, () => done())
  })
  const address = http.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  return {
    url: `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}/mcp`,
    port,
    close: async () => {
      await closeRenderer()
      http.closeAllConnections()
      await new Promise<void>((done) => http.close(() => done()))
    },
  }
}

// The command: `stage mcp --http host:port --root dir`.
export async function runMcpHttp(options: McpHttpOptions): Promise<void> {
  const server = await startMcpHttp(options)
  process.stderr.write(`stage: MCP over HTTP at ${server.url}, scenes in ${resolve(options.root)}\n`)
  const shutdown = async () => {
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
