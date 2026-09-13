// The house style, and the scaffold each kind of map stands on.
//
// This is the file to edit when the hand changes. Everything below is words: no
// network, no database, no image. What comes out is the prompt a map is drawn
// from, which is why the checks can prove it without buying a generation.
//
// Two axes, and they are independent on purpose.
//
//   THE STYLE says whose hand drew it. A card carries the craft sentence, the
//   part of a prompt that is about projection, cluster size, outline, light and
//   saturation and never about the subject. One card per account, plus the one
//   house card that is granted rather than owned.
//
//   THE KIND says what the engine needs the picture to be. An island has to
//   have a transparent coast or the engine cannot draw its own ocean under it.
//   That is structural, so it applies whether or not a card does.
//
// A person typing "island" gets an island, not THE island. The subject is
// theirs; the scaffold and the craft are the parts they did not have to say.

import { readFileSync } from 'node:fs'

/* MEASURED, AND THE REASON THE CRAFT SENTENCE EXISTS AT ALL: a style image
 * transfers palette, outline, detail and shading, and it cannot transfer the
 * angle. /v2/generate-image-v2 has no view parameter. So the projection is said
 * in words on every prompt, and the reference painting is passed with its own
 * colour switched off so a new map is drawn by the same hand in its own hues. */
export const STYLE_OPTIONS = { color_palette: false, outline: true, detail: true, shading: true }

/* the pixel ceiling one generation can hold, and both canvas sides even. An odd
 * side is a 422 raised after the router has already spent its time choosing. */
export const AREA_CEILING = 265000
export const even = (n) => (n % 2 ? n + 1 : n)

// ---- the kinds -------------------------------------------------------------

/* WHAT THE ENGINE NEEDS, PER CLASS. Nothing here describes a subject: no nouns
 * a person would have typed themselves, and no palette. Adding a noun here is
 * how every island starts coming back the same island. */
export const SCAFFOLDS = {
  island: {
    title: 'island',
    canvas: { w: 688, h: 384 },
    /* the coast is transparent because the engine draws the moving ocean under
     * it; painting water into the picture puts a dead sea beside a live one */
    structure:
      'one whole landmass seen from above, filling the frame, surrounded by fully transparent empty space with no water painted in, ' +
      'a clear walkable shoreline all the way round, one small dock or jetty meeting the edge of the land, ' +
      'open flat ground in at least one place with nothing standing on it',
    /* said out loud because the shallows are the one piece of water that belongs
     * IN the painting: the engine's ocean cannot know where the sand ends */
    extra: 'a narrow band of shallow water hugging the shore, inside the land and not beyond it',
  },
  room: {
    title: 'room',
    canvas: { w: 512, h: 384 },
    structure:
      'one interior seen from above at character scale, walls meeting the floor on every side, no sky and no horizon, ' +
      'the floor clearly readable as walkable, open floor in at least one place with nothing standing on it',
    extra: 'the space beyond the walls fully transparent',
  },
  hall: {
    title: 'hall',
    canvas: { w: 688, h: 384 },
    structure:
      'one long interior passage seen from above at character scale, running from one edge of the frame to the other, ' +
      'walls on both long sides, openings at both ends, no sky and no horizon, the floor clearly readable as walkable',
    extra: 'the space beyond the walls fully transparent',
  },
}

export const KINDS = Object.keys(SCAFFOLDS)

/* the kind a person typed, taken from their own words. Explicit beats guessed,
 * and an unrecognised word is not a kind rather than being forced into one. */
export function kindOf(text, explicit) {
  const want = String(explicit || '').toLowerCase().trim()
  if (SCAFFOLDS[want]) return want
  const words = String(text || '').toLowerCase()
  // longest first, so "great hall" is a hall and not a miss
  for (const k of ['island', 'hall', 'room']) if (new RegExp(`\\b${k}s?\\b`).test(words)) return k
  return ''
}

// ---- the cards -------------------------------------------------------------

/* THE HOUSE CARD. Read off the hub's own painting and then written down, so it
 * does not depend on that map still existing or on a planner being reachable.
 * It is one account's card and is offered to another only by a grant. */
export const HOUSE_KEY = 'adventure-game'

export const HOUSE_CARD = {
  key: HOUSE_KEY,
  title: 'Adventure Game',
  /* said on the constant and not only where it is handed out, or the one card
   * that is granted rather than owned stops declaring itself halfway down */
  house: true,
  craft: {
    scale: 'chunky isometric pixel art, moderate-coarse pixel clusters, forms blocky and readable at a glance, no sub-pixel detail',
    light: 'clear neutral daylight, source upper-left, soft shadows falling right and lower-right of every form',
    outline: 'consistent 1px near-black outline on all forms and edges, no hue-shift',
    palette: 'desaturated muted tones throughout, nothing vivid',
    clause:
      'chunky isometric pixel forms, moderate-coarse clusters, dark 1px outlines with no hue-shift, upper-left daylight with shadows right and lower-right, desaturated muted palette',
  },
}

/* a card from an account's own published map: the same five fields, read off
 * that painting by the planner and stored. `ref` is the map whose picture is
 * passed as the style image. */
export function cardFrom(row) {
  if (!row) return null
  const craft = row.craft && typeof row.craft === 'object' ? row.craft : {}
  if (!craft.clause) return null
  return {
    key: String(row.key || ''),
    title: String(row.title || row.key || 'a hand'),
    craft: {
      scale: String(craft.scale || ''),
      light: String(craft.light || ''),
      outline: String(craft.outline || ''),
      palette: String(craft.palette || ''),
      clause: String(craft.clause || ''),
    },
    ref: String(row.ref_slug || ''),
    house: !!row.house,
  }
}

/* the card read off a map's own style.json, for an account naming one of its
 * published maps as its hand. The file is the same shape readStyleCard writes. */
export function cardFromStyleFile(file, { key, title, ref }) {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'))
    if (!o || !o.clause) return null
    return cardFrom({ key, title, ref_slug: ref, craft: o })
  } catch {
    return null
  }
}

// ---- the prompt ------------------------------------------------------------

const tidy = (s) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,.\s]+$/, '')

/* THE WHOLE OF IT, AND THE ORDER MATTERS. The subject first, because a
 * generator weights the opening words hardest and the subject is the only part
 * the person actually typed. Then what the engine needs of this class. Then the
 * hand. A craft sentence in front of the subject draws the style and forgets the
 * thing. */
export function mapPrompt({ subject, kind, card, max = 1400 }) {
  const sub = tidy(subject)
  if (!sub) return { prompt: '', kind: '', card: null, parts: [] }
  const k = kindOf(sub, kind)
  const scaffold = SCAFFOLDS[k] || null

  const parts = [
    { name: 'subject', text: sub },
    scaffold ? { name: 'structure', text: scaffold.structure } : null,
    scaffold && scaffold.extra ? { name: 'extra', text: scaffold.extra } : null,
    card && card.craft && card.craft.clause ? { name: 'craft', text: card.craft.clause } : null,
    /* last, because it is the one instruction a generator drops first and the
     * bundle is unusable without it: a painted border is a coast the cut cannot
     * find and a wall the engine draws its ocean over. */
    { name: 'edge', text: 'pixel art, no border, no frame, no text, no user interface' },
  ].filter(Boolean)

  return {
    prompt: parts.map((p) => tidy(p.text)).join('. ').slice(0, max) + '.',
    kind: k,
    card: card ? card.key : null,
    parts,
    canvas: scaffold ? scaffold.canvas : { w: 688, h: 384 },
  }
}

/* what a map carries about the hand that drew it, for map.json. A reader can
 * then say which hand it was without holding an account. */
export function styleStamp(card, kind) {
  if (!card) return kind ? { kind } : null
  return {
    ...(kind ? { kind } : {}),
    style: card.key,
    title: card.title,
    clause: card.craft.clause,
    ...(card.house ? { house: true } : {}),
  }
}

/* a canvas that fits the ceiling with both sides even, keeping the shape asked
 * for. Returned rather than refused, because a refusal here lands after the
 * person has already typed the subject. */
export function fitCanvas({ w, h }) {
  let W = Math.max(64, Math.round(Number(w) || 688))
  let H = Math.max(64, Math.round(Number(h) || 384))
  if (W * H > AREA_CEILING) {
    const k = Math.sqrt(AREA_CEILING / (W * H))
    W = Math.floor(W * k)
    H = Math.floor(H * k)
  }
  return { w: even(W), h: even(H) }
}

// ---- the cover -------------------------------------------------------------

/* WHAT A TRANSITION SCREEN IS, and it is not a map. A map is painted to be walked on and its
 * scaffolds say so: transparent surrounds, a readable floor, a shoreline the cut can find. A cover
 * is painted to be LOOKED at for two seconds while the next map loads, so none of that applies and
 * putting it in SCAFFOLDS would also let kindOf guess it off the word "cover" in somebody's subject.
 *
 * The one hard rule is that it carries no words. The game draws the place's name itself, on its own
 * drawn plaque with a kicker over it (src/game/stage/covers.ts), so lettering in the picture lands
 * under lettering on top of it. */
export const COVER_SCAFFOLD = {
  title: 'cover',
  /* the widest frame under the ceiling with both sides even: 688 x 384 is 264,192 against 265,000,
   * and it is the shape the game shows a cover in */
  canvas: { w: 688, h: 384 },
  structure:
    'one wide painted scene of the place named above, seen from a little way off so the whole of it reads at a glance, ' +
    'filling the frame corner to corner with no transparent space and nothing cut off at the edges, ' +
    'a clear foreground, middle and distance, and one place for the eye to rest near the middle',
  /* said twice over and last, because it is the instruction a generator drops first and a cover with
   * a title painted into it cannot be used at all */
  extra:
    'no text, no title, no lettering, no words, no numbers, no logo, no signage, no banner and nothing written anywhere in the picture',
}

/* THE WHOLE PROMPT FOR A COVER, built here and never in the browser, for the same reason mapPrompt is:
 * a client that assembles the prompt is a client that can ask for a hand it was never granted. Same
 * shape as mapPrompt so the two can be read side by side, and the subject leads because it is the one
 * part a person typed. */
export function coverPrompt({ subject, card, max = 1400 }) {
  const sub = tidy(subject)
  if (!sub) return { prompt: '', card: null, parts: [], canvas: COVER_SCAFFOLD.canvas }
  const parts = [
    { name: 'subject', text: sub },
    { name: 'structure', text: COVER_SCAFFOLD.structure },
    card && card.craft && card.craft.clause ? { name: 'craft', text: card.craft.clause } : null,
    /* last, and it repeats the no-words rule the scaffold already made, because the game writes the
     * title over this picture and a painted one underneath it reads as a mistake nobody can fix */
    { name: 'edge', text: COVER_SCAFFOLD.extra + ', no border, no frame, no user interface' },
  ].filter(Boolean)
  return {
    prompt: parts.map((p) => tidy(p.text)).join('. ').slice(0, max) + '.',
    card: card ? card.key : null,
    parts,
    canvas: COVER_SCAFFOLD.canvas,
  }
}

/* the code name an extra cover is called by, the same rule an anchor name follows, because python
 * addresses both and one namespace shape across the tool is worth more than the freedom of two */
export const isCoverName = (s) => /^[a-z][a-z0-9_]{0,47}$/.test(String(s || ''))
