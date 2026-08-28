// Remove publish rows that point at bytes which are not there.
//
//   node server/db/reconcile-publishes.mjs           say what would happen
//   node server/db/reconcile-publishes.mjs --write   delete those rows
//
// Measured on 2026-08-27: ten of thirteen rows in publishes named a prefix
// holding zero objects. hub v1 to v3 and every site-* row were written against a
// bucket that has since been left behind, and the row is what /api/v1/maps
// reads, so the api advertised seven maps as published and every one of them
// answered 503 when the game asked for the bytes. publishBundle now refuses to
// write a row it cannot list back, which stops new ones appearing. This is for
// the ones already in the table.
//
// WHAT THIS IS NOT ALLOWED TO DO, and does not:
//   - it never deletes an object. Not one, not a prefix, not ever. It reads the
//     bucket with list and nothing else.
//   - it never touches the maps table. A map is the author's work and outlives
//     every version of it; a publish row is only a receipt for one export.
//   - it never deletes anything on a dry run, which is the default.
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

/* THE COUNT COMES OFF THE MANIFEST, KEY BY KEY.
 *
 * Counting objects under the prefix and comparing totals would call a bundle
 * healthy when it holds the right number of the wrong files. The manifest names
 * every object the row promises, so asking whether each one is present is both
 * the cheaper check and the true one. */
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

/* A PARTIAL ROW IS NOT THIS SCRIPT'S CALL.
 *
 * "Whose objects do not exist" means none of them. A bundle missing four frames
 * out of 801 still loads and still walks, so deleting its row would take a
 * working version away from a class mid-session to fix a cosmetic hole. It is
 * printed loudly and left for a human, who can simply export again. */
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

/* THE TRIPWIRE, BECAUSE THE FAILURE MODE IS INDISTINGUISHABLE FROM THE BUG.
 *
 * An empty publish/ listing is what a stale bucket looks like, and it is also
 * exactly what pointing at the wrong bucket looks like: wrong S3_ENDPOINT, wrong
 * S3_BUCKET, a missing key falling back to the local work/ folder. In that state
 * every row reads as dead and one run would empty the table on a set of
 * perfectly good bundles. So when the bucket has nothing under publish/ at all,
 * it has to be said out loud a second time. */
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
