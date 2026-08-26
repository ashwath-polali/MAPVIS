/* My maps.
 *
 * Not a table and not a grid of grey cards. Each map is a plate on a wall: the
 * real painting, framed, with what is actually true about it underneath — how
 * many named places code can reach, how many things are in its library, which
 * version is live in the game.
 *
 * The thumbnail is the map's own scene.png out of object storage, so this page
 * is the first time most people will see that their work really did leave their
 * laptop.
 */
import { useEffect, useState } from 'react'
import { Link, go, useWarm } from './router'
import { Compass, Foot } from './Chrome'
import { useSession } from './session'
import { Ink } from './Shell'
import { useReveal } from './motion'

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

const ago = (iso: string) => {
  const s = (Date.now() - +new Date(iso)) / 1000
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`
  if (s < 172800) return `${Math.round(s / 3600)} hours ago`
  return `${Math.round(s / 86400)} days ago`
}

export default function Maps() {
  const { user, loading } = useSession()
  const [maps, setMaps] = useState<MapRow[] | null>(null)

  useEffect(() => {
    if (loading) return
    if (!user) {
      go('/enter', true)
      return
    }
    fetch('/api/my-maps')
      .then((r) => r.json())
      .then((j) => setMaps(j.maps || []))
      .catch(() => setMaps([]))
  }, [user, loading])

  return (
    <div className="site grain">
      <Compass />
      <div className="wrap sec shelf">
        <header className="shelf-head">
          <div>
            <div className="label tick">your hand</div>
            <h1 className="d2">Maps you have drawn</h1>
          </div>
          <a href="/edit" className="plate">
            begin a new chart
          </a>
        </header>
        <hr className="hair" />

        {maps === null ? (
          <Ink what="pulling your charts" />
        ) : maps.length === 0 ? (
          <Empty />
        ) : (
          <div className="plates">
            {maps.map((m, i) => (
              <Plate key={m.id} m={m} i={i} />
            ))}
          </div>
        )}
      </div>
      <Foot />
    </div>
  )
}

function Plate({ m, i }: { m: MapRow; i: number }) {
  const ref = useReveal<HTMLDivElement>()
  const warm = useWarm()
  const live = m.published != null
  return (
    <div className="mplate rise" ref={ref} style={{ ['--i' as string]: i % 6 }}>
      <Link
        to={`/maps/${m.slug}`}
        className="mplate-art"
        onMouseEnter={() => warm(`/api/v1/maps/${m.slug}`)}
      >
        <div className="realm-frame mplate-frame">
          {live ? (
            <img
              src={`/api/v1/maps/${m.slug}/file/${m.published}/scene.png`}
              alt=""
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="mplate-unpub">
              <span className="realm-await mono">not published yet</span>
            </div>
          )}
          <div className="realm-grid" aria-hidden />
        </div>
      </Link>

      <div className="mplate-say">
        <h2 className="d3">
          <Link to={`/maps/${m.slug}`}>{m.title || m.slug}</Link>
        </h2>
        <div className="mono mplate-slug">{m.slug}</div>
        <dl className="facts">
          <Fact k="named places" v={m.anchors} tone={m.anchors ? 'gold' : 'dim'} />
          <Fact k="placements" v={m.placements} />
          <Fact k="library" v={m.library} />
          <Fact k="size" v={`${m.w}×${m.h}`} />
        </dl>
        <div className="mplate-foot">
          <span className={'pip ' + (live ? 'live' : 'idle')}>
            {live ? `v${m.published} in the game` : 'never published'}
          </span>
          <span className="dimmed">{ago(m.updated_at)}</span>
        </div>
      </div>
    </div>
  )
}

function Fact({ k, v, tone }: { k: string; v: string | number; tone?: string }) {
  return (
    <div className={'fact' + (tone === 'gold' ? ' gold' : '')}>
      <dt className="label">{k}</dt>
      <dd className="mono">{v}</dd>
    </div>
  )
}

/* An empty shelf should say what to do, not apologise. */
function Empty() {
  return (
    <div className="empty">
      <div className="empty-art">
        <span className="realm-await mono">painting: blank-chart</span>
      </div>
      <div>
        <h2 className="d3">Nothing drawn yet.</h2>
        <p className="lede">
          A map starts as one painting. Bring it in, cut the sea away from the land, and mark what can
          be walked on. Everything after that is decoration.
        </p>
        <a href="/edit" className="plate">
          begin a new chart
        </a>
      </div>
    </div>
  )
}
