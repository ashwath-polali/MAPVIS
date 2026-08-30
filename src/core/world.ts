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

/* WHAT A POINT ON THE WATER IS FOR, AND THERE IS ONE KIND OF POINT.
 *
 * Ash, 2026-08-30, collapsed the whole category: a berth is a waypoint for the
 * ocean, it is placed and moved freely, and it is callable in code. So `berth`
 * is the word and the default. The rest of this list is a FILTER, not a second
 * type, so a grape can ask for the anchorages without being handed every
 * landmark too; they are drawn the same and dragged the same.
 *
 * `approach` is gone from the vocabulary. It was never a kind of point, it was
 * the second field on a place, and server/db/019_berths.sql lifted every one of
 * them out as a plain berth. */
export const MARK_KINDS = ['berth', 'waypoint', 'anchorage', 'landmark', 'spawn'] as const
export type MarkKind = (typeof MARK_KINDS)[number]

/* A NAMED POINT ON THE WATER. It may belong to an island and it is never welded
 * to one: `island` is a field, not a different type. */
export interface WorldMark {
  /* what python addresses it by: a python identifier, unique against every
     place name on the same ocean, because sail_to("north_passage") does not
     say which list to look in */
  name: string
  kind: MarkKind
  x: number
  y: number
  facing?: string
  /* how close counts as arrived, so sailing to a berth is not an exact-pixel
     test on a hull that moves in floats */
  r?: number
  /* WHAT A PERSON READS. Ash, 2026-08-29, asked for this directly: points get
     labels too. The column and the cleaner have both carried it since
     server/db/014_world_marks.sql, and nothing in the browser ever set it, so
     every point fell through to displayName's derived branch and a student would
     have read "North Passage" only by luck of the identifier being tidy. */
  label?: string
  /* WHICH ISLAND THIS BELONGS TO, if any. A place used to carry its berth
     nested inside it, which is what made a mooring impossible to place: you had
     to pick an island before you could put a point anywhere. Naming the island
     from the point instead keeps everything the nesting bought, since the page
     drags a bound point along when its island moves, and costs none of the
     freedom. Empty means a point in open water that answers to nobody. */
  island?: string
  /* WHERE THE HULL PUTS SOMEBODY DOWN ONCE THEY ARE ASHORE: an anchor name
     inside the island being arrived at, not a point on the ocean. Without it a
     voyage lands on that map's default spawn and the dock somebody drew is
     walked past with nothing saying so. */
  at?: string
  meta?: Record<string, unknown>
}

/* the same name rule the server enforces, so a form can refuse before posting
 * rather than finding out from a 400. A bad name is REFUSED and never bent:
 * turning `North Passage` into `north_passage` invents an address the author
 * never wrote and nothing in their code calls. */
export const isMarkName = (s: string): boolean => /^[a-z][a-z0-9_]{0,47}$/.test(String(s || ''))
