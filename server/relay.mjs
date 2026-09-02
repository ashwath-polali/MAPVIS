import path from 'node:path'
import fs from 'node:fs'
// The linked machine.
//
//   node server/relay.mjs
//
// This is what makes the club account work. It holds no api key: it runs the
// model cli that is already installed and already paid for on this machine,
// and posts the answers back to a MAPVIS that may be hosted anywhere.
//
// It polls rather than being called, which is the only shape that works from a
// laptop with no public address, behind a school network, that closes at night.
// When it stops checking in the platform notices within ninety seconds and
// degrades: the router features send the author's own words straight to
// pixellab and the purely-claude features say they need a key. Nothing hangs
// waiting for a machine that went to sleep.
//
// When the linked machine goes away for good, somebody sets the account's
// provider to 'key' from a dropdown, this stops mattering, and nothing else
// changes.
import os from 'node:os'
import { env } from './db/env.mjs'
import { viaCli } from './store/planner.mjs'

const E = env()
const BASE = (E.MAPVIS_URL || 'http://localhost:5274').replace(/\/+$/, '')
const TOKEN = E.MAPVIS_RELAY_TOKEN
const NAME = E.MAPVIS_RELAY_NAME || os.hostname()
const CAPS = (E.MAPVIS_RELAY_CAPS || 'claude').split(',').map((s) => s.trim()).filter(Boolean)
/* A MACHINE WITH A PIXELLAB TOKEN CAN DO PIXELLAB, and says so without being
 * told to in caps. The host cannot run a generation through this queue, so
 * what it gets from this machine is the token itself, sent with the first
 * claim and again now and then so a restarted host is not left without it. */
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
    /* THE PICTURES COME WITH THE JOB. The host wrote them to its own tmp
     * directory and named those paths in the prompt; this machine has neither.
     * Each image is written here and the host's path is swapped for this one,
     * so the cli reads exactly what the host meant it to and the prompt's
     * wording never changes. Before this the planner on the laptop was asked
     * to read /tmp files that only ever existed on a serverless instance. */
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
