// Moves a map out of work/<id>/ and into the platform: the document into
// postgres, every png into object storage, the library out of a directory walk
// and into rows.
//
//   node server/db/import-work.mjs hub
//   node server/db/import-work.mjs hub --dry
//
// Non-destructive. work/<id>/ is left exactly as it was, so this can be run
// again and the folder stays the fallback until the gate passes.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.mjs'
import { q, one, closeDb } from './pool.mjs'
import { store, keys } from '../store/blobs.mjs'
import { ensureUser, createMap, getMapBySlug, putDoc } from '../store/maps.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORK = path.resolve(HERE, '..', '..', 'work')

const id = process.argv[2]
const DRY = process.argv.includes('--dry')
if (!id) throw new Error('usage: node server/db/import-work.mjs <map-id> [--dry]')

const dir = path.join(WORK, id)
if (!fs.existsSync(dir)) throw new Error(`no such map folder: ${dir}`)

const K = (n) => (n / 1024).toFixed(1) + 'kb'
const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return fallback
  }
}

// width and height straight out of the IHDR, without decoding the image
function pngSize(file) {
  const fd = fs.openSync(file, 'r')
  const b = Buffer.alloc(24)
  fs.readSync(fd, b, 0, 24, 0)
  fs.closeSync(fd)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

const s = store()
let bytes = 0
let objects = 0
async function upload(key, file) {
  const buf = fs.readFileSync(file)
  bytes += buf.length
  objects++
  if (!DRY) await s.put(key, buf, 'image/png')
  return buf.length
}

console.log(`importing ${id}  from ${dir}${DRY ? '   (dry run, nothing is written)' : ''}`)
console.log(`  storage: ${s.kind} -> ${s.bucket}`)

// ---- the owner -------------------------------------------------------------

const E = env()
const owner = DRY
  ? { id: '00000000-0000-0000-0000-000000000000', email: 'dry@run' }
  : await ensureUser({
      email: E.BOOTSTRAP_EMAIL || 'atc@bonneylake.local',
      password: E.BOOTSTRAP_PASSWORD || 'change-me-on-first-login',
      displayName: 'Algorithmic Thinking Club',
      // the club account is wired to a linked machine rather than holding keys
      claude: 'relay',
      pixellab: 'relay',
    })
console.log(`  owner:   ${owner.email}`)

// ---- the document ----------------------------------------------------------

const docFile = path.join(dir, 'doc.json')
if (!fs.existsSync(docFile)) throw new Error('no doc.json, there is nothing to import')
const docString = fs.readFileSync(docFile, 'utf8')
const doc = JSON.parse(docString)

let map = await getMapBySlug(id)
if (!map && !DRY) {
  map = await createMap({
    slug: id,
    ownerId: owner.id,
    title: id,
    w: doc.w,
    h: doc.h,
    base: doc.base,
    spawn: doc.spawn || [0, 0],
  })
  console.log(`  created map row ${map.id}`)
} else if (map) {
  console.log(`  map row exists ${map.id}`)
}

if (!DRY) {
  const r = await putDoc(map.id, docString)
  console.log(`  document: ${r.wrote.length ? r.wrote.join(', ') : 'nothing changed'}`)
} else {
  console.log(`  document: ${K(docString.length)} would be split into planes + row`)
}

// ---- the side documents that used to be their own files --------------------

if (!DRY) {
  await q(
    `update maps set asks = $2::jsonb, keeps = $3::jsonb, style = $4::jsonb, title = coalesce(nullif(title,''), $5)
     where id = $1`,
    [
      map.id,
      JSON.stringify(readJson(path.join(dir, 'asks.json'), [])),
      JSON.stringify(readJson(path.join(dir, 'keeps.json'), [])),
      JSON.stringify(readJson(path.join(dir, 'style.json'), null)),
      id,
    ],
  )
}

// ---- the paintings and masks -----------------------------------------------

for (const role of ['scene', 'levels', 'occluders', 'cut']) {
  const f = path.join(dir, `${role}.png`)
  if (!fs.existsSync(f)) continue
  const key = role === 'scene' ? keys.scene(map?.id || 'dry') : keys.mask(map?.id || 'dry', role)
  const n = await upload(key, f)
  if (!DRY) {
    const crypto = await import('node:crypto')
    await q(
      `insert into map_blobs (map_id, role, key, bytes, sha256, updated_at) values ($1,$2,$3,$4,$5, now())
       on conflict (map_id, role) do update set key=excluded.key, bytes=excluded.bytes, sha256=excluded.sha256, updated_at=now()`,
      [map.id, role, key, n, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')],
    )
  }
  console.log(`  ${role}.png  ${K(n)}`)
}

// ---- the library, from a directory walk into rows ---------------------------

const libDir = path.join(dir, 'library')
const origin = readJson(path.join(dir, 'origin.json'), {})
let items = 0
let frames = 0

if (fs.existsSync(libDir)) {
  for (const ent of fs.readdirSync(libDir, { withFileTypes: true })) {
    const mapId = map?.id || 'dry'

    // a still: one png named for the item
    if (ent.isFile() && /\.png$/i.test(ent.name)) {
      const name = ent.name.replace(/\.png$/i, '')
      const file = path.join(libDir, ent.name)
      const { w, h } = pngSize(file)
      await upload(keys.libStill(mapId, name), file)
      if (!DRY) await putItem(mapId, name, 'static', { w, h, frame_count: 0, origin: origin[name] || null })
      items++
      continue
    }
    if (!ent.isDirectory()) continue

    // a folder: frames, or headings, or an effect
    const sub = path.join(libDir, ent.name)
    const name = ent.name
    const dirsMeta = readJson(path.join(sub, 'dirs.json'), null)
    const effect = readJson(path.join(sub, 'effect.json'), null)

    let n = 0
    while (fs.existsSync(path.join(sub, n + '.png'))) n++

    let w = 0
    let h = 0
    for (let i = 0; i < n; i++) {
      const f = path.join(sub, i + '.png')
      if (!i) ({ w, h } = pngSize(f))
      await upload(keys.libFrame(mapId, name, i), f)
      frames++
    }

    // a directional set keeps one png per heading under its own folder
    const dirs = {}
    if (dirsMeta?.dirs) {
      for (const [heading, list] of Object.entries(dirsMeta.dirs)) {
        dirs[heading] = []
        for (let i = 0; i < list.length; i++) {
          const f = path.join(sub, heading, i + '.png')
          if (!fs.existsSync(f)) continue
          if (!w) ({ w, h } = pngSize(f))
          const key = `maps/${mapId}/library/${name}/${heading}/${i}.png`
          await upload(key, f)
          dirs[heading].push(key)
          frames++
        }
      }
    }

    if (!DRY)
      await putItem(mapId, name, n > 1 || Object.keys(dirs).length ? 'animated' : 'static', {
        w,
        h,
        fps: effect?.fps ?? dirsMeta?.fps ?? null,
        frame_count: n,
        dirs: Object.keys(dirs).length ? dirs : null,
        effect,
        is_effect: !!effect,
        origin: origin[name] || (dirsMeta?.characterId ? { characterId: dirsMeta.characterId } : null),
      })
    items++
  }
}

async function putItem(mapId, name, kind, o) {
  await q(
    `insert into library_items (map_id, name, kind, is_effect, w, h, fps, frame_count, dirs, effect, origin, blob_prefix)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12)
     on conflict (map_id, name) do update set
       kind=excluded.kind, is_effect=excluded.is_effect, w=excluded.w, h=excluded.h,
       fps=excluded.fps, frame_count=excluded.frame_count, dirs=excluded.dirs,
       effect=excluded.effect, origin=excluded.origin`,
    [
      mapId,
      name,
      kind,
      !!o.is_effect,
      o.w | 0,
      o.h | 0,
      o.fps ?? null,
      o.frame_count | 0,
      o.dirs ? JSON.stringify(o.dirs) : null,
      o.effect ? JSON.stringify(o.effect) : null,
      o.origin ? JSON.stringify(o.origin) : null,
      keys.libPrefix(mapId, name),
    ],
  )
}

// ---- what happened ---------------------------------------------------------

console.log(`  library: ${items} items, ${frames} frames`)
console.log(`  uploaded ${objects} objects, ${(bytes / 1024 / 1024).toFixed(2)} MB`)

if (!DRY) {
  const a = await one('select count(*)::int n from anchors where map_id = $1', [map.id])
  const l = await one('select count(*)::int n from library_items where map_id = $1', [map.id])
  console.log(`  in the database now: ${l.n} library items, ${a.n} anchors`)
}
await closeDb()
