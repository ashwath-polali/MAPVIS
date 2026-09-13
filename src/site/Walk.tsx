/* the walk law comes from src/core/walk.ts: the old local copy drifted four ways into invisible walls. */
import { useEffect, useRef, useState } from 'react'
import { bodyAt, cleanLife, lifeAt, separate, type Body, type Life } from '../core/life'
import { Walker, canStand, defaultCfg, type WalkCfg } from '../core/walk'
import type { MaskDoc } from '../core/mask'

type Rect = [number, number, number, number]
/* THE SAME DEPTH RULE THE EDITOR AND THE GAME USE, so a map is drawn in one order wherever it
 * is drawn. Where it stands, plus the author's nudge, and no nudge is the plain y-sort. */
const zOf = (p: { z?: number }) => (Number.isFinite(Number(p.z)) ? Number(p.z) : 0)

type Placed = {
  x: number
  y: number
  group?: string
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
  /* [ox, oy, rx, ry] base ellipse in painting pixels from the anchor; an older bundle carries none. */
  foot?: number[]
  /* WHICH OF TWO OVERLAPPING THINGS IS IN FRONT, written by move-forward and move-back in the
   * editor. Added to the sort key and never to the position. Absent on nearly every placement
   * and on every bundle published before it existed. */
  z?: number
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
  const [where, setAt] = useState('')
  /* the camera is a ref because restarting the draw effect reloads the atlas and respawns the walker. */
  const [mode, setMode] = useState<'island' | 'pov'>('island')
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [showMask, setShowMask] = useState(false)
  const maskRef = useRef(showMask)
  maskRef.current = showMask

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
        /* lvlAt to the letter: it ROUNDS rather than truncates, and off the map is 0, blocked, not 40. */
        const at = (x: number, y: number) => {
          const xi = Math.round(x)
          const yi = Math.round(y)
          if (!lv || xi < 0 || yi < 0 || xi >= meta.w || yi >= meta.h) return 0
          return lv[(yi * meta.w + xi) * 4]
        }

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

        // ---- the walker ----------------------------------------------------------
        /* 38 empty rows sit under his feet in a 144 frame, and one height scales every frame or he pulses. */
        const A_MIN = 40 // the repo-wide alpha threshold
        type Frame = { img: HTMLImageElement; feet: number; top: number }
        const trimToFeet = (im: HTMLImageElement): Frame | null => {
          try {
            const c = document.createElement('canvas')
            c.width = im.width
            c.height = im.height
            const tg = c.getContext('2d', { willReadFrequently: true })!
            tg.drawImage(im, 0, 0)
            const d = tg.getImageData(0, 0, im.width, im.height).data
            let top = -1
            let feet = -1
            for (let y = 0; y < im.height; y++) {
              let hit = false
              for (let x = 0; x < im.width && !hit; x++) if (d[(y * im.width + x) * 4 + 3] > A_MIN) hit = true
              if (hit) {
                if (top < 0) top = y
                feet = y
              }
            }
            return feet < 0 ? null : { img: im, feet, top }
          } catch {
            return null
          }
        }
        const frames: Record<string, Frame[]> = {}
        await Promise.all(
          HEADINGS.map(async (h) => {
            const set: Frame[] = []
            for (let i = 0; i < 6; i++) {
              const im = await load(`/walker/${h}/${i}.png`)
              const t = im && trimToFeet(im)
              if (t) set.push(t)
            }
            if (set.length) frames[h] = set
          }),
        )
        // the standing south frame is the one charH measures, exactly as the rig does
        // 1 is never used: with no frames at all the draw takes its capsule
        // fallback and never reaches the scale.
        const stand = frames.south?.[0] || Object.values(frames)[0]?.[0]
        const drawnH = stand ? stand.feet - stand.top + 1 : 1

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

        /* the hip band is tested at y + hipDY, not y, or the walker steps a pixel past a wall. */
        const hipDY = meta.character?.hipDY ?? 0

        /* near is stepTolerance under its editor name, and what the bundle omits falls back to defaults. */
        const cfg: WalkCfg = { ...defaultCfg(), speed, hip, hipDY, near: tol, charH, yScale }

        /* canStandFrom only asks the level under a pixel, so lvlAt and a no-op markHit are all of it. */
        /* only the still ones block: a solid crowd walled the pier at 9px of harbour instead of 235. */
        const solids: Body[] = []
        /* footprint if there is one, else the old radius 3 circle, and an effect is never solid. */
        const bodyOf = (p: Placed, x: number, y: number, r: number): Body | null => {
          if (p.group === 'effects') return null
          const f = p.foot
          if (!f) return { x, y, r }
          if (!(f[2] > 0) || !(f[3] > 0)) return null
          // r is kept sane rather than zero so anything that reads it without
          // knowing about rx and ry still gets a circle roughly the right size
          return { x: x + f[0], y: y + f[1], r: f[2], rx: f[2], ry: f[3] }
        }

        /* bodies must never go into lvlAt: it reads the feet and both hips, so one fences five pixels. */
        const docLike = { lvlAt: (x: number, y: number) => at(x, y), markHit: () => {} } as unknown as MaskDoc
        const standable = (x: number, y: number) => canStand(docLike, cfg, x, y)
        const bareStand = standable
        // "is somebody already there", read after a step rather than folded into
        // the floor: the floor has to stay still or lifeAt stops being pure
        const occupied = bodyAt(solids, yScale)
        /* Where the ground actually is, measured once off the levels plane.
         * Everything on screen is framed against this rather than against the
         * canvas the ground happens to sit inside. */
        /* an unstandable spawn freezes him, so it is a hint: search out to the nearest standable pixel. */
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

        /* green is what the mask marks, yellow where a body can stand, the stricter test that decides. */
        const maskCv = (() => {
          try {
            const c = document.createElement('canvas')
            c.width = meta.w
            c.height = meta.h
            const mg = c.getContext('2d')!
            const im = mg.createImageData(meta.w, meta.h)
            for (let y = 0; y < meta.h; y++)
              for (let x = 0; x < meta.w; x++) {
                const i = (y * meta.w + x) * 4
                if (at(x, y) <= 0) continue
                const ok = standable(x, y)
                im.data[i] = ok ? 250 : 40
                im.data[i + 1] = ok ? 240 : 200
                im.data[i + 2] = ok ? 60 : 90
                im.data[i + 3] = 130
              }
            mg.putImageData(im, 0, 0)
            return c
          } catch {
            return null
          }
        })()

        /* a placement is never nudged onto walkable ground: that hauled two rowboats out of the harbour. */
        /* walkPct is re-measured, not trusted: 63.2 percent stored against 20.3 real on a dragged box. */
        const walkFraction = (r: { x: number; y: number; w: number; h: number }) => {
          const step = Math.max(1, Math.floor(Math.min(r.w, r.h) / 40))
          let seen = 0
          let walk = 0
          for (let y = r.y; y < r.y + r.h; y += step)
            for (let x = r.x; x < r.x + r.w; x += step) {
              if (x < 0 || y < 0 || x >= meta.w || y >= meta.h) continue
              seen++
              if (at(x, y) > 0) walk++
            }
          return seen ? walk / seen : 0
        }
        let restated = 0
        for (const v of live) {
          const life = v.life as { bounds?: { x: number; y: number; w: number; h: number }; walkPct?: number } | null
          if (!life?.bounds || typeof life.walkPct !== 'number') continue
          const now = walkFraction(life.bounds)
          if (Math.abs(now - life.walkPct) > 0.01) restated++
          life.walkPct = now
        }
        if (restated) console.warn(`[walk] ${restated} placement(s) carried a stale walkPct; re-measured from the mask`)

        const stuckWalkers = live
          .filter((v) => v.life && !standable(v.p.x, v.p.y))
          .map((v) => `${(v.p as { id?: string }).id ?? '?'} at ${v.p.x},${v.p.y}`)
        if (stuckWalkers.length)
          console.warn(
            `[walk] ${stuckWalkers.length} moving placement(s) are not on walkable ground: ` +
              `${stuckWalkers.join('; ')}. If one of them is meant to walk, the mask under it needs ` +
              `widening in the levels step. If it floats or bobs, this is expected.`,
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

        /* frame the alpha box, not the walkable band: fitting 534x185 of 688x640 picked zoom 3. */
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

        // Which way the walker faces is now Walker's own dirFrom, off the same squash,
        // so the picked view matches the editor's walk test rather than a second
        // rounding of the same angle.

        let last = performance.now()
        const draw = (now: number) => {
          if (dead) return
          const dt = Math.min(0.05, (now - last) / 1000)
          last = now
          const t = now / 1000

          /* the editor's own Walker and keys map, so nothing here reinterprets the step law. */
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
          /* a walker gives way and is not blocked against, or the crowd on the two pixel pier is a fence. */
          const bx = walker.x
          const by = walker.y
          walker.step(docLike, cfg, held, dt)
          /* each axis is kept when it alone is clear, so a solid is slid along instead of glue. */
          /* measured on the published hub: footprints cover 173px of floor against the old dots' 326px. */
          const HARD_BODIES = true
          if (HARD_BODIES && occupied(walker.x, walker.y)) {
            if (!occupied(walker.x, by)) walker.y = by
            else if (!occupied(bx, walker.y)) walker.x = bx
            else {
              walker.x = bx
              walker.y = by
            }
          }
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
          /* fit the land, not the canvas: the hub is 688x640 with ground in the middle 400 rows. */
          /* island and pov differ only in zoom and centre, and pov clamps the camera to the painting. */
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
          /* the mask blits with the scene's own transform, so you see the plane the step test reads. */
          if (maskRef.current && maskCv) g.drawImage(maskCv, ox, oy, w, h)

          /* only walking things go through separate, or the furniture drifts the island every frame. */
          const pts = live.map((v) => ({ x: v.p.x, y: v.p.y, r: 3 }))
          const shown = live.map((v, i) => {
            let alpha = 1
            let face = (v.p as { facing?: string }).facing || 'south'
            let flip = false
            // something with no life is a stander and never runs a gait
            let gait = false
            if (v.life) {
              /* canStand must be passed to lifeAt, or a wander walks over the sea wall. */
              /* the floor lifeAt reads must not change per frame: it is pure in t, so figures teleport. */
              const s = lifeAt(v.life, t, { x: v.p.x, y: v.p.y }, bareStand)
              pts[i] = { x: v.p.x + s.dx, y: v.p.y + s.dy, r: 3 }
              alpha = s.alpha
              face = s.facing
              flip = s.flip
              // whether the legs should be going THIS instant, which is not the
              // same as whether this thing is capable of moving at all
              gait = s.moving
            }
            return { v, alpha, face, flip, gait, moves: !!v.life }
          })
          /* immovable rows are listed twice, because separate splits a pair's correction in half. */
          const still = [
            ...live.filter((v) => !v.life).map((v) => ({ x: v.p.x, y: v.p.y, r: 3 })),
            { x: px, y: py, r: Math.max(3, hip) },
          ]
          const crowd = [...pts, ...still, ...still]
          /* separate RETURNS the corrections and does not apply them; throwing them away did nothing. */
          const push = separate(crowd, yScale, 1, bareStand)
          for (let i = 0; i < pts.length; i++)
            if (shown[i].moves) pts[i] = { ...pts[i], x: pts[i].x + push[i].dx, y: pts[i].y + push[i].dy }

          /* y here is the sort key and nothing else, the drawn position being read off pts,
           * so the author's nudge belongs in it directly. */
          const order: Array<{ y: number; go: () => void }> = shown.map((s, i) => ({
            y: pts[i].y + zOf(s.v.p),
            go: () => {
              const v = s.v
              const set = v.dirs[s.face] || v.dirs.south
              /* a gait: a stopped figure rests at frame 0, but a frames-only effect plays anyway. */
              const cell = set?.length
                ? s.gait
                  ? set[Math.floor(t * v.fps) % set.length]
                  : set[0]
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
              const set = frames[facing] || frames.south
              if (!set?.length) {
                g.fillStyle = '#ffd66e'
                g.fillRect(ox + px * zoom - zoom, oy + py * zoom - charH * zoom, zoom * 2, charH * zoom)
                return
              }
              const f = moving ? 1 + (Math.floor(stepT * 9) % (set.length - 1)) : 0
              const fr = set[Math.min(f, set.length - 1)]
              /* the 0.7 is the editor's own; a bare charH drew him 1.43 times too big. */
              const ts = (charH * 0.7) / drawnH
              const rows = fr.feet + 1
              const dw = fr.img.width * ts * zoom
              const dh = rows * ts * zoom
              // the editor's contact shadow, which is most of what sells him as
              // standing on the ground rather than hovering over it
              g.save()
              g.fillStyle = 'rgba(6,10,14,0.35)'
              g.beginPath()
              g.ellipse(ox + (px + 1) * zoom, oy + (py - 2) * zoom, 15 * ts * zoom, 5.5 * ts * zoom, 0, 0, 6.284)
              g.fill()
              g.restore()
              g.drawImage(fr.img, 0, 0, fr.img.width, rows, ox + px * zoom - dw / 2, oy + py * zoom - dh, dw, dh)
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
          /* reads the same lvlAt the step test does, so an argument is about a pixel that is named. */
          setAt(`${Math.round(px)},${Math.round(py)} lv ${at(px, py)}${walker.blocked ? ' blocked' : ''}`)
          /* the body list next frame's floor reads, written last, and only the ones that cannot move. */
          solids.length = 0
          for (let i = 0; i < live.length; i++) {
            if (live[i].life) continue
            const b = bodyOf(live[i].p, pts[i].x, pts[i].y, pts[i].r)
            if (b) solids.push(b)
          }
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
        <div className="walk-cam">
          <button
            type="button"
            className={showMask ? 'on' : ''}
            onClick={() => setShowMask((v) => !v)}
            aria-pressed={showMask}
            title="show the ground the step test reads: green is painted, yellow is where a body fits"
          >
            mask
          </button>
        </div>
        <span className={near ? 'on' : ''}>{near || where}</span>
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
