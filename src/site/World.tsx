/* THE OCEAN, WHICH IS THE ONE SURFACE THAT HAD NO AUTHOR.
 *
 * Everything MAPVIS can mark is at an x,y inside one painting's pixel raster.
 * A document cannot exist without a painting, anchor creation refuses a click
 * outside the canvas, and growing the canvas to buy room for a mooring changes
 * w/h, which the game fits its camera from, so it zooms the island out. The
 * water between the islands was therefore the one place nothing could be
 * placed, and every fact about it lived as a constant in the game repo.
 *
 * This is that surface. It is not a map and it has no painting: a coordinate
 * space with maps placed on it, drawn as a chart of an ocean rather than as a
 * form with numbers in it, because where an island sits relative to every other
 * island is a thing you judge by looking.
 *
 * NO AUTOSAVE, unlike a map document. There is one world row shared by every
 * map on the platform, so a half-finished drag is not something to write into
 * the thing a whole class sails. Saving is a press, and what comes back is what
 * the server kept, warnings and all.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, go } from './router'
import { useSession } from './session'
import { anchorName, isAnchorName } from '../core/mask'
import './world.css'

type Pt = { x: number; y: number; facing?: string }

/* The shape the server keeps, field for field. cleanPlace is the authority and
 * this mirrors it rather than adding to it: a field invented here would be
 * dropped on the way in and would read as a control that does nothing. */
type Place = {
  name: string
  map: string
  title: string
  x: number
  y: number
  w: number
  h: number
  state: string
  release: number
  berth?: Pt
  approach?: Pt
  meta?: Record<string, unknown>
}
type Region = { name: string; kind: string; rect: [number, number, number, number]; label?: string }
type Doc = { w: number; h: number; places: Place[]; regions: Region[] }

type Sel = { kind: 'place' | 'region'; i: number } | null
type Hit = { kind: 'place' | 'berth' | 'approach' | 'size' | 'region'; i: number } | null
type Band = { x0: number; y0: number; x1: number; y1: number } | null
type Tool = 'move' | 'place' | 'sea'
type Pick = '' | 'berth' | 'approach'
type Fit = { s: number; ox: number; oy: number }

/* ONE INK PER STATE, and the ramp is the journey: unknown is cold and grey,
 * the one you are in is gold, the one that is over goes back down to a dull
 * bronze. The names come from the server, not from here, so a state added there
 * still draws with the fallback rather than disappearing. */
const STATE_INK: Record<string, string> = {
  rumoured: '#5b6470',
  misty: '#6f8296',
  discovered: '#8fa6bb',
  available: '#4f9b84',
  active: '#d4a53c',
  completed: '#8a6a1f',
  in_season: '#b04a2f',
}
const SEA_INK: Record<string, string> = {
  sailable: '#1d2c3c',
  shallow: '#2b5a55',
  forbidden: '#4a1f16',
  mist: '#3b4654',
  ambience: '#3a3252',
}
const inkFor = (m: Record<string, string>, k: string) => m[k] || '#5b6470'

const LABEL = '500 11px "Archivo Narrow", sans-serif'
const MONO = '400 9px "Martian Mono", monospace'
const PAD = 36

/* how far apart the graticule sits, aimed at roughly eight divisions across.
 * Powers of two, because every other number in this project is one and a chart
 * ruled at 437 reads as a rounding error. */
const grat = (w: number) => {
  let s = 256
  while (w / s > 12) s *= 2
  while (w / s < 4 && s > 16) s /= 2
  return s
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const freeName = (stem: string, taken: string[]) => {
  let n = 1
  while (taken.includes(`${stem}_${n}`)) n++
  return `${stem}_${n}`
}

const FACE_GRID = [
  ['north-west', 'north', 'north-east'],
  ['west', '', 'east'],
  ['south-west', 'south', 'south-east'],
]
const FACE_ARROW = '↖↑↗←·→↙↓↘'

/* ---- the chart ----------------------------------------------------------- */

function paint(c: CanvasRenderingContext2D, size: { w: number; h: number }, doc: Doc, fit: Fit, sel: Sel, hover: Hit, band: Band) {
  const X = (x: number) => fit.ox + x * fit.s
  const Y = (y: number) => fit.oy + y * fit.s

  c.fillStyle = '#070b11'
  c.fillRect(0, 0, size.w, size.h)
  c.fillStyle = '#0b111a'
  c.fillRect(X(0), Y(0), doc.w * fit.s, doc.h * fit.s)

  // the graticule, which is the whole reason this reads as a chart and not as
  // a dark box with rectangles on it
  const step = grat(doc.w)
  c.strokeStyle = 'rgba(212,165,60,0.075)'
  c.lineWidth = 1
  c.beginPath()
  for (let x = step; x < doc.w; x += step) {
    c.moveTo(Math.round(X(x)) + 0.5, Y(0))
    c.lineTo(Math.round(X(x)) + 0.5, Y(doc.h))
  }
  for (let y = step; y < doc.h; y += step) {
    c.moveTo(X(0), Math.round(Y(y)) + 0.5)
    c.lineTo(X(doc.w), Math.round(Y(y)) + 0.5)
  }
  c.stroke()

  // sea regions sit under everything, because they are what the water IS and
  // an island is a thing on top of it
  for (const r of doc.regions) {
    const [x0, y0, x1, y1] = r.rect
    const rx = X(Math.min(x0, x1))
    const ry = Y(Math.min(y0, y1))
    const rw = Math.abs(x1 - x0) * fit.s
    const rh = Math.abs(y1 - y0) * fit.s
    const tint = inkFor(SEA_INK, r.kind)
    c.fillStyle = tint
    c.globalAlpha = 0.42
    c.fillRect(rx, ry, rw, rh)
    c.globalAlpha = 1
    c.setLineDash([5, 4])
    c.strokeStyle = tint
    c.strokeRect(rx + 0.5, ry + 0.5, rw, rh)
    c.setLineDash([])
    c.font = MONO
    c.fillStyle = 'rgba(216,227,238,0.5)'
    c.fillText(`${r.name} · ${r.kind}`, rx + 6, ry + 13)
  }

  for (let i = 0; i < doc.places.length; i++) {
    const p = doc.places[i]
    const on = sel?.kind === 'place' && sel.i === i
    const lit = on || (hover?.i === i && hover.kind !== 'region')
    const tint = inkFor(STATE_INK, p.state)
    const px = X(p.x)
    const py = Y(p.y)

    /* THE RING IS DRAWN FROM x,y AND NOT FROM THE MIDDLE OF THE RECTANGLE.
     * checkWorld measures the berth distance with hypot(berth - x,y), so a ring
     * drawn around the centre would be a picture of a rule nobody enforces and
     * an author would trust it and get a warning anyway. The cross under it
     * says where the number is measured from. */
    c.beginPath()
    c.arc(px, py, p.release * fit.s, 0, Math.PI * 2)
    c.strokeStyle = tint
    c.globalAlpha = lit ? 0.5 : 0.22
    c.setLineDash([3, 5])
    c.stroke()
    c.setLineDash([])
    c.globalAlpha = 1

    // a berth and an approach are separate marks tied back to the island they
    // belong to, so a chart full of them still says which is whose
    for (const m of [p.approach, p.berth]) {
      if (!m) continue
      c.beginPath()
      c.moveTo(px, py)
      c.lineTo(X(m.x), Y(m.y))
      c.strokeStyle = tint
      c.globalAlpha = 0.35
      c.stroke()
      c.globalAlpha = 1
    }
    if (p.approach) {
      c.beginPath()
      c.arc(X(p.approach.x), Y(p.approach.y), 4.5, 0, Math.PI * 2)
      c.strokeStyle = '#8fa6bb'
      c.stroke()
    }
    if (p.berth) {
      const bx = X(p.berth.x)
      const by = Y(p.berth.y)
      c.beginPath()
      c.moveTo(bx, by - 5)
      c.lineTo(bx + 5, by)
      c.lineTo(bx, by + 5)
      c.lineTo(bx - 5, by)
      c.closePath()
      c.fillStyle = '#f0c869'
      c.fill()
      // the heading a hull holds once it is tied up, as a tick off the diamond
      const face = p.berth.facing || ''
      const dx = face.includes('east') ? 1 : face.includes('west') ? -1 : 0
      const dy = face.includes('south') ? 1 : face.includes('north') ? -1 : 0
      if (dx || dy) {
        c.beginPath()
        c.moveTo(bx, by)
        c.lineTo(bx + dx * 13, by + dy * 13)
        c.strokeStyle = '#f0c869'
        c.stroke()
      }
    }

    const rw = Math.max(3, p.w * fit.s)
    const rh = Math.max(3, p.h * fit.s)
    c.fillStyle = tint
    c.globalAlpha = lit ? 0.3 : 0.18
    c.fillRect(px, py, rw, rh)
    c.globalAlpha = 1
    // an empty slot is drawn as a dashed outline, because it is a position the
    // chart is holding open and not a coast anybody has painted
    c.setLineDash(p.map ? [] : [4, 3])
    c.strokeStyle = on ? '#f0c869' : tint
    c.lineWidth = on ? 2 : 1
    c.strokeRect(px + 0.5, py + 0.5, rw, rh)
    c.lineWidth = 1
    c.setLineDash([])

    c.strokeStyle = tint
    c.beginPath()
    c.moveTo(px - 5, py)
    c.lineTo(px + 5, py)
    c.moveTo(px, py - 5)
    c.lineTo(px, py + 5)
    c.stroke()

    // the name goes above the rectangle, or below it when the rectangle is
    // near the top edge and the label would be drawn off the chart
    const say = p.title || p.name
    const above = py - 7 > PAD
    c.font = LABEL
    c.fillStyle = on ? '#f0c869' : '#d8e3ee'
    c.fillText(say, px, above ? py - 7 : py + rh + 14)
    c.font = MONO
    c.fillStyle = '#6f7885'
    c.fillText(p.map || 'no map yet', px, above ? py - 20 : py + rh + 25)

    if (on) {
      c.fillStyle = '#f0c869'
      c.fillRect(px + rw - 4, py + rh - 4, 8, 8)
    }
  }

  if (band) {
    c.setLineDash([4, 3])
    c.strokeStyle = '#4f9b84'
    c.strokeRect(X(Math.min(band.x0, band.x1)), Y(Math.min(band.y0, band.y1)), Math.abs(band.x1 - band.x0) * fit.s, Math.abs(band.y1 - band.y0) * fit.s)
    c.setLineDash([])
  }

  // the edge of the world last, over everything, so an island hanging off it
  // is unmistakable
  c.strokeStyle = 'rgba(212,165,60,0.45)'
  c.strokeRect(X(0) + 0.5, Y(0) + 0.5, doc.w * fit.s, doc.h * fit.s)
  c.font = MONO
  c.fillStyle = '#6f7885'
  c.fillText('0,0', X(0), Y(0) - 6)
  const end = `${doc.w},${doc.h}`
  c.fillText(end, X(doc.w) - c.measureText(end).width, Y(doc.h) + 14)
}

/* What is under the pointer, tested in the order things are drawn on top of
 * each other: the size handle of the selected island, then its marks, then the
 * islands newest first, then the water regions. A region is last because it is
 * the biggest thing on the chart and would otherwise swallow every click. */
function under(doc: Doc, fit: Fit, sel: Sel, mx: number, my: number): Hit {
  const X = (x: number) => fit.ox + x * fit.s
  const Y = (y: number) => fit.oy + y * fit.s
  const near = (x: number, y: number, r: number) => Math.hypot(mx - X(x), my - Y(y)) <= r

  if (sel?.kind === 'place') {
    const p = doc.places[sel.i]
    if (p && Math.abs(mx - (X(p.x) + p.w * fit.s)) <= 6 && Math.abs(my - (Y(p.y) + p.h * fit.s)) <= 6) return { kind: 'size', i: sel.i }
  }
  for (let i = doc.places.length - 1; i >= 0; i--) {
    const p = doc.places[i]
    if (p.berth && near(p.berth.x, p.berth.y, 8)) return { kind: 'berth', i }
    if (p.approach && near(p.approach.x, p.approach.y, 8)) return { kind: 'approach', i }
  }
  for (let i = doc.places.length - 1; i >= 0; i--) {
    const p = doc.places[i]
    if (mx >= X(p.x) - 5 && mx <= X(p.x) + Math.max(10, p.w * fit.s) && my >= Y(p.y) - 5 && my <= Y(p.y) + Math.max(10, p.h * fit.s))
      return { kind: 'place', i }
  }
  for (let i = doc.regions.length - 1; i >= 0; i--) {
    const [x0, y0, x1, y1] = doc.regions[i].rect
    if (mx >= X(Math.min(x0, x1)) && mx <= X(Math.max(x0, x1)) && my >= Y(Math.min(y0, y1)) && my <= Y(Math.max(y0, y1)))
      return { kind: 'region', i }
  }
  return null
}

/* ---- the page ------------------------------------------------------------ */

export default function World() {
  const { user, loading } = useSession()
  const [doc, setDoc] = useState<Doc | null>(null)
  const [states, setStates] = useState<string[]>([])
  const [kinds, setKinds] = useState<string[]>([])
  const [slugs, setSlugs] = useState<string[]>([])
  const [why, setWhy] = useState('')
  const [sel, setSel] = useState<Sel>(null)
  const [tool, setTool] = useState<Tool>('move')
  const [pick, setPick] = useState<Pick>('')
  const [hover, setHover] = useState<Hit>(null)
  const [band, setBand] = useState<Band>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [inked, setInked] = useState(false)

  const box = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ kind: 'place' | 'berth' | 'approach' | 'size'; i: number; dx: number; dy: number } | null>(null)
  const bandFrom = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    fetch('/api/world')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the ocean would not load (${r.status})`))))
      .then((j: Doc & { states?: string[]; seaKinds?: string[] }) => {
        setDoc({ w: j.w, h: j.h, places: j.places || [], regions: j.regions || [] })
        setStates(j.states || [])
        setKinds(j.seaKinds || [])
      })
      .catch((e) => setWhy(String((e as Error).message || e)))
  }, [])

  /* THE DROPDOWN IS FED FROM THE PUBLISHED MAPS SO A TYPO CANNOT NAME AN
   * ISLAND THAT DOES NOT EXIST. Empty stays offered on purpose: cleanPlace
   * takes an empty map, and that is the whole of the empty-slot ask, a position
   * holding no bundle that reads as a rumour. */
  useEffect(() => {
    fetch('/api/v1/maps')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { maps?: Array<{ slug: string }> }) => setSlugs((j.maps || []).map((m) => m.slug)))
      .catch(() => setSlugs([]))
  }, [])

  // the stage is only in the dom once the world has answered, so this has to
  // run again on that transition and not only on mount
  const ready = doc !== null
  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [ready])

  // the label face is a webfont, so the first paint can land before it arrives
  // and every name on the chart is drawn in the fallback until you touch
  // something. One redraw when the fonts settle costs nothing.
  useEffect(() => {
    document.fonts?.ready.then(() => setInked(true)).catch(() => {})
  }, [])

  const fit: Fit = useMemo(() => {
    if (!doc || !size.w || !size.h) return { s: 1, ox: 0, oy: 0 }
    const s = Math.min((size.w - PAD * 2) / doc.w, (size.h - PAD * 2) / doc.h)
    return { s, ox: (size.w - doc.w * s) / 2, oy: (size.h - doc.h * s) / 2 }
  }, [doc, size])

  useEffect(() => {
    const el = cv.current
    if (!el || !doc || !size.w) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    el.width = Math.round(size.w * dpr)
    el.height = Math.round(size.h * dpr)
    const c = el.getContext('2d')
    if (!c) return
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    paint(c, size, doc, fit, sel, hover, band)
  }, [doc, size, fit, sel, hover, band, inked])

  const place = doc && sel?.kind === 'place' ? doc.places[sel.i] : null
  const region = doc && sel?.kind === 'region' ? doc.regions[sel.i] : null

  const edit = useCallback((i: number, patch: Partial<Place>) => {
    setDoc((d) => (d ? { ...d, places: d.places.map((p, k) => (k === i ? { ...p, ...patch } : p)) } : d))
    setDirty(true)
  }, [])

  /* AN ISLAND CARRIES ITS BERTH AND ITS APPROACH WITH IT.
   *
   * The same rule a bound anchor follows: the mark was placed relative to the
   * island, so moving the island and leaving the mooring behind is never what
   * anybody meant. Clamped to the chart as it goes, because checkWorld refuses
   * a save for a place that is off the ocean and a drag should not be able to
   * make a document the server will not take. */
  const shift = useCallback((i: number, x: number, y: number) => {
    setDoc((d) => {
      if (!d) return d
      return {
        ...d,
        places: d.places.map((p, k) => {
          if (k !== i) return p
          const nx = clamp(Math.round(x), 0, d.w)
          const ny = clamp(Math.round(y), 0, d.h)
          const dx = nx - p.x
          const dy = ny - p.y
          return {
            ...p,
            x: nx,
            y: ny,
            ...(p.berth ? { berth: { ...p.berth, x: p.berth.x + dx, y: p.berth.y + dy } } : {}),
            ...(p.approach ? { approach: { ...p.approach, x: p.approach.x + dx, y: p.approach.y + dy } } : {}),
          }
        }),
      }
    })
    setDirty(true)
  }, [])

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { mx: e.clientX - r.left, my: e.clientY - r.top }
  }
  const toWorld = (mx: number, my: number) => ({ x: (mx - fit.ox) / fit.s, y: (my - fit.oy) / fit.s })

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!doc) return
    const { mx, my } = at(e)
    const w = toWorld(mx, my)
    e.currentTarget.setPointerCapture(e.pointerId)

    // setting a mark by clicking the water. It is a mode rather than a drag,
    // because the point being set is usually nowhere near the island and a drag
    // out of the inspector cannot cross the panel edge.
    if (pick && place && sel?.kind === 'place') {
      const spot = { x: clamp(Math.round(w.x), 0, doc.w), y: clamp(Math.round(w.y), 0, doc.h) }
      edit(sel.i, pick === 'berth' ? { berth: { ...spot, ...(place.berth?.facing ? { facing: place.berth.facing } : {}) } } : { approach: spot })
      setPick('')
      return
    }

    if (tool === 'place') {
      const name = freeName('island', doc.places.map((p) => p.name))
      const made: Place = {
        name,
        map: '',
        title: '',
        x: clamp(Math.round(w.x), 0, doc.w),
        y: clamp(Math.round(w.y), 0, doc.h),
        w: 64,
        h: 64,
        // a slot with no map behind it is a rumour and nothing else reads
        // honestly, which is what checkWorld warns about
        state: 'rumoured',
        release: 160,
      }
      setDoc({ ...doc, places: [...doc.places, made] })
      setSel({ kind: 'place', i: doc.places.length })
      setTool('move')
      setDirty(true)
      return
    }

    if (tool === 'sea') {
      bandFrom.current = { x: Math.round(w.x), y: Math.round(w.y) }
      setBand({ x0: w.x, y0: w.y, x1: w.x, y1: w.y })
      return
    }

    const hit = under(doc, fit, sel, mx, my)
    if (!hit) {
      setSel(null)
      return
    }
    if (hit.kind === 'region') {
      setSel({ kind: 'region', i: hit.i })
      return
    }
    setSel({ kind: 'place', i: hit.i })
    const p = doc.places[hit.i]
    const from = hit.kind === 'berth' ? p.berth : hit.kind === 'approach' ? p.approach : { x: p.x, y: p.y }
    drag.current = { kind: hit.kind, i: hit.i, dx: w.x - (from?.x ?? p.x), dy: w.y - (from?.y ?? p.y) }
  }

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!doc) return
    const { mx, my } = at(e)
    const w = toWorld(mx, my)

    if (bandFrom.current) {
      setBand({ x0: bandFrom.current.x, y0: bandFrom.current.y, x1: w.x, y1: w.y })
      return
    }
    const d = drag.current
    if (!d) {
      // the same hit, held rather than replaced, or every pixel of pointer
      // movement is a new object and a full repaint of the chart
      const h = under(doc, fit, sel, mx, my)
      setHover((v) => (v?.kind === h?.kind && v?.i === h?.i ? v : h))
      return
    }
    const x = clamp(Math.round(w.x - d.dx), 0, doc.w)
    const y = clamp(Math.round(w.y - d.dy), 0, doc.h)
    if (d.kind === 'place') shift(d.i, x, y)
    else if (d.kind === 'berth') edit(d.i, { berth: { ...doc.places[d.i].berth, x, y } as Pt })
    else if (d.kind === 'approach') edit(d.i, { approach: { x, y } })
    else edit(d.i, { w: Math.max(1, x - doc.places[d.i].x), h: Math.max(1, y - doc.places[d.i].y) })
  }

  const up = () => {
    if (bandFrom.current && band && doc) {
      // held inside the chart, because a drag that ran off the edge names water
      // that is not on the ocean and nothing would ever sail through it
      const rect: [number, number, number, number] = [
        clamp(Math.round(Math.min(band.x0, band.x1)), 0, doc.w),
        clamp(Math.round(Math.min(band.y0, band.y1)), 0, doc.h),
        clamp(Math.round(Math.max(band.x0, band.x1)), 0, doc.w),
        clamp(Math.round(Math.max(band.y0, band.y1)), 0, doc.h),
      ]
      // a region dragged out by accident, one pixel across, is a click and not
      // a region, and it would sit on the chart as an invisible thing to hit
      if (rect[2] - rect[0] > 8 && rect[3] - rect[1] > 8) {
        const made: Region = { name: freeName('sea', doc.regions.map((r) => r.name)), kind: kinds[0] || 'sailable', rect }
        setDoc({ ...doc, regions: [...doc.regions, made] })
        setSel({ kind: 'region', i: doc.regions.length })
        setDirty(true)
      }
      setTool('move')
    }
    bandFrom.current = null
    setBand(null)
    drag.current = null
  }

  const drop = (i: number) => {
    setDoc((d) => (d ? { ...d, places: d.places.filter((_, k) => k !== i) } : d))
    setSel(null)
    setDirty(true)
  }
  const dropRegion = (i: number) => {
    setDoc((d) => (d ? { ...d, regions: d.regions.filter((_, k) => k !== i) } : d))
    setSel(null)
    setDirty(true)
  }

  /* THE WHOLE DOCUMENT GOES, and what comes back replaces what was on screen,
   * so the chart afterwards is the row and not a hopeful copy of it.
   *
   * The one thing checked here rather than there: cleanPlace and cleanRegion
   * both DROP a row whose name is not a legal identifier, silently, and a save
   * that quietly loses an island is worse than a save that refuses. */
  const save = async () => {
    if (!doc || busy) return
    const illegal = [...doc.places, ...doc.regions].filter((p) => !isAnchorName(p.name)).map((p) => p.name || '(no name)')
    if (illegal.length) {
      setProblems([`${illegal.join(', ')} cannot be a name · lower case letters, digits and underscores, starting with a letter`])
      return
    }
    setBusy(true)
    setProblems([])
    setWarnings([])
    try {
      const r = await fetch('/api/world', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ w: doc.w, h: doc.h, places: doc.places, regions: doc.regions }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setProblems(j.problems?.length ? j.problems : [j.error || `the server refused it (${r.status})`])
        return
      }
      setDoc({ w: j.w, h: j.h, places: j.places || [], regions: j.regions || [] })
      setWarnings(j.warnings || [])
      setDirty(false)
    } catch (e) {
      setProblems([String((e as Error).message || e)])
    } finally {
      setBusy(false)
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
        setPick('')
        setTool('move')
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
    // no dependency list, because save() closes over the document and a list
    // that misses one field is a ctrl+s that posts what the page held a minute
    // ago. Rebinding one listener per render costs nothing here.
  })

  // there is no autosave here on purpose, so the only thing standing between a
  // half hour of placing and a closed tab is this
  useEffect(() => {
    if (!dirty) return
    const ask = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [dirty])

  if (why)
    return (
      <div className="world">
        <div className="world-gone">
          <h1>The ocean will not open.</h1>
          <p>{why}</p>
          <Link to="/" className="world-btn">
            back to your maps
          </Link>
        </div>
      </div>
    )
  if (!doc) return <div className="world" />

  return (
    <div className="world">
      <header className="world-bar">
        <button className="world-back" onClick={() => go('/')}>
          ← maps
        </button>
        <span className="world-name">the ocean</span>
        <span className="world-meta">
          <input
            className="world-num"
            type="number"
            value={doc.w}
            aria-label="ocean width"
            onChange={(e) => {
              setDoc({ ...doc, w: Math.max(1, Math.round(Number(e.target.value) || 0)) })
              setDirty(true)
            }}
          />
          <span>×</span>
          <input
            className="world-num"
            type="number"
            value={doc.h}
            aria-label="ocean height"
            onChange={(e) => {
              setDoc({ ...doc, h: Math.max(1, Math.round(Number(e.target.value) || 0)) })
              setDirty(true)
            }}
          />
          <span className="world-count">
            {doc.places.length} placed · {doc.regions.length} sea
          </span>
        </span>
        <div className="world-tools">
          <button className={'world-tool' + (tool === 'move' ? ' on' : '')} onClick={() => setTool('move')}>
            move
          </button>
          <button className={'world-tool' + (tool === 'place' ? ' on' : '')} onClick={() => setTool('place')}>
            add a place
          </button>
          <button className={'world-tool' + (tool === 'sea' ? ' on' : '')} onClick={() => setTool('sea')}>
            draw water
          </button>
        </div>
        <button className="world-save" onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? 'saving' : dirty ? 'save the ocean' : 'saved'}
        </button>
      </header>

      <div className="world-body">
        <div className="world-stage" ref={box}>
          <canvas
            ref={cv}
            className="world-chart"
            style={{ width: size.w || undefined, height: size.h || undefined, cursor: pick || tool !== 'move' ? 'crosshair' : 'default' }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
          <p className="world-hint">
            {pick
              ? `click the water to put the ${pick} there · esc cancels`
              : tool === 'place'
                ? 'click open water to hold a position · esc cancels'
                : tool === 'sea'
                  ? 'drag out the water you are naming · esc cancels'
                  : 'drag an island to move it · its berth and its approach go with it'}
          </p>
        </div>

        <aside className="world-side">
          {problems.length > 0 && (
            <div className="world-refused">
              <span className="world-lab">not saved</span>
              {problems.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <div className="world-warns">
              <span className="world-lab">saved, and worth reading</span>
              {warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}
          {!loading && !user && <p className="world-note">Placing is yours until you press save; the save itself needs an account.</p>}

          {place && sel?.kind === 'place' ? (
            <Inspector
              p={place}
              i={sel.i}
              states={states}
              slugs={slugs}
              pick={pick}
              onPick={setPick}
              onEdit={edit}
              onMove={shift}
              onDrop={() => drop(sel.i)}
            />
          ) : region && sel?.kind === 'region' ? (
            <SeaPanel
              r={region}
              kinds={kinds}
              onEdit={(patch) => {
                setDoc({ ...doc, regions: doc.regions.map((x, k) => (k === sel.i ? { ...x, ...patch } : x)) })
                setDirty(true)
              }}
              onDrop={() => dropRegion(sel.i)}
            />
          ) : (
            <p className="world-note">
              Nothing selected. Every island on this chart is one map on the platform, plus the positions a ship uses to
              reach it.
            </p>
          )}

          <div className="world-roster">
            <span className="world-lab">what is on the water</span>
            {doc.places.map((p, i) => (
              <button
                key={i}
                className={'world-row' + (sel?.kind === 'place' && sel.i === i ? ' on' : '')}
                onClick={() => setSel({ kind: 'place', i })}
              >
                <i style={{ background: inkFor(STATE_INK, p.state) }} />
                <span className="world-row-n">{p.name}</span>
                <span className="world-row-m">{p.map || 'rumour'}</span>
              </button>
            ))}
            {doc.regions.map((r, i) => (
              <button
                key={'r' + i}
                className={'world-row' + (sel?.kind === 'region' && sel.i === i ? ' on' : '')}
                onClick={() => setSel({ kind: 'region', i })}
              >
                <i style={{ background: inkFor(SEA_INK, r.kind) }} />
                <span className="world-row-n">{r.name}</span>
                <span className="world-row-m">{r.kind}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}

/* EVERY FIELD THE SERVER KEEPS, IN ONE PANEL.
 *
 * A place that carried a field with no control on it would be a field only the
 * database ever sets, which is the half-plumbed sweep this page exists to stop
 * repeating. So name, map, title, x, y, w, h, state, release, berth and
 * approach are all here, and meta is the only one left out because nothing
 * reads it yet. */
function Inspector({
  p,
  i,
  states,
  slugs,
  pick,
  onPick,
  onEdit,
  onMove,
  onDrop,
}: {
  p: Place
  i: number
  states: string[]
  slugs: string[]
  pick: Pick
  onPick: (v: Pick) => void
  onEdit: (i: number, patch: Partial<Place>) => void
  onMove: (i: number, x: number, y: number) => void
  onDrop: () => void
}) {
  const set = (patch: Partial<Place>) => onEdit(i, patch)
  const legal = isAnchorName(p.name)
  // a map the listing does not carry is still shown, because it may be the
  // island being painted this week and blanking it would rewrite the document
  // behind somebody's back
  const options = p.map && !slugs.includes(p.map) ? [p.map, ...slugs] : slugs

  return (
    <div className="world-insp">
      <span className="world-lab">the place</span>
      <label className="world-f">
        <span>name</span>
        <input
          className={'world-in' + (legal ? '' : ' bad')}
          value={p.name}
          spellCheck={false}
          maxLength={48}
          onChange={(e) => set({ name: e.target.value })}
          onBlur={() => !legal && set({ name: anchorName(p.name) })}
        />
      </label>
      {!legal && <p className="world-bad">a name is the only address there is · lower case, digits, underscores</p>}
      <label className="world-f">
        <span>map</span>
        <select className="world-in" value={p.map} onChange={(e) => set({ map: e.target.value })}>
          <option value="">nothing yet · a rumour</option>
          {options.map((s) => (
            <option key={s} value={s}>
              {s}
              {slugs.includes(s) ? '' : ' · not published'}
            </option>
          ))}
        </select>
      </label>
      <label className="world-f">
        <span>title</span>
        <input className="world-in" value={p.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
      </label>
      {/* typing a coordinate goes through the same move the drag does, so an
          island carries its berth and its approach either way. Two ways to say
          the same thing that mean different things is how a mooring gets left
          behind by whoever typed instead of dragged. */}
      <div className="world-pair">
        <Num label="x" v={p.x} on={(n) => onMove(i, n, p.y)} />
        <Num label="y" v={p.y} on={(n) => onMove(i, p.x, n)} />
      </div>
      <div className="world-pair">
        <Num label="width" v={p.w} min={1} on={(n) => set({ w: n })} />
        <Num label="height" v={p.h} min={1} on={(n) => set({ h: n })} />
      </div>
      <label className="world-f">
        <span>state</span>
        <select className="world-in" value={p.state} onChange={(e) => set({ state: e.target.value })}>
          {states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="world-f">
        <span>release</span>
        <input
          className="world-in"
          type="number"
          min={0}
          value={p.release}
          onChange={(e) => set({ release: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
        />
      </label>
      <p className="world-say">how close the hull comes before this counts as discovered, measured from x,y</p>

      <span className="world-lab">where a ship stops</span>
      <div className="world-mark">
        <span className="world-mark-t">berth</span>
        <button className={'world-btn small' + (pick === 'berth' ? ' on' : '')} onClick={() => onPick(pick === 'berth' ? '' : 'berth')}>
          {p.berth ? 'move it' : 'put one down'}
        </button>
        {p.berth && (
          <button className="world-btn small" onClick={() => set({ berth: undefined })}>
            clear
          </button>
        )}
      </div>
      {p.berth && (
        <>
          <div className="world-pair">
            <Num label="berth x" v={p.berth.x} on={(n) => set({ berth: { ...p.berth, x: n } as Pt })} />
            <Num label="berth y" v={p.berth.y} on={(n) => set({ berth: { ...p.berth, y: n } as Pt })} />
          </div>
          {/* the heading held once the hull is tied up, on the compass the
              editor already uses for a door and a post, so a facing is set the
              same way everywhere in this tool */}
          <span className="world-lab">facing</span>
          <div className="world-face">
            {FACE_GRID.flat().map((k, n) => (
              <button
                key={k || 'none'}
                className={'world-fbtn' + ((k ? p.berth?.facing === k : !p.berth?.facing) ? ' on' : '')}
                title={k || 'no opinion'}
                onClick={() => {
                  const b = p.berth as Pt
                  set({ berth: k && b.facing !== k ? { x: b.x, y: b.y, facing: k } : { x: b.x, y: b.y } })
                }}
              >
                {FACE_ARROW[n]}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="world-mark">
        <span className="world-mark-t">approach</span>
        <button
          className={'world-btn small' + (pick === 'approach' ? ' on' : '')}
          onClick={() => onPick(pick === 'approach' ? '' : 'approach')}
        >
          {p.approach ? 'move it' : 'put one down'}
        </button>
        {p.approach && (
          <button className="world-btn small" onClick={() => set({ approach: undefined })}>
            clear
          </button>
        )}
      </div>
      {p.approach && (
        <div className="world-pair">
          <Num label="approach x" v={p.approach.x} on={(n) => set({ approach: { ...p.approach, x: n } as Pt })} />
          <Num label="approach y" v={p.approach.y} on={(n) => set({ approach: { ...p.approach, y: n } as Pt })} />
        </div>
      )}

      <button className="world-btn danger" onClick={onDrop}>
        take {p.name} off the chart
      </button>
    </div>
  )
}

function SeaPanel({ r, kinds, onEdit, onDrop }: { r: Region; kinds: string[]; onEdit: (patch: Partial<Region>) => void; onDrop: () => void }) {
  const set = (n: number, v: number) => {
    const rect = [...r.rect] as [number, number, number, number]
    rect[n] = v
    onEdit({ rect })
  }
  return (
    <div className="world-insp">
      <span className="world-lab">the water itself</span>
      <label className="world-f">
        <span>name</span>
        <input
          className={'world-in' + (isAnchorName(r.name) ? '' : ' bad')}
          value={r.name}
          spellCheck={false}
          maxLength={48}
          onChange={(e) => onEdit({ name: e.target.value })}
          onBlur={() => !isAnchorName(r.name) && onEdit({ name: anchorName(r.name) })}
        />
      </label>
      <label className="world-f">
        <span>kind</span>
        <select className="world-in" value={r.kind} onChange={(e) => onEdit({ kind: e.target.value })}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label className="world-f">
        <span>label</span>
        <input className="world-in" value={r.label || ''} maxLength={120} onChange={(e) => onEdit({ label: e.target.value })} />
      </label>
      {/* two opposite corners, the order the mask's own rect settled on, so one
          reader shape serves an anchor region and a sea region */}
      <div className="world-pair">
        <Num label="x0" v={r.rect[0]} on={(n) => set(0, n)} />
        <Num label="y0" v={r.rect[1]} on={(n) => set(1, n)} />
      </div>
      <div className="world-pair">
        <Num label="x1" v={r.rect[2]} on={(n) => set(2, n)} />
        <Num label="y1" v={r.rect[3]} on={(n) => set(3, n)} />
      </div>
      <button className="world-btn danger" onClick={onDrop}>
        take {r.name} off the chart
      </button>
    </div>
  )
}

function Num({ label, v, min, on }: { label: string; v: number; min?: number; on: (n: number) => void }) {
  return (
    <label className="world-f">
      <span>{label}</span>
      <input
        className="world-in"
        type="number"
        value={v}
        onChange={(e) => {
          const n = Number(e.target.value)
          on(Math.max(min ?? -1e9, Number.isFinite(n) ? Math.round(n) : 0))
        }}
      />
    </label>
  )
}
