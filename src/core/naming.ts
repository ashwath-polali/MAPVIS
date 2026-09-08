/* WHAT A HUMAN READS. The name/label split exists in the data and every surface ignored it, printing `the_hub` and `panthers_maw` at people. Returns a `derived` flag saying the words were guessed from an identifier rather than typed. */

/* the words that stay upper when a name is unpacked. Every one of these is a
 * thing this project actually says out loud, and "Atc Room" reads as a typo. */
const SHOUTED = new Set([
  'atc',
  'blhs',
  'ap',
  'ib',
  'frc',
  'npc',
  'ui',
  'hud',
  'id',
  'gpa',
  'sat',
  'stem',
  'asb',
  'pe',
  'tv',
  'dj',
])

/* short words that stay lower inside a name, the way a title does. First and
 * last word are exempt, because "The Maw Of Panthers" is not how anybody
 * writes it and neither is "of the maw". */
const QUIET = new Set(['a', 'an', 'and', 'at', 'by', 'de', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs'])

/* An identifier unpacked into words. Both separators, because an anchor name is snake_case and a map id is kebab and a person should not have to know which they are looking at. A run of digits is never title-cased. */
export function humanise(name: string): string {
  const words = String(name || '')
    .replace(/[_\-.]+/g, ' ')
    // camelCase and PascalCase get a space too, because a member will write one
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // a number glued to letters is its own word
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return ''
  return words
    .map((w, i) => {
      const low = w.toLowerCase()
      if (SHOUTED.has(low)) return low.toUpperCase()
      if (/^\d+$/.test(w)) return w
      if (i > 0 && i < words.length - 1 && QUIET.has(low)) return low
      return low.charAt(0).toUpperCase() + low.slice(1)
    })
    .join(' ')
}

/* anything a person might have to read. Every field optional so a caller passes the object it already has. `title` sits beside `label` because the ocean spells it one way and a mark the other. */
export interface Nameable {
  name?: string | null
  label?: string | null
  title?: string | null
}

export interface Readable {
  /* what to put on screen */
  text: string
  /* true when nobody typed this and it was unpacked from the identifier. The
     same word src/core/mask.ts stamps on an anchor name it had to invent. */
  derived: boolean
  /* the identifier itself, so a surface can still show it as a monospace aside
     next to the words without reaching back into the object */
  name: string
}

/* THE ONE HELPER; nothing else formats a name. A plain string is the same as { name }, because half the call sites hold an id. `fallback` covers a slot that exists before it is named, and comes back derived. */
/* the shape of a string with nothing to say about it: no case, no separators.
 * Used to catch a title that is only the identifier wearing a hat. */
const bare = (s: string) => s.toLowerCase().replace(/[\s_\-.]+/g, '')

export function displayName(thing: Nameable | string | null | undefined, fallback = 'untitled'): Readable {
  const o: Nameable = typeof thing === 'string' ? { name: thing } : thing || {}
  const name = String(o.name || '').trim()
  // label first, then title. A thing carrying both is carrying one of them by
  // accident, and label is the newer field and the one the game reads.
  const typed = String(o.label || o.title || '').trim()
  /* A TITLE THAT IS THE IDENTIFIER WAS NOT TYPED BY ANYBODY: maps.title is machine-filled with the slug, so the dashboard printed a kebab id as a heading with derived:false. */
  if (typed && bare(typed) !== bare(name)) return { text: typed, derived: false, name }
  const guessed = humanise(typed || name)
  if (guessed) return { text: guessed, derived: true, name }
  return { text: fallback, derived: true, name }
}

/* sugar for the common case, which is JSX that wants a string and has no room
 * for a destructure. It exists so that `{displayName(a).text}` never gets
 * shortened to `{a.name}` by somebody in a hurry. */
export const readable = (thing: Nameable | string | null | undefined, fallback?: string): string =>
  displayName(thing, fallback).text
