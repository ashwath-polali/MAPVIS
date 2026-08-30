/* THE OCEAN DOCUMENT, as the front end sees it.
 *
 * server/store/world.mjs has held the authoritative shapes since marks were
 * added, and the browser had none: World.tsx typed the third list as
 * `marks?: unknown` and carried it through the save untouched, which works
 * exactly until something wants to read one. A field nothing can name is a
 * field the next surface will drop.
 *
 * The rules below are the server's rules restated, not new ones. Where this
 * file and server/store/world.mjs disagree, the server is right: it is the one
 * that refuses a save.
 */

/* what a free-standing point on the water is FOR. `waypoint` is the one the
 * category was asked for: a corner a sail leg turns at, belonging to neither
 * island it sits between. */
export const MARK_KINDS = ['berth', 'approach', 'waypoint', 'anchorage', 'landmark', 'spawn'] as const
export type MarkKind = (typeof MARK_KINDS)[number]

/* A NAMED POINT ON THE WATER THAT BELONGS TO NO ISLAND. */
export interface WorldMark {
  /* what python addresses it by: a python identifier, unique against every
     place name on the same ocean, because sail_to("north_passage") does not
     say which list to look in */
  name: string
  kind: MarkKind
  x: number
  y: number
  facing?: string
  /* how close counts as arrived, so sailing to a mark is not an exact-pixel
     test on a hull that moves in floats */
  r?: number
  /* WHAT A PERSON READS. Ash, 2026-08-29, asked for this directly: waypoints
     get labels too. The column and the cleaner have both carried it since
     server/db/014_world_marks.sql, and nothing in the browser ever set it, so
     every mark fell through to displayName's derived branch and a student would
     have read "North Passage" only by luck of the identifier being tidy. */
  label?: string
  meta?: Record<string, unknown>
}

/* the same name rule the server enforces, so a form can refuse before posting
 * rather than finding out from a 400. A bad name is REFUSED and never bent:
 * turning `North Passage` into `north_passage` invents an address the author
 * never wrote and nothing in their code calls. */
export const isMarkName = (s: string): boolean => /^[a-z][a-z0-9_]{0,47}$/.test(String(s || ''))
