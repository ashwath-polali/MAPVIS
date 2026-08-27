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
  const { job } = await call('/api/relay/claim', { name: NAME, caps: CAPS })
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
    const raw = await viaCli(job.payload.prompt, 300000)
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
