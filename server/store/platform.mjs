// the url space does not change, because the placement urls already inside every saved document have to keep resolving
import crypto from 'node:crypto'
import { q, one, many } from '../db/pool.mjs'
import { store, keys, onBlobWrite, takeBucketOps } from './blobs.mjs'
import { getDoc, putDoc, getMapBySlug, createMap, ensureUser } from './maps.mjs'
import { env, need } from '../db/env.mjs'
import { request } from './ctx.mjs'

// Is the platform on at all? With no database configured the tool falls back to
// work/ and behaves exactly as it did before, which is the degraded-not-broken
// rule applied to the backend itself.
export const platformOn = () => {
  const E = env()
  return E.MAPVIS_STORAGE !== 'work' && !!(E.DATABASE_POOLED_URL || E.DATABASE_URL)
}

// disk fallback stays on so a database blip cannot lose an author's work, and MAPVIS_NO_DISK=1 takes it away so a gate can prove the map really lives off this laptop
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
    /* a new map belongs to whoever made it, and an http request with no signed-in user gets nothing, or a stranger creates rows on somebody else's account by naming a slug */
    const req = request()
    if (req.http && !req.user) return null
    const ownerId =
      req.user?.id ||
      (
        await ensureUser({
          email: need(`BOOTSTRAP_EMAIL`),
          password: need(`BOOTSTRAP_PASSWORD`),
          displayName: env().BOOTSTRAP_NAME || 'Maps',
          claude: 'relay',
          pixellab: 'relay',
        })
      ).id
    // a brand new scene has no geometry yet; the first autosave fills it in
    m = await createMap({ slug, ownerId, title: slug, w: 1, h: 1 })
  }
  ids.set(slug, { id: m?.id || null, at: Date.now() })
  return m?.id || null
}

export const forgetMap = (slug) => ids.delete(slug)

// ---- the document ----------------------------------------------------------

export async function saveDocument(slug, docString) {
  const id = await mapIdFor(slug, { create: true })
  /* the refusal is a sentence and not a null, because a null read as a database outage falls through to the disk fallback and writes to /tmp on a host */
  if (!id) {
    const e = new Error('sign in to create a map')
    e.name = 'NoOwner'
    throw e
  }
  const r = await putDoc(id, docString)
  // the row's own updated_at, so the browser records exactly what the server
  // thinks the time is rather than what the browser's clock thinks
  const t = await one('select updated_at from maps where id = $1', [id])
  return { bytes: docString.length, savedAt: t ? +new Date(t.updated_at) : Date.now(), ...r }
}

/* the painting goes to the bucket on save, because writing only work/<slug>/scene.png puts it in a Vercel tmpdir that is gone by the next request */
export async function savePainting(slug, buf) {
  const id = await mapIdFor(slug, { create: true })
  if (!id) {
    const e = new Error('sign in to create a map')
    e.name = 'NoOwner'
    throw e
  }
  const key = `maps/${id}/scene.png`
  await store().put(key, buf, 'image/png')
  return key
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

// one select where the filesystem version cost 71 probes per listing on the hub, and the returned shape is unchanged because App.tsx reads it directly
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
    /* A SET OF HEADINGS IS STATIC WITH DIRS, and every other reader in this tool already says so:
     * libraryItems off the disk, readLook in the editor, and the routes' own answers. Only this
     * column disagreed, because a view set writes <heading>-<i>.png and never 0.png, so frame_count
     * is 0 while the kind came out 'animated'.
     *
     * What that cost: the client places by kind, and for 'animated' it copies `frames` and never
     * touches `src`. frame_count 0 means there are no frames to copy, so the placement landed with
     * an empty frame list and nothing else: no ghost under the cursor, a 24 by 24 handle box round a
     * 36 by 48 figure, no library row resolvable from it so the whole inspector vanished, and on
     * export no resting heading so every such figure shipped facing south. Measured on the live
     * database: 27 of 27 view sets are stored this way.
     *
     * Healed here rather than migrated, so rows written by the old code come back right on the next
     * read and nothing has to be republished. upsertItem writes it correctly from now on. */
    const kind = r.dirs && !(r.frame_count > 1) ? 'static' : r.kind
    const it = { name: r.name, kind, w: r.w, h: r.h }
    if (r.fps) it.fps = r.fps
    if (r.is_effect) it.effect = true
    if (r.frame_count > 0) it.frames = Array.from({ length: r.frame_count }, (_, i) => `${base}/${r.name}/${i}.png`)
    if (r.dirs) {
      // stored as blob keys; handed back as urls in the same /work/ space
      it.dirs = Object.fromEntries(
        Object.entries(r.dirs).map(([h, list]) => [h, list.map((k) => '/work/' + k.replace(`maps/${id}/`, `${slug}/`))]),
      )
    }
    /* a direction set owns no flat still, so without a first-frame thumbnail the panel asks for a <name>.png that was never written */
    if (r.frame_count === 0) {
      const facing = it.dirs && (it.dirs.south || it.dirs[Object.keys(it.dirs)[0]])
      it.src = facing?.length ? facing[0] : `${base}/${r.name}.png`
    }
    // the same shape statesOf() returned off disk, because App.tsx picks a face
    // by name and draws it at the size it reports
    const st = Array.isArray(r.states) ? r.states : []
    if (st.length) it.states = st
    if (r.origin && (r.origin.objectId || r.origin.characterId)) it.canState = true
    /* the origin and the effect recipe come back whole, because an item pushed before the sidecars has frames in the bucket and no dirs.json */
    if (r.origin && typeof r.origin === 'object') it.origin = r.origin
    if (r.effect && typeof r.effect === 'object') it.effectJson = r.effect
    return it
  })
}

/* cached because opening a map is a couple of hundred png requests each needing this check, and the cost of thirty seconds of staleness is an old owner reading a just-transferred map */
const OWNER_TTL = 30_000
const owners = new Map()
export async function ownerOfSlug(slug) {
  if (!platformOn() || !slug) return null
  const hit = owners.get(slug)
  if (hit && Date.now() - hit.at < OWNER_TTL) return hit.id
  try {
    const r = await one('select owner_id from maps where slug = $1', [slug])
    const id = r?.owner_id || null
    if (owners.size > 2000) owners.clear()
    owners.set(slug, { id, at: Date.now() })
    return id
  } catch {
    return null
  }
}
export const forgetOwner = (slug) => owners.delete(slug)

// ---- what the bucket has been asked to do, and the line it will not cross ---

/* r2 has no spend cap so the cap lives here, at eighty percent of the free 10 million reads and 1 million writes a month */
const LIMITS = () => ({
  b: Number(env().R2_MONTHLY_READ_LIMIT || 8_000_000),
  a: Number(env().R2_MONTHLY_WRITE_LIMIT || 800_000),
})
const monthKey = () => new Date().toISOString().slice(0, 7)

let budgetMemo = { at: 0, row: null }
export async function bucketBudget() {
  if (!platformOn()) return null
  const now = Date.now()
  if (budgetMemo.row && now - budgetMemo.at < 60_000) return budgetMemo.row
  try {
    const r = await one('select class_a, class_b from bucket_usage where month = $1', [monthKey()])
    const lim = LIMITS()
    const row = {
      month: monthKey(),
      a: Number(r?.class_a || 0),
      b: Number(r?.class_b || 0),
      limitA: lim.a,
      limitB: lim.b,
      overA: Number(r?.class_a || 0) >= lim.a,
      overB: Number(r?.class_b || 0) >= lim.b,
    }
    budgetMemo = { at: now, row }
    return row
  } catch {
    return null
  }
}

// Called once at the end of a request, with whatever that request spent.
export async function noteBucketUsage() {
  if (!platformOn()) return
  const d = takeBucketOps()
  if (!d.a && !d.b) return
  try {
    await q(
      `insert into bucket_usage (month, class_a, class_b, updated_at) values ($1,$2,$3, now())
       on conflict (month) do update set
         class_a = bucket_usage.class_a + excluded.class_a,
         class_b = bucket_usage.class_b + excluded.class_b,
         updated_at = now()`,
      [monthKey(), d.a, d.b],
    )
    // the cached total is now wrong by exactly this much, so correct it rather
    // than waiting out the minute
    if (budgetMemo.row) {
      budgetMemo.row.a += d.a
      budgetMemo.row.b += d.b
      budgetMemo.row.overA = budgetMemo.row.a >= budgetMemo.row.limitA
      budgetMemo.row.overB = budgetMemo.row.b >= budgetMemo.row.limitB
    }
  } catch {
    /* losing a count must never fail a request that already succeeded */
  }
}

// ---- serving a png ---------------------------------------------------------

// /work/<slug>/<anything> maps to maps/<id>/<anything>, so the slug is swapped for the id and the rest of the path is kept
export async function blobKeyForWorkPath(rel) {
  const parts = String(rel).split('/').filter(Boolean).map(decodeURIComponent)
  if (parts.length < 2) return null
  const [slug, ...rest] = parts
  const id = await mapIdFor(slug)
  if (!id) return null
  return `maps/${id}/${rest.join('/')}`
}

const MIME = { png: 'image/png', json: 'application/json', jpg: 'image/jpeg' }

/* blob_shas records a sha at write time so "has this changed" is a primary-key lookup, or a 304 costs a full bucket read and reopening a map spends 156 of them */
const tagOf = (sha) => '"' + sha + '"'

async function knownTag(key) {
  if (!platformOn()) return null
  try {
    const r = await one('select sha from blob_shas where key = $1', [key])
    return r?.sha ? tagOf(r.sha) : null
  } catch {
    return null
  }
}

// Registered once. The sha is written beside the bytes rather than derived
// later, because a tag that is recomputed on read is a tag that costs a read.
let hooked = false
function hookBlobWrites() {
  if (hooked) return
  hooked = true
  onBlobWrite(async (kind, key, body) => {
    if (!platformOn()) return
    if (kind === 'put' && body) {
      const sha = crypto.createHash('sha1').update(body).digest('base64url')
      await q(
        `insert into blob_shas (key, sha, bytes, updated_at) values ($1,$2,$3, now())
         on conflict (key) do update set sha = excluded.sha, bytes = excluded.bytes, updated_at = now()`,
        [key, sha, body.length],
      )
    } else if (kind === 'del') {
      await q('delete from blob_shas where key = $1', [key])
    } else if (kind === 'delPrefix') {
      await q('delete from blob_shas where key like $1', [key + '%'])
    }
  })
}

export async function serveFromStore(res, rel, req) {
  hookBlobWrites()
  const key = await blobKeyForWorkPath(rel)
  if (!key) return false

  /* answered without touching the bucket, which is the branch that makes reopening a map free */
  const known = req && req.headers['if-none-match'] ? await knownTag(key) : null
  if (known && req.headers['if-none-match'] === known) {
    res.setHeader('ETag', known)
    res.setHeader('Cache-Control', 'private, no-cache')
    res.statusCode = 304
    res.end()
    return true
  }

  let buf
  try {
    buf = await store().get(key)
  } catch {
    return false
  }
  res.setHeader('Content-Type', MIME[key.split('.').pop().toLowerCase()] || 'application/octet-stream')

  /* an etag and not no-store, because no-store makes the browser keep nothing and re-download every png in a library on every open */
  const etag = '"' + crypto.createHash('sha1').update(buf).digest('base64url') + '"'
  res.setHeader('ETag', etag)
  res.setHeader('Cache-Control', 'private, no-cache')

  /* the tag is backfilled on first read, because an object stored before this table has no row and a migration would have to walk the whole bucket to make one */
  if (platformOn()) {
    q(
      `insert into blob_shas (key, sha, bytes, updated_at) values ($1,$2,$3, now())
       on conflict (key) do update set sha = excluded.sha, bytes = excluded.bytes, updated_at = now()`,
      [key, etag.slice(1, -1), buf.length],
    ).catch(() => {
      /* the bytes are already in hand; failing to remember them is not a
       * reason to fail the response */
    })
  }

  if (req && req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    res.end()
    return true
  }
  res.end(buf)
  return true
}

/* the bytes are pulled to disk because export resolves every placement through a filesystem call, and on a host that returned null for all of them and published an empty island as a success */
export async function hydrateMap(slug, dir) {
  if (!platformOn()) return { pulled: 0, bytes: 0, skipped: 0 }
  const fs = await import('node:fs')
  const path = await import('node:path')
  const id = await mapIdFor(slug)
  if (!id) return { pulled: 0, bytes: 0, skipped: 0 }

  const s = store()
  const prefix = `maps/${id}/`
  let pulled = 0
  let bytes = 0
  let skipped = 0
  const failed = []

  const want = []
  for (const o of await s.list(prefix)) {
    const key = String(o.key || o)
    const rel = key.slice(prefix.length)
    if (!rel) continue
    const f = path.join(dir, ...rel.split('/'))
    if (fs.existsSync(f)) skipped++
    else want.push([key, f])
  }

  /* twelve lanes, because 1,383 objects one at a time measured 260 seconds against a maxDuration of 300 */
  const LANES = 12
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(LANES, want.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= want.length) return
        const [key, f] = want[i]
        /* the retry lives here and not in the client, whose maxAttempts:1 is right, because ten of 1,383 files vanished silently to transient resets at twelve lanes */
        let got = null
        for (let attempt = 0; attempt < 3 && !got; attempt++) {
          try {
            got = await s.get(key)
          } catch {
            if (attempt < 2) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)))
          }
        }
        if (!got) {
          failed.push(key)
          continue
        }
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, got)
        pulled++
        bytes += got.length
      }
    }),
  )
  // said out loud rather than swallowed: a file that did not arrive is a frame
  // that will be missing from the bundle, and the export must not look clean
  if (failed.length) console.error(`[hydrate] ${slug}: ${failed.length} object(s) could not be read, e.g. ${failed[0]}`)
  return { pulled, bytes, skipped, failed: failed.length }
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

// disk stays the scratch area the generation routes run in, and this pushes what landed to the store before the request ends, so an ephemeral disk still works
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

  /* THE FOLDER WINS OVER THE LOOSE PNG WHEN BOTH ARE THERE, and both are there
   * for the length of one swap. Turning a still into an animation writes the
   * frame folder, pushes, and only then deletes the png, so that the original
   * is still standing if the write dies halfway. Reading the png first during
   * that window records the row as a still with no frames, the png is deleted a
   * moment later, and the library is left calling an animated thing a still
   * that points at bytes nobody has. Nothing is animated again until the map is
   * reconciled by hand.
   *
   * A frame folder and a png of the same name is never a resting state, so the
   * folder is the newer of the two and the one to believe. */
  const folderFirst = fs.existsSync(path.join(lib, name))

  // a still
  const still = path.join(lib, `${name}.png`)
  if (!folderFirst && fs.existsSync(still)) {
    const buf = fs.readFileSync(still)
    await s.put(keys.libStill(id, name), buf, 'image/png')
    /* AND THE FRAMES IT USED TO BE ARE GONE FROM THE STORE, after the still is safely up. Taking the
     * animation off a thing left them there: hydrateMap pulls a map's whole library back down onto
     * an empty work/, so the folder reappeared beside the png, folderFirst read true again, and the
     * thing was animated once more on the very next request. On a host, where work/ is always empty
     * and so a hydrate always runs, removing an animation did not stick at all. The store has to
     * hold the shape the disk holds and no other. */
    await s.delPrefix(keys.libPrefix(id, name))
    const { w, h } = size(still)
    await upsertItem(id, name, 'static', { w, h, frame_count: 0, prefix: keys.libPrefix(id, name), origin: originOf(fs, path, workDir, name) })
    /* AND ITS FACES, which this branch used to return before ever reaching. An object is a loose png,
     * so every second face ever drawn for one was skipped here and stored nowhere at all. */
    const faces = await pushStates(slug, name, workDir)
    return { name, kind: 'static', faces }
  }

  const folder = path.join(lib, name)
  if (!fs.existsSync(folder)) return null

  // frames, and any per-heading folders beside them
  const meta = readJson(fs, path.join(folder, 'dirs.json'))
  const effect = readJson(fs, path.join(folder, 'effect.json'))
  /* EVERY KEY THIS PUSH WRITES, so that whatever is left under the item's prefix afterwards can be
   * recognised as belonging to a shape it no longer has and removed. Counting is not enough: a
   * heading set, a frame list and a written effect put files in three different shapes, and an
   * eight-frame motion replaced by a four-frame one leaves frames four to seven sitting there for
   * the next hydrate to pull down and the disk reader to count. */
  const wrote = new Set()
  const put = async (key, buf, ct) => {
    wrote.add(key)
    await s.put(key, buf, ct)
  }
  let n = 0
  let w = 0
  let h = 0
  while (fs.existsSync(path.join(folder, n + '.png'))) {
    const f = path.join(folder, n + '.png')
    if (!n) ({ w, h } = size(f))
    await put(keys.libFrame(id, name, n), fs.readFileSync(f), 'image/png')
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
      await put(key, fs.readFileSync(f), 'image/png')
      dirs[heading].push(key)
    }
    if (!dirs[heading].length) delete dirs[heading]
  }

  /* a direction set is flat files beside dirs.json and not subfolders, dirs.json is the authority, and the fallback scan tries two-word headings first so north-east never reads as north */
  const HEADINGS = ['north-east', 'north-west', 'south-east', 'south-west', 'north', 'south', 'east', 'west']
  if (!Object.keys(dirs).length) {
    const take = async (heading, file, into) => {
      const f = path.join(folder, file)
      if (!fs.existsSync(f)) return
      if (!w) ({ w, h } = size(f))
      const key = `maps/${id}/library/${name}/${file}`
      await put(key, fs.readFileSync(f), 'image/png')
      into.push(key)
    }
    if (meta?.dirs && typeof meta.dirs === 'object') {
      for (const [heading, list] of Object.entries(meta.dirs)) {
        const out = []
        // the entries are /work/<slug>/library/<name>/<file> urls; only the
        // last segment is ours to trust, since the slug in them can be stale
        for (const u of Array.isArray(list) ? list : []) await take(heading, String(u).split('/').pop(), out)
        if (out.length) dirs[heading] = out
      }
    } else {
      for (const heading of HEADINGS) {
        const out = []
        for (let i = 0; fs.existsSync(path.join(folder, `${heading}-${i}.png`)); i++) await take(heading, `${heading}-${i}.png`, out)
        // a standing view set is one bare <heading>.png with no cycle beside
        // it, and a sprite that has both keeps the cycle rather than the pose
        if (!out.length) await take(heading, `${heading}.png`, out)
        if (out.length) dirs[heading] = out
      }
    }
  }

  /* the two sidecars go up with the frames, because hydrateMap pulls the pngs back onto an empty work/ and the disk readers read the files rather than the row */
  if (meta) await put(`maps/${id}/library/${name}/dirs.json`, Buffer.from(JSON.stringify(meta)), 'application/json')
  if (effect) await put(`maps/${id}/library/${name}/effect.json`, Buffer.from(JSON.stringify(effect)), 'application/json')

  /* NOW THE STORE HOLDS THIS SHAPE AND NOTHING ELSE. Two things go: the loose png, if this item used
   * to be a still and has just been animated, and anything still under the folder that this push did
   * not write, which is the tail of a longer motion or the flat headings of a set that has become a
   * frame list. Both only ever come back to bite on a host, where hydrateMap pulls the whole library
   * down onto an empty work/ and the disk readers believe what they find there. Done last, so
   * nothing is removed until what replaces it is up. */
  await s.del(keys.libStill(id, name)).catch(() => {
    /* nothing there to remove, which is the ordinary case */
  })
  try {
    for (const o of await s.list(keys.libPrefix(id, name))) if (!wrote.has(o.key)) await s.del(o.key)
  } catch (e) {
    /* the bytes that matter are all up; a sweep that could not run leaves the store holding more
     * than it should rather than less, and import-work.mjs reconciles a whole map */
    console.error(`[library] could not clear what ${name} used to be:`, e.message)
  }

  /* a set of headings is STATIC with dirs, never animated: see the note in libraryOf about what
   * calling it animated did to every placement made after a reload */
  await upsertItem(id, name, n > 1 ? 'animated' : 'static', {
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

/* a shared item duplicates the bytes rather than nulling map_id, which six readers derive a map id from including the write gate, and it copies every frame and every state face because a partial copy is a character facing south forever */
export async function copyLibraryItem(fromSlug, name, toSlug, as) {
  if (!platformOn()) return null
  const fromId = await mapIdFor(fromSlug)
  const toId = await mapIdFor(toSlug)
  if (!fromId || !toId) throw new Error('one of those maps does not exist')
  const src = await one('select * from library_items where map_id = $1 and name = $2', [fromId, name])
  if (!src) throw new Error(`"${name}" is not in ${fromSlug}'s library`)
  const to = await freeName(toSlug, as || name)

  const s = store()
  // the still, the flat frames, the per-heading folders: everything under the
  // item's own prefix keeps the relative tail it had, because
  // blobKeyForWorkPath translates a /work/ url to a key by position
  const held = [...(await s.list(keys.libPrefix(fromId, name))), ...(await s.list(keys.libStill(fromId, name)))]
  const lib = `maps/${fromId}/library/`
  for (const o of held) {
    // sliced off a prefix that is known exactly rather than matched, because the
    // item's own name is the only part that changes and everything after it is
    // the path the loader already knows how to read
    const tail = String(o.key).slice(lib.length + name.length)
    await s.copy(o.key, `maps/${toId}/library/${to}${tail}`)
  }

  // dirs holds blob keys, so it moves with them or the row points at the map it
  // was copied out of
  const dirs = src.dirs
    ? JSON.parse(JSON.stringify(src.dirs).split(`maps/${fromId}/library/${name}/`).join(`maps/${toId}/library/${to}/`))
    : null
  await upsertItem(toId, to, src.kind, {
    w: src.w,
    h: src.h,
    fps: src.fps,
    frame_count: src.frame_count,
    dirs,
    effect: src.effect,
    is_effect: src.is_effect,
    origin: src.origin,
    prefix: keys.libPrefix(toId, to),
  })

  const row = await one('select id from library_items where map_id = $1 and name = $2', [toId, to])
  let faces = 0
  for (const f of await many('select * from library_states where item_id = $1', [src.id])) {
    for (const o of await s.list(keys.statePrefix(fromId, name, f.face))) {
      const tail = String(o.key).slice(keys.statePrefix(fromId, name, f.face).length)
      await s.copy(o.key, keys.statePrefix(toId, to, f.face) + tail)
    }
    // a face's dirs and src are /work/ urls rather than keys, so both the slug
    // and the item name in them have to move
    const swap = (v) =>
      v == null
        ? null
        : JSON.parse(JSON.stringify(v).split(`/work/${fromSlug}/states/${name}/`).join(`/work/${toSlug}/states/${to}/`))
    await q(
      `insert into library_states (item_id, face, dirs, frame_count, blob_prefix, fps, w, h, src)
       values ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)
       on conflict (item_id, face) do update set
         dirs=excluded.dirs, frame_count=excluded.frame_count, fps=excluded.fps,
         w=excluded.w, h=excluded.h, src=excluded.src`,
      [
        row.id,
        f.face,
        f.dirs ? JSON.stringify(swap(f.dirs)) : null,
        f.frame_count,
        keys.statePrefix(toId, to, f.face),
        f.fps,
        f.w,
        f.h,
        f.src ? swap(f.src) : null,
      ],
    )
    faces++
  }
  return { name: to, from: fromSlug, files: held.length, frames: src.frame_count, faces }
}

/* a face lives one folder deeper than the library because a state comes back as whole headings, and its size and fps are columns rather than a png opened per face on every listing */
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
    /* A LOOSE <face>.png IS A FACE TOO, and skipping it is why no face has ever been stored. The
     * object branch of asset-state writes exactly that shape, so walking only directories made every
     * second face drawn for an object invisible here: no blob, no row, while the toast said it was
     * ready and a life round naming it silently drew picture 0. Read off the live database:
     * library_states holds no rows at all, and never has. Filed as face/0.png, the same shape a
     * headingless face already takes, so one reader serves both. */
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isFile() && /\.png$/i.test(ent.name)) {
        const face = ent.name.replace(/\.png$/i, '')
        const f = path.join(dir, ent.name)
        const { w, h } = size(f)
        await s.put(`maps/${id}/states/${item}/${face}/0.png`, fs.readFileSync(f), 'image/png')
        await q(
          `insert into library_states (item_id, face, dirs, frame_count, blob_prefix, fps, w, h, src)
           values ($1,$2,null,1,$3,6,$4,$5,$6)
           on conflict (item_id, face) do update set
             dirs=null, frame_count=1, fps=6, w=excluded.w, h=excluded.h, src=excluded.src`,
          [
            row.id,
            face,
            keys.statePrefix(id, item, face),
            w,
            h,
            `/work/${slug}/states/${encodeURIComponent(item)}/${encodeURIComponent(face)}/0.png`,
          ],
        )
        seen.push(face)
        continue
      }
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

/* what .prev holds, kept off the laptop and capped at 8 so an edit cannot roll its own original away; the snapshot copies inside the bucket, so it costs no transfer */
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
/* ONE ITEM'S BYTES BACK ONTO DISK, so the row can be derived from them rather than hand-patched.
 * hydrateMap pulls a whole map, which is hundreds of files for the sake of one. */
export async function hydrateItem(slug, name, workDir) {
  if (!platformOn()) return 0
  const fs = await import('node:fs')
  const path = await import('node:path')
  const id = await mapIdFor(slug)
  if (!id) return 0
  const s = store()
  const lib = path.join(workDir, 'library')
  fs.mkdirSync(lib, { recursive: true })
  /* both shapes of the same name, and the loose png LAST, so a name that is a folder now does not
   * end up with a stale flat png beside it */
  fs.rmSync(path.join(lib, name), { recursive: true, force: true })
  fs.rmSync(path.join(lib, name + '.png'), { force: true })
  let n = 0
  for (const o of await s.list(keys.libPrefix(id, name))) {
    const rel = o.key.slice(keys.libPrefix(id, name).length)
    if (!rel) continue
    const to = path.join(lib, name, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, await s.get(o.key))
    n++
  }
  try {
    const b = await s.get(keys.libStill(id, name))
    if (b && b.length) {
      fs.writeFileSync(path.join(lib, name + '.png'), b)
      n++
    }
  } catch {
    /* a folder-shaped item owns no loose png, which is the ordinary case */
  }
  return n
}

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
  /* AND THE FACES IT WORE. The row's library_states cascade away with it, but the blobs did not, so
   * asking for a troll again handed back the free name, hydrateMap pulled the dead troll's face
   * pixels back down, and the next push rowed them onto the new one. An author got a face they never
   * paid for, of a different object. */
  await s.delPrefix(`maps/${id}/states/${name}/`).catch(() => {
    /* nothing there, which is every item that never wore a second face */
  })
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

// ---- covers ----------------------------------------------------------------

/* THE TRANSITION SCREEN A MAP IS ENTERED THROUGH. One per map with no name, which is the map's own,
 * plus any number of extras a code name addresses. Kept beside the masks in the store, so a cover
 * survives the laptop that drew it the way a painting does. */
export async function saveCover(slug, buf, name = '') {
  const id = await mapIdFor(slug, { create: true })
  if (!id) {
    const e = new Error('sign in to keep a cover')
    e.name = 'NoOwner'
    throw e
  }
  const key = name ? keys.coverNamed(id, name) : keys.cover(id)
  await store().put(key, buf, 'image/png')
  return key
}

export async function readCover(slug, name = '') {
  if (!platformOn()) return null
  const id = await mapIdFor(slug)
  if (!id) return null
  try {
    return await store().get(name ? keys.coverNamed(id, name) : keys.cover(id))
  } catch {
    /* no cover drawn for this map yet, which is every map until somebody draws one */
    return null
  }
}

/* what a map has: whether it owns a default, and the code names of its extras. Read off the store
 * rather than a column, because the bytes are the record and a column could disagree with them. */
export async function coversOf(slug) {
  if (!platformOn()) return { cover: false, covers: [] }
  const id = await mapIdFor(slug)
  if (!id) return { cover: false, covers: [] }
  const s = store()
  let has = false
  try {
    const b = await s.get(keys.cover(id))
    has = !!(b && b.length)
  } catch {
    /* none, which is the ordinary case */
  }
  let covers = []
  try {
    covers = (await s.list(keys.coversPrefix(id)))
      .map((o) => o.key.slice(keys.coversPrefix(id).length))
      .filter((n) => n.endsWith('.png'))
      .map((n) => n.slice(0, -4))
      .sort()
  } catch {
    /* a store that cannot be listed reports no extras rather than throwing the panel away */
  }
  return { cover: has, covers }
}

export async function dropCover(slug, name = '') {
  if (!platformOn()) return
  const id = await mapIdFor(slug)
  if (!id) return
  await store()
    .del(name ? keys.coverNamed(id, name) : keys.cover(id))
    .catch(() => {
      /* removing one that is not there is the same end state */
    })
}
