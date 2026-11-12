# Stage as a shared server

`stage mcp` over stdio serves one person's agent on their own machine. To
reach Stage from somewhere else, such as a chat app on the web or a
phone, run it as a shared server: the MCP server over HTTP, and the viewer
beside it, both on one folder of scenes.

```sh
node bin/stage.js serve --root ./scenes --listen 127.0.0.1:4747
node bin/stage.js mcp --http 127.0.0.1:4748 --root ./scenes
```

The MCP endpoint is `http://127.0.0.1:4748/mcp` (Streamable HTTP,
stateless, JSON replies), and `/health` answers `{"stage": "<version>"}`.

## Scenes by name

A shared server never takes a file path. A scene is named
`project/variant`, in lowercase letters, digits, and hyphens, like
`house/main` or `house/open-kitchen`, and lives at
`<root>/<project>/<variant>/scene.json`. Nothing else is a name, so no
request can reach a file outside the root.

The tools are the ones in [mcp.md](mcp.md), with these differences:

- Every `scene` argument is a name, and `new_scene` takes the name too.
- `scenes` lists every scene on the server.
- `open_viewer` returns a link for the person to open, on `STAGE_PUBLIC_URL`.
- `export` takes no output path. It writes `exports/scene.glb` beside the
  scene and returns a link that downloads it from the viewer.
- Files a scene refers to, such as a level's plan drawing or a model from
  `fetch_model`, sit in the scene's folder.
- The `from-floor-plan` prompt is left out, since it reads an image on the
  server's own disk.

The viewer serves a scene by name too, at `/?scene=house/main`, and
refuses absolute paths.

Two writes to one scene take turns, so an agent that sends several `set`
calls at once loses none of them. Every write replaces the file whole.

## Settings

| Variable | Used by | What it is |
| --- | --- | --- |
| `STAGE_ALLOWED_HOSTS` | both | Host names to answer to besides localhost, comma-separated: the names a proxy in front sends. Any other `Host` gets 403. |
| `STAGE_PUBLIC_URL` | mcp | The viewer as people reach it, for the links `open_viewer` and `export` hand out. Default `http://127.0.0.1:4747`. |
| `STAGE_VIEWER_URL` | mcp | The viewer as the MCP server reaches it, for `show`. Default `http://127.0.0.1:4747`. |
| `STAGE_CHROMIUM` | mcp | The Chromium or Chrome binary for renders and exports. |
| `STAGE_CHROMIUM_FLAGS` | mcp | Extra Chromium flags, space-separated. |
| `XDG_CACHE_HOME` | both | Where the asset cache lives (`<it>/stage/assets`). |
| `POLY_PIZZA_KEY`, `SKETCHFAB_TOKEN` | mcp | Optional keys for `find_model` and `fetch_model`. |

## Docker

The image runs either process. It brings Chromium, runs as the `node` user
(uid 1000), and keeps scenes and the asset cache in `/data`.

```sh
docker build -t stage .
```

A compose file for both, published on localhost only:

```yaml
services:
  viewer:
    image: stage
    user: "1000:1000"
    volumes: ["./data:/data"]
    ports: ["127.0.0.1:4747:4747"]
    environment:
      STAGE_ALLOWED_HOSTS: viewer,viewer.example.com
    logging: { driver: local, options: { max-size: 10m, max-file: "3" } }
    restart: unless-stopped
  mcp:
    image: stage
    command: ["mcp", "--http", "0.0.0.0:4748", "--root", "/data"]
    user: "1000:1000"
    volumes: ["./data:/data"]
    ports: ["127.0.0.1:4748:4748"]
    environment:
      STAGE_ALLOWED_HOSTS: mcp.example.com
      STAGE_PUBLIC_URL: https://viewer.example.com
      STAGE_VIEWER_URL: http://viewer:4747
    logging: { driver: local, options: { max-size: 10m, max-file: "3" } }
    restart: unless-stopped
```

Fill the asset cache once, so renders use real textures and furniture
instead of stand-ins:

```sh
docker compose run --rm mcp assets fetch --all
```

An agent can also call the `fetch_assets` tool.

Chromium runs without its own sandbox in the image (`--no-sandbox` in
`STAGE_CHROMIUM_FLAGS`), because Docker's default seccomp profile refuses
the namespaces the sandbox needs. The container is the boundary, and the
only page Chromium loads is Stage's own viewer.

## Security

Stage has no sign-in of its own. Anyone who reaches the MCP port can
change every scene, and anyone who reaches the viewer can read them. Keep
both bound to localhost and put an authenticating proxy in front: an
OAuth gateway for the MCP endpoint, which is what remote MCP clients
expect, and a sign-in for the viewer. Set `STAGE_ALLOWED_HOSTS` to the
names that proxy sends, and nothing else.
