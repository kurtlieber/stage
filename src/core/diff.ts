import { COLLECTIONS, type Collection } from './schema.ts'

// What differs between two scenes, entity by entity: what one has that the
// other lacks, and for an entity in both, each field that changed. Works on
// the raw files, so a scene with problems can still be compared.

export interface FieldChange {
  field: string
  from: unknown
  to: unknown
}

export interface EntityChange {
  collection: Collection | 'scene'
  id: string
  kind: 'added' | 'removed' | 'changed'
  fields: FieldChange[]
  /** The rooms the change is in or on, when it has one. */
  rooms: string[]
}

type Raw = Record<string, unknown>
type Entity = Raw & { id?: unknown }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// The room an entity stands in or is cut into.
function roomsOf(collection: Collection, entity: Entity | undefined): string[] {
  if (!entity) return []
  if (collection === 'rooms') return typeof entity.id === 'string' ? [entity.id] : []
  if (collection === 'openings') {
    const wall = entity.wall as { room?: unknown } | undefined
    return typeof wall?.room === 'string' ? [wall.room] : []
  }
  return typeof entity.room === 'string' ? [entity.room] : []
}

function fieldChanges(a: Raw, b: Raw, skip: (key: string) => boolean = () => false): FieldChange[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !skip(key))
  return keys.filter((key) => !same(a[key], b[key])).map((field) => ({ field, from: a[field], to: b[field] }))
}

export function diffScenes(a: Raw, b: Raw): EntityChange[] {
  const changes: EntityChange[] = []
  const scene = fieldChanges(a, b, (key) => (COLLECTIONS as readonly string[]).includes(key))
  if (scene.length) changes.push({ collection: 'scene', id: 'scene', kind: 'changed', fields: scene, rooms: [] })
  for (const collection of COLLECTIONS) {
    const before = new Map(((a[collection] as Entity[] | undefined) ?? []).map((e) => [String(e.id), e]))
    const after = new Map(((b[collection] as Entity[] | undefined) ?? []).map((e) => [String(e.id), e]))
    for (const [id, entity] of before) {
      const other = after.get(id)
      if (!other) changes.push({ collection, id, kind: 'removed', fields: [], rooms: roomsOf(collection, entity) })
      else {
        const fields = fieldChanges(entity, other)
        if (fields.length) changes.push({ collection, id, kind: 'changed', fields, rooms: [...new Set([...roomsOf(collection, entity), ...roomsOf(collection, other)])] })
      }
    }
    for (const [id, entity] of after) if (!before.has(id)) changes.push({ collection, id, kind: 'added', fields: [], rooms: roomsOf(collection, entity) })
  }
  return changes
}

// A value short enough for one line.
function brief(value: unknown): string {
  if (value === undefined) return '(none)'
  const text = JSON.stringify(value)
  return text.length > 70 ? `${text.slice(0, 67)}...` : text
}

/** One line per change, with `a` and `b` naming the two scenes. */
export function describeDiff(changes: EntityChange[], a: string, b: string): string {
  if (changes.length === 0) return `${a} and ${b} are the same`
  const lines = [`from ${a} to ${b}:`]
  for (const change of changes) {
    const where = change.collection === 'scene' ? 'scene' : `${change.collection.slice(0, -1)} ${change.id}`
    if (change.kind === 'added') lines.push(`+ ${where}: only in ${b}`)
    else if (change.kind === 'removed') lines.push(`- ${where}: only in ${a}`)
    else lines.push(`~ ${where}: ${change.fields.map((f) => `${f.field} ${brief(f.from)} -> ${brief(f.to)}`).join('; ')}`)
  }
  return lines.join('\n')
}

/** The one room every change is in, if there is one, to frame a comparison on. */
export function sharedRoom(changes: EntityChange[]): string | undefined {
  const rooms = new Set<string>()
  for (const change of changes) {
    if (change.rooms.length === 0) return undefined
    for (const room of change.rooms) rooms.add(room)
  }
  return rooms.size === 1 ? [...rooms][0] : undefined
}
