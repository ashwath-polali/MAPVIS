/* Palette lock: a returned sprite pushed onto the map's own colours.
 *
 * Why this exists. Words never carry a painting's look. A request for tropical
 * palm trees on a warm golden-hour island came back a generic bright green,
 * because the generator has no idea what the island looks like and no amount
 * of description told it. The style card fixes the ask. This fixes the answer,
 * afterwards, without generating anything: every pixel walks toward the
 * nearest colour the painting actually uses.
 *
 * Two rules hold. Alpha is copied through byte for byte, so a cutout keeps
 * exactly the shape it came back as and no edge softens. And shading survives:
 * the match runs in Oklab with lightness weighted heavier than hue, so a dark
 * pixel can only land on a dark palette entry and a highlight can only land on
 * a light one. Snapping on hue alone flattens a sprite into a sticker, which is
 * the failure this is built to avoid.
 *
 * Pure. No canvas, no network, no react, no document. The same image, palette
 * and strength always give the same bytes, so nothing here can surprise anyone
 * twice.
 */

// what both functions read and matchToPalette hands back. A browser ImageData
// already has this shape, so a caller can pass one straight in; the answer is a
// plain object, because a canvas is the caller's business, not this file's.
export interface RGBAImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

type RGB = [number, number, number]
type Lab = { L: number; a: number; b: number }

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0')

export const toHex = (c: RGB) => '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2])

export function toRGB(s: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s).trim())
  if (!m) return [255, 255, 255]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// ---- Oklab ----------------------------------------------------------------
// Ottosson's transform, straight. It is the cheapest space where a distance
// actually means what an eye means: equal steps look equal, and L is a real
// lightness rather than a green-heavy average. That matters here because the
// whole point is to move hue while leaving value alone.

const toLinear = (c: number) => {
  const u = c / 255
  return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4)
}

const toSRGB = (u: number) => {
  const v = u <= 0.0031308 ? u * 12.92 : 1.055 * Math.pow(u, 1 / 2.4) - 0.055
  return clamp(Math.round(v * 255), 0, 255)
}

function oklab(r: number, g: number, b: number): Lab {
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

function unlab(c: Lab): RGB {
  const l = c.L + 0.3963377774 * c.a + 0.2158037573 * c.b
  const m = c.L - 0.1055613458 * c.a - 0.0638541728 * c.b
  const s = c.L - 0.0894841775 * c.a - 1.291485548 * c.b
  const l3 = l * l * l
  const m3 = m * m * m
  const s3 = s * s * s
  return [
    toSRGB(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    toSRGB(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    toSRGB(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  ]
}

// ---- the map's own colours ------------------------------------------------

/* Ten to sixteen colours off the WHOLE opaque painting.
 *
 * A spot sample was tried and dropped: one spot only ever knows one thing's
 * colours, and asking for a spot before every generation is the step the owner
 * threw out. So the count runs over every opaque pixel. Coarse buckets first,
 * then the biggest buckets that sit far enough apart in rgb to be worth their
 * own entry.
 *
 * Both ends are forced in afterwards. The darkest and the lightest colour a
 * painting uses are almost never its most common ones, and they are exactly
 * what shading is made of: drop them and every matched sprite comes out at the
 * same middle value. The apart-threshold walks down until at least ten entries
 * come out, so a flat painting still yields a usable ramp.
 */
export function sampleMapPalette(img: RGBAImage, want = 14): string[] {
  const d = img.data
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>()
  let total = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 24) continue
    total++
    const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)
    const e = counts.get(key)
    if (e) {
      e.n++
      e.r += d[i]
      e.g += d[i + 1]
      e.b += d[i + 2]
    } else counts.set(key, { n: 1, r: d[i], g: d[i + 1], b: d[i + 2] })
  }
  if (!total) return []
  const ordered = [...counts.values()]
    .map((e) => ({ n: e.n, c: [e.r / e.n, e.g / e.n, e.b / e.n] as RGB }))
    .sort((a, b) => b.n - a.n)

  const cap = clamp(Math.round(want), 4, 16)
  const apart = (list: RGB[], c: RGB, min: number) =>
    list.every((q) => Math.abs(q[0] - c[0]) + Math.abs(q[1] - c[1]) + Math.abs(q[2] - c[2]) > min)
  let picked: RGB[] = []
  for (const min of [34, 24, 16, 9, 4]) {
    picked = []
    for (const e of ordered) {
      if (picked.length >= cap) break
      if (apart(picked, e.c, min)) picked.push(e.c)
    }
    if (picked.length >= Math.min(10, ordered.length)) break
  }
  if (!picked.length) return []

  // the ends, off buckets that are actually present rather than rare noise
  const floor = Math.max(6, total * 0.0004)
  const real = ordered.filter((e) => e.n >= floor)
  const ends = real.length ? real : ordered
  let lo = ends[0].c
  let hi = ends[0].c
  for (const e of ends) {
    if (lum(e.c) < lum(lo)) lo = e.c
    if (lum(e.c) > lum(hi)) hi = e.c
  }
  const out = picked.slice()
  for (const end of [hi, lo]) {
    if (out.length >= 16) break
    if (apart(out, end, 10)) out.push(end)
  }
  out.sort((a, b) => lum(b) - lum(a))
  return out.slice(0, 16).map(toHex)
}

// perceptual lightness, so the ends of the ramp are the ends an eye sees
const lum = (c: RGB) => oklab(c[0], c[1], c[2]).L

// ---- the lock -------------------------------------------------------------

// how much harder a lightness miss counts than a hue miss when the nearest
// entry is chosen. At 2.5 a mid-tone can never grab a highlight's pixel, which
// is what keeps a sprite shaded instead of stickered.
const WEIGHT_L = 2.5

// under this, a pixel is the transparent surround and is left exactly alone
const ALPHA_FLOOR = 8

/* Every opaque pixel moved toward the nearest colour the map uses.
 *
 * strength is how far it goes: 1 snaps onto the palette entry, 0 hands back
 * the original untouched, and the default the panel opens at sits high enough
 * to change the family without erasing the drawing underneath. Alpha is copied
 * straight through at every pixel, opaque or not.
 *
 * The match is cached per distinct colour. Pixel art holds a few dozen colours
 * in a sprite, so a 96x96 take does a few dozen searches rather than nine
 * thousand, and the panel's slider redraws inside a frame.
 */
export function matchToPalette(img: RGBAImage, palette: string[], strength: number): RGBAImage {
  const out: RGBAImage = {
    data: new Uint8ClampedArray(img.data),
    width: img.width,
    height: img.height,
  }
  const k = clamp(Number(strength) || 0, 0, 1)
  const pal = palette.map(toRGB)
  if (!pal.length || k <= 0) return out
  const labs = pal.map((c) => oklab(c[0], c[1], c[2]))
  const seen = new Map<number, number>()
  const d = out.data
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] <= ALPHA_FLOOR) continue
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]
    let hit = seen.get(key)
    if (hit === undefined) {
      const src = oklab(d[i], d[i + 1], d[i + 2])
      let best = 0
      let bestD = Infinity
      for (let j = 0; j < labs.length; j++) {
        const dl = (src.L - labs[j].L) * WEIGHT_L
        const da = src.a - labs[j].a
        const db = src.b - labs[j].b
        const q = dl * dl + da * da + db * db
        if (q < bestD) {
          bestD = q
          best = j
        }
      }
      const t = labs[best]
      const rgb = unlab({
        L: src.L + (t.L - src.L) * k,
        a: src.a + (t.a - src.a) * k,
        b: src.b + (t.b - src.b) * k,
      })
      hit = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]
      seen.set(key, hit)
    }
    d[i] = (hit >> 16) & 255
    d[i + 1] = (hit >> 8) & 255
    d[i + 2] = hit & 255
  }
  return out
}
