/* WHAT AN ANCHOR IS DRAWN IN, on whichever of the two canvases is drawing it.
 *
 * TWO SURFACES DRAW THE SAME MARKS AND DISAGREED ABOUT THEM. The editor's
 * overlay drew every anchor in one pale iris, #c9cbf8, whatever kind it was.
 * The ocean chart drew a door in salmon, a post in green, a spawn in blue. So
 * Panther's Maw is a lavender pill on /edit and an orange one two clicks away
 * on /world, and neither surface is wrong on its own: they were each written
 * without the other in the room. A person moving between them has to relearn
 * the colours, which is the whole cost of an accent that means one thing on one
 * page and something else on the next.
 *
 * ONE TABLE, IMPORTED BY BOTH. src/site/World.tsx and src/core/editor.ts each
 * keep a block of hexes at the top, because a 2d context cannot read a custom
 * property, and each block promises that no colour is written below it. That
 * promise survives: this file is that block, for the one thing the two surfaces
 * both draw.
 *
 * Nothing else moved here. A route and a shot exist only inside the editor and
 * a stretch of water only on the chart, so their inks stay where they are drawn
 * rather than collecting in a bag named "colours".
 */

/* THE SIX ANCHOR KINDS src/core/mask.ts ALLOWS, each its own ink. The reason to
 * colour them at all is that an author aiming a berth has to tell a door from a
 * spawn without reading nine labels, and an author placing a door has to see at
 * a glance which of the marks already on the painting are doors. Same question,
 * two pages, one answer.
 *
 * Every hex is a copy of a token in src/site/tokens.css or a hue chosen beside
 * them, so a token that moves is followed here and neither canvas is opened. */
export const ANCHOR_INK: Record<string, string> = {
  door: '#e2734a',
  post: '#6fc2a6',
  spawn: '#7fa8d8',
  trigger: '#b07acc',
  region: '#d4a53c' /* --acc-tool */,
  point: '#c8d2dd',
}

/* the fallback is --ink-edge, a boundary colour rather than a text one on
 * purpose: a kind nobody has an ink for should read as an unfinished thing and
 * not as a seventh category somebody chose. */
export const inkFor = (m: Record<string, string>, k: string): string => m[k] || '#5b6470'
