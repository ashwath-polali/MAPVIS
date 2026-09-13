/* pixellab, server side only, and the token never leaves this process; GET /v2/openapi.json is free and names every route and field, so read it rather than guessing or probing */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { currentPixellabKey } from './store/ctx.mjs'
import { env } from './db/env.mjs'

const BASE = 'https://api.pixellab.ai'
let cached = null

export class NoPixellab extends Error {
  constructor() {
    super('generation needs a pixellab key · add one in your account')
    this.name = 'NoPixellab'
    this.needs = 'pixellab'
  }
}

/* the signed-in account's own key always comes first, because a machine-wide token bills every new account's generations to whoever owns it */
export function token() {
  const mine = currentPixellabKey()
  if (mine) return mine
  if (cached) return cached
  // env() and not process.env: .env is read into a merged object and never
  // exported into the process, so reading process.env here finds nothing on a
  // laptop and generation fails as though no key were set.
  const E = env()
  if (E.PIXELLAB_TOKEN) return (cached = E.PIXELLAB_TOKEN)
  try {
    const p = E.PIXELLAB_TOKEN_FILE || path.join(os.homedir(), '.mapvis.json')
    const d = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (d.pixellabToken) return (cached = String(d.pixellabToken))
  } catch {
    /* no home directory, which is every hosted environment */
  }
  throw new NoPixellab()
}

async function call(method, route, body) {
  const r = await fetch(BASE + route, {
    method,
    headers: {
      Authorization: 'Bearer ' + token(),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`pixellab ${r.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

export const balance = () => call('GET', '/v1/balance')

/* built without sending it, because a request only readable by paying for it is never checked; additionalProperties is false so one stray field is a 422, style_image is a ReferenceImage and not the bare Base64Image the ui route takes, and this route has no view, camera or element parameter at all */
export function imageBody({ prompt, w, h, seed, styleImage, styleOptions, noBackground = false }) {
  const body = {
    description: prompt,
    image_size: { width: w, height: h },
    no_background: noBackground,
  }
  if (seed != null) body.seed = seed
  if (styleImage) {
    body.style_image = { image: { type: 'base64', base64: styleImage.base64 }, size: { width: styleImage.w, height: styleImage.h } }
    /* the four style aspects are independent, because a map usually wants another map's outline and shading while keeping its own palette */
    body.style_options = {
      color_palette: true, outline: true, detail: true, shading: true,
      ...(styleOptions || {}),
    }
  }
  return body
}

export async function submit({ prompt, w, h, seed, styleImage, styleOptions }) {
  const out = await call('POST', '/v2/generate-image-v2', imageBody({ prompt, w, h, seed, styleImage, styleOptions }))
  return out.background_job_id
}

// nothing calls this: pixflux paints a freeform illustration and stands whatever it is given on an invented plinth, so a palm came back on a stone slab
export async function pixflux({ description, w = 96, h = 96, seed }) {
  const body = {
    description,
    image_size: { width: w, height: h },
    no_background: true,
  }
  if (seed != null) body.seed = seed
  const out = await call('POST', '/v1/generate-image-pixflux', body)
  const imgs = collect(out)
  if (!imgs.length) throw new Error('pixflux returned no image')
  return imgs[0]
}

// map-objects is the route the 47 good objects were made on, non-square with a low top-down view, and it bills like one generation
/* never send background_image or color_image: measured over 22 generations, this endpoint CONTINUES a picture it is given instead of drawing into it, and a bookshelf came back as roof tiles */
export async function mapObject({ description, w, h, view = 'low top-down', seed }) {
  /* both sides even, because an odd one is a hard 422 raised only after the router has spent thirteen seconds choosing the size */
  const even = (n) => Math.max(32, Math.floor(Number(n) / 2) * 2)
  const req = {
    description,
    image_size: { width: even(w), height: even(h) },
    view,
  }
  if (seed != null) req.seed = seed
  const out = await call('POST', '/v2/map-objects', req)
  if (!out.object_id) throw new Error('map-objects returned no object id')
  // typical generation time is 15-30 seconds; give it five minutes
  for (let waited = 0; waited < 300000; waited += 5000) {
    await new Promise((r) => setTimeout(r, 5000))
    const r = await fetch(BASE + '/v2/map-objects/' + encodeURIComponent(out.object_id), {
      headers: { Authorization: 'Bearer ' + token() },
    })
    if (r.status === 423) continue // still generating
    const text = await r.text()
    if (r.status === 410) throw new Error('generation failed: ' + text.slice(0, 200))
    if (!r.ok) throw new Error(`pixellab ${r.status} ${text.slice(0, 300)}`)
    const j = text ? JSON.parse(text) : {}
    if (j.status === 'failed') throw new Error(j.error || 'generation failed')
    if (j.status === 'completed' && j.download_url) {
      const png = await fetch(j.download_url)
      if (!png.ok) throw new Error('cutout download failed ' + png.status)
      /* the object id comes back too, because every state endpoint keys off it and once the bytes are on disk there is no way back to it */
      return { b64: Buffer.from(await png.arrayBuffer()).toString('base64'), objectId: out.object_id }
    }
  }
  throw new Error('generation timed out')
}

/* the ui route is POST /v2/create-ui-asset, additionalProperties false so one stray field is a 422, the poll is 200 throughout and the picture is image_url; the five aspect gates do not combine so 688x512 is refused after the send, both sides start at 192, and it draws panels and only panels */
export const UI_GATES = [
  [16 / 9, 688, 384],
  [9 / 16, 384, 688],
  [4 / 3, 600, 448],
  [3 / 4, 448, 600],
  [1, 512, 512],
]

export function fitUi(w, h) {
  const want = Math.max(1, Number(w) || 256) / Math.max(1, Number(h) || 256)
  // nearest gate by ratio, because the caller asked for a shape rather than for
  // one of five names and should get the closest legal one
  const [, maxW, maxH] = UI_GATES.reduce((best, g) => (Math.abs(Math.log(g[0] / want)) < Math.abs(Math.log(best[0] / want)) ? g : best))
  const k = Math.min(1, maxW / Math.max(1, w), maxH / Math.max(1, h))
  return {
    width: Math.max(192, Math.min(maxW, Math.round(w * k))),
    height: Math.max(192, Math.min(maxH, Math.round(h * k))),
  }
}

/* the twelve element names are fenced here because the api types them as plain strings, so a typo reaches the handler and spends instead of returning a 422 */
export const UI_ELEMENTS = [
  'button', 'icon_button', 'toolbar', 'tab', 'panel', 'window',
  'health_bar', 'avatar', 'triangle', 'pentagon', 'hexagon', 'octagon',
]

/* the three template shapes, on a virtual canvas whose longer side spans 0 to 512 and not the output size, refused here because anything else is a 422 */
const PIECE_KINDS = { rounded_rect: ['x', 'y', 'w', 'h'], circle: ['x', 'y', 'r'], polygon: ['x', 'y', 'r', 'sides'] }

/* the body is built without sending it and uiAsset calls this, so a dry run and a real one cannot diverge and a spend is never what tells anybody what the request looked like */
export function uiAssetBody({ description, width = 256, height = 256, palette, elements, pieces, styleImageBase64, seed, name }) {
  const say = String(description || '').trim()
  if (!say) throw new Error('a surface needs a description')
  const size = fitUi(width, height)
  /* the size is nested, because top-level width and height come back extra_forbidden under additionalProperties false */
  const req = {
    description: say.slice(0, 2000),
    /* only ever probe this api by omitting a REQUIRED field: `image_size: {}` defaults to 256x256, draws and is charged for, which cost 40 generations */
    image_size: { width: size.width, height: size.height },
    // chrome sits on top of a map, so it is cut out for the same reason every
    // map object is: anything opaque behind it is a rectangle of somebody
    // else's idea of a background painted over the island
    no_background: true,
  }
  if (palette) req.color_palette = String(palette).slice(0, 200)
  if (Array.isArray(elements) && elements.length) {
    const want = elements.map((s) => String(s).trim()).filter(Boolean)
    const unknown = want.filter((s) => !UI_ELEMENTS.includes(s))
    if (unknown.length)
      throw new Error(`the generator has no element called "${unknown[0]}" · it scaffolds from ${UI_ELEMENTS.join(', ')}`)
    req.elements = want
  }
  /* one press draws one piece, refused here as well as at the route because a batch turns one bad prompt into five paid-for bad pictures */
  if (Array.isArray(pieces) && pieces.length) {
    if (pieces.length > 1) throw new Error(`one press draws one piece, and this asked for ${pieces.length}`)
    /* a list of names is not a list of shapes: each piece is an object with an id, a kind and that kind's coordinates, and a bare string is a 422 */
    const one = pieces[0]
    const need = one && typeof one === 'object' && !Array.isArray(one) ? PIECE_KINDS[one.kind] : null
    if (!need)
      throw new Error(`a shape has to say what kind it is · ${Object.keys(PIECE_KINDS).join(', ')}`)
    if (!one.id || need.some((k) => !isFinite(Number(one[k]))))
      throw new Error(`a ${one.kind} needs an id and ${need.join(', ')}, on a canvas whose longer side runs 0 to 512`)
    req.pieces = pieces
  }
  /* a style image transfers material and no layout at all, so it cannot fix ornament landing in the middle of an edge; it is a Base64Image object and a bare string is extra_forbidden */
  if (styleImageBase64) req.style_image = { type: 'base64', base64: String(styleImageBase64), format: 'png' }
  if (seed != null) req.seed = seed
  if (name) req.name = String(name).slice(0, 60)
  return req
}

export async function uiAsset(ask) {
  const req = uiAssetBody(ask)
  const out = await call('POST', '/v2/create-ui-asset', req)
  const id = out.ui_asset_id
  if (!id) throw new Error('the surface was queued without an id to collect it from')

  /* no 423 and no 410 on this route, it answers 200 all the way through, and a 404 does not end the wait because the row is not queryable the instant the post answers */
  let misses = 0
  for (let waited = 0; waited < 300000; waited += 5000) {
    await new Promise((r) => setTimeout(r, 5000))
    const r = await fetch(BASE + '/v2/ui-assets/' + encodeURIComponent(id), {
      headers: { Authorization: 'Bearer ' + token() },
    })
    const text = await r.text()
    if (r.status === 404 && ++misses < 3) continue
    if (!r.ok) throw new Error(`pixellab ${r.status} ${text.slice(0, 300)}`)
    misses = 0
    const j = text ? JSON.parse(text) : {}
    const st = String(j.status || '').toLowerCase()
    if (DEAD.includes(st)) throw new Error(String(j.error || j.message || 'the surface failed to draw').slice(0, 200))
    if (j.image_url) {
      /* fetched the instant it exists, because the cdn url is not promised forever and a paid surface must not be lost to a slow caller */
      return {
        b64: (await fetchPNG(j.image_url)).toString('base64'),
        uiAssetId: String(id),
        // off the request that was actually sent rather than off what the caller
        // asked for, because uiAssetBody fits the canvas to an aspect gate and
        // 688x512 leaves here as 600x448
        width: Number(j.size?.width) || req.image_size.width,
        height: Number(j.size?.height) || req.image_size.height,
      }
    }
  }
  throw new Error('the surface timed out')
}

/* sheets come here because create-ui-asset draws panels whatever it is asked for, and a family stays one job or it comes back at different weights; this route's floor is 171 on the long side, under which it returns a grid of variants of one mark instead of one picture */
export const SHEET_ONE_IMAGE = 171

/* the ceiling is UI_GATES because that table is the measured one and the schema only says the maximum depends on aspect ratio */
export function fitSheet(w, h) {
  const W = Math.max(1, Math.round(Number(w) || 384))
  const H = Math.max(1, Math.round(Number(h) || 384))
  const want = W / H
  const [, maxW, maxH] = UI_GATES.reduce((best, g) => (Math.abs(Math.log(g[0] / want)) < Math.abs(Math.log(best[0] / want)) ? g : best))
  const down = Math.min(1, maxW / W, maxH / H)
  let width = Math.max(16, Math.min(maxW, Math.round(W * down)))
  let height = Math.max(16, Math.min(maxH, Math.round(H * down)))
  // and up over the one-image line, because under it the answer is a grid of
  // variants rather than the one canvas the face cut is arithmetic against
  const long = Math.max(width, height)
  if (long < SHEET_ONE_IMAGE) {
    const up = SHEET_ONE_IMAGE / long
    width = Math.min(maxW, Math.ceil(width * up))
    height = Math.min(maxH, Math.ceil(height * up))
  }
  return { width, height }
}

/* Split from the post for the reason uiAssetBody is: the dry run has to be able
 * to show what would be sent without sending it, and a second copy of the
 * assembly would prove nothing about the copy that spends. */
export function sheetBody({ description, width = 384, height = 384, styleImage, styleOptions, seed }) {
  const say = String(description || '').trim()
  if (!say) throw new Error('a sheet needs a description')
  const size = fitSheet(width, height)
  return imageBody({
    // the schema's own ceiling, the same 2000 the ui route carries
    prompt: say.slice(0, 2000),
    w: size.width,
    h: size.height,
    seed,
    styleImage,
    styleOptions,
    // passed anyway even though it defaults true, because the default is the endpoint's and a default is not a decision
    noBackground: true,
  })
}

export async function sheetImage(ask) {
  const req = sheetBody(ask)
  const out = await call('POST', '/v2/generate-image-v2', req)
  const id = out.background_job_id
  if (!id) throw new Error('the sheet was queued without a job to collect it from')
  // the same five minute ceiling and five second tick every other generation in
  // this file waits on, through the job() and collect() that already exist for
  // this exact route rather than a third client beside them
  for (let waited = 0; waited < 300000; waited += 5000) {
    await new Promise((r) => setTimeout(r, 5000))
    const j = await job(id)
    if (j.state === 'failed') throw new Error(String(j.error || 'the sheet failed to draw').slice(0, 200))
    if (j.state !== 'done') continue
    if (!j.images.length) throw new Error('the sheet finished with no picture in it')
    return {
      b64: j.images[0],
      jobId: String(id),
      // off the request that was actually sent, because fitSheet moves a canvas
      // and the face cut is measured against the picture rather than the ask
      width: req.image_size.width,
      height: req.image_size.height,
      // more than one means the canvas fell under the one-image line and this is
      // a grid of variants of one mark. fitSheet makes that impossible, and the
      // count is reported rather than assumed away.
      count: j.images.length,
    }
  }
  throw new Error('the sheet timed out')
}

/* a state is an EDIT of the drawing that is already there, not a second drawing, or a 32px grey rock stands in for a 64px mossy troll; use_color_palette_from_reference is what keeps it from drifting */
export async function objectState({ objectId, edit, name, seed }) {
  const req = { edit_description: String(edit).slice(0, 1000) }
  if (name) req.state_name = String(name).slice(0, 100)
  if (seed != null) req.seed = seed
  const out = await call('POST', `/v2/objects/${encodeURIComponent(objectId)}/states`, req)
  const id = out.object_id
  if (!id) throw new Error('the state was queued without an id to collect it from')
  /* bought from here, so every way out below carries the id it was bought under */
  const withId = (e) => {
    e.objectId = id
    return e
  }
  // an edit is quicker than a build, but it is the same queue behind it
  for (let waited = 0; waited < 300000; waited += 5000) {
    await new Promise((r) => setTimeout(r, 5000))
    let d
    try {
      d = await objectDetail(id)
    } catch {
      continue // a row that is not queryable yet is not a failure yet
    }
    if (String(d.status || '').toLowerCase() === 'failed') throw withId(new Error('the state failed to draw'))
    const url = (d.storage_urls && d.storage_urls.unknown) || ''
    if (url) return { b64: (await fetchPNG(url)).toString('base64'), objectId: id, usage: out.usage || null }
  }
  throw withId(new Error('the state timed out'))
}

export async function characterState({ characterId, edit, name, seed, size }) {
  const req = {
    character_id: characterId,
    edit_description: String(edit).slice(0, 1000),
    no_background: true,
    // the reason to prefer this endpoint over drawing a second thing
    use_color_palette_from_reference: true,
  }
  if (name) req.state_name = String(name).slice(0, 100)
  if (seed != null) req.seed = seed
  // only for an edit that genuinely needs more room, wings or a raised weapon.
  // Absent, the state keeps the source's canvas, which is what keeps a swap
  // from jumping size mid-round.
  if (size && size.w && size.h) req.override_frame_size = { width: size.w, height: size.h }
  const out = await call('POST', '/v2/create-character-state', req)
  const id = out.character_id
  if (!id) throw new Error('the state was queued without an id to collect it from')
  /* what it actually cost, carried back rather than assumed. The schema does
   * not price this endpoint anywhere and the docs do not either, so the only
   * honest source is the usage the call itself answers with. */
  try {
    return { characterId: id, usage: out.usage || null, detail: await awaitCharacter(id) }
  } catch (e) {
    /* the state is bought and it exists under this id. Losing the id with the
     * error is what makes a timeout unrecoverable rather than merely slow, so
     * it rides out on the error for the caller to record. */
    e.characterId = id
    throw e
  }
}

/* never use the eight-direction OBJECT endpoint for anything with a body: pixellab's own docs say the identity transfer is unreliable and it returns a generic figure instead of yours */
export const characterPage = (limit, offset) =>
  call('GET', `/v2/characters?limit=${Math.max(1, Math.min(100, limit))}&offset=${Math.max(0, offset)}`)

export const characterDetail = (id) => call('GET', '/v2/characters/' + encodeURIComponent(id))

/* every character on the account, the same way allObjects works */
export async function allCharacters() {
  const first = await characterPage(100, 0)
  const out = Array.isArray(first.characters) ? [...first.characters] : []
  const total = Math.min(Number(first.total || out.length), 2000)
  const rest = []
  for (let off = out.length; off > 0 && off < total; off += 100) rest.push(characterPage(100, off))
  for (const page of await Promise.all(rest)) if (Array.isArray(page.characters)) out.push(...page.characters)
  return out
}

/* four create routes, never probed because probing one spends the generation; a size is the CHARACTER and pixellab pads the frame about 40 percent, so 48px lands on a 68px canvas and has to be base-trimmed */
const DONE = ['completed', 'success', 'succeeded', 'done', 'ready']
const DEAD = ['failed', 'error', 'cancelled', 'canceled']
// the four views the live schema names on the standard create routes, and oblique is not one of them; pro and v3 name only the first three
const VIEWS = ['low top-down', 'high top-down', 'side', 'perspective']
const QUADRUPEDS = ['bear', 'cat', 'dog', 'horse', 'lion']

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const stateOf = (o) => String((o && (o.status || o.state)) || '').toLowerCase()

// proportions travel as an object over the wire but the ui holds the preset as
// a json string, so take either and let a broken string mean "no opinion"
function asProportions(p) {
  if (!p) return null
  if (typeof p === 'object') return p
  try {
    const j = JSON.parse(String(p))
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

// answers the character id, which exists the moment the post returns even
// though the rotations take minutes. Pass it to awaitCharacter.
export async function createCharacter({
  description,
  size = 48,
  view = 'low top-down',
  nDirections = 8,
  bodyType = 'humanoid',
  template,
  outline,
  detail,
  proportions,
  styleCharacterId,
  mode = 'standard',
  seed,
}) {
  const say = String(description || '').trim()
  if (!say) throw new Error('a character needs a description')
  const m = mode === 'pro' || mode === 'v3' ? mode : 'standard'
  // the schema caps standard and pro at 128 and only v3 reaches 256
  const px = Math.max(16, Math.min(m === 'v3' ? 256 : 128, Math.round(Number(size) || 48)))
  // a quadruped is a skeleton pick, not a description: there are five and the
  // endpoint fits the one it is named to the frames it drew
  let tpl = 'mannequin'
  if (bodyType === 'quadruped') {
    tpl = String(template || '')
    if (!QUADRUPEDS.includes(tpl)) throw new Error('an animal needs one of ' + QUADRUPEDS.join(', '))
  }
  // perspective is standard only; pro and v3 enumerate three views and refuse it
  let v = VIEWS.includes(view) ? view : 'low top-down'
  if (m !== 'standard' && v === 'perspective') v = 'low top-down'

  const req = {
    description: say,
    image_size: { width: px, height: px },
    view: v,
    template_id: tpl,
  }
  // every one of the four create routes carries seed. Two variants of one ask
  // are only reliably different when the noise they start from is.
  if (seed != null) req.seed = seed
  let route
  if (m === 'pro') {
    route = '/v2/create-character-pro'
    req.no_background = true
    // pro ignores the style hints and reads the eight sprites of a character
    // already on the account instead
    if (styleCharacterId) req.style_character_id = String(styleCharacterId)
  } else if (m === 'v3') {
    route = '/v2/create-character-v3'
    req.no_background = true
    if (outline) req.outline = outline
    if (detail) req.detail = detail
  } else {
    // four and eight are separate routes, and only the eight one carries mode
    route = Number(nDirections) === 4 ? '/v2/create-character-with-4-directions' : '/v2/create-character-with-8-directions'
    if (route.endsWith('8-directions')) req.mode = 'standard'
    if (outline) req.outline = outline
    if (detail) req.detail = detail
    const pr = bodyType === 'quadruped' ? null : asProportions(proportions)
    if (pr) req.proportions = pr
  }

  const out = await call('POST', route, req)
  const cid = out.character_id || out.id || out.characterId
  if (!cid) throw new Error('the character route returned no id')
  return String(cid)
}

/* the ceiling is ten minutes against a job priced at two to five, and a read that throws does not end the wait because the row is not visible the instant the post answers */
export async function awaitCharacter(characterId, { timeoutMs = 600000 } = {}) {
  if (!characterId) throw new Error('no character to wait on')
  const every = 5000
  let misses = 0
  // rotation_urls is documented as null until the status says completed, so a
  // completed answer with nothing in it gets a couple of ticks before it counts
  let empty = 0
  for (let waited = 0; waited < timeoutMs; waited += every) {
    await wait(every)
    let d
    try {
      d = await characterDetail(characterId)
      misses = 0
    } catch (e) {
      if (++misses >= 3) throw e
      continue
    }
    const st = stateOf(d)
    if (DEAD.includes(st)) throw new Error(String(d.error || d.message || 'the character failed').slice(0, 200))
    const rot = d.rotation_urls && typeof d.rotation_urls === 'object' ? d.rotation_urls : {}
    const got = Object.values(rot).filter((u) => typeof u === 'string' && u).length
    // four real headings is finished whatever the status word turns out to be,
    // and a four-direction character has exactly four
    if (got >= 4) return d
    if (DONE.includes(st) && ++empty >= 3) throw new Error('the character finished with no rotations')
  }
  throw new Error('the character timed out')
}

/* one generation per direction, and template mode defaults to every heading the character has, so an eight-direction character is eight generations */
export async function animateCharacter({ characterId, templateAnimationId, directions, seed }) {
  if (!characterId) throw new Error('no character to animate')
  const tpl = String(templateAnimationId || '').trim()
  if (!tpl) throw new Error('no animation template to walk with')
  const want = Array.isArray(directions) ? directions.map((k) => String(k).toLowerCase().trim()).filter(Boolean) : []
  const req = {
    character_id: String(characterId),
    template_animation_id: tpl,
    mode: 'template',
    animation_name: tpl,
  }
  if (want.length) req.directions = want
  if (seed != null) req.seed = seed
  return startAnimation(req, want, tpl)
}

/* mode v3 writes the motion instead of picking a template, and directions is NOT optional here because custom mode defaults to south only; priced at ceil(w*h*frames/65536) per direction, which is one at 96px and under */
export async function animateCharacterAction({ characterId, action, frameCount = 8, directions, name = 'motion', seed }) {
  if (!characterId) throw new Error('no character to animate')
  const act = String(action || '').replace(/\s+/g, ' ').trim()
  if (!act) throw new Error('no motion words to animate with')
  const want = Array.isArray(directions) ? directions.map((k) => String(k).toLowerCase().trim()).filter(Boolean) : []
  if (!want.length) throw new Error('written motion has to name its directions or only south comes back')
  // 4 to 16 and even, the schema's own bounds
  const n = Math.max(4, Math.min(16, Math.round(Number(frameCount) || 8)))
  const req = {
    character_id: String(characterId),
    mode: 'v3',
    action_description: act.slice(0, 300),
    animation_name: String(name || 'motion').slice(0, 60),
    frame_count: n % 2 ? n + 1 : n,
    keep_first_frame: false,
    directions: want,
  }
  if (seed != null) req.seed = seed
  return startAnimation(req, want, req.animation_name)
}

// both modes answer the same way and are waited on the same way, so the post
// and the handle it turns into are written once. group is what awaitAnimation
// matches the frames by: the template's id, or the name a written one was given.
async function startAnimation(req, want, group) {
  const out = await call('POST', '/v2/animate-character', req)
  const jobIds = Array.isArray(out.background_job_ids) ? out.background_job_ids.filter(Boolean) : []
  const going = Array.isArray(out.directions) && out.directions.length ? out.directions.map((k) => String(k).toLowerCase()) : want
  if (!jobIds.length && !going.length) throw new Error('the animation did not start')
  // the reply says which jobs and which headings but not which group, so the
  // group's name is carried on the handle for awaitAnimation to recognise it by
  return { ...out, jobIds, directions: going, templateAnimationId: group }
}

/* `known` is every frame the character carried before this job, and the skip belongs here because the first group holding a heading wins and an old walk would mask the new frames */
function framesByDir(detail, tpl, known) {
  const groups = Array.isArray(detail && detail.animations) ? detail.animations : []
  const named = tpl
    ? groups.filter((g) => [g.animation_type, g.display_name].some((s) => String(s || '').toLowerCase() === tpl.toLowerCase()))
    : []
  const out = {}
  for (const g of named.length ? named : groups) {
    for (const dd of Array.isArray(g.directions) ? g.directions : []) {
      const k = String(dd.direction || '').toLowerCase()
      const frames = Array.isArray(dd.frames) ? dd.frames.filter(Boolean) : []
      if (known && !frames.some((u) => !known.has(u))) continue
      if (k && frames.length && !out[k]) out[k] = frames
    }
  }
  return out
}

/* the character is polled rather than the jobs, one read a tick, and `known` is needed because an animation group can come back unnamed, so on a character that already moves the wait would end on the OLD motion */
/* ONE DIRECTION FAILING MUST NOT THROW AWAY THE OTHERS. An eight-way ask is
 * eight background jobs, each bought separately. Ending the wait on the first
 * failure abandons every heading that did draw, and they are already paid for:
 * it reads to the person as a two and a half minute wait that produced nothing.
 *
 * So a failure narrows what the wait is holding out for instead of ending it.
 * The wait ends when every job has settled, and hands back whatever landed;
 * newGroupDirs fills the missing headings from their standing rotation and
 * refuses below four, which is where the real floor belongs. Only a run where
 * EVERY job failed throws, because then there is genuinely nothing to collect.
 *
 * `readDetail` and `readJob` are injected so the partial-failure path can be
 * exercised without buying a generation to do it. */
export async function awaitAnimation(
  characterId,
  handle,
  { timeoutMs = 600000, known, every = 5000, notes, readDetail = characterDetail, readJob = job } = {},
) {
  if (!characterId) throw new Error('no character to wait on')
  const h = handle || {}
  const tpl = String(h.templateAnimationId || '')
  const want = (Array.isArray(h.directions) ? h.directions : []).map((k) => String(k).toLowerCase())
  const jobIds = Array.isArray(h.jobIds) ? h.jobIds : Array.isArray(h.background_job_ids) ? h.background_job_ids : []
  let misses = 0
  const failed = new Map()
  for (let tick = 0, waited = 0; waited < timeoutMs; tick++, waited += every) {
    await wait(every)
    let d
    try {
      d = await readDetail(characterId)
      misses = 0
    } catch (e) {
      if (++misses >= 3) throw e
      continue
    }
    const got = framesByDir(d, tpl, known)
    // with no list to check against, four headings is the same floor the
    // library import holds a view set to
    const ready = want.length ? want.every((k) => got[k]) : Object.keys(got).length >= 4
    if (ready) return d

    if (jobIds.length && tick % 6 === 5) {
      const states = await Promise.all(
        jobIds.map((j) =>
          readJob(j).then(
            (s) => [j, s],
            () => [j, { state: 'running' }],
          ),
        ),
      )
      for (const [j, s] of states) {
        if (s.state !== 'failed' || failed.has(j)) continue
        const why = String(s.error || 'a direction failed').slice(0, 200)
        failed.set(j, why)
        if (notes) notes.push(why)
      }
      // nothing drew, so waiting longer cannot change the answer
      if (failed.size >= jobIds.length) throw new Error(String([...failed.values()][0] || 'a direction failed').slice(0, 200))
      /* some drew and some did not. Nothing is still running, so the set in
       * hand is the final one: hand it back rather than holding out for a
       * heading whose job is already dead. The caller re-reads and falls back
       * to recovery if the detail has not caught up yet. */
      if (failed.size && states.every(([, s]) => s.state !== 'running')) return d
    }
  }
  throw new Error('the animation timed out')
}

// one sprite from written motion on /v2/animate-with-text-v3, priced at one generation while w*h*frames stays under 524288
export async function animate({ base64, action, frameCount = 8, seed }) {
  const req = {
    first_frame: { type: 'base64', base64 },
    action,
    frame_count: frameCount,
    no_background: true,
  }
  if (seed != null) req.seed = seed
  const out = await call('POST', '/v2/animate-with-text-v3', req)
  const id = out.background_job_id
  if (!id) throw new Error('animate returned no job id')
  /* typical generation time is 30-180 seconds; give it five minutes.
   *
   * AND RIDE OUT A BLIP, the way awaitCharacter and awaitAnimation already do. One 429 or one 502
   * from the job endpoint used to reject the whole promise, and the caller answers 502 and deletes
   * the staged folder while pixellab carries on drawing frames that are already bought. There is no
   * recover path anywhere for the single-image animator, so that money had nowhere to go: the only
   * way forward was to press again and pay again. Three reads in a row have to fail before it gives
   * up, and it gives up carrying the real error rather than one invented here. */
  let misses = 0
  for (let waited = 0; waited < 300000; waited += 5000) {
    await new Promise((r) => setTimeout(r, 5000))
    let j
    try {
      j = await job(id)
      misses = 0
    } catch (e) {
      if (++misses >= 3) throw e
      continue
    }
    if (j.state === 'done') {
      if (!j.images || !j.images.length) throw new Error('animation returned no frames')
      return j.images
    }
    if (j.state === 'failed') throw new Error(j.error || 'animation failed')
  }
  throw new Error('animation timed out')
}

// reads and not generations, and a 1-direction object's png sits in storage_urls under the key "unknown" with every rotation null

export const objectPage = (limit, offset) =>
  call('GET', `/v2/objects?limit=${Math.max(1, Math.min(100, limit))}&offset=${Math.max(0, offset)}`)

export const objectDetail = (id) => call('GET', '/v2/objects/' + encodeURIComponent(id))

// the pages after the first go out together, because seven calls in series took eight seconds and in parallel it is closer to two
export async function allObjects() {
  const first = await objectPage(100, 0)
  const out = Array.isArray(first.objects) ? [...first.objects] : []
  const total = Math.min(Number(first.total || 0), 5000)
  const rest = []
  for (let off = out.length; off > 0 && off < total; off += 100) rest.push(objectPage(100, off))
  for (const page of await Promise.all(rest)) if (Array.isArray(page.objects)) out.push(...page.objects)
  return out
}

// the bare fetch goes first because the cdn answers 401 to a Bearer header it did not ask for, and the token is only tried after a refusal
export async function fetchPNG(url) {
  let r = await fetch(url)
  if (r.status === 401 || r.status === 403) r = await fetch(url, { headers: { Authorization: 'Bearer ' + token() } })
  if (!r.ok) throw new Error(`download failed ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}



export async function job(id) {
  const j = await call('GET', '/v2/background-jobs/' + encodeURIComponent(id))
  const st = String(j.status || '').toLowerCase()
  if (['completed', 'success', 'succeeded', 'done'].includes(st)) {
    return { state: 'done', images: collect(j) }
  }
  if (['failed', 'error', 'cancelled'].includes(st)) {
    return { state: 'failed', error: (j.error || j.message || st).toString().slice(0, 200) }
  }
  return { state: 'running' }
}

// the image payload sits at a different depth depending on the model, so walk
// the response for anything that looks like a png in base64
function collect(o, acc = [], depth = 0) {
  if (depth > 8) return acc
  if (Array.isArray(o)) {
    for (const v of o) collect(v, acc, depth + 1)
  } else if (o && typeof o === 'object') {
    const b = o.base64
    if (typeof b === 'string' && b.length > 500) acc.push(b)
    else for (const v of Object.values(o)) collect(v, acc, depth + 1)
  }
  return acc
}
