/* A published map, alive, filling the screen.
 *
 * Not a picture of an island. The island: the painting, plus all 94 placements
 * moving on the same life data the game runs, on the same evaluator, so the
 * people walk their real routes and the waterfalls fall at their real rate.
 *
 * This is the whole answer to "what should the site look like". The product
 * already knows how to make a place breathe, so the site is a place breathing
 * rather than a page describing one. No layout tropes, nothing to mistake for a
 * template, and no art to commission because the art already exists.
 *
 * It arrives in the right order on purpose: the painting lands first and looks
 * finished, then over the next second or two the placements load and the island
 * starts moving. That is not a loading state to apologise for, it is the thing
 * waking up.
 */
import { useEffect, useRef, useState } from 'react'
import { cleanLife, lifeAt, separate, type Life } from '../core/life'

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

/* Fetch with a ceiling on how many are in flight. A bundle is eight hundred
 * small pngs and firing them all at once buries the first paint under its own
 * tail. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>) {
  const out: R[] = []
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const k = i++
        if (k >= items.length) return
        out[k] = await fn(items[k])
      }
    }),
  )
  return out
}

export function LivingMap({
  slug,
  version,
  fill = 'cover',
  drift = true,
}: {
  slug: string
  version: number
  fill?: 'cover' | 'contain'
  drift?: boolean
}) {
  const mount = useRef<HTMLDivElement>(null)
  const [awake, setAwake] = useState(false)

  useEffect(() => {
    let dead = false
    let raf = 0
    const base = `/api/v1/maps/${slug}/file/${version}/`

    ;(async () => {
      const meta = await (await fetch(`${base}map.json`)).json()
      const scene = await img(`${base}scene.png`)
      if (dead || !scene || !mount.current) return

      const cv = document.createElement('canvas')
      cv.className = 'living-canvas'
      mount.current.replaceChildren(cv)
      const g = cv.getContext('2d')!

      /* FRAME THE ISLAND, NOT THE CANVAS.
       *
       * A painting is grown with transparent margin so the map can spread, so
       * the hub is 688x640 with land only in the middle of it. Fitting the
       * canvas puts the island in a box of empty black and reads as a picture
       * pasted on a page, which is the exact thing this screen exists to avoid.
       * So the opaque pixels are measured once and everything is framed on
       * those. */
      const land = (() => {
        const c = document.createElement('canvas')
        c.width = meta.w
        c.height = meta.h
        const cg = c.getContext('2d', { willReadFrequently: true })!
        cg.drawImage(scene, 0, 0)
        const d = cg.getImageData(0, 0, meta.w, meta.h).data
        let x0 = meta.w
        let y0 = meta.h
        let x1 = 0
        let y1 = 0
        for (let y = 0; y < meta.h; y++)
          for (let x = 0; x < meta.w; x++)
            if (d[(y * meta.w + x) * 4 + 3] > 8) {
              if (x < x0) x0 = x
              if (y < y0) y0 = y
              if (x > x1) x1 = x
              if (y > y1) y1 = y
            }
        return x1 > x0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w: meta.w, h: meta.h }
      })()

      const live: Ready[] = []
      let px = 0
      let py = 0
      const t0 = performance.now()

      const draw = (now: number) => {
        if (dead) return
        const box = mount.current!.getBoundingClientRect()
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        // integer zoom, always: a painted pixel must land on whole screen
        // pixels or the whole thing turns to mush
        const pick = fill === 'cover' ? Math.max : Math.min
        // measured against the LAND, so a painting with a lot of transparent
        // margin still arrives filling the window
        const z = Math.max(1, Math.round(pick(box.width / land.w, box.height / land.h)))
        const w = meta.w * z
        const h = meta.h * z
        if (cv.width !== Math.round(box.width * dpr)) {
          cv.width = Math.round(box.width * dpr)
          cv.height = Math.round(box.height * dpr)
          cv.style.width = box.width + 'px'
          cv.style.height = box.height + 'px'
        }
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.imageSmoothingEnabled = false
        g.clearRect(0, 0, box.width, box.height)

        // the island breathes very slowly across the frame. Slow enough that
        // nobody catches it moving, fast enough that the screen is never still.
        const t = (now - t0) / 1000
        const wob = drift ? { x: Math.sin(t * 0.06) * 14, y: Math.cos(t * 0.045) * 9 } : { x: 0, y: 0 }
        // centre the LAND in the window, not the canvas the land sits inside
        const ox = box.width / 2 - (land.x + land.w / 2) * z + wob.x + px
        const oy = box.height / 2 - (land.y + land.h / 2) * z + wob.y + py

        g.drawImage(scene, ox, oy, w, h)

        // every placement, y-sorted so a figure in front of a hut is in front
        const now2 = t
        const pts: Array<{ x: number; y: number; r: number }> = []
        const frame: Array<{ r: Ready; x: number; y: number; a: number; face: string; flip: boolean; moving: boolean }> = []
        for (const r of live) {
          let dx = 0
          let dy = 0
          let alpha = 1
          let face = 'south'
          let flip = false
          /* NO BEHAVIOUR IS NOT MOVING, and it used to read as moving here by
           * never being asked. `lifeAt` has always answered this. */
          let moving = false
          if (r.life) {
            const at = lifeAt(r.life, now2, { x: r.p.x, y: r.p.y })
            dx = at.dx
            dy = at.dy
            alpha = at.alpha
            face = at.facing
            flip = at.flip
            moving = at.moving
          }
          frame.push({ r, x: r.p.x + dx, y: r.p.y + dy, a: alpha, face, flip, moving })
          pts.push({ x: r.p.x + dx, y: r.p.y + dy, r: 3 })
        }
        // the same push-apart the editor and the game use, so a crowd here
        // stands the way it stands there
        separate(pts, meta.yScale ?? 0.72, 1)
        frame.forEach((f, i) => {
          f.x = pts[i].x
          f.y = pts[i].y
        })
        frame.sort((a, b) => a.y - b.y)

        for (const f of frame) {
          const r = f.r
          let pic: HTMLImageElement | undefined
          /* A WALK CYCLE IS A GAIT, so it runs only while the figure travels.
           * Cycling it off the wall clock made every standing figure stride on
           * the spot, and a placement with no life at all never stopped. Frame 0
           * is the resting pose every heading set is drawn from. Same rule as
           * editor.ts, Walk.tsx and the game's own PmapScene. */
          const set = r.dirs[f.face] || r.dirs.south
          if (set && set.length) pic = set[f.moving ? Math.floor(now2 * r.fps) % set.length : 0]
          else if (r.frames.length) pic = r.frames[Math.floor(now2 * r.fps) % r.frames.length]
          else pic = r.still
          if (!pic) continue

          const sx = (r.p.scaleX ?? r.p.scale ?? 1) * z
          const sy = (r.p.scaleY ?? r.p.scale ?? 1) * z
          g.save()
          g.globalAlpha = f.a
          g.translate(ox + f.x * z, oy + f.y * z)
          if (r.p.rot) g.rotate(r.p.rot)
          const mirror = (r.p.flipX ? -1 : 1) * (set ? 1 : f.flip ? -1 : 1)
          g.scale(mirror, r.p.flipY ? -1 : 1)
          // anchored at the feet, the way every placement in this project is
          g.drawImage(pic, (-pic.width * sx) / 2, -pic.height * sy, pic.width * sx, pic.height * sy)
          g.restore()
        }

        raf = requestAnimationFrame(draw)
      }
      raf = requestAnimationFrame(draw)

      // pointer parallax, gentle, applied to the whole island rather than to
      // layers, because the island IS one painting
      const onMove = (e: PointerEvent) => {
        if (!drift) return
        px = (e.clientX / window.innerWidth - 0.5) * -26
        py = (e.clientY / window.innerHeight - 0.5) * -16
      }
      window.addEventListener('pointermove', onMove, { passive: true })

      // now wake it up. Placements that move come first, so the island starts
      // living before it finishes furnishing.
      const list: Placed[] = (await (await fetch(`${base}assets.json`)).json()).assets || []
      const order = [...list].sort((a, b) => (b.life ? 1 : 0) - (a.life ? 1 : 0))
      await pool(order, 8, async (p) => {
        if (dead) return null
        const r: Ready = { p, life: cleanLife(p.life), frames: [], dirs: {}, fps: p.fps || 6 }
        if (p.dirs) {
          for (const [k, urls] of Object.entries(p.dirs)) {
            const set = (await Promise.all(urls.map((u) => img(base + u)))).filter(Boolean) as HTMLImageElement[]
            if (set.length) r.dirs[k] = set
          }
        }
        if (p.frames) r.frames = (await Promise.all(p.frames.map((u) => img(base + u)))).filter(Boolean) as HTMLImageElement[]
        if (p.src) r.still = (await img(base + p.src)) || undefined
        if (r.still || r.frames.length || Object.keys(r.dirs).length) live.push(r)
        if (!dead) setAwake(true)
        return null
      })

      return () => window.removeEventListener('pointermove', onMove)
    })()

    return () => {
      dead = true
      cancelAnimationFrame(raf)
    }
  }, [slug, version, fill, drift])

  return <div className={'living' + (awake ? ' awake' : '')} ref={mount} aria-hidden />
}
