/* SOUND, BEFORE THERE IS ANY SOUND. Not an audio system: the stored preference and the first-gesture unlock, because a browser holds sound until a click and code that finds that out on ship day finds it as a silent bug. Field named `mute` to match the game's own settings blob. */

/* WHETHER ANYTHING HERE CAN MAKE A NOISE. False, checked rather than assumed, and the one line to change when the first sound file lands. Typed boolean so a branch on it stays live code. */
export const SOUND_EXISTS: boolean = false

/* Browser-local, like mapvis:folder-order: it is a preference of the person looking, there is no account-preferences table, and the game keeps the same value the same way. */
const KEY = 'mapvis:sound'

type Stored = { mute: boolean }

let cached: boolean | null = null
const listeners = new Set<(muted: boolean) => void>()

const read = (): boolean => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return false
    const v = JSON.parse(raw) as Partial<Stored>
    return v.mute === true
  } catch {
    // private browsing has no storage, and a browser that cannot remember an
    // answer should default to the one that surprises nobody: sound on.
    return false
  }
}

/* THE ATTRIBUTE IS THE SETTING MADE VISIBLE TO CSS, as data-rm is for reduced motion, so a stylesheet can match it without importing anything and there is one source rather than two. */
const publish = () => {
  if (typeof document === 'undefined') return
  const want = isMuted() ? '1' : ''
  if (document.documentElement.dataset.mute !== want) document.documentElement.dataset.mute = want
}

/** the live value, cheap enough to call on every sound */
export function isMuted(): boolean {
  if (cached === null) cached = read()
  return cached
}

/** what a settings sheet calls when somebody moves the switch */
export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ mute: muted } satisfies Stored))
  } catch {
    // storage refused, so this answer lasts as long as the tab. Still obeyed:
    // a switch that does not stick is a smaller lie than one that does not act.
  }
  if (cached === muted) return
  cached = muted
  publish()
  for (const fn of listeners) fn(muted)
}

/** something already playing subscribes so it can stop, rather than finishing a
 *  sound the person just asked it not to make */
export function onMuted(fn: (muted: boolean) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/* ---- the first-gesture unlock. Browsers refuse audio until a click and fail QUIETLY, so the context sits suspended and nothing comes out. No context is built until something wants one; the listener only records the gesture. pointerdown and keydown only, because pointerdown already covers touch. */
type Ctor = new () => AudioContext
const audioCtor = (): Ctor | null => {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

let gestured = false
let ctx: AudioContext | null = null
let armed = false
const waiting: Array<(c: AudioContext | null) => void> = []
const gestureWatchers = new Set<() => void>()

/* Built inside the gesture handler because Safari wants the resume started in the same task as the click. Null means the browser said no: resume() resolving is not the same as the context running. */
const build = (): Promise<AudioContext | null> => {
  const C = audioCtor()
  if (!C) return Promise.resolve(null)
  if (!ctx) {
    try {
      ctx = new C()
    } catch {
      return Promise.resolve(null)
    }
  }
  const c = ctx
  if (c.state !== 'suspended') return Promise.resolve(c)
  return c.resume().then(
    () => (c.state === 'suspended' ? null : c),
    () => null,
  )
}

const settle = () => {
  if (!waiting.length) return
  const asked = waiting.splice(0)
  void build().then((c) => {
    // still blocked, so put the askers back and wait for another gesture rather
    // than handing out a context that will swallow whatever is played into it
    if (!c) {
      gestured = false
      // unshift and not push, so somebody who asked while the resume was in
      // flight does not get served ahead of whoever was waiting first
      waiting.unshift(...asked)
      arm()
      return
    }
    asked.forEach((fn) => fn(c))
  })
}

const onGesture = () => {
  gestured = true
  disarm()
  settle()
  for (const fn of gestureWatchers) fn()
}

function disarm() {
  if (!armed || typeof window === 'undefined') return
  armed = false
  window.removeEventListener('pointerdown', onGesture, true)
  window.removeEventListener('keydown', onGesture, true)
}

function arm() {
  if (armed || gestured || typeof window === 'undefined') return
  armed = true
  // capture phase, so a component that stops propagation on its own buttons
  // cannot make the whole page look ungestured
  window.addEventListener('pointerdown', onGesture, true)
  window.addEventListener('keydown', onGesture, true)
}

arm()
/* the stored answer has to reach the stylesheets on the first frame, before any
 * settings sheet has been opened, for the same reason motion.ts publishes on
 * load: the first thing that happens must already be obeying the preference */
publish()

/** whether this browser can play audio at all */
export const audioSupported = (): boolean => audioCtor() !== null

/** whether the document has had the click or keypress browsers require before
 *  any sound is allowed through */
export const audioUnblocked = (): boolean => gestured

/** a settings row showing the real state re-renders when it changes */
export function onFirstGesture(fn: () => void): () => void {
  gestureWatchers.add(fn)
  return () => {
    gestureWatchers.delete(fn)
  }
}

/* THE ONE CALL A SOUND MAKES: a context that is allowed to play, or null. Waits for the first gesture rather than returning something suspended. This answers "may I", not "should I". */
export function unlockAudio(): Promise<AudioContext | null> {
  if (!audioCtor()) return Promise.resolve(null)
  return new Promise((resolve) => {
    waiting.push(resolve)
    if (gestured) settle()
    else arm()
  })
}
