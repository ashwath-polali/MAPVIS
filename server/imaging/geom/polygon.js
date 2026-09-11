// Polygons: area, winding, containment and the things that follow from them.
//
// Every region an author draws arrives here as a list of points. Nothing below
// assumes the list is closed, convex, or wound any particular way, because a
// hand-drawn outline is none of those.

import { dist, sub, cross, distToSegment } from './vec.js'

/* the shoelace sum. Signed, because the sign is the winding and the winding is
 * what tells a hole from a shape. */
export function signedArea(pts) {
  let a = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]
  }
  return a / 2
}

export const area = (pts) => Math.abs(signedArea(pts))
export const isClockwise = (pts) => signedArea(pts) < 0

export function perimeter(pts) {
  let p = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) p += dist(pts[j], pts[i])
  return p
}

export function centroid(pts) {
  const a = signedArea(pts)
  if (a === 0) {
    const m = pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0])
    return [m[0] / pts.length, m[1] / pts.length]
  }
  let x = 0
  let y = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]
    x += (pts[j][0] + pts[i][0]) * f
    y += (pts[j][1] + pts[i][1]) * f
  }
  return [x / (6 * a), y / (6 * a)]
}

/* ray casting. The >= on one side and < on the other is not a typo: it is what
 * stops a vertex exactly on the ray being counted twice. */
export function contains(pts, p) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const yi = pts[i][1]
    const yj = pts[j][1]
    if (yi > p[1] !== yj > p[1]) {
      const x = ((pts[j][0] - pts[i][0]) * (p[1] - yi)) / (yj - yi) + pts[i][0]
      if (p[0] < x) inside = !inside
    }
  }
  return inside
}

export function bounds(pts) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0]
    if (p[0] > x1) x1 = p[0]
    if (p[1] < y0) y0 = p[1]
    if (p[1] > y1) y1 = p[1]
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function distanceTo(pts, p) {
  let best = Infinity
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const d = distToSegment(p, pts[j], pts[i])
    if (d < best) best = d
  }
  return contains(pts, p) ? -best : best
}

/* a ring wound the way the caller wants, in place of trusting what arrived */
export function wind(pts, clockwise) {
  return isClockwise(pts) === clockwise ? pts.slice() : pts.slice().reverse()
}

/* three points in a line add nothing but a vertex to carry. Worth dropping
 * before a ring is stored, because every consumer walks it. */
export function dropCollinear(pts, eps = 1e-9) {
  const out = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length]
    const b = pts[i]
    const c = pts[(i + 1) % pts.length]
    if (Math.abs(cross(sub(b, a), sub(c, b))) > eps) out.push(b)
  }
  return out.length >= 3 ? out : pts.slice()
}
