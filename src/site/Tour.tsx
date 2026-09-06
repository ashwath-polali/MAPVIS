/* One painted map, and a camera that walks you through it.
 *
 * No scrolling anywhere. The view starts wide on the whole place, then travels
 * to a handful of spots on it, holding at each one while a line of text sits
 * beside what it is describing. The map does not move past you; you move across
 * the map, which is what the tool does to a painting and is the only honest way
 * to advertise it.
 *
 * The camera is the same idea as the walk test: a position and a zoom over a
 * painting, eased. Everything alive on the scene keeps running underneath it on
 * the life data, so the place is not paused while you read.
 */
import { useEffect, useRef, useState } from 'react'
import { cleanLife, lifeAt, separate, type Life } from '../core/life'

export type Stop = {
  /* where on the painting, in painting pixels. Taken from the scene's own
   * anchors, so the tour is authored in MAPVIS rather than in this file. */
  x: number
  y: number
  /* how close. 1 is the whole place; 3 is standing next to something. */
  z: number
  say: string
  /* which side of the point the words sit on, so they never cover it */
  side?: 'left' | 'right'
}

type Placed = {
  id: string
  x: number
  y: number
  scaleX?: number
  scaleY?: number
  scale?: number
  rot?: number
  flipX?: boolean
  flipY?: boolean
  src?: string
  frames?: string[]
  fps?: number
  dirs?: Record<string, string[]>
  life?: unknown
}
type Ready = {
  p: Placed
  life: Life | null
  still?: HTMLImageElement
  frames: HTMLImageElement[]
  dirs: Record<string, HTMLImageElement[]>
  fps: number
}

const img = (src: string) =>
  new Promise<HTMLImageElement | null>((res) => {
    const i = new Image()
    i.crossOrigin = 'anonymous'
    i.onload = () => res(i)
    i.onerror = () => res(null)
    i.src = src
  })

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<unknown>) {
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const k = i++
        if (k >= items.length) return
        await fn(items[k])
      }
    }),
  )
}

/* Eased, and slow at both ends. A camera that starts and stops abruptly reads
 * as a slideshow; one that leans into the move and settles out of it reads as
 * somebody showing you around. */
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/* A hook rather than a component, because the caller needs to drive it: which
 * stop is showing decides which line of text is on screen, and the text is not
 * drawn on the canvas. */
export function useTour({
  slug,
  version,
  stops,
  hold = 4200,
  travel = 1900,
  onStop,
}: {
  slug: string
  version: number
  stops: Stop[]
  hold?: number
  travel?: number
  onStop?: (i: number) => void
}) {
  const mount = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const at = useRef(0)
  const jump = useRef<number | null>(null)

  // the caller can drive the tour; these refs let it without remounting
  const stopsRef = useRef(stops)
  stopsRef.current = stops

  useEffect(() => {
    let dead = false
    let raf = 0
    const base = `/api/v1/maps/${slug}/file/${version}/`

    ;(async () => {
      const meta = await (await fetch(`${base}map.json`)).json()
      const scene = await img(`${base}scene.png`)
      if (dead || !scene || !mount.current) return

      const cv = document.createElement('canvas')
      cv.className = 'tour-canvas'
      mount.current.replaceChildren(cv)
      const g = cv.getContext('2d')!
      setReady(true)

      const live: Ready[] = []
      const t0 = performance.now()

      // where the camera actually is, chasing where it should be
      let cx = meta.w / 2
      let cy = meta.h / 2
      let cz = 1
      let legStart = t0
      let from = { x: cx, y: cy, z: cz }

      const draw = (now: number) => {
        if (dead) return
        const box = mount.current!.getBoundingClientRect()
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        if (cv.width !== Math.round(box.width * dpr)) {
          cv.width = Math.round(box.width * dpr)
          cv.height = Math.round(box.height * dpr)
          cv.style.width = box.width + 'px'
          cv.style.height = box.height + 'px'
        }

        const list = stopsRef.current
        const target = list[at.current] || { x: meta.w / 2, y: meta.h / 2, z: 1 }
        const since = now - legStart
        if (jump.current != null) {
          at.current = jump.current
          jump.current = null
          from = { x: cx, y: cy, z: cz }
          legStart = now
          onStop?.(at.current)
        } else if (since > travel + hold && list.length > 1) {
          at.current = (at.current + 1) % list.length
          from = { x: cx, y: cy, z: cz }
          legStart = now
          onStop?.(at.current)
        }
        const k = ease(Math.min(1, since / travel))
        cx = from.x + (target.x - from.x) * k
        cy = from.y + (target.y - from.y) * k
        cz = from.z + (target.z - from.z) * k

        // base zoom fits the painting to the window, then the stop multiplies
        const fit = Math.max(box.width / meta.w, box.height / meta.h)
        const z = fit * cz
        const ox = box.width / 2 - cx * z
        const oy = box.height / 2 - cy * z

        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.imageSmoothingEnabled = false
        g.clearRect(0, 0, box.width, box.height)
        g.drawImage(scene, ox, oy, meta.w * z, meta.h * z)

        const t = (now - t0) / 1000
        const pts: Array<{ x: number; y: number; r: number }> = []
        const frame: Array<{ r: Ready; x: number; y: number; a: number; face: string; flip: boolean }> = []
        for (const r of live) {
          let dx = 0
          let dy = 0
          let alpha = 1
          let face = 'south'
          let flip = false
          if (r.life) {
            const s = lifeAt(r.life, t, { x: r.p.x, y: r.p.y })
            dx = s.dx
            dy = s.dy
            alpha = s.alpha
            face = s.facing
            flip = s.flip
          }
          frame.push({ r, x: r.p.x + dx, y: r.p.y + dy, a: alpha, face, flip })
          pts.push({ x: r.p.x + dx, y: r.p.y + dy, r: 3 })
        }
        separate(pts, meta.yScale ?? 0.72, 1)
        frame.forEach((f, i) => {
          f.x = pts[i].x
          f.y = pts[i].y
        })
        frame.sort((a, b) => a.y - b.y)

        for (const f of frame) {
          const r = f.r
          const set = r.dirs[f.face] || r.dirs.south
          const pic = set?.length
            ? set[Math.floor(t * r.fps) % set.length]
            : r.frames.length
              ? r.frames[Math.floor(t * r.fps) % r.frames.length]
              : r.still
          if (!pic) continue
          const sx = (r.p.scaleX ?? r.p.scale ?? 1) * z
          const sy = (r.p.scaleY ?? r.p.scale ?? 1) * z
          g.save()
          g.globalAlpha = f.a
          g.translate(ox + f.x * z, oy + f.y * z)
          if (r.p.rot) g.rotate(r.p.rot)
          g.scale((r.p.flipX ? -1 : 1) * (set ? 1 : f.flip ? -1 : 1), r.p.flipY ? -1 : 1)
          g.drawImage(pic, (-pic.width * sx) / 2, -pic.height * sy, pic.width * sx, pic.height * sy)
          g.restore()
        }
        raf = requestAnimationFrame(draw)
      }
      raf = requestAnimationFrame(draw)

      const placed: Placed[] = (await (await fetch(`${base}assets.json`)).json()).assets || []
      await pool(
        [...placed].sort((a, b) => (b.life ? 1 : 0) - (a.life ? 1 : 0)),
        8,
        async (p) => {
          if (dead) return
          const r: Ready = { p, life: cleanLife(p.life), frames: [], dirs: {}, fps: p.fps || 6 }
          if (p.dirs)
            for (const [kk, urls] of Object.entries(p.dirs)) {
              const s = (await Promise.all(urls.map((u) => img(base + u)))).filter(Boolean) as HTMLImageElement[]
              if (s.length) r.dirs[kk] = s
            }
          if (p.frames)
            r.frames = (await Promise.all(p.frames.map((u) => img(base + u)))).filter(Boolean) as HTMLImageElement[]
          if (p.src) r.still = (await img(base + p.src)) || undefined
          if (r.still || r.frames.length || Object.keys(r.dirs).length) live.push(r)
        },
      )
    })()

    return () => {
      dead = true
      cancelAnimationFrame(raf)
    }
  }, [slug, version, hold, travel, onStop])

  return {
    view: <div className={'tour-view' + (ready ? ' ready' : '')} ref={mount} aria-hidden />,
    goTo: (i: number) => {
      jump.current = i
    },
  }
}
