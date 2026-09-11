/* The effect engine: small animated effects built from the map's own colours. The generator draws objects, not effects, and twenty-odd attempts at smoke and sparkle came back garbage because an effect is a motion rule over colours rather than a picture. Every effect is a seamless loop by construction and nothing is random at render time. */
import { mkCanvas } from './mask'
import type { CustomControl } from './customfx'

export type EffectType = 'flow' | 'rise' | 'spray' | 'twinkle' | 'sway' | 'glow' | 'swirl'

/* The eighth answer, and the one that is not a rule: when an ask fits none of the seven the planner writes the renderer and it runs in customfx's sandbox, never reaching renderEffect. */
export type AnyEffectType = EffectType | 'custom'

export const CUSTOM_DESC = 'written for this ask'

export const EFFECT_TYPES: EffectType[] = ['flow', 'rise', 'spray', 'twinkle', 'sway', 'glow', 'swirl']

// one line each, the same words the planner is given
export const EFFECT_DESC: Record<EffectType, string> = {
  flow: 'scrolling streaks in a direction',
  rise: 'particles climbing, growing, fading',
  spray: 'particles arcing out from a point',
  twinkle: 'points fading in and out in place',
  sway: 'a bend cycle over the pixels there',
  glow: 'a soft radial pulse',
  swirl: 'a turning vortex',
}

// a square of painting pixels, rgba, cut pixels already dropped to nothing
export interface Patch {
  data: Uint8ClampedArray
  w: number
  h: number
}

/* Every rule takes all of these and ignores what does not apply to it.
 * direction is degrees like a compass: 0 up, 90 right, 180 down, 270 left. */
export interface EffectParams {
  width: number
  height: number
  frames: number
  speed: number
  size: number
  count: number
  direction: number
  spread: number
  intensity: number
  seed: number
  // spray only: the sliding foam band where the particles are thrown from
  churn?: boolean
  // custom only: the knobs the written recipe declared for itself, each already
  // held inside the range it declared. They ride here so one params object still
  // saves, reopens and re-renders the way every other effect's does.
  custom?: Record<string, number>
}

// what each rule starts at when the plan leaves a number out
const BY_TYPE: Record<EffectType, Partial<EffectParams>> = {
  flow: { width: 16, height: 64, count: 12, direction: 180, size: 1 },
  rise: { width: 56, height: 96, count: 4, direction: 0, size: 1 },
  spray: { width: 40, height: 28, count: 12, direction: 0, spread: 1, churn: true },
  twinkle: { width: 48, height: 32, count: 14, size: 1, spread: 1 },
  sway: { width: 40, height: 40, count: 1, direction: 0, spread: 1 },
  glow: { width: 48, height: 48, count: 1, size: 1 },
  swirl: { width: 64, height: 48, count: 4, size: 1, spread: 1, direction: 0 },
}

// a written recipe sets its own canvas in the plan; this is only what stands in
// when it leaves a field out
const CUSTOM_START: Partial<EffectParams> = { width: 64, height: 64, count: 8, size: 1, spread: 1, direction: 0 }

const BASE: EffectParams = {
  width: 48,
  height: 48,
  frames: 8,
  speed: 1,
  size: 1,
  count: 8,
  direction: 0,
  spread: 1,
  intensity: 1,
  seed: 1,
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
const clampI = (v: number, a: number, b: number) => clamp(Math.round(v), a, b)
const num = (v: unknown, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export const isEffectType = (s: unknown): s is EffectType =>
  typeof s === 'string' && (EFFECT_TYPES as string[]).includes(s)

/* The plan's loose numbers turned into a full, sane param set. Every caller
 * goes through here, so a slider, a plan and a reopened effect.json all land in
 * the same shape. */
export function fillParams(
  type: AnyEffectType,
  raw?: Record<string, unknown> | Partial<EffectParams> | null,
  controls?: CustomControl[] | null,
): EffectParams {
  const d = { ...BASE, ...(type === 'custom' ? CUSTOM_START : BY_TYPE[type]) } as EffectParams
  const r = (raw || {}) as Record<string, unknown>
  const p: EffectParams = {
    width: clampI(num(r.width, d.width), 8, 512),
    height: clampI(num(r.height, d.height), 8, 512),
    frames: clampI(num(r.frames, d.frames), 2, 24),
    speed: clamp(num(r.speed, d.speed), 0.2, 4),
    size: clamp(num(r.size, d.size), 0.2, 3),
    count: clampI(num(r.count, d.count), 1, 64),
    direction: ((Math.round(num(r.direction, d.direction)) % 360) + 360) % 360,
    spread: clamp(num(r.spread, d.spread), 0.1, 3),
    intensity: clamp(num(r.intensity, d.intensity), 0.1, 2),
    seed: clampI(num(r.seed, d.seed), 1, 2147483647),
  }
  if (type === 'spray') p.churn = r.churn === undefined ? !!d.churn : !!r.churn
  if (type === 'custom') {
    // the plan hands the knobs back flat in params; a reopened effect.json has
    // them under custom. Read either, and hold each one inside the range its
    // own control declared rather than any of the fixed five.
    const from = r.custom && typeof r.custom === 'object' ? (r.custom as Record<string, unknown>) : r
    const c: Record<string, number> = {}
    for (const k of controls || []) {
      const lo = Math.min(k.min, k.max)
      const hi = Math.max(k.min, k.max)
      c[k.key] = clamp(num(from[k.key], num(k.value, lo)), lo, hi)
    }
    p.custom = c
  }
  return p
}

/* Every number a written recipe can read as p.<key>: the canvas and cycle
 * fields, then its own knobs on top. Flat on purpose, so the body never has to
 * know which half a name came from. */
export function flatParams(p: EffectParams): Record<string, number> {
  const out: Record<string, number> = {
    width: p.width,
    height: p.height,
    frames: p.frames,
    speed: p.speed,
    size: p.size,
    count: p.count,
    direction: p.direction,
    spread: p.spread,
    intensity: p.intensity,
    seed: p.seed,
  }
  for (const [k, v] of Object.entries(p.custom || {})) out[k] = v
  return out
}

// the cycle plays once over `frames` frames, so speed IS the playback rate
export const fpsFor = (p: EffectParams) => clampI(6 * p.speed, 2, 20)

/* The keyword fall-back, shared by the client and mirrored on the server: the
 * ask alone decides the rule when the planner is not reachable. It is never
 * clever, it just never leaves the user with nothing. */
export function guessType(ask: string): EffectType {
  const s = String(ask).toLowerCase()
  if (/smoke|steam|vapou?r|bubble|plume|fume|mist|incense/.test(s)) return 'rise'
  // swirl sits after rise so swirling smoke is still smoke, and before the rest
  // because a vortex has no other word for itself
  if (/swirl|spiral|vortex|portal|whirl|twist|warp|gateway/.test(s)) return 'swirl'
  // twinkle goes before spray on purpose: a sparkle contains a spark
  if (/sparkle|glint|twinkle|shimmer|firefl|star|glitter/.test(s)) return 'twinkle'
  if (/splash|spray|spark|dust|ember|debris|foam|burst/.test(s)) return 'spray'
  if (/fall|river|stream|flow|lava|current|rapid|cascade|waterfall/.test(s)) return 'flow'
  if (/flag|leaf|leaves|sway|foliage|banner|branch|grass|wind|sign/.test(s)) return 'sway'
  if (/glow|lamp|fire|light|torch|lantern|halo|beacon|ember light/.test(s)) return 'glow'
  return 'rise'
}

/* A colour named in the ask, as a small ramp. The plan carried a rule and numbers but never a colour, so "swirling purple portal" came out brown: purple was not reachable from anywhere. Near-white first, because every rule puts its lightest entry where the eye goes. */
const COLOR_RAMPS: Record<string, string[]> = {
  purple: ['#f3e6ff', '#c58cf5', '#8a3fd1', '#4a1b78'],
  violet: ['#f3e6ff', '#c58cf5', '#8a3fd1', '#4a1b78'],
  green: ['#eeffe8', '#8ce88a', '#35a83c', '#14501f'],
  blue: ['#e6f2ff', '#7ec4f5', '#2f6fd0', '#123a75'],
  red: ['#fff0e6', '#ff9a6b', '#d8342a', '#6e1410'],
  orange: ['#fff2df', '#ffbe6b', '#ef8419', '#7a3d07'],
  yellow: ['#fffbe0', '#ffe97a', '#e8c022', '#7d6208'],
  pink: ['#ffe9f4', '#ff9ecb', '#e34d92', '#7a1b47'],
  cyan: ['#e4ffff', '#86ecec', '#23aab4', '#0b5158'],
  teal: ['#e2fff7', '#79e0c2', '#1f9c7d', '#0a4a3c'],
  white: ['#ffffff', '#eef1f5', '#c3ccd6', '#7d8794'],
  black: ['#d7dbe0', '#8b929b', '#444a52', '#14171b'],
  gold: ['#fff6d8', '#ffd873', '#d99a1c', '#6d4508'],
}

// the first colour word in the ask, or nothing. Leftmost wins, so "purple
// portal with green sparks" is a purple portal.
export function guessColors(ask: string): string[] {
  const m = /\b(purple|violet|green|blue|red|orange|yellow|pink|cyan|teal|white|black|gold)\b/i.exec(String(ask))
  return m ? COLOR_RAMPS[m[1].toLowerCase()].slice() : []
}

// ---- colour ---------------------------------------------------------------

type RGB = [number, number, number]

const hex2 = (n: number) => n.toString(16).padStart(2, '0')
export const toHex = (c: RGB) => '#' + hex2(clampI(c[0], 0, 255)) + hex2(clampI(c[1], 0, 255)) + hex2(clampI(c[2], 0, 255))

export function toRGB(s: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s).trim())
  if (!m) return [255, 255, 255]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// green carries most of the value and blue the least, which is the luma split
const lum = (c: RGB) => c[0] * 0.35 + c[1] * 0.4 + c[2] * 0.25

const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

const scaleCol = (c: RGB, r: number, g: number, b: number): RGB => [c[0] * r, c[1] * g, c[2] * b]

/* The sampled colours as a light-to-dark ramp of n steps. Ends are extended rather than repeated, so an effect drawn off a flat patch still reads shaded and not as a sticker. */
function ramp(colors: string[], n: number): RGB[] {
  const src = (colors.length ? colors : ['#ffffff']).map(toRGB).sort((a, b) => lum(b) - lum(a))
  if (src.length === 1) {
    const c = src[0]
    src.unshift(mix(c, [255, 255, 255], 0.45))
    src.push(mix(c, [40, 44, 52], 0.4))
  } else if (src.length === 2) {
    src.splice(1, 0, mix(src[0], src[1], 0.5))
  }
  const out: RGB[] = []
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * (src.length - 1)
    const k = Math.min(src.length - 2, Math.floor(u))
    out.push(mix(src[k], src[k + 1], u - k))
  }
  return out
}

/* the lift: straight off the art a puff reads as the rock it was cut from, because those pixels were painted against a bright sky. Each step is pulled most of the way to a pale tint of the palette's own hue, keeping the value structure. */
function liftedRamp(colors: string[], n: number, k = 0.65): RGB[] {
  const base = ramp(colors, n)
  const avg: RGB = [0, 0, 0]
  for (const c of base) {
    avg[0] += c[0] / base.length
    avg[1] += c[1] / base.length
    avg[2] += c[2] / base.length
  }
  const tint = mix(avg, [255, 255, 255], 0.72)
  return base.map((c) => {
    const v = lum(c)
    return [v * (1 - k) + tint[0] * k, v * (1 - k) + tint[1] * k, v * (1 - k) + tint[2] * k] as RGB
  })
}

/* Warm, bright, and still in the map's family: the core of a glow. */
function warmRamp(colors: string[], n: number): RGB[] {
  const base = ramp(colors, n)
  const warm: RGB = [255, 226, 170]
  return base.map((c, i) => mix(c, warm, 0.55 * (1 - i / Math.max(1, n - 1)) + 0.12))
}

/* The same lift without the warmth. A ramp the effect brought itself is already the answer to what colour it is, so pulling it toward lamp-cream would bring a purple glow back peach. */
function ownRamp(colors: string[], n: number): RGB[] {
  const base = ramp(colors, n)
  return base.map((c, i) => mix(c, [255, 255, 255], 0.4 * (1 - i / Math.max(1, n - 1))))
}

/* The dominant colours of a patch, lightest first. Coarse buckets, then the biggest that sit far enough apart in rgb. Transparent pixels never count: the sea and the cut are not part of the palette. */
export function samplePalette(patch: Patch, want = 6): string[] {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>()
  const d = patch.data
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 24) continue
    const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)
    const e = counts.get(key)
    if (e) {
      e.n++
      e.r += d[i]
      e.g += d[i + 1]
      e.b += d[i + 2]
    } else counts.set(key, { n: 1, r: d[i], g: d[i + 1], b: d[i + 2] })
  }
  const ordered = [...counts.values()].sort((a, b) => b.n - a.n)
  const picked: RGB[] = []
  const far = (c: RGB) => picked.every((q) => Math.abs(q[0] - c[0]) + Math.abs(q[1] - c[1]) + Math.abs(q[2] - c[2]) > 46)
  for (const e of ordered) {
    if (picked.length >= want) break
    const c: RGB = [e.r / e.n, e.g / e.n, e.b / e.n]
    if (far(c)) picked.push(c)
  }
  // a flat patch can hand back one colour; the ramp handles that, but two
  // entries make every rule's colour picking read better
  if (!picked.length) picked.push([255, 255, 255])
  picked.sort((a, b) => lum(b) - lum(a))
  return picked.map(toHex)
}

// ---- the plumbing ---------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// the 4x4 ordered matrix: how a gradient stays pixel art instead of turning
// into a smooth ramp
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
const bayer = (x: number, y: number) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16

const dirVec = (deg: number): [number, number] => {
  const r = (deg * Math.PI) / 180
  return [Math.sin(r), -Math.cos(r)]
}

/* One frame as raw rgba. Every rule writes pixels by hand: no blending engine,
 * no soft edges, nothing that could sneak an antialiased fringe into pixel art. */
class Frame {
  data: Uint8ClampedArray
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8ClampedArray(w * h * 4)
  }
  // where two particles land on one pixel the brighter wins, so a droplet crossing
  // mist still reads as a droplet
  put(x: number, y: number, c: RGB, a: number) {
    if (a <= 0.02) return
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return
    const i = (yi * this.w + xi) * 4
    const na = Math.min(255, Math.round(255 * a))
    if (this.data[i + 3] !== 0 && na <= this.data[i + 3]) return
    this.data[i] = c[0]
    this.data[i + 1] = c[1]
    this.data[i + 2] = c[2]
    this.data[i + 3] = na
  }
  toCanvas(): HTMLCanvasElement {
    const c = mkCanvas(this.w, this.h)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    const img = g.createImageData(this.w, this.h)
    img.data.set(this.data)
    g.putImageData(img, 0, 0)
    return c
  }
}

// ---- the seven rules ------------------------------------------------------

/* flow: scrolling streaks. Every column's dash+gap span divides PERIOD, which is what makes the loop close exactly rather than nearly. */
const PERIOD = 16
const SPANS = [4, 8, 8, 16]

function flowFrames(p: EffectParams, colors: string[]): HTMLCanvasElement[] {
  const { width: W, height: H } = p
  const rnd = mulberry32(p.seed * 7919 + 11)
  const pal = ramp(colors, 4)
  const [dx, dy] = dirVec(p.direction)
  const px = -dy
  const py = dx
  const spanA = Math.abs(W * dx) + Math.abs(H * dy)
  const spanB = Math.abs(W * px) + Math.abs(H * py)
  const nLanes = Math.max(1, Math.ceil(spanB))
  const density = clamp(p.count / 14, 0.2, 1)
  const lanes: { live: boolean; span: number; dash: number; phase: number; col: RGB; strength: number }[] = []
  for (let i = 0; i < nLanes; i++) {
    const span = SPANS[Math.min(SPANS.length - 1, Math.floor(rnd() * SPANS.length))]
    const f = clamp(0.3 + 0.25 * p.size + rnd() * 0.15, 0.15, 0.9)
    // a colour off the ramp, biased toward the light end the way the reference
    // weighted white over the deep blue-gray
    const ci = Math.min(pal.length - 1, Math.floor(Math.pow(rnd(), 1.5) * pal.length))
    lanes.push({
      live: rnd() < density,
      span,
      dash: clampI(span * f, 1, span - 1),
      phase: rnd(),
      col: pal[ci],
      strength: 1 - 0.45 * (ci / Math.max(1, pal.length - 1)),
    })
  }
  const edgeGain = 1.2 + 0.8 * p.spread
  const out: HTMLCanvasElement[] = []
  for (let f = 0; f < p.frames; f++) {
    const shift = (f * PERIOD) / p.frames
    const fr = new Frame(W, H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ox = x + 0.5 - W / 2
        const oy = y + 0.5 - H / 2
        const a = ox * dx + oy * dy + spanA / 2
        const b = ox * px + oy * py + spanB / 2
        const lane = lanes[clampI(Math.floor(b), 0, nLanes - 1)]
        if (!lane.live) continue
        let edge = 1 - Math.abs(b / spanB - 0.5) * 2
        edge = Math.min(1, edge * edgeGain)
        if (edge <= 0) continue
        const u = (a + shift + lane.phase * PERIOD) % lane.span
        if (u >= lane.dash) continue
        // a streak is brightest in its middle and tapers at both ends
        const k = Math.pow(Math.sin(Math.PI * (u / lane.dash)), 0.6)
        // it thins as it travels, then breaks up at the very end
        let depth = 1 - 0.35 * (a / spanA)
        const tail = spanA - a
        if (tail < 8) depth *= Math.max(0, tail / 8)
        const al = lane.strength * k * edge * depth * 0.9 * p.intensity
        if (al <= 0.03) continue
        fr.put(x, y, lane.col, al)
      }
    }
    out.push(fr.toCanvas())
  }
  return out
}

/* The lumpy puff silhouette: one body plus shoulders all the way round, because a circle reads mechanical and stacked circles were rejected. Box blur then a hard threshold, so the boundary stays one crisp pixel. */
function puffMask(size: number, rnd: () => number): Uint8Array {
  const cov = new Float32Array(size * size)
  const c = size / 2
  const ell = (cx: number, cy: number, rx: number, ry: number) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5 - cx) / rx
        const v = (y + 0.5 - cy) / ry
        if (u * u + v * v <= 1) cov[y * size + x] = 1
      }
  }
  ell(c, c, size * 0.28, size * 0.24)
  const lobes: [number, number, number][] = [
    [-0.24, -0.14, 0.21],
    [0.22, -0.18, 0.2],
    [0.0, -0.26, 0.23],
    [-0.28, 0.08, 0.18],
    [0.26, 0.06, 0.19],
    [-0.12, 0.2, 0.17],
    [0.14, 0.22, 0.16],
  ]
  for (const [lx, ly, lr] of lobes) {
    const j = (rnd() - 0.5) * 0.05
    const r = (lr + j) * size
    ell(c + lx * size, c + ly * size, r, r)
  }
  const blur = new Float32Array(size * size)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let s = 0
      let n = 0
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const xx = x + i
          const yy = y + j
          if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue
          s += cov[yy * size + xx]
          n++
        }
      blur[y * size + x] = s / n
    }
  const m = new Uint8Array(size * size)
  for (let i = 0; i < m.length; i++) m[i] = blur[i] > 0.5 ? 1 : 0
  return m
}

/* A puff filled with the map's own colours, lit upper left with a hue-shifted rim and never a black outline. Blocky noise plus an ordered dither, so the fill has structure rather than a smooth gradient. */
function buildBlob(size: number, colors: string[], seed: number, lift: number): { m: Uint8Array; px: Uint8ClampedArray } {
  const rnd = mulberry32(seed)
  const m = puffMask(size, rnd)
  const pal = lift > 0 ? liftedRamp(colors, 5, lift) : ramp(colors, 5)
  const px = new Uint8ClampedArray(size * size * 4)
  const hash = (x: number, y: number) => {
    const n = Math.sin(x * 127.1 + y * 311.7 + seed * 0.017) * 43758.5453
    return n - Math.floor(n)
  }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (!m[y * size + x]) continue
      // how far into the blob this pixel sits, along the light axis
      const k = (x + y) / (2 * size) - 0.5
      const n = (hash(Math.floor(x / 3), Math.floor(y / 3)) - 0.5) * 0.32
      const t = clamp(0.5 + k * 0.8 + n, 0, 1)
      const idx = clampI(Math.floor(t * (pal.length - 1) + bayer(x, y)), 0, pal.length - 1)
      let col = pal[idx]
      // the rim: any pixel whose lower-right neighbour is empty gets a cooler,
      // slightly deeper edge, so the puff reads round without an outline pass
      const edge =
        x + 1 >= size || !m[y * size + x + 1] || y + 1 >= size || !m[(y + 1) * size + x]
      if (edge) col = scaleCol(col, 0.86, 0.87, 0.92)
      const i = (y * size + x) * 4
      px[i] = col[0]
      px[i + 1] = col[1]
      px[i + 2] = col[2]
      px[i + 3] = 255
    }
  return { m, px }
}

// one blob drawn at another size, nearest neighbour, alpha scaled
function blitBlob(
  fr: Frame,
  blob: { m: Uint8Array; px: Uint8ClampedArray },
  srcSize: number,
  dstSize: number,
  x0: number,
  y0: number,
  alpha: number,
) {
  if (alpha <= 0.02 || dstSize < 1) return
  for (let y = 0; y < dstSize; y++) {
    const sy = Math.min(srcSize - 1, Math.floor((y * srcSize) / dstSize))
    for (let x = 0; x < dstSize; x++) {
      const sx = Math.min(srcSize - 1, Math.floor((x * srcSize) / dstSize))
      if (!blob.m[sy * srcSize + sx]) continue
      const i = (sy * srcSize + sx) * 4
      fr.put(x0 + x, y0 + y, [blob.px[i], blob.px[i + 1], blob.px[i + 2]], alpha)
    }
  }
}

/* rise: puffs climbing and evaporating. One shape and n+1 slots, so over a cycle every puff advances one slot and the last frame lands on the first. The newborn starts half-clipped, because smoke fully inside the canvas reads as floating. */
function riseFrames(p: EffectParams, colors: string[], patch?: Patch | null, own = false): HTMLCanvasElement[] {
  void patch
  const { width: W, height: H } = p
  const n = clampI(p.count, 2, 8)
  const base = clampI(W * 0.52 * p.size, 4, Math.max(4, Math.floor(W / 1.25)))
  // the lift is there to separate a puff cut from the ground behind it; a ramp
  // the effect brought itself is already separate, so it barely gets one
  const blob = buildBlob(base, colors, p.seed * 2654 + 7, own ? 0.2 : 0.65)
  const [dx, dy] = dirVec(p.direction)
  const perp: [number, number] = [-dy, dx]
  const L = Math.abs(W * dx) + Math.abs(H * dy)
  const src: [number, number] = [W / 2 - dx * W * 0.49, H / 2 - dy * H * 0.49]
  // the resting slots: how far along the travel axis and how big. The last slot stops a radius short, because running the travel to the end guillotined a big plume flat against row 0 (measured: 47 opaque pixels on row 0 of a 64x96 take at size 3).
  const slotA: number[] = []
  const slotS: number[] = []
  const rTop = (base * (0.45 + 0.75)) / 2
  const aStart = Math.min(L * 0.104, base * 0.3)
  const aEnd = Math.max(aStart + L * 0.2, L - rTop)
  for (let k = 0; k <= n; k++) {
    slotA.push(aStart + (aEnd - aStart) * (k / n))
    slotS.push(0.45 + k * (0.75 / n))
  }
  const bornA = -L * 0.04
  const bornS = 0.25
  const out: HTMLCanvasElement[] = []
  for (let f = 0; f < p.frames; f++) {
    const t = f / p.frames
    const fr = new Frame(W, H)
    for (let k = -1; k < n; k++) {
      const a0 = k >= 0 ? slotA[k] : bornA
      const s0 = k >= 0 ? slotS[k] : bornS
      const a = a0 + (slotA[k + 1] - a0) * t
      const s = s0 + (slotS[k + 1] - s0) * t
      const size = Math.max(3, Math.round(base * s))
      // the newborn is solid as soon as it clears the rim; the top one holds,
      // then lets go, which is evaporation rather than a dimmer
      let al = 1
      if (k === -1) al = Math.min(1, t * 1.6)
      else if (k === n - 1) al = 1 - t * t
      al *= p.intensity
      // a lazy sideways drift, the same on every cycle so the loop stays exact
      const drift = Math.sin((a / Math.max(1, L)) * Math.PI * 2) * 2 * p.spread
      const cx = src[0] + dx * a + perp[0] * drift
      const cy = src[1] + dy * a + perp[1] * drift
      blitBlob(fr, blob, base, size, Math.round(cx - size / 2), Math.round(cy - size / 2), al)
    }
    out.push(fr.toCanvas())
  }
  return out
}

/* spray: particles arcing from a source. Every particle's life is one full cycle and they are phase-shifted copies, so frame N wraps onto 0. The stagger is the golden ratio, which never clumps. */
function blob3(fr: Frame, cx: number, cy: number, size: number, col: RGB, a: number, lightest: RGB) {
  if (size <= 1) {
    fr.put(cx, cy, col, a)
    return
  }
  if (size === 2) {
    fr.put(cx, cy, col, a)
    fr.put(cx + 1, cy, col, a)
    fr.put(cx, cy + 1, col, a)
    fr.put(cx + 1, cy + 1, col, a)
    return
  }
  fr.put(cx, cy - 1, col, a)
  fr.put(cx - 1, cy, col, a)
  fr.put(cx, cy, col, a)
  fr.put(cx + 1, cy, col, a)
  fr.put(cx, cy + 1, col, a)
  // a paler core, so a fat droplet reads as water rather than a dot
  fr.put(cx, cy, lightest, a)
}

function sprayFrames(p: EffectParams, colors: string[]): HTMLCanvasElement[] {
  const { width: W, height: H } = p
  const rnd = mulberry32(p.seed * 40503 + 3)
  const pal = ramp(colors, 4)
  const [dx, dy] = dirVec(p.direction)
  const perp: [number, number] = [-dy, dx]
  const L = Math.abs(W * dx) + Math.abs(H * dy)
  const across = Math.abs(W * perp[0]) + Math.abs(H * perp[1])
  const src: [number, number] = [W / 2 - dx * W * 0.49, H / 2 - dy * H * 0.49]
  const n = clampI(p.count, 1, 48)
  const parts: { arc: number; along: number; size: number; col: RGB; phase: number }[] = []
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1
    const ci = Math.min(pal.length - 1, Math.floor(Math.pow(rnd(), 1.4) * pal.length))
    parts.push({
      arc: side * (0.6 + rnd() * 1.6),
      along: L * (0.22 + rnd() * 0.55),
      size: clampI((1 + rnd() * 2) * p.size, 1, 3),
      col: pal[ci],
      phase: (i * 0.618) % 1,
    })
  }
  const acrossScale = across * 0.17 * p.spread
  const out: HTMLCanvasElement[] = []
  for (let f = 0; f < p.frames; f++) {
    const t = f / p.frames
    const fr = new Frame(W, H)
    if (p.churn) churnBand(fr, t, p, pal, src, dx, dy, perp, across)
    for (const q of parts) {
      const u = (t + q.phase) % 1
      // travel with a slow-down at the far end, the way spray loses momentum
      const a = q.along * (1 - Math.pow(1 - u, 1.6))
      // the sideways travel grows while the particle climbs, plus a lazy
      // wobble so the column never reads as a straight line of dots
      const b = q.arc * u * acrossScale + Math.sin(u * 6.283 + q.phase * 9) * 0.9
      // in fast, out slow, gone by the end of the life so the loop closes clean
      const al = Math.pow(Math.sin(Math.PI * u), 0.7) * p.intensity
      const size = u < 0.6 ? q.size : Math.max(1, q.size - 1)
      blob3(fr, src[0] + dx * a + perp[0] * b, src[1] + dy * a + perp[1] * b, size, q.col, al, pal[0])
    }
    out.push(fr.toCanvas())
  }
  return out
}

/* The churn where the water lands: short foam dashes sliding outward and
 * fading. At map zoom a droplet is two screen pixels, so what actually reads as
 * motion is this band shifting, the same trick the engine's ocean foam uses. */
function churnBand(
  fr: Frame,
  t: number,
  p: EffectParams,
  pal: RGB[],
  src: [number, number],
  dx: number,
  dy: number,
  perp: [number, number],
  across: number,
) {
  for (let lane = 0; lane < 3; lane++) {
    const off = 1 + lane * 2
    const speed = [1.0, 0.7, 0.45][lane]
    const col = pal[Math.min(pal.length - 1, lane)]
    for (const side of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        const u = (t * speed + k * 0.25 + lane * 0.13) % 1
        const b = side * (2.5 + u * (across * 0.42))
        const a = Math.pow(Math.sin(Math.PI * u), 0.8) * 0.95 * p.intensity
        const w = u < 0.55 ? 2 : 1
        for (let i = 0; i < w; i++) {
          const bb = b + side * i
          fr.put(src[0] + dx * off + perp[0] * bb, src[1] + dy * off + perp[1] * bb, col, a)
        }
      }
    }
  }
}

/* twinkle: points fading where they stand. Nothing moves, so the timing carries it: a long dark hold and a brief peak, staggered by the golden ratio. The biggest points grow a four-point star at the peak. */
function twinkleFrames(p: EffectParams, colors: string[]): HTMLCanvasElement[] {
  const { width: W, height: H } = p
  const rnd = mulberry32(p.seed * 22697 + 5)
  const pal = ramp(colors, 3)
  const n = clampI(p.count, 1, 64)
  const pull = clamp(p.spread, 0.1, 1.2)
  const pts: { x: number; y: number; phase: number; big: boolean; col: RGB }[] = []
  for (let i = 0; i < n; i++) {
    const rx = rnd() * W
    const ry = rnd() * H
    pts.push({
      x: W / 2 + (rx - W / 2) * pull,
      y: H / 2 + (ry - H / 2) * pull,
      phase: (i * 0.618) % 1,
      big: rnd() < 0.3,
      col: pal[Math.min(pal.length - 1, Math.floor(Math.pow(rnd(), 1.6) * pal.length))],
    })
  }
  const arm = Math.max(1, Math.round(p.size))
  const out: HTMLCanvasElement[] = []
  for (let f = 0; f < p.frames; f++) {
    const t = f / p.frames
    const fr = new Frame(W, H)
    for (const q of pts) {
      const u = (t + q.phase) % 1
      const a = Math.pow(Math.sin(Math.PI * u), 6) * p.intensity
      if (a <= 0.04) continue
      fr.put(q.x, q.y, q.col, a)
      if (q.big && a > 0.5) {
        fr.put(q.x + 1, q.y, q.col, a * 0.8)
        fr.put(q.x, q.y + 1, q.col, a * 0.8)
      }
      if (q.big && a > 0.82) {
        for (let d = 1; d <= arm; d++) {
          const k = a * (1 - d / (arm + 1)) * 0.85
          fr.put(q.x - d, q.y, q.col, k)
          fr.put(q.x + 1 + d, q.y, q.col, k)
          fr.put(q.x, q.y - d, q.col, k)
          fr.put(q.x, q.y + 1 + d, q.col, k)
        }
      }
    }
    out.push(fr.toCanvas())
  }
  return out
}

// the patch the shear works on, centred into the effect's own canvas. Without
// one, a lumpy clump of the sampled colours stands in, so the rule always draws
function shearSource(p: EffectParams, colors: string[], patch?: Patch | null): Uint8ClampedArray {
  const { width: W, height: H } = p
  const out = new Uint8ClampedArray(W * H * 4)
  if (patch && patch.w > 0 && patch.h > 0) {
    const ox = Math.round((patch.w - W) / 2)
    const oy = Math.round((patch.h - H) / 2)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const sx = x + ox
        const sy = y + oy
        if (sx < 0 || sy < 0 || sx >= patch.w || sy >= patch.h) continue
        const s = (sy * patch.w + sx) * 4
        const d = (y * W + x) * 4
        out[d] = patch.data[s]
        out[d + 1] = patch.data[s + 1]
        out[d + 2] = patch.data[s + 2]
        out[d + 3] = patch.data[s + 3]
      }
    return out
  }
  const size = Math.min(W, H)
  const blob = buildBlob(size, colors, p.seed * 991 + 13, 0)
  const ox = Math.round((W - size) / 2)
  const oy = Math.round((H - size) / 2)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (!blob.m[y * size + x]) continue
      const s = (y * size + x) * 4
      const d = ((y + oy) * W + (x + ox)) * 4
      if (d < 0 || d + 3 >= out.length) continue
      out[d] = blob.px[s]
      out[d + 1] = blob.px[s + 1]
      out[d + 2] = blob.px[s + 2]
      out[d + 3] = 255
    }
  return out
}

/* sway: a shear cycle over the pixels already there, pivoting at the root so a tree bends at its crown. Nearest-neighbour, never interpolated: a blurred leaf is not pixel art. */
function swayFrames(p: EffectParams, colors: string[], patch?: Patch | null): HTMLCanvasElement[] {
  const { width: W, height: H } = p
  const src = shearSource(p, colors, patch)
  const [dx, dy] = dirVec(p.direction)
  const perp: [number, number] = [-dy, dx]
  const L = Math.max(1, Math.abs(W * dx) + Math.abs(H * dy))
  const amp = Math.max(1, W * 0.1 * p.spread * p.size)
  const out: HTMLCanvasElement[] = []
  for (let f = 0; f < p.frames; f++) {
    const off = amp * Math.sin((2 * Math.PI * f) / p.frames)
    const fr = new Frame(W, H)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const ox = x + 0.5 - W / 2
        const oy = y + 0.5 - H / 2
        const along = clamp((ox * dx + oy * dy + L / 2) / L, 0, 1)
        const k = Math.pow(along, 1.4)
        const sx = Math.round(x - off * k * perp[0])
        const sy = Math.round(y - off * k * perp[1])
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue
        const s = (sy * W + sx) * 4
        if (src[s + 3] === 0) continue
        const d = (y * W + x) * 4
        fr.data[d] = src[s]
        fr.data[d + 1] = src[s + 1]
        fr.data[d + 2] = src[s + 2]
        fr.data[d + 3] = Math.min(255, src[s + 3] * p.intensity)
      }
    out.push(fr.toCanvas())
  }
  return out
}

/* glow: radius and alpha breathe together over one sine, so a lamp swells rather than blinks. The falloff is quantised and the fringe knocked out by the ordered matrix, which keeps it a dithered halo. */
function glowFrames(p: EffectParams, colors: string[], own = false): HTMLCanvasElement[] {
  const { width: W, height: H } = p
  const pal = own ? ownRamp(colors, 4) : warmRamp(colors, 4)
  const cx = W / 2
  const cy = H / 2
  const r0 = (Math.min(W, H) / 2) * clamp(p.size, 0.2, 2)
  const out: HTMLCanvasElement[] = []
  for (let f = 0; f < p.frames; f++) {
    const b = 0.5 + 0.5 * Math.sin((2 * Math.PI * f) / p.frames)
    const R = Math.max(1, r0 * (0.82 + 0.3 * b * clamp(p.spread, 0.2, 2)))
    const A = p.intensity * (0.55 + 0.45 * b)
    const fr = new Frame(W, H)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / R
        if (d >= 1) continue
        const v = (1 - d) * (1 - d)
        const q = Math.floor(A * v * 5 + bayer(x, y)) / 5
        if (q <= 0) continue
        const idx = clampI(Math.floor((1 - v) * pal.length + bayer(x, y) * 0.9), 0, pal.length - 1)
        fr.put(x, y, pal[idx], Math.min(1, q))
      }
    out.push(fr.toCanvas())
  }
  return out
}

/* swirl: a turning vortex, and the rule a portal had nowhere else to go: the ask went to glow, and a radial pulse is a lamp. Ring i carries A arms, so turning by 2pi/A leaves it identical, and each ring turns a whole number of those steps per cycle. m counts DOWN with the ring index, so the inner rings turn fastest and it reads as pulling inward. */

// the vertical squash: the map is isometric and a portal lies in a doorway, so a circle drawn head-on reads wrong. 0.62 is the ellipse the rest of this maths assumes.
const SWIRL_SQUASH = 0.62

function swirlFrames(p: EffectParams, colors: string[], own: boolean): HTMLCanvasElement[] {
  const { width: W, height: H } = p
  const rnd = mulberry32(p.seed * 15731 + 17)
  const rings = clampI(p.count, 2, 10)
  const pal = own ? ownRamp(colors, rings + 2) : ramp(colors, rings + 2)
  // the brightest entry, pushed a little further when the ramp is the effect's
  // own, so the middle of a gateway burns rather than sits
  const core = own ? mix(pal[0], [255, 255, 255], 0.4) : pal[0]
  const cx = W / 2
  const cy = H / 2
  // at size 1 the ellipse fills the canvas exactly, whichever side is tighter.
  // Above 1 it runs off the edges, the same way a glow's radius does, so size
  // stays a way to overfill a canvas on purpose rather than a second width.
  const R = Math.min(W / 2, H / (2 * SWIRL_SQUASH)) * clamp(p.size, 0.2, 2)
  const rx = Math.max(2, R)
  const ry = Math.max(1.5, R * SWIRL_SQUASH)
  // how far in from the rim the bands reach: spread pulls them toward the
  // centre, leaving a smaller core hole
  const rc = clamp(0.3 / clamp(p.spread, 0.3, 3), 0.06, 0.6)
  const bw = (1 - rc) / rings
  // direction tilts the ellipse, which is the only spatial thing a flat disc
  // has left to say. Everything else about it is radial.
  const tilt = (p.direction * Math.PI) / 180
  const ctl = Math.cos(tilt)
  const stl = Math.sin(tilt)
  const TAU = Math.PI * 2
  // per ring: its arm count, and the radians it has turned by the end of the
  // cycle. Both are independent of the frame count, which is what keeps a
  // 16-frame render a resampling of the 8-frame one rather than a new pattern.
  const arms: number[] = []
  const turn: number[] = []
  for (let i = 0; i < rings; i++) {
    const a = 2 + i
    arms.push(a)
    turn.push((TAU * (rings - i)) / a)
  }
  const specks: { r: number; th0: number; m: number; col: RGB }[] = []
  for (let i = 0, n = Math.min(10, rings + 3); i < n; i++)
    specks.push({
      r: rc + (1 - rc) * (0.15 + rnd() * 0.8),
      th0: rnd() * TAU,
      m: 1 + Math.floor(rnd() * 2),
      col: pal[Math.min(pal.length - 1, Math.floor(rnd() * 2))],
    })
  const out: HTMLCanvasElement[] = []
  for (let f = 0; f < p.frames; f++) {
    const t = f / p.frames
    const fr = new Frame(W, H)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const ox = x + 0.5 - cx
        const oy = y + 0.5 - cy
        // back into the circle the maths runs in: untilt, then unsquash
        const ux = (ox * ctl + oy * stl) / rx
        const uy = (-ox * stl + oy * ctl) / ry
        const rr = Math.hypot(ux, uy)
        if (rr >= 1) continue
        if (rr < rc) {
          const a = p.intensity * (1 - 0.5 * (rr / rc))
          const q = Math.floor(a * 4 + bayer(x, y)) / 4
          if (q > 0) fr.put(x, y, core, Math.min(1, q))
          continue
        }
        const i = Math.min(rings - 1, Math.floor((rr - rc) / bw))
        // the radial gap that keeps one ring off the next
        if ((rr - rc) / bw - i > 0.82) continue
        const cell = TAU / arms[i]
        const th = Math.atan2(uy, ux) + turn[i] * t
        const u = (((th % cell) + cell) % cell) / cell
        const duty = clamp(0.68 - 0.03 * i, 0.32, 0.72)
        if (u >= duty) continue
        // an arc is brightest in its middle and tapers at both ends, the way a
        // streak does in flow
        const k = Math.pow(Math.sin(Math.PI * (u / duty)), 0.6)
        const col = pal[clampI(1 + Math.round((i / Math.max(1, rings - 1)) * (pal.length - 2)), 0, pal.length - 1)]
        const a = p.intensity * k * (1 - 0.25 * ((rr - rc) / (1 - rc))) * 0.95
        const q = Math.floor(a * 4 + bayer(x, y)) / 4
        if (q > 0) fr.put(x, y, col, Math.min(1, q))
      }
    for (const s of specks) {
      const th = s.th0 + TAU * s.m * t
      const ux = Math.cos(th) * s.r * rx
      const uy = Math.sin(th) * s.r * ry
      fr.put(cx + ux * ctl - uy * stl, cy + ux * stl + uy * ctl, s.col, Math.min(1, 0.9 * p.intensity))
    }
    out.push(fr.toCanvas())
  }
  return out
}

// ---- the one way in -------------------------------------------------------

/* Frames for one effect. Pure. `own` says the ramp is the effect's own rather than sampled, defaults to off, so every effect made before the colours were a decision renders byte-identically. */
export function renderEffect(
  type: EffectType,
  params: EffectParams,
  colors: string[],
  patch?: Patch | null,
  own = false,
): HTMLCanvasElement[] {
  switch (type) {
    case 'flow':
      return flowFrames(params, colors)
    case 'rise':
      return riseFrames(params, colors, patch, own)
    case 'spray':
      return sprayFrames(params, colors)
    case 'twinkle':
      return twinkleFrames(params, colors)
    case 'sway':
      return swayFrames(params, colors, patch)
    case 'glow':
      return glowFrames(params, colors, own)
    case 'swirl':
      return swirlFrames(params, colors, own)
  }
}
