/* PUT A MAP'S LOST BEHAVIOURS BACK.
 *
 * On 2026-09-05 the hub's row came back with `life` gone from all 22 placements
 * that carried a behaviour and the one placement name gone with it, while every
 * geometry and art field on all 94 survived. The people stood on the spot
 * playing their walk cycles instead of wandering. Nothing on the server drops
 * those fields, so a browser sent a document that had already lost them and the
 * row took it; putDoc now keeps a copy and says so when that happens again.
 *
 * This is the repair for the one that already happened. It reads the last
 * export in work/<slug>/assets.json, which is the bundle that was published and
 * is known good, and grafts `life` and `name` back onto the row's placements BY
 * ID. It changes nothing else, so every edit made since is kept.
 *
 *   node server/db/restore-life.mjs hub           what it would do
 *   node server/db/restore-life.mjs hub --write   do it
 *
 * It touches one map row. It never touches the world row.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { q, one, closeDb } from './pool.mjs'

const WORK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'work')
const slug = process.argv[2] || 'hub'
const WRITE = process.argv.includes('--write')

const src = path.join(WORK, slug, 'assets.json')
if (!fs.existsSync(src)) throw new Error(`no export to restore from at ${src}`)
const exported = JSON.parse(fs.readFileSync(src, 'utf8')).assets || []
const lifeById = new Map(exported.filter((a) => a.life).map((a) => [String(a.id), a.life]))
const nameById = new Map(exported.filter((a) => a.name).map((a) => [String(a.id), a.name]))
console.log(`${src}\n  ${exported.length} placements, ${lifeById.size} with a behaviour, ${nameById.size} named`)

const m = await one('select id, assets, doc_sha, updated_at from maps where slug = $1', [slug])
if (!m) throw new Error(`no map ${slug} in the database`)
console.log(`row ${m.id}\n  ${m.assets.length} placements, ${m.assets.filter((a) => a.life).length} with a behaviour, updated ${new Date(m.updated_at).toISOString()}`)

/* the row as it stands, on disk, before anything is written. The rescue putDoc
 * now files is for the next time; this is the one for this run. */
const kept = path.join(WORK, slug, 'versions', `restore-life-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.mkdirSync(path.dirname(kept), { recursive: true })
fs.writeFileSync(kept, JSON.stringify({ slug, mapId: m.id, updatedAt: m.updated_at, docSha: m.doc_sha, assets: m.assets }, null, 1))
console.log(`kept the row as it is at ${kept}`)

let gotLife = 0
let gotName = 0
const next = m.assets.map((a) => {
  const id = String(a.id)
  const out = { ...a }
  if (!out.life && lifeById.has(id)) {
    out.life = lifeById.get(id)
    gotLife++
  }
  if (!out.name && nameById.has(id)) {
    out.name = nameById.get(id)
    gotName++
  }
  return out
})

/* NOTHING BUT THOSE TWO MAY MOVE. The whole value of grafting by id rather than
 * restoring the export wholesale is that the co-pilot's edits since the publish
 * stay; if anything else differs the graft is wrong and this refuses. */
let drift = 0
for (let i = 0; i < next.length; i++)
  for (const k of new Set([...Object.keys(m.assets[i]), ...Object.keys(next[i])])) {
    if (k === 'life' || k === 'name') continue
    if (JSON.stringify(m.assets[i][k]) !== JSON.stringify(next[i][k])) {
      console.log(`  would change ${m.assets[i].id}.${k}`)
      drift++
    }
  }

console.log(`\n${gotLife} placement(s) regain a behaviour, ${gotName} regain a name`)
console.log(`${next.length} placements in, ${next.length} out`)
console.log(`fields other than life and name that would change: ${drift}`)

if (drift) {
  console.log('\nREFUSED: the graft would move something it has no business moving.')
} else if (!WRITE) {
  console.log('\nnothing written. add --write to do it.')
} else {
  /* doc_sha is cleared, not recomputed. maps.mjs warns that a column edited out
   * of band with the sha left alone leaves a row that can never correct itself:
   * the next save would compare against a hash that still describes the broken
   * document, decide nothing changed, and write nothing. An empty sha matches
   * no document, so the next save writes and the row heals. */
  await q('update maps set assets = $2::jsonb, doc_sha = $3, updated_at = now() where id = $1', [m.id, JSON.stringify(next), ''])
  const back = await one('select assets from maps where id = $1', [m.id])
  console.log(`\nwritten. the row now holds ${back.assets.length} placements, ${back.assets.filter((a) => a.life).length} with a behaviour and ${back.assets.filter((a) => a.name).length} named.`)
  console.log('reload the editor before touching the map: a tab still holding the broken document will save it back over this within four seconds.')
}
await closeDb()
