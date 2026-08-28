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

/* WHAT THE SHEET HAS TO FIT INSIDE.
 *
 * WebGL reports MAX_TEXTURE_SIZE and the 4 GB school Chromebooks this targets
 * report 4096. A sheet with either side over that cannot be uploaded at all, so
 * every frame on it fails to draw, and the failure arrives on the machine in the
 * classroom rather than on the machine that published. */
export const MAX_TEXTURE_SIZE = 4096

const pow2 = (n) => 1 << Math.ceil(Math.log2(Math.max(1, n)))

/* Shelf packing: sort tall-first, lay left to right, drop to a new row when the
 * shelf is full. It is not the tightest algorithm published, and for a few
 * hundred small sprites of similar height it lands within a few percent of one
 * while being twenty lines instead of two hundred. */
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

  /* THE WIDEST FRAME IS A FLOOR ON THE WIDTH, NOT THE ANSWER.
   *
   * Letting the widest frame decide outright packed the hub as 256 x 6422. Its
   * widest frame is 154 px, which rounds up to a 256 wide sheet, and 794 frames
   * laid on 256 px shelves is a strip six thousand rows tall, well past the
   * 4096 above. The `max` cap never came into it, because the width was already
   * far below the cap.
   *
   * Fill is not what is being traded here. Measured over the hub's 794 frames:
   * 256 wide gives 6422 tall, 512 gives 3063, 1024 gives 1538 and 2048 gives
   * 790, and the fill sits between 86 and 93 percent at every one of them. Only
   * the aspect ratio moves. So the width is chosen from the total area instead:
   * the square root of everything to be packed, rounded up to a power of two,
   * which is the width a square sheet would want. The widest frame still holds
   * it up from below, because a frame wider than the sheet would be written past
   * the end of its own row and land in the next one. */
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

  /* REFUSED OUT LOUD RATHER THAN SHIPPED UNDRAWABLE.
   *
   * A sheet over the texture limit is not a slow bundle, it is a bundle where
   * nothing appears, and it looks perfectly fine from the publisher's side. The
   * shelf packer cannot do better than this without a different algorithm, so
   * there is nothing to fall back to and the honest move is to stop. */
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
