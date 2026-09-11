// this talks the S3 api and nothing else so the provider is an endpoint in .env, and with no S3_* configured it falls back to work/ so the tool still runs for somebody signed up for nothing
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../db/env.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
/* the same directory the api writes its scratch to, so MAPVIS_WORK moves both
 * or neither: a host with a read-only filesystem needs every writer pointed at
 * the one writable place. */
const workDir = () => env().MAPVIS_WORK || path.join(ROOT, 'work')

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

/* a per-process ceiling far above anything real, because r2 invoices instead of stopping and twenty thousand operations means something is looping */
let ceiling = null
const OP_CEILING = () => (ceiling ??= Number(env().S3_MAX_OPS || 20000))
const ops = { a: 0, b: 0, tripped: false }

export const bucketOps = () => ({ ...ops, ceiling: OP_CEILING() })
export const resetBucketOps = () => { ops.a = 0; ops.b = 0; ops.tripped = false }

/* deliberately a second counter, because zeroing the ceiling's one per request would stop it detecting a loop spread over many requests */
const since = { a: 0, b: 0 }
export function takeBucketOps() {
  const d = { a: since.a, b: since.b }
  since.a = 0
  since.b = 0
  return d
}

function meter(b) {
  const spend = (cls) => {
    ops[cls]++
    since[cls]++
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

/* safe to cache a changing working copy because every write goes through put, del, delPrefix or copy in this object and evicts the key; bounded lru, since this runs in a serverless function */
const MEM_MAX = 400
const MEM_BYTES = 48 * 1024 * 1024
const MEM_ONE = 2 * 1024 * 1024

/* a hook and not an import, because reaching into the database from here would make the storage adapter depend on there being one */
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
    /* a write from another process is invisible here and this file cannot detect it without a bucket read, so a caller holding a sha calls forget when the bytes do not match */
    forget: (key) => drop(key),
    forgetPrefix: (prefix) => dropPrefix(prefix),
    async get(key) {
      const hit = mem.get(key)
      if (hit) { mem.delete(key); mem.set(key, hit); return hit }
      const buf = await b.get(key)
      if (buf && buf.length <= MEM_ONE) {
        /* a re-put refunds what it replaces or the count drifts up permanently and the cache goes quietly useless, and `mem.size &&` stops an empty map spinning the eviction loop forever */
        const prev = mem.get(key)
        if (prev) held -= prev.length
        mem.set(key, buf)
        held += buf.length
        while (mem.size && (mem.size > MEM_MAX || held > MEM_BYTES)) drop(mem.keys().next().value)
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
          /* one attempt, because a capped bucket will not change its mind in 300ms and the sdk's backoff made 94 refusals outlive the browser */
          maxAttempts: 1,
          /* the sdk ships NO timeouts unless handed some and treats a falsy one as never give up, so one stalled socket used to hang a whole publish forever */
          requestHandler: { connectionTimeout: 10_000, requestTimeout: 60_000 },
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
  const at = (key) => path.join(workDir(), '.blobs', clean(key))
  return {
    kind: 'local',
    bucket: path.join(workDir(), '.blobs'),

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
      const root = path.join(workDir(), '.blobs')
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
  // the placements as they stood just before a save took authored work off them
  docRescue: (mapId, at) => `maps/${mapId}/rescue/${at}-assets.json`,
  publish: (slug, v) => `publish/${slug}/v${v}/`,
  map: (mapId) => `maps/${mapId}/`,
}
