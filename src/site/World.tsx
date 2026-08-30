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
import { ANCHOR_INK, inkFor } from '../core/ink'
import { displayName } from '../core/naming'
import { MARK_KINDS, isMarkName, type MarkKind, type WorldMark } from '../core/world'
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
/* marks is AUTHORED here now, and for two revisions it was carried untouched by
 * a page that had no control for it: first as `unknown`, then typed and drawn
 * on the roster but read-only. Ash, 2026-08-29, asked for marks to be easy to
 * add, and the only way to make one was as an island's berth or an island's
 * approach, which is not a free-standing point at all. The toolbar has a
 * waypoint on it and this list is what it writes.
 * src/core/world.ts holds the shape and the name rule. */
/* `home` is the slot a run with no vessel record starts in and the one a
 * graduate is handed back to. One name for the whole ocean, and the game had it
 * as a constant because nothing here could say it. */
type Doc = { w: number; h: number; places: Place[]; regions: Region[]; marks?: WorldMark[]; home?: string }

/* What the registry hands back for one map. The x,y on an anchor is in that
 * map's OWN pixel raster, the same raster scene.png is published at, which is
 * what makes it drawable on this chart at all. */
type Anchor = { name: string; kind: string; x: number; y: number; r?: number; to?: string; label?: string }
type MapRow = { slug: string; w: number; h: number; version: number | null; anchors?: Anchor[] }

type Sel = { kind: 'place' | 'region' | 'mark'; i: number } | null
type Hit = { kind: 'place' | 'berth' | 'approach' | 'size' | 'region' | 'mark'; i: number } | null
type Band = { x0: number; y0: number; x1: number; y1: number } | null
/* `mark` is the tool Ash asked for and the one this page could not do. Every
 * point on the water had to be an island's berth or an island's approach, so a
 * corner a sail leg turns at, which belongs to neither island it sits between,
 * had nowhere to be authored. It is free standing: no map, no footprint, no
 * owner, just a name a grape can sail to. */
type Tool = 'move' | 'place' | 'sea' | 'mark'
type Pick = '' | 'berth' | 'approach'
type Fit = { s: number; ox: number; oy: number }

/* ---- THE ONLY HEX IN THIS FILE, AND THE REASON IT IS ALLOWED ---------------
 *
 * A 2d context takes a css colour string and cannot read a custom property, so
 * a canvas is the one surface a token layer cannot reach. Everything the chart
 * draws is therefore written out, HERE, in one block, and each line names the
 * token it is a copy of. If a token moves, these move with it and nothing else
 * in this file has to be looked at.
 *
 * The rule that makes this a fence rather than an excuse: no colour is written
 * anywhere below this block. Before, the tool's own gold appeared as '#f0c869'
 * in nine separate draw calls and the dark rim behind every word appeared as
 * 'rgba(7,11,17,0.9)' in seven, so a change to either meant finding sixteen
 * literals by eye.
 */
const CHART_VOID = '#070b11' /* --void */
const CHART_SEA_FILL = '#0b111a' /* the water itself, one step off --void */
const CHART_INK = '#e6e9ee' /* --ink */
const CHART_QUIET = '#7d8ea1' /* --ink-3, the text floor */
const CHART_EDGE = '#5b6470' /* --ink-edge. NOT TEXT: a tick, a boundary */
const CHART_ARMED = '#f0c869' /* --acc-tool-lit */
const CHART_TOOL = '#d4a53c' /* --acc-tool */
const CHART_MARK = '#d0785f' /* --acc-mark */
const CHART_STOP = '#b04a2f' /* --acc-stop */
const CHART_LIVE = '#4f9b84' /* --acc-live, sunk to sit under a painting */
const CHART_DEEP = '#8a6a1f' /* --acc-tool-deep */
/* THE GRATICULE, AND IT WAS THE ONE THAT WAS WRONG FOR ITS OWN REASON. It was
 * #1a1c1c, a neutral charcoal with no blue in it, ruled over water at #0b111a,
 * so a warm grey mesh sat on a cold ground and read as something laid on top of
 * the chart rather than as the chart's own ruling. It is a lift of the water's
 * hue now, in two weights, because a graticule is the sea drawn lighter. */
const CHART_SEA_MINOR = 'rgba(122,164,204,0.07)'
const CHART_SEA_MAJOR = 'rgba(122,164,204,0.17)'
/* what a word on the water sits on. --void at the alpha that survives a lit
 * volcano underneath it, measured against the hub's own painting. */
const PLATE = 'rgba(7,11,17,0.84)'

/* ONE INK PER STATE, and the ramp is the journey: unknown is cold and grey,
 * the one you are in is gold, the one that is over goes back down to a dull
 * bronze. The names come from the server, not from here, so a state added there
 * still draws with the fallback rather than disappearing. */
const STATE_INK: Record<string, string> = {
  rumour: CHART_EDGE,
  rising: CHART_STOP,
  misty: '#6f8296',
  discovered: '#8fa6bb',
  available: CHART_LIVE,
  active: CHART_TOOL,
  completed: CHART_DEEP,
}
const SEA_INK: Record<string, string> = {
  sailable: '#1d2c3c',
  shallow: '#2b5a55',
  forbidden: '#4a1f16',
  mist: '#3b4654',
  ambience: '#3a3252',
}
/* THE ANCHOR INKS ARE NOT WRITTEN HERE ANY MORE. They were, and the editor's
 * overlay had its own single pale iris for the same six kinds, so Panther's Maw
 * was orange on this page and lavender two clicks away in the tool that made
 * it. src/core/ink.ts is the one table both canvases read; it keeps the same
 * promise this block does, that every hex names the token it copies. */

/* THE CHART'S TYPE, AS THREE JOBS RATHER THAN THREE ARBITRARY SIZES.
 *
 * A canvas takes a css font string and cannot read a custom property, so the
 * numbers have to be written here. They are the tokens.css steps by hand:
 * --fs-fine, --fs-micro and one below the scale that only a chart is allowed,
 * because a plate on a fourteen pixel island cannot carry a ten pixel word.
 * label() takes a size, so the name on an island grows with the island. */
const LABEL = (px: number) => `500 ${px}px "Archivo Narrow", sans-serif`
const MONO = '400 10px "Martian Mono", monospace'
const TINY = '400 9px "Martian Mono", monospace'
const PAD = 36

/* HOW BIG A NAME ON THE WATER IS ALLOWED TO GET.
 *
 * It was a flat 11 px at every zoom, which is two failures in one direction. At
 * the floor the hub is ten screen pixels across and "The Hub" was fifty, so the
 * word was physically larger than the island it names and the chart read as a
 * list of captions. Zoomed to 17x the same word sat on a six hundred pixel
 * painting looking like a tooltip that had come loose.
 *
 * So it follows the island: a fraction of the drawn width, fenced at both ends.
 * Under LABEL_DROP the island is too small to hold a word at all and only the
 * one under the hand is named, which is also the collision fix that costs
 * nothing. */
const LABEL_MIN = 10
const LABEL_MAX = 17
const LABEL_DROP = 30
/* AND HOW SMALL AN ISLAND CAN GET BEFORE THE TOOL STOPS DRAWING ITS HANDLES ON
 * IT. Measured at the zoom floor: the hub is ten screen pixels across and the
 * selection put a sixteen pixel grip square, a "64 × 60 u" plate and a "berth
 * 152 u" plate around it, so three pieces of chrome, each wider than the thing
 * they belong to, piled into sixty pixels of water. The name and the ring say
 * what is selected out there. The handles are for a footprint you can actually
 * pull a corner off, which is why the floor is a few times the grip and not one
 * grip: a corner is only a corner when it is somewhere other than the middle. */
const GRIP_DROP = 44
// a fifth of the drawn width, fenced. A fifth is not arithmetic, it is what
// puts a five letter name across about the width of the island it names.
const nameAt = (rw: number) => Math.round(clamp(rw * 0.2, LABEL_MIN, LABEL_MAX))

// as far out as fitting the whole ocean, and as far in as one painted pixel
// filling a fat screen pixel. Anything past that is not more information.
const MAX_S = 48
const SNAP = 11

/* THE ZOOM LADDER, AND IT IS NOT A MULTIPLIER.
 *
 * Each press was a fixed factor, so the readout walked 1.6, 2.6, 4.1, 6.6: no
 * 2, no 4, no 8, and no way to land on a round number by pressing a button. A
 * chart's zoom is a ladder of stops you can name, the way every drawing program
 * has one. The floor is whatever fits the whole ocean, so the stops below 1 are
 * there for a big ocean on a small stage and are skipped when they are out of
 * reach. */
const STOPS = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48]

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

/* ONE TO ONE, WITH A GEARED MODE ON SHIFT.
 *
 * This was 0.5, and measured: a 300 px drag off the handle left the drawn
 * corner 242 px from the cursor, so the thing in your hand was not the thing
 * moving. Ash's ruling is that the grip sits under the cursor. That is direct
 * manipulation and it is what the gain of 1 buys: you are holding the corner
 * rather than steering it from a distance.
 *
 * Shift is the gradual mode he also asked for, so both instructions are on the
 * record and neither was dropped. It is the same gearing the old default had,
 * moved to where it belongs: the last few units of a footprint, where one
 * world unit at 17x is seventeen screen pixels and the hand cannot land on one.
 *
 * The delta is measured in SCREEN pixels and divided back through the zoom, so
 * the same hand movement does the same thing wherever you are looking. */
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
/* AND HOW OFTEN A LINE IS A HEAVY ONE.
 *
 * It was one weight at one pitch, so the grid was a bathroom tile and gave the
 * eye nothing to count in. Every fourth line is drawn heavier and carries its
 * own coordinate, which is what turns a mesh into a graticule: a distance is
 * counted in majors and read off the number, instead of counted in eighty
 * identical squares. Four and not five or ten, because the pitch is a power of
 * two and only a power of two divides it without a fraction appearing in the
 * label. */
const MAJOR = 4

/* WHAT WOULD GO TO THE SERVER, AS ONE STRING.
 *
 * "dirty" was a flag that only ever went up, so stepping back to exactly the
 * document the server holds still left the button offering to post it, and the
 * beforeunload guard still stopped a tab closing over nothing. Comparing is
 * the only version of this that can be right, and the document is a couple of
 * dozen small objects, so it costs nothing to compare it whole.
 *
 * MARKS ARE IN IT NOW. They were left out because nothing on this page could
 * change one, and the waypoint tool is exactly that thing: leaving them out
 * would mean placing a waypoint left the save button reading "saved". */
const stamp = (d: Doc) => JSON.stringify({ w: d.w, h: d.h, places: d.places, regions: d.regions, marks: d.marks || [], home: d.home || '' })

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

/* ---- ONE GEOMETRY, READ THE SAME WAY BY THE DRAWING AND BY THE HIT TEST ----
 *
 * The footprint and the skin lived inside paint(), so under() had to build its
 * own and it built the wrong rectangle: the grip was drawn on the painting's opaque
 * corner in one place and answered a press at the raster's corner in the
 * other. Measured 16 px apart at 2.6x and 103 px apart at 17x, which is a
 * handle floating in open water below the island while the corner you can see
 * quietly drags the whole place instead. Nothing computes a corner privately
 * any more. */
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

/* THE CORNER YOU PULL, and there is exactly one of it.
 *
 * On the drawn coast, not on the raster, because the raster's corner is out in
 * the water on any map with transparent margin and Ash's rule is that the
 * thing you can see is the thing you can grab.
 *
 * The other three corners are deliberately not handles. x,y is the origin
 * checkWorld measures a berth and a release radius from, so a north or west
 * handle would move the point every distance on this chart is quoted against
 * while you were only trying to change a size. */
const gripOf = (p: Place, fit: Fit, sk: Skin) => {
  const b = skinBox(p, fit, sk)
  return { gx: b.px + b.rw, gy: b.py + b.rh }
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

/* A WORD ON THE WATER GETS A PLATE, NOT A RIM.
 *
 * Every name on this chart was drawn as fill-over-stroke: a three pixel dark
 * outline round each glyph and the colour inside it. On open water that is
 * fine. On a painting it is not, and this chart's whole point is that the
 * paintings are drawn: "Panther's Maw" was 8.5 px salmon strokes over a lit
 * volcano and could not be read at 2.6x or at 17x.
 *
 * A plate is a filled box behind the word. It costs one measureText and it is
 * the difference between a label and a smear. The rim stays for a bare number
 * out in open water, where a box would be heavier than the thing it carries. */
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

  /* EVERY LABEL LAID THIS FRAME, so the next one can be told to go somewhere
   * else. Two names stacked on each other is two names nobody can read, and
   * with the paintings drawn at chart scale it happens the moment two islands
   * sit within a footprint of each other. */
  const laid: Box[] = []

  /* the plate itself. `anchor` says which corner of the box the x,y is, so a
   * caller can hang a label off the left of a mark or the right of one without
   * measuring the text twice. Returns false when the words were dropped rather
   * than drawn, so a caller that wants to try a second position can. */
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
  c.fillStyle = CHART_SEA_FILL
  c.fillRect(X(0), Y(0), doc.w * fit.s, doc.h * fit.s)

  /* THE GRATICULE, IN TWO WEIGHTS AND THE WATER'S OWN HUE.
   *
   * It is the whole reason this reads as a chart and not as a dark box with
   * rectangles on it, and one uniform weight at one pitch is the version of it
   * that reads as tiling. Every fourth line is heavier and carries the world
   * coordinate it stands on, so a berth 152 units off a jetty can be counted
   * off the chart rather than trusted to a number in a form.
   *
   * Only the part of it the stage can see: at full zoom the whole ocean is
   * 4096/8 lines and drawing them all is work thrown away against the clip. */
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
  // and what the heavy ones stand on, along the two edges the eye starts at
  c.font = TINY
  c.fillStyle = CHART_EDGE
  for (let x = Math.max(big, Math.ceil(gx0 / big) * big); x < gx1; x += big) c.fillText(String(x), Math.round(X(x)) + 3, Math.max(top + 10, 10))
  for (let y = Math.max(big, Math.ceil(gy0 / big) * big); y < gy1; y += big) c.fillText(String(y), Math.max(lft + 3, 3), Math.round(Y(y)) - 3)

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

  /* TWO PASSES OVER THE ISLANDS, and the split is the point.
   *
   * Everything painted goes down first and everything you aim with goes on top,
   * so a neighbouring island's picture can never cover the berth diamond you are
   * trying to drag. One pass had the rectangle drawn over its own release ring
   * already; with a whole painting in that rectangle it would have swallowed the
   * marks outright. */
  const shot = (i: number) => {
    const p = doc.places[i]
    const key = artKey(p, reg)
    const img = key ? art.get(key) : undefined
    const { px, py, rw, rh } = boxOf(p, fit)
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
    const lit = on || (hover?.i === i && hover.kind !== 'region')
    const tint = inkFor(STATE_INK, p.state)
    const { px, py, rw, rh } = boxOf(p, fit)
    const sk = skinAt(p, reg, art)
    const seen = skinBox(p, fit, sk)

    /* ---- THE SELECTION, AS ONE TREATMENT ------------------------------------
     *
     * WHAT WAS HERE, counted off a screenshot at 2.6x: a plus sign at the
     * origin, four corner ticks that were three different glyphs because the
     * grip square covered one of them and the cross covered another, a leader
     * line drawn in the STATE ink so it came out teal on an available island
     * while everything else on the selection was amber, and two bare integers,
     * 64x60 and 152, sitting on the pixel art with nothing saying what either
     * of them measured. Six marks, four hues, no words.
     *
     * The rule now is one hue and one voice. Everything the tool draws about
     * the thing you have selected is amber, quiet, and carries its own unit.
     * The state ink keeps the coast outline and the ring and nothing else,
     * because those two are about what the island IS rather than about what you
     * are doing to it. */

    /* THE RING IS DRAWN FROM x,y AND NOT FROM THE MIDDLE OF THE RECTANGLE.
     * checkWorld measures the berth distance with hypot(berth - x,y), so a ring
     * drawn around the centre would be a picture of a rule nobody enforces and
     * an author would trust it and get a warning anyway. */
    c.beginPath()
    c.arc(px, py, p.release * fit.s, 0, Math.PI * 2)
    c.strokeStyle = tint
    c.globalAlpha = lit ? 0.5 : 0.22
    c.setLineDash([3, 5])
    c.stroke()
    c.setLineDash([])
    c.globalAlpha = 1

    /* THE FOOTPRINT, ONLY WHILE IT IS THE THING IN YOUR HAND, AND AS ONE SHAPE.
     *
     * A whole dashed rectangle rather than four hand-drawn corner brackets. The
     * brackets were the same idea and they could not survive the grip and the
     * cross being drawn over two of them; a rectangle has no corners to lose.
     * It is what a berth distance and a release radius are measured against, so
     * it has to be visible while one is being set and wrong to have around the
     * rest of the time, because the coast is inside it. */
    if (on) {
      c.strokeStyle = CHART_ARMED
      c.globalAlpha = 0.4 * warm
      c.setLineDash([3, 4])
      c.strokeRect(Math.round(px) + 0.5, Math.round(py) + 0.5, Math.round(rw), Math.round(rh))
      c.setLineDash([])
      c.globalAlpha = 1
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
        c.strokeStyle = PLATE
        c.stroke()
        c.lineWidth = hot ? 2 : 1.4
        c.strokeStyle = hot ? CHART_ARMED : ink
        c.stroke()
        c.lineWidth = 1
        /* AN ANCHOR'S NAME, ON A PLATE, AND ONLY WHERE ONE CAN BE READ.
         *
         * "Panther's Maw" was 8.5 px of salmon stroke-and-fill laid straight on
         * a lit volcano, which is the single worst-off word on this page. It
         * gets the same plate every other name gets, at a size that follows the
         * island, and it gives way when something is already there: nine doors
         * on one map is nine labels that would otherwise stack into a block.
         *
         * ABOVE THE MARK AND CENTRED ON IT, which is where the editor hangs the
         * same word for the same anchor. It used to sit off the right of the
         * dot here and above it there, so the one mark a person follows from
         * the tool that made it to the chart that places it moved as they
         * crossed. Two surfaces, one habit. */
        if (named || hot) {
          c.font = LABEL(nameAt(rw))
          // rimmed in the mark's own ink whether it is hot or not, which is
          // what the editor draws. A rim only on hover meant a door was a
          // bordered pill in one tool and a bare one in the other.
          plate(displayName(a).text, ax, ay - 8, hot ? CHART_ARMED : ink, { rim: hot ? CHART_ARMED : ink, keep: hot, mid: true })
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
    for (const [what, k] of lit ? ([['approach', p.approach], ['berth', p.berth]] as const) : []) {
      if (!k) continue
      /* THE LEADER IS AMBER, AND IT WAS THE STATE TINT.
       * The hub is `available`, whose ink is #4f9b84, so the one line the tool
       * draws to say "this mooring belongs to that island" came out teal and ran
       * straight across the painting while the diamond at its far end, the grip,
       * the footprint and the outline were all amber. A leader is the tool
       * talking about the selection, so it takes the selection's hue. */
      c.beginPath()
      c.moveTo(px, py)
      c.lineTo(X(k.x), Y(k.y))
      c.strokeStyle = CHART_TOOL
      c.globalAlpha = on ? 0.55 : 0.3
      c.setLineDash([2, 3])
      c.stroke()
      c.setLineDash([])
      c.globalAlpha = 1
      /* HOW LONG THE TETHER IS, WITH A WORD AND A UNIT ON IT.
       * It read "152". Not what it measured, not from where, not in what. Both
       * bare integers on this chart came from the same habit of drawing the
       * number and assuming the picture said the rest. checkWorld measures a
       * berth against the discovery radius and both are in world units, so the
       * label says which mooring and says "u". */
      // and only where the island is big enough to be worth measuring against.
      // At the floor the tether is four pixels long and this plate is fifty.
      if (on && rw >= GRIP_DROP) {
        c.font = TINY
        // two thirds of the way out rather than halfway, because halfway on a
        // short tether is on top of the island the tether starts at
        plate(
          `${what} ${Math.round(Math.hypot(k.x - p.x, k.y - p.y))} u`,
          px + (X(k.x) - px) * 0.66,
          py + (Y(k.y) - py) * 0.66,
          CHART_ARMED,
          { mid: true },
        )
      }
    }
    if (p.approach) {
      const ax = X(p.approach.x)
      const ay = Y(p.approach.y)
      c.beginPath()
      c.arc(ax, ay, 5, 0, Math.PI * 2)
      c.lineWidth = 3.4
      c.strokeStyle = PLATE
      c.stroke()
      c.lineWidth = 1.4
      c.strokeStyle = CHART_TOOL
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
        c.strokeStyle = PLATE
        c.stroke()
        c.lineWidth = 1.6
        c.strokeStyle = CHART_ARMED
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
      c.strokeStyle = PLATE
      c.stroke()
      c.lineWidth = 1
      c.fillStyle = CHART_ARMED
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
    /* the words drawn beside the island. `p.title || p.name` fell through to
       the raw identifier and painted `the_hub` across the chart; displayName
       unpacks it into words instead, and it is the same call the roster in the
       rail makes, so the label on the water and the row in the panel can never
       disagree about what a place is called. */
    const title = displayName(p, 'unnamed').text
    /* AND IT IS DROPPED WHEN THE ISLAND CANNOT CARRY IT.
     *
     * At the zoom floor the hub is ten screen pixels across and "The Hub" at a
     * flat 11 px was fifty, so the caption was five times the size of the thing
     * it captioned and the chart read as a page of labels with specks under
     * them. Under LABEL_DROP only the island under the hand is named, which is
     * the honest answer at that zoom and is also why two labels can never
     * stack out there. */
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

    /* THE CORNER YOU PULL, ON THE CORNER OF THE LINE YOU CAN SEE.
     *
     * It used to be drawn at the raster's corner while the selection outline
     * was drawn round the paint, and the two diverge with zoom: 16 px apart at
     * 2.6x, 103 px at 17x. So the square sat in open water below the island,
     * the corner of the outline answered a press by MOVING the place, and the
     * band that resized ran off the coast into the sea.
     *
     * gripOf is the only thing that knows where this is, and under() asks the
     * same function, so the picture and the hit test cannot drift again.
     *
     * It is an outlined square with a corner mark in it rather than a filled
     * amber block, because the block was the loudest thing on the selection and
     * a handle is the quietest thing you are meant to notice.
     *
     * AND IT IS NOT DRAWN ON AN ISLAND SMALLER THAN THE HANDLE. under() asks
     * the same question before it answers a press, so an island out at the zoom
     * floor is moved and never resized, which is the only thing a ten pixel
     * footprint can honestly offer. */
    if (on && rw >= GRIP_DROP) {
      const { gx, gy } = gripOf(p, fit, sk)
      const g = GRIP - 1
      c.fillStyle = PLATE
      c.fillRect(gx - g, gy - g, g * 2, g * 2)
      c.globalAlpha = 0.4 + 0.6 * warm
      c.strokeStyle = CHART_ARMED
      c.strokeRect(gx - g + 0.5, gy - g + 0.5, g * 2 - 1, g * 2 - 1)
      c.beginPath()
      c.moveTo(gx - 3, gy + 3)
      c.lineTo(gx + 3, gy + 3)
      c.lineTo(gx + 3, gy - 3)
      c.stroke()
      c.globalAlpha = 1
      /* WHAT THE FOOTPRINT IS WORTH, WITH ITS UNIT.
       * It read "64×60" on the pixel art, which is a pair of integers in an
       * app whose other integers are pixels, world units and radii. Beside the
       * handle, because the only time this is on screen is while somebody is
       * pulling the handle and that is where they are looking.
       *
       * FLIPPED TO THE OTHER SIDE WHEN IT WOULD RUN OFF THE STAGE. Drag an
       * island toward the rail and the reading of the size you are dragging it
       * to went under the panel, which is the one moment it is needed. */
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

  /* THE FREE-STANDING MARKS, which had no picture at all.
   *
   * A waypoint belongs to no island, so nothing in the two passes above ever
   * drew one: they were saved, validated, namespaced against every island, and
   * invisible. A ring with a bar through it, because it is neither a berth,
   * which is a diamond, nor an anchor on a painting, which is a dot. */
  for (let i = 0; i < (doc.marks || []).length; i++) {
    const k = (doc.marks as WorldMark[])[i]
    const mx = X(k.x)
    const my = Y(k.y)
    const on = sel?.kind === 'mark' && sel.i === i
    const lit = on || (hover?.kind === 'mark' && hover.i === i)
    if (k.r) {
      c.beginPath()
      c.arc(mx, my, k.r * fit.s, 0, Math.PI * 2)
      c.strokeStyle = on ? CHART_ARMED : CHART_MARK
      c.globalAlpha = lit ? 0.45 : 0.2
      c.setLineDash([3, 5])
      c.stroke()
      c.setLineDash([])
      c.globalAlpha = 1
    }
    c.beginPath()
    c.arc(mx, my, 5.5, 0, Math.PI * 2)
    c.moveTo(mx - 8, my)
    c.lineTo(mx + 8, my)
    c.lineWidth = 3.4
    c.strokeStyle = PLATE
    c.stroke()
    c.lineWidth = on ? 2 : 1.4
    c.strokeStyle = on ? CHART_ARMED : CHART_MARK
    c.stroke()
    c.lineWidth = 1
    // the words, never the identifier. Ash asked for waypoints to carry labels
    // and this is the surface that has to honour it. Above the ring and centred
    // on it, the same place an anchor's name and a route's name sit, so a point
    // on the water is captioned the way a point on a painting is.
    c.font = LABEL(on ? LABEL_MAX - 3 : LABEL_MIN + 1)
    plate(displayName(k, 'unnamed mark').text, mx, my - 10, on ? CHART_ARMED : CHART_MARK, { rim: on ? CHART_ARMED : CHART_MARK, keep: lit, mid: true })
  }

  if (band) {
    c.setLineDash([4, 3])
    c.strokeStyle = CHART_TOOL
    c.strokeRect(X(Math.min(band.x0, band.x1)), Y(Math.min(band.y0, band.y1)), Math.abs(band.x1 - band.x0) * fit.s, Math.abs(band.y1 - band.y0) * fit.s)
    c.setLineDash([])
  }

  /* the edge of the world last, over everything, so an island hanging off it
   * is unmistakable. In --ink-edge and not in gold: gold is the tool speaking
   * about the thing you have armed, and where the water stops is a fact of the
   * document that is true whether anything is selected or not. */
  c.strokeStyle = CHART_EDGE
  c.lineWidth = 1
  c.strokeRect(X(0) + 0.5, Y(0) + 0.5, doc.w * fit.s, doc.h * fit.s)
  c.font = MONO
  say('0,0', X(0), Y(0) - 6, CHART_QUIET)
  const end = `${doc.w},${doc.h}`
  say(end, X(doc.w) - c.measureText(end).width, Y(doc.h) + 14, CHART_QUIET)

  /* THE RULER, WHICH IS ONE GRATICULE SQUARE WIDE, AND IT SAYS SO.
   *
   * It was a hairline with a bare "32" beside it, and "32" is not a length: it
   * is a number next to a line, in a page that also quotes radii, pixel sizes
   * and footprints. Discovery is 520 and a berth sits a few dozen units off a
   * jetty, and there was nothing anywhere saying how far that is on screen.
   *
   * A ruler now: end ticks, a mid tick, the halved value under the mid, the
   * whole value under the end, and the word. One graticule square wide, so the
   * grid IS the ruler repeated and a distance is counted rather than guessed. */
  const rx = 16
  const ry = size.h - 24
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
  c.fillStyle = CHART_QUIET
  c.fillText('0', rx - 1, ry + 12)
  c.fillText(String(step / 2), rx + rl / 2 - 5, ry + 12)
  c.fillText(`${step} world units`, rx + rl + 7, ry + 3)
}

/* What is under the pointer, tested in the order things are drawn on top of
 * each other: the size handle of the selected island, then its marks, then the
 * islands newest first, then the water regions. A region is last because it is
 * the biggest thing on the chart and would otherwise swallow every click. */
function under(doc: Doc, fit: Fit, sel: Sel, mx: number, my: number, skin: (p: Place) => Skin): Hit {
  const X = (x: number) => fit.ox + x * fit.s
  const Y = (y: number) => fit.oy + y * fit.s
  const near = (x: number, y: number, r: number) => Math.hypot(mx - X(x), my - Y(y)) <= r

  /* THE CORNER, THROUGH THE FUNCTION THAT DRAWS IT.
   * This built its own corner out of the raw footprint while paint drew the
   * square on the painted coast, so the amber block you aimed at was 16 px
   * from the band that answered at 2.6x and 103 px from it at 17x. One
   * reader, so a press and a picture cannot disagree about where a handle is. */
  const chosen = sel?.kind === 'place' ? doc.places[sel.i] : undefined
  // and only while there is a handle drawn. rig() drops it under GRIP_DROP,
  // where the square would be wider than the island, and a hot spot with no
  // picture under it is the same lie the handle used to tell from 103 px away.
  if (chosen && sel?.kind === 'place' && chosen.w * fit.s >= GRIP_DROP) {
    const { gx, gy } = gripOf(chosen, fit, skin(chosen))
    if (Math.abs(mx - gx) <= GRIP && Math.abs(my - gy) <= GRIP) return { kind: 'size', i: sel.i }
  }
  // a free-standing mark is a point and nothing else, so it sits with the other
  // points rather than with the islands. Ahead of them, because it is drawn
  // last and a waypoint dropped over an island has to stay reachable.
  const list = doc.marks || []
  for (let i = list.length - 1; i >= 0; i--) if (near(list[i].x, list[i].y, 10)) return { kind: 'mark', i }
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
  /* WHAT IS ACTUALLY IN THE HAND, as state and not as the ref the drag lives
   * in. The ref cannot make the cursor change, because writing a ref does not
   * render, so the shape was frozen for the whole of a press. */
  const [hand, setHand] = useState<'' | 'pan' | 'place' | 'berth' | 'approach' | 'size' | 'mark'>('')
  const [band, setBand] = useState<Band>(null)
  /* WHERE THE ARMED TOOL'S ONE LINE IS DRAWN, which used to be the top centre of
   * the stage: measured 500 px from the button that armed it and 500 px from
   * the water the click has to land on, sitting on top of the zoom cluster on
   * the way. It rides just off the pointer instead. Only written while a tool
   * is armed, so the ordinary case of moving a pointer across the chart costs
   * no renders at all. */
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
  // whether this account is the one the ocean belongs to. null while nobody
  // has answered, and the chart waits rather than flashing up and going away.
  const [mine, setMine] = useState<boolean | null>(null)

  const box = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const art = useRef<Art>(new Map())
  const drag = useRef<{
    kind: 'place' | 'berth' | 'approach' | 'size' | 'mark'
    i: number
    dx: number
    dy: number
    mx: number
    my: number
    w: number
    h: number
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
        const fresh: Doc = { w: j.w, h: j.h, places: j.places || [], regions: j.regions || [], marks: j.marks, home: j.home || '' }
        saved.current = stamp(fresh)
        setDoc(fresh)
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

  /* THE FOOTPRINTS ARE PUT RIGHT ONCE, AT THE LOAD, AND IT IS NOT AN EDIT.
   *
   * Every place used to be born 64x64 and the hub is 688x640, so the document
   * on the server holds squares for paintings that are not square and every
   * anchor on them lands a few percent off. The correction has to happen: a
   * berth placed against a squashed jetty is placed against nothing.
   *
   * WHERE it happened was the bug. The inspector did it on mount, so opening an
   * island to read its name rewrote its height, lit the save button, and made
   * the undo button unable to reach a clean document, because stepping back put
   * the panel straight back on screen to do it again. Measured: a fresh /world
   * said "saved", one click on the roster said "save".
   *
   * So it runs here, over the whole document, on the frame the registry lands,
   * and the result is folded into the saved stamp. Nothing on screen changed by
   * the author, so nothing claims it did; the corrected height rides out with
   * the next real save. It is idempotent, so a load that finds the document
   * already square with its paintings does nothing at all. */
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
    // and only folded in while the document still matches what the server sent.
    // If the registry is slow enough that somebody has already dragged an
    // island, re-stamping here would swallow their change and the save button
    // would go quiet with work in it.
    if (stamp(doc) === saved.current) saved.current = stamp(put)
    setDoc(put)
  }, [doc, reg])

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
      /* AT THE FLOOR, THE OCEAN GOES BACK IN THE MIDDLE.
       *
       * Anchoring the zoom on a point is right everywhere except at the very
       * bottom, where there is nothing left to zoom and the anchor only slides
       * the water. Pan a long way out and press minus and the whole 4096 square
       * ends up off the side of the stage with its bottom cut off, which is a
       * chart of nothing that still says 1:6. The floor means "the whole ocean",
       * so it draws the whole ocean. */
      if (s <= base.s * 1.0001) return glide(base)
      glide({ s, ox: mx - (mx - f.ox) * (s / f.s), oy: my - (my - f.oy) * (s / f.s) })
    },
    [base, glide],
  )

  /* ONE PRESS IS ONE RUNG, and the rungs are named numbers.
   *
   * A fixed factor per press walked the readout 1.6, 2.6, 4.1, 6.6 and never
   * landed on 2, 4 or 8, so the two most discoverable controls on the chart
   * could not reach a round zoom at all. The ladder is clamped to what this
   * ocean on this stage can actually show, and the floor is always its first
   * rung so pulling all the way back is still one press away. */
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

  /* AND THE WHOLE OCEAN, WHICH NOTHING COULD ASK FOR.
   * `base` was the zoom floor and the fallback for an empty chart and was
   * reachable no other way, so the only view of the water the header names was
   * arrived at by pressing minus until it stopped. */
  const frameSea = useCallback(() => glide(base), [base, glide])

  /* THE PANEL STARTS AT THE TOP OF WHATEVER WAS JUST SELECTED.
   *
   * It kept the scroll from the last island, so picking a new one landed you
   * somewhere down in its berth fields with the name off the top, and the name
   * is the one field a place born a second ago actually needs. Keyed on which
   * row is selected rather than on the row's contents, so typing in a field
   * does not throw the panel back to the top under your hands. */
  useEffect(() => {
    if (sel) panel.current?.scrollTo({ top: 0 })
  }, [sel?.kind, sel?.i])

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
    if (!place) return
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
  }, [place, spot, size, base.s, glide])

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

  /* A STEP BACK KEEPS WHAT YOU WERE WORKING ON.
   *
   * This dropped the selection, so undoing one nudge shut the inspector and
   * threw away the island being nudged, and the next thing an author did was
   * find it again. Only an index the restored document no longer has is let
   * go, which is the one case where holding on would point the panel at
   * nothing.
   *
   * And the dirty flag is answered rather than raised: stepping back to the
   * document the server holds means there is nothing to send. */
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
    setDoc((d) => (d ? { ...d, places: d.places.map((p, k) => (k === i ? { ...p, ...patch } : p)) } : d))
    setDirty(true)
  }, [])

  const editMark = useCallback((i: number, patch: Partial<WorldMark>) => {
    setDoc((d) => (d ? { ...d, marks: (d.marks || []).map((m, k) => (k === i ? { ...m, ...patch } : m)) } : d))
    setDirty(true)
  }, [])
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

  /* THE SAME READING OF THE PICTURE THE CHART DRAWS WITH, handed to every hit
   * test. skinOf caches by slug and version, so this is a map lookup and not
   * an alpha scan per pointer move. */
  const skin = useCallback((p: Place) => skinAt(p, reg, art.current), [reg])

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
      setHand('pan')
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
      // one size, every time, and the painting bends the short side later.
      // Born 64x64 it depended on nothing and looked like nothing.
      const born = bornAs()
      const made: Place = {
        name,
        map: '',
        title: '',
        /* THE CLICK IS THE MIDDLE OF THE ISLAND, NOT ITS TOP LEFT CORNER.
         * x,y is the corner because that is where a raster starts and where
         * every distance is measured from, but nobody aiming at open water is
         * thinking about a corner. Anchored there, a click low or right on the
         * stage put most of the new island off the edge of the view and the
         * first thing an author did was drag it back. */
        x: clamp(Math.round(w.x - born.w / 2), 0, doc.w),
        y: clamp(Math.round(w.y - born.h / 2), 0, doc.h),
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

    /* A WAYPOINT IS A PRESS AND NOTHING ELSE.
     *
     * It has no footprint to size and no painting to line up with, so there is
     * nothing to drag out. The name goes in one namespace with every island and
     * every stretch of water, because a grape calls sail_to("north_passage")
     * and never says which list to look in, so the free name is checked against
     * all three or checkWorld refuses the save with a duplicate. */
    if (tool === 'mark') {
      const taken = [...doc.places.map((p) => p.name), ...doc.regions.map((r) => r.name), ...(doc.marks || []).map((k) => k.name)]
      const made: WorldMark = {
        name: freeName('waypoint', taken),
        kind: 'waypoint',
        x: clamp(Math.round(w.x), 0, doc.w),
        y: clamp(Math.round(w.y), 0, doc.h),
        // a label from the start, so a mark never reaches a player as
        // `waypoint_1`. Ash, 2026-08-29: waypoints get labels too.
        label: displayName({ name: freeName('waypoint', taken) }).text,
        // the same order of size a berth sits at off a jetty, so arriving is not
        // an exact-pixel test on a hull that moves in floats
        r: 40,
      }
      remember()
      setDoc({ ...doc, marks: [...(doc.marks || []), made] })
      setSel({ kind: 'mark', i: (doc.marks || []).length })
      setTool('move')
      setDirty(true)
      return
    }

    const hit = under(doc, fit, sel, mx, my, skin)
    if (!hit) {
      /* EMPTY WATER DRAGS THE CHART, and only DESELECTS if the pointer did not
       * really move. Zoomed in, panning is the thing you do most, and reaching
       * for a scrollbar that is not there was the first thing that made this
       * page feel broken. */
      pan.current = { mx, my, ox: fit.ox, oy: fit.oy, far: 0 }
      setHand('pan')
      return
    }
    if (hit.kind === 'region') {
      setSel({ kind: 'region', i: hit.i })
      return
    }
    if (hit.kind === 'mark') {
      setSel({ kind: 'mark', i: hit.i })
      setSure(false)
      const k = (doc.marks || [])[hit.i]
      drag.current = { kind: 'mark', i: hit.i, dx: w.x - k.x, dy: w.y - k.y, mx, my, w: 0, h: 0 }
      setHand('mark')
      remember()
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
    setHand(hit.kind)
    remember()
  }

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!doc) return
    const { mx, my } = at(e)
    const w = toWorld(mx, my)

    /* the armed tool's line follows the hand. Only while one is armed, so an
     * ordinary pointer sweep across the chart still costs no state at all.
     *
     * Held inside the stage on both axes: down and right of the cursor is where
     * it belongs, and near the panel edge or the bottom of the water that is
     * off screen, which is a worse place for it than the one it came from. 230
     * is the widest line this ever says, measured, plus its padding. */
    if (pick || tool !== 'move')
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
      // the same hit, held rather than replaced, or every pixel of pointer
      // movement is a new object and a full repaint of the chart
      const h = under(doc, fit, sel, mx, my, skin)
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
    else if (d.kind === 'mark') editMark(d.i, { x, y })
    else {
      /* THE GRIP STAYS UNDER THE HAND, and the arithmetic is what puts it there.
       *
       * The old branch geared the travel to half and divided it by the raw
       * footprint, so a 300 px drag left the drawn corner 242 px from the
       * cursor and the handle read as something you steered rather than
       * something you held.
       *
       * sk.x1 is the fraction of the footprint's screen width the drawn corner
       * sits at, so one world unit of w carries the corner sk.x1 * fit.s
       * pixels. Dividing the hand's travel by that is the corner tracking the
       * cursor exactly. Dividing by the FOOTPRINT instead, which is what this
       * did, overshoots by however much transparent margin the painting
       * carries: a third of it on the hub. */
      const p0 = doc.places[d.i]
      const m = p0.map ? reg.get(p0.map) : undefined
      const sk = skin(p0)
      const gain = e.shiftKey ? RESIZE_FINE : RESIZE_GAIN
      // never zero, or a picture whose paint stops short of its own left edge
      // would divide a whole drag by nothing and throw the footprint to its fence
      const kx = Math.max(1e-3, sk.x1 * fit.s)
      const ky = Math.max(1e-3, sk.y1 * fit.s)
      const hx = (mx - d.mx) * gain
      const hy = (my - d.my) * gain
      // the handle honours the same lock the inspector does, so dragging a
      // footprint cannot quietly squash the painting inside it
      const held = lock && m && m.w > 0 && m.h > 0
      let nw: number
      let nh: number
      if (held && m) {
        /* HELD, THE CORNER CAN ONLY RUN ALONG ONE DIAGONAL, so the hand's
         * travel is projected onto it. Averaging the two axes, which is what
         * this used to do, meant a drag straight down and a drag straight
         * right each got half of what was asked and the corner sat off the
         * cursor in both. Projection puts it as close as the shape allows and
         * exactly under the cursor whenever the drag runs along the diagonal. */
        const vx = kx * d.w
        const vy = (ky * d.w * m.h) / m.w
        const k = (hx * vx + hy * vy) / Math.max(1e-6, vx * vx + vy * vy)
        nw = side(d.w + d.w * k)
        nh = side((nw * m.h) / m.w)
      } else {
        nw = side(d.w + hx / kx)
        nh = side(d.h + hy / ky)
      }
      if (nw !== p0.w || nh !== p0.h) edit(d.i, { w: nw, h: nh })
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
        // marks always go, and they used to be sent only if the load had
        // brought some back. The waypoint tool can now make the first one on an
        // ocean that had none, and an absent key means "keep what is in the
        // row", so that first waypoint would have been dropped in silence.
        body: JSON.stringify({ w: doc.w, h: doc.h, places: doc.places, regions: doc.regions, marks: doc.marks || [], home: doc.home || '' }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setProblems(j.problems?.length ? j.problems : [j.error || `the server refused it (${r.status})`])
        return
      }
      const kept: Doc = { w: j.w, h: j.h, places: j.places || [], regions: j.regions || [], marks: j.marks, home: j.home || '' }
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

  /* ONE NOTATION, ALL THE WAY DOWN.
   *
   * It read "2.6×" zoomed in and "1:6" zoomed out, which is two different
   * things written in the same 42 px slot: a multiplier and a ratio, swapping
   * over at a boundary nothing on screen announces. Pressing minus took the
   * number from 1.5 to 1:1 to 1:2 and it looked like the readout had broken.
   * A multiplier throughout, with the decimals only where they carry
   * information, so the sequence is 0.16, 0.25, 0.5, 1, 2, 4, 8. */
  const scale = `${fit.s >= 10 ? Math.round(fit.s) : fit.s >= 1 ? Number(fit.s.toFixed(1)) : Number(fit.s.toFixed(2))}×`
  /* HOW MUCH OF THE OCEAN IS ACTUALLY IN FRONT OF YOU.
   *
   * The header advertises 4096 × 4096 and the opening view frames the islands,
   * which on a chart holding one island is about two hundred units across: half
   * a per cent of the water by area, with nothing saying so. It is the right
   * view to open on and the wrong thing to leave unlabelled, so the span is
   * quoted beside the zoom and the button that goes to the whole square is
   * named "ocean" rather than hidden inside "fit". */
  const span = size.w && fit.s ? Math.round(size.w / fit.s) : 0
  /* WHAT A PRESS WOULD DO, SAID BY THE CURSOR, AND IT COULD NOT SAY IT WHILE
   * YOU WERE PRESSING.
   *
   * hover is only written while nothing is held, so the whole of a pan and the
   * whole of a drag ran under whatever the cursor happened to be a moment
   * earlier. `hand` is the missing half: it is set at the press, so the shape
   * changes when the hand closes and changes back when it opens.
   *
   * A region says pointer and not move, because a press on one SELECTS it and
   * nothing here drags a stretch of water. A cursor promising a move that no
   * press performs is the same lie the handle was telling. */
  const grip =
    hand === 'pan'
      ? 'grabbing'
      : hand === 'size'
        ? 'nwse-resize'
        : hand
          ? 'move'
          : pick || tool !== 'move'
            ? 'crosshair'
            : hover?.kind === 'size'
              ? 'nwse-resize'
              : hover?.kind === 'region'
                ? 'pointer'
                : hover
                  ? 'move'
                  : 'grab'

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
          {/* THE FREE-STANDING POINT, which is the one thing this bar could not
              make. A berth and an approach both belong to an island, so the
              corner a crossing turns at had to be faked as a berth on whichever
              island was nearest, and then it moved when that island moved. */}
          <button className={'world-tool' + (tool === 'mark' ? ' on' : '')} onClick={() => setTool('mark')} title="drop a named point on open water">
            waypoint
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
            <p className="world-hint" role="status" style={{ '--hx': `${nib.x}px`, '--hy': `${nib.y}px` } as React.CSSProperties}>
              {pick
                ? aim
                  ? `on ${displayName(aim.split('/')[1]).text}`
                  : `click the water · esc`
                : tool === 'place'
                  ? 'click open water · esc'
                  : tool === 'mark'
                    ? 'click open water to drop a waypoint · esc'
                    : 'drag out the water · esc'}
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
            <button className="world-zbtn" onClick={() => rung(-1, ...holdPt)} aria-label="zoom out" title="zoom out one step">
              −
            </button>
            <span className="world-zread" title={`${span} world units across the stage`}>
              {scale}
            </span>
            <button className="world-zbtn" onClick={() => rung(1, ...holdPt)} aria-label="zoom in" title="zoom in one step">
              +
            </button>
            {/* THREE FRAMINGS, EACH SAYING WHAT IT FRAMES. "fit" showed about a
                two hundred unit window of a 4096 unit ocean the header
                advertises, which is right for opening a chart and wrong to call
                fit with nothing else on offer. */}
            <button className="world-zbtn wide" onClick={frameSea} title={`the whole ${doc.w} × ${doc.h} ocean`}>
              ocean
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
          ) : spot && sel?.kind === 'mark' ? (
            <MarkPanel m={spot} sure={sure} onSure={setSure} onEdit={(patch) => editMark(sel.i, patch)} onDrop={() => dropMark(sel.i)} />
          ) : null}

          {/* THE ROSTER READS THE WAY A PERSON WOULD SAY IT.
              It printed `the_hub`, which is the address python holds and not a
              name anybody gave a place. Every row here carries a second field
              for exactly this and the column was ignoring it, so displayName
              takes the title when there is one and unpacks the identifier when
              there is not. The identifier is still one hover away, because the
              author writing a grape needs the string they will type. */}
          {/* WHAT THIS CHART IS, IN A RAIL THAT WAS OTHERWISE AIR.
              Measured 290 by 719 holding a heading and one 15 px row, which is
              97 per cent nothing with a border down the side. The empty state
              answers a rail with nothing in it; this answers the case /world is
              actually in, which is one island and a column of air under it.
              Counts, the water it sits in, the fraction of it on screen, and
              the things the save is going to complain about. */}
          {!sel && <Summary doc={doc} span={span} />}

          <div className="world-roster">
            {/* ONE COLUMN, ONE MEANING. The right hand column printed a map slug
                on an island row and a KIND on a water row, so the same 42 px of
                the rail meant two unrelated things one line apart. It is the
                address everywhere now, which is the one field every row on this
                ocean has and the one string a grape actually types, and what
                kind of thing a row is comes from the group it sits in. */}
            {(
              [
                ['islands', doc.places.length],
                ['water', doc.regions.length],
                ['waypoints', (doc.marks || []).length],
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
                  {what === 'waypoints' &&
                    (doc.marks || []).map((m, i) => {
                      const said = displayName(m, 'unnamed mark')
                      return (
                        <button
                          key={'m' + i}
                          className={'world-row' + (sel?.kind === 'mark' && sel.i === i ? ' on' : '')}
                          onClick={() => setSel({ kind: 'mark', i })}
                          title={`${said.text} · ${m.kind}${said.derived ? ' · no label yet, so the words were read off the address' : ''}`}
                        >
                          <i style={{ background: 'var(--acc-mark)' }} />
                          <span className={'world-row-n' + (said.derived ? ' guessed' : '')}>{said.text}</span>
                          <span className="world-row-m">{m.name}</span>
                        </button>
                      )
                    })}
                </div>
              )
            })}
          </div>

          {/* the shared empty state, for the ocean that genuinely has nothing on
              it. Anything else is answered by the summary above. */}
          {!sel && !doc.places.length && !doc.regions.length && !(doc.marks || []).length && (
            <div className="nothing">
              <p className="nothing-say">nothing is on this ocean yet</p>
              <p className="nothing-do">place the first island</p>
            </div>
          )}
          {!sel && (doc.places.length > 0 || doc.regions.length > 0 || (doc.marks || []).length > 0) && (
            <Key doc={doc} />
          )}
        </aside>
      </div>
    </div>
  )
}

/* WHAT THE COLOURED DOTS MEAN, AT THE FOOT OF THE RAIL.
 *
 * Two things at once, and the second is why it is here rather than in a help
 * sheet. A roster row carries a square of state ink and nothing on the page
 * said what green was, so the one piece of information the chart encodes as
 * colour was the one piece a reader had to already know. That is a legend, and
 * a chart with a legend is the normal shape of this.
 *
 * The other thing is the rail's floor. Measured with one island on the water:
 * the column is 719 px tall and the summary and roster fill 183 of them, so
 * three quarters of it is air with a border down the side. A legend is real
 * content that belongs at the bottom, so it sits on `margin-top: auto` and the
 * rail reads as a panel with a floor instead of a panel with a hole.
 *
 * ONLY WHAT IS ACTUALLY ON THE WATER. Seven states and five water kinds listed
 * unconditionally is a wall of swatches for a document using two of them, and
 * that is a worse rail than the empty one. */
function Key({ doc }: { doc: Doc }) {
  const rows: { ink: string; word: string }[] = []
  for (const s of [...new Set(doc.places.map((p) => p.state))]) rows.push({ ink: inkFor(STATE_INK, s), word: s })
  for (const k of [...new Set(doc.regions.map((r) => r.kind))]) rows.push({ ink: inkFor(SEA_INK, k), word: k })
  if ((doc.marks || []).length) rows.push({ ink: CHART_MARK, word: 'waypoint' })
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

/* WHAT IS ON THIS CHART, FOR A RAIL THAT WAS 97 PER CENT AIR.
 *
 * The empty state in tokens.css is the right answer for a panel with nothing in
 * it. It is the wrong answer for /world, which is a chart with one island on it
 * and seven hundred pixels of nothing under one row: not empty, just thin, and
 * a thin panel does not get fixed by a sentence saying it is empty.
 *
 * So the rail says something true about the chart instead. The counts, the
 * water they sit in, how much of that water is on screen right now, and the
 * work the save is going to name: exactly the warnings checkWorld raises, said
 * before the press rather than after it. On a full ocean the last line goes
 * away and the block is four rows, which is what a summary should cost. */
function Summary({ doc, span }: { doc: Doc; span: number }) {
  const marks = doc.marks || []
  /* THE SAME QUESTIONS server/store/world.mjs ASKS AT THE SAVE, in the same
   * order, so nothing here can promise a clean save the server then refuses. */
  const todo: string[] = []
  const homeless = !doc.home && doc.places.length
  const noId = doc.places.filter((p) => p.map && !p.place).length
  const noBerth = doc.places.filter((p) => p.map && !p.berth).length
  const noMap = doc.places.filter((p) => !p.map).length
  if (homeless) todo.push('no island is marked as where a run starts')
  if (noId) todo.push(`${noId} ${noId === 1 ? 'island has' : 'islands have'} no place id, so the game cannot count a visit`)
  if (noBerth) todo.push(`${noBerth} ${noBerth === 1 ? 'island has' : 'islands have'} nowhere to tie up`)
  if (noMap) todo.push(`${noMap} ${noMap === 1 ? 'slot holds' : 'slots hold'} no painting yet`)
  return (
    <div className="world-sum">
      <div className="world-sum-r">
        <span>on the water</span>
        <b>
          {doc.places.length} island{doc.places.length === 1 ? '' : 's'}
        </b>
      </div>
      {/* only the parts that are there. "0 water · 1 waypoint" is a row that
          spends half its width saying nothing happened. */}
      {(doc.regions.length > 0 || marks.length > 0) && (
        <div className="world-sum-r">
          <span>also marked</span>
          <b>
            {[
              doc.regions.length ? `${doc.regions.length} water` : '',
              marks.length ? `${marks.length} waypoint${marks.length === 1 ? '' : 's'}` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </b>
        </div>
      )}
      <div className="world-sum-r">
        <span>the ocean</span>
        <b>
          {doc.w} × {doc.h} u
        </b>
      </div>
      {/* the honest half of the fit question. The header advertises 4096 and the
          opening view frames the islands, so this says how wide the window on it
          currently is rather than letting the two numbers sit unrelated. */}
      {/* and it says so in words when the stage has not been measured yet. It
          printed an em dash, which is a typographic shrug in a readout column
          where every other row is a number and a unit. */}
      <div className="world-sum-r">
        <span>in view</span>
        <b>{span ? `${span} u across` : 'not drawn yet'}</b>
      </div>
      {todo.length > 0 && <p className="world-sum-todo">{todo[0]}</p>}
    </div>
  )
}

/* A POINT ON OPEN WATER THAT BELONGS TO NOTHING.
 *
 * Every other panel on this page edits something with a footprint. This one has
 * a name, a kind, two coordinates, a radius and a heading, and that is the
 * whole of a waypoint: the corner a sail leg turns at, which is exactly what
 * the ocean could not author until now. */
function MarkPanel({
  m,
  sure,
  onSure,
  onEdit,
  onDrop,
}: {
  m: WorldMark
  sure: boolean
  onSure: (v: boolean) => void
  onEdit: (patch: Partial<WorldMark>) => void
  onDrop: () => void
}) {
  const said = displayName(m, 'unnamed mark')
  const legal = isMarkName(m.name)
  return (
    <div className="world-insp">
      <div className="world-head">
        <b className={said.derived ? 'guessed' : ''}>{said.text}</b>
        <span className="world-code">
          <i>waypoint</i> {m.name}
        </span>
      </div>
      <div className="world-set">
        <span className="world-lab">what a person reads</span>
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
      </div>
      <div className="world-set">
        <span className="world-lab">what code addresses</span>
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
        <label className="world-f">
          <span>kind</span>
          <select className="world-in" value={m.kind} onChange={(e) => onEdit({ kind: e.target.value as MarkKind })}>
            {MARK_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="world-set">
        <span className="world-lab">where it is</span>
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
        <Facing v={m.facing || ''} say="the heading held here" on={(k) => onEdit({ facing: k || undefined })} />
      </div>
      <Scrap what={said.text} sure={sure} onSure={onSure} onDrop={onDrop} />
    </div>
  )
}

/* THE COMPASS, WITH THE WORD IT WAS MISSING.
 *
 * Nine arrow buttons in a 3x3 block with nothing above them, in a column where
 * every other control has a caption over it. It was readable only if you
 * already knew that a berth has a facing, which is the one group on this page
 * that cannot be worked out from its own shape. Lifted out of the inspector so
 * a berth and a waypoint ask for a heading the same way. */
function Facing({ v, say, on }: { v: string; say: string; on: (k: string) => void }) {
  return (
    <div className="world-f">
      <span>{say}</span>
      <div className="world-face" role="group" aria-label={say}>
        {FACE_GRID.flat().map((k, n) => (
          <button
            key={k || 'none'}
            className={'world-fbtn' + ((k ? v === k : !v) ? ' on' : '')}
            title={k || 'no opinion'}
            aria-pressed={k ? v === k : !v}
            onClick={() => on(k && v !== k ? k : '')}
          >
            {FACE_ARROW[n]}
          </button>
        ))}
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
   * IT DOES NOT HAPPEN HERE ANY MORE. It ran on mount, so opening an island to
   * read it rewrote its height and lit the save button on a page nobody had
   * edited, and undo could then never reach a clean document because the panel
   * put the change straight back. Correcting the document is right; charging it
   * to the author for looking is not. squareUp in World() does it once, for
   * every place, at the load, before the page decides what "saved" means. */

  const said = displayName(p, 'unnamed island')
  return (
    <div className="world-insp">
      {/* THE PANEL SAYS WHICH ISLAND IT IS ABOUT.
          The heading was the word "island" on every island, so the only place
          the thing's name appeared was inside the name field, where it is the
          ADDRESS and not a name at all. Ash, 2026-08-29: humans see labels, and
          the snake_case stays where it is the address, marked as the code
          name. */}
      <div className="world-head">
        <b className={said.derived ? 'guessed' : ''}>{said.text}</b>
        <span className="world-code">
          <i>island</i> {p.name}
        </span>
      </div>

      {/* THE ACTS FIRST, AND THIS IS THE WHOLE RESTRUCTURE.
          Measured: the panel ran 856 px inside a 719 px column, so "set" for a
          berth, which is the entire reason this page draws the paintings, sat
          below the fold behind eleven number fields. Nothing here is a field.
          Everything here is something somebody came to the panel to do. */}
      <div className="world-acts">
        <button
          className={'world-btn small' + (pick === 'berth' ? ' on' : '')}
          title="where the ship ties up · then click the water, and a mark on the island snaps"
          onClick={() => onPick(pick === 'berth' ? '' : 'berth')}
        >
          {p.berth ? 'move berth' : 'set berth'}
        </button>
        <button
          className={'world-btn small' + (pick === 'approach' ? ' on' : '')}
          title="where the hull waits before it comes in · then click the water"
          onClick={() => onPick(pick === 'approach' ? '' : 'approach')}
        >
          {p.approach ? 'move approach' : 'set approach'}
        </button>
      </div>

      <div className="world-set">
        <span className="world-lab">what a person reads</span>
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
      </div>

      <div className="world-set">
        <span className="world-lab">what code addresses</span>
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
      </div>

      <details className="world-set" open={!p.map}>
        <summary className="world-lab">the painting and the footprint</summary>
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
                {displayName(s).text}
                {slugs.includes(s) ? '' : ' · unpublished'}
              </option>
            ))}
          </select>
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
      </details>

      <details className="world-set">
        <summary className="world-lab">how far it reaches</summary>
        {/* TWO RADII, AND THIS PANEL HAD ONE UNDER THE WRONG NAME. What was called
            release here is what the game calls discover; what the game calls
            release is how far out the bundle stays decoded, which is the number
            the memory budget trims against and had no control at all. */}
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
        {/* ONE SLOT FOR THE WHOLE OCEAN, so it is a radio wearing a checkbox: a
            run starts in one place, and two islands both claiming it would make a
            fresh run begin in whichever the reader happened to find first.
            Ticking this unticks any other by writing one name on the world. */}
        <label className="world-check" title="a run with no ship yet begins here, and a graduate is handed back to it">
          <input type="checkbox" checked={home === p.name} onChange={(e) => onHome(e.target.checked ? p.name : '')} />
          <span>the run starts here</span>
        </label>
      </details>

      <details className="world-set" open={!!p.berth || !!p.approach}>
        <summary className="world-lab">
          the mooring{p.map ? ` · ${marks.length} mark${marks.length === 1 ? '' : 's'} to aim at` : ''}
        </summary>
        {p.berth ? (
          <>
            <div className="world-mark">
              <span className="world-mark-t">berth</span>
              <button
                className="world-btn small danger"
                title="take the berth off"
                onClick={() => {
                  onBefore()
                  set({ berth: undefined })
                }}
              >
                remove
              </button>
            </div>
            <div className="world-pair">
              <Num label="x" v={p.berth.x} on={(n) => set({ berth: { ...p.berth, x: n } as Pt })} />
              <Num label="y" v={p.berth.y} on={(n) => set({ berth: { ...p.berth, y: n } as Pt })} />
            </div>
            {/* the heading held once the hull is tied up, on the compass the
                editor already uses for a door and a post, so a facing is set the
                same way everywhere in this tool. Through Facing, which is where
                the caption this block never had now lives. */}
            <Facing
              v={p.berth.facing || ''}
              say="the heading held at the berth"
              on={(k) => {
                const b = p.berth as Pt
                // rebuilt rather than spread, so clearing a facing really
                // clears it. The arrival anchor is carried across by hand,
                // because it is the one other thing living on this point.
                const at = b.at ? { at: b.at } : {}
                set({ berth: k ? { x: b.x, y: b.y, facing: k, ...at } : { x: b.x, y: b.y, ...at } })
              }}
            />
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
                {/* the anchor's own words, not its identifier. mask.ts keeps
                    label separate from name for exactly this reason and every
                    reader of the list was printing the address. */}
                {marks.map((a) => (
                  <option key={a.name} value={a.name}>
                    {displayName(a).text}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <p className="world-note">no berth yet, so a ship cannot tie up here</p>
        )}
        {p.approach ? (
          <>
            <div className="world-mark">
              <span className="world-mark-t">approach</span>
              <button
                className="world-btn small danger"
                title="take the approach off"
                onClick={() => {
                  onBefore()
                  set({ approach: undefined })
                }}
              >
                remove
              </button>
            </div>
            <div className="world-pair">
              <Num label="x" v={p.approach.x} on={(n) => set({ approach: { ...p.approach, x: n } as Pt })} />
              <Num label="y" v={p.approach.y} on={(n) => set({ approach: { ...p.approach, y: n } as Pt })} />
            </div>
          </>
        ) : (
          <p className="world-note">no approach, so the hull comes straight in</p>
        )}
      </details>

      {/* the words, not the address. It read "remove the_hub" at a person. */}
      <Scrap what={said.text} sure={sure} onSure={onSure} onDrop={onDrop} />
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
      <div className="world-set">
        <span className="world-lab">what a person reads</span>
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
      </div>
      <div className="world-set">
        <span className="world-lab">what code addresses</span>
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
      </div>
      <div className="world-set">
        <span className="world-lab">where it is</span>
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
      </div>
      <Scrap what={said.text} sure={sure} onSure={onSure} onDrop={onDrop} />
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
