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
import { getWorld, saveWorld } from '../store/world.mjs'
import { encodePNG } from '../sheet.mjs'
import { q, one, closeDb } from './pool.mjs'

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
    { id: 'a1', name: 'the_coach', group: 'people', kind: 'static', src: '/work/x/library/a/0.png', x: 20, y: 20, scale: 1, sx: 1, sy: 1, rot: 0, fx: false, fy: false },
    { id: 'a2', group: 'props', kind: 'static', src: '/work/x/library/b/0.png', x: 30, y: 30, scale: 1, sx: 1, sy: 1, rot: 0, fx: false, fy: false },
  ],
  assetNext: 3,
  events: [
    // bound to the placement BY ITS NAME, with the floor beside it marked and a
    // heading to face while standing there
    { id: 1, name: 'coach_post', kind: 'post', x: 20, y: 20, r: 10, to: '', label: 'the coach', placement: 'the_coach', stand: [20, 26], facing: 'north' },
    // an area, four numbers meaning two opposite corners
    { id: 2, name: 'the_yard', kind: 'region', x: 10, y: 10, r: 8, to: '', label: '', rect: [4, 4, 36, 30] },
    // a hall is a place you are inside of, so the gate insists on a way out
    { id: 3, name: 'the_way_out', kind: 'door', x: 12, y: 12, r: 8, to: 'hub', toAnchor: 'panthers_maw', label: 'out' },
  ],
  eventNext: 4,
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
  framings: [{ id: 1, name: 'over_the_coach', anchor: 'coach_post', dx: -12, dy: -20, zoom: 2.5, entry: true }],
  framingNext: 2,
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
  /* THE ZOOM IS THE ONE THAT WOULD HAVE DIED QUIETLY. The renderer's zoom is an
   * integer locked at load, so 2.5 is exactly the value something downstream is
   * most tempted to round, and a pull-out shot cannot exist on integer notches. */
  eq('the shot keeps a zoom off the integer notches', bf?.zoom, 2.5)

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
  const pub = await publishBundle(SLUG, {
    mapJson: bundleMap,
    assetsJson: { assets: [{ id: 'a1', name: 'the_coach', group: 'people', src: 'assets/a/0.png', x: 20, y: 20, scale: 1 }] },
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
  eq('published placement name', shippedAssets.assets?.[0]?.name, 'the_coach')

  // ---- 4. and the gate really does stop a publish -------------------------
  await q(`update anchors set x = 46, y = 20, r = 2 where map_id = $1 and name = 'coach_post'`, [map.id])
  let refused = ''
  try {
    await publishBundle(SLUG, {
      mapJson: bundleMap,
      assetsJson: { assets: [] },
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
   * puts the whole thing back exactly as it was found. */
  const worldBefore = await getWorld()
  try {
    const saved = await saveWorld({
      w: 4096,
      h: 4096,
      places: [
        {
          name: 'zz_verify_isle',
          map: SLUG,
          title: 'The Verify Yard',
          x: 800,
          y: 600,
          w: 128,
          h: 96,
          state: 'available',
          release: 240,
          // off the painting, which is the whole point of the category
          berth: { x: 880, y: 700, facing: 'north' },
          approach: { x: 940, y: 780 },
        },
        // a reserved position holding no map, reading as a rumour, with the
        // rise happening where the rumour was
        { name: 'zz_verify_rumour', map: '', title: '', x: 2200, y: 1400, w: 64, h: 64, state: 'rumoured', release: 300 },
      ],
      regions: [{ name: 'zz_the_shallows', kind: 'shallow', rect: [700, 500, 1100, 900] }],
    })
    const readBack = await getWorld()
    const isle = readBack.places.find((p) => p.name === 'zz_verify_isle')
    eq('a berth exists in world space', isle?.berth, { x: 880, y: 700, facing: 'north' })
    eq('the approach beside it', isle?.approach, { x: 940, y: 780 })
    eq('the island state', isle?.state, 'available')
    eq('the release radius', isle?.release, 240)
    eq('a slot that is empty on purpose', readBack.places.find((p) => p.name === 'zz_verify_rumour')?.map, '')
    eq('a named sea region', readBack.regions.find((r) => r.name === 'zz_the_shallows')?.kind, 'shallow')
    saved.warnings.length === 0
      ? ok('a berth inside its own release radius draws no warning')
      : no(`unexpected warning: ${saved.warnings[0]}`)

    /* A composition that cannot work is refused where it is written, naming
     * what is wrong, rather than found by a student sailing into nothing. */
    let worldRefused = ''
    try {
      await saveWorld({
        w: 4096,
        h: 4096,
        places: [
          { name: 'zz_twice', map: '', x: 10, y: 10, w: 8, h: 8, state: 'rumoured', release: 10 },
          { name: 'zz_twice', map: '', x: 90, y: 90, w: 8, h: 8, state: 'rumoured', release: 10 },
        ],
        regions: [],
      })
    } catch (e) {
      worldRefused = e.message
    }
    worldRefused.includes('only address')
      ? ok('two places with one name are refused, because a name is the only address there is')
      : no(`a duplicate place name saved anyway: ${worldRefused || 'no error'}`)

    /* A BERTH OUTSIDE ITS OWN RELEASE RADIUS is the quiet one: the ship sails
     * to a dock that is offered before the island has been discovered. */
    const far = await saveWorld({
      w: 4096,
      h: 4096,
      places: [
        { name: 'zz_far', map: '', x: 100, y: 100, w: 8, h: 8, state: 'rumoured', release: 10, berth: { x: 900, y: 900 } },
      ],
      regions: [],
    })
    far.warnings.some((w) => w.includes('berths'))
      ? ok('a berth outside its own release radius is warned about')
      : no('an unreachable berth passed without a word')
  } finally {
    // put the ocean back exactly as it was, because it is one shared row
    await saveWorld(worldBefore)
  }
} finally {
  await q('delete from maps where id = $1', [map.id])
}

console.log(bad ? `\n${bad} check(s) failed.` : `\nevery authored field reaches the bundle.`)
await closeDb()
process.exit(bad ? 1 : 0)
