// The asset library. Pieces with a `model` use a CC0 glTF model from Poly
// Haven once `stage assets fetch` has it, and a piece built from primitives
// until then, so a scene renders either way. Sizes are width (x), depth (y),
// height (z) in meters at facing 0, front toward +y (north); for models they
// are the model's real size, which the viewer fits the model to, because a
// few models are exported at the wrong scale.

export interface AssetInfo {
  id: string
  name: string
  category: string
  size: [number, number, number]
  tags: string[]
  // A CC0 glTF model from Poly Haven, used once downloaded; the piece built
  // from primitives stands in until then. `size` is the model's own.
  model?: string
  // Turns the model so its front faces north at facing 0, in degrees.
  yaw?: number
  // Built to measure: an item's own `size` sets it (stairs, railings,
  // counters, rugs), where a model's size is fixed.
  resizable?: boolean
  // Walked over or under, never into.
  passable?: boolean
  // From the generated part of the library (generated-assets.ts): fetched
  // on demand, not by a plain `stage assets fetch`.
  generated?: boolean
}

import { GENERATED_ASSETS } from './generated-assets.ts'

const CURATED: AssetInfo[] = [
  { id: 'sofa/three-seat', model: 'sofa_02', name: 'Three-seat sofa', category: 'sofa', size: [1.81, 0.82, 0.71], tags: ['sofa', 'couch', 'living', 'seating', 'three-seat'] },
  { id: 'sofa/two-seat', model: 'Sofa_01', name: 'Two-seat sofa', category: 'sofa', size: [1.57, 0.66, 0.8], tags: ['sofa', 'couch', 'loveseat', 'living', 'seating'] },
  { id: 'chair/armchair', model: 'modern_arm_chair_01', name: 'Armchair', category: 'chair', size: [0.82, 0.99, 1.02], tags: ['chair', 'armchair', 'living', 'seating', 'reading'] },
  { id: 'chair/dining', model: 'dining_chair_02', name: 'Dining chair', category: 'chair', size: [0.43, 0.58, 0.97], tags: ['chair', 'dining', 'kitchen', 'seating'] },
  { id: 'table/dining-six', model: 'dining_table', name: 'Dining table for six', category: 'table', size: [2.26, 1.39, 0.88], tags: ['table', 'dining', 'kitchen', 'six'] },
  { id: 'table/coffee', model: 'modern_coffee_table_01', yaw: 90, name: 'Coffee table', category: 'table', size: [1.2, 0.6, 0.39], tags: ['table', 'coffee', 'living', 'low'] },
  { id: 'table/desk', model: 'metal_office_desk', name: 'Desk', category: 'table', size: [2.0, 0.95, 0.79], tags: ['desk', 'table', 'office', 'work', 'study'] },
  { id: 'table/desk-to-measure', name: 'Desk, to measure (an L-shaped desk is two: the desk and its return)', category: 'table', size: [1.6, 0.6, 0.75], resizable: true, tags: ['desk', 'table', 'office', 'work', 'study', 'return', 'l-shaped', 'corner'] },
  { id: 'bed/double', name: 'Double bed', category: 'bed', size: [1.6, 2.1, 0.95], tags: ['bed', 'double', 'queen', 'bedroom', 'sleep'] },
  { id: 'bed/single', name: 'Single bed', category: 'bed', size: [0.9, 2.0, 0.95], tags: ['bed', 'single', 'bedroom', 'kids', 'sleep'] },
  { id: 'plant/fiddle-leaf', name: 'Fiddle-leaf fig', category: 'plant', size: [0.6, 0.6, 1.6], tags: ['plant', 'tree', 'green', 'decor', 'pot'] },
  { id: 'lamp/floor', name: 'Floor lamp', category: 'lamp', size: [0.4, 0.4, 1.6], tags: ['lamp', 'light', 'floor', 'living', 'reading'] },
  { id: 'kitchen/counter-two-meter', name: 'Kitchen counter, 2 m', category: 'kitchen', size: [2.0, 0.6, 0.9], resizable: true, tags: ['kitchen', 'counter', 'cabinet', 'worktop', 'units'] },
  { id: 'kitchen/island-two-meter', name: 'Kitchen island, 2 m', category: 'kitchen', size: [2.0, 0.9, 0.9], tags: ['kitchen', 'island', 'counter', 'worktop'] },
  { id: 'kitchen/fridge', name: 'Fridge', category: 'kitchen', size: [0.7, 0.7, 1.8], tags: ['kitchen', 'fridge', 'refrigerator', 'appliance'] },
  { id: 'shelf/bookcase', model: 'steel_frame_shelves_01', name: 'Bookcase', category: 'shelf', size: [1.1, 0.5, 2.14], tags: ['shelf', 'bookcase', 'books', 'storage', 'living', 'office'] },
  { id: 'rug/area', name: 'Area rug', category: 'rug', size: [2.4, 1.7, 0.02], resizable: true, tags: ['rug', 'carpet', 'living', 'floor', 'textile'] },
  { id: 'tv/stand', name: 'TV on a stand', category: 'tv', size: [1.6, 0.45, 1.2], tags: ['tv', 'television', 'media', 'living', 'stand', 'console'] },
  { id: 'wardrobe/double', name: 'Double wardrobe', category: 'wardrobe', size: [1.2, 0.6, 2.1], resizable: true, tags: ['wardrobe', 'closet', 'storage', 'bedroom', 'clothes'] },
  { id: 'bath/toilet', name: 'Toilet', category: 'bath', size: [0.4, 0.7, 0.8], tags: ['toilet', 'wc', 'bathroom'] },
  { id: 'bath/basin', name: 'Basin on a cabinet', category: 'bath', size: [0.6, 0.5, 0.85], tags: ['basin', 'sink', 'bathroom', 'vanity'] },
  { id: 'bath/tub', name: 'Bathtub', category: 'bath', size: [1.7, 0.75, 0.6], tags: ['bath', 'tub', 'bathtub', 'bathroom'] },
  { id: 'kitchen/wall-cabinets', name: 'Wall cabinets, 2 m (hung 1.45 to 2.15 m)', category: 'kitchen', size: [2.0, 0.35, 2.15], resizable: true, tags: ['kitchen', 'cabinet', 'wall', 'upper', 'storage'] },
  { id: 'table/side', model: 'side_table_01', name: 'Side table', category: 'table', size: [0.55, 0.45, 0.55], tags: ['table', 'side', 'end', 'living', 'bedside', 'nightstand'] },
  { id: 'chair/lounge', model: 'mid_century_lounge_chair', name: 'Mid-century lounge chair', category: 'chair', size: [1.01, 1.19, 1.17], tags: ['chair', 'lounge', 'armchair', 'swivel', 'leather', 'living', 'reading'] },
  { id: 'plant/large-potted', model: 'potted_plant_02', name: 'Large potted plant', category: 'plant', size: [0.7, 0.66, 0.84], tags: ['plant', 'pot', 'green', 'decor', 'floor'] },
  { id: 'lamp/desk', model: 'desk_lamp_arm_01', name: 'Desk lamp', category: 'lamp', size: [0.2, 0.61, 0.89], tags: ['lamp', 'desk', 'light', 'office', 'study'] },
  { id: 'person/standing', name: 'Standing person, 1.75 m', category: 'person', size: [0.5, 0.3, 1.75], tags: ['person', 'human', 'people', 'figure', 'scale', 'adult'] },
  // Structure, built to measure. Stairs climb to the next level unless
  // their size gives a rise; their open side faces south at facing 0.
  { id: 'stairs/horseshoe', name: 'Horseshoe stair around a well', category: 'stairs', size: [4.6, 1.5, 3.35], resizable: true, passable: true, tags: ['stairs', 'staircase', 'horseshoe', 'winder', 'u-turn', 'floor'] },
  { id: 'stairs/straight', name: 'Straight flight of stairs', category: 'stairs', size: [1.0, 2.4, 1.0], resizable: true, passable: true, tags: ['stairs', 'steps', 'straight', 'flight', 'entrance', 'porch'] },
  { id: 'railing/glass', name: 'Glass railing with a steel handrail', category: 'railing', size: [2.0, 0.06, 1.05], resizable: true, tags: ['railing', 'balustrade', 'glass', 'handrail', 'mezzanine', 'balcony', 'void'] },
  { id: 'lift/doors', name: 'Lift doors, brushed steel', category: 'lift', size: [1.0, 0.12, 2.1], resizable: true, tags: ['lift', 'elevator', 'doors', 'steel'] },
  { id: 'wall/boundary', name: 'Freestanding wall, to measure (compound, garden, parapet)', category: 'wall', size: [3.0, 0.23, 1.5], resizable: true, tags: ['wall', 'boundary', 'compound', 'fence', 'garden', 'freestanding', 'masonry'] },
  { id: 'column/round', name: 'Round column', category: 'column', size: [0.3, 0.3, 3.0], resizable: true, tags: ['column', 'pillar', 'post', 'concrete', 'porch', 'structure'] },
  { id: 'bath/shower', name: 'Shower cubicle, glass', category: 'bath', size: [0.9, 0.9, 2.1], resizable: true, tags: ['shower', 'bathroom', 'glass', 'cubicle'] },
  { id: 'bath/jacuzzi', name: 'Jacuzzi, two seats', category: 'bath', size: [1.8, 1.8, 0.85], resizable: true, tags: ['jacuzzi', 'hot tub', 'spa', 'bath', 'whirlpool'] },
  { id: 'bath/steam-cabin', name: 'Steam cabin, glass with a bench', category: 'bath', size: [1.2, 1.2, 2.1], resizable: true, tags: ['steam', 'sauna', 'cabin', 'bathroom', 'glass'] },
  { id: 'wash/washing-machine', name: 'Washing machine', category: 'wash', size: [0.6, 0.6, 0.85], tags: ['washing', 'machine', 'laundry', 'wash', 'utility'] },
  { id: 'kitchen/counter', name: 'Kitchen counter, to measure', category: 'kitchen', size: [1.8, 0.6, 0.9], resizable: true, tags: ['kitchen', 'counter', 'worktop', 'cabinet', 'units'] },
  { id: 'wardrobe/sliding', name: 'Sliding-door wardrobe, to measure', category: 'wardrobe', size: [2.4, 0.6, 2.4], resizable: true, tags: ['wardrobe', 'closet', 'sliding', 'dress', 'storage', 'bedroom'] },
  { id: 'bed/king', name: 'King bed', category: 'bed', size: [1.8, 2.1, 0.95], tags: ['bed', 'king', 'bedroom', 'sleep', 'master'] },
  { id: 'table/round-small', name: 'Small round table', category: 'table', size: [0.7, 0.7, 0.74], tags: ['table', 'round', 'small', 'bedroom', 'corner', 'tea'] },
  { id: 'seating/floor', name: 'Floor seating: a low platform with cushions, to measure', category: 'seating', size: [2.4, 0.9, 0.45], resizable: true, tags: ['seating', 'floor', 'indian', 'cushions', 'baithak', 'platform', 'low'] },
  { id: 'theatre/recliner-row', name: 'Row of cinema recliners, to measure', category: 'theatre', size: [3.4, 1.1, 1.1], resizable: true, tags: ['theatre', 'cinema', 'recliner', 'seats', 'row', 'home theatre'] },
  { id: 'screen/projection', name: 'Projection screen, to measure', category: 'screen', size: [3.6, 0.08, 2.05], resizable: true, passable: true, tags: ['screen', 'projector', 'projection', 'cinema', 'theatre', 'wall'] },
  { id: 'tv/wall', name: 'Wall-mounted TV, 65 inch', category: 'tv', size: [1.45, 0.08, 0.84], passable: true, tags: ['tv', 'television', 'wall', 'mounted', 'bedroom', 'screen'] },
  { id: 'hut/pavilion', name: 'Garden pavilion: posts and a hipped roof, to measure', category: 'hut', size: [3.66, 3.05, 3.0], resizable: true, passable: true, tags: ['hut', 'pavilion', 'gazebo', 'meditation', 'garden', 'roof', 'shelter'] },
  { id: 'statue/buddha', name: 'Seated Buddha on a plinth', category: 'statue', size: [1.0, 1.0, 1.7], tags: ['statue', 'buddha', 'sculpture', 'garden', 'stone', 'meditation'] },
  { id: 'rock/boulder', name: 'Boulder, to measure', category: 'rock', size: [0.9, 0.7, 0.5], resizable: true, tags: ['rock', 'boulder', 'stone', 'zen', 'garden', 'landscape'] },
  { id: 'plant/shrub', name: 'Shrub, to measure', category: 'plant', size: [0.8, 0.8, 0.8], resizable: true, tags: ['shrub', 'bush', 'plant', 'hedge', 'garden', 'green'] },
  { id: 'tree/small', name: 'Small tree, to measure', category: 'tree', size: [3.0, 3.0, 4.5], resizable: true, passable: true, tags: ['tree', 'garden', 'plant', 'green', 'shade'] },
  { id: 'tree/round', name: 'Round garden tree, to measure', category: 'tree', size: [4.0, 4.0, 3.6], resizable: true, passable: true, tags: ['tree', 'round', 'garden', 'shade', 'lawn', 'broadleaf'] },
  { id: 'cabinet/sideboard', model: 'modern_wooden_cabinet', name: 'Modern wooden sideboard', category: 'cabinet', size: [2.0, 0.43, 0.56], tags: ['cabinet', 'sideboard', 'console', 'dining', 'living', 'storage', 'wood'] },
  { id: 'cabinet/credenza', name: 'Credenza, to measure', category: 'cabinet', size: [1.6, 0.5, 0.75], resizable: true, tags: ['cabinet', 'credenza', 'office', 'storage', 'low', 'wood', 'sideboard'] },
  { id: 'table/outdoor-set', model: 'outdoor_table_chair_set_01', name: 'Outdoor table with two chairs', category: 'table', size: [0.78, 1.83, 0.86], tags: ['table', 'outdoor', 'terrace', 'garden', 'chairs', 'set', 'balcony'] },
  { id: 'lamp/street', model: 'street_lamp_01', name: 'Street lamp', category: 'lamp', size: [0.7, 0.39, 3.87], tags: ['lamp', 'street', 'road', 'outdoor', 'light', 'post'] },
  { id: 'car/covered', model: 'covered_car', name: 'Car under a cover', category: 'car', size: [1.79, 4.38, 1.41], tags: ['car', 'covered', 'garage', 'parking', 'vehicle'] },
  { id: 'plant/potted-small', model: 'potted_plant_01', name: 'Potted plant, tall', category: 'plant', size: [0.59, 0.63, 1.35], tags: ['plant', 'pot', 'small', 'decor', 'shelf', 'table'] },
  { id: 'car/sedan', name: 'Sedan car', category: 'car', size: [1.8, 4.6, 1.45], tags: ['car', 'sedan', 'vehicle', 'garage', 'parking', 'drive'] },
  { id: 'bench/garden', name: 'Garden bench', category: 'bench', size: [1.5, 0.55, 0.85], tags: ['bench', 'garden', 'seat', 'outdoor', 'wood'] },
]

// The curated pieces first, then the generated ones that add something new.
export const ASSETS: AssetInfo[] = [...CURATED, ...GENERATED_ASSETS.filter((g) => !CURATED.some((c) => c.id === g.id || c.model === g.model))]

// Models the engine places itself, rather than the scene file.
export const FIXTURES = { ceilingLamp: 'modern_ceiling_lamp_01' }

export function findAsset(id: string): AssetInfo | undefined {
  return ASSETS.find((asset) => asset.id === id)
}

// Every word must match something: the id, the name, a tag, or the category.
export function searchAssets(words: string, options: { category?: string; maxSize?: [number, number, number] } = {}): AssetInfo[] {
  const terms = words.toLowerCase().split(/[\s,]+/).filter(Boolean)
  return ASSETS.filter((asset) => {
    if (options.category && asset.category !== options.category) return false
    if (options.maxSize && asset.size.some((dimension, i) => dimension > options.maxSize![i])) return false
    const haystack = [asset.id, asset.name, asset.category, ...asset.tags].join(' ').toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}
