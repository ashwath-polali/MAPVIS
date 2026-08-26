/* The account: which services this login can reach, what it has spent, and
 * which machine is answering for it.
 *
 * The whole page is one idea made visible: MAPVIS is a bridge, so a missing key
 * narrows the tool instead of breaking it. Somebody has to be able to see
 * exactly what they can and cannot do BEFORE they press a button and hit a
 * wall, which is why the routing table is the first thing on the page rather
 * than an error they meet later.
 */
import { useEffect, useState } from 'react'
import { go } from './router'
import { Compass, Foot } from './Chrome'
import { useSession, setProvider, makeRelayToken, can, type User } from './session'
import { Ink } from './Shell'

type Relay = { id: string; name: string; capabilities: string[]; last_seen_at: string | null; live: boolean }

export default function Account() {
  const { user, spend, loading } = useSession()
  const [relays, setRelays] = useState<Relay[]>([])
  const [minted, setMinted] = useState<string>('')

  useEffect(() => {
    if (!loading && !user) go('/enter', true)
  }, [user, loading])
  useEffect(() => {
    if (!user) return
    fetch('/api/auth/relays')
      .then((r) => r.json())
      .then((j) => setRelays(j.relays || []))
      .catch(() => {})
  }, [user])

  if (loading || !user) return <Ink what="checking your hand" />
  const able = can(user)
  const total = spend.reduce((a, s) => a + s.total, 0)

  return (
    <div className="site grain">
      <Compass />
      <div className="wrap sec acct">
        <header>
          <div className="label tick">your account</div>
          <h1 className="d2">{user.display_name || user.email}</h1>
          <div className="mono map-meta">{user.email}</div>
        </header>
        <hr className="hair" />

        {/* WHAT WORKS RIGHT NOW. Every row is honest about what happens rather
            than about what is configured. */}
        <section className="routing">
          <div className="label tick">what you can do right now</div>
          <table className="rtable">
            <tbody>
              <Row on={true} what="cut, levels, walk test, placing, export, publish" note="free forever, no key" />
              <Row
                on={able.generate}
                what="generating art with PixelLab"
                note={able.generate ? 'your key' : 'needs a PixelLab key'}
              />
              <Row
                on={able.interpret}
                what="Claude writing the prompt for you"
                note={able.interpret ? 'reachable' : 'your words go straight to PixelLab instead'}
              />
              <Row
                on={able.interpret}
                what="reading the painting, judging candidates, planning effects"
                note={able.interpret ? 'reachable' : 'denied until Claude is reachable'}
              />
            </tbody>
          </table>
        </section>

        <div className="acct-cols">
          <Provider
            user={user}
            service="claude"
            title="Claude"
            what="Writes the prompt, reads the painting, and judges what came back. Without it your own words go straight to PixelLab, which still draws, just less carefully."
          />
          <Provider
            user={user}
            service="pixellab"
            title="PixelLab"
            what="Draws everything. Without it generation is simply unavailable and every other part of the tool works exactly as it does now."
          />
        </div>

        {/* the linked machine */}
        <section className="relays">
          <div className="label tick">linked machines</div>
          <p className="aside">
            A machine you link runs the Claude you already pay for and answers on this
            account&rsquo;s behalf. It stores no key, and when it stops checking in the tool degrades
            within ninety seconds rather than hanging.
          </p>
          {relays.length > 0 && (
            <ul className="relaylist">
              {relays.map((r) => (
                <li key={r.id}>
                  <span className={'pip ' + (r.live ? 'live' : 'idle')}>{r.live ? 'answering' : 'asleep'}</span>
                  <span className="mono">{r.name}</span>
                  <span className="label">{r.capabilities.join(', ')}</span>
                  <span className="dimmed">
                    {r.last_seen_at ? new Date(r.last_seen_at).toLocaleString() : 'never checked in'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {minted ? (
            <div className="minted">
              <div className="label">copy this now, it is not shown again</div>
              <code className="mono">{minted}</code>
              <p className="aside">
                Put it in <span className="mono">.env</span> as{' '}
                <span className="mono">MAPVIS_RELAY_TOKEN</span> on the machine, then run{' '}
                <span className="mono">npm run relay</span>.
              </p>
            </div>
          ) : (
            <button
              className="plate quiet"
              onClick={() => {
                void makeRelayToken('a machine').then((j) => {
                  setMinted(j.token)
                  fetch('/api/auth/relays')
                    .then((r) => r.json())
                    .then((k) => setRelays(k.relays || []))
                })
              }}
            >
              link a machine
            </button>
          )}
        </section>

        {/* the ledger */}
        <section className="ledger">
          <div className="label tick">what you have spent, last 30 days</div>
          {spend.length === 0 ? (
            <p className="aside">Nothing yet.</p>
          ) : (
            <>
              <table className="rtable">
                <tbody>
                  {spend.map((s) => (
                    <tr key={s.provider + s.endpoint}>
                      <td className="mono">{s.endpoint}</td>
                      <td className="label">{s.provider}</td>
                      <td className="mono">{s.n}</td>
                      <td className="mono gold">${s.total.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="ledger-total mono">
                total <span className="gold">${total.toFixed(2)}</span>
              </div>
            </>
          )}
        </section>
      </div>
      <Foot />
    </div>
  )
}

function Row({ on, what, note }: { on: boolean; what: string; note: string }) {
  return (
    <tr className={on ? '' : 'off'}>
      <td>
        <span className={'pip ' + (on ? 'live' : 'idle')} />
      </td>
      <td>{what}</td>
      <td className="aside">{note}</td>
    </tr>
  )
}

function Provider({
  user,
  service,
  title,
  what,
}: {
  user: User
  service: 'claude' | 'pixellab'
  title: string
  what: string
}) {
  const mode = service === 'claude' ? user.claude_provider : user.pixellab_provider
  const held = service === 'claude' ? user.has_claude_key : user.has_pixellab_key
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [why, setWhy] = useState('')

  const apply = async (next: 'key' | 'relay' | 'none') => {
    setBusy(true)
    setWhy('')
    try {
      await setProvider(service, next, next === 'key' ? key : undefined)
      setKey('')
    } catch (e) {
      setWhy(String((e as Error).message))
    }
    setBusy(false)
  }

  return (
    <section className="prov">
      <div className="prov-head">
        <h2 className="d3">{title}</h2>
        <span className={'pip ' + (mode === 'none' ? 'idle' : 'live')}>{mode}</span>
      </div>
      <p className="aside">{what}</p>

      <div className="prov-modes">
        {(['key', 'relay', 'none'] as const).map((m) => (
          <button
            key={m}
            className={'kbtn2' + (mode === m ? ' on' : '')}
            disabled={busy || (m === 'key' && !key && mode !== 'key')}
            onClick={() => apply(m)}
          >
            {m === 'key' ? 'my own key' : m === 'relay' ? 'a linked machine' : 'nothing'}
          </button>
        ))}
      </div>

      {mode === 'key' && held ? (
        <p className="aside prov-held">
          A key is stored. It is encrypted and never comes back out, so replacing it means pasting a
          new one.
        </p>
      ) : null}

      <label className="wfield">
        <span className="label">{held ? 'replace the key' : 'paste a key'}</span>
        <input
          type="password"
          value={key}
          placeholder={service === 'claude' ? 'sk-ant-…' : 'your pixellab token'}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      {key ? (
        <button className="plate small" disabled={busy} onClick={() => apply('key')}>
          {busy ? 'a moment' : 'use this key'}
        </button>
      ) : null}
      {why ? <p className="wax">{why}</p> : null}
    </section>
  )
}
