// sRGB, and the transfer function that makes every other file here possible.
//
// The eight-bit numbers in a png are not light. They are a curve over light, so
// averaging two of them averages the curve and not the brightness: blending
// #000000 and #ffffff in eight-bit space gives 128, which is about 21 percent of
// the light of white rather than half of it. Every operation that mixes,
// resamples or blurs has to leave the curve first.

/* the piecewise curve from IEC 61966-2-1, not the 2.2 approximation. The knee
 * at 0.04045 matters at the dark end, which is exactly where a pixel-art palette
 * spends its shadows. */
export function toLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function toSRGB(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

export const byteToLinear = (b) => toLinear(b / 255)
export const linearToByte = (l) => clamp255(Math.round(toSRGB(l) * 255))

export function clamp255(n) {
  return n < 0 ? 0 : n > 255 ? 255 : n | 0
}

export function clamp01(n) {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/* a whole rgb triple at once, because doing it channel by channel at the call
 * site is where a green channel gets linearised twice */
export function rgbToLinear(rgb) {
  return [toLinear(rgb[0] / 255), toLinear(rgb[1] / 255), toLinear(rgb[2] / 255)]
}

export function linearToRGB(lin) {
  return [linearToByte(lin[0]), linearToByte(lin[1]), linearToByte(lin[2])]
}

/* Rec. 709 luma weights, applied to LINEAR light. The same weights over
 * eight-bit values are the common mistake and they read a saturated blue as
 * far brighter than it is. */
export function luminance(rgb) {
  const l = rgbToLinear(rgb)
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
}

/* what a viewer calls brightness rather than what a photometer reads, so this
 * one deliberately stays on the encoded values */
export function perceivedBrightness(rgb) {
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255
}

export function toGrey(rgb) {
  const y = linearToByte(luminance(rgb))
  return [y, y, y]
}

/* 0xRRGGBB in, triple out. Accepts the three and six digit forms and a leading
 * hash, because a palette file written by a person contains all of them. */
export function parseHex(s) {
  let t = String(s).trim().replace(/^#/, '')
  if (t.length === 3) t = t[0] + t[0] + t[1] + t[1] + t[2] + t[2]
  if (t.length === 4) t = t[0] + t[0] + t[1] + t[1] + t[2] + t[2] + t[3] + t[3]
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(t)) return null
  const n = parseInt(t.slice(0, 6), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  if (t.length === 8) rgb.push(parseInt(t.slice(6, 8), 16))
  return rgb
}

export function toHex(rgb) {
  const h = (n) => clamp255(n).toString(16).padStart(2, '0')
  return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2])
}

/* packed integer keys, because a Map keyed on an array compares by identity and
 * silently grows one entry per lookup */
export const packRGB = (r, g, b) => ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)
export const unpackRGB = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255]

/* the count of distinct colours, which is the first thing worth knowing about a
 * sprite somebody is about to palette-match */
export function countColors(rgba) {
  const seen = new Set()
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue
    seen.add(packRGB(rgba[i], rgba[i + 1], rgba[i + 2]))
  }
  return seen.size
}

export function histogram(rgba) {
  const h = new Map()
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue
    const k = packRGB(rgba[i], rgba[i + 1], rgba[i + 2])
    h.set(k, (h.get(k) || 0) + 1)
  }
  return h
}
