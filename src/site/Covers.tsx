/* THE TRANSITION SCREEN EDITOR. Its own editor, linked to a map by picking one, because a cover
   belongs to one map: the game chooses a cover by where the player is going, so one published inside
   a map's bundle shows on every door and every sail into it with no python naming anything.

   The author says what the screen SHOWS and never how it looks. The hand, the viewpoint, the light
   and the colour are assembled on the server out of the cover scaffold and a style card, so there is
   one sentence to type and not five fields to fill. */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import { displayName } from '../core/naming'
import './covers.css'

export type CoverMap = { slug: string; title?: string; published?: number | null; style?: string }

/* the word the game says over every cover, spaced by hand there and copied here so what is judged is
   the frame a student sees. src/app/transitions.tsx draws the real one. */
const KICKER = 'E N T E R I N G'
const IDENT = /^[a-z][a-z0-9_]{0,47}$/
/* the two words the game already spends on the cover argument: an OCCASION rather than a name, so a
   cover called either of them ships in the bundle and can never be shown. Refused where it is typed
   rather than discovered when nothing appears. */
const RESERVED = new Set(['ceremony', 'passing'])
// one of the sentences the game prints under the bar, so the preview is not judged with a hole where its longest line goes
const SAMPLE_FACT = 'Bonney Lake offers 26 AP courses, and a retake is allowed on every one of them.'

/* the working painting first because it is the live one, then the published bundle behind it: the
   same pair and the same reason as the dashboard's cards */
const shot = (m: CoverMap) => `/work/${m.slug}/scene.png`
const fellBack = (m: CoverMap) => (e: { currentTarget: HTMLImageElement }) => {
  if (e.currentTarget.dataset.fell || !m.published) return
  e.currentTarget.dataset.fell = '1'
  e.currentTarget.src = `/api/v1/maps/${encodeURIComponent(m.slug)}/file/${m.published}/scene.png`
}

/* THE PICTURE INSIDE THE FRAME THE GAME DRAWS ROUND IT, and it is a scale model rather than a
   likeness. Every size in covers.css is the game's own number over a 1280 wide window divided by
   1280 and said in cqw, so the stack sits where src/app/transitions.css puts it: the text block
   centred at 46 percent of the height, the plate at the full 700px width rather than shrink-wrapped
   to the word, the bar under it and the fact under that. A subject sitting dead centre, or a horizon
   the plate cuts in half, is the one fault this preview exists to catch. */
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
          <div className="cvr-work">LOADING</div>
          <p className="cvr-fact">{SAMPLE_FACT}</p>
        </div>
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  )
}

/* what came back from one press, and WHICH MAP IT WAS PRESSED FOR. Held together because the two
   drifted apart: a job takes minutes, the strip is one click, and a picture bought for the harbour
   was written onto whichever island happened to be selected when it landed. */
type Made = { src: string; slug: string; subject: string; style: string }

export default function Covers({ maps }: { maps: CoverMap[] }) {
  const [slug, setSlug] = useState('')
  const [ask, setAsk] = useState('')
  const [name, setName] = useState('')
  const [made, setMade] = useState<Made | null>(null)
  const [busy, setBusy] = useState('')
  const [said, setSaid] = useState('')
  const [has, setHas] = useState<api.CoverState>({ cover: false, covers: [] })
  const [bust, setBust] = useState(0)
  /* which maps already carry one, so the strip can say so on the thumbnails rather than making
     somebody click ten of them to find out */
  const [carry, setCarry] = useState<Record<string, boolean>>({})
  /* THE HAND, WHICH NEVER USED TO REACH A PRESS. This editor sent no style key at all and the server
     resolves a card from the key it is given, so every cover was bought with no card and no reference
     painting: the one thing an author should not have to say was the one thing nobody said. The map's
     own hand is the default, because a cover for an island should be drawn by whoever drew it. */
  const [cards, setCards] = useState<api.StyleCard[]>([])
  const [fallback, setFallback] = useState('')
  const [styleKey, setStyleKey] = useState('')
  const [touchedStyle, setTouchedStyle] = useState(false)
  // one press says what it is about to spend and the second spends it, the rule every other paid press in this tool follows
  const [armed, setArmed] = useState('')
  const armTimer = useRef<number | undefined>(undefined)

  const arm = useCallback((what: string) => {
    setArmed(what)
    window.clearTimeout(armTimer.current)
    armTimer.current = window.setTimeout(() => setArmed(''), 6000)
  }, [])
  const disarm = useCallback(() => {
    window.clearTimeout(armTimer.current)
    setArmed('')
  }, [])
  useEffect(() => () => window.clearTimeout(armTimer.current), [])

  useEffect(() => {
    if (!slug && maps.length) setSlug(maps[0].slug)
  }, [maps, slug])

  useEffect(() => {
    let dead = false
    api
      .styles()
      .then((r) => {
        if (dead) return
        setCards(r.cards)
        setFallback(r.fallback || '')
      })
      .catch(() => {
        /* no database and no account is the one-laptop case: the words go out as typed */
      })
    return () => {
      dead = true
    }
  }, [])

  useEffect(() => {
    let dead = false
    void Promise.all(
      maps.slice(0, 24).map((m) =>
        api
          .coversOf(m.slug)
          .then((c) => [m.slug, !!c.cover || c.covers.length > 0] as const)
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
    setSaid('')
    disarm()
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
  }, [slug, bust, disarm])

  const map = maps.find((m) => m.slug === slug)
  const title = displayName({ name: map?.slug || 'this map', title: map?.title }).text
  const mapStyle = map?.style || ''

  // the map's own hand until somebody picks another, and then theirs stands for the rest of the sitting
  useEffect(() => {
    if (touchedStyle) return
    setStyleKey(mapStyle || fallback || '')
  }, [mapStyle, fallback, touchedStyle])

  const draw = useCallback(async () => {
    const words = ask.trim()
    if (!words || !slug) return
    if (armed !== 'draw') {
      arm('draw')
      return
    }
    disarm()
    const forSlug = slug
    setBusy('drawing')
    setSaid('')
    try {
      const r = await api.coverGen(words, styleKey, forSlug)
      const started = Date.now()
      let misses = 0
      for (;;) {
        /* one bad poll is not a lost generation: the job is still running and the money is already
           spent, so a network blink used to throw the picture away and invite a second press */
        const s = await api.jobState(r.job.id).catch((e) => {
          if (++misses > 8) throw e
          return { state: 'running' as const, images: undefined, error: undefined }
        })
        if (s.state === 'done' && s.images && s.images[0]) {
          setMade({ src: s.images[0], slug: forSlug, subject: words, style: styleKey })
          break
        }
        if (s.state === 'failed') throw new Error(s.error || 'it did not come back')
        if (Date.now() - started > 300000) throw new Error('it did not come back within five minutes')
        await new Promise((res) => setTimeout(res, 2500))
      }
    } catch (e) {
      setSaid(String(e instanceof Error ? e.message : e).slice(0, 160))
    } finally {
      setBusy('')
    }
  }, [ask, slug, styleKey, armed, arm, disarm])

  const keep = useCallback(async () => {
    if (!made) return
    const code = name.trim().toLowerCase()
    if (code && !IDENT.test(code)) {
      setSaid('a code name is lowercase letters, numbers and underscores, starting with a letter')
      return
    }
    if (code && RESERVED.has(code)) {
      setSaid(`"${code}" is a word the game already spends on this argument, so a cover called that could never be shown`)
      return
    }
    setBusy('keeping')
    try {
      const r = await api.coverSave(made.slug, made.src, code || undefined, made.subject, made.style)
      if (made.slug === slug) setHas(r)
      setBust(Date.now())
      setMade(null)
      setName('')
      setSaid('')
    } catch (e) {
      setSaid(String(e instanceof Error ? e.message : e).slice(0, 160))
    } finally {
      setBusy('')
    }
  }, [made, name, slug])

  const drop = useCallback(
    async (code: string) => {
      if (!slug) return
      const key = 'drop:' + code
      if (armed !== key) {
        arm(key)
        return
      }
      disarm()
      try {
        const r = await api.coverRemove(slug, code || undefined)
        setHas(r)
        setBust(Date.now())
      } catch (e) {
        setSaid(String(e instanceof Error ? e.message : e).slice(0, 160))
      }
    },
    [slug, armed, arm, disarm],
  )

  if (!maps.length)
    return (
      <div className="cvr-none">
        <p>A cover is the screen a map is entered through.</p>
        <a href="/edit">paint a map first</a>
      </div>
    )

  const madeMap = made ? maps.find((m) => m.slug === made.slug) : undefined
  const madeTitle = made ? displayName({ name: made.slug, title: madeMap?.title }).text : ''
  const replacing = !!made && made.slug === slug && !name.trim() && has.cover
  const note = has.notes && has.notes.cover ? has.notes.cover : null

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
              {made && made.slug === m.slug ? <i className="cvr-pend" title="a drawn cover is waiting here" /> : null}
            </span>
            <span className="cvr-map-name">{displayName({ name: m.slug, title: m.title }).text}</span>
          </button>
        ))}
      </div>

      <div className="cvr-body">
        <section className="cvr-ask">
          <h2 className="cvr-h">{title}</h2>
          {!map?.title ? <p className="cvr-hint">this map has no title, so the game reads its name off the id</p> : null}
          {/* the hand comes before the sentence, the same order the map editor asks in, and it is only a choice where there is more than one to make */}
          {cards.length > 0 ? (
            <div className="cvr-hands">
              {cards.map((c) => (
                <button
                  key={c.key}
                  className={'cvr-hand' + (styleKey === c.key ? ' on' : '')}
                  title={c.clause}
                  onClick={() => {
                    setStyleKey(c.key)
                    setTouchedStyle(true)
                    disarm()
                  }}
                >
                  {c.title}
                  {c.house ? <span className="cvr-hand-tag">house</span> : null}
                </button>
              ))}
              <button
                className={'cvr-hand' + (styleKey === '' ? ' on' : '')}
                title="no style card, the words go out as typed"
                onClick={() => {
                  setStyleKey('')
                  setTouchedStyle(true)
                  disarm()
                }}
              >
                Other
              </button>
            </div>
          ) : null}
          <textarea
            rows={3}
            value={ask}
            placeholder="the harbour at dusk, the dock and a moored ship"
            onChange={(e) => {
              setAsk(e.target.value)
              disarm()
            }}
          />
          {/* the one fact worth a line: everything else is decided for them */}
          <p className="cvr-hint">no words in the picture &middot; the game writes the name over it</p>
          <button
            className={'cvr-go' + (armed === 'draw' ? ' armed' : '')}
            onClick={() => void draw()}
            disabled={!!busy || !ask.trim()}
          >
            {busy === 'drawing' ? 'drawing…' : armed === 'draw' ? 'yes, draw it' : 'draw it'}
            <em>{armed === 'draw' ? 'this spends 1 generation' : '1 generation'}</em>
          </button>
          {said ? <p className="cvr-said">{said}</p> : null}
        </section>

        <section className="cvr-view">
          {made ? (
            <>
              <Shot src={made.src} title={madeTitle} caption={made.slug === slug ? undefined : `drawn for ${madeTitle}`} />
              <div className="cvr-keep">
                {made.slug !== slug ? (
                  /* the picture belongs to the map it was pressed on, so switching the strip cannot walk it onto another island */
                  <p className="cvr-said">this was drawn for {madeTitle} and is kept there, whichever map is selected</p>
                ) : null}
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
                    yield enter(&quot;{made.slug}&quot;, cover=&quot;{name.trim().toLowerCase()}&quot;)
                  </code>
                ) : null}
                {replacing ? (
                  /* what is about to be thrown away, on screen at the moment it is thrown away */
                  <div className="cvr-swap">
                    <img src={api.coverUrl(slug, undefined, bust)} alt="" />
                    <span>keeping this replaces the cover it already has</span>
                  </div>
                ) : null}
                <div className="cvr-acts">
                  <button className="cvr-go" onClick={() => void keep()} disabled={!!busy}>
                    {busy === 'keeping' ? 'keeping…' : 'keep it'}
                  </button>
                  <button className="cvr-x" onClick={() => setMade(null)}>
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
                  {note && note.subject ? <p className="cvr-note">asked for: {note.subject}</p> : null}
                  <button className={'cvr-x' + (armed === 'drop:' ? ' armed' : '')} onClick={() => void drop('')}>
                    {armed === 'drop:' ? 'yes, remove it' : 'remove'}
                  </button>
                </div>
              ) : (
                /* a map with names and no default still shows the game's own art on an ordinary door, which is worth saying where it is true */
                <p className="cvr-said">
                  this map has named covers and no default, so an ordinary door still shows the game&rsquo;s own
                </p>
              )}
              {has.covers.map((c) => (
                <div className="cvr-have" key={c}>
                  <Shot src={api.coverUrl(slug, c, bust)} title={title} caption={`yield enter("${slug}", cover="${c}")`} />
                  {has.notes && has.notes.named[c] && has.notes.named[c].subject ? (
                    <p className="cvr-note">asked for: {has.notes.named[c].subject}</p>
                  ) : null}
                  <button className={'cvr-x' + (armed === 'drop:' + c ? ' armed' : '')} onClick={() => void drop(c)}>
                    {armed === 'drop:' + c ? 'yes, remove it' : 'remove'}
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
