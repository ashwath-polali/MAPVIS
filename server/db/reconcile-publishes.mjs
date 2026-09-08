// removes publish rows whose bytes are gone: it never deletes an object and never touches the maps table
import { many, q, closeDb } from './pool.mjs'
import { store } from '../store/blobs.mjs'

const WRITE = process.argv.includes('--write')
const FORCE_EMPTY = process.argv.includes('--force-empty-bucket')

const s = store()
console.log(`bucket: ${s.kind}${s.bucket ? ' ' + s.bucket : ''}`)
console.log(WRITE ? 'writing, rows listed below will be deleted\n' : 'dry run, nothing will be deleted (pass --write)\n')

// one listing of the whole publish tree, rather than one per row. A per-row
// listing on thirteen rows is thirteen class A operations to learn what one
// answers, and the tree is small enough to hold.
const objects = await s.list('publish/')
const have = new Set(objects.map((o) => String(o.key || o)))
console.log(`publish/ holds ${have.size} object(s)`)

const rows = await many(
  `select p.id, p.version, p.blob_prefix, p.bytes, p.published_at, m.slug
     from publishes p join maps m on m.id = p.map_id
    order by m.slug, p.version`,
)

/* counted off the manifest key by key, since a prefix count passes the right number of the wrong files */
const manifests = new Map(
  (await many('select id, manifest from publishes')).map((r) => [r.id, Object.keys(r.manifest || {})]),
)

const dead = []
const partial = []
for (const r of rows) {
  const want = manifests.get(r.id) || []
  const gone = want.filter((rel) => !have.has(r.blob_prefix + rel))
  const line = `${r.slug} v${r.version}  ${r.blob_prefix}  ${want.length - gone.length}/${want.length} object(s) present`
  if (!want.length || gone.length === want.length) {
    dead.push(r)
    console.log(`  DEAD     ${line}`)
  } else if (gone.length) {
    partial.push({ r, gone })
    console.log(`  PARTIAL  ${line}  e.g. missing ${gone[0]}`)
  } else {
    console.log(`  ok       ${line}`)
  }
}

/* gone means none of them: a bundle missing four frames of 801 still walks, so a partial row is left alone */
if (partial.length)
  console.log(
    `\n${partial.length} row(s) are missing some but not all of their objects. Those are left alone on purpose: ` +
      `re-export the map to replace them.`,
  )

if (!dead.length) {
  console.log('\nnothing to reconcile')
  await closeDb()
  process.exit(0)
}

/* an empty publish/ listing is also what a wrong bucket looks like, and one run would empty the table */
if (!have.size && !FORCE_EMPTY) {
  console.log(
    `\nREFUSING: publish/ holds no objects at all in this bucket, which is what a wrong S3_ENDPOINT or S3_BUCKET ` +
      `looks like as well as what a stale table looks like. Check the bucket named above is the one the exports went ` +
      `to, then pass --force-empty-bucket alongside --write.`,
  )
  await closeDb()
  process.exit(1)
}

console.log(`\n${dead.length} row(s) would be deleted:`)
for (const r of dead) console.log(`  delete from publishes where id = ${r.id}   (${r.slug} v${r.version})`)

if (!WRITE) {
  console.log('\ndry run, nothing was deleted. Pass --write to act.')
  await closeDb()
  process.exit(0)
}

// deleted by primary key one at a time, so the statement can never widen to
// something it was not shown above
let n = 0
for (const r of dead) {
  await q('delete from publishes where id = $1', [r.id])
  n++
}
console.log(`\ndeleted ${n} row(s). No object was touched and the maps table was not read for anything but a slug.`)
await closeDb()
process.exit(0)
