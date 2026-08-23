/* Cut the pedestal off a generated sprite.
 *
 * The generator keeps standing objects on a little disc of ground: a slab, a
 * rock patch, a circle of dirt. Wording cannot be trusted to stop it, because
 * every way of saying "no ground" hands the generator the word ground. So this
 * removes it afterwards, with arithmetic and no model.
 *
 * A pedestal has one signature that holds across trees, statues, posts and
 * barrels: it sits ON the bottom edge, and it is much WIDER than the thing
 * standing on it. Read the row widths from the bottom up and the base shows as
 * a wide block that suddenly narrows into the trunk. Cut at that narrowing.
 *
 * It refuses when it is not sure. An object that legitimately widens all the
 * way down (a house, a boulder, a crate) has no narrowing to find, so nothing
 * is cut and the caller is told so.
 */

export interface DebaseResult {
  /* the trimmed image, or the original when nothing was cut */
  data: Uint8ClampedArray
  width: number
  height: number
  /* how many rows came off the bottom */
  cut: number
  /* what it found, in plain words, for the line under the preview */
  note: string
}

const A_MIN = 20

/* opaque pixel count and horizontal extent per row */
function rowStats(data: Uint8ClampedArray, w: number, h: number) {
  const count = new Int32Array(h)
  const left = new Int32Array(h).fill(w)
  const right = new Int32Array(h).fill(-1)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > A_MIN) {
        count[y]++
        if (x < left[y]) left[y] = x
        if (x > right[y]) right[y] = x
      }
    }
  }
  return { count, left, right }
}

export function findBase(data: Uint8ClampedArray, w: number, h: number): { cut: number; note: string } {
  const { count, right, left } = rowStats(data, w, h)
  let bottom = -1
  for (let y = h - 1; y >= 0; y--) {
    if (count[y] > 0) {
      bottom = y
      break
    }
  }
  if (bottom < 4) return { cut: 0, note: 'nothing to trim' }

  const widthAt = (y: number) => (right[y] >= left[y] ? right[y] - left[y] + 1 : 0)

  // Two things were wrong with reading this from the bottom row up.
  //
  // First, a slab is drawn as an ELLIPSE, and an ellipse tapers to a point at
  // its bottom edge: the last row of a 52px sand island is 6px wide. A scan
  // that starts there reads "narrow" on its very first row, ends where it
  // began, and cuts nothing. Measured on his three palms, 2026-08-19: every
  // one came back "no base found".
  //
  // Second, "narrow" was a guessed fraction of the widest row. Three trunks
  // together are half the width of the slab they stand on, so any fraction
  // tight enough to catch a single trunk misses a cluster.
  //
  // The signature that actually holds is a WAIST: the slab bulges, the thing
  // standing on it pinches in, and the crown spreads out again above. So find
  // the bulge, find the narrowest row above it, and cut at the lowest row that
  // is already down to waist width. No fraction is guessed; the object's own
  // trunk sets the threshold.
  const look = Math.min(bottom + 1, Math.max(8, Math.round(h * 0.3)))
  const floor = bottom - look + 1
  let widest = 0
  let wy = bottom
  for (let y = bottom; y >= floor; y--)
    if (widthAt(y) > widest) {
      widest = widthAt(y)
      wy = y
    }
  if (widest < 10) return { cut: 0, note: 'too small to have a base' }
  if (wy <= floor) return { cut: 0, note: 'no base found, it widens all the way down' }

  let waist = widest
  for (let y = floor; y < wy; y++) waist = Math.min(waist, widthAt(y))
  // a real pedestal is half again wider than what stands on it. Below that the
  // shape is just a wide-bottomed object (a house, a crate, a boulder) and
  // there is nothing here to take off
  if (waist < 3 || widest < waist * 1.45)
    return { cut: 0, note: 'no base found, it widens all the way down' }

  const lim = Math.max(waist * 1.25, waist + 2)
  let cutRow = -1
  for (let y = bottom; y >= floor; y--)
    if (y < wy && widthAt(y) <= lim) {
      cutRow = y
      break
    }
  if (cutRow < 0) return { cut: 0, note: 'no base found, it widens all the way down' }

  const rows = bottom - cutRow
  if (rows < 3 || widthAt(cutRow) < 3) return { cut: 0, note: 'nothing to trim' }
  // a pedestal is a small share of the object; more than this and the shape
  // itself is wide-bottomed, so leave it alone
  if (rows > h * 0.42) return { cut: 0, note: 'that is the object, not a base' }
  return { cut: rows, note: `${rows}px of base under a ${widthAt(cutRow)}px stem` }
}

/* Erase the base rows rather than cropping them: the sprite keeps its size, so
 * a placement's feet anchor does not jump when this is applied to something
 * already on the map. */
export function debase(data: Uint8ClampedArray, w: number, h: number): DebaseResult {
  const found = findBase(data, w, h)
  if (!found.cut) return { data, width: w, height: h, cut: 0, note: found.note }
  const out = new Uint8ClampedArray(data)
  let bottom = -1
  for (let y = h - 1; y >= 0 && bottom < 0; y--)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3] > A_MIN) {
        bottom = y
        break
      }
  for (let y = bottom - found.cut + 1; y <= bottom; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      out[i] = 0
      out[i + 1] = 0
      out[i + 2] = 0
      out[i + 3] = 0
    }
  return { data: out, width: w, height: h, cut: found.cut, note: found.note }
}
