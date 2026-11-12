import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { format, readScene, writeScene } from './store.ts'

// Where scenes live. The command line and the local MCP server name a scene
// by its file path. A server shared over the network names it
// project/variant inside one data root instead, and never reads or writes a
// file outside that root.

export interface SceneStore {
  /** True when scenes are named project/variant rather than by file path. */
  readonly named: boolean
  /** The scene file a name stands for. Throws for a name the store does not hold. */
  locate(scene: string): string
  read(scene: string): Promise<unknown>
  /** Replaces the whole scene. `note` says what changed, for the history. */
  write(scene: string, value: unknown, note?: string): Promise<void>
  /**
   * Reads, changes, and writes one scene with no other write to it in
   * between. `change` edits the object in place; nothing is written when it
   * throws. `note` says what changed, for the history.
   */
  mutate<T>(scene: string, change: (raw: Record<string, unknown>) => T | Promise<T>, note?: string): Promise<T>
  /**
   * Writes a new scene, refusing one that exists, and returns its name. A
   * string is the file's exact text, as an example is copied; anything else
   * is written in canonical form.
   */
  create(scene: string, value: unknown): Promise<string>
  /** Every scene in the store, by name. */
  list(): Promise<string[]>
}

// One write at a time to each scene file, within this process. A turn that
// fails does not hold up the next one.
const tails = new Map<string, Promise<unknown>>()
function inTurn<T>(file: string, work: () => Promise<T>): Promise<T> {
  const turn = (tails.get(file) ?? Promise.resolve()).then(work)
  const tail = turn.catch(() => {})
  tails.set(file, tail)
  void tail.then(() => {
    if (tails.get(file) === tail) tails.delete(file)
  })
  return turn
}

// A new scene file, written whole or not at all.
async function writeNew(file: string, value: unknown): Promise<void> {
  if (typeof value !== 'string') return writeScene(file, value)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, value)
  await rename(temporary, file)
}

async function readObject(file: string): Promise<Record<string, unknown>> {
  const raw = await readScene(file)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${file} is not a scene: the file holds no JSON object`)
  return raw as Record<string, unknown>
}

// Scenes named by their file paths, as the command line has always had them.
export class PathSceneStore implements SceneStore {
  readonly named = false

  locate(scene: string): string {
    return resolve(scene)
  }

  read(scene: string): Promise<unknown> {
    return readScene(this.locate(scene))
  }

  // A scene named by its path keeps no history: the file is all there is.
  async write(scene: string, value: unknown, _note?: string): Promise<void> {
    const file = this.locate(scene)
    return inTurn(file, () => writeScene(file, value))
  }

  async mutate<T>(scene: string, change: (raw: Record<string, unknown>) => T | Promise<T>, _note?: string): Promise<T> {
    const file = this.locate(scene)
    return inTurn(file, async () => {
      const raw = await readObject(file)
      const result = await change(raw)
      await writeScene(file, raw)
      return result
    })
  }

  // A folder gets a scene.json inside it.
  async create(scene: string, value: unknown): Promise<string> {
    const file = resolve(scene.endsWith('.json') ? scene : join(scene, 'scene.json'))
    return inTurn(file, async () => {
      if (existsSync(file)) throw new Error(`${file} already exists; open it, or pick another path`)
      await writeNew(file, value)
      return file
    })
  }

  list(): Promise<string[]> {
    return Promise.reject(new Error('scenes named by file path cannot be listed'))
  }
}

// A name is project/variant: lowercase letters, digits, and hyphens, each
// part starting with a letter or digit. Nothing else is a name, so no name
// can climb out of the root, point at a hidden folder, or be a path.
const PART = '[a-z0-9][a-z0-9-]{0,63}'
export const SCENE_NAME = new RegExp(`^${PART}/${PART}$`)
export const PART_ONLY = new RegExp(`^${PART}$`)
export const SCENE_NAME_HELP = 'a scene name is project/variant in lowercase letters, digits, and hyphens, like house/main'

// One version of a scene. Version 1 is the scene as it was created, and
// every write after it is the next number. `back` is where undo goes from
// here: the version before, or for a restore, the version before the one it
// brought back, so undo after undo keeps walking back.
export interface Version {
  version: number
  at: string
  change: string
  back: number | null
}

// What a scene's history folder holds: history/<n>.json for every version
// but the current one, which is scene.json, and history/log.json listing
// them all, oldest first.
const HISTORY = 'history'
// Not copied into a new variant: its history is its own, and exports are
// rebuilt from the scene.
const NOT_COPIED = new Set([HISTORY, 'exports'])

// Scenes by name in one folder: <root>/<project>/<variant>/scene.json. Files
// a scene refers to (a plan drawing, fetched models, exports) sit in its
// variant folder beside it. Every write keeps the scene it replaces, so a
// change can be undone and nothing is ever lost.
export class FileSceneStore implements SceneStore {
  readonly named = true
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  locate(scene: string): string {
    if (typeof scene !== 'string' || !SCENE_NAME.test(scene)) throw new Error(`"${scene}" is not a scene name; ${SCENE_NAME_HELP}`)
    return join(this.root, scene, 'scene.json')
  }

  async read(scene: string): Promise<unknown> {
    return this.naming(scene, () => readScene(this.existing(scene)))
  }

  async write(scene: string, value: unknown, note?: string): Promise<void> {
    const file = this.locate(scene)
    await inTurn(file, () => this.commit(file, format(value), note ?? 'rewrote the scene'))
  }

  async mutate<T>(scene: string, change: (raw: Record<string, unknown>) => T | Promise<T>, note?: string): Promise<T> {
    const file = this.existing(scene)
    return inTurn(file, async () => {
      const raw = await this.naming(scene, () => readObject(file))
      const result = await change(raw)
      await this.commit(file, format(raw), note ?? 'changed the scene')
      return result
    })
  }

  async create(scene: string, value: unknown, note = 'created'): Promise<string> {
    const file = this.locate(scene)
    return inTurn(file, async () => {
      if (existsSync(file)) throw new Error(`a scene called "${scene}" already exists; open it, or pick another name`)
      await writeNew(file, value)
      await writeLog(dirname(file), [{ version: 1, at: new Date().toISOString(), change: note, back: null }])
      return scene
    })
  }

  /** Every version of a scene, newest first, and which one is current. */
  async history(scene: string): Promise<{ current: number; versions: Version[] }> {
    const file = this.existing(scene)
    return inTurn(file, async () => {
      const log = await currentLog(file)
      return { current: log.at(-1)!.version, versions: [...log].reverse() }
    })
  }

  /** One version of a scene, as it was then. */
  async version(scene: string, version: number): Promise<unknown> {
    const file = this.existing(scene)
    return inTurn(file, async () => this.naming(scene, async () => JSON.parse(await this.versionText(scene, file, await currentLog(file), version))))
  }

  /**
   * Brings back an earlier version as a new one, so the versions after it
   * stay too. Nothing is deleted.
   */
  async restore(scene: string, version: number, note?: string): Promise<Version> {
    const file = this.existing(scene)
    return inTurn(file, async () => {
      const log = await currentLog(file)
      if (version === log.at(-1)!.version) throw new Error(`version ${version} is already the current one of ${scene}`)
      return this.naming(scene, () => this.bringBack(scene, file, log, version, note ?? `restored version ${version}`))
    })
  }

  /** Goes back one step: to the version before the current one. */
  async undo(scene: string): Promise<Version> {
    const file = this.existing(scene)
    return inTurn(file, async () => {
      const log = await currentLog(file)
      const current = log.at(-1)!
      if (current.back === null) throw new Error(`nothing to undo: version ${current.version} of ${scene} is the first`)
      return this.naming(scene, () => this.bringBack(scene, file, log, current.back!, `undo: back to version ${current.back}`))
    })
  }

  /** The variants of one project, by name. */
  async variants(project: string): Promise<string[]> {
    if (!PART_ONLY.test(project)) throw new Error(`"${project}" is not a project name; ${SCENE_NAME_HELP}`)
    return (await this.list()).filter((name) => name.startsWith(`${project}/`))
  }

  /**
   * A new variant of a scene's project, copied from the scene with every
   * file beside it (plan drawings, models) but not its history or exports.
   */
  async createVariant(from: string, variant: string): Promise<string> {
    const source = this.existing(from)
    if (!PART_ONLY.test(variant)) throw new Error(`"${variant}" is not a variant name; use lowercase letters, digits, and hyphens, like open-kitchen`)
    const name = `${from.split('/')[0]}/${variant}`
    const target = this.locate(name)
    if (existsSync(dirname(target))) throw new Error(`a variant called "${name}" already exists; open it, or pick another name`)
    return inTurn(source, () =>
      inTurn(target, async () => {
        if (existsSync(dirname(target))) throw new Error(`a variant called "${name}" already exists; open it, or pick another name`)
        const log = await currentLog(source)
        const temporary = `${dirname(target)}.${process.pid}.tmp`
        await cp(dirname(source), temporary, { recursive: true, filter: (path) => !(dirname(path) === dirname(source) && NOT_COPIED.has(basename(path))) && !path.endsWith('.tmp') })
        await writeLog(temporary, [{ version: 1, at: new Date().toISOString(), change: `copied from ${from} version ${log.at(-1)!.version}`, back: null }])
        await rename(temporary, dirname(target))
        return name
      }),
    )
  }

  /**
   * Takes a variant out of its project. Its folder moves to
   * <root>/.deleted/, out of every list, rather than being erased. The last
   * variant of a project is refused.
   */
  async deleteVariant(scene: string): Promise<string> {
    const file = this.existing(scene)
    const project = scene.split('/')[0]
    // One delete at a time in a project, so two can't take its last two.
    return inTurn(join(this.root, project), async () => {
      if ((await this.variants(project)).length <= 1) throw new Error(`${scene} is the only variant of ${project}; a project keeps at least one`)
      return inTurn(file, async () => {
        const kept = join(this.root, '.deleted', project, `${scene.split('/')[1]}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
        await mkdir(dirname(kept), { recursive: true })
        await rename(dirname(file), kept)
        return kept.slice(this.root.length + 1)
      })
    })
  }

  // Writes a scene's new text and records it as the next version, keeping
  // the text it replaces. Called in the scene's turn. Text that is already
  // there is not a new version.
  private async commit(file: string, text: string, change: string, back?: number | null): Promise<Version | undefined> {
    const folder = dirname(file)
    let log: Version[] = []
    if (existsSync(file)) {
      if ((await readFile(file, 'utf8')) === text) return undefined
      log = await currentLog(file)
      await mkdir(join(folder, HISTORY), { recursive: true })
      await copyFile(file, join(folder, HISTORY, `${log.at(-1)!.version}.json`))
    }
    const previous = log.at(-1)
    const entry: Version = { version: (previous?.version ?? 0) + 1, at: new Date().toISOString(), change, back: back === undefined ? (previous?.version ?? null) : back }
    await writeNew(file, text)
    await writeLog(folder, [...log, entry])
    return entry
  }

  private async bringBack(scene: string, file: string, log: Version[], version: number, change: string): Promise<Version> {
    const text = await this.versionText(scene, file, log, version)
    const back = log.find((v) => v.version === version)!.back
    const entry = await this.commit(file, text, change, back)
    // The same text as now: still a step, so undo keeps its place.
    if (!entry) {
      const current = log.at(-1)!
      const step: Version = { version: current.version + 1, at: new Date().toISOString(), change, back }
      await copyFile(file, join(dirname(file), HISTORY, `${current.version}.json`))
      await writeLog(dirname(file), [...log, step])
      return step
    }
    return entry
  }

  private async versionText(scene: string, file: string, log: Version[], version: number): Promise<string> {
    if (!log.some((v) => v.version === version)) throw new Error(`${scene} has no version ${version}; it has versions 1 to ${log.at(-1)!.version}`)
    if (version === log.at(-1)!.version) return readFile(file, 'utf8')
    return readFile(join(dirname(file), HISTORY, `${version}.json`), 'utf8')
  }

  async list(): Promise<string[]> {
    const names: string[] = []
    for (const project of await folders(this.root)) {
      if (!PART_ONLY.test(project)) continue
      for (const variant of await folders(join(this.root, project))) {
        if (PART_ONLY.test(variant) && existsSync(join(this.root, project, variant, 'scene.json'))) names.push(`${project}/${variant}`)
      }
    }
    return names.sort()
  }

  private existing(scene: string): string {
    const file = this.locate(scene)
    if (!existsSync(file)) throw new Error(`no scene is called "${scene}"`)
    return file
  }

  // Errors name the scene, not where the server keeps it.
  private async naming<T>(scene: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      const file = this.locate(scene)
      throw new Error((error as Error).message.replaceAll(file, scene).replaceAll(dirname(file), scene))
    }
  }
}

// The history of a scene file. A scene from before history was kept, or
// one changed by hand, starts as version 1, as it stands.
async function currentLog(file: string): Promise<Version[]> {
  try {
    const log = JSON.parse(await readFile(join(dirname(file), HISTORY, 'log.json'), 'utf8')) as Version[]
    if (Array.isArray(log) && log.length > 0) return log
  } catch {}
  return [{ version: 1, at: (await stat(file)).mtime.toISOString(), change: 'as it was before history was kept', back: null }]
}

async function writeLog(folder: string, log: Version[]): Promise<void> {
  const file = join(folder, HISTORY, 'log.json')
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(log, null, 1)}\n`)
  await rename(temporary, file)
}

async function folders(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}
