/* Does the behaviour maths actually reproduce the beach map's crab and gull?
 *
 * Run: npx tsx src/core/life.check.ts
 *
 * The beach crab, from BeachIso.tsx: dashes to a target within +-4 tiles of
 * home, speed 2.6 to 4.2 tiles/sec, freezes 1.2 to 4.7s, flips to face the way
 * it went, scuttles 1.5px while moving. The gull: a 35s cycle with 9s of glide
 * across the cove, a sine rise and fall, absent the rest of the time.
 */
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

console.log(bad ? `\n${bad} FAILED` : '\nall good')
process.exit(bad ? 1 : 0)
