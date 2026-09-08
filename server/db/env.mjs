// everything after the first = is the value, and a blank line here never shadows a real environment variable
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let cached = null

/* a real environment variable always wins, or a test can never turn off what .env turns on */
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
