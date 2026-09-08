/* Settings as a panel over whatever you were doing, because nothing here is a destination and a route means a navigation and a lost place in a list, for four fields. */
import { useEffect, useState } from 'react'
import { useSession, setProvider, makeRelayToken, signOut, can, type User } from './session'
import { go } from './router'
import { SOUND_EXISTS, audioSupported, audioUnblocked, isMuted, onFirstGesture, setMuted } from '../core/audio'

type Relay = { id: string; name: string; capabilities: string[]; last_seen_at: string | null; live: boolean }

export function Settings({ onClose }: { onClose: () => void }) {
  const { user, spend } = useSession()
  const [relays, setRelays] = useState<Relay[]>([])
  const [minted, setMinted] = useState('')

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  useEffect(() => {
    fetch('/api/auth/relays')
      .then((r) => r.json())
      .then((j) => setRelays(j.relays || []))
      .catch(() => {})
  }, [])

  if (!user) return null
  const able = can(user)
  const total = spend.reduce((a, s) => a + s.total, 0)

  return (
    <div className="sheetwrap" onMouseDown={onClose}>
      <div className="sheet" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="settings">
        <header>
          <div>
            <h2>Settings</h2>
            <span className="sheet-who">{user.email}</span>
          </div>
          <button className="sheet-x" onClick={onClose} aria-label="close">
            ×
          </button>
        </header>

        <section>
          <h3>What works right now</h3>
          <ul className="works">
            <Works on what="drawing, cutting, elevation, walk test, export" note="always free" />
            <Works on={able.generate} what="generating art" note={able.generate ? 'ready' : 'needs an art key'} />
            <Works
              on={able.interpret}
              what="writing your prompt for you"
              note={able.interpret ? 'ready' : 'your own words are sent instead'}
            />
          </ul>
        </section>

        <section className="keys">
          <h3>Keys</h3>
          <Key user={user} which="pixellab" title="Art generation" api="PixelLab API key" note="Without it, generating is unavailable and everything else works." />
          <Key user={user} which="claude" title="Prompt writing" api="Claude API key" note="Without it, what you type is used directly." />
        </section>

        <section>
          <h3>Linked machines</h3>
          {relays.length ? (
            <ul className="machines">
              {relays.map((r) => (
                <li key={r.id}>
                  <span className={'dot ' + (r.live ? 'on' : '')} />
                  <span>{r.name}</span>
                  <span className="machines-when">{r.live ? 'connected' : 'asleep'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sheet-note">None. A linked machine lets this account use software installed on your computer.</p>
          )}
          {minted ? (
            <div className="minted">
              <span className="sheet-note">Copy this now, it is not shown again.</span>
              <code>{minted}</code>
            </div>
          ) : (
            <button
              className="sheet-btn"
              onClick={() => {
                void makeRelayToken('my computer').then((j) => {
                  setMinted(j.token)
                  fetch('/api/auth/relays')
                    .then((r) => r.json())
                    .then((k) => setRelays(k.relays || []))
                })
              }}
            >
              Link a machine
            </button>
          )}
        </section>

        <Sound />

        {spend.length > 0 && (
          <section>
            <h3>Used in the last 30 days</h3>
            <ul className="spend">
              {spend.map((s) => (
                <li key={s.provider + s.endpoint}>
                  <span>{s.endpoint}</span>
                  <span>{s.n}</span>
                  <span className="spend-cost">${s.total.toFixed(2)}</span>
                </li>
              ))}
            </ul>
            <div className="spend-total">
              total <b>${total.toFixed(2)}</b>
            </div>
          </section>
        )}

        <footer>
          <button
            className="sheet-btn danger"
            onClick={() => {
              void signOut().then(() => go('/'))
            }}
          >
            Sign out
          </button>
        </footer>
      </div>
    </div>
  )
}

/* THE MUTE SWITCH, WHICH MUTES NOTHING, AND SAYS SO. A control that reports a state it does not deliver is worse than no control, so the row states plainly that nothing plays yet and the switch does the one real thing there is, which is remember. */
function Sound() {
  const [muted, setMine] = useState(isMuted)
  const [, bump] = useState(0)

  /* the unlock line below reports the real state of this tab, so it has to
     notice the click or keypress that changes it rather than reading once */
  useEffect(() => onFirstGesture(() => bump((n) => n + 1)), [])

  const set = (next: boolean) => {
    setMuted(next)
    setMine(next)
  }

  return (
    <section>
      <h3>Sound</h3>
      <ul className="works">
        <Works on={SOUND_EXISTS} what="anything that makes a sound" note={SOUND_EXISTS ? 'ready' : 'none exists yet'} />
      </ul>
      <div className="pref">
        <span id="pref-sound">Play sound</span>
        <div className="pref-sw" role="group" aria-labelledby="pref-sound">
          <button className={muted ? '' : 'on'} aria-pressed={!muted} onClick={() => set(false)}>
            on
          </button>
          <button className={muted ? 'on' : ''} aria-pressed={muted} onClick={() => set(true)}>
            muted
          </button>
        </div>
      </div>
      {/* the switch is here before there is anything to silence, because the answer outlives the first sound. */}
      {!SOUND_EXISTS && (
        <p className="sheet-note">Nothing plays a sound yet. The answer is kept, so the first one ever added arrives already silent.</p>
      )}
      <p className="sheet-note">
        {!audioSupported()
          ? 'This browser cannot play audio at all, so nothing will be audible in it even once there is something to hear.'
          : audioUnblocked()
            ? 'Browsers hold sound until somebody clicks or presses a key. This tab has.'
            : 'Browsers hold sound until somebody clicks or presses a key. This tab has not yet.'}
      </p>
    </section>
  )
}

function Works({ on = true, what, note }: { on?: boolean; what: string; note: string }) {
  return (
    <li className={on ? '' : 'off'}>
      <span className={'dot ' + (on ? 'on' : '')} />
      <span>{what}</span>
      <span className="works-note">{note}</span>
    </li>
  )
}

function Key({ user, which, title, api, note }: { user: User; which: 'claude' | 'pixellab'; title: string; api: string; note: string }) {
  const mode = which === 'claude' ? user.claude_provider : user.pixellab_provider
  const held = which === 'claude' ? user.has_claude_key : user.has_pixellab_key
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [why, setWhy] = useState('')

  const save = async (next: 'key' | 'relay' | 'none') => {
    setBusy(true)
    setWhy('')
    try {
      await setProvider(which, next, next === 'key' ? val : undefined)
      setVal('')
    } catch (e) {
      setWhy(String((e as Error).message))
    }
    setBusy(false)
  }

  return (
    <div className="key">
      <div className="key-top">
        <b>{title}</b>
        <span className="key-api">({api})</span>
        <span className={'dot ' + (mode === 'none' ? '' : 'on')} />
      </div>
      <p className="sheet-note">{note}</p>
      <div className="key-row">
        <input
          type="password"
          value={val}
          placeholder={held ? 'a key is saved · paste one to replace it' : 'paste a key'}
          onChange={(e) => setVal(e.target.value)}
        />
        <button className="sheet-btn" disabled={busy || !val} onClick={() => save('key')}>
          Save
        </button>
        {(held || mode === 'relay') && (
          <button className="sheet-btn quiet" disabled={busy} onClick={() => save('none')}>
            Remove
          </button>
        )}
      </div>
      {mode === 'relay' && <p className="sheet-note">Currently using a linked machine instead of a key.</p>}
      {why && <p className="sheet-bad">{why}</p>}
    </div>
  )
}
