// a user IS an account with no membership graph, because the club's plan is one shared login; the crypto is in crypto.mjs and is standard rather than clever
import { q, one, many } from '../db/pool.mjs'
import { hashPassword, verifyPassword, newToken, hashToken, sealKey, openKey } from './crypto.mjs'
import { env } from '../db/env.mjs'

const DAYS = 30
const COOKIE = 'mapvis_session'
// set when somebody signs out on purpose, read only by solo mode
const OUT_COOKIE = 'mapvis_out'

// Never select the key columns. A shape with a name says what may leave the
// server much more reliably than remembering to delete fields at each caller.
const PUBLIC = `id, email, display_name, claude_provider, pixellab_provider,
                (claude_key_enc is not null)   as has_claude_key,
                (pixellab_key_enc is not null) as has_pixellab_key,
                created_at`

// ---- accounts --------------------------------------------------------------

export async function signUp({ email, password, displayName = '' }) {
  const clean = String(email || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new Error('that is not an email address')
  if (String(password || '').length < 8) throw new Error('a password needs at least 8 characters')
  if (await one('select id from users where email = $1', [clean])) throw new Error('that email already has an account')
  return one(
    `insert into users (email, password_hash, display_name) values ($1,$2,$3) returning ${PUBLIC}`,
    [clean, await hashPassword(password), String(displayName || '').slice(0, 80)],
  )
}

/* backoff and not a lockout, because a hard lock lets anybody who knows an email address lock its owner out by failing on purpose */
const backoffMs = (n) => (n < 3 ? 0 : Math.min(300000, 4000 * 2 ** (n - 3)))

export async function signIn({ email, password, userAgent = '' }) {
  const clean = String(email || '').trim().toLowerCase()
  const row = await one(
    'select id, password_hash, failed_logins, last_failed_at from users where email = $1',
    [clean],
  )

  if (row) {
    const wait = backoffMs(row.failed_logins) - (Date.now() - +new Date(row.last_failed_at || 0))
    if (wait > 0) {
      const s = Math.ceil(wait / 1000)
      throw new Error(`too many attempts · try again in ${s < 60 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`}`)
    }
  }

  /* The same work whether the email exists or not. Answering an unknown address
   * instantly while a real one takes 100ms of scrypt would say which addresses
   * have accounts here just as loudly as a different error message would. */
  const okPassword = row
    ? await verifyPassword(password, row.password_hash)
    : await verifyPassword(password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA')

  if (!row || !okPassword) {
    if (row) await q('update users set failed_logins = failed_logins + 1, last_failed_at = now() where id = $1', [row.id])
    // one message for both cases, so this cannot enumerate who has an account
    throw new Error('that email and password do not match')
  }

  await q('update users set failed_logins = 0, last_failed_at = null where id = $1', [row.id])
  return { token: await openSession(row.id, userAgent), user: await getUser(row.id) }
}

export const getUser = (id) => one(`select ${PUBLIC} from users where id = $1`, [id])

// ---- sessions --------------------------------------------------------------

export async function openSession(userId, userAgent = '') {
  const token = newToken()
  await q(
    `insert into sessions (user_id, token_hash, user_agent, expires_at)
     values ($1,$2,$3, now() + ($4 || ' days')::interval)`,
    [userId, hashToken(token), String(userAgent).slice(0, 200), String(DAYS)],
  )
  return token
}

export async function whoIs(token) {
  if (!token) return null
  const s = await one(
    'select user_id from sessions where token_hash = $1 and expires_at > now()',
    [hashToken(token)],
  )
  return s ? getUser(s.user_id) : null
}

export const closeSession = (token) =>
  token ? q('delete from sessions where token_hash = $1', [hashToken(token)]) : null

// expired rows are dead weight and a small privacy leak, since they record what
// browser was used and when
export const sweepSessions = () => q('delete from sessions where expires_at < now()')

// ---- reading the request ---------------------------------------------------

export function tokenFrom(req) {
  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === COOKIE) return decodeURIComponent(v.join('='))
  }
  return null
}

// signing in is also the end of having deliberately signed out, so the crumb
// that suppresses solo mode is dropped here
export function setSessionCookie(res, token) {
  // httpOnly so no script can read it, sameSite=Lax so it is not sent from
  // another site's form, secure once there is a domain in front of it
  const secure = env().MAPVIS_INSECURE_COOKIE === '1' ? '' : '; Secure'
  res.setHeader('Set-Cookie', [
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; SameSite=Lax${secure}`,
    `${OUT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`,
  ])
}

export const clearSessionCookie = (res) =>
  res.setHeader('Set-Cookie', [
    `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    // remembers that this was a real sign-out, so solo mode does not undo it
    `${OUT_COOKIE}=1; Path=/; Max-Age=${DAYS * 86400}; SameSite=Lax`,
  ])

/* MAPVIS_SOLO treats an unauthenticated request as a named account, so an owned map does not lock its author out of their own signed-out laptop */
/* an explicit sign-out beats that convenience, or the landing page bounces back to the dashboard on localhost and nowhere else */
const optedOut = (req) => /(?:^|;\s*)mapvis_out=1(?:;|$)/.test(req.headers?.cookie || '')

/* every irreversible route asks this and not currentUser, because a delete with no session was authorised as the solo account and destroyed a real map */
export const sessionUser = (req) => whoIs(tokenFrom(req))

export async function currentUser(req) {
  const real = await whoIs(tokenFrom(req))
  if (real) return real
  if (optedOut(req)) return null
  const solo = soloMode()
  if (!solo || !fromThisMachine(req)) {
    if (solo) sayRefused('the request did not come from this machine')
    return null
  }
  return one(`select ${PUBLIC} from users where email = $1`, [String(solo).toLowerCase()])
}

/* Solo mode is a development convenience and nothing else: it treats an
 * unauthenticated request as one named account. Four fences, because a deploy
 * that shipped .env once signed every anonymous visitor in as the club account.
 * It is off unless MAPVIS_SOLO names an account, off wherever a serverless
 * runtime is detected, off whenever NODE_ENV says production on any host at
 * all, and off for any request that did not come from the loopback address. */
export const soloMode = () => {
  const E = env()
  if (E.MAPVIS_NO_SOLO === '1') return null
  if (!E.MAPVIS_SOLO) return null
  if (E.VERCEL || E.AWS_LAMBDA_FUNCTION_NAME || E.MAPVIS_HOSTED === '1') {
    sayRefused('a hosted runtime was detected')
    return null
  }
  if (E.NODE_ENV === 'production') {
    sayRefused('NODE_ENV is production')
    return null
  }
  return E.MAPVIS_SOLO
}

/* ::1, 127.0.0.0/8 and the ipv4-mapped spelling of the same. A unix socket has
 * no address at all and is local by construction. */
const LOOPBACK = /^(::1|::ffff:127\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+)$/
const fromThisMachine = (req) => {
  const a = req?.socket?.remoteAddress
  return !a || LOOPBACK.test(a)
}

/* said once and not per request, or a signed-out tab prints a line a second */
let refusedOnce = false
function sayRefused(why) {
  if (refusedOnce) return
  refusedOnce = true
  console.warn(`[auth] MAPVIS_SOLO is set and was refused: ${why}. Sign in normally.`)
}

// ---- what an account may reach ---------------------------------------------

/* Ownership, asked once, in one place. Everything that mutates a map goes
 * through this, because "the editor only shows your maps" is a UI convenience
 * and not a rule anybody has to obey. */
export async function mayEdit(user, slug) {
  if (!user) return false
  const m = await one('select owner_id from maps where slug = $1', [slug])
  // a map nobody owns yet is the one about to be created by whoever is asking
  return !m || m.owner_id === user.id
}

// ---- the key vault ---------------------------------------------------------

/* each account says how it reaches each service: 'key' uses the stored ciphertext, 'relay' is a linked machine, 'none' is the degraded path */
export async function setProvider(userId, service, mode, key) {
  if (!['claude', 'pixellab'].includes(service)) throw new Error('unknown service')
  if (!['key', 'relay', 'none'].includes(mode)) throw new Error('unknown provider')
  const col = service === 'claude' ? 'claude' : 'pixellab'
  if (mode === 'key') {
    if (!String(key || '').trim()) throw new Error('that mode needs a key')
    await q(`update users set ${col}_provider = 'key', ${col}_key_enc = $2 where id = $1`, [userId, sealKey(key.trim())])
  } else {
    // leaving a key behind on a switch to relay or none would mean the account
    // still holds a secret it no longer claims to use
    await q(`update users set ${col}_provider = $2, ${col}_key_enc = null where id = $1`, [userId, mode])
  }
  return getUser(userId)
}

/* a null key is the signal to degrade rather than fail: no pixellab means no generation, no claude means the author's own words go straight through */
export async function keyFor(userId, service) {
  const col = service === 'claude' ? 'claude' : 'pixellab'
  const row = await one(`select ${col}_provider p, ${col}_key_enc k from users where id = $1`, [userId])
  if (!row) return null
  if (row.p === 'key' && row.k) return { mode: 'key', key: openKey(row.k) }
  /* a linked machine lends its key, because pixellab is called from here directly and relay alone meant a green dot and NoPixellab on every press */
  if (row.p === 'relay') return { mode: 'relay', key: row.k ? openKey(row.k) : null }
  return { mode: 'none', key: null }
}

/* The key a linked machine lends, sealed like a pasted one. Only into an account
 * that chose relay for that service: a chosen key or a chosen none is not
 * overridden by whatever machine happens to poll. */
export async function lendKey(userId, service, key) {
  if (!['claude', 'pixellab'].includes(service)) throw new Error('unknown service')
  const k = String(key || '').trim()
  if (!k) return
  const col = service === 'claude' ? 'claude' : 'pixellab'
  await q(`update users set ${col}_key_enc = $2 where id = $1 and ${col}_provider = 'relay'`, [userId, sealKey(k)])
}

// ---- the ledger ------------------------------------------------------------

// Every spend, so a shared club account has a record instead of a surprise, and
// so the account holder can see which member burned what.
export const noteSpend = ({ userId, mapId, jobId, provider, endpoint, cost }) =>
  q(
    `insert into usage (user_id, map_id, job_id, provider, endpoint, cost_usd)
     values ($1,$2,$3,$4,$5,$6)`,
    [userId, mapId || null, jobId || null, provider, String(endpoint).slice(0, 80), Number(cost) || 0],
  )

export const spendSince = (userId, days = 30) =>
  many(
    `select provider, endpoint, count(*)::int n, sum(cost_usd)::float total
     from usage where user_id = $1 and at > now() - ($2 || ' days')::interval
     group by provider, endpoint order by total desc`,
    [userId, String(days)],
  )
