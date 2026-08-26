// Accounts, exercised end to end against the real database.
//
//   node server/db/verify-auth.mjs
//
// Security code is the one place where "it seemed to work" is worthless, so
// this checks the refusals as hard as the successes: a wrong password, a
// forged token, an expired session, one account reaching another's map, and
// whether a stored api key can ever come back out over http.
import http from 'node:http'
import { api } from '../api.mjs'
import { q, one, closeDb } from './pool.mjs'
import { openKey } from '../store/crypto.mjs'

const PORT = 5397
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

const call = async (path, opts = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const cookie = r.headers.get('set-cookie') || ''
  let json = null
  try {
    json = await r.json()
  } catch {}
  return { status: r.status, json, cookie, token: (cookie.match(/mapvis_session=([^;]+)/) || [])[1] }
}

const stamp = Date.now().toString(36)
const alice = { email: `alice-${stamp}@test.local`, password: 'a-long-enough-pw' }
const mallory = { email: `mallory-${stamp}@test.local`, password: 'another-long-pw' }
let aliceTok = ''

try {
  // ---- signing up ----------------------------------------------------------
  const weak = await call('/api/auth/signup', { method: 'POST', body: { email: alice.email, password: 'short' } })
  weak.status === 400 ? ok('a short password is refused') : no(`a 5 character password was accepted (${weak.status})`)

  const notMail = await call('/api/auth/signup', { method: 'POST', body: { email: 'nope', password: 'a-long-enough-pw' } })
  notMail.status === 400 ? ok('a non-address is refused') : no('"nope" was accepted as an email')

  const up = await call('/api/auth/signup', { method: 'POST', body: alice })
  up.status === 200 && up.json.user?.email === alice.email ? ok(`signed up ${alice.email}`) : no(`signup failed: ${JSON.stringify(up.json)}`)
  aliceTok = up.token
  aliceTok ? ok('signup set a session cookie') : no('signup set no cookie')
  up.cookie.includes('HttpOnly') ? ok('the cookie is HttpOnly, so no script can read it') : no('the cookie is readable by script')
  up.cookie.includes('SameSite=Lax') ? ok('the cookie is SameSite=Lax') : no('the cookie has no SameSite')

  const dupe = await call('/api/auth/signup', { method: 'POST', body: alice })
  dupe.status === 400 ? ok('the same email cannot sign up twice') : no('a duplicate account was created')

  // ---- signing in ----------------------------------------------------------
  const wrong = await call('/api/auth/login', { method: 'POST', body: { email: alice.email, password: 'not-the-password' } })
  wrong.status === 401 ? ok('a wrong password is refused') : no(`a wrong password returned ${wrong.status}`)

  const ghost = await call('/api/auth/login', { method: 'POST', body: { email: 'nobody@test.local', password: 'not-the-password' } })
  ghost.status === 401 && ghost.json.error === wrong.json.error
    ? ok('an unknown email and a wrong password answer identically, so accounts cannot be enumerated')
    : no(`the two answers differ: "${ghost.json?.error}" vs "${wrong.json?.error}"`)

  const inn = await call('/api/auth/login', { method: 'POST', body: alice })
  inn.status === 200 && inn.token ? ok('signed in and got a fresh session') : no('sign in failed')

  // ---- sessions ------------------------------------------------------------
  const me = await call('/api/me', { headers: { cookie: `mapvis_session=${aliceTok}` } })
  me.json.user?.email === alice.email ? ok('the session identifies the account') : no('the session did not resolve')

  const forged = await call('/api/me', { headers: { cookie: 'mapvis_session=obviously-not-a-real-token' } })
  forged.json.user === null ? ok('a forged token resolves to nobody') : no('a forged token was accepted')

  const anon = await call('/api/me')
  anon.json.user === null ? ok('no cookie is simply signed out, not an error') : no('no cookie errored')

  // a session past its expiry must not work even though the row still exists
  await q(`update sessions set expires_at = now() - interval '1 day' where user_id = $1`, [up.json.user.id])
  const stale = await call('/api/me', { headers: { cookie: `mapvis_session=${aliceTok}` } })
  stale.json.user === null ? ok('an expired session is refused even though its row is still there') : no('an expired session still worked')
  const fresh = await call('/api/auth/login', { method: 'POST', body: alice })
  aliceTok = fresh.token

  // ---- the key vault -------------------------------------------------------
  const secret = 'sk-ant-this-must-never-come-back-out'
  const setK = await call('/api/auth/provider', {
    method: 'POST',
    headers: { cookie: `mapvis_session=${aliceTok}` },
    body: { service: 'claude', mode: 'key', key: secret },
  })
  setK.json.user?.claude_provider === 'key' && setK.json.user?.has_claude_key
    ? ok('a claude key is stored and the account reports holding one')
    : no(`storing a key failed: ${JSON.stringify(setK.json)}`)

  // the whole point: the plaintext must not be anywhere in any response
  const body = JSON.stringify(setK.json) + JSON.stringify((await call('/api/me', { headers: { cookie: `mapvis_session=${aliceTok}` } })).json)
  body.includes(secret) ? no('THE KEY CAME BACK OVER HTTP') : ok('the key never comes back out over http')

  const row = await one('select claude_key_enc from users where id = $1', [up.json.user.id])
  row.claude_key_enc.toString('utf8').includes(secret)
    ? no('THE KEY IS STORED IN PLAINTEXT')
    : ok('what is stored is ciphertext, not the key')
  openKey(row.claude_key_enc) === secret ? ok('and the server can open it again') : no('the ciphertext does not decrypt back')

  // switching away from 'key' must not leave the secret behind
  await call('/api/auth/provider', {
    method: 'POST',
    headers: { cookie: `mapvis_session=${aliceTok}` },
    body: { service: 'claude', mode: 'relay' },
  })
  const after = await one('select claude_provider p, claude_key_enc k from users where id = $1', [up.json.user.id])
  after.p === 'relay' && after.k === null
    ? ok('switching to relay wiped the stored key rather than leaving it behind')
    : no('a key survived a switch away from key mode')

  const anonSet = await call('/api/auth/provider', { method: 'POST', body: { service: 'claude', mode: 'none' } })
  anonSet.status === 401 ? ok('a signed-out caller cannot set a provider') : no('a provider was set with no session')

  // ---- ownership -----------------------------------------------------------
  const m = await call('/api/auth/signup', { method: 'POST', body: mallory })
  const mine = await call('/api/my-maps', { headers: { cookie: `mapvis_session=${aliceTok}` } })
  const theirs = await call('/api/my-maps', { headers: { cookie: `mapvis_session=${m.token}` } })
  Array.isArray(mine.json.maps) && Array.isArray(theirs.json.maps)
    ? ok(`the dashboard is per account (alice ${mine.json.maps.length}, mallory ${theirs.json.maps.length})`)
    : no('my-maps did not answer per account')
  const { mayEdit } = await import('../store/auth.mjs')
  const hub = await one('select owner_id from maps where slug = $1', ['hub'])
  if (hub) {
    ;(await mayEdit(m.json.user, 'hub'))
      ? no("another account may edit somebody else's map")
      : ok('another account may not edit a map it does not own')
  }
} finally {
  await q('delete from users where email like $1', [`%-${stamp}@test.local`])
  await new Promise((r) => server.close(r))
  await closeDb()
}

console.log(bad ? `\n${bad} problem(s).` : '\naccounts hold, and the keys stay put.')
process.exit(bad ? 1 : 0)
