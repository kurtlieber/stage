import { z } from 'zod'

// The scene format, version 0.1. Everything an agent writes is validated
// here first, so an error names the exact entity and field.
//
// Conventions: meters and degrees. Positions are plan coordinates [x, y] on
// the floor, x east and y north, plus an elevation. `facing` 0 points north
// and 90 east. Every entity has a lowercase id, unique in the file.

export const FORMAT_VERSION = '0.1'

const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'an id is lowercase letters, digits, and hyphens')

const point = z.tuple([z.number(), z.number()])
const point3 = z.tuple([z.number(), z.number(), z.number()])

// A drawing of the level, shown under the plan view so the walls can be
// checked against it. `scale` is pixels per meter and `origin` the pixel
// that sits at plan [0, 0]; image rows run down, plan y runs north.
export const Plan = z.object({
  image: z.string().describe('Image file, relative to the scene file'),
  scale: z.number().positive(),
  origin: point.default([0, 0]),
  opacity: z.number().min(0).max(1).default(0.55),
})

export const Level = z.object({
  id,
  name: z.string().optional(),
  elevation: z.number().default(0),
  // Floor to ceiling. The next level's floor slab sits on top of that.
  height: z.number().positive().default(2.7),
  // Thickness of this level's floor slab, below its elevation. Walls of
  // the level below rise through it; the lowest level has none.
  slab: z.number().min(0).default(0.15),
  // A split level of the storey on the ground, a few steps up or down from
  // it (a sunken living room, a raised wing): it stands on the ground beside
  // the other levels, not over them.
  grade: z.boolean().default(false),
  plan: Plan.optional(),
  // A pitched roof over this level's rooms, ridge along their longer side;
  // without it the top is flat. `pitch` in degrees, `overhang` in meters.
  roof: z.object({ kind: z.enum(['flat', 'gable']).default('gable'), pitch: z.number().min(5).max(70).default(30), overhang: z.number().min(0).default(0.4) }).optional(),
})

export const Room = z.object({
  id,
  level: id.default('ground'),
  name: z.string().optional(),
  floor: z.array(point).min(3, 'a floor needs at least three corners'),
  height: z.number().positive().optional(),
  // Outdoors: no ceiling, and its own edges get a parapet instead of a
  // wall. A terrace, a garden, a driveway.
  open: z.boolean().default(false),
  parapet: z.number().min(0).default(1),
  // A well has no floor: the hole a stair comes up through, or a void over
  // a tall room below.
  well: z.boolean().default(false),
  // Walls of this room are at least this thick (m), even where another room
  // shares them: a lift shaft, or a hall that borrows a house's outside wall.
  thickness: z.number().min(0.05).optional(),
  // No ceiling: a stairwell under a well, or a room open to the one above.
  ceiling: z.boolean().default(true),
  materials: z
    .object({
      floor: z.string().optional(),
      walls: z.string().optional(),
      ceiling: z.string().optional(),
    })
    .optional(),
})

// An opening sits on edge n of a room, which runs from floor[n] to
// floor[n+1]; `at` is measured along that edge from floor[n].
export const Opening = z.object({
  id,
  wall: z.object({ room: id, edge: z.number().int().min(0) }),
  at: z.number().min(0),
  // A slider is a sliding glass door from the floor up; its middle panels
  // stand open.
  type: z.enum(['door', 'window', 'opening', 'slider']),
  width: z.number().positive(),
  height: z.number().positive(),
  sill: z.number().min(0).optional(),
  swing: z.enum(['in-left', 'in-right', 'out-left', 'out-right']).optional(),
})

export const Item = z.object({
  id,
  asset: z.string(),
  room: id,
  at: point,
  facing: z.number().default(0),
  // Above the room's floor.
  elevation: z.number().default(0),
  // Width (x), depth (y), height (z) in meters. Builds a labeled box for an
  // unknown asset, and sizes the library pieces that are made to measure
  // (stairs, railings, counters, rugs).
  size: point3.optional(),
  scale: z.number().positive().default(1),
})

export const Light = z.object({
  id,
  type: z.enum(['sun', 'point']),
  azimuth: z.number().default(220),
  elevation: z.number().default(35),
  intensity: z.number().min(0).default(1),
  color: z.string().optional(),
  at: point3.optional(),
})

export const Camera = z.object({
  id,
  type: z.enum(['perspective', 'plan', 'orbit']).default('perspective'),
  at: point3.optional(),
  look: point3.optional(),
  // Vertical degrees. 55 is about a 24 mm lens on full frame: wide enough
  // for a room, without the stretching of anything wider.
  fov: z.number().min(10).max(150).default(55),
  // For plan and orbit cameras: show this level and the ones below it.
  level: id.optional(),
})

// A material of the scene's own: a color, or a photographed texture set
// from Poly Haven by its id, mapped at `size` meters per repeat (the set's
// own measured size when left out). `tint` paints over the photograph,
// `shade` multiplies it.
export const CustomMaterial = z.object({
  id,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a color like #a0b0c0'),
  roughness: z.number().min(0).max(1).default(0.8),
  metalness: z.number().min(0).max(1).default(0),
  texture: z.string().optional(),
  size: z.number().positive().optional(),
  tint: z.boolean().optional(),
  shade: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
})

// A free object: a primitive, a polygon pulled up, a glTF model, a library
// piece, or an empty group to hang others on. Anywhere in the world, with
// nothing to do with rooms unless `room` puts its origin on that room's
// floor. `at` is where its bottom center stands; `facing` turns it
// clockwise from north, `pitch` lifts its front, `roll` drops its right
// side. With a `parent`, all of that is in the parent's own frame, so a
// thing built from parts moves as one.
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a color like #a0b0c0')
const objectBase = {
  id,
  name: z.string().optional(),
  // Text floating above the object, for a scene that explains something.
  label: z.string().optional(),
  parent: id.optional(),
  room: id.optional(),
  at: point3.default([0, 0, 0]),
  facing: z.number().default(0),
  pitch: z.number().default(0),
  roll: z.number().default(0),
  scale: z.union([z.number().positive(), point3]).default(1),
  // A built-in or scene material by name, or a plain color.
  material: z.string().optional(),
  color: hex.optional(),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  opacity: z.number().min(0).max(1).optional(),
  // Emits this color: a screen, a lamp, a hot thing.
  glow: hex.optional(),
  // Stops a person walking and counts in the overlap check. A plane never
  // blocks; its top is something to stand on, like every flat top.
  solid: z.boolean().default(true),
}
export const SceneObject = z.discriminatedUnion('kind', [
  z.object({ ...objectBase, kind: z.literal('box'), size: point3.describe('[width, depth, height] in meters') }),
  z.object({ ...objectBase, kind: z.literal('sphere'), radius: z.number().positive() }),
  // A cone when `top` is 0, a frustum between.
  z.object({ ...objectBase, kind: z.literal('cylinder'), radius: z.number().positive(), height: z.number().positive(), top: z.number().min(0).optional() }),
  z.object({ ...objectBase, kind: z.literal('plane'), size: point.describe('[width, depth] in meters; lies flat, face up') }),
  // A polygon in the object's own plan coordinates, pulled up `height`.
  z.object({ ...objectBase, kind: z.literal('extrude'), polygon: z.array(point).min(3), height: z.number().positive() }),
  // A glTF or glb file beside the scene, or an https URL. With a `size`
  // the model is fitted into it; without, it keeps its own scale.
  z.object({
    ...objectBase,
    kind: z.literal('model'),
    file: z.string(),
    size: point3.optional(),
    // Where it came from and whose it is, kept with the scene so a shared
    // bundle can credit the author.
    source: z.string().optional(),
    license: z.string().optional(),
    credit: z.string().optional(),
  }),
  // A piece from the library, outside the room system.
  z.object({ ...objectBase, kind: z.literal('asset'), asset: z.string(), size: point3.optional() }),
  z.object({ ...objectBase, kind: z.literal('group') }),
])

export const Scene = z.object({
  stage: z.literal(FORMAT_VERSION),
  name: z.string().min(1),
  units: z.literal('m').default('m'),
  // A scene needs no rooms at all: free objects stand on the ground at
  // z = 0. A room's floor sits on its level.
  levels: z.array(Level).prefault([{ id: 'ground' }]),
  rooms: z.array(Room).default([]),
  openings: z.array(Opening).default([]),
  items: z.array(Item).default([]),
  objects: z.array(SceneObject).default([]),
  lights: z.array(Light).default([]),
  cameras: z.array(Camera).default([]),
  materials: z.array(CustomMaterial).default([]),
})

export type Scene = z.infer<typeof Scene>
export type Level = z.infer<typeof Level>
export type Plan = z.infer<typeof Plan>
export type Room = z.infer<typeof Room>
export type Opening = z.infer<typeof Opening>
export type Item = z.infer<typeof Item>
export type Light = z.infer<typeof Light>
export type Camera = z.infer<typeof Camera>
export type CustomMaterial = z.infer<typeof CustomMaterial>
export type SceneObject = z.infer<typeof SceneObject>
export type ObjectKind = SceneObject['kind']

// The order keys are written in, so a formatted file reads top-down the
// way the schema does and a diff shows only real changes.
export const KEY_ORDER: Record<string, string[]> = {
  scene: ['stage', 'name', 'units', 'levels', 'rooms', 'openings', 'items', 'objects', 'lights', 'cameras', 'materials'],
  level: ['id', 'name', 'elevation', 'height', 'slab', 'grade', 'plan', 'roof'],
  plan: ['image', 'scale', 'origin', 'opacity'],
  room: ['id', 'level', 'name', 'floor', 'height', 'open', 'parapet', 'well', 'ceiling', 'thickness', 'materials'],
  opening: ['id', 'wall', 'at', 'type', 'width', 'height', 'sill', 'swing'],
  item: ['id', 'asset', 'room', 'at', 'facing', 'elevation', 'size', 'scale'],
  object: ['id', 'kind', 'name', 'label', 'parent', 'room', 'at', 'facing', 'pitch', 'roll', 'scale', 'size', 'radius', 'top', 'height', 'polygon', 'file', 'source', 'license', 'credit', 'asset', 'material', 'color', 'roughness', 'metalness', 'opacity', 'glow', 'solid'],
  light: ['id', 'type', 'azimuth', 'elevation', 'intensity', 'color', 'at'],
  camera: ['id', 'type', 'at', 'look', 'fov', 'level'],
  material: ['id', 'color', 'roughness', 'metalness', 'texture', 'size', 'tint', 'shade'],
}

export const COLLECTIONS = ['levels', 'rooms', 'openings', 'items', 'objects', 'lights', 'cameras', 'materials'] as const
export type Collection = (typeof COLLECTIONS)[number]

export function jsonSchema(): unknown {
  return z.toJSONSchema(Scene)
}
