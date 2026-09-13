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
import {
  facingIntoCoast,
  checkWorld,
  FACING_VECTORS,
  INTO_COAST,
  BERTH_FACINGS,
  vecOfBearing,
  vecOfMark,
  bearingOf,
  nearestFacing,
} from '../store/world.mjs'

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
  /* IT TELLS RATHER THAN REFUSES NOW. It knows one point, the middle of the painting, so a berth at
   * the end of a jetty lying along that jetty reads as aimed at the land. That is not a rare corner:
   * it is the hub's own berth, 2 degrees off the middle and moored over open water the whole length
   * of the hull, and the save was refused. */
  const said = bad1.warnings.find((s) => s.includes('straight at the middle'))
  said ? ok('checkWorld says a bow aimed at the middle, as a warning the author can overrule by eye') : no('nothing was said at all')
  said && said.includes('the_hub_berth') && said.includes('the_hub')
    ? ok('and the sentence names the berth and the island it is aimed at')
    : no(`the message does not name both: ${said}`)
  bad1.problems.filter((s) => s.includes('straight at the middle')).length === 0
    ? ok('and it never blocks the save, because the ghost on the chart is the better judge')
    : no('it is still refusing the save')

  const turned = { ...doc, marks: [{ ...HUB_BERTH, facing: 'south' }] }
  checkWorld(turned, ['hub'], maps).warnings.filter((s) => s.includes('straight at the middle')).length === 0
    ? ok('and turning her out to sea clears it')
    : no('a berth facing open water was still warned about')

  /* a berth on no island cannot be judged and must not be mentioned: an author
   * is allowed to mark the water before the island is there */
  const loose = { ...doc, marks: [{ ...HUB_BERTH, island: '', facing: 'north' }] }
  checkWorld(loose, ['hub'], maps).warnings.filter((s) => s.includes('straight at the middle')).length === 0
    ? ok('while a berth belonging to no island is never judged at all')
    : no('a free-standing berth was judged')
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
  const gp = path.join(ROOT, '..', 'AdventureGame', 'src/game/pmap/PmapScene.tsx')
  if (!fs.existsSync(gp)) { ok('the game repo is not beside this one, so its heading table is not cross-checked here') } else {
  const g = fs.readFileSync(gp, 'utf8')
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
}

// ---- the dial: any angle, and the same angle everywhere --------------------
// Eight words cannot say "along this shore" when a coast runs at 23 degrees, and a berth is the one
// mark whose whole job is to lie along something. So a berth carries an angle, and `facing` is kept
// beside it at the nearest of the eight so python and every older reader still read a word.
{
  /* the angle and the word have to mean the same thing, or the compass presses on the dial move the
   * hull somewhere the press did not say */
  const off = Object.entries(FACING_VECTORS).filter(([k, v]) => {
    const b = vecOfBearing(bearingOf({ facing: k }))
    return Math.hypot(b[0] - v[0], b[1] - v[1]) > 1e-3
  })
  off.length === 0
    ? ok('every compass word turns into the same vector as the angle it sits at, so a preset and the dial agree')
    : no(`${off.length} word(s) disagree with their own angle: ${off.map(([k]) => k).join(', ')}`)

  bearingOf({ facing: 'north' }) === 0 && bearingOf({ facing: 'east' }) === 90 && bearingOf({ facing: 'west' }) === 270
    ? ok('and the dial reads clockwise from north, which is how a person reads a compass')
    : no('the dial is not clockwise from north')

  /* the angle WINS, because a berth turned to 23 degrees that gets judged and drawn as north-east is
   * a control that does not control anything */
  const v23 = vecOfMark({ facing: 'north', bearing: 23 })
  const want23 = vecOfBearing(23)
  Math.hypot(v23[0] - want23[0], v23[1] - want23[1]) < 1e-6
    ? ok('an angle beats the word beside it, so the dial is what is drawn and what is judged')
    : no('the word won over the angle')

  /* and a mark with only a word still answers, so nothing written before the dial existed changes */
  const vw = vecOfMark({ facing: 'south-east' })
  Math.abs(vw[0] - 0.7071) < 1e-3 && Math.abs(vw[1] - 0.7071) < 1e-3
    ? ok('while a mark carrying only a word is read exactly as it always was')
    : no('a word-only mark changed meaning')

  /* the boundary between two words is HALFWAY between them, 67.5 and not 45: 46 degrees is nearer
   * north-east than east and calling it east would be the floor, not the nearest */
  nearestFacing(23) === 'north-east' && nearestFacing(67) === 'north-east' && nearestFacing(68) === 'east' && nearestFacing(350) === 'north'
    ? ok('and the word kept beside an angle is the nearest of the eight, rounded rather than floored, and wraps past north')
    : no(`the nearest word is wrong: 23 -> ${nearestFacing(23)}, 67 -> ${nearestFacing(67)}, 68 -> ${nearestFacing(68)}, 350 -> ${nearestFacing(350)}`)

  /* THE GAME TURNS THE SAME ANGLE THE SAME WAY. Read out of its source and compared, because a sign
   * flip here draws the ghost one way on the chart and moors her the other. */
  const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const gp = path.join(HERE, '..', 'AdventureGame', 'src/game/pmap/PmapScene.tsx')
  if (!fs.existsSync(gp)) { ok('the game repo is not beside this one, so its heading table is not cross-checked here') } else {
  const g = fs.readFileSync(gp, 'utf8')
  g.includes('return Math.atan2(-Math.cos(t), Math.sin(t))')
    ? ok('the game turns degrees into radians with the convention the chart draws')
    : no('the game does not read an angle, or reads it with another convention')
  const toRad = (deg) => {
    const t = (deg * Math.PI) / 180
    return Math.atan2(-Math.cos(t), Math.sin(t))
  }
  const bad2 = []
  for (let deg = 0; deg < 360; deg += 7) {
    const v = vecOfBearing(deg)
    const want = Math.atan2(v[1], v[0])
    const got = toRad(deg)
    if (Math.abs(Math.atan2(Math.sin(want - got), Math.cos(want - got))) > 1e-6) bad2.push(deg)
  }
  bad2.length === 0
    ? ok('and it agrees at every angle round the circle, not only at the eight the words name')
    : no(`${bad2.length} angle(s) are drawn one way and moored another, first at ${bad2[0]}°`)
  }
}

// ---- and the coast rule tells rather than refuses --------------------------
// It knows ONE POINT, the middle of the painting, so a berth at the end of a jetty lying along that
// jetty reads as aimed at the land: the hub's own berth is 2 degrees off the middle and moored over
// open water. It could not be made right without the walkable mask, so it stopped blocking the save.
{
  const doc = {
    w: 4096,
    h: 4096,
    home: 'the_hub',
    places: [HUB_PLACE],
    regions: [],
    marks: [{ ...HUB_BERTH, facing: 'north' }],
  }
  const r = checkWorld(doc, ['hub'], new Map([['hub', HUB_MAP]]))
  r.problems.filter((s) => /bow|coast|straight at the middle/.test(s)).length === 0
    ? ok('a bow aimed at the island middle no longer refuses the save')
    : no('it is still a refusal, so a berth on a jetty cannot be saved')
  r.warnings.some((s) => s.includes('straight at the middle'))
    ? ok('and it is said as a warning, with the angle, so the author can judge it against the ghost')
    : no('nothing is said at all, so a bow in the rocks would ship silently')
}

console.log(bad ? `\n${bad} problem(s).` : '\na berth points along the shore or out to sea, and never into the land she is tied to.')
process.exit(bad ? 1 : 0)
