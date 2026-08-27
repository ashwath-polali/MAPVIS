// Where the bytes live. Every png a map owns: the painting, the three mask
// planes, the library, the states, the published bundles.
//
// This talks the S3 API and nothing else, which is the whole point. Backblaze
// B2, Cloudflare R2, AWS S3 and MinIO all speak it, so the provider is an
// endpoint in .env rather than a rewrite. We are on B2 because its 10 GB free
// tier is permanent and needs no credit card; if that ever stops being true,
// changing providers is four lines of config and a copy.
//
// With no S3_* configured it falls back to the work/ folder, so the tool still
// runs for someone who has signed up for nothing. That fallback is not a dev
// convenience, it is the degraded-not-broken rule applied to storage.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../db/env.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK = path.join(ROOT, 'work')

const TYPES = { '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' }
const typeOf = (key) => TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream'

let cached = null

export function store() {
  if (cached) return cached
  const E = env()
  // meter UNDER the cache on purpose: a memo hit never reaches the bucket, so
  // counting it would trip the ceiling on reads that cost nothing
  return (cached = memo(meter(E.S3_ACCESS_KEY_ID && E.S3_ENDPOINT ? s3Store(E) : localStore())))
}

/* A BUG MUST NOT BE ABLE TO RUN UP A BILL.
 *
 * B2 stops when its daily cap is gone, which is a broken site and a free
 * lesson. R2 does not stop, it invoices, and there is no spend cap to set in
 * the dashboard. That difference is the whole risk of moving, and it is not
 * about ordinary use: at the measured 249 reads to open a map, R2's ten
 * million free reads a month are forty thousand map opens. Nobody reaches that
 * by working. A loop reaches it in a minute.
 *
 * So the ceiling is per process and deliberately far above anything real. A
 * serverless instance serving one map open spends a few hundred; publishing
 * the biggest map spends a few thousand. Twenty thousand means something is
 * looping, and the right answer to that is to stop rather than to keep paying.
 * Counted by class because R2 prices them differently and a runaway ListObjects
 * is twelve times worse than a runaway GetObject. */
let ceiling = null
const OP_CEILING = () => (ceiling ??= Number(env().S3_MAX_OPS || 20000))
const ops = { a: 0, b: 0, tripped: false }

export const bucketOps = () => ({ ...ops, ceiling: OP_CEILING() })
export const resetBucketOps = () => { ops.a = 0; ops.b = 0; ops.tripped = false }

function meter(b) {
  const spend = (cls) => {
    ops[cls]++
    if (ops.a + ops.b <= OP_CEILING()) return
    if (!ops.tripped) {
      ops.tripped = true
      console.error(`[blobs] STOPPED: ${ops.a + ops.b} bucket operations in one process (ceiling ${OP_CEILING()}). Something is looping.`)
    }
    throw new Error(`bucket operation ceiling reached (${OP_CEILING()} in one process); refusing to spend more`)
  }
  return {
    ...b,
    // class B on r2: reads
    async get(key) { spend('b'); return b.get(key) },
    async exists(key) { spend('b'); return b.exists(key) },
    // class A on r2: writes and listings. list is the expensive one per call.
    async put(key, body, ct) { spend('a'); return b.put(key, body, ct) },
    async list(prefix) { spend('a'); return b.list(prefix) },
    async copy(from, to) { spend('a'); return b.copy(from, to) },
    // delete is free on r2, and is not metered
    async del(key) { return b.del(key) },
    async delPrefix(prefix) { spend('a'); return b.delPrefix(prefix) },
  }
}

/* THE SAME BYTES ARE NEVER FETCHED TWICE.
 *
 * A published version is immutable and is cached forever by the browser, but
 * the editor's own working copy is not, and it was being served with no-store
 * and no memory behind it. So every open of a map went to the bucket for every
 * png in its library, every dashboard thumbnail went again, and a free tier's
 * 2,500 daily transactions were gone in an afternoon of ordinary use.
 *
 * The working copy really does change under the author, so it cannot simply be
 * cached and forgotten. What makes this safe is that every change to a key goes
 * through put, del, delPrefix or copy in this same object, so a write is the
 * one moment the cached copy can become wrong, and a write evicts it. A reader
 * can therefore never be handed bytes that some earlier writer replaced.
 *
 * Bounded because this runs in a serverless function: least recently used falls
 * off first, and anything genuinely large is passed straight through rather
 * than held. */
const MEM_MAX = 400
const MEM_BYTES = 48 * 1024 * 1024
const MEM_ONE = 2 * 1024 * 1024

/* WHO WANTS TO KNOW WHEN BYTES CHANGE.
 *
 * The sha of every object is kept in Postgres so a revalidation can be answered
 * without a download, and that record is only trustworthy if it is updated at
 * the moment of the write. This is how it hears about one.
 *
 * A hook rather than an import because this file talks the S3 API and nothing
 * else, deliberately. Reaching into the database from here would make the
 * storage adapter depend on there BEING a database, and the local backend
 * exists precisely for when there is not. platform.mjs registers a handler when
 * the platform is on, and when it is off nothing is registered and nothing
 * changes. */
const writeHooks = []
export const onBlobWrite = (fn) => writeHooks.push(fn)
const announce = async (kind, key, body) => {
  for (const f of writeHooks) {
    try {
      await f(kind, key, body)
    } catch {
      /* a bookkeeping failure must never fail the write that succeeded */
    }
  }
}

function memo(b) {
  const mem = new Map()
  let held = 0

  const drop = (k) => {
    const v = mem.get(k)
    if (v) { mem.delete(k); held -= v.length }
  }
  // a prefix write invalidates everything under it, which is what delPrefix and
  // a copy into a folder both do
  const dropPrefix = (p) => { for (const k of [...mem.keys()]) if (k.startsWith(p)) drop(k) }

  return {
    ...b,
    async get(key) {
      const hit = mem.get(key)
      if (hit) { mem.delete(key); mem.set(key, hit); return hit }
      const buf = await b.get(key)
      if (buf && buf.length <= MEM_ONE) {
        mem.set(key, buf)
        held += buf.length
        while (mem.size > MEM_MAX || held > MEM_BYTES) drop(mem.keys().next().value)
      }
      return buf
    },
    async put(key, body, contentType) {
      drop(key)
      const r = await b.put(key, body, contentType)
      // after the write lands, so a failed put never records a sha for bytes
      // that are not there
      await announce('put', key, body)
      return r
    },
    async del(key) {
      drop(key)
      const r = await b.del(key)
      await announce('del', key)
      return r
    },
    async delPrefix(prefix) {
      dropPrefix(prefix)
      const r = await b.delPrefix(prefix)
      await announce('delPrefix', prefix)
      return r
    },
    async copy(from, to) {
      drop(to)
      dropPrefix(to)
      const r = await b.copy(from, to)
      // the bytes are not in hand here, so the tag is forgotten rather than
      // rewritten and the next read recomputes it
      await announce('del', to)
      return r
    },
  }
}

// A key is a posix path under the bucket. Never absolute, never containing a
// traversal segment, because on the local backend it becomes a real filesystem
// path and on S3 it becomes a name that would be permanently awkward.
function clean(key) {
  const k = String(key || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!k || k.split('/').some((s) => s === '..' || s === '.')) throw new Error(`bad key: ${key}`)
  return k
}

// ---- s3, and anything that speaks it ---------------------------------------

function s3Store(E) {
  const bucket = E.S3_BUCKET
  // loaded lazily so the local backend costs nothing to import
  let client = null
  const lib = async () => {
    if (!client) {
      const m = await import('@aws-sdk/client-s3')
      client = {
        m,
        c: new m.S3Client({
          region: E.S3_REGION || 'auto',
          endpoint: E.S3_ENDPOINT,
          credentials: { accessKeyId: E.S3_ACCESS_KEY_ID, secretAccessKey: E.S3_SECRET_ACCESS_KEY },
          // b2 and r2 both want path-style rather than a bucket subdomain
          forcePathStyle: true,
          /* A REFUSAL IS AN ANSWER, SO STOP ASKING AGAIN.
           *
           * The sdk retries with backoff by default, which is right for a
           * flaky connection and wrong for a cap: the bucket is not going to
           * change its mind inside three hundred milliseconds. Exporting reads
           * a source per placement, so on a capped bucket ninety-four refusals
           * each became three refusals plus waiting, and the export outlived
           * the browser's own timeout. That is what "export failed to fetch"
           * was. One attempt makes a capped read fail in milliseconds, which
           * lets the caller fall back to disk while the request is still
           * alive. */
          maxAttempts: 1,
        }),
      }
    }
    return client
  }

  return {
    kind: 's3',
    bucket,

    async put(key, body, contentType) {
      const { m, c } = await lib()
      const k = clean(key)
      await c.send(
        new m.PutObjectCommand({
          Bucket: bucket,
          Key: k,
          Body: body,
          ContentType: contentType || typeOf(k),
          // a published bundle is version-scoped and never rewritten, so the
          // cdn in front of it should keep it forever. Everything else is the
          // author's working copy and must not be cached at all.
          CacheControl: k.startsWith('publish/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        }),
      )
      return { key: k, bytes: body.length }
    },

    async get(key) {
      const { m, c } = await lib()
      const r = await c.send(new m.GetObjectCommand({ Bucket: bucket, Key: clean(key) }))
      return Buffer.from(await r.Body.transformToByteArray())
    },

    async exists(key) {
      const { m, c } = await lib()
      try {
        await c.send(new m.HeadObjectCommand({ Bucket: bucket, Key: clean(key) }))
        return true
      } catch {
        return false
      }
    },

    // Returns [{ key, bytes }]. Pages through, because a map's library can be
    // hundreds of frames and S3 caps a page at 1000.
    async list(prefix) {
      const { m, c } = await lib()
      const out = []
      let token
      do {
        const r = await c.send(
          new m.ListObjectsV2Command({ Bucket: bucket, Prefix: clean(prefix + 'x').slice(0, -1), ContinuationToken: token }),
        )
        for (const o of r.Contents || []) out.push({ key: o.Key, bytes: o.Size })
        token = r.IsTruncated ? r.NextContinuationToken : undefined
      } while (token)
      return out
    },

    async del(key) {
      const { m, c } = await lib()
      await c.send(new m.DeleteObjectCommand({ Bucket: bucket, Key: clean(key) }))
    },

    async delPrefix(prefix) {
      const { m, c } = await lib()
      const all = await this.list(prefix)
      for (let i = 0; i < all.length; i += 1000) {
        await c.send(
          new m.DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: all.slice(i, i + 1000).map((o) => ({ Key: o.key })) },
          }),
        )
      }
      return all.length
    },

    async copy(from, to) {
      const { m, c } = await lib()
      await c.send(
        new m.CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${clean(from)}`, Key: clean(to) }),
      )
    },
  }
}

// ---- the laptop ------------------------------------------------------------

function localStore() {
  const at = (key) => path.join(WORK, '.blobs', clean(key))
  return {
    kind: 'local',
    bucket: path.join(WORK, '.blobs'),

    async put(key, body) {
      const f = at(key)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      // written beside then renamed, so a reader never sees half a file
      const tmp = f + '.tmp'
      fs.writeFileSync(tmp, body)
      fs.renameSync(tmp, f)
      return { key: clean(key), bytes: body.length }
    },

    async get(key) {
      return fs.readFileSync(at(key))
    },

    async exists(key) {
      return fs.existsSync(at(key))
    },

    async list(prefix) {
      const p = clean(prefix + 'x').slice(0, -1)
      const root = path.join(WORK, '.blobs')
      const out = []
      const walk = (dir) => {
        if (!fs.existsSync(dir)) return
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name)
          if (e.isDirectory()) walk(full)
          else {
            const key = path.relative(root, full).replace(/\\/g, '/')
            if (key.startsWith(p) && !key.endsWith('.tmp')) out.push({ key, bytes: fs.statSync(full).size })
          }
        }
      }
      walk(root)
      return out
    },

    async del(key) {
      fs.rmSync(at(key), { force: true })
    },

    async delPrefix(prefix) {
      const all = await this.list(prefix)
      for (const o of all) fs.rmSync(at(o.key), { force: true })
      return all.length
    },

    async copy(from, to) {
      const f = at(to)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.copyFileSync(at(from), f)
    },
  }
}

// ---- the key layout, in one place so nothing invents its own ----------------

export const keys = {
  planes: (mapId) => `maps/${mapId}/planes.png`,
  scene: (mapId) => `maps/${mapId}/scene.png`,
  mask: (mapId, role) => `maps/${mapId}/${role}.png`,
  libStill: (mapId, name) => `maps/${mapId}/library/${name}.png`,
  libFrame: (mapId, name, i) => `maps/${mapId}/library/${name}/${i}.png`,
  libPrefix: (mapId, name) => `maps/${mapId}/library/${name}/`,
  state: (mapId, item, face, heading, i) => `maps/${mapId}/states/${item}/${face}/${heading}/${i}.png`,
  statePrefix: (mapId, item, face) => `maps/${mapId}/states/${item}/${face}/`,
  version: (mapId, item, seq) => `maps/${mapId}/versions/${item}/${seq}/`,
  publish: (slug, v) => `publish/${slug}/v${v}/`,
  map: (mapId) => `maps/${mapId}/`,
}
