import path from 'node:path'
import fs from 'node:fs'
// the linked machine, run with `node server/relay.mjs`; it polls rather than being called because a laptop behind a home or office network has no public address, and the platform degrades within ninety seconds of it going quiet
import os from 'node:os'
import { env } from './db/env.mjs'
import { viaCli } from './store/planner.mjs'

const E = env()
const BASE = (E.MAPVIS_URL || 'http://localhost:5274').replace(/\/+$/, '')
const TOKEN = E.MAPVIS_RELAY_TOKEN
const NAME = E.MAPVIS_RELAY_NAME || os.hostname()
const CAPS = (E.MAPVIS_RELAY_CAPS || 'claude').split(',').map((s) => s.trim()).filter(Boolean)
/* a machine with a pixellab token says so without being told, and lends the token itself because the host cannot run a generation through this queue */
if (E.PIXELLAB_TOKEN && !CAPS.includes('pixellab')) CAPS.push('pixellab')
let claims = 0

if (!TOKEN) {
  console.error(
    'MAPVIS_RELAY_TOKEN is not set.\n' +
      'Make one in your account settings, put it in .env, and run this again.',
  )
  process.exit(1)
}

const call = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Relay ${TOKEN}` },
    body: JSON.stringify(body || {}),
  })
  if (!r.ok) throw new Error(`${path} said ${r.status}: ${(await r.text()).slice(0, 160)}`)
  return r.json()
}

let quiet = false
const say = (m) => console.log(`[relay] ${m}`)

async function tick() {
  // Claiming and heartbeating are the same call. A relay that is asking for
  // work is by definition alive, so there is no second timer to forget.
  const lend = E.PIXELLAB_TOKEN && claims % 400 === 0 ? { pixellab: E.PIXELLAB_TOKEN } : {}
  claims++
  const { job } = await call('/api/relay/claim', { name: NAME, caps: CAPS, ...lend })
  if (!job) {
    if (!quiet) {
      say('linked and waiting')
      quiet = true
    }
    return
  }
  quiet = false
  say(`job ${job.id.slice(0, 8)} · ${job.kind}`)
  const started = Date.now()
  try {
    // the same cli, the same flags, the same answer MAPVIS has always used
    /* the pictures come with the job and their paths are rewritten here, because the prompt names the host's own tmp files and this machine has neither */
    let prompt = String(job.payload.prompt || '')
    const imgs = Array.isArray(job.payload.images) ? job.payload.images : []
    const paths = Array.isArray(job.payload.paths) ? job.payload.paths : []
    if (imgs.length) {
      const dir = path.join(os.tmpdir(), 'mapvis-relay', String(job.id))
      fs.mkdirSync(dir, { recursive: true })
      imgs.forEach((b64, i) => {
        const local = path.join(dir, `${i}.png`)
        fs.writeFileSync(local, Buffer.from(String(b64), 'base64'))
        if (paths[i]) prompt = prompt.split(String(paths[i])).join(local)
      })
    }
    const raw = await viaCli(prompt, 300000)
    let text = raw
    try {
      // the cli wraps its answer; unwrapping here means the server sees one
      // shape whichever provider replied
      const j = JSON.parse(raw)
      if (typeof j.result === 'string') text = j.result
    } catch {}
    await call('/api/relay/done', { id: job.id, text })
    say(`  answered in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  } catch (e) {
    await call('/api/relay/done', { id: job.id, error: String(e.message || e).slice(0, 300) }).catch(() => {})
    say(`  failed: ${String(e.message || e).slice(0, 120)}`)
  }
}

say(`${NAME} -> ${BASE}, serving ${CAPS.join(', ')}`)
for (;;) {
  try {
    await tick()
  } catch (e) {
    // a server that is down or a laptop that lost wifi is a normal Tuesday, not
    // a reason to stop. The platform degrades on its own while this waits.
    if (!quiet) say(`cannot reach mapvis: ${String(e.message || e).slice(0, 120)}`)
    quiet = true
  }
  await new Promise((r) => setTimeout(r, 1500))
}
