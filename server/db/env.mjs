// A three-line .env reader, because one dependency for KEY=value is silly.
// Everything after the first = is the value, so a connection string with an =
// in its query survives. A blank in .env never shadows a real environment
// variable, which is what makes the same code work on a laptop and on a host.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let cached = null

/* A REAL ENVIRONMENT VARIABLE ALWAYS WINS over a line in .env.
 *
 * That ordering is not a preference. .env is the local fallback for values
 * nobody has set; a variable that IS set was set deliberately, by a host, by a
 * CI job, or by a test that needs a local convenience turned off. Letting the
 * file override it means a test can never disable something .env enables, and
 * a deploy can never override a file that got committed by accident.
 *
 * Written the wrong way round first, and found by a test that kept passing for
 * the wrong reason. */
export function env() {
  if (cached) return cached
  const fromFile = {}
  const f = path.join(ROOT, '.env')
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const i = s.indexOf('=')
      if (i < 1) continue
      const v = s.slice(i + 1).trim()
      if (v) fromFile[s.slice(0, i).trim()] = v
    }
  }
  // the file fills in what the environment has not already said
  return (cached = { ...fromFile, ...process.env })
}

export function need(key) {
  const v = env()[key]
  if (!v) throw new Error(`${key} is not set in .env or the environment`)
  return v
}
