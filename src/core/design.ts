import { z } from 'zod'

// A Design: one piece of custom furniture or cabinetry, drawn and built by a
// CAD pipeline outside Stage. Stage only shows it: alone on a studio floor,
// in the rooms it is placed in, and with the files a maker needs. Each
// design lives in its own folder, <root>/designs/<id>/, beside the scenes:
//
//   design.json         this file
//   model.glb           Y-up, meters, origin at the floor under its center;
//                       each Part is a node named by its part id
//   thumb.png           a picture for the gallery, about 800 × 600
//   package/...         the current Draft's files
//   revisions/<letter>/ each issued Revision's files, frozen
//
// A house scene places a design as an ordinary model object; the design
// names those objects in `placements`, so the two can be found from either
// side.

export const DESIGN_FORMAT = 1

// The same rule as a project or variant name, so an id is a safe folder name.
export const DESIGN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const id = z.string().regex(DESIGN_ID, 'an id is lowercase letters, digits, and hyphens')

// A file inside the design folder, written relative to it. Nothing that
// could climb out of the folder or name another place.
const file = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((part) => part === '..' || part === '.' || part === ''), 'a file is a plain path inside the design folder, like package/drawings.pdf')

const download = z.object({ label: z.string().min(1), file })

export const DESIGN_STATUSES = ['draft', 'issued-for-review', 'issued-for-build'] as const
const status = z.enum(DESIGN_STATUSES)

export const Part = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  material: z.string().optional(),
  qty: z.number().int().positive().default(1),
  // [width, depth, height] in millimeters, as a cut list writes it.
  size_mm: z.tuple([z.number(), z.number(), z.number()]).optional(),
})

export const Revision = z.object({
  letter: z.string().regex(/^[A-Z]{1,2}$/, 'a revision is a capital letter, like A'),
  date: z.string().optional(),
  status,
  // How many open holds the drawings carry.
  holds: z.number().int().min(0).optional(),
  files: z.array(download).default([]),
})

export const Design = z.object({
  stage_design: z.literal(DESIGN_FORMAT),
  id,
  name: z.string().min(1),
  summary: z.string().default(''),
  // The scenes of this project are where it stands.
  project: id,
  rooms: z.array(id).default([]),
  placements: z.array(z.object({ room: id, object: id })).default([]),
  // [width, depth, height] in meters.
  size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  status,
  updated: z.string().optional(),
  parts: z.array(Part).default([]),
  files: z
    .object({
      model: file.default('model.glb'),
      thumbnail: file.optional(),
      package: z.array(download).default([]),
    })
    .prefault({}),
  revisions: z.array(Revision).default([]),
})

export type Design = z.infer<typeof Design>
export type DesignPart = z.infer<typeof Part>
export type DesignRevision = z.infer<typeof Revision>
export type DesignStatus = (typeof DESIGN_STATUSES)[number]

// How a person reads a status: on a chip, and in a sentence.
export const STATUS_LABEL: Record<DesignStatus, string> = {
  draft: 'Draft',
  'issued-for-review': 'Issued for review',
  'issued-for-build': 'Issued for build',
}

// The newest issued Revision, or none while the design is a first Draft.
export function latestRevision(design: Design): DesignRevision | undefined {
  return design.revisions.at(-1)
}

// The designs that stand in one room.
export function designsIn(designs: Design[], room: string): Design[] {
  return designs.filter((design) => design.rooms.includes(room))
}

// Designs by room, in the order the rooms are given, then those in a room
// the list doesn't know, then those in no room under ''. A design in two
// rooms is listed under each.
export function groupByRoom(designs: Design[], rooms: string[]): { room: string; designs: Design[] }[] {
  const order = [...rooms, ...new Set(designs.flatMap((design) => design.rooms).filter((room) => !rooms.includes(room)))]
  const groups = order.map((room) => ({ room, designs: designsIn(designs, room) })).filter((group) => group.designs.length)
  const loose = designs.filter((design) => design.rooms.length === 0)
  return loose.length ? [...groups, { room: '', designs: loose }] : groups
}

// The Part a model node belongs to. A node is named by its part id; a Part
// with qty above 1 has one node per copy, named <part-id>_1, <part-id>_2,
// and glTF loaders add the same kind of suffix to tell twin names apart.
// Loaders also drop what a node name can't hold in an animation path
// (space becomes _, and . : / [ ] go), so both sides are read that way.
export function partOfNode(nodeName: string, parts: DesignPart[]): DesignPart | undefined {
  const plain = (name: string) => name.replace(/\s/g, '_').replace(/[[\]./:]/g, '')
  const name = plain(nodeName)
  const byName = new Map(parts.map((part) => [plain(part.id), part]))
  return byName.get(name) ?? byName.get(name.replace(/_\d+$/, ''))
}
