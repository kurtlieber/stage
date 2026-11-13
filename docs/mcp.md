# Stage as an MCP server

`stage mcp` speaks the Model Context Protocol over stdio. Any MCP client
can start it; the command is the same everywhere:

```
node <the stage folder>/bin/stage.js mcp
```

Run the add commands below from inside the folder you cloned, and `$PWD`
fills the path in. Once the package is on npm, `npx -y stage-engine mcp`
does the same without a clone.

## Clients

**Claude Code**

```sh
cd stage
claude mcp add --scope user stage -- node "$PWD/bin/stage.js" mcp
```

A project can also carry it: this repository's `.mcp.json` starts the server
from the checkout when you open it in Claude Code.

**Codex**

```sh
cd stage
codex mcp add stage -- node "$PWD/bin/stage.js" mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.stage]
command = "node"
args = ["/path/to/stage/bin/stage.js", "mcp"]
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor**
(`.cursor/mcp.json` or the global one), **Gemini CLI**
(`~/.gemini/settings.json`), and most other clients:

```json
{
  "mcpServers": {
    "stage": {
      "command": "node",
      "args": ["/path/to/stage/bin/stage.js", "mcp"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`) uses `servers` instead of `mcpServers`,
with the same `command` and `args`.

Renders need Chromium or Chrome on the machine; set `STAGE_CHROMIUM` to its
path if it is somewhere unusual.

**Model search keys.** `find_model` searches Poly Haven, Sketchfab and the
Icosa Gallery with no key. Two more things need free keys in the server's
environment: `POLY_PIZZA_KEY` (an app key from poly.pizza/settings/api)
turns on Poly Pizza, and `SKETCHFAB_TOKEN` (your API token from
sketchfab.com/settings/password) lets Sketchfab models be downloaded, not
just found. In a JSON config they go in `env`:

```json
{
  "mcpServers": {
    "stage": {
      "command": "node",
      "args": ["/path/to/stage/bin/stage.js", "mcp"],
      "env": { "POLY_PIZZA_KEY": "...", "SKETCHFAB_TOKEN": "..." }
    }
  }
}
```

With Claude Code: `claude mcp add --scope user -e POLY_PIZZA_KEY=... -e SKETCHFAB_TOKEN=... stage -- node "$PWD/bin/stage.js" mcp`. With Codex, add an `[mcp_servers.stage.env]` table with the two keys to `~/.codex/config.toml`.

## What the server exposes

**Instructions.** The agent guide (`src/skill.md`) is sent as the server's
instructions at startup, so a client that shows them to the model knows
the scene format, free objects and assemblies, how several floors work,
and the order of work (rooms, then openings, then furniture, or a group
and its parts, rendering and looking after each step)
before its first call. Some clients never show the model either
instructions or resources (claude.ai is one), so the same text is also the
`guide` tool, listed first, whose description tells the model to call it
before any other Stage tool. The `stage://guide` resource carries the guide
too, and `stage skill install` puts it where Claude Code and Codex read
skills.

**Tools.** Each one says what it is for and what to call next; `set` carries
an example entity for every collection, `query` lists its questions, and
`assets` lists its categories.

| Tool | Does |
| --- | --- |
| `guide` | The server instructions as a tool result, for clients that drop instructions |
| `new_scene` | Start a scene, empty or from an example |
| `open_viewer` | Open it in the person's browser; the page follows the file |
| `show` | Point their view at a camera, a level, or an entity |
| `check` | Schema, references, and spatial rules, each with its fix |
| `render` | An image of any camera, `room:<id>`, `plan:<level>`, `object:<id>` framed from any side, a turntable `around` one thing, or a contact sheet |
| `query` | Rooms, a room's edges and neighbors, objects and where they ended up, what fits where, free space, areas |
| `set`, `remove`, `write_scene` | Change the file; every write is checked and reported |
| `read_scene` | The whole file, when query is not enough |
| `assets`, `fetch_assets`, `materials` | The library, downloading what a scene needs, the surfaces |
| `find_model`, `fetch_model` | Search the open model libraries with thumbnails; fetch one beside the scene and place it |
| `schema` | The format as JSON Schema, whole or per collection |
| `export` | The built scene as binary glTF |
| `calibrate_plan` | Fit a level's drawing to scale from one labeled dimension, checked against others |

**Resources.** `stage://guide` (the guide), `stage://schema` (the format),
and `stage://examples/<name>` for `flat`, `flat-with-bedroom`, `two-storey`,
and `desk` (no rooms: free objects with parents).

**Prompts.** `from-floor-plan` (a plan image and a path in, a walkable home
out) and `furnish` (one room, laid out with pieces that fit).

## What an agent sees

Writes land in the file the person's browser is watching, so the page
updates the moment a tool returns and outlines what changed. `render`
returns the PNG in the tool result, so the model looks at it in the same
turn. `check` and `query` answer in words that name entities and fixes,
which is what lets a model that has never seen Stage fix its own mistakes.
