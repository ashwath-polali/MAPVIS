// What the library records when an item changes shape, against the real database and bucket.

//   node server/db/verify-shape.mjs

// An item here is one of three things: a loose png, a folder of numbered frames, or a folder of
// per-heading view sets. Animating a still turns the first into the second, and for the length of
// that swap BOTH exist on disk, because the png is only deleted once the folder is whole so that a
// crash leaves the original standing.
//
// Reading the png during that window is what broke animation: the row went down as a still with no
// frames, not one frame blob was uploaded, the png was deleted a moment later, and every placement
// of it pointed at bytes nobody had. This walks that exact window on the real disk and asks the
// database what it ended up believing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pushItem, libraryOf, mapIdFor } from '../store/platform.mjs'
import { store, keys } from '../store/blobs.mjs'
import { q, closeDb } from './pool.mjs'

let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}

/* a real png, because pushItem reads the IHDR off the first bytes to size the row */
function png(w, h) {
  const chunk = (type, body) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), body])
    const crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
    let c = 0xffffffff
    for (const b of td) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const SLUG = 'zz-shape-' + Math.random().toString(36).slice(2, 8)
const NAME = 'zz-swapping-thing'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mapvis-shape-'))
const lib = path.join(work, 'library')
fs.mkdirSync(lib, { recursive: true })

const rowFor = async () => (await libraryOf(SLUG)).find((i) => i.name === NAME) || null

try {
  // ---- it starts as one png ------------------------------------------------
  fs.writeFileSync(path.join(lib, NAME + '.png'), png(32, 32))
  await pushItem(SLUG, NAME, work)
  {
    const it = await rowFor()
    it && it.kind === 'static' ? ok('a loose png is recorded as a still') : no(`a still came back as ${JSON.stringify(it)}`)
    it && !it.frames ? ok('and carries no frames') : no('a still carried frames')
  }

  // ---- the window: the frames are written, the png is not deleted yet ------
  // This is the exact state the animate route leaves behind between writing the
  // folder and removing the original, and it is the state that used to be read
  // as a still with nothing in it.
  fs.mkdirSync(path.join(lib, NAME), { recursive: true })
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(lib, NAME, i + '.png'), png(48, 48))
  const bothThere = fs.existsSync(path.join(lib, NAME + '.png')) && fs.existsSync(path.join(lib, NAME))
  bothThere ? ok('the png and the frame folder are both on disk, which is what a swap looks like') : no('the window could not be staged')

  await pushItem(SLUG, NAME, work)
  {
    const it = await rowFor()
    it && it.kind === 'animated'
      ? ok('and the row is written as the animation it now is, not as the png it used to be')
      : no(`the row says ${it && it.kind}, so the library is calling an animated thing a still`)
    it && it.frames && it.frames.length === 4
      ? ok('with every frame on it')
      : no(`it carries ${it && it.frames ? it.frames.length : 0} frames, expected 4`)
    it && it.w === 48 ? ok('and the size of the frames rather than of the old png') : no(`the size is ${it && it.w}, expected 48`)
  }

  // ---- the frames really are in the bucket ---------------------------------
  // The row being right is half of it. The early return also meant not one frame
  // was ever uploaded, so every url 404d on a host where work/ is empty.
  {
    const id = await mapIdFor(SLUG)
    const s = store()
    let got = 0
    for (let i = 0; i < 4; i++) {
      try {
        const b = await s.get(keys.libFrame(id, NAME, i))
        if (b && b.length) got++
      } catch {
        /* a missing frame is the failure this is counting */
      }
    }
    got === 4
      ? ok('and all four frames are really in the store, so nothing 404s where work/ is empty')
      : no(`${got} of 4 frames reached the store, so the rest would be invisible on a host`)
  }

  // ---- the png goes, and nothing changes -----------------------------------
  fs.rmSync(path.join(lib, NAME + '.png'), { force: true })
  await pushItem(SLUG, NAME, work)
  {
    const it = await rowFor()
    it && it.kind === 'animated' && it.frames && it.frames.length === 4
      ? ok('deleting the png afterwards leaves the row exactly as it was')
      : no('removing the original changed what the library believes')
  }
} catch (e) {
  no('the checks themselves threw: ' + String((e && e.message) || e))
} finally {
  try {
    const id = await mapIdFor(SLUG)
    if (id) {
      await store().delPrefix(`maps/${id}/`)
      await q('delete from maps where id = $1', [id])
    }
  } catch {
    /* a map that was never made needs no cleaning up */
  }
  fs.rmSync(work, { recursive: true, force: true })
  await closeDb()
}

console.log(bad ? `\n${bad} problem(s).` : '\nan item that changes shape is recorded as what it became.')
process.exit(bad ? 1 : 0)
