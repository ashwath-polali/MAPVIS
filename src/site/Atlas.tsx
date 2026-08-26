/* The atlas: every map anybody has published, hung on a wall.
 *
 * This is the public surface. It is what a link in a message unfurls into, what
 * a club member shows off, and the closest thing the project has to a shop
 * window if MAPVIS ever gets sold.
 */
import { useEffect, useState } from 'react'
import { Link, useWarm } from './router'
import { Compass, Foot } from './Chrome'
import { Ink } from './Shell'
import { useReveal } from './motion'

type Entry = { slug: string; title: string; w: number; h: number; version: number; anchors: number; updated_at: string }

export default function Atlas() {
  const [maps, setMaps] = useState<Entry[] | null>(null)
  useEffect(() => {
    fetch('/api/v1/maps')
      .then((r) => r.json())
      .then((j) => setMaps(j.maps || []))
      .catch(() => setMaps([]))
  }, [])

  return (
    <div className="site grain">
      <Compass />
      <div className="wrap sec">
        <header className="atlas-head">
          <div className="label tick">the atlas</div>
          <h1 className="d1 atlas-title">Every place anybody has finished.</h1>
          <p className="lede">
            A published map never changes, so each of these is standing exactly as it was on the day it
            went out. Open one and walk it.
          </p>
        </header>
        <hr className="hair" />

        {maps === null ? (
          <Ink what="opening the atlas" />
        ) : maps.length === 0 ? (
          <div className="empty">
            <div className="empty-art">
              <span className="realm-await mono">painting: empty-atlas</span>
            </div>
            <div>
              <h2 className="d3">The atlas is blank.</h2>
              <p className="lede">Nothing has been published yet. The first map to go out lands here.</p>
              <Link to="/enter?new=1" className="plate">
                draw the first one
              </Link>
            </div>
          </div>
        ) : (
          <div className="wall">
            {maps.map((m, i) => (
              <Hung key={m.slug} m={m} i={i} />
            ))}
          </div>
        )}
      </div>
      <Foot />
    </div>
  )
}

function Hung({ m, i }: { m: Entry; i: number }) {
  const ref = useReveal<HTMLAnchorElement>()
  const warm = useWarm()
  // hang them at slightly different heights, the way pictures actually hang
  const drop = [0, 26, 12, 38, 6][i % 5]
  return (
    <Link
      to={`/maps/${m.slug}`}
      className="hung rise"
      ref={ref as never}
      style={{ ['--i' as string]: i % 5, marginTop: drop }}
      onMouseEnter={() => warm(`/api/v1/maps/${m.slug}`)}
    >
      <div className="realm-frame hung-frame">
        <img src={`/api/v1/maps/${m.slug}/file/${m.version}/scene.png`} alt="" loading="lazy" decoding="async" />
        <div className="realm-grid" aria-hidden />
        <div className="hung-veil" aria-hidden />
      </div>
      <div className="hung-say">
        <h2 className="d3">{m.title || m.slug}</h2>
        <div className="mono hung-meta">
          v{m.version} · {m.w}×{m.h} · {m.anchors} named
        </div>
      </div>
    </Link>
  )
}
