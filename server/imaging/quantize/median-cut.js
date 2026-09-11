// Median cut, which is the quantiser to reach for when the palette has to keep
// the picture's own colours rather than invent new ones.
//
// It repeatedly splits the box of colours along its longest axis at the median,
// so every box ends up holding roughly the same number of PIXELS rather than the
// same volume of colour space. That is what stops a large flat sky eating the
// whole palette.

import { histogram, unpackRGB } from '../color/srgb.js'

function boxOf(entries) {
  let rlo = 255, rhi = 0, glo = 255, ghi = 0, blo = 255, bhi = 0, count = 0
  for (const e of entries) {
    if (e.r < rlo) rlo = e.r
    if (e.r > rhi) rhi = e.r
    if (e.g < glo) glo = e.g
    if (e.g > ghi) ghi = e.g
    if (e.b < blo) blo = e.b
    if (e.b > bhi) bhi = e.b
    count += e.n
  }
  return { entries, rlo, rhi, glo, ghi, blo, bhi, count }
}

/* the longest side is measured with the luma weights on, because a box that is
 * wide in blue and narrow in green is perceptually narrower than its numbers
 * say and splitting it first wastes an entry */
function longestAxis(box) {
  const r = (box.rhi - box.rlo) * 0.2126
  const g = (box.ghi - box.glo) * 0.7152
  const b = (box.bhi - box.blo) * 0.0722
  if (r >= g && r >= b) return 'r'
  return g >= b ? 'g' : 'b'
}

function split(box) {
  const axis = longestAxis(box)
  const sorted = box.entries.slice().sort((x, y) => x[axis] - y[axis])
  const half = box.count / 2
  let acc = 0
  let cut = 0
  for (; cut < sorted.length - 1; cut++) {
    acc += sorted[cut].n
    if (acc >= half) break
  }
  return [boxOf(sorted.slice(0, cut + 1)), boxOf(sorted.slice(cut + 1))]
}

function average(box) {
  let r = 0, g = 0, b = 0, n = 0
  for (const e of box.entries) {
    r += e.r * e.n
    g += e.g * e.n
    b += e.b * e.n
    n += e.n
  }
  return n === 0 ? [0, 0, 0] : [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
}

export function medianCut(rgba, want = 16) {
  const hist = histogram(rgba)
  const entries = []
  for (const [key, n] of hist) {
    const [r, g, b] = unpackRGB(key)
    entries.push({ r, g, b, n })
  }
  if (entries.length === 0) return []
  if (entries.length <= want) return entries.map((e) => [e.r, e.g, e.b])

  let boxes = [boxOf(entries)]
  while (boxes.length < want) {
    // always split the box holding the most pixels that still has room to split
    let pick = -1
    let most = -1
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].entries.length < 2) continue
      if (boxes[i].count > most) {
        most = boxes[i].count
        pick = i
      }
    }
    if (pick < 0) break
    const [a, b] = split(boxes[pick])
    boxes.splice(pick, 1, a, b)
  }
  return boxes.map(average)
}
