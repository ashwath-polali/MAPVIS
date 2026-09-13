// Taking the animation off a thing, and putting it back, through the real route.

//   node server/db/verify-switch.mjs

// Nothing is generated: the frames are already bought, so the switch keeps them rather than binning
// them and putting them back costs nothing. That is the whole reason this can exist at all.
//
// The route is driven here as the server drives it, with a scripted request and response, because
// the risk in this feature is not arithmetic. It is the swap window: for a moment both a loose png
// and a folder of frames sit under one name, and reading the wrong one records an animated thing as
// a still with no frames, uploads nothing, then deletes the file every placement was pointing at.
// That failure is silent, survives a reload, and is what the author sees as "it came back invisible".
// So this walks the real disk and then asks the library what it ended up believing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}

/* the route writes under WORK, and WORK is read once when api.mjs loads, so it is pointed at a
 * throwaway folder BEFORE the import. Without this the checks would edit the real work/ tree. */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mapvis-switch-'))
process.env.MAPVIS_WORK = WORK

const { api } = await import('../api.mjs')
const { store } = await import('../store/blobs.mjs')
const { libraryOf, mapIdFor } = await import('../store/platform.mjs')
const { q, closeDb } = await import('./pool.mjs')

/* a real png: the library reads the IHDR off the first bytes to size a row, and a colour in the
 * pixels so "which frame was kept" is answerable rather than assumed */
function png(w, h, tint) {
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const chunk = (type, bodyBuf) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(bodyBuf.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), bodyBuf])
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
  const rows = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows[y * (w * 4 + 1) + 1 + x * 4] = tint
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* the route as the server calls it: api() hands the response back through res.end rather than by
 * returning, so the call is finished when end fires */
function post(pathname, payload) {
  return new Promise((resolve) => {
    const req = { url: pathname, method: 'POST', headers: {}, socket: {}, _body: Promise.resolve(payload) }
    const res = {
      statusCode: 200,
      setHeader() {},
      end(buf) {
        let json = null
        try {
          json = JSON.parse(String(buf))
        } catch {
          /* a body that is not json is itself the answer, and the caller reads the code */
        }
        resolve({ code: res.statusCode, body: json })
      },
    }
    api(req, res, () => resolve({ code: 404, body: null }))
  })
}

const SLUG = 'zz-switch-' + Math.random().toString(36).slice(2, 8)
const NAME = 'zz-lamp'
const lib = path.join(WORK, SLUG, 'library')
const folder = path.join(lib, NAME)
const still = path.join(lib, NAME + '.png')
const prev = path.join(WORK, SLUG, '.prev')

const rowFor = async () => (await libraryOf(SLUG)).find((i) => i.name === NAME) || null
/* the frame tint, read back off the deflated pixels rather than off a file name */
const tintOf = (file) => {
  const raw = fs.readFileSync(file)
  let at = 8
  while (at < raw.length) {
    const len = raw.readUInt32BE(at)
    const type = raw.toString('ascii', at + 4, at + 8)
    if (type === 'IDAT') return zlib.inflateSync(raw.subarray(at + 8, at + 8 + len))[1]
    at += 12 + len
  }
  return -1
}

try {
  /* THE MAP EXISTS FIRST, because it always does: nobody animates an asset in a map they have not
   * made. It is created here rather than left to the route on purpose. mapIdFor REFUSES to create a
   * map inside an http request carrying no signed-in user, which is what stops a stranger writing
   * rows onto somebody else's account by naming a slug, and driving the route is exactly that shape
   * of request. So the row is made out of band, the way the author's own session made it. */
  await mapIdFor(SLUG, { create: true })

  // ---- it starts as four frames --------------------------------------------
  fs.mkdirSync(folder, { recursive: true })
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(folder, i + '.png'), png(32, 32, 10 + i))
  {
    const r = await post('/api/asset-animation', { id: SLUG, name: NAME, on: false })
    r.code === 200 ? ok('the switch answers on a thing that moves') : no(`taking it off answered ${r.code} ${JSON.stringify(r.body)}`)
    r.body && r.body.plays === false ? ok('and says it no longer plays') : no('the answer did not say it had stopped')
  }

  // ---- what is on disk now -------------------------------------------------
  fs.existsSync(still) ? ok('a loose png is where the folder was') : no('no still was written')
  !fs.existsSync(folder) ? ok('and the folder of frames is gone, so nothing reads two answers for one name') : no('the frame folder is still there beside the png')
  fs.existsSync(still) && tintOf(still) === 10
    ? ok('and the picture kept is the FIRST frame, which is the one the author drew before asking for movement')
    : no(`the still holds tint ${fs.existsSync(still) ? tintOf(still) : 'nothing'}, expected the first frame's 10`)

  /* NOTHING IS THROWN AWAY. Every one of those frames was paid for, so taking the movement off has
   * to be a switch and not a deletion, or "bring it back" is a promise the tool cannot keep. */
  {
    const kept = path.join(prev, NAME)
    const n = fs.existsSync(kept) ? fs.readdirSync(kept).filter((f) => f.endsWith('.png')).length : 0
    n === 4 ? ok('and all four frames are kept, so none of what was paid for is thrown away') : no(`${n} of 4 frames were kept`)
  }

  // ---- and what the library believes ---------------------------------------
  // The row being wrong is the silent half: a placement reads the row to know
  // what to draw, so a row still calling this an animation points every copy of
  // it at a folder that no longer exists.
  {
    const it = await rowFor()
    it && it.kind === 'static' ? ok('the library records it as the still it now is') : no(`the row says ${it && it.kind}`)
    it && !(it.frames && it.frames.length) ? ok('and carries no frames') : no('a still row still lists frames')
  }

  /* and the still really is in the store, because on a host work/ is empty and a row pointing at a
   * file nobody uploaded is the same invisible asset by a different route */
  {
    const id = await mapIdFor(SLUG)
    let got = 0
    try {
      const b = await store().get(`maps/${id}/library/${NAME}.png`)
      if (b && b.length) got = b.length
    } catch {
      /* a missing still is the failure this is counting */
    }
    got > 0 ? ok('and the still reached the store, so it draws on a host too') : no('the still never reached the store, so it would 404 anywhere but this laptop')
  }

  // ---- pressing it again is refused, not repeated ---------------------------
  {
    const r = await post('/api/asset-animation', { id: SLUG, name: NAME, on: false })
    r.code === 409 ? ok('asking a still to stop moving is refused rather than run again') : no(`a second removal answered ${r.code}`)
  }

  // ---- and back ------------------------------------------------------------
  {
    const r = await post('/api/asset-animation', { id: SLUG, name: NAME, on: true })
    r.code === 200 ? ok('bringing it back answers') : no(`bringing it back answered ${r.code} ${JSON.stringify(r.body)}`)
    const n = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => f.endsWith('.png')).length : 0
    n === 4 ? ok('and every frame is back on disk') : no(`${n} of 4 frames came back`)
    !fs.existsSync(still) ? ok('with the still gone, so again there is one answer for the name') : no('the still is still there beside the frames')
    const it = await rowFor()
    it && it.kind === 'animated' && it.frames && it.frames.length === 4
      ? ok('and the library records it as the animation it is again')
      : no(`the row came back as ${it && it.kind} with ${(it && it.frames && it.frames.length) || 0} frames`)
  }

  /* THE FRAMES REACHED THE STORE TOO. This is the exact failure that made an animated asset
   * invisible: the row was right and not one frame blob was ever uploaded. */
  {
    const id = await mapIdFor(SLUG)
    let got = 0
    for (let i = 0; i < 4; i++) {
      try {
        const b = await store().get(`maps/${id}/library/${NAME}/${i}.png`)
        if (b && b.length) got++
      } catch {
        /* counted as missing */
      }
    }
    got === 4 ? ok('and all four frames are in the store, not only on this disk') : no(`${got} of 4 frames reached the store`)
  }

  // ---- and it goes back and forth, not just once ---------------------------
  // The first removal has a clean .prev to write into. The second does not, and
  // prevPath numbers copies after the first, so a switch that could only read
  // the unnumbered one would work once and then quietly stop.
  {
    const off2 = await post('/api/asset-animation', { id: SLUG, name: NAME, on: false })
    off2.code === 200 ? ok('it comes off a second time') : no(`the second removal answered ${off2.code} ${JSON.stringify(off2.body)}`)

    /* AND THE FRAMES ARE OUT OF THE STORE, which is what this round trip exists to prove. They used
     * to be left there: hydrateMap pulls a map's whole library down onto an empty work/ before any
     * route reads the disk, so the folder came back beside the png, the folder is believed over a
     * png of the same name, and the thing was animated again on the very next request. On a host,
     * where work/ is always empty and a hydrate always runs, removing an animation did not stick at
     * all. It read as "I took it off and it came back on its own". */
    {
      const id = await mapIdFor(SLUG)
      let left = 0
      try {
        left = (await store().list(`maps/${id}/library/${NAME}/`)).length
      } catch {
        /* a store that cannot be listed cannot be checked, and the count stays zero */
      }
      left === 0
        ? ok('and the frames are out of the store, so a hydrate on a host cannot put the animation back')
        : no(`${left} frame(s) of what it used to be are still in the store, so hydrating undoes the removal`)
    }

    const r = await post('/api/asset-animation', { id: SLUG, name: NAME, on: true })
    const n = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => f.endsWith('.png')).length : 0
    r.code === 200 && n === 4
      ? ok('a second round trip works, so it reads the numbered copies and not only the first')
      : no(`the second round trip answered ${r.code} with ${n} frames`)
    /* and it is the FRAMES that came back, not the still that was there a moment ago */
    tintOf(path.join(folder, '0.png')) === 10 ? ok('and what came back is the frames, in order') : no('the frames came back in the wrong order or as the wrong pictures')
  }

  // ---- a thing that never moved has nothing to bring back ------------------
  {
    const LONE = 'zz-rock'
    fs.writeFileSync(path.join(lib, LONE + '.png'), png(16, 16, 99))
    const off = await post('/api/asset-animation', { id: SLUG, name: LONE, on: false })
    off.code === 409 ? ok('an ordinary picture has no movement to take off, and it says so') : no(`a still answered ${off.code} to removal`)
    const on = await post('/api/asset-animation', { id: SLUG, name: LONE, on: true })
    on.code === 404 && on.body && /ever kept/.test(String(on.body.error))
      ? ok('and one that was never animated says nothing was kept rather than inventing frames')
      : no(`a never-animated still answered ${on.code} ${JSON.stringify(on.body)}`)
  }

  // ---- a set of headings keeps its headings --------------------------------
  // A walking figure is not a frame folder: it is one picture set per heading,
  // and flattening it to a single png would throw seven directions away. Taking
  // the movement off a figure means the standing rotation it was drawn with.
  {
    const SET = 'zz-porter'
    const sdir = path.join(lib, SET)
    const heads = ['south', 'north', 'east', 'west']
    fs.mkdirSync(sdir, { recursive: true })
    const dirs = {}
    heads.forEach((h, hi) => {
      dirs[h] = []
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(path.join(sdir, `${h}-${i}.png`), png(24, 24, 30 + hi * 3 + i))
        dirs[h].push(`/work/${SLUG}/library/${SET}/${h}-${i}.png`)
      }
    })
    fs.writeFileSync(path.join(sdir, 'dirs.json'), JSON.stringify({ dirs, fps: 8, characterId: 'char-abc' }, null, 2))

    const r = await post('/api/asset-animation', { id: SLUG, name: SET, on: false })
    r.code === 200 ? ok('a walking set can have its movement taken off') : no(`a view set answered ${r.code} ${JSON.stringify(r.body)}`)

    const meta = JSON.parse(fs.readFileSync(path.join(sdir, 'dirs.json'), 'utf8'))
    const heads2 = Object.keys(meta.dirs || {})
    heads2.length === 4 ? ok('and it still has all four headings, so it still faces where it walks') : no(`${heads2.length} headings survived, expected 4`)
    heads2.every((h) => meta.dirs[h].length === 1)
      ? ok('each holding one picture, which is the standing rotation it was drawn with')
      : no('a heading came back with more than one picture, so it still moves')
    /* THE RIG IS THE WAY BACK. A set with no character id can never be given another motion, so
     * losing it here would make this a one-way door disguised as a switch. */
    meta.characterId === 'char-abc' ? ok('and the character it was drawn from is carried across') : no('the character id was dropped, so it can never be animated again')
    /* the first picture of each heading, not an arbitrary one: the others were deleted */
    heads.every((h, hi) => fs.existsSync(path.join(sdir, `${h}-0.png`)) && tintOf(path.join(sdir, `${h}-0.png`)) === 30 + hi * 3)
      ? ok('and the picture kept for each heading is its first')
      : no('a heading kept the wrong picture')
    !fs.existsSync(path.join(sdir, 'south-1.png')) ? ok('with the walk cycle taken off disk') : no('the walk frames are still there, so nothing changed')

    const back = await post('/api/asset-animation', { id: SLUG, name: SET, on: true })
    const m2 = JSON.parse(fs.readFileSync(path.join(sdir, 'dirs.json'), 'utf8'))
    back.code === 200 && Object.keys(m2.dirs || {}).every((h) => m2.dirs[h].length === 3)
      ? ok('and the walk cycles come back whole')
      : no(`the walk did not come back: ${back.code}, ${JSON.stringify(Object.keys(m2.dirs || {}).map((h) => m2.dirs[h].length))}`)
  }

  // ---- what it refuses to be asked ----------------------------------------
  {
    const r = await post('/api/asset-animation', { id: SLUG, name: 'zz-nothing-here', on: false })
    r.code === 404 ? ok('a name that is not in the library is a 404 and not a crash') : no(`an unknown name answered ${r.code}`)
    /* NO NAME AT ALL IS REFUSED, and this is not a formality: cleanName falls back to the word
     * "asset" rather than to nothing, so a guard written on the cleaned name would have let a
     * nameless request through to flatten whatever row happened to be called asset. */
    const n = await post('/api/asset-animation', { id: SLUG, on: false })
    n.code === 400 ? ok('and a request with no name is refused before any row is read') : no(`a nameless request answered ${n.code} ${JSON.stringify(n.body)}`)
  }
} catch (e) {
  no('the checks themselves threw: ' + String((e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)))
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
  fs.rmSync(WORK, { recursive: true, force: true })
  await closeDb()
}

console.log(bad ? `\n${bad} problem(s).` : '\nan animation comes off a thing and comes back, and nothing paid for is lost either way.')
process.exit(bad ? 1 : 0)
