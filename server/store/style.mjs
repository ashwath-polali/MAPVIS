// the house style and the scaffolds, words only so a check can prove a prompt without spending a generation; style is whose hand drew it, kind is what the engine needs, and the two are independent

import { readFileSync } from 'node:fs'

/* measured: a style image transfers palette, outline, detail and shading but never the angle, and /v2/generate-image-v2 has no view parameter, so the projection is said in words on every prompt and the reference is passed with its colour switched off */
export const STYLE_OPTIONS = { color_palette: false, outline: true, detail: true, shading: true }

/* the pixel ceiling one generation can hold, and both canvas sides must be even because an odd side is a 422 raised after the router has already spent its time choosing */
export const AREA_CEILING = 265000
export const even = (n) => (n % 2 ? n + 1 : n)

// ---- the kinds -------------------------------------------------------------

/* what the engine needs per class, no subject nouns and no palette: adding a noun here is how every island starts coming back the same island */
export const SCAFFOLDS = {
  island: {
    title: 'island',
    canvas: { w: 688, h: 384 },
    /* the coast is transparent because the engine draws the moving ocean under it, and painting water into the picture puts a dead sea beside a live one */
    structure:
      'one whole landmass seen from above, filling the frame, surrounded by fully transparent empty space with no water painted in, ' +
      'a clear walkable shoreline all the way round, one small dock or jetty meeting the edge of the land, ' +
      'open flat ground in at least one place with nothing standing on it',
    /* said out loud because the shallows are the one piece of water that belongs in the painting: the engine's ocean cannot know where the sand ends */
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

/* the kind a person typed, taken from their own words: explicit beats guessed, and an unrecognised word is not a kind rather than being forced into one */
export function kindOf(text, explicit) {
  const want = String(explicit || '').toLowerCase().trim()
  if (SCAFFOLDS[want]) return want
  const words = String(text || '').toLowerCase()
  // longest first, so "great hall" is a hall and not a miss
  for (const k of ['island', 'hall', 'room']) if (new RegExp(`\\b${k}s?\\b`).test(words)) return k
  return ''
}

// ---- the cards -------------------------------------------------------------

/* the house card, read off the hub's own painting and written down so it does not depend on that map still existing or on a planner being reachable; it is one account's card and is offered to another only by a grant */
export const HOUSE_KEY = 'adventure-game'

export const HOUSE_CARD = {
  key: HOUSE_KEY,
  title: 'Adventure Game',
  /* said on the constant and not only where it is handed out, or the one card that is granted rather than owned stops declaring itself halfway down */
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

/* a card from an account's own published map: the same five fields read off that painting by the planner and stored, with `ref` the map whose picture is passed as the style image */
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

/* the card read off a map's own style.json, for an account naming one of its published maps as its hand, in the same shape readStyleCard writes */
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

/* order matters: subject first because a generator weights the opening words hardest and the subject is the only part a person typed, then the class, then the hand, because a craft sentence in front of the subject draws the style and forgets the thing */
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
    /* last, because it is the instruction a generator drops first and the bundle is unusable without it: a painted border is a coast the cut cannot find and a wall the engine draws its ocean over */
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

/* what a map carries about the hand that drew it, for map.json, so a reader can say which hand it was without holding an account */
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

/* a canvas that fits the ceiling with both sides even, keeping the shape asked for; returned rather than refused because a refusal here lands after the subject is already typed */
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

/* a cover is looked at for two seconds while the next map loads, so no map scaffold applies, and it stays out of SCAFFOLDS so kindOf cannot guess it off the word cover. it carries no words because the game draws the name on its own plaque (src/game/stage/covers.ts) */
export const COVER_SCAFFOLD = {
  title: 'cover',
  /* the widest frame under the ceiling with both sides even: 688 x 384 is 264,192 against 265,000, and it is the shape the game shows a cover in; the four covers the game ships are 400x224, the same 1.79 to 1 */
  canvas: { w: 688, h: 384 },
  /* read off the four covers the game ships, loading-port, loading-islands, loading-maw and loading-voyage in the game's public/art/ui: every one looks across a place toward a horizon from about eye level, with a foreground, a subject in the middle and distance behind, and none is seen from above */
  structure:
    'one wide scenic view looking across the place named above toward a distant horizon, from eye level or a little above, ' +
    'filling the frame corner to corner with no transparent space and nothing cut off at the edges, ' +
    'a dark detailed foreground at the bottom edge, the subject standing clear in the middle distance, ' +
    'open sky across the upper third',
  /* the light is what makes those four read as a held breath rather than a screenshot: in every one the source is in the picture, low and warm, with the foreground dropped into shadow against it */
  light:
    'one strong light source inside the frame, low and warm, with a bright core and long reflections, ' +
    'the foreground dropped into deep shadow so the middle distance reads brightly against it',
  /* rich and not muted, the one place a cover parts company with a map: a map is painted flat and desaturated so placements read on top of it, and nothing is ever placed on a cover */
  colour: 'rich saturated colour, strong contrast between the warm lit side and the cool shadowed side, deep clean darks',
  /* said twice over and last, because it is the instruction a generator drops first and a cover with a title painted into it cannot be used at all */
  extra:
    'no text, no title, no lettering, no words, no numbers, no logo, no signage, no banner and nothing written anywhere in the picture',
}

/* the whole prompt for a cover, built here and never in the browser, because a client that assembles the prompt can ask for a hand it was never granted; same shape as mapPrompt, and the subject leads because it is the part a person typed */
export function coverPrompt({ subject, card, max = 1400 }) {
  const sub = tidy(subject)
  if (!sub) return { prompt: '', card: null, parts: [], canvas: COVER_SCAFFOLD.canvas }
  /* the card's clause is not used here: read off a map, it names an isometric projection and a muted palette, which contradicts every one of the four shipped covers. only the outline discipline carries across, and the projection, light and saturation come from the scaffold */
  const hand = card && card.craft && card.craft.outline ? card.craft.outline : ''
  const parts = [
    { name: 'subject', text: sub },
    { name: 'structure', text: COVER_SCAFFOLD.structure },
    { name: 'light', text: COVER_SCAFFOLD.light },
    { name: 'colour', text: COVER_SCAFFOLD.colour },
    hand ? { name: 'hand', text: hand } : null,
    /* last, and it repeats the no-words rule the scaffold already made, because the game writes the title over this picture and a painted one underneath cannot be fixed */
    { name: 'edge', text: COVER_SCAFFOLD.extra + ', no border, no frame, no user interface' },
  ].filter(Boolean)
  return {
    prompt: parts.map((p) => tidy(p.text)).join('. ').slice(0, max) + '.',
    card: card ? card.key : null,
    parts,
    canvas: COVER_SCAFFOLD.canvas,
  }
}

/* the code name an extra cover is called by, the same rule an anchor name follows, because python addresses both and one namespace shape across the tool beats the freedom of two */
export const isCoverName = (s) => /^[a-z][a-z0-9_]{0,47}$/.test(String(s || ''))
