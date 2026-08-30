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
 * ONE ROW PER ACCOUNT, AND ROW 1 IS OURS. This said one row for the whole
 * platform, because a berth is a position relative to every other island rather
 * than a private note. That is right about one OCEAN and wrong about one TABLE:
 * it meant a stranger who signed up for a map tool found a page that offered to
 * compose a world and then refused them with a 403. The maps table never made
 * that mistake, and this is the same shape. Everybody gets an ocean, ours is the
 * one the game reads, and it is pinned by id because an id cannot be set on two
 * rows and the game's read has no account behind it to resolve anything else.
 */
import { db, q, one } from '../db/pool.mjs'

/* THE OCEAN THE GAME READS, AND IT IS NOT A LOOKUP.
 *
 * /api/v1/world is fetched by a freshman's chromebook with no account, no
 * cookie and no way to say whose world it wants, so the answer has to be a
 * constant. Every function here defaults to it, which is what keeps the game
 * side unchanged by one byte through all of this: a caller that says nothing
 * gets exactly the row it always got. */
export const GAME_WORLD = 1

/* ONE WRITER AT A TIME ON THE ONE ROW THERE IS ONE OF.
 *
 * A verify run destroyed Ash's real ocean by interleaving with a second run,
 * and the lock that was added afterwards lived in verify-authoring.mjs alone.
 * That made it a cooperative lock with exactly one cooperator: the dev server
 * serving POST /api/world never asked for it, so the same interleave was still
 * open with a different second party, and two browser tabs did it too.
 *
 * It was also taken through q(), which is pool.query, so the lock was acquired
 * on whichever pooled client came out and released three hundred lines later on
 * whichever client came out then. pg_advisory_lock belongs to the connection
 * that ran it. Same client by luck is not the same client by design, and the
 * mirror case is worse: a session advisory lock is re-entrant, so a second
 * acquirer landing on the same client is granted immediately and gets no
 * exclusion at all.
 *
 * So the lock lives here, in the store every writer goes through, and it pins
 * ONE client for the read, the version decision and the write. The finally
 * releases the client, so a crash frees the lock with the connection rather
 * than wedging the next runner until the pool's ten second idle timeout. */
export const WORLD_LOCK = 774_112_090

/* THE LOCK IS PER WORLD NOW, through the two-integer form: the key is this
 * constant and the row's own id. With one shared row a single key was the same
 * thing, and with one row per account a single key would make every author on
 * the platform queue behind every other author's save for no reason at all. The
 * classification half stays constant so the pair cannot collide with any other
 * advisory lock this codebase might grow. */
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

/* WHICH ROW AN ACCOUNT AUTHORS, RESOLVED OR CREATED.
 *
 * Row 1 is the game's and belongs to the account named by OCEAN_OWNER, which is
 * configuration this file cannot read, so the caller decides whether this user
 * is that account and passes `game`. Everybody else gets a row of their own, on
 * first use, which is the only moment there is anything to make it at.
 *
 * THE OWNER IS CLAIMED ON ROW 1 RATHER THAN LEFT NULL, and the update is guarded
 * on it still being null. Without it the ocean owner would fall through to the
 * insert below and end up with a SECOND world, orphaning the one the game reads
 * while every check still passed.
 *
 * A signed-out caller can never get here with `game` false, because both
 * authoring routes refuse before this, and with `game` true they get row 1,
 * which is the laptop-with-no-login case this tool has always run in. */
export async function worldIdFor(ownerId, { game = false } = {}) {
  if (game || !ownerId) {
    /* THE CLAIM IS GUARDED ON THE ACCOUNT NOT ALREADY HAVING ONE, and without
     * that guard it is a crash rather than a no-op. OCEAN_OWNER is
     * configuration, so an account can perfectly well author its own ocean for a
     * week and then be named as ours, at which point this tried to give it row 1
     * as well and the one-world-per-account index refused the whole request.
     * Row 1 keeps being the game's either way, because the pin is the id. */
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
  /* ON CONFLICT ON THE OWNER INDEX, because two tabs signing in at the same
   * instant both read no row and both insert. The partial unique index makes the
   * loser a conflict rather than a second unreachable ocean, and returning is
   * what turns the conflict back into the winner's id. */
  const made = await one(
    `insert into world (owner_id) values ($1)
     on conflict (owner_id) where owner_id is not null do update set owner_id = excluded.owner_id
     returning id`,
    [ownerId],
  )
  return made.id
}

/* THE ADDRESS A STRANGER'S OWN ENGINE READS THEIR OCEAN AT.
 *
 * Ours is /api/v1/world and it is a constant because the game has no account to
 * resolve. Theirs is /api/v1/worlds/<pub_id>: opaque, stable, not an email, and
 * plural so it can never shadow the two paths the game already holds. */
export async function worldPubId(id = GAME_WORLD) {
  const r = await one('select pub_id from world where id = $1', [id])
  return r ? String(r.pub_id) : ''
}

export async function worldByPubId(pub) {
  if (!/^[0-9a-f-]{36}$/i.test(String(pub || ''))) return 0
  const r = await one('select id from world where pub_id = $1', [pub])
  return r ? r.id : 0
}

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
 * `approach` is GONE AS A KIND and it is back as a FIELD, which is not the same
 * thing changing its mind. Nothing on the water is an approach: an approach is
 * one berth's own run-in, a second point that only means anything relative to
 * the first, and it is nobody's destination. So it is not in this list and it
 * never will be, and cleanMark carries it nested on the berth it belongs to. */
export const MARK_KINDS = ['berth', 'waypoint', 'anchorage', 'landmark', 'spawn']

/* THE HEADINGS A HULL CAN ACTUALLY SETTLE ON, AND THERE ARE FOUR.
 *
 * The picker offers the full eight-way grid, and the game's radOf in
 * PmapScene.tsx answers east, south and north and sends EVERYTHING ELSE to
 * Math.PI, which is west. So an author clicking the north-west arrow got a hull
 * pointing due west, with nothing said anywhere, and all four diagonals
 * collapsed onto the same heading. The live hub berth was one of them.
 *
 * That is the camera-zoom-notch failure again: MAPVIS authoring in a vocabulary
 * the consumer does not run. The consumer is the canonical side and it is
 * read-only, so this is the side that narrows.
 *
 * ONLY A BERTH IS NARROWED. A waypoint's facing goes out on
 * /api/v1/world/marks and is read by a member's python, which can do whatever
 * it likes with a diagonal. The narrowing belongs to the one field the engine
 * itself turns into an angle. */
export const BERTH_FACINGS = ['north', 'east', 'south', 'west']

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
    /* THE RUN-IN, WHICH IS THE ONE THING A BERTH CARRIES THAT IS NOT A BERTH.
     *
     * The game aims here first and only then comes alongside, so a dock looks
     * deliberate rather than nosed-in: PmapScene reads `s.berth.approach` and
     * sail.ts runs a whole `approach` stage off it, steering at this point until
     * it is astern and only then swinging onto the berth's own heading. 019
     * lifted the old nested approach out as a second free-standing berth and
     * then nothing put it back on the wire, so a field with a live consumer in
     * the other repo had no author at all and every arrival was a straight-in
     * nose.
     *
     * NESTED, AND THAT IS NOT A RETREAT FROM 019. What 019 fixed is that a
     * DESTINATION cannot be welded to an island, because python addresses it by
     * name and a leg between two islands turns at a corner belonging to neither.
     * A run-in is the opposite kind of thing: it is geometry that only exists
     * relative to one berth, nothing sails to it, and no grape ever names it. It
     * moves when its berth moves, which is exactly the welding that was wrong
     * for a destination and is exactly right here.
     *
     * IT REPLACED A POSITIONAL RULE, which was "the second berth-kind mark bound
     * to this island". That was an ordering contract nothing on the page could
     * see: a spare dock, or a route corner an author bound to the island so it
     * would follow it around, silently became the run-in and the hull steered at
     * it. 021 folds every mark 019 lifted back in here and the rule is gone.
     *
     * WHAT THE UI STILL OWES THIS, and it is three things rather than one.
     * A control on BerthPanel, live only when the mark is a berth, that drops a
     * run-in at the berth's own position, lets it be dragged on the chart and
     * lets it be cleared. A second dot drawn on the water joined to its berth by
     * a line, because a point you cannot see is a point nobody can aim. And
     * World.tsx:1937, which moves every mark bound to an island when the island
     * is dragged and would leave a nested run-in standing where it was: it has to
     * carry the approach by the same dx and dy. Until all three exist this field
     * is authorable over the wire and not by hand, which is the half-plumbed
     * pattern docs/AUTHORING.md names. */
    ...(m.approach && isFinite(Number(m.approach.x)) && isFinite(Number(m.approach.y))
      ? { approach: { x: num(m.approach.x), y: num(m.approach.y) } }
      : {}),
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
    /* WHICH OCEAN THIS IS, AND WHERE ITS OWN ENGINE READS IT. Both ride along
     * because the page has to be able to say "this is yours, here is the url",
     * and the alternative is a second round trip for two facts this query has
     * already read. Neither reaches the game: composition() is a different shape
     * and does not carry them. */
    id: w.id,
    pubId: String(w.pub_id || ''),
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
  /* THE PAINTED EXTENT IS MEASURED, AND base_* IS NOT IT.
   *
   * This sent base_w/base_h under a field named for the painting and a comment
   * saying the canvas is 41 percent too generous. base_* is the DROPPED IMAGE's
   * size and offset inside the canvas, which is what growCanvas moves and what
   * re-grows a map on reload. On the hub the picture was dropped at 688x640 with
   * its margin already baked in, so base_* reads 688x640 at 0,0 and the wire
   * said 688x640: identical to the canvas, 440,320 pixels against the game's
   * 265,000 ceiling, and compositionFaults REFUSES THE WHOLE DOCUMENT on that
   * one field. The comment described the intended behaviour and the query
   * supplied the wrong columns, so the defect read as fixed.
   *
   * paint_* is the opaque bounding box, scanned off the bytes that actually
   * ship at publish. base_* stays the fallback for a map published before the
   * measurement existed, which is honest rather than right: it is what this
   * function was already sending. */
  const paintOf = (m) =>
    m.paint_w > 0 && m.paint_h > 0
      ? { w: m.paint_w, h: m.paint_h, ox: m.paint_ox || 0, oy: m.paint_oy || 0 }
      : { w: m.base_w || m.w, h: m.base_h || m.h, ox: m.base_ox || 0, oy: m.base_oy || 0 }
  /* HOME CROSSES IN THE GAME'S ADDRESSING, NOT IN MAPVIS'S.
   *
   * `w.home` is a PLACE NAME: a python identifier, validated by isName, written
   * from the chart's "the run starts here" tick. The game resolves it against
   * `s.place ?? s.map`, the kebab-case roster id or the map slug, and
   * compositionFaults raises a fault when nothing matches. loadComposition
   * discards the ENTIRE composition on any fault and falls back with only a
   * console.warn, so one home tick killed every island, every region and every
   * berth MAPVIS authored.
   *
   * It is the fourth instance of the same law: MAPVIS emits X, the game reads Y,
   * and the failure is silent. Translating here is what this function is for.
   * Renaming the column is not an option, because isName can never spell a
   * kebab id like `home-island`.
   *
   * OMITTED WHEN THE NAMED PLACE HAS NEITHER, because a home slot the game
   * cannot resolve is worse than no home slot: absent means the game uses its
   * own answer, present and wrong means it throws the ocean away. */
  const hp = w.home ? w.places.find((p) => p.name === w.home) : null
  const homeSlot = hp ? hp.place || hp.map : ''
  return {
    /* NOT updated_at. The game stamps a saved position with this and refuses to
     * resume a run when it has changed, so a millisecond epoch would throw away
     * every position on every class chromebook each time an author nudged one
     * island. An integer that only counts up when the composition really moved. */
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
        /* WHERE THE PAINTING'S CENTRE LANDS, WHICH IS NOT THE CHART'S CORNER.
         *
         * The chart holds x,y as the top-left of a w by h box, and the game does
         * `toSea = at + (px - paintedCentre)`, so `at` is where the middle of the
         * painting sits. Sending the corner put every island half a footprint
         * north-west of where the chart drew it, and every berth authored beside
         * it landed inside the island: measured on the live hub, the one berth on
         * the ocean was on dry land.
         *
         * One chart unit is one painting pixel. It has to be: the game measures
         * distance in the same units it measures a footprint in, and a footprint
         * is painting pixels because it is checked against the one-generation
         * pixel ceiling. So there is no scale factor here and there must not be
         * one. checkWorld warns when a place's box is not its map's canvas,
         * which is the only way the two can disagree. */
        at: {
          x: p.x + (pb ? pb.ox + pb.w / 2 : p.w / 2),
          y: p.y + (pb ? pb.oy + pb.h / 2 : p.h / 2),
        },
        // the painted extent, which is what a distance is measured against.
        // Taking it off the canvas is 41 percent too generous on the hub, in the
        // direction that discovers an island before it is on screen.
        footprint: pb ? { w: pb.w, h: pb.h } : { w: p.w, h: p.h },
        /* WHERE THE PAINTING SITS INSIDE ITS CANVAS, and the test used to be
         * `(base_ox || base_oy)`, which suppresses a legitimate origin of 0,0: a
         * 669x377 painting at 0,0 in a 688x640 canvas is not centred, and absent
         * means centred to the game. Sent whenever the painting is not the whole
         * canvas, which is the real question. */
        ...(m && pb && (pb.w !== m.w || pb.h !== m.h || pb.ox || pb.oy) ? { origin: { x: pb.ox, y: pb.oy } } : {}),
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
         * `approach` IS BACK ON THE WIRE, and the note that said nothing ever
         * carried one was reasoning about MAPVIS instead of about the consumer.
         * PmapScene reads `s.berth.approach` and feeds it to the berthing
         * manoeuvre, and sail.ts runs an `approach` stage off it, so 019 left a
         * field with a live reader and no author and every arrival became a
         * straight-in nose.
         *
         * IT COMES OFF THE BERTH ITSELF NOW, and it briefly came off list order:
         * "the second berth-kind mark bound to this island", which is what 019's
         * migration happened to write. Nothing on the chart could see that rule,
         * so a spare dock or a route corner an author bound to the island so it
         * would follow it around became the run-in and the hull steered at it.
         * The point is nested on the berth, 021 folded the lifted ones back in,
         * and what crosses is byte for byte what it was.
         *
         * ONLY THE BERTH THE GAME USES CAN CARRY ONE, because slot.berth is one
         * berth and this is its geometry. checkWorld names an approach anywhere
         * else rather than sending it, since a field nothing reads is worse than
         * a field nobody wrote.
         *
         * THE HEADING IS NARROWED TO WHAT THE ENGINE TURNS INTO AN ANGLE. radOf
         * answers east, south and north and sends everything else to west, so
         * emitting a diagonal is emitting a lie. Absent has exactly the same
         * effect and does not claim anything. checkWorld names it at the save so
         * the author can re-aim rather than finding out from a hull. */
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
export function checkWorld(doc, slugs = [], maps = new Map()) {
  const problems = []
  const warnings = []
  const seen = new Set()
  /* THE SEVERITY MODEL HAS TO BE THE CONSUMER'S.
   *
   * Three of the checks below were warnings here and are faults in the game's
   * compositionFaults, and any fault makes loadComposition throw the WHOLE
   * document away and use its hand-written fallback with only a console.warn. So
   * what MAPVIS called a nudge cost every island, every region and every berth
   * on the ocean, including the ones that were right. A publish gate that saves
   * a document the consumer refuses is not a gate. */
  const seenMap = new Set()
  for (const p of doc.places) {
    if (seen.has(p.name)) problems.push(`two places are both called "${p.name}", and a name is the only address there is`)
    seen.add(p.name)
    // the game faults on a map placed twice and discards the whole composition
    if (p.map && seenMap.has(p.map))
      problems.push(`the map "${p.map}" is placed twice, and the game refuses a whole composition that places one map in two positions`)
    if (p.map) seenMap.add(p.map)
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
      problems.push(
        `"${p.name}" has no map, so its only honest state is "rumour" and it says "${p.state}" · the game refuses the whole composition over this, every other island with it`,
      )
    /* AND THE MIRROR, WHICH NOTHING CHECKED AT ALL. The island tool is born a
     * rumour and picking a painting in the inspector never touched the state, so
     * the ordinary authoring path produced a document the game throws away: drop
     * an island, choose its map, press save, and MAPVIS says saved while the
     * whole ocean silently vanishes at the other end. The dropdown lifts the
     * state now, and this is the fence under it. */
    if (p.map && p.state === 'rumour')
      problems.push(
        `"${p.name}" holds the map "${p.map}" and still reads as a rumour · the game refuses the whole composition over this, so pick a state it has really reached`,
      )
    /* AN ISLAND THE GAME CANNOT ADDRESS. It looks a slot up by its place id and
     * counts exposure by the same id, so one without it is never discovered, has
     * no programmes, and reads misty for the whole run with nothing said. */
    if (p.map && !p.place)
      warnings.push(`"${p.name}" carries no place id, so the game has no id to discover it or count a visit under`)
    /* ONE CHART UNIT IS ONE PAINTING PIXEL, AND THIS IS THE ONLY WAY TO BREAK IT.
     *
     * The game measures a distance in the units it measures a footprint in, and
     * a footprint is painting pixels. So a place's box has to be its map's
     * canvas or the berth beside it arrives somewhere else: the live hub sat in
     * a 128x119 box in front of a 688x640 painting, a ratio of 5.4, and its one
     * berth landed inside the island. A warning rather than a refusal because
     * the size is fixed by the dropdown now and an old row has to stay
     * loadable. */
    const mm = p.map ? maps.get(p.map) : null
    if (mm && (p.w !== mm.w || p.h !== mm.h))
      warnings.push(
        `"${p.name}" is drawn ${p.w}x${p.h} on the chart in front of a ${mm.w}x${mm.h} painting, and one chart unit has to be one painting pixel, so every point aimed against it lands somewhere else`,
      )
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
      /* MEASURED FROM WHERE THE GAME MEASURES, WHICH IS THE PAINTING'S CENTRE.
       *
       * This took the distance from x,y, the box's top-left corner, while the
       * game measures every radius from `at`, and `at` is where the middle of
       * the painting lands. On the hub that is 344 pixels of difference in each
       * axis, so a berth sitting comfortably inside the discovery radius was
       * being reported as 807 out and unreachable. A checker that measures from
       * a different point than the consumer is a checker that cries wolf. */
      const c = mm
        ? { x: p.x + (mm.paint_w > 0 ? mm.paint_ox + mm.paint_w / 2 : mm.w / 2), y: p.y + (mm.paint_h > 0 ? mm.paint_oy + mm.paint_h / 2 : mm.h / 2) }
        : { x: p.x + p.w / 2, y: p.y + p.h / 2 }
      const d = Math.hypot(b.x - c.x, b.y - c.y)
      if (d > p.discover)
        warnings.push(
          `"${b.name}" ties up ${Math.round(d)} out from "${p.name}", which is only discovered at ${p.discover}, so the dock is offered before the island is`,
        )
      /* A HEADING THE ENGINE CANNOT TURN INTO AN ANGLE. radOf answers east,
       * south and north and everything else falls through to west, so all four
       * diagonals collapse silently. Named here rather than dropped in
       * cleanMark, because dropping it produces the same west and takes the
       * author's choice with it without saying anything. */
      if (b.facing && !BERTH_FACINGS.includes(b.facing))
        warnings.push(
          `"${b.name}" is aimed ${b.facing} and the game only turns north, east, south and west into a heading · a hull tying up there will point west`,
        )
    }
  }
  /* WHERE A RUN WITH NO SHIP BEGINS, WHICH WAS THE ONE POINTER WITH NO FENCE.
   *
   * Every other dangling reference in this document is named at the save: an
   * orphan berth's island, a map nobody published, a place the game cannot
   * address. Home was admitted on nothing but "is it a legal identifier", so
   * deleting or renaming the island marked home passed clean, and the fault
   * surfaced in the other repo at render time where the author never sees it.
   * It is also the pointer with the largest blast radius, because it is what
   * decides where a run with no recorded position starts. */
  if (doc.home) {
    const h = doc.places.find((p) => p.name === doc.home)
    if (!h) warnings.push(`"${doc.home}" is marked as where a run starts, and no island on this ocean is called that`)
    else if (!h.place && !h.map)
      warnings.push(
        `"${doc.home}" is where a run starts and carries neither a place id nor a map, so there is nothing the game can spell it with and it will not be sent`,
      )
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
    /* A RUN-IN ON SOMETHING THAT IS NOT A DOCK IS A FIELD NOTHING READS.
     *
     * The game holds one berth per slot and aims at its approach, so a second
     * point nested on a waypoint, or on the spare berth further down an island's
     * list, is stored, is drawn nowhere and is never sent. That is the
     * half-plumbed pattern this project keeps rediscovering, and the honest
     * answer is to say so at the save rather than to drop it silently, which
     * would take the author's work with it and explain nothing. */
    if (m.approach && berthOf(doc.marks, m.island) !== m)
      warnings.push(
        `"${m.name}" carries a run-in and is not the berth its island docks at, so nothing will ever steer through it · put the run-in on the dock itself`,
      )
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
  /* REGIONS ARE IN THE SAME NAMESPACE AS EVERYTHING ELSE, and this loop started
   * a fresh set, so a stretch of water could take an island's name or a berth's
   * and the save was accepted. Every other layer already honoured one namespace:
   * 019's migration builds `taken` from places, marks AND regions, and the chart
   * does the same when it names a new berth. The server is the only enforcement
   * point and it was the one leaving the hole, so sail_to("the_reach") could
   * resolve to two different things depending on which lookup ran first. The
   * region-only wording is kept for the case where both hits really are
   * regions, because that is the sentence an author can act on. */
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
  /* THE READ AND THE WRITE ARE ONE UNIT, OR THEY ARE A COIN TOSS.
   *
   * This was an unlocked, untransacted read-modify-write on the single shared
   * row: read the whole world, decide a version off it, write it back, with
   * nothing serialising the gap. That is the exact interleave that destroyed
   * Ash's ocean, and it stayed open after the fix, because the lock was added to
   * verify-authoring and never to the store every writer goes through. Two
   * browser tabs did it too. It also broke the version: two writers both read 10
   * and both wrote 11 with different content, and a writer whose own save
   * changed nothing wrote 10 back on top of somebody's 11, so the counter went
   * BACKWARDS onto content that is not what 10 was.
   *
   * Called with no client it wraps itself, so every existing caller is covered
   * without knowing about any of this. */
  if (!client) return withWorld((c) => saveWorld(input, c, id), id)
  const run = (t, p) => client.query(t, p)
  /* AN ABSENT KEY IS NOT AN EMPTY ONE, AND THAT NOW COVERS THE WHOLE DOCUMENT.
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
   * every dock with it.
   *
   * AND IT ONLY PROTECTED marks AND home, with the other four falling back to a
   * destructive default directly under this essay about why they must not:
   * places and regions to [], w and h to 4096. The route hands the raw parsed
   * body straight here with no shape check, and an empty payload parses to {},
   * so any caller posting a subset wiped every island and every sea region on
   * the one shared row and got a 200 back. The field with the loudest comment
   * was the safe one. */
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
  /* THE STAMP THE PAGE WAS HANDED HAS TO COME BACK.
   *
   * There was no write precondition anywhere. GET hands the client `version` and
   * `updatedAt`, the client kept neither, and the save was a blind full-document
   * overwrite, so a second tab, a reload left open or the same tab after a
   * verify run posted a document built from a stale snapshot and silently
   * discarded every island written since. The lock above does not fix that:
   * locking makes each write atomic, it does not stop a stale writer winning.
   *
   * Not `version`: version deliberately does not move for a title or a berth, so
   * it cannot detect the overwrites that matter most. A caller that sends no
   * stamp is a deliberate overwrite, which is what the verify restore is. */
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
  /* AND w, h AND home ARE OUT OF IT, because they fail the rule the comment
   * above states. w/h are the chart's own frame and never reach composition() at
   * all, so resizing the canvas is an editorial act the game literally cannot
   * observe and it was counting the version up and throwing away the saved
   * position of every chromebook in a class. home only answers a question asked
   * when there is no recorded position, so it can never invalidate one. */
  const shape = (d) => JSON.stringify(stable([d.places, d.regions]))
  const version = shape(doc) === shape(was) ? was.version : (was.version || 1) + 1
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
