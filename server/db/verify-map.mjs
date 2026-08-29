// Does what came back out equal what went in, and does an unchanged save
// actually write nothing?
//
//   node server/db/verify-map.mjs hub
//
// The second question is the one that matters. The editor autosaves every 4
// seconds, so if a no-op save still rewrites the row and the planes png, the
// free tier dies quietly over a weekend rather than loudly on a Tuesday.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getMapBySlug, getDoc, putDoc } from '../store/maps.mjs'
import { closeDb } from './pool.mjs'

const WORK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'work')
const slug = process.argv[2] || 'hub'
let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}

const map = await getMapBySlug(slug)
if (!map) throw new Error(`no map ${slug} in the database`)
console.log(`${slug}  ${map.id}  ${map.w}x${map.h}`)

/* THE FILE ON DISK IS A SNAPSHOT, NOT THE MAP, and that decides what each
 * check below is allowed to ask.
 *
 * work/<slug>/doc.json is written by the failure fallback and by import-work,
 * so on a machine where the platform is answering it is however old the last
 * one of those was. It is the right thing to compare the MASK against, because
 * the mask is the one thing that cannot be redrawn and a stale copy of it is
 * still a copy of the same hand-drawn pixels. It is the wrong thing to compare
 * the placements or the anchors against: name a placement or mark a standing
 * spot and a comparison against a two-day-old file calls perfectly correct work
 * a fault. Those are asked of the round trip instead, which is the property
 * this file is really about. */
const original = JSON.parse(fs.readFileSync(path.join(WORK, slug, 'doc.json'), 'utf8'))
const roundTripped = JSON.parse(await getDoc(map.id))

// the three mask planes, byte for byte. This is the hand-drawn work and the one
// thing in the whole system that cannot be regenerated.
const a = Buffer.from(original.m, 'base64')
const b = Buffer.from(roundTripped.m, 'base64')
if (a.length !== b.length) no(`planes length ${a.length} in, ${b.length} out`)
else {
  let diff = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
  diff ? no(`planes differ in ${diff} of ${a.length} bytes`) : ok(`planes lossless, ${a.length.toLocaleString()} bytes`)
}

/* GEOMETRY, and only the two numbers the disk file is entitled to be asked
 * about.
 *
 * w and h belong here because the planes above were just compared byte for
 * byte, and a mask of that length can only describe one size, so a disagreement
 * is a real fault rather than an old file.
 *
 * `spawn` and `assetNext` used to be in this loop and both are authored state
 * that legitimately changes. That is the hazard this file's own header warns
 * about for placements and anchors, applied to two fields that were left behind
 * when the rest moved. It cost a real morning: the hub reported `spawn 557,508
 * in, 557,507 out` as a FAILURE on every run, and the two numbers were simply a
 * two-day-old snapshot and today's map, both correct. Nothing was broken and
 * the suite said something was. They are asked of the round trip below
 * instead, which is the property this file is actually about. */
for (const k of ['w', 'h'])
  original[k] === roundTripped[k] ? ok(`${k} ${original[k]}`) : no(`${k}: ${original[k]} in, ${roundTripped[k]} out`)

// the placements, compared as data rather than as text, since jsonb reorders keys
const norm = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x,
  )
/* saved and read back, rather than against the file, because the question is
 * whether the split into jsonb loses anything and the file cannot answer that
 * once anybody has authored a placement since it was written */
await putDoc(map.id, JSON.stringify(roundTripped))
const again1 = JSON.parse(await getDoc(map.id))
norm(roundTripped.assets) === norm(again1.assets)
  ? ok(`${roundTripped.assets.length} placements survive the round trip`)
  : no(`placements differ (${roundTripped.assets.length} in, ${again1.assets?.length} out)`)
norm(roundTripped.walk) === norm(again1.walk) && norm(roundTripped.props) === norm(again1.props)
  ? ok(`the walk contract and the map's properties survive it too`)
  : no(`walk or props changed: ${norm(again1.walk)} ${norm(again1.props)}`)
// the start point and the placement counter, asked of the live document rather
// than of the file, because both of them move whenever somebody authors
String(roundTripped.spawn) === String(again1.spawn)
  ? ok(`spawn ${roundTripped.spawn} survives the round trip`)
  : no(`spawn ${roundTripped.spawn} in, ${again1.spawn} out`)
roundTripped.assetNext === again1.assetNext
  ? ok(`assetNext ${roundTripped.assetNext}`)
  : no(`assetNext ${roundTripped.assetNext} in, ${again1.assetNext} out`)
// the routes and the shots, which are the newest authored lists and travel the
// same jsonb path the placements do
norm(roundTripped.paths || []) === norm(again1.paths || []) && norm(roundTripped.framings || []) === norm(again1.framings || [])
  ? ok(`${(roundTripped.paths || []).length} route(s) and ${(roundTripped.framings || []).length} shot(s) survive it`)
  : no(`routes or shots changed: ${norm(again1.paths)} ${norm(again1.framings)}`)

// anchors survive the trip through the table. A document written before anchors
// existed says type:'door'; one written since says kind, and both have to come
// back as the same set of named places.
const isDoor = (e) => e.kind === 'door' || e.type === 'door'
const doorsIn = (original.events || []).filter(isDoor)
const doorsOut = (roundTripped.events || []).filter(isDoor)
doorsIn.length === doorsOut.length
  ? ok(`${doorsIn.length} door(s): ${doorsOut.map((d) => `${d.name} -> ${d.to || '?'}`).join(', ') || 'none'}`)
  : no(`doors ${doorsIn.length} in, ${doorsOut.length} out`)
doorsOut.every((d) => /^[a-z][a-z0-9_]*$/.test(d.name || ''))
  ? ok('every anchor came back with a name code can address')
  : no(`an anchor came back unnamed: ${JSON.stringify(doorsOut.map((d) => d.name))}`)

/* THE WHOLE POINT: saving the same thing twice must write nothing the second
 * time. Saving what the database just handed back, which is what the editor
 * does on every four-second beat when nobody has touched anything. Against the
 * disk file this only tested whether that file happened to be current. */
const again = await putDoc(map.id, JSON.stringify(again1))
again.skipped
  ? ok('an unchanged save wrote nothing')
  : no(`an unchanged save still wrote: ${again.wrote.join(', ')}`)

// and a real change must still land
again1.spawn = [again1.spawn[0] + 1, again1.spawn[1]]
const moved = await putDoc(map.id, JSON.stringify(again1))
moved.wrote.some((w) => w.startsWith('doc')) && !moved.wrote.some((w) => w.startsWith('planes'))
  ? ok(`moving the spawn wrote only the row: ${moved.wrote.join(', ')}`)
  : no(`moving the spawn wrote: ${moved.wrote.join(', ') || 'nothing'}`)
// and put it back, off the document this test has been moving rather than off
// the file, so the map is left exactly as it was found
again1.spawn = [again1.spawn[0] - 1, again1.spawn[1]]
await putDoc(map.id, JSON.stringify(again1))

// ---- a generated asset has to survive the trip too -------------------------

// The listing comes from the database now, so anything generation writes to
// disk and does not push would simply vanish from the library. This walks the
// same path a generation does: bytes land in work/<slug>/library, the choke
// point pushes them, and the item has to come back out of the store.
{
  const { pushItem, libraryOf, dropItem } = await import('../store/platform.mjs')
  const { store, keys } = await import('../store/blobs.mjs')
  const { encodePNG } = await import('../sheet.mjs')
  const name = 'zz-verify-probe'
  const lib = path.join(WORK, slug, 'library')
  const file = path.join(lib, `${name}.png`)
  const png = encodePNG(4, 3, Buffer.alloc(4 * 3 * 4, 200))
  try {
    fs.mkdirSync(lib, { recursive: true })
    fs.writeFileSync(file, png)
    await pushItem(slug, name, path.join(WORK, slug))

    const listed = (await libraryOf(slug)).find((i) => i.name === name)
    listed && listed.w === 4 && listed.h === 3
      ? ok(`a written asset lists from the database at ${listed.w}x${listed.h}`)
      : no(`a written asset did not list back: ${JSON.stringify(listed)}`)

    const back = await store().get(keys.libStill(map.id, name))
    Buffer.compare(back, png) === 0 ? ok('its bytes round-tripped through object storage') : no('its bytes came back different')

    // an in-place edit keeps the old pixels, and putting them back must work on
    // a machine that never saw the edit, which is the whole reason .prev alone
    // was not enough
    const { snapshotVersion, restoreVersion, versionsOf } = await import('../store/platform.mjs')
    const snap = await snapshotVersion(slug, name)
    snap ? ok(`kept version ${snap.seq} of it (${snap.files} file)`) : no('nothing was kept')

    // overwrite it the way an edit does, with different pixels
    const edited = encodePNG(4, 3, Buffer.alloc(4 * 3 * 4, 40))
    fs.writeFileSync(file, edited)
    await pushItem(slug, name, path.join(WORK, slug))
    const now = await store().get(keys.libStill(map.id, name))
    Buffer.compare(now, edited) === 0 ? ok('the edit landed over it') : no('the edit did not land')

    const undone = await restoreVersion(slug, name)
    const after = await store().get(keys.libStill(map.id, name))
    undone && Buffer.compare(after, png) === 0
      ? ok('undo put the original pixels back, out of the store rather than off this disk')
      : no('undo did not restore the original bytes')

    await dropItem(slug, name)
    ;(await libraryOf(slug)).some((i) => i.name === name) ? no('a deleted asset still lists') : ok('deleting it removed it from both stores')
    ;(await versionsOf(slug, name)).length === 0 ? ok('and took its kept versions with it') : no('kept versions outlived the item')
  } finally {
    fs.rmSync(file, { force: true })
  }
}

console.log(bad ? `\n${bad} problem(s).` : '\nlossless, and an idle autosave costs nothing.')
await closeDb()
process.exit(bad ? 1 : 0)
