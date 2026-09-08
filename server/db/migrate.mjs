// one transaction per file, and the direct DATABASE_URL not the pooled one, since schema wants a real session
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

// A three-line .env reader, because one dependency for KEY=value is silly.
// Everything after the first = is the value, so a connection string with an =
// in its query survives.
export function env() {
  const out = { ...process.env }
  const f = path.join(ROOT, '.env')
  if (!fs.existsSync(f)) return out
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i < 1) continue
    // an explicit blank in .env should not shadow a real environment variable
    const v = s.slice(i + 1).trim()
    if (v) out[s.slice(0, i).trim()] = v
  }
  return out
}

const E = env()
if (!E.DATABASE_URL) throw new Error('no DATABASE_URL in .env or the environment')

const client = new pg.Client({ connectionString: E.DATABASE_URL })
await client.connect()

const who = await client.query('select current_database() db, version() v')
console.log(`connected  ${who.rows[0].db}  ${who.rows[0].v.split(',')[0]}`)

await client.query(`
  create table if not exists schema_migrations (
    name        text primary key,
    applied_at  timestamptz not null default now()
  )`)

const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name))
const files = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith('.sql'))
  .sort()

if (process.argv.includes('--status')) {
  for (const f of files) console.log(`  ${done.has(f) ? 'applied' : '    new'}  ${f}`)
  await client.end()
  process.exit(0)
}

let ran = 0
for (const f of files) {
  if (done.has(f)) {
    console.log(`  skip     ${f}`)
    continue
  }
  const sql = fs.readFileSync(path.join(HERE, f), 'utf8')
  try {
    await client.query('begin')
    await client.query(sql)
    await client.query('insert into schema_migrations (name) values ($1)', [f])
    await client.query('commit')
    console.log(`  applied  ${f}`)
    ran++
  } catch (e) {
    await client.query('rollback')
    console.error(`  FAILED   ${f}\n  ${e.message}`)
    await client.end()
    process.exit(1)
  }
}

const tables = await client.query(`
  select table_name from information_schema.tables
  where table_schema = 'public' order by table_name`)
console.log(`${ran} applied. tables now: ${tables.rows.map((r) => r.table_name).join(', ')}`)
await client.end()
