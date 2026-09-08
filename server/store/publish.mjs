// export is a save: version N's bytes live at publish/<slug>/vN/ forever and are never rewritten, so a class mid-session cannot break and a cdn can cache them for good
import crypto from 'node:crypto'
import { q, one, many, tx } from '../db/pool.mjs'
import { store, keys } from './blobs.mjs'
import { packAtlas, atlasify } from './atlas.mjs'
import { gateMap } from './gate.mjs'
import { decodePNG } from '../sheet.mjs'

// the same three words as MAP_CLASSES in src/core/mask.ts and the check on
// maps.class in 008. Kept here because the browser's copy is typescript.
export const MAP_CLASSES = ['island', 'room', 'hall']

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

/* measured off the shipped bytes, because `base` is the dropped image and read 688x640 on a hub opaque only in x 7..675, y 194..570; alpha 8 so a soft coastline is not eaten */
export function paintedBox(png) {
  const { w, h, data } = decodePNG(png)
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
      }
  if (x1 < 0) return { w, h, ox: 0, oy: 0 }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, ox: x0, oy: y0 }
}

/* compounds first, because the game re-derives a heading with endsWith and 'south-west-0.png' ends with 'west-0.png', which sent 17 of the hub's 38 sets to the wrong view */
export const DIR_ORDER = ['north-east', 'north-west', 'south-east', 'south-west', 'east', 'west', 'north', 'south']

export const orderedHeadings = (keys) =>
  [...keys].sort((a, b) => {
    const ia = DIR_ORDER.indexOf(a)
    const ib = DIR_ORDER.indexOf(b)
    return (ia < 0 ? DIR_ORDER.length : ia) - (ib < 0 ? DIR_ORDER.length : ib)
  })

/* shots fold onto the anchor's meta bag because the game has no reader for a shot list, and zoom crosses as overFit/1.18 rather than the editor's notch, which would arrive as a face filling the screen; a deliberate second copy of src/core/mask.ts, change both */
const GAME_OPENING_PULL = 1.18

const shotZoom = (f) => {
  const rel = isFinite(Number(f?.overFit)) && Number(f.overFit) > 0 ? Number(f.overFit) : 0
  // a shot armed before overFit existed has no canvas behind it any more, so it
  // becomes the map's opening view. That is a camera somebody can look at and
  // re-arm; the raw notch is a nose filling the screen with nothing saying why.
  if (!rel) return 1
  return Math.round((rel / GAME_OPENING_PULL) * 1000) / 1000
}

/* a projection owns its key's absence too, or a framings key left in the bag from an earlier export ships as a camera the author can neither see nor delete; second copy of src/core/mask.ts, change both */
const without = (meta, ...keys) => {
  if (!meta || typeof meta !== 'object') return undefined
  const out = { ...meta }
  for (const k of keys) delete out[k]
  return Object.keys(out).length ? out : undefined
}

/* a poly ships with its box because the game tests a region by its rect and has no polygon test, so points alone are a place nobody is ever inside; second copy of src/core/mask.ts, change both */
/* the meta mode wins only when the shape it names has something in it, and no gate on kind, or a zone drawn on a door ships as a bare radius */
const anchorShape = (a) => {
  const hasPoly = Array.isArray(a.poly) && a.poly.length > 2
  const hasRect = Array.isArray(a.rect) && a.rect.length === 4
  const want = a.meta && typeof a.meta.shape === 'string' ? a.meta.shape : ''
  if (want === 'poly' && hasPoly) return 'poly'
  if (want === 'rect' && hasRect) return 'rect'
  if (want === 'circle') return 'circle'
  return hasPoly ? 'poly' : hasRect ? 'rect' : 'circle'
}

const polyBox = (poly) => {
  let x0 = Number(poly[0][0])
  let y0 = Number(poly[0][1])
  let x1 = x0
  let y1 = y0
  for (const [x, y] of poly) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

const shotsOntoMeta = (framings, anchor, meta) => {
  const all = Array.isArray(framings) ? framings : []
  const mine = all.filter((f) => f && f.anchor === anchor)
  const had = meta && typeof meta === 'object' && Object.keys(meta).length ? meta : null
  if (!mine.length) return without(had, 'framings', 'framing')
  const one = (f) => ({ zoom: shotZoom(f), dx: f.dx ?? 0, dy: f.dy ?? 0 })
  const set = {}
  for (const f of mine) set[f.name] = one(f)
  /* a default is always written, because look_at asks for a shot with no name and an unnamed miss falls back to the same slot */
  const def = mine.find((f) => f.entry) || mine.reduce((a, b) => ((a.id ?? 0) <= (b.id ?? 0) ? a : b))
  /* MERGED, NEVER SWAPPED IN. panthers_maw on the real hub already carries docId
   * and derived, and the game writes `derived` itself when it has to invent a
   * name, so replacing the bag would take both out. */
  return { ...(had || {}), framings: set, framing: { ...one(def), name: def.name } }
}

/* variants go in the meta bag and not at the top level, because the game's Anchor reader takes a fixed field list and copies meta whole; no default is invented, an empty initial is a state an author chose */
const variantsOntoMeta = (variants, anchor, meta) => {
  const all = Array.isArray(variants) ? variants : []
  const mine = all.filter((v) => v && v.anchor === anchor)
  const had = meta && typeof meta === 'object' && Object.keys(meta).length ? meta : null
  // the same clearing the shots do, for the same reason: a projection that
  // cannot remove its own key ships a set nothing in the document still holds
  if (!mine.length) return without(had, 'variants')
  const set = {}
  for (const v of mine)
    set[v.name] = {
      initial: typeof v.initial === 'string' ? v.initial : '',
      members: (Array.isArray(v.members) ? v.members : []).map((m) => ({ name: m.name, placement: m.placement })),
    }
  /* MERGED, NEVER SWAPPED IN, exactly as the shots are. An anchor already
   * carries docId, derived, and now `when`, and replacing the bag would take all
   * three out. */
  return { ...(had || {}), variants: set }
}

/* the footprint is the bottom contact band and not the whole sprite, so a tree is a trunk you walk into under a canopy; it is not editor.ts's bodyRadius and the two must not be unified, and the ellipse is pushed up by its own ry because the anchor is the front of the base */
const FOOT_ALPHA = 40 // the repo-wide alpha threshold, same as Walk.tsx's trimToFeet
const FOOT_BAND = 4 // how deep the ground contact band is, in painting pixels

/* the frame the placement rests on: whatever a reader would draw for it while it
 * is standing still. The export already resolves a direction set's resting view
 * into src, so this order matches what the walk page puts on screen. */
const restFrame = (a) => a.src || a.frames?.[0] || Object.values(a.dirs || {})[0]?.[0] || null

/* files is keyed by the path inside assets/ and the two callers disagree about
 * whether the folder is on it, exactly as the atlas packer found. Strip and try
 * both rather than trust either. */
function frameBytes(files, url) {
  if (!url) return null
  const rel = String(url)
    .replace(/^\/+/, '')
    .replace(/^assets\//, '')
  return files.get(rel) || files.get('assets/' + rel) || null
}

function measureFoot(img, a, yScale) {
  const { w, h, data } = img
  const sx = Number(a.scaleX ?? a.scale) > 0 ? Number(a.scaleX ?? a.scale) : 1
  const sy = Number(a.scaleY ?? a.scale) > 0 ? Number(a.scaleY ?? a.scale) : 1
  let top = -1
  let feet = -1
  for (let y = 0; y < h; y++) {
    let hit = false
    for (let x = 0; x < w && !hit; x++) if (data[(y * w + x) * 4 + 3] > FOOT_ALPHA) hit = true
    if (hit) {
      if (top < 0) top = y
      feet = y
    }
  }
  // a frame with nothing drawn in it is nothing to walk into
  if (top < 0) return [0, 0, 0, 0]
  /* a quarter of the object's height at most, so a thing shorter than the band
   * is not read as being all base, and never less than one row */
  const drawnH = (feet - top + 1) * sy
  const rows = Math.max(1, Math.round(Math.min(FOOT_BAND, drawnH * 0.25) / sy))
  /* flipY draws the sprite upside down, so the rows that end up against the
   * ground are the ones at the TOP of the source */
  const upside = !!a.flipY
  const lo = upside ? top : Math.max(top, feet - rows + 1)
  const hi = upside ? Math.min(feet, top + rows - 1) : feet
  let x0 = w
  let x1 = -1
  for (let y = lo; y <= hi; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3] > FOOT_ALPHA) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
      }
  if (x1 < x0) return [0, 0, 0, 0]
  let rx = ((x1 - x0 + 1) / 2) * sx
  let ry = Math.max(((hi - lo + 1) / 2) * sy, rx * yScale)
  // the frame is drawn centred on the anchor in x, so an off-centre base carries
  // an offset, and a mirrored frame carries it the other way
  let ox = ((x0 + x1 + 1) / 2 - w / 2) * sx
  if (a.flipX) ox = -ox
  /* a rotated frame is covered by the axis-aligned box around the turned ellipse, because a second geometry nobody can check costs more than the slack */
  if (a.rot) {
    const c = Math.abs(Math.cos(a.rot))
    const s = Math.abs(Math.sin(a.rot))
    const nx = rx * c + ry * s
    const ny = rx * s + ry * c
    rx = nx
    ry = ny
  }
  // the transparent rows under the drawn feet are canvas, not object, and they
  // are what would otherwise float the whole footprint below the ground
  const lift = (upside ? top : h - 1 - feet) * sy
  const r2 = (v) => Math.round(v * 100) / 100
  return [r2(ox), r2(-lift - ry), r2(rx), r2(ry)]
}

/* every placement gets a footprint because it measures the art rather than granting permission to block, except an effect, whose contact band would put an 86px wall across the beach */
export function footprints(assets, files, yScale) {
  const seen = new Map()
  return assets.map((a) => {
    if (!a || typeof a !== 'object') return a
    /* an authored footprint beats the scan, which is the correction for a halo or a painted-in shadow; four finite numbers or the measurement stands */
    if (Array.isArray(a.foot) && a.foot.length === 4 && a.foot.every((n) => Number.isFinite(Number(n))))
      return { ...a, foot: a.foot.map((n) => Number(n)) }
    if (a.group === 'effects') return { ...a, foot: [0, 0, 0, 0] }
    const url = restFrame(a)
    if (!seen.has(url)) {
      const buf = frameBytes(files, url)
      let img = null
      try {
        if (buf) img = decodePNG(buf)
      } catch {
        /* an unreadable frame simply gets no footprint and the reader falls back */
      }
      seen.set(url, img)
    }
    const img = seen.get(url)
    if (!img) return a
    return { ...a, foot: measureFoot(img, a, yScale) }
  })
}

/* a published file is immutable so it is fetched once, because the free tier allows 2,500 downloads a day and a day of building blew through it; small files only */
const HOT_MAX = 200
const HOT_BYTES = 8 * 1024 * 1024
const hot = new Map()
let hotBytes = 0

export function hotGet(key) {
  const v = hot.get(key)
  if (!v) return null
  // touch: least recently used falls off the end first
  hot.delete(key)
  hot.set(key, v)
  return v
}

export function hotPut(key, buf) {
  if (buf.length > 512 * 1024) return buf
  /* a re-put must refund the bytes it replaces, or the counter drifts up permanently and the cache evicts almost everything while looking like it works */
  const prev = hot.get(key)
  if (prev) {
    hot.delete(key)
    hotBytes -= prev.length
  }
  hot.set(key, buf)
  hotBytes += buf.length
  /* `hot.size &&` because entries().next().value on an empty Map is undefined and destructuring it throws every later read into a 500 */
  while (hot.size && (hot.size > HOT_MAX || hotBytes > HOT_BYTES)) {
    const [k, v] = hot.entries().next().value
    hot.delete(k)
    hotBytes -= v.length
  }
  return buf
}

// everything the game fetches under one version prefix, from a Map of bundle-relative path to Buffer
/* the spend ceiling lives in code because R2 bills for overage instead of stopping, and a publish writes about 950 objects */
const WRITE_CEILING = 800_000

async function writesThisMonth() {
  const r = await one(
    `select coalesce(sum((select count(*) from jsonb_object_keys(manifest))), 0) n
       from publishes where published_at >= date_trunc('month', now())`,
  )
  return Number(r.n) || 0
}

export async function publishBundle(slug, { mapJson, assetsJson, images, files }) {
  /* A PUBLISH THAT TAKES MINUTES HAS TO SAY WHERE IT IS. It writes hundreds of
   * objects and nothing said so until it finished, which is indistinguishable
   * from hanging and was read as exactly that for hours. */
  const t0 = Date.now()
  const step = (what) => console.log(`[publish] ${slug}: ${what} · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  const m = await one('select id from maps where slug = $1', [slug])
  if (!m) throw new Error(`no map ${slug}`)

  const already = await writesThisMonth()
  const about = (files?.size || 0) + Object.keys(images || {}).length + 4
  if (already + about > WRITE_CEILING) {
    throw new Error(
      `this export would write ${about} objects and ${already} have already been written this month, ` +
        `which crosses the ${WRITE_CEILING} ceiling that keeps storage inside its free allowance. ` +
        `The count resets on the 1st. Nothing was written.`,
    )
  }

  const last = await one('select coalesce(max(version), 0) v from publishes where map_id = $1', [m.id])
  const version = Number(last.v) + 1
  const prefix = keys.publish(slug, version)
  const s = store()

  // anchors come from the table and not the client, and both anchors[] and the older events[] ship so no working bundle stops working
  const anchors = await many(
    `select name, kind, x, y, r, rect, poly, stand, to_slug, to_anchor, placement_id, facing, label, meta
     from anchors where map_id = $1 order by kind, name`,
    [m.id],
  )
  /* title and class are selected here because the bundle never carried them, so every place name was a slug and the engine guessed class from the border */
  const props = await one(
    `select m.title, m.class, m.island_id, m.meta, m.char_h, m.char_hip, m.char_hipdy, m.speed, m.yscale, m.step_tol,
            m.base_w, m.base_h, m.base_ox, m.base_oy, m.paint_set, m.paint_w, m.paint_h, m.paint_ox, m.paint_oy,
            m.paths, m.framings, m.sets, m.racks,
            m.variants, m.asset_groups, m.cover_fact,
            u.email as owner_email
     from maps m join users u on u.id = m.owner_id where m.id = $1`,
    [m.id],
  )
  /* MEASURED BEFORE THE BUNDLE IS ASSEMBLED, and never fatal: a scene this
   * decoder cannot read is a reason to fall back to the columns, not a reason to
   * refuse a publish that is otherwise fine. */
  const stated = props?.paint_set ? { w: props.paint_w, h: props.paint_h, ox: props.paint_ox, oy: props.paint_oy } : null
  let paint = null
  try {
    if (images?.['scene.png']) paint = paintedBox(images['scene.png'])
  } catch (e) {
    console.warn(`[publish] ${slug}: could not measure the painted extent, falling back to base_* · ${e.message}`)
  }
  const map = {
    ...mapJson,
    contract: 2,
    slug,
    version,
    ...(props?.title ? { title: props.title } : {}),
    /* class is never optional, because absent makes the engine guess island from the border of a fact this side already knows */
    class: MAP_CLASSES.includes(props?.class) ? props.class : 'island',
    ...(props?.island_id ? { islandId: props.island_id } : {}),
    ...(props?.meta && Object.keys(props.meta).length ? { meta: props.meta } : {}),
    /* the walk contract comes from the row, so a stale tab cannot publish an 18 px character over a map set to 36 */
    encoding: { ...(mapJson?.encoding || {}), stepTolerance: props?.step_tol ?? 10 },
    character: { heightPx: props?.char_h ?? 18, hip: props?.char_hip ?? 2, hipDY: props?.char_hipdy ?? 1 },
    speed: Number(props?.speed ?? 34),
    yScale: Number(props?.yscale ?? 0.72),
    /* measured off the scene.png about to be written and not asked of base_*, which overstates the hub by 75 percent and puts its centre 62 pixels out */
    /* stated beats measured beats the dropped file's box. paint_set says a person
     * typed the four numbers, which is the case the scan is wrong in. */
    base: stated || paint || {
      w: props?.base_w ?? mapJson?.w ?? 0,
      h: props?.base_h ?? mapJson?.h ?? 0,
      ox: props?.base_ox ?? 0,
      oy: props?.base_oy ?? 0,
    },
    /* provenance rides inside the bundle, because a file that has left the platform cannot be traced back to the press that made it without a database query */
    provenance: { owner: props?.owner_email || '', publishedAt: new Date().toISOString(), version },
    ...(props?.cover_fact ? { coverFact: props.cover_fact } : {}),
    /* routes come from the row so a stale tab cannot republish one somebody moved, and the points stay as pairs because nothing in the game reads `paths` to be right for yet */
    ...(Array.isArray(props?.paths) && props.paths.length
      ? {
          paths: props.paths.map((p) => ({
            name: p.name,
            /* what travels the line, because without it a reader has to guess whether a route over open water is a defect */
            kind: p.kind || 'walk',
            points: p.points,
            closed: !!p.closed,
            twoWay: !!p.twoWay,
            ...(p.facing ? { facing: p.facing } : {}),
            ...(Array.isArray(p.marks) && p.marks.length ? { marks: p.marks } : {}),
            ...(p.meta && Object.keys(p.meta).length ? { meta: p.meta } : {}),
          })),
        }
      : {}),
    /* the shot list is the authoring record and not the camera, which the game only reads off the anchor's meta bag; a shot on raw coordinates has nowhere else to go */
    ...(Array.isArray(props?.framings) && props.framings.length
      ? {
          framings: props.framings.map((f) => ({
            name: f.name,
            ...(f.anchor ? { anchor: f.anchor } : {}),
            ...(f.anchor ? {} : { x: f.x, y: f.y }),
            dx: f.dx ?? 0,
            dy: f.dy ?? 0,
            zoom: Number(f.zoom ?? 1),
            // what the same shot is worth to the game, beside the editor's own
            // view number, so nothing downstream has to work out which unit the
            // field above is in
            gameZoom: shotZoom(f),
            ...(f.entry ? { entry: true } : {}),
            ...(f.meta && Object.keys(f.meta).length ? { meta: f.meta } : {}),
          })),
        }
      : {}),
    /* sets and racks match bundle() in src/core/editor.ts field for field, because the two exporters diverged before and both dropped `placement`; a rack ships slot numbers, which are the address a save means */
    ...(Array.isArray(props?.sets) && props.sets.length
      ? {
          sets: props.sets.map((s) => ({
            name: s.name,
            ...(s.label ? { label: s.label } : {}),
            members: Array.isArray(s.members) ? s.members : [],
            ...(s.meta && Object.keys(s.meta).length ? { meta: s.meta } : {}),
          })),
        }
      : {}),
    ...(Array.isArray(props?.racks) && props.racks.length
      ? {
          racks: props.racks.map((r) => ({
            name: r.name,
            ...(r.label ? { label: r.label } : {}),
            slots: (Array.isArray(r.slots) ? r.slots : []).map((s) => ({
              slot: Number(s.slot),
              anchor: s.anchor,
              ...(s.label ? { label: s.label } : {}),
              ...(s.meta && Object.keys(s.meta).length ? { meta: s.meta } : {}),
            })),
            ...(r.meta && Object.keys(r.meta).length ? { meta: r.meta } : {}),
          })),
        }
      : {}),
    /* the variant list is the authoring record and not the switch, and it carries the labels a person reads, which the projection drops */
    ...(Array.isArray(props?.variants) && props.variants.length
      ? {
          variants: props.variants.map((v) => ({
            name: v.name,
            anchor: v.anchor,
            ...(v.label ? { label: v.label } : {}),
            members: (Array.isArray(v.members) ? v.members : []).map((m) => ({
              name: m.name,
              placement: m.placement,
              ...(m.label ? { label: m.label } : {}),
            })),
            initial: typeof v.initial === 'string' ? v.initial : '',
            ...(v.meta && Object.keys(v.meta).length ? { meta: v.meta } : {}),
          })),
        }
      : {}),
    /* the group rows ship for the re-open, because assets.json already carries the resolved condition and a reopened map would show no group owning any of them */
    ...(Array.isArray(props?.asset_groups) && props.asset_groups.length
      ? { groups: props.asset_groups }
      : {}),
    anchors: anchors.map((a) => ({
      name: a.name,
      kind: a.kind,
      x: a.x,
      y: a.y,
      ...(a.r ? { r: a.r } : {}),
      /* only the live shape ships, because an anchor holds a drawing and a box at once and the game's contains() tests a rect before a radius */
      ...(() => {
        const shape = anchorShape(a)
        if (shape === 'poly') return { poly: a.poly, rect: polyBox(a.poly) }
        if (shape === 'rect') return { rect: a.rect }
        return {}
      })(),
      ...(a.stand ? { stand: a.stand } : {}),
      ...(a.to_slug ? { to: a.to_slug } : {}),
      ...(a.to_anchor ? { toAnchor: a.to_anchor } : {}),
      /* the placement this name is on, which `show` reads as its entire body and which was dropped here for four releases */
      ...(a.placement_id ? { placement: a.placement_id } : {}),
      ...(a.facing ? { facing: a.facing } : {}),
      ...(a.label ? { label: a.label } : {}),
      /* the bag, with every shot hung on this name folded in. See shotsOntoMeta
       * below: the game reads a camera off the anchor and has never had a reader
       * for the framings array above. */
      ...(() => {
        const meta = variantsOntoMeta(props?.variants, a.name, shotsOntoMeta(props?.framings, a.name, a.meta))
        return meta ? { meta } : {}
      })(),
    })),
  }

  /* the gate runs before a single object is written, because a version is immutable and a dead door costs a version number nobody can correct */
  const slugs = (await many('select slug from maps')).map((r) => r.slug)
  /* checked against map.anchors and not the rows, because the rows are snake_case and a gate reading those passes everything on undefined fields */
  const { problems, warnings } = gateMap({
    mapJson: map,
    anchors: map.anchors,
    levels: images?.['levels.png'] ? decodePNG(images['levels.png']) : null,
    slugs,
  })
  for (const a of map.anchors) {
    if (!a.toAnchor || !a.to) continue
    const there = await many(
      'select a.name from anchors a join maps m on m.id = a.map_id where m.slug = $1',
      [a.to],
    )
    if (!there.length) continue // the missing map is already a problem above
    if (there.some((r) => r.name === a.toAnchor)) continue
    const names = there.map((r) => r.name)
    problems.push(
      `the door "${a.name}" arrives at "${a.toAnchor}" on ${a.to}, and nothing there is called that. ` +
        `That map has: ${names.slice(0, 8).join(', ')}${names.length > 8 ? `, and ${names.length - 8} more` : ''}.`,
    )
  }

  /* a set naming a missing anchor is refused, because four steles look exactly like five downstream and the badge on completeness never fires */
  {
    const have = new Set(map.anchors.map((a) => a.name))
    const missing = (names) => [...new Set(names.filter((n) => !have.has(n)))]
    for (const s of map.sets || []) {
      const gone = missing(s.members)
      if (gone.length)
        problems.push(
          `the set "${s.name}" names ${gone.length === 1 ? 'an anchor' : 'anchors'} this map does not have: ` +
            `${gone.join(', ')}. Either add ${gone.length === 1 ? 'it' : 'them'} or take ` +
            `${gone.length === 1 ? 'it' : 'them'} out of the set.`,
        )
    }
    /* a variant is checked against the placements and its own anchor, because a wrong placement name reads as the state not working and a wrong anchor lands the set in no bag at all */
    const named = new Set(
      (assetsJson?.assets || []).map((a) => a && a.name).filter((n) => typeof n === 'string' && n),
    )
    for (const v of map.variants || []) {
      if (!have.has(v.anchor))
        problems.push(
          `the variant set "${v.name}" hangs on the anchor "${v.anchor}", and this map has no anchor called that. ` +
            `A set is addressed through its anchor, so this one would ship where nothing can reach it.`,
        )
      const lost = [...new Set(v.members.map((m) => m.placement).filter((n) => !named.has(n)))]
      if (lost.length)
        problems.push(
          `the variant set "${v.name}" names ${lost.length === 1 ? 'a placement' : 'placements'} this map does not have: ` +
            `${lost.join(', ')}. Either name the placement in the editor or take ` +
            `${lost.length === 1 ? 'it' : 'them'} out of the set.`,
        )
      if (v.initial && !v.members.some((m) => m.name === v.initial))
        problems.push(
          `the variant set "${v.name}" opens on the state "${v.initial}" and has no member called that, ` +
            `so the map would open with nothing showing there.`,
        )
    }
    for (const r of map.racks || []) {
      const gone = missing(r.slots.map((s) => s.anchor))
      if (gone.length) {
        // the slot NUMBER is named beside the anchor, because that is the address
        // the author is holding: "slot 3 is empty" is actionable, "the rack is
        // broken" is not
        const where = r.slots.filter((s) => gone.includes(s.anchor)).map((s) => `slot ${s.slot} · ${s.anchor}`)
        problems.push(
          `the rack "${r.name}" has ${where.length === 1 ? 'a slot' : 'slots'} on ${where.length === 1 ? 'an anchor' : 'anchors'} ` +
            `this map does not have: ${where.join(', ')}.`,
        )
      }
    }
  }
  if (problems.length)
    throw new Error(
      `${slug} was not published, and nothing was written. ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n` +
        problems.map((p) => '  · ' + p).join('\n'),
    )
  // a warning is a fact the author should have, not a reason to refuse: a door
  // to a room nobody has painted yet is the Maw's own design
  for (const w of warnings) console.warn(`[publish] ${slug}: ${w}`)
  step('gate passed')

  /* the assets/ prefix is normalised here at the boundary, because the two publishers disagreed and one wrote 794 objects a folder shallower than its own manifest */
  const inAssets = (k) => 'assets/' + String(k).replace(/^\/+/, '').replace(/^assets\//, '')
  const all = new Map([...files].map(([k, v]) => [inAssets(k), v]))

  /* every frame packs into one sheet, because 800 loose pngs emptied a 2,500-a-day allowance in three page loads and packed a map is five requests */
  let packed = null
  if (files.size) {
    /* the index is keyed the way assets.json asks, normalised rather than prefixed, because either mismatch makes every frame miss and fall back to a loose file while reporting success */
    // the same normalisation `all` was built with above, so the index and the
    // objects can no longer be keyed differently from one another
    packed = packAtlas(new Map([...files].map(([k, v]) => [inAssets(k), v])))
    if (packed) {
      all.set('atlas.png', packed.png)
      all.set('atlas.json', Buffer.from(JSON.stringify(packed.index)))
    }
    step(`atlas packed, ${packed ? packed.count : 0} frames`)
  }

  for (const [name, buf] of Object.entries(images)) if (buf) all.set(name, buf)
  all.set('map.json', Buffer.from(JSON.stringify(map, null, 2)))
  /* measured here rather than in the export route, so all three publishers get footprints without knowing they exist */
  // off the map that is shipping, which is the row, so a footprint is squashed
  // by the same number the bundle tells the game to squash distance by
  const placed = footprints(assetsJson.assets || [], files, map.yScale > 0 ? map.yScale : 0.72)
  const feet = placed.filter((a) => a && a.foot).length
  const solid = placed.filter((a) => a && a.foot && a.foot[2] > 0).length
  // kept, because the cost measured at the bottom has to read the array that
  // actually shipped rather than the one it was built from
  const atlased = packed ? atlasify(placed, packed.index) : null
  all.set(
    'assets.json',
    Buffer.from(
      JSON.stringify(
        { ...assetsJson, ...(packed ? { atlas: 'atlas.png' } : {}), assets: atlased || placed },
        null,
        2,
      ),
    ),
  )

  /* twelve lanes, because 1,383 objects one at a time measured 260 seconds against a 300 second maxDuration; the manifest is assembled afterwards by index so lane order cannot reshuffle it */
  const entries = [...all]
  step(`${entries.length} object(s) to write`)
  const wrote = new Array(entries.length)
  const LANES = 12
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(LANES, entries.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= entries.length) return
        const [rel, buf] = entries[i]
        /* the retry lives here and not in the client, whose maxAttempts:1 is right, because ten of 1,383 objects vanished to transient resets at twelve in flight */
        let err = null
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await s.put(prefix + rel, buf, rel.endsWith('.json') ? 'application/json' : 'image/png')
            err = null
            break
          } catch (e) {
            err = e
            if (attempt < 2) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)))
          }
        }
        // rethrown rather than counted, so a publish that lost an object cannot
        // reach the insert below
        if (err) throw err
        wrote[i] = { bytes: buf.length, sha256: sha(buf) }
      }
    }),
  )
  step('all objects written')
  let bytes = 0
  const manifest = {}
  for (let i = 0; i < entries.length; i++) {
    manifest[entries[i][0]] = wrote[i]
    bytes += wrote[i].bytes
  }

  /* the bucket is listed back before the row is written, because a row is a claim that a version can be fetched and ten of thirteen once pointed at empty prefixes */
  const have = new Set((await s.list(prefix)).map((o) => String(o.key || o)))
  step('bucket listed back')
  const missing = Object.keys(manifest).filter((rel) => !have.has(prefix + rel))
  if (missing.length)
    throw new Error(
      `${slug} v${version}: ${missing.length} of ${entries.length} object(s) are not in the bucket after being written, ` +
        `starting with ${prefix}${missing[0]}. No publish row was recorded, so the game keeps reading the last version ` +
        `that is really there. The objects that did land are harmless and the next export overwrites them.`,
    )

  await q(
    `insert into publishes (map_id, version, blob_prefix, manifest, bytes, published_by)
     values ($1, $2, $3, $4::jsonb, $5, (select owner_id from maps where id = $1))`,
    [m.id, version, prefix, JSON.stringify(manifest), bytes],
  )
  // publishing IS working on a map, so the dashboard should say so. Without
  // this the home page kept leading with whichever map happened to be saved
  // last, while the one just re-exported sat further down the grid.
  await q('update maps set updated_at = now() where id = $1', [m.id])
  /* the painted extent lands in its own columns and never over base_*, which getDoc round-trips and which re-grows a map on reload */
  // never over a stated extent: paint_set means a person corrected the scan
  if (paint && !props?.paint_set)
    await q('update maps set paint_w = $2, paint_h = $3, paint_ox = $4, paint_oy = $5 where id = $1', [
      m.id,
      paint.w,
      paint.h,
      paint.ox,
      paint.oy,
    ])

  /* the cost of opening the map is said out loud every publish, six being the floor, because an atlas that fails to match falls back and still works */
  /* measured on the array that shipped, because atlasify returns new objects and filtering the pre-atlas one made the warning fire every time */
  const loose = atlased
    ? atlased.filter((a) => !a.srcAt && !a.framesAt && !a.dirsAt).length
    : placed.length
  const cost = 6 + loose
  if (loose)
    console.warn(
      `[publish] ${slug} v${version}: ${loose} placement(s) missed the atlas, so opening this map costs about ${cost} requests`,
    )
  else console.log(`[publish] ${slug} v${version}: opening this map costs 6 requests`)
  /* said out loud because a bundle with no footprints still loads and walks the old way, so 0 on a map with placements means the frames did not come through */
  if (placed.length)
    console.log(
      `[publish] ${slug} v${version}: ${feet} of ${placed.length} placement(s) measured a footprint, ${solid} of them solid`,
    )

  return {
    version,
    prefix,
    files: [...all.keys()],
    bytes,
    anchors: anchors.length,
    atlas: packed ? { frames: packed.count, w: packed.index.w, h: packed.index.h } : null,
  }
}

// What the game asks for. Version defaults to the newest, which is what
// "re-exporting updates that map in the game" means in practice, but a build
// can pin one and never be surprised.
export async function publishedMap(slug, version) {
  const row = await one(
    version
      ? `select p.*, m.slug from publishes p join maps m on m.id = p.map_id where m.slug = $1 and p.version = $2`
      : `select p.*, m.slug from publishes p join maps m on m.id = p.map_id where m.slug = $1
         order by p.version desc limit 1`,
    version ? [slug, Number(version)] : [slug],
  )
  return row || null
}

export const publishHistory = (slug) =>
  many(
    `select p.version, p.bytes, p.published_at from publishes p join maps m on m.id = p.map_id
     where m.slug = $1 order by p.version desc`,
    [slug],
  )
