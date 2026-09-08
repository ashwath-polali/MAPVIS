// the smallest honest bundle for a scene nobody walks; anything richer belongs in the editor
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { env, need } from './env.mjs'
import { q, one, closeDb } from './pool.mjs'
import { store, keys } from '../store/blobs.mjs'
import { publishBundle } from '../store/publish.mjs'
import { ensureUser, createMap, getMapBySlug } from '../store/maps.mjs'

const [slug, file] = process.argv.slice(2)
if (!slug || !file) throw new Error('usage: node server/db/make-scene.mjs <slug> <painting.png>')
if (!slug.startsWith('site-')) throw new Error('a site scene must be called site-something, or the landing page will not show it')
if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`)

const png = fs.readFileSync(file)
if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('that is not a png')
const w = png.readUInt32BE(16)
const h = png.readUInt32BE(20)
console.log(`${path.basename(file)}  ${w}x${h}  ${(png.length / 1024).toFixed(1)}kb`)

const E = env()
const owner = await ensureUser({
  email: need(`BOOTSTRAP_EMAIL`),
  password: need(`BOOTSTRAP_PASSWORD`),
  displayName: 'Algorithmic Thinking Club',
  claude: 'relay',
  pixellab: 'relay',
})

let map = await getMapBySlug(slug)
if (!map) {
  map = await createMap({ slug, ownerId: owner.id, title: slug, w, h, spawn: [w >> 1, h >> 1] })
  console.log(`created ${slug}`)
} else {
  await q('update maps set w = $2, h = $3 where id = $1', [map.id, w, h])
  console.log(`updating ${slug}`)
}

// the painting itself, so the editor can reopen it later
await store().put(keys.scene(map.id), png, 'image/png')
await q(
  `insert into map_blobs (map_id, role, key, bytes, sha256, updated_at) values ($1,'scene',$2,$3,$4, now())
   on conflict (map_id, role) do update set key=excluded.key, bytes=excluded.bytes, sha256=excluded.sha256, updated_at=now()`,
  [map.id, keys.scene(map.id), png.length, crypto.createHash('sha256').update(png).digest('hex')],
)

// a levels plane that says the whole thing is ground. Nothing walks here, but
// the bundle contract expects the file and a reader should never meet a hole.
const flat = flatLevels(w, h, 40)

const r = await publishBundle(slug, {
  mapJson: {
    id: slug,
    w,
    h,
    encoding: { blocked: 0, L0: 40, ramp01: 50, L1: 60, ramp12: 70, L2: 80, ramp23: 90, L3: 100, stepTolerance: 10 },
    spawn: [w >> 1, h >> 1],
    character: { heightPx: 18, hip: 2, hipDY: 1 },
    speed: 34,
    yScale: 0.72,
    stairs: [],
    occluders: [],
  },
  assetsJson: { assets: [] },
  images: { 'scene.png': png, 'levels.png': flat },
  files: new Map(),
})

console.log(`published ${slug} v${r.version} · ${r.files.length} files · ${(r.bytes / 1024).toFixed(1)}kb`)
console.log('the landing page will pick it up on the next load')
await closeDb()

/* A one-colour png, written by hand rather than pulled from a library. It is a
 * single scanline repeated, so zlib crushes it to nothing whatever the size. */
function flatLevels(width, height, value) {
  const row = Buffer.alloc(1 + width * 4)
  for (let x = 0; x < width; x++) {
    row[1 + x * 4] = value
    row[1 + x * 4 + 3] = 255
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const idat = zlib.deflateSync(raw, { level: 9 })
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c
}
