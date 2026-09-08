// disk is the superset, and 1,038 files of paid generation once lived only on this laptop
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { store } from '../store/blobs.mjs'
import { q, many } from './pool.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK = path.join(ROOT, 'work')
const WRITE = process.argv.includes('--write')

// .prev is undo scratch and assets/ is export output that a publish rewrites,
// so neither is the irreplaceable half.
const SKIP = new Set(['.prev', 'assets'])

function walk(dir, base = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const rel = base ? base + '/' + e.name : e.name
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, rel))
    else out.push(rel)
  }
  return out
}

const TYPES = { '.png': 'image/png', '.json': 'application/json' }

const maps = await many('select id, slug from maps order by slug')
const s = store()

/* pull before leaving a bucket, and publishes are deliberately skipped since exporting rebuilds them */
if (process.argv.includes('--pull')) {
  let got = 0
  for (const m of maps) {
    for (const o of await s.list(`maps/${m.id}/`)) {
      const key = String(o.key || o)
      const rel = key.slice(`maps/${m.id}/`.length)
      const f = path.join(WORK, m.slug, ...rel.split('/'))
      if (fs.existsSync(f)) continue
      if (!WRITE) { console.log(`would pull ${m.slug}/${rel}`); got++; continue }
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, await s.get(key))
      got++
    }
  }
  console.log(WRITE ? `pulled ${got}` : `${got} file(s) would be pulled`)
  process.exit(0)
}
console.log(`bucket: ${s.kind}${s.bucket ? ' ' + s.bucket : ''}`)
console.log(WRITE ? 'writing\n' : 'dry run, nothing will be uploaded (pass --write)\n')

let total = 0
let sent = 0
for (const m of maps) {
  const dir = path.join(WORK, m.slug)
  if (!fs.existsSync(dir)) {
    console.log(`${m.slug}: no local folder, skipped`)
    continue
  }
  const files = walk(dir)
  const have = new Set((await s.list(`maps/${m.id}/`)).map((o) => String(o.key || o)))
  const todo = files.filter((f) => !have.has(`maps/${m.id}/${f}`))
  total += todo.length
  console.log(`${m.slug}: ${files.length} local, ${have.size} in bucket, ${todo.length} to upload`)
  if (!WRITE) continue
  for (const rel of todo) {
    const buf = fs.readFileSync(path.join(dir, ...rel.split('/')))
    await s.put(`maps/${m.id}/${rel}`, buf, TYPES[path.extname(rel).toLowerCase()] || 'application/octet-stream')
    if (++sent % 100 === 0) console.log(`  ${sent}/${total}`)
  }
}

/* planes.png is derived by putDoc and never on disk, so a bucket move by uploading work/ left it behind */
let rebuilt = 0
for (const m of maps) {
  const doc = path.join(WORK, m.slug, 'doc.json')
  if (!fs.existsSync(doc)) continue
  if (await s.exists(`maps/${m.id}/planes.png`)) continue
  if (!WRITE) {
    console.log(`would rebuild planes.png for ${m.slug} from doc.json`)
    rebuilt++
    continue
  }
  /* the sha must be cleared or putDoc skips the write, and emptied not nulled since the column is not null */
  await q("update map_blobs set sha256 = '' where map_id = $1 and role = $2", [m.id, 'planes'])
  const { saveDocument } = await import('../store/platform.mjs')
  await saveDocument(m.slug, fs.readFileSync(doc, 'utf8'))
  const ok = await s.exists(`maps/${m.id}/planes.png`)
  console.log(`rebuilt planes.png for ${m.slug}${ok ? '' : '  <-- STILL MISSING, look at this'}`)
  rebuilt++
}

console.log(WRITE ? `\ndone, ${sent} uploaded, ${rebuilt} plane set(s) rebuilt` : `\n${total} file(s) would be uploaded, ${rebuilt} plane set(s) rebuilt`)
await q('select 1')
process.exit(0)
