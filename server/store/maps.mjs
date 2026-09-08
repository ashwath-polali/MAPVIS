// each half is written only when its own content changed, because a 4 second autosave of the whole document is 1.6 GB an hour against a 0.5 GB tier
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { q, one, many, tx } from '../db/pool.mjs'
import { store, keys } from './blobs.mjs'
import { encodePNG, decodePNG } from '../sheet.mjs'
import { hashPassword } from './crypto.mjs'
import { env } from '../db/env.mjs'
import { MAP_CLASSES } from './publish.mjs'

/* the same two-body reach mask.ts holds the browser to, repeated because putDoc is reachable by a hand-written POST, and truncated toward the anchor so rounding cannot put it back outside */
export function clampStand(x, y, stand, charH) {
  if (!Array.isArray(stand) || stand.length !== 2) return null
  if (!Number.isFinite(Number(stand[0])) || !Number.isFinite(Number(stand[1]))) return null
  // rounded BEFORE it is measured: rounding a point just inside the circle can push it back out by up to 0.71px
  const sx = Math.round(Number(stand[0]))
  const sy = Math.round(Number(stand[1]))
  const reach = Math.max(1, Math.round(Number(charH) || 18)) * 2
  const dx = sx - x
  const dy = sy - y
  const d = Math.hypot(dx, dy)
  if (d <= reach) return [sx, sy]
  const k = reach / d
  return [x + Math.trunc(dx * k), y + Math.trunc(dy * k)]
}

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

/* the five fields a person TYPED, worth rescuing because geometry can be dragged back and a name is the only address python has */
const AUTHORED = ['life', 'name', 'looks', 'lookName', 'when']

/* never throws, because refusing the write over a failed rescue copy costs the author the edit they just made as well */
async function keepLostAuthoring(mapId, wasAssets, nowAssets) {
  try {
    const before = new Map((Array.isArray(wasAssets) ? wasAssets : []).map((a) => [String(a.id), a]))
    if (!before.size) return null
    const lost = []
    for (const a of Array.isArray(nowAssets) ? nowAssets : []) {
      const was = before.get(String(a && a.id))
      if (!was) continue
      for (const k of AUTHORED) if (was[k] != null && (a[k] === undefined || a[k] === null)) lost.push(`${a.id}.${k}`)
    }
    if (!lost.length) return null
    const at = new Date().toISOString().replace(/[:.]/g, '-')
    const key = keys.docRescue(mapId, at)
    await store().put(key, Buffer.from(JSON.stringify({ mapId, at, lost, assets: wasAssets }, null, 1)), 'application/json')
    console.error(
      `[doc] a save removed authored work from ${lost.length} field(s) on map ${mapId}: ` +
        `${lost.slice(0, 12).join(', ')}${lost.length > 12 ? ` and ${lost.length - 12} more` : ''}. ` +
        `the placements as they were are kept at ${key}`,
    )
    return `rescued ${lost.length}`
  } catch (e) {
    console.error('[doc] could not keep the placements a save is about to overwrite:', e.message)
    return null
  }
}

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
  /* the map's own properties ride the document so there is one save beat, and the defaults are walk.ts defaultCfg() so an older tab writes back what it already had */
  const wk = d.walk && typeof d.walk === 'object' ? d.walk : {}
  const pr = d.props && typeof d.props === 'object' ? d.props : {}
  const num = (v, dflt) => (isFinite(Number(v)) ? Number(v) : dflt)
  const walk = {
    charH: Math.round(num(wk.charH, 18)),
    hip: Math.round(num(wk.hip, 2)),
    hipDY: Math.round(num(wk.hipDY, 1)),
    speed: num(wk.speed, 34),
    yScale: num(wk.yScale, 0.72),
    near: Math.round(num(wk.near, 10)),
  }
  /* WHERE THE PAINT IS, STATED. Four finite numbers or nothing, and nothing is
   * the normal answer: publish scans the bytes that ship and beats a typed
   * number. paint_set is what stops that scan overwriting a correction. */
  const paint =
    Array.isArray(pr.paint) && pr.paint.length === 4 && pr.paint.every((n) => Number.isFinite(Number(n)))
      ? pr.paint.map((n) => Math.round(Number(n)))
      : null
  const props = {
    title: typeof pr.title === 'string' ? pr.title : '',
    class: MAP_CLASSES.includes(pr.class) ? pr.class : 'island',
    islandId: typeof pr.islandId === 'string' ? pr.islandId : '',
    meta: pr.meta && typeof pr.meta === 'object' ? pr.meta : {},
    ...(paint ? { paint } : {}),
  }
  /* the occluder baselines, because the polygons ride in the planes png and a per-id typed baseline was rebuilt from the bottom edge on every open and lost */
  const occs = Array.isArray(d.occs)
    ? d.occs
        .filter((o) => o && isFinite(Number(o.id)) && isFinite(Number(o.baseline)))
        .map((o) => ({ id: Math.round(Number(o.id)), baseline: Math.round(Number(o.baseline)) }))
    : []

  /* only the shape guard is repeated, because mask.ts has already filtered these and putDoc is reachable by a hand-written POST */
  const paths = Array.isArray(d.paths)
    ? d.paths.filter((p) => p && typeof p.name === 'string' && Array.isArray(p.points) && p.points.length > 1)
    : []
  const framings = Array.isArray(d.framings)
    ? d.framings.filter((f) => f && typeof f.name === 'string' && isFinite(Number(f.zoom)))
    : []
  /* sets and racks on the same terms, and a slot with no number goes because the number is the address a save means */
  const sets = Array.isArray(d.sets)
    ? d.sets.filter((s) => s && typeof s.name === 'string' && Array.isArray(s.members))
    : []
  const racks = Array.isArray(d.racks)
    ? d.racks
        .filter((r) => r && typeof r.name === 'string' && Array.isArray(r.slots))
        .map((r) => ({
          ...r,
          slots: r.slots.filter((s) => s && isFinite(Number(s.slot)) && typeof s.anchor === 'string' && s.anchor),
        }))
    : []
  /* variant sets and group rows on the same terms, and a set with no anchor goes because the anchor is the only address python can reach it through */
  const variants = Array.isArray(d.variants)
    ? d.variants
        .filter((v) => v && typeof v.name === 'string' && typeof v.anchor === 'string' && v.anchor && Array.isArray(v.members))
        .map((v) => ({
          ...v,
          members: v.members.filter((m) => m && typeof m.name === 'string' && typeof m.placement === 'string' && m.placement),
        }))
    : []
  const assetGroups = Array.isArray(d.groups)
    ? d.groups.filter((g) => g && typeof g.name === 'string' && g.name && (g.when || g.label))
    : []

  // the outlines an author drew, three points minimum, newest first and capped
  const stencils = (Array.isArray(d.stencils) ? d.stencils : [])
    .filter((k) => k && Number.isFinite(Number(k.id)) && Array.isArray(k.pts) && k.pts.length >= 3)
    .map((k) => ({
      id: Math.round(Number(k.id)),
      pts: k.pts
        .filter((q2) => Array.isArray(q2) && q2.length === 2 && Number.isFinite(Number(q2[0])) && Number.isFinite(Number(q2[1])))
        .map((q2) => [Number(q2[0]), Number(q2[1])]),
    }))
    .filter((k) => k.pts.length >= 3)
    .slice(0, 12)

  /* IN THE SHA OR IT NEVER SAVES. A field left out of this list is a field the
   * four-second autosave decides is unchanged, so drawing a route and nothing
   * else would write nothing at all and the work would be gone on reload. */
  const rowSha = sha(
    JSON.stringify([
      w, h, d.base?.w ?? w, d.base?.h ?? h, d.base?.ox ?? 0, d.base?.oy ?? 0, d.spawn, d.assetNext, walk, props, occs,
      paths, framings, sets, racks, variants, assetGroups, stencils,
    ]) + assetsSha,
  )
  const cur = await one('select doc_sha from maps where id = $1', [mapId])

  if (cur?.doc_sha !== rowSha) {
    /* a save that drops an authored field leaves a rescue file and a log line rather than being refused, and it sits inside the sha check because reading 100 kb of placements every four seconds is 90 mb an hour */
    const was = await one('select assets from maps where id = $1', [mapId])
    const rescued = await keepLostAuthoring(mapId, was?.assets, assets)
    if (rescued) wrote.push(rescued)
    await q(
      `update maps set
         w = $2, h = $3,
         base_w = $4, base_h = $5, base_ox = $6, base_oy = $7,
         spawn_x = $8, spawn_y = $9,
         assets = $10::jsonb, asset_next = $11,
         char_h = $13, char_hip = $14, char_hipdy = $15,
         speed = $16, yscale = $17, step_tol = $18,
         title = $19, class = $20, island_id = $21, meta = $22::jsonb,
         occs = $23::jsonb,
         paths = $24::jsonb, framings = $25::jsonb,
         sets = $26::jsonb, racks = $27::jsonb,
         variants = $28::jsonb, asset_groups = $29::jsonb,
         stencils = $35::jsonb,
         /* a stated extent lands in the paint_* columns and marks itself, so
          * publish leaves it alone; unstated leaves whatever publish measured */
         paint_w = case when $34 then $30 else paint_w end,
         paint_h = case when $34 then $31 else paint_h end,
         paint_ox = case when $34 then $32 else paint_ox end,
         paint_oy = case when $34 then $33 else paint_oy end,
         paint_set = $34,
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
        /* rounded and not truncated, because mask.ts reads a spawn back with Math.round and `| 0` puts the row a pixel north of the document */
        Math.round(Number(d.spawn?.[0]) || 0),
        Math.round(Number(d.spawn?.[1]) || 0),
        assetsJson,
        d.assetNext ?? assets.length + 1,
        rowSha,
        walk.charH,
        walk.hip,
        walk.hipDY,
        walk.speed,
        walk.yScale,
        walk.near,
        props.title,
        props.class,
        props.islandId,
        JSON.stringify(props.meta),
        JSON.stringify(occs),
        JSON.stringify(paths),
        JSON.stringify(framings),
        JSON.stringify(sets),
        JSON.stringify(racks),
        JSON.stringify(variants),
        JSON.stringify(assetGroups),
        paint?.[0] ?? 0,
        paint?.[1] ?? 0,
        paint?.[2] ?? 0,
        paint?.[3] ?? 0,
        !!paint,
        JSON.stringify(stencils),
      ],
    )
    wrote.push(`doc ${(assetsJson.length / 1024).toFixed(1)}kb`)
  }

  // Events are the pre-anchor contract and still ride in the document. They are
  // mirrored into the anchors table rather than living there twice, so the
  // editor keeps working while the naming UI is built.
  if (Array.isArray(d.events)) {
    const n = await syncEventsToAnchors(mapId, d.events, walk.charH)
    if (n) wrote.push(`${n} anchor(s)`)
  }

  return { wrote, skipped: !wrote.length }
}

// when the local copy was last written, so getDoc can tell a genuinely newer file from one sitting there since the last import
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

  /* the mask cannot be redrawn, so an unreachable blob falls back to the local file rather than failing to open */
  /* but the local file is only a fallback and never the source: doc.json is not written by the same save, and preferring it discarded fourteen hours of mask edits */
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
    /* the row is the source for these and not the local copy, because they have real columns behind them and can be corrected out of band */
    walk: {
      charH: m.char_h ?? 18,
      hip: m.char_hip ?? 2,
      hipDY: m.char_hipdy ?? 1,
      speed: Number(m.speed ?? 34),
      yScale: Number(m.yscale ?? 0.72),
      near: m.step_tol ?? 10,
    },
    props: {
      title: m.title || '',
      class: m.class || 'island',
      islandId: m.island_id || '',
      meta: m.meta || {},
      // only when a person stated it; otherwise the four numbers are a measurement and the document says nothing
      ...(m.paint_set ? { paint: [m.paint_w, m.paint_h, m.paint_ox, m.paint_oy] } : {}),
    },
    stencils: Array.isArray(m.stencils) ? m.stencils : [],
    stencilNext: (Array.isArray(m.stencils) ? m.stencils : []).reduce((a, k) => Math.max(a, Number(k.id) || 0), 0) + 1,
    occs: Array.isArray(m.occs) ? m.occs : [],
    occNext: (Array.isArray(m.occs) ? m.occs : []).reduce((a, o) => Math.max(a, Number(o.id) || 0), 0) + 1,
    paths: Array.isArray(m.paths) ? m.paths : [],
    pathNext: (Array.isArray(m.paths) ? m.paths : []).reduce((a, p) => Math.max(a, Number(p.id) || 0), 0) + 1,
    framings: Array.isArray(m.framings) ? m.framings : [],
    framingNext: (Array.isArray(m.framings) ? m.framings : []).reduce((a, f) => Math.max(a, Number(f.id) || 0), 0) + 1,
    sets: Array.isArray(m.sets) ? m.sets : [],
    setNext: (Array.isArray(m.sets) ? m.sets : []).reduce((a, s) => Math.max(a, Number(s.id) || 0), 0) + 1,
    racks: Array.isArray(m.racks) ? m.racks : [],
    rackNext: (Array.isArray(m.racks) ? m.racks : []).reduce((a, r) => Math.max(a, Number(r.id) || 0), 0) + 1,
    variants: Array.isArray(m.variants) ? m.variants : [],
    variantNext: (Array.isArray(m.variants) ? m.variants : []).reduce((a, v) => Math.max(a, Number(v.id) || 0), 0) + 1,
    /* the document calls them `groups` and the column is `asset_groups`, because
     * GROUPS is a sql keyword and the schema now also has anchor sets to be
     * confused with. The rename lives here, at the one boundary that crosses. */
    groups: Array.isArray(m.asset_groups) ? m.asset_groups : [],
  })
}

// ---- events and anchors, the bridge between the two contracts ---------------

// a derived name is flagged derived:true, because a name a member writes python against has to be one a human actually picked
/* mirror means mirror: everything in the document is upserted by name and any row it no longer has is deleted, or a renamed anchor lingers in the api forever */
export async function syncEventsToAnchors(mapId, anchors, charH = 18) {
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
      /* `when` rides in the meta bag and not a column, because three readers copy a fixed column list plus the whole bag, so a new top-level field is dropped three times over */
      const when = typeof a.when === 'string' ? a.when.trim().slice(0, 240) : ''
      if (when) meta.when = when
      else delete meta.when

      /* under three points is stored as no shape at all, because a line has no inside and would be an area nobody can ever be in */
      const poly = (Array.isArray(a.poly) ? a.poly : []).filter(
        (q) => Array.isArray(q) && q.length === 2 && Number.isFinite(Number(q[0])) && Number.isFinite(Number(q[1])),
      )
      const polyJson = poly.length >= 3 ? JSON.stringify(poly.map((q) => [Math.round(Number(q[0])), Math.round(Number(q[1]))])) : null
      const rectOk = Array.isArray(a.rect) && a.rect.length === 4

      /* the live shape rides in the bag for the same reason `when` does, on EVERY kind and not only a region, or a zone drawn on a door reads back as a plain circle */
      const stand = clampStand(Math.round(a.x), Math.round(a.y), a.stand, charH)
      const wanted = ['circle', 'rect', 'poly'].includes(a.shape)
        ? a.shape
        : ['circle', 'rect', 'poly'].includes(meta.shape)
          ? meta.shape
          : ''
      if (polyJson || rectOk || wanted) meta.shape = wanted || (polyJson ? 'poly' : rectOk ? 'rect' : 'circle')
      else delete meta.shape
      const r = await c.query(
        `insert into anchors (map_id, name, kind, x, y, r, rect, poly, stand, to_slug, to_anchor, placement_id, facing, label, meta)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb)
         on conflict (map_id, name) do update set
           kind=excluded.kind, x=excluded.x, y=excluded.y, r=excluded.r, rect=excluded.rect,
           poly=excluded.poly, stand=excluded.stand,
           to_slug=excluded.to_slug, to_anchor=excluded.to_anchor, placement_id=excluded.placement_id,
           facing=excluded.facing, label=excluded.label, meta=excluded.meta
         where (anchors.kind, anchors.x, anchors.y, anchors.r, anchors.rect, anchors.poly, anchors.stand,
                anchors.to_slug, anchors.to_anchor, anchors.placement_id,
                anchors.facing, anchors.label, anchors.meta)
           is distinct from
               (excluded.kind, excluded.x, excluded.y, excluded.r, excluded.rect, excluded.poly, excluded.stand,
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
          /* both shapes are kept, because nulling the rect whenever a poly existed cost an author their box the moment they drew on it */
          rectOk ? JSON.stringify(a.rect.map((n) => Math.round(Number(n)))) : null,
          polyJson,
          stand ? JSON.stringify(stand) : null,
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
    `select name, kind, x, y, r, rect, poly, stand, to_slug, to_anchor, placement_id, facing, label, meta
     from anchors where map_id = $1 order by created_at`,
    [mapId],
  )
  return rows.map((a, i) => ({
    id: a.meta?.docId ?? i + 1,
    name: a.name,
    // lifted back onto the field it was typed into, so the two can never
    // disagree about what the author wrote. mask.ts migrateEvent does the same
    // lift, and this is the half that runs before the browser sees the document.
    ...(typeof a.meta?.when === 'string' && a.meta.when ? { when: a.meta.when } : {}),
    // and the same lift for the area mode, so a reopened map shows the shape the
    // author chose rather than whichever of the two stored shapes is guessed at
    ...(['circle', 'rect', 'poly'].includes(a.meta?.shape) ? { shape: a.meta.shape } : {}),
    kind: a.kind,
    x: a.x,
    y: a.y,
    r: a.r,
    ...(a.rect ? { rect: a.rect } : {}),
    // the shape the author walked round, back in the document's own shape so
    // reopening a map shows the area they drew instead of the box it sits in
    ...(a.poly ? { poly: a.poly } : {}),
    ...(a.stand ? { stand: a.stand } : {}),
    to: a.to_slug || '',
    ...(a.to_anchor ? { toAnchor: a.to_anchor } : {}),
    ...(a.placement_id ? { placement: a.placement_id } : {}),
    ...(a.facing ? { facing: a.facing } : {}),
    label: a.label || '',
    ...(a.meta && Object.keys(a.meta).length ? { meta: a.meta } : {}),
  }))
}
