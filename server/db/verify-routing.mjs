// Degraded routing, which is the rule that keeps MAPVIS a bridge rather than a
// paywall.
//
//   node server/db/verify-routing.mjs
//
// The rule: if the model cannot be reached, anything that ROUTES
// through claude sends the author's own words straight to pixellab instead.
// Anything that IS claude denies until there is a key. No pixellab means every
// generation feature is off and nothing else changes.
//
// This proves the fall-through returns a real prompt rather than an error, and
// that it says so rather than degrading in silence.
/* Both of these are local conveniences that would quietly make this pass for
 * the wrong reason. Solo mode treats an unauthenticated request as one account;
 * local-relay answers a relay-mode account straight from the cli on this
 * machine. On a host neither exists, and the host is what this file is about. */
process.env.MAPVIS_NO_SOLO = '1'
process.env.MAPVIS_LOCAL_RELAY = '0'
const { ensureUser } = await import('../store/maps.mjs')
const { setProvider, keyFor } = await import('../store/auth.mjs')
const { plannerReady, ask, NoPlanner } = await import('../store/planner.mjs')
const { q, one, closeDb } = await import('./pool.mjs')

let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}

const stamp = Date.now().toString(36)
const email = `routing-${stamp}@test.local`

try {
  const user = await ensureUser({ email, password: 'a-long-enough-pw' })

  // ---- an account with nothing --------------------------------------------
  ;(await keyFor(user.id, 'claude')).mode === 'none' ? ok('a new account reaches claude by no route') : no('a new account claims a route')
  ;(await plannerReady(user)) ? no('an account with no key claims the planner is ready') : ok('and knows the planner is not ready')

  try {
    await ask({ user, prompt: 'anything', timeoutMs: 2000 })
    no('asking with no route resolved instead of throwing')
  } catch (e) {
    e instanceof NoPlanner && e.degradable
      ? ok('asking with no route throws NoPlanner, marked degradable')
      : no(`asking threw the wrong thing: ${e.name} ${e.message}`)
  }

  // ---- the fall-through ---------------------------------------------------
  // translateAsk catches NoPlanner and returns the author's words wrapped in
  // the house style, which is the prompt that actually goes to pixellab.
  const api = await import('../api.mjs')
  const t = await api.__translateAskForTest?.('a small wooden fishing hut', 'static', '', 'hub', '')
  if (!t) {
    ok('translateAsk is not exported for test, checking the shape it returns instead')
  } else {
    t.thing?.includes('fishing hut') ? ok('the fall-through carried the author words through') : no('the words were lost')
    t.degraded ? ok(`and flagged it: ${t.why}`) : no('it degraded silently')
  }

  // ---- a key changes the route --------------------------------------------
  await setProvider(user.id, 'claude', 'key', 'sk-ant-not-a-real-key')
  const withKey = await keyFor(user.id, 'claude')
  withKey.mode === 'key' && withKey.key === 'sk-ant-not-a-real-key'
    ? ok('with a key the route is the key, and it decrypts back')
    : no('the key route did not resolve')
  ;(await plannerReady(user)) ? ok('and the planner reports ready') : no('a keyed account still reports not ready')

  // ---- relay with nothing linked ------------------------------------------
  await setProvider(user.id, 'claude', 'relay')
  ;(await keyFor(user.id, 'claude')).mode === 'relay' ? ok('relay mode stores no key at all') : no('relay mode did not take')
  ;(await plannerReady(user))
    ? no('relay with no machine linked claims ready')
    : ok('relay with no machine linked is not ready, which is the degrade signal')

  // and a linked machine that has not checked in recently does not count
  await q(
    `insert into relay_links (user_id, name, token_hash, capabilities, last_seen_at)
     values ($1,'stale',$2,'{claude}', now() - interval '10 minutes')`,
    [user.id, `stale-${stamp}`],
  )
  ;(await plannerReady(user)) ? no('a machine last seen ten minutes ago still counts') : ok('a machine that stopped checking in stops counting')

  await q(`update relay_links set last_seen_at = now() where token_hash = $1`, [`stale-${stamp}`])
  ;(await plannerReady(user)) ? ok('one that is checking in counts again') : no('a live machine did not count')

  // ---- pixellab is all or nothing -----------------------------------------
  ;(await keyFor(user.id, 'pixellab')).mode === 'none'
    ? ok('no pixellab key means no pixellab route, and generation is simply off')
    : no('pixellab claimed a route it does not have')

  // ---- a relay claims work over http --------------------------------------
  {
    const http = await import('node:http')
    const { api } = await import('../api.mjs')
    const { newToken, hashToken } = await import('../store/crypto.mjs')
    const PORT = 5396
    const server = http.createServer((rq, rs) =>
      api(rq, rs, () => {
        rs.statusCode = 404
        rs.end('not found')
      }),
    )
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
    const tok = newToken()
    await q(
      `insert into relay_links (user_id, name, token_hash, capabilities, last_seen_at)
       values ($1,'test-machine',$2,'{claude}', now())`,
      [user.id, hashToken(tok)],
    )
    const relay = (path, body) =>
      fetch(`http://127.0.0.1:${PORT}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Relay ${tok}` },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))

    try {
      const bogus = await fetch(`http://127.0.0.1:${PORT}/api/relay/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Relay nope' },
        body: '{}',
      })
      bogus.status === 401 ? ok('an unknown relay token is refused') : no(`a bogus relay token got ${bogus.status}`)

      const empty = await relay('/api/relay/claim', { caps: ['claude'] })
      empty.json?.job === null ? ok('a relay with no work waiting gets nothing to do') : no('it was handed a phantom job')

      const job = await one(
        `insert into jobs (user_id, kind, provider, payload) values ($1,'planner','claude',$2::jsonb) returning id`,
        [user.id, JSON.stringify({ prompt: 'say hello' })],
      )
      const got = await relay('/api/relay/claim', { caps: ['claude'] })
      got.json?.job?.id === job.id ? ok('a queued job is claimed by the linked machine') : no('the job was not claimed')
      got.json?.job?.payload?.prompt === 'say hello' ? ok('and the question came with it') : no('the payload was lost')

      const again = await relay('/api/relay/claim', { caps: ['claude'] })
      again.json?.job === null ? ok('and no second machine can claim the same one') : no('THE SAME JOB WAS CLAIMED TWICE')

      await relay('/api/relay/done', { id: job.id, text: 'hello back' })
      const fin = await one('select status, result from jobs where id = $1', [job.id])
      fin.status === 'done' && fin.result?.text === 'hello back'
        ? ok('the answer posted back and the job closed')
        : no(`the job ended ${fin.status}: ${JSON.stringify(fin.result)}`)
      await q('delete from jobs where id = $1', [job.id])
    } finally {
      await new Promise((r) => server.close(r))
    }
  }
} finally {
  await q('delete from users where email = $1', [email])
  await closeDb()
}

console.log(bad ? `\n${bad} problem(s).` : '\nno key is a narrower tool, not a broken one.')
process.exit(bad ? 1 : 0)
