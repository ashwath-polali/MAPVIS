// The stand-point reach law on both sides of the wire, with no database and no bucket, so a stranger can run it on a fresh clone.

//   node server/db/verify-stand.mjs

// Two on the hub ended up 60 and 214 pixels from their anchor. The browser holds the rule in src/core/mask.ts and the server
// keeps its own copy in maps.mjs, because putDoc is reachable by a hand-written POST, so this runs both against each other.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { clampStand as serverClamp } from '../store/maps.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}

// the browser's own source, transpiled and loaded, so this cannot drift from it
const src = fs.readFileSync(path.join(ROOT, 'src/core/mask.ts'), 'utf8')
const cut = src.slice(src.indexOf('export const STAND_REACH_BODIES'), src.indexOf('export function migrateEvent'))
const js = ts.transpileModule(cut, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { clampStand, standReach, STAND_REACH_BODIES } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
)

STAND_REACH_BODIES === 2 ? ok('two body lengths') : no(`the reach is ${STAND_REACH_BODIES} bodies`)
standReach(18) === 36 ? ok('an 18px body reaches 36px') : no(`reach(18) is ${standReach(18)}`)
standReach(36) === 72 ? ok('a 36px body reaches 72px, so the rule follows the map and not a constant') : no('the reach does not follow charH')

const inside = clampStand(100, 100, [110, 120], 18)
String(inside) === '110,120' ? ok('a point inside is left exactly where it was') : no(`a legal point moved to ${inside}`)

const far = clampStand(100, 100, [100, 300], 18)
String(far) === '100,136' ? ok('a point 200px away is pulled to 36px, straight down the line') : no(`a far point came back ${far}`)

// the two the hub actually had
for (const d of [60, 214]) {
  const p = clampStand(300, 300, [300 + d, 300], 18)
  const got = Math.hypot(p[0] - 300, p[1] - 300)
  got <= 36 ? ok(`${d}px behind comes back ${got}px away`) : no(`${d}px behind stayed ${got}px away`)
}

/* THE PROMISE, SWEPT. Nothing lands past the reach at any angle or distance, and
 * a point that was already legal is not shoved. The rounding is what breaks this
 * if it is done in the wrong order: rounding after measuring let a point at 35.9
 * come back at 36.4 against a reach of 36. */
let worst = 0
let shoved = 0
for (let deg = 0; deg < 360; deg++) {
  const a = (deg * Math.PI) / 180
  for (const d of [0.5, 1, 12, 35.4, 35.9, 36.1, 37, 100, 999.7]) {
    const want = [400 + Math.cos(a) * d, 400 + Math.sin(a) * d]
    const p = clampStand(400, 400, want, 18)
    const got = Math.hypot(p[0] - 400, p[1] - 400)
    worst = Math.max(worst, got)
    // a point a pixel or more inside is only ever rounded. One sitting ON the
    // boundary may round outward and then be pulled back onto it, which is the
    // rule working rather than a shove, so it is not counted here.
    if (d <= 35 && Math.hypot(p[0] - want[0], p[1] - want[1]) > 0.71) shoved++
    const q = serverClamp(400, 400, want, 18)
    if (String(p) !== String(q)) no(`the two copies disagree at ${deg} degrees, ${d}px: browser ${p}, server ${q}`)
  }
}
worst <= 36
  ? ok(`over 3240 angles and distances nothing lands past 36px, worst ${worst.toFixed(3)}`)
  : no(`something landed ${worst.toFixed(3)}px out`)
shoved === 0 ? ok('and a point a pixel inside the reach is only ever rounded') : no(`${shoved} legal points were shoved`)

// the server's own half, which the browser never reaches
serverClamp(0, 0, null, 18) === null ? ok('the server refuses a stand that is not a pair') : no('the server took a null stand')
serverClamp(0, 0, ['x', 2], 18) === null ? ok('and one that is not two numbers') : no('the server took a non-numeric stand')
String(serverClamp(0, 0, [10, 10], undefined)) === '10,10' ? ok('and falls back to an 18px body when the map does not say') : no('the server default reach is wrong')

console.log(bad ? `\n${bad} problem(s).` : '\nthe stand point cannot be saved out of reach, on either side.')
process.exit(bad ? 1 : 0)
