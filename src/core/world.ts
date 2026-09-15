/* THE OCEAN DOCUMENT as the front end sees it. The browser had no types for it and carried marks through the save as unknown, which works until something wants to read one. Where this and server/store/world.mjs disagree, the server is right: it is the one that refuses a save. */

/* WHAT A POINT ON THE WATER IS FOR, and there is one kind of point: a berth. The rest of this list is a FILTER so a reader can ask for anchorages without being handed every landmark; they are drawn and dragged the same. `approach` is not a kind, it is a field on a berth. */
export const MARK_KINDS = ['berth', 'waypoint', 'anchorage', 'landmark', 'spawn'] as const

/* the hull in chart units, which are painting pixels: a stated size, never measured, because the vessel is drawn by whatever reads this ocean, so this is the place to correct it */
export const HULL = { length: 46, beam: 18 }

/* the compass words a berth may hold, as vectors, and y grows south so north is negative y, the same as every raster in this tool */
export const HEADINGS: Record<string, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
  'north-east': [0.7071, -0.7071],
  'north-west': [-0.7071, -0.7071],
  'south-east': [0.7071, 0.7071],
  'south-west': [-0.7071, 0.7071],
}

export const headingOf = (facing?: string): [number, number] | null => HEADINGS[String(facing || '').toLowerCase()] || null

/* degrees clockwise from north into a unit vector, y growing south, written out rather than taken off HEADINGS so an angle between two words draws where it points */
export const vecOfBearing = (deg: number): [number, number] => {
  const r = (Number(deg) * Math.PI) / 180
  return [Math.sin(r), -Math.cos(r)]
}

/* which way a mark is really pointing, the angle when there is one and the word when there is not, in one function because the chart, the coast rule and the publish answering separately is how a hull ends up drawn at one heading and moored at another */
export const vecOfMark = (m: { facing?: string; bearing?: number }): [number, number] | null =>
  Number.isFinite(Number(m?.bearing)) ? vecOfBearing(Number(m.bearing)) : headingOf(m?.facing)

/* the nearest of the eight to an angle, kept on `facing` so a word-reader still gets a sensible one, and rounded rather than floored because 44 degrees is north-east and not north */
export const WORDS_CW = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
export const nearestFacing = (deg: number): string => {
  const d = ((Number(deg) % 360) + 360) % 360
  return WORDS_CW[Math.round(d / 45) % 8]
}

/* and back, so a mark that only ever carried a word can be put on the dial without losing where it was pointing */
export const bearingOfMark = (m: { facing?: string; bearing?: number }): number => {
  if (Number.isFinite(Number(m?.bearing))) return ((Number(m.bearing) % 360) + 360) % 360
  const i = WORDS_CW.indexOf(String(m?.facing || '').toLowerCase())
  return i < 0 ? 0 : i * 45
}

export type MarkKind = (typeof MARK_KINDS)[number]

/* a named point on the water, which may belong to an island and is never welded to one, because `island` is a field and not a different type */
export interface WorldMark {
  /* what python addresses it by: a python identifier unique against every place name on the same ocean, because sail_to("north_passage") does not say which list to look in */
  name: string
  kind: MarkKind
  x: number
  y: number
  facing?: string
  /* the heading as an angle is the real one, because eight words cannot say along this shore when a coast runs at 23 degrees, in degrees clockwise from north so 0 is north and 90 is east, with `facing` kept beside it as the nearest of the eight, and when both are here this one wins */
  bearing?: number
  /* how close counts as arrived, so sailing to a berth is not an exact-pixel test on a hull that moves in floats */
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
