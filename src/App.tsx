/* one screen, six steps: load, cut, levels, test, assets, export; only how a human reaches them changed. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, ReactNode } from 'react'
import { Editor, isCutTool, loadImage, groupFor, type EditorStatus, type Tool } from './core/editor'
import {
  PAL,
  mkCanvas,
  nameOf,
  assetLabel,
  anchorName,
  anchorShape,
  isLookName,
  lookOf,
  ANCHOR_KINDS,
  ANCHOR_R_MIN,
  ANCHOR_R_MAX,
  MAP_CLASSES,
  PATH_KINDS,
  type AnchorKind,
  type MapAnchor,
  type AssetLook,
  type MapClass,
  type PlacedAsset,
  ANCHOR_META_RESERVED,
  type StairRegion,
} from './core/mask'

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

/* what a zone is, per kind: a shared word lets an author draw the object instead of the ground beside it. */
const ANCHOR_ZONE: Record<AnchorKind, string> = {
  point: 'the ground close enough to count as being here',
  region: 'the area the player has to be inside for it to fire',
  door: 'the doormat · stand anywhere in it and the prompt is there',
  post: 'the side you can reach it from · draw the floor, not the table',
  spawn: 'the patch a body may land in when it arrives here',
  trigger: 'the ground that sets it off when it is crossed',
}

/* the drawn tile each kind wears in the list, replacing a raw ⏻ that said the same thing for every kind. */
const ANCHOR_ICON: Record<AnchorKind, IconName> = {
  point: 'pin',
  region: 'rect',
  door: 'door',
  post: 'flag',
  spawn: 'walk',
  trigger: 'trigger',
}

/* what a route's kind means, said once and read by the chips in the form and by
 * the tooltip on the row, so the two cannot drift into two answers */
const PATH_WHAT: Record<(typeof PATH_KINDS)[number], string> = {
  walk: 'a body walks it, so every leg is held to ground it can stand on',
  sail: 'it leaves the floor on purpose · no ground check',
  camera: 'a camera move · no feet, so nothing to check',
}
import { Help } from './ui/Help'
/* what a person reads, given a thing whose `name` is a python identifier. This
   is the surface that CREATES those identifiers, which makes it the last place
   that should have been printing one where a name belongs. */
import { displayName, readable } from './core/naming'
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

/* the eight headings; four throws away half of life.ts's eight-way facing. the empty middle is the caller's. */
/* what each map class means. the engine guessed it off a transparent border instead of being told. */
const MAP_CLASS_WHAT: Record<MapClass, string> = {
  island: 'seen from above, with sea around it · the engine draws the ocean',
  room: 'an interior at character scale · you leave it through a door',
  hall: 'a shared place that is neither · the template for anything members build together',
}

const FACE_GRID = [
  ['north-west', 'north', 'north-east'],
  ['west', '', 'east'],
  ['south-west', 'south', 'south-east'],
] as const

// where a tool lives, so a keyboard tool change can never happen off-screen:
// the workflow follows the key instead of hiding the mode
const homeStep = (t: Tool): StepId =>
  isCutTool(t) ? 'cut' : 'levels'

// the chips, in plain words; values and canvas colours stay PAL's
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
  /* an offer on the toast: z cannot undo a pixel edit, and nineteen trees were cropped with no way home. */
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

/* one open effect, named because the review loop takes it as an argument and works off values, not state. */
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

/* how many go on one contact sheet; the review route slices to it, so callers cut their own list to match. */
const LOOK_CELLS = 6

/* eight views: life.ts facings are eight-way, so this is an engine requirement and never a routing answer. */
const CHAR_DIRS = 8
/* pro is twenty generations at size 80, which clears a 56x67 reference and fits the server's 32..96 clamp. */
const PRO_BODY = 20
const STYLE_SIZE = 80
/* the style reference lives in the map's bag and not in this file, so mapvis stays a general tool. */
const STYLE_ID = 'styleCharacter'
const STYLE_VIEW = 'styleCharacterView'
const STYLE_NAME = 'styleCharacterName'

// a running wait, said the way a clock says it
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/* webkit has no ::-moz-range-progress, so the fill goes out as a custom property or the rail draws empty. */
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

/* the cache-bust prefix. '' makes bustAssets a no-op, so a view set or plain png kept drawing old pixels. */
const folderOf = (it: api.LibItem): string => {
  const f = (it.frames && it.frames[0]) || (it.dirs && Object.values(it.dirs)[0]?.[0]) || ''
  return f ? f.slice(0, f.lastIndexOf('/') + 1) : it.src || ''
}

/* one library row as one appearance. views before src, or a view set's src loses the other seven headings. */
/* A face, in the shape the renderer draws. Same three shapes as a library row
 * and for the same reason: a state of a walking character is eight headings,
 * and losing them mid-round turns a troll south the moment it becomes a rock. */
/* the face's name rides with the picture, not read off its url; anchorName fixes hyphenated library rows. */
const lookNameOf = (want: string | undefined): string | undefined => {
  const n = anchorName(String(want || ''))
  return isLookName(n) ? n : undefined
}

const lookOfState = (f: api.AssetState): AssetLook => {
  const L: AssetLook = f.frames && f.frames.length
    ? { kind: 'animated', frames: f.frames.slice(), fps: f.fps || 8 }
    : { kind: 'static', src: f.src }
  if (f.dirs && Object.keys(f.dirs).length) {
    L.dirs = { ...f.dirs }
    if (f.fps && f.fps > 0) L.fps = f.fps
  }
  const name = lookNameOf(f.name)
  if (name) L.name = name
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
  const name = lookNameOf(it.name)
  if (name) L.name = name
  return L
}

// ---- the palette lock: pushed onto the map's palette after it lands, arithmetic and not a generation ----

// every frame of a library item, decoded onto its own canvas. The compare
// panel draws these and the lock reads them, so both halves work off the same
// pixels the library is already showing.
/* every picture an item is made of. src on a view set is only the south view, so an edit hit one of eight. */
/* every picture, not the first frame per heading: reading 8 of 64 turned a walk cycle into eight stills. */
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

/* one row. standing descriptions wanted 1073px of rail inside 690px, so only what is true right now stays. */
function Row(props: {
  icon?: IconName
  label: string
  desc?: string
  keep?: boolean
  kbd?: string
  on?: boolean
  disabled?: boolean
  onClick?: () => void
  children?: ReactNode
}) {
  const live = !!props.desc && (props.on || props.keep)
  return (
    <button
      className={'row' + (props.on ? ' on' : '')}
      onClick={props.onClick}
      disabled={props.disabled}
      data-tip={!live && props.desc ? props.desc : undefined}
    >
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
        {live && <span className="row-desc">{props.desc}</span>}
      </span>
      {props.children}
    </button>
  )
}

/* the anchor overlay switch. thirty zones can bury a painting; one component so two panels cannot disagree. */
function AnchorsShown({ ed, on }: { ed: Editor | null; on: boolean }) {
  return (
    <Row
      icon="rect"
      label={on ? 'anchor zones shown' : 'anchor zones hidden'}
      desc="every zone, floor spot, heading and binding, on the map"
      kbd="a"
      on={on}
      onClick={() => ed?.toggleEvents()}
    />
  )
}

// a section header. Every panel labels its groups the same way, so the eye
// learns one shape instead of six.
function Sec({ children }: { children: ReactNode }) {
  return <div className="asec">{children}</div>
}

/* the pairs wrap: at 141px it clipped to "quarry_gate → pant…", one flex item each so a name never breaks. */
function Addr({ parts }: { parts: [string | null, string][] }) {
  return (
    <i>
      {parts.map(([cap, val], k) => (
        <span key={k}>
          {cap ? <em>{cap}</em> : null}
          {cap ? ' ' : null}
          {val}
        </span>
      ))}
    </i>
  )
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
  /* what the field means, when its name does not already say it. On hover, not
     under the block: one shared sentence over six fields is three lines tall
     and only restates the six labels. */
  tip?: string
  onCommit: (v: number) => void
}) {
  const [txt, setTxt] = useState('')
  const [live, setLive] = useState(false)
  const cancel = useRef(false)
  const shown = live ? txt : props.dp ? props.value.toFixed(props.dp) : String(Math.round(props.value))
  return (
    <label className="numf" data-tip={props.tip}>
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

/* held while typed: these setters snapshot undo, so per-keystroke commits undo a name one letter at a time. */
function HeldInput(props: {
  value: string
  placeholder?: string
  className?: string
  tip?: string
  onCommit: (v: string) => void
}) {
  const [txt, setTxt] = useState('')
  const [live, setLive] = useState(false)
  const cancel = useRef(false)
  return (
    <input
      className={props.className}
      data-tip={props.tip}
      value={live ? txt : props.value}
      placeholder={props.placeholder}
      onFocus={() => {
        cancel.current = false
        setTxt(props.value)
        setLive(true)
      }}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => {
        setLive(false)
        if (!cancel.current && txt !== props.value) props.onCommit(txt)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          cancel.current = true
          e.currentTarget.blur()
        }
      }}
      spellCheck={false}
    />
  )
}

/* the condition string: mapvis declares it, python decides what it means, so nothing here looks inside it. */
function WhenField({ what, value, onCommit }: { what: string; value: string; onCommit: (v: string) => void }) {
  return (
    <label className="anchfield" data-tip="mapvis only declares the condition · python decides what it means">
      <span>when · {what} is there</span>
      <HeldInput className="anchname" value={value} placeholder="always" onCommit={onCommit} />
    </label>
  )
}

/* what a placement blocks. blank is better: publish scans the png's alpha; type numbers only to fix a halo. */
function FootField({
  value,
  onCommit,
}: {
  value?: [number, number, number, number]
  onCommit: (f: [number, number, number, number] | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value ? value.join(', ') : '')
  return (
    <label className="insp-row">
      <span data-tip="cx, cy across and down from the feet, then the two radii">blocks</span>
      <input
        value={shown}
        placeholder="measured"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === null) return
          const n = draft
            .split(/[ ,]+/)
            .filter(Boolean)
            .map(Number)
          onCommit(n.length === 4 && n.every((v) => isFinite(v)) ? (n as [number, number, number, number]) : null)
          setDraft(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
        }}
        spellCheck={false}
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

/* Where a map opened by id gets its painting from, in order. The working copy is
 * the live one so it goes first; the published bundle is the copy that always
 * exists once a map has been exported, and it is the road back for a map whose
 * painting never reached the store. `loadPainting` keeps whatever it is given, so
 * arriving by the second road also repairs the first. */
async function paintingFor(id: string): Promise<string | null> {
  const work = `/work/${encodeURIComponent(id)}/scene.png`
  try {
    if ((await fetch(work, { method: 'HEAD' })).ok) return work
  } catch {
    /* no answer is not a painting either, so fall through to the bundle */
  }
  try {
    const r = await fetch(`/api/v1/maps/${encodeURIComponent(id)}`)
    if (!r.ok) return null
    const j = (await r.json()) as { files?: Record<string, { url?: string }> }
    return j.files?.['scene.png']?.url || null
  } catch {
    return null
  }
}

async function openById(ed: Editor, id: string) {
  const src = await paintingFor(id)
  if (!src) {
    ed.say(`${id} has no painting yet · drop one in`)
    return
  }
  try {
    await ed.loadPainting(src, id)
  } catch {
    ed.say(`could not load the painting for ${id}`)
  }
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const edRef = useRef<Editor | null>(null)
  const [st, setSt] = useState<EditorStatus | null>(null)
  const [step, setStep] = useState<StepId>('load')
  const [prompt, setPrompt] = useState('')
  /* THE HAND, CHOSEN BEFORE THE SUBJECT IS TYPED. Empty is Other: the words go
   * out as typed. The list is whatever this account may draw with, which for
   * almost everybody is nothing but their own. */
  const [cards, setCards] = useState<api.StyleCard[]>([])
  const [styleKey, setStyleKey] = useState('')
  const [willDraw, setWillDraw] = useState('')
  const [cands, setCands] = useState<Cand[]>([])
  const [usd, setUsd] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [regionsBusy, setRegionsBusy] = useState(false)
  const [armed, arm, disarm] = useArm()
  const [lib, setLib] = useState<api.LibItem[] | null>(null)
  // the words the author typed, kept so "what did I write to get that tree"
  // has an answer in the app instead of on disk
  const [asks, setAsks] = useState<api.Ask[]>([])
  const [asksOpen, setAsksOpen] = useState(false)
  /* ctrl+p grain, sprite pixels per map pixel. 1 is the strict match and too blocky, so this starts at 2. */
  const [grain, setGrain] = useState(2)
  // the assets panel's two halves, plus a cache stamp on thumbnail urls so rewritten pixels are not served stale
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
  /* objects are props; sprites have a skeleton, directions and cycles. the two are not interchangeable. */
  const [chars, setChars] = useState<{ items: api.AccountCharacter[]; busy: boolean; err: string } | null>(null)
  /* draw the next sprite in the game's style: off is one generation, on is twenty, so off is the default. */
  const [styleOn, setStyleOn] = useState(false)
  const styleId = String(st?.props.meta?.[STYLE_ID] || '')
  const styleView = String(st?.props.meta?.[STYLE_VIEW] || '')
  const styleName = String(st?.props.meta?.[STYLE_NAME] || '')
  const [accTab, setAccTab] = useState<'objects' | 'sprites'>('objects')
  const [genPrompt, setGenPrompt] = useState('')
  const [genType, setGenType] = useState<'static' | 'animated'>('static')
  /* one ask box: two stacked boxes ran the same gesture twice, so a four-way does it with half the controls. */
  const [makeWhat, setMakeWhat] = useState<'object' | 'effect' | 'fill' | 'sprite'>('object')
  /* the button counts out loud: a still label for six minutes is indistinguishable from a hang. */
  const [charRun, setCharRun] = useState<{ at: number } | null>(null)
  const [charSecs, setCharSecs] = useState(0)
  // how many things a fill plans. A range, because "populate this" means
  // something different for a courtyard than for a whole beach.
  const [fillCount, setFillCount] = useState(6)
  /* takes of one thing, not fill's different ones. 1 for a cheap default, 8 max at nine generations a take. */
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
  /* three steps to give a placement movement. esc at the boundary is an answer, so the map is judged instead. */
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
  /* what the pixels do standing still; life moves the placement. the server prices it, never a list here. */
  const [animOpen, setAnimOpen] = useState(false)
  const [animAsk, setAnimAsk] = useState('')
  const [animBusy, setAnimBusy] = useState(false)
  const [animPlan, setAnimPlan] = useState<api.AnimPlan | null>(null)
  /* the run keeps the plan: it is cleared on the confirmed press, and the button still has minutes to narrate. */
  const [animRun, setAnimRun] = useState<{ at: number; plan: api.AnimPlan } | null>(null)
  const [animSecs, setAnimSecs] = useState(0)
  const [animNote, setAnimNote] = useState('')
  // stop: the server-side job to kill, and a flag the loops check between
  // steps so a batch ends after the generation already in flight
  const jobRef = useRef('')
  const stopRef = useRef(false)
  /* a round waits here until the first placement lands. a ref, so it does not re-run the placing effect. */
  const pendingLife = useRef<{ name: string; ask: string } | null>(null)
  /* pixel edits filed with the undo depth they sat at, so z reverts them only on arriving back at that depth. */
  const pixelUndo = useRef<{ name: string; at: number }[]>([])
  /* whether a pixel edit hits every copy of the row; off, because the surprising answer is a bad default. */
  const [editAll, setEditAll] = useState(false)
  /* the first take that landed, held for a yes; a ref so a re-render cannot mint a second promise. */
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
  /* The same hold, for the name on a PLACEMENT. Kept apart from the anchor
   * pair above because both forms can be open at once and one draft between
   * them would put half a typed anchor name into the selected sprite. */
  const [pnameDraft, setPnameDraft] = useState<string | null>(null)
  const [pnameSaid, setPnameSaid] = useState<{ id: string; why: string } | null>(null)
  /* the two anchor fields a person points at rather than types. Both borrow the
   * one-shot map click "add door" already uses; the rectangle needs two, so it
   * holds the first corner while it waits for the second. */
  const [standPick, setStandPick] = useState(0)
  const [rectPick, setRectPick] = useState<{ id: number; from: [number, number] | null } | null>(null)
  /* the radius while typed: clearing the box to type 300 passes through '', which would clamp to the minimum. */
  const [radDraft, setRadDraft] = useState<string | null>(null)
  /* a draft per form: all four can be open at once, and one shared draft puts half a route name into a shot. */
  const [pathEdit, setPathEdit] = useState(0)
  const [rnameDraft, setRnameDraft] = useState<string | null>(null)
  const [rnameSaid, setRnameSaid] = useState<{ id: number; why: string } | null>(null)
  const [shotEdit, setShotEdit] = useState(0)
  const [snameDraft, setSnameDraft] = useState<string | null>(null)
  const [snameSaid, setSnameSaid] = useState<{ id: number; why: string } | null>(null)
  /* one kind:id, not three numbers: only one form is ever open, and stacked forms grew the column off screen. */
  const [collEdit, setCollEdit] = useState('')
  const [collDraft, setCollDraft] = useState<string | null>(null)
  const [collSaid, setCollSaid] = useState('')
  /* the rack slot a drag has hold of, by its NUMBER and never by its position.
   * The number is the whole guarantee a rack exists for, so nothing here can
   * carry an index around and hand it back as an address. */
  const [dragSlot, setDragSlot] = useState(0)
  /* one group's condition field at a time; an input on every group made the layer list the tallest thing here. */
  const [grpWhen, setGrpWhen] = useState('')
  // the map's own id, held while it is typed, because a rename is a server call
  // that can be refused and half a slug is not a thing to send
  const [idDraft, setIdDraft] = useState<string | null>(null)
  // null until somebody asks, because finding them is three flood fills
  const [stairs, setStairs] = useState<StairRegion[] | null>(null)
  const [paintDraft, setPaintDraft] = useState<string | null>(null)
  const [idSaid, setIdSaid] = useState('')
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
  // colors renders; mapColors and ownColors keep the toggle reversible; ask lets a dead recipe fall back free
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
  // the style card read off the painting once, and the map's colours for the palette lock; both are optional
  const [mapPal, setMapPal] = useState<string[]>([])
  // the compare panel; nothing here is written yet, and pick is -1 when nothing looked or none of them are it
  const [pl, setPl] = useState<{
    mode: 'gen' | 'sel'
    selId: string
    items: PlItem[]
    ask: string
    prompt: string
    pick: number
  } | null>(null)
  /* what the look saw, held on the run because most runs open no panel; advice only, the item stays either way. */
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
    /* tools disarm on a step change: a bucket surviving into test cut a hole in the island with one click. */
    e.setPaintable(s === 'cut' || s === 'levels' || s === 'assets')
    /* zones draw on every step; grabbing stays the step's, since the anchor drag runs first and takes the post. */
    e.setEventsEditable(s === 'test' || s === 'export')
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

    /* ?id with no ?img takes the working copy, then the map's own published
     * bundle, and only then says there is no painting. The second road is what
     * was missing: a map whose painting never reached the store answered "drop
     * one in" and stopped, so `loadPainting` never ran, so the upload that would
     * have fixed it never ran either. A published map always carries its own
     * painting, so opening one now repairs it on the way in. */
    const q = new URLSearchParams(location.search)
    const img = q.get('img')
    const id = q.get('id')
    if (img) {
      void ed.loadPainting(img, id || slug(img.split('/').pop() || 'scene')).catch(() => ed.say('could not load ' + img))
    } else if (id) {
      void openById(ed, id)
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

  /* one effect, not a call at each of seven places that move doorEdit; right six times in seven is not trusted. */
  useEffect(() => {
    edRef.current?.selectAnchor(doorEdit)
  }, [doorEdit])

  /* the canvas selection back into the form; zero is not synced, or closing would immediately reopen it. */
  useEffect(() => {
    const sel = st?.anchorSel ?? 0
    if (sel && sel !== doorEdit) setDoorEdit(sel)
  }, [st?.anchorSel])

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

  // and a half-laid route or a half-drawn area the same way, or their clicks
  // would land as corners on a step where neither shape is even drawn
  useEffect(() => {
    if (step !== 'test') {
      edRef.current?.cancelPath()
      edRef.current?.cancelRegionDraw()
    }
  }, [step])

  /* watched, not returned from a handler: two of the three ways a line ends happen outside react. */
  const layingPath = (st?.pathDraw ?? -1) >= 0
  // the same read for an area being walked round. The gesture lives in the
  // editor, so this is how the form knows the shape is still open.
  const drawingRegion = (st?.polyDraw ?? -1) >= 0
  const wasLaying = useRef(false)
  useEffect(() => {
    if (wasLaying.current && !layingPath && st?.pathSel) {
      setPathEdit(st.pathSel)
      setRnameDraft(null)
    }
    wasLaying.current = layingPath
  }, [layingPath, st?.pathSel])

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

  /* only colours here, for the palette lock. every ask carries the painting, since words describing it failed. */
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

  /* stop sets the flag before it resolves so the break and the next-turn check agree; nothing drawn is lost. */
  const closeGate = useCallback((go: boolean) => {
    if (!go) {
      stopRef.current = true
      const j = jobRef.current
      if (j) void api.stop(j).catch(() => {})
    }
    gateRef.current?.(go)
  }, [])

  // ---- picking from what he owns: browsing beats a fresh ask, and every call on this path is a read ----

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
  // the same free listing, fetched when the style toggle is on and the map
  // has not yet been told whose style that is, so the one-time pick has
  // something to pick from
  useEffect(() => {
    if (!styleOn || chars) return
    setChars({ items: [], busy: true, err: '' })
    api
      .accountCharacters()
      .then((r) => setChars({ items: r.items, busy: false, err: '' }))
      .catch((e) => setChars({ items: [], busy: false, err: String(e instanceof Error ? e.message : e).slice(0, 120) }))
  }, [styleOn, chars])

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

  /* the one look at a run, free because the strip is local; advice only, nothing is removed from the library. */
  const lookAt = useCallback(
    async (sid: string, ask: string, prompt: string, all: api.LibItem[]): Promise<api.ObjVerdict | null> => {
      // the sheet holds six, so six is what gets sent. Cut here rather than at
      // the far end, so what the words name is what the picture shows.
      const made = all.slice(0, LOOK_CELLS)
      if (!made.length) return null
      setSaid(null)
      setLooking(true)
      // one line rather than silence when the look cannot happen. Returning
      // having said nothing is indistinguishable from a look that ran and
      // approved.
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
      /* the real size, hidden by a 3x strip. sent only when candidates agree; a wrong number is worse than none. */
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

  /* hold the run after the first landing; four moving sprites is half an hour, and a no throws nothing away. */
  const askGate = useCallback(async (item: api.LibItem, done: number, total: number) => {
    setGate({ item, done, total })
    const go = await new Promise<boolean>((res) => {
      gateRef.current = res
    })
    gateRef.current = null
    setGate(null)
    return go
  }, [])

  /* skeleton, view, size and motion come off the plan; one job id per run, reused, as takes are sequential. */
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
              /* pro overrides mode, size and view. the view must be the reference's, or pro drags the result off angle. */
              ...(styleOn && styleId
                ? {
                    mode: 'pro' as const,
                    styleCharacterId: styleId,
                    size: STYLE_SIZE,
                    ...(styleView ? { view: styleView as api.SpriteRoute['view'] } : {}),
                  }
                : {}),
            })
            if (e.sceneId !== sid) break
            setLib((prev) => [...(prev || []).filter((x) => x.name !== r.item.name), r.item])
            made.push(r.item)
            // a motion that did not happen is said out loud. It still lands,
            // standing, because the body was bought before the motion was ever
            // asked for.
            if (r.note) push(`${r.item.name} · ${r.note}`)
            /* faces before the round, because a round can only name a face that exists; a failed face keeps the body. */
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
            /* the round is free, and held on the plan because nothing has been placed yet for it to be given to. */
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
          /* the first take that landed, not i === 0; a failed first took the gate with it and seven ran unseen. */
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
    [genCount, charRun, askGate, lookAt, push, styleOn, styleId, styleView],
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

  // ---- the palette lock: raw and matched side by side, a human chooses, and both are local so it is free ----

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
  /* cut the pedestal in arithmetic: a prompt refusing ground four times still came back on a stone slab. */
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
          // write through a fresh ImageData the context owns, so the buffer type
          // is whatever this browser wants rather than whatever built it
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

  /* per item, not per placement: forty palms off one png are one trim; items with no base are said out loud. */
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

  /* the factor is not a setting; the placement's scale answers it, and one item at one factor writes one png. */
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
        /* grain, sprite pixels per map pixel; 1 is blockiest since a palm's ground is 24 by 32, so 2 is the default. */
        const tw = Math.max(1, Math.round(item.w * Math.abs(a.sx) * grain))
        const th = Math.max(1, Math.round(item.h * Math.abs(a.sy) * grain))
        // one item, one size, rewritten under one name, so the biggest placement wins or the big one loses detail
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
          // the png keeps its name, so without this the browser answers from
          // cache and the map goes on drawing the replaced pixels
          e.bustAssets(folderOf(res.item))
          setBust((q) => ({ ...q, [res.item.name]: Date.now() }))
          // it shrank, so EVERY placement of it grows by the same amount to
          // stay the size it was, including ones that were never selected,
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
  /* one generation for another face; kept off the free sparkle, and a face must exist before a round names it. */
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
      /* taken now, because drawing the box is a selection gesture and the picked set is one by the callback. */
      const ids = e.selIds().includes(placeId) ? e.selIds() : [placeId]
      e.markArea(async (bounds) => {
        const job = 'life-' + Date.now()
        jobRef.current = job
        stopRef.current = false
        setLifeBusy(true)
        /* the 35% law: a box mostly over walkable ground fences to the floor as well, otherwise the box alone holds. */
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
          /* passed in, not stamped on after: cleanLife built states with no floor and rounds walked off the path. */
          const life = cleanLife({
            ...(r.life as Record<string, unknown>),
            ...(bounds ? { bounds, walkPct } : {}),
            ...(walkOnly ? { walkOnly: true } : {}),
          })
          if (!life) throw new Error('that did not come back as movement')
          /* an unknown name falls back to picture 0, since dropping one shifts every later index down and misdraws. */
          const named = Array.isArray(r.looks) ? r.looks.slice(0, 8) : []
          const looks: AssetLook[] = []
          const artAt = [0]
          for (const nm of named.slice(1)) {
            /* the row's own faces first, then the library: a name means one picture only on the row that owns it. */
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

  /* the pending round lands on the first placement, then clears, so a second one does not silently re-run it. */
  useEffect(() => {
    const want = pendingLife.current
    if (!want || lifeBusy) return
    const hit = (st?.assets ?? []).find((a) => assetLabel(a) === want.name && !a.life)
    if (!hit) return
    pendingLife.current = null
    void runLife(hit.id, want.ask)
  }, [st?.assets, lifeBusy, runLife])


  /* two presses: the free read prices it, since 0, 1 or one-per-heading cannot be guessed on this side. */
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
      /* travel goes to the free recipe engine: both animators redraw in place and a scatter comes back on the spot. */
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
        let r = await api.assetAnimate(sid, { name: item.name, ask, plan, confirm: true, job })
        /* pending is not failed: the host cannot hold a fifteen-minute request, so polling is free and never rebuys. */
        if (r.pending) {
          push(`${item.name} · ${r.note || 'pixellab is still drawing'}`)
          const want = r.group || true
          let got: typeof r | null = null
          for (let i = 0; i < 40 && !got; i++) {
            await new Promise((res) => setTimeout(res, 30000))
            if (e.sceneId !== sid || stopRef.current) return
            try {
              const q = await api.assetAnimate(sid, { name: item.name, ask, plan, confirm: true, recover: want, job })
              if (q.item) got = q
            } catch {
              // not finished yet, or the listing blinked: ask again in half a minute
            }
          }
          if (!got) {
            push(`${item.name} · still not collected after twenty minutes · press animate again with the same words and it will be collected, not redrawn`)
            return
          }
          r = got
        }
        // a scene swap mid-run would file the result under the wrong map
        if (e.sceneId !== sid) return
        if (!r.item) {
          push(`${item.name} · nothing came back`)
          return
        }
        const next = r.item
        setLib((prev) => [...(prev || []).filter((x) => x.name !== next.name), next])
        // same names, new bytes: without this the editor answers every draw out
        // of the frames it already cached
        e.bustAssets(folderOf(next))
        setBust((q) => ({ ...q, [next.name]: Date.now() }))
        /* pixellab pads the canvas, so placements are rescaled by the difference before refresh or figures resize. */
        if (next.w !== item.w || next.h !== item.h)
          e.rescalePlacementsOf(next, item.w / next.w, item.h / next.h)
        e.refreshPlacementsOf(next)
        setAnimNote(r.note || '')
        setAnimAsk('')
        setAnimOpen(false)
        /* a partial run is a success with a hole in it, so it is said plainly and
         * not folded into the note where it reads as a detail. */
        push(
          (r.partial ? `${next.name} moves, mostly · ${r.partial}` : `${next.name} is moving · ${plan.motion}`) +
            (r.note && !r.partial ? ' · ' + r.note : '') +
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

  // three ways out, none generating. on a looked-at batch keep means the picked take and the rest come off disk
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

  // looked at before he chooses. looking is free, and "none of them" picks nothing so every row stays keepable
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

  // ---- the effect engine: generated effects came back unusable, so local rules run over sampled colours ----

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
          // a broken preview is never shown; one that worked keeps its recipe, one that never drew falls to a built-in
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

  // ---- the review loop: rendering is free, so the tool looks at its own frames before asking a person ----

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

  /* three free passes; nothing commits until it renders, and the look carries a job as a pass is two minutes. */
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

  // the plan is free with a keyword fallback, so a click always draws something, and it says whose colours
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
      // a renderer takes a real 25-30s; a dropped request fell silently to the keyword guess, so ask twice and say so
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
      /* a stop is not a failed read: a null plan below falls to the keyword guess, and a stop must get nothing. */
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

  // touching a swatch is itself the decision to own the ramp; the toggle puts the sampled one back untouched
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

  // keep writes the frames and effect.json so it reopens; reopened, it overwrites itself or writes a second item
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

  // reopen off effect.json; nothing moves on disk until save, and the patch re-samples at the placement or middle
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

  // ---- the test step's doors: a one-shot map click drops the anchor, esc or right-click cancels ----
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

  /* pointed at, not typed: a coordinate read off the status bar and retyped is a coordinate nobody sets. */
  const armStand = useCallback(
    (id: number) => {
      const e = edRef.current
      if (!e) return
      if (standPick) {
        setStandPick(0)
        e.pickPoint(null)
        return
      }
      setStandPick(id)
      e.pickPoint((p) => {
        if (!p) {
          setStandPick(0)
          return
        }
        if (!e.doc.inB(p[0], p[1])) return
        e.pickPoint(null)
        setStandPick(0)
        e.updateEvent(id, { stand: [p[0], p[1]] })
      })
    },
    [standPick],
  )

  /* THE AREA, two corners, so the second click needs the first one to still be
   * in hand. Held in state rather than in the editor because it is a gesture
   * and not a fact about the map until both clicks have happened. */
  const armRect = useCallback(
    (id: number) => {
      const e = edRef.current
      if (!e) return
      if (rectPick) {
        setRectPick(null)
        e.pickPoint(null)
        return
      }
      let first: [number, number] | null = null
      setRectPick({ id, from: null })
      e.pickPoint((p) => {
        if (!p) {
          setRectPick(null)
          return
        }
        if (!e.doc.inB(p[0], p[1])) return
        if (!first) {
          first = [p[0], p[1]]
          setRectPick({ id, from: first })
          return
        }
        e.pickPoint(null)
        setRectPick(null)
        e.updateEvent(id, { rect: [first[0], first[1], p[0], p[1]] })
      })
    },
    [rectPick],
  )

  /* a held drag, not a one-shot pick, so it lives in the editor; the rect pick cancels or one press feeds two. */
  const armPoly = useCallback(
    (id: number) => {
      const e = edRef.current
      if (!e) return
      if (rectPick) {
        setRectPick(null)
        e.pickPoint(null)
      }
      e.drawRegion(id)
    },
    [rectPick],
  )

  /* the mode is written first and always: reading whose data exists lit two at once and deleted a shape. */
  const pickShape = useCallback(
    (id: number, want: 'circle' | 'rect' | 'poly', ev: MapAnchor) => {
      const e = edRef.current
      if (!e) return
      const now = ev.shape ?? anchorShape(ev)
      const again = now === want
      if (rectPick && want !== 'rect') {
        setRectPick(null)
        e.pickPoint(null)
      }
      if (drawingRegion && want !== 'poly') e.cancelRegionDraw()
      e.updateEvent(id, { shape: want })
      if (want === 'rect' && (again || !ev.rect)) armRect(id)
      if (want === 'poly' && (again || !ev.poly)) armPoly(id)
    },
    [rectPick, drawingRegion, armRect, armPoly],
  )

  // the spend; the spot's crop rides as pixellab's background, and one job id per run or a stop kills nothing
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
                  // the boxed art rides along so pixellab draws into this map's light; with no box the router's patch goes
                  ...(bg ? { background: bg } : t.where ? { where: t.where } : {}),
                })
          if (e.sceneId !== sid) break
          setLib((prev) => [...(prev || []).filter((x) => x.name !== r.item.name), r.item])
          made.push(r.item)
          // a stop between the base and its frames files a still, and a still asked for as moving has to say so
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
        // the first take that landed, keyed on what came back: a failed first take would carry the gate away with it
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
        // breath: the box is otherwise the only place they exist
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
        // both kinds, not only static, or a campfire comes back unlooked-at; the slider opens where relatedness says
        setPlStr(80)
        void reviewMade(sid, p, t.prompt, made)
      }
    },
    [genCount, genType, askGate, reviewMade, push],
  )

  /* boxing is optional and esc reads the whole map; the box is what makes scale right, next to what is there. */
  const doBox = useCallback(() => {
    const e = edRef.current
    if (!e) return
    if (genBox) {
      setGenBox(null)
      setGenPlan(null)
      // a fill's plan is a list of positions INSIDE the box, so it means nothing
      // once the box is gone. Letting it survive leaves the draw button lit
      // over a plan with nowhere to land.
      setScene(null)
      push('box cleared · it will read the whole map')
      return
    }
    e.markArea((r) => {
      setGenBox(r)
      // a new area means the reading in hand is about a different place
      setGenPlan(null)
      setScene(null)
      if (r) push(`boxed ${r.w}×${r.h} · now say what goes there`)
    })
  }, [genBox, push])

  /* one press stops all of it. a sent generation cannot be recalled, but the run stops before the next one. */
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

  /* free, and separate from the spend so the list can be read and cut first. no box means the whole painting. */
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

  /* one at a time and sequential, so the stop flag is checked before every spend and what landed stays. */
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
      /* the same first-landing hold: twenty-four moving things is forty-eight generations, keyed on what landed. */
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
    /* the free look, over the set as a set: six things need six names, and one prompt describes only the first. */
    void lookAt(sid, ask, made.slice(0, LOOK_CELLS).map((m) => m.name).join(' · '), made)
  }, [scene, sceneOff, genBox, fillRun, genType, makeWhat, genPrompt, askGate, lookAt, push])

  /* two presses: a free read writing the prompt off the painting, then a spend that runs it verbatim. */
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
        /* "a few crates" came back one welded png, so the router counts the ask and hands a set to the fill planner. */
        if (what === 'object' && many > 1) {
          e.setBusy(`working out the ${many}`)
          await readMany(p, many, job)
          return
        }
        /* a sprite is priced per body, so several means takes; fill only writes prompts for the flat prop endpoint. */
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

  /* the corrected prompt goes in the box and the free read runs at once; nothing is armed and nothing spends. */
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

  // ---- crop: done on canvas since the frames are already decoded, and written as a new <name>-crop item ----
  /* an in-place edit hits every placement, and z knows only the document, so it says the count and the way back. */
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

  /* THE ANIMATION SWITCH. Nothing is generated either way, so it needs no plan, no price and no
     confirm: taking the movement off keeps the frames, and putting it back reads the frames that
     were kept. The library row, the decoded images and every placement of it all have to be told,
     the same four steps an in-place edit takes, because the item has changed shape and a placement
     holding the old shape's urls draws nothing at all. */
  const doAnimSwitch = useCallback(
    async (name: string, on: boolean) => {
      const ed = edRef.current
      if (!ed) return
      try {
        const r = await api.assetAnimation(ed.sceneId, name, on)
        setLib((prev) => [...(prev || []).filter((x) => x.name !== r.item.name), r.item])
        ed.bustAssets(folderOf(r.item))
        setBust((q) => ({ ...q, [r.item.name]: Date.now() }))
        const n = ed.refreshPlacementsOf(r.item)
        push(
          on
            ? `${name} moves again${n > 1 ? ` · all ${n} of them on the map` : ''}`
            : `${name} stands still${n > 1 ? ` · all ${n} of them on the map` : ''}`,
        )
      } catch (err) {
        push(String(err instanceof Error ? err.message : err).slice(0, 110))
      }
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
        /* a crop of one writes a copy under a new name, so the other placements keep their row untouched. */
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
          // the stack each, so z moves a single tree back and leaves the other
          // eighteen where the crop put them.
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

  /* z reverts pixels at the depth they were filed at, a round trip, so the art catches up to the anchors. */
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

  useEffect(() => {
    let gone = false
    api
      .styles()
      .then((r) => {
        if (gone) return
        setCards(r.cards)
        // the first offered is the default, and with none offered it is Other
        setStyleKey((k) => (k ? k : r.fallback || ''))
      })
      .catch(() => {
        /* no database and no account is the one-laptop case: Other, silently */
      })
    return () => {
      gone = true
    }
  }, [])

  /* the words that would be sent, read back from the server so what is shown is
   * what runs rather than a second copy of the assembly living in the browser */
  useEffect(() => {
    const sub = prompt.trim()
    if (!sub) return setWillDraw('')
    let gone = false
    const t = setTimeout(() => {
      api
        .mapPrompt(sub, styleKey)
        .then((r) => !gone && setWillDraw(r.prompt))
        .catch(() => !gone && setWillDraw(''))
    }, 250)
    return () => {
      gone = true
      clearTimeout(t)
    }
  }, [prompt, styleKey])

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
      const { jobs } = await api.generate(p, n, w, h, styleKey)
      // the choice belongs to the map from here, so every asset made for it
      // afterwards is drawn by the same hand without being asked again
      if (e.sceneId) void api.setMapStyle(e.sceneId, styleKey).catch(() => {})
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

  /* confirm before leaving. keepalive was tried and capped the request at 64 KiB, stopping the hub publishing. */
  const exporting = useRef(false)
  useEffect(() => {
    const ask = (ev: BeforeUnloadEvent) => {
      if (!exporting.current) return
      ev.preventDefault()
      ev.returnValue = ''
    }
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [])

  const doExport = useCallback(async () => {
    const e = edRef.current
    if (!e || !e.status().hasPainting) return
    if (exporting.current) return
    /* lowered in a finally: after the await, one interrupted export made every later press a silent no-op. */
    exporting.current = true
    e.setBusy('writing')
    try {
      /* flush first: the publisher reads anchors out of postgres, which only fills on the four-second autosave. */
      await e.flush()
      const r = await api.exportBundle(e.bundle())
      e.say(
        r.published
          ? `published v${r.published.version} · ${r.files.join(', ')}`
          : `wrote ${r.files.join(', ')} to ${r.dir}`,
      )
    } catch (err) {
      e.say(String(err instanceof Error ? err.message : err))
    } finally {
      exporting.current = false
      e.setBusy('')
    }
  }, [])

  /* flush first, or a late autosave writes under the previous id; then re-enter by url so one thing knows the id. */
  const doRename = useCallback(async (want: string) => {
    const e = edRef.current
    const from = e?.status().sceneId
    setIdDraft(null)
    setIdSaid('')
    if (!e || !from || !want.trim() || want.trim() === from) return
    try {
      await e.flush()
      const r = await api.renameMap(from, want.trim())
      if (r.repointed) e.say(`${from} is ${r.slug} now · ${r.repointed} door${r.repointed > 1 ? 's' : ''} followed it`)
      location.href = `/edit?id=${encodeURIComponent(r.slug)}`
    } catch (err) {
      setIdSaid(String(err instanceof Error ? err.message : err))
    }
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

      {/* dropping your own png is first, because generating needs a key and everything after this step is free. */}
      <Sec>open a file</Sec>
      <label className="field openfile">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(ev) => {
            const f = ev.target.files?.[0]
            const e = edRef.current
            if (!f || !e) return
            const fr = new FileReader()
            fr.onload = () => void e.loadPainting(String(fr.result), slug(f.name.replace(/\.[a-z]+$/i, '')))
            fr.readAsDataURL(f)
            ev.target.value = ''
          }}
        />
        <span className="openfile-btn">choose a png</span>
        <span className="field-desc">or drop one anywhere on the map · free, no key needed</span>
      </label>

      <Sec>generate</Sec>
      {/* THE HAND COMES BEFORE THE SUBJECT. Choosing it after the words are
          typed reads as a filter on them; choosing it first reads as what it is,
          which is who is drawing. Only shown when there is a hand to choose:
          an account with none has no choice to make and Other is the only
          answer, so an empty pair of buttons would be furniture. */}
      {cards.length > 0 && (
        <div className="stylepick">
          {cards.map((c) => (
            <button
              key={c.key}
              className={'stylebtn' + (styleKey === c.key ? ' on' : '')}
              onClick={() => {
                setStyleKey(c.key)
                disarm()
              }}
              title={c.clause}
            >
              {c.title}
              {c.house ? <span className="stylebtn-tag">house</span> : null}
            </button>
          ))}
          <button
            className={'stylebtn' + (styleKey === '' ? ' on' : '')}
            onClick={() => {
              setStyleKey('')
              disarm()
            }}
            title="no style card · the words go out as typed"
          >
            Other
          </button>
        </div>
      )}
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
      {/* what will actually be sent, because a hand described is a hand nobody
          can check and this is free to show */}
      {willDraw ? (
        <details className="willdraw">
          <summary>what will be drawn</summary>
          <p>{willDraw}</p>
        </details>
      ) : null}
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
        // it stays on screen because it is not standing prose: it is a live
        // count and, when the worker has not answered, the reason the tool
        // cannot do the thing the row is offering
        keep
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
      {/* kept points: the outline survives closing the polygon, so one shape is traced once rather than three times. */}
      {(st?.stencils.length ?? 0) > 0 && (
        <>
          <Sec>outlines you drew</Sec>
          {st!.stencils.map((k) => (
            <div className="manyrow" key={k.id}>
              <button
                className="abtn tiny"
                data-tip="lay it down again with the tool and level that are live now"
                onClick={() => {
                  ed?.applyStencil(k.id)
                  push(`outline ${k.id} laid down again`)
                }}
              >
                use {k.pts.length}-point outline
              </button>
              <button className="arow-x" data-tip="forget it" onClick={() => ed?.deleteStencil(k.id)}>
                ×
              </button>
            </div>
          ))}
        </>
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
        {/* one row per occluder; the baseline wrote to the last one drawn, so a second made the first unreachable. */}
        {st && st.occs.length > 0 && (
          <div className="occrows">
            {st.occs.map((o) => (
              <div
                key={o.id}
                className={'occrow' + (st.occSel === o.id ? ' sel' : '')}
                onClick={() => ed?.selectOcc(o.id)}
              >
                <span className="occ-id">{o.id}</span>
                <label className="occ-base" onClick={(e) => e.stopPropagation()}>
                  <span>draws over above</span>
                  <input
                    type="number"
                    value={o.baseline}
                    onFocus={() => ed?.selectOcc(o.id)}
                    onChange={(e) => {
                      ed?.selectOcc(o.id)
                      ed?.setBaseline(Number(e.target.value))
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                    }}
                  />
                </label>
                <button
                  className={'arow-x' + (armed === 'occ:' + o.id ? ' armed' : '')}
                  data-tip={armed === 'occ:' + o.id ? undefined : 'remove'}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!arm('occ:' + o.id)) return
                    ed?.deleteOcc(o.id)
                  }}
                >
                  {armed === 'occ:' + o.id ? 'sure?' : <Icon name="x" />}
                </button>
              </div>
            ))}
          </div>
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
  /* the stored mode leads and the derived shape is only the fallback; a gesture in flight beats both. */
  const liveShape = !editingDoor
    ? 'circle'
    : rectPick?.id === editingDoor.id
      ? 'rect'
      : drawingRegion && st?.polyDrawId === editingDoor.id
        ? 'poly'
        : (editingDoor.shape ?? anchorShape(editingDoor))
  // the map's routes and its shots, and whichever row of each has its form open
  const paths = st?.paths ?? []
  const editingPath = paths.find((p) => p.id === pathEdit)
  /* the bad legs of the route being edited, and only when it is the one the
     editor has selected: the status measures the selection, and opening a form
     without selecting the same route would report another line's faults */
  const pathBad = editingPath && st?.pathSel === editingPath.id ? (st?.pathBad ?? []) : []
  const framings = st?.framings ?? []
  const editingShot = framings.find((f) => f.id === shotEdit)
  /* by name first and then id, the way the game resolves it; `has` is the only way a broken binding shows. */
  const bindTargets = (() => {
    const all = st?.assets ?? []
    const named = all.filter((a) => a.name)
    const rest = all.filter((a) => !a.name)
    const keys = new Set<string>()
    for (const a of all) {
      keys.add(a.id)
      if (a.name) keys.add(a.name)
    }
    return { named, rest, has: (ref: string) => keys.has(ref) }
  })()

  /* gaps are measured for the selected row alone, so they are read only when the open form is that row's. */
  const sets = st?.sets ?? []
  const racks = st?.racks ?? []
  const variants = st?.variants ?? []
  const editingSet = sets.find((s) => collEdit === `set:${s.id}`)
  const editingRack = racks.find((r) => collEdit === `rack:${r.id}`)
  const editingVar = variants.find((v) => collEdit === `var:${v.id}`)
  const setGaps = editingSet && st?.anchorSetSel === editingSet.id ? (st?.setGaps ?? []) : []
  const rackGaps = editingRack && st?.rackSel === editingRack.id ? (st?.rackGaps ?? []) : []
  const varGaps = editingVar && st?.variantSel === editingVar.id ? (st?.variantGaps ?? []) : []
  /* Open one collection and close every other form in this panel, the route and
   * the shot included. The editor is told which row is selected as well, or the
   * gaps above measure nothing. */
  const openColl = (kind: 'set' | 'rack' | 'var', id: number) => {
    setCollEdit(id ? `${kind}:${id}` : '')
    setCollDraft(null)
    setCollSaid('')
    ed?.selectSet(kind === 'set' ? id : 0)
    ed?.selectRack(kind === 'rack' ? id : 0)
    ed?.selectVariantSet(kind === 'var' ? id : 0)
    setPathEdit(0)
    ed?.selectPath(0)
    setShotEdit(0)
    ed?.selectFraming(0)
  }
  /* the anchor picker every collection form spends, offered once. A name that
   * has been renamed or deleted under a slot is added by the caller, because
   * only the caller knows which name is missing. */
  const anchorOpts = doors.map((d) => (
    <option key={d.id} value={d.name}>
      {readable(d)} · {d.name}
    </option>
  ))
  /* identifier alone for a rack slot: the full pair clips and loses the address, which is the half that is addressable. */
  const anchorCodeOpts = doors.map((d) => (
    <option key={d.id} value={d.name}>
      {d.name}
    </option>
  ))
  /* which collections the open anchor is in; a rack says its slot number, because the number is the address. */
  const anchorIn = editingDoor
    ? [
        ...sets.filter((s) => s.members.includes(editingDoor.name)).map((s) => `set ${s.name}`),
        /* one line per rack with its hooks sorted, since a line per hook said the same rack three times out of order. */
        ...racks
          .map((r) => ({
            r,
            on: r.slots
              .filter((q) => q.anchor === editingDoor.name)
              .map((q) => q.slot)
              .sort((a, b) => a - b),
          }))
          .filter((q) => q.on.length)
          .map((q) => `rack ${q.r.name} slot${q.on.length > 1 ? 's' : ''} ${q.on.join(', ')}`),
        ...variants.filter((v) => v.anchor === editingDoor.name).map((v) => `variant set ${v.name}`),
      ]
    : []

  /* a variable, not a component, so both panels share the form without threading fifteen states through props. */
  const anchorForm = editingDoor ? (
        <div className="doorform">
          {/* name is what python writes, label is what a player reads; a rename must not break somebody's island. */}
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
              placeholder="The Old Quarry"
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

          {/* when the anchor exists at all; read by the game since anchors shipped with no way for anybody to set it. */}
          <WhenField
            what="this anchor"
            value={editingDoor.when ?? ''}
            onCommit={(v) => ed?.setAnchorWhen(editingDoor.id, v)}
          />

          {/* binds a name to a placement; with no value here `show` could not fire on any bundle this tool made. */}
          <label className="anchfield">
            <span>bound to · the placement it follows</span>
            <select
              className="anchbind"
              data-empty={editingDoor.placement ? '0' : '1'}
              value={editingDoor.placement ?? ''}
              onChange={(e) => ed?.bindAnchor(editingDoor.id, e.target.value || null)}
            >
              <option value="">nothing · it holds still</option>
              {bindTargets.named.length > 0 && (
                <optgroup label="named">
                  {bindTargets.named.map((a) => (
                    <option key={a.id} value={a.name as string}>
                      {readable(a)} · {a.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {bindTargets.rest.length > 0 && (
                <optgroup label="unnamed">
                  {bindTargets.rest.map((a) => (
                    <option key={a.id} value={a.id}>
                      {assetLabel(a)} · {a.id}
                    </option>
                  ))}
                </optgroup>
              )}
              {/* a binding whose placement is gone is shown rather than silently
                  dropped, or an author fixes an anchor they never knew broke */}
              {editingDoor.placement && !bindTargets.has(editingDoor.placement) && (
                <option value={editingDoor.placement}>{editingDoor.placement} · gone</option>
              )}
            </select>
          </label>
          {editingDoor.placement && !bindTargets.has(editingDoor.placement) && (
            <div className="anchwarn">
              nothing on this map is called {editingDoor.placement} any more · show would refuse
            </div>
          )}

          {/* the floor beside the thing, not its middle: one point doing four jobs sat on unwalkable pixels. */}
          <div className="anchspot">
            <span>stand at</span>
            <button
              className={'mbtn wide' + (standPick ? ' on' : '')}
              onClick={() => armStand(editingDoor.id)}
            >
              {standPick
                ? 'click the floor · esc cancels'
                : editingDoor.stand
                  ? `${editingDoor.stand[0]}, ${editingDoor.stand[1]}`
                  : 'the middle of it'}
            </button>
            {editingDoor.stand && !standPick && (
              <button
                className="arow-x"
                data-tip="back to the middle"
                onClick={() => ed?.updateEvent(editingDoor.id, { stand: null })}
              >
                <Icon name="x" />
              </button>
            )}
          </div>

          {/* which way a body looks; the middle clears it, and arrival() read this for a value nobody could ever set. */}
          <div className="anchface">
            <span>facing</span>
            <div className="facegrid">
              {FACE_GRID.flat().map((k, i) =>
                k ? (
                  <button
                    key={k}
                    className={'abtn tiny' + (editingDoor.facing === k ? ' on' : '')}
                    data-tip={k}
                    onClick={() => ed?.updateEvent(editingDoor.id, { facing: editingDoor.facing === k ? '' : k })}
                  >
                    <span className="facearrow">{'↖↑↗←·→↙↓↘'[i]}</span>
                  </button>
                ) : (
                  <button
                    key="none"
                    className={'abtn tiny' + (editingDoor.facing ? '' : ' on')}
                    data-tip="no opinion"
                    onClick={() => ed?.updateEvent(editingDoor.id, { facing: '' })}
                  >
                    <span className="facearrow">·</span>
                  </button>
                ),
              )}
            </div>
          </div>

          {/* three shapes on every kind. the lit one is the mode: reading whose data exists lit two and deleted one. */}
          <div className="anchface">
            <span>zone</span>
            <div className="anchkinds">
              <button
                className={'kbtn' + (liveShape === 'circle' ? ' on' : '')}
                data-tip="a circle of the radius below"
                onClick={() => pickShape(editingDoor.id, 'circle', editingDoor)}
              >
                circle
              </button>
              <button
                className={'kbtn' + (liveShape === 'rect' ? ' on' : '')}
                data-tip={editingDoor.rect ? 'the box you drew · press again to redo it' : 'two opposite corners'}
                onClick={() => pickShape(editingDoor.id, 'rect', editingDoor)}
              >
                rect
              </button>
              <button
                className={'kbtn' + (liveShape === 'poly' ? ' on' : '')}
                data-tip={
                  editingDoor.poly
                    ? 'the area you drew · press again to redo it'
                    : 'press and drag round the area · let go to close it'
                }
                onClick={() => pickShape(editingDoor.id, 'poly', editingDoor)}
              >
                draw
              </button>
              {/* THE ONLY THING THAT THROWS A SHAPE AWAY, and it takes a press.
                  A mode switch that does it silently loses an author's drawing
                  to the wrong button. */}
              {((liveShape === 'poly' && editingDoor.poly) || (liveShape === 'rect' && editingDoor.rect)) && (
                <button
                  className="arow-x"
                  data-tip={liveShape === 'poly' ? 'throw the drawn area away' : 'throw the box away'}
                  onClick={() =>
                    ed?.updateEvent(
                      editingDoor.id,
                      liveShape === 'poly' ? { poly: null, shape: 'circle' } : { rect: null, shape: 'circle' },
                    )
                  }
                >
                  <Icon name="x" />
                </button>
              )}
            </div>
          </div>
          {/* the zone hint per kind, because "area" on a door meant nothing until it said doormat. */}
          <div className="doorhint">
            {rectPick?.id === editingDoor.id
              ? rectPick.from
                ? 'now the opposite corner'
                : 'click one corner · esc cancels'
              : drawingRegion && st?.polyDrawId === editingDoor.id
                ? (st?.polyDraw ?? 0) > 0
                  ? `${st?.polyDraw} points · enter saves it · esc drops it · draw again to redo it`
                  : 'press and drag round the area · let go to close it'
                : liveShape === 'poly' && editingDoor.poly
                  ? `${editingDoor.poly.length} points · drag one to correct it · the game gets the box round it too`
                  : liveShape === 'rect' && editingDoor.rect
                    ? `${Math.abs(editingDoor.rect[2] - editingDoor.rect[0])} × ${Math.abs(editingDoor.rect[3] - editingDoor.rect[1])}`
                    : `a circle of ${editingDoor.r}px`}
          </div>
          <div className="doorhint">{ANCHOR_ZONE[editingDoor.kind]}</div>

          {/* THE RADIUS, TYPEABLE, because the ceiling is 512 and stepping there
              two pixels at a time is 250 presses. The buttons stay for the small
              corrections they were always for. */}
          <div className="doorrad">
            <span>radius</span>
            <button className="mbtn" onClick={() => ed?.updateEvent(editingDoor.id, { r: editingDoor.r - 2 })}>
              −
            </button>
            <input
              className="radnum"
              type="number"
              min={ANCHOR_R_MIN}
              max={ANCHOR_R_MAX}
              value={radDraft ?? String(editingDoor.r)}
              onChange={(e) => setRadDraft(e.target.value)}
              onBlur={() => {
                if (radDraft === null) return
                const n = Number(radDraft)
                if (isFinite(n)) ed?.updateEvent(editingDoor.id, { r: n })
                setRadDraft(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
              }}
            />
            <button className="mbtn" onClick={() => ed?.updateEvent(editingDoor.id, { r: editingDoor.r + 2 })}>
              +
            </button>
          </div>
          <div className="doorhint">{ANCHOR_WHAT[editingDoor.kind]}</div>
          {/* what this one anchor is a member of. Without it a collection is
              only visible from its own form, so an author looking at stele_2
              cannot tell it is one of the five that python iterates. */}
          {anchorIn.length > 0 && <div className="doorhint">in {anchorIn.join(' · ')}</div>}
          {/* the bag a reader picks up, which without this carries only MAPVIS bookkeeping and nothing an author chose. */}
          <div className="metarows">
            <div className="doorhint">what a reader can pick up off this anchor</div>
            {[
              ...Object.entries(editingDoor.meta ?? {}).filter(([k]) => !ANCHOR_META_RESERVED.includes(k)),
              ['', ''],
            ].map(([k, v], i) => (
              <div className="metarow" key={k || 'new' + i}>
                <input
                  className="anchname"
                  defaultValue={k}
                  placeholder="key"
                  onBlur={(e) => {
                    const nk = e.target.value.trim()
                    if (nk === k) return
                    // the new name takes the previous one's value, and clearing
                    // the name is how a key is removed
                    if (nk) ed?.setAnchorMeta(editingDoor.id, nk, String(v ?? ''))
                    if (k) ed?.setAnchorMeta(editingDoor.id, k, null)
                  }}
                  spellCheck={false}
                />
                <input
                  defaultValue={String(v ?? '')}
                  placeholder="value"
                  onBlur={(e) => {
                    const kk = (e.currentTarget.parentElement?.querySelector('input') as HTMLInputElement)?.value.trim()
                    if (kk) ed?.setAnchorMeta(editingDoor.id, kk, e.target.value)
                  }}
                  spellCheck={false}
                />
              </div>
            ))}
          </div>
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
  ) : null

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
      {/* not a rival to a spawn anchor: arrival resolves door `arrive at`, then a spawn anchor, then this. */}
      <Row
        icon="pin"
        label="set start point"
        desc="under the cursor, or the walker mid-test · last resort: a door's arrive at wins, then a spawn anchor, then this"
        onClick={() => ed?.setSpawnHere()}
      />
      {/* the body this map is drawn for; with no control every map shipped an 18px body at 34 px/s squashed 0.72. */}
      <Sec>the body it is drawn for</Sec>
      {/* no standing sentence here: twenty-six words restating six labels cost three lines of a 272px column. */}
      <div className="walkcfg">
        <NumField
          label="height"
          tip="how tall the body is in painting pixels · 18 is a person on an island map"
          value={st?.walk.charH ?? 18}
          onCommit={(v) => ed?.setWalk({ charH: v })}
        />
        <NumField
          label="speed"
          tip="painting pixels a second · the map's width over twice this is how long it takes to cross"
          value={st?.walk.speed ?? 34}
          onCommit={(v) => ed?.setWalk({ speed: v })}
        />
        <NumField
          label="hip out"
          tip="how far to each side the two floor probes sit, so a body cannot walk with one foot in the sea"
          value={st?.walk.hip ?? 2}
          onCommit={(v) => ed?.setWalk({ hip: v })}
        />
        <NumField
          label="hip up"
          tip="how far above the feet those probes sit"
          value={st?.walk.hipDY ?? 1}
          onCommit={(v) => ed?.setWalk({ hipDY: v })}
        />
        <NumField
          label="squash"
          tip="how much shorter a step north is than a step east, because the ground is seen at an angle"
          value={st?.walk.yScale ?? 0.72}
          dp={2}
          step={0.02}
          onCommit={(v) => ed?.setWalk({ yScale: v })}
        />
        <NumField
          label="step"
          tip="the biggest level change a body can climb without stairs"
          value={st?.walk.near ?? 10}
          onCommit={(v) => ed?.setWalk({ near: v })}
        />
      </div>
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
      {/* six kinds are made here, not just doors, which is why neither the button nor the header says door. */}
      <Sec>anchors</Sec>
      <Row
        icon="door"
        label={doorPick ? 'click the map for the anchor' : 'add anchor'}
        desc={doorPick ? 'right-click or esc cancels' : 'a named spot code can address'}
        on={doorPick}
        onClick={armDoor}
      />
      <AnchorsShown ed={ed} on={!!st?.eventsVisible} />
      {anchorForm}
      {doors.length > 0 && (
        <div className="evrows">
          {doors.map((ev) => (
            <div
              key={ev.id}
              className={'evrow' + (doorEdit === ev.id ? ' sel' : '')}
              /* what this kind does and where it goes, rather than a title repeating the two lines already under the pointer. */
              data-tip={
                /* the reach is the radius only while the radius is the live
                   shape. On a region drawn as an area the ring is dormant data
                   and the row would be quoting a number the game never tests. */
                `${ANCHOR_WHAT[ev.kind]} · ${
                  anchorShape(ev) === 'poly'
                    ? `${ev.poly?.length ?? 0} points drawn`
                    : anchorShape(ev) === 'rect'
                      ? 'a box'
                      : `${ev.r}px reach`
                }` +
                (ev.kind === 'door'
                  ? ` · leads to ${ev.to || 'nowhere yet'}${ev.toAnchor ? `, arriving at ${ev.toAnchor}` : ''}`
                  : '')
              }
              onClick={() => {
                setDoorNew(false)
                setDoorEdit(doorEdit === ev.id ? 0 : ev.id)
              }}
            >
              {/* the drawn 26px tile: a bare ⏻ stood in for "door" and started the words at x=43 instead of x=59. */}
              <span className="row-ic">
                <Icon name={ANCHOR_ICON[ev.kind]} />
              </span>
              {/* the NAME leads, because that is what a player is told the
                  door is. Its address and where it goes sit on the line under
                  it, captioned, in Addr above. */}
              <span className="ev-name">
                {/* the label leads and the identifier follows; displayName unpacks the identifier when no label was typed. */}
                {/* the mark is only about these words: reading ev.meta.derived dotted a label somebody actually typed. */}
                <b className={displayName(ev).derived ? 'guessed' : undefined}>{displayName(ev).text}</b>
                {ev.kind === 'door' ? (
                  <Addr
                    parts={[
                      ['code', ev.name],
                      ['to', ev.to || 'nowhere yet'],
                      ...(ev.toAnchor ? ([['at', ev.toAnchor]] as [string, string][]) : []),
                    ]}
                  />
                ) : (
                  <Addr parts={[['code', ev.name], [null, ev.kind]]} />
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
      {/* routes, because an anchor is one pixel and every real line was hand-typed as numbers in the other repo. */}
      <Sec>routes</Sec>
      <Row
        icon="poly"
        label={layingPath ? `keep the line · ${st?.pathDraw} points` : 'draw a route'}
        desc={
          layingPath
            ? 'click to add · enter or double click keeps it · esc drops it'
            : 'a named line something walks or sails'
        }
        on={layingPath}
        onClick={() => {
          setPathEdit(0)
          ed?.armPath()
        }}
      />
      {editingPath && (
        <div className="doorform">
          <label className="anchfield">
            <span>name · what code calls it</span>
            <input
              className={'anchname' + (rnameSaid?.id === editingPath.id ? ' bad' : '')}
              value={rnameDraft ?? editingPath.name}
              placeholder="ship_to_dock"
              onChange={(e) => setRnameDraft(e.target.value)}
              onBlur={() => {
                if (rnameDraft === null) return
                const r = ed?.renamePath(editingPath.id, rnameDraft)
                setRnameSaid(r?.why ? { id: editingPath.id, why: r.why } : null)
                setRnameDraft(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
              }}
              spellCheck={false}
              autoFocus
            />
          </label>
          {rnameSaid?.id === editingPath.id && <div className="anchwarn">{rnameSaid.why}</div>}

          {/* what travels it, since a leg over water is a defect for a body and the whole point for a boat. */}
          <div className="anchkinds">
            {PATH_KINDS.map((k) => (
              <button
                key={k}
                className={'kbtn' + (editingPath.kind === k ? ' on' : '')}
                onClick={() => ed?.updatePath(editingPath.id, { kind: k })}
                data-tip={PATH_WHAT[k]}
              >
                {k}
              </button>
            ))}
          </div>
          <div className="anchkinds">
            <button
              className={'kbtn' + (editingPath.closed ? ' on' : '')}
              onClick={() => ed?.updatePath(editingPath.id, { closed: !editingPath.closed })}
              data-tip="the last point runs back to the first · a patrol rather than an approach"
            >
              closed
            </button>
            <button
              className={'kbtn' + (editingPath.twoWay ? ' on' : '')}
              onClick={() => ed?.updatePath(editingPath.id, { twoWay: !editingPath.twoWay })}
              data-tip="it can be walked backwards · a sail line into a berth is not a line out of one"
            >
              two-way
            </button>
          </div>
          {/* waypoints drop with no floor test, so a walk route can cross the sea and look correct; sails are exempt. */}
          {pathBad.length > 0 && (
            <div className="anchwarn">
              {pathBad.length} of {st?.pathLegs ?? 0} {(st?.pathLegs ?? 0) === 1 ? 'leg' : 'legs'}{' '}
              {pathBad.length === 1 ? 'crosses' : 'cross'} ground a body cannot walk
            </div>
          )}

          {/* the heading to hold on arrival, the same compass the anchor form
              uses and the same middle cell meaning no opinion */}
          <div className="anchface">
            <span>facing</span>
            <div className="facegrid">
              {FACE_GRID.flat().map((k, i) =>
                k ? (
                  <button
                    key={k}
                    className={'abtn tiny' + (editingPath.facing === k ? ' on' : '')}
                    data-tip={k}
                    onClick={() => ed?.updatePath(editingPath.id, { facing: editingPath.facing === k ? null : k })}
                  >
                    <span className="facearrow">{'↖↑↗←·→↙↓↘'[i]}</span>
                  </button>
                ) : (
                  <button
                    key="none"
                    className={'abtn tiny' + (editingPath.facing ? '' : ' on')}
                    data-tip="no opinion"
                    onClick={() => ed?.updatePath(editingPath.id, { facing: null })}
                  >
                    <span className="facearrow">·</span>
                  </button>
                ),
              )}
            </div>
          </div>

          {/* timing marks name a waypoint index, so a beat is not retuned every time a line of text changes length. */}
          {/* short label on purpose: a 52px caption and a nowrap button in a 228px form widen rather than wrap. */}
          <div className="anchspot">
            <span>marks</span>
            <button
              className="mbtn wide"
              data-tip="names a waypoint, so a cutscene beat can wait for it instead of for a number of seconds"
              onClick={() => ed?.addPathMark(editingPath.id, 0)}
            >
              <Icon name="mark" />
              add a mark
            </button>
          </div>
          {/* a mark carries both strings; with name alone the canvas captioned a waypoint "at_the_doorway". */}
          {(editingPath.marks || []).map((m, i) => (
            <div className="markrow" key={i}>
              <input
                className="anchname"
                value={m.name}
                placeholder="at_the_doorway"
                data-tip="what code waits for"
                onChange={(e) => ed?.updatePathMark(editingPath.id, i, { name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                }}
                spellCheck={false}
              />
              <input
                value={m.label ?? ''}
                placeholder={displayName(m).text}
                data-tip="what a person reads · blank unpacks the name above"
                onChange={(e) => ed?.updatePathMark(editingPath.id, i, { label: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                }}
                spellCheck={false}
              />
              <div className="doorrad" data-tip="which waypoint it names">
                <button className="mbtn" onClick={() => ed?.updatePathMark(editingPath.id, i, { at: m.at - 1 })}>
                  −
                </button>
                <em>{m.at}</em>
                <button className="mbtn" onClick={() => ed?.updatePathMark(editingPath.id, i, { at: m.at + 1 })}>
                  +
                </button>
              </div>
              <button
                className="arow-x"
                data-tip="remove this mark"
                onClick={() => ed?.removePathMark(editingPath.id, i)}
              >
                <Icon name="x" />
              </button>
            </div>
          ))}

          <div className="doorhint">
            {editingPath.points.length} waypoints · the arrowhead on the map is the direction it is walked
          </div>
          <div className="dooracts">
            <button className="abtn" onClick={() => setPathEdit(0)}>
              done
            </button>
            <button
              className={'abtn danger' + (armed === 'path:' + editingPath.id ? ' armed' : '')}
              onClick={() => {
                if (!arm('path:' + editingPath.id)) return
                ed?.removePath(editingPath.id)
                setPathEdit(0)
              }}
            >
              {armed === 'path:' + editingPath.id ? 'sure?' : 'remove'}
            </button>
          </div>
        </div>
      )}
      {paths.length > 0 && (
        <div className="evrows">
          {paths.map((p) => (
            <div
              key={p.id}
              className={'evrow' + (pathEdit === p.id ? ' sel' : '')}
              /* the kind decides whether a leg over water is a defect, and "3 pts" never says where the points are. */
              data-tip={
                `${PATH_WHAT[p.kind]} · from ${p.points[0]?.join(', ')} to ${p.points[p.points.length - 1]?.join(', ')}`
              }
              onClick={() => {
                const open = pathEdit === p.id ? 0 : p.id
                setPathEdit(open)
                setRnameDraft(null)
                ed?.selectPath(open)
                // one inspector at a time. Picking a route while a shot form
                // was open stacked both, and the panel grew until neither the
                // route nor the shot was on screen at the same moment.
                setShotEdit(0)
                ed?.selectFraming(0)
              }}
            >
              <span className="row-ic">
                <Icon name="route" />
              </span>
              <span className="ev-name">
                {/* the same two lines a door row has, and for the same reason:
                    `the_dock_walk` is the address, not the name, and printing
                    it as the heading was the last place in the tool doing it */}
                <b className={displayName(p).derived ? 'guessed' : undefined}>{displayName(p).text}</b>
                <Addr
                  parts={[
                    ['code', p.name],
                    [null, `${p.points.length} pts`],
                    ...(p.closed ? ([[null, 'loop']] as [null, string][]) : []),
                    ...(p.twoWay ? ([[null, 'both ways']] as [null, string][]) : []),
                  ]}
                />
              </span>
              <button
                className={'arow-x' + (armed === 'pathrow:' + p.id ? ' armed' : '')}
                data-tip={armed === 'pathrow:' + p.id ? undefined : 'remove'}
                onClick={(e2) => {
                  e2.stopPropagation()
                  if (!arm('pathrow:' + p.id)) return
                  ed?.removePath(p.id)
                  if (pathEdit === p.id) setPathEdit(0)
                }}
              >
                {armed === 'pathrow:' + p.id ? 'sure?' : <Icon name="x" />}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* shots, because without them every camera move is hand-typed numbers nobody can check without running it. */}
      <Sec>shots</Sec>
      <Row
        icon="eye"
        label={editingDoor ? `save this view on ${readable(editingDoor)}` : 'save this view as a shot'}
        desc={
          editingDoor
            ? 'the offset from that anchor, so the shot travels when it does'
            : 'open an anchor above first, or it stores raw numbers'
        }
        // and this one, because it says what pressing WILL DO in the state the
        // panel is actually in. A shot saved on no anchor stores raw pixels
        // that re-break the next time the painting is cut.
        keep
        onClick={() => {
          const id = ed?.armFraming(editingDoor?.name ?? '')
          if (id) {
            setShotEdit(id)
            setSnameDraft(null)
          }
        }}
      />
      {editingShot && (
        <div className="doorform">
          <label className="anchfield">
            <span>name · what code calls it</span>
            <input
              className={'anchname' + (snameSaid?.id === editingShot.id ? ' bad' : '')}
              value={snameDraft ?? editingShot.name}
              placeholder="over_the_dock"
              onChange={(e) => setSnameDraft(e.target.value)}
              onBlur={() => {
                if (snameDraft === null) return
                const r = ed?.renameFraming(editingShot.id, snameDraft)
                setSnameSaid(r?.why ? { id: editingShot.id, why: r.why } : null)
                setSnameDraft(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
              }}
              spellCheck={false}
              autoFocus
            />
          </label>
          {snameSaid?.id === editingShot.id && <div className="anchwarn">{snameSaid.why}</div>}

          {/* an anchor by preference, because raw numbers re-break on every re-cut and every map gets re-cut. */}
          <label className="anchfield">
            <span>hung on · the anchor it follows</span>
            <select
              className="anchbind"
              data-empty={editingShot.anchor ? '0' : '1'}
              value={editingShot.anchor}
              onChange={(e) => ed?.updateFraming(editingShot.id, { anchor: e.target.value || null })}
            >
              <option value="">no anchor · a point on the map</option>
              {doors.map((d) => (
                <option key={d.id} value={d.name}>
                  {readable(d)} · {d.name}
                </option>
              ))}
              {/* an anchor that has been renamed or deleted under the shot is
                  shown rather than silently dropped, or an author fixes a shot
                  they never knew broke */}
              {editingShot.anchor && !doors.some((d) => d.name === editingShot.anchor) && (
                <option value={editingShot.anchor}>{editingShot.anchor} · gone</option>
              )}
            </select>
          </label>
          {editingShot.anchor && !doors.some((d) => d.name === editingShot.anchor) && (
            <div className="anchwarn">nothing on this map is called {editingShot.anchor} any more</div>
          )}

          <div className="walkcfg">
            {!editingShot.anchor && (
              <>
                <NumField
                  label="x"
                  value={editingShot.x ?? 0}
                  onCommit={(v) => ed?.updateFraming(editingShot.id, { x: v })}
                />
                <NumField
                  label="y"
                  value={editingShot.y ?? 0}
                  onCommit={(v) => ed?.updateFraming(editingShot.id, { y: v })}
                />
              </>
            )}
            <NumField
              label="offset x"
              value={editingShot.dx}
              onCommit={(v) => ed?.updateFraming(editingShot.id, { dx: v })}
            />
            <NumField
              label="offset y"
              value={editingShot.dy}
              onCommit={(v) => ed?.updateFraming(editingShot.id, { dy: v })}
            />
            {/* two decimals on purpose: the pull-out shot cannot exist on the
                renderer's integer notches, so this field does not round */}
            <NumField
              label="zoom"
              value={editingShot.zoom}
              dp={2}
              step={0.1}
              onCommit={(v) => ed?.updateFraming(editingShot.id, { zoom: v })}
            />
          </div>

          <div className="anchkinds">
            <button
              className={'kbtn' + (editingShot.entry ? ' on' : '')}
              onClick={() => ed?.updateFraming(editingShot.id, { entry: !editingShot.entry })}
              data-tip="the view a player gets on arriving in this map · at most one"
            >
              arrival shot
            </button>
          </div>

          {/* short for the same reason the route form's mark button is: this row
              cannot wrap, so a long label widens the form past the panel */}
          <div className="anchspot">
            <span>check it</span>
            <button
              className="mbtn wide"
              data-tip="puts the editor's own view on this shot"
              onClick={() => ed?.showFraming(editingShot.id)}
            >
              go to this shot
            </button>
          </div>
          <div className="doorhint">
            the editor zooms in whole steps and this number does not, so the check lands on the nearest one
          </div>
          <div className="dooracts">
            <button className="abtn" onClick={() => setShotEdit(0)}>
              done
            </button>
            <button
              className={'abtn danger' + (armed === 'shot:' + editingShot.id ? ' armed' : '')}
              onClick={() => {
                if (!arm('shot:' + editingShot.id)) return
                ed?.removeFraming(editingShot.id)
                setShotEdit(0)
              }}
            >
              {armed === 'shot:' + editingShot.id ? 'sure?' : 'remove'}
            </button>
          </div>
        </div>
      )}
      {framings.length > 0 && (
        <div className="evrows">
          {framings.map((f) => (
            <div
              key={f.id}
              className={'evrow' + (shotEdit === f.id ? ' sel' : '')}
              /* WHAT A SHOT IS, and what the word `arrival` on the line below
                 means, which is the question a tooltip repeating that line
                 leaves unanswered */
              data-tip={
                (f.entry
                  ? 'the view a player gets on arriving in this map'
                  : 'a saved camera position a cutscene can cut to') +
                ` · ${f.zoom}x, ` +
                (f.anchor ? `travels with ${f.anchor}` : `pinned to ${f.x}, ${f.y}`)
              }
              onClick={() => {
                const open = shotEdit === f.id ? 0 : f.id
                setShotEdit(open)
                setSnameDraft(null)
                ed?.selectFraming(open)
                // the other half of the same law, so a shot picked under an
                // open route form closes that form instead of piling onto it
                setPathEdit(0)
                ed?.selectPath(0)
              }}
            >
              <span className="row-ic">
                <Icon name="shot" />
              </span>
              <span className="ev-name">
                <b className={displayName(f).derived ? 'guessed' : undefined}>{displayName(f).text}</b>
                <Addr
                  parts={[
                    ['code', f.name],
                    f.anchor ? ['on', f.anchor] : ['at', `${f.x}, ${f.y}`],
                    ...(f.entry ? ([[null, 'arrival']] as [null, string][]) : []),
                  ]}
                />
              </span>
              <button
                className={'arow-x' + (armed === 'shotrow:' + f.id ? ' armed' : '')}
                data-tip={armed === 'shotrow:' + f.id ? undefined : 'remove'}
                onClick={(e2) => {
                  e2.stopPropagation()
                  if (!arm('shotrow:' + f.id)) return
                  ed?.removeFraming(f.id)
                  if (shotEdit === f.id) setShotEdit(0)
                }}
              >
                {armed === 'shotrow:' + f.id ? 'sure?' : <Icon name="x" />}
              </button>
            </div>
          ))}
        </div>
      )}
      {/* sets, so python iterates instead of hard-coding names; filled from the anchor whose form is open above. */}
      <Sec>sets</Sec>
      <Row
        icon="flag"
        label={editingDoor ? `new set from ${readable(editingDoor)}` : 'new set'}
        desc={
          editingDoor
            ? 'a name several anchors answer to at once'
            : 'open an anchor above first, or it starts empty'
        }
        keep
        onClick={() => openColl('set', ed?.addSet(editingDoor ? [editingDoor.name] : []) || 0)}
      />
      {editingSet && (
        <div className="doorform">
          <label className="anchfield">
            <span>name · what code calls it</span>
            <input
              className={'anchname' + (collSaid ? ' bad' : '')}
              value={collDraft ?? editingSet.name}
              placeholder="steles"
              onChange={(e) => setCollDraft(e.target.value)}
              onBlur={() => {
                if (collDraft === null) return
                const r = ed?.renameSet(editingSet.id, collDraft)
                setCollSaid(r?.why || '')
                setCollDraft(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
              }}
              spellCheck={false}
              autoFocus
            />
          </label>
          {collSaid && <div className="anchwarn">{collSaid}</div>}
          <div className="anchspot">
            <span>members · {editingSet.members.length}</span>
            <button
              className="mbtn wide"
              data-tip="puts the anchor whose form is open above into this set"
              disabled={!editingDoor || editingSet.members.includes(editingDoor.name)}
              onClick={() =>
                editingDoor && ed?.updateSet(editingSet.id, { members: [...editingSet.members, editingDoor.name] })
              }
            >
              {/* the name is not repeated in the already-in case: this row is
                  one nowrap button in a 228px form, and `quarry_gate is
                  already in` ellipsised to `quarry_gate is alread…` */}
              {!editingDoor
                ? 'open an anchor above first'
                : editingSet.members.includes(editingDoor.name)
                  ? 'already in this set'
                  : `add ${editingDoor.name}`}
            </button>
          </div>
          {editingSet.members.map((m) => (
            <div className="memrow" key={m}>
              <span className="anchname">{m}</span>
              <button
                className="arow-x"
                data-tip="take it out of the set"
                onClick={() =>
                  ed?.updateSet(editingSet.id, { members: editingSet.members.filter((q) => q !== m) })
                }
              >
                <Icon name="x" />
              </button>
            </div>
          ))}
          {/* the same question the publish gate asks, asked while somebody is
              still looking at the screen, in the red check reach paints
              stranded ground with */}
          {setGaps.length > 0 && (
            <div className="anchwarn">nothing on this map is called {setGaps.join(', ')}</div>
          )}
          <div className="dooracts">
            <button className="abtn" onClick={() => openColl('set', 0)}>
              done
            </button>
            <button
              className={'abtn danger' + (armed === 'set:' + editingSet.id ? ' armed' : '')}
              onClick={() => {
                if (!arm('set:' + editingSet.id)) return
                ed?.removeSet(editingSet.id)
                openColl('set', 0)
              }}
            >
              {armed === 'set:' + editingSet.id ? 'sure?' : 'remove'}
            </button>
          </div>
        </div>
      )}
      {sets.length > 0 && (
        <div className="evrows">
          {sets.map((s) => (
            <div
              key={s.id}
              className={'evrow' + (collEdit === `set:${s.id}` ? ' sel' : '')}
              data-tip={`one name for ${s.members.length} anchors · ${s.members.join(', ') || 'empty so far'}`}
              onClick={() => openColl('set', collEdit === `set:${s.id}` ? 0 : s.id)}
            >
              <span className="row-ic">
                <Icon name="flag" />
              </span>
              <span className="ev-name">
                <b className={displayName(s).derived ? 'guessed' : undefined}>{displayName(s).text}</b>
                <Addr parts={[['code', s.name], [null, `${s.members.length} anchors`]]} />
              </span>
              <button
                className={'arow-x' + (armed === 'setrow:' + s.id ? ' armed' : '')}
                data-tip={armed === 'setrow:' + s.id ? undefined : 'remove'}
                onClick={(e2) => {
                  e2.stopPropagation()
                  if (!arm('setrow:' + s.id)) return
                  ed?.removeSet(s.id)
                  if (collEdit === `set:${s.id}`) openColl('set', 0)
                }}
              >
                {armed === 'setrow:' + s.id ? 'sure?' : <Icon name="x" />}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* racks; the number never renumbers, so deleting the second hook leaves 1, 3, 4, 5 and only the row drags. */}
      <Sec>racks</Sec>
      <Row
        icon="mark"
        label="new rack"
        desc="ordered slots · code fills slot 3 and slot 3 is where it lands"
        onClick={() => openColl('rack', ed?.addRack() || 0)}
      />
      {editingRack && (
        <div className="doorform">
          <label className="anchfield">
            <span>name · what code calls it</span>
            <input
              className={'anchname' + (collSaid ? ' bad' : '')}
              value={collDraft ?? editingRack.name}
              placeholder="trophy_wall"
              onChange={(e) => setCollDraft(e.target.value)}
              onBlur={() => {
                if (collDraft === null) return
                const r = ed?.renameRack(editingRack.id, collDraft)
                setCollSaid(r?.why || '')
                setCollDraft(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
              }}
              spellCheck={false}
              autoFocus
            />
          </label>
          {collSaid && <div className="anchwarn">{collSaid}</div>}
          <div className="anchspot">
            <span>slots · {editingRack.slots.length}</span>
            <button
              className="mbtn wide"
              data-tip="hangs the anchor open above on the next number this rack has never handed out"
              disabled={!editingDoor}
              onClick={() => editingDoor && ed?.addRackSlot(editingRack.id, editingDoor.name)}
            >
              {editingDoor ? `add ${editingDoor.name}` : 'open an anchor above first'}
            </button>
          </div>
          {editingRack.slots.map((s, i) => (
            <div
              className={'rackrow' + (dragSlot === s.slot ? ' lifted' : '')}
              key={s.slot}
              onDragOver={(e) => {
                if (dragSlot) e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragSlot) ed?.moveRackSlot(editingRack.id, dragSlot, i)
                setDragSlot(0)
              }}
            >
              <span
                className="rackgrip"
                draggable
                data-tip="drag to change the order they fill in · the number stays where it is"
                onDragStart={() => setDragSlot(s.slot)}
                onDragEnd={() => setDragSlot(0)}
              >
                <Icon name="dots" />
              </span>
              <em className="rackno">{s.slot}</em>
              <select
                className="anchbind"
                value={s.anchor}
                onChange={(e) => ed?.updateRackSlot(editingRack.id, s.slot, { anchor: e.target.value })}
              >
                {anchorCodeOpts}
                {!doors.some((d) => d.name === s.anchor) && <option value={s.anchor}>{s.anchor} · gone</option>}
              </select>
              <button
                className="arow-x"
                data-tip="the number goes with it and is not handed out again"
                onClick={() => ed?.removeRackSlot(editingRack.id, s.slot)}
              >
                <Icon name="x" />
              </button>
            </div>
          ))}
          {rackGaps.length > 0 && (
            <div className="anchwarn">nothing on this map is called {rackGaps.join(', ')}</div>
          )}
          <div className="dooracts">
            <button className="abtn" onClick={() => openColl('rack', 0)}>
              done
            </button>
            <button
              className={'abtn danger' + (armed === 'rack:' + editingRack.id ? ' armed' : '')}
              onClick={() => {
                if (!arm('rack:' + editingRack.id)) return
                ed?.removeRack(editingRack.id)
                openColl('rack', 0)
              }}
            >
              {armed === 'rack:' + editingRack.id ? 'sure?' : 'remove'}
            </button>
          </div>
        </div>
      )}
      {racks.length > 0 && (
        <div className="evrows">
          {racks.map((r) => (
            <div
              key={r.id}
              className={'evrow' + (collEdit === `rack:${r.id}` ? ' sel' : '')}
              data-tip={`ordered slots · ${r.slots.map((q) => `${q.slot} ${q.anchor}`).join(', ') || 'empty so far'}`}
              onClick={() => openColl('rack', collEdit === `rack:${r.id}` ? 0 : r.id)}
            >
              <span className="row-ic">
                <Icon name="mark" />
              </span>
              <span className="ev-name">
                <b className={displayName(r).derived ? 'guessed' : undefined}>{displayName(r).text}</b>
                <Addr parts={[['code', r.name], [null, `${r.slots.length} slots`]]} />
              </span>
              <button
                className={'arow-x' + (armed === 'rackrow:' + r.id ? ' armed' : '')}
                data-tip={armed === 'rackrow:' + r.id ? undefined : 'remove'}
                onClick={(e2) => {
                  e2.stopPropagation()
                  if (!arm('rackrow:' + r.id)) return
                  ed?.removeRack(r.id)
                  if (collEdit === `rack:${r.id}`) openColl('rack', 0)
                }}
              >
                {armed === 'rackrow:' + r.id ? 'sure?' : <Icon name="x" />}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* variant sets are placements, not faces; two frames of one sprite give empty water the ship's collision. */}
      <Sec>variant sets</Sec>
      <Row
        icon="wand"
        label={editingDoor ? `new variant set on ${readable(editingDoor)}` : 'new variant set'}
        desc={
          editingDoor
            ? 'placements that trade places · at most one shows'
            : 'open an anchor above first · a set hangs off one'
        }
        keep
        disabled={!editingDoor}
        onClick={() => editingDoor && openColl('var', ed?.addVariantSet(editingDoor.name) || 0)}
      />
      {editingVar && (
        <div className="doorform">
          <label className="anchfield">
            <span>name · what code calls it</span>
            <HeldInput
              className="anchname"
              value={editingVar.name}
              placeholder="the_berth"
              onCommit={(v) => ed?.updateVariantSet(editingVar.id, { name: v })}
            />
          </label>
          <label className="anchfield">
            <span>on · the anchor it is addressed through</span>
            <select
              className="anchbind"
              value={editingVar.anchor}
              onChange={(e) => ed?.updateVariantSet(editingVar.id, { anchor: e.target.value })}
            >
              {anchorOpts}
              {!doors.some((d) => d.name === editingVar.anchor) && (
                <option value={editingVar.anchor}>{editingVar.anchor} · gone</option>
              )}
            </select>
          </label>
          {/* a member can only be a placement somebody NAMED: an unnamed one has
              no address for the set to hold on to */}
          <label className="anchfield">
            <span>add a placement</span>
            <select
              className="anchbind"
              data-empty="1"
              value=""
              onChange={(e) => e.target.value && ed?.addVariant(editingVar.id, e.target.value)}
            >
              <option value="">
                {bindTargets.named.length ? 'pick a named placement' : 'name a placement in step 5 first'}
              </option>
              {bindTargets.named
                .filter((a) => !editingVar.members.some((m) => m.placement === a.name))
                .map((a) => (
                  <option key={a.id} value={a.name as string}>
                    {readable(a)} · {a.name}
                  </option>
                ))}
            </select>
          </label>
          {editingVar.members.map((m) => (
            <div className="varrow" key={m.name}>
              {/* the dot turns all the way off, because nothing showing is a
                  state an author chooses and not a fallback */}
              <button
                className={'vardot' + (editingVar.initial === m.name ? ' on' : '')}
                role="radio"
                aria-checked={editingVar.initial === m.name}
                data-tip={
                  editingVar.initial === m.name
                    ? 'showing to start · press again for none showing'
                    : 'show this one to start'
                }
                onClick={() =>
                  ed?.updateVariantSet(editingVar.id, { initial: editingVar.initial === m.name ? '' : m.name })
                }
              />
              <HeldInput
                className="anchname"
                value={m.name}
                placeholder="ship_in"
                onCommit={(v) => ed?.updateVariant(editingVar.id, m.name, { name: v })}
              />
              <button
                className="arow-x"
                data-tip="take this state out of the set"
                onClick={() => ed?.removeVariant(editingVar.id, m.name)}
              >
                <Icon name="x" />
              </button>
              <span className="varplace">{m.placement}</span>
            </div>
          ))}
          {varGaps.length > 0 && (
            <div className="anchwarn">nothing on this map is called {varGaps.join(', ')}</div>
          )}
          <div className="doorhint">
            {editingVar.initial ? `${editingVar.initial} shows to start` : 'nothing shows to start'}
          </div>
          <div className="dooracts">
            <button className="abtn" onClick={() => openColl('var', 0)}>
              done
            </button>
            <button
              className={'abtn danger' + (armed === 'var:' + editingVar.id ? ' armed' : '')}
              onClick={() => {
                if (!arm('var:' + editingVar.id)) return
                ed?.removeVariantSet(editingVar.id)
                openColl('var', 0)
              }}
            >
              {armed === 'var:' + editingVar.id ? 'sure?' : 'remove'}
            </button>
          </div>
        </div>
      )}
      {variants.length > 0 && (
        <div className="evrows">
          {variants.map((v) => (
            <div
              key={v.id}
              className={'evrow' + (collEdit === `var:${v.id}` ? ' sel' : '')}
              data-tip={`at most one of ${v.members.length} shows · ${v.members.map((m) => m.name).join(', ') || 'empty so far'}`}
              onClick={() => openColl('var', collEdit === `var:${v.id}` ? 0 : v.id)}
            >
              <span className="row-ic">
                <Icon name="wand" />
              </span>
              <span className="ev-name">
                <b className={displayName(v).derived ? 'guessed' : undefined}>{displayName(v).text}</b>
                <Addr
                  parts={[
                    ['code', v.name],
                    ['on', v.anchor],
                    [null, `${v.members.length} states`],
                  ]}
                />
              </span>
              <button
                className={'arow-x' + (armed === 'varrow:' + v.id ? ' armed' : '')}
                data-tip={armed === 'varrow:' + v.id ? undefined : 'remove'}
                onClick={(e2) => {
                  e2.stopPropagation()
                  if (!arm('varrow:' + v.id)) return
                  ed?.removeVariantSet(v.id)
                  if (collEdit === `var:${v.id}`) openColl('var', 0)
                }}
              >
                {armed === 'varrow:' + v.id ? 'sure?' : <Icon name="x" />}
              </button>
            </div>
          ))}
        </div>
      )}
      <Keys
        lines={[
          'space walks, then space hops · wasd or arrows move · esc stops',
          'esc drops an armed door click',
          'laying a route: enter or double click keeps it · backspace takes a point back · esc drops it',
          'a rack slot drags up and down · its number does not move with it',
          'z undoes',
        ]}
      />
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
  // the condition a layer carries. A group only gets a row in the document once
  // it says something, so most maps answer '' here and grow no field.
  const whenOfGroup = (name: string) => (st?.groups ?? []).find((g) => g.name === name)?.when ?? ''
  /* read off the sets, because membership lives there and a placement has no idea it is in one. */
  const selVariant = (() => {
    if (!selA?.name) return null
    for (const v of variants) {
      const m = v.members.find((q) => q.placement === selA.name)
      if (m) return { set: v, member: m }
    }
    return null
  })()
  /* EVERY FACE THIS PLACEMENT HAS, numbered the way `art` numbers them: slot 0
   * is the picture it was placed with and slot 1 is looks[0]. That off-by-one
   * lives in lookOf and this list only counts. */
  const selFaces = selA ? [0, ...(selA.looks || []).map((_, i) => i + 1)] : []
  const groupNames = [...SUGGESTED_GROUPS]
  for (const a of assets) if (!groupNames.includes(a.group)) groupNames.push(a.group)
  const thumbOf = (a: { src?: string; frames?: string[] }) => a.src || (a.frames && a.frames[0]) || ''
  // one picture off any library item, whichever of the three shapes it is: a
  // png, a folder of frames, or a set of headings
  const shotOf = (a: api.LibItem) => a.src || a.frames?.[0] || a.dirs?.south?.[0] || ''
  /* one movement value for a placement or a whole set, since runLife reads the live selection either way. */
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

  /* the price per take: an animated object is two, a moving sprite is nine, and standard mode is assumed. */
  const spriteDirs = genPlan?.sprite
    ? genPlan.sprite.anim.how === 'none'
      ? 0
      : CHAR_DIRS
    : genType === 'animated'
      ? CHAR_DIRS
      : 0
  /* each split-out face is another generation, so the button says the total before it is pressed. */
  const spriteFaces = makeWhat === 'sprite' ? (genPlan?.faces || []).length : 0
  // a body drawn in the game's style is a pro body, and a pro body is twenty
  const styled = makeWhat === 'sprite' && styleOn && !!styleId
  const perTake = makeWhat === 'sprite' ? (styled ? PRO_BODY : 1) + spriteDirs + spriteFaces : genType === 'animated' ? 2 : 1
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
  /* animating is the library row, not one copy: it rewrites the art in place under the row's own name. */
  const libItem = st?.placing ? (lib || []).find((it) => it.name === st.placing) : undefined
  const animItem = selItem || libItem
  /* kind cannot answer this: a set of headings is 'static' either way, so count the frames in a heading. */
  const selWays = animItem?.dirs ? Object.keys(animItem.dirs).length : 0
  const selMoves = !!(
    animItem &&
    (animItem.kind === 'animated'
      ? (animItem.frames?.length ?? 0) > 1
      : (Object.values(animItem.dirs ?? {})[0]?.length ?? 0) > 1)
  )
  /* a ceiling and not a promise: eight headings is at most eight and a written recipe costs none. */
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
  /* nothing here enumerates what an animation can be, and one value serves both places the box appears. */
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
        {/* words, not icons: one is free behaviour and the other spends, and two round buttons could not say which. */}
        <span className="insp-acts">
        <button
          className={'actpill' + (lifeOpen ? ' on' : '') + (selA.life ? ' has' : '')}
          data-tip={selA.life ? 'change how it moves · free' : 'give it a way of moving · free'}
          /* opening one closes the other: two boxes stacked open read as though the same words go in both. */
          onClick={() => {
            setLifeOpen((v) => !v)
            setFaceOpen(false)
            setLifeNote('')
          }}
        >
          <Icon name="sparkle" />
          moves
        </button>
        {/* one generation editing the art already on the account; off with no origin on record, and it says so. */}
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
      {/* face names, with the index `art` stores kept beside them so anything reading by number is unaffected. */}
      {selFaces.length > 1 && (
        <div className="lookrows">
          <span className="grainlab">faces · what code shows by name</span>
          {selFaces.map((i) => {
            const L = lookOf(selA, i)
            const shot = L.src || L.frames?.[0] || Object.values(L.dirs || {})[0]?.[0] || ''
            return (
              <div className="lookrow" key={i}>
                <em className="lookno">{i}</em>
                <span className="lookth">{shot ? <img src={shot} alt="" /> : null}</span>
                <HeldInput
                  className="anchname"
                  value={(i === 0 ? selA.lookName : L.name) ?? ''}
                  placeholder={i === 0 ? 'as it was placed' : 'unnamed'}
                  onCommit={(v) => ed?.setLookName(selA.id, i, v)}
                />
              </div>
            )
          })}
        </div>
      )}
      {/* the address, usually blank. the machine id does not survive re-placing, so this is the only stable name. */}
      <label className="anchfield">
        <span>name · what code calls it</span>
        <input
          className={'anchname' + (pnameSaid?.id === selA.id ? ' bad' : '')}
          value={pnameDraft ?? selA.name ?? ''}
          placeholder="unnamed"
          onChange={(e) => setPnameDraft(e.target.value)}
          onBlur={() => {
            if (pnameDraft === null) return
            const r = ed?.namePlacement(selA.id, pnameDraft)
            setPnameSaid(r?.why ? { id: selA.id, why: r.why } : null)
            setPnameDraft(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
          }}
          spellCheck={false}
        />
      </label>
      {pnameSaid?.id === selA.id && <div className="anchwarn">{pnameSaid.why}</div>}
      {/* it is one of several that trade places, not scenery. Said here because
          the set itself lives two steps back, on step 4, and nothing on this
          placement would otherwise admit it is half of a pair. */}
      {selVariant && (
        <div className="doorhint">
          one of {selVariant.set.members.length} in {selVariant.set.name} · this one is{' '}
          {selVariant.member.name}
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
      {/* WHEN THIS ONE IS THERE, and it beats its group's where both exist. */}
      <WhenField
        what="this one"
        value={selA.when ?? ''}
        onCommit={(v) => ed?.setAssetWhen([selA.id], v)}
      />
      {/* WHAT IT BLOCKS ON THE GROUND. Measured off the sprite's own alpha at
          publish, which is right nearly always, so blank is the answer here and
          four numbers are the correction. */}
      <FootField
        value={selA.foot}
        onCommit={(f) => ed?.setFoot([selA.id], f)}
      />
      {/* a group's condition is inherited rather than copied, so a placement
          with none of its own is not unconditional and must not read as if it
          is */}
      {!selA.when && whenOfGroup(selA.group) && (
        <div className="doorhint">inherits {whenOfGroup(selA.group)} from {selA.group}</div>
      )}
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
      {/* WHICH OF TWO OVERLAPPING THINGS IS IN FRONT. It writes a nudge to the sort key and
          moves nothing: the older version of these two shifted the placement down the map, which
          put it in front and also stood it somewhere its author had not put it. The step is
          measured against what this actually covers, so one press clears the thing in the way. */}
      <div className="actrow">
        <button
          className="abtn"
          data-tip="in front of what it overlaps · it does not move"
          onClick={() => ed?.order('front')}
        >
          move forward
        </button>
        <button
          className="abtn"
          data-tip="behind what it overlaps · it does not move"
          onClick={() => ed?.order('back')}
        >
          move back
        </button>
        {!!selA.z && (
          <button className="abtn" data-tip="sort by where it stands again" onClick={() => ed?.orderReset()}>
            reset order
          </button>
        )}
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
        {/* THE WAY BACK, and the way back to the way back. Asked for by name: reverting was the
            only road and it steps back one version whatever that version happens to be. It offers
            "bring it back" on anything standing still, because whether frames were ever kept for a
            row is a question only the server can answer, and it answers it in a sentence. */}
        {animItem && (
          <button
            className="abtn"
            data-tip={
              selMoves
                ? 'keep the first picture and stop the movement · nothing is generated'
                : 'put back the frames it had, if it ever had any · nothing is generated'
            }
            onClick={() => void doAnimSwitch(animItem.name, !selMoves)}
            disabled={plBusy || !!animRun}
          >
            {selMoves ? 'remove animation' : 'bring it back'}
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
      {/* who a pixel edit lands on, said before it happens. off by default, as one row drives every placement. */}
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

  // two cells in a 272px panel, so the largest whole multiple shows; a fraction blurs the pixels being judged
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
      {/* "none of them" says so up here rather than under a row, where a reason would read as a recommendation. */}
      {looking ? (
        <div className="fxlooking pllook">looking at them…</div>
      ) : said && said.verdict === 'revise' ? (
        <div className="pllook plmiss">{said.why}</div>
      ) : null}
      <div className="plrows">
        {pl.items.map((it, i) => {
          const chosen = pl.pick === i
          /* clickable whatever the look said: needing a chosen one left "none of these" with no way to keep any. */
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
          <span key={c} style={{ background: c }} data-tip={c} />
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

  // the account's objects, browsable; nothing on this path can spend anything and the panel foot says so
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

  /* many at once: in front and behind are a nudge to the sort key, so the picked placements stay
     exactly where their author put them. See Editor.order. */
  /* the group every picked placement is already in, or blank when they differ,
     so the select never claims a crowd is somewhere only one of them is */
  const manyPicked = assets.filter((a) => selAll.includes(a.id))
  const manyGroup = manyPicked.every((a) => a.group === manyPicked[0]?.group) ? (manyPicked[0]?.group ?? '') : ''
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
      {/* one group onto the whole pick. The select next door acts on one
          placement, so a crowd was regrouped one at a time. */}
      <label className="insp-row">
        <span>group</span>
        <select
          value={manyGroup}
          onChange={(e) => {
            const n = ed?.setAssetGroup(selAll, e.target.value) ?? 0
            push(`${n} → ${e.target.value}`)
          }}
        >
          <option value="">mixed</option>
          {groupNames.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </label>
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
        <button className="abtn tiny" data-tip="in front of what they overlap · they do not move" onClick={() => ed?.order('front')}>
          forward
        </button>
        <button className="abtn tiny" data-tip="behind what they overlap · they do not move" onClick={() => ed?.order('back')}>
          back
        </button>
        {manyPicked.some((a) => a.z) && (
          <button className="abtn tiny" data-tip="sort by where they stand again" onClick={() => ed?.orderReset()}>
            reset order
          </button>
        )}
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

  /* chips and not a stacked list, which was the tallest thing in the column after the tuner. */
  const groupStrip = (
    <>
      <div className="grpstrip">
        {groupNames
          .map((g) => ({ g, n: assets.filter((a) => a.group === g).length }))
          .filter((q) => q.n > 0)
          .map(({ g, n }) => {
            const hidden = hiddenSet.has(g)
            return (
              /* the eye is forgotten, the condition ships in the bundle, so the chip grows a target instead of an input. */
              <span className="grpwrap" key={g}>
                <button
                  className={'grpchip' + (hidden ? ' off' : '')}
                  data-tip={hidden ? 'show ' + g : 'hide ' + g}
                  onClick={() => ed?.setGroupHidden(g, !hidden)}
                >
                  <Icon name={hidden ? 'eyeoff' : 'eye'} />
                  {g}
                  <span className="grp-n">{n}</span>
                </button>
                {/* a word, not a pictogram: nothing drawn means "a condition" and trigger already means an anchor kind. */}
                <button
                  className={
                    'grpwhen' + (grpWhen === g ? ' on' : '') + (whenOfGroup(g) ? ' has' : '')
                  }
                  data-tip={
                    whenOfGroup(g) ? `${g} is there when ${whenOfGroup(g)}` : `say when ${g} is there`
                  }
                  onClick={() => setGrpWhen(grpWhen === g ? '' : g)}
                >
                  when
                </button>
              </span>
            )
          })}
        {!assets.length && <span className="grpnone">nothing placed yet</span>}
      </div>
      {/* one condition per layer, because copying the string onto each placement loses it on the thirteenth. */}
      {grpWhen && (
        <div className="doorform">
          <WhenField
            what={`the ${grpWhen} layer`}
            value={whenOfGroup(grpWhen)}
            onCommit={(v) => ed?.setGroupWhen(grpWhen, v)}
          />
          <div className="dooracts">
            <button className="abtn" onClick={() => setGrpWhen('')}>
              done
            </button>
          </div>
        </div>
      )}
    </>
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
    // asks for an area, an asset ask can resolve to more than one thing
    if (scene) return void runMany()
    if (makeWhat === 'fill') return void doScenePlan()
    // a sprite runs the same two presses a thing does: the router answers the
    // plan, and the second press buys it.
    return void doGen()
  }, [makeWhat, scene, armFx, runMany, doScenePlan, doGen])

  const wantedInScene = scene ? scene.items.length - sceneOff.size : 0
  /* the total behind an armed set: an animated thing is a base plus frames, so nine of them is eighteen. */
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
        ? // the same rest state the other three have, rather than lit and
          // disabled: "box the area first" in the press-me colour is a button asking to be pressed and refusing
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
  /* four takes of a moving sprite is thirty-six generations, said before the read and not only after it. */
  const takeWord = genCount === 1 ? '' : `, ${genCount} takes · ${genCost} generations`
  /* fill's total: twenty-four animated things is forty-eight generations, and it named no number before. */
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
            `${CHAR_DIRS} ways${genType === 'animated' ? ' + motion' : ''}${styled ? ` · in the game's style` : ''} · ${genType === 'animated' ? 'five to fifteen minutes' : 'two to five minutes'}${takeWord}${usd ? ` · ${usd} left` : ''}`
        : makeWhat === 'fill'
          ? `${genBox ? `the boxed ${genBox.w}×${genBox.h}` : 'box an area'} · ${fillWord}${usd ? ` · ${usd} left` : ''}`
          : /* the ask resolved to several things. It says so here rather than
               going on describing one png, and it says where they land, because
               that is the one thing this differs from a fill in. */
            scene
            ? `${wantedInScene} thing${wantedInScene === 1 ? '' : 's'} · ${manyGens} generation${manyGens === 1 ? '' : 's'} · into the library${usd ? ` · ${usd} left` : ''}`
            : `${genBox ? `reads the boxed ${genBox.w}×${genBox.h}` : 'reads the whole map'} · ${genType === 'animated' ? 'sprite + 8 frames' : 'one png'}${takeWord}${usd ? ` · ${usd} left` : ''}`

  /* ---- the make strip: one ask box and a three-way, where two stacked boxes ran the identical gesture ---- */
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
              // takes reset to one on a mode change: eight is seventy-two generations the moment the mode says sprite
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
                  ? /* the only place anybody learns one ask can name what it turns into as well as the body, so it has to fit the box */
                    'e.g. a troll that curls into a boulder and rolls'
                  : /* the only place anybody finds out a plural ask is allowed, and it has to fit the box rather than be clipped */
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
      {/* still or moving; for a sprite the router decides what moving is, which is not always a walk cycle. */}
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
      {/* takes of one thing, where fill's identical-looking slider counts a set of different ones. */}
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
              // for is not the confirm that was agreed to
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
      {/* the look, for runs that open no compare panel: a sprite, a set, or a painting with no colours yet. */}
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

  /* ---- the plan cards: what the model decided before anything is bought, with the set's rows strikeable ---- */
  const spriteRoute = genPlan?.sprite
  const planCard = genPlan && (
    <div className="planbox">
      <div className="plannote">{genPlan.note || 'read the map'}</div>
      {spriteRoute && (
        <>
          <div className="planmeta">
            {styled
              ? `pro · ${styleView || spriteRoute.view} · ${STYLE_SIZE}px · ${CHAR_DIRS} ways · ${PRO_BODY} for the body`
              : `${spriteRoute.skeleton} rig · ${spriteRoute.view} · ${spriteRoute.size}px · ${CHAR_DIRS} ways`}
          </div>
          {/* the template rig cannot match an existing character whatever the words say; a reference's rotations can. */}
          <Row
            icon="rect"
            label={styleOn ? "in the game's style" : 'in the template style'}
            desc={
              styleOn
                ? styleId
                  ? `a pro body matched to ${styleName || 'the map\'s style character'} · ${PRO_BODY} instead of 1`
                  : 'pick whose style this map draws people in, once'
                : `rig-drawn · 1 for the body · switch on to match ${styleName || 'the game\'s character'}`
            }
            on={styleOn}
            onClick={() => setStyleOn((v) => !v)}
          />
          {styleOn && !styleId && (
            <label className="anchfield">
              <span>whose style · one of your eight-way characters</span>
              <select
                value=""
                onChange={(ev) => {
                  const c = (chars?.items || []).find((q) => q.id === ev.target.value)
                  if (!c) return
                  // written once into the map's own bag, where the export
                  // panel already lets it be read and changed by hand
                  ed?.setProps({
                    meta: { ...(st?.props.meta || {}), [STYLE_ID]: c.id, [STYLE_VIEW]: c.view, [STYLE_NAME]: c.name },
                  })
                }}
              >
                <option value="">choose…</option>
                {(chars?.items || [])
                  .filter((c) => c.directions === 8)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.size ? ` · ${c.size}` : ''}
                      {c.view ? ` · ${c.view}` : ''}
                    </option>
                  ))}
              </select>
              {chars?.busy && <div className="plannote">reading your characters…</div>}
              {chars?.err && <div className="anchwarn">{chars.err}</div>}
            </label>
          )}
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
      {/* what else it heard, since otherwise the only sign of a second half is a bigger number on the button. */}
      {!!genPlan.faces?.length && (
        <div className="planmeta">
          also draws {genPlan.faces.map((f) => f.name).join(', ')} · {genPlan.faces.length} more
          {genPlan.faces.length > 1 ? ' generations' : ' generation'}
        </div>
      )}
      {genPlan.does && <div className="plannote">then: {genPlan.does}</div>}
      {genPlan.crossing && <div className="planmeta">{genPlan.crossing}</div>}
      <div className="planmeta">
        {/* w and h are the prop path's; a sprite posts route.size, so printing both put two numbers on one thing. */}
        {spriteRoute ? '' : `${genPlan.w}×${genPlan.h}${genPlan.motion ? ` · ${genPlan.motion}` : ''}`}
        <button className="planshow" onClick={() => setGenShow((v) => !v)}>
          {genShow ? 'hide the words' : 'the words'}
        </button>
      </div>
      {genShow && <div className="planprompt">{genPlan.prompt}</div>}
    </div>
  )

  /* the first take with the run held; it is already paid for, so the only question is buying the rest. */
  const gateCard = gate && (
    <div className="planbox gatebox">
      {/* fillRun tells a planned set from a run of takes, and only a set has one. */}
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
              /* the whole ask, because the row shows the first line of it and a
                 scene item is picked by what was asked for */
              data-tip={it.prompt}
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
                data-tip={c}
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

  /* every ask as it was typed, because the library kept only a four-word slug of it. */
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
              /* what pressing it does: it said "made <name>", repeating the words already under the pointer. */
              data-tip="puts this ask back in the box, to edit and run again"
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
      {/* the make strip on top, then one context zone: six things competing for a 272px column each got a slice. */}
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
      {/* the zone switch is here too, because reaching it should not cost a step change and back. */}
      <AnchorsShown ed={ed} on={!!st?.eventsVisible} />
      {anchorForm}
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
      {/* bundle fields. title was machine-filled with the slug, and class unwritten leaves the engine guessing. */}
      <Sec>this map</Sec>
      <label className="anchfield">
        <span>name · what a player reads</span>
        <input
          value={st?.props.title ?? ''}
          placeholder={st?.sceneId}
          onChange={(e) => ed?.setProps({ title: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
          }}
        />
      </label>
      <div className="anchkinds">
        {MAP_CLASSES.map((k) => (
          <button
            key={k}
            className={'kbtn' + (st?.props.class === k ? ' on' : '')}
            onClick={() => ed?.setProps({ class: k })}
            data-tip={MAP_CLASS_WHAT[k]}
          >
            {k}
          </button>
        ))}
      </div>
      {/* the id is the publish slug, every door's target and the save key at once; renaming carries the doors. */}
      <label className="anchfield">
        <span>id · what code and every door calls it</span>
        <input
          className="anchname"
          value={idDraft ?? st?.sceneId ?? ''}
          onChange={(e) => setIdDraft(e.target.value)}
          onBlur={() => {
            if (idDraft === null) return
            void doRename(idDraft)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
          }}
          spellCheck={false}
        />
      </label>
      {idSaid && <div className="anchwarn">{idSaid}</div>}
      <label className="anchfield">
        <span>about · the offering it teaches</span>
        <input
          className="anchname"
          value={st?.props.islandId ?? ''}
          placeholder="blank means it teaches nothing"
          onChange={(e) => ed?.setProps({ islandId: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
          }}
          spellCheck={false}
        />
      </label>
      {/* the map's own bag; without one, map-scoped data hung on a meta of some arbitrarily chosen anchor. */}
      <div className="metarows">
        {[...Object.entries(st?.props.meta ?? {}), ['', '']].map(([k, v], i) => (
          <div className="metarow" key={k || 'new' + i}>
            <input
              className="anchname"
              defaultValue={k}
              placeholder="key"
              onBlur={(e) => {
                const nk = e.target.value.trim()
                if (nk === k) return
                // the new name takes the old one's value with it, and clearing
                // the name is how a key is removed
                if (nk) ed?.setMapMeta(nk, String(v ?? ''))
                if (k) ed?.setMapMeta(k, null)
              }}
              spellCheck={false}
            />
            <input
              defaultValue={String(v ?? '')}
              placeholder="value"
              onBlur={(e) => {
                // the key is whatever is in the box to the left, which on the
                // blank row at the bottom is a key that was named a moment ago
                const kk = (e.currentTarget.parentElement?.querySelector('input') as HTMLInputElement)?.value.trim()
                if (kk) ed?.setMapMeta(kk, e.target.value)
              }}
              spellCheck={false}
            />
          </div>
        ))}
      </div>
      {/* measured off the shipped bytes; type here only when an alpha halo makes the footprint too big. */}
      <label className="anchfield">
        <span>painting · w, h, ox, oy inside the canvas</span>
        <input
          className="anchname"
          value={paintDraft ?? (st?.props.paint ? st.props.paint.join(', ') : '')}
          placeholder="measured off the picture"
          onChange={(e) => setPaintDraft(e.target.value)}
          onBlur={() => {
            if (paintDraft === null) return
            const n = paintDraft
              .split(/[ ,]+/)
              .filter(Boolean)
              .map(Number)
            ed?.setProps({ paint: n.length === 4 && n.every((v) => isFinite(v)) ? (n as [number, number, number, number]) : null })
            setPaintDraft(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
          }}
          spellCheck={false}
        />
      </label>
      {/* stairs stay machine made; a press lays a named region over one, and it costs three flood fills. */}
      <Sec>stairs</Sec>
      <div className="manyrow">
        <button className="abtn tiny" onClick={() => setStairs(ed?.stairList() ?? [])}>
          find them
        </button>
        {stairs !== null && <span className="doorhint">{stairs.length} found</span>}
      </div>
      {(stairs ?? []).map((r, i) => (
        <div className="manyrow" key={`${r.value}-${r.rect.join(',')}`}>
          <span className="doorhint">
            {r.connects[0]} to {r.connects[1]} · {r.px}px at {r.rect[0]}, {r.rect[1]}
          </span>
          <button
            className="abtn tiny"
            data-tip="put a named region over it, so python can address this stair"
            onClick={() => {
              ed?.markStair(r)
              push(`stair ${i + 1} marked · name it on step 3`)
            }}
          >
            name it
          </button>
        </div>
      ))}
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

        {/* the step rides on the stage for the cursor: export answers no clicks and still wore the crosshair. */}
        <div className="stage" data-step={step} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
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
