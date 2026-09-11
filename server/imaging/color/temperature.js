// Colour temperature, for matching one painting's light to another's.
//
// Two maps drawn months apart drift: one is lit warm and one is lit neutral, and
// placing a prop from the first onto the second reads as a sticker. Measuring
// the light rather than eyeballing it is what makes a correction repeatable.

import { rgbToXYZ, xyzToRGB, toChromaticity, adapt, D65 } from './xyz.js'

/* Planckian locus by the Kim cubic, which is accurate from 1667K to 25000K and
 * is the range anything in a painting sits in */
export function kelvinToChromaticity(k) {
  const t = Math.max(1667, Math.min(25000, k))
  let x
  if (t <= 4000) x = -0.2661239e9 / (t * t * t) - 0.2343589e6 / (t * t) + 0.8776956e3 / t + 0.179910
  else x = -3.0258469e9 / (t * t * t) + 2.1070379e6 / (t * t) + 0.2226347e3 / t + 0.24039

  let y
  if (t <= 2222) y = -1.1063814 * x * x * x - 1.3481102 * x * x + 2.18555832 * x - 0.20219683
  else if (t <= 4000) y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867
  else y = 3.081758 * x * x * x - 5.8733867 * x * x + 3.75112997 * x - 0.37001483
  return [x, y]
}

export function kelvinToRGB(k) {
  const [x, y] = kelvinToChromaticity(k)
  if (y === 0) return [255, 255, 255]
  const xyz = [x / y, 1, (1 - x - y) / y]
  const rgb = xyzToRGB(xyz)
  const max = Math.max(rgb[0], rgb[1], rgb[2]) || 1
  return rgb.map((c) => Math.round((c / max) * 255))
}

/* McCamy's approximation, inverted off the chromaticity. Good to a few kelvin
 * near daylight and that is all this needs. */
export function estimateKelvin(rgb) {
  const [x, y] = toChromaticity(rgbToXYZ(rgb))
  const n = (x - 0.332) / (0.1858 - y)
  return 449 * n * n * n + 3525 * n * n + 6823.3 * n + 5520.33
}

/* a whole image pushed from one light to another, through Bradford. Scaling the
 * channels directly is the shortcut and it shifts every hue on the way. */
export function shiftTemperature(rgba, fromK, toK) {
  const a = kelvinToChromaticity(fromK)
  const b = kelvinToChromaticity(toK)
  const wa = [a[0] / a[1], 1, (1 - a[0] - a[1]) / a[1]]
  const wb = [b[0] / b[1], 1, (1 - b[0] - b[1]) / b[1]]
  const out = new Uint8ClampedArray(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) {
      out[i + 3] = 0
      continue
    }
    const rgb = xyzToRGB(adapt(rgbToXYZ([rgba[i], rgba[i + 1], rgba[i + 2]]), wa, wb))
    out[i] = rgb[0]
    out[i + 1] = rgb[1]
    out[i + 2] = rgb[2]
    out[i + 3] = rgba[i + 3]
  }
  return out
}

/* the average light of a painting, ignoring transparent pixels, which is the
 * measurement a style match is actually made against */
export function averageLight(rgba) {
  let x = 0
  let y = 0
  let z = 0
  let n = 0
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue
    const c = rgbToXYZ([rgba[i], rgba[i + 1], rgba[i + 2]])
    x += c[0]
    y += c[1]
    z += c[2]
    n++
  }
  return n === 0 ? D65.slice() : [x / n, y / n, z / n]
}
