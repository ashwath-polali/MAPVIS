// CIELAB and LCh.
//
// Lab is the space to ask "do these two look the same" in, because a fixed step
// in it is roughly a fixed step to an eye. It is not the space to BLEND in: the
// straight line between two Lab colours bends through grey, which is why a ramp
// generated here comes out muddy in the middle and the one in oklab.js does not.

import { rgbToXYZ, xyzToRGB, D65 } from './xyz.js'

const E = 216 / 24389
const K = 24389 / 27

const f = (t) => (t > E ? Math.cbrt(t) : (K * t + 16) / 116)
const fInv = (t) => (t * t * t > E ? t * t * t : (116 * t - 16) / K)

export function xyzToLab(xyz, white = D65) {
  const fx = f(xyz[0] / white[0])
  const fy = f(xyz[1] / white[1])
  const fz = f(xyz[2] / white[2])
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function labToXYZ(lab, white = D65) {
  const fy = (lab[0] + 16) / 116
  const fx = fy + lab[1] / 500
  const fz = fy - lab[2] / 200
  return [fInv(fx) * white[0], fInv(fy) * white[1], fInv(fz) * white[2]]
}

export const rgbToLab = (rgb) => xyzToLab(rgbToXYZ(rgb))
export const labToRGB = (lab) => xyzToRGB(labToXYZ(lab))

/* the polar form, and the one an author actually thinks in: lightness, how
 * colourful, and which hue. Rotating h is how a palette gets shifted without
 * losing its own contrast. */
export function labToLCh(lab) {
  const c = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2])
  let h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI
  if (h < 0) h += 360
  return [lab[0], c, h]
}

export function lchToLab(lch) {
  const r = (lch[2] * Math.PI) / 180
  return [lch[0], Math.cos(r) * lch[1], Math.sin(r) * lch[1]]
}

export const rgbToLCh = (rgb) => labToLCh(rgbToLab(rgb))
export const lchToRGB = (lch) => labToRGB(lchToLab(lch))

/* shortest way round the circle, because interpolating 350 to 10 the long way
 * takes a ramp through every hue there is */
export function hueLerp(a, b, t) {
  let d = ((b - a + 540) % 360) - 180
  return (a + d * t + 360) % 360
}

/* chroma pulled in until the colour is one a screen can show, keeping L and h.
 * Clipping the rgb channels instead shifts the hue, which is how a ramp of one
 * colour arrives with a purple end. */
export function clipToGamut(lch, steps = 24) {
  let lo = 0
  let hi = lch[1]
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2
    const rgb = lchToRGB([lch[0], mid, lch[2]])
    const back = rgbToLCh(rgb)
    if (Math.abs(back[1] - mid) < 0.02) lo = mid
    else hi = mid
  }
  return [lch[0], lo, lch[2]]
}
