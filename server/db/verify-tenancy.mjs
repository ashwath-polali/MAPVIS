// one account cannot see, open or steer another account's work, and these checks run with the owner deliberately unset because that is what a fresh deployment is: ownedBy and mayUseHouse both ended `if (!owner) return true`, which handed the game's ocean and the house hand to every new account
import http from 'node:http'

let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}

/* the owner is cleared before the api loads, because env() reads a merged object once and what is checked is exactly what happens when nothing is configured */
process.env.OCEAN_OWNER = ''
process.env.HOUSE_STYLE_OWNER = ''
process.env.BOOTSTRAP_EMAIL = ''
/* and solo mode off, because an unauthenticated loopback request is deliberately treated as one named account, which is wrong here where the question is how the tool behaves when there are other people */
process.env.MAPVIS_NO_SOLO = '1'

const { api } = await import('../api.mjs')
const { q, closeDb } = await import('./pool.mjs')
const { platformOn } = await import('../store/platform.mjs')

const PORT = 5398
const server = http.createServer((req, res) =>
  api(req, res, () => {
    res.statusCode = 404
    res.end('not found')
  }),
)
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const call = async (path, opts = {}, tries = 4) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (r.status === 429 && tries > 0) {
    const after = Number(r.headers.get('retry-after') || 1)
    await new Promise((res) => setTimeout(res, Math.max(250, after * 1000)))
    return call(path, opts, tries - 1)
  }
  let json = null
  try {
    json = await r.json()
  } catch {
    /* a body that is not json is the answer, and the caller reads the code */
  }
  const cookie = r.headers.get('set-cookie') || ''
  return { status: r.status, json, token: (cookie.match(/mapvis_session=([^;]+)/) || [])[1] }
}

const stamp = Date.now().toString(36)
const one = { email: `zz-one-${stamp}@test.local`, password: 'a-long-enough-pw' }
const two = { email: `zz-two-${stamp}@test.local`, password: 'another-long-pw' }
const as = (tok) => ({ headers: { cookie: `mapvis_session=${tok}` } })

let t1 = ''
let t2 = ''

try {
  if (!platformOn()) {
    console.log('  note  no database configured, so there are no accounts to keep apart. Nothing checked.')
    process.exit(0)
  }

  const a = await call('/api/auth/signup', { method: 'POST', body: one })
  const b = await call('/api/auth/signup', { method: 'POST', body: two })
  t1 = a.token || ''
  t2 = b.token || ''
  t1 && t2 ? ok('two accounts signed up') : no(`could not make two accounts (${a.status}, ${b.status})`)

  // the ocean, which is row 1, and with nobody configured as its owner neither account may be handed it, because not knowing who owns a thing is not a reason to give it away
  {
    const w1 = await call('/api/world', as(t1))
    const w2 = await call('/api/world', as(t2))
    w1.status === 200 && w2.status === 200 ? ok('both accounts can open an ocean') : no(`opening an ocean answered ${w1.status} and ${w2.status}`)

    const m1 = await call('/api/world/mine', as(t1))
    const m2 = await call('/api/world/mine', as(t2))
    m1.json?.game === false && m2.json?.game === false
      ? ok('and with no owner configured, neither of them is told the game ocean is theirs')
      : no(`the game ocean was claimed by a stranger: ${JSON.stringify([m1.json, m2.json])}`)

    /* the real test is what is in it, so this asks whether either account can see a place it did not put there, which is how the hub and the ATC island leaked */
    const places1 = (w1.json?.places || []).map((p) => p.name)
    const places2 = (w2.json?.places || []).map((p) => p.name)
    places1.length === 0 && places2.length === 0
      ? ok('and each opens an EMPTY ocean rather than the one the game sails')
      : no(`a stranger's ocean carried places: ${JSON.stringify([places1, places2])}`)

    /* and they are not each other's either */
    const rows = await q(
      `select w.id, u.email from world w join users u on u.id = w.owner_id where u.email in ($1, $2)`,
      [one.email, two.email],
    )
    const ids = new Set(rows.rows.map((r) => r.id))
    ids.size === rows.rows.length && !ids.has(1)
      ? ok('each account got a world row of its own, and neither is row 1')
      : no(`the two accounts share a world row, or were given the game's: ${JSON.stringify(rows.rows)}`)
  }

  // the house hand is one account's style, granted by them, and with nobody configured it belongs to nobody rather than to everybody
  {
    const s1 = await call('/api/styles', as(t1))
    const s2 = await call('/api/styles', as(t2))
    const house1 = (s1.json?.cards || []).filter((c) => c.house)
    const house2 = (s2.json?.cards || []).filter((c) => c.house)
    house1.length === 0 && house2.length === 0
      ? ok('the house hand is offered to neither account, because neither was granted it')
      : no(`the house hand was offered to a stranger: ${JSON.stringify([house1, house2])}`)
  }

  // the map list, whose open form is the game's door registry and stays open because a door names a target by slug and the game signs in as nobody, while the authoring picker must never be dressed out of it
  {
    const mine1 = await call('/api/v1/maps?mine=1', as(t1))
    mine1.status === 200 && (mine1.json?.maps || []).length === 0
      ? ok('an account with no maps is offered no maps to place')
      : no(`a new account was offered ${(mine1.json?.maps || []).length} map(s) to place`)

    const nobody = await call('/api/v1/maps?mine=1')
    nobody.status === 401 ? ok('and the scoped list refuses a request with nobody signed in') : no(`the scoped list answered ${nobody.status} to nobody`)

    /* the open one still answers, because the game depends on it */
    const open = await call('/api/v1/maps')
    open.status === 200 ? ok("while the game's own registry stays open, which is what doors resolve against") : no(`the registry answered ${open.status}`)
  }

  // and writes, where the door gate is the one that was already right, checked here so a later change to the read side cannot quietly take it with it
  {
    const stolen = await call('/api/doc', { method: 'POST', body: { id: 'hub', doc: '{}' }, ...as(t2) })
    stolen.status === 403
      ? ok("and one account cannot write another's map, which the door gate already refused")
      : no(`a stranger wrote to the hub and got ${stolen.status}`)
    const read = await call('/api/library/hub', as(t2))
    read.status === 403 ? ok('nor read its library') : no(`a stranger read the hub library and got ${read.status}`)
  }
} catch (e) {
  no('the checks themselves threw: ' + String((e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e)))
} finally {
  try {
    await q('delete from world where owner_id in (select id from users where email in ($1, $2))', [one.email, two.email])
    await q('delete from users where email in ($1, $2)', [one.email, two.email])
  } catch {
    /* an account that was never made needs no cleaning up */
  }
  server.close()
  await closeDb()
}

console.log(bad ? `\n${bad} problem(s).` : "\nan account sees its own work, and a missing setting is not permission.")
process.exit(bad ? 1 : 0)
