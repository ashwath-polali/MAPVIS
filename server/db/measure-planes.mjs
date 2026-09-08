// throwaway measurement of the claim that planes.png is about 40 KB against 1.7 MB of base64 in the doc
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { encodePNG, decodePNG } from '../sheet.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORK = path.resolve(HERE, '..', '..', 'work')
const id = process.argv[2] || 'hub'
const K = (n) => (n / 1024).toFixed(1).padStart(9) + ' KB'

const raw = fs.readFileSync(path.join(WORK, id, 'doc.json'), 'utf8')
const d = JSON.parse(raw)
const { w, h } = d
const n = w * h

// unpack exactly as mask.ts unpack() does: three byte planes back to back
const s = Buffer.from(d.m, 'base64')
if (s.length !== n * 3) throw new Error(`expected ${n * 3} plane bytes, got ${s.length}`)
const lvl = s.subarray(0, n)
const occ = s.subarray(n, n * 2)
const cut = s.subarray(n * 2, n * 3)

// r = levels, g = occluder id, b = cut. alpha is constant so it costs nothing.
const rgba = Buffer.alloc(n * 4)
for (let i = 0; i < n; i++) {
  rgba[i * 4] = lvl[i]
  rgba[i * 4 + 1] = occ[i]
  rgba[i * 4 + 2] = cut[i]
  rgba[i * 4 + 3] = 255
}
const png = encodePNG(w, h, rgba)

// prove it round-trips before believing the size
const back = decodePNG(png).data
let bad = 0
for (let i = 0; i < n; i++) {
  if (back[i * 4] !== lvl[i] || back[i * 4 + 1] !== occ[i] || back[i * 4 + 2] !== cut[i]) bad++
}

const docNoPlanes = JSON.stringify({ ...d, m: undefined })
const gz = (b) => zlib.gzipSync(Buffer.from(b)).length

console.log(`map ${id}  ${w}x${h}  ${n.toLocaleString()} px`)
console.log(`  doc.json today          ${K(raw.length)}   (gz ${K(gz(raw))})`)
console.log(`    of which base64 m     ${K(d.m.length)}`)
console.log(`    of which everything   ${K(docNoPlanes.length)}   (gz ${K(gz(docNoPlanes))})`)
console.log(`  planes.png              ${K(png.length)}`)
console.log(`  new autosave total      ${K(docNoPlanes.length + png.length)}`)
console.log(`  ratio                   ${(raw.length / (docNoPlanes.length + png.length)).toFixed(1)}x smaller`)
console.log(`  round-trip mismatches   ${bad}${bad ? '  <-- LOSSY, DO NOT SHIP' : '  (lossless)'}`)
