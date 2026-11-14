# Stage

![A furnished flat in Stage, seen from above](docs/overview.png)

An open-source 3D scene engine that AI agents drive and people walk through.
An agent writes one JSON scene file and checks, queries, and renders it from
the command line or over MCP. A person opens the same file in a browser,
watches it change as the agent works, and walks through it at eye level.

Two layers, used together or alone. **Objects** are anything: primitives,
glTF models, library pieces, and assemblies built from parts that move as
one, for a product, a device, a creature, a set, an explanation in space.
**Buildings** are rooms, doors, windows, stairs, and furniture, from a floor
plan or a description: walls come from room edges, levels stack, and whole
houses work, with the architect's drawing under each plan. A library of
about two hundred CC0 pieces with real sizes serves both, and the open
model libraries are a search away for everything else.

| No rooms at all: a desk, a computer, and a duck built from parts | A house from a floor plan |
| --- | --- |
| ![A desk with a monitor, a lamp, and a rubber duck made of spheres](docs/desk.jpg) | ![A double-height living room with sliding glass](docs/home-living.jpg) |

| From the front door | The bedroom |
| --- | --- |
| ![Living room at eye level](docs/living-room.png) | ![Bedroom at eye level](docs/bedroom.png) |

| The same house from the roof | A shared garden between two houses |
| --- | --- |
| ![A roof garden between two houses](docs/home-roof.jpg) | ![The garden](docs/home-garden.jpg) |

| Every camera and every room on one sheet | The plan, with sizes |
| --- | --- |
| ![Contact sheet](docs/contact-sheet.jpg) | ![Plan with room sizes](docs/plan-labels.jpg) |

## Try it in a browser

The two-storey house is live at <https://dvrshil.github.io/stage/two-storey/>
and the desk at <https://dvrshil.github.io/stage/desk/>:
press **Walk inside**, then `W` `A` `S` `D` and the mouse. No install.

## Use it with an agent

Stage is an MCP server, and that is the way to use it. Clone it, install
it, and add it to your agent from inside the folder, so the path takes
care of itself:

```sh
git clone https://github.com/dvrshil/stage
cd stage
npm install                     # also builds the viewer
node bin/stage.js assets fetch  # 40 MB of CC0 textures, models, and sky, into ~/.cache/stage

# Claude Code
claude mcp add --scope user stage -- node "$PWD/bin/stage.js" mcp

# Codex
codex mcp add stage -- node "$PWD/bin/stage.js" mcp
```

Cursor, Claude Desktop, Gemini CLI, VS Code, and any other MCP client take
the same command, `node <the folder>/bin/stage.js mcp`, in their JSON
config; [docs/mcp.md](docs/mcp.md) has each one, and the two optional keys
for the model libraries. Opening this repository itself in Claude Code
offers the server from its `.mcp.json`.

To reach Stage from another machine, such as a chat app on the web or a
phone, run it as a shared server: the MCP server over HTTP and the viewer
beside it, with scenes by name instead of by path, in Docker if you like.
[docs/server.md](docs/server.md) has the commands and the settings.

Then start a fresh session and ask: "Build me a rubber duck on a desk and
open it in my browser." Or: "Start a scene from the two-storey example,
open it, and move the sofa under the window." The agent sees every render
it asks for; you see every change in your browser as it lands.

The server carries its own guide, as its instructions and as a `guide`
tool for clients that drop instructions, so an agent that has never seen
Stage knows the format and the order of work before it starts: a group and
its parts for a thing, rooms then openings then furniture for a building,
looking at a render after each step. The tools say what they are for,
`query` and `check` answer in words that name the entity and the fix, and
`render` hands the image back into the conversation. `node
bin/stage.js skill install` also installs the guide as a skill for Claude
Code and Codex, for agents that read skills before tools.

Stage needs Node 22.18 or later (24 or later is best), and Chromium or
Chrome for headless renders; the viewer runs in any browser. Without
`assets fetch`, everything still works: textures fall back to patterns
drawn in code and furniture to pieces built from primitives.
`npm install -g .` puts a `stage` command on your path; the examples
below spell it out as `node bin/stage.js`.

For anything the library lacks, `find_model` searches the open model
libraries: Poly Haven (CC0 scans), Sketchfab (CC0 and CC-BY, the largest),
the Icosa Gallery (the Google Poly archive), and Poly Pizza (low-poly
packs). The first three need no key; Poly Pizza wants a free key in
`POLY_PIZZA_KEY`, and downloading from Sketchfab wants your free account
token in `SKETCHFAB_TOKEN`. Every fetched model lands beside the scene
with its license and author recorded, and `share` writes the credits.

## The scene file

Meters and degrees; plan coordinates `[x, y]` with x east and y north, z
up. **Objects** stand anywhere by their bottom center, turned by `facing`
(clockwise from north), `pitch`, and `roll`; a `parent` puts one in
another's frame, so an assembly moves as one. Kinds: `box`, `sphere`,
`cylinder` (a cone with `top: 0`), `plane`, `extrude` (a polygon pulled
up), `model` (any glTF beside the scene or at a URL), `asset` (a library
piece), and `group`. A material by name or a `color`, plus `roughness`,
`metalness`, `opacity`, and `glow`.

```json
{
  "stage": "0.1",
  "name": "A duck",
  "objects": [
    { "id": "duck", "kind": "group", "at": [0, 0, 0.8], "facing": 215 },
    { "id": "body", "kind": "sphere", "parent": "duck", "radius": 0.07, "scale": [1, 1.35, 0.85], "color": "#f2c21b" },
    { "id": "head", "kind": "sphere", "parent": "duck", "radius": 0.045, "at": [0, 0.05, 0.1], "color": "#f2c21b", "label": "rubber duck" },
    { "id": "beak", "kind": "cylinder", "parent": "duck", "radius": 0.018, "top": 0, "height": 0.045, "at": [0, 0.085, 0.14], "pitch": -90, "color": "#f07a1e" }
  ]
}
```

**Buildings** are rooms: floor polygons, with walls built from their edges,
shared where two rooms meet. Openings sit on a room's edge. Items are
library assets placed by their center in a room and turned by `facing`.

```json
{
  "stage": "0.1",
  "name": "One room",
  "levels": [{ "id": "ground", "height": 2.7 }],
  "rooms": [{ "id": "room", "floor": [[0, 0], [4, 0], [4, 3], [0, 3]], "materials": { "floor": "oak-plank" } }],
  "openings": [{ "id": "door", "wall": { "room": "room", "edge": 0 }, "at": 0.5, "type": "door", "width": 0.9, "height": 2.1 }],
  "items": [{ "id": "sofa", "asset": "sofa/three-seat", "room": "room", "at": [2, 2.4], "facing": 180 }]
}
```

Several floors: each level has an `elevation`, a `height`, and a floor
`slab`; rooms stack on their own, a tall room beside a short one gets the
right walls, and `well: true` leaves the hole a stair comes up through.
`grade: true` makes a split level, a few steps up or down, that stands on
the ground beside the storey instead of over it.
Stairs are items (`stairs/horseshoe`, `stairs/straight`) that a person
climbs when walking. `open: true` makes a terrace, a roof, or a garden,
with a parapet where nothing else stands. A level can carry a `plan`
image, the architect's drawing, shown under the plan view so the walls can
be checked against it; render `plan:<level>` to see one floor at a time.

`node bin/stage.js schema` prints the whole format as JSON Schema, and
`examples/` has four complete scenes: a flat, a flat with a bedroom, a
two-storey house, and the desk above, which has no rooms at all.

## Commands

Every command except `open`, `serve`, and `mcp` needs no display, takes
`--json`, exits 0 or 1, and prints errors with the entity and a fix.

| Command | Does |
| --- | --- |
| `stage new <path> [--from flat]` | Start a scene: empty, `room`, or an example |
| `stage check <scene>` | Schema, references, and spatial rules |
| `stage render <scene> -o out.png [--camera id] [--level id] [--size 1280x720]` | A deterministic image, through the same page the viewer uses; `plan:<level>` for one floor, `room:<id>` for a camera standing in any room |
| `stage render <scene> --camera object:duck:front -o duck.png` | Framed on any object, item, or room: `:front`, `:back`, `:left`, `:right`, `:top`, the corners, a bearing, and `:close` |
| `stage render <scene> --around duck -o turntable.png` | A turntable of one thing: every side, the top, and a close view on one sheet |
| `stage render <scene> --all-cameras -o sheet.png` | Every camera, and one per room, as a contact sheet |
| `stage query <scene> rooms` | Also `room <id>`, `objects`, `object <id>` (its world placement after its parents), `items in <room>`, `walls <room>`, `openings`, `cameras`, `bounds`, `adjacent <room>`, `areas [level]`, `free <room>`, `fits <asset> in <room>` |
| `stage set <scene> items '<json>'` | Add an entity, or replace the one with its id |
| `stage remove <scene> <id>` | Remove an entity |
| `stage open <scene>` | The live viewer in your browser |
| `stage show <scene> --focus <id>` | Fly every open viewer to an entity |
| `stage export <scene> -o scene.glb` | The built scene as binary glTF, for Blender or any viewer |
| `stage share <scene> -o folder` | The viewer, scene, and only the assets it needs, for any static host |
| `stage assets [words]` | Search the furniture library |
| `stage assets fetch [ids \| scene.json] [--all]` | Download the CC0 assets: the basics, what a scene uses, or everything |
| `stage models find <words> [--source s]` | Search the open model libraries for anything else: a bicycle, a dinosaur, a laptop |
| `stage models fetch <scene> <source> <id>` | Download one beside the scene, measured, ready for a `model` object |

## The viewer

**Walk inside** (or `V`) to walk at eye level: `W` `A` `S` `D` and the mouse,
`Shift` to hurry. Walls and furniture stop you. `↑` and `↓` fly up and
down, free of the floor until you land on one again. `O` is the overview, `P` the
plan, `C` the next camera, `Q` switches between high quality and fast
rendering, and clicking anything shows its id and size. The page reloads
itself when the viewer is rebuilt, keeping your view.

## Assets and licenses

Textures, furniture models, and the sky come from [Poly Haven](https://polyhaven.com),
all CC0. `assets/lock.json` pins every built-in file by checksum with its
source and real-world size; the files themselves stay in the local cache,
with on-demand extras recorded in the cache's own lock. The library is
about sixty curated pieces (`src/core/assets.ts`) plus every household
model Poly Haven publishes, measured and listed by
`scripts/grow-library.ts`. A few models are exported at the wrong scale,
so the viewer fits each one to its recorded size. A scene can also carry
its own `materials`: a color, or any Poly Haven texture set by id.

## Contributing

Issues and pull requests are welcome; [CONTRIBUTING.md](CONTRIBUTING.md)
says where things live and how to run the tests. Scenes you build are
yours; a scene that shows off something Stage does well makes a good
example.

## Development

```sh
npm test               # core: check, geometry, query, walking, formatting, assets;
                       # the scene store, and the shared server over HTTP
npm run test:render    # headless renders: determinism, and goldens for every example
npm run typecheck
```

The code is TypeScript, run directly by Node for the command line and
bundled by Vite for the viewer, which draws with Three.js. See
`src/core` for everything that needs no renderer, `src/viewer` for the
page, and `src/cli` for the commands, the server, and MCP.

## License

MIT. Assets are CC0, from Poly Haven.
