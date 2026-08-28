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
    /* A NEW MAP BELONGS TO WHOEVER MADE IT.
     *
     * This assigned every map to BOOTSTRAP_EMAIL, which is fine on one laptop
     * where that account is the only one, and wrong the moment a second person
     * signs up: their very first save created a map owned by the club, and the
     * ownership gate then locked them out of the thing they had just made. It
     * is the bug that would have made "anyone can make an account" false in
     * practice, and it got sharper once ownership started being enforced on
     * reads as well as writes.
     *
     * A script has no request around it, so it still falls back to the
     * bootstrap account; that is import-work and make-scene, run by hand on the
     * machine that owns the data. An HTTP request with no signed-in user gets
     * nothing, because the alternative is letting a stranger create rows and
     * bucket objects on somebody else's account by naming a slug. */
    const req = request()
    if (req.http && !req.user) return null
    const ownerId =
      req.user?.id ||
      (
        await ensureUser({
          email: need(`BOOTSTRAP_EMAIL`),
          password: need(`BOOTSTRAP_PASSWORD`),
          displayName: 'Algorithmic Thinking Club',
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
  /* mapIdFor refuses to invent a map for a caller with no account, and that
   * refusal has to arrive here as a sentence rather than as a null that travels
   * two more functions and surfaces as a not-null constraint violation on
   * map_blobs.map_id. The caller turns this into a 401; without it the failure
   * looked like the database being unreachable and fell through to the disk
   * fallback, which on a host writes to /tmp and silently loses the work. */
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

/* THE PAINTING HAS TO LEAVE THE MACHINE THAT LOADED IT.
 *
 * /api/save wrote work/<slug>/scene.png and stopped, so the picture a map is
 * MADE of was the one part of it that never reached the platform until an
 * export, which is hundreds of edits later. Two ways that bites and both are
 * real: a map started on the laptop opens on the deployed site saying there is
 * no painting, and a map started ON the deployed site writes its painting into
 * a Vercel tmpdir that is gone by the next request.
 *
 * Same key serveFromStore already reads, so nothing else changes: the disk copy
 * stays the fast path and the bucket is the copy that survives. Found from the
 * game side on 2026-08-28, opening a freshly made panther-maw on the host.
 */
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
    if (r.dirs) {
      // stored as blob keys; handed back as urls in the same /work/ space
      it.dirs = Object.fromEntries(
        Object.entries(r.dirs).map(([h, list]) => [h, list.map((k) => '/work/' + k.replace(`maps/${id}/`, `${slug}/`))]),
      )
    }
    /* A direction set owns no flat still, so its thumbnail is the first frame
     * of the heading a character faces by default. Without this the panel asks
     * for <name>.png, which for a sprite is a key that was never written, and
     * the tile renders empty. */
    if (r.frame_count === 0) {
      const facing = it.dirs && (it.dirs.south || it.dirs[Object.keys(it.dirs)[0]])
      it.src = facing?.length ? facing[0] : `${base}/${r.name}.png`
    }
    // the same shape statesOf() returned off disk, because App.tsx picks a face
    // by name and draws it at the size it reports
    const st = Array.isArray(r.states) ? r.states : []
    if (st.length) it.states = st
    if (r.origin && (r.origin.objectId || r.origin.characterId)) it.canState = true
    return it
  })
}

/* Who owns a map, cached, because this is asked on every png.
 *
 * Opening a map is a couple of hundred image requests and each one has to be
 * checked, so an uncached select here would be a couple of hundred round trips
 * added to the thing this whole session has been trying to make cheaper. An
 * owner effectively never changes, and the miss is re-asked every half minute,
 * so handing back a stale answer is bounded and the failure mode is that a map
 * transferred seconds ago stays readable by its old owner for thirty seconds. */
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

/* R2 HAS NO SPEND CAP, SO THE CAP LIVES HERE.
 *
 * Cloudflare bills overage and offers no dashboard setting to stop at the free
 * tier, so "we will simply not go over" is a hope unless something enforces it.
 * The free allowance is 10 million reads and 1 million writes a month. These
 * default to eighty percent of that, which leaves room to notice and react
 * rather than room to be surprised.
 *
 * Deliberately low-frequency: the totals are read at most once a minute and
 * written at most once per request, so the guard costs far less than the thing
 * it guards. */
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

/* THE TAG IS KNOWN BEFORE THE BYTES ARE, WHICH IS THE WHOLE POINT.
 *
 * blob_shas records the sha of every object at the moment it is written, so
 * "has this changed" is a primary-key lookup rather than a download. Without
 * it the ETag below was computed from bytes that had just been fetched, so a
 * 304 cost a full bucket read and reopening a map on the host spent 156 of
 * them to learn that nothing had changed. */
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

  /* ANSWERED WITHOUT TOUCHING THE BUCKET AT ALL.
   *
   * This is the branch that makes reopening a map free. If the caller already
   * holds the current bytes and Postgres knows their sha, there is nothing to
   * fetch and nothing to send. */
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

  /* BACKFILL, so this object is only ever paid for once.
   *
   * The write hook records a sha for anything written from now on, but every
   * object that already existed when this table was added has no row, and a
   * bucket move writes bytes through a path that predates it too. Recording
   * the tag on the first read means the next revalidation is answered out of
   * Postgres, without a migration that would have to walk the whole bucket. */
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

/* PUT THE MAP'S BYTES WHERE THE EXPORTER CAN SEE THEM.
 *
 * Export resolves every placement's source through resolveAssetFile, which is
 * a filesystem call: it joins a path under work/ and returns null when the file
 * is not there. On a laptop that is always fine, because work/ IS the library.
 * On the host work/ is an empty tmp directory and the library lives in the
 * bucket, so every source resolved to null, every placement was skipped by the
 * `if (!look0) continue` a few lines down from the call, no frames reached the
 * atlas, and the bundle published as a success carrying an island with nothing
 * on it. Nobody caught it because the gate never exercises /api/export.
 *
 * Rather than teach four call sites and the naming logic to read bytes from two
 * places, the bytes are brought to the place that already works. Anything
 * already on disk is left alone, so this costs nothing at all on the machine
 * that made the map, and on the host it is one listing plus the files that are
 * genuinely missing.
 *
 * Returns what it had to fetch, so the caller can say so out loud rather than
 * quietly spending a few hundred reads. */
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

  /* FETCHED IN PARALLEL, BECAUSE THE FUNCTION HAS FIVE MINUTES AND THE HUB HAS
   * FOURTEEN HUNDRED FILES.
   *
   * Measured one at a time: 1,383 objects took 260 seconds, against a
   * maxDuration of 300. That is not a margin, it is a coin toss, and the export
   * would have started failing the moment the map grew. Twelve at a time is the
   * same number of requests and roughly a twentieth of the wall clock, and it
   * stays well under the ceiling the meter enforces. Kept modest rather than
   * maximal because this shares a connection with everything else the request
   * is doing. */
  const LANES = 12
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(LANES, want.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= want.length) return
        const [key, f] = want[i]
        /* RETRIED, BECAUSE THE CLIENT IS DELIBERATELY MAXATTEMPTS:1.
         *
         * That setting is right for its own reason: against a capped bucket a
         * refusal is an answer and retrying three times just makes the export
         * outlive the browser. But it also means a transient reset loses the
         * object outright, and twelve lanes at once produce those. Measured:
         * ten of 1,383 files vanished this way, silently, which would have been
         * ten missing frames in a published bundle reported as a success.
         *
         * So the retry lives here rather than in the client, where it applies to
         * a bulk copy that can afford it and not to the single reads a request
         * is waiting on. */
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

  /* A DIRECTION SET ARRIVES AS FLAT FILES BESIDE dirs.json, NOT AS SUBFOLDERS.
   *
   * The character writer lays down <name>/<heading>-<i>.png. Everything above
   * looks for <name>/<i>.png or <name>/<heading>/<i>.png, so a sprite matched
   * neither: it fell through as kind 'static' with dirs null, and libraryOf
   * then pointed src at <name>.png, a key nobody ever wrote. That is why all
   * nineteen people on the hub, plus the troll and the gull, were blank tiles
   * in the library panel. Measured on disk: work/hub/library/troll/ holds
   * dirs.json and east-0.png through west-7.png and no 0.png at all.
   *
   * dirs.json is the authority rather than the filename pattern: it already
   * lists each heading's files in order, so reading it means this keeps working
   * if the writer ever renames them. The pattern scan is only the fallback for
   * a folder whose dirs.json went missing, and it tries the two-word headings
   * first so north-east never reads as north. Either way the key keeps the
   * relative path the file had, because blobKeyForWorkPath translates /work/
   * urls to bucket keys by position. */
  const HEADINGS = ['north-east', 'north-west', 'south-east', 'south-west', 'north', 'south', 'east', 'west']
  if (!Object.keys(dirs).length) {
    const take = async (heading, file, into) => {
      const f = path.join(folder, file)
      if (!fs.existsSync(f)) return
      if (!w) ({ w, h } = size(f))
      const key = `maps/${id}/library/${name}/${file}`
      await s.put(key, fs.readFileSync(f), 'image/png')
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
