/* THE OCEAN DOCUMENT as the front end sees it. The browser had no types for it and carried marks through the save as unknown, which works until something wants to read one. Where this and server/store/world.mjs disagree, the server is right: it is the one that refuses a save. */

/* WHAT A POINT ON THE WATER IS FOR, and there is one kind of point: a berth. The rest of this list is a FILTER so a reader can ask for anchorages without being handed every landmark; they are drawn and dragged the same. `approach` is not a kind, it is a field on a berth. */
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
  /* WHAT A PERSON READS. The column and the cleaner have carried it since 014 and nothing in the browser ever set it, so every point fell through to displayName's derived branch. */
  label?: string
  /* WHICH ISLAND THIS BELONGS TO, if any. Nesting a berth inside a place made a mooring impossible to put anywhere until an island was picked. Empty means open water answering to nobody. */
  island?: string
  /* WHERE THE HULL PUTS SOMEBODY DOWN ONCE ASHORE: an anchor name inside the island being arrived at. Without it a voyage lands on that map's default spawn and the dock somebody drew is walked past. */
  at?: string
  /* THE RUN-IN, the one field on a berth that is not a berth: the game aims here first and swings onto the berth's heading once it is astern, which is coming alongside rather than nosing into a jetty. Nested and not free, because nothing sails to a run-in and it only means anything relative to this berth. */
  approach?: { x: number; y: number }
  meta?: Record<string, unknown>
}

/* the same name rule the server enforces, so a form refuses before posting. A bad name is REFUSED and never bent: turning `North Passage` into `north_passage` invents an address nothing in the author's code calls. */
export const isMarkName = (s: string): boolean => /^[a-z][a-z0-9_]{0,47}$/.test(String(s || ''))
