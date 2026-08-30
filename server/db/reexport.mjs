// Re-pack a map's placements from doc.json and publish a new version.
//
//   node server/db/reexport.mjs hub
//
// The export writer had a bug: it set every view-set placement's resting
// picture to the SOUTH heading, throwing away the facing the author chose. The
// fix is in api.mjs, but a fix in the writer does nothing to a bundle that has
// already been written, and the wrong data is baked into work/<id>/assets.json.
//
// doc.json is the source of truth and was never damaged, so this reads the
// placements back out of it, packs them the corrected way, and publishes. Export
// is a save, not a finish line, which is exactly what makes this recoverable.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb } from './pool.mjs'
import { publishBundle, orderedHeadings } from '../store/publish.mjs'
import { isPlacementName, isAnchorName } from '../store/crypto.mjs'

// a round is at most this many states and each can name one picture that is not
// look 0, which is the same cap the export route packs to
const STATES_MAX = 6

/* WHOSE CONDITION A PLACEMENT SHIPS UNDER. editor.ts bundle() resolves this
 * against the map's group rows because that is the side holding them, and
 * nothing downstream recomputes it, so a re-export that read only the placement
 * turned every conditional placement unconditional. Restated here rather than
 * imported, because that resolver is browser TypeScript and this is node. */
const whenOf = (a, groups) => {
  const own = typeof a.when === 'string' ? a.when.trim() : ''
  if (own) return own
  const g = (groups || []).find((x) => x && x.name === a.group)
  return g && typeof g.when === 'string' ? g.when.trim() : ''
}

const WORK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'work')
const slug = process.argv[2]
if (!slug) throw new Error('usage: node server/db/reexport.mjs <slug>')

const dir = path.join(WORK, slug)
const doc = JSON.parse(fs.readFileSync(path.join(dir, 'doc.json'), 'utf8'))
const mapJson = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'))

/* /work/<id>/library/<name>/<heading>/<i>.png -> the file on disk */
const resolve = (u) => {
  const m = String(u || '').match(/^\/work\/[^/]+\/(.+)$/)
  if (!m) return null
  const f = path.join(dir, ...m[1].split('/').map(decodeURIComponent))
  return fs.existsSync(f) ? f : null
}

const files = new Map()
const named = new Map()
const uniq = (abs, want, ext) => {
  const had = named.get(abs)
  if (had) return had
  const used = new Set(named.values())
  let n = want + ext
  for (let i = 2; used.has(n); i++) n = `${want}-${i}${ext}`
  named.set(abs, n)
  return n
}

let turned = 0
const pack = (s) => {
  if (!s || typeof s !== 'object') return null

  if (s.dirs && Object.keys(s.dirs).length) {
    const outDirs = {}
    let metaFile = ''
    /* THE COMPOUND HEADINGS FIRST, the same order and the same one list the
     * export route packs in. Two publishers disagreeing about key order are two
     * bundles that face different ways, which is what this file exists to
     * repair, so the order is not restated here. */
    for (const k of orderedHeadings(Object.keys(s.dirs))) {
      const arr = s.dirs[k]
      if (!Array.isArray(arr) || !arr[0]) continue
      const out = []
      for (const u of arr) {
        const abs = resolve(u)
        if (!abs) break
        const srcDir = path.dirname(abs)
        const rel = uniq(srcDir, path.basename(srcDir), '') + '/' + path.basename(abs)
        files.set(rel, fs.readFileSync(abs))
        out.push('assets/' + rel)
        if (!metaFile) metaFile = path.join(srcDir, 'dirs.json')
      }
      if (out.length) outDirs[k] = out
    }
    if (!Object.keys(outDirs).length) return null

    let fps = Number(s.fps) > 0 ? Math.round(Number(s.fps)) : 8
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      if (Number(meta.fps) > 0) fps = Math.round(Number(meta.fps))
    } catch {}

    // THE HEADING THE AUTHOR PICKED, read back off the placement's own src
    const wanted = String(s.src || '')
    let rest = ''
    for (const [k, arr] of Object.entries(s.dirs))
      if (Array.isArray(arr) && arr.some((u) => String(u) === wanted)) {
        rest = k
        break
      }
    if (rest && rest !== 'south') turned++
    const set = (rest && outDirs[rest]) || outDirs.south || Object.values(outDirs)[0]
    return { dirs: outDirs, src: set[0], facing: rest || 'south', fps }
  }

  if (Array.isArray(s.frames) && s.frames.length) {
    const out = []
    for (const u of s.frames) {
      const abs = resolve(u)
      if (!abs) break
      const srcDir = path.dirname(abs)
      const rel = uniq(srcDir, path.basename(srcDir), '') + '/' + path.basename(abs)
      files.set(rel, fs.readFileSync(abs))
      out.push('assets/' + rel)
    }
    return out.length ? { frames: out, fps: Number(s.fps) > 0 ? Math.round(Number(s.fps)) : 6 } : null
  }

  const abs = resolve(s.src)
  if (!abs) return null
  const rel = uniq(abs, path.basename(abs, '.png'), '.png')
  files.set(rel, fs.readFileSync(abs))
  return { src: 'assets/' + rel }
}

const out = []
for (const a of doc.assets || []) {
  const look0 = pack(a)
  if (!look0) continue
  const looks = (a.looks || []).map(pack).map((l, i) => l || (i === 0 ? look0 : null))
  /* THREE FIELDS THIS PUBLISHER USED TO DROP, and the export route writes all
   * three, so a re-export silently produced a poorer bundle than the button did.
   *
   * `name` is the only address anything outside the map holds: PmapScene keys
   * every placement by both its MAPVIS id and its author name, and an anchor's
   * `placement` resolves through that map, so losing it kills every
   * anchor-to-placement binding made by name. `when` is the resolved group
   * condition and nothing downstream recomputes it, so losing it turns every
   * conditional placement unconditional. `lookNames` is the vocabulary
   * show(placement, state) selects from. All three fail invisibly until a grape
   * misses. This file exists because a writer bug baked wrong data into a
   * bundle, and it was baking in three missing fields the same way. */
  const when = whenOf(a, doc.groups)
  const names = [
    isAnchorName(a.lookName) ? String(a.lookName) : '',
    ...(Array.isArray(a.looks) ? a.looks.slice(0, STATES_MAX) : []).map((L) => (L && isAnchorName(L.name) ? String(L.name) : '')),
  ]
  out.push({
    id: a.id,
    ...(isPlacementName(a.name) ? { name: String(a.name) } : {}),
    group: a.group,
    ...(when ? { when: when.slice(0, 240) } : {}),
    ...look0,
    x: Math.round(a.x),
    y: Math.round(a.y),
    ...(a.scale !== 1 ? { scale: a.scale } : {}),
    ...(a.sx !== undefined ? { scaleX: a.sx, scaleY: a.sy } : {}),
    ...(a.rot ? { rot: a.rot } : {}),
    ...(a.fx ? { flipX: true } : {}),
    ...(a.fy ? { flipY: true } : {}),
    ...(a.life ? { life: a.life } : {}),
    ...(looks.filter(Boolean).length ? { looks: looks.filter(Boolean) } : {}),
    ...(names.some((n) => n) ? { lookNames: names } : {}),
  })
}

const png = (n) => (fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n)) : null)
const r = await publishBundle(slug, {
  mapJson,
  assetsJson: { assets: out },
  images: {
    'scene.png': png('scene.png'),
    'levels.png': png('levels.png'),
    'occluders.png': png('occluders.png'),
    'cut.png': png('cut.png'),
  },
  files,
})

const faces = {}
for (const a of out) if (a.dirs) faces[a.facing] = (faces[a.facing] || 0) + 1
console.log(`re-exported ${slug} v${r.version}`)
console.log(`  ${out.length} placements, ${files.size} frames, ${(r.bytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`  facings restored: ${JSON.stringify(faces)}`)
console.log(`  ${turned} figure(s) were being forced south and are now facing where you turned them`)
if (r.atlas) console.log(`  atlas: ${r.atlas.frames} frames in ${r.atlas.w}x${r.atlas.h}`)
await closeDb()
