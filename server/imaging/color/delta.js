// How far apart two colours are, in four opinions.
//
// A quantiser is only as good as the distance it minimises. Plain rgb distance
// is fast and wrong: it treats a step of eight in blue as the same size as a
// step of eight in green, and an eye does not. Every function here takes two
// rgb triples and returns a number where zero is identical.

import { rgbToLab } from './lab.js'
import { rgbToOklab } from './oklab.js'

/* squared, because nothing here compares a distance to anything but another
 * distance and a square root per pixel per palette entry is real time */
export function rgbDistSq(a, b) {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return dr * dr + dg * dg + db * db
}

/* the weighted approximation that gets most of Lab's benefit for none of its
 * cost. The weights shift with the mean red, which is what stops it reading
 * dark blues as close to dark greens. */
export function redmean(a, b) {
  const rm = (a[0] + b[0]) / 2
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db)
}

export function deltaE76(a, b) {
  const x = rgbToLab(a)
  const y = rgbToLab(b)
  const dl = x[0] - y[0]
  const da = x[1] - y[1]
  const db = x[2] - y[2]
  return Math.sqrt(dl * dl + da * da + db * db)
}

/* graphic arts weights. Cheaper than 2000 and good enough to rank candidates
 * that are already close. */
export function deltaE94(a, b) {
  const x = rgbToLab(a)
  const y = rgbToLab(b)
  const dl = x[0] - y[0]
  const c1 = Math.sqrt(x[1] * x[1] + x[2] * x[2])
  const c2 = Math.sqrt(y[1] * y[1] + y[2] * y[2])
  const dc = c1 - c2
  const da = x[1] - y[1]
  const db = x[2] - y[2]
  const dh2 = da * da + db * db - dc * dc
  const sl = 1
  const sc = 1 + 0.045 * c1
  const sh = 1 + 0.015 * c1
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dh2 > 0 ? dh2 / (sh * sh) : 0))
}

/* CIEDE2000, with the hue rotation term. It is fiddly and it is the one that
 * agrees with an eye on near-neutrals, which is exactly where a shading ramp
 * lives. */
export function deltaE2000(a, b, kL = 1, kC = 1, kH = 1) {
  const x = rgbToLab(a)
  const y = rgbToLab(b)
  const [L1, a1, b1] = x
  const [L2, a2, b2] = y

  const C1 = Math.sqrt(a1 * a1 + b1 * b1)
  const C2 = Math.sqrt(a2 * a2 + b2 * b2)
  const Cb = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))))

  const ap1 = (1 + G) * a1
  const ap2 = (1 + G) * a2
  const Cp1 = Math.sqrt(ap1 * ap1 + b1 * b1)
  const Cp2 = Math.sqrt(ap2 * ap2 + b2 * b2)

  const hp1 = deg(Math.atan2(b1, ap1))
  const hp2 = deg(Math.atan2(b2, ap2))

  const dL = L2 - L1
  const dC = Cp2 - Cp1
  let dh = 0
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1
    if (dh > 180) dh -= 360
    else if (dh < -180) dh += 360
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * Math.PI) / 360)

  const Lb = (L1 + L2) / 2
  const Cpb = (Cp1 + Cp2) / 2
  let hb
  if (Cp1 * Cp2 === 0) hb = hp1 + hp2
  else if (Math.abs(hp1 - hp2) <= 180) hb = (hp1 + hp2) / 2
  else hb = hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2

  const T =
    1 -
    0.17 * Math.cos(rad(hb - 30)) +
    0.24 * Math.cos(rad(2 * hb)) +
    0.32 * Math.cos(rad(3 * hb + 6)) -
    0.2 * Math.cos(rad(4 * hb - 63))

  const dTheta = 30 * Math.exp(-Math.pow((hb - 275) / 25, 2))
  const Rc = 2 * Math.sqrt(Math.pow(Cpb, 7) / (Math.pow(Cpb, 7) + Math.pow(25, 7)))
  const Sl = 1 + (0.015 * Math.pow(Lb - 50, 2)) / Math.sqrt(20 + Math.pow(Lb - 50, 2))
  const Sc = 1 + 0.045 * Cpb
  const Sh = 1 + 0.015 * Cpb * T
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc

  return Math.sqrt(
    Math.pow(dL / (kL * Sl), 2) +
      Math.pow(dC / (kC * Sc), 2) +
      Math.pow(dH / (kH * Sh), 2) +
      Rt * (dC / (kC * Sc)) * (dH / (kH * Sh)),
  )
}

/* straight euclidean distance in OKLab, which is what that space was fitted to
 * make meaningful, and the default this library quantises against */
export function deltaOk(a, b) {
  const x = rgbToOklab(a)
  const y = rgbToOklab(b)
  const dl = x[0] - y[0]
  const da = x[1] - y[1]
  const db = x[2] - y[2]
  return Math.sqrt(dl * dl + da * da + db * db)
}

const rad = (d) => (d * Math.PI) / 180
function deg(r) {
  const d = (r * 180) / Math.PI
  return d < 0 ? d + 360 : d
}

export const METRICS = { rgb: rgbDistSq, redmean, cie76: deltaE76, cie94: deltaE94, ciede2000: deltaE2000, oklab: deltaOk }
