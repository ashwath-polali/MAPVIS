// The database-backed versions of the three things api.mjs used to do with the
// filesystem: save and load a document, list a library, and serve a png.
//
// The URL space does not change. The editor still asks for
// /work/<slug>/library/base.png and still gets a png back; it simply comes out
// of object storage now. Keeping the old shape is what lets the whole backend
// move without touching 17,000 lines of client, and it is why the placement
// urls already sitting inside every saved document keep resolving.
import { one, many } from '../db/pool.mjs'
import { store, keys } from './blobs.mjs'
import { getDoc, putDoc, getMapBySlug, createMap, ensureUser } from './maps.mjs'
import { env } from '../db/env.mjs'

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
      email: E.BOOTSTRAP_EMAIL || 'atc@bonneylake.local',
      password: E.BOOTSTRAP_PASSWORD || 'change-me-on-first-login',
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
  return { bytes: docString.length, ...r }
}

export async function loadDocument(slug) {
  const id = await mapIdFor(slug)
  if (!id) return ''
  return (await getDoc(id)) || ''
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
              (select jsonb_agg(jsonb_build_object('face', s.face, 'dirs', s.dirs, 'frames', s.frame_count)
                                order by s.face)
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
    const st = Array.isArray(r.states) ? r.states : []
    if (st.length) it.states = st.map((s) => s.face)
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

export async function serveFromStore(res, rel) {
  const key = await blobKeyForWorkPath(rel)
  if (!key) return false
  let buf
  try {
    buf = await store().get(key)
  } catch {
    return false
  }
  res.setHeader('Content-Type', MIME[key.split('.').pop().toLowerCase()] || 'application/octet-stream')
  // the author's working copy, which changes under them constantly. A published
  // bundle is a different key space and is cached forever; this must not be.
  res.setHeader('Cache-Control', 'no-store')
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

// A name nobody has used in this map yet, matching the -2, -3 suffix the
// filesystem version got from probing for a free filename.
export async function freeName(slug, want) {
  const id = await mapIdFor(slug, { create: true })
  const taken = new Set((await many('select name from library_items where map_id = $1', [id])).map((r) => r.name))
  if (!taken.has(want)) return want
  for (let i = 2; ; i++) if (!taken.has(`${want}-${i}`)) return `${want}-${i}`
}
