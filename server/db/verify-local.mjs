// the whole tool with no database and no bucket, the way a fresh clone runs before anything is configured: node server/db/verify-local.mjs writes only to a temporary directory and talks to nothing
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// set before api.mjs is imported, because env() caches on first read and merges .env underneath, so a blank value here beats a filled-in line in that file and this can run on a machine that does have a database
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mapvis-local-'))
for (const k of [
  'DATABASE_URL',
  'DATABASE_POOLED_URL',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'MAPVIS_SOLO',
  'PIXELLAB_TOKEN',
])
  process.env[k] = ''
process.env.MAPVIS_STORAGE = 'work'
/* an owner is named so the house-hand checks mean the same on a fresh clone as on a configured one, because with nobody named the permission deliberately opens up, one person on one laptop with no other accounts to keep it from */
process.env.HOUSE_STYLE_OWNER = 'owner@example.invalid'
process.env.MAPVIS_WORK = SANDBOX

const { api } = await import('../api.mjs')
const { store } = await import('../store/blobs.mjs')
const { platformOn } = await import('../store/platform.mjs')

const PORT = 5396
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

const call = async (p, opts = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  let json = null
  try {
    json = await r.json()
  } catch {}
  return { status: r.status, json, retryAfter: r.headers.get('retry-after'), cache: r.headers.get('cache-control') }
}

try {
  // ---- nothing is configured, and the tool knows it ------------------------
  platformOn() === false ? ok('with no DATABASE_URL the platform is off') : no('the platform thinks it is on')
  store().kind === 'local' ? ok('and the blob store falls back to the file store') : no(`the store is ${store().kind}`)
  store().bucket.startsWith(SANDBOX)
    ? ok('which writes under MAPVIS_WORK rather than one fixed folder')
    : no(`the file store writes to ${store().bucket}`)

  const me = await call('/api/me')
  me.status === 200 && me.json?.user === null
    ? ok('/api/me answers nobody instead of failing on the missing database')
    : no(`/api/me answered ${me.status} ${JSON.stringify(me.json)}`)

  // a map survives a round trip through disk: the document is the one file a person cannot redraw, so a lossy save is the worst bug this tool can have, and it is compared as a string and not as an object
  const doc = JSON.stringify({
    v: 3,
    walk: { charH: 18, feet: 2, hip: 5, step: 1, tol: 10, slide: 1 },
    events: [{ id: 'e1', kind: 'door', name: 'quarry_gate', x: 12, y: 34, stand: [14, 36] }],
    note: 'a string with a quote " a backslash \\ and a bullet ·',
  })
  const put = await call('/api/doc', { method: 'POST', body: { id: 'zz-local', doc } })
  put.status === 200 ? ok('a document posts with no platform behind it') : no(`saving answered ${put.status}`)

  const got = await call('/api/doc/zz-local')
  got.json?.doc === doc
    ? ok('and comes back byte for byte, off this machine')
    : no('the document changed across a save and a load')
  got.json?.from === 'disk' ? ok('and says it came from disk') : no(`it says it came from ${got.json?.from}`)

  // the read api refuses rather than breaking: a game asking for a map this machine has never published still has to get an answer, because a 500 here reads as an outage to whatever is polling
  const listed = await call('/api/v1/maps')
  listed.status === 503 && /no database/.test(listed.json?.error || '')
    ? ok('/api/v1/maps says in a sentence that nothing is published here yet')
    : no(`/api/v1/maps answered ${listed.status} ${JSON.stringify(listed.json)}`)
  const missing = await call('/api/v1/maps/nothing-here-at-all')
  missing.status === 404 || missing.status === 503
    ? ok(`an unpublished map answers ${missing.status} and not a crash`)
    : no(`an unknown map answered ${missing.status}`)

  // the fence in front of sign-in, refused on the burst and not on the first press: signing in once must never meet this, and a machine guessing passwords must
  const burst = Number(process.env.AUTH_RATE_BURST || 30)
  let refusedAt = 0
  for (let i = 1; i <= burst + 6 && !refusedAt; i++) {
    const r = await call('/api/auth/login', { method: 'POST', body: { email: 'nobody@test.local', password: 'wrong' } })
    if (r.status === 429) refusedAt = i
  }
  refusedAt > 1 && refusedAt <= burst + 6
    ? ok(`sign-in is refused after ${refusedAt} attempts from one address`)
    : no(refusedAt ? 'sign-in was refused on the first press' : `${burst + 6} sign-in attempts were all allowed`)

  const still = await call('/api/auth/login', { method: 'POST', body: { email: 'nobody@test.local', password: 'wrong' } })
  still.status === 429 && Number(still.retryAfter) > 0
    ? ok(`and says how long to wait (Retry-After ${still.retryAfter})`)
    : no('a refused attempt did not carry a Retry-After')

  const reading = await call('/api/me')
  reading.status === 200
    ? ok('while ordinary reads keep working through it')
    : no(`/api/me got caught in the credential bucket (${reading.status})`)

  // the auth bypass: soloMode() is read once per process, so each case is its own process, and four of these five answer null
  const ASK = "const m = await import('./server/store/auth.mjs'); console.log(JSON.stringify(m.soloMode()))"
  const solo = (extra) => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', ASK], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, MAPVIS_SOLO: 'someone@example.invalid', MAPVIS_NO_SOLO: '', ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(out.trim().split('\n').pop())
  }
  solo({}) === 'someone@example.invalid'
    ? ok('solo mode is on when the env var names an account')
    : no('solo mode did not read its own variable')
  solo({ VERCEL: '1' }) === null ? ok('and off wherever a serverless runtime is detected') : no('solo mode survived VERCEL')
  solo({ NODE_ENV: 'production' }) === null
    ? ok('and off whenever NODE_ENV is production')
    : no('solo mode survived NODE_ENV=production')
  solo({ MAPVIS_NO_SOLO: '1' }) === null ? ok('and off when told off explicitly') : no('MAPVIS_NO_SOLO did not turn it off')
  solo({ MAPVIS_SOLO: '' }) === null
    ? ok('and off by default, which is what a fresh clone gets')
    : no('solo mode was on with no account named')

  const src = fs.readFileSync(path.join(ROOT, 'server/store/auth.mjs'), 'utf8')
  const fenced = src.includes('fromThisMachine(req)') && src.includes('LOOPBACK.test(a)')
  fenced
    ? ok('and refused for any request that did not come from the loopback address')
    : no('the loopback fence is gone from currentUser')

  // undoing an edit, all eight steps: .prev keeps eight copies named <name>.png then <name>-2.png upward, and a lone backslash in a quoted string is dropped, so '\d' there is the letter d, the pattern matched <name>-ddd and never <name>-2, and undo reached only the newest copy
  {
    const route = fs.readFileSync(path.join(ROOT, 'server/api.mjs'), 'utf8')
    /* the shared reader, not the line that used to sit inside the revert route: undo and the animation switch have to agree which kept copy is the newest, so the pattern is written once and named, and this exercises the one they both call */
    const line = route.split(/\r?\n/).find((l) => l.includes('const numberedCopy = (name) =>'))
    if (!line) no('nothing builds a pattern for the copies kept beside an item any more')
    else {
      const make = new Function(line.trim() + '; return numberedCopy')
      const re = make()('palm')
      const hits = (n) => re.test(n)
      hits('palm-2.png') && hits('palm-8.png') && hits('palm-3')
        ? ok('an undo can reach every numbered copy kept beside an item, not just the newest')
        : no(`the revert pattern misses its own numbered copies: ${re.source}`)
      !hits('palm-d') && !hits('palm-ddd.png')
        ? ok('and the digits are digits rather than the letter d')
        : no(`the revert pattern is matching letters: ${re.source}`)
      !hits('other-2.png') ? ok('while another item of a similar name is left alone') : no('the pattern reached another item')
    }
  }

  // how long an answer may be kept: a url carrying a version names one set of bytes for ever, and left with no header a host fills one in whose default turns every versioned file into a conditional request on every open, the round trip the version in the url exists to avoid
  {
    const cc = async (path) => (await call(path)).cache
    const IMM = 'public, max-age=31536000, immutable'

    ;(await cc('/api/v1/maps/anything/file/7/map.json')) === IMM
      ? ok('a versioned map file is immutable, so a browser that has it never asks again')
      : no(`a versioned file answered ${JSON.stringify(await cc('/api/v1/maps/anything/file/7/map.json'))}`)

    ;(await cc('/api/v1/ui/band/image?v=abc123')) === IMM
      ? ok('and a ui piece asked for by content hash is immutable too')
      : no(`a hashed ui piece answered ${JSON.stringify(await cc('/api/v1/ui/band/image?v=abc123'))}`)

    ;(await cc('/api/v1/maps/hub')) === 'public, max-age=60'
      ? ok('while the manifest gets a minute, because it is what moves when a map is republished')
      : no(`the manifest answered ${JSON.stringify(await cc('/api/v1/maps/hub'))}`)

    ;(await cc('/api/v1/maps/hub?v=3')) === IMM
      ? ok('and a manifest pinned to a version is immutable like the files under it')
      : no(`a pinned manifest answered ${JSON.stringify(await cc('/api/v1/maps/hub?v=3'))}`)

    /* the listing is every map and their newest versions, so it is the one answer that must not be held: a map published a moment ago has to appear */
    ;(await cc('/api/v1/maps')) === null
      ? ok('and the listing of every map is never held, since a new publish has to show in it')
      : no(`the listing answered ${JSON.stringify(await cc('/api/v1/maps'))}`)

    ;(await cc('/api/v1/ui/band/image')) === null
      ? ok('and a ui piece with no hash on it is not claimed to be immutable')
      : no(`an unhashed ui piece answered ${JSON.stringify(await cc('/api/v1/ui/band/image'))}`)
  }

  // whose hand a stranger may draw with: the house style is the only thing on this platform that is not public, and reading the owner with process.env instead of env() finds an empty string, which the permission treats as nothing configured and opens it to everybody
  {
    const offered = await call('/api/styles')
    const keys = (offered.json?.cards || []).map((c) => c.key)
    keys.length === 0
      ? ok('a signed-out visitor is offered no house hand at all')
      : no(`a stranger was offered ${JSON.stringify(keys)}`)
    offered.json?.fallback === ''
      ? ok('and their default is Other, which is the prompt as typed')
      : no(`a stranger defaults to ${JSON.stringify(offered.json?.fallback)}`)

    const taken = await call('/api/map-prompt', { method: 'POST', body: { subject: 'an island', style: 'adventure-game' } })
    const words = String(taken.json?.prompt || '')
    !taken.json?.style && !words.includes('chunky isometric pixel forms')
      ? ok('and naming it outright still writes none of its craft into the prompt')
      : no('a stranger read the house craft sentence by naming the key')

    const drew = await call('/api/generate', { method: 'POST', body: { prompt: 'an island', style: 'adventure-game', n: 1 } })
    drew.status === 403 ? ok('and drawing with it is refused outright') : no(`drawing in the house hand answered ${drew.status}`)

    const other = await call('/api/map-prompt', { method: 'POST', body: { subject: 'an island', style: '' } })
    other.status === 200 && String(other.json?.prompt || '').startsWith('an island')
      ? ok('while Other is open to them and keeps their own words in front')
      : no('a stranger cannot draw at all')
  }

  // what a client cannot raise: every ceiling standing between a loop and a bill is read from the environment, so a request that could widen one could spend somebody else's money, and each is checked where it is declared
  const ceilings = [
    ['the monthly bucket read limit', 'server/store/platform.mjs', /R2_MONTHLY_READ_LIMIT/],
    ['the monthly bucket write limit', 'server/store/platform.mjs', /R2_MONTHLY_WRITE_LIMIT/],
    ['the per-process bucket ceiling', 'server/store/blobs.mjs', /S3_MAX_OPS/],
    ['the request budget', 'server/api.mjs', /RATE_PER_SEC/],
    ['the credential budget', 'server/api.mjs', /AUTH_RATE_PER_MIN/],
  ]
  for (const [what, file, name] of ceilings) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const line = text.split(/\r?\n/).find((l) => name.test(l) && /Number\(/.test(l)) || ''
    const fromEnv = /(env\(\)|process\.env)\./.test(line)
    const fromBody = /(b|body|req|url|params|input)\s*[.[]/.test(line)
    fromEnv && !fromBody
      ? ok(`${what} is read from the environment and from nothing a caller sends`)
      : no(`${what} does not read from the environment alone: ${line.trim().slice(0, 90)}`)
  }

  // and nothing anywhere writes one back into the process it was read from
  const writesEnv = ['server/api.mjs', 'server/store/blobs.mjs', 'server/store/platform.mjs', 'server/db/env.mjs']
    .flatMap((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/))
    .filter((l) => /process\.env(\.[A-Z_]+|\[)\s*=[^=]/.test(l))
  writesEnv.length === 0
    ? ok('and no route writes an environment value back, so a ceiling cannot be moved at runtime')
    : no(`${writesEnv.length} line(s) assign to process.env outside a check harness`)
} finally {
  server.close()
  fs.rmSync(SANDBOX, { recursive: true, force: true })
}

console.log(bad ? `\n${bad} problem(s).` : '\nthe tool runs, saves and refuses correctly with nothing configured.')
process.exit(bad ? 1 : 0)
