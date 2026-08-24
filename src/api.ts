/* Calls to the local node side. Nothing here knows a key. */
import type { CustomControl } from './core/customfx'

async function jpost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error || r.statusText)
  return j as T
}

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url)
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error || r.statusText)
  return j as T
}

export const balance = () => jget<{ usd?: number }>('/api/balance')

export const generate = (prompt: string, n: number, w: number, h: number) =>
  jpost<{ jobs: { id?: string; seed?: number; error?: string }[] }>('/api/generate', { prompt, n, w, h })

export const jobState = (id: string) =>
  jget<{ state: 'running' | 'done' | 'failed'; images?: string[]; error?: string }>('/api/job/' + encodeURIComponent(id))

export const propose = (image: string) =>
  jpost<{ levels: string; note: Record<string, unknown> }>('/api/propose', { image })

export const saveScene = (id: string, image: string) => jpost<{ url: string }>('/api/save', { id, image })

// one entry of an exported assets.json, exactly the loader contract's shape.
// scale is the legacy uniform field (= scaleX); the transform fields are
// absent in bundles exported before they existed.
export interface SavedAssetEntry {
  id?: string
  group?: string
  src?: string
  frames?: string[]
  fps?: number
  /* one view per heading, keyed by the eight names Thor's own frames use, each
   * one a list of bundle-relative paths inside a single folder. Written for
   * anything that has to face where it is going. */
  dirs?: Record<string, string[]>
  /* how it MOVES, if it does: a core/life.ts Life, written through untouched by
   * the exporter. Off the wire, so it is only a Life once cleanLife says so. */
  life?: unknown
  x?: number
  y?: number
  scale?: number
  scaleX?: number
  scaleY?: number
  rot?: number
  flipX?: boolean
  flipY?: boolean
}
export interface SavedScene {
  map?: {
    spawn?: [number, number]
    occluders?: { id: number; baseline: number }[]
    // the events contract: a spot plus an action; door is the first type
    events?: { id: number; type: string; x: number; y: number; r: number; label: string; to: string }[]
  } | null
  levels?: string | null
  occluders?: string | null
  cut?: string | null
  assets?: { assets?: SavedAssetEntry[] } | null
}
export const savedScene = (id: string) => jget<SavedScene>('/api/scene/' + encodeURIComponent(id))

// ---- the assets step ----------------------------------------------------

// one library entry: a single png, or a folder of frames played in order.
// The library is per map: only what was generated for this scene id.
export interface LibItem {
  name: string
  kind: 'static' | 'animated'
  // an animated item that carries effect.json: the tuning panel can reopen it
  effect?: boolean
  src?: string
  frames?: string[]
  fps?: number
  /* one view per heading, for something that has to face where it is going.
   * Keys are the eight names Thor's own frames use. Absent on almost
   * everything: a crab is two apparent directions and a flip covers it. */
  dirs?: Record<string, string[]>
  w: number
  h: number
}
export const library = (id: string) => jget<{ items: LibItem[] }>('/api/library/' + encodeURIComponent(id))

// ---- what the account already owns --------------------------------------

// The objects on the pixellab account, browsable. This is the cheap half of
// the assets step and the good half: 700 objects are already sitting there and
// the ones written in the house style are better than anything a fresh ask
// comes back with. Picking one costs nothing. thumb is pixellab's own public
// preview url, so the grid draws straight off their cdn.
export interface AccountObject {
  id: string
  name: string
  prompt: string
  w: number
  h: number
  thumb: string
}
export const accountObjects = (page: number, q: string) =>
  jget<{ items: AccountObject[]; total: number; page: number; pages: number }>(
    `/api/account-objects?page=${page}&q=${encodeURIComponent(q)}`,
  )

// one of them copied into this map's library as a normal static item. Free:
// the png already exists, this only moves the bytes.
export const accountImport = (id: string, sceneId: string, name?: string) =>
  jpost<{ item: LibItem }>('/api/account-import', { id, sceneId, name })

// ---- the style card -----------------------------------------------------

// What this map looks like, read off the painting ONCE and kept on disk.
// The ask has never carried the map's look: a request for tropical palm trees
// on a warm golden-hour island came back generic bright green, because the
// words could not tell the generator what the island is like. clause is the
// deliverable, one short phrase that hangs off the end of any sprite
// description. FREE: nothing on this route touches pixellab, and a scene that
// never answers just goes without.
export interface StyleCard {
  palette: string
  light: string
  outline: string
  scale: string
  clause: string
}
export const styleCard = (id: string, image: string, refresh = false, job?: string) =>
  jpost<{ card: StyleCard; cached: boolean }>('/api/style-card', { id, image, refresh, job })

// the ask interpreter alone, free: called at arm time so the confirm button
// can show exactly what will be drawn before anything spends. styleClause is
// the style card's line, appended to the thing that comes back, so what the
// button promises already includes it.
// belongs is how much the thing should look like it came off this map: a palm
// on the island is 1, a generic crate 0.8, a magic item 0.2. The style clause
// is appended server-side only at or above 0.5, so the will-draw line reads
// belongs to say which of the two happened before anything spends.
export interface AskTranslation {
  thing: string
  motion: string
  w: number
  h: number
  belongs?: number
}
// id rides along so the rewrite can be shaped by what he has already KEPT on
// this map: the last few keeps go into the prompt as taste, never the discards.
export const translate = (
  ask: string,
  kind: 'static' | 'animated',
  styleClause?: string,
  id?: string,
  job?: string,
) => jpost<{ t: AskTranslation }>('/api/translate', { ask, kind, styleClause, id, job })

// ONE pixellab generation into this map's library. Only ever called after an
// explicit cost confirm. name pins the library filename (a run of takes passes
// <slug>-1 up to <slug>-8) and seed pins the starting noise, so several takes
// of the same prompt land as distinct pictures. thing/tw/th carry the CONFIRMED
// translation through verbatim, so what the button showed is what runs.
export const assetGen = (
  id: string,
  prompt: string,
  o?: {
    w?: number
    h?: number
    name?: string
    seed?: number
    thing?: string
    tw?: number
    th?: number
    // the boxed area of the painting, already inside 32..192 per side. When it
    // rides along pixellab draws INTO that art instead of onto a bare canvas.
    background?: string
    // a generation already asked for is already paid for, so what a stop buys
    // is the one NOT yet asked for. The server checks the job before it sends.
    job?: string
  },
) => jpost<{ item: LibItem }>('/api/asset-gen', { id, prompt, ...o })

/* ---- characters: people and animals ------------------------------------
 *
 * Pixellab's own distinction, and it matters. An OBJECT is a prop — a crate, a
 * well — and that is all MAPVIS has ever made. A CHARACTER has a skeleton, 4 or
 * 8 directions, and walk cycles from a template library. Their docs say plainly
 * not to use the eight-direction object endpoint for a person; an earlier
 * version of this file did exactly that.
 *
 * Both of these are free: listing reads the account, importing moves bytes that
 * already exist. */
export interface AccountCharacter {
  id: string
  name: string
  directions: number
  animations: number
  size: string
  thumb: string
}
export const accountCharacters = () =>
  jget<{ items: AccountCharacter[]; total: number }>('/api/account-characters')

/* One character into this map's library, WITH its walk cycle when it has one.
 * What lands is one entry per heading with frames inside, which is the shape
 * the renderers already understand. */
export const characterImport = (id: string, sceneId: string, o?: { name?: string; animation?: string }) =>
  jpost<{ item: LibItem }>('/api/character-import', { id, sceneId, ...o })

/* A NEW sprite, made rather than picked. The only paid call on this half.
 *
 * Not an object with more sides. An object endpoint given a body answers with a
 * generic character instead of the one that was asked for, which is pixellab's
 * own warning and not a guess; a sprite is generated off a skeleton, which is
 * what makes eight views of the SAME body possible and what a motion hangs on.
 * So the two live on different endpoints and this one is theirs.
 *
 * The price is the thing to say out loud. One generation for the body in
 * standard mode, then ONE PER DIRECTION for the motion, so eight-way moving is
 * nine. It is also slow: two to five minutes for the body and longer again for
 * the motion, all inside this one request.
 *
 * confirm true is the server's own gate and only the confirmed press sends it,
 * so a reload or a retry cannot spend. job makes the wait stoppable, and a stop
 * that lands between the body and its motion is worth eight generations.
 *
 * Nothing here is picked off a control. skeleton, view, size and anim are the
 * router's answer, carried through verbatim from the plan the button showed.
 * The server splits skeleton into pixellab's bodyType and template, because a
 * four-legged rig has to name which body it is and mannequin must not.
 *
 * What lands is the same on-disk shape the account import writes, so placement,
 * facing, life and the export never learn that it was generated.
 *
 * note carries a motion that did not happen. The body is bought the moment it
 * is asked for, so a motion that fails or is stopped leaves the sprite standing
 * rather than losing it, and this is where the reason comes back. */
export const characterGen = (
  id: string,
  o: {
    description: string
    confirm: true
    job?: string
    name?: string
    // pins the starting noise so two variants of one ask are distinct takes
    // rather than the same roll twice
    seed?: number
    // pixellab pads the canvas about 40% past this to leave room for the
    // animation, so 48 comes back near 68 and arrives needing its base trimmed
    size?: number
    view?: SpriteRoute['view']
    // one of the six rigs. The server turns mannequin into humanoid and the
    // other five into quadruped + that template.
    skeleton?: SpriteRoute['skeleton']
    // eight, because life.ts works out an eight-way facing and four makes the
    // diagonals snap to the wrong view. An engine requirement, so it is not a
    // routing answer.
    nDirections?: 4 | 8
    anim?: SpriteAnim
    // standard is one generation. pro is twenty to forty and can never be a
    // default here, and the price on the button assumes standard.
    mode?: 'standard' | 'pro' | 'v3'
  },
) => jpost<{ item: LibItem; note?: string }>('/api/character-gen', { id, ...o })

/* ---- the ask, read with the map open ------------------------------------
 *
 * One call, and the only one before a generation. It is handed the painting
 * itself and, if the user drew one, the boxed area at 2x, and it answers with
 * the WHOLE generator prompt plus the pixel size it measured against what is
 * already on the map.
 *
 * This replaced a translator, a style card, a prompt assembled in code, a
 * ground-word filter and a pixel trimmer. Those five existed because the map
 * was compressed to eighteen words of text before anything could use it. It is
 * not compressed any more.
 *
 * It is also the ROUTER. A sprite has a body, so somebody has to answer which
 * skeleton, which view, how big, and what moving MEANS for that thing. None of
 * those belong in a dropdown: a list of creatures is always shorter than what
 * somebody wants to make, and a dragon does not walk. So the ask goes in whole
 * and the model, holding the painting, answers the routing as well as the
 * words.
 *
 * FREE, and stoppable: job is any string, and stop(job) ends it mid-thought. */

// how the sprite moves. template is one of pixellab's named humanoid cycles;
// action is written prose for anything a template cannot say, which is most of
// what is interesting: hovering, lurching, servos idling. none is a sprite that
// stands.
export interface SpriteAnim {
  how: 'none' | 'template' | 'action'
  template?: string
  action?: string
  // only on the written path. 4..16, even.
  frames?: number
}
/* Pixellab builds a sprite off a skeleton and there are exactly six: the
 * upright mannequin and five four-legged bodies. There is no dragon rig and no
 * robot rig, so anything else is mapped onto the NEAREST one by body plan. That
 * decision is the router's, and the skeleton never leaks into the words: a
 * mannequin-rigged patrol robot still reads as a machine because the prompt
 * says plating and a lens where a face would be. */
export interface SpriteRoute {
  skeleton: 'mannequin' | 'bear' | 'cat' | 'dog' | 'horse' | 'lion'
  view: 'low top-down' | 'high top-down' | 'side' | 'perspective'
  // the sprite's own pixel height, 32..96. Above 96 a written animation costs
  // more than one generation per direction, so bigger is a scale-up on the map.
  size: number
  anim: SpriteAnim
  why: string
}
export interface MakePlan {
  kind: 'object' | 'sprite'
  prompt: string
  motion: string
  note: string
  w: number
  h: number
  // one line when the OTHER mode would have suited it better. The router never
  // switches on its own, because a switch changes the price.
  crossing?: string
  sprite?: SpriteRoute
}
export const assetPlan = (
  id: string,
  ask: string,
  o: {
    map: string
    // which of the two spending modes is open. The router answers for that one
    // and says so in crossing if the other one fits better.
    what: 'object' | 'sprite'
    kind: 'static' | 'animated'
    box?: { x: number; y: number; w: number; h: number } | null
    boxImage?: string
    previous?: string
    job?: string
  },
) => jpost<{ plan: MakePlan }>('/api/asset-plan', { id, ask, ...o })

/* ---- give a placement life ----------------------------------------------
 *
 * Free. What comes back is a handful of numbers saying how the thing MOVES,
 * which the game works out each frame; it is not animation frames and cannot
 * be, because every effect here has to loop and a wander that returns to its
 * start is a dance. See src/core/life.ts.
 *
 * bounds is the box drawn on the map, and skipping it is a real answer: with no
 * fence the movement is judged from the map itself. */
export const lifePlan = (
  id: string,
  ask: string,
  o: {
    map: string
    mapW: number
    mapH: number
    name: string
    at?: { x: number; y: number }
    size?: { w: number; h: number }
    bounds?: { x: number; y: number; w: number; h: number } | null
    /* how much of that box is ground a person could stand on, and whether that
     * crossed the line where the floor becomes a second fence */
    walkPct?: number
    walkOnly?: boolean
    job?: string
  },
) => jpost<{ life: unknown; note: string }>('/api/life-plan', { id, ask, ...o })

export const stop = (job: string) => jpost<{ stopped: boolean }>('/api/stop', { job })

/* A whole boxed area planned in one look: what belongs in it, and where each
 * thing stands. Free and stoppable, same as the single read. Positions come
 * back in the box's own pixels, feet-anchored, so the client only has to add
 * the box's corner. Nothing generates until the list has been seen. */
export interface SceneItem {
  what: string
  prompt: string
  motion: string
  w: number
  h: number
  x: number
  y: number
}
export interface ScenePlan {
  note: string
  items: SceneItem[]
}
export const scenePlan = (
  id: string,
  o: {
    map: string
    boxImage: string
    box: { x: number; y: number; w: number; h: number }
    ask?: string
    count?: number
    kind?: 'static' | 'animated'
    job?: string
  },
) => jpost<{ plan: ScenePlan }>('/api/scene-plan', { id, ...o })

// ONE pixellab generation WITH context, same price class as assetGen: crop is
// a square of the cut painting around the user's chosen spot (up to 160px,
// clamped to the canvas), cx/cy the clicked painting pixel. The server sends
// the crop as the background of pixellab's map-object endpoint, so the asset
// comes back drawn in that spot's palette and light, transparent, and lands
// in this map's library like any other static item. The client places it.
//
// note is the same disclosure characterGen carries: asked for moving, a stop
// between the base and its frames files the base as a still object, and this is
// where the reason travels so the ui does not have to guess why it stands.
export const assetGenHere = (
  id: string,
  prompt: string,
  o: {
    crop: string
    cx: number
    cy: number
    kind?: 'static' | 'animated'
    name?: string
    seed?: number
    thing?: string
    tmotion?: string
    tw?: number
    th?: number
    // a stop landing between the base and its animation saves the second half
    job?: string
  },
) => jpost<{ item: LibItem; note?: string }>('/api/asset-gen-here', { id, prompt, ...o })

// TWO pixellab generations behind the same confirm: a transparent base
// sprite, then its 8-frame animation. The ui passes motion as '' and the
// server's ask interpreter splits the one prompt into thing + movement words
// (scene words in the motion bleed objects into the sprite, the measured
// smoke-summoned-a-volcano failure); a non-empty motion still wins. The
// frames land in work/<id>/library/<name>/0..n.png, the folder shape the
// library lists as one animated item. thing/tmotion/tw/th carry the confirmed
// translation through verbatim.
//
// note carries a motion that did not happen, the way characterGen's does. The
// base is bought the moment it is asked for, so a stop landing between the two
// halves files it as a still object rather than losing it; without the note
// travelling with it the user gets a still where they asked for a moving one
// and nothing on screen says why.
export const assetAnim = (
  id: string,
  prompt: string,
  motion: string,
  o?: {
    name?: string
    seed?: number
    thing?: string
    tmotion?: string
    tw?: number
    th?: number
    // two spends behind one request, so a stop between them is worth one
    job?: string
  },
) => jpost<{ item: LibItem; note?: string }>('/api/asset-anim', { id, prompt, motion, ...o })

/* ---- making a thing that is already in the library MOVE -------------------
 *
 * Everything above makes something new. This points at a thing that exists and
 * says what it should DO: breathing while it stands, a rod cast, wings, a hop, a
 * crab scattering. Five people were standing dead still on the hub and there was
 * no way to ask for that without generating them again.
 *
 * Nothing on this path shows a list of animations. The user types it and the
 * server routes it, because a list of animations is always shorter than what
 * somebody wants. There are three ways to get there and they do not cost the
 * same, which is exactly why the price cannot be worked out on this side:
 *
 *   character  something drawn from headings. Every heading goes through ONE
 *              coordinated job, priced per heading. Eight separate single-image
 *              calls would come back as eight loops with eight rhythms, so a
 *              figure would breathe faster facing north than facing south.
 *   sprite     one png, or a folder of frames, animated off its own first
 *              frame. One generation.
 *   written    the ask needs the thing to TRAVEL, and neither generator can
 *              carry a sprite anywhere: both only redraw it where it stands. A
 *              written recipe stamps the item's own sprite at a position it
 *              works out per frame, and costs NOTHING. The route names this
 *              path rather than running it, so the free answer is offered
 *              instead of the wrong one being quietly charged for.
 *   blocked    it cannot be done honestly, and why. A figure whose character on
 *              the account cannot be found is the case that exists: animating
 *              its headings one at a time would come back out of register, so
 *              the route refuses instead of selling a defect.
 *
 * Everything except written rewrites the item IN PLACE, the way crop and
 * pixelate do, so an item that already moves has its frames REPLACED and the
 * library keeps one row per thing. Nothing touches the library folder until
 * every byte has landed under .stage, and the bytes that were there go to
 * work/<id>/.prev.
 *
 * ONE route, two presses. Without confirm it is a free read that answers the
 * plan and the true price. With confirm it runs the plan it was handed back, so
 * the number the button showed is the number that gets spent; the price itself
 * is re-derived server-side from the item and the account, so a client cannot
 * talk it down and the router cannot talk it up. */
export interface AnimPlan {
  path: 'character' | 'sprite' | 'written' | 'blocked'
  // exact, and the number the armed button shows. 0 on written and on blocked,
  // and on written it is a real zero: nothing there touches pixellab at all.
  price: number
  // the ask rewritten as one plain line of what the body does, which is what
  // the animator is actually given. The panel shows this, not the raw ask.
  motion: string
  // how many frames the loop is. 4 to 16, even.
  frames: number
  // one short line saying what it will look like
  note: string
  // true when the words were about where the thing GOES rather than what its
  // body does, which is what sends it down the free path
  move: boolean
  name: string
  shape: 'still' | 'frames' | 'views'
  // the headings a character job covers. Its length times the per-heading price
  // IS the price.
  headings?: string[]
  characterId?: string
  // how the character behind a folder was found: pinned, off dirs.json, or
  // rescued through asks.json
  found?: string
  pad?: boolean
  sprite?: boolean
  // set only on blocked: the reason, in words, and it is the whole answer
  why?: string
}
/* The read has no confirm and buys nothing. The confirmed press hands the plan
 * straight back so what was priced is what runs; job makes the wait stoppable,
 * which on the character path is worth up to seven of the eight.
 *
 * What comes back: { plan } from a read, { item, note } from a run that drew
 * something, { plan, free: true } from a confirmed written path, which spends
 * nothing and leaves the item alone. note carries a half that did not happen,
 * the way characterGen's does. */
export const assetAnimate = (
  id: string,
  o: { name: string; ask: string; plan?: AnimPlan; confirm?: true; job?: string },
) =>
  jpost<{ plan?: AnimPlan; item?: LibItem; note?: string; free?: boolean }>('/api/asset-animate', {
    id,
    ...o,
  })

// ---- the effect engine --------------------------------------------------

// Which motion rule fits the ask, what numbers to start it at, and WHOSE
// COLOURS it is made of. palette 'map' means the sampled painting pixels, which
// is right for smoke and dust; 'own' means the effect brought its own ramp in
// colors, which is the only way a purple portal on a brown island is purple.
// FREE: no generation happens on this path at all, and the server answers from
// a keyword match when the planner is unreachable, so it never hard-fails.
//
// type "custom" is the eighth answer and the one that is not a rule: when no
// built-in fits, the plan carries a WRITTEN renderer instead. code is the body
// of (p, colors, api) => void, run in the sandbox in core/customfx, and
// controls are the knobs it declared for itself, which replace the fixed five
// sliders in the panel. Still free, still no generation anywhere on this path.
export interface EffectPlan {
  type: string
  name: string
  palette?: 'map' | 'own'
  colors?: string[]
  params: Record<string, number | boolean>
  code?: string
  controls?: CustomControl[]
}
export const effectPlan = (ask: string, colors: string[], id?: string, job?: string) =>
  jpost<{ plan: EffectPlan }>('/api/effect-plan', { ask, colors, id, job })

// ---- the review loop ----------------------------------------------------

// The frames the client just rendered, laid out as one strip on disk and LOOKED
// AT. verdict good means ship it; revise carries a full replacement body for a
// written effect, or better numbers for one of the seven. FREE, every pass: the
// render is local and the look never touches pixellab. strip is the absolute
// path of what was looked at, so a failure can be seen rather than guessed at.
export interface FxVerdict {
  strip: string
  verdict: 'good' | 'revise'
  why: string
  code?: string
  params?: Record<string, number | boolean> | null
}
export const fxReview = (
  id: string,
  o: {
    ask: string
    frames: string[]
    kind: 'custom' | 'builtin'
    type: string
    params: Record<string, number>
    code?: string
    controls?: CustomControl[]
    pass?: number
    // three passes at two minutes each is six minutes of nothing to press, so
    // the look carries a job like every other planner
    job?: string
  },
) => jpost<FxVerdict>('/api/fx-review', { id, ...o })

// The generated candidates side by side, LOOKED AT: which one, and why. fix is
// only set when none of them are usable, and it is a corrected prompt to try,
// which costs generations and so stays behind the armed confirm. Looking itself
// is free: no generation happens anywhere on this route.
export interface ObjVerdict {
  strip: string
  best: number
  why: string
  fix: string
}
export const objReview = (id: string, ask: string, prompt: string, frames: string[], job?: string) =>
  jpost<ObjVerdict>('/api/obj-review', { id, ask, prompt, frames, job })

// one KEPT thing, appended to work/<id>/keeps.json. Only keeps, never discards.
export const keepNote = (
  id: string,
  o: { ask: string; prompt: string; name: string; kind: 'asset' | 'effect' },
) => jpost<{ n: number }>('/api/keep-note', { id, ...o })

// The frames the client rendered, written as an animated library item:
// work/<id>/library/<name>/0..n.png, plus effect.json beside them so the rule,
// its numbers and the sampled colours can be reopened later. Also free.
// overwrite rewrites an existing item in place: same name, same frame urls, so
// every placement of it plays the new render without being touched.
export const effectSave = (
  id: string,
  name: string,
  frames: string[],
  meta: unknown,
  overwrite = false,
  ask = '',
) => jpost<{ item: LibItem }>('/api/effect-save', { id, name, frames, meta, overwrite, ask })

// Every ask this map has been given, newest first. Free, read-only, and the
// answer to "what did I type to get that". A record, not a feature to feed.
export interface Ask {
  name: string
  // character is here so a past ask reopens in the mode that made it. Without
  // it a sprite came back in the object box, which draws a prop of a body. The
  // on-disk word stays 'character' so old asks.json rows still replay; the ui
  // calls that mode a sprite.
  kind?: 'asset' | 'effect' | 'character'
  ask: string
  prompt: string
  at: string
}
export const asks = (id: string) => jget<{ asks: Ask[] }>('/api/asks/' + encodeURIComponent(id))

// what a saved effect was made of, so the tuning panel reopens on it. Free.
export interface EffectSaved {
  type: string
  params: Record<string, number | boolean>
  palette?: 'map' | 'own'
  colors: string[]
  fps: number
  frames: number
  // a custom effect keeps its recipe beside its frames, so the pencil reopens
  // it with every knob still working
  code?: string
  controls?: CustomControl[]
}
export const effectRead = (id: string, name: string) =>
  jpost<EffectSaved>('/api/effect-read', { id, name })

/* Pixels the client already holds, written back to the item IN PLACE.
 *
 * Every edit used to land as a second row — palm, palm-trimmed,
 * palm-trimmed-bit2, palm-matched — and a library of near-identical rows is
 * worse than whatever each edit fixed. So crop, base-trim, pixelate and the
 * palette lock all rewrite the item they were given. One thing, one row.
 *
 * The bytes that were there are copied to work/<id>/.prev first, which is not
 * the library and is never listed anywhere. Nothing reads it; it exists because
 * these files cost generations.
 *
 * keepCopy asks for the old behaviour and names the copy <name>-<suffix>. Only
 * the compare panel uses it, where the point IS to hold two versions at once.
 * An animated item arrives with every frame handled identically, so its loop
 * stays in register.
 */
export const assetCrop = (
  id: string,
  name: string,
  rect: { x: number; y: number; w: number; h: number } | null,
  o: {
    kind: 'static' | 'animated'
    frames: string[]
    fps?: number
    suffix?: string
    keepCopy?: boolean
    /* when the item is a set of VIEWS, what each frame is called. Without it an
     * edited view set would be written back as animation frames and stop being
     * a view set at all. */
    dirKeys?: string[] | null
  },
) => jpost<{ item: LibItem }>('/api/asset-crop', { id, name, rect, ...o })

// takes one item out of this map's library for good: the png for a static
// item, the frame folder for an animated one. The file deletion is not
// undoable; the ui clears the item's placements through the editor, so that
// part is.
export const libraryRemove = (id: string, name: string) =>
  jpost<{ removed: 'static' | 'animated' }>('/api/library-remove', { id, name })

// the cut-applied painting on its own, so a map can be cut and staged before
// any mechanics are drawn. Writes scene-cut.png, and cut.png so it reopens.
export const saveCutPNG = (id: string, image: string, cut: string) =>
  jpost<{ dir: string; files: string[] }>('/api/savecut', { id, image, cut })

export const exportBundle = (b: unknown) => jpost<{ dir: string; files: string[] }>('/api/export', b)

/* The map's own state, mirrored to disk on the same beat as the browser
 * autosave. Export is a different job: it is the bundle the game reads, it is
 * lossy about the editor's state, and it should not be the only way work leaves
 * the browser. This is the save. The payload is the exact string the doc
 * serializes to, so nothing here has to understand the format. */
export const saveDoc = (id: string, doc: string) => jpost<{ bytes: number }>('/api/doc', { id, doc })

export const loadDoc = (id: string) => jget<{ doc: string }>('/api/doc/' + encodeURIComponent(id))
