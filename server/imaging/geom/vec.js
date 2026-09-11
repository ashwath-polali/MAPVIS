// Two dimensional vector arithmetic, on plain arrays.
//
// Plain [x, y] rather than a class, because every one of these crosses a wire as
// JSON at some point and a class arrives on the other side as an object with no
// methods. Nothing here allocates more than it has to.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
export const scale = (a, k) => [a[0] * k, a[1] * k]
export const neg = (a) => [-a[0], -a[1]]
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1]
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0]
export const len = (a) => Math.hypot(a[0], a[1])
export const len2 = (a) => a[0] * a[0] + a[1] * a[1]
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
export const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2

export function normalise(a) {
  const l = len(a)
  return l === 0 ? [0, 0] : [a[0] / l, a[1] / l]
}

export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
export const perp = (a) => [-a[1], a[0]]

export function rotate(a, radians) {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c]
}

export function angle(a, b) {
  return Math.atan2(b[1] - a[1], b[0] - a[0])
}

/* the nearest point on a segment, clamped to its ends. The building block of
 * every "how far is this from that path" question. */
export function closestOnSegment(p, a, b) {
  const ab = sub(b, a)
  const l = len2(ab)
  if (l === 0) return a.slice()
  let t = dot(sub(p, a), ab) / l
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return [a[0] + ab[0] * t, a[1] + ab[1] * t]
}

export function distToSegment(p, a, b) {
  return dist(p, closestOnSegment(p, a, b))
}

/* which side of the line a to b the point is on: positive is left with y down,
 * which is the convention every raster in this library uses */
export const side = (p, a, b) => cross(sub(b, a), sub(p, a))

export function segmentsIntersect(a, b, c, d) {
  const d1 = side(c, a, b)
  const d2 = side(d, a, b)
  const d3 = side(a, c, d)
  const d4 = side(b, c, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  // the collinear cases, which the sign test above cannot see
  if (d1 === 0 && onSegment(a, b, c)) return true
  if (d2 === 0 && onSegment(a, b, d)) return true
  if (d3 === 0 && onSegment(c, d, a)) return true
  if (d4 === 0 && onSegment(c, d, b)) return true
  return false
}

function onSegment(a, b, p) {
  return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
}

export function intersection(a, b, c, d) {
  const r = sub(b, a)
  const s = sub(d, c)
  const denom = cross(r, s)
  if (denom === 0) return null
  const t = cross(sub(c, a), s) / denom
  return [a[0] + r[0] * t, a[1] + r[1] * t]
}
