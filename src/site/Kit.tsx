/* THE UI LIBRARY: the shelf of drawn pieces the game's interface is made of.
 *
 * A picture of a page is not a page. The generator will happily draw a dialogue
 * box, and what comes back is a png; the vine still has to know that the
 * speaker's name goes at 14,9 and that the frame's top edge is 49 pixels deep
 * so the corners do not deform when the panel is stretched. Without those
 * marks, nineteen call sites in the game say `background: <a png> center /
 * 100% 100% no-repeat` and squash one whole painting into whatever box the
 * element happens to be. This page is where the marks get made.
 *
 * docs/UI-KIT.md is the authority for the twenty-one types, the region
 * vocabulary and the export shape, and server/store/ui.mjs holds the rules.
 * Nothing here re-derives any of it: the type list, its presets, its region set
 * and every enum arrive from GET /api/ui, so a second copy cannot drift.
 *
 * WHAT THE PAGE IT REPLACES GOT WRONG, and it is worth naming so it does not
 * come back. /surfaces opened with a blank rectangle and a text box, which
 * assumes the author already knows what a dialogue box is made of. It led with
 * the price under the button, which is why it read as a bill. Its region editor
 * had no piece under it, so six unlabelled rectangles had to be rediscovered
 * every time. And it could not produce the one thing the game can consume,
 * which is four edge numbers.
 *
 * SO THE ORDER HERE IS: pick a type, see the canvas that will be drawn as a
 * picture rather than as a paragraph, describe the piece in your own words.
 * Then drag four edges over the art and watch the piece stretch beside it,
 * because four numbers you can see working beat four numbers you measured in an
 * image editor and typed in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { go } from './router'
import { useSession } from './session'
import { displayName } from '../core/naming'
import './kit.css'

/* ---- what the server says a piece is ------------------------------------- */

type Rect = { x: number; y: number; w: number; h: number }
type Region = Rect & {
  name: string
  kind: string
  align?: string
  valign?: string
  fit?: string
  axis?: string
  mode?: string
  wrap?: string
  overflow?: string
}
type Slice = { top: number; right: number; bottom: number; left: number }
type Repeat = { x: string; y: string }

type Piece = {
  name: string
  type: string
  title: string
  description: string
  w: number
  h: number
  status: 'pending' | 'ready' | 'failed'
  core: boolean
  published: boolean
  regions: Region[]
  slice?: Slice
  scale?: number
  fill?: boolean
  repeat?: Repeat
  css?: string
  src?: string
  createdAt: number
}

type PType = {
  name: string
  label: string
  tier: 'ground' | 'sheet' | 'painted' | 'none'
  order: number
  stretch: 'both' | 'x' | 'y' | 'none'
  w: number
  h: number
  elements: string[] | null
  faces: string[]
  facesFree: boolean
  fill: boolean
  regions: { name: string; kind: string; required: boolean }[]
  what: string
  why: string
  caution: string
}

type Vocab = {
  ui: Piece[]
  types: PType[]
  core: string[]
  pending: { name: string; since: number } | null
  kinds: string[]
  valigns: string[]
  fits: string[]
  fillAxes: string[]
  fillModes: string[]
  repeats: string[]
  wraps: string[]
  overflows: string[]
  floor: number
}

type MapRow = { slug: string; title: string }

/* the same shape a piece name has to read as, and the same one an anchor name
 * does. It is deliberately a python identifier so that renaming a piece for a
 * person cannot silently break a member's island. */
const IDENT = /^[a-z][a-z0-9_]{0,47}$/

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

const post = async (path: string, body: unknown) => {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = (await r.json().catch(() => ({}))) as { error?: string; warnings?: string[] }
  if (!r.ok) throw new Error(j.error || `that did not work (${r.status})`)
  return j
}

/* ---- the page ------------------------------------------------------------ */

export default function Kit() {
  const { user, loading } = useSession()
  const [v, setV] = useState<Vocab | null>(null)
  const [maps, setMaps] = useState<MapRow[]>([])
  const [mine, setMine] = useState(false)
  /* THE PICTURE IS SERVED IMMUTABLE FOR A YEAR, which is right for a classroom
   * of thirty chromebooks and wrong for the editor that just redrew it. One
   * stamp per load busts it here and nowhere else. */
  const [stamp, setStamp] = useState(() => Date.now())
  // '' is the shelf, a type name is the making form, 'piece:<name>' is marking
  const [where, setWhere] = useState('')

  const load = useCallback(async () => {
    const r = await fetch('/api/ui')
    if (!r.ok) return
    setV((await r.json()) as Vocab)
    setStamp(Date.now())
  }, [])

  useEffect(() => {
    if (loading) return
    if (!user) {
      go('/', true)
      return
    }
    void load()
    fetch('/api/my-maps')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { maps?: MapRow[] }) => setMaps(j.maps || []))
      .catch(() => {})
    /* CORE CHROME BELONGS TO ONE ACCOUNT, the same one the ocean does, so that
     * is the question being asked. Everyone else makes an additive piece, which
     * is the whole of what a member's piece is meant to be. */
    fetch('/api/world/mine')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { mine?: boolean }) => setMine(j.mine !== false))
      .catch(() => setMine(false))
  }, [user, loading, load])

  /* Polling that stops when nothing is drawing, which is the one thing worth
   * keeping from the page this replaces. A row sits in `pending` for the whole
   * minute and a half a generation takes and for no longer. */
  useEffect(() => {
    if (!v?.pending) return
    const t = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(t)
  }, [v?.pending, load])

  const types = useMemo(() => (v?.types || []).slice().sort((a, b) => a.order - b.order), [v])
  const byType = useMemo(() => new Map(types.map((t) => [t.name, t])), [types])

  const open = where.startsWith('piece:') ? (v?.ui || []).find((p) => p.name === where.slice(6)) : undefined
  const making = !where.startsWith('piece:') && where ? byType.get(where) : undefined

  return (
    <div className="kit">
      <header className="home-bar">
        <button className="home-mark" onClick={() => go('/')} aria-label="home">
          MAPVIS
        </button>
        <div className="home-bar-r">
          {where ? (
            <button className="kit-back" onClick={() => setWhere('')}>
              &larr; the library
            </button>
          ) : null}
        </div>
      </header>

      <main className="kit-body">
        {!v ? (
          <div className="kit-wait" />
        ) : open ? (
          <Marking
            key={open.name}
            piece={open}
            type={open.type ? byType.get(open.type) : undefined}
            v={v}
            stamp={stamp}
            onSaved={() => void load()}
            onGone={() => {
              setWhere('')
              void load()
            }}
            onRedraw={() => setWhere(open.type || '')}
          />
        ) : making ? (
          <Making
            key={making.name}
            t={making}
            v={v}
            maps={maps}
            mine={mine}
            onDrawn={(name) => {
              void load()
              setWhere('piece:' + name)
            }}
            onBack={() => setWhere('')}
          />
        ) : (
          <Shelf v={v} types={types} stamp={stamp} onOpen={(n) => setWhere('piece:' + n)} onMake={(t) => setWhere(t)} />
        )}
      </main>
    </div>
  )
}

/* ---- the shelf ------------------------------------------------------------
 *
 * Art first, words second. Every card is the piece's own picture at a size
 * where you can see what it is, on a checker so the transparency chrome
 * always carries reads as transparency rather than as black.
 *
 * A core piece and a member piece read differently on purpose. Core chrome is
 * the whole game's and is never overridable; a member's piece is added beside
 * it. That is a fact about who owns the thing, so it is a mark on the card
 * rather than a column in a table.
 */
function Shelf({
  v,
  types,
  stamp,
  onOpen,
  onMake,
}: {
  v: Vocab
  types: PType[]
  stamp: number
  onOpen: (name: string) => void
  onMake: (type: string) => void
}) {
  const tiers: Array<[string, string, PType['tier']]> = [
    ['grounds', 'they stretch, so they carry four edge numbers', 'ground'],
    ['sheets', 'one canvas holding a family of faces, cut by marked rectangles', 'sheet'],
    ['paintings', 'keyed to a place, and never stretched', 'painted'],
  ]
  const at = new Map(types.map((t) => [t.name, t]))
  const owned = (tier: PType['tier']) => v.ui.filter((p) => at.get(p.type)?.tier === tier)
  const loose = v.ui.filter((p) => !at.has(p.type))

  return (
    <>
      <div className="kit-lede">
        <h1 className="d2">The UI library</h1>
        <p className="kit-sub">
          Every panel, plaque, button and mark the game is drawn out of. One kit for the whole game: a member&rsquo;s
          piece is added beside the chrome and never over it.
        </p>
      </div>

      {v.pending ? (
        <p className="kit-live">
          <span className="kit-pulse" aria-hidden />
          {displayName(v.pending.name).text} is being drawn. One at a time, so the next one starts after this one has
          been looked at.
        </p>
      ) : null}

      {v.ui.length === 0 ? (
        <div className="nothing kit-blank">
          <p className="nothing-say">
            Nothing is drawn yet. Twenty-one kinds of piece are waiting below, and each one already knows its own
            canvas, its own marks and what it is for.
          </p>
          <p className="nothing-do">pick one and describe it</p>
        </div>
      ) : (
        tiers.map(([title, why, tier]) => {
          const rows = owned(tier)
          if (!rows.length) return null
          return (
            <section className="kit-sec" key={tier}>
              <h2 className="label tick">{title}</h2>
              <p className="kit-why">{why}</p>
              <div className="kit-shelf">
                {rows.map((p) => (
                  <PieceCard key={p.name} p={p} t={at.get(p.type)} stamp={stamp} onOpen={() => onOpen(p.name)} />
                ))}
              </div>
            </section>
          )
        })
      )}

      {loose.length ? (
        <section className="kit-sec">
          <h2 className="label tick">unfiled</h2>
          <p className="kit-why">drawn before the type list existed, so nothing knows what these stretch like</p>
          <div className="kit-shelf">
            {loose.map((p) => (
              <PieceCard key={p.name} p={p} stamp={stamp} onOpen={() => onOpen(p.name)} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="kit-sec">
        <h2 className="label tick">make a piece</h2>
        <p className="kit-why">
          the type carries the canvas, the marks it normally holds and the one thing to be careful of, so all that is
          left to say is what this one looks like
        </p>
        <div className="kit-types">
          {types.map((t) => (
            <TypeTile key={t.name} t={t} owned={v.ui.some((p) => p.type === t.name)} onPick={() => onMake(t.name)} />
          ))}
        </div>
      </section>
    </>
  )
}

function PieceCard({ p, t, stamp, onOpen }: { p: Piece; t?: PType; stamp: number; onOpen: () => void }) {
  const said = displayName({ name: p.name, label: p.title })
  const needsEdges = t?.tier === 'ground' && !p.slice
  return (
    <button className={'kit-piece' + (p.core ? ' core' : '')} onClick={onOpen}>
      <span className="kit-art">
        {p.src ? (
          <img src={`${p.src}?v=${stamp}`} alt="" draggable={false} />
        ) : (
          <span className="kit-void" data-say={p.status === 'failed' ? 'nothing came back' : 'still drawing'} />
        )}
      </span>
      <span className="kit-piece-say">
        <span className={'kit-piece-name' + (said.derived ? ' guessed' : '')}>{said.text}</span>
        <span className="kit-piece-meta mono">
          {p.w}&times;{p.h}
          {t ? ' · ' + t.label.toLowerCase() : ''}
        </span>
        <span className="kit-piece-state">
          <span className="kit-owner">{p.core ? 'core chrome' : 'added'}</span>
          {p.published ? <span className="kit-done">measured</span> : needsEdges ? <span className="kit-todo">wants its edges</span> : null}
        </span>
      </span>
    </button>
  )
}

/* One type, as the canvas it will be drawn on rather than as a row in a list.
 * A season token is about 24 pixels across and the generator will not draw
 * anything under 192 on a side, which is why six of these are sheets, and the
 * only way to feel that is to see a 384 square next to a 688 by 384. */
function TypeTile({ t, owned, onPick }: { t: PType; owned: boolean; onPick: () => void }) {
  const refused = t.tier === 'none'
  return (
    <button
      className={'kit-type' + (refused ? ' refused' : '') + (owned ? ' owned' : '')}
      onClick={onPick}
      aria-disabled={refused}
    >
      <span className="kit-type-pic">{refused ? <span className="kit-nope">not drawn</span> : <CanvasPic t={t} />}</span>
      <span className="kit-type-name">{t.label}</span>
      <span className="kit-type-size mono">{refused ? 'named so nobody spends on it' : `${t.w}×${t.h}`}</span>
    </button>
  )
}

/* THE CANVAS, AT A SIZE YOU CAN COMPARE. One scale for every type, so the
 * rectangles are honestly to each other: the widest gate is 688, drawn 232
 * across. A sheet shows its faces as cuts, because that is what comes back and
 * what has to be marked afterwards. */
function CanvasPic({ t, big = false }: { t: PType; big?: boolean }) {
  /* THE WIDEST GATE IS 688 AND THE TALLEST IS ALSO 688, so one divisor makes
   * every rectangle honest against every other and keeps the biggest inside the
   * box it is drawn in. Scaled off the tile's width instead, the 384 by 688
   * rail was 232 tall in a 128 tall tile and every canvas spilled over its
   * neighbour. */
  const k = (big ? 340 : 140) / 688
  const w = Math.round(t.w * k)
  const h = Math.round(t.h * k)
  /* a free sheet is drawn as nine cells and not as four, because four cells
   * reads as a count of four and the count is exactly the thing nobody knows
   * until the picture is back and somebody cuts it */
  const n = t.facesFree ? 9 : t.faces.length
  const cols = n ? Math.ceil(Math.sqrt(n)) : 0
  const rows = n ? Math.ceil(n / cols) : 0
  return (
    /* ONE MARK PER CANVAS. A plank both stretches and comes back as three
       faces, and drawing the stretch dashes across the face grid made the tile
       read as noise rather than as a shape. The faces win, because the grid is
       the thing that is not obvious. */
    <span className="kit-canvaspic" style={{ width: w, height: h }} data-stretch={cols ? 'none' : t.stretch}>
      {cols ? (
        <span className="kit-facegrid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
          {Array.from({ length: cols * rows }, (_, i) => (
            <i key={i} className={i < n ? 'on' : ''} />
          ))}
        </span>
      ) : null}
    </span>
  )
}

/* ---- making a piece -------------------------------------------------------
 *
 * The type supplies the canvas, the generator's element list and the marks the
 * piece normally carries. What is left for a person is what this one looks
 * like, in their own words, and that is the only text box on the screen.
 */
function Making({
  t,
  v,
  maps,
  mine,
  onDrawn,
  onBack,
}: {
  t: PType
  v: Vocab
  maps: MapRow[]
  mine: boolean
  onDrawn: (name: string) => void
  onBack: () => void
}) {
  const taken = useMemo(() => new Set(v.ui.map((p) => p.name)), [v.ui])
  const had = v.ui.find((p) => p.type === t.name)
  const [name, setName] = useState(had ? had.name : t.name)
  const [title, setTitle] = useState(had?.title || '')
  const [what, setWhat] = useState(had?.description || '')
  const [style, setStyle] = useState('')
  const [core, setCore] = useState(mine)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const refused = t.tier === 'none'
  const legal = IDENT.test(name)
  const reserved = !core && v.core.includes(name)
  const replacing = taken.has(name)
  const blocked = !!v.pending && v.pending.name !== name
  const can = !refused && legal && !reserved && !blocked && what.trim().length > 0 && !busy

  const draw = async () => {
    setBusy(true)
    setErr('')
    try {
      await post('/api/ui/generate', {
        name,
        type: t.name,
        title,
        description: what.trim(),
        width: t.w,
        height: t.h,
        style: style || undefined,
        core,
      })
      onDrawn(name)
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kit-make">
      <div className="kit-make-say">
        <p className="label tick">{t.tier === 'ground' ? 'a ground that stretches' : t.tier === 'sheet' ? 'a sheet of faces' : t.tier === 'painted' ? 'a painting' : 'not a piece'}</p>
        <h1 className="d3">{t.label}</h1>
        <p className="kit-what">{t.what}</p>
        <p className="kit-whyline">{t.why}</p>
        {t.caution ? <p className="kit-care">{t.caution}</p> : null}

        <div className="kit-canvasbig">
          <CanvasPic t={t} big />
          <div className="kit-canvasfacts">
            <span className="mono">
              {refused ? '—' : `${t.w}×${t.h}`}
            </span>
            <span>
              {refused
                ? 'this one comes from somewhere else'
                : t.tier === 'sheet'
                  ? t.facesFree || t.faces.length < 2
                    ? 'a grid of faces on one canvas, cut after it is drawn'
                    : `${t.faces.length} faces on one canvas, cut after it is drawn`
                  : t.stretch === 'none'
                    ? 'drawn once at this size and never stretched'
                    : t.stretch === 'both'
                      ? 'stretches on both axes, so the corners stay and the middle repeats'
                      : `stretches ${t.stretch === 'x' ? 'sideways' : 'vertically'} only`}
            </span>
            {t.regions.length ? (
              <span className="kit-willmark">
                marks it normally carries: {t.regions.map((r) => displayName(r.name).text.toLowerCase()).join(', ')}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="kit-form">
        {refused ? (
          <p className="kit-refused">
            This one is named so that nobody spends on it. {t.caution}
            <button className="kit-quiet" onClick={onBack}>
              go back to the library
            </button>
          </p>
        ) : (
          <>
            <label className="kit-field">
              <span className="label">what it is called</span>
              <input
                className="kit-in mono"
                value={name}
                spellCheck={false}
                maxLength={48}
                onChange={(e) => setName(e.target.value)}
              />
              <span className="kit-hint">
                {!legal
                  ? 'lower case, digits and underscores, starting with a letter, because a grape holds this name'
                  : reserved
                    ? `"${name}" is core chrome and belongs to the whole game · pick a name of your own and it is added beside it`
                    : replacing
                      ? 'a piece already has this name, and drawing it again replaces the picture while keeping every mark on it'
                      : displayName(name).text}
              </span>
            </label>

            <label className="kit-field">
              <span className="label">what a person calls it</span>
              <input
                className="kit-in"
                value={title}
                placeholder={displayName(name).text}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>

            <label className="kit-field">
              <span className="label">what it looks like</span>
              <textarea
                className="kit-in kit-area"
                value={what}
                rows={5}
                maxLength={1000}
                placeholder={
                  t.tier === 'sheet'
                    ? 'the family of marks, and the plate they are drawn on'
                    : t.tier === 'painted'
                      ? 'the place, and what is in the picture'
                      : 'the material, the trim, and what the middle is made of'
                }
                onChange={(e) => setWhat(e.target.value)}
              />
              <span className="kit-hint">
                the whole of what gets drawn, in your words. Say the material and the edge, not the contents.
              </span>
            </label>

            {maps.length ? (
              <label className="kit-field">
                <span className="label">match a painting</span>
                <select className="kit-in" value={style} onChange={(e) => setStyle(e.target.value)}>
                  <option value="">nothing to match</option>
                  {maps.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {displayName({ name: m.slug, title: m.title }).text}
                    </option>
                  ))}
                </select>
                <span className="kit-hint">
                  a map you have already painted hands over its palette, its outline and its shading, and cannot hand
                  over layout
                </span>
              </label>
            ) : null}

            {mine ? (
              <div className="kit-field">
                <span className="label">whose piece</span>
                <div className="kit-seg">
                  <button className={core ? 'on' : ''} onClick={() => setCore(true)}>
                    core chrome
                  </button>
                  <button className={core ? '' : 'on'} onClick={() => setCore(false)}>
                    an addition
                  </button>
                </div>
                <span className="kit-hint">
                  core chrome is the whole game&rsquo;s and is never overridable; an addition sits beside it
                </span>
              </div>
            ) : null}

            {blocked ? (
              <p className="kit-live">
                <span className="kit-pulse" aria-hidden />
                {displayName(v.pending?.name || '').text} is still being drawn. They get judged one at a time.
              </p>
            ) : null}
            {err ? <p className="kit-err">{err}</p> : null}

            <div className="kit-acts">
              <button className="plate" disabled={!can} onClick={() => void draw()}>
                {busy ? 'drawing…' : replacing ? 'draw it again' : 'draw it'}
              </button>
              <span className="kit-comeback">
                what comes back: one {t.w}&times;{t.h} picture
                {t.tier === 'sheet' ? ', ready to be cut into faces' : ', ready to be marked'}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ---- marking a piece ------------------------------------------------------
 *
 * THE FOUR-EDGE DRAG, which is the whole reason this page is worth building.
 * The smallest useful change on the game side is six lines of CSS carrying four
 * numbers, and those numbers have twice been got by measuring a png in an image
 * editor and typing a percentage into a stylesheet. Here they are dragged over
 * the picture, the nine regions shade as they move, and the piece is stretched
 * to three sizes beside it so the slice can be SEEN working rather than
 * trusted.
 *
 * A PIECE THAT IS NOT DRAWN YET STILL TAKES ITS MARKS. The frame is the right
 * size whether or not a picture has arrived, so the marking can happen before
 * the art does and a redraw keeps every rectangle.
 */
function Marking({
  piece,
  type,
  v,
  stamp,
  onSaved,
  onGone,
  onRedraw,
}: {
  piece: Piece
  type?: PType
  v: Vocab
  stamp: number
  onSaved: () => void
  onGone: () => void
  onRedraw: () => void
}) {
  const ground = type ? type.tier === 'ground' : true
  const [mode, setMode] = useState<'edges' | 'marks'>(ground ? 'edges' : 'marks')
  const [slice, setSlice] = useState<Slice>(
    piece.slice || {
      top: Math.round(piece.h / 6),
      right: Math.round(piece.w / 6),
      bottom: Math.round(piece.h / 6),
      left: Math.round(piece.w / 6),
    },
  )
  const [scale, setScale] = useState(piece.scale || 1)
  const [fill, setFill] = useState(piece.fill ?? (type ? type.fill : true))
  const [repeat, setRepeat] = useState<Repeat>(piece.repeat || { x: 'round', y: 'round' })
  const [regions, setRegions] = useState<Region[]>(piece.regions || [])
  const [pick, setPick] = useState(-1)
  const [draft, setDraft] = useState<Rect | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftKind, setDraftKind] = useState('text')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [warn, setWarn] = useState<string[]>([])
  const [saved, setSaved] = useState(false)
  const [css, setCss] = useState(piece.css || '')
  const [doomed, setDoomed] = useState(false)

  const stage = useRef<HTMLDivElement | null>(null)
  const art = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  /* THE HEIGHT COMES OFF THE WINDOW AND NOT OFF THE STAGE, and that is not a
   * preference. The stage is sized to the art, the art is sized by the zoom and
   * the zoom was being read back out of the stage, which is a loop: a 512 by
   * 192 box measured against a stage held open at 64svh drew itself at a third
   * of the room it had, with four hundred pixels of nothing under it. */
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const read = () => setBox({ w: el.clientWidth, h: Math.max(260, window.innerHeight - 250) })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    window.addEventListener('resize', read)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', read)
    }
  }, [])

  /* An integer zoom at or above 1, because a pixel drawn 1.4 pixels wide is a
   * pixel with a seam down one side of it and this is the surface somebody is
   * measuring an edge against. Below 1 there is nothing to be done: a 688 wide
   * painting has to fit the screen. */
  const raw = box.w && box.h ? Math.min((box.w - 28) / piece.w, (box.h - 28) / piece.h) : 1
  const z = raw >= 1 ? Math.floor(raw) : Math.max(0.1, raw)

  const dirty =
    JSON.stringify(regions) !== JSON.stringify(piece.regions || []) ||
    (ground &&
      JSON.stringify({ slice, scale, fill, repeat }) !==
        JSON.stringify({
          slice: piece.slice,
          scale: piece.scale,
          fill: piece.fill,
          repeat: piece.repeat,
        }))

  const at = (e: { clientX: number; clientY: number }) => {
    const r = art.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return { x: Math.round((e.clientX - r.left) / z), y: Math.round((e.clientY - r.top) / z) }
  }

  const drag = (move: (p: { x: number; y: number }) => void) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const on = (ev: PointerEvent) => move(at(ev))
    const off = () => {
      window.removeEventListener('pointermove', on)
      window.removeEventListener('pointerup', off)
    }
    window.addEventListener('pointermove', on)
    window.addEventListener('pointerup', off)
  }

  const edge = (side: keyof Slice) =>
    drag(({ x, y }) =>
      setSlice((s) => {
        if (side === 'top') return { ...s, top: clamp(y, 0, piece.h - s.bottom - 1) }
        if (side === 'bottom') return { ...s, bottom: clamp(piece.h - y, 0, piece.h - s.top - 1) }
        if (side === 'left') return { ...s, left: clamp(x, 0, piece.w - s.right - 1) }
        return { ...s, right: clamp(piece.w - x, 0, piece.w - s.left - 1) }
      }),
    )

  // a rectangle dragged onto the picture. It is not a region until it is named,
  // because a region silently called `region_3` is a promise nobody made.
  const startDraft = (e: React.PointerEvent) => {
    if (mode !== 'marks' || e.target !== e.currentTarget) return
    const a = at(e)
    setPick(-1)
    drag(({ x, y }) =>
      setDraft({
        x: clamp(Math.min(a.x, x), 0, piece.w),
        y: clamp(Math.min(a.y, y), 0, piece.h),
        w: clamp(Math.abs(x - a.x), 0, piece.w),
        h: clamp(Math.abs(y - a.y), 0, piece.h),
      }),
    )(e)
  }

  const moveRegion = (i: number, corner: boolean) =>
    drag(({ x, y }) =>
      setRegions((rs) =>
        rs.map((r, j) => {
          if (j !== i) return r
          if (corner)
            return { ...r, w: clamp(x - r.x, 1, piece.w - r.x), h: clamp(y - r.y, 1, piece.h - r.y) }
          return { ...r, x: clamp(x - Math.round(r.w / 2), 0, piece.w - r.w), y: clamp(y - Math.round(r.h / 2), 0, piece.h - r.h) }
        }),
      ),
    )

  /* THE DEDUPE AND THE STAGGER BOTH READ THE LIST INSIDE THE UPDATER, because
   * reading it from the closure is stale the moment two of these land in one
   * tick, and the second one then lands exactly on top of the first with the
   * same name. A duplicate name is refused at save with "a name is the only
   * address there is", which is the right refusal in the wrong place. */
  const addNamed = (name: string, kind: string) => {
    const w = Math.max(8, Math.round(piece.w / 3))
    const h = Math.max(8, Math.round(piece.h / 4))
    setRegions((rs) => {
      if (rs.some((r) => r.name === name)) return rs
      const step = (rs.length % 4) * 10
      return [
        ...rs,
        {
          name,
          kind,
          x: clamp(Math.round(piece.w / 2 - w / 2) + step, 0, piece.w - w),
          y: clamp(Math.round(piece.h / 2 - h / 2) + step, 0, piece.h - h),
          w,
          h,
          ...(kind === 'picture' ? { valign: 'bottom', fit: 'contain' } : {}),
          ...(kind === 'fill' ? { axis: 'right', mode: 'tile' } : {}),
        },
      ]
    })
    setPick(regions.length)
  }

  const commitDraft = () => {
    if (!draft || !IDENT.test(draftName) || regions.some((r) => r.name === draftName)) return
    const r: Region = {
      ...draft,
      name: draftName,
      kind: draftKind,
      ...(draftKind === 'picture' ? { valign: 'bottom', fit: 'contain' } : {}),
      ...(draftKind === 'fill' ? { axis: 'right', mode: 'tile' } : {}),
    }
    setRegions((rs) => [...rs, r])
    setPick(regions.length)
    setDraft(null)
    setDraftName('')
  }

  const save = async () => {
    setBusy(true)
    setErr('')
    setWarn([])
    try {
      const j = (await post('/api/ui/regions', {
        name: piece.name,
        regions,
        slices: ground ? { slice, scale, fill, repeat } : {},
      })) as { warnings?: string[]; css?: string }
      setWarn(j.warnings || [])
      setCss(j.css || '')
      setSaved(true)
      onSaved()
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  const publish = async () => {
    setBusy(true)
    setErr('')
    try {
      const j = (await post('/api/ui/publish', { name: piece.name })) as { warnings?: string[]; css?: string }
      setWarn(j.warnings || [])
      setCss(j.css || '')
      onSaved()
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  const scrap = async () => {
    setBusy(true)
    try {
      await post('/api/ui/remove', { name: piece.name })
      onGone()
    } catch (e) {
      setErr(String((e as Error).message || e))
      setBusy(false)
    }
  }

  const said = displayName({ name: piece.name, label: piece.title })
  const cols = [0, slice.left, piece.w - slice.right, piece.w]
  const rows = [0, slice.top, piece.h - slice.bottom, piece.h]
  const wants = (type?.regions || []).filter((r) => !regions.some((x) => x.name === r.name))
  const cuts = (type?.faces || []).filter((f) => !regions.some((x) => x.name === f))

  return (
    <div className="kit-mark">
      <div className="kit-mark-head">
        <div>
          <h1 className={'d3' + (said.derived ? ' guessed' : '')}>{said.text}</h1>
          <p className="kit-mark-meta mono">
            {piece.name} · {piece.w}&times;{piece.h}
            {type ? ' · ' + type.label.toLowerCase() : ''}
            {piece.core ? ' · core chrome' : ''}
          </p>
        </div>
        <div className="kit-mark-acts">
          {ground ? (
            <div className="kit-seg">
              <button className={mode === 'edges' ? 'on' : ''} onClick={() => setMode('edges')}>
                the edges
              </button>
              <button className={mode === 'marks' ? 'on' : ''} onClick={() => setMode('marks')}>
                the marks
              </button>
            </div>
          ) : null}
          <button className="kit-quiet" onClick={onRedraw}>
            draw it again
          </button>
        </div>
      </div>

      <div className="kit-mark-body">
        <div className="kit-stagecol">
        <div className="kit-stage" ref={stage}>
          <div
            className="kit-artwrap"
            ref={art}
            data-mode={mode}
            style={{ width: piece.w * z, height: piece.h * z }}
            onPointerDown={startDraft}
          >
            {piece.src ? (
              <img className="kit-artimg" src={`${piece.src}?v=${stamp}`} alt="" draggable={false} />
            ) : (
              <span className="kit-artvoid">
                {piece.status === 'failed' ? 'nothing came back, and the marks are kept' : 'no picture yet, and the marks can be made anyway'}
              </span>
            )}

            {mode === 'edges' ? (
              <>
                {rows.slice(0, 3).map((y0, r) =>
                  cols.slice(0, 3).map((x0, c) => (
                    <span
                      key={`${r}-${c}`}
                      className="kit-nine"
                      data-part={r === 1 && c === 1 ? 'mid' : r === 1 || c === 1 ? 'edge' : 'corner'}
                      style={{
                        left: x0 * z,
                        top: y0 * z,
                        width: Math.max(0, (cols[c + 1] - x0) * z),
                        height: Math.max(0, (rows[r + 1] - y0) * z),
                      }}
                    />
                  )),
                )}
                <span className="kit-guide h" style={{ top: slice.top * z }} />
                <span className="kit-guide h" style={{ top: (piece.h - slice.bottom) * z }} />
                <span className="kit-guide v" style={{ left: slice.left * z }} />
                <span className="kit-guide v" style={{ left: (piece.w - slice.right) * z }} />
                <span className="kit-grip h" style={{ top: slice.top * z }} onPointerDown={edge('top')}>
                  <i className="mono">{slice.top}</i>
                </span>
                <span className="kit-grip h" style={{ top: (piece.h - slice.bottom) * z }} onPointerDown={edge('bottom')}>
                  <i className="mono">{slice.bottom}</i>
                </span>
                <span className="kit-grip v" style={{ left: slice.left * z }} onPointerDown={edge('left')}>
                  <i className="mono">{slice.left}</i>
                </span>
                <span className="kit-grip v" style={{ left: (piece.w - slice.right) * z }} onPointerDown={edge('right')}>
                  <i className="mono">{slice.right}</i>
                </span>
              </>
            ) : (
              <>
                {regions.map((r, i) => (
                  <span
                    key={r.name}
                    className={'kit-rect' + (pick === i ? ' on' : '')}
                    data-kind={r.kind}
                    style={{ left: r.x * z, top: r.y * z, width: r.w * z, height: r.h * z }}
                    onPointerDown={(e) => {
                      setPick(i)
                      moveRegion(i, false)(e)
                    }}
                  >
                    <i className="kit-rect-name mono">{r.name}</i>
                    <i className="kit-rect-grip" onPointerDown={moveRegion(i, true)} />
                  </span>
                ))}
                {draft ? (
                  <span className="kit-rect draft" style={{ left: draft.x * z, top: draft.y * z, width: draft.w * z, height: draft.h * z }} />
                ) : null}
              </>
            )}
          </div>

          {draft ? (
            <div className="kit-naming">
              <span className="label">name this mark</span>
              <input
                className="kit-in mono"
                autoFocus
                value={draftName}
                spellCheck={false}
                maxLength={48}
                placeholder="body"
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitDraft()
                  if (e.key === 'Escape') setDraft(null)
                }}
              />
              <div className="kit-chips">
                {v.kinds.map((k) => (
                  <button key={k} className={draftKind === k ? 'on' : ''} onClick={() => setDraftKind(k)}>
                    {k}
                  </button>
                ))}
              </div>
              <div className="kit-naming-acts">
                <button className="kit-quiet" onClick={() => setDraft(null)}>
                  drop it
                </button>
                <button className="kit-do" disabled={!IDENT.test(draftName)} onClick={commitDraft}>
                  name it
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* THE SLICE HAS TO BE SEEN WORKING, and it has to be seen from where
            the hand is. Under the art rather than across the page: drag an edge
            and the same edge is redrawn at three aspect ratios a glance below,
            which is what replaces measuring in an image editor and trusting
            four numbers. */}
        {ground ? (
          <div className="kit-prevwrap">
            <span className="label">stretched to three sizes, live</span>
            <Preview src={piece.src ? `${piece.src}?v=${stamp}` : ''} slice={slice} scale={scale} fill={fill} repeat={repeat} />
          </div>
        ) : null}
        </div>

        <aside className="kit-rail">
          {ground ? (
            <section>
              <h2 className="label tick">how it stretches</h2>
              <p className="kit-why">
                the corners never move, the edges repeat along themselves, and the middle is the paper. Drag the four
                lines until each corner holds the whole drawn corner and nothing more.
              </p>
              <div className="kit-nums">
                {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
                  <label key={k}>
                    <span className="label">{k}</span>
                    <input
                      className="kit-in mono"
                      type="number"
                      value={slice[k]}
                      onChange={(e) =>
                        setSlice((s) => ({
                          ...s,
                          [k]:
                            k === 'top' || k === 'bottom'
                              ? clamp(Number(e.target.value) || 0, 0, piece.h - s[k === 'top' ? 'bottom' : 'top'] - 1)
                              : clamp(Number(e.target.value) || 0, 0, piece.w - s[k === 'left' ? 'right' : 'left'] - 1),
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="kit-line">
                <span className="label">one source pixel is</span>
                <div className="kit-step">
                  <button onClick={() => setScale((n) => Math.max(1, n - 1))} aria-label="thinner">
                    &minus;
                  </button>
                  <b className="mono">{scale}</b>
                  <button onClick={() => setScale((n) => Math.min(8, n + 1))} aria-label="thicker">
                    +
                  </button>
                </div>
                <span className="kit-hint">css pixels wide</span>
              </div>
              <div className="kit-line">
                <span className="label">the edges</span>
                <div className="kit-seg small">
                  {v.repeats.map((r) => (
                    <button key={r} className={repeat.x === r ? 'on' : ''} onClick={() => setRepeat({ x: r, y: r })}>
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <div className="kit-line">
                <span className="label">the middle</span>
                <div className="kit-seg small">
                  <button className={fill ? 'on' : ''} onClick={() => setFill(true)}>
                    paper
                  </button>
                  <button className={fill ? '' : 'on'} onClick={() => setFill(false)}>
                    a hole
                  </button>
                </div>
              </div>
            </section>
          ) : (
            <section>
              <h2 className="label tick">how it stretches</h2>
              <p className="kit-why">
                it does not. {type ? type.caution : 'nothing here takes four edge numbers.'}
              </p>
            </section>
          )}

          <section>
            <h2 className="label tick">{type?.tier === 'sheet' ? 'the faces' : 'the marks'}</h2>
            <p className="kit-why">
              a named rectangle the engine puts something into, and the name is the address a member&rsquo;s python
              holds. Drag one onto the picture, or take one it normally carries.
            </p>
            {wants.length || cuts.length ? (
              <div className="kit-chips add">
                {wants.map((r) => (
                  <button key={r.name} onClick={() => addNamed(r.name, r.kind)}>
                    + {displayName(r.name).text.toLowerCase()}
                    {/* a mark this type does not read right without */}
                    {r.required ? <i /> : null}
                  </button>
                ))}
                {cuts.map((f) => (
                  <button key={f} onClick={() => addNamed(f, 'face')}>
                    + {displayName(f).text.toLowerCase()}
                  </button>
                ))}
              </div>
            ) : null}
            {regions.length === 0 ? (
              <p className="kit-hint">nothing marked yet</p>
            ) : (
              <ul className="kit-regions">
                {regions.map((r, i) => (
                  <RegionRow
                    key={r.name}
                    r={r}
                    v={v}
                    on={pick === i}
                    onPick={() => {
                      setPick(i)
                      setMode('marks')
                    }}
                    onSet={(patch) => setRegions((rs) => rs.map((x, j) => (j === i ? { ...x, ...patch } : x)))}
                    onDrop={() => {
                      setRegions((rs) => rs.filter((_, j) => j !== i))
                      setPick(-1)
                    }}
                  />
                ))}
              </ul>
            )}
          </section>

          {err ? <p className="kit-err">{err}</p> : null}
          {warn.map((w) => (
            <p className="kit-warn" key={w}>
              {w}
            </p>
          ))}

          <div className="kit-save">
            <button className="plate" disabled={busy || (!dirty && saved)} onClick={() => void save()}>
              {busy ? 'saving…' : 'save the marks'}
            </button>
            <button className="kit-quiet" disabled={busy || dirty || piece.published} onClick={() => void publish()}>
              {piece.published ? 'measured' : 'call it measured'}
            </button>
          </div>

          {css ? (
            <section>
              <h2 className="label tick">what the game takes</h2>
              <p className="kit-why">six lines, pasted into the game&rsquo;s own tokens, and nothing is guessed</p>
              <pre className="kit-css mono">{css}</pre>
              <button className="kit-quiet" onClick={() => void navigator.clipboard?.writeText(css)}>
                copy it
              </button>
            </section>
          ) : null}

          <div className="kit-scrap">
            {doomed ? (
              <>
                <span className="kit-hint">the picture and every mark on it go</span>
                <button className="kit-quiet" onClick={() => setDoomed(false)}>
                  keep it
                </button>
                <button className="kit-stop" onClick={() => void scrap()}>
                  remove it
                </button>
              </>
            ) : (
              <button className="kit-quiet" onClick={() => setDoomed(true)}>
                remove this piece
              </button>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

/* THE SLICE, WORKING. Three boxes at three aspect ratios, because the failure
 * this whole record exists to end is a painting squashed into a box, and one
 * preview at one size cannot show a corner deforming. Drawn with the same
 * border-image rule the game will run, so what is on screen here is what the
 * game does rather than a drawing of it. */
function Preview({
  src,
  slice,
  scale,
  fill,
  repeat,
}: {
  src: string
  slice: Slice
  scale: number
  fill: boolean
  repeat: Repeat
}) {
  const sizes: Array<[number, number, string]> = [
    [252, 68, 'a plaque'],
    [252, 150, 'a dialogue box'],
    [148, 190, 'a tall panel'],
  ]
  const style = src
    ? {
        borderStyle: 'solid' as const,
        borderWidth: `${slice.top * scale}px ${slice.right * scale}px ${slice.bottom * scale}px ${slice.left * scale}px`,
        borderImage: `url("${src}") ${slice.top} ${slice.right} ${slice.bottom} ${slice.left}${fill ? ' fill' : ''} / 1 / 0 ${repeat.x} ${repeat.y}`,
      }
    : undefined
  return (
    <div className="kit-prev">
      {sizes.map(([w, h, say]) => (
        <div key={say} className="kit-prev-one">
          <div className="kit-prev-box" style={{ width: w, height: h, ...style }} />
          <span className="mono">{say}</span>
        </div>
      ))}
    </div>
  )
}

/* One marked rectangle. The extra fields are per kind and appear only on the
 * kind that has them, because a fill's direction on a text well is a control
 * that reports a state it does not deliver.
 *
 * THE VERTICAL ON A PICTURE HAS NO DEFAULT. The shipped portrait is
 * bottom-anchored because a person stands on the bottom of their box, and a
 * frame that centres its content puts every character in the game floating. The
 * server refuses the absence rather than inventing one, so this asks. */
function RegionRow({
  r,
  v,
  on,
  onPick,
  onSet,
  onDrop,
}: {
  r: Region
  v: Vocab
  on: boolean
  onPick: () => void
  onSet: (patch: Partial<Region>) => void
  onDrop: () => void
}) {
  const said = displayName(r.name)
  return (
    <li className={'kit-region' + (on ? ' on' : '')} data-kind={r.kind}>
      <button className="kit-region-top" onClick={onPick}>
        <span className="kit-region-name">{said.text}</span>
        <span className="kit-region-id mono">{r.name}</span>
      </button>
      <div className="kit-region-body">
        <select className="kit-in tiny" value={r.kind} onChange={(e) => onSet({ kind: e.target.value })}>
          {v.kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        {r.kind === 'picture' ? (
          <>
            <select className="kit-in tiny" value={r.valign || ''} onChange={(e) => onSet({ valign: e.target.value })}>
              <option value="">stands where?</option>
              {v.valigns.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <select className="kit-in tiny" value={r.fit || 'contain'} onChange={(e) => onSet({ fit: e.target.value })}>
              {v.fits.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {r.kind === 'fill' ? (
          <>
            <select className="kit-in tiny" value={r.axis || 'right'} onChange={(e) => onSet({ axis: e.target.value })}>
              {v.fillAxes.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <select className="kit-in tiny" value={r.mode || 'tile'} onChange={(e) => onSet({ mode: e.target.value })}>
              {v.fillModes.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {r.kind === 'text' ? (
          <>
            <select className="kit-in tiny" value={r.wrap || 'wrap'} onChange={(e) => onSet({ wrap: e.target.value })}>
              {v.wraps.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <select className="kit-in tiny" value={r.overflow || 'ellipsis'} onChange={(e) => onSet({ overflow: e.target.value })}>
              {v.overflows.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <span className="kit-region-rect mono">
          {r.x},{r.y} {r.w}&times;{r.h}
        </span>
        <button className="kit-region-x" onClick={onDrop} aria-label={`drop ${r.name}`}>
          &times;
        </button>
      </div>
    </li>
  )
}
