// Export is a save, not a finish line.
//
// Maps live in a database, any map can be reopened and edited at any time, and re-exporting updates that map in the game. So export and
// publish are not two acts. Pressing export writes an immutable version into
// object storage and records it, and the game reads whichever version it asks
// for.
//
// Immutable is the important half. Version N's bytes live at publish/<slug>/vN/
// forever and nothing ever rewrites them, which means:
//   - re-exporting can never break a class that is mid-session
//   - a game build can pin a version it was tested against
//   - every byte can be cached forever by a cdn, so the free tier's read
//     allowance is never touched twice for the same file
import crypto from 'node:crypto'
import { q, one, many, tx } from '../db/pool.mjs'
import { store, keys } from './blobs.mjs'
import { packAtlas, atlasify } from './atlas.mjs'
import { gateMap } from './gate.mjs'
import { decodePNG } from '../sheet.mjs'

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

/* WHAT A PLACEMENT STANDS ON, MEASURED OFF ITS OWN ART.
 *
 * A published placement used to carry no collision shape at all, so the walk
 * page invented one: a circle of radius 3 at the anchor, the same for a barrel
 * and for a market stall. That is wrong in both directions at once. A 26px stall
 * blocked a 3px dot and you walked through the rest of it, while on a quay two
 * or three pixels across the same dot was a fence. The comment in Walk.tsx that
 * held the hard test switched off said exactly this: "a building's collision is
 * its footprint, not a circle at its anchor".
 *
 * So the footprint is measured here, once, at publish, where the png bytes are
 * already in hand and nothing has to be decoded in a game loop. It ships as
 * `foot: [ox, oy, rx, ry]`, an ellipse in painting pixels relative to the
 * placement's anchor. Optional on purpose: a bundle published before this
 * existed has no `foot` and a reader that has never heard of one ignores it, so
 * both sides stay backward compatible.
 *
 * THE CONTACT BAND, NOT THE WHOLE SPRITE. Only the bottom few rows of drawn
 * pixels touch the ground. That is what makes a tree a trunk you walk into and a
 * canopy you walk under, and it is why this is not editor.ts's bodyRadius, which
 * is 0.6 of the WHOLE ink width and belongs to a different job: that number
 * sizes the keep-out circle two figures shove each other out of, tuned over
 * 30000 frames for how a crowd looks. This one answers where the ground is
 * solid. Do not unify them.
 *
 * THE ANCHOR IS THE FRONT OF THE BASE, NOT ITS MIDDLE. A placement is drawn with
 * the bottom edge of its frame on the anchor, so the pixels where the object
 * meets the floor are the near edge of its base and the base itself runs away
 * from the camera, up the screen. The ellipse is therefore pushed up by its own
 * ry so its near rim sits on the drawn feet.
 *
 * ry COMES FROM rx, BECAUSE THE GROUND IS SQUASHED. A base that reads 2rx across
 * the screen is 2*rx*yScale deep up it, which is the same squash bodyAt and
 * separate already measure distance in. Taking ry from the band's own few rows
 * instead would give every object a flat sliver you could stand behind while
 * standing inside it.
 */
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
  /* a rotated frame is not measured again, it is covered: the axis-aligned box
   * around the turned ellipse. 13 of the hub's 94 placements carry a rotation
   * and all of them are small, so a few tenths of a pixel of slack is cheaper
   * than a second geometry nobody can check. */
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

/* Every placement gets its footprint attached, movers included: it is a
 * measurement of the art rather than a permission to block, and the reader stays
 * the one that decides who is solid.
 *
 * An EFFECT is exempt and gets a zero footprint. Smoke, a waterfall, a water
 * wash across the sand, a lighthouse sweep and the glow over a door are drawn
 * over the ground rather than standing on it, and there are 19 of them on the
 * hub. Reading their contact band would put an 86px wall across the beach. */
export function footprints(assets, files, yScale) {
  const seen = new Map()
  return assets.map((a) => {
    if (!a || typeof a !== 'object') return a
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

/* A PUBLISHED FILE NEVER CHANGES, SO IT SHOULD BE FETCHED ONCE.
 *
 * publish/<slug>/v<N>/ is immutable by design, which means the second read of
 * any file in it is guaranteed to return exactly what the first one did. Going
 * back to the bucket for it is a transaction spent to learn nothing.
 *
 * That matters because the free tier allows 2,500 downloads a day and a day of
 * building blew through it: every reload of a map page, every walk test, every
 * dashboard thumbnail was a fresh read of bytes the server had already seen.
 *
 * Small files only, and a bounded number of them. map.json and atlas.json are
 * what get asked for over and over; scene.png and the atlas sheet are hundreds
 * of kilobytes and belong to the browser's cache, not this one. */
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
  /* THE COUNTER HAS TO FORGET WHAT IT IS REPLACING.
   *
   * hotBytes was added to on every put and only subtracted from on eviction, so
   * a key put twice had its bytes counted twice while the Map held one copy.
   * The caller guards with hotGet first, but two requests for the same published
   * file both miss and both put, which is ordinary rather than rare.
   *
   * Measured on that shape, 60 files of 100 KB each put twice, comfortably
   * inside a 200 entry 8 MB cache: the old counter reached 8,294,400 bytes while
   * really holding 2,150,400, so 6.1 MB of the ceiling was spent on bytes that
   * were not there, and the cache kept 21 of the 60 files instead of all of
   * them. The drift never comes back, because evicting an entry only refunds
   * what the Map is holding under it. So the count pins itself just under the
   * ceiling and stays there, and from then on almost every put is evicted
   * immediately and almost every read goes back to the bucket. That is the
   * 2,500-a-day transaction burn this cache was written to stop, arriving
   * silently and looking exactly like a working cache. With the subtraction it
   * holds 60 of 60 with zero drift.
   *
   * Deleted before being re-set rather than just adjusted, so a re-put also
   * counts as a touch and moves the key to the fresh end. */
  const prev = hot.get(key)
  if (prev) {
    hot.delete(key)
    hotBytes -= prev.length
  }
  hot.set(key, buf)
  hotBytes += buf.length
  /* `hot.size &&` because entries().next().value on an empty Map is undefined
   * and destructuring undefined throws, which would turn every later read in
   * this process into a 500 until a cold start. The eviction above happens to
   * refund enough to stop just short of that, so it is a guard rather than a
   * fix for something reproduced, but the loop must not be one accounting
   * change away from taking the process out. */
  while (hot.size && (hot.size > HOT_MAX || hotBytes > HOT_BYTES)) {
    const [k, v] = hot.entries().next().value
    hot.delete(k)
    hotBytes -= v.length
  }
  return buf
}

// Everything the game fetches, written under one version prefix.
//
// files is a Map of relative path inside the bundle -> Buffer, exactly the
// shape the export route already builds for the assets folder, so the caller
// hands over what it was going to write to disk anyway.
/* A FREE TIER THAT BILLS INSTEAD OF STOPPING NEEDS THE STOP PUT BACK.
 *
 * Backblaze refused to serve once the daily allowance was gone. That broke the
 * site and never cost a penny. R2 does the opposite: it keeps working and
 * charges for the overage, and Cloudflare has no hard spend cap to switch on.
 * So the ceiling has to live here, in the code.
 *
 * Publishing is the only thing that writes objects in bulk, about 950 an
 * export, and writes are the class with the smallest monthly allowance. This
 * counts what this month's publishes already wrote, straight off their
 * manifests, and refuses the export that would cross the line instead of
 * letting it through and being invoiced for it.
 *
 * Set well under the real limit so the refusal comes with room to spare. */
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

  // The anchors go in from the database rather than from whatever the client
  // sent, because the anchors table is the contract and the document's events
  // array is the older shape. Both ship: anchors[] is what the api and python
  // will read, events[] is what the game reads today, and writing both means no
  // bundle that works now stops working.
  const anchors = await many(
    `select name, kind, x, y, r, rect, stand, to_slug, to_anchor, placement_id, facing, label, meta
     from anchors where map_id = $1 order by kind, name`,
    [m.id],
  )
  /* WHAT THE MAP CALLS ITSELF AND WHAT IT IS, which the bundle has never
   * carried. title is a real column, is written as the slug at creation, is
   * read by the dashboard, and died here: publishBundle never selected it, so
   * every named place a student reads is a slug or a string hand-typed in the
   * game repo. class is the same story from the other end, a fact MAPVIS knows
   * and never said, so the engine guesses it from the border on every map. */
  const props = await one(
    `select title, class, island_id, meta, char_h, char_hip, char_hipdy, speed, yscale, step_tol,
            base_w, base_h, base_ox, base_oy, paths, framings
     from maps where id = $1`,
    [m.id],
  )
  const map = {
    ...mapJson,
    contract: 2,
    slug,
    version,
    ...(props?.title ? { title: props.title } : {}),
    ...(props?.class ? { class: props.class } : {}),
    ...(props?.island_id ? { islandId: props.island_id } : {}),
    ...(props?.meta && Object.keys(props.meta).length ? { meta: props.meta } : {}),
    /* THE WALK CONTRACT FROM THE ROW, not from whatever the browser sent.
     * Same reason the anchors come from the table: the row is the contract and
     * it is the one an author can set out of band, and a stale tab must not be
     * able to publish an 18 px character over a map that was set to 36. */
    encoding: { ...(mapJson?.encoding || {}), stepTolerance: props?.step_tol ?? 10 },
    character: { heightPx: props?.char_h ?? 18, hip: props?.char_hip ?? 2, hipDY: props?.char_hipdy ?? 1 },
    speed: Number(props?.speed ?? 34),
    yScale: Number(props?.yscale ?? 0.72),
    /* THE PAINTING'S OWN SIZE, which is not the canvas's. growCanvas buys room
     * in transparent margin, so a discovery radius taken off h is wrong by
     * about 41 percent on the hub, early rather than late. Four columns that
     * have existed since the first schema and never left the database. */
    base: {
      w: props?.base_w ?? mapJson?.w ?? 0,
      h: props?.base_h ?? mapJson?.h ?? 0,
      ox: props?.base_ox ?? 0,
      oy: props?.base_oy ?? 0,
    },
    /* ROUTES AND SHOTS FROM THE ROW, for the same reason the walk contract and
     * the anchors come from it: a stale tab must not be able to republish a
     * route somebody moved four seconds ago. Absent when empty, so a bundle
     * from before they existed does not grow two empty arrays. */
    ...(Array.isArray(props?.paths) && props.paths.length
      ? {
          paths: props.paths.map((p) => ({
            name: p.name,
            points: p.points,
            closed: !!p.closed,
            twoWay: !!p.twoWay,
            ...(p.facing ? { facing: p.facing } : {}),
            ...(Array.isArray(p.marks) && p.marks.length ? { marks: p.marks } : {}),
            ...(p.meta && Object.keys(p.meta).length ? { meta: p.meta } : {}),
          })),
        }
      : {}),
    ...(Array.isArray(props?.framings) && props.framings.length
      ? {
          framings: props.framings.map((f) => ({
            name: f.name,
            ...(f.anchor ? { anchor: f.anchor } : {}),
            ...(f.anchor ? {} : { x: f.x, y: f.y }),
            dx: f.dx ?? 0,
            dy: f.dy ?? 0,
            zoom: Number(f.zoom ?? 1),
            ...(f.entry ? { entry: true } : {}),
            ...(f.meta && Object.keys(f.meta).length ? { meta: f.meta } : {}),
          })),
        }
      : {}),
    anchors: anchors.map((a) => ({
      name: a.name,
      kind: a.kind,
      x: a.x,
      y: a.y,
      ...(a.r ? { r: a.r } : {}),
      ...(a.rect ? { rect: a.rect } : {}),
      ...(a.stand ? { stand: a.stand } : {}),
      ...(a.to_slug ? { to: a.to_slug } : {}),
      ...(a.to_anchor ? { toAnchor: a.to_anchor } : {}),
      /* the placement this name is on. Selected above and then dropped here,
       * which is the last of the four places the field died between the anchor
       * form and the game. `show` reads it as its entire body, so until this
       * line existed one of the fifteen intents could not fire on any bundle
       * MAPVIS was capable of producing. */
      ...(a.placement_id ? { placement: a.placement_id } : {}),
      ...(a.facing ? { facing: a.facing } : {}),
      ...(a.label ? { label: a.label } : {}),
      ...(a.meta && Object.keys(a.meta).length ? { meta: a.meta } : {}),
    })),
  }

  /* THE GATE, BEFORE A SINGLE OBJECT IS WRITTEN.
   *
   * A version is immutable: its bytes live at a version-scoped prefix forever
   * and nothing rewrites them. So refusing costs a retry and publishing a map
   * with a dead door costs a version number nobody can correct. Every check
   * below already existed somewhere — as a CLI nobody remembers to run, as a
   * button in the editor that writes nothing, or as a hardcoded list in the
   * game repo — and none of them ran here.
   *
   * `to` is checked against the registry, which is one query away and has never
   * been consulted: the hub's one door has pointed at a map that does not exist
   * since the day it was placed. `toAnchor` needs the far map's anchor list, so
   * it is asked for here rather than inside the gate, which has no database. */
  const slugs = (await many('select slug from maps')).map((r) => r.slug)
  /* checked against `map.anchors` and not against the rows they came from,
   * because that array IS what is about to ship. The rows are snake_case and
   * the bundle is camelCase, and a gate reading the wrong one of those passes
   * everything by looking at fields that are always undefined. */
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
  if (problems.length)
    throw new Error(
      `${slug} was not published, and nothing was written. ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n` +
        problems.map((p) => '  · ' + p).join('\n'),
    )
  // a warning is a fact the author should have, not a reason to refuse: a door
  // to a room nobody has painted yet is the Maw's own design
  for (const w of warnings) console.warn(`[publish] ${slug}: ${w}`)
  step('gate passed')

  /* ONE LAYOUT, DECIDED HERE, NOT BY WHICHEVER CALLER TURNED UP.
   *
   * The two publishers disagreed about whether the assets/ folder is part of a
   * key. publish-work.mjs walks the folder and includes it; the export route
   * sets bare keys and then writes an assets.json pointing at "assets/...". So
   * a map published from the export BUTTON wrote its 794 objects one folder
   * shallower than its own manifest said, and every loose asset fetch 404'd.
   * Measured: hub v3, published that way, has 0 of 794 png keys prefixed, while
   * v4 and v5 from the command line have 794 of 794. The atlas hid it, because
   * an atlas reader never asks for the loose file, so the export reported
   * success and even logged that the map cost six requests.
   *
   * The prefix was already normalised, but only for the atlas index a few lines
   * down. Doing it once here, at the boundary, makes the caller's convention
   * irrelevant, which is the only version of this that stays fixed. It also
   * stops a library item named "scene" writing scene.png and being overwritten
   * by the map painting. */
  const inAssets = (k) => 'assets/' + String(k).replace(/^\/+/, '').replace(/^assets\//, '')
  const all = new Map([...files].map(([k, v]) => [inAssets(k), v]))

  /* EVERY FRAME PACKED INTO ONE SHEET.
   *
   * The hub publishes 800 pngs, and opening it once cost 800 downloads, which
   * emptied Backblaze's 2,500-a-day free allowance in three page loads. Packed,
   * a map is five requests. Nothing is resampled and nothing is re-encoded
   * lossily; the frames come back out at exactly the size they went in.
   *
   * The loose pngs still ship alongside. Storage is not the constraint,
   * transactions are, and keeping them means a reader written before this
   * existed is untouched. */
  let packed = null
  if (files.size) {
    /* KEYED THE WAY THE PLACEMENTS ASK FOR THEM.
     *
     * files is keyed by path inside assets/ ("gull/0.png") while every url in
     * assets.json carries the folder ("assets/gull/0.png"). Packing the raw
     * keys built an index nothing could look itself up in, so every frame
     * missed, fell back to a loose file, and the atlas shipped as 333 KB of
     * dead weight beside the 794 downloads it was written to prevent. It looked
     * like it worked because the fallback works.
     *
     * NORMALISED RATHER THAN PREFIXED, because the two callers disagreed. The
     * export route passes bare keys ("gull/0.png") and publish-work.mjs walks
     * the folder passing them already prefixed ("assets/gull/0.png"), so adding
     * the folder unconditionally produced "assets/assets/gull/0.png" for every
     * frame the command-line publisher handed over. Nothing matched, all 94
     * placements shipped loose, and the bundle cost 800 requests to open while
     * reporting success. Stripping first means the caller's convention stops
     * mattering, which is the only version of this that stays fixed. */
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
  /* the collision shape of every placement, measured off the art on the way
   * through. It happens here rather than in the export route so that all three
   * publishers get it: the editor's export, publish-work.mjs and reexport.mjs
   * all end up in this function and none of them has to know footprints exist.
   * yScale comes off the map because the squash is per map. */
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

  /* WRITTEN IN LANES, BECAUSE 801 OBJECTS ONE AT A TIME DOES NOT FIT THE FUNCTION.
   *
   * Every put also awaits a Postgres upsert into blob_shas through the write
   * hook in blobs.mjs, so publishing the hub sequentially is about 1,600 round
   * trips inside a function whose maxDuration is 300 seconds. hydrateMap already
   * measured this exact shape on the read side: 1,383 objects one at a time took
   * 260 seconds, which is not a margin but a coin toss, and twelve lanes made it
   * roughly a twentieth of the wall clock for the same number of requests.
   * Twelve here for the same reason, and it stays well under the ceiling the
   * meter enforces.
   *
   * The manifest is assembled afterwards out of an array indexed by position,
   * never from inside a lane. That keeps it complete and keeps its key order
   * equal to the order of `all` however the lanes interleave, so two publishes
   * of the same bundle produce the same jsonb rather than the same set shuffled. */
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
        /* RETRIED, BECAUSE THE CLIENT IS DELIBERATELY MAXATTEMPTS:1.
         *
         * That setting is right for its own reason, which is that a capped
         * bucket's refusal is an answer and retrying it just makes the export
         * outlive the browser. But hydrateMap measured ten of 1,383 objects
         * vanishing to transient resets once twelve were in flight at once, and
         * a put lost that way is a file missing from a bundle that reported
         * success. The retry therefore lives here, over a bulk copy that can
         * afford the wait, rather than in the client. */
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

  /* A PUBLISH ROW MUST NOT OUTLIVE ITS BYTES.
   *
   * Measured on 2026-08-27: ten of the thirteen rows in publishes pointed at
   * prefixes holding nothing at all. hub v1 to v3 and every site-* row were
   * written against a bucket that has since been left behind, and nothing ever
   * noticed, because the row is what /api/v1/maps reads. It advertised seven
   * maps as published and all seven answered 503 when the game went for the
   * bytes. A row is a claim that a version can be fetched, and the moment before
   * making the claim is the only honest place to check it.
   *
   * Listed back from the bucket rather than counted out of the put loop above,
   * because the puts are the thing being doubted: an object lost to a reset, a
   * prefix written one folder off and a bucket quietly refusing all look
   * identical from this side of the call. One listing costs one class A
   * operation per thousand keys, against the 801 writes it is checking. */
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

  /* A PUBLISH THAT WOULD COST HUNDREDS OF REQUESTS TO OPEN IS A BUG.
   *
   * The hub shipped 800 loose pngs, and opening it three times emptied a free
   * tier's entire daily download allowance. The atlas fixes that structurally,
   * but an atlas that silently fails to match also 'works' by falling back to
   * exactly the thing it was written to prevent, which is how it hid for a
   * whole day.
   *
   * So the cost of opening this map is measured here, at publish, every time,
   * and said out loud. Six is the floor: map.json, scene, levels, assets.json,
   * atlas.png, atlas.json. If this number is ever in the hundreds again,
   * something regressed and the log says so before anybody's bucket does. */
  /* MEASURE THE ARRAY THAT SHIPPED, NOT THE ONE IT CAME FROM.
   *
   * atlasify returns new objects rather than mutating in place, so filtering
   * assetsJson.assets asked the pre-atlas array whether it had atlas fields.
   * It never does. loose therefore always equalled the full placement count and
   * the warning always fired, which made the one tripwire guarding this
   * unreadable: it cried wolf on a good bundle and on a broken one alike. */
  const loose = atlased
    ? atlased.filter((a) => !a.srcAt && !a.framesAt && !a.dirsAt).length
    : placed.length
  const cost = 6 + loose
  if (loose)
    console.warn(
      `[publish] ${slug} v${version}: ${loose} placement(s) missed the atlas, so opening this map costs about ${cost} requests`,
    )
  else console.log(`[publish] ${slug} v${version}: opening this map costs 6 requests`)
  /* said out loud for the same reason the atlas cost is: a bundle where nothing
   * measured a footprint still loads and still walks, it just walks the old way,
   * and that is exactly the kind of silent fallback the atlas hid behind for a
   * day. If this is 0 on a map with placements, the frames did not come through. */
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
