// MaxRects bin packing, which is what puts every frame of a map on one sheet.
//
// The free space is kept as a list of maximal rectangles rather than a tree, so
// a rectangle that becomes usable when two neighbours are freed is found without
// a merge pass. It packs tighter than a shelf or a skyline at the cost of the
// pruning below being O(n squared) in the free list.

export const HEURISTIC = {
  shortSide: 'short-side',
  longSide: 'long-side',
  area: 'area',
  bottomLeft: 'bottom-left',
}

export class MaxRects {
  constructor(width, height, { allowRotate = false } = {}) {
    this.width = width
    this.height = height
    this.allowRotate = allowRotate
    this.free = [{ x: 0, y: 0, w: width, h: height }]
    this.used = []
  }

  insert(w, h, heuristic = HEURISTIC.shortSide) {
    const spot = this.find(w, h, heuristic)
    if (!spot) return null
    this.place(spot)
    return spot
  }

  find(w, h, heuristic) {
    let best = null
    let bestA = Infinity
    let bestB = Infinity

    const consider = (rw, rh, rotated) => {
      for (const f of this.free) {
        if (f.w < rw || f.h < rh) continue
        const leftover = [Math.abs(f.w - rw), Math.abs(f.h - rh)]
        let a
        let b
        if (heuristic === HEURISTIC.bottomLeft) {
          a = f.y + rh
          b = f.x
        } else if (heuristic === HEURISTIC.area) {
          a = f.w * f.h - rw * rh
          b = Math.min(leftover[0], leftover[1])
        } else if (heuristic === HEURISTIC.longSide) {
          a = Math.max(leftover[0], leftover[1])
          b = Math.min(leftover[0], leftover[1])
        } else {
          a = Math.min(leftover[0], leftover[1])
          b = Math.max(leftover[0], leftover[1])
        }
        if (a < bestA || (a === bestA && b < bestB)) {
          bestA = a
          bestB = b
          best = { x: f.x, y: f.y, w: rw, h: rh, rotated }
        }
      }
    }

    consider(w, h, false)
    if (this.allowRotate && w !== h) consider(h, w, true)
    return best
  }

  place(rect) {
    const next = []
    for (const f of this.free) {
      if (!splitFree(f, rect, next)) next.push(f)
    }
    this.free = next
    prune(this.free)
    this.used.push(rect)
  }

  occupancy() {
    const used = this.used.reduce((s, r) => s + r.w * r.h, 0)
    return used / (this.width * this.height)
  }
}

/* the rectangle is cut out of a free one, leaving up to four maximal pieces.
 * Returns false when they do not overlap at all, so the caller keeps the
 * original rather than replacing it with copies of itself. */
function splitFree(free, rect, out) {
  if (rect.x >= free.x + free.w || rect.x + rect.w <= free.x || rect.y >= free.y + free.h || rect.y + rect.h <= free.y) return false

  if (rect.x < free.x + free.w && rect.x + rect.w > free.x) {
    if (rect.y > free.y && rect.y < free.y + free.h) out.push({ x: free.x, y: free.y, w: free.w, h: rect.y - free.y })
    if (rect.y + rect.h < free.y + free.h) out.push({ x: free.x, y: rect.y + rect.h, w: free.w, h: free.y + free.h - (rect.y + rect.h) })
  }
  if (rect.y < free.y + free.h && rect.y + rect.h > free.y) {
    if (rect.x > free.x && rect.x < free.x + free.w) out.push({ x: free.x, y: free.y, w: rect.x - free.x, h: free.h })
    if (rect.x + rect.w < free.x + free.w) out.push({ x: rect.x + rect.w, y: free.y, w: free.x + free.w - (rect.x + rect.w), h: free.h })
  }
  return true
}

/* any free rectangle wholly inside another is not maximal and only costs time
 * on every later search */
function prune(free) {
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      if (inside(free[i], free[j])) {
        free.splice(i, 1)
        i--
        break
      }
      if (inside(free[j], free[i])) {
        free.splice(j, 1)
        j--
      }
    }
  }
}

const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h

/* biggest first, which is the ordering that matters far more than the heuristic:
 * inserting small rectangles early fragments the free list before the large ones
 * arrive and they then do not fit at all */
export function packAll(items, width, height, opts = {}) {
  const bin = new MaxRects(width, height, opts)
  const order = items
    .map((it, i) => ({ ...it, index: i }))
    .sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h)
  const placed = []
  const failed = []
  for (const it of order) {
    const spot = bin.insert(it.w, it.h, opts.heuristic)
    if (spot) placed.push({ ...it, ...spot })
    else failed.push(it)
  }
  return { placed, failed, occupancy: bin.occupancy(), bin }
}
