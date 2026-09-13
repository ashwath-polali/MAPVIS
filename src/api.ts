/* Calls to the local node side. Nothing here knows a key. */
import type { CustomControl } from './core/customfx'

/* KEEPALIVE CANNOT CARRY AN EXPORT. The fetch standard caps a keepalive body at 64 KiB and a browser refuses an over-quota one outright: measured in the browser, 60 KiB reaches the server and 64 KiB rejects with TypeError in four milliseconds. A map's bundle is about half a megabyte, so with the flag set unconditionally no press ever puts a byte on the wire and nothing says why. It is honoured only when the payload fits. */
const KEEPALIVE_MAX = 60 * 1024

/* A REQUEST THAT NEVER ANSWERS HAS TO BECOME AN ERROR, because a promise that never settles is not a slow call, it is a dead button: doExport holds a flag while it waits, so one interrupted export left every later press returning without making a request. This is the floor under the SHORT calls only, and the map below carries the long ones; it catches never, not slow, and what it must never do again is catch a generation that is still being drawn. */
const POST_TIMEOUT_MS = 180_000

/* BUT THREE MINUTES IS SHORTER THAN THE WORK, AND THAT COST REAL MONEY. This one ceiling governed
 * every call, and an eight-heading animation is eight background jobs that take about five minutes
 * together, so the browser gave up while pixellab was still drawing. The generations were bought,
 * the server finished and saved them minutes later, and the author was told "did not answer within
 * 180s" and pressed again, which bought all eight a second time. Measured on the account: four
 * eight-way runs in thirty-one minutes, thirty-two generations, every job completed, none collected.
 *
 * So the deadline belongs to the route and not to the transport. These are the calls whose server
 * side legitimately outlives three minutes, each set past the ceiling the server itself waits to plus
 * the downloads after it, so the browser is never the first to give up. The server's own numbers are
 * CHAR_WAIT 600s, WALK_WAIT 900s and HOST_WAIT 230s, in server/api.mjs.
 *
 * None of this beats the host, which cuts a function at 300s whatever is written here (vercel.json,
 * maxDuration) and answers with its own page rather than json. That is why the read below cannot
 * assume a body parses, and why HOST_WAIT exists at all: on the host the answer to a long fan-out is
 * a receipt to collect later, never a longer wait.
 *
 * Everything absent from this map keeps the three minutes, which is what it was written for. */
const SLOW_POSTS: Array<[string, number]> = [
  /* a sprite is the body and then up to eight walk cycles in ONE request: CHAR_WAIT 600s plus
   * WALK_WAIT 900s plus sixty-four downloads after them. 960s was under the server's own sum, so the
   * browser was still the first to give up on the most expensive thing in the tool. */
  ['/api/character-gen', 1_620_000],
  ['/api/character-import', 960_000],
  // a motion on an existing rig: the free plan read, then WALK_WAIT 900s of fan-out, then 64 frames
  ['/api/asset-animate', 1_200_000],
  // one object, then an animation of it: two sequential waits of up to 300s each
  ['/api/asset-anim', 660_000],
  ['/api/asset-gen', 360_000],
  ['/api/asset-gen-here', 360_000],
  // one edited rotation set, which is every heading in a single job
  // awaitCharacter's own 600s, and then every heading comes down
  ['/api/asset-state', 720_000],
  ['/api/account-import', 360_000],
  // the planner reads a painting and reasons about it
  ['/api/asset-plan', 300_000],
  ['/api/scene-plan', 300_000],
  ['/api/life-plan', 300_000],
  ['/api/style-card', 300_000],
  ['/api/translate', 300_000],
  ['/api/generate', 600_000],
  ['/api/propose', 300_000],
]
const deadlineFor = (url: string) => {
  const hit = SLOW_POSTS.find(([p]) => url === p || url.startsWith(p + '/'))
  return hit ? hit[1] : POST_TIMEOUT_MS
}

async function jpost<T>(url: string, body: unknown, opts?: { keepalive?: boolean }): Promise<T> {
  const payload = JSON.stringify(body)
  const ms = deadlineFor(url)
  const cut = AbortSignal.timeout(ms)
  let r: Response
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: cut,
      ...(opts?.keepalive && payload.length <= KEEPALIVE_MAX ? { keepalive: true } : {}),
    })
  } catch (e) {
    // name the wait, because "failed to fetch" sends the next person looking at
    // the server when the server may never have been asked
    if (e instanceof DOMException && e.name === 'TimeoutError')
      throw new Error(`${url} did not answer within ${ms / 1000}s`)
    throw e
  }
  /* A GATEWAY DOES NOT ANSWER IN JSON. The host cuts a function at 300s and sends its own page, and
   * r.json() on that throws out of the parser before the status is looked at, so a wait that ran out
   * reads as a bug in this file. Only reachable now that the paid routes are allowed past three
   * minutes, because until then the abort above always answered first. */
  const raw = await r.text()
  let j: unknown
  try {
    j = raw ? JSON.parse(raw) : {}
  } catch {
    throw new Error(
      r.ok
        ? `${url} answered with ${raw.length} characters that are not json`
        : `${url} was cut off before it answered · whatever it had already bought is on the account, so collect it rather than pressing again`,
    )
  }
  const o = (j || {}) as { error?: string }
  if (!r.ok || o.error) throw new Error(o.error || r.statusText)
  return j as T
}

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url)
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error || r.statusText)
  return j as T
}

export const balance = () => jget<{ usd?: number }>('/api/balance')

/* WHOSE HAND A MAP IS DRAWN BY. A card carries the craft sentence: projection,
 * cluster size, outline, light and saturation, and nothing about the subject.
 * The house card is one account's and is offered only where it has been granted,
 * so a stranger signing up is never handed it. */
export interface StyleCard {
  key: string
  title: string
  clause: string
  house: boolean
  ref: string
}

export const styles = () =>
  jget<{
    cards: StyleCard[]
    fallback: string
    kinds: { kind: string; canvas: { w: number; h: number } }[]
    grants?: string[]
  }>('/api/styles')

/* the words that would be sent, written but not bought, so the hand can be read
 * before anything is spent on it */
export const mapPrompt = (subject: string, style: string, kind?: string) =>
  jpost<{ prompt: string; kind: string; style: string; canvas: { w: number; h: number }; parts: string[] }>('/api/map-prompt', {
    subject,
    style,
    kind,
  })

/* the choice, kept on the map so every asset made for it afterwards and every
 * republish are drawn by the same hand */
export const setMapStyle = (id: string, style: string, kind?: string) =>
  jpost<{ style: string; kind: string }>('/api/map-style', { id, style, kind })

/* the house hand handed to somebody else, and taken back. The owner alone, and
 * the list that comes back is who may draw with it now. */
export const grantHand = (email: string, revoke?: true) =>
  jpost<{ email: string | null; granted: string[] }>('/api/styles/grant', { email, revoke })

export const styleFromMap = (from: string, title?: string) =>
  jpost<{ card: StyleCard }>('/api/styles/mine', { from, title })

export const generate = (prompt: string, n: number, w: number, h: number, style?: string, kind?: string) =>
  jpost<{ jobs: { id?: string; seed?: number; error?: string }[]; prompt?: string; style?: string; kind?: string }>('/api/generate', {
    prompt,
    n,
    w,
    h,
    style,
    kind,
  })

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
  /* what the AUTHOR called this thing. The id beside it is a counter MAPVIS made
   * up and does not survive a delete and a re-place, so this is the only address
   * an anchor binding, a variant member or a member's python can hold. */
  name?: string
  group?: string
  /* WHEN THIS THING IS THERE AT ALL, resolved at export from the placement's own
   * condition or its group's. An opaque string: MAPVIS declares it and python
   * decides what it means. */
  when?: string
  /* what each face is called, indexed the way art indexes them: slot 0 is the placement's own picture. An empty string holds its slot, because dropping one would shift every later index down. Absent on every bundle exported before it existed. */
  lookNames?: string[]
  src?: string
  frames?: string[]
  fps?: number
  /* one view per heading, keyed by the eight names the walk-test frames use, each
   * one a list of bundle-relative paths inside a single folder. Written for
   * anything that has to face where it is going. */
  dirs?: Record<string, string[]>
  /* how it MOVES, if it does: a core/life.ts Life, written through untouched by
   * the exporter. Off the wire, so it is only a Life once cleanLife says so. */
  life?: unknown
  /* the extra appearances a sequence switches to, index 1 and up, each written
   * in the same shape as the entry itself. Absent on everything that does not
   * change, and a reader that has never heard of them draws the entry. */
  looks?: { src?: string; frames?: string[]; fps?: number; dirs?: Record<string, string[]>; name?: string }[]
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
/* A FACE this row has been given: the same thing edited into another state, not a second thing that looks like one. It keeps the library's three shapes because a state of a walking character IS eight headings, or a troll snaps round to face south the instant it becomes a boulder. Deliberately NOT a LibItem: a library that fills with boulder, boulder-2, sleeping-dragon is a library of rows that mean nothing alone. */
export interface AssetState {
  name: string
  src?: string
  frames?: string[]
  dirs?: Record<string, string[]>
  fps?: number
  w: number
  h: number
}

export interface LibItem {
  name: string
  kind: 'static' | 'animated'
  /* the faces it can wear, each one an edit of this row's own art */
  states?: AssetState[]
  /* whether another face can be made at all. False for anything imported off the account or edited by hand, which has no pixellab id on record, and every state endpoint keys off that id. Saying so on the button beats finding out at spend time. */
  canState?: boolean
  // an animated item that carries effect.json: the tuning panel can reopen it
  effect?: boolean
  src?: string
  frames?: string[]
  fps?: number
  /* one view per heading, for something that has to face where it is going.
   * Keys are the eight names the walk-test frames use. Absent on almost
   * everything: a crab is two apparent directions and a flip covers it. */
  dirs?: Record<string, string[]>
  w: number
  h: number
}
export const library = (id: string) => jget<{ items: LibItem[] }>('/api/library/' + encodeURIComponent(id))

/* Put an item's previous pixels back, out of the copy every in-place edit keeps. Free. z only ever undid the placement half of a crop, which left art cropped and everything standing on it moved back, and that reads as the whole map having shifted. */
export const assetRevert = (id: string, name: string) =>
  jpost<{ item: LibItem }>('/api/asset-revert', { id, name })

/* TAKE THE ANIMATION OFF A THING, OR PUT IT BACK. Free both ways: the frames are already bought
 * and go to the kept copies rather than to the bin. Off leaves the first frame as an ordinary
 * picture, and for a set of headings leaves the standing rotation, so it still faces where it
 * walks. On puts back the newest frames kept for that name. Deliberately not assetRevert, which
 * steps back one version whatever that version is: an author who cropped after animating asked to
 * stop the movement and got the uncropped picture. */
export const assetAnimation = (id: string, name: string, on: boolean) =>
  jpost<{ item: LibItem; plays: boolean }>('/api/asset-animation', { id, name, on })

/* ONE generation: this thing, edited into another face. The endpoint edits the art already on the account, which is what makes the face match the thing it belongs to, and for a character it edits all 4 or 8 rotations in one job so the swap keeps its heading. */
export const assetState = (
  id: string,
  name: string,
  ask: string,
  o?: { state?: string; seed?: number; job?: string },
) => jpost<{ item: LibItem | null; face: string }>('/api/asset-state', { id, name, ask, ...o })

// ---- what the account already owns --------------------------------------

// The objects on the pixellab account, browsable: 700 already sitting there, and the ones written in the house style beat anything a fresh ask comes back with. Picking one costs nothing, and thumb is pixellab's own public preview url.
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

// What this map looks like, read off the painting ONCE and kept on disk. The ask has never carried the map's look, so tropical palm trees came back generic bright green. clause is the deliverable, one phrase that hangs off any sprite description. FREE, and a scene that never answers just goes without.
export interface StyleCard {
  palette: string
  light: string
  outline: string
  scale: string
  clause: string
}
export const styleCard = (id: string, image: string, refresh = false, job?: string) =>
  jpost<{ card: StyleCard; cached: boolean }>('/api/style-card', { id, image, refresh, job })

// the ask interpreter alone, free: called at arm time so the confirm button can show exactly what will be drawn before anything spends. belongs is how much the thing should look like it came off this map, and the style clause is appended server-side only at or above 0.5, so the will-draw line reads belongs to say which happened.
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

// ONE pixellab generation into this map's library, only ever after an explicit cost confirm. name pins the filename and seed pins the starting noise, so several takes of one prompt land as distinct pictures. thing/tw/th carry the CONFIRMED translation verbatim, so what the button showed is what runs.
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
    /* A crop of the painting, once sent so pixellab would draw into this map's art. Nothing sends it: measured over twenty-two generations in both modes the schema allows, that endpoint continues the picture it is handed instead of drawing the subject into it. Kept only because the route still accepts one. */
    background?: string
    // a generation already asked for is already paid for, so what a stop buys
    // is the one NOT yet asked for. The server checks the job before it sends.
    job?: string
  },
) => jpost<{ item: LibItem }>('/api/asset-gen', { id, prompt, ...o })

/* ---- characters: people and animals. Pixellab's own distinction and it matters: an OBJECT is a prop, a CHARACTER has a skeleton, 4 or 8 directions and walk cycles. Their docs say plainly not to use the eight-direction object endpoint for a person, and it answers with a generic character rather than the one asked for. Both calls here are free. */
export interface AccountCharacter {
  id: string
  name: string
  directions: number
  animations: number
  size: string
  // which camera it was drawn for; blank when the account did not say
  view: string
  thumb: string
}
export const accountCharacters = () =>
  jget<{ items: AccountCharacter[]; total: number }>('/api/account-characters')

/* One character into this map's library, WITH its walk cycle when it has one.
 * What lands is one entry per heading with frames inside, which is the shape
 * the renderers already understand. */
export const characterImport = (id: string, sceneId: string, o?: { name?: string; animation?: string }) =>
  jpost<{ item: LibItem }>('/api/character-import', { id, sceneId, ...o })

/* A NEW sprite, made rather than picked, and the only paid call on this half. An object endpoint given a body answers with a generic character instead of the one asked for, which is pixellab's own warning; a sprite is generated off a skeleton, which is what makes eight views of the SAME body possible. The price: one generation for the body, then ONE PER DIRECTION for the motion, so eight-way moving is nine, and two to five minutes for the body alone. confirm true is the server's gate, so a reload cannot spend, and a stop between the body and its motion is worth eight generations. skeleton, view, size and anim are the router's answer carried through verbatim. note carries a motion that did not happen, because the body is bought the moment it is asked for. */
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
    /* ONE OF YOUR OWN EIGHT-WAY CHARACTERS, whose rotations guide every direction of this one. Pro only, and how a new person comes back built like your own character instead of like the template rig: four standard-mode principals were flat upright humanoids whatever the words said. */
    styleCharacterId?: string
  },
) => jpost<{ item: LibItem; note?: string }>('/api/character-gen', { id, ...o })

/* ---- the ask, read with the map open. One call, the only one before a generation: handed the painting itself and the boxed area at 2x, it answers the WHOLE generator prompt plus the pixel size measured against what is already on the map. It replaced a translator, a style card, a prompt assembled in code, a ground-word filter and a pixel trimmer, all of which existed because the map was compressed to eighteen words first. It is also the ROUTER, because a list of creatures is always shorter than what somebody wants to make and a dragon does not walk. FREE and stoppable. */

// how the sprite moves. template is one of pixellab's named humanoid cycles; action is written prose for anything a template cannot say, which is most of what is interesting: hovering, lurching, servos idling.
export interface SpriteAnim {
  how: 'none' | 'template' | 'action'
  template?: string
  action?: string
  // only on the written path. 4..16, even.
  frames?: number
}
/* Pixellab builds a sprite off a skeleton and there are exactly six: the upright mannequin and five four-legged bodies. Anything else maps onto the NEAREST by body plan, and the skeleton never leaks into the words, so a mannequin-rigged patrol robot still reads as a machine. */
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
  /* WHERE ON THE MAP this thing belongs: the patch of painting whose light and surface it should have been painted under, not where it will be placed. It rides as pixellab's background_image, the one lever measured to beat the generator's own idea of what a noun looks like. */
  where?: { x: number; y: number; w: number; h: number } | null
  /* THE REST OF ONE SENTENCE, split by the router so one press can do all of it: somebody describing a creature describes what it does in the same breath, and what it does can need pictures that do not exist yet. Splitting it here moves the faces-before-rounds rule to the side that knows it. Both are usually absent. */
  faces?: { name: string; edit: string }[]
  does?: string
  /* HOW MANY DIFFERENT THINGS the ask is asking for. The generator draws every noun it is given, so "a few crates" bought a single picture of a pile. Absent or 1 is every ask the tool had until now, so the single path does not move; above 1 the client carries the same free press on into scenePlan. */
  count?: number
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

/* ---- give a placement life. Free. What comes back is numbers saying how the thing MOVES, not animation frames, because every effect has to loop and a wander that returns to its start is a dance. bounds is the drawn box and skipping it is a real answer. names is what this map's library holds: without the list the answer was invented names, every art index landed on 0, and the sequence changed timing and movement and never the picture. */
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
    // every library item this map has, by name. The server picks from these
    // and never names anything else.
    names?: string[]
    /* the LIBRARY ROW this placement is drawn from. When that row has faces of its own the server offers those instead of the library, so a sequence picks between the pictures THIS thing can wear. That is what makes "which boulder" not a question. */
    owner?: string
    job?: string
  },
) => jpost<{ life: unknown; note: string; looks?: string[] }>('/api/life-plan', { id, ask, ...o })

export const stop = (job: string) => jpost<{ stopped: boolean }>('/api/stop', { job })

/* A whole boxed area planned in one look: what belongs in it and where each thing stands. Free and stoppable. Positions come back in the box's own pixels, feet-anchored. Nothing generates until the list has been seen. */
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

// ONE pixellab generation WITH context, same price class as assetGen: crop is a square of the cut painting around the chosen spot, up to 160px, so the asset comes back drawn in that spot's palette and light. note is the same disclosure characterGen carries, because a stop between the base and its frames files the base as a still object.
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

// TWO pixellab generations behind one confirm: a transparent base sprite, then its 8-frame animation. The server's ask interpreter splits the one prompt into thing plus movement words, because scene words in the motion bleed objects into the sprite: asking for smoke draws the volcano it belongs to. note carries a motion that did not happen, or the user gets a still where they asked for a moving one with nothing saying why.
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

/* ---- making a thing that is already in the library MOVE, without paying to generate it a second time. The user types what it should do and the server routes it, because a list of animations is always shorter than what somebody wants. Four paths, priced differently: `character` puts every heading through ONE coordinated job, because eight separate calls come back as eight rhythms and a figure would breathe faster facing north; `sprite` is one generation; `written` costs NOTHING and is named rather than run, because neither generator can carry a sprite anywhere; `blocked` refuses instead of selling a defect. Everything but written rewrites the item IN PLACE, staged under .stage with the replaced bytes going to work/<id>/.prev. ONE route, two presses: the free read answers the plan and the true price, and the price is re-derived server-side so a client cannot talk it down. */
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
/* The read has no confirm and buys nothing; the confirmed press hands the plan straight back so what was priced is what runs. What comes back: { plan } from a read, { item, note } from a run that drew, { plan, free: true } from a confirmed written path. */
export const assetAnimate = (
  id: string,
  o: {
    name: string
    ask: string
    plan?: AnimPlan
    confirm?: true
    job?: string
    /* collect frames a previous press already paid for instead of drawing again: the host answers pending with the group it started when a generation outlives its function budget, and sending that group back finishes the job for free. */
    recover?: true | string
  },
) =>
  /* `partial` is set when a heading's own job failed and it kept its standing
   * frame. The set is whole and it walks; one of its headings does not move,
   * which is worth saying rather than leaving to be found on the map. */
  jpost<{ plan?: AnimPlan; item?: LibItem; note?: string; free?: boolean; pending?: boolean; group?: string; partial?: string }>(
    '/api/asset-animate',
    {
      id,
      ...o,
    },
  )

// ---- the effect engine --------------------------------------------------

// Which motion rule fits the ask, what numbers to start it at, and WHOSE COLOURS it is made of: palette 'map' is the sampled painting, 'own' is the only way a purple portal on a brown island is purple. FREE, and it answers from a keyword match when the planner is unreachable so it never hard-fails. type "custom" is the eighth answer and carries a WRITTEN renderer run in the core/customfx sandbox, still free.
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

// The frames the client just rendered, laid out as one strip on disk and LOOKED AT. verdict good means ship it; revise carries a replacement body or better numbers. FREE every pass, and strip is the absolute path of what was looked at, so a failure can be seen rather than guessed at.
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

// The generated candidates side by side, LOOKED AT: which one and why. fix is set only when none are usable and costs generations, so it stays behind the armed confirm. Looking itself is free.
export interface ObjVerdict {
  strip: string
  best: number
  why: string
  fix: string
  /* Whether what came back ANSWERS THE ASK, which best on its own cannot say: best is clamped into 1..n, so a row of things that are all wrong still comes back with one praised. Absent reads as good, the same default the effect loop takes. */
  verdict?: 'good' | 'revise'
}
/* An options object, not a positional list: five ordered arguments mean counting out every call site the day the look is given something more to judge with. */
export const objReview = (o: {
  id: string
  ask: string
  prompt: string
  frames: string[]
  /* the real size of every candidate on the strip, in map pixels. The strip is blown up 3x to be visible, so without this the look cannot tell a sprite drawn at the map's chunky pixel from one drawn finer. */
  w?: number
  h?: number
  job?: string
}) => jpost<ObjVerdict>('/api/obj-review', o)

// one KEPT thing, appended to work/<id>/keeps.json. Only keeps, never discards.
export const keepNote = (
  id: string,
  o: { ask: string; prompt: string; name: string; kind: 'asset' | 'effect' },
) => jpost<{ n: number }>('/api/keep-note', { id, ...o })

// The frames the client rendered, written as an animated library item plus effect.json beside them so the rule, its numbers and the sampled colours reopen later. Free. overwrite keeps the name and the frame urls, so every placement plays the new render untouched.
export const effectSave = (
  id: string,
  name: string,
  frames: string[],
  meta: unknown,
  overwrite = false,
  ask = '',
) => jpost<{ item: LibItem }>('/api/effect-save', { id, name, frames, meta, overwrite, ask })

// Every ask this map has been given, newest first. Free, read-only, and the
// answer to "what did I type to get that". A record, not an input.
export interface Ask {
  name: string
  // character is here so a past ask reopens in the mode that made it: without it a sprite came back in the object box, which draws a prop of a body. The on-disk word stays 'character' so old asks.json rows replay.
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

/* Pixels the client already holds, written back to the item IN PLACE. An edit that lands as a second row leaves palm, then palm-trimmed, then palm-matched, and a library of near-identical rows is worse than whatever each edit corrected. The replaced bytes go to work/<id>/.prev, which is never listed, because these files cost generations. keepCopy asks for a second row instead, and only the compare panel uses it. */
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

// takes one item out of this map's library for good. The file deletion is not undoable; the ui clears the item's placements through the editor, so that part is.
export const libraryRemove = (id: string, name: string) =>
  jpost<{ removed: 'static' | 'animated' }>('/api/library-remove', { id, name })

// the cut-applied painting on its own, so a map can be cut and staged before
// any mechanics are drawn. Writes scene-cut.png, and cut.png so it reopens.
export const saveCutPNG = (id: string, image: string, cut: string) =>
  jpost<{ dir: string; files: string[] }>('/api/savecut', { id, image, cut })

export const exportBundle = (b: unknown) =>
  jpost<{ dir: string; files: string[]; published?: { version: number } }>('/api/export', b, { keepalive: true })

/* The map's own state, saved to the platform on the same beat as the browser autosave. Export is a different job and should not be the only way work leaves the browser. savedAt is the server's clock, not this browser's, and it decides which copy wins; wrote says which halves actually changed. */
export const saveDoc = (id: string, doc: string) =>
  jpost<{ bytes: number; savedAt?: number; wrote?: string[] }>('/api/doc', { id, doc })

export const loadDoc = (id: string) =>
  jget<{ doc: string; savedAt?: number; from?: string }>('/api/doc/' + encodeURIComponent(id))

/* Give a map a different id. It is the publish slug, every door's target, the objective's map field and the save key at once. The server carries the doors that point here over and says how many it moved, and refuses a slug somebody already has, because a door names one as a bare string with no owner in it. */
export const renameMap = (from: string, to: string) =>
  jpost<{ slug: string; repointed: number }>('/api/map-rename', { from, to })
