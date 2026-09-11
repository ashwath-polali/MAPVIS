// Convex hull, and the smallest box that fits a shape at any angle.
//
// Andrew's monotone chain: sort once, then walk up and back. O(n log n) with the
// sort and O(n) after it, and the only floating point comparison is a cross
// product sign, so it does not fall apart on collinear input the way a
// gift-wrapping implementation does.

import { cross, sub, dist } from './vec.js'

export function convexHull(points) {
  if (points.length < 3) return points.slice()
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])

  const half = (list) => {
    const out = []
    for (const p of list) {
      while (out.length >= 2 && cross(sub(out[out.length - 1], out[out.length - 2]), sub(p, out[out.length - 1])) <= 0) out.pop()
      out.push(p)
    }
    out.pop()
    return out
  }

  return half(pts).concat(half(pts.slice().reverse()))
}

/* rotating callipers. The smallest enclosing rectangle always has a side flush
 * with a hull edge, so there are only as many candidates as the hull has edges
 * and each can be measured directly. */
export function minimumAreaRect(points) {
  const hull = convexHull(points)
  if (hull.length < 3) return null
  let best = null

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % hull.length]
    const edge = sub(b, a)
    const l = Math.hypot(edge[0], edge[1])
    if (l === 0) continue
    const ux = edge[0] / l
    const uy = edge[1] / l

    let minU = Infinity
    let maxU = -Infinity
    let minV = Infinity
    let maxV = -Infinity
    for (const p of hull) {
      const d = sub(p, a)
      const u = d[0] * ux + d[1] * uy
      const v = -d[0] * uy + d[1] * ux
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    const w = maxU - minU
    const h = maxV - minV
    if (!best || w * h < best.area) {
      best = { area: w * h, w, h, angle: Math.atan2(uy, ux), origin: [a[0] + ux * minU - uy * minV, a[1] + uy * minU + ux * minV] }
    }
  }
  return best
}

/* the two points furthest apart, which is the longest span of the shape. Off
 * the hull, because the extreme pair is always on it. */
export function diameter(points) {
  const hull = convexHull(points)
  let best = 0
  let pair = null
  for (let i = 0; i < hull.length; i++) {
    for (let j = i + 1; j < hull.length; j++) {
      const d = dist(hull[i], hull[j])
      if (d > best) {
        best = d
        pair = [hull[i], hull[j]]
      }
    }
  }
  return { length: best, pair }
}
