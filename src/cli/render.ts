import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, viewerUrl, type StageServer } from './server.ts'

// Headless renders go through the real viewer page in headless Chromium,
// driven over the DevTools protocol, so an agent's image and a person's
// screen never disagree. No browser download: it uses the system Chromium.

export function findChromium(): string {
  const candidates = [process.env.STAGE_CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
  const found = candidates.find((path) => path && existsSync(path))
  if (!found) throw new Error('rendering needs Chromium or Chrome; install one (omarchy-pkg-add chromium) or set STAGE_CHROMIUM')
  return found
}

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string }

class Devtools {
  private next = 1
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private listeners: ((message: Message) => void)[] = []
  private socket: WebSocket

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Message
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) waiting?.reject(new Error(message.error.message))
        else waiting?.resolve(message.result)
      } else {
        for (const listener of this.listeners) listener(message)
      }
    })
  }

  static async connect(url: string): Promise<Devtools> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error(`could not connect to Chromium at ${url}`)), { once: true })
    })
    return new Devtools(socket)
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.next++
    this.socket.send(JSON.stringify({ id, method, params, sessionId }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  on(listener: (message: Message) => void) {
    this.listeners.push(listener)
  }

  close() {
    this.socket.close()
  }
}

export interface RenderOptions {
  camera?: string
  // Show this level and the ones below it.
  level?: string
  // 'fast' skips ambient occlusion; 'high' is the default.
  quality?: 'high' | 'fast'
  width?: number
  height?: number
  timeout?: number
  // Render these cameras as one contact sheet; width and height are then
  // the size of each tile.
  sheet?: string[]
}

// The size of a contact sheet of `count` tiles.
export function sheetSize(count: number, tileW: number, tileH: number): { width: number; height: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
  const rows = Math.max(1, Math.ceil(count / cols))
  return { width: cols * tileW, height: rows * (tileH + 28) }
}

// One browser and one server, reused across renders; the MCP server keeps
// one alive so each render takes about a second instead of three.
export class Renderer {
  private browser: ChildProcess
  private devtools: Devtools
  private sessionId: string
  private server: StageServer
  private profile: string
  private errors: string[]

  private constructor(browser: ChildProcess, devtools: Devtools, sessionId: string, server: StageServer, profile: string, errors: string[]) {
    this.browser = browser
    this.devtools = devtools
    this.sessionId = sessionId
    this.server = server
    this.profile = profile
    this.errors = errors
  }

  static async start(): Promise<Renderer> {
    const server = await startServer(0)
    const profile = await mkdtemp(join(tmpdir(), 'stage-chromium-'))
    const browser = spawn(
      findChromium(),
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--mute-audio',
        '--hide-scrollbars',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        // Extra flags from the environment, like --no-sandbox in a container
        // whose seccomp profile refuses Chromium's own sandbox.
        ...(process.env.STAGE_CHROMIUM_FLAGS ?? '').split(/\s+/).filter(Boolean),
        'about:blank',
      ],
      // Its own temporary files go in the profile too, so close removes them.
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: profile } },
    )
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error(`Chromium did not start: ${output.slice(-400)}`)), 20000)
      browser.stderr!.on('data', (chunk) => {
        output += chunk
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(output)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      })
      browser.once('exit', (code) => reject(new Error(`Chromium exited with ${code}: ${output.slice(-400)}`)))
    })
    const devtools = await Devtools.connect(endpoint)
    const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true })
    const errors: string[] = []
    devtools.on((message) => {
      if (message.sessionId !== sessionId) return
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text)
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        errors.push(message.params.args.map((a: any) => a.value ?? a.description ?? '').join(' '))
      }
    })
    await devtools.send('Runtime.enable', {}, sessionId)
    await devtools.send('Page.enable', {}, sessionId)
    return new Renderer(browser, devtools, sessionId, server, profile, errors)
  }

  async render(scene: string, options: RenderOptions = {}): Promise<Buffer> {
    const width = options.width ?? (options.sheet ? 640 : 1280)
    const height = options.height ?? (options.sheet ? 360 : 720)
    this.errors.length = 0
    const page = options.sheet ? sheetSize(options.sheet.length, width, height) : { width, height }
    await this.devtools.send('Emulation.setDeviceMetricsOverride', { ...page, deviceScaleFactor: 1, mobile: false }, this.sessionId)
    const extra: Record<string, string> = { headless: '1', w: String(width), h: String(height) }
    if (options.sheet) extra.sheet = options.sheet.join(',')
    if (options.camera) extra.camera = options.camera
    if (options.level) extra.level = options.level
    if (options.quality) extra.quality = options.quality
    await this.devtools.send('Page.navigate', { url: viewerUrl(this.server.url, scene, extra) }, this.sessionId)

    const deadline = Date.now() + (options.timeout ?? 30000)
    for (;;) {
      const { result } = await this.devtools.send(
        'Runtime.evaluate',
        { expression: 'document.body ? [document.body.dataset.ready || "", document.body.dataset.error || "", document.body.dataset.phase || ""] : ["", "", ""]', returnByValue: true },
        this.sessionId,
      )
      const [ready, error, phase] = (result?.value ?? ['', '', '']) as [string, string, string]
      if (ready === '1') break
      if (ready === 'error') throw new Error(error || 'the viewer could not build the scene')
      if (Date.now() > deadline) throw new Error(`the render timed out${phase ? ` while loading ${phase}` : ''}${this.errors.length ? `: ${this.errors.join('; ')}` : ''}`)
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    const { data } = await this.devtools.send('Page.captureScreenshot', { format: 'png' }, this.sessionId)
    return Buffer.from(data, 'base64')
  }

  // The scene as a binary glTF, built by the same page that renders it.
  async export(scene: string, timeout = 120000): Promise<Buffer> {
    this.errors.length = 0
    await this.devtools.send('Page.navigate', { url: viewerUrl(this.server.url, scene, { headless: '1', export: '1', w: '64', h: '64' }) }, this.sessionId)
    const deadline = Date.now() + timeout
    for (;;) {
      const { result } = await this.devtools.send('Runtime.evaluate', { expression: 'document.body ? [document.body.dataset.ready || "", document.body.dataset.error || "", document.body.dataset.phase || ""] : ["", "", ""]', returnByValue: true }, this.sessionId)
      const [ready, error, phase] = (result?.value ?? ['', '', '']) as [string, string, string]
      if (ready === '1') break
      if (ready === 'error') throw new Error(error || 'the viewer could not build the scene')
      if (Date.now() > deadline) throw new Error(`the export timed out${phase ? ` while ${phase}` : ''}${this.errors.length ? `: ${this.errors.join('; ')}` : ''}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const { result: length } = await this.devtools.send('Runtime.evaluate', { expression: 'window.__stageGlb.length', returnByValue: true }, this.sessionId)
    const total = length.value as number
    const parts: string[] = []
    for (let at = 0; at < total; at += 4_000_000) {
      const { result } = await this.devtools.send('Runtime.evaluate', { expression: `window.__stageGlb.slice(${at}, ${at + 4_000_000})`, returnByValue: true }, this.sessionId)
      parts.push(result.value as string)
    }
    return Buffer.from(parts.join(''), 'base64')
  }

  async close() {
    this.devtools.close()
    // Chromium writes to its profile as it shuts down, so wait for it to go
    // before removing the profile, or a server leaves one behind per close.
    const running = this.browser.exitCode === null && this.browser.signalCode === null
    const gone = running ? new Promise<void>((done) => this.browser.once('exit', () => done())) : Promise.resolve()
    this.browser.kill()
    await Promise.race([gone, new Promise<void>((done) => setTimeout(done, 5000).unref())])
    await this.server.close()
    await rm(this.profile, { recursive: true, force: true }).catch(() => {})
  }
}
