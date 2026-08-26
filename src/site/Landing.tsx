/* THE LANDING PAGE IS AN ISLAND THAT IS ALIVE.
 *
 * One screen. No scroll story, no eyebrow-headline-lede, no alternating
 * sections, no closing call to action. You arrive and there is a place, moving,
 * filling the window, and a very small amount of type sitting in it.
 *
 * The island is real. It is whatever map was published most recently, drawn
 * from object storage and animated by the same life data the game runs, which
 * means this page is never a mock-up and gets better every time somebody
 * publishes something. A site for a map tool should be made of maps.
 */
import { useEffect, useState } from 'react'
import { Link } from './router'
import { LivingMap } from './LivingMap'
import { useSession } from './session'

type Entry = { slug: string; title: string; version: number; anchors: number; w: number; h: number }

export default function Landing() {
  const { user } = useSession()
  const [maps, setMaps] = useState<Entry[] | null>(null)
  const [i, setI] = useState(0)

  /* SCENES MADE FOR THIS SITE, AND NOTHING ELSE.
   *
   * A slug beginning site- is a painting made in MAPVIS for MAPVIS: a
   * cartographer's tower, an archipelago, a harbour. Game content is never
   * shown here. The hub island is Thor's, it belongs to the Adventure Game, and
   * dressing a shop window in it is borrowing something that is not the shop's.
   *
   * The consequence is that this page is built with the tool it is advertising.
   * Ash paints a scene, places things that move on it, publishes it, and the
   * site renders it through the same engine a map goes through. */
  useEffect(() => {
    fetch('/api/v1/maps')
      .then((r) => r.json())
      .then((j) => setMaps((j.maps || []).filter((m: Entry) => m.slug.startsWith('site-'))))
      .catch(() => setMaps([]))
  }, [])

  // if more than one map is published the window drifts between them, slowly,
  // the way a shelf of them would be flicked through
  useEffect(() => {
    if (!maps || maps.length < 2) return
    const t = setInterval(() => setI((n) => (n + 1) % maps.length), 14000)
    return () => clearInterval(t)
  }, [maps])

  const show = maps && maps.length ? maps[i % maps.length] : null

  return (
    <main className="arrive">
      {show ? (
        <LivingMap key={show.slug} slug={show.slug} version={show.version} fill="cover" />
      ) : (
        <div className="arrive-dark" />
      )}

      {/* the type sits IN the place, not on a page above it */}
      <div className="arrive-ui">
        <div className="arrive-top">
          <span className="brand">MAPVIS</span>
          <nav>
            <Link to="/atlas">atlas</Link>
            {user ? <Link to="/maps">my maps</Link> : null}
            <Link to={user ? '/account' : '/enter'}>{user ? 'account' : 'sign in'}</Link>
          </nav>
        </div>

        <div className="arrive-mid">
          <Link to={user ? '/maps' : '/enter?new=1'} className="enterbtn">
            make one
          </Link>
        </div>

        <div className="arrive-foot">
          {show ? (
            <span className="here">
              {show.title || show.slug}
              <em>
                {show.w}&times;{show.h}
              </em>
            </span>
          ) : (
            <span className="here">nothing published yet</span>
          )}
          {maps && maps.length > 1 ? (
            <span className="dots">
              {maps.map((m, k) => (
                <button
                  key={m.slug}
                  className={k === i ? 'on' : ''}
                  onClick={() => setI(k)}
                  aria-label={m.slug}
                />
              ))}
            </span>
          ) : null}
        </div>
      </div>
    </main>
  )
}
