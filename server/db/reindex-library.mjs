// nothing re-examines an item that has a row, so 23 of the hub's 71 were stuck as static with dirs null
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pushItem, libraryOf } from '../store/platform.mjs'
import { bucketOps } from '../store/blobs.mjs'
import { many, q } from './pool.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK = path.join(ROOT, 'work')
const WRITE = process.argv.includes('--write')
const only = process.argv.slice(2).find((a) => !a.startsWith('--'))

const maps = await many('select id, slug from maps order by slug')
let checked = 0
let wrong = 0
let done = 0

for (const m of maps) {
  if (only && m.slug !== only) continue
  const workDir = path.join(WORK, m.slug)
  const lib = path.join(workDir, 'library')
  if (!fs.existsSync(lib)) continue

  // what the database believes today, so the report says what CHANGES rather
  // than just what exists
  const before = new Map((await libraryOf(m.slug)).map((it) => [it.name, it]))

  // one entry per item: a still is <name>.png, everything else is a folder
  const names = new Set()
  for (const e of fs.readdirSync(lib, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    names.add(e.isDirectory() ? e.name : e.name.replace(/\.png$/i, ''))
  }

  const suspect = []
  for (const name of [...names].sort()) {
    checked++
    const was = before.get(name)
    const folder = path.join(lib, name)
    // a folder holding a direction set that the row does not know about is the
    // exact defect this pass repairs, so name it in the dry run
    const looksDirectional =
      fs.existsSync(path.join(folder, 'dirs.json')) && !(was && was.dirs && Object.keys(was.dirs).length)
    const srcMissing = was && was.src && !was.frames && !fs.existsSync(path.join(lib, `${name}.png`))
    if (looksDirectional || srcMissing) {
      wrong++
      suspect.push(name)
    }
    if (!WRITE) continue
    try {
      await pushItem(m.slug, name, workDir)
      done++
    } catch (e) {
      console.log(`  ! ${m.slug}/${name}: ${e.message}`)
    }
  }
  console.log(
    `${m.slug}: ${names.size} item(s), ${suspect.length} indexed wrong${suspect.length ? ' -> ' + suspect.join(', ') : ''}`,
  )
}

const ops = bucketOps()
console.log(
  WRITE
    ? `\nreindexed ${done} item(s); ${ops.a} write and ${ops.b} read bucket operations spent`
    : `\n${checked} item(s) checked, ${wrong} indexed wrong. nothing written (pass --write)`,
)
await q('select 1')
process.exit(0)
