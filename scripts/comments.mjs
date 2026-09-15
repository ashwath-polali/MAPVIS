// rewrites a comment without touching a byte of code, because the rewriter only ever sees the words, so a sweep of thousands cannot change behaviour and codeonly.mjs proves it; one is listed when it runs past one line, carries an em-dash, or names a person, a model, a working session or a document
import fs from 'node:fs'
import path from 'node:path'

// a comment that is an instruction to a tool is not prose and is never rewritten
const DIRECTIVE =
  /^\s*(?:\/\/|\/\*|#)\s*(?:@ts-|@type\b|@vitest|eslint|prettier-|c8\s|istanbul|@license|@preserve|globals\b|sourceMappingURL|noinspection|deno-|biome-|oxlint-|#!)/

const BANNED =
  /\b(Ash|Ashwath|Wiseman|Claude|ChatGPT|Copilot|Anthropic|OpenAI)\b|\bGPT-?[0-9]?\b|BRIEF-[A-Z0-9-]+|\bwave ?[0-9]\b|\bENGINE-[0-9]\b|\bMAPVIS-W[0-9]\b|\bthis session\b|\bthe session\b|\blast session\b|\ba session\b|\bWORDS-1\b|\bthe strategy session\b|\bAI\b|\ban agent\b|\bthe agent\b/

const hasDash = (s) => /[—–]/.test(s)
const needsWork = (text, lines) => lines > 1 || hasDash(text) || BANNED.test(text)

// scanning: every comment span in a javascript-family source, with strings, templates and regex literals skipped so a double slash inside a url is never mistaken for one
function scanJS(src) {
  const spans = []
  let i = 0
  const n = src.length
  let prev = ''
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const start = i
      while (i < n && src[i] !== '\n') i++
      spans.push({ start, end: i, kind: 'line' })
      continue
    }
    if (c === '/' && d === '*') {
      const start = i
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      spans.push({ start, end: i, kind: 'block' })
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      i++
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) { i++; break }
        i++
      }
      prev = q
      continue
    }
    if (c === '`') {
      i++
      let depth = 0
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '$' && src[i + 1] === '{') { depth++; i += 2; continue }
        if (depth > 0) {
          // an expression hole is real code and can hold a comment of its own
          if (src[i] === '}') { depth--; i++; continue }
          if (src[i] === '/' && src[i + 1] === '/') {
            const start = i
            while (i < n && src[i] !== '\n') i++
            spans.push({ start, end: i, kind: 'line' })
            continue
          }
          if (src[i] === '/' && src[i + 1] === '*') {
            const start = i
            i += 2
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
            i = Math.min(n, i + 2)
            spans.push({ start, end: i, kind: 'block' })
            continue
          }
          if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
            const q = src[i]
            i++
            while (i < n) {
              if (src[i] === '\\') { i += 2; continue }
              if (src[i] === q) { i++; break }
              i++
            }
            continue
          }
          i++
          continue
        }
        if (src[i] === '`') { i++; break }
        i++
      }
      prev = '`'
      continue
    }
    if (c === '/') {
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
          i = j
          prev = '/'
          continue
        }
      }
    }
    if (!/\s/.test(c)) prev = c
    i++
  }
  return spans
}

function scanCSS(src) {
  const spans = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '*') {
      const start = i
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      spans.push({ start, end: i, kind: 'block' })
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      i++
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    i++
  }
  return spans
}

function scanPY(src) {
  const spans = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '#') {
      const start = i
      while (i < n && src[i] !== '\n') i++
      spans.push({ start, end: i, kind: 'hash' })
      continue
    }
    const three = src.slice(i, i + 3)
    if (three === '"""' || three === "'''") {
      i += 3
      while (i < n && src.slice(i, i + 3) !== three) {
        if (src[i] === '\\') { i += 2; continue }
        i++
      }
      i += 3
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      i++
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    i++
  }
  return spans
}

const scan = (file, src) => {
  const ext = path.extname(file)
  if (ext === '.css') return scanCSS(src)
  if (ext === '.py') return scanPY(src)
  return scanJS(src)
}

// grouping: a run of comment-only lines is one comment, blank lines between paragraphs included, because one line each means one line for the whole thought
function group(src, spans, file) {
  const lineStart = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStart.push(i + 1)
  const lineOf = (off) => {
    let lo = 0
    let hi = lineStart.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStart[mid] <= off) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const lines = src.split('\n')
  // a comment starting a line, with nothing but whitespace (or a jsx brace) before it
  const ownLine = (s) => {
    const ln = lineOf(s.start)
    const before = src.slice(lineStart[ln], s.start)
    return /^\s*\{?$/.test(before)
  }
  const jsx = (s) => {
    const ln = lineOf(s.start)
    const before = src.slice(lineStart[ln], s.start)
    return /\{$/.test(before) && src.slice(s.end).match(/^\s*\}/) !== null
  }

  const out = []
  let i = 0
  while (i < spans.length) {
    const s = spans[i]
    const startLine = lineOf(s.start)
    const own = ownLine(s)
    if (!own) {
      // a trailing comment beside code stays where it is and only its words change
      out.push({ spans: [s], own: false, jsx: false, startLine, endLine: lineOf(s.end) })
      i++
      continue
    }
    if (s.kind === 'block') {
      out.push({ spans: [s], own: true, jsx: jsx(s), startLine, endLine: lineOf(s.end) })
      i++
      continue
    }
    // gather the run of own-line line comments, across blank lines
    const run = [s]
    let j = i + 1
    let lastLine = lineOf(s.end)
    while (j < spans.length) {
      const t = spans[j]
      if (t.kind === 'block' || !ownLine(t)) break
      const tl = lineOf(t.start)
      let onlyBlank = true
      for (let k = lastLine + 1; k < tl; k++) if (lines[k].trim() !== '') { onlyBlank = false; break }
      if (!onlyBlank) break
      run.push(t)
      lastLine = lineOf(t.end)
      j++
    }
    out.push({ spans: run, own: true, jsx: false, startLine, endLine: lastLine })
    i = j
  }

  return out.map((g, n) => {
    const first = g.spans[0]
    const last = g.spans[g.spans.length - 1]
    const ln = lineOf(first.start)
    const indent = src.slice(lineStart[ln], first.start).replace(/[^\t ]/g, ' ')
    const raw = src.slice(first.start, last.end)
    const text = raw
      .split('\n')
      .map((l) =>
        l
          .replace(/^\s*\/\/\s?/, '')
          .replace(/^\s*#\s?/, '')
          .replace(/^\s*\/\*+\s?/, '')
          .replace(/^\s*\*+\/?\s?/, '')
          .replace(/\s*\*+\/\s*$/, '')
          .replace(/^\{\s*/, '')
          .replace(/\s*\}$/, ''),
      )
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    const nLines = g.endLine - g.startLine + 1
    const style =
      path.extname(file) === '.py'
        ? 'hash'
        : path.extname(file) === '.css'
          ? 'css'
          : g.jsx
            ? 'jsx'
            : first.kind === 'block'
              ? raw.startsWith('/**')
                ? 'jsdoc'
                : 'block'
              : 'line'
    return {
      id: n,
      start: first.start,
      end: last.end,
      line: g.startLine + 1,
      lines: nLines,
      own: g.own,
      style,
      indent,
      text,
      directive: DIRECTIVE.test(raw),
      // the code this comment sits over, so a rewrite can say what the code does not
      after: lines
        .slice(g.endLine + 1, g.endLine + 7)
        .join('\n')
        .slice(0, 500),
    }
  })
}

// ---- the three commands -----------------------------------------------------

const EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.css', '.py'])

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '_archive', '__pycache__', '.vite-cache', 'coverage'].includes(e.name)) continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (EXT.has(path.extname(e.name))) out.push(p)
  }
  return out
}

const commentsOf = (root, rel) => {
  const src = fs.readFileSync(path.join(root, rel), 'utf8')
  return group(src, scan(rel, src), rel)
}

const cmd = process.argv[2]
const root = process.argv[3]

if (cmd === 'list') {
  const dirs = process.argv.slice(4)
  const files = dirs.flatMap((d) => (fs.existsSync(path.join(root, d)) ? walk(path.join(root, d)) : []))
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/')
    let cs
    try {
      cs = commentsOf(root, rel)
    } catch (e) {
      console.error(`SKIP ${rel}: ${e.message}`)
      continue
    }
    const work = cs.filter((c) => !c.directive && needsWork(c.text, c.lines))
    if (work.length) console.log(JSON.stringify({ file: rel, count: work.length, bytes: fs.statSync(f).size }))
  }
} else if (cmd === 'show') {
  const rel = process.argv[4]
  const limit = Number(process.argv[5] || 0)
  const all = commentsOf(root, rel).filter((c) => !c.directive && needsWork(c.text, c.lines))
  const cs = limit > 0 ? all.slice(0, limit) : all
  console.log(
    JSON.stringify(
      { file: rel, left: all.length, shown: cs.length, comments: cs.map(({ id, line, lines, style, text, after }) => ({ id, line, lines, style, text, after })) },
      null,
      1,
    ),
  )
} else if (cmd === 'apply') {
  const rel = process.argv[4]
  const map = JSON.parse(fs.readFileSync(process.argv[5], 'utf8'))
  const full = path.join(root, rel)
  const src = fs.readFileSync(full, 'utf8')
  const nl = src.includes('\r\n') ? '\r\n' : '\n'
  const cs = commentsOf(root, rel)
  const wanted = new Map(map.map((m) => [Number(m.id), String(m.line || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()]))
  let out = ''
  let cursor = 0
  let n = 0
  for (const c of cs) {
    if (!wanted.has(c.id)) continue
    const one = wanted.get(c.id)
    if (!one) continue
    let rendered
    if (c.style === 'hash') rendered = `# ${one}`
    else if (c.style === 'css') rendered = `/* ${one} */`
    else if (c.style === 'jsx') rendered = `/* ${one} */`
    else if (c.style === 'jsdoc') rendered = `/** ${one} */`
    else if (c.style === 'block') rendered = `/* ${one} */`
    else rendered = `// ${one}`
    out += src.slice(cursor, c.start) + rendered
    cursor = c.end
    n++
  }
  out += src.slice(cursor)
  // the lines a multi-line comment used to occupy come out with it
  out = out.split('\r\n').join('\n')
  fs.writeFileSync(full, nl === '\r\n' ? out.split('\n').join('\r\n') : out)
  console.log(`${rel}: ${n} comment(s) rewritten`)
} else {
  console.error('list | show | apply')
  process.exit(2)
}
