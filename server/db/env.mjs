// A three-line .env reader, because one dependency for KEY=value is silly.
// Everything after the first = is the value, so a connection string with an =
// in its query survives. A blank in .env never shadows a real environment
// variable, which is what makes the same code work on a laptop and on a host.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let cached = null

export function env() {
  if (cached) return cached
  const out = { ...process.env }
  const f = path.join(ROOT, '.env')
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const i = s.indexOf('=')
      if (i < 1) continue
      const v = s.slice(i + 1).trim()
      if (v) out[s.slice(0, i).trim()] = v
    }
  }
  return (cached = out)
}

export function need(key) {
  const v = env()[key]
  if (!v) throw new Error(`${key} is not set in .env or the environment`)
  return v
}
