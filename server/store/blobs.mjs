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
  return (cached = E.S3_ACCESS_KEY_ID && E.S3_ENDPOINT ? s3Store(E) : localStore())
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
