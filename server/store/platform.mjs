// The database-backed versions of the three things api.mjs used to do with the
// filesystem: save and load a document, list a library, and serve a png.
//
// The URL space does not change. The editor still asks for
// /work/<slug>/library/base.png and still gets a png back; it simply comes out
// of object storage now. Keeping the old shape is what lets the whole backend
// move without touching 17,000 lines of client, and it is why the placement
// urls already sitting inside every saved document keep resolving.
import crypto from 'node:crypto'
import { q, one, many } from '../db/pool.mjs'
import { store, keys } from './blobs.mjs'
import { getDoc, putDoc, getMapBySlug, createMap, ensureUser } from './maps.mjs'
import { env, need } from '../db/env.mjs'

// Is the platform on at all? With no database configured the tool falls back to
// work/ and behaves exactly as it did before, which is the degraded-not-broken
// rule applied to the backend itself.
export const platformOn = () => {
  const E = env()
  return E.MAPVIS_STORAGE !== 'work' && !!(E.DATABASE_POOLED_URL || E.DATABASE_URL)
}

// May a route fall back to work/ when the platform cannot answer? Yes normally,
// because an author's work must never be lost to a database being unreachable.
// The gate sets MAPVIS_NO_DISK=1 to take that away and prove the map really
// lives off this laptop, which a passing test with a working disk underneath it
// would not prove at all.
export const diskAllowed = () => env().MAPVIS_NO_DISK !== '1'

// slug -> map id. Cached because it is asked on every png request and a map's
// id never changes. Negative answers are cached briefly too, so a request for a
// map that does not exist does not hit the database on every frame.
const ids = new Map()
const MISS_MS = 5000

export async function mapIdFor(slug, { create = false } = {}) {
  const hit = ids.get(slug)
  if (hit && (hit.id || Date.now() - hit.at < MISS_MS)) return hit.id
  let m = await getMapBySlug(slug)
  if (!m && create) {
    const E = env()
    const owner = await ensureUser({
      email: need(`BOOTSTRAP_EMAIL`),
      password: need(`BOOTSTRAP_PASSWORD`),
      displayName: 'Algorithmic Thinking Club',
      claude: 'relay',
      pixellab: 'relay',
    })
    // a brand new scene has no geometry yet; the first autosave fills it in
    m = await createMap({ slug, ownerId: owner.id, title: slug, w: 1, h: 1 })
  }
  ids.set(slug, { id: m?.id || null, at: Date.now() })
  return m?.id || null
}

export const forgetMap = (slug) => ids.delete(slug)

// ---- the document ----------------------------------------------------------

export async function saveDocument(slug, docString) {
  const id = await mapIdFor(slug, { create: true })
  const r = await putDoc(id, docString)
  // the row's own updated_at, so the browser records exactly what the server
  // thinks the time is rather than what the browser's clock thinks
  const t = await one('select updated_at from maps where id = $1', [id])
  return { bytes: docString.length, savedAt: t ? +new Date(t.updated_at) : Date.now(), ...r }
}

export async function loadDocument(slug) {
  const id = await mapIdFor(slug)
  if (!id) return null
  const doc = await getDoc(id)
  if (!doc) return null
  const t = await one('select updated_at from maps where id = $1', [id])
  return { doc, savedAt: t ? +new Date(t.updated_at) : 0 }
}

// ---- the library -----------------------------------------------------------

// One select, where the filesystem version walked the directory and probed for
// dirs.json, then 0.png, then effect.json, opening a file descriptor per item
// to read 24 bytes of png header. On the hub that was 71 probes per listing.
//
// The returned shape is exactly what libraryItems() returned, because App.tsx
// reads it directly and this is a backend swap, not a redesign.
export async function libraryOf(slug) {
  const id = await mapIdFor(slug)
  if (!id) return []
  const rows = await many(
    `select l.*,
            coalesce(
              (select jsonb_agg(jsonb_build_object(
                        'name', s.face, 'dirs', s.dirs, 'fps', s.fps,
                        'src', s.src, 'w', s.w, 'h', s.h) order by s.face)
               from library_states s where s.item_id = l.id), '[]'::jsonb) as states
     from library_items l where l.map_id = $1 order by l.name`,
    [id],
  )
  const base = `/work/${slug}/library`
  return rows.map((r) => {
    const it = { name: r.name, kind: r.kind, w: r.w, h: r.h }
    if (r.fps) it.fps = r.fps
    if (r.is_effect) it.effect = true
    if (r.frame_count > 0) it.frames = Array.from({ length: r.frame_count }, (_, i) => `${base}/${r.name}/${i}.png`)
    else it.src = `${base}/${r.name}.png`
    if (r.dirs) {
      // stored as blob keys; handed back as urls in the same /work/ space
      it.dirs = Object.fromEntries(
        Object.entries(r.dirs).map(([h, list]) => [h, list.map((k) => '/work/' + k.replace(`maps/${id}/`, `${slug}/`))]),
      )
    }
    // the same shape statesOf() returned off disk, because App.tsx picks a face
    // by name and draws it at the size it reports
    const st = Array.isArray(r.states) ? r.states : []
    if (st.length) it.states = st
    if (r.origin && (r.origin.objectId || r.origin.characterId)) it.canState = true
    return it
  })
}

// ---- serving a png ---------------------------------------------------------

// /work/<slug>/library/base.png            -> maps/<id>/library/base.png
// /work/<slug>/library/gull/3.png          -> maps/<id>/library/gull/3.png
// /work/<slug>/scene.png                   -> maps/<id>/scene.png
// /work/<slug>/states/troll/boulder/...    -> maps/<id>/states/troll/boulder/...
export async function blobKeyForWorkPath(rel) {
  const parts = String(rel).split('/').filter(Boolean).map(decodeURIComponent)
  if (parts.length < 2) return null
  const [slug, ...rest] = parts
  const id = await mapIdFor(slug)
  if (!id) return null
  return `maps/${id}/${rest.join('/')}`
}

const MIME = { png: 'image/png', json: 'application/json', jpg: 'image/jpeg' }

export async function serveFromStore(res, rel, req) {
  const key = await blobKeyForWorkPath(rel)
  if (!key) return false
  let buf
  try {
    buf = await store().get(key)
  } catch {
    return false
  }
  res.setHeader('Content-Type', MIME[key.split('.').pop().toLowerCase()] || 'application/octet-stream')

  /* THE AUTHOR'S WORKING COPY, WHICH CHANGES UNDER THEM, AND STILL MUST NOT BE
   * RE-DOWNLOADED EVERY TIME.
   *
   * This was no-store, which is the honest answer to "these bytes can change"
   * and the wrong one. no-store means the browser keeps nothing, so re-opening
   * a map pulled every png in its library down again, and the dashboard pulled
   * every thumbnail again on every visit.
   *
   * An ETag says the same thing without the cost. The tag is the content, so it
   * changes exactly when the picture changes and never when it has not, and a
   * browser holding the current bytes gets a 304 with no body. What it cannot
   * do is show a stale picture: a changed png is a changed tag, which is a
   * full response. */
  const etag = '"' + crypto.createHash('sha1').update(buf).digest('base64url') + '"'
  res.setHeader('ETag', etag)
  res.setHeader('Cache-Control', 'private, no-cache')
  if (req && req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    res.end()
    return true
  }
  res.end(buf)
  return true
}

// ---- writing a png ---------------------------------------------------------

// Every generation path in api.mjs ends by putting bytes somewhere. These are
// the two calls that replaces, so no route needs to know about keys.
export async function putLibraryStill(slug, name, buf, meta = {}) {
  const id = await mapIdFor(slug, { create: true })
  await store().put(keys.libStill(id, name), buf, 'image/png')
  await upsertItem(id, name, 'static', { ...meta, frame_count: 0, prefix: keys.libPrefix(id, name) })
  return `/work/${slug}/library/${name}.png`
}

export async function putLibraryFrames(slug, name, buffers, meta = {}) {
  const id = await mapIdFor(slug, { create: true })
  for (let i = 0; i < buffers.length; i++) await store().put(keys.libFrame(id, name, i), buffers[i], 'image/png')
  await upsertItem(id, name, 'animated', { ...meta, frame_count: buffers.length, prefix: keys.libPrefix(id, name) })
  return buffers.map((_, i) => `/work/${slug}/library/${name}/${i}.png`)
}

async function upsertItem(mapId, name, kind, o) {
  await one(
    `insert into library_items (map_id, name, kind, is_effect, w, h, fps, frame_count, dirs, effect, origin, blob_prefix)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12)
     on conflict (map_id, name) do update set
       kind=excluded.kind, is_effect=excluded.is_effect, w=excluded.w, h=excluded.h,
       fps=excluded.fps, frame_count=excluded.frame_count,
       dirs=coalesce(excluded.dirs, library_items.dirs),
       effect=coalesce(excluded.effect, library_items.effect),
       origin=coalesce(excluded.origin, library_items.origin)
     returning id`,
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
      o.prefix,
    ],
  )
}

// ---- pushing a just-written item into the store -----------------------------

// The generation routes are intricate: collision loops that probe for a free
// filename, a .stage folder swapped in atomically, .prev kept so an edit can be
// undone. All of that is tested and none of it is worth rewriting.
//
// So disk stays the scratch area where those run, and this is called the moment
// one finishes: it reads what landed and pushes it to the store, which is the
// durable copy. Four call sites, because there are only four functions that
// ever finish a library write.
//
// It also means a hosted server works with an ephemeral disk, since the bytes
// are in object storage before the request ends.
export async function pushItem(slug, name, workDir) {
  if (!platformOn()) return null
  const fs = await import('node:fs')
  const path = await import('node:path')
  const id = await mapIdFor(slug, { create: true })
  const lib = path.join(workDir, 'library')
  const s = store()

  const size = (f) => {
    const fd = fs.openSync(f, 'r')
    const b = Buffer.alloc(24)
    fs.readSync(fd, b, 0, 24, 0)
    fs.closeSync(fd)
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  }

  // a still
  const still = path.join(lib, `${name}.png`)
  if (fs.existsSync(still)) {
    const buf = fs.readFileSync(still)
    await s.put(keys.libStill(id, name), buf, 'image/png')
    const { w, h } = size(still)
    await upsertItem(id, name, 'static', { w, h, frame_count: 0, prefix: keys.libPrefix(id, name), origin: originOf(fs, path, workDir, name) })
    return { name, kind: 'static' }
  }

  const folder = path.join(lib, name)
  if (!fs.existsSync(folder)) return null

  // frames, and any per-heading folders beside them
  const meta = readJson(fs, path.join(folder, 'dirs.json'))
  const effect = readJson(fs, path.join(folder, 'effect.json'))
  let n = 0
  let w = 0
  let h = 0
  while (fs.existsSync(path.join(folder, n + '.png'))) {
    const f = path.join(folder, n + '.png')
    if (!n) ({ w, h } = size(f))
    await s.put(keys.libFrame(id, name, n), fs.readFileSync(f), 'image/png')
    n++
  }

  const dirs = {}
  for (const ent of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const heading = ent.name
    dirs[heading] = []
    for (let i = 0; fs.existsSync(path.join(folder, heading, i + '.png')); i++) {
      const f = path.join(folder, heading, i + '.png')
      if (!w) ({ w, h } = size(f))
      const key = `maps/${id}/library/${name}/${heading}/${i}.png`
      await s.put(key, fs.readFileSync(f), 'image/png')
      dirs[heading].push(key)
    }
    if (!dirs[heading].length) delete dirs[heading]
  }

  await upsertItem(id, name, n > 1 || Object.keys(dirs).length ? 'animated' : 'static', {
    w,
    h,
    fps: effect?.fps ?? meta?.fps ?? null,
    frame_count: n,
    dirs: Object.keys(dirs).length ? dirs : null,
    effect,
    is_effect: !!effect,
    origin: originOf(fs, path, workDir, name) || (meta?.characterId ? { characterId: meta.characterId } : null),
    prefix: keys.libPrefix(id, name),
  })
  const faces = await pushStates(slug, name, workDir)
  return { name, frames: n, dirs: Object.keys(dirs).length, faces }
}

/* The same thing wearing another face: a troll's boulder, a character's every
 * heading. A face lives one folder deeper than the library does, because a
 * character state comes back as whole headings and nesting keeps a heading's
 * frames in order without encoding the order into the filename.
 *
 * The client reads a face's size and fps to draw it, so those become columns
 * rather than something re-derived by opening a png per face on every listing. */
export async function pushStates(slug, item, workDir) {
  if (!platformOn()) return 0
  const fs = await import('node:fs')
  const path = await import('node:path')
  const id = await mapIdFor(slug, { create: true })
  const row = await one('select id from library_items where map_id = $1 and name = $2', [id, item])
  if (!row) return 0

  const dir = path.join(workDir, 'states', item)
  const seen = []
  const s = store()
  const size = (f) => {
    const fd = fs.openSync(f, 'r')
    const b = Buffer.alloc(24)
    fs.readSync(fd, b, 0, 24, 0)
    fs.closeSync(fd)
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  }

  if (fs.existsSync(dir)) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const face = ent.name
      const faceDir = path.join(dir, face)
      const meta = readJson(fs, path.join(faceDir, 'dirs.json'))
      const base = `/work/${slug}/states/${encodeURIComponent(item)}/${encodeURIComponent(face)}`
      const dirs = {}
      let frames = 0
      let w = 0
      let h = 0
      let src = null

      // headings, each with its own frames
      for (const sub of fs.readdirSync(faceDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue
        const heading = sub.name
        dirs[heading] = []
        for (let i = 0; fs.existsSync(path.join(faceDir, heading, i + '.png')); i++) {
          const f = path.join(faceDir, heading, i + '.png')
          if (!w) ({ w, h } = size(f))
          await s.put(keys.state(id, item, face, heading, i), fs.readFileSync(f), 'image/png')
          dirs[heading].push(`${base}/${encodeURIComponent(heading)}/${i}.png`)
          frames++
        }
        if (!dirs[heading].length) delete dirs[heading]
      }
      // or a flat run of frames when the face has no headings
      for (let i = 0; fs.existsSync(path.join(faceDir, i + '.png')); i++) {
        const f = path.join(faceDir, i + '.png')
        if (!w) ({ w, h } = size(f))
        await s.put(`maps/${id}/states/${item}/${face}/${i}.png`, fs.readFileSync(f), 'image/png')
        frames++
      }
      if (!frames) continue
      src = Object.keys(dirs).length ? (dirs.south || Object.values(dirs)[0])[0] : `${base}/0.png`

      await q(
        `insert into library_states (item_id, face, dirs, frame_count, blob_prefix, fps, w, h, src)
         values ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)
         on conflict (item_id, face) do update set
           dirs=excluded.dirs, frame_count=excluded.frame_count, fps=excluded.fps,
           w=excluded.w, h=excluded.h, src=excluded.src`,
        [
          row.id,
          face,
          Object.keys(dirs).length ? JSON.stringify(dirs) : null,
          frames,
          keys.statePrefix(id, item, face),
          Number(meta?.fps) > 0 ? Math.round(Number(meta.fps)) : Object.keys(dirs).length ? 8 : 6,
          w,
          h,
          src,
        ],
      )
      seen.push(face)
    }
  }

  // a face removed on disk must leave the table too
  await q(
    seen.length
      ? 'delete from library_states where item_id = $1 and face <> all($2::text[])'
      : 'delete from library_states where item_id = $1',
    seen.length ? [row.id, seen] : [row.id],
  )
  return seen.length
}

const readJson = (fs, f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

const originOf = (fs, path, workDir, name) => readJson(fs, path.join(workDir, 'origin.json'))?.[name] || null

/* ---- versions: what .prev holds, kept where the laptop is not --------------
 *
 * An in-place edit rewrites the item and z puts the pixels back. On disk that
 * is the .prev folder, capped at 8 so an edit cannot roll its own original
 * away. None of that survives the laptop, and an undo that only works on one
 * machine is not an undo.
 *
 * Snapshotting copies inside the bucket rather than downloading and re-uploading
 * the bytes, so keeping a version costs one server-side copy per file and no
 * transfer at all. Called at the moment before an item is overwritten, when what
 * is in the store still IS the previous version. */
const PREV_MAX = 8

export async function snapshotVersion(slug, name) {
  if (!platformOn()) return null
  const id = await mapIdFor(slug)
  if (!id) return null
  const item = await one('select id from library_items where map_id = $1 and name = $2', [id, name])
  if (!item) return null

  const s = store()
  const live = [...(await s.list(keys.libPrefix(id, name))), ...(await s.list(keys.libStill(id, name)))]
  if (!live.length) return null

  const last = await one('select coalesce(max(seq), 0) v from library_versions where item_id = $1', [item.id])
  const seq = Number(last.v) + 1
  const prefix = keys.version(id, name, seq)
  for (const o of live) await s.copy(o.key, prefix + o.key.split(`/library/`)[1])

  const row = await one(
    `insert into library_versions (item_id, seq, blob_prefix, meta)
     values ($1,$2,$3,$4::jsonb) returning id`,
    [item.id, seq, prefix, JSON.stringify({ files: live.length })],
  )

  // the same rollover PREV_MAX gave the folder: oldest goes first, so an edit
  // can never roll its own original away
  const old = await many(
    'select id, blob_prefix from library_versions where item_id = $1 order by seq desc offset $2',
    [item.id, PREV_MAX],
  )
  for (const o of old) {
    await s.delPrefix(o.blob_prefix)
    await q('delete from library_versions where id = $1', [o.id])
  }
  return { seq, files: live.length, id: row.id }
}

// How far back this item can be put. The editor asks so the undo affordance can
// say something true instead of guessing.
export const versionsOf = async (slug, name) => {
  if (!platformOn()) return []
  const id = await mapIdFor(slug)
  if (!id) return []
  return many(
    `select v.seq, v.meta, v.created_at from library_versions v
     join library_items l on l.id = v.item_id
     where l.map_id = $1 and l.name = $2 order by v.seq desc`,
    [id, name],
  )
}

/* Put the newest kept version back, for a machine whose .prev folder holds
 * nothing because the edit happened somewhere else. */
export async function restoreVersion(slug, name) {
  if (!platformOn()) return null
  const id = await mapIdFor(slug)
  if (!id) return null
  const v = await one(
    `select v.* from library_versions v join library_items l on l.id = v.item_id
     where l.map_id = $1 and l.name = $2 order by v.seq desc limit 1`,
    [id, name],
  )
  if (!v) return null
  const s = store()
  // the copy being replaced becomes a version too, so a restore is reversible
  await snapshotVersion(slug, name)
  await s.delPrefix(keys.libPrefix(id, name))
  await s.del(keys.libStill(id, name)).catch(() => {})
  const held = await s.list(v.blob_prefix)
  for (const o of held) await s.copy(o.key, `maps/${id}/library/${o.key.slice(v.blob_prefix.length)}`)
  await q('delete from library_versions where id = $1', [v.id])
  await s.delPrefix(v.blob_prefix)
  return { seq: v.seq, files: held.length }
}

// A deleted item has to leave both stores, or it comes back on the next listing.
export async function dropItem(slug, name) {
  if (!platformOn()) return
  const id = await mapIdFor(slug)
  if (!id) return
  const s = store()
  await s.delPrefix(keys.libPrefix(id, name))
  await s.del(keys.libStill(id, name)).catch(() => {})
  await one('delete from library_items where map_id = $1 and name = $2 returning id', [id, name])
}

// A name nobody has used in this map yet, matching the -2, -3 suffix the
// filesystem version got from probing for a free filename.
export async function freeName(slug, want) {
  const id = await mapIdFor(slug, { create: true })
  const taken = new Set((await many('select name from library_items where map_id = $1', [id])).map((r) => r.name))
  if (!taken.has(want)) return want
  for (let i = 2; ; i++) if (!taken.has(`${want}-${i}`)) return `${want}-${i}`
}
