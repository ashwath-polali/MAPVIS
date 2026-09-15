/* A router in sixty lines. Seven routes do not justify twenty kilobytes, and hand-rolling keeps the page transition: navigation runs an exit before the next route mounts. */
import { useCallback, useEffect, useRef, useState } from 'react'

export type Route = { path: string; params: Record<string, string>; query: URLSearchParams }

const read = (): Route => ({
  path: window.location.pathname.replace(/\/+$/, '') || '/',
  params: {},
  query: new URLSearchParams(window.location.search),
})

let listeners: Array<() => void> = []
const announce = () => listeners.forEach((f) => f())

/* navigate, absolute paths only, because a relative one in a nested view is how a link ends up pointing at /maps/maps/hub */
export function go(to: string, replace = false) {
  if (to === window.location.pathname + window.location.search) return
  window.history[replace ? 'replaceState' : 'pushState']({}, '', to)
  announce()
}

export function useRoute(): Route {
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = () => setRoute(read())
    listeners.push(on)
    window.addEventListener('popstate', on)
    return () => {
      listeners = listeners.filter((f) => f !== on)
      window.removeEventListener('popstate', on)
    }
  }, [])
  return route
}

/* match /maps/:slug against a pattern and return params or null: exact segments and :names only, no wildcards and no optionals, because anything needing more is two routes */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const q = path.split('/').filter(Boolean)
  if (p.length !== q.length) return null
  const out: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) out[p[i].slice(1)] = decodeURIComponent(q[i])
    else if (p[i] !== q[i]) return null
  }
  return out
}

/* an internal anchor that navigates without a reload, while anything external stays a plain <a> and keeps the browser's own behaviour, including opening in a new tab */
export function Link({
  to,
  children,
  className,
  onClick,
  ...rest
}: { to: string; children: React.ReactNode; className?: string; onClick?: () => void } & Record<string, unknown>) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        // let a middle click, a modified click or a right click do what the browser would do, because stealing those is infuriating
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        onClick?.()
        go(to)
      }}
      {...(rest as object)}
    >
      {children}
    </a>
  )
}

/* scroll to the top on a real navigation but never on a back button, because the browser restores that position itself and fighting it loses the reader's place */
export function useScrollReset(path: string) {
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [path])
}

/* prefetch a map page's manifest on hover, so it is usually there before the click finishes */
const warmed = new Set<string>()
export function useWarm() {
  return useCallback((url: string) => {
    if (warmed.has(url)) return
    warmed.add(url)
    fetch(url).catch(() => {})
  }, [])
}
