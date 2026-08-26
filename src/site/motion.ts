/* Reactivity without a library.
 *
 * Everything here writes a custom property or toggles a class and nothing
 * animates from javascript, so the browser keeps the work on the compositor and
 * a Chromebook does not drop frames rendering a landing page.
 */
import { useEffect, useRef, useState } from 'react'

/* Reveal on arrival. One shared observer for the whole page rather than one per
 * element, because a landing page has a hundred of these and a hundred
 * observers is a hundred callbacks on every scroll. */
let io: IntersectionObserver | null = null
const seen = new WeakSet<Element>()

function observer() {
  if (io) return io
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting || seen.has(e.target)) continue
        seen.add(e.target)
        e.target.classList.add('seen')
        io!.unobserve(e.target)
      }
    },
    // fire a little before the element is fully in view, so it has finished
    // resolving by the time the reader's eye actually reaches it
    { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
  )
  return io
}

export function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('seen')
      return
    }
    observer().observe(el)
    return () => observer().unobserve(el)
  }, [])
  return ref
}

/* Pointer parallax. Writes --px and --py in the range -1..1 onto one element,
 * and every layer inside reads them at its own depth via --par. One listener,
 * one write per frame, and the transform itself is pure CSS.
 *
 * The damping is what makes it feel like a heavy sheet of paper rather than a
 * mouse-follower: the target moves instantly, the value chases it. */
export function usePointer<T extends HTMLElement = HTMLDivElement>(strength = 1) {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let tx = 0
    let ty = 0
    let x = 0
    let y = 0
    let raf = 0
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      tx = ((e.clientX - r.left) / r.width - 0.5) * 2 * strength
      ty = ((e.clientY - r.top) / r.height - 0.5) * 2 * strength
    }
    const leave = () => {
      tx = 0
      ty = 0
    }
    const tick = () => {
      x += (tx - x) * 0.06
      y += (ty - y) * 0.06
      el.style.setProperty('--px', x.toFixed(4))
      el.style.setProperty('--py', y.toFixed(4))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerleave', leave)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerleave', leave)
    }
  }, [strength])
  return ref
}

/* How far down the page we are, 0..1, written as --scroll on <html> so any
 * rule anywhere can read it. Used by the compass needle and the sea. */
export function useScrollProgress() {
  useEffect(() => {
    let raf = 0
    const on = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const h = document.documentElement.scrollHeight - window.innerHeight
        const p = h > 0 ? window.scrollY / h : 0
        document.documentElement.style.setProperty('--scroll', p.toFixed(4))
        document.documentElement.style.setProperty('--scrolled', window.scrollY > 40 ? '1' : '0')
      })
    }
    on()
    window.addEventListener('scroll', on, { passive: true })
    window.addEventListener('resize', on)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', on)
      window.removeEventListener('resize', on)
    }
  }, [])
}

/* Type it out, the way a name gets written onto a chart. Used sparingly: on the
 * hero line and nowhere else, because a page where everything types is a page
 * nobody can read. */
export function useTyped(text: string, on: boolean, speed = 34) {
  const [out, setOut] = useState('')
  useEffect(() => {
    if (!on) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setOut(text)
      return
    }
    let i = 0
    const t = setInterval(() => {
      i++
      setOut(text.slice(0, i))
      if (i >= text.length) clearInterval(t)
    }, speed)
    return () => clearInterval(t)
  }, [text, on, speed])
  return out
}

/* The grain. Generated once into a data url rather than shipped as a file, so
 * there is no request and no asset to lose. Real paper and real water are never
 * flat, and this is the cheapest thing that says so. */
export function installGrain() {
  if (document.documentElement.style.getPropertyValue('--grain-url')) return
  const n = 180
  const c = document.createElement('canvas')
  c.width = c.height = n
  const g = c.getContext('2d')!
  const img = g.createImageData(n, n)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() * 2 - 1) * 42
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  g.putImageData(img, 0, 0)
  document.documentElement.style.setProperty('--grain-url', `url(${c.toDataURL('image/png')})`)
}
