// the same call the export button makes, for a bundle exported earlier or a republish with no browser
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishBundle, publishHistory } from '../store/publish.mjs'
import { closeDb } from './pool.mjs'

const WORK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'work')
const slug = process.argv[2]
if (!slug) throw new Error('usage: node server/db/publish-work.mjs <slug>')

const dir = path.join(WORK, slug)
const mapFile = path.join(dir, 'map.json')
if (!fs.existsSync(mapFile)) throw new Error(`work/${slug}/map.json does not exist, so there is nothing exported to publish`)

const readJson = (f, fallback) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback)
const png = (n) => (fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n)) : null)

// every png under assets/, keyed by its path inside the bundle
const files = new Map()
const walk = (d, base) => {
  if (!fs.existsSync(d)) return
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name)
    if (e.isDirectory()) walk(full, `${base}${e.name}/`)
    else if (/\.png$/i.test(e.name)) files.set(`${base}${e.name}`, fs.readFileSync(full))
  }
}
walk(path.join(dir, 'assets'), 'assets/')

const r = await publishBundle(slug, {
  mapJson: readJson(mapFile, {}),
  assetsJson: readJson(path.join(dir, 'assets.json'), { assets: [] }),
  images: {
    'scene.png': png('scene.png'),
    'levels.png': png('levels.png'),
    'occluders.png': png('occluders.png'),
    'cut.png': png('cut.png'),
  },
  files,
})

console.log(`published ${slug} v${r.version}`)
console.log(`  ${r.files.length} files, ${(r.bytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`  ${r.anchors} anchor(s) written into map.json`)
console.log(`  at ${r.prefix}`)
const hist = await publishHistory(slug)
console.log(`  versions: ${hist.map((h) => 'v' + h.version).join(', ')}`)
await closeDb()
