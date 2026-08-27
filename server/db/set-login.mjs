// Change an account's email or password.
//
//   node server/db/set-login.mjs <current-email> [new-email] [new-password]
//
// Exists because the bootstrap account is created automatically by the import
// scripts with a placeholder login, and that account owns every map. Leaving a
// known default on the row that owns everything is not a thing to leave.
//
// Changing the password invalidates nothing else on purpose: sessions are rows,
// so anyone already signed in stays signed in. Pass --out to end them all.
import { q, one, closeDb } from './pool.mjs'
import { hashPassword } from '../store/crypto.mjs'

const [current, nextEmail, nextPassword] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const alsoSignOut = process.argv.includes('--out')
if (!current) throw new Error('usage: node server/db/set-login.mjs <current-email> [new-email] [new-password] [--out]')

const user = await one('select id, email from users where email = $1', [String(current).toLowerCase()])
if (!user) throw new Error(`no account with the email ${current}`)

if (nextEmail) {
  const clean = String(nextEmail).trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new Error('that is not an email address')
  const taken = await one('select id from users where email = $1 and id <> $2', [clean, user.id])
  if (taken) throw new Error('another account already uses that email')
  await q('update users set email = $2 where id = $1', [user.id, clean])
  console.log(`email  ${user.email} -> ${clean}`)
}

if (nextPassword) {
  if (String(nextPassword).length < 8) throw new Error('a password needs at least 8 characters')
  await q('update users set password_hash = $2, failed_logins = 0, last_failed_at = null where id = $1', [
    user.id,
    await hashPassword(nextPassword),
  ])
  console.log('password set')
}

if (alsoSignOut) {
  const gone = await q('delete from sessions where user_id = $1', [user.id])
  console.log(`${gone.rowCount} session(s) ended`)
}

const now = await one('select email, claude_provider, pixellab_provider from users where id = $1', [user.id])
const owns = await one('select count(*)::int n from maps where owner_id = $1', [user.id])
console.log(`${now.email} · claude ${now.claude_provider} · pixellab ${now.pixellab_provider} · owns ${owns.n} map(s)`)
await closeDb()
