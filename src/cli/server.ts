import { createReadStream, existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SceneStore } from '../core/scene-store.ts'
import { CACHE, availableLock } from './assets.ts'

// Serves the built viewer, the scene files it asks for, and a stream of
// changes, so the browser updates the moment an agent writes the file.
// Bound to 127.0.0.1 by default, and it checks the Host header, so no web
// page elsewhere can read a scene through it. Given a store of named scenes,
// it serves those scenes only, and may answer to the host names a proxy in
// front of it sends.

export const VERSION = '0.1.0'
export const DEFAULT_PORT = Number(process.env.STAGE_PORT ?? 4747)
export const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.hdr': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.svg': 'image/svg+xml',
}

// The scene's folder as a path segment: a glTF's textures and buffers are
// named relative to the glTF, so they must sit at sibling URLs.
export const sceneToken = (scenePath: string) => Buffer.from(scenePath).toString('base64url')
const fromToken = (token: string) => Buffer.from(token, 'base64url').toString()

const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/

// Whether a request's Host header is one this server answers to: localhost,
// or one of `extra` (host names, any port).
export function hostAllowed(host: string, extra: readonly string[] = []): boolean {
  if (LOCAL_HOST.test(host)) return true
  const name = host.toLowerCase().replace(/:\d+$/, '')
  return name !== '' && extra.includes(name)
}

// STAGE_ALLOWED_HOSTS: host names, comma-separated, that a server of named
// scenes answers to besides localhost; the deployment's, so they stay out of
// the code.
export function allowedHostsFromEnv(): string[] {
  return (process.env.STAGE_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
}

// "0.0.0.0:4747", ":4747", or "4747" (on 127.0.0.1).
export function parseListen(value: string): { host: string; port: number } {
  const match = /^(?:(.*):)?(\d+)$/.exec(value.trim())
  const port = Number(match?.[2])
  if (!match || !Number.isInteger(port) || port > 65535) throw new Error(`expected host:port, like 127.0.0.1:4747; got "${value}"`)
  return { host: match[1] || '127.0.0.1', port }
}

export interface ServeOptions {
  /** The address to bind; 127.0.0.1 by default. */
  host?: string
  /** Serve the scenes of this store by name, and no file outside it. */
  store?: SceneStore
  /** With a store: host names to answer to besides localhost. */
  allowedHosts?: readonly string[]
}

interface Channel {
  clients: Set<ServerResponse>
  watcher?: FSWatcher
  timer?: NodeJS.Timeout
}

export interface StageServer {
  url: string
  port: number
  close(): Promise<void>
}

// The stamp vite writes into each build, so open pages can tell they are stale.
function buildStamp(): string {
  try {
    return /name="stage-build" content="([^"]*)"/.exec(readFileSync(join(DIST, 'index.html'), 'utf8'))?.[1] ?? ''
  } catch {
    return ''
  }
}

export async function startServer(port = DEFAULT_PORT, options: ServeOptions = {}): Promise<StageServer> {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(`the viewer is not built; run: npm run build (in ${resolve(DIST, '..')})`)
  }
  const { store } = options
  const extraHosts = store ? (options.allowedHosts ?? []) : []
  // The scene file a request names: an absolute path, or with a store, a
  // scene name. Undefined for anything else.
  const locate = (value: string | null): string | undefined => {
    if (!store) return scenePath(value)
    try {
      return value ? store.locate(value) : undefined
    } catch {
      return undefined
    }
  }
  const channels = new Map<string, Channel>()
  let stamp = buildStamp()
  let rebuildTimer: NodeJS.Timeout | undefined
  // A rebuild of the viewer tells every open page to reload.
  const distWatcher = watch(DIST, () => {
    clearTimeout(rebuildTimer)
    rebuildTimer = setTimeout(() => {
      const next = buildStamp()
      if (!next || next === stamp) return
      stamp = next
      for (const c of channels.values()) for (const client of c.clients) client.write(`event: hello\ndata: ${JSON.stringify({ build: stamp })}\n\n`)
    }, 300)
  })

  const channel = (path: string): Channel => {
    let c = channels.get(path)
    if (!c) {
      c = { clients: new Set() }
      channels.set(path, c)
    }
    if (!c.watcher && existsSync(dirname(path))) {
      // Watch the directory: an atomic save replaces the file, which ends a
      // watch on the file itself.
      c.watcher = watch(dirname(path), (_event, name) => {
        if (name !== basename(path)) return
        clearTimeout(c!.timer)
        c!.timer = setTimeout(() => broadcast(path, 'change', {}), 60)
      })
    }
    return c
  }

  const broadcast = (path: string, event: string, data: unknown) => {
    for (const client of channel(path).clients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const server = createServer(async (request, response) => {
    try {
      await handle(request, response)
    } catch (error) {
      send(response, 500, { error: (error as Error).message })
    }
  })

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host ?? ''
    if (!hostAllowed(host, extraHosts)) return send(response, 403, { error: 'stage only answers on localhost' })
    const url = new URL(request.url ?? '/', `http://${host}`)

    if (url.pathname === '/api/health') return send(response, 200, { stage: VERSION, pid: process.pid })

    // Downloaded CC0 textures and skies, from the local cache.
    if (url.pathname === '/api/library') return send(response, 200, await availableLock())
    if (url.pathname.startsWith('/library/')) {
      const file = normalize(join(CACHE, decodeURIComponent(url.pathname.slice('/library/'.length))))
      if (!file.startsWith(CACHE) || !existsSync(file)) return send(response, 404, { error: 'not in the asset cache; run: stage assets fetch' })
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=31536000, immutable' })
      createReadStream(file).pipe(response)
      return
    }

    // /files/<scene token>/<relative path>: a file beside the scene, at a
    // URL whose siblings are the file's siblings.
    const sibling = /^\/files\/([A-Za-z0-9_-]+)\/(.+)$/.exec(url.pathname)
    if (sibling) {
      const scene = locate(fromToken(sibling[1]))
      if (!scene) return send(response, 404, { error: 'no such scene' })
      const folder = dirname(scene)
      const file = normalize(join(folder, decodeURIComponent(sibling[2])))
      if (!file.startsWith(folder + '/') || !existsSync(file) || statSync(file).isDirectory()) return send(response, 404, { error: 'no such file beside the scene' })
      response.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      createReadStream(file).pipe(response)
      return
    }

    if (url.pathname.startsWith('/api/')) {
      const path = locate(url.searchParams.get('path'))
      if (!path) return send(response, 400, { error: store ? 'path must be a scene name, project/variant' : 'path must be an absolute path to a .json scene file' })

      if (url.pathname === '/api/scene') {
        try {
          const text = await readFile(path, 'utf8')
          return send(response, 200, { scene: JSON.parse(text) })
        } catch (error) {
          const name = url.searchParams.get('path')!
          return send(response, 200, { error: `${name}: ${(error as Error).message.replaceAll(path, name)}` })
        }
      }

      // A file the scene names, like a level's plan drawing, from beside it.
      if (url.pathname === '/api/file') {
        const folder = dirname(path)
        const file = normalize(join(folder, url.searchParams.get('file') ?? ''))
        if (!file.startsWith(folder + '/') || !existsSync(file) || statSync(file).isDirectory()) return send(response, 404, { error: 'no such file beside the scene' })
        response.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
        createReadStream(file).pipe(response)
        return
      }

      if (url.pathname === '/api/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        response.write(': connected\n\n')
        response.write(`event: hello\ndata: ${JSON.stringify({ build: stamp })}\n\n`)
        const c = channel(path)
        c.clients.add(response)
        const ping = setInterval(() => response.write(': ping\n\n'), 15000)
        request.on('close', () => {
          clearInterval(ping)
          c.clients.delete(response)
        })
        return
      }

      if (url.pathname === '/api/control' && request.method === 'POST') {
        const body = await readBody(request)
        const viewers = channel(path).clients.size
        broadcast(path, 'control', JSON.parse(body || '{}'))
        return send(response, 200, { ok: true, viewers })
      }

      return send(response, 404, { error: 'no such endpoint' })
    }

    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
    let file = join(DIST, relative === '/' ? 'index.html' : relative)
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    createReadStream(file).pipe(response)
  }

  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(port, host, () => done())
  })
  const address = server.address()
  const actual = typeof address === 'object' && address ? address.port : port
  return {
    url: `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${actual}`,
    port: actual,
    close: async () => {
      distWatcher.close()
      for (const c of channels.values()) {
        c.watcher?.close()
        for (const client of c.clients) client.end()
      }
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

function scenePath(value: string | null): string | undefined {
  if (!value || !isAbsolute(value) || !value.endsWith('.json')) return undefined
  return resolve(value)
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => done(body))
    request.on('error', fail)
  })
}

export function viewerUrl(base: string, scene: string, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({ scene: resolve(scene), ...extra })
  return `${base}/?${query}`
}

export async function healthy(port = DEFAULT_PORT): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) })
    return response.ok && ((await response.json()) as { stage?: string }).stage !== undefined
  } catch {
    return false
  }
}
