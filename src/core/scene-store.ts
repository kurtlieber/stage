import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { readScene, writeScene } from './store.ts'

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
  /** Replaces the whole scene. */
  write(scene: string, value: unknown): Promise<void>
  /**
   * Reads, changes, and writes one scene with no other write to it in
   * between. `change` edits the object in place; nothing is written when it
   * throws.
   */
  mutate<T>(scene: string, change: (raw: Record<string, unknown>) => T | Promise<T>): Promise<T>
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

  async write(scene: string, value: unknown): Promise<void> {
    const file = this.locate(scene)
    return inTurn(file, () => writeScene(file, value))
  }

  async mutate<T>(scene: string, change: (raw: Record<string, unknown>) => T | Promise<T>): Promise<T> {
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
const PART_ONLY = new RegExp(`^${PART}$`)
export const SCENE_NAME_HELP = 'a scene name is project/variant in lowercase letters, digits, and hyphens, like house/main'

// Scenes by name in one folder: <root>/<project>/<variant>/scene.json. Files
// a scene refers to (a plan drawing, fetched models, exports) sit in its
// variant folder beside it.
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

  async write(scene: string, value: unknown): Promise<void> {
    const file = this.locate(scene)
    return inTurn(file, () => writeScene(file, value))
  }

  async mutate<T>(scene: string, change: (raw: Record<string, unknown>) => T | Promise<T>): Promise<T> {
    const file = this.existing(scene)
    return inTurn(file, async () => {
      const raw = await this.naming(scene, () => readObject(file))
      const result = await change(raw)
      await writeScene(file, raw)
      return result
    })
  }

  async create(scene: string, value: unknown): Promise<string> {
    const file = this.locate(scene)
    return inTurn(file, async () => {
      if (existsSync(file)) throw new Error(`a scene called "${scene}" already exists; open it, or pick another name`)
      await writeNew(file, value)
      return scene
    })
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
      throw new Error((error as Error).message.replaceAll(this.locate(scene), scene))
    }
  }
}

async function folders(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}
