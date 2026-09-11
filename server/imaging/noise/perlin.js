// Perlin and simplex noise, with a seeded permutation.
//
// Everything here is deterministic from its seed. A ground texture that comes
// back different on the second run cannot be compared against the first, and a
// map generated twice has to be the same map.

const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
]

/* mulberry32: small, fast, and good enough for a shuffle. Not for anything that
 * needs to be unpredictable, which nothing in a texture does. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function permutation(seed = 0) {
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  const rand = rng(seed)
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  const doubled = new Uint8Array(512)
  doubled.set(p)
  doubled.set(p, 256)
  return doubled
}

/* 6t^5 - 15t^4 + 10t^3, which has a zero second derivative at both ends. The
 * older 3t^2 - 2t^3 does not, and the discontinuity shows as a visible grid of
 * creases along the lattice lines. */
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10)
const lerp = (a, b, t) => a + (b - a) * t

export class Perlin {
  constructor(seed = 0) {
    this.p = permutation(seed)
  }

  at(x, y) {
    const xi = Math.floor(x) & 255
    const yi = Math.floor(y) & 255
    const xf = x - Math.floor(x)
    const yf = y - Math.floor(y)
    const u = fade(xf)
    const v = fade(yf)

    const aa = this.p[this.p[xi] + yi]
    const ab = this.p[this.p[xi] + yi + 1]
    const ba = this.p[this.p[xi + 1] + yi]
    const bb = this.p[this.p[xi + 1] + yi + 1]

    const g = (hash, dx, dy) => {
      const grad = GRAD2[hash & 7]
      return grad[0] * dx + grad[1] * dy
    }

    const x1 = lerp(g(aa, xf, yf), g(ba, xf - 1, yf), u)
    const x2 = lerp(g(ab, xf, yf - 1), g(bb, xf - 1, yf - 1), u)
    return lerp(x1, x2, v)
  }

  /* octaves summed at halving amplitude and doubling frequency, which is what
   * turns one smooth field into something with detail at every scale */
  fbm(x, y, { octaves = 4, lacunarity = 2, gain = 0.5 } = {}) {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      sum += this.at(x * freq, y * freq) * amp
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return norm === 0 ? 0 : sum / norm
  }

  ridged(x, y, opts) {
    return 1 - Math.abs(this.fbm(x, y, opts))
  }
}

const F2 = 0.5 * (Math.sqrt(3) - 1)
const G2 = (3 - Math.sqrt(3)) / 6

/* simplex skews the square lattice to a triangular one, so the number of
 * corners to blend is three rather than four and there is no directional bias
 * along the axes the way perlin has */
export class Simplex {
  constructor(seed = 0) {
    this.p = permutation(seed)
  }

  at(xin, yin) {
    const s = (xin + yin) * F2
    const i = Math.floor(xin + s)
    const j = Math.floor(yin + s)
    const t = (i + j) * G2
    const x0 = xin - (i - t)
    const y0 = yin - (j - t)

    const i1 = x0 > y0 ? 1 : 0
    const j1 = x0 > y0 ? 0 : 1

    const x1 = x0 - i1 + G2
    const y1 = y0 - j1 + G2
    const x2 = x0 - 1 + 2 * G2
    const y2 = y0 - 1 + 2 * G2

    const ii = i & 255
    const jj = j & 255
    const g0 = GRAD2[this.p[ii + this.p[jj]] & 7]
    const g1 = GRAD2[this.p[ii + i1 + this.p[jj + j1]] & 7]
    const g2 = GRAD2[this.p[ii + 1 + this.p[jj + 1]] & 7]

    const corner = (gx, gy, dx, dy) => {
      let t0 = 0.5 - dx * dx - dy * dy
      if (t0 < 0) return 0
      t0 *= t0
      return t0 * t0 * (gx * dx + gy * dy)
    }

    return 70 * (corner(g0[0], g0[1], x0, y0) + corner(g1[0], g1[1], x1, y1) + corner(g2[0], g2[1], x2, y2))
  }
}

/* cellular noise: distance to the nearest of a set of scattered points. What
 * stone, scales and cracked ground are made of. */
export class Worley {
  constructor(seed = 0) {
    this.seed = seed >>> 0
  }

  point(cx, cy) {
    let h = (cx * 374761393 + cy * 668265263 + this.seed) >>> 0
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
    const a = ((h ^ (h >>> 16)) >>> 0) / 4294967296
    h = Math.imul(h ^ (h >>> 7), 2246822519) >>> 0
    const b = ((h ^ (h >>> 16)) >>> 0) / 4294967296
    return [cx + a, cy + b]
  }

  at(x, y, { order = 1 } = {}) {
    const cx = Math.floor(x)
    const cy = Math.floor(y)
    const found = []
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const p = this.point(cx + dx, cy + dy)
        found.push(Math.hypot(p[0] - x, p[1] - y))
      }
    }
    found.sort((a, b) => a - b)
    return found[Math.min(order - 1, found.length - 1)]
  }
}
