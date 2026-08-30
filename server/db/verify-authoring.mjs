// Can an author's typed value survive all the way into a published bundle?
//
//   node server/db/verify-authoring.mjs
//
// Every field checked here was in the half-plumbed sweep: typed somewhere,
// stored somewhere, read by the game, and with nothing anywhere that could put
// a value in it. Each one now has a control, and this is the fence that says
// the control still reaches the other end.
//
// It builds a throwaway map, writes a document into it exactly the way the
// editor's autosave does, publishes it, reads the published map.json back out
// of object storage, and then deletes the map. Small on purpose: no library, no
// placements with art, six objects written rather than eight hundred.
import { getMapBySlug, createMap, getDoc, putDoc } from '../store/maps.mjs'
import { publishBundle, publishedMap } from '../store/publish.mjs'
import { gateMap } from '../store/gate.mjs'
import { store } from '../store/blobs.mjs'
import { getWorld, saveWorld, composition } from '../store/world.mjs'
import { putLibraryFrames, copyLibraryItem } from '../store/platform.mjs'
import { createUi, setUiRegions, setUiImage, getUiByName, removeUi, publishUi, pieceType, PIECE_TYPES } from '../store/ui.mjs'
import { encodePNG } from '../sheet.mjs'
import { api } from '../api.mjs'
import { q, one, closeDb } from './pool.mjs'
import http from 'node:http'

let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}
const eq = (what, got, want) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(`${what} ${JSON.stringify(got)}`) : no(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)

const W = 64
const H = 48
const SLUG = 'zz-verify-authoring'
// a port of its own, so running this beside the dev server or beside
// verify-api.mjs does not collide with either
const PORT = 5399

/* a floor with a wall down the right-hand quarter, so there is somewhere legal
 * to stand, somewhere illegal, and somewhere fenced off from the start point */
const lvl = Buffer.alloc(W * H, 40)
for (let y = 0; y < H; y++) for (let x = 44; x < 48; x++) lvl[y * W + x] = 0
const occ = Buffer.alloc(W * H)
const cut = Buffer.alloc(W * H)
const planesB64 = Buffer.concat([lvl, occ, cut]).toString('base64')

const levelsPNG = (() => {
  const rgba = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = lvl[i]
    rgba[i * 4 + 3] = 255
  }
  return encodePNG(W, H, rgba)
})()

/* WHAT AN AUTHOR TYPED. Every value below is one somebody has to be able to
 * enter in the tool, and every one of them used to die somewhere between the
 * form and the game. */
const doc = {
  v: 3,
  w: W,
  h: H,
  base: { w: W, h: H, ox: 0, oy: 0 },
  spawn: [8, 8],
  m: planesB64,
  assets: [
    // a placement with a NAME, which is the only address anything outside the
    // map can hold: the id beside it is a counter nobody chose
    /* NAMED FACES. `art` is an index and stays one, so these ride beside the
     * index rather than instead of it: without them the only selector in the
     * system is a life round a model wrote, and show(placement, state) has no
     * vocabulary at all. Look 0's name lives on the placement, because look 0 is
     * the placement's own picture and not an entry in `looks`. */
    {
      id: 'a1', name: 'the_coach', group: 'people', kind: 'static', src: '/work/x/library/a/0.png',
      x: 20, y: 20, scale: 1, sx: 1, sy: 1, rot: 0, fx: false, fy: false,
      lookName: 'standing',
      looks: [{ kind: 'static', src: '/work/x/library/b/0.png', name: 'seated' }],
    },
    { id: 'a2', group: 'props', kind: 'static', src: '/work/x/library/b/0.png', x: 30, y: 30, scale: 1, sx: 1, sy: 1, rot: 0, fx: false, fy: false },
    /* TWO PLACEMENTS THAT TRADE PLACES, which is what a variant set is and what
     * one placement wearing two faces cannot be: a ship and the empty water it
     * is not in have two silhouettes, two footprints and two anchors. */
    { id: 'a3', name: 'the_ship', group: 'dock', kind: 'static', src: '/work/x/library/c/0.png', x: 24, y: 22, scale: 1, sx: 1, sy: 1, rot: 0, fx: false, fy: false },
    { id: 'a4', name: 'the_empty_berth', group: 'dock', kind: 'static', src: '/work/x/library/d/0.png', x: 24, y: 22, scale: 1, sx: 1, sy: 1, rot: 0, fx: false, fy: false },
    /* A PLACEMENT WITH ITS OWN CONDITION, which must beat the group's, and one
     * with none, which must inherit it. */
    { id: 'a5', name: 'the_banner', group: 'year_two', kind: 'static', src: '/work/x/library/e/0.png', x: 12, y: 26, scale: 1, sx: 1, sy: 1, rot: 0, fx: false, fy: false, when: 'flag("banner_hung")' },
    { id: 'a6', name: 'the_bunting', group: 'year_two', kind: 'static', src: '/work/x/library/f/0.png', x: 14, y: 26, scale: 1, sx: 1, sy: 1, rot: 0, fx: false, fy: false },
  ],
  assetNext: 7,
  events: [
    // bound to the placement BY ITS NAME, with the floor beside it marked and a
    // heading to face while standing there
    { id: 1, name: 'coach_post', kind: 'post', x: 20, y: 20, r: 10, to: '', label: 'the coach', placement: 'the_coach', stand: [20, 26], facing: 'north' },
    // an area, four numbers meaning two opposite corners
    { id: 2, name: 'the_yard', kind: 'region', x: 10, y: 10, r: 8, to: '', label: '', rect: [4, 4, 36, 30] },
    // a hall is a place you are inside of, so the gate insists on a way out
    { id: 3, name: 'the_way_out', kind: 'door', x: 12, y: 12, r: 8, to: 'hub', toAnchor: 'panthers_maw', label: 'out' },
    /* A DOOR THAT IS BARRED UNTIL SOMETHING HAPPENS, which is the case that
     * proves the condition cannot only live on a placement: this anchor has no
     * placement bound to it and still has to be able to be off. It rides the
     * meta bag, because the anchors upsert, the game's readAnchors and the
     * publish projection each copy a fixed list of columns plus the whole bag. */
    { id: 4, name: 'the_barred_way', kind: 'door', x: 16, y: 12, r: 8, to: 'hub', toAnchor: 'panthers_maw', label: 'the barred way', when: 'cord("service")' },
    // the anchor a variant set is addressed through, which is the only address
    // python has for one: every world-touching intent takes an anchor name
    { id: 5, name: 'the_berth', kind: 'point', x: 24, y: 22, r: 10, to: '', label: 'the berth' },
  ],
  eventNext: 6,
  occs: [{ id: 1, baseline: 41 }],
  occNext: 2,
  // the six numbers describing the body, none of them the defaults
  walk: { charH: 36, hip: 3, hipDY: 2, speed: 68, yScale: 0.66, near: 12 },
  props: { title: 'The Verify Yard', class: 'hall', islandId: 'verify_club', meta: { district: 'harbour' } },
  /* A NAMED ROUTE. Straight lines between two anchors were the only shape a map
   * could describe, so the ship reaching the dock and an actor crossing a room
   * were both hand-typed numbers in the other repo. The mark is the part that
   * stops a cutscene being retuned whenever the text changes. */
  paths: [
    {
      id: 1,
      name: 'the_approach',
      points: [
        [4, 4],
        [18, 10],
        [30, 26],
      ],
      closed: false,
      twoWay: false,
      facing: 'east',
      marks: [{ at: 1, name: 'the_line_ends' }],
    },
  ],
  pathNext: 2,
  /* A NAMED SHOT, hung off an anchor rather than off coordinates, so it travels
   * with the station when the same beat stages somewhere else and does not
   * re-break every time the painting is re-cut. */
  framings: [
    /* `zoom` is the editor's own view, screen pixels per painting pixel, and it
     * means nothing on its own. `overFit` is the number that crosses: how many
     * times tighter than the whole map that view was, recorded when the shot was
     * armed, because the server exporter has no canvas to work it out from.
     * 2.36 over the game's 1.18 pull-out is exactly twice the opening view. */
    { id: 1, name: 'over_the_coach', anchor: 'coach_post', dx: -12, dy: -20, zoom: 2.5, overFit: 2.36, entry: true },
    { id: 2, name: 'wide_on_the_coach', anchor: 'coach_post', dx: 0, dy: 0, zoom: 1, overFit: 1.18 },
  ],
  framingNext: 2,
  /* A NAMED SET OF ANCHORS, so python iterates a collection instead of holding
   * five hard-coded strings and never being able to tell whether that is all of
   * them. Membership only: where the third one has to be the third one every run,
   * that is a rack and not this. */
  sets: [{ id: 1, name: 'the_stations', label: 'the stations', members: ['coach_post', 'the_yard'] }],
  setNext: 2,
  /* AN ORDERED RACK: the trophy wall, in miniature. The slot numbers are NOT
   * array positions, and slot 2 is deliberately absent to prove it: this rack was
   * authored with three hooks, the middle one was taken out, and the two that are
   * left keep the numbers they were given. */
  racks: [
    {
      id: 1,
      name: 'the_trophy_wall',
      label: 'the trophy wall',
      slots: [
        { slot: 1, anchor: 'coach_post', label: 'first place' },
        { slot: 3, anchor: 'the_yard' },
      ],
      slotNext: 4,
    },
  ],
  rackNext: 2,
  /* A NAMED EXCLUSIVE VARIANT SET. One name resolving to one of several
   * PLACEMENTS with at most one visible, so python sets a state and never has to
   * know how many there are or switch the others off by hand. Five dock
   * placements, one per island state, is the shape; two is enough to prove it. */
  variants: [
    {
      id: 1,
      name: 'the_berth_state',
      anchor: 'the_berth',
      label: 'the berth',
      members: [
        { name: 'empty', placement: 'the_empty_berth', label: 'no ship' },
        { name: 'moored', placement: 'the_ship' },
      ],
      initial: 'empty',
    },
  ],
  variantNext: 2,
  /* A CONDITION ON A GROUP, so a dozen placements that are the same year's
   * dressing are not a dozen copies of one string, and the thirteenth is not
   * placed without it. */
  groups: [{ name: 'year_two', label: 'second year dressing', when: 'year >= 2' }],
}

const owner = await one('select id from users order by created_at limit 1')
if (!owner) throw new Error('no user to own the map')

const existing = await getMapBySlug(SLUG)
if (existing) await q('delete from maps where id = $1', [existing.id])
const map = await createMap({ slug: SLUG, ownerId: owner.id, w: W, h: H, base: { w: W, h: H, ox: 0, oy: 0 }, spawn: [8, 8] })
console.log(`${SLUG}  ${map.id}  ${W}x${H}`)

try {
  await putDoc(map.id, JSON.stringify(doc))

  // ---- 1. the round trip through postgres --------------------------------
  const back = JSON.parse(await getDoc(map.id))
  eq('placement name survives the save', back.assets.find((a) => a.id === 'a1')?.name, 'the_coach')
  eq('the walk contract survives the save', back.walk, doc.walk)
  eq('the map properties survive the save', back.props, doc.props)
  eq('the occluder baseline survives the save', back.occs, doc.occs)
  const post = back.events.find((e) => e.name === 'coach_post')
  eq('the binding survives the save', post?.placement, 'the_coach')
  eq('the stand-at point survives the save', post?.stand, [20, 26])
  eq('the facing survives the save', post?.facing, 'north')
  eq('the area survives the save', back.events.find((e) => e.name === 'the_yard')?.rect, [4, 4, 36, 30])
  const bp = back.paths?.find((p) => p.name === 'the_approach')
  eq('the route survives the save', bp?.points, doc.paths[0].points)
  eq('the route keeps its direction', [bp?.closed, bp?.twoWay, bp?.facing], [false, false, 'east'])
  eq('the timing mark survives the save', bp?.marks, [{ at: 1, name: 'the_line_ends' }])
  const bf = back.framings?.find((f) => f.name === 'over_the_coach')
  eq('the shot survives the save', [bf?.anchor, bf?.dx, bf?.dy], ['coach_post', -12, -20])
  eq('the shot remembers how tight it was framed', bf?.overFit, 2.36)
  /* THE ZOOM IS THE ONE THAT WOULD HAVE DIED QUIETLY. The renderer's zoom is an
   * integer locked at load, so 2.5 is exactly the value something downstream is
   * most tempted to round, and a pull-out shot cannot exist on integer notches. */
  eq('the shot keeps a zoom off the integer notches', bf?.zoom, 2.5)
  const bs = back.sets?.find((s) => s.name === 'the_stations')
  eq('the set survives the save', bs?.members, ['coach_post', 'the_yard'])
  const br = back.racks?.find((r) => r.name === 'the_trophy_wall')
  /* THE GAP IS THE POINT. A rack that came back as slots 1 and 2 would be a rack
   * that renumbered itself around a deleted hook, and every trophy after the gap
   * would hang somewhere else the next time the map was opened. */
  eq('the rack keeps the slot numbers it was given, gap and all', br?.slots.map((s) => s.slot), [1, 3])
  eq('and the counter does not hand out a number the wall has already used', br?.slotNext, 4)
  /* THE FACE NAMES. Every one of these was resolved to an integer by the planner
   * lane and thrown away, so a bundle addressed a picture by number and nothing
   * outside life.ts could ask for one at all. The index is still the data; this
   * is the word beside it. */
  const bcoach = back.assets.find((a) => a.id === 'a1')
  eq('the name of look 0 survives the save', bcoach?.lookName, 'standing')
  eq('the name of the face it changes into survives the save', bcoach?.looks?.[0]?.name, 'seated')
  eq('a placement condition survives the save', back.assets.find((a) => a.id === 'a5')?.when, 'flag("banner_hung")')
  /* field by field, not whole, for the reason the world checks below give: this
   * came back out of jsonb and postgres does not keep the key order it went in
   * with */
  eq('the group row survives the save', [back.groups?.[0]?.name, back.groups?.[0]?.when], ['year_two', 'year >= 2'])
  /* THE ANCHOR'S CONDITION, which is the one with no column of its own: it rides
   * anchors.meta because that is the only carrier the anchors upsert copies
   * whole, and migrateEvent lifts it back onto the field so the panel sees it. */
  const barred = back.events.find((e) => e.name === 'the_barred_way')
  eq('an anchor condition survives the save, in the bag it has to ride in', barred?.meta?.when, 'cord("service")')
  eq('and is lifted back onto the field the author typed it into', barred?.when, 'cord("service")')
  const bv = back.variants?.find((v) => v.name === 'the_berth_state')
  eq('the variant set survives the save', bv?.members.map((m) => m.placement), ['the_empty_berth', 'the_ship'])
  eq('and the state it opens on', [bv?.anchor, bv?.initial], ['the_berth', 'empty'])

  // ---- 2. the gate, refusing things that can never work -------------------
  const anchors = [
    { name: 'in_the_wall', kind: 'post', x: 46, y: 20, r: 2, to: null },
  ]
  const g1 = gateMap({
    mapJson: { spawn: [8, 8], encoding: { stepTolerance: 12, blocked: 0 }, character: { hip: 3 }, class: 'island' },
    anchors,
    levels: { w: W, h: H, data: (() => { const d = Buffer.alloc(W * H * 4); for (let i = 0; i < W * H; i++) { d[i * 4] = lvl[i]; d[i * 4 + 3] = 255 } return d })() },
    slugs: [SLUG],
  })
  g1.problems.length ? ok(`the gate refuses an anchor in the wall: ${g1.problems[0].slice(0, 60)}…`) : no('the gate let an anchor in the wall through')

  const g2 = gateMap({
    mapJson: { spawn: [8, 8], encoding: { stepTolerance: 12, blocked: 0 }, character: { hip: 3 }, class: 'island' },
    anchors: [{ name: 'a_typo', kind: 'door', x: 8, y: 8, r: 6, to: 'zz-verify-authoringg' }],
    levels: { w: W, h: H, data: (() => { const d = Buffer.alloc(W * H * 4); for (let i = 0; i < W * H; i++) { d[i * 4] = lvl[i]; d[i * 4 + 3] = 255 } return d })() },
    slugs: [SLUG],
  })
  g2.problems.some((p) => p.includes('Did you mean')) ? ok('the gate names the nearest map for a misspelt door') : no(`the gate missed a one-letter typo: ${JSON.stringify(g2.problems)}`)

  const g3 = gateMap({
    mapJson: { spawn: [8, 8], encoding: { stepTolerance: 12, blocked: 0 }, character: { hip: 3 }, class: 'island' },
    anchors: [{ name: 'east_tunnel', kind: 'door', x: 8, y: 8, r: 6, to: 'a-room-nobody-painted' }],
    levels: { w: W, h: H, data: (() => { const d = Buffer.alloc(W * H * 4); for (let i = 0; i < W * H; i++) { d[i * 4] = lvl[i]; d[i * 4 + 3] = 255 } return d })() },
    slugs: [SLUG],
  })
  !g3.problems.length && g3.warnings.length
    ? ok('a door to a room nobody has painted warns rather than refusing')
    : no(`the gate refused an honestly barred door: ${JSON.stringify(g3.problems)}`)

  // ---- 3. all the way into a published bundle -----------------------------
  const bundleMap = {
    id: SLUG,
    w: W,
    h: H,
    encoding: { blocked: 0, L0: 40, ramp01: 50, L1: 60, ramp12: 70, L2: 80, ramp23: 90, L3: 100, stepTolerance: 12 },
    spawn: [8, 8],
    character: { heightPx: 36, hip: 3, hipDY: 2 },
    speed: 68,
    yScale: 0.66,
    stairs: [],
    occluders: doc.occs,
    class: 'hall',
  }
  /* exactly what server/api.mjs writes into assets.json, including the two
   * fields this round added to it: the resolved condition, and the face names
   * indexed the way `art` indexes the pictures. Held in one place because the
   * refusal test further down republishes and its refusal has to be about the
   * anchor in the wall rather than about a variant set with nothing in it. */
  const pubAssets = {
    assets: [
      { id: 'a1', name: 'the_coach', group: 'people', src: 'assets/a/0.png', x: 20, y: 20, scale: 1, lookNames: ['standing', 'seated'], looks: [{ src: 'assets/b/0.png' }] },
      { id: 'a3', name: 'the_ship', group: 'dock', src: 'assets/c/0.png', x: 24, y: 22, scale: 1 },
      { id: 'a4', name: 'the_empty_berth', group: 'dock', src: 'assets/d/0.png', x: 24, y: 22, scale: 1 },
      { id: 'a5', name: 'the_banner', group: 'year_two', src: 'assets/e/0.png', x: 12, y: 26, scale: 1, when: 'flag("banner_hung")' },
      { id: 'a6', name: 'the_bunting', group: 'year_two', src: 'assets/f/0.png', x: 14, y: 26, scale: 1, when: 'year >= 2' },
    ],
  }
  const pub = await publishBundle(SLUG, {
    mapJson: bundleMap,
    assetsJson: pubAssets,
    images: { 'levels.png': levelsPNG },
    files: new Map(),
  })
  console.log(`  published v${pub.version}`)

  const row = await publishedMap(SLUG)
  const shipped = JSON.parse((await store().get(row.blob_prefix + 'map.json')).toString('utf8'))
  eq('published title', shipped.title, 'The Verify Yard')
  eq('published class', shipped.class, 'hall')
  eq('published islandId', shipped.islandId, 'verify_club')
  eq('published map meta', shipped.meta, { district: 'harbour' })
  eq('published character', shipped.character, { heightPx: 36, hip: 3, hipDY: 2 })
  eq('published speed', shipped.speed, 68)
  eq('published yScale', shipped.yScale, 0.66)
  eq('published stepTolerance', shipped.encoding.stepTolerance, 12)
  const pa = (shipped.anchors || []).find((a) => a.name === 'coach_post')
  eq('published binding', pa?.placement, 'the_coach')
  eq('published stand-at', pa?.stand, [20, 26])
  eq('published facing', pa?.facing, 'north')
  eq('published rect', (shipped.anchors || []).find((a) => a.name === 'the_yard')?.rect, [4, 4, 36, 30])

  const sp = (shipped.paths || []).find((p) => p.name === 'the_approach')
  eq('published route', sp?.points, doc.paths[0].points)
  eq('published timing mark', sp?.marks, [{ at: 1, name: 'the_line_ends' }])
  const sf = (shipped.framings || []).find((f) => f.name === 'over_the_coach')
  eq('published shot', [sf?.anchor, sf?.dx, sf?.dy, sf?.zoom], ['coach_post', -12, -20, 2.5])
  eq('published entry framing', sf?.entry, true)

  /* THE SET AND THE RACK, ALL THE WAY INTO THE PUBLISHED BUNDLE. Two exporters
   * write these, bundle() in the browser and publishBundle here, and the two have
   * diverged before: `placement` lived in the type, the form, the document and
   * the table and was dropped by both, so one of the fifteen intents could not
   * fire on any bundle this tool could produce. This is the fence for that. */
  const ss = (shipped.sets || []).find((s) => s.name === 'the_stations')
  eq('published set', ss?.members, ['coach_post', 'the_yard'])
  eq('published set label', ss?.label, 'the stations')
  const sr = (shipped.racks || []).find((r) => r.name === 'the_trophy_wall')
  eq('published rack keeps its stable slot numbers', sr?.slots.map((s) => s.slot), [1, 3])
  eq('published rack slot names its anchor and its own label', sr?.slots[0], {
    slot: 1,
    anchor: 'coach_post',
    label: 'first place',
  })

  /* THE SHOT WHERE THE CAMERA ACTUALLY LOOKS FOR IT, which is the fence this
   * whole check was missing. The array above is MAPVIS's authoring record and
   * the game has never had a reader for it: what the game reads is the anchor's
   * own meta bag, meta.framings[name] first and meta.framing as the unnamed
   * default that look_at and every miss fall back to. A published bundle where
   * the array is perfect and the bag is empty is a map whose only authored
   * camera has zero readers, and that is exactly what shipped. */
  eq('the shot is on the anchor the camera reads it off', pa?.meta?.framings?.over_the_coach, {
    zoom: 2,
    dx: -12,
    dy: -20,
  })
  eq('a second shot on the same anchor sits beside it', pa?.meta?.framings?.wide_on_the_coach, { zoom: 1, dx: 0, dy: 0 })
  /* WITHOUT A DEFAULT EVERY UNNAMED SHOT IS NULL. look_at asks with no name at
   * all and a script naming a shot the map does not carry falls back here, so an
   * anchor with named shots and no default has a dead camera on both paths. The
   * entry shot takes it. */
  eq('the entry shot is the anchor default', pa?.meta?.framing, { zoom: 2, dx: -12, dy: -20, name: 'over_the_coach' })
  /* MERGED, NOT SWAPPED IN. The real hub's panthers_maw already carries docId
   * and derived, and the game writes derived itself, so a projection that
   * replaced the bag would take both out. */
  eq('the bag that was already there is still under it', pa?.meta?.docId, 1)
  /* AND AN ANCHOR NOBODY POINTED A CAMERA AT GROWS NOTHING, so a bundle with no
   * shots on it stays what it was. */
  eq('an anchor with no shot on it stays as it was', (shipped.anchors || []).find((a) => a.name === 'the_yard')?.meta, { docId: 2 })
  /* THE PAINTING'S OWN SIZE. A discovery radius taken off h instead of base_h is
   * wrong by about 41 percent on the hub, in the direction that discovers an
   * island before it is on screen. Four columns that existed from the first
   * schema and never reached a bundle. */
  eq('published base extent', shipped.base, { w: W, h: H, ox: 0, oy: 0 })
  /* a bundle that has left the platform should know where it came from, because
   * twelve islands means twelve authors and a file on a cdn has no row behind it */
  shipped.provenance?.owner && shipped.provenance?.publishedAt && shipped.provenance?.version === pub.version
    ? ok(`published provenance ${shipped.provenance.owner} v${shipped.provenance.version}`)
    : no(`provenance missing or wrong: ${JSON.stringify(shipped.provenance)}`)

  const shippedAssets = JSON.parse((await store().get(row.blob_prefix + 'assets.json')).toString('utf8'))
  const byId = (id) => (shippedAssets.assets || []).find((a) => a.id === id)
  eq('published placement name', byId('a1')?.name, 'the_coach')
  /* THE FACE NAMES, ALL THE WAY TO THE BUNDLE, and indexed the way art indexes
   * the pictures: slot 0 is the placement's own and slot 1 is looks[0]. life.ts
   * is emphatic that art is an index and never a name, and it stays that way; a
   * bundle that shipped these inside look 0 would have overwritten the
   * placement's own name, because look 0 is spread into the entry. */
  eq('published look names, indexed exactly as art is', byId('a1')?.lookNames, ['standing', 'seated'])
  /* THE RESOLVED CONDITION ON EACH PLACEMENT. Its own beats the group's; a
   * placement with none inherits the group's, which is the whole reason the
   * carrier could not only be the placement. */
  eq('a placement keeps its own condition', byId('a5')?.when, 'flag("banner_hung")')
  eq('and one with none inherits the condition on its group', byId('a6')?.when, 'year >= 2')

  /* THE VARIANT SET, ALL THE WAY IN, and in both shapes for the same reason the
   * shots are: the array is the authoring record and the anchor's meta bag is
   * what the game can actually read. readAnchors over there builds an Anchor
   * from a fixed list of top-level fields and copies meta whole, so an array up
   * top has no reader at all; PmapScene keys its sprites by placement name, so a
   * state pointing at a name needs no new lookup. */
  const sv = (shipped.variants || []).find((v) => v.name === 'the_berth_state')
  eq('published variant set', sv?.members.map((m) => m.placement), ['the_empty_berth', 'the_ship'])
  eq('published variant labels, which the projection drops', sv?.members[0]?.label, 'no ship')
  const berth = (shipped.anchors || []).find((a) => a.name === 'the_berth')
  eq('the set is on the anchor python addresses it through', berth?.meta?.variants?.the_berth_state, {
    initial: 'empty',
    members: [
      { name: 'empty', placement: 'the_empty_berth' },
      { name: 'moored', placement: 'the_ship' },
    ],
  })
  /* THE GROUP ROWS SHIP TOO. Nothing has to read them, because every placement
   * already carries the resolved string; without them a reopened map shows a
   * dozen placements each carrying a condition and no group that owns any. */
  eq('published group row', [shipped.groups?.[0]?.name, shipped.groups?.[0]?.when], ['year_two', 'year >= 2'])
  /* AND THE ANCHOR'S OWN CONDITION, in the bag, beside the shots and under the
   * docId that was already there. A door barred until a cord is earned has no
   * placement to hang a condition on, which is the case that settles it. */
  eq('the anchor condition reaches the bag the game reads', (shipped.anchors || []).find((a) => a.name === 'the_barred_way')?.meta?.when, 'cord("service")')
  /* AND AN ANCHOR NOBODY HUNG A SET ON GROWS NOTHING, so a bundle with no
   * variant sets on it stays byte for byte what it was. */
  eq('an anchor with no set on it stays as it was', berth?.meta?.framings, undefined)

  /* A SET NAMING AN ANCHOR THAT IS NOT HERE IS REFUSED, WITH THE NAME SAID.
   *
   * This is the whole argument for authoring a set instead of typing five strings
   * into python. A grape iterating `steles` and silently getting four back is
   * indistinguishable from five to everything downstream: the badge that fires on
   * the set being complete never fires and nothing anywhere says why. So the
   * count is checked once, here, where refusing costs a retry, rather than at
   * runtime where it costs a student the beat.
   *
   * Written straight into the column rather than through putDoc, because putDoc
   * also mirrors the anchors and this has to change one thing at a time. Put back
   * immediately after, so section 4 below still finds the map it expects. */
  const goodSets = (await one('select sets from maps where id = $1', [map.id])).sets
  await q(`update maps set sets = $2::jsonb where id = $1`, [
    map.id,
    JSON.stringify([{ id: 1, name: 'the_stations', members: ['coach_post', 'a_stele_nobody_drew'] }]),
  ])
  let setRefused = ''
  try {
    await publishBundle(SLUG, {
      mapJson: bundleMap,
      assetsJson: { assets: [] },
      images: { 'levels.png': levelsPNG },
      files: new Map(),
    })
  } catch (e) {
    setRefused = e.message
  }
  setRefused.includes('a_stele_nobody_drew') && setRefused.includes('the_stations')
    ? ok('a set naming an anchor this map does not have is refused, and the refusal says which name')
    : no(`a broken set published anyway: ${setRefused || 'no error'}`)
  await q(`update maps set sets = $2::jsonb where id = $1`, [map.id, JSON.stringify(goodSets)])

  /* AND THE SHAPE A GRAPE ACTUALLY ASKS IN. The bundle above is what the engine
   * loads; this is what a member's python reads at author time, keyed by the name
   * they typed, so `for a in self.anchors_in("the_stations")` is one call rather
   * than a list-walk written slightly differently in every island. Booted in this
   * process the way verify-api does, so it tests the working tree. */
  {
    const server = http.createServer((req, res) =>
      api(req, res, () => {
        res.statusCode = 404
        res.end('not found')
      }),
    )
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
    try {
      const body = await (await fetch(`http://127.0.0.1:${PORT}/api/v1/maps/${SLUG}/sets`)).json()
      eq('a grape looks a set up by the name its author typed', body.sets?.the_stations, {
        label: 'the stations',
        members: ['coach_post', 'the_yard'],
      })
      eq('and a rack comes back with the addresses, not with array positions', body.racks?.the_trophy_wall?.slots, [
        { slot: 1, anchor: 'coach_post', label: 'first place' },
        { slot: 3, anchor: 'the_yard' },
      ])
    } finally {
      await new Promise((r) => server.close(r))
    }
  }

  // ---- 4. and the gate really does stop a publish -------------------------
  await q(`update anchors set x = 46, y = 20, r = 2 where map_id = $1 and name = 'coach_post'`, [map.id])
  let refused = ''
  try {
    await publishBundle(SLUG, {
      mapJson: bundleMap,
      assetsJson: pubAssets,
      images: { 'levels.png': levelsPNG },
      files: new Map(),
    })
  } catch (e) {
    refused = e.message
  }
  refused.includes('was not published')
    ? ok('a map with an unreachable anchor is refused before a version is written')
    : no('an unreachable anchor published anyway')
  const after = await publishedMap(SLUG)
  after.version === pub.version ? ok(`still at v${pub.version}, so nothing was half written`) : no(`version moved to ${after.version}`)

  // ---- 5. the water between the islands -----------------------------------
  /* The one surface the entire crossing happens on, and until now the one
   * surface with no author. A berth is off the painting by definition, so no
   * anchor could ever have expressed one: anchor creation refuses a click
   * outside the canvas, and growing the canvas to make room zooms the island
   * out. This saves a composition, reads it back the way the game reads it, and
   * puts the whole thing back exactly as it was found.
   *
   * ONE KIND OF POINT SINCE 019_berths.sql. A place carried a nested `berth` and
   * a nested `approach`, so the only points that could exist were welded to an
   * island's corner, and this section tested that shape. Every point is an entry
   * in `marks` now with `island` naming the place it belongs to, and the fences
   * below are the ones that shape needs: that a bound point still crosses as
   * that slot's berth, that an unreachable one is still warned about, and that a
   * point in open water is still addressable by a name nothing else holds. */
  /* SAVE AND RESTORE IS NOT SAFE ON A ROW THERE IS ONLY ONE OF, and this test
   * destroyed Ash's real composition proving it.
   *
   * The pattern below is read-the-world, overwrite it with a throwaway, put it
   * back in a finally. That is correct for one runner and wrong for two. Two
   * runs overlapped: A read the real ocean, B read A's throwaway as though it
   * were the truth, A put the real one back, and then B put A's throwaway back
   * on top. The hub and its berth were gone and nothing said so, because both
   * runs reported every check green. There is exactly one world row, so any
   * concurrency at all makes the restore a coin toss.
   *
   * A lock is the fix rather than more care. This takes a postgres advisory
   * lock for the whole section, so a second runner waits instead of interleaving
   * and reading a half-finished ocean as its baseline. The key is an arbitrary
   * constant that only this section uses. The lock is session scoped and the
   * pool hands the connection back on release, so a crashed run frees it when
   * its connection closes rather than wedging the next one for ever. */
  const WORLD_LOCK = 774_112_090
  await q('select pg_advisory_lock($1)', [WORLD_LOCK])
  const worldBefore = await getWorld()
  try {
    const saved = await saveWorld({
      w: 4096,
      h: 4096,
      home: 'zz_verify_isle',
      places: [
        {
          name: 'zz_verify_isle',
          // the roster id, which is a DIFFERENT string from the address above
          // and cannot be spelt by it: this is kebab-case and a name is a python
          // identifier. The game looks a slot up by this and counts a visit
          // under it, so a composition carrying none has every island stuck at
          // misty for the whole run with nothing saying why.
          place: 'verify-yard',
          map: SLUG,
          title: 'The Verify Yard',
          x: 800,
          y: 600,
          w: 128,
          h: 96,
          state: 'available',
          // two radii, and this tool had one under the other one's name
          discover: 240,
          release: 900,
        },
        // a reserved position holding no map, reading as a rumour, with the
        // rise happening where the rumour was. Negative on purpose: the sea the
        // game sails is the hub's own pixels extended, centred on the hub, so
        // half of it is negative and every one of those was unstorable here.
        { name: 'zz_verify_rumour', map: '', title: '', x: 2200, y: -1400, w: 64, h: 64, state: 'rumour', discover: 300 },
      ],
      regions: [{ name: 'zz_the_shallows', kind: 'shallow', rect: [700, 500, 1100, 900] }],
      /* THE BERTH IS A ROW OF ITS OWN AND NAMES THE ISLAND IT BELONGS TO, which
       * is the whole of 019. It is off the painting, which is the reason the
       * category exists at all: no anchor can express a point outside a canvas.
       * `at` is the anchor INSIDE the island the hull puts somebody down on, and
       * it is the one field the old nested shape carried that had nowhere else
       * to live. The second one is in open water and belongs to nobody, which is
       * the corner a crossing turns at. */
      marks: [
        { name: 'zz_verify_dock', kind: 'berth', x: 880, y: 700, facing: 'north', at: 'coach_post', island: 'zz_verify_isle', label: 'The Verify Dock' },
        { name: 'zz_north_turn', kind: 'waypoint', x: 1600, y: 200, r: 50 },
      ],
    })
    const readBack = await getWorld()
    const isle = readBack.places.find((p) => p.name === 'zz_verify_isle')
    const dock = readBack.marks.find((m) => m.name === 'zz_verify_dock')
    /* A PLACE CARRIES NO POINT AT ALL NOW, and that is the fence: cleanPlace
     * dropping the nesting is what stops a stale berth riding along beside the
     * real one, where nothing would say which of the two the game read. */
    eq('an island carries no point of its own', [isle?.berth, isle?.approach], [undefined, undefined])
    // field by field rather than whole, because this one came back out of jsonb
    // and postgres does not keep the key order an object went in with
    eq(
      'a berth exists in world space and says whose it is',
      [dock?.x, dock?.y, dock?.facing, dock?.at, dock?.island],
      [880, 700, 'north', 'coach_post', 'zz_verify_isle'],
    )
    eq('and a point in open water belongs to nobody', readBack.marks.find((m) => m.name === 'zz_north_turn')?.island, undefined)
    eq('the island state', isle?.state, 'available')
    eq('the discovery radius', isle?.discover, 240)
    eq('and the radius it stays in memory to, which is a different number', isle?.release, 900)
    eq('the roster id the game addresses it by', isle?.place, 'verify-yard')
    eq('a slot that is empty on purpose', readBack.places.find((p) => p.name === 'zz_verify_rumour')?.map, '')
    eq('a rumour out in negative water', readBack.places.find((p) => p.name === 'zz_verify_rumour')?.y, -1400)
    eq('a named sea region', readBack.regions.find((r) => r.name === 'zz_the_shallows')?.kind, 'shallow')
    eq('where a run with no ship begins', readBack.home, 'zz_verify_isle')
    saved.warnings.length === 0
      ? ok('a berth inside its own discovery radius draws no warning')
      : no(`unexpected warning: ${saved.warnings[0]}`)

    /* THE OCEAN IN THE GAME'S OWN WORDS, which is the shape that actually
     * crosses. The game gates the whole fetch on Array.isArray(slots), so
     * answering with `places` meant a real composition was discarded and a
     * hand-written fallback used in its place, silently, on both sides. */
    const comp = await composition()
    Array.isArray(comp.slots) && !comp.places
      ? ok('the ocean leaves as slots, the key the game gates the whole fetch on')
      : no('the composition still answers with places')
    const slot = comp.slots.find((s) => s.place === 'verify-yard')
    eq('the slot position is a point, not two loose numbers', slot?.at, { x: 800, y: 600 })
    /* THE PAINTED EXTENT, NOT THE CANVAS. A radius measured off the canvas is 41
     * percent too generous on the hub, in the direction that discovers an island
     * before it is on screen. Asked of the maps table, which has known all three
     * numbers since the first schema and never said any of them. */
    eq('the footprint is the painting', slot?.footprint, { w: W, h: H })
    eq('the canvas beside it', slot?.canvas, { w: W, h: H })
    eq('and what it really costs to hold', slot?.placements, doc.assets.length)
    /* THE BERTH IS FOLDED BACK IN UNDER THE KEY THE GAME ALREADY READS, and this
     * is the fence that makes 019 invisible on the wire. PmapScene reads
     * slot.berth about thirty times, so the collapse had to be a change to where
     * a point is AUTHORED and never to what crosses: composition() looks the
     * island's berth up out of the flat list and hands it over unchanged, with
     * its own name added so a grape holding a slot can go straight to the flat
     * lookup instead of matching coordinates. */
    eq('the free-standing berth crosses as that slot"s berth', slot?.berth, {
      name: 'zz_verify_dock',
      x: 880,
      y: 700,
      facing: 'north',
      at: 'coach_post',
    })
    /* AND EVERY POINT IS STILL ON THE WIRE UNDER `marks`, including the one
     * folded into the slot above, because the sail loop that grows routes will
     * want the whole list and not the one dock per island. */
    eq('every point crosses as well, by name', (comp.marks || []).map((m) => m.name).sort(), ['zz_north_turn', 'zz_verify_dock'])
    /* FOUR NUMBERS AGAINST A READER THAT WANTS FOUR KEYS is the quietest failure
     * on this endpoint: every comparison is against undefined and false, so no
     * region ever matches and nothing anywhere is raised. */
    eq('a sea region crosses as a box', comp.regions.find((r) => r.name === 'zz_the_shallows')?.rect, {
      x: 700,
      y: 500,
      w: 400,
      h: 400,
    })
    eq('and the run knows where it starts', comp.home, { slot: 'zz_verify_isle' })

    /* THE VERSION HAS TO BE QUIET. The game stamps a saved position with it and
     * refuses to resume when the number has changed, so one that moved on every
     * press would throw away every position on a class of chromebooks each time
     * an author saved. updated_at could never have done this job. */
    const v1 = (await getWorld()).version
    await saveWorld({ w: 4096, h: 4096, home: 'zz_verify_isle', places: saved.places, regions: saved.regions })
    eq('a save that changed nothing leaves the world version alone', (await getWorld()).version, v1)
    await saveWorld({
      w: 4096,
      h: 4096,
      home: 'zz_verify_isle',
      places: saved.places.map((q) => (q.name === 'zz_verify_isle' ? { ...q, x: 810 } : q)),
      regions: saved.regions,
    })
    const v2 = (await getWorld()).version
    v2 === v1 + 1
      ? ok('and moving an island counts it up, which is what refuses a stale position')
      : no(`the version did not move: ${v1} then ${v2}`)

    /* A composition that cannot work is refused where it is written, naming
     * what is wrong, rather than found by a student sailing into nothing. */
    let worldRefused = ''
    try {
      await saveWorld({
        w: 4096,
        h: 4096,
        places: [
          { name: 'zz_twice', map: '', x: 10, y: 10, w: 8, h: 8, state: 'rumour', release: 10 },
          { name: 'zz_twice', map: '', x: 90, y: 90, w: 8, h: 8, state: 'rumour', release: 10 },
        ],
        regions: [],
      })
    } catch (e) {
      worldRefused = e.message
    }
    worldRefused.includes('only address')
      ? ok('two places with one name are refused, because a name is the only address there is')
      : no(`a duplicate place name saved anyway: ${worldRefused || 'no error'}`)

    /* A BERTH OUTSIDE ITS ISLAND'S DISCOVERY RADIUS is the quiet one: the ship
     * sails to a dock that is offered before the island has been discovered.
     * Measured through berthOf, the same rule composition() sends, so this can
     * never warn about a point the game will not be handed. */
    const far = await saveWorld({
      w: 4096,
      h: 4096,
      places: [{ name: 'zz_far', map: '', x: 100, y: 100, w: 8, h: 8, state: 'rumour', discover: 10 }],
      regions: [],
      marks: [{ name: 'zz_far_dock', kind: 'berth', x: 900, y: 900, island: 'zz_far' }],
    })
    far.warnings.some((w) => w.includes('the dock is offered before the island is'))
      ? ok('a berth outside its island"s discovery radius is warned about')
      : no('an unreachable berth passed without a word')

    /* A BERTH BOUND TO AN ISLAND NOBODY HAS PLACED, which is the one thing the
     * collapse made possible to get wrong. Nesting could not express it: a berth
     * lived inside its island, so deleting the island took the berth with it.
     * Now the name can dangle, so it is named at the save. */
    const orphan = await saveWorld({
      w: 4096,
      h: 4096,
      places: [{ name: 'zz_far', map: '', x: 100, y: 100, w: 8, h: 8, state: 'rumour', discover: 10 }],
      regions: [],
      marks: [{ name: 'zz_lost_dock', kind: 'berth', x: 120, y: 120, island: 'zz_sunk_isle' }],
    })
    orphan.warnings.some((w) => w.includes('zz_sunk_isle'))
      ? ok('a berth tied to an island that is not there is named at the save')
      : no('a berth pointed at nothing and nobody said so')

    /* A POINT THAT BELONGS TO NEITHER ISLAND IT SITS BETWEEN.
     *
     * A berth and an approach hung off a place, so the only points that could
     * exist were points about arriving somewhere. The corner a sail leg turns
     * at halfway across has no place to hang off and was a constant typed into
     * the game repo. This is the fence saying it survives the save and comes
     * back out of the read api in the shape python asks for it in. */
    const marked = await saveWorld({
      w: 4096,
      h: 4096,
      places: [{ name: 'zz_verify_isle', map: '', x: 800, y: 600, w: 128, h: 96, state: 'rumour', release: 240 }],
      regions: [],
      marks: [
        { name: 'zz_north_passage', kind: 'waypoint', x: 1200, y: 400, facing: 'north', r: 60, label: 'the north passage' },
        { name: 'zz_deep_water', kind: 'anchorage', x: 900, y: 1500 },
        // `approach` left the vocabulary with 019: it was never a kind of point,
        // it was the second field on a place. A row still carrying it falls back
        // rather than being kept as a seventh spelling of the same thing.
        { name: 'zz_old_approach', kind: 'approach', x: 950, y: 1550 },
        // dropped rather than corrected, because bending it invents an address
        // the author never wrote and nothing in their python calls
        { name: 'North Passage', kind: 'waypoint', x: 10, y: 10 },
      ],
    })
    eq('a bad berth name is dropped rather than tidied into one', marked.marks.length, 3)
    const readMarks = (await getWorld()).marks
    const wp = readMarks.find((m) => m.name === 'zz_north_passage')
    eq('the waypoint survives the save', [wp?.kind, wp?.x, wp?.y, wp?.facing, wp?.r], ['waypoint', 1200, 400, 'north', 60])
    eq('a kind the author narrowed is kept', readMarks.find((m) => m.name === 'zz_deep_water')?.kind, 'anchorage')
    /* BERTH IS THE FALLBACK NOW AND IT WAS `waypoint`. Everything on the water is
     * a berth unless somebody deliberately narrowed it, so a kind this file has
     * never heard of lands on the word Ash gave the category. */
    eq('a kind nothing recognises falls back to a berth', readMarks.find((m) => m.name === 'zz_old_approach')?.kind, 'berth')

    /* ONE NAMESPACE, because python has one. A grape calls sail_to("x") and
     * never says which list to look in, so a mark sharing a name with an island
     * is a call whose answer depends on which lookup runs first. */
    let clash = ''
    try {
      await saveWorld({
        w: 4096,
        h: 4096,
        places: [{ name: 'zz_both', map: '', x: 10, y: 10, w: 8, h: 8, state: 'rumour', release: 10 }],
        regions: [],
        marks: [{ name: 'zz_both', kind: 'waypoint', x: 90, y: 90 }],
      })
    } catch (e) {
      clash = e.message
    }
    clash.includes('one namespace')
      ? ok('a berth taking an island name is refused, because python addresses both in one namespace')
      : no(`a berth and a place shared a name: ${clash || 'no error'}`)

    /* AND THE BERTHS ARE ABSENT RATHER THAN EMPTY when nobody mentions them.
     * The world page posts w, h, places and regions and says nothing about this
     * field, so treating the silence as an empty list means one drag of an
     * island wipes the list. It costs more since 019 than it did before: this
     * used to hold only free waypoints and now it holds every dock as well. */
    await saveWorld({ w: 4096, h: 4096, places: [], regions: [] })
    eq('a save that never mentions berths keeps them', (await getWorld()).marks.length, 3)

    /* THE PUBLISHED READ HAS NO ACCOUNT AND MUST NOT NEED ONE.
     *
     * /api/world is now refused to anybody but the account the ocean belongs
     * to. /api/v1 is the other half of that decision: a freshman on a chromebook
     * has never heard of MAPVIS and this is the request that tells the ship
     * where the islands are. Booted in this process, the way verify-api does,
     * so it tests the working tree and needs nothing else to be up. */
    const server = http.createServer((req, res) =>
      api(req, res, () => {
        res.statusCode = 404
        res.end('not found')
      }),
    )
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
    try {
      const pub = await fetch(`http://127.0.0.1:${PORT}/api/v1/world`)
      const body = await pub.json()
      pub.ok && Array.isArray(body.marks)
        ? ok('the published ocean still answers with no account behind the request')
        : no(`/api/v1/world answered ${pub.status} to a request with no cookie`)
      const flat = await (await fetch(`http://127.0.0.1:${PORT}/api/v1/world/marks`)).json()
      eq('a grape looks a berth up by the name its author typed', flat.marks?.zz_north_passage, {
        kind: 'waypoint',
        x: 1200,
        y: 400,
        facing: 'north',
        // and the words a player is shown for it, which this route used to drop:
        // an island holding only the address prints `zz_north_passage` at somebody
        label: 'the north passage',
        // which island it belongs to, so a grape that has sailed somewhere can
        // tell what it arrived at without fetching the whole composition
        island: '',
        at: '',
      })
      /* AND A BOUND BERTH ANSWERS UNDER ITS ISLAND'S OWN NAME AS WELL, because a
       * grape asking to sail to `panther_isle` should not have to know what the
       * author called its dock. Set up here rather than relying on what the
       * saves above left, so the alias is proved and not assumed. */
      await saveWorld({
        w: 4096,
        h: 4096,
        places: [{ name: 'zz_alias_isle', map: '', x: 300, y: 300, w: 64, h: 64, state: 'rumour', discover: 900 }],
        regions: [],
        marks: [{ name: 'zz_alias_dock', kind: 'berth', x: 360, y: 360, island: 'zz_alias_isle', label: 'The Alias Dock' }],
      })
      const aliased = await (await fetch(`http://127.0.0.1:${PORT}/api/v1/world/marks`)).json()
      eq('an island answers with its own berth, under its own name', aliased.marks?.zz_alias_isle, {
        kind: 'berth',
        x: 360,
        y: 360,
        facing: '',
        label: 'The Alias Dock',
        island: 'zz_alias_isle',
        at: '',
      })
      eq('and the berth is still reachable by the name it was given', aliased.marks?.zz_alias_dock?.x, 360)
    } finally {
      await new Promise((r) => server.close(r))
    }
  } finally {
    // put the ocean back exactly as it was, because it is one shared row
    await saveWorld(worldBefore)
    // released only after the ocean is back, so the next runner's baseline is
    // the real one and never this test's throwaway
    await q('select pg_advisory_unlock($1)', [WORLD_LOCK])
  }

  // ---- 6. the ui library, and one kit shared across maps -------------------
  /* A PICTURE OF A PAGE IS NOT A PAGE. A generated dialogue box with no marks
   * is a wallpaper: the game still has to be told where the name prints, where
   * the button is and how deep the frame edge runs, and those numbers end up
   * typed into game source where the picture cannot correct them. So the marks
   * are the deliverable, and this is the fence saying one survives being saved
   * and read back.
   *
   * Nothing here generates anything. The picture is a solid colour written by
   * this file, because the only thing being tested is whether an authored value
   * reaches the other end. */
  const solidPNG = (w, h, r, g, b) => {
    const rgba = Buffer.alloc(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = r
      rgba[i * 4 + 1] = g
      rgba[i * 4 + 2] = b
      rgba[i * 4 + 3] = 255
    }
    return encodePNG(w, h, rgba)
  }

  const thrown = async (fn) => {
    try {
      await fn()
      return ''
    } catch (e) {
      return String(e.message || e)
    }
  }

  const UI = 'zz_verify_panel'
  await removeUi(owner.id, UI, { core: true })
  try {
    await createUi({ ownerId: owner.id, name: UI, title: 'The Verify Panel', description: 'a plain box', w: 200, h: 80 })
    const saved = await setUiRegions(owner.id, UI, [
      { name: 'speaker', kind: 'text', x: 10, y: 6, w: 120, h: 14, align: 'left', wrap: 'nowrap', overflow: 'ellipsis' },
      { name: 'stamina', kind: 'fill', x: 10, y: 40, w: 180, h: 12, axis: 'right', mode: 'tile', meta: { fills: 'left' } },
      { name: 'go_on', kind: 'press', x: 150, y: 60, w: 44, h: 16 },
    ])
    eq('the piece keeps every region it was given', saved.regions.length, 3)

    const read = await getUiByName(owner.id, UI)
    const bar = read?.regions.find((s) => s.name === 'stamina')
    eq('a region comes back by name', [bar?.kind, bar?.x, bar?.y, bar?.w, bar?.h], ['fill', 10, 40, 180, 12])
    /* A ROPE THAT STRETCHES IS A SMEAR AND A ROPE THAT TILES IS A ROPE, which
     * is the whole reason `bar` became `fill`: the old kind carried neither a
     * direction nor a tile rule, so the reader had to guess both. */
    eq('a fill says which way it grows and whether it tiles', [bar?.axis, bar?.mode], ['right', 'tile'])
    eq('a region keeps the bag its author filled', bar?.meta, { fills: 'left' })
    eq('a region keeps its alignment', read?.regions.find((s) => s.name === 'speaker')?.align, 'left')
    eq('text says what a long option does', read?.regions.find((s) => s.name === 'speaker')?.overflow, 'ellipsis')

    /* A REGION WITH NO NAME IS REFUSED RATHER THAN NUMBERED. Every other field
     * has an honest default; a name does not, because the name is the thing a
     * grape holds, and a mark silently called region_3 is a promise nobody
     * made. */
    const nameless = await thrown(() => setUiRegions(owner.id, UI, [{ kind: 'text', x: 0, y: 0, w: 10, h: 10 }]))
    nameless.includes('no name')
      ? ok('a nameless region is refused rather than given a number')
      : no(`a nameless region saved anyway: ${nameless || 'no error'}`)

    // and a rect off the edge of the picture, which can never be drawn into,
    // is refused with the region's own name in the sentence
    const offEdge = await thrown(() => setUiRegions(owner.id, UI, [{ name: 'off_the_edge', kind: 'text', x: 180, y: 70, w: 60, h: 40 }]))
    offEdge.includes('off_the_edge') && offEdge.includes('200x80')
      ? ok('a region off the edge is refused, naming the region and the picture')
      : no(`a region off the picture saved anyway: ${offEdge || 'no error'}`)

    /* THE VERTICAL IS REQUIRED ON A PICTURE AND THERE IS NO DEFAULT. The
     * shipped portrait is bottom-anchored because a person stands on the bottom
     * of their box, and a frame that centres its content leaves every character
     * in the game floating with nothing anywhere saying so. */
    const floating = await thrown(() => setUiRegions(owner.id, UI, [{ name: 'their_face', kind: 'picture', x: 4, y: 4, w: 40, h: 60 }]))
    floating.includes('floating')
      ? ok('a picture with no vertical is refused rather than quietly centred')
      : no(`a picture region saved with no vertical: ${floating || 'no error'}`)

    // overlap is legal and usually a mis-drag, so it warns and still saves
    const over = await setUiRegions(owner.id, UI, [
      { name: 'the_bar', kind: 'fill', x: 10, y: 10, w: 100, h: 20 },
      { name: 'the_reading', kind: 'number', x: 40, y: 12, w: 30, h: 14 },
    ])
    over.warnings.some((w) => w.includes('overlap'))
      ? ok('two overlapping regions warn and still save')
      : no('an overlap passed without a word')
    eq('the piece still has both after the warning', over.regions.length, 2)
  } finally {
    await removeUi(owner.id, UI, { core: true })
  }

  /* ---- the twenty-one types, and the four numbers a ground piece owes -----
   *
   * docs/UI-KIT.md read the game's own record and found twenty-one distinct
   * kinds of drawn surface. The reason to have types at all is that twenty
   * islands built by twenty people end up speaking one dialect rather than
   * twenty, and the reason to have the edge numbers is that every UI image in
   * the game today is drawn with `center / 100% 100% no-repeat`, which squashes
   * one whole painting into whatever box the element happens to be. */
  eq('the kit names twenty-one types', PIECE_TYPES.length, 21)
  eq('a type nobody named does not resolve', pieceType('wobble_box'), null)

  const GROUND = 'zz_verify_ground'
  const SHEET = 'zz_verify_sheet'
  const CORE = 'zz_verify_core'
  for (const n of [GROUND, SHEET, CORE]) await removeUi(owner.id, n, { core: true })
  try {
    /* A GROUND ROUND-TRIPS WITH ITS SLICES. The unit is SOURCE pixels because
     * that is the only thing CSS border-image and Pixi NineSliceSprite agree
     * on, and `scale` rides along because border-image-width is a separate
     * number: with only four insets the game has to invent the draw thickness
     * and will get it wrong. */
    await createUi({ ownerId: owner.id, name: GROUND, type: 'panel', description: 'a plain paper panel', w: 96, h: 96 })
    await setUiImage(owner.id, GROUND, solidPNG(96, 96, 190, 170, 130), 96, 96)
    const g = await setUiRegions(
      owner.id,
      GROUND,
      [{ name: 'body', kind: 'text', x: 14, y: 14, w: 68, h: 68 }],
      { slice: { top: 12, right: 14, bottom: 13, left: 14 }, scale: 2, fill: true, repeat: { x: 'round', y: 'round' } },
    )
    /* READ IN CSS ORDER RATHER THAN COMPARED AS AN OBJECT, because jsonb does
     * not keep the key order it was handed: these come back top, left, right,
     * bottom. Nothing reads them positionally, so it costs nothing, but a test
     * comparing two stringified objects fails on it and looks like data loss. */
    const four = (s) => [s.top, s.right, s.bottom, s.left]
    eq('a ground keeps its four edge numbers', four(g.slice), [12, 14, 13, 14])
    eq('and the draw thickness beside them', [g.scale, g.fill, g.repeat.x, g.repeat.y], [2, true, 'round', 'round'])
    const back = await getUiByName(owner.id, GROUND)
    eq('the slices survive being read back', four(back.slice), [12, 14, 13, 14])
    /* THE FORM HE CAN PASTE. Section 3's smallest change on the game side is
     * three tokens plus one rule per image, and border-width is slice * scale
     * so nothing is guessed on that side. */
    back?.css.includes('--kit-slice-zz_verify_ground: 12 14 13 14;') && back?.css.includes('--kit-slice-w-zz_verify_ground: 24px 28px 26px 28px;')
      ? ok('the measurement comes out as css that can be pasted, with the thickness worked out')
      : no(`the css is not the shape the game takes: ${(back?.css || '').split('\n')[0] || 'nothing'}`)

    /* THE CONSTRAINT THAT BREAKS SILENTLY. If the top and bottom insets do not
     * leave a middle, CSS drops to no border image at all and says nothing, and
     * the author spends an hour in the wrong stylesheet. */
    const crossed = await thrown(() =>
      setUiRegions(owner.id, GROUND, [{ name: 'body', kind: 'text', x: 14, y: 14, w: 68, h: 68 }], {
        slice: { top: 60, right: 14, bottom: 50, left: 14 },
      }),
    )
    crossed.includes('no middle') && crossed.includes('saying nothing')
      ? ok('edges that cross leave no middle and are refused, naming what CSS does about it')
      : no(`crossed edges saved anyway: ${crossed || 'no error'}`)

    /* AND A PANEL WITHOUT fill RENDERS AS A RING AROUND A HOLE, because
     * border-image defaults it off. Only the highlight edge wants that. */
    const ring = await thrown(() =>
      setUiRegions(owner.id, GROUND, [{ name: 'body', kind: 'text', x: 14, y: 14, w: 68, h: 68 }], {
        slice: { top: 12, right: 14, bottom: 13, left: 14 },
        fill: false,
      }),
    )
    ring.includes('ring around a hole') ? ok('a panel that would draw as a ring around a hole is refused') : no(`fill:false saved on a panel: ${ring || 'no error'}`)

    /* A SHEET CARRIES NAMED FACES CUT FROM ONE CANVAS. Both sides of a
     * generation start at 192 and a season token is about 24 across, so a
     * family of small marks is one job cut by marked rectangles, which is also
     * the only way the five faces come back the same weight. */
    await createUi({ ownerId: owner.id, name: SHEET, type: 'pip', description: 'five season tokens', w: 100, h: 100 })
    await setUiImage(owner.id, SHEET, solidPNG(100, 100, 120, 150, 190), 100, 100)
    const s = await setUiRegions(owner.id, SHEET, [
      { name: 'fall', kind: 'face', x: 0, y: 0, w: 20, h: 20 },
      { name: 'winter', kind: 'face', x: 20, y: 0, w: 20, h: 20 },
      { name: 'spring', kind: 'face', x: 40, y: 0, w: 20, h: 20 },
      { name: 'spent', kind: 'face', x: 60, y: 0, w: 20, h: 20 },
      { name: 'ghost', kind: 'face', x: 80, y: 0, w: 20, h: 20 },
    ])
    eq('a sheet reports its faces as a list of cuts', s.faces.map((f) => f.name), ['fall', 'winter', 'spring', 'spent', 'ghost'])
    eq('and each cut keeps its rectangle', s.faces[3], { name: 'spent', x: 60, y: 0, w: 20, h: 20 })
    /* TWO CUTS SHARING PIXELS IS NOT A MIS-DRAG THE WAY TWO REGIONS ARE. One of
     * the two comes out with a corner of its neighbour in it, so it is refused
     * where two overlapping text wells only warn. */
    const shared = await thrown(() =>
      setUiRegions(owner.id, SHEET, [
        { name: 'fall', kind: 'face', x: 0, y: 0, w: 30, h: 20 },
        { name: 'winter', kind: 'face', x: 20, y: 0, w: 20, h: 20 },
      ]),
    )
    shared.includes('share pixels') ? ok('two cuts that share pixels are refused') : no(`overlapping faces saved: ${shared || 'no error'}`)
    // and a sheet does not stretch, so four edge numbers on one are a
    // measurement nothing will ever read
    const wrongTier = await thrown(() => setUiRegions(owner.id, SHEET, [], { slice: { top: 4, right: 4, bottom: 4, left: 4 } }))
    wrongTier.includes('does not stretch') ? ok('edge numbers on a sheet are refused as a field nothing reads') : no(`slices saved on a sheet: ${wrongTier || 'no error'}`)

    /* A PIECE WITHOUT SLICES IS REFUSED AT PUBLISH, because those four numbers
     * are the entire thing the game can consume: without them the consumer
     * falls back to squashing the whole painting into the box. */
    const NOSLICE = 'zz_verify_unmeasured'
    await removeUi(owner.id, NOSLICE, { core: true })
    await createUi({ ownerId: owner.id, name: NOSLICE, type: 'panel', description: 'never measured', w: 96, h: 96 })
    await setUiImage(owner.id, NOSLICE, solidPNG(96, 96, 200, 200, 200), 96, 96)
    await setUiRegions(owner.id, NOSLICE, [{ name: 'body', kind: 'text', x: 14, y: 14, w: 68, h: 68 }])
    const unmeasured = await thrown(() => publishUi(owner.id, NOSLICE))
    unmeasured.includes('four edge numbers')
      ? ok('a ground piece with no measurement cannot be published')
      : no(`an unmeasured ground published anyway: ${unmeasured || 'no error'}`)
    await removeUi(owner.id, NOSLICE, { core: true })

    // the measured one goes through, which is the other half of the same fence
    await setUiRegions(
      owner.id,
      GROUND,
      [{ name: 'body', kind: 'text', x: 14, y: 14, w: 68, h: 68 }],
      { slice: { top: 12, right: 14, bottom: 13, left: 14 }, scale: 2, fill: true, repeat: { x: 'round', y: 'round' } },
    )
    eq('a measured ground publishes', (await publishUi(owner.id, GROUND)).published, true)

    /* ONE KIT, ADDITIVE ONLY (Ash, 2026-08-30). Core chrome is never
     * overridable and a member piece may only add. Two fences, because the flag
     * on a row cannot hold on an empty shelf: the first member to generate
     * something called `dialogue_box` would otherwise own the name every island
     * in the game speaks through. */
    const reserved = await thrown(() => createUi({ ownerId: owner.id, name: 'dialogue_box', description: 'mine now', w: 96, h: 96 }))
    reserved.includes('core chrome') ? ok('a reserved core name is refused to a member piece') : no(`a member took a core name: ${reserved || 'no error'}`)

    await createUi({ ownerId: owner.id, name: CORE, type: 'plaque', description: 'the real one', w: 96, h: 96, core: true })
    const replaced = await thrown(() => createUi({ ownerId: owner.id, name: CORE, description: 'my version', w: 96, h: 96 }))
    replaced.includes('never overridable')
      ? ok('a member piece cannot replace a core one, and the refusal says why')
      : no(`a core piece was replaced: ${replaced || 'no error'}`)
    const deleted = await thrown(() => removeUi(owner.id, CORE))
    deleted.includes('never overridable') ? ok('and it cannot be deleted from a member\'s side either') : no(`a core piece was deleted: ${deleted || 'no error'}`)
    eq('the core piece is still there afterwards', (await getUiByName(owner.id, CORE))?.core, true)

    // the two named so nobody generates them, refused before anything is spent
    const notArt = await thrown(() => createUi({ ownerId: owner.id, name: 'zz_verify_signpost', type: 'sign', description: 'a signpost', w: 96, h: 96 }))
    notArt.includes('not generated') ? ok('a sign is refused here rather than costing a spend to find out') : no(`a sign was accepted: ${notArt || 'no error'}`)
  } finally {
    for (const n of [GROUND, SHEET, CORE]) await removeUi(owner.id, n, { core: true })
  }

  /* ONE DOCK KIT, TWENTY MAPS. The bytes are duplicated on purpose: that costs
   * object storage and no generation at all, and 013_library_kit.sql has the
   * six places a genuinely shared row would have had to reach. The thing that
   * matters here is that EVERY frame comes across, because a walking character
   * copied as one still is a person who faces south forever and nothing
   * anywhere would say so. */
  const KIT_A = 'zz-verify-kit-a'
  const KIT_B = 'zz-verify-kit-b'
  for (const s of [KIT_A, KIT_B]) {
    const had = await getMapBySlug(s)
    if (had) await q('delete from maps where id = $1', [had.id])
  }
  const a = await createMap({ slug: KIT_A, ownerId: owner.id, w: 32, h: 32, spawn: [0, 0] })
  const bmap = await createMap({ slug: KIT_B, ownerId: owner.id, w: 32, h: 32, spawn: [0, 0] })
  try {
    const frames = [solidPNG(8, 8, 200, 60, 40), solidPNG(8, 8, 180, 50, 30), solidPNG(8, 8, 160, 40, 20)]
    await putLibraryFrames(KIT_A, 'dock-barrel', frames, { w: 8, h: 8, fps: 6 })
    await q(`update library_items set shared = true where map_id = $1 and name = 'dock-barrel'`, [a.id])

    const kit = await q(
      `select m.slug, l.name from library_items l join maps m on m.id = l.map_id where l.shared and m.owner_id = $1 and m.slug = $2`,
      [owner.id, KIT_A],
    )
    eq('a shared item is offered by its own map', kit.rows[0]?.name, 'dock-barrel')

    const copied = await copyLibraryItem(KIT_A, 'dock-barrel', KIT_B, 'dock-barrel')
    const there = await one('select * from library_items where map_id = $1 and name = $2', [bmap.id, 'dock-barrel'])
    eq('the copy lands in the other map', there?.name, 'dock-barrel')
    eq('the copy carries the same frame count', there?.frame_count, 3)
    eq('the copy keeps the size and the rate', [there?.w, there?.h, there?.fps], [8, 8, 6])
    /* THE ROW IS THE CHEAP HALF. A row saying three frames with one png behind
     * it is exactly the failure a partial copy looks like, so the bucket is
     * counted rather than trusted. */
    const bytes = await store().list(`maps/${bmap.id}/library/dock-barrel/`)
    bytes.length === 3
      ? ok('all three frames really are in the bucket of the map copied into')
      : no(`the row says 3 frames and the bucket holds ${bytes.length}`)
    /* AND IT IS A COPY, NOT A MOVE. The source has to be untouched, or
     * "offering" a barrel to a second island quietly takes it off the first. */
    const still = await store().list(`maps/${a.id}/library/dock-barrel/`)
    still.length === 3 ? ok('the map it came from still has its own') : no(`the source lost frames: ${still.length} left`)
    eq('the copy reports where it came from', copied?.from, KIT_A)
  } finally {
    for (const id of [a.id, bmap.id]) {
      await store().delPrefix(`maps/${id}/`)
      await q('delete from maps where id = $1', [id])
    }
  }
} finally {
  await q('delete from maps where id = $1', [map.id])
}

console.log(bad ? `\n${bad} check(s) failed.` : `\nevery authored field reaches the bundle.`)
await closeDb()
process.exit(bad ? 1 : 0)
