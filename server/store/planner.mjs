// three providers behind one call (key, relay, none), and when claude fails anything that can degrade sends the author's own words straight to pixellab instead
import { spawn } from 'node:child_process'
import { q, one } from '../db/pool.mjs'
import { keyFor } from './auth.mjs'
import { env } from '../db/env.mjs'

export class NoPlanner extends Error {
  constructor(mode) {
    super(mode === 'relay' ? 'no linked machine is answering' : 'this account has no claude key')
    this.name = 'NoPlanner'
    this.mode = mode
    // what a caller checks to decide between degrading and denying
    this.degradable = true
  }
}

const MODEL = env().PLANNER_MODEL || 'claude-opus-4-8'

/* a relay on this machine is just the cli, so it skips the round trip through the database; read through a function so a test can turn it off */
const localRelay = () => env().MAPVIS_LOCAL_RELAY === '1'

// ---- the account's own key -------------------------------------------------

/* the api directly, which also removes the 3.77s process start the cli costs on every call */
/* the paths in the prompt ARE the attachments, because the api has no disk and no Read tool, and one line says so rather than rewording every prompt */
const attachedNote = (n) =>
  n
    ? `The ${n === 1 ? 'image file' : `${n} image files`} named by absolute path below ${n === 1 ? 'is' : 'are'} ` +
      `attached to this message${n === 1 ? '' : ', in that same order'}. You have no Read tool here: look at the ` +
      `attachment${n === 1 ? '' : 's'} and do not try to open the path${n === 1 ? '' : 's'}.\n\n`
    : ''

async function viaKey(key, prompt, timeoutMs, images = []) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const content = [
      ...images.map((b64) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: b64 },
      })),
      { type: 'text', text: attachedNote(images.length) + prompt },
    ]
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: 'user', content }] }),
    })
    if (!r.ok) throw new Error(`anthropic said ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = await r.json()
    const text = (j.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')
    // the cli wraps its answer in an envelope and every caller unwraps that
    // shape, so this hands back the same one rather than teaching ten callers
    // a second format
    return JSON.stringify({ result: text })
  } finally {
    clearTimeout(t)
  }
}

// ---- a linked machine ------------------------------------------------------

/* an unclaimed job times out into NoPlanner, which is the degrade signal, because a closed laptop is a normal condition and not a fault */
async function viaRelay(userId, prompt, timeoutMs, images = [], jobKey = '', paths = []) {
  const live = await one(
    `select id from relay_links where user_id = $1 and 'claude' = any(capabilities)
       and last_seen_at > now() - interval '90 seconds' limit 1`,
    [userId],
  )
  if (!live) throw new NoPlanner('relay')

  const job = await one(
    `insert into jobs (user_id, kind, provider, payload) values ($1,'planner','claude',$2::jsonb) returning id`,
    // the host's own paths for those images, in order, so the laptop that
    // claims this can put the bytes where the prompt says they are
    [userId, JSON.stringify({ prompt, images, paths, key: jobKey })],
  )

  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 700))
    const row = await one('select status, result, error from jobs where id = $1', [job.id])
    if (!row) break
    if (row.status === 'done') return JSON.stringify({ result: row.result?.text ?? '' })
    if (row.status === 'error') throw new Error(row.error || 'the linked machine could not answer')
    if (row.status === 'stopped') throw new Error('stopped')
  }
  await q(`update jobs set status='error', error='timed out waiting for a linked machine', finished_at=now() where id=$1`, [job.id])
  throw new NoPlanner('relay')
}

// ---- the local cli ---------------------------------------------------------

// What MAPVIS has always done, kept for a machine that is running the tool and
// the cli at once. On a host there is no cli to spawn, which is the harder half
// of why hosting forces this whole module to exist.
export function viaCli(prompt, timeoutMs, onProcess) {
  return new Promise((resolve, reject) => {
    let ps
    try {
      ps = spawn(
        'claude',
        ['-p', '--output-format', 'json', '--model', 'opus', '--max-turns', '6', '--allowedTools', 'Read'],
        { windowsHide: true, shell: true },
      )
    } catch (e) {
      return reject(e)
    }
    if (onProcess) onProcess(ps)
    let out = ''
    let err = ''
    let finished = false
    const t = setTimeout(() => {
      if (finished) return
      finished = true
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(ps.pid), '/T', '/F'], { windowsHide: true })
        else ps.kill()
      } catch {}
      reject(new Error('the interpreter timed out'))
    }, timeoutMs)
    ps.stdout.on('data', (d) => (out += d))
    ps.stderr.on('data', (d) => (err += d))
    ps.on('error', (e) => {
      if (finished) return
      finished = true
      clearTimeout(t)
      reject(e)
    })
    ps.on('close', (code) => {
      if (finished) return
      finished = true
      clearTimeout(t)
      if (code === 0) resolve(out)
      else reject(new Error((err || 'the interpreter exited ' + code).slice(-300)))
    })
    ps.stdin.write(prompt)
    ps.stdin.end()
  })
}

// ---- the one call the rest of the server makes -----------------------------

export async function ask({ user, prompt, timeoutMs = 240000, images = [], paths = [], jobKey = '', onProcess }) {
  // With no accounts configured at all this is still the local tool it always
  // was, so the cli answers and nothing changed.
  if (!user) return viaCli(prompt, timeoutMs, onProcess)

  const how = await keyFor(user.id, 'claude')
  if (how?.mode === 'key') return viaKey(how.key, prompt, timeoutMs, images)
  if (how?.mode === 'relay') {
    // a relay on this very machine is just the cli, and going out to the
    // database and back to reach a process sitting right here would be silly
    if (localRelay()) return viaCli(prompt, timeoutMs, onProcess)
    return viaRelay(user.id, prompt, timeoutMs, images, jobKey, paths)
  }
  throw new NoPlanner('none')
}

// Whether a caller should even try, so a feature that cannot degrade can say so
// before spending anything.
export async function plannerReady(user) {
  if (!user) return true
  const how = await keyFor(user.id, 'claude')
  if (how?.mode === 'key') return true
  if (how?.mode !== 'relay') return false
  if (localRelay()) return true
  return !!(await one(
    `select 1 from relay_links where user_id = $1 and 'claude' = any(capabilities)
       and last_seen_at > now() - interval '90 seconds' limit 1`,
    [user.id],
  ))
}
