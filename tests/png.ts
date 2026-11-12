import { crc32, deflateSync, inflateSync } from 'node:zlib'

// Enough of a PNG decoder to compare renders: 8-bit RGB or RGBA, no
// interlacing, which is what headless Chromium writes.
export function decodePng(png: Buffer): { width: number; height: number; channels: number; data: Uint8Array } {
  if (png.toString('ascii', 1, 4) !== 'PNG') throw new Error('not a PNG')
  let at = 8
  let width = 0
  let height = 0
  let channels = 0
  const chunks: Buffer[] = []
  while (at < png.length) {
    const length = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    const body = png.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      const color = body[9]
      if (depth !== 8 || body[12] !== 0) throw new Error('only 8-bit, non-interlaced PNGs')
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color] ?? 0
      if (!channels) throw new Error(`unsupported color type ${color}`)
    } else if (type === 'IDAT') chunks.push(body)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const data = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = data.subarray(y * stride, (y + 1) * stride)
    const above = y > 0 ? data.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride)
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? out[i - channels] : 0
      const up = above[i]
      const upLeft = i >= channels ? above[i - channels] : 0
      let value = row[i]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      out[i] = value & 0xff
    }
  }
  return { width, height, channels, data }
}

// Mean absolute difference per channel between two images of one size,
// 0 for identical images and 255 for black against white.
export function meanDifference(a: Buffer, b: Buffer): number {
  const p = decodePng(a)
  const q = decodePng(b)
  if (p.width !== q.width || p.height !== q.height || p.channels !== q.channels) return 255
  let sum = 0
  for (let i = 0; i < p.data.length; i++) sum += Math.abs(p.data[i] - q.data[i])
  return sum / p.data.length
}

// A flat 8-bit RGB PNG filled by `color(x, y)`, for test drawings.
export function encodePng(width: number, height: number, color: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(color(x, y), y * (width * 3 + 1) + 1 + x * 3)
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'ascii')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
