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
  /* WHAT LOOK 0 IS CALLED, which cannot live on AssetLook because look 0 is not
   * one of those. The placement's own src / frames / dirs ARE look 0 and `looks`
   * holds 1 and up, so a name for the picture a thing was placed with has
   * nowhere else to go. Without it the vocabulary is half a vocabulary: an
   * author could name the boulder and not the troll it turns back into. */
  lookName?: string
  /* WHEN THIS THING IS THERE AT ALL, declared here and decided somewhere else.
   *
   * MAPVIS says the condition, python says what it means. This tool has no run
   * state, no year, no flags, and no idea what `cord_earned` is, and putting an
   * evaluator here would move half the game's progression rules into a map
   * editor. So it is an opaque string the bundle carries to whoever can answer
   * it, and MAPVIS never looks inside it.
   *
   * A placement with none is always there, which is every placement on every map
   * that exists today. */
  when?: string
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
  /* WHAT A PERSON CALLS THIS FACE, and the vocabulary `show(placement, state)`
   * never had to select from.
   *
   * The index stays the data. life.ts documents `art` as "an INDEX and never a
   * name", clamped 0 to 7, because lifeAt runs for every placement on every
   * frame and a name would be a search where a number is a lookup. The planner
   * already answers in names and server/api.mjs resolves each one to an integer
   * before the row is saved, so by the time a look reaches here the word the
   * author used is gone and a bundle addresses a face by number alone.
   *
   * This is that word, kept BESIDE the index and never instead of it. The
   * positional packing is untouched: a look that will not load still holds its
   * slot, art still counts 0, 1, 2 through the same list, and anything reading
   * by index cannot tell the difference. */
  name?: string
}

/* THE NAME OF A FACE OR A SET STATE, and it is deliberately the anchor rule.
 *
 * A look name is a python string rather than an identifier, so a looser rule
 * would work, and one namespace shape across every name in this tool is worth
 * more than that freedom. Library rows arrive hyphenated (`boulder-2` from the
 * exporter's own collision suffix), so a name derived from one is folded through
 * anchorName first rather than refused, which is what stops the derivation
 * silently dropping half the vocabulary it was written to supply. */
export const isLookName = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(s)

/* THE NAME A PICTURE ALREADY HAS, read off the url it lives at.
 *
 * The planner names every look and App.tsx resolves that name to an index at
 * src/App.tsx:1924 and then throws the word away, so nothing downstream of the
 * life panel has ever seen it. Until that panel hands the word over, this
 * recovers it from the one place it is still written down: the path.
 *
 * Two shapes, both built by server/store/platform.mjs and neither of them a
 * guess. A face is /work/<slug>/states/<item>/<face>/[<heading>/]<n>.png, so the
 * name is the segment two past `states`. A library row is
 * /work/<slug>/library/<name>.png or /work/<slug>/library/<name>/... , so it is
 * the segment one past `library`. Anything else answers nothing, because a wrong
 * name is worse than no name once python is writing against it.
 *
 * NOT assetLabel: that one takes the second-to-last segment for anything with
 * dirs, which on a face is the HEADING. It answered `south` for every one of
 * them, which is the same bug that turned 38 of the hub's figures round. */
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

/* EVERY FACE THIS PLACEMENT HAS, BY NAME, indexed exactly the way `art` indexes
 * them: slot 0 is the placement's own picture, slot 1 is looks[0]. An empty
 * string is a face nobody named, and it holds its slot for the same reason a
 * look that would not load holds its slot. Answers an empty array when nothing
 * anywhere is named, so a bundle from a map with no vocabulary grows no field. */
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
  /* THE FACE NAMES, DROPPED RATHER THAN CORRECTED, exactly the way the placement
   * name above is. A name a person did not type is a name their python will call
   * and miss on, and a look with no name is still perfectly drawable by index.
   * The look itself is never removed here: art counts through the slots, so
   * dropping one shifts every later face down and a troll/boulder/troll round
   * draws its third picture where its second belongs. */
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
  /* region only. THE SHAPE THE PLACE ACTUALLY IS, in painting pixels, closed
   * by the reader rather than by a repeated last point.
   *
   * A circle and a box are the only two shapes this tool could describe, and
   * neither is a pier that bends or an L-shaped plaza: an author marking the
   * hub's waterfront either took in half the water or left out half the pier.
   * Exclusive with `rect`, enforced in migrateEvent below, because a region
   * carrying two different shapes gives the exporter a choice nobody authored.
   *
   * WHAT SHIPS IS BOTH THIS AND ITS BOUNDING BOX. The running game tests a
   * region with a box and has no polygon test at all, so a bundle carrying only
   * the points would be an area nothing can ever be inside. See polyBounds. */
  poly?: [number, number][]
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
  /* author key/values a grape can read, and the bag every boundary copies whole.
   * The `when` comment below is the reason it has to keep existing: the anchors
   * upsert, readAnchors in the game and the publish projection each copy a fixed
   * list of top-level fields plus all of meta, so this is what carries anything
   * new across intact. */
  meta?: Record<string, unknown>
  /* WHEN THIS PLACE IS THERE AT ALL, and the reason the carrier could not stay
   * on the placement alone. A door barred until a cord is earned and a berth
   * that does not exist until the ship has been repaired are conditions on the
   * NAME, not on any picture: the anchor may have no placement bound to it and
   * still need to be off. Same contract as PlacedAsset.when, declared by MAPVIS
   * and decided by python, and MAPVIS never looks inside the string.
   *
   * IT RIDES IN THE META BAG ACROSS EVERY BOUNDARY, and that is not a shortcut.
   * The anchors table's upsert column list, the game's readAnchors and the
   * publish projection each copy a fixed set of top-level fields plus the whole
   * of `meta`, so a new top-level field is dropped three times over while the
   * bag arrives intact. That is the framings lesson, paid for once already.
   * migrateEvent below folds this into meta and lifts it back out, so the field
   * and the bag can never disagree about what the author typed. */
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

/* HOW BIG A NAMED PLACE IS ALLOWED TO BE, and the old ceiling was 64.
 *
 * A region is what a plaza, a pier, a shop floor or a bay gets authored as, and
 * a 64px circle on a 688px map covers under two percent of it. None of those
 * things fit, so the one shape an author could reach for could not describe the
 * thing they were marking.
 *
 * THE CONSUMER NEVER ENFORCED 64 AND STILL DOES NOT. AdventureGame's
 * src/game/pmap/anchors.ts reads `r: Math.max(1, Math.round(num(e.r, 14)))`
 * with no upper bound; the anchors.r column is a plain integer with no check
 * constraint; neither exporter clamps. The cap lived in one line of this tool
 * and nowhere else, so raising it cannot outrun anything downstream.
 *
 * 512 rather than unbounded: PixelLab's measured area budget is about 265,000
 * output pixels, so 688x377 is the widest painting that exists and a corner of
 * it is 392 pixels from the middle. 512 covers any map this project can make
 * and still refuses a number that could only be a typo. */
export const ANCHOR_R_MIN = 4
export const ANCHOR_R_MAX = 512

/* THE BOX A DRAWN AREA SITS IN, two opposite corners, in the order `rect` uses.
 *
 * This is what makes a poly safe to ship. The game tests a region by its rect
 * and has no polygon test at all (src/game/pmap/anchors.ts:224), so a bundle
 * carrying only the points would be an area no player is ever inside and every
 * grape hung on it would go quiet. Both exporters write the box beside the
 * points: the box is what runs today, the points are what a reader that learns
 * them will use, and until then an L-shaped plaza tests as its bounding box. */
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
  /* THE DRAWN AREA, and three points is the floor rather than a nicety: two
   * points are a line, a line has no inside, and a region built from one would
   * test as empty for every player forever with nothing saying why. Refused
   * here rather than repaired, the way an illegal name is refused, because a
   * shape somebody half-drew is not a shape they meant. */
  const poly = (Array.isArray(e.poly) ? e.poly : [])
    .filter((q) => Array.isArray(q) && q.length === 2 && isFinite(Number(q[0])) && isFinite(Number(q[1])))
    .map((q) => [Math.round(Number(q[0])), Math.round(Number(q[1]))] as [number, number])
  if (poly.length >= 3) {
    e.poly = poly
    /* ONE SHAPE PER REGION. A rect beside a poly is two different areas both
     * claiming to be this place, and both exporters would have to guess which
     * the author meant. The drawn one wins because it is the more specific of
     * the two, and the box that ships is derived from it at export. */
    delete e.rect
  } else delete e.poly
  if (!isAnchorName(e.name)) {
    e.name = anchorName(e.label || `${e.kind}_${e.id}`)
    e.meta = { ...(e.meta || {}), derived: true }
  }
  /* THE CONDITION, FOLDED INTO THE BAG AND LIFTED BACK OUT OF IT.
   *
   * Both directions, in one place, because the field and the bag must never
   * disagree about what the author typed. Going out: syncEventsToAnchors copies
   * a fixed list of columns plus the whole of meta, so a top-level `when` never
   * reaches postgres and is gone by the next open. Coming in: eventsFromAnchors
   * hands the bag back and nothing else knows to look inside it, so an anchor
   * that has been round the database once would come back with no condition and
   * the panel would show it as unconditional. */
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
 * typed into the game's source. `class` was known and never said. `meta` is the
 * author's own bag and there was no map-level one at all, so the only place to
 * hang map-scoped data was a `meta` on some arbitrarily chosen anchor.
 *
 * `islandId` HAS NO READER YET, AND THIS NOTE CLAIMED OTHERWISE. It is the join
 * between a published map and the school offering behind it, and the reason
 * given for adding it was that the binding lived in a hardcoded Set in the other
 * repo, so shipping a member's island was a source edit and a deploy. That is
 * still true now the field ships: the game declares islandId on its map type and
 * never reads it, and the only binding is islandOfMap(mapId), a lookup over
 * member-islands.json, so a new island is still a row added there and a deploy.
 * The field is right and the emit stays. The reader belongs in the game repo,
 * and this says so rather than reading as a problem somebody solved. MAPVIS
 * emitting a field is not the same as the consumer having a reader, which is the
 * lesson the framings array and the top-level anchor fields already taught. */
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
  /* WHAT A PERSON READS, the same split an anchor makes between name and label.
   * Ash, 2026-08-29: waypoints get labels too. Until this existed the only
   * string a mark carried was the python identifier, so the canvas captioned a
   * waypoint `at_the_doorway` and the panel listed it the same way, which is
   * the exact thing the name/label split was paid for to stop. Optional,
   * because every mark saved before today has none and displayName unpacks the
   * identifier for those. */
  label?: string
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
  /* HOW MANY TIMES TIGHTER THAN THE WHOLE MAP THIS SHOT IS, recorded when it
   * was armed. `zoom` above is the editor's own view: screen pixels per
   * painting pixel, which only means anything next to the canvas that was open
   * at the time. The game has no such number. It multiplies whatever it is
   * given by the scale the map loaded at, so handing it a 3 asks for a face
   * filling the screen. This is the ratio that survives the crossing, and
   * shotZoom below turns it into the multiple the game reads. */
  overFit?: number
  /* the framing a player gets on arriving in this map, at most one per map */
  entry?: boolean
  meta?: Record<string, unknown>
}

/* A NAMED SET OF ANCHORS. `steles` meaning those five, `the_berths` meaning
 * every one on this map.
 *
 * WHAT THE GAME DOES WITH ONE TODAY: nothing, and nothing like it. Read before
 * this was written rather than assumed. AdventureGame's src/game/pmap/anchors.ts
 * holds every anchor in one flat map keyed by name, and the only question it can
 * answer about several at once is `ofKind`, which is the tool's own vocabulary
 * and not the author's. Nothing groups anchors, nothing iterates a named
 * collection, and no intent in src/vine/intents.ts takes anything but a single
 * `anchor: string`. So a grape that wants the five steles hard-codes five
 * strings, and neither side can say whether that is all of them.
 *
 * MEMBERSHIP, NOT ORDER. A set answers "is this one of them" and "how many are
 * there". Where the third one has to be the third one every run, that is a rack
 * below and not this.
 *
 * AN EMPTY SET IS KEPT, unlike a one-point path, which is dropped. A path with
 * one point is not a line at all; a set with no members is an author who has
 * named the thing before drawing the anchors, and iterating it yields nothing,
 * which is a correct answer rather than a broken one. */
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

/* ONE POSITION IN A RACK, and `slot` is its address for the whole life of the
 * map.
 *
 * WHY THIS NUMBER IS NOT AN ARRAY POSITION. The whole demand is that the third
 * hook is the third hook every run. An index into `slots` renumbers the moment
 * somebody deletes the second hook, so every trophy after it moves one place
 * left, a save that says "slot 3 is filled" now means a different hook, and
 * nothing anywhere says so. So each slot carries a number assigned once from the
 * rack's own counter and never reused: delete slot 2 of five and the rack is
 * 1, 3, 4, 5, and the next one added is 6.
 *
 * WHY IT IS CALLED `slot` AND NOT `id`. A path and a shot both carry an `id`
 * which is deliberately stripped at the bundle boundary, because across that
 * boundary a name is the only identity there is. This one is the opposite: it
 * ships, and it is what `hook[3]` means. Naming it `id` would put it in the
 * class of fields a reader is meant to drop.
 *
 * THE ANCHOR IS REQUIRED. "Each empty or filled" is about whether a thing has
 * arrived, which is run state and belongs to python. The position itself is a
 * place on a wall, so a slot with nowhere to be is not a slot. */
export interface RackSlot {
  slot: number
  anchor: string
  label?: string
  meta?: Record<string, unknown>
}

/* AN ORDERED SLOT RACK: the trophy wall, the banner wall, the three season
 * tokens, the graduation front row.
 *
 * The reverse of a group. A group is things that exist acting as one; a rack is
 * one authored empty position per thing that does not exist yet, and the filling
 * of it is the only progression readout in the game that is not a number on a
 * panel.
 *
 * ARRAY ORDER IS ARRIVAL ORDER AND THE SLOT NUMBER IS THE ADDRESS. The two are
 * separate on purpose. Things arrive in the order the list is written, so an
 * author who wants the first trophy on the left end drags it to the front;
 * `hook[3]` still means the slot numbered 3 wherever it now sits in the list. */
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

/* A saved set, made safe. A member that is not a legal anchor name is dropped
 * rather than carried: it can never resolve, and the publish gate that refuses a
 * set naming a missing anchor would then be refusing over a string nobody typed
 * into the members list on purpose. A duplicate is dropped for the same reason a
 * duplicate anchor name is, and it is what makes "the set is complete" a
 * countable question. */
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

/* A saved rack, made safe. Two hooks numbered 3 is not a rack, so the second one
 * loses: an address that resolves to two positions is worse than a missing
 * position, because nothing downstream can tell which one it got. slotNext comes
 * back at least one past the highest number present, so a hand-edited save can
 * never hand out a number that is already on the wall. */
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
  /* WHICH PLACEMENT, BY ITS AUTHOR NAME and never by its id. The id is a counter
   * MAPVIS made up that does not survive a delete and a re-place, which is the
   * same reason an anchor binds by name. The game resolves both, so a name is
   * the half that stays true. */
  placement: string
  /* what a person reads in the panel. Never the identity. */
  label?: string
}

/* A NAMED EXCLUSIVE VARIANT SET: one name, several PLACEMENTS, at most one of
 * them visible.
 *
 * NOT ONE PLACEMENT WEARING ANOTHER FACE. That is `looks` and `art`, it is
 * already built, and it is the wrong tool here. §8.12's ship and empty berth is
 * the case that settles it: a ship at a dock and the empty water where it is not
 * are two objects with different silhouettes, different footprints and different
 * anchors, and drawing them as two frames of one sprite would give the empty
 * berth the ship's collision and the ship the berth's y-sort. A face swap is one
 * thing changing; this is two things trading places.
 *
 * WHAT IT BUYS: python sets a state without knowing how many faces exist. Five
 * dock placements, one per island state, and a grape writes the word rather than
 * showing one and hiding four by hand, which is the version that ships with the
 * fifth `show` forgotten and two docks on screen at once.
 *
 * IT HANGS ON AN ANCHOR, AND THAT IS REQUIRED. The anchor namespace is the only
 * addressing system the running game has: every intent in src/vine/intents.ts
 * that touches the world takes `anchor: string`, `show` resolves an anchor to
 * `a.placement` and then to a sprite, and readAnchors carries an anchor's meta
 * bag across intact. A set with nowhere to be addressed from is a set nobody can
 * name, so the anchor it hangs on is where it is published to. Several sets may
 * share one anchor, keyed by name, exactly as several shots may.
 *
 * The state a run OPENS on is `initial`, and empty is a legal answer: an author
 * who wants nothing showing until the story says otherwise says so here rather
 * than shipping a placement they then have to hide on the first frame. */
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

/* A saved variant set, made safe.
 *
 * A member naming a placement twice is dropped, because two states pointing at
 * one placement cannot be exclusive: setting either one leaves the same sprite
 * on screen and nothing downstream can say which state it is in. A duplicate
 * state name goes for the reason a duplicate anchor name does. An `initial`
 * naming a member that is not in the list falls back to nothing rather than to
 * the first one: showing an arbitrary member is worse than showing none, because
 * none is a state an author can see is wrong.
 *
 * A set with fewer than two members is KEPT. One member is an author part way
 * through building the second, and it still answers correctly. */
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

/* A GROUP OF PLACEMENTS, WHICH ALREADY EXISTED AS A STRING AND NOW HAS A ROW.
 *
 * Every placement carries `group`, the editor hides and shows by it, and there
 * was nowhere to say anything ABOUT one. That matters for exactly one field so
 * far: a dozen placements that are the same year's dressing share one condition,
 * and copying that string onto each of them means the thirteenth is added
 * without it and nothing anywhere says so.
 *
 * The name IS the group string on the placements. There is no id, because
 * `a.group` is the join and adding a second identity would let a placement point
 * at a group that has been renamed out from under it. */
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

/* A saved group, made safe. The name is a placement's `group` string rather than
 * an anchor name, and those have always been free text (`props`, `effects`,
 * `people`), so it is folded rather than refused: refusing would silently drop
 * the condition off every group that was made before this existed. A group
 * carrying nothing at all is dropped, because a row that says only its own name
 * is what every placement already says. */
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

/* THE CONDITION A PLACEMENT ACTUALLY SHIPS WITH: its own if it has one, its
 * group's otherwise. Resolved here rather than in the game, because the game's
 * assets loop has a placement in hand and no group table beside it, and handing
 * it one would be a second lookup for a string that never changes after export. */
export function whenOf(a: { when?: string; group?: string }, groups: MapGroup[]): string {
  if (typeof a.when === 'string' && a.when.trim()) return a.when.trim()
  const g = groups.find((q) => q.name === a.group)
  return g && g.when ? g.when : ''
}

/* THE GAME'S OWN PULL-OUT CONSTANT, and MAPVIS carries it because MAPVIS is the
 * one that moves. The consumer computes its opening scale as
 * `max(1, floor(min(sw / W, sh / H))) * 1.18` and then multiplies a framing's
 * zoom by that, so a shot exported as 1 is the map's opening view and 1.9 is
 * pushed in. Nothing here can change what the game does with the number, so the
 * conversion happens on the way out and this constant lives at the emit.
 * AdventureGame/src/game/pmap/PmapScene.tsx:828-829 is where it comes from. */
export const GAME_OPENING_PULL = 1.18

/* What a shot is worth to the game. A framing armed before overFit existed has
 * no honest answer, so it becomes the map's opening view rather than the raw
 * editor notch: an opening view is a shot somebody can look at and re-arm, and
 * a notch shipped straight through is a nose filling the screen with nothing
 * anywhere saying why. */
export function shotZoom(f: { zoom?: number; overFit?: number }): number {
  const rel = isFinite(Number(f.overFit)) && Number(f.overFit) > 0 ? Number(f.overFit) : 0
  if (!rel) return 1
  return Math.round((rel / GAME_OPENING_PULL) * 1000) / 1000
}

/* SHOTS FOLDED ONTO THE ANCHOR THEY NAME, which is where the consumer looks.
 *
 * MAPVIS keeps its shots in a list of their own, and that list is the authoring
 * record: it is what the panel edits, what reloads, and what the api hands to
 * python. The game has never had a reader for it. What the game reads is the
 * anchor's own `meta` bag, `meta.framings[name]` first and `meta.framing` as the
 * unnamed default, with the fields spelt exactly zoom, dx, dy and name. So the
 * list stays and this writes the same shots into the place they are read from.
 *
 * WHICH ONE IS THE DEFAULT matters more than it looks. look_at asks for a shot
 * with no name at all, and a script naming a shot the map does not carry falls
 * back to the same slot, so an anchor with named shots and no default has a
 * silently dead camera on both paths. The entry shot takes it if there is one
 * on this anchor, otherwise the oldest, because ids only ever count upwards and
 * the first shot somebody armed on a station is the one they framed it with.
 *
 * MERGED, NEVER SWAPPED IN. panthers_maw on the real hub already carries
 * docId and derived, and the game writes `derived` itself when it has to invent
 * a name, so replacing the bag would take both out. `framing` and `framings` are
 * the only two keys touched, and only when a shot actually hangs here.
 *
 * A name of `(default)` cannot happen: framing names go through isAnchorName,
 * and that is the literal string the game's own refusal listing prints for the
 * unnamed slot. */
/* OWNING A KEY MEANS OWNING ITS ABSENCE TOO.
 *
 * Both projections below were additive only: with no shots on an anchor they
 * handed the incoming bag straight back, so a `framings` or `framing` key
 * already sitting in it shipped as a live camera the shot list no longer
 * contained. That is reachable and permanent. restoreFromDisk pulls map.json's
 * anchors into the document carrying the PROJECTED meta from the previous
 * export, and the shot list is empty at that point, so syncEventsToAnchors bakes
 * the stale projection into postgres and every later publish reads it back and
 * re-ships it. The author sees no shots, cannot edit or delete the camera, and
 * the game keeps pushing in on it, because framingOf reads meta.framings[name]
 * and meta.framing and never cross-checks anything.
 *
 * A DELIBERATE SECOND COPY of the same helper in server/store/publish.mjs. If
 * either half changes, change both. */
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

/* VARIANT SETS FOLDED ONTO THE ANCHOR THEY HANG ON, for the same reason the
 * shots above are, and read off the running game before it was written.
 *
 * WHAT THE GAME READS TODAY. src/game/pmap/anchors.ts:readAnchors builds its
 * Anchor from a fixed list of top-level fields and then copies `meta` whole, so
 * a new top-level field on an anchor is thrown away by the reader that already
 * ships. src/game/pmap/PmapScene.tsx keys every placement into `placedById` by
 * BOTH its MAPVIS id and its author name, and `show(anchor, visible)` resolves
 * `anchor.placement` through that map. So the two things the consumer can
 * already do are: read an anchor's bag, and turn a placement name into a sprite.
 * A set written as { state: placement-name } inside the bag needs neither a new
 * reader shape nor a new lookup, only a loop.
 *
 * MERGED, NEVER SWAPPED IN, the same as the shots: panthers_maw on the real hub
 * carries docId and derived, and the game writes `derived` itself.
 *
 * MAPVIS DOES NOT PICK A DEFAULT HERE, and that is the difference from a shot. A
 * missing shot has to fall back to something or the camera is dead; a set with
 * `initial` empty means nothing is showing, which is a state an author chose. */
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
  /* the named collections of anchors, which belong to the map for the same
   * reason: they are made of this map's names and nothing outside it can hold
   * them. A set is unordered membership, a rack is addressed positions. */
  sets: MapAnchorSet[] = []
  setNext = 1
  racks: MapRack[] = []
  rackNext = 1
  /* the named exclusive variant sets, and the rows that say something about a
   * placement group. Both belong to the map for the reason the collections above
   * do: they are made of this map's own names and nothing outside it can hold
   * them. */
  variants: MapVariantSet[] = []
  variantNext = 1
  groups: MapGroup[] = []
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
        /* the same treatment for the two collections, and for the same reason: a
         * set naming something that is not an anchor name at all, or a rack with
         * two hooks numbered 3, has to come back as data or not at all. */
        this.sets = Array.isArray(d.sets) ? d.sets.map(migrateAnchorSet).filter((s): s is MapAnchorSet => !!s) : []
        this.setNext =
          Number(d.setNext) > 0 ? Math.round(Number(d.setNext)) : this.sets.reduce((m, s) => Math.max(m, s.id), 0) + 1
        this.racks = Array.isArray(d.racks) ? d.racks.map(migrateRack).filter((r): r is MapRack => !!r) : []
        this.rackNext =
          Number(d.rackNext) > 0 ? Math.round(Number(d.rackNext)) : this.racks.reduce((m, r) => Math.max(m, r.id), 0) + 1
        /* and the variant sets, on the same terms. A set whose members all name
         * the same placement, or whose initial names a member that is not in the
         * list, has to come back as data or not at all: an exclusive set that is
         * not exclusive is worse than none, because every state leaves the same
         * sprite on screen and nothing can tell which one it is in. */
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
