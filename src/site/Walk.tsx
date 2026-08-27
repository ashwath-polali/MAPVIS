/* Walking a published map, properly.
 *
 * The first version drew the painting and a yellow stick, which was a test
 * harness with a play button on it. This draws the map: every placement, moving
 * on its real life data, y-sorted against you, with Thor as Thor.
 *
 * It reads the ATLAS when there is one, so the hub costs six requests instead
 * of eight hundred. Frames come out of one sheet by rectangle, which is the
 * same drawImage the loose files needed, minus 794 downloads.
 *
 * THE WALK LAW IS IMPORTED, NOT REWRITTEN.
 *
 * This file used to carry its own copy of the step test, and it had drifted
 * four ways from the one the editor runs: it probed the hip band at y + hipDY
 * where the real law probes y - hipDY, it demanded every pixel across the band
 * be legal where the real law checks exactly the two hip points, it compared
 * heights against the destination instead of against the level being stepped
 * off, and it had none of the escape clause that lets a character standing on a
 * blocked pixel move at all. The result was invisible walls, a character who
 * could walk off the quay, and a walk test that disagreed with the tool that
 * drew the mask, which makes it worse than no walk test.
 *
 * So canStandFrom and Walker come from src/core/walk.ts, the same functions the
 * levels step uses, driven through a tiny adapter over the published levels png.
 * They cannot disagree now, because there is only one of them.
 */
import { useEffect, useRef, useState } from 'react'
import { cleanLife, lifeAt, separate, type Life } from '../core/life'
import { Walker, canStand, defaultCfg, type WalkCfg } from '../core/walk'
import type { MaskDoc } from '../core/mask'

type Rect = [number, number, number, number]
type Placed = {
  x: number
  y: number
  scale?: number
  scaleX?: number
  scaleY?: number
  rot?: number
  flipX?: boolean
  flipY?: boolean
  src?: string
  srcAt?: Rect
  frames?: string[]
  framesAt?: Rect[]
  dirs?: Record<string, string[]>
  dirsAt?: Record<string, Rect[]>
  fps?: number
  life?: unknown
}
/* one drawable: either a rectangle in the sheet, or its own image */
type Cell = { img: HTMLImageElement; r: Rect }
type Live = { p: Placed; life: Life | null; still?: Cell; frames: Cell[]; dirs: Record<string, Cell[]>; fps: number }

const HEADINGS = ['south', 'south-west', 'west', 'north-west', 'north', 'north-east', 'east', 'south-east']

const load = (src: string) =>
  new Promise<HTMLImageElement | null>((res) => {
    const i = new Image()
    i.crossOrigin = 'anonymous'
    i.onload = () => res(i)
    i.onerror = () => res(null)
    i.src = src
  })

export function Walk({ slug, version }: { slug: string; version: number }) {
  const mount = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'playing' | 'failed'>('loading')
  const [near, setNear] = useState('')
  const [why, setWhy] = useState('')
  /* The camera, in a ref beside the state.
   *
   * The draw loop is inside an effect that must not restart when the camera
   * changes, because restarting it reloads the atlas and puts Thor back at the
   * spawn. The ref is what the loop reads; the state is only what the button
   * renders itself from. */
  const [mode, setMode] = useState<'island' | 'pov'>('island')
  const modeRef = useRef(mode)
  modeRef.current = mode

  useEffect(() => {
    let dead = false
    let raf = 0
    const keys = new Set<string>()
    const down = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault()
      keys.add(e.key.toLowerCase())
    }
    const up = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase())

    ;(async () => {
      try {
        const base = `/api/v1/maps/${slug}/file/${version}/`
        const meta = await (await fetch(`${base}map.json`)).json()
        const [scene, levels] = await Promise.all([load(`${base}scene.png`), load(`${base}levels.png`)])
        if (dead) return
        if (!scene) throw new Error('the painting would not load')

        // the levels plane, read once. A canvas readback per frame is a stall
        // on every step.
        let lv: Uint8ClampedArray | null = null
        if (levels) {
          const lc = document.createElement('canvas')
          lc.width = meta.w
          lc.height = meta.h
          const lg = lc.getContext('2d', { willReadFrequently: true })!
          lg.drawImage(levels, 0, 0)
          lv = lg.getImageData(0, 0, meta.w, meta.h).data
        }
        const at = (x: number, y: number) =>
          !lv || x < 0 || y < 0 || x >= meta.w || y >= meta.h ? 40 : lv[((y | 0) * meta.w + (x | 0)) * 4]

        // ---- the placements ------------------------------------------------
        const aj = await (await fetch(`${base}assets.json`)).json().catch(() => ({ assets: [] }))
        const list: Placed[] = aj.assets || []
        let sheet: HTMLImageElement | null = null
        if (aj.atlas) sheet = await load(base + aj.atlas)

        const cellOf = async (url?: string, rect?: Rect): Promise<Cell | undefined> => {
          if (rect && sheet) return { img: sheet, r: rect }
          if (!url) return undefined
          const i = await load(base + url)
          return i ? { img: i, r: [0, 0, i.width, i.height] } : undefined
        }

        const live: Live[] = []
        for (const p of list) {
          if (dead) return
          const v: Live = { p, life: cleanLife(p.life), frames: [], dirs: {}, fps: p.fps || 6 }
          v.still = await cellOf(p.src, p.srcAt)
          if (p.frames)
            for (let i = 0; i < p.frames.length; i++) {
              const c = await cellOf(p.frames[i], p.framesAt?.[i])
              if (c) v.frames.push(c)
            }
          const dirs = p.dirsAt || p.dirs
          if (dirs)
            for (const [k, arr] of Object.entries(dirs)) {
              const out: Cell[] = []
              for (let i = 0; i < arr.length; i++) {
                const c = await cellOf(p.dirs?.[k]?.[i], p.dirsAt?.[k]?.[i])
                if (c) out.push(c)
              }
              if (out.length) v.dirs[k] = out
            }
          if (v.still || v.frames.length || Object.keys(v.dirs).length) live.push(v)
        }

        // ---- Thor ----------------------------------------------------------
        const thor: Record<string, HTMLImageElement[]> = {}
        await Promise.all(
          HEADINGS.map(async (h) => {
            const set: HTMLImageElement[] = []
            for (let i = 0; i < 6; i++) {
              const im = await load(`/thor/${h}/${i}.png`)
              if (im) set.push(im)
            }
            if (set.length) thor[h] = set
          }),
        )

        if (dead) return
        const el = mount.current!
        const cv = document.createElement('canvas')
        cv.className = 'walk-canvas'
        el.replaceChildren(cv)
        const g = cv.getContext('2d')!

        let px = meta.spawn?.[0] ?? meta.w / 2
        let py = meta.spawn?.[1] ?? meta.h / 2
        let facing = 'south'
        let stepT = 0
        const tol = meta.encoding?.stepTolerance ?? 10
        const speed = meta.speed || 34
        const yScale = meta.yScale ?? 0.72
        const hip = meta.character?.hip ?? 2
        const charH = meta.character?.heightPx ?? 18

        /* The game's walk law, including hipDY.
         *
         * The band is tested at y + hipDY, not at y: feet sit a pixel or two
         * below the point the collision is meant to read, and dropping that
         * offset shifts every test by that much. Close enough to look right and
         * wrong enough that Thor walks a pixel past a wall and jams against the
         * next one. */
        const hipDY = meta.character?.hipDY ?? 0

        /* The map's own numbers, in the shape the shared law expects. near is
         * stepTolerance under its editor name: how much height a step may cross.
         * Anything the bundle does not carry falls back to the same defaults the
         * exporter writes, so an older bundle walks the way it always did. */
        const cfg: WalkCfg = { ...defaultCfg(), speed, hip, hipDY, near: tol, charH, yScale }

        /* canStandFrom only ever asks a document for one thing, the level under
         * a pixel, and markHit is the editor painting its refused-move layer,
         * which a published map has nowhere to put. So the whole document
         * interface a published bundle needs is these two. */
        const docLike = { lvlAt: (x: number, y: number) => at(x, y), markHit: () => {} } as unknown as MaskDoc
        const standable = (x: number, y: number) => canStand(docLike, cfg, x, y)
        /* Where the ground actually is, measured once off the levels plane.
         * Everything on screen is framed against this rather than against the
         * canvas the ground happens to sit inside. */
        /* A SPAWN THAT IS NOT STANDABLE IS A CHARACTER WHO CANNOT MOVE.
         *
         * Movement only commits a step the collision test accepts, so starting
         * on a pixel that fails the test leaves every direction refused and Thor
         * frozen on the spot with no way to tell why. The hub spawns at 557,508
         * and hip is 2, so the test reads five pixels across and one of them is
         * off the edge of the walkable band. The nearest pixel that does pass is
         * 556,507, one across and one up.
         *
         * A whole map is not broken by one pixel. The spawn is a hint, so it is
         * treated as one: search outward for the closest standable pixel and
         * start there. Nothing is written back, because the document belongs to
         * the author and the editor is where a spawn gets moved on purpose. */
        const roomy = (x: number, y: number) =>
          standable(x, y) &&
          standable(x - 1, y) &&
          standable(x + 1, y) &&
          standable(x, y - 1) &&
          standable(x, y + 1)
        const settle = (x: number, y: number, reach = 96) => {
          if (roomy(x, y)) return { x, y }
          // two passes outward: somewhere with elbow room first, then anywhere
          // standable at all. Landing hard against a wall is technically legal
          // and reads as being stuck, because half the directions refuse.
          let any: { x: number; y: number } | null = null
          for (let r = 1; r <= reach; r++)
            for (let a = 0; a < 360; a += 5) {
              const nx = Math.round(x + Math.cos((a * Math.PI) / 180) * r)
              const ny = Math.round(y + Math.sin((a * Math.PI) / 180) * r)
              if (roomy(nx, ny)) return { x: nx, y: ny }
              if (!any && standable(nx, ny)) any = { x: nx, y: ny }
            }
          // nothing within reach is standable, so leave the hint alone rather
          // than teleporting somebody to a corner of the canvas
          return any || { x, y }
        }
        ;({ x: px, y: py } = settle(px, py))
        const walker = new Walker([px, py])

        /* A WALKER STANDING OFF THE GROUND CANNOT WALK.
         *
         * lifeAt is handed the collision test so a wandering figure stays on the
         * floor, which means a figure whose own position fails that test has
         * nowhere legal to step and holds still forever. Seven of the hub's
         * twenty-two moving placements are in exactly that state, sitting a
         * pixel or two off the walkable band, and they read on screen as people
         * frozen mid-street while the ones beside them move.
         *
         * Nudged the same way the spawn is, and only a few pixels: far enough to
         * find the floor, near enough that nobody has been moved anywhere an
         * author would notice. The saved document is untouched; this is the
         * reader being forgiving, not the map being rewritten.
         *
         * Eight pixels and no further, because past that it stops being a
         * rounding error and starts being a relocation. Two of the hub's are 82
         * and 90 pixels from any floor, which is not a placement that slipped,
         * it is a placement standing somewhere the mask never made walkable.
         * Papering over that would hide the actual defect, so anything still
         * stranded is named in the console instead: the map is what needs the
         * edit, and the tool should say which placement to go and look at. */
        const stranded: string[] = []
        for (const v of live) {
          if (!v.life) continue
          const s = settle(v.p.x, v.p.y, 8)
          if (!standable(s.x, s.y)) {
            stranded.push(`${(v.p as { id?: string }).id ?? '?'} at ${v.p.x},${v.p.y}`)
            continue
          }
          if (s.x !== v.p.x || s.y !== v.p.y) v.p = { ...v.p, x: s.x, y: s.y }
        }
        if (stranded.length)
          console.warn(
            `[walk] ${stranded.length} moving placement(s) stand off walkable ground and cannot move: ` +
              `${stranded.join('; ')}. Widen the mask under them, or move them, in the levels step.`,
          )

        const land = (() => {
          let x0 = meta.w
          let y0 = meta.h
          let x1 = 0
          let y1 = 0
          for (let y = 0; y < meta.h; y++)
            for (let x = 0; x < meta.w; x++)
              if (at(x, y) > (meta.encoding?.blocked ?? 0)) {
                if (x < x0) x0 = x
                if (y < y0) y0 = y
                if (x > x1) x1 = x
                if (y > y1) y1 = y
              }
          return x1 > x0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w: meta.w, h: meta.h }
        })()

        /* WHAT TO FRAME IS THE PICTURE, NOT THE WALKABLE STRIP.
         *
         * Zoom used to fit `land`, the bounding box of standable pixels. On the
         * hub that box is 534x185 while the painting is 688x640, because the
         * ground people can stand on is a band across the middle and the volcano,
         * the cliffs and the rooftops are all above it. Fitting the band picked
         * zoom 3 and drew the scene at 2064x1920 inside an 880-tall window, so
         * the island was enormous and cut off at the top and bottom. Fitting the
         * bare canvas is the other failure the old comment describes: a painting
         * carries transparent margin, so that leaves the island a stamp in a
         * field of black.
         *
         * The thing that is neither is the painting's own visible extent: the
         * alpha bounding box. Read once, off the image already loaded. Unioned
         * with land so no standable pixel can ever fall outside the view, and
         * falling back to land if the readback is refused. */
        const view = (() => {
          try {
            const c = document.createElement('canvas')
            c.width = meta.w
            c.height = meta.h
            const cg = c.getContext('2d', { willReadFrequently: true })!
            cg.drawImage(scene, 0, 0, meta.w, meta.h)
            const d = cg.getImageData(0, 0, meta.w, meta.h).data
            let x0 = meta.w
            let y0 = meta.h
            let x1 = -1
            let y1 = -1
            for (let y = 0; y < meta.h; y++)
              for (let x = 0; x < meta.w; x++)
                if (d[(y * meta.w + x) * 4 + 3] > 8) {
                  if (x < x0) x0 = x
                  if (y < y0) y0 = y
                  if (x > x1) x1 = x
                  if (y > y1) y1 = y
                }
            if (x1 < x0) return land
            const ax = Math.min(x0, land.x)
            const ay = Math.min(y0, land.y)
            const bx = Math.max(x1, land.x + land.w - 1)
            const by = Math.max(y1, land.y + land.h - 1)
            return { x: ax, y: ay, w: bx - ax + 1, h: by - ay + 1 }
          } catch {
            return land
          }
        })()

        // Which way Thor faces is now Walker's own dirFrom, off the same squash,
        // so the picked view matches the editor's walk test rather than a second
        // rounding of the same angle.

        let last = performance.now()
        const draw = (now: number) => {
          if (dead) return
          const dt = Math.min(0.05, (now - last) / 1000)
          last = now
          const t = now / 1000

          /* The editor's own Walker, stepped with the editor's own keys map, so
           * the axis slide, the height rule and the escape clause for standing
           * on a blocked pixel are all the ones the levels step demonstrates
           * rather than a second interpretation of them. */
          const held: Record<string, boolean> = {}
          for (const k of keys) held[k] = true
          const moving = !!(
            held.w ||
            held.a ||
            held.s ||
            held.d ||
            held.arrowup ||
            held.arrowdown ||
            held.arrowleft ||
            held.arrowright
          )
          walker.step(docLike, cfg, held, dt)
          px = walker.x
          py = walker.y
          facing = walker.facing
          stepT = moving ? stepT + dt : 0

          const box = el.getBoundingClientRect()
          const dpr = Math.min(2, window.devicePixelRatio || 1)
          if (cv.width !== Math.round(box.width * dpr)) {
            cv.width = Math.round(box.width * dpr)
            cv.height = Math.round(box.height * dpr)
            cv.style.width = box.width + 'px'
            cv.style.height = box.height + 'px'
          }
          /* FIT THE LAND, NOT THE CANVAS.
           *
           * A painting is grown with transparent margin so the map can spread,
           * so the hub is 688x640 with ground only in the middle 400 rows.
           * Fitting the canvas picked zoom 1 and left the island a stamp in a
           * field of black. Fitting the ground it actually has picks 2, and the
           * empty margin is cropped rather than framed. */
          /* TWO WAYS TO WATCH THE SAME MAP.
           *
           * ISLAND frames the whole painting and holds still, which is what you
           * want when the question is whether the map reads. POV picks a zoom
           * close enough to see a character's feet against the ground and keeps
           * him in the middle, which is what you want when the question is
           * whether he walks. They differ only in zoom and in what the view is
           * centred on, so nothing below this needs to know which is on.
           *
           * The camera is clamped to the painting in POV so walking to an edge
           * shows the edge rather than sliding the island off into black. */
          const pov = modeRef.current === 'pov'
          const fit = Math.min(box.width / view.w, box.height / view.h)
          const zoom = pov
            ? Math.max(2, Math.min(8, Math.round(fit * 2.5)))
            : Math.max(1, Math.min(8, Math.floor(fit)))
          const w = meta.w * zoom
          const h = meta.h * zoom
          let cx = view.x + view.w / 2
          let cy = view.y + view.h / 2
          if (pov) {
            const halfW = box.width / 2 / zoom
            const halfH = box.height / 2 / zoom
            // follow him, but never past the edge of the painting
            cx = Math.min(Math.max(px, view.x + halfW), view.x + view.w - halfW)
            cy = Math.min(Math.max(py, view.y + halfH), view.y + view.h - halfH)
            // a painting narrower than the window simply centres
            if (view.w < halfW * 2) cx = view.x + view.w / 2
            if (view.h < halfH * 2) cy = view.y + view.h / 2
          }
          const ox = Math.round(box.width / 2 - cx * zoom)
          const oy = Math.round(box.height / 2 - cy * zoom)

          g.setTransform(dpr, 0, 0, dpr, 0, 0)
          g.imageSmoothingEnabled = false
          g.clearRect(0, 0, box.width, box.height)
          g.drawImage(scene, ox, oy, w, h)

          /* Where everything is this frame.
           *
           * A placement with no life is FURNITURE and must not move: houses,
           * stalls and sea walls were being fed through separate() along with
           * the walkers, so the whole island drifted a few pixels every frame
           * and read as a map that would not sit still. Only the things that
           * are actually walking push each other apart.
           *
           * A standing figure also has no direction to derive, so its resting
           * view is the facing the exporter now records rather than south. */
          const pts = live.map((v) => ({ x: v.p.x, y: v.p.y, r: 3 }))
          const shown = live.map((v, i) => {
            let alpha = 1
            let face = (v.p as { facing?: string }).facing || 'south'
            let flip = false
            if (v.life) {
              /* canStand is what keeps a walkOnly figure on the ground. Leaving
               * it out is why the fishwives were strolling across the sea wall:
               * lifeAt has nothing to test against and happily walks a wander
               * straight over anything. The game passes it; so must this. */
              const s = lifeAt(v.life, t, { x: v.p.x, y: v.p.y }, standable)
              pts[i] = { x: v.p.x + s.dx, y: v.p.y + s.dy, r: 3 }
              alpha = s.alpha
              face = s.facing
              flip = s.flip
            }
            return { v, alpha, face, flip, moves: !!v.life }
          })
          const movers = pts.filter((_, i) => shown[i].moves)
          separate(movers, yScale, 1)
          let mi = 0
          for (let i = 0; i < pts.length; i++) if (shown[i].moves) pts[i] = movers[mi++]

          const order: Array<{ y: number; go: () => void }> = shown.map((s, i) => ({
            y: pts[i].y,
            go: () => {
              const v = s.v
              const set = v.dirs[s.face] || v.dirs.south
              const cell = set?.length
                ? set[Math.floor(t * v.fps) % set.length]
                : v.frames.length
                  ? v.frames[Math.floor(t * v.fps) % v.frames.length]
                  : v.still
              if (!cell) return
              const sx = (v.p.scaleX ?? v.p.scale ?? 1) * zoom
              const sy = (v.p.scaleY ?? v.p.scale ?? 1) * zoom
              g.save()
              g.globalAlpha = s.alpha
              g.translate(ox + pts[i].x * zoom, oy + pts[i].y * zoom)
              if (v.p.rot) g.rotate(v.p.rot)
              g.scale((v.p.flipX ? -1 : 1) * (set ? 1 : s.flip ? -1 : 1), v.p.flipY ? -1 : 1)
              const [rx, ry, rw, rh] = cell.r
              g.drawImage(cell.img, rx, ry, rw, rh, (-rw * sx) / 2, -rh * sy, rw * sx, rh * sy)
              g.restore()
            },
          }))

          order.push({
            y: py,
            go: () => {
              const set = thor[facing] || thor.south
              if (!set?.length) {
                g.fillStyle = '#ffd66e'
                g.fillRect(ox + px * zoom - zoom, oy + py * zoom - charH * zoom, zoom * 2, charH * zoom)
                return
              }
              const f = moving ? 1 + (Math.floor(stepT * 9) % (set.length - 1)) : 0
              const im = set[Math.min(f, set.length - 1)]
              /* Thor's frames are drawn at 144px; map.json says a person on this
               * island is 18 painting pixels tall. So the scale is simply how
               * many screen pixels 18 painting pixels comes to, divided by the
               * frame height. Getting this wrong drew him eight times life size,
               * standing over the harbour like a kaiju. */
              const s = (charH * zoom) / im.height
              g.drawImage(im, ox + px * zoom - (im.width * s) / 2, oy + py * zoom - im.height * s, im.width * s, im.height * s)
            },
          })
          order.sort((a, b) => a.y - b.y).forEach((o) => o.go())

          // named places, and the nearest one announced
          let closest = ''
          let best = 1e9
          for (const a of meta.anchors || []) {
            const r = a.r || 14
            const d = Math.hypot(a.x - px, (a.y - py) / yScale)
            if (d < r && d < best) {
              best = d
              closest = a.label || a.name
            }
          }
          setNear(closest)
          raf = requestAnimationFrame(draw)
        }
        raf = requestAnimationFrame(draw)
        window.addEventListener('keydown', down)
        window.addEventListener('keyup', up)
        el.focus()
        setState('playing')
      } catch (e) {
        setWhy(String((e as Error).message))
        setState('failed')
      }
    })()

    return () => {
      dead = true
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [slug, version])

  return (
    <div className="walk">
      <div className="walk-stage" tabIndex={0}>
        <div className="walk-mount" ref={mount} />
        {state === 'loading' && (
          <div className="walk-over">
            <Loading />
            <span>waking the island</span>
          </div>
        )}
        {state === 'failed' && <div className="walk-over bad">{why}</div>}
      </div>
      <div className="walk-hint">
        <span>WASD or arrows to move</span>
        <div className="walk-cam" role="group" aria-label="camera">
          <button
            type="button"
            className={mode === 'island' ? 'on' : ''}
            onClick={() => setMode('island')}
            aria-pressed={mode === 'island'}
          >
            island
          </button>
          <button
            type="button"
            className={mode === 'pov' ? 'on' : ''}
            onClick={() => setMode('pov')}
            aria-pressed={mode === 'pov'}
          >
            pov
          </button>
        </div>
        <span className={near ? 'on' : ''}>{near || ''}</span>
      </div>
    </div>
  )
}

/* Four squares walking a ring, on the pixel grid. It belongs to this app in a
 * way a spinning arc does not, and it is the same mark used everywhere else
 * something is loading. */
export function Loading() {
  return (
    <div className="pixload" aria-hidden>
      <i />
      <i />
      <i />
      <i />
    </div>
  )
}
