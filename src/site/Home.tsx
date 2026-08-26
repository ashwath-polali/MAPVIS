/* Home, once you are signed in.
 *
 * NOT a room, not a desk, not a bookshelf with maps in it. Skeuomorphism is
 * where this kind of thing goes wrong: a fake wooden shelf is a costume over a
 * list, it gets in the way the second you have twenty maps, and it looks like
 * somebody's idea of charming rather than somebody's tool.
 *
 * So this is an interface. What makes it not generic is that the ONLY art on it
 * is the maps themselves, at real pixel scale, big, unfiltered, on a surface
 * dark enough to let painted colour be the brightest thing on the screen. The
 * craft goes into the type, the spacing, the edges and the motion. Everything
 * else gets out of the way of the pictures.
 */
import { useEffect, useState } from 'react'
import { Link, go } from './router'
import { useSession, signOut } from './session'

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

export default function Home() {
  const { user, loading } = useSession()
  const [maps, setMaps] = useState<MapRow[] | null>(null)
  const [q, setQ] = useState('')

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

  const shown = (maps || []).filter((m) => !q || (m.title + m.slug).toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="home">
      <header className="home-bar">
        <span className="home-mark">MAPVIS</span>
        <div className="home-bar-r">
          {maps && maps.length > 4 ? (
            <input
              className="home-find"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="find"
              spellCheck={false}
            />
          ) : null}
          <Link to="/account" className="home-icon" aria-label="settings" title="settings">
            <Gear />
          </Link>
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
        ) : (
          <div className="grid">
            <button className="card new" onClick={() => go('/edit')}>
              <span className="new-plus" aria-hidden>
                +
              </span>
              <span className="new-say">new map</span>
              <span className="new-sub">start from a painting</span>
            </button>

            {shown.map((m) => (
              <Card key={m.id} m={m} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

function Card({ m }: { m: MapRow }) {
  const live = m.published != null
  return (
    <article className="card">
      <a className="card-art" href={`/edit?id=${encodeURIComponent(m.slug)}`}>
        {live ? (
          <img src={`/api/v1/maps/${m.slug}/file/${m.published}/scene.png`} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="card-none">not published</span>
        )}
      </a>
      <div className="card-say">
        <div className="card-top">
          <h2>{m.title || m.slug}</h2>
          <span className="card-when">{when(m.updated_at)}</span>
        </div>
        <div className="card-nums">
          <span>{m.w}&times;{m.h}</span>
          <span>{m.placements} placed</span>
          <span className={m.anchors ? 'lit' : ''}>{m.anchors} named</span>
          {live ? <span className="lit">v{m.published}</span> : null}
        </div>
        <div className="card-do">
          <a href={`/edit?id=${encodeURIComponent(m.slug)}`}>edit</a>
          {live ? <Link to={`/maps/${m.slug}`}>walk</Link> : null}
        </div>
      </div>
    </article>
  )
}

/* Icons are drawn on a pixel grid, not lifted from an icon set. Two of them,
 * because two is all this screen needs. */
function Gear() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" shapeRendering="crispEdges" aria-hidden>
      <path fill="currentColor" d="M7 1h2v2H7zM7 13h2v2H7zM1 7h2v2H1zM13 7h2v2h-2zM3 3h2v2H3zM11 3h2v2h-2zM3 11h2v2H3zM11 11h2v2h-2zM6 6h4v4H6z" />
    </svg>
  )
}
function Out() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" shapeRendering="crispEdges" aria-hidden>
      <path fill="currentColor" d="M2 2h7v2H4v8h5v2H2zM10 5h2v2h-2zM12 7h3v2h-3zM10 9h2v2h-2z" />
    </svg>
  )
}
