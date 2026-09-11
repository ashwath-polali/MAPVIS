// Skyline packing, which is the cheap one.
//
// The free space is described by its top edge only, as a list of horizontal
// runs. That throws away any pocket under an overhang, so it packs looser than
// MaxRects, but an insert is O(number of runs) rather than O(free rectangles)
// and the run list stays short.

export class Skyline {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.runs = [{ x: 0, y: 0, w: width }]
    this.used = []
    this.wasted = 0
  }

  insert(w, h) {
    let best = null
    for (let i = 0; i < this.runs.length; i++) {
      const fit = this.fit(i, w, h)
      if (!fit) continue
      // lowest top edge wins, and on a tie the narrower run, which keeps wide
      // runs available for the wide pieces still to come
      if (!best || fit.y < best.y || (fit.y === best.y && this.runs[i].w < this.runs[best.index].w)) {
        best = { ...fit, index: i }
      }
    }
    if (!best) return null
    const rect = { x: best.x, y: best.y, w, h }
    this.add(best.index, rect)
    this.used.push(rect)
    return rect
  }

  fit(index, w, h) {
    const run = this.runs[index]
    if (run.x + w > this.width) return null
    let y = run.y
    let left = w
    for (let i = index; i < this.runs.length && left > 0; i++) {
      if (this.runs[i].y > y) y = this.runs[i].y
      if (y + h > this.height) return null
      left -= this.runs[i].w
    }
    return left > 0 ? null : { x: run.x, y }
  }

  add(index, rect) {
    const inserted = { x: rect.x, y: rect.y + rect.h, w: rect.w }
    this.runs.splice(index, 0, inserted)

    for (let i = index + 1; i < this.runs.length; i++) {
      const cur = this.runs[i]
      const prev = this.runs[i - 1]
      if (cur.x >= prev.x + prev.w) break
      const overlap = prev.x + prev.w - cur.x
      // the area under the new run that can never be reached again, tracked so
      // a caller can see how much of the sheet the heuristic threw away
      this.wasted += overlap * Math.max(0, inserted.y - cur.y)
      cur.x += overlap
      cur.w -= overlap
      if (cur.w > 0) break
      this.runs.splice(i, 1)
      i--
    }
    this.merge()
  }

  merge() {
    for (let i = 0; i < this.runs.length - 1; i++) {
      if (this.runs[i].y !== this.runs[i + 1].y) continue
      this.runs[i].w += this.runs[i + 1].w
      this.runs.splice(i + 1, 1)
      i--
    }
  }

  occupancy() {
    return this.used.reduce((s, r) => s + r.w * r.h, 0) / (this.width * this.height)
  }
}

/* the sheet is square and a power of two, because a texture that is neither is
 * refused outright by some hardware and silently padded by the rest */
export function smallestSheet(items, { max = 4096, min = 64, padding = 0 } = {}) {
  for (let size = min; size <= max; size *= 2) {
    const bin = new Skyline(size, size)
    const order = items.slice().sort((a, b) => b.h - a.h || b.w - a.w)
    let ok = true
    const placed = []
    for (const it of order) {
      const r = bin.insert(it.w + padding, it.h + padding)
      if (!r) {
        ok = false
        break
      }
      placed.push({ ...it, x: r.x, y: r.y })
    }
    if (ok) return { size, placed, occupancy: bin.occupancy(), wasted: bin.wasted }
  }
  return null
}
