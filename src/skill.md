---
name: stage
description: |
  Build and change 3D scenes with Stage: any objects (primitives, glTF
  models, library pieces, assemblies with parents) and any buildings (rooms,
  doors, stairs, furniture from a floor plan), that a person walks through in
  their browser. Use for any request to make, show, or explain something in
  3D: a home or a floor plan, a product, a device, a creature, a diagram in
  space, a set.
---

# Stage

A Stage scene is one JSON file. You write it with `set`, `remove`, or
`write_scene` (or `stage set` on the command line); `check` validates it;
`render` returns an image you look at; `query` answers questions so you
never need to reread the file. A person may have the scene open in their
browser: it updates the moment you write, and outlines what you changed.

Two layers, used together or alone. `objects` are free things anywhere:
primitives, models, library pieces, and groups of them, for a product, a
creature, a machine, an explanation. `rooms` and what hangs on them are
buildings: walls come from room edges, doors sit on edges, furniture
stands in rooms, levels stack. A scene with no rooms is fine.

## Start

- A new scene: `new_scene` (`empty` for a thing, `room` for a building,
  or an example when the person wants something to react to), then
  `open_viewer` right away so they watch it take shape. With no path
  given, use `~/stage-scenes/<name>/scene.json`.
- An existing scene: `check` it, then `query "rooms"` and `query "objects"`
  for the lay of the land. `read_scene` only when you must; `query` is
  cheaper.
- Not a building? Skip rooms entirely and build with `objects` (below).
- Before the first `render` of a scene with library pieces, `fetch_assets`
  with the scene once, so the picture shows the real models and surfaces.
- The tools: `new_scene`, `open_viewer`, `show` (fly the person's view),
  `check`, `render` (an image you look at), `query`, `set`, `remove`,
  `write_scene`, `read_scene`, `assets`, `fetch_assets`, `find_model`,
  `fetch_model`, `materials`, `schema`, `export` (glTF), `calibrate_plan`
  (fit a level's drawing to scale). Resources `stage://guide`, `stage://schema`,
  and `stage://examples/<name>` hold this guide, the format, and the
  example scenes.

## The format

- Meters and degrees. Plan coordinates `[x, y]`: x east, y north.
- `rooms`: `floor` is a polygon of corners. Edge n runs from `floor[n]` to
  `floor[n+1]` (the last edge closes back to the first corner). Rooms that
  share an edge share one wall; walls are built for you.
- `openings`: on `{ "room": id, "edge": n }`, starting `at` meters along that
  edge from `floor[n]`. `type` is door, window, opening (a stretch of
  missing wall), or slider (a sliding glass door from the floor up, its
  middle panels standing open). Windows take a `sill` height (default 0.9).
- `items`: an `asset` from the library (`assets` tool), placed by its center
  `at` [x, y] in a `room`, rotated by `facing` (0 = its front faces north,
  90 = east, 180 = south). An unknown asset with a `size` [w, d, h] renders
  as a labeled box, so you can lay out first and resolve later.
- `cameras`: `plan` and `orbit` always exist. Add perspective cameras with
  `at` [x, y, z] and `look` [x, y, z]; z is absolute: a level's elevation
  plus 1.6 is eye height there.
- Ids are lowercase with hyphens and unique across the file.

## Free objects

- `objects`: each has a `kind` with its own fields, and stands anywhere.
  `at` [x, y, z] is where its bottom center is (z up); `facing` turns it
  clockwise from north, `pitch` lifts its front, `roll` drops its right
  side; `scale` is one number or [x, y, z].
- Kinds: `box` (`size` [w, d, h]), `sphere` (`radius`), `cylinder`
  (`radius`, `height`; `top` 0 makes a cone, another radius a frustum),
  `plane` (`size` [w, d], lies flat, face up), `extrude` (`polygon` in its
  own plan coordinates, pulled up `height`), `model` (`file`: a .glb or
  .gltf beside the scene, or an https URL; `size` fits it, else its own
  scale), `asset` (a library piece by id, outside the rooms), `group`
  (nothing to see, something to hang parts on).
- `parent`: the object stands in that object's frame, so a thing built from
  parts moves, turns and scales as one. A duck is a group with spheres and
  a cone as children; move the group. Up to any depth.
- Looks: `material` by name (built-in or the scene's own), or `color`;
  `roughness`, `metalness`, `opacity`, and `glow` (emits that color: a
  screen, a lamp) on top.
- `solid` (default true) stops a person and counts in the overlap check;
  parts of one assembly may touch. Every flat top within a step is
  something to stand on; a `plane` is only that, never in the way.
- `label` floats text above it, for a scene that explains itself. Labels
  step aside in `object:` views, so they never cover the thing inspected.
- `room` stands it on that room's floor; without one, z counts from the
  ground. With no rooms at all, the ground holds the person up.
- `query "objects"` lists every object with its world position, yaw and
  size after its parents' turns; `query "object <id>"` adds its box and
  children. Build a thing, query it, render it, and compare the two.
- Build order for a thing: a `group` at its place, the biggest part first,
  then the rest in the group's frame. Then look at it: `render` with
  camera `object:<id>` frames it (with `:front`, `:left`, `:top`, a
  bearing like `:120`, and `:close` for a tight crop; `:top` puts a
  thing's front at the bottom, and a room's north at the top), and `around: <id>`
  renders a turntable of every side, the top, and a close view as one
  sheet. Nothing you build is done until you have looked at its turntable
  and fixed what is wrong: a part floating, a face the wrong way, a beak
  on the back of the head.
- Something the library lacks (a bicycle, a dinosaur, a laptop, a tree):
  `find_model` searches the open model libraries (Poly Haven's CC0 scans,
  Sketchfab, the Icosa Gallery, Poly Pizza when its key is set) and shows
  thumbnails;
  look at them, then `fetch_model` with `place` puts the one you pick in
  the scene as a `model` object, measured, with its license and author
  recorded. Search first; build from primitives when nothing fits or the
  thing is simple and geometric; never guess at a file that is not there.
  A fetched model that measures meters across when it should be
  centimeters came in the wrong units: give it a `size`.

## Several floors

- `levels`: each has `elevation` (its floor), `height` (floor to ceiling),
  and `slab` (its floor slab, below the elevation). Put the next level at
  elevation + height + slab. A room's `level` places it; a room on the
  lowest level with closed rooms stands on the ground, plinth and all.
- A split level, a few steps up or down within the storey on the ground (a
  sunken living room, a raised wing, a porch): give it `grade: true`. It
  stands on the ground beside the other levels, not over them: its walls go
  down to the ground and a raised floor is solid down to it. Give it the
  `height` that puts its ceiling where its neighbors' is.
- Nothing is drawn below the ground at 0. When a drawing marks floors below
  its ±0.00, put the lowest at 0, raise the rest by as much, and name each
  level by the drawing's own mark.
- Rooms on different levels may share edges: walls stack on their own. A
  tall room (`height` of two floors) beside a normal one gets the right wall
  above its neighbor's ceiling.
- `well: true` on a room draws no floor: the hole a stair comes up through,
  on every level above the one it starts on. `ceiling: false` leaves the
  room below it open. The stair itself is an item: `stairs/horseshoe` (up
  the west side, across the north, down the east, around a well; its open
  side faces south at facing 0) or `stairs/straight`. Give it a `size`
  [width, depth, rise]; the rise is the floor-to-floor height.
- Walls are 23 cm outside and 11.5 cm between rooms. A room's `thickness`
  makes all of its walls at least that thick (a lift shaft, a hall that
  shares a house's outside wall).
- `materials` (optional): the scene's own surfaces, used by name like the
  built-in ones: `{ "id": "lime-plaster", "color": "#e9e2d3", "roughness": 0.9 }`,
  or with `"texture": "<Poly Haven texture id>"` and `"size"` meters per
  repeat for a photographed set (fetch it with `fetch_assets` first; until
  then it renders as the color).
- `open: true` is outdoors: a terrace, a roof, a garden, a drive. No ceiling;
  a `parapet` (default 1 m, 0 for none) on edges that touch nothing; no wall
  at all where two open rooms meet. Outdoor floors: grass, pavers,
  paving-stone, gravel, asphalt, deck, concrete.
- A level may carry a `roof`: `{ "kind": "gable", "pitch": 30, "overhang": 0.4 }`
  puts a pitched roof over its rooms, ridge along their longer side; the
  top is flat without it.
- A level may carry a `plan`: `{ "image": "plans/first.jpg", "scale":
  <pixels per meter>, "origin": [px, py] }`, the drawing under the plan
  view, with `origin` the pixel at plan [0, 0]. Don't work the numbers
  out by hand: `calibrate_plan` takes the two ends of one labeled dimension
  on the drawing and its length, checks the scale against every other
  dimension you give it, and writes `plan` only when they all agree within
  1%. Calibrate on the longest dimension you can read. Render camera
  `plan:<level>` to see that level's walls over its drawing; `render` and
  `show` also take a `level`, which hides everything above it.
- Items built to measure (stairs, railings, counters, wardrobes, rugs,
  walls, columns, screens) take their own `size`; the rest have fixed sizes
  and `scale`.

## How to work

1. A building: rooms first. Get their sizes and how they connect right,
   then `check` and `render` with camera `plan`. Look at the image before
   going on. A thing: its group and biggest part first, then `render`
   `orbit` and look.
2. Doors, openings, windows. `check` names any opening that does not fit its
   wall and says what to change.
3. Furniture. `query "room <id>"` gives each edge's direction, its neighbor,
   and its openings; `query "fits <asset> in <room>"` names positions where
   a piece stands clear of doors and other pieces, back to a wall; `query
   "free <room>"` gives the clear floor and the longest free run along each
   wall. Put a piece's back against a wall by facing it away from that
   wall. `check` reports pieces that run into each other, wardrobes and
   cabinets without room to open, and things standing on windows.
4. Render `orbit` and a camera at eye level, or `sheet: true` for every
   camera and one standing in each room at once; `object:<id>` and
   `around` for one thing from every side. Fix what looks wrong. Call
   `fetch_assets` with the scene once, so renders show the real models and
   photographed surfaces instead of stand-ins.
5. When a person is watching, use `show` to fly their view to what you are
   describing, and keep each change small so they can follow along.

Keep edits small and use `query` instead of reading the whole file.
