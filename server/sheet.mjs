/* Contact sheets, so what the tool just made can be LOOKED AT.
 *
 * The planner reads images off disk by absolute path, which is the proven
 * pattern already used by the style card. That means everything the tool makes
 * has to become one file first: eight frames of an effect are eight separate
 * pngs, and eight separate looks would be eight separate answers. So the frames
 * are laid out left to right in one strip, blown up so a 2px thread is visible,
 * and put on a mid-grey field so light pixels and dark pixels both read against
 * it. One image, one look, one verdict.
 *
 * There is no image library in this project and there is not going to be one,
 * so the png work is here: enough of a decoder to read what the client and
 * pixellab write, and enough of an encoder to write a flat rgba strip back.
 * Both halves are free and local. Nothing on this path touches pixellab.
 */
import zlib from 'node:zlib'

// ---- png in ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/* One png as flat rgba. Handles the shapes these two sources actually write:
 * the client's canvas.toDataURL (8-bit rgba) and pixellab's own files (8-bit
 * rgba or palette). Interlaced files are refused rather than half-read. */
export function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png')
  let pos = 8
  let w = 0
  let h = 0
  let depth = 0
  let ct = 6
  let interlace = 0
  let plte = null
  let trns = null
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      depth = data[8]
      ct = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') plte = Buffer.from(data)
    else if (type === 'tRNS') trns = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (!(w > 0 && h > 0) || !idat.length) throw new Error('no image in that png')
  if (interlace) throw new Error('interlaced png')
  const ch = CHANNELS[ct]
  if (!ch) throw new Error('png colour type ' + ct)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = Math.ceil((w * ch * depth) / 8)
  const bpp = Math.max(1, Math.ceil((ch * depth) / 8))
  const flat = Buffer.alloc(stride * h)
  let p = 0
  for (let y = 0; y < h; y++) {
    const f = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const cur = flat.subarray(y * stride, (y + 1) * stride)
    const prev = y ? flat.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= bpp ? prev[i - bpp] : 0
      let v = line[i]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 255
    }
  }
  // every sample as one byte, whatever the file's bit depth was: 16 keeps the
  // high half, anything under 8 is unpacked, and a palette index stays an index
  const vals = new Uint8Array(w * h * ch)
  if (depth === 8) {
    for (let y = 0; y < h; y++) for (let i = 0; i < w * ch; i++) vals[y * w * ch + i] = flat[y * stride + i]
  } else if (depth === 16) {
    for (let y = 0; y < h; y++) for (let i = 0; i < w * ch; i++) vals[y * w * ch + i] = flat[y * stride + i * 2]
  } else {
    const max = (1 << depth) - 1
    for (let y = 0; y < h; y++) {
      let bit = 0
      for (let i = 0; i < w * ch; i++) {
        const byte = flat[y * stride + (bit >> 3)]
        const shift = 8 - depth - (bit & 7)
        const s = (byte >> shift) & max
        vals[y * w * ch + i] = ct === 3 ? s : Math.round((s * 255) / max)
        bit += depth
      }
    }
  }
  const out = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const s = i * ch
    const d = i * 4
    if (ct === 6) {
      out[d] = vals[s]
      out[d + 1] = vals[s + 1]
      out[d + 2] = vals[s + 2]
      out[d + 3] = vals[s + 3]
    } else if (ct === 2) {
      out[d] = vals[s]
      out[d + 1] = vals[s + 1]
      out[d + 2] = vals[s + 2]
      out[d + 3] = 255
    } else if (ct === 0) {
      out[d] = out[d + 1] = out[d + 2] = vals[s]
      out[d + 3] = 255
    } else if (ct === 4) {
      out[d] = out[d + 1] = out[d + 2] = vals[s]
      out[d + 3] = vals[s + 1]
    } else {
      const k = vals[s] * 3
      out[d] = plte ? plte[k] : 0
      out[d + 1] = plte ? plte[k + 1] : 0
      out[d + 2] = plte ? plte[k + 2] : 0
      out[d + 3] = trns && vals[s] < trns.length ? trns[vals[s]] : 255
    }
  }
  return { w, h, data: out }
}

// ---- png out --------------------------------------------------------------

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/* Flat rgba back out as an 8-bit rgba png, every scanline filter 0. A sheet is
 * a few hundred kilobytes of flat colour and it is read once, so there is no
 * reason to search filters. */
export function encodePNG(w, h, rgba) {
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length)
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    src.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- the sheet ------------------------------------------------------------

// the field the frames sit on. Mid-grey on purpose: a white sheet loses pale
// smoke and a black one loses a dark rim, and both of those are exactly the
// thing being judged.
const BG = [122, 122, 122]
// the rule between cells, so frames can be counted and a cell's edge is visible
const RULE = [86, 86, 86]
const PAD = 6
const GAP = 6
// a strip wider than this is a strain to read, so the zoom drops instead
const MAX_W = 2200

// 3x5 digits, for numbering the candidates on an object sheet
const DIGITS = [
  0b111101101101111, 0b010110010010111, 0b111001111100111, 0b111001111001111, 0b101101111001001,
  0b111100111001111, 0b111100111101111, 0b111001001001001, 0b111101111101111, 0b111101111001111,
]

/* The frames, left to right, blown up with no smoothing. images is a list of
 * { w, h, data } from decodePNG; every cell is bottom-aligned so a row of
 * sprites stands on one line. label puts an index number over each cell, which
 * is the whole way an answer of "the second one" can name what it means. */
export function contactSheet(images, o = {}) {
  const live = images.filter((im) => im && im.w > 0 && im.h > 0)
  if (!live.length) throw new Error('nothing to lay out')
  const cw = live.reduce((a, im) => a + im.w, 0)
  const ch = live.reduce((a, im) => Math.max(a, im.h), 0)
  let z = Math.max(1, Math.min(o.zoom || 3, Math.floor((MAX_W - PAD * 2) / Math.max(1, cw))))
  if (!isFinite(z) || z < 1) z = 1
  const W = PAD * 2 + cw * z + GAP * (live.length - 1)
  const H = PAD * 2 + ch * z
  const out = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = BG[0]
    out[i * 4 + 1] = BG[1]
    out[i * 4 + 2] = BG[2]
    out[i * 4 + 3] = 255
  }
  const put = (x, y, r, g, b, a) => {
    if (!(x >= 0 && y >= 0 && x < W && y < H) || a <= 0) return
    const d = (y * W + x) * 4
    if (a >= 1) {
      out[d] = r
      out[d + 1] = g
      out[d + 2] = b
      return
    }
    out[d] = r * a + out[d] * (1 - a)
    out[d + 1] = g * a + out[d + 1] * (1 - a)
    out[d + 2] = b * a + out[d + 2] * (1 - a)
  }
  let x0 = PAD
  for (let n = 0; n < live.length; n++) {
    const im = live[n]
    const top = PAD + (ch - im.h) * z
    if (n) for (let y = PAD; y < PAD + ch * z; y++) for (let g = 0; g < GAP; g++) put(x0 - GAP + g, y, RULE[0], RULE[1], RULE[2], 1)
    for (let y = 0; y < im.h * z; y++) {
      const sy = (y / z) | 0
      for (let x = 0; x < im.w * z; x++) {
        const s = (sy * im.w + ((x / z) | 0)) * 4
        put(x0 + x, top + y, im.data[s], im.data[s + 1], im.data[s + 2], im.data[s + 3] / 255)
      }
    }
    if (o.label) drawNumber(put, n + 1, x0 + 2, top + 2, Math.max(2, z))
    x0 += im.w * z + GAP
  }
  return { w: W, h: H, data: out }
}

// one index number, white on a dark ring so it reads over any sprite
function drawNumber(put, n, x, y, s) {
  const digits = String(n).split('')
  let dx = x
  for (const d of digits) {
    const bits = DIGITS[Number(d)] || 0
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (!((bits >> (14 - (r * 3 + c))) & 1)) continue
        for (let oy = -1; oy <= 1; oy++)
          for (let ox = -1; ox <= 1; ox++)
            for (let py = 0; py < s; py++)
              for (let px = 0; px < s; px++) put(dx + c * s + px + ox * s, y + r * s + py + oy * s, 16, 16, 16, 1)
      }
    }
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 3; c++) {
        if (!((bits >> (14 - (r * 3 + c))) & 1)) continue
        for (let py = 0; py < s; py++) for (let px = 0; px < s; px++) put(dx + c * s + px, y + r * s + py, 255, 255, 255, 1)
      }
    dx += 4 * s
  }
}

/* Everything above, in one call: png buffers in, a written sheet out. */
export function sheetPNG(buffers, o) {
  const images = []
  for (const b of buffers) {
    try {
      images.push(decodePNG(b))
    } catch {
      /* one unreadable frame does not sink the sheet */
    }
  }
  const sh = contactSheet(images, o)
  return encodePNG(sh.w, sh.h, sh.data)
}
