/* THE WATER BETWEEN THE ISLANDS, WHICH NOTHING COULD AUTHOR.
 *
 * A MAPVIS document cannot exist without a painting. The id comes from a
 * dropped filename, every later step operates on its pixels, and anchor
 * creation refuses a click outside the canvas because armDoor tests inB(x, y).
 * The canvas only grows by transparent margin, and growing it changes w/h,
 * which the game fits its camera from, so buying room for a mooring anchor
 * zooms the whole island out.
 *
 * So the one surface the entire crossing happens on was the one surface with no
 * author, and everything about it lived as constants in the other repo. This is
 * that surface. It is not a map and it has no painting: it is a coordinate
 * space with maps placed on it, and a place can be marked before anything has
 * been painted for it.
 *
 * ONE ROW, because there is one ocean. Two accounts holding two compositions
 * would be two worlds that cannot both be sailed, and a berth is a position
 * relative to every other island rather than a private note.
 */
import { q, one } from '../db/pool.mjs'

/* THE STATES THE OVERWORLD READS, spelt the way the overworld spells them.
 *
 * This list was written from memory and got three of them wrong, which is the
 * failure the whole survey was for. The game's SlotState is the authority and
 * MAPVIS moves to it.
 *
 *   rumour    not `rumoured`. One letter, and without it the game marks every
 *             empty slot in the composition as a fault.
 *   rising    was missing, and it is the one state the world owns rather than
 *             the student: the island coming up out of the water, with an
 *             effect hung on it. MAPVIS could not author the only state that is
 *             purely a property of the composition.
 *   in_season is GONE. Being in season is per student and per season, derived
 *             from the roster and the run's own ledger. An authored one is a
 *             world-level claim about a per-run fact, so the two would
 *             contradict each other and nothing would say which won.
 *
 * `rumour` still belongs to an empty slot: a reserved position holding no map,
 * where the rise happens where the rumour was. */
export const ISLAND_STATES = [
  'rumour',
  'rising',
  'misty',
  'discovered',
  'available',
  'active',
  'completed',
]

/* the two spellings that reached the database before the survey, kept so that
 * reopening the ocean does not quietly turn every reserved slot into misty */
const STATE_WAS = { rumoured: 'rumour', in_season: 'active' }

/* what the water is, where it is not an island. Same vocabulary the walkable
 * mask cannot answer, because the mask answers a question about feet and a
 * ship is not a walker. */
export const SEA_KINDS = ['sailable', 'shallow', 'forbidden', 'mist', 'ambience']

/* WHAT A POINT ON THE WATER IS FOR, AND THERE IS ONLY ONE KIND OF POINT NOW.
 *
 * Ash, 2026-08-30: "collapse it into waypoints. currently, a berth is tied to a
 * corner of the map and annoying to place around. keep it simple, we can call
 * it a 'berth' which are basically waypoints for the ocean. you can place and
 * move it around freely."
 *
 * So `berth` is the word and the default, and everything on the water is one.
 * The rest of this list is a FILTER and not a second type: a grape asking for
 * the anchorages should not be handed every landmark too. They are drawn the
 * same, dragged the same and addressed the same.
 *
 * `approach` is GONE. It was never a kind of point, it was the second field on
 * a place, and 019_berths.sql lifted every one of them out as a plain berth.
 * Nothing writes it and cleanMark would have quietly kept accepting it. */
export const MARK_KINDS = ['berth', 'waypoint', 'anchorage', 'landmark', 'spawn']

const isName = (s) => /^[a-z][a-z0-9_]{0,47}$/.test(String(s || ''))

/* WHICH PLACE ON THE ROSTER THIS IS, and it cannot be the same string as `name`.
 *
 * The game addresses a slot by its place id and counts what a student has been
 * exposed to by the same id, so a composition carrying none has every island
 * stuck at misty forever and nothing ever discovered. Those ids belong to the
 * roster and they are kebab-case: home-island, atc-room, flex-200. A python
 * identifier cannot spell one, which is why this is a second field and not a
 * looser rule on the first. */
const isPlaceId = (s) => /^[a-z][a-z0-9-]{0,47}$/.test(String(s || ''))

const num = (v, d = 0) => (isFinite(Number(v)) ? Math.round(Number(v)) : d)

/* One entry in the composition. `map` empty is deliberate and is the whole of
 * the empty-slot ask: a position that exists, carries a state and reads as a
 * rumour, with no bundle behind it yet.
 *
 * A PLACE NO LONGER CARRIES A POINT. It held `berth` and `approach` as two
 * nested objects, which is what welded a mooring to the island that owned it:
 * the only way to make a point on the water was to pick an island first, and a
 * point halfway between two of them had to be faked as a berth on whichever was
 * nearer. Both are entries in `marks` now, with `island` naming the place they
 * belong to, so "attached to an island" is a field and not a different type. */
export function cleanPlace(p) {
  if (!p || !isName(p.name)) return null
  const state = STATE_WAS[p.state] || (ISLAND_STATES.includes(p.state) ? p.state : 'misty')
  /* TWO RADII, BECAUSE THE GAME HAS TWO AND MAPVIS HAD THE WRONG ONE.
   *
   * `release` here meant "how close before this counts as discovered", which is
   * what the game calls `discover`. What the game calls `release` is residency:
   * how far out the bundle stays decoded in memory, and it is the number the
   * memory budget trims against on a 4 GB chromebook. So MAPVIS's word for
   * discovery was the game's word for memory, and MAPVIS had no field at all for
   * the one that decides what gets dropped.
   *
   * A row written before the split says `release` and means discovery, so it is
   * read as discovery and residency is defaulted from it. 160 was also wrong by
   * an order of magnitude against the 520 and 1400 that are actually authored,
   * and the default follows the shape of those rather than the old one. */
  const pre = p.discover === undefined && p.release !== undefined
  const discover = Math.max(0, num(p.discover, pre ? num(p.release, 520) : 520))
  return {
    name: p.name,
    /* the roster id, which is a different string from the address above and is
     * how the game finds this slot at all */
    ...(isPlaceId(p.place) ? { place: p.place } : {}),
    map: typeof p.map === 'string' ? p.map.slice(0, 60) : '',
    title: typeof p.title === 'string' ? p.title.slice(0, 120) : '',
    x: num(p.x),
    y: num(p.y),
    w: Math.max(1, num(p.w, 64)),
    h: Math.max(1, num(p.h, 64)),
    state,
    discover,
    // held in memory well past the radius that discovered it, or the bundle is
    // dropped and re-fetched every time the hull drifts back across one circle
    release: pre || num(p.release, 0) <= discover ? discover * 2 : num(p.release),
    ...(p.meta && typeof p.meta === 'object' && !Array.isArray(p.meta) ? { meta: p.meta } : {}),
  }
}

/* A BERTH: THE ONE KIND OF POINT ON THE WATER, AND IT IS FREE STANDING.
 *
 * There were two shapes doing this job and one of them could not be placed. A
 * place carried a nested `berth` and a nested `approach`, welded to whichever
 * island owned them, and this list carried everything else. So the corner a sail
 * leg turns at halfway across, which belongs to neither island it sits between,
 * had to be faked as a berth on the nearer one and then moved when that island
 * moved.
 *
 * One array now, and `island` is how a point says it belongs to a place: a
 * FIELD rather than a different type. A berth with no island is the corner in
 * open water; a berth naming `the_hub` is the hub's dock, moves when the hub
 * moves, and is what composition() hands the game as that slot's berth.
 *
 * The NAME is the whole of the interface, because python only ever holds a name,
 * and a route between two berths is a later thing this shape is already able to
 * express: sail(from='the_hub_berth', via=['north_passage']) needs nothing here
 * that is not here. Nothing draws or stores a route yet, on purpose.
 *
 * A BAD NAME IS DROPPED RATHER THAN CORRECTED. Bending `North Passage` into
 * `north_passage` invents an address the author never wrote and nothing in their
 * code calls, which is worse than the berth simply not being there. cleanPlace
 * takes the same line for the same reason.
 */
export function cleanMark(m) {
  if (!m || !isName(m.name)) return null
  // absent rather than zeroed: (0,0) is a real position on the ocean, so a point
  // with no coordinates is not a point
  if (!isFinite(Number(m.x)) || !isFinite(Number(m.y))) return null
  return {
    name: m.name,
    /* BERTH IS THE FALLBACK NOW, and it was `waypoint`. Everything on the water
     * is a berth unless an author deliberately narrowed it, so a kind this file
     * has never heard of lands on the word Ash gave the category rather than on
     * one that no longer means anything different. */
    kind: MARK_KINDS.includes(m.kind) ? m.kind : 'berth',
    x: num(m.x),
    y: num(m.y),
    ...(m.facing ? { facing: String(m.facing).slice(0, 16) } : {}),
    // how close counts as arrived, so sailing to a berth is not an exact-pixel
    // test on a hull that moves in floats. Absent leaves it to the caller.
    ...(isFinite(Number(m.r)) ? { r: Math.max(0, num(m.r)) } : {}),
    ...(m.label ? { label: String(m.label).slice(0, 120) } : {}),
    /* WHICH ISLAND THIS POINT BELONGS TO, IF ANY. Not validated against the
     * roster here, because cleanMark runs one row at a time and cannot see the
     * places; checkWorld warns about an island nobody has drawn. A name that is
     * not even a legal address is dropped, since it can never match one. */
    ...(isName(m.island) ? { island: m.island } : {}),
    /* WHERE THE HULL PUTS SOMEBODY DOWN ONCE THEY ARE ASHORE. It lived on the
     * nested berth and it is the one field from there that had nowhere else to
     * go: without it a voyage arrives at the destination's default spawn rather
     * than the dock somebody drew, and nothing anywhere says it was ignored. An
     * anchor name inside the map being arrived at, so it takes the same rule
     * every other name in this tool takes. */
    ...(isName(m.at) ? { at: m.at } : {}),
    ...(m.meta && typeof m.meta === 'object' && !Array.isArray(m.meta) ? { meta: m.meta } : {}),
  }
}

/* THE BERTH THE GAME MEANS WHEN IT SAYS "THIS ISLAND'S BERTH".
 *
 * A place used to carry exactly one, so there was nothing to choose. Now it can
 * carry any number, and the game's slot shape has room for one, so the rule has
 * to be written down somewhere rather than being whichever the reader reached
 * first: the earliest berth-kind point bound to that island wins, and an author
 * who wants a different one moves it up the list. Everything bound to the island
 * still goes out on the wire under `marks`, so nothing is hidden by this. */
export const berthOf = (marks, name) => (marks || []).find((m) => m.island === name && m.kind === 'berth') || null

export function cleanRegion(r) {
  if (!r || !isName(r.name)) return null
  const rect = Array.isArray(r.rect) && r.rect.length === 4 && r.rect.every((n) => isFinite(Number(n)))
  if (!rect) return null
  return {
    name: r.name,
    kind: SEA_KINDS.includes(r.kind) ? r.kind : 'sailable',
    // two opposite corners, the same order and the same min/max tolerance the
    // anchor rect settled on, so one reader shape serves both
    rect: r.rect.map((n) => num(n)),
    ...(r.label ? { label: String(r.label).slice(0, 120) } : {}),
  }
}

export async function getWorld() {
  const w = await one('select w, h, places, regions, marks, home, version, updated_at from world where id = 1')
  if (!w) return { w: 4096, h: 4096, places: [], regions: [], marks: [], home: '', version: 1 }
  return {
    w: w.w,
    h: w.h,
    places: Array.isArray(w.places) ? w.places : [],
    regions: Array.isArray(w.regions) ? w.regions : [],
    marks: Array.isArray(w.marks) ? w.marks : [],
    /* WHERE A RUN WITH NO VESSEL RECORD STARTS, and where a graduate is handed
     * back to. One slot for the whole ocean, named by the same address a place
     * is addressed by. Nothing in MAPVIS could say it, so the game had it as a
     * constant beside the composition it was supposed to come out of. */
    home: w.home || '',
    version: w.version || 1,
    updatedAt: w.updated_at ? new Date(w.updated_at).getTime() : 0,
  }
}

/* THE OCEAN IN THE WORDS THE GAME ALREADY READS, and the reason this function
 * exists at all rather than the shape above simply being renamed.
 *
 * Two readers, two shapes, and only one of them gets to move. The chart page in
 * this tool drags a place around by w/h and draws a region from two corners,
 * and the game asks for a composition of `slots` with a footprint, an origin, a
 * canvas and a rect of x/y/w/h. The game is the consumer and its running shape
 * is canonical, so this is where MAPVIS moves: the row stays the authoring
 * document, and what leaves on the wire is the game's.
 *
 * The envelope alone was fatal. The game gates the whole fetch on
 * `Array.isArray(j.slots)` and MAPVIS answered with `places`, so a real
 * composition was discarded and a hand-written fallback used instead, with no
 * error logged anywhere on either side.
 *
 * THE THREE SIZES ARE ASKED OF THE MAPS TABLE, not of the author. A place
 * carries one w/h, and the game needs three different rectangles out of it: the
 * painted extent it measures a discovery radius against, the offset of that
 * painting inside a canvas that may have been grown, and the canvas itself,
 * which is what the memory budget is charged for. The platform already knows all
 * three per map and has since the first schema. A slot with no map falls back to
 * the author's w/h, because a rumour has no painting to ask.
 */
export async function composition() {
  const w = await getWorld()
  const rows = w.places.some((p) => p.map)
    ? (
        await q(
          `select slug, w, h, base_w, base_h, base_ox, base_oy, jsonb_array_length(assets) as placements from maps`,
        )
      ).rows
    : []
  const by = new Map(rows.map((r) => [r.slug, r]))
  return {
    /* NOT updated_at. The game stamps a saved position with this and refuses to
     * resume a run when it has changed, so a millisecond epoch would throw away
     * every position on every class chromebook each time an author nudged one
     * island. An integer that only counts up when the composition really moved. */
    version: w.version,
    ...(w.home ? { home: { slot: w.home } } : {}),
    slots: w.places.map((p) => {
      const m = p.map ? by.get(p.map) : null
      const b = berthOf(w.marks, p.name)
      return {
        ...(p.map ? { map: p.map } : {}),
        ...(p.place ? { place: p.place } : {}),
        title: p.title || '',
        at: { x: p.x, y: p.y },
        // the painted extent, which is what a distance is measured against.
        // Taking it off the canvas is 41 percent too generous on the hub, in the
        // direction that discovers an island before it is on screen.
        footprint: m ? { w: m.base_w, h: m.base_h } : { w: p.w, h: p.h },
        ...(m && (m.base_ox || m.base_oy) ? { origin: { x: m.base_ox, y: m.base_oy } } : {}),
        ...(m ? { canvas: { w: m.w, h: m.h } } : {}),
        // what this map really costs, so the budget stops charging every island
        // the same invented ninety-four and dropping ones it should have kept
        ...(m ? { placements: m.placements || 0 } : {}),
        state: p.state,
        release: p.release,
        discover: p.discover,
        /* THE BERTH IS LOOKED UP RATHER THAN UNPACKED, and the game does not
         * find out. It reads slot.berth about thirty times in PmapScene, so the
         * collapse is a change to where the point is AUTHORED and never to what
         * crosses: a free-standing point naming this island is folded back in
         * here under the key the game already reads.
         *
         * `approach` is not on the wire any more. It was an optional second
         * point inside the berth, nothing in the composition ever carried one,
         * and it is a plain berth of its own after 019, addressable by name like
         * everything else. `name` rides along so a grape holding a slot can go
         * straight to the flat marks lookup without matching coordinates. */
        ...(b
          ? {
              berth: {
                name: b.name,
                x: b.x,
                y: b.y,
                ...(b.facing ? { facing: b.facing } : {}),
                ...(b.at ? { at: b.at } : {}),
              },
            }
          : {}),
      }
    }),
    /* A RECT OF FOUR NUMBERS AGAINST A READER THAT WANTS FOUR KEYS is the
     * quietest failure on this endpoint: every comparison is against undefined
     * and false, so no region ever matches, no sea_region is ever logged, and
     * the chart's "anywhere you have not been" question has no correct answer
     * with nothing raised anywhere. Two corners in, a box out. */
    regions: w.regions.map((r) => {
      const [x0, y0, x1, y1] = r.rect
      return {
        name: r.name,
        ...(r.label ? { label: r.label } : {}),
        kind: r.kind,
        rect: { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) },
      }
    }),
    /* EVERY POINT ON THE WATER, INCLUDING THE ONES FOLDED INTO A SLOT ABOVE.
     *
     * The game's berthing holds one target per island rather than a list of
     * legs, so most of this is still unread over there, and that is fine: it is
     * not in the way of anything and a grape reads it flat at
     * /api/v1/world/marks. It stays until the sail loop grows routes, which is
     * the one thing this list was collapsed to make possible. */
    marks: w.marks,
    source: 'mapvis',
  }
}

/* WHAT A COMPOSITION IS NOT ALLOWED TO BE.
 *
 * The same argument as the publish gate: a world that cannot work should be
 * refused where it is written, naming the thing that is wrong, rather than
 * discovered by a student sailing into a berth that is not there. Names are the
 * addressing system, so a duplicate name is fatal; a map id nobody has
 * published is a warning rather than a refusal, because a slot is allowed to
 * name the island that is going to be painted next week.
 */
export function checkWorld(doc, slugs = []) {
  const problems = []
  const warnings = []
  const seen = new Set()
  for (const p of doc.places) {
    if (seen.has(p.name)) problems.push(`two places are both called "${p.name}", and a name is the only address there is`)
    seen.add(p.name)
    /* NEGATIVE IS NORMAL OUT THERE, and refusing it was this file reasoning
     * about a coordinate space it does not own. The game's ocean is the hub's
     * own painting pixels extended outwards with the hub at the origin, so half
     * of it is negative by construction: the shipped composition has a rumour at
     * y -260 and a mist bank starting at x -2600, and every one of them was
     * unstorable here. w/h stays as a hint for framing the chart, and it stops
     * being a validity test. */
    if (p.map && slugs.length && !slugs.includes(p.map))
      warnings.push(`"${p.name}" names the map "${p.map}", which nothing has published yet`)
    if (!p.map && p.state !== 'rumour')
      warnings.push(`"${p.name}" has no map, so only the state "rumour" reads honestly; it says "${p.state}"`)
    /* AN ISLAND THE GAME CANNOT ADDRESS. It looks a slot up by its place id and
     * counts exposure by the same id, so one without it is never discovered, has
     * no programmes, and reads misty for the whole run with nothing said. */
    if (p.map && !p.place)
      warnings.push(`"${p.name}" carries no place id, so the game has no id to discover it or count a visit under`)
    /* A BERTH YOU CANNOT REACH IS WORSE THAN NO BERTH, because the ship sails
     * to it and stops. It has to be within the discovery radius or the island is
     * never discovered at the point the dock is offered.
     *
     * Asked of the berth the GAME will use, through the same berthOf the wire
     * uses, so this cannot warn about a point the composition never sends. A
     * berth bound to the island but further down the list is somebody's spare
     * and is not what the hull sails to. */
    const b = berthOf(doc.marks, p.name)
    if (b) {
      const d = Math.hypot(b.x - p.x, b.y - p.y)
      if (d > p.discover)
        warnings.push(
          `"${b.name}" ties up ${Math.round(d)} out from "${p.name}", which is only discovered at ${p.discover}, so the dock is offered before the island is`,
        )
    }
  }
  /* ONE NAMESPACE, because python has one.
   *
   * A grape calls sail_to("north_passage") and never says which list to look in,
   * so a mark sharing a name with an island is a call whose answer depends on
   * which lookup the runtime happens to try first. Checked against the places
   * above rather than in a set of its own, and fatal for the same reason a
   * duplicate place is: the name is the only address there is. */
  const diag = Math.hypot(doc.w, doc.h)
  const isles = new Set(doc.places.map((p) => p.name))
  for (const m of doc.marks || []) {
    if (seen.has(m.name))
      problems.push(`"${m.name}" is the name of two things on this ocean, and python addresses every place and every berth in one namespace`)
    seen.add(m.name)
    /* A BERTH BOUND TO AN ISLAND NOBODY HAS PLACED.
     *
     * `island` is what makes a mooring follow its island around instead of being
     * welded to it, and the cost of that is a name that can point at nothing:
     * delete the island and the berth stays, silently unbound, still drawn and
     * still sailed to. A warning and not a refusal, because an author is allowed
     * to mark the dock before the island exists. */
    if (m.island && !isles.has(m.island))
      warnings.push(`"${m.name}" says it belongs to "${m.island}", and no island on this ocean is called that`)
    // no bounds test here either, for the same reason a place has none: the sea
    // the game sails is centred on the hub and runs negative in both directions
    /* A BERTH WITH NOTHING TO SAIL BETWEEN. The yardstick is deliberately the
     * whole ocean's diagonal, so nothing inside a populated composition can
     * ever trip it: what it really catches is a point left behind after the
     * islands either side of it were deleted, which is a leg that goes nowhere
     * and a cutscene that stops. A warning and not a refusal, because marking
     * the water before painting the island is allowed here the same way an
     * empty slot is. */
    const nearest = doc.places.length ? Math.min(...doc.places.map((p) => Math.hypot(m.x - p.x, m.y - p.y))) : Infinity
    if (nearest > diag)
      warnings.push(`the berth "${m.name}" has no island within reach of it, so nothing sails to or from it`)
  }
  const rseen = new Set()
  for (const r of doc.regions) {
    if (rseen.has(r.name)) problems.push(`two sea regions are both called "${r.name}"`)
    rseen.add(r.name)
  }
  return { problems, warnings }
}

export async function saveWorld(input) {
  /* NO MARKS IN THE BODY IS NOT THE SAME AS NO MARKS.
   *
   * Every caller written before marks existed posts w, h, places and regions and
   * says nothing at all about this field. Treating that silence as an empty list
   * means dragging one island and pressing save wipes every point the crossing
   * is built out of, and nothing anywhere would mention it. So an absent key
   * keeps what is in the row and only a real array replaces it, which is also
   * what lets an empty array still mean "clear them".
   *
   * IT MATTERS MORE SINCE 019 THAN IT DID BEFORE. This list held only free
   * waypoints, so the worst a silent caller could do was lose a corner of a
   * route. It now holds every berth on the ocean, so the same silence would take
   * every dock with it. */
  const stated = Array.isArray(input?.marks)
  const was = await getWorld()
  const doc = {
    w: Math.max(1, num(input?.w, 4096)),
    h: Math.max(1, num(input?.h, 4096)),
    places: (Array.isArray(input?.places) ? input.places : []).map(cleanPlace).filter(Boolean),
    regions: (Array.isArray(input?.regions) ? input.regions : []).map(cleanRegion).filter(Boolean),
    marks: stated ? input.marks.map(cleanMark).filter(Boolean) : was.marks,
    // silence keeps what is there, the same argument marks makes, so a page that
    // has never heard of a home slot cannot clear one by saving
    home: typeof input?.home === 'string' ? (isName(input.home) ? input.home : '') : was.home,
  }
  const slugs = (await q('select slug from maps')).rows.map((r) => r.slug)
  const { problems, warnings } = checkWorld(doc, slugs)
  if (problems.length) {
    const e = new Error(`the world was not saved · ${problems.join(' · ')}`)
    e.problems = problems
    throw e
  }
  /* THE VERSION COUNTS UP ONLY WHEN THE COMPOSITION REALLY MOVED.
   *
   * The game stamps a saved position with this number and refuses to resume a
   * run when it has changed, because a position taken before a re-cut can land
   * inside blocked pixels. So it has to be quiet: a title typed, a berth nudged
   * or a save that changed nothing must leave it alone, or thirty chromebooks
   * lose their place every time somebody presses save. Compared on the things
   * that actually move a hull, which is where the islands are, how far out they
   * read, and how the water is divided.
   *
   * MARKS ARE STILL OUT OF THE COMPARISON, and that is deliberate rather than
   * left over from when they were only waypoints. A saved position is a spot a
   * student is STANDING on inside a painting, and moving the dock they arrived
   * through does not put them inside a wall. Dragging the island does, and that
   * is in `places`, which is in the comparison. */
  /* KEYS SORTED, because the two sides of this comparison have been through
   * different mills. One is freshly cleaned in this process and the other came
   * back out of jsonb, and postgres does not keep the order an object went in
   * with. Comparing the raw stringify counted a version up on every save that
   * changed nothing, which is the failure this guard exists to prevent. */
  const stable = (v) =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, stable(v[k])]),
          )
        : v
  const shape = (d) => JSON.stringify(stable([d.w, d.h, d.places, d.regions, d.home]))
  const version = shape(doc) === shape(was) ? was.version : (was.version || 1) + 1
  await q(
    `insert into world (id, w, h, places, regions, marks, home, version, updated_at)
     values (1, $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, now())
     on conflict (id) do update set w = $1, h = $2, places = $3::jsonb, regions = $4::jsonb,
       marks = $5::jsonb, home = $6, version = $7, updated_at = now()`,
    [doc.w, doc.h, JSON.stringify(doc.places), JSON.stringify(doc.regions), JSON.stringify(doc.marks), doc.home, version],
  )
  return { ...doc, version, warnings }
}
