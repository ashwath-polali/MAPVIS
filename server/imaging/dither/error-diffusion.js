// Error diffusion against a fixed palette.
//
// The error is carried in LINEAR light and not in eight-bit values. Diffusing
// the encoded difference pushes too much error in the shadows and not enough in
// the highlights, and the visible result is a dark area that goes blotchy while
// a bright one stays banded.

import { KERNELS, FLOYD_STEINBERG } from './kernels.js'
import { cachedMatcher } from '../quantize/kdtree.js'
import { toLinear, toSRGB, clamp255 } from '../color/srgb.js'

export function diffuse(rgba, w, h, palette, { kernel = FLOYD_STEINBERG, serpentine = true, strength = 1 } = {}) {
  const k = typeof kernel === 'string' ? KERNELS[kernel] || FLOYD_STEINBERG : kernel
  const match = cachedMatcher(palette)
  const out = new Uint8ClampedArray(rgba.length)

  // one float buffer of linear light, which is what the error is added to
  const buf = new Float32Array(w * h * 3)
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 3) {
    buf[p] = toLinear(rgba[i] / 255)
    buf[p + 1] = toLinear(rgba[i + 1] / 255)
    buf[p + 2] = toLinear(rgba[i + 2] / 255)
  }

  for (let y = 0; y < h; y++) {
    // every other row read backwards, so the error does not all drift to one
    // side and leave a visible lean across a large flat area
    const flip = serpentine && (y & 1) === 1
    for (let n = 0; n < w; n++) {
      const x = flip ? w - 1 - n : n
      const p = (y * w + x) * 3
      const i = (y * w + x) * 4
      if (rgba[i + 3] === 0) {
        out[i + 3] = 0
        continue
      }

      const want = [
        clamp255(Math.round(toSRGB(clamp01(buf[p])) * 255)),
        clamp255(Math.round(toSRGB(clamp01(buf[p + 1])) * 255)),
        clamp255(Math.round(toSRGB(clamp01(buf[p + 2])) * 255)),
      ]
      const got = palette[match(want)]
      out[i] = got[0]
      out[i + 1] = got[1]
      out[i + 2] = got[2]
      out[i + 3] = rgba[i + 3]

      const err = [
        (buf[p] - toLinear(got[0] / 255)) * strength,
        (buf[p + 1] - toLinear(got[1] / 255)) * strength,
        (buf[p + 2] - toLinear(got[2] / 255)) * strength,
      ]

      for (const [dx0, dy, weight] of k.points) {
        const dx = flip ? -dx0 : dx0
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
        const q = (ny * w + nx) * 3
        const f = weight / k.divisor
        buf[q] += err[0] * f
        buf[q + 1] += err[1] * f
        buf[q + 2] += err[2] * f
      }
    }
  }
  return out
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/* no diffusion at all, which is the honest baseline every dither should be
 * compared against before anybody claims one looks better */
export function nearest(rgba, palette) {
  const match = cachedMatcher(palette)
  const out = new Uint8ClampedArray(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) {
      out[i + 3] = 0
      continue
    }
    const got = palette[match([rgba[i], rgba[i + 1], rgba[i + 2]])]
    out[i] = got[0]
    out[i + 1] = got[1]
    out[i + 2] = got[2]
    out[i + 3] = rgba[i + 3]
  }
  return out
}
