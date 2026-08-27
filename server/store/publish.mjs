// Export is a save, not a finish line.
//
// Ash, 2026-08-23: maps live in a database, any map can be reopened and edited
// at any time, and re-exporting updates that map in the game. So export and
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

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

// Everything the game fetches, written under one version prefix.
//
// files is a Map of relative path inside the bundle -> Buffer, exactly the
// shape the export route already builds for the assets folder, so the caller
// hands over what it was going to write to disk anyway.
export async function publishBundle(slug, { mapJson, assetsJson, images, files }) {
  const m = await one('select id from maps where slug = $1', [slug])
  if (!m) throw new Error(`no map ${slug}`)

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
    `select name, kind, x, y, r, rect, to_slug, to_anchor, placement_id, facing, label, meta
     from anchors where map_id = $1 order by kind, name`,
    [m.id],
  )
  const map = {
    ...mapJson,
    contract: 2,
    slug,
    version,
    anchors: anchors.map((a) => ({
      name: a.name,
      kind: a.kind,
      x: a.x,
      y: a.y,
      ...(a.r ? { r: a.r } : {}),
      ...(a.rect ? { rect: a.rect } : {}),
      ...(a.to_slug ? { to: a.to_slug } : {}),
      ...(a.to_anchor ? { toAnchor: a.to_anchor } : {}),
      ...(a.facing ? { facing: a.facing } : {}),
      ...(a.label ? { label: a.label } : {}),
      ...(a.meta && Object.keys(a.meta).length ? { meta: a.meta } : {}),
    })),
  }

  const all = new Map(files)

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
     * like it worked because the fallback works. */
    packed = packAtlas(new Map([...files].map(([k, v]) => ['assets/' + k, v])))
    if (packed) {
      all.set('atlas.png', packed.png)
      all.set('atlas.json', Buffer.from(JSON.stringify(packed.index)))
    }
  }

  for (const [name, buf] of Object.entries(images)) if (buf) all.set(name, buf)
  all.set('map.json', Buffer.from(JSON.stringify(map, null, 2)))
  all.set(
    'assets.json',
    Buffer.from(
      JSON.stringify(
        packed
          ? { ...assetsJson, atlas: 'atlas.png', assets: atlasify(assetsJson.assets || [], packed.index) }
          : assetsJson,
        null,
        2,
      ),
    ),
  )

  let bytes = 0
  const manifest = {}
  for (const [rel, buf] of all) {
    await s.put(prefix + rel, buf, rel.endsWith('.json') ? 'application/json' : 'image/png')
    manifest[rel] = { bytes: buf.length, sha256: sha(buf) }
    bytes += buf.length
  }

  await q(
    `insert into publishes (map_id, version, blob_prefix, manifest, bytes, published_by)
     values ($1, $2, $3, $4::jsonb, $5, (select owner_id from maps where id = $1))`,
    [m.id, version, prefix, JSON.stringify(manifest), bytes],
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
