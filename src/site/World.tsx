/* a coordinate space with maps drawn into it, and NO autosave: one world row serves the whole platform. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, go } from './router'
import { useSession } from './session'
import { anchorName, anchorShape, isAnchorName } from '../core/mask'
import { ANCHOR_INK, inkFor } from '../core/ink'
import { displayName } from '../core/naming'
import { MARK_KINDS, isMarkName, type MarkKind, type WorldMark } from '../core/world'
import './world.css'

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
  meta?: Record<string, unknown>
}
type Region = { name: string; kind: string; rect: [number, number, number, number]; label?: string }
/* every point on the water is one flat list, and belonging to an island is the island FIELD, not nesting. */
/* `home` is the slot a run with no vessel record starts in and the one a
 * graduate is handed back to. One name for the whole ocean, and the game had it
 * as a constant because nothing here could say it. */
/* the version this page read, sent back so the server refuses a stale overwrite that once won with a 200. */
type Doc = { w: number; h: number; places: Place[]; regions: Region[]; marks?: WorldMark[]; home?: string; updatedAt?: number }

/* What the registry hands back for one map. The x,y on an anchor is in that
 * map's OWN pixel raster, the same raster scene.png is published at, which is
 * what makes it drawable on this chart at all. */
/* THE AREA FIELDS ARE PART OF IT, because a region is not a circle. `shape` is
 * the mode the author chose, lifted off the anchor's meta bag by the registry,
 * and `rect` is two opposite corners the way the game reads them. */
type Anchor = {
  name: string
  kind: string
  x: number
  y: number
  r?: number
  to?: string
  label?: string
  shape?: string
  rect?: [number, number, number, number]
  poly?: [number, number][]
}
type MapRow = { slug: string; w: number; h: number; version: number | null; anchors?: Anchor[] }

type Sel = { kind: 'place' | 'region' | 'mark'; i: number } | null
/* WHICH CORNER OF A FOOTPRINT IS IN THE HAND. There was only ever one, and the
 * note under gripsOf says what changed. */
type Corner = 'nw' | 'ne' | 'sw' | 'se'
/* the shape a corner asks the pointer to wear. Two glyphs for four corners,
 * because a north west and a south east corner are pulled along the same
 * diagonal and the cursor is a picture of that diagonal. */
const CURSOR: Record<Corner, string> = { nw: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', se: 'nwse-resize' }
type Hit = { kind: 'place' | 'size' | 'region' | 'mark' | 'runin'; i: number; corner?: Corner } | null
type Band = { x0: number; y0: number; x1: number; y1: number } | null
/* berth replaces the mark tool and the two arm-then-click modes: one gesture, two incompatible shapes. */
type Tool = 'move' | 'place' | 'sea' | 'berth'
type Fit = { s: number; ox: number; oy: number }

/* the only hex in this file, because a 2d context cannot read a custom property. none is written below. */
const CHART_VOID = '#070b11' /* --void, and what is OUTSIDE the ocean */
const CHART_INK = '#e6e9ee' /* --ink */
const CHART_QUIET = '#7d8ea1' /* --ink-3, the text floor */
const CHART_EDGE = '#5b6470' /* --ink-edge. NOT TEXT: a tick, a boundary */
const CHART_ARMED = '#f0c869' /* --acc-tool-lit */
const CHART_TOOL = '#d4a53c' /* --acc-tool */
const CHART_BERTH = '#d0785f' /* --acc-mark */
const CHART_BERTH_LIT = '#e39b83' /* --acc-mark-lit */
const CHART_LIVE = '#6fbf9d' /* --acc-live */
const CHART_DEEP = '#8a6a1f' /* --acc-tool-deep */

/* one hue, the sea ramp by depth, plus gold for the tool, green for ready and coral for a berth, no fifth. */
const CHART_SEA = '#0b1626' /* --sea-deep, the water itself */
const CHART_SEA_EDGE = '#132437' /* --sea-rim, where the water stops */
const SEA_1 = '#44586c' /* --sea-1, the dimmest step somebody can read */
const SEA_2 = '#5d7891' /* --sea-2 */
const SEA_3 = '#86a6c2' /* --sea-3 */
const SEA_4 = '#a8cbe6' /* --sea-4, the brightest */
/* the graticule is the sea drawn lighter, and the majors came down from 0.17, louder than the art. */
const CHART_SEA_MINOR = 'rgba(122,164,204,0.045)'
const CHART_SEA_MAJOR = 'rgba(122,164,204,0.105)'
/* what a word on the water sits on. --void at the alpha that survives a lit
 * volcano underneath it, measured against the hub's own painting. */
const PLATE = 'rgba(7,11,17,0.84)'

/* one ink per state as a ramp of the sea, and the names come from the server so a new one falls back. */
const STATE_INK: Record<string, string> = {
  rumour: SEA_1,
  misty: SEA_2,
  discovered: SEA_3,
  // the one state the world owns rather than the student, and it is an EVENT:
  // an island coming up out of the water with an effect hung on it, so it is
  // the brightest step of the sea rather than a red from nowhere
  rising: SEA_4,
  available: CHART_LIVE,
  active: CHART_TOOL,
  completed: CHART_DEEP,
}
/* regions run on the same depth axis, and only the refusal leaves it, since a refusal is red everywhere. */
const SEA_INK: Record<string, string> = {
  sailable: '#14293c',
  shallow: '#1f4d5e',
  mist: '#33404f',
  forbidden: '#5a2418' /* --acc-stop sunk far enough to be a fill */,
  ambience: '#2a3a63',
}

/* anchor inks come from src/core/ink.ts, the one table both canvases read, after the two disagreed. */

/* a canvas takes a font string and cannot read a token, so these are the tokens.css steps by hand. */
const LABEL = (px: number) => `500 ${px}px "Archivo Narrow", sans-serif`
const MONO = '400 10px "Martian Mono", monospace'
const TINY = '400 9px "Martian Mono", monospace'
const PAD = 36

/* a name follows its island: a flat 11px drew a fifty pixel word over a ten pixel island at the floor. */
const LABEL_MIN = 10
const LABEL_MAX = 17
const LABEL_DROP = 30
/* handles drop below this: at the zoom floor three plates each wider than the island piled onto it. */
const GRIP_DROP = 44
// a fifth of the drawn width, fenced. A fifth is not arithmetic, it is what
// puts a five letter name across about the width of the island it names.
const nameAt = (rw: number) => Math.round(clamp(rw * 0.2, LABEL_MIN, LABEL_MAX))

// as far out as fitting the whole ocean, and as far in as one painted pixel
// filling a fat screen pixel. Anything past that is not more information.
const MAX_S = 48
const SNAP = 11

/* a ladder of named stops, not a multiplier: fixed factors walked 1.6, 2.6, 4.1, 6.6 and never 2 or 4. */
const STOPS = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48]

/* one chart unit is one painting pixel: born at 96 against a 688 painting, the live berth landed inland. */
const ISLAND_DEFAULT = 512
/* and the fences either side of it. Both were reachable with the handle: the
 * old resize collapsed the footprint to a single unit on the first frame of a
 * grab, and nothing at all stopped it swallowing a quarter of the chart. */
const ISLAND_MIN = 16
const ISLAND_MAX = 1024

/* gain of 1 so the grip is under the cursor: at 0.5 a 300 px drag left the corner 242 px behind. */
const RESIZE_GAIN = 1
const RESIZE_FINE = 0.2
// the grab radius of the corner handle, and half the square it is drawn as, so
// the hot spot and the picture of it cannot drift apart
const GRIP = 9

const NUDGE_FAR = 8
const UNDO_DEEP = 40
// how far the view walks toward where it was sent, per frame
const EASE = 0.22

const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/* the graticule pitch follows the zoom, not doc.w, which ruled lines 512 units apart. powers of two. */
const grat = (s: number) => {
  let v = 4096
  while (v * s > 130 && v > 1) v /= 2
  while (v * s < 46) v *= 2
  return v
}
/* every fourth line is heavy and carries its coordinate; only a power of two divides the pitch cleanly. */
const MAJOR = 4

/* comparing the whole document beats a dirty flag that only went up, and marks are in the comparison. */
const stamp = (d: Doc) => JSON.stringify({ w: d.w, h: d.h, places: d.places, regions: d.regions, marks: d.marks || [], home: d.home || '' })

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/* the ocean runs negative both ways, with a rumour shipped at y -260, so the fence is symmetric. */
const sea = (v: number, span: number) => clamp(Math.round(v), -span, span)
const side = (n: number) => clamp(Math.round(n), ISLAND_MIN, ISLAND_MAX)
const freeName = (stem: string, taken: string[]) => {
  let n = 1
  while (taken.includes(`${stem}_${n}`)) n++
  return `${stem}_${n}`
}

/* a place holding a map is exactly its canvas: a 128x119 box on a 688x640 painting put its berth inland. */
const bornAs = (m?: MapRow) => {
  if (!m || m.w <= 0 || m.h <= 0) return { w: ISLAND_DEFAULT, h: ISLAND_DEFAULT }
  return { w: m.w, h: m.h }
}

/* only rows 194 to 570 of the 688x640 hub are opaque, so the coast is drawn round the pixels. */
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

/* the drawing and the hit test read one geometry: a private rectangle sat 103 px off at 17x. */
type Art = Map<string, HTMLImageElement>

// the published picture this place draws with, or '' when there is no map or
// nothing has been published for it yet
const artKey = (p: Place, reg: Map<string, MapRow>) => {
  const m = p.map ? reg.get(p.map) : undefined
  return m && m.version ? `${p.map}@${m.version}` : ''
}

// where the paint sits inside the raster. The whole raster is the honest
// answer while the picture is still loading, which is also what an empty slot
// gets, because a position holding no bundle has no coast to draw round.
const skinAt = (p: Place, reg: Map<string, MapRow>, art: Art): Skin => {
  const key = artKey(p, reg)
  const img = key ? art.get(key) : undefined
  if (!img || !img.complete || !img.naturalWidth) return WHOLE
  return skinOf(key, img)
}

/* THE FOOTPRINT ON SCREEN, floored at three pixels. The floor is not cosmetic:
 * out at full extent an island is a couple of pixels across and a handle
 * smaller than its own outline is a handle nobody can land on. */
const boxOf = (p: Place, fit: Fit) => ({
  px: fit.ox + p.x * fit.s,
  py: fit.oy + p.y * fit.s,
  rw: Math.max(3, p.w * fit.s),
  rh: Math.max(3, p.h * fit.s),
})

// and the part of it the eye reads as the island
const skinBox = (p: Place, fit: Fit, sk: Skin) => {
  const b = boxOf(p, fit)
  return { px: b.px + sk.x0 * b.rw, py: b.py + sk.y0 * b.rh, rw: (sk.x1 - sk.x0) * b.rw, rh: (sk.y1 - sk.y0) * b.rh }
}

/* a corner pull is a scale about the corner you are NOT holding, so x,y and the berths move with it. */
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']
const gripsOf = (p: Place, fit: Fit, sk: Skin): { corner: Corner; gx: number; gy: number }[] => {
  /* no resize on a place with a painting: the box IS the raster, and scaling it beached the hub's berth. */
  if (p.map) return []
  const b = skinBox(p, fit, sk)
  if (b.rw < GRIP_DROP || b.rh < GRIP * 2 + 4) return []
  return CORNERS.map((c) => ({
    corner: c,
    gx: c === 'ne' || c === 'se' ? b.px + b.rw : b.px,
    gy: c === 'sw' || c === 'se' ? b.py + b.rh : b.py,
  }))
}
// which edges a corner owns, asked in three places and worth one reader
const eastOf = (c: Corner) => c === 'ne' || c === 'se'
const southOf = (c: Corner) => c === 'sw' || c === 'se'

/* fit what is on the water, not the 4096 ocean, which opened an island as an eleven pixel speck. */
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
  }
  for (const m of doc.marks || []) {
    x0 = Math.min(x0, m.x)
    y0 = Math.min(y0, m.y)
    x1 = Math.max(x1, m.x)
    y1 = Math.max(y1, m.y)
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

/* radOf answers east, south and north and sends everything else west, so the four come from the server. */
const BERTH_FACINGS = ['north', 'east', 'south', 'west']

/* anchors map through the registry's w/h, not the png's size, so a stale publish stretches the picture. */
const anchorAt = (p: Place, m: MapRow, a: Anchor) => ({
  x: p.x + (a.x / Math.max(1, m.w)) * p.w,
  y: p.y + (a.y / Math.max(1, m.h)) * p.h,
})

/* every point that says it belongs to this island, asked in six places, since a berth is a field now. */
const boundTo = (doc: Doc, name: string) => (doc.marks || []).filter((m) => m.island === name)

/* AND THE ONE THE GAME MEANS, which is the same rule berthOf keeps on the
 * server: the first berth-kind point bound to the island. The two have to agree
 * or the chart draws a leader to one dock and the ship sails to another. */
const berthOf = (doc: Doc, name: string) => (doc.marks || []).find((m) => m.island === name && m.kind === 'berth') || null

/* ---- the chart ----------------------------------------------------------- */

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

/* a name over a painting gets a filled plate; stroke-and-fill on a lit volcano could not be read. */
type Box = { x: number; y: number; w: number; h: number }
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

function paint(c: CanvasRenderingContext2D, size: { w: number; h: number }, sc: Scene) {
  const { doc, fit, sel, hover, band, reg, art, marks, aim, warm } = sc
  const X = (x: number) => fit.ox + x * fit.s
  const Y = (y: number) => fit.oy + y * fit.s

  // a label sitting on a painting was unreadable, so every word on this chart
  // gets a dark rim first and the fill second
  const say = (t: string, x: number, y: number, fill: string) => {
    c.lineJoin = 'round'
    c.lineWidth = 3
    c.strokeStyle = PLATE
    c.strokeText(t, x, y)
    c.lineWidth = 1
    c.fillStyle = fill
    c.fillText(t, x, y)
  }

  /* every label laid this frame, so the next can be moved: two names stack when two islands sit close. */
  const laid: Box[] = []

  /* anchor says which corner the x,y is, and it returns false when the words were dropped. */
  const plate = (t: string, x: number, y: number, fill: string, opt?: { rim?: string; mid?: boolean; keep?: boolean }) => {
    const pad = 4
    const m = c.measureText(t)
    const h = Math.round((m.actualBoundingBoxAscent || 8) + 5)
    const bx = Math.round((opt?.mid ? x - m.width / 2 : x) - pad)
    const by = Math.round(y - h + 2)
    const box = { x: bx, y: by, w: Math.round(m.width) + pad * 2, h: h + 3 }
    if (!opt?.keep && laid.some((b) => overlaps(box, b))) return false
    laid.push(box)
    c.fillStyle = PLATE
    c.beginPath()
    // 4, which is --r and what the editor's own plate() rounds a caption to. It
    // was 2 here, so the same door's name was a slightly sharper pill on the
    // chart than in the tool that made it, for no reason but two authors.
    c.roundRect(box.x, box.y, box.w, box.h, 4)
    c.fill()
    if (opt?.rim) {
      c.strokeStyle = opt.rim
      c.lineWidth = 1
      c.stroke()
    }
    c.fillStyle = fill
    c.fillText(t, box.x + pad, y)
    return true
  }

  c.fillStyle = CHART_VOID
  c.fillRect(0, 0, size.w, size.h)
  c.fillStyle = CHART_SEA
  c.fillRect(X(0), Y(0), doc.w * fit.s, doc.h * fit.s)

  /* clipped to the stage: at full zoom the whole ocean is 4096/8 lines, thrown away against the clip. */
  const step = grat(fit.s)
  const gx0 = Math.max(0, Math.floor((0 - fit.ox) / fit.s / step) * step)
  const gx1 = Math.min(doc.w, (size.w - fit.ox) / fit.s)
  const gy0 = Math.max(0, Math.floor((0 - fit.oy) / fit.s / step) * step)
  const gy1 = Math.min(doc.h, (size.h - fit.oy) / fit.s)
  const big = step * MAJOR
  const top = Math.max(0, Y(0))
  const bot = Math.min(size.h, Y(doc.h))
  const lft = Math.max(0, X(0))
  const rgt = Math.min(size.w, X(doc.w))
  for (const heavy of [false, true]) {
    c.strokeStyle = heavy ? CHART_SEA_MAJOR : CHART_SEA_MINOR
    c.lineWidth = 1
    c.beginPath()
    for (let x = Math.max(step, gx0); x < gx1; x += step) {
      if (x % big === 0 !== heavy) continue
      c.moveTo(Math.round(X(x)) + 0.5, top)
      c.lineTo(Math.round(X(x)) + 0.5, bot)
    }
    for (let y = Math.max(step, gy0); y < gy1; y += step) {
      if (y % big === 0 !== heavy) continue
      c.moveTo(lft, Math.round(Y(y)) + 0.5)
      c.lineTo(rgt, Math.round(Y(y)) + 0.5)
    }
    c.stroke()
  }
  /* the last thirty-four pixels of the left edge are the ruler's, where a y label drew 1792 over its 0. */
  c.font = TINY
  c.fillStyle = CHART_EDGE
  for (let x = Math.max(big, Math.ceil(gx0 / big) * big); x < gx1; x += big) c.fillText(String(x), Math.round(X(x)) + 3, Math.max(top + 10, 10))
  for (let y = Math.max(big, Math.ceil(gy0 / big) * big); y < gy1; y += big) {
    const ly = Math.round(Y(y)) - 3
    if (ly > size.h - 44) continue
    c.fillText(String(y), Math.max(lft + 3, 3), ly)
  }

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
    // the words a person reads, then the kind. A stretch of water carries the
    // same name/label split an island does and this printed the identifier.
    c.font = LABEL(11)
    plate(`${displayName(r, 'unnamed water').text} · ${r.kind}`, rx + 6, ry + 15, CHART_INK, { rim: tint })
  }

  /* two passes: paintings first, then everything you aim with, so a neighbour cannot swallow a berth. */
  const shot = (i: number) => {
    const p = doc.places[i]
    const key = artKey(p, reg)
    const img = key ? art.get(key) : undefined
    const { px, py, rw, rh } = boxOf(p, fit)
    const on = sel?.kind === 'place' && sel.i === i
    /* the hover has to be on an island: the lists index separately, so BERTH 0 lit ISLAND 0. */
    const lit = on || ((hover?.kind === 'place' || hover?.kind === 'size') && hover.i === i)
    const tint = inkFor(STATE_INK, p.state)

    if (img && img.complete && img.naturalWidth) {
      /* the state ink backs the painting only under about twenty six screen pixels, or it hides the coast. */
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

    /* the outline goes round the picture, since a third of the hub's png is transparent margin. */
    const seen = skinBox(p, fit, skinAt(p, reg, art))
    c.setLineDash(p.map ? [] : [4, 3])
    c.strokeStyle = on ? CHART_ARMED : tint
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
    const key = artKey(p, reg)
    const img = key ? art.get(key) : undefined
    const drawn = !!img?.naturalWidth
    const on = sel?.kind === 'place' && sel.i === i
    /* the hover has to be on an island: the lists index separately, so BERTH 0 lit ISLAND 0. */
    const lit = on || ((hover?.kind === 'place' || hover?.kind === 'size') && hover.i === i)
    const tint = inkFor(STATE_INK, p.state)
    const { px, py, rw } = boxOf(p, fit)
    const sk = skinAt(p, reg, art)
    const seen = skinBox(p, fit, sk)

    /* one gold outline and four grips, and the ring is from x,y because checkWorld measures from there. */
    if (lit) {
      c.beginPath()
      c.arc(px, py, p.release * fit.s, 0, Math.PI * 2)
      c.strokeStyle = tint
      c.globalAlpha = on ? 0.45 * warm : 0.25
      c.setLineDash([3, 5])
      c.stroke()
      c.setLineDash([])
      c.globalAlpha = 1
    }

    /* the map's own marks, held back until nine dots are not one smear across a fourteen pixel island. */
    if (m && marks && rw > 54) {
      const named = rw > 130
      for (const a of m.anchors || []) {
        const w = anchorAt(p, m, a)
        const ax = X(w.x)
        const ay = Y(w.y)
        const key = `${p.name}/${a.name}`
        const hot = aim === key
        const ink = inkFor(ANCHOR_INK, a.kind)
        /* anchorShape is the one answer to which shape is live, shared with the form and both exporters. */
        const spot = (mx: number, my: number) => ({
          x: X(p.x + (mx / Math.max(1, m.w)) * p.w),
          y: Y(p.y + (my / Math.max(1, m.h)) * p.h),
        })
        const shape = anchorShape(a)
        c.strokeStyle = ink
        c.globalAlpha = 0.3
        if (shape === 'poly' && a.poly) {
          c.beginPath()
          a.poly.forEach(([mx, my], n) => {
            const q = spot(mx, my)
            if (n) c.lineTo(q.x, q.y)
            else c.moveTo(q.x, q.y)
          })
          c.closePath()
          c.stroke()
        } else if (shape === 'rect' && a.rect) {
          const [x0, y0, x1, y1] = a.rect
          const nw = spot(Math.min(x0, x1), Math.min(y0, y1))
          const se = spot(Math.max(x0, x1), Math.max(y0, y1))
          c.strokeRect(nw.x, nw.y, se.x - nw.x, se.y - nw.y)
        } else if (a.r) {
          c.beginPath()
          c.arc(ax, ay, (a.r / Math.max(1, m.w)) * p.w * fit.s, 0, Math.PI * 2)
          c.stroke()
        }
        c.globalAlpha = 1
        c.beginPath()
        c.arc(ax, ay, hot ? 6 : 3.6, 0, Math.PI * 2)
        c.lineWidth = 3
        c.strokeStyle = PLATE
        c.stroke()
        c.lineWidth = hot ? 2 : 1.4
        c.strokeStyle = hot ? CHART_ARMED : ink
        c.stroke()
        c.lineWidth = 1
        /* on a plate above the mark and centred, where the editor hangs it, and it gives way to a plate. */
        if (named || hot) {
          c.font = LABEL(nameAt(rw))
          // rimmed in the mark's own ink whether it is hot or not, which is
          // what the editor draws. A rim only on hover meant a door was a
          // bordered pill in one tool and a bare one in the other.
          plate(displayName(a).text, ax, ay - 8, hot ? CHART_ARMED : ink, { rim: hot ? CHART_ARMED : ink, keep: hot, mid: true })
        }
      }
    }

    /* the only thing left saying a point belongs to this island, now that the two are separate rows. */
    for (const k of boundTo(doc, p.name)) {
      /* at rest it starts on the drawn coast; under the hand it returns to x,y, where the ring is centred. */
      const bx = X(k.x)
      const by = Y(k.y)
      const from = lit
        ? { x: px, y: py }
        : { x: clamp(bx, seen.px, seen.px + seen.rw), y: clamp(by, seen.py, seen.py + seen.rh) }
      c.beginPath()
      c.moveTo(from.x, from.y)
      c.lineTo(bx, by)
      c.strokeStyle = lit ? CHART_TOOL : CHART_BERTH
      c.globalAlpha = on ? 0.5 : lit ? 0.28 : 0.34
      c.setLineDash([2, 3])
      c.stroke()
      c.setLineDash([])
      c.globalAlpha = 1
      /* the tether says what it measures and in what, and is dropped where it is shorter than its plate. */
      if (on && rw >= GRIP_DROP) {
        c.font = TINY
        // two thirds of the way out rather than halfway, because halfway on a
        // short tether is on top of the island the tether starts at
        plate(
          `${Math.round(Math.hypot(k.x - p.x, k.y - p.y))} u out`,
          px + (X(k.x) - px) * 0.66,
          py + (Y(k.y) - py) * 0.66,
          CHART_ARMED,
          { mid: true },
        )
      }
    }

    /* the name sits on the coast, not the raster top, and it is one line: the slug is in the panel. */
    /* displayName, not p.title || p.name, which painted the_hub across the chart; the roster agrees. */
    const title = displayName(p, 'unnamed').text
    /* dropped under LABEL_DROP, where the hub is ten screen pixels and a flat 11 px name was fifty. */
    if (rw >= LABEL_DROP || lit) {
      const fs = nameAt(rw)
      c.font = LABEL(fs)
      // the state, as a chip, once the footprint stopped being a slab of state
      // ink you could read it off. Only where a painting took that job away.
      const chip = drawn ? fs : 0
      const above = seen.py - 7 > 22
      const ly = above ? seen.py - 7 : seen.py + seen.rh + fs + 4
      // above first, then below, then give up. A name in the wrong place is
      // recoverable by moving the chart; two names on top of each other is not.
      const put =
        plate(title, seen.px + chip, ly, on ? CHART_ARMED : CHART_INK, { rim: on ? CHART_ARMED : undefined, keep: on }) ||
        plate(title, seen.px + chip, seen.py + seen.rh + fs + 4, on ? CHART_ARMED : CHART_INK)
      if (put && chip) {
        const cy = laid[laid.length - 1].y
        c.fillStyle = tint
        c.fillRect(seen.px - 1, cy + 3, fs - 5, fs - 5)
      }
    }

    /* gripsOf is the only thing that knows where these are, and under() asks it, after a 103 px drift. */
    const hands = on ? gripsOf(p, fit, sk) : []
    for (const { gx, gy } of hands) {
      const g = 4
      c.globalAlpha = 0.35 + 0.65 * warm
      c.fillStyle = CHART_VOID
      c.fillRect(gx - g - 1, gy - g - 1, g * 2 + 2, g * 2 + 2)
      c.fillStyle = CHART_ARMED
      c.fillRect(gx - g, gy - g, g * 2, g * 2)
      c.globalAlpha = 1
    }
    const foot = hands.find((h) => h.corner === 'se')
    if (foot) {
      // beside the south east one, which is where a size readout has always
      // sat and the corner least likely to have the rail behind it
      const { gx, gy } = foot
      /* the size plate carries its unit, and flips sides when a drag toward the rail would hide it. */
      c.font = TINY
      const worth = `${p.w} × ${p.h} u`
      const wide = c.measureText(worth).width + 8
      const right = gx + GRIP + 3
      plate(worth, right + wide > size.w ? gx - GRIP - 3 - wide : right, gy + GRIP + 5, CHART_ARMED, { keep: true })
    }
  }

  for (let i = 0; i < doc.places.length; i++) shot(i)
  // the second pass always runs. Only the map's OWN anchors answer to the marks
  // toggle, inside rig: a button labelled "marks" that also took away the berth
  // and the island's name is a button nobody would press twice.
  for (let i = 0; i < doc.places.length; i++) rig(i)

  /* one ring, one coral, drawn in screen pixels: in world units it is a grain out and a plate zoomed in. */
  for (let i = 0; i < (doc.marks || []).length; i++) {
    const k = (doc.marks as WorldMark[])[i]
    const mx = X(k.x)
    const my = Y(k.y)
    const on = sel?.kind === 'mark' && sel.i === i
    const lit = on || (hover?.kind === 'mark' && hover.i === i)
    // coral, and gold only while it is the thing in your hand: the same rule the
    // anchors on a painting follow two hundred lines up
    const tint = on ? CHART_ARMED : lit ? CHART_BERTH_LIT : CHART_BERTH
    /* the arrival radius is drawn only while this berth is talked about, not always over open water. */
    /* the run-in is hollow and the berth solid, since the hull passes one and stops at the other. */
    if (k.approach) {
      const ax = X(k.approach.x)
      const ay = Y(k.approach.y)
      // hover and nothing else, and it holds through a drag: move() returns
      // early while something is in the hand, so the last hit stays the last hit
      // and the run-in keeps the gold it was grabbed with
      const hotA = hover?.kind === 'runin' && hover.i === i
      const aTint = hotA ? CHART_ARMED : lit ? CHART_BERTH_LIT : CHART_BERTH
      c.beginPath()
      c.moveTo(ax, ay)
      c.lineTo(mx, my)
      c.strokeStyle = aTint
      c.globalAlpha = lit ? 0.75 : 0.4
      c.setLineDash([4, 3])
      c.stroke()
      c.setLineDash([])
      c.globalAlpha = 1
      /* a diamond and not a second coral ring, or the two marks are told apart only by reading their size. */
      c.save()
      c.translate(ax, ay)
      c.rotate(Math.PI / 4)
      c.lineWidth = 3.4
      c.strokeStyle = PLATE
      c.strokeRect(-4, -4, 8, 8)
      c.lineWidth = hotA ? 2 : 1.4
      c.strokeStyle = aTint
      c.strokeRect(-4, -4, 8, 8)
      c.restore()
      c.lineWidth = 1
      /* named only while its berth is looked at, and with the word for what it is: it has no name. */
      if (lit || hotA) {
        c.font = LABEL(nameAt(LABEL_DROP))
        plate('run-in', ax, ay - 12, aTint, { rim: aTint, keep: hotA, mid: true })
      }
    }
    if (k.r && lit) {
      c.beginPath()
      c.arc(mx, my, k.r * fit.s, 0, Math.PI * 2)
      c.strokeStyle = tint
      c.globalAlpha = on ? 0.45 : 0.28
      c.setLineDash([3, 5])
      c.stroke()
      c.setLineDash([])
      c.globalAlpha = 1
    }
    /* THE HEADING HELD HERE, as a spur off the ring. It was drawn only for a
     * place's own berth, so a free point could carry a facing, save it, hand it
     * to a grape and show nothing at all for it. */
    const face = k.facing || ''
    const dx = face.includes('east') ? 1 : face.includes('west') ? -1 : 0
    const dy = face.includes('south') ? 1 : face.includes('north') ? -1 : 0
    if (dx || dy) {
      const n = Math.hypot(dx, dy)
      c.beginPath()
      c.moveTo(mx + (dx / n) * 6, my + (dy / n) * 6)
      c.lineTo(mx + (dx / n) * 15, my + (dy / n) * 15)
      c.lineWidth = 3.6
      c.strokeStyle = PLATE
      c.stroke()
      c.lineWidth = 1.6
      c.strokeStyle = tint
      c.stroke()
      c.lineWidth = 1
    }
    c.beginPath()
    c.arc(mx, my, 5.5, 0, Math.PI * 2)
    c.lineWidth = 3.4
    c.strokeStyle = PLATE
    c.stroke()
    c.lineWidth = on ? 2 : 1.4
    c.strokeStyle = tint
    c.stroke()
    // a filled centre on the one that is bound to an island, which is the only
    // difference between two berths that a person needs on the chart: this one
    // is somebody's dock, that one is a corner in open water
    if (k.island) {
      c.beginPath()
      c.arc(mx, my, 2.2, 0, Math.PI * 2)
      c.fillStyle = tint
      c.fill()
    }
    c.lineWidth = 1
    /* a berth's name follows the zoom, since a point has no footprint, and goes above, below, dropped. */
    const fs = nameAt(Math.max(LABEL_DROP, (k.r || 24) * 2 * fit.s))
    c.font = LABEL(on ? fs + 2 : fs)
    const word = displayName(k, 'unnamed berth').text
    plate(word, mx, my - 10, tint, { rim: tint, keep: lit, mid: true }) || plate(word, mx, my + 22, tint, { rim: tint, mid: true })
  }

  if (band) {
    c.setLineDash([4, 3])
    c.strokeStyle = CHART_TOOL
    c.strokeRect(X(Math.min(band.x0, band.x1)), Y(Math.min(band.y0, band.y1)), Math.abs(band.x1 - band.x0) * fit.s, Math.abs(band.y1 - band.y0) * fit.s)
    c.setLineDash([])
  }

  /* the edge of the world last, in the sea's own rim, because gold is the tool speaking about a tool. */
  c.strokeStyle = CHART_SEA_EDGE
  c.lineWidth = 1
  c.strokeRect(X(0) + 0.5, Y(0) + 0.5, doc.w * fit.s, doc.h * fit.s)
  c.font = MONO
  say('0,0', X(0), Y(0) - 6, CHART_QUIET)
  const end = `${doc.w},${doc.h}`
  say(end, X(doc.w) - c.measureText(end).width, Y(doc.h) + 14, CHART_QUIET)

  /* the ruler is one graticule square wide and says so, so the grid is the ruler repeated. */
  /* the gutter fits the number under the first tick: at sixteen in, the 0's plate ran off the stage. */
  const rx = 22
  const ry = size.h - 26
  const rl = step * fit.s
  c.strokeStyle = CHART_QUIET
  c.lineWidth = 1
  c.beginPath()
  c.moveTo(rx + 0.5, ry - 6)
  c.lineTo(rx + 0.5, ry + 0.5)
  c.lineTo(rx + rl + 0.5, ry + 0.5)
  c.lineTo(rx + rl + 0.5, ry - 6)
  c.moveTo(rx + rl / 2 + 0.5, ry + 0.5)
  c.lineTo(rx + rl / 2 + 0.5, ry - 4)
  c.stroke()
  c.font = TINY
  c.textAlign = 'center'
  c.fillStyle = CHART_QUIET
  c.fillText('0', rx, ry + 12)
  c.fillText(String(step / 2), rx + rl / 2, ry + 12)
  c.textAlign = 'left'
  c.fillText(`${step} world units`, rx + rl + 7, ry + 3)
}

/* tested in the order things are drawn, and a region is last or it swallows every click. */
function under(doc: Doc, fit: Fit, sel: Sel, mx: number, my: number, skin: (p: Place) => Skin): Hit {
  const X = (x: number) => fit.ox + x * fit.s
  const Y = (y: number) => fit.oy + y * fit.s
  const near = (x: number, y: number, r: number) => Math.hypot(mx - X(x), my - Y(y)) <= r

  /* corners through the function that draws them, after a private one sat 103 px off at 17x. */
  const chosen = sel?.kind === 'place' ? doc.places[sel.i] : undefined
  if (chosen && sel?.kind === 'place') {
    for (const g of gripsOf(chosen, fit, skin(chosen)))
      if (Math.abs(mx - g.gx) <= GRIP && Math.abs(my - g.gy) <= GRIP) return { kind: 'size', i: sel.i, corner: g.corner }
  }
  /* every point in one loop: a bound berth answered at nine pixels and a free one at ten. */
  const list = doc.marks || []
  for (let i = list.length - 1; i >= 0; i--) if (near(list[i].x, list[i].y, 10)) return { kind: 'mark', i }
  /* the run-in is grabbable only on the selected berth, and tested after them: a fresh one overlaps. */
  if (sel?.kind === 'mark') {
    const m = list[sel.i]
    if (m?.approach && near(m.approach.x, m.approach.y, 9)) return { kind: 'runin', i: sel.i }
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
  /* the kinds come from the server, because cleanMark silently falls an unknown one back to berth. */
  const [markKinds, setMarkKinds] = useState<string[]>([])
  const [reg, setReg] = useState<Map<string, MapRow>>(new Map())
  const [why, setWhy] = useState('')
  const [sel, setSel] = useState<Sel>(null)
  const [tool, setTool] = useState<Tool>('move')
  const [hover, setHover] = useState<Hit>(null)
  /* WHAT IS ACTUALLY IN THE HAND, as state and not as the ref the drag lives
   * in. The ref cannot make the cursor change, because writing a ref does not
   * render, so the shape was frozen for the whole of a press. */
  const [hand, setHand] = useState<'' | 'pan' | 'place' | 'mark' | 'runin' | Corner>('')
  const [band, setBand] = useState<Band>(null)
  /* the tool's line rides off the pointer: at top centre it was 500 px from the button and the water. */
  const [nib, setNib] = useState({ x: 14, y: 12 })
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
  /* whose water and whether it is the game's row are two questions since 022; mine is null until asked. */
  const [mine, setMine] = useState<boolean | null>(null)
  const [game, setGame] = useState(true)
  /* api.mjs is the only thing that knows the game's row is pinned to id 1, so the url is not rebuilt. */
  const [readUrl, setReadUrl] = useState('')

  const box = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const art = useRef<Art>(new Map())
  const drag = useRef<{
    kind: 'place' | 'size' | 'mark' | 'runin'
    i: number
    dx: number
    dy: number
    mx: number
    my: number
    /* every resize frame is computed from the grab, or rounding feeds back and the footprint walks off. */
    p?: Place
    /* the berths are snapshotted at the same moment, or each frame rescales the last one. */
    m0?: WorldMark[]
    corner?: Corner
  } | null>(null)
  const pan = useRef<{ mx: number; my: number; ox: number; oy: number; far: number } | null>(null)
  const bandFrom = useRef<{ x: number; y: number } | null>(null)
  // the documents to go back to, newest last. Held in a ref because nothing
  // renders from the stack itself, only from how deep it is.
  const past = useRef<Doc[]>([])
  const live = useRef<Doc | null>(null)
  live.current = doc
  const nudged = useRef(0)
  // the row the server last agreed to. Undo compares against this rather than
  // leaving the dirty flag stuck up, and it is set from what came BACK from a
  // save so it is the server's copy and not a hopeful one.
  const saved = useRef('')
  // the inspector's own scroller, so a fresh selection starts at the name.
  // Not called `side`, which is the footprint clamp this file already has and
  // which the resize handle calls four lines into a drag.
  const panel = useRef<HTMLElement>(null)

  /* one request answers the water and the ownership, and a 401 is signed out rather than an error. */
  useEffect(() => {
    if (loading) return
    let live = true
    fetch('/api/world')
      .then(async (r) => {
        if (r.status === 401) return null
        if (!r.ok) throw new Error(`the water would not load (${r.status})`)
        return (await r.json()) as Doc & {
          states?: string[]
          seaKinds?: string[]
          markKinds?: string[]
          game?: boolean
          readUrl?: string
        }
      })
      .then((j) => {
        if (!live) return
        if (!j) {
          setMine(false)
          return
        }
        const fresh: Doc = { w: j.w, h: j.h, places: j.places || [], regions: j.regions || [], marks: j.marks, home: j.home || '', updatedAt: j.updatedAt }
        saved.current = stamp(fresh)
        setDoc(fresh)
        setStates(j.states || [])
        setKinds(j.seaKinds || [])
        setMarkKinds(j.markKinds || [])
        // a deploy older than 022 sends neither, and the game's ocean is what it
        // served then, so that is what the missing answer means
        setGame(j.game !== false)
        setReadUrl(j.readUrl || '/api/v1/world')
        setMine(true)
      })
      .catch((e) => {
        if (!live) return
        setWhy(String((e as Error).message || e))
        setMine(true)
      })
    return () => {
      live = false
    }
  }, [loading])

  /* asked with=anchors, the one request carrying the door graph; empty stays offered for a rumour. */
  useEffect(() => {
    fetch('/api/v1/maps?with=anchors')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { maps?: MapRow[] }) => setReg(new Map((j.maps || []).map((m) => [m.slug, m]))))
      .catch(() => setReg(new Map()))
  }, [])

  /* footprints are corrected at the load, not on inspector mount, where reading a name lit the save. */
  const squared = useRef(false)
  useEffect(() => {
    if (squared.current || !doc || !reg.size) return
    squared.current = true
    let moved = false
    const places = doc.places.map((p) => {
      const m = p.map ? reg.get(p.map) : undefined
      if (!m || m.w <= 0 || m.h <= 0) return p
      const want = side((p.w * m.h) / m.w)
      if (want === p.h) return p
      moved = true
      return { ...p, h: want }
    })
    if (!moved) return
    const put = { ...doc, places }
    // only folded in while the document still matches the server's, or a slow registry eats a drag
    if (stamp(doc) === saved.current) saved.current = stamp(put)
    setDoc(put)
  }, [doc, reg])

  /* kept by slug and version, and a failure is left in the map or a 404 refetches every repaint. */
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

  /* both gates: the stage enters the dom only once the world answers, or it measures 0x0 at scale 1. */
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

  // one eased number, because a canvas has no css to transition and the ring blinked into existence
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

  /* the view is chased, not set: want is where it is sent, here is what is painted, a fifth a frame. */
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

  /* zoom about a point, measured from where the view is going, or three notches come out as one. */
  const zoomAt = useCallback(
    (mx: number, my: number, k: number) => {
      const f = want.current || here.current || base
      const s = clamp(f.s * k, base.s, MAX_S)
      if (Math.abs(s - f.s) < 1e-9) return
      /* at the floor the ocean goes back in the middle, since there the anchor only slides the water. */
      if (s <= base.s * 1.0001) return glide(base)
      glide({ s, ox: mx - (mx - f.ox) * (s / f.s), oy: my - (my - f.oy) * (s / f.s) })
    },
    [base, glide],
  )

  /* one press is one rung: a fixed factor walked 1.6, 2.6, 4.1, 6.6 and never landed on 2, 4 or 8. */
  const rung = useCallback(
    (dir: 1 | -1, mx: number, my: number) => {
      const f = want.current || here.current || base
      const rungs = [base.s, ...STOPS.filter((v) => v > base.s * 1.02 && v <= MAX_S)]
      const next = dir > 0 ? rungs.find((v) => v > f.s * 1.02) : [...rungs].reverse().find((v) => v < f.s * 0.98)
      if (next === undefined) return
      zoomAt(mx, my, next / f.s)
    },
    [base, zoomAt],
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

  /* base stays the whole ocean as the zoom floor, and the opening view is written out, not null. */
  const frameAll = useCallback(() => {
    if (!doc || !size.w || !size.h) return
    const b = contentBox(doc)
    if (!b) return glide(base)
    const s = clamp(Math.min((size.w - PAD * 2) / b.w, (size.h - PAD * 2) / b.h), base.s, MAX_S)
    glide({ s, ox: size.w / 2 - (b.x + b.w / 2) * s, oy: size.h / 2 - (b.y + b.h / 2) * s })
  }, [doc, size, base, glide])

  /* and the whole ocean, which was reachable no other way than pressing minus until it stopped. */
  const frameSea = useCallback(() => glide(base), [base, glide])

  /* keyed on which row is selected, not its contents, so typing does not throw the panel to the top. */
  useEffect(() => {
    if (sel) panel.current?.scrollTo({ top: 0 })
  }, [sel?.kind, sel?.i])

  /* a refusal is scrolled into view: it is drawn at the top of the same scroller, above the fold. */
  useEffect(() => {
    if (problems.length) panel.current?.scrollTo({ top: 0 })
  }, [problems])

  // once, when the water first arrives with something on it
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || !doc || !size.w || !doc.places.length) return
    opened.current = true
    frameAll()
  }, [doc, size, frameAll])

  const place = doc && sel?.kind === 'place' ? doc.places[sel.i] : null
  const region = doc && sel?.kind === 'region' ? doc.regions[sel.i] : null
  const spot = doc && sel?.kind === 'mark' ? (doc.marks || [])[sel.i] : null
  const sheet = place && place.map ? reg.get(place.map) : undefined

  // fill the stage with the selected island and everything tied to it, which is
  // the one move that gets you from the whole ocean to a jetty
  const frame = useCallback(() => {
    if (!size.w) return
    // a mark has no footprint, so what is framed round it is its own reach: the
    // radius that decides a hull has arrived, with room either side of it
    if (spot) {
      const r = Math.max(24, (spot.r || 40) * 3)
      const s = clamp(Math.min((size.w - PAD * 3) / (r * 2), (size.h - PAD * 3) / (r * 2)), base.s, MAX_S)
      return glide({ s, ox: size.w / 2 - spot.x * s, oy: size.h / 2 - spot.y * s })
    }
    if (!place || !doc) return
    let x0 = place.x
    let y0 = place.y
    let x1 = place.x + place.w
    let y1 = place.y + place.h
    // and everything tied to it, which is what turns "frame this island" into
    // "show me this island and the dock somebody has to reach"
    for (const m of boundTo(doc, place.name)) {
      x0 = Math.min(x0, m.x)
      y0 = Math.min(y0, m.y)
      x1 = Math.max(x1, m.x)
      y1 = Math.max(y1, m.y)
    }
    const mw = Math.max(8, x1 - x0)
    const mh = Math.max(8, y1 - y0)
    const s = clamp(Math.min((size.w - PAD * 3) / mw, (size.h - PAD * 3) / mh), base.s, MAX_S)
    glide({ s, ox: size.w / 2 - (x0 + mw / 2) * s, oy: size.h / 2 - (y0 + mh / 2) * s })
  }, [place, spot, doc, size, base.s, glide])

  /* the hint looks the label up rather than unpacking the id: an apostrophe cannot survive an identifier. */
  const aimSaid = useMemo(() => {
    if (!aim || !doc) return ''
    const [isle, mark] = aim.split('/')
    const m = reg.get(doc.places.find((p) => p.name === isle)?.map || '')
    return displayName(m?.anchors?.find((a) => a.name === mark) || mark).text
  }, [aim, doc, reg])

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

  /* undo keeps whole documents, and remember() runs once a gesture, so a drag is one step. */
  const remember = useCallback(() => {
    const d = live.current
    if (!d) return
    past.current = [...past.current.slice(1 - UNDO_DEEP), d]
    setDepth(past.current.length)
  }, [])

  /* a step back keeps the selection, letting go only an index the restored document no longer has. */
  const undo = useCallback(() => {
    const back = past.current.pop()
    setDepth(past.current.length)
    if (!back) return
    setDoc(back)
    setSel((s) => {
      if (!s) return s
      const len = s.kind === 'place' ? back.places.length : s.kind === 'region' ? back.regions.length : (back.marks || []).length
      return s.i < len ? s : null
    })
    setSure(false)
    setDirty(stamp(back) !== saved.current)
  }, [])

  const edit = useCallback((i: number, patch: Partial<Place>) => {
    setDoc((d) => {
      if (!d) return d
      const was = d.places[i]
      const places = d.places.map((p, k) => (k === i ? { ...p, ...patch } : p))
      /* a rename cascades: island on a berth and home on the document hold this string. */
      const to = patch.name
      if (to === undefined || !was || to === was.name || !isAnchorName(was.name)) return { ...d, places }
      return {
        ...d,
        places,
        marks: (d.marks || []).map((m) => (m.island === was.name ? { ...m, island: to } : m)),
        home: d.home === was.name ? to : d.home,
      }
    })
    setDirty(true)
  }, [])

  /* moving a berth carries its run-in, and only when the patch moves it: an absent y reads as zero. */
  const editMark = useCallback((i: number, patch: Partial<WorldMark>) => {
    setDoc((d) => {
      if (!d) return d
      return {
        ...d,
        marks: (d.marks || []).map((m, k) => {
          if (k !== i) return m
          const next = { ...m, ...patch }
          const dx = (patch.x ?? m.x) - m.x
          const dy = (patch.y ?? m.y) - m.y
          // `approach` in the patch is the run-in being set or cleared on
          // purpose, and shifting what was just typed would fight the author
          if (m.approach && !('approach' in patch) && (dx || dy))
            next.approach = { x: m.approach.x + dx, y: m.approach.y + dy }
          return next
        }),
      }
    })
    setDirty(true)
  }, [])

  /* one place a berth is born, named off its island and checked against every name on the ocean. */
  const addBerth = useCallback(
    (x: number, y: number, to?: { island: string; at?: string }) => {
      const d = live.current
      if (!d) return
      const taken = [...d.places.map((p) => p.name), ...d.regions.map((r) => r.name), ...(d.marks || []).map((k) => k.name)]
      const stem = to ? `${to.island}_berth`.slice(0, 48) : 'berth'
      let name = to && !taken.includes(stem) ? stem : ''
      if (!name) {
        let n = to ? 2 : 1
        while (taken.includes(`${stem.slice(0, 45)}_${n}`)) n++
        name = `${stem.slice(0, 45)}_${n}`
      }
      const made: WorldMark = {
        name,
        kind: 'berth',
        x: sea(x, d.w),
        y: sea(y, d.h),
        // a label from the start, so a berth never reaches a player as `berth_1`.
        // Every point carries one, not just the islands.
        label: displayName({ name }).text,
        // how close counts as arrived, because a hull moves in floats and an
        // exact-pixel test on one never fires. The order of size a dock sits at
        // off a jetty.
        r: 40,
        ...(to ? { island: to.island } : {}),
        ...(to?.at ? { at: to.at } : {}),
      }
      remember()
      setDoc({ ...d, marks: [...(d.marks || []), made] })
      setSel({ kind: 'mark', i: (d.marks || []).length })
      setSure(false)
      setDirty(true)
    },
    [remember],
  )
  const dropMark = useCallback(
    (i: number) => {
      remember()
      setDoc((d) => (d ? { ...d, marks: (d.marks || []).filter((_, k) => k !== i) } : d))
      setSel(null)
      setSure(false)
      setDirty(true)
    },
    [remember],
  )

  /* an island carries its bound berths, in one setDoc or a frame shows the dock left behind. */
  const shift = useCallback((i: number, x: number, y: number) => {
    setDoc((d) => {
      if (!d) return d
      const p = d.places[i]
      if (!p) return d
      const nx = sea(x, d.w)
      const ny = sea(y, d.h)
      const dx = nx - p.x
      const dy = ny - p.y
      if (!dx && !dy) return d
      return {
        ...d,
        places: d.places.map((q, k) => (k === i ? { ...q, x: nx, y: ny } : q)),
        // and a bound berth's run-in goes by the same dx and dy, or it stands in the old water
        marks: (d.marks || []).map((m) =>
          m.island === p.name
            ? { ...m, x: m.x + dx, y: m.y + dy, ...(m.approach ? { approach: { x: m.approach.x + dx, y: m.approach.y + dy } } : {}) }
            : m,
        ),
      }
    })
    setDirty(true)
  }, [])

  /* THE SAME READING OF THE PICTURE THE CHART DRAWS WITH, handed to every hit
   * test. skinOf caches by slug and version, so this is a map lookup and not
   * an alpha scan per pointer move. */
  const skin = useCallback((p: Place) => skinAt(p, reg, art.current), [reg])

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { mx: e.clientX - r.left, my: e.clientY - r.top }
  }
  const toWorld = (mx: number, my: number) => ({ x: (mx - fit.ox) / fit.s, y: (my - fit.oy) / fit.s })

  /* an eleven pixel snap to any island's anchor, and what it snaps to decides which island binds. */
  const aimed = useCallback(
    (mx: number, my: number) => {
      if (!doc || !marks) return null
      for (const p of doc.places) {
        const m = p.map ? reg.get(p.map) : undefined
        if (!m || p.w * fit.s <= 54) continue
        for (const a of m.anchors || []) {
          const w = anchorAt(p, m, a)
          if (Math.hypot(mx - (fit.ox + w.x * fit.s), my - (fit.oy + w.y * fit.s)) <= SNAP) return { p, a, w }
        }
      }
      return null
    },
    [doc, reg, marks, fit],
  )

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!doc) return
    const { mx, my } = at(e)
    const w = toWorld(mx, my)
    // capture so a drag off the stage keeps reporting, and swallowed: a throw here kills the press
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* the press still works uncaptured */
    }

    // the middle button pans whatever tool is up, the way it does in every
    // other canvas anybody has used
    if (e.button === 1) {
      pan.current = { mx, my, ox: fit.ox, oy: fit.oy, far: 0 }
      setHand('pan')
      return
    }

    if (tool === 'place') {
      const name = freeName('island', doc.places.map((p) => p.name))
      // one size, every time, and the painting bends the short side later.
      // Born 64x64 it depended on nothing and looked like nothing.
      const born = bornAs()
      const made: Place = {
        name,
        map: '',
        title: '',
        /* the click is the middle of the new island: anchoring x,y there put most of it off the view. */
        x: sea(w.x - born.w / 2, doc.w),
        y: sea(w.y - born.h / 2, doc.h),
        ...born,
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

    /* a berth is one press anywhere on the water, and landing on an anchor sets island and at together. */
    if (tool === 'berth') {
      const hitA = aimed(mx, my)
      addBerth(
        hitA ? Math.round(hitA.w.x) : w.x,
        hitA ? Math.round(hitA.w.y) : w.y,
        hitA ? { island: hitA.p.name, at: hitA.a.name } : undefined,
      )
      setTool('move')
      return
    }

    const hit = under(doc, fit, sel, mx, my, skin)
    if (!hit) {
      /* empty water drags the chart, and deselects only when the pointer did not really move. */
      pan.current = { mx, my, ox: fit.ox, oy: fit.oy, far: 0 }
      setHand('pan')
      return
    }
    if (hit.kind === 'region') {
      setSel({ kind: 'region', i: hit.i })
      return
    }
    /* the run-in moves without changing the selection, because it has no panel and no name to select. */
    if (hit.kind === 'runin') {
      const a = (doc.marks || [])[hit.i].approach
      if (!a) return
      drag.current = { kind: 'runin', i: hit.i, dx: w.x - a.x, dy: w.y - a.y, mx, my }
      setHand('runin')
      remember()
      return
    }
    if (hit.kind === 'mark') {
      setSel({ kind: 'mark', i: hit.i })
      setSure(false)
      const k = (doc.marks || [])[hit.i]
      drag.current = { kind: 'mark', i: hit.i, dx: w.x - k.x, dy: w.y - k.y, mx, my }
      setHand('mark')
      remember()
      return
    }
    setSel({ kind: 'place', i: hit.i })
    setSure(false)
    const p = doc.places[hit.i]
    /* a resize keeps its own start pair: the move's dx is from the origin and collapsed the footprint. */
    drag.current = { kind: hit.kind, i: hit.i, dx: w.x - p.x, dy: w.y - p.y, mx, my, p, m0: doc.marks || [], corner: hit.corner }
    // the cursor keeps the diagonal it was given, so the shape does not swap to
    // a generic move the moment the hand closes on a corner
    setHand(hit.kind === 'size' ? hit.corner || 'se' : hit.kind)
    remember()
  }

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!doc) return
    const { mx, my } = at(e)
    const w = toWorld(mx, my)

    /* held inside the stage on both axes, and 230 is the widest line this ever says, measured. */
    if (tool !== 'move')
      setNib({ x: Math.round(clamp(mx + 16, 6, Math.max(6, size.w - 236))), y: Math.round(clamp(my + 26, 6, Math.max(6, size.h - 30))) })

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
      /* the corner is part of the same hit, or moving between two grips keeps the first and lies. */
      const h = under(doc, fit, sel, mx, my, skin)
      setHover((v) => (v?.kind === h?.kind && v?.i === h?.i && v?.corner === h?.corner ? v : h))
      // and the anchor a berth would land on, lit while you decide. It answers
      // for the whole chart now rather than for the one island you had selected,
      // which is what a free-standing point needs it to do.
      const p = tool === 'berth' ? aimed(mx, my) : null
      setAim(p ? `${p.p.name}/${p.a.name}` : '')
      return
    }
    const x = sea(w.x - d.dx, doc.w)
    const y = sea(w.y - d.dy, doc.h)
    if (d.kind === 'place') shift(d.i, x, y)
    else if (d.kind === 'mark') editMark(d.i, { x, y })
    // and the run-in on its own, which is the one drag that moves a point
    // without moving what it hangs off
    else if (d.kind === 'runin') editMark(d.i, { approach: { x: Math.round(x), y: Math.round(y) } })
    else {
      /* divide the travel by the DRAWN width, not the footprint, which overshoots by the margin. */
      const p0 = d.p as Place
      const now = doc.places[d.i]
      if (!p0 || !now) return
      const m = p0.map ? reg.get(p0.map) : undefined
      const sk = skin(p0)
      const gain = e.shiftKey ? RESIZE_FINE : RESIZE_GAIN
      const corner = d.corner || 'se'
      const east = eastOf(corner)
      const south = southOf(corner)
      // never zero, or a picture whose paint is a hairline would divide a whole
      // drag by nothing and throw the footprint to its fence
      const kx = Math.max(1e-3, (sk.x1 - sk.x0) * fit.s)
      const ky = Math.max(1e-3, (sk.y1 - sk.y0) * fit.s)
      // a west or north handle grows the island as the hand travels the other
      // way, so the reading is signed by which edges the corner owns
      const hx = (mx - d.mx) * gain * (east ? 1 : -1)
      const hy = (my - d.my) * gain * (south ? 1 : -1)
      // the handle honours the same lock the inspector does, so dragging a
      // footprint cannot quietly squash the painting inside it
      const held = lock && m && m.w > 0 && m.h > 0
      let nw: number
      let nh: number
      if (held && m) {
        /* the travel is projected onto the diagonal: averaging the axes gave a straight drag half. */
        const vx = kx * p0.w
        const vy = (ky * p0.w * m.h) / m.w
        const k = (hx * vx + hy * vy) / Math.max(1e-6, vx * vx + vy * vy)
        nw = side(p0.w + p0.w * k)
        nh = side((nw * m.h) / m.w)
      } else {
        nw = side(p0.w + hx / kx)
        nh = side(p0.h + hy / ky)
      }

      /* a resize scales about the corner you are not holding, carrying x,y and the bound berths only. */
      const pinX = p0.x + (east ? sk.x0 : sk.x1) * p0.w
      const pinY = p0.y + (south ? sk.y0 : sk.y1) * p0.h
      const fx = nw / Math.max(1, p0.w)
      const fy = nh / Math.max(1, p0.h)
      const nx = Math.round(pinX + (p0.x - pinX) * fx)
      const ny = Math.round(pinY + (p0.y - pinY) * fy)
      if (nw !== now.w || nh !== now.h || nx !== now.x || ny !== now.y) {
        /* THE ISLAND AND ITS BERTHS IN ONE setDoc, the same argument shift()
         * makes: two writes would put a frame on screen with the coast scaled
         * and the dock still on the old jetty, for every frame of the drag. */
        setDoc((cur) =>
          cur
            ? {
                ...cur,
                places: cur.places.map((q, k) => (k === d.i ? { ...q, w: nw, h: nh, x: nx, y: ny } : q)),
                // off the grab snapshot and not off `cur`, or every frame scales
                // what the frame before it already scaled
                marks: (d.m0 || []).map((mk) =>
                  mk.island === p0.name
                    ? {
                        ...mk,
                        x: Math.round(pinX + (mk.x - pinX) * fx),
                        y: Math.round(pinY + (mk.y - pinY) * fy),
                        // the run-in takes the same scale as the dock it belongs
                        // to, for the same reason: it is aimed at the picture,
                        // and the picture is what just changed size
                        ...(mk.approach
                          ? {
                              approach: {
                                x: Math.round(pinX + (mk.approach.x - pinX) * fx),
                                y: Math.round(pinY + (mk.approach.y - pinY) * fy),
                              },
                            }
                          : {}),
                      }
                    : mk,
                ),
              }
            : cur,
        )
        setDirty(true)
      }
    }
  }

  const up = () => {
    setHand('')
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
        sea(Math.min(band.x0, band.x1), doc.w),
        sea(Math.min(band.y0, band.y1), doc.h),
        sea(Math.max(band.x0, band.x1), doc.w),
        sea(Math.max(band.y0, band.y1), doc.h),
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

  /* the whole document goes and the answer replaces the screen; an illegal name is caught here first. */
  const save = async () => {
    if (!doc || busy) return
    // marks are in this check now, and by their own rule. isMarkName is the
    // server's regex restated, and cleanMark drops a row that fails it exactly
    // the way cleanPlace does, so a bad waypoint would vanish without a word.
    const illegal = [...doc.places, ...doc.regions].filter((p) => !isAnchorName(p.name)).map((p) => p.name || '(no name)')
    illegal.push(...(doc.marks || []).filter((m) => !isMarkName(m.name)).map((m) => m.name || '(no name)'))
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
        // marks always go, since an absent key means keep the row and the first waypoint would vanish
        body: JSON.stringify({
          w: doc.w,
          h: doc.h,
          places: doc.places,
          regions: doc.regions,
          marks: doc.marks || [],
          home: doc.home || '',
          updatedAt: doc.updatedAt ?? 0,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setProblems(j.problems?.length ? j.problems : [j.error || `the server refused it (${r.status})`])
        return
      }
      const kept: Doc = { w: j.w, h: j.h, places: j.places || [], regions: j.regions || [], marks: j.marks, home: j.home || '', updatedAt: j.updatedAt }
      saved.current = stamp(kept)
      setDoc(kept)
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
        setTool('move')
        setAim('')
        setSure(false)
        return
      }
      /* bare keys stop at a field: typing a release of 160 would throw the chart out to the whole ocean. */
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return
      if (e.key === 'f') frame()
      if (e.key === '0') frameAll()

      /* arrows, because one screen pixel is a third of a unit, and one undo per burst, not per key. */
      const step = e.key.startsWith('Arrow') ? (e.shiftKey ? NUDGE_FAR : 1) : 0
      if (step && sel && (place || spot)) {
        e.preventDefault()
        const now = performance.now()
        if (now - nudged.current > 600) remember()
        nudged.current = now
        const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0
        const dy = e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0
        /* a mark nudges the way an island does, and needs it more: it has no footprint to aim by. */
        if (place && sel.kind === 'place') shift(sel.i, place.x + dx, place.y + dy)
        else if (spot && sel.kind === 'mark') editMark(sel.i, { x: spot.x + dx, y: spot.y + dy })
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

  /* signed out is the whole of this case since 022, and the published read still works for anybody. */
  if (mine === false)
    return (
      <div className="world">
        <div className="world-gone">
          <h1>A world belongs to an account.</h1>
          <p>
            Sign in and you get water of your own to place your islands on, with a public address your own engine can
            read it from. The game&apos;s ocean stays readable by anyone at <code>/api/v1/world</code>.
          </p>
          <div className="world-gone-do">
            <Link to="/enter" className="world-btn lit">
              sign in
            </Link>
            <Link to="/enter?new=1" className="world-btn">
              make an account
            </Link>
          </div>
        </div>
      </div>
    )
  if (why)
    return (
      <div className="world">
        <div className="world-gone">
          <h1>The water will not open.</h1>
          <p>{why}</p>
          <Link to="/" className="world-btn">
            your maps
          </Link>
        </div>
      </div>
    )
  if (!doc || mine === null) return <div className="world" />

  /* a multiplier throughout, never a ratio: the two are indistinguishable in one slot and nothing catches a swap. */
  const scale = `${fit.s >= 10 ? Math.round(fit.s) : fit.s >= 1 ? Number(fit.s.toFixed(1)) : Number(fit.s.toFixed(2))}×`
  /* the span sits beside the zoom: the header says 4096 and the opening view is half a per cent. */
  const span = size.w && fit.s ? Math.round(size.w / fit.s) : 0
  /* hand is set at the press, since hover is only written while nothing is held. */
  /* two glyphs, one per diagonal, out of the table the press uses, or a handle promises the wrong pull. */
  const grip =
    hand === 'pan'
      ? 'grabbing'
      : CURSOR[hand as Corner]
        ? CURSOR[hand as Corner]
        : hand
          ? 'move'
          : tool !== 'move'
            ? 'crosshair'
            : hover?.kind === 'size'
              ? CURSOR[hover.corner || 'se']
              : hover?.kind === 'region'
                ? 'pointer'
                : hover
                  ? 'move'
                  : 'grab'

  /* the ocean is the game's row alone and everybody else's is a world, or the name means two things. */
  const water = game ? 'ocean' : 'world'

  return (
    <div className="world">
      <header className="world-bar">
        <button className="world-back" onClick={() => go('/')} title="back to your maps">
          ←
        </button>
        <span className="world-name" title={game ? 'the water the game sails, read at /api/v1/world' : 'your own water, nobody else edits it'}>
          {water}
        </span>
        {/* one segmented control in the editor's shape; spelt out the four were a sentence */}
        <div className="world-tools seg" role="group" aria-label="tool">
          <button className={'world-tool' + (tool === 'move' ? ' on' : '')} onClick={() => setTool('move')} title="move what is on the water">
            move
          </button>
          <button className={'world-tool' + (tool === 'place' ? ' on' : '')} onClick={() => setTool('place')} title="hold a position for an island">
            island
          </button>
          <button className={'world-tool' + (tool === 'sea' ? ' on' : '')} onClick={() => setTool('sea')} title="drag out a stretch of water and name it">
            water
          </button>
          {/* ONE BUTTON FOR EVERY POINT ON THE WATER, and there were three ways
              to make one: this, "set berth" and "set approach", the last two
              welded to whichever island happened to be selected. */}
          <button
            className={'world-tool' + (tool === 'berth' ? ' on' : '')}
            onClick={() => setTool('berth')}
            title="drop a named point anywhere on the water · on an island's own mark to tie it there"
          >
            berth
          </button>
        </div>
        {/* the size of the water sits at the foot, where the editor keeps a map's size */}
        <span className="world-grow" />
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
          {/* one line and only while a tool is armed: the standing version explained a map */}
          {tool !== 'move' && (
            <p className="world-hint" role="status" style={{ '--hx': `${nib.x}px`, '--hy': `${nib.y}px` } as React.CSSProperties}>
              {tool === 'place'
                ? 'click open water · esc'
                : tool === 'berth'
                  ? // and it says what the snap is about to do, which is the one
                    // moment a berth becomes an island's rather than the sea's
                    aim
                    ? `tie it to ${aimSaid} · esc`
                    : 'click anywhere to drop a berth · esc'
                  : 'drag out the water · esc'}
            </p>
          )}
          <div className="world-zoom">
            {/* the buttons zoom where the wheel does: the viewport centre marched the island off */}
            <button className="world-zbtn" onClick={() => rung(-1, ...holdPt)} aria-label="zoom out" title="zoom out one step">
              −
            </button>
            <span className="world-zread" title={`${span} world units across the stage`}>
              {scale}
            </span>
            <button className="world-zbtn" onClick={() => rung(1, ...holdPt)} aria-label="zoom in" title="zoom in one step">
              +
            </button>
            {/* each framing names what it frames: fit showed 200 units of a 4096 unit ocean */}
            {/* the framing button is named after the thing it frames, and on a
                member's water that thing is not called the ocean */}
            <button className="world-zbtn wide" onClick={frameSea} title={`the whole ${doc.w} × ${doc.h} ${water}`}>
              {water}
            </button>
            <button className="world-zbtn wide" onClick={frameAll} title="everything on the water · 0">
              placed
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

        <aside className="world-side sparse" ref={panel}>
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

          {/* nothing selected is answered with the roster below, not with a
              paragraph explaining what an island is to somebody already looking
              at a chart of them. */}
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
              berths={boundTo(doc, place.name)}
              lock={lock}
              sure={sure}
              onSure={setSure}
              onLock={setLock}
              /* born tied to this island and just off its corner, so it is draggable and not buried */
              onBerth={() => addBerth(place.x + place.w + 24, place.y + place.h + 24, { island: place.name })}
              onGo={(name) => {
                const i = (doc.marks || []).findIndex((m) => m.name === name)
                if (i >= 0) setSel({ kind: 'mark', i })
              }}
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
          ) : spot && sel?.kind === 'mark' ? (
            <BerthPanel
              m={spot}
              kinds={markKinds.length ? markKinds : [...MARK_KINDS]}
              places={doc.places}
              /* the anchors of whatever island this berth belongs to, not of the panel you are in */
              sheet={spot.island ? reg.get(doc.places.find((p) => p.name === spot.island)?.map || '') : undefined}
              /* the same rule composition() uses to pick the one berth a slot
                 gets, asked here so the panel can say a run-in on any other
                 point is a field nothing reads */
              heeded={!!spot.island && berthOf(doc, spot.island) === spot}
              sure={sure}
              onSure={setSure}
              onEdit={(patch) => editMark(sel.i, patch)}
              onDrop={() => dropMark(sel.i)}
            />
          ) : null}

          {/* displayName and not the raw the_hub, with the identifier a hover away for a grape */}
          {/* only the work left: the counts and the size moved to the readout strip below */}
          {/* whose water this is decides what every row below means: only the game's is sailed */}
          {!sel && <Whose doc={doc} game={game} readUrl={readUrl} />}
          {!sel && <Todo doc={doc} />}

          <div className="world-roster">
            {/* one column, one meaning: it printed a map slug on an island and a kind on water */}
            {(
              [
                ['islands', doc.places.length],
                ['water', doc.regions.length],
                ['berths', (doc.marks || []).length],
              ] as const
            ).map(([what, n]) => {
              if (!n) return null
              return (
                <div className="world-grp" key={what}>
                  <div className="world-cols">
                    <span className="world-lab">
                      {what} · {n}
                    </span>
                    {/* on every group and not just the first, because each group
                        is read on its own and an unlabelled monospace column is
                        how this one came to mean two things. */}
                    <span className="world-lab">code name</span>
                  </div>
                  {what === 'islands' &&
                    doc.places.map((p, i) => {
                      const said = displayName(p, 'unnamed island')
                      return (
                        <button
                          key={i}
                          className={'world-row' + (sel?.kind === 'place' && sel.i === i ? ' on' : '')}
                          onClick={() => setSel({ kind: 'place', i })}
                          title={`${said.text} · ${p.state}${p.map ? ` · ${p.map}` : ' · no map'}${said.derived ? ' · nobody has titled it, so the words were read off the address' : ''}`}
                        >
                          <i style={{ background: inkFor(STATE_INK, p.state) }} />
                          <span className={'world-row-n' + (said.derived ? ' guessed' : '')}>{said.text}</span>
                          <span className="world-row-m">{p.name}</span>
                        </button>
                      )
                    })}
                  {what === 'water' &&
                    doc.regions.map((r, i) => {
                      const said = displayName(r, 'unnamed water')
                      return (
                        <button
                          key={'r' + i}
                          className={'world-row' + (sel?.kind === 'region' && sel.i === i ? ' on' : '')}
                          onClick={() => setSel({ kind: 'region', i })}
                          title={`${said.text} · ${r.kind}${said.derived ? ' · no label yet, so the words were read off the address' : ''}`}
                        >
                          <i style={{ background: inkFor(SEA_INK, r.kind) }} />
                          <span className={'world-row-n' + (said.derived ? ' guessed' : '')}>{said.text}</span>
                          <span className="world-row-m">{r.name}</span>
                        </button>
                      )
                    })}
                  {what === 'berths' &&
                    (doc.marks || []).map((m, i) => {
                      const said = displayName(m, 'unnamed berth')
                      return (
                        <button
                          key={'m' + i}
                          className={'world-row' + (sel?.kind === 'mark' && sel.i === i ? ' on' : '')}
                          onClick={() => setSel({ kind: 'mark', i })}
                          title={`${said.text} · ${m.kind}${m.island ? ` · tied to ${m.island}` : ' · open water'}${said.derived ? ' · no label yet, so the words were read off the address' : ''}`}
                        >
                          {/* one coral square for every berth, and filled means it is tied to an island */}
                          <i className={m.island ? '' : 'open'} style={{ background: CHART_BERTH, borderColor: CHART_BERTH }} />
                          <span className={'world-row-n' + (said.derived ? ' guessed' : '')}>{said.text}</span>
                          <span className="world-row-m">{m.name}</span>
                        </button>
                      )
                    })}
                </div>
              )
            })}
          </div>

          {/* the shared empty state, for the water that genuinely has nothing on
              it. Anything else is answered by the summary above. */}
          {!sel && !doc.places.length && !doc.regions.length && !(doc.marks || []).length && (
            <div className="nothing">
              <p className="nothing-say">nothing is on this {water} yet</p>
              <p className="nothing-do">place the first island</p>
            </div>
          )}
          {!sel && (doc.places.length > 0 || doc.regions.length > 0 || (doc.marks || []).length > 0) && (
            <Key doc={doc} />
          )}
        </aside>
      </div>

      {/* the editor's own readout strip, same type and same facts, so the screens read alike */}
      <footer className="world-foot">
        <span className="world-read mono">{scale}</span>
        <span className="world-read dim">{span ? `${span} u across the stage` : 'not drawn yet'}</span>
        <span className="world-read dim">
          {doc.places.length} island{doc.places.length === 1 ? '' : 's'} · {(doc.marks || []).length} berth
          {(doc.marks || []).length === 1 ? '' : 's'}
          {doc.regions.length ? ` · ${doc.regions.length} water` : ''}
        </span>
        <span className="world-grow" />
        <label className="world-size" title={`the ${water}, across and down, in world units`}>
          <span className="dim">{water}</span>
          <input
            className="world-num"
            type="number"
            value={doc.w}
            aria-label={`${water} width`}
            onChange={(e) => {
              setDoc({ ...doc, w: Math.max(1, Math.round(Number(e.target.value) || 0)) })
              setDirty(true)
            }}
          />
          <span className="dim">×</span>
          <input
            className="world-num"
            type="number"
            value={doc.h}
            aria-label={`${water} height`}
            onChange={(e) => {
              setDoc({ ...doc, h: Math.max(1, Math.round(Number(e.target.value) || 0)) })
              setDirty(true)
            }}
          />
          <span className="dim">u</span>
        </label>
        {/* the same standing line the editor's footer ends with: what the two
            gestures are, said once, quietly, instead of a caption on the water */}
        <span className="world-read dim">scroll zooms · drag the water pans</span>
      </footer>
    </div>
  )
}

/* the read url is the point of the block, and absolute, because it is pasted into another program. */
function Whose({ doc, game, readUrl }: { doc: Doc; game: boolean; readUrl: string }) {
  const [copied, setCopied] = useState(false)
  // window is read at click time and not at render, so nothing here assumes a
  // dom during a server render this app does not have yet but might
  const full = () => (typeof window === 'undefined' ? readUrl : window.location.origin + readUrl)
  const home = doc.home ? doc.places.find((p) => p.name === doc.home) : undefined
  return (
    <section className="world-whose">
      <h3 className="world-lab">{game ? 'the game reads this water' : 'your own water'}</h3>
      <p className="world-note">
        {game
          ? 'This is the row the ship sails. Anything placed here is somewhere a student can reach.'
          : 'Nobody else edits this and the game does not sail it. Point your own engine at the address below.'}
      </p>
      <div className="world-fact">
        <span>read at</span>
        <a className="world-url mono" href={readUrl} target="_blank" rel="noreferrer" title="the composition, as the engine receives it">
          {readUrl}
        </a>
        <button
          className="world-btn small"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(full())
              .then(() => setCopied(true))
              // clipboard is refused outside a secure context and on a denied
              // permission, and a button that lies about having copied is worse
              // than one that says it could not
              .catch(() => setCopied(false))
          }}
          title={full()}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <div className="world-fact">
        <span>a run starts at</span>
        <b>{home ? displayName(home, 'unnamed island').text : 'nothing is marked'}</b>
      </div>
      {doc.updatedAt ? (
        <div className="world-fact">
          <span>last saved</span>
          <b>{when(doc.updatedAt)}</b>
        </div>
      ) : null}
    </section>
  )
}

/* HOW LONG AGO, IN WORDS, and deliberately coarse. A timestamp to the second on
 * a document one person edits is precision nobody reads; what is worth knowing
 * is whether the row changed under you while this tab was open. */
function when(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 90) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minutes ago`
  const h = Math.round(m / 60)
  if (h < 36) return h === 1 ? 'an hour ago' : `${h} hours ago`
  return `${Math.round(h / 24)} days ago`
}

/* the legend lists only what is on the water, and it floors a 719 px rail with 183 px in it. */
function Key({ doc }: { doc: Doc }) {
  const rows: { ink: string; word: string }[] = []
  for (const s of [...new Set(doc.places.map((p) => p.state))]) rows.push({ ink: inkFor(STATE_INK, s), word: s })
  for (const k of [...new Set(doc.regions.map((r) => r.kind))]) rows.push({ ink: inkFor(SEA_INK, k), word: k })
  /* one row for every berth, because six swatches taught six hues that no longer exist. */
  if ((doc.marks || []).length) rows.push({ ink: CHART_BERTH, word: 'berth' })
  if (!rows.length) return null
  return (
    <div className="world-key">
      <span className="world-lab">what the colours are</span>
      <div className="world-key-rows">
        {rows.map((r) => (
          <span className="world-key-r" key={r.word}>
            <i style={{ background: r.ink }} />
            {r.word}
          </span>
        ))}
      </div>
    </div>
  )
}

/* exactly the warnings checkWorld raises and ALL of them: printing the first reported one of four. */
function Todo({ doc }: { doc: Doc }) {
  /* THE SAME QUESTIONS server/store/world.mjs ASKS AT THE SAVE, in the same
   * order, so nothing here can promise a clean save the server then refuses. */
  const todo: string[] = []
  const noId = doc.places.filter((p) => p.map && !p.place).length
  // through berthOf, which is the same rule the server warns on and the same
  // one composition() sends, so this cannot promise a dock the game will not get
  const noBerth = doc.places.filter((p) => p.map && !berthOf(doc, p.name)).length
  const noMap = doc.places.filter((p) => !p.map).length
  // a berth naming an island nobody has placed, which is the one thing the
  // collapse made possible to get wrong and the server warns about by name
  const orphan = (doc.marks || []).filter((m) => m.island && !doc.places.some((p) => p.name === m.island)).length
  if (!doc.home && doc.places.length) todo.push('no island is marked as where a run starts')
  if (noId) todo.push(`${noId} ${noId === 1 ? 'island has' : 'islands have'} no place id, so the game cannot count a visit`)
  if (noBerth) todo.push(`${noBerth} ${noBerth === 1 ? 'island has' : 'islands have'} nowhere to tie up`)
  if (noMap) todo.push(`${noMap} ${noMap === 1 ? 'slot holds' : 'slots hold'} no painting yet`)
  if (orphan) todo.push(`${orphan} ${orphan === 1 ? 'berth belongs' : 'berths belong'} to an island that is not here`)
  if (!todo.length) return null
  return (
    <section className="world-sec world-todo">
      <h3 className="world-lab">still to do</h3>
      {todo.map((t) => (
        <p key={t}>{t}</p>
      ))}
    </section>
  )
}

/* one panel for one point, and which island it belongs to is a field rather than which panel is open. */
function BerthPanel({
  m,
  kinds,
  places,
  sheet,
  heeded,
  sure,
  onSure,
  onEdit,
  onDrop,
}: {
  m: WorldMark
  kinds: string[]
  places: Place[]
  sheet: MapRow | undefined
  /* the slot holds one berth per island and the server takes the first, so a run-in elsewhere is dead. */
  heeded: boolean
  sure: boolean
  onSure: (v: boolean) => void
  onEdit: (patch: Partial<WorldMark>) => void
  onDrop: () => void
}) {
  const said = displayName(m, 'unnamed berth')
  const legal = isMarkName(m.name)
  const anchors = sheet?.anchors || []
  return (
    <div className="world-insp">
      <div className="world-head">
        <b className={said.derived ? 'guessed' : ''}>{said.text}</b>
        {/* the kind this point actually is, and it said "waypoint" on all six */}
        <span className="world-code">
          <i>{m.kind}</i> {m.name}
        </span>
      </div>

      <section className="world-sec">
        <h3 className="world-lab">what a person reads</h3>
        <label className="world-f">
          <span>label</span>
          <input
            className="world-in"
            value={m.label || ''}
            maxLength={120}
            placeholder={said.text}
            title="the words a player is shown. Without one the label is guessed from the address below"
            onChange={(e) => onEdit({ label: e.target.value })}
          />
        </label>
      </section>

      <section className="world-sec">
        <h3 className="world-lab">what code addresses</h3>
        <label className="world-f">
          <span>code name</span>
          <input
            className={'world-in' + (legal ? '' : ' bad')}
            value={m.name}
            spellCheck={false}
            maxLength={48}
            title="what a grape calls sail_to with · one namespace with every island and every stretch of water"
            onChange={(e) => onEdit({ name: e.target.value })}
            onBlur={() => !legal && onEdit({ name: anchorName(m.name) })}
          />
        </label>
        {!legal && <p className="world-bad">lower case, digits, underscores</p>}
        {/* the kinds the SERVER allows, since cleanMark quietly rewrites one it
            does not know back to `berth`. A list kept here would drift out of
            step with that and take the author's choice with it. */}
        <label className="world-f">
          <span>kind</span>
          <select className="world-in" value={m.kind} onChange={(e) => onEdit({ kind: e.target.value as MarkKind })}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="world-sec">
        <h3 className="world-lab">what it belongs to</h3>
        {/* a point is tied, untied or moved here, and naming an island makes it travel with it */}
        <label className="world-f">
          <span>island</span>
          <select
            className="world-in"
            value={m.island || ''}
            title="the island this point is the dock for · it moves with that island, and the game reads the first one as that slot's berth"
            /* at goes on every change: it names an anchor in ONE map's list and nothing validates it */
            onChange={(e) => onEdit({ island: e.target.value || undefined, at: undefined })}
          >
            <option value="">open water</option>
            {places.map((p) => (
              <option key={p.name} value={p.name}>
                {displayName(p, 'unnamed island').text}
              </option>
            ))}
          </select>
        </label>
        {/* where the hull puts somebody down, or a voyage lands on that map's default spawn */}
        <label className="world-f">
          <span>lands at</span>
          <select
            className="world-in"
            value={m.at || ''}
            disabled={!m.island || !anchors.length}
            title={
              !m.island
                ? 'tie this to an island first'
                : anchors.length
                  ? 'the anchor on that island the player stands on'
                  : 'that island has no painting published yet, so it has no anchors to land on'
            }
            onChange={(e) => onEdit({ at: e.target.value || undefined })}
          >
            <option value="">the map&apos;s own spawn</option>
            {/* the anchor's own words, not its identifier. mask.ts keeps label
                separate from name for exactly this reason. */}
            {anchors.map((a) => (
              <option key={a.name} value={a.name}>
                {displayName(a).text}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="world-sec">
        <h3 className="world-lab">where it is</h3>
        <div className="world-pair">
          <Num label="x" v={m.x} on={(n) => onEdit({ x: n })} />
          <Num label="y" v={m.y} on={(n) => onEdit({ y: n })} />
        </div>
        {/* how close counts as arrived, because a hull moves in floats and an
            exact-pixel test on one never fires */}
        <label className="world-f">
          <span>arrived within</span>
          <input
            className="world-in"
            type="number"
            min={0}
            value={m.r ?? 0}
            title="how close a hull comes before it counts as having reached this point"
            onChange={(e) => onEdit({ r: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
          />
        </label>
        {/* four on a berth, since the engine sends every diagonal west, and nine where python reads */}
        <Facing
          v={m.facing || ''}
          say="the heading held here"
          only={m.kind === 'berth' ? BERTH_FACINGS : undefined}
          on={(k) => onEdit({ facing: k || undefined })}
        />
      </section>

      {/* the game aims here first, so with no run-in every arrival is a straight-in nose */}
      {m.kind === 'berth' && <RunIn m={m} heeded={heeded} onEdit={onEdit} />}

      <Scrap what={said.text} sure={sure} onSure={onSure} onDrop={onDrop} />
    </div>
  )
}

/* born astern of the heading, not on the berth, or the two dots share a pixel and cannot be parted. */
function RunIn({ m, heeded, onEdit }: { m: WorldMark; heeded: boolean; onEdit: (patch: Partial<WorldMark>) => void }) {
  const a = m.approach
  const make = () => {
    const f = m.facing || ''
    let dx = f.includes('east') ? 1 : f.includes('west') ? -1 : 0
    let dy = f.includes('south') ? 1 : f.includes('north') ? -1 : 0
    if (!dx && !dy) dy = -1
    const n = Math.hypot(dx, dy) || 1
    // far enough out that the two marks are separate targets at the opening
    // zoom, and outside the arrival radius so it is never inside "already there"
    const far = Math.max(90, (m.r || 0) * 2.5)
    dx = Math.round((-dx / n) * far)
    dy = Math.round((-dy / n) * far)
    onEdit({ approach: { x: m.x + dx, y: m.y + dy } })
  }
  return (
    <section className="world-sec">
      <h3 className="world-lab">the run-in</h3>
      {a ? (
        <>
          <div className="world-pair">
            <Num label="x" v={a.x} on={(n) => onEdit({ approach: { x: n, y: a.y } })} />
            <Num label="y" v={a.y} on={(n) => onEdit({ approach: { x: a.x, y: n } })} />
          </div>
          <p className="world-note">Drag the hollow diamond on the chart. The hull steers at it, then swings onto the heading above.</p>
          {!heeded && (
            <p className="world-bad">
              The game reads one dock per island and this is not it, so nothing will ever steer through this point.
            </p>
          )}
          <button className="world-btn small" onClick={() => onEdit({ approach: undefined })} title="the hull will come straight in">
            clear it
          </button>
        </>
      ) : (
        <>
          <p className="world-note">Nothing set, so a hull noses straight in on the heading above.</p>
          <button className="world-btn small" onClick={make}>
            add a run-in
          </button>
        </>
      )}
    </section>
  )
}

/* the compass with the caption it lacked, lifted out so a berth and a waypoint ask the same way. */
function Facing({ v, say, on, only }: { v: string; say: string; on: (k: string) => void; only?: readonly string[] }) {
  return (
    <div className="world-f">
      <span>{say}</span>
      <div className="world-face" role="group" aria-label={say}>
        {FACE_GRID.flat().map((k, n) => {
          // a heading the consumer cannot honour is drawn dead, since a compass with holes is harder to aim
          const off = !!k && !!only && !only.includes(k)
          return (
            <button
              key={k || 'none'}
              className={'world-fbtn' + ((k ? v === k : !v) ? ' on' : '')}
              title={off ? `the game cannot hold ${k}, so a hull here would point west` : k || 'no opinion'}
              disabled={off}
              aria-pressed={k ? v === k : !v}
              onClick={() => on(k && v !== k ? k : '')}
            >
              {FACE_ARROW[n]}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* every field the server keeps has a control except meta, and the mooring is a list of berths. */
function Inspector({
  p,
  i,
  states,
  home,
  onHome,
  reg,
  sheet,
  berths,
  lock,
  sure,
  onSure,
  onLock,
  onBerth,
  onGo,
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
  berths: WorldMark[]
  lock: boolean
  sure: boolean
  onSure: (v: boolean) => void
  onLock: (v: boolean) => void
  onBerth: () => void
  onGo: (name: string) => void
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

  /* the footprint follows the painting's shape through side(), since a squashed jetty is nothing. */
  const setW = (n: number) => set(lock && shape ? { w: side(n), h: side(n / shape) } : { w: side(n) })
  const setH = (n: number) => set(lock && shape ? { h: side(n), w: side(n * shape) } : { h: side(n) })

  /* a ticked constraint that is not enforced is a lie, so the shape lock is dead on a painting. */

  const said = displayName(p, 'unnamed island')
  return (
    <div className="world-insp">
      {/* the panel is headed with the island's name, and the snake_case stays as the address */}
      <div className="world-head">
        <b className={said.derived ? 'guessed' : ''}>{said.text}</b>
        <span className="world-code">
          <i>island</i> {p.name}
        </span>
      </div>

      {/* the mooring first: the panel ran 856 px inside a 719 px column and the berth was below */}
      <section className="world-sec">
        <h3 className="world-lab">where a ship ties up</h3>
        {berths.length > 0 && (
          <div className="world-list">
            {berths.map((b, n) => (
              <button
                key={b.name}
                className="world-lrow"
                onClick={() => onGo(b.name)}
                title={`${b.name} · ${Math.round(Math.hypot(b.x - p.x, b.y - p.y))} units out from this island's origin`}
              >
                <i style={{ background: CHART_BERTH }} />
                <span className="world-lrow-n">{displayName(b, 'unnamed berth').text}</span>
                {/* which one the game uses, since an island carries any number and one is sent */}
                <span className="world-lrow-m">{n === 0 && b.kind === 'berth' ? 'the dock' : b.kind}</span>
              </button>
            ))}
          </div>
        )}
        {!berths.length && <p className="world-note">nothing ties up here yet, so a ship cannot land</p>}
        <button className="world-btn small" onClick={onBerth} title="drop a berth just off this island and open it">
          add a berth
        </button>
      </section>

      <section className="world-sec">
        <h3 className="world-lab">what a person reads</h3>
        <label className="world-f">
          <span>title</span>
          <input
            className="world-in"
            value={p.title}
            maxLength={120}
            placeholder={said.text}
            title="what the player is told this place is called. Without one the words above are guessed from the address"
            onChange={(e) => set({ title: e.target.value })}
          />
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
      </section>

      <section className="world-sec">
        <h3 className="world-lab">what code addresses</h3>
        <label className="world-f">
          <span>code name</span>
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
        {/* the roster id, kebab-case where the address is an identifier, or the island reads misty */}
        <label className="world-f">
          <span>place id</span>
          <input
            className="world-in"
            value={p.place || ''}
            spellCheck={false}
            maxLength={48}
            placeholder="home-island"
            /* MAPVIS cannot see the roster the game keeps, so this is typed rather than picked from a list */
            title="the roster id the game finds this slot by"
            onChange={(e) => set({ place: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
          />
        </label>
      </section>

      <details className="world-sec world-fold" open={!p.map}>
        {/* two words and not five: at 10px mono a longer header wrapped in the 290px rail */}
        <summary className="world-lab">the painting</summary>
        <label className="world-f">
          <span>map</span>
          <select
            className="world-in"
            value={p.map}
            onChange={(e) => {
              const slug = e.target.value
              const m = slug ? reg.get(slug) : undefined
              onBefore()
              /* the box becomes the canvas and the state lifts off rumour, or the game drops every island */
              set({
                map: slug,
                ...(m && m.w > 0 && m.h > 0 ? bornAs(m) : {}),
                ...(slug ? (p.state === 'rumour' ? { state: 'misty' } : {}) : { state: 'rumour' }),
              })
            }}
          >
            <option value="">no map</option>
            {options.map((s) => (
              <option key={s} value={s}>
                {displayName(s).text}
                {slugs.includes(s) ? '' : ' · unpublished'}
              </option>
            ))}
          </select>
        </label>
        {/* a typed coordinate goes through the same move the drag does, so the mooring is carried */}
        <div className="world-pair">
          <Num label="x" v={p.x} on={(n) => onMove(i, n, p.y)} />
          <Num label="y" v={p.y} on={(n) => onMove(i, p.x, n)} />
        </div>
        {/* on a place holding a painting the size is the canvas, shown because it is worth reading */}
        <div className="world-pair">
          <Num label="w" v={p.w} min={ISLAND_MIN} on={setW} disabled={!!p.map} />
          <Num label="h" v={p.h} min={ISLAND_MIN} on={setH} disabled={!!p.map} />
        </div>
        {/* the sentence this was, "hold the painting's shape · 688x640", said the
            same thing three times. The size it is holding is the title. */}
        <label
          className="world-check"
          title={p.map ? 'a place holding a painting is that painting"s canvas, one unit to one pixel' : 'the painting decides the short side'}
        >
          <input type="checkbox" checked={lock} disabled={!!p.map} onChange={(e) => onLock(e.target.checked)} />
          <span>keep the shape</span>
        </label>
      </details>

      <details className="world-sec world-fold">
        <summary className="world-lab">how far it reaches</summary>
        {/* what this called release is what the game calls discover, and the real release had none */}
        <label className="world-f">
          <span>discovered within</span>
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
          <span>held in memory within</span>
          <input
            className="world-in"
            type="number"
            min={0}
            value={p.release}
            title="how far out this map's bundle stays in memory · the first thing dropped when a chromebook runs short"
            onChange={(e) => set({ release: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
          />
        </label>
        {/* a radio wearing a checkbox: a run starts in one place, so ticking writes one name on the world */}
        <label className="world-check" title="a run with no ship yet begins here, and a graduate is handed back to it">
          <input type="checkbox" checked={home === p.name} onChange={(e) => onHome(e.target.checked ? p.name : '')} />
          <span>the run starts here</span>
        </label>
      </details>

      {/* the words, not the address. It read "remove the_hub" at a person. */}
      <Scrap what={said.text} sure={sure} onSure={onSure} onDrop={onDrop} />
    </div>
  )
}

/* taking something off the chart asks once, because the row is the one thing nothing else recovers. */
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
  const said = displayName(r, 'unnamed water')
  const legal = isAnchorName(r.name)
  return (
    <div className="world-insp">
      <div className="world-head">
        <b className={said.derived ? 'guessed' : ''}>{said.text}</b>
        <span className="world-code">
          <i>water</i> {r.name}
        </span>
      </div>
      <section className="world-sec">
        <h3 className="world-lab">what a person reads</h3>
        <label className="world-f">
          <span>label</span>
          <input
            className="world-in"
            value={r.label || ''}
            maxLength={120}
            placeholder={said.text}
            title="the words a player is shown. Without one the label is guessed from the address below"
            onChange={(e) => onEdit({ label: e.target.value })}
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
      </section>
      <section className="world-sec">
        <h3 className="world-lab">what code addresses</h3>
        <label className="world-f">
          <span>code name</span>
          <input
            className={'world-in' + (legal ? '' : ' bad')}
            value={r.name}
            spellCheck={false}
            maxLength={48}
            onChange={(e) => onEdit({ name: e.target.value })}
            onBlur={() => !legal && onEdit({ name: anchorName(r.name) })}
          />
        </label>
        {!legal && <p className="world-bad">lower case, digits, underscores</p>}
      </section>
      <section className="world-sec">
        <h3 className="world-lab">where it is</h3>
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
      </section>
      <Scrap what={said.text} sure={sure} onSure={onSure} onDrop={onDrop} />
    </div>
  )
}

function Num({ label, v, min, on, disabled }: { label: string; v: number; min?: number; on: (n: number) => void; disabled?: boolean }) {
  return (
    <label className="world-f">
      <span>{label}</span>
      <input
        className="world-in"
        type="number"
        disabled={disabled}
        value={v}
        onChange={(e) => {
          const n = Number(e.target.value)
          on(Math.max(min ?? -1e9, Number.isFinite(n) ? Math.round(n) : 0))
        }}
      />
    </label>
  )
}

/* a canvas has no css to transition, so this eases the value, and it is off for reduced motion. */
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
