/* Does the behaviour maths reproduce the beach map's crab and gull? Run: npx tsx src/core/life.check.ts. The crab dashes within 4 tiles of home at 2.6-4.2 tiles/sec, freezes 1.2-4.7s and scuttles 1.5px; the gull is a 35s cycle with 9s of glide. */
import { cleanLife, lifeAt, type Life } from './life'

let bad = 0
const ok = (name: string, pass: boolean, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? '   ' + detail : ''}`)
}

// one tile is 32 painting pixels, so the crab's +-4 tiles is +-128px and its
// 2.6-4.2 tiles/sec is 83-134 px/sec
const crab = cleanLife({
  kind: 'wander',
  range: 128,
  speedMin: 83,
  speedMax: 134,
  pauseMin: 1.2,
  pauseMax: 4.7,
  bob: 1.5,
  bobRate: 3.5,
  faceMotion: true,
  seed: 7,
}) as Life
const home = { x: 300, y: 260 }

// ---- it must actually travel, and stay inside its range -------------------
let minX = Infinity
let maxX = -Infinity
let moved = 0
let still = 0
let flips = 0
let lastFlip = false
for (let i = 0; i < 4000; i++) {
  const t = i * 0.05
  const a = lifeAt(crab, t, home)
  const b = lifeAt(crab, t + 0.05, home)
  minX = Math.min(minX, a.dx)
  maxX = Math.max(maxX, a.dx)
  if (Math.abs(b.dx - a.dx) > 0.01) moved++
  else still++
  if (a.flip !== lastFlip) flips++
  lastFlip = a.flip
}
ok('crab travels', maxX - minX > 60, `spread ${(maxX - minX).toFixed(0)}px`)
ok('crab stays in range', minX > -170 && maxX < 170, `x from ${minX.toFixed(0)} to ${maxX.toFixed(0)}`)
ok('crab pauses as well as moves', still > 200 && moved > 200, `${moved} moving / ${still} still frames`)
ok('crab turns round', flips > 3, `${flips} direction changes`)

// ---- the thing that broke the frame version: it must NOT loop -------------
const p0 = lifeAt(crab, 0, home)
const p200 = lifeAt(crab, 200, home)
ok(
  'crab does not return to start (no loop)',
  Math.abs(p200.dx - p0.dx) > 1 || Math.abs(p200.dy - p0.dy) > 1,
  `t=0 (${p0.dx.toFixed(1)}, ${p0.dy.toFixed(1)})  t=200 (${p200.dx.toFixed(1)}, ${p200.dy.toFixed(1)})`,
)

// ---- pure: the same t always gives the same answer -----------------------
const a1 = lifeAt(crab, 61.37, home)
const a2 = lifeAt(crab, 61.37, home)
ok('same time, same answer', a1.dx === a2.dx && a1.dy === a2.dy && a1.flip === a2.flip)

// ---- two of them side by side must not move as one -----------------------
const crabB = { ...crab, seed: 99 }
let apart = 0
for (let i = 0; i < 400; i++) {
  const t = i * 0.1
  if (Math.abs(lifeAt(crab, t, home).dx - lifeAt(crabB, t, home).dx) > 4) apart++
}
ok('two crabs move differently', apart > 300, `${apart}/400 frames apart`)

// ---- continuity: no teleporting between frames ---------------------------
let jump = 0
for (let i = 0; i < 6000; i++) {
  const t = i * 0.016
  const a = lifeAt(crab, t, home)
  const b = lifeAt(crab, t + 0.016, home)
  if (Math.hypot(b.dx - a.dx, b.dy - a.dy) > 12) jump++
}
ok('crab never teleports', jump === 0, `${jump} jumps over 12px in one frame`)

// ---- the gull ------------------------------------------------------------
const gull = cleanLife({
  kind: 'cross',
  cycle: 35,
  travel: 9,
  fromX: 40,
  fromY: 180,
  toX: 640,
  toY: 140,
  swayAmp: 26,
  swayWaves: 1.4,
  fade: true,
  airborne: true,
  seed: 3,
}) as Life
const gh = { x: 40, y: 180 }
const away = lifeAt(gull, 20, gh)
const mid = lifeAt(gull, 4.5, gh)
const enter = lifeAt(gull, 0.05, gh)
ok('gull is absent between passes', away.alpha === 0, `alpha at t=20 is ${away.alpha}`)
ok('gull is present mid-pass', mid.alpha === 1, `alpha at t=4.5 is ${mid.alpha}`)
ok('gull fades in', enter.alpha > 0 && enter.alpha < 1, `alpha at t=0.05 is ${enter.alpha.toFixed(2)}`)
ok('gull crosses the map', Math.abs(mid.dx - 300) < 40, `mid-pass dx ${mid.dx.toFixed(0)} of 600`)
const g1 = lifeAt(gull, 3, gh)
const g2 = lifeAt(gull, 38, gh)
ok('gull repeats on its cycle', Math.abs(g1.dx - g2.dx) < 0.001, 'a pass every 35s')

// ---- bad input cannot crash it ------------------------------------------
ok('junk is refused', cleanLife({ kind: 'nonsense' }) === null)
ok('nothing is refused', cleanLife(null) === null)
const wild = cleanLife({ kind: 'wander', speedMin: 1e9, speedMax: -5, range: -100, seed: 0 }) as Life
const w = lifeAt(wild, 12.5, home)
ok('absurd numbers still render', isFinite(w.dx) && isFinite(w.dy), `dx ${w.dx.toFixed(1)}`)

// ---- a sequence: the troll -----------------------------------------------
/* Four states on a 63s round: rolls 26s, boulder 16s, rolls off 9s, settles 12s. The rolling state has to genuinely travel at 40-45 px/s, because a one-pixel drift nets out over a round and every continuity check below passed on code that teleported. */
const troll = cleanLife({
  kind: 'wander',
  range: 70,
  speedMin: 10,
  speedMax: 22,
  pauseMin: 0.8,
  pauseMax: 3,
  bob: 1,
  bobRate: 3,
  faceMotion: true,
  seed: 11,
  states: [
    { secs: 26, fade: 0.25 },
    { secs: 16, art: 1, fade: 0.4 },
    {
      secs: 9,
      art: 0,
      fade: 0.25,
      move: { kind: 'wander', range: 220, speedMin: 40, speedMax: 45, pauseMin: 0, pauseMax: 0.2, bob: 1, bobRate: 3, seed: 11 },
    },
    { secs: 12, art: 1, fade: 0.3 },
  ],
}) as Life
const th = { x: 400, y: 300 }
const ROUND = 63

ok('a sequence survives the guard', !!troll.states && troll.states.length === 4, `${troll.states?.length} states`)
ok(
  'the first state inherits the flat behaviour',
  troll.states![0].move?.kind === 'wander' && troll.states![0].move?.range === 70,
  `first move is ${troll.states![0].move?.kind}`,
)
ok('a state cannot carry states of its own', !troll.states![2].move?.states)
ok('one state is not a sequence', !cleanLife({ kind: 'drift', states: [{ secs: 5 }] })?.states)

// which picture, at the seconds the durations predict
const artAt = (t: number) => lifeAt(troll, t, th).art
ok(
  'the picture changes exactly on the boundaries',
  artAt(25.9) === 0 && artAt(26.1) === 1 && artAt(41.9) === 1 && artAt(42.1) === 0 && artAt(51.1) === 1,
  `${artAt(1)} ${artAt(30)} ${artAt(45)} ${artAt(55)}`,
)
ok('the round comes round again', artAt(5) === artAt(5 + ROUND) && artAt(45) === artAt(45 + ROUND * 3))

/* CONTINUITY over five whole rounds, because three was not enough to trust and 12px a frame was not tight enough to notice a wrap throwing away a whole round of travel. A clean frame costs about 2px (0.72 of travel plus the bob hop); pre-fix this fixture measured a worst step of 166.69px at t=314.99s, after 1.31px. */
let sjump = 0
let worst = 0
let worstT = 0
for (let i = 0; i < 20000; i++) {
  const t = i * 0.016
  const a = lifeAt(troll, t, th)
  const b = lifeAt(troll, t + 0.016, th)
  const d = Math.hypot(b.dx - a.dx, b.dy - a.dy)
  if (d > worst) {
    worst = d
    worstT = t
  }
  if (d > 3) sjump++
}
ok(
  'the troll never teleports, over five rounds',
  sjump === 0 && worst < 2.5,
  `worst step ${worst.toFixed(2)}px at t=${worstT.toFixed(2)}s, ${sjump} steps over 3px in ${((20000 * 0.016) / ROUND).toFixed(2)} rounds`,
)

/* THE TWO SEAMS, named and measured separately, because the sweep above can only say something jumped somewhere. Pre-fix the wraps measured 58.37 / 22.27 / 28.99 / 117.47 / 166.76px and re-entry 58.39 and 22.22px. Both are arithmetic, not luck, so half a pixel is generous. */
const d0 = 0.001
const jumpAt = (t: number) => {
  const a = lifeAt(troll, t - d0, th)
  const b = lifeAt(troll, t + d0, th)
  return Math.hypot(b.dx - a.dx, b.dy - a.dy)
}
let worstWrap = 0
for (let r = 1; r <= 5; r++) worstWrap = Math.max(worstWrap, jumpAt(ROUND * r))
ok('the round closes on itself', worstWrap < 0.5, `worst wrap jump ${worstWrap.toFixed(3)}px over 5 rounds`)

let worstSeam = 0
let worstSeamT = 0
let edge = 0
for (const s of troll.states!) {
  edge += s.secs
  if (edge >= ROUND) break
  for (let r = 0; r < 5; r++) {
    const j = jumpAt(r * ROUND + edge)
    if (j > worstSeam) {
      worstSeam = j
      worstSeamT = r * ROUND + edge
    }
  }
}
ok(
  'a state goes live where the last one stopped, every round',
  worstSeam < 0.5,
  `worst state change ${worstSeam.toFixed(3)}px at t=${worstSeamT.toFixed(0)}s`,
)

// and it has to have gone somewhere: a sequence that closes its round by
// standing still would pass everything above and be the dance this file exists
// to refuse
const r0 = lifeAt(troll, 5, th)
const r5 = lifeAt(troll, 5 + ROUND * 5, th)
ok(
  'the rolling state actually carries it somewhere',
  Math.hypot(r5.dx - r0.dx, r5.dy - r0.dy) > 40,
  `${Math.hypot(r5.dx - r0.dx, r5.dy - r0.dy).toFixed(0)}px from where it was five rounds ago`,
)

// the state's own clock: it freezes where it walked to and picks that up again
const before = lifeAt(troll, 26 - 0.01, th)
const after = lifeAt(troll, 26 + 0.01, th)
ok(
  'it turns to stone where it stood',
  Math.hypot(after.dx - before.dx, after.dy - before.dy) < 1 && before.art !== after.art,
  `moved ${Math.hypot(after.dx - before.dx, after.dy - before.dy).toFixed(3)}px across the change`,
)
const back = lifeAt(troll, 42 + 0.01, th)
ok(
  'and it unfurls from the same spot',
  Math.hypot(back.dx - after.dx, back.dy - after.dy) < 1.5,
  `${Math.hypot(back.dx - after.dx, back.dy - after.dy).toFixed(3)}px from where it froze`,
)

// pure, the property everything rests on
const s1 = lifeAt(troll, 47.31, th)
const s2 = lifeAt(troll, 47.31, th)
ok('a sequence is a function of t alone', s1.dx === s2.dx && s1.dy === s2.dy && s1.art === s2.art)

/* and EVERY field, asked for out of order: the editor scrubs and the game runs forward, so a placement that answered differently depending on what was asked before it would make the preview a lie. It also catches a lifeAt that started keeping state or reading a clock. */
const times = [0, 0.016, 3.5, 26, 41.99, 47.31, 62.9, 63, 126.5, 1800, 1937.19, 2400, 3600]
const forwards = times.map((t) => lifeAt(troll, t, th))
const shuffled = [7, 2, 11, 0, 9, 4, 12, 1, 6, 3, 10, 5, 8].map((i) => [i, lifeAt(troll, times[i], th)] as const)
let sameEvery = true
for (const [i, a] of shuffled) {
  const b = forwards[i]
  if (a.dx !== b.dx || a.dy !== b.dy || a.flip !== b.flip || a.alpha !== b.alpha || a.facing !== b.facing || a.moving !== b.moving || a.rot !== b.rot || a.art !== b.art)
    sameEvery = false
}
ok('and every field of it, whatever order it is asked in', sameEvery, `${times.length} times read forwards then shuffled`)

// a boulder does not walk, and the fade dips at the change
const held = lifeAt(troll, 30, th)
const held2 = lifeAt(troll, 34, th)
ok('a state with no move stands still', held.dx === held2.dx && held.dy === held2.dy && !held.moving)
ok('the picture dissolves rather than cuts', lifeAt(troll, 26.05, th).alpha < 0.6, `alpha ${lifeAt(troll, 26.05, th).alpha.toFixed(2)}`)

// ---- art is an INDEX, and only ever an index -----------------------------
/* The planner answers in names and the server turns them into numbers, so the guard's job is that a name which slipped past lands on 0, the placement's own picture, rather than on some other creature's. */
const named = cleanLife({
  kind: 'drift',
  states: [{ secs: 5, art: 'mossy boulder' }, { secs: 5, art: 2 }, { secs: 5, art: 99 }, { secs: 5, art: -3 }],
}) as Life
ok(
  'a name that reached the guard draws the placement itself',
  named.states![0].art === 0,
  `"mossy boulder" cleaned to ${named.states![0].art}`,
)
ok('an index is kept as it is', named.states![1].art === 2)
ok(
  'and an index off the end is held to the seven looks a placement can carry',
  named.states![2].art === 7 && named.states![3].art === 0,
  `99 -> ${named.states![2].art}, -3 -> ${named.states![3].art}`,
)

/* ---- THE FLOOR, INSIDE A SEQUENCE. The 35% law worked on a placement with no sequence and quietly did not inside one: every state was worked out from the PLACEMENT'S home while the sprite was drawn at home plus everything earlier states had travelled, so the walk rejected legs measured from one point and stood at another. A 40px path down a 100px box measured 15 frames of 20000 off it with no sequence and 5630 with one, 19.7px out; after, 7 frames and 0.2px. The 0.6px floor is the bob hop, which is why the threshold is a pixel and not zero. */
const BOX = { x: 100, y: 100, w: 100, h: 100 }
const PATH = { y0: 130, y1: 170 }
const onPath = (x: number, y: number) => x >= BOX.x && x < BOX.x + BOX.w && y >= PATH.y0 && y < PATH.y1
const fenced = {
  kind: 'wander',
  bounds: BOX,
  walkOnly: true,
  walkPct: 0.4,
  range: 60,
  speedMin: 12,
  speedMax: 24,
  pauseMin: 0.5,
  pauseMax: 2,
  bob: 1,
  bobRate: 3,
  faceMotion: true,
  seed: 11,
}
const fencedPlain = cleanLife(fenced) as Life
const fencedSeq = cleanLife({
  ...fenced,
  states: [
    { secs: 26, fade: 0.25 },
    { secs: 16, art: 1, fade: 0.4 },
    { secs: 9, art: 0, fade: 0.25, move: { kind: 'wander', range: 220, speedMin: 40, speedMax: 45, pauseMin: 0, pauseMax: 0.2, bob: 1, bobRate: 3, seed: 11 } },
    { secs: 12, art: 1, fade: 0.3 },
  ],
}) as Life
const fh = { x: 150, y: 150 }
const strayed = (l: Life): [number, number] => {
  let n = 0
  let w = 0
  for (let i = 0; i < 20000; i++) {
    const a = lifeAt(l, i * 0.016, fh, onPath)
    const x = fh.x + a.dx
    const y = fh.y + a.dy
    const e = Math.max(0, BOX.x - x, x - (BOX.x + BOX.w), PATH.y0 - y, y - PATH.y1)
    if (e > 0.001) {
      n++
      if (e > w) w = e
    }
  }
  return [n, w]
}
const [pn, pw] = strayed(fencedPlain)
const [sn, sw] = strayed(fencedSeq)
ok('a fenced walk keeps to the path', pn < 60 && pw < 1, `${pn}/20000 frames off, worst ${pw.toFixed(2)}px, no sequence`)

/* and it walks the SAME path it always did. The four hashes below are taken with no floor, so on their own they say nothing about the placements that had one. This is the same 20000 frames with the floor in force, checked against git show HEAD. */
let gf = 2166136261
const eatF = (s: string) => {
  for (let i = 0; i < s.length; i++) {
    gf ^= s.charCodeAt(i)
    gf = Math.imul(gf, 16777619)
  }
}
for (let i = 0; i < 20000; i++) {
  const a = lifeAt(fencedPlain, i * 0.016, fh, onPath)
  eatF(`${a.dx}|${a.dy}|${a.flip}|${a.alpha}|${a.facing}|${a.moving}|${a.rot};`)
}
const fenceHash = (gf >>> 0).toString(16).padStart(8, '0')
ok('and it is the same walk the floor always gave it', fenceHash === 'c9443de3', `${fenceHash} against c9443de3, 20000 frames with the floor in force`)
ok(
  'and it keeps to the same path inside a sequence',
  sn < pn * 4 + 40 && sw < 1,
  `${sn}/20000 frames off, worst ${sw.toFixed(2)}px, with a four state round`,
)

/* AND THE SAME PATH TURNED ON ITS SIDE, WHICH IS NOT THE SAME QUESTION. The old share squeezed only a state's HEIGHT, so a path lying across the box came out inside the squeeze with 2.5px to spare and one running up it did not: 1360 frames off it and 9.40px out, against 0 for the flat one. A fixture that only works one way up is not a fixture. */
const UPPATH = { x0: 130, x1: 170 }
const upPath = (x: number, y: number) => y >= BOX.y && y < BOX.y + BOX.h && x >= UPPATH.x0 && x < UPPATH.x1
const strayedUp = (l: Life): [number, number] => {
  let n = 0
  let w = 0
  for (let i = 0; i < 20000; i++) {
    const a = lifeAt(l, i * 0.016, fh, upPath)
    const x = fh.x + a.dx
    const y = fh.y + a.dy
    const e = Math.max(0, UPPATH.x0 - x, x - UPPATH.x1, BOX.y - y, y - (BOX.y + BOX.h))
    if (e > 0.001) {
      n++
      if (e > w) w = e
    }
  }
  return [n, w]
}
const [un, uw] = strayedUp(fencedSeq)
const [upn] = strayedUp(fencedPlain)
ok(
  'and it keeps to that path with the corridor turned on its side too',
  un < upn * 4 + 40 && uw < 1,
  `${un}/20000 frames off, worst ${uw.toFixed(2)}px, against ${upn} with no round`,
)

/* and the anchor walking with the round must not have cost the continuity the
 * sequence work bought. Same three seams as the troll below, on the fenced
 * walker, where the anchor is the thing that moves. */
let fWorst = 0
for (let i = 0; i < 20000; i++) {
  const a = lifeAt(fencedSeq, i * 0.016, fh, onPath)
  const b = lifeAt(fencedSeq, i * 0.016 + 0.016, fh, onPath)
  fWorst = Math.max(fWorst, Math.hypot(b.dx - a.dx, b.dy - a.dy))
}
ok('a fenced sequence never teleports either', fWorst < 2.5, `worst step ${fWorst.toFixed(3)}px over 20000 frames`)

/* ---- A PASS IS NOT A STATE. Every other kind answers an offset from home, but a cross answers an absolute point and for most of its cycle answers dx 0 dy 0 meaning absent, and adding absent walks the placement off the island: max dx 737px on a 688px map with a single frame step of 404px. Both doors are shut: a state naming a cross stands still, and a cross handed states loses them, because the first state is BUILT from the flat fields and that path measured 356px on its own. */
const passState = cleanLife({
  kind: 'wander',
  range: 60,
  speedMin: 12,
  speedMax: 24,
  pauseMin: 0.5,
  pauseMax: 2,
  bob: 1,
  bobRate: 3,
  seed: 11,
  states: [{ secs: 30 }, { secs: 30, move: { kind: 'cross', cycle: 30, travel: 20, fromX: 0, fromY: 300, toX: 700, toY: 300, swayAmp: 0, seed: 11 } }],
}) as Life
ok('a state that asked to be a pass stands still instead', !passState.states![1].move, `state two is ${passState.states![1].move ? passState.states![1].move.kind : 'still'}`)
const passHome = { x: 344, y: 300 }
let pmx = 0
let pmy = 0
let pstep = 0
for (let i = 0; i < 20000; i++) {
  const a = lifeAt(passState, i * 0.016, passHome)
  const b = lifeAt(passState, i * 0.016 + 0.016, passHome)
  pmx = Math.max(pmx, Math.abs(a.dx))
  pmy = Math.max(pmy, Math.abs(a.dy))
  pstep = Math.max(pstep, Math.hypot(b.dx - a.dx, b.dy - a.dy))
}
ok(
  'so the round stays on a 688px map',
  pmx < 344 && pmy < 300 && pstep < 2.5,
  `max |dx| ${pmx.toFixed(1)}px, max |dy| ${pmy.toFixed(1)}px, worst step ${pstep.toFixed(2)}px`,
)
const passFlat = cleanLife({
  kind: 'cross',
  cycle: 30,
  travel: 20,
  fromX: 0,
  fromY: 300,
  toX: 700,
  toY: 300,
  swayAmp: 0,
  seed: 11,
  states: [{ secs: 30 }, { secs: 30, art: 1 }],
}) as Life
ok('and a pass handed a round keeps the pass and loses the round', !passFlat.states, `states: ${passFlat.states ? passFlat.states.length : 'none'}`)
/* and losing the round leaves the pass EXACTLY as it was, which is the point. A pass does leave the map and fades to alpha 0 while it is away, so nothing is drawn out there. What made the state version a bug is that a state is drawn the whole time. */
const passAlone = cleanLife({ kind: 'cross', cycle: 30, travel: 20, fromX: 0, fromY: 300, toX: 700, toY: 300, swayAmp: 0, seed: 11 }) as Life
let passSame = true
let passAway = 0
for (let i = 0; i < 20000; i++) {
  const a = lifeAt(passFlat, i * 0.016, passHome)
  const b = lifeAt(passAlone, i * 0.016, passHome)
  if (a.dx !== b.dx || a.dy !== b.dy || a.alpha !== b.alpha || a.art !== b.art) passSame = false
  if (a.alpha <= 0.01) passAway++
}
ok('and the pass itself is untouched', passSame, `20000 frames against the same cross with no states`)
ok('a pass is absent for most of its cycle', passAway > 20000 * 0.3, `${passAway}/20000 frames at alpha 0`)

// ---- nothing without a sequence changed ----------------------------------
let artZero = true
for (let i = 0; i < 500; i++) if (lifeAt(crab, i * 0.37, home).art !== 0) artZero = false
ok('a placement with no sequence always draws art 0', artZero)
ok('and an old bundle still cleans to no states', !crab.states && !gull.states)

/* THE OLD BUNDLES, PIXEL FOR PIXEL. Every exported map draws placements with no sequence, and the sequence work must not move one by a rounding error, so 20000 frames of each behaviour fold into one number checked against git show HEAD. A hash rather than a table, because the only question is whether a single one of them moved. */
const trace = (l: Life, h: { x: number; y: number }, n: number): string => {
  let g = 2166136261
  const eat = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      g ^= s.charCodeAt(i)
      g = Math.imul(g, 16777619)
    }
  }
  for (let i = 0; i < n; i++) {
    const a = lifeAt(l, i * 0.016, h)
    eat(`${a.dx}|${a.dy}|${a.flip}|${a.alpha}|${a.facing}|${a.moving}|${a.rot};`)
  }
  return (g >>> 0).toString(16).padStart(8, '0')
}
// a moored boat and a circling gull, so the two kinds the crab and the gull do
// not cover are under the same guard. The boat leans as well, which is the only
// thing that puts a non-zero rot in the trace.
const boat = cleanLife({ kind: 'drift', driftX: 3, driftY: 1.5, period: 5.5, rock: 4, rockRate: 0.3, seed: 21 }) as Life
const circler = cleanLife({ kind: 'orbit', period: 17, radiusX: 60, radiusY: 22, bob: 2, bobRate: 2.5, seed: 5 }) as Life
const golden: [string, Life, { x: number; y: number }, string][] = [
  ['wander', crab, home, '2b2a0208'],
  ['cross', gull, gh, 'd48a575d'],
  ['drift', boat, home, 'a1524e5c'],
  ['orbit', circler, home, 'cf34c31c'],
]
for (const [name, l, h, want] of golden) {
  const got = trace(l, h, 20000)
  ok(`${name} with no states is unchanged from before sequences existed`, got === want, `${got} against ${want}, 20000 frames`)
}

/* THE 32 MINUTE FREEZE. The walk used to fall off the end of its legs and answer still, teleporting the thing home to stand there visible for the rest of the session: measured on this crab, moving at t=1800s and frozen from t=1932.92s, inside a 30 to 45 minute advisory session. A sample cannot prove it is alive, because a wander is mostly pauses, so the test is that it still COVERS GROUND across sixty seconds at each mark. */
for (const t0 of [1800, 2400, 3600, 5400, 20000]) {
  let lo = Infinity
  let hi = -Infinity
  let mv = 0
  for (let i = 0; i < 3750; i++) {
    const a = lifeAt(crab, t0 + i * 0.016, home)
    lo = Math.min(lo, a.dx)
    hi = Math.max(hi, a.dx)
    if (a.moving) mv++
  }
  ok(
    `the wander is still walking at t=${t0}s`,
    hi - lo > 60,
    `${(hi - lo).toFixed(1)}px of dx over the next 60s, moving ${((100 * mv) / 3750).toFixed(0)}% of them`,
  )
}

/* and the round closes rather than restarting from the anchor, or the freeze has only become a teleport every 32 minutes. Swept rather than read at one instant, because the crab's round is 1937.19s and the old snap home was at 1932.92s, so a probe at either would miss the other. Before 90.63px, after 1.50px, all of it the bob hop. */
let worstRound = 0
let worstRoundT = 0
for (let t = 1900; t < 1990; t += 0.0005) {
  const a = lifeAt(crab, t, home)
  const b = lifeAt(crab, t + 0.0005, home)
  const d = Math.hypot(b.dx - a.dx, b.dy - a.dy)
  if (d > worstRound) {
    worstRound = d
    worstRoundT = t
  }
}
ok(
  'the walk wraps without a teleport',
  worstRound < 2.5,
  `worst step ${worstRound.toFixed(4)}px at t=${worstRoundT.toFixed(3)}s, swept 1900..1990s`,
)

/* THE PRE-CAP WINDOW, PIXEL FOR PIXEL. The hashes above cover 320s, a tenth of the way to the cap, so they say nothing about the legs near it. This walks the whole 1900s below the cap at 20 samples a second, folded to 55711aa4 from git show HEAD: the fix adds a leg AFTER the 512th, so every leg before it must land identically. */
let gl = 2166136261
const eatL = (s: string) => {
  for (let i = 0; i < s.length; i++) {
    gl ^= s.charCodeAt(i)
    gl = Math.imul(gl, 16777619)
  }
}
for (let i = 0; i <= 38000; i++) {
  const a = lifeAt(crab, i * 0.05, home)
  eatL(`${a.dx}|${a.dy}|${a.flip}|${a.alpha}|${a.facing}|${a.moving}|${a.rot};`)
}
const long = (gl >>> 0).toString(16).padStart(8, '0')
ok('nothing below the cap moved', long === '55711aa4', `${long} against 55711aa4, 38001 samples over 1900s`)

/* WHAT THE ROUND COSTS. The cap bounds the price of a call and still has to: the hub has 94 placements on school Chromebooks. The round costs one extra walk to learn its own length, measured 14.1us at t=3600s before and 27.2us after, and then FLAT, so t=1e9 costs the same as t=3600. The threshold is loose because a wall clock in a test is noisy; what is caught is growth by a factor. */
const perCall = (t: number, n: number) => {
  for (let i = 0; i < 200; i++) lifeAt(crab, t + i * 1e-6, home)
  let best = Infinity
  for (let r = 0; r < 5; r++) {
    const s = process.hrtime.bigint()
    for (let i = 0; i < n; i++) lifeAt(crab, t + i * 1e-6, home)
    best = Math.min(best, Number(process.hrtime.bigint() - s) / 1000 / n)
  }
  return best
}
const cLate = perCall(3600, 4000)
const cHuge = perCall(1e9, 4000)
ok(
  'the cost stops growing once the round is known',
  cHuge < cLate * 2,
  `${cLate.toFixed(1)}us at t=3600s, ${cHuge.toFixed(1)}us at t=1e9s`,
)
ok('and a fresh placement is still nearly free', perCall(0, 200000) < 1, `${perCall(0, 200000).toFixed(3)}us at t=0`)

/* ---- A BOXED ROUND: THE LIVE STATE HAS TO BE THE ONE ON SCREEN. A fenced state answered with a POSITION rather than a displacement, so the last state carrying a move overwrote every earlier one. Three states asking 12-24, 5 and 200 px/s measured 3.9, 2.0 and 196.9 with the drawn position being the last mover's own on 55.8% of 20000 frames; after, 17.3, 5.0 and 186.7 and 0.0%. Speeds are read only across moving frames, and the 200 reads 199.4 at a 1ms sample, so the gap is the stopwatch. */
const BOXR = { x: 100, y: 100, w: 200, h: 200 }
const bh = { x: 200, y: 200 }
const boxed = cleanLife({
  kind: 'wander',
  bounds: BOXR,
  range: 90,
  speedMin: 12,
  speedMax: 24,
  pauseMin: 0.4,
  pauseMax: 1.2,
  bob: 0,
  bobRate: 0,
  seed: 5,
  states: [
    { secs: 40 },
    { secs: 30, art: 1, move: { kind: 'wander', speedMin: 5, speedMax: 5, pauseMin: 0.4, pauseMax: 1.2, bob: 0, seed: 6 } },
    { secs: 30, art: 2, move: { kind: 'wander', speedMin: 200, speedMax: 200, pauseMin: 0.4, pauseMax: 1.2, bob: 0, seed: 7 } },
  ],
}) as Life
const BROUND = 100
const liveAt = (t: number) => {
  const p = ((t % BROUND) + BROUND) % BROUND
  return p < 40 ? 0 : p < 70 ? 1 : 2
}
const drew = [0, 0, 0]
const forS = [0, 0, 0]
for (let i = 0; i < 60000; i++) {
  const t = 60 + i * 0.016
  const a = lifeAt(boxed, t, bh)
  if (!a.moving) continue
  const b = lifeAt(boxed, t + 0.016, bh)
  const k = liveAt(t)
  drew[k] += Math.hypot(b.dx - a.dx, b.dy - a.dy)
  forS[k] += 0.016
}
const px = [drew[0] / forS[0], drew[1] / forS[1], drew[2] / forS[2]]
ok(
  'a boxed state draws the speed it asked for',
  px[0] > 10 && px[0] < 26 && px[1] > 4 && px[1] < 6 && px[2] > 150,
  `asked 12-24 / 5 / 200 px/s, drew ${px[0].toFixed(1)} / ${px[1].toFixed(1)} / ${px[2].toFixed(1)}`,
)

/* and the position is not the last moving state's own. That is the shape of the
 * bug rather than a symptom of it: if the sum has been replaced, the answer IS
 * that state's position, exactly, on every frame. */
const lastMover = (boxed.states as NonNullable<Life['states']>).length - 1
let sameAsLast = 0
for (let i = 0; i < 20000; i++) {
  const t = 60 + i * 0.016
  const k = liveAt(t)
  const c = Math.floor(t / BROUND)
  const into = ((t % BROUND) + BROUND) % BROUND - (k === 0 ? 0 : k === 1 ? 40 : 70)
  const st = (boxed.states as NonNullable<Life['states']>)[lastMover]
  const own = (lastMover < k ? c + 1 : c) * st.secs + (lastMover === k ? into : 0)
  const a = lifeAt(boxed, t, bh)
  const z = lifeAt(st.move as Life, own, bh)
  if (Math.hypot(a.dx - z.dx, a.dy - z.dy) < 0.0005) sameAsLast++
}
ok(
  'and it is not just the last moving state showing through',
  sameAsLast < 20000 * 0.02,
  `${((100 * sameAsLast) / 20000).toFixed(1)}% of 20000 frames sat exactly on the last moving state, against 55.8% before`,
)

/* ---- WHAT A BOX MEANS INSIDE A ROUND: the box is the room the WHOLE ROUND has and the movers divide it. The live state decides everything watchable at full asking; a state that is not live decides only how far it has already carried the thing. Deliberately lopsided at 15 against 120 px/s and read from the corner as well as the middle, because the old share gave every state the same reach both ways and the sum overran the short side: 54.9% of 60000 frames held against the fence and 8.6% of moving frames covering no ground. After, 0.0% and 0.0%. Three sweep starts, because t=0 is where a fault of this kind hides. */
const NBOX = { x: 100, y: 100, w: 100, h: 100 }
const nRound = (slow: number) =>
  cleanLife({
    kind: 'wander',
    bounds: NBOX,
    range: 60,
    speedMin: slow,
    speedMax: slow,
    pauseMin: 0.5,
    pauseMax: 2,
    bob: 0,
    bobRate: 0,
    seed: 11,
    states: [
      { secs: 22 },
      { secs: 18, art: 1, move: { kind: 'wander', speedMin: 120, speedMax: 120, pauseMin: 0.5, pauseMax: 2, bob: 0, seed: 511 } },
    ],
  }) as Life
const nAlone = (sp: number, seed: number) =>
  cleanLife({ kind: 'wander', bounds: NBOX, range: 60, speedMin: sp, speedMax: sp, pauseMin: 0.5, pauseMax: 2, bob: 0, bobRate: 0, seed }) as Life
const NR = 40
const nLive = (t: number) => (((t % NR) + NR) % NR < 22 ? 0 : 1)

/* one sweep, every reading taken off it. `want` picks which state's live windows
 * to read, or null for the whole round. */
const readRound = (l: Life, h: { x: number; y: number }, want: number | null, t0: number, n: number) => {
  let dist = 0
  let movT = 0
  let allT = 0
  let lox = Infinity
  let hix = -Infinity
  let loy = Infinity
  let hiy = -Infinity
  let fence = 0
  let pinned = 0
  let movN = 0
  let frames = 0
  let run = 0
  let longestStill = 0
  for (let i = 0; i < n; i++) {
    const t = t0 + i * 0.016
    if (want !== null && (nLive(t) !== want || nLive(t + 0.016) !== want)) continue
    const a = lifeAt(l, t, h)
    const b = lifeAt(l, t + 0.016, h)
    const x = h.x + a.dx
    const y = h.y + a.dy
    const d = Math.hypot(b.dx - a.dx, b.dy - a.dy)
    allT += 0.016
    frames++
    lox = Math.min(lox, x)
    hix = Math.max(hix, x)
    loy = Math.min(loy, y)
    hiy = Math.max(hiy, y)
    /* sitting EXACTLY on an edge is the hold biting. A walk that merely arrives
     * near one lands on a real number and misses it, so this counts the hold and
     * not the walk. */
    if (
      Math.abs(x - NBOX.x) < 1e-9 ||
      Math.abs(x - (NBOX.x + NBOX.w)) < 1e-9 ||
      Math.abs(y - NBOX.y) < 1e-9 ||
      Math.abs(y - (NBOX.y + NBOX.h)) < 1e-9
    )
      fence++
    if (a.moving) {
      dist += d
      movT += 0.016
      movN++
      // bob is 0 on this fixture, so a moving frame that covers nothing is
      // genuinely pinned rather than at the top of a hop
      if (d < 1e-9) pinned++
      run = 0
    } else {
      run += 0.016
      if (run > longestStill) longestStill = run
    }
  }
  return {
    px: dist / movT,
    movPct: (100 * movT) / allT,
    spanX: hix - lox,
    spanY: hiy - loy,
    fencePct: (100 * fence) / frames,
    pinPct: (100 * pinned) / Math.max(1, movN),
    longestStill,
  }
}

const nMid = { x: 150, y: 150 }
const nCorner = { x: 105, y: 105 }
let worstSlow = [Infinity, -Infinity]
let worstFast = [Infinity, -Infinity]
let leastSpan = Infinity
let worstFence = 0
let worstPin = 0
let worstStill = 0
console.log('\na two state round in a 100x100 box, one state asking 15 px/s and one asking 120:')
for (const [h, where] of [
  [nMid, 'from the middle'],
  [nCorner, '5px in from the corner'],
] as [{ x: number; y: number }, string][]) {
  for (const t0 of [0, 12000, 300000]) {
    const l = nRound(15)
    const s0 = readRound(l, h, 0, t0, 60000)
    const s1 = readRound(l, h, 1, t0, 60000)
    const whole = readRound(l, h, null, t0, 60000)
    worstSlow = [Math.min(worstSlow[0], s0.px), Math.max(worstSlow[1], s0.px)]
    worstFast = [Math.min(worstFast[0], s1.px), Math.max(worstFast[1], s1.px)]
    leastSpan = Math.min(leastSpan, whole.spanX, whole.spanY)
    worstFence = Math.max(worstFence, whole.fencePct)
    worstPin = Math.max(worstPin, whole.pinPct)
    worstStill = Math.max(worstStill, s1.longestStill)
    console.log(
      `  ${where.padEnd(23)} t0=${String(t0).padStart(6)}s  drew ${s0.px.toFixed(1)} / ${s1.px.toFixed(1)} px/s  ` +
        `covers ${whole.spanX.toFixed(0)}x${whole.spanY.toFixed(0)}  on the fence ${whole.fencePct.toFixed(1)}%  pinned ${whole.pinPct.toFixed(1)}%`,
    )
  }
}
/* The band is wide on the fast state for the same reason the older reading above
 * says: a 16ms frame that straddles the end of a leg counts the whole frame and
 * only part of the travel, which costs a 120 more than it costs a 15. */
ok(
  'every state of a boxed round draws the speed IT asked for',
  worstSlow[0] > 13.5 && worstSlow[1] < 16.5 && worstFast[0] > 105 && worstFast[1] < 132,
  `asked 15 / 120, drew ${worstSlow[0].toFixed(1)}-${worstSlow[1].toFixed(1)} / ${worstFast[0].toFixed(1)}-${worstFast[1].toFixed(1)} px/s over 6 sweeps`,
)
/* The whole box is too much to ask of a walk that picks targets at random, so the bar is that the round clearly uses the room it was given: twelve readings land between 84 and 96px of the 100, against the 32 the flattening left. */
ok(
  'and the round uses the box the person actually drew',
  leastSpan > 80,
  `the tightest of 12 readings covers ${leastSpan.toFixed(0)}px of a 100px box, against 32 before`,
)
ok(
  'and the hold on the sum never has to bite, wherever it stands in its box',
  worstFence < 0.5 && worstPin < 0.1,
  `worst ${worstFence.toFixed(1)}% of 60000 frames on the fence and ${worstPin.toFixed(1)}% of the moving ones pinned, against 54.9% and 8.6%`,
)

/* and a boxed state must not spend its life standing about. Its legs ARE shorter because its share is, and two movers predicts 15% walking against 26% alone, which is what it measures. What is NOT allowed is the old share's collapse to 11%, which squeezed the state into a fifth of the box's height. */
const aloneFast = readRound(nAlone(120, 511), nMid, null, 12000, 60000)
const inRoundFast = readRound(nRound(15), nMid, 1, 12000, 60000)
ok(
  'and a state in a round walks at least half as much of the time as it would alone',
  inRoundFast.movPct > aloneFast.movPct * 0.5,
  `moving ${inRoundFast.movPct.toFixed(0)}% of its live windows against ${aloneFast.movPct.toFixed(0)}% with no round, 11% before`,
)
ok(
  'and it stands still for no longer at a stretch than it would alone',
  worstStill < aloneFast.longestStill * 1.5 + 0.1,
  `longest ${worstStill.toFixed(2)}s against ${aloneFast.longestStill.toFixed(2)}s, both inside the 2s pause it asked for`,
)

/* ---- AND A STATE THAT IS NOT LIVE DECIDES NOTHING YOU CAN SEE. Read without knowing how the round works inside, because a check that rebuilds the implementation only proves it equals itself: two rounds differing only in state zero's speed must step identically while state ONE is live. The control is the other half: while state ZERO is live the two MUST differ. */
const nA = nRound(15)
const nB = nRound(60)
let liveDiffer = 0
let worstStepGap = 0
let controlDiffer = 0
for (let i = 0; i < 60000; i++) {
  const t = 12000 + i * 0.016
  const k = nLive(t)
  if (nLive(t + 0.016) !== k) continue
  const a1 = lifeAt(nA, t, nCorner)
  const b1 = lifeAt(nA, t + 0.016, nCorner)
  const a2 = lifeAt(nB, t, nCorner)
  const b2 = lifeAt(nB, t + 0.016, nCorner)
  const g = Math.hypot(b1.dx - a1.dx - (b2.dx - a2.dx), b1.dy - a1.dy - (b2.dy - a2.dy))
  if (k === 1) {
    if (g > 1e-9) {
      liveDiffer++
      worstStepGap = Math.max(worstStepGap, g)
    }
  } else if (g > 1e-9) controlDiffer++
}
ok(
  'changing a state that is not live does not move the one that is',
  liveDiffer === 0,
  `${liveDiffer} frames moved by the other state's speed, worst ${worstStepGap.toFixed(3)}px`,
)
ok(
  'and the reading can tell the difference when it should',
  controlDiffer > 1000,
  `${controlDiffer} frames differ while the state whose speed changed IS the live one`,
)

/* ---- NOBODY MARCHES ON THE SPOT. moving is what runs the walk cycle, and bob is 0 here, so a moving frame covering no ground is genuinely pinned. The pin was the fence: states' distances piled up and the hold took the difference, leaving the placement against the box edge with its legs going. 27.8% of 187499 frames and 8.30s unbroken before, 0.0% after. */
const MBOX = { x: 100, y: 100, w: 100, h: 100 }
const mh = { x: 150, y: 150 }
const mflat = { kind: 'wander', bounds: MBOX, range: 60, speedMin: 12, speedMax: 24, pauseMin: 0.8, pauseMax: 2.5, bob: 0, bobRate: 0, seed: 11 }
const marchy = cleanLife({
  ...mflat,
  states: [
    { secs: 26 },
    { secs: 16, art: 1, move: { kind: 'wander', speedMin: 8, speedMax: 14, pauseMin: 1, pauseMax: 3, bob: 0, seed: 12 } },
    { secs: 18, art: 2, move: { kind: 'wander', speedMin: 30, speedMax: 45, pauseMin: 0.5, pauseMax: 2, bob: 0, seed: 13 } },
  ],
}) as Life
const marches = (l: Life): [number, number] => {
  let n = 0
  let run = 0
  let longest = 0
  let prev = lifeAt(l, 60, mh)
  const frames = 187499
  for (let i = 1; i <= frames; i++) {
    const a = lifeAt(l, 60 + i * 0.016, mh)
    if (prev.moving && Math.hypot(a.dx - prev.dx, a.dy - prev.dy) < 1e-9) {
      n++
      run += 0.016
      if (run > longest) longest = run
    } else run = 0
    prev = a
  }
  return [(100 * n) / frames, longest]
}
const [mp, ml] = marches(marchy)
const [mp0] = marches(cleanLife(mflat) as Life)
ok(
  'nothing walks on the spot inside a round',
  mp < 0.5 && ml < 0.5,
  `${mp.toFixed(2)}% of 187499 frames, longest ${ml.toFixed(2)}s, against ${mp0.toFixed(2)}% with no round`,
)

/* ---- A FENCED ROUND DOES NOT TELEPORT, ON ANY SEED. A floor-fenced walk's legs are a BOOLEAN function of where it starts, so nothing a state is worked out from may move while its own clock stands still. 200 seeds, because whether a candidate sits near the floor's edge is luck. Swept from t=12000s, because the error grows with completed rounds: the same broken code measured 0 seeds over 2.5px at t=1200 and 200 at t=30000. Anchoring only the live state instead put a 76 to 95px jump at every state change on all 200 seeds, worst 89.65px, which is why the round is a sum. After: 0 of 200. */
const seedSweep = (h: { x: number; y: number }, t0: number) => {
  let jumpy = 0
  let worstJump = 0
  let worstJumpSeed = 0
  for (let s = 1; s <= 200; s++) {
    const l = cleanLife({
      kind: 'wander',
      bounds: BOX,
      walkOnly: true,
      walkPct: 0.4,
      range: 60,
      speedMin: 12,
      speedMax: 24,
      pauseMin: 0.5,
      pauseMax: 2,
      bob: 0,
      seed: s,
      states: [
        { secs: 22 },
        { secs: 18, art: 1, move: { kind: 'wander', speedMin: 20, speedMax: 30, pauseMin: 0.3, pauseMax: 1.2, bob: 0, seed: s + 500 } },
      ],
    }) as Life
    let w = 0
    let prev = lifeAt(l, t0, h, onPath)
    for (let i = 1; i < 2600; i++) {
      const a = lifeAt(l, t0 + i * 0.016, h, onPath)
      const d = Math.hypot(a.dx - prev.dx, a.dy - prev.dy)
      if (d > w) w = d
      prev = a
    }
    if (w > 2.5) jumpy++
    if (w > worstJump) {
      worstJump = w
      worstJumpSeed = s
    }
  }
  return { jumpy, worstJump, worstJumpSeed }
}
let jumpySeeds = 0
let jumpiest = 0
let jumpiestSeed = 0
let jumpiestWhere = ''
console.log('\ntwo fenced wanders on a round, 200 seeds each, worst single frame step:')
for (const [h, where, t0] of [
  [fh, 'from the middle', 12000],
  [{ x: 105, y: 135 }, 'from the corner', 12000],
  [{ x: 105, y: 135 }, 'from the corner', 300000],
] as [{ x: number; y: number }, string, number][]) {
  const r = seedSweep(h, t0)
  console.log(`  ${where}, t0=${String(t0).padStart(6)}s: ${r.jumpy}/200 over 2.5px, worst ${r.worstJump.toFixed(2)}px on seed ${r.worstJumpSeed}`)
  jumpySeeds += r.jumpy
  if (r.worstJump > jumpiest) {
    jumpiest = r.worstJump
    jumpiestSeed = r.worstJumpSeed
    jumpiestWhere = `${where} at t0=${t0}s`
  }
}
ok(
  'a fenced round holds together on every seed',
  jumpySeeds === 0 && jumpiest < 2.5,
  `${jumpySeeds}/600 seed sweeps step over 2.5px, worst ${jumpiest.toFixed(2)}px on seed ${jumpiestSeed} ${jumpiestWhere}`,
)

/* ---- AND IT DOES NOT GET WORSE THE LONGER THE SESSION RUNS, which is the gate the last round of work did not have: every sweep started at t=0 where the fault was 1.59px and looked like rounding. Worst step by sweep start before: 0.71px at t=0, 1.35 at 12000, 82.42 at 60000, 128.56 at 300000. After, flat at 0.71. A map left open in the editor is not a 45 minute session. */
let worstLate = 0
let worstLateT0 = 0
const lateLine: string[] = []
for (const t0 of [0, 3600, 12000, 60000, 300000]) {
  let w = 0
  let prev = lifeAt(marchy, t0, mh)
  for (let i = 1; i < 20000; i++) {
    const a = lifeAt(marchy, t0 + i * 0.016, mh)
    const d = Math.hypot(a.dx - prev.dx, a.dy - prev.dy)
    if (d > w) w = d
    prev = a
  }
  lateLine.push(`${t0}:${w.toFixed(2)}`)
  if (w > worstLate) {
    worstLate = w
    worstLateT0 = t0
  }
}
ok(
  'a round costs the same step at t=300000s as at t=0',
  worstLate < 2.5,
  `worst step by sweep start ${lateLine.join('  ')}, worst ${worstLate.toFixed(2)}px at t0=${worstLateT0}`,
)

/* ---- WHAT A ROUND COSTS PER CALL. The two-pass ceiling is per MOVING STATE, not per call, so a six state round is six walks. Measured at t=1e5 before and after: plain 28.3 / 28.5us, two states 57.8 / 62.6, four 133.4 / 119.4, six 185.0 / 138.4. Loose threshold and the number printed, because what is caught is a round that got dearer by a factor. */
const costOf = (l: Life, t: number) => {
  for (let i = 0; i < 500; i++) lifeAt(l, t + i * 1e-6, mh)
  let best = Infinity
  for (let r = 0; r < 5; r++) {
    const s = process.hrtime.bigint()
    for (let i = 0; i < 3000; i++) lifeAt(l, t + i * 1e-6, mh)
    best = Math.min(best, Number(process.hrtime.bigint() - s) / 1000 / 3000)
  }
  return best
}
const roundOf = (n: number): Life => {
  const states: unknown[] = []
  for (let i = 0; i < n; i++)
    states.push({ secs: 10 + i * 3, art: i % 3, move: { kind: 'wander', speedMin: 10 + i, speedMax: 20 + i, pauseMin: 0.5, pauseMax: 2, bob: 0, seed: 30 + i } })
  return cleanLife({ ...mflat, states }) as Life
}
const cPlain = costOf(cleanLife(mflat) as Life, 1e5)
const c2 = costOf(roundOf(2), 1e5)
const c4 = costOf(roundOf(4), 1e5)
const c6 = costOf(roundOf(6), 1e5)
ok(
  'a six state round is still a frame budget a Chromebook can pay',
  c6 < 400 && c6 < c2 * 4,
  `${cPlain.toFixed(1)}us plain, ${c2.toFixed(1)}us at two states, ${c4.toFixed(1)} at four, ${c6.toFixed(1)} at six`,
)
/* AND IT IS LINEAR IN THE STATES THAT MOVE, WHICH IS THE HONEST CEILING. A state that is not live cannot cost nothing, because the sum needs its term, and dropping those terms is the design that measures an 89.65px step on 200 of 200 seeds above. A state that only changes the picture is genuinely free, which is the cheap half of what a round is usually for. */
const stillOnly = cleanLife({
  ...mflat,
  states: [{ secs: 10 }, { secs: 9, art: 1 }, { secs: 8, art: 2 }, { secs: 7, art: 1 }, { secs: 6, art: 2 }, { secs: 5, art: 1 }],
}) as Life
const cStill = costOf(stillOnly, 1e5)
ok(
  'and a state that only changes the picture costs nothing at all',
  cStill < cPlain * 1.6,
  `${cStill.toFixed(1)}us for a six state round with one mover, against ${cPlain.toFixed(1)}us plain and ${c6.toFixed(1)}us with six movers`,
)

/* AND THE SAME READING WITH THE FLOOR IN FORCE, WHICH IS THE ONE THAT COSTS: a plain fenced walk is 164.6us against 22.7 with no floor, seven times, before any round exists. A round multiplies that by the movers and got dearer rather than cheaper, two states 257.8 to 364.5us and six 377.9 to 713.7, because the legs are now as long as the box says instead of the 5.83px the old share left. No exported bundle carries a round yet; this gate is for the day one does, on a Chromebook. */
const costWith = (l: Life, t: number, floor: (x: number, y: number) => boolean) => {
  for (let i = 0; i < 200; i++) lifeAt(l, t + i * 1e-6, mh, floor)
  let best = Infinity
  for (let r = 0; r < 5; r++) {
    const s = process.hrtime.bigint()
    for (let i = 0; i < 800; i++) lifeAt(l, t + i * 1e-6, mh, floor)
    best = Math.min(best, Number(process.hrtime.bigint() - s) / 1000 / 800)
  }
  return best
}
const mfenced = { ...mflat, bounds: BOX, walkOnly: true, walkPct: 0.4 }
const roundFenced = (n: number): Life => {
  const states: unknown[] = []
  for (let i = 0; i < n; i++)
    states.push({ secs: 10 + i * 3, art: i % 3, move: { kind: 'wander', speedMin: 10 + i, speedMax: 20 + i, pauseMin: 0.5, pauseMax: 2, bob: 0, seed: 30 + i } })
  return cleanLife({ ...mfenced, states }) as Life
}
const fPlain = costWith(cleanLife(mfenced) as Life, 1e5, onPath)
const f2 = costWith(roundFenced(2), 1e5, onPath)
const f6 = costWith(roundFenced(6), 1e5, onPath)
ok(
  'and a floor-fenced round still costs about one walk per moving state',
  f6 < fPlain * 6 && f6 < 1600,
  `${fPlain.toFixed(0)}us plain with the floor, ${f2.toFixed(0)} at two states, ${f6.toFixed(0)} at six, against ${cPlain.toFixed(0)}/${c2.toFixed(0)}/${c6.toFixed(0)} with no floor`,
)

// ---- the round, sample by sample -----------------------------------------
console.log('\nthe round, which state is live at each sample:')
// worked out here rather than asked of lifeAt, so the table is a second opinion
// on the division rather than a printout of the same walk
const liveState = (t: number): number => {
  const st = troll.states as NonNullable<Life['states']>
  let p = ((t % ROUND) + ROUND) % ROUND
  let k = 0
  while (k < st.length - 1 && p >= st[k].secs) {
    p -= st[k].secs
    k++
  }
  return k
}
for (let t = 0; t <= ROUND; t += 3) {
  const a = lifeAt(troll, t, th)
  const k = liveState(t)
  console.log(
    `  t=${String(t).padStart(3)}s  state ${k}  art ${a.art}  alpha ${a.alpha.toFixed(2)}  ` +
      `${a.moving ? 'moving' : 'still '}  at (${a.dx.toFixed(1)}, ${a.dy.toFixed(1)})`,
  )
}

console.log(bad ? `\n${bad} FAILED` : '\nall good')
process.exit(bad ? 1 : 0)
