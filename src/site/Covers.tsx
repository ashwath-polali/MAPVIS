/* THE TRANSITION SCREEN EDITOR. Its own editor, linked to a map through a dropdown, because a cover
   belongs to one map: the game picks a cover by where the player is going, so one published inside a
   map's bundle shows on every door and every sail into it with no python naming anything.

   The author says what the screen SHOWS and never how it looks. The hand, the viewpoint, the light
   and the colour are assembled on the server out of the cover scaffold and the account's style card,
   so there is one field here and not five. */
import { useCallback, useEffect, useState } from 'react'
import * as api from '../api'
import './covers.css'

type MapRow = { slug: string; title: string }

/* the word the game says over every cover, spaced by hand there and copied here, so what is judged is
   the frame a student sees rather than a picture on its own. src/app/transitions.tsx draws the real
   one. */
const KICKER = 'E N T E R I N G'

const IDENT = /^[a-z][a-z0-9_]{0,47}$/

/* a slug is never shown to a player, so the preview says what the game would say: the bundle title
   when there is one, and otherwise the slug turned back into words. titleOfMap in the game does the
   same thing for the same reason. */
const readable = (m: MapRow | undefined) =>
  (m?.title || m?.slug || 'this map').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/* the picture inside the frame the game draws round it. A cover is judged with the title ACROSS it,
   because that is where the title lands: a subject sitting dead centre is the one mistake this
   preview exists to catch. */
function Shot({ src, title, caption }: { src: string; title: string; caption: string }) {
  return (
    <figure className="cvr-shot">
      <div className="cvr-pic">
        <img src={src} alt="" draggable={false} />
        <div className="cvr-vig" />
        <div className="cvr-text">
          <div className="cvr-kicker">{KICKER}</div>
          <div className="cvr-band">
            <span className="cvr-title">{title.toUpperCase()}</span>
          </div>
          <div className="cvr-meter">
            <i />
          </div>
        </div>
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  )
}

export default function Covers({ maps }: { maps: MapRow[] }) {
  const [slug, setSlug] = useState('')
  const [ask, setAsk] = useState('')
  const [name, setName] = useState('')
  const [made, setMade] = useState('')
  const [busy, setBusy] = useState('')
  const [said, setSaid] = useState('')
  const [has, setHas] = useState<{ cover: boolean; covers: string[] }>({ cover: false, covers: [] })
  const [bust, setBust] = useState(0)

  /* the first map is picked for you, because a dropdown that starts on nothing makes the whole panel
     look broken until you touch it */
  useEffect(() => {
    if (!slug && maps.length) setSlug(maps[0].slug)
  }, [maps, slug])

  const load = useCallback(async (s: string) => {
    if (!s) return
    try {
      setHas(await api.coversOf(s))
    } catch {
      /* a map that has never been saved carries nothing, which is not a fault */
      setHas({ cover: false, covers: [] })
    }
  }, [])

  useEffect(() => {
    void load(slug)
    setMade('')
    setSaid('')
  }, [slug, load])

  const map = maps.find((m) => m.slug === slug)
  const title = readable(map)

  /* ONE generation, on the press and never before it. The prompt is built on the server so a client
     cannot ask for a hand it was never granted. */
  const draw = useCallback(async () => {
    const words = ask.trim()
    if (!words || !slug) return
    setBusy('drawing')
    setSaid('')
    try {
      const r = await api.coverGen(words)
      const started = Date.now()
      for (;;) {
        const s = await api.jobState(r.job.id)
        if (s.state === 'done' && s.images && s.images[0]) {
          setMade(s.images[0])
          setSaid(`${r.w}x${r.h} · not kept yet`)
          break
        }
        if (s.state === 'failed') throw new Error(s.error || 'it did not come back')
        if (Date.now() - started > 300000) throw new Error('it did not come back within five minutes')
        await new Promise((res) => setTimeout(res, 2500))
      }
    } catch (e) {
      setSaid(String(e instanceof Error ? e.message : e).slice(0, 120))
    } finally {
      setBusy('')
    }
  }, [ask, slug])

  const keep = useCallback(async () => {
    if (!made || !slug) return
    const code = name.trim().toLowerCase()
    if (code && !IDENT.test(code)) {
      setSaid('a code name starts with a letter and holds only letters, numbers and underscores')
      return
    }
    setBusy('keeping')
    try {
      const r = await api.coverSave(slug, made, code || undefined)
      setHas({ cover: r.cover, covers: r.covers })
      setBust(Date.now())
      setMade('')
      setName('')
      setSaid(code ? `kept as ${code}` : 'kept as this map’s own')
    } catch (e) {
      setSaid(String(e instanceof Error ? e.message : e).slice(0, 120))
    } finally {
      setBusy('')
    }
  }, [made, name, slug])

  const drop = useCallback(
    async (code: string) => {
      if (!slug) return
      try {
        const r = await api.coverRemove(slug, code || undefined)
        setHas({ cover: r.cover, covers: r.covers })
        setBust(Date.now())
      } catch (e) {
        setSaid(String(e instanceof Error ? e.message : e).slice(0, 120))
      }
    },
    [slug],
  )

  if (!maps.length)
    return (
      <div className="cvr-empty">
        <p>No maps yet. A cover is the screen a map is entered through, so there has to be a map first.</p>
      </div>
    )

  return (
    <div className="cvr">
      <section className="cvr-side">
        <label className="cvr-field">
          <span>the map it belongs to</span>
          <select value={slug} onChange={(e) => setSlug(e.target.value)}>
            {maps.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.title || m.slug}
              </option>
            ))}
          </select>
        </label>
        {/* the one sentence. What it SHOWS, never how it looks: the look is the account's and the
            shape is the cover's, and both are put on server side. */}
        <label className="cvr-field">
          <span>what the screen shows</span>
          <textarea rows={4} value={ask} placeholder="the ATC lab at dusk, the harbour below" onChange={(e) => setAsk(e.target.value)} />
        </label>
        <p className="cvr-note">
          Say what it shows. The hand is already yours and the shape is already a cover&apos;s, so neither is worth typing. It
          carries no words: the game writes the name over it.
        </p>
        <button className="cvr-go" onClick={() => void draw()} disabled={!!busy || !ask.trim() || !slug}>
          {busy === 'drawing' ? 'drawing…' : 'draw it · 1 generation'}
        </button>
        {said && <p className="cvr-said">{said}</p>}
      </section>

      <section className="cvr-main">
        {made && (
          <>
            <Shot src={made} title={title} caption={said || 'not kept yet'} />
            <div className="cvr-keep">
              <label className="cvr-field">
                <span>code name · leave empty for this map&apos;s own</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void keep()
                  }}
                />
              </label>
              {name.trim() ? (
                <code className="cvr-code">
                  enter(&quot;{slug}&quot;, cover=&quot;{name.trim().toLowerCase()}&quot;)
                </code>
              ) : (
                <p className="cvr-note">With no name it is this map&apos;s own, shown on every door and every sail in.</p>
              )}
              <div className="cvr-row2">
                <button className="cvr-go" onClick={() => void keep()} disabled={!!busy}>
                  {busy === 'keeping' ? 'keeping…' : 'keep it'}
                </button>
                <button className="cvr-x" onClick={() => setMade('')}>
                  discard
                </button>
              </div>
            </div>
          </>
        )}

        <h3 className="cvr-lab">{map ? (map.title || map.slug) : 'this map'} carries</h3>
        {!has.cover && !has.covers.length && (
          <p className="cvr-note">Nothing yet. The game falls back to its own painted cover for this destination.</p>
        )}
        {has.cover && (
          <div className="cvr-have">
            <Shot src={api.coverUrl(slug, undefined, bust)} title={title} caption="this map’s own" />
            <button className="cvr-x" onClick={() => void drop('')}>
              remove
            </button>
          </div>
        )}
        {has.covers.map((c) => (
          <div className="cvr-have" key={c}>
            <Shot src={api.coverUrl(slug, c, bust)} title={title} caption={c} />
            <div>
              <code className="cvr-code">
                enter(&quot;{slug}&quot;, cover=&quot;{c}&quot;)
              </code>
              <button className="cvr-x" onClick={() => void drop(c)}>
                remove
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
