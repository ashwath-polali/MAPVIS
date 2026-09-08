// an anchor drops on any pixel with no ground test, so a door on a wall looks right and never fires in game
import { one, closeDb } from './pool.mjs'
import { store } from '../store/blobs.mjs'
import { decodePNG } from '../sheet.mjs'

const slug = process.argv[2] || 'hub'
const map = await one('select id, w, h, spawn_x, spawn_y from maps where slug = $1', [slug])
if (!map) throw new Error(`no map ${slug}`)

const pub = await one(
  `select p.blob_prefix, p.version, p.manifest from publishes p where p.map_id = $1 order by p.version desc limit 1`,
  [map.id],
)
if (!pub) throw new Error(`${slug} has never been published`)

const levels = decodePNG(await store().get(pub.blob_prefix + 'levels.png'))
const mapJson = JSON.parse((await store().get(pub.blob_prefix + 'map.json')).toString('utf8'))
const enc = mapJson.encoding || {}
const tol = enc.stepTolerance ?? 10
const hip = mapJson.character?.hip ?? 2
const { w, h } = levels
const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : levels.data[((y | 0) * w + (x | 0)) * 4])

// the game's own test: the hip band either side of the feet, so nobody balances
// on a single legal pixel
const standable = (x, y) => {
  const here = at(x, y)
  if (here <= (enc.blocked ?? 0)) return false
  for (let dx = -hip; dx <= hip; dx++) {
    const v = at(x + dx, y)
    if (v <= 0 || Math.abs(v - here) > tol) return false
  }
  return true
}

console.log(`${slug} v${pub.version}  ${w}x${h}  stepTolerance ${tol}  hip ${hip}`)

let ground = 0
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (standable(x, y)) ground++
console.log(`standable pixels: ${ground.toLocaleString()}`)

const anchors = mapJson.anchors || []
if (!anchors.length) console.log('no anchors on this map')

let bad = 0
for (const a of anchors) {
  const r = a.r || 14
  let inside = 0
  for (let y = a.y - r; y <= a.y + r; y++)
    for (let x = a.x - r; x <= a.x + r; x++) {
      if ((x - a.x) ** 2 + (y - a.y) ** 2 > r * r) continue
      if (standable(x, y)) inside++
    }
  if (inside) {
    console.log(`  ok    ${a.name}  (${a.x},${a.y}) r${r} · ${inside} standable px inside`)
    continue
  }
  // how far away the nearest ground actually is, so the fix is a direction and
  // not a guess
  let best = Infinity
  let bx = 0
  let by = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!standable(x, y)) continue
      const d = Math.hypot(x - a.x, y - a.y)
      if (d < best) {
        best = d
        bx = x
        by = y
      }
    }
  bad++
  console.log(
    `  DEAD  ${a.name}  (${a.x},${a.y}) r${r} · nothing standable inside it.\n` +
      `        nearest ground is ${best.toFixed(0)}px away at (${bx},${by}).\n` +
      `        move it there, widen r past ${Math.ceil(best)}, or paint ground under it.`,
  )
}

console.log(bad ? `\n${bad} anchor(s) a player can never reach.` : `\nevery anchor is reachable.`)
await closeDb()
process.exit(bad ? 1 : 0)
