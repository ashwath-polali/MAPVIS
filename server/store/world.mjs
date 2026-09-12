/* the ocean is a coordinate space with no painting, so a place can be marked before anything is painted for it; one row per account and row 1 is the one the game reads */
import { db, q, one } from '../db/pool.mjs'

/* a constant and not a lookup, because /api/v1/world is fetched with no account and no way to say whose world it wants */
export const GAME_WORLD = 1

/* the lock pins one client for the read, the version decision and the write, because pg_advisory_lock belongs to its connection and is re-entrant, so taking it through the pool gives no exclusion at all */
export const WORLD_LOCK = 774_112_090

/* the lock is per world through the two-integer form, or every author on the platform queues behind every other author's save */
export async function withWorld(fn, id = GAME_WORLD) {
  const c = await db().connect()
  try {
    await c.query('select pg_advisory_lock($1, $2)', [WORLD_LOCK, id])
    try {
      return await fn(c)
    } finally {
      await c.query('select pg_advisory_unlock($1, $2)', [WORLD_LOCK, id])
    }
  } finally {
    c.release()
  }
}

/* row 1 is the game's and its owner is claimed rather than left null, or the ocean owner falls through to the insert and gets a second world orphaning the one the game reads */
export async function worldIdFor(ownerId, { game = false } = {}) {
  if (game || !ownerId) {
    /* guarded on the account not already having one, or an account named as ours later gets row 1 too and the one-world-per-account index refuses the request */
    if (ownerId)
      await q(
        `update world set owner_id = $1 where id = $2 and owner_id is null
           and not exists (select 1 from world where owner_id = $1)`,
        [ownerId, GAME_WORLD],
      )
    return GAME_WORLD
  }
  const mine = await one('select id from world where owner_id = $1', [ownerId])
  if (mine) return mine.id
  /* on conflict on the owner index, because two tabs signing in at once both read no row and both insert */
  const made = await one(
    `insert into world (owner_id) values ($1)
     on conflict (owner_id) where owner_id is not null do update set owner_id = excluded.owner_id
     returning id`,
    [ownerId],
  )
  return made.id
}

/* a stranger's ocean is read at /api/v1/worlds/<pub_id>, plural so it can never shadow the two paths the game already holds */
export async function worldPubId(id = GAME_WORLD) {
  const r = await one('select pub_id from world where id = $1', [id])
  return r ? String(r.pub_id) : ''
}

export async function worldByPubId(pub) {
  if (!/^[0-9a-f-]{36}$/i.test(String(pub || ''))) return 0
  const r = await one('select id from world where pub_id = $1', [pub])
  return r ? r.id : 0
}

/* the game's SlotState is the authority: `rumour` not `rumoured` or every empty slot reads as a fault, and in_season is gone because it is per student and per season */
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

/* everything on the water is a berth and this list is a filter rather than a second type; approach is never a kind because it only means anything relative to the berth it hangs on */
export const MARK_KINDS = ['berth', 'waypoint', 'anchorage', 'landmark', 'spawn']

/* four headings only, because the game's radOf answers east, south and north and sends every diagonal to west with nothing said; a waypoint's facing is not narrowed */
export const BERTH_FACINGS = ['north', 'east', 'south', 'west']

const isName = (s) => /^[a-z][a-z0-9_]{0,47}$/.test(String(s || ''))

/* the roster's place id is kebab-case, which a python identifier cannot spell, so it is a second field and without it every island stays misty forever */
const isPlaceId = (s) => /^[a-z][a-z0-9-]{0,47}$/.test(String(s || ''))

const num = (v, d = 0) => (isFinite(Number(v)) ? Math.round(Number(v)) : d)

/* an empty `map` is a real slot with no bundle yet, and a place carries no nested point because welding a mooring to its island made a mid-ocean corner impossible to place */
export function cleanPlace(p) {
  if (!p || !isName(p.name)) return null
  const state = STATE_WAS[p.state] || (ISLAND_STATES.includes(p.state) ? p.state : 'misty')
  /* two radii: the game's `discover` is proximity and its `release` is memory residency, and an old row saying `release` meant discovery so it is read that way */
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

/* one free-standing array with `island` as a field, and a bad name is dropped rather than corrected because bending it invents an address nothing in the author's code calls */
export function cleanMark(m) {
  if (!m || !isName(m.name)) return null
  // absent rather than zeroed: (0,0) is a real position on the ocean, so a point
  // with no coordinates is not a point
  if (!isFinite(Number(m.x)) || !isFinite(Number(m.y))) return null
  return {
    name: m.name,
    /* berth is the fallback, because everything on the water is one unless an author deliberately narrowed it */
    kind: MARK_KINDS.includes(m.kind) ? m.kind : 'berth',
    x: num(m.x),
    y: num(m.y),
    ...(m.facing ? { facing: String(m.facing).slice(0, 16) } : {}),
    // how close counts as arrived, so sailing to a berth is not an exact-pixel
    // test on a hull that moves in floats. Absent leaves it to the caller.
    ...(isFinite(Number(m.r)) ? { r: Math.max(0, num(m.r)) } : {}),
    ...(m.label ? { label: String(m.label).slice(0, 120) } : {}),
    /* not validated against the roster here, because cleanMark runs one row at a time and cannot see the places; checkWorld warns instead */
    ...(isName(m.island) ? { island: m.island } : {}),
    /* the anchor a hull puts somebody down at, because without it a voyage lands on the destination's default spawn and nothing says it was ignored */
    ...(isName(m.at) ? { at: m.at } : {}),
    /* the run-in is nested because it is geometry relative to one berth that nothing sails to and nothing names, and it replaces a positional rule nothing on the page could see; still authorable over the wire only */
    ...(m.approach && isFinite(Number(m.approach.x)) && isFinite(Number(m.approach.y))
      ? { approach: { x: num(m.approach.x), y: num(m.approach.y) } }
      : {}),
    ...(m.meta && typeof m.meta === 'object' && !Array.isArray(m.meta) ? { meta: m.meta } : {}),
  }
}

/* the earliest berth-kind point bound to the island wins, because the game's slot shape has room for one and the rule cannot be whichever a reader reached first */
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

/* Takes an optional pinned client so the read, the version decision and the
 * write inside saveWorld are one atomic unit under one advisory lock. With no
 * client it is the pool, which is what every plain reader wants. */
export async function getWorld(client, id = GAME_WORLD) {
  const run = client ? (t, p) => client.query(t, p) : q
  const w = (await run('select id, pub_id, w, h, places, regions, marks, home, version, updated_at from world where id = $1', [id])).rows[0] || null
  // updatedAt 0 on an ocean nobody has written, so the save precondition reads
  // "there is nothing here to be stale against" rather than refusing the first save
  if (!w) return { id, pubId: '', w: 4096, h: 4096, places: [], regions: [], marks: [], home: '', version: 1, updatedAt: 0 }
  return {
    /* the id and the pub id ride along to save a second round trip, and neither reaches the game because composition() is a different shape */
    id: w.id,
    pubId: String(w.pub_id || ''),
    w: w.w,
    h: w.h,
    places: Array.isArray(w.places) ? w.places : [],
    regions: Array.isArray(w.regions) ? w.regions : [],
    marks: Array.isArray(w.marks) ? w.marks : [],
    /* where a run with no vessel record starts, one slot for the whole ocean, addressed the way a place is */
    home: w.home || '',
    version: w.version || 1,
    updatedAt: w.updated_at ? new Date(w.updated_at).getTime() : 0,
  }
}

/* the wire is the game's shape and not the authoring row's, because the game gates the whole fetch on Array.isArray(j.slots) and discarded `places` silently; the three sizes are asked of the maps table */
export async function composition(id = GAME_WORLD) {
  const w = await getWorld(undefined, id)
  const rows = w.places.some((p) => p.map)
    ? (
        await q(
          `select slug, w, h, base_w, base_h, base_ox, base_oy, paint_w, paint_h, paint_ox, paint_oy,
                  jsonb_array_length(assets) as placements from maps`,
        )
      ).rows
    : []
  const by = new Map(rows.map((r) => [r.slug, r]))
  /* paint_* is the measured opaque box and base_* is the dropped image, which on the hub reads 688x640 and makes compositionFaults refuse the whole document */
  const paintOf = (m) =>
    m.paint_w > 0 && m.paint_h > 0
      ? { w: m.paint_w, h: m.paint_h, ox: m.paint_ox || 0, oy: m.paint_oy || 0 }
      : { w: m.base_w || m.w, h: m.base_h || m.h, ox: m.base_ox || 0, oy: m.base_oy || 0 }
  /* home is translated into the game's addressing here, because the game resolves it against place-or-map and an unresolvable home throws the whole ocean away */
  const hp = w.home ? w.places.find((p) => p.name === w.home) : null
  const homeSlot = hp ? hp.place || hp.map : ''
  return {
    /* not updated_at: the game refuses to resume a run when this changes, so an epoch would drop every saved position on every nudge */
    version: w.version,
    ...(homeSlot ? { home: { slot: homeSlot } } : {}),
    slots: w.places.map((p) => {
      const m = p.map ? by.get(p.map) : null
      const pb = m ? paintOf(m) : null
      const b = berthOf(w.marks, p.name)
      return {
        ...(p.map ? { map: p.map } : {}),
        ...(p.place ? { place: p.place } : {}),
        title: p.title || '',
        /* `at` is the painting's centre and not the chart's corner, because the game does toSea = at + (px - paintedCentre) and the corner put every berth on dry land */
        at: {
          x: p.x + (pb ? pb.ox + pb.w / 2 : p.w / 2),
          y: p.y + (pb ? pb.oy + pb.h / 2 : p.h / 2),
        },
        // the painted extent, which is what a distance is measured against.
        // Taking it off the canvas is 41 percent too generous on the hub, in the
        // direction that discovers an island before it is on screen.
        footprint: pb ? { w: pb.w, h: pb.h } : { w: p.w, h: p.h },
        /* sent whenever the painting is not the whole canvas, because absent means centred to the game and an origin of 0,0 is legitimate */
        ...(m && pb && (pb.w !== m.w || pb.h !== m.h || pb.ox || pb.oy) ? { origin: { x: pb.ox, y: pb.oy } } : {}),
        ...(m ? { canvas: { w: m.w, h: m.h } } : {}),
        // what this map really costs, so the budget stops charging every island
        // the same invented ninety-four and dropping ones it should have kept
        ...(m ? { placements: m.placements || 0 } : {}),
        state: p.state,
        release: p.release,
        discover: p.discover,
        /* the free-standing berth is folded back under the key the reading side already reads, approach nested on the berth itself rather than taken off list order, and the heading narrowed to the four radOf can turn into an angle */
        ...(b
          ? {
              berth: {
                name: b.name,
                x: b.x,
                y: b.y,
                ...(BERTH_FACINGS.includes(b.facing) ? { facing: b.facing } : {}),
                ...(b.approach ? { approach: { x: b.approach.x, y: b.approach.y } } : {}),
                ...(b.at ? { at: b.at } : {}),
              },
            }
          : {}),
      }
    }),
    /* two corners in, a box out, because the reader wants four keys and a four-number rect makes every comparison undefined so no region ever matches */
    regions: w.regions.map((r) => {
      const [x0, y0, x1, y1] = r.rect
      return {
        name: r.name,
        ...(r.label ? { label: r.label } : {}),
        kind: r.kind,
        rect: { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) },
      }
    }),
    /* every point on the water including the ones folded into a slot above, mostly unread by a consumer and read flat at /api/v1/world/marks */
    marks: w.marks,
    source: 'mapvis',
  }
}

/* WHICH WAY A COMPASS WORD POINTS, on the chart. y grows south, the same as
 * every raster in this tool, so north is negative y. */
export const FACING_VECTORS = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
  'north-east': [0.7071, -0.7071],
  'north-west': [-0.7071, -0.7071],
  'south-east': [0.7071, 0.7071],
  'south-west': [-0.7071, 0.7071],
}

/* how far off straight-at-the-island still counts as pointing into it. 0.5 is
 * sixty degrees: a bow aimed anywhere inside that cone is aimed at the land, and
 * anything wider than it is lying along the shore, which is what mooring is. */
export const INTO_COAST = 0.5

/* A BERTH WHOSE BOW IS IN THE LAND. The facing is the heading the hull holds
 * once she is tied up, so it must not point at the island she is tied to.
 *
 * Measured against the direction from the berth to the island's middle, not
 * against its box: a box test refuses a berth lying along a shore simply for
 * being beside it, and a dock is always beside it. What this can see is the
 * footprint the world document carries, so a berth deep inside a bay is judged
 * against the island as a whole and not against the water it actually sits in.
 * That is the one case where a hand is better than this, and it says so. */
export function facingIntoCoast(mark, place, map) {
  if (!mark || !place) return null
  const v = FACING_VECTORS[String(mark.facing || '').toLowerCase()]
  if (!v) return null
  /* the painting's middle, the same point checkWorld measures a berth's reach
   * from, so the two answers cannot disagree about where the island is */
  const cx = place.x + (map && map.paint_w > 0 ? map.paint_ox + map.paint_w / 2 : (map ? map.w : place.w) / 2)
  const cy = place.y + (map && map.paint_h > 0 ? map.paint_oy + map.paint_h / 2 : (map ? map.h : place.h) / 2)
  const dx = cx - mark.x
  const dy = cy - mark.y
  const d = Math.hypot(dx, dy)
  // tied up exactly on the middle of its own island is a different fault, and
  // there is no direction to measure from a point with no distance
  if (d < 1) return null
  const dot = (v[0] * dx + v[1] * dy) / d
  return dot > INTO_COAST ? { dot, degrees: Math.round((Math.acos(Math.min(1, dot)) * 180) / Math.PI) } : null
}

/* a duplicate name is fatal because names are the addressing system, and an unpublished map id is only a warning because a slot may name next week's island */
export function checkWorld(doc, slugs = [], maps = new Map()) {
  const problems = []
  const warnings = []
  const seen = new Set()
  /* the severity model is the consumer's: anything compositionFaults calls a fault is a problem here, because one fault throws the whole document away */
  const seenMap = new Set()
  for (const p of doc.places) {
    if (seen.has(p.name)) problems.push(`two places are both called "${p.name}", and a name is the only address there is`)
    seen.add(p.name)
    // the game faults on a map placed twice and discards the whole composition
    if (p.map && seenMap.has(p.map))
      problems.push(`the map "${p.map}" is placed twice, and the game refuses a whole composition that places one map in two positions`)
    if (p.map) seenMap.add(p.map)
    /* negative coordinates are normal, because the ocean has the hub at its origin and the shipped composition has a rumour at y -260 */
    if (p.map && slugs.length && !slugs.includes(p.map))
      warnings.push(`"${p.name}" names the map "${p.map}", which nothing has published yet`)
    if (!p.map && p.state !== 'rumour')
      problems.push(
        `"${p.name}" has no map, so its only honest state is "rumour" and it says "${p.state}" · the game refuses the whole composition over this, every other island with it`,
      )
    /* the mirror case, because the island tool is born a rumour and picking a painting never touched the state, so the ordinary path saved a document the game throws away */
    if (p.map && p.state === 'rumour')
      problems.push(
        `"${p.name}" holds the map "${p.map}" and still reads as a rumour · the game refuses the whole composition over this, so pick a state it has really reached`,
      )
    /* AN ISLAND THE GAME CANNOT ADDRESS. It looks a slot up by its place id and
     * counts exposure by the same id, so one without it is never discovered, has
     * no programmes, and reads misty for the whole run with nothing said. */
    if (p.map && !p.place)
      warnings.push(`"${p.name}" carries no place id, so the game has no id to discover it or count a visit under`)
    /* one chart unit is one painting pixel, so a place's box has to be its map's canvas or every point aimed at it lands elsewhere */
    const mm = p.map ? maps.get(p.map) : null
    if (mm && (p.w !== mm.w || p.h !== mm.h))
      warnings.push(
        `"${p.name}" is drawn ${p.w}x${p.h} on the chart in front of a ${mm.w}x${mm.h} painting, and one chart unit has to be one painting pixel, so every point aimed against it lands somewhere else`,
      )
    /* asked of the berth the game will use, through the same berthOf the wire uses, so it cannot warn about a point the composition never sends */
    const b = berthOf(doc.marks, p.name)
    if (b) {
      /* measured from the painting's centre because the game measures every radius from `at`, and the corner reported a reachable berth as 807 out */
      const c = mm
        ? { x: p.x + (mm.paint_w > 0 ? mm.paint_ox + mm.paint_w / 2 : mm.w / 2), y: p.y + (mm.paint_h > 0 ? mm.paint_oy + mm.paint_h / 2 : mm.h / 2) }
        : { x: p.x + p.w / 2, y: p.y + p.h / 2 }
      const d = Math.hypot(b.x - c.x, b.y - c.y)
      if (d > p.discover)
        warnings.push(
          `"${b.name}" ties up ${Math.round(d)} out from "${p.name}", which is only discovered at ${p.discover}, so the dock is offered before the island is`,
        )
      /* THE BOW IN THE LAND. The heading is what the hull holds once she is tied
       * up, so pointing it at the island is a ship moored into the rocks. A
       * refusal and not a warning: it is one press to turn, it is visible on the
       * chart as the ghost lying across the shore, and a world saved with it
       * reaches a player as a ship facing a cliff. */
      const into = facingIntoCoast(b, p, mm)
      if (into)
        problems.push(
          `"${b.name}" is aimed ${b.facing}, which is ${into.degrees}° off straight into "${p.name}" · that is the heading the hull holds once she is tied up, so she would lie bow-first in the coast · turn her along the shore or out to open water`,
        )
      /* named here rather than dropped in cleanMark, because dropping a diagonal produces the same west and says nothing */
      if (b.facing && !BERTH_FACINGS.includes(b.facing))
        warnings.push(
          `"${b.name}" is aimed ${b.facing} and the game only turns north, east, south and west into a heading · a hull tying up there will point west`,
        )
    }
  }
  /* home is checked like every other dangling reference, because admitting it on legality alone let a renamed island pass and fail at render time in the other repo */
  if (doc.home) {
    const h = doc.places.find((p) => p.name === doc.home)
    if (!h) warnings.push(`"${doc.home}" is marked as where a run starts, and no island on this ocean is called that`)
    else if (!h.place && !h.map)
      warnings.push(
        `"${doc.home}" is where a run starts and carries neither a place id nor a map, so there is nothing the game can spell it with and it will not be sent`,
      )
  }
  /* one namespace because python has one: sail_to("north_passage") never says which list to look in, so a shared name is a call whose answer depends on lookup order */
  const diag = Math.hypot(doc.w, doc.h)
  const isles = new Set(doc.places.map((p) => p.name))
  for (const m of doc.marks || []) {
    if (seen.has(m.name))
      problems.push(`"${m.name}" is the name of two things on this ocean, and python addresses every place and every berth in one namespace`)
    seen.add(m.name)
    /* a warning and not a refusal, because an author is allowed to mark the dock before the island exists */
    if (m.island && !isles.has(m.island))
      warnings.push(`"${m.name}" says it belongs to "${m.island}", and no island on this ocean is called that`)
    /* the game holds one berth per slot, so a run-in nested anywhere else is stored, drawn nowhere and never sent */
    if (m.approach && berthOf(doc.marks, m.island) !== m)
      warnings.push(
        `"${m.name}" carries a run-in and is not the berth its island docks at, so nothing will ever steer through it · put the run-in on the dock itself`,
      )
    // no bounds test here either, for the same reason a place has none: the sea
    // the game sails is centred on the hub and runs negative in both directions
    /* the yardstick is the whole ocean's diagonal, so only a point left behind after its islands were deleted can trip it */
    const nearest = doc.places.length ? Math.min(...doc.places.map((p) => Math.hypot(m.x - p.x, m.y - p.y))) : Infinity
    if (nearest > diag)
      warnings.push(`the berth "${m.name}" has no island within reach of it, so nothing sails to or from it`)
  }
  /* regions share the one namespace, so this carries `seen` forward rather than starting a fresh set and letting water take an island's name */
  const rseen = new Set()
  for (const r of doc.regions) {
    if (rseen.has(r.name)) problems.push(`two sea regions are both called "${r.name}"`)
    else if (seen.has(r.name))
      problems.push(`"${r.name}" is the name of two things on this ocean, and python addresses every island, every berth and every stretch of water in one namespace`)
    rseen.add(r.name)
    seen.add(r.name)
  }
  return { problems, warnings }
}

export async function saveWorld(input, client, id = GAME_WORLD) {
  /* the read and the write are one locked unit, because an unserialised read-modify-write destroyed the ocean and drove the version counter backwards */
  if (!client) return withWorld((c) => saveWorld(input, c, id), id)
  const run = (t, p) => client.query(t, p)
  /* an absent key keeps the row and only a real array replaces it, on every field, because the route posts the raw body and a subset would wipe every island and return 200 */
  const stated = Array.isArray(input?.marks)
  const was = await getWorld(client, id)
  const doc = {
    w: input?.w === undefined ? was.w : Math.max(1, num(input.w, 4096)),
    h: input?.h === undefined ? was.h : Math.max(1, num(input.h, 4096)),
    places: Array.isArray(input?.places) ? input.places.map(cleanPlace).filter(Boolean) : was.places,
    regions: Array.isArray(input?.regions) ? input.regions.map(cleanRegion).filter(Boolean) : was.regions,
    marks: stated ? input.marks.map(cleanMark).filter(Boolean) : was.marks,
    // silence keeps what is there, the same argument marks makes, so a page that
    // has never heard of a home slot cannot clear one by saving
    home: typeof input?.home === 'string' ? (isName(input.home) ? input.home : '') : was.home,
  }
  /* the stamp is a write precondition, because locking makes a write atomic and does not stop a stale tab winning; not version, which deliberately does not move for a title or a berth */
  if (isFinite(Number(input?.updatedAt)) && Number(input.updatedAt) > 0 && was.updatedAt && Number(input.updatedAt) !== was.updatedAt) {
    const why = 'the ocean moved while this page was open, so nothing was saved · reload the chart and make the change again'
    const e = new Error(why)
    e.problems = [why]
    throw e
  }
  // the paint columns come too, because checkWorld measures a berth from the
  // painting's centre, which is the point the game measures every radius from
  const rows = (await run('select slug, w, h, paint_w, paint_h, paint_ox, paint_oy from maps')).rows
  const slugs = rows.map((r) => r.slug)
  const { problems, warnings } = checkWorld(doc, slugs, new Map(rows.map((r) => [r.slug, r])))
  if (problems.length) {
    const e = new Error(`the world was not saved · ${problems.join(' · ')}`)
    e.problems = problems
    throw e
  }
  /* the version counts up only when a hull's world moved, because a consumer refuses to resume a run when it changes and everybody loses their place */
  /* keys sorted, because one side is freshly cleaned and the other came out of jsonb, and a raw stringify counted a version up on every empty save */
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
  /* w, h and home are out of the comparison, because they never reach composition() and cannot move a hull */
  const shape = (d) => JSON.stringify(stable([d.places, d.regions]))
  const version = shape(doc) === shape(was) ? was.version : (was.version || 1) + 1
  /* every write to this row is logged, because the row was destroyed once by a runner nobody was watching */
  console.log()
  /* every write to this row is logged, because an unexplained writer is indistinguishable from a test run without a line in a log */
  console.log('[world] row ' + id + ' written · ' + doc.places.length + ' place(s), ' + (doc.marks || []).length + ' berth(s), version ' + version)
  const wrote = await run(
    `insert into world (id, w, h, places, regions, marks, home, version, updated_at)
     values ($8, $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, now())
     on conflict (id) do update set w = $1, h = $2, places = $3::jsonb, regions = $4::jsonb,
       marks = $5::jsonb, home = $6, version = $7, updated_at = now()
     returning id, pub_id, updated_at`,
    [doc.w, doc.h, JSON.stringify(doc.places), JSON.stringify(doc.regions), JSON.stringify(doc.marks), doc.home, version, id],
  )
  // the new stamp goes back with the document, or the page has nothing to send
  // on the next save and the precondition above can never fire
  return {
    ...doc,
    id: wrote.rows[0].id,
    pubId: String(wrote.rows[0].pub_id || ''),
    version,
    updatedAt: +new Date(wrote.rows[0].updated_at),
    warnings,
  }
}
