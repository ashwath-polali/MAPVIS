// CIE XYZ, the space everything else is defined against.
//
// Nothing draws in XYZ. It is the hub: sRGB goes in, Lab and OKLab come out the
// other side, and a white point adaptation in the middle is what lets a palette
// lifted from a photograph under one light sit beside one drawn under another.

import { toLinear, toSRGB, clamp255 } from './srgb.js'

/* D65, two degree observer, which is what sRGB is defined against. D50 is here
 * because print references and a good many palette files are still in it. */
export const D65 = [0.3127 / 0.329, 1, (1 - 0.3127 - 0.329) / 0.329]
export const D50 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585]

/* the sRGB primaries, to four more places than the spec prints them. The
 * rounded matrix in most references does not round-trip: white comes back
 * 254.6 and a pass through XYZ and back visibly darkens. */
const RGB_TO_XYZ = [
  [0.4123907992659595, 0.35758433938387796, 0.1804807884018343],
  [0.21263900587151036, 0.7151686787677559, 0.07219231536073371],
  [0.01933081871559185, 0.11919477979462599, 0.9505321522496606],
]

const XYZ_TO_RGB = [
  [3.2409699419045213, -1.5373831775700935, -0.4986107602930033],
  [-0.9692436362808798, 1.8759675015077206, 0.04155505740717561],
  [0.05563007969699361, -0.20397695888897657, 1.0569715142428786],
]

const apply3 = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
]

export function rgbToXYZ(rgb) {
  return apply3(RGB_TO_XYZ, [toLinear(rgb[0] / 255), toLinear(rgb[1] / 255), toLinear(rgb[2] / 255)])
}

export function xyzToRGB(xyz) {
  const l = apply3(XYZ_TO_RGB, xyz)
  return [clamp255(Math.round(toSRGB(l[0]) * 255)), clamp255(Math.round(toSRGB(l[1]) * 255)), clamp255(Math.round(toSRGB(l[2]) * 255))]
}

/* whether the conversion above had to clamp, which is the difference between a
 * colour this display can show and one it cannot. A quantiser that ignores this
 * reports a match it never actually produced. */
export function inGamut(xyz, eps = 1e-6) {
  const l = apply3(XYZ_TO_RGB, xyz)
  return l.every((c) => c >= -eps && c <= 1 + eps)
}

/* Bradford, which is the adaptation everybody else implements, so a palette
 * converted here and elsewhere lands on the same numbers */
const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
]

const BRADFORD_INV = [
  [0.9869929, -0.1470543, 0.1599627],
  [0.4323053, 0.5183603, 0.0492912],
  [-0.0085287, 0.0400428, 0.9684867],
]

export function adapt(xyz, from, to) {
  const s = apply3(BRADFORD, from)
  const d = apply3(BRADFORD, to)
  const c = apply3(BRADFORD, xyz)
  return apply3(BRADFORD_INV, [(c[0] * d[0]) / s[0], (c[1] * d[1]) / s[1], (c[2] * d[2]) / s[2]])
}

/* chromaticity, which is colour with the brightness taken out. Two swatches
 * with the same xy are the same hue and saturation at different exposures, and
 * that is the comparison a style match wants rather than a distance. */
export function toChromaticity(xyz) {
  const sum = xyz[0] + xyz[1] + xyz[2]
  return sum === 0 ? [0, 0] : [xyz[0] / sum, xyz[1] / sum]
}
