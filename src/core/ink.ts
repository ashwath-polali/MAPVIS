/* ONE TABLE OF ANCHOR INKS, IMPORTED BY BOTH CANVASES. The editor drew every anchor pale iris and the ocean chart drew a door salmon, so one place was two colours two clicks apart. A 2d context cannot read a custom property, which is why this is hexes. */

/* THE SIX ANCHOR KINDS, each its own ink, so an author tells a berth from a spawn without reading nine labels. Every hex copies a token in src/site/tokens.css. */
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
