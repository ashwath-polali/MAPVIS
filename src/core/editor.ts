/* The editor: one canvas, one painting, one mask on top of it. React owns the chrome; everything per frame or per pixel happens here, outside React, so a brush stroke never runs a render pass. */
import { ANCHOR_INK, inkFor } from './ink'
import { cleanLife, lifeAt, liveState, separate, type Life, type LifeAt, type LifeBounds } from './life'
import {
  MaskDoc,
  PAL,
  colOf,
  nameOf,
  mkCanvas,
  bresenham,
  assetLabel,
  lookOf,
  migrateAnchor,
  ANCHOR_META_RESERVED,
  type StairRegion,
  type Stencil,
  STENCIL_KEEP,
  migratePath,
  migrateFraming,
  migrateAnchorSet,
  migrateRack,
  migrateVariantSet,
  migrateGroup,
  shotZoom,
  shotsOntoMeta,
  variantsOntoMeta,
  lookNameFrom,
  whenOf,
  anchorName,
  isAnchorName,
  isLookName,
  isPlacementName,
  polyBounds,
  simplifyPoly,
  anchorShape,
  ANCHOR_R_MIN,
  ANCHOR_R_MAX,
  MAP_CLASSES,
  type Occluder,
  type MapProps,
  clampStand,
  standReach,
  type Pt,
  type PlacedAsset,
  type MapEvent,
  type MapAnchor,
  type AnchorKind,
  type AnchorShape,
  type AssetLook,
  type MapPath,
  type MapFraming,
  type PathMark,
  type PathKind,
  type MapAnchorSet,
  type MapRack,
  type MapVariantSet,
  type MapGroup,
} from './mask'
import { Walker, canStand, checkReach, type WalkCfg, type ReachResult } from './walk'
/* the canvas is a surface a person reads, so it obeys the same law the panels
 * do: it prints the label and never the identifier. It was captioning
 * `the_maw_mouth` and `the_dock_walk` straight onto the painting. */
import { displayName } from './naming'
import { savedScene, saveDoc, loadDoc, saveScene, type LibItem } from '../api'

export type Tool =
  | 'region'
  | 'brush'
  | 'poly'
  | 'rect'
  | 'bucket'
  | 'eraser'
  | 'pick'
  | 'occ'
  | 'cut'
  | 'cuterase'
  | 'cutfill'
  | 'cutpoly'

export const isCutTool = (t: Tool) => t === 'cut' || t === 'cuterase' || t === 'cutfill' || t === 'cutpoly'

/* How many EXTRA pictures a placement can switch to, one per state, because a round is at most six states and none need to name look 0. life.ts and server/api.mjs work the same number out the same way; if that ceiling moves all three move together or a reopen drops the pictures the round points at. */
const LOOKS_MAX = 6

/* PERSONAL SPACE: the four numbers the push is made of, a verbatim copy of the same four on the reading side, because the preview has to work the answer out the way the game does or it is lying about the map. If one changes, copy it again; do not edit one side only. */

/* the smallest body anything gets, in painting pixels: a circle of no radius is nothing to push off. It is also the walker used by the reach test below, so the floor is one number in both places. */
const BODY_MIN = 2

/* how much of a body's DRAWN width its keep-out circle is. Half the width leaves a pair touching whenever a push cannot be delivered whole, so the circle is a fifth wider. Measured on the hub over 30000 frames, 17 walkers against 21 standers: at 0.5 the bodies overlapped on 34.36% of frames, at 0.6 on 8.59%, and 0.7 bought nothing while the worst single-frame shift went 14.79px to 17.27px. */
const BODY_R = 0.6

// the keep-out circle of something whose drawn art is w pixels across
function bodyRadius(w: number) {
  return Math.max(BODY_MIN, (w || 8) * BODY_R)
}

/* HOW WIDE A BODY IS: the ink, not the canvas it was saved on. PixelLab centres a character on a square sheet, and the proof bundle's harbour-walker is 144x144 holding 52px of ink, so reading the canvas gave a body 2.8 times its real width and a 5px figure wore a 15.12px keep-out circle. The columns holding any opaque pixel are the body, measured once per picture because reading pixels per frame is far too slow. */
function inkWidth(data: Uint8ClampedArray, w: number, h: number) {
  let x0 = w
  let x1 = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] === 0) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
    }
  // a picture with nothing in it at all keeps the canvas, which is what this
  // measured before and is never worse than answering zero
  return x1 >= x0 ? x1 - x0 + 1 : w
}

/* CAN A WALKER GET CLOSE ENOUGH TO TOUCH IT. The old test asked whether the thing's OWN FEET stand on walkable ground, which dropped five standing figures on the hub whose anchor sits a pixel or three off the mask (the gate guard 3.31px, an old fisherman 2.78px) and let walkers pass straight through them. The right question is whether any pixel a walker could stand on lies inside the thing's circle, measured in separate()'s own geometry because that is where the overlap will be measured. It keeps everything the feet test kept, and on the hub keeps 20 of 72 standing placements. A marginal keep is a marginal push by construction, which is what makes this safe to derive from the data. It answers for the placements the FLOOR fences; see freeReach below for the rest. */
function walkerCanReach(x: number, y: number, r: number, yScale: number, stands: (x: number, y: number) => boolean) {
  const ys = yScale || 1
  const reach = r + BODY_MIN
  const x0 = Math.ceil(x - reach)
  const x1 = Math.floor(x + reach)
  const y0 = Math.ceil(y - reach * ys)
  const y1 = Math.floor(y + reach * ys)
  for (let py = y0; py <= y1; py++)
    for (let px = x0; px <= x1; px++) {
      if (Math.hypot(px - x, (py - y) / ys) >= reach) continue
      if (stands(px, py)) return true
    }
  return false
}

/* AND WHAT A PLACEMENT THE FLOOR DOES NOT FENCE CAN GET TO. A crab told to wander the tideline is not walkOnly, so lifeAt hands it no floor and its only fence is its box: asking the floor about it answered about somebody else, and the two hub crabs walked through a hand cart, two barrels, a wrecked rowboat and a water wash, 8.90px into the wash. A free behaviour reaches anywhere its own box reaches. On the hub that adds five, and walker-on-stander went from 13972 pair-hits on 41.73% of frames to 3334 on 10.81%. */
function freeReach(x: number, y: number, r: number, yScale: number, b: LifeBounds | null | undefined) {
  // no box is no fence, so it can be anywhere and everything is reachable
  if (!b) return true
  const reach = r + BODY_MIN
  const ys = yScale || 1
  return x >= b.x - reach && x <= b.x + b.w + reach && y >= b.y - reach * ys && y <= b.y + b.h + reach * ys
}

/* WHAT OF A PUSH CAN ACTUALLY BE DELIVERED: whole vector first, then each axis, which is the rule the character already walks by. Dropping a push WHOLE when it would land somewhere unstandable fails worst exactly where overlaps are worst, on thin ground: on a narrow quay the shove out of a fishmonger lands in the water, so the figure does not move a pixel and stays fully inside. Measured over 30000 frames: partial delivery takes figure-frames shifted over 4px from 142 to 73.
 *
 * AND IT HOLDS BACK ONLY WHAT THE BEHAVIOUR ITSELF IS HELD BACK BY. A skiff drifting on water is free of the floor for every pixel it travels, so fencing it by the floor the instant it is pushed discards every correction it receives: three of them sat inside each other on 30000 of 30000 frames, 11.46px deep. Reading each row's own fence takes the worst walker-on-walker from 11.46px to 5.19px.
 *
 * It lives in the caller rather than inside separate(), because separate() is shared with the game by a hand copy and both sides have to run the identical rule. */
function floorPush(
  pts: { x: number; y: number }[],
  push: { dx: number; dy: number }[],
  stands: (x: number, y: number) => boolean,
  fenced: boolean[],
) {
  for (let i = 0; i < pts.length; i++) {
    const o = push[i]
    if (!o.dx && !o.dy) continue
    if (!fenced[i]) continue
    const p = pts[i]
    if (stands(p.x + o.dx, p.y + o.dy)) continue
    if (stands(p.x + o.dx, p.y)) {
      o.dy = 0
      continue
    }
    if (stands(p.x, p.y + o.dy)) {
      o.dx = 0
      continue
    }
    o.dx = 0
    o.dy = 0
  }
  return push
}

export interface EditorStatus {
  x: number
  y: number
  level: number
  occ: number
  cut: number
  zoom: number
  walking: boolean
  walkable: number
  pct: number
  cutPx: number
  cutTol: number
  cutPreview: boolean
  tool: Tool
  value: number
  brush: number
  occCount: number
  lastBaseline: number
  /* every occluder, so the panel can list them and an author can reach the
   * first one's baseline again after drawing a second */
  occs: { id: number; baseline: number }[]
  occSel: number
  // the outlines already drawn, newest first
  stencils: Stencil[]
  /* the six numbers describing the body this map is drawn for, and what the map
   * calls itself. Both ride the status so a panel can render them without
   * reaching into the document. */
  walk: WalkCfg
  props: MapProps
  note: string
  noteSeq: number
  busy: string
  hasPainting: boolean
  sceneId: string
  w: number
  h: number
  regions: number
  assets: PlacedAsset[]
  assetSel: string
  assetSelAll: string[]
  lifePlay: boolean
  /* whether the placements are being drawn as a faint reference on a step that cannot edit them */
  assetGhost: boolean
  placing: string
  hiddenGroups: string[]
  proposedGroups: string[]
  events: MapEvent[]
  /* IS THE ANCHOR OVERLAY DRAWN, and which anchor is the loud one. Both ride the status because the overlay is on every step and its switch belongs to the author, so a panel has to show the state of something no step change decides. */
  eventsVisible: boolean
  anchorSel: number
  /* the area being drawn right now, as the count of points sampled, -1 when none is open and 0 while armed and unpressed. The gesture lives outside React so the line follows the hand without a render per sample. The anchor it belongs to comes with it, or opening a second anchor mid-draw lights the wrong mode on the wrong form. */
  polyDraw: number
  polyDrawId: number
  /* ROUTES AND SHOTS ride the status the way anchors do, so the panel can list them without reaching into the document. pathDraw is the live gesture's waypoint count, -1 when no line is open, which is how a button knows to say finish instead of draw. */
  paths: MapPath[]
  pathSel: number
  pathDraw: number
  /* the legs of the SELECTED route that cross ground no body can stand on, and how many legs it has. Only the selected one, because that is the one the panel has room to say it about. Empty for a sail line and for a camera. */
  pathBad: number[]
  pathLegs: number
  framings: MapFraming[]
  framingSel: number
  /* THE NAMED COLLECTIONS, and the missing names in the selected one. setGaps and rackGaps are the whole reason a set is worth authoring rather than typing five strings into python: MAPVIS can be asked whether the set is complete. anchorSetSel is spelt the long way because setSel already means selecting several PLACEMENTS. */
  sets: MapAnchorSet[]
  anchorSetSel: number
  setGaps: string[]
  racks: MapRack[]
  rackSel: number
  rackGaps: string[]
  /* THE NAMED EXCLUSIVE VARIANT SETS and the rows about a placement group. variantGaps is setGaps again: the members of the selected set naming a placement this map does not have. */
  variants: MapVariantSet[]
  variantSel: number
  variantGaps: string[]
  groups: MapGroup[]
  // the crop gesture: on while a rectangle is being dragged over a placement
  cropping: boolean
  cropKind: '' | 'crop' | 'area'
  // what the clipboard holds, so paste can say what it will drop
  clip: string
}

// which fields of a placement a typed edit may set. One call is one undo step.
export interface AssetPatch {
  x?: number
  y?: number
  sx?: number
  sy?: number
  rot?: number
  fx?: boolean
  fy?: boolean
  group?: string
}

/* The clipboard lives at module scope on purpose: a copy has to survive
 * switching scenes inside one session, so it can not hang off an Editor
 * instance or off the document that gets replaced with the painting. */
let clipboard: PlacedAsset[] = []

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

// Which group a fresh placement lands in, from the library item's own name. The four suggested groups exist even when empty and anything unrecognised is a prop. Exported so generate-here files its result the way a click would.
export const groupFor = (name: string): string => {
  const n = name.toLowerCase()
  if (/palm|tree|banyan|bush|fern|banana|tuft|grass|kapok|broadleaf|sapling|plant|flower/.test(n)) return 'trees'
  if (/person|people|villager|npc|sailor|fisher|guard|kid|man|woman/.test(n)) return 'people'
  if (/smoke|steam/.test(n)) return 'smoke'
  return 'props'
}

// A manual placement's starting scale. Large art (a reopened bundle can
// carry some) starts at quarter size; a generated 96px asset starts at 0.4
// so it does not vanish. [ and ] take it from there.
const defaultScale = (it: LibItem): number => (it.h >= 120 ? 0.25 : 0.4)

/* THE OVERLAY COLOURS FOR ROUTES AND SHOTS, their own two: the chrome already spends iris on anchors, green on the spawn, yellow on the mask polygon, purple on occluders and magenta on the cut, so a route in any of those reads as one of those. */
const PATH_COL = '#f0883e'
const PATH_SEL = '#ffc27a'
const SHOT_COL = '#5cc8e0'
const SHOT_SEL = '#a9e6f5'
/* a leg of a walk route over ground nothing can stand on. The same red check reach paints stranded ground with, because it is the same sentence about a different mark and an author should not learn a second colour for "the floor is not there". */
const PATH_BAD = '#ff2828'

/* HOW CLOSE COUNTS AS GRABBING SOMETHING, both here because the anchor radius ceiling went from 64 to 512. ANCHOR_GRAB caps the drag target at the dot, or a region authored at 400 eats every click within 400 pixels, which on a 688px map is the map. HANDLE_GRAB is small because corners of one shape sit close together and grabbing the wrong one silently reshapes the area. */
const ANCHOR_GRAB = 20
const HANDLE_GRAB = 3

/* THE TWO CHROME SURFACES THIS FILE DRAWS, written out because a 2d context cannot read a custom property, and named for the token they mirror so a token that moves can be followed. PLATE was five different strings for one job, the dark card a caption sits on. */
const PLATE = 'rgba(16,20,26,0.9)' // --panel at nine tenths
const BOARD = '#0e1319' // --board
/* AN ANCHOR'S INK IS NOT WRITTEN HERE. It was one pale iris for all six kinds while the ocean chart had a colour per kind, so a door was lavender in the tool that made it and orange on the page that places it. Both read src/core/ink.ts now. */
/* THE FLOOR SPOT AND THE HEADING OFF IT, deliberately ONE colour and not the kind ink: a zone is per kind because it answers which of six things this is, but where a body's feet end is the same question on all six, and colouring it per kind would say there are six kinds of standing. */
const STAND_INK = '#6fd08c'

/* WHAT EVERY MARK ON THE ANCHOR OVERLAY IS CASED IN, and the reason the overlay can be on over a finished painting at all. Measured on the hub at 3x: a one-pixel dashed outline in a mid-tone hue over pixel art of that tone is not faint, it is gone. A darker stroke underneath separates the mark from whatever it lies on, the same job the caption plate does for text. */
const CASE_INK = 'rgba(14,19,25,0.66)'

/* THE EIGHT HEADINGS AS DIRECTIONS ON THE PAINTING, for drawing the facing
 * arrow. dirFrom in walk.ts turns a direction into one of these words; this is
 * the trip back, and it is only ever used to draw. */
const FACE_VEC: Record<string, [number, number]> = {
  north: [0, -1],
  'north-east': [0.7071, -0.7071],
  east: [1, 0],
  'south-east': [0.7071, 0.7071],
  south: [0, 1],
  'south-west': [-0.7071, 0.7071],
  west: [-1, 0],
  'north-west': [-0.7071, -0.7071],
}

/* A ROUTE AS THE PAIRS OF POINTS IT IS WALKED IN, so the checker and the overlay count legs the same way. A closed route has one more leg than an open one, the run back to the first point, and forgetting it is how a patrol would be declared clean while its closing leg went through a wall. */
/* WHERE THE PAINT IS ON A COMPOSITED CANVAS, the browser half of the measurement publish.mjs makes, and it has to answer the same numbers or the disk export and the platform export describe two different islands. Alpha 8 rather than 128, because the cut writes a hard zero and generated art has soft edges, so a high threshold eats a coastline. Nothing opaque answers with the whole raster. */
function paintedBoxOf(c: HTMLCanvasElement): { w: number; h: number; ox: number; oy: number } {
  const g = c.getContext('2d') as CanvasRenderingContext2D
  const d = g.getImageData(0, 0, c.width, c.height).data
  let x0 = c.width
  let y0 = c.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      if (d[(y * c.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
      }
  if (x1 < 0) return { w: c.width, h: c.height, ox: 0, oy: 0 }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, ox: x0, oy: y0 }
}

function legsOf(p: MapPath): [Pt, Pt][] {
  const out: [Pt, Pt][] = []
  for (let i = 0; i + 1 < p.points.length; i++) out.push([p.points[i], p.points[i + 1]])
  if (p.closed && p.points.length > 2) out.push([p.points[p.points.length - 1], p.points[0]])
  return out
}

/* WHICH PLACEMENTS BELONG TO A LIBRARY ITEM. Two plain functions, at module
 * level and exported, because this rule has now broken animation twice and a
 * rule that can only be exercised by opening a map with a canvas in front of it
 * is a rule nobody checks. They take shapes rather than the real types so the
 * pair can be lifted out and run on their own.
 *
 * The hard case is a still that has become an animation. It is the same thing
 * under the same name, but it has moved from `library/palm.png` to
 * `library/palm/0.png`, so a url match alone misses every placement of it. They
 * then keep pointing at a png that is deleted moments later: nothing is drawn,
 * and a reload does not help because the dead url is what was saved. */
/* WHERE A PLACEMENT SITS IN THE DRAW ORDER. Every surface that draws a map has to answer this
 * the same way: the editor, the three previews on the site, and the game. It is y plus the
 * author's nudge, so with no nudge it is exactly the y-sort every published map already has.
 */
/* DO TWO DRAWN BOXES SHARE ANY PIXELS. Touching edges do not count: two barrels standing flush
 * are not covering each other and reordering them changes nothing anybody can see. */
export function boxesOverlap(
  a: { x0: number; x1: number; y0: number; y1: number },
  b: { x0: number; x1: number; y0: number; y1: number },
): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
}

/* HOW FAR THE NUDGE HAS TO MOVE to clear everything the selection covers, or nothing when it is
 * already clear. Out here because the arithmetic is the whole feature and the rest of order() is
 * reading boxes off a canvas: the one part worth being sure about should not need a browser.
 *
 * The step lands one past the far end of what it overlaps, so a single press clears the thing in
 * the way rather than a fraction of it, and the already-clear case returns null rather than 0,
 * because a press that keeps adding to a bias that is doing nothing is how a placement ends up
 * sorting a thousand deep for no reason. */
export function orderDelta(dir: 'front' | 'back', mine: number[], theirs: number[]): number | null {
  if (!mine.length || !theirs.length) return null
  if (dir === 'front') {
    const top = Math.max(...theirs)
    const from = Math.max(...mine)
    return from > top ? null : top + 1 - from
  }
  const low = Math.min(...theirs)
  const from = Math.min(...mine)
  return from < low ? null : low - 1 - from
}

export function assetDepth(a: { y: number; z?: number }): number {
  const z = Number(a.z)
  return a.y + (Number.isFinite(z) ? z : 0)
}

export function itemMatch(item: { kind: string; src?: string; frames?: string[] }): {
  key: string
  wasStill: string
  wasFolder: string
} {
  const first = item.frames && item.frames[0]
  const key = item.kind === 'animated' ? (first ? first.slice(0, first.lastIndexOf('/') + 1) : '') : item.src || ''
  // the folder and the still it replaced differ by one slash, so it is derived
  // rather than guessed at or passed in beside it
  const wasStill = item.kind === 'animated' && key ? key.slice(0, -1) + '.png' : ''
  /* AND THE SAME DERIVATION THE OTHER WAY ROUND, because animating is reversible now: taking
   * the animation off a thing leaves a still where a folder of frames was, and every placement
   * of it is holding frame urls under a folder that has just been deleted. Without this the
   * match found none of them, so they kept those urls, drew nothing, and survived a reload,
   * which is the same three symptoms animating a still used to have. A trailing slash is what
   * keeps `palm` off `palm-trimmed`. */
  const wasFolder = item.kind !== 'animated' && key.slice(-4).toLowerCase() === '.png' ? key.slice(0, -4) + '/' : ''
  return { key, wasStill, wasFolder }
}

export function placementIsOf(
  a: { kind: string; src?: string; frames?: string[] },
  m: { key: string; wasStill: string; wasFolder: string },
): boolean {
  if (!m.key) return false
  if (a.kind === 'animated') {
    const f = a.frames && a.frames[0]
    if (!f) return false
    return f.startsWith(m.key) || (!!m.wasFolder && f.startsWith(m.wasFolder))
  }
  return a.src === m.key || (!!m.wasStill && a.src === m.wasStill)
}

export class Editor {
  doc = new MaskDoc(1, 1)
  /* THE BODY THIS MAP IS DRAWN FOR, read off the document rather than held here. A default held on the editor and never assigned again describes every map as an 18px character at 34 px/s over ground squashed 0.72, island and room alike. It belongs to the map, so it rides the save, the undo and the reopen. */
  get cfg(): WalkCfg {
    return this.doc.walk
  }
  walker = new Walker([0, 0])
  tool: Tool = 'brush'
  value = 40
  brush = 2
  opacity = 0.55
  showMask = true
  showOcc = true
  showHits = false
  grid = false
  walking = false
  cutTol = 40
  showCutPreview = false
  sceneId = 'untitled'
  note = ''
  noteSeq = 0
  busy = ''
  // the precomputed colour regions for the accept-propose flow: one label per
  // pixel, -1 where the painting is transparent, computed off-thread by the app
  regionLabels: Int32Array | null = null
  regionCount = 0
  private hoverRegion = -1
  private regionHL: HTMLCanvasElement | null = null
  // ---- the assets step: life placed ON the painting -----------------------
  // assetMode is owned by the workflow (step 5 turns it on); while it is on,
  // the pointer places, selects and drags placements instead of painting mask
  assetMode = false
  /* THE ART AS A REFERENCE ONLY, for painting levels underneath it. What is walkable is decided by
   * where the things on the map stand, and the levels step draws the bare painting, so the author was
   * holding the furniture in their head while tracing the floor around it. This draws the placements
   * faintly and changes nothing else: the pointer still belongs to the mask, because every path that
   * picks, drags or places a placement is gated on assetMode and this is not that. */
  assetGhost = false
  placing: LibItem | null = null
  /* Selection is a SET with an anchor. selAsset is the anchor: the one the inspector shows numbers for. It stays a plain property so every path that sets it keeps working, and the setter collapses the set to that one id. Everything acting on "the selection" reads selIds(), so one thing and forty go down the same road. */
  private _selAsset = ''
  private selSet = new Set<string>()
  get selAsset(): string {
    return this._selAsset
  }
  set selAsset(v: string) {
    this._selAsset = v
    this.selSet.clear()
    if (v) this.selSet.add(v)
  }
  /* every picked placement, anchor first, skipping any that died under an undo */
  selIds(): string[] {
    const live = (id: string) => this.doc.assets.some((a) => a.id === id)
    const out: string[] = []
    if (this._selAsset && live(this._selAsset)) out.push(this._selAsset)
    for (const id of this.selSet) if (id !== this._selAsset && live(id)) out.push(id)
    return out
  }
  selCount(): number {
    return this.selIds().length
  }
  /* the picked placements themselves, in the order they are drawn, so an align
   * or a distribute walks them the way the eye does */
  private selAssets(): PlacedAsset[] {
    const s = new Set(this.selIds())
    return this.doc.assets.filter((a) => s.has(a.id) && !this.hiddenGroups.has(a.group))
  }
  setSel(ids: string[]) {
    const seen = new Set(ids.filter(Boolean))
    this._selAsset = ids.find((i) => seen.has(i)) || ''
    this.selSet = seen
    this.dirty = true
    this.emit()
  }
  /* the behaviour preview: on by default so a placement that moves is seen
   * moving, and a clock that can be restarted so a fresh behaviour is judged
   * from its beginning rather than from wherever the page happened to be */
  lifePlay = true
  lifeT0 = performance.now() / 1000
  /* the preview clock, stopped, while an editing gesture has hold of something
   * that moves. Null the rest of the time. lifeNow says why. */
  private lifeHold: number | null = null
  /* Where every moving placement's PICTURE is this frame, keyed by id. A behaviour draws a placement at its anchor plus however far it has walked, so the anchor is not where the picture is. The draw works the offset out once a frame and the picker, handles and outline all read it, so a click lands on the sprite on screen. Asking lifeAt again from the picker would answer for a different instant. */
  private liveAt = new Map<string, LifeAt>()
  // the clock those offsets were worked out at, and -1 until the first frame
  // has drawn. A hold stops on THIS reading rather than on the wall clock, so
  // the offsets the gesture carries on with are the ones it grabbed.
  private liveT = -1
  hiddenGroups = new Set<string>()
  // groups the sparkle run landed that no one has accepted yet: they render
  // ghosted until the check keeps them or the x removes them
  proposedGroups = new Set<string>()
  private assetCache = new Map<string, { img: HTMLImageElement; ok: boolean; failed: boolean }>()
  // urls whose pixels were rewritten under the same name (an effect saved over
  // itself): the key stays the clean url so exports never see a query string,
  // and only the img request carries the tag that gets past the browser cache
  private bustTag = new Map<string, number>()
  // the crop gesture: which placement, the rectangle being dragged in painting
  // coordinates, and who to hand the source-pixel rect to
  private cropSt: {
    id: string
    a: Pt | null
    b: Pt | null
    dragging: boolean
    /* WHICH PART OF THE BOX THE POINTER TOOK, and what makes a crop a crop rather than a second selection. '' is what an AREA still does, dragging a fresh rectangle out of nothing; a sprite crop opens with the box round the whole picture and every drag after is one edge of THAT box moving. 'move' slides the window without resizing it. */
    grip: '' | 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'se' | 'sw'
    // where the box and the pointer were when the grip was taken, so a drag is
    // measured as a delta rather than snapping the edge to the cursor
    from: { x0: number; y0: number; x1: number; y1: number; px: number; py: number } | null
    cb: (r: { x: number; y: number; w: number; h: number } | null) => void
  } | null = null
  // the panel hands this over so a double click on a placement can open the
  // crop box itself, the way a slide editor does
  cropReq: (() => void) | null = null
  // ctrl+p and ctrl+t: the panel owns the pixels, so the editor only says
  // which placements were picked when the keys were pressed
  bitifyReq: ((ids: string[]) => void) | null = null
  trimReq: ((ids: string[]) => void) | null = null
  /* the rubber band: dragged from empty painting, it picks up everything it
   * touches. base is what was already selected when the drag began, so holding
   * shift adds a second sweep to a first one instead of replacing it. */
  private bandSt: { a: Pt; b: Pt; base: string[]; add: boolean } | null = null
  // one live gesture on the selected placement: moving, scaling from a corner, stretching one axis from an edge, or rotating from the floating handle. The snapshot lands on the first real move, so a bare click never pushes an identical state onto the undo stack.
  private dragAsset: {
    id: string
    mode: 'move' | 'scale' | 'stretchx' | 'stretchy' | 'rotate'
    moved: boolean
    dx: number // move: grab offset to the anchor
    dy: number
    sx0: number // scales at gesture start
    sy0: number
    d0: number // scale: pointer distance to the anchor at start
    u0: number // stretch: pointer's |axis| distance at start
    rot0: number // rotate: rotation at start
    a0: number // rotate: pointer angle at start
    edge: 'top' | 'bottom' | 'left' | 'right'
    // every picked placement's position at gesture start, so a move carries
    // the whole set and a group scale/rotate has something to work from
    many?: { id: string; x: number; y: number; sx?: number; sy?: number; rot?: number }[]
    // the group's own frame for a many-scale: the box centre and its size
    box?: { cx: number; cy: number; w: number; h: number }
  } | null = null
  // arrow-key nudges coalesce into one undo step per burst
  private nudgeId = ''
  private nudgeAt = 0
  // the painting as it was loaded, before any boundary growth: growth always
  // recomposites from this, so no pixel is ever resampled twice
  private basePainting: HTMLImageElement | HTMLCanvasElement | null = null

  private canvas: HTMLCanvasElement | null = null
  private g: CanvasRenderingContext2D | null = null
  private painting: HTMLImageElement | HTMLCanvasElement | null = null
  /* WHERE THE PICTURE ACTUALLY IS inside the document, in painting pixels.
   * Worked out once per painting and kept, because a full alpha scan of 688x640
   * is not something to do sixty times a second. null means not scanned yet. */
  private paintBox: { x0: number; y0: number; x1: number; y1: number } | null = null
  private z = 3
  private ox = 0
  private oy = 0
  private dpr = 1
  private cursor: Pt | null = null
  private poly: Pt[] = []
  private dragRect: [number, number, number, number] | null = null
  private drawing = false
  private erasing = false
  private lastPx: Pt | null = null
  private panning: { sx: number; sy: number; ox: number; oy: number } | null = null
  private keys: Record<string, boolean> = {}
  private natMask: HTMLCanvasElement | null = null
  private natOcc: HTMLCanvasElement | null = null
  private natCut: HTMLCanvasElement | null = null
  private natHits: HTMLCanvasElement | null = null
  private pix: Uint8ClampedArray | null = null
  private cutApplied: HTMLCanvasElement | null = null
  /* which occluder the baseline field is about. 0 means whichever was drawn
   * last, which is the right answer the moment after you draw one and the wrong
   * one from then on, which is the whole bug. */
  private occSel = 0
  private plates: { cv: HTMLCanvasElement; baseline: number }[] | null = null
  private dirtyMask = true
  private dirty = true
  private raf = 0
  private last = 0
  private saveT = 0
  private changed = false
  // loadPainting replaces this.doc and then awaits a restore. Without this the
  // autosave beat can fire inside that gap and write the empty replacement over
  // a good save, which is a way to lose a map by opening another one.
  private loading = false
  // set once a disk save has failed, so the failure is said once and not every
  // four seconds forever
  private diskWarned = false
  private listener: ((s: EditorStatus) => void) | null = null
  private detachers: (() => void)[] = []

  // ---- lifecycle --------------------------------------------------------
  attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.g = canvas.getContext('2d')
    this.dpr = clamp(window.devicePixelRatio || 1, 1, 3)
    const ro = new ResizeObserver(() => this.resize())
    ro.observe(canvas.parentElement || canvas)
    this.detachers.push(() => ro.disconnect())

    const on = <K extends keyof HTMLElementEventMap>(
      t: HTMLElement | Window,
      k: K,
      f: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      t.addEventListener(k, f as EventListener, opts)
      this.detachers.push(() => t.removeEventListener(k, f as EventListener, opts))
    }
    on(canvas, 'pointerdown', (e) => this.onDown(e as PointerEvent))
    on(canvas, 'pointermove', (e) => this.onMove(e as PointerEvent))
    on(canvas, 'pointerup', (e) => this.onUp(e as PointerEvent))
    on(canvas, 'pointerleave', () => {
      this.cursor = null
      this.dirty = true
    })
    // double click means "work on this one": on a placed asset it opens the
    // crop box the way a slide editor does, everywhere else it closes a polygon
    on(canvas, 'dblclick', (e) => {
      /* a double click keeps the route, and the second press of it has already
       * dropped a waypoint on top of the first, so that one comes back off */
      if (this.newPath) {
        e.preventDefault()
        const n = this.newPath.length
        if (n > 1) {
          const a = this.newPath[n - 1]
          const b = this.newPath[n - 2]
          if (a[0] === b[0] && a[1] === b[1]) this.newPath.pop()
        }
        this.finishPath()
        return
      }
      if (this.assetMode && !this.cropSt && this.selAsset && this.cropReq) {
        e.preventDefault()
        this.cropReq()
        return
      }
      this.closePoly()
    })
    on(canvas, 'contextmenu', (e) => e.preventDefault())
    on(canvas, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false })
    // a handle on the live editor while running from vite, so a gesture can be
    // checked from the console instead of guessed at. Never in a build: vite
    // rewrites this to false and the line is dropped.
    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)
      (window as unknown as { __ed: unknown }).__ed = this
    on(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true))
    on(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false))
    on(window, 'blur', () => {
      this.keys = {}
    })

    // the scripting surface, the way tools/maskdraw exposed window.__md: the
    // console can drive every command the buttons drive
    ;(globalThis as unknown as { mapvis: Editor }).mapvis = this

    this.resize()
    this.last = performance.now()
    // scheduled first, so one bad frame cannot stop the tool dead
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop)
      this.frame(now)
    }
    this.raf = requestAnimationFrame(loop)
  }

  detach() {
    cancelAnimationFrame(this.raf)
    for (const d of this.detachers) d()
    this.detachers = []
  }

  onStatus(cb: (s: EditorStatus) => void) {
    this.listener = cb
  }

  status(): EditorStatus {
    const s = this.doc.stats()
    const c = this.cursor
    const lastOcc = this.selectedOcc()
    const selPath = this.pathSel ? this.doc.paths.find((p) => p.id === this.pathSel) : undefined
    const selSet = this.anchorSetSel ? this.doc.sets.find((s) => s.id === this.anchorSetSel) : undefined
    const selRack = this.rackSel ? this.doc.racks.find((r) => r.id === this.rackSel) : undefined
    return {
      x: c ? c[0] : -1,
      y: c ? c[1] : -1,
      level: c ? this.doc.lvlAt(c[0], c[1]) : -1,
      occ: c ? this.doc.occAt(c[0], c[1]) : 0,
      cut: c ? this.doc.cutAt(c[0], c[1]) : 0,
      zoom: this.z,
      walking: this.walking,
      walkable: s.walkable,
      pct: s.pct,
      cutPx: s.cut,
      cutTol: this.cutTol,
      cutPreview: this.showCutPreview,
      tool: this.tool,
      value: this.value,
      brush: this.brush,
      occCount: this.doc.occs.length,
      lastBaseline: lastOcc ? lastOcc.baseline : 0,
      occs: this.doc.occs.map((o) => ({ id: o.id, baseline: o.baseline })),
      occSel: lastOcc ? lastOcc.id : 0,
      stencils: this.doc.stencils,
      walk: { ...this.doc.walk },
      props: { ...this.doc.props },
      note: this.note,
      noteSeq: this.noteSeq,
      busy: this.busy,
      hasPainting: !!this.painting,
      sceneId: this.sceneId,
      w: this.doc.W,
      h: this.doc.H,
      regions: this.regionCount,
      assets: this.doc.assets,
      assetSel: this.selAsset,
      // every picked id, so the panel can show the many-at-once row and know
      // when the single-asset inspector is the wrong thing to put on screen
      assetSelAll: this.selIds(),
      placing: this.placing ? this.placing.name : '',
      hiddenGroups: [...this.hiddenGroups],
      proposedGroups: [...this.proposedGroups],
      events: this.doc.events,
      eventsVisible: this.eventsVisible,
      anchorSel: this.anchorSel,
      polyDraw: this.newPoly ? this.newPoly.pts.length : -1,
      polyDrawId: this.newPoly ? this.newPoly.id : 0,
      paths: this.doc.paths,
      pathSel: this.pathSel,
      pathDraw: this.newPath ? this.newPath.length : -1,
      pathBad: selPath ? this.crossings(selPath) : [],
      pathLegs: selPath ? legsOf(selPath).length : 0,
      framings: this.doc.framings,
      framingSel: this.framingSel,
      sets: this.doc.sets,
      anchorSetSel: this.anchorSetSel,
      setGaps: selSet ? this.missingIn(selSet.members) : [],
      racks: this.doc.racks,
      rackSel: this.rackSel,
      rackGaps: selRack ? this.missingIn(selRack.slots.map((s) => s.anchor)) : [],
      variants: this.doc.variants,
      variantSel: this.variantSel,
      variantGaps: this.variantSel ? this.variantGaps(this.variantSel) : [],
      groups: this.doc.groups,
      cropping: !!this.cropSt,
      // which of the two it is, so the hint on screen can say the right thing.
      // They are one state and two gestures: a crop takes an existing box in,
      // an area is dragged out of nothing.
      cropKind: this.cropSt ? (this.cropSt.id ? 'crop' : 'area') : '',
      lifePlay: this.lifePlay,
      assetGhost: this.assetGhost,
      clip: clipboard.length ? (clipboard.length > 1 ? `${clipboard.length} items` : assetLabel(clipboard[0])) : '',
    }
  }
  private emit() {
    if (this.listener) this.listener(this.status())
  }
  say(note: string) {
    this.note = note
    this.noteSeq++
    this.emit()
  }
  setBusy(b: string) {
    this.busy = b
    this.emit()
  }

  // ---- the painting -----------------------------------------------------
  async loadPainting(src: string, id: string) {
    const img = await loadImage(src)
    this.painting = img
    this.basePainting = img
    this.sceneId = id
    this.doc = new MaskDoc(img.naturalWidth, img.naturalHeight)
    // the replacement is empty and the restore below is async, so the autosave
    // beat has to be held off until this doc is the real one
    this.loading = true
    this.changed = false
    this.diskWarned = false
    this.walker = new Walker(this.doc.spawn)
    this.natMask = mkCanvas(this.doc.W, this.doc.H)
    this.natOcc = mkCanvas(this.doc.W, this.doc.H)
    this.natCut = mkCanvas(this.doc.W, this.doc.H)
    this.natHits = mkCanvas(this.doc.W, this.doc.H)
    this.plates = null
    this.cutApplied = null
    this.paintBox = null
    this.regionLabels = null
    this.regionCount = 0
    this.hoverRegion = -1
    this.regionHL = null
    this.placing = null
    this.selAsset = ''
    this.dragAsset = null
    this.nudgeId = ''
    // a half-drawn route or area belongs to the map it was being drawn on, and
    // so do both selections: carrying an id into another document points at
    // whatever happens to hold that number over there
    this.newPath = null
    this.newPoly = null
    this.pathSel = 0
    this.framingSel = 0
    this.anchorSel = 0
    this.anchorSetSel = 0
    this.rackSel = 0
    this.variantSel = 0
    this.cancelPick()
    this.cancelCrop()
    this.hiddenGroups.clear()
    this.proposedGroups.clear()
    // the painting's own pixels, read once: the cut flood matches against these
    {
      const c = mkCanvas(this.doc.W, this.doc.H)
      const g = c.getContext('2d') as CanvasRenderingContext2D
      g.drawImage(img, 0, 0)
      this.pix = g.getImageData(0, 0, this.doc.W, this.doc.H).data
    }
    // restoreDoc weighs this browser against the platform and takes the newer one; an exported bundle is the last resort. Trying the browser first unconditionally meant a map in a database was never actually read from it.
    try {
      if (!(await this.restoreDoc())) await this.restoreFromDisk()
    } finally {
      this.loading = false
    }
    /* AND THE PAINTING ITSELF HAS TO REACH THE STORE. `saveScene` had exactly one
     * caller, `pick()`, which runs only when a candidate generated inside MAPVIS is
     * chosen. A dropped file and a `?img=` open both land here and neither uploaded
     * anything, so a map's painting lived in one browser tab while its cut and its
     * levels autosaved to postgres every four seconds. The dashboard then said "no
     * painting yet" and reopening by id found nothing, on a map whose work was
     * perfectly safe. `?img=` is the opening MAPS.md documents, so the documented
     * road was the one that lost the picture. */
    void this.keepPainting()
    this.fit()
    this.dirtyMask = true
    this.dirty = true
    this.emit()
  }

  /* Put this painting in the store when the store has none. It can only ever FILL a
   * gap: a map that already has one is left alone, so reopening an id with a
   * different picture cannot overwrite what is there. That is why the HEAD comes
   * first instead of writing unconditionally. */
  private async keepPainting() {
    const id = this.sceneId
    if (!id) return
    try {
      const r = await fetch(`/work/${encodeURIComponent(id)}/scene.png`, { method: 'HEAD' })
      if (r.ok) return
    } catch {
      /* no answer means no copy, and the write below is the thing that fixes it */
    }
    const url = this.paintingDataURL()
    if (!url) return
    try {
      await saveScene(id, url)
    } catch (e) {
      /* said out loud, once, because a painting that never reached the store is the
       * difference between a map that reopens and one that looks empty */
      this.say('painting not saved: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  paintingDataURL(): string | null {
    if (!this.painting) return null
    const c = mkCanvas(this.doc.W, this.doc.H)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.drawImage(this.painting, 0, 0)
    return c.toDataURL('image/png')
  }

  /* THE NOTCH THE WHOLE PAINTING FITS AT, lifted out of fit() so a saved shot can be expressed against it: neither side knows the other's window, but both know what "the whole map on screen" means. */
  fitNotch(): number {
    if (!this.canvas || !this.painting) return 0
    const z = clamp(Math.floor(Math.min(this.canvas.clientWidth / this.doc.W, this.canvas.clientHeight / this.doc.H)), 1, 8)
    return z || 1
  }

  fit() {
    if (!this.canvas || !this.painting) return
    const cw = this.canvas.clientWidth
    const ch = this.canvas.clientHeight
    const z = this.fitNotch()
    this.z = z || 1
    this.ox = Math.round((cw - this.doc.W * this.z) / 2)
    this.oy = Math.round((ch - this.doc.H * this.z) / 2)
    this.dirty = true
  }

  setZoom(z: number, cx?: number, cy?: number) {
    if (!this.canvas) return
    const nz = clamp(Math.round(z), 1, 8)
    const px = cx == null ? this.canvas.clientWidth / 2 : cx
    const py = cy == null ? this.canvas.clientHeight / 2 : cy
    const nx = (px - this.ox) / this.z
    const ny = (py - this.oy) / this.z
    this.z = nz
    this.ox = Math.round(px - nx * nz)
    this.oy = Math.round(py - ny * nz)
    this.dirty = true
    this.emit()
  }

  private resize() {
    const c = this.canvas
    if (!c || !this.g) return
    const w = c.clientWidth
    const h = c.clientHeight
    c.width = Math.max(1, Math.round(w * this.dpr))
    c.height = Math.max(1, Math.round(h * this.dpr))
    this.g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.g.imageSmoothingEnabled = false
    this.dirty = true
  }

  // ---- input ------------------------------------------------------------
  private toNative(e: PointerEvent | WheelEvent): Pt {
    const r = (this.canvas as HTMLCanvasElement).getBoundingClientRect()
    return [
      Math.floor((e.clientX - r.left - this.ox) / this.z),
      Math.floor((e.clientY - r.top - this.oy) / this.z),
    ]
  }
  // the unfloored native point, for transform gestures where a whole pixel of
  // slack would make a rotation handle stutter
  private toNativeF(e: PointerEvent): Pt {
    const r = (this.canvas as HTMLCanvasElement).getBoundingClientRect()
    return [(e.clientX - r.left - this.ox) / this.z, (e.clientY - r.top - this.oy) / this.z]
  }

  // a synthesised pointer has no id the browser will capture, and scripts use
  // synthesised pointers
  private capture(e: PointerEvent) {
    try {
      ;(this.canvas as HTMLCanvasElement).setPointerCapture(e.pointerId)
    } catch {
      /* scripted pointer */
    }
  }

  private onDown(e: PointerEvent) {
    if (!this.painting) return
    const r = (this.canvas as HTMLCanvasElement).getBoundingClientRect()
    if (e.button === 1 || e.altKey) {
      this.panning = { sx: e.clientX, sy: e.clientY, ox: this.ox, oy: this.oy }
      this.capture(e)
      e.preventDefault()
      return
    }
    // the generate-here pick eats the click before any tool sees it
    if (this.pickCb) {
      if (e.button === 2) this.cancelPick()
      else this.pickCb(this.toNative(e))
      return
    }
    if (this.walking) return
    const [x, y] = this.toNative(e)
    this.lastPx = [x, y]
    void r

    /* A ROUTE BEING LAID EATS THE CLICK, ahead of everything including the anchor drag: a waypoint dropped near a door must not grab the door. It sits above the paintable gate because routes are drawn on the test step where painting is off. */
    if (this.newPath) {
      if (e.button === 2) this.cancelPath()
      else {
        this.newPath.push([x, y])
        this.dirty = true
        this.emit()
      }
      e.preventDefault()
      return
    }

    /* AN AREA BEING DRAWN eats the press for the same reason: a drag that starts near an anchor must not grab the anchor. The press starts a fresh path every time, so an author who dislikes what they let go of draws again over the top, and nothing is written to the anchor until enter. */
    if (this.newPoly) {
      if (e.button === 2) this.cancelRegionDraw()
      else {
        this.newPoly.pts = [[x, y]]
        this.newPoly.drawing = true
        this.capture(e)
        this.dirty = true
        this.emit()
      }
      e.preventDefault()
      return
    }

    /* A CORNER OF A DRAWN AREA, tested BEFORE the anchor under it: a region big enough to be a plaza has a ring covering its own corners, so grabbing the anchor first would make every handle unreachable. EDITABLE, not merely visible, or a corner handle would take the press meant for the art under it. */
    /* THE RING'S HANDLE, tested before the poly corners and the anchor dot: while the offset is zero the handle sits exactly on the dot, so testing the dot first would make it unreachable on every ring never moved. Selected anchors only, so it cannot take a press meant for the art. */
    if (e.button === 0 && this.anchorSel) {
      const ev = this.doc.events.find((v) => v.id === this.anchorSel)
      if (ev && this.anchorLive(ev) && anchorShape(ev) === 'circle') {
        const home = ev.placement ? this.placementRef(ev.placement) : undefined
        const spot = home ? this.lifeSpot(home) : { x: ev.x, y: ev.y }
        const [rx, ry] = ev.ring ?? [0, 0]
        const hx = spot.x + rx
        const hy = spot.y + ry
        if (Math.abs(hx - x) <= HANDLE_GRAB + 2 && Math.abs(hy - y) <= HANDLE_GRAB + 2) {
          this.doc.snap()
          this.dragRing = { id: ev.id, dx: hx - x, dy: hy - y }
          this.capture(e)
          e.preventDefault()
          return
        }
      }
    }

    if (e.button === 0) {
      for (const ev of [...this.doc.events].reverse()) {
        if (!ev.poly || !this.anchorLive(ev)) continue
        const i = ev.poly.findIndex(([px, py]) => Math.abs(px - x) <= HANDLE_GRAB && Math.abs(py - y) <= HANDLE_GRAB)
        if (i < 0) continue
        this.doc.snap()
        this.dragVert = { id: ev.id, i, dx: ev.poly[i][0] - x, dy: ev.poly[i][1] - y }
        this.capture(e)
        e.preventDefault()
        return
      }
    }

    /* A DOOR CAN BE DRAGGED, by clicking inside its ring. Anchors were droppable and deletable and nothing else, so a door landing two pixels off meant deleting it and clicking again, and one on unwalkable ground could not be rescued at all: the hub's only interactive thing sat 22px from the nearest floor for exactly this reason. */
    if (e.button === 0) {
      /* THE GRAB IS THE DOT, NOT THE WHOLE RING, which a large radius forces: grabbing by the full r is safe at 64 and swallows every click on the map at 400. */
      const onDot = (v: MapEvent) =>
        Math.hypot(v.x - x, v.y - y) <= Math.max(6, Math.min(v.r, ANCHOR_GRAB))
      const hit = [...this.doc.events].reverse().find((v) => this.anchorLive(v) && onDot(v))
      if (hit) {
        this.doc.snap()
        this.dragEvent = { id: hit.id, dx: hit.x - x, dy: hit.y - y }
        this.capture(e)
        e.preventDefault()
        return
      }
      /* ONE PRESS CHOOSES IT, THE NEXT ONE MOVES IT, on any step that does not own anchors. Selecting had one route in and it was a panel the assets step does not have. Separate presses also stop a stray click on a zone dragging an anchor somebody only meant to look at. */
      if (!this.eventsEditable && this.eventsVisible) {
        const pick = [...this.doc.events].reverse().find(onDot)
        if (pick) {
          this.selectAnchor(pick.id)
          this.say(`${pick.name} · press again to move it`)
          e.preventDefault()
          return
        }
        /* AND PRESSING THE MAP ITSELF LETS GO OF IT: the form opens from this press and the step has no row list to close it with, so an anchor chosen once stayed chosen with its handles live. Falls through rather than returning, because the press still belongs to whatever is under it. */
        if (this.anchorSel) this.selectAnchor(0)
      }
    }

    /* TOOLS BELONG TO THE STEP THAT OWNS THEM. The tool survived a step change, so arriving at test with the bucket still armed cut a hole in the map on one click, and arriving from levels painted walkable ground. Both silent, both undoable only if you noticed. */
    if (!this.paintable) return

    if (this.assetMode) {
      this.assetDown(e, x, y)
      return
    }
    const erase = e.shiftKey || e.button === 2 || this.tool === 'eraser'
    if (this.tool === 'region') {
      // accept-propose: left assigns the active level to the hovered colour
      // region, right (or shift) clears it back to blocked
      if (!this.regionLabels) {
        this.say('regions still loading')
        return
      }
      const id = this.regionAt(x, y)
      if (id < 0) return
      const v = erase ? 0 : this.value
      const n = this.applyRegion(id, v)
      this.say(n ? `${v === 0 ? 'cleared' : 'filled'} a region · ${n}px ${v === 0 ? '' : nameOf(v)}`.trim() : 'that region is already ' + nameOf(v))
      return
    }
    if (this.tool === 'pick') {
      this.value = this.doc.lvlAt(x, y)
      this.emit()
      return
    }
    if (this.tool === 'poly' || this.tool === 'occ' || this.tool === 'cutpoly') {
      this.poly.push([x + 0.5, y + 0.5])
      this.dirty = true
      return
    }
    if (this.tool === 'bucket') {
      this.doc.snap()
      this.doc.bucket(x, y, erase ? 0 : this.value)
      this.touched()
      return
    }
    if (this.tool === 'cutfill') {
      if (!this.pix || !this.doc.inB(x, y)) return
      this.doc.snap()
      const n = this.doc.cutFlood(x, y, erase ? 0 : 1, this.cutTol, this.pix)
      this.touched()
      this.say(`${erase ? 'uncut' : 'cut'} ${n}px, tolerance ${this.cutTol}`)
      return
    }
    if (this.tool === 'rect') {
      this.doc.snap()
      this.dragRect = [x, y, x, y]
      this.erasing = erase
      this.capture(e)
      return
    }
    this.doc.snap()
    this.drawing = true
    this.erasing = erase
    if (this.tool === 'cut' || this.tool === 'cuterase')
      this.doc.cutStamp(x, y, this.tool === 'cuterase' || erase ? 0 : 1, this.brush)
    else this.doc.stamp(x, y, erase ? 0 : this.value, this.brush)
    ;(this.canvas as HTMLCanvasElement).setPointerCapture(e.pointerId)
    this.touched()
  }

  private onMove(e: PointerEvent) {
    if (this.panning) {
      this.ox = this.panning.ox + (e.clientX - this.panning.sx)
      this.oy = this.panning.oy + (e.clientY - this.panning.sy)
      this.dirty = true
      return
    }
    // a door being dragged. It says whether the ground under it can be stood
    // on as it goes, so a door is never left somewhere the game cannot fire it.
    if (this.dragEvent) {
      const [x, y] = this.toNative(e)
      const ev = this.doc.events.find((v) => v.id === this.dragEvent!.id)
      if (ev) {
        this.moveAnchor(ev, Math.round(x + this.dragEvent.dx), Math.round(y + this.dragEvent.dy))
        this.touched()
      }
      return
    }
    /* AN AREA BEING DRAWN FREEHAND, sampled here. Only dirty is set, because emit() would run a React render per pointer move. The same painting pixel twice running is dropped: above zoom 1 the pointer covers several screen pixels inside one painting pixel, so a slow drag would store the same point twenty times. */
    if (this.newPoly?.drawing) {
      const [x, y] = this.toNative(e)
      const last = this.newPoly.pts[this.newPoly.pts.length - 1]
      if (!last || last[0] !== x || last[1] !== y) {
        this.newPoly.pts.push([x, y])
        this.dirty = true
      }
      return
    }
    // a corner of a drawn area being pulled. The shape is corrected in place
    // rather than redrawn from scratch, which is the whole reason the handles
    // are draggable: one corner in the water should not cost the other eleven.
    if (this.dragRing) {
      const [x, y] = this.toNative(e)
      const ev = this.doc.events.find((v) => v.id === this.dragRing!.id)
      if (ev) {
        const home = ev.placement ? this.placementRef(ev.placement) : undefined
        const spot = home ? this.lifeSpot(home) : { x: ev.x, y: ev.y }
        const rx = Math.round(x + this.dragRing.dx - spot.x)
        const ry = Math.round(y + this.dragRing.dy - spot.y)
        this.updateAnchor(ev.id, { ring: rx || ry ? [rx, ry] : null })
      }
      return
    }
    if (this.dragVert) {
      const [x, y] = this.toNative(e)
      const ev = this.doc.events.find((v) => v.id === this.dragVert!.id)
      const p = ev?.poly?.[this.dragVert.i]
      if (p) {
        p[0] = Math.round(x + this.dragVert.dx)
        p[1] = Math.round(y + this.dragVert.dy)
        this.touched()
      }
      return
    }
    if (!this.painting) return
    const [x, y] = this.toNative(e)
    this.cursor = [x, y]
    if (this.assetMode) {
      if (this.cropSt) {
        const c = this.cropSt
        if (c.dragging) {
          const p = this.cropPt(e)
          if (!c.grip || !c.from) c.b = p
          else this.cropDrag(c, p)
        } else if (c.id && c.a && c.b) {
          /* the pointer says what a press would do before it is pressed, which
           * is most of what makes handles feel like handles rather than like
           * eight squares somebody drew */
          const p = this.cropPt(e)
          const gx0 = Math.min(c.a[0], c.b[0])
          const gy0 = Math.min(c.a[1], c.b[1])
          const gx1 = Math.max(c.a[0], c.b[0])
          const gy1 = Math.max(c.a[1], c.b[1])
          const gp = this.cropGrip(p[0], p[1], gx0, gy0, gx1, gy1)
          const CUR: Record<string, string> = {
            nw: 'nwse-resize',
            se: 'nwse-resize',
            ne: 'nesw-resize',
            sw: 'nesw-resize',
            n: 'ns-resize',
            s: 'ns-resize',
            e: 'ew-resize',
            w: 'ew-resize',
            move: 'move',
          }
          if (this.canvas) this.canvas.style.cursor = CUR[gp] || 'default'
        }
        this.lastPx = [x, y]
        this.dirty = true
        this.emit()
        return
      }
      // the band lives inside the asset block: this whole branch returns before
      // the tail of onMove, so a band updated down there never moved at all
      if (this.bandSt) {
        this.bandSt.b = this.toNativeF(e)
        this.lastPx = [x, y]
        this.dirty = true
        this.emit()
        return
      }
      if (this.dragAsset) {
        const d = this.dragAsset
        const a = this.doc.assets.find((q) => q.id === d.id)
        if (a) {
          // the snapshot happens at the first real move, so a bare select
          // click never pushes an identical state onto the undo stack
          if (!d.moved) {
            this.doc.snap()
            d.moved = true
          }
          const [fx, fy] = this.toNativeF(e)
          if (d.mode === 'move') {
            const nx = clamp(Math.round(fx + d.dx), 0, this.doc.W - 1)
            const ny = clamp(Math.round(fy + d.dy), 0, this.doc.H - 1)
            if (d.many && d.many.length > 1) {
              // the whole picked set rides the same delta, measured off the one
              // under the pointer, so their spacing survives the move
              const start = d.many.find((m) => m.id === a.id)
              const ddx = nx - (start ? start.x : a.x)
              const ddy = ny - (start ? start.y : a.y)
              for (const m of d.many) {
                const q = this.doc.assets.find((z) => z.id === m.id)
                if (!q) continue
                this.moveTo(q, m.x + ddx, m.y + ddy)
              }
            } else {
              this.moveTo(a, nx, ny)
            }
          } else if (d.mode === 'rotate') {
            const [ax, ay] = this.assetOrigin(a)
            let rot = d.rot0 + Math.atan2(fy - ay, fx - ax) - d.a0
            // shift snaps to 15 degree steps
            if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12)
            while (rot > Math.PI) rot -= Math.PI * 2
            while (rot < -Math.PI) rot += Math.PI * 2
            a.rot = +rot.toFixed(4)
          } else if (d.mode === 'scale' && d.box && d.many && d.many.length > 1) {
            // a group scale pivots on the corner OPPOSITE the one grabbed, so that corner stays put and the box grows toward the pointer. Each member scales by the same factor and its distance from the pivot with it, so the arrangement grows without drifting apart.
            const f = clamp(Math.hypot(fx - d.box.cx, fy - d.box.cy) / d.d0, 0.05, 12)
            for (const m of d.many) {
              const q = this.doc.assets.find((z2) => z2.id === m.id)
              if (!q || m.sx === undefined || m.sy === undefined) continue
              q.sx = clamp(+(m.sx * f).toFixed(3), 0.02, 8)
              q.sy = clamp(+(m.sy * f).toFixed(3), 0.02, 8)
              q.scale = q.sx
              this.moveTo(q, d.box.cx + (m.x - d.box.cx) * f, d.box.cy + (m.y - d.box.cy) * f)
            }
          } else {
            const [ux, uy] = this.rotFrame(a, fx, fy)
            if (d.mode === 'scale') {
              // corner: uniform, the factor is how far the pointer pulled
              // from the feet anchor relative to where it grabbed
              const f = Math.hypot(ux, uy) / d.d0
              a.sx = clamp(+(d.sx0 * f).toFixed(3), 0.02, 8)
              a.sy = clamp(+(d.sy0 * f).toFixed(3), 0.02, 8)
            } else if (d.mode === 'stretchx') {
              a.sx = clamp(+((d.sx0 * Math.abs(ux)) / d.u0).toFixed(3), 0.02, 8)
            } else if (d.edge === 'top') {
              a.sy = clamp(+((d.sy0 * Math.abs(uy)) / d.u0).toFixed(3), 0.02, 8)
            } else {
              // the bottom edge sits ON the feet anchor, so its stretch is
              // delta-driven: dragging away from the body grows
              const ref = Math.max(this.assetNat(a).h * d.sy0, 1e-3)
              const g = (a.fy ? -uy : uy) / ref
              a.sy = clamp(+(d.sy0 * (1 + g)).toFixed(3), 0.02, 8)
            }
            a.scale = a.sx
          }
          this.touched()
        }
      }
      this.lastPx = [x, y]
      this.dirty = true
      this.emit()
      return
    }
    /* A TOOL THAT CANNOT ACT MUST NOT LOOK LIKE IT CAN. Painting is refused when the step does not own it, but this highlight was not, so arriving at test with fill-by-colour selected lit a region under the cursor on every move and read as an armed tool. */
    if (this.tool === 'region' && this.paintable && !this.drawing && !this.walking) {
      const id = this.regionAt(x, y)
      if (id !== this.hoverRegion) {
        this.hoverRegion = id
        this.bakeRegionHL()
        this.dirty = true
      }
    } else if (!this.paintable && this.hoverRegion >= 0) {
      // and leaving the step clears whatever was already lit
      this.hoverRegion = -1
      this.bakeRegionHL()
      this.dirty = true
    }
    if (this.drawing) {
      const [px, py] = this.lastPx || [x, y]
      if (this.tool === 'cut' || this.tool === 'cuterase') {
        const cv = this.tool === 'cuterase' || this.erasing ? 0 : 1
        bresenham(px, py, x, y, (cx, cy) => this.doc.cutStamp(cx, cy, cv, this.brush))
      } else {
        const v = this.erasing ? 0 : this.value
        bresenham(px, py, x, y, (cx, cy) => this.doc.stamp(cx, cy, v, this.brush))
      }
      this.touched()
    }
    if (this.dragRect) {
      this.dragRect[2] = x
      this.dragRect[3] = y
    }
    this.lastPx = [x, y]
    this.dirty = true
    this.emit()
  }

  private onUp(_e: PointerEvent) {
    this.panning = null
    // letting go closes the freehand area and hands it back as a highlight
    if (this.newPoly?.drawing) {
      this.closeRegionDrag()
      return
    }
    if (this.dragRing) {
      const ev = this.doc.events.find((v) => v.id === this.dragRing!.id)
      this.dragRing = null
      if (ev)
        this.say(
          ev.ring ? `${displayName(ev).text} · ring ${ev.ring[0]}, ${ev.ring[1]}` : `${displayName(ev).text} · ring centred`,
        )
      return
    }
    if (this.dragVert) {
      const ev = this.doc.events.find((v) => v.id === this.dragVert!.id)
      this.dragVert = null
      if (ev?.poly) this.say(`${displayName(ev).text} · ${ev.poly.length} corners`)
      return
    }
    if (this.dragEvent) {
      const ev = this.doc.events.find((v) => v.id === this.dragEvent!.id)
      this.dragEvent = null
      if (ev) {
        /* Say whether it can be reached, now, while the map is in front of you. An anchor drops on any pixel with no ground test, so a door can sit on a wall or on open water and still look correct on screen, 22px from the nearest floor. */
        /* The ring is only what the game tests when the ring is the live shape. On a region drawn as an area the radius is dormant data, so reporting on it would report on a circle the game never looks at. */
        if (anchorShape(ev) !== 'circle') this.say(`${ev.name} at ${ev.x}, ${ev.y}`)
        else {
          const ok = this.ringHasGround(ev.x, ev.y, ev.r)
          this.say(
            ok
              ? `${ev.name} at ${ev.x}, ${ev.y} · a player can reach it`
              : `${ev.name} at ${ev.x}, ${ev.y} · NOTHING WALKABLE INSIDE IT · the game will never fire it`,
          )
        }
      }
      return
    }
    if (this.bandSt) {
      const b = this.bandSt
      const dragged = Math.abs(b.b[0] - b.a[0]) > 2 || Math.abs(b.b[1] - b.a[1]) > 2
      const hits = dragged ? this.bandHits() : []
      this.bandSt = null
      if (!dragged) {
        // it was a click on empty painting after all: that clears
        if (!b.add) this.selAsset = ''
      } else {
        const next = b.add ? [...new Set([...hits, ...b.base])] : hits
        this.setSel(next)
        this.say(next.length ? `${next.length} picked` : 'nothing in there')
      }
      this.dirty = true
      this.emit()
      return
    }
    if (this.cropSt) {
      // the box stays on screen after the drag: enter takes it, esc drops it
      this.cropSt.dragging = false
      this.cropSt.grip = ''
      this.cropSt.from = null
      this.dirty = true
      this.emit()
      return
    }
    if (this.dragAsset && this.dragAsset.moved && this.dragAsset.mode !== 'move') {
      const a = this.doc.assets.find((q) => q.id === (this.dragAsset as { id: string }).id)
      if (a)
        this.say(
          this.dragAsset.mode === 'rotate'
            ? `${assetLabel(a)} · ${Math.round((a.rot * 180) / Math.PI)}°`
            : `${assetLabel(a)} · scale ${a.sx.toFixed(2)}×${a.sy.toFixed(2)}`,
        )
    }
    this.dragAsset = null
    if (this.dragRect) {
      const [a, b, c, d] = this.dragRect
      this.doc.fillRect(a, b, c, d, this.erasing ? 0 : this.value)
      this.dragRect = null
      this.touched()
    }
    this.drawing = false
  }

  private onWheel(e: WheelEvent) {
    if (!this.painting) return
    e.preventDefault()
    const r = (this.canvas as HTMLCanvasElement).getBoundingClientRect()
    this.setZoom(this.z + (e.deltaY < 0 ? 1 : -1), e.clientX - r.left, e.clientY - r.top)
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    const k = e.key.toLowerCase()
    this.keys[k] = down
    if (!down) return
    // esc leaves the generate-here pick without spending anything
    if (k === 'escape' && this.pickCb) {
      this.cancelPick()
      return
    }
    /* AN AREA BEING DRAWN owns enter and escape, ahead of the crop and the walk test, either of which would eat the enter that saves the shape. Escape throws the draft away and leaves what was stored untouched; backspace clears the draft without leaving the mode. */
    if (this.newPoly) {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.finishRegionDraw()
        return
      }
      if (k === 'escape') {
        e.preventDefault()
        this.cancelRegionDraw()
        return
      }
      if (e.key === 'Backspace') {
        e.preventDefault()
        this.newPoly.pts = []
        this.dirty = true
        this.emit()
        return
      }
      if (k === ' ') {
        e.preventDefault()
        return
      }
    }
    /* A ROUTE BEING LAID owns four keys, checked ahead of the crop and the walk test because both would eat the enter or the space meant for the line. Space is swallowed: starting the walk test under a half-drawn route is the same surprise as painting on the test step. */
    if (this.newPath) {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.finishPath()
        return
      }
      if (k === 'escape') {
        e.preventDefault()
        this.cancelPath()
        return
      }
      if (e.key === 'Backspace') {
        e.preventDefault()
        this.newPath.pop()
        this.dirty = true
        this.emit()
        return
      }
      if (k === ' ') {
        e.preventDefault()
        return
      }
    }
    // the crop rectangle owns the keyboard while it is up: enter takes it, esc
    // drops it, and nothing else (space would start the walk test under it)
    if (this.cropSt) {
      e.preventDefault()
      if (e.key === 'Enter') this.commitCrop()
      else if (k === 'escape') this.cancelCrop()
      return
    }
    if (k === ' ') {
      e.preventDefault()
      // space is the one key that means "the same thing the game means": start
      // walking, and once walking, hop. Esc is how you get back out, so space
      // never has to do double duty as an exit.
      if (this.walking) this.walker.jump()
      else this.toggleWalk()
      return
    }
    if (this.walking && k === 'escape') {
      e.preventDefault()
      this.toggleWalk()
      return
    }
    if (this.walking && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      e.preventDefault()
      return
    }
    // the asset step's own keys: scale, nudge, delete, stop placing. Everything
    // else falls through, so a tool key still pulls the workflow to its home step.
    if (this.assetMode) {
      // copy, paste, duplicate. Checked before the tool letters, or ctrl+c
      // would swap to the cut brush on its way past.
      if (e.ctrlKey || e.metaKey) {
        if (k === 'c') {
          e.preventDefault()
          this.copySelected()
          return
        }
        if (k === 'v') {
          e.preventDefault()
          this.pasteClipboard()
          return
        }
        if (k === 'd') {
          e.preventDefault()
          this.duplicateSelected(false)
          return
        }
        if (k === 'p' || k === 't') {
          // the browser owns both of these by default (print, new tab), and
          // both have to be taken off it before the panel sees them
          e.preventDefault()
          const ids = this.selIds()
          const req = k === 'p' ? this.bitifyReq : this.trimReq
          if (!ids.length) this.say('click an asset first')
          else if (req) req(ids)
          return
        }
      }
      if ((e.ctrlKey || e.metaKey) && k === 'a') {
        // everything on the map that is not in a hidden group
        e.preventDefault()
        const all = this.doc.assets.filter((a) => !this.hiddenGroups.has(a.group)).map((a) => a.id)
        this.setSel(all)
        this.say(all.length ? `${all.length} picked` : 'nothing on the map yet')
        return
      }
      if (k === '[' || k === ']') {
        this.scaleSelected(k === ']' ? 1.1 : 1 / 1.1)
        return
      }
      if (this.selCount() && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        e.preventDefault()
        const picked = this.selAssets()
        if (picked.length) {
          // 1px per press, 8px with shift; a burst coalesces into one undo
          const step = e.shiftKey ? 8 : 1
          const now = performance.now()
          const key = picked.map((a) => a.id).join(',')
          if (this.nudgeId !== key || now - this.nudgeAt > 900) this.doc.snap()
          this.nudgeId = key
          this.nudgeAt = now
          for (const a of picked) {
            if (k === 'arrowleft') this.moveTo(a, a.x - step, a.y)
            else if (k === 'arrowright') this.moveTo(a, a.x + step, a.y)
            else if (k === 'arrowup') this.moveTo(a, a.x, a.y - step)
            else this.moveTo(a, a.x, a.y + step)
          }
          this.touched()
        }
        return
      }
      if (k === 'delete' || k === 'backspace') {
        e.preventDefault()
        this.deleteSelected()
        return
      }
      if (k === 'escape') {
        if (this.placing) {
          this.placing = null
          this.say('placement stopped')
        } else if (this.selCount()) {
          this.selAsset = ''
        }
        this.dirty = true
        this.emit()
        return
      }
    }
    // a browser shortcut never changes a tool on its way past; ctrl+z still
    // reaches the undo below, so both undo keys work
    if ((e.ctrlKey || e.metaKey) && k !== 'z') return
    const p = PAL.find((q) => q.key === e.key)
    if (p) {
      this.value = p.v
      this.emit()
      return
    }
    if (k === 'z' && !this.walking) {
      if (this.undoDoc()) {
        // the undo may have removed the selected placement with it
        if (this.selAsset && !this.doc.assets.some((a) => a.id === this.selAsset)) this.selAsset = ''
        // and the next arrow nudge must open its own undo step
        this.nudgeId = ''
        this.touched()
      }
      return
    }
    if (k === 'u') this.setTool('region')
    else if (k === 'b') this.setTool('brush')
    else if (k === 'p') this.setTool('poly')
    else if (k === 'r') this.setTool('rect')
    else if (k === 'f') this.setTool('bucket')
    else if (k === 'e') this.setTool('eraser')
    else if (k === 'i') this.setTool('pick')
    else if (k === 'o') this.setTool('occ')
    else if (k === 'c') this.setTool('cut')
    else if (k === 'x') this.setTool('cuterase')
    else if (k === 'v') this.setTool('cutfill')
    else if (k === 'n') this.setTool('cutpoly')
    else if (k === 't') this.toggleCutPreview()
    else if (k === 'g') {
      this.grid = !this.grid
      this.dirty = true
      this.say(this.grid ? 'pixel grid on' : 'pixel grid off')
    } else if (k === 'm') {
      this.showMask = !this.showMask
      this.dirtyMask = true
      this.say(this.showMask ? 'levels shown' : 'levels hidden · m shows them')
    } else if (k === 'h') {
      this.showHits = !this.showHits
      this.dirtyMask = true
      this.say(this.showHits ? 'hit marks shown' : 'hit marks hidden')
    } else if (e.key === 'Enter') this.closePoly()
    else if (e.key === 'Escape') {
      this.poly = []
      this.dirty = true
    } else if (e.key === 'Backspace') {
      this.poly.pop()
      this.dirty = true
      e.preventDefault()
    } else if (k === '[') this.setBrush(this.brush - 1)
    else if (k === ']') this.setBrush(this.brush + 1)
    else if (k === '+' || k === '=') this.setZoom(this.z + 1)
    else if (k === '-') this.setZoom(this.z - 1)
  }

  // ---- commands ---------------------------------------------------------
  setTool(t: Tool) {
    this.tool = t
    this.poly = []
    if (t !== 'region') {
      this.hoverRegion = -1
      this.regionHL = null
    }
    this.dirty = true
    this.emit()
  }
  setValue(v: number) {
    this.value = v
    this.emit()
  }
  setBrush(n: number) {
    this.brush = clamp(n, 1, 16)
    this.dirty = true
    this.emit()
  }
  /* THE BASELINE OF THE ONE THAT IS SELECTED, and there is a selection now. This reached for occs[occs.length - 1] unconditionally, so drawing a second occluder made the first one's baseline permanently unreachable: the only number in the depth system a person sets by hand, on the only shape a building needs two of. */
  setBaseline(y: number) {
    const o = this.selectedOcc()
    if (!o) return
    this.doc.snap()
    o.baseline = Math.round(y)
    this.plates = null
    this.touched()
  }
  /* which occluder the baseline field and the delete button are about. The last
   * one drawn until somebody picks another, which is what the tool already did
   * and is right the moment after you draw one. */
  selectedOcc(): Occluder | undefined {
    return this.doc.occs.find((o) => o.id === this.occSel) || this.doc.occs[this.doc.occs.length - 1]
  }
  selectOcc(id: number) {
    this.occSel = id
    this.dirty = true
    this.emit()
  }
  /* An occluder deleted properly: the id comes out of the list AND its pixels
   * come out of the plane, or the plane keeps painting a shape nothing has a
   * baseline for and the export ships it. One undo step for both. */
  deleteOcc(id: number) {
    const i = this.doc.occs.findIndex((o) => o.id === id)
    if (i < 0) return
    this.doc.snap()
    this.doc.occs.splice(i, 1)
    for (let k = 0; k < this.doc.occ.length; k++) if (this.doc.occ[k] === id) this.doc.occ[k] = 0
    if (this.occSel === id) this.occSel = 0
    this.plates = null
    this.touched()
    this.say(`occluder ${id} removed · z undoes`)
  }
  closePoly() {
    if (this.poly.length < 3) {
      this.poly = []
      this.dirty = true
      return
    }
    this.doc.snap()
    if (this.tool === 'occ') {
      const o = this.doc.addOccluder(this.poly)
      this.plates = null
      this.say(`occluder ${o.id}, baseline y ${o.baseline}`)
    } else if (this.tool === 'cutpoly') {
      this.doc.fillPoly(this.poly, 1, 'cut')
    } else {
      this.doc.fillPoly(this.poly, this.value, 'lvl')
    }
    this.keepStencil(this.poly)
    this.poly = []
    this.touched()
  }

  /* THE OUTLINE, KEPT ON THE WAY OUT. An author traces one shape for the level,
   * the same shape again for the cut and a third time for the occluder, because
   * closePoly rasterized and cleared and nothing ever stored the points. */
  private keepStencil(pts: [number, number][]) {
    if (pts.length < 3) return
    this.doc.stencils.unshift({ id: this.doc.stencilNext++, pts: pts.map(([x, y]) => [x, y] as [number, number]) })
    this.doc.stencils.length = Math.min(this.doc.stencils.length, STENCIL_KEEP)
  }

  // the kept outline laid down again with whatever tool and level are live now
  applyStencil(id: number) {
    const k = this.doc.stencils.find((q) => q.id === id)
    if (!k) return false
    this.doc.snap()
    if (this.tool === 'occ') {
      const o = this.doc.addOccluder(k.pts)
      this.plates = null
      this.say(`occluder ${o.id}, baseline y ${o.baseline}`)
    } else if (this.tool === 'cutpoly') {
      this.doc.fillPoly(k.pts, 1, 'cut')
      this.say('cut')
    } else {
      this.doc.fillPoly(k.pts, this.value, 'lvl')
      this.say(`level ${this.value}`)
    }
    this.touched()
    return true
  }

  deleteStencil(id: number) {
    const i = this.doc.stencils.findIndex((q) => q.id === id)
    if (i < 0) return
    this.doc.stencils.splice(i, 1)
    this.touched()
  }

  setCutTol(n: number) {
    this.cutTol = clamp(Math.round(n), 0, 120)
    this.emit()
  }
  // ---- the region-accept propose. The app computes flat-ish colour regions off-thread and hands them in; the editor only reads them, hover highlights one and a click assigns the active level. No network, nothing lands unseen.
  pixelsCopy(): Uint8ClampedArray | null {
    return this.pix ? this.pix.slice() : null
  }
  setRegions(labels: Int32Array | null, count: number) {
    this.regionLabels = labels
    this.regionCount = count
    this.hoverRegion = -1
    this.regionHL = null
    this.dirty = true
    this.emit()
  }
  regionAt(x: number, y: number): number {
    if (!this.regionLabels || !this.doc.inB(x, y)) return -1
    return this.regionLabels[this.doc.idx(x, y)]
  }
  // assign one region to one level value. Cut pixels and original
  // transparency never take a level: the sea is not ground. One snapshot, so
  // one undo takes the whole region back.
  applyRegion(id: number, v: number): number {
    const L = this.regionLabels
    if (!L || !this.pix) return 0
    this.doc.snap()
    let n = 0
    for (let i = 0; i < L.length; i++) {
      if (L[i] !== id) continue
      if (this.doc.cut[i] || this.pix[i * 4 + 3] === 0) continue
      if (this.doc.lvl[i] !== v) {
        this.doc.lvl[i] = v
        n++
      }
    }
    if (!n) {
      this.doc.undo()
      return 0
    }
    this.touched()
    return n
  }
  // the hovered region, baked once per hover change: a faint fill and a
  // marching-ants edge in alternating black and white, readable on any art
  private bakeRegionHL() {
    if (this.hoverRegion < 0 || !this.regionLabels) {
      this.regionHL = null
      return
    }
    const { W, H } = this.doc
    const L = this.regionLabels
    const id = this.hoverRegion
    const c = mkCanvas(W, H)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    const d = g.createImageData(W, H)
    const p = d.data
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (L[i] !== id) continue
        const edge =
          x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
          L[i - 1] !== id || L[i + 1] !== id || L[i - W] !== id || L[i + W] !== id
        if (edge) {
          const w = (x + y) & 2
          p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = w ? 255 : 0
          p[i * 4 + 3] = 235
        } else {
          p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = 255
          p[i * 4 + 3] = 46
        }
      }
    g.putImageData(d, 0, 0)
    this.regionHL = c
  }
  // ---- the assets step. Life the painting deliberately left out, placed on top of it. Every mutation snapshots the document first, so z walks placements, drags, scales and clears back exactly like mask strokes.
  /* on or off, and it answers where it landed so the caller can say so */
  toggleAssetGhost(): boolean {
    this.assetGhost = !this.assetGhost
    this.dirty = true
    this.emit()
    return this.assetGhost
  }
  setAssetMode(on: boolean) {
    if (this.assetMode === on) return
    this.assetMode = on
    if (!on) {
      this.placing = null
      this.selAsset = ''
      this.dragAsset = null
      this.cancelPick()
      this.cancelCrop()
    }
    this.dirty = true
    this.emit()
  }
  // ---- the generate-here pick. One armed click-picker: while set, every canvas click hands its painting pixel to the callback instead of the tools. The callback owns validity so a miss stays armed; esc or right-click cancels with null.
  private pickCb: ((p: Pt | null) => void) | null = null
  pickPoint(cb: ((p: Pt | null) => void) | null) {
    this.pickCb = cb
    this.dirty = true
  }
  private cancelPick() {
    const cb = this.pickCb
    if (!cb) return
    this.pickCb = null
    this.dirty = true
    cb(null)
  }
  // is there art under this point once the cut is applied? A generate-here
  // click only counts where the map actually is.
  opaqueAt(x: number, y: number): boolean {
    if (!this.pix || !this.doc.inB(x, y)) return false
    const i = this.doc.idx(x, y)
    return !this.doc.cut[i] && this.pix[i * 4 + 3] > 0
  }
  // the painting's own pixels around a point, cut pixels dropped to nothing. What an effect samples its colours from and what the sway rule shears: raw rgba, no data url, no decode, so a click can read the palette and render frames in one tick.
  patchAround(x: number, y: number, r: number): { data: Uint8ClampedArray; w: number; h: number } | null {
    if (!this.pix) return null
    const { W, H } = this.doc
    if (W < 1 || H < 1) return null
    const x0 = clamp(Math.round(x) - r, 0, W - 1)
    const y0 = clamp(Math.round(y) - r, 0, H - 1)
    const x1 = clamp(Math.round(x) + r, 0, W - 1)
    const y1 = clamp(Math.round(y) + r, 0, H - 1)
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    const out = new Uint8ClampedArray(w * h * 4)
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++) {
        const i = this.doc.idx(x0 + xx, y0 + yy)
        if (this.doc.cut[i]) continue
        const o = (yy * w + xx) * 4
        out[o] = this.pix[i * 4]
        out[o + 1] = this.pix[i * 4 + 1]
        out[o + 2] = this.pix[i * 4 + 2]
        out[o + 3] = this.pix[i * 4 + 3]
      }
    return { data: out, w, h }
  }
  // a crop of the cut-applied painting around a point, the context a generation is given. The window slides inside the canvas edges instead of shrinking, so it only comes back smaller on a painting smaller than size.
  cropAround(x: number, y: number, size = 160): { crop: string; w: number; h: number } | null {
    if (!this.painting) return null
    const w = Math.min(size, this.doc.W)
    const h = Math.min(size, this.doc.H)
    const x0 = clamp(Math.round(x - w / 2), 0, this.doc.W - w)
    const y0 = clamp(Math.round(y - h / 2), 0, this.doc.H - h)
    if (!this.cutApplied) this.cutApplied = this.buildCutApplied()
    const c = mkCanvas(w, h)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.drawImage(this.cutApplied, x0, y0, w, h, 0, 0, w, h)
    return { crop: c.toDataURL('image/png'), w, h }
  }
  // arm a library item: the next canvas clicks stamp it down, esc stops
  armPlace(item: LibItem | null) {
    if (item && this.placing && this.placing.name === item.name) item = null
    this.placing = item
    if (item) {
      this.selAsset = ''
      this.say(`click the map to place ${item.name} · esc stops`)
    }
    this.dirty = true
    this.emit()
  }
  private assetDown(e: PointerEvent, x: number, y: number) {
    // the crop rectangle owns the pointer while it is up: left drags the box,
    // right backs out without touching anything
    if (this.cropSt) {
      if (e.button === 2) {
        this.cancelCrop()
        return
      }
      const p = this.cropPt(e)
      const c = this.cropSt
      /* An AREA is drawn from nothing, so a press starts a new rectangle. A CROP already has one round the whole picture, so a press takes hold of part of it. Two gestures, and only one ever asks you to draw a box. */
      if (!c.id || !c.a || !c.b) {
        c.a = p
        c.b = p
        c.dragging = true
        c.grip = ''
        c.from = null
      } else {
        const x0 = Math.min(c.a[0], c.b[0])
        const y0 = Math.min(c.a[1], c.b[1])
        const x1 = Math.max(c.a[0], c.b[0])
        const y1 = Math.max(c.a[1], c.b[1])
        c.grip = this.cropGrip(p[0], p[1], x0, y0, x1, y1)
        c.from = { x0, y0, x1, y1, px: p[0], py: p[1] }
        c.dragging = true
        // normalised, so every drag below works from a known corner order
        c.a = [x0, y0]
        c.b = [x1, y1]
      }
      this.capture(e)
      this.dirty = true
      return
    }
    if (e.button === 2) {
      // right-click backs out: first the armed item, then the selection
      if (this.placing) {
        this.placing = null
        this.say('placement stopped')
      } else if (this.selAsset) {
        this.selAsset = ''
      }
      this.dirty = true
      this.emit()
      return
    }
    if (this.placing) {
      this.placeAt(x, y)
      return
    }
    const [fx, fy] = this.toNativeF(e)
    // a group frame's corner grips come before anything under them: they sit
    // out at the bounds where a stray placement might also be
    const gb = this.groupBox()
    if (gb) {
      const r = 5 / Math.max(1, this.z)
      for (const h of this.groupHandles()) {
        if (Math.abs(fx - h.x) <= r && Math.abs(fy - h.y) <= r) {
          this.dragAsset = {
            id: this._selAsset,
            mode: 'scale',
            moved: false,
            dx: 0,
            dy: 0,
            sx0: 1,
            sy0: 1,
            // how far the grabbed corner is from the far corner: the group
            // scales by how that distance changes
            d0: Math.max(Math.hypot(fx - (gb.cx - (h.x - gb.cx)), fy - (gb.cy - (h.y - gb.cy))), 1e-3),
            u0: 1,
            rot0: 0,
            a0: 0,
            edge: 'top',
            many: this.selAssets().map((a) => ({ id: a.id, x: a.x, y: a.y, sx: a.sx, sy: a.sy, rot: a.rot })),
            box: { cx: gb.cx - (h.x - gb.cx), cy: gb.cy - (h.y - gb.cy), w: gb.x1 - gb.x0, h: gb.y1 - gb.y0 },
          }
          this.capture(e)
          this.dirty = true
          this.emit()
          return
        }
      }
    }
    // the selected asset's transform handles take the pointer first
    if (this.selAsset && this.selCount() === 1) {
      const a = this.doc.assets.find((q) => q.id === this.selAsset)
      if (a && !this.hiddenGroups.has(a.group)) {
        const h = this.hitHandle(a, fx, fy)
        if (h) {
          const [ux, uy] = this.rotFrame(a, fx, fy)
          // the turn is measured about the DRAWN feet, which is the pixel the
          // sprite pivots on: measuring it about the anchor of something that
          // has wandered off would swing the box round a point on empty ground
          const [ax, ay] = this.assetOrigin(a)
          const d: NonNullable<typeof this.dragAsset> = {
            id: a.id,
            mode: h.mode,
            moved: false,
            dx: 0,
            dy: 0,
            sx0: a.sx,
            sy0: a.sy,
            d0: Math.max(Math.hypot(ux, uy), 1e-3),
            u0: 1e-3,
            rot0: a.rot,
            a0: Math.atan2(fy - ay, fx - ax),
            edge: h.edge || 'top',
          }
          if (h.mode === 'stretchx') d.u0 = Math.max(Math.abs(ux), 1e-3)
          if (h.mode === 'stretchy' && d.edge === 'top') d.u0 = Math.max(Math.abs(uy), 1e-3)
          this.dragAsset = d
          this.capture(e)
          this.dirty = true
          this.emit()
          return
        }
      }
    }
    const hit = this.assetAt(fx, fy)
    const extend = e.shiftKey || e.ctrlKey || e.metaKey
    if (hit) {
      const cur = this.selIds()
      if (extend) {
        // shift on something already picked drops it back out, which is how
        // you fix a band that swept up one thing too many
        if (cur.includes(hit.id)) {
          const left = cur.filter((i) => i !== hit.id)
          this.setSel(left)
          this.say(left.length ? `${left.length} picked` : 'nothing picked')
          return
        }
        this.setSel([hit.id, ...cur])
        this.say(`${cur.length + 1} picked`)
      } else if (!cur.includes(hit.id)) {
        // a plain click on something outside the selection starts fresh; a
        // plain click on something INSIDE it keeps the set, so dragging a
        // group by one of its members moves the group
        this.selAsset = hit.id
      } else {
        this._selAsset = hit.id
      }
      /* dragging moves everything picked, so each one's start point is kept. What the pointer carries is the ANCHOR, so the sprite travels exactly as far as the pointer and the behaviour underneath is untouched, roaming box included. Dragging the drawn position would fold the wander into the anchor and the figure would jump the moment the clock moved on. */
      this.dragAsset = {
        id: hit.id,
        mode: 'move',
        moved: false,
        dx: hit.x - fx,
        dy: hit.y - fy,
        sx0: hit.sx,
        sy0: hit.sy,
        d0: 1,
        u0: 1,
        rot0: hit.rot,
        a0: 0,
        edge: 'top',
        many: this.selAssets().map((a) => ({ id: a.id, x: a.x, y: a.y })),
      }
      this.capture(e)
    } else {
      // empty painting: start the band. The selection is not cleared yet. A
      // click that turns out to be a click and not a drag clears it on the way
      // up, so a band that starts over nothing does not flash the panel empty.
      this.bandSt = { a: [fx, fy], b: [fx, fy], base: extend ? this.selIds() : [], add: extend }
      this.capture(e)
    }
    this.dirty = true
    this.emit()
  }
  /* everything the band touches. Slide editors select on TOUCH rather than on
   * full containment, so a sweep that clips a palm's fronds takes the palm. */
  private bandHits(): string[] {
    const b = this.bandSt
    if (!b) return []
    const x0 = Math.min(b.a[0], b.b[0])
    const x1 = Math.max(b.a[0], b.b[0])
    const y0 = Math.min(b.a[1], b.b[1])
    const y1 = Math.max(b.a[1], b.b[1])
    const out: string[] = []
    for (const a of this.doc.assets) {
      if (this.hiddenGroups.has(a.group)) continue
      const c = this.assetCorners(a)
      let ax0 = Infinity
      let ax1 = -Infinity
      let ay0 = Infinity
      let ay1 = -Infinity
      for (const [px, py] of c) {
        ax0 = Math.min(ax0, px)
        ax1 = Math.max(ax1, px)
        ay0 = Math.min(ay0, py)
        ay1 = Math.max(ay1, py)
      }
      if (ax1 >= x0 && ax0 <= x1 && ay1 >= y0 && ay0 <= y1) out.push(a.id)
    }
    return out
  }
  private placeAt(x: number, y: number) {
    const it = this.placing
    if (!it || !this.doc.inB(x, y)) return
    this.doc.snap()
    const s = defaultScale(it)
    const a: PlacedAsset = {
      id: 'a' + this.doc.assetNext++,
      group: groupFor(it.name),
      kind: it.kind,
      x,
      y,
      scale: s,
      sx: s,
      sy: s,
      rot: 0,
      fx: false,
      fy: false,
    }
    if (it.kind === 'animated') {
      a.frames = it.frames ? it.frames.slice() : []
      a.fps = it.fps || 8
    } else {
      a.src = it.src
    }
    // a set of VIEWS rides onto the placement whole. Without this the placement
    // knew only the one view its src pointed at, so it could not face where it
    // walked and could not even be looked up by name.
    if (it.dirs && Object.keys(it.dirs).length) a.dirs = { ...it.dirs }
    this.doc.assets.push(a)
    this.selAsset = a.id
    // placing into a hidden group must land visibly
    this.hiddenGroups.delete(a.group)
    this.touched()
    this.say(`placed ${it.name} in ${a.group} · esc stops`)
  }
  // ---- the placement transform. Local space is the png's own pixels with the feet anchor at the origin. The world transform is flip, then axis scale, then rotation about the feet, then the anchor translation, the exact order Pixi composes anchor(0.5,1) sprites, so the editor shows what the game draws.
  private assetNat(a: PlacedAsset): { w: number; h: number } {
    const img = this.assetImg(a.kind === 'animated' ? (a.frames && a.frames[0]) || '' : a.src || '')
    if (img) return { w: img.naturalWidth, h: img.naturalHeight }
    return { w: 24, h: 24 }
  }
  /* The feet as DRAWN, which for anything that moves is not a.x,a.y, so the box, the handles and the rotate stalk sit on the sprite. The live tilt rides with it because a boat leaning 30 degrees is a box leaning 30 degrees. The live FLIP does not, because the box is symmetric about the feet and honouring it would swap which edge handle is left every time a figure turned mid-drag. */
  private assetOrigin(a: PlacedAsset): Pt {
    const L = this.liveAt.get(a.id)
    return [a.x + (L ? L.dx : 0), a.y + (L ? L.dy : 0)]
  }
  /* live=false asks for the placement's own geometry with wherever its behaviour
   * has walked to left out: what a crop or an align works on is the thing, not
   * the moment. */
  private assetPt(a: PlacedAsset, lx: number, ly: number, live = true): Pt {
    const L = live ? this.liveAt.get(a.id) : undefined
    const px = lx * a.sx * (a.fx ? -1 : 1)
    const py = ly * a.sy * (a.fy ? -1 : 1)
    const rot = a.rot + (L ? L.rot : 0)
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    return [a.x + (L ? L.dx : 0) + px * c - py * s, a.y + (L ? L.dy : 0) + px * s + py * c]
  }
  // painting point into the asset's rotated (but unscaled) frame around the
  // drawn feet, so the pointer is measured against the sprite it is over
  private rotFrame(a: PlacedAsset, x: number, y: number): Pt {
    const L = this.liveAt.get(a.id)
    const dx = x - (a.x + (L ? L.dx : 0))
    const dy = y - (a.y + (L ? L.dy : 0))
    const rot = a.rot + (L ? L.rot : 0)
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    return [dx * c + dy * s, -dx * s + dy * c]
  }
  // painting point all the way into local png space, for hit-testing
  private assetLocal(a: PlacedAsset, x: number, y: number): Pt {
    const [rx, ry] = this.rotFrame(a, x, y)
    return [rx / (a.sx * (a.fx ? -1 : 1)), ry / (a.sy * (a.fy ? -1 : 1))]
  }
  private assetCorners(a: PlacedAsset, live = true): Pt[] {
    const { w, h } = this.assetNat(a)
    return [
      this.assetPt(a, -w / 2, -h, live),
      this.assetPt(a, w / 2, -h, live),
      this.assetPt(a, w / 2, 0, live),
      this.assetPt(a, -w / 2, 0, live),
    ]
  }
  // topmost first: the draw order is y-sorted, so hit-test it backwards
  private assetAt(x: number, y: number): PlacedAsset | null {
    const list = this.assetsSorted()
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i]
      // a pass that has faded right out is not on screen, and the draw skipped
      // it: a click goes through to whatever is behind, which is what the eye
      // expects of something it cannot see
      const L = this.liveAt.get(a.id)
      if (L && L.alpha <= 0.01) continue
      const { w, h } = this.assetNat(a)
      const [lx, ly] = this.assetLocal(a, x, y)
      if (lx >= -w / 2 && lx <= w / 2 && ly >= -h && ly <= 0) return a
    }
    return null
  }
  // which transform handle of the selected asset sits under the pointer.
  // Screen-space tolerance, so a handle is as grabbable at 1x as at 8x.
  private hitHandle(
    a: PlacedAsset,
    x: number,
    y: number,
  ): { mode: 'scale' | 'stretchx' | 'stretchy' | 'rotate'; edge?: 'top' | 'bottom' | 'left' | 'right' } | null {
    const { w, h } = this.assetNat(a)
    const tol = 7 / this.z
    const near = (p: Pt) => Math.hypot(p[0] - x, p[1] - y) <= tol
    // the rotate handle floats above the box, so it wins first
    if (near(this.rotHandlePos(a))) return { mode: 'rotate' }
    for (const [lx, ly] of [
      [-w / 2, -h],
      [w / 2, -h],
      [w / 2, 0],
      [-w / 2, 0],
    ] as Pt[])
      if (near(this.assetPt(a, lx, ly))) return { mode: 'scale' }
    if (near(this.assetPt(a, -w / 2, -h / 2))) return { mode: 'stretchx', edge: 'left' }
    if (near(this.assetPt(a, w / 2, -h / 2))) return { mode: 'stretchx', edge: 'right' }
    if (near(this.assetPt(a, 0, -h))) return { mode: 'stretchy', edge: 'top' }
    if (near(this.assetPt(a, 0, 0))) return { mode: 'stretchy', edge: 'bottom' }
    return null
  }
  // 16 screen px out from the top edge's midpoint, along the box's own up
  private rotHandlePos(a: PlacedAsset): Pt {
    const { h } = this.assetNat(a)
    const [ax, ay] = this.assetOrigin(a)
    const top = this.assetPt(a, 0, -h)
    const vx = top[0] - ax
    const vy = top[1] - ay
    const L = Math.hypot(vx, vy) || 1
    const out = 16 / this.z
    return [top[0] + (vx / L) * out, top[1] + (vy / L) * out]
  }
  private assetsSorted(): PlacedAsset[] {
    return this.doc.assets.filter((a) => !this.hiddenGroups.has(a.group)).sort((p, q) => assetDepth(p) - assetDepth(q))
  }
  selectAsset(id: string) {
    const a = this.doc.assets.find((q) => q.id === id)
    if (!a) return
    this.selAsset = id
    this.placing = null
    this.hiddenGroups.delete(a.group)
    this.dirty = true
    this.emit()
  }
  deleteAsset(id: string) {
    const i = this.doc.assets.findIndex((a) => a.id === id)
    if (i < 0) return
    this.doc.snap()
    const [a] = this.doc.assets.splice(i, 1)
    if (this.selAsset === id) this.selAsset = ''
    this.touched()
    this.say(`removed ${assetLabel(a)} · z undoes`)
  }
  /* everything picked, in ONE undo step: forty deletes that each snapshot would
   * take forty presses of z to walk back */
  deleteSelected() {
    const ids = new Set(this.selIds())
    if (!ids.size) return
    if (ids.size === 1) return this.deleteAsset([...ids][0])
    this.doc.snap()
    const n = this.doc.assets.length
    this.doc.assets = this.doc.assets.filter((a) => !ids.has(a.id))
    this.selAsset = ''
    this.touched()
    this.say(`removed ${n - this.doc.assets.length} · z undoes`)
  }

  // ---- many at once ------------------------------------------------------
  /* Align, distribute and stacking order on the picked set, read off the placements' DRAWN bounds and not their anchors, because that is what the eye lines up. The anchor is then moved by the same delta the edge needed, so nothing else about the placement changes. */
  private drawnBox(a: PlacedAsset) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    /* Where a behaviour has walked to is deliberately left out: aligning a crowd
     * off the pixel each figure happened to be standing on this frame would drag
     * their anchors to wherever the clock had them. */
    for (const [px, py] of this.assetCorners(a, false)) {
      x0 = Math.min(x0, px)
      y0 = Math.min(y0, py)
      x1 = Math.max(x1, px)
      y1 = Math.max(y1, py)
    }
    return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }
  }
  /* How wide a BODY is, for the separation pass and nothing else: the INK of look 0's first picture times the x scale, which is the number the game uses. Not the canvas it was saved on, and not drawnBox, which folds in height and rotation so a tall thing laid on its side would carry a keep-out circle several times its body here and its body's worth in the game. Where a behaviour has walked to is left out, because a width that breathed as a boat rocked would be a preview the game does not run. */
  private bodyW(a: PlacedAsset) {
    const img = this.assetImg(a.kind === 'animated' ? (a.frames && a.frames[0]) || '' : a.src || '')
    return (img ? this.inkOf(img) : this.assetNat(a).w) * Math.abs(a.sx)
  }
  private bodyR(a: PlacedAsset) {
    return bodyRadius(this.bodyW(a))
  }
  /* the ink width of one loaded picture, read once and kept against that very
   * Image. An in-place edit builds a new Image for the rewritten png, so it is
   * measured again without anything having to remember to invalidate this. */
  private inkCache = new Map<HTMLImageElement, number>()
  private inkOf(img: HTMLImageElement) {
    const hit = this.inkCache.get(img)
    if (hit !== undefined) return hit
    const w = img.naturalWidth
    const h = img.naturalHeight
    let out = w
    try {
      const c = mkCanvas(w, h)
      const g = c.getContext('2d') as CanvasRenderingContext2D
      g.drawImage(img, 0, 0)
      out = inkWidth(g.getImageData(0, 0, w, h).data, w, h)
    } catch {
      // a picture that cannot be read back keeps its canvas width, which is
      // what this measured by before it measured anything better
    }
    this.inkCache.set(img, out)
    return out
  }
  /* Whether ANYTHING that moves can reach this standing placement, and so whether it is something to go round. Two kinds of mover, each asked about its own fence: the floor-held one is a pixel scan kept per placement and keyed by radius, so a picture still loading when the question was first asked is asked again; the box-held one is four comparisons and is worked out fresh, so a life edit never has to invalidate it. */
  private reachCache = new Map<string, boolean>()
  private moverCanTouch(a: PlacedAsset, free: (LifeBounds | null | undefined)[]) {
    if (this.walkerCanTouch(a)) return true
    const r = this.bodyR(a)
    return free.some((b) => freeReach(a.x, a.y, r, this.cfg.yScale, b))
  }
  private walkerCanTouch(a: PlacedAsset) {
    const r = this.bodyR(a)
    const key = a.id + '@' + r
    const hit = this.reachCache.get(key)
    if (hit !== undefined) return hit
    const out = walkerCanReach(a.x, a.y, r, this.cfg.yScale, this.standsAt)
    this.reachCache.set(key, out)
    return out
  }
  align(edge: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') {
    const picked = this.selAssets()
    if (picked.length < 2) {
      this.say('pick two or more first')
      return
    }
    const boxes = picked.map((a) => ({ a, b: this.drawnBox(a) }))
    const all = {
      x0: Math.min(...boxes.map((q) => q.b.x0)),
      x1: Math.max(...boxes.map((q) => q.b.x1)),
      y0: Math.min(...boxes.map((q) => q.b.y0)),
      y1: Math.max(...boxes.map((q) => q.b.y1)),
    }
    const cx = (all.x0 + all.x1) / 2
    const cy = (all.y0 + all.y1) / 2
    this.doc.snap()
    for (const { a, b } of boxes) {
      if (edge === 'left') this.moveTo(a, a.x + (all.x0 - b.x0), a.y)
      else if (edge === 'right') this.moveTo(a, a.x + (all.x1 - b.x1), a.y)
      else if (edge === 'hcenter') this.moveTo(a, a.x + (cx - b.cx), a.y)
      else if (edge === 'top') this.moveTo(a, a.x, a.y + (all.y0 - b.y0))
      else if (edge === 'bottom') this.moveTo(a, a.x, a.y + (all.y1 - b.y1))
      else this.moveTo(a, a.x, a.y + (cy - b.cy))
    }
    this.touched()
    this.say(`aligned ${picked.length} · ${edge}`)
  }
  /* Even gaps between the picked things, outermost two held still. Measured edge to edge rather than centre to centre, so a wide tree and a narrow post end up with the same air between them. */
  distribute(axis: 'h' | 'v') {
    const picked = this.selAssets()
    if (picked.length < 3) {
      this.say('pick three or more first')
      return
    }
    const boxes = picked
      .map((a) => ({ a, b: this.drawnBox(a) }))
      .sort((p, q) => (axis === 'h' ? p.b.x0 - q.b.x0 : p.b.y0 - q.b.y0))
    const first = boxes[0].b
    const last = boxes[boxes.length - 1].b
    const span = axis === 'h' ? last.x1 - first.x0 : last.y1 - first.y0
    let used = 0
    for (const q of boxes) used += axis === 'h' ? q.b.w : q.b.h
    const gap = (span - used) / (boxes.length - 1)
    this.doc.snap()
    let cur = axis === 'h' ? first.x0 : first.y0
    for (const { a, b } of boxes) {
      if (axis === 'h') {
        this.moveTo(a, a.x + (cur - b.x0), a.y)
        cur += b.w + gap
      } else {
        this.moveTo(a, a.x, a.y + (cur - b.y0))
        cur += b.h + gap
      }
    }
    this.touched()
    this.say(`spaced ${picked.length} evenly`)
  }
  /* Stacking order. The game y-sorts, so what this really moves is the feet: to put something in front you stand it lower down the map. Saying that plainly beats a "bring to front" that silently does nothing once the bundle is exported. */
  /* IN FRONT OF, OR BEHIND, WHAT IT OVERLAPS. The map is drawn in depth order and depth is
   * where a thing stands, so the old version of this moved the placement down the map to put
   * it in front: correct on screen and wrong about the world, because a barrel does not slide
   * two feet south to sit over a puddle. It nudges the sort key instead, which leaves x and y
   * exactly where the author put them.
   *
   * The step is measured against what this actually COVERS rather than against the whole map,
   * so one press clears the thing in the way and not every thing on the island. With nothing
   * overlapping it there is nothing to be in front of, and it says so rather than quietly
   * writing a number that changes no pixels.
   */
  order(dir: 'front' | 'back') {
    const picked = this.selAssets()
    if (!picked.length) {
      this.say('click an asset first')
      return
    }
    const others = this.doc.assets.filter((a) => !picked.includes(a) && !this.hiddenGroups.has(a.group))
    if (!others.length) {
      this.say('nothing else on the map')
      return
    }
    /* the drawn boxes, live movement left out: a wanderer's depth has to be decided about the
     * thing itself and not about wherever it happened to have walked to when the button was
     * pressed, or the same two presses would order it differently each time. */
    const box = (a: PlacedAsset) => {
      const c = this.assetCorners(a, false)
      const xs = c.map((p) => p[0])
      const ys = c.map((p) => p[1])
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
    }
    const mine = picked.map(box)
    const over = others.filter((a) => mine.some((m) => boxesOverlap(box(a), m)))
    if (!over.length) {
      this.say('nothing overlaps it, so there is nothing to be in front of')
      return
    }
    const d = orderDelta(dir, picked.map(assetDepth), over.map(assetDepth))
    if (d === null) {
      this.say(dir === 'front' ? 'already in front of what it covers' : 'already behind what it covers')
      return
    }
    this.doc.snap()
    for (const a of picked) {
      const next = Math.round((a.z || 0) + d)
      /* a bias wider than the map is meaningless, since y itself cannot exceed it */
      const lim = clamp(next, -this.doc.H, this.doc.H)
      if (lim) a.z = lim
      else delete a.z
    }
    this.touched()
    this.say(
      dir === 'front'
        ? `in front of ${over.length} thing${over.length > 1 ? 's' : ''} it covers · it has not moved`
        : `behind ${over.length} thing${over.length > 1 ? 's' : ''} it covers · it has not moved`,
    )
  }
  /* BACK TO SORTING BY WHERE IT STANDS, which is the only state a map has ever been published
   * in and so the one an author must be able to get back to without guessing at a number. */
  orderReset() {
    const picked = this.selAssets()
    if (!picked.length) {
      this.say('click an asset first')
      return
    }
    const biased = picked.filter((a) => a.z)
    if (!biased.length) {
      this.say('already sorted by where it stands')
      return
    }
    this.doc.snap()
    for (const a of biased) delete a.z
    this.touched()
    this.say(`${biased.length} back to sorting by where it stands`)
  }
  clearGroup(group: string) {
    const n = this.doc.assets.filter((a) => a.group === group).length
    if (!n) return
    this.doc.snap()
    this.doc.assets = this.doc.assets.filter((a) => a.group !== group)
    this.proposedGroups.delete(group)
    if (this.selAsset && !this.doc.assets.some((a) => a.id === this.selAsset)) this.selAsset = ''
    this.touched()
    this.say(`cleared ${group} · ${n} removed · z undoes`)
  }
  // a library item was deleted on disk: every placement that used it comes off the map in one snapshot, so z restores the placements even though the file stays gone. Matched by the item's own served url.
  removePlacementsOf(item: LibItem): number {
    const key =
      item.kind === 'animated'
        ? item.frames && item.frames[0]
          ? item.frames[0].slice(0, item.frames[0].lastIndexOf('/') + 1)
          : ''
        : item.src || ''
    if (this.placing && this.placing.name === item.name) {
      this.placing = null
      this.dirty = true
      this.emit()
    }
    if (!key) return 0
    const gone = (a: PlacedAsset) =>
      a.kind === 'animated' ? !!(a.frames && a.frames[0] && a.frames[0].startsWith(key)) : a.src === key
    const n = this.doc.assets.filter(gone).length
    if (!n) return 0
    this.doc.snap()
    this.doc.assets = this.doc.assets.filter((a) => !gone(a))
    if (this.selAsset && !this.doc.assets.some((a) => a.id === this.selAsset)) this.selAsset = ''
    this.touched()
    return n
  }
  // a library item was rewritten in place: every placement takes the new frame list and rate, or a re-render with more frames leaves existing placements playing a short loop. One snapshot, so z puts the previous timing back.
  refreshPlacementsOf(item: LibItem): number {
    /* A DIRECTION SET IS NEITHER A FRAME LIST NOR A STILL, and this handled only those two, building an empty key and returning nought. So a character animated AFTER it was placed kept the one-frame headings it was placed with and stood frozen for good, because the cycle reads the placement's own dirs. Keyed on the folder the headings live in. */
    if (item.dirs && Object.keys(item.dirs).length) {
      const first = Object.values(item.dirs).find((l) => l && l.length)?.[0] || ''
      const folder = first.slice(0, first.lastIndexOf('/') + 1)
      if (!folder) return 0
      const inFolder = (u?: string) => !!u && u.startsWith(folder)
      const list = this.doc.assets.filter(
        (a) => inFolder(a.src) || (!!a.dirs && Object.values(a.dirs).some((l) => l.some(inFolder))),
      )
      if (!list.length) return 0
      this.doc.snap()
      for (const a of list) {
        a.dirs = Object.fromEntries(Object.entries(item.dirs).map(([h, l]) => [h, l.slice()]))
        a.fps = item.fps || 8
        const rest = Object.keys(a.dirs).find((k) => (a.src || '').includes('/' + k + '-')) || 'south'
        const still = a.dirs[rest] && a.dirs[rest][0]
        if (still) a.src = still
      }
      this.touched()
      return list.length
    }
    const m = itemMatch(item)
    if (!m.key) return 0
    const list = this.doc.assets.filter((a) => placementIsOf(a, m))
    if (!list.length) return 0
    this.doc.snap()
    for (const a of list) {
      if (item.kind === 'animated') {
        /* the kind moves with the frames. Leaving it static keeps the renderer
         * reading `src`, so the thing stands still on a list of frames it now
         * carries, which is the half-converted state that reads as "it animated
         * and then stopped". */
        a.kind = 'animated'
        a.frames = item.frames ? item.frames.slice() : []
        a.fps = item.fps || 8
        // the still it was placed as no longer exists, and a src beside frames
        // is a second answer to which pixels this is
        if (a.src) delete a.src
      } else {
        /* AND THE KIND MOVES BACK WITH IT. This set src alone, so a placement that had been
         * animated stayed kind animated on a frames list whose folder was gone: the renderer
         * reads frames for an animated placement and never looks at src, so it drew nothing at
         * all. The mirror of the bug the branch above carries a comment about. */
        a.kind = 'static'
        a.src = item.src
        if (a.frames) delete a.frames
      }
    }
    this.touched()
    return list.length
  }
  // ---- the sparkle accept flow ------------------------------------------
  // a group the sparkle run landed stays ghosted until a human rules on it:
  // the check keeps it, the x takes the whole group off the island
  markGroupProposed(group: string) {
    this.proposedGroups.add(group)
    this.dirty = true
    this.emit()
  }
  acceptGroup(group: string) {
    if (!this.proposedGroups.delete(group)) return
    this.dirty = true
    this.emit()
    this.say(`${group} kept`)
  }
  rejectGroup(group: string) {
    this.proposedGroups.delete(group)
    this.clearGroup(group)
  }
  setGroupHidden(group: string, hidden: boolean) {
    if (hidden) this.hiddenGroups.add(group)
    else this.hiddenGroups.delete(group)
    if (hidden && this.selAsset) {
      const a = this.doc.assets.find((q) => q.id === this.selAsset)
      if (a && a.group === group) this.selAsset = ''
    }
    this.dirty = true
    this.emit()
    this.say(hidden ? `${group} hidden here · still exports` : `${group} shown`)
  }
  scaleSelected(f: number) {
    const picked = this.selAssets()
    if (!picked.length) {
      this.say('click an asset first')
      return
    }
    this.doc.snap()
    for (const a of picked) {
      a.sx = clamp(+(a.sx * f).toFixed(3), 0.02, 8)
      a.sy = clamp(+(a.sy * f).toFixed(3), 0.02, 8)
      a.scale = a.sx
    }
    this.touched()
    const a = picked[0]
    this.say(
      picked.length > 1
        ? `${picked.length} scaled`
        : `${assetLabel(a)} · scale ${a.sx.toFixed(2)}${a.sy !== a.sx ? '×' + a.sy.toFixed(2) : ''}`,
    )
  }
  // mirror the picked placements about their own feet anchors; the game renders
  // the same flip as negative sprite scale
  flipSelected(axis: 'x' | 'y') {
    const picked = this.selAssets()
    if (!picked.length) {
      this.say('click an asset first')
      return
    }
    this.doc.snap()
    for (const a of picked) {
      if (axis === 'x') a.fx = !a.fx
      else a.fy = !a.fy
    }
    this.touched()
    const a = picked[0]
    const on = axis === 'x' ? a.fx : a.fy
    this.say(
      picked.length > 1
        ? `${picked.length} flipped ${axis === 'x' ? 'h' : 'v'}`
        : `${assetLabel(a)} · flip ${axis === 'x' ? 'h' : 'v'} ${on ? 'on' : 'off'}`,
    )
  }
  // copies of everything picked, and the copies become the selection so a
  // duplicate can be dragged straight off the originals. offset drops them
  // beside; ctrl+d asks for them in place, right on top.
  /* Move a placement, and take its roaming box with it. life.bounds is absolute painting pixels, so anything that moves a placement without shifting them leaves the box behind: the thing walks back to where it was first placed, and a duplicate inherits the original's box, which is a row of walkers pacing one square. Everything that moves a placement goes through here. */
  private moveTo(a: PlacedAsset, nx: number, ny: number) {
    const x = clamp(Math.round(nx), 0, this.doc.W - 1)
    const y = clamp(Math.round(ny), 0, this.doc.H - 1)
    const b = a.life && a.life.bounds
    if (b) {
      // clamped so a box dragged off the edge keeps its size rather than
      // collapsing against the border
      b.x = clamp(Math.round(b.x + (x - a.x)), 0, Math.max(0, this.doc.W - b.w))
      b.y = clamp(Math.round(b.y + (y - a.y)), 0, Math.max(0, this.doc.H - b.h))
      /* THE BOX MOVED, SO THE NUMBER THAT DESCRIBES IT IS ABOUT SOMEWHERE ELSE. walkPct is the 35% law's input, measured when the box is drawn. Carried verbatim through a drag or a duplicate it describes ground the box no longer covers: 63.2% stored against 20.3% real leaves a figure fenced to a box with almost no floor in it, holding still for a whole leg. It reads on screen as a walking sprite randomly getting stuck, and it is random because it resolves per leg. */
      if (a.life && typeof (a.life as { walkPct?: number }).walkPct === 'number')
        (a.life as { walkPct?: number }).walkPct = this.walkFraction(b)
    }
    a.x = x
    a.y = y
  }

  duplicateSelected(offset = true) {
    const picked = this.selAssets()
    if (!picked.length) {
      this.say('click an asset first')
      return
    }
    this.doc.snap()
    const made: string[] = []
    for (const a of picked) {
      const b: PlacedAsset = {
        ...a,
        id: 'a' + this.doc.assetNext++,
        frames: a.frames ? a.frames.slice() : undefined,
        x: a.x,
        y: a.y,
        // the copy gets its own movement, or the pair moves as one thing. The
        // bounds are cloned rather than shared, because two placements pointing
        // at one box means dragging either drags both their roaming areas.
        ...(a.life
          ? {
              life: {
                ...(this.freshLife(a.life) as Life),
                ...(a.life.bounds ? { bounds: { ...a.life.bounds } } : {}),
              },
            }
          : {}),
      }
      // through moveTo, so the copy's box comes with it instead of being left
      // on top of the original's and pacing a square it does not stand in
      if (offset) this.moveTo(b, a.x + 12, a.y + 6)
      this.doc.assets.push(b)
      made.push(b.id)
    }
    this.setSel(made)
    this.touched()
    this.say(
      picked.length > 1
        ? `${made.length} duplicated${offset ? '' : ' in place'}`
        : offset
          ? `duplicated ${assetLabel(picked[0])}`
          : `duplicated ${assetLabel(picked[0])} in place`,
    )
  }
  // ---- copy and paste. The clipboard holds a detached copy, not a reference, so deleting the original or loading another painting leaves it intact. It carries the item's own urls, so a paste into another scene draws as long as those files are there.
  copySelected(): boolean {
    const picked = this.selAssets()
    if (!picked.length) {
      this.say('click an asset first')
      return false
    }
    clipboard = picked.map((a) => ({ ...a, frames: a.frames ? a.frames.slice() : undefined }))
    this.emit()
    this.say(
      picked.length > 1
        ? `copied ${picked.length} · ctrl v pastes`
        : `copied ${assetLabel(picked[0])} · ctrl v pastes`,
    )
    return true
  }
  /* Paste lands under the cursor when the cursor is over the painting and just off the originals when it is not, so a paste is never invisible. A pasted SET keeps its arrangement, positioned by the block's own top-left. */
  pasteClipboard(): boolean {
    if (!clipboard.length) {
      this.say('nothing copied yet')
      return false
    }
    let x0 = Infinity
    let y0 = Infinity
    for (const c of clipboard) {
      x0 = Math.min(x0, c.x)
      y0 = Math.min(y0, c.y)
    }
    const over = this.cursor && this.doc.inB(this.cursor[0], this.cursor[1])
    const tx = over ? (this.cursor as Pt)[0] : x0 + 8
    const ty = over ? (this.cursor as Pt)[1] : y0 + 6
    this.doc.snap()
    const made: string[] = []
    for (const c of clipboard) {
      const b: PlacedAsset = {
        ...c,
        id: 'a' + this.doc.assetNext++,
        frames: c.frames ? c.frames.slice() : undefined,
        x: c.x,
        y: c.y,
        // cloned, not shared: two placements pointing at one box means dragging
        // either drags both their roaming areas
        ...(c.life
          ? {
              life: {
                ...(this.freshLife(c.life) as Life),
                ...(c.life.bounds ? { bounds: { ...c.life.bounds } } : {}),
              },
            }
          : {}),
      }
      // the box travels with the paste, so a walker dropped on the far quay
      // roams there rather than pacing where it was copied from
      this.moveTo(b, tx + (c.x - x0), ty + (c.y - y0))
      this.doc.assets.push(b)
      this.hiddenGroups.delete(b.group)
      made.push(b.id)
    }
    this.setSel(made)
    this.touched()
    this.say(made.length > 1 ? `pasted ${made.length} · z undoes` : `pasted ${assetLabel(clipboard[0])} · z undoes`)
    return true
  }
  // ---- typed edits -------------------------------------------------------
  // One call is one undo step, so a number typed into the inspector walks back
  // exactly like a drag. Every field lands in the same clamps the gestures use.
  /* THE BODY, EDITED. One field at a time, each clamped wide enough for a room at character scale and narrow enough that a typo cannot make a map unwalkable. Every one changes what the game does, so each is one undo step and marks the map dirty. */
  setWalk(patch: Partial<WalkCfg>) {
    const w = this.doc.walk
    const n = (v: unknown, lo: number, hi: number, whole = true) => {
      const x = Math.max(lo, Math.min(hi, Number(v)))
      return whole ? Math.round(x) : +x.toFixed(2)
    }
    const next: WalkCfg = { ...w }
    if (patch.charH !== undefined && isFinite(Number(patch.charH))) next.charH = n(patch.charH, 4, 128)
    if (patch.hip !== undefined && isFinite(Number(patch.hip))) next.hip = n(patch.hip, 0, 32)
    if (patch.hipDY !== undefined && isFinite(Number(patch.hipDY))) next.hipDY = n(patch.hipDY, 0, 32)
    if (patch.speed !== undefined && isFinite(Number(patch.speed))) next.speed = n(patch.speed, 1, 400, false)
    if (patch.yScale !== undefined && isFinite(Number(patch.yScale))) next.yScale = n(patch.yScale, 0.2, 1, false)
    if (patch.near !== undefined && isFinite(Number(patch.near))) next.near = n(patch.near, 0, 100)
    if ((Object.keys(next) as (keyof WalkCfg)[]).every((k) => next[k] === w[k])) return false
    this.doc.snap()
    this.doc.walk = next
    this.touched()
    return true
  }

  /* WHAT THIS MAP IS, as opposed to what is drawn on it. Every field here
   * either had no home at all or had one that died before the bundle. */
  /* null on `paint` clears it, which undefined cannot mean: undefined is "this
   * patch does not mention it", the same split updateEvent makes. */
  setProps(patch: Omit<Partial<MapProps>, 'paint'> & { paint?: [number, number, number, number] | null }) {
    const p = this.doc.props
    const next: MapProps = { ...p }
    if (patch.title !== undefined) next.title = String(patch.title).slice(0, 120)
    if (patch.class !== undefined && MAP_CLASSES.includes(patch.class)) next.class = patch.class
    if (patch.islandId !== undefined) next.islandId = String(patch.islandId).trim().slice(0, 64)
    if (patch.meta !== undefined && patch.meta && typeof patch.meta === 'object') next.meta = patch.meta
    // four numbers or nothing, and nothing is how you go back to measured
    if (patch.paint !== undefined) {
      if (patch.paint && patch.paint.length === 4 && patch.paint.every((n) => isFinite(n)))
        next.paint = patch.paint.map((n) => Math.round(n)) as [number, number, number, number]
      else delete next.paint
    }
    if (
      next.title === p.title &&
      next.class === p.class &&
      next.islandId === p.islandId &&
      next.meta === p.meta &&
      String(next.paint) === String(p.paint)
    )
      return false
    this.doc.snap()
    this.doc.props = next
    this.touched()
    return true
  }

  /* One key in the map's own bag, the stated extension point, which had no writer at all so it carried only this tool's bookkeeping. null REMOVES the key and '' keeps it holding nothing: typing a name into the blank row has to make a key before there is a value to put in it. */
  setMapMeta(key: string, value: string | null) {
    const k = String(key || '').trim()
    if (!k) return false
    const meta = { ...this.doc.props.meta }
    if (value === null) delete meta[k]
    else meta[k] = value
    return this.setProps({ meta })
  }

  /* A name no other placement on this map has taken. Same suffix walk the
   * library and the anchors already use, so three copies of one thing read the
   * way three anchors named the same way already read. */
  freePlacementName(want: string, exceptId = ''): string {
    const base = anchorName(want)
    const taken = new Set(this.doc.assets.filter((a) => a.id !== exceptId && a.name).map((a) => a.name as string))
    if (!taken.has(base)) return base
    for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
  }

  /* NAMING A PLACEMENT IS THE SAME EDIT AS RENAMING AN ANCHOR and refuses the same way: a name changed under an author is worse than one they have to fix, and this string is what a member's python will address. Blank clears it, which is a real answer, since most placements are scenery. */
  namePlacement(id: string, want: string): { ok: boolean; name?: string; why?: string } {
    const a = this.doc.assets.find((q) => q.id === id)
    if (!a) return { ok: false, why: 'gone' }
    const trimmed = String(want || '').trim()
    if (!trimmed) {
      if (a.name) {
        this.doc.snap()
        this.repointBindings(a.name, a.id)
        delete a.name
        this.touched()
      }
      return { ok: true }
    }
    const clean = anchorName(trimmed)
    if (!isPlacementName(clean))
      return {
        ok: false,
        why: /^a[0-9]+$/.test(clean)
          ? 'a name shaped like a1 is what the tool calls placements itself · pick another'
          : 'letters, digits and underscores, starting with a letter',
      }
    const free = this.freePlacementName(clean, id)
    if (a.name === free) return { ok: true, name: free }
    this.doc.snap()
    /* every anchor pointing at this thing follows the rename, whether it holds the previous name or the machine id. Renaming is the one direction a binding breaks silently, since the id is the fallback and a fresh name leaves it pointing at nothing, and it is fixable here because both keys are in hand. */
    this.repointBindings(a.name || a.id, free)
    a.name = free
    this.touched()
    return { ok: true, name: free, why: free !== clean ? `taken · saved as ${free}` : undefined }
  }

  /* Move every binding from one placement key to another. Used by naming and by
   * clearing a name, so an anchor never quietly stops pointing at the thing an
   * author can see it is on. */
  private repointBindings(from: string, to: string) {
    if (from === to) return
    for (const e of this.doc.events) if (e.placement === from) e.placement = to
  }

  editAsset(id: string, patch: AssetPatch): boolean {
    const a = this.doc.assets.find((q) => q.id === id)
    if (!a) return false
    const sc = (v: number) => clamp(+Number(v).toFixed(3), 0.02, 8)
    const next: AssetPatch = {}
    if (patch.x !== undefined && isFinite(patch.x)) next.x = clamp(Math.round(patch.x), 0, this.doc.W - 1)
    if (patch.y !== undefined && isFinite(patch.y)) next.y = clamp(Math.round(patch.y), 0, this.doc.H - 1)
    if (patch.sx !== undefined && isFinite(patch.sx)) next.sx = sc(patch.sx)
    if (patch.sy !== undefined && isFinite(patch.sy)) next.sy = sc(patch.sy)
    if (patch.rot !== undefined && isFinite(patch.rot)) {
      let r = patch.rot
      while (r > Math.PI) r -= Math.PI * 2
      while (r < -Math.PI) r += Math.PI * 2
      next.rot = +r.toFixed(4)
    }
    if (patch.fx !== undefined) next.fx = !!patch.fx
    if (patch.fy !== undefined) next.fy = !!patch.fy
    if (patch.group !== undefined) {
      const g = String(patch.group).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'props'
      next.group = g
    }
    // nothing actually different means no snapshot: z stays meaningful
    const same = (Object.keys(next) as (keyof AssetPatch)[]).every((k) => a[k] === next[k])
    if (same) return false
    this.doc.snap()
    // x and y go through moveTo so a typed coordinate carries the roaming box
    // the same way a drag does. Everything else is a plain field.
    const { x: nx, y: ny, ...rest } = next
    Object.assign(a, rest)
    if (nx !== undefined || ny !== undefined) this.moveTo(a, nx ?? a.x, ny ?? a.y)
    a.scale = a.sx
    if (next.group) this.hiddenGroups.delete(next.group)
    this.touched()
    return true
  }
  // point a placement at another library item, keeping it selected. The caller
  // owns where it lands: a crop passes the anchor that keeps the pixels still.
  /* MOVE A SET OF PLACEMENTS AS ONE UNDO STEP. Going through editAsset snapshotted once per placement, so nineteen trees meant nineteen entries and z put ONE tree back and left the other eighteen where the crop had moved them: measured 18 of 19 still displaced after a single press. One snapshot before anything moves, the same shape as addPlacements. */
  moveAll(at: Map<string, { x: number; y: number } | null>): number {
    const hits = [...at].filter(([id, p]) => p && this.doc.assets.some((q) => q.id === id))
    if (!hits.length) return 0
    this.doc.snap()
    let n = 0
    for (const [id, p] of hits) {
      const a = this.doc.assets.find((q) => q.id === id)
      if (!a || !p) continue
      // through moveTo, so a roaming box travels with the thing it belongs to
      this.moveTo(a, clamp(Math.round(p.x), 0, this.doc.W - 1), clamp(Math.round(p.y), 0, this.doc.H - 1))
      n++
    }
    this.touched()
    return n
  }

  repointAsset(id: string, item: LibItem, at?: { x: number; y: number }): boolean {
    const a = this.doc.assets.find((q) => q.id === id)
    if (!a) return false
    this.doc.snap()
    a.kind = item.kind
    if (item.kind === 'animated') {
      a.frames = item.frames ? item.frames.slice() : []
      a.fps = item.fps || 8
      delete a.src
    } else {
      a.src = item.src
      delete a.frames
      delete a.fps
    }
    if (item.dirs && Object.keys(item.dirs).length) a.dirs = { ...item.dirs }
    else delete a.dirs
    // through moveTo like every other move: a crop that shifts the anchor moves
    // the figure on screen, so its roaming box shifts with it
    if (at) this.moveTo(a, at.x, at.y)
    this.touched()
    return true
  }
  // the pixels behind one url were rewritten under the same name: drop the cached image and let the next draw ask again with a tag the browser cache cannot answer. The stored key stays the clean url, so exports never see the tag.
  /* An item's pixels were rewritten UNDER ITS OWN NAME at a different size, so every placement has to be re-scaled or they all change size on the map. The url did not change, so the placements are matched the way refreshPlacementsOf matches them and their scale is multiplied by how much the png shrank. This is the price of editing in place, and the library stays one row per thing. */
  rescalePlacementsOf(item: LibItem, fx: number, fy: number): number {
    const key =
      item.kind === 'animated'
        ? item.frames && item.frames[0]
          ? item.frames[0].slice(0, item.frames[0].lastIndexOf('/') + 1)
          : ''
        : item.src || ''
    if (!key || (fx === 1 && fy === 1)) return 0
    const mine = (a: PlacedAsset) =>
      a.kind === 'animated' ? !!(a.frames && a.frames[0] && a.frames[0].startsWith(key)) : a.src === key
    const list = this.doc.assets.filter(mine)
    if (!list.length) return 0
    for (const a of list) {
      a.sx = clamp(+(a.sx * fx).toFixed(4), -8, 8)
      a.sy = clamp(+(a.sy * fy).toFixed(4), -8, 8)
      a.scale = Math.abs(a.sx)
    }
    this.dirty = true
    return list.length
  }
  /* How much of a boxed area is ground a person could stand on, 0..1, which decides whether a behaviour gets one fence or two: mostly walkable says they fenced a PATH so the thing keeps to the floor inside it, mostly not says they fenced a REGION so the box alone holds. Sampled on a grid, because a 300x200 box is 60,000 reads while a gesture is being finished. */
  walkFraction(r: { x: number; y: number; w: number; h: number }): number {
    const step = Math.max(1, Math.floor(Math.min(r.w, r.h) / 40))
    let seen = 0
    let walk = 0
    for (let y = r.y; y < r.y + r.h; y += step)
      for (let x = r.x; x < r.x + r.w; x += step) {
        if (x < 0 || y < 0 || x >= this.doc.W || y >= this.doc.H) continue
        seen++
        if (this.doc.lvl[(y | 0) * this.doc.W + (x | 0)]) walk++
      }
    return seen ? walk / seen : 0
  }
  /* the floor probe a behaviour is fenced by. It has to be the SAME answer the game gives, not a near one: a walkOnly wander takes the first standable candidate out of a fixed sequence, so one disagreement forks every leg after it. That means the body test, feet plus two hips, and reading the plane the export actually writes, since levelsCanvas zeroes every cut pixel. */
  standsAt = (x: number, y: number): boolean => {
    if (!canStand(this.doc, this.cfg, x, y)) return false
    const cut = (px: number, py: number) => this.doc.cutAt(Math.round(px), Math.round(py)) > 0
    return !cut(x, y) && !cut(x - this.cfg.hip, y - this.cfg.hipDY) && !cut(x + this.cfg.hip, y - this.cfg.hipDY)
  }

  /* A copy of a moving placement must not march in step with its original: the behaviour is driven entirely by seed and clock, so two copies sharing both are the same creature twice. A fresh seed and phase turn a pasted row into a crowd instead of a chorus line. */
  private freshLife(life: Life | null | undefined): Life | null {
    if (!life) return null
    const out: Life = {
      ...life,
      seed: 1 + Math.floor(Math.random() * 2147483000),
      phase: Math.random() * 60,
    }
    // a copy's states have to be re-seeded too, or the crowd transforms as one
    if (life.states)
      out.states = life.states.map((s) =>
        s.move ? { ...s, move: { ...s.move, seed: 1 + Math.floor(Math.random() * 2147483000) } } : { ...s },
      )
    return out
  }
  /* The behaviour a placement is following RIGHT NOW: its own life without a sequence, and whichever state is live at the preview clock with one, off life.ts's own walk rather than a second copy. A state that holds has no behaviour at all. */
  private liveLife(a: PlacedAsset): Life | null {
    const l = a.life
    if (!l) return null
    // paused, the preview draws every placement at home wearing its first
    // picture, so the fence it shows is the placement's own one
    if (!l.states || l.states.length < 2 || !this.lifePlay) return l
    const t = this.lifeNow() + (l.phase || 0)
    return l.states[liveState(l.states, t).k].move || null
  }
  /* re-roll one placement's movement without asking for a new behaviour: same
   * kind, same numbers, different life */
  shuffleLife(id: string): boolean {
    const a = this.doc.assets.find((q) => q.id === id)
    if (!a || !a.life) return false
    this.doc.snap()
    a.life = this.freshLife(a.life) as Life
    this.restartLife()
    this.touched()
    this.say('reshuffled')
    return true
  }
  /* Give a placement a way of moving, or take it away. One undo step, and the
   * preview clock restarts so a fresh behaviour is judged from its beginning
   * rather than from wherever the page happened to be. */
  setLife(id: string, life: Life | null, looks?: AssetLook[]) {
    const a = this.doc.assets.find((q) => q.id === id)
    if (!a) return false
    this.doc.snap()
    if (life) a.life = life
    else delete a.life
    /* the behaviour and the pictures it switches to land in ONE undo step, or z leaves half a sequence behind. The pictures given here are the whole truth about this placement: a troll that was a sequence and is now a plain wander would otherwise carry its boulder into the export, indexed by an art nobody sets. */
    if (looks && looks.length) a.looks = looks.map((l) => ({ ...l }))
    else delete a.looks
    this.nameLooks(a)
    this.restartLife()
    this.touched()
    return true
  }

  /* EVERY FACE GETS THE NAME IT ALREADY HAS, so show(placement, state) has a vocabulary the moment a sequence is made. The planner answers in names and App.tsx resolves each to an index and drops the word, so nothing downstream has seen it; recovering it from the url is exact rather than a guess, because the face name and the row name are segments of the path platform.mjs built. A NAME A PERSON TYPED IS NEVER OVERWRITTEN. */
  private nameLooks(a: PlacedAsset) {
    if (!isLookName(a.lookName)) {
      const n = lookNameFrom(a)
      if (n) a.lookName = n
    }
    for (const L of a.looks || []) {
      if (isLookName(L.name)) continue
      const n = lookNameFrom(L)
      if (n) L.name = n
    }
    /* TWO FACES CANNOT SHARE ONE WORD: a collision means two placements' pictures folded to one string, and a name that resolves to two indices is a name python cannot use. The later one loses its name and keeps its slot, because the slot is the index and the index is what draws. */
    const seen = new Set<string>()
    for (let i = 0; i < 1 + (a.looks?.length || 0); i++) {
      const cur = i === 0 ? a.lookName : a.looks![i - 1].name
      if (!cur) continue
      if (!seen.has(cur)) {
        seen.add(cur)
        continue
      }
      if (i === 0) delete a.lookName
      else delete a.looks![i - 1].name
    }
  }
  /* Which way a standing figure looks. Only a view set can answer it, and only one that is standing: a walker faces where it is going and lifeAt decides that every frame, so a chosen facing would be overwritten before it was seen. Both renderers read the resting heading off the placement's own src, so pointing src at another heading turns the figure on both sides. */
  faceAsset(ids: string[], heading: string): number {
    const want = new Set(ids)
    const picked = this.doc.assets.filter((a) => want.has(a.id) && a.dirs && a.dirs[heading] && !a.life)
    if (!picked.length) return 0
    this.doc.snap()
    for (const a of picked) a.src = a.dirs![heading][0]
    this.touched()
    return picked.length
  }

  /* One behaviour onto everything picked, which is how a crowd gets made. They share the box, because a market is one place, and they do not share the seed and the phase, because identical numbers make a dozen figures step in perfect time. Each gets its own copy of the bounds, so dragging one later moves only its own area. */
  setLifeMany(ids: string[], life: Life | null, looks?: AssetLook[]) {
    const want = new Set(ids)
    const picked = this.doc.assets.filter((a) => want.has(a.id))
    if (!picked.length) return 0
    this.doc.snap()
    for (const a of picked) {
      if (!life) {
        delete a.life
        delete a.looks
        continue
      }
      a.life = {
        ...(this.freshLife(life) as Life),
        ...(life.bounds ? { bounds: { ...life.bounds } } : {}),
      }
      /* the same pictures for the whole set, each its own copy, under the one snapshot above. Whatever they were switching to before goes, for the reason setLife drops it: a crowd re-lifed with a plain wander keeping its old looks would export pictures no art index can reach. */
      if (looks && looks.length) a.looks = looks.map((l) => ({ ...l }))
      else delete a.looks
      // the crowd's faces get their names the same way one placement's do, so a
      // sequence made on twelve figures at once is addressable on all twelve
      this.nameLooks(a)
    }
    this.restartLife()
    this.touched()
    return picked.length
  }
  /* THE PREVIEW CLOCK, and the one place anything reads it. It stands still while a living placement is dragged, scaled, turned or cropped, or a sprite whose position is a function of the clock walks out from under the cursor while you hold it. Coming out of the hold the clock is rewound by however long the gesture took, so nothing jumps and no behaviour skips a beat. Never saved, never exported. */
  private lifeNow(): number {
    return this.lifeHold !== null ? this.lifeHold : performance.now() / 1000 - this.lifeT0
  }
  /* the clock back to the beginning, so a fresh behaviour is judged from its
   * start rather than from wherever the page happened to be. Any hold goes with
   * it, or releasing that hold would put the old clock back over the restart. */
  private restartLife() {
    this.lifeT0 = performance.now() / 1000
    this.lifeHold = null
  }
  /* Has a gesture got hold of something that MOVES? Asked every frame rather than latched at pointer-down, so no path can end a gesture and leave the clock stopped. */
  private gestureOnLife(): boolean {
    const d = this.dragAsset
    const ids = d
      ? d.many && d.many.length
        ? d.many.map((m) => m.id)
        : [d.id]
      : this.cropSt && this.cropSt.id
        ? [this.cropSt.id]
        : []
    return ids.some((id) => this.doc.assets.some((a) => a.id === id && !!a.life))
  }
  /* pause the preview: a thing that will not hold still is hard to place, and
   * hard to judge the LOOK of */
  toggleLifePlay() {
    this.lifePlay = !this.lifePlay
    this.restartLife()
    this.dirty = true
    this.emit()
    return this.lifePlay
  }
  bustAssets(prefix: string) {
    if (!prefix) return
    const t = Date.now()
    for (const k of [...this.assetCache.keys()])
      if (k.startsWith(prefix)) {
        this.assetCache.delete(k)
        this.bustTag.set(k, t)
      }
    this.dirty = true
  }
  // ---- crop. A rectangle dragged over the selected placement in painting space; on enter its four corners go back through the placement's own transform, so the rect the caller receives is in the SOURCE png's pixels however the placement is scaled, flipped or rotated. Nothing is written here.
  /* WHICH GRIP A PRESS LANDED ON. The reach is worked out from the zoom so it is a constant number of SCREEN pixels: a handle you cannot hit at 1x is the whole gesture failing on the small sprites this is mostly used on. Inside the box and away from every edge means slide the whole window. */
  private cropGrip(
    px: number,
    py: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): '' | 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'se' | 'sw' {
    const near = Math.max(2, 7 / Math.max(this.z, 0.0001))
    const L = Math.abs(px - x0) <= near
    const R = Math.abs(px - x1) <= near
    const T = Math.abs(py - y0) <= near
    const B = Math.abs(py - y1) <= near
    const inX = px >= x0 - near && px <= x1 + near
    const inY = py >= y0 - near && py <= y1 + near
    if (T && L) return 'nw'
    if (T && R) return 'ne'
    if (B && R) return 'se'
    if (B && L) return 'sw'
    if (T && inX) return 'n'
    if (B && inX) return 's'
    if (L && inY) return 'w'
    if (R && inY) return 'e'
    if (px > x0 && px < x1 && py > y0 && py < y1) return 'move'
    // outside it entirely: nothing moves, rather than the box jumping to meet
    // a press that was probably meant for something else
    return ''
  }

  /* ONE EDGE, OR THE WHOLE WINDOW, MOVED BY HOW FAR THE POINTER HAS COME, as a delta from where the grip was taken rather than by snapping the edge to the cursor, so grabbing an edge off centre does not jump it under your hand. It cannot pass the opposite edge and it stays over the picture, and sliding is clamped as a whole so the window stops at the edge instead of shrinking against it. */
  private cropDrag(c: NonNullable<Editor['cropSt']>, p: Pt) {
    const f = c.from
    if (!f) return
    const a = this.doc.assets.find((q) => q.id === c.id)
    if (!a) return
    const c4 = this.assetCorners(a)
    const bx0 = Math.min(...c4.map((q) => q[0]))
    const by0 = Math.min(...c4.map((q) => q[1]))
    const bx1 = Math.max(...c4.map((q) => q[0]))
    const by1 = Math.max(...c4.map((q) => q[1]))
    const dx = p[0] - f.px
    const dy = p[1] - f.py
    // a pixel of the picture, in painting pixels, as the smallest box worth
    // keeping. Below this a crop returns nothing anybody can see.
    const min = Math.max(1, (bx1 - bx0) / Math.max(1, this.assetNat(a).w))
    let { x0, y0, x1, y1 } = f
    if (c.grip === 'move') {
      const w = x1 - x0
      const h = y1 - y0
      x0 = clamp(x0 + dx, bx0, bx1 - w)
      y0 = clamp(y0 + dy, by0, by1 - h)
      x1 = x0 + w
      y1 = y0 + h
    } else {
      if (c.grip.includes('w')) x0 = clamp(x0 + dx, bx0, x1 - min)
      if (c.grip.includes('e')) x1 = clamp(x1 + dx, x0 + min, bx1)
      if (c.grip.includes('n')) y0 = clamp(y0 + dy, by0, y1 - min)
      if (c.grip.includes('s')) y1 = clamp(y1 + dy, y0 + min, by1)
    }
    c.a = [x0, y0]
    c.b = [x1, y1]
  }

  private cropPt(e: PointerEvent): Pt {
    const [x, y] = this.toNativeF(e)
    return [clamp(x, 0, this.doc.W), clamp(y, 0, this.doc.H)]
  }
  /* Box an area of the PAINTING, not a sprite. Same drag, same overlay, same enter and escape as the crop, because it is the same gesture and a second one would be a second thing to learn. The only difference is what comes back, and the empty id is what says which. */
  markArea(cb: (r: { x: number; y: number; w: number; h: number } | null) => void): boolean {
    this.selAsset = ''
    this.cropSt = { id: '', a: null, b: null, dragging: false, grip: '', from: null, cb }
    this.placing = null
    this.dragAsset = null
    this.cancelPick()
    const act = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
    if (act && typeof act.blur === 'function') act.blur()
    this.dirty = true
    this.emit()
    this.say('drag a box round where it goes · enter takes it · esc skips')
    return true
  }
  /* CROP, AND IT IS ITS OWN GESTURE, not the area gesture wearing a different label. It opens round the whole picture and you take it in by dragging the box's edges, which is what every slide editor does; asking for a box dragged out of nothing over a sprite a dozen pixels across is the version that cannot be done. The handles look like resize handles and are not: the picture never changes size, the window over it does. Marking an AREA starts empty, which is what keeps the two from being confusable. */
  startCrop(cb: (r: { x: number; y: number; w: number; h: number } | null) => void): boolean {
    const a = this.doc.assets.find((q) => q.id === this.selAsset)
    if (!a) {
      this.say('click an asset first')
      return false
    }
    // the whole picture, in painting pixels, as the box to start from. Its own
    // corners rather than the drawn bounding box, so a turned or flipped
    // placement opens square on its art instead of on the box around it.
    const c4 = this.assetCorners(a)
    const xs = c4.map((q) => q[0])
    const ys = c4.map((q) => q[1])
    this.cropSt = {
      id: a.id,
      a: [Math.min(...xs), Math.min(...ys)],
      b: [Math.max(...xs), Math.max(...ys)],
      dragging: false,
      grip: '',
      from: null,
      cb,
    }
    this.placing = null
    this.dragAsset = null
    // an armed generate or effect click would eat the drag before it started
    this.cancelPick()
    // the button that started this keeps focus otherwise, and then enter
    // re-presses it (which by now reads "cancel crop") instead of taking the
    // rectangle: the crop looked broken because it cancelled itself
    const act = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
    if (act && typeof act.blur === 'function') act.blur()
    this.dirty = true
    this.emit()
    this.say('drag the edges to take it in · enter crops · esc cancels')
    return true
  }
  cancelCrop() {
    const c = this.cropSt
    if (!c) return
    if (this.canvas) this.canvas.style.cursor = ''
    this.cropSt = null
    this.dirty = true
    this.emit()
    c.cb(null)
  }
  commitCrop() {
    const c = this.cropSt
    if (!c) return
    // an area box belongs to the painting, so it needs none of the placement
    // transform maths below: the drag is already in painting pixels
    if (!c.id) {
      if (!c.a || !c.b) {
        this.say('drag a box first, or esc to skip it')
        return
      }
      const ax = clamp(Math.round(Math.min(c.a[0], c.b[0])), 0, this.doc.W)
      const ay = clamp(Math.round(Math.min(c.a[1], c.b[1])), 0, this.doc.H)
      const bx = clamp(Math.round(Math.max(c.a[0], c.b[0])), 0, this.doc.W)
      const by = clamp(Math.round(Math.max(c.a[1], c.b[1])), 0, this.doc.H)
      if (bx - ax < 8 || by - ay < 8) {
        this.say('that box is too small to read')
        return
      }
      this.cropSt = null
      this.dirty = true
      this.emit()
      c.cb({ x: ax, y: ay, w: bx - ax, h: by - ay })
      return
    }
    const a = this.doc.assets.find((q) => q.id === c.id)
    if (!a || !c.a || !c.b) {
      this.say('drag the edges in first')
      return
    }
    const { w, h } = this.assetNat(a)
    const x0 = Math.min(c.a[0], c.b[0])
    const x1 = Math.max(c.a[0], c.b[0])
    const y0 = Math.min(c.a[1], c.b[1])
    const y1 = Math.max(c.a[1], c.b[1])
    let lx0 = Infinity
    let lx1 = -Infinity
    let ly0 = Infinity
    let ly1 = -Infinity
    for (const [px, py] of [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ] as Pt[]) {
      const [lx, ly] = this.assetLocal(a, px, py)
      lx0 = Math.min(lx0, lx)
      lx1 = Math.max(lx1, lx)
      ly0 = Math.min(ly0, ly)
      ly1 = Math.max(ly1, ly)
    }
    // local space has the feet anchor at the origin: x in [-w/2, w/2], y in
    // [-h, 0]. The png's own pixels are that shifted back to its corner.
    const ix0 = clamp(Math.round(lx0 + w / 2), 0, w)
    const ix1 = clamp(Math.round(lx1 + w / 2), 0, w)
    const iy0 = clamp(Math.round(ly0 + h), 0, h)
    const iy1 = clamp(Math.round(ly1 + h), 0, h)
    const rw = ix1 - ix0
    const rh = iy1 - iy0
    if (rw < 1 || rh < 1) {
      this.say('that leaves nothing of it')
      return
    }
    /* The box opens round the whole picture, so pressing enter without touching it asks to crop a thing to its own size: every placement re-anchored, the png rewritten, not one pixel different. It says so and closes instead. */
    if (ix0 === 0 && iy0 === 0 && rw === w && rh === h) {
      this.canvas && (this.canvas.style.cursor = '')
      this.cropSt = null
      this.dirty = true
      this.emit()
      this.say('nothing taken off, so nothing to crop')
      c.cb(null)
      return
    }
    if (this.canvas) this.canvas.style.cursor = ''
    this.cropSt = null
    this.dirty = true
    this.emit()
    c.cb({ x: ix0, y: iy0, w: rw, h: rh })
  }
  // where the feet anchor has to move so a crop does not jump: the new png's
  // bottom-centre, expressed in the OLD png's local space, put back through
  // the placement's transform
  cropAnchor(id: string, r: { x: number; y: number; w: number; h: number }): { x: number; y: number } | null {
    const a = this.doc.assets.find((q) => q.id === id)
    if (!a) return null
    const { w, h } = this.assetNat(a)
    // the placement's own frame, not the drawn one: this answer BECOMES the
    // anchor, so folding in how far a behaviour has wandered would bake the
    // wander into it and shift the thing for good
    const [px, py] = this.assetPt(a, r.x + r.w / 2 - w / 2, r.y + r.h - h, false)
    return { x: Math.round(px), y: Math.round(py) }
  }
  // a propose lands as one batch: one snapshot, one z takes it all back
  addPlacements(list: { item: LibItem; x: number; y: number; scale: number; group: string }[]): number {
    const valid = list.filter((q) => this.doc.inB(Math.round(q.x), Math.round(q.y)))
    if (!valid.length) return 0
    this.doc.snap()
    for (const q of valid) {
      const s = clamp(q.scale > 0 ? q.scale : defaultScale(q.item), 0.02, 8)
      const a: PlacedAsset = {
        id: 'a' + this.doc.assetNext++,
        group: q.group,
        kind: q.item.kind,
        x: Math.round(q.x),
        y: Math.round(q.y),
        scale: s,
        sx: s,
        sy: s,
        rot: 0,
        fx: false,
        fy: false,
      }
      if (q.item.kind === 'animated') {
        a.frames = q.item.frames ? q.item.frames.slice() : []
        a.fps = q.item.fps || 8
      } else {
        a.src = q.item.src
      }
      if (q.item.dirs && Object.keys(q.item.dirs).length) a.dirs = { ...q.item.dirs }
      this.doc.assets.push(a)
      this.hiddenGroups.delete(a.group)
    }
    this.touched()
    return valid.length
  }
  // the image cache: urls load once, a finished load repaints, a failure
  // falls back to the placeholder box so a placement can never be invisible
  private assetImg(url: string): HTMLImageElement | null {
    if (!url) return null
    let e = this.assetCache.get(url)
    if (!e) {
      const img = new Image()
      const entry = { img, ok: false, failed: false }
      img.onload = () => {
        entry.ok = true
        this.dirty = true
      }
      img.onerror = () => {
        entry.failed = true
      }
      const tag = this.bustTag.get(url)
      img.src = tag ? url + (url.includes('?') ? '&' : '?') + 't=' + tag : url
      this.assetCache.set(url, entry)
      e = entry
    }
    return e.ok ? e.img : null
  }
  /* art is which appearance to draw: 0 is the placement's own pictures. Everything below reads the look rather than the placement, so a thing that never changes takes the same path it always did. moving is the GAIT gate and belongs to a view set alone: a walk cycle is what the legs do while travelling, but a fire burns and a flag flaps whether or not the thing goes anywhere, and the game runs those off the clock, so freezing them here made the preview lie about the bundle. */
  private assetFrame(a: PlacedAsset, now: number, facing?: string, art = 0, moving = true): HTMLImageElement | null {
    const L = lookOf(a, art)
    const gait = moving ? now : 0
    // a thing with views faces where it is walking; the nearest view it
    // actually has wins, so a four-view import still works
    if (facing && L.dirs) {
      const set = L.dirs[facing] || L.dirs[NEAREST_DIR[facing] || 'south'] || L.dirs.south
      if (set && set.length) {
        const i = set.length > 1 ? Math.floor(gait * (L.fps || 8)) % set.length : 0
        return this.assetImg(set[i])
      }
    }
    /* Standing still is not the same as holding one frame: someone breathing at a stall never travels, so nothing ever handed this a facing and the loop sat on frame zero forever. The heading it rests in is whichever its own src belongs to. */
    if (!facing && L.dirs) {
      const rest = Object.keys(L.dirs).find((k) => L.dirs![k].includes(L.src || '')) || 'south'
      const set = L.dirs[rest] || L.dirs.south
      if (set && set.length) {
        const i = set.length > 1 ? Math.floor(gait * (L.fps || 8)) % set.length : 0
        return this.assetImg(set[i])
      }
    }
    if (L.kind === 'animated' && L.frames && L.frames.length) {
      const i = Math.floor(now * (L.fps || 8)) % L.frames.length
      return this.assetImg(L.frames[i])
    }
    return L.src ? this.assetImg(L.src) : null
  }

  // the workflow steps own the view: entering a step announces its default
  // view instead of leaving a toggle behind that could hide a result
  setView(v: { cutPreview?: boolean; mask?: boolean }) {
    if (v.cutPreview !== undefined) this.showCutPreview = v.cutPreview
    if (v.mask !== undefined) this.showMask = v.mask
    this.dirtyMask = true
    this.dirty = true
    this.emit()
  }
  // every cut-fill click a human would make along the border and the transparent edge, made at once, under one snapshot. FIXED tolerance and never the slider: at a raised manual tolerance the margin floods walked from sea navy into island rock and proposed half the island.
  autoSea() {
    if (!this.pix || !this.painting) return
    this.doc.snap()
    const n = this.doc.autoSea(40, this.pix)
    this.touched()
    this.say(`cut ${n}px of sea · correct it`)
  }
  // one landmass rule: every 4-way component of uncut opaque pixels except
  // the largest joins the cut. One snapshot, one undo.
  despeckle() {
    if (!this.pix || !this.painting) return
    this.doc.snap()
    const r = this.doc.despeckle(this.pix)
    if (!r.specks) {
      // nothing changed, so drop the identical snapshot and keep z meaningful
      this.doc.undo()
      this.say('no specks to remove')
      return
    }
    this.touched()
    this.say(`cut ${r.px}px in ${r.specks} specks`)
  }
  // one dilation ring per press: the anti-aliased coast fringe is a single
  // pixel of blended tone, so each press eats exactly one ring and one undo
  // gives exactly one ring back.
  shaveEdge() {
    if (!this.pix || !this.painting) return
    this.doc.snap()
    const n = this.doc.shaveEdge(this.pix)
    this.touched()
    this.say(`shaved ${n} px off the edge`)
  }
  toggleCutPreview() {
    this.showCutPreview = !this.showCutPreview
    this.dirty = true
    this.say(this.showCutPreview ? 'cut result over checkerboard' : 'art with the cut hatch')
  }
  // After a propose the result must actually be on screen: the cut preview replaces the whole draw with the cut-applied painting, and m can have hidden the levels overlay. Returns true when something had to be flipped.
  revealLevels(): boolean {
    let changed = false
    if (this.showCutPreview) {
      this.showCutPreview = false
      changed = true
    }
    if (!this.showMask) {
      this.showMask = true
      changed = true
    }
    if (changed) {
      this.dirtyMask = true
      this.dirty = true
      this.emit()
    }
    return changed
  }
  // the walker never starts inside a wall: mask edits can move blocked ground under a
  // stale spawn, so the start point spirals out to the nearest standable pixel, by
  // the same validated-spawn law the game's scene applies on load
  private groundNear(p: [number, number]): [number, number] {
    if (canStand(this.doc, this.cfg, p[0], p[1])) return p
    for (let r = 4; r <= 400; r += 4)
      for (let a = 0; a < 16; a++) {
        const x = Math.round(p[0] + Math.cos((a / 16) * 6.283) * r)
        const y = Math.round(p[1] + Math.sin((a / 16) * 6.283) * r)
        if (canStand(this.doc, this.cfg, x, y)) return [x, y]
      }
    return p
  }
  toggleWalk() {
    this.walking = !this.walking
    if (this.walking) {
      this.walker = new Walker(this.groundNear(this.doc.spawn))
      this.plates = null
    }
    this.dirty = true
    this.emit()
  }
  setSpawnHere() {
    if (this.walking) this.doc.spawn = [Math.round(this.walker.x), Math.round(this.walker.y)]
    else if (this.cursor) this.doc.spawn = [this.cursor[0], this.cursor[1]]
    this.dirty = true
    // the autosave, or a refresh eats the spawn: setting it is usually the
    // LAST act before an export, so nothing after it would ever save
    this.touched()
    this.say(`spawn ${this.doc.spawn[0]}, ${this.doc.spawn[1]}`)
  }
  // ---- events: a spot on the map plus an action. The drop is one undo and the delete is one undo; the form edits between them mutate in place and ride whatever snapshot comes next, so typing a label never floods the history.
  /* THE OVERLAY IS ON EVERYWHERE AND IT IS THE AUTHOR'S SWITCH, not the workflow's. Gated on the step it goes invisible exactly where it matters most, the step where art gets placed: a post's zone is the side of a table you can reach, and the table is the thing being dragged. No step writes it, so an author who turns it off keeps it off until they say otherwise. */
  eventsVisible = true
  setEventsVisible(on: boolean) {
    if (this.eventsVisible === on) return
    this.eventsVisible = on
    this.dirty = true
    this.emit()
  }
  toggleEvents() {
    this.setEventsVisible(!this.eventsVisible)
    this.say(this.eventsVisible ? 'anchors shown' : 'anchors hidden · a shows them')
  }

  /* MAY A CLICK GRAB AN ANCHOR, a different question from whether one is drawn, and separating the two is what makes the always-on overlay safe: the anchor drag and the drawn-corner drag both run before the asset step gets the pointer, so every click near a post would grab the post instead of the art. */
  eventsEditable = false
  setEventsEditable(on: boolean) {
    if (this.eventsEditable === on) return
    this.eventsEditable = on
    this.dirty = true
  }
  /* MAY THIS ONE ANCHOR ANSWER A PRESS RIGHT NOW, narrower than the flag above and the whole of what makes editing safe off the test step. Everywhere but test and export anchors are scenery, or a click near a post grabs the post instead of the art under it. The exception is the one anchor the author has selected: placing art against a zone you cannot nudge means leaving the step to fix a thing you are looking straight at. */
  anchorLive(ev: MapEvent): boolean {
    return this.eventsEditable || (this.eventsVisible && ev.id === this.anchorSel)
  }
  /* WHICH ANCHOR THE PANEL HAS OPEN, so the overlay can draw that one brighter.
   * The same shape as pathSel and framingSel and for the same reason: which row
   * is open is React's business, which mark is drawn loud is this file's. */
  anchorSel = 0
  selectAnchor(id: number) {
    if (this.anchorSel === id) return
    this.anchorSel = id
    this.dirty = true
    this.emit()
  }

  /* May this screen paint at all? The workflow sets it per step, so cut and
   * levels paint and load, test and export cannot. Default true, so a caller
   * that opens the editor for one purpose and never sets it can still paint. */
  paintable = true
  setPaintable(on: boolean) {
    if (this.paintable === on) return
    this.paintable = on
    this.dirty = true
    this.emit()
  }

  /* the door being dragged right now, and where inside its ring it was held */
  private dragEvent: { id: number; dx: number; dy: number } | null = null
  /* the corner of a drawn area being dragged, by the anchor it belongs to and
   * its index in that anchor's points. An index rather than the point itself,
   * because the array is rewritten by updateEvent on every move */
  private dragVert: { id: number; i: number; dx: number; dy: number } | null = null
  private dragRing: { id: number; dx: number; dy: number } | null = null

  /* THE ROUTE BEING LAID, and null the rest of the time. Here rather than in React for the reason this.poly is: every click drops a waypoint and a state update per click would put a render pass between the press and the pixel. */
  private newPath: Pt[] | null = null
  /* THE REGION BEING DRAWN, here rather than in React because the pointer is sampled on every move and a state update per sample would put a render pass between the hand and the line. IT IS A FREEHAND DRAG, NOT A CORNER PER CLICK: walking a pier corner by corner was slow enough to be the first thing said about the feature, and a coastline is a curve no reasonable number of clicks describes. `drawing` splits the two halves of the gesture, and escape in either leaves whatever was stored alone. */
  private newPoly: { id: number; pts: Pt[]; drawing: boolean } | null = null
  pathSel = 0
  framingSel = 0
  anchorSetSel = 0
  rackSel = 0
  variantSel = 0

  /* Is there anywhere inside this ring a player could actually stand? The same test the game applies, so the answer here is the answer there. One standable pixel is enough: the ring is a trigger, not a floor. */
  ringHasGround(cx: number, cy: number, r: number) {
    const rad = Math.max(1, Math.round(r))
    /* HELD TO THE CANVAS, because the radius ceiling is 512 now and a ring that
     * size is a million pixel tests run on every anchor drop. Nothing outside
     * the painting can be stood on anyway, so the clamp costs no answers. */
    const y0 = Math.max(0, cy - rad)
    const y1 = Math.min(this.doc.H - 1, cy + rad)
    const x0 = Math.max(0, cx - rad)
    const x1 = Math.min(this.doc.W - 1, cx + rad)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > rad * rad) continue
        if (canStand(this.doc, this.cfg, x, y)) return true
      }
    return false
  }
  /* A name nobody in this map has used. The suffix walk matches the one the
   * library uses for a filename, so two anchors named the same way read the way
   * two assets named the same way already do. */
  freeAnchorName(want: string, exceptId = 0): string {
    const base = anchorName(want)
    const taken = new Set(this.doc.events.filter((e) => e.id !== exceptId).map((e) => e.name))
    if (!taken.has(base)) return base
    for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
  }

  addAnchor(kind: AnchorKind, x: number, y: number): number {
    this.doc.snap()
    const id = this.doc.eventNext++
    const e = migrateAnchor({
      id,
      name: this.freeAnchorName(`${kind}_${id}`),
      kind,
      x,
      y,
      r: kind === 'door' ? 14 : 12,
      label: '',
      to: '',
    }, this.doc.walk.charH)
    this.doc.events.push(e)
    this.touched()
    this.say(`${kind} at ${e.x}, ${e.y} · give it a name code can use`)
    return e.id
  }

  addDoor(x: number, y: number): number {
    return this.addAnchor('door', x, y)
  }

  /* Renaming is the one edit that can break something outside this tool, so it is the one edit that refuses. An illegal name is rejected rather than silently corrected, because a name quietly changed under an author is worse than one they have to fix. A collision gets suffixed. */
  renameAnchor(id: number, want: string): { ok: boolean; name?: string; why?: string } {
    const e = this.doc.events.find((q) => q.id === id)
    if (!e) return { ok: false, why: 'gone' }
    const trimmed = String(want || '').trim()
    if (!trimmed) return { ok: false, why: 'a name is required · code addresses this' }
    const clean = anchorName(trimmed)
    if (!isAnchorName(clean)) return { ok: false, why: 'letters, digits and underscores, starting with a letter' }
    const free = this.freeAnchorName(clean, id)
    /* EVERY COLLECTION THAT NAMES THIS ANCHOR COMES WITH IT, or renaming stele_2 drops it out of `steles` and leaves a rack slot pointing at nothing, which surfaces at publish or never. A delete deliberately does NOT: the name stays in the set and the publish gate says which one is missing, because deleting an anchor a set is built on is a thing an author should be told about. */
    const was = e.name
    for (const s of this.doc.sets) s.members = s.members.map((m) => (m === was ? free : m))
    for (const r of this.doc.racks) for (const sl of r.slots) if (sl.anchor === was) sl.anchor = free
    e.name = free
    // an author has now chosen it, so it is no longer a guess derived from a label
    if (e.meta?.derived) {
      const { derived: _drop, ...rest } = e.meta
      e.meta = Object.keys(rest).length ? rest : undefined
    }
    this.touched()
    return { ok: true, name: free, why: free !== clean ? `taken · saved as ${free}` : undefined }
  }

  /* One typed edit to one anchor. null clears a field that is allowed to be
   * absent, which undefined cannot mean here: undefined is "this patch does not
   * mention it" and both callers need to say the other thing. */
  updateEvent(
    id: number,
    patch: Partial<Pick<MapAnchor, 'label' | 'to' | 'r' | 'toAnchor' | 'kind' | 'facing' | 'placement'>> & {
      stand?: [number, number] | null
      rect?: [number, number, number, number] | null
      poly?: [number, number][] | null
      ring?: [number, number] | null
      shape?: AnchorShape
    },
  ) {
    const e = this.doc.events.find((q) => q.id === id)
    if (!e) return
    /* HELD TO TWO BODIES OF ITS OWN ANCHOR, and pulled in rather than refused:
     * the author clicked a pixel, so the nearest legal one is the answer they
     * meant, and a press that appears to do nothing is worse. */
    if (patch.stand !== undefined) {
      if (patch.stand) {
        const at = clampStand(e.x, e.y, patch.stand, this.doc.walk.charH)
        if (at[0] !== Math.round(patch.stand[0]) || at[1] !== Math.round(patch.stand[1]))
          this.say(`${e.name} · a stand point is at most ${standReach(this.doc.walk.charH)}px from its anchor · pulled in`)
        e.stand = at
      } else delete e.stand
    }
    /* THE THREE SHAPES A REGION CAN BE ARE EXCLUSIVE, AND THAT IS THE MODE'S JOB RATHER THAN DELETION'S. If writing a rect deletes the poly, an author who drew an area and touched the circle button loses the drawing outright, with no way back once the map has saved. */
    if (patch.shape !== undefined) e.shape = patch.shape
    if (patch.rect !== undefined) {
      if (patch.rect) e.rect = patch.rect.map((n) => Math.round(n)) as [number, number, number, number]
      else delete e.rect
    }
    if (patch.ring !== undefined) {
      if (patch.ring) e.ring = [Math.round(patch.ring[0]), Math.round(patch.ring[1])]
      else delete e.ring
    }
    if (patch.poly !== undefined) {
      // fewer than three points is a line, and a line has no inside, so it is
      // refused here rather than stored and left to fire for nobody
      if (patch.poly && patch.poly.length >= 3)
        e.poly = patch.poly.map(([x, y]) => [Math.round(x), Math.round(y)] as [number, number])
      else delete e.poly
    }
    if (patch.label !== undefined) e.label = patch.label
    if (patch.to !== undefined) e.to = patch.to
    if (patch.r !== undefined) e.r = Math.max(ANCHOR_R_MIN, Math.min(ANCHOR_R_MAX, Math.round(patch.r)))
    if (patch.kind !== undefined) e.kind = patch.kind
    if (patch.toAnchor !== undefined) {
      if (patch.toAnchor) e.toAnchor = patch.toAnchor
      else delete e.toAnchor
    }
    if (patch.facing !== undefined) {
      if (patch.facing) e.facing = patch.facing
      else delete e.facing
    }
    if (patch.placement !== undefined) {
      if (patch.placement) e.placement = patch.placement
      else delete e.placement
    }
    /* THE MODE IS FOLDED INTO THE BAG THE MOMENT IT CHANGES, the way setAnchorWhen folds a condition: the bag is what crosses the anchors table and both exporters, and it is otherwise only rebuilt on load or save, so an export in the same session would carry the shape the author had just left. */
    if (
      patch.shape !== undefined ||
      patch.rect !== undefined ||
      patch.poly !== undefined ||
      patch.ring !== undefined ||
      patch.kind !== undefined
    )
      migrateAnchor(e, this.doc.walk.charH)
    this.touched()
  }
  updateAnchor = this.updateEvent.bind(this)

  /* ---- a region you draw. A circle and a box were the only two shapes a named place could be, and the hub's waterfront is neither: a box takes in half the water, a circle takes in the volcano. The points land on the anchor as `poly`, and what SHIPS is the points and their bounding box together, because the running game tests a region by its box and has no polygon test yet. */
  drawRegion(id: number) {
    if (!this.doc.events.some((q) => q.id === id)) return
    this.newPoly = { id, pts: [], drawing: false }
    this.dirty = true
    this.say('draw round the area · let go to close it · enter saves it')
    this.emit()
  }
  cancelRegionDraw() {
    if (!this.newPoly) return
    this.newPoly = null
    this.dirty = true
    this.emit()
  }

  /* THE TOLERANCE THE FREEHAND PATH IS SIMPLIFIED AT: about one screen pixel at the zoom the author is drawing at, which is the smallest error they could see. The floor stops a very deep zoom turning the tolerance into nothing. Without it a two second drag is several hundred points, each of which goes into the document, the anchors table, both exporters and the bundle, and gets drawn as a draggable handle. */
  private polyTol() {
    return Math.max(0.5, 1 / Math.max(0.05, this.z))
  }

  /* THE RELEASE: simplified, closed and left on screen as a filled highlight so the author sees what they marked before anything is written. A DOT IS NOT A SHAPE, and storing one would give the map a named place no player can ever be inside with nothing saying why, so it is dropped and the gesture stays armed. */
  private closeRegionDrag() {
    const d = this.newPoly
    if (!d) return
    d.drawing = false
    const span = polyBounds(d.pts.length ? (d.pts as [number, number][]) : [[0, 0]])
    const travel = Math.max(span[2] - span[0], span[3] - span[1])
    const pts = simplifyPoly(d.pts as [number, number][], this.polyTol())
    if (pts.length < 3 || travel < 4) {
      d.pts = []
      this.dirty = true
      this.say('that was a dot · press and drag round the area')
      this.emit()
      return
    }
    d.pts = pts
    this.dirty = true
    this.say(`${pts.length} points · enter saves it · esc drops it · draw again to redo it`)
    this.emit()
  }

  finishRegionDraw() {
    const drawn = this.newPoly
    if (!drawn) return
    /* Enter with nothing drawn yet leaves the gesture armed rather than closing
     * it. The author has pressed draw and has not drawn: dropping them out of
     * the mode would read as the key having done something wrong. */
    if (drawn.pts.length < 3) {
      this.say('nothing drawn yet · press and drag round the area')
      this.emit()
      return
    }
    this.newPoly = null
    this.doc.snap()
    this.updateEvent(drawn.id, {
      poly: drawn.pts.map(([x, y]) => [x, y] as [number, number]),
      shape: 'poly',
    })
    const e = this.doc.events.find((q) => q.id === drawn.id)
    this.dirty = true
    this.say(`${e ? displayName(e).text : 'the area'} is ${drawn.pts.length} points`)
  }

  /* THE PLACEMENT A REFERENCE POINTS AT, resolved the way the game resolves it: the author's name first, then the machine id. One function, so the editor, the export and the reader cannot disagree about which object a string means. */
  placementRef(ref: string | undefined | null): PlacedAsset | undefined {
    if (!ref) return undefined
    return this.doc.assets.find((a) => a.name === ref) || this.doc.assets.find((a) => a.id === ref)
  }

  /* Bind an anchor to a placement so it moves with it, which is what "a name survives editing" has to mean: coach_post is where the coach stands, and dragging the coach should take the post along. THE NAME IS WRITTEN WHEN THERE IS ONE and the id only when there is not, because an id is a counter that does not survive a delete and re-place. */
  /* THE ONE PLACE AN ANCHOR MOVES, so the stand point can only be left behind in one place and it is not left behind here. Three callers move an anchor: a drag, a binding, and a bound anchor following the thing it is on. */
  private moveAnchor(e: MapAnchor, x: number, y: number) {
    if (e.x === x && e.y === y) return false
    if (e.stand) e.stand = [e.stand[0] + x - e.x, e.stand[1] + y - e.y]
    e.x = x
    e.y = y
    return true
  }

  bindAnchor(id: number, ref: string | null) {
    const e = this.doc.events.find((q) => q.id === id)
    if (!e) return
    if (ref) {
      const a = this.placementRef(ref)
      if (!a) return
      const key = a.name || a.id
      if (e.placement === key) return
      this.doc.snap()
      e.placement = key
      this.moveAnchor(e, Math.round(a.x), Math.round(a.y))
      this.say(`${e.name} follows ${key} now`)
    } else {
      if (!e.placement) return
      this.doc.snap()
      delete e.placement
      this.say(`${e.name} holds still`)
    }
    this.touched()
  }

  /* Every bound anchor pulled back onto the thing it follows, ONTO THE HOME POSITION and never onto where a wander has got to: a moving placement's spot is a function of the clock, so writing the live one would put whatever pixel the export happened to catch into the bundle and a second export of an unchanged map would write a different number. */
  syncBoundAnchors() {
    let moved = 0
    for (const e of this.doc.events) {
      if (!e.placement) continue
      const a = this.placementRef(e.placement)
      if (!a) continue
      if (this.moveAnchor(e, Math.round(a.x), Math.round(a.y))) moved++
    }
    return moved
  }

  /* WHERE A PLACEMENT IS BEING DRAWN RIGHT NOW, rebuilt every frame in drawAssets and keyed by placement id. An empty map means the preview is paused, and then the honest answer is where the thing was put. Read-only: nothing here is written back into the document. */
  lifeSpot(a: PlacedAsset): { x: number; y: number } {
    const at = this.liveAt.get(a.id)
    return at ? { x: a.x + at.dx, y: a.y + at.dy } : { x: a.x, y: a.y }
  }

  deleteEvent(id: number) {
    const i = this.doc.events.findIndex((q) => q.id === id)
    if (i < 0) return
    this.doc.snap()
    const [e] = this.doc.events.splice(i, 1)
    this.touched()
    this.say(`removed ${e.name || e.label || 'anchor'} · z undoes`)
  }

  // ---- routes: a named polyline -----------------------------------------
  /* Every anchor is one pixel, so the only route this tool could describe was a straight line between two, and every real one was hand-typed as numbers in the other repo. Routes, shots and anchors each keep their own name tally, because the bundle ships them as three arrays keyed by name. Z DOES NOT BRING A ROUTE OR A SHOT BACK: MaskDoc.snap was written before either list existed and has nothing of them to restore. snap is still called so the stack stays in step, and the guard on a delete is the two-click confirm. */
  freePathName(want: string, exceptId = 0): string {
    const base = anchorName(want)
    const taken = new Set(this.doc.paths.filter((p) => p.id !== exceptId).map((p) => p.name))
    if (!taken.has(base)) return base
    for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
  }

  /* Arm the line. From here every map click drops a waypoint, enter or a double click keeps what is down, esc or a right-click throws it away. Pressing this while a line is open cancels, the way every armed thing here behaves. */
  armPath() {
    if (this.newPath) {
      this.cancelPath()
      return
    }
    this.newPath = []
    this.pathSel = 0
    this.dirty = true
    this.say('click the map to lay the line · enter keeps it · esc drops it')
    this.emit()
  }

  cancelPath() {
    if (!this.newPath) return
    this.newPath = null
    this.dirty = true
    this.say('line dropped · nothing saved')
    this.emit()
  }

  /* Two points is the least that means anything, and it is migratePath's rule
   * rather than a second one invented here: a one-point line has no direction,
   * so nothing downstream could walk it or point a camera along it. */
  finishPath(): number {
    const pts = this.newPath
    if (!pts) return 0
    this.newPath = null
    if (pts.length < 2) {
      this.dirty = true
      this.say('a line needs two points · nothing saved')
      this.emit()
      return 0
    }
    return this.addPath(pts)
  }

  addPath(points: [number, number][]): number {
    if (!points || points.length < 2) {
      this.say('a line needs two points · nothing saved')
      return 0
    }
    this.doc.snap()
    const id = this.doc.pathNext
    const p = migratePath({
      id,
      name: this.freePathName(`path_${id}`),
      kind: 'walk',
      points,
      closed: false,
      twoWay: false,
    })
    // migratePath drops anything it cannot make a line of, which is the same
    // gate a reopened save goes through, so nothing can enter the document
    // here that would not survive being saved and read back
    if (!p) {
      this.say('those points are not a line · nothing saved')
      return 0
    }
    this.doc.pathNext = id + 1
    this.doc.paths.push(p)
    this.pathSel = id
    this.touched()
    this.say(`${p.name} · ${p.points.length} points · give it a name code can use`)
    return id
  }

  /* Renaming refuses rather than corrects, exactly as renameAnchor does and for
   * the same reason: this string is what a member writes in python, and a name
   * quietly changed under an author is worse than a name they have to fix. */
  renamePath(id: number, want: string): { ok: boolean; name?: string; why?: string } {
    const p = this.doc.paths.find((q) => q.id === id)
    if (!p) return { ok: false, why: 'gone' }
    const trimmed = String(want || '').trim()
    if (!trimmed) return { ok: false, why: 'a name is required · code addresses this' }
    const clean = anchorName(trimmed)
    if (!isAnchorName(clean)) return { ok: false, why: 'letters, digits and underscores, starting with a letter' }
    const free = this.freePathName(clean, id)
    p.name = free
    this.touched()
    return { ok: true, name: free, why: free !== clean ? `taken · saved as ${free}` : undefined }
  }

  /* One typed edit to one route. null clears a field that is allowed to be
   * absent, which undefined cannot mean here: undefined is "this patch does not
   * mention it", the same split updateEvent makes. */
  updatePath(
    id: number,
    patch: {
      points?: [number, number][]
      kind?: PathKind
      closed?: boolean
      twoWay?: boolean
      facing?: string | null
      marks?: PathMark[] | null
    },
  ) {
    const p = this.doc.paths.find((q) => q.id === id)
    if (!p) return
    if (patch.points !== undefined && patch.points.length >= 2)
      p.points = patch.points.map((q) => [Math.round(q[0]), Math.round(q[1])] as [number, number])
    if (patch.kind !== undefined) p.kind = patch.kind
    if (patch.closed !== undefined) p.closed = !!patch.closed
    if (patch.twoWay !== undefined) p.twoWay = !!patch.twoWay
    if (patch.facing !== undefined) {
      if (patch.facing) p.facing = patch.facing
      else delete p.facing
    }
    if (patch.marks !== undefined) {
      /* a mark past the end of the line is dropped rather than carried, because a beat waiting for waypoint nine on a six point path waits for ever. migratePath states the same rule on load, and shortening a line here has to apply it. */
      const clean = (patch.marks || [])
        .filter((m) => m && isAnchorName(m.name) && isFinite(Number(m.at)))
        .map((m) => ({
          at: Math.round(Number(m.at)),
          name: m.name,
          ...(m.label && String(m.label).trim() ? { label: String(m.label) } : {}),
        }))
        .filter((m) => m.at >= 0 && m.at < p.points.length)
      if (clean.length) p.marks = clean
      else delete p.marks
    }
    this.touched()
  }

  removePath(id: number) {
    const i = this.doc.paths.findIndex((q) => q.id === id)
    if (i < 0) return
    this.doc.snap()
    const [p] = this.doc.paths.splice(i, 1)
    if (this.pathSel === id) this.pathSel = 0
    this.touched()
    this.say(`removed the route ${p.name}`)
  }

  selectPath(id: number) {
    if (this.pathSel === id) return
    this.pathSel = id
    this.dirty = true
    this.emit()
  }

  /* WHICH LEGS OF A WALK ROUTE RUN OVER GROUND NOTHING CAN STAND ON. A waypoint is dropped wherever the pointer was with no ground test, so a route can be laid straight across the sea and still look correct on screen. Only a walk is asked, because a sail line crossing water is the point of a sail line. The probe is standsAt, the same one anchor reach and behaviour fencing use, since a checker that disagrees with the fence would redden ground the preview walks over. Bresenham rather than a fixed number of samples, because a three-sample leg steps clean over a six pixel gap in a jetty. */
  crossings(p: MapPath): number[] {
    if (p.kind !== 'walk') return []
    const bad: number[] = []
    legsOf(p).forEach(([a, b], i) => {
      let off = false
      bresenham(a[0], a[1], b[0], b[1], (x, y) => {
        if (!off && !this.standsAt(x, y)) off = true
      })
      if (off) bad.push(i)
    })
    return bad
  }

  /* A TIMING MARK: a name hung on a waypoint index, so a beat says "be at the doorway by the end of this line" instead of "walk for 2.4 seconds". A mark's name COERCES where a route's refuses, because a route is addressed from outside the map and a mark only from inside the route that owns it. */
  addPathMark(id: number, at = 0): number {
    const p = this.doc.paths.find((q) => q.id === id)
    if (!p) return -1
    const marks = [...(p.marks || [])]
    const taken = new Set(marks.map((m) => m.name))
    let name = `mark_${marks.length + 1}`
    for (let i = marks.length + 1; taken.has(name); i++) name = `mark_${i + 1}`
    marks.push({ at: clamp(Math.round(at), 0, p.points.length - 1), name })
    p.marks = marks
    this.touched()
    return marks.length - 1
  }

  updatePathMark(id: number, i: number, patch: { at?: number; name?: string; label?: string }) {
    const p = this.doc.paths.find((q) => q.id === id)
    if (!p || !p.marks || !p.marks[i]) return
    const m = p.marks[i]
    if (patch.at !== undefined) m.at = clamp(Math.round(patch.at), 0, p.points.length - 1)
    /* an empty label is REMOVED rather than stored as '', so displayName falls
     * back to unpacking the identifier instead of printing nothing at all when
     * an author clears the box */
    if (patch.label !== undefined) {
      if (patch.label.trim()) m.label = patch.label
      else delete m.label
    }
    if (patch.name !== undefined) {
      const clean = anchorName(patch.name)
      const taken = new Set(p.marks.filter((_, j) => j !== i).map((q) => q.name))
      let free = clean
      for (let n = 2; taken.has(free); n++) free = `${clean}_${n}`
      m.name = free
    }
    this.touched()
  }

  removePathMark(id: number, i: number) {
    const p = this.doc.paths.find((q) => q.id === id)
    if (!p || !p.marks || !p.marks[i]) return
    const marks = p.marks.filter((_, j) => j !== i)
    if (marks.length) p.marks = marks
    else delete p.marks
    this.touched()
  }

  // ---- shots: a named camera framing -------------------------------------
  freeFramingName(want: string, exceptId = 0): string {
    const base = anchorName(want)
    const taken = new Set(this.doc.framings.filter((f) => f.id !== exceptId).map((f) => f.name))
    if (!taken.has(base)) return base
    for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
  }

  /* THE PAINTING PIXEL IN THE MIDDLE OF THE SCREEN, which is what a saved shot
   * is a shot of. Answers the middle of the map when there is no canvas yet, so
   * a scripted call never puts NaN into a framing. */
  viewCentre(): Pt {
    const c = this.canvas
    if (!c) return [Math.round(this.doc.W / 2), Math.round(this.doc.H / 2)]
    return [
      Math.round((c.clientWidth / 2 - this.ox) / this.z),
      Math.round((c.clientHeight / 2 - this.oy) / this.z),
    ]
  }

  /* WHERE A SHOT IS POINTED, resolved the way the game will: the thing it hangs on plus the offset. An anchor bound to a placement answers where that placement is drawn right now, so a shot on the coach travels when he does. */
  framingSpot(f: MapFraming): { x: number; y: number } {
    const on = f.anchor ? this.doc.events.find((e) => e.name === f.anchor) : undefined
    if (!on) return { x: (f.x ?? 0) + f.dx, y: (f.y ?? 0) + f.dy }
    const home = on.placement ? this.placementRef(on.placement) : undefined
    const at = home ? this.lifeSpot(home) : { x: on.x, y: on.y }
    return { x: at.x + f.dx, y: at.y + f.dy }
  }

  /* SAVE THE VIEW AS A SHOT. No click to arm: pan and zoom until the screen shows what the shot should show, then press. IT HANGS OFF AN ANCHOR WHENEVER THERE IS ONE, because raw numbers re-break every time a painting is re-cut and every map gets re-cut. THE RATIO IS TAKEN NOW AND NEVER AT EXPORT: this.z is screen pixels per painting pixel and means nothing without the canvas it was measured against, which the server exporter does not have. */
  armFraming(anchor = ''): number {
    const [cx, cy] = this.viewCentre()
    const on = anchor ? this.doc.events.find((e) => e.name === anchor) : undefined
    const overFit = this.z / (this.fitNotch() || this.z || 1)
    return this.addFraming(
      on
        ? { anchor: on.name, dx: cx - on.x, dy: cy - on.y, zoom: this.z, overFit }
        : { x: cx, y: cy, dx: 0, dy: 0, zoom: this.z, overFit },
    )
  }

  addFraming(from: {
    anchor?: string
    x?: number
    y?: number
    dx?: number
    dy?: number
    zoom?: number
    overFit?: number
  }): number {
    /* the anchor is cleaned BEFORE the point is decided, or a caller handing
     * over an illegal name gets a shot with no anchor and no coordinates, and
     * migrateFraming quite rightly refuses it. */
    const anchor = from.anchor && isAnchorName(from.anchor) ? from.anchor : ''
    this.doc.snap()
    const id = this.doc.framingNext
    const f = migrateFraming({
      id,
      name: this.freeFramingName(`shot_${id}`),
      anchor,
      ...(anchor ? {} : { x: Math.round(from.x ?? 0), y: Math.round(from.y ?? 0) }),
      dx: Math.round(from.dx ?? 0),
      dy: Math.round(from.dy ?? 0),
      zoom: from.zoom ?? 1,
      overFit: from.overFit,
    } as MapFraming)
    // a shot that resolves to nowhere is refused on load, so it is refused here
    if (!f) {
      this.say('a shot needs an anchor or a point · nothing saved')
      return 0
    }
    this.doc.framingNext = id + 1
    this.doc.framings.push(f)
    this.framingSel = id
    this.touched()
    /* A POINT SHOT IS SAVED AND SAID OUT LOUD, not refused. The game's framing is an OFFSET from an anchor with no position of its own, so raw coordinates are unreadable there and the export skips them. It still works as a bookmark on a big painting, so the panel says what it is instead of quietly shipping nothing. */
    this.say(
      f.anchor
        ? `${f.name} · hung on ${f.anchor} · give it a name code can use`
        : `${f.name} · at ${f.x}, ${f.y} · the game reads shots off an anchor, so this one stays in the tool`,
    )
    return id
  }

  renameFraming(id: number, want: string): { ok: boolean; name?: string; why?: string } {
    const f = this.doc.framings.find((q) => q.id === id)
    if (!f) return { ok: false, why: 'gone' }
    const trimmed = String(want || '').trim()
    if (!trimmed) return { ok: false, why: 'a name is required · code addresses this' }
    const clean = anchorName(trimmed)
    if (!isAnchorName(clean)) return { ok: false, why: 'letters, digits and underscores, starting with a letter' }
    const free = this.freeFramingName(clean, id)
    f.name = free
    this.touched()
    return { ok: true, name: free, why: free !== clean ? `taken · saved as ${free}` : undefined }
  }

  updateFraming(
    id: number,
    patch: { anchor?: string | null; x?: number; y?: number; dx?: number; dy?: number; zoom?: number; entry?: boolean },
  ) {
    const f = this.doc.framings.find((q) => q.id === id)
    if (!f) return
    if (patch.anchor !== undefined) {
      const want = patch.anchor && isAnchorName(patch.anchor) ? patch.anchor : ''
      /* COMING OFF AN ANCHOR HAS TO LEAVE A POINT BEHIND: a framing with neither is dropped by migrateFraming on the next load, so clearing the anchor without writing x and y loses a shot by reopening the map. */
      if (!want && f.anchor) {
        const at = this.framingSpot(f)
        f.x = Math.round(at.x - f.dx)
        f.y = Math.round(at.y - f.dy)
      }
      f.anchor = want
      // and hanging it back on an anchor drops the stale numbers, or an export
      // would carry a point nobody can see next to the anchor that overrides it
      if (want) {
        delete f.x
        delete f.y
      }
    }
    if (patch.x !== undefined) f.x = Math.round(patch.x)
    if (patch.y !== undefined) f.y = Math.round(patch.y)
    if (patch.dx !== undefined) f.dx = Math.round(patch.dx)
    if (patch.dy !== undefined) f.dy = Math.round(patch.dy)
    /* ZOOM IS A REAL NUMBER and is clamped, never rounded: the pull-out shot cannot exist on the renderer's integer notches, and a renderer that cannot honour 1.4 is a defect at the renderer rather than a reason to throw the author's number away. */
    if (patch.zoom !== undefined && isFinite(patch.zoom)) {
      f.zoom = Math.min(16, Math.max(0.1, patch.zoom))
      /* and the crossing ratio moves with it, or the panel shows one camera and the bundle carries whichever was armed before. Only when there is a canvas to measure against: on a headless load the stored ratio is still the honest one. */
      const fit = this.fitNotch()
      if (fit) f.overFit = f.zoom / fit
    }
    if (patch.entry !== undefined) {
      if (patch.entry) {
        // at most one per map: a player arriving twice in one map is not a
        // thing, so turning one on turns the rest off rather than refusing
        for (const q of this.doc.framings) delete q.entry
        f.entry = true
      } else delete f.entry
    }
    this.touched()
  }

  removeFraming(id: number) {
    const i = this.doc.framings.findIndex((q) => q.id === id)
    if (i < 0) return
    this.doc.snap()
    const [f] = this.doc.framings.splice(i, 1)
    if (this.framingSel === id) this.framingSel = 0
    this.touched()
    this.say(`removed the shot ${f.name}`)
  }

  selectFraming(id: number) {
    if (this.framingSel === id) return
    this.framingSel = id
    this.dirty = true
    this.emit()
  }

  /* Put the editor's view where a saved shot is pointed, so a shot can be checked by looking rather than by reading four numbers. The zoom cannot be honoured exactly: setZoom rounds to the renderer's notches and the field does not, so this lands on the nearest and the panel keeps the authored number. */
  showFraming(id: number) {
    const f = this.doc.framings.find((q) => q.id === id)
    const c = this.canvas
    if (!f || !c) return
    const at = this.framingSpot(f)
    this.z = clamp(Math.round(f.zoom), 1, 8)
    this.ox = Math.round(c.clientWidth / 2 - at.x * this.z)
    this.oy = Math.round(c.clientHeight / 2 - at.y * this.z)
    this.framingSel = id
    this.dirty = true
    this.say(`${f.name} · ${at.x}, ${at.y} at ${f.zoom}x`)
  }

  // ---- sets and racks: anchors addressed several at a time -----------------
  /* A SET is `steles` meaning those five; a RACK is the same anchors given stable positions, where the third hook has to be the third hook every run. ONE TALLY ACROSS BOTH, unlike routes and shots: both are a named collection of this map's anchors and the obvious python for either is one call taking one name, so letting `steles` be both makes that call's answer depend on which lookup runs first. Z DOES NOT BRING EITHER BACK, exactly as it does not bring back a route: snap predates these lists. The guard on a delete is a two-click confirm. */
  freeCollectionName(want: string, exceptSet = 0, exceptRack = 0): string {
    const base = anchorName(want)
    const taken = new Set([
      ...this.doc.sets.filter((s) => s.id !== exceptSet).map((s) => s.name),
      ...this.doc.racks.filter((r) => r.id !== exceptRack).map((r) => r.name),
    ])
    if (!taken.has(base)) return base
    for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
  }

  /* WHICH OF THESE NAMES IS NOT AN ANCHOR ON THIS MAP. The publish gate asks the database the same question and refuses; this asks it while somebody is still looking at the screen. Duplicates collapse, so a rack with two hooks on one missing anchor says the name once. */
  missingIn(names: string[]): string[] {
    const have = new Set(this.doc.events.map((e) => e.name))
    const out: string[] = []
    for (const n of names) if (!have.has(n) && !out.includes(n)) out.push(n)
    return out
  }

  addSet(members: string[] = []): number {
    this.doc.snap()
    const id = this.doc.setNext
    const s = migrateAnchorSet({ id, name: this.freeCollectionName(`set_${id}`), members } as MapAnchorSet)
    if (!s) return 0
    this.doc.setNext = id + 1
    this.doc.sets.push(s)
    this.anchorSetSel = id
    this.touched()
    this.say(`${s.name} · ${s.members.length} anchors · give it a name code can use`)
    return id
  }

  /* Renaming refuses rather than corrects, the same as renameAnchor, renamePath
   * and renameFraming, and for the one reason all four share: this string is
   * what a member writes in python. */
  renameSet(id: number, want: string): { ok: boolean; name?: string; why?: string } {
    const s = this.doc.sets.find((q) => q.id === id)
    if (!s) return { ok: false, why: 'gone' }
    const trimmed = String(want || '').trim()
    if (!trimmed) return { ok: false, why: 'a name is required · code addresses this' }
    const clean = anchorName(trimmed)
    if (!isAnchorName(clean)) return { ok: false, why: 'letters, digits and underscores, starting with a letter' }
    const free = this.freeCollectionName(clean, id)
    s.name = free
    this.touched()
    return { ok: true, name: free, why: free !== clean ? `taken · saved as ${free}` : undefined }
  }

  /* One typed edit to one set. Members go through migrateAnchorSet's own filter
   * rather than a second copy of the rule here, so what a caller can put in is
   * exactly what survives being saved and read back. */
  updateSet(id: number, patch: { members?: string[]; label?: string | null; meta?: Record<string, unknown> | null }) {
    const i = this.doc.sets.findIndex((q) => q.id === id)
    if (i < 0) return
    const s = this.doc.sets[i]
    const next = migrateAnchorSet({
      ...s,
      ...(patch.members !== undefined ? { members: patch.members } : {}),
      ...(patch.label !== undefined ? { label: patch.label || '' } : {}),
      ...(patch.meta !== undefined ? { meta: patch.meta || undefined } : {}),
    } as MapAnchorSet)
    if (!next) return
    this.doc.sets[i] = next
    this.touched()
  }

  removeSet(id: number) {
    const i = this.doc.sets.findIndex((q) => q.id === id)
    if (i < 0) return
    this.doc.snap()
    const [s] = this.doc.sets.splice(i, 1)
    if (this.anchorSetSel === id) this.anchorSetSel = 0
    this.touched()
    this.say(`removed the set ${s.name}`)
  }

  selectSet(id: number) {
    if (this.anchorSetSel === id) return
    this.anchorSetSel = id
    this.dirty = true
    this.emit()
  }

  addRack(anchors: string[] = []): number {
    this.doc.snap()
    const id = this.doc.rackNext
    const r = migrateRack({
      id,
      name: this.freeCollectionName(`rack_${id}`),
      // the numbers start at one and follow the order they were handed over in,
      // which is the order they will fill in
      slots: anchors.map((a, i) => ({ slot: i + 1, anchor: a })),
      slotNext: anchors.length + 1,
    } as MapRack)
    if (!r) return 0
    this.doc.rackNext = id + 1
    this.doc.racks.push(r)
    this.rackSel = id
    this.touched()
    this.say(`${r.name} · ${r.slots.length} slots · give it a name code can use`)
    return id
  }

  renameRack(id: number, want: string): { ok: boolean; name?: string; why?: string } {
    const r = this.doc.racks.find((q) => q.id === id)
    if (!r) return { ok: false, why: 'gone' }
    const trimmed = String(want || '').trim()
    if (!trimmed) return { ok: false, why: 'a name is required · code addresses this' }
    const clean = anchorName(trimmed)
    if (!isAnchorName(clean)) return { ok: false, why: 'letters, digits and underscores, starting with a letter' }
    const free = this.freeCollectionName(clean, 0, id)
    r.name = free
    this.touched()
    return { ok: true, name: free, why: free !== clean ? `taken · saved as ${free}` : undefined }
  }

  /* A NEW SLOT TAKES THE NEXT NUMBER THIS RACK HAS NEVER HANDED OUT, which is the whole stability guarantee: slots.length + 1 would hand a fresh hook the number a deleted one answered to, so a save saying "slot 2 is filled" would light a different hook. */
  addRackSlot(id: number, anchor: string, label = ''): number {
    const r = this.doc.racks.find((q) => q.id === id)
    if (!r || !isAnchorName(anchor)) return 0
    const slot = r.slotNext
    r.slots.push({ slot, anchor, ...(label.trim() ? { label } : {}) })
    r.slotNext = slot + 1
    this.touched()
    return slot
  }

  updateRackSlot(id: number, slot: number, patch: { anchor?: string; label?: string | null }) {
    const r = this.doc.racks.find((q) => q.id === id)
    const s = r?.slots.find((q) => q.slot === slot)
    if (!r || !s) return
    // the anchor under a slot can be moved; the number over it never changes,
    // because that number is what a save and a member's python are both holding
    if (patch.anchor !== undefined && isAnchorName(patch.anchor)) s.anchor = patch.anchor
    if (patch.label !== undefined) {
      if (patch.label && patch.label.trim()) s.label = patch.label
      else delete s.label
    }
    this.touched()
  }

  /* THE NUMBER IS RETIRED WITH THE SLOT. A rack of five that loses its second hook is 1, 3, 4, 5, and the next added is 6. Anything else and every trophy after the deleted one hangs somewhere else the next time the map is opened. */
  removeRackSlot(id: number, slot: number) {
    const r = this.doc.racks.find((q) => q.id === id)
    if (!r) return
    const i = r.slots.findIndex((q) => q.slot === slot)
    if (i < 0) return
    this.doc.snap()
    r.slots.splice(i, 1)
    this.touched()
    this.say(`slot ${slot} is gone and its number is not handed out again`)
  }

  /* REORDER, WHICH MOVES A ROW AND NOT ITS ADDRESS. The list order is the order
   * things arrive in; the slot number is where they land. Dragging the fourth
   * banner to the front means it is hung first and it is still banner 4. */
  moveRackSlot(id: number, slot: number, to: number) {
    const r = this.doc.racks.find((q) => q.id === id)
    if (!r) return
    const i = r.slots.findIndex((q) => q.slot === slot)
    if (i < 0) return
    const at = clamp(Math.round(to), 0, r.slots.length - 1)
    if (at === i) return
    const [s] = r.slots.splice(i, 1)
    r.slots.splice(at, 0, s)
    this.touched()
  }

  removeRack(id: number) {
    const i = this.doc.racks.findIndex((q) => q.id === id)
    if (i < 0) return
    this.doc.snap()
    const [r] = this.doc.racks.splice(i, 1)
    if (this.rackSel === id) this.rackSel = 0
    this.touched()
    this.say(`removed the rack ${r.name}`)
  }

  selectRack(id: number) {
    if (this.rackSel === id) return
    this.rackSel = id
    this.dirty = true
    this.emit()
  }

  // ---- variant sets, group conditions, and the names of faces ---------------
  /* A VARIANT SET is one name resolving to one of several PLACEMENTS with at most one showing: five docks, a hearth lit and unlit, a ship and the empty berth it is not in. Not `looks`, which is one placement wearing another face: a ship and empty water are two silhouettes with two footprints and two anchors, and two frames of one sprite would give the empty berth the ship's collision. ONE TALLY WITH SETS AND RACKS, because python calls all three with one word. */
  freeVariantName(want: string, exceptId = 0): string {
    const base = anchorName(want)
    const taken = new Set([
      ...this.doc.sets.map((s) => s.name),
      ...this.doc.racks.map((r) => r.name),
      ...this.doc.variants.filter((v) => v.id !== exceptId).map((v) => v.name),
    ])
    if (!taken.has(base)) return base
    for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
  }

  /* WHICH MEMBERS NAME A PLACEMENT THIS MAP DOES NOT HAVE, the same question the publish gate asks, asked while somebody is looking at the screen. Against the author names only, which is what a set stores and what the game resolves through. */
  variantGaps(id: number): string[] {
    const v = this.doc.variants.find((q) => q.id === id)
    if (!v) return []
    const have = new Set(this.doc.assets.filter((a) => a.name).map((a) => a.name as string))
    const out: string[] = []
    for (const m of v.members) if (!have.has(m.placement) && !out.includes(m.placement)) out.push(m.placement)
    return out
  }

  /* every placement an author has named, which is the only pool a variant member
   * can be picked from: an unnamed placement has no address for the set to hold */
  namedPlacements(): { name: string; label: string }[] {
    return this.doc.assets
      .filter((a) => isPlacementName(a.name))
      .map((a) => ({ name: a.name as string, label: assetLabel(a) }))
  }

  addVariantSet(anchor: string): number {
    if (!isAnchorName(anchor)) return 0
    const id = this.doc.variantNext++
    const v = migrateVariantSet({
      id,
      name: this.freeVariantName(`${anchor}_state`),
      anchor,
      members: [],
      initial: '',
    } as MapVariantSet)
    if (!v) return 0
    this.doc.snap()
    this.doc.variants.push(v)
    this.variantSel = id
    this.touched()
    this.say(`variant set ${v.name} on ${anchor}`)
    return id
  }

  updateVariantSet(id: number, patch: { name?: string; anchor?: string; label?: string | null; initial?: string }) {
    const v = this.doc.variants.find((q) => q.id === id)
    if (!v) return
    if (patch.name !== undefined) v.name = this.freeVariantName(patch.name || v.name, id)
    if (patch.anchor !== undefined && isAnchorName(patch.anchor)) v.anchor = patch.anchor
    if (patch.label !== undefined) {
      if (patch.label && patch.label.trim()) v.label = patch.label
      else delete v.label
    }
    /* A STATE NAME NOTHING IS CALLED MEANS NOTHING IS SHOWING, on purpose rather than a fallback to the first member: showing an arbitrary placement because the initial was misspelt is a map that looks authored and is not, and showing nothing is a mistake an author can see. */
    if (patch.initial !== undefined) v.initial = v.members.some((m) => m.name === patch.initial) ? patch.initial : ''
    this.touched()
  }

  addVariant(id: number, placement: string, name = ''): boolean {
    const v = this.doc.variants.find((q) => q.id === id)
    if (!v || !isPlacementName(placement)) return false
    /* ONE PLACEMENT PER STATE, both ways round. Two states on one placement
     * cannot be exclusive: setting either leaves the same sprite on screen and
     * nothing downstream can say which state the set is in. */
    if (v.members.some((m) => m.placement === placement)) return false
    let want = anchorName(name || placement)
    if (v.members.some((m) => m.name === want)) for (let i = 2; v.members.some((m) => m.name === `${want}_${i}`); i++) want = `${want}_${i}`
    v.members.push({ name: want, placement })
    // the first member showing by default, because a set built one row at a time
    // with nothing selected reads as a set that does not work
    if (!v.initial) v.initial = want
    this.touched()
    return true
  }

  updateVariant(id: number, name: string, patch: { name?: string; placement?: string; label?: string | null }) {
    const v = this.doc.variants.find((q) => q.id === id)
    const m = v?.members.find((q) => q.name === name)
    if (!v || !m) return
    if (patch.placement !== undefined && isPlacementName(patch.placement) && !v.members.some((q) => q !== m && q.placement === patch.placement))
      m.placement = patch.placement
    if (patch.name !== undefined) {
      const want = anchorName(patch.name)
      if (isAnchorName(want) && !v.members.some((q) => q !== m && q.name === want)) {
        // the initial follows the rename, or an author renaming the state that
        // was showing silently turns the whole set off
        if (v.initial === m.name) v.initial = want
        m.name = want
      }
    }
    if (patch.label !== undefined) {
      if (patch.label && patch.label.trim()) m.label = patch.label
      else delete m.label
    }
    this.touched()
  }

  removeVariant(id: number, name: string) {
    const v = this.doc.variants.find((q) => q.id === id)
    if (!v) return
    const i = v.members.findIndex((q) => q.name === name)
    if (i < 0) return
    this.doc.snap()
    v.members.splice(i, 1)
    if (v.initial === name) v.initial = ''
    this.touched()
  }

  removeVariantSet(id: number) {
    const i = this.doc.variants.findIndex((q) => q.id === id)
    if (i < 0) return
    this.doc.snap()
    const [v] = this.doc.variants.splice(i, 1)
    if (this.variantSel === id) this.variantSel = 0
    this.touched()
    this.say(`removed the variant set ${v.name}`)
  }

  selectVariantSet(id: number) {
    if (this.variantSel === id) return
    this.variantSel = id
    this.dirty = true
    this.emit()
  }

  /* THE CONDITION ON A GROUP, which is why a group has a row at all: a dozen placements sharing one condition means the thirteenth is placed without it and nothing says so. The row is created on demand and removed when it says nothing, so a map where nobody typed a condition exports byte for byte what it did. */
  setGroupWhen(name: string, when: string) {
    if (!name) return
    const clean = String(when || '').trim().slice(0, 240)
    const i = this.doc.groups.findIndex((g) => g.name === name)
    this.doc.snap()
    if (i < 0) {
      if (clean) this.doc.groups.push({ name, when: clean })
    } else if (clean) this.doc.groups[i].when = clean
    else {
      delete this.doc.groups[i].when
      if (!this.doc.groups[i].label) this.doc.groups.splice(i, 1)
    }
    this.touched()
    this.say(clean ? `${name} shows when ${clean}` : `${name} always shows`)
  }

  /* THE STAIRS THIS MAP HAS, on demand rather than every frame: it is three
   * flood fills over the whole plane and the answer only changes when somebody
   * paints a ramp. */
  stairList(): StairRegion[] {
    return this.doc.stairRegions()
  }

  /* A STAIR MADE ADDRESSABLE, by putting a named region over it. map.json.stairs is a machine fact and nobody types it; what nobody could do was NAME one, so nothing downstream had a way to say which stair it meant. Rather than invent a second naming scheme keyed to a rectangle that moves when the paint moves, this makes the thing the tool already knows how to name. */
  markStair(r: StairRegion): number {
    const [x0, y0, x1, y1] = r.rect
    const id = this.addAnchor('region', Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2))
    this.updateEvent(id, { rect: [x0, y0, x1, y1], shape: 'rect' })
    const e = this.doc.events.find((q) => q.id === id)
    if (e) e.name = this.freeAnchorName(`stair_${r.connects[0]}_${r.connects[1]}`)
    this.touched()
    return id
  }

  /* WHAT A PLACEMENT BLOCKS, typed instead of measured. Four numbers or null
   * to go back to the measurement, and null is what almost every placement
   * wants. See PlacedAsset.foot for when a person needs the other thing. */
  setFoot(ids: string[], foot: [number, number, number, number] | null) {
    const want = new Set(ids)
    const picked = this.doc.assets.filter((a) => want.has(a.id))
    if (!picked.length) return 0
    this.doc.snap()
    for (const a of picked) {
      if (foot && foot.every((n) => isFinite(n))) a.foot = foot.map((n) => Math.round(n)) as [number, number, number, number]
      else delete a.foot
    }
    this.touched()
    this.say(foot ? `${picked.length} block ${foot[2]}x${foot[3]} at ${foot[0]}, ${foot[1]}` : `${picked.length} back to measured`)
    return picked.length
  }

  /* ONE GROUP ONTO EVERY PICKED PLACEMENT. The group select sat on the single
   * inspector only, so a crowd of forty had to be regrouped forty times, which
   * is why the hub's people are in one group nobody chose. */
  setAssetGroup(ids: string[], group: string) {
    const want = new Set(ids)
    const picked = this.doc.assets.filter((a) => want.has(a.id))
    if (!picked.length) return 0
    this.doc.snap()
    for (const a of picked) this.editAsset(a.id, { group })
    this.touched()
    this.say(`${picked.length} in ${group}`)
    return picked.length
  }

  /* THE CONDITION ON ONE PLACEMENT, which beats its group's where both exist. */
  setAssetWhen(ids: string[], when: string) {
    const want = new Set(ids)
    const picked = this.doc.assets.filter((a) => want.has(a.id))
    if (!picked.length) return 0
    const clean = String(when || '').trim().slice(0, 240)
    this.doc.snap()
    for (const a of picked) {
      if (clean) a.when = clean
      else delete a.when
    }
    this.touched()
    return picked.length
  }

  /* ONE KEY ON ONE ANCHOR'S BAG, the stated extension point, which without an author writer carries MAPVIS bookkeeping and nothing an author chose. null removes the key and '' keeps it holding nothing. The keys MAPVIS writes itself are refused, or an author would be editing the tool's own record through a box that looks like theirs. */
  setAnchorMeta(id: number, key: string, value: string | null) {
    const e = this.doc.events.find((q) => q.id === id)
    if (!e) return false
    const k = String(key || '').trim()
    if (!k || ANCHOR_META_RESERVED.includes(k)) return false
    this.doc.snap()
    const meta = { ...(e.meta || {}) }
    if (value === null) delete meta[k]
    else meta[k] = value
    if (Object.keys(meta).length) e.meta = meta
    else delete e.meta
    migrateAnchor(e, this.doc.walk.charH)
    this.touched()
    return true
  }

  /* THE CONDITION ON AN ANCHOR: a door barred until a cord is earned, a berth
   * that does not exist until the ship is repaired. It goes through migrateEvent
   * so the field and the meta bag it rides in cannot disagree. */
  setAnchorWhen(id: number, when: string) {
    const e = this.doc.events.find((q) => q.id === id)
    if (!e) return
    this.doc.snap()
    e.when = String(when || '').trim().slice(0, 240)
    migrateAnchor(e, this.doc.walk.charH)
    this.touched()
  }

  /* WHAT A FACE IS CALLED, which is the whole of show(placement, state) having a vocabulary. Index 0 is the picture the placement was placed with and is named on the placement itself, because look 0 is not an AssetLook. */
  setLookName(id: string, index: number, name: string): boolean {
    const a = this.doc.assets.find((q) => q.id === id)
    if (!a) return false
    const want = anchorName(name)
    if (name && !isLookName(want)) return false
    this.doc.snap()
    if (index <= 0) {
      if (name) a.lookName = want
      else delete a.lookName
    } else {
      const L = a.looks && a.looks[index - 1]
      if (!L) return false
      if (name) L.name = want
      else delete L.name
    }
    this.touched()
    return true
  }

  clearMask() {
    this.doc.clear()
    this.plates = null
    this.touched()
    this.say('mask cleared')
  }
  heal() {
    this.doc.snap()
    const r = this.doc.healSeams(this.cfg.near)
    this.touched()
    this.say(`healed ${r.filled}px of seams in ${r.passes} pass${r.passes > 1 ? 'es' : ''}`)
  }
  check(): ReachResult {
    const r = checkReach(this.doc, this.cfg)
    this.showHits = true
    this.touched()
    this.say(
      r.orphans.length
        ? `reached ${r.reached}px · cut off: ` +
            r.orphans
              .slice(0, 3)
              .map((o) => `${o.px}px at ${o.rect[0]},${o.rect[1]}`)
              .join(' · ')
        : `reached ${r.reached}px · nothing cut off`,
    )
    return r
  }
  applyLevelsPNG(dataURL: string) {
    return loadImage(dataURL).then((img) => {
      this.doc.importLevels(img)
      this.touched()
    })
  }
  // the painting with the cut applied: cut pixels at alpha 0, art untouched.
  // This is what the engine gets, and what the preview shows.
  private buildCutApplied(): HTMLCanvasElement {
    const c = mkCanvas(this.doc.W, this.doc.H)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    if (this.painting) g.drawImage(this.painting, 0, 0)
    const d = g.getImageData(0, 0, this.doc.W, this.doc.H)
    for (let i = 0; i < this.doc.cut.length; i++) if (this.doc.cut[i]) d.data[i * 4 + 3] = 0
    g.putImageData(d, 0, 0)
    return c
  }
  cutSceneDataURL(): string | null {
    if (!this.painting) return null
    return this.buildCutApplied().toDataURL('image/png')
  }
  /* A rectangle of the painting on its own, as a png. Two callers want the same pixels at different sizes: the model reads it enlarged because a 40px strip is easier to judge at 2x, and PixelLab will not accept more than 192 per side so that one passes a cap. Whole multiples only and smoothing off, because a resampled pixel is a lie about what is on the map. */
  areaDataURL(r: { x: number; y: number; w: number; h: number }, scale = 1, cap = 0): string {
    const src = this.buildCutApplied()
    const w = Math.max(1, Math.round(r.w))
    const h = Math.max(1, Math.round(r.h))
    let z = scale > 0 ? Math.round(scale) : 1
    if (cap > 0) {
      // fit under the cap: shrink to a whole fraction if it is already over
      z = Math.max(1, Math.floor(cap / Math.max(w, h)))
      if (Math.max(w, h) > cap) {
        const c = mkCanvas(Math.max(1, Math.round((w * cap) / Math.max(w, h))), Math.max(1, Math.round((h * cap) / Math.max(w, h))))
        const g = c.getContext('2d') as CanvasRenderingContext2D
        g.imageSmoothingEnabled = false
        g.drawImage(src, r.x, r.y, w, h, 0, 0, c.width, c.height)
        return c.toDataURL('image/png')
      }
    }
    const c = mkCanvas(w * z, h * z)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.imageSmoothingEnabled = false
    g.drawImage(src, r.x, r.y, w, h, 0, 0, c.width, c.height)
    return c.toDataURL('image/png')
  }
  cutMaskDataURL(): string {
    return this.doc.cutCanvas().toDataURL('image/png')
  }
  bundle() {
    const hasCut = this.doc.stats().cut > 0
    const scene = hasCut ? this.buildCutApplied() : mkCanvas(this.doc.W, this.doc.H)
    if (!hasCut) {
      const sg = scene.getContext('2d') as CanvasRenderingContext2D
      if (this.painting) sg.drawImage(this.painting, 0, 0)
    }
    return {
      id: this.sceneId,
      scene: scene.toDataURL('image/png'),
      levels: this.doc.levelsCanvas(hasCut ? this.doc.cut : undefined).toDataURL('image/png'),
      cut: hasCut ? this.doc.cutCanvas().toDataURL('image/png') : null,
      occluders: this.doc.occludersCanvas().toDataURL('image/png'),
      /* the placements as the editor holds them, MINUS anything in a hidden group. Hidden has to mean hidden everywhere: a group with its eye closed that still ships at full opacity, with nothing saying so, reads as the tool ignoring you the moment the thing turns up in the game. */
      /* THE CONDITION IS RESOLVED HERE, where the group table is: a placement's own `when` wins and otherwise it inherits its group's. The group row stays as the authoring record, and the resolved string rides the placement because the game's assets loop has a placement in hand and no group table beside it. */
      assets: this.doc.assets
        .filter((a) => !this.hiddenGroups.has(a.group))
        .map((a) => {
          const w = whenOf(a, this.doc.groups)
          return w === (a.when || '') ? a : { ...a, when: w }
        }),
      map: {
        id: this.sceneId,
        w: this.doc.W,
        h: this.doc.H,
        /* THE PAINTING, AS OPPOSED TO THE CANVAS IT SITS IN, AND IT WAS NEITHER. This said doc.bw/bh/ox/oy, which is where the DROPPED FILE sits and knows nothing about the cut: the hub's manifest said 688x640 at 0,0 while the scene.png beside it is opaque only in x 7..675, y 194..570. The consumer hand-copied the real numbers into a fallback, and worse, 688*640 is past the pixel ceiling one generation can hold, so the composition built off it was thrown away whole. Measured off the bytes that ship, the same way the server measures them at publish. */
        /* stated when an author has stated it, measured otherwise, which is
         * every map so far. See MapProps.paint. */
        base: this.doc.props.paint
          ? { w: this.doc.props.paint[0], h: this.doc.props.paint[1], ox: this.doc.props.paint[2], oy: this.doc.props.paint[3] }
          : paintedBoxOf(scene),
        /* WHAT THIS MAP IS AND WHAT IT CALLS ITSELF. The engine guessed `class` from whether the border was transparent while this tool knew the answer, and `title` never left the database. Written only when set, so a bundle from before this stays byte for byte what it was. */
        class: this.doc.props.class,
        ...(this.doc.props.title ? { title: this.doc.props.title } : {}),
        ...(this.doc.props.islandId ? { islandId: this.doc.props.islandId } : {}),
        ...(Object.keys(this.doc.props.meta).length ? { meta: this.doc.props.meta } : {}),
        encoding: {
          blocked: 0,
          L0: 40,
          ramp01: 50,
          L1: 60,
          ramp12: 70,
          L2: 80,
          ramp23: 90,
          L3: 100,
          stepTolerance: this.cfg.near,
        },
        spawn: this.doc.spawn,
        character: { heightPx: this.cfg.charH, hip: this.cfg.hip, hipDY: this.cfg.hipDY },
        speed: this.cfg.speed,
        yScale: this.cfg.yScale,
        stairs: this.doc.stairRegions(),
        occluders: this.doc.occs.map((o) => ({ id: o.id, baseline: o.baseline })),
        // the events contract: a spot plus an action, and a reader that does not know a type skips it. BOTH shapes ship: anchors[] is what the api and python read, events[] is what the game reads today and stays door-only in the exact shape it already parses.
        anchors: this.doc.events.map((e) => ({
          name: e.name,
          kind: e.kind,
          x: e.x,
          y: e.y,
          r: e.r,
          /* THE AREA, AS BOTH SHAPES WHEN IT WAS DRAWN: `poly` is what the author marked and `rect` is its bounding box, both because the running game tests a region by its rect and has no polygon test, so points alone would be an area no player is ever inside. An L-shaped plaza tests as its box until the game learns the points. ONLY THE LIVE SHAPE SHIPS: an anchor can hold a drawing and a box at once and the game's contains() tests a rect before a radius, so a dormant rect beside a circle would hand the game an area the author had switched off. */
          ...(() => {
            const shape = anchorShape(e)
            if (shape === 'poly' && e.poly) return { poly: e.poly, rect: polyBounds(e.poly) }
            if (shape === 'rect' && e.rect) return { rect: e.rect }
            return {}
          })(),
          ...(e.stand ? { stand: e.stand } : {}),
          ...(e.to ? { to: e.to } : {}),
          ...(e.toAnchor ? { toAnchor: e.toAnchor } : {}),
          /* the placement this name is on. Dropping it here means `show` can never fire on a bundle from this exporter, and the published bundle takes its anchors from the database, so both exporters carry it. */
          ...(e.placement ? { placement: e.placement } : {}),
          ...(e.facing ? { facing: e.facing } : {}),
          ...(e.label ? { label: e.label } : {}),
          /* the bag, with every shot AND every variant set hung on this name folded into it: readAnchors in the game builds its anchor from a fixed list of top-level fields and then copies meta whole, so the bag is the only thing a new field can cross in. */
          ...(() => {
            const m = variantsOntoMeta(this.doc.variants, e.name, shotsOntoMeta(this.doc.framings, e.name, e.meta))
            return m ? { meta: m } : {}
          })(),
        })),
        events: this.doc.events
          .filter((e) => e.kind === 'door')
          .map((e) => ({ id: e.id, type: 'door', x: e.x, y: e.y, r: e.r, label: e.label || e.name, to: e.to })),
        /* ROUTES AND SHOTS, keyed by name and absent when none were drawn, so a bundle from before they existed stays byte for byte what it was. The id is deliberately not shipped: across the bundle boundary a name is the only identity there is. */
        /* NOTHING READS `paths` YET, and the shape is written down here rather than guessed at later. The nearest running shape is findPath's `{x, y}` in painting pixels walked forward by index, so these pairs would have to become objects for a reader to take them with no adapter. Not converted, because there is no reader to be right for. */
        ...(this.doc.paths.length
          ? {
              paths: this.doc.paths.map((p) => ({
                name: p.name,
                /* always written, never omitted when it is walk: the reader on the game side has to tell a boat from a body without knowing which version of this tool wrote the file, and an absent field would make it guess. */
                kind: p.kind,
                points: p.points,
                closed: p.closed,
                twoWay: p.twoWay,
                ...(p.facing ? { facing: p.facing } : {}),
                ...(p.marks && p.marks.length ? { marks: p.marks } : {}),
                ...(p.meta && Object.keys(p.meta).length ? { meta: p.meta } : {}),
              })),
            }
          : {}),
        /* THE SHOT LIST IS THE AUTHORING RECORD AND NOT THE CAMERA. Every shot hanging on an anchor is also written into that anchor's meta bag, which is the only place the game looks. This array stays because it is what the panel edits and what reloads, and because a shot on raw coordinates has nowhere else to live. `entry` is here honestly: the game's arrival path returns a position and a facing and never touches zoom. */
        ...(this.doc.framings.length
          ? {
              framings: this.doc.framings.map((f) => ({
                name: f.name,
                ...(f.anchor ? { anchor: f.anchor } : {}),
                ...(f.anchor ? {} : { x: f.x, y: f.y }),
                dx: f.dx,
                dy: f.dy,
                zoom: f.zoom,
                // what the same shot is worth to the game, beside the editor's
                // own view number, so nothing downstream has to guess which
                // unit the field above is in
                gameZoom: shotZoom(f),
                ...(f.entry ? { entry: true } : {}),
                ...(f.meta && Object.keys(f.meta).length ? { meta: f.meta } : {}),
              })),
            }
          : {}),
        /* SETS AND RACKS, keyed by name and absent when nobody made one. NOTHING IN THE GAME READS EITHER YET, written down the way it is for `paths`: anchors.ts holds anchors in one flat map and its only many-at-once question is `ofKind`, nothing iterates a named collection, and every anchor-taking intent takes a single string. So there was no running shape to match and these are the minimum that says the thing. The rack's `slot` ships and the id does not, the opposite of a route's counter, because slot is the address: it is what hook[3] means and it is stable for the life of the map. */
        ...(this.doc.sets.length
          ? {
              sets: this.doc.sets.map((s) => ({
                name: s.name,
                ...(s.label ? { label: s.label } : {}),
                members: s.members,
                ...(s.meta && Object.keys(s.meta).length ? { meta: s.meta } : {}),
              })),
            }
          : {}),
        ...(this.doc.racks.length
          ? {
              racks: this.doc.racks.map((r) => ({
                name: r.name,
                ...(r.label ? { label: r.label } : {}),
                slots: r.slots.map((s) => ({
                  slot: s.slot,
                  anchor: s.anchor,
                  ...(s.label ? { label: s.label } : {}),
                  ...(s.meta && Object.keys(s.meta).length ? { meta: s.meta } : {}),
                })),
                ...(r.meta && Object.keys(r.meta).length ? { meta: r.meta } : {}),
              })),
            }
          : {}),
        /* THE VARIANT SET LIST IS THE AUTHORING RECORD AND NOT THE SWITCH. Every set is also folded into its anchor's meta bag, which is the only place the game can read one, since readAnchors copies a fixed list plus the whole bag and drops an array up here. This stays because it is what the panel edits and because the anchor projection drops the labels a person reads. */
        ...(this.doc.variants.length
          ? {
              variants: this.doc.variants.map((v) => ({
                name: v.name,
                anchor: v.anchor,
                ...(v.label ? { label: v.label } : {}),
                members: v.members,
                initial: v.initial,
                ...(v.meta && Object.keys(v.meta).length ? { meta: v.meta } : {}),
              })),
            }
          : {}),
        /* THE GROUP ROWS, the one place a condition shared by a dozen placements is written once. Every placement in assets.json already carries the resolved string, so a reader needs nothing from here; without it a reopened map would show a dozen placements each carrying a condition and no group that owns any of them. */
        ...(this.doc.groups.length ? { groups: this.doc.groups } : {}),
      },
    }
  }

  private touched() {
    this.dirtyMask = true
    this.dirty = true
    this.changed = true
    this.cutApplied = null
    /* A BOUND ANCHOR FOLLOWS THE THING IT IS BOUND TO, and this is the one hook every edit already runs through, so no gesture has to remember to drag the name along with the sprite. Cheap: almost no anchor carries a binding. */
    this.syncBoundAnchors()
    // whether a walker can reach a standing placement is a question about the
    // floor and about where the thing was put, and this is the one hook both a
    // brush stroke and a drag already run through
    this.reachCache.clear()
    this.emit()
  }

  // ---- expand the map boundary. Transparent margin growth, one side per press: the painting re-composites onto a larger canvas and every plane, the spawn, the baselines, the placements and the walker shift by the same offset. Hard cap 2048x2048, and nothing is ever resampled.
  growCanvas(side: 'top' | 'bottom' | 'left' | 'right', px: number) {
    if (!this.painting) return
    const n = Math.round(px)
    if (!(n > 0)) return
    const dx = side === 'left' ? n : 0
    const dy = side === 'top' ? n : 0
    const nw = this.doc.W + (side === 'left' || side === 'right' ? n : 0)
    const nh = this.doc.H + (side === 'top' || side === 'bottom' ? n : 0)
    if (nw > 2048 || nh > 2048) {
      this.say(`the cap is 2048×2048 · ${nw}×${nh} does not fit`)
      return
    }
    this.doc.snap()
    this.relayCanvas(dx, dy, nw, nh)
    // pan compensates for the origin shift, so the art stays put on screen
    // and the new margin appears on the grown side
    this.ox -= dx * this.z
    this.oy -= dy * this.z
    this.touched()
    this.say(`grew ${side} by ${n}px · now ${nw}×${nh} · z undoes`)
  }
  // the shared re-lay: document planes, painting, walker, then every derived
  // canvas. Used by a grow press and by the autosave restore of a grown map.
  private relayCanvas(dx: number, dy: number, nw: number, nh: number) {
    this.doc.grow(dx, dy, nw, nh)
    const c = mkCanvas(nw, nh)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    if (this.painting) g.drawImage(this.painting, dx, dy)
    this.painting = c
    this.walker.x += dx
    this.walker.y += dy
    this.rebuildForSize()
  }
  // undo, size-aware: a growth press snapshots the pre-grow document, so one
  // z re-lays the painting from the base art at the restored size and offset
  /* THE PANEL'S CHANCE TO UNDO WHAT THE DOCUMENT CANNOT. A crop is two changes, pixels on disk and anchors in the document, and z only knew about the second, so undoing one put every placement back around art that was still cropped and the map read as though it had slid, which cost nineteen trees once. The hook is asked first and told how deep the stack is, so it can tell its own edit apart from three moves after it. */
  beforeUndo: ((histLen: number) => void) | null = null

  private undoDoc(): boolean {
    if (this.beforeUndo) this.beforeUndo(this.doc.histLen())
    const ow = this.doc.W
    const oh = this.doc.H
    const oox = this.doc.ox
    const ooy = this.doc.oy
    if (!this.doc.undo()) return false
    if (this.doc.W !== ow || this.doc.H !== oh) {
      if (this.basePainting) {
        const c = mkCanvas(this.doc.W, this.doc.H)
        const g = c.getContext('2d') as CanvasRenderingContext2D
        g.drawImage(this.basePainting, this.doc.ox, this.doc.oy)
        this.painting = c
      }
      this.walker.x += this.doc.ox - oox
      this.walker.y += this.doc.oy - ooy
      this.ox -= (this.doc.ox - oox) * this.z
      this.oy -= (this.doc.oy - ooy) * this.z
      this.rebuildForSize()
      this.say(`canvas back to ${this.doc.W}×${this.doc.H}`)
    }
    return true
  }
  // everything derived from the canvas size, rebuilt after a grow or its
  // undo. The region labels drop to null; the app recomputes them off-thread
  // the moment the status reports the new size.
  private rebuildForSize() {
    const { W, H } = this.doc
    this.natMask = mkCanvas(W, H)
    this.natOcc = mkCanvas(W, H)
    this.natCut = mkCanvas(W, H)
    this.natHits = mkCanvas(W, H)
    this.plates = null
    this.cutApplied = null
    this.paintBox = null
    this.regionLabels = null
    this.regionCount = 0
    this.hoverRegion = -1
    this.regionHL = null
    if (this.painting) {
      const c = mkCanvas(W, H)
      const g = c.getContext('2d') as CanvasRenderingContext2D
      g.drawImage(this.painting, 0, 0)
      this.pix = g.getImageData(0, 0, W, H).data
    }
    this.dirtyMask = true
    this.dirty = true
  }

  // ---- local autosave, silent -------------------------------------------
  // v3 saves under the size-free key and carries w/h and the base offset, so
  // a grown map re-grows on reload; the old sized key still reads.
  private key() {
    return `mapvis:${this.sceneId}`
  }
  /* THE SAVE, WAITED FOR: the four-second race, closed. Export posts the bundle without waiting for the autosave beat, and the published anchors come from postgres while the local map.json comes from the same request, so an anchor renamed in the four seconds before pressing export published with its PREVIOUS values while the file beside it carried the new ones. Awaited rather than fired, because the whole point is that the row is up to date before the publisher reads it. */
  async flush() {
    if (!this.changed) return
    const s = this.doc.serialize()
    try {
      localStorage.setItem(this.key(), s)
    } catch {
      /* said below on the beat; not worth two warnings for one full quota */
    }
    const r = await saveDoc(this.sceneId, s)
    localStorage.setItem(this.key() + ':at', String(r?.savedAt || Date.now()))
    this.changed = false
    this.saveT = performance.now()
  }
  private saveLocal() {
    const s = this.doc.serialize()
    try {
      localStorage.setItem(this.key(), s)
    } catch {
      // a full quota is reported and not swallowed. One map is about two
      // megabytes of utf-16 at 688x384 and a browser gives roughly five, so the
      // third map in one browser stops saving, and silence loses the work.
      this.say('this browser is full · saving to disk only')
    }
    // the copy that survives a cleared browser or a different machine. The
    // server answers with its own clock, and recording that here is what lets
    // the next open tell which of the two copies is really the newer one.
    void saveDoc(this.sceneId, s)
      .then((r) => {
        localStorage.setItem(this.key() + ':at', String(r?.savedAt || Date.now()))
        this.diskWarned = false
      })
      .catch(() => {
        // an unreachable platform means this browser is ahead of it, so stamp
        // local time and let the comparison on the next open notice
        localStorage.setItem(this.key() + ':at', String(Date.now()))
        if (this.diskWarned) return
        this.diskWarned = true
        this.say('could not reach the platform · this browser is the only copy')
      })
  }
  /* Unpack a saved string into this doc. A v3 envelope may describe a grown canvas, so match its base against the painting that just loaded, grow first, then unpack into the grown planes. Shared by every restore path, which only differ in where the string came from. */
  private applyDoc(raw: string) {
    try {
      if (raw.startsWith('{')) {
        const d = JSON.parse(raw) as {
          w?: number
          h?: number
          base?: { w: number; h: number; ox: number; oy: number }
        }
        if (typeof d.w === 'number' && typeof d.h === 'number' && (d.w !== this.doc.W || d.h !== this.doc.H)) {
          const b = d.base
          if (!b || b.w !== this.doc.W || b.h !== this.doc.H) return false // saved against another painting
          this.relayCanvas(b.ox, b.oy, d.w, d.h)
        }
      }
      return this.doc.deserialize(raw)
    } catch {
      return false
    }
  }

  /* When this browser last saved. Kept beside the document rather than inside
   * it, so the saved format is untouched and an older build still reads it. */
  private localAt() {
    return Number(localStorage.getItem(this.key() + ':at') || 0)
  }

  private restoreLocal() {
    const legacyKey = `mapvis:${this.sceneId}:${this.doc.W}x${this.doc.H}`
    try {
      let raw = localStorage.getItem(this.key())
      let legacy = false
      if (!raw) {
        raw = localStorage.getItem(legacyKey)
        legacy = true
      }
      if (!raw) return false
      if (this.applyDoc(raw)) {
        if (legacy) {
          const m = localStorage.getItem(legacyKey + ':meta')
          if (m) this.doc.spawn = JSON.parse(m).spawn
        }
        this.say('restored from this browser')
        return true
      }
    } catch {
      /* nothing saved, or nothing readable */
    }
    return false
  }

  /* The disk mirror, read when this browser has nothing: a new machine, a cleared browser, or the quota having eaten the local copy. Same grow-then-unpack order restoreLocal uses, because deserialize ignores the envelope's w/h and unpack refuses a length mismatch. */
  /* Whichever copy is newer wins, which is the whole difference between a tool and a platform. Trying localStorage first is right on one machine and wrong the moment a map lives in a database: opening it here would read this browser forever and a second browser would quietly diverge. Both are asked and the server's own clock decides; the browser copy still wins when it is genuinely newer, which is what happens after editing offline. */
  private async restoreDoc() {
    const localRaw = localStorage.getItem(this.key())
    const localAt = this.localAt()
    let server: { doc: string; savedAt?: number; from?: string } | null = null
    try {
      server = await loadDoc(this.sceneId)
    } catch {
      /* the server is not up; the browser copy is all there is */
    }
    const serverAt = Number(server?.savedAt || 0)

    // a browser copy with no recorded time predates this and cannot be
    // compared, so the platform is trusted over it
    if (server?.doc && (!localRaw || serverAt >= localAt) && this.applyDoc(server.doc)) {
      localStorage.setItem(this.key() + ':at', String(serverAt || Date.now()))
      this.say(localRaw && localAt && serverAt > localAt ? 'loaded a newer copy from the platform' : 'loaded from the platform')
      return true
    }
    if (localRaw && this.restoreLocal()) {
      if (serverAt && localAt > serverAt) this.say('this browser has newer work · it will save over the platform copy')
      return true
    }
    if (server?.doc && this.applyDoc(server.doc)) {
      this.say('loaded from the platform')
      return true
    }
    return false
  }

  // an exported bundle is the other place a mask lives, so reopening a scene
  // that was exported under this id picks it back up
  private async restoreFromDisk() {
    try {
      const s = await savedScene(this.sceneId)
      let got = false
      if (s.cut) {
        this.doc.importCut(await loadImage(s.cut))
        got = true
      }
      if (s.levels) {
        this.doc.importLevels(await loadImage(s.levels))
        if (s.occluders && s.map && s.map.occluders && s.map.occluders.length)
          this.doc.importOccluders(await loadImage(s.occluders), s.map.occluders)
        if (s.map && s.map.spawn) this.doc.spawn = s.map.spawn
        /* The exported names come back too, so a reopened map keeps them. anchors[] first because it is the richer shape and carries the author-typed name; a bundle from before anchors existed only has events[], which migrate into doors with a derived name. */
        const exported =
          (s.map as
            | {
                anchors?: unknown[]
                events?: unknown[]
                variants?: unknown[]
                groups?: unknown[]
                paths?: unknown[]
                framings?: unknown[]
                sets?: unknown[]
                racks?: unknown[]
              }
            | undefined) || {}
        const list = Array.isArray(exported.anchors) ? exported.anchors : exported.events
        if (Array.isArray(list) && list.length) {
          this.doc.events = list.map((e, i) =>
            migrateAnchor({ id: i + 1, ...(e as object) } as MapAnchor & { type?: string }, this.doc.walk.charH),
          )
          this.doc.eventNext = this.doc.events.reduce((m, e) => Math.max(m, e.id), 0) + 1
        }
        /* THE VARIANT SETS AND THE GROUP ROWS COME BACK TOO, or a reopen and a re-export deletes them: the placements would still carry their conditions and every set would be gone, the same silent loss `life` and `dirs` each shipped once. The id is not in the bundle, so it is handed out again here. */
        if (Array.isArray(exported.variants) && exported.variants.length) {
          this.doc.variants = (exported.variants as MapVariantSet[])
            .map((v, i) => migrateVariantSet({ ...(v as object), id: i + 1 } as MapVariantSet))
            .filter((v): v is MapVariantSet => !!v)
          this.doc.variantNext = this.doc.variants.reduce((m, v) => Math.max(m, v.id), 0) + 1
        }
        if (Array.isArray(exported.groups) && exported.groups.length)
          this.doc.groups = (exported.groups as MapGroup[])
            .map(migrateGroup)
            .filter((g): g is MapGroup => !!g)
        /* AND THE OTHER FOUR, WHICH THE FIX ABOVE WAS APPLIED TO TWO OF. bundle() writes six arrays and this restored two, so a reopen dropped every route, shot, anchor set and rack while the comment above claimed to have stopped exactly that. This only runs when the browser holds nothing, so it is the new-machine recovery path: reopen the hub on a fresh machine, the panels come up empty, and the next autosave writes that emptiness into postgres as the truth. WORSE FOR THE SHOTS: the restored anchors carry the PROJECTED meta from the last export, so a lost shot list leaves a live framings bag with nothing in the panel to edit or delete. */
        if (Array.isArray(exported.paths) && exported.paths.length) {
          this.doc.paths = (exported.paths as MapPath[])
            .map((p, i) => migratePath({ ...(p as object), id: i + 1 } as MapPath))
            .filter((p): p is MapPath => !!p)
          this.doc.pathNext = this.doc.paths.reduce((m, p) => Math.max(m, p.id), 0) + 1
        }
        if (Array.isArray(exported.framings) && exported.framings.length) {
          this.doc.framings = (exported.framings as MapFraming[])
            .map((f, i) => migrateFraming({ ...(f as object), id: i + 1 } as MapFraming))
            .filter((f): f is MapFraming => !!f)
          this.doc.framingNext = this.doc.framings.reduce((m, f) => Math.max(m, f.id), 0) + 1
        }
        if (Array.isArray(exported.sets) && exported.sets.length) {
          this.doc.sets = (exported.sets as MapAnchorSet[])
            .map((a, i) => migrateAnchorSet({ ...(a as object), id: i + 1 } as MapAnchorSet))
            .filter((a): a is MapAnchorSet => !!a)
          this.doc.setNext = this.doc.sets.reduce((m, a) => Math.max(m, a.id), 0) + 1
        }
        if (Array.isArray(exported.racks) && exported.racks.length) {
          this.doc.racks = (exported.racks as MapRack[])
            .map((r, i) => migrateRack({ ...(r as object), id: i + 1 } as MapRack))
            .filter((r): r is MapRack => !!r)
          this.doc.rackNext = this.doc.racks.reduce((m, r) => Math.max(m, r.id), 0) + 1
        }
        got = true
      }
      // assets.json paths are bundle-relative (assets/foo.png); the bundle's
      // own assets/ folder holds those exact pngs and /work serves it, so map
      // them to /work/<id>/assets urls. Export resolves those back to files.
      const listed = s.assets && Array.isArray(s.assets.assets) ? s.assets.assets : null
      if (listed && listed.length) {
        const out: PlacedAsset[] = []
        let next = 1
        // anything with frames or views lives in a FOLDER inside assets/, so the
        // folder segment has to survive the trip back. Keeping only the basename
        // 404s the png and the placement falls back to the placeholder box.
        const workURL = (p: unknown): string => {
          const rel = String(p || '')
            .split('?')[0]
            .replace(/^\/?assets\//, '')
            .replace(/^\//, '')
          return rel ? `/work/${this.sceneId}/assets/${rel}` : ''
        }
        /* ONE APPEARANCE, read back: views, then frames, then a bare src, in the order the exporter packs them and the game loads them. A set of views carries a src as well, pointing at whichever heading came first, so views have to be taken before the src branch claims it and loses the other seven. One copy of this precedence, because two of them disagree. */
        type LookRec = { src?: string; frames?: string[]; fps?: number; facing?: string; dirs?: Record<string, string[]> }
        const readLook = (s: LookRec | null | undefined): AssetLook | null => {
          if (!s || typeof s !== 'object') return null
          const fps = Number(s.fps) > 0 ? Number(s.fps) : 0
          if (s.dirs && typeof s.dirs === 'object') {
            const views: Record<string, string[]> = {}
            for (const [k, arr] of Object.entries(s.dirs)) {
              if (!Array.isArray(arr) || !arr.length) continue
              // one path per heading from the old exporter, a whole walk cycle
              // from a newer one; both are just the list that was written
              const set = arr.map(workURL).filter(Boolean)
              if (set.length) views[k] = set
            }
            const keys = Object.keys(views)
            /* THE HEADING THE AUTHOR PICKED SURVIVES THE REOPEN. Taking views.south whenever a south set exists throws away the one field the exporter writes to carry the choice, because the resting heading is only ever held on src: a reopen turns every hand-turned figure back to front and the next export writes that down as the truth. Measured on a 38-figure map, 21 south, 8 south-west and 9 south-east go in and 38 south come out. restoreFromDisk only runs when the browser holds nothing, so this lands on the new-machine path and nowhere else. */
            if (keys.length) {
              const rest = (s.facing && views[s.facing]) || views.south || views[keys[0]]
              return { kind: 'static', dirs: views, src: rest[0], ...(fps ? { fps } : {}) }
            }
          }
          if (Array.isArray(s.frames) && s.frames.length) {
            const frames = s.frames.map(workURL).filter(Boolean)
            if (frames.length) return { kind: 'animated', frames, fps: fps || 6 }
          }
          if (s.src) {
            const url = workURL(s.src)
            if (url) return { kind: 'static', src: url }
          }
          return null
        }
        for (const d of listed) {
          const x = Number(d.x)
          const y = Number(d.y)
          if (!isFinite(x) || !isFinite(y)) continue
          const id = typeof d.id === 'string' && d.id ? d.id : 'a' + next
          const m = /^a(\d+)$/.exec(id)
          if (m) next = Math.max(next, Number(m[1]) + 1)
          // the transform fields, falling back to the old uniform scale for a
          // bundle exported before they existed
          const us = Number(d.scale) > 0 ? Number(d.scale) : 0.25
          const sx = Number(d.scaleX) > 0 ? Number(d.scaleX) : us
          const sy = Number(d.scaleY) > 0 ? Number(d.scaleY) : us
          // look 0 is the entry itself, in the same shape and by the same rules
          // as every extra look below it. Nothing resolved means nothing to
          // draw, which is where a placement has always been dropped.
          const look0 = readLook(d)
          if (!look0) continue
          const base: PlacedAsset = {
            id,
            /* THE AUTHOR'S OWN NAME FOR THIS THING, which this path dropped. It is the only address anything outside the map can hold: an anchor binds to it, a variant member names it, and the game keys its sprites by it, so a reopen that loses it and re-exports turns every binding into a name pointing at nothing. */
            ...(isPlacementName(d.name) ? { name: String(d.name) } : {}),
            group: typeof d.group === 'string' && d.group ? d.group : 'props',
            ...look0,
            x,
            y,
            scale: sx,
            sx,
            sy,
            rot: isFinite(Number(d.rot)) ? Number(d.rot) : 0,
            fx: !!d.flipX,
            fy: !!d.flipY,
            // the condition, back exactly as it shipped. It was resolved off the
            // group on the way out, and the group rows come back above, so
            // whenOf answers the same string on the next export.
            ...(typeof d.when === 'string' && d.when.trim() ? { when: String(d.when).trim() } : {}),
          }
          // how it MOVES comes back too, through the same guard every other
          // caller uses. Dropping it was what silently deleted every behaviour
          // on a reopen-and-re-export.
          const life = cleanLife(d.life)
          if (life) base.life = life
          /* and the extra pictures a sequence switches to. A look that resolves to NOTHING KEEPS ITS SLOT, holding look 0: art is an index, so dropping one shifts every later look down and the placement draws the wrong picture rather than a missing one. The exporter and the game reader hold the slot the same way, so all three sides agree that a look that did not arrive shows the thing as it started. Dropping the list entirely would delete every look on a reopen-and-re-export. */
          const looks: AssetLook[] = []
          for (const L of Array.isArray(d.looks) ? d.looks.slice(0, LOOKS_MAX) : []) looks.push(readLook(L) || look0)
          if (looks.length) base.looks = looks
          /* AND WHAT EACH FACE IS CALLED, one array indexed the way art is with slot 0 the placement's own picture, so the off-by-one is read here the same way it is written. An empty string is a face nobody named and holds its slot. */
          const names = Array.isArray(d.lookNames) ? (d.lookNames as unknown[]) : []
          if (isLookName(names[0])) base.lookName = names[0] as string
          for (let i = 0; i < looks.length; i++) if (isLookName(names[i + 1])) looks[i].name = names[i + 1] as string
          out.push(base)
        }
        if (out.length) {
          this.doc.assets = out
          this.doc.assetNext = next
          got = true
        }
      }
      if (got) this.say(`reopened from work/${this.sceneId}`)
    } catch {
      /* never exported, or the api is not up */
    }
  }

  // ---- render -----------------------------------------------------------
  private bakeLayers() {
    if (!this.natMask || !this.natOcc || !this.natCut || !this.natHits) return
    const { W, H } = this.doc
    const gm = (this.natMask as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D
    const d = gm.createImageData(W, H)
    const p = d.data
    /* PAINTED IS NOT STANDABLE, AND THIS OVERLAY MUST NOT SAY IT IS. Colouring every pixel that has a level ignores the rest of the step test, which needs both hip pixels to exist and to sit within stepTolerance. Measured on a 688x384 island, 23,861 pixels are painted and 21,050 can be stood on, so 2,811 of them, 11.8 percent, would be shown as floor no character can occupy. They are a one to two pixel rim along every path edge, and the harbour stair narrows to a single standable pixel while looking comfortably wide. Drawn dim rather than hidden, because seeing where usable floor stops is the point of the overlay. */
    for (let i = 0; i < this.doc.lvl.length; i++) {
      const v = this.doc.lvl[i]
      if (v === 0) {
        p[i * 4 + 3] = 0
        continue
      }
      const c = colOf(v)
      p[i * 4] = c[0]
      p[i * 4 + 1] = c[1]
      p[i * 4 + 2] = c[2]
      p[i * 4 + 3] = canStand(this.doc, this.cfg, i % W, (i / W) | 0) ? 255 : 70
    }
    gm.putImageData(d, 0, 0)

    const go = (this.natOcc as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D
    const o = go.createImageData(W, H)
    const q = o.data
    for (let i = 0; i < this.doc.occ.length; i++) {
      if (!this.doc.occ[i]) continue
      q[i * 4] = 190
      q[i * 4 + 1] = 120
      q[i * 4 + 2] = 255
      q[i * 4 + 3] = 150
    }
    go.putImageData(o, 0, 0)

    // the cut layer: a magenta 1px checker, deliberately not a colour any
    // painting uses, so a cut pixel can never be mistaken for art
    const gc = (this.natCut as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D
    const cd = gc.createImageData(W, H)
    const cp = cd.data
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (!this.doc.cut[i]) continue
        cp[i * 4] = 255
        cp[i * 4 + 1] = 64
        cp[i * 4 + 2] = 208
        cp[i * 4 + 3] = (x + y) & 1 ? 190 : 80
      }
    gc.putImageData(cd, 0, 0)

    const gh = (this.natHits as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D
    const h = gh.createImageData(W, H)
    const r = h.data
    for (let i = 0; i < this.doc.hits.length; i++) {
      if (!this.doc.hits[i]) continue
      r[i * 4] = 255
      r[i * 4 + 1] = 40
      r[i * 4 + 2] = 40
      r[i * 4 + 3] = Math.min(255, this.doc.hits[i] * 24)
    }
    gh.putImageData(h, 0, 0)
    this.dirtyMask = false
  }

  // An occluder is a piece of the painting lifted back out of it and drawn
  // over the character when his feet are north of its baseline. Baking it from
  // the painting itself is what keeps it pixel-identical to the art.
  private bakePlates() {
    const { W, H } = this.doc
    this.plates = this.doc.occs.map((o) => {
      const c = mkCanvas(W, H)
      const g = c.getContext('2d') as CanvasRenderingContext2D
      if (this.painting) g.drawImage(this.painting, 0, 0)
      const d = g.getImageData(0, 0, W, H)
      for (let i = 0; i < this.doc.occ.length; i++) if (this.doc.occ[i] !== o.id) d.data[i * 4 + 3] = 0
      g.putImageData(d, 0, 0)
      return { cv: c, baseline: o.baseline }
    })
  }

  private frame(now: number) {
    const dt = Math.min(50, now - this.last) / 1000
    this.last = now
    if (this.walking) {
      const wasBlocked = this.walker.step(this.doc, this.cfg, this.keys, dt)
      if (wasBlocked && this.showHits) this.dirtyMask = true
      this.dirty = true
    }
    if (this.changed && !this.loading && now - this.saveT > 4000) {
      this.saveLocal()
      this.changed = false
      this.saveT = now
    }
    // an animated placement keeps its own clock, and so does one that MOVES, so
    // the frame loop must keep painting while either is on screen
    if (
      this.assetMode &&
      this.doc.assets.some(
        (a) =>
          (a.kind === 'animated' ||
            (this.lifePlay && a.life) ||
            // a view set whose heading holds more than one frame is a loop too,
            // and it is kind 'static', so without this a breathing figure that
            // never travels stopped the canvas from repainting at all
            (a.dirs && Object.values(a.dirs).some((s) => s.length > 1))) &&
          !this.hiddenGroups.has(a.group),
      )
    )
      this.dirty = true
    /* The editing hold, taken and let go in ONE place so no gesture has to
     * remember to. Both edges repaint: taking it must show the sprite stopping,
     * and letting it go must show it moving again. */
    const hold = this.assetMode && this.lifePlay && this.liveT >= 0 && this.gestureOnLife()
    if (hold && this.lifeHold === null) {
      // stopped on the reading the drawn offsets came from, not on the wall
      // clock a frame later, so lifeAt hands back the very numbers the pointer
      // grabbed and a scale does not start with a jump
      this.lifeHold = this.liveT
      this.dirty = true
    } else if (!hold && this.lifeHold !== null) {
      // wound back by the length of the gesture, so the behaviour carries on
      // from where it stopped instead of jumping to where the wall clock got to
      this.lifeT0 = performance.now() / 1000 - this.lifeHold
      this.lifeHold = null
      this.dirty = true
    }
    if (!this.dirty && !this.dirtyMask) return
    if (this.dirtyMask) this.bakeLayers()
    this.draw()
    this.dirty = false
  }

  private draw() {
    const g = this.g
    const c = this.canvas
    if (!g || !c) return
    const cw = c.clientWidth
    const ch = c.clientHeight
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.imageSmoothingEnabled = false
    g.clearRect(0, 0, cw, ch)
    if (!this.painting) return
    const { W, H } = this.doc
    const z = this.z
    const ox = Math.round(this.ox)
    const oy = Math.round(this.oy)
    const w = W * z
    const h = H * z

    g.save()
    g.translate(ox, oy)
    /* the board the painting lies on. Drawn under everything, so the margin a
     * grow added reads as bare board instead of as the stage showing through a
     * hole in the map. The shadow is what stops the whole thing floating. */
    g.save()
    g.shadowColor = 'rgba(0,0,0,0.55)'
    g.shadowBlur = 18
    g.shadowOffsetY = 4
    g.fillStyle = BOARD
    g.fillRect(0, 0, w, h)
    g.restore()
    if (this.showCutPreview) {
      // exactly what the game will get: the painting with the cut applied,
      // over a dark checkerboard where the engine's ocean will show through
      const B = 8 * z
      g.fillStyle = '#101318'
      g.fillRect(0, 0, w, h)
      g.fillStyle = '#191d24'
      for (let by = 0; by * B < h; by++)
        for (let bx = (by & 1); bx * B < w; bx += 2)
          g.fillRect(bx * B, by * B, Math.min(B, w - bx * B), Math.min(B, h - by * B))
      if (!this.cutApplied) this.cutApplied = this.buildCutApplied()
      g.drawImage(this.cutApplied, 0, 0, w, h)
    } else {
      g.drawImage(this.painting, 0, 0, w, h)
      if (this.showMask && this.natMask) {
        g.globalAlpha = this.opacity
        g.drawImage(this.natMask, 0, 0, w, h)
        g.globalAlpha = 1
      }
      if (this.showOcc && this.natOcc) g.drawImage(this.natOcc, 0, 0, w, h)
      if (this.natCut) g.drawImage(this.natCut, 0, 0, w, h)
      if (this.showHits && this.natHits) g.drawImage(this.natHits, 0, 0, w, h)
      if (this.tool === 'region' && this.regionHL && !this.walking) g.drawImage(this.regionHL, 0, 0, w, h)
    }
    if (this.assetMode) this.drawAssets(g, z)
    /* the reference pass. Only when the step does NOT own the placements, so the assets step is never
     * drawing them twice, and with no selection box, no handles and no group frame, because none of
     * that can be acted on from here and an outline you cannot grab reads as a bug. */
    else if (this.assetGhost) this.drawAssets(g, z, true)

    if (this.grid && z >= 4) {
      g.strokeStyle = 'rgba(255,255,255,0.09)'
      g.lineWidth = 1
      g.beginPath()
      for (let x = 0; x <= W; x++) {
        g.moveTo(x * z + 0.5, 0)
        g.lineTo(x * z + 0.5, h)
      }
      for (let y = 0; y <= H; y++) {
        g.moveTo(0, y * z + 0.5)
        g.lineTo(w, y * z + 0.5)
      }
      g.stroke()
    }
    if (this.poly.length) {
      const pc = this.tool === 'occ' ? '#c07aff' : this.tool === 'cutpoly' ? '#ff40d0' : '#ffd166'
      g.strokeStyle = pc
      g.lineWidth = 1.5
      g.beginPath()
      this.poly.forEach((p, i) => (i ? g.lineTo(p[0] * z, p[1] * z) : g.moveTo(p[0] * z, p[1] * z)))
      if (this.cursor) g.lineTo((this.cursor[0] + 0.5) * z, (this.cursor[1] + 0.5) * z)
      g.stroke()
      g.fillStyle = this.tool === 'cutpoly' ? '#ff40d0' : '#ffd166'
      for (const p of this.poly) g.fillRect(p[0] * z - 1.5, p[1] * z - 1.5, 3, 3)
    }
    if (this.dragRect) {
      const [a, b, cx, cy] = this.dragRect
      g.strokeStyle = '#ffd166'
      g.lineWidth = 1
      g.strokeRect(
        Math.min(a, cx) * z + 0.5,
        Math.min(b, cy) * z + 0.5,
        (Math.abs(cx - a) + 1) * z - 1,
        (Math.abs(cy - b) + 1) * z - 1,
      )
    }
    // the brush footprint: exactly which native pixels the next click changes
    if (
      this.cursor &&
      !this.walking &&
      (this.tool === 'brush' || this.tool === 'eraser' || this.tool === 'cut' || this.tool === 'cuterase')
    ) {
      const h0 = Math.floor((this.brush - 1) / 2)
      g.strokeStyle = this.tool === 'cut' || this.tool === 'cuterase' ? '#ff40d0' : '#ffffff'
      g.lineWidth = 1
      g.strokeRect((this.cursor[0] - h0) * z + 0.5, (this.cursor[1] - h0) * z + 0.5, this.brush * z - 1, this.brush * z - 1)
    }
    g.strokeStyle = '#6fd08c'
    g.lineWidth = 1
    g.strokeRect(this.doc.spawn[0] * z - 2, this.doc.spawn[1] * z - 2, 5, 5)

    if (this.walking) {
      this.drawWalker(g)
      if (this.doc.occs.length) {
        if (!this.plates) this.bakePlates()
        for (const p of this.plates as { cv: HTMLCanvasElement; baseline: number }[])
          if (this.walker.y < p.baseline) g.drawImage(p.cv, 0, 0, w, h)
      }
    }
    // one claim list per frame, emptied here rather than inside any one drawer,
    // because the whole point of it is that the three drawers share it
    this.plateRects.length = 0
    if (this.eventsVisible && this.doc.events.length) this.drawEvents(g, z)
    if (this.eventsVisible && this.doc.paths.length) this.drawPaths(g, z)
    if (this.eventsVisible && this.doc.framings.length) this.drawFramings(g, z)
    /* THE ROUTE BEING LAID, drawn as it grows with the next leg trailing the cursor. It ignores the overlay toggle, because it only exists while somebody is holding the gesture and an author correcting a line they cannot see is an author guessing. It borrows the selected colour, since the line being laid is by definition the one being worked on. */
    /* THE AREA BEING DRAWN, in the region's own ink so what is under the hand looks like what it is about to become. The two halves look different on purpose: while the button is down it is an open line following the pointer, and the moment they let go it closes and fills, because that fill answers the only question they have. Brighter than a stored area, since it is the one thing on the map not saved yet. */
    if (this.newPoly && this.newPoly.pts.length) {
      const ink = inkFor(ANCHOR_INK, 'region')
      const pts = this.newPoly.pts.map(([px, py]) => [(px + 0.5) * z, (py + 0.5) * z] as Pt)
      g.strokeStyle = ink
      g.lineWidth = 1.5
      g.lineJoin = 'round'
      g.lineCap = 'round'
      g.beginPath()
      pts.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])))
      if (!this.newPoly.drawing) {
        g.closePath()
        g.globalAlpha = 0.28
        g.fillStyle = ink
        g.fill()
        g.globalAlpha = 1
      }
      g.stroke()
      if (!this.newPoly.drawing) {
        g.fillStyle = ink
        for (const q of pts) g.fillRect(q[0] - 1.5, q[1] - 1.5, 3, 3)
      }
    }
    if (this.newPath) {
      const pts = this.newPath.map(([px, py]) => [(px + 0.5) * z, (py + 0.5) * z] as Pt)
      g.strokeStyle = PATH_SEL
      g.lineWidth = 1.5
      g.lineJoin = 'round'
      g.beginPath()
      pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])))
      if (this.cursor) g.lineTo((this.cursor[0] + 0.5) * z, (this.cursor[1] + 0.5) * z)
      g.stroke()
      g.fillStyle = PATH_SEL
      for (const p of pts) g.fillRect(p[0] - 2, p[1] - 2, 4, 4)
    }
    g.restore()

    /* THE BOARD, and the reason it is a board and not a hairline. One 1px rule round the document enclosed about 190px of dead black above the hub's picture, because growCanvas adds transparent margin and never adds picture: only rows 194 to 570 of a 688x640 scene hold an opaque pixel. So the rule said "the map is this tall" while the eye said "the top third failed to load". Two marks now: the board is the DOCUMENT and makes empty margin read as spare board, the brighter rule is the PICTURE. When they agree, which is every map never grown, only one line is drawn. */
    const box = this.paintExtent()
    g.save()
    g.strokeStyle = 'rgba(230,233,238,0.10)'
    g.lineWidth = 1
    g.strokeRect(ox - 0.5, oy - 0.5, w + 1, h + 1)
    if (box) {
      const bx = ox + box.x0 * z
      const by = oy + box.y0 * z
      const bw = (box.x1 - box.x0 + 1) * z
      const bh = (box.y1 - box.y0 + 1) * z
      // within a pixel of the whole document is the same rectangle, and drawing
      // it twice at two brightnesses reads as a rendering fault
      const whole = bw >= w - z && bh >= h - z
      g.strokeStyle = whole ? 'rgba(230,233,238,0.22)' : 'rgba(230,233,238,0.26)'
      g.strokeRect(Math.round(bx) - 0.5, Math.round(by) - 0.5, Math.round(bw) + 1, Math.round(bh) + 1)
    }
    g.restore()
  }

  /* The opaque bounds of the painting, scanned once. Null when the painting is
   * empty or cannot be read back (a cross-origin image would taint the scratch
   * canvas), and every caller treats null as "no opinion" rather than as zero. */
  private paintExtent(): { x0: number; y0: number; x1: number; y1: number } | null {
    if (this.paintBox) return this.paintBox
    const src = this.painting
    if (!src) return null
    const { W, H } = this.doc
    if (W < 1 || H < 1) return null
    let d: Uint8ClampedArray
    try {
      const c = mkCanvas(W, H)
      const cg = c.getContext('2d') as CanvasRenderingContext2D
      cg.drawImage(src, 0, 0)
      d = cg.getImageData(0, 0, W, H).data
    } catch {
      return null
    }
    let x0 = W
    let y0 = H
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        // 8 and not 0, because a coastline feathered by the generator leaves a
        // ring of alpha-2 pixels that no player will ever see and that would
        // otherwise put the rule back on the document edge
        if (d[(y * W + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
    if (x1 < 0) return null
    this.paintBox = { x0, y0, x1, y1 }
    return this.paintBox
  }

  // The placements, y-sorted among themselves and layered over the painting exactly how the game will draw them: anchor 0.5,1 at x,y, axis scales with flips as negative scale, rotation about the feet.
  private drawAssets(g: CanvasRenderingContext2D, z: number, faint = false) {
    const now = performance.now() / 1000
    /* Everyone resolved first, then pushed apart, then drawn, the identical three passes the game runs: every position is a pure function of the clock, so the whole set is knowable at once. A placement that never moves was put on its spot on purpose, and keeping it out of the SET altogether also made it nothing to push off, so a walker went straight through it. It takes part now and its own answer is thrown away, so it pushes and never moves. */
    const t = this.lifeNow()
    /* A REFERENCE HOLDS STILL. The repaint loop only runs itself for the step that owns the
     * placements, so a faint pass is redrawn by whatever else dirties the canvas, which while painting
     * is every stroke. Left animated, the walkers would jump to a new spot on each stroke and the
     * floor would be traced against furniture that keeps moving. So nothing travels and nothing
     * cycles: every placement is drawn where it was put, on its first frame. */
    const movers = faint ? [] : this.doc.assets.filter((a) => this.lifePlay && a.life && !this.hiddenGroups.has(a.group))
    const at = new Map<string, LifeAt>()
    /* the picker reads this very map, so the box you can click is the sprite you can see. Handed over before a pixel is drawn, because the outline, the handles and the group frame read it too, and rebuilt empty every frame so a paused preview leaves nothing behind for a click to trip over. */
    this.liveAt = at
    this.liveT = t
    if (movers.length) {
      const res = movers.map((a) => lifeAt(a.life as Life, t, { x: a.x, y: a.y }, this.standsAt))
      /* the things a mover has to go round: the ones something can get close enough to touch, read off the fences already in the document rather than a list of names. Somewhere nothing can reach is somewhere the fences already keep them apart, and a keep-out circle there would shove people for a reason nobody on screen can see. */
      const free = movers.filter((a) => !(a.life as Life).walkOnly).map((a) => (a.life as Life).bounds)
      const fixed = this.doc.assets
        .filter((a) => !a.life && !this.hiddenGroups.has(a.group) && this.moverCanTouch(a, free))
        .map((a) => ({ x: a.x, y: a.y, r: this.bodyR(a) }))
      // the walk test's walker is one too, because a drawn character is. The hip
      // probe is the body half-width the walk already measures him by, and the
      // one number about the character map.json and MAPVIS both carry.
      if (this.walking) fixed.push({ x: this.walker.x, y: this.walker.y, r: Math.max(BODY_MIN, this.cfg.hip) })
      const pts = [
        ...movers.map((a, i) => ({
          x: a.x + res[i].dx,
          y: a.y + res[i].dy,
          r: this.bodyR(a),
        })),
        /* LISTED TWICE. separate() splits a pair's correction down the middle, so a side that throws its half away leaves the walker half inside it, and paying the discarded half a second time IS the whole correction. Verified over 180000 push vectors against a separate() carrying a real fixed flag: worst difference 1.8e-15px. */
        ...fixed,
        ...fixed,
      ]
      /* the floor guard runs in the caller, not inside separate(), so the slide it does with a push it cannot deliver whole is the same rule here and in the game. Each row says whether the floor is its fence at all, the same answer lifeAt gives it; an immovable row is false because its push is discarded. */
      const fenced = [
        ...movers.map((a) => !!(a.life as Life).walkOnly),
        ...fixed.map(() => false),
        ...fixed.map(() => false),
      ]
      const push = floorPush(pts, separate(pts, this.cfg.yScale, 1), this.standsAt, fenced)
      movers.forEach((a, i) => at.set(a.id, { ...res[i], dx: res[i].dx + push[i].dx, dy: res[i].dy + push[i].dy }))
    }
    /* EVERY ALPHA IN THE LOOP BELOW IS ABSOLUTE, so a globalAlpha set once round the call would be
     * wiped by the first placement that fades or rides ghosted. The base is multiplied through
     * instead, which is the only way a faint pass and a fading behaviour can both be honoured. */
    const base = faint ? 0.38 : 1
    if (faint) g.globalAlpha = base
    for (const a of this.assetsSorted()) {
      // a placement that MOVES is drawn where its behaviour says it is right
      // now, off the same maths the game runs, so what is on screen here is
      // what will be on screen there
      const L = at.get(a.id) || null
      /* A walk cycle is a GAIT. Running it off the clock alone made a figure stood at the end of a leg march on the spot, so it freezes on its first frame while it waits, which is the standing pose the cycle was drawn from. */
      const img = this.assetFrame(a, faint ? 0 : now, L ? L.facing : undefined, L ? L.art : 0, faint ? false : !L || L.moving)
      // an unaccepted sparkle group rides ghosted until the check keeps it
      const ghost = this.proposedGroups.has(a.group)
      if (ghost) g.globalAlpha = base * 0.55
      if (L && L.alpha <= 0.01) {
        if (ghost) g.globalAlpha = base
        continue
      }
      if (L) g.globalAlpha = base * (ghost ? 0.55 : 1) * L.alpha
      if (img) {
        g.save()
        g.translate((a.x + (L ? L.dx : 0)) * z, (a.y + (L ? L.dy : 0)) * z)
        // the placement's own rotation plus whatever tilt its behaviour is leaning through, about the feet where the transform is already centred, so a boat leans on its waterline rather than swinging around its mast.
        g.rotate(a.rot + (L ? L.rot : 0))
        /* The mirror is suppressed for a thing with its own views, because a west view is already drawn facing west and flipping it points it back east. That is a fact about the picture ON SCREEN RIGHT NOW: a troll with eight headings that turns into a single boulder png has to start flipping again the second the boulder is live, and reading a.dirs asked look 0 forever. */
        const noFlip = !!(L && L.flip && !lookOf(a, L.art).dirs)
        g.scale(a.sx * (a.fx !== noFlip ? -1 : 1) * z, a.sy * (a.fy ? -1 : 1) * z)
        g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight)
        g.restore()
      } else {
        // still loading, or the png is gone: a dim box, never nothing
        const c4 = this.assetCorners(a)
        g.strokeStyle = '#8f93f588'
        g.lineWidth = 1
        g.beginPath()
        c4.forEach((p, i) => (i ? g.lineTo(p[0] * z, p[1] * z) : g.moveTo(p[0] * z, p[1] * z)))
        g.closePath()
        g.stroke()
      }
      if (ghost || L) g.globalAlpha = base
    }
    if (faint) {
      g.globalAlpha = 1
      return
    }
    // One picked thing gets its full transform box. Many get a light outline
    // each so you can see exactly what is in the set, plus one frame round the
    // lot with the handles that scale it, the way a slide editor does it.
    const picked = this.selAssets()
    if (picked.length === 1) {
      this.drawTransformBox(g, z, picked[0])
    } else if (picked.length > 1) {
      g.save()
      g.strokeStyle = '#8f93f577'
      g.lineWidth = 1
      for (const a of picked) {
        const c4 = this.assetCorners(a)
        g.beginPath()
        c4.forEach((p, i) => (i ? g.lineTo(p[0] * z, p[1] * z) : g.moveTo(p[0] * z, p[1] * z)))
        g.closePath()
        g.stroke()
        // the feet of each as drawn, the pixel the game y-sorts by
        const [ax, ay] = this.assetOrigin(a)
        g.fillStyle = '#8f93f5aa'
        g.fillRect(Math.round(ax * z) - 1, Math.round(ay * z) - 1, 2, 2)
      }
      g.restore()
      this.drawGroupBox(g, z)
    }
    // under the handles and over the map: it explains the picked thing, so it
    // belongs with the selection chrome rather than with the art
    this.drawLifeBounds(g, z)
    if (this.bandSt) this.drawBand(g, z)
    if (this.cropSt) this.drawCrop(g, z)
    if (this.placing && this.cursor && !this.dragAsset) {
      const it = this.placing
      const img = this.assetImg(it.kind === 'animated' ? (it.frames && it.frames[0]) || '' : it.src || '')
      const s = defaultScale(it)
      const [cx, cy] = this.cursor
      if (img) {
        const dw = img.naturalWidth * s * z
        const dh = img.naturalHeight * s * z
        g.globalAlpha = 0.55
        g.drawImage(img, Math.round(cx * z - dw / 2), Math.round(cy * z - dh), dw, dh)
        g.globalAlpha = 1
      }
      g.strokeStyle = '#8f93f5'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo((cx - 3) * z, cy * z)
      g.lineTo((cx + 3) * z, cy * z)
      g.moveTo(cx * z, (cy - 3) * z)
      g.lineTo(cx * z, (cy + 3) * z)
      g.stroke()
    }
  }

  // The selection's transform box: the rotated outline, four corner handles for uniform scale, four edge handles for one-axis stretch, and the rotate handle off the top edge. Handle sizes are screen px, so they stay grabbable at every zoom.
  private drawTransformBox(g: CanvasRenderingContext2D, z: number, a: PlacedAsset) {
    const { w, h } = this.assetNat(a)
    const c4 = this.assetCorners(a)
    g.strokeStyle = '#8f93f5'
    g.lineWidth = 1.5
    g.beginPath()
    c4.forEach((p, i) => (i ? g.lineTo(p[0] * z, p[1] * z) : g.moveTo(p[0] * z, p[1] * z)))
    g.closePath()
    g.stroke()
    const knob = (p: Pt, s: number) => {
      g.fillStyle = '#16181b'
      g.strokeStyle = '#8f93f5'
      g.lineWidth = 1.5
      g.fillRect(p[0] * z - s / 2, p[1] * z - s / 2, s, s)
      g.strokeRect(p[0] * z - s / 2, p[1] * z - s / 2, s, s)
    }
    for (const p of c4) knob(p, 7)
    knob(this.assetPt(a, -w / 2, -h / 2), 5.5)
    knob(this.assetPt(a, w / 2, -h / 2), 5.5)
    knob(this.assetPt(a, 0, -h), 5.5)
    knob(this.assetPt(a, 0, 0), 5.5)
    // the rotate handle: a stalk off the top edge, a ring at its end
    const top = this.assetPt(a, 0, -h)
    const rp = this.rotHandlePos(a)
    g.strokeStyle = '#8f93f5'
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(top[0] * z, top[1] * z)
    g.lineTo(rp[0] * z, rp[1] * z)
    g.stroke()
    g.fillStyle = '#16181b'
    g.beginPath()
    g.arc(rp[0] * z, rp[1] * z, 4.5, 0, Math.PI * 2)
    g.fill()
    g.lineWidth = 1.5
    g.stroke()
    // the feet as drawn, the pixel the game will y-sort by
    const [ax, ay] = this.assetOrigin(a)
    g.fillStyle = '#8f93f5'
    g.fillRect(Math.round(ax * z) - 1, Math.round(ay * z) - 1, 3, 3)
  }

  /* The box round everything picked, in painting pixels. Built from the drawn
   * corners, so a rotated or flipped placement contributes the space it really
   * occupies rather than its untransformed size. */
  groupBox(): { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number } | null {
    const picked = this.selAssets()
    if (picked.length < 2) return null
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const a of picked)
      for (const [px, py] of this.assetCorners(a)) {
        x0 = Math.min(x0, px)
        y0 = Math.min(y0, py)
        x1 = Math.max(x1, px)
        y1 = Math.max(y1, py)
      }
    return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
  }
  /* the four corner grips of the group frame, in painting pixels */
  private groupHandles(): { x: number; y: number; kx: number; ky: number }[] {
    const b = this.groupBox()
    if (!b) return []
    return [
      { x: b.x0, y: b.y0, kx: -1, ky: -1 },
      { x: b.x1, y: b.y0, kx: 1, ky: -1 },
      { x: b.x1, y: b.y1, kx: 1, ky: 1 },
      { x: b.x0, y: b.y1, kx: -1, ky: 1 },
    ]
  }
  private drawGroupBox(g: CanvasRenderingContext2D, z: number) {
    const b = this.groupBox()
    if (!b) return
    g.save()
    g.strokeStyle = '#8f93f5'
    g.lineWidth = 1
    g.setLineDash([4, 3])
    g.strokeRect(b.x0 * z + 0.5, b.y0 * z + 0.5, (b.x1 - b.x0) * z, (b.y1 - b.y0) * z)
    g.setLineDash([])
    g.fillStyle = '#16181b'
    for (const h of this.groupHandles()) {
      g.beginPath()
      g.rect(h.x * z - 3.5, h.y * z - 3.5, 7, 7)
      g.fill()
      g.stroke()
    }
    g.restore()
  }
  /* The roaming box of whatever is picked, and the ground it may actually use. Neither was ever drawn, so the area a figure would pace was invisible and the only way to find out was to press play and watch. Faint on purpose: this is a thing being explained, not edited. The wash uses the same standsAt the preview and the game run, so the highlighted pixels are exactly the ones a leg can end on. */
  private drawLifeBounds(g: CanvasRenderingContext2D, z: number) {
    // the box a sequence fences with is the LIVE state's, so what is drawn is
    // the fence actually in force this second rather than the first state's
    const picked = this.selAssets()
      .map((a) => this.liveLife(a))
      .filter((l): l is Life => !!l && !!l.bounds)
    if (!picked.length) return
    g.save()
    for (const l of picked) {
      const b = l.bounds!
      if (l.walkOnly) {
        /* only where it can stand, at one dot per pixel, stepped by whole map pixels so the wash lines up with the mask rather than blurring across it, and skipped when zoomed out far enough that it would read as a solid block. */
        if (z >= 1) {
          g.fillStyle = 'rgba(120,220,170,0.20)'
          for (let y = b.y; y < b.y + b.h; y++)
            for (let x = b.x; x < b.x + b.w; x++) if (this.standsAt(x, y)) g.fillRect(x * z, y * z, z, z)
        }
      } else {
        g.fillStyle = 'rgba(143,147,245,0.10)'
        g.fillRect(b.x * z, b.y * z, b.w * z, b.h * z)
      }
      g.strokeStyle = l.walkOnly ? 'rgba(120,220,170,0.75)' : 'rgba(143,147,245,0.75)'
      g.lineWidth = 1
      g.setLineDash([3, 3])
      g.strokeRect(b.x * z + 0.5, b.y * z + 0.5, b.w * z - 1, b.h * z - 1)
      g.setLineDash([])
    }
    g.restore()
  }

  private drawBand(g: CanvasRenderingContext2D, z: number) {
    const b = this.bandSt
    if (!b) return
    const x = Math.min(b.a[0], b.b[0]) * z
    const y = Math.min(b.a[1], b.b[1]) * z
    const w = Math.abs(b.b[0] - b.a[0]) * z
    const h = Math.abs(b.b[1] - b.a[1]) * z
    g.save()
    g.fillStyle = 'rgba(143,147,245,0.14)'
    g.fillRect(x, y, w, h)
    g.strokeStyle = '#8f93f5'
    g.lineWidth = 1
    g.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1))
    g.restore()
  }

  // The crop chrome: the placement's current bounds so the target is obvious,
  // the dragged rectangle in the tool's accent, and everything outside it
  // dimmed so what survives the trim reads at a glance.
  private drawCrop(g: CanvasRenderingContext2D, z: number) {
    const c = this.cropSt
    if (!c) return
    const a = c.id ? this.doc.assets.find((q) => q.id === c.id) : null
    if (c.id && !a) return
    g.save()
    // an area box has no sprite to outline, so the dashed target is skipped and
    // only the dragged rectangle shows
    if (a) {
      const c4 = this.assetCorners(a)
      g.strokeStyle = '#8f93f5aa'
      g.lineWidth = 1
      g.setLineDash([3, 3])
      g.beginPath()
      c4.forEach((p, i) => (i ? g.lineTo(p[0] * z, p[1] * z) : g.moveTo(p[0] * z, p[1] * z)))
      g.closePath()
      g.stroke()
      g.setLineDash([])
    }
    if (c.a && c.b) {
      const x = Math.min(c.a[0], c.b[0]) * z
      const y = Math.min(c.a[1], c.b[1]) * z
      const w = Math.abs(c.b[0] - c.a[0]) * z
      const h = Math.abs(c.b[1] - c.a[1]) * z
      /* A CROP DOES NOT LOOK LIKE A SELECTION, on purpose: selection is the accent iris everywhere else, so a crop borrowing it is a second meaning on one colour. Black frame, eight handles, and what is about to be thrown away goes grey. */
      const crop = !!c.id
      g.fillStyle = crop ? '#0a0b0dcc' : '#05060899'
      g.fillRect(0, 0, this.doc.W * z, y)
      g.fillRect(0, y + h, this.doc.W * z, this.doc.H * z - y - h)
      g.fillRect(0, y, x, h)
      g.fillRect(x + w, y, this.doc.W * z - x - w, h)
      g.strokeStyle = crop ? '#0b0c0e' : '#8f93f5'
      g.lineWidth = crop ? 2 : 1.5
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
      if (crop) {
        // a hairline inside the black, so the frame stays readable against the
        // dark art this map is mostly made of
        g.strokeStyle = '#e8e8eeaa'
        g.lineWidth = 1
        g.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5)
      }
      /* Eight, not four. Four corners can only take a box in diagonally, and
       * trimming one edge is most of what cropping actually is. */
      const grips: [number, number][] = crop
        ? [
            [x, y],
            [x + w / 2, y],
            [x + w, y],
            [x + w, y + h / 2],
            [x + w, y + h],
            [x + w / 2, y + h],
            [x, y + h],
            [x, y + h / 2],
          ]
        : [
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h],
          ]
      for (const [hx, hy] of grips) {
        g.fillStyle = crop ? '#0b0c0e' : '#16181b'
        g.strokeStyle = crop ? '#e8e8ee' : '#8f93f5'
        g.lineWidth = 1
        g.fillRect(hx - 3, hy - 3, 6, 6)
        g.strokeRect(hx - 2.5, hy - 2.5, 5, 5)
      }
    }
    g.restore()
  }

  /* EVERY CAPTION ON THE CANVAS IS PLACED HERE, and it exists because of a measured pile: on the hub's test step three plates all landed inside a 140 by 40 box and drew over each other, so two were unreadable and nothing said which mark owned which words. THE RULE: a plate claims a rectangle, and one that would land on a claimed one steps away from its mark until it is clear, with a leader drawn back down once it has stopped touching. The claim list is emptied once per frame. One face and one size, because these are labels a person reads and not identifiers. */
  private plateRects: [number, number, number, number][] = []

  private static readonly PLATE_FONT = '11px "Archivo Narrow", "Segoe UI", system-ui, sans-serif'

  private plate(g: CanvasRenderingContext2D, text: string, mx: number, my: number, ink: string, up: boolean) {
    g.font = Editor.PLATE_FONT
    const h = 15
    const w = g.measureText(text).width + 12
    // the gap between the mark and the near edge of the plate at rest
    const clear = 7
    let top = up ? my - clear - h : my + clear
    const hit = (t: number) =>
      this.plateRects.some(([rx, ry, rw, rh]) => mx - w / 2 < rx + rw && mx + w / 2 > rx && t < ry + rh && t + h > ry)
    // ten steps is 180px, which is more room than any pile this tool has made,
    // and stopping rather than looping keeps a bad frame cheap
    for (let i = 0; i < 10 && hit(top); i++) top += up ? -(h + 3) : h + 3
    const x = mx - w / 2
    this.plateRects.push([x, top, w, h])
    // the leader, drawn first so the plate sits on top of its own line
    const near = up ? top + h : top
    if (Math.abs(near - my) > clear + 1) {
      g.strokeStyle = ink
      g.lineWidth = 1
      g.globalAlpha = 0.5
      g.beginPath()
      g.moveTo(mx, my)
      g.lineTo(mx, near)
      g.stroke()
      g.globalAlpha = 1
    }
    g.fillStyle = PLATE
    g.beginPath()
    g.roundRect(x, top, w, h, 4)
    g.fill()
    g.strokeStyle = ink
    g.lineWidth = 1
    g.stroke()
    g.fillStyle = ink
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, mx, top + h / 2 + 0.5)
  }

  // The events, drawn in the tool's own chrome (accent iris over panel dark,
  // never a colour the art uses): the activation ring at its real radius, a
  // dot on the anchor, the name on a small plate above.
  /* EVERYTHING AN ANCHOR SAYS ABOUT ITSELF IS ON THE MAP, and none of it waits for a form to be opened: the heading a body holds and which painted thing an anchor is tied to were readable only by opening a compass grid and a dropdown, so an author aiming a post at a table alternated between a picture and a panel to answer one question. THE SELECTED ONE IS LOUD AND THE REST ARE QUIET, because thirty anchors at full strength is a painting nobody can see. */
  private drawEvents(g: CanvasRenderingContext2D, z: number) {
    g.save()
    /* THE SELECTED ONE IS DRAWN LAST, so its plate, its arrow and its tie sit
     * over the quiet ones rather than under whichever anchor happens to come
     * after it in the document. */
    const order = [...this.doc.events].sort(
      (a, b) => Number(a.id === this.anchorSel) - Number(b.id === this.anchorSel),
    )
    for (const ev of order) {
      const sel = ev.id === this.anchorSel
      /* an anchor bound to something that MOVES is drawn where that thing is right now, so the binding is a thing you can watch working rather than a field you take on trust. Read-only: the document still holds the home position, which is what the bundle carries. */
      const home = ev.placement ? this.placementRef(ev.placement) : undefined
      const spot = home ? this.lifeSpot(home) : { x: ev.x, y: ev.y }
      const px = spot.x * z
      const py = spot.y * z
      /* THE INK COMES FROM THE KIND, off the ocean chart's own table. Every anchor was drawn in one iris here while /world drew a door in salmon and a spawn in blue, so the same mark changed colour between the tool that made it and the chart that places it. It also buys what a single hue could not: nine marks on the hub and you can see which are doors without reading nine plates. */
      const ink = inkFor(ANCHOR_INK, ev.kind)
      /* THE TWO STRENGTHS, and they are one number each rather than two colour
       * tables, so a kind's hue never changes with the selection. */
      const line = sel ? 2.5 : 1.25
      const wash = sel ? 0.26 : 0.13
      const quiet = sel ? 1 : 0.85
      g.strokeStyle = ink
      g.lineWidth = line
      g.globalAlpha = quiet
      /* ONE SHAPE IS DRAWN AND IT IS THE LIVE ONE. Drawing every shape an anchor holds puts a radius ring in the middle of a plaza the author walked round: two marks, one of them describing an area the game will not test, and nothing to tell them apart. The others keep their data and are simply not on screen, and a stored shape is hidden while its area is being redrawn. */
      const shape = this.newPoly?.id === ev.id ? 'none' : anchorShape(ev)
      let top = py - ev.r * z
      // where the ring actually landed, so the handle below can be put on it
      let cx = px
      let cy = py
      /* ONE PATH FOR ALL THREE SHAPES, so a box, a ring and a walked outline cannot drift into three different weights. THE FILL AND THE CASING ARE BOTH LOAD-BEARING, measured at 3x: a 1px dashed outline in a mid-tone hue over pixel art of that tone is gone, and the quay's outline sat on sand the same value as itself. The fill says which side is inside and the dark casing separates the line from whatever it lies on. */
      let path: Path2D | null = null
      if (shape === 'rect' && ev.rect) {
        const [x0, y0, x1, y1] = ev.rect
        const ax = Math.min(x0, x1) * z
        const ay = Math.min(y0, y1) * z
        path = new Path2D()
        path.rect(ax, ay, (Math.abs(x1 - x0) + 1) * z, (Math.abs(y1 - y0) + 1) * z)
        top = ay
      } else if (shape === 'poly' && ev.poly) {
        path = new Path2D()
        ev.poly.forEach(([qx, qy], i) =>
          i ? path?.lineTo((qx + 0.5) * z, (qy + 0.5) * z) : path?.moveTo((qx + 0.5) * z, (qy + 0.5) * z),
        )
        path.closePath()
        top = polyBounds(ev.poly)[1] * z
      } else if (shape === 'circle') {
        /* THE RING IS DRAWN WHERE THE AUTHOR PUT IT, not on the anchor's own pixel: for a bound anchor that is the placement's origin, the bottom middle of the art, so an untouched ring on a table sits under its front legs. The offset rides on top of `spot`, so a ring on somebody who paces travels with her. */
        const [rx, ry] = ev.ring ?? [0, 0]
        cx = px + rx * z
        cy = py + ry * z
        path = new Path2D()
        path.arc(cx, cy, ev.r * z, 0, Math.PI * 2)
        top = cy - ev.r * z
      }
      if (path) {
        g.globalAlpha = wash
        g.fillStyle = ink
        g.fill(path)
        g.globalAlpha = sel ? 0.7 : 0.5
        g.strokeStyle = CASE_INK
        g.lineWidth = line + 2
        g.stroke(path)
        g.globalAlpha = quiet
        g.strokeStyle = ink
        g.lineWidth = line
        g.setLineDash(shape === 'circle' ? [4, 3] : shape === 'rect' ? [6, 4] : [])
        g.stroke(path)
        g.setLineDash([])
      }
      /* THE RING'S OWN HANDLE, on the selected anchor only, for the reason a drawn outline's corners are handles: a shape you can correct should look correctable. Square so it cannot be mistaken for the round dot marking the anchor, which it only sits on while the offset is zero. */
      if (sel && shape === 'circle') {
        g.globalAlpha = 1
        g.fillStyle = CASE_INK
        g.fillRect(cx - 4, cy - 4, 8, 8)
        g.fillStyle = ink
        g.fillRect(cx - 3, cy - 3, 6, 6)
      }
      /* THE CORNERS ARE HANDLES AND ARE DRAWN AS SUCH, so a point in the water costs one drag rather than the whole outline. They shrink once a shape has enough points that full-size squares would bury the line. THEY BELONG TO THE SELECTED ONE ALONE, because thirty drawn shapes wearing every corner is a field of squares over the painting and only one can be dragged anyway. */
      if (sel && shape === 'poly' && ev.poly) {
        g.globalAlpha = 1
        g.fillStyle = ink
        const hs = ev.poly.length > 16 ? 1.5 : 2
        for (const [qx, qy] of ev.poly) g.fillRect((qx + 0.5) * z - hs, (qy + 0.5) * z - hs, hs * 2, hs * 2)
        g.globalAlpha = quiet
      }
      /* WHICH PAINTED THING THIS NAME IS ON, drawn rather than filed: a binding was confirmable only by opening the form and reading a dropdown, so an author looking at nineteen people on the hub could not tell which carried a name at all. The bracket is the art's own drawn bounds in the anchor's ink, with a tie up to the mark. */
      if (home) {
        const b = this.drawnBox(home)
        const dx = spot.x - home.x
        const dy = spot.y - home.y
        const bx = (b.x0 + dx) * z
        const by = (b.y0 + dy) * z
        const bw = b.w * z
        const bh = b.h * z
        const tie = new Path2D()
        tie.rect(bx, by, bw, bh)
        tie.moveTo(px, py)
        tie.lineTo(bx + bw / 2, by + bh / 2)
        g.setLineDash([3, 3])
        g.globalAlpha = sel ? 0.6 : 0.4
        g.strokeStyle = CASE_INK
        g.lineWidth = 3
        g.stroke(tie)
        g.globalAlpha = sel ? 0.95 : 0.7
        g.strokeStyle = ink
        g.lineWidth = 1
        g.stroke(tie)
        g.setLineDash([])
        g.lineWidth = line
        g.globalAlpha = quiet
      }
      /* THE ANCHOR'S OWN PIXEL, cased for the reason the zone is: three pixels of
       * a mid hue on pixel art of that hue is nothing. */
      g.globalAlpha = 1
      g.fillStyle = CASE_INK
      g.fillRect(Math.round(px) - 2.5, Math.round(py) - 2.5, 6, 6)
      g.fillStyle = ink
      g.fillRect(Math.round(px) - 1.5, Math.round(py) - 1.5, 4, 4)
      g.globalAlpha = quiet
      /* WHERE A BODY ENDS UP, joined to the thing it stands at by a line, because two loose dots say nothing about which is the table and which is the floor beside it. IT IS FILLED NOW: hollow at a quiet alpha over a painting, the floor spot was the one mark that genuinely could not be found, and it answers the question the zone is drawn for. */
      if (ev.stand) {
        const sx = ev.stand[0] * z
        const sy = ev.stand[1] * z
        g.globalAlpha = 1
        g.setLineDash([2, 2])
        g.strokeStyle = CASE_INK
        g.lineWidth = 3
        g.beginPath()
        g.moveTo(px, py)
        g.lineTo(sx, sy)
        g.stroke()
        g.strokeStyle = STAND_INK
        g.lineWidth = 1
        g.stroke()
        g.setLineDash([])
        const rad = sel ? 4 : 3
        g.beginPath()
        g.arc(sx, sy, rad, 0, Math.PI * 2)
        g.fillStyle = CASE_INK
        g.fill()
        g.beginPath()
        g.arc(sx, sy, rad - 1.2, 0, Math.PI * 2)
        g.fillStyle = STAND_INK
        g.fill()
        this.facingArrow(g, sx, sy, ev.facing, sel)
        g.strokeStyle = ink
        g.lineWidth = line
        g.globalAlpha = quiet
      } else {
        /* NO FLOOR MARKED, so the heading is drawn off the anchor itself, which is where the game aims a body with no stand-at. An arrow that only appeared once somebody had marked a floor would hide the field on exactly the anchors where it is the only thing set. */
        this.facingArrow(g, px, py, ev.facing, sel)
      }
      /* WHAT A PERSON READS, never the identifier: `ev.label || ev.name` prints `quarry_gate` onto the painting the moment nobody has typed a label. It hangs off the top of whatever shape is live rather than off the radius, because a 220px radius would float the caption most of a map away from its region. */
      g.globalAlpha = sel ? 1 : 0.8
      this.plate(g, displayName(ev).text, px, top, ink, true)
      g.globalAlpha = 1
    }
    g.restore()
  }

  /* WHICH WAY A BODY LOOKS WHEN IT GETS HERE, as an arrow on the floor spot. `facing` has been typed, tabled, exported and read by arrival() since anchors shipped, and the only place it was visible was a compass grid inside a form. THE GROUND IS SQUASHED AND THE ARROW IS TOO: a heading is worked out from (dx, dy * yScale), so dividing y by the squash puts the arrow along the line a body walking that heading actually takes. */
  private facingArrow(g: CanvasRenderingContext2D, x: number, y: number, facing: string | undefined, sel: boolean) {
    const v = facing ? FACE_VEC[facing] : undefined
    if (!v) return
    const ys = Math.max(0.05, this.doc.walk.yScale || 0.72)
    let [vx, vy] = [v[0], v[1] / ys]
    const len = Math.hypot(vx, vy) || 1
    vx /= len
    vy /= len
    const gap = sel ? 6 : 5
    const reach = sel ? 16 : 13
    const ang = Math.atan2(vy, vx)
    g.save()
    g.globalAlpha = 1
    g.lineCap = 'round'
    // cased first and then drawn over, the same two passes the zone outline
    // takes, because a green hairline over a green awning is not a heading
    for (const pass of [0, 1]) {
      g.strokeStyle = pass ? STAND_INK : CASE_INK
      g.fillStyle = pass ? STAND_INK : CASE_INK
      g.lineWidth = pass ? (sel ? 2 : 1.5) : (sel ? 4.5 : 4)
      g.beginPath()
      g.moveTo(x + vx * gap, y + vy * gap)
      g.lineTo(x + vx * reach, y + vy * reach)
      g.stroke()
      this.arrowHead(g, x + vx * (reach + 4), y + vy * (reach + 4), ang, pass ? (sel ? 6 : 5) : (sel ? 7.5 : 6.5))
    }
    g.restore()
  }

  // a solid triangle sitting at x,y and pointing along ang. One helper because
  // a two-way route wants the same head twice, once at each end
  private arrowHead(g: CanvasRenderingContext2D, x: number, y: number, ang: number, s: number) {
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x - Math.cos(ang - 0.42) * s, y - Math.sin(ang - 0.42) * s)
    g.lineTo(x - Math.cos(ang + 0.42) * s, y - Math.sin(ang + 0.42) * s)
    g.closePath()
    g.fill()
  }

  /* THE ROUTES. A line nobody can see is a line nobody can correct, and until this drew, a path was six numbers in a list. The arrowhead is most of why it is worth drawing: a route has a direction, and the direction is what is wrong when a ship sails into a berth backwards. A two-way route is dashed with a head at both ends. */
  private drawPaths(g: CanvasRenderingContext2D, z: number) {
    g.save()
    g.lineJoin = 'round'
    g.lineCap = 'round'
    g.font = '10px monospace'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (const p of this.doc.paths) {
      const sel = p.id === this.pathSel
      const col = sel ? PATH_SEL : PATH_COL
      const pts = p.points.map(([x, y]) => [(x + 0.5) * z, (y + 0.5) * z] as Pt)
      if (pts.length < 2) continue
      g.strokeStyle = col
      g.lineWidth = sel ? 2.5 : 1.5
      g.setLineDash(p.twoWay ? [7, 4] : [])
      g.beginPath()
      pts.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])))
      if (p.closed) g.closePath()
      g.stroke()
      g.setLineDash([])
      /* A LEG THAT CROSSES GROUND NOTHING CAN STAND ON, drawn over the route in the same red check reach gives stranded ground. Only the selected route is checked: an author is correcting one line, and reddening every bad leg at once would paint the hub. */
      if (sel && p.kind === 'walk')
        for (const i of this.crossings(p)) {
          const a = pts[i]
          const b = pts[(i + 1) % pts.length]
          g.strokeStyle = PATH_BAD
          g.lineWidth = 3.5
          g.beginPath()
          g.moveTo(a[0], a[1])
          g.lineTo(b[0], b[1])
          g.stroke()
        }
      g.strokeStyle = col
      g.fillStyle = col
      for (const q of pts) g.fillRect(Math.round(q[0]) - 2, Math.round(q[1]) - 2, 4, 4)
      /* the head sits on the last leg, and on the leg BACK to the first point
       * when the route closes, because a loop's direction lives in that leg and
       * a head on a leg that is not walked points the wrong way round. */
      const end = p.closed ? pts[0] : pts[pts.length - 1]
      const before = p.closed ? pts[pts.length - 1] : pts[pts.length - 2]
      this.arrowHead(g, end[0], end[1], Math.atan2(end[1] - before[1], end[0] - before[0]), sel ? 9 : 7)
      if (p.twoWay && !p.closed)
        this.arrowHead(
          g,
          pts[0][0],
          pts[0][1],
          Math.atan2(pts[0][1] - pts[1][1], pts[0][0] - pts[1][0]),
          sel ? 9 : 7,
        )
      // a marked waypoint wears a ring and its name, because a mark is a thing
      // an author tunes against the line and reading it out of a table means
      // counting waypoints on screen by eye
      for (const m of p.marks || []) {
        const q = pts[m.at]
        if (!q) continue
        g.strokeStyle = col
        g.lineWidth = 1.2
        g.beginPath()
        g.arc(q[0], q[1], 5.5, 0, Math.PI * 2)
        g.stroke()
        // a mark's caption hangs BELOW its ring, so it does not fight the route
        // name sitting above the head of the same line
        this.plate(g, displayName(m).text, q[0], q[1] + 5.5, col, false)
      }
      // the name at the head, where the eye already is after following the line
      this.plate(g, displayName(p).text, end[0], end[1] - 6, col, true)
    }
    g.restore()
  }

  /* THE SHOTS: a camera body with a lens, and a dashed tie back to the anchor it hangs off, because a shot and the thing it is a shot OF are two marks in different parts of the map and nothing else says which pairs with which. */
  private drawFramings(g: CanvasRenderingContext2D, z: number) {
    g.save()
    g.font = '10px monospace'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (const f of this.doc.framings) {
      const sel = f.id === this.framingSel
      const col = sel ? SHOT_SEL : SHOT_COL
      const at = this.framingSpot(f)
      const px = at.x * z
      const py = at.y * z
      const on = f.anchor ? this.doc.events.find((e) => e.name === f.anchor) : undefined
      let ang = 0
      if (on) {
        const home = on.placement ? this.placementRef(on.placement) : undefined
        const spot = home ? this.lifeSpot(home) : { x: on.x, y: on.y }
        const ax = spot.x * z
        const ay = spot.y * z
        g.strokeStyle = col
        g.lineWidth = 1
        g.setLineDash([4, 3])
        g.beginPath()
        g.moveTo(px, py)
        g.lineTo(ax, ay)
        g.stroke()
        g.setLineDash([])
        if (ax !== px || ay !== py) ang = Math.atan2(ay - py, ax - px)
      }
      g.fillStyle = '#16181bd9'
      g.strokeStyle = col
      g.lineWidth = sel ? 2 : 1.4
      g.beginPath()
      g.roundRect(px - 8, py - 6, 16, 12, 3)
      g.fill()
      g.stroke()
      // the lens, a stub off the body along the tie
      g.beginPath()
      g.moveTo(px + Math.cos(ang) * 8, py + Math.sin(ang) * 8)
      g.lineTo(px + Math.cos(ang) * 13, py + Math.sin(ang) * 13)
      g.stroke()
      // the arrival shot wears a filled pip, since one of them being the way a
      // player comes in is the one thing about a list of shots you read first
      if (f.entry) {
        g.fillStyle = col
        g.beginPath()
        g.arc(px, py, 2.5, 0, Math.PI * 2)
        g.fill()
      }
      this.plate(g, `${displayName(f).text} · ${f.zoom}x`, px, py - 6, col, true)
    }
    g.restore()
  }

  private drawWalker(g: CanvasRenderingContext2D) {
    const z = this.z
    const W = this.walker
    const px = W.x * z
    const py = W.y * z
    if (thorState === 'idle') loadThor()
    const rig = thorState === 'ready' ? thorRig : null
    if (rig) {
      // the real character, drawn the way the reading side draws it: frames are pre-trimmed to their drawn feet so the bottom edge IS the feet, and the drawn height scales to the document's charH. Drawn slightly smaller than the contract height for test-stage feel only; the exported heightPx and the collision probes stay untouched.
      const ts = (this.cfg.charH * 0.7) / rig.drawnH
      const { rise, stretch } = W.hop()
      const seq = rig.frames[W.facing] || rig.frames.south
      const fr = W.animT > 0 ? seq[1 + (Math.floor(W.animT) % 5)] : seq[0]
      const fw = fr.width * ts * z
      const fh = fr.height * ts * z
      g.save()
      g.fillStyle = 'rgba(6,10,14,0.35)'
      g.beginPath()
      g.ellipse((W.x + 1) * z, (W.y - 2) * z, 15 * ts * z, 5.5 * ts * z, 0, 0, 6.284)
      g.fill()
      // the hop lifts the DRAWING only: the shadow stays on the ground he is
      // still standing on, which is what sells it as a jump rather than a float
      g.drawImage(
        fr,
        Math.round(px - (fw * stretch) / 2),
        Math.round(py - fh * stretch - rise * ts * z),
        fw * stretch,
        fh * stretch,
      )
      // the YOU tag, the game's styling at screen scale: 11px monospace in
      // pale teal over a dark stroke, floating above his head on a soft bob
      const ty =
        (W.y - this.cfg.charH * 0.7 - 3) * z -
        rise * ts * z +
        Math.sin((performance.now() / 1000) * 2.1) * 1.5
      g.font = '11px monospace'
      g.textAlign = 'center'
      g.textBaseline = 'bottom'
      g.lineJoin = 'round'
      g.lineWidth = 3
      g.strokeStyle = '#06282c'
      g.strokeText('YOU', px, ty)
      g.fillStyle = '#baf3ea'
      g.fillText('YOU', px, ty)
      g.restore()
    } else {
      // the capsule: the fallback while the sprites load, or if they never do
      const bodyH = this.cfg.charH * z
      const bodyW = Math.max(3, this.cfg.hip * 2 * z)
      g.save()
      g.fillStyle = 'rgba(6,10,14,0.42)'
      g.beginPath()
      g.ellipse(px, py, bodyW * 0.8, bodyW * 0.3, 0, 0, 6.284)
      g.fill()
      g.fillStyle = W.blocked ? '#ffb3c0' : '#e9edf3'
      g.fillRect(px - bodyW / 2, py - bodyH, bodyW, bodyH)
      g.fillStyle = '#0e1116'
      g.fillRect(px - bodyW / 2, py - bodyH, bodyW, Math.max(1, bodyH * 0.22))
      g.restore()
    }
    // the collision pixel and the two hip probes, drawn at native scale
    g.fillStyle = W.blocked ? '#ff3040' : '#40ff90'
    g.fillRect(Math.round(W.x) * z, Math.round(W.y) * z, z, z)
    g.fillStyle = '#40c8ff'
    g.fillRect(Math.round(W.x - this.cfg.hip) * z, Math.round(W.y - this.cfg.hipDY) * z, z, z)
    g.fillRect(Math.round(W.x + this.cfg.hip) * z, Math.round(W.y - this.cfg.hipDY) * z, z, z)
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = () => rej(new Error('could not load ' + src.slice(0, 80)))
    i.src = src
  })
}

/* ---- The walk-test sprite: the same 48 walk frames the game loads, with the reading side's anchor convention, each frame alpha-scanned and cropped to its drawn feet so bottom-anchoring puts the feet exactly on the collision pixel. Any load failure leaves the capsule in place, so the walk test never goes blind over a missing PNG. */
/* when a heading has no view, the next best one it might have. An object drawn
 * four ways still faces roughly right instead of falling back to south. */
const NEAREST_DIR: Record<string, string> = {
  'south-east': 'east',
  'north-east': 'east',
  'south-west': 'west',
  'north-west': 'west',
  east: 'south-east',
  west: 'south-west',
  north: 'north-east',
  south: 'south-east',
}
const WALK_DIRS = ['south', 'north', 'east', 'west', 'south-east', 'north-east', 'north-west', 'south-west']
const A_MIN = 40 // the repo-wide alpha threshold (shared with the reading side)

interface ThorRig {
  frames: Record<string, HTMLCanvasElement[]>
  drawnH: number
}
let thorRig: ThorRig | null = null
let thorState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'

// crop to rows 0..feet (the canvas padding under the feet is what floats a
// character above the mask; the padding above the head stays, it is trimmed
// out of the scale by using top)
function trimToFeet(img: HTMLImageElement): { cv: HTMLCanvasElement; top: number; feet: number } | null {
  const w = img.naturalWidth
  const h = img.naturalHeight
  const scan = mkCanvas(w, h)
  const sg = scan.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
  sg.drawImage(img, 0, 0)
  const d = sg.getImageData(0, 0, w, h).data
  let top = -1
  let feet = -1
  for (let y = 0; y < h; y++) {
    let hit = false
    for (let x = 0; x < w && !hit; x++) if (d[(y * w + x) * 4 + 3] > A_MIN) hit = true
    if (hit) {
      if (top < 0) top = y
      feet = y
    }
  }
  if (feet < 0) return null
  const cv = mkCanvas(w, feet + 1)
  ;(cv.getContext('2d') as CanvasRenderingContext2D).drawImage(img, 0, 0)
  return { cv, top, feet }
}

function loadThor() {
  if (thorState !== 'idle') return
  thorState = 'loading'
  ;(async () => {
    const frames: Record<string, HTMLCanvasElement[]> = {}
    let drawnH = 67 // the reading side's measured drawn height, the fallback
    await Promise.all(
      WALK_DIRS.map(async (dir) => {
        const imgs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => loadImage(`/walker/${dir}/${i}.png`)))
        frames[dir] = imgs.map((im, i) => {
          const t = trimToFeet(im)
          if (!t) throw new Error(`empty walker frame ${dir}/${i}`)
          if (dir === 'south' && i === 0) drawnH = t.feet - t.top + 1
          return t.cv
        })
      }),
    )
    thorRig = { frames, drawnH }
    thorState = 'ready'
  })().catch(() => {
    thorState = 'failed'
  })
}

// start fetching at module load, so the first press of space already has him
loadThor()
