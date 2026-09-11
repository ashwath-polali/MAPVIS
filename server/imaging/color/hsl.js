// HSL, HSV and HWB.
//
// None of these are perceptual and none of them should be used to judge whether
// two colours match. They are here because they are what a person types and what
// a colour picker draws, so a value arriving from a UI arrives in one of them.

import { clamp255, clamp01 } from './srgb.js'

export function rgbToHsl(rgb) {
  const r = rgb[0] / 255
  const g = rgb[1] / 255
  const b = rgb[2] / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h * 360, s, l]
}

export function hslToRgb(hsl) {
  const h = ((hsl[0] % 360) + 360) % 360 / 360
  const s = clamp01(hsl[1])
  const l = clamp01(hsl[2])
  if (s === 0) {
    const v = clamp255(Math.round(l * 255))
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [clamp255(Math.round(hue(p, q, h + 1 / 3) * 255)), clamp255(Math.round(hue(p, q, h) * 255)), clamp255(Math.round(hue(p, q, h - 1 / 3) * 255))]
}

function hue(p, q, t) {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

export function rgbToHsv(rgb) {
  const r = rgb[0] / 255
  const g = rgb[1] / 255
  const b = rgb[2] / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  return [h * 360, max === 0 ? 0 : d / max, max]
}

export function hsvToRgb(hsv) {
  const h = (((hsv[0] % 360) + 360) % 360) / 60
  const s = clamp01(hsv[1])
  const v = clamp01(hsv[2])
  const i = Math.floor(h)
  const f = h - i
  const p = v * (1 - s)
  const q = v * (1 - s * f)
  const t = v * (1 - s * (1 - f))
  const table = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ]
  const c = table[i % 6]
  return [clamp255(Math.round(c[0] * 255)), clamp255(Math.round(c[1] * 255)), clamp255(Math.round(c[2] * 255))]
}

/* whiteness and blackness rather than saturation and value, which is closer to
 * how a painter mixes and reads better on a tint ramp */
export function rgbToHwb(rgb) {
  const hsv = rgbToHsv(rgb)
  const w = Math.min(rgb[0], rgb[1], rgb[2]) / 255
  return [hsv[0], w, 1 - Math.max(rgb[0], rgb[1], rgb[2]) / 255]
}

export function hwbToRgb(hwb) {
  let w = clamp01(hwb[1])
  let b = clamp01(hwb[2])
  if (w + b >= 1) {
    const g = clamp255(Math.round((w / (w + b)) * 255))
    return [g, g, g]
  }
  const rgb = hsvToRgb([hwb[0], 1, 1])
  return rgb.map((c) => clamp255(Math.round((c / 255) * (1 - w - b) * 255 + w * 255)))
}
