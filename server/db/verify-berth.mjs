// A berth's facing is the heading the hull holds once she is tied up, so it must not point at the land.

//   node server/db/verify-berth.mjs

// No database and nothing bought. The geometry is the whole of it: an island's painted middle, a berth
// beside it, and a compass word that either lies along the shore or drives the bow into it.
//
// The hub's own numbers are in here as a case, because the rule was written against them and a rule
// checked only on invented data is a rule nobody has seen fire.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { facingIntoCoast, checkWorld, FACING_VECTORS, INTO_COAST, BERTH_FACINGS } from '../store/world.mjs'

let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}

/* the hub as it is actually stored: the island's top-left, its painted extent inside its canvas, and
 * the berth beside its south-east shore */
const HUB_PLACE = { name: 'the_hub', map: 'hub', x: 1736, y: 1591, w: 688, h: 640, state: 'available', discover: 520, place: 'home-island' }
const HUB_MAP = { slug: 'hub', w: 688, h: 640, paint_w: 669, paint_h: 377, paint_ox: 7, paint_oy: 194 }
const HUB_BERTH = { name: 'the_hub_berth', kind: 'berth', x: 2264, y: 2145, island: 'the_hub' }

// ---- the hub, every heading ------------------------------------------------

{
  const verdicts = {}
  for (const f of Object.keys(FACING_VECTORS)) verdicts[f] = !!facingIntoCoast({ ...HUB_BERTH, facing: f }, HUB_PLACE, HUB_MAP)

  // the island's middle is up and to the left of this berth, so the headings
  // that drive into it are the northerly and westerly ones
  verdicts.north ? ok('the hub berth facing north is refused, which is how it stands today') : no('the hub berth facing north passed')
  verdicts['north-west'] ? ok('and north-west, which is almost exactly at the island') : no('north-west passed on the hub')
  verdicts.west ? ok('and west') : no('west passed on the hub')

  !verdicts.south ? ok('while south is clear, which is out to open water') : no('south was refused on the hub')
  !verdicts.east ? ok('and east, which lies along the shore') : no('east was refused on the hub')
  !verdicts['south-east'] ? ok('and south-east') : no('south-east was refused on the hub')

  const into = facingIntoCoast({ ...HUB_BERTH, facing: 'north' }, HUB_PLACE, HUB_MAP)
  into && into.degrees === 47
    ? ok(`and the refusal says how far off it is: ${into.degrees} degrees from straight at the island`)
    : no(`the angle reported was ${into && into.degrees}, expected 47`)
}

// ---- the rule itself, on geometry nobody has to trust me about -------------

{
  /* a berth due south of a square island: north is straight into it, south is
   * straight out to sea, and east and west lie along the shore */
  const place = { name: 'isle', map: 'isle', x: 0, y: 0, w: 200, h: 200 }
  const at = (facing) => facingIntoCoast({ name: 'b', kind: 'berth', x: 100, y: 260, facing, island: 'isle' }, place, null)

  at('north') && at('north').degrees === 0 ? ok('straight at the island is 0 degrees off and refused') : no('straight in was not caught')
  !at('south') ? ok('straight out to sea is clear') : no('straight out to sea was refused')
  !at('east') && !at('west') ? ok('and both ways along the shore are clear') : no('a shore-parallel heading was refused')
  /* A 45 DEGREE DIAGONAL IS REFUSED, AND IT HAS TO BE. It is 0.707 toward the
   * land where the hub's north is 0.677, so any rule that catches the hub and
   * clears this one is not a rule about geometry, it is a rule about the hub.
   * The bow has to be at least 60 degrees off the land to count as lying along
   * a shore rather than angling into it. */
  at('north-east') && at('north-east').degrees === 45
    ? ok('and a 45 degree diagonal is refused too, being further in than the hub already is')
    : no('a 45 degree diagonal was allowed while a shallower angle was not')

  /* the threshold is a cone and not a half-plane, which is what lets a berth
   * lie along a shore it is necessarily beside */
  INTO_COAST === 0.5 ? ok('the cone is 60 degrees either side of straight in') : no(`the threshold is ${INTO_COAST}`)
  /* the boundary itself, stated so moving it is a decision and not a drift */
  !at('east') && !at('west') && at('north') && at('north-east')
    ? ok('so the first clear heading off the land is the one square to it')
    : no('the boundary is not where it is written down')
}

// ---- what it refuses to judge ---------------------------------------------

{
  const place = { name: 'isle', map: 'isle', x: 0, y: 0, w: 200, h: 200 }
  const mark = { name: 'b', kind: 'berth', x: 100, y: 260, island: 'isle' }
  facingIntoCoast({ ...mark, facing: '' }, place, null) === null
    ? ok('a berth with no heading is not judged, because there is nothing to judge')
    : no('a berth with no facing was refused')
  facingIntoCoast({ ...mark, facing: 'sideways' }, place, null) === null
    ? ok('and neither is a word that is not a compass point, which a different check already names')
    : no('a nonsense facing was judged as geometry')
  facingIntoCoast({ ...mark, x: 100, y: 100, facing: 'north' }, place, null) === null
    ? ok('and neither is a berth sitting on the island middle, which has no direction to measure')
    : no('a berth with no distance was judged')
  facingIntoCoast(null, place, null) === null && facingIntoCoast(mark, null, null) === null
    ? ok('and a berth belonging to no island is left alone')
    : no('a berth with no island threw or was judged')
}

// ---- through checkWorld, which is what actually refuses the save -----------

{
  const doc = {
    w: 4096,
    h: 4096,
    home: 'the_hub',
    places: [HUB_PLACE],
    regions: [],
    marks: [{ ...HUB_BERTH, facing: 'north' }],
  }
  const maps = new Map([['hub', HUB_MAP]])
  const bad1 = checkWorld(doc, ['hub'], maps)
  const said = bad1.problems.find((s) => s.includes('bow-first in the coast'))
  said ? ok('checkWorld raises it as a problem, so the save is refused rather than warned about') : no('the save was allowed')
  said && said.includes('the_hub_berth') && said.includes('the_hub')
    ? ok('and the sentence names the berth and the island it would run into')
    : no(`the message does not name both: ${said}`)

  const turned = { ...doc, marks: [{ ...HUB_BERTH, facing: 'south' }] }
  checkWorld(turned, ['hub'], maps).problems.filter((s) => s.includes('bow-first in the coast')).length === 0
    ? ok('and turning her out to sea clears it')
    : no('a berth facing open water was still refused')

  /* a berth on no island cannot be judged and must not block a save: an author
   * is allowed to mark the water before the island is there */
  const loose = { ...doc, marks: [{ ...HUB_BERTH, island: '', facing: 'north' }] }
  checkWorld(loose, ['hub'], maps).problems.filter((s) => s.includes('bow-first in the coast')).length === 0
    ? ok('while a berth belonging to no island never blocks one')
    : no('a free-standing berth was refused')
}

// ---- the vectors the chart draws the ghost from ----------------------------

{
  const wrong = Object.entries(FACING_VECTORS).filter(([, v]) => Math.abs(Math.hypot(v[0], v[1]) - 1) > 1e-3)
  wrong.length === 0 ? ok('every heading is a unit vector, so the ghost is drawn the same length whichever way she lies') : no(`${wrong.length} headings are not unit length`)
  FACING_VECTORS.north[1] === -1 ? ok('and north is negative y, the way every raster in this tool has it') : no('north points south')
}

// ---- every heading a berth can hold, and the game holding it ---------------
// A berth was held to four compass points because the game's radOf read three words and sent
// everything else to west, silently, so a diagonal drawn on the chart moored the hull facing
// somewhere nobody aimed it. A coastline does not run north to south to suit us, so half the shores
// on a map could not be lain along at all.
//
// Both sides changed together, which is the only way this can be true, so both sides are read here.
// The angle the game turns a word into has to be the angle the vector this tool publishes points at,
// or the ghost hull on the chart lies about the moored ship.
{
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  BERTH_FACINGS.length === 8
    ? ok('a berth can be aimed at all eight compass points')
    : no(`a berth is held to ${BERTH_FACINGS.length} headings: ${BERTH_FACINGS.join(', ')}`)
  BERTH_FACINGS.every((f) => FACING_VECTORS[f])
    ? ok('and every one of them is a heading the chart can draw, being the same list')
    : no('a heading is publishable that the chart cannot draw')

  /* THE GAME'S OWN TABLE, read out of its source and compared angle by angle against the vectors
   * this tool publishes. Screen space with y down, so atan2(dy, dx) is the heading in radians. */
  const g = fs.readFileSync(path.join(ROOT, '..', 'AdventureGame', 'src/game/pmap/PmapScene.tsx'), 'utf8')
  const tbl = g.slice(g.indexOf('const RADS: Record<string, number> = {'), g.indexOf('const radOf ='))
  tbl ? ok("the game reads its headings off a table rather than a chain of three words") : no('the game has no heading table')
  /* one line at a time, so the pattern needs no newline of its own: a line-spanning class in a
   * generated file is exactly where an escape gets eaten and the regex stops meaning what it reads */
  const rads = {}
  for (const line of tbl.split(/\r?\n/)) {
    const m = line.match(/^\s*'?([a-z-]+)'?:\s*(.+?),?\s*$/)
    if (!m || !/Math\.PI|^-?[\d.]+$/.test(m[2])) continue
    rads[m[1]] = Function('return ' + m[2].replace(/Math\.PI/g, String(Math.PI)))()
  }
  Object.keys(rads).length === 8
    ? ok('and it holds all eight, so no heading falls through to west unsaid')
    : no(`the game's table holds ${Object.keys(rads).length} headings, not 8`)
  const wrong = Object.entries(FACING_VECTORS).filter(([k, v]) => {
    const want = Math.atan2(v[1], v[0])
    const got = rads[k]
    if (got === undefined) return true
    return Math.abs(Math.atan2(Math.sin(want - got), Math.cos(want - got))) > 1e-3
  })
  wrong.length === 0
    ? ok('and every angle it turns a word into is the angle that word points on the chart')
    : no(`${wrong.length} heading(s) are drawn one way here and another in the game: ${wrong.map(([k]) => k).join(', ')}`)

  /* the fallback still answers west, so every world published while a diagonal meant west keeps
   * drawing exactly as it did rather than swinging on the next load */
  g.includes('return r === undefined ? Math.PI : r')
    ? ok('while a word it does not know still answers west, so nothing already published moves')
    : no('an unknown heading no longer falls back to west, so old bundles may swing')
}

console.log(bad ? `\n${bad} problem(s).` : '\na berth points along the shore or out to sea, and never into the land she is tied to.')
process.exit(bad ? 1 : 0)
