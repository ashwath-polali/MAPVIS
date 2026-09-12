// every field here was half-plumbed with no way to type a value; the fence that one now reaches the bundle
import { getMapBySlug, createMap, getDoc, putDoc } from '../store/maps.mjs'
import { publishBundle, publishedMap, orderedHeadings } from '../store/publish.mjs'
import { gateMap } from '../store/gate.mjs'
import { store } from '../store/blobs.mjs'
import { getWorld, saveWorld, composition, withWorld, worldIdFor, worldByPubId, GAME_WORLD } from '../store/world.mjs'
import { putLibraryFrames, copyLibraryItem } from '../store/platform.mjs'
// ownedUiImage is read at 1655 and was never imported, so the whole file threw
// a ReferenceError there and every check after it never ran
import {
  createUi,
  setUiRegions,
  setUiImage,
  getUiByName,
  ownedUiImage,
  ownedUiFull,
  uncropUi,
  cropHero,
  cropsToHero,
  removeUi,
  publishUi,
  readyUi,
  listUi,
  checkSlices,
  sliceCss,
  pieceType,
  chromeRef,
  legalCanvas,
  sheetCanvas,
  canvasFor,
  usesImageEndpoint,
  cutFaces,
  PIECE_TYPES,
} from '../store/ui.mjs'
import { uiAsset, uiAssetBody, sheetBody, fitSheet, SHEET_ONE_IMAGE, UI_ELEMENTS } from '../pixellab.mjs'
import { encodePNG, decodePNG } from '../sheet.mjs'
import { api, chromePrompt, chromePlan, chromeStyle, chromeFinal } from '../api.mjs'
import { NoPlanner } from '../store/planner.mjs'
import { openSession } from '../store/auth.mjs'
import { q, one, closeDb } from './pool.mjs'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

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

/* base off file size is the canvas not the paint, 75 percent too big on the hub, so this scene is inset */
const PAINT = { ox: 5, oy: 6, w: 40, h: 24 }
const scenePNG = (() => {
  const rgba = Buffer.alloc(W * H * 4)
  for (let y = PAINT.oy; y < PAINT.oy + PAINT.h; y++)
    for (let x = PAINT.ox; x < PAINT.ox + PAINT.w; x++) {
      const i = (y * W + x) * 4
      rgba[i] = 90
      rgba[i + 1] = 120
      rgba[i + 2] = 140
      rgba[i + 3] = 255
    }
  return encodePNG(W, H, rgba)
})()

/* WHAT AN AUTHOR TYPED. Every value below is one somebody has to be able to
 * enter in the tool, and this file follows each of them from the form all the
 * way to the bundle the game reads. */
/* overwritten before the save by the lookup below, which finds a real anchor on
 * the target map. It is a placeholder and never a name anything has to carry. */
const DOOR_PLACEHOLDER = 'the_far_side'

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
    /* names ride beside the art index; look 0's name is on the placement because look 0 is its own picture */
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
    { id: 3, name: 'the_way_out', kind: 'door', x: 12, y: 12, r: 8, to: 'hub', toAnchor: DOOR_PLACEHOLDER, label: 'out' },
    /* a barred door with no placement, so the condition rides the meta bag every projection copies whole */
    { id: 4, name: 'the_barred_way', kind: 'door', x: 16, y: 12, r: 8, to: 'hub', toAnchor: DOOR_PLACEHOLDER, label: 'the barred way', when: 'cord("service")' },
    // the anchor a variant set is addressed through, which is the only address
    // python has for one: every world-touching intent takes an anchor name
    { id: 5, name: 'the_berth', kind: 'point', x: 24, y: 22, r: 10, to: '', label: 'the berth' },
    /* L-shaped because no circle holds a bending pier, and at radius 220 it is well past the 64 a narrow clamp allows */
    {
      id: 6,
      name: 'the_pier',
      kind: 'region',
      x: 20,
      y: 30,
      r: 220,
      to: '',
      label: 'the pier',
      /* mode says which shape is live, so nothing has to be deleted to choose one and no drawing is lost */
      shape: 'poly',
      poly: [
        [6, 26],
        [20, 26],
        [20, 34],
        [34, 34],
        [34, 40],
        [6, 40],
      ],
    },
    /* two points are a line with no inside, so a region built from one is refused where it is written */
    {
      id: 7,
      name: 'the_half_shape',
      kind: 'region',
      x: 30,
      y: 12,
      r: 8,
      to: '',
      label: '',
      shape: 'poly',
      poly: [
        [2, 2],
        [9, 9],
      ],
    },
    /* all three shapes are held at once and only the chosen one ships, so writing one cannot delete the others */
    {
      id: 8,
      name: 'the_switched_place',
      kind: 'region',
      x: 26,
      y: 16,
      r: 9,
      to: '',
      label: 'the switched place',
      shape: 'circle',
      rect: [22, 12, 30, 20],
      poly: [
        [22, 12],
        [30, 12],
        [30, 20],
        [26, 24],
        [22, 20],
      ],
    },
    /* a door's reach is the doormat, not a ring that takes in the wall; the mode had four places to die */
    {
      id: 9,
      name: 'the_shed_door',
      kind: 'door',
      x: 30,
      y: 38,
      r: 9,
      to: 'hub',
      toAnchor: DOOR_PLACEHOLDER,
      label: 'the shed',
      shape: 'poly',
      poly: [
        [24, 34],
        [36, 34],
        [36, 40],
        [30, 40],
        [30, 44],
        [24, 44],
      ],
    },
    /* a post's zone is the reachable floor beside it and stand-at is the pixel a body ends on */
    {
      id: 10,
      name: 'the_counter',
      kind: 'post',
      x: 14,
      y: 32,
      r: 7,
      to: '',
      label: 'the counter',
      facing: 'north',
      stand: [14, 36],
      shape: 'poly',
      poly: [
        [8, 34],
        [22, 34],
        [22, 38],
        [16, 38],
        [16, 42],
        [8, 42],
      ],
    },
  ],
  eventNext: 11,
  occs: [{ id: 1, baseline: 41 }],
  occNext: 2,
  // the six numbers describing the body, none of them the defaults
  walk: { charH: 36, hip: 3, hipDY: 2, speed: 68, yScale: 0.66, near: 12 },
  props: { title: 'The Verify Yard', class: 'hall', islandId: 'verify_club', meta: { district: 'harbour' } },
  /* a named route, so a crossing is not numbers hand-typed into the game that reads it */
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
    /* zoom means nothing alone, overFit is how much tighter than the map since the exporter has no canvas */
    { id: 1, name: 'over_the_coach', anchor: 'coach_post', dx: -12, dy: -20, zoom: 2.5, overFit: 2.36, entry: true },
    { id: 2, name: 'wide_on_the_coach', anchor: 'coach_post', dx: 0, dy: 0, zoom: 1, overFit: 1.18 },
  ],
  framingNext: 2,
  /* a named set so python iterates instead of hard-coded strings; membership only, ordered is a rack */
  sets: [{ id: 1, name: 'the_stations', label: 'the stations', members: ['coach_post', 'the_yard'] }],
  setNext: 2,
  /* an ordered rack: slot numbers are not array positions, and slot 2 is absent on purpose to prove it */
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
  /* one name over several placements with at most one visible, so python never switches the others off */
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

/* THE DOOR'S TARGET IS FOUND, NEVER NAMED. Every door below arrives on a map
 * this file does not own, and the publish gate refuses a door whose target
 * anchor is not really there. Naming one couples this suite to whatever that
 * map happens to carry and breaks it the day somebody renames an anchor, which
 * is the one rename the tool exists to make safe. So: take a real name off the
 * target if it has one, and otherwise send the doors at a map nobody has
 * painted, which the gate warns about instead of refusing. */
const doorTarget = 'hub'
const liveAnchor = await one(
  `select a.name from anchors a join maps m on m.id = a.map_id where m.slug = $1 order by a.name limit 1`,
  [doorTarget],
)
for (const ev of doc.events) {
  if (ev.kind !== 'door' || ev.to !== doorTarget) continue
  if (liveAnchor) ev.toAnchor = liveAnchor.name
  else {
    ev.to = 'zz-no-such-map'
    ev.toAnchor = ''
  }
}
console.log(
  liveAnchor
    ? `  note  doors arrive at ${doorTarget}."${liveAnchor.name}", found rather than named`
    : `  note  ${doorTarget} carries no anchors, so the doors point at a map nobody has painted`,
)

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
  const pier = back.events.find((e) => e.name === 'the_pier')
  eq('a drawn area survives the save with every corner it was given', pier?.poly, doc.events[5].poly)
  /* the ceiling is enforced in the editor and nowhere else, so this is what
   * says a large radius is not quietly clipped on the way through. */
  eq('a radius past the 64 the editor once clamped to survives the save', pier?.r, 220)
  /* two points store as no shape, checked here too since putDoc takes a raw POST with no mask.ts in front */
  eq('a two-point area is refused rather than stored', back.events.find((e) => e.name === 'the_half_shape')?.poly, undefined)
  eq('a drawn area remembers that drawing is the mode it is in', pier?.shape, 'poly')
  /* all three shapes come back from postgres; an upsert that nulls the others loses the drawing */
  const switched = back.events.find((e) => e.name === 'the_switched_place')
  eq('switching to a circle keeps the drawn area', switched?.poly, doc.events[7].poly)
  eq('switching to a circle keeps the box too', switched?.rect, [22, 12, 30, 20])
  eq('and the mode it was switched to is what comes back', switched?.shape, 'circle')

  /* a drawn zone on a door: three gates keyed off kind === region stored the points and dropped the mode */
  const shed = back.events.find((e) => e.name === 'the_shed_door')
  eq('a door keeps the doormat it was drawn', shed?.poly, doc.events[8].poly)
  eq('and remembers that drawing is the mode it is in', shed?.shape, 'poly')
  const counter = back.events.find((e) => e.name === 'the_counter')
  eq('a post keeps the floor beside it that it was drawn', counter?.poly, doc.events[9].poly)
  eq('and the mode survives on a post too', counter?.shape, 'poly')
  eq('with the stand-at inside it and the heading beside it', [counter?.stand, counter?.facing], [[14, 36], 'north'])

  /* switching a drawn door to a post keeps the mode, so the next save does not read it back as a circle */
  const swap = JSON.parse(JSON.stringify(doc))
  swap.events.find((e) => e.name === 'the_shed_door').kind = 'post'
  await putDoc(map.id, JSON.stringify(swap))
  const afterSwap = JSON.parse(await getDoc(map.id)).events.find((e) => e.name === 'the_shed_door')
  eq('a drawn zone survives its anchor changing kind', afterSwap?.poly, doc.events[8].poly)
  eq('and so does the mode that says the drawing is live', afterSwap?.shape, 'poly')
  await putDoc(map.id, JSON.stringify(doc))
  eq(
    'and it is a door again with its zone intact',
    JSON.parse(await getDoc(map.id)).events.find((e) => e.name === 'the_shed_door')?.shape,
    'poly',
  )
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
  /* face names: the planner resolved each to an integer and threw it away, so only numbers ever shipped */
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
  /* what api.mjs writes into assets.json, in one place so the refusal below is about its own anchor */
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
    // the scene goes in, because the painted extent is measured off the bytes
    // that ship rather than read off a column describing the dropped file
    images: { 'levels.png': levelsPNG, 'scene.png': scenePNG },
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

  /* the box is not optional: the game's anchors.ts tests a region by rect and has no polygon test */
  const shippedPier = (shipped.anchors || []).find((a) => a.name === 'the_pier')
  eq('published drawn area, corner for corner', shippedPier?.poly, doc.events[5].poly)
  eq('and the box round it, which is what the running game can actually test', shippedPier?.rect, [6, 26, 34, 40])
  eq('published radius past the old 64 cap', shippedPier?.r, 220)
  eq('and the bundle says the drawn area is the shape that is live', shippedPier?.meta?.shape, 'poly')
  /* AND THE HALF SHAPE REACHES THE BUNDLE AS A PLAIN CIRCLE. It is still a
   * region and still has a radius; what it does not have is a shape it never
   * had, silently invented somewhere between the form and the game. */
  eq(
    'a two-point area never becomes a shape downstream either',
    (shipped.anchors || []).find((a) => a.name === 'the_half_shape')?.poly,
    undefined,
  )
  eq(
    'and it ships no box it never had either',
    (shipped.anchors || []).find((a) => a.name === 'the_half_shape')?.rect,
    undefined,
  )

  /* contains() tests rect before radius, so a dormant rect in the bundle silently beats the chosen circle */
  const shippedSwitched = (shipped.anchors || []).find((a) => a.name === 'the_switched_place')
  eq('a region switched back to a circle ships no box', shippedSwitched?.rect, undefined)
  eq('and ships no drawn area either', shippedSwitched?.poly, undefined)
  eq('while the circle it was switched to is intact', shippedSwitched?.r, 9)
  eq('and the mode rides along so a later reader can tell', shippedSwitched?.meta?.shape, 'circle')

  /* publish.mjs carries its own anchorShape copy, and that copy answered circle for every kind but region */
  const shippedShed = (shipped.anchors || []).find((a) => a.name === 'the_shed_door')
  eq('a door ships the doormat it was drawn', shippedShed?.poly, doc.events[8].poly)
  eq('and the box round it, corner for corner', shippedShed?.rect, [24, 34, 36, 44])
  eq('and says the drawing is the live shape', shippedShed?.meta?.shape, 'poly')
  const shippedCounter = (shipped.anchors || []).find((a) => a.name === 'the_counter')
  eq('a post ships the floor beside it', shippedCounter?.poly, doc.events[9].poly)
  eq('and its box too', shippedCounter?.rect, [8, 34, 22, 42])
  eq('with the stand-at and the heading beside them', [shippedCounter?.stand, shippedCounter?.facing], [[14, 36], 'north'])

  const sp = (shipped.paths || []).find((p) => p.name === 'the_approach')
  eq('published route', sp?.points, doc.paths[0].points)
  eq('published timing mark', sp?.marks, [{ at: 1, name: 'the_line_ends' }])
  const sf = (shipped.framings || []).find((f) => f.name === 'over_the_coach')
  eq('published shot', [sf?.anchor, sf?.dx, sf?.dy, sf?.zoom], ['coach_post', -12, -20, 2.5])
  eq('published entry framing', sf?.entry, true)

  /* two exporters write these and have diverged before: both dropped placement and an intent went dead */
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

  /* the game never reads the array, only the anchor's meta bag: meta.framings[name] then meta.framing */
  eq('the shot is on the anchor the camera reads it off', pa?.meta?.framings?.over_the_coach, {
    zoom: 2,
    dx: -12,
    dy: -20,
  })
  eq('a second shot on the same anchor sits beside it', pa?.meta?.framings?.wide_on_the_coach, { zoom: 1, dx: 0, dy: 0 })
  /* look_at asks with no name and every miss falls here, so named shots without a default is a dead camera */
  eq('the entry shot is the anchor default', pa?.meta?.framing, { zoom: 2, dx: -12, dy: -20, name: 'over_the_coach' })
  /* MERGED, NOT SWAPPED IN. A real map's anchor already carries docId
   * and derived, and the game writes derived itself, so a projection that
   * replaced the bag would take both out. */
  eq('the bag that was already there is still under it', pa?.meta?.docId, 1)
  /* an anchor with no shots grows no camera, and area mode rides the bag because nothing else crosses here */
  eq('an anchor with no shot on it grows no camera', (shipped.anchors || []).find((a) => a.name === 'the_yard')?.meta, {
    docId: 2,
    shape: 'rect',
  })

  /* the bag is not handed back whole, or a leftover framing key ships as a camera nobody can delete */
  const yardMeta = (await one(`select meta from anchors where map_id = $1 and name = 'the_yard'`, [map.id])).meta
  await q(`update anchors set meta = $2::jsonb where map_id = $1 and name = 'the_yard'`, [
    map.id,
    JSON.stringify({ docId: 2, framings: { ghost: { zoom: 3, dx: 0, dy: 0 } }, framing: { zoom: 3, dx: 0, dy: 0, name: 'ghost' }, variants: { gone: {} } }),
  ])
  const ghosted = await publishBundle(SLUG, {
    mapJson: bundleMap,
    assetsJson: pubAssets,
    images: { 'levels.png': levelsPNG, 'scene.png': scenePNG },
    files: new Map(),
  })
  const ghostRow = await publishedMap(SLUG)
  const ghostShipped = JSON.parse((await store().get(ghostRow.blob_prefix + 'map.json')).toString('utf8'))
  eq(
    'a camera left in the bag with no shot behind it is cleared rather than re-shipped',
    (ghostShipped.anchors || []).find((a) => a.name === 'the_yard')?.meta,
    { docId: 2 },
  )
  ghosted.version > pub.version ? ok(`the clearing publish went out as v${ghosted.version}`) : no('the clearing publish did not write a version')
  await q(`update anchors set meta = $2::jsonb where map_id = $1 and name = 'the_yard'`, [map.id, JSON.stringify(yardMeta)])
  /* base_w/base_h is the dropped file not the paint: on the hub 440,320 px past the 265,000 ceiling */
  // read field by field rather than compared whole, because jsonb does not keep
  // the key order it was handed and a shape test would fail on that alone
  eq('published base extent is the paint and not the canvas', [shipped.base?.w, shipped.base?.h, shipped.base?.ox, shipped.base?.oy], [
    PAINT.w,
    PAINT.h,
    PAINT.ox,
    PAINT.oy,
  ])
  eq(
    'and the row carries the same four numbers the bundle does',
    Object.values(await one('select paint_w, paint_h, paint_ox, paint_oy from maps where id = $1', [map.id])),
    [PAINT.w, PAINT.h, PAINT.ox, PAINT.oy],
  )
  /* a bundle that has left the platform should know where it came from, because
   * twelve islands means twelve authors and a file on a cdn has no row behind it */
  shipped.provenance?.owner && shipped.provenance?.publishedAt && shipped.provenance?.version === pub.version
    ? ok(`published provenance ${shipped.provenance.owner} v${shipped.provenance.version}`)
    : no(`provenance missing or wrong: ${JSON.stringify(shipped.provenance)}`)

  const shippedAssets = JSON.parse((await store().get(row.blob_prefix + 'assets.json')).toString('utf8'))
  const byId = (id) => (shippedAssets.assets || []).find((a) => a.id === id)
  eq('published placement name', byId('a1')?.name, 'the_coach')
  /* names index like art: slot 0 is the placement's own, and putting them in look 0 would overwrite it */
  eq('published look names, indexed exactly as art is', byId('a1')?.lookNames, ['standing', 'seated'])
  /* THE RESOLVED CONDITION ON EACH PLACEMENT. Its own beats the group's; a
   * placement with none inherits the group's, which is the whole reason the
   * carrier could not only be the placement. */
  eq('a placement keeps its own condition', byId('a5')?.when, 'flag("banner_hung")')
  eq('and one with none inherits the condition on its group', byId('a6')?.when, 'year >= 2')

  /* readAnchors takes a fixed field list and copies meta whole, so an array at the top has no reader */
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

  /* a set silently one short reads as complete downstream, so it is refused here where it costs a retry */
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

  /* what a member's python reads, keyed by the typed name, booted in-process so it tests the working tree */
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
      eq('a reader looks a set up by the name its author typed', body.sets?.the_stations, {
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
  // measured against the LAST publish rather than the first, because the meta
  // clearing fence above deliberately writes a version of its own
  after.version === ghosted.version
    ? ok(`still at v${ghosted.version}, so nothing was half written`)
    : no(`version moved to ${after.version}`)

  // ---- 5. the water between the islands -----------------------------------
  /* a berth is off the painting so no anchor can hold one; since 019 a point is a mark naming its island */
  /* two overlapping runs wiped the one world row and both reported green, so withWorld pins one client */
  await withWorld(async (wc) => {
  // every read and every write in this section runs on the one pinned client the
  // lock is held on, so a second runner waits instead of reading a half-finished
  // ocean as its baseline
  const saveWorld_ = (d) => saveWorld(d, wc)
  const getWorld_ = () => getWorld(wc)
  const worldBefore = await getWorld_()
  /* a verify run once left sunken_bell_buoy on the live world, so this asks before the fixture is written */
  worldBefore.marks.some((m) => m.name === 'sunken_bell_buoy')
    ? no('the bell buoy is back on the live ocean, so something is leaking test marks into it')
    : ok('the live ocean carries no test residue')
  try {
    const saved = await saveWorld_({
      w: 4096,
      h: 4096,
      home: 'zz_verify_isle',
      places: [
        {
          name: 'zz_verify_isle',
          // the kebab roster id, not the name: without it every island stays misty and no visit is counted
          place: 'verify-yard',
          map: SLUG,
          title: 'The Verify Yard',
          x: 800,
          y: 600,
          /* one chart unit is one painting pixel: the hub's 128x119 box over 688x640 put its berth inland */
          w: W,
          h: H,
          state: 'available',
          // two radii, and this tool had one under the other one's name
          discover: 240,
          release: 900,
        },
        // negative on purpose: the sea is centred on the hub, so half of it is negative and was unstorable
        { name: 'zz_verify_rumour', map: '', title: '', x: 2200, y: -1400, w: 64, h: 64, state: 'rumour', discover: 300 },
      ],
      regions: [{ name: 'zz_the_shallows', kind: 'shallow', rect: [700, 500, 1100, 900] }],
      /* a berth is its own row naming its island, because no anchor can express a point outside the canvas */
      marks: [
        /* the run-in is a field, not list order, where a spare dock became what the hull steers at */
        {
          name: 'zz_verify_dock',
          kind: 'berth',
          x: 880,
          y: 700,
          facing: 'north',
          at: 'coach_post',
          island: 'zz_verify_isle',
          label: 'The Verify Dock',
          approach: { x: 940, y: 760 },
        },
        /* a second berth on the same island is inert, and must not become the run-in the hull aims at */
        { name: 'zz_verify_spare', kind: 'berth', x: 700, y: 500, island: 'zz_verify_isle', label: 'The Spare' },
        { name: 'zz_north_turn', kind: 'waypoint', x: 1600, y: 200, r: 50 },
      ],
    })
    const readBack = await getWorld_()
    const isle = readBack.places.find((p) => p.name === 'zz_verify_isle')
    const dock = readBack.marks.find((m) => m.name === 'zz_verify_dock')
    /* A PLACE CARRIES NO POINT AT ALL, and that is the fence: cleanPlace
     * dropping the nesting is what stops a leftover berth riding along beside
     * the real one, where nothing says which of the two the game read. */
    eq('an island carries no point of its own', [isle?.berth, isle?.approach], [undefined, undefined])
    // field by field rather than whole, because this one came back out of jsonb
    // and postgres does not keep the key order an object went in with
    eq(
      'a berth exists in world space and says whose it is',
      [dock?.x, dock?.y, dock?.facing, dock?.at, dock?.island],
      [880, 700, 'north', 'coach_post', 'zz_verify_isle'],
    )
    eq('and a point in open water belongs to nobody', readBack.marks.find((m) => m.name === 'zz_north_turn')?.island, undefined)
    // the second point survives the round trip nested, which is what makes it an
    // authored fact rather than a consequence of where it sat in the list
    eq('a berth carries its own run-in', dock?.approach, { x: 940, y: 760 })
    eq('and a spare berth beside it is not one', readBack.marks.find((m) => m.name === 'zz_verify_spare')?.approach, undefined)
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

    /* the game gates on Array.isArray(slots), so answering with places silently discarded the composition */
    const comp = await composition()
    Array.isArray(comp.slots) && !comp.places
      ? ok('the ocean leaves as slots, the key the game gates the whole fetch on')
      : no('the composition still answers with places')
    const slot = comp.slots.find((s) => s.place === 'verify-yard')
    /* at is the painting's centre not the chart's corner, which put every island half a footprint out */
    eq('the slot position is the painting"s centre', slot?.at, {
      x: 800 + PAINT.ox + PAINT.w / 2,
      y: 600 + PAINT.oy + PAINT.h / 2,
    })
    /* the painted extent, not the canvas: off the canvas the hub's radius is 41 percent too generous */
    eq('the footprint is the painting', slot?.footprint, { w: PAINT.w, h: PAINT.h })
    /* base_ox || base_oy suppressed a legitimate 0,0, and absent means centred to the game */
    eq('and where it sits inside its canvas', slot?.origin, { x: PAINT.ox, y: PAINT.oy })
    eq('the canvas beside it', slot?.canvas, { w: W, h: H })
    eq('and what it really costs to hold', slot?.placements, doc.assets.length)
    /* the reading side reads slot.berth thirty times, so 019 changed where a point is authored, not what crosses */
    eq('the free-standing berth crosses as that slot"s berth', slot?.berth, {
      name: 'zz_verify_dock',
      x: 880,
      y: 700,
      facing: 'north',
      // without this second point sail.ts never runs its two-stage berthing and every arrival is nose-in
      approach: { x: 940, y: 760 },
      at: 'coach_post',
    })
    /* AND EVERY POINT IS STILL ON THE WIRE UNDER `marks`, including the one
     * folded into the slot above, because the sail loop that grows routes will
     * want the whole list and not the one dock per island. */
    eq('every point crosses as well, by name', (comp.marks || []).map((m) => m.name).sort(), [
      'zz_north_turn',
      'zz_verify_dock',
      'zz_verify_spare',
    ])
    /* FOUR NUMBERS AGAINST A READER THAT WANTS FOUR KEYS is the quietest failure
     * on this endpoint: every comparison is against undefined and false, so no
     * region ever matches and nothing anywhere is raised. */
    eq('a sea region crosses as a box', comp.regions.find((r) => r.name === 'zz_the_shallows')?.rect, {
      x: 700,
      y: 500,
      w: 400,
      h: 400,
    })
    /* home stores a python name and the game matches the kebab id; isName bars a hyphen, so translate here */
    eq('and the run starts at a slot the game can resolve', comp.home, { slot: 'verify-yard' })

    /* a consumer refuses to resume when version moves, so bumping it every save wipes everybody's position */
    const v1 = (await getWorld_()).version
    await saveWorld_({ w: 4096, h: 4096, home: 'zz_verify_isle', places: saved.places, regions: saved.regions })
    eq('a save that changed nothing leaves the world version alone', (await getWorld_()).version, v1)
    await saveWorld_({
      w: 4096,
      h: 4096,
      home: 'zz_verify_isle',
      places: saved.places.map((q) => (q.name === 'zz_verify_isle' ? { ...q, x: 810 } : q)),
      regions: saved.regions,
    })
    const v2 = (await getWorld_()).version
    v2 === v1 + 1
      ? ok('and moving an island counts it up, which is what refuses a stale position')
      : no(`the version did not move: ${v1} then ${v2}`)

    /* w, h and home are out: w/h never reach composition(), home only answers when no position is saved */
    const placesNow = (await getWorld_()).places
    await saveWorld_({ w: 8192, h: 8192, home: '', places: placesNow, regions: saved.regions })
    eq('resizing the chart and clearing home leave the version alone', (await getWorld_()).version, v2)
    await saveWorld_({ w: 4096, h: 4096, home: 'zz_verify_isle', places: placesNow, regions: saved.regions })
    eq('and putting them back does too', (await getWorld_()).version, v2)

    /* an absent key is not an empty one: a subset POST wiped every island and sea region and got a 200 */
    const before = await getWorld_()
    await saveWorld_({ marks: before.marks })
    const kept = await getWorld_()
    eq('a save that mentions no places keeps them', kept.places.length, before.places.length)
    eq('and keeps the sea regions', kept.regions.length, before.regions.length)
    eq('and keeps the size of the ocean', [kept.w, kept.h], [before.w, before.h])
    eq('and keeps where a run starts', kept.home, before.home)

    /* no precondition means a stale tab wipes every island since its snapshot, and a lock cannot fix it */
    let staleRefused = ''
    try {
      await saveWorld_({ ...kept, updatedAt: kept.updatedAt - 1000 })
    } catch (e) {
      staleRefused = e.message
    }
    staleRefused.includes('moved while this page was open')
      ? ok('a save built on a snapshot the row has moved past is refused')
      : no(`a stale document overwrote the ocean: ${staleRefused || 'no error'}`)
    const fresh = await getWorld_()
    await saveWorld_({ ...fresh, updatedAt: fresh.updatedAt })
    ok('and the stamp the row actually holds saves')

    /* severity is the consumer's: any fault makes loadComposition bin the whole document, warning or not */
    const refuses = async (what, doc, needle) => {
      let msg = ''
      try {
        await saveWorld_(doc)
      } catch (e) {
        msg = e.message
      }
      msg.includes(needle) ? ok(what) : no(`${what}: got ${msg || 'no error'}`)
    }
    await refuses(
      'a slot holding no map and reading as anything but a rumour is refused',
      { w: 4096, h: 4096, places: [{ name: 'zz_liar', map: '', x: 10, y: 10, w: 8, h: 8, state: 'available' }], regions: [] },
      'only honest state',
    )
    await refuses(
      'and a slot holding a map that still reads as a rumour is refused, which nothing checked at all',
      { w: 4096, h: 4096, places: [{ name: 'zz_shy', map: SLUG, x: 10, y: 10, w: W, h: H, state: 'rumour' }], regions: [] },
      'still reads as a rumour',
    )
    await refuses(
      'the same map placed twice is refused, because the game discards the whole ocean over it',
      {
        w: 4096,
        h: 4096,
        places: [
          { name: 'zz_here', map: SLUG, x: 10, y: 10, w: W, h: H, state: 'misty' },
          { name: 'zz_there', map: SLUG, x: 90, y: 90, w: W, h: H, state: 'misty' },
        ],
        regions: [],
      },
      'placed twice',
    )
    await refuses(
      'and a stretch of water taking an island name is refused, because python has one namespace',
      {
        w: 4096,
        h: 4096,
        places: [{ name: 'zz_reach', map: '', x: 10, y: 10, w: 8, h: 8, state: 'rumour' }],
        regions: [{ name: 'zz_reach', kind: 'sailable', rect: [0, 0, 10, 10] }],
      },
      'one namespace',
    )

    /* home was admitted on being a legal identifier, so deleting the island it names passed clean */
    const homeless = await saveWorld_({
      w: 4096,
      h: 4096,
      home: 'zz_sunk_isle',
      places: [{ name: 'zz_still_here', map: '', x: 10, y: 10, w: 8, h: 8, state: 'rumour' }],
      regions: [],
      marks: [],
    })
    homeless.warnings.some((w) => w.includes('zz_sunk_isle') && w.includes('where a run starts'))
      ? ok('a home naming an island nobody has placed is named at the save')
      : no('home pointed at nothing and nobody said so')
    const unspellable = await saveWorld_({
      w: 4096,
      h: 4096,
      home: 'zz_still_here',
      places: [{ name: 'zz_still_here', map: '', x: 10, y: 10, w: 8, h: 8, state: 'rumour' }],
      regions: [],
      marks: [],
    })
    unspellable.warnings.some((w) => w.includes('nothing the game can spell it with'))
      ? ok('and a home carrying neither a place id nor a map says it will not be sent')
      : no('a home the game cannot resolve passed without a word')
    eq('and it really is not sent', (await composition()).home, undefined)

    /* radOf answers east, south and north and sends the rest to west, so all four diagonals collapse */
    const skew = await saveWorld_({
      w: 4096,
      h: 4096,
      home: '',
      places: [{ name: 'zz_skew_isle', map: '', x: 100, y: 100, w: 64, h: 64, state: 'rumour', discover: 900 }],
      regions: [],
      marks: [{ name: 'zz_skew_dock', kind: 'berth', x: 140, y: 140, facing: 'north-west', island: 'zz_skew_isle' }],
    })
    skew.warnings.some((w) => w.includes('north-west') && w.includes('point west'))
      ? ok('a berth aimed at a diagonal is named at the save')
      : no('a diagonal berth heading passed without a word')
    eq('and the diagonal does not cross, because absent and west are the same hull', (await composition()).slots[0]?.berth?.facing, undefined)
    eq('the row keeps what the author typed, so nothing is lost', (await getWorld_()).marks[0]?.facing, 'north-west')

    /* A composition that cannot work is refused where it is written, naming
     * what is wrong, rather than found by a student sailing into nothing. */
    let worldRefused = ''
    try {
      await saveWorld_({
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

    /* a berth outside the discovery radius offers a dock before the island exists, measured on berthOf */
    const far = await saveWorld_({
      w: 4096,
      h: 4096,
      places: [{ name: 'zz_far', map: '', x: 100, y: 100, w: 8, h: 8, state: 'rumour', discover: 10 }],
      regions: [],
      marks: [{ name: 'zz_far_dock', kind: 'berth', x: 900, y: 900, island: 'zz_far' }],
    })
    far.warnings.some((w) => w.includes('the dock is offered before the island is'))
      ? ok('a berth outside its island"s discovery radius is warned about')
      : no('an unreachable berth passed without a word')

    /* nesting could not express this: a name can dangle now, so a berth on no island is named at the save */
    const orphan = await saveWorld_({
      w: 4096,
      h: 4096,
      places: [{ name: 'zz_far', map: '', x: 100, y: 100, w: 8, h: 8, state: 'rumour', discover: 10 }],
      regions: [],
      marks: [{ name: 'zz_lost_dock', kind: 'berth', x: 120, y: 120, island: 'zz_sunk_isle' }],
    })
    orphan.warnings.some((w) => w.includes('zz_sunk_isle'))
      ? ok('a berth tied to an island that is not there is named at the save')
      : no('a berth pointed at nothing and nobody said so')

    /* the corner a leg turns at belongs to no island, so without a mark it is a constant typed into the game that reads it */
    const marked = await saveWorld_({
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
    const readMarks = (await getWorld_()).marks
    const wp = readMarks.find((m) => m.name === 'zz_north_passage')
    eq('the waypoint survives the save', [wp?.kind, wp?.x, wp?.y, wp?.facing, wp?.r], ['waypoint', 1200, 400, 'north', 60])
    eq('a kind the author narrowed is kept', readMarks.find((m) => m.name === 'zz_deep_water')?.kind, 'anchorage')
    /* BERTH IS THE FALLBACK, not `waypoint`. Everything on the water is a berth
     * unless somebody deliberately narrowed it, so a kind this file has never
     * heard of lands on the word the category is named for. */
    eq('a kind nothing recognises falls back to a berth', readMarks.find((m) => m.name === 'zz_old_approach')?.kind, 'berth')

    /* ONE NAMESPACE, because python has one. A reader calls sail_to("x") and
     * never says which list to look in, so a mark sharing a name with an island
     * is a call whose answer depends on which lookup runs first. */
    let clash = ''
    try {
      await saveWorld_({
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

    /* the world page never posts this field, so treating silence as empty wipes every dock on one drag */
    await saveWorld_({ w: 4096, h: 4096, places: [], regions: [] })
    eq('a save that never mentions berths keeps them', (await getWorld_()).marks.length, 3)

    /* /api/v1 must need no account: a browser with no login is what asks where the islands are */
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
      eq('a reader looks a berth up by the name its author typed', flat.marks?.zz_north_passage, {
        kind: 'waypoint',
        x: 1200,
        y: 400,
        facing: 'north',
        // and the words a player is shown for it, which the route has to carry:
        // an island holding only the address prints `zz_north_passage` at somebody
        label: 'the north passage',
        // which island it belongs to, so a reader that has routed somewhere can
        // tell what it arrived at without fetching the whole composition
        island: '',
        at: '',
        /* arrive tolerance is not optional: a hull moves in floats, so an exact-pixel test never fires */
        r: 60,
      })
      /* a bound berth also answers to its island's name, so a reader need not know what the dock was called */
      await saveWorld_({
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
        // zero, which is the honest answer for a point nobody set a tolerance
        // on, and it means the caller decides rather than the route guessing
        r: 0,
      })
      eq('and the berth is still reachable by the name it was given', aliased.marks?.zz_alias_dock?.x, 360)

      /* 022 dropped check (id = 1), so /api/v1/world is pinned to row 1 by a constant nobody can move */
      const mate = await one(
        `insert into users (email, password_hash) values ('zz-verify-stranger@example.invalid', 'x')
         on conflict (email) do update set email = excluded.email returning id`,
      )
      try {
        const theirs = await worldIdFor(mate.id)
        theirs !== GAME_WORLD
          ? ok(`a second account gets an ocean of its own, row ${theirs}`)
          : no('a stranger was handed the game"s own world row')
        eq('and asking twice does not make a second one', await worldIdFor(mate.id), theirs)
        /* AND THE GAME'S OWN ROW IS STILL RESOLVED BY THE CONFIGURED ACCOUNT
         * RATHER THAN BY WHOEVER ASKS FIRST. `game` is the caller's answer to
         * "is this the account OCEAN_OWNER names", which a store cannot read. */
        eq('the account the game reads is still row 1', await worldIdFor(mate.id, { game: true }), GAME_WORLD)

        const oursBefore = await getWorld_()
        await saveWorld(
          {
            w: 2048,
            h: 2048,
            home: '',
            places: [{ name: 'zz_their_isle', map: '', x: 10, y: 10, w: 64, h: 64, state: 'rumour', discover: 300 }],
            regions: [],
            marks: [{ name: 'zz_their_berth', kind: 'berth', x: 40, y: 40, island: 'zz_their_isle', label: 'Their Berth' }],
          },
          null,
          theirs,
        )
        const oursAfter = await getWorld_()
        eq('a stranger saving their ocean leaves ours alone', [oursAfter.version, oursAfter.places.length], [
          oursBefore.version,
          oursBefore.places.length,
        ])

        /* THE GAME'S READ IS UNCHANGED BY ONE BYTE, which is the only promise
         * this item makes to the other repo. Asked through the real route with
         * no cookie, the way a browser asks it. */
        const still = await (await fetch(`http://127.0.0.1:${PORT}/api/v1/world/marks`)).json()
        eq('/api/v1/world still answers the game"s own ocean', Object.keys(still.marks).sort(), [
          'zz_alias_dock',
          'zz_alias_isle',
        ])

        // and theirs is fetchable at an address of its own, or an ocean nobody
        // can read is a drawing
        const pub = (await getWorld(undefined, theirs)).pubId
        eq('a stranger"s ocean resolves back from its public address', await worldByPubId(pub), theirs)
        const mine = await (await fetch(`http://127.0.0.1:${PORT}/api/v1/worlds/${pub}`)).json()
        eq('and their engine reads it in the same words ours does', mine.slots?.length, 1)
        const theirMarks = await (await fetch(`http://127.0.0.1:${PORT}/api/v1/worlds/${pub}/marks`)).json()
        eq('their berths come back flat, by name, the way a reader wants them', theirMarks.marks?.zz_their_berth?.x, 40)
        const nowhere = await fetch(`http://127.0.0.1:${PORT}/api/v1/worlds/00000000-0000-0000-0000-000000000000`)
        nowhere.status === 404 ? ok('an ocean nobody owns is a 404 rather than ours') : no(`a bogus address answered ${nowhere.status}`)
      } finally {
        // the world row goes with the account, on delete cascade
        await q('delete from users where id = $1', [mate.id])
      }
    } finally {
      await new Promise((r) => server.close(r))
    }
  } finally {
    /* put the shared row back with the stamp dropped: a restore is an overwrite, not an edit on a snapshot */
    await saveWorld_({ ...worldBefore, updatedAt: 0 }, wc)
    /* the version goes back too: a run counts two changes and the game drops saved positions, 341 to 395 */
    await wc.query('update world set version = $1 where id = $2', [worldBefore.version, GAME_WORLD])
    // the lock is released by withWorld, with the client, so a crash frees it
    // with the connection instead of wedging the next runner
  }
  })

  /* facing is ignored and endsWith re-derives it, where south-west matches west: 17 of the hub's 38 broke */
  {
    const packed = Object.fromEntries(orderedHeadings(['south', 'west', 'south-west', 'north']).map((k) => [k, [`${k}-0.png`]]))
    const asTheGameAsks = (src) => Object.keys(packed).find((k) => src.endsWith(`${k}-0.png`))
    eq('a south-west set is found as south-west and not as west', asTheGameAsks('south-west-0.png'), 'south-west')
    eq('and a plain west set is still found as west', asTheGameAsks('west-0.png'), 'west')
    eq('a heading nothing recognises sorts last, where it cannot shadow one', orderedHeadings(['wobble', 'south-east'])[0], 'south-east')
  }

  /* POST /v2/create-ui-asset, not the GET-only /v2/ui-assets that 405'd; fetch is faked so nothing spends */
  {
    const real = globalThis.fetch
    let sent = null
    globalThis.fetch = async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) }
      return { ok: true, status: 200, text: async () => '{}' }
    }
    try {
      await uiAsset({ description: 'a carved wooden dialogue box', width: 688, height: 384, elements: ['window'], name: 'zz_probe' })
      no('the ui route answered without an id and nothing complained')
    } catch (e) {
      if (e.name === 'NoPixellab') console.log('  skip  no pixellab key on this machine, so the ui request was not built')
      else if (!sent) no(`the ui request never left: ${e.message}`)
      else {
        eq('a piece of chrome is asked for at the route that answers 422 rather than 405', sent.url, 'https://api.pixellab.ai/v2/create-ui-asset')
        // nested, because a flat width and height came back extra_forbidden
        eq('the canvas goes nested, the way the request model takes it', sent.body.image_size, { width: 688, height: 384 })
        eq('and nothing flat rides beside it', [sent.body.width, sent.body.height, sent.body.style_image_base64], [undefined, undefined, undefined])
      }
    } finally {
      globalThis.fetch = real
    }
    /* elements is a plain string list so a typo is paid for; pieces refuses a bare string as not a dict */
    const refused = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return String(e.message || e)
      }
    }
    const badEl = await refused(() => uiAsset({ description: 'x', elements: ['nonsense_widget'] }))
    badEl.includes('no element called')
      ? ok('an element the generator does not have is refused before it is paid for')
      : no(`an unknown element went out to be spent on: ${badEl || 'no error'}`)
    const badPiece = await refused(() => uiAsset({ description: 'x', pieces: ['panel'] }))
    badPiece.includes('what kind it is')
      ? ok('a name where a shape belongs is refused, naming the three shapes there are')
      : no(`a bare string went out as a shape template: ${badPiece || 'no error'}`)
  }

  /* the route posted the author's sentence raw with ui.mjs unread; 240 generations went on two pieces */
  {
    const gt = pieceType('dialogue_box')
    const st = pieceType('pip')
    const style = chromeStyle('dialogue_box')
    style && style.base64
      ? ok(`the style reference is picked by type and read off disk: ${style.file}, ${style.w}x${style.h}`)
      : no('no reference art for dialogue_box, so the one lever that matches the palette is missing')
    // a small mark is not a panel and must not be handed a panel to match
    chromeStyle('pip')?.file !== style?.file
      ? ok('a sheet of small marks takes a different reference from a drawn frame')
      : no('every type was handed the same reference picture')

    // the shelf goes over, because the second piece has to match the first
    const shelf = [{ name: 'binder', type: 'panel', status: 'ready', description: 'a worn oak binder with brass corners' }]
    const asked = chromePrompt({ ask: 'a wooden dialogue box', t: gt, width: 688, height: 384, shelf, style })
    const carries = (what, needle) =>
      asked.includes(needle) ? ok(`the router is told ${what}`) : no(`the router was NOT told ${what}: "${needle}" is missing`)
    carries('which type this is', 'THE PIECE TYPE IS "dialogue_box"')
    carries("the type's own caution, verbatim", gt.caution)
    carries('that ornament belongs in the corners', 'ORNAMENT GOES IN THE CORNERS')
    carries('that an edge repeats and cannot hold a motif', 'THE EDGES REPEAT')
    carries('that the middle has to stay plain enough for text', 'THE MIDDLE HOLDS TEXT')
    carries('the anchor that smeared, so it is a measured failure and not a rule', 'anchor drawn at top centre')
    carries('the canvas it cannot argue with', 'THE CANVAS IS 688 BY 384')
    carries('which way this one stretches', 'stretches on BOTH axes')
    carries('the rectangles the game draws into', '- body (text, required)')
    carries('that the element list forces one centred panel', '"window" element')
    carries('what is already on this shelf', 'binder (panel): a worn oak binder')
    carries('that painted words cannot be read or translated', 'NO LETTERING ANYWHERE')
    carries('to say muted rather than saturated', 'MUTED saturation')
    // and the two fields, because a model that writes the joined sentence can
    // drop the law out of it
    carries('to answer two fields and never the joined sentence', 'never write the joined sentence yourself')

    // a sheet is a different piece and gets a different law, not the ground one
    const sheetAsk = chromePrompt({ ask: 'season tokens', t: st, width: st.w, height: st.h, shelf: [], style: chromeStyle('pip') })
    !sheetAsk.includes('ORNAMENT GOES IN THE CORNERS') && sheetAsk.includes('THIS PIECE IS A SHEET')
      ? ok('a sheet is told it is a grid of faces cut apart, not told a nine-slice law it cannot obey')
      : no('the wrong tier law went to a sheet')
    sheetAsk.includes('fall, winter, spring, spent, ghost')
      ? ok('a sheet is told every face it owes, so they come back at one weight')
      : no('a sheet was asked for without naming its faces')
    /* the count goes in the prompt: eight marks asked for came back twelve, the last four a repeated row */
    sheetAsk.includes('EXACTLY 5, no more and no fewer')
      ? ok('a sheet is told how many marks, which is the number the cut checks against')
      : no('a sheet was asked for with no count in it, so nothing downstream can check what came back')
    /* keep the names out of the prompt: plate_lit went into the subject and came back painted on */
    sheetAsk.includes('DO NOT WRITE THESE NAMES INTO YOUR ANSWER')
      ? ok('and told the names are addresses rather than captions, which is what came back painted once')
      : no('nothing stops the router writing the face names into the subject, which drew them as labels')
    /* THE FLOOR IN THE SHEET BRIEF IS NOT 192. That number is
     * /v2/create-ui-asset's, and saying it to a piece going somewhere else is a
     * lie about the endpoint that will draw it. */
    sheetAsk.includes('both sides start at 192')
      ? no('a sheet was told the panel route floor, which is not the route it goes to')
      : ok('a sheet is not told a floor belonging to the endpoint it does not use')

    /* the router runs on a stub that answers a lazy style field, the way both failed rolls did */
    let sawPrompt = ''
    const fakeThink = async (prompt) => {
      sawPrompt = prompt
      return JSON.stringify({
        result: JSON.stringify({
          subject: 'A carved oak dialogue box with brass corner plates and a worn paper face',
          style: 'chunky pixels, muted oak and brass palette, dark brown outline, lit from the upper left, shaded right',
          palette: 'muted oak brown and tarnished brass',
          note: 'matched the shipped dialogue box',
        }),
      })
    }
    const plan = await chromePlan({ ask: 'a wooden dialogue box', t: gt, width: 688, height: 384, shelf, style, think: fakeThink })
    plan.routed ? ok('the router wrote the prompt') : no(`the router did not run: ${plan.why || 'no reason given'}`)
    sawPrompt.includes('ORNAMENT GOES IN THE CORNERS')
      ? ok('and it was handed the constraints on its way in')
      : no('the router ran on a prompt with no constraints in it')
    plan.description.includes('Ornament only in the four corners')
      ? ok('the nine-slice law is attached by code, so a lazy answer cannot drop it')
      : no(`the law fell out of the joined prompt: ${plan.description}`)
    plan.description.includes('fully transparent background') && plan.description.includes('no lettering')
      ? ok('and so do the cut-out and the no-lettering clauses')
      : no(`the code-owned clauses are missing: ${plan.description}`)
    eq('the palette leaves as its own field, the way the endpoint takes it', plan.palette, 'muted oak brown and tarnished brass')

    // a sheet takes no nine-slice law, because there is nothing to nine-slice
    const sheetPlan = await chromePlan({ ask: 'season tokens', t: st, width: 384, height: 384, shelf: [], style, think: fakeThink })
    sheetPlan.description.includes('Ornament only in the four corners')
      ? no('a sheet of loose marks was told to keep its ornament in the corners')
      : ok('a sheet gets no nine-slice clause, because it is never cut into nine')

    /* AND THE PROMPT THE ROUTER WROTE IS THE ONE THAT GETS PAID FOR. Asserted
     * against the request body rather than against the return value, because
     * the return value is not what pixellab is handed. */
    const real = globalThis.fetch
    let body = null
    globalThis.fetch = async (url, init) => {
      body = JSON.parse(init.body)
      return { ok: true, status: 200, text: async () => '{}' }
    }
    try {
      await uiAsset({
        description: plan.description,
        width: 688,
        height: 384,
        palette: plan.palette,
        elements: gt.elements,
        styleImageBase64: style?.base64,
        name: 'zz_probe',
      })
    } catch {
      /* no id in the fake answer, so it gives up before its poll. Expected. */
    } finally {
      globalThis.fetch = real
    }
    if (!body) console.log('  skip  no pixellab key on this machine, so the routed request was not built')
    else {
      body.description === plan.description
        ? ok('the routed prompt is the string that reaches the generator')
        : no('something rewrote the prompt between the router and the wire')
      eq('the palette rides as its own field', body.color_palette, 'muted oak brown and tarnished brass')
      eq('the element list forces one centred panel rather than a kit', body.elements, ['window'])
      body.style_image?.base64 === style?.base64 && body.style_image?.type === 'base64'
        ? ok('the reference goes as a Base64Image, so material transfers alongside the words')
        : no('the style reference never left, so nothing carries the palette of the shipped chrome')
    }

    /* with no planner the words go out unchanged and the answer says so, so a bad prompt differs from none */
    const down = await chromePlan({
      ask: '  a wooden   dialogue box  ',
      t: gt,
      width: 688,
      height: 384,
      shelf,
      style,
      think: async () => {
        throw new NoPlanner('none')
      },
    })
    /* the sentence carries the code-owned tail even when no model is reached, rather than going out bare */
    down.routed === false && down.description.startsWith('a wooden dialogue box.')
      ? ok('with no planner the author own sentence is what is described, unrewritten')
      : no(`the degraded prompt was not the author's own words: ${down.description.slice(0, 120)}`)
    down.description.includes('One single complete piece, centred') && down.description.includes('Ornament only in the four corners')
      ? ok('and the tail code owns rides anyway, because a missing model is not a reason to send a prompt with no rules in it')
      : no(`a degraded prompt went out with no code-owned clauses on it: ${down.description}`)
    down.why?.includes('no claude key') && down.why?.includes('none of the type rules in it')
      ? ok('and the answer says plainly that nobody wrote this prompt, so a worse result has a reason')
      : no(`the degrade was silent: ${down.why || 'nothing said'}`)
    eq('and it names which provider was missing, the way every other degrade does', down.degraded, 'none')
    const relayDown = await chromePlan({
      ask: 'a wooden dialogue box',
      t: gt,
      width: 688,
      height: 384,
      shelf,
      style,
      think: async () => {
        throw new NoPlanner('relay')
      },
    })
    relayDown.why?.includes('no linked machine')
      ? ok('a laptop being closed reads as a closed laptop rather than as a missing key')
      : no(`a relay degrade said the wrong thing: ${relayDown.why}`)
  }

  /* elements decides shape, style_image decides material, words neither, over about 280 generations */
  {
    // the size the body carries has to be one the endpoint will accept, and the
    // maxima do not combine: 688x512 reads as 4:3 and is refused AFTER the money
    // is committed
    const legalCanvasOk = (s) => {
      const g = legalCanvas(s?.width, s?.height)
      return g.ok && s.width >= 192 && s.height >= 192
    }
    const think = async () =>
      JSON.stringify({
        result: JSON.stringify({
          subject: 'A carved walnut frame with rope trim and brass corner rivets',
          style: 'chunky pixels, muted walnut and brass palette, dark brown outline, lit upper left, shaded right',
          palette: 'muted walnut brown and tarnished brass',
          note: 'matched the shipped chrome',
        }),
      })

    /* eight of the twelve grounds fell through an unexamined default, and a default is not a decision */
    const generated = PIECE_TYPES.filter((t) => t.tier !== 'none')
    const refless = generated.filter((t) => !chromeStyle(t.name))
    refless.length
      ? no(`${refless.length} type(s) have no material reference on disk: ${refless.map((t) => t.name).join(', ')}`)
      : ok(`all ${generated.length} generated types name a reference file that exists`, generated.length)
    // and the two named so nobody generates them carry none, rather than a
    // fallback that would read as a decision somebody made
    PIECE_TYPES.filter((t) => t.tier === 'none').every((t) => !t.styleRef && !chromeRef(t.name))
      ? ok('a type nobody may generate carries no reference, so no field on it pretends to be read')
      : no('a type that is never drawn was given reference art')

    /* a ground with no element list is the v3 failure, a kit with the piece cropped off the top */
    const groundless = PIECE_TYPES.filter((t) => t.tier === 'ground' && !(t.elements || []).length)
    groundless.length
      ? no(`${groundless.length} ground(s) send no element list, which is the roll that came back a cropped kit: ${groundless.map((t) => t.name).join(', ')}`)
      : ok('every ground sends an element list, which is the lever that decides one piece against a kit')
    const strayEl = PIECE_TYPES.flatMap((t) => (t.elements || []).filter((e) => !UI_ELEMENTS.includes(e)).map((e) => `${t.name}:${e}`))
    strayEl.length
      ? no(`an element name the generator does not have would reach the handler and be paid for: ${strayEl.join(', ')}`)
      : ok('every element name on the table is one the endpoint actually scaffolds from')
    /* no-elements returns a grid of panels, so a sheet carries none: its own route has no such field */
    PIECE_TYPES.filter((t) => t.tier === 'sheet').every((t) => !t.elements && t.elementsWhy.includes('generate-image-v2'))
      ? ok('a sheet sends no list and names the route with no such field, rather than claiming the panel route would behave')
      : no('a sheet either carries an element list or still says the panel route returns a grid of loose marks')

    /* FOUR TYPES THROUGH THE WHOLE PATH, one per tier plus the two the recipe
     * is written against. What is asserted is the request body, because the body
     * is what is paid for and everything before it is a claim about the body. */
    const wireFor = async (typeName) => {
      const t = pieceType(typeName)
      const style = chromeStyle(typeName)
      const plan = await chromePlan({ ask: 'the piece', t, width: t.w, height: t.h, shelf: [], style, think })
      return {
        t,
        style,
        plan,
        req: uiAssetBody({
          description: plan.description,
          width: t.w,
          height: t.h,
          palette: plan.palette,
          elements: t.elements,
          styleImageBase64: style ? style.base64 : undefined,
          name: typeName,
        }),
      }
    }
    for (const typeName of ['panel', 'dialogue_box', 'plank', 'cover_plate']) {
      const { t, style, req } = await wireFor(typeName)
      const has = (what, cond) => (cond ? ok(`${typeName}: ${what}`) : no(`${typeName}: ${what} · NOT true of the body that would be sent`))
      has('the element list rides, so the shape is forced rather than asked for', JSON.stringify(req.elements) === JSON.stringify(t.elements))
      has('the reference rides as a Base64Image, so the material transfers', req.style_image?.type === 'base64' && req.style_image.base64 === style.base64)
      has(`its material reference is ${t.styleRef}`, style.file === t.styleRef)
      has('the canvas is inside an aspect gate, so it is not refused after the money is committed', legalCanvasOk(req.image_size))
      // the three clauses code owns, which is the whole reason chromeFinal
      // exists: a model that writes the joined sentence can drop any of them
      has('nothing may touch the edge of the image, which is what v3 died of', req.description.includes('nothing touching the edge of the image'))
      has(
        t.tier === 'sheet' ? 'every face is complete and inside the canvas' : 'it is one single complete piece, centred',
        req.description.includes(t.tier === 'sheet' ? 'Every face is drawn complete' : 'One single complete piece, centred'),
      )
      has('it is a cut-out with no lettering on it', req.description.includes('fully transparent background') && req.description.includes('no lettering'))
      if (t.material)
        has(`the interior is named by code as ${t.material}`, req.description.includes(`The surface inside the frame is ${t.material}.`))
      if (t.tier === 'ground') has('the nine-slice law is attached', req.description.includes('Ornament only in the four corners'))
      else has('no nine-slice law on something that is never cut into nine', !req.description.includes('Ornament only in the four corners'))
      has('and the description fits the endpoint ceiling', req.description.length <= 2000)
    }

    /* highlight_edge is drawn round a hole, so a fill-the-centre law is an order it cannot obey */
    {
      const ring = chromeFinal({ subject: 'a ring', style: 'chunky pixels', t: pieceType('highlight_edge') })
      ring.includes('Ornament only in the four corners') &&
      ring.includes('completely empty and fully transparent') &&
      !ring.includes('The middle is one plain surface')
        ? ok('the piece drawn round a hole keeps the corner and edge law and is told its middle is a hole')
        : no(`the ring was told to paint a middle it does not have: ${ring.slice(-260)}`)
      const solid = chromeFinal({ subject: 'a panel', style: 'chunky pixels', t: pieceType('panel') })
      solid.includes('The middle is one plain surface') && !solid.includes('completely empty and fully transparent')
        ? ok('and every other ground still gets the plain middle a sentence prints on')
        : no('the ring clause leaked onto a ground whose middle holds text')
    }

    /* the code-owned clauses sit last, so a long subject loses wood grain and not the rule */
    {
      const long = chromeFinal({ subject: 'walnut '.repeat(600), style: 'chunky pixels, muted', t: pieceType('panel') })
      long.length <= 2000 &&
      long.includes('One single complete piece, centred') &&
      long.includes('The surface inside the frame is plain cream parchment.') &&
      long.includes('Ornament only in the four corners')
        ? ok('a subject long enough to fill the budget loses its own words and never the code-owned tail')
        : no(`the tail was truncated off a long subject: ...${long.slice(-160)}`)
    }
  }

  /* /v2/create-ui-asset only draws panel kits, so six types go to /v2/generate-image-v2 instead */
  {
    const sheets = PIECE_TYPES.filter((t) => t.tier === 'sheet')
    eq('six of the twenty-one types are sheets', sheets.length, 6)
    sheets.every((t) => usesImageEndpoint(t))
      ? ok('every sheet routes to the image endpoint, which is the only one that draws a mark')
      : no(`a sheet still goes to the panel route: ${sheets.filter((t) => !usesImageEndpoint(t)).map((t) => t.name).join(', ')}`)
    PIECE_TYPES.filter((t) => t.tier !== 'sheet').some((t) => usesImageEndpoint(t))
      ? no('a piece of furniture was sent to the image route, which has no element list to force one clean piece out of it')
      : ok('and nothing else does, because the two levers on the panel route are what drew the twelve already on the shelf')

    /* a chip strip is 384x160 and the panel floor is 192, and an empty bottom third repeats a row */
    const wrongGate = sheets.filter((t) => !legalCanvas(t.w, t.h).ok)
    wrongGate.length
      ? ok(`the panel route's floor would refuse ${wrongGate.length} real sheet canvas(es), which is why the gate is chosen by tier`)
      : ok('every sheet canvas happens to clear both gates')
    const badCanvas = sheets.filter((t) => !canvasFor(t, t.w, t.h).ok)
    badCanvas.length
      ? no(`${badCanvas.length} sheet canvas(es) would be refused after the money is committed: ${badCanvas.map((t) => t.name).join(', ')}`)
      : ok('every sheet canvas passes its own route gate before anything is spent')
    /* AND CLEARS 171 ON THE LONG SIDE. Under that the endpoint answers with a
     * GRID OF VARIANTS of one mark, 4 or 16 or 64 of them, rather than one
     * picture, so a sheet asked for small comes back as sixty-four compasses. */
    sheets.every((t) => Math.max(t.w, t.h) >= SHEET_ONE_IMAGE)
      ? ok('and clears the one-image line, so the answer is one canvas rather than a grid of variants')
      : no(`a sheet is small enough to come back as a grid of variants: ${sheets.filter((t) => Math.max(t.w, t.h) < SHEET_ONE_IMAGE).map((t) => t.name).join(', ')}`)
    eq('and a canvas asked for under that line is lifted over it rather than drawn as 64 copies', Math.max(...Object.values(fitSheet(24, 24))), SHEET_ONE_IMAGE)

    const think = async () =>
      JSON.stringify({
        result: JSON.stringify({
          subject: 'Small walnut and brass marks in a row, each a plain silhouette on empty space',
          style: 'chunky pixels, muted walnut and brass palette, dark brown outline, lit upper left, shaded right',
          palette: 'muted walnut brown and tarnished brass',
          note: 'matched the shipped chrome',
        }),
      })
    for (const t of sheets) {
      const style = chromeStyle(t.name)
      const plan = await chromePlan({ ask: 'the marks', t, width: t.w, height: t.h, shelf: [], style, think })
      const req = sheetBody({ description: plan.description, width: t.w, height: t.h, styleImage: style ? { base64: style.base64, w: style.w, h: style.h } : null })
      const has = (what, cond) => (cond ? ok(`${t.name}: ${what}`) : no(`${t.name}: ${what} · NOT true of the body that would be sent`))
      /* additionalProperties is false on both, and this route wants a ReferenceImage not a bare image */
      has(
        "the reference rides as a ReferenceImage with its own size, which is this route's shape",
        req.style_image?.image?.type === 'base64' &&
          req.style_image.image.base64 === style.base64 &&
          req.style_image.size?.width === style.w &&
          req.style_image.size?.height === style.h,
      )
      has('it is cut out, because a mark is laid straight over a painted map', req.no_background === true)
      has('the canvas is the one the type asks for', req.image_size.width === t.w && req.image_size.height === t.h)
      /* AND NO FIELD FROM THE OTHER ROUTE. GenerateImageV2Request sets
       * additionalProperties false, so one `elements` carried across from the
       * panel body is a 422 for the whole call. */
      has('nothing from the panel route rides along, which would be a 422 for the whole call', !('elements' in req) && !('pieces' in req) && !('name' in req) && !('color_palette' in req))
      has('and the description fits the schema ceiling of 2000', req.description.length <= 2000 && req.description.length >= 1)
      // the clauses code owns on this tier, which is what the first two rolls
      // proved a model will not carry on its own
      has('the count rides, which is the number the cut checks against', req.description.includes(`Exactly ${t.faces.length} marks on the canvas`))
      has('no frame around the group, which is what the panel route always drew', req.description.includes('No frame, border, card or panel around the group'))
      has('it is a grid of separate small marks', req.description.includes('A grid of separate small marks'))
      has('no nine-slice law on something that is never cut into nine', !req.description.includes('Ornament only in the four corners'))
    }

    /* A CHIP'S MARKS ARE PLATES, so the flat "nothing sits on a plate" clause and
     * the family it was asked for cannot both be obeyed, and two instructions
     * that contradict is how a generator picks. Same shape as the ring clause. */
    const chipTail = chromeFinal({ subject: 'three round tokens', style: 'chunky pixels', t: pieceType('chip') })
    chipTail.includes('unless the mark itself is a plate')
      ? ok('the sheet whose marks ARE plates is not told to draw nothing on a plate')
      : no('a chip sheet carries two instructions it cannot both obey')

    /* a sheet has no hero, so the cut reads every shape in reading order and refuses rather than invents */
    const sheetPNG = (w, h, blobs) => {
      const px = new Uint8ClampedArray(w * h * 4)
      for (const [x0, y0, bw, bh] of blobs)
        for (let y = y0; y < y0 + bh; y++)
          for (let x = x0; x < x0 + bw; x++) {
            const i = (y * w + x) * 4
            px[i] = 200
            px[i + 1] = 170
            px[i + 2] = 120
            px[i + 3] = 255
          }
      return encodePNG(w, h, px)
    }
    // evenly spaced across the canvas with a margin at both ends, so nothing in
    // these fixtures runs off the right edge and wraps onto the next row
    const row = (n, y, size, w) => Array.from({ length: n }, (_, i) => [Math.round((w - n * size) / (n + 1)) * (i + 1) + i * size, y, size, size])
    const pipT = pieceType('pip')

    const clean = cutFaces(sheetPNG(512, 160, row(5, 50, 60, 512)), pipT)
    clean.why || clean.note
      ? no(`a clean sheet of five was not cut: ${clean.why || clean.note}`)
      : eq('five marks are cut and named in reading order', clean.faces.map((f) => f.name), pipT.faces)
    clean.faces.every((f) => f.kind === 'face')
      ? ok('and each one is a face, which is the kind a consumer cuts OUT rather than draws into')
      : no('a cut came back as some other kind of region')

    /* READING ORDER IS BANDED AND NOT A SORT ON Y. Marks in one row do not share
     * a y: a tick sits lower than a compass of the same height, and a plain sort
     * by y interleaves two rows into nonsense. */
    const jittered = cutFaces(sheetPNG(384, 256, [[30, 20, 60, 60], [150, 32, 60, 60], [270, 18, 60, 60], [30, 150, 60, 60], [150, 162, 60, 60], [270, 148, 60, 60]]), pieceType('pointer'))
    eq('a row whose marks do not share a y still reads left to right', jittered.faces.map((f) => f.name), pieceType('pointer').faces)

    /* a paw print is five shapes sharing no pixel, and when boxes overlap only the union holds each */
    // a ring with a needle floating inside it, which shares no pixel with the
    // ring and whose box sits entirely within the ring's
    const ringed = (x) => [
      [x, 30, 60, 8],
      [x, 82, 60, 8],
      [x, 30, 8, 60],
      [x + 52, 30, 8, 60],
      [x + 26, 56, 10, 10],
    ]
    const paw = cutFaces(sheetPNG(384, 160, [...ringed(20), ...ringed(110), ...ringed(200), ...ringed(290)]), pieceType('cue'))
    paw.found === 4 && !paw.why && !paw.note
      ? ok('a mark drawn in separate pieces is cut as one face, because no rectangle could separate them anyway')
      : no(`a mark in pieces was not merged: found ${paw.found}, ${paw.why || paw.note || 'no reason'}`)

    /* AND THE TWO REFUSALS. One big object is the failure the whole second path
     * exists to get past, and it is what the panel route returned every time. */
    const lump = cutFaces(sheetPNG(512, 160, [[40, 20, 430, 120]]), pipT)
    lump.why.includes('one big object')
      ? ok('a sheet that came back as one big object is refused, naming what it looks like')
      : no(`one big object was cut into faces anyway: ${lump.why || 'no reason'}`)
    const crumbs = cutFaces(sheetPNG(512, 160, Array.from({ length: 24 }, (_, i) => [10 + (i % 12) * 42, 20 + Math.floor(i / 12) * 70, 20, 20])), pipT)
    crumbs.why.includes('not a grid of 5 things')
      ? ok('and so is a picture with far too many shapes on it')
      : no(`a shattered sheet was cut anyway: ${crumbs.why || 'no reason'}`)

    /* a count in the band but not exact names the wrong shape silently: eight asked for, twelve came back */
    const seven = cutFaces(sheetPNG(512, 160, row(7, 50, 50, 512)), pipT)
    seven.faces.length === 7 && seven.faces.every((f) => /^face_\d+$/.test(f.name)) && seven.note.includes('numbered rather than named')
      ? ok('a count that is close but not exact is numbered rather than named, because a wrong name is a silent wrong answer')
      : no(`an inexact count was handed the type's names: ${seven.faces.map((f) => f.name).join(', ')}`)
  }

  // ---- 6. the ui library, and one kit shared across maps -------------------
  /* a box with no marks is wallpaper whose numbers get typed into game source; the marks are the point */
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
    /* A ROPE THAT STRETCHES IS A SMEAR AND A ROPE THAT TILES IS A ROPE, which is
     * what `fill` carries and a bare `bar` cannot: without a direction and a
     * tile rule the reader has to guess both. */
    eq('a fill says which way it grows and whether it tiles', [bar?.axis, bar?.mode], ['right', 'tile'])
    eq('a region keeps the bag its author filled', bar?.meta, { fills: 'left' })
    eq('a region keeps its alignment', read?.regions.find((s) => s.name === 'speaker')?.align, 'left')
    eq('text says what a long option does', read?.regions.find((s) => s.name === 'speaker')?.overflow, 'ellipsis')

    /* refused, not numbered: the name is what a reader holds, and a silent region_3 promises nothing */
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

    /* no default vertical: a person stands on the bottom of the box, and centring leaves them all floating */
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

  /* every ui image draws center / 100% 100% no-repeat, squashing the painting into whatever box */
  eq('the kit names twenty-one types', PIECE_TYPES.length, 21)
  eq('a type nobody named does not resolve', pieceType('wobble_box'), null)

  const GROUND = 'zz_verify_ground'
  const SHEET = 'zz_verify_sheet'
  const CORE = 'zz_verify_core'
  for (const n of [GROUND, SHEET, CORE]) await removeUi(owner.id, n, { core: true })
  /* setUiImage with no crop clears the crop columns and deletes the family from storage, so snapshot all */
  const snapUi = async (name) => {
    const row = await one('select * from ui_assets where owner_id = $1 and name = $2', [owner.id, name])
    if (!row) return null
    const img = row.blob_key ? await store().get(row.blob_key).catch(() => null) : null
    const full = row.full_key ? await store().get(row.full_key).catch(() => null) : null
    return { row, img, full }
  }
  const putUiBack = async (snap) => {
    if (!snap) return
    const { row, img, full } = snap
    if (img && row.blob_key) await store().put(row.blob_key, img, 'image/png')
    if (full && row.full_key) await store().put(row.full_key, full, 'image/png')
    await q(
      `insert into ui_assets
         (owner_id, name, type, title, description, w, h, blob_key, pixellab_id, regions, slices,
          status, core, published, published_at, full_key, crop, crop_note, img_sha)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17::jsonb,$18,$19)
       on conflict (owner_id, name) do update set
         type = excluded.type, title = excluded.title, description = excluded.description,
         w = excluded.w, h = excluded.h, blob_key = excluded.blob_key,
         pixellab_id = excluded.pixellab_id, regions = excluded.regions, slices = excluded.slices,
         status = excluded.status, core = excluded.core, published = excluded.published,
         published_at = excluded.published_at, full_key = excluded.full_key,
         crop = excluded.crop, crop_note = excluded.crop_note, img_sha = excluded.img_sha`,
      [
        owner.id, row.name, row.type, row.title, row.description, row.w, row.h, row.blob_key,
        row.pixellab_id, JSON.stringify(row.regions || []), JSON.stringify(row.slices || {}),
        row.status, row.core, row.published, row.published_at, row.full_key,
        JSON.stringify(row.crop || {}), row.crop_note, row.img_sha,
      ],
    )
  }
  const realDlgSnap = await snapUi('dialogue_box')
  try {
    /* slices are source pixels, the one unit css border-image and Pixi agree on; scale rides along too */
    await createUi({ ownerId: owner.id, name: GROUND, type: 'panel', description: 'a plain paper panel', w: 96, h: 96 })
    await setUiImage(owner.id, GROUND, solidPNG(96, 96, 190, 170, 130), 96, 96)
    const g = await setUiRegions(
      owner.id,
      GROUND,
      [{ name: 'body', kind: 'text', x: 14, y: 14, w: 68, h: 68 }],
      { slice: { top: 12, right: 14, bottom: 13, left: 14 }, scale: 2, fill: true, repeat: { x: 'round', y: 'round' } },
    )
    /* jsonb loses key order, so compare in css order or a stringified test fails and looks like data loss */
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

    /* custom properties at the top level of a stylesheet are a malformed rule: measured cssRules.length 0 */
    back?.css.startsWith(':root {') && /}\s*\n\s*\n\.kit-surface-/.test(back?.css || '')
      ? ok('the custom properties are inside a block, so the whole thing parses instead of nothing')
      : no('the css still opens with a bare declaration, which throws the rule after it away')
    /* solid with no colour inherits currentColor, a 49 pixel black ring once the art token is none */
    back?.css.includes('border-color: transparent;')
      ? ok('the border is transparent, so the study plain arm blanks instead of ringing')
      : no('the emitted rule would draw a solid ring in the plain arm')
    /* var(--kit-art-name) was defined nowhere, so the whole border-image was invalid and dropped to none */
    /* the route answers immutable for a year, so the sha is in the url; renaming is not a workaround */
    back?.css.includes(`var(--kit-art-zz_verify_ground, url('/api/v1/ui/zz_verify_ground/image?v=${(back.sha || '').slice(0, 12)}'))`) && !!back?.sha
      ? ok('and it falls back to the piece own bytes at a versioned url, so an undefined token is not a blank panel')
      : no('the border image still depends on a token nothing defines')

    /* THE CONSTRAINT THAT BREAKS SILENTLY. If the top and bottom insets do not
     * leave a middle, CSS drops to no border image at all and says nothing,
     * which sends the author to the wrong stylesheet. */
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

    /* one job because a family split across jobs drifts in weight and palette; the cut is at import */
    {
      const CUT = 'zz_verify_cut'
      await removeUi(owner.id, CUT, { core: true })
      const marks = new Uint8ClampedArray(512 * 160 * 4)
      pieceType('pip').faces.forEach((_, i) => {
        for (let y = 40; y < 110; y++)
          for (let x = 26 + i * 96; x < 86 + i * 96; x++) {
            const at = (y * 512 + x) * 4
            marks[at] = 190
            marks[at + 1] = 170
            marks[at + 2] = 130
            marks[at + 3] = 255
          }
      })
      await createUi({ ownerId: owner.id, name: CUT, type: 'pip', description: 'five season tokens', w: 512, h: 160 })
      const cut = await setUiImage(owner.id, CUT, encodePNG(512, 160, marks), 512, 160)
      eq('a sheet is not cropped to one hero, because it has no hero to crop to', cut.full_key, '')
      eq('and the cut ran without a complaint', cut.crop_note, '')
      const readBack = await getUiByName(owner.id, CUT)
      eq('a sheet round-trips carrying its faces, named in reading order', readBack.faces.map((f) => f.name), pieceType('pip').faces)
      eq('and each face keeps the rectangle the scan measured', readBack.faces[2], { name: 'spring', x: 218, y: 40, w: 60, h: 70 })
      /* a sheet with no rectangles is wallpaper: a consumer holding the name spent has nothing to ask for */
      readBack.faces.length === pieceType('pip').faces.length
        ? ok('so nothing is owed a hand cut on a sheet that came back the way it was asked for')
        : no(`${pieceType('pip').faces.length - readBack.faces.length} face(s) of the type were never cut`)
      await removeUi(owner.id, CUT, { core: true })
    }

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

    /* core chrome is never overridable and members may only add, or the first dialogue_box wins the name */
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

    /* the kit says dialogue_box, the game mounts dialogue, so the first paste matched no element at all */
    /* dialogue_box is a real drawn piece, so its art is snapshotted and written back at the end */
    await createUi({ ownerId: owner.id, name: 'dialogue_box', type: 'dialogue_box', description: 'the real one', w: 688, h: 384, core: true })
    await setUiImage(owner.id, 'dialogue_box', solidPNG(688, 384, 60, 50, 40), 688, 384)
    const dlg = await setUiRegions(owner.id, 'dialogue_box', [{ name: 'caption', kind: 'text', x: 40, y: 40, w: 200, h: 40 }], {
      slice: { top: 40, right: 40, bottom: 40, left: 40 },
      scale: 2,
      fill: true,
      repeat: { x: 'round', y: 'round' },
    })
    dlg.css.includes('.kit-surface-dialogue {') &&
    dlg.css.includes('--kit-slice-dialogue:') &&
    // the fallback url still names the row, which is right: the ROUTE is keyed
    // by the piece name and only the css handle is translated
    !dlg.css.includes('.kit-surface-dialogue_box') &&
    !dlg.css.includes('--kit-slice-dialogue_box')
      ? ok('the core dialogue box emits the handle the game mounts and not the kit name')
      : no(`the css still names dialogue_box, which the game has no class or token for: ${dlg.css.split('\n')[5] || ''}`)
    /* put the author's piece back, every column and both pictures. A row this
     * file found must survive it unchanged, cut the way it was cut. */
    if (realDlgSnap) {
      await putUiBack(realDlgSnap)
      const kept = await getUiByName(owner.id, 'dialogue_box').catch(() => null)
      kept && kept.status === 'ready'
        ? ok('a piece the author drew survives a verifier run')
        : no("the verifier ate the author's dialogue box again")
      const family = realDlgSnap.row.full_key ? await ownedUiFull(owner.id, 'dialogue_box') : null
      if (realDlgSnap.full)
        family && family.equals(realDlgSnap.full)
          ? ok('and so does the family it was cut out of, which is the rest of the kit')
          : no('the verifier threw away the picture the dialogue box was cut out of')
    } else {
      await removeUi(owner.id, 'dialogue_box', { core: true })
    }

    /* createUi keeps slices through a redraw only at the same size, so a resize can store top+bottom >= h */
    await setUiImage(owner.id, GROUND, solidPNG(96, 96, 190, 170, 130), 96, 96)
    eq('a redraw at the same size keeps the edge numbers, which is the promise', (await getUiByName(owner.id, GROUND))?.slice?.top, 12)
    await setUiImage(owner.id, GROUND, solidPNG(64, 64, 190, 170, 130), 64, 64)
    eq('a redraw at a different size drops them rather than pointing them at a picture that is gone', (await getUiByName(owner.id, GROUND))?.slice, undefined)

    /* the generate route sent only b64, width and height, so pixellab_id was empty on every row ever made */
    await setUiImage(owner.id, GROUND, solidPNG(64, 64, 1, 2, 3), 64, 64, 'zz-pixellab-1234')
    eq('a generated piece remembers the spend it came from', (await getUiByName(owner.id, GROUND))?.pixellabId, 'zz-pixellab-1234')

    /* failUi only runs in the two catches, so a restart stranded a row at still drawing; aged out on read */
    const STUCK = 'zz_verify_stuck'
    await removeUi(owner.id, STUCK, { core: true })
    await createUi({ ownerId: owner.id, name: STUCK, type: 'panel', description: 'never came back', w: 96, h: 96 })
    eq('a row that is genuinely drawing says so', (await getUiByName(owner.id, STUCK))?.status, 'pending')
    await q(`update ui_assets set created_at = now() - interval '30 minutes' where owner_id = $1 and name = $2`, [owner.id, STUCK])
    eq('and one that has been drawing for half an hour says nothing came back', (await getUiByName(owner.id, STUCK))?.status, 'failed')
    await removeUi(owner.id, STUCK, { core: true })
  } finally {
    for (const n of [GROUND, SHEET, CORE]) await removeUi(owner.id, n, { core: true })
    /* the author's real dialogue_box is restored rather than removed: removeUi drops both blobs */
    if (realDlgSnap) await putUiBack(realDlgSnap)
    else await removeUi(owner.id, 'dialogue_box', { core: true })
  }

  /* names are unique per account only, and the list had no dedupe, so a member row silently beat core */
  const TWIN = 'zz_verify_twin'
  const other = await one(
    `insert into users (email, password_hash) values ('zz-verify-other@example.invalid', 'x')
     on conflict (email) do update set password_hash = 'x' returning id`,
  )
  try {
    await removeUi(owner.id, TWIN, { core: true })
    await removeUi(other.id, TWIN, { core: true })
    // the member row first, so "the oldest wins" alone would pick the wrong one
    // and only the core flag can save it
    await createUi({ ownerId: other.id, name: TWIN, type: 'panel', description: 'a member piece', w: 96, h: 96 })
    await setUiImage(other.id, TWIN, solidPNG(96, 96, 10, 10, 10), 96, 96)
    await createUi({ ownerId: owner.id, name: TWIN, type: 'panel', description: 'the core one', w: 96, h: 96, core: true })
    await setUiImage(owner.id, TWIN, solidPNG(96, 96, 250, 250, 250), 96, 96)
    const listed = (await readyUi()).filter((u) => u.name === TWIN)
    eq('the published list answers with one row per name', listed.length, 1)
    eq('and it is the core one, which is what the by-name read has always said', listed[0]?.core, true)
    /* src was hard-coded to the account-less route, so two accounts sharing a name saw one picture */
    eq('a member marking up their own piece is served their own bytes', (await getUiByName(other.id, TWIN))?.src, `/api/ui/${TWIN}/image`)
    eq('and the published read keeps the account-less route the game asks on', listed[0]?.src, `/api/v1/ui/${TWIN}/image`)
    /* the two pictures are different colours, so a byte compare proves the scoping without decoding */
    {
      const server = http.createServer((req, res) =>
        api(req, res, () => {
          res.statusCode = 404
          res.end('not found')
        }),
      )
      await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
      try {
        const pubBytes = Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}/api/v1/ui/${TWIN}/image`)).arrayBuffer())
        const core = solidPNG(96, 96, 250, 250, 250)
        pubBytes.equals(core)
          ? ok('the published image route hands over the core picture, which is the row the list agrees on')
          : no('the published image route and the published list disagree about which row is which')
      } finally {
        await new Promise((r) => server.close(r))
      }
    }
  } finally {
    await removeUi(owner.id, TWIN, { core: true })
    await removeUi(other.id, TWIN, { core: true })
    await q('delete from users where id = $1', [other.id])
  }

  /* neither css nor Pixi takes a source rect, so the insets are whole-image and a family cannot be sliced */
  const familyPNG = (w, h, boxes) => {
    // transparent everywhere it is not drawn, which is what the scan reads
    const rgba = Buffer.alloc(w * h * 4)
    for (const [bx, by, bw, bh, r, g, b] of boxes)
      for (let y = by; y < by + bh; y++)
        for (let x = bx; x < bx + bw; x++) {
          const i = (y * w + x) * 4
          rgba[i] = r
          rgba[i + 1] = g
          rgba[i + 2] = b
          rgba[i + 3] = 255
        }
    return encodePNG(w, h, rgba)
  }
  // a rectangle drawn as an outline, so something can sit inside its box
  // without touching its pixels, which is the highlight edge's real shape
  const ringBoxes = (x, y, w, h, t, c) => [
    [x, y, w, t, ...c],
    [x, y + h - t, w, t, ...c],
    [x, y, t, h, ...c],
    [x + w - t, y, t, h, ...c],
  ]

  const dlgType = pieceType('dialogue_box')
  {
    /* THE ORDINARY CASE. A hero of 520x180 at 60,20 on a 688x384 canvas is 35%
     * of it, and three tray buttons sit well below with nothing overlapping. */
    const good = familyPNG(688, 384, [
      [60, 20, 520, 180, 120, 90, 60],
      [60, 260, 150, 40, 120, 90, 60],
      [240, 260, 150, 40, 120, 90, 60],
      [420, 260, 150, 40, 120, 90, 60],
    ])
    const cut = cropHero(good, dlgType)
    eq('the scan finds the hero and every tray piece beside it', cut.regions, 4)
    eq('and cuts the hero out at the pixel', cut.box, { x: 60, y: 20, w: 520, h: 180 })
    const back = decodePNG(cut.png)
    eq('the bytes it hands over really are that size', [back.w, back.h], [520, 180])
    /* AND THE CUT IS THE PIECE AND NOT A WINDOW ONTO IT. Every corner of the
     * returned picture has to be the hero's own paint, or the box was off by
     * enough to carry canvas. */
    const corner = (x, y) => [back.data[(y * back.w + x) * 4], back.data[(y * back.w + x) * 4 + 3]]
    JSON.stringify([corner(0, 0), corner(519, 0), corner(0, 179), corner(519, 179)]) === JSON.stringify([[120, 255], [120, 255], [120, 255], [120, 255]])
      ? ok('all four corners of the cut are the hero, so the box is tight rather than near')
      : no('the cut has transparent corners, which means the box is bigger than the piece')
  }

  {
    // A SHAPE INSIDE THE HERO'S BOX. A ring with a chip in its hole: the two
    // never touch, so they are two regions, and a cut on the outer one would
    // carry the inner one with it.
    const overlap = familyPNG(688, 384, [
      ...ringBoxes(60, 20, 520, 180, 12, [120, 90, 60]),
      [200, 80, 40, 40, 200, 40, 40],
    ])
    const cut = cropHero(overlap, dlgType)
    !cut.box && cut.why.includes('carry part of its neighbour')
      ? ok('a shape sitting inside the hero box refuses the crop rather than swallowing it')
      : no(`a crop went ahead with something inside it: ${cut.why || JSON.stringify(cut.box)}`)
  }

  {
    // TOO SMALL TO BE THE PIECE. 200x100 is 7% of a 688x384 canvas, which is a
    // tray button, and crowning one would cut the kit down to a button.
    const small = familyPNG(688, 384, [
      [40, 40, 200, 100, 120, 90, 60],
      [300, 40, 120, 60, 120, 90, 60],
    ])
    const cut = cropHero(small, dlgType)
    !cut.box && cut.why.includes('never that small a part of its own canvas')
      ? ok(`a largest shape that is a twelfth of the canvas is refused · ${cut.why}`)
      : no(`a tray-sized shape was taken for the hero: ${cut.why || JSON.stringify(cut.box)}`)
  }

  {
    // THE RIGHT SIZE AND THE WRONG SHAPE. 260x380 is 37% of the canvas, so it
    // clears the area check, and its ratio is 0.68 against the 1.79 a dialogue
    // box is drawn at, which is outside the band.
    const wrong = familyPNG(688, 384, [[10, 2, 260, 380, 120, 90, 60]])
    const cut = cropHero(wrong, dlgType)
    !cut.box && cut.why.includes('too far off to be the piece')
      ? ok('a shape the wrong way round for its type is refused on its ratio')
      : no(`a portrait shape passed as a dialogue box: ${cut.why || JSON.stringify(cut.box)}`)
  }

  {
    const empty = familyPNG(688, 384, [])
    const cut = cropHero(empty, dlgType)
    !cut.box && cut.why.includes('transparent')
      ? ok('a picture with nothing in it says so rather than cutting a zero-sized piece')
      : no('an empty picture produced a crop')
  }

  /* A SHEET IS A GRID OF CUTS AND CROPPING IT THROWS THE OTHER CUTS AWAY. So a
   * sheet is never scanned, and neither is a cover plate, whose canvas IS the
   * painting. Only a ground piece is one piece. */
  eq('a ground piece is cropped to its hero', cropsToHero(pieceType('panel')), true)
  eq('a sheet is left whole, because every cut on it is wanted', cropsToHero(pieceType('pip')), false)
  eq('and so is a cover plate, whose canvas is the painting', cropsToHero(pieceType('cover_plate')), false)
  eq('a piece with no type is left alone rather than guessed at', cropsToHero(null), false)

  /* work/ is not in git, so a clean checkout skips this rather than failing on the measured numbers */
  {
    const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'work', '.kit')
    const real = [
      ['dialogue_box_v4.png', 'dialogue_box', { x: 85, y: 17, w: 518, h: 182 }],
      ['panel.png', 'panel', { x: 22, y: 22, w: 403, h: 150 }],
    ]
    for (const [file, type, want] of real) {
      const at = path.join(KIT, file)
      if (!fs.existsSync(at)) {
        ok(`${file} is not on this machine, so its measurement is skipped rather than guessed`)
        continue
      }
      eq(`the hero of the real ${file}`, cropHero(fs.readFileSync(at), pieceType(type)).box, want)
    }
  }

  /* ---- 6c. the crop lands on the row, and can be taken back ---------------- */
  const CROPPED = 'zz_verify_cropped'
  await removeUi(owner.id, CROPPED, { core: true })
  try {
    const family = familyPNG(688, 384, [
      [60, 20, 520, 180, 120, 90, 60],
      [60, 260, 150, 40, 120, 90, 60],
      [240, 260, 150, 40, 120, 90, 60],
    ])
    await createUi({ ownerId: owner.id, name: CROPPED, type: 'dialogue_box', description: 'a family', w: 688, h: 384, core: true })
    const saved = await setUiImage(owner.id, CROPPED, family, 688, 384)
    eq('importing a family stores the hero size and not the canvas size', [saved.w, saved.h], [520, 180])
    const row = await getUiByName(owner.id, CROPPED)
    // read field by field: jsonb does not keep the key order it was given, so
    // comparing the whole object as a string compares postgres's ordering
    eq('and the row says where in the family the hero was', [row?.crop?.x, row?.crop?.y, row?.crop?.w, row?.crop?.h], [60, 20, 520, 180])
    eq('and offers the family it came out of', row?.full, `/api/ui/${CROPPED}/full`)
    row?.cropNote ? no(`a clean crop still left a note: ${row.cropNote}`) : ok('a clean crop leaves no hand-crop note on the row')
    /* THE FAMILY IS KEPT WHOLE. It is the rest of the kit, drawn in the same job
     * and paid for in the same spend, so throwing it away to keep the blob
     * store tidy would mean paying for those buttons again. */
    const kept = await ownedUiFull(owner.id, CROPPED)
    kept && kept.equals(family)
      ? ok('the family is kept exactly as it was drawn, tray and all')
      : no('the family was not stored, so a bad crop could not be undone')
    const hero = await ownedUiImage(owner.id, CROPPED)
    const heroSize = hero ? decodePNG(hero) : null
    eq('and the piece itself serves the hero', [heroSize?.w, heroSize?.h], [520, 180])

    /* A REFUSAL KEEPS THE WHOLE PICTURE AND SAYS WHY ON THE ROW, because the
     * author has to be told a hand crop is owed rather than discovering it when
     * their four numbers draw the wrong band. */
    const bad = familyPNG(688, 384, [
      [40, 40, 200, 100, 120, 90, 60],
      [300, 40, 120, 60, 120, 90, 60],
    ])
    const refused = await setUiImage(owner.id, CROPPED, bad, 688, 384)
    eq('a refused crop keeps the whole picture', [refused.w, refused.h], [688, 384])
    const note = await getUiByName(owner.id, CROPPED)
    note?.needsCrop && note.cropNote.includes('never that small a part of its own canvas')
      ? ok('and the row says a hand crop is owed, naming the check that stopped it')
      : no(`a refused crop said nothing on the row: ${JSON.stringify(note?.cropNote)}`)
    note?.crop ? no('a refused crop still claimed a box') : ok('and it claims no box, because none was cut')
    /* AND THE LAST IMPORT'S FAMILY IS GONE WITH IT. A `.full` left behind from
     * a crop that has been replaced is a picture of something else sitting under
     * the undo button. */
    ;(await ownedUiFull(owner.id, CROPPED)) === null
      ? ok('a redraw that does not crop takes the old family away with it')
      : no('the previous import`s family is still under the undo route')

    // and putting a crop back, which is the other half of the rule: a crop that
    // passed every check and is still wrong has to be one press to undo rather
    // than a spend to draw again
    await setUiImage(owner.id, CROPPED, family, 688, 384)
    const put = await uncropUi(owner.id, CROPPED)
    eq('undoing a crop puts the whole family back as the piece', [put.w, put.h], [688, 384])
    put.crop ? no('the row still claims a crop after an undo') : ok('and the row stops claiming a crop')
    const whole = await ownedUiImage(owner.id, CROPPED)
    whole && whole.equals(family) ? ok('and the bytes are the family, byte for byte') : no('the undo produced something other than the family')
    const nothingLeft = await thrown(() => uncropUi(owner.id, CROPPED))
    nothingLeft.includes('nothing to put back')
      ? ok('undoing a piece that was never cropped says so rather than half-doing it')
      : no(`a second undo did something: ${nothingLeft || 'no error'}`)
  } finally {
    await removeUi(owner.id, CROPPED, { core: true })
  }

  /* blobs.mjs only evicts on a same-process write, so a cli redraw stayed invisible until restart */
  const FRESH = 'zz_verify_fresh'
  await removeUi(owner.id, FRESH, { core: true })
  const freshServer = http.createServer((req, res) =>
    api(req, res, () => {
      res.statusCode = 404
      res.end('not found')
    }),
  )
  await new Promise((r) => freshServer.listen(PORT, '127.0.0.1', r))
  const token = await openSession(owner.id, 'verify-authoring')
  const asOwner = { headers: { cookie: `mapvis_session=${token}` } }
  const bytesAt = async (u, o) => Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}${u}`, o)).arrayBuffer())
  try {
    await createUi({ ownerId: owner.id, name: FRESH, type: 'panel', description: 'redrawn twice', w: 96, h: 96 })
    const first = solidPNG(96, 96, 10, 20, 30)
    await setUiImage(owner.id, FRESH, first, 96, 96)
    const gotFirst = await bytesAt(`/api/ui/${FRESH}/image`, asOwner)
    gotFirst.equals(first) ? ok('the first picture reaches the route it is served on') : no('the first picture did not come back')

    // the same size and different bytes, which is the case that has no other
    // tell: nothing about the row changes except the picture
    const second = solidPNG(96, 96, 200, 190, 180)
    await setUiImage(owner.id, FRESH, second, 96, 96)
    const gotSecond = await bytesAt(`/api/ui/${FRESH}/image`, asOwner)
    gotSecond.equals(second)
      ? ok('a redraw shows through on the authoring route in the same process, with no restart')
      : no(`the authoring route served the old picture again: ${gotSecond.length} bytes instead of ${second.length}`)
    const v1Second = await bytesAt(`/api/v1/ui/${FRESH}/image`)
    v1Second.equals(second)
      ? ok('and on the published route, which was serving the stale copy too')
      : no(`the published route served the old picture: ${v1Second.length} bytes instead of ${second.length}`)

    /* a second blobs.mjs under another specifier is a separate cache, which is what another process is */
    const { store: foreign } = await import('../store/blobs.mjs?foreign-writer')
    const third = solidPNG(96, 96, 3, 4, 5)
    await foreign().put(`ui/${owner.id}/${FRESH}.png`, third, 'image/png')
    await q('update ui_assets set img_sha = $3 where owner_id = $1 and name = $2', [
      owner.id,
      FRESH,
      crypto.createHash('sha1').update(third).digest('base64url'),
    ])
    const gotThird = await bytesAt(`/api/ui/${FRESH}/image`, asOwner)
    gotThird.equals(third)
      ? ok('a write from another process shows through too, because the row is what says which bytes are the picture')
      : no(`another process wrote the picture and this one kept serving its cached copy: ${gotThird.length} bytes instead of ${third.length}`)
  } finally {
    await new Promise((r) => freshServer.close(r))
    await removeUi(owner.id, FRESH, { core: true })
    await q('delete from sessions where user_id = $1 and user_agent = $2', [owner.id, 'verify-authoring'])
  }

  /* end to end on real art, with the row put back whole because this file has eaten it before */
  const dlgSnap = await snapUi('dialogue_box')
  try {
    const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'work', '.kit')
    /* THE REAL ART, in the order it is most likely to be the family: the
     * picture a crop already came out of, then the row's own bytes, then the
     * file on disk. Nothing is generated and nothing is invented. */
    const onDisk = ['dialogue_box_v4.png', 'dialogue_box.png']
      .map((f) => path.join(KIT, f))
      .find((f) => fs.existsSync(f))
    const art =
      (dlgSnap?.row.full_key ? await ownedUiFull(owner.id, 'dialogue_box') : null) ||
      (onDisk ? fs.readFileSync(onDisk) : null) ||
      dlgSnap?.img ||
      null
    if (!art) {
      ok('there is no real dialogue box on this machine, so the end-to-end slice is skipped rather than faked')
    } else {
      const size = decodePNG(art)
      const want = cropHero(art, dlgType)
      await createUi({
        ownerId: owner.id, name: 'dialogue_box', type: 'dialogue_box',
        title: 'The Dialogue Box', description: 'the real one', w: size.w, h: size.h, core: true,
      })
      const put = await setUiImage(owner.id, 'dialogue_box', art, size.w, size.h)
      const piece = { w: put.w, h: put.h }
      want.box
        ? eq('the real art is cut down to its hero on import', [piece.w, piece.h], [want.box.w, want.box.h])
        : ok(`this copy of the real art refuses its crop and keeps the whole picture · ${want.why}`)

      /* a fraction of the piece, so it can never store top + bottom >= h, which css draws as nothing */
      const edge = { top: Math.round(piece.h * 0.17), bottom: Math.round(piece.h * 0.17), left: Math.round(piece.w * 0.07), right: Math.round(piece.w * 0.07) }
      const marks = [
        { name: 'speaker', kind: 'text', x: edge.left + 4, y: edge.top + 2, w: 120, h: 16, align: 'left', overflow: 'ellipsis' },
        { name: 'body', kind: 'text', x: edge.left + 4, y: edge.top + 24, w: piece.w - edge.left - edge.right - 8, h: piece.h - edge.top - edge.bottom - 30, wrap: 'wrap' },
        { name: 'go_on', kind: 'press', x: piece.w - edge.right - 40, y: piece.h - edge.bottom - 20, w: 36, h: 16 },
      ]
      const measured = await setUiRegions(owner.id, 'dialogue_box', marks, {
        slice: edge, scale: 2, fill: true, repeat: { x: 'round', y: 'round' },
      })
      // in the order border-image-slice takes them, and field by field, because
      // jsonb hands the object back in whatever key order it chose
      const four = (s) => [s?.top, s?.right, s?.bottom, s?.left]
      eq('the measurement survives being saved', four(measured.slice), four(edge))
      eq('a published dialogue box says it is published', (await publishUi(owner.id, 'dialogue_box')).published, true)

      const server = http.createServer((req, res) =>
        api(req, res, () => {
          res.statusCode = 404
          res.end('not found')
        }),
      )
      await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
      try {
        const read = await (await fetch(`http://127.0.0.1:${PORT}/api/v1/ui/dialogue_box`)).json()
        eq('the four edge numbers come back off the route the game asks on', four(read.slice), four(edge))
        eq('and the three qualifiers beside them', [read.scale, read.fill, read.repeat], [2, true, { x: 'round', y: 'round' }])
        eq('and the picture is the size the numbers were measured against', [read.w, read.h], [piece.w, piece.h])
        eq('and every rectangle keeps its name', read.regions?.map((r) => r.name), ['speaker', 'body', 'go_on'])
        eq('and a text region keeps what a long line does', read.regions?.find((r) => r.name === 'speaker')?.overflow, 'ellipsis')
        eq('and the piece answers on the route its own src names', read.src, '/api/v1/ui/dialogue_box/image')

        /* the insets are off this picture, so serving the family canvas would make every one of them wrong */
        const shown = decodePNG(await bytesAt('/api/v1/ui/dialogue_box/image'))
        eq('the bytes the slice is measured against are the piece itself', [shown.w, shown.h], [piece.w, piece.h])

        /* the handle is dialogue not dialogue_box, width is slice times scale, and the url carries the sha */
        const css = read.css || ''
        const drawn = [edge.top, edge.right, edge.bottom, edge.left].map((n) => `${n * 2}px`).join(' ')
        css === sliceCss('dialogue_box', { slice: edge, scale: 2, fill: true, repeat: { x: 'round', y: 'round' } }, read.sha)
          ? ok('the css on the wire is exactly what sliceCss emits for those numbers')
          : no('the css on the wire and sliceCss disagree, which is two truths about one measurement')
        css.includes(`--kit-slice-dialogue: ${edge.top} ${edge.right} ${edge.bottom} ${edge.left};`) &&
        css.includes(`--kit-slice-w-dialogue: ${drawn};`) &&
        css.includes('.kit-surface-dialogue {') &&
        css.includes('border-image: var(--kit-art-dialogue,') &&
        css.includes(' fill /')
          ? ok('and it is a mountable rule: the handle the game has, the numbers, the drawn width and a filled middle')
          : no(`the css is not what a consumer would mount:\n${css}`)
        read.sha && css.includes(`/api/v1/ui/dialogue_box/image?v=${read.sha.slice(0, 12)}`)
          ? ok('and its url carries the content hash, so a redraw is a new address rather than a rename')
          : no('the css url has no version on it, so a browser holding the old art keeps it for a year')
      } finally {
        await new Promise((r) => server.close(r))
      }
    }
  } finally {
    if (dlgSnap) await putUiBack(dlgSnap)
    else await removeUi(owner.id, 'dialogue_box', { core: true })
  }

  /* asks the real shelf, not a fixture: unmeasured art falls back to the squash, and an empty shelf passes */
  {
    const shelf = (await listUi(owner.id)).filter((p) => p.status === 'ready' && !p.name.startsWith('zz_'))
    if (!shelf.length) ok('there is no drawn kit on this account, so its completeness is skipped rather than faked')
    else {
      const grounds = shelf.filter((p) => pieceType(p.type)?.tier === 'ground')
      const missing = grounds.filter((p) => !p.slice)
      missing.length
        ? no(`${missing.length} ground piece(s) carry no edge numbers, so the game would squash them: ${missing.map((p) => p.name).join(', ')}`)
        : ok(`all ${grounds.length} ground pieces on the shelf carry their four edge numbers`)

      /* top + bottom under h or css drops the border image with no error, and asked of what is stored */
      const crossed = []
      for (const p of grounds) {
        if (!p.slice) continue
        const { problems } = checkSlices({ slice: p.slice, scale: p.scale, fill: p.fill, repeat: p.repeat }, p.w, p.h, pieceType(p.type))
        if (problems.length) crossed.push(`${p.name}: ${problems[0]}`)
      }
      crossed.length
        ? no(`edge numbers that cannot be drawn are stored: ${crossed.join(' · ')}`)
        : ok('and every pair of them leaves a middle, so no piece silently loses its border image')

      /* the type's list is the vocabulary a reader holds, so a box with no body has nowhere to write */
      const owed = []
      for (const p of shelf) {
        const t = pieceType(p.type)
        if (!t) continue
        const have = new Set((p.regions || []).map((s) => s.name))
        for (const want of t.regions) if (want.required && !have.has(want.name)) owed.push(`${p.name}.${want.name}`)
      }
      owed.length
        ? no(`${owed.length} named place(s) the type promises are not on the picture: ${owed.join(', ')}`)
        : ok('and every region a type calls required is marked on every piece of that type')
    }
  }

  /* bytes are duplicated on purpose, and every frame has to come across or a walker faces south forever */
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
  /* AND A PERSON CAN CORRECT THE SCAN, for a painting whose edge is a faint halo; paint_set keeps the next publish from scanning over it */
  {
    const stated = [12, 9, 3, 2]
    await putDoc(map.id, JSON.stringify({ ...doc, props: { ...doc.props, paint: stated } }))
    const back2 = JSON.parse(await getDoc(map.id))
    eq('a stated painting extent survives the save', back2.props?.paint, stated)
    const pub2 = await publishBundle(SLUG, {
      mapJson: bundleMap,
      assetsJson: pubAssets,
      images: { 'levels.png': levelsPNG, 'scene.png': scenePNG },
      files: new Map(),
    })
    const row2 = await publishedMap(SLUG)
    const shipped2 = JSON.parse((await store().get(row2.blob_prefix + 'map.json')).toString('utf8'))
    eq('and the bundle carries it instead of the scan', [shipped2.base?.w, shipped2.base?.h, shipped2.base?.ox, shipped2.base?.oy], stated)
    eq(
      'and publishing does not scan back over it',
      Object.values(await one('select paint_w, paint_h, paint_ox, paint_oy from maps where id = $1', [map.id])),
      stated,
    )
    pub2.version > pub.version ? ok(`and it published as v${pub2.version}`) : no('the second publish did not make a version')
    // and clearing it hands the map back to the measurement
    await putDoc(map.id, JSON.stringify(doc))
    const back3 = JSON.parse(await getDoc(map.id))
    back3.props?.paint === undefined ? ok('clearing it goes back to measured') : no(`a cleared extent came back ${back3.props?.paint}`)
  }

  /* AND A PERSON CAN CORRECT WHAT A PLACEMENT BLOCKS, for a sprite with a halo or a shadow painted into the frame */
  {
    const hand = [1, -2, 3, 4]
    const withFoot = { ...pubAssets, assets: pubAssets.assets.map((a) => (a.id === 'a3' ? { ...a, foot: hand } : a)) }
    await publishBundle(SLUG, {
      mapJson: bundleMap,
      assetsJson: withFoot,
      images: { 'levels.png': levelsPNG, 'scene.png': scenePNG },
      files: new Map(),
    })
    const r = await publishedMap(SLUG)
    const shippedA = JSON.parse((await store().get(r.blob_prefix + 'assets.json')).toString('utf8'))
    eq('an authored footprint reaches the bundle instead of the scan', shippedA.assets.find((a) => a.id === 'a3')?.foot, hand)
    /* and correcting one placement does not hand the rest the same number. This
     * fixture ships no pngs, so nothing else can be measured and the honest
     * answer for the rest is no footprint at all rather than a borrowed one. */
    const other = shippedA.assets.find((a) => a.id === 'a1')?.foot
    other === undefined ? ok('and no other placement borrowed it') : no(`another placement came back ${JSON.stringify(other)}`)
  }

  /* THE OUTLINES AN AUTHOR DREW. Three tools take polygon points and all three
   * rasterize and clear, so one outline was traced by hand three times. They are
   * a stencil and not a shape the map has: nothing reads them but the tool. */
  {
    const drawn = [{ id: 1, pts: [[1, 1], [9, 1], [9, 7]] }, { id: 2, pts: [[2, 2], [4, 2], [4, 4], [2, 4]] }]
    await putDoc(map.id, JSON.stringify({ ...doc, stencils: drawn, stencilNext: 3 }))
    const back4 = JSON.parse(await getDoc(map.id))
    eq('the drawn outlines survive the save', back4.stencils, drawn)
    eq('and the next id comes back past the highest one', back4.stencilNext, 3)
    // two points is a line and a line fills nothing, so it is refused rather than stored
    await putDoc(map.id, JSON.stringify({ ...doc, stencils: [{ id: 1, pts: [[1, 1], [9, 1]] }] }))
    eq('a two-point outline is refused', JSON.parse(await getDoc(map.id)).stencils, [])
    await putDoc(map.id, JSON.stringify(doc))
  }
} finally {
  await q('delete from maps where id = $1', [map.id])
}

console.log(bad ? `\n${bad} check(s) failed.` : `\nevery authored field reaches the bundle.`)
await closeDb()
process.exit(bad ? 1 : 0)
