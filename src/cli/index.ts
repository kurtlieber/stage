import { mkdirSync, readFileSync, symlinkSync, lstatSync, unlinkSync, existsSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { searchAssets } from '../core/assets.ts'
import { formatProblem, type CheckResult } from '../core/check.ts'
import { allCameras, turntable } from '../core/cameras.ts'
import { materialNames } from '../core/materials.ts'
import { QUESTIONS, query } from '../core/query.ts'
import { COLLECTIONS, jsonSchema, type Collection } from '../core/schema.ts'
import { readScene, writeScene } from '../core/store.ts'
import { ROOT, checkScene, control, newScene, openViewer, removeEntity, upsert } from './ops.ts'
import { Renderer } from './render.ts'
import { FileSceneStore } from '../core/scene-store.ts'
import { DEFAULT_PORT, VERSION, allowedHostsFromEnv, parseListen, startServer } from './server.ts'

// The `stage` command. Every command but `open`, `serve`, and `mcp` needs
// no display, takes --json, exits 0 or 1, and prints errors on stderr.

const USAGE = `Usage: stage <command> [options]

Viewer:
  open <scene>                         Open the scene in your browser; it updates as the file changes
  serve [--port ${DEFAULT_PORT}]                   Run the viewer server in the foreground
  serve --root dir [--listen host:port]
                                       Serve the scenes in dir by name (project/variant), and no other file

Commands that need no display:
  new <path> [--name N] [--from flat]  Start a scene: empty, room, or an example (flat, flat-with-bedroom, two-storey, desk)
  check <scene>                        Report every problem, with its entity and a fix
  render <scene> -o out.png [--camera id] [--level id] [--size 1280x720]
                                       [--all-cameras: every camera, and one per room, as a contact sheet]
                                       [--around id: a turntable of one object, item, or room]
                                       Cameras: orbit, plan, plan:<level>, room:<id>, object:<id>[:front|back|left|right|top|front-left...][:close], or a camera id
  query <scene> <question...>          ${QUESTIONS.join(' | ')}
  set <scene> <collection> '<json>'    Add an entity, or replace the one with its id
  remove <scene> <id>                  Remove an entity
  show <scene> [--camera id] [--level id] [--focus id]
                                       Point every open viewer at a camera, level, or entity
  export <scene> -o scene.glb          Write the built scene as binary glTF
  share <scene> -o folder              Bundle viewer, scene, and assets for any static host
  assets [words...] [--category c]     Search the asset library
  assets fetch [ids|scene.json...] [--all]  Download CC0 textures, models and the sky into the local cache
  materials                            List the built-in materials
  models find <words...> [--source s]  Search the open model libraries (Poly Haven and more)
  models fetch <scene> <source> <id>   Download a model beside the scene, measured
  fmt <scene>                          Rewrite the scene in canonical form
  schema                               Print the scene format as JSON Schema
  mcp                                  Run as an MCP server over stdio
  mcp --http host:port --root dir      Run as an MCP server over HTTP at /mcp, for scenes in dir by name
  skill [install]                      Print the agent skill, or install it

Add --json to any command for machine-readable output.`

function listenOn(flag: string, value: string): { host: string; port: number } {
  try {
    return parseListen(value)
  } catch (error) {
    throw new Error(`${flag}: ${(error as Error).message}`)
  }
}

function print(value: unknown) {
  process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`)
}

function fail(message: string): number {
  process.stderr.write(`stage: ${message}\n`)
  return 1
}

function reportCheck(result: CheckResult, json: boolean): void {
  if (json) {
    print({ ok: result.ok, problems: result.problems })
    return
  }
  if (result.problems.length === 0) print('ok: no problems')
  for (const problem of result.problems) print(formatProblem(problem))
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: 'boolean' },
      source: { type: 'string' },
      out: { type: 'string', short: 'o' },
      camera: { type: 'string' },
      level: { type: 'string' },
      focus: { type: 'string' },
      size: { type: 'string' },
      name: { type: 'string' },
      from: { type: 'string' },
      category: { type: 'string' },
      port: { type: 'string' },
      listen: { type: 'string' },
      root: { type: 'string' },
      http: { type: 'string' },
      resolution: { type: 'string' },
      all: { type: 'boolean' },
      'all-cameras': { type: 'boolean' },
      around: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const json = values.json === true
  const scene = positionals[0]

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      print(USAGE)
      return 0

    case '--version':
    case 'version':
      print(VERSION)
      return 0

    case 'new': {
      if (!scene) return fail('name the scene to create: stage new <path>')
      const name = (values.name as string | undefined) ?? 'Untitled scene'
      const path = await newScene(scene, name, (values.from as string | undefined) ?? 'empty')
      json ? print({ ok: true, scene: path }) : print(`Created ${path}`)
      return 0
    }

    case 'check': {
      if (!scene) return fail('name a scene: stage check <scene>')
      const result = await checkScene(scene)
      reportCheck(result, json)
      return result.ok ? 0 : 1
    }

    case 'render': {
      if (!scene) return fail('name a scene: stage render <scene> -o out.png')
      const out = (values.out as string | undefined) ?? 'render.png'
      const [width, height] = ((values.size as string | undefined) ?? '1280x720').split('x').map(Number)
      if (!width || !height) return fail('--size is WIDTHxHEIGHT, like 1280x720')
      const result = await checkScene(scene)
      if (!result.ok) {
        reportCheck(result, json)
        return fail('fix the errors above before rendering')
      }
      const renderer = await Renderer.start()
      try {
        const sheet = values.around ? turntable(result.scene!, values.around as string) : values['all-cameras'] === true ? allCameras(result.scene!).filter((c) => c.type === 'perspective').map((c) => c.id).concat('orbit', 'plan') : undefined
        const png = await renderer.render(scene, { camera: values.camera as string | undefined, level: values.level as string | undefined, width: sheet && !values.size ? 640 : width, height: sheet && !values.size ? 360 : height, sheet })
        const target = resolve(out)
        mkdirSync(dirname(target), { recursive: true })
        const temporary = `${target}.${process.pid}.tmp`
        await writeFile(temporary, png)
        await rename(temporary, target)
        json ? print({ ok: true, image: target, warnings: result.problems }) : print(`Rendered ${target}`)
      } finally {
        await renderer.close()
      }
      return 0
    }

    case 'query': {
      if (!scene || positionals.length < 2) return fail(`ask a question: stage query <scene> ${QUESTIONS.join(' | ')}`)
      const result = await checkScene(scene)
      if (!result.scene) {
        reportCheck(result, json)
        return fail('the scene has errors that stop it from being read')
      }
      print(query(result.scene, positionals.slice(1)))
      return 0
    }

    case 'set': {
      const [, collection, entityJson] = positionals
      if (!scene || !collection || !entityJson) return fail(`stage set <scene> <${COLLECTIONS.join('|')}> '<json>'`)
      if (!(COLLECTIONS as readonly string[]).includes(collection)) return fail(`collections are ${COLLECTIONS.join(', ')}`)
      const { replaced, result } = await upsert(scene, collection as Collection, JSON.parse(entityJson))
      if (!json) print(replaced ? 'Replaced' : 'Added')
      reportCheck(result, json)
      return 0
    }

    case 'remove': {
      const id = positionals[1]
      if (!scene || !id) return fail('stage remove <scene> <id>')
      const { collection, result } = await removeEntity(scene, id)
      if (!json) print(`Removed ${id} from ${collection}`)
      reportCheck(result, json)
      return 0
    }

    case 'show': {
      if (!scene) return fail('stage show <scene> --camera <id> | --focus <id>')
      const viewers = await control(scene, { camera: values.camera as string | undefined, level: values.level as string | undefined, focus: values.focus as string | undefined })
      json ? print({ ok: true, viewers }) : print(viewers ? `Showed it in ${viewers} viewer${viewers === 1 ? '' : 's'}` : 'No viewer has this scene open; run: stage open <scene>')
      return 0
    }

    case 'open': {
      if (!scene) return fail('name a scene: stage open <scene>')
      if (!existsSync(scene)) return fail(`${scene} does not exist`)
      const url = await openViewer(scene)
      json ? print({ ok: true, url }) : print(`Opened ${url}`)
      return 0
    }

    case 'serve': {
      const listen = typeof values.listen === 'string' ? listenOn('--listen', values.listen) : { host: '127.0.0.1', port: Number(values.port ?? DEFAULT_PORT) }
      const root = typeof values.root === 'string' ? resolve(values.root) : undefined
      const server = await startServer(listen.port, { host: listen.host, store: root ? new FileSceneStore(root) : undefined, allowedHosts: root ? allowedHostsFromEnv() : [] })
      print(root ? `Serving the scenes in ${root} at ${server.url}` : `Serving the viewer at ${server.url}`)
      await new Promise(() => {})
      return 0
    }

    case 'assets': {
      if (positionals[0] === 'fetch') {
        const { fetchAssets, sceneAssetIds, CACHE } = await import('./assets.ts')
        const ids: string[] = []
        for (const arg of positionals.slice(1)) {
          if (arg.endsWith('.json')) ids.push(...sceneAssetIds((await checkScene(arg)).scene ?? { items: [] }))
          else ids.push(arg)
        }
        const lock = await fetchAssets({ resolution: values.resolution as string | undefined, ids, all: values.all === true, log: json ? undefined : (line) => print(line) })
        json ? print({ ok: true, cache: CACHE, textures: Object.keys(lock.textures), skies: Object.keys(lock.skies), models: Object.keys(lock.models) }) : print(`Fetched into ${CACHE}`)
        return 0
      }
      const found = searchAssets(positionals.join(' '), { category: values.category as string | undefined })
      if (json) print(found)
      else for (const a of found) print(`${a.id.padEnd(28)} ${a.size.join(' x ')} m   ${a.name}`)
      return 0
    }

    case 'models': {
      const { findModels, fetchModelBesideScene, SOURCES } = await import('./models.ts')
      if (positionals[0] === 'find') {
        const { hits, skipped } = await findModels(positionals.slice(1).join(' '), { source: values.source as string | undefined, limit: 12 })
        if (json) print({ hits, skipped })
        else {
          for (const h of hits) print(`${`${h.source}:${h.id}`.padEnd(44)} ${h.license.padEnd(6)} ${h.name}${h.credit ? ` (${h.credit})` : ''}`)
          if (skipped.length) print(`not searched: ${skipped.join('; ')}`)
        }
        return 0
      }
      if (positionals[0] === 'fetch') {
        const [, scenePath, source, id] = positionals
        if (!scenePath || !source || !id) return fail(`stage models fetch <scene> <source> <id>; sources are ${SOURCES.map((s) => s.id).join(', ')}`)
        const fetched = await fetchModelBesideScene(resolve(scenePath), source, id)
        json ? print(fetched) : print(`Fetched ${fetched.file} (${fetched.size.join(' × ')} m, ${fetched.license}${fetched.credit ? ` by ${fetched.credit}` : ''})`)
        return 0
      }
      return fail('stage models find <words> | stage models fetch <scene> <source> <id>')
    }

    case 'materials':
      json ? print(materialNames()) : print(materialNames().join('\n'))
      return 0

    case 'export': {
      if (!scene) return fail('name a scene: stage export <scene> -o scene.glb')
      const out = (values.out as string | undefined) ?? 'scene.glb'
      const result = await checkScene(scene)
      if (!result.ok) {
        reportCheck(result, json)
        return fail('fix the errors above before exporting')
      }
      const renderer = await Renderer.start()
      try {
        const glb = await renderer.export(resolve(scene))
        const target = resolve(out)
        mkdirSync(dirname(target), { recursive: true })
        await writeFile(target, glb)
        json ? print({ ok: true, file: target, bytes: glb.length }) : print(`Exported ${target} (${(glb.length / 1e6).toFixed(1)} MB)`)
      } finally {
        await renderer.close()
      }
      return 0
    }

    case 'share': {
      if (!scene) return fail('name a scene: stage share <scene> -o folder')
      const out = (values.out as string | undefined) ?? `${scene.replace(/\.json$/, '')}-site`
      const result = await checkScene(scene)
      if (!result.ok) {
        reportCheck(result, json)
        return fail('fix the errors above before sharing')
      }
      const { shareScene } = await import('./share.ts')
      const info = await shareScene(scene, result.scene!, out, (line) => !json && print(line))
      json ? print({ ok: true, ...info }) : print(`Wrote ${info.files} files (${(info.bytes / 1e6).toFixed(1)} MB) to ${info.dir}\nServe the folder from any static host, or try: python3 -m http.server -d ${info.dir} 8080`)
      return 0
    }

    case 'fmt': {
      if (!scene) return fail('name a scene: stage fmt <scene>')
      const raw = await readScene(scene)
      await writeScene(scene, raw)
      json ? print({ ok: true }) : print(`Formatted ${scene}`)
      return 0
    }

    case 'schema':
      print(jsonSchema())
      return 0

    case 'mcp': {
      if (values.http !== undefined) {
        if (typeof values.http !== 'string') throw new Error('--http takes host:port, like 127.0.0.1:4748')
        if (typeof values.root !== 'string') throw new Error('--http needs --root, the folder that holds the scenes')
        const { host, port } = listenOn('--http', values.http)
        const { runMcpHttp } = await import('./mcp.ts')
        await runMcpHttp({
          root: values.root,
          host,
          port,
          publicUrl: process.env.STAGE_PUBLIC_URL,
          viewerUrl: process.env.STAGE_VIEWER_URL,
          allowedHosts: allowedHostsFromEnv(),
        })
        return 0
      }
      const { runMcp } = await import('./mcp.ts')
      await runMcp()
      return 0
    }

    case 'skill': {
      const text = readFileSync(join(ROOT, 'src/skill.md'), 'utf8')
      if (positionals[0] !== 'install') {
        process.stdout.write(text)
        return 0
      }
      const directory = join(homedir(), '.agents/skills/stage')
      mkdirSync(directory, { recursive: true })
      await writeFile(join(directory, 'SKILL.md'), text)
      print(`Installed ${join(directory, 'SKILL.md')}`)
      const link = join(homedir(), '.claude/skills/stage')
      if (existsSync(join(homedir(), '.claude'))) {
        try {
          if (lstatSync(link).isSymbolicLink()) unlinkSync(link)
          else return fail(`${link} exists and is not a link; leaving it alone`)
        } catch {}
        mkdirSync(dirname(link), { recursive: true })
        symlinkSync('../../.agents/skills/stage', link)
        print(`Linked ${link}`)
      }
      return 0
    }

    default:
      return fail(`"${command}" is not a command\n\n${USAGE}`)
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (process.argv[2] !== 'serve' && process.argv[2] !== 'mcp') process.exit(code)
  },
  (error) => process.exit(fail((error as Error).message)),
)

