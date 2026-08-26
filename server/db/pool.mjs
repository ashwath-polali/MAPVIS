// One postgres pool for the whole process.
//
// Uses the POOLED connection string, because a serverless function opens a
// connection on every cold start and neon's pooler is what keeps a few hundred
// of those from exhausting the database. max is deliberately small for the same
// reason: many small pools beat a few large ones when the process count is not
// ours to control.
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
