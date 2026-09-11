// k-means in OKLab, for when the palette is allowed to invent colours.
//
// Median cut and the octree both answer with colours that were IN the picture.
// k-means answers with the centre of each cluster, which is usually a colour
// that was not, and for a shading ramp that is the better answer.

import { rgbToOklab, oklabToRGB } from '../color/oklab.js'
import { histogram, unpackRGB } from '../color/srgb.js'

/* k-means++ seeding, because plain random seeding on a picture with one large
 * flat area puts most centres inside that area and the result is a palette of
 * twelve nearly identical skies */
function seed(points, weights, k, rand) {
  const centres = []
  let first = 0
  let total = 0
  for (let i = 0; i < weights.length; i++) total += weights[i]
  let pick = rand() * total
  for (let i = 0; i < weights.length; i++) {
    pick -= weights[i]
    if (pick <= 0) {
      first = i
      break
    }
  }
  centres.push(points[first].slice())

  const best = new Float64Array(points.length).fill(Infinity)
  while (centres.length < k) {
    const c = centres[centres.length - 1]
    let sum = 0
    for (let i = 0; i < points.length; i++) {
      const d = dist2(points[i], c)
      if (d < best[i]) best[i] = d
      sum += best[i] * weights[i]
    }
    if (sum === 0) break
    let r = rand() * sum
    let chosen = points.length - 1
    for (let i = 0; i < points.length; i++) {
      r -= best[i] * weights[i]
      if (r <= 0) {
        chosen = i
        break
      }
    }
    centres.push(points[chosen].slice())
  }
  return centres
}

function dist2(a, b) {
  const d0 = a[0] - b[0]
  const d1 = a[1] - b[1]
  const d2 = a[2] - b[2]
  return d0 * d0 + d1 * d1 + d2 * d2
}

/* a seeded generator, so the same picture and the same k give the same palette
 * every run. A quantiser that answers differently each time cannot be compared
 * against its own previous answer. */
function mulberry(seedValue) {
  let a = seedValue >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function kmeansQuantize(rgba, want = 16, { iterations = 24, seed: s = 1 } = {}) {
  const hist = histogram(rgba)
  if (hist.size === 0) return []
  const points = []
  const weights = []
  for (const [key, n] of hist) {
    points.push(rgbToOklab(unpackRGB(key)))
    weights.push(n)
  }
  if (points.length <= want) return points.map(oklabToRGB)

  const rand = mulberry(s)
  let centres = seed(points, weights, want, rand)
  const assign = new Int32Array(points.length).fill(-1)

  for (let iter = 0; iter < iterations; iter++) {
    let moved = 0
    for (let i = 0; i < points.length; i++) {
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < centres.length; c++) {
        const d = dist2(points[i], centres[c])
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      if (assign[i] !== best) {
        assign[i] = best
        moved++
      }
    }
    // nothing changed hands, so another pass cannot move a centre either
    if (moved === 0) break

    const sums = centres.map(() => [0, 0, 0, 0])
    for (let i = 0; i < points.length; i++) {
      const s2 = sums[assign[i]]
      const w = weights[i]
      s2[0] += points[i][0] * w
      s2[1] += points[i][1] * w
      s2[2] += points[i][2] * w
      s2[3] += w
    }
    for (let c = 0; c < centres.length; c++) {
      if (sums[c][3] === 0) continue
      centres[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]]
    }
  }
  return centres.map(oklabToRGB)
}
