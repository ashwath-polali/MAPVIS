// Two ways to throw points away without changing the shape.
//
// A hand-traced outline arrives with a point per pointer event, which is
// hundreds for a shape whose corners number six. Every consumer walks the list,
// so the cost is paid on every read forever.

import { distToSegment, dist } from './vec.js'

/* Douglas-Peucker keeps the point furthest from the chord and recurses. It
 * preserves corners exactly, which is what a building outline needs, and it can
 * leave long smooth curves looking faceted. */
export function douglasPeucker(pts, tolerance) {
  if (pts.length < 3) return pts.slice()

  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1

  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()
    let worst = 0
    let index = 0
    for (let i = first + 1; i < last; i++) {
      const d = distToSegment(pts[i], pts[first], pts[last])
      if (d > worst) {
        worst = d
        index = i
      }
    }
    if (worst > tolerance) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/* Visvalingam drops the point whose triangle with its neighbours is smallest,
 * repeatedly. It degrades gracefully: a shape simplified hard still looks like
 * itself, where Douglas-Peucker at a hard tolerance can collapse to a line. */
export function visvalingam(pts, keepCount) {
  if (pts.length <= keepCount || pts.length < 3) return pts.slice()
  const live = pts.map((p, i) => ({ p, i, prev: i - 1, next: i + 1, area: 0 }))
  const areaOf = (i) => {
    const n = live[i]
    if (n.prev < 0 || n.next >= live.length) return Infinity
    const a = live[n.prev].p
    const b = n.p
    const c = live[n.next].p
    return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2
  }
  for (let i = 0; i < live.length; i++) live[i].area = areaOf(i)

  const removed = new Uint8Array(live.length)
  let remaining = live.length
  while (remaining > keepCount) {
    let pick = -1
    let smallest = Infinity
    for (let i = 0; i < live.length; i++) {
      if (removed[i] || live[i].area === Infinity) continue
      if (live[i].area < smallest) {
        smallest = live[i].area
        pick = i
      }
    }
    if (pick < 0) break
    removed[pick] = 1
    remaining--
    const { prev, next } = live[pick]
    if (prev >= 0) live[prev].next = next
    if (next < live.length) live[next].prev = prev
    // both neighbours now span a wider triangle, so their own areas changed
    if (prev >= 0) live[prev].area = areaOf(prev)
    if (next < live.length) live[next].area = areaOf(next)
  }
  return live.filter((_, i) => !removed[i]).map((n) => n.p)
}

/* points closer together than a step contribute nothing a rasteriser can see */
export function dropDense(pts, minStep) {
  if (pts.length < 2) return pts.slice()
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    if (dist(out[out.length - 1], pts[i]) >= minStep) out.push(pts[i])
  }
  if (out.length < 2) out.push(pts[pts.length - 1])
  return out
}

/* a chain resampled to an even spacing, which is what a route wants before it
 * is walked so the steps are the same length everywhere */
export function resample(pts, step) {
  if (pts.length < 2) return pts.slice()
  const out = [pts[0].slice()]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const segment = dist(a, b)
    if (segment === 0) continue
    let travelled = carry
    while (travelled + step <= segment) {
      travelled += step
      const t = travelled / segment
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
    carry = travelled - segment
  }
  const last = pts[pts.length - 1]
  if (dist(out[out.length - 1], last) > 1e-9) out.push(last.slice())
  return out
}
