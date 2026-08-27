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
 * The walk law is the game's: the levels png read per pixel, a hip band tested
 * either side of the feet so nobody balances on one legal pixel, and the two
 * axes resolved separately so a wall stops you without stopping the slide along
 * it.
 */
import { useEffect, useRef, useState } from 'react'
import { cleanLife, lifeAt, separate, type Life } from '../core/life'

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
        const standable = (x: number, y: number) => {
          const yy = y + hipDY
          const here = at(x, yy)
          if (here <= (meta.encoding?.blocked ?? 0)) return false
          for (let dx = -hip; dx <= hip; dx++) {
            const v = at(x + dx, yy)
            if (v <= 0 || Math.abs(v - here) > tol) return false
          }
          return true
        }
        /* Where the ground actually is, measured once off the levels plane.
         * Everything on screen is framed against this rather than against the
         * canvas the ground happens to sit inside. */
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

        const headingOf = (dx: number, dy: number) => {
          // the 2:1 squash, so a walking figure picks the view the game picks
          const a = Math.atan2(dy / yScale, dx)
          const k = Math.round((a * 8) / (Math.PI * 2) + 8) % 8
          return ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'][k]
        }

        let last = performance.now()
        const draw = (now: number) => {
          if (dead) return
          const dt = Math.min(0.05, (now - last) / 1000)
          last = now
          const t = now / 1000

          let ax = 0
          let ay = 0
          if (keys.has('a') || keys.has('arrowleft')) ax -= 1
          if (keys.has('d') || keys.has('arrowright')) ax += 1
          if (keys.has('w') || keys.has('arrowup')) ay -= 1
          if (keys.has('s') || keys.has('arrowdown')) ay += 1
          const moving = !!(ax || ay)
          if (moving) {
            const m = Math.hypot(ax, ay) || 1
            const nx = px + (ax / m) * speed * dt
            const ny = py + (ay / m) * speed * dt * yScale
            if (standable(nx, py)) px = nx
            if (standable(px, ny)) py = ny
            facing = headingOf(ax, ay)
            stepT += dt
          } else stepT = 0

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
          const zoom = Math.max(1, Math.min(8, Math.floor(Math.min(box.width / land.w, box.height / land.h))))
          const w = meta.w * zoom
          const h = meta.h * zoom
          const ox = Math.round(box.width / 2 - (land.x + land.w / 2) * zoom)
          const oy = Math.round(box.height / 2 - (land.y + land.h / 2) * zoom)

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
