// OKLab and OKLCh, which is what this library blends and ramps in.
//
// Lab was fitted to small colour differences and it is not uniform over large
// ones: its blue is badly placed, so a blue-to-white ramp in Lab swings through
// purple. OKLab is fitted to the whole range, and the straight line between two
// of its colours stays the colour an author expected the whole way.

import { toLinear, toSRGB, clamp255 } from './srgb.js'

const M1 = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
]

const M2 = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
]

const M1_INV = [
  [1.0, 0.3963377774, 0.2158037573],
  [1.0, -0.1055613458, -0.0638541728],
  [1.0, -0.0894841775, -1.291485548],
]

const M2_INV = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
]

const mul = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
]

export function linearToOklab(lin) {
  const lms = mul(M1, lin)
  return mul(M2, [Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2])])
}

export function oklabToLinear(lab) {
  const lms = mul(M1_INV, lab)
  return mul(M2_INV, [lms[0] * lms[0] * lms[0], lms[1] * lms[1] * lms[1], lms[2] * lms[2] * lms[2]])
}

export function rgbToOklab(rgb) {
  return linearToOklab([toLinear(rgb[0] / 255), toLinear(rgb[1] / 255), toLinear(rgb[2] / 255)])
}

export function oklabToRGB(lab) {
  const l = oklabToLinear(lab)
  return [clamp255(Math.round(toSRGB(l[0]) * 255)), clamp255(Math.round(toSRGB(l[1]) * 255)), clamp255(Math.round(toSRGB(l[2]) * 255))]
}

export function oklabToOklch(lab) {
  const c = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2])
  let h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI
  if (h < 0) h += 360
  return [lab[0], c, h]
}

export function oklchToOklab(lch) {
  const r = (lch[2] * Math.PI) / 180
  return [lch[0], Math.cos(r) * lch[1], Math.sin(r) * lch[1]]
}

export const rgbToOklch = (rgb) => oklabToOklch(rgbToOklab(rgb))
export const oklchToRGB = (lch) => oklabToRGB(oklchToOklab(lch))

/* the mix an author means by "halfway between these two". In OKLab, so the
 * midpoint of two saturated colours stays saturated. */
export function mix(a, b, t) {
  const x = rgbToOklab(a)
  const y = rgbToOklab(b)
  return oklabToRGB([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}

/* a ramp of n steps, ends included. What a shading row on a sprite wants, and
 * the reason it is here rather than in lab.js. */
export function ramp(a, b, n) {
  if (n < 2) return [a.slice()]
  const out = []
  for (let i = 0; i < n; i++) out.push(mix(a, b, i / (n - 1)))
  return out
}

/* lightness moved without touching hue or how colourful it is, which is what
 * "the same colour, one step darker" has to mean on a ramp */
export function lighten(rgb, amount) {
  const lab = rgbToOklab(rgb)
  return oklabToRGB([Math.max(0, Math.min(1, lab[0] + amount)), lab[1], lab[2]])
}

export const darken = (rgb, amount) => lighten(rgb, -amount)

export function saturate(rgb, factor) {
  const lch = rgbToOklch(rgb)
  return oklchToRGB([lch[0], Math.max(0, lch[1] * factor), lch[2]])
}

export function rotateHue(rgb, degrees) {
  const lch = rgbToOklch(rgb)
  return oklchToRGB([lch[0], lch[1], (lch[2] + degrees + 360) % 360])
}
