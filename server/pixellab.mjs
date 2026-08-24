/* PixelLab, server side only. The token never leaves this process.
 *
 * It is read the same way scripts/pxl.py reads it: from the MCP server entry in
 * ~/.claude.json, or from PIXELLAB_TOKEN if that is set.
 *
 * Endpoints in use:
 *   POST /v2/generate-image-v2         -> { background_job_id }
 *   GET  /v2/background-jobs/{id}      -> { status, ...images somewhere inside }
 *   POST /v1/generate-image-pixflux    -> the image inline, for small assets
 *   POST /v2/animate-with-text-v3      -> { background_job_id }, frames of one sprite
 *   POST /v2/map-objects               -> { background_job_id, object_id }, one object, bare or drawn INTO a map crop
 *   GET  /v2/map-objects/{object_id}   -> 423 while running, download_url when done
 *   GET  /v2/objects                   -> { objects, total }, everything this account already owns
 *   GET  /v2/objects/{object_id}       -> one of them, with the storage url of its png
 *   POST /v2/create-character-with-8-directions -> { character_id, background_job_id }, one person or animal
 *   POST /v2/create-character-with-4-directions -> the same, when four headings are enough
 *   POST /v2/create-character-pro      -> the same, 20-40 generations, can style-match a character you own
 *   POST /v2/create-character-v3       -> the same, 2-9 generations, the only one taking a reference image
 *   POST /v2/animate-character         -> { background_job_ids, directions }, one generation PER direction
 *   GET  /v2/characters                -> { characters, total }, every character on the account
 *   GET  /v2/characters/{id}           -> status, rotation_urls, and animations carrying frame urls
 *   GET  /v1/balance                   -> { usd }
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = 'https://api.pixellab.ai'
let cached = null

export function token() {
  if (cached) return cached
  if (process.env.PIXELLAB_TOKEN) return (cached = process.env.PIXELLAB_TOKEN)
  const p = path.join(os.homedir(), '.claude.json')
  const d = JSON.parse(fs.readFileSync(p, 'utf8'))
  for (const proj of Object.values(d.projects || {})) {
    const s = (proj.mcpServers || {}).pixellab
    if (!s) continue
    for (const [k, v] of Object.entries(s.headers || {})) {
      if (k.toLowerCase() === 'authorization') return (cached = String(v).split(/\s+/).pop())
    }
    if (s.token) return (cached = s.token)
    if ((s.url || '').includes('token=')) return (cached = s.url.split('token=')[1].split('&')[0])
  }
  throw new Error('no pixellab token in ~/.claude.json and no PIXELLAB_TOKEN set')
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

export async function submit({ prompt, w, h, seed, styleImage }) {
  const body = {
    description: prompt,
    image_size: { width: w, height: h },
    no_background: false,
  }
  if (seed != null) body.seed = seed
  if (styleImage) {
    body.style_image = { image: { type: 'base64', base64: styleImage.base64 }, size: { width: styleImage.w, height: styleImage.h } }
    body.style_options = { color_palette: true, outline: true, detail: true, shading: true }
  }
  const out = await call('POST', '/v2/generate-image-v2', body)
  return out.background_job_id
}

// One small asset, synchronously: v1 pixflux answers with the image in the
// response body instead of a background job. NOTHING CALLS THIS ANY MORE. It
// drew the asset library until 2026-08-19 and it is what "asset generation
// just sucks" was about: pixflux paints a freeform illustration, so it stands
// whatever it is given on an invented plinth, and a palm came back on a stone
// slab. Both asset routes now go through mapObject below. Kept because it is
// the only synchronous image call on the api and it costs nothing to keep.
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

// One object, transparent, from POST /v2/map-objects. This is the endpoint the
// 47 objects on the account that he rates as good were actually made with:
// they are 1-direction, non-square (110x230, 400x280, 240x340) and carry a
// "low top-down" view, none of which /v2/create-1-direction-object can even
// express (that one is square 16..256, view top-down|sidescroller, and its own
// schema prices it at 20-40 generations a call while entering a review state
// at any size under 171). This one bills like a single generation.
//
// Two modes, one function. BASIC, with no background: a bare object on
// transparent, which is how the good ones were made. CONTEXT, with a crop of
// the map as background_image plus an oval inpainting mask: the same object
// drawn in that crop's palette and light. Read from the v2 openapi document,
// not probed: description is the only required field, sides are 32..400,
// the area cap is 400x400 basic and 192x192 with inpainting, and
// background_image is required whenever inpainting is asked for.
//
// It answers with a job; the documented poll is GET /v2/map-objects/{object_id},
// 423 Locked while running, download_url on 200. The download url auto-expires
// after 8 hours, so the png is fetched the moment it exists.
export async function mapObject({ description, w, h, view = 'low top-down', background, fraction = 0.3, seed }) {
  const req = {
    description,
    image_size: { width: w, height: h },
    view,
  }
  // no background means no inpainting: the endpoint rejects a mask without one,
  // and a bare object is the point of the basic mode
  if (background) {
    req.background_image = { type: 'base64', base64: background }
    req.inpainting = { type: 'oval', fraction }
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
      return Buffer.from(await png.arrayBuffer()).toString('base64')
    }
  }
  throw new Error('generation timed out')
}

/* CHARACTERS, which is what pixellab calls a person or an animal.
 *
 * Not the same thing as an object. An object is a prop: a crate, a well, a
 * tree, and MAPVIS has only ever made those. A character has a skeleton, comes
 * in 4 or 8 directions, and can be given walk cycles from a library of template
 * animations, one generation per direction.
 *
 * That distinction is pixellab's, not ours, and it matters: their own docs say
 * do NOT use the eight-direction OBJECT endpoint for a person, because the
 * identity transfer is unreliable on humanoids and it comes back a generic
 * character instead of yours. An earlier version of this file wired exactly
 * that, for exactly that use, and it was wrong.
 *
 * Both of these are reads and cost nothing.
 */
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

/* MAKING one, which does cost generations.
 *
 * There is no POST /v2/characters. The v2 openapi document names four create
 * routes and the mode picks between them: standard is one generation and is the
 * only one that can be asked for four headings, pro is 20-40 and is the only
 * one that takes style_character_id, v3 is 2-9 and is the only one that takes a
 * reference image. Read from that document rather than probed, because probing
 * a create route spends the generation it is probing.
 *
 * Sizes are the character, not the canvas: pixellab pads the frame by about 40
 * percent to leave room for the animation to swing through, so a 48px character
 * lands on a 68px canvas with the feet up off the bottom. Whoever writes these
 * to disk has to base-trim them or the figure floats.
 *
 * The api is not consistent about which word means finished, so a state is read
 * against a list of words rather than compared to one.
 */
const DONE = ['completed', 'success', 'succeeded', 'done', 'ready']
const DEAD = ['failed', 'error', 'cancelled', 'canceled']
const VIEWS = ['low top-down', 'high top-down', 'side', 'oblique']
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
  // oblique is a standard-mode beta; pro and v3 name three views and refuse it
  let v = VIEWS.includes(view) ? view : 'low top-down'
  if (m !== 'standard' && v === 'oblique') v = 'low top-down'

  const req = {
    description: say,
    image_size: { width: px, height: px },
    view: v,
    template_id: tpl,
  }
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

/* Wait for the rotations. The detail read is free, so the poll is the cheap
 * part of a job the schema prices at two to five minutes; the ceiling is ten
 * because a five minute one would fail on the slow tail of that range.
 *
 * A read that throws does not end the wait. The character row is not always
 * visible the instant the post answers, and losing a paid generation to one
 * blip is not worth the tighter code. Three failures in a row is a real fault.
 */
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

/* A walk cycle from pixellab's own template library, one generation per
 * direction. Template mode defaults to every heading the character has, which
 * for an eight-direction character is eight generations.
 *
 * The group is named after the template so it reads back the way the account
 * import already looks for a walk: that path matches /walk/ against
 * animation_type or display_name, so 'walking-8-frames' is found by both.
 *
 * /v2/characters/animations is the same handler under a second path. This one
 * is the name the tooling uses.
 */
export async function animateCharacter({ characterId, templateAnimationId, directions }) {
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
  const out = await call('POST', '/v2/animate-character', req)
  const jobIds = Array.isArray(out.background_job_ids) ? out.background_job_ids.filter(Boolean) : []
  const going = Array.isArray(out.directions) && out.directions.length ? out.directions.map((k) => String(k).toLowerCase()) : want
  if (!jobIds.length && !going.length) throw new Error('the animation did not start')
  // the reply says which jobs and which headings but not which group, so the
  // template is carried on the handle for awaitAnimation to recognise it by
  return { ...out, jobIds, directions: going, templateAnimationId: tpl }
}

// heading to frame urls, in order, for the group named after the template.
// Nothing carrying that name means every group is read, which is right for a
// character just generated because the walk is the only thing on it.
function framesByDir(detail, tpl) {
  const groups = Array.isArray(detail && detail.animations) ? detail.animations : []
  const named = tpl
    ? groups.filter((g) => [g.animation_type, g.display_name].some((s) => String(s || '').toLowerCase() === tpl.toLowerCase()))
    : []
  const out = {}
  for (const g of named.length ? named : groups) {
    for (const dd of Array.isArray(g.directions) ? g.directions : []) {
      const k = String(dd.direction || '').toLowerCase()
      const frames = Array.isArray(dd.frames) ? dd.frames.filter(Boolean) : []
      if (k && frames.length && !out[k]) out[k] = frames
    }
  }
  return out
}

/* Wait for those frames, then answer the character detail again so the caller
 * reads the per-direction urls off one object.
 *
 * The character is what gets polled, because the frames landing on it is the
 * thing being waited for and it is one read a tick instead of one per job. The
 * jobs are swept every sixth tick, thirty seconds, only so a failed direction
 * surfaces as an error rather than sitting until the ceiling.
 */
export async function awaitAnimation(characterId, handle, { timeoutMs = 600000 } = {}) {
  if (!characterId) throw new Error('no character to wait on')
  const h = handle || {}
  const tpl = String(h.templateAnimationId || '')
  const want = (Array.isArray(h.directions) ? h.directions : []).map((k) => String(k).toLowerCase())
  const jobIds = Array.isArray(h.jobIds) ? h.jobIds : Array.isArray(h.background_job_ids) ? h.background_job_ids : []
  const every = 5000
  let misses = 0
  for (let tick = 0, waited = 0; waited < timeoutMs; tick++, waited += every) {
    await wait(every)
    let d
    try {
      d = await characterDetail(characterId)
      misses = 0
    } catch (e) {
      if (++misses >= 3) throw e
      continue
    }
    const got = framesByDir(d, tpl)
    // with no list to check against, four headings is the same floor the
    // library import holds a view set to
    const ready = want.length ? want.every((k) => got[k]) : Object.keys(got).length >= 4
    if (ready) return d
    if (jobIds.length && tick % 6 === 5) {
      const states = await Promise.all(jobIds.map((j) => job(j).catch(() => ({ state: 'running' }))))
      const bad = states.find((s) => s.state === 'failed')
      if (bad) throw new Error(String(bad.error || 'a direction failed').slice(0, 200))
    }
  }
  throw new Error('the animation timed out')
}

// One sprite animated from a text motion description, via
// /v2/animate-with-text-v3 (found by probing: /v1/animate-image and friends
// 404, this one 422-names first_frame + action as its required fields). It
// answers with a background job; poll until the frames arrive. At 64x64 and
// 8 frames the pixel budget (w*h*frames <= 524288) prices the job at one
// generation.
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
  // typical generation time is 30-180 seconds; give it five minutes
  for (let waited = 0; waited < 300000; waited += 5000) {
    await new Promise((r) => setTimeout(r, 5000))
    const j = await job(id)
    if (j.state === 'done') {
      if (!j.images || !j.images.length) throw new Error('animation returned no frames')
      return j.images
    }
    if (j.state === 'failed') throw new Error(j.error || 'animation failed')
  }
  throw new Error('animation timed out')
}

// ---- what the account already owns --------------------------------------
// Reads, not generations. GET /v2/objects is the paged list (limit 1..100,
// offset), answering { objects, total, usage }; every entry carries id, name,
// prompt, size, directions, status and a public preview_url. GET
// /v2/objects/{id} adds rotation_urls and the raw storage_urls map, which is
// where a 1-direction object's png actually sits (under the key "unknown",
// with every rotation null). Neither costs anything.

export const objectPage = (limit, offset) =>
  call('GET', `/v2/objects?limit=${Math.max(1, Math.min(100, limit))}&offset=${Math.max(0, offset)}`)

export const objectDetail = (id) => call('GET', '/v2/objects/' + encodeURIComponent(id))

// every object on the account. The first page also answers with the total, so
// the rest go out together instead of one after another: seven calls in series
// took eight seconds and in parallel it is closer to two. The caller still
// caches the result, so this runs once per session, not per keystroke.
export async function allObjects() {
  const first = await objectPage(100, 0)
  const out = Array.isArray(first.objects) ? [...first.objects] : []
  const total = Math.min(Number(first.total || 0), 5000)
  const rest = []
  for (let off = out.length; off > 0 && off < total; off += 100) rest.push(objectPage(100, off))
  for (const page of await Promise.all(rest)) if (Array.isArray(page.objects)) out.push(...page.objects)
  return out
}

// a png that already exists, off pixellab's own cdn. These urls are documented
// as no-auth and the cdn in front of them answers 401 to a Bearer header it
// did not ask for, so the bare fetch goes first and the token is only tried if
// the bare one is turned away.
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
