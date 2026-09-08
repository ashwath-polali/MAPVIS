// every frame packs into one image, because 800 loose pngs emptied a 2,500-a-day allowance in three page loads; nothing is resampled and the loose pngs still ship
import { decodePNG, encodePNG } from '../sheet.mjs'

/* the school chromebooks report 4096, and a sheet over that cannot be uploaded at all, so the failure lands in the classroom rather than at publish */
export const MAX_TEXTURE_SIZE = 4096

const pow2 = (n) => 1 << Math.ceil(Math.log2(Math.max(1, n)))

/* shelf packing, within a few percent of the tightest algorithm on a few hundred small sprites and twenty lines instead of two hundred */
export function packAtlas(files, { max = MAX_TEXTURE_SIZE, pad = 1 } = {}) {
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

  /* the width comes from the total area and the widest frame is only a floor, because letting the widest frame decide packed the hub as 256 x 6422, past the texture limit */
  const widest = items.reduce((m, i) => Math.max(m, i.w + pad * 2), 0)
  const area = items.reduce((s, i) => s + (i.w + pad * 2) * (i.h + pad * 2), 0)
  const width = Math.max(256, pow2(widest), Math.min(max, pow2(Math.ceil(Math.sqrt(area)))))

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

  /* refused out loud, because a sheet over the texture limit is a bundle where nothing appears and looks fine from the publisher's side */
  if (width > MAX_TEXTURE_SIZE || height > MAX_TEXTURE_SIZE)
    throw new Error(
      `the atlas for these ${items.length} frame(s) comes out ${width}x${height}, and a texture cannot be larger than ` +
        `${MAX_TEXTURE_SIZE} on the school Chromebooks this targets, so no frame on the sheet would draw. ` +
        `Widest frame ${widest - pad * 2}px, total packed area ${area}px. Split the map across two maps.`,
    )

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

/* src, frames and dirs keep their names and order and only gain a rectangle, so a reader that has never heard of the atlas still has its paths */
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
