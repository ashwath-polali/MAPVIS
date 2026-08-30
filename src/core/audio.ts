/* SOUND, BEFORE THERE IS ANY SOUND.
 *
 * Measured 2026-08-30, in both repos: there is no audio anywhere. No
 * `AudioContext`, no `new Audio`, no `<audio>` element, and no mp3, ogg or wav
 * under either `public/`. The game's own capability harvest says the same thing
 * twice, at 60-capabilities.md U1 and at 80-substrates.md 80.5, and U3 adds the
 * rule this file is built around: a control that reports a state it does not
 * deliver is worse than no control.
 *
 * So this is deliberately NOT an audio system. It is the two things a mute
 * switch needs to be honest instead of decorative:
 *
 *   1. the preference, stored and served, so the first thing that ever plays a
 *      sound reads it rather than inventing its own default, and
 *   2. the first-gesture unlock, because a browser holds sound until a person
 *      clicks or types and code that discovers that on the day it ships a sound
 *      discovers it as a silent bug.
 *
 * CONSUMER-CANONICAL. The running game already owns the shape: `Settings` at
 * AdventureGame/src/app/SettingsPanel.tsx:16 is `{ mute, textSize,
 * reducedMotion, skin }`, stored as JSON under `blhs_settings_v1`. The field is
 * `mute` and it is a boolean, so that is the field and the type here too, even
 * though a different origin means MAPVIS cannot write the game's key. Getting
 * this wrong costs a rename in two repos later; getting it right costs nothing
 * now. Anything added here goes in as a sibling of `mute`, so merging the two
 * stores one day is a spread and not a translation.
 *
 * THE SHAPE OF THIS FILE IS AdventureGame/src/game/ui/motion.ts, on purpose.
 * That file is the same problem already solved for reduced motion: a value the
 * renderer can read, published to an attribute the stylesheets can match, with
 * a subscription so something mid-work can change its mind. Sound gets the same
 * treatment rather than a second idiom, and like src/core/life.ts this file is
 * written to be copied verbatim into the game rather than reimplemented.
 */

/* WHETHER ANYTHING IN THIS PROJECT CAN MAKE A NOISE. It is false, it is checked
 * rather than assumed (the grep above), and it is the one line to change when
 * the first sound file lands. Every surface asking "should I tell the person
 * this switch does nothing" asks this, so the day sound exists no copy anywhere
 * is left claiming otherwise. Typed `boolean` and not the literal so a branch
 * on it is live code rather than something the compiler narrows away. */
export const SOUND_EXISTS: boolean = false

/* mapvis:folder-order in src/site/Home.tsx is the existing idiom for a
 * preference of the person looking rather than a property of the thing looked
 * at, and there is no account-preferences table on the server to put this in:
 * server/db/001_schema.sql's users row carries an email, a password and two
 * provider modes, and nothing else. Browser-local is where it belongs and it is
 * also where the game keeps the same value. */
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

/* THE ATTRIBUTE IS THE SETTING MADE VISIBLE TO CSS, exactly as `data-rm` is for
 * reduced motion, so a stylesheet can hide or dim a sound affordance without
 * importing anything and there is one source rather than two that agree most of
 * the time. Nothing matches on it today; it is written now so that whatever
 * matches on it later is matching the same boolean the code reads. */
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

/* ---- the first-gesture unlock ---------------------------------------------
 *
 * Chrome, Safari and Firefox all refuse to start audio until the document has
 * been clicked or typed into, and the failure is quiet: the context is created,
 * it sits in state 'suspended', the sound is scheduled, and nothing comes out.
 * Whoever adds the first sound should not have to find that out.
 *
 * NO CONTEXT IS CREATED UNTIL SOMETHING ACTUALLY WANTS ONE. An AudioContext is
 * a real audio graph and a live thread, and today it would be spent producing
 * silence on a 4 GB school Chromebook. So the listener below only records that
 * the gesture happened; `unlockAudio` is what builds the thing, and if nobody
 * ever calls it the cost of this file is one listener that removes itself.
 *
 * pointerdown and keydown only. touchstart is not in the list because
 * pointerdown covers touch on every browser this ships to, and adding it means
 * two events firing for one finger. */
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

/* Built inside the gesture handler when anybody is waiting, because Safari has
 * historically wanted the resume STARTED in the same task as the click and not
 * merely after one. Chrome is happy either way. So the construction and the
 * `resume()` call are synchronous here and only the answer is awaited.
 *
 * Null means the browser said no. That matters: `resume()` resolving is not the
 * same as the context running, and a context handed back still suspended is
 * exactly the silent failure this whole file exists to stop, so it is reported
 * as a refusal and the next gesture gets another go. */
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

/* THE ONE CALL A SOUND MAKES. Resolves with a context that is allowed to play,
 * or null on a browser with no audio at all, and waits for the first gesture if
 * it has not happened yet rather than returning something suspended. Callers
 * still check `isMuted()`: this answers "may I", not "should I". */
export function unlockAudio(): Promise<AudioContext | null> {
  if (!audioCtor()) return Promise.resolve(null)
  return new Promise((resolve) => {
    waiting.push(resolve)
    if (gestured) settle()
    else arm()
  })
}
