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
  /* THE MAP'S OWN PROPERTIES, which ride the document because they belong to
   * it and because one save beat is easier to reason about than two. The six
   * walk numbers describe the body the map is drawn for and had no column at
   * all until 008, so they could not even be set out of band; title had a
   * column and no writer but the slug. Defaults are walk.ts defaultCfg(), so a
   * document saved by an older tab writes back exactly what it already had. */
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
  const props = {
    title: typeof pr.title === 'string' ? pr.title : '',
    class: ['island', 'room', 'hall'].includes(pr.class) ? pr.class : 'island',
    islandId: typeof pr.islandId === 'string' ? pr.islandId : '',
    meta: pr.meta && typeof pr.meta === 'object' ? pr.meta : {},
  }
  /* the occluder baselines. The polygons ride in the planes png as ids in the
   * green channel; the number a character has to be north of is per id and had
   * nowhere to live, so it was rebuilt from the polygon's bottom edge on every
   * open and the typed value was lost. An older document sends none and keeps
   * the behaviour it had. */
  const occs = Array.isArray(d.occs)
    ? d.occs
        .filter((o) => o && isFinite(Number(o.id)) && isFinite(Number(o.baseline)))
        .map((o) => ({ id: Math.round(Number(o.id)), baseline: Math.round(Number(o.baseline)) }))
    : []

  /* routes and shots. Both come off the document already filtered by mask.ts,
   * so the job here is to store them, not to re-decide what a legal one is; the
   * one thing repeated is the shape guard, because putDoc is reachable by a
   * hand-written POST and mask.ts is not in front of it. */
  const paths = Array.isArray(d.paths)
    ? d.paths.filter((p) => p && typeof p.name === 'string' && Array.isArray(p.points) && p.points.length > 1)
    : []
  const framings = Array.isArray(d.framings)
    ? d.framings.filter((f) => f && typeof f.name === 'string' && isFinite(Number(f.zoom)))
    : []
  /* sets and racks, on the same terms. mask.ts has already dropped a member that
   * is not a legal anchor name and a rack with two hooks numbered 3; the shape
   * guard is repeated here because putDoc is reachable by a hand-written POST and
   * mask.ts is not in front of it. A slot with no number is the one that has to
   * go: the number IS the address, and a hook nothing can name is not a hook. */
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
  /* the exclusive variant sets and the placement group rows, on the same terms.
   * mask.ts has already dropped a set with two states on one placement and a
   * group row that says nothing but its own name; the shape guard is repeated
   * for the reason the others are, that putDoc is reachable by a hand-written
   * POST and mask.ts is not in front of it. A set with no anchor is the one that
   * has to go: the anchor is the only address python can reach the set through,
   * so a set without one is a set nobody can name. */
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

  /* IN THE SHA OR IT NEVER SAVES. A field left out of this list is a field the
   * four-second autosave decides is unchanged, so drawing a route and nothing
   * else would write nothing at all and the work would be gone on reload. */
  const rowSha = sha(
    JSON.stringify([
      w, h, d.base?.w ?? w, d.base?.h ?? h, d.base?.ox ?? 0, d.base?.oy ?? 0, d.spawn, d.assetNext, walk, props, occs,
      paths, framings, sets, racks, variants, assetGroups,
    ]) + assetsSha,
  )
  const cur = await one('select doc_sha from maps where id = $1', [mapId])

  if (cur?.doc_sha !== rowSha) {
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
        /* ROUNDED, NOT TRUNCATED, because the other side rounds.
         *
         * mask.ts reads a spawn back with Math.round and this wrote it with
         * `| 0`, so the two disagree about any half pixel and the row ends up
         * one north of the document. Not currently reachable, since every
         * writer upstream already rounds, which is why changing it did NOT fix
         * the hub's 557,508-in-557,507-out failure. Left as a consistency fix
         * and written down so the next person does not read it as the cause of
         * that one. The real cause is the doc_sha shortcut above: the columns
         * were edited out of band, the sha still matches the document, and an
         * unchanged save writes nothing, so the row can never correct itself. */
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
    /* The row is the source for these, not the local copy, because they are the
     * half of the document that has real columns behind it and can be corrected
     * out of band. A map opened before 008 comes back holding the defaults,
     * which are the numbers it was already shipping. */
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
    },
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
      /* THE CONDITION THIS PLACE IS THERE UNDER, folded into the bag the way
       * derived and docId already are. It has to ride here rather than in a
       * column: the upsert below copies a fixed list of columns plus the whole
       * bag, the game's readAnchors copies the identical way, and the publish
       * projection does it a third time, so a top-level field on an anchor is
       * dropped three times over while the bag arrives intact.
       *
       * mask.ts migrateEvent does the same fold in the browser, and this is the
       * repeat for the reason every other shape guard in this file is repeated:
       * putDoc is reachable by a hand-written POST and mask.ts is not in front
       * of it. Without this line an author's barred door was a field the editor
       * showed and the database never heard of. */
      const when = typeof a.when === 'string' ? a.when.trim().slice(0, 240) : ''
      if (when) meta.when = when
      else delete meta.when

      /* THE DRAWN AREA, checked here as well as in the browser, for the reason
       * every other shape guard in this file is repeated: putDoc is reachable
       * by a hand-written POST and mask.ts is not in front of it. Two points
       * are a line and a line has no inside, so anything under three is stored
       * as no shape at all rather than as an area nobody can ever be in. */
      const poly = (Array.isArray(a.poly) ? a.poly : []).filter(
        (q) => Array.isArray(q) && q.length === 2 && Number.isFinite(Number(q[0])) && Number.isFinite(Number(q[1])),
      )
      const polyJson = poly.length >= 3 ? JSON.stringify(poly.map((q) => [Math.round(Number(q[0])), Math.round(Number(q[1]))])) : null
      const rectOk = Array.isArray(a.rect) && a.rect.length === 4

      /* WHICH OF THE THREE AREA SHAPES IS THE LIVE ONE, folded into the bag the
       * way `when` is above and for the identical reason: this upsert copies a
       * fixed list of columns plus the whole bag, the game's readAnchors copies
       * the same way, and the publish projection does it a third time, so a new
       * top-level field would be dropped three times over.
       *
       * It has to survive because both shapes are now stored side by side. A
       * rect used to be nulled the moment a poly arrived, which is why touching
       * the circle button in the editor cost an author their whole drawing.
       * Nothing is thrown away here any more, so without the mode a reopened map
       * would have no way to know which of the two the author had chosen. */
      const wanted = ['circle', 'rect', 'poly'].includes(a.shape)
        ? a.shape
        : ['circle', 'rect', 'poly'].includes(meta.shape)
          ? meta.shape
          : ''
      if (a.kind === 'region' && (polyJson || rectOk || wanted)) meta.shape = wanted || (polyJson ? 'poly' : rectOk ? 'rect' : 'circle')
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
          /* BOTH SHAPES ARE KEPT, and this line used to be where one of them
           * died: a rect went in as null whenever a poly existed, so switching
           * an anchor back to its box after drawing on it got an empty box. The
           * mode in the bag says which one is authoritative, publish ships only
           * that one, and neither is destroyed by choosing the other. */
          rectOk ? JSON.stringify(a.rect.map((n) => Math.round(Number(n)))) : null,
          polyJson,
          a.stand ? JSON.stringify(a.stand) : null,
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
