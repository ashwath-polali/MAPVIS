/* Custom effects: when an ask fits none of the seven rules in effects.ts, the planner WRITES the renderer and it runs here, in a blob worker with the network, the page and every loader taken off it. api.t runs 0..1 and rnd(n) is stable per n, so a correct recipe loops by construction. */
import { mkCanvas } from './mask'

// one declared knob: a custom effect ships its own sliders rather than
// borrowing the five fixed ones
export interface CustomControl {
  key: string
  label: string
  min: number
  max: number
  step: number
  value: number
}

export interface CustomSpec {
  code: string
  controls: CustomControl[]
}

export interface CustomReq {
  code: string
  // every number the code can read as p.<key>: the canvas and cycle fields plus
  // whatever the declared controls are called
  params: Record<string, number>
  colors: string[]
  width: number
  height: number
  frames: number
  seed: number
  // also render 2n frames and check frame k against frame 2k
  seam?: boolean
  /* An existing sprite the recipe can draw and MOVE. PixelLab's animator only animates in place, so a crab it animates breathes where it stands; a recipe that blits at a per-frame position walks. */
  sprite?: { w: number; h: number; frames: Uint8ClampedArray[] }
}

export interface CustomRun {
  frames: Uint8ClampedArray[]
  w: number
  h: number
  // nothing was drawn on any frame
  empty: boolean
  // frame k of this render matched frame 2k of a double-length one
  loops: boolean
  // the seam check actually ran; a slow render skips it rather than blow the clock
  seamRan: boolean
  // what the code threw, deduped, at most a few
  errors: string[]
  ms: number
}

// the whole render, both passes, gets this long. Past it the worker is killed.
export const CUSTOM_MS = 3000
// the first pass has to come in under this or the seam pass is skipped
const SEAM_BUDGET = 700

/* The worker, as source. It is one self-contained classic worker on purpose:
 * a blob cannot import anything, which is half the sandbox for free. */
const SRC = `
'use strict'
var post = self.postMessage.bind(self)

/* The doors come off before any written code is built. READ THIS BEFORE TRUSTING IT: a denylist over a shared global is hardening and not a boundary, and a determined body can still get out. Tolerable only because the planner writes it in the author's own browser against their own map; it stops being tolerable the moment one account's effect can be run by somebody else. The two holes closed here are the prototype chain (deleting off self only shadows) and .constructor handing Function back. */
var SHUT = ['fetch','XMLHttpRequest','WebSocket','EventSource','importScripts','Worker','SharedWorker','indexedDB','caches','BroadcastChannel','FileReader','navigator','crypto','WorkerGlobalScope']
var scope = self
while (scope && scope !== Object.prototype) {
  for (var si = 0; si < SHUT.length; si++) {
    try { delete scope[SHUT[si]] } catch (e) {}
    try { Object.defineProperty(scope, SHUT[si], { value: undefined, writable: false, configurable: false }) } catch (e) {}
  }
  scope = Object.getPrototypeOf(scope)
}

// .constructor is the way back to Function from any value at all, so it comes
// off the intrinsics a written body actually has in hand. post was bound above
// this, so the worker can still answer.
var VIA = [Object, Array, String, Number, Boolean, Function, RegExp]
// the async and generator function constructors are separate intrinsics with the same power: (async function(){}).constructor('return this')() handed back the real global before this line.
try { VIA.push(Object.getPrototypeOf(async function () {}).constructor) } catch (e) {}
try { VIA.push(Object.getPrototypeOf(function* () {}).constructor) } catch (e) {}
try { VIA.push(Object.getPrototypeOf(async function* () {}).constructor) } catch (e) {}
for (var vi = 0; vi < VIA.length; vi++) {
  try { Object.defineProperty(VIA[vi].prototype, 'constructor', { value: undefined, writable: false, configurable: false }) } catch (e) {}
}

// the body, built once. The names after api are shadows: inside the body they
// are all undefined, so even the words are dead ends.
function build(code) {
  return new Function(
    'p', 'colors', 'api',
    'self', 'globalThis', 'postMessage', 'fetch', 'XMLHttpRequest',
    'importScripts', 'Worker', 'WebSocket', 'indexedDB', 'caches', 'Function',
    '"use strict";\\n' + code + '\\n'
  )
}

function hex2rgb(s) {
  var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s).trim())
  if (!m) return [255, 255, 255]
  var h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  var n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// mulberry32's mixing over an INDEX rather than a running counter, so rnd(n) is the same number for the same n on every frame and the loop cannot drift.
function mkRnd(seed) {
  return function (n) {
    var x = (Math.imul(n | 0, 0x27d4eb2d) ^ (seed >>> 0)) >>> 0
    x = Math.imul(x ^ (x >>> 15), 1 | x)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function mkApi(buf, W, H, f, N, seed, ramp, colors, SPR) {
  var cache = {}
  var colOf = function (c) {
    if (typeof c === 'number') {
      var i = c | 0
      if (!(i >= 0)) i = 0
      if (i > ramp.length - 1) i = ramp.length - 1
      return ramp[i]
    }
    var k = String(c)
    var got = cache[k]
    if (!got) { got = hex2rgb(k); cache[k] = got }
    return got
  }
  // one pixel, already whole and already inside. Source over, so a later draw
  // sits on top of the one below it the way a person would expect.
  var raw = function (xi, yi, col, a) {
    var sa = a > 1 ? 1 : a
    var i = (yi * W + xi) * 4
    var da = buf[i + 3] / 255
    if (sa >= 1 || da <= 0) {
      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]
      buf[i + 3] = Math.round(sa * 255)
      return
    }
    var oa = sa + da * (1 - sa)
    var k = da * (1 - sa)
    buf[i] = (col[0] * sa + buf[i] * k) / oa
    buf[i + 1] = (col[1] * sa + buf[i + 1] * k) / oa
    buf[i + 2] = (col[2] * sa + buf[i + 2] * k) / oa
    buf[i + 3] = Math.round(oa * 255)
  }
  var put = function (x, y, c, a) {
    var al = a === undefined ? 1 : a
    if (!(al > 0.02)) return
    var xi = Math.round(x), yi = Math.round(y)
    if (!(xi >= 0 && yi >= 0 && xi < W && yi < H)) return
    raw(xi, yi, colOf(c), al)
  }
  var rect = function (x, y, w, h, c, a) {
    var al = a === undefined ? 1 : a
    if (!(al > 0.02)) return
    var col = colOf(c)
    var x0 = Math.round(x), y0 = Math.round(y)
    var x1 = Math.round(x + w), y1 = Math.round(y + h)
    if (x1 < x0) { var tx = x0; x0 = x1; x1 = tx }
    if (y1 < y0) { var ty = y0; y0 = y1; y1 = ty }
    if (x0 < 0) x0 = 0
    if (y0 < 0) y0 = 0
    if (x1 > W) x1 = W
    if (y1 > H) y1 = H
    for (var yy = y0; yy < y1; yy++) for (var xx = x0; xx < x1; xx++) raw(xx, yy, col, al)
  }
  var disc = function (cx, cy, r, c, a, lumpy) {
    var al = a === undefined ? 1 : a
    if (!(al > 0.02) || !(r > 0)) return
    var col = colOf(c)
    var rr = r > 4096 ? 4096 : r
    var reach = lumpy ? rr * 1.3 : rr
    var x0 = Math.floor(cx - reach - 1), x1 = Math.ceil(cx + reach + 1)
    var y0 = Math.floor(cy - reach - 1), y1 = Math.ceil(cy + reach + 1)
    if (x0 < 0) x0 = 0
    if (y0 < 0) y0 = 0
    if (x1 > W - 1) x1 = W - 1
    if (y1 > H - 1) y1 = H - 1
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x + 0.5 - cx, dy = y + 0.5 - cy
        var d = Math.sqrt(dx * dx + dy * dy)
        if (d > reach) continue
        if (lumpy) {
          var th = Math.atan2(dy, dx)
          // fixed lobes, no seed and no frame in them, so a puff keeps its
          // shape across the cycle instead of boiling
          var wob = 1 + 0.17 * Math.sin(3 * th + 1.7) + 0.11 * Math.sin(5 * th - 0.6) + 0.07 * Math.sin(7 * th + 2.4)
          if (d > rr * wob) continue
        }
        raw(x, y, col, al)
      }
    }
  }
  var line = function (x0, y0, x1, y1, c, a) {
    var al = a === undefined ? 1 : a
    if (!(al > 0.02)) return
    var col = colOf(c)
    var ax = Math.round(x0), ay = Math.round(y0), bx = Math.round(x1), by = Math.round(y1)
    if (!(isFinite(ax) && isFinite(ay) && isFinite(bx) && isFinite(by))) return
    var dx = Math.abs(bx - ax), sx = ax < bx ? 1 : -1
    var dy = -Math.abs(by - ay), sy = ay < by ? 1 : -1
    var err = dx + dy
    // a runaway line still stops: the longest useful one is the diagonal
    var guard = (W + H) * 4 + 8
    while (guard-- > 0) {
      if (ax >= 0 && ay >= 0 && ax < W && ay < H) raw(ax, ay, col, al)
      if (ax === bx && ay === by) break
      var e2 = 2 * err
      if (e2 >= dy) { err += dy; ax += sx }
      if (e2 <= dx) { err += dx; ay += sy }
    }
  }
  // stamp the source sprite with its FEET at x,y, the anchor everything else
  // in this tool uses. flip mirrors it, which is how a walker turns round.
  var sprite = function (x, y, opts) {
    if (!SPR || !SPR.frames.length) return
    var o = opts || {}
    var idx = o.frame === undefined ? f % SPR.frames.length : Math.floor(o.frame) % SPR.frames.length
    if (idx < 0) idx += SPR.frames.length
    var src = SPR.frames[idx]
    if (!src) return
    var sw = SPR.w | 0, sh = SPR.h | 0
    var al = o.alpha === undefined ? 1 : o.alpha
    if (!(al > 0.02)) return
    var flip = !!o.flip
    var ox = Math.round(x) - (sw >> 1)
    var oy = Math.round(y) - sh
    for (var sy = 0; sy < sh; sy++) {
      var dy = oy + sy
      if (dy < 0 || dy >= H) continue
      for (var sx = 0; sx < sw; sx++) {
        var dx = ox + (flip ? sw - 1 - sx : sx)
        if (dx < 0 || dx >= W) continue
        var si = (sy * sw + sx) * 4
        var sa = src[si + 3] / 255
        if (sa <= 0.02) continue
        raw(dx, dy, [src[si], src[si + 1], src[si + 2]], sa * al)
      }
    }
  }
  return {
    w: W,
    h: H,
    t: f / N,
    frame: f,
    frames: N,
    colors: colors,
    rnd: mkRnd(seed),
    px: put,
    rect: rect,
    line: line,
    circle: function (cx, cy, r, c, a) { disc(cx, cy, r, c, a, false) },
    blob: function (cx, cy, r, c, a) { disc(cx, cy, r, c, a, true) },
    sprite: sprite,
    spriteW: SPR ? SPR.w : 0,
    spriteH: SPR ? SPR.h : 0,
    hasSprite: !!SPR,
  }
}

function same(a, b) {
  if (a.length !== b.length) return false
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

self.onmessage = function (ev) {
  var d = ev.data || {}
  var t0 = Date.now()
  try {
    var W = d.width | 0, H = d.height | 0, N = d.frames | 0
    var colors = Array.isArray(d.colors) && d.colors.length ? d.colors : ['#ffffff']
    var ramp = colors.map(hex2rgb)
    var p = d.params || {}
    var seed = d.seed | 0
    // the source sprite, if this recipe is moving one rather than drawing one
    var SPR = null
    if (d.sprite && d.sprite.frames && d.sprite.frames.length) {
      var sf = []
      for (var q = 0; q < d.sprite.frames.length; q++) sf.push(new Uint8ClampedArray(d.sprite.frames[q]))
      SPR = { w: d.sprite.w | 0, h: d.sprite.h | 0, frames: sf }
    }
    var fn = build(String(d.code || ''))
    var errs = []
    var note = function (e) {
      var m = String((e && e.message) || e).slice(0, 160)
      if (errs.length < 3 && errs.indexOf(m) < 0) errs.push(m)
    }
    var bufs = []
    for (var f = 0; f < N; f++) {
      var buf = new Uint8ClampedArray(W * H * 4)
      try { fn(p, colors, mkApi(buf, W, H, f, N, seed, ramp, colors, SPR)) } catch (e) { note(e) }
      bufs.push(buf)
    }
    var empty = true
    for (var i = 0; i < bufs.length && empty; i++) {
      var b = bufs[i]
      for (var j = 3; j < b.length; j += 4) if (b[j] !== 0) { empty = false; break }
    }
    // the seam check: a recipe that is a pure function of api.t draws the same pixels at frame k of n as at 2k of 2n. One that reads api.frame does not, and that is the one way a recipe pops on the wrap.
    var loops = true
    var seamRan = false
    if (d.seam && Date.now() - t0 < ${SEAM_BUDGET}) {
      seamRan = true
      for (var g = 0; g < N * 2 && loops; g++) {
        if (g % 2) continue
        var b2 = new Uint8ClampedArray(W * H * 4)
        try { fn(p, colors, mkApi(b2, W, H, g, N * 2, seed, ramp, colors, SPR)) } catch (e) { note(e) }
        if (!same(bufs[g / 2], b2)) loops = false
      }
    }
    var out = []
    var move = []
    for (var k = 0; k < bufs.length; k++) { out.push(bufs[k].buffer); move.push(bufs[k].buffer) }
    post({ ok: true, bufs: out, w: W, h: H, empty: empty, loops: loops, seamRan: seamRan, errors: errs, ms: Date.now() - t0 }, move)
  } catch (e) {
    post({ ok: false, error: String((e && e.message) || e).slice(0, 200) })
  }
}
`

let blobURL = ''
function workerURL(): string {
  if (!blobURL) blobURL = URL.createObjectURL(new Blob([SRC], { type: 'text/javascript' }))
  return blobURL
}

/* One render of a written recipe. Rejects on a timeout, a worker that will not
 * start, or a body that would not even build; a body that throws while drawing
 * resolves with the frames it managed and the message in errors. */
export function runCustom(req: CustomReq): Promise<CustomRun> {
  return new Promise<CustomRun>((resolve, reject) => {
    let w: Worker
    try {
      w = new Worker(workerURL())
    } catch (e) {
      reject(new Error(String(e instanceof Error ? e.message : e)))
      return
    }
    let done = false
    const end = () => {
      done = true
      clearTimeout(timer)
      w.terminate()
    }
    const timer = setTimeout(() => {
      if (done) return
      end()
      reject(new Error('that recipe ran too long'))
    }, CUSTOM_MS)
    w.onmessage = (ev: MessageEvent) => {
      if (done) return
      const d = ev.data as {
        ok: boolean
        error?: string
        bufs?: ArrayBuffer[]
        w?: number
        h?: number
        empty?: boolean
        loops?: boolean
        seamRan?: boolean
        errors?: string[]
        ms?: number
      }
      end()
      if (!d || !d.ok) {
        reject(new Error(d?.error || 'that recipe did not run'))
        return
      }
      resolve({
        frames: (d.bufs || []).map((b) => new Uint8ClampedArray(b)),
        w: d.w || req.width,
        h: d.h || req.height,
        empty: !!d.empty,
        loops: d.loops !== false,
        seamRan: !!d.seamRan,
        errors: d.errors || [],
        ms: d.ms || 0,
      })
    }
    w.onerror = (ev) => {
      if (done) return
      end()
      reject(new Error(ev.message || 'that recipe did not run'))
    }
    // the sprite's buffers are TRANSFERRED, not copied: a walker's source can
    // be a few hundred KB and it is read-only on the far side
    const spr = req.sprite
    const msg: Record<string, unknown> = {
      code: req.code,
      params: req.params,
      colors: req.colors,
      width: req.width,
      height: req.height,
      frames: req.frames,
      seed: req.seed,
      seam: !!req.seam,
    }
    const move: ArrayBuffer[] = []
    if (spr && spr.frames.length) {
      const bufs = spr.frames.map((f) => f.buffer as ArrayBuffer)
      msg.sprite = { w: spr.w, h: spr.h, frames: bufs }
      move.push(...bufs)
    }
    w.postMessage(msg, move)
  })
}

// the raw buffers as canvases, the same currency the seven rules hand back
export function customCanvases(run: CustomRun): HTMLCanvasElement[] {
  return run.frames.map((f) => {
    const c = mkCanvas(run.w, run.h)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    const img = g.createImageData(run.w, run.h)
    img.data.set(f)
    g.putImageData(img, 0, 0)
    return c
  })
}
