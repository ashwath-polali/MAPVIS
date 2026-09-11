// Ordered dithering, which is the one that belongs on pixel art.
//
// Error diffusion produces a pattern that changes with the content, so a sprite
// dithered at one size and again at another does not match itself. An ordered
// matrix is fixed to the grid, so the texture is stable, tiles, and reads as a
// deliberate hatch rather than as noise.

import { cachedMatcher } from '../quantize/kdtree.js'
import { clamp255 } from '../color/srgb.js'

/* a Bayer matrix of any power-of-two size, built from the recurrence rather
 * than typed out, because the 16x16 is 256 numbers nobody should transcribe */
export function bayer(n) {
  if (n <= 1) return [[0]]
  const half = bayer(n >> 1)
  const size = n
  const out = Array.from({ length: size }, () => new Array(size).fill(0))
  const h = n >> 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < h; x++) {
      const v = half[y][x] * 4
      out[y][x] = v
      out[y][x + h] = v + 2
      out[y + h][x] = v + 3
      out[y + h][x + h] = v + 1
    }
  }
  return out
}

/* normalised to -0.5..0.5 so applying it does not shift the overall brightness
 * of the picture, which a 0..1 matrix does by half a step */
export function bayerNormalised(n) {
  const m = bayer(n)
  const denom = n * n
  return m.map((row) => row.map((v) => v / denom - 0.5))
}

export function orderedDither(rgba, w, h, palette, { size = 8, strength = 32 } = {}) {
  const m = bayerNormalised(size)
  const match = cachedMatcher(palette)
  const out = new Uint8ClampedArray(rgba.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (rgba[i + 3] === 0) {
        out[i + 3] = 0
        continue
      }
      const t = m[y % size][x % size] * strength
      const got = palette[match([clamp255(rgba[i] + t), clamp255(rgba[i + 1] + t), clamp255(rgba[i + 2] + t)])]
      out[i] = got[0]
      out[i + 1] = got[1]
      out[i + 2] = got[2]
      out[i + 3] = rgba[i + 3]
    }
  }
  return out
}

/* a void-and-cluster style matrix is expensive to build and is precomputed in
 * tables/blue-noise.js; this takes one and applies it the same way */
export function noiseDither(rgba, w, h, palette, noise, noiseW, { strength = 32 } = {}) {
  const match = cachedMatcher(palette)
  const out = new Uint8ClampedArray(rgba.length)
  const noiseH = noise.length / noiseW
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (rgba[i + 3] === 0) {
        out[i + 3] = 0
        continue
      }
      const t = (noise[(y % noiseH) * noiseW + (x % noiseW)] / 255 - 0.5) * strength
      const got = palette[match([clamp255(rgba[i] + t), clamp255(rgba[i + 1] + t), clamp255(rgba[i + 2] + t)])]
      out[i] = got[0]
      out[i + 1] = got[1]
      out[i + 2] = got[2]
      out[i + 3] = rgba[i + 3]
    }
  }
  return out
}
