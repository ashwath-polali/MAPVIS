/* draws the chrome and marks it: a png with no edges or named rectangles is half a piece. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from './session'
import { go } from './router'
import { displayName } from '../core/naming'
import Covers from './Covers'
import './ui.css'

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
  /* align had no control though the api published it: a plaque's label is centred, a field's text is left. */
  aligns: string[]
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

/* the shape a piece name has to read as, and the same one an anchor name does.
 * Deliberately a python identifier, so renaming a piece for a person cannot
 * silently break the member's island that holds the name. */
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

/* WHAT YOU ARE MAKING, asked before anything else. This page used to open straight into the
   twenty-one game pieces, so the only thing it could make was the one thing it showed. A group is a
   kind of thing with its own editor and its own rules, and the list is a list on purpose: a third
   one is a row here rather than a redesign. */
type GroupId = 'pieces' | 'covers'

const GROUPS: { id: GroupId; name: string; about: string }[] = [
  {
    id: 'pieces',
    name: 'game pieces',
    about: 'the panels, boxes, buttons and marks the whole game is dressed in, drawn once for every screen',
  },
  {
    id: 'covers',
    name: 'transition screens',
    about: 'the screen a student looks at on the way into a map, one per map and any number of named extras',
  },
]

type Step = 'pieces' | 'draw' | 'mark'

const STEPS: { id: Step; n: number; name: string }[] = [
  { id: 'pieces', n: 1, name: 'pieces' },
  { id: 'draw', n: 2, name: 'draw' },
  { id: 'mark', n: 3, name: 'mark' },
]

/* the tier decides whether four edge numbers mean anything, which is why there is a third step. */
const TIERS: Array<[PType['tier'], string]> = [
  ['ground', 'grounds · they stretch'],
  ['sheet', 'sheets · one canvas of faces'],
  ['painted', 'paintings · never stretched'],
  ['none', 'not drawn here'],
]

/* THE ONE FACT THAT DECIDES WHETHER FOUR EDGE NUMBERS MEAN ANYTHING on this
 * piece: a ground stretches, a sheet is cut into faces, a painting is neither.
 * A footer readout, so it is short and it is not a sentence. */
function stretchLaw(t: PType | undefined): string {
  if (!t) return 'unfiled'
  if (t.tier === 'sheet') return t.facesFree || t.faces.length < 2 ? 'sheet · cut into faces' : `sheet · ${t.faces.length} faces`
  if (t.tier === 'none') return 'not drawn here'
  if (t.tier === 'painted') return 'painting · never stretched'
  if (t.stretch === 'none') return 'ground · fixed'
  return `ground · stretches ${t.stretch === 'both' ? 'both ways' : t.stretch === 'x' ? 'sideways' : 'vertically'}`
}

/* ---- the page ------------------------------------------------------------ */

export default function Ui() {
  const { user, loading } = useSession()
  const [v, setV] = useState<Vocab | null>(null)
  const [maps, setMaps] = useState<MapRow[]>([])
  const [mine, setMine] = useState(false)
  /* THE PICTURE IS SERVED IMMUTABLE FOR A YEAR, which is right for a classroom
   * of thirty machines and wrong for the page that just redrew it. One stamp
   * per load busts the cache here and nowhere else. */
  const [stamp, setStamp] = useState(() => Date.now())
  const [step, setStep] = useState<Step>('pieces')
  /* empty is the chooser, which is where the page now opens */
  const [group, setGroup] = useState<GroupId | ''>('')
  // which of the twenty-one is armed for drawing, and which drawn piece is open
  const [armed, setArmed] = useState('')
  const [open, setOpen] = useState('')
  /* THE POINTER'S POSITION IN THE PIECE'S OWN PIXELS, which is what the editor
   * puts in the left of its footer and is the one number worth having while a
   * rectangle is being dragged. It lives up here because the footer does. */
  const [readout, setReadout] = useState('')
  /* how many marks are on the piece RIGHT NOW, which is not the same number as
   * the one on the saved record and is the one worth reporting while somebody is
   * dragging rectangles. The footer lives up here, so the count has to. */
  const [marks, setMarks] = useState(0)
  /* whether claude wrote the prompt is carried up, since with no claude the author's sentence goes bare. */
  const [bare, setBare] = useState('')

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

  /* Polling that stops when nothing is drawing. A row sits in `pending` for the
   * minute and a half a generation takes and for no longer. */
  useEffect(() => {
    if (!v?.pending) return
    const t = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(t)
  }, [v?.pending, load])

  const types = useMemo(() => (v?.types || []).slice().sort((a, b) => a.order - b.order), [v])
  const byType = useMemo(() => new Map(types.map((t) => [t.name, t])), [types])

  const piece = (v?.ui || []).find((p) => p.name === open)
  const type = armed ? byType.get(armed) : undefined

  const goTo = (s: Step) => {
    if (s === 'mark' && !piece) return
    setStep(s)
  }

  // opening a drawn piece is the same act as going to step three, so it is one
  // call and the two can never disagree about which piece is on the stage
  const openPiece = (name: string) => {
    setOpen(name)
    setStep('mark')
  }

  const armType = (name: string) => {
    setArmed(name)
    setStep('draw')
  }

  /* the label and not the name: this printed dialogue_box for a piece titled Dialogue Box. */
  const subject = piece && step === 'mark'
    ? `${displayName({ name: piece.name, label: piece.title }).text} · ${piece.w}×${piece.h}`
    : type && step === 'draw'
      ? // 0×0 is what the record holds for a type nobody ever generates, and
        // printing it reads as a bug rather than as the rule it is
        `${type.name} · ${type.tier === 'none' ? 'no canvas' : `${type.w}×${type.h}`}`
      : v
        ? `${v.ui.length} drawn · ${types.length} types`
        : ''

  /* uikit rides beside app as a fence: every rule under it in ui.css is a metric and never a colour. */
  /* THE CHOOSER. Nothing else is on screen until a group is picked, because the page's whole problem
     was that it looked like one editor for one thing. */
  if (!group)
    return (
      <div className="app uikit">
        <header>
          <a className="brand" href="/" title="your maps">
            MAPVIS
          </a>
          {/* the question is asked once, in the body where the decision is made */}
          <span className="uk-head" />
          <a className="helpbtn backbtn" href="/" data-tip="back to your maps">
            ←
          </a>
        </header>
        <main>
          <div className="uk-pick">
            {/* the question is asked in the body and not only in the header strip, because the header
                is where this page puts a status and a body is where it puts a decision */}
            <h1 className="uk-ask">What are you making?</h1>
            <div className="uk-cards">
            {GROUPS.map((g) => (
              <button key={g.id} className="uk-card" onClick={() => setGroup(g.id)}>
                <b>{g.name}</b>
                <span>{g.about}</span>
              </button>
            ))}
            </div>
            {/* said rather than left to be discovered: a chooser with two things on it invites the
                question, and the honest answer is that the third is not built */}
            <p className="uk-soon">More groups, and groups you name yourself, are not built yet.</p>
          </div>
        </main>
      </div>
    )

  if (group === 'covers')
    return (
      <div className="app uikit">
        <header>
          <a className="brand" href="/" title="your maps">
            MAPVIS
          </a>
          <button className="uk-back" onClick={() => setGroup('')}>
            ← what are you making
          </button>
          <span className="uk-head">transition screens</span>
          <a className="helpbtn backbtn" href="/" data-tip="back to your maps">
            ←
          </a>
        </header>
        <main>
          {/* a div, for the same reason the chooser is one: main is flex on this page */}
          <div className="uk-hold">
            <Covers maps={maps} />
          </div>
        </main>
      </div>
    )

  return (
    <div className="app uikit">
      <header>
        {/* the same wordmark, the same size and face as the editor's and the
            home page's. One product should not have three logos. */}
        <a className="brand" href="/" title="your maps">
          MAPVIS
        </a>
        <button className="uk-back" onClick={() => setGroup('')}>
          ← what are you making
        </button>
        <nav className="stepper">
          {STEPS.map((s) => (
            <button
              key={s.id}
              className={'step' + (step === s.id ? ' on' : '')}
              disabled={s.id === 'mark' && !piece}
              /* title and not data-tip: a step's underline and the tooltip are both ::after. */
              title={
                s.id === 'pieces'
                  ? 'the panels, boxes, buttons and marks this account has drawn'
                  : s.id === 'draw'
                    ? 'pick one of the twenty-one and say what it looks like'
                    : 'drag its edges and name the rectangles the engine fills'
              }
              onClick={() => goTo(s.id)}
            >
              <span className="step-n">{s.n}</span>
              {s.name}
            </button>
          ))}
        </nav>
        <a className="helpbtn backbtn" href="/" data-tip="back to your maps">
          ←
        </a>
        <span className="meta">
          {v?.pending ? <span className="busy">drawing {displayName(v.pending.name).text}</span> : null}
          {subject}
        </span>
      </header>

      <main>
        {!v ? (
          <>
            <aside className="panel">
              <div className="panel-empty">
                <p>reading what this account has drawn</p>
              </div>
            </aside>
            <div className="stage" />
          </>
        ) : step === 'mark' && piece ? (
          <Marking
            key={piece.name}
            piece={piece}
            type={piece.type ? byType.get(piece.type) : undefined}
            v={v}
            stamp={stamp}
            bare={bare}
            onSaved={() => void load()}
            onGone={() => {
              setOpen('')
              setStep('pieces')
              void load()
            }}
            onRedraw={() => armType(piece.type || '')}
            onReadout={setReadout}
            onMarks={setMarks}
          />
        ) : step === 'draw' ? (
          <Drawing
            key={armed}
            t={type}
            types={types}
            v={v}
            maps={maps}
            mine={mine}
            stamp={stamp}
            onArm={armType}
            onDrawn={(name, why) => {
              setBare(why)
              void load()
              openPiece(name)
            }}
          />
        ) : (
          <Pieces v={v} types={types} stamp={stamp} onOpen={openPiece} onMake={() => setStep('draw')} />
        )}
      </main>

      {/* The same split the editor's footer makes: the pointer on the left, what
          the tool has measured on the right. The header says which piece is
          open, so saying it again down here would be one string twice. */}
      <footer>
        <span className="read mono">{readout}</span>
        <span className="grow" />
        {piece && step === 'mark' ? (
          <>
            <span className="read mono dim">{stretchLaw(byType.get(piece.type))}</span>
            {piece.slice ? (
              <span className="read mono dim">
                edges {piece.slice.top}·{piece.slice.right}·{piece.slice.bottom}·{piece.slice.left}
              </span>
            ) : null}
            <span className="read mono">
              {marks} mark{marks === 1 ? '' : 's'}
            </span>
            <span className="read mono dim">{piece.published ? 'measured' : 'not measured yet'}</span>
          </>
        ) : type && step === 'draw' ? (
          <span className="read mono dim">{stretchLaw(type)}</span>
        ) : v ? (
          <>
            <span className="read mono dim">
              {types.filter((x) => x.tier === 'ground').length} grounds ·{' '}
              {types.filter((x) => x.tier === 'sheet').length} sheets ·{' '}
              {types.filter((x) => x.tier === 'painted').length} paintings
            </span>
            <span className="read mono">
              {v.ui.filter((p) => p.published).length} of {v.ui.length} measured
            </span>
          </>
        ) : null}
      </footer>
    </div>
  )
}

/* ---- step one: what this account has drawn, on a checker so transparency reads as transparency ---- */
function Pieces({
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
  onMake: () => void
}) {
  const at = new Map(types.map((t) => [t.name, t]))
  return (
    <>
      <aside className="panel" key="pieces">
        <div className="panel-cap">the panels, boxes, buttons and marks the game is drawn out of</div>
        {v.ui.length === 0 ? (
          <div className="panel-empty">
            <p>nothing drawn yet, and twenty-one kinds of piece are waiting</p>
          </div>
        ) : (
          <>
            <div className="asec">on this shelf</div>
            {v.ui.map((p) => {
              const said = displayName({ name: p.name, label: p.title })
              const t = at.get(p.type)
              return (
                <button
                  key={p.name}
                  className="row"
                  data-tip={p.description || undefined}
                  onClick={() => onOpen(p.name)}
                >
                  {/* the real picture when there is one, the diagram only for a piece still in flight */}
                  <span className="row-ic">
                    {p.src ? (
                      <img src={`${p.src}?v=${stamp}`} alt="" draggable={false} />
                    ) : t ? (
                      <Dia t={t} />
                    ) : null}
                  </span>
                  <span className="row-tx">
                    <span className={'row-label' + (said.derived ? ' guessed' : '')}>{said.text}</span>
                    <span className="row-desc mono">
                      {p.w}×{p.h}
                      {t ? ' · ' + displayName({ name: t.name, label: t.label }).text.toLowerCase() : ''}
                    </span>
                    {/* the same sentence the card carries, because the rail is
                        what somebody scans when they are looking for the piece
                        that still needs work */}
                    <Made p={p} />
                  </span>
                </button>
              )
            })}
          </>
        )}
        <button className="primary big" onClick={onMake}>
          draw a new piece
        </button>
      </aside>

      <div className="stage">
        {v.ui.length === 0 ? (
          <p className="empty">
            {/* wrapped, because bare text in a grid becomes an anonymous item
                that fills its track and then reads left-aligned inside it */}
            <span>nothing drawn yet · draw a piece to put something here</span>
          </p>
        ) : (
          /* one card class with a size modifier, since two grids drifted into two card designs before. */
          <div className="ui-gal">
            <div className="ui-gal-set wide">
              {v.ui.map((p) => {
                const said = displayName({ name: p.name, label: p.title })
                return (
                  <button key={p.name} className="ui-card" onClick={() => onOpen(p.name)}>
                    <span className="ui-card-art ui-check">
                      {p.src ? (
                        <img src={`${p.src}?v=${stamp}`} alt="" draggable={false} />
                      ) : (
                        <span className="ui-void">
                          {p.status === 'failed' ? 'nothing came back' : 'still drawing'}
                        </span>
                      )}
                    </span>
                    <span className="ui-card-say">
                      <span className={'ui-card-name' + (said.derived ? ' guessed' : '')}>{said.text}</span>
                      {/* who owns it, which is a fact about the piece and not a
                          selection, so it is a word and never the gold border */}
                      <span className="ui-card-meta mono">
                        {p.core ? 'core · ' : ''}
                        {p.w}×{p.h}
                      </span>
                    </span>
                    {/* half a piece looks exactly like a whole one: the missing marks are not visible */}
                    <Made p={p} />
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/* three states and not two, because 'not measured' hides untouched from halfway through. */
function Made({ p }: { p: Piece }) {
  if (p.status === 'pending') return <span className="ui-made">drawing</span>
  if (p.status === 'failed') return <span className="ui-made bad">nothing came back</span>
  const n = p.regions?.length || 0
  const edged = !!p.slice && !!(p.slice.top || p.slice.right || p.slice.bottom || p.slice.left)
  if (p.published)
    return (
      <span className="ui-made done">
        <i />
        measured · {n} mark{n === 1 ? '' : 's'}
      </span>
    )
  if (n || edged)
    return (
      <span className="ui-made part">
        <i />
        {n ? `${n} mark${n === 1 ? '' : 's'}` : 'edges set'}, not called measured
      </span>
    )
  return (
    <span className="ui-made">
      <i />
      no marks yet, so the game cannot use it
    </span>
  )
}

/* ---- what a type is, drawn as a diagram and never a preview: the viewBox is the real canvas ---- */

/* THE TWO THAT ARE NEVER GENERATED still have to say what they are. Neither has
 * a canvas, so neither gets a real one: a shape to be drawn in, and the card's
 * own meta line says out loud that nothing is drawn here. */
const NOMINAL: Record<string, [number, number]> = {
  sign: [384, 288],
  row: [480, 200],
}

/* one divisor for every diagram: 688 is the widest canvas, and .ui-card-art in ui.css holds the same 144. */
const DIA_K = 144 / 688

function diaSize(t: PType): [number, number] {
  if (t.w && t.h) return [t.w, t.h]
  return NOMINAL[t.name] || [384, 192]
}

function Dia({ t }: { t: PType }) {
  const [w, h] = diaSize(t)
  const X = (f: number) => Math.round(f * w * 10) / 10
  const Y = (f: number) => Math.round(f * h * 10) / 10
  /* a rectangle in fractions of the canvas. The class says what kind of thing
   * it is: f a drawn frame, g something not there yet, m a mark, t a run of
   * type, p painted paper. ui.css owns what each of those looks like. */
  const R = (x: number, y: number, ww: number, hh: number, k = 'f', r = 0) => (
    <rect className={k} x={X(x)} y={Y(y)} width={X(ww)} height={Y(hh)} rx={r} />
  )
  /* a line of type is always a mark and never a word. At a fifth of size a word
   * is noise, and what the diagram is saying is where the words go. */
  const T = (x: number, y: number, ww: number, hh = 0.05) => R(x, y, ww, hh, 't', 3)
  const wrap = (kids: React.ReactNode) => (
    <svg className="ui-dia" viewBox={`0 0 ${w} ${h}`} aria-hidden>
      {kids}
    </svg>
  )
  // a small silhouette family, told apart by shape rather than by hue, which is
  // the whole definition of an icon set
  const MARKS = (cx: number, cy: number, s: number, i: number) => {
    const px = X(cx)
    const py = Y(cy)
    const r = X(s)
    if (i % 5 === 0) return <circle className="m" cx={px} cy={py} r={r} />
    if (i % 5 === 1) return <rect className="m" x={px - r} y={py - r} width={r * 2} height={r * 2} rx={2} />
    if (i % 5 === 2) return <path className="m" d={`M ${px} ${py - r} L ${px + r} ${py + r} L ${px - r} ${py + r} Z`} />
    if (i % 5 === 3) return <path className="m" d={`M ${px} ${py - r} L ${px + r} ${py} L ${px} ${py + r} L ${px - r} ${py} Z`} />
    return (
      <path
        className="m"
        d={`M ${px - r} ${py - r * 0.35} h ${r * 0.7} v ${-r * 0.65} h ${r * 0.6} v ${r * 0.65} h ${r * 0.7} v ${r * 0.7} h ${-r * 0.7} v ${r * 0.65} h ${-r * 0.6} v ${-r * 0.65} h ${-r * 0.7} Z`}
      />
    )
  }

  switch (t.name) {
    /* a frame, a plate hung on its top edge with the speaker's name in it, a
       portrait well with somebody in it, three lines of speech and the tap that
       says the line has finished */
    case 'dialogue_box':
      return wrap(
        <>
          {R(0.02, 0.17, 0.96, 0.79, 'f', 14)}
          {R(0.05, 0.03, 0.29, 0.2, 'f', 10)}
          {T(0.09, 0.1, 0.19, 0.06)}
          {R(0.06, 0.29, 0.18, 0.56, 'g', 6)}
          <circle className="m" cx={X(0.15)} cy={Y(0.47)} r={X(0.035)} />
          <path className="m" d={`M ${X(0.09)} ${Y(0.85)} a ${X(0.06)} ${Y(0.15)} 0 0 1 ${X(0.12)} 0 Z`} />
          {T(0.29, 0.36, 0.62)}
          {T(0.29, 0.49, 0.58)}
          {T(0.29, 0.62, 0.33)}
          <path className="m" d={`M ${X(0.89)} ${Y(0.76)} h ${X(0.05)} l ${-X(0.025)} ${Y(0.1)} Z`} />
        </>,
      )

    // a frame with a header rule across it, the close in its corner, and body
    case 'panel':
      return wrap(
        <>
          {R(0.04, 0.04, 0.92, 0.92, 'f', 14)}
          {T(0.1, 0.11, 0.4, 0.055)}
          <path className="s" d={`M ${X(0.04)} ${Y(0.23)} H ${X(0.96)}`} />
          <path className="s" d={`M ${X(0.84)} ${Y(0.1)} l ${X(0.07)} ${Y(0.07)} M ${X(0.91)} ${Y(0.1)} l ${-X(0.07)} ${Y(0.07)}`} />
          {T(0.1, 0.33, 0.72)}
          {T(0.1, 0.45, 0.66)}
          {T(0.1, 0.57, 0.72)}
          {T(0.1, 0.69, 0.38)}
        </>,
      )

    /* three sides open at both edges: a closed rectangle was clipped and read as a broken box. */
    case 'band':
      return wrap(
        <>
          <path
            className="f"
            d={`M 0 ${Y(0.99)} V ${Y(0.28)} H ${X(1)} V ${Y(0.99)}`}
          />
          {T(0.31, 0.44, 0.38, 0.14)}
          {T(0.37, 0.68, 0.26, 0.08)}
        </>,
      )

    // three faces down one canvas, and the middle one is what pressed looks like
    case 'plank':
      return wrap(
        <>
          {R(0.06, 0.05, 0.88, 0.25, 'f', 10)}
          {T(0.26, 0.14, 0.48, 0.07)}
          {R(0.06, 0.375, 0.88, 0.25, 'p', 10)}
          {R(0.06, 0.375, 0.88, 0.25, 'f', 10)}
          {T(0.26, 0.48, 0.48, 0.07)}
          {R(0.06, 0.7, 0.88, 0.25, 'g', 10)}
          {T(0.26, 0.8, 0.48, 0.07)}
        </>,
      )

    // fixed ends, and a middle that repeats between them
    case 'plaque':
      return wrap(
        <>
          {R(0.04, 0.24, 0.92, 0.52, 'f', 8)}
          <path className="s" d={`M ${X(0.17)} ${Y(0.24)} V ${Y(0.76)} M ${X(0.83)} ${Y(0.24)} V ${Y(0.76)}`} />
          {T(0.27, 0.44, 0.46, 0.12)}
        </>,
      )

    // one canvas of small controls, each a plate with its own mark on it
    case 'chip':
      return wrap(
        <>
          {[0, 1, 2].map((r) =>
            [0, 1, 2].map((c) => (
              <g key={`${r}-${c}`}>
                {R(0.08 + c * 0.3, 0.08 + r * 0.3, 0.24, 0.24, 'f', 8)}
                {MARKS(0.2 + c * 0.3, 0.2 + r * 0.3, 0.055, r * 3 + c)}
              </g>
            )),
          )}
        </>,
      )

    // the same canvas with no plates, because a family told apart by silhouette
    // is the whole difference between an icon set and a chip sheet
    case 'icon_set':
      return wrap(
        <>
          {[0, 1, 2].map((r) =>
            [0, 1, 2].map((c) => <g key={`${r}-${c}`}>{MARKS(0.2 + c * 0.3, 0.2 + r * 0.3, 0.085, r + c * 3)}</g>),
          )}
        </>,
      )

    // an inset well, a run of typed characters, the caret after them, a unit
    case 'field':
      return wrap(
        <>
          {R(0.05, 0.26, 0.9, 0.48, 'p', 6)}
          {R(0.05, 0.26, 0.9, 0.48, 'f', 6)}
          {T(0.1, 0.44, 0.28, 0.12)}
          <path className="s" d={`M ${X(0.4)} ${Y(0.4)} V ${Y(0.6)}`} />
          {T(0.79, 0.44, 0.11, 0.12)}
        </>,
      )

    /* the land is class d and not m, so the marks on it stay the brightest or the type reads as scenery. */
    case 'cover_plate':
      return wrap(
        <>
          {R(0, 0, 1, 1, 'p', 4)}
          {R(0, 0, 1, 1, 'f', 4)}
          <path
            className="d"
            d={`M 0 ${Y(1)} V ${Y(0.55)} L ${X(0.2)} ${Y(0.3)} L ${X(0.42)} ${Y(0.52)} L ${X(0.62)} ${Y(0.22)} L ${X(1)} ${Y(0.6)} V ${Y(1)} Z`}
          />
          {T(0.08, 0.6, 0.4, 0.1)}
          {R(0.08, 0.77, 0.52, 0.09, 'f', 6)}
          {R(0.095, 0.79, 0.27, 0.05, 'm', 4)}
          {T(0.08, 0.9, 0.66, 0.045)}
        </>,
      )

    // an empty place that says something goes here, with its caption under it
    case 'socket':
      return wrap(
        <>
          {R(0.08, 0.05, 0.84, 0.72, 'f', 12)}
          {R(0.19, 0.15, 0.62, 0.52, 'g', 8)}
          <path
            className="s"
            d={`M ${X(0.5)} ${Y(0.33)} V ${Y(0.49)} M ${X(0.42)} ${Y(0.41)} H ${X(0.58)}`}
          />
          {T(0.24, 0.86, 0.52, 0.06)}
        </>,
      )

    // a track and a fill that have to come apart, and the number they report
    case 'gauge':
      return wrap(
        <>
          {R(0.04, 0.32, 0.76, 0.36, 'f', 12)}
          {R(0.055, 0.38, 0.42, 0.24, 'm', 8)}
          {T(0.85, 0.4, 0.11, 0.2)}
        </>,
      )

    // a track holding entries, and the dashed one saying the run changes length
    case 'rail':
      return wrap(
        <>
          {R(0.24, 0.03, 0.52, 0.94, 'f', 14)}
          {R(0.31, 0.09, 0.38, 0.16, 'f', 8)}
          {R(0.31, 0.31, 0.38, 0.16, 'f', 8)}
          {R(0.31, 0.53, 0.38, 0.16, 'f', 8)}
          {R(0.31, 0.75, 0.38, 0.16, 'g', 8)}
        </>,
      )

    // two states repeated along an edge, and the edge they are repeated along
    case 'tab':
      return wrap(
        <>
          {R(0.05, 0.18, 0.42, 0.56, 'f', 10)}
          {T(0.14, 0.38, 0.24, 0.12)}
          {R(0.53, 0.34, 0.42, 0.4, 'g', 10)}
          {T(0.62, 0.46, 0.24, 0.12)}
          <path className="s" d={`M 0 ${Y(0.74)} H ${X(1)}`} />
        </>,
      )

    // an aperture with somebody in it, standing on the bottom of the box rather
    // than floating in the middle of it, which is the whole point of the type
    case 'portrait_frame':
      return wrap(
        <>
          {R(0.08, 0.05, 0.84, 0.68, 'f', 10)}
          <circle className="m" cx={X(0.5)} cy={Y(0.35)} r={X(0.13)} />
          <path className="m" d={`M ${X(0.24)} ${Y(0.73)} a ${X(0.26)} ${Y(0.22)} 0 0 1 ${X(0.52)} 0 Z`} />
          {T(0.24, 0.83, 0.52, 0.06)}
        </>,
      )

    // a ring around a rectangle somebody else drew, with nothing in the middle
    case 'highlight_edge':
      return wrap(
        <path
          className="f"
          d={`M ${X(0.1)} ${Y(0.32)} V ${Y(0.1)} H ${X(0.32)} M ${X(0.68)} ${Y(0.1)} H ${X(0.9)} V ${Y(0.32)} M ${X(0.9)} ${Y(0.68)} V ${Y(0.9)} H ${X(0.68)} M ${X(0.32)} ${Y(0.9)} H ${X(0.1)} V ${Y(0.68)}`}
        />,
      )

    /* the seasons carry different marks, because five identical discs say the count and not the point. */
    case 'pip':
      return wrap(
        <>
          {[0, 1, 2].map((i) => (
            <circle key={i} className="m" cx={X(0.22 + i * 0.28)} cy={Y(0.3)} r={X(0.11)} />
          ))}
          <path className="o" d={`M ${X(0.18)} ${Y(0.34)} L ${X(0.26)} ${Y(0.25)}`} />
          <path className="o" d={`M ${X(0.46)} ${Y(0.24)} V ${Y(0.36)} M ${X(0.44)} ${Y(0.3)} H ${X(0.56)}`} />
          <circle className="o" cx={X(0.78)} cy={Y(0.3)} r={X(0.04)} />
          <circle className="f" cx={X(0.36)} cy={Y(0.72)} r={X(0.11)} />
          <circle className="g" cx={X(0.64)} cy={Y(0.72)} r={X(0.11)} />
        </>,
      )

    /* a strip of frames of one mark, which is what an animated cue is. Filled
       and not a stroked v: at a fifth of size a two pixel chevron is a speck. */
    case 'cue':
      return wrap(
        <>
          {[0, 1, 2, 3].map((i) => {
            const l = 0.065 + i * 0.25
            const d = 0.24 + i * 0.1
            return (
              <path
                key={i}
                className="m"
                d={`M ${X(l)} ${Y(d)} L ${X(l + 0.06)} ${Y(d)} L ${X(l + 0.0925)} ${Y(d + 0.18)} L ${X(l + 0.125)} ${Y(d)} L ${X(l + 0.185)} ${Y(d)} L ${X(l + 0.0925)} ${Y(d + 0.34)} Z`}
              />
            )
          })}
          {[1, 2, 3].map((i) => (
            <path key={i} className="s" d={`M ${X(i * 0.25)} ${Y(0.12)} V ${Y(0.88)}`} />
          ))}
        </>,
      )

    // a mark that lands on top of something, which is why something is under it
    case 'stamp':
      return wrap(
        <>
          {R(0.14, 0.2, 0.6, 0.6, 'g', 8)}
          <g transform={`rotate(-14 ${X(0.56)} ${Y(0.56)})`}>
            <circle className="f" cx={X(0.56)} cy={Y(0.56)} r={X(0.28)} />
            <circle className="f" cx={X(0.56)} cy={Y(0.56)} r={X(0.22)} />
            {R(0.36, 0.5, 0.4, 0.12, 'm', 3)}
          </g>
        </>,
      )

    /* the arrow points down and the ring is flattened, because both shapes were already other icons. */
    case 'pointer':
      return wrap(
        <>
          {R(0.145, 0.18, 0.03, 0.32, 'm', 2)}
          <path className="m" d={`M ${X(0.06)} ${Y(0.46)} H ${X(0.26)} L ${X(0.16)} ${Y(0.8)} Z`} />
          <path
            className="m"
            d={`M ${X(0.47)} ${Y(0.8)} L ${X(0.36)} ${Y(0.46)} a ${X(0.11)} ${Y(0.24)} 0 1 1 ${X(0.22)} 0 Z`}
          />
          <circle className="o" cx={X(0.47)} cy={Y(0.38)} r={X(0.038)} />
          <ellipse className="f" cx={X(0.8)} cy={Y(0.62)} rx={X(0.15)} ry={Y(0.11)} />
          <circle className="m" cx={X(0.8)} cy={Y(0.62)} r={X(0.032)} />
        </>,
      )

    // a board on a post, at world scale, with the words carved into it
    case 'sign':
      return wrap(
        <>
          {R(0.46, 0.5, 0.08, 0.5, 'm', 2)}
          {R(0.13, 0.12, 0.74, 0.42, 'f', 8)}
          {T(0.2, 0.22, 0.6, 0.08)}
          {T(0.2, 0.38, 0.42, 0.08)}
        </>,
      )

    // one list line, and enough of the next to say it repeats
    case 'row':
      return wrap(
        <>
          {T(0.06, 0.16, 0.34, 0.11)}
          {T(0.68, 0.18, 0.26, 0.08)}
          <path className="s" d={`M ${X(0.04)} ${Y(0.42)} H ${X(0.96)}`} />
          {T(0.06, 0.56, 0.28, 0.11)}
          {T(0.68, 0.58, 0.26, 0.08)}
          <path className="s" d={`M ${X(0.04)} ${Y(0.82)} H ${X(0.96)}`} />
        </>,
      )

    /* A TYPE THE SERVER ADDED AND THIS FILE HAS NOT DRAWN YET. It gets its own
     * honest canvas outline rather than nothing, so a new type appears on the
     * gallery as an undrawn one instead of an empty card. */
    default:
      return wrap(R(0.02, 0.02, 0.96, 0.96, 'g', 8))
  }
}

/* THE CANVAS AT ITS TRUE SIZE, holding the diagram. One divisor across the
 * whole gallery, so the boxes are honest against each other. */
function DiaBox({ t, children }: { t: PType; children?: React.ReactNode }) {
  const [w, h] = diaSize(t)
  return (
    <span className="ui-dia-box" style={{ width: Math.round(w * DIA_K), height: Math.round(h * DIA_K) }}>
      {children ?? <Dia t={t} />}
    </span>
  )
}

/* ---- step two: pick a type and describe one, and one press draws one piece ---- */
function Drawing({
  t,
  types,
  v,
  maps,
  mine,
  stamp,
  onArm,
  onDrawn,
}: {
  t?: PType
  types: PType[]
  v: Vocab
  maps: MapRow[]
  mine: boolean
  stamp: number
  onArm: (name: string) => void
  onDrawn: (name: string, why: string) => void
}) {
  const taken = useMemo(() => new Set(v.ui.map((p) => p.name)), [v.ui])
  const had = t ? v.ui.find((p) => p.type === t.name) : undefined
  const [name, setName] = useState(had ? had.name : t ? t.name : '')
  const [title, setTitle] = useState(had?.title || '')
  const [what, setWhat] = useState(had?.description || '')
  const [style, setStyle] = useState('')
  const [core, setCore] = useState(mine)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const refused = t?.tier === 'none'
  const legal = IDENT.test(name)
  const reserved = !core && v.core.includes(name)
  const replacing = taken.has(name)
  /* any pending row blocks: exempting the same name was two spends, since Drawing is keyed by armed. */
  const blocked = !!v.pending
  const can = !!t && !refused && legal && !reserved && !blocked && what.trim().length > 0 && !busy

  const draw = async () => {
    if (!t) return
    setBusy(true)
    setErr('')
    try {
      /* the answer says whether claude wrote the prompt, and discarding it makes an honest degrade silent. */
      const said = (await post('/api/ui/generate', {
        name,
        type: t.name,
        title,
        description: what.trim(),
        width: t.w,
        height: t.h,
        style: style || undefined,
        core,
      })) as { routed?: boolean; why?: string }
      onDrawn(name, said?.routed === false ? String(said.why || '') : '')
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  // why a name is refused, said on the line under the box rather than after a
  // press. All four cases are about the identifier a reader will hold.
  const nameSays = !legal
    ? 'lower case, digits and underscores, starting with a letter'
    : reserved
      ? `"${name}" belongs to the whole game · pick your own and it is added beside it`
      : replacing
        ? 'this replaces the picture and keeps every mark on it'
        : displayName(name).text

  return (
    <>
      <aside className="panel" key={t?.name || 'none'}>
        <div className="panel-cap">
          {!t ? 'nothing armed' : refused ? 'this one is named so that nobody spends on it' : 'say what this one looks like, in your words'}
        </div>

        {/* one line and no subtitle: at 272px with a button beside it a second line wrapped to three */}
        {t ? (
          <div className="row on ui-armed">
            <span className="row-ic">
              <Dia t={t} />
            </span>
            <span className="row-label">{displayName({ name: t.name, label: t.label }).text}</span>
            <button className="abtn tiny" onClick={() => onArm('')}>
              pick another
            </button>
          </div>
        ) : (
          <>
            <div className="panel-empty">
              <p>pick one of the twenty-one and this fills with what to say about it</p>
            </div>
            {/* the one fact worth having before anything is armed, because it is
                about the spend and not about the layout: the server draws one
                piece at a time and refuses the second. */}
            <div className="panel-foot ui-foot">one press draws one piece</div>
          </>
        )}

        {t && !refused ? (
          <>
            <div className="ui-block">
              <label className="anchfield">
                <span>what code calls it</span>
                <input
                  className={'anchname' + (legal && !reserved ? '' : ' bad')}
                  value={name}
                  spellCheck={false}
                  maxLength={48}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <div className={legal && !reserved ? 'field-desc' : 'anchwarn'}>{nameSays}</div>

              <label className="anchfield">
                <span>what a person calls it</span>
                <input value={title} placeholder={displayName(name).text} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
              </label>

              <label className="anchfield">
                <span>what it looks like</span>
                <textarea
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
              </label>

              {maps.length ? (
                <label className="anchfield" data-tip="a map you have painted hands over its palette, its outline and its shading, and cannot hand over layout">
                  <span>match a painting</span>
                  <select value={style} onChange={(e) => setStyle(e.target.value)}>
                    <option value="">nothing to match</option>
                    {maps.map((m) => (
                      <option key={m.slug} value={m.slug}>
                        {displayName({ name: m.slug, title: m.title }).text}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {mine ? (
                <div className="anchfield" data-tip="core chrome is the whole game's and is never overridable · an addition sits beside it">
                  <span>whose piece</span>
                  <div className="seg">
                    <button className={'seg-opt' + (core ? ' on' : '')} onClick={() => setCore(true)}>
                      core chrome
                    </button>
                    <button className={'seg-opt' + (core ? '' : ' on')} onClick={() => setCore(false)}>
                      an addition
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            {/* THE ONE STANDING LINE ON THIS SCREEN, and it is only here while a
                type is armed. Everything else a type has to say is a tip. */}
            <div className="lawhint">{t.what}</div>
            {blocked ? (
              <div className="anchwarn" style={{ padding: '0 var(--pan-in)' }}>
                {displayName(v.pending?.name || '').text} is still being drawn · they get judged one at a time
              </div>
            ) : null}
            {err ? <p className="ui-err">{err}</p> : null}

            <button className="primary big" disabled={!can} onClick={() => void draw()}>
              {busy ? 'drawing…' : replacing ? 'draw it again' : 'draw it'}
            </button>
          </>
        ) : t && refused ? (
          <div className="lawhint">{t.caution}</div>
        ) : null}
      </aside>

      {/* grouped by tier, the fact that decides whether the edge numbers mean anything, and no checker */}
      <div className="stage">
        <div className="ui-gal">
          {TIERS.map(([tier, say]) => {
            const rows = types.filter((x) => x.tier === tier)
            if (!rows.length) return null
            return (
              <div className="ui-gal-part" key={tier}>
                <div className="asec">{say}</div>
                <div className="ui-gal-set">
                  {rows.map((x) => {
                    /* the one card that stops being a diagram once the account has drawn this type */
                    const had = v.ui.find((p) => p.type === x.name)
                    return (
                      <button
                        key={x.name}
                        className={'ui-card' + (t?.name === x.name ? ' on' : '')}
                        data-tip={x.what}
                        onClick={() => onArm(x.name)}
                      >
                        <span className={'ui-card-art' + (had?.src ? ' ui-check' : '')}>
                          <DiaBox t={x}>
                            {had?.src ? <img src={`${had.src}?v=${stamp}`} alt="" draggable={false} /> : undefined}
                          </DiaBox>
                        </span>
                        <span className="ui-card-say">
                          {/* through displayName like every other name on this
                              page, so a type whose label the server ever stops
                              sending still reads as words and not `cover_plate` */}
                          <span className="ui-card-name">{displayName({ name: x.name, label: x.label }).text}</span>
                          <span className="ui-card-meta mono">
                            {had ? 'drawn' : x.tier === 'none' ? 'no canvas' : `${x.w}×${x.h}`}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

/* ---- step three: the four edges and the named marks, dragged so the slice is seen working ---- */
function Marking({
  piece,
  type,
  v,
  stamp,
  bare,
  onSaved,
  onGone,
  onRedraw,
  onReadout,
  onMarks,
}: {
  piece: Piece
  type?: PType
  v: Vocab
  stamp: number
  // the reason nobody wrote the prompt for this piece, empty when the router ran
  bare: string
  onSaved: () => void
  onGone: () => void
  onRedraw: () => void
  onReadout: (s: string) => void
  onMarks: (n: number) => void
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

  const board = useRef<HTMLDivElement | null>(null)
  const art = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = board.current
    if (!el) return
    const read = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => onMarks(regions.length), [regions.length, onMarks])
  // the coordinate belongs to this piece, so it goes when the piece does
  useEffect(() => () => onReadout(''), [onReadout])

  /* an integer zoom at or above 1, because a pixel drawn 1.4 wide has a seam and an edge is measured here. */
  const raw = box.w && box.h ? Math.min((box.w - 28) / piece.w, (box.h - 28) / piece.h) : 1
  const z = raw >= 1 ? Math.floor(raw) : Math.max(0.1, raw)

  const dirty =
    JSON.stringify(regions) !== JSON.stringify(piece.regions || []) ||
    (ground &&
      JSON.stringify({ slice, scale, fill, repeat }) !==
        JSON.stringify({ slice: piece.slice, scale: piece.scale, fill: piece.fill, repeat: piece.repeat }))

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

  // a rectangle dragged onto the picture. It is not a mark until it is named,
  // because a mark silently called `region_3` is a promise nobody made.
  const startDraft = (e: React.PointerEvent) => {
    if (mode !== 'marks' || e.target !== e.currentTarget) return
    const a = at(e)
    setPick(-1)
    /* clamp against the room left from the origin: x + w past piece.w made checkUi refuse every save. */
    drag(({ x, y }) => {
      const x0 = clamp(Math.min(a.x, x), 0, piece.w)
      const y0 = clamp(Math.min(a.y, y), 0, piece.h)
      setDraft({ x: x0, y: y0, w: clamp(Math.abs(x - a.x), 0, piece.w - x0), h: clamp(Math.abs(y - a.y), 0, piece.h - y0) })
    })(e)
  }

  const moveRegion = (i: number, corner: boolean) =>
    drag(({ x, y }) =>
      setRegions((rs) =>
        rs.map((r, j) => {
          if (j !== i) return r
          if (corner) return { ...r, w: clamp(x - r.x, 1, piece.w - r.x), h: clamp(y - r.y, 1, piece.h - r.y) }
          return {
            ...r,
            x: clamp(x - Math.round(r.w / 2), 0, piece.w - r.w),
            y: clamp(y - Math.round(r.h / 2), 0, piece.h - r.h),
          }
        }),
      ),
    )

  /* both read the list inside the updater, since the closure is stale when two land in one tick. */
  const addNamed = (name: string, kind: string) => {
    const w = Math.max(8, Math.round(piece.w / 3))
    const h = Math.max(8, Math.round(piece.h / 4))
    setRegions((rs) => {
      if (rs.some((r) => r.name === name)) return rs
      const stepBy = (rs.length % 4) * 10
      return [
        ...rs,
        {
          name,
          kind,
          x: clamp(Math.round(piece.w / 2 - w / 2) + stepBy, 0, piece.w - w),
          y: clamp(Math.round(piece.h / 2 - h / 2) + stepBy, 0, piece.h - h),
          w,
          h,
          ...(kind === 'picture' ? { valign: 'bottom', fit: 'contain' } : {}),
          ...(kind === 'fill' ? { axis: 'right', mode: 'tile' } : {}),
        },
      ]
    })
    setPick(regions.length)
    setMode('marks')
  }

  const commitDraft = () => {
    if (!draft || !IDENT.test(draftName) || regions.some((r) => r.name === draftName)) return
    setRegions((rs) => [
      ...rs,
      {
        ...draft,
        name: draftName,
        kind: draftKind,
        ...(draftKind === 'picture' ? { valign: 'bottom', fit: 'contain' } : {}),
        ...(draftKind === 'fill' ? { axis: 'right', mode: 'tile' } : {}),
      },
    ])
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

  const cols = [0, slice.left, piece.w - slice.right, piece.w]
  const rows = [0, slice.top, piece.h - slice.bottom, piece.h]
  const wants = (type?.regions || []).filter((r) => !regions.some((x) => x.name === r.name))
  const cuts = (type?.faces || []).filter((f) => !regions.some((x) => x.name === f))
  const chosen = pick >= 0 ? regions[pick] : undefined

  return (
    <>
      <aside className="panel" key={piece.name}>
        <div className="panel-cap">
          {mode === 'edges'
            ? 'drag the four lines until each corner holds the whole drawn corner'
            : 'drag a rectangle onto the picture and name it'}
        </div>

        {ground ? (
          <div className="seg tabs">
            <button className={'seg-opt' + (mode === 'edges' ? ' on' : '')} onClick={() => setMode('edges')}>
              the edges
            </button>
            <button className={'seg-opt' + (mode === 'marks' ? ' on' : '')} onClick={() => setMode('marks')}>
              the marks
            </button>
          </div>
        ) : null}

        {ground ? (
          <>
            <div className="asec">how it stretches</div>
            <div className="ui-block">
              <div className="numgrid">
                {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
                  <label className="numf" key={k}>
                    <span>{k}</span>
                    <input
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
                <label className="numf" data-tip="how many css pixels one drawn pixel is, so the frame reads at the same weight as the rest of the game">
                  <span>pixel size</span>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={scale}
                    onChange={(e) => setScale(clamp(Number(e.target.value) || 1, 1, 8))}
                  />
                </label>
              </div>
              <div className="seg" data-tip="what the four edges do between the corners">
                {v.repeats.map((r) => (
                  <button
                    key={r}
                    className={'seg-opt' + (repeat.x === r ? ' on' : '')}
                    onClick={() => setRepeat({ x: r, y: r })}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <div className="seg" data-tip="whether the middle of the piece is drawn paper or a hole the map shows through">
                <button className={'seg-opt' + (fill ? ' on' : '')} onClick={() => setFill(true)}>
                  paper middle
                </button>
                <button className={'seg-opt' + (fill ? '' : ' on')} onClick={() => setFill(false)}>
                  a hole
                </button>
              </div>
            </div>
          </>
        ) : null}

        <div className="asec">{type?.tier === 'sheet' ? 'the faces' : 'the marks'}</div>
        {wants.length || cuts.length ? (
          <div className="anchkinds" style={{ padding: '2px var(--pan-in) 4px' }}>
            {wants.map((r) => (
              <button
                key={r.name}
                className="kbtn"
                data-tip={r.required ? 'this type does not read right without it' : `a ${r.kind} this type normally carries`}
                onClick={() => addNamed(r.name, r.kind)}
              >
                + {displayName(r.name).text.toLowerCase()}
              </button>
            ))}
            {cuts.map((f) => (
              <button key={f} className="kbtn" data-tip="a face cut out of this sheet" onClick={() => addNamed(f, 'face')}>
                + {displayName(f).text.toLowerCase()}
              </button>
            ))}
          </div>
        ) : null}

        {regions.length === 0 ? (
          /* two lines, and the second is the move: what is missing, then which press fills it. */
          <div className="panel-empty">
            <p>nothing marked yet</p>
            <p className="ui-empty-do">add one above, then drag it over the art</p>
          </div>
        ) : (
          regions.map((r, i) => {
            const said = displayName(r.name)
            return (
              <button
                key={r.name}
                className={'row' + (pick === i ? ' on' : '')}
                onClick={() => {
                  setPick(i)
                  setMode('marks')
                }}
              >
                <span className="ui-sw" data-kind={r.kind} />
                <span className="row-tx">
                  <span className={'row-label' + (said.derived ? ' guessed' : '')}>{said.text}</span>
                  {/* the address belongs in this mono line and the words go on the tag over the art */}
                  <span className="row-desc mono">
                    {r.name} · {r.kind} · {r.x},{r.y} {r.w}×{r.h}
                  </span>
                </span>
              </button>
            )
          })
        )}

        {/* the chosen mark's own fields, in the editor's inspector, because a
            fill's direction on a text well is a control reporting a state it
            does not deliver */}
        {chosen ? (
          <div className="insp">
            <div className="insp-head">
              {/* the words first and the address after, since mono alone reads as plaque_hang */}
              <span className="insp-name">{displayName(chosen.name).text}</span>
              <span className="insp-code mono">{chosen.name}</span>
              <button className="arow-x" aria-label={`drop ${displayName(chosen.name).text}`} onClick={() => {
                setRegions((rs) => rs.filter((_, j) => j !== pick))
                setPick(-1)
              }}>
                ×
              </button>
            </div>
            <label className="insp-row">
              <span>kind</span>
              <select
                value={chosen.kind}
                onChange={(e) => setRegions((rs) => rs.map((x, j) => (j === pick ? { ...x, kind: e.target.value } : x)))}
              >
                {v.kinds.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            {chosen.kind === 'picture' ? (
              <>
                {/* the vertical has no default: a centred frame leaves every character floating */}
                <label className="insp-row">
                  <span>stands</span>
                  <select
                    value={chosen.valign || ''}
                    onChange={(e) => setRegions((rs) => rs.map((x, j) => (j === pick ? { ...x, valign: e.target.value } : x)))}
                  >
                    <option value="">where?</option>
                    {v.valigns.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="insp-row">
                  <span>fit</span>
                  <select
                    value={chosen.fit || 'contain'}
                    onChange={(e) => setRegions((rs) => rs.map((x, j) => (j === pick ? { ...x, fit: e.target.value } : x)))}
                  >
                    {v.fits.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
            {chosen.kind === 'fill' ? (
              <>
                <label className="insp-row">
                  <span>grows</span>
                  <select
                    value={chosen.axis || 'right'}
                    onChange={(e) => setRegions((rs) => rs.map((x, j) => (j === pick ? { ...x, axis: e.target.value } : x)))}
                  >
                    {v.fillAxes.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="insp-row">
                  <span>how</span>
                  <select
                    value={chosen.mode || 'tile'}
                    onChange={(e) => setRegions((rs) => rs.map((x, j) => (j === pick ? { ...x, mode: e.target.value } : x)))}
                  >
                    {v.fillModes.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
            {/* align is the one qualifier a consumer cannot guess, and empty means the reader decides */}
            {chosen.kind === 'text' || chosen.kind === 'number' ? (
              <label className="insp-row">
                <span>aligns</span>
                <select
                  value={chosen.align || ''}
                  onChange={(e) => setRegions((rs) => rs.map((x, j) => (j === pick ? { ...x, align: e.target.value } : x)))}
                >
                  <option value="">the reader decides</option>
                  {(v.aligns || []).map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {chosen.kind === 'text' ? (
              <>
                <label className="insp-row">
                  <span>wrap</span>
                  <select
                    value={chosen.wrap || 'wrap'}
                    onChange={(e) => setRegions((rs) => rs.map((x, j) => (j === pick ? { ...x, wrap: e.target.value } : x)))}
                  >
                    {v.wraps.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="insp-row">
                  <span>too long</span>
                  <select
                    value={chosen.overflow || 'ellipsis'}
                    onChange={(e) => setRegions((rs) => rs.map((x, j) => (j === pick ? { ...x, overflow: e.target.value } : x)))}
                  >
                    {v.overflows.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
          </div>
        ) : null}

        {err ? <p className="ui-err">{err}</p> : null}
        {/* said where the piece is looked at, because that is where somebody
            decides whether the picture is any good */}
        {bare ? (
          <div className="anchwarn" style={{ padding: '4px var(--pan-in) 0' }}>
            {bare}
          </div>
        ) : null}
        {warn.map((w) => (
          <div className="anchwarn" key={w} style={{ padding: '4px var(--pan-in) 0' }}>
            {w}
          </div>
        ))}

        <button className="primary big" disabled={busy || (!dirty && saved)} onClick={() => void save()}>
          {busy ? 'saving…' : 'save the marks'}
        </button>
        <div className="actrow">
          {/* its own line: three buttons in a 272 px rail give 76 px each and this label wrapped */}
          <button
            className="abtn own-line"
            disabled={busy || dirty || piece.published}
            data-tip="says the measurement was made and survives its own check, which is a different fact from the picture having arrived"
            onClick={() => void publish()}
          >
            {piece.published ? 'measured' : 'call it measured'}
          </button>
          <button className="abtn" onClick={onRedraw} data-tip="draw the picture again and keep every mark on it">
            draw it again
          </button>
          <button
            className={'abtn danger' + (doomed ? ' armed' : '')}
            onClick={() => (doomed ? void scrap() : setDoomed(true))}
            data-tip={doomed ? 'the picture and every mark on it go' : 'remove this piece'}
          >
            {doomed ? 'yes, remove it' : 'remove'}
          </button>
        </div>

        {css ? (
          <>
            <div className="asec">what the game takes</div>
            <pre className="ui-css">{css}</pre>
            <div className="actrow">
              <button className="abtn" onClick={() => void navigator.clipboard?.writeText(css)}>
                copy it
              </button>
            </div>
          </>
        ) : null}
      </aside>

      <div className="stage ui-stage">
        {/* the checker goes on the piece and not the board, since it is about that picture's transparency */}
        <div className="ui-board" ref={board}>
          <div
            className="ui-art ui-check"
            ref={art}
            data-mode={mode}
            style={{ width: piece.w * z, height: piece.h * z }}
            onPointerDown={startDraft}
            onPointerMove={(e) => onReadout(`${at(e).x},${at(e).y}`)}
            onPointerLeave={() => onReadout('')}
          >
            {piece.src ? (
              <img src={`${piece.src}?v=${stamp}`} alt="" draggable={false} />
            ) : (
              <span className="ui-art-void">
                {piece.status === 'failed'
                  ? 'nothing came back, and the marks are kept'
                  : 'no picture yet, and the marks can be made anyway'}
              </span>
            )}

            {mode === 'edges' ? (
              <>
                {rows.slice(0, 3).map((y0, r) =>
                  cols.slice(0, 3).map((x0, c) => (
                    <span
                      key={`${r}-${c}`}
                      className="ui-nine"
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
                <span className="ui-guide h" style={{ top: slice.top * z }} />
                <span className="ui-guide h" style={{ top: (piece.h - slice.bottom) * z }} />
                <span className="ui-guide v" style={{ left: slice.left * z }} />
                <span className="ui-guide v" style={{ left: (piece.w - slice.right) * z }} />
                <span className="ui-grip h" style={{ top: slice.top * z }} onPointerDown={edge('top')}>
                  <i>{slice.top}</i>
                </span>
                <span className="ui-grip h" style={{ top: (piece.h - slice.bottom) * z }} onPointerDown={edge('bottom')}>
                  <i>{slice.bottom}</i>
                </span>
                <span className="ui-grip v" style={{ left: slice.left * z }} onPointerDown={edge('left')}>
                  <i>{slice.left}</i>
                </span>
                <span className="ui-grip v" style={{ left: (piece.w - slice.right) * z }} onPointerDown={edge('right')}>
                  <i>{slice.right}</i>
                </span>
              </>
            ) : (
              <>
                {regions.map((r, i) => (
                  <span
                    key={r.name}
                    className={'ui-rect' + (pick === i ? ' on' : '')}
                    data-kind={r.kind}
                    style={{ left: r.x * z, top: r.y * z, width: r.w * z, height: r.h * z }}
                    onPointerDown={(e) => {
                      setPick(i)
                      moveRegion(i, false)(e)
                    }}
                  >
                    {/* the words, never the identifier, which is the one rule
                        src/core/naming.ts exists to hold. The address is on the
                        rail row's mono line. */}
                    <i>{displayName(r.name).text}</i>
                    <b onPointerDown={moveRegion(i, true)} />
                  </span>
                ))}
                {draft ? (
                  <span
                    className="ui-rect draft"
                    style={{ left: draft.x * z, top: draft.y * z, width: draft.w * z, height: draft.h * z }}
                  />
                ) : null}
              </>
            )}
          </div>

          {draft ? (
            <div className="ui-naming">
              <label className="anchfield">
                <span>name this mark</span>
                <input
                  className="anchname"
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
              </label>
              <div className="anchkinds">
                {v.kinds.map((k) => (
                  <button key={k} className={'kbtn' + (draftKind === k ? ' on' : '')} onClick={() => setDraftKind(k)}>
                    {k}
                  </button>
                ))}
              </div>
              <div className="actrow">
                <button className="abtn" onClick={() => setDraft(null)}>
                  drop it
                </button>
                <button className="abtn on" disabled={!IDENT.test(draftName)} onClick={commitDraft}>
                  name it
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {ground ? (
          <div className="ui-tray">
            <span className="asec">stretched, live</span>
            <Preview
              src={piece.src ? `${piece.src}?v=${stamp}` : ''}
              slice={slice}
              scale={scale}
              fill={fill}
              repeat={repeat}
            />
          </div>
        ) : null}
      </div>
    </>
  )
}

/* each box is sized FROM the slice: fixed at 252 with a 115 slice each side it drew a stack of corners. */
const TRAY_ROOM = 118

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
  // the middle each shape asks for: a label, a line of speech, a column
  const shapes: Array<[number, number, string]> = [
    [150, 6, 'a plaque'],
    [330, 76, 'a box'],
    [40, 190, 'a tall panel'],
  ]
  const outW = (mid: number) => (slice.left + slice.right) * scale + mid
  const outH = (mid: number) => (slice.top + slice.bottom) * scale + mid
  const k = Math.min(1, TRAY_ROOM / Math.max(1, ...shapes.map(([, mh]) => outH(mh))))
  const style = src
    ? {
        borderStyle: 'solid' as const,
        borderWidth: `${slice.top * scale}px ${slice.right * scale}px ${slice.bottom * scale}px ${slice.left * scale}px`,
        borderImage: `url("${src}") ${slice.top} ${slice.right} ${slice.bottom} ${slice.left}${fill ? ' fill' : ''} / 1 / 0 ${repeat.x} ${repeat.y}`,
      }
    : undefined
  return (
    <>
      {shapes.map(([mw, mh, say]) => (
        <div key={say} className="ui-prev">
          <div className="ui-prev-fit" style={{ width: Math.round(outW(mw) * k), height: Math.round(outH(mh) * k) }}>
            <div className="ui-prev-box" style={{ width: mw, height: mh, transform: `scale(${k})`, ...style }} />
          </div>
          <span>{say}</span>
        </div>
      ))}
    </>
  )
}
