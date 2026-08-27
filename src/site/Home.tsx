/* Home, once you are signed in.
 *
 * Not a room, not a desk, not a bookshelf with maps in it. Skeuomorphism is
 * where this goes wrong: a fake wooden shelf is a costume over a list, and it
 * gets in the way the moment you have twenty maps.
 *
 * So it is an interface, and what stops it being a blank list is that the newest
 * map runs across the top at full width as a real banner, and every card below
 * is a big unfiltered painting. The only colour on the page comes out of the
 * work. Chrome stays out of the way.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, go } from './router'
import { useSession, signOut } from './session'
import { Settings } from './Settings'

type MapRow = {
  id: string
  slug: string
  title: string
  w: number
  h: number
  updated_at: string
  anchors: number
  library: number
  placements: number
  published: number | null
}

const when = (iso: string) => {
  const s = (Date.now() - +new Date(iso)) / 1000
  if (s < 120) return 'just now'
  if (s < 5400) return Math.round(s / 60) + ' min ago'
  if (s < 172800) return Math.round(s / 3600) + ' hr ago'
  const d = Math.round(s / 86400)
  return d < 30 ? d + ' days ago' : new Date(iso).toLocaleDateString()
}
/* A MAP THAT HAS NEVER BEEN EXPORTED STILL HAS A PICTURE.
 *
 * This only ever pointed at a published bundle, so a map you had painted but
 * not yet exported showed "no painting yet", and every card on the page was a
 * read out of object storage. The working scene is the better source for a
 * thumbnail on both counts: it is what the map looks like right now rather than
 * at the last export, and /work/ is served from local disk when this machine
 * has it, so a page of cards costs nothing.
 *
 * The published copy stays the first choice, because on a host it is the only
 * one that exists. */
const shot = (m: MapRow) => `/work/${m.slug}/scene.png`

export default function Home() {
  const { user, loading } = useSession()
  const [maps, setMaps] = useState<MapRow[] | null>(null)
  const [q, setQ] = useState('')
  const [settings, setSettings] = useState(false)
  const [doomed, setDoomed] = useState<MapRow | null>(null)

  useEffect(() => {
    if (loading) return
    if (!user) {
      go('/', true)
      return
    }
    fetch('/api/my-maps')
      .then((r) => r.json())
      .then((j) => setMaps(j.maps || []))
      .catch(() => setMaps([]))
  }, [user, loading])

  const shown = useMemo(
    () => (maps || []).filter((m) => !q || (m.title + m.slug).toLowerCase().includes(q.toLowerCase())),
    [maps, q],
  )
  // the most recently touched map that has something to show leads the page
  const lead = !q ? shown.find((m) => shot(m)) : undefined
  const rest = lead ? shown.filter((m) => m.id !== lead.id) : shown

  return (
    <div className="home">
      <header className="home-bar">
        <button className="home-mark" onClick={() => go('/')} aria-label="home">
            MAPVIS
          </button>
        <div className="home-bar-r">
          <input
            className="home-find"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="find a map"
            spellCheck={false}
          />
          <button className="home-icon" aria-label="settings" title="settings" onClick={() => setSettings(true)}>
            <Gear />
          </button>
          <button
            className="home-icon"
            aria-label="sign out"
            title="sign out"
            onClick={() => void signOut().then(() => go('/'))}
          >
            <Out />
          </button>
        </div>
      </header>

      <main className="home-body">
        {maps === null ? (
          <div className="home-wait" />
        ) : maps.length === 0 ? (
          <Blank />
        ) : (
          <>
            {lead && <Lead m={lead} onDelete={() => setDoomed(lead)} />}
            <div className="grid">
              <button className="card new" onClick={() => go('/edit')}>
                <span className="new-plus" aria-hidden>
                  +
                </span>
                <span className="new-say">new map</span>
                <span className="new-sub">start from a painting</span>
              </button>
              {rest.map((m) => (
                <Card key={m.id} m={m} onDelete={() => setDoomed(m)} />
              ))}
            </div>
          </>
        )}
      </main>

      {settings && <Settings onClose={() => setSettings(false)} />}
      {doomed && (
        <DeleteMap
          m={doomed}
          onClose={() => setDoomed(null)}
          onGone={() => {
            // dropped from the list here rather than refetched, so the card
            // cannot flash back while the request settles
            setMaps((all) => (all || []).filter((x) => x.id !== doomed.id))
            setDoomed(null)
          }}
        />
      )}
    </div>
  )
}

/* The newest map, across the whole width. It is the one thing on this page that
 * is allowed to be big, and it is what stops the screen reading as a list. */
function Lead({ m, onDelete }: { m: MapRow; onDelete: () => void }) {
  return (
    <div className="lead">
      <a className="lead-hit" href={`/edit?id=${encodeURIComponent(m.slug)}`} aria-label={`edit ${m.slug}`} />
      {/* above the full-bleed hit area, or the link swallows the click */}
      <button className="card-bin lead-bin" title={`delete ${m.slug}`} aria-label={`delete ${m.slug}`} onClick={onDelete}>
        <Trash />
      </button>
      <img src={shot(m) as string} alt="" />
      <div className="lead-say">
        <span className="lead-when">last opened {when(m.updated_at)}</span>
        <h1>{m.title || m.slug}</h1>
        <div className="lead-nums">
          <span>
            {m.w}&times;{m.h}
          </span>
          <span>{m.placements} placed</span>
          <span>{m.anchors} named</span>
          {m.published != null && <span>v{m.published}</span>}
        </div>
        {/* two ways in, because the newest map is the one you are most likely
            to want to either carry on with OR go and stand in */}
        <div className="lead-acts">
          <a className="lead-go" href={`/edit?id=${encodeURIComponent(m.slug)}`}>
            keep working
          </a>
          {m.published != null && (
            <Link to={`/maps/${m.slug}`} className="lead-go alt">
              walk it
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

function Card({ m, onDelete }: { m: MapRow; onDelete: () => void }) {
  const src = shot(m)
  return (
    <article className="card">
      <button className="card-bin" title={`delete ${m.slug}`} aria-label={`delete ${m.slug}`} onClick={onDelete}>
        <Trash />
      </button>
      <a className="card-art" href={`/edit?id=${encodeURIComponent(m.slug)}`}>
        {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : <span className="card-none">no painting yet</span>}
      </a>
      <div className="card-say">
        <div className="card-top">
          <h2>{m.title || m.slug}</h2>
          <span className="card-when">{when(m.updated_at)}</span>
        </div>
        <div className="card-nums">
          <span>
            {m.w}&times;{m.h}
          </span>
          <span>{m.placements} placed</span>
          <span className={m.anchors ? 'lit' : ''}>{m.anchors} named</span>
          {m.published != null ? <span className="lit">v{m.published}</span> : null}
        </div>
        <div className="card-do">
          <a href={`/edit?id=${encodeURIComponent(m.slug)}`}>edit</a>
          {m.published != null ? <Link to={`/maps/${m.slug}`}>walk</Link> : null}
        </div>
      </div>
    </article>
  )
}

function Blank() {
  return (
    <div className="blank">
      <h1>Nothing here yet.</h1>
      <p>A map starts as one painting. Bring one in and cut the parts you can walk on out of it.</p>
      <button className="sheet-btn" onClick={() => go('/edit')}>
        Make your first map
      </button>
    </div>
  )
}

/* Drawn on a pixel grid rather than lifted from an icon set. */
function Out() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" shapeRendering="crispEdges" aria-hidden>
      <path fill="currentColor" d="M2 2h7v2H4v8h5v2H2zM10 5h2v2h-2zM12 7h3v2h-3zM10 9h2v2h-2z" />
    </svg>
  )
}

function Trash() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" shapeRendering="crispEdges" aria-hidden>
      <path
        fill="currentColor"
        d="M6 1h4v1H6zM3 3h10v1H3zM4 5h1v9H4zM11 5h1v9h-1zM5 14h6v1H5zM6 6h1v7H6zM9 6h1v7H9z"
      />
    </svg>
  )
}

/* DELETING A MAP, IN TWO DELIBERATE STEPS.
 *
 * A map is months of painting and hand-drawn mask, and one of these was once
 * destroyed by a test that pointed at a real slug. So this asks twice, and the
 * two questions are different on purpose: the first confirms WHICH map, spelling
 * out its slug and what goes with it, and the second proves WHO you are. A
 * double confirm that asks the same question twice trains you to click through
 * both.
 *
 * The destructive button is never focused when a step opens, so a stray return
 * key lands on nothing. Escape and the backdrop both cancel. The password is
 * only ever sent to /api/maps/delete, which checks the session, the ownership
 * and the password again on the server; nothing here is the security. */
function DeleteMap({ m, onClose, onGone }: { m: MapRow; onClose: () => void; onGone: () => void }) {
  const [step, setStep] = useState<'confirm' | 'password'>('confirm')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose, busy])

  const remove = async () => {
    if (busy || !pw) return
    setBusy(true)
    setErr('')
    try {
      const r = await fetch('/api/maps/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: m.slug, password: pw }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setErr(j.error || `could not delete (${r.status})`)
        setBusy(false)
        return
      }
      onGone()
    } catch (e) {
      setErr(String((e as Error).message || e))
      setBusy(false)
    }
  }

  return (
    <div className="sheet-wrap" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="sheet danger" role="dialog" aria-modal="true" aria-label={`delete ${m.slug}`}>
        {step === 'confirm' ? (
          <>
            <h2>
              delete <b>{m.slug}</b>?
            </h2>
            <p>
              The painting, the mask you drew by hand, all {m.placements} placement{m.placements === 1 ? '' : 's'} and
              every published version go with it. This cannot be undone.
            </p>
            <div className="sheet-acts">
              <button className="sheet-no" onClick={onClose} autoFocus>
                keep it
              </button>
              <button className="sheet-yes" onClick={() => setStep('password')}>
                yes, delete
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>type your password</h2>
            <p>
              This proves the account, not the map. <b>{m.slug}</b> is removed the moment it matches.
            </p>
            <input
              className="sheet-pw"
              type="password"
              value={pw}
              autoFocus
              disabled={busy}
              placeholder="account password"
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void remove()}
            />
            {err && <p className="sheet-err">{err}</p>}
            <div className="sheet-acts">
              <button className="sheet-no" onClick={onClose} disabled={busy}>
                cancel
              </button>
              <button className="sheet-yes" onClick={() => void remove()} disabled={busy || !pw}>
                {busy ? 'deleting…' : 'delete for good'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Gear() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" shapeRendering="crispEdges" aria-hidden>
      <path
        fill="currentColor"
        d="M7 1h2v2H7zM7 13h2v2H7zM1 7h2v2H1zM13 7h2v2h-2zM3 3h2v2H3zM11 3h2v2h-2zM3 11h2v2H3zM11 11h2v2h-2zM6 6h4v4H6z"
      />
    </svg>
  )
}
