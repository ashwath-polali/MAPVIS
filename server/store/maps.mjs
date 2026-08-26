// The map repository: everything that reads or writes a map.
//
// The shape on the wire is still mask.ts serialize() v3, so the editor does not
// know any of this happened. What changes is where it lands: the three mask
// planes become a png in object storage, the placements and geometry become a
// row, and each half is only written when its own content actually changed.
//
// That last part is not an optimisation, it is what makes a free database
// survive. editor.ts autosaves every 4 seconds while the map is dirty. Writing
// the whole document each time is 1.6 GB an hour against a 0.5 GB tier. Almost
// every one of those saves changes a placement OR the mask, never both, so
// hashing each half and skipping the unchanged one removes most of the traffic
// without the editor having to say what it touched.
import crypto from 'node:crypto'
import { q, one, many, tx } from '../db/pool.mjs'
import { store, keys } from './blobs.mjs'
import { encodePNG, decodePNG } from '../sheet.mjs'
import { hashPassword } from './crypto.mjs'

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

// ---- the planes ------------------------------------------------------------

// lvl, occ and cut are one byte per pixel each. As r, g and b of a png they
// compress the way image data does rather than the way base64 does: measured on
// the hub, 1,720 KB of base64 becomes 9.5 KB, lossless.
export function planesToPNG(w, h, lvl, occ, cut) {
  const n = w * h
  const rgba = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = lvl[i]
    rgba[i * 4 + 1] = occ[i]
    rgba[i * 4 + 2] = cut[i]
    rgba[i * 4 + 3] = 255
  }
  return encodePNG(w, h, rgba)
}

export function planesFromPNG(buf) {
  const { w, h, data } = decodePNG(buf)
  const n = w * h
  const lvl = Buffer.alloc(n)
  const occ = Buffer.alloc(n)
  const cut = Buffer.alloc(n)
  for (let i = 0; i < n; i++) {
    lvl[i] = data[i * 4]
    occ[i] = data[i * 4 + 1]
    cut[i] = data[i * 4 + 2]
  }
  return { w, h, lvl, occ, cut }
}

// what serialize() packs into `m`: three planes back to back, base64'd
const unpackM = (m, n) => {
  const b = Buffer.from(String(m || ''), 'base64')
  if (b.length !== n * 3 && b.length !== n * 2) throw new Error(`expected ${n * 3} plane bytes, got ${b.length}`)
  return {
    lvl: b.subarray(0, n),
    occ: b.subarray(n, n * 2),
    cut: b.length === n * 3 ? b.subarray(n * 2, n * 3) : Buffer.alloc(n),
  }
}

const packM = (lvl, occ, cut) => Buffer.concat([lvl, occ, cut]).toString('base64')

// ---- users -----------------------------------------------------------------

export async function ensureUser({ email, password, displayName = '', claude = 'none', pixellab = 'none' }) {
  const found = await one('select * from users where email = $1', [email])
  if (found) return found
  return one(
    `insert into users (email, password_hash, display_name, claude_provider, pixellab_provider)
     values ($1, $2, $3, $4, $5) returning *`,
    [email, await hashPassword(password), displayName, claude, pixellab],
  )
}

// ---- maps ------------------------------------------------------------------

export const getMapBySlug = (slug) => one('select * from maps where slug = $1', [slug])
export const getMapById = (id) => one('select * from maps where id = $1', [id])

export const listMaps = (ownerId) =>
  many(
    `select m.id, m.slug, m.title, m.w, m.h, m.updated_at,
            (select count(*)::int from anchors a where a.map_id = m.id)        as anchors,
            (select count(*)::int from library_items l where l.map_id = m.id)  as library,
            jsonb_array_length(m.assets)                                       as placements,
            (select max(version) from publishes p where p.map_id = m.id)       as published
     from maps m where m.owner_id = $1 order by m.updated_at desc`,
    [ownerId],
  )

export async function createMap({ slug, ownerId, title = '', w, h, base, spawn = [0, 0] }) {
  return one(
    `insert into maps (slug, owner_id, title, w, h, base_w, base_h, base_ox, base_oy, spawn_x, spawn_y)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [slug, ownerId, title, w, h, base?.w ?? w, base?.h ?? h, base?.ox ?? 0, base?.oy ?? 0, spawn[0] | 0, spawn[1] | 0],
  )
}

// ---- the document ----------------------------------------------------------

// Takes exactly what mask.ts serialize() produced. Returns which halves were
// actually written, so the caller (and the doctor, and anyone reading a log)
// can see the skipping working rather than trusting that it does.
export async function putDoc(mapId, docString) {
  const d = JSON.parse(docString)
  const w = d.w | 0
  const h = d.h | 0
  if (!(w > 0 && h > 0)) throw new Error('document has no size')

  const { lvl, occ, cut } = unpackM(d.m, w * h)
  const png = planesToPNG(w, h, lvl, occ, cut)
  const planesSha = sha(png)

  const assets = Array.isArray(d.assets) ? d.assets : []
  const assetsJson = JSON.stringify(assets)
  const assetsSha = sha(assetsJson)

  const wrote = []
  const prev = await one('select sha256 from map_blobs where map_id = $1 and role = $2', [mapId, 'planes'])

  if (prev?.sha256 !== planesSha) {
    const key = keys.planes(mapId)
    await store().put(key, png, 'image/png')
    await q(
      `insert into map_blobs (map_id, role, key, bytes, sha256, updated_at)
       values ($1,'planes',$2,$3,$4, now())
       on conflict (map_id, role) do update
         set key = excluded.key, bytes = excluded.bytes, sha256 = excluded.sha256, updated_at = now()`,
      [mapId, key, png.length, planesSha],
    )
    wrote.push(`planes ${(png.length / 1024).toFixed(1)}kb`)
  }

  // Everything the row holds, hashed as one thing. Compared against the stored
  // hash rather than against md5(assets::text) in the query, because jsonb
  // renormalises key order on the way in and would never match what we hold.
  const rowSha = sha(
    JSON.stringify([w, h, d.base?.w ?? w, d.base?.h ?? h, d.base?.ox ?? 0, d.base?.oy ?? 0, d.spawn, d.assetNext]) +
      assetsSha,
  )
  const cur = await one('select doc_sha from maps where id = $1', [mapId])

  if (cur?.doc_sha !== rowSha) {
    await q(
      `update maps set
         w = $2, h = $3,
         base_w = $4, base_h = $5, base_ox = $6, base_oy = $7,
         spawn_x = $8, spawn_y = $9,
         assets = $10::jsonb, asset_next = $11,
         doc_sha = $12, updated_at = now()
       where id = $1`,
      [
        mapId,
        w,
        h,
        d.base?.w ?? w,
        d.base?.h ?? h,
        d.base?.ox ?? 0,
        d.base?.oy ?? 0,
        d.spawn?.[0] | 0,
        d.spawn?.[1] | 0,
        assetsJson,
        d.assetNext ?? assets.length + 1,
        rowSha,
      ],
    )
    wrote.push(`doc ${(assetsJson.length / 1024).toFixed(1)}kb`)
  }

  // Events are the pre-anchor contract and still ride in the document. They are
  // mirrored into the anchors table rather than living there twice, so the
  // editor keeps working while the naming UI is built.
  if (Array.isArray(d.events)) {
    const n = await syncEventsToAnchors(mapId, d.events)
    if (n) wrote.push(`${n} anchor(s)`)
  }

  return { wrote, skipped: !wrote.length }
}

// Rebuilds the v3 string the editor expects, so nothing downstream changed.
export async function getDoc(mapId) {
  const m = await getMapById(mapId)
  if (!m) return null
  const blob = await one('select key from map_blobs where map_id = $1 and role = $2', [mapId, 'planes'])
  let mm = ''
  if (blob) {
    const { lvl, occ, cut } = planesFromPNG(await store().get(blob.key))
    mm = packM(lvl, occ, cut)
  } else {
    mm = Buffer.alloc(m.w * m.h * 3).toString('base64')
  }
  const events = await eventsFromAnchors(mapId)
  return JSON.stringify({
    v: 3,
    w: m.w,
    h: m.h,
    base: { w: m.base_w, h: m.base_h, ox: m.base_ox, oy: m.base_oy },
    spawn: [m.spawn_x, m.spawn_y],
    m: mm,
    assets: m.assets,
    assetNext: m.asset_next,
    events,
    eventNext: events.reduce((a, e) => Math.max(a, e.id), 0) + 1,
  })
}

// ---- events and anchors, the bridge between the two contracts ---------------

// An old event has a label and no name, so a name is derived from the label and
// flagged derived:true. The editor shows those as needing confirmation rather
// than pretending the author chose them, because a name a member writes python
// against must be one a human actually picked.
export async function syncEventsToAnchors(mapId, events) {
  const { anchorName } = await import('./crypto.mjs')
  return tx(async (c) => {
    const existing = (await c.query('select id, name, meta from anchors where map_id = $1', [mapId])).rows
    const byLegacy = new Map(existing.filter((a) => a.meta?.legacyEventId != null).map((a) => [a.meta.legacyEventId, a]))
    const taken = new Set(existing.map((a) => a.name))
    let n = 0

    for (const e of events) {
      if (!e || !Number.isFinite(Number(e.x))) continue
      const hit = byLegacy.get(Number(e.id))
      if (hit) {
        await c.query(
          `update anchors set x=$2, y=$3, r=$4, to_slug=$5, label=$6 where id=$1
           and (x,y,r,coalesce(to_slug,''),label) is distinct from ($2,$3,$4,coalesce($5,''),$6)`,
          [hit.id, Math.round(e.x), Math.round(e.y), Math.round(e.r) || 14, e.to || null, e.label || ''],
        )
        continue
      }
      let name = anchorName(e.label || `${e.type || 'door'}_${e.id}`)
      for (let i = 2; taken.has(name); i++) name = `${anchorName(e.label || 'door')}_${i}`.slice(0, 48)
      taken.add(name)
      await c.query(
        `insert into anchors (map_id, name, kind, x, y, r, to_slug, label, meta)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          mapId,
          name,
          e.type === 'door' ? 'door' : 'point',
          Math.round(e.x),
          Math.round(e.y),
          Math.round(e.r) || 14,
          e.to || null,
          e.label || '',
          JSON.stringify({ legacyEventId: Number(e.id), derived: true }),
        ],
      )
      n++
    }
    return n
  })
}

// Doors go back out in the shape the game already reads, so no bundle that
// works today stops working.
export async function eventsFromAnchors(mapId) {
  const rows = await many(
    `select name, kind, x, y, r, to_slug, to_anchor, label, meta
     from anchors where map_id = $1 and kind = 'door' order by created_at`,
    [mapId],
  )
  return rows.map((a, i) => ({
    id: a.meta?.legacyEventId ?? i + 1,
    type: 'door',
    x: a.x,
    y: a.y,
    r: a.r,
    label: a.label || a.name,
    to: a.to_slug || '',
  }))
}
