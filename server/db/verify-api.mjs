// boots the api in-process so it tests the working tree, and checks refusals because it has to fail closed
import http from 'node:http'
import { api } from '../api.mjs'
import { closeDb, one } from './pool.mjs'

const slug = process.argv[2] || 'hub'
const PORT = 5398
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
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const hit = (path) => fetch(`http://127.0.0.1:${PORT}${path}`)

try {
  // the registry the game has never had. A door names a target by slug and
  // nothing has ever been able to answer whether that target exists.
  const reg = await (await hit('/api/v1/maps')).json()
  const mine = reg.maps?.find((m) => m.slug === slug)
  mine ? ok(`registry lists ${slug} at v${mine.version}, ${mine.anchors} anchor(s)`) : no('registry did not list the map')

  // the listing that gives python autocomplete and an author-time error
  const an = await (await hit(`/api/v1/maps/${slug}/anchors`)).json()
  const names = (an.anchors || []).map((a) => a.name)
  names.length ? ok(`anchors: ${names.join(', ')}`) : no('no anchors listed')
  const derived = (an.anchors || []).filter((a) => a.derived)
  if (derived.length) ok(`${derived.length} flagged derived, so nobody writes code against a guessed name`)

  // the manifest, and the anchors riding inside map.json
  const man = await (await hit(`/api/v1/maps/${slug}`)).json()
  man.version ? ok(`manifest v${man.version}, ${Object.keys(man.files).length} files`) : no('no manifest')
  man.map?.contract === 2 ? ok('map.json carries contract 2') : no(`map.json contract is ${man.map?.contract}`)
  Array.isArray(man.map?.anchors) && man.map.anchors.length
    ? ok(`map.json carries ${man.map.anchors.length} anchor(s) as well as ${man.map.events?.length ?? 0} legacy event(s)`)
    : no('map.json carries no anchors')

  // real bytes, at the url the manifest advertises
  for (const name of ['scene.png', 'levels.png']) {
    const entry = man.files[name]
    if (!entry) {
      no(`${name} is not in the manifest`)
      continue
    }
    const r = await hit(entry.url)
    const buf = Buffer.from(await r.arrayBuffer())
    const isPNG = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47
    isPNG && buf.length === entry.bytes
      ? ok(`${name}: ${buf.length.toLocaleString()} bytes, matches the manifest`)
      : no(`${name}: ${r.status}, ${buf.length} bytes, manifest said ${entry.bytes}`)
    r.headers.get('cache-control')?.includes('immutable')
      ? ok(`${name} is cached forever, which is what keeps the free read budget untouched`)
      : no(`${name} is not marked immutable: ${r.headers.get('cache-control')}`)
  }

  const asset = Object.entries(man.files).find(([k]) => k.startsWith('assets/'))
  if (asset) {
    const r = await hit(asset[1].url)
    const buf = Buffer.from(await r.arrayBuffer())
    buf.length === asset[1].bytes ? ok(`${asset[0]}: ${buf.length} bytes`) : no(`${asset[0]} came back ${buf.length}`)
  }

  // and everything that must be refused
  const refuse = [
    [`/api/v1/maps/${slug}/file/1/../../../.env`, 'a path climbing out of the version'],
    [`/api/v1/maps/${slug}/file/99/scene.png`, 'a version that does not exist'],
    [`/api/v1/maps/${slug}/file/1/`, 'an empty file name'],
    ['/api/v1/maps/nope-not-a-map', 'a map that does not exist'],
  ]
  /* found rather than named: a hardcoded slug fails this suite the day that map is published */
  const unpublished = await one(
    `select slug from maps m where not exists (select 1 from publishes p where p.map_id = m.id) limit 1`,
  )
  if (unpublished) refuse.push([`/api/v1/maps/${unpublished.slug}`, 'a map that exists nowhere yet'])
  else console.log('  --    every map is published, so there is nothing to ask about an unpublished one')
  for (const [path, what] of refuse) {
    const r = await hit(path)
    r.status === 404 ? ok(`refused ${what}`) : no(`${what} came back ${r.status}, not 404`)
  }

  const w = await fetch(`http://127.0.0.1:${PORT}/api/v1/maps/${slug}`, { method: 'POST' })
  w.status === 405 ? ok('the read api refuses to be written to') : no(`POST came back ${w.status}, not 405`)
} finally {
  await new Promise((r) => server.close(r))
  await closeDb()
}

console.log(bad ? `\n${bad} problem(s).` : '\nthe game and python have something real to call.')
process.exit(bad ? 1 : 0)
