// Passwords and the api-key vault.
//
// Two different jobs that people constantly confuse. A password must be SLOW
// and one-way, because the only thing we ever do is check it. An api key must
// be reversible, because we have to hand the real key to PixelLab, so it is
// encrypted rather than hashed and the master key lives in the environment.
import crypto from 'node:crypto'
import { need } from '../db/env.mjs'

// ---- passwords -------------------------------------------------------------

// scrypt with node's defaults raised: N=2^15 is about 100ms on this class of
// machine, which is slow enough to make a stolen table expensive and fast
// enough that a login does not feel broken.
const N = 32768
const R = 8
const P = 1
const KEYLEN = 64

const scrypt = (pw, salt) =>
  new Promise((res, rej) =>
    crypto.scrypt(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 }, (e, k) => (e ? rej(e) : res(k))),
  )

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('password must be at least 8 characters')
  const salt = crypto.randomBytes(16)
  const key = await scrypt(password, salt)
  // the parameters travel with the hash, so raising them later does not
  // invalidate every existing password
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, salt, key] = String(stored).split('$')
    if (scheme !== 'scrypt') return false
    const want = Buffer.from(key, 'base64')
    const got = await new Promise((res, rej) =>
      crypto.scrypt(
        password,
        Buffer.from(salt, 'base64'),
        want.length,
        { N: +n, r: +r, p: +p, maxmem: 128 * +n * +r * 2 },
        (e, k) => (e ? rej(e) : res(k)),
      ),
    )
    // constant time, so a wrong password cannot be found one byte at a time
    return got.length === want.length && crypto.timingSafeEqual(got, want)
  } catch {
    return false
  }
}

// ---- session and relay tokens ----------------------------------------------

// The token goes to the client once; only its hash is stored, so a stolen
// database cannot be replayed as a login. sha256 and not scrypt on purpose:
// these are 256 bits of real randomness, so there is nothing to brute force
// and a slow hash would only slow every request down.
export const newToken = () => crypto.randomBytes(32).toString('base64url')
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex')

// ---- the api-key vault -----------------------------------------------------

// aes-256-gcm. The nonce is random per encryption and rides in front of the
// ciphertext, the tag rides behind it, so one opaque buffer goes in the
// bytea column and tampering fails loudly instead of decrypting to garbage.
const master = () => {
  const k = Buffer.from(need('KEY_VAULT_SECRET'), 'base64')
  if (k.length !== 32) throw new Error('KEY_VAULT_SECRET must be 32 bytes of base64')
  return k
}

export function sealKey(plaintext) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', master(), iv)
  const body = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()])
  return Buffer.concat([iv, body, c.getAuthTag()])
}

export function openKey(sealed) {
  const b = Buffer.from(sealed)
  const d = crypto.createDecipheriv('aes-256-gcm', master(), b.subarray(0, 12))
  d.setAuthTag(b.subarray(b.length - 16))
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8')
}

// ---- names -----------------------------------------------------------------

// An anchor name is what a member types in python, so it has to be a legal
// identifier there. Used both to validate what an author typed and to derive a
// starting point when migrating an old door that only ever had a label.
export function anchorName(s) {
  const n = String(s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'a$1')
    .slice(0, 48)
  return n || 'anchor'
}

export const isAnchorName = (s) => /^[a-z][a-z0-9_]{0,47}$/.test(String(s))

/* The same rule for a PLACEMENT's name, with one extra fence: it may not look
 * like a machine id. The game resolves a placement reference against the names
 * and the ids together, so that an anchor bound before the thing was named
 * keeps working, and `a55` allowed as a name would let one string mean two
 * objects on the same map. Kept in step with isPlacementName in
 * src/core/mask.ts, which is the copy the editor refuses with. */
export const isPlacementName = (s) =>
  /^[a-z][a-z0-9_]{0,47}$/.test(String(s)) && !/^a[0-9]+$/.test(String(s))
