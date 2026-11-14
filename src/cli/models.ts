import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { measureGltf } from './assets.ts'

// Models from the open libraries, for anything the built-in library lacks:
// search by words across every source, look at thumbnails, fetch one
// beside the scene as a glTF the `model` object kind loads. Every source
// is a small adapter; the agent sees one list.

export interface ModelHit {
  source: string
  id: string
  name: string
  // The license's short name and who to credit, as the source states them.
  license: string
  credit: string
  // The page a person can open.
  url: string
  thumbnail?: string
  triangles?: number
  // Width, depth, height in meters when the source knows.
  size?: [number, number, number]
  // What the source needs to fetch it, kept from the search.
  download?: string
  formats?: unknown[]
}

export interface Fetched {
  // The main file, relative to the scene: a .glb, or a .gltf with its
  // buffers and textures beside it.
  file: string
  size: [number, number, number]
  license: string
  credit: string
  source: string
}

export interface ModelSource {
  id: string
  name: string
  // What the agent should know: licenses, what it is good for, the key.
  about: string
  // The environment variable holding a key, when the source needs one,
  // and whether search works without it.
  key?: string
  searchWithoutKey?: boolean
  headers?: () => Record<string, string>
  search(words: string, limit: number, options: SearchOptions): Promise<ModelHit[]>
  // One model by the id search gave, for a fetch in a later session.
  get(id: string): Promise<ModelHit | undefined>
  fetch(hit: ModelHit, folder: string): Promise<string>
}

export interface SearchOptions {
  // Only public-domain models, or any Creative Commons license that allows
  // use with credit.
  license: 'cc0' | 'any'
}

const HEADERS = { 'user-agent': 'stage/0.1 (https://github.com/dvrshil/stage; model search)' }

export async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(url, { headers: { ...HEADERS, ...headers } })
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`)
  return response.json()
}

export async function getBytes(url: string, headers: Record<string, string> = {}): Promise<{ data: Buffer; type: string }> {
  const response = await fetch(url, { headers: { ...HEADERS, ...headers } })
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`)
  return { data: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') ?? 'application/octet-stream' }
}

export async function saveTo(url: string, path: string, headers: Record<string, string> = {}): Promise<void> {
  const { data } = await getBytes(url, headers)
  mkdirSync(dirname(path), { recursive: true })
  await writeFile(`${path}.tmp`, data)
  await rename(`${path}.tmp`, path)
}

// The name a fetched file is saved under, from the path its source gives.
// Icosa gives some names URL-encoded ("Office%20chair.bin"), as a glTF's own
// URIs are, and the viewer asks for the decoded name, so the file on disk
// must carry it. A name that leaves the model's folder is refused.
export function fileName(relative: string): string {
  let name = relative
  try {
    name = decodeURIComponent(relative)
  } catch {
    // Not URL-encoded: a stray % stays as it is.
  }
  name = name.replace(/\\/g, '/')
  if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some((part) => part === '..')) throw new Error(`${relative}: the model names a file outside its folder`)
  return name
}

// A file name a source's id can become.
export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || createHash('md5').update(text).digest('hex').slice(0, 8)

// The JSON of a .gltf or the JSON chunk of a .glb.
export async function readGltfJson(path: string): Promise<any> {
  const data = await readFile(path)
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'glTF') {
    let at = 12
    while (at + 8 <= data.length) {
      const length = data.readUInt32LE(at)
      const type = data.readUInt32LE(at + 4)
      if (type === 0x4e4f534a) return JSON.parse(data.toString('utf8', at + 8, at + 8 + length))
      at += 8 + length
    }
    throw new Error(`${path}: no JSON chunk in the glb`)
  }
  return JSON.parse(data.toString('utf8'))
}

export async function measureFile(path: string): Promise<[number, number, number]> {
  const size = measureGltf(await readGltfJson(path))
  if (!size.every((n) => Number.isFinite(n))) throw new Error(`${path}: could not measure the model`)
  return size
}

// --- Poly Haven: CC0 scans, photographic quality, heavy; furniture,
// props, plants, rocks, vehicles. No key. Its terms ask for a named
// user agent and a visible credit where results are shown.
const POLYHAVEN = 'https://api.polyhaven.com'
function polyhavenHit(id: string, a: any): ModelHit {
  const mm = a.dimensions as [number, number, number] | undefined
  return {
    source: 'polyhaven',
    id,
    name: a.name,
    license: 'CC0',
    credit: Object.keys(a.authors ?? {}).join(', '),
    url: `https://polyhaven.com/a/${id}`,
    thumbnail: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`,
    triangles: a.polycount,
    size: mm ? ([mm[0] / 1000, mm[1] / 1000, mm[2] / 1000].map((n) => Math.round(n * 100) / 100) as [number, number, number]) : undefined,
  }
}
let polyhavenIndex: Promise<Record<string, any>> | undefined
const polyhaven: ModelSource = {
  id: 'polyhaven',
  name: 'Poly Haven',
  about: 'about 520 CC0 photoscanned models (furniture, props, plants, rocks, a few vehicles), realistic and heavy, with real sizes; no key',
  async search(words, limit) {
    polyhavenIndex ??= getJson(`${POLYHAVEN}/assets?type=models`)
    const [index, ranked] = await Promise.all([polyhavenIndex, getJson(`${POLYHAVEN}/search?q=${encodeURIComponent(words)}&t=models`).catch(() => [])])
    const list = Array.isArray(ranked) ? ranked : (ranked?.results ?? [])
    // The hybrid search ranks everything; only real matches are worth a look.
    const order: string[] = list.filter((r: any) => (r.score ?? 1) >= 0.5).map((r: any) => r.slug ?? r.id).filter((id: string) => index[id])
    if (order.length === 0) {
      const terms = words.toLowerCase().split(/\s+/).filter(Boolean)
      for (const [id, a] of Object.entries<any>(index)) {
        const haystack = `${id} ${a.name} ${(a.tags ?? []).join(' ')} ${(a.categories ?? []).join(' ')}`.toLowerCase()
        if (terms.every((t) => haystack.includes(t))) order.push(id)
      }
    }
    return order.slice(0, limit).map((id) => polyhavenHit(id, index[id]))
  },
  async get(id) {
    polyhavenIndex ??= getJson(`${POLYHAVEN}/assets?type=models`)
    const a = (await polyhavenIndex)[id]
    return a ? polyhavenHit(id, a) : undefined
  },
  async fetch(hit, folder) {
    const files = await getJson(`${POLYHAVEN}/files/${hit.id}`)
    const entry = files.gltf?.['1k']?.gltf as { url: string; include: Record<string, { url: string }> } | undefined
    if (!entry) throw new Error(`${hit.id} has no glTF`)
    const base = join('models', 'polyhaven', hit.id)
    await saveTo(entry.url, join(folder, base, `${hit.id}.gltf`))
    await Promise.all(Object.entries(entry.include).map(([path, file]) => saveTo(file.url, join(folder, base, fileName(path)))))
    return `${base}/${hit.id}.gltf`
  },
}

// --- Poly Pizza: thousands of low-poly CC0 and CC-BY pieces (the Kenney
// and Quaternius packs among them), one glb each. Free key from
// poly.pizza/settings/api in POLY_PIZZA_KEY.
const polypizzaHit = (m: any): ModelHit => ({
  source: 'polypizza',
  id: String(m.ID),
  name: m.Title,
  license: m.Licence ?? 'CC-BY 3.0',
  credit: m.Attribution ?? m.Creator?.Username ?? '',
  url: `https://poly.pizza/m/${m.ID}`,
  thumbnail: m.Thumbnail,
  triangles: m['Tri Count'],
  download: m.Download,
})
const polypizza: ModelSource = {
  id: 'polypizza',
  name: 'Poly Pizza',
  about: 'thousands of low-poly stylised models (household, vehicles, animals, food, characters), CC0 and CC-BY, one small glb each; free key in POLY_PIZZA_KEY',
  key: 'POLY_PIZZA_KEY',
  headers: () => ({ 'x-auth-token': process.env.POLY_PIZZA_KEY ?? '' }),
  async search(words, limit, { license }) {
    const url = `https://api.poly.pizza/v1.1/search/${encodeURIComponent(words)}?Limit=${Math.min(32, limit)}${license === 'cc0' ? '&License=1' : ''}`
    const data = await getJson(url, this.headers!())
    return ((data.results ?? []) as any[]).map(polypizzaHit)
  },
  async get(id) {
    const m = await getJson(`https://api.poly.pizza/v1.1/model/${encodeURIComponent(id)}`, this.headers!()).catch(() => undefined)
    return m?.ID !== undefined ? polypizzaHit(m) : undefined
  },
  async fetch(hit, folder) {
    const download = (hit as ModelHit & { download?: string }).download
    if (!download) throw new Error(`${hit.id} has no download`)
    const file = join('models', 'polypizza', `${slug(hit.name)}-${hit.id}.glb`)
    await saveTo(download, join(folder, file), this.headers!())
    return file
  },
}

// --- Sketchfab: the largest catalogue. Search is open; downloading needs
// a personal API token (Settings, Password & API) in SKETCHFAB_TOKEN. A
// download is a zip of glTF, unpacked beside the scene.
function sketchfabHit(m: any): ModelHit {
  const thumbs = ((m.thumbnails?.images ?? []) as { url: string; width: number }[]).sort((a, b) => a.width - b.width)
  const thumb = thumbs.find((t) => t.width >= 200) ?? thumbs.at(-1)
  return {
    source: 'sketchfab',
    id: m.uid,
    name: m.name,
    license: m.license?.label ?? 'CC-BY',
    credit: `${m.user?.displayName ?? m.user?.username ?? ''} (${m.viewerUrl})`,
    url: m.viewerUrl,
    thumbnail: thumb?.url,
    triangles: m.faceCount,
  }
}
const sketchfab: ModelSource = {
  id: 'sketchfab',
  name: 'Sketchfab',
  about: 'the largest catalogue, CC0 and CC-BY downloadable models of everything (often 100k+ faces with big textures; scans, products, creatures, vehicles); search needs no key, downloading needs your free account token in SKETCHFAB_TOKEN',
  key: 'SKETCHFAB_TOKEN',
  searchWithoutKey: true,
  headers: (): Record<string, string> => (process.env.SKETCHFAB_TOKEN ? { authorization: `Token ${process.env.SKETCHFAB_TOKEN}` } : {}),
  async search(words, limit, { license }) {
    // One relevance-ranked search over everything downloadable, then only
    // the licenses that allow use with credit; a license filter on the
    // query itself makes Sketchfab rank loosely within that license.
    const allowed = license === 'cc0' ? new Set(['cc0']) : new Set(['cc0', 'by', 'by-sa'])
    const hits: ModelHit[] = []
    let url: string | undefined = `https://api.sketchfab.com/v3/search?type=models&q=${encodeURIComponent(words)}&downloadable=true${license === 'cc0' ? '&license=cc0' : ''}&count=24&archives_max_face_count=500000`
    for (let page = 0; page < 3 && url && hits.length < limit; page++) {
      const data: any = await getJson(url).catch(() => ({ results: [] }))
      for (const m of (data.results ?? []) as any[]) {
        if (!allowed.has(m.license?.uid ?? m.license?.slug ?? '') && !/cc0|attribution$|attribution-sharealike$/i.test(m.license?.label ?? '')) continue
        hits.push(sketchfabHit(m))
      }
      url = data.next
    }
    return hits.slice(0, limit)
  },
  async get(id) {
    const m = await getJson(`https://api.sketchfab.com/v3/models/${encodeURIComponent(id)}`).catch(() => undefined)
    return m?.uid ? sketchfabHit(m) : undefined
  },
  async fetch(hit, folder) {
    if (!process.env.SKETCHFAB_TOKEN) throw new Error('downloading from Sketchfab needs SKETCHFAB_TOKEN: your API token from sketchfab.com/settings/password, set in the environment of the MCP server')
    const links = await getJson(`https://api.sketchfab.com/v3/models/${hit.id}/download`, this.headers!())
    const archive = links.glb?.url ? { url: links.glb.url, kind: 'glb' } : links.gltf?.url ? { url: links.gltf.url, kind: 'gltf' } : undefined
    if (!archive) throw new Error(`${hit.id}: Sketchfab offered no glTF archive`)
    const { data } = await getBytes(archive.url)
    const base = join('models', 'sketchfab', `${slug(hit.name)}-${hit.id.slice(0, 8)}`)
    // The glb comes bare; the glTF comes zipped with its files.
    if (data.length > 4 && data.toString('ascii', 0, 4) === 'glTF') {
      const file = `${base}.glb`
      mkdirSync(dirname(join(folder, file)), { recursive: true })
      await writeFile(join(folder, file), data)
      return file
    }
    const entries = unzip(data)
    let main: string | undefined
    for (const entry of entries) {
      const path = join(folder, base, entry.name)
      if (!resolve(path).startsWith(resolve(folder, base))) continue
      mkdirSync(dirname(path), { recursive: true })
      await writeFile(path, entry.data)
      if (/\.(glb|gltf)$/i.test(entry.name) && (!main || entry.name.endsWith('.glb'))) main = entry.name
    }
    if (!main) throw new Error(`${hit.id}: the archive held no .gltf or .glb`)
    return `${base}/${main}`
  },
}

// --- Icosa Gallery: the Google Poly archive, 140k low-poly models,
// nearly all CC-BY 3.0. No key. Files often come through the Internet
// Archive, slowly.
const ICOSA_LICENSE: Record<string, string> = { CREATIVE_COMMONS_BY: 'CC-BY', CREATIVE_COMMONS_0: 'CC0', CREATIVE_COMMONS_BY_ND: 'CC-BY-ND' }
const icosaUsable = (a: any) => a.license !== 'CREATIVE_COMMONS_BY_ND' && (a.formats ?? []).some((f: any) => f.formatType === 'GLB' || f.formatType === 'GLTF2')
const icosaHit = (a: any): ModelHit => ({
  source: 'icosa',
  id: a.assetId,
  name: a.displayName,
  license: `${ICOSA_LICENSE[a.license] ?? a.license} ${a.licenseVersion ?? ''}`.trim(),
  credit: `${a.authorName} (https://icosa.gallery/view/${a.assetId})`,
  url: `https://icosa.gallery/view/${a.assetId}`,
  thumbnail: a.thumbnail?.url,
  triangles: a.triangleCount,
  formats: a.formats,
})
const icosa: ModelSource = {
  id: 'icosa',
  name: 'Icosa Gallery',
  about: 'the Google Poly archive, 140k low-poly models (household, animals, vehicles, scenes), nearly all CC-BY 3.0 with a few CC0; no key; downloads can be slow',
  async search(words, limit, { license }) {
    const url = `https://api.icosa.gallery/v1/assets?keywords=${encodeURIComponent(words)}&format=GLTF2&license=${license === 'cc0' ? 'CREATIVE_COMMONS_0' : 'ALL_CC'}&orderBy=BEST&pageSize=${Math.min(100, limit)}`
    const data = await getJson(url)
    return ((data.assets ?? []) as any[]).filter(icosaUsable).map(icosaHit)
  },
  async get(id) {
    const a = await getJson(`https://api.icosa.gallery/v1/assets/${encodeURIComponent(id)}`).catch(() => undefined)
    return a?.assetId && icosaUsable(a) ? icosaHit(a) : undefined
  },
  async fetch(hit, folder) {
    const formats = ((hit as ModelHit & { formats?: any[] }).formats ?? []) as any[]
    const glb = formats.find((f) => f.formatType === 'GLB' && f.root?.url)
    const gltf = formats.find((f) => f.formatType === 'GLTF2' && f.root?.url)
    const base = join('models', 'icosa', `${slug(hit.name)}-${hit.id}`)
    if (glb && !gltf) {
      await saveTo(glb.root.url, join(folder, base, 'model.glb'))
      return `${base}/model.glb`
    }
    const chosen = gltf ?? glb
    if (!chosen) throw new Error(`${hit.id}: no glTF format`)
    const rootName = fileName(chosen.root.relativePath ?? 'model.gltf')
    await saveTo(chosen.root.url, join(folder, base, rootName))
    await Promise.all(((chosen.resources ?? []) as any[]).map((r) => saveTo(r.url, join(folder, base, fileName(r.relativePath ?? r.url.split('/').pop())))))
    return `${base}/${rootName}`
  },
}

// A zip, as the Sketchfab archives come: stored or deflated entries,
// read from the central directory.
export function unzip(data: Buffer): { name: string; data: Buffer }[] {
  let end = data.length - 22
  while (end >= 0 && data.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0) throw new Error('not a zip file')
  const count = data.readUInt16LE(end + 10)
  let at = data.readUInt32LE(end + 16)
  const entries: { name: string; data: Buffer }[] = []
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(at) !== 0x02014b50) break
    const method = data.readUInt16LE(at + 10)
    const compressed = data.readUInt32LE(at + 20)
    const nameLength = data.readUInt16LE(at + 28)
    const extraLength = data.readUInt16LE(at + 30)
    const commentLength = data.readUInt16LE(at + 32)
    const local = data.readUInt32LE(at + 42)
    const name = data.toString('utf8', at + 46, at + 46 + nameLength)
    at += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
    const body = data.subarray(start, start + compressed)
    entries.push({ name, data: method === 8 ? inflateRawSync(body) : Buffer.from(body) })
  }
  return entries
}

export const SOURCES: ModelSource[] = [polyhaven, polypizza, sketchfab, icosa]

export function sourceById(id: string): ModelSource {
  const found = SOURCES.find((s) => s.id === id)
  if (!found) throw new Error(`no source is called "${id}"; sources are ${SOURCES.map((s) => s.id).join(', ')}.`)
  return found
}

// Sources that can be used now: the ones needing a key only when it is set.
export const available = () => SOURCES.filter((s) => !s.key || s.searchWithoutKey || process.env[s.key])

export async function findModels(words: string, options: { source?: string; limit?: number; license?: 'cc0' | 'any' } = {}): Promise<{ hits: ModelHit[]; skipped: string[] }> {
  const limit = options.limit ?? 8
  const sources = options.source ? [sourceById(options.source)] : available()
  const skipped = SOURCES.filter((s) => !sources.includes(s) && !options.source).map((s) => `${s.name} (set ${s.key})`)
  const results = await Promise.allSettled(sources.map((s) => s.search(words, limit, { license: options.license ?? 'any' })))
  const hits: ModelHit[] = []
  for (let round = 0; hits.length < limit; round++) {
    let any = false
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      const hit = result.value[round]
      if (!hit) continue
      any = true
      if (hits.length < limit) hits.push(hit)
    }
    if (!any) break
  }
  results.forEach((result, i) => {
    if (result.status === 'rejected') skipped.push(`${sources[i].name}: ${String((result.reason as Error).message)}`)
  })
  return { hits, skipped }
}

// A hit by id: the recent search results first, then the source itself.
const recent = new Map<string, ModelHit>()
export const remember = (hits: ModelHit[]) => hits.forEach((h) => recent.set(`${h.source}:${h.id}`, h))
async function findById(adapter: ModelSource, id: string): Promise<ModelHit> {
  const known = recent.get(`${adapter.id}:${id}`) ?? (await adapter.get(id))
  if (known) return known
  const hits = await adapter.search(id, 50, { license: 'any' })
  const hit = hits.find((h) => h.id === id) ?? hits.find((h) => slug(h.id) === slug(id))
  if (!hit) throw new Error(`${adapter.name} has no model with id "${id}"; find_model first and use the id it gives.`)
  return hit
}

// Fetch one hit beside the scene file and measure it.
export async function fetchModelBesideScene(scenePath: string, source: string, id: string): Promise<Fetched> {
  const adapter = sourceById(source)
  const hit = await findById(adapter, id)
  const folder = dirname(resolve(scenePath))
  const file = await adapter.fetch(hit, folder)
  const size = await measureFile(join(folder, file))
  return { file, size, license: hit.license, credit: hit.credit, source: hit.url }
}

// Thumbnails as image content for the model to look at.
export async function thumbnailImage(hit: ModelHit): Promise<{ data: string; mimeType: string } | undefined> {
  if (!hit.thumbnail) return undefined
  try {
    const { data, type } = await getBytes(hit.thumbnail, SOURCES.find((s) => s.id === hit.source)?.headers?.() ?? {})
    // Some hosts send pictures as octet streams; the bytes say what they are.
    const sniffed = data.length > 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : data[0] === 0x89 && data.toString('ascii', 1, 4) === 'PNG' ? 'image/png' : data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : undefined
    const mimeType = sniffed ?? type.split(';')[0].trim()
    if (!mimeType.startsWith('image/')) return undefined
    return { data: data.toString('base64'), mimeType }
  } catch {
    return undefined
  }
}

export const hasFile = (path: string) => existsSync(path)
