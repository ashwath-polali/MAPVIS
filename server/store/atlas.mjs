// Pack every frame a map owns into one image.
//
// THE PROBLEM THIS EXISTS FOR: the hub publishes 800 pngs. Opening it once is
// 800 downloads. Backblaze's free tier allows 2,500 a day, so three page loads
// emptied it and the bucket started refusing reads mid-session. A map that
// costs 800 requests to open cannot be handed to a classroom, whatever the
// storage costs.
//
// Packed, a map is five files: map.json, scene.png, levels.png, atlas.png and
// atlas.json. Same pixels, same bytes give or take the packing gaps, 160x fewer
// transactions. Nothing is resampled, nothing is re-encoded lossily, and every
// frame comes back out at exactly the size it went in.
//
// The individual pngs are still published beside it. Storage is not the
// constraint, transactions are, and keeping them means a reader written before
// the atlas existed keeps working.
import { decodePNG, encodePNG } from '../sheet.mjs'

/* Shelf packing: sort tall-first, lay left to right, drop to a new row when the
 * shelf is full. It is not the tightest algorithm published, and for a few
 * hundred small sprites of similar height it lands within a few percent of one
 * while being twenty lines instead of two hundred. */
export function packAtlas(files, { max = 2048, pad = 1 } = {}) {
  const items = []
  for (const [name, buf] of files) {
    try {
      const { w, h, data } = decodePNG(buf)
      items.push({ name, w, h, data })
    } catch {
      /* anything unreadable simply stays a loose file */
    }
  }
  if (!items.length) return null

  // widest single frame decides the sheet, so nothing is ever cut in half
  const widest = items.reduce((m, i) => Math.max(m, i.w + pad * 2), 0)
  const width = Math.min(max, Math.max(256, 1 << Math.ceil(Math.log2(widest))))

  items.sort((a, b) => b.h - a.h || b.w - a.w)

  const place = []
  let x = pad
  let y = pad
  let shelf = 0
  for (const it of items) {
    if (x + it.w + pad > width) {
      x = pad
      y += shelf + pad
      shelf = 0
    }
    place.push({ ...it, x, y })
    x += it.w + pad
    shelf = Math.max(shelf, it.h)
  }
  const height = y + shelf + pad

  const rgba = Buffer.alloc(width * height * 4)
  for (const it of place) {
    for (let row = 0; row < it.h; row++) {
      const from = row * it.w * 4
      const to = ((it.y + row) * width + it.x) * 4
      // decodePNG hands back a Uint8Array rather than a Buffer, so this is set()
      // rather than copy(). Both are byte moves; only one of them exists here.
      rgba.set(it.data.subarray(from, from + it.w * 4), to)
    }
  }

  const index = {}
  for (const it of place) index[it.name] = [it.x, it.y, it.w, it.h]

  return {
    png: encodePNG(width, height, rgba),
    index: { w: width, h: height, frames: index },
    count: place.length,
  }
}

/* Rewrite the placement list so it points into the sheet.
 *
 * The shape stays what every reader already understands: src, frames and dirs
 * keep their names and their order, and each entry gains its rectangle. A
 * reader that knows about the atlas draws from one image; one that does not
 * still has the path it always had. */
export function atlasify(assets, index) {
  const at = (u) => index.frames[u] || null
  const one = (o) => {
    const out = { ...o }
    if (o.src && at(o.src)) out.srcAt = at(o.src)
    if (Array.isArray(o.frames)) {
      const rects = o.frames.map(at)
      if (rects.every(Boolean)) out.framesAt = rects
    }
    if (o.dirs) {
      const d = {}
      let all = true
      for (const [k, list] of Object.entries(o.dirs)) {
        const rects = list.map(at)
        if (rects.every(Boolean)) d[k] = rects
        else all = false
      }
      if (all) out.dirsAt = d
    }
    if (Array.isArray(o.looks)) out.looks = o.looks.map(one)
    return out
  }
  return assets.map(one)
}
