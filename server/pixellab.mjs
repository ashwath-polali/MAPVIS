/* PixelLab, server side only. The token never leaves this process.
 *
 * It is read from PIXELLAB_TOKEN, or from a token file if one is configured.
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
 *   POST /v2/animate-character         -> { background_job_ids, directions }, one generation PER direction,
 *                                         mode template off a named walk, or mode v3 off written motion words
 *   GET  /v2/characters                -> { characters, total }, every character on the account
 *   GET  /v2/characters/{id}           -> status, rotation_urls, and animations carrying frame urls
 *   POST /v2/create-ui-asset           -> { ui_asset_id, background_job_id, status, usage }, one panel of chrome
 *   GET  /v2/ui-assets/{id}            -> { status, image_url, size, progress_percent, eta_seconds }, 200 throughout
 *   GET  /v2/ui-assets                 -> the list. GET ONLY: a POST here is 405, which is what was being sent
 *   DELETE /v2/ui-assets/{id}          -> { success }, the only other verb that path takes
 *   GET  /v1/balance                   -> { usd }
 *
 * GET /v2/openapi.json IS FREE AND NAMES EVERY ROUTE AND EVERY FIELD. Read it
 * rather than guessing at a shape, and rather than probing: it is the whole
 * schema, it costs nothing, and it is what settled every ui fact below.
 */
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

/* WHOSE SUBSCRIPTION THIS SPENDS.
 *
 * The signed-in account's own key comes first, always. This file used to read
 * one machine-wide token and use it for everybody, which was correct when there
 * was exactly one user and became a hole the moment anyone else could sign up:
 * every generation a new account made would have been billed to whoever owned
 * that token.
 *
 * The machine's own token is the fallback and only that. On a laptop it is what
 * has always happened and nothing changed. On a host there is no token file to
 * read, so an account with no key gets NoPixellab and generation is simply
 * unavailable, which is the decided behaviour: no pixellab means no generation,
 * and everything else still works. */
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

/* The style reference's four aspects are INDEPENDENT, and that is the whole
 * point of exposing them. A new map usually wants the craft of a map that
 * already works, the crisp outline and the shading structure, while keeping its
 * own colours: the Maw is black and grey stone and must not inherit the hub's
 * tropical palette. Sending all four was fine while every map was the same
 * island; it is wrong the moment two maps are meant to look different. */
export async function submit({ prompt, w, h, seed, styleImage, styleOptions }) {
  const body = {
    description: prompt,
    image_size: { width: w, height: h },
    no_background: false,
  }
  if (seed != null) body.seed = seed
  if (styleImage) {
    body.style_image = { image: { type: 'base64', base64: styleImage.base64 }, size: { width: styleImage.w, height: styleImage.h } }
    body.style_options = {
      color_palette: true, outline: true, detail: true, shading: true,
      ...(styleOptions || {}),
    }
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
// 47 objects on the account that were judged good were actually made with:
// they are 1-direction, non-square (110x230, 400x280, 240x340) and carry a
// "low top-down" view, none of which /v2/create-1-direction-object can even
// express (that one is square 16..256, view top-down|sidescroller, and its own
// schema prices it at 20-40 generations a call while entering a review state
// at any size under 171). This one bills like a single generation.
//
/* WHAT THIS ENDPOINT TAKES, read off the live v2 openapi 2026-08-25, and what
 * of it is deliberately not sent.
 *
 * NOT SENT: background_image and color_image. The schema describes them as
 * style matching and a forced palette, and on paper they are the answer to the
 * one thing words cannot fix, which is the generator's own idea of what colour
 * a noun is. They were measured twice, twenty-two generations, and they are
 * not. Handed a picture of somewhere, this endpoint CONTINUES that picture
 * instead of drawing the subject into it: with an oval mask it returns the
 * mask full of blurred map, and without one, at the exact canvas it demands, it
 * returns the crop's own content restyled. A bookshelf came back as roof tiles.
 * It is a tool for editing a map in place. The map belongs to the router, which
 * can look at it and reason; it does not belong to the generator, which can
 * only copy it. Do not rewire this without proving a subject survives first.
 *
 * ALSO NOT SENT: outline, shading, detail, text_guidance_scale. Real channels
 * with real enums, and every object in this library that has been judged good
 * was made on their defaults. Worth trying one at a time. Not worth three at
 * once under a route that works.
 *
 * It answers with a job; the documented poll is GET /v2/map-objects/{object_id},
 * 423 Locked while running, download_url on 200. The download url auto-expires
 * after 8 hours, so the png is fetched the moment it exists. */
export async function mapObject({ description, w, h, view = 'low top-down', seed }) {
  /* Both sides even, because the endpoint refuses an odd one and says so only
   * after the router has spent thirteen seconds choosing it. Measured: a 150x95
   * canvas came back 422 "must both be divisible by 2", and a caller that only
   * learns this from a 422 loses the ask. Rounding down keeps it inside every
   * cap it has already passed. */
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
      /* the object id comes back too, and dropping it was the reason a thing
       * could never be given a second state. Every state endpoint keys off the
       * id of what it is editing, and once these bytes are on disk there is no
       * way back to it: the account holds 769 objects and matching one by its
       * prompt is the fragile guesswork characterFor already has to do. */
      return { b64: Buffer.from(await png.arrayBuffer()).toString('base64'), objectId: out.object_id }
    }
  }
  throw new Error('generation timed out')
}

/* ---- UI: the furniture the game draws OVER a map -------------------------
 *
 * A dialogue box, a meter, a card, a button. Not a map object and not a
 * character: it has no world position, no camera and no body, and it is the one
 * class of art this file could not make at all.
 *
 * THE ROUTE IS POST /v2/create-ui-asset AND IT WAS POST /v2/ui-assets, WHICH IS
 * A 405. That guess made the whole button dead: the create never left, so no
 * author could ever draw a piece, and the row failed with a Method Not Allowed
 * in it.
 *
 * THE WHOLE REQUEST MODEL, off the published schema and not off a guess.
 * CreateUIAssetRequest takes exactly these and additionalProperties is FALSE,
 * so one stray field is a 422 for the whole call:
 *
 *   description    required, 1 to 2000 characters
 *   image_size     { width, height }, each 192 to 688, and ITS OWN
 *                  additionalProperties is false as well
 *   elements       list of the twelve names below, auto-positioned
 *   pieces         shape template, rounded_rect | circle | polygon
 *   style_image    a Base64Image object, { type, base64, format }
 *   color_palette  a phrase, up to 200 characters
 *   no_background  defaults true
 *   seed           integer
 *   name           a friendly name kept on the saved asset
 *   project_id     assigns the finished asset to a pixellab project. Not sent:
 *                  MAPVIS does not keep projects, and a parameter nothing can
 *                  fill is the half-plumbed shape docs/AUTHORING.md names.
 *
 * The answer is { ui_asset_id, background_job_id, status, usage }. THERE IS NO
 * download_url on this route: the finished picture is `image_url` on the poll,
 * and download_url was carried over from /v2/map-objects.
 *
 * HOW THE ROUTE WAS FOUND, AND THE PROOF IS THE 422. The schema names four ui
 * paths: /generate-ui-v2, /create-ui-asset, /ui-assets and
 * /ui-assets/{ui_asset_id}. Then each candidate was posted an INVALID body, `{}`,
 * which fastapi refuses at validation before any work happens and therefore
 * costs nothing, and the status separates the three cases cleanly:
 *
 *   POST /v2/ui-assets        405 Method Not Allowed  · that path is GET-only
 *   POST /v2/ui-asset         404 Not Found           · no such path
 *   POST /v2/ui-panels        404 Not Found           · no such path
 *   POST /v2/create-ui-asset  422 body.description Field required
 *
 * A 422 IS THE SIGNAL. It means the method and the path matched and a handler's
 * own request model rejected the body, which no wrong route can produce. The
 * same probe proved the BODY was wrong in three more ways, because
 * CreateUIAssetRequest sets additionalProperties false: `width`, `height` and
 * `style_image_base64` all came back extra_forbidden. So the size is nested in
 * `image_size` and the reference is a Base64Image object, and every one of those
 * would have been a refusal after the route was fixed.
 *
 * THE POLL IS NOT A 423 EITHER. That was carried over from /v2/map-objects.
 * GET /v2/ui-assets/{id} answers 200 the whole way through with a status word
 * and a null image_url, and the finished picture is `image_url` and never
 * `download_url`. A non-uuid in that path is a 422, which is how the path was
 * confirmed without holding a real id.
 *
 * The aspect gate is the endpoint's own and the five pairs below are it,
 * verbatim: 688x512 answers "exceeds the max for this aspect ratio (600x448).
 * Max per axis: square 512x512, 16:9 688x384, 9:16 384x688."
 *
 * IT IS THE EXPENSIVE ONE, in the pro bracket rather than the one-generation
 * bracket map objects sit in, and that is the reason nothing calls it
 * speculatively and why one press draws one piece. The number is not put in
 * front of an author: telling somebody what a press costs before telling them
 * what they get is why the old page read as a bill.
 *
 * The size is aspect-gated and the two maxima DO NOT COMBINE: 688 is only
 * reachable with a 16:9 partner and 512 only as a square, so 688x512 resolves
 * to 4:3 and is refused. That refusal arrives after the request has been sent,
 * which is the same trap the odd-canvas 422 was on map-objects, so the fit
 * happens here where it costs nothing.
 *
 * BOTH SIDES START AT 192 and that floor changes what a piece is, rather than
 * being an inconvenience. A season token is about 24 pixels across and an
 * advance cue is smaller, so neither can be asked for at its own size: the
 * existing crest-panther.png is 128x128 and could not be regenerated today. So
 * anything under the floor is drawn as a SHEET, one legal canvas holding a grid
 * of faces cut by marked rectangles, which is also the only way the faces of
 * one family come back the same weight. server/store/ui.mjs carries which of
 * the twenty-one types that applies to.
 *
 * Exported because the store checks the canvas BEFORE the press rather than
 * after it, and a second copy of these five pairs would be five numbers that
 * disagree with the generator the first time one is edited.
 */
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

/* THE TWELVE NAMES THE ENDPOINT SCAFFOLDS FROM, off the schema's own field
 * description, and they are fenced here because NOTHING VALIDATES THEM.
 *
 * SENDING ONE AT ALL IS THE DIFFERENCE BETWEEN A PANEL AND A KIT, measured over
 * four rolls. With `elements` omitted the endpoint decides for itself and
 * returns a SHEET of loose interface parts, with the piece somebody actually
 * asked for sitting at the top and cropped off the edge of the canvas. With
 * `elements: ['window']` it returns one complete centred panel, every time.
 * That is why several piece types in server/store/ui.mjs carry a one-name list
 * and why the few that carry none say out loud that they mean it.
 *
 * `elements` types as a plain list of strings, so a name outside this list is
 * accepted at the door, reaches the handler, and spends. That is the one place
 * on this route where a typo costs money instead of a 422, and the generate
 * route lets an author override the preset's list by hand. Measured with a
 * deliberately invalid seed alongside: `nonsense_widget` drew no complaint of
 * its own, which is exactly the shape of a fence that is not there. */
export const UI_ELEMENTS = [
  'button', 'icon_button', 'toolbar', 'tab', 'panel', 'window',
  'health_bar', 'avatar', 'triangle', 'pentagon', 'hexagon', 'octagon',
]

/* AND THE THREE SHAPES A TEMPLATE PIECE CAN BE. Coordinates are on a virtual
 * editor canvas whose LONGER side spans 0 to 512, which is not the output size:
 * a 16:9 panel is authored on 512x288 whatever it is finally drawn at. Anything
 * that is not one of these three is a 422, so it is refused here rather than
 * after an author has pressed and watched a row fail. */
const PIECE_KINDS = { rounded_rect: ['x', 'y', 'w', 'h'], circle: ['x', 'y', 'r'], polygon: ['x', 'y', 'r', 'sides'] }

/* THE BODY, BUILT WITHOUT SENDING IT, and the split exists so a spend is never
 * what tells anybody what the request looked like.
 *
 * Ash spent about 280 generations on 2026-08-30 rediscovering one recipe, and
 * the two that produced it, `elements` and `style_image`, are both fields a
 * caller could silently omit: work/.kit/panel.png is a paid picture whose only
 * defect is that the call dropped the element list. There was no way to look at
 * a request before paying for it, so the only instrument was the picture.
 *
 * Everything up to the post lives here and uiAsset calls it, so a dry run and a
 * real one cannot diverge: it is not a second copy of the assembly, it IS the
 * assembly. It also needs no token, so it answers on a machine with no key.
 */
export function uiAssetBody({ description, width = 256, height = 256, palette, elements, pieces, styleImageBase64, seed, name }) {
  const say = String(description || '').trim()
  if (!say) throw new Error('a surface needs a description')
  const size = fitUi(width, height)
  /* THE SIZE IS NESTED AND IT WAS FLAT. CreateUIAssetRequest sets
   * additionalProperties false, so the old `width` and `height` at the top level
   * came back extra_forbidden and would have refused the call even once the
   * route was right. The schema caps this at 2000 rather than 1000. */
  const req = {
    description: say.slice(0, 2000),
    /* ONLY EVER PROBE THIS API BY OMITTING A REQUIRED FIELD. 40 generations
     * were spent finding this route's shape by posting `image_size: {}`, which
     * looks like an obviously invalid body and is not: both width and height
     * DEFAULT to 256, so an empty object validates, reaches the handler, draws
     * a 256x256 picture and is charged for. An empty `{}` at the top level is
     * safe because `description` is required with no default, so fastapi
     * refuses it before any work happens. That is the difference, and it is the
     * only free probe: a missing required field is refused, a missing OPTIONAL
     * field is filled in and paid for. */
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
  /* ONE PRESS DRAWS ONE PIECE (Ash, 2026-08-30), and the refusal is here as
   * well as at the route because this is the line that spends the money. A
   * batch is the shape that turns one bad prompt into five bad pictures and
   * leaves nobody looking at the first one before the second is paid for.
   *
   * `pieces` used to be accepted here and never sent by anything, which is the
   * half-plumbed pattern docs/AUTHORING.md names: a field a caller could fill
   * and no form could reach. It reaches now, and it carries at most one. */
  if (Array.isArray(pieces) && pieces.length) {
    if (pieces.length > 1) throw new Error(`one press draws one piece, and this asked for ${pieces.length}`)
    /* A LIST OF NAMES IS NOT A LIST OF SHAPES, and the route upstream was
     * folding one into the other. Each piece is an object carrying an id, a
     * kind and that kind's own coordinates, so a bare string is a 422 on every
     * one of the three shapes at once and the author is told a piece is not a
     * dictionary, which is not a sentence anybody can act on. */
    const one = pieces[0]
    const need = one && typeof one === 'object' && !Array.isArray(one) ? PIECE_KINDS[one.kind] : null
    if (!need)
      throw new Error(`a shape has to say what kind it is · ${Object.keys(PIECE_KINDS).join(', ')}`)
    if (!one.id || need.some((k) => !isFinite(Number(one[k]))))
      throw new Error(`a ${one.kind} needs an id and ${need.join(', ')}, on a canvas whose longer side runs 0 to 512`)
    req.pieces = pieces
  }
  /* THE STRONGEST LEVER THIS ENDPOINT HAS, AND HALF OF WHAT A PIECE NEEDS.
   *
   * A style image transfers MATERIAL: the palette, the outline weight, the
   * wear, the motifs. It transfers NO LAYOUT at all. So it is the only thing
   * that can make a new piece the same wood as the chrome the game already
   * ships, and it can do nothing whatever about ornament landing in the middle
   * of an edge, which is what both failed rolls died of. The words are the
   * other half and neither lever substitutes for the other.
   *
   * The route sends this from public/chrome, chosen by piece type, rather than
   * taking a reference somebody pasted. See the comment at /api/ui/generate.
   *
   * It does not carry the risk the map did on /v2/map-objects, where
   * background_image made the endpoint CONTINUE a picture it was given and a
   * bookshelf came back as roof tiles. There is no subject in a style image and
   * nothing for it to continue.
   *
   * IT IS A Base64Image AND IT WAS A BARE STRING under `style_image_base64`,
   * which the probe answered extra_forbidden. Same wrapper `submit` already
   * sends on /v2/generate-image-v2. */
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

  /* 30 to 90 seconds typical; the same five minute ceiling and five second tick
   * mapObject settled on. NOT the same statuses, and that is the half of this
   * function that was wrong independently of the route: there is no 423 and no
   * 410 here. The read answers 200 all the way through, carrying `processing`
   * with a null image_url and a progress percent, then `completed` with the url.
   *
   * A 404 does not end the wait, for the reason awaitCharacter gives: the row is
   * not always queryable the instant the post answers, and losing a paid
   * generation to one blip is not worth the tighter code. */
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
      /* fetched the instant it exists, because a cdn url is not promised
       * forever and a surface that has been paid for must not be lost to a slow
       * caller. The size comes off what the endpoint says it drew rather than
       * off what was asked for, the same reason setUiImage reads the IHDR. */
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

/* ---- STATES: the same thing wearing a different face ---------------------
 *
 * A troll that turns into a boulder does not need a boulder. It needs ITSELF,
 * curled up, and those are not the same picture: one is drawn from scratch in
 * its own palette at its own size, the other is an edit of the drawing that is
 * already there. Generating the boulder separately is how you get a 32px grey
 * rock standing in for a 64px mossy troll, and how a library fills with orphan
 * rows called boulder-2 that mean nothing on their own.
 *
 * Pixellab models this natively and MAPVIS has never touched it. Every object
 * on the account already carries state_name "base" and a group_id; the shelf
 * was there and empty. Two endpoints, one per kind, and the kind is the same
 * object/character split this file already turns on:
 *
 *   POST /v2/objects/{id}/states   -> edits the image, new object, same group
 *   POST /v2/create-character-state -> edits ALL 4 or 8 rotations consistently,
 *                                      new character, same group
 *
 * Both answer a NEW id plus a background job, so the art is collected off the
 * new id the same way the original was.
 *
 * The character one carries use_color_palette_from_reference, which is the
 * whole point in one flag: the edited rotations snap to the source's existing
 * palette, so a state cannot drift off the thing it is a state OF. It defaults
 * to on here for the same reason it is not offered in the ui. */
export async function objectState({ objectId, edit, name, seed }) {
  const req = { edit_description: String(edit).slice(0, 1000) }
  if (name) req.state_name = String(name).slice(0, 100)
  if (seed != null) req.seed = seed
  const out = await call('POST', `/v2/objects/${encodeURIComponent(objectId)}/states`, req)
  const id = out.object_id
  if (!id) throw new Error('the state was queued without an id to collect it from')
  // an edit is quicker than a build, but it is the same queue behind it
  for (let waited = 0; waited < 300000; waited += 5000) {
    await new Promise((r) => setTimeout(r, 5000))
    let d
    try {
      d = await objectDetail(id)
    } catch {
      continue // a row that is not queryable yet is not a failure yet
    }
    if (String(d.status || '').toLowerCase() === 'failed') throw new Error('the state failed to draw')
    const url = (d.storage_urls && d.storage_urls.unknown) || ''
    if (url) return { b64: (await fetchPNG(url)).toString('base64'), objectId: id, usage: out.usage || null }
  }
  throw new Error('the state timed out')
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
  return { characterId: id, usage: out.usage || null, detail: await awaitCharacter(id) }
}

/* CHARACTERS, which is what pixellab calls anything built on a skeleton.
 *
 * Not the same thing as an object. An object is a prop: a crate, a well, a
 * tree, drawn flat and once. A character is rigged, comes in 4 or 8 directions
 * of the SAME body, and can be given motion, one generation per direction.
 *
 * The skeleton is a RIG, not a species. There are six of them, mannequin and
 * five four-legged bodies, and that is all there will ever be: no dragon, no
 * robot, no bird. Anything outside the six is drawn on the nearest rig by body
 * plan and made itself by the words of the prompt. Deciding which rig is the
 * router's job in api.mjs; nothing in this file has an opinion about it.
 *
 * The object/character split is pixellab's, not ours, and it matters: their own
 * docs say do NOT use the eight-direction OBJECT endpoint for something with a
 * body, because the identity transfer is unreliable and it comes back a generic
 * figure instead of yours. An earlier version of this file wired exactly that,
 * for exactly that use, and it was wrong.
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
// the four the live v2 schema names on the standard create routes. oblique used
// to sit here and is not in that schema at all: read off /v2/openapi.json
// 2026-08-23, every create-character route says "side, low top-down, high
// top-down, perspective". pro and v3 name only the first three.
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

/* THE SAME ENDPOINT, MOTION WRITTEN INSTEAD OF PICKED.
 *
 * mode v3 takes action_description in place of a template id, so the movement
 * is a sentence rather than a name off a list. That is the whole reason this
 * exists: a dragon does not walk, it hovers and beats its wings, and there is
 * no hovering template and never will be one. The same goes for a ghoul that
 * lurches and a robot whose servos idle. A quadruped needs it too, because the
 * four-legged templates are named per body and cannot be known before the body
 * has been drawn.
 *
 * directions is NOT optional here and that is measured, not assumed: the live
 * schema says template mode defaults to every direction the character has and
 * CUSTOM MODE DEFAULTS TO SOUTH ONLY. Leave it out and a dragon comes back
 * facing one way with the budget for eight still unspent and the sprite
 * useless. So the caller names all eight.
 *
 * keep_first_frame false stores exactly frameCount frames instead of
 * frameCount + the reference pose, so the loop has no duplicate at its seam.
 *
 * Priced at ceil(w * h * frames / 65536) per direction, which is one per
 * direction at 96px and under. That is why the sprite size is capped there.
 */
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

/* heading to frame urls, in order, for the group named after the template.
 * Nothing carrying that name means every group is read, which is right for a
 * character just generated because the walk is the only thing on it.
 *
 * known, when given, is every frame the character carried BEFORE this job, and
 * a heading made only of those has not landed. The skip belongs here rather
 * than in the caller: the first group holding a heading wins, so on a character
 * that already moves an old walk listed first would mask the new frames and
 * they would never be looked at again. */
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

/* Wait for those frames, then answer the character detail again so the caller
 * reads the per-direction urls off one object.
 *
 * The character is what gets polled, because the frames landing on it is the
 * thing being waited for and it is one read a tick instead of one per job. The
 * jobs are swept every sixth tick, thirty seconds, only so a failed direction
 * surfaces as an error rather than sitting until the ceiling.
 *
 * known is every frame url the character ALREADY carried, and it exists because
 * of what a live read says: an animation group comes back with no id at all,
 * animation_type carrying the template's name and display_name null. So when
 * the api does not echo a written animation's name, framesByDir falls back to
 * reading every group, and on a character that already moves that is the OLD
 * motion, sitting there complete, and the wait ends the instant it starts.
 * Frame urls are path-based, unsigned and identical across reads (measured
 * 2026-08-23), so they are the one honest test of what is new. Nothing that
 * animates a fresh character passes this, and nothing changes for them.
 */
export async function awaitAnimation(characterId, handle, { timeoutMs = 600000, known } = {}) {
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
    const got = framesByDir(d, tpl, known)
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
