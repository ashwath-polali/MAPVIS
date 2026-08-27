/* The landing page. Signed out only.
 *
 * Six paintings, six lines. It advances on its own so somebody who never
 * touches the wheel still sees the whole thing, and scrolling takes it over the
 * instant they do. Both drive the same number, so there is never a moment where
 * the timer and the reader disagree about which stop we are on.
 *
 * THE PAIRING IS NOT DECORATION. The water map is the one where you cut water
 * off. The six-terrace map is the one about marking ground. The crowded market
 * is the one about things that move. The canyon has a real door carved into the
 * cliff. Nobody will read it as a diagram, and nobody will feel it was shuffled
 * either.
 *
 * ON THE WORDS: steps, not slogans. Lower case, imperative, one clause. The
 * previous attempt read as AI because of its SHAPE, not its vocabulary: pairs
 * of balanced fragments and "X is not Y, it is Z". No rewriting saves copy whose
 * structure is the tell.
 */
import { useEffect, useRef, useState } from 'react'
import { go } from './router'

type Beat = { slug: string; say: string; side: 'left' | 'right' }

const BEATS: Beat[] = [
  { slug: 'site-1', say: 'all of this is one painting', side: 'left' },
  { slug: 'site-2', say: 'you cut the water off it by hand', side: 'right' },
  { slug: 'site-3', say: 'then mark the ground people can stand on', side: 'left' },
  { slug: 'site-4', say: 'put things on it that move on their own', side: 'right' },
  { slug: 'site-5', say: 'name the door, and code can find it later', side: 'left' },
  { slug: 'site-6', say: 'export. it is in the game.', side: 'right' },
]

const HOLD = 5200

export default function Landing() {
  const [at, setAt] = useState(0)
  const [ready, setReady] = useState<Record<string, string>>({})
  const paused = useRef(0)
  const wheel = useRef(0)

  /* Every painting is fetched once, up front, and held as an object url. Six
   * images is a quarter of a megabyte and the alternative is a blank frame
   * every time the scroll moves, which is the one thing that would make this
   * feel cheap. */
  useEffect(() => {
    let dead = false
    ;(async () => {
      for (const b of BEATS) {
        try {
          /* THE PUBLISHED SCENE FIRST, THEN THE WORKING ONE.
           *
           * This only ever read the published bundle, which is always fetched
           * from object storage, so the day storage stopped answering the whole
           * page went blank, on a laptop that had every one of these images on
           * its own disk. /work/ is served from disk when this machine has the
           * file, so the fallback costs nothing and cannot be capped. */
          let url: string | null = null
          try {
            const r = await fetch(`/api/v1/maps/${b.slug}`)
            if (r.ok) url = (await r.json()).files?.['scene.png']?.url || null
          } catch {
            /* fall through to the working copy */
          }
          if (dead) return
          let res = url ? await fetch(url) : null
          if (!res || !res.ok) res = await fetch(`/work/${b.slug}/scene.png`)
          if (!res.ok || dead) continue
          const blob = await res.blob()
          if (dead) return
          setReady((s) => ({ ...s, [b.slug]: URL.createObjectURL(blob) }))
        } catch {
          /* a scene that will not load simply does not appear */
        }
      }
    })()
    return () => {
      dead = true
    }
  }, [])

  // it moves on its own, unless somebody just took the wheel
  useEffect(() => {
    const t = setInterval(() => {
      if (Date.now() < paused.current) return
      setAt((n) => (n + 1) % BEATS.length)
    }, HOLD)
    return () => clearInterval(t)
  }, [])

  /* Scroll, keys and touch all mean the same thing: one step. The page itself
   * never scrolls, so the wheel is captured rather than followed, and a
   * threshold keeps a trackpad's momentum from firing six stops at once. */
  useEffect(() => {
    const step = (d: number) => {
      paused.current = Date.now() + 9000
      setAt((n) => Math.max(0, Math.min(BEATS.length - 1, n + d)))
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      wheel.current += e.deltaY
      if (Math.abs(wheel.current) < 90) return
      step(wheel.current > 0 ? 1 : -1)
      wheel.current = 0
    }
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowDown', 'PageDown', ' '].includes(e.key)) {
        e.preventDefault()
        step(1)
      }
      if (['ArrowUp', 'PageUp'].includes(e.key)) {
        e.preventDefault()
        step(-1)
      }
    }
    let y0 = 0
    const onStart = (e: TouchEvent) => (y0 = e.touches[0].clientY)
    const onEnd = (e: TouchEvent) => {
      const dy = y0 - e.changedTouches[0].clientY
      if (Math.abs(dy) > 40) step(dy > 0 ? 1 : -1)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchend', onEnd)
    }
  }, [])

  const beat = BEATS[at]

  return (
    <main className="land">
      <div className="land-art">
        {BEATS.map((b, i) => (
          <div
            key={b.slug}
            className={'land-plate' + (i === at ? ' on' : i < at ? ' past' : '')}
            style={ready[b.slug] ? { backgroundImage: `url(${ready[b.slug]})` } : undefined}
          />
        ))}
      </div>

      <div className="land-ui">
        <header>
          <span className="land-mark">MAPVIS</span>
          <button className="land-in" onClick={() => go('/enter')}>
            sign in
          </button>
        </header>

        <div className={'land-say ' + beat.side}>
          <p key={at}>{beat.say}</p>
        </div>

        <footer>
          <button className="land-go" onClick={() => go('/enter?new=1')}>
            make one
          </button>
          <nav className="land-dots" aria-label="progress">
            {BEATS.map((b, k) => (
              <button
                key={b.slug}
                className={k === at ? 'on' : ''}
                onClick={() => {
                  paused.current = Date.now() + 9000
                  setAt(k)
                }}
                aria-label={b.say}
              />
            ))}
          </nav>
        </footer>
      </div>
    </main>
  )
}
