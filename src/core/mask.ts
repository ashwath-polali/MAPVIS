import type { Life } from './life'
import { defaultCfg, type WalkCfg } from './walk'
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
  /* WHAT CODE CALLS THIS THING, typed by a person and unique in this map.
   * The id above is machine-made: it is 'a' plus a counter, nobody chose it,
   * and it does not survive being deleted and placed again. So it is not an
   * address anybody can write python against, and until this field existed the
   * complete set of addressable things in a bundle was the anchors. Every
   * speaking figure, every fixture and every trophy slot needs to be one.
   *
   * Optional, because almost nothing needs one. Nineteen palms and a gull are
   * scenery and naming each of them would be noise in the only list that
   * matters. Absent means nothing outside this map can address it, which is
   * the honest default. */
  name?: string
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
  /* the extra appearances a sequence switches to, index 1 and up. Absent on
   * everything that does not change. */
  looks?: AssetLook[]
}

/* ONE APPEARANCE of a placement: exactly the four fields that say what to draw.
 * A placement's own src / frames / dirs / fps are look 0, and `looks` holds the
 * extra ones a sequence switches to, so nothing that edits look 0 today has to
 * learn about this. */
export interface AssetLook {
  kind: 'static' | 'animated'
  src?: string
  frames?: string[]
  fps?: number
  dirs?: Record<string, string[]>
}

/* look 0 is the placement itself, so index 1 is looks[0]. That off-by-one lives
 * here and nowhere else. */
export const lookOf = (a: PlacedAsset, i: number): AssetLook =>
  i > 0 && a.looks && a.looks[i - 1]
    ? a.looks[i - 1]
    : { kind: a.kind, src: a.src, frames: a.frames, fps: a.fps, dirs: a.dirs }

/* A placement name is legal to type in python, and is never the shape of a
 * machine id. The second half is not fussiness: the game resolves a placement
 * reference against the names AND the ids, so that a binding made before an
 * author named the thing keeps working. Allowing somebody to name a placement
 * `a55` would let one string mean two different objects on the same map. */
/* TYPE FIRST, and that is not pedantry. String(undefined) is "undefined",
 * which passes the pattern, so an unnamed placement exported as literally named
 * `undefined` and two of them collided on one map. Found by exporting one. */
export const isPlacementName = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(s) && !/^a[0-9]+$/.test(s)

// an asset from an older save or bundle: before the transform fields only
// `scale` existed, so absent ones fill in as the identity transform. Mutates
// and returns the same object so array.map keeps references stable.
export function migrateAsset(a: PlacedAsset): PlacedAsset {
  // a name that is not legal is not a name. Dropped rather than corrected, so
  // nothing downstream can be handed a string a person did not actually type.
  if (typeof a.name !== 'string' || !isPlacementName(a.name)) delete a.name
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
 * it does not know.
 *
 * SINCE ANCHORS: the above described a door and nothing else could be
 * addressed by name. `guide_to("maw_entrance")` has to resolve to something and
 * this tool is the only place that name can be created, so an event grew into
 * an anchor.
 *
 * name and label are separate, and that is the most important line here.
 * `label` is what a player reads on the door prompt. `name` is what code
 * addresses. One string doing both means renaming a door for the player
 * silently breaks a member's island. */
export type AnchorKind = 'point' | 'region' | 'door' | 'post' | 'spawn' | 'trigger'

export const ANCHOR_KINDS: AnchorKind[] = ['point', 'region', 'door', 'post', 'spawn', 'trigger']

export interface MapAnchor {
  id: number
  /* author-typed, unique in this map, shaped like a python identifier so a typo
   * is caught where it is written instead of failing silently at runtime */
  name: string
  kind: AnchorKind
  x: number
  y: number
  r: number
  /* WHERE A BODY ENDS UP WHEN IT USES THIS PLACE, and it is a different pixel
   * from the one above. x,y is the middle of the thing: the centre of the
   * interaction ring, the origin of the prompt, what the objective chevron
   * points at. A chart table's middle is the tabletop, and standing on the
   * tabletop is not what anybody meant. So the author marks the floor beside
   * it, once, and walk_to and an arrival through a door both aim there.
   *
   * Absolute painting pixels, not an offset, because that is what an author
   * clicks. A bound anchor carries it along by the same amount the placement
   * has moved, which is worked out where the following happens rather than
   * stored. Absent means the body aims at x,y, which is what every anchor did
   * before this existed. */
  stand?: [number, number]
  /* region only. THE FOUR NUMBERS ARE [x0, y0, x1, y1], two opposite corners,
   * and not [x, y, w, h]. The schema comment said one thing and the game's own
   * box test did the other, and nothing was authoritative because no rect had
   * ever been authored. The game is the side that already had running code, so
   * the game wins and everything else was moved to it. Order does not matter:
   * both readers take the min and the max. */
  rect?: [number, number, number, number]
  /* door only: the map this leads to */
  to: string
  /* door only: WHICH anchor in that map you arrive at. Without it every door
   * into a map drops the player on its single global spawn, so three connected
   * rooms all land you on the same tile no matter which way you came in. */
  toAnchor?: string
  /* when set, this anchor follows that placement instead of holding still, so
   * dragging an npc takes its post with it and the name survives the edit */
  placement?: string
  /* post only: the heading whatever stands here faces */
  facing?: string
  /* what a player reads. NOT the identity. */
  label: string
  /* author key/values a grape can read */
  meta?: Record<string, unknown>
}

/* Kept so nothing that still says MapEvent has to change. */
export type MapEvent = MapAnchor

/* A name that is legal to type in python. Also used to derive a starting point
 * for a door that only ever had a label, which is every door made before
 * anchors existed. */
export function anchorName(s: string): string {
  const n = String(s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'a$1')
    .slice(0, 48)
  return n || 'anchor'
}

export const isAnchorName = (s: string) => /^[a-z][a-z0-9_]{0,47}$/.test(String(s))

/* A saved route, made safe. Two points is the minimum that means anything, and
 * a mark pointing past the end of the line is dropped rather than carried,
 * because a beat that waits for waypoint nine on a six-point path waits for
 * ever. Returns null for anything that cannot be a path at all. */
export function migratePath(p: MapPath): MapPath | null {
  if (!p || !isAnchorName(p.name)) return null
  const points = (Array.isArray(p.points) ? p.points : [])
    .filter((q) => Array.isArray(q) && q.length === 2 && isFinite(Number(q[0])) && isFinite(Number(q[1])))
    .map((q) => [Math.round(Number(q[0])), Math.round(Number(q[1]))] as [number, number])
  if (points.length < 2) return null
  const marks = (Array.isArray(p.marks) ? p.marks : [])
    .filter((m) => m && isAnchorName(m.name) && isFinite(Number(m.at)))
    .map((m) => ({ at: Math.round(Number(m.at)), name: m.name }))
    .filter((m) => m.at >= 0 && m.at < points.length)
  return {
    id: Math.round(Number(p.id)) || 0,
    name: p.name,
    /* every route saved before kind existed was drawn by somebody laying a line
     * on the ground, so walk is the honest reading of it and not merely the
     * first entry in the list */
    kind: (PATH_KINDS as string[]).includes(p.kind) ? p.kind : 'walk',
    points,
    closed: !!p.closed,
    twoWay: !!p.twoWay,
    ...(p.facing ? { facing: String(p.facing) } : {}),
    ...(marks.length ? { marks } : {}),
    ...(p.meta && typeof p.meta === 'object' ? { meta: p.meta } : {}),
  }
}

/* A saved shot, made safe. A framing has to resolve to somewhere, so one that
 * names neither an anchor nor a point is dropped. Zoom is clamped rather than
 * refused: an author who typed 0 meant "close", not "divide by zero". */
export function migrateFraming(f: MapFraming): MapFraming | null {
  if (!f || !isAnchorName(f.name)) return null
  const anchor = typeof f.anchor === 'string' && isAnchorName(f.anchor) ? f.anchor : ''
  const hasPt = isFinite(Number(f.x)) && isFinite(Number(f.y))
  if (!anchor && !hasPt) return null
  const zoom = isFinite(Number(f.zoom)) ? Math.min(16, Math.max(0.1, Number(f.zoom))) : 1
  return {
    id: Math.round(Number(f.id)) || 0,
    name: f.name,
    anchor,
    ...(hasPt ? { x: Math.round(Number(f.x)), y: Math.round(Number(f.y)) } : {}),
    dx: isFinite(Number(f.dx)) ? Math.round(Number(f.dx)) : 0,
    dy: isFinite(Number(f.dy)) ? Math.round(Number(f.dy)) : 0,
    zoom,
    ...(f.entry ? { entry: true } : {}),
    ...(f.meta && typeof f.meta === 'object' ? { meta: f.meta } : {}),
  }
}

/* An anchor from an older save: absent numbers fill in sane, absent strings
 * empty. Anything saved before anchors existed is a door with no name, so one
 * is derived from its label and marked derived — code written against a
 * derived name is code written against a guess, and the editor says so. */
export function migrateEvent(e: MapAnchor & { type?: string }): MapAnchor {
  e.id = Number(e.id) > 0 ? Math.round(Number(e.id)) : 1
  const legacy = typeof e.type === 'string' ? e.type : ''
  e.kind = (ANCHOR_KINDS as string[]).includes(e.kind)
    ? e.kind
    : legacy === 'door' || !legacy
      ? 'door'
      : 'point'
  e.x = isFinite(Number(e.x)) ? Math.round(Number(e.x)) : 0
  e.y = isFinite(Number(e.y)) ? Math.round(Number(e.y)) : 0
  e.r = Number(e.r) > 0 ? Math.round(Number(e.r)) : 14
  e.label = typeof e.label === 'string' ? e.label : ''
  e.to = typeof e.to === 'string' ? e.to : ''
  if (typeof e.toAnchor !== 'string' || !e.toAnchor) delete e.toAnchor
  if (typeof e.placement !== 'string' || !e.placement) delete e.placement
  if (typeof e.facing !== 'string' || !e.facing) delete e.facing
  // two numbers or nothing: half a point is not a place to stand
  if (Array.isArray(e.stand) && e.stand.length === 2 && e.stand.every((n) => isFinite(Number(n))))
    e.stand = [Math.round(Number(e.stand[0])), Math.round(Number(e.stand[1]))]
  else delete e.stand
  // four numbers or nothing, and they are two corners
  if (Array.isArray(e.rect) && e.rect.length === 4 && e.rect.every((n) => isFinite(Number(n))))
    e.rect = e.rect.map((n) => Math.round(Number(n))) as [number, number, number, number]
  else delete e.rect
  if (!isAnchorName(e.name)) {
    e.name = anchorName(e.label || `${e.kind}_${e.id}`)
    e.meta = { ...(e.meta || {}), derived: true }
  }
  delete (e as { type?: string }).type
  return e
}

export const migrateAnchor = migrateEvent

export interface StairRegion {
  value: number
  connects: [number, number]
  rect: [number, number, number, number]
  px: number
}

export type Pt = [number, number]

/* WHAT KIND OF PLACE A MAP IS. The engine guessed this from whether the
 * painting's border was transparent, on every map, because MAPVIS knew the
 * answer and never wrote it down. `hall` is the third value: a shared space
 * that is neither a club's own island nor a room inside something, and it is
 * the shape anything a member builds for other people to use will take. */
export type MapClass = 'island' | 'room' | 'hall'

export const MAP_CLASSES: MapClass[] = ['island', 'room', 'hall']

/* Everything about the map itself that is not pixels and not a named point.
 *
 * All four of these were missing in different ways. `title` was a real postgres
 * column, machine-filled with the slug, shown on the dashboard and dropped
 * before the export, so every named place a student reads is a slug or a string
 * typed into the game's source. `class` was known and never said. `islandId` is
 * the join between a published map and the school offering behind it, and it
 * lived in a hardcoded Set in the other repo, so shipping a member's island was
 * a source edit and a deploy. `meta` is the author's own bag and there was no
 * map-level one at all, so the only place to hang map-scoped data was a `meta`
 * on some arbitrarily chosen anchor. */
export interface MapProps {
  /* what a player reads. The id is what code addresses, the same split anchors
   * make between name and label, and for the same reason. */
  title: string
  class: MapClass
  /* the school offering this map is about, joining it to a grape */
  islandId: string
  meta: Record<string, unknown>
}

export const defaultProps = (): MapProps => ({ title: '', class: 'island', islandId: '', meta: {} })

/* A NAMED POLYLINE, WHICH IS THE LARGEST THING THIS TOOL COULD NOT SAY.
 *
 * Every anchor is one pixel, so the only route a map could describe was a
 * straight line between two of them. The ship reaching the dock, an actor
 * crossing a room on a line somebody chose rather than a lerp, a patrol that
 * follows a shape, a camera that travels: all of them are this, and all of them
 * were being hand-typed as numbers in the other repo.
 *
 * `marks` is the part that stops a cutscene being retuned every time the text
 * changes. A mark names a waypoint index, so a beat says "be at the doorway by
 * the time this line ends" instead of "walk for 2.4 seconds". */
export interface PathMark {
  /* index into points, so a mark cannot name a waypoint that is not there */
  at: number
  name: string
}

/* WHAT TRAVELS THE LINE, and the thing that decides whether a route crossing
 * open water is a defect or the whole point of it.
 *
 * Until this existed a route was just points, so nothing could be checked: the
 * hub's own the_dock_walk runs over pixels no body can stand on, and the tool
 * had no way to know whether that was a mistake or a boat. A walk line is held
 * to the floor. A sail line is expected to leave it. A camera is a dolly with
 * no feet and is held to nothing. */
export type PathKind = 'walk' | 'sail' | 'camera'

export const PATH_KINDS: PathKind[] = ['walk', 'sail', 'camera']

export interface MapPath {
  id: number
  /* author-typed, unique in this map, python-shaped, exactly like an anchor's */
  name: string
  /* walk unless it says otherwise, because a route drawn by a person clicking
   * ground is a walk until they say it is a boat */
  kind: PathKind
  points: [number, number][]
  /* a patrol returns to its first point; an approach does not */
  closed: boolean
  /* whether walking it backwards is legal. A one-way route is the default,
   * because a sail line into a berth is not a line out of one. */
  twoWay: boolean
  /* the heading to hold on arrival, same vocabulary as an anchor's facing */
  facing?: string
  marks?: PathMark[]
  meta?: Record<string, unknown>
}

/* A NAMED SHOT. Every "point the camera at the thing" beat needs one, and
 * without them every camera move in the game is hand-typed numbers nobody can
 * check without running it.
 *
 * It hangs off an ANCHOR by preference rather than off coordinates, because raw
 * numbers re-break every time a painting is re-cut, which happens on every map.
 * A shot on `coach_post` travels when the coach does; a shot on (412, 208) is
 * wrong the next time the coast is shaved by a pixel.
 *
 * zoom is a real number, not one of the renderer's integer notches. The pull-out
 * shot cannot exist on integer notches, and an authored value the renderer
 * cannot honour is a defect at the renderer rather than a reason to round here. */
export interface MapFraming {
  id: number
  name: string
  /* the anchor this shot is hung on. Empty means it stands on x,y instead. */
  anchor: string
  x?: number
  y?: number
  /* where the camera sits relative to what it is looking at, so the same shot
   * restages at a different anchor and still frames the same way */
  dx: number
  dy: number
  zoom: number
  /* the framing a player gets on arriving in this map, at most one per map */
  entry?: boolean
  meta?: Record<string, unknown>
}

/* only the keys that came back as real numbers, so a corrupt or hand-edited
 * save cannot put NaN into the walk law and stop a character moving at all */
const numbersOnly = (o: Partial<WalkCfg>): Partial<WalkCfg> => {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(o)) if (isFinite(Number(v))) out[k] = Number(v)
  return out as Partial<WalkCfg>
}

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
  /* THE BODY THIS MAP IS DRAWN FOR: six numbers, and the most demanded shape in
   * the authoring sweep. bundle() writes all six into map.json, the game
   * consumes all six, this repo's own walk law reads them and check-anchors
   * reads two back out. They lived on the editor as `cfg = defaultCfg()` and
   * were never assigned again anywhere, with no control and no column, so every
   * map MAPVIS ever produced shipped an 18 px character at 34 px/s on ground
   * squashed 0.72, whether it was a 688 px island seen from far above or a room
   * drawn at character scale. They belong to the document because they describe
   * the map, and living here is what lets one save carry them. */
  walk: WalkCfg = defaultCfg()
  props: MapProps = defaultProps()
  /* routes and shots, both addressed by name and both belonging to the map for
   * the same reason the walk contract does: they describe this painting, so one
   * save has to carry them or they are retyped on every open */
  paths: MapPath[] = []
  pathNext = 1
  framings: MapFraming[] = []
  framingNext = 1
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
  /* HOW DEEP THE UNDO STACK IS, so something outside the document can pin an
   * edit of its own to a point in it.
   *
   * The pixel edits (crop, ctrl+P, trim, palette match) rewrite files on disk,
   * which this document knows nothing about and cannot restore. The panel keeps
   * its own list of those and has to know WHICH z is the one that should undo
   * them, or a crop followed by three moves would be undone by the first z. */
  histLen() {
    return this.hist.length
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
      /* THE OCCLUDER BASELINES, WHICH USED TO BE THROWN AWAY HERE.
       *
       * A baseline is the one hand-set number in the whole depth system: it is
       * the row a character has to be north of before the piece of painting is
       * drawn over him. It reached map.json and the game read it, and this
       * method omitted `occs`, so unpack() rebuilt every one of them from the
       * bottom edge of the polygon on the next open and the typed value was
       * gone. The author watched the field take the number, which is what makes
       * it the nastiest of the fourteen. */
      occs: this.occs,
      occNext: this.occNext,
      walk: this.walk,
      props: this.props,
      paths: this.paths,
      pathNext: this.pathNext,
      framings: this.framings,
      framingNext: this.framingNext,
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
          occs?: Occluder[]
          occNext?: number
          walk?: Partial<WalkCfg>
          props?: Partial<MapProps>
          paths?: MapPath[]
          pathNext?: number
          framings?: MapFraming[]
          framingNext?: number
        }
        /* the saved baselines go in FIRST, because unpack() only invents them
         * when there are none, which is exactly the guard that has to see them
         * already here. A payload written before they were saved has none and
         * unpack rebuilds them the way it always did. */
        if (Array.isArray(d.occs)) {
          this.occs = d.occs
            .filter((o) => o && isFinite(Number(o.id)) && isFinite(Number(o.baseline)))
            .map((o) => ({ id: Math.round(Number(o.id)), baseline: Math.round(Number(o.baseline)) }))
          this.occNext =
            Number(d.occNext) > 0 ? Math.round(Number(d.occNext)) : this.occs.reduce((m, o) => Math.max(m, o.id), 0) + 1
        }
        if (d.walk) this.walk = { ...defaultCfg(), ...numbersOnly(d.walk) }
        if (d.props)
          this.props = {
            title: typeof d.props.title === 'string' ? d.props.title : '',
            class: MAP_CLASSES.includes(d.props.class as MapClass) ? (d.props.class as MapClass) : 'island',
            islandId: typeof d.props.islandId === 'string' ? d.props.islandId : '',
            meta: d.props.meta && typeof d.props.meta === 'object' ? d.props.meta : {},
          }
        /* A ROUTE OR A SHOT FROM A HAND-EDITED SAVE HAS TO COME BACK AS DATA OR
         * NOT AT ALL. A path with one point is not a path and a NaN in a zoom
         * stops a camera dead, so both are filtered on the way in rather than
         * trusted, the same way occs and walk are. */
        this.paths = Array.isArray(d.paths) ? d.paths.map(migratePath).filter((p): p is MapPath => !!p) : []
        this.pathNext =
          Number(d.pathNext) > 0 ? Math.round(Number(d.pathNext)) : this.paths.reduce((m, p) => Math.max(m, p.id), 0) + 1
        this.framings = Array.isArray(d.framings)
          ? d.framings.map(migrateFraming).filter((f): f is MapFraming => !!f)
          : []
        this.framingNext =
          Number(d.framingNext) > 0
            ? Math.round(Number(d.framingNext))
            : this.framings.reduce((m, f) => Math.max(m, f.id), 0) + 1
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
