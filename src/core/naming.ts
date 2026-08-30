/* WHAT A HUMAN READS, given a thing that also has a name code addresses it by.
 *
 * THE SPLIT ALREADY EXISTS IN THE DATA and every surface was ignoring it. A
 * MapAnchor carries `name` and `label`, a place on the ocean carries `name` and
 * `title`, a mark carries `name` and `label`, and `name` is deliberately shaped
 * like a python identifier so that renaming a door for the player cannot
 * silently break a member's island. Then the roster on /world printed
 * `the_hub`, the editor's event rows printed `panthers_maw`, and the walk panel
 * printed `the_maw_mouth`. The two-field design was paid for and then thrown
 * away at the last inch, at the point where the string reaches a person.
 *
 * ONE HELPER, so a surface cannot get this half right. Ash, 2026-08-29: humans
 * see labels, never snake_case, and waypoints get labels too.
 *
 * IT RETURNS A FLAG, and the flag is the reason this is a function and not a
 * template string. `derived` says the words on screen were guessed from an
 * identifier rather than typed by an author, which is exactly the idiom
 * src/core/mask.ts:327 already uses when it invents an anchor name from an old
 * door label and stamps meta.derived = true. A surface that wants to nudge
 * somebody into naming the thing properly can now tell the difference; a
 * surface that does not care ignores it and reads .text.
 */

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

/* A DEVELOPER IDENTIFIER, UNPACKED INTO WORDS.
 *
 * Both separators, because the two id shapes in this repo disagree on purpose:
 * an anchor name is `panthers_maw` (a python identifier) and a map or place id
 * is `panther-maw` (kebab, and a python identifier cannot spell one). A person
 * should not have to know which kind of string they are looking at.
 *
 * A digit stuck to a word is split off, so `island_1` reads "Island 1" and
 * `flex200` reads "Flex 200". A run of digits is never title-cased.
 */
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

/* anything in this repo that a person might have to read. Every field is
 * optional: the caller passes the object it already has, not a shape it has to
 * build first, or the helper does not get used and we are back where we were.
 *
 * `title` is here beside `label` because a place on the ocean spells it that
 * way and a mark spells it the other, and neither is going to be renamed to
 * suit a display function. */
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

/* THE ONE HELPER. Every surface calls this and nothing else formats a name.
 *
 * A plain string is accepted because half the call sites hold an id and not an
 * object: a map id off the roster, a folder name, an anchor name pulled out of
 * a `meta` bag. Passing one is the same as passing { name }.
 *
 * `fallback` is what to say when the thing has no name at all, which is a real
 * state: an island slot on the ocean can exist before it has been named. It
 * comes back derived, because nobody typed it either.
 */
/* the shape of a string with nothing to say about it: no case, no separators.
 * Used to catch a title that is only the identifier wearing a hat. */
const bare = (s: string) => s.toLowerCase().replace(/[\s_\-.]+/g, '')

export function displayName(thing: Nameable | string | null | undefined, fallback = 'untitled'): Readable {
  const o: Nameable = typeof thing === 'string' ? { name: thing } : thing || {}
  const name = String(o.name || '').trim()
  // label first, then title. A thing carrying both is carrying one of them by
  // accident, and label is the newer field and the one the game reads.
  const typed = String(o.label || o.title || '').trim()
  /* A TITLE THAT IS THE IDENTIFIER WAS NOT TYPED BY ANYBODY.
   *
   * mask.ts:355 says it outright: `title` is a postgres column that was
   * MACHINE-FILLED WITH THE SLUG. So the dashboard asked this helper what a
   * person should read, got `panther-maw` handed back with derived:false, and
   * printed a kebab id as a heading under a rule that says humans never see
   * one. Compared bare, so "Hub" against `hub` and "The Maw" against `the_maw`
   * are both caught, and anything a person actually wrote is not. */
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
