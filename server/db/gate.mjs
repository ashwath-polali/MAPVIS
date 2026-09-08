// MAPVIS_NO_DISK refuses the work/ fallback; renaming the folder aside is EPERM on windows and dead in CI
import http from 'node:http'
import { closeDb } from './pool.mjs'

// set before api.mjs is imported, because env() caches on first read
process.env.MAPVIS_NO_DISK = '1'
const { api } = await import('../api.mjs')

const slug = process.argv[2] || 'hub'
const PORT = 5399

let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}

const server = http.createServer((req, res) =>
  api(req, res, () => {
    res.statusCode = 404
    res.end('not found')
  }),
)

const get = async (p) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`)
  return { status: r.status, type: r.headers.get('content-type') || '', body: r }
}

try {
  console.log(`disk fallback off. work/${slug} may as well not exist.\n`)
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  // the document, which is the hand-drawn work and the thing that matters
  const d = await get(`/api/doc/${slug}`)
  const doc = JSON.parse((await d.body.json()).doc || '{}')
  const planes = doc.m ? Buffer.from(doc.m, 'base64').length : 0
  planes === doc.w * doc.h * 3
    ? ok(`document: ${doc.w}x${doc.h}, ${planes.toLocaleString()} plane bytes, ${doc.assets?.length ?? 0} placements`)
    : no(`document came back wrong: ${JSON.stringify(doc).slice(0, 120)}`)
  doc.events?.length ? ok(`${doc.events.length} door(s) survived: ${doc.events.map((e) => e.to).join(', ')}`) : no('no doors came back')

  // the library, which used to be a directory walk
  const l = await get(`/api/library/${slug}`)
  const items = (await l.body.json()).items || []
  items.length ? ok(`library: ${items.length} items`) : no('library came back empty')

  // and a real png, fetched at the same url a placement carries
  const withFrames = items.find((i) => i.frames?.length)
  const still = items.find((i) => i.src)
  const target = withFrames?.frames[0] || still?.src
  if (!target) no('no item to fetch bytes for')
  else {
    const png = await get(target)
    const buf = Buffer.from(await png.body.arrayBuffer())
    const isPNG = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47
    isPNG
      ? ok(`png: ${target} -> ${buf.length.toLocaleString()} bytes, valid header`)
      : no(`png: ${target} -> ${png.status}, ${buf.length} bytes, not a png`)
  }

  // the scene painting itself
  const s = await get(`/work/${slug}/scene.png`)
  const sbuf = Buffer.from(await s.body.arrayBuffer())
  sbuf.length > 8 && sbuf.readUInt32BE(0) === 0x89504e47
    ? ok(`scene.png: ${(sbuf.length / 1024).toFixed(1)}kb`)
    : no(`scene.png came back ${s.status}, ${sbuf.length} bytes`)
} finally {
  await new Promise((r) => server.close(r))
  await closeDb()
  console.log('')
}

console.log(bad ? `${bad} problem(s). the map still needs this laptop.` : `the map does not need this laptop.`)
process.exit(bad ? 1 : 0)
