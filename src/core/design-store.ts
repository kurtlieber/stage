import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Design, DESIGN_ID } from './design.ts'

// The folder under a store's root that holds the designs. It is not a
// project: the scene store leaves it alone.
export const DESIGNS_FOLDER = 'designs'

// Every design under <root>/designs/<id>/design.json that reads as one, by
// name. One that doesn't is left out and said on stderr, so a half-written
// design never takes the rest of the gallery down. No folder, no designs.
export async function listDesigns(root: string, warn: (message: string) => void = (m) => console.error(m)): Promise<Design[]> {
  let entries
  try {
    entries = await readdir(join(root, DESIGNS_FOLDER), { withFileTypes: true })
  } catch {
    return []
  }
  const designs: Design[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !DESIGN_ID.test(entry.name)) continue
    const file = join(root, DESIGNS_FOLDER, entry.name, 'design.json')
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`stage: skipped design ${entry.name}: ${(error as Error).message}`)
      continue
    }
    const parsed = Design.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      warn(`stage: skipped design ${entry.name}: ${issue.path.join('.') || 'design.json'}: ${issue.message}`)
      continue
    }
    if (parsed.data.id !== entry.name) {
      warn(`stage: skipped design ${entry.name}: its id is "${parsed.data.id}"; the id is the folder's name`)
      continue
    }
    designs.push(parsed.data)
  }
  return designs.sort((a, b) => a.name.localeCompare(b.name))
}
