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

// geometry
for (const k of ['w', 'h', 'assetNext'])
  original[k] === roundTripped[k] ? ok(`${k} ${original[k]}`) : no(`${k}: ${original[k]} in, ${roundTripped[k]} out`)
String(original.spawn) === String(roundTripped.spawn)
  ? ok(`spawn ${original.spawn}`)
  : no(`spawn ${original.spawn} in, ${roundTripped.spawn} out`)

// the placements, compared as data rather than as text, since jsonb reorders keys
const norm = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x,
  )
norm(original.assets) === norm(roundTripped.assets)
  ? ok(`${original.assets.length} placements identical`)
  : no(`placements differ (${original.assets.length} in, ${roundTripped.assets?.length} out)`)

// doors survive the trip through the anchors table in the shape the game reads
const doorsIn = (original.events || []).filter((e) => e.type === 'door')
const doorsOut = (roundTripped.events || []).filter((e) => e.type === 'door')
doorsIn.length === doorsOut.length
  ? ok(`${doorsIn.length} door(s): ${doorsOut.map((d) => `${d.label || '?'} -> ${d.to}`).join(', ') || 'none'}`)
  : no(`doors ${doorsIn.length} in, ${doorsOut.length} out`)

// the whole point: saving the same thing twice must write nothing the second time
const again = await putDoc(map.id, JSON.stringify(original))
again.skipped
  ? ok('an unchanged save wrote nothing')
  : no(`an unchanged save still wrote: ${again.wrote.join(', ')}`)

// and a real change must still land
original.spawn = [original.spawn[0] + 1, original.spawn[1]]
const moved = await putDoc(map.id, JSON.stringify(original))
moved.wrote.some((w) => w.startsWith('doc')) && !moved.wrote.some((w) => w.startsWith('planes'))
  ? ok(`moving the spawn wrote only the row: ${moved.wrote.join(', ')}`)
  : no(`moving the spawn wrote: ${moved.wrote.join(', ') || 'nothing'}`)
original.spawn = [original.spawn[0] - 1, original.spawn[1]]
await putDoc(map.id, JSON.stringify(original))

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

    await dropItem(slug, name)
    ;(await libraryOf(slug)).some((i) => i.name === name) ? no('a deleted asset still lists') : ok('deleting it removed it from both stores')
  } finally {
    fs.rmSync(file, { force: true })
  }
}

console.log(bad ? `\n${bad} problem(s).` : '\nlossless, and an idle autosave costs nothing.')
await closeDb()
process.exit(bad ? 1 : 0)
