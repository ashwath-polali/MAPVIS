/* Who is signed in, asked once for the whole app: a tiny store with subscribers rather than a hook that refetches per mount. Context would mean wrapping the editor, which knows nothing about accounts and should keep not knowing. */
import { useEffect, useState } from 'react'

export type User = {
  id: string
  email: string
  display_name: string
  claude_provider: 'key' | 'relay' | 'none'
  pixellab_provider: 'key' | 'relay' | 'none'
  has_claude_key: boolean
  has_pixellab_key: boolean
}
export type Spend = { provider: string; endpoint: string; n: number; total: number }

type State = { user: User | null; spend: Spend[]; loading: boolean }

let state: State = { user: null, spend: [], loading: true }
let subs: Array<() => void> = []
let asked = false

const set = (next: Partial<State>) => {
  state = { ...state, ...next }
  subs.forEach((f) => f())
}

export async function refreshSession() {
  try {
    const r = await fetch('/api/me')
    const j = await r.json()
    set({ user: j.user || null, spend: j.spend || [], loading: false })
  } catch {
    // an unreachable server is signed out, not an error page. The tool still
    // works without an account and always will.
    set({ user: null, spend: [], loading: false })
  }
}

export function useSession() {
  const [, bump] = useState(0)
  useEffect(() => {
    const on = () => bump((n) => n + 1)
    subs.push(on)
    if (!asked) {
      asked = true
      void refreshSession()
    }
    return () => {
      subs = subs.filter((f) => f !== on)
    }
  }, [])
  return state
}

const post = async (path: string, body?: unknown) => {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `that did not work (${r.status})`)
  return j
}

export const signUp = async (email: string, password: string, displayName: string) => {
  const j = await post('/api/auth/signup', { email, password, displayName })
  set({ user: j.user, loading: false })
  return j.user as User
}

export const signIn = async (email: string, password: string) => {
  const j = await post('/api/auth/login', { email, password })
  set({ user: j.user, loading: false })
  return j.user as User
}

export const signOut = async () => {
  await post('/api/auth/logout')
  set({ user: null, spend: [] })
}

export const setProvider = async (service: 'claude' | 'pixellab', mode: 'key' | 'relay' | 'none', key?: string) => {
  const j = await post('/api/auth/provider', { service, mode, key })
  set({ user: j.user })
  return j.user as User
}

export const makeRelayToken = (name: string) => post('/api/auth/relay-token', { name })

/* What this account can and cannot do, in one place, so somebody learns a feature needs a key BEFORE they press it. That is the difference between degraded and broken. */
export function can(user: User | null) {
  const claude = !user ? 'local' : user.claude_provider === 'none' ? 'no' : user.claude_provider
  const pixellab = !user ? 'local' : user.pixellab_provider === 'none' ? 'no' : user.pixellab_provider
  return {
    generate: pixellab !== 'no',
    interpret: claude !== 'no',
    // everything the tool does for free, forever, and it is most of it
    draw: true,
    claude,
    pixellab,
  }
}
