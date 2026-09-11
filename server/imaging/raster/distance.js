// Exact euclidean distance transform, by Felzenszwalb and Huttenlocher.
//
// How far every empty pixel is from the nearest filled one. It answers "where is
// the middle of this room" and "how wide is this corridor at its narrowest",
// both of which are questions about a map that are otherwise guessed at.
//
// The naive version is O(n) per pixel against every filled pixel. This is two
// one dimensional passes, each linear, and the answer is exact rather than the
// chamfer approximation most implementations settle for.

const INF = 1e20

/* the lower envelope of a set of parabolas, one per row entry. The whole trick:
 * the squared distance from a row of sources is a parabola per source, and the
 * distance transform is the lowest of them at each x. */
function edt1d(f, n) {
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF

  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }

  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
  return d
}

export function distanceTransform(plane, { threshold = 1, invert = false } = {}) {
  const { w, h } = plane
  const f = new Float64Array(Math.max(w, h))
  const out = new Float64Array(w * h)

  for (let i = 0; i < out.length; i++) {
    const filled = plane.data[i] >= threshold
    out[i] = (invert ? !filled : filled) ? 0 : INF
  }

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x]
    const d = edt1d(f, h)
    for (let y = 0; y < h; y++) out[y * w + x] = d[y]
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x]
    const d = edt1d(f, w)
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x])
  }
  return out
}

/* the point furthest from any edge, which is where a label goes so it does not
 * run off the shape */
export function poleOfInaccessibility(plane, opts) {
  const d = distanceTransform(plane, { ...opts, invert: true })
  let best = -1
  let bx = 0
  let by = 0
  for (let y = 0; y < plane.h; y++) {
    for (let x = 0; x < plane.w; x++) {
      const i = y * plane.w + x
      if (!plane.data[i]) continue
      if (d[i] > best) {
        best = d[i]
        bx = x
        by = y
      }
    }
  }
  return { x: bx, y: by, radius: best }
}

/* the narrowest point of a shape, doubled, which is the widest body that can
 * pass through it */
export function narrowest(plane, opts) {
  const d = distanceTransform(plane, { ...opts, invert: true })
  let min = Infinity
  for (let i = 0; i < d.length; i++) {
    if (!plane.data[i]) continue
    if (d[i] > 0 && d[i] < min) min = d[i]
  }
  return min === Infinity ? 0 : min * 2
}
