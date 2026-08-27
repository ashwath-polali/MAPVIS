/* One screen, one visible workflow: 1 load, 2 cut, 3 levels, 4 test,
 * 5 assets, 6 export. The active step owns the left panel; the painting owns
 * the rest.
 *
 * Two rules hold everything together. A step never hides another step's
 * result: entering a step sets the view that shows its work, and every state
 * change says what it did in a toast. And the core document, the export
 * bundle, the autosave and the server wiring are byte-identical to the
 * previous MAPVIS: this file only changes how a human reaches them.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, ReactNode } from 'react'
import { Editor, isCutTool, loadImage, groupFor, type EditorStatus, type Tool } from './core/editor'
import { PAL, mkCanvas, nameOf, assetLabel, ANCHOR_KINDS, type AnchorKind, type AssetLook, type PlacedAsset } from './core/mask'

/* What each kind is FOR, in the words an author would use. Shown on the kind
 * buttons and under the form, because "post" and "trigger" mean nothing until
 * somebody says what the engine does with them. */
const ANCHOR_WHAT: Record<AnchorKind, string> = {
  point: 'a spot to walk to · guide_to("name")',
  region: 'an area to be inside · fires when the player is in it',
  door: 'walk into it, press E, and the next map loads',
  post: 'where somebody stands · bind it to a placement and it follows them',
  spawn: 'where the player begins, or arrives from a door',
  trigger: 'a spot that fires once when it is reached',
}
import { Help } from './ui/Help'
import { computeRegions } from './core/regions'
import { debase } from './core/debase'
import { bitify, bitFactor } from './core/bitify'
import { cleanLife } from './core/life'
import {
  CUSTOM_DESC,
  EFFECT_DESC,
  fillParams,
  flatParams,
  fpsFor,
  guessColors,
  guessType,
  isEffectType,
  renderEffect,
  samplePalette,
  type AnyEffectType,
  type EffectParams,
  type EffectType,
  type Patch,
} from './core/effects'
import { customCanvases, runCustom, type CustomSpec } from './core/customfx'
import { matchToPalette, sampleMapPalette } from './core/palette'
import * as api from './api'
import { Icon, type IconName } from './ui/icons'

type StepId = 'load' | 'cut' | 'levels' | 'test' | 'assets' | 'export'

const STEPS: { id: StepId; n: number; name: string }[] = [
  { id: 'load', n: 1, name: 'load' },
  { id: 'cut', n: 2, name: 'cut' },
  { id: 'levels', n: 3, name: 'levels' },
  { id: 'test', n: 4, name: 'test' },
  { id: 'assets', n: 5, name: 'assets' },
  { id: 'export', n: 6, name: 'export' },
]

// the groups that exist even when empty, so placing has somewhere to aim
const SUGGESTED_GROUPS = ['trees', 'people', 'smoke', 'effects', 'props']

// where a tool lives, so a keyboard tool change can never happen off-screen:
// the workflow follows the key instead of hiding the mode
const homeStep = (t: Tool): StepId =>
  isCutTool(t) ? 'cut' : 'levels'

// the chips, in the brief's plain words; values and canvas colours stay PAL's
const CHIP_LABEL: Record<number, string> = {
  0: 'blocked',
  40: 'ground',
  50: 'stairs 1',
  60: 'level 1',
  70: 'stairs 2',
  80: 'level 2',
  90: 'stairs 3',
  100: 'level 3',
}

interface Cand {
  id: string
  seed: number
  state: 'running' | 'done' | 'failed'
  url?: string
  error?: string
}

interface Toast {
  id: number
  text: string
  /* One thing the line can offer to do about itself. It exists for the edits
   * that rewrite pixels, because z cannot take those back and finding that out
   * afterwards is how nineteen trees ended up cropped with no way home. The
   * offer sits on the line that announced the change, which is the one moment
   * somebody is definitely looking at it. */
  act?: { label: string; run: () => void }
}

// one row of the compare panel: a library item and its frames exactly as they
// came back, before anything was matched to anything
interface PlItem {
  name: string
  kind: 'static' | 'animated'
  fps: number
  raw: HTMLCanvasElement[]
}

/* Everything one open effect is made of. It is a named shape rather than an
 * inline one because the review loop takes it as an argument: the loop works
 * off explicit values instead of state, so it can render and check a revision
 * before anything it did reaches the panel. */
interface FxState {
  type: AnyEffectType
  name: string
  ask: string
  at: [number, number]
  colors: string[]
  mapColors: string[]
  ownColors: string[]
  palette: 'map' | 'own'
  patch: Patch | null
  custom?: CustomSpec
}

// how many times the tool looks at its own render before he is asked to judge
// it. Every pass is free: the render is local and the look generates nothing.
const FX_PASSES = 3

/* How many things go on one contact sheet. The review route slices to this
 * whatever it is sent, so a run of eight takes or a fill of twenty-four has to
 * cut its own list to the same number: naming twenty-four things over a strip
 * with six cells in it is asking about pictures that are not there. */
const LOOK_CELLS = 6

/* The one thing about a made sprite that is not a creative choice.
 *
 * Eight views because life.ts works out an eight-way facing and four makes the
 * diagonals snap to the wrong one. That is an engine requirement, so it is a
 * constant and never a routing answer.
 *
 * Everything else about a sprite used to be constants and dropdowns here: the
 * body type, the animal template, the view, the size, one walk cycle name. Each
 * one was a list, and a list is always shorter than what somebody wants to
 * make. A dragon is not on it, a robot is not on it, and neither of them walks.
 * So the ask goes to the router whole and it answers the skeleton, the view,
 * the size and what moving MEANS for that thing. See MakePlan in api.ts. */
const CHAR_DIRS = 8

// a running wait, said the way a clock says it
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/* Where the filled part of a rail ends.
 *
 * Firefox works this out on its own through ::-moz-range-progress. Webkit has
 * no such part and never will, so the position is handed over as a custom
 * property and the gradient in app.css reads it. A range that skips this draws
 * its rail empty at every value, which is why every one of them goes through
 * here rather than only the two that were noticed. */
const rail = (v: number, lo: number, hi: number): CSSProperties => ({
  ['--pct' as string]: `${hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 100 : 0}%`,
})

/* The handle a stop is posted against. One per gesture, minted here so every
 * long call in the tool carries one and none of them can run to a timeout with
 * nothing to press. The prefix is only there to read in a log. */
const newJob = (what: string) => `${what}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-') || 'scene'

/* the folder an item's pixels live in: the prefix every one of its placements
 * carries, and the key for dropping their cached bytes.
 *
 * A set of headings lives in a folder too. Reading only frames[0] answered ''
 * for those, and bustAssets('') returns without doing anything, so a person
 * whose frames were rewritten under the same names went on being drawn out of
 * the cache from the old pixels. It only started to matter when an item could
 * gain frames in place.
 *
 * A plain png has no folder at all, and it answered '' for the same reason and
 * with the same result: keep matched wrote new pixels under the same name and
 * the placement on the canvas went on drawing the old ones. Its own url is the
 * prefix that matches exactly itself, which is all bustAssets needs. */
const folderOf = (it: api.LibItem): string => {
  const f = (it.frames && it.frames[0]) || (it.dirs && Object.values(it.dirs)[0]?.[0]) || ''
  return f ? f.slice(0, f.lastIndexOf('/') + 1) : it.src || ''
}

/* one library row as ONE APPEARANCE, which is what a sequence switches to.
 *
 * The same three shapes placeAt reads when it turns a row into a placement, in
 * the same order: a set of views carries a src as well, pointing at whichever
 * heading came first, so views have to be taken before the src branch claims it
 * and loses the other seven. */
/* A face, in the shape the renderer draws. Same three shapes as a library row
 * and for the same reason: a state of a walking character is eight headings,
 * and losing them mid-round turns a troll south the moment it becomes a rock. */
const lookOfState = (f: api.AssetState): AssetLook => {
  const L: AssetLook = f.frames && f.frames.length
    ? { kind: 'animated', frames: f.frames.slice(), fps: f.fps || 8 }
    : { kind: 'static', src: f.src }
  if (f.dirs && Object.keys(f.dirs).length) {
    L.dirs = { ...f.dirs }
    if (f.fps && f.fps > 0) L.fps = f.fps
  }
  return L
}

const lookOfItem = (it: api.LibItem): AssetLook => {
  const L: AssetLook =
    it.kind === 'animated'
      ? { kind: 'animated', frames: (it.frames || []).slice(), fps: it.fps || 8 }
      : { kind: 'static', src: it.src }
  if (it.dirs && Object.keys(it.dirs).length) {
    L.dirs = { ...it.dirs }
    // a heading holds a whole walk cycle on a character, so a view set needs a
    // rate the same way an animated item does
    if (it.fps && it.fps > 0) L.fps = it.fps
  }
  return L
}

// ---- the palette lock ---------------------------------------------------
// The generator answers in its own colours whatever the ask said, so the
// answer is pushed onto the map's palette after it lands. It is arithmetic,
// not a generation: free, instant, and the same every time.

// every frame of a library item, decoded onto its own canvas. The compare
// panel draws these and the lock reads them, so both halves work off the same
// pixels the library is already showing.
/* Every image an item is made of, and what each one is called.
 *
 * An item is one png, OR a folder of animation frames, OR a set of views, one
 * per heading. The third shape arrived with eight-sided art and every edit
 * operation was blind to it: they all read `src`, which on a view set points at
 * the south view, so a trim or a pixelate would have processed one of the eight
 * and written it back under the wrong name. Everything that edits pixels asks
 * here instead, so all three shapes go down one road.
 *
 * keys is null for the first two shapes and the view names for the third. */
/* EVERY PICTURE AN ITEM IS MADE OF, and the word every is the whole of this.
 *
 * It used to answer the FIRST frame of each heading and nothing else. On a
 * standing view set that is right, because a heading is one picture. On a
 * walking one a heading is eight, so every in-place edit read 8 pictures out of
 * 64, wrote 8 back, and the item stopped being a walk cycle. Crop, ctrl+P and
 * trim the base all went through here, so all three did it.
 *
 * Seen on the hub 2026-08-25: cropping dock-porter left `dirs.json` pointing at
 * one `east.png` per heading where there had been `east-0.png` through
 * `east-7.png`, and took `fps` and `characterId` with it. The sprite kept its
 * name and quietly stopped walking.
 *
 * keys runs parallel to urls, one entry per picture, repeating a heading once
 * per frame it owns. That is what lets the writer put the set back together in
 * the shape it found it. */
function partsOf(it: { kind: string; src?: string; frames?: string[]; dirs?: Record<string, string[]> }): {
  urls: string[]
  keys: string[] | null
} {
  if (it.dirs && Object.keys(it.dirs).length) {
    const urls: string[] = []
    const keys: string[] = []
    for (const k of Object.keys(it.dirs)) {
      const list = it.dirs[k]
      if (!list || !list.length) continue
      for (const u of list) {
        if (!u) continue
        urls.push(u)
        keys.push(k)
      }
    }
    return { urls, keys }
  }
  return { urls: (it.kind === 'animated' ? it.frames || [] : [it.src || '']).filter(Boolean), keys: null }
}

async function framesOf(it: {
  kind: string
  src?: string
  frames?: string[]
  dirs?: Record<string, string[]>
}): Promise<HTMLCanvasElement[]> {
  const urls = partsOf(it).urls
  const imgs = await Promise.all(urls.map((u) => loadImage(u)))
  return imgs.map((img) => {
    const c = mkCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.imageSmoothingEnabled = false
    g.drawImage(img, 0, 0)
    return c
  })
}

// one frame through the lock and back onto a canvas. Nothing leaves the tab,
// so the slider is a preview of exactly the bytes that would be written.
function matchCanvas(src: HTMLCanvasElement, palette: string[], strength: number): HTMLCanvasElement {
  const g0 = src.getContext('2d') as CanvasRenderingContext2D
  const out = matchToPalette(g0.getImageData(0, 0, src.width, src.height), palette, strength)
  const c = mkCanvas(src.width, src.height)
  const g = c.getContext('2d') as CanvasRenderingContext2D
  const id = g.createImageData(src.width, src.height)
  id.data.set(out.data)
  g.putImageData(id, 0, 0)
  return c
}

// the map's own colours, off the WHOLE painting with the cut dropped. A radius
// bigger than the canvas makes patchAround hand back all of it, so nobody has
// to click a spot and no step is added to anyone's way through the tool.
const readMapPalette = (e: Editor): string[] => {
  const p = e.patchAround(Math.round(e.doc.W / 2), Math.round(e.doc.H / 2), Math.max(e.doc.W, e.doc.H))
  return p ? sampleMapPalette({ data: p.data, width: p.w, height: p.h }, 14) : []
}

// ---- small pieces -------------------------------------------------------

// the walkable percentage, eased toward its new value so a region click
// visibly moves the number instead of teleporting it
function TickPct({ value }: { value: number }) {
  const [shown, setShown] = useState(value)
  const fromRef = useRef(value)
  useEffect(() => {
    const from = fromRef.current
    if (Math.abs(from - value) < 0.05) {
      fromRef.current = value
      setShown(value)
      return
    }
    const t0 = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 300)
      const eased = 1 - (1 - k) ** 3
      const v = from + (value - from) * eased
      fromRef.current = v
      setShown(v)
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{shown.toFixed(1)}</>
}

// one row in a step panel: a big target, a plain label, one line under it,
// the key shown on hover
function Row(props: {
  icon?: IconName
  label: string
  desc?: string
  kbd?: string
  on?: boolean
  disabled?: boolean
  onClick?: () => void
  children?: ReactNode
}) {
  return (
    <button className={'row' + (props.on ? ' on' : '')} onClick={props.onClick} disabled={props.disabled}>
      {props.icon && (
        <span className="row-ic">
          <Icon name={props.icon} />
        </span>
      )}
      <span className="row-tx">
        <span className="row-label">
          {props.label}
          {props.kbd && <kbd>{props.kbd}</kbd>}
        </span>
        {props.desc && <span className="row-desc">{props.desc}</span>}
      </span>
      {props.children}
    </button>
  )
}

// a section header. Every panel labels its groups the same way, so the eye
// learns one shape instead of six.
function Sec({ children }: { children: ReactNode }) {
  return <div className="asec">{children}</div>
}

// one collapsed line of keys at the foot of a panel, instead of a standing
// block of text nobody reads twice
function Keys({ lines }: { lines: string[] }) {
  return (
    <details className="keys">
      <summary>keys</summary>
      <div className="keys-body">
        {lines.map((l) => (
          <div key={l}>{l}</div>
        ))}
      </div>
    </details>
  )
}

/* Two clicks for anything that can not be taken back. The first click arms and
 * the label says so, the second does it, and an unattended arm disarms itself.
 * One hook for every armed control in the tool, so they all behave the same. */
function useArm(): [string, (key: string, ms?: number) => boolean, () => void] {
  const [armed, setArmed] = useState('')
  // the answer has to be known inside the click handler, so the truth lives in
  // a ref and the state is only what the label reads
  const cur = useRef('')
  const t = useRef(0)
  const drop = useCallback(() => {
    window.clearTimeout(t.current)
    cur.current = ''
    setArmed('')
  }, [])
  const arm = useCallback((key: string, ms = 2600) => {
    window.clearTimeout(t.current)
    if (cur.current === key) {
      cur.current = ''
      setArmed('')
      return true
    }
    cur.current = key
    setArmed(key)
    t.current = window.setTimeout(() => {
      cur.current = ''
      setArmed('')
    }, ms)
    return false
  }, [])
  return [armed, arm, drop]
}

/* A number you can type. It shows the live value until it has focus, then it
 * holds exactly what is being typed; enter and blur commit, esc puts the old
 * value back. One commit is one undo step in the editor. */
function NumField(props: {
  label: string
  value: number
  dp?: number
  step?: number
  onCommit: (v: number) => void
}) {
  const [txt, setTxt] = useState('')
  const [live, setLive] = useState(false)
  const cancel = useRef(false)
  const shown = live ? txt : props.dp ? props.value.toFixed(props.dp) : String(Math.round(props.value))
  return (
    <label className="numf">
      <span>{props.label}</span>
      <input
        type="number"
        step={props.step || 1}
        value={shown}
        onFocus={() => {
          cancel.current = false
          setTxt(props.dp ? props.value.toFixed(props.dp) : String(Math.round(props.value)))
          setLive(true)
        }}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={() => {
          setLive(false)
          if (cancel.current) return
          const v = Number(txt)
          if (isFinite(v) && txt.trim() !== '') props.onCommit(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            cancel.current = true
            e.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

// the effect preview: the rendered frames looping on a canvas at one zoom.
// Pixel art, so nothing is smoothed and nothing is tweened between frames, and
// the clock is the effect's own fps so the panel plays what the map will play.
function FxPlay({ frames, zoom, fps }: { frames: HTMLCanvasElement[]; zoom: number; fps: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c || !frames.length) return
    const w = frames[0].width
    const h = frames[0].height
    c.width = w * zoom
    c.height = h * zoom
    const g = c.getContext('2d') as CanvasRenderingContext2D
    let i = 0
    let last = 0
    let raf = 0
    const step = (t: number) => {
      raf = requestAnimationFrame(step)
      if (t - last < 1000 / Math.max(1, fps)) return
      last = t
      g.imageSmoothingEnabled = false
      g.clearRect(0, 0, c.width, c.height)
      g.drawImage(frames[i % frames.length], 0, 0, w, h, 0, 0, c.width, c.height)
      i++
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [frames, zoom, fps])
  return <canvas ref={ref} className="fxcv" />
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const edRef = useRef<Editor | null>(null)
  const [st, setSt] = useState<EditorStatus | null>(null)
  const [step, setStep] = useState<StepId>('load')
  const [prompt, setPrompt] = useState('')
  const [cands, setCands] = useState<Cand[]>([])
  const [usd, setUsd] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [regionsBusy, setRegionsBusy] = useState(false)
  const [armed, arm, disarm] = useArm()
  const [lib, setLib] = useState<api.LibItem[] | null>(null)
  // the words he typed, kept so "what did I write to get that tree" has an
  // answer in the app instead of on disk
  const [asks, setAsks] = useState<api.Ask[]>([])
  const [asksOpen, setAsksOpen] = useState(false)
  /* How chunky ctrl+p makes a sprite, as sprite-pixels per map-pixel. 1 is the
   * strict match to the painting and it is the blockiest possible result, since
   * the map has only as many pixels there as the sprite is wide on it. The
   * strict match shipped first and was far too much; the gentlest step was then
   * not quite enough. 2 is where his eye landed, so 2 is where this starts. */
  const [grain, setGrain] = useState(2)
  // the assets panel's two halves: place what exists, or make something new
  // library thumbnails whose pixels were rewritten under the same name: the
  // stamp goes on the img url so the browser cache can not answer with the old
  // picture. The stored library urls stay clean.
  const [bust, setBust] = useState<Record<string, number>>({})
  // the picker over what the pixellab account already owns. Open, which page,
  // what is typed in its search, what came back, and which one is being copied
  // in right now. Nothing on this path generates.
  const [acc, setAcc] = useState<{
    open: boolean
    q: string
    page: number
    items: api.AccountObject[]
    total: number
    pages: number
    busy: boolean
    taking: string
    err: string
  }>({ open: false, q: '', page: 0, items: [], total: 0, pages: 1, busy: false, taking: '', err: '' })
  /* The account has two kinds of thing and they are not interchangeable.
   * OBJECTS are props: crates, wells, trees. SPRITES are built on a skeleton,
   * with four or eight directions and cycles hung on it. Anything that walks a
   * harbour is the second kind, so the browser shows both and says which. */
  const [chars, setChars] = useState<{ items: api.AccountCharacter[]; busy: boolean; err: string } | null>(null)
  const [accTab, setAccTab] = useState<'objects' | 'sprites'>('objects')
  const [genPrompt, setGenPrompt] = useState('')
  const [genType, setGenType] = useState<'static' | 'animated'>('static')
  /* What the one ask box is for. There used to be two boxes stacked in the
   * column, an object one and an effect one, running the same gesture twice:
   * type, point at the map, get a thing. One box and a four-way says the same
   * with half the controls. */
  const [makeWhat, setMakeWhat] = useState<'object' | 'effect' | 'fill' | 'sprite'>('object')
  /* A sprite is the longest wait in the tool by a wide margin: minutes for the
   * body, minutes again for eight directions of motion, all inside one request.
   * So the button counts out loud, because a still label for six minutes is
   * indistinguishable from a hang.
   */
  const [charRun, setCharRun] = useState<{ at: number } | null>(null)
  const [charSecs, setCharSecs] = useState(0)
  // how many things a fill plans. A range, because "populate this" means
  // something different for a courtyard than for a whole beach.
  const [fillCount, setFillCount] = useState(6)
  /* How many takes on ONE thing. Not fill's slider, which means a set of
   * different things: this is the same core asset drawn again from a different
   * seed, so what comes back is four palms rather than a palm, a barrel and a
   * crate. Starts at 1, because the default press has to be the cheap one, and
   * stops at 8, because a moving sprite is nine generations a take and the gate
   * below is the only reason even that is safe. */
  const [genCount, setGenCount] = useState(1)
  const [scene, setScene] = useState<api.ScenePlan | null>(null)
  // which of the planned things are still wanted, by index: a plan you can
  // edit before spending beats a plan you accept whole or throw away
  const [sceneOff, setSceneOff] = useState<Set<number>>(new Set())
  const [fillRun, setFillRun] = useState<{ done: number; total: number; what: string } | null>(null)
  const [genRun, setGenRun] = useState<{ done: number; total: number } | null>(null)
  // the area boxed on the painting, in painting pixels. null means the whole
  // map is read instead, which is a real answer and not a missing step.
  const [genBox, setGenBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  // what the model wrote after looking. Held so the words and the size can be
  // seen BEFORE anything is bought; the second press spends it.
  const [genPlan, setGenPlan] = useState<api.MakePlan | null>(null)
  const [genBusy, setGenBusy] = useState(false)
  // the prompt behind the take he did not keep, fed into the next reading so
  // pressing again is a correction rather than a reroll of the same idea
  const [genLast, setGenLast] = useState('')
  const [genShow, setGenShow] = useState(false)
  /* Giving a placement a way of moving. Three steps and they are the ones he
   * described: the sparkle opens a box, the words go in, then the map is asked
   * where it is allowed to roam. Esc at the boundary step is a real answer, not
   * a cancel: no fence means the movement is judged from the map instead. */
  // the help panel, opened on the step you are standing in so the first
  // thing you read is about what is in front of you
  const [helpOn, setHelpOn] = useState(false)
  const [lifeOpen, setLifeOpen] = useState(false)
  /* the second-face box. Separate from the sparkle's because they are separate
   * jobs and doing them in one box was the shape that could not work: a face is
   * a GENERATION and a round is free, so they cannot share a send button. */
  const [faceOpen, setFaceOpen] = useState(false)
  const [faceAsk, setFaceAsk] = useState('')
  const [faceBusy, setFaceBusy] = useState(false)
  const [lifeAsk, setLifeAsk] = useState('')
  const [lifeBusy, setLifeBusy] = useState(false)
  const [lifeNote, setLifeNote] = useState('')
  /* Animating a thing that is already in the library.
   *
   * Life moves a placement around the map. This is the other half: what the
   * pixels themselves do while they stand there. Five people on the hub were
   * dead still, and dead still is what makes a map read as a diorama.
   *
   * One free-text box, the same two presses as every other spend, and no list
   * of animations anywhere: the words go to the server and it answers whether
   * that is a written recipe (free), one picture animated (one), or every
   * heading in one coordinated job (one each). */
  const [animOpen, setAnimOpen] = useState(false)
  const [animAsk, setAnimAsk] = useState('')
  const [animBusy, setAnimBusy] = useState(false)
  const [animPlan, setAnimPlan] = useState<api.AnimPlan | null>(null)
  /* The run carries the plan it is running as well as its start time. The plan
   * is cleared the instant the confirmed press lands, so without this the
   * button would have nothing left to say what it is doing for the several
   * minutes it takes. */
  const [animRun, setAnimRun] = useState<{ at: number; plan: api.AnimPlan } | null>(null)
  const [animSecs, setAnimSecs] = useState(0)
  const [animNote, setAnimNote] = useState('')
  // stop: the server-side job to kill, and a flag the loops check between
  // steps so a batch ends after the generation already in flight
  const jobRef = useRef('')
  const stopRef = useRef(false)
  /* A ROUND WAITING FOR SOMETHING TO PUT IT ON.
   *
   * One ask can describe a creature and what it does, and the drawing finishes
   * long before anything is placed. The round cannot be applied to nothing, so
   * it waits here until the first placement of that item lands and is handed
   * over then. That is why nobody ever types the sentence twice.
   *
   * It is a ref and not state on purpose: it is read once inside a callback at
   * the moment of placing, and putting it in state would re-run the placing
   * effect every time it changed. */
  const pendingLife = useRef<{ name: string; ask: string } | null>(null)
  /* THE PIXEL EDITS z HAS TO UNDO, and how it knows which z.
   *
   * Crop, ctrl+P, trim and palette match rewrite files on disk. The document
   * knows nothing about that, so undo restored anchors around art that was
   * still edited. Each edit is filed here with the undo depth it sat at, and
   * the hook below only reverts when z arrives back at that exact depth: a crop
   * followed by three moves takes four presses to reach, the way everything
   * else in the tool already behaves. */
  const pixelUndo = useRef<{ name: string; at: number }[]>([])
  /* WHETHER A PIXEL EDIT CHANGES EVERY COPY OR JUST THE ONE PICKED.
   *
   * These edits rewrite one library row and every placement of it draws from
   * that row, so the tool has always changed all of them at once. That is
   * genuinely useful when nineteen trees came off one generation and want the
   * same trim, and genuinely surprising when you selected one tree. It is off,
   * because the surprising answer should never be the default one. */
  const [editAll, setEditAll] = useState(false)
  /* The first take of a multi-take run that LANDED, held up for a yes.
   *
   * A moving sprite is nine generations, so four of them is thirty-six and
   * about half an hour. Finding out at the end that the first one was wrong
   * costs all of it. So the run pauses after the first, puts the actual picture
   * on the panel, and asks. The resolver is a ref because the loop is awaiting
   * it and a re-render must not mint a second promise.
   *
   * done is which take it is, not always one: a take that failed has no picture
   * to hold up, so the gate falls through to the next one rather than letting
   * the rest of the run past unseen. */
  const [gate, setGate] = useState<{ item: api.LibItem; done: number; total: number } | null>(null)
  const gateRef = useRef<((go: boolean) => void) | null>(null)
  // the confirmed static generate is waiting for a spot on the map
  const [genPick, setGenPick] = useState(false)
  // the add-door flow: armed for a map click, then which door's form is open
  // and whether that form is a fresh drop (cancel removes it) or a reopened
  // row (done is the only way out, the row's x removes)
  const [doorPick, setDoorPick] = useState(false)
  const [doorEdit, setDoorEdit] = useState(0)
  const [doorNew, setDoorNew] = useState(false)
  /* Renaming is held while it is being typed rather than applied per keystroke,
   * because a name is checked for uniqueness and legality and half a word is
   * neither. nameSaid carries back what the editor did with it. */
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [nameSaid, setNameSaid] = useState<{ id: number; why: string } | null>(null)
  // the effect box: the ask, the armed map click, the plan the click produced
  // and the params a human is tuning. fxFrames is the render, redone locally on
  // every slider move. Nothing here has touched the disk yet.
  const [fxAsk, setFxAsk] = useState('')
  const [fxPick, setFxPick] = useState(false)
  const [fxBusy, setFxBusy] = useState(false)
  const [fxSaving, setFxSaving] = useState(false)
  // set while the panel is reopened on an effect that already exists on disk:
  // save rewrites that item in place, save as new writes another one
  const [fxEdit, setFxEdit] = useState<api.LibItem | null>(null)
  // colors is the live ramp, the one that renders and the one that is written.
  // mapColors is what the click read off the painting and ownColors is the
  // effect's own, so the toggle can go back and forth without losing either.
  // custom is set only when the plan came back with a written renderer instead
  // of one of the seven, and ask is kept so a recipe that will not run can fall
  // back onto the closest built-in without asking the planner again.
  const [fx, setFx] = useState<FxState | null>(null)
  const [fxP, setFxP] = useState<EffectParams | null>(null)
  const [fxFrames, setFxFrames] = useState<HTMLCanvasElement[]>([])
  // the review loop, shown honestly while it runs: which pass it is on, what it
  // last said, and whether it is still going. null means it has not looked yet.
  const [fxRev, setFxRev] = useState<{ pass: number; why: string; running: boolean } | null>(null)
  // use this one: the loop reads this between passes and stops where it stands,
  // so he is never trapped waiting for a check he did not ask for
  const fxStop = useRef(false)
  // one quiet line under a written effect's preview: it rendered, but it does
  // not wrap. Not a block, because he may not care on a slow drift.
  const [fxNote, setFxNote] = useState('')
  // the recipe fold, so what was written for him is always one click away
  const [fxShow, setFxShow] = useState(false)
  // the recipe that has drawn something at least once. A knob turned somewhere
  // useless is not a broken recipe, so only one that has NEVER rendered gets
  // thrown away for a built-in.
  const fxRan = useRef('')
  const [growPx, setGrowPx] = useState(64)
  // the style card: what this map looks like, read off the painting once and
  // kept on disk. Its clause rides on every later ask, so a sprite comes back
  // in the map's family instead of the generator's own idea of the words.
  // Everything still works when it is not there.
  // the map's own colours, off the whole painting, for the palette lock
  const [mapPal, setMapPal] = useState<string[]>([])
  // the compare panel. raw is what came back; the matched side is rendered
  // locally at whatever the slider is on, and neither has been written yet.
  // ask and prompt are what made these, kept so a keep can be recorded. pick is
  // the one the tool chose after looking at all of them, and -1 when nothing
  // looked or when the look said none of them are it.
  const [pl, setPl] = useState<{
    mode: 'gen' | 'sel'
    selId: string
    items: PlItem[]
    ask: string
    prompt: string
    pick: number
  } | null>(null)
  /* WHAT THE TOOL SAW IN WHAT CAME BACK, and it belongs to the run rather than
   * to the compare panel, because most runs open no panel at all. A moving
   * object, a sprite and a whole planned set all landed unlooked-at while a
   * still object did not, and a thing that came back at the wrong angle is the
   * same thing whichever of the four made it.
   *
   * It is advice and it reads as advice: one line, never a block. Whatever it
   * says, the item is already in the library and stays there. fix is the only
   * part with money behind it, so it is a button and the button only fills the
   * box and reads the map again, both free. */
  const [said, setSaid] = useState<{ why: string; verdict: 'good' | 'revise'; fix: string } | null>(null)
  // the look itself, in flight. One flag for every path, so the stop button's
  // line has one thing to name however the run got here.
  const [looking, setLooking] = useState(false)
  const [plStr, setPlStr] = useState(80)
  const [plOut, setPlOut] = useState<HTMLCanvasElement[][]>([])
  const [plBusy, setPlBusy] = useState(false)
  const toastId = useRef(0)
  const lastSeq = useRef(0)
  const lastTool = useRef<Tool | null>(null)
  const hadPainting = useRef(false)
  const wasWalking = useRef(false)
  const stepRef = useRef<StepId>('load')
  stepRef.current = step

  const push = useCallback((text: string, act?: { label: string; run: () => void }) => {
    const id = ++toastId.current
    setToasts((prev) => [...prev.slice(-3), { id, text, act }])
    // a line offering to undo something has to outlive a glance at the map
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), act ? 12000 : 4200)
  }, [])

  // entering a step sets the view that shows that step's work, so nothing
  // can land behind a toggle
  const gotoStep = useCallback((s: StepId, keepTool = false) => {
    setStep(s)
    disarm()
    const e = edRef.current
    if (!e) return
    e.setAssetMode(s === 'assets')
    /* PAINTING BELONGS TO THE STEPS THAT PAINT. Cut and levels draw on the
     * map; load, test and export do not. The tool used to survive a step
     * change, so arriving at test with the bucket still armed from cut meant
     * one click cut a hole in the island. */
    e.setPaintable(s === 'cut' || s === 'levels' || s === 'assets')
    // the events overlay belongs to the steps that read it
    e.setEventsVisible(s === 'test' || s === 'export')
    if (s === 'cut') {
      e.setView({ cutPreview: true, mask: true })
      if (!keepTool && !isCutTool(e.tool)) e.setTool('cutfill')
    } else if (s === 'levels') {
      e.setView({ cutPreview: false, mask: true })
      if (!keepTool && (isCutTool(e.tool) || e.tool === 'occ')) e.setTool('region')
    } else if (s === 'assets') {
      // the cut preview is what the game gets, and the assets live on top of it
      e.setView({ cutPreview: true, mask: true })
    } else if (s === 'export') {
      e.setView({ cutPreview: true, mask: true })
    } else {
      e.setView({ cutPreview: false, mask: true })
    }
  }, [disarm])

  // ---- editor ----------------------------------------------------------
  useEffect(() => {
    const ed = new Editor()
    edRef.current = ed
    let pending: EditorStatus | null = null
    let queued = false
    ed.onStatus((s) => {
      pending = s
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        if (pending) setSt(pending)
      })
    })
    ed.attach(canvasRef.current as HTMLCanvasElement)
    setSt(ed.status())

    /* OPENING A MAP THAT ALREADY EXISTS.
     *
     * ?img= is how a painting has always been dropped in, and it stays. But a
     * map in the database has no ?img: the home page links to ?id=hub and the
     * painting is in object storage, so the editor has to go and get it. It
     * used to load nothing at all and say "no painting", which severed the
     * whole link between the dashboard and the tool.
     *
     * The scene is served at /work/<id>/scene.png, the same address the tool
     * has always used, which now resolves through the platform. */
    const q = new URLSearchParams(location.search)
    const img = q.get('img')
    const id = q.get('id')
    if (img) {
      void ed.loadPainting(img, id || slug(img.split('/').pop() || 'scene')).catch(() => ed.say('could not load ' + img))
    } else if (id) {
      const from = `/work/${encodeURIComponent(id)}/scene.png`
      void fetch(from, { method: 'HEAD' })
        .then((r) => {
          if (!r.ok) throw new Error('no painting saved for ' + id)
          return ed.loadPainting(from, id)
        })
        .catch(() => ed.say(`${id} has no painting yet · drop one in`))
    }

    return () => ed.detach()
  }, [])

  useEffect(() => {
    api
      .balance()
      .then((b) => setUsd(typeof b.usd === 'number' && b.usd > 0 ? `$${b.usd.toFixed(2)}` : ''))
      .catch(() => setUsd(''))
  }, [])

  const ed = edRef.current

  // every editor announcement becomes a toast: results can not land silently
  useEffect(() => {
    if (!st) return
    if (st.noteSeq !== lastSeq.current) {
      lastSeq.current = st.noteSeq
      if (st.note) push(st.note)
    }
  }, [st, push])

  // a keyboard tool change pulls the workflow to the step that owns the tool
  useEffect(() => {
    if (!st) return
    if (lastTool.current === null) {
      lastTool.current = st.tool
      return
    }
    if (st.tool !== lastTool.current) {
      lastTool.current = st.tool
      const home = homeStep(st.tool)
      if (home !== stepRef.current && !st.walking) gotoStep(home, true)
    }
  }, [st, gotoStep])

  // walking pulls the workflow into the test step
  useEffect(() => {
    if (!st) return
    if (st.walking && !wasWalking.current && stepRef.current !== 'test') gotoStep('test', true)
    wasWalking.current = st.walking
  }, [st, gotoStep])

  // a fresh painting advances the workflow and kicks the region pass
  const sceneKey = st && st.hasPainting ? `${st.sceneId}:${st.w}x${st.h}` : ''
  useEffect(() => {
    if (!sceneKey) {
      hadPainting.current = false
      return
    }
    if (!hadPainting.current && stepRef.current === 'load') {
      gotoStep('cut')
      push('painting loaded · now cut the sea')
    }
    hadPainting.current = true
    const e = edRef.current
    if (!e) return
    const pix = e.pixelsCopy()
    if (!pix) return
    let stale = false
    setRegionsBusy(true)
    e.setRegions(null, 0)
    computeRegions(pix, e.doc.W, e.doc.H)
      .then((r) => {
        if (stale) return
        e.setRegions(r.labels, r.count)
        setRegionsBusy(false)
        push(`${r.count} regions read · fill them in levels`)
      })
      .catch(() => {
        if (stale) return
        setRegionsBusy(false)
        push('regions failed · brush and poly still work')
      })
    return () => {
      stale = true
    }
  }, [sceneKey, gotoStep, push])

  // the library is PER MAP: it resets with the painting, and so does the
  // door form state
  useEffect(() => {
    setLib(null)
    setDoorPick(false)
    setDoorEdit(0)
    setDoorNew(false)
    // an effect is built out of one painting's colours, so it cannot survive
    // the painting changing under it
    setFx(null)
    setFxP(null)
    setFxFrames([])
    setFxPick(false)
    setFxEdit(null)
    setBust({})
    // the card and the colours belong to one painting, and so does anything
    // left waiting in the compare panel
    setMapPal([])
    setPl(null)
    setPlOut([])
    // a run paused on the gate is awaiting a promise nobody is left to answer,
    // so the swap answers it: no, and what was already drawn stays
    if (gateRef.current) {
      stopRef.current = true
      gateRef.current(false)
    }
  }, [sceneKey])

  // leaving the test step drops an armed door pick without spending it
  useEffect(() => {
    if (step !== 'test' && doorPick) {
      setDoorPick(false)
      edRef.current?.pickPoint(null)
    }
  }, [step, doorPick])

  // and leaving the assets step drops an armed effect click the same way
  useEffect(() => {
    if (step !== 'assets' && fxPick) {
      setFxPick(false)
      edRef.current?.pickPoint(null)
    }
  }, [step, fxPick])

  // this map's generated assets load the first time the assets step opens
  useEffect(() => {
    if (step !== 'assets' || lib !== null || !sceneKey) return
    const id = sceneKey.split(':')[0]
    api
      .library(id)
      .then((r) => {
        setLib(r.items)
        if (r.items.length) push(`${r.items.length} asset${r.items.length === 1 ? '' : 's'} in the library`)
      })
      .catch(() => {
        setLib([])
        push('library did not load · is the server up?')
      })
    // the words he typed, alongside the things they made
    api
      .asks(id)
      .then((r) => setAsks(r.asks))
      .catch(() => setAsks([]))
  }, [step, lib, sceneKey, push])

  /* The style card is gone from this path, and it is worth saying why it was
   * ever here. The map used to be read ONCE per scene, compressed to eighteen
   * words, and those words stapled onto every later prompt. On the hub island
   * the honest answer came back as "warm sandy-tan and earthy-brown palette,
   * cool grey stone" — true of the map, and a materials list for a plinth. Then
   * a filter was added to strip those words, then a pixel trimmer to cut the
   * plinth off anyway. Four stages, all of them paying interest on the same
   * mistake: describing a picture in text to a model that can look at it.
   *
   * Now every ask carries the painting itself. What is still read here is the
   * map's COLOURS, which is local, free, instant, and used by the palette lock
   * rather than by any prompt. */
  useEffect(() => {
    if (step !== 'assets' || !sceneKey) return
    const e = edRef.current
    if (!e) return
    setMapPal(readMapPalette(e))
  }, [step, sceneKey])

  // ---- the assets step -------------------------------------------------
  // leave the click-where-it-goes wait without spending anything. Both waits
  // share one picker, so arming either one has to drop the other.
  const stopPick = useCallback(() => {
    setGenPick(false)
    setFxPick(false)
    edRef.current?.pickPoint(null)
  }, [])

  /* The answer to the gate. stop sets the run's flag BEFORE it resolves, so the
   * loop's own break and the flag it checks at the top of the next turn agree
   * with each other. Nothing already drawn is thrown away: it is paid for and
   * it stays in the library. */
  const closeGate = useCallback((go: boolean) => {
    if (!go) {
      stopRef.current = true
      const j = jobRef.current
      if (j) void api.stop(j).catch(() => {})
    }
    gateRef.current?.(go)
  }, [])

  // ---- picking from what he already owns --------------------------------
  // The account holds hundreds of objects and the ones written in the house
  // style are better than what a fresh ask comes back with, so browsing them
  // is the first thing offered and generating is the second. Every call on
  // this path is a read: the listing, the thumbnails, and the copy.

  const accLoad = useCallback(
    async (q: string, page: number) => {
      setAcc((a) => ({ ...a, busy: true, err: '' }))
      try {
        const r = await api.accountObjects(page, q)
        setAcc((a) => ({ ...a, busy: false, items: r.items, total: r.total, pages: r.pages, page: r.page }))
      } catch (err) {
        setAcc((a) => ({
          ...a,
          busy: false,
          items: [],
          err: String(err instanceof Error ? err.message : err).slice(0, 120),
        }))
      }
    },
    [],
  )

  // the people half, read once per session. Free, like the objects listing.
  useEffect(() => {
    if (!acc.open || accTab !== 'sprites' || chars) return
    setChars({ items: [], busy: true, err: '' })
    api
      .accountCharacters()
      .then((r) => setChars({ items: r.items, busy: false, err: '' }))
      .catch((e) => setChars({ items: [], busy: false, err: String(e instanceof Error ? e.message : e).slice(0, 120) }))
  }, [acc.open, accTab, chars])

  /* one character into this map's library, with its walk cycle if it has one */
  const takeCharacter = useCallback(
    async (c: api.AccountCharacter) => {
      const e = edRef.current
      if (!e || acc.taking) return
      setAcc((a) => ({ ...a, taking: c.id }))
      try {
        const r = await api.characterImport(c.id, e.sceneId, { name: c.name })
        setLib((prev) => [...(prev || []).filter((x) => x.name !== r.item.name), r.item])
        setAcc((a) => ({ ...a, taking: '', open: false }))
        push(
          `${r.item.name} added · ${Object.keys(r.item.dirs || {}).length} ways` +
            `${(r.item.dirs?.south?.length || 1) > 1 ? ', walking' : ''} · click it, then the map`,
        )
      } catch (err) {
        setAcc((a) => ({ ...a, taking: '' }))
        push('that one did not come over · ' + String(err instanceof Error ? err.message : err).slice(0, 120))
      }
    },
    [acc.taking, push],
  )

  // the clock under the sprite button. One second is enough resolution for
  // a wait measured in minutes.
  useEffect(() => {
    if (!charRun) {
      setCharSecs(0)
      return
    }
    setCharSecs(0)
    const t = window.setInterval(() => setCharSecs(Math.round((Date.now() - charRun.at) / 1000)), 1000)
    return () => window.clearInterval(t)
  }, [charRun])

  // the same clock under the animate button, for the same reason: eight
  // headings is minutes and a label that never moves reads as a hang
  useEffect(() => {
    if (!animRun) {
      setAnimSecs(0)
      return
    }
    setAnimSecs(0)
    const t = window.setInterval(() => setAnimSecs(Math.round((Date.now() - animRun.at) / 1000)), 1000)
    return () => window.clearInterval(t)
  }, [animRun])

  /* A plan is a price for ONE item. Picking a different thing drops it, or the
   * armed button would still be lit and the next press would buy the last
   * item's plan against this one's name. */
  const animSel = st?.assetSel ?? ''
  useEffect(() => {
    setAnimOpen(false)
    setAnimPlan(null)
    setAnimNote('')
  }, [animSel])

  /* THE ONE LOOK AT WHAT A RUN CAME BACK WITH, and the only caller of the
   * review route.
   *
   * Free, every time: the strip is written locally and the look never touches
   * pixellab. It runs at the end of every run whatever was made, because a
   * moving object, a sprite and a whole planned set all landed unlooked-at
   * while a still object did not, and a thing that came back at the wrong
   * angle is the same thing whichever of the four drew it.
   *
   * What it answers is advice. The items are already paid for and already in
   * the library, so nothing here removes one, and a look that fails or is
   * stopped costs the run nothing. It returns the verdict for the compare
   * panel to preselect from, and it writes the line either way. */
  const lookAt = useCallback(
    async (sid: string, ask: string, prompt: string, all: api.LibItem[]): Promise<api.ObjVerdict | null> => {
      // the sheet holds six, so six is what gets sent. Cut here rather than at
      // the far end, so what the words name is what the picture shows.
      const made = all.slice(0, LOOK_CELLS)
      if (!made.length) return null
      setSaid(null)
      setLooking(true)
      // one line rather than silence when the look cannot happen. It used to
      // return having said nothing, which is indistinguishable from a look that
      // ran and approved.
      const quiet = (why: string) => {
        setLooking(false)
        setSaid({ why, verdict: 'good', fix: '' })
        return null
      }
      let shots: string[] = []
      try {
        const cans = await Promise.all(made.map(async (it) => (await framesOf(it))[0]))
        // one candidate that will not decode would shift every index, and then
        // "the second one" would name the wrong sprite: skip the look instead
        if (cans.some((c) => !c)) return quiet('did not look · one of these would not decode')
        shots = cans.map((c) => c.toDataURL('image/png'))
      } catch {
        return quiet('did not look · those pixels would not decode')
      }
      // the look runs after the spend, so the job that bought them is finished
      // and stop has nothing to post against. It gets its own.
      const job = newJob('look')
      jobRef.current = job
      /* HOW BIG THEY REALLY ARE, which is half of what the look is for: a thing
       * drawn at a finer pixel than the map reads as pasted on, and that cannot
       * be judged off a strip blown up 3x without being told the real number.
       * Read off what actually landed rather than threaded down from three
       * callers. Sent only when every candidate agrees: a run of takes shares
       * one size, a planned set does not, and a wrong number is worse than
       * none. */
      const w = made[0].w
      const h = made[0].h
      const oneSize = w > 0 && h > 0 && made.every((m) => m.w === w && m.h === h)
      try {
        const v = await api.objReview({ id: sid, ask, prompt, frames: shots, job, ...(oneSize ? { w, h } : {}) })
        setLooking(false)
        // anything that is not the word revise is good, the same default the
        // effect loop takes, so a server that has not been given a verdict yet
        // still says its line and nothing else changes
        setSaid({ why: v.why, verdict: v.verdict === 'revise' ? 'revise' : 'good', fix: v.fix || '' })
        return v
      } catch {
        setLooking(false)
        return null
      }
    },
    [],
  )

  /* Hold a run after the first thing that landed and put the actual picture on
   * the panel. Answers whether to carry on.
   *
   * This is the whole reason the take slider can go to eight and the fill
   * slider to twenty-four. A moving sprite is nine generations and the best
   * part of five minutes, so four of them is half an hour, and finding out at
   * the end that the first one was wrong costs every minute of it. What has
   * already been drawn is in the library before this opens, so a no here throws
   * nothing away. */
  const askGate = useCallback(async (item: api.LibItem, done: number, total: number) => {
    setGate({ item, done, total })
    const go = await new Promise<boolean>((res) => {
      gateRef.current = res
    })
    gateRef.current = null
    setGate(null)
    return go
  }, [])

  /* Sprites made to order, after the price has been confirmed.
   *
   * Nothing here was chosen off a control. The skeleton, the view, the size and
   * what moving MEANS for this thing all came back in the plan the button
   * showed, so a dragon can hover and a robot can stand its servos idling
   * without either of them being on a list somewhere.
   *
   * One request holds one whole take: the body, then the motion run once per
   * direction. Stopping is still worth having even though the body is paid for
   * the moment it is asked for, because a stop that lands in the minutes before
   * the motion keeps eight generations from ever being asked for. So the run
   * carries a job id like the planners do, and every take reuses it: the
   * requests are sequential, so there is never two of them registered at once.
   *
   * A scene swap mid-run drops the result rather than filing it under the wrong
   * map, the same as every other spend here.
   */
  const runSpriteGen = useCallback(
    async (p: string, plan: api.MakePlan) => {
      const e = edRef.current
      const route = plan.sprite
      if (!e || !route || charRun) return
      const sid = e.sceneId
      const job = newJob('gen')
      jobRef.current = job
      stopRef.current = false
      const seed0 = 1 + Math.floor(Math.random() * 1e9)
      const runs: { name?: string; seed?: number }[] =
        genCount > 1
          ? Array.from({ length: genCount }, (_, i) => ({ name: `${slug(p)}-${i + 1}`, seed: seed0 + i + 1 }))
          : [{}]
      const moves = route.anim.how !== 'none'
      setCharRun({ at: Date.now() })
      setGenRun({ done: 0, total: runs.length })
      // what the last run came back with is not what this one is drawing
      setSaid(null)
      const made: api.LibItem[] = []
      // asked once per run, and only once something is on screen to ask about
      let gated = false
      try {
        for (let i = 0; i < runs.length; i++) {
          if (e.sceneId !== sid || stopRef.current) break
          e.setBusy(
            runs.length > 1
              ? `sprite ${i + 1}/${runs.length}`
              : moves
                ? 'drawing it, then the motion'
                : 'drawing it',
          )
          try {
            const r = await api.characterGen(sid, {
              description: plan.prompt,
              // the server will not spend without this, and only the confirmed
              // press sends it
              confirm: true,
              job,
              ...runs[i],
              size: route.size,
              view: route.view,
              skeleton: route.skeleton,
              nDirections: CHAR_DIRS,
              anim: route.anim,
              mode: 'standard',
            })
            if (e.sceneId !== sid) break
            setLib((prev) => [...(prev || []).filter((x) => x.name !== r.item.name), r.item])
            made.push(r.item)
            // a motion that did not happen is said out loud. It still lands,
            // standing, because the body was bought before the motion was ever
            // asked for.
            if (r.note) push(`${r.item.name} · ${r.note}`)
            /* THE REST OF THE ASK, in the order that works.
             *
             * "a troll that curls into a boulder and rolls around" is one
             * sentence and three jobs: a body, a second face, and a round. The
             * router already split them, and doing them here means nobody has
             * to learn that the faces have to exist before the round can name
             * one. That ordering rule is real and it is not written on any
             * button, so it belongs on this side of the screen.
             *
             * A face that fails does not take the body down with it. The body
             * is bought and on disk, the failure is said out loud, and the
             * round still runs against whatever faces did land. */
            let owner = r.item
            for (const f of plan.faces || []) {
              if (e.sceneId !== sid || stopRef.current) break
              e.setBusy(`drawing "${f.name}"`)
              try {
                const fr = await api.assetState(sid, owner.name, f.edit, { state: f.name, job })
                if (fr.item) {
                  owner = fr.item
                  setLib((prev) => [...(prev || []).filter((x) => x.name !== fr.item!.name), fr.item!])
                }
                push(`${owner.name} can now be "${fr.face}"`)
              } catch (err) {
                const m = String(err instanceof Error ? err.message : err)
                push(m.includes('stopped') ? 'stopped before the faces' : `"${f.name}" did not draw · ` + m.slice(0, 90))
              }
            }
            /* and the round, which is free and therefore always worth trying.
             * It is held on the plan rather than applied here: nothing has been
             * placed on the map yet, so there is no placement to give it to.
             * The moment one is put down it gets this, and the person never
             * types the sentence twice. */
            if (plan.does) {
              pendingLife.current = { name: owner.name, ask: plan.does }
              push(`put it down and it will ${plan.does.slice(0, 60)}${plan.does.length > 60 ? '…' : ''}`)
            }
          } catch (err) {
            const m = String(err instanceof Error ? err.message : err)
            push(
              m.includes('stopped')
                ? 'stopped · the body was already paid for, the motion was not asked for'
                : 'that one did not come back · ' + m.slice(0, 120),
            )
          }
          setGenRun({ done: i + 1, total: runs.length })
          /* After the first take that LANDED, not after the first attempt.
           *
           * Keying this on i === 0 meant a take that failed took the gate with
           * it, and the other seven ran unseen: at nine generations each that
           * is sixty-three nobody looked at, which is the one thing this whole
           * feature exists to stop. i < last is the other half, because asking
           * when there is nothing left to buy is a card with no question in
           * it. */
          if (!gated && made.length && i < runs.length - 1 && !stopRef.current) {
            gated = true
            if (!(await askGate(made[0], i + 1, runs.length))) break
          }
        }
      } finally {
        setCharRun(null)
        setGenRun(null)
        edRef.current?.setBusy('')
      }
      if (!made.length) return
      setGenPrompt('')
      api
        .asks(sid)
        .then((q) => setAsks(q.asks))
        .catch(() => {})
      const ways = Object.keys(made[0].dirs || {}).length
      push(
        stopRef.current && made.length < runs.length
          ? `stopped after ${made.length} of ${runs.length} · ${made.length === 1 ? 'it stays' : 'they stay'}`
          : made.length === 1
            ? `${made[0].name} added · ${ways} ways${moves ? ', moving' : ''} · click it, then the map`
            : `${made.length} sprites added · click one, then the map`,
      )
      // the same free look every other run gets. A sprite is the most expensive
      // thing here and it was the least checked: nine generations came back and
      // nothing said whether the body was the one that was asked for.
      void lookAt(sid, p, plan.prompt, made)
    },
    [genCount, charRun, askGate, lookAt, push],
  )

  // the search box, one call behind the typing so a full listing is not walked
  // per keystroke
  useEffect(() => {
    if (!acc.open) return
    const t = window.setTimeout(() => void accLoad(acc.q, acc.page), acc.q ? 260 : 0)
    return () => window.clearTimeout(t)
  }, [acc.open, acc.q, acc.page, accLoad])

  // one of his own objects copied into this map's library, then closed. It
  // lands as a normal static item, so placing it is the same click as anything
  // else in the library.
  const takeAccount = useCallback(
    async (o: api.AccountObject) => {
      const e = edRef.current
      if (!e || acc.taking) return
      setAcc((a) => ({ ...a, taking: o.id }))
      try {
        const r = await api.accountImport(o.id, e.sceneId, o.name)
        setLib((prev) => [...(prev || []).filter((x) => x.name !== r.item.name), r.item])
        setAcc((a) => ({ ...a, taking: '', open: false }))
        push(`${r.item.name} added · click it, then the map`)
      } catch (err) {
        setAcc((a) => ({ ...a, taking: '' }))
        push('that one did not come over · ' + String(err instanceof Error ? err.message : err).slice(0, 120))
      }
    },
    [acc.taking, push],
  )

  // ---- the palette lock ------------------------------------------------
  // Nothing here is ever applied quietly. The raw take and the matched one sit
  // side by side and a human says which goes in the library; both are already
  // on the client, so every button on the panel is free.

  // the matched frames, redone on every slider move. A sprite holds a few
  // dozen distinct colours, so a whole batch re-renders inside one frame.
  useEffect(() => {
    if (!pl || !mapPal.length) {
      setPlOut([])
      return
    }
    try {
      setPlOut(pl.items.map((it) => it.raw.map((c) => matchCanvas(c, mapPal, plStr / 100))))
    } catch {
      setPlOut([])
    }
  }, [pl, plStr, mapPal])

  const closeMatch = useCallback(() => {
    setPl(null)
    setPlOut([])
    // the line under the button and the line in the panel are the same words,
    // so closing the panel must not make them reappear somewhere else
    setSaid(null)
  }, [])

  // one thing he KEPT, on the record for this map. Fire and forget: it shapes
  // the next ask and nothing waits on it. Only keeps go in, never discards.
  const noteKeep = useCallback(
    (id: string, ask: string, prompt: string, name: string, kind: 'asset' | 'effect') => {
      if (!ask.trim()) return
      api.keepNote(id, { ask, prompt, name, kind }).catch(() => {})
    },
    [],
  )

  // open the compare on library items: a fresh static generate hands in what
  // it made, the inspector hands in the one item behind the selected placement
  /* Cut the pedestal the generator keeps standing things on.
   *
   * No words can stop it, because every way of saying "no ground" hands the
   * generator the word ground: measured on his palm, which came back on a
   * stone slab under a prompt that refused ground four times. So it comes off
   * afterwards, by arithmetic, free, and in place. */
  const doDebase = useCallback(
    async (item: api.LibItem, placeId: string): Promise<boolean> => {
      const e = edRef.current
      if (!e) return false
      try {
        const frames = await framesOf(item)
        if (!frames.length) return false
        const cut: string[] = []
        let rows = 0
        let note = ''
        for (const c of frames) {
          const g = c.getContext('2d') as CanvasRenderingContext2D
          const img = g.getImageData(0, 0, c.width, c.height)
          const r = debase(img.data, c.width, c.height)
          if (!rows) {
            rows = r.cut
            note = r.note
          }
          const out = mkCanvas(c.width, c.height)
          const og = out.getContext('2d') as CanvasRenderingContext2D
          // write through a fresh ImageData the context owns, so the buffer
          // type is whatever this browser wants rather than whatever we made
          const dst = og.createImageData(c.width, c.height)
          dst.data.set(r.data)
          og.putImageData(dst, 0, 0)
          cut.push(out.toDataURL('image/png'))
        }
        if (!rows) {
          push('no base found · ' + note)
          return false
        }
        // in place, under the same name: the trim erases rows rather than
        // cropping them, so the png is the same size and every placement of it
        // simply loses its slab
        const r = await api.assetCrop(e.sceneId, item.name, null, {
          kind: item.kind,
          frames: cut,
          fps: item.fps,
          // eight-sided art is trimmed on every view and written back under the
          // view names, not as animation frames
          dirKeys: partsOf(item).keys,
        })
        setLib((prev) => [...(prev || []).filter((x) => x.name !== r.item.name), r.item])
        e.bustAssets(folderOf(r.item))
        setBust((q) => ({ ...q, [r.item.name]: Date.now() }))
        e.refreshPlacementsOf(r.item)
        void placeId
        saidEdit(r.item.name, `base off · ${note}`, e.doc.assets.filter((q) => assetLabel(q) === r.item.name).length)
        return true
      } catch (err) {
        push('could not trim it · ' + String(err instanceof Error ? err.message : err).slice(0, 80))
        return false
      }
    },
    [push],
  )

  /* ctrl+t on a whole selection.
   *
   * The pixels are shared, so this works per ITEM, not per placement: forty
   * palms off one png are one trim, not forty. Items that turn out to have no
   * base are counted and said out loud rather than silently skipped, because
   * "nothing happened" is the one outcome that reads as a broken key. */
  const doTrim = useCallback(
    async (ids: string[]) => {
      const e = edRef.current
      if (!e || !ids.length) return
      const items = new Map<string, api.LibItem>()
      for (const id of ids) {
        const a = e.doc.assets.find((q) => q.id === id)
        if (!a) continue
        const it = (lib || []).find((x) => x.name === assetLabel(a))
        if (it) items.set(it.name, it)
      }
      if (!items.size) {
        push('click an asset first')
        return
      }
      if (items.size === 1) {
        await doDebase([...items.values()][0], ids[0])
        return
      }
      e.setBusy('trimming')
      let cut = 0
      for (const it of items.values()) if (await doDebase(it, '')) cut++
      e.setBusy('')
      push(cut ? `${cut} of ${items.size} trimmed` : `no base found on any of the ${items.size}`)
    },
    [lib, doDebase, push],
  )

  /* Drop the picked placements to the map's own pixel size.
   *
   * The amount is not a setting. A sprite drawn at a quarter of its size has
   * four of its pixels inside every map pixel, so it carries detail the
   * painting does not have and reads as a sticker stuck on top. Reduced by that
   * same four and stood back at scale 1, one of its pixels is one of the map's.
   * The placement holds the answer, so nothing has to be guessed or typed.
   *
   * Placements sharing an item AND a factor share one new png: forty palms at
   * the same scale write one file, not forty. Originals are never touched, so a
   * result you dislike costs one z.
   */
  const doBitify = useCallback(
    async (ids: string[]) => {
      const e = edRef.current
      if (!e || !ids.length) return
      const jobs = new Map<string, { item: api.LibItem; f: number; tw: number; th: number; places: string[] }>()
      const skipped: string[] = []
      for (const id of ids) {
        const a = e.doc.assets.find((q) => q.id === id)
        if (!a) continue
        const name = assetLabel(a)
        const item = (lib || []).find((it) => it.name === name)
        if (!item) continue
        /* grain is how many of the sprite's pixels sit inside one map pixel
         * when this is done. 1 is the strict match and it is the blockiest
         * thing possible, because where a palm stands the map itself only has
         * 24 by 32 pixels to spend. 2 keeps twice that and reads chunky
         * without going to bricks, which is why it is the default. */
        const tw = Math.max(1, Math.round(item.w * Math.abs(a.sx) * grain))
        const th = Math.max(1, Math.round(item.h * Math.abs(a.sy) * grain))
        // One item, one size: the pixels are rewritten under the item's own
        // name, so two placements of the same palm at different scales cannot
        // ask for two different results. The BIGGEST of them wins, because
        // shrinking a sprite the little one needed would cost the big one
        // detail it was using.
        const j = jobs.get(name)
        if (j) {
          j.places.push(id)
          j.tw = Math.max(j.tw, tw)
          j.th = Math.max(j.th, th)
          continue
        }
        if (bitFactor(item.w, item.h, tw, th) < 1.25) {
          skipped.push(name)
          continue
        }
        jobs.set(name, { item, f: 0, tw, th, places: [id] })
      }
      if (!jobs.size) {
        push(skipped.length ? 'already at the map’s size · nothing to pixelate' : 'click an asset first')
        return
      }
      e.setBusy('pixelating')
      let done = 0
      let note = ''
      try {
        for (const { item, tw, th, places } of jobs.values()) {
          void places
          const urls = partsOf(item).urls
          if (!urls.length || !urls[0]) continue
          const imgs = await Promise.all(urls.map((u) => loadImage(u)))
          const out: string[] = []
          for (const img of imgs) {
            const c = mkCanvas(img.naturalWidth, img.naturalHeight)
            const g = c.getContext('2d') as CanvasRenderingContext2D
            g.imageSmoothingEnabled = false
            g.drawImage(img, 0, 0)
            // every frame goes down to the SAME size, so an animation's loop
            // stays in register instead of jittering by a pixel
            const r = bitify(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, tw, th)
            note = r.note
            const dc = mkCanvas(r.width, r.height)
            const dg = dc.getContext('2d') as CanvasRenderingContext2D
            const dst = dg.createImageData(r.width, r.height)
            dst.data.set(r.data)
            dg.putImageData(dst, 0, 0)
            out.push(dc.toDataURL('image/png'))
          }
          const res = await api.assetCrop(e.sceneId, item.name, null, {
            kind: item.kind,
            frames: out,
            fps: item.fps,
            dirKeys: partsOf(item).keys,
          })
          setLib((prev) => [...(prev || []).filter((x) => x.name !== res.item.name), res.item])
          // the png kept its name, so the browser would answer from cache and
          // the map would go on drawing the old pixels
          e.bustAssets(folderOf(res.item))
          setBust((q) => ({ ...q, [res.item.name]: Date.now() }))
          // it shrank, so EVERY placement of it grows by the same amount to
          // stay the size it was — including ones that were never selected,
          // because they are all looking at the one file
          const n = e.rescalePlacementsOf(res.item, item.w / res.item.w, item.h / res.item.h)
          e.refreshPlacementsOf(res.item)
          done += n || places.length
        }
        push(
          `${done} pixelated · ${note}${skipped.length ? ` · ${skipped.length} left alone` : ''} · z undoes`,
        )
      } catch (err) {
        push('could not pixelate · ' + String(err instanceof Error ? err.message : err).slice(0, 90))
      } finally {
        e.setBusy('')
      }
    },
    [lib, grain, push],
  )

  /* the words, then the fence, then the answer. The placement is pinned by id
   * up front: drawing the box clears the selection, so anything reading it
   * live would lose its subject halfway through. */
  /* ONE generation: this thing, edited into another face.
   *
   * It is deliberately not the sparkle's job. The sparkle is free and describes
   * a round; this spends and draws a picture. Sharing a box would have put a
   * cost behind a button that has never had one.
   *
   * The order matters and the ui does not have to explain it, because the face
   * has to exist before a round can name it. Make the faces, then describe what
   * it does. */
  const runFace = useCallback(
    async (name: string) => {
      const e = edRef.current
      if (!e || faceBusy || !faceAsk.trim()) return
      const job = newJob('face')
      jobRef.current = job
      setFaceBusy(true)
      e.setBusy('drawing another face')
      try {
        const r = await api.assetState(e.sceneId, name, faceAsk.trim(), { job })
        if (r.item) setLib((prev) => [...(prev || []).filter((x) => x.name !== r.item!.name), r.item!])
        setFaceAsk('')
        setFaceOpen(false)
        push(`${name} can now be "${r.face}" · say so in the sparkle to use it`)
      } catch (err) {
        const m = String(err instanceof Error ? err.message : err)
        push(m.includes('stopped') ? 'stopped' : 'could not draw that · ' + m.slice(0, 90))
      } finally {
        setFaceBusy(false)
        e.setBusy('')
      }
    },
    [faceAsk, faceBusy, push],
  )

  const runLife = useCallback(
    /* said is for the round that came out of the make ask and is waiting for
     * something to land on. Everything else reads the box, as it always has. */
    async (placeId: string, said?: string) => {
      const e = edRef.current
      const ask = (said || lifeAsk).trim()
      if (!e || !ask || lifeBusy) return
      const a = e.doc.assets.find((q) => q.id === placeId)
      if (!a) return
      const item = (lib || []).find((x) => x.name === assetLabel(a))
      const map = e.cutSceneDataURL()
      if (!map) {
        push('no painting to read')
        return
      }
      /* Taken NOW, for the same reason placeId is. markArea does not answer
       * until a box has been drawn on the canvas, and drawing on the canvas is
       * itself a selection gesture, so by the time the callback runs the set
       * that was picked is down to one. */
      const ids = e.selIds().includes(placeId) ? e.selIds() : [placeId]
      e.markArea(async (bounds) => {
        const job = 'life-' + Date.now()
        jobRef.current = job
        stopRef.current = false
        setLifeBusy(true)
        /* THE 35% LAW. A box drawn mostly over walkable ground means a path or
         * a plaza was fenced, so the floor becomes a second barrier and the
         * thing keeps to it. Mostly not walkable means a region was fenced
         * regardless of ground, and the box alone holds. */
        const walkPct = bounds ? e.walkFraction(bounds) : 0
        const walkOnly = !!bounds && walkPct >= 0.35
        e.setBusy(bounds ? 'working out how it moves in there' : 'working out how it moves')
        try {
          const r = await api.lifePlan(e.sceneId, ask, {
            map,
            mapW: e.doc.W,
            mapH: e.doc.H,
            name: assetLabel(a),
            at: { x: a.x, y: a.y },
            size: item ? { w: item.w, h: item.h } : undefined,
            bounds,
            walkPct: bounds ? walkPct : undefined,
            walkOnly,
            // what it is allowed to name when it wants the picture to change.
            // The server picks out of this list and nothing else, so a sequence
            // cannot ask for a boulder this map has never had.
            names: (lib || []).map((x) => x.name),
            // the row this placement is drawn from. If it has faces of its own
            // the server offers those instead of the whole library.
            owner: item ? item.name : undefined,
            job,
          })
          if (stopRef.current) return
          /* The fence goes IN, not on afterwards.
           *
           * These three were stamped onto the finished object, which meant
           * cleanLife had already built every state inside it believing there
           * was no floor, and a round then walked straight off the path. Passed
           * in, the states are built knowing. lifeAt carries a guard for the
           * same thing so bundles already on disk still fence; this is the
           * source of it. */
          const life = cleanLife({
            ...(r.life as Record<string, unknown>),
            ...(bounds ? { bounds, walkPct } : {}),
            ...(walkOnly ? { walkOnly: true } : {}),
          })
          if (!life) throw new Error('that did not come back as movement')
          /* The pictures a sequence switches between, resolved from names to
           * the pixels they stand for.
           *
           * art counts through this list and index 0 is the placement's own,
           * which lookOf answers off the placement itself, so only 1 and up are
           * written down. A name this browser's library has not caught up with
           * sends its state back to picture 0 rather than being dropped out of
           * the list: dropping one shifts every later index down by one, and a
           * troll/boulder/troll then draws the third picture where the second
           * was meant. */
          const named = Array.isArray(r.looks) ? r.looks.slice(0, 8) : []
          const looks: AssetLook[] = []
          const artAt = [0]
          for (const nm of named.slice(1)) {
            /* THIS THING'S OWN FACES FIRST, and the library only after.
             *
             * A face belongs to the row that owns it, so it is the only place
             * a name can mean exactly one picture. The library is the fallback
             * for a row with no faces — everything imported off the account,
             * everything made before faces existed — and it is where the old
             * ambiguity lived: three boulders on a map and no way to know which
             * one was meant. Looking here first is what retires that. */
            const face = (item?.states || []).find((f) => f.name === nm)
            const row = face ? null : (lib || []).find((x) => x.name === nm)
            if (!face && !row) {
              artAt.push(0)
              continue
            }
            looks.push(face ? lookOfState(face) : lookOfItem(row!))
            // looks[0] is art 1, so the length after the push IS the index
            artAt.push(looks.length)
          }
          if (life.states) for (const s of life.states) s.art = artAt[s.art || 0] || 0
          const swaps = looks.length ? ` · changes into ${looks.length} other picture${looks.length > 1 ? 's' : ''}` : ''
          // a name that went missing is said out loud, because a picture that
          // quietly stays put is exactly what this whole lane looked like while
          // it was broken
          const missed = named.length - 1 - looks.length
          const gone = missed > 0 ? ` · ${missed} not in the library, left as it was` : ''
          /* One ask, everything picked. A market is one place and the crowd in
           * it shares the box; what they do not share is the seed and the phase,
           * or a dozen figures step in perfect time and read as one thing. */
          const n = ids.length > 1 ? e.setLifeMany(ids, life, looks) : (e.setLife(placeId, life, looks), 1)
          setLifeNote(r.note || '')
          setLifeOpen(false)
          setLifeAsk('')
          push(
            (r.note || `${n > 1 ? `${n} are moving` : `${assetLabel(a)} is moving`}`) +
              swaps +
              gone +
              (walkOnly ? ` · keeps to the floor (${Math.round(walkPct * 100)}% walkable)` : '') +
              ' · z undoes',
          )
        } catch (err) {
          const m = String(err instanceof Error ? err.message : err)
          push(m.includes('stopped') ? 'stopped' : 'could not work that out · ' + m.slice(0, 90))
        } finally {
          setLifeBusy(false)
          e.setBusy('')
        }
      })
      push('draw where it may roam · esc to leave it unfenced')
    },
    [lifeAsk, lifeBusy, lib, push],
  )

  /* HAND THE WAITING ROUND TO THE FIRST THING PLACED.
   *
   * The drawing finishes long before anything is on the map, so a round that
   * came out of the same sentence has nothing to be applied to yet. It waits in
   * pendingLife and lands here, once, on the first placement of that item that
   * does not already move. Then it is cleared, so putting a second one down
   * does not silently re-run a free call nobody asked for.
   *
   * Watching the placement list rather than hooking the click keeps this out of
   * editor.ts, which does not otherwise know that asks exist. */
  useEffect(() => {
    const want = pendingLife.current
    if (!want || lifeBusy) return
    const hit = (st?.assets ?? []).find((a) => assetLabel(a) === want.name && !a.life)
    if (!hit) return
    pendingLife.current = null
    void runLife(hit.id, want.ask)
  }, [st?.assets, lifeBusy, runLife])


  /* Two presses, on a thing that is already in the library.
   *
   * FIRST press is free and buys nothing. The server looks at what the item IS
   * on disk, which is one png or a folder of frames or eight headings, and at
   * the words, and answers how it would do it and exactly what that costs.
   * There are four answers at 0, 1, one-per-heading and no, so the price cannot
   * be worked out on this side and the button refuses to arm over a guess.
   *
   * SECOND press spends precisely the number the button was showing. The frames
   * land back under the same name, so every placement of that thing starts
   * moving without being touched and the library keeps one row.
   *
   * A stop is worth pressing even after the first heading is paid for, because
   * seven more are queued behind it. Whatever landed stays; stopping never
   * undoes. */
  const doAnim = useCallback(
    async (item: api.LibItem) => {
      const e = edRef.current
      const ask = animAsk.trim()
      if (!e || !ask || animBusy || animRun) return
      const sid = e.sceneId

      if (!animPlan) {
        const job = newJob('anim')
        jobRef.current = job
        stopRef.current = false
        setAnimBusy(true)
        e.setBusy('reading what it should do')
        try {
          const r = await api.assetAnimate(sid, { name: item.name, ask, job })
          if (stopRef.current || !r.plan) return
          setAnimPlan(r.plan)
          push(
            r.plan.path === 'blocked'
              ? r.plan.why || 'that cannot be done to this one'
              : (r.plan.note || r.plan.motion) + ' · press again',
          )
        } catch (err) {
          const m = String(err instanceof Error ? err.message : err)
          push(m.includes('stopped') ? 'stopped' : 'could not read that · ' + m.slice(0, 90))
        } finally {
          setAnimBusy(false)
          e.setBusy('')
        }
        return
      }

      const plan = animPlan
      // nothing to buy and nothing to draw here. Saying no is the answer, and
      // the button never arms over it.
      if (plan.path === 'blocked') return
      /* The free path never posts.
       *
       * Travelling is the one thing neither animator can do: both redraw a
       * sprite where it stands, so a crab asked to scatter comes back scuttling
       * on the spot for real money. The recipe engine already does travel for
       * nothing, so the words are carried across to it rather than spent here. */
      if (plan.path === 'written') {
        setAnimPlan(null)
        setAnimOpen(false)
        setFxAsk(plan.motion || ask)
        setMakeWhat('effect')
        stopPick()
        push(
          (plan.note || 'this one has to travel, so it is written rather than drawn') +
            ' · free · the words are in the motion box',
        )
        return
      }

      setAnimPlan(null)
      const job = newJob('anim')
      jobRef.current = job
      stopRef.current = false
      setAnimRun({ at: Date.now(), plan })
      e.setBusy(`animating ${item.name}`)
      try {
        const r = await api.assetAnimate(sid, { name: item.name, ask, plan, confirm: true, job })
        // a scene swap mid-run would file the result under the wrong map
        if (e.sceneId !== sid || !r.item) return
        const next = r.item
        setLib((prev) => [...(prev || []).filter((x) => x.name !== next.name), next])
        // same names, new bytes: without this the editor answers every draw out
        // of the frames it already cached
        e.bustAssets(folderOf(next))
        setBust((q) => ({ ...q, [next.name]: Date.now() }))
        /* pixellab pads a canvas to leave the motion somewhere to go, so what
         * comes back is rarely the size that went in. Every placement is scaled
         * by the difference BEFORE it is refreshed, or the figures change size
         * on the map. Same order doBitify uses. */
        if (next.w !== item.w || next.h !== item.h)
          e.rescalePlacementsOf(next, item.w / next.w, item.h / next.h)
        e.refreshPlacementsOf(next)
        setAnimNote(r.note || '')
        setAnimAsk('')
        setAnimOpen(false)
        push(
          `${next.name} is moving · ${plan.motion}` +
            (r.note ? ' · ' + r.note : '') +
            ' · the old pixels are in .prev',
        )
      } catch (err) {
        const m = String(err instanceof Error ? err.message : err)
        push(
          m.includes('stopped')
            ? 'stopped · the item is as it was, nothing half-written'
            : 'that did not come back · ' + m.slice(0, 110),
        )
      } finally {
        setAnimRun(null)
        edRef.current?.setBusy('')
      }
    },
    [animAsk, animBusy, animRun, animPlan, push, stopPick],
  )

  const openMatch = useCallback(
    async (
      mode: 'gen' | 'sel',
      items: api.LibItem[],
      selId: string,
      o?: { ask?: string; prompt?: string },
    ) => {
      const e = edRef.current
      if (!e || !items.length) return
      let pal = mapPal
      if (!pal.length) {
        pal = readMapPalette(e)
        setMapPal(pal)
      }
      if (!pal.length) {
        push('no colours off the painting yet')
        return
      }
      try {
        const rows: PlItem[] = await Promise.all(
          items.map(async (it) => ({
            name: it.name,
            kind: it.kind,
            fps: it.fps || 8,
            raw: await framesOf(it),
          })),
        )
        const live = rows.filter((r) => r.raw.length)
        if (!live.length) return
        setPlOut([])
        setPl({ mode, selId, items: live, ask: o?.ask || '', prompt: o?.prompt || '', pick: -1 })
      } catch {
        push('those pixels did not load')
      }
    },
    [mapPal, push],
  )

  // The three ways out, and not one of them generates anything. keep matched
  // writes the matched pixels as their own library item and, from the
  // inspector, points the selected placement at it in one undo step, leaving
  // the original file alone. keep raw leaves what came back exactly as it is.
  // discard takes the just-generated files back off the disk.
  //
  // A batch that has been looked at comes in with one of them chosen, so keep
  // means keep THAT one: the takes he did not pick come off the disk with it,
  // since they were just made, nothing points at them, and three near-identical
  // sprites in a per-map library is clutter he would delete by hand.
  const applyMatch = useCallback(
    async (which: 'matched' | 'raw' | 'discard') => {
      const e = edRef.current
      if (!e || !pl || plBusy) return
      // which rows the buttons act on: the chosen one when something was
      // picked, everything when nothing was
      const idx = pl.pick >= 0 && pl.pick < pl.items.length ? [pl.pick] : pl.items.map((_, i) => i)
      const others = pl.items.filter((_, i) => !idx.includes(i))
      setPlBusy(true)
      e.setBusy(which === 'matched' ? 'writing the matched pixels' : which === 'discard' ? 'removing' : '')
      try {
        if (which === 'discard') {
          for (const it of pl.items) await api.libraryRemove(e.sceneId, it.name)
          setLib((await api.library(e.sceneId)).items)
          push(pl.items.length === 1 ? 'discarded' : `${pl.items.length} discarded`)
        } else if (which === 'raw') {
          if (pl.mode === 'gen' && others.length) {
            for (const it of others) await api.libraryRemove(e.sceneId, it.name)
            setLib((await api.library(e.sceneId)).items)
          }
          if (pl.mode === 'gen') noteKeep(e.sceneId, pl.ask, pl.prompt, pl.items[idx[0]].name, 'asset')
          push(
            pl.mode !== 'gen'
              ? 'left as it is'
              : others.length
                ? `${pl.items[idx[0]].name} kept as it came back`
                : 'kept as it came back',
          )
        } else {
          // the matched pixels replace the item's own, so the library keeps one
          // row per thing instead of growing a -matched twin beside every item
          const saved: api.LibItem[] = []
          for (const i of idx) {
            const frames = (plOut[i] || []).map((c) => c.toDataURL('image/png'))
            if (!frames.length) continue
            const r = await api.assetCrop(e.sceneId, pl.items[i].name, null, {
              kind: pl.items[i].kind,
              frames,
              fps: pl.items[i].fps,
              dirKeys: partsOf(pl.items[i]).keys,
            })
            saved.push(r.item)
          }
          if (!saved.length) throw new Error('nothing to write')
          for (const it of saved) {
            e.bustAssets(folderOf(it))
            setBust((q) => ({ ...q, [it.name]: Date.now() }))
            e.refreshPlacementsOf(it)
          }
          if (pl.mode === 'gen') {
            // a fresh batch: the takes he did not pick still go, so a ×3 leaves
            // one item rather than three
            const others = pl.items.filter((it) => !saved.some((s) => s.name === it.name))
            for (const it of others) await api.libraryRemove(e.sceneId, it.name)
            setLib((await api.library(e.sceneId)).items)
            noteKeep(e.sceneId, pl.ask, pl.prompt, saved[0].name, 'asset')
            push(saved.length === 1 ? `${saved[0].name} · in the map's colours` : `${saved.length} matched to the map`)
          } else {
            setLib((prev) => [...(prev || []).filter((x) => !saved.some((s) => s.name === x.name)), ...saved])
            push(`${saved[0].name} · in the map's colours`)
          }
        }
        closeMatch()
      } catch (err) {
        push('that did not write · ' + String(err instanceof Error ? err.message : err).slice(0, 120))
      }
      e.setBusy('')
      setPlBusy(false)
    },
    [pl, plOut, plBusy, closeMatch, noteKeep, push],
  )

  // The candidates, looked at before he is asked to choose. They are already
  // paid for, so this only says which one and why: the compare opens on that
  // one preselected with all of them still on screen, and one click overrules
  // it. Looking generates nothing. A look that says none of them are it picks
  // NOTHING instead, so every row stays keepable and the line above them says
  // why, with a corrected prompt behind one press.
  const reviewMade = useCallback(
    async (sid: string, ask: string, prompt: string, made: api.LibItem[]) => {
      await openMatch('gen', made, '', { ask, prompt })
      const v = await lookAt(sid, ask, prompt, made)
      if (!v || v.verdict === 'revise') return
      setPl((q) =>
        q && q.mode === 'gen' && q.items.length === made.length
          ? { ...q, pick: Math.max(0, Math.min(q.items.length - 1, v.best - 1)) }
          : q,
      )
    },
    [openMatch, lookAt],
  )

  // ---- the effect engine -----------------------------------------------
  // Effects are not generated. The generator draws objects, and every attempt
  // at smoke, splash or sparkle came back unusable, so the seven motion rules in
  // core/effects run over colours sampled off the painting itself. That makes
  // every knob free and instant: the sliders re-render locally and nothing is
  // written until keep.
  //
  // Seven rules is still a menu, and a menu has a ceiling: a portal was
  // impossible until swirl was added by hand, in code, first. So an ask that
  // fits none of them comes back with a renderer WRITTEN for those words, and
  // it runs in the sandbox in core/customfx. Same panel, same preview, same
  // keep; only the five fixed sliders are swapped for the ones it declared.

  // the current params turned into frames. Re-runs on every slider move; a
  // whole 8-frame effect at map scale renders in a few milliseconds.
  useEffect(() => {
    if (!fx || !fxP) {
      setFxFrames([])
      setFxNote('')
      return
    }
    // a written recipe runs in the sandbox, which is a worker and so async. The
    // seven run here and now, exactly as they always have.
    if (fx.type === 'custom') {
      const spec = fx.custom
      if (!spec) {
        setFxFrames([])
        return
      }
      let dropped = false
      void (async () => {
        try {
          const run = await runCustom({
            code: spec.code,
            params: flatParams(fxP),
            colors: fx.colors,
            width: fxP.width,
            height: fxP.height,
            frames: fxP.frames,
            seed: fxP.seed,
            seam: true,
          })
          if (dropped) return
          if (run.empty) throw new Error(run.errors[0] || 'nothing drawn at these numbers')
          fxRan.current = spec.code
          setFxFrames(customCanvases(run))
          // it rendered but it does not wrap: say so once, quietly, and leave
          // the decision with him
          setFxNote(run.seamRan && !run.loops ? 'this one does not loop cleanly' : '')
        } catch (err) {
          if (dropped) return
          const why = String(err instanceof Error ? err.message : err).slice(0, 90)
          // a broken preview is never shown. One that HAS worked keeps its
          // recipe and just says what went blank, so a knob is walkable back;
          // one that has never drawn anything hands the panel to the closest
          // built-in instead.
          setFxFrames([])
          if (fxRan.current === spec.code) {
            setFxNote(why)
            return
          }
          const g = guessType(fx.ask || fx.name)
          setFxNote('')
          setFx((f) => (f && f.type === 'custom' ? { ...f, type: g, custom: undefined } : f))
          setFxP((q) => (q ? fillParams(g, { ...q }) : q))
          push(`that recipe would not run · ${g} instead · ${why}`)
        }
      })()
      return () => {
        dropped = true
      }
    }
    try {
      setFxFrames(renderEffect(fx.type, fxP, fx.colors, fx.patch, fx.palette === 'own'))
      setFxNote('')
    } catch {
      setFxFrames([])
      push('that effect would not render')
    }
  }, [fx, fxP, push])

  const dropFx = useCallback(() => {
    fxStop.current = true
    setFx(null)
    setFxP(null)
    setFxFrames([])
    setFxNote('')
    setFxShow(false)
    setFxPick(false)
    setFxEdit(null)
    setFxRev(null)
    edRef.current?.pickPoint(null)
  }, [])

  // ---- the review loop --------------------------------------------------
  // The planner never used to see what it made: it wrote a renderer, the tool
  // drew it, and the first pair of eyes on the result belonged to the person
  // being asked to judge it. Rendering is free and instant, so now the tool
  // looks at its own frames first, fixes what it can, and only then asks.

  // one render, off explicit values instead of state, so a revision can be
  // proven to draw something BEFORE it reaches the panel
  const renderOnce = useCallback(async (f: FxState, p: EffectParams): Promise<HTMLCanvasElement[]> => {
    if (f.type === 'custom') {
      if (!f.custom) throw new Error('no recipe')
      const run = await runCustom({
        code: f.custom.code,
        params: flatParams(p),
        colors: f.colors,
        width: p.width,
        height: p.height,
        frames: p.frames,
        seed: p.seed,
        seam: true,
      })
      if (run.empty) throw new Error(run.errors[0] || 'nothing drawn at these numbers')
      return customCanvases(run)
    }
    return renderEffect(f.type as EffectType, p, f.colors, f.patch, f.palette === 'own')
  }, [])

  /* Render, look, revise, render. Up to three passes, stopping the moment the
   * answer is good, and every one of them free: the render is local and the
   * look never touches pixellab. A written effect gets its body rewritten; one
   * of the seven gets better numbers, which is the same free improvement
   * without writing a renderer.
   *
   * Two rules hold it together. Nothing is committed until it has been rendered
   * successfully, so a bad revision leaves the last good frames on screen
   * instead of blanking the panel. And the loop reads fxStop between every step,
   * so use this one takes whatever is on screen and ends it.
   *
   * fxStop only lands BETWEEN passes, and one pass is two minutes, so the look
   * itself carries a job as well: three passes with nothing to press is six
   * minutes of staring at a spinner. */
  const reviewFx = useCallback(
    async (f0: FxState, p0: EffectParams, first: HTMLCanvasElement[]) => {
      const e = edRef.current
      if (!e) return
      const sid = e.sceneId
      const job = newJob('fx')
      jobRef.current = job
      fxStop.current = false
      let f = f0
      let p = p0
      let frames = first
      let why = ''
      let pass = 1
      for (; pass <= FX_PASSES; pass++) {
        setFxRev({ pass, why, running: true })
        if (!frames.length) {
          try {
            frames = await renderOnce(f, p)
            setFxFrames(frames)
          } catch {
            break
          }
        }
        if (fxStop.current || e.sceneId !== sid) break
        let v: api.FxVerdict
        try {
          v = await api.fxReview(sid, {
            ask: f.ask,
            pass,
            job,
            kind: f.type === 'custom' ? 'custom' : 'builtin',
            type: f.type,
            params: flatParams(p),
            code: f.custom?.code,
            controls: f.custom?.controls,
            frames: frames.map((c) => c.toDataURL('image/png')),
          })
        } catch {
          if (!why) why = 'could not look at it'
          break
        }
        if (fxStop.current || e.sceneId !== sid) break
        why = v.why || why
        if (v.verdict !== 'revise') break
        // what it wants changed, rendered before it is committed. A recipe that
        // came back broken, or numbers that draw nothing, end the loop with the
        // render that already worked still on screen.
        let nf = f
        let np = p
        if (f.type === 'custom' && v.code) nf = { ...f, custom: { code: v.code, controls: f.custom?.controls || [] } }
        else if (f.type !== 'custom' && v.params)
          np = fillParams(f.type, { ...(p as unknown as Record<string, unknown>), ...v.params })
        else break
        let next: HTMLCanvasElement[]
        try {
          next = await renderOnce(nf, np)
        } catch {
          break
        }
        if (fxStop.current || e.sceneId !== sid) break
        f = nf
        p = np
        frames = next
        setFx(f)
        setFxP(p)
        setFxFrames(next)
      }
      if (e.sceneId !== sid) return
      setFxRev({ pass: Math.min(pass, FX_PASSES), why, running: false })
    },
    [renderOnce],
  )

  // use this one: whatever is on screen right now is the render, and the loop
  // ends where it stands rather than making him wait out a check. The pass in
  // flight gets killed too, or the flag would only take effect after it.
  const stopReview = useCallback(() => {
    fxStop.current = true
    const j = jobRef.current
    if (j) void api.stop(j).catch(() => {})
    setFxRev((r) => (r ? { ...r, running: false } : r))
  }, [])

  // the same look on demand, for any effect: a written one gets its body
  // rewritten, one of the seven gets better numbers
  const lookAtFx = useCallback(() => {
    if (!fx || !fxP || fxRev?.running) return
    void reviewFx(fx, fxP, fxFrames)
  }, [fx, fxP, fxFrames, fxRev, reviewFx])

  // the click landed on the painting: read the palette right there, ask which
  // rule fits the words, then render. The plan call is free and the server
  // answers from a keyword match when the planner is unreachable, so a click
  // always ends in something on screen.
  //
  // The plan also says whose colours the effect is made of. Things made OF the
  // place take the pixels the click sampled; things with their own identity
  // bring their own ramp, which is the whole reason a purple portal can be
  // purple on a brown island. Either way the toggle in the panel overrules it.
  const planFx = useCallback(
    async (ask: string, at: [number, number]) => {
      const e = edRef.current
      if (!e) return
      const sid = e.sceneId
      const patch = e.patchAround(at[0], at[1], 24)
      const mapColors = patch ? samplePalette(patch, 8) : ['#ffffff']
      // two reads in a row at a minute each, so the stop button has to have
      // something to post against for the whole of it
      const job = newJob('fx')
      jobRef.current = job
      stopRef.current = false
      setFxBusy(true)
      e.setBusy('reading the ask')
      // Writing a renderer takes a real 25-30s, and a dropped request used to
      // fall straight through to the keyword guess in SILENCE: the panel then
      // read SWIRL exactly as if that had been the considered answer, so a
      // regex was quietly impersonating the planner and a nether portal came
      // back as two galaxies. Ask twice, and if it still will not answer, say
      // so instead of substituting a rule behind his back.
      let plan: api.EffectPlan | null = null
      for (let attempt = 0; attempt < 2 && !plan && !stopRef.current; attempt++) {
        if (attempt) e.setBusy('reading the ask again')
        try {
          plan = (await api.effectPlan(ask, mapColors, sid, job)).plan
        } catch {
          plan = null
        }
      }
      e.setBusy('')
      setFxBusy(false)
      /* Stopped mid-read, so there is no answer to work from.
       *
       * Everything below treats a null plan as "the planner could not be
       * reached" and falls through to the keyword guess, which is precisely
       * what the note above says must never happen quietly. A stop is not a
       * failed read, it is a change of mind, and it gets nothing. */
      if (stopRef.current) return
      // a scene swap while the ask was being read drops the whole thing
      if (e.sceneId !== sid) return
      // the eighth answer: no rule fitted, so the plan carries a renderer
      // written for these words instead of the name of one
      const written = !!(plan && plan.type === 'custom' && plan.code)
      const type: AnyEffectType = written ? 'custom' : plan && isEffectType(plan.type) ? plan.type : guessType(ask)
      // the server already applied the colour-word rule, so its answer stands;
      // only an unreachable server sends the words back through the fall-back
      let ownColors: string[] = []
      if (plan) {
        if (plan.palette === 'own' && Array.isArray(plan.colors)) ownColors = plan.colors
      } else ownColors = guessColors(ask)
      const palette: 'map' | 'own' = ownColors.length ? 'own' : 'map'
      const colors = palette === 'own' ? ownColors : mapColors
      const custom: CustomSpec | undefined =
        written && plan?.code ? { code: plan.code, controls: plan.controls || [] } : undefined
      const next: FxState = {
        type,
        name: slug(plan?.name || ask),
        ask,
        at,
        colors,
        mapColors,
        ownColors,
        palette,
        patch,
        custom,
      }
      const params = fillParams(type, plan?.params, custom?.controls)
      setFx(next)
      setFxP(params)
      setFxShow(false)
      setFxRev(null)
      // a rule that came from a guess is never presented as a considered answer
      if (!plan) {
        push(`the planner did not answer · guessed ${type} from the words · try again for a written one`)
        return
      }
      const label = written ? 'written for this ask' : type
      push(
        palette === 'own'
          ? `${label} · its own colours · tune it, nothing is written yet`
          : `${label} · ${colors.length} colours off the map · tune it, nothing is written yet`,
      )
      // a written renderer is the one nobody has ever seen the output of, so it
      // reviews itself before he is asked anything. Free, and stoppable.
      if (written) void reviewFx(next, params, [])
    },
    [push, reviewFx],
  )

  // the colour control, both halves free and instant like the sliders. Touching
  // a swatch IS the decision that these are not the map's colours any more, so
  // it moves the panel to own and edits that ramp; the toggle puts the sampled
  // one back untouched.
  const setFxPalette = useCallback((mode: 'map' | 'own') => {
    setFx((f) => {
      if (!f || f.palette === mode) return f
      if (mode === 'own') {
        const own = f.ownColors.length ? f.ownColors : f.colors
        return { ...f, palette: 'own', ownColors: own, colors: own }
      }
      return { ...f, palette: 'map', colors: f.mapColors.length ? f.mapColors : f.colors }
    })
  }, [])

  const setFxColor = useCallback((i: number, hex: string) => {
    setFx((f) => {
      if (!f) return f
      const cs = f.colors.slice()
      cs[i] = hex
      return { ...f, palette: 'own', ownColors: cs, colors: cs }
    })
  }, [])

  // make an effect arms a one-shot map click, the same picker the door flow
  // uses. A click off the art stays armed; esc or right-click cancels.
  const armFx = useCallback(() => {
    const e = edRef.current
    const ask = fxAsk.trim()
    if (!e || !ask || fxBusy) return
    if (fxPick) {
      setFxPick(false)
      e.pickPoint(null)
      return
    }
    setFx(null)
    setFxP(null)
    setGenPick(false)
    setFxPick(true)
    e.armPlace(null)
    e.pickPoint((p) => {
      if (!p) {
        setFxPick(false)
        return
      }
      if (!e.opaqueAt(p[0], p[1])) return
      e.pickPoint(null)
      setFxPick(false)
      void planFx(ask, [p[0], p[1]])
    })
  }, [fxAsk, fxBusy, fxPick, planFx])

  // keep: the frames become an animated library item on disk, effect.json goes
  // beside them so the rule and its numbers can be reopened, and the item lands
  // on the map at the clicked point in one undo step.
  //
  // Three ways out of the tuning panel, and this is two of them. A fresh effect
  // writes a new item and places it. A REOPENED effect either overwrites itself
  // (same name, same frame urls, so every placement of it plays the new render
  // the moment the caches are busted) or writes a second item and leaves the
  // original alone. Discard is the third and touches nothing.
  const keepFx = useCallback(
    async (how: 'new' | 'over') => {
      const e = edRef.current
      if (!e || !fx || !fxP || !fxFrames.length || fxSaving) return
      const over = how === 'over' && !!fxEdit
      setFxSaving(true)
      e.setBusy(over ? 'rewriting the effect' : 'writing the effect')
      try {
        const urls = fxFrames.map((c) => c.toDataURL('image/png'))
        const r = await api.effectSave(
          e.sceneId,
          over && fxEdit ? fxEdit.name : fx.name || 'effect',
          urls,
          {
            type: fx.type,
            params: fxP,
            colors: fx.colors,
            palette: fx.palette,
            fps: fpsFor(fxP),
            // a written effect carries its recipe onto disk beside the frames,
            // so the pencil reopens it with every knob still working
            code: fx.custom?.code,
            controls: fx.custom?.controls,
          },
          over,
          fx.ask,
        )
        // it IS an effect by construction, so the flag rides whatever came back:
        // without this the pencil only showed up after a reload
        r.item.effect = true
        setLib((prev) => [...(prev || []).filter((x) => x.name !== r.item.name), r.item])
        // kept, so it goes on this map's record and shapes the next ask
        noteKeep(e.sceneId, fx.ask, fx.type === 'custom' ? 'a written renderer' : `the ${fx.type} rule`, r.item.name, 'effect')
        if (!over)
          api
            .asks(e.sceneId)
            .then((q) => setAsks(q.asks))
            .catch(() => {})
        if (over) {
          // the urls did not change, so nothing on the map knows yet: repoint
          // the placements (a longer take has more frames) and drop the cached
          // pixels for those exact urls
          const n = e.refreshPlacementsOf(r.item)
          e.bustAssets(folderOf(r.item))
          setBust((b) => ({ ...b, [r.item.name]: Date.now() }))
          push(n ? `${r.item.name} updated · ${n} on the map` : `${r.item.name} updated`)
        } else if (fxEdit) {
          // a second take off a reopened effect: it belongs to the library, not
          // on top of whatever the original is doing
          push(`${r.item.name} saved · click it, then the map`)
        } else {
          // a glow, a twinkle or a swirl sits around its spot, so it drops half
          // a sprite lower and the click ends up in the middle; everything else
          // stands on the spot, the way every other placement anchors at its feet
          const mid =
            fx.type === 'glow' || fx.type === 'twinkle' || fx.type === 'swirl' || fx.type === 'custom'
          const n = e.addPlacements([
            {
              item: r.item,
              x: fx.at[0],
              y: fx.at[1] + (mid ? Math.round((r.item.h || fxP.height) / 2) : 0),
              scale: 1,
              group: 'effects',
            },
          ])
          push(n ? `${r.item.name} kept and placed · z undoes` : `${r.item.name} kept · click it, then the map`)
        }
        setFxAsk('')
        setFx(null)
        setFxP(null)
        setFxFrames([])
        setFxNote('')
        setFxShow(false)
        setFxEdit(null)
        setFxRev(null)
      } catch (err) {
        push('could not write it · ' + String(err instanceof Error ? err.message : err).slice(0, 120))
      }
      e.setBusy('')
      setFxSaving(false)
    },
    [fx, fxP, fxFrames, fxSaving, fxEdit, noteKeep, push],
  )

  // reopen a saved effect on the same panel that made it: the rule, the numbers
  // and the colours come off effect.json, the preview starts playing, and
  // nothing on disk moves until save or save as new. The patch (the painting
  // pixels the sway and rise rules read) is re-sampled at whichever placement
  // the effect was opened from, or at the middle of the map when it is only in
  // the library.
  const openFx = useCallback(
    async (it: api.LibItem, at?: [number, number]) => {
      const e = edRef.current
      if (!e || fxBusy) return
      const sid = e.sceneId
      setFxBusy(true)
      e.setBusy('reading the effect')
      try {
        const saved = await api.effectRead(sid, it.name)
        if (e.sceneId !== sid) return
        const written = saved.type === 'custom' && !!saved.code
        const type: AnyEffectType = written ? 'custom' : isEffectType(saved.type) ? saved.type : guessType(it.name)
        const custom: CustomSpec | undefined =
          written && saved.code ? { code: saved.code, controls: saved.controls || [] } : undefined
        const spot: [number, number] = at || [Math.round(e.doc.W / 2), Math.round(e.doc.H / 2)]
        const patch = e.patchAround(spot[0], spot[1], 24)
        const sampled = patch ? samplePalette(patch, 8) : ['#ffffff']
        const colors = saved.colors.length ? saved.colors : sampled
        // an effect saved on its own ramp reopens on it; the sampled colours
        // sit behind the toggle so the map is still one click away
        const palette: 'map' | 'own' = saved.palette === 'own' ? 'own' : 'map'
        stopPick()
        setFx({
          type,
          name: it.name,
          ask: it.name,
          at: spot,
          colors,
          mapColors: sampled,
          ownColors: palette === 'own' ? colors : [],
          palette,
          patch,
          custom,
        })
        setFxP(fillParams(type, saved.params, custom?.controls))
        setFxNote('')
        setFxShow(false)
        setFxRev(null)
        setFxEdit(it)
        setMakeWhat('effect')
        push(`${it.name} open · ${written ? 'written for this ask' : type} · save writes over it`)
      } catch (err) {
        push('that one did not reopen · ' + String(err instanceof Error ? err.message : err).slice(0, 120))
      }
      e.setBusy('')
      setFxBusy(false)
    },
    [fxBusy, push, stopPick],
  )

  // ---- the test step's doors -------------------------------------------
  // add door arms a one-shot map click (the same pick machinery the
  // generate-here spot uses); the click drops the event and opens its form.
  // A click off the painting stays armed; esc or right-click cancels.
  const armDoor = useCallback(() => {
    const e = edRef.current
    if (!e) return
    if (doorPick) {
      setDoorPick(false)
      e.pickPoint(null)
      return
    }
    setDoorEdit(0)
    setDoorPick(true)
    e.pickPoint((p) => {
      if (!p) {
        setDoorPick(false)
        return
      }
      if (!e.doc.inB(p[0], p[1])) return
      e.pickPoint(null)
      setDoorPick(false)
      setDoorNew(true)
      setDoorEdit(e.addDoor(p[0], p[1]))
    })
  }, [doorPick])

  // The spend itself, after every confirm has happened. spot is the static
  // path's context: the clicked painting pixel and a crop of the cut painting
  // around it, which the server hands to pixellab as the background, so the
  // asset comes back drawn in that spot's palette and light. With a spot the
  // result also lands ON the map right there (one undo); a run of takes fans
  // out beside the spot so all of them stay visible. Animated has no spot: its
  // animate endpoint needs a standalone first frame.
  //
  // One job for the whole run, minted here. It used to mint none, so a stop
  // mid-run posted a finished planner's id and the server answered that there
  // was nothing to stop; only the flag between generations did anything.
  const runGen = useCallback(
    async (p: string, t: api.MakePlan, bg: string) => {
      const e = edRef.current
      if (!e) return
      const sid = e.sceneId
      const job = newJob('gen')
      jobRef.current = job
      const seed0 = 1 + Math.floor(Math.random() * 1e9)
      const runs: { name?: string; seed?: number }[] =
        genCount > 1
          ? Array.from({ length: genCount }, (_, i) => ({ name: `${slug(p)}-${i + 1}`, seed: seed0 + i + 1 }))
          : [{}]
      setGenRun({ done: 0, total: runs.length })
      // the line under the button is about what LAST came back, so it goes the
      // moment something new is being drawn
      setSaid(null)
      const made: api.LibItem[] = []
      // asked once per run, and only once something is on screen to ask about
      let gated = false
      for (let i = 0; i < runs.length; i++) {
        // a scene swap mid-run stops the spend where it stands
        if (e.sceneId !== sid) break
        if (stopRef.current) break
        e.setBusy(
          runs.length > 1
            ? `asset ${i + 1}/${runs.length}`
            : genType === 'animated'
              ? 'animating'
              : 'generating',
        )
        try {
          const r =
            genType === 'animated'
              ? await api.assetAnim(sid, p, '', {
                  ...runs[i],
                  job,
                  thing: t.prompt,
                  tmotion: t.motion,
                  tw: t.w,
                  th: t.h,
                })
              : await api.assetGen(sid, p, {
                  ...runs[i],
                  job,
                  thing: t.prompt,
                  tw: t.w,
                  th: t.h,
                  // the boxed art rides along, so pixellab draws into this
                  // map's light instead of onto a bare canvas. With no box the
                  // patch the router chose goes instead and the server crops
                  // it, so the ordinary ask gets the same treatment as the
                  // careful one without anybody drawing anything.
                  ...(bg ? { background: bg } : t.where ? { where: t.where } : {}),
                })
          if (e.sceneId !== sid) break
          setLib((prev) => [...(prev || []).filter((x) => x.name !== r.item.name), r.item])
          made.push(r.item)
          // a motion that did not happen is said out loud, the same as a
          // sprite's. Asked for moving, a stop between the base and its frames
          // files the base as a still object, and a still where a moving one
          // was asked for has to explain itself.
          if ('note' in r && r.note) push(`${r.item.name} · ${r.note}`)
        } catch (err) {
          const m = String(err instanceof Error ? err.message : err)
          push(
            m.includes('stopped')
              ? 'stopped'
              : (genType === 'animated' ? 'animation failed · ' : 'generation failed · ') + m.slice(0, 120),
          )
        }
        setGenRun({ done: i + 1, total: runs.length })
        // The first take that LANDED, held up for a yes. Seven more of
        // something he does not want is minutes and generations spent proving
        // the same point twice. Keyed on what came back rather than on the
        // index, because a first take that failed would otherwise carry the
        // gate away with it and let the rest through unseen.
        if (!gated && made.length && i < runs.length - 1 && !stopRef.current) {
          gated = true
          if (!(await askGate(made[0], i + 1, runs.length))) break
        }
      }
      e.setBusy('')
      setGenRun(null)
      if (made.length) {
        setGenPrompt('')
        // the box clears on success, so the words go on the list in the same
        // breath: clearing them used to be the only place they existed
        api
          .asks(sid)
          .then((r) => setAsks(r.asks))
          .catch(() => {})
        push(
          stopRef.current && made.length < runs.length
            ? `stopped after ${made.length} of ${runs.length} · ${made.length === 1 ? 'it stays' : 'they stay'}`
            : made.length === 1
              ? 'added to the library · click it, then the map'
              : `${made.length} added to the library · click one, then the map`,
        )
        // what came back carries the generator's colours, not the map's. The
        // compare opens on it; nothing changes until somebody clicks. The
        // slider starts where the thing's relatedness says it should: a palm
        // opens matched, an alien artifact opens raw, and either can be dragged.
        // and it is looked at before he is asked to choose: a run of takes comes
        // back with one of them picked and a line saying why, a single one comes
        // back confirmed or with a corrected prompt to try. Looking is free.
        //
        // Both kinds, now. This used to read `if (genType === 'static')`, which
        // meant a campfire came back in the generator's own colours with nobody
        // having looked at it, on the same endpoint and from the same words as a
        // well that did. The panel already handles a folder of frames: the
        // inspector's own match button opens it on one.
        //
        // the prompt was written against this map's own pixels, so the take
        // already belongs here: the lock opens matched
        setPlStr(80)
        void reviewMade(sid, p, t.prompt, made)
      }
    },
    [genCount, genType, askGate, reviewMade, push],
  )

  /* Box the area this thing will stand in. Optional, and skipping is a real
   * answer: esc hands back null and the read goes ahead on the whole map. The
   * box is what makes scale right, because a sprite is the right size when it
   * is the right size NEXT TO WHAT IS ALREADY THERE. */
  const doBox = useCallback(() => {
    const e = edRef.current
    if (!e) return
    if (genBox) {
      setGenBox(null)
      setGenPlan(null)
      // a fill's plan is a list of positions INSIDE the box, so it means
      // nothing once the box is gone. It used to survive, which left the draw
      // button lit over a plan that had nowhere to land.
      setScene(null)
      push('box cleared · it will read the whole map')
      return
    }
    e.markArea((r) => {
      setGenBox(r)
      // a new area means the old reading is about a different place
      setGenPlan(null)
      setScene(null)
      if (r) push(`boxed ${r.w}×${r.h} · now say what goes there`)
    })
  }, [genBox, push])

  /* One press ends whatever is thinking or drawing. The planner is a process
   * on the server, so it takes a round trip to kill; a generation already sent
   * to pixellab cannot be recalled, but the run stops before the next one, and
   * a run held on the gate is answered no on the way past. */
  const doStop = useCallback(() => {
    stopRef.current = true
    const j = jobRef.current
    if (j) void api.stop(j).catch(() => {})
    gateRef.current?.(false)
    setFxBusy(false)
    fxStop.current = true
    setGenBusy(false)
    edRef.current?.setBusy('')
    push('stopped')
  }, [push])

  /* SEVERAL THINGS, PLANNED IN ONE LOOK. Free, and the whole point of doing it
   * separately from the spend: what comes back is a list you can read, drop
   * items from, and only then buy.
   *
   * One call for both asks that end up here, because they are the same
   * question. "fill this courtyard" says how many out loud; "a few crates" says
   * it in the words and the router counts them. Either way the answer is a list
   * of things to draw, and the press after this one buys it.
   *
   * A box is required by fill and optional here, exactly as it is for the
   * single read: with no box the whole painting is the area, which is a real
   * answer rather than a missing step. Throws on failure so the caller that
   * owns the busy line owns the message too. */
  const readMany = useCallback(
    async (ask: string, count: number, job: string) => {
      const e = edRef.current
      if (!e) return
      const map = e.cutSceneDataURL()
      if (!map) throw new Error('no painting to read')
      const box = genBox || { x: 0, y: 0, w: e.doc.W, h: e.doc.H }
      const r = await api.scenePlan(e.sceneId, {
        map,
        // the boxed area goes at 2x because a 40px strip is easier to judge
        // enlarged. With no box the area IS the map, which is already in hand.
        boxImage: genBox ? e.areaDataURL(genBox, 2) : map,
        box,
        ask,
        count,
        kind: genType,
        job,
      })
      if (stopRef.current) return
      setScene(r.plan)
      setSceneOff(new Set())
      push(r.plan.note || `${r.plan.items.length} planned · look, then draw`)
    },
    [genBox, genType, push],
  )

  const doScenePlan = useCallback(async () => {
    const e = edRef.current
    if (!e || genBusy || fillRun) return
    if (!genBox) {
      push('box an area first · that is what gets filled')
      return
    }
    const job = newJob('scene')
    jobRef.current = job
    stopRef.current = false
    setGenBusy(true)
    setScene(null)
    e.setBusy(`planning ${fillCount} for the area`)
    try {
      await readMany(genPrompt.trim(), fillCount, job)
    } catch (err) {
      const m = String(err instanceof Error ? err.message : err)
      push(m.includes('stopped') ? 'stopped' : 'could not plan the area · ' + m.slice(0, 90))
    } finally {
      setGenBusy(false)
      e.setBusy('')
    }
  }, [genBusy, fillRun, genBox, genPrompt, fillCount, readMany, push])

  /* DRAW A PLANNED SET, ONE AT A TIME. The second press behind both asks that
   * produce several things, because past the plan they are the same job.
   *
   * The only difference is where they land, and it is one line. A fill was
   * asked to populate an area, so each thing goes onto the map at the spot the
   * plan chose for it. An asset ask was asked for THINGS, so they go in the
   * library and the map is a later click, the same as every other asset ask.
   * That is the whole of it: same planner, same loop, same gate, same stop.
   *
   * Sequential on purpose. Each generation is a spend, so stopping has to mean
   * stopping: the flag is checked before every one, whatever has already been
   * drawn stays rather than being rolled back, and the first one to land is
   * held up for a yes exactly as a run of takes is.
   */
  const runMany = useCallback(async () => {
    const e = edRef.current
    if (!e || !scene || fillRun) return
    // the map half is what needs the area. A library row does not stand
    // anywhere yet, so it does not need one.
    const place = makeWhat === 'fill'
    if (place && !genBox) return
    const wanted = scene.items.filter((_, i) => !sceneOff.has(i))
    if (!wanted.length) {
      push('nothing left in the plan')
      return
    }
    const sid = e.sceneId
    // what this set came from, held before the box is cleared. A fill's box can
    // be empty, and then the plan's own line is the nearest thing to an ask.
    const ask = genPrompt.trim() || scene.note || `${wanted.length} things`
    // one job for the whole run. Without it a stop mid-run posted the id of
    // the planner that had already finished, so only the flag between items did
    // anything and the generation in flight ran to the end.
    const job = newJob(place ? 'fill' : 'many')
    jobRef.current = job
    stopRef.current = false
    setScene(null)
    setSaid(null)
    setFillRun({ done: 0, total: wanted.length, what: wanted[0].what })
    const made: api.LibItem[] = []
    // asked once per run, and only once something is on screen to ask about
    let gated = false
    for (let i = 0; i < wanted.length; i++) {
      if (stopRef.current || e.sceneId !== sid) break
      const it = wanted[i]
      setFillRun({ done: i, total: wanted.length, what: it.what })
      e.setBusy(`${i + 1}/${wanted.length} · ${it.what}`)
      try {
        const r =
          genType === 'animated'
            ? await api.assetAnim(sid, it.what, '', { job, thing: it.prompt, tmotion: it.motion, tw: it.w, th: it.h })
            : await api.assetGen(sid, it.what, { job, thing: it.prompt, tw: it.w, th: it.h })
        if (e.sceneId !== sid) break
        setLib((prev) => [...(prev || []).filter((x) => x.name !== r.item.name), r.item])
        // one of a set can land still when the whole set was asked for moving,
        // so the reason travels with that item rather than being lost in the
        // run's own summary
        if ('note' in r && r.note) push(`${r.item.name} · ${r.note}`)
        // straight onto the map at the planned spot, so a run cut short still
        // leaves what it managed to draw
        if (place && genBox)
          e.addPlacements([
            {
              item: r.item,
              x: Math.round(genBox.x + it.x),
              y: Math.round(genBox.y + it.y),
              scale: 1,
              group: groupFor(r.item.name),
            },
          ])
        made.push(r.item)
      } catch (err) {
        push(`${it.what} failed · ` + String(err instanceof Error ? err.message : err).slice(0, 80))
      }
      /* The same hold a run of takes has, and for the same reason: twenty-four
       * moving things is forty-eight generations, and finding out at the end
       * that the first one was wrong costs all of them. Keyed on what LANDED,
       * not on the index, so a first item that failed does not carry the gate
       * away with it. */
      if (!gated && made.length && i < wanted.length - 1 && !stopRef.current) {
        gated = true
        if (!(await askGate(made[0], i + 1, wanted.length))) break
      }
    }
    e.setBusy('')
    setFillRun(null)
    push(
      made.length
        ? stopRef.current
          ? `stopped · ${made.length} of ${wanted.length} ${place ? 'placed' : 'drawn'}, they stay`
          : place
            ? `${made.length} placed · z undoes`
            : `${made.length} added to the library · click one, then the map`
        : 'nothing was drawn',
    )
    if (!made.length) return
    // the words go on the record and out of the box in the same breath, the
    // same as a single asset ask. A fill's box is steering rather than an ask,
    // so it keeps what was typed.
    if (!place) setGenPrompt('')
    api
      .asks(sid)
      .then((q) => setAsks(q.asks))
      .catch(() => {})
    /* and the same free look. It reads the set as a set, because these all came
     * from one ask and what it says about them is about that ask.
     *
     * The words it is given are the ones a person typed when there are any, and
     * the plan's own line when the box was empty. What each candidate was
     * MEANT to be goes in place of a prompt, named off what actually landed so
     * the names line up with the strip even when one of them failed: six
     * different things need six different names, and one item's full prompt
     * would describe the first cell and none of the rest. */
    void lookAt(sid, ask, made.slice(0, LOOK_CELLS).map((m) => m.name).join(' · '), made)
  }, [scene, sceneOff, genBox, fillRun, genType, makeWhat, genPrompt, askGate, lookAt, push])

  /* The whole flow, in two presses.
   *
   * FIRST press is free and spends nothing: the painting, and the boxed area if
   * there is one, go to the model, which writes the entire generator prompt and
   * picks the sprite's pixel size by measuring it against what is already on
   * the map. What comes back is shown before anything is bought.
   *
   * SECOND press spends. The prompt runs verbatim, with the boxed art riding
   * along as pixellab's background so the sprite is drawn into this map's light
   * rather than onto a bare canvas.
   *
   * There is no translator, no style card, no assembled house prompt and no
   * ground-word filter in this path any more. All four existed to carry a
   * description of the map through a pipeline made of text. The model looks at
   * the map instead.
   *
   * A sprite goes through the same two presses, and that is the change: it used
   * to be one armed press against a row of dropdowns. The read is where the
   * skeleton, the view, the size and the meaning of moving get decided, so the
   * card can say "lion rig, hovering, wings beating" before a penny is spent. */
  const doGen = useCallback(async (askIn?: string) => {
    const e = edRef.current
    // the words are normally the ones in the box. They are handed in only by
    // try-again, whose whole point is that one press both fills the box and
    // reads the map, and state set a line earlier is not readable yet.
    const p = (askIn ?? genPrompt).trim()
    if (!e || !p || genRun || genBusy || charRun) return
    const what = makeWhat === 'sprite' ? 'sprite' : 'object'

    if (!genPlan) {
      const map = e.cutSceneDataURL()
      if (!map) {
        push('no painting to read')
        return
      }
      const job = newJob('plan')
      jobRef.current = job
      stopRef.current = false
      setGenBusy(true)
      e.setBusy('reading the map')
      try {
        const r = await api.assetPlan(e.sceneId, p, {
          map,
          what,
          kind: genType,
          box: genBox,
          boxImage: genBox ? e.areaDataURL(genBox, 2) : '',
          // a rejected take feeds the next reading, so "again" is not a reroll
          previous: genLast,
          job,
        })
        if (stopRef.current) return
        // held to the same 1..24 the area planner clamps to, so the busy line
        // and the price can never name a number the next call will not honour
        const many = Math.min(24, Math.max(1, Math.round(r.plan.count || 1)))
        /* SEVERAL FROM ONE ASK, and it is still the same free press.
         *
         * "a few crates" came back as one png with three crates welded into it,
         * because the generator draws every noun it is given and one ask bought
         * one picture. Nothing about that is fixable in the words.
         *
         * So the router now says how many things the ask is, and when it is
         * more than one the read carries straight on into the planner that
         * already writes a set of them for a fill. Same list card, same rows to
         * strike out, same second press, same stop. What changes is where they
         * land: an asset ask fills the library, not the map. */
        if (what === 'object' && many > 1) {
          e.setBusy(`working out the ${many}`)
          await readMany(p, many, job)
          return
        }
        /* A sprite is priced per body, so several of THOSE is the takes slider
         * rather than a set of different things: each one is its own rig and its
         * own nine generations, and the fill planner writes prompts for a flat
         * prop endpoint. Setting the number here is what makes the button state
         * the real total before it is armed. */
        if (what === 'sprite' && many > 1) setGenCount(Math.min(8, many))
        setGenPlan(r.plan)
        push(r.plan.note || 'read · press again to draw it')
      } catch (err) {
        const m = String(err instanceof Error ? err.message : err)
        push(m.includes('stopped') ? 'stopped' : 'could not read the map · ' + m.slice(0, 90))
      } finally {
        setGenBusy(false)
        e.setBusy('')
      }
      return
    }

    const plan = genPlan
    // a sprite mode holding an object plan has nowhere to send it, so it reads
    // again rather than spending on the wrong endpoint
    if (what === 'sprite' && !plan.sprite) {
      setGenPlan(null)
      push('that read came back as an asset · press again to read it as a sprite')
      return
    }
    setGenPlan(null)
    setGenLast(plan.prompt)
    stopRef.current = false
    if (what === 'sprite') {
      void runSpriteGen(p, plan)
      return
    }
    // pixellab takes the background at 32..192 per side, so the box is fitted
    // into that before it is sent; without a box it generates on bare canvas
    const bg = genBox ? e.areaDataURL(genBox, 0, 192) : ''
    runGen(p, plan, bg)
  }, [genPrompt, genRun, genBusy, charRun, makeWhat, genPlan, genBox, genType, genLast, readMany, push, runGen, runSpriteGen])

  /* ONE PRESS BACK TO THE MAP, when the look said none of these are it.
   *
   * The corrected prompt goes in the box and the free read runs on it straight
   * away, because a correction nobody acts on is a sentence. Nothing is armed
   * by this: the read is free, and the press after it is still the one that
   * states a price and spends. */
  const tryAgain = useCallback(
    (fix: string) => {
      setGenPrompt(fix)
      setGenPlan(null)
      setScene(null)
      setSaid(null)
      closeMatch()
      push('reading the map again · the button still asks before it spends')
      void doGen(fix)
    },
    [closeMatch, doGen, push],
  )

  // deleting a library item: the file goes for good, and every placement of
  // it comes off the canvas in one undo step (z restores the placements)
  const removeLib = useCallback(
    async (it: api.LibItem) => {
      const e = edRef.current
      if (!e) return
      try {
        await api.libraryRemove(e.sceneId, it.name)
      } catch (err) {
        push('remove failed · ' + String(err instanceof Error ? err.message : err).slice(0, 120))
        return
      }
      const n = e.removePlacementsOf(it)
      push(n ? `removed ${it.name} + ${n} placed` : `removed ${it.name}`)
      api
        .library(e.sceneId)
        .then((r) => setLib(r.items))
        .catch(() => setLib((prev) => (prev || []).filter((x) => x.name !== it.name)))
    },
    [push],
  )

  // ---- crop --------------------------------------------------------------
  // The trim itself happens here, on canvas: the client already holds every
  // frame decoded for the draw, so cutting a rectangle out of them costs one
  // drawImage each and needs no image library on the node side. The result goes
  // to the server as a NEW item called <name>-crop — the original png is never
  // touched, so a bad crop costs nothing but a click on the original.
  /* WHAT AN IN-PLACE PIXEL EDIT SAYS AFTERWARDS, and it is the same line for
   * all of them because they carry the same surprise.
   *
   * These edits replace the art under its own name, so EVERY placement of that
   * item changes at once. That is the point of them, and it is not what
   * somebody who selected one tree expects. It also cannot be taken back with
   * z, which only knows about the document: undoing a crop moved every tree
   * back to where it belonged around art that was still cropped, and the whole
   * map looked like it had slid. So the count is said out loud and the way home
   * rides on the same line. */
  const saidEdit = useCallback(
    (name: string, what: string, n: number) => {
      const e = edRef.current
      push(`${what}${n > 1 ? ` · all ${n} of them on the map` : ''}`, {
        label: 'put it back',
        run: () => {
          const ed = edRef.current
          if (!ed) return
          void (async () => {
            try {
              const r = await api.assetRevert(ed.sceneId, name)
              setLib((prev) => [...(prev || []).filter((x) => x.name !== r.item.name), r.item])
              ed.bustAssets(folderOf(r.item))
              setBust((q) => ({ ...q, [r.item.name]: Date.now() }))
              ed.refreshPlacementsOf(r.item)
              push(`${name} is back the way it was`)
            } catch (err) {
              push('could not put it back · ' + String(err instanceof Error ? err.message : err).slice(0, 90))
            }
          })()
        },
      })
      void e
    },
    [push],
  )

  const applyCrop = useCallback(
    async (id: string, r: { x: number; y: number; w: number; h: number }) => {
      const e = edRef.current
      if (!e) return
      const a = e.doc.assets.find((q) => q.id === id)
      if (!a) return
      const name = assetLabel(a)
      const parts = partsOf(a)
      const urls = parts.urls
      if (!urls.length || !urls[0]) return
      // the anchor comes off the placement BEFORE it is repointed, or it would
      // be measured against the cropped size
      const at = e.cropAnchor(id, r)
      e.setBusy('cropping')
      try {
        const imgs = await Promise.all(urls.map((u) => loadImage(u)))
        const frames = imgs.map((img) => {
          const c = mkCanvas(r.w, r.h)
          const g = c.getContext('2d') as CanvasRenderingContext2D
          g.imageSmoothingEnabled = false
          g.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
          return c.toDataURL('image/png')
        })
        // Every placement of this item, and where each of their feet have to
        // land so the kept pixels do not jump. Measured BEFORE the write, since
        // the anchor is worked out against the size the png still has.
        const mine = e.doc.assets.filter((q) => assetLabel(q) === name).map((q) => q.id)
        /* JUST THIS ONE, unless the toggle says otherwise.
         *
         * Cropping rewrites a library row and every placement reads that row,
         * so in place has always meant all of them. Selecting one tree and
         * cropping nineteen is not what anybody means, so a crop of one asks
         * the server to keep a copy under a new name and points only the picked
         * placement at it. The others are not touched and their row is not
         * rewritten, so there is nothing to put back either.
         *
         * With one placement the two are the same thing, and in place is the
         * one that leaves the library tidy. */
        const alone = !editAll && mine.length > 1
        const res = await api.assetCrop(e.sceneId, name, r, {
          kind: a.kind,
          frames,
          fps: a.fps || 8,
          dirKeys: parts.keys,
          ...(alone ? { keepCopy: true, suffix: 'crop' } : {}),
        })
        setLib((prev) => [...(prev || []).filter((x) => x.name !== res.item.name), res.item])
        e.bustAssets(folderOf(res.item))
        setBust((q) => ({ ...q, [res.item.name]: Date.now() }))
        if (alone) {
          // a row of its own, so only the one that was picked moves to it
          e.repointAsset(id, res.item, at || undefined)
          push(`cropped to ${r.w}×${r.h} · just this one, as "${res.item.name}"`)
        } else {
          const anchors = new Map<string, { x: number; y: number } | null>()
          for (const pid of mine) anchors.set(pid, pid === id ? at : e.cropAnchor(pid, r))
          e.refreshPlacementsOf(res.item)
          // ONE undo step for every copy. Per-placement edits put one entry on
          // the stack each, so z used to move a single tree back and leave the
          // other eighteen where the crop had put them.
          e.moveAll(anchors)
          // filed against the undo depth it now sits at, so z knows which press
          // is the one that should put the pixels back
          pixelUndo.current.push({ name, at: e.doc.histLen() })
          saidEdit(name, `cropped to ${r.w}×${r.h}`, mine.length)
        }
      } catch (err) {
        push('crop failed · ' + String(err instanceof Error ? err.message : err).slice(0, 120))
      }
      e.setBusy('')
    },
    [push, saidEdit, editAll],
  )

  const doCrop = useCallback(() => {
    const e = edRef.current
    if (!e) return
    if (e.status().cropping) {
      e.cancelCrop()
      return
    }
    const id = e.status().assetSel
    if (!id) {
      push('click an asset first')
      return
    }
    e.startCrop((r) => {
      if (r) void applyCrop(id, r)
    })
  }, [applyCrop, push])

  // a double click on a placement opens the crop box, so the editor needs a way
  // back into this callback
  useEffect(() => {
    const e = edRef.current
    if (e) e.cropReq = doCrop
  }, [doCrop])

  /* z PUTS THE PIXELS BACK TOO.
   *
   * The editor asks first and says how deep its undo stack is. An edit only
   * answers when z has arrived back at the depth it was filed at, so a crop
   * followed by three moves needs four presses to reach and the three moves
   * come off first, exactly as they would without any of this.
   *
   * The revert is a round trip and the document undo is not, so they do not
   * finish together. That is fine and is why the anchors come back regardless:
   * the placements land in the right places immediately and the art catches up
   * a moment later, rather than the two disagreeing forever, which is the bug
   * this replaces. */
  useEffect(() => {
    const e = edRef.current
    if (!e) return
    e.beforeUndo = (depth: number) => {
      const top = pixelUndo.current[pixelUndo.current.length - 1]
      if (!top || top.at !== depth) return
      pixelUndo.current.pop()
      void (async () => {
        try {
          const r = await api.assetRevert(e.sceneId, top.name)
          setLib((prev) => [...(prev || []).filter((x) => x.name !== r.item.name), r.item])
          e.bustAssets(folderOf(r.item))
          setBust((q) => ({ ...q, [r.item.name]: Date.now() }))
          e.refreshPlacementsOf(r.item)
          push(`${top.name} is back the way it was`)
        } catch (err) {
          push('z could not put the pixels back · ' + String(err instanceof Error ? err.message : err).slice(0, 80))
        }
      })()
    }
    return () => {
      e.beforeUndo = null
    }
  }, [push])

  // ctrl+p and ctrl+t reach the pixel work the same way
  useEffect(() => {
    const e = edRef.current
    if (e) e.bitifyReq = (ids: string[]) => void doBitify(ids)
  }, [doBitify])

  useEffect(() => {
    const e = edRef.current
    if (e) e.trimReq = (ids: string[]) => void doTrim(ids)
  }, [doTrim])

  // ---- generate (wiring identical to the previous MAPVIS) --------------
  const run = useCallback(async () => {
    const e = edRef.current
    const p = prompt.trim()
    if (!e || !p) return
    const q = new URLSearchParams(location.search)
    const n = Number(q.get('n') || 4)
    const w = Number(q.get('w') || 688)
    const h = Number(q.get('h') || 384)
    e.setBusy(`generating ${n}`)
    setCands([])
    try {
      const { jobs } = await api.generate(p, n, w, h)
      const live: Cand[] = jobs
        .filter((j) => j.id)
        .map((j) => ({ id: j.id as string, seed: j.seed || 0, state: 'running' as const }))
      setCands(live)
      if (!live.length) {
        e.setBusy('')
        e.say(jobs[0]?.error || 'nothing came back')
        return
      }
      let left = live.length
      for (const c of live) {
        const poll = async () => {
          try {
            const s = await api.jobState(c.id)
            if (s.state === 'running') return setTimeout(poll, 5000)
            left--
            setCands((prev) =>
              prev.map((x) =>
                x.id === c.id
                  ? { ...x, state: s.state, url: s.images && s.images[0] ? 'data:image/png;base64,' + s.images[0] : undefined, error: s.error }
                  : x,
              ),
            )
          } catch (err) {
            left--
            setCands((prev) => prev.map((x) => (x.id === c.id ? { ...x, state: 'failed', error: String(err) } : x)))
          }
          e.setBusy(left > 0 ? `generating ${left}` : '')
          if (left === 0) push('candidates ready · click one to use it')
        }
        setTimeout(poll, 4000)
      }
    } catch (err) {
      e.setBusy('')
      e.say(String(err instanceof Error ? err.message : err))
    }
  }, [prompt, push])

  // how many paintings one press buys, so the confirm can name the real cost
  const candN = Math.max(1, Math.min(6, Number(new URLSearchParams(location.search).get('n') || 4)))

  // the load generate spends, so it arms first and says what it will cost
  const askRun = useCallback(() => {
    if (!prompt.trim() || st?.busy) return
    if (arm('load-gen', 20000)) run()
  }, [prompt, st?.busy, arm, run])

  const pick = useCallback(
    async (c: Cand) => {
      const e = edRef.current
      if (!e || !c.url) return
      const id = `${slug(prompt)}-${c.seed}`
      try {
        const { url } = await api.saveScene(id, c.url)
        await e.loadPainting(url, id)
      } catch {
        await e.loadPainting(c.url, id)
      }
    },
    [prompt],
  )

  const doExport = useCallback(async () => {
    const e = edRef.current
    if (!e || !e.status().hasPainting) return
    e.setBusy('writing')
    try {
      const r = await api.exportBundle(e.bundle())
      e.say(`wrote ${r.files.join(', ')} to ${r.dir}`)
    } catch (err) {
      e.say(String(err instanceof Error ? err.message : err))
    }
    e.setBusy('')
  }, [])

  const doSaveCut = useCallback(async () => {
    const e = edRef.current
    if (!e) return
    const img = e.cutSceneDataURL()
    if (!img) return
    e.setBusy('writing')
    try {
      const r = await api.saveCutPNG(e.status().sceneId, img, e.cutMaskDataURL())
      e.say(`wrote ${r.files.join(', ')} to ${r.dir}`)
    } catch (err) {
      e.say(String(err instanceof Error ? err.message : err))
    }
    e.setBusy('')
  }, [])

  const onDrop = useCallback((ev: DragEvent) => {
    ev.preventDefault()
    const f = ev.dataTransfer.files[0]
    const e = edRef.current
    if (!f || !e) return
    const fr = new FileReader()
    fr.onload = () => e.loadPainting(String(fr.result), slug(f.name.replace(/\.[a-z]+$/i, '')))
    fr.readAsDataURL(f)
  }, [])

  const has = !!st?.hasPainting
  const tool = st?.tool

  // ---- panels ----------------------------------------------------------

  const needPainting = (
    <div className="panel-empty">
      <p>no painting yet</p>
      <button className="primary" onClick={() => gotoStep('load')}>
        go to load
      </button>
    </div>
  )

  const loadPanel = (
    <>
      <div className="panel-cap">bring in one whole painting</div>
      <Sec>generate</Sec>
      <label className="field">
        <input
          value={prompt}
          placeholder="describe the map"
          onChange={(e) => {
            setPrompt(e.target.value)
            disarm()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') askRun()
            if (e.key === 'Escape') e.currentTarget.blur()
          }}
          spellCheck={false}
        />
        <span className="field-desc">
          {candN} paintings to choose from{usd ? ` · ${usd} left` : ''}
        </span>
      </label>
      <button
        className={'primary genbtn' + (armed === 'load-gen' ? ' armed' : '')}
        onClick={askRun}
        disabled={!prompt.trim() || !!st?.busy}
      >
        {armed === 'load-gen' ? `${candN} generations · sure?` : 'generate'}
      </button>
      {cands.length > 0 && (
        <>
          <Sec>pick one</Sec>
          <div className="cands">
            {cands.map((c) => (
              <button
                key={c.id}
                className={'cand' + (c.state === 'running' ? ' wait' : '')}
                onClick={() => pick(c)}
                disabled={c.state !== 'done'}
                title={c.state === 'failed' ? c.error || 'failed' : `seed ${c.seed}`}
              >
                {c.url ? <img src={c.url} alt="" /> : <span>{c.state === 'failed' ? 'failed' : ''}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      <Sec>or open one</Sec>
      <div className="drophint">drop a png on the canvas</div>
      {has && (
        <div className="loaded">
          <span className="dotok" />
          {st?.sceneId} · {st?.w}×{st?.h}
        </div>
      )}
    </>
  )

  const cutPanel = !has ? (
    needPainting
  ) : (
    <>
      <div className="panel-cap">cut the sea · the checkerboard is what the game gets</div>
      <Sec>in one press</Sec>
      <Row
        icon="wave"
        label="remove ocean"
        desc="floods the sea away from the border"
        onClick={() => ed?.autoSea()}
      />
      <Row
        icon="sparkle"
        label="remove specks"
        desc="keeps the biggest landmass, cuts the rest"
        onClick={() => ed?.despeckle()}
      />
      <Row
        icon="eraser"
        label="shave fringe"
        desc="one pixel off the coast per press"
        onClick={() => ed?.shaveEdge()}
      />
      <Sec>by hand</Sec>
      <Row
        icon="bucket"
        label="cut by colour"
        desc="click a colour to cut it"
        kbd="v"
        on={tool === 'cutfill'}
        onClick={() => ed?.setTool('cutfill')}
      />
      {tool === 'cutfill' && (
        <label className="slider">
          <span>
            colour reach <em>{st?.cutTol}</em>
          </span>
          <input
            type="range"
            min={0}
            max={120}
            value={st?.cutTol || 0}
            style={rail(st?.cutTol || 0, 0, 120)}
            onChange={(e) => ed?.setCutTol(Number(e.target.value))}
          />
        </label>
      )}
      <Row
        icon="brush"
        label="cut brush"
        desc="paint the cut by hand"
        kbd="c"
        on={tool === 'cut'}
        onClick={() => ed?.setTool('cut')}
      />
      <Row
        icon="eraser"
        label="restore brush"
        desc="paint cut pixels back to art"
        kbd="x"
        on={tool === 'cuterase'}
        onClick={() => ed?.setTool('cuterase')}
      />
      <Row
        icon="poly"
        label="cut outline"
        desc="click corners · enter closes"
        kbd="n"
        on={tool === 'cutpoly'}
        onClick={() => ed?.setTool('cutpoly')}
      />
      {(tool === 'cut' || tool === 'cuterase') && (
        <label className="slider">
          <span>
            brush size <em>{st?.brush}px</em>
          </span>
          <input
            type="range"
            min={1}
            max={16}
            value={st?.brush || 1}
            style={rail(st?.brush || 1, 1, 16)}
            onChange={(e) => ed?.setBrush(Number(e.target.value))}
          />
        </label>
      )}
      <div className="panel-foot">
        {st && st.cutPx > 0 ? `${st.cutPx.toLocaleString()}px cut so far` : 'nothing cut yet'}
      </div>
      <details className="more">
        <summary>
          <Icon name="dots" /> more
        </summary>
        <Row
          label={st?.cutPreview ? 'show art with cut hatch' : 'show checkerboard result'}
          desc="same cut, two views"
          kbd="t"
          onClick={() => ed?.toggleCutPreview()}
        />
      </details>
      <Keys lines={['v c x n pick a cut tool', 't swaps the two views', 'z undoes']} />
    </>
  )

  const levelsPanel = !has ? (
    needPainting
  ) : (
    <>
      <div className="panel-cap">paint what's walkable and how high</div>
      <Sec>tool</Sec>
      <Row
        icon="wand"
        label="fill by region"
        desc={
          regionsBusy
            ? 'reading regions…'
            : st && st.regions > 0
              ? `click fills · right-click clears · ${st.regions} regions`
              : 'regions not ready'
        }
        kbd="u"
        on={tool === 'region'}
        onClick={() => ed?.setTool('region')}
      />
      <div className="toolrow">
        {(
          [
            ['brush', 'brush', 'b'],
            ['poly', 'poly', 'p'],
            ['rect', 'rect', 'r'],
            ['bucket', 'bucket', 'f'],
            ['eraser', 'eraser', 'e'],
            ['pick', 'pick', 'i'],
          ] as [Tool, IconName, string][]
        ).map(([t, ic, k]) => (
          <button
            key={t}
            className={'tbtn' + (tool === t ? ' on' : '')}
            onClick={() => ed?.setTool(t)}
            data-tip={`${t} · ${k}`}
          >
            <Icon name={ic} />
          </button>
        ))}
      </div>
      {(tool === 'brush' || tool === 'eraser') && (
        <label className="slider">
          <span>
            brush size <em>{st?.brush}px</em>
          </span>
          <input
            type="range"
            min={1}
            max={16}
            value={st?.brush || 1}
            style={rail(st?.brush || 1, 1, 16)}
            onChange={(e) => ed?.setBrush(Number(e.target.value))}
          />
        </label>
      )}
      <Sec>what you are painting</Sec>
      <div className="chips">
        {PAL.map((p) => (
          <button
            key={p.v}
            className={'chip' + (st?.value === p.v ? ' on' : '')}
            onClick={() => ed?.setValue(p.v)}
            data-tip={`${nameOf(p.v)} · key ${p.key}`}
          >
            <span className="chip-sw" style={{ background: `rgb(${p.col.join(',')})` }} />
            <span className="chip-name">{CHIP_LABEL[p.v]}</span>
            <kbd>{p.key}</kbd>
          </button>
        ))}
      </div>
      <div className="lawhint">levels never touch · stairs connect them</div>
      <div className="walkstat">
        <span className="walkpct">
          <TickPct value={st?.pct || 0} />%
        </span>
        <span className="walklabel">of the map is walkable</span>
      </div>
      <details className="more">
        <summary>
          <Icon name="dots" /> more
        </summary>
        <Row
          icon="occ"
          label="occluder outline"
          desc="art that draws over the character"
          kbd="o"
          on={tool === 'occ'}
          onClick={() => ed?.setTool('occ')}
        />
        {st && st.occCount > 0 && (
          <label className="field inline">
            <span>occluder baseline</span>
            <input
              type="number"
              value={st.lastBaseline}
              onChange={(e) => ed?.setBaseline(Number(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
              }}
            />
          </label>
        )}
        <Row
          label={armed === 'clear-mask' ? 'clear everything · sure?' : 'clear all levels'}
          desc="wipes levels, occluders and cut · z undoes"
          onClick={() => {
            if (arm('clear-mask')) ed?.clearMask()
          }}
        />
      </details>
      <Keys lines={['u b p r f e i pick a tool', '0-7 pick a level · [ ] brush size', 'm hides the overlay · z undoes']} />
    </>
  )

  // the map's anchors. Every named place, not only the doors.
  const doors = st?.events ?? []
  const editingDoor = doors.find((v) => v.id === doorEdit)

  const testPanel = !has ? (
    needPainting
  ) : (
    <>
      <div className="panel-cap">prove it on foot before it ships</div>
      <Sec>walk</Sec>
      <Row
        icon="walk"
        label={st?.walking ? 'stop the walk test' : 'walk the map'}
        desc="wasd or arrows · blocked moves flash red"
        kbd="space"
        on={st?.walking}
        onClick={() => ed?.toggleWalk()}
      />
      <Row
        icon="pin"
        label="set start point"
        desc="under the cursor, or the walker mid-test"
        onClick={() => ed?.setSpawnHere()}
      />
      <Sec>check the ground</Sec>
      <Row
        icon="heal"
        label="fix gaps"
        desc="closes 1px seams between shapes"
        onClick={() => ed?.heal()}
      />
      <Row
        icon="flag"
        label="check reach"
        desc="stranded ground turns red"
        onClick={() => ed?.check()}
      />
      <Sec>doors</Sec>
      <Row
        icon="door"
        label={doorPick ? 'click the map for the door' : 'add door'}
        desc={doorPick ? 'right-click or esc cancels' : 'a spot that leads to another map'}
        on={doorPick}
        onClick={armDoor}
      />
      {editingDoor && (
        <div className="doorform">
          {/* THE NAME IS THE IDENTITY, and it is first for that reason. It is
              the string a member writes in python. The label below is only what
              a player reads, and keeping them apart is the whole point: renaming
              a door for the player must not break somebody's island. */}
          <label className="anchfield">
            <span>name · what code calls it</span>
            <input
              className={'anchname' + (nameSaid?.id === editingDoor.id ? ' bad' : '')}
              value={nameDraft ?? editingDoor.name}
              placeholder="maw_entrance"
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                if (nameDraft === null) return
                const r = ed?.renameAnchor(editingDoor.id, nameDraft)
                setNameSaid(r?.why ? { id: editingDoor.id, why: r.why } : null)
                setNameDraft(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
              }}
              spellCheck={false}
              autoFocus
            />
          </label>
          {nameSaid?.id === editingDoor.id && <div className="anchwarn">{nameSaid.why}</div>}
          {editingDoor.meta?.derived === true && (
            <div className="anchwarn">guessed from the label · rename it so python has something real</div>
          )}

          <div className="anchkinds">
            {ANCHOR_KINDS.map((k) => (
              <button
                key={k}
                className={'kbtn' + (editingDoor.kind === k ? ' on' : '')}
                onClick={() => ed?.updateEvent(editingDoor.id, { kind: k })}
                data-tip={ANCHOR_WHAT[k]}
              >
                {k}
              </button>
            ))}
          </div>

          <label className="anchfield">
            <span>label · what a player reads</span>
            <input
              value={editingDoor.label}
              placeholder="Panther's Maw"
              onChange={(e) => ed?.updateEvent(editingDoor.id, { label: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
              }}
              spellCheck={false}
            />
          </label>

          {editingDoor.kind === 'door' && (
            <>
              <label className="anchfield">
                <span>leads to · map</span>
                <input
                  value={editingDoor.to}
                  placeholder="maw-hall"
                  onChange={(e) => ed?.updateEvent(editingDoor.id, { to: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                  }}
                  spellCheck={false}
                />
              </label>
              {/* WITHOUT THIS every door into a map drops the player on that
                  map's single global spawn, so three connected rooms all land
                  you on the same tile whichever way you came in. */}
              <label className="anchfield">
                <span>arrive at · anchor over there</span>
                <input
                  value={editingDoor.toAnchor ?? ''}
                  placeholder="from_hub · blank means that map's spawn"
                  onChange={(e) => ed?.updateEvent(editingDoor.id, { toAnchor: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                  }}
                  spellCheck={false}
                />
              </label>
            </>
          )}

          <div className="doorrad">
            <span>radius</span>
            <button className="mbtn" onClick={() => ed?.updateEvent(editingDoor.id, { r: editingDoor.r - 2 })}>
              −
            </button>
            <em>{editingDoor.r}px</em>
            <button className="mbtn" onClick={() => ed?.updateEvent(editingDoor.id, { r: editingDoor.r + 2 })}>
              +
            </button>
          </div>
          <div className="doorhint">{ANCHOR_WHAT[editingDoor.kind]}</div>
          <div className="dooracts">
            <button
              className="abtn"
              onClick={() => {
                setDoorEdit(0)
                setDoorNew(false)
              }}
            >
              done
            </button>
            {doorNew && (
              <button
                className="abtn danger"
                onClick={() => {
                  ed?.deleteEvent(editingDoor.id)
                  setDoorEdit(0)
                  setDoorNew(false)
                }}
              >
                cancel
              </button>
            )}
          </div>
        </div>
      )}
      {doors.length > 0 && (
        <div className="evrows">
          {doors.map((ev) => (
            <div
              key={ev.id}
              className={'evrow' + (doorEdit === ev.id ? ' sel' : '')}
              onClick={() => {
                setDoorNew(false)
                setDoorEdit(doorEdit === ev.id ? 0 : ev.id)
              }}
            >
              <span className="ev-glyph">⏻</span>
              {/* the NAME leads, because that is what a member types. The label
                  and the target trail behind it in dimmer text. */}
              <span className="ev-name">
                <b className={ev.meta?.derived === true ? 'guessed' : undefined}>{ev.name}</b>
                {ev.kind === 'door' ? (
                  <i>
                    {' → '}
                    {ev.to || '?'}
                    {ev.toAnchor ? ` · ${ev.toAnchor}` : ''}
                  </i>
                ) : (
                  <i> · {ev.kind}</i>
                )}
              </span>
              <button
                className={'arow-x' + (armed === 'door:' + ev.id ? ' armed' : '')}
                data-tip={armed === 'door:' + ev.id ? undefined : 'remove'}
                onClick={(e2) => {
                  e2.stopPropagation()
                  if (!arm('door:' + ev.id)) return
                  ed?.deleteEvent(ev.id)
                  if (doorEdit === ev.id) setDoorEdit(0)
                }}
              >
                {armed === 'door:' + ev.id ? 'sure?' : <Icon name="x" />}
              </button>
            </div>
          ))}
        </div>
      )}
      <Keys lines={['space walks, then space hops · wasd or arrows move · esc stops', 'esc drops an armed door click', 'z undoes']} />
    </>
  )

  // ---- step 5: assets --------------------------------------------------
  const assets: PlacedAsset[] = st?.assets ?? []
  const selAll = st?.assetSelAll ?? []
  const many = selAll.length > 1
  // the inspector is about ONE placement's numbers, so it stands down when a
  // set is picked and the many-at-once row takes its place
  const selA = many ? undefined : assets.find((a) => a.id === st?.assetSel)
  const hiddenSet = new Set(st?.hiddenGroups ?? [])
  const groupNames = [...SUGGESTED_GROUPS]
  for (const a of assets) if (!groupNames.includes(a.group)) groupNames.push(a.group)
  const thumbOf = (a: { src?: string; frames?: string[] }) => a.src || (a.frames && a.frames[0]) || ''
  // one picture off any library item, whichever of the three shapes it is: a
  // png, a folder of frames, or a set of headings
  const shotOf = (a: api.LibItem) => a.src || a.frames?.[0] || a.dirs?.south?.[0] || ''
  /* The movement ask. One value, rendered against one placement or against a
   * whole picked set, because the question is identical either way: say how it
   * moves, then draw where. runLife reads the live selection, so a set gets the
   * one answer applied to all of it. */
  const lifeBoxFor = (id: string) => (
    <div className="lifebox">
      <div className="boxwhat">say what it does · free</div>
      <input
        autoFocus
        value={lifeAsk}
        placeholder="e.g. scuttles about the wet sand, stopping often"
        onChange={(ev) => setLifeAsk(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' && lifeAsk.trim() && !lifeBusy) void runLife(id)
          if (ev.key === 'Escape') {
            setLifeOpen(false)
            ev.currentTarget.blur()
          }
        }}
        spellCheck={false}
      />
      <div className="liferow">
        <button className="abtn tiny" onClick={() => void runLife(id)} disabled={!lifeAsk.trim() || lifeBusy}>
          {lifeBusy ? 'working it out…' : 'send'}
        </button>
        {assets.some((a) => selAll.includes(a.id) && a.life) && (
          <button className="abtn tiny" onClick={() => ed?.setLifeMany(selAll, null)}>
            stand still
          </button>
        )}
        {lifeBusy && (
          <button className="abtn tiny" onClick={doStop}>
            stop
          </button>
        )}
      </div>
      <div className="lifehint">
        {lifeNote ||
          (selAll.length > 1
            ? `send, then draw where all ${selAll.length} may roam · esc leaves them unfenced`
            : 'send, then draw where it may roam · esc there leaves it unfenced')}
      </div>
    </div>
  )

  /* The real price of the armed click, per take.
   *
   * An animated object is two generations, a base sprite then its animation. A
   * sprite is one for the body plus ONE PER DIRECTION for its motion, so eight
   * ways moving is nine. It assumes standard mode, which is the only mode this
   * client ever sends; pro is twenty to forty and this line would be a lie
   * about it.
   *
   * Once the plan exists it is the truth. A sprite the router decided not to
   * animate costs one whatever the still/moving segment says, so the number on
   * the button at the moment of spending is the number that gets bought. */
  const spriteDirs = genPlan?.sprite
    ? genPlan.sprite.anim.how === 'none'
      ? 0
      : CHAR_DIRS
    : genType === 'animated'
      ? CHAR_DIRS
      : 0
  /* Every face the router split out of the ask is one more generation, and the
   * button has to say so BEFORE it is pressed. The whole point of doing the
   * body, the faces and the round off one press is that nobody has to count
   * them, which only holds if the number they see is the number they buy. */
  const spriteFaces = makeWhat === 'sprite' ? (genPlan?.faces || []).length : 0
  const perTake = makeWhat === 'sprite' ? 1 + spriteDirs + spriteFaces : genType === 'animated' ? 2 : 1
  const genCost = genCount * perTake
  // the big preview's zoom: the largest whole multiple that still fits the
  // panel, so a tall plume and a wide splash both land inside the column
  const fxBig = fxP ? ([4, 3, 2, 1].find((z) => Math.max(fxP.width, fxP.height) * z <= 208) ?? 1) : 4

  // the library item a placement was made from, matched by name: that is what
  // the library calls a static png (basename) and an animated folder alike
  const selItem = selA ? (lib || []).find((it) => it.name === assetLabel(selA)) : undefined
  // how many placements draw from the same library row, which is how many a
  // pixel edit would change
  const sameCount = selA ? assets.filter((q) => assetLabel(q) === assetLabel(selA)).length : 0
  const selIsFx = !!(selItem && selItem.kind === 'animated' && selItem.effect)
  /* Animating is about the LIBRARY ROW, never about one copy on the map: it
   * rewrites the art in place under its own name, so every placement of it
   * changes at once. Asking for a placement first was backwards, and it meant
   * clicking a thing in the library and finding nothing there. */
  const libItem = st?.placing ? (lib || []).find((it) => it.name === st.placing) : undefined
  const animItem = selItem || libItem
  /* Does the selected thing MOVE today.
   *
   * kind cannot answer it. A set of headings is kind 'static' whether each
   * heading holds one frame or a whole walk cycle, so the only honest test is
   * how many frames a heading has. Getting this wrong would put "replaces what
   * it does now" on a still and hide it from a walker. */
  const selWays = animItem?.dirs ? Object.keys(animItem.dirs).length : 0
  const selMoves = !!(
    animItem &&
    (animItem.kind === 'animated'
      ? (animItem.frames?.length ?? 0) > 1
      : (Object.values(animItem.dirs ?? {})[0]?.length ?? 0) > 1)
  )
  /* The price, before the read as well as on the button after it.
   *
   * The read is free and it can come back free, so the line before it is a
   * CEILING, not a promise: eight headings is at most eight and a written
   * recipe is none. Said up front because by the time the plan is on screen he
   * has already decided whether this was worth asking for. */
  const animMost = selWays || 1
  // said the same way everywhere: an eight-heading job is minutes, and a label
  // that never changes for five of them is indistinguishable from a hang
  const animWait = animPlan
    ? animPlan.path === 'character'
      ? `${(animPlan.headings || []).length || selWays} headings in one job · five to fifteen minutes`
      : animPlan.path === 'sprite'
        ? 'one picture · a minute or two'
        : 'nothing is spent'
    : ''
  const animBlocked = animPlan?.path === 'blocked'
  const animLabel = animRun
    ? `${animRun.plan.path === 'character' ? 'every heading together' : 'animating it'} · ${mmss(animSecs)}`
    : animBusy
      ? 'reading it…'
      : animBlocked
        ? 'it cannot be done this way'
        : animPlan
          ? animPlan.price === 0
            ? // zero, and it means zero: the written path never touches pixellab
              'free · write it instead'
            : `${animPlan.price} generation${animPlan.price === 1 ? '' : 's'} · ${selMoves ? 'replace what it does' : 'animate it'}`
          : 'read the ask · free'
  const animDesc = animRun
    ? animRun.plan.path === 'character'
      ? // what a stop is still worth once this is running
        'pixellab is drawing every heading in one job · stopping saves the ones not asked for yet'
      : 'pixellab is drawing · already paid for'
    : animBlocked
      ? animPlan?.why || 'that cannot be done to this one'
      : animPlan
        ? `${animPlan.note || animPlan.motion} · ${animPlan.frames} frames · ${animWait}`
        : `${selWays ? `${selWays} headings` : 'one picture'} · at most ${animMost} generation${animMost === 1 ? '' : 's'}, none if the words need it to travel${selMoves ? ' · replaces what it does now' : ''}${usd ? ` · ${usd} left` : ''}`
  /* The ask, in the make strip's own language: one free-text line, the honest
   * cost under it, and one armed button. Nothing here enumerates what an
   * animation can be. Whatever is typed is what the router has to find a way to
   * draw, the same way the sprite box works.
   *
   * Held as one value because it belongs in two places: beside the other edits
   * to the art when a placement is selected, and under the library grid when a
   * row is, which is where a person actually looks for it. */
  const animBox = animOpen && animItem && (
    <div className="animbox">
      <label className="field">
        <input
          autoFocus
          value={animAsk}
          placeholder={selMoves ? 'e.g. breathes while it stands' : 'e.g. casts the rod out over the water'}
          onChange={(ev) => {
            setAnimAsk(ev.target.value)
            // the plan was priced against the words that were there
            setAnimPlan(null)
          }}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') void doAnim(animItem)
            if (ev.key === 'Escape') {
              setAnimOpen(false)
              ev.currentTarget.blur()
            }
          }}
          spellCheck={false}
        />
        <span className="field-desc">{animDesc}</span>
      </label>
      <div className="genrow">
        {/* the yellow arm is the money colour and it stays that way: a free
            answer is a second press too, but it is not a spend and must not
            shout like one */}
        <button
          className={'primary genbtn' + (animPlan && animPlan.price > 0 ? ' armed' : '')}
          onClick={() => void doAnim(animItem)}
          disabled={!animAsk.trim() || animBusy || !!animRun || animBlocked}
        >
          {animLabel}
        </button>
        {(animBusy || !!animRun) && (
          <button className="abtn stopbtn" onClick={doStop}>
            stop
          </button>
        )}
      </div>
      {animNote && <div className="lifehint">{animNote}</div>}
    </div>
  )

  // how far this one placement is above the map's pixel size; 1 means it is
  // already there and the button has no work to offer
  const selBit =
    selItem && selA
      ? bitFactor(selItem.w, selItem.h, selItem.w * Math.abs(selA.sx), selItem.h * Math.abs(selA.sy))
      : 1
  const thumbSrc = (it: api.LibItem) => thumbOf(it) + (bust[it.name] ? `?t=${bust[it.name]}` : '')
  /* Does this row's art move at all. kind cannot answer it: a set of headings
   * is 'static' whether each heading holds one still or eight frames of a walk,
   * so the only honest test is how many frames a heading has. */
  const libMoves = (it: api.LibItem) =>
    it.kind === 'animated' ? (it.frames?.length ?? 0) > 1 : (Object.values(it.dirs ?? {})[0]?.length ?? 0) > 1

  /* Which way a standing figure looks, laid out the way a compass is.
   *
   * Only for a view set, and only while it stands: a walker faces where it is
   * going and lifeAt settles that every frame, so a chosen heading would be
   * overwritten before it was seen. The middle of the grid is empty because
   * there is no such thing as facing nowhere.
   *
   * It rewrites the placement's src, which is where both renderers read the
   * resting heading from, so nothing else has to be told. */
  const FACE_GRID = [
    ['north-west', 'north', 'north-east'],
    ['west', '', 'east'],
    ['south-west', 'south', 'south-east'],
  ] as const
  const faceable = assets.filter((a) => selAll.includes(a.id) && a.dirs && Object.keys(a.dirs).length >= 4 && !a.life)
  const facingNow = faceable.length === 1 ? Object.keys(faceable[0].dirs!).find((k) => faceable[0].dirs![k][0] === faceable[0].src) : ''
  const faceRow = faceable.length > 0 && (
    <div className="facerow">
      <span className="grainlab">facing</span>
      <div className="facegrid">
        {FACE_GRID.flat().map((k, i) =>
          k && faceable[0].dirs![k] ? (
            <button
              key={k}
              className={'abtn tiny' + (k === facingNow ? ' on' : '')}
              data-tip={k}
              onClick={() => {
                const n = ed?.faceAsset(faceable.map((a) => a.id), k) || 0
                if (n) push(n > 1 ? `${n} now face ${k} · z undoes` : `facing ${k} · z undoes`)
              }}
            >
              <span className="facearrow">{'↖↑↗←·→↙↓↘'[i]}</span>
            </button>
          ) : (
            <span key={'gap' + i} className="facegap" />
          ),
        )}
      </div>
    </div>
  )

  // the selected placement, in numbers you can type. Every field commits on
  // enter or blur and each commit is one undo step, so a typed 0.62 walks back
  // exactly like a dragged corner.
  /* How far ctrl+p goes. Shown wherever the button is, because the right amount
   * is a look and only the person looking can call it: "match the map" is the
   * arithmetically correct answer and it came out far too blocky in practice. */
  const grainRow = (
    <div className="grainrow">
      <span className="grainlab">chunk</span>
      <div className="seg" role="radiogroup" aria-label="how chunky">
        {(
          [
            [3, 'a little'],
            [2, 'more'],
            [1, 'match the map'],
          ] as const
        ).map(([g, label]) => (
          <button
            key={g}
            className={'seg-opt' + (grain === g ? ' on' : '')}
            role="radio"
            aria-checked={grain === g}
            onClick={() => setGrain(g)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )

  const inspector = selA && (
    <div className="insp">
      <div className="insp-head">
        <span className="arow-th">
          <img src={thumbOf(selA)} alt="" />
        </span>
        <span className="insp-name">{assetLabel(selA)}</span>
        <span className={'badge' + (selA.kind === 'animated' ? ' anim' : '')}>
          {selA.kind === 'animated' ? 'anim' : 'static'}
        </span>
        {/* THE TWO THINGS YOU CAN DO TO A PLACED THING, and they say which is
            which in words. They were a sparkle and a wand, two round buttons of
            the same size side by side, and the first question anyone asked on
            seeing them was what the difference was. One is behaviour and free,
            the other draws a picture and spends, and no pair of icons carries
            that. */}
        <span className="insp-acts">
        <button
          className={'actpill' + (lifeOpen ? ' on' : '') + (selA.life ? ' has' : '')}
          data-tip={selA.life ? 'change how it moves · free' : 'give it a way of moving · free'}
          /* Opening one closes the other. They are two different jobs on the
           * same thing and never both at once, but the panel let both boxes
           * stand open, stacked, each with its own greyed example and its own
           * send button. Ash's first read of that was "do i have to type it
           * into both", which is the only thing it could have looked like. */
          onClick={() => {
            setLifeOpen((v) => !v)
            setFaceOpen(false)
            setLifeNote('')
          }}
        >
          <Icon name="sparkle" />
          moves
        </button>
        {/* ANOTHER FACE. One generation, and the only way a thing gets a second
            picture that actually matches it: the endpoint edits the art already
            on the account rather than drawing something new, and for a
            character it edits every heading in one job.

            It is off for a row with nothing on record about what drew it —
            imported off the account, hand-edited, made before origin.json — and
            it says which rather than failing at spend time. */}
        {selItem && (
          <button
            className={'actpill spends' + (faceOpen ? ' on' : '') + (selItem.states?.length ? ' has' : '')}
            data-tip={
              selItem.canState
                ? selItem.states?.length
                  ? `already wears ${selItem.states.map((f) => f.name).join(', ')} · another costs 1`
                  : 'draw it curled up, broken open, asleep, on fire · 1 generation'
                : 'nothing on record says what drew this, so it cannot be edited'
            }
            disabled={!selItem.canState}
            onClick={() => {
              setFaceOpen((v) => !v)
              setLifeOpen(false)
            }}
          >
            <Icon name="wand" />
            becomes
            <span className="pill-cost">1</span>
          </button>
        )}
        </span>
      </div>
      {faceOpen && selItem && (
        <div className="lifebox">
          {/* one line saying what this box does, because a bare input with a
              greyed example in it reads as a field to fill rather than an
              action to take */}
          <div className="boxwhat">
            {selItem.states?.length
              ? `it already wears ${selItem.states.map((f) => f.name).join(', ')} · add another picture`
              : 'draw another picture of this thing, so it has something to change into'}
          </div>
          <input
            autoFocus
            value={faceAsk}
            placeholder="e.g. curled into a mossy boulder"
            onChange={(ev) => setFaceAsk(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && faceAsk.trim() && !faceBusy) void runFace(selItem.name)
              if (ev.key === 'Escape') {
                setFaceOpen(false)
                ev.currentTarget.blur()
              }
            }}
            spellCheck={false}
          />
          <div className="liferow">
            <button
              className="abtn tiny"
              onClick={() => void runFace(selItem.name)}
              disabled={!faceAsk.trim() || faceBusy}
            >
              {faceBusy ? 'drawing…' : '1 generation'}
            </button>
            {faceBusy && (
              <button className="abtn tiny" onClick={doStop}>
                stop
              </button>
            )}
          </div>
        </div>
      )}
      {lifeOpen && lifeBoxFor(selA.id)}
      {selA.life && !lifeOpen && (
        <div className="lifeline">
          <span>
            {selA.life.kind}
            {selA.life.walkOnly
              ? ` · on the floor (${Math.round((selA.life.walkPct ?? 0) * 100)}%)`
              : selA.life.bounds
                ? ' · in the box'
                : ' · free'}
          </span>
          <button className="abtn tiny" data-tip="same idea, different path" onClick={() => ed?.shuffleLife(selA.id)}>
            reshuffle
          </button>
          <button className="abtn tiny" onClick={() => ed?.toggleLifePlay()}>
            {st?.lifePlay === false ? 'play' : 'pause'}
          </button>
        </div>
      )}
      <label className="insp-row">
        <span>group</span>
        <select
          value={selA.group}
          onChange={(e) => {
            ed?.editAsset(selA.id, { group: e.target.value })
            push(`${assetLabel(selA)} → ${e.target.value}`)
          }}
        >
          {groupNames.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </label>
      <div className="numgrid">
        <NumField label="x" value={selA.x} onCommit={(v) => ed?.editAsset(selA.id, { x: v })} />
        <NumField label="y" value={selA.y} onCommit={(v) => ed?.editAsset(selA.id, { y: v })} />
        <NumField
          label="scale x"
          value={selA.sx}
          dp={2}
          step={0.05}
          onCommit={(v) => ed?.editAsset(selA.id, { sx: v })}
        />
        <NumField
          label="scale y"
          value={selA.sy}
          dp={2}
          step={0.05}
          onCommit={(v) => ed?.editAsset(selA.id, { sy: v })}
        />
        <NumField
          label="turn °"
          value={(selA.rot * 180) / Math.PI}
          step={5}
          onCommit={(v) => ed?.editAsset(selA.id, { rot: (v * Math.PI) / 180 })}
        />
      </div>
      <div className="flips">
        <label>
          <input type="checkbox" checked={selA.fx} onChange={() => ed?.flipSelected('x')} /> flip h
        </label>
        <label>
          <input type="checkbox" checked={selA.fy} onChange={() => ed?.flipSelected('y')} /> flip v
        </label>
      </div>
      <div className="actrow">
        <button
          className={'abtn' + (st?.cropping ? ' on' : '')}
          data-tip="trim the art itself"
          onClick={doCrop}
        >
          {st?.cropping ? 'cancel crop' : 'crop'}
        </button>
        <button className="abtn" data-tip="ctrl d" onClick={() => ed?.duplicateSelected()}>
          duplicate
        </button>
        <button className="abtn" data-tip="ctrl c" onClick={() => ed?.copySelected()}>
          copy
        </button>
      </div>
      <div className="actrow">
        {/* it sits with the other edits to the ART, because that is what it is:
            the pixels get rewritten in place under the same name, the way
            trim and pixelate rewrite them. It offers no list of animations. */}
        {animItem && (
          <button
            className={'abtn' + (animOpen ? ' on' : '')}
            data-tip={selMoves ? 'say what it should do instead' : 'say what it should do'}
            onClick={() => {
              setAnimOpen((v) => !v)
              setAnimPlan(null)
            }}
            disabled={plBusy || !!animRun}
          >
            animate
          </button>
        )}
        {selIsFx && selItem && (
          <button className="abtn" data-tip="reopen its knobs" onClick={() => openFx(selItem, [selA.x, selA.y])}>
            edit effect
          </button>
        )}
        {selItem && (
          <button
            className="abtn"
            data-tip="onto the map's own colours"
            onClick={() => openMatch('sel', [selItem], selA.id)}
            disabled={plBusy}
          >
            match to the map
          </button>
        )}
        {selItem && (
          <button
            className="abtn"
            data-tip="ctrl t · cut the slab it stands on"
            onClick={() => void doDebase(selItem, selA.id)}
            disabled={plBusy}
          >
            trim the base
          </button>
        )}
        {selItem && selA && selBit >= 1.25 && (
          <button
            className="abtn"
            data-tip={`ctrl p · ${selItem.w}×${selItem.h} down to ${Math.round(selItem.w * Math.abs(selA.sx) * grain)}×${Math.round(selItem.h * Math.abs(selA.sy) * grain)}, same size on the map`}
            onClick={() => void doBitify([selA.id])}
            disabled={plBusy}
          >
            pixelate
          </button>
        )}
        <button className="abtn danger" data-tip="del" onClick={() => ed?.deleteAsset(selA.id)}>
          delete
        </button>
      </div>
      {/* WHO A PIXEL EDIT LANDS ON, said before it happens rather than after.
          These edits rewrite one library row and every placement draws from it,
          so the tool used to change all of them and never mentioned it. Off by
          default: selecting one tree and cropping nineteen is not what anybody
          means. It only appears when there is more than one, because with a
          single copy the two answers are the same thing. */}
      {selItem && sameCount > 1 && (
        <label className="editall" data-tip="these edits rewrite the picture every copy shares">
          <input type="checkbox" checked={editAll} onChange={(ev) => setEditAll(ev.target.checked)} />
          <span>
            {editAll ? `changes all ${sameCount} copies` : 'changes just this one'}
          </span>
        </label>
      )}
      {selItem && selA && selBit >= 1.25 && grainRow}
      {faceRow}
      {animBox}
    </div>
  )

  // The compare: what came back on one side, the map's colours on the other,
  // one slider between them. Two cells have to sit inside a 272px panel, so 2x
  // is the target and the largest whole multiple that still fits is what
  // shows; a fraction would blur pixel art, and blurred pixels are the wrong
  // thing to judge a colour on.
  const plW = pl && pl.items[0] && pl.items[0].raw[0] ? pl.items[0].raw[0].width : 64
  const plZoom = [2, 1].find((z) => plW * z * 2 + 16 <= 218) ?? 1
  const matchPanel = pl && (
    <div className="fxpanel">
      <div className="fxhead">
        <span className="fxrule">palette</span>
        <span className="fxdesc">
          {pl.mode === 'gen' ? 'what came back, and the same thing on this map' : "the same art on this map's colours"}
        </span>
      </div>
      {/* looked at before he is asked to choose: the chosen one is outlined
          with the reason under it, all of them stay on screen, and one click
          on any other row overrules it.

          A look that says NONE of them are it chooses nothing and says so up
          here instead, because a reason printed under a preselected row is a
          recommendation and this is the opposite of one. Every row is still
          keepable: the pictures are paid for and this is advice. */}
      {looking ? (
        <div className="fxlooking pllook">looking at them…</div>
      ) : said && said.verdict === 'revise' ? (
        <div className="pllook plmiss">{said.why}</div>
      ) : null}
      <div className="plrows">
        {pl.items.map((it, i) => {
          const chosen = pl.pick === i
          /* clickable as soon as the look is over, whatever it said. It used to
             need the tool to have chosen one first, so a look that came back
             "none of these" left three candidates on screen and no way to keep
             just one of them. */
          const pickable = !looking && pl.items.length > 1
          return (
            <div key={it.name}>
              <div
                className={'plrow' + (chosen ? ' chosen' : '') + (pickable ? ' pickable' : '')}
                onClick={pickable ? () => setPl((v) => (v ? { ...v, pick: i } : v)) : undefined}
              >
                {pickable && <span className="plnum">{i + 1}</span>}
                <span className="fxcell">
                  <FxPlay frames={it.raw} zoom={plZoom} fps={it.fps} />
                  <em>raw</em>
                </span>
                <span className="fxcell">
                  <FxPlay frames={plOut[i] || []} zoom={plZoom} fps={it.fps} />
                  <em>matched</em>
                </span>
              </div>
              {chosen && said && said.verdict === 'good' && said.why && <div className="plwhy">{said.why}</div>}
            </div>
          )
        })}
      </div>
      {said && said.fix && (
        <button className="abtn plfix" onClick={() => tryAgain(said.fix)}>
          try again with this
        </button>
      )}
      <div className="fxpal">
        {mapPal.map((c) => (
          <span key={c} style={{ background: c }} title={c} />
        ))}
      </div>
      <label className="slider fxslider">
        <span>
          strength <em>{plStr}%</em>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={plStr}
          style={rail(plStr, 0, 100)}
          onChange={(e) => setPlStr(Number(e.target.value))}
        />
      </label>
      <div className="actrow">
        <button className="abtn" onClick={() => applyMatch('matched')} disabled={plBusy || !plOut.length}>
          {plBusy ? 'writing…' : 'keep matched'}
        </button>
        <button className="abtn" onClick={() => applyMatch('raw')} disabled={plBusy}>
          {pl.mode === 'gen' ? 'keep raw' : 'cancel'}
        </button>
        {pl.mode === 'gen' && (
          <button className="abtn danger" onClick={() => applyMatch('discard')} disabled={plBusy}>
            discard
          </button>
        )}
      </div>
      <div className="fxfoot">
        {mapPal.length} colours off the whole painting · {plZoom}× · nothing is generated here
        {pl.pick >= 0 && pl.items.length > 1 ? ` · keeping one takes the other ${pl.items.length - 1} off` : ''}
      </div>
    </div>
  )

  // The objects already on the account, browsable. Thumbnails come straight
  // off pixellab's own cdn, the search runs over every one of them, and a
  // click copies the png in. Nothing in here can spend anything, and the foot
  // of the panel says so.
  const charList = chars
    ? chars.items.filter((c) => !acc.q.trim() || c.name.toLowerCase().includes(acc.q.trim().toLowerCase()))
    : []

  const accPanel = (
    <div className="accpanel">
      {/* two kinds of thing, said out loud. A prop and a sprite are different
          in pixellab and behave differently here: only the second turns to face
          where it goes. */}
      <div className="seg acctabs" role="radiogroup" aria-label="what to browse">
        {(['objects', 'sprites'] as const).map((t) => (
          <button
            key={t}
            className={'seg-opt' + (accTab === t ? ' on' : '')}
            role="radio"
            aria-checked={accTab === t}
            onClick={() => setAccTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <input
        className="accfind"
        value={acc.q}
        placeholder="find by name"
        onChange={(e) => setAcc((a) => ({ ...a, q: e.target.value, page: 0 }))}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setAcc((a) => ({ ...a, open: false }))
        }}
        spellCheck={false}
      />
      {accTab === 'sprites' ? (
        chars?.err ? (
          <div className="lib-empty">{chars.err}</div>
        ) : chars?.busy ? (
          <div className="lib-empty">reading your account…</div>
        ) : !charList.length ? (
          <div className="lib-empty">no people by that name</div>
        ) : (
          <div className="accgrid">
            {charList.map((c) => (
              <button
                key={c.id}
                className={'acc' + (acc.taking === c.id ? ' on' : '')}
                onClick={() => void takeCharacter(c)}
                disabled={!!acc.taking}
                data-tip={`${c.directions} ways${c.animations ? ` · ${c.animations} animations` : ' · no walk yet'}${c.size ? ` · ${c.size}` : ''}`}
              >
                <span className="acc-th">{c.thumb ? <img src={c.thumb} alt="" /> : null}</span>
                <span className="acc-name">{acc.taking === c.id ? 'adding…' : c.name}</span>
                <span className="acc-sub">
                  {c.directions} ways{c.animations ? ' · walks' : ''}
                </span>
              </button>
            ))}
          </div>
        )
      ) : (
        <>
      {acc.err ? (
        <div className="lib-empty">{acc.err}</div>
      ) : acc.busy && !acc.items.length ? (
        <div className="lib-empty">reading your account…</div>
      ) : !acc.items.length ? (
        <div className="lib-empty">nothing by that name</div>
      ) : (
        <div className="accgrid">
          {acc.items.map((o) => (
            <button
              key={o.id}
              className={'lib' + (acc.taking === o.id ? ' on' : '')}
              data-tip={`${o.w}×${o.h} · ${o.prompt.slice(0, 80)}`}
              disabled={!!acc.taking}
              onClick={() => takeAccount(o)}
            >
              <span className="lib-th">
                <img src={o.thumb} alt="" loading="lazy" />
              </span>
              <span className="lib-name">{o.name}</span>
            </button>
          ))}
        </div>
      )}
          <div className="accfoot">
            <button
              className="abtn"
              disabled={acc.page <= 0 || acc.busy}
              onClick={() => setAcc((a) => ({ ...a, page: a.page - 1 }))}
            >
              back
            </button>
            <span>
              {acc.total} yours · {acc.page + 1}/{acc.pages}
            </span>
            <button
              className="abtn"
              disabled={acc.page >= acc.pages - 1 || acc.busy}
              onClick={() => setAcc((a) => ({ ...a, page: a.page + 1 }))}
            >
              next
            </button>
          </div>
        </>
      )}
      <div className="fxfoot">nothing is generated</div>
    </div>
  )

  /* Many at once.
   *
   * When more than one placement is picked the single-asset numbers are the
   * wrong thing to show — there is no one x to type. What IS useful on a set is
   * the arranging: line them up, space them evenly, mirror them, put them in
   * front of or behind everything else. Same verbs a slide editor has.
   *
   * Stacking is worth a word: the game y-sorts, so "in front" means standing
   * lower down the map, and the button says so rather than implying a z-index
   * the exported bundle does not have. */
  const manyPanel = many && (
    <div className="insp many">
      <div className="insp-head">
        <span className="insp-name">{selAll.length} picked</span>
        {/* one behaviour onto the whole set. Placing a crowd one figure at a
            time and asking each of them separately is the same answer typed
            twelve times, and it is the thing a crowd most obviously wants. */}
        <button
          className={'lifedot' + (lifeOpen ? ' on' : '')}
          data-tip={`give all ${selAll.length} the same way of moving`}
          onClick={() => {
            setLifeOpen((v) => !v)
            setLifeNote('')
          }}
        >
          <Icon name="sparkle" />
        </button>
        <button className="abtn tiny" onClick={() => ed?.setSel([])}>
          clear
        </button>
      </div>
      {lifeOpen && lifeBoxFor(selAll[0])}
      <div className="manygrid">
        {(
          [
            ['left', 'align-l'],
            ['hcenter', 'align-hc'],
            ['right', 'align-r'],
            ['top', 'align-t'],
            ['vcenter', 'align-vc'],
            ['bottom', 'align-b'],
          ] as const
        ).map(([e, icon]) => (
          <button key={e} className="abtn tiny" data-tip={'align ' + e} onClick={() => ed?.align(e)}>
            <Icon name={icon} />
          </button>
        ))}
      </div>
      <div className="manyrow">
        <button className="abtn tiny" data-tip="even gaps across" onClick={() => ed?.distribute('h')}>
          space across
        </button>
        <button className="abtn tiny" data-tip="even gaps down" onClick={() => ed?.distribute('v')}>
          space down
        </button>
      </div>
      <div className="manyrow">
        <button className="abtn tiny" onClick={() => ed?.flipSelected('x')}>
          flip h
        </button>
        <button className="abtn tiny" onClick={() => ed?.flipSelected('y')}>
          flip v
        </button>
        <button className="abtn tiny" onClick={() => ed?.scaleSelected(1 / 1.1)}>
          smaller
        </button>
        <button className="abtn tiny" onClick={() => ed?.scaleSelected(1.1)}>
          bigger
        </button>
      </div>
      <div className="manyrow">
        <button className="abtn tiny" data-tip="stands them lower, so they draw in front" onClick={() => ed?.order('front')}>
          to front
        </button>
        <button className="abtn tiny" data-tip="stands them higher, so they draw behind" onClick={() => ed?.order('back')}>
          to back
        </button>
        <button className="abtn tiny" onClick={() => ed?.duplicateSelected(true)}>
          duplicate
        </button>
        <button className="abtn tiny danger" onClick={() => ed?.deleteSelected()}>
          delete
        </button>
      </div>
      {grainRow}
      <div className="manyrow">
        <button className="abtn tiny" data-tip="ctrl p" onClick={() => void doBitify(selAll)}>
          pixelate
        </button>
        <button className="abtn tiny" data-tip="ctrl t · cut the slab they stand on" onClick={() => void doTrim(selAll)}>
          trim the base
        </button>
      </div>
      <div className="manyfoot">drag moves all · arrows nudge · corners scale the box · ctrl a takes everything</div>
    </div>
  )

  /* Groups, as one line of chips instead of a stacked list with a nested row
   * of every placement inside it. The list was the single tallest thing in the
   * column after the tuner, and what it is actually for is showing counts and
   * turning a layer off while you work under it. */
  const groupStrip = (
    <div className="grpstrip">
      {groupNames
        .map((g) => ({ g, n: assets.filter((a) => a.group === g).length }))
        .filter((q) => q.n > 0)
        .map(({ g, n }) => {
          const hidden = hiddenSet.has(g)
          return (
            <button
              key={g}
              className={'grpchip' + (hidden ? ' off' : '')}
              data-tip={hidden ? 'show ' + g : 'hide ' + g}
              onClick={() => ed?.setGroupHidden(g, !hidden)}
            >
              <Icon name={hidden ? 'eyeoff' : 'eye'} />
              {g}
              <span className="grp-n">{n}</span>
            </button>
          )
        })}
      {!assets.length && <span className="grpnone">nothing placed yet</span>}
    </div>
  )

  const libraryPane = (
    <>
      {/* the library header carries the cheap door out: hundreds of objects
          are already on the account and picking one of those beats asking for
          a new one, so it sits beside the library rather than under create */}
      <div className="sechead">
        <Sec>library</Sec>
        <button
          className={'seclink' + (acc.open ? ' on' : '')}
          data-tip="objects you already own"
          onClick={() => setAcc((a) => ({ ...a, open: !a.open, err: '' }))}
        >
          from my account
        </button>
      </div>
      {acc.open && accPanel}
      {lib === null ? (
        <div className="lib-empty">loading…</div>
      ) : lib.length === 0 ? (
        <div className="lib-empty">nothing here yet · pick one from your account, or make one under create</div>
      ) : (
        <>
          <div className="lib-cap">click one, then the map</div>
          {/* the animate ask, under the row it belongs to. It rewrites the art
              in place under the same name, so it was always about the library
              row rather than about one copy sitting on the map. */}
          {libItem && !selA && (
            <div className="actrow">
              <button
                className={'abtn' + (animOpen ? ' on' : '')}
                data-tip={selMoves ? 'say what it should do instead' : 'say what it should do'}
                onClick={() => {
                  setAnimOpen((v) => !v)
                  setAnimPlan(null)
                }}
                disabled={plBusy || !!animRun}
              >
                animate {libItem.name}
              </button>
            </div>
          )}
          {!selA && animBox}
          <div className="libpanel">
            <div className="libgrid">
              {lib.map((it) => (
                <div key={it.name} className="libwrap">
                  <button
                    className={'lib' + (st?.placing === it.name ? ' on' : '')}
                    onClick={() => {
                      stopPick()
                      ed?.armPlace(it)
                    }}
                    data-tip={`${it.w}×${it.h}${libMoves(it) ? ' · moves' : ''}${
                      it.dirs ? ` · ${Object.keys(it.dirs).length} ways` : ''
                    }`}
                  >
                    <span className="lib-th">
                      <img src={thumbSrc(it)} alt="" />
                    </span>
                    <span className="lib-name">{it.name}</span>
                    {/* a set of headings is kind 'static' whether each heading
                        holds one frame or a whole walk cycle, so nothing in this
                        row told them apart and a walker looked like a statue */}
                    {libMoves(it) && <span className="lib-moves" aria-label="moves" />}
                  </button>
                  {it.effect && (
                    <button className="lib-edit" data-tip="edit effect" onClick={() => openFx(it)}>
                      <Icon name="pencil" />
                    </button>
                  )}
                  <button
                    className={'lib-x' + (armed === 'lib:' + it.name ? ' armed' : '')}
                    data-tip={armed === 'lib:' + it.name ? undefined : 'delete for good'}
                    onClick={() => {
                      if (arm('lib:' + it.name)) removeLib(it)
                    }}
                  >
                    {armed === 'lib:' + it.name ? 'sure?' : <Icon name="x" />}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )

  /* One button, and what it says depends on where you are: reading is free and
   * says so, spending states the price first, and a run in flight reports which
   * of how many it is on. Two presses to spend, always. */
  const doMake = useCallback(() => {
    if (makeWhat === 'effect') return void armFx()
    // a planned set is the same second press whichever ask produced it: fill
    // asked for an area, an asset ask turned out to be more than one thing
    if (scene) return void runMany()
    if (makeWhat === 'fill') return void doScenePlan()
    // a sprite runs the same two presses a thing does now. It used to be one
    // armed press against a row of dropdowns, which is what the router replaced.
    return void doGen()
  }, [makeWhat, scene, armFx, runMany, doScenePlan, doGen])

  const wantedInScene = scene ? scene.items.length - sceneOff.size : 0
  /* The real total behind an armed set, and it is the multiplication nobody
   * does in their head: an animated thing is a base plus its frames, so nine
   * of them is eighteen. Same arithmetic whether the set came from a fill or
   * from an ask that turned out to be more than one thing, because past the
   * plan they are the same run. */
  const manyGens = wantedInScene * perTake
  const makeArmed = makeWhat === 'effect' ? fxPick : !!scene || (makeWhat !== 'fill' && !!genPlan)
  const makeOff =
    genBusy ||
    !!genRun ||
    !!fillRun ||
    !!charRun ||
    (makeWhat === 'effect'
      ? !fxAsk.trim() || fxBusy || !!fx
      : makeWhat === 'fill'
        ? // the same rest state the other three have. It used to sit lit and
          // pressable while its own label said "box the area first", which is a
          // button telling you not to press it in the one colour that says
          // press me. No box is nothing to read and nowhere to draw, and it is
          // the only thing fill needs before it can do either.
          !genBox
        : !genPrompt.trim() || (makeWhat === 'object' && genPick))
  // the sprite plan's own words for what it decided to make move, so the busy
  // line says hovering rather than walking when that is what it bought
  const spriteMoves = genPlan?.sprite && genPlan.sprite.anim.how !== 'none'
  const takes = genRun && genRun.total > 1 ? `${Math.min(genRun.done + 1, genRun.total)}/${genRun.total} · ` : ''
  const makeLabel = charRun
    ? // the one wait long enough to look broken, so it counts
      `${takes}${spriteMoves ? 'drawing it, then the motion' : 'drawing it'} · ${mmss(charSecs)}`
    : fillRun
      ? // a planned item writes its own words long, "a weathered fishing net
        // draped over a barrel beside the quay". The button holds one height and
        // hides what does not fit, so an uncapped line loses its tail with
        // nothing to show for it. Cut it here, where the ellipsis is meant.
        `${fillRun.done + 1}/${fillRun.total} · ${fillRun.what.length > 34 ? fillRun.what.slice(0, 33).trimEnd() : fillRun.what}…`
      : genRun
        ? genRun.total > 1
          ? `generating ${Math.min(genRun.done + 1, genRun.total)}/${genRun.total}…`
          : 'generating…'
        : genBusy
          ? makeWhat === 'fill'
            ? 'reading the area…'
            : 'reading the map…'
          : fxBusy
            ? 'reading the ask…'
            : genPick || fxPick
              ? 'click where it goes'
              : makeWhat === 'effect'
                ? 'make it move'
                : /* a planned set states its real total whichever ask planned
                     it, and it is the total for the rows still in the list, so
                     striking one out changes the number on the button */
                  scene
                  ? `${manyGens} generation${manyGens === 1 ? '' : 's'} · draw ${wantedInScene === 1 ? 'it' : 'them'}`
                  : makeWhat === 'fill'
                    ? genBox
                      ? 'read the area · free'
                      : 'box the area first'
                    : genPlan
                      ? `${genCost} generation${genCost === 1 ? '' : 's'} · ${genCount > 1 ? 'draw them' : 'draw it'}`
                      : 'read the map · free'
  /* The multiplication is the part nobody does in their head: four takes of a
   * moving sprite is thirty-six generations. Said before the read as well as
   * on the button after it, because the read is where he decides whether four
   * was a sensible number and by then it is too late to be told. */
  const takeWord = genCount === 1 ? '' : `, ${genCount} takes · ${genCost} generations`
  /* Fill's own multiplication, and it is the biggest one in the panel: an
   * animated thing is a base plus its frames, so twenty-four of them is
   * forty-eight generations. It was the one mode that named no number before it
   * read, which put the largest spend here behind the least warning. */
  const fillGens = fillCount * (genType === 'animated' ? 2 : 1)
  const fillWord = `${fillCount} different thing${fillCount === 1 ? '' : 's'} · ${fillGens} generation${fillGens === 1 ? '' : 's'}`
  const makeDesc =
    makeWhat === 'effect'
      ? 'free · built from this map’s colours'
      : makeWhat === 'sprite'
        ? charRun
          ? /* what a stop is still worth: the body is paid for the moment it is
             * asked for, the eight directions of motion are not */
            spriteMoves
            ? 'pixellab is drawing · stopping before the motion saves eight'
            : 'pixellab is drawing · already paid for'
          : /* said honestly: this is minutes, not the seconds an object takes,
             * and the motion is what most of them go on */
            `${CHAR_DIRS} ways${genType === 'animated' ? ' + motion' : ''} · ${genType === 'animated' ? 'five to fifteen minutes' : 'two to five minutes'}${takeWord}${usd ? ` · ${usd} left` : ''}`
        : makeWhat === 'fill'
          ? `${genBox ? `the boxed ${genBox.w}×${genBox.h}` : 'box an area'} · ${fillWord}${usd ? ` · ${usd} left` : ''}`
          : /* the ask turned out to be several. It says so here rather than
               going on describing one png, and it says where they land, because
               that is the one thing this differs from a fill in. */
            scene
            ? `${wantedInScene} thing${wantedInScene === 1 ? '' : 's'} · ${manyGens} generation${manyGens === 1 ? '' : 's'} · into the library${usd ? ` · ${usd} left` : ''}`
            : `${genBox ? `reads the boxed ${genBox.w}×${genBox.h}` : 'reads the whole map'} · ${genType === 'animated' ? 'sprite + 8 frames' : 'one png'}${takeWord}${usd ? ` · ${usd} left` : ''}`

  /* ---- the make strip -------------------------------------------------
   *
   * ONE ask box. There used to be two stacked here, an object one and an
   * effect one, running the identical gesture: type what you want, point at
   * the map, get a thing placed. Two of everything for one idea. The three-way
   * says which kind, the box says where, and the same words go to whichever
   * planner is right for it.
   *
   * fill is the third: the boxed area gets read once and a whole set of things
   * is planned into it at once, which is the same job as placing forty sprites
   * by hand, done by looking at the painting instead. */
  const makeStrip = (
    <div className="make">
      <div className="seg makewhat" role="radiogroup" aria-label="what to make">
        {(
          [
            ['object', 'an asset'],
            // not "a person". A person is one of the things this can be, and
            // naming the mode after it told everybody the rest were not allowed.
            ['sprite', 'a sprite'],
            ['effect', 'motion'],
            ['fill', 'fill an area'],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            className={'seg-opt' + (makeWhat === m ? ' on' : '')}
            role="radio"
            aria-checked={makeWhat === m}
            onClick={() => {
              setMakeWhat(m)
              setGenPlan(null)
              setScene(null)
              // the line about the last thing that came back belongs to the
              // mode that drew it, so it goes with the mode
              setSaid(null)
              // the takes go back to one with the plan. Eight of them set
              // against a thing, which is eight generations, is seventy-two the
              // moment the mode says sprite, and a number chosen for one price
              // is not a number he agreed to at the other.
              setGenCount(1)
              // an arm does not survive a change of mind about what is being
              // made, or the next press spends on the new thing
              disarm()
              stopPick()
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="field">
        <input
          value={makeWhat === 'effect' ? fxAsk : genPrompt}
          placeholder={
            makeWhat === 'effect'
              ? // short because it has to FIT. The long version measured 228px
                // in a 210px box and rendered as "where the fall lai", and this
                // hint is the only instruction motion has.
                'e.g. water splashing at the falls'
              : makeWhat === 'fill'
                ? 'anything to steer it, or leave empty'
                : makeWhat === 'sprite'
                  ? /* Deliberately not a person and not an animal: whatever is
                       typed here is what the router has to find a rig for.
                       It also names what it TURNS INTO, because one ask can
                       carry the body, the pictures it changes between and the
                       whole round, and this hint is the only place anybody
                       finds that out. A troll fits the box; a fisherman with a
                       lantern does not say the second half is allowed. */
                    'e.g. a troll that curls into a boulder and rolls'
                  : /* one thing or several, in the same box. This hint is the
                       only place anybody finds out that a plural ask is allowed,
                       and like the effect one it has to fit the box rather than
                       be clipped halfway through the second half. */
                    genType === 'animated'
                    ? 'e.g. a campfire · or three of them'
                    : 'e.g. a stone well · or a few crates'
          }
          onChange={(ev) => {
            if (makeWhat === 'effect') {
              setFxAsk(ev.target.value)
              if (fxPick) {
                setFxPick(false)
                ed?.pickPoint(null)
              }
            } else {
              setGenPrompt(ev.target.value)
              setGenPlan(null)
              setScene(null)
              stopPick()
            }
          }}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') doMake()
            if (ev.key === 'Escape') ev.currentTarget.blur()
          }}
          spellCheck={false}
        />
        <span className="field-desc">{makeDesc}</span>
      </label>
      {/* still or moving, and it means the same thing in all three modes that
          have it. For a sprite it does not mean a walk cycle: it means the
          router decides what moving IS for that thing, which is one foot in
          front of the other for a fisherman and wings beating for a dragon. */}
      {makeWhat !== 'effect' && (
        <div className="segrow">
          <div className="seg" role="radiogroup" aria-label="still or moving">
            {(['static', 'animated'] as const).map((t) => (
              <button
                key={t}
                className={'seg-opt' + (genType === t ? ' on' : '')}
                role="radio"
                aria-checked={genType === t}
                onClick={() => {
                  setGenType(t)
                  // the plan was written for the other answer, so it is not the
                  // plan for this one
                  setGenPlan(null)
                  setScene(null)
                  stopPick()
                }}
              >
                {t === 'static' ? 'still' : 'moving'}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Two sliders, same rail, and they do not mean the same thing. Fill's
          count is a set of DIFFERENT things planned into one area. This one is
          takes on ONE thing, the same core asset drawn again from another seed,
          which is why the words under it say so. */}
      {makeWhat === 'fill' ? (
        <label className="fillnum">
          <span>how many</span>
          <input
            type="range"
            min={1}
            max={24}
            value={fillCount}
            style={rail(fillCount, 1, 24)}
            onChange={(ev) => {
              setFillCount(Number(ev.target.value))
              setScene(null)
            }}
          />
          <b>{fillCount}</b>
        </label>
      ) : makeWhat !== 'effect' ? (
        <label className="fillnum">
          <span>takes</span>
          <input
            type="range"
            min={1}
            max={8}
            value={genCount}
            style={rail(genCount, 1, 8)}
            onChange={(ev) => {
              setGenCount(Number(ev.target.value))
              // the price on the button changes, so the confirm it was armed
              // for is no longer the confirm he agreed to
              setGenPlan(null)
            }}
          />
          <b>{genCount}</b>
        </label>
      ) : null}
      {/* a box is context for a drawing on the map, and the sprite endpoint has
          nowhere to put one */}
      {(makeWhat === 'object' || makeWhat === 'fill') && (
        <button
          className={'abtn areabtn' + (genBox ? ' on' : '')}
          onClick={doBox}
          disabled={genBusy || !!genRun || !!fillRun}
        >
          {genBox ? `boxed ${genBox.w}×${genBox.h} · clear` : makeWhat === 'fill' ? 'box the area to fill' : 'box where it goes'}
        </button>
      )}
      <div className="genrow">
        <button className={'primary genbtn' + (makeArmed ? ' armed' : '')} onClick={doMake} disabled={makeOff}>
          {makeLabel}
        </button>
        {/* everything that can be running is listed here on purpose. A wait
            with nothing to press is the failure this button exists for, so a
            new one must be added to this line the day it is written. */}
        {(genBusy ||
          !!genRun ||
          !!fillRun ||
          fxBusy ||
          !!charRun ||
          lifeBusy ||
          animBusy ||
          !!animRun ||
          looking ||
          !!fxRev?.running) && (
          <button className="abtn stopbtn" onClick={doStop}>
            stop
          </button>
        )}
      </div>
      {/* WHAT THE TOOL SAW, under the button that drew it.
          Free, and it is advice: whatever it says, the thing is in the library
          and stays there. An object run opens the compare and the same words go
          in its head, so this is the line for the runs that open no panel at
          all: a sprite, a whole planned set, and any run where the compare could
          not open because the painting had no colours to lock onto yet. */}
      {!pl && (looking || said) && (
        <div className="saidline">
          {looking ? (
            <span className="saidlook">looking at what came back…</span>
          ) : (
            said && (
              <>
                <span className={'saidwhy' + (said.verdict === 'revise' ? ' miss' : '')}>{said.why}</span>
                {said.fix && (
                  <button className="abtn tiny saidgo" onClick={() => tryAgain(said.fix)}>
                    try again
                  </button>
                )}
              </>
            )
          )}
        </div>
      )}
    </div>
  )

  /* ---- the plan cards -------------------------------------------------
   * What the model decided, before anything is bought. One for a single thing,
   * one for a whole area; the area's is a list you can strike items out of, so
   * a plan that is nine-tenths right costs one click rather than a re-read.
   *
   * A sprite's card carries the routing as well as the words, because that is
   * where the decisions that used to be dropdowns now live: which rig, which
   * angle, how big, and what moving means for this particular thing. He should
   * be able to read "lion rig · hovering, wings beating slowly" and know the
   * dragon is not about to try walking. */
  const spriteRoute = genPlan?.sprite
  const planCard = genPlan && (
    <div className="planbox">
      <div className="plannote">{genPlan.note || 'read the map'}</div>
      {spriteRoute && (
        <>
          <div className="planmeta">
            {spriteRoute.skeleton} rig · {spriteRoute.view} · {spriteRoute.size}px · {CHAR_DIRS} ways
          </div>
          <div className="planmeta">
            {spriteRoute.anim.how === 'none'
              ? 'stands still'
              : spriteRoute.anim.how === 'template'
                ? `moves: ${spriteRoute.anim.template}`
                : `moves: ${spriteRoute.anim.action} (written, ${spriteRoute.anim.frames || 8} frames)`}
          </div>
          {spriteRoute.why && <div className="plannote">{spriteRoute.why}</div>}
        </>
      )}
      {/* WHAT ELSE IT HEARD IN THE ASK, shown before anything is bought.
           One sentence can carry a body, the pictures it changes between and a
           whole round, and without this the only sign the second half was
           understood is a bigger number on the button. Each face is a
           generation, so each one is named. */}
      {!!genPlan.faces?.length && (
        <div className="planmeta">
          also draws {genPlan.faces.map((f) => f.name).join(', ')} · {genPlan.faces.length} more
          {genPlan.faces.length > 1 ? ' generations' : ' generation'}
        </div>
      )}
      {genPlan.does && <div className="plannote">then: {genPlan.does}</div>}
      {genPlan.crossing && <div className="planmeta">{genPlan.crossing}</div>}
      <div className="planmeta">
        {/* w and h are the PROP path's size and only the prop path sends them.
            A sprite posts route.size and nothing else, so printing w×h here put
            two different numbers on screen for one thing. The rig line above
            already carries the size a sprite actually gets drawn at. */}
        {spriteRoute ? '' : `${genPlan.w}×${genPlan.h}${genPlan.motion ? ` · ${genPlan.motion}` : ''}`}
        <button className="planshow" onClick={() => setGenShow((v) => !v)}>
          {genShow ? 'hide the words' : 'the words'}
        </button>
      </div>
      {genShow && <div className="planprompt">{genPlan.prompt}</div>}
    </div>
  )

  /* The first take, on screen, with the run held. Continue or stop.
   *
   * Nothing here undoes anything: what is in the picture is already paid for
   * and already in the library. The only question is whether the REST gets
   * bought, and it is asked at the one moment where the answer is still worth
   * money. */
  const gateCard = gate && (
    <div className="planbox gatebox">
      {/* a run of takes is the same thing drawn again, a planned set is several
          different things, and calling the second one a take would be a lie
          about what the picture below is. fillRun is what tells them apart:
          only a set has one. */}
      <div className="plannote">
        {fillRun
          ? `${gate.done} of ${gate.total} drawn · keep going?`
          : `take ${gate.done} of ${gate.total} · keep going?`}
      </div>
      <div className="gateshot">
        <img src={shotOf(gate.item)} alt="" />
      </div>
      <div className="planmeta">
        {gate.item.name} · {gate.item.w}×{gate.item.h}
      </div>
      <div className="actrow">
        <button className="abtn" onClick={() => closeGate(true)}>
          continue
        </button>
        <button className="abtn danger" onClick={() => closeGate(false)}>
          stop · keep this one
        </button>
      </div>
      <div className="fxfoot">
        {gate.total - gate.done} more · {perTake * (gate.total - gate.done)} generations · what is drawn already stays
      </div>
    </div>
  )

  const sceneCard = scene && (
    <div className="planbox">
      <div className="plannote">{scene.note || `${scene.items.length} planned`}</div>
      <div className="scenelist">
        {scene.items.map((it, i) => {
          const off = sceneOff.has(i)
          return (
            <button
              key={i}
              className={'scenerow' + (off ? ' off' : '')}
              title={it.prompt}
              onClick={() =>
                setSceneOff((prev) => {
                  const n = new Set(prev)
                  if (n.has(i)) n.delete(i)
                  else n.add(i)
                  return n
                })
              }
            >
              <span className="scenewhat">{it.what}</span>
              <span className="scenemeta">
                {it.w}×{it.h}
              </span>
            </button>
          )
        })}
      </div>
      {/* the one thing this list does not otherwise say: a fill puts them on
          the map where the plan chose, an asset ask puts them in the library
          and the map is a later click */}
      <div className="planmeta">
        {wantedInScene} of {scene.items.length} · click one to drop it ·{' '}
        {makeWhat === 'fill' ? 'onto the map' : 'into the library'}
      </div>
    </div>
  )

  const fxTuner = fx && fxP && (
        <div className="fxpanel">
          <div className="fxhead">
            <span className="fxrule">{fx.type === 'custom' ? 'written' : fx.type}</span>
            <span className="fxdesc">{fx.type === 'custom' ? CUSTOM_DESC : EFFECT_DESC[fx.type]}</span>
          </div>
          {fxEdit && <div className="fxedit">editing {fxEdit.name}</div>}
          <div className="fxstage">
            <span className="fxcell">
              <FxPlay frames={fxFrames} zoom={1} fps={fpsFor(fxP)} />
              <em>1×</em>
            </span>
            <span className="fxcell">
              <FxPlay frames={fxFrames} zoom={fxBig} fps={fpsFor(fxP)} />
              <em>{fxBig}×</em>
            </span>
          </div>
          {fxNote && <div className="fxwarn">{fxNote}</div>}
          {/* the tool judging its own render, in the open. While it runs he can
              take whatever is on screen and move on; when it stops, one quiet
              line says what it did. He is only asked to judge it after this. */}
          <div className="fxlook">
            {fxRev?.running ? (
              <>
                <span className="fxlooking">
                  looking at it… (pass {fxRev.pass} of {FX_PASSES})
                </span>
                <button className="fxuse" onClick={stopReview}>
                  use this one
                </button>
              </>
            ) : (
              <>
                <span className="fxsaid">{fxRev ? (fxRev.why ? `checked · ${fxRev.why}` : 'checked') : ''}</span>
                <button className="fxshow" onClick={lookAtFx} disabled={!fxFrames.length}>
                  {fxRev ? 'look again' : 'look at it'}
                </button>
              </>
            )}
          </div>
          <div className="seg fxwhose" role="radiogroup" aria-label="colours">
            {(['map', 'own'] as const).map((m) => (
              <button
                key={m}
                className={'seg-opt' + (fx.palette === m ? ' on' : '')}
                role="radio"
                aria-checked={fx.palette === m}
                onClick={() => setFxPalette(m)}
              >
                {m === 'map' ? 'map colours' : 'own colours'}
              </button>
            ))}
          </div>
          <div className="fxpal edit">
            {fx.colors.map((c, i) => (
              <input
                key={i}
                type="color"
                value={c}
                title={c}
                aria-label={'colour ' + (i + 1)}
                onChange={(ev) => setFxColor(i, ev.target.value)}
              />
            ))}
          </div>
          {/* the seven share five fixed knobs; a written effect ships its own,
              so the panel shows whichever it actually has */}
          {fx.type === 'custom' && fx.custom
            ? fx.custom.controls.map((c) => {
                const v = fxP.custom?.[c.key] ?? c.value
                return (
                  <label className="slider fxslider" key={c.key}>
                    <span>
                      {c.label} <em>{c.step < 1 ? v.toFixed(2) : v}</em>
                    </span>
                    <input
                      type="range"
                      min={c.min}
                      max={c.max}
                      step={c.step}
                      value={v}
                      style={rail(v, c.min, c.max)}
                      onChange={(e) => {
                        const n = Number(e.target.value)
                        setFxP((q) => (q ? { ...q, custom: { ...(q.custom || {}), [c.key]: n } } : q))
                      }}
                    />
                  </label>
                )
              })
            : (
                [
                  ['speed', 'speed', 0.2, 3, 0.1],
                  ['size', 'size', 0.2, 3, 0.1],
                  ['count', 'count', 1, 48, 1],
                  ['spread', 'spread', 0.1, 3, 0.1],
                  ['intensity', 'intensity', 0.1, 2, 0.05],
                ] as [keyof EffectParams, string, number, number, number][]
              ).map(([k, label, lo, hi, st2]) => (
                <label className="slider fxslider" key={k}>
                  <span>
                    {label} <em>{st2 < 1 ? Number(fxP[k]).toFixed(2) : Number(fxP[k])}</em>
                  </span>
                  <input
                    type="range"
                    min={lo}
                    max={hi}
                    step={st2}
                    value={Number(fxP[k])}
                    style={rail(Number(fxP[k]), lo, hi)}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setFxP((q) => (q ? { ...q, [k]: v } : q))
                    }}
                  />
                </label>
              ))}
          <div className="seg" role="radiogroup" aria-label="frames">
            {[8, 12, 16].map((n) => (
              <button
                key={n}
                className={'seg-opt' + (fxP.frames === n ? ' on' : '')}
                role="radio"
                aria-checked={fxP.frames === n}
                onClick={() => setFxP((q) => (q ? { ...q, frames: n } : q))}
              >
                {n} frames
              </button>
            ))}
          </div>
          <div className="actrow">
            <button
              className="abtn"
              onClick={() => keepFx(fxEdit ? 'over' : 'new')}
              disabled={fxSaving || !fxFrames.length}
            >
              {fxSaving ? 'writing…' : fxEdit ? 'save' : 'keep'}
            </button>
            {fxEdit && (
              <button className="abtn" onClick={() => keepFx('new')} disabled={fxSaving || !fxFrames.length}>
                save as new
              </button>
            )}
            <button className="abtn danger" onClick={dropFx} disabled={fxSaving}>
              discard
            </button>
          </div>
          {/* what was written for him, read-only. Nothing here is a text
              editor: it is there so the panel is not a black box */}
          {fx.type === 'custom' && fx.custom && (
            <div className="fxrecipe">
              <button className="fxshow" onClick={() => setFxShow((v) => !v)}>
                {fxShow ? 'hide the recipe' : 'show the recipe'}
              </button>
              {fxShow && <pre>{fx.custom.code}</pre>}
            </div>
          )}
          <div className="fxfoot">
            {fxP.width}×{fxP.height} · {fxP.frames} frames · {fpsFor(fxP)} fps · loops
            {fxEdit ? ' · save keeps every placement of it' : ''}
          </div>
        </div>
  )

  /* Every ask this map has been given, in his words, behind one small toggle.
     The library only kept a four-word slug of them, so the thing he typed to
     get a tree he liked was gone the moment the box cleared. It stays shut
     until asked for. */
  const askLog = asks.length > 0 && (
    <div className="askwrap">
      <button className="asktoggle" aria-expanded={asksOpen} onClick={() => setAsksOpen((v) => !v)}>
        your asks · {asks.length}
      </button>
      {asksOpen && (
        <div className="asklog">
          {asks.map((a, i) => (
            <button
              key={a.at + i}
              className="askrow"
              title={'made ' + a.name}
              onClick={() => {
                if (a.kind === 'effect') {
                  setMakeWhat('effect')
                  setFxAsk(a.ask)
                } else {
                  // a sprite put back in the object box comes out a prop shaped
                  // like one, so the mode has to come back with the words. The
                  // on-disk word is still 'character', so old rows replay.
                  setMakeWhat(a.kind === 'character' ? 'sprite' : 'object')
                  setGenPrompt(a.ask)
                }
                disarm()
                setAsksOpen(false)
                push('back in the box · edit it and go again')
              }}
            >
              <span className="askwords">{a.ask}</span>
              <span className="askmade">{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )

  const assetsPanel = !has ? (
    needPainting
  ) : (
    <>
      {/* The make strip is always here, at the top, because making something is
          why you opened this step. Everything else is one context zone below
          it, showing exactly ONE thing chosen by what you are doing.

          The old shape was two tabs, place and create, with an inspector, a
          multi-select panel, a clipboard line, a compare, a 677px effect tuner
          and a library all stacked inside whichever tab you were on. Six
          things competing for a 272px column, each squeezed to a slice. The
          rule now is one at a time and it gets the whole column, so the tuner
          is readable, the library is not three thumbnails tall, and adding
          fill cost no vertical space at all. */}
      {makeStrip}
      <div className="zone">
        {/* the gate goes first. Nothing else can be open while a run is held,
            but saying so here makes it true by construction. */}
        {gateCard ? (
          gateCard
        ) : matchPanel ? (
          matchPanel
        ) : fxTuner ? (
          fxTuner
        ) : sceneCard ? (
          sceneCard
        ) : planCard ? (
          planCard
        ) : manyPanel ? (
          manyPanel
        ) : inspector ? (
          inspector
        ) : (
          libraryPane
        )}
      </div>
      {/* the foot: small, always there, never in the way. The clipboard says
          what it holds wherever you are, the groups are one line of chips, and
          the asks hide behind a toggle. */}
      {st?.clip && (
        <div className="clipline">
          <span>copied · {st.clip}</span>
          <button className="abtn" data-tip="ctrl v" onClick={() => ed?.pasteClipboard()}>
            paste
          </button>
        </div>
      )}
      {groupStrip}
      {askLog}
      <Keys
        lines={[
          'click places · drag moves · del removes',
          'drag empty space to sweep up many · shift click adds or drops one',
          'ctrl a takes everything · esc clears · drag any of them moves the lot',
          'corners scale · edges stretch · ring rotates, shift snaps 15°',
          'arrows nudge, shift 8px · [ ] scale',
          'ctrl c copies · ctrl v pastes · ctrl d duplicates · z undoes',
          'ctrl p pixelates · ctrl t trims the base · both edit the asset itself',
        ]}
      />
    </>
  )

  const exportPanel = !has ? (
    needPainting
  ) : (
    <>
      <div className="panel-cap">write the bundle the game loads</div>
      <Sec>what gets written</Sec>
      <div className="manifest">
        <div className="manifest-to">
          → work/<b>{st?.sceneId}</b>/
        </div>
        <ul>
          <li>
            <b>scene.png</b> the painting, cut pixels transparent
          </li>
          <li>
            <b>levels.png</b> the level under every pixel
          </li>
          <li>
            <b>occluders.png</b> {st && st.occCount > 0 ? `${st.occCount} occluder${st.occCount > 1 ? 's' : ''}` : 'none drawn'}
          </li>
          {st && st.cutPx > 0 && (
            <li>
              <b>cut.png</b> the cut mask, so it reopens
            </li>
          )}
          <li>
            <b>map.json</b> spawn, stairs, encoding, character metrics
            {doors.length ? `, ${doors.length} door${doors.length > 1 ? 's' : ''}` : ''}
          </li>
          <li>
            <b>assets.json</b>{' '}
            {assets.length
              ? `${assets.length} placed asset${assets.length > 1 ? 's' : ''} + pngs`
              : 'none placed'}
          </li>
        </ul>
      </div>
      <button className="primary big" onClick={doExport}>
        <Icon name="export" /> export
      </button>
      {st && st.cutPx > 0 && (
        <details className="more">
          <summary>
            <Icon name="dots" /> more
          </summary>
          <Row
            label="save the cut painting only"
            desc="scene-cut.png · art before mechanics"
            onClick={doSaveCut}
          />
        </details>
      )}
    </>
  )

  const panels: Record<StepId, ReactNode> = {
    load: loadPanel,
    cut: cutPanel,
    levels: levelsPanel,
    test: testPanel,
    assets: assetsPanel,
    export: exportPanel,
  }

  // ---- the screen ------------------------------------------------------
  return (
    <div className="app">
      <header>
        {/* the same wordmark, the same size and face as the home page, and it
            goes there. One product should not have two logos. */}
        <a className="brand" href="/" title="your maps">
          MAPVIS
        </a>
        <nav className="stepper">
          {STEPS.map((s) => (
            <button
              key={s.id}
              className={'step' + (step === s.id ? ' on' : '')}
              onClick={() => gotoStep(s.id)}
            >
              <span className="step-n">{s.n}</span>
              {s.name}
            </button>
          ))}
        </nav>
        <a className="helpbtn backbtn" href="/" data-tip="back to your maps">
          ←
        </a>
        <button className="helpbtn" data-tip="what this tool can do" onClick={() => setHelpOn(true)}>
          ?
        </button>
        <span className="meta">
          {st?.busy && <span className="busy">{st.busy}</span>}
          {has ? `${st?.sceneId} · ${st?.w}×${st?.h}` : 'no painting'}
        </span>
      </header>
      {helpOn && <Help start={step} onClose={() => setHelpOn(false)} />}

      <main>
        <aside className="panel" key={step}>
          {panels[step]}
        </aside>

        <div className="stage" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <canvas ref={canvasRef} />
          {!has && <p className="empty">drop a png here, or generate one in load</p>}
          {st?.walking && <div className="walkbadge">walk test · wasd moves · space stops</div>}
          {!st?.walking && step === 'assets' && st?.placing && !genPick && (
            <div className="walkbadge placebadge">placing {st.placing} · click the map · esc stops</div>
          )}
          {!st?.walking && step === 'assets' && genPick && (
            <div className="walkbadge placebadge">click where it goes · esc cancels</div>
          )}
          {!st?.walking && step === 'assets' && fxPick && (
            <div className="walkbadge placebadge">click where it goes · esc cancels</div>
          )}
          {!st?.walking && step === 'assets' && st?.cropping && (
            <div className="walkbadge placebadge">
              {st.cropKind === 'area'
                ? 'drag a box round the area · enter takes it · esc skips'
                : 'drag the edges to take it in · enter crops · esc cancels'}
            </div>
          )}
          {!st?.walking && step === 'test' && doorPick && (
            <div className="walkbadge placebadge">click where the door stands · esc cancels</div>
          )}
          <div className="toasts">
            {toasts.map((t) => (
              <div key={t.id} className="toast">
                {t.text}
                {t.act && (
                  <button
                    className="toast-act"
                    onClick={() => {
                      setToasts((prev) => prev.filter((q) => q.id !== t.id))
                      t.act?.run()
                    }}
                  >
                    {t.act.label}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </main>

      <footer>
        <span className="read mono">
          {st && st.x >= 0 && has ? `${st.x},${st.y}` : ''}
          {st && st.level >= 0 && has ? ` · ${nameOf(st.level)}` : ''}
          {st?.occ ? ` · occ${st.occ}` : ''}
          {st?.cut ? ' · cut' : ''}
        </span>
        <span className="grow" />
        {has && (
          <>
            <span className="read mono dim">{st?.zoom}×</span>
            <span className="read mono">
              <TickPct value={st?.pct || 0} />% walkable
            </span>
            {st && st.occCount > 0 && <span className="read mono dim">{st.occCount} occ</span>}
            {st && st.cutPx > 0 && <span className="read mono dim">{(st.cutPx / 1000).toFixed(0)}k cut</span>}
            {assets.length > 0 && <span className="read mono dim">{assets.length} assets</span>}
            <span className="mapsize">
              <span className="dim">map size</span>
              {(
                [
                  ['top', '↑'],
                  ['bottom', '↓'],
                  ['left', '←'],
                  ['right', '→'],
                ] as ['top' | 'bottom' | 'left' | 'right', string][]
              ).map(([side, arrow]) => (
                <button
                  key={side}
                  className="mbtn"
                  data-tip={`grow ${side} +${growPx}px`}
                  onClick={() => ed?.growCanvas(side, growPx)}
                >
                  {arrow}
                </button>
              ))}
              <input
                className="mpx"
                type="number"
                min={1}
                max={2048}
                value={growPx}
                onChange={(e) => setGrowPx(Math.max(1, Math.min(2048, Math.round(Number(e.target.value) || 0))))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                }}
              />
              <span className="dim">px</span>
            </span>
          </>
        )}
        <span className="read dim hint">space walks, then hops · z undoes</span>
      </footer>
    </div>
  )
}
