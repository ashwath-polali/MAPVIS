// Who is asking, and what they are allowed to reach.
//
// A user IS an account. There is no membership graph on purpose: the club's
// plan is one shared login that every club member uses, so a team model
// would be machinery serving nobody.
//
// The parts that are easy to get wrong are in crypto.mjs and are the standard
// implementations, not clever ones: scrypt for passwords, timing-safe compare,
// and session tokens that are 256 bits of real randomness stored only as their
// hash, so a stolen database cannot be replayed as a login.
import { q, one, many } from '../db/pool.mjs'
import { hashPassword, verifyPassword, newToken, hashToken, sealKey, openKey } from './crypto.mjs'
import { env } from '../db/env.mjs'

const DAYS = 30
const COOKIE = 'mapvis_session'

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

/* How long this account has to wait after failing. Doubles each time from four
 * seconds and stops at five minutes, so three fat-fingered attempts cost
 * nothing a human notices and a thousand guesses take a week.
 *
 * Backoff and not a lockout, on purpose: a hard lock lets anybody who knows an
 * email address lock its owner out by failing on purpose. */
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

export function setSessionCookie(res, token) {
  // httpOnly so no script can read it, sameSite=Lax so it is not sent from
  // another site's form, secure once there is a domain in front of it
  const secure = env().MAPVIS_INSECURE_COOKIE === '1' ? '' : '; Secure'
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; SameSite=Lax${secure}`,
  )
}

export const clearSessionCookie = (res) =>
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`)

/* Who this request is, and the one deliberate exception to it.
 *
 * MAPVIS_SOLO names an account that an unauthenticated request is treated as.
 * It exists because the tool has to stay usable the way it has always been
 * used: one person, one laptop, no login screen in front of the map they are
 * in the middle of drawing. Without it, the moment a map has an owner its own
 * author is locked out of it by their own signed-out browser.
 *
 * It lives only in .env, which is gitignored and never deployed. On a host the
 * variable is absent and every request is exactly who its cookie says it is.
 * Nothing else in the code knows this happened, so there is one place to look
 * when asking whether it is on. */
export async function currentUser(req) {
  const real = await whoIs(tokenFrom(req))
  if (real) return real
  const solo = soloMode()
  return solo ? await one(`select ${PUBLIC} from users where email = $1`, [String(solo).toLowerCase()]) : null
}

/* SOLO MODE CANNOT EXIST ON A HOST, whatever any file says.
 *
 * The first deploy shipped .env by accident, so MAPVIS_SOLO went up with it and
 * /api/me answered as the club account to a request carrying no cookie: every
 * anonymous visitor was signed in as ATC. .vercelignore stops that file going
 * up again, and this stops it mattering if one ever does.
 *
 * A convenience that is safe on one laptop and catastrophic on a server should
 * not be one config line away from the wrong one. Refusing it wherever a
 * serverless runtime is detected costs nothing and closes the whole class.
 *
 * MAPVIS_NO_SOLO is how the auth test turns it off locally, so it can prove the
 * door holds without the convenience quietly propping it open. */
export const soloMode = () => {
  const E = env()
  if (E.VERCEL || E.AWS_LAMBDA_FUNCTION_NAME || E.MAPVIS_HOSTED === '1') return null
  return E.MAPVIS_NO_SOLO === '1' ? null : E.MAPVIS_SOLO || null
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

/* Each account says how it reaches each service. 'key' uses the stored
 * ciphertext, 'relay' is wired to a linked machine and stores no key at all,
 * 'none' is the degraded path.
 *
 * The club account ships relay/relay. Switching either to 'key' and pasting one
 * severs the machine link for that service, which is the whole graduation story
 * and is a dropdown rather than a migration. */
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

/* The real key, for server code about to call the service. Returns null when
 * this account has none, which is the signal to degrade rather than fail: no
 * PixelLab means generation is unavailable, no Claude means the router features
 * fall through and send the author's own words straight to PixelLab. */
export async function keyFor(userId, service) {
  const col = service === 'claude' ? 'claude' : 'pixellab'
  const row = await one(`select ${col}_provider p, ${col}_key_enc k from users where id = $1`, [userId])
  if (!row) return null
  if (row.p === 'key' && row.k) return { mode: 'key', key: openKey(row.k) }
  if (row.p === 'relay') return { mode: 'relay', key: null }
  return { mode: 'none', key: null }
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
