/* The editor: one canvas, one painting, one mask on top of it.
 *
 * React owns the chrome (the prompt line, the tool strip, the bottom bar).
 * Everything that happens per frame or per pixel happens here, outside React,
 * so a brush stroke never runs a render pass.
 */
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
  anchorName,
  isAnchorName,
  type Pt,
  type PlacedAsset,
  type MapEvent,
  type MapAnchor,
  type AnchorKind,
  type AssetLook,
} from './mask'
import { Walker, canStand, checkReach, defaultCfg, type WalkCfg, type ReachResult } from './walk'
import { savedScene, saveDoc, loadDoc, type LibItem } from '../api'

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

/* How many EXTRA pictures a placement can switch to, which is one per state
 * because a round is at most six states and none of them need name look 0.
 *
 * Six is cleanLife's ceiling on states (src/core/life.ts, the slice inside
 * cleanLife) and the export and the planner route work the same number out the
 * same way (server/api.mjs, STATES_MAX). It is a separate line here only
 * because life.ts does not export it; if that ceiling moves, all three move
 * together or a reopen quietly drops the pictures the round still points at. */
const LOOKS_MAX = 6

/* PERSONAL SPACE: the four numbers the push is made of.
 *
 * These are a verbatim copy of the same four in the game's
 * src/game/pmap/PmapScene.tsx, for the reason life.ts is copied there verbatim:
 * the preview has to work the answer out the way the game does or it is lying
 * about the map. If one changes, copy it again; do not edit one side only.
 * They want to live in life.ts with separate(), and they are here instead only
 * because that file is shared by a hand copy rather than by an import.
 */

/* the smallest body anything gets, in painting pixels. separate() is handed
 * circles, and a circle of no radius is nothing to push off, so every figure
 * carries at least this much of one. It is also the walker used by the reach
 * test below, so the floor is one number in both places. */
const BODY_MIN = 2

/* how much of a body's DRAWN width its keep-out circle is.
 *
 * Half the width is the body itself. A circle exactly that big leaves a pair
 * touching the moment a push cannot be delivered whole, and on this map that is
 * often, so the circle is a fifth wider than the body. Measured on the hub, 30000
 * frames at 1/60, the 17 walking figures against the 21 standing ones, judged by
 * their real half-widths: at 0.5 the bodies still overlapped in 34.36 percent of
 * frames, at 0.6 in 8.59 percent. 0.7 bought nothing more, the same 8.59 percent,
 * while the worst walker-on-walker depth went 4.83px to 6.05px and the worst
 * shift in a single frame 14.79px to 17.27px. */
const BODY_R = 0.6

// the keep-out circle of something whose drawn art is w pixels across
function bodyRadius(w: number) {
  return Math.max(BODY_MIN, (w || 8) * BODY_R)
}

/* HOW WIDE A BODY IS: the ink, not the canvas it was saved on.
 *
 * PixelLab hands back a character centred on a square sheet. The proof bundle's
 * harbour-walker south-0.png is 144x144 holding 52px of actual ink, so reading
 * the canvas gave a body 2.8 times its real width, and at scale 0.3 a figure
 * about 5px across wore a 15.12px keep-out circle. Every figure on the map was
 * several times its own size, the circles overlapped constantly, and the pushes
 * they asked for were larger than any gap on the map could deliver.
 *
 * The columns that hold any opaque pixel are the body. Reading pixels is far too
 * slow to do per frame, so both sides do it once per picture and keep the number
 * against the picture, which cannot change while the picture does not. */
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

/* CAN A WALKER GET CLOSE ENOUGH TO TOUCH IT.
 *
 * A thing that never moves is an obstacle when a walker can reach it, and the
 * old test asked something narrower: whether the thing's OWN FEET stand on
 * ground a walker could stand on. That dropped five standing figures on the hub
 * whose anchor sits a pixel or three off the mask, the gate guard 3.31px off and
 * an old fisherman 2.78px, and a walker with a body a few pixels wide walked
 * straight through them.
 *
 * So the question is the right one now: is there any pixel a walker could stand
 * on inside this thing's circle. The circle is its body plus the smallest body
 * there is, which is the walker, so this is one law with the floor the
 * behaviours are already fenced by and with the radius above. It is measured in
 * separate()'s own geometry, x straight and y unsquashed, because that is the
 * geometry the overlap it is deciding about will be measured in.
 *
 * It reads better than the feet test rather than differently: a thing standing
 * on ground is at distance zero from ground, so everything the old test kept is
 * still kept. On the hub it keeps 20 of the 72 standing placements, the old 16
 * plus the gate guard and the old fisherman the owner complained about, plus two
 * effects that cost nothing: a portal veil no behaviour goes near, and one
 * lighthouse sweep whose nearest standable pixel is 12.32px away against a
 * 12.80px reach, so the deepest shove it can ever ask for is half a pixel.
 *
 * A marginal keep is always a marginal push, by construction, which is what
 * makes this safe to derive from the data instead of from a list of names.
 *
 * It answers for the placements the FLOOR fences, which is the ones lifeAt
 * fences: walkOnly and nothing else. See freeReach below for the rest. */
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

/* AND WHAT A PLACEMENT THE FLOOR DOES NOT FENCE CAN GET TO.
 *
 * The reach test above reads the floor because a walkOnly behaviour reads the
 * floor. A crab told to wander the tideline and a skiff told to drift are not
 * walkOnly, so lifeAt hands them no floor at all and their only fence is the box
 * they were drawn inside. Asking the floor about them answers about somebody
 * else, and the answer it gave was no: the two hub crabs walked clean through a
 * hand cart, two barrels, a wrecked rowboat and a water wash, none of which
 * stands near ground a person can reach, 8.90px into the wash at t=30.88s.
 *
 * So a free behaviour reaches anywhere its own box reaches, which is the same
 * shape of question as the one above and the same fence lifeAt already applies.
 * On the hub it adds exactly those five, taking the standing set from 20 to 25.
 * Measured over 30000 frames at the real half-width of the ink: walker on
 * stander went from 13972 pair-hits on 41.73% of frames to 3334 on 10.81%, and
 * the worst overlap on the map from 8.90px to 6.86px. */
function freeReach(x: number, y: number, r: number, yScale: number, b: LifeBounds | null | undefined) {
  // no box is no fence, so it can be anywhere and everything is reachable
  if (!b) return true
  const reach = r + BODY_MIN
  const ys = yScale || 1
  return x >= b.x - reach && x <= b.x + b.w + reach && y >= b.y - reach * ys && y <= b.y + b.h + reach * ys
}

/* WHAT OF A PUSH CAN ACTUALLY BE DELIVERED.
 *
 * Shoving someone out of a neighbour and into a wall is not an improvement, so
 * a push that would land somewhere it could not stand has to be held back. It
 * used to be thrown away WHOLE, and the worst overlaps on this map are exactly
 * the ones on thin ground: on a narrow quay the shove out of a fishmonger lands
 * in the water, so the figure did not move a pixel and stayed fully inside.
 * Traced on the hub at t=276.97s.
 *
 * So it delivers what it can. The whole vector, then each axis on its own,
 * which is the rule the character himself already walks by, so the map has one
 * law about a move that only partly fits rather than two. A previous try at an
 * axis slide was measured inside the WANDER's leg search and correctly taken
 * back out there, because it moved 19298 of 20000 frames of ordinary walking.
 * This is not that place: a push happens only where two bodies already overlap.
 * Measured here on its own, 30000 frames of the hub: the number of figure-frames
 * shifted more than 4px in one frame fell from 142 to 73, and the worst
 * walker-on-stander depth from 7.20px to 6.86px.
 *
 * AND IT HOLDS BACK ONLY WHAT THE BEHAVIOUR ITSELF IS HELD BACK BY, which is
 * what `fenced` carries. lifeAt puts a placement behind the floor when walkOnly
 * says so and never otherwise (life.ts: `life.walkOnly && canStand`), so a skiff
 * drifting on water is free of the floor for every pixel it travels and was
 * being fenced by it the instant it was pushed. Water is not standable, so every
 * correction those three ever received was thrown away, and they sat inside each
 * other on 30000 of 30000 frames, 11.46px deep, through every version of this
 * guard including the axis slide. Reading each row's own fence instead, measured
 * over 30000 frames at the real half-width of the ink: the worst walker on
 * walker went 11.46px to 5.19px and its pair-hits 66891 to 33820. Nothing lands
 * where its behaviour could not have carried it, because the push is an offset
 * on top of a pure position and is never integrated: across that run no free
 * placement was pushed onto standable ground once, and the furthest any got
 * outside its own box was 8.70px.
 *
 * An immovable row is not fenced either, and does not need to be: its answer is
 * discarded, so no floor test on it could change a pixel.
 *
 * It lives in the caller and not inside separate() because separate() is shared
 * with the editor by a hand copy and both sides have to run the identical rule;
 * the `stands` argument separate() still takes is no longer passed by either.
 */
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
  placing: string
  hiddenGroups: string[]
  proposedGroups: string[]
  events: MapEvent[]
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

// Which group a fresh placement lands in, from the library item's own name.
// The four suggested groups exist even when empty; anything unrecognised is a
// prop. A propose overrides this with the group Claude chose. Exported so the
// generate-here auto-place files its result the same way a click would.
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

export class Editor {
  doc = new MaskDoc(1, 1)
  cfg: WalkCfg = defaultCfg()
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
  placing: LibItem | null = null
  /* Selection is a SET with an anchor.
   *
   * selAsset is the anchor: the one the inspector shows numbers for, the one a
   * handle belongs to when only one thing is picked. It stays a plain property
   * so every path that already sets it keeps working — the setter underneath
   * collapses the set to that one id, which is exactly what a plain click, a
   * paste or a fresh placement means.
   *
   * Everything that acts on "the selection" reads selIds() instead, so one
   * thing and forty things go down the same road. */
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
  /* Where every moving placement's PICTURE is this frame, keyed by id.
   *
   * A behaviour draws a placement at its anchor plus however far it has walked,
   * so the anchor is not where the picture is. The draw works that offset out
   * once a frame and leaves it here; the picker, the handles and the outline all
   * read these same numbers, so a click lands on the sprite that is on screen
   * rather than on an empty box the wander left behind. Asking lifeAt a second
   * time from the picker would answer for a different instant and miss by a
   * pixel or two, which is this same bug again, smaller. */
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
    /* WHICH PART OF THE BOX THE POINTER TOOK, and this is what makes a crop a
     * crop rather than a second selection.
     *
     * '' is the old behaviour and is what an AREA still does: press on empty
     * ground and drag a fresh rectangle out of nothing. A sprite crop never
     * does that. It opens with the box already round the whole picture, and
     * every drag afterwards is one edge or one corner of THAT box moving, which
     * is how a slide editor crops and is the thing everybody already knows.
     * 'move' slides the whole window over the picture without resizing it. */
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
  // one live gesture on the selected placement: moving the body, scaling from
  // a corner (uniform), stretching one axis from an edge, or rotating from
  // the floating handle. The snapshot lands on the first real move, so a bare
  // click never pushes an identical state onto the undo stack.
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
    const lastOcc = this.doc.occs[this.doc.occs.length - 1]
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
      cropping: !!this.cropSt,
      // which of the two it is, so the hint on screen can say the right thing.
      // They are one state and two gestures: a crop takes an existing box in,
      // an area is dragged out of nothing.
      cropKind: this.cropSt ? (this.cropSt.id ? 'crop' : 'area') : '',
      lifePlay: this.lifePlay,
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
    this.regionLabels = null
    this.regionCount = 0
    this.hoverRegion = -1
    this.regionHL = null
    this.placing = null
    this.selAsset = ''
    this.dragAsset = null
    this.nudgeId = ''
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
    // restoreDoc weighs this browser against the platform and takes the newer
    // one; a bundle exported under this id is the last resort. It used to try
    // the browser first unconditionally, which meant a map in a database was
    // never actually read from it.
    try {
      if (!(await this.restoreDoc())) await this.restoreFromDisk()
    } finally {
      this.loading = false
    }
    this.fit()
    this.dirtyMask = true
    this.dirty = true
    this.emit()
  }

  paintingDataURL(): string | null {
    if (!this.painting) return null
    const c = mkCanvas(this.doc.W, this.doc.H)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.drawImage(this.painting, 0, 0)
    return c.toDataURL('image/png')
  }

  fit() {
    if (!this.canvas || !this.painting) return
    const cw = this.canvas.clientWidth
    const ch = this.canvas.clientHeight
    const z = clamp(Math.floor(Math.min(cw / this.doc.W, ch / this.doc.H)), 1, 8)
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
            // a group scale pivots on the corner OPPOSITE the one grabbed, so
            // that corner stays put and the box grows toward the pointer, the
            // way a slide handle behaves. Each member scales by the same factor
            // and its distance from the pivot scales with it, so the whole
            // arrangement grows without drifting apart.
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
    if (this.tool === 'region' && !this.drawing && !this.walking) {
      const id = this.regionAt(x, y)
      if (id !== this.hoverRegion) {
        this.hoverRegion = id
        this.bakeRegionHL()
        this.dirty = true
      }
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
  setBaseline(y: number) {
    const o = this.doc.occs[this.doc.occs.length - 1]
    if (!o) return
    o.baseline = Math.round(y)
    this.plates = null
    this.emit()
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
    this.poly = []
    this.touched()
  }
  setCutTol(n: number) {
    this.cutTol = clamp(Math.round(n), 0, 120)
    this.emit()
  }
  // ---- the region-accept propose ---------------------------------------
  // The app computes flat-ish colour regions off-thread and hands them in
  // here. The editor only ever reads them: hover highlights one, a click
  // assigns the active level to it. No network, no SAM, nothing lands unseen.
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
  // ---- the assets step ---------------------------------------------------
  // Life the painting deliberately left out, placed on top of it. Every
  // mutation snapshots the document first, so z walks placements, drags,
  // scales and clears back exactly like mask strokes.
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
  // ---- the generate-here pick ------------------------------------------
  // One armed click-picker for the context-aware generate: while set, every
  // canvas click hands its painting pixel to the callback instead of the
  // tools, so the app can take a crop there. The callback owns validity (a
  // miss stays armed); esc or right-click cancels with null; the app clears
  // it with pickPoint(null) once a click lands.
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
  // the painting's own pixels around a point, cut pixels dropped to nothing.
  // This is what an effect samples its colours from, and what the sway rule
  // shears: raw rgba, no data url, no decode, so a click can read the palette
  // and render frames in the same tick.
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
  // a crop of the cut-applied painting around a point, the context a
  // generation is given. Up to size px square; the window slides inside the
  // canvas edges instead of shrinking, so it only comes back smaller than
  // size on a painting smaller than size.
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
      /* An AREA is drawn from nothing, so a press starts a new rectangle. A
       * CROP already has one round the whole picture, so a press takes hold of
       * part of it instead. Two gestures, and only one of them ever asks you to
       * draw a box. */
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
      /* dragging moves everything picked, so each one's start point is kept.
       *
       * What the pointer carries is the ANCHOR, offset from the cursor by the
       * same amount it was when the drag began, so the sprite travels exactly
       * as far as the pointer does and the behaviour underneath it is untouched:
       * a walker dragged across the quay goes on walking the same walk, and its
       * roaming box comes with it (moveTo carries the bounds). Dragging the
       * drawn position instead would have to fold the wander into the anchor and
       * the figure would jump the moment the clock moved on. */
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
      // empty painting: start the band. The selection is not cleared yet — a
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
  // ---- the placement transform ------------------------------------------
  // Local space is the png's own pixels with the feet anchor at the origin:
  // x in [-w/2, w/2], y in [-h, 0]. The world transform is flip (negative
  // scale), then axis scale, then rotation about the feet, then the anchor
  // translation — the exact order Pixi composes anchor(0.5,1) sprites, so
  // what the editor shows is what the game draws.
  private assetNat(a: PlacedAsset): { w: number; h: number } {
    const img = this.assetImg(a.kind === 'animated' ? (a.frames && a.frames[0]) || '' : a.src || '')
    if (img) return { w: img.naturalWidth, h: img.naturalHeight }
    return { w: 24, h: 24 }
  }
  /* The feet as DRAWN, which for anything that moves is not a.x,a.y.
   *
   * Everything the pointer touches hangs off this, so the box, the handles and
   * the rotate stalk sit on the sprite. The live tilt rides with it for the same
   * reason: a boat leaning 30 degrees is a box leaning 30 degrees. The live FLIP
   * deliberately does not, because the box is symmetric about the feet so a
   * mirror does not move it, and honouring it would swap which edge handle is
   * "left" every time a figure turned round mid-drag. */
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
    return this.doc.assets.filter((a) => !this.hiddenGroups.has(a.group)).sort((p, q) => p.y - q.y)
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
  /* Align, distribute and stacking order, on the picked set.
   *
   * These read the placements' DRAWN bounds, not their anchors, because that is
   * what the eye lines up: a rotated palm and an upright one share an edge when
   * their painted edges share it, whatever their feet are doing. The anchor is
   * then moved by the same delta the edge needed, so nothing else about the
   * placement changes. */
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
  /* How wide a BODY is, for the separation pass and nothing else.
   *
   * The INK of the placement's own picture times the x scale, which is the
   * number the game uses (PmapScene.tsx, bodyW). Not the canvas the picture was
   * saved on: see inkWidth at the top of this file for what that cost. Not
   * drawnBox either, which is the rotated bounding box: that folds in the height
   * and the rotation, so a tall thing laid on its side would carry a keep-out
   * circle several times its body here and its body's worth in the game, and the
   * tool would be drawing a shove nobody gets. Where a behaviour has walked to is
   * left out for the same reason it is left out of drawnBox: personal space
   * belongs to the placement, and a width that breathed as a boat rocked would be
   * a preview the game does not run.
   *
   * Look 0's first picture, which is the one the game measures too, so a troll
   * and the boulder it becomes shove alike on both sides. */
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
  /* Whether ANYTHING that moves can reach this standing placement, and so
   * whether it is something to go round.
   *
   * Two kinds of mover and each is asked about its own fence: one the floor
   * holds, which is the pixel scan, and one only its box holds, which is a
   * rectangle test. The scan is kept per placement because its answer only moves
   * when the floor or the placement does and touched() empties it for both; the
   * key carries the radius so a picture that was still loading when the question
   * was first asked is asked again once it has arrived. The box test is four
   * comparisons against the handful of free placements on a map, so it is worked
   * out fresh and never has to be invalidated when a life is edited. The caller
   * gathers the free boxes once for the whole frame rather than this walking the
   * document again for every standing placement it is asked about. */
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
  /* Even gaps between the picked things, outermost two held still. Spacing is
   * measured edge to edge rather than centre to centre, so a wide tree and a
   * narrow post end up with the same air between them, which is what "evenly
   * spaced" looks like. */
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
  /* Stacking order. The game y-sorts, so what this really moves is the feet: to
   * put something in front of another thing you stand it lower down the map.
   * Saying that plainly beats a "bring to front" that silently does nothing
   * once the bundle is exported. */
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
    const ys = others.map((a) => a.y)
    const target = dir === 'front' ? Math.max(...ys) + 1 : Math.min(...ys) - 1
    const cur = picked.map((a) => a.y)
    const from = dir === 'front' ? Math.max(...cur) : Math.min(...cur)
    const d = target - from
    if (!d) {
      this.say(dir === 'front' ? 'already in front' : 'already behind')
      return
    }
    this.doc.snap()
    for (const a of picked) a.y = clamp(Math.round(a.y + d), 0, this.doc.H - 1)
    this.touched()
    this.say(dir === 'front' ? `moved in front · ${Math.abs(d)}px down` : `moved behind · ${Math.abs(d)}px up`)
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
  // a library item was deleted on disk: take every placement that used it
  // off the map in one snapshot, so z restores the placements even though
  // the file itself stays gone. Matches by the item's own served url: the
  // png for a static item, the frame folder for an animated one.
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
  // a library item was rewritten in place: every placement of it takes the new
  // frame list and rate. A re-render with more frames leaves the old placements
  // playing a short loop otherwise, and a changed speed leaves them at the old
  // one. One snapshot, so z puts the old timing back.
  refreshPlacementsOf(item: LibItem): number {
    const key =
      item.kind === 'animated'
        ? item.frames && item.frames[0]
          ? item.frames[0].slice(0, item.frames[0].lastIndexOf('/') + 1)
          : ''
        : item.src || ''
    if (!key) return 0
    const mine = (a: PlacedAsset) =>
      a.kind === 'animated' ? !!(a.frames && a.frames[0] && a.frames[0].startsWith(key)) : a.src === key
    const list = this.doc.assets.filter(mine)
    if (!list.length) return 0
    this.doc.snap()
    for (const a of list) {
      if (item.kind === 'animated') {
        a.frames = item.frames ? item.frames.slice() : []
        a.fps = item.fps || 8
      } else {
        a.src = item.src
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
  /* Move a placement, and take its roaming box with it.
   *
   * life.bounds is in painting pixels, absolute, and nothing anywhere used to
   * shift it. So dragging a wanderer across the map left its box behind and the
   * thing walked back to where it had been placed, and duplicating one gave the
   * copy the original's box, which is worse: a row of walkers all pacing the
   * same square. The box is part of the placement, so it rides along.
   *
   * Everything that moves a placement goes through here. Nothing else should
   * write x or y directly on something that might carry life. */
  private moveTo(a: PlacedAsset, nx: number, ny: number) {
    const x = clamp(Math.round(nx), 0, this.doc.W - 1)
    const y = clamp(Math.round(ny), 0, this.doc.H - 1)
    const b = a.life && a.life.bounds
    if (b) {
      // clamped so a box dragged off the edge keeps its size rather than
      // collapsing against the border
      b.x = clamp(Math.round(b.x + (x - a.x)), 0, Math.max(0, this.doc.W - b.w))
      b.y = clamp(Math.round(b.y + (y - a.y)), 0, Math.max(0, this.doc.H - b.h))
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
  // ---- copy and paste ----------------------------------------------------
  // The clipboard holds a detached copy of the placement, not a reference, so
  // deleting the original or loading another painting leaves it intact. It
  // carries the item's own urls, so a paste into another scene still draws as
  // long as those files are there.
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
  /* Paste lands under the cursor when the cursor is over the painting, and just
   * off the originals when it is not, so a paste is never invisible. A pasted
   * SET keeps its arrangement: the copies move as one block, positioned by the
   * block's own top-left, so two palms twenty pixels apart stay twenty pixels
   * apart wherever they land. */
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
  /* MOVE A SET OF PLACEMENTS AS ONE UNDO STEP.
   *
   * A crop that changes every copy has to re-anchor every copy, and doing that
   * through editAsset snapshotted once per placement. Nineteen trees meant
   * nineteen entries on the undo stack, so z put ONE tree back and left the
   * other eighteen sitting where the crop had moved them. Measured on the hub
   * 2026-08-25: 18 of 19 still displaced after a single press.
   *
   * One snapshot, taken before anything moves, and the moves applied straight
   * to the placements after it. That is the same shape as addPlacements and as
   * the multi-select align, which have always been one press to take back. */
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
  // the pixels behind one url were rewritten under the same name: drop the
  // cached image and let the next draw ask for it again with a tag the browser
  // cache can not answer. The stored key stays the clean url, so exports and
  // the bundle contract never see the tag.
  /* An item's pixels were rewritten UNDER ITS OWN NAME at a different size, so
   * every placement of it has to be re-scaled or they all change size on the
   * map. The url did not change, so nothing here can be found by repointing:
   * the placements are matched the same way refreshPlacementsOf matches them,
   * and their scale is multiplied by how much the png shrank.
   *
   * This is the price of editing in place instead of leaving a second copy in
   * the library, and it is worth paying: the library stays one row per thing. */
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
  /* How much of a boxed area is ground a person could stand on, 0..1.
   *
   * This decides whether a behaviour gets one fence or two. A box drawn mostly
   * over walkable ground says the person fenced a PATH, a plaza, a stretch of
   * sand, so the thing should keep to the floor inside it. A box drawn mostly
   * over roofs, water or cliff says they fenced a REGION regardless of ground,
   * so the box alone holds and the floor is not consulted.
   *
   * Sampled on a grid rather than every pixel: a 300x200 box is 60,000 reads
   * and this runs while a gesture is being finished. */
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
  /* the floor probe a behaviour is fenced by, in painting pixels.
   *
   * It has to be the SAME answer the game gives, not a near one: walkOnly
   * wander takes the first standable candidate out of a fixed random sequence,
   * so one disagreement about one candidate forks every leg after it and the
   * two sides never come back together. That means the body test, feet plus two
   * hips, not a single pixel, and it means reading the plane the export
   * actually writes: levelsCanvas zeroes every cut pixel, so ground that is
   * both levelled and cut stands here and is blocked there. */
  standsAt = (x: number, y: number): boolean => {
    if (!canStand(this.doc, this.cfg, x, y)) return false
    const cut = (px: number, py: number) => this.doc.cutAt(Math.round(px), Math.round(py)) > 0
    return !cut(x, y) && !cut(x - this.cfg.hip, y - this.cfg.hipDY) && !cut(x + this.cfg.hip, y - this.cfg.hipDY)
  }

  /* A copy of a moving placement must not march in step with its original.
   *
   * The behaviour is driven entirely by seed and clock, so two copies sharing
   * both are the same creature twice. A fresh seed gives it different targets
   * and a fresh phase starts it somewhere else in its own cycle, which is what
   * turns a pasted row into a crowd instead of a chorus line. */
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
  /* The behaviour a placement is following RIGHT NOW.
   *
   * Without a sequence that is the placement's own life and nothing changes.
   * With one it is whichever state is live at the preview clock, off life.ts's
   * own walk rather than a second copy of it, so the panel and the box agree
   * with what the thing is doing. A state that holds has no behaviour at all. */
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
    /* the behaviour and the pictures it switches to land in ONE undo step, or z
     * leaves half a sequence behind.
     *
     * The pictures given here are the whole truth about this placement, so
     * nothing is kept from before: a troll that was a sequence and is now a
     * plain wander would otherwise carry its boulder into the export, indexed
     * by an art nobody sets any more. */
    if (looks && looks.length) a.looks = looks.map((l) => ({ ...l }))
    else delete a.looks
    this.restartLife()
    this.touched()
    return true
  }
  /* Which way a standing figure looks.
   *
   * Only a view set can answer this, and only one that is standing: a walker
   * faces where it is going and lifeAt decides that every frame, so a chosen
   * facing would be overwritten before it was ever seen.
   *
   * It is one field. Both renderers read the resting heading off the
   * placement's own src, so pointing src at another heading turns the figure in
   * the editor and in the game with nothing else to keep in step.
   */
  faceAsset(ids: string[], heading: string): number {
    const want = new Set(ids)
    const picked = this.doc.assets.filter((a) => want.has(a.id) && a.dirs && a.dirs[heading] && !a.life)
    if (!picked.length) return 0
    this.doc.snap()
    for (const a of picked) a.src = a.dirs![heading][0]
    this.touched()
    return picked.length
  }

  /* One behaviour onto everything picked, which is how a crowd gets made.
   *
   * They share the box, because the box is the place they are milling about in
   * and a market is one place. What they do not share is the seed and the phase:
   * identical numbers make a dozen figures step in perfect time, which reads as
   * one thing rather than twelve people. Each also gets its own copy of the
   * bounds, so dragging one later moves only its own area.
   *
   * One snapshot for the whole set, so z walks the crowd back in one press. */
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
      /* the same pictures for the whole set, each its own copy: one snapshot
       * above already holds the lot, so z walks the crowd back in one press.
       *
       * Whatever they were switching to before goes, for the reason setLife
       * drops it: a crowd re-lifed with a plain wander that kept its old looks
       * would export pictures no art index can ever reach. */
      if (looks && looks.length) a.looks = looks.map((l) => ({ ...l }))
      else delete a.looks
    }
    this.restartLife()
    this.touched()
    return picked.length
  }
  /* THE PREVIEW CLOCK, and the one place anything reads it.
   *
   * It stands still while a living placement is being dragged, scaled, turned or
   * cropped. A sprite whose position is a function of the clock walks out from
   * under the cursor while you are holding it, so you cannot put it anywhere on
   * purpose and the handle you grabbed is somewhere else by the time you have
   * moved a pixel. Coming out of the hold the clock is rewound by however long
   * the gesture took, so nothing jumps the instant the pointer comes up and no
   * behaviour skips a beat. It is an editing gesture and nothing more: it is not
   * saved, not exported, and the game never sees it. */
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
  /* Has a gesture got hold of something that MOVES?
   *
   * Asked every frame rather than latched at pointer-down, so no path can end a
   * gesture and leave the clock stopped: whatever clears the drag or the crop
   * releases the hold on the next frame without having to know it must. */
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
  // ---- crop --------------------------------------------------------------
  // A rectangle dragged over the selected placement in painting space. On
  // enter the four corners of that rectangle go back through the placement's
  // own transform, so the rect the caller receives is in the SOURCE png's
  // pixels however the placement is scaled, flipped or rotated. Nothing is
  // written here: the caller trims the pixels and decides what to do with them.
  // a crop corner, held inside the painting so the dimmed chrome and the rect
  // never run off the canvas when the pointer does
  /* WHICH GRIP A PRESS LANDED ON, in painting pixels.
   *
   * The reach is worked out from the zoom so it is a constant number of screen
   * pixels whatever the map is scaled to: a handle you cannot hit at 1x is the
   * whole gesture failing on the small sprites this is mostly used on. Inside
   * the box and away from every edge means take the whole window and slide it,
   * which is how you re-frame without changing what you kept. */
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

  /* ONE EDGE, OR THE WHOLE WINDOW, MOVED BY HOW FAR THE POINTER HAS COME.
   *
   * Measured as a delta from where the grip was taken rather than by snapping
   * the edge to the cursor, so grabbing an edge slightly off centre does not
   * jump it under your hand.
   *
   * Two fences. It cannot pass the opposite edge, because a box turned inside
   * out is not a crop, and it stays over the picture, because keeping pixels
   * that are not there is nothing. Sliding is clamped as a whole so the window
   * keeps its size and stops at the edge instead of shrinking against it. */
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
  /* Box an area of the PAINTING, not a sprite.
   *
   * Same drag, same overlay, same enter/esc as the crop, because it is the same
   * gesture and a second one would be a second thing to learn. The only
   * difference is what comes back: painting pixels, not a sprite's own pixels.
   * The empty id is what says which. Cancelling hands back null, and the caller
   * carries on without it. */
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
  /* CROP, AND IT IS ITS OWN GESTURE.
   *
   * It used to be the area gesture wearing a different label: the box vanished
   * and you were asked to drag a new one out of nothing, over a sprite that was
   * often a dozen pixels across. Ash on trying it: "when i double click, it asks
   * me to select the area, that is completely wrong."
   *
   * It opens round the whole picture instead, and you take it in by dragging the
   * box's own edges, which is what every slide editor does and is the reason
   * nobody has to be told how. The handles look like resize handles and are not:
   * the picture underneath never changes size, the window over it does.
   *
   * Marking an AREA is left exactly as it was. That one really is "draw a
   * rectangle on the map somewhere", there is nothing to open around, and the
   * two gestures stop being confusable the moment only one of them starts
   * empty. */
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
    /* The box opens round the whole picture now, so pressing enter without
     * touching it asks to crop a thing to its own size: every placement
     * re-anchored, the png rewritten, and not one pixel different. It says so
     * and closes instead. */
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
  /* art is which appearance to draw: 0 is the placement's own pictures, and a
   * sequence names the others. Everything below reads the look rather than the
   * placement, so a thing that never changes takes the same path it always did.
   *
   * moving is the GAIT gate, and it belongs to a view set alone. A walk cycle is
   * what the legs do while the thing travels, so a figure stood at the end of a
   * leg holds the pose it was drawn from. A plain frame list is not a gait: a
   * fire burns and a flag flaps whether or not the thing is going anywhere, and
   * the game has always run those off the clock, so freezing them here made the
   * preview lie about the bundle. */
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
    /* Standing still is not the same as holding one frame. Someone breathing at
     * a stall never travels, so nothing ever handed this a facing and the loop
     * sat on frame zero forever. The heading it rests in is whichever one its
     * own src belongs to, and those frames run on the same clock a walker uses. */
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
  // every cut-fill click a human would make along the border and the
  // transparent edge, made at once. One snapshot first, so one undo takes the
  // whole proposal back. FIXED tolerance, never the slider: at a raised manual
  // tolerance the margin floods walked from sea navy into island rock and
  // proposed half the island (Ash hit this 2026-08-15). One press must behave
  // the same every time; wider grabs belong to the human's cut-fill clicks.
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
  // After a propose, the result must actually be on screen: the cut preview
  // replaces the whole draw with the cut-applied painting, and m can have
  // hidden the levels overlay. Returns true when something had to be flipped,
  // so the caller can say the overlay is now shown.
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
  // stale spawn, so the start point spirals out to the nearest standable pixel — the
  // same validated-spawn law the game's scene applies on load
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
  // ---- events: a spot on the map plus an action ---------------------------
  // The first type is a door. The drop is one undo, the delete is one undo;
  // the form edits between them mutate in place and ride whatever snapshot
  // comes next, so typing a label never floods the history. The workflow
  // turns the overlay on for the steps that read it (test, export).
  eventsVisible = false
  setEventsVisible(on: boolean) {
    if (this.eventsVisible === on) return
    this.eventsVisible = on
    this.dirty = true
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
    })
    this.doc.events.push(e)
    this.touched()
    this.say(`${kind} at ${e.x}, ${e.y} · give it a name code can use`)
    return e.id
  }

  addDoor(x: number, y: number): number {
    return this.addAnchor('door', x, y)
  }

  /* Renaming is the one edit that can break something outside this tool, so it
   * is the one edit that refuses. An empty or illegal name is rejected rather
   * than silently corrected, because a name quietly changed under an author is
   * worse than a name they have to fix. A collision gets suffixed, the way the
   * library does. */
  renameAnchor(id: number, want: string): { ok: boolean; name?: string; why?: string } {
    const e = this.doc.events.find((q) => q.id === id)
    if (!e) return { ok: false, why: 'gone' }
    const trimmed = String(want || '').trim()
    if (!trimmed) return { ok: false, why: 'a name is required · code addresses this' }
    const clean = anchorName(trimmed)
    if (!isAnchorName(clean)) return { ok: false, why: 'letters, digits and underscores, starting with a letter' }
    const free = this.freeAnchorName(clean, id)
    e.name = free
    // an author has now chosen it, so it is no longer a guess derived from a label
    if (e.meta?.derived) {
      const { derived: _drop, ...rest } = e.meta
      e.meta = Object.keys(rest).length ? rest : undefined
    }
    this.touched()
    return { ok: true, name: free, why: free !== clean ? `taken · saved as ${free}` : undefined }
  }

  updateEvent(
    id: number,
    patch: Partial<Pick<MapAnchor, 'label' | 'to' | 'r' | 'toAnchor' | 'kind' | 'facing' | 'placement'>>,
  ) {
    const e = this.doc.events.find((q) => q.id === id)
    if (!e) return
    if (patch.label !== undefined) e.label = patch.label
    if (patch.to !== undefined) e.to = patch.to
    if (patch.r !== undefined) e.r = Math.max(4, Math.min(64, Math.round(patch.r)))
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
    this.touched()
  }
  updateAnchor = this.updateEvent.bind(this)

  /* Bind an anchor to a placement so it moves with it. This is what "a name
   * survives editing" has to mean in practice: coach_post is where the coach
   * stands, and dragging the coach should take the post along rather than
   * leaving a name pointing at bare ground. */
  bindAnchor(id: number, placementId: string | null) {
    const e = this.doc.events.find((q) => q.id === id)
    if (!e) return
    this.doc.snap()
    if (placementId) {
      const a = this.doc.assets.find((q) => q.id === placementId)
      if (!a) return
      e.placement = placementId
      e.x = Math.round(a.x)
      e.y = Math.round(a.y)
      this.say(`${e.name} follows that placement now`)
    } else {
      delete e.placement
      this.say(`${e.name} holds still`)
    }
    this.touched()
  }

  /* Every bound anchor pulled back onto the feet of the thing it follows. Cheap
   * enough to run on any placement move, and it is what keeps the binding
   * honest rather than decorative. */
  syncBoundAnchors() {
    let moved = 0
    for (const e of this.doc.events) {
      if (!e.placement) continue
      const a = this.doc.assets.find((q) => q.id === e.placement)
      if (!a) continue
      const x = Math.round(a.x)
      const y = Math.round(a.y)
      if (e.x !== x || e.y !== y) {
        e.x = x
        e.y = y
        moved++
      }
    }
    return moved
  }

  deleteEvent(id: number) {
    const i = this.doc.events.findIndex((q) => q.id === id)
    if (i < 0) return
    this.doc.snap()
    const [e] = this.doc.events.splice(i, 1)
    this.touched()
    this.say(`removed ${e.name || e.label || 'anchor'} · z undoes`)
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
  /* A rectangle of the painting, on its own, as a png.
   *
   * Two callers want the same pixels at different sizes. The model reads it
   * enlarged, because a 40px strip of pixel art is easier to judge at 2x and
   * nothing downstream cares how big it is. PixelLab takes it as the background
   * to draw into and will not accept more than 192 per side, so that one passes
   * a cap and gets the biggest whole-number scale that fits under it.
   *
   * Whole multiples only, and smoothing off: a resampled pixel is a lie about
   * what is on the map. */
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
      // the placements as the editor holds them; the server rewrites the
      // /library/ urls into the bundle's own assets/ folder and copies pngs
      assets: this.doc.assets,
      map: {
        id: this.sceneId,
        w: this.doc.W,
        h: this.doc.H,
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
        // the events contract: a spot plus an action. A reader that does not
        // know a type skips it; a bundle without the field means none.
        // BOTH shapes ship. anchors[] is the contract the api and python read;
        // events[] is what the game reads today and stays door-only in the
        // exact shape it already parses, so nothing that works stops working.
        anchors: this.doc.events.map((e) => ({
          name: e.name,
          kind: e.kind,
          x: e.x,
          y: e.y,
          r: e.r,
          ...(e.rect ? { rect: e.rect } : {}),
          ...(e.to ? { to: e.to } : {}),
          ...(e.toAnchor ? { toAnchor: e.toAnchor } : {}),
          ...(e.facing ? { facing: e.facing } : {}),
          ...(e.label ? { label: e.label } : {}),
          ...(e.meta && Object.keys(e.meta).length ? { meta: e.meta } : {}),
        })),
        events: this.doc.events
          .filter((e) => e.kind === 'door')
          .map((e) => ({ id: e.id, type: 'door', x: e.x, y: e.y, r: e.r, label: e.label || e.name, to: e.to })),
      },
    }
  }

  private touched() {
    this.dirtyMask = true
    this.dirty = true
    this.changed = true
    this.cutApplied = null
    // whether a walker can reach a standing placement is a question about the
    // floor and about where the thing was put, and this is the one hook both a
    // brush stroke and a drag already run through
    this.reachCache.clear()
    this.emit()
  }

  // ---- expand the map boundary ------------------------------------------
  // Transparent margin growth, one side per press: the painting re-composites
  // onto a larger canvas at the right offset, and every plane, the spawn, the
  // occluder baselines, the placed assets and the walker shift by the same
  // offset. One undo per press. Hard cap 2048x2048, and nothing is ever
  // resampled: the art moves by one integer-offset drawImage.
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
  /* THE PANEL'S CHANCE TO UNDO WHAT THE DOCUMENT CANNOT.
   *
   * A crop is two changes: pixels on disk and anchors in the document. z only
   * ever knew about the second, so undoing one put every placement back around
   * art that was still cropped and the map read as though it had slid. Ash lost
   * nineteen trees to exactly that on 2026-08-25.
   *
   * The hook is asked first and told how deep the stack is, so it can tell its
   * own edit apart from three moves that happened after it. It answers nothing;
   * the document undo runs either way, because the anchors always have to come
   * back whether or not there were pixels to restore with them. */
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
  private saveLocal() {
    const s = this.doc.serialize()
    try {
      localStorage.setItem(this.key(), s)
    } catch {
      // a full quota used to be swallowed here. One map is about two megabytes
      // of utf-16 at 688x384 and a browser gives roughly five, so the third map
      // in one browser stops saving. Silently, which is the part that cost work.
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
  /* Unpack a saved string into this doc. A v3 envelope may describe a grown
   * canvas, so match its base against the painting that just loaded, grow
   * first, then unpack into the grown planes. Shared by every restore path
   * because they only differ in where the string came from. */
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

  /* The disk mirror, read when this browser has nothing. That is a new machine,
   * a cleared browser, or the quota having eaten the local copy. Same string
   * and the same grow-then-unpack order restoreLocal uses, because deserialize
   * ignores the envelope's w/h and unpack refuses a length mismatch. */
  /* Whichever copy is newer wins, and that is the whole difference between a
   * tool and a platform.
   *
   * This used to try localStorage first and only reach for the server when the
   * browser had nothing. On one machine that is right. The moment a map lives
   * in a database it is wrong: opening it here would read this browser forever,
   * a second browser would quietly diverge, and the map would still effectively
   * live in one place.
   *
   * So both are asked, and the server's own clock decides. The browser copy is
   * still what makes the tool work with no network, and it still wins when it
   * is genuinely the newer one, which is what happens after editing offline. */
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
        /* The exported names come back too, so a reopened map keeps them.
         * anchors[] first because it is the richer shape and carries the
         * author-typed name; a bundle exported before anchors existed only has
         * events[], and those migrate into doors with a derived name. */
        const exported = (s.map as { anchors?: unknown[]; events?: unknown[] } | undefined) || {}
        const list = Array.isArray(exported.anchors) ? exported.anchors : exported.events
        if (Array.isArray(list) && list.length) {
          this.doc.events = list.map((e, i) =>
            migrateAnchor({ id: i + 1, ...(e as object) } as MapAnchor & { type?: string }),
          )
          this.doc.eventNext = this.doc.events.reduce((m, e) => Math.max(m, e.id), 0) + 1
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
        /* ONE APPEARANCE, read back: views, then frames, then a bare src, in
         * exactly the order the exporter packs them (server/api.mjs, packLook)
         * and the game loads them. A set of views carries a src as well,
         * pointing at whichever heading came first, so views have to be taken
         * before the src branch claims it and loses the other seven.
         *
         * It runs for the placement itself and again for each extra picture a
         * sequence switches to, so a look comes back exactly the way the
         * placement does. There used to be two copies of this precedence, one
         * for look 0 and one for the rest, and only one of them was right. */
        type LookRec = { src?: string; frames?: string[]; fps?: number; dirs?: Record<string, string[]> }
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
            if (keys.length) return { kind: 'static', dirs: views, src: (views.south || views[keys[0]])[0], ...(fps ? { fps } : {}) }
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
          }
          // how it MOVES comes back too, through the same guard every other
          // caller uses. Dropping it was what silently deleted every behaviour
          // on a reopen-and-re-export.
          const life = cleanLife(d.life)
          if (life) base.life = life
          /* and the extra pictures a sequence switches to.
           *
           * A look that resolves to NOTHING KEEPS ITS SLOT, holding look 0.
           * art is an index, so dropping one here shifts every later look down
           * and the placement then draws the wrong picture rather than a
           * missing one: a troll whose looks were [gone, boulder] with states
           * at art 1 and 2 comes back with the boulder at index 1 and art 2
           * falling off the end, so both states draw something nobody asked
           * for. The exporter holds the slot this way (server/api.mjs) and so
           * does the game reader (PmapScene), so all three sides agree that a
           * look that did not arrive shows the thing the way it started.
           *
           * Dropping the list entirely would delete every look on a
           * reopen-and-re-export and turn the troll back into one boulder
           * forever, which is the same bug life and dirs already shipped once. */
          const looks: AssetLook[] = []
          for (const L of Array.isArray(d.looks) ? d.looks.slice(0, LOOKS_MAX) : []) looks.push(readLook(L) || look0)
          if (looks.length) base.looks = looks
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
    for (let i = 0; i < this.doc.lvl.length; i++) {
      const v = this.doc.lvl[i]
      const c = colOf(v)
      p[i * 4] = c[0]
      p[i * 4 + 1] = c[1]
      p[i * 4 + 2] = c[2]
      p[i * 4 + 3] = v === 0 ? 0 : 255
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
    if (this.eventsVisible && this.doc.events.length) this.drawEvents(g, z)
    g.restore()

    // frame edge, so the painting's bounds are readable against the backdrop
    g.strokeStyle = 'rgba(255,255,255,0.14)'
    g.lineWidth = 1
    g.strokeRect(ox - 0.5, oy - 0.5, w + 1, h + 1)
  }

  // The placements, y-sorted among themselves and layered over the painting,
  // exactly how the game will draw them: anchor 0.5,1 at x,y, axis scales
  // with flips as negative scale, rotation about the feet. The selection's
  // transform box rides over everything; the armed item ghosts under the
  // cursor.
  private drawAssets(g: CanvasRenderingContext2D, z: number) {
    const now = performance.now() / 1000
    /* Everyone resolved first, then pushed apart, then drawn.
     *
     * Two figures wandering one quay used to walk through each other. Avoidance
     * needs to know where the others are, and it can: every position here is a
     * pure function of the clock, so the whole set is knowable at once. Resolve,
     * separate, draw. The game runs the identical three passes.
     *
     * A placement that never moves was put on its spot on purpose and must never
     * be shoved off it. Keeping it out of the push altogether is how that was
     * done, and it is half right: out of the SET, it is also nothing to push off,
     * so a walker went straight through it. It takes part now and its own answer
     * is thrown away, so it pushes and never moves. */
    const t = this.lifeNow()
    const movers = this.doc.assets.filter((a) => this.lifePlay && a.life && !this.hiddenGroups.has(a.group))
    const at = new Map<string, LifeAt>()
    /* the picker reads this very map, so the box you can click is the sprite you
     * can see. Handed over before a single pixel is drawn, because the chrome
     * further down (the outline, the handles, the group frame) reads it too, and
     * rebuilt empty every frame so a paused preview or a hidden group leaves
     * nothing behind for a click to trip over. */
    this.liveAt = at
    this.liveT = t
    if (movers.length) {
      const res = movers.map((a) => lifeAt(a.life as Life, t, { x: a.x, y: a.y }, this.standsAt))
      /* the things a mover has to go round: the ones something can get close
       * enough to touch, which is the fences already in the document rather than
       * a list of names, and the same fences the behaviours are held by.
       * Somewhere nothing can ever reach is somewhere the fences are already
       * keeping them apart, and a keep-out circle there would only shove people
       * for a reason nobody on screen can see. See walkerCanReach and freeReach
       * at the top of this file for why it is a reach and not the feet, and for
       * what the pair keeps on the hub. */
      const free = movers.filter((a) => !(a.life as Life).walkOnly).map((a) => (a.life as Life).bounds)
      const fixed = this.doc.assets
        .filter((a) => !a.life && !this.hiddenGroups.has(a.group) && this.moverCanTouch(a, free))
        .map((a) => ({ x: a.x, y: a.y, r: this.bodyR(a) }))
      // the walk test's walker is one too, because the game's Thor is. The hip
      // probe is the body half-width the walk already measures him by, and the
      // one number about the character map.json and MAPVIS both carry.
      if (this.walking) fixed.push({ x: this.walker.x, y: this.walker.y, r: Math.max(BODY_MIN, this.cfg.hip) })
      const pts = [
        ...movers.map((a, i) => ({
          x: a.x + res[i].dx,
          y: a.y + res[i].dy,
          r: this.bodyR(a),
        })),
        /* LISTED TWICE. separate() splits a pair's correction down the middle,
         * so a side that throws its half away leaves the walker half inside it.
         * It is not an approximation of a fixed flag inside separate(); a pair
         * splits evenly, so paying the discarded half a second time IS the whole
         * correction. Verified over 180000 push vectors against a separate()
         * carrying a real fixed flag: worst difference 1.8e-15px. */
        ...fixed,
        ...fixed,
      ]
      /* the floor guard runs in the caller, not inside separate(), so that the
       * slide it does with a push it cannot deliver whole is the same rule here
       * and in the game. See floorPush at the top of this file.
       *
       * Each row says whether the floor is its fence at all, which is the same
       * answer lifeAt gives it: walkOnly and nothing else. An immovable row is
       * false because its push is discarded, so no test on it can move a pixel. */
      const fenced = [
        ...movers.map((a) => !!(a.life as Life).walkOnly),
        ...fixed.map(() => false),
        ...fixed.map(() => false),
      ]
      const push = floorPush(pts, separate(pts, this.cfg.yScale, 1), this.standsAt, fenced)
      movers.forEach((a, i) => at.set(a.id, { ...res[i], dx: res[i].dx + push[i].dx, dy: res[i].dy + push[i].dy }))
    }
    for (const a of this.assetsSorted()) {
      // a placement that MOVES is drawn where its behaviour says it is right
      // now, off the same maths the game runs, so what is on screen here is
      // what will be on screen there
      const L = at.get(a.id) || null
      /* A walk cycle is a GAIT. A wander is mostly pauses, and running the cycle
       * off the clock alone made a figure stood at the end of a leg march on the
       * spot. Frozen on its first frame while it waits, which is the standing
       * pose the cycle was drawn from. Which picture, and whether the gait runs,
       * both come off the behaviour; assetFrame holds the rest. */
      const img = this.assetFrame(a, now, L ? L.facing : undefined, L ? L.art : 0, !L || L.moving)
      // an unaccepted sparkle group rides ghosted until the check keeps it
      const ghost = this.proposedGroups.has(a.group)
      if (ghost) g.globalAlpha = 0.55
      if (L && L.alpha <= 0.01) {
        if (ghost) g.globalAlpha = 1
        continue
      }
      if (L) g.globalAlpha = (ghost ? 0.55 : 1) * L.alpha
      if (img) {
        g.save()
        g.translate((a.x + (L ? L.dx : 0)) * z, (a.y + (L ? L.dy : 0)) * z)
        // the placement's own rotation, plus whatever tilt its behaviour is
        // leaning through right now. Rotating about the feet, which is where the
        // transform is already centred, so a boat leans on its waterline rather
        // than swinging around its mast.
        g.rotate(a.rot + (L ? L.rot : 0))
        /* The mirror is suppressed for a thing that has its own views, because a
         * west view is already drawn facing west and flipping it points it back
         * east. That is a fact about the picture ON SCREEN RIGHT NOW, not about
         * the placement: a troll drawn with eight headings that turns into a
         * single boulder png has to start flipping again the second the boulder
         * is live. Reading a.dirs asked look 0 forever, so the boulder faced one
         * way here and the other way in the game, which is the preview lying. */
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
      if (ghost || L) g.globalAlpha = 1
    }
    // One picked thing gets its full transform box. Many get a light outline
    // each so you can see exactly what is in the set, plus one frame round the
    // lot with the handles that scale it — the way a slide editor does it.
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

  // The selection's transform box: the rotated outline, four corner handles
  // (uniform scale), four edge handles (one-axis stretch), and the rotate
  // handle floating off the top edge. Handle sizes are screen px, so they
  // stay grabbable at every zoom.
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
  /* The roaming box of whatever is picked, and the ground it may actually use.
   *
   * A wander is a box plus, when the box is mostly walkable, the floor inside it.
   * Neither was ever drawn, so the area a figure would pace was invisible and
   * the only way to find out was to press play and watch. Faint on purpose: this
   * is a thing being explained, not a thing being edited.
   *
   * The walkable wash uses the same standsAt the preview and the game run, so
   * the highlighted pixels are exactly the ones a leg can end on. */
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
        /* only where it can stand, at one dot per pixel. Stepped by whole map
         * pixels so the wash lines up with the mask rather than blurring across
         * it, and skipped entirely when zoomed out far enough that it would
         * read as a solid block. */
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
      /* A CROP DOES NOT LOOK LIKE A SELECTION, on purpose. Selection is the
       * accent iris everywhere else in this tool, so a crop borrowing it is a
       * second meaning on one colour and the only way to tell them apart is to
       * remember which mode you are in. Black frame, eight handles, and what is
       * about to be thrown away goes grey. */
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

  // The events, drawn in the tool's own chrome (accent iris over panel dark,
  // never a colour the art uses): the activation ring at its real radius, a
  // dot on the anchor, the name on a small plate above. Test and export show
  // them; the paint steps stay clean.
  private drawEvents(g: CanvasRenderingContext2D, z: number) {
    g.save()
    for (const ev of this.doc.events) {
      const px = ev.x * z
      const py = ev.y * z
      g.strokeStyle = '#8f93f5'
      g.lineWidth = 1.5
      g.setLineDash([4, 3])
      g.beginPath()
      g.arc(px, py, ev.r * z, 0, Math.PI * 2)
      g.stroke()
      g.setLineDash([])
      g.fillStyle = '#8f93f5'
      g.fillRect(Math.round(px) - 1, Math.round(py) - 1, 3, 3)
      const label = ev.label || 'door'
      g.font = '11px monospace'
      const tw = g.measureText(label).width
      const ty = py - ev.r * z - 6
      g.beginPath()
      g.roundRect(px - tw / 2 - 5, ty - 15, tw + 10, 16, 5)
      g.fillStyle = '#16181bd9'
      g.fill()
      g.lineWidth = 1
      g.stroke()
      g.fillStyle = '#c9cbf8'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(label, px, ty - 7)
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
      // the real character, drawn the way PmapScene draws him: frames are
      // pre-trimmed to their drawn feet so the bottom edge IS the feet, and
      // his drawn height scales to the document's charH. Idle shows frame 0,
      // walking cycles frames 1-5 on the walker's own clock. Drawn slightly
      // smaller than the contract height (test-stage feel only, Ash 2026-08-16);
      // the exported heightPx and the collision probes stay untouched.
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

/* ---- Thor, the walk-test sprite ----------------------------------------
 * The same 48 walk frames the game loads (public/thor/<dir>/<i>.png, copied
 * from the game repo's /art/characters/thor/walk), with PmapScene's anchor
 * convention: each frame is alpha-scanned and cropped to its drawn feet, so
 * drawing it bottom-anchored puts the feet exactly on the collision pixel,
 * and the drawn height of the standing south frame is what charH scales
 * against. Any load failure leaves the capsule in place; the walk test never
 * goes blind over a missing PNG. */
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
const THOR_DIRS = ['south', 'north', 'east', 'west', 'south-east', 'north-east', 'north-west', 'south-west']
const A_MIN = 40 // the repo-wide alpha threshold (PmapScene, objmap/measure.ts)

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
    let drawnH = 67 // PmapScene's measured drawn height, the fallback
    await Promise.all(
      THOR_DIRS.map(async (dir) => {
        const imgs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => loadImage(`/thor/${dir}/${i}.png`)))
        frames[dir] = imgs.map((im, i) => {
          const t = trimToFeet(im)
          if (!t) throw new Error(`empty thor frame ${dir}/${i}`)
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
