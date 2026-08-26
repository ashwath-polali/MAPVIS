/* WALK IT HERE.
 *
 * A published bundle, standing up and playable, in the browser, on the exact
 * collision the game will use. No engine, no Pixi, no bundle of dependencies:
 * one canvas, the painting, and the levels png read per pixel.
 *
 * This is the same walk law the game applies, so what happens here is what
 * happens there. The point is not a demo. It is that nobody should ever again
 * find out a map is wrong AFTER exporting it, which is how this project spent
 * two months.
 *
 * The encoding, from map.json: 0 blocked, 40 L0, 50 ramp 0-1, 60 L1, 70 ramp
 * 1-2, 80 L2, 90 ramp 2-3, 100 L3. A step is legal when the difference is
 * stepTolerance or less, so two plateaus only connect through a painted stair.
 */
import { useEffect, useRef, useState } from 'react'

type Pmap = {
  w: number
  h: number
  spawn: [number, number]
  speed: number
  yScale: number
  character: { heightPx: number; hip: number; hipDY: number }
  encoding: { blocked: number; stepTolerance: number }
  anchors?: Array<{ name: string; kind: string; x: number; y: number; r?: number; label?: string; to?: string }>
}

export function Walk({ slug, version }: { slug: string; version: number }) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'failed'>('idle')
  const [near, setNear] = useState<string>('')
  const [why, setWhy] = useState('')

  useEffect(() => {
    if (state !== 'loading') return
    let stop = false
    let raf = 0
    const keys = new Set<string>()

    const onDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault()
      keys.add(e.key.toLowerCase())
    }
    const onUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase())

    ;(async () => {
      try {
        const base = `/api/v1/maps/${slug}/file/${version}/`
        const meta: Pmap = await (await fetch(`${base}map.json`)).json()
        const [scene, levels] = await Promise.all([load(`${base}scene.png`), load(`${base}levels.png`)])
        if (stop) return

        // the levels plane, read once into a flat byte array. Reading a canvas
        // per frame would be a readback stall on every single step.
        const lc = document.createElement('canvas')
        lc.width = meta.w
        lc.height = meta.h
        const lg = lc.getContext('2d', { willReadFrequently: true })!
        lg.drawImage(levels, 0, 0)
        const lv = lg.getImageData(0, 0, meta.w, meta.h).data
        const at = (x: number, y: number) =>
          x < 0 || y < 0 || x >= meta.w || y >= meta.h ? 0 : lv[((y | 0) * meta.w + (x | 0)) * 4]

        /* The canvas goes into a div React never renders children into.
         *
         * It used to go straight into the stage, which React DOES render into,
         * cleared with innerHTML = ''. That deletes nodes React still believes
         * it owns, and the next render throws while trying to remove one, which
         * white-screened the whole app rather than just this panel. Anything
         * imperative needs its own patch of DOM. */
        const el = host.current!
        const cv = document.createElement('canvas')
        cv.className = 'walk-canvas'
        el.replaceChildren(cv)
        const g = cv.getContext('2d')!

        let px = meta.spawn[0]
        let py = meta.spawn[1]
        const tol = meta.encoding?.stepTolerance ?? 10
        const speed = meta.speed || 34
        const yScale = meta.yScale ?? 0.72
        const hip = meta.character?.hip ?? 2

        // can the feet stand here? The hip band is what the game tests, so a
        // figure never balances on a single legal pixel under one foot.
        const standable = (x: number, y: number) => {
          const here = at(x, y)
          if (here <= (meta.encoding?.blocked ?? 0)) return false
          for (let dx = -hip; dx <= hip; dx++) {
            const v = at(x + dx, y)
            if (v <= 0) return false
            if (Math.abs(v - here) > tol) return false
          }
          return true
        }

        let last = performance.now()
        const frame = (now: number) => {
          if (stop) return
          const dt = Math.min(0.05, (now - last) / 1000)
          last = now

          let ax = 0
          let ay = 0
          if (keys.has('a') || keys.has('arrowleft')) ax -= 1
          if (keys.has('d') || keys.has('arrowright')) ax += 1
          if (keys.has('w') || keys.has('arrowup')) ay -= 1
          if (keys.has('s') || keys.has('arrowdown')) ay += 1
          if (ax || ay) {
            const m = Math.hypot(ax, ay) || 1
            // y moves slower because the painted ground is foreshortened, which
            // is the same yScale the game applies
            const nx = px + (ax / m) * speed * dt
            const ny = py + (ay / m) * speed * dt * yScale
            // axes resolved separately so a wall stops you sliding along it
            if (standable(nx, py)) px = nx
            if (standable(px, ny)) py = ny
          }

          // fit the painting to the box at an integer zoom, the way the game does
          const box = (el.parentElement || el).getBoundingClientRect()
          const z = Math.max(1, Math.floor(Math.min(box.width / meta.w, box.height / meta.h)))
          cv.width = meta.w * z
          cv.height = meta.h * z
          g.imageSmoothingEnabled = false
          g.drawImage(scene, 0, 0, cv.width, cv.height)

          // the figure: a plain mark, because this is about where you can go
          g.fillStyle = '#f0c869'
          g.strokeStyle = '#0a0e14'
          g.lineWidth = Math.max(1, z)
          const cx = px * z
          const cy = py * z
          g.beginPath()
          g.ellipse(cx, cy, 2.4 * z, 1.4 * z, 0, 0, Math.PI * 2)
          g.fill()
          g.stroke()
          g.fillRect(cx - 1.2 * z, cy - 9 * z, 2.4 * z, 9 * z)

          // named places, drawn as survey marks, and the nearest one announced
          let closest = ''
          let best = 1e9
          for (const a of meta.anchors || []) {
            const r = a.r || 14
            const d = Math.hypot(a.x - px, (a.y - py) / yScale)
            const hot = d < r
            g.strokeStyle = hot ? '#f0c869' : 'rgba(212,165,60,.45)'
            g.lineWidth = 1
            g.beginPath()
            g.arc(a.x * z, a.y * z, r * z * 0.5, 0, Math.PI * 2)
            g.stroke()
            if (hot && d < best) {
              best = d
              closest = a.to ? `${a.label || a.name} → ${a.to}` : a.name
            }
          }
          setNear(closest)

          raf = requestAnimationFrame(frame)
        }
        raf = requestAnimationFrame(frame)
        window.addEventListener('keydown', onDown)
        window.addEventListener('keyup', onUp)
        el.focus()
        setState('playing')
      } catch (e) {
        setWhy(String((e as Error).message))
        setState('failed')
      }
    })()

    return () => {
      stop = true
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [state, slug, version])

  return (
    <div className="walk">
      <div className="walk-stage" tabIndex={0}>
        {/* imperative territory: react renders nothing in here, ever */}
        <div className="walk-mount" ref={host} />
        {state === 'idle' && (
          <button className="walk-start" onClick={() => setState('loading')}>
            <span className="walk-tri" aria-hidden />
            <span className="label">walk it</span>
            <span className="aside">right here, on the collision the game uses</span>
          </button>
        )}
        {state === 'loading' && <div className="walk-load label">standing up the island</div>}
        {state === 'failed' && <div className="walk-load wax">it would not load · {why}</div>}
      </div>
      {state === 'playing' && (
        <div className="walk-bar">
          <span className="mono">wasd or arrows</span>
          <span className={'walk-near mono' + (near ? ' on' : '')}>{near || 'walk into a named place'}</span>
        </div>
      )}
    </div>
  )
}

const load = (src: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image()
    i.crossOrigin = 'anonymous'
    i.onload = () => res(i)
    i.onerror = () => rej(new Error(`could not load ${src.split('/').pop()}`))
    i.src = src
  })
