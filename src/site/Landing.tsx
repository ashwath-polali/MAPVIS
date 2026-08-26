/* The landing page. Signed out only.
 *
 * One painted place, a camera that walks you across it, and a line of text at
 * each stop saying what happens there. Nothing scrolls.
 *
 * ON THE WORDS: they are steps, not slogans. Lower case, imperative, one clause
 * each, no metaphor, no pair of balanced fragments, no "X is not Y, it is Z".
 * That construction and that rhythm are the tell, and no amount of rewriting
 * fixes copy whose SHAPE is wrong. A tool describes itself by saying what you
 * do with it.
 */
import { useCallback, useEffect, useState } from 'react'
import { go } from './router'
import { useTour, type Stop } from './Tour'

type Entry = { slug: string; version: number; w: number; h: number }

/* The tour, authored here for now. Once a site scene exists these come off its
 * own anchors, so the walkthrough is arranged in MAPVIS by moving marks around
 * on the painting rather than by editing numbers in a file. */
const SCRIPT: Array<Omit<Stop, 'x' | 'y'> & { at: [number, number] }> = [
  { at: [0.5, 0.5], z: 1, say: 'this whole place was one painting', side: 'left' },
  { at: [0.3, 0.62], z: 2.4, say: 'you cut the water off it by hand', side: 'right' },
  { at: [0.52, 0.44], z: 2.2, say: 'then mark the ground people can stand on', side: 'left' },
  { at: [0.68, 0.58], z: 2.6, say: 'put things on it that move on their own', side: 'left' },
  { at: [0.46, 0.36], z: 2.8, say: 'name the door, so somebody can write code that finds it', side: 'right' },
  { at: [0.5, 0.5], z: 1.15, say: 'press export. it is in the game.', side: 'left' },
]

export default function Landing() {
  const [scene, setScene] = useState<Entry | null | 'none'>(null)
  const [i, setI] = useState(0)
  const onStop = useCallback((n: number) => setI(n), [])

  useEffect(() => {
    fetch('/api/v1/maps')
      .then((r) => r.json())
      .then((j) => {
        const site = (j.maps || []).filter((m: Entry & { slug: string }) => m.slug.startsWith('site-'))
        setScene(site.length ? site[0] : 'none')
      })
      .catch(() => setScene('none'))
  }, [])

  const w = scene && scene !== 'none' ? scene.w : 1
  const h = scene && scene !== 'none' ? scene.h : 1
  const stops: Stop[] = SCRIPT.map((s) => ({ ...s, x: s.at[0] * w, y: s.at[1] * h }))

  const tour = useTour({
    slug: scene && scene !== 'none' ? scene.slug : '',
    version: scene && scene !== 'none' ? scene.version : 0,
    stops,
    onStop,
  })

  const line = SCRIPT[i] || SCRIPT[0]

  return (
    <main className="land">
      {scene && scene !== 'none' ? tour.view : <Unpainted />}

      <div className="land-ui">
        <header>
          <span className="land-mark">MAPVIS</span>
          <button className="land-in" onClick={() => go('/enter')}>
            sign in
          </button>
        </header>

        {/* the line sits beside the thing it is about, and swaps by fading
            through rather than sliding, so nothing on screen is ever moving in
            two directions at once */}
        <div className={'land-say ' + (line.side || 'left')}>
          <p key={i}>{line.say}</p>
        </div>

        <footer>
          <button className="land-go" onClick={() => go('/enter?new=1')}>
            make one
          </button>
          <nav className="land-dots" aria-label="jump">
            {SCRIPT.map((s, k) => (
              <button
                key={k}
                className={k === i ? 'on' : ''}
                onClick={() => {
                  setI(k)
                  tour.goTo(k)
                }}
                aria-label={s.say}
              />
            ))}
          </nav>
        </footer>
      </div>
    </main>
  )
}

/* No site scene has been painted yet. Say so plainly rather than shipping a
 * placeholder that pretends to be art. */
function Unpainted() {
  return (
    <div className="land-unpainted">
      <span>no scene painted yet</span>
    </div>
  )
}
