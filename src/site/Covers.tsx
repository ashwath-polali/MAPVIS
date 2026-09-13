/* THE TRANSITION SCREEN EDITOR. Its own editor, linked to a map by picking one, because a cover
   belongs to one map: the game chooses a cover by where the player is going, so one published inside
   a map's bundle shows on every door and every sail into it with no python naming anything.

   The author says what the screen SHOWS and never how it looks. The hand, the viewpoint, the light
   and the colour are assembled on the server out of the cover scaffold and the account's style card,
   so there is one field here and not five. */
import { useCallback, useEffect, useState } from 'react'
import * as api from '../api'
import { displayName } from '../core/naming'
import './covers.css'

export type CoverMap = { slug: string; title?: string; version?: number | null }

/* the word the game says over every cover, spaced by hand there and copied here so what is judged is
   the frame a student sees. src/app/transitions.tsx draws the real one. */
const KICKER = 'E N T E R I N G'
const IDENT = /^[a-z][a-z0-9_]{0,47}$/

/* the working painting first because it is the live one, then the published bundle behind it: the
   same pair and the same reason as the dashboard's cards */
const shot = (m: CoverMap) => `/work/${m.slug}/scene.png`
const fellBack = (m: CoverMap) => (e: { currentTarget: HTMLImageElement }) => {
  if (e.currentTarget.dataset.fell || !m.version) return
  e.currentTarget.dataset.fell = '1'
  e.currentTarget.src = `/api/v1/maps/${encodeURIComponent(m.slug)}/file/${m.version}/scene.png`
}

/* the picture inside the frame the game draws round it. A cover is judged with the title ACROSS it,
   because that is where the title lands: a subject sitting dead centre is the one fault this preview
   exists to catch. */
function Shot({ src, title, caption }: { src: string; title: string; caption?: string }) {
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
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  )
}

export default function Covers({ maps }: { maps: CoverMap[] }) {
  const [slug, setSlug] = useState('')
  const [ask, setAsk] = useState('')
  const [name, setName] = useState('')
  const [made, setMade] = useState('')
  const [busy, setBusy] = useState('')
  const [said, setSaid] = useState('')
  const [has, setHas] = useState<{ cover: boolean; covers: string[] }>({ cover: false, covers: [] })
  const [bust, setBust] = useState(0)
  /* which maps already carry one, so the strip can say so on the thumbnails rather than making
     somebody click ten of them to find out */
  const [carry, setCarry] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!slug && maps.length) setSlug(maps[0].slug)
  }, [maps, slug])

  useEffect(() => {
    let dead = false
    void Promise.all(
      maps.slice(0, 24).map((m) =>
        api
          .coversOf(m.slug)
          .then((c) => [m.slug, !!c.cover] as const)
          .catch(() => [m.slug, false] as const),
      ),
    ).then((rows) => {
      if (!dead) setCarry(Object.fromEntries(rows))
    })
    return () => {
      dead = true
    }
  }, [maps, bust])

  /* THE ANSWER FOR A MAP NOBODY IS LOOKING AT ANY MORE IS THROWN AWAY. Ten thumbnails ask what they
     carry at the same time, so a reply for the map that was selected a moment ago can land after the
     reply for the one selected now, and the panel then says "no cover yet" beside a thumbnail whose
     own dot says there is one. The screen contradicting itself is worse than it being slow. */
  useEffect(() => {
    let dead = false
    setMade('')
    setSaid('')
    if (!slug) return
    api
      .coversOf(slug)
      .then((c) => {
        if (!dead) setHas(c)
      })
      .catch(() => {
        if (!dead) setHas({ cover: false, covers: [] })
      })
    return () => {
      dead = true
    }
  }, [slug, bust])

  const map = maps.find((m) => m.slug === slug)
  const title = displayName({ name: map?.slug || 'this map', title: map?.title }).text

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
          setSaid('')
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
      setSaid('a code name is lowercase letters, numbers and underscores, starting with a letter')
      return
    }
    setBusy('keeping')
    try {
      const r = await api.coverSave(slug, made, code || undefined)
      setHas({ cover: r.cover, covers: r.covers })
      setBust(Date.now())
      setMade('')
      setName('')
      setSaid('')
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
      <div className="cvr-none">
        <p>A cover is the screen a map is entered through.</p>
        <a href="/edit">paint a map first</a>
      </div>
    )

  return (
    <div className="cvr">
      {/* THE MAP IS PICKED BY ITS PAINTING. It was a dropdown of slugs, which is the one control that
          makes a visual tool feel like a form: you choose the island by looking at it. */}
      <div className="cvr-strip" role="tablist" aria-label="which map">
        {maps.map((m) => (
          <button
            key={m.slug}
            role="tab"
            aria-selected={m.slug === slug}
            className={'cvr-map' + (m.slug === slug ? ' on' : '')}
            onClick={() => setSlug(m.slug)}
          >
            <span className="cvr-map-art">
              <img src={shot(m)} alt="" loading="lazy" draggable={false} onError={fellBack(m)} />
              {carry[m.slug] ? <i className="cvr-dot" title="carries a cover" /> : null}
            </span>
            <span className="cvr-map-name">{displayName({ name: m.slug, title: m.title }).text}</span>
          </button>
        ))}
      </div>

      <div className="cvr-body">
        <section className="cvr-ask">
          <h2 className="cvr-h">{title}</h2>
          <textarea
            rows={3}
            value={ask}
            placeholder="the harbour at dusk, the dock and a moored ship"
            onChange={(e) => setAsk(e.target.value)}
          />
          {/* the one fact worth a line: everything else is decided for them */}
          <p className="cvr-hint">no words in the picture &middot; the game writes the name over it</p>
          <button className="cvr-go" onClick={() => void draw()} disabled={!!busy || !ask.trim()}>
            {busy === 'drawing' ? 'drawing…' : 'draw it'}
            <em>1 generation</em>
          </button>
          {said ? <p className="cvr-said">{said}</p> : null}
        </section>

        <section className="cvr-view">
          {made ? (
            <>
              <Shot src={made} title={title} />
              <div className="cvr-keep">
                <input
                  value={name}
                  placeholder="code name, or leave empty for this map's own"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void keep()
                  }}
                />
                {name.trim() ? (
                  <code className="cvr-code">
                    enter(&quot;{slug}&quot;, cover=&quot;{name.trim().toLowerCase()}&quot;)
                  </code>
                ) : null}
                <div className="cvr-acts">
                  <button className="cvr-go" onClick={() => void keep()} disabled={!!busy}>
                    {busy === 'keeping' ? 'keeping…' : 'keep it'}
                  </button>
                  <button className="cvr-x" onClick={() => setMade('')}>
                    discard
                  </button>
                </div>
              </div>
            </>
          ) : has.cover || has.covers.length ? (
            <>
              {has.cover ? (
                <div className="cvr-have">
                  <Shot src={api.coverUrl(slug, undefined, bust)} title={title} caption="shown on every way in" />
                  <button className="cvr-x" onClick={() => void drop('')}>
                    remove
                  </button>
                </div>
              ) : null}
              {has.covers.map((c) => (
                <div className="cvr-have" key={c}>
                  <Shot src={api.coverUrl(slug, c, bust)} title={title} caption={`enter("${slug}", cover="${c}")`} />
                  <button className="cvr-x" onClick={() => void drop(c)}>
                    remove
                  </button>
                </div>
              ))}
            </>
          ) : (
            /* THE SHAPE OF WHAT IS MISSING, at the size it ships at, rather than two lines of text
               floating in an empty column: an empty slot that shows its own dimensions says what the
               press is going to make. */
            <div className="cvr-empty">
              <div className="cvr-empty-frame">
                <span>no cover yet</span>
                <p>the game falls back to its own painted one</p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
