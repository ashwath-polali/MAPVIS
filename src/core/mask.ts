import type { Life } from './life'
import { defaultCfg, type WalkCfg } from './walk'
/* The mask document: walkable ground, elevation levels, occluders. Pixel ops kept exact from the harbor authoring tool: no antialiasing, whole pixels. Encoding: 0 blocked, 40/60/80/100 the plateaus, 50/70/90 the ramps, and a step is legal at |a-b| <= 10, so two plateaus only connect through the stair painted between them. */

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

/* AN OUTLINE THAT WAS DRAWN, KEPT. Three tools take polygon points and all three rasterize and clear, so one outline was traced by hand for the level, the cut and the occluder. The planes stay the only truth; a stencil is a stencil. */
export interface Stencil {
  id: number
  pts: [number, number][]
}
// no more than this many, newest first, so the list stays a tool and not a log
export const STENCIL_KEEP = 12

/* A placed asset. x,y is the FEET anchor in painting pixels (sprite anchor 0.5, 1) and the game y-sorts by y. `scale` is the legacy uniform field kept equal to sx so older readers stay alive. Urls here are the editor's own; export rewrites them to the bundle's assets/ folder. */
export interface PlacedAsset {
  id: string
  /* WHAT CODE CALLS THIS THING, typed and unique in this map, because the id is 'a' plus a counter that does not survive being deleted and placed again. Optional: nineteen palms are scenery, and absent means nothing outside this map can address it. */
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
  /* WHAT LOOK 0 IS CALLED. It cannot live on AssetLook because look 0 is the placement's own src/frames/dirs, so without this an author could name the boulder and not the troll it turns back into. */
  lookName?: string
  /* WHEN THIS THING IS THERE AT ALL: MAPVIS declares the condition, python decides what it means. An opaque string this tool never looks inside, because an evaluator here would move half the game's progression into a map editor. */
  when?: string
  /* WHAT THIS THING BLOCKS ON THE GROUND, as [cx, cy, rx, ry] round the feet anchor. An ellipse because the ground is squashed by yScale. Absent means measured, which is the right default and nearly always better. */
  foot?: [number, number, number, number]
}

/* ONE APPEARANCE of a placement: the four fields that say what to draw. A placement's own src/frames/dirs/fps are look 0 and `looks` holds the extra ones. */
export interface AssetLook {
  kind: 'static' | 'animated'
  src?: string
  frames?: string[]
  fps?: number
  dirs?: Record<string, string[]>
  /* WHAT A PERSON CALLS THIS FACE, kept BESIDE the index and never instead of it: lifeAt runs per placement per frame and a name would be a search where a number is a lookup. The positional packing is untouched. */
  name?: string
}

/* THE NAME OF A FACE OR A SET STATE, deliberately the anchor rule: one namespace shape across every name is worth more than the freedom a looser rule would buy. A hyphenated library row is folded through anchorName rather than refused. */
export const isLookName = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(s)

/* THE NAME A PICTURE ALREADY HAS, read off the url, because the life panel resolves a name to an index and throws the word away. Two path shapes, neither a guess; anything else answers nothing, since a wrong name is worse than no name once python writes against it. NOT assetLabel, which answers the HEADING for a face. */
export function lookNameFrom(look: {
  src?: string
  frames?: string[]
  dirs?: Record<string, string[]>
}): string | undefined {
  const url =
    look.src ||
    (look.frames && look.frames[0]) ||
    (look.dirs && Object.values(look.dirs).find((v) => v && v.length)?.[0]) ||
    ''
  const parts = String(url).split('?')[0].split('/').filter(Boolean)
  const si = parts.lastIndexOf('states')
  const raw =
    si >= 0 && parts[si + 2]
      ? parts[si + 2]
      : (() => {
          const li = parts.lastIndexOf('library')
          return li >= 0 && parts[li + 1] ? parts[li + 1].replace(/\.png$/i, '') : ''
        })()
  if (!raw) return undefined
  const n = anchorName(decodeURIComponent(raw))
  return isLookName(n) ? n : undefined
}

/* EVERY FACE BY NAME, indexed the way `art` indexes them: slot 0 is the placement's own picture. An empty string is a face nobody named and holds its slot. Empty array when nothing is named, so a bundle grows no field. */
export function lookNames(a: {
  lookName?: string
  looks?: { name?: string }[]
}): string[] {
  const out = [isLookName(a.lookName) ? a.lookName : '']
  for (const L of a.looks || []) out.push(isLookName(L?.name) ? (L.name as string) : '')
  return out.some((n) => n) ? out : []
}

/* look 0 is the placement itself, so index 1 is looks[0]. That off-by-one lives
 * here and nowhere else. */
export const lookOf = (a: PlacedAsset, i: number): AssetLook =>
  i > 0 && a.looks && a.looks[i - 1]
    ? a.looks[i - 1]
    : { kind: a.kind, src: a.src, frames: a.frames, fps: a.fps, dirs: a.dirs }

/* A placement name is legal python and is never the shape of a machine id. The game resolves a reference against names AND ids, so allowing `a55` would let one string mean two objects on one map. */
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
  /* THE FACE NAMES, DROPPED RATHER THAN CORRECTED: a name a person did not type is one their python will miss on. The look itself is never removed, because art counts through the slots and dropping one shifts every later face down. */
  if (!isLookName(a.lookName)) delete a.lookName
  for (const L of a.looks || []) if (L && !isLookName(L.name)) delete L.name
  // an opaque string MAPVIS never reads. Whitespace-only is nothing, because a
  // condition of " " would refuse a placement for ever with nothing to read
  if (typeof a.when !== 'string' || !a.when.trim()) delete a.when
  else a.when = a.when.trim().slice(0, 240)
  return a
}

// the short human name of a placement: the png's basename, or the frame
// folder's name for an animated one
export const assetLabel = (a: PlacedAsset): string => {
  const f = a.src || (a.frames && a.frames[0]) || ''
  const parts = f.split('/')
  /* A set of VIEWS lives in a folder like an animation, so its name is the folder and not the file. Without this the label came back as the view it pointed at, so ctrl+P, ctrl+T, crop and the palette lock all silently did nothing. */
  if (a.kind === 'animated' || (a.dirs && Object.keys(a.dirs).length)) return parts[parts.length - 2] || a.id
  return (parts[parts.length - 1] || a.id).replace(/\.png$/i, '')
}

/* An anchor: a spot on the map plus what it is for. `type` stays an open string so a later kind rides the same list. name and label are separate and that is the most important line here: label is what a player reads, name is what code addresses, and one string doing both means renaming a door for the player breaks a member's island. */
export type AnchorKind = 'point' | 'region' | 'door' | 'post' | 'spawn' | 'trigger'

export const ANCHOR_KINDS: AnchorKind[] = ['point', 'region', 'door', 'post', 'spawn', 'trigger']

/* THE THREE SHAPES A ZONE CAN BE, one live at a time, and EVERY KIND HAS ONE. Gated to region, a table against a wall got a circle hanging over the pit behind it and a door got a ring instead of the doormat you can stand on. */
export type AnchorShape = 'circle' | 'rect' | 'poly'

export const ANCHOR_SHAPES: AnchorShape[] = ['circle', 'rect', 'poly']

export interface MapAnchor {
  id: number
  /* author-typed, unique in this map, shaped like a python identifier so a typo
   * is caught where it is written instead of failing silently at runtime */
  name: string
  kind: AnchorKind
  x: number
  y: number
  r: number
  /* WHERE A BODY ENDS UP WHEN IT USES THIS PLACE, a different pixel from x,y: x,y is the middle of the thing, and a chart table's middle is the tabletop. Absolute painting pixels because that is what an author clicks. Absent means the body aims at x,y. */
  stand?: [number, number]
  /* WHICH OF THE THREE SHAPES THE AUTHOR MEANS. Exclusivity used to be enforced by deletion, so touching the circle button lost a drawn area outright with no undo across a reload. Absent means work it out from the data. Rides in the meta bag, because a new top-level field is dropped by three copiers. */
  shape?: AnchorShape
  /* THE FOUR NUMBERS ARE [x0, y0, x1, y1], two opposite corners, not [x, y, w, h]. The schema comment said one thing and the game's box test the other; the game had running code, so the game wins. Both readers take min and max. */
  rect?: [number, number, number, number]
  /* THE SHAPE THE PLACE ACTUALLY IS, because neither a circle nor a box is a pier that bends. Exclusive with rect. WHAT SHIPS IS BOTH THIS AND ITS BOUNDING BOX: the game tests a region with a box and has no polygon test, so points alone would be an area nothing can be inside. */
  poly?: [number, number][]
  /* WHERE THE CIRCLE SITS, as an offset from the anchor's own pixel: a ring carried only r, so on a bound anchor it sat under the front legs of a table with the tabletop outside its own zone. An offset and not a point, because the circle is the one shape that already follows a placement that moves. */
  ring?: [number, number]
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
  /* author key/values a grape can read, and the bag every boundary copies whole: the upsert, the game's readAnchors and the publish projection each copy a fixed list plus all of meta, so this is what carries anything new across. */
  meta?: Record<string, unknown>
  /* WHEN THIS PLACE IS THERE AT ALL. A condition on the NAME, not on a picture: an anchor may have no placement bound to it and still need to be off. Rides in the meta bag, because three copiers take a fixed field list plus all of meta, and migrateEvent folds it both ways so the field and the bag cannot disagree. */
  when?: string
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

/* HOW BIG A NAMED PLACE MAY BE. The old ceiling was 64, which on a 688px map is under two percent, so no plaza, pier or bay fit the one shape an author could reach for. Nothing downstream ever enforced 64, so raising it cannot outrun anything. 512 covers the widest painting the pixel budget allows and still refuses a typo. */
export const ANCHOR_R_MIN = 4
export const ANCHOR_R_MAX = 512

/* WHICH SHAPE THIS ANCHOR IS, asked once so the form, the overlay and both exporters cannot answer differently. The mode wins only when the shape it names has something in it, so pressing draw then escape does not ship an area of no pixels. It no longer asks the KIND: a door's zone is the doormat, not a ring round the middle. */
export function anchorShape(e: {
  kind?: string
  shape?: string
  rect?: unknown
  poly?: unknown
}): AnchorShape {
  const hasPoly = Array.isArray(e.poly) && e.poly.length > 2
  const hasRect = Array.isArray(e.rect) && e.rect.length === 4
  if (e.shape === 'poly' && hasPoly) return 'poly'
  if (e.shape === 'rect' && hasRect) return 'rect'
  if (e.shape === 'circle') return 'circle'
  return hasPoly ? 'poly' : hasRect ? 'rect' : 'circle'
}

/* FEWER POINTS FOR THE SAME LINE, Ramer-Douglas-Peucker. A freehand drag samples on every move, so two seconds arrives as several hundred points that would each become a document field, a row, a bundle entry and a draggable handle. The tolerance is about one screen pixel at the zoom drawn at, which is the smallest error the author could see. */
export function simplifyPoly(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts.slice()
  const t2 = Math.max(0.01, tol * tol)
  const keep = new Array<boolean>(pts.length).fill(false)
  keep[0] = true
  keep[pts.length - 1] = true
  // an explicit stack rather than recursion, because a long drag on a slow map
  // is thousands of samples and a blown call stack loses the whole shape
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number]
    if (b <= a + 1) continue
    const [ax, ay] = pts[a]
    const [bx, by] = pts[b]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    let far = -1
    let worst = 0
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]
      let d2: number
      if (len2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2
      else {
        const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
        d2 = (px - ax - u * dx) ** 2 + (py - ay - u * dy) ** 2
      }
      if (d2 > worst) {
        worst = d2
        far = i
      }
    }
    if (far > 0 && worst > t2) {
      keep[far] = true
      stack.push([a, far], [far, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/* THE BOX A DRAWN AREA SITS IN, in the order `rect` uses, and what makes a poly safe to ship: the game tests a region by its rect and has no polygon test, so points alone would be an area no player is ever inside. */
export function polyBounds(poly: [number, number][]): [number, number, number, number] {
  let x0 = poly[0][0]
  let y0 = poly[0][1]
  let x1 = x0
  let y1 = y0
  for (const [x, y] of poly) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

/* A saved route, made safe. Two points is the minimum, and a mark past the end of the line is dropped rather than carried, because a beat waiting for waypoint nine on a six-point path waits for ever. */
export function migratePath(p: MapPath): MapPath | null {
  if (!p || !isAnchorName(p.name)) return null
  const points = (Array.isArray(p.points) ? p.points : [])
    .filter((q) => Array.isArray(q) && q.length === 2 && isFinite(Number(q[0])) && isFinite(Number(q[1])))
    .map((q) => [Math.round(Number(q[0])), Math.round(Number(q[1]))] as [number, number])
  if (points.length < 2) return null
  const marks = (Array.isArray(p.marks) ? p.marks : [])
    .filter((m) => m && isAnchorName(m.name) && isFinite(Number(m.at)))
    .map((m) => ({
      at: Math.round(Number(m.at)),
      name: m.name,
      ...(typeof m.label === 'string' && m.label.trim() ? { label: String(m.label) } : {}),
    }))
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
    // carried, never invented: a shot from before this field existed has no
    // canvas behind it any more, and guessing one would ship a wrong camera
    // that looks authored
    ...(isFinite(Number(f.overFit)) && Number(f.overFit) > 0
      ? { overFit: Math.min(16, Math.max(0.05, Number(f.overFit))) }
      : {}),
    ...(f.entry ? { entry: true } : {}),
    ...(f.meta && typeof f.meta === 'object' ? { meta: f.meta } : {}),
  }
}

/* HOW FAR FROM ITS ANCHOR A STAND POINT MAY BE, in bodies. Two on the hub ended up 60 and 214 pixels away because dragging the anchor left them where they were. Two bodies reaches past a wide table and no further. */
/* THE KEYS IN AN ANCHOR'S BAG THAT BELONG TO THE TOOL, kept off the author's grid: `when` and `shape` have their own controls, `derived` and `docId` are MAPVIS's record of where a name came from. */
export const ANCHOR_META_RESERVED = ['when', 'shape', 'derived', 'docId', 'shots', 'variants']

export const STAND_REACH_BODIES = 2
export const standReach = (charH: number) => Math.max(1, Math.round(charH)) * STAND_REACH_BODIES

/* The nearest legal stand point to the one asked for. Truncated toward the
 * anchor rather than rounded, because rounding a point that sits exactly on the
 * limit can put it back outside and this has to be able to promise it did not. */
export function clampStand(
  x: number,
  y: number,
  stand: [number, number],
  charH: number,
): [number, number] {
  const reach = standReach(charH)
  /* ROUNDED BEFORE IT IS MEASURED, not after. Rounding a point that sits just
   * inside the circle can push it back out by up to 0.71px, so measuring first
   * and rounding second let a legal-looking point be saved at 36.4 against a
   * reach of 36. Caught by the sweep in the stand check. */
  const sx = Math.round(stand[0])
  const sy = Math.round(stand[1])
  const dx = sx - x
  const dy = sy - y
  const d = Math.hypot(dx, dy)
  if (d <= reach) return [sx, sy]
  const k = reach / d
  return [x + Math.trunc(dx * k), y + Math.trunc(dy * k)]
}

/* An anchor from an older save: absent numbers fill in sane, absent strings empty. A pre-anchor door has no name, so one is derived from its label and marked derived, because code written against a derived name is written against a guess. */
export function migrateEvent(e: MapAnchor & { type?: string }, charH = defaultCfg().charH): MapAnchor {
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
  /* two numbers or nothing: half a point is not a place to stand. Held to
   * STAND_REACH_BODIES here as well as at the setter, because a document
   * written before the rule existed carries points that break it. */
  if (Array.isArray(e.stand) && e.stand.length === 2 && e.stand.every((n) => isFinite(Number(n))))
    e.stand = clampStand(e.x, e.y, [Number(e.stand[0]), Number(e.stand[1])], charH)
  else delete e.stand
  // four numbers or nothing, and they are two corners
  if (Array.isArray(e.rect) && e.rect.length === 4 && e.rect.every((n) => isFinite(Number(n))))
    e.rect = e.rect.map((n) => Math.round(Number(n))) as [number, number, number, number]
  else delete e.rect
  /* THE DRAWN AREA, and three points is the floor: two are a line, a line has no inside, and a region built from one tests empty for every player forever. Refused rather than repaired, because a half-drawn shape is not a shape anybody meant. */
  const poly = (Array.isArray(e.poly) ? e.poly : [])
    .filter((q) => Array.isArray(q) && q.length === 2 && isFinite(Number(q[0])) && isFinite(Number(q[1])))
    .map((q) => [Math.round(Number(q[0])), Math.round(Number(q[1]))] as [number, number])
  if (poly.length >= 3) e.poly = poly
  else delete e.poly
  /* THE MODE, FOLDED INTO THE BAG AND LIFTED BACK OUT. Both shapes are kept now and the mode says which is authoritative, so touching a mode button no longer costs an author their drawing. Written only when there is an area to be authoritative over. THE KIND IS NOT ASKED: a zone drawn on a door used to survive until the next save and read back as a circle. */
  /* THE RING OFFSET, validated and folded like `shape` and `when` and in the bag for the same reason. Two finite numbers or nothing, and a zero offset stores as nothing so an untouched ring grows no field. */
  const bagRing = e.meta && Array.isArray((e.meta as { ring?: unknown }).ring)
    ? ((e.meta as { ring?: unknown[] }).ring as unknown[])
    : null
  const rawRing = Array.isArray(e.ring) ? (e.ring as unknown[]) : bagRing
  if (rawRing && rawRing.length === 2 && rawRing.every((n) => isFinite(Number(n)))) {
    const rx = Math.round(Number(rawRing[0]))
    const ry = Math.round(Number(rawRing[1]))
    if (rx || ry) {
      e.ring = [rx, ry]
      e.meta = { ...(e.meta || {}), ring: [rx, ry] }
    } else {
      delete e.ring
      if (e.meta && 'ring' in e.meta) {
        const { ring: _drop, ...rest } = e.meta as Record<string, unknown>
        e.meta = rest
      }
    }
  } else {
    delete e.ring
    if (e.meta && 'ring' in e.meta) {
      const { ring: _drop, ...rest } = e.meta as Record<string, unknown>
      e.meta = rest
    }
  }

  const bagShape = e.meta && typeof (e.meta as { shape?: unknown }).shape === 'string'
    ? String((e.meta as { shape?: string }).shape)
    : ''
  const wanted = (ANCHOR_SHAPES as string[]).includes(String(e.shape))
    ? String(e.shape)
    : (ANCHOR_SHAPES as string[]).includes(bagShape)
      ? bagShape
      : ''
  if (e.poly || e.rect || wanted) {
    const shape = (wanted || anchorShape(e)) as AnchorShape
    e.shape = shape
    e.meta = { ...(e.meta || {}), shape }
  } else {
    delete e.shape
    if (e.meta && 'shape' in e.meta) {
      const { shape: _drop, ...rest } = e.meta as Record<string, unknown>
      e.meta = rest
    }
  }
  if (!isAnchorName(e.name)) {
    e.name = anchorName(e.label || `${e.kind}_${e.id}`)
    e.meta = { ...(e.meta || {}), derived: true }
  }
  /* THE CONDITION, FOLDED BOTH WAYS IN ONE PLACE, because the field and the bag must never disagree: syncEventsToAnchors copies a fixed column list plus meta, so a top-level `when` never reaches postgres, and eventsFromAnchors hands the bag back with nothing else knowing to look inside it. */
  const bagWhen = e.meta && typeof (e.meta as { when?: unknown }).when === 'string'
    ? String((e.meta as { when?: string }).when)
    : ''
  const when = (typeof e.when === 'string' && e.when.trim() ? e.when : bagWhen).trim().slice(0, 240)
  if (when) {
    e.when = when
    e.meta = { ...(e.meta || {}), when }
  } else {
    delete e.when
    if (e.meta && 'when' in e.meta) {
      const { when: _drop, ...rest } = e.meta as Record<string, unknown>
      e.meta = rest
    }
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

/* WHAT KIND OF PLACE A MAP IS, which the engine guessed from whether the border was transparent because MAPVIS knew and never said. `hall` is a shared space that is neither a club's island nor a room inside something. */
export type MapClass = 'island' | 'room' | 'hall'

export const MAP_CLASSES: MapClass[] = ['island', 'room', 'hall']

/* Everything about the map that is not pixels and not a named point. title was a real column machine-filled with the slug and dropped before the export; class was known and never said; meta is the author's own bag and there was no map-level one. islandId HAS NO READER YET: the game declares it and never reads it, and the only binding is still a row in member-islands.json plus a deploy. MAPVIS emitting a field is not the consumer having a reader. */
export interface MapProps {
  /* what a player reads. The id is what code addresses, the same split anchors
   * make between name and label, and for the same reason. */
  title: string
  class: MapClass
  /* the school offering this map is about, joining it to a grape */
  islandId: string
  /* WHERE THE PAINT IS INSIDE THE CANVAS, as [w, h, ox, oy], stated rather than measured. Absent means measured, which is nearly always better; this is the correction for an edge the scan reads as picture. */
  paint?: [number, number, number, number]
  meta: Record<string, unknown>
}

export const defaultProps = (): MapProps => ({ title: '', class: 'island', islandId: '', meta: {} })

/* A NAMED POLYLINE, the largest thing this tool could not say: every anchor is one pixel, so the only route a map could describe was a straight line between two. `marks` names a waypoint index, so a beat says "be at the doorway by the time this line ends" instead of "walk for 2.4 seconds". */
export interface PathMark {
  /* index into points, so a mark cannot name a waypoint that is not there */
  at: number
  name: string
  /* WHAT A PERSON READS, the same split an anchor makes. Without it the canvas captioned a waypoint `at_the_doorway`, which is the exact thing the name/label split was paid for to stop. Optional, because every mark saved before has none. */
  label?: string
}

/* WHAT TRAVELS THE LINE, and what decides whether a route over open water is a defect or the point: the hub's own the_dock_walk runs over pixels no body can stand on and nothing could tell a mistake from a boat. A walk line is held to the floor, a sail line is expected to leave it, a camera is held to nothing. */
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

/* A NAMED SHOT, hung off an ANCHOR by preference rather than coordinates, because raw numbers re-break every time a painting is re-cut. zoom is a real number and not one of the renderer's integer notches: the pull-out shot cannot exist on those. */
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
  /* HOW MANY TIMES TIGHTER THAN THE WHOLE MAP THIS SHOT IS, recorded when armed. `zoom` above is the editor's own screen-pixels-per-painting-pixel and means nothing outside the canvas that was open; the game multiplies what it is given by the scale the map loaded at. */
  overFit?: number
  /* the framing a player gets on arriving in this map, at most one per map */
  entry?: boolean
  meta?: Record<string, unknown>
}

/* A NAMED SET OF ANCHORS. WHAT THE GAME DOES WITH ONE TODAY: nothing, read rather than assumed. Nothing groups anchors and no intent takes more than a single anchor string, so a grape wanting five steles hard-codes five and neither side can say whether that is all of them. Membership, not order; a rack below is the ordered one. An empty set is kept, because iterating it yields nothing, which is a correct answer. */
export interface MapAnchorSet {
  id: number
  /* author-typed, python-shaped, and unique across sets AND racks. See
   * freeCollectionName in editor.ts for why those two share one tally. */
  name: string
  /* what a person reads, the same split anchors make between name and label */
  label?: string
  /* anchor names. Not ids: an anchor's id is a document counter that does not
   * survive being deleted and placed again, and the name is the only thing a
   * member's python can hold. */
  members: string[]
  meta?: Record<string, unknown>
}

/* ONE POSITION IN A RACK, and `slot` is its address for the life of the map. NOT an array position: deleting the second hook would renumber every trophy after it and a save saying "slot 3 is filled" would mean a different hook. Numbers come from the rack's counter and are never reused. Called `slot` and not `id` because it SHIPS, and `id` is the class of field a reader is meant to drop. The anchor is required: a slot with nowhere to be is not a slot. */
export interface RackSlot {
  slot: number
  anchor: string
  label?: string
  meta?: Record<string, unknown>
}

/* AN ORDERED SLOT RACK: the trophy wall, the banner wall, the season tokens. The reverse of a group, one authored empty position per thing that does not exist yet. ARRAY ORDER IS ARRIVAL ORDER AND THE SLOT NUMBER IS THE ADDRESS, separate on purpose, so dragging a trophy to the front does not change what hook[3] means. */
export interface MapRack {
  id: number
  name: string
  label?: string
  slots: RackSlot[]
  /* the next slot number this rack will hand out. Stored rather than computed
   * from the highest one present, so a number is never reused after a delete. */
  slotNext: number
  meta?: Record<string, unknown>
}

/* A saved set, made safe. A member that is not a legal anchor name is dropped rather than carried, or the publish gate would refuse over a string nobody typed. Duplicates go too, which is what makes "the set is complete" a countable question. */
export function migrateAnchorSet(s: MapAnchorSet): MapAnchorSet | null {
  if (!s || !isAnchorName(s.name)) return null
  const seen = new Set<string>()
  const members: string[] = []
  for (const m of Array.isArray(s.members) ? s.members : []) {
    const n = String(m)
    if (!isAnchorName(n) || seen.has(n)) continue
    seen.add(n)
    members.push(n)
  }
  return {
    id: Math.round(Number(s.id)) || 0,
    name: s.name,
    ...(typeof s.label === 'string' && s.label.trim() ? { label: String(s.label) } : {}),
    members,
    ...(s.meta && typeof s.meta === 'object' ? { meta: s.meta } : {}),
  }
}

/* A saved rack, made safe. Two hooks numbered 3 is not a rack and the second loses: an address resolving to two positions is worse than a missing one. slotNext comes back past the highest number present, so a hand-edited save cannot hand out a number already on the wall. */
export function migrateRack(r: MapRack): MapRack | null {
  if (!r || !isAnchorName(r.name)) return null
  const seen = new Set<number>()
  const slots: RackSlot[] = []
  let high = 0
  for (const s of Array.isArray(r.slots) ? r.slots : []) {
    if (!s || !isFinite(Number(s.slot)) || !isAnchorName(String(s.anchor))) continue
    const slot = Math.round(Number(s.slot))
    if (slot < 1 || seen.has(slot)) continue
    seen.add(slot)
    high = Math.max(high, slot)
    slots.push({
      slot,
      anchor: String(s.anchor),
      ...(typeof s.label === 'string' && s.label.trim() ? { label: String(s.label) } : {}),
      ...(s.meta && typeof s.meta === 'object' ? { meta: s.meta } : {}),
    })
  }
  return {
    id: Math.round(Number(r.id)) || 0,
    name: r.name,
    ...(typeof r.label === 'string' && r.label.trim() ? { label: String(r.label) } : {}),
    slots,
    slotNext: Math.max(high + 1, Math.round(Number(r.slotNext)) || 1),
    ...(r.meta && typeof r.meta === 'object' ? { meta: r.meta } : {}),
  }
}

/* ONE STATE OF A VARIANT SET: a word, and the placement that is showing while
 * that word is the answer. */
export interface MapVariant {
  /* what python sets. Folded through the same rule every other name in this
   * tool goes through, because one namespace shape beats four. */
  name: string
  /* WHICH PLACEMENT, BY ITS AUTHOR NAME and never by its id: the id is a counter that does not survive a delete and a re-place. The game resolves both, so the name is the half that stays true. */
  placement: string
  /* what a person reads in the panel. Never the identity. */
  label?: string
}

/* A NAMED EXCLUSIVE VARIANT SET: one name, several PLACEMENTS, at most one visible. NOT one placement wearing another face, which is `looks`: a ship at a dock and the empty water where it is not have different silhouettes, footprints and anchors, so two frames of one sprite would give the empty berth the ship's collision. It buys python setting a state without knowing how many faces exist, instead of showing one and hiding four by hand. It hangs on an ANCHOR because the anchor namespace is the only addressing system the running game has. `initial` may be empty, which is an author saying nothing shows until the story says otherwise. */
export interface MapVariantSet {
  id: number
  name: string
  /* the anchor this set is addressed through and published onto */
  anchor: string
  label?: string
  members: MapVariant[]
  /* the member showing before anything sets it. '' means none of them. */
  initial: string
  meta?: Record<string, unknown>
}

/* A saved variant set, made safe. A member named twice is dropped, because two states pointing at one placement cannot be exclusive. An `initial` naming a non-member falls back to nothing rather than the first: showing an arbitrary member is worse than showing none, because none is visibly wrong. One member is KEPT, being an author part way through the second. */
export function migrateVariantSet(v: MapVariantSet): MapVariantSet | null {
  if (!v || !isAnchorName(v.name) || !isAnchorName(String(v.anchor))) return null
  const names = new Set<string>()
  const places = new Set<string>()
  const members: MapVariant[] = []
  for (const m of Array.isArray(v.members) ? v.members : []) {
    if (!m) continue
    const name = isLookName(m.name) ? m.name : anchorName(String(m.name || ''))
    if (!isLookName(name) || names.has(name)) continue
    if (!isPlacementName(m.placement) || places.has(m.placement)) continue
    names.add(name)
    places.add(m.placement)
    members.push({
      name,
      placement: m.placement,
      ...(typeof m.label === 'string' && m.label.trim() ? { label: String(m.label) } : {}),
    })
  }
  return {
    id: Math.round(Number(v.id)) || 0,
    name: v.name,
    anchor: String(v.anchor),
    ...(typeof v.label === 'string' && v.label.trim() ? { label: String(v.label) } : {}),
    members,
    initial: names.has(String(v.initial)) ? String(v.initial) : '',
    ...(v.meta && typeof v.meta === 'object' ? { meta: v.meta } : {}),
  }
}

/* A GROUP OF PLACEMENTS, WHICH WAS ALREADY A STRING AND NOW HAS A ROW, so there is somewhere to say something ABOUT one. It matters for one field so far: a dozen placements sharing a condition, where copying the string onto each means the thirteenth is added without it. The name IS the group string; a second identity would let a placement point at a group renamed out from under it. */
export interface MapGroup {
  name: string
  /* what a person reads. The group string itself is what the panel shows today
   * and it is often a machine word like `props`. */
  label?: string
  /* the condition every placement in this group inherits. Same contract as
   * PlacedAsset.when: MAPVIS declares it, python decides what it means, and a
   * placement's own `when` wins where it has one. */
  when?: string
}

/* A saved group, made safe. The name is a placement's free-text `group` string, so it is folded rather than refused: refusing would drop the condition off every group made before this existed. A row that says only its own name is dropped, because every placement already says it. */
export function migrateGroup(g: MapGroup): MapGroup | null {
  if (!g || typeof g.name !== 'string' || !g.name.trim()) return null
  const when = typeof g.when === 'string' ? g.when.trim().slice(0, 240) : ''
  const label = typeof g.label === 'string' ? g.label.trim() : ''
  if (!when && !label) return null
  return {
    name: g.name.trim().slice(0, 48),
    ...(label ? { label } : {}),
    ...(when ? { when } : {}),
  }
}

/* THE CONDITION A PLACEMENT SHIPS WITH: its own if it has one, its group's otherwise. Resolved here rather than in the game, whose assets loop has a placement in hand and no group table beside it. */
export function whenOf(a: { when?: string; group?: string }, groups: MapGroup[]): string {
  if (typeof a.when === 'string' && a.when.trim()) return a.when.trim()
  const g = groups.find((q) => q.name === a.group)
  return g && g.when ? g.when : ''
}

/* THE GAME'S OWN PULL-OUT CONSTANT, carried here because MAPVIS is the one that moves: the consumer multiplies a framing's zoom by its own opening scale, so a shot exported as 1 is the opening view. The conversion happens on the way out, so the constant lives at the emit. */
export const GAME_OPENING_PULL = 1.18

/* What a shot is worth to the game. A framing armed before overFit existed has no honest answer, so it becomes the opening view: a raw editor notch shipped straight through is a nose filling the screen with nothing saying why. */
export function shotZoom(f: { zoom?: number; overFit?: number }): number {
  const rel = isFinite(Number(f.overFit)) && Number(f.overFit) > 0 ? Number(f.overFit) : 0
  if (!rel) return 1
  return Math.round((rel / GAME_OPENING_PULL) * 1000) / 1000
}

/* SHOTS FOLDED ONTO THE ANCHOR THEY NAME, which is where the consumer looks: the game reads meta.framings[name] and meta.framing and has never had a reader for the shot list. WHICH ONE IS THE DEFAULT matters: look_at asks for an unnamed shot and a missing name falls back to the same slot, so an anchor with named shots and no default has a dead camera on both paths. The entry shot takes it, otherwise the oldest. MERGED, NEVER SWAPPED IN, because the real hub's anchors already carry docId and derived. */
/* OWNING A KEY MEANS OWNING ITS ABSENCE TOO. Additive-only projections handed a stale `framings` key back as a live camera the shot list no longer held, permanently: restoreFromDisk pulls the PREVIOUS export's projected meta in while the shot list is empty, so the stale copy is baked into postgres and re-shipped forever. A DELIBERATE SECOND COPY of this helper lives in server/store/publish.mjs; change both. */
const without = (meta: Record<string, unknown> | undefined, ...keys: string[]): Record<string, unknown> | undefined => {
  if (!meta) return undefined
  const out = { ...meta }
  for (const k of keys) delete out[k]
  return Object.keys(out).length ? out : undefined
}

export function shotsOntoMeta(
  framings: MapFraming[],
  anchor: string,
  meta?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const mine = framings.filter((f) => f.anchor === anchor)
  if (!mine.length) return without(meta, 'framings', 'framing')
  const one = (f: MapFraming) => ({ zoom: shotZoom(f), dx: f.dx, dy: f.dy })
  const set: Record<string, unknown> = {}
  for (const f of mine) set[f.name] = one(f)
  const def = mine.find((f) => f.entry) || mine.reduce((a, b) => (a.id <= b.id ? a : b))
  return { ...(meta || {}), framings: set, framing: { ...one(def), name: def.name } }
}

/* VARIANT SETS FOLDED ONTO THE ANCHOR THEY HANG ON, read off the running game before it was written: readAnchors copies meta whole and throws away new top-level fields, and PmapScene keys placements by both id and author name, so a set written as { state: placement-name } inside the bag needs only a loop. MERGED, never swapped in. MAPVIS PICKS NO DEFAULT here, unlike a shot: a missing shot leaves the camera dead, a missing state does not. */
export function variantsOntoMeta(
  variants: MapVariantSet[],
  anchor: string,
  meta?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const mine = variants.filter((v) => v.anchor === anchor)
  // the same clearing the shots do, for the same reason: a projection that
  // cannot remove its own key ships a set the document no longer holds
  if (!mine.length) return without(meta, 'variants')
  const set: Record<string, unknown> = {}
  for (const v of mine)
    set[v.name] = {
      initial: v.initial,
      members: v.members.map((m) => ({ name: m.name, placement: m.placement })),
    }
  return { ...(meta || {}), variants: set }
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
  stencils: Stencil[] = []
  stencilNext = 1
  assets: PlacedAsset[] = []
  assetNext = 1
  events: MapEvent[] = []
  eventNext = 1
  /* THE BODY THIS MAP IS DRAWN FOR: six numbers, written into map.json and consumed by the game. They lived on the editor as a default that was never assigned again, so every map shipped an 18px character at 34px/s on ground squashed 0.72, island or room. They belong to the document because they describe the map. */
  walk: WalkCfg = defaultCfg()
  props: MapProps = defaultProps()
  /* routes and shots, both addressed by name and both belonging to the map for
   * the same reason the walk contract does: they describe this painting, so one
   * save has to carry them or they are retyped on every open */
  paths: MapPath[] = []
  pathNext = 1
  framings: MapFraming[] = []
  framingNext = 1
  /* the named collections of anchors, which belong to the map for the same
   * reason: they are made of this map's names and nothing outside it can hold
   * them. A set is unordered membership, a rack is addressed positions. */
  sets: MapAnchorSet[] = []
  setNext = 1
  racks: MapRack[] = []
  rackNext = 1
  /* the named exclusive variant sets and the rows about a placement group, on the map for the reason the collections above are: they are made of this map's own names. */
  variants: MapVariantSet[] = []
  variantNext = 1
  groups: MapGroup[] = []
  spawn: Pt
  // boundary growth: bw/bh is the base painting's size, ox/oy how far it sits inside the grown canvas. Zero until the map is expanded; the autosave uses it to re-grow on reload.
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

  // ---- history. assets and events ride the same timeline as the planes, so a placement, a drag or a group clear is one z away and a mask undo can never strand their state
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
  /* HOW DEEP THE UNDO STACK IS, so something outside the document can pin an edit to a point in it: the pixel edits rewrite files on disk this document cannot restore, and the panel has to know WHICH z should undo them. */
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
    this.events = (JSON.parse(h.e) as MapEvent[]).map((e) => migrateEvent(e, this.walk.charH))
    return true
  }

  // ---- boundary growth. Grow by a transparent margin: every plane re-laid at the same offset, spawn, baselines and placements shifted with it. Pure memory copy, never a resample. The caller owns the undo snapshot.
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
  // The machine proposal: flood the painting's own colour from the clicked pixel against the SEED colour, never chained neighbour to neighbour, which is how sea-navy once walked into volcano rock. The seen buffer is reusable across the hundreds of floods auto sea runs, stamped rather than cleared.
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

  // The outer sea in one press. The seed set is computed ONCE, before any flood, and never from already-cut pixels: the frontier version reseeded from fresh cuts, chaining tone to tone until it proposed the whole painting (measured 264k of 264k px). Each flood matches its own seed colour at the given tolerance, exactly the manual tool. The caller owns the undo snapshot.
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

  // Coastline residue: the anti-aliased fringe leaves floating specks too small to hunt by hand. Connected components over opaque, not-cut pixels; the largest is the land and every other joins the cut.
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

  // One ring off the coast. The ring is collected before any pixel is written, otherwise scan order lets a fresh cut qualify its own neighbour and one press eats more than one ring.
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

  // ---- SEAM HEAL. Two polygons drawn as independent outlines do not tile exactly, leaving a 1px row of 0 that is invisible below 6x and hard-blocks the character, whose hip probes sit 2px out. Only a pixel pinched between two walkable ones a legal step apart is closed, so a real wall is never eaten.
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

  // ---- export. Every ramp value becomes a named region with its bbox. The runtime does not need it (the level values carry the law); the game wants it for footstep sounds, camera and "you are on the stair".
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

  // levels + occluders + cut packed for the local autosave, wrapped in json so placements and anchors ride along. v3 adds the canvas size, the base size and offset and the spawn; older shapes still load, and a payload without events loads with none.
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
      /* THE OCCLUDER BASELINES, WHICH USED TO BE THROWN AWAY HERE. A baseline is the one hand-set number in the depth system, and omitting `occs` meant unpack() rebuilt every one from the polygon's bottom edge on the next open. The author watched the field take the number. */
      occs: this.occs,
      occNext: this.occNext,
      stencils: this.stencils,
      stencilNext: this.stencilNext,
      walk: this.walk,
      props: this.props,
      paths: this.paths,
      pathNext: this.pathNext,
      framings: this.framings,
      framingNext: this.framingNext,
      sets: this.sets,
      setNext: this.setNext,
      racks: this.racks,
      rackNext: this.rackNext,
      variants: this.variants,
      variantNext: this.variantNext,
      groups: this.groups,
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
          stencils?: Stencil[]
          stencilNext?: number
          walk?: Partial<WalkCfg>
          props?: Partial<MapProps>
          paths?: MapPath[]
          pathNext?: number
          framings?: MapFraming[]
          framingNext?: number
          sets?: MapAnchorSet[]
          setNext?: number
          racks?: MapRack[]
          rackNext?: number
          variants?: MapVariantSet[]
          variantNext?: number
          groups?: MapGroup[]
        }
        /* the saved baselines go in FIRST, because unpack() only invents them when there are none, which is exactly the guard that has to see them already here. */
        if (Array.isArray(d.occs)) {
          this.occs = d.occs
            .filter((o) => o && isFinite(Number(o.id)) && isFinite(Number(o.baseline)))
            .map((o) => ({ id: Math.round(Number(o.id)), baseline: Math.round(Number(o.baseline)) }))
          this.occNext =
            Number(d.occNext) > 0 ? Math.round(Number(d.occNext)) : this.occs.reduce((m, o) => Math.max(m, o.id), 0) + 1
        }
        // kept outlines, sanitised the way an anchor's poly is: three points is
        // the floor, because two are a line and a line fills nothing
        if (Array.isArray(d.stencils)) {
          this.stencils = d.stencils
            .filter((k) => k && isFinite(Number(k.id)) && Array.isArray(k.pts) && k.pts.length >= 3)
            .map((k) => ({
              id: Math.round(Number(k.id)),
              pts: k.pts
                .filter((q) => Array.isArray(q) && q.length === 2 && isFinite(Number(q[0])) && isFinite(Number(q[1])))
                .map((q) => [Number(q[0]), Number(q[1])] as [number, number]),
            }))
            .filter((k) => k.pts.length >= 3)
            .slice(0, STENCIL_KEEP)
          this.stencilNext =
            Number(d.stencilNext) > 0 ? Math.round(Number(d.stencilNext)) : this.stencils.reduce((m, k) => Math.max(m, k.id), 0) + 1
        }
        if (d.walk) this.walk = { ...defaultCfg(), ...numbersOnly(d.walk) }
        if (d.props)
          this.props = {
            title: typeof d.props.title === 'string' ? d.props.title : '',
            class: MAP_CLASSES.includes(d.props.class as MapClass) ? (d.props.class as MapClass) : 'island',
            islandId: typeof d.props.islandId === 'string' ? d.props.islandId : '',
            ...(Array.isArray(d.props.paint) && d.props.paint.length === 4 && d.props.paint.every((n) => isFinite(Number(n)))
              ? { paint: d.props.paint.map((n) => Math.round(Number(n))) as [number, number, number, number] }
              : {}),
            meta: d.props.meta && typeof d.props.meta === 'object' ? d.props.meta : {},
          }
        /* A ROUTE OR A SHOT FROM A HAND-EDITED SAVE COMES BACK AS DATA OR NOT AT ALL: a one-point path is not a path and a NaN in a zoom stops a camera dead. */
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
        /* the same treatment for the two collections, and for the same reason: a
         * set naming something that is not an anchor name at all, or a rack with
         * two hooks numbered 3, has to come back as data or not at all. */
        this.sets = Array.isArray(d.sets) ? d.sets.map(migrateAnchorSet).filter((s): s is MapAnchorSet => !!s) : []
        this.setNext =
          Number(d.setNext) > 0 ? Math.round(Number(d.setNext)) : this.sets.reduce((m, s) => Math.max(m, s.id), 0) + 1
        this.racks = Array.isArray(d.racks) ? d.racks.map(migrateRack).filter((r): r is MapRack => !!r) : []
        this.rackNext =
          Number(d.rackNext) > 0 ? Math.round(Number(d.rackNext)) : this.racks.reduce((m, r) => Math.max(m, r.id), 0) + 1
        /* and the variant sets, on the same terms. An exclusive set that is not exclusive is worse than none, because every state leaves the same sprite on screen and nothing can tell which one it is in. */
        this.variants = Array.isArray(d.variants)
          ? d.variants.map(migrateVariantSet).filter((v): v is MapVariantSet => !!v)
          : []
        this.variantNext =
          Number(d.variantNext) > 0
            ? Math.round(Number(d.variantNext))
            : this.variants.reduce((m, v) => Math.max(m, v.id), 0) + 1
        this.groups = Array.isArray(d.groups) ? d.groups.map(migrateGroup).filter((g): g is MapGroup => !!g) : []
        if (!this.unpack(String(d.m || ''))) return false
        // v2 assets carry only `scale`; the migration fills the transform
        this.assets = Array.isArray(d.assets) ? d.assets.map(migrateAsset) : []
        this.assetNext = typeof d.assetNext === 'number' ? d.assetNext : this.assets.length + 1
        // an older payload has no events and loads with none
        this.events = Array.isArray(d.events) ? d.events.map((e) => migrateEvent(e, this.walk.charH)) : []
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
