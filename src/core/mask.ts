import type { Life } from './life'
/* The mask document: the walkable ground, the elevation levels, the occluders.
 *
 * Ported from tools/maskdraw/app.js in the game repo. The pixel operations are
 * the same ones that were used to author the harbor scene, kept exact on
 * purpose: they have no antialiasing, they write whole pixels, and the seam
 * heal has already caught a bug that a person could not see below 6x.
 *
 * Encoding (matches src/game/painted/PaintedScene.tsx in the game):
 *   0 = blocked. 40 = L0, 50 = ramp01, 60 = L1, 70 = ramp12, 80 = L2,
 *   90 = ramp23, 100 = L3. A step is legal when |a-b| <= 10, so two plateaus
 *   only connect through the stair painted between them.
 */

export interface PalEntry {
  v: number
  name: string
  key: string
  col: [number, number, number]
}

export const PAL: PalEntry[] = [
  { v: 0, name: 'blocked', key: '0', col: [232, 70, 96] },
  { v: 40, name: 'ground', key: '1', col: [70, 150, 220] },
  { v: 50, name: 'stair up to 1', key: '2', col: [120, 220, 230] },
  { v: 60, name: 'level 1', key: '3', col: [90, 210, 120] },
  { v: 70, name: 'stair up to 2', key: '4', col: [200, 235, 110] },
  // violet, not amber: the old [245,190,70] sat invisibly on warm sandstone paintings
  { v: 80, name: 'level 2', key: '5', col: [150, 90, 255] },
  { v: 90, name: 'stair up to 3', key: '6', col: [245, 140, 70] },
  { v: 100, name: 'level 3', key: '7', col: [235, 110, 190] },
]

export const colOf = (v: number): [number, number, number] =>
  (PAL.find((p) => p.v === v) || PAL[0]).col

export const nameOf = (v: number): string => (PAL.find((p) => p.v === v) || PAL[0]).name

export interface Occluder {
  id: number
  baseline: number
}

/* A placed asset: a piece of life set ON the painting after mechanics exist.
 * x,y is the FEET anchor in painting pixels (sprite anchor 0.5, 1); the game
 * y-sorts by y. sx/sy scale each axis against the png's native size, rot is
 * radians around the feet anchor, fx/fy mirror the sprite (the game applies
 * them as negative scale, so the editor draws them the same way). scale is
 * the legacy uniform field, kept equal to sx so every older reader stays
 * alive. Static assets carry src, animated ones carry an ordered frame list
 * and an fps. The urls here are the editor's own (/work/<id>/library/... for
 * this map's generated assets); export rewrites them to the bundle's assets/
 * folder. */
export interface PlacedAsset {
  id: string
  group: string
  kind: 'static' | 'animated'
  src?: string
  frames?: string[]
  fps?: number
  /* one view per heading, when this thing faces where it walks */
  dirs?: Record<string, string[]>
  x: number
  y: number
  scale: number
  sx: number
  sy: number
  rot: number
  fx: boolean
  fy: boolean
  /* how this one MOVES, if it does. Data, not frames: see core/life.ts for why
   * travel cannot be baked into an animation. Absent means it stands still,
   * which is almost everything. */
  life?: Life | null
}

// an asset from an older save or bundle: before the transform fields only
// `scale` existed, so absent ones fill in as the identity transform. Mutates
// and returns the same object so array.map keeps references stable.
export function migrateAsset(a: PlacedAsset): PlacedAsset {
  const s = Number(a.scale) > 0 ? Number(a.scale) : 0.25
  if (!(Number(a.sx) > 0)) a.sx = s
  if (!(Number(a.sy) > 0)) a.sy = s
  a.rot = isFinite(Number(a.rot)) ? Number(a.rot) : 0
  a.fx = !!a.fx
  a.fy = !!a.fy
  a.scale = a.sx
  return a
}

// the short human name of a placement: the png's basename, or the frame
// folder's name for an animated one
export const assetLabel = (a: PlacedAsset): string => {
  const f = a.src || (a.frames && a.frames[0]) || ''
  const parts = f.split('/')
  /* A set of VIEWS lives in a folder like an animation does, so its name is the
   * folder and not the file. It is kind 'static' though, because each view IS
   * one still picture, and without this line the label came back as "south" —
   * the view it happened to point at — so every lookup by name missed and
   * ctrl+P, ctrl+T, crop and the palette lock all silently did nothing. */
  if (a.kind === 'animated' || (a.dirs && Object.keys(a.dirs).length)) return parts[parts.length - 2] || a.id
  return (parts[parts.length - 1] || a.id).replace(/\.png$/i, '')
}

/* An EVENT: a spot on the map plus an action. x,y is the anchor in painting
 * pixels, r the activation radius the game tests the character's feet
 * against. The first type is a door — label is its human name, to the bundle
 * id it leads to. type stays an open string so a later kind (dialogue, a
 * trigger) rides the same list without a format change; a reader skips types
 * it does not know. */
export interface MapEvent {
  id: number
  type: string
  x: number
  y: number
  r: number
  label: string
  to: string
}

// an event from an older save: absent numbers fill in sane, absent strings
// empty. Mutates and returns the same object, like migrateAsset.
export function migrateEvent(e: MapEvent): MapEvent {
  e.id = Number(e.id) > 0 ? Math.round(Number(e.id)) : 1
  e.type = typeof e.type === 'string' && e.type ? e.type : 'door'
  e.x = isFinite(Number(e.x)) ? Math.round(Number(e.x)) : 0
  e.y = isFinite(Number(e.y)) ? Math.round(Number(e.y)) : 0
  e.r = Number(e.r) > 0 ? Math.round(Number(e.r)) : 14
  e.label = typeof e.label === 'string' ? e.label : ''
  e.to = typeof e.to === 'string' ? e.to : ''
  return e
}

export interface StairRegion {
  value: number
  connects: [number, number]
  rect: [number, number, number, number]
  px: number
}

export type Pt = [number, number]

export class MaskDoc {
  W: number
  H: number
  lvl: Uint8Array
  occ: Uint8Array
  cut: Uint8Array
  hits: Uint8Array
  occs: Occluder[] = []
  occNext = 1
  assets: PlacedAsset[] = []
  assetNext = 1
  events: MapEvent[] = []
  eventNext = 1
  spawn: Pt
  // boundary growth: bw/bh is the base painting's own size (set once at
  // construction), ox/oy is how far that base sits inside the grown canvas.
  // Zero until the map is expanded; the editor composites the art at this
  // offset and the autosave uses it to re-grow on reload.
  bw: number
  bh: number
  ox = 0
  oy = 0
  private hist: {
    w: number
    h: number
    l: Uint8Array
    o: Uint8Array
    c: Uint8Array
    a: string
    e: string
    sp: Pt
    oc: string
    ox: number
    oy: number
  }[] = []

  constructor(w: number, h: number) {
    this.W = w
    this.H = h
    this.bw = w
    this.bh = h
    this.lvl = new Uint8Array(w * h)
    this.occ = new Uint8Array(w * h)
    this.cut = new Uint8Array(w * h)
    this.hits = new Uint8Array(w * h)
    this.spawn = [Math.round(w / 2), Math.round(h * 0.7)]
  }

  idx(x: number, y: number) {
    return y * this.W + x
  }
  inB(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.W && y < this.H
  }
  lvlAt(x: number, y: number) {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (!this.inB(xi, yi)) return 0
    return this.lvl[this.idx(xi, yi)]
  }
  occAt(x: number, y: number) {
    return this.inB(x, y) ? this.occ[this.idx(x, y)] : 0
  }
  cutAt(x: number, y: number) {
    return this.inB(x, y) ? this.cut[this.idx(x, y)] : 0
  }

  // ---- history ----------------------------------------------------------
  // assets and events ride the same timeline as the planes: a placement, a
  // drag, a dropped door or a group clear is one z away, and a mask undo can
  // never strand their state
  snap() {
    this.hist.push({
      w: this.W,
      h: this.H,
      l: this.lvl.slice(),
      o: this.occ.slice(),
      c: this.cut.slice(),
      a: JSON.stringify(this.assets),
      e: JSON.stringify(this.events),
      sp: [this.spawn[0], this.spawn[1]],
      oc: JSON.stringify(this.occs),
      ox: this.ox,
      oy: this.oy,
    })
    if (this.hist.length > 60) this.hist.shift()
  }
  undo() {
    const h = this.hist.pop()
    if (!h) return false
    // a boundary growth is one z away like everything else: when the snapshot
    // was taken at another size, the whole document re-lays at that size.
    // Same-size undos deliberately do NOT touch spawn/occs, exactly as before.
    if (h.w !== this.W || h.h !== this.H) {
      this.W = h.w
      this.H = h.h
      this.lvl = new Uint8Array(h.w * h.h)
      this.occ = new Uint8Array(h.w * h.h)
      this.cut = new Uint8Array(h.w * h.h)
      this.hits = new Uint8Array(h.w * h.h)
      this.spawn = [h.sp[0], h.sp[1]]
      this.occs = JSON.parse(h.oc) as Occluder[]
      this.ox = h.ox
      this.oy = h.oy
    }
    this.lvl.set(h.l)
    this.occ.set(h.o)
    this.cut.set(h.c)
    this.assets = (JSON.parse(h.a) as PlacedAsset[]).map(migrateAsset)
    this.events = (JSON.parse(h.e) as MapEvent[]).map(migrateEvent)
    return true
  }

  // ---- boundary growth ---------------------------------------------------
  // Grow the canvas by a transparent margin: every plane is re-laid at the
  // same offset, and the spawn, the occluder baselines and the placed assets
  // shift with it. Pure memory copy, never a resample. The caller owns the
  // undo snapshot and the painting recomposite.
  grow(dx: number, dy: number, nw: number, nh: number) {
    const { W: ow, H: oh } = this
    const move = (src: Uint8Array) => {
      const out = new Uint8Array(nw * nh)
      for (let y = 0; y < oh; y++) out.set(src.subarray(y * ow, y * ow + ow), (y + dy) * nw + dx)
      return out
    }
    this.lvl = move(this.lvl)
    this.occ = move(this.occ)
    this.cut = move(this.cut)
    this.hits = new Uint8Array(nw * nh)
    this.W = nw
    this.H = nh
    this.spawn = [this.spawn[0] + dx, this.spawn[1] + dy]
    for (const o of this.occs) o.baseline += dy
    for (const a of this.assets) {
      a.x += dx
      a.y += dy
    }
    for (const e of this.events) {
      e.x += dx
      e.y += dy
    }
    this.ox += dx
    this.oy += dy
  }
  clear() {
    this.snap()
    this.lvl.fill(0)
    this.occ.fill(0)
    this.cut.fill(0)
    this.hits.fill(0)
    this.occs = []
    this.occNext = 1
  }

  // ---- exact drawing, no antialiasing -----------------------------------
  setPx(x: number, y: number, v: number) {
    if (!this.inB(x, y)) return
    this.lvl[this.idx(x, y)] = v
  }
  stamp(cx: number, cy: number, v: number, size: number) {
    if (size <= 1) {
      this.setPx(cx, cy, v)
      return
    }
    const h0 = Math.floor((size - 1) / 2)
    const h1 = Math.ceil((size - 1) / 2)
    for (let y = cy - h0; y <= cy + h1; y++)
      for (let x = cx - h0; x <= cx + h1; x++) this.setPx(x, y, v)
  }
  fillRect(x0: number, y0: number, x1: number, y1: number, v: number) {
    const ax = Math.min(x0, x1)
    const bx = Math.max(x0, x1)
    const ay = Math.min(y0, y1)
    const by = Math.max(y0, y1)
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) this.setPx(x, y, v)
  }
  // ---- the cut mask: a binary plane, never the levels, never the art ----
  setCut(x: number, y: number, v: number) {
    if (!this.inB(x, y)) return
    this.cut[this.idx(x, y)] = v ? 1 : 0
  }
  cutStamp(cx: number, cy: number, v: number, size: number) {
    if (size <= 1) {
      this.setCut(cx, cy, v)
      return
    }
    const h0 = Math.floor((size - 1) / 2)
    const h1 = Math.ceil((size - 1) / 2)
    for (let y = cy - h0; y <= cy + h1; y++)
      for (let x = cx - h0; x <= cx + h1; x++) this.setCut(x, y, v)
  }
  // The machine proposal: flood the painting's own colour from the clicked
  // pixel, Manhattan RGB distance against the SEED colour, never chained
  // neighbour to neighbour (chaining is how sea-navy once walked into volcano
  // rock). Contiguous, 4-way, added to (or removed from) the cut mask.
  // The seen buffer can be handed in and reused across many floods (auto sea
  // runs hundreds); the generation stamp makes each flood see it as fresh
  // without a clear. A manual click passes neither and behaves as it always has.
  cutFlood(sx: number, sy: number, v: number, tol: number, pix: Uint8ClampedArray, seen?: Int32Array, gen = 1): number {
    if (!this.inB(sx, sy)) return 0
    const s4 = this.idx(sx, sy) * 4
    const sr = pix[s4]
    const sg = pix[s4 + 1]
    const sb = pix[s4 + 2]
    const sn = seen || new Int32Array(this.W * this.H)
    const q: number[] = [sx, sy]
    let n = 0
    while (q.length) {
      const y = q.pop() as number
      const x = q.pop() as number
      if (!this.inB(x, y)) continue
      const i = this.idx(x, y)
      if (sn[i] === gen) continue
      sn[i] = gen
      const j = i * 4
      if (Math.abs(pix[j] - sr) + Math.abs(pix[j + 1] - sg) + Math.abs(pix[j + 2] - sb) > tol) continue
      if (this.cut[i] !== v) {
        this.cut[i] = v
        n++
      }
      q.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1)
    }
    return n
  }

  // The outer sea in one press. The seed set is computed ONCE, before any
  // flood: every opaque, not-yet-cut pixel on the image border or 4-adjacent
  // to ORIGINAL transparency (alpha 0 in the painting). It never seeds from
  // already-cut pixels and never repeats until stable: the frontier version
  // did both, and reseeding from freshly cut pixels let each flood hand its
  // own edge to the next seed colour, chaining tone to tone until it proposed
  // the whole painting (measured 264k of 264k px, 2026-08-15). Inner tones
  // that never touch the border or the transparency stay for cut-fill clicks.
  // Each flood matches against its own seed colour at the given tolerance,
  // exactly the manual tool, deliberately never chained neighbour to
  // neighbour. The caller owns the undo snapshot, so the run reverts as one.
  autoSea(tol: number, pix: Uint8ClampedArray): number {
    const seeds: number[] = []
    for (let y = 0; y < this.H; y++)
      for (let x = 0; x < this.W; x++) {
        const i = this.idx(x, y)
        if (this.cut[i] || pix[i * 4 + 3] === 0) continue
        // border first, so neighbour reads only happen when all four exist
        const seed =
          x === 0 ||
          y === 0 ||
          x === this.W - 1 ||
          y === this.H - 1 ||
          pix[(i - 1) * 4 + 3] === 0 ||
          pix[(i + 1) * 4 + 3] === 0 ||
          pix[(i - this.W) * 4 + 3] === 0 ||
          pix[(i + this.W) * 4 + 3] === 0
        if (seed) seeds.push(x, y)
      }
    const seen = new Int32Array(this.W * this.H)
    let gen = 0
    let total = 0
    for (let k = 0; k < seeds.length; k += 2) total += this.cutFlood(seeds[k], seeds[k + 1], 1, tol, pix, seen, ++gen)
    return total
  }

  // Coastline residue: after the sea is cut, the anti-aliased fringe leaves
  // floating specks of blended tone too small to hunt down by hand. 4-way
  // connected components over pixels that are opaque and not cut; the largest
  // component is the land and survives, every other component joins the cut.
  despeckle(pix: Uint8ClampedArray): { px: number; specks: number } {
    const { W, H } = this
    const n = W * H
    const land = (i: number) => !this.cut[i] && pix[i * 4 + 3] !== 0
    const comp = new Int32Array(n) // 0 = unlabelled
    const sizes: number[] = [0]
    let labels = 0
    const stack: number[] = []
    for (let s = 0; s < n; s++) {
      if (comp[s] || !land(s)) continue
      const id = ++labels
      let size = 0
      comp[s] = id
      stack.push(s)
      while (stack.length) {
        const i = stack.pop() as number
        size++
        const x = i % W
        if (x > 0 && !comp[i - 1] && land(i - 1)) {
          comp[i - 1] = id
          stack.push(i - 1)
        }
        if (x < W - 1 && !comp[i + 1] && land(i + 1)) {
          comp[i + 1] = id
          stack.push(i + 1)
        }
        if (i >= W && !comp[i - W] && land(i - W)) {
          comp[i - W] = id
          stack.push(i - W)
        }
        if (i < n - W && !comp[i + W] && land(i + W)) {
          comp[i + W] = id
          stack.push(i + W)
        }
      }
      sizes.push(size)
    }
    if (labels <= 1) return { px: 0, specks: 0 }
    let keep = 1
    for (let id = 2; id <= labels; id++) if (sizes[id] > sizes[keep]) keep = id
    let px = 0
    for (let i = 0; i < n; i++)
      if (comp[i] && comp[i] !== keep) {
        this.cut[i] = 1
        px++
      }
    return { px, specks: labels - 1 }
  }

  // One ring off the coast: every opaque, not-cut pixel 4-adjacent to a cut
  // pixel or to original transparency joins the cut. The ring is collected
  // before any pixel is written, otherwise scan order would let a fresh cut
  // qualify its own neighbour and one press would eat more than one ring.
  shaveEdge(pix: Uint8ClampedArray): number {
    const { W, H } = this
    const ring: number[] = []
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = this.idx(x, y)
        if (this.cut[i] || pix[i * 4 + 3] === 0) continue
        const edge =
          (x > 0 && (!!this.cut[i - 1] || pix[(i - 1) * 4 + 3] === 0)) ||
          (x < W - 1 && (!!this.cut[i + 1] || pix[(i + 1) * 4 + 3] === 0)) ||
          (y > 0 && (!!this.cut[i - W] || pix[(i - W) * 4 + 3] === 0)) ||
          (y < H - 1 && (!!this.cut[i + W] || pix[(i + W) * 4 + 3] === 0))
        if (edge) ring.push(i)
      }
    for (const i of ring) this.cut[i] = 1
    return ring.length
  }

  // exact scanline polygon fill, pixel centres, even-odd
  fillPoly(pts: Pt[], v: number, target: 'lvl' | 'occ' | 'cut') {
    if (pts.length < 3) return
    const put =
      target === 'occ'
        ? (x: number, y: number, val: number) => {
            if (this.inB(x, y)) this.occ[this.idx(x, y)] = val
          }
        : target === 'cut'
          ? (x: number, y: number, val: number) => this.setCut(x, y, val)
          : (x: number, y: number, val: number) => this.setPx(x, y, val)
    let miny = 1e9
    let maxy = -1e9
    for (const p of pts) {
      miny = Math.min(miny, p[1])
      maxy = Math.max(maxy, p[1])
    }
    miny = Math.max(0, Math.floor(miny))
    maxy = Math.min(this.H - 1, Math.ceil(maxy))
    for (let y = miny; y <= maxy; y++) {
      const yc = y + 0.5
      const xs: number[] = []
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]
        const [xj, yj] = pts[j]
        if ((yi <= yc && yj > yc) || (yj <= yc && yi > yc))
          xs.push(xi + ((yc - yi) / (yj - yi)) * (xj - xi))
      }
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.ceil(xs[k] - 0.5)
        const b = Math.floor(xs[k + 1] - 0.5)
        for (let x = a; x <= b; x++) put(x, y, v)
      }
    }
  }
  bucket(sx: number, sy: number, v: number) {
    if (!this.inB(sx, sy)) return
    const from = this.lvl[this.idx(sx, sy)]
    if (from === v) return
    const q: number[] = [sx, sy]
    while (q.length) {
      const y = q.pop() as number
      const x = q.pop() as number
      if (!this.inB(x, y) || this.lvl[this.idx(x, y)] !== from) continue
      this.lvl[this.idx(x, y)] = v
      q.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1)
    }
  }
  addOccluder(pts: Pt[]): Occluder {
    const id = this.occNext++
    let maxy = 0
    for (const p of pts) maxy = Math.max(maxy, p[1])
    this.fillPoly(pts, id, 'occ')
    const o: Occluder = { id, baseline: Math.round(maxy) }
    this.occs.push(o)
    return o
  }

  // ---- SEAM HEAL --------------------------------------------------------
  // Two polygons drawn as two independent outlines do not tile exactly: where
  // their vertex chains disagree by a fraction of a pixel, a 1px row of 0
  // survives between them. It is invisible below 6x and it hard-blocks the
  // character, because his hip probes sit 2px out from his feet. This closes
  // any blocked pixel pinched between two walkable pixels whose levels are a
  // legal step apart, so a real wall (a level difference over the tolerance,
  // or a gap thicker than one pixel) is never eaten.
  healSeams(tol = 10) {
    let filled = 0
    let pass = 0
    for (pass = 0; pass < 3; pass++) {
      const before = filled
      const copy = this.lvl.slice()
      for (let y = 1; y < this.H - 1; y++)
        for (let x = 1; x < this.W - 1; x++) {
          const i = this.idx(x, y)
          if (copy[i] !== 0) continue
          const pairs = [
            [copy[i - 1], copy[i + 1]],
            [copy[i - this.W], copy[i + this.W]],
          ]
          for (const [a, b] of pairs) {
            if (a > 0 && b > 0 && Math.abs(a - b) <= tol) {
              this.lvl[i] = Math.abs(a - b) === 0 ? a : Math.min(a, b)
              filled++
              break
            }
          }
        }
      if (filled === before) break
    }
    return { filled, passes: pass + 1 }
  }

  markHit(x: number, y: number) {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (this.inB(xi, yi)) this.hits[this.idx(xi, yi)] = Math.min(255, this.hits[this.idx(xi, yi)] + 1)
  }

  stats() {
    let walkable = 0
    let cut = 0
    for (let i = 0; i < this.lvl.length; i++) {
      if (this.lvl[i]) walkable++
      if (this.cut[i]) cut++
    }
    return { walkable, pct: (100 * walkable) / this.lvl.length, cut }
  }

  // ---- export -----------------------------------------------------------
  // every ramp value becomes a named region with its bbox. The runtime does
  // not need this (the level values carry the law) but the game does, for
  // footstep sounds, camera, "you are on the stair" logic.
  stairRegions(): StairRegion[] {
    const out: StairRegion[] = []
    for (const rv of [50, 70, 90]) {
      const seen = new Uint8Array(this.W * this.H)
      for (let y = 0; y < this.H; y++)
        for (let x = 0; x < this.W; x++) {
          const i = this.idx(x, y)
          if (this.lvl[i] !== rv || seen[i]) continue
          let minx = x
          let maxx = x
          let miny = y
          let maxy = y
          let n = 0
          const q: number[] = [x, y]
          while (q.length) {
            const cy = q.pop() as number
            const cx = q.pop() as number
            if (!this.inB(cx, cy)) continue
            const j = this.idx(cx, cy)
            if (seen[j] || this.lvl[j] !== rv) continue
            seen[j] = 1
            n++
            minx = Math.min(minx, cx)
            maxx = Math.max(maxx, cx)
            miny = Math.min(miny, cy)
            maxy = Math.max(maxy, cy)
            q.push(cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1)
          }
          if (n > 6) out.push({ value: rv, connects: [rv - 10, rv + 10], rect: [minx, miny, maxx, maxy], px: n })
        }
    }
    return out
  }

  // cut pixels export as blocked: the sea is never walkable
  levelsCanvas(cut?: Uint8Array): HTMLCanvasElement {
    const c = mkCanvas(this.W, this.H)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    const d = g.createImageData(this.W, this.H)
    for (let i = 0; i < this.lvl.length; i++) {
      const v = cut && cut[i] ? 0 : this.lvl[i]
      d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = v
      d.data[i * 4 + 3] = 255
    }
    g.putImageData(d, 0, 0)
    return c
  }
  cutCanvas(): HTMLCanvasElement {
    const c = mkCanvas(this.W, this.H)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    const d = g.createImageData(this.W, this.H)
    for (let i = 0; i < this.cut.length; i++) {
      const v = this.cut[i] ? 255 : 0
      d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = v
      d.data[i * 4 + 3] = 255
    }
    g.putImageData(d, 0, 0)
    return c
  }
  occludersCanvas(): HTMLCanvasElement {
    const c = mkCanvas(this.W, this.H)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    const d = g.createImageData(this.W, this.H)
    for (let i = 0; i < this.occ.length; i++) {
      d.data[i * 4] = this.occ[i]
      d.data[i * 4 + 1] = this.occ[i] ? 255 : 0
      d.data[i * 4 + 2] = 0
      d.data[i * 4 + 3] = 255
    }
    g.putImageData(d, 0, 0)
    return c
  }

  importLevels(image: HTMLImageElement | HTMLCanvasElement) {
    const w = 'naturalWidth' in image ? image.naturalWidth : image.width
    const h = 'naturalHeight' in image ? image.naturalHeight : image.height
    const c = mkCanvas(w, h)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.drawImage(image, 0, 0)
    const d = g.getImageData(0, 0, w, h).data
    this.snap()
    for (let y = 0; y < this.H; y++)
      for (let x = 0; x < this.W; x++) {
        const sx = Math.floor((x * w) / this.W)
        const sy = Math.floor((y * h) / this.H)
        this.lvl[this.idx(x, y)] = d[(sy * w + sx) * 4]
      }
  }

  importOccluders(image: HTMLImageElement, occs: Occluder[]) {
    const c = mkCanvas(this.W, this.H)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.drawImage(image, 0, 0)
    const d = g.getImageData(0, 0, this.W, this.H).data
    for (let i = 0; i < this.occ.length; i++) this.occ[i] = d[i * 4]
    this.occs = occs.slice()
    this.occNext = occs.reduce((m, o) => Math.max(m, o.id), 0) + 1
  }

  importCut(image: HTMLImageElement) {
    const c = mkCanvas(this.W, this.H)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.drawImage(image, 0, 0)
    const d = g.getImageData(0, 0, this.W, this.H).data
    for (let i = 0; i < this.cut.length; i++) this.cut[i] = d[i * 4] > 127 ? 1 : 0
  }

  // levels + occluders + cut packed for the silent local autosave, wrapped in
  // json so the placed assets and events ride along. v3 adds the canvas size,
  // the base painting's size and offset (so a grown map re-grows on reload)
  // and the spawn. A v2 save is the same envelope without them; an old save
  // is the bare base64 (two planes, or three). All shapes load; a payload
  // without events loads with none.
  serialize(): string {
    return JSON.stringify({
      v: 3,
      w: this.W,
      h: this.H,
      base: { w: this.bw, h: this.bh, ox: this.ox, oy: this.oy },
      spawn: this.spawn,
      m: this.pack(),
      assets: this.assets,
      assetNext: this.assetNext,
      events: this.events,
      eventNext: this.eventNext,
    })
  }
  private pack(): string {
    const b = new Uint8Array(this.lvl.length * 3)
    b.set(this.lvl, 0)
    b.set(this.occ, this.lvl.length)
    b.set(this.cut, this.lvl.length * 2)
    let s = ''
    const CH = 0x8000
    for (let i = 0; i < b.length; i += CH) s += String.fromCharCode(...b.subarray(i, i + CH))
    return btoa(s)
  }
  deserialize(data: string) {
    if (data.startsWith('{')) {
      try {
        const d = JSON.parse(data) as {
          m?: string
          assets?: PlacedAsset[]
          assetNext?: number
          events?: MapEvent[]
          eventNext?: number
          spawn?: Pt
        }
        if (!this.unpack(String(d.m || ''))) return false
        // v2 assets carry only `scale`; the migration fills the transform
        this.assets = Array.isArray(d.assets) ? d.assets.map(migrateAsset) : []
        this.assetNext = typeof d.assetNext === 'number' ? d.assetNext : this.assets.length + 1
        // an older payload has no events and loads with none
        this.events = Array.isArray(d.events) ? d.events.map(migrateEvent) : []
        this.eventNext =
          typeof d.eventNext === 'number'
            ? d.eventNext
            : this.events.reduce((m, e) => Math.max(m, e.id), 0) + 1
        if (Array.isArray(d.spawn) && d.spawn.length === 2 && isFinite(d.spawn[0]) && isFinite(d.spawn[1]))
          this.spawn = [Math.round(d.spawn[0]), Math.round(d.spawn[1])]
        return true
      } catch {
        return false
      }
    }
    return this.unpack(data)
  }
  private unpack(data: string) {
    const s = atob(data)
    const n = this.lvl.length
    if (s.length !== n * 2 && s.length !== n * 3) return false
    for (let i = 0; i < n; i++) {
      this.lvl[i] = s.charCodeAt(i)
      this.occ[i] = s.charCodeAt(n + i)
      this.cut[i] = s.length === n * 3 ? s.charCodeAt(n * 2 + i) : 0
    }
    let max = 0
    for (let i = 0; i < n; i++) if (this.occ[i] > max) max = this.occ[i]
    if (max && !this.occs.length) {
      for (let id = 1; id <= max; id++) {
        let baseline = 0
        for (let y = 0; y < this.H; y++)
          for (let x = 0; x < this.W; x++) if (this.occ[this.idx(x, y)] === id) baseline = Math.max(baseline, y)
        this.occs.push({ id, baseline })
      }
      this.occNext = max + 1
    }
    return true
  }
}

export function mkCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

export function bresenham(x0: number, y0: number, x1: number, y1: number, fn: (x: number, y: number) => void) {
  const dx = Math.abs(x1 - x0)
  const sx = x0 < x1 ? 1 : -1
  const dy = -Math.abs(y1 - y0)
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  for (;;) {
    fn(x0, y0)
    if (x0 === x1 && y0 === y1) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x0 += sx
    }
    if (e2 <= dx) {
      err += dx
      y0 += sy
    }
  }
}
