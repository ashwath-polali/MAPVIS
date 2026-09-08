// checks each piece independently and keeps going after a failure, so one missing secret hides nothing else
import pg from 'pg'
import { env } from './env.mjs'
import { store } from '../store/blobs.mjs'

const E = env()
let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}
const skip = (m) => console.log(`  --    ${m}`)

async function db(label, url) {
  if (!url) return skip(`${label}: not set`)
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15000 })
  try {
    await c.connect()
    const n = await c.query("select count(*)::int n from information_schema.tables where table_schema = 'public'")
    const v = await c.query('select version() v')
    ok(`${label}: ${n.rows[0].n} tables, ${v.rows[0].v.split(' ').slice(0, 2).join(' ')}`)
  } catch (e) {
    no(`${label}: ${e.message}`)
  } finally {
    try {
      await c.end()
    } catch {}
  }
}

console.log('postgres')
await db('direct', E.DATABASE_URL)
await db('pooled', E.DATABASE_POOLED_URL)

console.log('object storage')
try {
  const s = store()
  const key = '.doctor/roundtrip.txt'
  const body = Buffer.from(`written by doctor at ${process.pid}`)
  await s.put(key, body, 'text/plain')
  const back = await s.get(key)
  if (Buffer.compare(back, body) !== 0) throw new Error('what came back is not what went in')
  const listed = await s.list('.doctor/')
  await s.del(key)
  ok(`${s.kind}: put, get, list (${listed.length}), delete all round-tripped on bucket ${s.bucket}`)
} catch (e) {
  no(`object storage: ${e.message}`)
}

console.log('secrets')
for (const k of ['KEY_VAULT_SECRET']) (E[k] ? ok : no)(`${k}${E[k] ? '' : ' is not set'}`)

console.log(bad ? `\n${bad} problem(s).` : '\nall good.')
process.exit(bad ? 1 : 0)
