// Who is asking, and what they are allowed to reach.
//
// A user IS an account. There is no membership graph on purpose: the club's
// plan is one shared login that Ash and every ATC member use, so a team model
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

export async function signIn({ email, password, userAgent = '' }) {
  const clean = String(email || '').trim().toLowerCase()
  const row = await one('select id, password_hash from users where email = $1', [clean])
  // the same answer whether the email is unknown or the password is wrong, so
  // this cannot be used to find out who has an account here
  const okPassword = row ? await verifyPassword(password, row.password_hash) : await verifyPassword(password, 'x$1$1$1$x$x')
  if (!row || !okPassword) throw new Error('that email and password do not match')
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

export const currentUser = (req) => whoIs(tokenFrom(req))

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
// so Ash can see which member burned what.
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
