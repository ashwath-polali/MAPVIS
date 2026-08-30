/* THE UI SURFACE, WHICH IS A PAINTING NOBODY COULD ADDRESS.
 *
 * A dialogue box, a bar, a portrait frame: the generator draws one as a single
 * panel, and a panel is a picture with no parts. The game then has to put a
 * name at 14,9 and a number at 210,9 and a fill bar across the middle, and
 * until now every one of those numbers lived as a constant in the game repo
 * next to the drawing code, which means the art and the layout were kept in two
 * places by hand and the second one was never written down.
 *
 * A slot is the fix. It is a rectangle in the surface's own pixels with a name
 * and a kind, marked here on top of the picture, so the game asks for the panel
 * and gets told where its text goes rather than guessing.
 *
 * NO AUTOSAVE, the same rule the ocean follows. A half-drawn rectangle is not a
 * layout, and what comes back from the save is what the server kept, refusals
 * and all.
 *
 * GENERATION IS A PRESS AND ONLY A PRESS. One surface is twenty to forty
 * PixelLab generations of real money, so nothing on this page posts to
 * /api/ui/generate except the button under a filled-in form.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, go } from './router'
import { useSession } from './session'
import { anchorName, isAnchorName } from '../core/mask'
import { displayName, readable } from '../core/naming'
import './surfaces.css'

/* What a slot can BE comes down with the listing, the way the ocean's island
 * states do, so a kind added on the server turns up in the select without this
 * file being touched. The list here is only what to draw with before the first
 * answer arrives. */
const KINDS = ['text', 'number', 'bar', 'button', 'icon', 'image']

/* meta is carried and never edited. Nothing on this page reads it yet, and a
 * page that drops a field on save is a page that quietly deletes whatever set
 * it, which is the one thing a save must never do. */
type Slot = {
  name: string
  kind: string
  x: number
  y: number
  w: number
  h: number
  align?: string
  meta?: Record<string, unknown>
}
type Surface = {
  name: string
  title: string
  description: string
  w: number
  h: number
  status: string
  slots: Slot[]
  src?: string
}

type Hit = { kind: 'slot' | 'size'; i: number } | null
type Band = { x0: number; y0: number; x1: number; y1: number } | null

/* THE TOKENS, WRITTEN OUT, because a 2d context cannot read a custom property.
 * That is the one exception world.css already carves for its own chart, and the
 * rule that comes with it is that every value here NAMES the token it mirrors,
 * so a token that moves can be followed here instead of quietly drifting off it.
 * Two of these had already drifted: the status green was #4f9b84 where
 * --acc-live is #6fbf9d, and the fallback was --ink-edge, which tokens.css says
 * in capitals is not a text colour. */
const TOK = {
  tool: '#d4a53c', // --acc-tool
  toolLit: '#f0c869', // --acc-tool-lit
  live: '#6fbf9d', // --acc-live
  stop: '#b04a2f', // --acc-stop
  ink: '#e6e9ee', // --ink
  ink3: '#7d8ea1', // --ink-3, and the floor for anything with words in it
  void: '#070b11', // --void
  panel: '#10141a', // --panel
} as const

/* ONE INK PER KIND, so a panel with fifteen marks on it can be read without
 * clicking any of them. Gold is the button, because a button is the one slot
 * the player presses and gold is what the tool uses when it is talking. The
 * three that are not accents are a categorical set, the way the level colours
 * are: they mean "a different kind", not "good" or "armed". */
const KIND_INK: Record<string, string> = {
  text: '#8fa6bb',
  number: TOK.live,
  bar: TOK.stop,
  button: TOK.tool,
  icon: '#6f8296',
  image: '#6d5f9e',
}
/* the status names come from the server, so anything it invents later still
 * draws in the fallback rather than vanishing off the rail */
const STATUS_INK: Record<string, string> = {
  pending: TOK.tool,
  drawing: TOK.tool,
  ready: TOK.live,
  done: TOK.live,
  failed: TOK.stop,
  error: TOK.stop,
}
const inkFor = (m: Record<string, string>, k: string) => m[k] || TOK.ink3

const LABEL = '500 11px "Archivo Narrow", sans-serif'
const MONO = '400 9px "Martian Mono", monospace'

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const whole = (v: unknown, fallback = 0) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? n : fallback
}
const freeName = (stem: string, taken: string[]) => {
  let n = 1
  while (taken.includes(`${stem}_${n}`)) n++
  return `${stem}_${n}`
}

const asSlot = (s: Partial<Slot>): Slot => ({
  name: String(s?.name || ''),
  kind: String(s?.kind || 'text') || 'text',
  x: whole(s?.x),
  y: whole(s?.y),
  w: Math.max(1, whole(s?.w, 1)),
  h: Math.max(1, whole(s?.h, 1)),
  ...(s?.align ? { align: String(s.align) } : {}),
  ...(s?.meta ? { meta: s.meta } : {}),
})
const asSurface = (a: Partial<Surface>): Surface => ({
  name: String(a?.name || ''),
  title: String(a?.title || ''),
  description: String(a?.description || ''),
  w: Math.max(1, whole(a?.w, 256)),
  h: Math.max(1, whole(a?.h, 256)),
  status: String(a?.status || ''),
  slots: (Array.isArray(a?.slots) ? a.slots : []).map(asSlot),
  ...(a?.src ? { src: String(a.src) } : {}),
})

/* THE SIZE IS ASPECT-GATED AND THE TWO MAXIMUMS DO NOT COMBINE.
 *
 * The generator resolves whatever ratio it is handed to the nearest of these
 * five and then applies THAT one's ceiling, which is why 688x512 comes back
 * refused: it reads as 4:3, and 4:3 stops at 600x448. Checked here so a form
 * that cannot be drawn says so before the press rather than after it. */
const GATES = [
  { w: 512, h: 512, say: 'square, up to 512×512' },
  { w: 688, h: 384, say: '16:9, up to 688×384' },
  { w: 384, h: 688, say: '9:16, up to 384×688' },
  { w: 600, h: 448, say: '4:3, up to 600×448' },
  { w: 448, h: 600, say: '3:4, up to 448×600' },
]
const gateFor = (w: number, h: number) => {
  let best = GATES[0]
  let near = Infinity
  for (const g of GATES) {
    const d = Math.abs(Math.log(w / h) - Math.log(g.w / g.h))
    if (d < near) {
      near = d
      best = g
    }
  }
  return best
}
const sizeSay = (w: number, h: number) => {
  if (!(w >= 192 && h >= 192)) return 'both sides start at 192'
  if (w > 688 || h > 688) return 'neither side goes past 688'
  const g = gateFor(w, h)
  return w > g.w || h > g.h ? `${w}×${h} reads as ${g.say}, so the generator refuses it` : ''
}

/* The generator's own list of named elements. Naming one scaffolds that part
 * into the panel and positions it, so this is the closest thing the form has to
 * saying what the panel is FOR. */
const ELEMENTS = [
  'button',
  'icon_button',
  'toolbar',
  'tab',
  'panel',
  'window',
  'health_bar',
  'avatar',
  'triangle',
  'pentagon',
  'hexagon',
  'octagon',
]

/* ---- the surface ---------------------------------------------------------- */

function paint(
  c: CanvasRenderingContext2D,
  s: { w: number; h: number },
  z: number,
  img: HTMLImageElement | null,
  slots: Slot[],
  sel: number,
  hover: Hit,
  band: Band,
) {
  const W = s.w * z
  const H = s.h * z

  if (img) {
    /* THE CHECKER IS NOT DECORATION. A panel is generated with no background,
     * so a surface drawn on a flat fill gives no way to tell a transparent hole
     * from a dark painted one, and a slot marked over the hole is a slot the
     * player never sees. */
    const cell = 8
    c.fillStyle = TOK.void
    c.fillRect(0, 0, W, H)
    c.fillStyle = TOK.panel
    for (let y = 0; y < H; y += cell) {
      for (let x = ((y / cell) % 2) * cell; x < W; x += cell * 2) c.fillRect(x, y, cell, cell)
    }
    // whole-number zoom and no smoothing, or the art stops being pixel art the
    // moment you look at it closely, which is the one thing this page is for
    c.imageSmoothingEnabled = false
    c.drawImage(img, 0, 0, W, H)
  } else {
    // the frame a surface has before it has a picture. Slots get marked on this
    // exactly as they do on the art, because the size is known from the moment
    // the surface is asked for and the layout does not have to wait on paint.
    c.fillStyle = TOK.panel
    c.fillRect(0, 0, W, H)
    c.strokeStyle = TOK.tool + '11'
    c.beginPath()
    for (let x = 16; x < s.w; x += 16) {
      c.moveTo(Math.round(x * z) + 0.5, 0)
      c.lineTo(Math.round(x * z) + 0.5, H)
    }
    for (let y = 16; y < s.h; y += 16) {
      c.moveTo(0, Math.round(y * z) + 0.5)
      c.lineTo(W, Math.round(y * z) + 0.5)
    }
    c.stroke()
    c.font = LABEL
    // --ink-3 and not --ink-edge. This is a sentence somebody reads, and the
    // edge step is 3.3:1, under the floor for text.
    c.fillStyle = TOK.ink3
    const say = 'nothing painted here yet'
    c.fillText(say, (W - c.measureText(say).width) / 2, H / 2 - 4)
    c.font = MONO
    const sz = `${s.w}×${s.h}`
    c.fillText(sz, (W - c.measureText(sz).width) / 2, H / 2 + 12)
  }

  for (let i = 0; i < slots.length; i++) {
    const sl = slots[i]
    const on = i === sel
    const lit = on || hover?.i === i
    const tint = inkFor(KIND_INK, sl.kind)
    const bx = sl.x * z
    const by = sl.y * z
    const bw = Math.max(2, sl.w * z)
    const bh = Math.max(2, sl.h * z)

    c.fillStyle = tint
    c.globalAlpha = lit ? 0.3 : 0.16
    c.fillRect(bx, by, bw, bh)
    c.globalAlpha = 1
    c.strokeStyle = on ? TOK.toolLit : tint
    c.lineWidth = on ? 2 : 1
    c.strokeRect(bx + 0.5, by + 0.5, bw, bh)
    c.lineWidth = 1

    /* the label sits on a plate, unlike the ocean's, because there is a
     * painting under it here and plain text over a bright panel is unreadable
     * at exactly the moment you need to know which slot you are looking at */
    c.font = LABEL
    // WORDS ON THE PLATE, NOT THE IDENTIFIER. It drew `hp_bar` over the
    // painting, which is the one thing Ash ruled out on every surface. The
    // identifier is still on the roster row and in the field being typed into,
    // which is where somebody checking the spelling is looking.
    const say = readable(sl)
    const tw = c.measureText(say).width
    const above = by >= 16
    const ly = above ? by - 15 : by + 1
    c.fillStyle = TOK.void + 'c7'
    c.fillRect(bx, ly, tw + 8, 14)
    c.fillStyle = on ? TOK.toolLit : TOK.ink
    c.fillText(say, bx + 4, ly + 11)
    if (bh > 30 && bw > 40) {
      c.font = MONO
      c.fillStyle = tint
      c.fillText(sl.kind, bx + 4, by + bh - 5)
    }

    if (on) {
      c.fillStyle = TOK.toolLit
      c.fillRect(bx + bw - 4, by + bh - 4, 8, 8)
    }
  }

  if (band) {
    c.setLineDash([4, 3])
    c.strokeStyle = TOK.live
    c.strokeRect(
      Math.min(band.x0, band.x1) * z,
      Math.min(band.y0, band.y1) * z,
      Math.abs(band.x1 - band.x0) * z,
      Math.abs(band.y1 - band.y0) * z,
    )
    c.setLineDash([])
  }

  c.strokeStyle = TOK.tool + '73'
  c.strokeRect(0.5, 0.5, W - 1, H - 1)
}

/* What is under the pointer, in the order things are drawn on top of each
 * other: the resize handle of the selected slot, then the slots newest first.
 * Nothing else on this canvas is clickable, because everything under the slots
 * is a painting. */
function under(slots: Slot[], z: number, sel: number, mx: number, my: number): Hit {
  const s = slots[sel]
  if (s && Math.abs(mx - (s.x + s.w) * z) <= 6 && Math.abs(my - (s.y + s.h) * z) <= 6) return { kind: 'size', i: sel }
  for (let i = slots.length - 1; i >= 0; i--) {
    const sl = slots[i]
    if (mx >= sl.x * z && mx <= (sl.x + sl.w) * z && my >= sl.y * z && my <= (sl.y + sl.h) * z) return { kind: 'slot', i }
  }
  return null
}

/* ---- the page ------------------------------------------------------------- */

type Form = {
  name: string
  title: string
  description: string
  width: number
  height: number
  palette: string
  elements: string[]
  style: string
}
const BLANK: Form = {
  name: '',
  title: '',
  description: '',
  width: 384,
  height: 256,
  palette: '',
  elements: [],
  style: '',
}

export default function Surfaces() {
  const { user, loading } = useSession()
  const [assets, setAssets] = useState<Surface[] | null>(null)
  const [kinds, setKinds] = useState<string[]>(KINDS)
  const [aligns, setAligns] = useState<string[]>([])
  const [why, setWhy] = useState('')
  const [sel, setSel] = useState('')
  const [slots, setSlots] = useState<Slot[]>([])
  const [pick, setPick] = useState(-1)
  const [hover, setHover] = useState<Hit>(null)
  const [band, setBand] = useState<Band>(null)
  const [dirty, setDirty] = useState(false)
  const [stashed, setStashed] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [z, setZ] = useState(2)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [redraw, setRedraw] = useState(0)
  const [making, setMaking] = useState(false)
  const [form, setForm] = useState<Form>(BLANK)
  const [maps, setMaps] = useState<Array<{ slug: string; title: string }>>([])
  const [sure, setSure] = useState(false)

  const stage = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ kind: 'slot' | 'size'; i: number; dx: number; dy: number } | null>(null)
  const from = useRef<{ x: number; y: number } | null>(null)
  /* MARKS IN PROGRESS SURVIVE A CLICK ON ANOTHER SURFACE. Twenty rectangles
   * dragged out by hand are half an hour, and losing them to a stray click on
   * the rail is the kind of thing that stops somebody using a tool. */
  const draft = useRef<Map<string, Slot[]>>(new Map())

  const cur = (assets || []).find((a) => a.name === sel) || null

  /* null means the ask itself failed, and that is not the same sentence as an
   * empty list. An empty list is "you have no surfaces", which draws the form;
   * a failure leaves what is on screen alone, and only the first read is
   * allowed to put the page in the error state. */
  const load = useCallback(async (first = false): Promise<Surface[] | null> => {
    try {
      const r = await fetch('/api/ui')
      if (!r.ok) throw new Error(`the surfaces would not load (${r.status})`)
      const j = await r.json()
      const list: Surface[] = (Array.isArray(j.ui) ? j.ui : Array.isArray(j.assets) ? j.assets : []).map(asSurface)
      setAssets(list)
      // the vocabularies ride along with the listing, so this is the only place
      // that has to know they exist
      if (Array.isArray(j.kinds) && j.kinds.length) setKinds(j.kinds.map(String))
      if (Array.isArray(j.aligns)) setAligns(j.aligns.map(String))
      return list
    } catch (e) {
      if (first) setWhy(String((e as Error).message || e))
      return null
    }
  }, [])

  const choose = useCallback(
    (name: string, list?: Surface[]) => {
      setMaking(false)
      if (name === sel) return
      if (sel) {
        if (dirty) draft.current.set(sel, slots)
        else draft.current.delete(sel)
      }
      const held = draft.current.get(name)
      const a = (list || assets || []).find((x) => x.name === name)
      setSel(name)
      setSlots(held ? held : a ? a.slots.map(asSlot) : [])
      setDirty(!!held)
      setStashed([...draft.current.keys()])
      setPick(-1)
      setProblems([])
      setWarnings([])
      setSure(false)
    },
    [assets, dirty, slots, sel],
  )

  useEffect(() => {
    void load(true).then((list) => {
      if (!list) return
      if (list.length) choose(list[0].name, list)
      else setMaking(true)
    })
    // one first read. Nothing choose closes over exists yet on mount, so it is
    // safe to leave out of the list and wrong to put in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* THE ROW EXISTS BEFORE THE PICTURE DOES, so a surface can sit at pending
   * with nothing drawn on it, and a tab closed halfway through a minute and a
   * half of generation is exactly how. This polls the platform's own list and
   * never the generator, so it costs nothing, and it stops the moment nothing
   * is pending. It replaces the list only: marks being made in the editor are
   * never touched by it. */
  useEffect(() => {
    if (!assets?.some((a) => a.status === 'pending' || a.status === 'drawing')) return
    const t = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(t)
  }, [assets, load])

  // the style reference, which is any map this account has painted. A surface
  // that matches the island it sits over is the whole reason the field is here.
  useEffect(() => {
    fetch('/api/my-maps')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { maps?: Array<{ slug: string; title: string }> }) =>
        setMaps((j.maps || []).map((m) => ({ slug: m.slug, title: m.title || m.slug }))),
      )
      .catch(() => setMaps([]))
  }, [])

  /* the zoom fits the surface into the stage once, when the surface changes,
   * and is a whole number because a panel drawn at 2.4x is a picture of pixel
   * art rather than pixel art. Deliberately not refitted on resize: a zoom set
   * by hand has to survive the window moving. */
  useEffect(() => {
    const el = stage.current
    if (!el || !cur) return
    const fit = Math.floor(Math.min((el.clientWidth - 48) / cur.w, (el.clientHeight - 48) / cur.h))
    setZ(clamp(Number.isFinite(fit) ? fit : 1, 1, 6))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel])

  /* THE PICTURE IS ASKED FOR EVERY TIME THE STATUS MOVES, and it is allowed to
   * be missing. A surface that has never been generated has no png at all, and
   * that is not an error state: it is a size with no paint in it yet, which the
   * canvas draws as an empty frame.
   *
   * The redraw count is in the url because the read route serves this image
   * with a year of immutable caching on purpose, for a class of chromebooks
   * that should fetch the chrome once between them. Drawing the same name
   * again would otherwise leave the author looking at the old panel with the
   * new panel's slots on it. */
  useEffect(() => {
    setImg(null)
    if (!cur) return
    let dead = false
    const el = new Image()
    el.onload = () => !dead && setImg(el)
    el.onerror = () => !dead && setImg(null)
    const at = cur.src || `/api/v1/ui/${encodeURIComponent(cur.name)}/image`
    el.src = `${at}?v=${encodeURIComponent(cur.status)}&r=${redraw}`
    return () => {
      dead = true
    }
  }, [cur?.name, cur?.status, cur?.src, redraw])

  useEffect(() => {
    const el = cv.current
    if (!el || !cur) return
    // an integer device ratio, because a half pixel of scaling puts the art off
    // the grid and every hard edge in the panel goes soft
    const dpr = Math.max(1, Math.round(Math.min(2, window.devicePixelRatio || 1)))
    el.width = cur.w * z * dpr
    el.height = cur.h * z * dpr
    const c = el.getContext('2d')
    if (!c) return
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    paint(c, cur, z, img, slots, pick, hover, band)
  }, [cur, z, img, slots, pick, hover, band])

  const edit = (i: number, patch: Partial<Slot>) => {
    setSlots((all) => all.map((s, k) => (k === i ? { ...s, ...patch } : s)))
    setDirty(true)
  }

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { mx: e.clientX - r.left, my: e.clientY - r.top }
  }

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!cur) return
    const { mx, my } = at(e)
    e.currentTarget.setPointerCapture(e.pointerId)
    const hit = under(slots, z, pick, mx, my)
    const x = mx / z
    const y = my / z
    if (!hit) {
      // a drag on the painting itself is a new slot. There is no draw tool to
      // arm first, because marking one is the only thing you came here to do.
      from.current = { x: clamp(Math.round(x), 0, cur.w), y: clamp(Math.round(y), 0, cur.h) }
      setBand({ x0: from.current.x, y0: from.current.y, x1: from.current.x, y1: from.current.y })
      setPick(-1)
      return
    }
    setPick(hit.i)
    const s = slots[hit.i]
    drag.current = { kind: hit.kind, i: hit.i, dx: x - s.x, dy: y - s.y }
  }

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!cur) return
    const { mx, my } = at(e)
    const x = mx / z
    const y = my / z
    if (from.current) {
      setBand({ x0: from.current.x, y0: from.current.y, x1: clamp(x, 0, cur.w), y1: clamp(y, 0, cur.h) })
      return
    }
    const d = drag.current
    if (!d) {
      // the same hit held rather than replaced, or every pixel of pointer
      // movement repaints the whole panel
      const h = under(slots, z, pick, mx, my)
      setHover((v) => (v?.kind === h?.kind && v?.i === h?.i ? v : h))
      return
    }
    const s = slots[d.i]
    if (d.kind === 'slot') {
      // held inside the surface, because a slot hanging off the edge is a piece
      // of layout the game would draw where there is no panel
      edit(d.i, {
        x: clamp(Math.round(x - d.dx), 0, cur.w - s.w),
        y: clamp(Math.round(y - d.dy), 0, cur.h - s.h),
      })
    } else {
      edit(d.i, {
        w: clamp(Math.round(x) - s.x, 1, cur.w - s.x),
        h: clamp(Math.round(y) - s.y, 1, cur.h - s.y),
      })
    }
  }

  const up = () => {
    if (from.current && band) {
      const x0 = Math.round(Math.min(band.x0, band.x1))
      const y0 = Math.round(Math.min(band.y0, band.y1))
      const w = Math.round(Math.abs(band.x1 - band.x0))
      const h = Math.round(Math.abs(band.y1 - band.y0))
      // a two pixel rectangle is a click that moved, not a slot, and it would
      // sit on the panel as an invisible thing to hit
      if (w >= 3 && h >= 3) {
        const made: Slot = { name: freeName('slot', slots.map((s) => s.name)), kind: 'text', x: x0, y: y0, w, h }
        setSlots([...slots, made])
        setPick(slots.length)
        setDirty(true)
      }
    }
    from.current = null
    setBand(null)
    drag.current = null
  }

  const drop = (i: number) => {
    setSlots((all) => all.filter((_, k) => k !== i))
    setPick(-1)
    setDirty(true)
  }

  /* EVERY SLOT GOES, AND WHAT COMES BACK REPLACES WHAT WAS ON SCREEN, so the
   * layout afterwards is the row and not a hopeful copy of it.
   *
   * Two things are checked here rather than there. A name that is not an
   * identifier is a name no grape can ask for, and two slots with the same name
   * are one address for two rectangles: the server cleans both cases, and a
   * save that quietly loses a mark is worse than a save that refuses. */
  const save = async () => {
    if (!cur || busy) return
    const bad = slots.filter((s) => !isAnchorName(s.name)).map((s) => s.name || '(no name)')
    const seen = new Set<string>()
    const twice = new Set<string>()
    for (const s of slots) {
      if (seen.has(s.name)) twice.add(s.name)
      seen.add(s.name)
    }
    const stop: string[] = []
    if (bad.length) stop.push(`${bad.join(', ')} cannot be a name · lower case letters, digits and underscores, starting with a letter`)
    if (twice.size) stop.push(`${[...twice].join(', ')} is used twice · a name is the only address a grape has`)
    if (stop.length) {
      setProblems(stop)
      return
    }
    setBusy(true)
    setProblems([])
    setWarnings([])
    try {
      const r = await fetch('/api/ui/slots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: cur.name, slots }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setProblems(j.problems?.length ? j.problems : [j.error || `the server refused it (${r.status})`])
        return
      }
      const kept = asSurface(j.ui || j.asset || j)
      setAssets((all) => (all || []).map((a) => (a.name === cur.name ? { ...kept, name: a.name } : a)))
      setSlots(kept.slots)
      // overlapping rectangles are legal and usually a mis-drag, so they come
      // back on a save that worked rather than stopping one
      setWarnings(Array.isArray(j.warnings) ? j.warnings : [])
      draft.current.delete(cur.name)
      setStashed([...draft.current.keys()])
      setDirty(false)
    } catch (e) {
      setProblems([String((e as Error).message || e)])
    } finally {
      setBusy(false)
    }
  }

  /* THE PRESS THAT COSTS MONEY. Nothing else in this file posts here, no effect
   * reaches it, and it is only ever reachable from the button under a filled-in
   * form. One surface is twenty to forty PixelLab generations. */
  const generate = async () => {
    if (busy) return
    const name = form.name.trim()
    const stop: string[] = []
    if (!isAnchorName(name)) stop.push('a name is the address the game asks by · lower case letters, digits and underscores, starting with a letter')
    if ((assets || []).some((a) => a.name === name)) stop.push(`${name} is already a surface on this account`)
    if (!form.description.trim()) stop.push('the description is what actually gets drawn, so it cannot be empty')
    const gate = sizeSay(form.width, form.height)
    if (gate) stop.push(gate)
    if (stop.length) {
      setProblems(stop)
      return
    }
    setBusy(true)
    setProblems([])
    try {
      const r = await fetch('/api/ui/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          title: form.title.trim(),
          description: form.description.trim(),
          width: form.width,
          height: form.height,
          palette: form.palette.trim(),
          elements: form.elements,
          // a map slug. The server owns turning that into the style reference
          // the generator takes, because it already has the painting on disk
          // and this page would otherwise be posting a megabyte of base64.
          style: form.style,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setProblems(j.problems?.length ? j.problems : [j.error || `the generator refused it (${r.status})`])
        return
      }
      // whatever shape the reply takes, the list is the truth, so read it again
      const list = await load()
      if (!list) {
        setProblems([`${name} was asked for, and the list would not reload · it is drawing, so open this page again in a minute`])
        return
      }
      setForm(BLANK)
      setRedraw((v) => v + 1)
      choose(name, list)
    } catch (e) {
      setProblems([String((e as Error).message || e)])
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!cur || busy) return
    setBusy(true)
    setProblems([])
    try {
      const r = await fetch('/api/ui/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: cur.name }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setProblems(j.problems?.length ? j.problems : [j.error || `it would not delete (${r.status})`])
        return
      }
      draft.current.delete(cur.name)
      const list = await load()
      if (!list) return
      if (list.length) choose(list[0].name, list)
      else {
        setSel('')
        setSlots([])
        setMaking(true)
      }
    } catch (e) {
      setProblems([String((e as Error).message || e)])
    } finally {
      setBusy(false)
      setSure(false)
    }
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
        return
      }
      if (e.key === 'Escape') {
        from.current = null
        setBand(null)
        setPick(-1)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
    // no dependency list, because save() closes over the marks and a list that
    // misses one field is a ctrl+s that posts what the page held a minute ago
  })

  // there is no autosave here on purpose, so this is the only thing standing
  // between an afternoon of marking and a closed tab
  useEffect(() => {
    if (!dirty) return
    const ask = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [dirty])

  if (why)
    return (
      <div className="surf">
        <div className="surf-gone">
          <h1>The surfaces will not open.</h1>
          <p>{why}</p>
          <Link to="/" className="surf-btn">
            back to your maps
          </Link>
        </div>
      </div>
    )
  if (!assets) return <div className="surf" />

  const slot = pick >= 0 ? slots[pick] : null

  return (
    <div className="surf">
      <header className="surf-bar">
        <button className="surf-back" onClick={() => go('/')}>
          ← maps
        </button>
        <span className="surf-mark">surfaces</span>
        {cur && (
          <span className="surf-meta">
            <span className="surf-size">
              {cur.w}×{cur.h}
            </span>
            <span className="surf-count">{slots.length === 1 ? '1 slot' : `${slots.length} slots`}</span>
          </span>
        )}
        <div className="surf-zoom">
          <button className="surf-tool" onClick={() => setZ((v) => clamp(v - 1, 1, 6))} disabled={!cur || z <= 1} aria-label="zoom out">
            −
          </button>
          <span className="surf-zn">×{z}</span>
          <button className="surf-tool" onClick={() => setZ((v) => clamp(v + 1, 1, 6))} disabled={!cur || z >= 6} aria-label="zoom in">
            +
          </button>
        </div>
        <button className="surf-save" onClick={() => void save()} disabled={busy || !dirty || !cur}>
          {busy ? 'saving' : dirty ? 'save the slots' : 'saved'}
        </button>
      </header>

      <div className="surf-body">
        <aside className="surf-rail sparse">
          <button className={'surf-new' + (making ? ' on' : '')} onClick={() => setMaking(true)}>
            + new surface
          </button>
          {assets.map((a) => (
            <button
              key={a.name}
              className={'surf-row' + (a.name === sel && !making ? ' on' : '')}
              onClick={() => choose(a.name)}
            >
              <i style={{ background: inkFor(STATUS_INK, a.status) }} />
              {/* `a.title || a.name` printed `dialogue_box` on the shelf for
                  every surface nobody had titled. displayName reads the title
                  when there is one and unpacks the identifier when there is
                  not, and the underline says which of the two happened. */}
              <span className={'surf-row-n' + (displayName(a).derived ? ' guessed' : '')}>
                {displayName(a).text}
                {stashed.includes(a.name) ? ' ·' : ''}
              </span>
              <span className="surf-row-m">{a.status || 'no picture'}</span>
            </button>
          ))}
          {/* the shared empty state, so a rail with nothing in it reads the
              same here as it does in the editor and out on the ocean */}
          {!assets.length && (
            <div className="nothing">
              <p className="nothing-say">no surfaces yet</p>
              <p className="nothing-do">a panel is one press, and it costs</p>
            </div>
          )}
        </aside>

        <div className="surf-stage" ref={stage}>
          {making ? (
            <NewSurface
              form={form}
              maps={maps}
              busy={busy}
              taken={assets.map((a) => a.name)}
              onSet={(patch) => setForm((f) => ({ ...f, ...patch }))}
              onGenerate={() => void generate()}
              onCancel={assets.length ? () => choose(sel || assets[0].name) : undefined}
            />
          ) : cur ? (
            <>
              <div className="surf-hold">
                <canvas
                  ref={cv}
                  className="surf-cv"
                  style={{ width: cur.w * z, height: cur.h * z }}
                  onPointerDown={down}
                  onPointerMove={move}
                  onPointerUp={up}
                  onPointerCancel={up}
                />
              </div>
              <p className="surf-hint">
                drag on the panel to mark a slot · drag a slot to move it, its corner to resize · esc lets go
              </p>
            </>
          ) : (
            // the surface that was selected is not in the listing any more,
            // which is what a refetch looks like after it was deleted in
            // another tab. A blank middle with no sentence in it reads as a
            // broken page rather than as nothing being chosen.
            <p className="surf-note surf-empty">Pick a surface on the left, or make a new one.</p>
          )}
        </div>

        <aside className="surf-side">
          {problems.length > 0 && (
            <div className="surf-refused">
              <span className="surf-lab">not saved</span>
              {problems.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <div className="surf-warns">
              <span className="surf-lab">saved, and worth reading</span>
              {warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}
          {!loading && !user && <p className="surf-note">Marking is yours until you press save; the save itself needs an account.</p>}

          {slot && pick >= 0 ? (
            <SlotPanel
              s={slot}
              kinds={kinds}
              aligns={aligns}
              max={cur ? { w: cur.w, h: cur.h } : { w: 9999, h: 9999 }}
              onEdit={(patch) => edit(pick, patch)}
              onDrop={() => drop(pick)}
            />
          ) : cur ? (
            <div className="surf-insp">
              <span className="surf-lab">the surface</span>
              {/* the words, then the address under them, which is the same
                   two-line shape every list in the editor uses for a thing that
                   has both. It printed `dialogue_box` as the heading. */}
              <p className="surf-say">
                <b className={displayName(cur).derived ? 'guessed' : undefined}>{displayName(cur).text}</b> ·{' '}
                {cur.status || 'never generated'}
              </p>
              {/* captioned, because a bare `dialogue_box` under a heading
                  reads as a second, uglier name for the panel rather than as
                  the string a grape passes. The editor's rows and /world's
                  roster both put the same word over the same kind of string. */}
              <p className="surf-addr">
                <em>code</em> {cur.name}
              </p>
              {cur.description && <p className="surf-say">{cur.description}</p>}
              <p className="surf-say">
                Drag a rectangle on the panel to mark where the game puts a piece of text, a number, a bar, a button, an
                icon or an image. The name is what a grape asks for.
              </p>
              {sure ? (
                <div className="surf-sure">
                  <button className="surf-btn danger" onClick={() => void remove()} disabled={busy}>
                    delete it
                  </button>
                  <button className="surf-btn" onClick={() => setSure(false)}>
                    keep it
                  </button>
                </div>
              ) : (
                <button className="surf-btn danger" onClick={() => setSure(true)}>
                  delete {readable(cur)}
                </button>
              )}
            </div>
          ) : null}

          {!making && slots.length > 0 && (
            <div className="surf-roster">
              <span className="surf-lab">what is marked</span>
              {slots.map((s, i) => (
                <button key={i} className={'surf-row' + (pick === i ? ' on' : '')} onClick={() => setPick(i)}>
                  <i style={{ background: inkFor(KIND_INK, s.kind) }} />
                  <span className="surf-row-t">
                    <b className={displayName(s).derived ? 'guessed' : undefined}>{displayName(s).text}</b>
                    <i>
                      <em>code</em> {s.name} · {s.kind}
                    </i>
                  </span>
                  <span className="surf-row-m">
                    {s.w}×{s.h}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

/* ASKING FOR A PANEL. Every field the generator takes has a control, because a
 * field with no way to enter a value is the half-plumbed sweep this project
 * keeps rediscovering, and the two that decide what comes back are the
 * description and the elements. */
function NewSurface({
  form,
  maps,
  busy,
  taken,
  onSet,
  onGenerate,
  onCancel,
}: {
  form: Form
  maps: Array<{ slug: string; title: string }>
  busy: boolean
  taken: string[]
  onSet: (patch: Partial<Form>) => void
  onGenerate: () => void
  onCancel?: () => void
}) {
  const legal = isAnchorName(form.name)
  const clash = taken.includes(form.name)
  const gate = sizeSay(form.width, form.height)
  const ready = legal && !clash && !gate && !!form.description.trim()

  return (
    <div className="surf-make">
      <span className="surf-lab">a new surface</span>
      {/* THE SAME TWO CAPTIONS THE EDITOR'S ANCHOR FORM WEARS, because these
          are the same two fields. `dialogue_box` sat in the box with the word
          "name" over it and nothing saying the underscored string is what code
          addresses rather than a second name for the panel, while the editor
          two clicks away says "name · what code calls it" and /world's
          inspector heads the pair "what code addresses". Three surfaces, one
          habit. */}
      <label className="surf-f">
        <span>name · what code calls it</span>
        <input
          /* an empty box is not a wrong answer, it is a box nobody has typed
             in yet, and marking it in sealing wax before the first keystroke
             is the form shouting at somebody who has done nothing */
          className={'surf-in' + (!form.name || (legal && !clash) ? '' : ' bad')}
          value={form.name}
          spellCheck={false}
          maxLength={48}
          placeholder="dialogue_box"
          onChange={(e) => onSet({ name: e.target.value })}
          onBlur={() => !legal && onSet({ name: anchorName(form.name) })}
        />
      </label>
      {!legal && form.name !== '' && <p className="surf-bad">lower case letters, digits and underscores, starting with a letter</p>}
      {clash && <p className="surf-bad">there is already a surface called {form.name}</p>}
      <label className="surf-f">
        <span>title · what a person reads</span>
        <input className="surf-in" value={form.title} maxLength={120} placeholder="the dialogue box" onChange={(e) => onSet({ title: e.target.value })} />
      </label>
      <label className="surf-f">
        <span>description</span>
        <textarea
          className="surf-in surf-area"
          value={form.description}
          maxLength={400}
          rows={3}
          placeholder="wooden RPG panel with gold trim"
          onChange={(e) => onSet({ description: e.target.value })}
        />
      </label>
      <p className="surf-say">This is the whole of what gets drawn. Say the material and the trim, not the layout.</p>

      <div className="surf-pair">
        <Num label="width" v={form.width} min={192} max={688} on={(n) => onSet({ width: n })} />
        <Num label="height" v={form.height} min={192} max={688} on={(n) => onSet({ height: n })} />
      </div>
      {/* the gate, spelled out rather than discovered by being refused */}
      <p className={gate ? 'surf-bad' : 'surf-say'}>
        {gate || 'square up to 512×512, 16:9 up to 688×384, 9:16 up to 384×688, 4:3 up to 600×448, 3:4 up to 448×600. Other combinations are refused by the generator.'}
      </p>

      <label className="surf-f">
        <span>palette</span>
        <input className="surf-in" value={form.palette} maxLength={80} placeholder="brown and gold" onChange={(e) => onSet({ palette: e.target.value })} />
      </label>
      <label className="surf-f">
        <span>match the look of</span>
        <select className="surf-in" value={form.style} onChange={(e) => onSet({ style: e.target.value })}>
          <option value="">nothing · let it decide</option>
          {/* the roster hands back `title || slug`, and every map whose title
              is machine-filled with its own slug therefore listed as
              `panther-maw` in this menu. displayName unpacks that back into
              words, which is the same call the dashboard and the ocean make,
              so a map is called one thing everywhere. */}
          {maps.map((m) => (
            <option key={m.slug} value={m.slug}>
              {readable({ name: m.slug, title: m.title })}
            </option>
          ))}
        </select>
      </label>
      <p className="surf-say">A painting to copy the palette, the pixel scale and the outlines from. None of its content comes across.</p>

      <span className="surf-lab">elements</span>
      <div className="surf-chips">
        {ELEMENTS.map((el) => (
          <button
            key={el}
            className={'surf-chip' + (form.elements.includes(el) ? ' on' : '')}
            onClick={() => onSet({ elements: form.elements.includes(el) ? form.elements.filter((x) => x !== el) : [...form.elements, el] })}
          >
            {el.replace('_', ' ')}
          </button>
        ))}
      </div>
      <p className="surf-say">Named parts get scaffolded into the panel and positioned for you. Pick none for a plain panel.</p>

      <div className="surf-fire">
        <button className="surf-go" onClick={onGenerate} disabled={busy || !ready}>
          {busy ? 'drawing · about a minute and a half' : 'generate this surface'}
        </button>
        {onCancel && (
          <button className="surf-btn" onClick={onCancel}>
            cancel
          </button>
        )}
      </div>
      <p className="surf-cost">One surface is 20 to 40 PixelLab generations. Nothing is spent until this is pressed.</p>
    </div>
  )
}

/* One slot, every field of it. x, y, w and h are in the surface's own pixels,
 * which is the same number the game reads, so what is typed here and what is
 * dragged on the canvas are the same act. */
function SlotPanel({
  s,
  kinds,
  aligns,
  max,
  onEdit,
  onDrop,
}: {
  s: Slot
  kinds: string[]
  aligns: string[]
  max: { w: number; h: number }
  onEdit: (patch: Partial<Slot>) => void
  onDrop: () => void
}) {
  const legal = isAnchorName(s.name)
  // a kind the listing does not carry is still shown, the same way the ocean
  // keeps a map slug it does not recognise: blanking it would rewrite somebody
  // else's slot behind their back
  const kindList = kinds.includes(s.kind) ? kinds : [s.kind, ...kinds]
  return (
    <div className="surf-insp">
      <span className="surf-lab">the slot</span>
      <label className="surf-f">
        <span>name</span>
        <input
          className={'surf-in' + (legal ? '' : ' bad')}
          value={s.name}
          spellCheck={false}
          maxLength={48}
          onChange={(e) => onEdit({ name: e.target.value })}
          onBlur={() => !legal && onEdit({ name: anchorName(s.name) })}
        />
      </label>
      {!legal && <p className="surf-bad">a name is the only address there is · lower case, digits, underscores</p>}
      <label className="surf-f">
        <span>kind</span>
        <select className="surf-in" value={s.kind} onChange={(e) => onEdit({ kind: e.target.value })}>
          {kindList.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      {/* only offered when the listing said there was such a thing, because a
          control over a vocabulary this page invented is a value the server
          drops on the floor. Empty means the reader's own default for the kind,
          which is why it is not a fourth word in the list. */}
      {aligns.length > 0 && (
        <label className="surf-f">
          <span>align</span>
          <select className="surf-in" value={s.align || ''} onChange={(e) => onEdit({ align: e.target.value || undefined })}>
            <option value="">whatever the kind does</option>
            {aligns.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="surf-pair">
        <Num label="x" v={s.x} min={0} max={max.w} on={(n) => onEdit({ x: n })} />
        <Num label="y" v={s.y} min={0} max={max.h} on={(n) => onEdit({ y: n })} />
      </div>
      <div className="surf-pair">
        <Num label="width" v={s.w} min={1} max={max.w} on={(n) => onEdit({ w: n })} />
        <Num label="height" v={s.h} min={1} max={max.h} on={(n) => onEdit({ h: n })} />
      </div>
      <button className="surf-btn danger" onClick={onDrop}>
        take {s.name} off the panel
      </button>
    </div>
  )
}

function Num({ label, v, min, max, on }: { label: string; v: number; min?: number; max?: number; on: (n: number) => void }) {
  return (
    <label className="surf-f">
      <span>{label}</span>
      <input
        className="surf-in"
        type="number"
        value={v}
        onChange={(e) => {
          const n = Number(e.target.value)
          on(clamp(Number.isFinite(n) ? Math.round(n) : 0, min ?? -1e9, max ?? 1e9))
        }}
      />
    </label>
  )
}
