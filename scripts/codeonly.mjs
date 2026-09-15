// proves a change touched comments only: strip every comment from the committed version and from the working copy, normalise whitespace and compare, where identical means the code is untouched and anything else is printed with the file named so it can be put back
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
const ref = process.argv[3] || 'HEAD'
const only = process.argv[4] || ''

const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })

// strippers: a javascript and typescript scanner that knows strings, templates and regex literals, because a dumber one eats the slashes of a url out of a string and reports a code change that never happened
function stripJS(src) {
  let out = ''
  let i = 0
  const n = src.length
  // what came before decides whether a slash opens a regex or divides
  let prev = ''
  const tmpl = []
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      out += ' '
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      out += c
      i++
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        if (src[i] === q) { i++; break }
        i++
      }
      prev = q
      continue
    }
    if (c === '`') {
      out += c
      i++
      tmpl.push(true)
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        if (src[i] === '$' && src[i + 1] === '{') {
          // an expression hole can hold anything, comments included, so hand it back to the scanner
          let depth = 1
          out += '${'
          i += 2
          let inner = ''
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') { depth--; if (!depth) break }
            inner += src[i]
            i++
          }
          out += stripJS(inner) + '}'
          i++
          continue
        }
        out += src[i]
        if (src[i] === '`') { i++; break }
        i++
      }
      tmpl.pop()
      prev = '`'
      continue
    }
    if (c === '/') {
      // a regex can only start where a value can start
      const canRegex = !/[\w)\]`'"]/.test(prev)
      if (canRegex) {
        let j = i + 1
        let cls = false
        let ok = false
        while (j < n) {
          const e = src[j]
          if (e === '\\') { j += 2; continue }
          if (e === '\n') break
          if (cls) { if (e === ']') cls = false; j++; continue }
          if (e === '[') { cls = true; j++; continue }
          if (e === '/') { ok = true; break }
          j++
        }
        if (ok) {
          j++
          while (j < n && /[a-z]/.test(src[j])) j++
          out += src.slice(i, j)
          i = j
          prev = '/'
          continue
        }
      }
    }
    out += c
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out
}

function stripCSS(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      out += ' '
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      out += c
      i++
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

// python: a docstring is a string and stays; only a real # comment goes
function stripPY(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    const three = src.slice(i, i + 3)
    if (three === '"""' || three === "'''") {
      out += three
      i += 3
      while (i < n && src.slice(i, i + 3) !== three) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        i++
      }
      out += three
      i += 3
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      out += c
      i++
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

const strip = (file, src) => {
  const ext = path.extname(file)
  if (ext === '.css') return stripCSS(src)
  if (ext === '.py') return stripPY(src)
  return stripJS(src)
}

// whitespace is not code: a comment coming out takes a blank line with it
const norm = (s) => s.replace(/\s+/g, ' ').trim()

// ---- the check --------------------------------------------------------------

const EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.css', '.py'])
let changed = only
  ? [only]
  : git(['diff', '--name-only', ref])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
changed = changed.filter((f) => EXT.has(path.extname(f)))

let bad = 0
for (const f of changed) {
  let before
  try {
    before = git(['show', `${ref}:${f}`])
  } catch {
    console.log(`  new     ${f}`)
    continue
  }
  const after = fs.readFileSync(path.join(root, f), 'utf8')
  const a = norm(strip(f, before))
  const b = norm(strip(f, after))
  if (a === b) continue
  bad++
  console.log(`  CODE    ${f}`)
  // say where, so putting it right does not mean reading the whole file
  let k = 0
  while (k < a.length && k < b.length && a[k] === b[k]) k++
  console.log(`          at ${k}: was ...${a.slice(Math.max(0, k - 70), k + 70)}...`)
  console.log(`              now ...${b.slice(Math.max(0, k - 70), k + 70)}...`)
}
console.log(bad ? `\n${bad} of ${changed.length} file(s) changed code.` : `\n${changed.length} file(s), comments only.`)
process.exit(bad ? 1 : 0)
