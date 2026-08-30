/* THE OCEAN, WHICH IS THE ONE SURFACE THAT HAD NO AUTHOR.
 *
 * Everything MAPVIS can mark is at an x,y inside one painting's pixel raster.
 * A document cannot exist without a painting, anchor creation refuses a click
 * outside the canvas, and growing the canvas to buy room for a mooring changes
 * w/h, which the game fits its camera from, so it zooms the island out. The
 * water between the islands was therefore the one place nothing could be
 * placed, and every fact about it lived as a constant in the game repo.
 *
 * This is that surface. It is not a map and it has no painting of its own: a
 * coordinate space with maps placed on it, drawn as a chart of an ocean rather
 * than as a form with numbers in it, because where an island sits relative to
 * every other island is a thing you judge by looking.
 *
 * THE ISLANDS ARE DRAWN AS THEMSELVES, and the first pass of this page did not
 * do that. It drew every place as a featureless rectangle, so the one job the
 * chart has, putting a berth against the dock a ship ties up at, was impossible:
 * the dock is painted into the island's own picture and the chart was not
 * showing the picture. Ash's verdict on that was "i have no idea where
 * specifically to place the berth". So each place now draws its published
 * scene.png into its footprint, with the map's own anchors on top of it, and the
 * chart zooms and pans, because the ocean is 4096 across and an island is 64 and
 * at full extent it is a speck you cannot aim at.
 *
 * NO AUTOSAVE, unlike a map document. There is one world row shared by every
 * map on the platform, so a half-finished drag is not something to write into
 * the thing a whole class sails. Saving is a press, and what comes back is what
 * the server kept, warnings and all.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, go } from './router'
import { useSession } from './session'
import { anchorName, isAnchorName } from '../core/mask'
import './world.css'

type Pt = { x: number; y: number; facing?: string; at?: string }

/* The shape the server keeps, field for field. cleanPlace is the authority and
 * this mirrors it rather than adding to it: a field invented here would be
 * dropped on the way in and would read as a control that does nothing. */
type Place = {
  name: string
  /* the roster id, which is NOT the address above. The game looks a slot up by
   * this and counts a visit under it, and it is kebab-case where a name is a
   * python identifier, so the two can never be one field. */
  place?: string
  map: string
  title: string
  x: number
  y: number
  w: number
  h: number
  state: string
  /* two radii, and they were one. `discover` is how close the hull comes before
   * this island is found; `release` is how far out its bundle stays decoded,
   * which is what gets trimmed first on a 4 GB chromebook. */
  discover: number
  release: number
  berth?: Pt
  approach?: Pt
  meta?: Record<string, unknown>
}
type Region = { name: string; kind: string; rect: [number, number, number, number]; label?: string }
/* marks is carried and never read here. The world row grew a third list while
 * this page was open, and a save that posts only what it knows about is a save
 * that deletes everything it does not, so it rides along untouched rather than
 * being dropped on the floor by a page that has no control for it. */
/* `home` is the slot a run with no vessel record starts in and the one a
 * graduate is handed back to. One name for the whole ocean, and the game had it
 * as a constant because nothing here could say it. */
type Doc = { w: number; h: number; places: Place[]; regions: Region[]; marks?: unknown; home?: string }

/* What the registry hands back for one map. The x,y on an anchor is in that
 * map's OWN pixel raster, the same raster scene.png is published at, which is
 * what makes it drawable on this chart at all. */
type Anchor = { name: string; kind: string; x: number; y: number; r?: number; to?: string; label?: string }
type MapRow = { slug: string; w: number; h: number; version: number | null; anchors?: Anchor[] }

type Sel = { kind: 'place' | 'region'; i: number } | null
type Hit = { kind: 'place' | 'berth' | 'approach' | 'size' | 'region'; i: number } | null
type Band = { x0: number; y0: number; x1: number; y1: number } | null
type Tool = 'move' | 'place' | 'sea'
type Pick = '' | 'berth' | 'approach'
type Fit = { s: number; ox: number; oy: number }

/* ONE INK PER STATE, and the ramp is the journey: unknown is cold and grey,
 * the one you are in is gold, the one that is over goes back down to a dull
 * bronze. The names come from the server, not from here, so a state added there
 * still draws with the fallback rather than disappearing. */
const STATE_INK: Record<string, string> = {
  rumour: '#5b6470',
  rising: '#b04a2f',
  misty: '#6f8296',
  discovered: '#8fa6bb',
  available: '#4f9b84',
  active: '#d4a53c',
  completed: '#8a6a1f',
}
const SEA_INK: Record<string, string> = {
  sailable: '#1d2c3c',
  shallow: '#2b5a55',
  forbidden: '#4a1f16',
  mist: '#3b4654',
  ambience: '#3a3252',
}
/* the six anchor kinds mask.ts allows, each its own ink, because the whole
 * reason to draw them here is to tell a door apart from a spawn at a glance
 * while you are aiming a berth at one of them */
const ANCHOR_INK: Record<string, string> = {
  door: '#e2734a',
  post: '#6fc2a6',
  spawn: '#7fa8d8',
  trigger: '#b07acc',
  region: '#d4a53c',
  point: '#c8d2dd',
}
const inkFor = (m: Record<string, string>, k: string) => m[k] || '#5b6470'

const LABEL = '500 11px "Archivo Narrow", sans-serif'
const MONO = '400 9px "Martian Mono", monospace'
const TINY = '400 8.5px "Martian Mono", monospace'
const PAD = 36

// as far out as fitting the whole ocean, and as far in as one painted pixel
// filling a fat screen pixel. Anything past that is not more information.
const MAX_S = 48
const SNAP = 11

/* ONE SIZE EVERY NEW ISLAND IS BORN AT.
 *
 * A place used to be born 64x64 and then have its height bent to whatever
 * painting was chosen afterwards, so how big an island came out depended on
 * which map you picked and no two of them started the same. The long side is
 * fixed here instead and the short side follows the painting, which is the
 * shape rule this page already holds everywhere else. 96 against a 4096 ocean
 * is small enough that a dozen fit and big enough to aim a berth at. */
const ISLAND_DEFAULT = 96
/* and the fences either side of it. Both were reachable with the handle: the
 * old resize collapsed the footprint to a single unit on the first frame of a
 * grab, and nothing at all stopped it swallowing a quarter of the chart. */
const ISLAND_MIN = 16
const ISLAND_MAX = 1024

/* HOW MUCH THE FOOTPRINT MOVES FOR A DRAG THE WIDTH OF THE ISLAND: half, and
 * a shifted eighth for the last few units.
 *
 * The delta behind it is measured in SCREEN pixels over the island's SCREEN
 * size. Measured in world units, which is what the old branch did, the same
 * hand movement was worth five times more with the whole ocean on the stage
 * than it was zoomed in on a jetty, so the handle behaved differently
 * depending on where you happened to be looking. */
const RESIZE_GAIN = 0.5
const RESIZE_FINE = 0.12
// the grab radius of the corner handle, and half the square it is drawn as, so
// the hot spot and the picture of it cannot drift apart
const GRIP = 9

const NUDGE_FAR = 8
const UNDO_DEEP = 40
// how far the view walks toward where it was sent, per frame
const EASE = 0.22

const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/* how far apart the graticule sits. It has to follow the ZOOM and not the
 * ocean's width: ruled off doc.w alone the lines were 512 world units apart,
 * which at any useful zoom is one line somewhere off the edge of the stage and
 * a chart that looks unruled exactly when you are trying to place something
 * precisely. Powers of two by construction, because every other number in this
 * project is one. */
const grat = (s: number) => {
  let v = 4096
  while (v * s > 130 && v > 1) v /= 2
  while (v * s < 46) v *= 2
  return v
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const side = (n: number) => clamp(Math.round(n), ISLAND_MIN, ISLAND_MAX)
const freeName = (stem: string, taken: string[]) => {
  let n = 1
  while (taken.includes(`${stem}_${n}`)) n++
  return `${stem}_${n}`
}

// the footprint a place is born with, and the one it takes when a painting is
// chosen for it: the long side at the default, the short side off the painting
const bornAs = (m?: MapRow) => {
  if (!m || m.w <= 0 || m.h <= 0) return { w: ISLAND_DEFAULT, h: ISLAND_DEFAULT }
  return m.w >= m.h
    ? { w: ISLAND_DEFAULT, h: side((ISLAND_DEFAULT * m.h) / m.w) }
    : { w: side((ISLAND_DEFAULT * m.w) / m.h), h: ISLAND_DEFAULT }
}

/* WHERE THE PAINTING ACTUALLY IS INSIDE ITS OWN RASTER.
 *
 * The hub is published 688x640 and only rows 194 to 570 of it hold an opaque
 * pixel, because growCanvas adds transparent margin and never picture. So the
 * footprint rectangle, which is the whole raster, was a box with a third of it
 * empty and Ash could not tell whether the line meant the island or something
 * around it.
 *
 * The rectangle stays the truth for coordinates, so it stays on the chart as
 * four faint corner ticks. The line you read as the island is drawn around the
 * pixels instead. Scanned once per picture and kept, at 128 across, because a
 * full alpha read on every repaint is a repaint you can feel. */
type Skin = { x0: number; y0: number; x1: number; y1: number }
const WHOLE: Skin = { x0: 0, y0: 0, x1: 1, y1: 1 }
const skins = new Map<string, Skin>()

const skinOf = (key: string, img: HTMLImageElement): Skin => {
  const had = skins.get(key)
  if (had) return had
  const w = Math.max(1, Math.min(128, img.naturalWidth))
  const h = Math.max(1, Math.round((w * img.naturalHeight) / Math.max(1, img.naturalWidth)))
  let out = WHOLE
  try {
    const off = document.createElement('canvas')
    off.width = w
    off.height = h
    const c = off.getContext('2d', { willReadFrequently: true })
    if (c) {
      c.drawImage(img, 0, 0, w, h)
      const d = c.getImageData(0, 0, w, h).data
      let x0 = w
      let y0 = h
      let x1 = -1
      let y1 = -1
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (d[(y * w + x) * 4 + 3] > 8) {
            if (x < x0) x0 = x
            if (y < y0) y0 = y
            if (x > x1) x1 = x
            if (y > y1) y1 = y
          }
      if (x1 >= 0) out = { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h }
    }
  } catch {
    // a picture served from another origin taints the canvas and getImageData
    // throws. The whole raster is then the honest answer rather than a guess.
  }
  skins.set(key, out)
  return out
}

/* FIT WHAT IS ON THE WATER, NOT THE WATER.
 *
 * This fitted the whole 4096 ocean, which is right arithmetic and the wrong
 * picture: an island is about sixty units across, so the one thing on the chart
 * opened as an eleven pixel speck on an empty grid and the page looked exactly
 * like the featureless grid it was rebuilt to stop being. Nothing in the
 * default view suggested there were paintings in there at all, and finding out
 * took a deliberate scroll-zoom nobody would think to perform.
 *
 * So the default frames the places, with their berths and approaches, and falls
 * back to the whole ocean only when there is genuinely nothing placed yet. The
 * margin is generous rather than tight because an author needs somewhere to
 * drag a new island to. */
const contentBox = (doc: Doc) => {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of doc.places) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x + p.w)
    y1 = Math.max(y1, p.y + p.h)
    for (const m of [p.berth, p.approach]) {
      if (!m) continue
      x0 = Math.min(x0, m.x)
      y0 = Math.min(y0, m.y)
      x1 = Math.max(x1, m.x)
      y1 = Math.max(y1, m.y)
    }
  }
  for (const r of doc.regions) {
    const [a, b, c, d] = r.rect
    x0 = Math.min(x0, a, c)
    y0 = Math.min(y0, b, d)
    x1 = Math.max(x1, a, c)
    y1 = Math.max(y1, b, d)
  }
  if (!isFinite(x0)) return null
  // half an island of air on every side, so there is water to drag into
  const padX = Math.max(48, (x1 - x0) * 0.6)
  const padY = Math.max(48, (y1 - y0) * 0.6)
  return { x: x0 - padX, y: y0 - padY, w: x1 - x0 + padX * 2, h: y1 - y0 + padY * 2 }
}

const fitOf = (doc: Doc, size: { w: number; h: number }): Fit => {
  if (!size.w || !size.h) return { s: 1, ox: 0, oy: 0 }
  const box = contentBox(doc) || { x: 0, y: 0, w: doc.w, h: doc.h }
  const s = Math.min((size.w - PAD * 2) / box.w, (size.h - PAD * 2) / box.h)
  return { s, ox: size.w / 2 - (box.x + box.w / 2) * s, oy: size.h / 2 - (box.y + box.h / 2) * s }
}

const FACE_GRID = [
  ['north-west', 'north', 'north-east'],
  ['west', '', 'east'],
  ['south-west', 'south', 'south-east'],
]
const FACE_ARROW = '↖↑↗←·→↙↓↘'

/* Where one map's anchor lands on the ocean.
 *
 * Through the REGISTRY's w/h and not through the loaded png's natural size,
 * even though today they are the same 688x640. The registry row is live and the
 * png is a published version, so a map grown since its last publish would put
 * the anchors in one space and the picture in another. Mapping both through the
 * same numbers keeps the dots on the picture whatever happens; when the two
 * disagree the picture stretches, which is visible, instead of the dots
 * drifting, which is not. */
const anchorAt = (p: Place, m: MapRow, a: Anchor) => ({
  x: p.x + (a.x / Math.max(1, m.w)) * p.w,
  y: p.y + (a.y / Math.max(1, m.h)) * p.h,
})

/* ---- the chart ----------------------------------------------------------- */

type Art = Map<string, HTMLImageElement>
type Scene = {
  doc: Doc
  fit: Fit
  sel: Sel
  hover: Hit
  band: Band
  reg: Map<string, MapRow>
  art: Art
  marks: boolean
  aim: string
  warm: number
}

function paint(c: CanvasRenderingContext2D, size: { w: number; h: number }, sc: Scene) {
  const { doc, fit, sel, hover, band, reg, art, marks, aim, warm } = sc
  const X = (x: number) => fit.ox + x * fit.s
  const Y = (y: number) => fit.oy + y * fit.s

  // a label sitting on a painting was unreadable, so every word on this chart
  // gets a dark rim first and the fill second
  const say = (t: string, x: number, y: number, fill: string) => {
    c.lineJoin = 'round'
    c.lineWidth = 3
    c.strokeStyle = 'rgba(7,11,17,0.9)'
    c.strokeText(t, x, y)
    c.lineWidth = 1
    c.fillStyle = fill
    c.fillText(t, x, y)
  }

  c.fillStyle = '#070b11'
  c.fillRect(0, 0, size.w, size.h)
  c.fillStyle = '#0b111a'
  c.fillRect(X(0), Y(0), doc.w * fit.s, doc.h * fit.s)

  // the graticule, which is the whole reason this reads as a chart and not as
  // a dark box with rectangles on it. Only the part of it the stage can see:
  // at full zoom the whole ocean is 4096/8 lines and drawing them all is work
  // thrown away against the clip.
  const step = grat(fit.s)
  const gx0 = Math.max(0, Math.floor((0 - fit.ox) / fit.s / step) * step)
  const gx1 = Math.min(doc.w, (size.w - fit.ox) / fit.s)
  const gy0 = Math.max(0, Math.floor((0 - fit.oy) / fit.s / step) * step)
  const gy1 = Math.min(doc.h, (size.h - fit.oy) / fit.s)
  c.strokeStyle = 'rgba(212,165,60,0.075)'
  c.lineWidth = 1
  c.beginPath()
  for (let x = Math.max(step, gx0); x < gx1; x += step) {
    c.moveTo(Math.round(X(x)) + 0.5, Math.max(0, Y(0)))
    c.lineTo(Math.round(X(x)) + 0.5, Math.min(size.h, Y(doc.h)))
  }
  for (let y = Math.max(step, gy0); y < gy1; y += step) {
    c.moveTo(Math.max(0, X(0)), Math.round(Y(y)) + 0.5)
    c.lineTo(Math.min(size.w, X(doc.w)), Math.round(Y(y)) + 0.5)
  }
  c.stroke()

  // sea regions sit under everything, because they are what the water IS and
  // an island is a thing on top of it
  for (const r of doc.regions) {
    const [x0, y0, x1, y1] = r.rect
    const rx = X(Math.min(x0, x1))
    const ry = Y(Math.min(y0, y1))
    const rw = Math.abs(x1 - x0) * fit.s
    const rh = Math.abs(y1 - y0) * fit.s
    const tint = inkFor(SEA_INK, r.kind)
    c.fillStyle = tint
    c.globalAlpha = 0.42
    c.fillRect(rx, ry, rw, rh)
    c.globalAlpha = 1
    c.setLineDash([5, 4])
    c.strokeStyle = tint
    c.strokeRect(rx + 0.5, ry + 0.5, rw, rh)
    c.setLineDash([])
    c.font = MONO
    say(`${r.name} · ${r.kind}`, rx + 6, ry + 13, 'rgba(216,227,238,0.6)')
  }

  /* TWO PASSES OVER THE ISLANDS, and the split is the point.
   *
   * Everything painted goes down first and everything you aim with goes on top,
   * so a neighbouring island's picture can never cover the berth diamond you are
   * trying to drag. One pass had the rectangle drawn over its own release ring
   * already; with a whole painting in that rectangle it would have swallowed the
   * marks outright. */
  /* THE FOOTPRINT ON SCREEN, THROUGH ONE READER.
   *
   * The drawing floored the rectangle at three pixels and the hit test did
   * not, so a long way out the gold square you could see and the square that
   * answered a press were in different places. Both go through this now. */
  const boxOf = (p: Place) => ({
    px: X(p.x),
    py: Y(p.y),
    rw: Math.max(3, p.w * fit.s),
    rh: Math.max(3, p.h * fit.s),
  })

  // and the part of it the eye reads as the island: the painted pixels when
  // the picture is here, the whole footprint when it is not
  const skinIn = (p: Place, key: string, img?: HTMLImageElement) => {
    const b = boxOf(p)
    if (!img || !img.complete || !img.naturalWidth) return b
    const s = skinOf(key, img)
    return { px: b.px + s.x0 * b.rw, py: b.py + s.y0 * b.rh, rw: (s.x1 - s.x0) * b.rw, rh: (s.y1 - s.y0) * b.rh }
  }

  const shot = (i: number) => {
    const p = doc.places[i]
    const m = p.map ? reg.get(p.map) : undefined
    const key = m && m.version ? `${p.map}@${m.version}` : ''
    const img = key ? art.get(key) : undefined
    const { px, py, rw, rh } = boxOf(p)
    const on = sel?.kind === 'place' && sel.i === i
    const lit = on || (hover?.i === i && hover.kind !== 'region')
    const tint = inkFor(STATE_INK, p.state)

    if (img && img.complete && img.naturalWidth) {
      /* AT CHART SCALE THE PAINTING IS BACKED BY THE STATE INK, and only there.
       *
       * A 688 wide island sampled into fourteen screen pixels is a grey smudge
       * you cannot find, and the whole ocean fitted on a laptop is the view the
       * page opens in. Under about twenty six pixels the block of state colour
       * is the more useful drawing and the painting rides on top of it; past
       * that the tint comes off entirely, because a wash at even a tenth covers
       * the transparent sea the island is cut out of and turns the hub into a
       * green box with a coastline you can no longer see the edge of. */
      const tiny = rw < 26
      if (tiny) {
        c.globalAlpha = lit ? 0.75 : 0.55
        c.fillStyle = tint
        c.fillRect(px, py, rw, rh)
        c.globalAlpha = 1
      }
      // nearest neighbour on the way up, because it is pixel art and smoothing
      // it turns a jetty into a smudge. Smoothing on the way down, because a
      // 688 wide painting sampled into 14 screen pixels with nearest is noise.
      c.imageSmoothingEnabled = rw < img.naturalWidth
      c.drawImage(img, px, py, rw, rh)
      c.imageSmoothingEnabled = true
    } else {
      c.fillStyle = tint
      c.globalAlpha = lit ? 0.3 : 0.18
      c.fillRect(px, py, rw, rh)
      c.globalAlpha = 1
    }

    /* THE OUTLINE GOES ROUND THE PICTURE, NOT ROUND THE RASTER.
     *
     * A third of the hub's published png is transparent margin, so the line
     * drawn on the footprint stood a long way off the coast at the top and the
     * bottom and it was not clear what it was meant to be around. The footprint
     * is still where the coordinates live and it is drawn, faintly, in rig.
     *
     * An empty slot keeps the dashed line, because it is a position the chart
     * is holding open and not a coast anybody has painted. */
    const seen = skinIn(p, key, img)
    c.setLineDash(p.map ? [] : [4, 3])
    c.strokeStyle = on ? '#f0c869' : tint
    c.globalAlpha = on ? 0.55 + 0.45 * warm : lit ? 0.85 : 0.6
    c.lineWidth = on ? 1 + warm : 1
    c.strokeRect(seen.px + 0.5, seen.py + 0.5, seen.rw, seen.rh)
    c.globalAlpha = 1
    c.lineWidth = 1
    c.setLineDash([])
  }

  const rig = (i: number) => {
    const p = doc.places[i]
    const m = p.map ? reg.get(p.map) : undefined
    const key = m && m.version ? `${p.map}@${m.version}` : ''
    const img = key ? art.get(key) : undefined
    const drawn = !!img?.naturalWidth
    const on = sel?.kind === 'place' && sel.i === i
    const lit = on || (hover?.i === i && hover.kind !== 'region')
    const tint = inkFor(STATE_INK, p.state)
    const { px, py, rw, rh } = boxOf(p)
    const seen = skinIn(p, key, img)

    /* THE RING IS DRAWN FROM x,y AND NOT FROM THE MIDDLE OF THE RECTANGLE.
     * checkWorld measures the berth distance with hypot(berth - x,y), so a ring
     * drawn around the centre would be a picture of a rule nobody enforces and
     * an author would trust it and get a warning anyway. The cross under it
     * says where the number is measured from. */
    c.beginPath()
    c.arc(px, py, p.release * fit.s, 0, Math.PI * 2)
    c.strokeStyle = tint
    c.globalAlpha = lit ? 0.5 : 0.22
    c.setLineDash([3, 5])
    c.stroke()
    c.setLineDash([])
    c.globalAlpha = 1

    /* THE CROSS ONLY WHILE THE ISLAND IS UNDER THE HAND.
     *
     * Once the outline moved onto the painting, this was a plus sign floating
     * in open water a long way above the coast, because x,y is the corner of
     * the raster and the raster carries transparent margin along its top. On an
     * island nobody is working on, the ring is already centred on it and that is
     * enough; the corner ticks below say the rest. */
    if (lit) {
      c.strokeStyle = tint
      c.globalAlpha = on ? 1 : 0.6
      c.beginPath()
      c.moveTo(px - 5, py)
      c.lineTo(px + 5, py)
      c.moveTo(px, py - 5)
      c.lineTo(px, py + 5)
      c.stroke()
      c.globalAlpha = 1
    }

    /* THE FOOTPRINT, ONLY WHILE IT IS THE THING IN YOUR HAND.
     *
     * Four corner ticks rather than a rectangle. The rectangle is what a berth
     * distance and a release radius are measured against, so it has to be
     * visible while you are sizing one, and it is the wrong thing to have a
     * hard line around the rest of the time because the coast is inside it. */
    if (on) {
      const t = Math.min(11, rw / 3, rh / 3)
      c.strokeStyle = '#f0c869'
      c.globalAlpha = 0.45 * warm
      c.beginPath()
      for (const [cx, sx] of [
        [px, 1],
        [px + rw, -1],
      ] as const)
        for (const [cy, sy] of [
          [py, 1],
          [py + rh, -1],
        ] as const) {
          c.moveTo(cx + sx * t, cy)
          c.lineTo(cx, cy)
          c.lineTo(cx, cy + sy * t)
        }
      c.stroke()
      c.globalAlpha = 1
      // and what it is worth, once, so release and berth have a size beside
      // them rather than being two numbers in a form
      c.font = TINY
      say(`${p.w}×${p.h}`, px + rw + 6, py + rh + 4, 'rgba(240,200,105,0.75)')
    }

    /* THE MARKS THE MAP ITSELF CARRIES, which is the thing a berth is aimed at.
     *
     * Held back until the island is wide enough on screen to tell one from
     * another. Nine dots crowded into fourteen pixels is not a dock you can
     * point at, it is a smear that hides the coast. */
    if (m && marks && rw > 54) {
      const named = rw > 130
      for (const a of m.anchors || []) {
        const w = anchorAt(p, m, a)
        const ax = X(w.x)
        const ay = Y(w.y)
        const key = `${p.name}/${a.name}`
        const hot = aim === key
        const ink = inkFor(ANCHOR_INK, a.kind)
        // its reach, when it has one, in the map's own pixels scaled onto the
        // ocean, so a door with r 14 reads as the area it really covers
        if (a.r) {
          c.beginPath()
          c.arc(ax, ay, (a.r / Math.max(1, m.w)) * p.w * fit.s, 0, Math.PI * 2)
          c.strokeStyle = ink
          c.globalAlpha = 0.3
          c.stroke()
          c.globalAlpha = 1
        }
        c.beginPath()
        c.arc(ax, ay, hot ? 6 : 3.6, 0, Math.PI * 2)
        c.lineWidth = 3
        c.strokeStyle = 'rgba(7,11,17,0.9)'
        c.stroke()
        c.lineWidth = hot ? 2 : 1.4
        c.strokeStyle = hot ? '#f0c869' : ink
        c.stroke()
        c.lineWidth = 1
        if (named || hot) {
          c.font = TINY
          say(a.label || a.name, ax + 8, ay + 3, hot ? '#f0c869' : ink)
        }
      }
    }

    /* A berth and an approach are separate marks tied back to the island they
     * belong to, so a chart full of them still says which is whose.
     *
     * Only while that island is under the hand, for the same reason the cross
     * is: the tether starts at x,y, and x,y is the corner of a raster with
     * transparent margin along its top, so on an island nobody is touching this
     * was a faint diagonal that began in open water well off the coast. The
     * diamond at the far end already says where the berth is. */
    for (const k of lit ? [p.approach, p.berth] : []) {
      if (!k) continue
      c.beginPath()
      c.moveTo(px, py)
      c.lineTo(X(k.x), Y(k.y))
      c.strokeStyle = tint
      c.globalAlpha = 0.35
      c.stroke()
      c.globalAlpha = 1
      /* HOW LONG THE TETHER IS, ON THE TETHER.
       * checkWorld measures a berth against the release radius and both are in
       * world units, and there was nothing anywhere on this page saying what a
       * world unit looks like. The number on the line it belongs to costs one
       * label and answers it where you are already looking. */
      if (on) {
        c.font = TINY
        // two thirds of the way out rather than halfway, because halfway on a
        // short tether is on top of the island the tether starts at
        say(String(Math.round(Math.hypot(k.x - p.x, k.y - p.y))), px + (X(k.x) - px) * 0.66 + 5, py + (Y(k.y) - py) * 0.66 - 3, 'rgba(216,227,238,0.5)')
      }
    }
    if (p.approach) {
      const ax = X(p.approach.x)
      const ay = Y(p.approach.y)
      c.beginPath()
      c.arc(ax, ay, 5, 0, Math.PI * 2)
      c.lineWidth = 3.4
      c.strokeStyle = 'rgba(7,11,17,0.9)'
      c.stroke()
      c.lineWidth = 1.4
      c.strokeStyle = '#8fa6bb'
      c.stroke()
      c.lineWidth = 1
    }
    if (p.berth) {
      /* DRAWN IN SCREEN PIXELS, WITH A RIM, AT EVERY ZOOM.
       * The mark exists to be aimed and then found again. Sized in world units
       * it is a grain of sand fitted out and a dinner plate zoomed in, and laid
       * flat on a painting with no rim it disappears into whatever colour the
       * jetty happens to be. */
      const bx = X(p.berth.x)
      const by = Y(p.berth.y)
      const face = p.berth.facing || ''
      const dx = face.includes('east') ? 1 : face.includes('west') ? -1 : 0
      const dy = face.includes('south') ? 1 : face.includes('north') ? -1 : 0
      if (dx || dy) {
        c.beginPath()
        c.moveTo(bx, by)
        c.lineTo(bx + dx * 15, by + dy * 15)
        c.lineWidth = 4
        c.strokeStyle = 'rgba(7,11,17,0.9)'
        c.stroke()
        c.lineWidth = 1.6
        c.strokeStyle = '#f0c869'
        c.stroke()
        c.lineWidth = 1
      }
      c.beginPath()
      c.moveTo(bx, by - 6)
      c.lineTo(bx + 6, by)
      c.lineTo(bx, by + 6)
      c.lineTo(bx - 6, by)
      c.closePath()
      c.lineWidth = 3.4
      c.lineJoin = 'round'
      c.strokeStyle = 'rgba(7,11,17,0.9)'
      c.stroke()
      c.lineWidth = 1
      c.fillStyle = '#f0c869'
      c.fill()
    }

    /* THE NAME SITS ON THE COAST, not on the top of the raster, or the hub's
     * label floated forty pixels above its own volcano in open water. Below the
     * island instead when the island is near the top of the stage and the
     * label would be drawn off it.
     *
     * One line, not two. The slug went under the title on every island at every
     * zoom, which is a second row of type on a chart whose whole job is to be
     * looked at; it is in the panel and the roster already. */
    const title = p.title || p.name
    const above = seen.py - 7 > 22
    const ly = above ? seen.py - 7 : seen.py + seen.rh + 14
    // the state, as a chip, once the footprint stopped being a slab of state
    // ink you could read it off. Only where a painting took that job away.
    const chip = drawn ? 11 : 0
    if (chip) {
      c.fillStyle = 'rgba(7,11,17,0.9)'
      c.fillRect(seen.px - 1, ly - 9, 9, 9)
      c.fillStyle = tint
      c.fillRect(seen.px, ly - 8, 7, 7)
    }
    c.font = LABEL
    say(title, seen.px + chip, ly, on ? '#f0c869' : '#d8e3ee')

    /* THE CORNER YOU PULL, drawn where under() looks for it.
     *
     * It was a flat 8px square with no rim, on a painting, at the one corner
     * where the coast usually is, and the test that answered it used a raw
     * footprint the drawing had already floored. Same reader, same size, and a
     * dark rim so it survives whatever colour it lands on. */
    if (on) {
      const g = GRIP - 1
      c.fillStyle = 'rgba(7,11,17,0.85)'
      c.fillRect(px + rw - g, py + rh - g, g * 2, g * 2)
      c.fillStyle = '#f0c869'
      c.globalAlpha = 0.35 + 0.65 * warm
      c.fillRect(px + rw - g + 2, py + rh - g + 2, g * 2 - 4, g * 2 - 4)
      c.globalAlpha = 1
    }
  }

  for (let i = 0; i < doc.places.length; i++) shot(i)
  // the second pass always runs. Only the map's OWN anchors answer to the marks
  // toggle, inside rig: a button labelled "marks" that also took away the berth
  // and the island's name is a button nobody would press twice.
  for (let i = 0; i < doc.places.length; i++) rig(i)

  if (band) {
    c.setLineDash([4, 3])
    c.strokeStyle = '#4f9b84'
    c.strokeRect(X(Math.min(band.x0, band.x1)), Y(Math.min(band.y0, band.y1)), Math.abs(band.x1 - band.x0) * fit.s, Math.abs(band.y1 - band.y0) * fit.s)
    c.setLineDash([])
  }

  // the edge of the world last, over everything, so an island hanging off it
  // is unmistakable
  c.strokeStyle = 'rgba(212,165,60,0.45)'
  c.strokeRect(X(0) + 0.5, Y(0) + 0.5, doc.w * fit.s, doc.h * fit.s)
  c.font = MONO
  say('0,0', X(0), Y(0) - 6, '#6f7885')
  const end = `${doc.w},${doc.h}`
  say(end, X(doc.w) - c.measureText(end).width, Y(doc.h) + 14, '#6f7885')

  /* THE RULER, WHICH IS ONE GRATICULE SQUARE WIDE.
   *
   * Release is 160 and a berth sits a few dozen units off a jetty, and there
   * was nothing anywhere on this page that said how far that is. The bar is
   * exactly one grid square, so the grid becomes the ruler repeated and a
   * distance can be counted off it instead of guessed. */
  const rx = 16
  const ry = size.h - 16
  const rl = step * fit.s
  c.strokeStyle = 'rgba(216,227,238,0.32)'
  c.lineWidth = 1
  c.beginPath()
  c.moveTo(rx + 0.5, ry - 5)
  c.lineTo(rx + 0.5, ry + 0.5)
  c.lineTo(rx + rl + 0.5, ry + 0.5)
  c.lineTo(rx + rl + 0.5, ry - 5)
  c.stroke()
  c.font = TINY
  say(String(step), rx + rl + 7, ry + 3, '#6f7885')
}

/* What is under the pointer, tested in the order things are drawn on top of
 * each other: the size handle of the selected island, then its marks, then the
 * islands newest first, then the water regions. A region is last because it is
 * the biggest thing on the chart and would otherwise swallow every click. */
function under(doc: Doc, fit: Fit, sel: Sel, mx: number, my: number): Hit {
  const X = (x: number) => fit.ox + x * fit.s
  const Y = (y: number) => fit.oy + y * fit.s
  const near = (x: number, y: number, r: number) => Math.hypot(mx - X(x), my - Y(y)) <= r

  /* THE CORNER, THROUGH THE SAME FLOOR THE DRAWING USES.
   * This read p.w * fit.s raw while paint floored the rectangle at three
   * pixels, so zoomed out the handle you could see and the spot that answered
   * a press were in different places and the grab silently became a pan. */
  const chosen = sel?.kind === 'place' ? doc.places[sel.i] : undefined
  if (chosen && sel?.kind === 'place') {
    const hx = X(chosen.x) + Math.max(3, chosen.w * fit.s)
    const hy = Y(chosen.y) + Math.max(3, chosen.h * fit.s)
    if (Math.abs(mx - hx) <= GRIP && Math.abs(my - hy) <= GRIP) return { kind: 'size', i: sel.i }
  }
  for (let i = doc.places.length - 1; i >= 0; i--) {
    const p = doc.places[i]
    if (p.berth && near(p.berth.x, p.berth.y, 9)) return { kind: 'berth', i }
    if (p.approach && near(p.approach.x, p.approach.y, 9)) return { kind: 'approach', i }
  }
  for (let i = doc.places.length - 1; i >= 0; i--) {
    const p = doc.places[i]
    if (mx >= X(p.x) - 5 && mx <= X(p.x) + Math.max(10, p.w * fit.s) && my >= Y(p.y) - 5 && my <= Y(p.y) + Math.max(10, p.h * fit.s))
      return { kind: 'place', i }
  }
  for (let i = doc.regions.length - 1; i >= 0; i--) {
    const [x0, y0, x1, y1] = doc.regions[i].rect
    if (mx >= X(Math.min(x0, x1)) && mx <= X(Math.max(x0, x1)) && my >= Y(Math.min(y0, y1)) && my <= Y(Math.max(y0, y1)))
      return { kind: 'region', i }
  }
  return null
}

/* ---- the page ------------------------------------------------------------ */

export default function World() {
  const { user, loading } = useSession()
  const [doc, setDoc] = useState<Doc | null>(null)
  const [states, setStates] = useState<string[]>([])
  const [kinds, setKinds] = useState<string[]>([])
  const [reg, setReg] = useState<Map<string, MapRow>>(new Map())
  const [why, setWhy] = useState('')
  const [sel, setSel] = useState<Sel>(null)
  const [tool, setTool] = useState<Tool>('move')
  const [pick, setPick] = useState<Pick>('')
  const [hover, setHover] = useState<Hit>(null)
  const [band, setBand] = useState<Band>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [ink, setInk] = useState(0)
  const [view, setView] = useState<Fit | null>(null)
  const [marks, setMarks] = useState(true)
  const [aim, setAim] = useState('')
  const [lock, setLock] = useState(true)
  const [depth, setDepth] = useState(0)
  const [sure, setSure] = useState(false)
  // whether this account is the one the ocean belongs to. null while nobody
  // has answered, and the chart waits rather than flashing up and going away.
  const [mine, setMine] = useState<boolean | null>(null)

  const box = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const art = useRef<Art>(new Map())
  const drag = useRef<{ kind: 'place' | 'berth' | 'approach' | 'size'; i: number; dx: number; dy: number; mx: number; my: number; w: number; h: number } | null>(null)
  const pan = useRef<{ mx: number; my: number; ox: number; oy: number; far: number } | null>(null)
  const bandFrom = useRef<{ x: number; y: number } | null>(null)
  // the documents to go back to, newest last. Held in a ref because nothing
  // renders from the stack itself, only from how deep it is.
  const past = useRef<Doc[]>([])
  const live = useRef<Doc | null>(null)
  live.current = doc
  const nudged = useRef(0)

  /* THE PAGE IS ONE ACCOUNT'S, AND IT SAYS SO RATHER THAN BREAKING.
   *
   * There is exactly one world row on the platform and everyone's maps sit on
   * it, so a second account opening this page could drag somebody else's
   * islands around and only find out at the save. It asks first.
   *
   * A request that does not answer at all leaves it alone: the endpoint is new,
   * an older deploy has no route for it, and hiding the page from its own owner
   * because a 404 came back is the worse of the two failures. The write is
   * still gated on the server, which is where it counts. */
  useEffect(() => {
    if (loading) return
    fetch('/api/world/mine')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { mine?: boolean }) => setMine(j.mine !== false))
      .catch(() => setMine(true))
  }, [loading])

  useEffect(() => {
    fetch('/api/world')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the ocean would not load (${r.status})`))))
      .then((j: Doc & { states?: string[]; seaKinds?: string[] }) => {
        setDoc({ w: j.w, h: j.h, places: j.places || [], regions: j.regions || [], marks: j.marks, home: j.home || '' })
        setStates(j.states || [])
        setKinds(j.seaKinds || [])
      })
      .catch((e) => setWhy(String((e as Error).message || e)))
  }, [])

  /* THE REGISTRY FEEDS EVERYTHING ON THIS PAGE, not just the dropdown.
   *
   * It is asked with=anchors, which is the one request that carries the whole
   * door graph. What comes back gives the map list a typo cannot escape, the
   * published version each painting is fetched at, the real shape of each
   * painting so a footprint is not a made-up square, and the marks that get
   * drawn on the island so a berth has something to aim at. Empty stays offered
   * on purpose: cleanPlace takes an empty map, and that is the whole of the
   * empty-slot ask, a position holding no bundle that reads as a rumour. */
  useEffect(() => {
    fetch('/api/v1/maps?with=anchors')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { maps?: MapRow[] }) => setReg(new Map((j.maps || []).map((m) => [m.slug, m]))))
      .catch(() => setReg(new Map()))
  }, [])

  /* The paintings, one fetch each, kept by slug AND version so a republish is
   * a different picture rather than a stale one held forever. A load failure is
   * left in the map on purpose: deleting the entry would make the next render
   * ask again, and a 404 would then be re-requested on every repaint. */
  const places = doc?.places
  useEffect(() => {
    for (const p of places || []) {
      const m = p.map ? reg.get(p.map) : undefined
      if (!m || !m.version) continue
      const key = `${p.map}@${m.version}`
      if (art.current.has(key)) continue
      const img = new Image()
      art.current.set(key, img)
      img.onload = () => setInk((n) => n + 1)
      img.src = `/api/v1/maps/${encodeURIComponent(p.map)}/file/${m.version}/scene.png`
    }
  }, [places, reg])

  /* The stage is only in the dom once the world has answered, so this has to
   * run again on that transition and not only on mount.
   *
   * BOTH GATES, and it cost a blank chart to learn. The ownership question was
   * added in front of the render without being added here, so on the frame
   * where the document had arrived and the answer had not, this ran against a
   * ref holding nothing, never ran again, and the stage stayed 0x0: fitOf's
   * empty-size fallback then made every view scale 1 and nothing was drawn. */
  const ready = doc !== null && mine !== null
  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [ready])

  // the label face is a webfont, so the first paint can land before it arrives
  // and every name on the chart is drawn in the fallback until you touch
  // something. One redraw when the fonts settle costs nothing.
  useEffect(() => {
    document.fonts?.ready.then(() => setInk((n) => n + 1)).catch(() => {})
  }, [])

  /* The whole ocean on the stage, which is where the chart starts and what the
   * fit button goes back to. Held as the FLOOR of the zoom as well, because
   * further out than the whole ocean is a chart of nothing. */
  const dw = doc?.w
  const dh = doc?.h
  const base: Fit = useMemo(() => (dw && dh ? fitOf({ w: dw, h: dh, places: [], regions: [] }, size) : { s: 1, ox: 0, oy: 0 }), [dw, dh, size])
  const fit = view ?? base

  // one eased number, run up when something is selected and back down when it
  // is let go. A canvas has no css to transition, so without it the ring and
  // the handle blinked into existence and the chart read as a form redrawing
  // itself rather than as a chart being handled.
  const warm = useGlide(sel?.kind === 'place' ? 1 : 0)

  useEffect(() => {
    const el = cv.current
    if (!el || !doc || !size.w) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    el.width = Math.round(size.w * dpr)
    el.height = Math.round(size.h * dpr)
    const c = el.getContext('2d')
    if (!c) return
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    paint(c, size, { doc, fit, sel, hover, band, reg, art: art.current, marks, aim, warm })
  }, [doc, size, fit, sel, hover, band, reg, marks, aim, ink, warm])

  /* THE VIEW IS CHASED, NOT SET.
   *
   * A wheel notch replaced the whole transform in one frame, so the chart
   * jumped from one zoom to the next instead of moving between them, and that
   * single stutter is most of why this page felt like a form. `want` is where
   * the view has been sent, `here` is what is painted, and the loop walks one
   * toward the other about a fifth per frame.
   *
   * Panning writes both at once and cancels the loop: a chart that lags the
   * hand holding it is worse than one that snaps. */
  const want = useRef<Fit | null>(null)
  const here = useRef<Fit | null>(null)
  const raf = useRef(0)

  const put = useCallback((f: Fit) => {
    here.current = f
    setView(f)
  }, [])

  const glide = useCallback(
    (to: Fit) => {
      want.current = to
      if (!here.current || calm()) {
        cancelAnimationFrame(raf.current)
        raf.current = 0
        put(to)
        return
      }
      if (raf.current) return
      const tick = () => {
        const t = want.current
        const f = here.current
        if (!t || !f) {
          raf.current = 0
          return
        }
        const s = f.s + (t.s - f.s) * EASE
        const ox = f.ox + (t.ox - f.ox) * EASE
        const oy = f.oy + (t.oy - f.oy) * EASE
        if (Math.abs(t.s - s) <= t.s * 0.002 && Math.abs(t.ox - ox) < 0.5 && Math.abs(t.oy - oy) < 0.5) {
          raf.current = 0
          put(t)
          return
        }
        put({ s, ox, oy })
        raf.current = requestAnimationFrame(tick)
      }
      raf.current = requestAnimationFrame(tick)
    },
    [put],
  )

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  /* ZOOM ABOUT A POINT, which is the only kind worth having here. Zooming about
   * the middle of the stage means the island you were looking at slides away
   * while you scroll, and you spend the zoom chasing it.
   *
   * Measured from where the view is GOING and not from where it is, so three
   * quick wheel notches are three notches of zoom rather than one and a half:
   * reading the painted view mid-glide would throw away everything the loop has
   * not caught up with yet. */
  const zoomAt = useCallback(
    (mx: number, my: number, k: number) => {
      const f = want.current || here.current || base
      const s = clamp(f.s * k, base.s, MAX_S)
      if (Math.abs(s - f.s) < 1e-9) return
      glide({ s, ox: mx - (mx - f.ox) * (s / f.s), oy: my - (my - f.oy) * (s / f.s) })
    },
    [base, glide],
  )

  /* A NATIVE LISTENER, because React binds wheel passively at the root and
   * preventDefault inside an onWheel prop does nothing. Without the
   * preventDefault the page scrolls behind the chart while you zoom. */
  useEffect(() => {
    const el = cv.current
    if (!el) return
    const spin = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const d = e.deltaY * (e.deltaMode === 1 ? 16 : 1)
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-d * 0.0018))
    }
    el.addEventListener('wheel', spin, { passive: false })
    return () => el.removeEventListener('wheel', spin)
  }, [zoomAt, ready])

  /* THE VIEW THAT OPENS, AND WHAT "fit" MEANS.
   *
   * `base` is the whole 4096 ocean and stays that way, because it is the zoom
   * FLOOR and pulling back to the whole water has to remain possible. It is the
   * wrong thing to OPEN on: an island is about sixty units across, so the chart
   * opened as an empty grid with the hub an eleven pixel speck, which is the
   * exact featureless grid this page was rebuilt to stop being. Nothing in that
   * view suggested there were paintings in it.
   *
   * Written as a real view rather than left as null, because a null view would
   * be recomputed from the document and the stage would jump under the cursor
   * every time an island was dragged. */
  const frameAll = useCallback(() => {
    if (!doc || !size.w || !size.h) return
    const b = contentBox(doc)
    if (!b) return glide(base)
    const s = clamp(Math.min((size.w - PAD * 2) / b.w, (size.h - PAD * 2) / b.h), base.s, MAX_S)
    glide({ s, ox: size.w / 2 - (b.x + b.w / 2) * s, oy: size.h / 2 - (b.y + b.h / 2) * s })
  }, [doc, size, base, glide])

  // once, when the water first arrives with something on it
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || !doc || !size.w || !doc.places.length) return
    opened.current = true
    frameAll()
  }, [doc, size, frameAll])

  const place = doc && sel?.kind === 'place' ? doc.places[sel.i] : null
  const region = doc && sel?.kind === 'region' ? doc.regions[sel.i] : null
  const sheet = place && place.map ? reg.get(place.map) : undefined

  // fill the stage with the selected island and everything tied to it, which is
  // the one move that gets you from the whole ocean to a jetty
  const frame = useCallback(() => {
    if (!place || !size.w) return
    let x0 = place.x
    let y0 = place.y
    let x1 = place.x + place.w
    let y1 = place.y + place.h
    for (const m of [place.berth, place.approach]) {
      if (!m) continue
      x0 = Math.min(x0, m.x)
      y0 = Math.min(y0, m.y)
      x1 = Math.max(x1, m.x)
      y1 = Math.max(y1, m.y)
    }
    const mw = Math.max(8, x1 - x0)
    const mh = Math.max(8, y1 - y0)
    const s = clamp(Math.min((size.w - PAD * 3) / mw, (size.h - PAD * 3) / mh), base.s, MAX_S)
    glide({ s, ox: size.w / 2 - (x0 + mw / 2) * s, oy: size.h / 2 - (y0 + mh / 2) * s })
  }, [place, size, base.s, glide])

  /* the screen point the ± buttons pull toward: the selected island if there is
   * one, otherwise the middle of everything placed, and only the bare middle of
   * the stage when the water is genuinely empty */
  const holdPt = useMemo<[number, number]>(() => {
    const t = place
      ? { x: place.x + place.w / 2, y: place.y + place.h / 2 }
      : doc && doc.places.length
        ? (() => {
            const b = contentBox(doc)
            return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null
          })()
        : null
    if (!t) return [size.w / 2, size.h / 2]
    return [t.x * fit.s + fit.ox, t.y * fit.s + fit.oy]
  }, [place, doc, fit, size])

  /* ONE STEP BACK, AND THE STEP IS A WHOLE DOCUMENT.
   *
   * The chart is a couple of dozen small objects, so keeping the state before a
   * gesture costs nothing and is the only version of this that cannot get out
   * of step with what is on screen. A patch log would have to know that moving
   * an island also moves its berth and its approach, and that is exactly the
   * kind of thing that ends up half right.
   *
   * remember() is called ONCE at the start of a gesture rather than on every
   * frame of it, so a drag across the chart is one undo and not four hundred. */
  const remember = useCallback(() => {
    const d = live.current
    if (!d) return
    past.current = [...past.current.slice(1 - UNDO_DEEP), d]
    setDepth(past.current.length)
  }, [])

  const undo = useCallback(() => {
    const back = past.current.pop()
    setDepth(past.current.length)
    if (!back) return
    setDoc(back)
    setSel(null)
    setSure(false)
    setDirty(true)
  }, [])

  const edit = useCallback((i: number, patch: Partial<Place>) => {
    setDoc((d) => (d ? { ...d, places: d.places.map((p, k) => (k === i ? { ...p, ...patch } : p)) } : d))
    setDirty(true)
  }, [])

  /* AN ISLAND CARRIES ITS BERTH AND ITS APPROACH WITH IT.
   *
   * The same rule a bound anchor follows: the mark was placed relative to the
   * island, so moving the island and leaving the mooring behind is never what
   * anybody meant. Clamped to the chart as it goes, because checkWorld refuses
   * a save for a place that is off the ocean and a drag should not be able to
   * make a document the server will not take. */
  const shift = useCallback((i: number, x: number, y: number) => {
    setDoc((d) => {
      if (!d) return d
      return {
        ...d,
        places: d.places.map((p, k) => {
          if (k !== i) return p
          const nx = clamp(Math.round(x), 0, d.w)
          const ny = clamp(Math.round(y), 0, d.h)
          const dx = nx - p.x
          const dy = ny - p.y
          return {
            ...p,
            x: nx,
            y: ny,
            ...(p.berth ? { berth: { ...p.berth, x: p.berth.x + dx, y: p.berth.y + dy } } : {}),
            ...(p.approach ? { approach: { ...p.approach, x: p.approach.x + dx, y: p.approach.y + dy } } : {}),
          }
        }),
      }
    })
    setDirty(true)
  }, [])

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { mx: e.clientX - r.left, my: e.clientY - r.top }
  }
  const toWorld = (mx: number, my: number) => ({ x: (mx - fit.ox) / fit.s, y: (my - fit.oy) / fit.s })

  /* THE ANCHOR THE POINTER IS AIMED AT, IF ANY.
   *
   * Eleven screen pixels, which is a deliberate aim and not a nudge you can
   * make by accident. This is what turns "somewhere near the coast" into "at
   * the dock": a door or a post is a real mark on the painting, so a berth put
   * exactly on one is a berth against the thing the author drew. It is offered
   * and never forced, because a mooring usually wants to sit in the water just
   * off the mark rather than on top of it. */
  const aimed = useCallback(
    (p: Place, mx: number, my: number) => {
      const m = p.map ? reg.get(p.map) : undefined
      if (!m || !marks || p.w * fit.s <= 54) return null
      for (const a of m.anchors || []) {
        const w = anchorAt(p, m, a)
        if (Math.hypot(mx - (fit.ox + w.x * fit.s), my - (fit.oy + w.y * fit.s)) <= SNAP) return { a, w }
      }
      return null
    },
    [reg, marks, fit],
  )

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!doc) return
    const { mx, my } = at(e)
    const w = toWorld(mx, my)
    // capture so a drag that leaves the stage keeps reporting, and swallow the
    // failure rather than letting it take the whole press with it: a pointer id
    // the browser has already released throws here, and an exception thrown on
    // the first line of a pointerdown means nothing below it ever runs
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* the press still works uncaptured */
    }

    // the middle button pans whatever tool is up, the way it does in every
    // other canvas anybody has used
    if (e.button === 1) {
      pan.current = { mx, my, ox: fit.ox, oy: fit.oy, far: 0 }
      return
    }

    // setting a mark by clicking the water. It is a mode rather than a drag,
    // because the point being set is usually nowhere near the island and a drag
    // out of the inspector cannot cross the panel edge.
    if (pick && place && sel?.kind === 'place') {
      const hitA = aimed(place, mx, my)
      const spot = hitA
        ? { x: Math.round(hitA.w.x), y: Math.round(hitA.w.y) }
        : { x: clamp(Math.round(w.x), 0, doc.w), y: clamp(Math.round(w.y), 0, doc.h) }
      remember()
      edit(sel.i, pick === 'berth' ? { berth: { ...spot, ...(place.berth?.facing ? { facing: place.berth.facing } : {}) } } : { approach: spot })
      setPick('')
      return
    }

    if (tool === 'place') {
      const name = freeName('island', doc.places.map((p) => p.name))
      const made: Place = {
        name,
        map: '',
        title: '',
        x: clamp(Math.round(w.x), 0, doc.w),
        y: clamp(Math.round(w.y), 0, doc.h),
        // one size, every time, and the painting bends the short side later.
        // Born 64x64 it depended on nothing and looked like nothing.
        ...bornAs(),
        // a slot with no map behind it is a rumour and nothing else reads
        // honestly, which is what checkWorld warns about
        state: 'rumour',
        /* 160 was a guess and it is wrong by an order of magnitude against what
         * is actually authored: the hub is discovered at 520 and held at 1400.
         * Born at those, so a new island reads the way the real ones do. */
        discover: 520,
        release: 1400,
      }
      remember()
      setDoc({ ...doc, places: [...doc.places, made] })
      setSel({ kind: 'place', i: doc.places.length })
      setTool('move')
      setDirty(true)
      return
    }

    if (tool === 'sea') {
      bandFrom.current = { x: Math.round(w.x), y: Math.round(w.y) }
      setBand({ x0: w.x, y0: w.y, x1: w.x, y1: w.y })
      return
    }

    const hit = under(doc, fit, sel, mx, my)
    if (!hit) {
      /* EMPTY WATER DRAGS THE CHART, and only DESELECTS if the pointer did not
       * really move. Zoomed in, panning is the thing you do most, and reaching
       * for a scrollbar that is not there was the first thing that made this
       * page feel broken. */
      pan.current = { mx, my, ox: fit.ox, oy: fit.oy, far: 0 }
      return
    }
    if (hit.kind === 'region') {
      setSel({ kind: 'region', i: hit.i })
      return
    }
    setSel({ kind: 'place', i: hit.i })
    setSure(false)
    const p = doc.places[hit.i]
    const from = hit.kind === 'berth' ? p.berth : hit.kind === 'approach' ? p.approach : { x: p.x, y: p.y }
    /* THE GESTURE REMEMBERS WHERE IT STARTED, IN BOTH UNITS.
     *
     * dx,dy is the world offset a MOVE keeps under the cursor. mx,my and w,h
     * are what a RESIZE grows from, and the resize needed its own pair because
     * it was reading the move's: dx there was the distance from the island's
     * ORIGIN, so the new width came out as the raw travel since the grab rather
     * than the old width plus it, and the footprint collapsed to its floor the
     * instant a corner was touched. */
    drag.current = { kind: hit.kind, i: hit.i, dx: w.x - (from?.x ?? p.x), dy: w.y - (from?.y ?? p.y), mx, my, w: p.w, h: p.h }
    remember()
  }

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!doc) return
    const { mx, my } = at(e)
    const w = toWorld(mx, my)

    const pn = pan.current
    if (pn) {
      pn.far = Math.max(pn.far, Math.hypot(mx - pn.mx, my - pn.my))
      // straight to the view and to where the view is going, both. Easing the
      // hand that is holding the chart is lag, not smoothness.
      const to = { s: fit.s, ox: pn.ox + (mx - pn.mx), oy: pn.oy + (my - pn.my) }
      want.current = to
      put(to)
      return
    }
    if (bandFrom.current) {
      setBand({ x0: bandFrom.current.x, y0: bandFrom.current.y, x1: w.x, y1: w.y })
      return
    }
    const d = drag.current
    if (!d) {
      // the same hit, held rather than replaced, or every pixel of pointer
      // movement is a new object and a full repaint of the chart
      const h = under(doc, fit, sel, mx, my)
      setHover((v) => (v?.kind === h?.kind && v?.i === h?.i ? v : h))
      // and the anchor the cursor would snap a berth to, lit while you decide
      const p = pick && place ? aimed(place, mx, my) : null
      setAim(p && place ? `${place.name}/${p.a.name}` : '')
      return
    }
    const x = clamp(Math.round(w.x - d.dx), 0, doc.w)
    const y = clamp(Math.round(w.y - d.dy), 0, doc.h)
    if (d.kind === 'place') shift(d.i, x, y)
    else if (d.kind === 'berth') edit(d.i, { berth: { ...doc.places[d.i].berth, x, y } as Pt })
    else if (d.kind === 'approach') edit(d.i, { approach: { x, y } })
    else {
      /* THE FOOTPRINT GROWS FROM WHAT IT WAS, GEARED, AND IT COULD DO NEITHER.
       *
       * The old branch put the corner wherever the pointer was, using the MOVE
       * drag's offset to get there, so the width became the raw travel since
       * the grab and an untouched grab set it to 1. That is the collapse. And
       * even once it was anchored, one to one on the corner means an island
       * doubles in the width of a thumb.
       *
       * The delta is a fraction of the island ON SCREEN, so the same hand
       * movement does the same thing at every zoom, and half of it lands on the
       * size, an eighth with shift held. The floor under d.w * fit.s stops a
       * footprint that is three pixels wide out at full extent turning every
       * tremor into a doubling. */
      const p0 = doc.places[d.i]
      const m = p0.map ? reg.get(p0.map) : undefined
      const gain = e.shiftKey ? RESIZE_FINE : RESIZE_GAIN
      const gx = ((mx - d.mx) / Math.max(GRIP * 2, d.w * fit.s)) * gain
      const gy = ((my - d.my) / Math.max(GRIP * 2, d.h * fit.s)) * gain
      // the handle honours the same lock the inspector does, so dragging a
      // footprint cannot quietly squash the painting inside it. Held, both
      // axes push the one scale, or dragging straight down does nothing at all.
      const held = lock && m && m.w > 0 && m.h > 0
      const nw = held ? side(d.w * (1 + (gx + gy) / 2)) : side(d.w * (1 + gx))
      const nh = held && m ? side((nw * m.h) / m.w) : side(d.h * (1 + gy))
      if (nw !== p0.w || nh !== p0.h) edit(d.i, { w: nw, h: nh })
    }
  }

  const up = () => {
    const pn = pan.current
    if (pn) {
      // a press that went nowhere is a click on open water, which clears the
      // selection the way it always did
      if (pn.far < 4) setSel(null)
      pan.current = null
      return
    }
    if (bandFrom.current && band && doc) {
      // held inside the chart, because a drag that ran off the edge names water
      // that is not on the ocean and nothing would ever sail through it
      const rect: [number, number, number, number] = [
        clamp(Math.round(Math.min(band.x0, band.x1)), 0, doc.w),
        clamp(Math.round(Math.min(band.y0, band.y1)), 0, doc.h),
        clamp(Math.round(Math.max(band.x0, band.x1)), 0, doc.w),
        clamp(Math.round(Math.max(band.y0, band.y1)), 0, doc.h),
      ]
      // a region dragged out by accident, one pixel across, is a click and not
      // a region, and it would sit on the chart as an invisible thing to hit
      if (rect[2] - rect[0] > 8 && rect[3] - rect[1] > 8) {
        const made: Region = { name: freeName('sea', doc.regions.map((r) => r.name)), kind: kinds[0] || 'sailable', rect }
        remember()
        setDoc({ ...doc, regions: [...doc.regions, made] })
        setSel({ kind: 'region', i: doc.regions.length })
        setDirty(true)
      }
      setTool('move')
    }
    bandFrom.current = null
    setBand(null)
    drag.current = null
  }

  const drop = (i: number) => {
    remember()
    setDoc((d) => (d ? { ...d, places: d.places.filter((_, k) => k !== i) } : d))
    setSel(null)
    setSure(false)
    setDirty(true)
  }
  const dropRegion = (i: number) => {
    remember()
    setDoc((d) => (d ? { ...d, regions: d.regions.filter((_, k) => k !== i) } : d))
    setSel(null)
    setSure(false)
    setDirty(true)
  }

  /* THE WHOLE DOCUMENT GOES, and what comes back replaces what was on screen,
   * so the chart afterwards is the row and not a hopeful copy of it.
   *
   * The one thing checked here rather than there: cleanPlace and cleanRegion
   * both DROP a row whose name is not a legal identifier, silently, and a save
   * that quietly loses an island is worse than a save that refuses. */
  const save = async () => {
    if (!doc || busy) return
    const illegal = [...doc.places, ...doc.regions].filter((p) => !isAnchorName(p.name)).map((p) => p.name || '(no name)')
    if (illegal.length) {
      setProblems([`${illegal.join(', ')} cannot be a name · lower case letters, digits and underscores, starting with a letter`])
      return
    }
    setBusy(true)
    setProblems([])
    setWarnings([])
    try {
      const r = await fetch('/api/world', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ w: doc.w, h: doc.h, places: doc.places, regions: doc.regions, home: doc.home || '', ...(doc.marks === undefined ? {} : { marks: doc.marks }) }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setProblems(j.problems?.length ? j.problems : [j.error || `the server refused it (${r.status})`])
        return
      }
      setDoc({ w: j.w, h: j.h, places: j.places || [], regions: j.regions || [], marks: j.marks, home: j.home || '' })
      setWarnings(j.warnings || [])
      setDirty(false)
    } catch (e) {
      setProblems([String((e as Error).message || e)])
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
        return
      }
      if (e.key === 'Escape') {
        setPick('')
        setTool('move')
        setAim('')
        setSure(false)
        return
      }
      /* THE BARE KEYS STOP AT A FIELD, and the one that matters is zero. The
       * inspector is full of number inputs, so an unguarded shortcut on 0 means
       * typing a release of 160 throws the chart back out to the whole ocean
       * halfway through. Ctrl+S and escape are above this on purpose: both are
       * things you press while your hands are still in a field. */
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return
      if (e.key === 'f') frame()
      if (e.key === '0') frameAll()

      /* THE ARROWS, because a footprint lands on the unit you meant by being
       * typed or by being nudged and not by being dragged: at the zoom where a
       * whole island fits, one screen pixel is a third of a world unit and the
       * hand cannot do better than that.
       *
       * One undo per BURST rather than per key. Holding an arrow down fires
       * thirty a second and a stack of thirty identical steps is an undo that
       * does nothing thirty times. */
      const step = e.key.startsWith('Arrow') ? (e.shiftKey ? NUDGE_FAR : 1) : 0
      if (step && place && sel?.kind === 'place') {
        e.preventDefault()
        const now = performance.now()
        if (now - nudged.current > 600) remember()
        nudged.current = now
        const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0
        const dy = e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0
        shift(sel.i, place.x + dx, place.y + dy)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
    // no dependency list, because save() closes over the document and a list
    // that misses one field is a ctrl+s that posts what the page held a minute
    // ago. Rebinding one listener per render costs nothing here.
  })

  // there is no autosave here on purpose, so the only thing standing between a
  // half hour of placing and a closed tab is this
  useEffect(() => {
    if (!dirty) return
    const ask = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [dirty])

  /* NOT YOURS, SAID PLAINLY, rather than a chart of somebody else's islands
   * that refuses at the save. There is one world row for the whole platform. */
  if (mine === false)
    return (
      <div className="world">
        <div className="world-gone">
          <h1>The ocean is not yours.</h1>
          <p>One account holds the water every map sits on. Yours are all still here.</p>
          <Link to="/" className="world-btn">
            your maps
          </Link>
        </div>
      </div>
    )
  if (why)
    return (
      <div className="world">
        <div className="world-gone">
          <h1>The ocean will not open.</h1>
          <p>{why}</p>
          <Link to="/" className="world-btn">
            your maps
          </Link>
        </div>
      </div>
    )
  if (!doc || mine === null) return <div className="world" />

  const scale = fit.s >= 1 ? `${fit.s < 10 ? fit.s.toFixed(1) : Math.round(fit.s)}×` : `1:${Math.round(1 / fit.s)}`
  // what the pointer is over, said by the cursor rather than by a sentence at
  // the bottom of the chart. The old grabbing state read a ref during render,
  // which never re-renders, so it was a cursor that could not appear.
  const grip = pick || tool !== 'move' ? 'crosshair' : hover?.kind === 'size' ? 'nwse-resize' : hover ? 'move' : 'grab'

  return (
    <div className="world">
      <header className="world-bar">
        <button className="world-back" onClick={() => go('/')} title="back to your maps">
          ←
        </button>
        <span className="world-name">ocean</span>
        {/* THE TOOLS ARE ONE CONTROL, not three buttons that happen to be
            beside each other. Spelt out they were a sentence across the bar;
            the words that carried nothing are in the title instead. */}
        <div className="world-tools" role="group" aria-label="tool">
          <button className={'world-tool' + (tool === 'move' ? ' on' : '')} onClick={() => setTool('move')} title="move what is on the water">
            move
          </button>
          <button className={'world-tool' + (tool === 'place' ? ' on' : '')} onClick={() => setTool('place')} title="hold a position for an island">
            island
          </button>
          <button className={'world-tool' + (tool === 'sea' ? ' on' : '')} onClick={() => setTool('sea')} title="drag out a stretch of water and name it">
            water
          </button>
        </div>
        <span className="world-meta">
          <input
            className="world-num"
            type="number"
            value={doc.w}
            aria-label="ocean width"
            title="the ocean, across"
            onChange={(e) => {
              setDoc({ ...doc, w: Math.max(1, Math.round(Number(e.target.value) || 0)) })
              setDirty(true)
            }}
          />
          <span>×</span>
          <input
            className="world-num"
            type="number"
            value={doc.h}
            aria-label="ocean height"
            title="the ocean, down"
            onChange={(e) => {
              setDoc({ ...doc, h: Math.max(1, Math.round(Number(e.target.value) || 0)) })
              setDirty(true)
            }}
          />
        </span>
        <button className="world-btn small" onClick={undo} disabled={!depth} title="step back · ctrl z">
          undo
        </button>
        <button className="world-save" onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? 'saving' : dirty ? 'save' : 'saved'}
        </button>
      </header>

      <div className="world-body">
        <div className="world-stage" ref={box}>
          <canvas
            ref={cv}
            className="world-chart"
            style={{ width: size.w || undefined, height: size.h || undefined, cursor: grip }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onDoubleClick={frame}
            onAuxClick={(e) => e.preventDefault()}
          />
          {/* ONE LINE, AND ONLY WHILE A TOOL IS ARMED.
              This was a standing paragraph across the bottom of the chart at
              all times, and the case it spent most of its life in was "scroll
              to zoom · drag the water to pan", which is a caption explaining a
              map to somebody already holding one. The armed cases are the only
              ones where the tool has something to say, so they are the only
              ones that speak, and they get the gold for saying it. */}
          {(pick || tool !== 'move') && (
            <p className="world-hint" role="status">
              {pick ? (aim ? `on ${aim.split('/')[1]}` : `click the water · esc`) : tool === 'place' ? 'click open water · esc' : 'drag out the water · esc'}
            </p>
          )}
          <div className="world-zoom">
            {/* THE BUTTONS ZOOM WHERE THE WHEEL DOES, which is not the middle of
                an empty screen. Anchoring on the viewport centre marched the one
                island straight off the top of the stage in two presses, because
                the island sits wherever it sits and the centre is just water. The
                wheel was already cursor-anchored and correct, so the discoverable
                control was the worse of the two. Both now pull toward whatever is
                selected, or toward everything that is placed. */}
            <button className="world-zbtn" onClick={() => zoomAt(...holdPt, 1 / 1.6)} aria-label="zoom out" title="zoom out">
              −
            </button>
            <span className="world-zread">{scale}</span>
            <button className="world-zbtn" onClick={() => zoomAt(...holdPt, 1.6)} aria-label="zoom in" title="zoom in">
              +
            </button>
            <button className="world-zbtn wide" onClick={frameAll} title="everything on the water · 0">
              fit
            </button>
            <button className="world-zbtn wide" onClick={frame} disabled={!place} title="fill the stage with what is selected · f">
              frame
            </button>
            <button
              className={'world-zbtn wide' + (marks ? ' on' : '')}
              onClick={() => setMarks((v) => !v)}
              title="the doors, posts and spawns each island carries"
            >
              marks
            </button>
          </div>
        </div>

        <aside className="world-side">
          {problems.length > 0 && (
            <div className="world-refused">
              <span className="world-lab">refused</span>
              {problems.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <div className="world-warns">
              <span className="world-lab">saved, with</span>
              {warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}
          {!loading && !user && <p className="world-note">saving needs an account</p>}

          {/* nothing selected used to be answered with a paragraph explaining
              what an island is to somebody looking at a chart of them. The
              roster below is the answer. */}
          {place && sel?.kind === 'place' ? (
            <Inspector
              p={place}
              i={sel.i}
              states={states}
              home={doc.home || ''}
              onHome={(name) => {
                remember()
                setDoc({ ...doc, home: name })
                setDirty(true)
              }}
              reg={reg}
              sheet={sheet}
              pick={pick}
              lock={lock}
              sure={sure}
              onSure={setSure}
              onLock={setLock}
              onPick={setPick}
              onEdit={edit}
              onMove={shift}
              onBefore={remember}
              onDrop={() => drop(sel.i)}
            />
          ) : region && sel?.kind === 'region' ? (
            <SeaPanel
              r={region}
              kinds={kinds}
              sure={sure}
              onSure={setSure}
              onEdit={(patch) => {
                setDoc({ ...doc, regions: doc.regions.map((x, k) => (k === sel.i ? { ...x, ...patch } : x)) })
                setDirty(true)
              }}
              onDrop={() => dropRegion(sel.i)}
            />
          ) : null}

          <div className="world-roster">
            <span className="world-lab">
              on the water · {doc.places.length}
              {doc.regions.length ? ` · ${doc.regions.length} sea` : ''}
            </span>
            {doc.places.map((p, i) => (
              <button
                key={i}
                className={'world-row' + (sel?.kind === 'place' && sel.i === i ? ' on' : '')}
                onClick={() => setSel({ kind: 'place', i })}
              >
                <i style={{ background: inkFor(STATE_INK, p.state) }} />
                <span className="world-row-n">{p.name}</span>
                <span className="world-row-m">{p.map || 'rumour'}</span>
              </button>
            ))}
            {doc.regions.map((r, i) => (
              <button
                key={'r' + i}
                className={'world-row' + (sel?.kind === 'region' && sel.i === i ? ' on' : '')}
                onClick={() => setSel({ kind: 'region', i })}
              >
                <i style={{ background: inkFor(SEA_INK, r.kind) }} />
                <span className="world-row-n">{r.name}</span>
                <span className="world-row-m">{r.kind}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}

/* EVERY FIELD THE SERVER KEEPS, IN ONE PANEL.
 *
 * A place that carried a field with no control on it would be a field only the
 * database ever sets, which is the half-plumbed sweep this page exists to stop
 * repeating. So name, map, title, x, y, w, h, state, release, berth and
 * approach are all here, and meta is the only one left out because nothing
 * reads it yet. */
function Inspector({
  p,
  i,
  states,
  home,
  onHome,
  reg,
  sheet,
  pick,
  lock,
  sure,
  onSure,
  onLock,
  onPick,
  onEdit,
  onMove,
  onBefore,
  onDrop,
}: {
  p: Place
  i: number
  states: string[]
  home: string
  onHome: (name: string) => void
  reg: Map<string, MapRow>
  sheet: MapRow | undefined
  pick: Pick
  lock: boolean
  sure: boolean
  onSure: (v: boolean) => void
  onLock: (v: boolean) => void
  onPick: (v: Pick) => void
  onEdit: (i: number, patch: Partial<Place>) => void
  onMove: (i: number, x: number, y: number) => void
  onBefore: () => void
  onDrop: () => void
}) {
  const set = (patch: Partial<Place>) => onEdit(i, patch)
  const legal = isAnchorName(p.name)
  const slugs = [...reg.keys()]
  // a map the listing does not carry is still shown, because it may be the
  // island being painted this week and blanking it would rewrite the document
  // behind somebody's back
  const options = p.map && !slugs.includes(p.map) ? [p.map, ...slugs] : slugs
  const shape = sheet && sheet.w > 0 && sheet.h > 0 ? sheet.w / sheet.h : 0
  const marks = sheet?.anchors || []

  /* THE FOOTPRINT FOLLOWS THE PAINTING'S SHAPE unless the author says
   * otherwise. Every place used to be born 64x64, so the hub, which is 688x640,
   * was drawn as a square and every anchor on it landed a few percent off the
   * pixel it belongs to. A wrong shape is worse than a wrong size: a berth
   * placed against a squashed jetty is against nothing.
   *
   * Through side(), the same fence the handle uses, so a footprint typed in and
   * a footprint dragged out cannot end up in different ranges. */
  const setW = (n: number) => set(lock && shape ? { w: side(n), h: side(n / shape) } : { w: side(n) })
  const setH = (n: number) => set(lock && shape ? { h: side(n), w: side(n * shape) } : { h: side(n) })

  /* A TICKED CONSTRAINT THAT IS NOT ENFORCED IS A LIE IN THE UI.
   *
   * The box said "hold the painting's shape · 688x640" with the tick on, while
   * the footprint sat at 64x64, and offered a button to straighten it. So the
   * tool showed a rule, showed the rule being broken, and asked the author to
   * fix it by hand. The two states this can be in are held and not held; a
   * third state where it is held but wrong is not one anybody asked for.
   *
   * It corrects itself instead, once, when the shape is first known. Only ever
   * the height, so the size an author chose is the one they keep. */
  const wantH = shape ? side(p.w / shape) : 0
  useEffect(() => {
    if (lock && wantH && p.h !== wantH) set({ h: wantH })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lock, wantH, p.h])

  return (
    <div className="world-insp">
      <span className="world-lab">island</span>
      <label className="world-f">
        <span>name</span>
        <input
          className={'world-in' + (legal ? '' : ' bad')}
          value={p.name}
          spellCheck={false}
          maxLength={48}
          title="the address a grape reaches this island by"
          onChange={(e) => set({ name: e.target.value })}
          onBlur={() => !legal && set({ name: anchorName(p.name) })}
        />
      </label>
      {!legal && <p className="world-bad">lower case, digits, underscores</p>}
      {/* THE ID THE GAME LOOKS THIS UP BY, which is a different string from the
          address above and could never have been typed into it: the roster's
          ids are kebab-case and a name here is a python identifier. Without one
          the game has nothing to discover this island under and nothing to count
          a visit against, so it reads misty for the whole run. */}
      <label className="world-f">
        <span>place id</span>
        <input
          className="world-in"
          value={p.place || ''}
          spellCheck={false}
          maxLength={48}
          placeholder="home-island"
          title="the roster id the game finds this slot by · lower case with hyphens"
          onChange={(e) => set({ place: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
        />
      </label>
      <label className="world-f">
        <span>map</span>
        <select
          className="world-in"
          value={p.map}
          onChange={(e) => {
            const slug = e.target.value
            const m = reg.get(slug)
            onBefore()
            /* A FOOTPRINT NOBODY HAS SIZED TAKES THE DEFAULT WHOLE, and one
             * somebody HAS sized keeps its width and only has the shape put
             * right. Bending the height of a square is correct for an island
             * already placed and wrong for one born a moment ago, which would
             * otherwise keep a width chosen before there was a picture. */
            if (!m || m.w <= 0 || m.h <= 0) return set({ map: slug })
            const fresh = p.w === ISLAND_DEFAULT && p.h === ISLAND_DEFAULT
            set(fresh ? { map: slug, ...bornAs(m) } : { map: slug, h: side((p.w * m.h) / m.w) })
          }}
        >
          <option value="">no map</option>
          {options.map((s) => (
            <option key={s} value={s}>
              {s}
              {slugs.includes(s) ? '' : ' · unpublished'}
            </option>
          ))}
        </select>
      </label>
      <label className="world-f">
        <span>title</span>
        <input
          className="world-in"
          value={p.title}
          maxLength={120}
          title="what the player is told this place is called"
          onChange={(e) => set({ title: e.target.value })}
        />
      </label>
      {/* typing a coordinate goes through the same move the drag does, so an
          island carries its berth and its approach either way. Two ways to say
          the same thing that mean different things is how a mooring gets left
          behind by whoever typed instead of dragged. */}
      <div className="world-pair">
        <Num label="x" v={p.x} on={(n) => onMove(i, n, p.y)} />
        <Num label="y" v={p.y} on={(n) => onMove(i, p.x, n)} />
      </div>
      <div className="world-pair">
        <Num label="w" v={p.w} min={ISLAND_MIN} on={setW} />
        <Num label="h" v={p.h} min={ISLAND_MIN} on={setH} />
      </div>
      {/* the sentence this was, "hold the painting's shape · 688x640", said the
          same thing three times. The size it is holding is the title. */}
      <label className="world-check" title={sheet ? `the painting is ${sheet.w}×${sheet.h}` : 'the painting decides the short side'}>
        <input type="checkbox" checked={lock} onChange={(e) => onLock(e.target.checked)} />
        <span>keep the shape</span>
      </label>
      <label className="world-f">
        <span>state</span>
        <select className="world-in" value={p.state} onChange={(e) => set({ state: e.target.value })}>
          {states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {/* TWO RADII, AND THIS PANEL HAD ONE UNDER THE WRONG NAME. What was called
          release here is what the game calls discover; what the game calls
          release is how far out the bundle stays decoded, which is the number
          the memory budget trims against and had no control at all. */}
      <label className="world-f">
        <span>discover</span>
        <input
          className="world-in"
          type="number"
          min={0}
          value={p.discover}
          title="how close the hull comes, measured from x,y, before this island is found"
          onChange={(e) => set({ discover: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
        />
      </label>
      <label className="world-f">
        <span>hold</span>
        <input
          className="world-in"
          type="number"
          min={0}
          value={p.release}
          title="how far out this map's bundle stays in memory · the first thing dropped when a chromebook runs short"
          onChange={(e) => set({ release: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
        />
      </label>
      {/* ONE SLOT FOR THE WHOLE OCEAN, so it is a radio wearing a checkbox: a
          run starts in one place, and two islands both claiming it would make a
          fresh run begin in whichever the reader happened to find first.
          Ticking this unticks any other by writing one name on the world. */}
      <label className="world-check" title="a run with no ship yet begins here, and a graduate is handed back to it">
        <input type="checkbox" checked={home === p.name} onChange={(e) => onHome(e.target.checked ? p.name : '')} />
        <span>the run starts here</span>
      </label>

      <span className="world-lab">mooring</span>
      {/* the marks the painting carries were spelt out as a sentence naming
          every one of them. The count is what you need in the panel; the names
          are on the island itself, which is where you aim at them. */}
      <div className="world-mark">
        <span className="world-mark-t" title={marks.length ? marks.map((a) => a.name).join(', ') : 'nothing on this painting to snap to yet'}>
          berth
          {p.map ? ` · ${marks.length} mark${marks.length === 1 ? '' : 's'}` : ''}
        </span>
        <button
          className={'world-btn small' + (pick === 'berth' ? ' on' : '')}
          title="then click the water · a mark on the island snaps"
          onClick={() => onPick(pick === 'berth' ? '' : 'berth')}
        >
          {p.berth ? 'move' : 'set'}
        </button>
        {p.berth && (
          <button
            className="world-btn small"
            title="take the berth off"
            onClick={() => {
              onBefore()
              set({ berth: undefined })
            }}
          >
            ×
          </button>
        )}
      </div>
      {p.berth && (
        <>
          <div className="world-pair">
            <Num label="x" v={p.berth.x} on={(n) => set({ berth: { ...p.berth, x: n } as Pt })} />
            <Num label="y" v={p.berth.y} on={(n) => set({ berth: { ...p.berth, y: n } as Pt })} />
          </div>
          {/* the heading held once the hull is tied up, on the compass the
              editor already uses for a door and a post, so a facing is set the
              same way everywhere in this tool */}
          <div className="world-face" role="group" aria-label="berth facing">
            {FACE_GRID.flat().map((k, n) => (
              <button
                key={k || 'none'}
                className={'world-fbtn' + ((k ? p.berth?.facing === k : !p.berth?.facing) ? ' on' : '')}
                title={k || 'no opinion'}
                onClick={() => {
                  const b = p.berth as Pt
                  // rebuilt rather than spread, so clearing a facing really
                  // clears it. The arrival anchor is carried across by hand,
                  // because it is the one other thing living on this point.
                  const at = b.at ? { at: b.at } : {}
                  set({ berth: k && b.facing !== k ? { x: b.x, y: b.y, facing: k, ...at } : { x: b.x, y: b.y, ...at } })
                }}
              >
                {FACE_ARROW[n]}
              </button>
            ))}
          </div>
          {/* WHERE THE HULL PUTS SOMEBODY DOWN ONCE THEY ARE ASHORE. A berth is
              a position out on the water and says nothing about the inside of
              the island, so without this a voyage arrives at that map's default
              spawn and the dock somebody drew gets walked past. The list is the
              island's own anchors, which is the same registry aiming a berth
              already needed. */}
          <label className="world-f">
            <span>lands at</span>
            <select
              className="world-in"
              value={p.berth.at || ''}
              disabled={!p.map}
              title={p.map ? 'the anchor on that island the player stands on' : 'pick a map first'}
              onChange={(e) => {
                const b = p.berth as Pt
                const at = e.target.value
                set({ berth: { x: b.x, y: b.y, ...(b.facing ? { facing: b.facing } : {}), ...(at ? { at } : {}) } })
              }}
            >
              <option value="">the map&apos;s own spawn</option>
              {marks.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <div className="world-mark">
        <span className="world-mark-t" title="where the hull waits before it comes in">
          approach
        </span>
        <button
          className={'world-btn small' + (pick === 'approach' ? ' on' : '')}
          title="then click the water"
          onClick={() => onPick(pick === 'approach' ? '' : 'approach')}
        >
          {p.approach ? 'move' : 'set'}
        </button>
        {p.approach && (
          <button
            className="world-btn small"
            title="take the approach off"
            onClick={() => {
              onBefore()
              set({ approach: undefined })
            }}
          >
            ×
          </button>
        )}
      </div>
      {p.approach && (
        <div className="world-pair">
          <Num label="x" v={p.approach.x} on={(n) => set({ approach: { ...p.approach, x: n } as Pt })} />
          <Num label="y" v={p.approach.y} on={(n) => set({ approach: { ...p.approach, y: n } as Pt })} />
        </div>
      )}

      <Scrap what={p.name} sure={sure} onSure={onSure} onDrop={onDrop} />
    </div>
  )
}

/* TAKING SOMETHING OFF THE CHART ASKS ONCE.
 *
 * A single red button beside a form full of number fields is a mis-click away
 * from a berth somebody spent an afternoon aiming, and the row it deletes is
 * the one thing here nothing else can recover. Ctrl+Z reaches it too, so this
 * is the fence and undo is the net; the shape is the one the folder rail and
 * the folder tile already use. */
function Scrap({ what, sure, onSure, onDrop }: { what: string; sure: boolean; onSure: (v: boolean) => void; onDrop: () => void }) {
  if (!sure)
    return (
      <button className="world-btn danger" onClick={() => onSure(true)}>
        remove {what}
      </button>
    )
  return (
    <div className="world-sure">
      <button className="world-btn danger" onClick={onDrop}>
        remove
      </button>
      <button className="world-btn" onClick={() => onSure(false)}>
        keep
      </button>
    </div>
  )
}

function SeaPanel({
  r,
  kinds,
  sure,
  onSure,
  onEdit,
  onDrop,
}: {
  r: Region
  kinds: string[]
  sure: boolean
  onSure: (v: boolean) => void
  onEdit: (patch: Partial<Region>) => void
  onDrop: () => void
}) {
  const set = (n: number, v: number) => {
    const rect = [...r.rect] as [number, number, number, number]
    rect[n] = v
    onEdit({ rect })
  }
  return (
    <div className="world-insp">
      <span className="world-lab">water</span>
      <label className="world-f">
        <span>name</span>
        <input
          className={'world-in' + (isAnchorName(r.name) ? '' : ' bad')}
          value={r.name}
          spellCheck={false}
          maxLength={48}
          onChange={(e) => onEdit({ name: e.target.value })}
          onBlur={() => !isAnchorName(r.name) && onEdit({ name: anchorName(r.name) })}
        />
      </label>
      <label className="world-f">
        <span>kind</span>
        <select className="world-in" value={r.kind} onChange={(e) => onEdit({ kind: e.target.value })}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label className="world-f">
        <span>label</span>
        <input className="world-in" value={r.label || ''} maxLength={120} onChange={(e) => onEdit({ label: e.target.value })} />
      </label>
      {/* two opposite corners, the order the mask's own rect settled on, so one
          reader shape serves an anchor region and a sea region */}
      <div className="world-pair">
        <Num label="x0" v={r.rect[0]} on={(n) => set(0, n)} />
        <Num label="y0" v={r.rect[1]} on={(n) => set(1, n)} />
      </div>
      <div className="world-pair">
        <Num label="x1" v={r.rect[2]} on={(n) => set(2, n)} />
        <Num label="y1" v={r.rect[3]} on={(n) => set(3, n)} />
      </div>
      <Scrap what={r.name} sure={sure} onSure={onSure} onDrop={onDrop} />
    </div>
  )
}

function Num({ label, v, min, on }: { label: string; v: number; min?: number; on: (n: number) => void }) {
  return (
    <label className="world-f">
      <span>{label}</span>
      <input
        className="world-in"
        type="number"
        value={v}
        onChange={(e) => {
          const n = Number(e.target.value)
          on(Math.max(min ?? -1e9, Number.isFinite(n) ? Math.round(n) : 0))
        }}
      />
    </label>
  )
}

/* A NUMBER THAT WALKS TO WHERE IT WAS PUT instead of arriving there.
 *
 * Everything drawn on this page is drawn into a canvas, and a canvas has no
 * css to transition, so a selection appeared and vanished between two frames.
 * Small, but it is most of the difference between a chart being handled and a
 * form redrawing itself. Cubic on the way out, and no animation at all for
 * anybody who has asked the system for none. */
function useGlide(to: number, ms = 220) {
  const [v, setV] = useState(to)
  const from = useRef(to)
  useEffect(() => {
    if (calm()) {
      from.current = to
      setV(to)
      return
    }
    const a = from.current
    const t0 = performance.now()
    let id = 0
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      const n = a + (to - a) * (1 - (1 - k) ** 3)
      from.current = n
      setV(n)
      if (k < 1) id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [to, ms])
  return v
}
