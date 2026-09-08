// the pooled string with a deliberately small max, because the process count is not ours on serverless
import pg from 'pg'
import { env } from './env.mjs'

let pool = null

export function db() {
  if (pool) return pool
  const E = env()
  const connectionString = E.DATABASE_POOLED_URL || E.DATABASE_URL
  if (!connectionString) throw new Error('no DATABASE_POOLED_URL or DATABASE_URL')
  pool = new pg.Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 15000,
  })
  // a dead idle client must never take the process down with it
  pool.on('error', (e) => console.error('[db] idle client error:', e.message))
  return pool
}

export const q = (text, params) => db().query(text, params)

export const one = async (text, params) => (await q(text, params)).rows[0] || null

export const many = async (text, params) => (await q(text, params)).rows

// Run fn inside a transaction on a single client. Rolls back on any throw, so
// a half-written map cannot exist: either every row and blob reference lands or
// none of them do.
export async function tx(fn) {
  const c = await db().connect()
  try {
    await c.query('begin')
    const out = await fn(c)
    await c.query('commit')
    return out
  } catch (e) {
    try {
      await c.query('rollback')
    } catch {}
    throw e
  } finally {
    c.release()
  }
}

export async function closeDb() {
  if (pool) await pool.end()
  pool = null
}
