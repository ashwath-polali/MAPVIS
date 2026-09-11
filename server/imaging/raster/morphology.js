// Erode, dilate, open, close and the outline that falls out of them.
//
// A hand-painted mask has ragged edges and single stray pixels. An open removes
// the strays without moving the shape; a close fills the pinholes a brush leaves
// where two strokes nearly met. Both are two passes of the same primitive.

import { Plane } from './plane.js'

const CROSS = [[0, -1], [-1, 0], [0, 0], [1, 0], [0, 1]]
const SQUARE = [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]

export const STRUCTURE = { cross: CROSS, square: SQUARE }

export function dilate(plane, { shape = SQUARE, times = 1 } = {}) {
  let cur = plane
  for (let t = 0; t < times; t++) {
    const out = new Plane(cur.w, cur.h)
    for (let y = 0; y < cur.h; y++) {
      for (let x = 0; x < cur.w; x++) {
        let max = 0
        for (const [dx, dy] of shape) {
          const v = cur.get(x + dx, y + dy)
          if (v > max) max = v
        }
        out.data[y * cur.w + x] = max
      }
    }
    cur = out
  }
  return cur
}

export function erode(plane, { shape = SQUARE, times = 1 } = {}) {
  let cur = plane
  for (let t = 0; t < times; t++) {
    const out = new Plane(cur.w, cur.h)
    for (let y = 0; y < cur.h; y++) {
      for (let x = 0; x < cur.w; x++) {
        let min = 255
        for (const [dx, dy] of shape) {
          // outside the plane counts as empty, so a shape touching the border
          // erodes away from it, which is what an island wants
          const v = cur.get(x + dx, y + dy)
          if (v < min) min = v
        }
        out.data[y * cur.w + x] = min
      }
    }
    cur = out
  }
  return cur
}

export const open = (plane, opts) => dilate(erode(plane, opts), opts)
export const close = (plane, opts) => erode(dilate(plane, opts), opts)

/* what dilate added, which is the one pixel ring around the shape. The outline
 * of a walkable area, drawn without tracing anything. */
export function outline(plane, { shape = CROSS, inner = false } = {}) {
  const grown = inner ? plane : dilate(plane, { shape })
  const shrunk = inner ? erode(plane, { shape }) : plane
  const out = new Plane(plane.w, plane.h)
  for (let i = 0; i < out.data.length; i++) out.data[i] = grown.data[i] - shrunk.data[i]
  return out
}

/* a pixel with fewer than two filled neighbours is a whisker, not a shape. Run
 * before an outline or the outline grows hairs. */
export function despeckle(plane, minNeighbours = 2) {
  const out = plane.clone()
  for (let y = 0; y < plane.h; y++) {
    for (let x = 0; x < plane.w; x++) {
      if (!plane.get(x, y)) continue
      let n = 0
      for (const [dx, dy] of SQUARE) {
        if (dx === 0 && dy === 0) continue
        if (plane.get(x + dx, y + dy)) n++
      }
      if (n < minNeighbours) out.data[y * plane.w + x] = 0
    }
  }
  return out
}
