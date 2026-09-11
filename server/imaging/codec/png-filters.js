// The five png row filters, and the heuristic for choosing between them.
//
// A png stores each row filtered by one of five predictors, and the choice is
// per row. Pixel art compresses dramatically better under the right one: a flat
// area under Sub is a row of zeroes, and the same row under None is a row of
// distinct bytes that deflate has to encode.

export const NONE = 0
export const SUB = 1
export const UP = 2
export const AVERAGE = 3
export const PAETH = 4

/* the predictor from the spec: whichever of left, above and upper-left is
 * closest to their combined estimate. It is the one that handles a diagonal
 * edge, which is most of a pixel-art outline. */
export function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

export function filterRow(type, row, prev, bpp) {
  const out = new Uint8Array(row.length)
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0
    const b = prev ? prev[i] : 0
    const c = i >= bpp && prev ? prev[i - bpp] : 0
    switch (type) {
      case SUB:
        out[i] = (row[i] - a) & 0xff
        break
      case UP:
        out[i] = (row[i] - b) & 0xff
        break
      case AVERAGE:
        out[i] = (row[i] - ((a + b) >> 1)) & 0xff
        break
      case PAETH:
        out[i] = (row[i] - paeth(a, b, c)) & 0xff
        break
      default:
        out[i] = row[i]
    }
  }
  return out
}

export function unfilterRow(type, row, prev, bpp) {
  const out = new Uint8Array(row.length)
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? out[i - bpp] : 0
    const b = prev ? prev[i] : 0
    const c = i >= bpp && prev ? prev[i - bpp] : 0
    switch (type) {
      case SUB:
        out[i] = (row[i] + a) & 0xff
        break
      case UP:
        out[i] = (row[i] + b) & 0xff
        break
      case AVERAGE:
        out[i] = (row[i] + ((a + b) >> 1)) & 0xff
        break
      case PAETH:
        out[i] = (row[i] + paeth(a, b, c)) & 0xff
        break
      default:
        out[i] = row[i]
    }
  }
  return out
}

/* the minimum sum of absolute differences, treating bytes as signed. It is the
 * heuristic the spec itself suggests and it is within a percent or two of
 * trying all five through the actual compressor, for a fraction of the time. */
export function chooseFilter(row, prev, bpp) {
  let best = NONE
  let bestScore = Infinity
  for (const type of [NONE, SUB, UP, AVERAGE, PAETH]) {
    const filtered = filterRow(type, row, prev, bpp)
    let score = 0
    for (let i = 0; i < filtered.length; i++) {
      const v = filtered[i]
      score += v < 128 ? v : 256 - v
    }
    if (score < bestScore) {
      bestScore = score
      best = type
    }
  }
  return best
}

/* png interlacing, which nothing here writes but a reader has to understand.
 * Seven passes, each a different lattice over the image. */
export const ADAM7 = [
  { x: 0, y: 0, dx: 8, dy: 8 },
  { x: 4, y: 0, dx: 8, dy: 8 },
  { x: 0, y: 4, dx: 4, dy: 8 },
  { x: 2, y: 0, dx: 4, dy: 4 },
  { x: 0, y: 2, dx: 2, dy: 4 },
  { x: 1, y: 0, dx: 2, dy: 2 },
  { x: 0, y: 1, dx: 1, dy: 2 },
]

export function passSize(pass, w, h) {
  const p = ADAM7[pass]
  return { w: Math.ceil(Math.max(0, w - p.x) / p.dx), h: Math.ceil(Math.max(0, h - p.y) / p.dy) }
}
