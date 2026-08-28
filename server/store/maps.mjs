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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { q, one, many, tx } from '../db/pool.mjs'
import { store, keys } from './blobs.mjs'
import { encodePNG, decodePNG } from '../sheet.mjs'
import { hashPassword } from './crypto.mjs'
import { env } from '../db/env.mjs'

const WORK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'work')

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

// This machine's own copy of a map document, if it has one. Absent on a host,
// where WORK is a scratch directory, and that is the case the blob covers.
// when the local copy was last written, so getDoc can tell a genuinely newer
// file from one that has simply been sitting there since the last import
function localDocAt(slug) {
  try {
    if (!slug || env().MAPVIS_NO_DISK === '1') return 0
    return fs.statSync(path.join(WORK_DIR, slug, 'doc.json')).mtimeMs
  } catch {
    return 0
  }
}

function localDoc(slug) {
  try {
    if (!slug || env().MAPVIS_NO_DISK === '1') return null
    const f = path.join(WORK_DIR, slug, 'doc.json')
    if (!fs.existsSync(f)) return null
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

// Rebuilds the v3 string the editor expects, so nothing downstream changed.
export async function getDoc(mapId) {
  const m = await getMapById(mapId)
  if (!m) return null
  const blob = await one('select key from map_blobs where map_id = $1 and role = $2', [mapId, 'planes'])
  let mm = ''

  /* THE MASK IS THE ONE THING THAT CANNOT BE REDRAWN, SO NEVER LET ONE COPY
   * DECIDE WHETHER IT OPENS.
   *
   * The planes live in object storage, and the day the bucket stopped serving,
   * every map on this laptop stopped opening with it, even though work/<slug>/
   * doc.json on the local disk held the identical mask the whole time. Hours of
   * hand-drawn cut and levels were unreachable because a free tier's download
   * counter had run out.
   *
   * So the local copy is tried first: it costs nothing, it is written by the
   * same save that writes the blob, and it means an unreachable bucket degrades
   * to slower rather than to stopped. The blob stays the source of truth for any
   * machine that does not have the file. */
  /* THE LOCAL COPY IS A FALLBACK. IT USED TO BE THE SOURCE, AND THAT IS A BUG.
   *
   * The reason above is right: the day the bucket stopped answering, no map on
   * this laptop would open, while work/<slug>/doc.json held the identical mask
   * the whole time. What it gets wrong is "written by the same save". It is
   * not. With the platform on, POST /api/doc returns before any disk write, so
   * the only writers of doc.json are the failure fallback and import-work.mjs.
   *
   * Measured on the hub: doc.json last written 05:57, map_blobs planes 19:55,
   * fourteen hours apart, contents identical only because nothing edited the
   * mask in between. Every mask edit from here would have gone to planes.png
   * and then been discarded on the next open in favour of a morning-old file.
   * That is the one thing this codebase says cannot be redrawn, silently
   * reverting itself.
   *
   * So the file is used when the blob cannot be read, or when it is genuinely
   * newer than the row. Otherwise the store wins, which is what makes it the
   * source of truth it is called everywhere else. */
  const local = localDoc(m.slug)
  const localNewer = local && localDocAt(m.slug) > +new Date(m.updated_at || 0)
  if (local && typeof local.m === 'string' && local.m.length && (!blob || localNewer)) {
    mm = local.m
  } else if (blob) {
    mm = packM(...(({ lvl, occ, cut }) => [lvl, occ, cut])(planesFromPNG(await store().get(blob.key))))
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
/* The document is where an anchor is authored, because that is what rides undo,
 * autosave and the browser copy. The table is the mirror the api queries, so
 * python can ask what a map is called without downloading the map.
 *
 * Mirror means mirror: everything in the document is upserted by name, and any
 * row the document no longer has is deleted. Anything else and a renamed or
 * removed anchor lingers in the api forever. */
export async function syncEventsToAnchors(mapId, anchors) {
  const { anchorName } = await import('./crypto.mjs')
  return tx(async (c) => {
    const seen = new Set()
    let touched = 0

    for (const a of anchors) {
      if (!a || !Number.isFinite(Number(a.x))) continue
      // a document written before anchors existed has a label and no name, so
      // one is derived here and flagged, exactly as the editor would
      const derived = !/^[a-z][a-z0-9_]{0,47}$/.test(String(a.name || ''))
      const name = derived ? anchorName(a.label || `${a.kind || a.type || 'door'}_${a.id}`) : a.name
      if (seen.has(name)) continue
      seen.add(name)

      const meta = { ...(a.meta || {}) }
      if (derived) meta.derived = true
      if (a.id != null) meta.docId = Number(a.id)

      const r = await c.query(
        `insert into anchors (map_id, name, kind, x, y, r, rect, to_slug, to_anchor, placement_id, facing, label, meta)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb)
         on conflict (map_id, name) do update set
           kind=excluded.kind, x=excluded.x, y=excluded.y, r=excluded.r, rect=excluded.rect,
           to_slug=excluded.to_slug, to_anchor=excluded.to_anchor, placement_id=excluded.placement_id,
           facing=excluded.facing, label=excluded.label, meta=excluded.meta
         where (anchors.kind, anchors.x, anchors.y, anchors.r, anchors.rect,
                anchors.to_slug, anchors.to_anchor, anchors.placement_id,
                anchors.facing, anchors.label, anchors.meta)
           is distinct from
               (excluded.kind, excluded.x, excluded.y, excluded.r, excluded.rect,
                excluded.to_slug, excluded.to_anchor, excluded.placement_id,
                excluded.facing, excluded.label, excluded.meta)
         returning id`,
        [
          mapId,
          name,
          ['point', 'region', 'door', 'post', 'spawn', 'trigger'].includes(a.kind) ? a.kind : 'door',
          Math.round(a.x),
          Math.round(a.y),
          Math.round(a.r) || 14,
          a.rect ? JSON.stringify(a.rect) : null,
          a.to || null,
          a.toAnchor || null,
          a.placement || null,
          a.facing || null,
          a.label || '',
          JSON.stringify(meta),
        ],
      )
      if (r.rowCount) touched++
    }

    const gone = await c.query(
      seen.size
        ? `delete from anchors where map_id = $1 and name <> all($2::text[]) returning name`
        : `delete from anchors where map_id = $1 returning name`,
      seen.size ? [mapId, [...seen]] : [mapId],
    )
    return touched + gone.rowCount
  })
}

/* Back out in the document's own shape. Every kind comes back, not only doors,
 * because the editor holds the whole list. */
export async function eventsFromAnchors(mapId) {
  const rows = await many(
    `select name, kind, x, y, r, rect, to_slug, to_anchor, placement_id, facing, label, meta
     from anchors where map_id = $1 order by created_at`,
    [mapId],
  )
  return rows.map((a, i) => ({
    id: a.meta?.docId ?? i + 1,
    name: a.name,
    kind: a.kind,
    x: a.x,
    y: a.y,
    r: a.r,
    ...(a.rect ? { rect: a.rect } : {}),
    to: a.to_slug || '',
    ...(a.to_anchor ? { toAnchor: a.to_anchor } : {}),
    ...(a.placement_id ? { placement: a.placement_id } : {}),
    ...(a.facing ? { facing: a.facing } : {}),
    label: a.label || '',
    ...(a.meta && Object.keys(a.meta).length ? { meta: a.meta } : {}),
  }))
}
