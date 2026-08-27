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
const shot = (m: MapRow) => (m.published != null ? `/api/v1/maps/${m.slug}/file/${m.published}/scene.png` : null)

export default function Home() {
  const { user, loading } = useSession()
  const [maps, setMaps] = useState<MapRow[] | null>(null)
  const [q, setQ] = useState('')
  const [settings, setSettings] = useState(false)

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
            {lead && <Lead m={lead} />}
            <div className="grid">
              <button className="card new" onClick={() => go('/edit')}>
                <span className="new-plus" aria-hidden>
                  +
                </span>
                <span className="new-say">new map</span>
                <span className="new-sub">start from a painting</span>
              </button>
              {rest.map((m) => (
                <Card key={m.id} m={m} />
              ))}
            </div>
          </>
        )}
      </main>

      {settings && <Settings onClose={() => setSettings(false)} />}
    </div>
  )
}

/* The newest map, across the whole width. It is the one thing on this page that
 * is allowed to be big, and it is what stops the screen reading as a list. */
function Lead({ m }: { m: MapRow }) {
  return (
    <a className="lead" href={`/edit?id=${encodeURIComponent(m.slug)}`}>
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
        <span className="lead-go">keep working</span>
      </div>
    </a>
  )
}

function Card({ m }: { m: MapRow }) {
  const src = shot(m)
  return (
    <article className="card">
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
