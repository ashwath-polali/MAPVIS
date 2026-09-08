/* The landing page, signed out only. Six paintings, six lines, advancing on their own until somebody scrolls; both drive one number so the timer and the reader never disagree. The pairing is not decoration: each painting is the one its line is about. Steps, not slogans. */
import { useEffect, useRef, useState } from 'react'
import { go } from './router'

type Beat = { slug: string; say: string; side: 'left' | 'right' }

const BEATS: Beat[] = [
  // the words are the running order; only which painting carries each one moved
  { slug: 'site-6', say: 'all of this is one painting', side: 'left' },
  { slug: 'site-2', say: 'you cut the water off it by hand', side: 'right' },
  { slug: 'site-3', say: 'then mark the ground people can stand on', side: 'left' },
  { slug: 'site-4', say: 'put things on it that move on their own', side: 'right' },
  { slug: 'site-5', say: 'name the door, and code can find it later', side: 'left' },
  { slug: 'site-1', say: 'export. it is in the game.', side: 'right' },
]

const HOLD = 5200

export default function Landing() {
  const [at, setAt] = useState(0)
  const [ready, setReady] = useState<Record<string, string>>({})
  const paused = useRef(0)
  const wheel = useRef(0)

  /* Every painting is fetched up front and held as an object url. Six images is a quarter of a megabyte; the alternative is a blank frame every time the scroll moves. */
  useEffect(() => {
    let dead = false
    ;(async () => {
      for (const b of BEATS) {
        try {
          /* THE SHIPPED COPY FIRST: this is a picture on a homepage. Reading the published bundle broke twice, once when publishes did not migrate buckets and once when /work/ started requiring ownership a stranger does not have. */
          let res: Response | null = await fetch(`/site-art/${b.slug}.png`).catch(() => null)
          if (!res || !res.ok || !/image/.test(res.headers.get('content-type') || '')) {
            let url: string | null = null
            try {
              const r = await fetch(`/api/v1/maps/${b.slug}`)
              if (r.ok) url = (await r.json()).files?.['scene.png']?.url || null
            } catch {
              /* fall through to the working copy */
            }
            if (dead) return
            res = url ? await fetch(url) : null
            if (!res || !res.ok) res = await fetch(`/work/${b.slug}/scene.png`)
          }
          if (!res || !res.ok || dead) continue
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
