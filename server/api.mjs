/* The local api. It exists so the pixellab token stays in node, and so the SAM
 * pass can run against the GPU. It is mounted into the vite dev server, so
 * `npm run dev` is one command and one port.
 *
 *   GET  /api/balance          what is left on the pixellab account
 *   POST /api/generate         { prompt, n } -> job ids
 *   GET  /api/job/:id          running | done + images | failed
 *   POST /api/propose          { image } -> a rough levels png from SAM
 *   GET  /api/library/:id      this map's own generated assets, work/<id>/library
 *   POST /api/library-remove   { id, name } -> deletes work/<id>/library/<name>(.png | /)
 *   GET  /api/account-objects  ?page=&q= everything the pixellab account already owns. FREE
 *   POST /api/account-import   { id, sceneId } -> copies one of them into this map's library. FREE
 *   GET  /api/account-characters  every person and animal on the account. FREE
 *   POST /api/character-import { id, sceneId, name, animation } -> one of them, walk and all. FREE
 *   POST /api/character-gen    { id, description, confirm, skeleton, anim, ... } -> a NEW one. SPENDS 1 + one per direction
 *   POST /api/asset-plan       { id, ask, what, kind, map, box } -> { plan } the whole routing decision. FREE
 *   POST /api/style-card       { id, image, refresh } -> { card } this map's own look, read ONCE and cached. FREE
 *   POST /api/asset-gen        { id, prompt, w, h, name, seed } -> ONE object png into work/<id>/library
 *   POST /api/asset-gen-here   { id, prompt, thing, tw, th, cx, cy, crop } -> ONE map-object png, the crop as context
 *   POST /api/asset-anim       { id, prompt, name, seed } -> base sprite + animated frames into work/<id>/library/<name>/
 *   POST /api/asset-animate    { id, name, ask, confirm } -> makes an item that ALREADY EXISTS move, in place. Free without confirm
 *   POST /api/effect-plan      { ask, colors, sprite } -> { plan } which rule, what numbers, whose colours, or a WRITTEN renderer. FREE
 *   POST /api/effect-save      { id, name, frames, meta, overwrite } -> the rendered frames + effect.json into the library
 *   POST /api/effect-read      { id, name } -> the saved rule, params, colours, fps and recipe, so an effect reopens
 *   POST /api/fx-review        { id, frames, ask, code|type } -> a contact sheet on disk, LOOKED AT, and a verdict. FREE
 *   POST /api/obj-review       { id, frames, ask, prompt } -> the candidates side by side, LOOKED AT, and which one. FREE
 *   POST /api/keep-note        { id, ask, prompt, name, kind } -> one line onto work/<id>/keeps.json, last 20
 *   POST /api/asset-crop       { id, name, rect, kind, frames, suffix } -> client pixels as a new <name>-<suffix> item
 *   POST /api/export           writes the bundle into work/<id>/
 *   POST /api/savecut          writes scene-cut.png + cut.png into work/<id>/
 *   GET  /work/<path>          serves what is in work/
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import * as pixellab from './pixellab.mjs'
import { decodePNG, encodePNG, sheetPNG } from './sheet.mjs'
import {
  platformOn,
  diskAllowed,
  saveDocument,
  savePainting,
  loadDocument,
  libraryOf,
  serveFromStore,
  hydrateMap,
  bucketBudget,
  noteBucketUsage,
  ownerOfSlug,
  pushItem,
  dropItem,
  snapshotVersion,
  restoreVersion,
  copyLibraryItem,
} from './store/platform.mjs'
import {
  listUi,
  getUiByName,
  createUi,
  setUiRegions,
  setUiImage,
  failUi,
  removeUi,
  publishUi,
  pendingUi,
  readyUi,
  readyUiByName,
  uiImage,
  ownedUiImage,
  ownedUiFull,
  uncropUi,
  legalCanvas,
  pieceType,
  PIECE_TYPES,
  CORE_NAMES,
  REGION_KINDS,
  REGION_ALIGNS,
  REGION_VALIGNS,
  PICTURE_FITS,
  FILL_AXES,
  FILL_MODES,
  REPEAT_MODES,
  TEXT_WRAPS,
  TEXT_OVERFLOWS,
  typeBrief,
  chromeRef,
  usesImageEndpoint,
  canvasFor,
} from './store/ui.mjs'
import { publishBundle, publishedMap, publishHistory, hotGet, hotPut, orderedHeadings } from './store/publish.mjs'
import { store } from './store/blobs.mjs'
import { q, one, many } from './db/pool.mjs'
import { newToken, hashToken, isPlacementName, isAnchorName } from './store/crypto.mjs'
import { listMaps } from './store/maps.mjs'
import { ask, plannerReady, NoPlanner } from './store/planner.mjs'
import { withRequest, request } from './store/ctx.mjs'
import { foldersApi } from './store/folders.mjs'
import {
  getWorld, saveWorld, composition, berthOf, worldIdFor, worldByPubId,
  GAME_WORLD, ISLAND_STATES, SEA_KINDS, MARK_KINDS,
} from './store/world.mjs'
import { env } from './db/env.mjs'
import { keyFor } from './store/auth.mjs'
import {
  signUp,
  signIn,
  openSession,
  closeSession,
  currentUser,
  tokenFrom,
  setSessionCookie,
  clearSessionCookie,
  setProvider,
  spendSince,
  sessionUser,
} from './store/auth.mjs'
import { verifyPassword } from './store/crypto.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* WHERE SCRATCH GOES.
 *
 * work/ is the staging area where the collision loops, the .stage swap and
 * .prev still run, all of it already tested and none of it worth rewriting.
 * The store is what survives; this is where bytes sit for the length of a
 * request.
 *
 * On a serverless host the whole filesystem is read-only except /tmp, so a
 * generation writing to ROOT/work would throw before it ever reached the push
 * that makes it durable. Pointing scratch at the writable place is the entire
 * accommodation hosting needs, and it works because nothing is expected to
 * still be there next time. */
const WORK =
  process.env.MAPVIS_WORK ||
  (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? path.join(os.tmpdir(), 'mapvis-work') : path.join(ROOT, 'work'))
const PUBLIB = path.join(ROOT, 'public', 'library')

const PYTHON =
  process.env.MAPVIS_PYTHON || 'C:\\Users\\ashcy\\ComfyUI_windows_portable\\python_embeded\\python.exe'
const SAM_CKPT =
  process.env.MAPVIS_SAM_CKPT || 'C:\\Users\\ashcy\\AdventureGame\\.tmp_extract\\sam_vit_b_01ec64.pth'

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' }

/* A MAP'S OWN PAINTING, AS A STYLE REFERENCE FOR THE NEXT ONE.
 *
 * The working scene first, then the published one, so a map being worked on
 * right now can be referenced before it has ever been exported. Dimensions come
 * off the PNG header rather than being trusted from the document, because the
 * generator rejects a size that does not match the bytes.
 */
async function styleRef(slug) {
  const id = safeId(slug)
  let buf = null
  const local = path.join(WORK, id, 'scene.png')
  if (fs.existsSync(local)) buf = fs.readFileSync(local)
  if (!buf) {
    const pub = await publishedMap(id, null)
    if (!pub) throw new Error('no working scene and never published')
    const key = pub.blob_prefix + 'scene.png'
    buf = hotGet(key) || hotPut(key, await store().get(key))
  }
  if (!buf || buf.length < 24) throw new Error('scene.png is empty')
  // IHDR sits at a fixed offset in every PNG: 8 signature + 8 length/type
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  if (!(w > 0 && h > 0)) throw new Error('scene.png has no readable size')
  return { base64: buf.toString('base64'), w, h }
}

/* POSTs that carry an `id` that is not a map anybody owns, so the ownership
 * gate must not stand in front of them. Auth has its own handler and never
 * reaches the gate; these are the ones whose `id` means something else or
 * nothing at all. */
/* The import routes were here because their id means something else. It does
 * not: both carry the target map in sceneId, which the gate now reads, and
 * both end in pushLibrary writing rows into that map. Leaving them exempt let
 * a signed-in stranger overwrite another account's library items by name. */
/* /api/world carries no map id at all, and the gate resolves a missing one to
 * `untitled`, which is a real map somebody may own. So it is exempt from the
 * MAP ownership gate and guards itself instead: it resolves which ocean the
 * signed-in account authors rather than checking one against a map. */
/* The ui routes are the same case as /api/world. A surface belongs to an
 * ACCOUNT and not to a map, so its body carries no map id at all, and the gate
 * resolves a missing one through safeId to 'untitled', which is a real map
 * somebody may own. Exempt from the MAP gate and guarded by a signed-in check
 * of their own, exactly the way the world write is. */
const OPEN_POSTS = new Set([
  '/api/stop',
  '/api/propose',
  '/api/world',
  '/api/ui/generate',
  '/api/ui/regions',
  '/api/ui/publish',
  '/api/ui/uncrop',
  '/api/ui/remove',
])

/* WHOSE OCEAN IS THE GAME'S ONE, which is a narrower question than it was.
 *
 * This used to decide who was allowed to open the world page at all, because
 * there was one row for the whole platform: a stranger dragging an island was
 * moving where the real crossing goes for everybody, so they got a 403 and an
 * apology. 022 gave every account a world of its own, so the page is open and
 * this answers something else now: whether the ocean you are authoring is ROW 1,
 * the one /api/v1/world serves and the game reads.
 *
 * It still gates the two things that really are one-of-a-kind: minting core
 * chrome, and removing it. A dialogue box belongs to the whole game the way the
 * game's ocean does, and neither is a thing a visitor should be able to touch.
 *
 * The address is configuration and never source: OCEAN_OWNER in .env, falling
 * back to BOOTSTRAP_EMAIL, which is already the account every import and every
 * map on this install belongs to. With neither set there is nobody to be, so
 * the gate opens and the tool works the way it always has on one laptop with no
 * login screen in front of it.
 */
const oceanOwner = () => {
  const E = env()
  return String(E.OCEAN_OWNER || E.BOOTSTRAP_EMAIL || '')
    .trim()
    .toLowerCase()
}
const ownedBy = (user) => {
  const owner = oceanOwner()
  if (!owner) return true
  return !!user && String(user.email || '').toLowerCase() === owner
}
const ownsOcean = async (req) => ownedBy(await currentUser(req))

/* WHICH ROW THIS REQUEST AUTHORS. Row 1 for the account the game's ocean belongs
 * to, and for a laptop with no owner configured at all, which is where this tool
 * has always run. Anybody else gets their own, made on first use.
 *
 * NOT_YOUR_OCEAN went with it. A refusal that reads "the world is a single
 * shared row, so one account composes it and everybody else reads it" is now a
 * false sentence, and a wall you were invited to walk into is worse than a door
 * that was never drawn. There is nothing to refuse: they get an ocean. */
const worldOf = async (user) => worldIdFor(user?.id || '', { game: ownedBy(user) })

export function api(req, res, next) {
  const url = new URL(req.url, 'http://local')
  const p = url.pathname
  if (!p.startsWith('/api/') && !p.startsWith('/work/')) return next ? next() : notFound(res)
  if (overRate(req)) {
    res.setHeader('Retry-After', '2')
    return send(res, 429, { error: 'too many requests' })
  }
  Promise.resolve(serve(req, res, p, url)).catch((e) => {
    // a missing key is a condition, not a crash, and it has to say which one so
    // the ui can put the right wall in front of the right button
    if (e && (e.name === 'NoPixellab' || e.name === 'NoPlanner')) {
      return send(res, 402, { error: String(e.message || e), needs: e.needs || 'claude' })
    }
    send(res, 500, { error: String(e.message || e) })
  })
}

/* Everything below runs inside this request's own context, which is what makes
 * a generation spend the signed-in account's pixellab subscription instead of
 * whatever token the machine happens to hold. Resolved once, here, because a
 * dozen calls deep in pixellab.mjs need it and threading it through every
 * signature is how one of them ends up billing the wrong person. */
async function serve(req, res, p, url) {
  /* THE MONTH'S BUCKET BUDGET, CHECKED BEFORE ANYTHING CAN SPEND IT.
   *
   * R2 bills overage and has no spend cap to set, so this is the only thing
   * standing between a mistake and a card. Checked once per request against a
   * total cached for a minute, and only in front of the routes that actually
   * read bytes, so an ordinary api call pays nothing for it. Refusing is the
   * correct behaviour: a tool that stops working is recoverable and a bill is
   * not. */
  if (p.startsWith('/work/') || p.startsWith('/api/v1/')) {
    const bud = await bucketBudget()
    if (bud && (bud.overA || bud.overB)) {
      res.setHeader('Retry-After', '3600')
      return send(res, 503, {
        error:
          `MAPVIS has reached its self-imposed object storage limit for ${bud.month} ` +
          `(${bud.b.toLocaleString()} reads, ${bud.a.toLocaleString()} writes). Nothing has been billed: ` +
          `this ceiling sits below the free allowance on purpose. Raise R2_MONTHLY_READ_LIMIT if this is expected.`,
        month: bud.month,
        reads: bud.b,
        writes: bud.a,
      })
    }
  }
  // the read api is public and spends nothing on a lookup, so it goes straight
  // through once the budget above has been honoured
  if (p.startsWith('/api/v1/')) {
    try {
      return await route(req, res, p, url)
    } finally {
      noteBucketUsage()
    }
  }
  /* http:true marks "there is a browser on the other end of this".
   *
   * mapIdFor needs to tell an anonymous HTTP request apart from a maintenance
   * script, because they want opposite answers: the script legitimately creates
   * maps as the bootstrap account, the anonymous request must not be able to
   * create anything at all. An empty context cannot express that difference,
   * so the flag is set here whether or not anybody is signed in. */
  let ctx = { http: true }
  try {
    const user = await currentUser(req)
    if (user) {
      const how = await keyFor(user.id, 'pixellab')
      ctx = { http: true, user, pixellabKey: how?.mode === 'key' ? how.key : null }
    }
  } catch {
    /* no database configured is the local tool it has always been */
  }
  try {
    return await withRequest(ctx, () => route(req, res, p, url))
  } finally {
    // whatever this request spent, counted into the month exactly once
    noteBucketUsage()
  }
}

/* NOBODY GETS TO SPEND THE BUCKET IN A LOOP.
 *
 * There was no rate limit anywhere in this server, and /work/ is dispatched
 * before any authentication, so a stranger with a slug could ask for pngs as
 * fast as their connection allowed and every single one was an R2 read plus a
 * Vercel invocation. That is the only realistic way this project sees a bill,
 * and it is not the owner reopening maps.
 *
 * A token bucket per address, held in the instance. Per-instance state is a
 * weaker limit than a shared one, but it is a real one: each instance a caller
 * lands on independently refuses them, and the cost of a shared counter is a
 * Postgres round trip on the hot path, which is worse than the thing it stops.
 * SIZED AGAINST A REAL MAP OPEN, which is the thing that must never trip it.
 * Opening the hub asks for about 250 pngs as fast as the browser will fire
 * them, so a limit tuned like an api rate limit refuses an author halfway
 * through their own island. The burst carries two of those back to back and the
 * refill sustains one every couple of seconds, which no person does and which
 * still leaves the monthly ceiling as the thing that actually bounds spend. */
const RATE = { perSec: Number(process.env.RATE_PER_SEC || 120), burst: Number(process.env.RATE_BURST || 600) }
const buckets = new Map()
function overRate(req) {
  const who = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim()
  const now = Date.now()
  let b = buckets.get(who)
  if (!b) {
    // bounded, because the key is attacker-controlled and an unbounded map is
    // its own denial of service
    if (buckets.size > 5000) buckets.clear()
    b = { tokens: RATE.burst, at: now }
    buckets.set(who, b)
  }
  b.tokens = Math.min(RATE.burst, b.tokens + ((now - b.at) / 1000) * RATE.perSec)
  b.at = now
  if (b.tokens < 1) return true
  b.tokens--
  return false
}

async function route(req, res, p, url) {
  /* A MAP NAMED IN A PATH IS STILL A MAP SOMEBODY OWNS.
   *
   * The gate below is POST-only, which left every GET that names a map wide
   * open: /work/<slug>/** served any account's working library to anyone who
   * could guess a slug, and /api/doc/<slug> handed over the entire document
   * including the hand-drawn masks. Slugs are enumerable, because
   * /api/v1/maps lists them all. On a host each of those requests is also a
   * paid bucket read, so this was simultaneously the privacy hole and the way
   * somebody else could spend the storage bill.
   *
   * The user was already resolved by serve(), so this costs one cached owner
   * lookup rather than a session round trip per png.
   *
   * An ownerless map stays open on purpose. MAPVIS has always worked signed
   * out, and a map nobody has claimed is not a map anybody is being kept out
   * of; that is the same rule the POST gate states at its own comment. */
  const named = p.startsWith('/work/')
    ? p.slice('/work/'.length).split('/')[0]
    : /^\/api\/(doc|library|scene|asks|keeps|style)\//.test(p)
      ? p.split('/')[3]
      : ''
  if (named) {
    const ownerId = await ownerOfSlug(safeId(decodeURIComponent(named)))
    if (ownerId) {
      const me = request().user
      if (!me || me.id !== ownerId) return send(res, 403, { error: `${named} belongs to another account` })
    }
  }

  if (p.startsWith('/work/')) return serveWork(res, p.slice('/work/'.length), req)
  if (p.startsWith('/api/v1/')) return readApi(req, res, p, url)
  // deleting a map lives with auth rather than with the map routes, because it
  // is the password that authorises it and not the ownership gate below
  if (p.startsWith('/api/auth/') || p === '/api/me' || p === '/api/my-maps' || p === '/api/maps/delete')
    return authApi(req, res, p, url)
  if (p.startsWith('/api/relay/')) return relayApi(req, res, p)
  // organising, and only organising. Its own module and its own tables, before
  // the ownership gate because a folder is a preference about the dashboard
  // rather than a write to anybody's map.
  if (p.startsWith('/api/folders') && (await foldersApi(req, res, p))) return

  /* OWNERSHIP IS CHECKED HERE, once, rather than in forty routes.
   *
   * "the dashboard only lists your maps" is a convenience, not a rule: every
   * write below takes a map id out of its own body, so without this an account
   * could name somebody else's map and edit it. The check is at the door
   * because a rule enforced in forty places is a rule enforced in thirty-nine.
   *
   * Signing in is not required to use MAPVIS. Anonymous still works exactly as
   * it always has, and only stops at a map that already has an owner, which is
   * what makes a map yours instead of merely listed under you. */
  if (req.method === 'POST' && !OPEN_POSTS.has(p)) {
    const b = await body(req)
    /* THE GATE HAS TO NAME THE MAP THE HANDLER WILL NAME.
     *
     * It read b.id alone, and two things followed. The import routes carry
     * their target in b.sceneId, so they named a map the gate never looked at,
     * and pushItem's upsert overwrites a row by (map_id, name), which is
     * somebody else's library rewritten rather than merely read. And a POST
     * with no id at all produced '' here and short-circuited, while every
     * handler resolves it through safeId, whose default is 'untitled', so a map
     * actually called untitled was writable by anyone.
     *
     * Resolved exactly the way the handlers resolve it, so the gate and the
     * code it guards can no longer disagree about which map is in play. */
    const slug = safeId(b?.sceneId || b?.slug || b?.id)
    if (slug && platformOn()) {
      const owner = await one('select u.id, u.email from maps m join users u on u.id = m.owner_id where m.slug = $1', [slug])
      if (owner) {
        const me = await currentUser(req)
        if (!me || me.id !== owner.id) {
          return send(res, 403, { error: `${slug} belongs to another account` })
        }
      }
    }
  }
  if (p === '/api/balance') return send(res, 200, await pixellab.balance())

  if (p === '/api/generate' && req.method === 'POST') {
    const b = await body(req)
    const prompt = String(b.prompt || '').trim()
    if (!prompt) return send(res, 400, { error: 'no prompt' })
    const n = Math.max(1, Math.min(6, b.n || 4))
    const w = b.w || 688
    const h = b.h || 384
    /* A STYLE REFERENCE, WHICH THIS HAS NEVER SENT.
     *
     * generateImage has taken one since it was written and nothing has ever
     * passed it, so every map ever generated here went out with no reference at
     * all. That is why a new map comes back reading like a generated picture
     * while the hub reads like a map: the hub is a thousand-candidate pick, and
     * a new one is candidate number one with nothing to imitate.
     *
     * `style` is a slug whose published painting is the reference. `styleOptions`
     * picks which of the four aspects to take, and the useful case is craft
     * without colour: outline, detail and shading on, color_palette OFF, so a
     * black-stone interior can borrow the hub's hand without its tropical
     * palette. */
    let styleImage
    if (b.style) {
      try {
        styleImage = await styleRef(String(b.style))
      } catch (e) {
        return send(res, 400, { error: `style "${b.style}": ${String(e.message || e).slice(0, 160)}` })
      }
    }
    const styleOptions = b.styleOptions && typeof b.styleOptions === 'object' ? b.styleOptions : undefined
    const jobs = []
    for (let i = 0; i < n; i++) {
      const seed = Math.floor(Math.random() * 1e9)
      try {
        jobs.push({ id: await pixellab.submit({ prompt, w, h, seed, styleImage, styleOptions }), seed })
      } catch (e) {
        jobs.push({ error: String(e.message || e).slice(0, 200) })
      }
    }
    return send(res, 200, { jobs, w, h, style: b.style || null, styleOptions: styleOptions || null })
  }

  if (p.startsWith('/api/job/')) {
    return send(res, 200, await pixellab.job(decodeURIComponent(p.slice('/api/job/'.length))))
  }

  if (p === '/api/propose' && req.method === 'POST') {
    const b = await body(req)
    if (!b.image) return send(res, 400, { error: 'no image' })
    const dir = path.join(WORK, '.propose')
    fs.mkdirSync(dir, { recursive: true })
    const inPath = path.join(dir, 'in.png')
    const outPath = path.join(dir, 'levels.png')
    fs.writeFileSync(inPath, Buffer.from(stripDataURL(b.image), 'base64'))
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
    if (!fs.existsSync(PYTHON)) return send(res, 500, { error: `no python at ${PYTHON}` })
    if (!fs.existsSync(SAM_CKPT)) return send(res, 500, { error: `no sam checkpoint at ${SAM_CKPT}` })
    const out = await run(PYTHON, [
      path.join(HERE, 'propose_sam.py'),
      '--image',
      inPath,
      '--out',
      outPath,
      '--checkpoint',
      SAM_CKPT,
    ])
    if (!fs.existsSync(outPath)) return send(res, 500, { error: (out.err || out.out || 'sam wrote nothing').slice(-300) })
    let note = {}
    try {
      note = JSON.parse((out.out.trim().split('\n').pop() || '{}'))
    } catch {
      note = {}
    }
    return send(res, 200, {
      levels: 'data:image/png;base64,' + fs.readFileSync(outPath).toString('base64'),
      note,
    })
  }

  // The ask interpreter alone, free: the ui calls this at ARM time and shows
  // the translation on the confirm button, so a bad rewrite dies at a glance
  // instead of costing generations. The confirmed translation is passed back
  // into asset-gen/asset-anim verbatim — what was shown is what runs.
  // styleClause, when the client holds a style card, is appended to the thing
  // that comes back, so the map's own look sits INSIDE the string the button
  // shows and the contract still holds: what was shown is what runs.
  if (p === '/api/translate' && req.method === 'POST') {
    const b = await body(req)
    const ask = String(b.ask || '').trim()
    if (!ask) return send(res, 400, { error: 'no ask' })
    // the id rides along so the ask can be shaped by what he has kept on THIS
    // map; a client that never sends one just gets the cold rewrite
    const t = await translateAsk(
      ask,
      b.kind === 'animated' ? 'animated' : 'static',
      b.styleClause,
      b.id ? safeId(b.id) : '',
      String(b.job || ''),
    )
    return send(res, 200, { t })
  }

  // The map is LOOKED AT once, not once per ask. Words alone never carry a
  // painting's look: a request for tropical palm trees on a warm golden-hour
  // island came back generic bright green, because no description told the
  // generator what the island looks like. So the painting itself is read once,
  // boiled down to a small card, and the card's clause rides on every later
  // ask. Cached at work/<id>/style.json and only read again when refresh is
  // passed. FREE: nothing on this route touches pixellab.
  if (p === '/api/style-card' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const dir = path.join(WORK, id)
    const cacheFile = path.join(dir, 'style.json')
    if (!b.refresh && fs.existsSync(cacheFile)) {
      try {
        const card = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
        if (card && card.clause) return send(res, 200, { card, cached: true })
      } catch {
        /* an unreadable cache is no cache: fall through and read the map again */
      }
    }
    if (!b.image) return send(res, 400, { error: 'no image' })
    const sdir = path.join(dir, '.style')
    fs.mkdirSync(sdir, { recursive: true })
    const file = path.join(sdir, 'painting.png')
    fs.writeFileSync(file, Buffer.from(stripDataURL(b.image), 'base64'))
    const card = await readStyleCard(file, String(b.job || ''))
    if (!card) return send(res, 502, { error: 'the map did not read' })
    fs.writeFileSync(cacheFile, JSON.stringify(card, null, 2))
    return send(res, 200, { card, cached: false })
  }

  // The asset library is PER MAP: only what was generated for this scene id,
  // in work/<id>/library. The old shared folder in public/library stays on
  // disk untouched but is no longer listed anywhere.
  if (p.startsWith('/api/library/')) {
    const id = safeId(decodeURIComponent(p.slice('/api/library/'.length)))
    // one select against library_items, where the disk version walked the
    // folder and opened a file descriptor per item to read a png header
    if (platformOn()) {
      try {
        const items = await libraryOf(id)
        if (items.length) return send(res, 200, { items })
      } catch (e) {
        console.error('[library] platform list failed, trying disk:', e.message)
      }
      if (!diskAllowed()) return send(res, 200, { items: [] })
    }
    return send(res, 200, { items: libraryItems(id) })
  }

  // What the account already owns, listed. Browsing beats generating here:
  // there are 700 objects on this account and the 47 that were written in the
  // house style are the good ones, so picking one costs nothing and lands
  // something already judged. GET /v2/objects is a read; so is the png fetch
  // the import does. NOTHING on either of these two routes generates.
  //
  // The list endpoint has no search of its own, so the whole thing is walked
  // once, held for a few minutes and filtered here. A page is 24, which is
  // eight rows of the three-wide grid the panel draws.
  if (p === '/api/account-objects') {
    const all = await accountObjects(url.searchParams.get('refresh') === '1')
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
    // pixellab cuts a name at 30 characters, so a word can sit in the prompt
    // and not in the name. Both are searched, but the ones whose visible name
    // holds the word come first, or a search reads as broken when the top row
    // does not say what was typed.
    const hits = q
      ? [
          ...all.filter((o) => o.name.toLowerCase().includes(q)),
          ...all.filter((o) => !o.name.toLowerCase().includes(q) && o.prompt.toLowerCase().includes(q)),
        ]
      : all
    const per = 24
    const pages = Math.max(1, Math.ceil(hits.length / per))
    const page = Math.max(0, Math.min(pages - 1, Math.floor(Number(url.searchParams.get('page')) || 0)))
    return send(res, 200, { items: hits.slice(page * per, page * per + per), total: hits.length, page, pages })
  }

  // One object he already owns, copied into this map's library as a normal
  // static item. A 1-direction object keeps its png under the storage key
  // "unknown" with every rotation url null, so the url is looked for in that
  // order. Free: this only moves bytes that already exist.
  if (p === '/api/account-import' && req.method === 'POST') {
    const b = await body(req)
    const oid = String(b.id || '').trim()
    if (!/^[a-f0-9-]{16,64}$/i.test(oid)) return send(res, 400, { error: 'no object id' })
    const id = safeId(b.sceneId)
    let d
    try {
      d = await pixellab.objectDetail(oid)
    } catch (e) {
      return send(res, 502, { error: String(e.message || e).slice(0, 200) })
    }
    const dir = libDirOf(id)
    fs.mkdirSync(dir, { recursive: true })
    const base = cleanName(b.name || d.name || d.prompt || 'object')

    /* An object with ROTATIONS comes over as all of them.
     *
     * A thing that walks needs to face where it is going, or it moon-walks
     * across a plaza. A crab gets away with a left-right flip because a crab is
     * two apparent directions; a person is not. Pixellab already draws these
     * eight ways and the account already holds them, so this pulls the set
     * rather than one view. Same writer the eight-direction generate uses.
     */
    const rotPlan = await saveRotations(id, d, base)
    if (rotPlan) {
      const item = await writeRotations(id, rotPlan)
      if (item) {
        // an import is a library write like any other, and both of this route's
        // returns used to end at disk. On a host that disk is a tmp dir that
        // dies with the request, so the item vanished and the library carried on
        // as if the import never happened. Same awaited push character-import
        // makes one route over.
        await pushLibrary(id, item.name)
        return send(res, 200, { item })
      }
    }

    const src = objectImageURL(d)
    if (!src) return send(res, 404, { error: 'that one has no image yet' })
    const buf = await pixellab.fetchPNG(src)
    const size = pngSizeBuf(buf)
    if (!(size.w > 0 && size.h > 0)) return send(res, 502, { error: 'what came back was not a png' })
    /* THE DATABASE ANSWERS TOO, not the disk alone. The walk here only looked at
     * libDirOf(id), which on a host starts empty every request, so every import
     * would pick the base name and the push below would then overwrite the store
     * row already sitting under it. Same reason saveRotations and saveFrames
     * went through this helper. */
    const file = (await freeLibraryName(id, base)) + '.png'
    fs.writeFileSync(path.join(dir, file), buf)
    const name = file.replace(/\.png$/i, '')
    await pushLibrary(id, name)
    return send(res, 200, {
      item: { name, kind: 'static', src: `/work/${id}/library/${file}`, w: size.w, h: size.h },
    })
  }

  // ONE pixellab spend, gated in the ui behind an explicit confirm: a small
  // transparent object, saved into this map's own library. The batch mode
  // passes name (<slug>-1/-2/-3) and a distinct seed per run.
  //
  // It goes through the OBJECT endpoint, not pixflux. pixflux draws freeform
  // illustrations, so it stands things on invented plinths: a palm came back
  // on a stone slab, twice. The 47 objects on this account that were judged
  // good were all made through /v2/map-objects, in its basic mode with no
  // background image, which is what this sends. Same price class as any other
  // single generation.
  //
  // The user's ask goes through the INTERPRETER first: the generator draws
  // every noun it hears ("smoke for the volcano" painted a volcano), so a
  // language model rewrites intent into the proven house prompt — one object,
  // stated projection, stated light, stated shading, and a refusal of ground.
  // Falls back to a bare-bones version of the same house prompt if the
  // interpreter is unavailable; generation never blocks on it.
  /* The ask, read with the map open. FREE: this route never touches pixellab,
   * it only looks and writes words. The client sends the painting it is already
   * holding (and the boxed area, if one was drawn) as data urls; both land in
   * work/<id>/.ask so the planner can read them off disk.
   *
   * It is also THE ROUTER. what says which of the two spending modes is open,
   * and for a sprite the answer carries the whole routing decision as well as
   * the prompt: which of the six skeletons, which camera angle, what size, and
   * whether the motion is a named template or written out for v3. Those four
   * used to be dropdowns, and a dropdown is a list of what can exist, which is
   * always shorter than what someone can imagine. See planMake.
   *
   * Nothing is generated here. What comes back is shown, and only a second,
   * deliberate press spends anything. */
  if (p === '/api/asset-plan' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const ask = String(b.ask || '').trim()
    if (!ask) return send(res, 400, { error: 'no ask' })
    const mapB64 = stripDataURL(String(b.map || ''))
    if (!mapB64) return send(res, 400, { error: 'no map' })
    const dir = path.join(WORK, id, '.ask')
    fs.mkdirSync(dir, { recursive: true })
    const mapFile = path.join(dir, 'map.png')
    fs.writeFileSync(mapFile, Buffer.from(mapB64, 'base64'))
    let boxFile = ''
    // x and y ride along now. The box used to be only a size the model read
    // scale off; it is also the patch of painting the cohesion crop is taken
    // from. A client sending w and h alone still works, it just does not pin
    // the spot and the router picks one.
    const box =
      b.box && Number(b.box.w) > 0
        ? {
            w: Math.round(b.box.w),
            h: Math.round(b.box.h),
            ...(Number.isFinite(Number(b.box.x)) && Number.isFinite(Number(b.box.y))
              ? { x: Math.round(b.box.x), y: Math.round(b.box.y) }
              : {}),
          }
        : null
    const boxB64 = stripDataURL(String(b.boxImage || ''))
    if (box && boxB64) {
      boxFile = path.join(dir, 'box.png')
      fs.writeFileSync(boxFile, Buffer.from(boxB64, 'base64'))
    }
    try {
      const plan = await planMake({
        ask,
        // which of the two spending modes is open. A client that sends nothing
        // is asking for a prop, which is what this route has always answered.
        what: b.what === 'sprite' ? 'sprite' : 'object',
        kind: b.kind === 'animated' ? 'animated' : 'static',
        id,
        mapFile,
        boxFile,
        box: boxFile ? box : null,
        previous: String(b.previous || ''),
        job: String(b.job || ''),
      })
      return send(res, 200, { plan })
    } catch (e) {
      const m = String((e && e.message) || e)
      return send(res, m === 'stopped' ? 499 : 502, { error: m })
    }
  }

  /* A whole area planned at once: what goes in it and where each thing stands.
   * FREE, like the single-asset read. Needs a boxed area, because "fill this"
   * has no meaning without a this. Nothing generates here; the list comes back,
   * the person looks at it, and only then does anything spend. */
  if (p === '/api/scene-plan' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const mapB64 = stripDataURL(String(b.map || ''))
    const boxB64 = stripDataURL(String(b.boxImage || ''))
    const box = b.box && Number(b.box.w) > 0 ? { w: Math.round(b.box.w), h: Math.round(b.box.h) } : null
    if (!mapB64) return send(res, 400, { error: 'no map' })
    if (!box || !boxB64) return send(res, 400, { error: 'box an area first' })
    const count = Math.max(1, Math.min(24, Math.round(Number(b.count) || 6)))
    const dir = path.join(WORK, id, '.ask')
    fs.mkdirSync(dir, { recursive: true })
    const mapFile = path.join(dir, 'map.png')
    const boxFile = path.join(dir, 'box.png')
    fs.writeFileSync(mapFile, Buffer.from(mapB64, 'base64'))
    fs.writeFileSync(boxFile, Buffer.from(boxB64, 'base64'))
    try {
      const plan = await planScene({
        ask: String(b.ask || '').trim(),
        id,
        mapFile,
        boxFile,
        box,
        count,
        kind: b.kind === 'animated' ? 'animated' : 'static',
        job: String(b.job || ''),
      })
      return send(res, 200, { plan })
    } catch (e) {
      const m = String((e && e.message) || e)
      return send(res, m === 'stopped' ? 499 : 502, { error: m })
    }
  }


  /* GIVE A PLACEMENT LIFE. Free: no image is generated, nothing is drawn.
   *
   * The answer is a handful of numbers describing how the thing MOVES, which
   * the game works out each frame. It is not animation frames, and it cannot
   * be: every effect in this tool has to loop, and a wander that returns to its
   * exact start every cycle is a dance rather than a wander. See
   * src/core/life.ts.
   *
   * The map rides along so the movement can suit the ground it happens on, and
   * the boxed area, if one was drawn, is the fence it stays inside.
   *
   * The answer carries "looks" beside the life: the names of the pictures the
   * states point at, in the order their indices count. looks[0] is always the
   * placement's own picture, so an answer with no states is looks of one and a
   * state that names nothing keeps what it had. */
  if (p === '/api/life-plan' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const ask = String(b.ask || '').trim()
    if (!ask) return send(res, 400, { error: 'say what it should do' })
    const mapB64 = stripDataURL(String(b.map || ''))
    if (!mapB64) return send(res, 400, { error: 'no map' })
    const dir = path.join(WORK, id, '.ask')
    fs.mkdirSync(dir, { recursive: true })
    const mapFile = path.join(dir, 'map.png')
    fs.writeFileSync(mapFile, Buffer.from(mapB64, 'base64'))
    const box = b.bounds && Number(b.bounds.w) > 1 ? b.bounds : null
    const walkPct = Math.max(0, Math.min(1, Number(b.walkPct) || 0))
    const walkOnly = !!b.walkOnly
    const thing = String(b.name || 'it').slice(0, 80)
    const at = b.at && isFinite(Number(b.at.x)) ? { x: Math.round(b.at.x), y: Math.round(b.at.y) } : null
    const size = b.size && Number(b.size.w) > 0 ? { w: Math.round(b.size.w), h: Math.round(b.size.h) } : null
    /* the pictures this map already holds, by name.
     *
     * A thing that CHANGES over time wears a different picture for part of its
     * round, and it has to name which one. Only a name that really exists is
     * any use: the name leaves here as an INDEX and the editor turns each
     * index back into a png, so a name nobody has drawn has nothing to become.
     *
     * Two sides have to agree on the list. The library on disk is what exists;
     * the names the client sends are what the editor can hand back to a
     * placement right now, and its copy can be a generate or a discard behind.
     * A name on one side and not the other cannot survive the round trip, so
     * the list is what both can see. Sent nothing, which is what an older
     * client does, and disk stands alone: the indices are still valid, the
     * client simply ignores them and every state draws the picture it had. */
    const fold = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase()
    const sent = new Set((Array.isArray(b.names) ? b.names : []).map(fold).filter(Boolean))
    /* THE FACES THIS THING HAS, and not the whole library.
     *
     * Two objections to the old shape, and they were the same objection twice: a boulder drawn separately does not match the troll, and
     * a library with three boulders in it gives the planner a choice nobody can
     * make for it. Both are gone if the pictures a thing can wear belong TO the
     * thing. A face is generated as an edit of the row that owns it and stored
     * under it, so "which boulder" is not a question that can be asked: there
     * is only this troll's second face.
     *
     * The library stays reachable for a row with no faces of its own, which is
     * every row made before today and every one imported off the account. That
     * is the old behaviour, kept because it is the only thing those rows have,
     * and it is what the fallback below is for. */
    const owner = cleanName(b.owner || '')
    const mine = owner ? (libraryItems(id).find((x) => x.name === owner) || {}).states || [] : []
    const onDisk = mine.length
      ? mine.map((f) => String(f.name || '').trim()).filter(Boolean)
      : libraryItems(id)
          .map((it) => String(it.name || '').trim())
          .filter(Boolean)
    /* Bounded by characters, because the prompt is made of characters. See
     * NAMES_CHARS. What is left over is counted here and named in the note
     * below, so a library too big to offer whole says so instead of dropping
     * whatever happened to be last in the directory. */
    // a face is not in the client's library list and never will be, so the
    // client's list only ever narrows the LIBRARY fallback
    const pool = mine.length ? onDisk : sent.size ? onDisk.filter((n) => sent.has(fold(n))) : onDisk
    const names = []
    let namesLen = 0
    for (const n of pool) {
      namesLen += n.length + 2 // the ", " it is joined with
      if (namesLen > NAMES_CHARS) break
      names.push(n)
    }
    const namesCut = pool.length - names.length
    try {
      const raw = await runPlanner(
        [
          `Give a thing on a hand-painted pixel-art game map a way of MOVING. Read the map image ` +
            `below ONCE with the Read tool, then answer in your next message. Do not read it again ` +
            `to check yourself and do not open anything else.`,
          ``,
          `The map, absolute path:`,
          mapFile,
          `It is ${b.mapW || '?'} by ${b.mapH || '?'} pixels and every coordinate here is in those pixels.`,
          ``,
          `The thing is called "${thing}"${size ? `, drawn ${size.w} by ${size.h} pixels` : ''}` +
            `${at ? `, standing at ${at.x}, ${at.y}` : ''}.`,
          names.length
            ? `The pictures this map already has, by name: ${names.join(', ')}. Nothing else has ` +
              `been drawn for it.`
            : ``,
          box
            ? `It must stay inside the box the person drew: x ${Math.round(box.x)} to ` +
              `${Math.round(box.x + box.w)}, y ${Math.round(box.y)} to ${Math.round(box.y + box.h)}.`
            : `The person did not fence it in, so choose somewhere sensible from the map itself: ` +
              `look at what is under and around where it stands and keep it on ground that suits it.`,
          /* What the ground says about the thing.
           *
           * A box drawn mostly over walkable floor is not a neutral fact: it
           * means the person fenced somewhere a person could WALK, a path, a
           * quay, a stretch of sand. Whatever lives there is doing what things
           * do on a floor, and floors call for unhurried movement. A crab can
           * dart because a crab darts; a person crossing a plaza cannot. */
          box && walkOnly
            ? `About that area: ${Math.round(walkPct * 100)}% of it is ground a person could ` +
              `stand on, so it is somewhere walkable, a path or a yard or open sand rather than ` +
              `roof, water or cliff. It will additionally be held to the walkable pixels inside ` +
              `the box, so it cannot cross a wall or step onto water whatever numbers you give.
` +
              `Let that shape the movement. Something that belongs on a floor among people moves ` +
              `unhurriedly: a figure crossing a yard is 8 to 18 pixels per second with long ` +
              `settled pauses, not a dart. Reserve quick bursts for small creatures that really ` +
              `do move that way. Judge the speed against the size of this map, ` +
              `${b.mapW || '?'} by ${b.mapH || '?'} pixels: something that crosses the whole ` +
              `thing in a few seconds is running, and almost nothing in the background should be ` +
              `running.`
            : box
              ? `About that area: only ${Math.round(walkPct * 100)}% of it is walkable ground, so ` +
                `it is mostly roof, water, cliff or scenery. The box is the only fence, which is ` +
                `right for something that does not stand on the floor at all.`
              : ``,
          ``,
          `What the person asked for:`,
          `"${String(ask).slice(0, ASK_MAX)}"`,
          ``,
          `Choose ONE kind and set its numbers. Speeds are pixels per second, times are seconds, ` +
            `distances are pixels.`,
          ``,
          `wander  bursts and pauses inside an area, the way a crab does: it dashes somewhere, ` +
            `stops for a while, dashes again, and faces the way it went. range (how far it strays ` +
            `when there is no box), speedMin/speedMax, pauseMin/pauseMax, bob (pixels it hops ` +
            `while moving), bobRate, faceMotion.`,
          `cross   a pass across the map and then nothing, the way a gull does: cycle (seconds for ` +
            `the whole thing, most of it absent), travel (seconds actually crossing), ` +
            `fromX/fromY/toX/toY, swayAmp and swayWaves for the rise and fall, fade, airborne ` +
            `(true for anything in the air, so it draws over the map instead of standing in it).`,
          `orbit   a circuit: period, radiusX, radiusY.`,
          `drift   barely moving, for something moored or idling: driftX, driftY, period.`,
          ``,
          /* rock is not a fifth kind and must not read as one. It was added to
           * Life and then never mentioned here, so the planner could not choose
           * a thing it did not know existed and a boat asked to rock came back
           * drifting sideways instead. */
          `AND SEPARATELY, on any of the four: rock and rockRate. A tilt, in degrees either side ` +
            `of upright and leans per second. This is how something LEANS rather than travels: a ` +
            `boat at its mooring, a hanging sign, a lantern on a bracket. It rides on top of the ` +
            `kind you chose, so a moored boat is drift with a small rock, and a sign that never ` +
            `moves at all is drift with driftX and driftY at zero and a rock on top. Gentle is ` +
            `right: 2 to 5 degrees and about a third of a lean a second reads as water. Ten ` +
            `degrees reads as a storm.`,
          ``,
          /* A SEQUENCE is not a fifth kind either, and it sits here with rock
           * for the same reason: it rides on top of whatever kind was chosen
           * rather than replacing it. The flat fields above ARE the first
           * state, so everything written above stays true and the answer is
           * still one object with an array on the end. See LifeState in
           * src/core/life.ts. */
          `AND SEPARATELY AGAIN: if what they asked for is not one behaviour but a THING THAT ` +
            `CHANGES, add a "states" list to the same answer. A troll that rolls around, turns to ` +
            `stone, then comes back is three facts, not one: it rolls for a while, it is a boulder ` +
            `for a while, it rolls again. Everything you already wrote above stays, because the ` +
            `first state uses it.`,
          // the count comes off STATES_MAX so the words and the guard below can
          // never drift apart. Asking for seven and keeping six is how a state
          // used to vanish without a word.
          `Each state is a length in seconds, optionally the name of a picture to draw, and ` +
            `optionally a behaviour of its own. Two to ${STATES_MAX} states, and a longer list is ` +
            `cut to ${STATES_MAX}. The list is a ROUND: after the last one it starts again at the ` +
            `first, so write the last state so that following it with the first reads right.`,
          `A state with no "move" does not move. It stands exactly where the thing was when the ` +
            `state before it ended, which is what a creature freezing in place looks like, and it ` +
            `is the right answer far more often than a behaviour is. Give a state a "move" only ` +
            `when it should travel while it is in that state, and write that move as a whole ` +
            `behaviour of its own with its own kind and numbers. A move inside a state may not ` +
            `have states of its own.`,
          /* The guard in cleanLife REFUSES a cross inside a state, so the prompt
           * has to stop inviting one or the answer comes back and that state
           * silently loses its movement with nobody told.
           *
           * The reason is structural rather than taste. Every other kind answers
           * with an OFFSET from where the thing lives, which is what lets a round
           * add its states up. A cross is an absolute scripted line across the
           * whole painting, and for most of its cycle it is not on the map at
           * all, where it answers nothing to mean ABSENT rather than to mean
           * here. A round cannot add absent to anything: measured, a cross state
           * put the placement 430px away on a 688px painting and jumped it 200px
           * in a frame, every round. */
          `A move inside a state may NOT be a cross. A cross is a one-off pass across the whole ` +
            `painting, which is a thing that appears and leaves rather than a thing that is doing ` +
            `something for a while, so it cannot be one stage of a round. If the ask really is a ` +
            `bird that crosses now and then, that is a cross placement on its own with NO states, ` +
            `not a state inside one.`,
          /* The list of pictures is a fence, not a preference.
           *
           * "art" leaves this route as an INDEX into the pictures this map
           * holds, so a name nobody has drawn has no index to become and that
           * state falls back to the picture it already had. The old wording
           * invited it to name one anyway and said somebody would be told what
           * was missing. Nobody was: it read on screen as a sequence that
           * changed timing and never once changed the picture. */
          names.length
            ? `"art" is the NAME of a picture and it must be copied exactly off that list of ` +
              `pictures this map already has. Leave it out for every state where the thing looks ` +
              `the way it already does, which is most of them. Name one only when it genuinely ` +
              `looks different: a boulder is a different picture, a troll pausing is not. A name ` +
              `that is not on the list is thrown away and that state keeps the picture it had, so ` +
              `do not invent one and do not describe a picture that would have to be drawn first.`
            : `Leave "art" out of every state. Nothing else has been drawn for this map, so the ` +
              `thing looks the way it already does the whole way round and a state changes how it ` +
              `MOVES rather than how it looks.`,
          `"fade" is seconds of dissolve at each end of a state, so a change of picture melts ` +
            `rather than cuts. A quarter of a second suits a creature curling up; leave it near ` +
            `zero for something that should snap.`,
          `Use states only when the ask really says the thing becomes something else, or stops ` +
            `being one thing and starts being another. Movement that merely varies, a wander that ` +
            `sometimes pauses longer, is ONE wander and its own pauses already cover it. When in ` +
            `doubt, leave states out.`,
          `Times: a state should last long enough to be noticed and short enough to come round ` +
            `again while someone is still looking. Ten to forty seconds is usually right. Under ` +
            `three seconds reads as a flicker rather than a change.`,
          ``,
          `Judge it against the map. A creature that scuttles wants short fast dashes and long ` +
            `stillness, not a steady glide. Something in the air wants a long cycle and a lot of ` +
            `absence, or it turns into traffic. Slow is usually righter than fast: this sits in the ` +
            `background of a scene, and a thing that never settles pulls the eye off everything else.`,
          ``,
          `Answer with ONLY this JSON, no prose. Include only the fields your chosen kind uses.`,
          `{"kind":"wander","note":"one short lower-case line on what it will do","seed":1,` +
            `"range":40,"speedMin":14,"speedMax":26,"pauseMin":1.2,"pauseMax":4.7,"bob":1.5,` +
            `"bobRate":3.5,"faceMotion":true}`,
          `Or, when it changes, the same object with a states list on the end:`,
          /* the middle state is the only one that names a picture, and the last
           * one names none on purpose: leaving it out is how the thing goes
           * back to looking the way it does the rest of the time. An example
           * that named "mossy boulder" taught it to invent, whatever the words
           * above said, so with no library to draw from it names nothing. */
          `{"kind":"wander","note":"rolls the rocks, goes still as a boulder, then rolls off",` +
            `"seed":1,"range":70,"speedMin":10,"speedMax":22,"pauseMin":0.8,"pauseMax":3,"bob":1,` +
            `"bobRate":3,"faceMotion":true,` +
            `"states":[{"secs":26,"fade":0.25},` +
            (names.length
              ? `{"secs":16,"art":"a name copied from the list above","fade":0.4},`
              : `{"secs":16,"fade":0.4},`) +
            `{"secs":9,"move":{"kind":"drift","driftX":1,"driftY":0.5,"period":1.2}}]}`,
        ].join('\n'),
        180000,
        String(b.job || ''),
      )
      const o = planJSON(raw, 'kind')
      if (!o || !o.kind) throw new Error('no answer')
      /* A NAME on the wire, an INDEX in the data.
       *
       * The planner answers with a name because a name is the only handle it
       * has. src/core/life.ts is numeric and stays numeric: lifeAt runs for
       * every placement on every frame, so an index is a lookup and a name
       * would be a search. This is the one place that holds both the answer
       * and the map's library, so the swap happens here, before it is sent.
       *
       * looks[0] is always the placement's own picture. That is what makes a
       * state with no art keep what it had, what makes the placement's own
       * name resolve to itself instead of a second copy, and what makes an
       * unresolvable name safe: 0 is the one index that always draws. */
      /* A round is cut to STATES_MAX HERE, where there is somebody to tell.
       *
       * cleanLife cuts it anyway, silently, on both sides of the wire, so a
       * seventh state used to reach the editor, be thrown away, and leave a
       * round that reads as one that just stops early. Cutting it before the
       * pictures are resolved also stops a dropped state spending a look slot
       * that nothing will ever draw. */
      const overStates = Array.isArray(o.states) ? Math.max(0, o.states.length - STATES_MAX) : 0
      if (overStates) o.states = o.states.slice(0, STATES_MAX)
      const looks = [thing]
      const real = new Map(names.map((n) => [fold(n), n]))
      const slot = new Map([[fold(thing), 0]])
      const missing = []
      for (const st of Array.isArray(o.states) ? o.states : []) {
        if (!st || typeof st !== 'object') continue
        const want = fold(st.art)
        if (!want) {
          delete st.art
          continue
        }
        const hit = real.get(want)
        if (!hit) {
          const said = String(st.art).replace(/\s+/g, ' ').trim().slice(0, 40)
          if (typeof st.art === 'string' && !missing.includes(said)) missing.push(said)
          st.art = 0
          continue
        }
        let i = slot.get(fold(hit))
        if (i === undefined) {
          // one extra picture per state is the ceiling, because a round is at
          // most STATES_MAX states and each of them can name one. looks[0] is
          // the placement itself, so the list is full at STATES_MAX + 1. The
          // export and a reopen hold the same number, worked out the same way.
          // Past it the honest answer is the picture it already has rather
          // than an index nothing will resolve.
          if (looks.length > STATES_MAX) {
            st.art = 0
            continue
          }
          i = looks.length
          looks.push(hit)
          slot.set(fold(hit), i)
        }
        st.art = i
      }
      /* say what was thrown away. A picture that does not exist reads on
       * screen as nothing happening, which looks exactly like the sequence
       * not working at all, so the one line the person sees has to name it. */
      const gone = missing.length
        ? ` · nothing here is called ${missing.slice(0, 2).map((m) => `"${m}"`).join(' or ')}, so ` +
          `that state keeps the picture it has`
        : ''
      /* and what was cut, for the same reason: a round one state short and a
       * library three pictures short both read on screen as the tool ignoring
       * the ask. Neither used to say anything at all. */
      const cutSt = overStates ? ` · a round holds ${STATES_MAX} states, so the last ${overStates} went` : ''
      const cutNm = namesCut
        ? ` · ${pool.length} pictures here, too many to list, so the last ${namesCut} could not be named`
        : ''
      const tail = gone + cutSt + cutNm
      const note = String(o.note || '').replace(/\s+/g, ' ').trim().slice(0, Math.max(0, 240 - tail.length)) + tail
      return send(res, 200, { life: o, note, looks })
    } catch (e) {
      const m = String((e && e.message) || e)
      return send(res, m === 'stopped' ? 499 : 502, { error: m })
    }
  }

  /* THE CHARACTERS ON THE ACCOUNT. A read, so it costs nothing.
   *
   * A character is pixellab's own word for a person or an animal: it has a
   * skeleton, comes in 4 or 8 directions, and can carry walk cycles. That is a
   * different thing from an object, which is a prop, and it is the right thing
   * for someone wandering a harbour. */
  if (p === '/api/account-characters') {
    try {
      const list = await accountCharacters(url.searchParams.get('refresh') === '1')
      const items = list
        .filter((c) => String(c.status || '').toLowerCase() !== 'failed')
        .map((c) => ({
          id: c.id,
          name: String(c.name || c.state_name || c.prompt || 'character').slice(0, 90),
          directions: Number(c.directions) || 0,
          animations: Number(c.animation_count) || 0,
          size: c.size && c.size.width ? `${c.size.width}x${c.size.height}` : '',
          // the camera it was drawn for. A pro-mode style reference drags the
          // new sprite to ITS angle, so a caller matching one has to send the
          // same view or spend twenty generations on a figure at the wrong
          // pitch. Thor is high top-down while this map's props are low.
          view: String(c.view || ''),
          thumb: (c.rotation_urls && (c.rotation_urls.south || Object.values(c.rotation_urls)[0])) || '',
        }))
      return send(res, 200, { items, total: items.length })
    } catch (e) {
      return send(res, 502, { error: String((e && e.message) || e).slice(0, 200) })
    }
  }

  /* One character copied into this map's library, WITH a walk cycle if it has
   * one. Free: every png already exists.
   *
   * What lands is the shape the renderers already understand — one entry per
   * heading, frames inside it — so a walking figure needs nothing new
   * downstream. When the character has no animation the rotations are used, and
   * it faces where it walks without its legs moving. */
  if (p === '/api/character-import' && req.method === 'POST') {
    const b = await body(req)
    const cid = String(b.id || '').trim()
    if (!/^[a-f0-9-]{16,64}$/i.test(cid)) return send(res, 400, { error: 'no character id' })
    const id = safeId(b.sceneId)
    let d
    try {
      d = await pixellab.characterDetail(cid)
    } catch (e) {
      return send(res, 502, { error: String(e.message || e).slice(0, 200) })
    }
    const plan = await saveFrames(id, characterDirs(d, b.animation), b.name || d.name || d.state_name || 'someone', 8, cid)
    if (!plan) return send(res, 404, { error: 'that one has fewer than four directions' })
    const item = await writeRotations(id, plan)
    if (!item) return send(res, 502, { error: 'the directions did not save' })
    // the same trim the generate route does. An account character carries the
    // same ~40% animation headroom as a fresh one, and a figure imported before
    // this landed measured 11 to 12 painting pixels of float in the game.
    const box = trimSet(plan.dir, item.dirs)
    if (box) {
      item.w = box.w
      item.h = box.h
    }
    // trimSet rewrites every frame in place, so the store is only told about
    // this set once the pixels have stopped changing
    await pushLibrary(id, item.name)
    return send(res, 200, { item })
  }

  /* ONE SPRITE, DRAWN TO ORDER. One variant per call: the client runs this once
   * for each variant it wants, so it can show the first one and ask before
   * buying the rest. name and seed are what make two calls two different takes
   * of the same ask rather than one row overwritten twice.
   *
   * WHAT IT NO LONGER TAKES. This route used to be handed bodyType, template,
   * walk and nDirections straight off four dropdowns, and a dropdown is a list
   * of what can exist, which is always shorter than what someone can imagine.
   * Now it takes skeleton and anim, which the ROUTER decided by reading the ask
   * against the map (see planMake). The old fields are still accepted so an
   * older client keeps working, but nothing sends them by choice.
   *
   * The price is one generation for the body in standard mode plus one per
   * direction for the motion, so a moving sprite is nine and a still one is
   * one. Pro is 20-40 on its own and is never the default.
   *
   * Motion has two paths and the second one is the point. A named template is
   * the cheap, proven walk cycle for a two-legged thing. Written motion is
   * mode v3, which takes any words at all, and it is the only way a dragon
   * hovers, a ghoul lurches or a robot idles its servos. Neither could be
   * expressed by a list.
   *
   * What lands is what /api/character-import lands, through the same writer:
   * work/<id>/library/<name>/<heading>-<frame>.png beside a dirs.json carrying
   * dirs and fps. Nothing downstream has to know which route made it.
   *
   * The whole set is trimmed to one shared box on the way in, because pixellab
   * draws into a canvas about 40% bigger than the character to leave animation
   * headroom, and that empty margin is why an imported figure stands in the air.
   */
  if (p === '/api/character-gen' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const description = String(b.description || '').replace(/\s+/g, ' ').trim().slice(0, PROMPT_MAX)
    if (!description) return send(res, 400, { error: 'no description' })
    // nothing above this line costs anything, and nothing below it runs without
    // the word: a stray post, a reload, a retry loop must not spend
    if (b.confirm !== true) return send(res, 400, { error: 'this spends generations: send confirm true' })

    const mode = CHAR_MODES.includes(String(b.mode)) ? String(b.mode) : 'standard'
    // pro and v3 come back eight ways whatever is asked for, and the motion is
    // priced per direction, so the count has to be the real one
    const nDirections = mode === 'standard' && Number(b.nDirections) === 4 ? 4 : 8
    const view = CHAR_VIEWS.includes(String(b.view)) ? String(b.view) : OBJECT_VIEW
    /* The rig, from the router, or worked back out of the old two fields.
     *
     * mannequin and the five four-legged bodies are the whole of what exists.
     * The router picks the nearest by body plan and the description carries
     * what the thing actually is, so a robot is a mannequin that reads as a
     * machine and a dragon is a lion that hovers. */
    const skeleton = SKELETONS.includes(String(b.skeleton)) ? String(b.skeleton) : legacySkeleton(b)
    if (!skeleton) return send(res, 400, { error: 'an animal needs a body: ' + QUADRUPEDS.join(', ') })
    const bodyType = skeleton === 'mannequin' ? 'humanoid' : 'quadruped'
    // written motion is priced by pixel budget per direction, and at or under
    // this it is one generation per direction, which is what the button said
    const size = Math.max(SPRITE_MIN, Math.min(SPRITE_MAX, Math.round(Number(b.size) || 48)))
    /* How it moves, held to what the endpoint will take.
     *
     * The router's clamps are applied again here, because this route is
     * reachable without going through it and an invented template id is a 422
     * that arrives after the body has been paid for.
     *
     * Only a named how counts as moving. spriteAnim's job inside the router is
     * to rescue a garbled answer to a MOVING ask, so it falls through to
     * written motion; here there is no ask to read, so an anim with no how is
     * simply a malformed request and lands standing. A garbled request costs
     * one generation, not nine.
     *
     * The description is what the walk gate reads. It is the only account of
     * the thing this route ever gets, and a route reachable without the router
     * is exactly where a walk nobody asked for would otherwise get through.
     * An action with no words in it is refused here, before the body: a 400 is
     * cheaper than a sprite that came back doing the wrong thing. */
    const want = b.anim && typeof b.anim === 'object' ? b.anim : legacyAnim(b)
    const moving = want.how === 'template' || want.how === 'action'
    let anim
    try {
      anim = spriteAnim(want, moving ? 'animated' : 'static', skeleton, '', description)
    } catch (e) {
      return send(res, 400, { error: String((e && e.message) || e).slice(0, 200) })
    }
    const seed = seedOf(b)
    // pixellab's own look controls, passed through only when the ui sent one
    const look = {}
    for (const k of ['outline', 'detail', 'proportions']) if (b[k]) look[k] = String(b[k]).slice(0, 40)
    if (mode === 'pro' && b.styleCharacterId) look.styleCharacterId = String(b.styleCharacterId).slice(0, 64)

    const { gate, halt, done } = gateFor(String(b.job || '').slice(0, 64))
    let folder = ''
    try {
      halt()
      const cid = await pixellab.createCharacter({
        description,
        size,
        view,
        nDirections,
        bodyType,
        template: bodyType === 'quadruped' ? skeleton : '',
        mode,
        seed,
        ...look,
      })
      if (!cid) throw new Error('no character came back')
      let d = await raceStop(gate, pixellab.awaitCharacter(cid, { timeoutMs: CHAR_WAIT }))
      // the motion is eight more generations. The minutes the body took are the
      // one window in which they can still be saved, so this is where a change
      // of mind is worth the most.
      halt()
      let note = ''
      if (anim.how !== 'none') {
        /* The body is paid for by the time the motion is asked for, so nothing
         * about the motion is allowed to take it down with it. The case that
         * bites is a four-legged rig: quadruped templates are named per body,
         * so a humanoid template id comes straight back 422 and a run that let
         * that through would bin a body that was already bought. It lands
         * standing instead and the reason travels with it.
         *
         * The still rotations are kept rather than whatever the motion half
         * landed, so every heading has the same number of frames. */
        try {
          /* The one place the two paths part.
           *
           * A template names its own directions by default, every heading the
           * character has, which is what the button priced. Written motion
           * does NOT: the schema defaults custom mode to south only, so the
           * headings are named out loud or seven of the eight never happen.
           *
           * They are read off the body that just landed rather than assumed,
           * because a four-direction character has four and naming a heading
           * it does not have is a generation asked for and thrown away. */
          const h =
            anim.how === 'template'
              ? await pixellab.animateCharacter({ characterId: cid, templateAnimationId: anim.template, seed })
              : await pixellab.animateCharacterAction({
                  characterId: cid,
                  action: anim.action,
                  frameCount: anim.frames,
                  directions: headingsOf(d, nDirections),
                  seed,
                })
          d = await raceStop(gate, pixellab.awaitAnimation(cid, h, { timeoutMs: WALK_WAIT }))
        } catch (e) {
          const m = String((e && e.message) || e)
          note = m === 'stopped' ? 'stopped mid motion, so it stands still' : 'no motion · ' + m.slice(0, 140)
        }
      }
      // Two readings, both deliberate. Every animation on it is the one just
      // paid for, because this route bought the only one it has, and its name is
      // a template id or the word motion rather than anything with walk in it.
      // Unnamed, the library row is the first few words of the ask, the way a
      // generated object is named; a variant run passes its own name in.
      const plan = await saveFrames(id, characterDirs(d, '*'), b.name ? cleanName(b.name) : slugName(description), 8, cid)
      if (!plan) throw new Error('it came back with fewer than four directions')
      folder = plan.dir
      const item = await writeRotations(id, plan)
      if (!item) throw new Error('the directions did not save')
      const box = trimSet(plan.dir, item.dirs)
      if (box) {
        item.w = box.w
        item.h = box.h
      }
      noteAsk(id, item.name, description, description, 'character')
      await pushLibrary(id, item.name)
      return send(res, 200, { item, note })
    } catch (e) {
      // a folder with three headings in it lists in the library looking like a
      // character and is not one, so a run that died halfway leaves nothing
      if (folder) {
        try {
          fs.rmSync(folder, { recursive: true, force: true })
        } catch {
          /* it was never written, or something else holds it; either way the error below is the news */
        }
      }
      const m = String((e && e.message) || e)
      return send(res, m === 'stopped' ? 499 : 502, { error: m.slice(0, 300) })
    } finally {
      done()
    }
  }

  // End a planner that is still thinking, or a wait on pixellab, by the job id
  // the client sent with it. Free, and idempotent: stopping something already
  // finished is fine.
  if (p === '/api/stop' && req.method === 'POST') {
    const b = await body(req)
    return send(res, 200, { stopped: stopJob(String(b.job || '')) })
  }

  if (p === '/api/asset-gen' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const prompt = String(b.prompt || '').trim()
    if (!prompt) return send(res, 400, { error: 'no prompt' })
    // one job for the whole run of variants, so a stop between two of them ends
    // the one in flight and the client's own loop stops asking for more
    const job = String(b.job || '').slice(0, 64)
    const { gate, halt, done } = gateFor(job)
    try {
      // a translation confirmed in the ui rides in as b.thing and wins; only a
      // bare ask (older client, direct api use) translates here
      const t = b.thing
        ? { thing: String(b.thing).slice(0, PROMPT_MAX), motion: '', w: clampPx(b.tw), h: clampPx(b.th) }
        : await translateAsk(prompt, 'static', '', id, job)
      /* THE CANVAS, SETTLED HERE AND NOWHERE ELSE, because the crop below has
       * to be the same two numbers to the pixel and the endpoint refuses the
       * pair when they disagree. Both sides even: 150x95 came back
       * "must both be divisible by 2" after the router had spent thirteen
       * seconds choosing it. Rounding down keeps it inside every cap it just
       * passed, and pixellab.mjs evens again on the way out, which is a
       * no-op from here and a fence for any other caller. */
      const even = (n) => Math.max(32, Math.floor(clampPx(n) / 2) * 2)
      const w = even(b.w || t.w)
      const h = even(b.h || t.h)
      /* THE COHESION CROP IS DEAD, and it cost twenty-two generations to be
       * sure, so the finding is written where the next person will look.
       *
       * The idea was sound and the endpoint really does take a picture of the
       * map: background_image for style matching, color_image for a forced
       * palette. Both were tried, twice, in the two modes the schema allows.
       *
       *   With an oval inpainting mask: ten generations came back as CIRCLES of
       *   blurred map material with no object in them at all.
       *   Without one, at the exact canvas the endpoint demands: three came
       *   back as the crop's own content restyled. A puddle returned jetty
       *   planks, a bookshelf returned roof tiles, a tree returned foliage and
       *   a roof corner.
       *
       * The pattern is the same both times and it is not a wiring bug the
       * second time: handed a picture of somewhere, this endpoint continues
       * that picture instead of drawing the subject into it. It is a tool for
       * editing a map in place, and MAPVIS does not edit maps in place, it
       * makes library sprites. So the map goes to the ROUTER, which can see and
       * reason, and never to the generator, which can only copy.
       *
       * Do not rebuild this. If it is ever revisited the thing to prove first
       * is that a subject survives at all, on one generation, before anything
       * is wired to it. */
      // the last free moment. Past this line the png is bought whatever happens
      // next, so everything below still writes it to disk.
      halt()

      /* THE ILLUSTRATOR, and it is the primary because it is the only one with
       * a CAMERA. Read off the live schema: /v2/map-objects takes view with an
       * enum of low top-down, high top-down and side. /v2/generate-image-v2,
       * which paints, has no view, no camera, no projection parameter at all.
       *
       * A style image was tried as the fix and it is not one. style_options
       * carries colour_palette, outline, detail and shading, so a painted ship
       * came back in the map's exact palette and outline and pointing the wrong
       * way, because none of those four is the angle.
       *
       * The view is read back out of the prompt that is about to be sent, so
       * the parameter and the words are the same decision by construction and
       * not by anybody remembering to pass a field. See viewFor.
       *
       * THE CANVAS IS THE OBJECT'S OWN, always. It used to become the crop's
       * size whenever a background rode along, which was a consequence of the
       * inpainting mode: that mode paints a hole in a picture, so the picture's
       * size was the answer's size. Style matching does not work that way. The
       * crop is reference and the object is drawn at the size the router chose
       * against the things already on the map, which is the only size that was
       * ever measured against anything. */
      const drawn = await raceStop(
        gate,
        pixellab.mapObject({
          description: t.thing,
          w,
          h,
          view: viewFor(t.thing),
          seed: seedOf(b),
        }),
      )
      const item = await saveStatic(
        id,
        drawn.b64,
        b.name ? cleanName(b.name) : 'gen-' + slugName(prompt),
        prompt,
        t.thing,
        drawn.objectId,
      )
      return send(res, 200, { item })
    } catch (e) {
      const m = String((e && e.message) || e)
      return send(res, m === 'stopped' ? 499 : 502, { error: m.slice(0, 300) })
    } finally {
      done()
    }
  }

  // ONE pixellab spend behind the same armed confirm, WITH context: a crop of
  // the cut painting around the user's chosen spot rides along, and
  // /v2/map-objects paints the thing into that crop's palette and light,
  // answering with a transparent cutout. Bare-canvas pixflux turns small
  // props into mush; this is pixellab's own cohesion tool for exactly that.
  // The api's usage field bills it in the same units as a static generation.
  // cx/cy (the clicked painting pixel) ride along for the record; the client
  // owns placement. The cutout saves into work/<id>/library like asset-gen.
  if (p === '/api/asset-gen-here' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const prompt = String(b.prompt || '').trim()
    if (!prompt) return send(res, 400, { error: 'no prompt' })
    const crop = stripDataURL(String(b.crop || ''))
    if (!crop) return send(res, 400, { error: 'no crop' })
    const cs = pngSizeBuf(Buffer.from(crop, 'base64'))
    // the endpoint's own limits: 32px per side minimum, 192x192 of area with
    // inpainting. The client sends up to 160 square, clamped to the canvas.
    if (!(cs.w >= 32 && cs.h >= 32 && cs.w * cs.h <= 192 * 192))
      return send(res, 400, { error: `crop must be 32..192 per side, got ${cs.w}x${cs.h}` })
    const job = String(b.job || '').slice(0, 64)
    const { gate, halt, done } = gateFor(job)
    const wantName = b.name ? cleanName(b.name) : 'gen-' + slugName(prompt)
    try {
      const t = b.thing
        ? { thing: String(b.thing).slice(0, 480), motion: String(b.tmotion || ''), w: clampPx(b.tw), h: clampPx(b.th) }
        : await translateAsk(prompt, b.kind === 'animated' ? 'animated' : 'static', '', id, job)
      // the oval mask: the sprite's intended footprint as a share of the crop,
      // held inside 0.15..0.8 so surrounding art always frames the object
      const fraction = Math.max(0.15, Math.min(0.8, (t.w * t.h) / (cs.w * cs.h)))
      halt()
      const drawn = await raceStop(
        gate,
        pixellab.mapObject({
          description: t.thing,
          w: cs.w,
          h: cs.h,
          // the same one decision, read off the same bytes. See viewFor.
          view: viewFor(t.thing),
          background: crop,
          fraction,
          seed: seedOf(b),
        }),
      )
      const b64 = drawn.b64
      // animated-with-context: the style-matched cutout becomes the FIRST FRAME
      // and the animation endpoint drives it with the motion words. The frames
      // land as a folder, the library's animated shape. The animate endpoint
      // caps first_frame at 256 and the frame budget at w*h*8 <= 524288, and a
      // 192-cap crop fits both.
      if (b.kind === 'animated') {
        // the second spend, and the one a stop is worth a whole generation at.
        // The cutout above is already bought either way, so a stop before or
        // during the animation files it standing rather than binning it.
        const motion = String(b.tmotion || b.motion || '').trim() || t.motion || t.thing
        const frames = await stillOnStop(gate, () =>
          pixellab.animate({ base64: b64, action: motion, frameCount: 8, seed: seedOf(b) }),
        )
        if (!frames)
          return send(res, 200, { item: await saveStatic(id, b64, wantName, prompt, t.thing, drawn.objectId), note: STOPPED_STILL })
        const adir = libDirOf(id)
        let aname = wantName
        for (let i = 2; fs.existsSync(path.join(adir, aname)); i++) aname = `${wantName}-${i}`
        const fdir = path.join(adir, aname)
        fs.mkdirSync(fdir, { recursive: true })
        const rel = []
        for (let i = 0; i < frames.length; i++) {
          fs.writeFileSync(path.join(fdir, i + '.png'), Buffer.from(frames[i], 'base64'))
          rel.push(`/work/${id}/library/${aname}/${i}.png`)
        }
        const fsize = pngSize(path.join(fdir, '0.png'))
        noteAsk(id, aname, prompt, t.thing)
        // two generations were paid for and only disk was told. On a host that
        // disk is a tmp dir, so the frames were gone with the request. Same
        // awaited push saveStatic makes on the still branch two lines down.
        await pushLibrary(id, aname)
        return send(res, 200, {
          item: { name: aname, kind: 'animated', frames: rel, fps: 6, w: fsize.w, h: fsize.h },
        })
      }
      return send(res, 200, { item: await saveStatic(id, b64, wantName, prompt, t.thing, drawn.objectId) })
    } catch (e) {
      const m = String((e && e.message) || e)
      return send(res, m === 'stopped' ? 499 : 502, { error: m.slice(0, 300) })
    } finally {
      done()
    }
  }

  // TWO pixellab spends behind the same armed confirm: a transparent base
  // object, then one 8-frame animation of it via /v2/animate-with-text-v3 with
  // the motion words as the action. The base comes off the same object
  // endpoint the static path uses, for the same reason: pixflux put the thing
  // on a plinth and the plinth then animated along with it. At 128 or less the
  // 8 frames stay inside pixellab's one-generation pixel budget, so the pair is
  // two generations. The frames land as work/<id>/library/<name>/0..n.png, the
  // folder shape the library lists as one animated item.
  /* ---- ANOTHER FACE FOR SOMETHING THAT ALREADY EXISTS -------------------
   *
   * A troll that turns into a boulder does not need a boulder. It needs
   * ITSELF, curled up. Those are not the same picture and the difference is
   * the whole feature: a boulder drawn from scratch is its own palette, its own
   * canvas and its own silhouette, so the swap mid-round reads as one sprite
   * being replaced by another rather than one thing changing. There are two
   * halves to it: whether the boulder and the troll match, and what happens
   * when the library holds more than one boulder.
   *
   * Both go away here, and neither needs a rule to keep them away. The state is
   * an EDIT of the art that is already on the account, so it cannot drift off
   * the thing it is a state of; and it is stored under the row that owns it, so
   * there is no flat namespace to be ambiguous in. There is no "which boulder".
   * There is only this troll's second face.
   *
   * The character route edits all 4 or 8 rotations in one job, which is what
   * keeps a walker from snapping round to face south the moment it transforms,
   * and it snaps the result to the source's own palette because pixellab has a
   * flag for exactly that.
   *
   * ONE generation, and the cost line says so before it is pressed. */
  if (p === '/api/asset-state' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const owner = cleanName(b.name || '')
    const ask = String(b.ask || '').trim()
    if (!owner) return send(res, 400, { error: 'no item' })
    if (!ask) return send(res, 400, { error: 'say what it turns into' })
    const it = readLibItem(id, owner)
    if (!it) return send(res, 404, { error: 'that is not in this library' })
    /* Two places have ever recorded where art came from and both are read, in
     * the order of how sure they are. origin.json is written at generation time
     * and names the row exactly. dirs.json's characterId was pinned by the
     * motion lane and is just as good when it is there. Neither present means
     * this row was imported or hand-made, and the honest answer is that it
     * cannot be edited rather than a guess at which of 769 rows it might be. */
    const o = readOrigin(id)[owner] || {}
    const characterId = o.characterId || (it.meta && it.meta.characterId) || ''
    const objectId = o.objectId || ''
    if (!characterId && !objectId)
      return send(res, 400, {
        error: 'nothing on record says what drew this, so it cannot be edited into another state',
      })
    const job = String(b.job || '').slice(0, 64)
    const { gate, halt, done } = gateFor(job)
    try {
      halt() // the last free moment
      const dir = stateDirOf(id, owner)
      fs.mkdirSync(dir, { recursive: true })
      // a face is named for what it becomes, so the planner can say the word
      const base = cleanName(b.state || slugName(ask))
      let face = base
      for (let i = 2; fs.existsSync(path.join(dir, face)) || fs.existsSync(path.join(dir, face + '.png')); i++)
        face = `${base}-${i}`
      let usage = null
      if (characterId) {
        const made = await raceStop(gate, pixellab.characterState({ characterId, edit: ask, name: face, seed: seedOf(b) }))
        usage = made.usage
        const byDir = characterDirs(made.detail, '*')
        const keys = Object.keys(byDir).filter((k) => byDir[k] && byDir[k].length)
        if (keys.length < 4) throw new Error('the state came back without its headings')
        const dirs = {}
        for (const k of keys) {
          const urls = byDir[k]
          const rel = []
          fs.mkdirSync(path.join(dir, face, k), { recursive: true })
          for (let i = 0; i < urls.length; i++) {
            fs.writeFileSync(path.join(dir, face, k, i + '.png'), await pixellab.fetchPNG(urls[i]))
            rel.push(`/work/${id}/states/${encodeURIComponent(owner)}/${encodeURIComponent(face)}/${encodeURIComponent(k)}/${i}.png`)
          }
          dirs[k] = rel
        }
        fs.writeFileSync(path.join(dir, face, 'dirs.json'), JSON.stringify({ dirs, fps: 8, characterId: made.characterId }, null, 2))
      } else {
        const made = await raceStop(gate, pixellab.objectState({ objectId, edit: ask, name: face, seed: seedOf(b) }))
        usage = made.usage
        fs.writeFileSync(path.join(dir, face + '.png'), Buffer.from(made.b64, 'base64'))
        // the state's OWN id, so a face can itself be edited again
        noteOrigin(id, owner, { faces: { ...(o.faces || {}), [face]: made.objectId } })
      }
      noteAsk(id, `${owner} > ${face}`, ask, ask, 'state')
      // the new face goes to the store before the response admits it exists,
      // the same rule every other library write follows
      await pushLibrary(id, owner)
      const item = platformOn()
        ? (await libraryOf(id)).find((x) => x.name === owner)
        : libraryItems(id).find((x) => x.name === owner)
      // the price, said out loud, because nothing documents what a state edit
      // costs and the button above it has to stop guessing
      return send(res, 200, { item: item || null, face, usage })
    } catch (e) {
      const m = String((e && e.message) || e)
      return send(res, m === 'stopped' ? 499 : 502, { error: m.slice(0, 300) })
    } finally {
      done()
    }
  }

  if (p === '/api/asset-anim' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const prompt = String(b.prompt || '').trim()
    if (!prompt) return send(res, 400, { error: 'no prompt' })
    const job = String(b.job || '').slice(0, 64)
    const { gate, halt, done } = gateFor(job)
    const wantName = b.name ? cleanName(b.name) : 'gen-' + slugName(prompt)
    try {
      // the motion rides separately from the thing: one merged prompt let scene
      // words bleed into the sprite (a smoke prompt that mentioned its volcano
      // generated a volcano, twice, 2026-08-16). The interpreter splits the ask
      // when the user leaves the motion empty; an explicit motion wins.
      const t = b.thing
        ? { thing: String(b.thing).slice(0, PROMPT_MAX), motion: String(b.tmotion || ''), w: clampPx(b.tw), h: clampPx(b.th) }
        : await translateAsk(prompt, 'animated', '', id, job)
      const motion = String(b.motion || '').trim() || t.motion || t.thing
      const seed = seedOf(b)
      // the interpreter's canvas choice holds for animation too, capped so the
      // 8 frames stay inside pixellab's one-generation pixel budget (w*h*8)
      const aw = Math.min(128, clampPx(t.w))
      const ah = Math.min(128, clampPx(t.h))
      halt()
      const drawn = await raceStop(
        gate,
        pixellab.mapObject({
          description: t.thing,
          w: aw,
          h: ah,
          // the same one decision, read off the same bytes. See viewFor.
          view: viewFor(t.thing),
          seed,
        }),
      )
      const b64 = drawn.b64
      // the base is bought. A stop between the two halves saves the second
      // generation, and the first one still lands, as a still object.
      const frames = await stillOnStop(gate, () => pixellab.animate({ base64: b64, action: motion, frameCount: 8, seed }))
      if (!frames)
          return send(res, 200, { item: await saveStatic(id, b64, wantName, prompt, t.thing, drawn.objectId), note: STOPPED_STILL })
      const dir = libDirOf(id)
      const name = await freeLibraryName(id, wantName)
      const fdir = path.join(dir, name)
      fs.mkdirSync(fdir, { recursive: true })
      const rel = []
      for (let i = 0; i < frames.length; i++) {
        fs.writeFileSync(path.join(fdir, i + '.png'), Buffer.from(frames[i], 'base64'))
        rel.push(`/work/${id}/library/${name}/${i}.png`)
      }
      const size = pngSize(path.join(fdir, '0.png'))
      noteAsk(id, name, prompt, t.thing)
      // the base object and the 8 frames are both bought, and only disk was
      // told. On a host WORK is a fresh tmp dir per request, so both spends went
      // with the instance and the library row never learned the item existed.
      // Same awaited push asset-gen-here's animated branch and saveStatic make.
      await pushLibrary(id, name)
      return send(res, 200, {
        item: { name, kind: 'animated', frames: rel, fps: 6, w: size.w, h: size.h },
      })
    } catch (e) {
      const m = String((e && e.message) || e)
      return send(res, m === 'stopped' ? 499 : 502, { error: m.slice(0, 300) })
    } finally {
      done()
    }
  }

  /* MAKE A THING THAT ALREADY EXISTS MOVE, or replace the motion it has.
   *
   * The person types what they want and never picks a path. There are three,
   * and the router chooses by reading the item off disk and asking what the
   * words need. A list of animations to choose from is the one thing this must
   * never grow into: whatever they can describe is what it has to try.
   *
   *   character  a person or animal with headings. Every heading goes in ONE
   *              coordinated job through /v2/animate-character, priced per
   *              direction. Eight separate calls to the single-image animator
   *              would come back as eight loops with eight rhythms, so a figure
   *              would breathe faster facing north than facing south. That is a
   *              defect, not a saving, and this route refuses rather than ship
   *              it: no character id, no animation.
   *   sprite     one png, or a folder of frames. /v2/animate-with-text-v3
   *              drives it off its own first frame.
   *   written    the ask needs the thing to TRAVEL, or to trace a path, which
   *              neither generator can do at all: both only ever redraw a
   *              sprite where it stands. A written recipe stamps the item's own
   *              sprite at a position it works out per frame, and costs
   *              nothing. This route does not run that, it NAMES it, so the
   *              client can offer the free path rather than quietly charge for
   *              the wrong one.
   *
   * Two presses, like every other spend. Without confirm this is a free read
   * that answers the plan and the true price. With confirm it runs the plan it
   * was handed back, so the number on the button is the number that gets spent.
   *
   * Replacing is in place and safe. Every byte is fetched, trimmed and settled
   * under work/<id>/.stage before the library folder is touched, and the old
   * bytes go to work/<id>/.prev the way /api/asset-crop puts them there. One
   * library row per thing, and a failure or a stop leaves the item as it was.
   */
  if (p === '/api/asset-animate' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const name = cleanName(b.name || '')
    const ask = String(b.ask || '').replace(/\s+/g, ' ').trim().slice(0, PROMPT_MAX)
    if (!b.name) return send(res, 400, { error: 'no item' })
    if (!ask) return send(res, 400, { error: 'say what it should do' })
    const it = readLibItem(id, name)
    if (!it) return send(res, 404, { error: 'not in the library' })
    const job = String(b.job || '').slice(0, 64)

    /* The plan the client was shown wins over a fresh one. A router that
     * changed its mind between the price and the press would make the price a
     * lie, and the price is the whole of what the person is agreeing to. */
    let plan
    try {
      plan = await animatePlan(it, ask, id, job, b)
    } catch (e) {
      const m = String((e && e.message) || e)
      return send(res, m === 'stopped' ? 499 : 502, { error: m.slice(0, 300) })
    }
    // nothing below this line runs without the word: a stray post, a reload or
    // a retry loop must not spend
    if (b.confirm !== true) return send(res, 200, { plan })
    // both of these spend nothing, and confirming them still spends nothing
    if (plan.path === 'written') return send(res, 200, { plan, free: true, note: plan.note })
    if (plan.path === 'blocked') return send(res, 409, { error: plan.why, plan })

    const seed = seedOf(b)
    const { gate, halt, done } = gateFor(job)
    try {
      if (plan.path === 'character') {
        /* Frames bought by an earlier attempt that could not read them back.
         * Charging a second time for art already sitting on the account is the
         * worst thing this route could do, so recovery is offered before the
         * spend rather than as a repair afterwards. */
        let byDir = null
        if (b.recover) {
          const found = await recoverCharacterMotion(plan)
          if (!found) return send(res, 409, { error: 'nothing already paid for was found on this one' })
          byDir = found.byDir
        } else {
          byDir = await runCharacterMotion(plan, seed, gate, halt)
        }
        // past here every generation is bought and every frame is theirs, so
        // the download runs to the end whatever a stop says. Stopping is not
        // undoing.
        const st = await stageViews(id, name, byDir, it.fps || 8)
        if (!st) throw new Error('the headings did not save')
        /* The id is the only way back to the rig that drew this, and a rewrite
         * that forgets it strands the art for good: nothing on disk says which
         * character it came from and the motion can never be replaced or
         * recovered again. Never write undefined over one that was there. */
        const keepId = plan.characterId || (it.meta && it.meta.characterId) || ''
        await swapFolder(id, name, st.stage, { dirs: st.dirs, fps: st.fps, characterId: keepId })
        noteAsk(id, name, ask, plan.motion, 'motion')
        return send(res, 200, {
          item: {
            name,
            kind: 'static',
            dirs: st.dirs,
            fps: st.fps,
            src: st.dirs.south ? st.dirs.south[0] : Object.values(st.dirs)[0][0],
            w: st.w,
            h: st.h,
          },
          note: plan.note,
        })
      }

      const src = it.shape === 'still' ? it.file : path.join(it.folder, it.frames[0])
      const first = fs.readFileSync(src)
      halt()
      const frames = await raceStop(
        gate,
        pixellab.animate({
          base64: (plan.pad ? padPNG(first) : first).toString('base64'),
          action: plan.motion,
          frameCount: plan.frames,
          seed,
        }),
      )
      if (!frames || !frames.length) throw new Error('the animation came back with no frames')
      const st = stageFrames(id, name, frames)
      /* A still becomes a frame folder under the SAME name, so the library keeps
       * one row rather than growing a second one beside it. The png is backed up
       * like any other replaced bytes and only removed once the folder is whole:
       * a crash in between leaves the original standing, which is the safe way
       * round. */
      if (it.shape === 'still') keepPrevFile(id, it.file, name + '.png')
      await swapFolder(id, name, st.stage, null)
      if (it.shape === 'still') fs.rmSync(it.file, { force: true })
      // an item that carried a written recipe does not carry it any more.
      // Leaving effect.json beside pixellab's frames would reopen a recipe that
      // did not draw them, and the library would keep calling it an effect.
      else fs.rmSync(path.join(libDirOf(id), name, 'effect.json'), { force: true })
      noteAsk(id, name, ask, plan.motion, 'motion')
      // 6, because that is what libraryItems will say about this folder on the
      // next read: a frame folder carries no rate of its own unless effect.json
      // is beside it, and the one that was there did not draw these pixels
      return send(res, 200, {
        item: { name, kind: 'animated', frames: st.frames, fps: 6, w: st.w, h: st.h },
        note: plan.note,
      })
    } catch (e) {
      // the library was never touched: everything happens in .stage until there
      // is nothing left that can fail
      fs.rmSync(path.join(stageDirOf(id), name), { recursive: true, force: true })
      const m = String((e && e.message) || e)
      return send(res, m === 'stopped' ? 499 : 502, { error: m.slice(0, 300) })
    } finally {
      done()
    }
  }

  // What he typed, back to him. The library only ever kept a four-word slug of
  // the ask, so "what did I write to get that tree?" had no answer anywhere in
  // the app. Newest first.
  if (p.startsWith('/api/asks/')) {
    return send(res, 200, { asks: readAsks(decodeURIComponent(p.slice('/api/asks/'.length))) })
  }

  // Which motion rule fits the ask, and what numbers to start it at. When none
  // of the seven fits, the answer is a renderer WRITTEN for the words instead,
  // which the client runs in a sandbox. FREE either way: this route never
  // touches pixellab, it only reads the ask and the colours the client sampled
  // off the painting. On any failure a keyword match answers instead, so the
  // effect box can never dead-end.
  if (p === '/api/effect-plan' && req.method === 'POST') {
    const b = await body(req)
    const ask = String(b.ask || '').trim()
    if (!ask) return send(res, 400, { error: 'no ask' })
    const colors = (Array.isArray(b.colors) ? b.colors : [])
      .map((c) => String(c).trim())
      .filter((c) => /^#[0-9a-f]{6}$/i.test(c))
      .slice(0, 12)
    // sprite says an existing library sprite has been put in the recipe's
    // hands, which changes what can be written: it can move the thing the
    // person already owns rather than draw a new one out of pixels
    return send(res, 200, {
      plan: await effectPlan(ask, colors, b.id ? safeId(b.id) : '', String(b.job || ''), !!b.sprite),
    })
  }

  // The rendered frames, written exactly like an animated library item:
  // work/<id>/library/<name>/0..n.png, plus effect.json beside them holding the
  // rule, its numbers and the sampled colours, so the effect can be reopened
  // and retuned later. Nothing is generated and nothing is spent here either.
  // overwrite rewrites an item that already exists IN PLACE: the frame urls do
  // not change, so every placement of it picks the new pixels up. Frames left
  // over from a longer previous take are deleted, or the folder would play a
  // mix of two renders.
  if (p === '/api/effect-save' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const frames = Array.isArray(b.frames) ? b.frames : []
    if (!frames.length) return send(res, 400, { error: 'no frames' })
    // 8 headings of 8 frames is 64, exactly the old cap, so a walking sprite
    // sat on the edge of being refused outright
    if (frames.length > 256) return send(res, 400, { error: 'too many frames' })
    const dir = libDirOf(id)
    fs.mkdirSync(dir, { recursive: true })
    const base = cleanName(b.name || 'effect')
    let name = base
    // a still that is about to become a folder of frames, which is what happens
    // when a recipe is written to MOVE a sprite that has never moved before
    let wasStill = ''
    if (b.overwrite) {
      const target = path.resolve(dir, name)
      if (!target.startsWith(path.resolve(dir) + path.sep)) return send(res, 400, { error: 'bad name' })
      const asDir = fs.existsSync(target) && fs.statSync(target).isDirectory()
      if (!asDir && fs.existsSync(target + '.png')) wasStill = target + '.png'
      else if (!asDir) return send(res, 404, { error: 'not in the library' })
    } else {
      /* disk for what is mid-request, the database for what exists at all. The
       * walk this replaced only looked at libDirOf(id), which on a host starts
       * empty every request, so every keep would pick the base name and the push
       * at the end would overwrite the store row already under it. */
      name = await freeLibraryName(id, base)
    }
    const fdir = path.join(dir, name)
    fs.mkdirSync(fdir, { recursive: true })
    const rel = []
    for (let i = 0; i < frames.length; i++) {
      fs.writeFileSync(path.join(fdir, i + '.png'), Buffer.from(stripDataURL(String(frames[i])), 'base64'))
      rel.push(`/work/${id}/library/${name}/${i}.png`)
    }
    for (let i = frames.length; fs.existsSync(path.join(fdir, i + '.png')); i++) fs.unlinkSync(path.join(fdir, i + '.png'))
    /* The png goes only once the folder is whole, and its bytes go to .prev
     * first. Both halves matter: the item keeps ONE library row, and a crash in
     * between leaves the original standing rather than nothing at all. */
    if (wasStill) {
      keepPrevFile(id, wasStill, name + '.png')
      fs.rmSync(wasStill, { force: true })
    }
    const meta = b.meta && typeof b.meta === 'object' ? b.meta : {}
    const fps = Number(meta.fps) > 0 ? Math.round(Number(meta.fps)) : 6
    const rec = {
      type: meta.type || '',
      params: meta.params || {},
      // whose colours these are, so a reopened effect keeps its own ramp
      // instead of falling back onto the map's the moment it is retuned
      palette: meta.palette === 'own' ? 'own' : 'map',
      colors: meta.colors || [],
      fps,
      frames: frames.length,
    }
    // a written effect keeps its recipe beside its frames, or the pencil would
    // reopen a panel with nothing to render and no knobs to turn
    if (rec.type === 'custom') {
      rec.code = cleanCode(meta.code)
      rec.controls = cleanControls(meta.controls)
    }
    fs.writeFileSync(path.join(fdir, 'effect.json'), JSON.stringify(rec, null, 2))
    const size = pngSize(path.join(fdir, '0.png'))
    // effects record on KEEP, not on every attempt, or one tuning session would
    // bury a week of asset asks under thirty near-identical lines
    if (b.ask && !b.overwrite) noteAsk(id, name, b.ask, rec.type === 'custom' ? 'written' : rec.type, 'effect')
    // nothing was generated here, but frames and effect.json are still a library
    // write, and this return used to end at disk. On a host that disk is a tmp
    // dir that dies with the request, so a kept effect was gone the moment the
    // response was sent. pushItem carries effect.json across with the frames.
    await pushLibrary(id, name)
    return send(res, 200, { item: { name, kind: 'animated', effect: true, frames: rel, fps, w: size.w, h: size.h } })
  }

  // The rule, the numbers and the colours a saved effect was built from, so the
  // tuning panel reopens on exactly what is on disk. Free, and read-only.
  if (p === '/api/effect-read' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const name = cleanName(b.name || '')
    const dir = path.resolve(libDirOf(id))
    const f = path.resolve(dir, name, 'effect.json')
    if (!f.startsWith(dir + path.sep) || !fs.existsSync(f)) return send(res, 404, { error: 'no effect saved under that name' })
    let meta = {}
    try {
      meta = JSON.parse(fs.readFileSync(f, 'utf8'))
    } catch {
      return send(res, 500, { error: 'the saved effect did not read' })
    }
    const out = {
      type: String(meta.type || ''),
      params: meta.params && typeof meta.params === 'object' ? meta.params : {},
      palette: meta.palette === 'own' ? 'own' : 'map',
      colors: Array.isArray(meta.colors) ? meta.colors.filter((c) => /^#[0-9a-f]{6}$/i.test(String(c))) : [],
      fps: Number(meta.fps) > 0 ? Math.round(Number(meta.fps)) : 6,
      frames: Number(meta.frames) > 0 ? Math.round(Number(meta.frames)) : 0,
    }
    // the recipe and its knobs, so a written effect reopens on exactly what
    // drew it. Built-in effects have neither and go without.
    if (out.type === 'custom') {
      out.code = cleanCode(meta.code)
      out.controls = cleanControls(meta.controls)
    }
    return send(res, 200, out)
  }

  // THE REVIEW LOOP, the free half of it. The frames the client just rendered
  // are laid out as one strip on disk and the planner is handed its absolute
  // path and asked to LOOK, the same way the style card reads a painting. It
  // answers good, or it answers revise and rewrites the renderer (or, for one
  // of the seven rules, hands back better numbers instead). Rendering is free
  // and instant, so this can run three times before a person is asked to judge
  // anything. Nothing on this route touches pixellab.
  if (p === '/api/fx-review' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const frames = (Array.isArray(b.frames) ? b.frames : []).slice(0, 24)
    if (!frames.length) return send(res, 400, { error: 'no frames' })
    const ask = String(b.ask || '').trim()
    if (!ask) return send(res, 400, { error: 'no ask' })
    let file
    try {
      file = writeSheet(id, 'fx', frames.map((f) => Buffer.from(stripDataURL(String(f)), 'base64')), false)
    } catch (e) {
      return send(res, 500, { error: 'the sheet did not write · ' + String(e.message || e).slice(0, 160) })
    }
    const custom = String(b.kind || '') === 'custom'
    const type = String(b.type || '')
    const job = String(b.job || '')
    const v = custom
      ? await reviewWritten(file, ask, frames.length, cleanCode(b.code), cleanControls(b.controls), b.params, job, !!b.sprite)
      : await reviewRule(file, ask, frames.length, type, b.params, job)
    if (!v) return send(res, 502, { error: 'the planner did not answer', strip: file })
    return send(res, 200, { strip: file, ...v })
  }

  /* THE SAME LOOK, over anything a generator just made: the candidates side by
   * side with an index number over each, an answer of which one, whether it is
   * good enough, and why.
   *
   * It is FREE. Nothing on this path touches pixellab; only regenerating
   * spends, and that stays behind the ui's own armed confirm.
   *
   * It CANNOT block a save. The item is already in the library before this is
   * called and stays there whatever comes back, so a planner that times out or
   * answers nonsense costs a spinner and nothing else. Do not move this in
   * front of the write.
   *
   * One route for every kind of thing. A prop, an animated prop, a character
   * sheet and a fill's candidates all land here, because what is being asked is
   * the same question in every case and a second route asking it again is the
   * segregation this tool keeps having to undo. `what` only changes one honest
   * sentence about what the strip shows. */
  if (p === '/api/obj-review' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const frames = (Array.isArray(b.frames) ? b.frames : []).slice(0, 6)
    if (!frames.length) return send(res, 400, { error: 'no images' })
    const ask = String(b.ask || '').trim()
    if (!ask) return send(res, 400, { error: 'no ask' })
    let file
    try {
      file = writeSheet(id, 'obj', frames.map((f) => Buffer.from(stripDataURL(String(f)), 'base64')), true)
    } catch (e) {
      return send(res, 500, { error: 'the sheet did not write · ' + String(e.message || e).slice(0, 160) })
    }
    /* THE PAINTING ITSELF, free and already on disk. asset-plan, scene-plan and
     * life-plan each rewrite work/<id>/.ask/map.png, and a generation always
     * follows a plan, so the copy sitting there is the map this thing was made
     * for. Not box.png: that one is only written when a box was drawn, so it
     * goes stale and would have the reviewer judging against another session's
     * crop. Missing is fine and the look falls back to the sprites alone. */
    const mapFile = path.join(WORK, id, '.ask', 'map.png')
    const v = await reviewObjects({
      file,
      map: fs.existsSync(mapFile) ? mapFile : '',
      ask,
      prompt: String(b.prompt || ''),
      // read off the prompt that drew it, the same way the generator read it, so
      // the reviewer is judging against the camera that was actually sent
      view: b.what === 'sprite' ? '' : viewFor(String(b.prompt || '')),
      n: frames.length,
      what: b.what === 'sprite' ? 'sprite' : 'object',
      size: Number(b.w) > 0 && Number(b.h) > 0 ? { w: Math.round(b.w), h: Math.round(b.h) } : null,
      job: String(b.job || ''),
    })
    if (!v) return send(res, 502, { error: 'the planner did not answer', strip: file })
    return send(res, 200, { strip: file, ...v })
  }

  // What he KEPT on this map, one line each. It is written only on a keep,
  // never on a discard, and the last five ride into the next ask so the tool's
  // rewrites drift toward this map's taste instead of starting cold every time.
  if (p === '/api/keep-note' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const ask = String(b.ask || '').trim()
    if (!ask) return send(res, 400, { error: 'no ask' })
    const n = addKeep(id, {
      ask: ask.slice(0, 200),
      prompt: String(b.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      name: cleanName(b.name || ''),
      kind: String(b.kind || '') === 'effect' ? 'effect' : 'asset',
      when: new Date().toISOString().slice(0, 10),
    })
    return send(res, 200, { n })
  }

  // A crop of a library item, written as a NEW item called <name>-crop: the
  // original is never touched, so a bad crop costs nothing. The client does the
  // pixel trim on canvas (it already holds every frame decoded) and posts the
  // trimmed pngs; rect rides along for the record. An animated item arrives
  // with every frame trimmed to the same rect, so the loop stays in register.
  // suffix names what the client did to those pixels and defaults to crop, so
  // the palette lock lands as <name>-matched down this same path. Nothing here
  // generates either way: it only writes bytes the client already holds.
  /* PUT THE OLD PIXELS BACK, from the copy every in-place edit already keeps.
   *
   * Crop, ctrl+P, trim and palette-match all rewrite the art under its own name
   * and copy the previous bytes to work/<id>/.prev first. Nothing could read
   * that folder, so the copies were a comfort and not a way back, and z only
   * ever undid the PLACEMENT half of a crop. That is worse than no undo:
   * placements moved back to where they belonged around art that was still
   * cropped, so nineteen trees looked like they had slid down the map.
   *
   * Newest first, because .prev numbers copies upward as they pile up and the
   * one worth wanting is the one written a moment ago. */
  if (p === '/api/asset-revert' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const name = cleanName(b.name || '')
    if (!name) return send(res, 400, { error: 'no name' })
    const prev = path.join(WORK, id, '.prev')
    // this machine may never have seen the edit. The store keeps the same eight
    // versions, so an undo is not something only one laptop can do.
    if (!fs.existsSync(prev) || !fs.readdirSync(prev).length) {
      const back = await restoreVersion(id, name).catch(() => null)
      if (!back) return send(res, 404, { error: 'nothing was kept for this one' })
      const restored = (await libraryOf(id)).find((x) => x.name === name)
      if (!restored) return send(res, 500, { error: 'it came back unreadable' })
      return send(res, 200, { item: restored, from: `version ${back.seq}` })
    }
    // <name>.png and <name> for the first copy, <name>-2.png upward after it
    const cands = fs
      .readdirSync(prev, { withFileTypes: true })
      .map((e) => e.name)
      .filter((n) => n === name || n === name + '.png' || new RegExp('^' + name + '-\d+(\.png)?$').test(n))
    if (!cands.length) return send(res, 404, { error: 'no earlier copy of that one' })
    const rank = (n) => {
      const m = n.match(/-(\d+)(\.png)?$/)
      return m ? Number(m[1]) : 1
    }
    cands.sort((a, c) => rank(c) - rank(a))
    const from = path.join(prev, cands[0])
    const dir = libDirOf(id)
    try {
      if (fs.statSync(from).isDirectory()) {
        const to = path.join(dir, name)
        // the current art goes to .prev too, so reverting is itself reversible
        keepPrevDir(id, to, name)
        fs.rmSync(to, { recursive: true, force: true })
        fs.mkdirSync(to, { recursive: true })
        for (const f of fs.readdirSync(from)) {
          const sp = path.join(from, f)
          if (fs.statSync(sp).isFile()) fs.copyFileSync(sp, path.join(to, f))
        }
        // a folder that came back is not a file: drop a stale flat png beside it
        const flat = path.join(dir, name + '.png')
        if (fs.existsSync(flat)) fs.rmSync(flat)
      } else {
        const to = path.join(dir, name + '.png')
        if (fs.existsSync(to)) keepPrevFile(id, to, name + '.png')
        const asDir = path.join(dir, name)
        if (fs.existsSync(asDir)) fs.rmSync(asDir, { recursive: true, force: true })
        fs.copyFileSync(from, to)
      }
      fs.rmSync(from, { recursive: true, force: true })
    } catch (e) {
      return send(res, 500, { error: String((e && e.message) || e).slice(0, 200) })
    }
    // reverting rewrites the art, so the store has to be told or the library
    // would keep serving the version that was just undone
    await pushLibrary(id, name)
    const item = platformOn()
      ? (await libraryOf(id)).find((x) => x.name === name)
      : libraryItems(id).find((x) => x.name === name)
    if (!item) return send(res, 500, { error: 'it came back unreadable' })
    return send(res, 200, { item })
  }

  if (p === '/api/asset-crop' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const frames = Array.isArray(b.frames) ? b.frames : []
    if (!frames.length) return send(res, 400, { error: 'no pixels' })
    // 8 headings of 8 frames is 64, exactly the old cap, so a walking sprite
    // sat on the edge of being refused outright
    if (frames.length > 256) return send(res, 400, { error: 'too many frames' })
    const src = String(b.name || '').trim()
    if (!src) return send(res, 400, { error: 'no name' })
    const dir = libDirOf(id)
    fs.mkdirSync(dir, { recursive: true })
    const taken = (n) => fs.existsSync(path.join(dir, n)) || fs.existsSync(path.join(dir, n + '.png'))
    /* IN PLACE is the default now. Every edit used to leave a second item
     * behind — palm, palm-trimmed, palm-trimmed-bit2 — and a library of
     * near-identical rows is worse than the problem each edit solved. The
     * pixels are simply replaced under the same name.
     *
     * The previous bytes are copied to work/<id>/.prev first, which is NOT the
     * library and is never listed. Nothing in the app reads it; it is there
     * because these files cost generations and an edit is not worth losing them
     * over. */
    const keep = !!b.keepCopy
    let name = cleanName(src)
    if (keep) {
      const base = cleanName(src + '-' + cleanName(b.suffix || 'crop'))
      name = base
      for (let i = 2; taken(name); i++) name = `${base}-${i}`
    } else {
      // the same two helpers the animate and swap paths use, so an in-place
      // edit cannot roll its own original away. See PREV_MAX.
      const png = path.join(dir, name + '.png')
      if (fs.existsSync(png)) keepPrevFile(id, png, name + '.png')
      else keepPrevDir(id, path.join(dir, name), name)
    }
    /* a set of VIEWS goes back under its own names, not as 0.png, 1.png.
     * Without this an edit on eight-sided art wrote frame files beside the
     * views it was supposed to replace and the item ended up as neither. */
    /* A SET OF VIEWS GOES BACK IN THE SHAPE IT ARRIVED IN, frame counts and all.
     *
     * dirKeys runs parallel to frames, one entry per picture, so a heading that
     * owns eight of them appears eight times. This used to assume one picture
     * per heading and wrote `<heading>.png`, which on a walking sprite replaced
     * a whole walk cycle with its first frame. Measured on the hub 2026-08-25:
     * dock-porter went from east-0..east-7 to a single east.png and stopped
     * walking, and fps and characterId went with it, because this rebuilt the
     * metadata from nothing instead of carrying it.
     *
     * Naming follows what the readers already expect: one frame keeps
     * `<heading>.png` and several become `<heading>-0.png` upward, which is what
     * writeRotations and saveFrames produce and what libraryItems reads.
     *
     * The old files are removed first. A set going from eight frames to one
     * would otherwise leave seven orphans behind that the next reader might
     * pick up. */
    const dirKeys = Array.isArray(b.dirKeys) ? b.dirKeys.map((k) => cleanName(String(k))) : null
    if (dirKeys && dirKeys.length === frames.length) {
      const fdir = path.join(dir, name)
      // what the set already knew about itself, kept rather than rebuilt: the
      // rate it plays at and the character it was drawn from, which is what a
      // second face is made from later
      let was = {}
      try {
        was = JSON.parse(fs.readFileSync(path.join(fdir, 'dirs.json'), 'utf8')) || {}
      } catch {
        /* a set with no metadata to carry, which is every imported one */
      }
      if (fs.existsSync(fdir)) for (const f of fs.readdirSync(fdir)) if (/\.png$/i.test(f)) fs.unlinkSync(path.join(fdir, f))
      fs.mkdirSync(fdir, { recursive: true })
      const byKey = new Map()
      for (let i = 0; i < frames.length; i++) {
        if (!byKey.has(dirKeys[i])) byKey.set(dirKeys[i], [])
        byKey.get(dirKeys[i]).push(frames[i])
      }
      const dirs = {}
      for (const [k, list] of byKey) {
        dirs[k] = list.map((f, i) => {
          const file = list.length > 1 ? `${k}-${i}.png` : `${k}.png`
          fs.writeFileSync(path.join(fdir, file), Buffer.from(stripDataURL(String(f)), 'base64'))
          return `/work/${id}/library/${name}/${file}`
        })
      }
      const meta = { dirs }
      if (Number(was.fps) > 0) meta.fps = Math.round(Number(was.fps))
      if (was.characterId) meta.characterId = was.characterId
      fs.writeFileSync(path.join(fdir, 'dirs.json'), JSON.stringify(meta, null, 2))
      const first = dirs[dirKeys[0]][0]
      const size = pngSize(path.join(fdir, String(first).split('/').pop()))
      /* AN EDIT IS A LIBRARY WRITE, so it goes to the store like every other one.
       *
       * All three returns in this route used to end at disk. On a host the disk
       * is a tmp dir that dies with the request, so a crop, a base-trim, a
       * pixelate or a palette-match was lost the moment the response was sent
       * and the library carried on serving the art from before the edit.
       * Awaited, so the response never says the edit landed before the bytes are
       * durable, which is the same rule saveStatic and /api/asset-revert keep. */
      await pushLibrary(id, name)
      return send(res, 200, {
        item: {
          name,
          kind: 'static',
          dirs,
          ...(meta.fps ? { fps: meta.fps } : {}),
          src: dirs.south ? dirs.south[0] : first,
          w: size.w,
          h: size.h,
        },
      })
    }
    if (b.kind === 'animated') {
      const fdir = path.join(dir, name)
      fs.mkdirSync(fdir, { recursive: true })
      const rel = []
      for (let i = 0; i < frames.length; i++) {
        fs.writeFileSync(path.join(fdir, i + '.png'), Buffer.from(stripDataURL(String(frames[i])), 'base64'))
        rel.push(`/work/${id}/library/${name}/${i}.png`)
      }
      // a shorter take must not leave the tail of a longer one behind, or the
      // folder plays a mix of two renders
      for (let i = frames.length; fs.existsSync(path.join(fdir, i + '.png')); i++)
        fs.unlinkSync(path.join(fdir, i + '.png'))
      const fps = Number(b.fps) > 0 ? Math.round(Number(b.fps)) : 6
      const size = pngSize(path.join(fdir, '0.png'))
      // see the push in the views branch above: same reason, same rule
      await pushLibrary(id, name)
      return send(res, 200, { item: { name, kind: 'animated', frames: rel, fps, w: size.w, h: size.h } })
    }
    const file = name + '.png'
    fs.writeFileSync(path.join(dir, file), Buffer.from(stripDataURL(String(frames[0])), 'base64'))
    const size = pngSize(path.join(dir, file))
    // see the push in the views branch above: same reason, same rule
    await pushLibrary(id, name)
    return send(res, 200, {
      item: { name, kind: 'static', src: `/work/${id}/library/${file}`, w: size.w, h: size.h },
    })
  }

  // takes one item out of this map's library: the png for a static item, the
  // whole frame folder for an animated one. The name is sanitized exactly the
  // way it was written, and the target must stay inside work/<id>/library.
  // Deleting the file is final; the ui clears its placements separately.
  if (p === '/api/library-remove' && req.method === 'POST') {
    const b = await body(req)
    if (!String(b.name || '').trim()) return send(res, 400, { error: 'no name' })
    const id = safeId(b.id)
    const name = cleanName(b.name)
    const dir = path.resolve(libDirOf(id))
    const inside = (f) => f.startsWith(dir + path.sep)
    const png = path.resolve(dir, name + '.png')
    const fdir = path.resolve(dir, name)
    // a delete has to land in both places or the item reappears on the next
    // listing, which now comes from the database rather than the folder
    if (inside(png) && fs.existsSync(png) && fs.statSync(png).isFile()) {
      fs.unlinkSync(png)
      await dropItem(id, name)
      return send(res, 200, { removed: 'static' })
    }
    if (inside(fdir) && fs.existsSync(fdir) && fs.statSync(fdir).isDirectory()) {
      fs.rmSync(fdir, { recursive: true, force: true })
      await dropItem(id, name)
      return send(res, 200, { removed: 'animated' })
    }
    // it may be gone from disk but still known to the platform
    await dropItem(id, name)
    return send(res, 404, { error: 'not in the library' })
  }

  // reopening a map: whatever was exported under this id, as data urls. Always
  // 200, so a map that was never exported does not put a 404 in the console.
  if (p.startsWith('/api/scene/')) {
    const dir = path.join(WORK, safeId(decodeURIComponent(p.slice('/api/scene/'.length))))
    const out = {}
    const png = (n) => {
      const f = path.join(dir, n)
      return fs.existsSync(f) ? 'data:image/png;base64,' + fs.readFileSync(f).toString('base64') : null
    }
    // the cut can exist before any mechanics do: a painting is cut and staged,
    // then the levels are drawn later
    out.cut = png('cut.png')
    const mapFile = path.join(dir, 'map.json')
    if (fs.existsSync(mapFile)) {
      try {
        out.map = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
      } catch {
        out.map = null
      }
      out.levels = png('levels.png')
      out.occluders = png('occluders.png')
    }
    const af = path.join(dir, 'assets.json')
    if (fs.existsSync(af)) {
      try {
        out.assets = JSON.parse(fs.readFileSync(af, 'utf8'))
      } catch {
        out.assets = null
      }
    }
    return send(res, 200, out)
  }

  /* THE COMPOSITION: where every map sits on this account's ocean.
   *
   * Both halves are the AUTHORING view and both used to be refused to anybody
   * but one account, because there was one world row for the whole platform.
   * That made the tool's own sign-up an invitation to a page that opens and
   * then apologises. 022 gave every account a world, so these two now resolve
   * whose row it is instead of deciding whether to let you in.
   *
   * `mine` KEPT ITS NAME AND CHANGED ITS QUESTION, from "are you the one account
   * that may compose" to "is this ocean yours to edit", which is true for anyone
   * signed in. `game` is the fact it used to be carrying, and the two are not
   * the same fact: a member's ocean is theirs and is not the one the ship in the
   * game sails. `readUrl` is where their own engine fetches it, because an ocean
   * nothing can read is a drawing.
   *
   * The published read at /api/v1/world stays open to everybody, pinned to row
   * 1, and is not touched by any of this. That is what the game fetches with no
   * account at all. */
  if (p === '/api/world' && req.method === 'GET') {
    const me = await currentUser(req)
    if (platformOn() && !me) return send(res, 401, { error: 'sign in to open an ocean' })
    const game = ownedBy(me)
    const w = await getWorld(undefined, await worldOf(me))
    return send(res, 200, {
      ...w,
      states: ISLAND_STATES,
      seaKinds: SEA_KINDS,
      markKinds: MARK_KINDS,
      mine: true,
      game,
      readUrl: game || !w.pubId ? '/api/v1/world' : `/api/v1/worlds/${w.pubId}`,
    })
  }
  /* One boolean, so the home page can decide whether to offer the ocean at all.
   * It was the answer to "are you us"; it is the answer to "have you got one",
   * and everybody signed in has. Kept rather than removed because the page asks
   * this before it asks anything else and a 404 there is a blank card. */
  if (p === '/api/world/mine' && req.method === 'GET') {
    const me = await currentUser(req)
    return send(res, 200, { mine: !platformOn() || !!me, game: ownedBy(me) })
  }
  if (p === '/api/world' && req.method === 'POST') {
    const me = await currentUser(req)
    if (platformOn() && !me) return send(res, 401, { error: 'sign in to place a map on the ocean' })
    const b = await body(req)
    try {
      return send(res, 200, await saveWorld(b, null, await worldOf(me)))
    } catch (e) {
      /* a composition that cannot work is refused where it is written, naming
       * what is wrong, rather than found by a student sailing into nothing.
       *
       * ONLY WHEN IT REALLY IS A REFUSAL. This caught everything, so a pool
       * timeout, a dropped Neon connection or a failed maps query came back as
       * 400 with an empty problems list and the page printed it into the refusal
       * panel. The author was told their composition was rejected when the
       * database was unreachable, which is the one case where retrying is the
       * right move and 400 is the status that says do not. Anything carrying no
       * `problems` is a server fault and goes up to the handler as a 500. */
      if (!e.problems) throw e
      return send(res, 400, { error: String(e.message || e), problems: e.problems })
    }
  }

  /* THE UI LIBRARY: the shelf of drawn pieces the game's interface is made of.
   *
   * A picture of a page is not a page. Without the marks saying where the text
   * goes, where the bar fills, where the button is and how deep the frame edge
   * runs, every drawn surface arrives with a second half typed by hand into
   * game source, which is the same defect as a hand-typed camera number: a fact
   * about a picture kept somewhere the picture cannot correct it.
   *
   * docs/UI-KIT.md is the authority and server/store/ui.mjs holds the rules.
   * These routes are the only way in, and all of them want an ACCOUNT rather
   * than a map, because a dialogue box belongs to the game and not to the hub.
   *
   * The word on the wire is `region` and never `slot`. A WorldSlot is an
   * island's berth on the sea and PmapScene reads it about thirty times, so a
   * UI rectangle called a slot costs a session the first time somebody greps.
   */
  if (p === '/api/ui' && req.method === 'GET') {
    const me = await currentUser(req)
    /* THE TYPE LIST GOES OUT WITH THE SHELF, because a library that opens with
     * a text box assumes the author already knows what a dialogue box is made
     * of, and the game's own record has that written down in twenty-one places.
     * A type carries its preset and its region vocabulary, so the page fills
     * the marks in rather than making somebody rediscover them by dragging six
     * unlabelled rectangles. */
    return send(res, 200, {
      ui: me ? await listUi(me.id) : [],
      types: PIECE_TYPES,
      core: CORE_NAMES,
      pending: me ? await pendingUi(me.id) : null,
      kinds: REGION_KINDS,
      aligns: REGION_ALIGNS,
      valigns: REGION_VALIGNS,
      fits: PICTURE_FITS,
      fillAxes: FILL_AXES,
      fillModes: FILL_MODES,
      repeats: REPEAT_MODES,
      wraps: TEXT_WRAPS,
      overflows: TEXT_OVERFLOWS,
      gates: legalCanvas(512, 512).gates,
      floor: 192,
    })
  }

  if (p === '/api/ui/generate' && req.method === 'POST') {
    const me = await currentUser(req)
    if (!me) return send(res, 401, { error: 'sign in to draw a piece' })
    const b = await body(req)
    const name = String(b.name || '').trim()
    const description = String(b.description || '').trim()
    if (!description) return send(res, 400, { error: 'say what the piece is before drawing it' })

    /* A DRY RUN COSTS NOTHING AND ANSWERS THE ONLY QUESTION WORTH ASKING FIRST.
     *
     * About 280 generations went on 2026-08-30 rediscovering one recipe, and the
     * instrument the whole time was the returned picture. work/.kit/panel.png is
     * a paid roll whose single defect is that the call dropped `elements`, which
     * is a fact visible in the request body a second before the money leaves.
     *
     * So this runs the router and hands back the EXACT body uiAsset would post,
     * built by the same function that builds the real one, and posts nothing. It
     * takes no pending lock and writes no row, because a dry run that made the
     * account busy would be a spend in every way except the picture. */
    const dry = b.dry === true || b.dry === 'true'

    /* ONE PRESS DRAWS ONE PIECE (Ash, 2026-08-30). He judges each one before
     * the next is asked for, so a batch is not a convenience here, it is the
     * shape that turns one bad prompt into five bad pictures with nobody having
     * looked at the first. Two ways to ask for more than one and both refused:
     * a list in the body, and a second press while one is still drawing. */
    const asked = [b.pieces, b.names, b.batch].find(Array.isArray)
    if (asked && asked.length > 1)
      return send(res, 400, {
        error: `one press draws one piece, and this asked for ${asked.length} · they get judged one at a time, so the next one starts after this one is looked at`,
      })
    /* ANY PENDING ROW REFUSES, and the exemption for the same name was a hole
     * with a real path through it. `Drawing` is keyed by `armed`, so pressing
     * "pick another" and re-arming the same type remounts it with a fresh local
     * busy flag and the name field defaulting to the type name both times, while
     * the page's own `v.pending` is still null because load() has not run. Two
     * concurrent pixellab spends on one row, and whichever answered last won.
     * The stuck-process case the exemption was reaching for is already covered:
     * pendingUi only sees a row younger than ten minutes. */
    const busy = dry ? null : await pendingUi(me.id)
    if (busy)
      return send(res, 409, { error: `"${busy.name}" is still drawing · one at a time, so wait for it and then look at it`, pending: busy })

    /* THE TYPE SUPPLIES THE PLUMBING. An author picks one of the twenty-one and
     * describes the piece; the canvas, the generator's element list and the
     * region vocabulary come from the preset rather than from a form somebody
     * fills in twice. An unknown type, and the two named so nobody generates
     * them, are refused inside createUi before anything is spent. */
    const t = pieceType(b.type)
    if (b.type && !t) return send(res, 400, { error: `there is no piece type called "${b.type}"` })
    const width = Number(b.width) || t?.w || 0
    const height = Number(b.height) || t?.h || 0

    /* THE GATE IS CHECKED BEFORE THE PRESS AND NOT AFTER IT. The maxima do not
     * combine, so 688x512 reads as 4:3 and comes back refused with the money
     * already committed.
     *
     * WHICH GATE depends on which generator, because the two have different
     * limits and the difference is not cosmetic. The panel route starts at 192
     * on both sides. The image route starts at 16, and running a sheet through
     * the panel route's floor would refuse a 384x160 chip strip and push it onto
     * a canvas taller than its family needs, which is measured to make the
     * generator repeat a row to fill the space. */
    const gate = canvasFor(t, width, height)
    if (!gate.ok)
      return send(res, 400, {
        error: `${width}x${height} is not a size this can be drawn at · the nearest legal canvas is ${gate.width}x${gate.height}`,
        canvas: gate,
      })

    /* WHO MAY MINT CORE CHROME. The kit is one set for the whole game and a
     * member piece may only add, so `core` is not a flag anybody can set on
     * their own shelf: it belongs to the one account the game reads chrome
     * from, which is the same account the ocean belongs to and is configured in
     * the same place. Everyone else gets an additive piece, which is the whole
     * of what they are meant to be making. */
    const core = !!b.core && (await ownsOcean(req))

    /* THE STYLE REFERENCE IS CHOSEN BY THE SERVER, FROM THE TYPE.
     *
     * It used to be a map slug an author typed, which is the strongest lever
     * this endpoint has and was reachable by exactly nobody: the page has no
     * field for it, so every piece ever drawn here went out with no reference
     * at all. A map's painting is also the wrong picture for chrome anyway. The
     * right one is the chrome the game ALREADY SHIPS and Ash already accepted,
     * and public/chrome holds it, picked by piece type in ui.mjs.
     *
     * A named map still wins if one is passed, because that is a deliberate
     * answer from somebody who had a reason, and the page has a select for it
     * with a tooltip saying what a painting can and cannot hand over. It is the
     * ONE way this call can end up carrying material that is not the type's, so
     * whichever file went out is named in the answer either way.
     *
     * Resolved before the row exists, so the dry run reaches it without writing
     * anything and a bad slug is a 400 rather than a failed row. */
    let style = chromeStyle(t ? t.name : '')
    if (b.style) {
      try {
        const m = await styleRef(String(b.style))
        style = { file: String(b.style), path: '', base64: m.base64, w: m.w, h: m.h }
      } catch (e) {
        return send(res, 400, { error: `style "${b.style}": ${String(e.message || e).slice(0, 160)}` })
      }
    }

    /* THE TWO LEVERS COME OFF THE TYPE AND A CALLER CANNOT DROP EITHER.
     *
     * `elements` used to read `Array.isArray(b.elements) ? b.elements : t?.elements`
     * and the style used to be omittable the same way, which is exactly how
     * work/.kit/panel.png was paid for: a call with no element list and the
     * wrong reference art, from a prompt that was otherwise good. Measured over
     * five rolls, `elements` is the lever that decides SHAPE and `style_image`
     * is the lever that decides MATERIAL, and words decide neither, so neither
     * is a thing a body may turn off.
     *
     * A type that deliberately sends no list, which is every sheet, is reported
     * rather than left to look like a dropped field. Same for a missing
     * reference: said out loud, because "no reference" is why the colours
     * drifted and an author who is not told reads it as a bad prompt. */
    const elements = t?.elements || null
    /* AND WHICH GENERATOR IS ABOUT TO BE PAID, because it is no longer one.
     *
     * /v2/create-ui-asset is a panel kit generator and nothing else: measured
     * 2026-08-31, an icon set came back as panels and round chip tokens came
     * back as panels, and the six sheet types could not be made on it at all.
     * They go to /v2/generate-image-v2, which paints an arbitrary subject with
     * transparency and has no element list, no shape template and no camera.
     * `elements` on a sheet is therefore not a dropped lever, it is a field that
     * route does not have, and the answer says which of the two it is. */
    const viaImage = usesImageEndpoint(t)
    const levers = {
      route: viaImage ? '/v2/generate-image-v2' : '/v2/create-ui-asset',
      elements,
      elementsWhy: t?.elementsWhy || '',
      styleRef: style ? style.file : '',
      ...(elements ? {} : { noElements: t ? t.elementsWhy || 'this type sends no element list' : 'no type, so no element list' }),
      ...(style ? {} : { noStyleRef: 'no reference art for this type, so nothing carries the material and only the words do' }),
    }

    /* CLAUDE WRITES THE PROMPT, WITH EVERYTHING THIS PROCESS KNOWS IN FRONT OF
     * IT, and this line is the whole point of the route. What goes over is the
     * author's sentence, the type's tier and stretch and canvas and region
     * vocabulary and caution, the nine-slice law, this account's existing shelf
     * so a second piece matches the first, and the picture of the chrome the
     * game already ships. All of it already existed here and none of it left
     * the process.
     *
     * It is not a gate. With no claude the author's own words still go to
     * pixellab, and the answer says out loud that nobody wrote the prompt. */
    const shelf = await listUi(me.id)

    /* THE ONE PLACE THE ASK IS ASSEMBLED, so a dry run and a real one cannot
     * disagree about what would have been sent. A dry run built from a second
     * copy of these fields proves nothing about the copy that spends. */
    const askFor = (plan, pieceName) => ({
      description: plan.description,
      width,
      height,
      // the router's palette, unless an author named one by hand. It is a
      // separate field on the endpoint rather than words in the description,
      // so it is answered separately.
      palette: b.palette || plan.palette || null,
      // the type's own list and nothing else. An author override lived here and
      // is gone: it is one of the two levers that decide whether a picture is
      // usable, and work/.kit/panel.png is what a dropped one costs.
      elements,
      /* ONLY `pieces` IS A SHAPE TEMPLATE, and this took whichever of the
       * three arrays happened to be present. `names` and `batch` are lists of
       * NAMES, so a caller sending one had its strings forwarded as the
       * generator's shape list, where every entry is refused three times over
       * as "not a valid dictionary" and the author is told nothing they can
       * act on. Those two are counted for the one-press refusal above and are
       * not content. */
      pieces: Array.isArray(b.pieces) && b.pieces.length === 1 ? b.pieces : null,
      // the same picture the router looked at. Two levers and they do
      // different jobs: this one carries material and no layout, the words
      // carry layout and cannot carry a palette.
      styleImageBase64: style ? style.base64 : undefined,
      name: pieceName,
    })

    /* THE SHEET'S OWN ASK, and it is a different set of fields rather than the
     * same one with two dropped. The image route takes no element list, no
     * shape template and no name, and its style reference is a ReferenceImage
     * carrying the picture's size rather than the bare Base64Image the panel
     * route takes, so sending one route's body to the other is a 422 either
     * way. Both are assembled here, once, for the reason askFor is: a dry run
     * built from a second copy of the fields proves nothing about the copy that
     * spends. */
    const sheetAsk = (plan) => ({
      description: plan.description,
      width,
      height,
      styleImage: style ? { base64: style.base64, w: style.w, h: style.h } : null,
    })

    if (dry) {
      const plan = await chromePlan({ ask: description, t, width, height, shelf, style, job: `ui:dry:${name || t?.name || 'piece'}` })
      const wire = viaImage ? pixellab.sheetBody(sheetAsk(plan)) : pixellab.uiAssetBody(askFor(plan, name || t?.name || 'piece'))
      /* THE PICTURE IS REPLACED BY ITS LENGTH. A base64 png is 60 to 200 KB of
       * one unreadable line, and printing it buries the six fields somebody is
       * dry-running to check. What matters about style_image is that it is
       * there, that it is the shape ITS OWN route takes, and which file it came
       * off, and all three survive this.
       *
       * The two routes wrap it differently and that is the point of showing it:
       * the panel route takes a bare Base64Image and the image route takes a
       * ReferenceImage with the picture's own size beside it, so a body built
       * for one and posted to the other is a 422 with the money uncommitted but
       * the author none the wiser. */
      const shown = (b64) => `<${b64.length} chars of ${style.file}>`
      const body = !wire.style_image
        ? wire
        : wire.style_image.image
          ? { ...wire, style_image: { ...wire.style_image, image: { ...wire.style_image.image, base64: shown(wire.style_image.image.base64) } } }
          : { ...wire, style_image: { ...wire.style_image, base64: shown(wire.style_image.base64) } }
      return send(res, 200, {
        dry: true,
        piece: { name: name || '', type: t ? t.name : '', tier: t ? t.tier : '', w: width, h: height },
        ...levers,
        routed: plan.routed,
        note: plan.note,
        ...(plan.routed ? {} : { degraded: plan.degraded, why: plan.why }),
        body,
      })
    }

    /* THE ROW EXISTS BEFORE THE PICTURE DOES, because this call takes a minute
     * and a half and something has to be poll-able for that minute and a half.
     * It is also what makes a spend that produced nothing visible afterwards
     * rather than silently absent. */
    let row
    try {
      // title guarded at the route the way description already is: createUi's
      // default parameter only fires on undefined, so a body carrying
      // {"title": null} stored the literal four-character string "null"
      row = await createUi({
        ownerId: me.id,
        name,
        type: t ? t.name : '',
        title: String(b.title || ''),
        description,
        w: width,
        h: height,
        core,
      })
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) })
    }

    const plan = await chromePlan({ ask: description, t, width, height, shelf, style, job: `ui:${row.name}` })
    try {
      const out = viaImage ? await pixellab.sheetImage(sheetAsk(plan)) : await pixellab.uiAsset(askFor(plan, row.name))
      const buf = Buffer.from(out.b64, 'base64')
      const size = pngSizeBuf(buf.subarray(0, 24))
      /* THE PIXELLAB ID IS KEPT, and it never was. The column exists, createUi
       * accepts it and has an on-conflict rule written to preserve it, and the
       * generator returns it, and this route used only b64, width and height, so
       * `pixellab_id` was the empty string on every row ever produced and
       * `pixellabId` never appeared on the wire. Every other generated thing in
       * this repo can be traced back to the spend it was paid for; chrome
       * silently could not. */
      /* THE ID IS WHICHEVER ONE THE ROUTE THAT DREW IT HANDS BACK. The panel
       * route answers a ui_asset_id and the image route answers a background job
       * id, and a row that cannot be traced to the spend it was paid for is the
       * defect this line already exists to fix. */
      const saved = await setUiImage(me.id, row.name, buf, size.w || out.width, size.h || out.height, out.uiAssetId || out.jobId || '')
      /* WHAT COMES BACK, AND NOT WHAT IT COST. The old page put the price under
       * the button as the last thing an author read, which is why it read as a
       * bill. What belongs there is this many faces, at this size, ready to be
       * cut. */
      const cutFaces = (saved.regions || []).filter((r) => r && r.kind === 'face')
      return send(res, 200, {
        ui: { name: saved.name, type: saved.type, w: saved.w, h: saved.h, status: saved.status },
        cut: t ? { tier: t.tier, faces: t.faces, regions: t.regions } : null,
        /* AND WHAT THE SCAN ACTUALLY FOUND ON A SHEET, which is the half an
         * author cannot see in the picture. The rectangles are already stored,
         * so this is a report and not an offer: either the marks were counted
         * and named, or the cut refused and `cutNote` says which check failed
         * and the piece is owed a hand cut. */
        ...(viaImage
          ? { faces: cutFaces.map((r) => ({ name: r.name, x: r.x, y: r.y, w: r.w, h: r.h })), cutNote: saved.crop_note || '' }
          : {}),
        /* WHO WROTE THE PROMPT, said out loud on every answer.
         *
         * An author whose piece came back wrong needs to know which of the two
         * things happened: the router wrote a prompt and it was a bad one, or
         * there was no router and their four words went to the generator bare.
         * Those want opposite next moves, and a silent degrade looks exactly
         * like the first one. */
        routed: plan.routed,
        prompt: plan.description,
        note: plan.note,
        // which levers actually went out, on every answer. A dropped element
        // list is invisible in a returned picture until somebody has spent
        // enough of them to see the pattern, which is what 2026-08-30 was.
        ...levers,
        ...(plan.routed ? {} : { degraded: plan.degraded, why: plan.why }),
      })
    } catch (e) {
      await failUi(me.id, row.name)
      return send(res, 502, {
        error: String(e.message || e).slice(0, 300),
        // the same honesty on the failure path: a piece that never drew after
        // a degraded prompt is a different problem from one that never drew
        // after a written one
        routed: plan.routed,
        ...(plan.routed ? {} : { degraded: plan.degraded, why: plan.why }),
      })
    }
  }

  /* THE MARKS AND THE MEASUREMENT, SAVED TOGETHER.
   *
   * One call because they are checked against each other: an edge number is
   * only legal against the picture the regions sit on, and two requests would
   * let the pair go inconsistent between them.
   *
   * There was a `/api/ui/slots` alias here holding the door open for the page
   * that spoke that word. That page is gone, and so is the alias: `region` is
   * the word on the wire, because a WorldSlot is an island's berth on the sea
   * and PmapScene reads it about thirty times. */
  if (p === '/api/ui/regions' && req.method === 'POST') {
    const me = await currentUser(req)
    if (!me) return send(res, 401, { error: 'sign in to mark a piece' })
    const b = await body(req)
    try {
      return send(res, 200, await setUiRegions(me.id, String(b.name || ''), b.regions, b.slices))
    } catch (e) {
      // refused where it is written, naming what is wrong, rather than found by
      // a member whose number prints half off the panel
      return send(res, 400, { error: String(e.message || e), problems: e.problems || [] })
    }
  }

  /* SAYING A PIECE IS FINISHED, which is a different fact from its picture
   * having arrived. A ground piece with no edge numbers is refused here,
   * because those four numbers are the entire thing the game can consume:
   * without them the consumer falls back to squashing the whole painting into
   * whatever box the element happens to be. */
  if (p === '/api/ui/publish' && req.method === 'POST') {
    const me = await currentUser(req)
    if (!me) return send(res, 401, { error: 'sign in to publish a piece' })
    const b = await body(req)
    try {
      return send(res, 200, await publishUi(me.id, String(b.name || '')))
    } catch (e) {
      return send(res, 400, { error: String(e.message || e), problems: e.problems || [] })
    }
  }

  /* PUTTING A BAD CROP BACK.
   *
   * The generator answers a ground piece with a family: the hero at the top and
   * a tray of matching buttons under it. The four edge numbers are insets from
   * the edge of the WHOLE image with no source rect anywhere in the shape, so a
   * family cannot be sliced at all, and the hero is cut out at import by an
   * alpha scan that refuses rather than guesses.
   *
   * This is the other half of that promise. Ash's concern about a crop was that
   * something guessing will sometimes be wrong, and the scan answers half of it
   * by refusing when it cannot prove which shape is the piece. The rest is that
   * a crop which passed all three checks and is still wrong must be one press
   * to undo, rather than a spend to draw again. */
  if (p === '/api/ui/uncrop' && req.method === 'POST') {
    const me = await currentUser(req)
    if (!me) return send(res, 401, { error: 'sign in to put a piece back' })
    const b = await body(req)
    try {
      return send(res, 200, await uncropUi(me.id, String(b.name || '')))
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) })
    }
  }

  if (p === '/api/ui/remove' && req.method === 'POST') {
    const me = await currentUser(req)
    if (!me) return send(res, 401, { error: 'sign in to remove a piece' })
    const b = await body(req)
    const name = String(b.name || '')
    try {
      // core chrome may only be removed by the account it belongs to, because
      // deleting the dialogue box is the loudest way to override it
      return send(res, (await removeUi(me.id, name, { core: await ownsOcean(req) })) ? 200 : 404, { removed: name })
    } catch (e) {
      return send(res, 403, { error: String(e.message || e) })
    }
  }

  /* THE AUTHOR'S OWN PICTURE, SCOPED TO THE ACCOUNT THAT DREW IT.
   *
   * The page fetched every piece through /api/v1/ui/<name>/image, which has no
   * account in its path and resolves core-then-oldest across the whole platform.
   * Names are unique per account only, so two people with a piece called
   * `binder` were both shown one picture, stretched to the other row's size, and
   * every rectangle they dragged was measured against art they never saw. This
   * is the same route for the row this account actually owns. */
  if (p.startsWith('/api/ui/') && p.endsWith('/image') && req.method === 'GET') {
    const me = await currentUser(req)
    if (!me) return send(res, 401, { error: 'sign in to see a piece' })
    const buf = await ownedUiImage(me.id, p.slice('/api/ui/'.length, -'/image'.length))
    if (!buf) return notFound(res)
    res.setHeader('Content-Type', 'image/png')
    // never cached, unlike the published route: this is the picture being marked
    // up, and a redraw under the same name has to show through immediately
    res.setHeader('Cache-Control', 'no-store')
    return res.end(buf)
  }

  /* THE FAMILY THE HERO WAS CUT OUT OF.
   *
   * Kept rather than thrown away for two reasons and only one of them is the
   * undo. The other is that the tray under the hero is the rest of the kit,
   * drawn in the same job and paid for in the same spend: the buttons, the
   * chips and the rules that match this frame. Discarding it to keep a tidy
   * blob store would mean paying for them again.
   *
   * Owner-scoped and offered nowhere else. The game consumes the piece, not the
   * sheet it arrived on. */
  if (p.startsWith('/api/ui/') && p.endsWith('/full') && req.method === 'GET') {
    const me = await currentUser(req)
    if (!me) return send(res, 401, { error: 'sign in to see a piece' })
    const buf = await ownedUiFull(me.id, p.slice('/api/ui/'.length, -'/full'.length))
    if (!buf) return notFound(res)
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'no-store')
    return res.end(buf)
  }

  /* ---- the shared library, which is a COPY and says so --------------------
   *
   * One dock kit usable by twenty maps instead of twenty spends. The bytes are
   * duplicated: that costs object storage and costs no pixellab generation at
   * all, and 013_library_kit.sql has the whole of why a genuinely shared row
   * was not worth its blast radius.
   *
   * library-share and library-copy both carry the map in `id`, so the POST
   * ownership gate at the door already covers the map being written to. The
   * SOURCE map is checked here, because the gate only ever looks at one. */
  if (p === '/api/library-share' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const name = cleanName(b.name)
    const r = await one(
      `update library_items set shared = $3
       where map_id = (select id from maps where slug = $1) and name = $2 returning name, shared`,
      [id, name, !!b.shared],
    )
    if (!r) return send(res, 404, { error: 'not in the library' })
    return send(res, 200, { name: r.name, shared: r.shared })
  }

  if (p === '/api/library-kit' && req.method === 'GET') {
    const me = await currentUser(req)
    if (!me) return send(res, 200, { kit: [] })
    // the source slug travels with every row, because a picker showing eight
    // barrels has to be able to say which map each one came off
    const rows = await many(
      `select m.slug, l.name, l.kind, l.w, l.h, l.fps, l.frame_count, l.is_effect
       from library_items l join maps m on m.id = l.map_id
       where l.shared and m.owner_id = $1 order by m.slug, l.name`,
      [me.id],
    )
    return send(res, 200, {
      kit: rows.map((r) => ({
        from: r.slug,
        name: r.name,
        kind: r.kind,
        w: r.w,
        h: r.h,
        ...(r.fps ? { fps: r.fps } : {}),
        frames: r.frame_count,
        ...(r.is_effect ? { effect: true } : {}),
        src: r.frame_count > 0 ? `/work/${r.slug}/library/${r.name}/0.png` : `/work/${r.slug}/library/${r.name}.png`,
      })),
    })
  }

  if (p === '/api/library-copy' && req.method === 'POST') {
    const b = await body(req)
    const to = safeId(b.id)
    const from = safeId(b.fromSlug)
    const name = cleanName(b.name)
    if (!name) return send(res, 400, { error: 'no name' })
    if (from === to) return send(res, 400, { error: 'that item is already in this map' })
    /* THE GATE ONLY EVER LOOKS AT ONE MAP, so the other one is checked here.
     * Without this an account could name somebody else's map as the source and
     * pull their whole library into a map they do own, which is the same hole
     * the import routes had when their target lived in sceneId. */
    if (platformOn()) {
      const me = await currentUser(req)
      const owners = await many('select slug, owner_id from maps where slug = any($1)', [[from, to]])
      for (const o of owners) if (!me || me.id !== o.owner_id) return send(res, 403, { error: `${o.slug} belongs to another account` })
      if (owners.length < 2) return send(res, 404, { error: 'one of those maps does not exist' })
    }
    try {
      return send(res, 200, { copied: await copyLibraryItem(from, name, to, cleanName(b.as || name)) })
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) })
    }
  }

  if (p === '/api/export' && req.method === 'POST') {
    /* AN EXPORT THAT TAKES MINUTES HAS TO SAY WHERE IT IS.
     *
     * This route reads a body, pulls missing art out of object storage, copies
     * eight hundred pngs and publishes a version, and until these lines existed
     * it said nothing at all until the whole thing finished. When it stopped
     * finishing there was no way to tell which of the four it was stuck in, and
     * three hours went into narrowing it down by hand. */
    const t0 = Date.now()
    const step = (what) => console.log(`[export] ${what} · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    const b = await body(req)
    const id = safeId(b.id)
    step(`${id}: body read, ${(JSON.stringify(b).length / 1024).toFixed(0)}kb`)
    const dir = path.join(WORK, id)
    // this route rebuilds dir/assets with fs.rmSync, so the fence goes in front
    // of the mkdir rather than anywhere later. See insideWork.
    if (!insideWork(dir)) return send(res, 400, { error: 'bad id' })
    fs.mkdirSync(dir, { recursive: true })
    /* Every source byte within reach of resolveAssetFile before anything tries
     * to resolve one. On this machine that is a no-op; on a host it is what
     * stops the export publishing an empty island. */
    try {
      const h = await hydrateMap(id, dir)
      if (h.pulled) console.log(`[export] ${id}: pulled ${h.pulled} file(s), ${(h.bytes / 1024).toFixed(0)}kb, from object storage`)
      /* A FILE THAT DID NOT ARRIVE STOPS THE EXPORT, before a single byte is
       * written.
       *
       * hydrateMap already counts these and already logs them, and the count was
       * then dropped on the floor: only h.pulled was read. What follows a missing
       * file is quiet, every step of the way. resolveAssetFile returns null,
       * packLook returns null, `if (!look0) continue` drops the placement, and
       * the short bundle publishes as a new immutable version reporting success.
       * Nobody finds out until a class walks an island with holes in it.
       *
       * A version is immutable, so there is no repairing it afterwards. Refusing
       * costs a retry; publishing costs a version number that can never be
       * corrected. */
      if (h.failed > 0)
        return send(res, 502, {
          error: `${h.failed} file(s) could not be read from object storage, so nothing was written. Try the export again.`,
        })
    } catch (e) {
      console.error('[export] could not hydrate from object storage:', e.message)
    }
    step('hydrated')
    const files = []
    for (const [name, data] of [
      ['scene.png', b.scene],
      ['levels.png', b.levels],
      ['occluders.png', b.occluders],
      ['cut.png', b.cut],
    ]) {
      if (!data) continue
      fs.writeFileSync(path.join(dir, name), Buffer.from(stripDataURL(data), 'base64'))
      files.push(name)
    }
    // a cut that was erased back to nothing should not survive on disk
    if (!b.cut && fs.existsSync(path.join(dir, 'cut.png'))) fs.unlinkSync(path.join(dir, 'cut.png'))
    fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify(b.map, null, 2))
    files.push('map.json')
    step('planes and map.json written')
    // the placed assets: assets.json per the loader contract, and every used
    // png copied into assets/ so the bundle stands on its own. Sources can be
    // the per-map library, the old shared library, or a reopened bundle's own
    // assets/ folder, so every source byte is read into memory BEFORE the
    // folder is rebuilt; otherwise a re-export would delete its own sources.
    const assetsDir = path.join(dir, 'assets')
    const outAssets = []
    const writes = new Map() // rel path inside assets/ -> png buffer
    /* ONE NAME PER DISTINCT SOURCE, because assets/ is one flat folder and two
     * libraries can both hold a tree.png. The key used to be the filename
     * alone, so the second one silently overwrote the first and both
     * placements drew the same picture. Looks make that likelier, since a troll
     * and the boulder it turns into come out of the same run. The same source
     * used by two placements still writes once, which is the point of keying by
     * the absolute path rather than counting. */
    const named = new Map() // absolute source file or folder -> name inside assets/
    const uniq = (abs, want, ext) => {
      const had = named.get(abs)
      if (had) return had
      const used = new Set(named.values())
      let n = want + ext
      for (let i = 2; used.has(n); i++) n = `${want}-${i}${ext}`
      named.set(abs, n)
      return n
    }
    /* ONE APPEARANCE, packed: views, frames or a bare src, in that order, with
     * its pngs read into the shared buffer map. It runs for the placement
     * itself and again for each extra look a sequence switches to, so a look is
     * written exactly the way the placement is and no reader learns a second
     * shape. Returns null when nothing resolved, which drops the entry the same
     * way the branches always did. */
    const packLook = (s) => {
      if (!s || typeof s !== 'object') return null
      /* a placement with VIEWS: every rotation goes into the bundle under one
       * folder, keyed by the heading it faces. The game picks by where the
       * thing is walking, which is what stops a figure moon-walking. */
      if (s.dirs && typeof s.dirs === 'object' && Object.keys(s.dirs).length) {
        // read into the same buffer map everything else uses: the folder is
        // rebuilt further down, so anything written straight to disk here would
        // be deleted by its own export
        const outDirs = {}
        let metaFile = ''
        /* THE COMPOUND HEADINGS GO IN FIRST, AND THAT ORDER IS THE WHOLE FIX.
         * See orderedHeadings in store/publish.mjs for what goes wrong when they
         * do not: the game re-derives a resting heading with an endsWith scan,
         * 'south-west-0.png' ends with 'west-0.png', and 17 of the hub's 38
         * direction sets came out facing the wrong way. Written once there,
         * because two publishers pack these sets. */
        for (const k of orderedHeadings(Object.keys(s.dirs))) {
          const arr = s.dirs[k]
          if (!Array.isArray(arr) || !arr[0]) continue
          /* EVERY frame of the heading, not the first one alone. A character is
           * a walk cycle, six frames to a heading, so keeping frame 0 handed the
           * game a statue that slid across the ground: the exact moon-walk the
           * views were added to stop. A stop at the first missing file, the way
           * the animated branch below stops, keeps the run contiguous. */
          const out = []
          for (const u of arr) {
            const abs = resolveAssetFile(u, dir)
            if (!abs) break
            const srcDir = path.dirname(abs)
            const rel = uniq(srcDir, path.basename(srcDir), '') + '/' + path.basename(abs)
            writes.set(rel, fs.readFileSync(abs))
            out.push('assets/' + rel)
            if (!metaFile) metaFile = path.join(srcDir, 'dirs.json')
          }
          if (out.length) outDirs[k] = out
        }
        if (Object.keys(outDirs).length) {
          // the rate those frames play at, off the item's own dirs.json the way
          // an animated item carries its fps. A set of single views has nothing
          // to cycle, so the number only ever matters to a walker.
          let fps = Number(s.fps) > 0 ? Math.round(Number(s.fps)) : 8
          try {
            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
            if (Number(meta.fps) > 0) fps = Math.round(Number(meta.fps))
          } catch {
            /* no dirs.json beside the views, or unreadable: the default stands */
          }
          /* THE HEADING THE AUTHOR PICKED, not south.
           *
           * A standing figure has no movement to derive a facing from, so its
           * resting view is whatever the facing picker set, and that choice is
           * carried on the placement's own src. This line used to hand back
           * outDirs.south unconditionally, which silently turned 17 of the
           * hub's hand-turned figures back to front: 21 south, 8 south-west and
           * 9 south-east went in, 38 south came out.
           *
           * Nothing about the pixels or the JSON was wrong, which is what made
           * it invisible. editor.ts documents this exact contract one file over
           * and the exporter broke it. */
          const wanted = String(s.src || '')
          let rest = ''
          for (const [k, arr] of Object.entries(s.dirs)) {
            if (Array.isArray(arr) && arr.some((u) => String(u) === wanted)) {
              rest = k
              break
            }
          }
          const restSet = (rest && outDirs[rest]) || outDirs.south || Object.values(outDirs)[0]
          return {
            dirs: outDirs,
            // frame 0 of the resting view, so a reader that knows nothing about
            // headings still gets the picture the author actually chose
            src: restSet[0],
            facing: rest || 'south',
            fps,
          }
        }
      }
      if (Array.isArray(s.frames) && s.frames.length) {
        // an animated placement: the frames live together in one folder
        const first = resolveAssetFile(s.frames[0], dir)
        if (!first) return null
        const srcDir = path.dirname(first)
        const dirName = uniq(srcDir, path.basename(srcDir), '')
        const frames = []
        for (let i = 0; i < s.frames.length; i++) {
          const from = path.join(srcDir, i + '.png')
          if (!fs.existsSync(from)) break
          writes.set(dirName + '/' + i + '.png', fs.readFileSync(from))
          frames.push(`assets/${dirName}/${i}.png`)
        }
        return frames.length ? { frames, fps: Number(s.fps) > 0 ? Number(s.fps) : 6 } : null
      }
      if (s.src) {
        const from = resolveAssetFile(s.src, dir)
        if (!from) return null
        const ext = path.extname(from)
        const file = uniq(from, path.basename(from, ext), ext)
        writes.set(file, fs.readFileSync(from))
        return { src: 'assets/' + file }
      }
      return null
    }
    const placements = (Array.isArray(b.assets) ? b.assets : []).filter((a) => a && typeof a === 'object')
    /* WHICH of the two drops happened, and to whom.
     *
     * The guard at the end of this loop fires on a count, and a count cannot say
     * why. Both `continue`s below reach it, so a placement carrying a bad x, y
     * or scale was reported as missing art and sent the person hunting for a png
     * that was sitting right there. Counted apart, with the ids, so the refusal
     * names the cause it actually hit. */
    const badNumber = []
    const noArt = []
    for (const a of placements) {
      const pid = String(a.id || '(no id)')
      const x = Number(a.x)
      const y = Number(a.y)
      const scale = Number(a.scale)
      if (!isFinite(x) || !isFinite(y) || !(scale > 0)) {
        badNumber.push(pid)
        continue
      }
      // the transform contract: scaleX/scaleY/rot/flipX/flipY, with scale
      // kept equal to scaleX so every older reader stays alive. An editor
      // asset that predates the fields exports as the identity transform.
      const scaleX = Number(a.sx) > 0 ? Number(a.sx) : scale
      const scaleY = Number(a.sy) > 0 ? Number(a.sy) : scale
      const rot = isFinite(Number(a.rot)) ? Number(a.rot) : 0
      const flipX = !!a.fx
      const flipY = !!a.fy
      // how it MOVES, if it does, straight through as the numbers the editor
      // holds. The game works out where it is each frame from these; there are
      // no extra pixels and nothing to load. A sequence is more of the same:
      // life.states is numbers too, so it rides this spread untouched and the
      // exporter needs no idea that it exists.
      const life = a.life && typeof a.life === 'object' ? a.life : null
      const tf = { scale: scaleX, scaleX, scaleY, rot, flipX, flipY, ...(life ? { life } : {}) }
      /* look 0 is the entry itself, in exactly the shape every existing reader
       * knows, so a placement that never changes moves not an inch. The extra
       * appearances a sequence switches to ride alongside under one optional
       * key, and a reader that has never heard of looks ignores it and draws
       * the thing the way it starts. */
      const look0 = packLook(a)
      if (!look0) {
        noArt.push(pid)
        continue
      }
      /* a look whose png has gone KEEPS ITS SLOT, holding look 0.
       *
       * art is an index, so dropping one here shifts every later look down and
       * the bundle then draws the wrong picture rather than a missing one.
       * Measured on a placement whose looks were [gone, boulder] with states at
       * art 1 and 2: the boulder came out at index 1 and art 2 fell off the end
       * back to the boat, so both states drew something that was never asked
       * for. The game reader already holds the slot the same way, and so does
       * a reopen, so all three sides agree that a look that did not arrive
       * shows the thing the way it started. */
      const looks = []
      // STATES_MAX extras, because a round is at most that many states and each
      // of them can name one picture that is not look 0. See STATES_MAX.
      for (const L of Array.isArray(a.looks) ? a.looks.slice(0, STATES_MAX) : []) looks.push(packLook(L) || look0)
      /* WHAT EACH FACE IS CALLED, in one array indexed exactly the way `art`
       * indexes the pictures: slot 0 is the placement's own and slot 1 is
       * looks[0]. life.ts is emphatic that art is "an INDEX and never a name",
       * and it stays that way; this rides beside it so `show(placement, state)`
       * finally has a vocabulary to select from, and nothing that reads by index
       * can tell the difference.
       *
       * NOT PACKED INSIDE look0. look0 is spread into this entry, so a `name` on
       * it would land on top of the placement's own name three lines above and
       * the map's whole addressing system would come out holding the name of a
       * picture. One array, one indexing law, no collision.
       *
       * An empty string is a face nobody named and HOLDS ITS SLOT, for the same
       * reason a look that would not load holds its: dropping one shifts every
       * later name onto the wrong index. Absent entirely when nothing here is
       * named, so a bundle from a map with no vocabulary grows no field. */
      const names = [
        isAnchorName(a.lookName) ? String(a.lookName) : '',
        ...(Array.isArray(a.looks) ? a.looks.slice(0, STATES_MAX) : []).map((L) =>
          L && isAnchorName(L.name) ? String(L.name) : '',
        ),
      ]
      outAssets.push({
        id: String(a.id),
        /* the author's own name for this thing, when they gave it one. It is
         * what an anchor binds to and what python addresses, and the id beside
         * it is a counter nobody chose, so a bundle that dropped this would
         * hand the game back the machine string it was written to replace.
         * Absent on scenery, which is nearly everything. */
        ...(isPlacementName(a.name) ? { name: String(a.name) } : {}),
        group: String(a.group || 'props'),
        /* WHEN THIS THING IS THERE AT ALL. Already resolved by editor.ts
         * bundle() against the map's group rows, because that is the side that
         * holds them, so what arrives here is the one string that ships. MAPVIS
         * never reads inside it: it declares the condition and python decides
         * what it means. */
        ...(typeof a.when === 'string' && a.when.trim() ? { when: a.when.trim().slice(0, 240) } : {}),
        ...look0,
        x,
        y,
        ...tf,
        ...(looks.length ? { looks } : {}),
        ...(names.some((n) => n) ? { lookNames: names } : {}),
      })
    }
    /* THE SAME COUNT OUT AS IN, or no bundle at all.
     *
     * The two `continue`s above are each correct on their own and together they
     * are how an island loses people quietly: a placement whose png did not
     * resolve is simply not in outAssets, and every count the response reports
     * is counted after the drop, so a bundle missing 19 of 75 placements reads
     * exactly like one missing none.
     *
     * Naming both numbers is the point. "62 of 75" tells a person to look; a
     * silent 62 does not. It sits here because the count is not knowable any
     * earlier, and here is still ahead of the two things that cannot be taken
     * back: the rm and rebuild of assets/, and the publish of a version. The
     * plane pngs above have already been rewritten with the same pixels the
     * editor holds, which is what a save does anyway.
     *
     * The two causes are named separately. This message used to say only that
     * the art was missing, which is a lie half the time it fires: a bad number
     * blocks the whole export and the person is then told to go looking for a
     * png that is on disk. */
    if (outAssets.length < placements.length) {
      // enough ids to go and look at, not a wall of them: a big map could drop
      // hundreds and the message has to stay readable
      const some = (list) => list.slice(0, 12).join(', ') + (list.length > 12 ? `, and ${list.length - 12} more` : '')
      const why = []
      if (noArt.length) why.push(`${noArt.length} whose art did not resolve, so it is not on this machine or in the store: ${some(noArt)}`)
      if (badNumber.length) why.push(`${badNumber.length} carrying a bad x, y or scale: ${some(badNumber)}`)
      return send(res, 502, {
        error: `only ${outAssets.length} of ${placements.length} placements resolved, so nothing was written. ${why.join('. ')}`,
        missingArt: noArt,
        badNumbers: badNumber,
      })
    }
    step(`${outAssets.length} placement(s) resolved, ${writes.size} png(s) read`)
    fs.rmSync(assetsDir, { recursive: true, force: true })
    for (const [rel, buf] of writes) {
      const to = path.join(assetsDir, rel)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.writeFileSync(to, buf)
    }
    const copied = writes.size
    fs.writeFileSync(path.join(dir, 'assets.json'), JSON.stringify({ assets: outAssets }, null, 2))
    files.push(copied ? `assets.json (+${copied} png${copied > 1 ? 's' : ''})` : 'assets.json')

    // The same bytes, written once more as an immutable version in object
    // storage. That is the publish: the game reads a version rather than a
    // folder somebody copied by hand, re-exporting cannot break a class that is
    // mid-session, and map.json picks up anchors[] from the database on the way
    // through. work/<id>/ stays exactly as it was, because it is still what a
    // reopened scene reads.
    step('assets folder rebuilt')
    let published = null
    if (platformOn()) {
      try {
        const png = (name) => {
          const f = path.join(dir, name)
          return fs.existsSync(f) ? fs.readFileSync(f) : null
        }
        published = await publishBundle(id, {
          mapJson: b.map,
          assetsJson: { assets: outAssets },
          images: {
            'scene.png': png('scene.png'),
            'levels.png': png('levels.png'),
            'occluders.png': png('occluders.png'),
            'cut.png': png('cut.png'),
          },
          files: writes,
        })
        files.push(`published v${published.version} (${published.anchors} anchor${published.anchors === 1 ? '' : 's'})`)
      } catch (e) {
        console.error('[export] published to disk but not to the platform:', e.message)
        files.push('NOT published · ' + String(e.message).slice(0, 80))
      }
    }
    step('done')
    return send(res, 200, { dir, files, published })
  }

  if (p === '/api/save' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const dir = path.join(WORK, id)
    if (!insideWork(dir)) return send(res, 400, { error: 'bad id' })
    const buf = Buffer.from(stripDataURL(b.image), 'base64')
    if (diskAllowed()) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'scene.png'), buf)
    }
    /* AND INTO OBJECT STORAGE, which this never did. See savePainting: the
     * painting was the only part of a map that stayed on whichever machine
     * loaded it, so a map made here opened on the host with no art at all. */
    let stored = false
    if (platformOn()) {
      try {
        await savePainting(id, buf)
        stored = true
      } catch (e) {
        if (e.name === 'NoOwner') return send(res, 401, { error: 'sign in to create a map' })
        console.error('[save] painting did not reach storage:', e.message)
        if (!diskAllowed()) return send(res, 503, { error: `painting could not be stored: ${e.message}` })
      }
    }
    return send(res, 200, { url: `/work/${id}/scene.png`, stored })
  }

  // the cut-applied painting alone, staged before any mechanics exist:
  // scene-cut.png is the deliverable, cut.png is the mask so reopening the
  // scene picks the cut back up
  if (p === '/api/savecut' && req.method === 'POST') {
    const b = await body(req)
    if (!b.image) return send(res, 400, { error: 'no image' })
    const id = safeId(b.id)
    const dir = path.join(WORK, id)
    if (!insideWork(dir)) return send(res, 400, { error: 'bad id' })
    fs.mkdirSync(dir, { recursive: true })
    const files = []
    fs.writeFileSync(path.join(dir, 'scene-cut.png'), Buffer.from(stripDataURL(b.image), 'base64'))
    files.push('scene-cut.png')
    if (b.cut) {
      fs.writeFileSync(path.join(dir, 'cut.png'), Buffer.from(stripDataURL(b.cut), 'base64'))
      files.push('cut.png')
    }
    return send(res, 200, { dir, files })
  }

  /* The doc exactly as the editor holds it, written on the same beat as the
   * browser autosave. A map used to live in one localStorage key on one machine
   * behind a quota failure that says nothing, so hours of masking had no second
   * copy anywhere. The body is the string Doc.serialize() already produces,
   * stored verbatim, so there is no second format to keep in step with it. */
  if (p === '/api/doc' && req.method === 'POST') {
    const b = await body(req)
    if (typeof b.doc !== 'string' || !b.doc) return send(res, 400, { error: 'no doc' })
    const id = safeId(b.id)
    // The platform splits it: the three mask planes become a png in object
    // storage, the placements become a row, and each half is skipped when its
    // own content did not change. At one autosave every four seconds that
    // skipping is the difference between a free database living and dying.
    if (platformOn()) {
      try {
        const r = await saveDocument(id, b.doc)
        return send(res, 200, { bytes: b.doc.length, wrote: r.wrote, savedAt: r.savedAt })
      } catch (e) {
        /* "you are not signed in" is an answer, not an outage.
         *
         * The disk fallback below exists so an unreachable database never costs
         * an author their work. A refusal is the opposite case: falling through
         * would write a stranger's map into scratch, report success, and lose it
         * when the instance ends. Say so instead. */
        if (e.name === 'NoOwner') return send(res, 401, { error: String(e.message) })
        // never lose an author's work to a database being unreachable: fall
        // through and put it on disk, and say so
        console.error('[doc] platform save failed, writing to disk:', e.message)
      }
      if (!diskAllowed()) return send(res, 503, { error: 'platform save failed and disk is off' })
    }
    if (!diskAllowed()) return send(res, 503, { error: 'disk is off' })
    const dir = path.join(WORK, id)
    if (!insideWork(dir)) return send(res, 400, { error: 'bad id' })
    fs.mkdirSync(dir, { recursive: true })
    // written beside and renamed, because a write killed halfway through leaves
    // a truncated doc that reads as valid until the moment it is needed
    const tmp = path.join(dir, 'doc.json.tmp')
    fs.writeFileSync(tmp, b.doc)
    fs.renameSync(tmp, path.join(dir, 'doc.json'))
    return send(res, 200, { bytes: b.doc.length, wrote: ['disk'] })
  }

  /* RENAMING A MAP, which is the one key everything else addresses.
   *
   * A map's id comes from the name of the file somebody dropped, or from ?id=,
   * and there has never been a way to change it. It is simultaneously the
   * publish slug, every door's target, the objective's map field, the world
   * roster key and the save key, so the one string the whole game addresses is
   * a side effect of what a png was called.
   *
   * The doors move with it. A rename that leaves twelve doors pointing at a map
   * that no longer answers is a rename that breaks the archipelago silently,
   * and the count is said out loud so an author knows what just happened.
   * Published versions keep their old prefix on purpose: they are immutable and
   * keyed by map id, so a class mid-session is untouched. */
  if (p === '/api/map-rename' && req.method === 'POST') {
    if (!platformOn()) return send(res, 503, { error: 'renaming needs the platform' })
    const b = await body(req)
    const from = safeId(b.from)
    const to = safeId(b.to)
    if (!to || !/^[a-z0-9][a-z0-9._-]{0,59}$/.test(to))
      return send(res, 400, { error: 'an id is lower case letters, digits, dot, dash or underscore, and starts with a letter or a digit' })
    if (from === to) return send(res, 200, { slug: to, repointed: 0 })
    const user = await currentUser(req)
    if (!user) return send(res, 401, { error: 'sign in first' })
    const mine = await one('select id, owner_id from maps where slug = $1', [from])
    if (!mine) return send(res, 404, { error: `no map ${from}` })
    if (mine.owner_id !== user.id) return send(res, 403, { error: 'that is not your map' })
    const taken = await one('select 1 from maps where slug = $1', [to])
    if (taken) return send(res, 409, { error: `${to} is taken · slugs are global, because a door names one as a bare string` })
    await q('update maps set slug = $2, updated_at = now() where id = $1', [mine.id, to])
    const moved = await many('update anchors set to_slug = $2 where to_slug = $1 returning name', [from, to])
    return send(res, 200, { slug: to, repointed: moved.length })
  }

  if (p.startsWith('/api/doc/') && req.method === 'GET') {
    const id = safeId(decodeURIComponent(p.slice('/api/doc/'.length)))
    // savedAt travels with the document because the browser also holds a copy,
    // and something has to decide which of the two is the real one. Without it
    // the editor prefers localStorage forever and the map still lives in one
    // browser, which is the whole thing this was meant to fix.
    if (platformOn()) {
      try {
        const r = await loadDocument(id)
        if (r?.doc) {
          /* OPENING A MAP IS WORKING ON IT.
           *
           * The dashboard orders by updated_at, which only a save used to
           * touch, so the banner kept leading with whichever map was written
           * last rather than the one just opened. Opening one now counts, which
           * is what "recent" reads as to the person looking at it. */
          q('update maps set updated_at = now() where slug = $1', [id]).catch(() => {})
          return send(res, 200, { doc: r.doc, savedAt: r.savedAt, from: 'platform' })
        }
      } catch (e) {
        console.error('[doc] platform load failed, trying disk:', e.message)
      }
      if (!diskAllowed()) return send(res, 200, { doc: '', savedAt: 0 })
    }
    const f = path.join(WORK, id, 'doc.json')
    // was f.startsWith(WORK), which a sibling like work-old/ satisfies. See insideWork.
    if (!insideWork(f) || !fs.existsSync(f)) return send(res, 200, { doc: '', savedAt: 0 })
    return send(res, 200, {
      doc: fs.readFileSync(f, 'utf8'),
      savedAt: fs.statSync(f).mtimeMs,
      from: 'disk',
    })
  }

  return notFound(res)
}

/* ---- the linked machine ---------------------------------------------------
 *
 * A relay authenticates with its own token, not a session, because it is a
 * process on a laptop rather than a person in a browser. The token is stored
 * hashed the same way a session is, so a stolen database cannot be replayed.
 *
 * It can only ever claim jobs belonging to the account it is linked to, and it
 * never sees a map, a key or anything else. All it does is answer questions.
 */
async function relayApi(req, res, p) {
  if (req.method !== 'POST') return send(res, 405, { error: 'post only' })
  const auth = String(req.headers.authorization || '')
  const token = auth.startsWith('Relay ') ? auth.slice(6).trim() : ''
  const link = token
    ? await one('select * from relay_links where token_hash = $1', [hashToken(token)])
    : null
  if (!link) return send(res, 401, { error: 'unknown relay token' })

  const b = await body(req)

  if (p === '/api/relay/claim') {
    // asking for work IS the heartbeat: a relay that is polling is by
    // definition alive, so there is no second timer to forget to send
    const caps = Array.isArray(b.caps) && b.caps.length ? b.caps : ['claude']
    await q(
      `update relay_links set last_seen_at = now(), name = coalesce(nullif($2,''), name), capabilities = $3
       where id = $1`,
      [link.id, String(b.name || '').slice(0, 80), caps],
    )
    /* One job, taken atomically. `for update skip locked` is what makes two
     * machines on the same account safe: each grabs a different row instead of
     * both running the same question and billing it twice. */
    const job = await one(
      `update jobs set status = 'claimed', claimed_by = $1, heartbeat_at = now()
       where id = (
         select id from jobs
          where user_id = $2 and status = 'queued' and provider = any($3::text[])
          order by created_at
          for update skip locked
          limit 1
       )
       returning id, kind, provider, payload`,
      [link.id, link.user_id, caps],
    )
    return send(res, 200, { job: job || null })
  }

  if (p === '/api/relay/done') {
    const owned = await one('select id from jobs where id = $1 and claimed_by = $2', [String(b.id || ''), link.id])
    if (!owned) return send(res, 404, { error: 'not your job' })
    if (b.error) {
      await q(`update jobs set status='error', error=$2, finished_at=now() where id=$1`, [owned.id, String(b.error).slice(0, 300)])
    } else {
      await q(`update jobs set status='done', result=$2::jsonb, finished_at=now() where id=$1`, [
        owned.id,
        JSON.stringify({ text: String(b.text ?? '') }),
      ])
    }
    return send(res, 200, { ok: true })
  }

  return send(res, 404, { error: 'no such endpoint' })
}

/* ---- accounts -------------------------------------------------------------
 *
 * Anyone can make one. The club shares a single login on purpose, so there is
 * no team model here and adding one would be machinery serving nobody.
 *
 * Signed out is not signed out of MAPVIS: the cut tool, levels, the walk test,
 * placing and export all work with no account at all, and always will. An
 * account is what makes a map yours across machines and what holds the keys.
 */
async function authApi(req, res, p, url) {
  const body_ = async () => (req.method === 'POST' ? await body(req) : {})

  if (p === '/api/auth/signup' && req.method === 'POST') {
    const b = await body_()
    try {
      const user = await signUp({ email: b.email, password: b.password, displayName: b.displayName })
      const token = await openSession(user.id, req.headers['user-agent'] || '')
      setSessionCookie(res, token)
      return send(res, 200, { user })
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) })
    }
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const b = await body_()
    try {
      const { token, user } = await signIn({
        email: b.email,
        password: b.password,
        userAgent: req.headers['user-agent'] || '',
      })
      setSessionCookie(res, token)
      return send(res, 200, { user })
    } catch (e) {
      // deliberately one message for both "no such email" and "wrong password",
      // so this cannot be used to find out who has an account here
      return send(res, 401, { error: String(e.message || e) })
    }
  }

  /* DELETING A MAP, WHICH IS THE ONE THING HERE THAT CANNOT BE UNDONE.
   *
   * A cut and its levels are hours of hand work and there is no version of them
   * anywhere else once the rows and the blobs are gone, so this asks for the
   * account password again even though the caller is already signed in. A
   * session proves the browser was left open. It does not prove the person
   * asking meant this.
   *
   * The order matters and is the whole safeguard:
   *   1. signed in at all
   *   2. this map exists
   *   3. this account owns it, checked against the row and not the UI
   *   4. the password is right
   * Only then does anything get destroyed. Every failure returns before a
   * single byte is touched. */
  if (p === '/api/maps/delete' && req.method === 'POST') {
    // sessionUser and NOT currentUser: solo mode must never authorise a delete
    const me = await sessionUser(req)
    if (!me) return send(res, 401, { error: 'sign in first' })

    const b = await body_()
    const slug = safeId(b.id || '')
    if (!slug) return send(res, 400, { error: 'which map' })

    const m = await one('select id, slug, owner_id from maps where slug = $1', [slug])
    if (!m) return send(res, 404, { error: 'no such map' })
    if (m.owner_id && m.owner_id !== me.id) return send(res, 403, { error: `${slug} belongs to another account` })

    const row = await one('select password_hash from users where id = $1', [me.id])
    if (!row || !(await verifyPassword(String(b.password || ''), row.password_hash))) {
      // deliberately vague and deliberately not destructive
      return send(res, 401, { error: 'that password is not right' })
    }

    // the bytes first, then the rows. If this dies halfway the map is still
    // listed and can be asked to delete again, which is recoverable. Rows first
    // would strand the blobs with nothing pointing at them.
    const s = store()
    try {
      await s.delPrefix(`maps/${m.id}/`)
      await s.delPrefix(`publish/${slug}/`)
    } catch (e) {
      return send(res, 502, { error: `storage refused: ${String(e.message || e).slice(0, 140)}` })
    }
    await q('delete from maps where id = $1', [m.id])

    // and this machine's own copy, so a deleted map cannot reappear from disk
    try {
      const dir = path.join(WORK, slug)
      if (dir.startsWith(WORK) && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      console.error('[delete] local copy survived:', e.message)
    }

    console.log(`[delete] ${slug} removed by ${me.email}`)
    return send(res, 200, { ok: true, slug })
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    await closeSession(tokenFrom(req))
    clearSessionCookie(res)
    return send(res, 200, { ok: true })
  }

  if (p === '/api/me') {
    const user = await currentUser(req)
    if (!user) return send(res, 200, { user: null })
    return send(res, 200, { user, spend: await spendSince(user.id, 30) })
  }

  /* Which service this account reaches how. The key itself never comes back
   * out; the account only ever learns whether one is stored. */
  if (p === '/api/auth/provider' && req.method === 'POST') {
    const user = await currentUser(req)
    if (!user) return send(res, 401, { error: 'sign in first' })
    const b = await body_()
    try {
      return send(res, 200, { user: await setProvider(user.id, b.service, b.mode, b.key) })
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) })
    }
  }

  /* Link a machine. The token is shown once and stored only as its hash, the
   * same rule sessions follow, so losing it means making another rather than
   * reading it back out of the database. */
  if (p === '/api/auth/relay-token' && req.method === 'POST') {
    const user = await currentUser(req)
    if (!user) return send(res, 401, { error: 'sign in first' })
    const b = await body_()
    const token = newToken()
    const caps = Array.isArray(b.caps) && b.caps.length ? b.caps : ['claude']
    const link = await one(
      `insert into relay_links (user_id, name, token_hash, capabilities)
       values ($1,$2,$3,$4) returning id, name, capabilities, created_at`,
      [user.id, String(b.name || 'a machine').slice(0, 80), hashToken(token), caps],
    )
    return send(res, 200, { link, token, note: 'copy it now · it is not shown again' })
  }

  if (p === '/api/auth/relays') {
    const user = await currentUser(req)
    if (!user) return send(res, 200, { relays: [] })
    return send(res, 200, {
      relays: await many(
        `select id, name, capabilities, last_seen_at,
                (last_seen_at > now() - interval '90 seconds') as live
         from relay_links where user_id = $1 order by created_at`,
        [user.id],
      ),
    })
  }

  // the dashboard: what this account has made, without any of it being loaded
  if (p === '/api/my-maps') {
    const user = await currentUser(req)
    if (!user) return send(res, 200, { maps: [] })
    return send(res, 200, { maps: await listMaps(user.id) })
  }

  return send(res, 404, { error: 'no such endpoint' })
}

/* ---- /api/v1, the read side ---------------------------------------------
 *
 * The only part of MAPVIS anything outside MAPVIS is allowed to call: the game
 * fetching a published map, and eventually a member's python asking what a map
 * is called and what is in it.
 *
 * Versioned in the path from the first line, because the whole point of the
 * anchors contract is that code written against it keeps working. Read-only,
 * so nothing here can damage a map. Everything is served by slug, never by the
 * internal uuid, since a slug is what an author typed and what a door's `to`
 * field already carries.
 *
 * Deliberately NOT here: anything that mutates. Publishing happens in the
 * editor, and a grape that could rewrite a map is a grape that can break every
 * other island.
 */
async function readApi(req, res, p, url) {
  /* CROSS-ORIGIN, WHICH THIS NEEDED FROM THE DAY IT WAS WRITTEN.
   *
   * The whole point of /api/v1 is that something which is NOT MAPVIS calls it,
   * and something which is not MAPVIS is on another origin. The file route set
   * this header and the manifest route did not, and the manifest is the FIRST
   * call the game makes, so the browser refused it before a byte moved and the
   * game fell back to the hand-copied folder every single time. Found from the
   * game side on 2026-08-27: fetching /api/v1/maps/hub from localhost was
   * blocked by CORS, so "the game asks the platform for a map" has never once
   * actually happened, on any origin but this one.
   *
   * `*` is right here and only here. Everything under /api/v1 is read-only,
   * published, immutable and already public to anyone with the slug; nothing
   * authenticated is reachable through this function. The editor's own routes
   * are a different handler and stay same-origin.
   */
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Vary', 'Origin')
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Max-Age', '86400')
    res.statusCode = 204
    return res.end()
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'read only' })
  // maps / <slug> / <sub> / <version> / <rel...>
  const parts = p
    .slice('/api/v1/'.length)
    .split('/')
    .map((s) => (s ? decodeURIComponent(s) : s))
  const [kind, slugRaw, sub] = parts

  // every map anyone could ask for, which is the registry the game has never
  // had. Doors name a target by slug and nothing has ever been able to answer
  // whether that target exists.
  if (kind === 'maps' && !slugRaw) {
    const rows = await many(
      `select m.slug, m.title, m.w, m.h, m.base_w, m.base_h, m.updated_at,
              (select max(version) from publishes p where p.map_id = m.id) as version,
              (select count(*)::int from anchors a where a.map_id = m.id)  as anchors
       from maps m order by m.updated_at desc`,
    )
    const maps = rows.filter((r) => r.version)
    /* THE WHOLE DOOR GRAPH IN ONE REQUEST, which is what ?with=anchors is for.
     *
     * The listing carried an anchor COUNT and the per-map listing deliberately
     * carried no x,y, so building a door graph over twelve islands cost
     * thirteen requests, and the world scene had to fetch a whole published
     * map.json just to learn where one dock is. That is a whole class arriving
     * inside one advisory block, on a 4 GB Chromebook, paying it. Opt-in, so
     * the cheap listing stays cheap for the dashboard that only wants names. */
    if (url.searchParams.get('with') === 'anchors' && maps.length) {
      /* THE AREA COMES WITH IT, AND IT DID NOT, so every region on the ocean
       * chart was drawn as a circle of its radius: an author who walked the
       * edge of a pier saw a ring over the water beside it. The three fields
       * below are what anchorShape needs to answer which of the three an author
       * meant, and the mode rides in the meta bag, so it is lifted onto the
       * field here exactly as readEvents lifts it for the editor. */
      const all = await many(
        `select m.slug, a.name, a.kind, a.x, a.y, a.r, a.to_slug, a.to_anchor, a.label, a.rect, a.poly, a.meta
         from anchors a join maps m on m.id = a.map_id
         where m.slug = any($1) order by m.slug, a.kind, a.name`,
        [maps.map((m) => m.slug)],
      )
      const by = new Map()
      for (const a of all) {
        if (!by.has(a.slug)) by.set(a.slug, [])
        by.get(a.slug).push({
          name: a.name,
          kind: a.kind,
          x: a.x,
          y: a.y,
          ...(a.r ? { r: a.r } : {}),
          ...(a.to_slug ? { to: a.to_slug } : {}),
          ...(a.to_anchor ? { toAnchor: a.to_anchor } : {}),
          ...(a.label ? { label: a.label } : {}),
          ...(['circle', 'rect', 'poly'].includes(a.meta?.shape) ? { shape: a.meta.shape } : {}),
          ...(Array.isArray(a.rect) && a.rect.length === 4 ? { rect: a.rect } : {}),
          ...(Array.isArray(a.poly) && a.poly.length > 2 ? { poly: a.poly } : {}),
        })
      }
      return send(res, 200, { maps: maps.map((m) => ({ ...m, anchors: by.get(m.slug) || [] })) })
    }
    return send(res, 200, { maps })
  }

  /* THE OCEAN, which is the one surface the whole crossing happens on and the
   * one the game had to hold as a constant because nothing could author it.
   * Served live from the row rather than from a published version: the maps
   * registry above is live for the same reason, and a composition that lags a
   * republish would place an island that has already moved.
   *
   * PUBLIC, AND IT HAS TO STAY PUBLIC. The authoring pair at /api/world is now
   * gated on the account the ocean belongs to, and the temptation is to gate
   * this the same way. It would break the game outright: a freshman on a
   * chromebook has no MAPVIS account, has never heard of one, and this is the
   * request that tells the ship where the islands are. Read-only, published,
   * already reachable by anyone with the URL.
   *
   * AND IN THE GAME'S OWN WORDS, not in this tool's. The row is the authoring
   * document and its shape belongs to the chart page; what leaves here is the
   * composition the game asks for, which it gates on Array.isArray(slots).
   * Answering with `places` meant a real composition was discarded and a
   * hand-written fallback used in its place, silently, on both sides.
   * composition() in store/world.mjs is where every one of those renames is.
   *
   * PINNED TO ROW 1, EXPLICITLY, and that is the whole of what 022 owes the
   * game. Every account has an ocean now and this path has no account in it and
   * never will: the request comes from a chromebook with no cookie. So the id is
   * a constant here rather than something resolved, and the answer is byte for
   * byte what it was before worlds were per-account. */
  if (kind === 'world' && !slugRaw) return send(res, 200, await composition(GAME_WORLD))

  /* THE BERTHS, FLAT, WHICH IS THE SHAPE A GRAPE ACTUALLY WANTS.
   *
   * A member writing sail_to("north_passage") holds a name and nothing else.
   * Handing them the whole composition means walking a list and matching a
   * field before they can move a ship, in a language running on MicroPython in
   * a worker, which is a loop written slightly differently in every island.
   * So the lookup is done here, once, and what comes back is a dictionary keyed
   * by the name the author typed in MAPVIS.
   *
   * This is the project's dividing line in one route: MAPVIS authors WHERE, and
   * python authors WHAT HAPPENS and WHEN. The berth says the corner of the
   * crossing is at (2100, 880) facing north; whether the ship pauses there,
   * whether somebody speaks, and what it costs are the grape's business and
   * this endpoint has no opinion about any of it.
   *
   * A ROUTE BETWEEN BERTHS IS A LATER THING. Ash asked for a ship that hops from
   * one island to another, steering through whatever berths sit in the middle,
   * and nothing here builds it. It does not need to: every point is addressable
   * by name and says which island it belongs to, so a route is a list of names
   * that some future thing writes down. Do not add a `routes` key until there is
   * something on the other side of the wire reading it.
   *
   * A BERTH BOUND TO AN ISLAND IS ALSO ANSWERED UNDER THAT ISLAND'S OWN NAME,
   * because a grape asking to sail to `panther_isle` should not have to know
   * what the author called its dock. The alias goes down FIRST so a real point
   * named `panther_isle` wins the key; checkWorld refuses that collision at the
   * save, so this only decides what a row written before the check does.
   *
   * WRITTEN ONCE AND SERVED FROM TWO PATHS, because 022 gave every account an
   * ocean and a member's engine wants this shape for the same reason ours does.
   * A second copy of the mapping is a second set of fields that drift, which is
   * how `label` and `r` came to be missing here in the first place. */
  const flatMarks = async (id) => {
    const w = await getWorld(undefined, id)
    const out = {}
    const say = (m) => ({
      kind: m.kind,
      x: m.x,
      y: m.y,
      facing: m.facing || '',
      /* THE LABEL RIDES ALONG, and it was the one field this route dropped. The
       * column, cleanMark and the chart's inspector all carry it, so a grape
       * sailing to a point could hold the address and had no way at all to get
       * the words a player should be shown for it, which leaves an island
       * printing `north_passage` at somebody. */
      label: m.label || '',
      /* WHICH ISLAND IT BELONGS TO, and this is what makes the flat lookup
       * enough on its own. Without it a grape holding `the_hub_berth` can sail
       * there and cannot tell what it has arrived at, so it would have to fetch
       * the whole composition to answer a question this row already knows. */
      island: m.island || '',
      // and where the hull puts somebody down once they are ashore, which is an
      // anchor name inside that island rather than a point on the ocean
      at: m.at || '',
      /* HOW CLOSE COUNTS AS ARRIVED, and this route dropped it. BerthPanel makes
       * the author type it and cleanMark stores it, and then the one lookup
       * built for a grape holding nothing but a name did not say it, so every
       * island had to invent its own arrival tolerance and the number somebody
       * typed did nothing. A hull moves in floats, so an exact-pixel test never
       * fires and this is not optional. Zero means the caller decides. */
      r: m.r ?? 0,
    })
    for (const p of w.places) {
      const b = berthOf(w.marks, p.name)
      if (b) out[p.name] = say(b)
    }
    for (const m of w.marks) out[m.name] = say(m)
    return out
  }
  if (kind === 'world' && slugRaw === 'marks') return send(res, 200, { marks: await flatMarks(GAME_WORLD) })

  /* AND THE SAME TWO READS FOR ANY OTHER ACCOUNT'S OCEAN.
   *
   * 022 gave every account a world, and a world nothing can fetch is a drawing.
   * A member composing their own sea needs their own engine to consume it the
   * way ours does, so it is the same two shapes off the same two functions, at
   * an address of their own.
   *
   * PLURAL, AND THAT IS THE WHOLE REASON THE WORD IS DIFFERENT. /api/v1/world
   * already spends its second segment on `marks`, so a singular
   * /api/v1/world/<something> could never tell an ocean's address from that
   * literal, and the game's two paths must not change by one byte. `worlds` has
   * no such history and cannot collide with either.
   *
   * THE ADDRESS IS THE ROW'S pub_id AND NOT ITS OWNER'S. An account uuid appears
   * in session and ownership code all over this file; an ocean's public address
   * is a separate opaque value so handing somebody the url to read your world
   * hands them nothing else, and so it can be rotated without touching identity.
   *
   * Public and unauthenticated, like everything else under /api/v1: what it
   * serves is where somebody's islands sit, which is already published art. */
  if (kind === 'worlds') {
    const id = slugRaw ? await worldByPubId(slugRaw) : 0
    if (!id) return send(res, 404, { error: 'no ocean at that address' })
    if (!sub) return send(res, 200, await composition(id))
    if (sub === 'marks') return send(res, 200, { marks: await flatMarks(id) })
    return send(res, 404, { error: 'an ocean answers with itself or with its marks' })
  }

  /* THE CHROME, WITH ITS SLICES, ITS REGIONS AND ITS FACES.
   *
   * The half of a drawn piece that is not the png, and the shape is
   * docs/UI-KIT.md section 3 verbatim: `{ src, w, h, slice, scale, fill,
   * repeat }` beside the named rectangles. Written to match what the game can
   * consume rather than what is convenient to publish, and the unit is source
   * pixels because that is the only thing CSS border-image and Pixi
   * NineSliceSprite agree on.
   *
   * A grape asking where the speaker's name goes gets an answer from the piece
   * itself rather than from a number somebody typed into game source, which is
   * the whole reason regions exist. Served live rather than from a published
   * version, the same way the maps registry and the ocean are.
   *
   * `published` rides along rather than filtering, because a piece whose
   * picture has arrived is worth serving to an editor while its measurement is
   * still being made, and a consumer that will only depend on a finished piece
   * has the flag to check.
   *
   * A name is unique per ACCOUNT and there is no account in this path, so two
   * people naming a piece `dialogue_box` collide here. CORE WINS, then the
   * oldest, which is the only ordering consistent with core chrome never being
   * overridable. Survivable because the game reads chrome from one account. */
  if (kind === 'ui') {
    if (!slugRaw) return send(res, 200, { ui: await readyUi() })
    const surface = await readyUiByName(slugRaw)
    if (!surface) return send(res, 404, { error: `no piece ${slugRaw}` })
    if (!sub) return send(res, 200, surface)
    if (sub === 'image') {
      const buf = await uiImage(slugRaw)
      if (!buf) return notFound(res)
      res.setHeader('Content-Type', 'image/png')
      /* IMMUTABLE, WHICH IS A TRADE AND NOT A FREE WIN. There is no version in
       * this key, so redrawing a surface under the same name will not reach a
       * browser that already holds the old picture until its year is up. The
       * thing bought with that is a class of thirty chromebooks fetching the
       * game's chrome exactly once between them, which is the cost that
       * actually shows up. Rename the surface to force a redraw through. */
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      res.setHeader('Access-Control-Allow-Origin', '*')
      return res.end(buf)
    }
    return send(res, 404, { error: 'no such endpoint' })
  }

  if (kind !== 'maps' || !slugRaw) return send(res, 404, { error: 'no such endpoint' })
  const slug = safeId(slugRaw)

  /* The listing that makes a member's python fail at author time instead of
   * silently doing nothing at runtime. Small enough to fetch on every keystroke
   * in an editor, because it carries names and never geometry-heavy data. */
  if (sub === 'anchors') {
    const m = await one('select id from maps where slug = $1', [slug])
    if (!m) return send(res, 404, { error: `no map ${slug}` })
    const rows = await many(
      `select name, kind, to_slug, to_anchor, label, meta from anchors where map_id = $1 order by kind, name`,
      [m.id],
    )
    return send(res, 200, {
      slug,
      anchors: rows.map((a) => ({
        name: a.name,
        kind: a.kind,
        ...(a.to_slug ? { to: a.to_slug } : {}),
        ...(a.to_anchor ? { toAnchor: a.to_anchor } : {}),
        ...(a.label ? { label: a.label } : {}),
        // a name derived from an old door's label rather than typed by a human.
        // Code written against one of these is code written against a guess.
        ...(a.meta?.derived ? { derived: true } : {}),
      })),
    })
  }

  /* THE NAMED COLLECTIONS, FLAT, WHICH IS THE SHAPE A GRAPE ACTUALLY WANTS.
   *
   * The same call /api/v1/world/marks makes and for the same reason: a member
   * holds a name and nothing else. `for stele in self.anchors_in("steles")` beats
   * five hard-coded strings, and it is the only way the map can ever say there
   * are six of them now. Keyed by the name the author typed, so the lookup is
   * done here once rather than as a slightly different loop in every island,
   * written in MicroPython in a worker.
   *
   * SETS AND RACKS COME BACK TOGETHER because they share one namespace: a name is
   * either a set or a rack and never both, which is what lets a grape ask for one
   * by name without also having to say which list to look in.
   *
   * Live from the row rather than from a published version, exactly as the
   * registry and the ocean above are: an author fixing a set and re-running their
   * python should see the fix, and a member's island is edited far more often
   * than it is published. */
  if (sub === 'sets' || sub === 'racks') {
    const m = await one('select id, sets, racks from maps where slug = $1', [slug])
    if (!m) return send(res, 404, { error: `no map ${slug}` })
    const sets = {}
    for (const s of Array.isArray(m.sets) ? m.sets : [])
      sets[s.name] = { ...(s.label ? { label: s.label } : {}), members: Array.isArray(s.members) ? s.members : [] }
    const racks = {}
    for (const r of Array.isArray(m.racks) ? m.racks : [])
      racks[r.name] = {
        ...(r.label ? { label: r.label } : {}),
        // ordered as the author laid them out, which is the order things arrive
        // in, while `slot` is the address that never moves
        slots: (Array.isArray(r.slots) ? r.slots : []).map((s) => ({
          slot: Number(s.slot),
          anchor: s.anchor,
          ...(s.label ? { label: s.label } : {}),
        })),
      }
    return send(res, 200, { slug, sets, racks })
  }

  if (sub === 'versions') return send(res, 200, { slug, versions: await publishHistory(slug) })

  if (!sub) {
    const v = url.searchParams.get('v')
    const pub = await publishedMap(slug, v)
    if (!pub) return send(res, 404, { error: `${slug} has never been published` })
    /* A MAP THAT EXISTS AND A STORE THAT WILL NOT ANSWER ARE DIFFERENT THINGS.
     *
     * Both used to come back as "never published", so a rate-limited bucket
     * read as lost work and sent somebody off to re-export something that was
     * already there. 503 says come back, 404 says it is not here. */
    let map
    try {
      // a published file never changes, so the second read is a transaction
      // spent to learn nothing
      const mk = pub.blob_prefix + 'map.json'
      map = JSON.parse((hotGet(mk) || hotPut(mk, await store().get(mk))).toString('utf8'))
    } catch (e) {
      const why = String(e.message || e)
      return send(res, 503, {
        error: /cap exceeded|bandwidth|transaction/i.test(why)
          ? `${slug} v${pub.version} is published, but object storage has hit its daily download cap. Raise it in the Backblaze console under Caps & Alerts, or wait for the reset.`
          : `${slug} v${pub.version} is published but its files could not be read: ${why.slice(0, 120)}`,
        published: pub.version,
      })
    }
    // absolute urls, so the game can point at a hosted MAPVIS without knowing
    // how any of this is laid out
    const base = `/api/v1/maps/${slug}/file/${pub.version}/`
    return send(res, 200, {
      slug,
      version: pub.version,
      publishedAt: pub.published_at,
      map,
      files: Object.fromEntries(Object.entries(pub.manifest).map(([k, v]) => [k, { ...v, url: base + k }])),
    })
  }

  // the bytes themselves. A version prefix never changes, so this is the one
  // thing in MAPVIS that is safe to cache forever, and caching it forever is
  // what keeps a class of thirty chromebooks off the free tier's read budget.
  if (sub === 'file') {
    const version = Number(parts[3])
    if (!Number.isFinite(version)) return notFound(res)
    const pub = await publishedMap(slug, version)
    if (!pub) return notFound(res)
    const rel = parts.slice(4).join('/')
    // only what the manifest lists, so this can never be talked into reading a
    // key outside the version it was asked for
    if (!rel || !pub.manifest[rel]) return notFound(res)
    let buf
    try {
      const ck = pub.blob_prefix + rel
      buf = hotGet(ck) || hotPut(ck, await store().get(ck))
    } catch {
      return notFound(res)
    }
    res.setHeader('Content-Type', rel.endsWith('.json') ? 'application/json' : 'image/png')
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.setHeader('Access-Control-Allow-Origin', '*')
    return res.end(buf)
  }

  return send(res, 404, { error: 'no such endpoint' })
}

// /work/<slug>/... is still the url space the editor asks for and still the url
// space saved inside every placement. Where the bytes come from moved; the
// address did not, which is the whole reason 17,000 lines of client did not
// have to change.
/* THE COPY ON THIS MACHINE IS THE FREE ONE, SO ASK FOR IT FIRST.
 *
 * This used to go to the bucket first and fall back to disk, which meant that
 * on the laptop the map was drawn on, where all fourteen hundred of its library
 * files already sit, every open of the editor fetched them out of object
 * storage anyway. A day of ordinary building spent 3,244 download transactions
 * against a free allowance of 2,500 to read files that were on the hard drive
 * the whole time.
 *
 * Disk first inverts that. On a laptop nearly every read is now free and the
 * bucket is touched only for what was made somewhere else. On a host there is
 * no work directory, so it falls straight through and behaves exactly as it did
 * before. Correctness is unchanged either way, because the local file and the
 * stored object are written together by the same save. */
async function serveWork(res, rel, req) {
  const f = path.join(WORK, rel.split('/').map(decodeURIComponent).join(path.sep))
  const onDisk = diskAllowed() && f.startsWith(WORK) && fs.existsSync(f) && !fs.statSync(f).isDirectory()

  if (onDisk) {
    const buf = fs.readFileSync(f)
    // same revalidation the stored path gives, so a browser holding the current
    // bytes gets a 304 instead of the file again
    const etag = '"' + crypto.createHash('sha1').update(buf).digest('base64url') + '"'
    res.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream')
    res.setHeader('ETag', etag)
    res.setHeader('Cache-Control', 'private, no-cache')
    if (req && req.headers['if-none-match'] === etag) {
      res.statusCode = 304
      return res.end()
    }
    return res.end(buf)
  }

  if (platformOn()) {
    try {
      if (await serveFromStore(res, rel, req)) return
    } catch (e) {
      console.error('[work] store read failed:', e.message)
    }
  }
  return notFound(res)
}

// ---- the asset library --------------------------------------------------

const libDirOf = (id) => path.join(WORK, id, 'library')

// a sprite canvas dimension the plan or the gen box asked for, kept sane
const clampPx = (v) => {
  const n = Math.round(Number(v))
  return isFinite(n) && n > 0 ? Math.max(32, Math.min(128, n)) : 96
}

// width and height straight off the png IHDR header, no image library needed
function pngSize(f) {
  try {
    const b = Buffer.alloc(24)
    const fd = fs.openSync(f, 'r')
    fs.readSync(fd, b, 0, 24, 0)
    fs.closeSync(fd)
    return pngSizeBuf(b)
  } catch {
    return { w: 0, h: 0 }
  }
}
function pngSizeBuf(b) {
  try {
    if (b.length < 24 || b.readUInt32BE(12) !== 0x49484452) return { w: 0, h: 0 }
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  } catch {
    return { w: 0, h: 0 }
  }
}

// this map's own assets: every png in work/<id>/library is a static item,
// every folder of 0.png..n.png is an animated one
/* THE FACES A ROW HAS BEEN GIVEN, read back off disk.
 *
 * A state is stored the same three ways a library row is (a png, a folder of
 * frames, a folder of headings) because a state of a walking character is
 * itself eight headings and has to stay that way, or the troll faces south the
 * moment it becomes a boulder. The shape is read off what is actually there
 * rather than off a flag, which is the same rule libraryItems follows below. */
function statesOf(id, owner) {
  const dir = stateDirOf(id, owner)
  if (!fs.existsSync(dir)) return []
  const base = `/work/${id}/states/${encodeURIComponent(cleanName(owner))}`
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.isDirectory()) {
      const dj = path.join(dir, ent.name, 'dirs.json')
      if (fs.existsSync(dj)) {
        try {
          const meta = JSON.parse(fs.readFileSync(dj, 'utf8'))
          const dirs = meta && meta.dirs && typeof meta.dirs === 'object' ? meta.dirs : null
          const first = dirs ? dirs.south || Object.values(dirs)[0] : null
          if (first && first[0]) {
            /* A face keeps its frames one folder deeper than the library does
             * (face/heading/0.png against the library's flat face/heading-0.png)
             * because a character state comes back as whole headings and nesting
             * them is what keeps a heading's frames in order without encoding
             * the order into the filename. So the size is read off the url's own
             * tail rather than off its last segment: taking only the last
             * segment looked for 0.png beside the folder that holds it, and the
             * row came back 0x0, which the editor draws as nothing. */
            const tail = String(first[0]).split('/states/')[1] || ''
            // drop the owner segment: `dir` already points at that folder
            const rel = tail.split('/').slice(1).map((x) => decodeURIComponent(x))
            const { w, h } = rel.length ? pngSize(path.join(dir, ...rel)) : { w: 0, h: 0 }
            out.push({
              name: ent.name,
              dirs,
              fps: Number(meta.fps) > 0 ? Math.round(Number(meta.fps)) : 8,
              src: first[0],
              w,
              h,
            })
            continue
          }
        } catch {
          /* unreadable: fall through and read it as frames */
        }
      }
      const frames = []
      for (let i = 0; fs.existsSync(path.join(dir, ent.name, i + '.png')); i++)
        frames.push(`${base}/${ent.name}/${i}.png`)
      if (!frames.length) continue
      const { w, h } = pngSize(path.join(dir, ent.name, '0.png'))
      out.push({ name: ent.name, frames, fps: 6, w, h })
    } else if (/\.png$/i.test(ent.name)) {
      const { w, h } = pngSize(path.join(dir, ent.name))
      out.push({ name: ent.name.replace(/\.png$/i, ''), src: `${base}/${ent.name}`, w, h })
    }
  }
  return out
}

function libraryItems(id) {
  const dir = libDirOf(id)
  if (!fs.existsSync(dir)) return []
  const base = `/work/${id}/library`
  const items = []
  const ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const ent of ents) {
    if (ent.isDirectory()) {
      // a folder of ROTATIONS rather than a folder of frames: one view per
      // direction, named for the heading it faces. dirs.json is what says so.
      const dj = path.join(dir, ent.name, 'dirs.json')
      if (fs.existsSync(dj)) {
        try {
          const meta = JSON.parse(fs.readFileSync(dj, 'utf8'))
          const dirs = meta && meta.dirs && typeof meta.dirs === 'object' ? meta.dirs : null
          const first = dirs ? dirs.south || Object.values(dirs)[0] : null
          if (first && first[0]) {
            const rel = String(first[0]).split('/').pop()
            const { w, h } = pngSize(path.join(dir, ent.name, rel))
            // a walking character has frames inside each heading, so it needs a
            // rate the same way an animated item does
            const fps = Number(meta.fps) > 0 ? Math.round(Number(meta.fps)) : 8
            // a walker's character id was pinned into dirs.json by the motion
            // lane long before origin.json existed, and it is the same handle
            // a second face is made from, so it counts as an origin too
            const row = { name: ent.name, kind: 'static', dirs, fps, src: first[0], w, h }
            if (meta.characterId) row.canState = true
            items.push(row)
            continue
          }
        } catch {
          /* unreadable: fall through and treat it as a frame folder */
        }
      }
      const frames = []
      for (let i = 0; fs.existsSync(path.join(dir, ent.name, i + '.png')); i++)
        frames.push(`${base}/${ent.name}/${i}.png`)
      if (!frames.length) continue
      const { w, h } = pngSize(path.join(dir, ent.name, '0.png'))
      // an effect folder carries its own playback rate beside the frames, so
      // the speed a human tuned survives a reload; anything else plays at 6.
      // The same file is what makes an item reopenable in the tuning panel, so
      // its presence rides along as a flag.
      let fps = 6
      let effect = false
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, ent.name, 'effect.json'), 'utf8'))
        if (Number(meta.fps) > 0) fps = Math.round(Number(meta.fps))
        effect = true
      } catch {
        /* not an effect, or no metadata: the default rate stands */
      }
      items.push({ name: ent.name, kind: 'animated', effect, frames, fps, w, h })
    } else if (/\.png$/i.test(ent.name)) {
      const { w, h } = pngSize(path.join(dir, ent.name))
      items.push({ name: ent.name.replace(/\.png$/i, ''), kind: 'static', src: `${base}/${ent.name}`, w, h })
    }
  }
  /* Faces and origin hang off the row they belong to, so the client never has
   * to ask a second time and a state never appears as a row of its own. `from`
   * is what the second-face button turns on: without an id there is nothing to
   * edit, and the button says so instead of failing at spend time. */
  const origin = readOrigin(id)
  for (const it of items) {
    const o = origin[it.name]
    const st = statesOf(id, it.name)
    if (st.length) it.states = st
    if (o && (o.objectId || o.characterId)) it.canState = true
  }
  return items
}

// ---- what the account already owns --------------------------------------

// the whole listing, walked once and held. Seven calls for 700 objects is too
// many to repeat on every keystroke of a search box, and the list only changes
// when something is generated, so five minutes is plenty. The refresh flag
// drops it for anyone who just made one.
const ACCT_TTL = 5 * 60 * 1000
let acct = { at: 0, list: [] }

async function accountObjects(refresh) {
  if (!refresh && acct.list.length && Date.now() - acct.at < ACCT_TTL) return acct.list
  const raw = await pixellab.allObjects()
  const list = raw
    .filter((o) => o && o.id && o.preview_url && String(o.status || 'completed') === 'completed')
    .map((o) => ({
      id: String(o.id),
      // pixellab cuts its own names at 30 characters, so a nameless one falls
      // back to the front of its prompt rather than showing an id
      name: String(o.name || o.prompt || 'object').slice(0, 40),
      prompt: String(o.prompt || '').slice(0, 400),
      w: Number((o.size || {}).width) || 0,
      h: Number((o.size || {}).height) || 0,
      thumb: String(o.preview_url),
    }))
  acct = { at: Date.now(), list }
  return list
}

/* The character listing, held the same way and for the same reason: free but
 * paged, and it only changes when something is generated.
 *
 * This one is kept RAW rather than mapped down, because two callers want
 * different things off it. The picker wants a name and a thumbnail; the
 * re-animate router wants the untouched name to match against asks.json, and
 * the canvas size, because the animation is priced per direction by pixel
 * budget and a 68px character at sixteen frames is not the same bill as a 48px
 * one at eight. */
let chars = { at: 0, list: [] }

async function accountCharacters(refresh) {
  if (!refresh && chars.list.length && Date.now() - chars.at < ACCT_TTL) return chars.list
  const list = await pixellab.allCharacters()
  chars = { at: Date.now(), list }
  return list
}

// where a listed object's png actually lives. A 1-direction object has every
// rotation url null and the file under storage_urls.unknown; a 4 or 8
// direction one has south. Anything under storage_urls will do as a last try.
function objectImageURL(d) {
  const st = d && typeof d.storage_urls === 'object' && d.storage_urls ? d.storage_urls : {}
  const rot = d && typeof d.rotation_urls === 'object' && d.rotation_urls ? d.rotation_urls : {}
  const tries = [st.unknown, rot.south, rot['south-east'], rot.east, ...Object.values(st)]
  for (const u of tries) if (typeof u === 'string' && /^https?:\/\//.test(u)) return u
  return ''
}

// An asset url the editor holds (/work/<id>/library/x.png, a reopened
// bundle's /work/<id>/assets/x.png, or a legacy /library/x.png) resolved to a
// real file, held inside work/ or public/library so no url can walk out.
function resolveAssetFile(u, sceneDir) {
  const parts = String(u)
    .split('?')[0]
    .replace(/^\//, '')
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
  let f
  if (parts[0] === 'work') f = path.join(WORK, ...parts.slice(1))
  else if (parts[0] === 'library') f = path.join(PUBLIB, ...parts.slice(1))
  else f = path.join(sceneDir, 'library', parts[parts.length - 1])
  const abs = path.resolve(f)
  const inside = (root) => abs === root || abs.startsWith(root + path.sep)
  if (!inside(WORK) && !inside(PUBLIB)) return null
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null
}

/* What the PERSON actually typed, kept beside the map it was typed for.
 *
 * The raw ask used to be used for the filename and then thrown away, so the
 * only trace of "Palm island beach tree. dark green" was the four-word slug in
 * the library. Every asset now leaves a line here: the words, the prompt they
 * became, and when. It is a record first, and the raw material for matching a
 * person's taste on later asks second. Newest first, last 40 kept. */
/* An object's rotations, written into a map's library as one folder keyed by
 * heading. Shared by the account import and by an eight-direction generation,
 * because both end up holding the same thing: a set of views that has to land
 * on disk the way the library reads it. */
async function saveRotations(id, detail, wantName) {
  const rot = detail && detail.rotation_urls && typeof detail.rotation_urls === 'object' ? detail.rotation_urls : null
  const DIRS = ['south', 'north', 'east', 'west', 'south-east', 'north-east', 'north-west', 'south-west']
  const got = rot ? DIRS.filter((k) => typeof rot[k] === 'string' && rot[k]) : []
  if (got.length < 4) return null
  const dir = libDirOf(id)
  fs.mkdirSync(dir, { recursive: true })
  const base = cleanName(wantName || detail.name || detail.prompt || 'object')
  /* THE DATABASE ANSWERS TOO, not the disk alone.
   *
   * The suffix walk this replaced only ever looked at libDirOf(id). On a host
   * that folder is a tmp dir that starts empty on every request, so every import
   * picked the base name and wrote over the library row already sitting under
   * it, taking that row's objects with it. saveStatic has been going through
   * freeLibraryName for exactly this reason and these two were left behind. */
  const name = await freeLibraryName(id, base)
  const folder = path.join(dir, name)
  // the folder is claimed the moment the name is picked, the way saveFrames has
  // always claimed its own. Two of these running at once could otherwise both
  // look, both find nothing, and both take it.
  fs.mkdirSync(folder, { recursive: true })
  return { name, dir: folder, urls: got.map((k) => [k, rot[k]]) }
}

/* The same plan for a set that has FRAMES INSIDE each heading, which is what a
 * walk cycle is. byDir is heading -> urls in play order.
 *
 * The folder is made here rather than in the writer, so the name is reserved the
 * moment it is picked: two of these running at once could otherwise both look,
 * both see nothing, and both choose it. */
async function saveFrames(id, byDir, wantName, fps, characterId) {
  const keys = Object.keys(byDir || {}).filter((k) => k && Array.isArray(byDir[k]) && byDir[k].length)
  if (keys.length < 4) return null
  const dir = libDirOf(id)
  fs.mkdirSync(dir, { recursive: true })
  const base = cleanName(wantName || 'someone')
  // disk for what is mid-request, the database for what exists at all. See the
  // note on saveRotations: the disk-only walk overwrote a live library row on a
  // host, and a character takes its objects down with it.
  const name = await freeLibraryName(id, base)
  const plan = { name, dir: path.join(dir, name), urls: keys.map((k) => [k, byDir[k]]), frames: true, fps, characterId }
  fs.mkdirSync(plan.dir, { recursive: true })
  return plan
}

async function writeRotations(id, plan) {
  fs.mkdirSync(plan.dir, { recursive: true })
  const dirs = {}
  let w0 = 0
  let h0 = 0
  for (const [k, u] of plan.urls) {
    const urls = Array.isArray(u) ? u : [u]
    const rel = []
    for (let i = 0; i < urls.length; i++) {
      const buf = await pixellab.fetchPNG(urls[i])
      const sk = pngSizeBuf(buf)
      if (!(sk.w > 0)) continue
      // a still set keeps <heading>.png, the name the object import has always
      // written. A walking one carries the frame index, which is the flat name
      // the export's folder handling and the game already read.
      const fname = plan.frames ? `${k}-${i}.png` : `${k}.png`
      fs.writeFileSync(path.join(plan.dir, fname), buf)
      rel.push(`/work/${id}/library/${plan.name}/${fname}`)
      if (!w0) {
        w0 = sk.w
        h0 = sk.h
      }
    }
    if (rel.length) dirs[k] = rel
  }
  if (Object.keys(dirs).length < 4) return null
  // a still object has no rate to keep, and writing one would say it plays
  const meta = plan.fps > 0 ? { dirs, fps: plan.fps } : { dirs }
  /* WHICH CHARACTER ON THE ACCOUNT DREW THIS, written down beside the art.
   *
   * Without it the only way back to the rig is matching the four-word folder
   * name against a description asks.json may already have forgotten, and only
   * that rig can be given a motion that stays in register across every heading.
   * dirs.json has always been read for dirs and fps and nothing else, so an
   * extra key costs nothing anywhere. */
  if (plan.characterId) meta.characterId = String(plan.characterId)
  fs.writeFileSync(path.join(plan.dir, 'dirs.json'), JSON.stringify(meta, null, 2))
  return {
    name: plan.name,
    kind: 'static',
    dirs,
    ...(plan.fps > 0 ? { fps: plan.fps } : {}),
    src: dirs.south ? dirs.south[0] : Object.values(dirs)[0][0],
    w: w0,
    h: h0,
  }
}

/* ---- making something that already exists move --------------------------
 *
 * Everything below serves /api/asset-animate. It is written apart from the
 * generate routes because it never makes a new library row: it replaces the
 * pixels of one that is already there, and staying one row per thing is half
 * the point.
 */

/* One library row, read off disk. libraryItems answers the same three shapes
 * for the whole folder at once; this answers for one, and keeps the things only
 * a re-animate cares about: where the files are, and what dirs.json says beyond
 * dirs and fps. */
function readLibItem(id, name) {
  const dir = path.resolve(libDirOf(id))
  const folder = path.resolve(dir, name)
  if (!folder.startsWith(dir + path.sep)) return null
  const png = folder + '.png'
  if (fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
    let meta = null
    try {
      meta = JSON.parse(fs.readFileSync(path.join(folder, 'dirs.json'), 'utf8'))
    } catch {
      /* no dirs.json, or an unreadable one: it is a folder of frames */
    }
    const dirs = meta && meta.dirs && typeof meta.dirs === 'object' ? meta.dirs : null
    const heads = dirs ? Object.keys(dirs).filter((k) => Array.isArray(dirs[k]) && dirs[k].length) : []
    if (heads.length) {
      const fps = Number(meta.fps) > 0 ? Math.round(Number(meta.fps)) : 8
      // a view set is kind static whether it moves or not, so the only test for
      // "does this already play" is whether a heading holds more than one frame
      return { id, name, shape: 'views', folder, dirs, heads, meta, fps, plays: dirs[heads[0]].length > 1 }
    }
    const frames = []
    for (let i = 0; fs.existsSync(path.join(folder, i + '.png')); i++) frames.push(i + '.png')
    if (!frames.length) return null
    return { id, name, shape: 'frames', folder, frames, plays: frames.length > 1, effect: fs.existsSync(path.join(folder, 'effect.json')) }
  }
  if (fs.existsSync(png)) {
    const { w, h } = pngSize(png)
    return { id, name, shape: 'still', file: png, w, h, plays: false }
  }
  return null
}

// 4 to 16 and even, the bounds /v2/animate-character enforces. The single-image
// animator is happy anywhere in that range too, so one clamp serves both.
const evenFrames = (v) => {
  const n = Math.max(4, Math.min(16, Math.round(Number(v) || 8)))
  return n % 2 ? n + 1 : n
}

// what the two animators bill. /v2/animate-with-text-v3 gets 524288 pixels to a
// generation across the whole take; /v2/animate-character gets 65536 per
// direction, which is why one direction of a 48px character is one generation
// and a 96px one at sixteen frames is three.
const IMG_BUDGET = 524288
const CHAR_BUDGET = 65536
const priceOf = (w, h, frames, budget) => Math.max(1, Math.ceil((w * h * frames) / budget))

/* Room for the motion to swing through.
 *
 * Everything in this library has been trimmed to its own pixels, by trimSet on
 * the way in or by ctrl+T afterwards, so a sprite handed straight to the
 * animator has no margin at all. A fisherman told to cast a rod has nowhere to
 * put the rod and it comes back clipped at the edge of the frame. So the first
 * frame goes into a bigger canvas before it is sent, and the whole loop is
 * trimmed back to one shared box afterwards, which leaves the item exactly as
 * tight as its own motion needs.
 *
 * 40 percent is pixellab's own headroom, the ratio their character pipeline
 * pads by: a 48px character lands on a 68px canvas. It is reasoned from that
 * number, not measured here. */
const ANIM_PAD = 0.4

// the size the animator is actually handed, and whether it is worth padding.
// Padding that pushes the take into a second generation is not worth the
// headroom, so the price the button showed stays the price.
function padPlan(w, h, frames) {
  const pw = w + Math.round(w * ANIM_PAD) * 2
  const ph = h + Math.round(h * ANIM_PAD) * 2
  if (!(w > 0) || !(h > 0)) return { w: w || 0, h: h || 0, pad: false }
  if (priceOf(pw, ph, frames, IMG_BUDGET) > priceOf(w, h, frames, IMG_BUDGET)) return { w, h, pad: false }
  return { w: pw, h: ph, pad: true }
}

function padPNG(buf) {
  let im
  try {
    im = decodePNG(buf)
  } catch {
    return buf // unreadable here is still readable to them; send it as it is
  }
  const gx = Math.round(im.w * ANIM_PAD)
  const gy = Math.round(im.h * ANIM_PAD)
  const w = im.w + gx * 2
  const h = im.h + gy * 2
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < im.h; y++)
    out.set(im.data.subarray(y * im.w * 4, (y + 1) * im.w * 4), ((y + gy) * w + gx) * 4)
  return encodePNG(w, h, out)
}

/* The one question the router asks, and it is not "which animation".
 *
 * Both pixellab animators redraw a sprite where it stands. Neither can carry it
 * anywhere: travel is life's job in the editor, or a written recipe that stamps
 * the sprite at a position it computes. So the whole decision is whether these
 * words need the DRAWING to change or the THING to move, and the same pass
 * rewrites the ask into the motion words the animator is actually given, the
 * way translateAsk rewrites an ask for the image generator.
 *
 * Nothing here is a list. The planner is told what the two mediums can do and
 * answers in the person's own terms. On any failure the words go through
 * unchanged as a redraw, so the box can never dead-end and the confirm press
 * still shows the price before anything is spent. */
async function animateAsk(it, ask, id, job) {
  const shape =
    it.shape === 'views'
      ? `a figure drawn from ${it.heads.length} headings` + (it.plays ? ', which already has a motion on it' : '')
      : it.plays
        ? 'one sprite that already has frames'
        : 'one still sprite'
  const fb = { move: false, motion: ask.slice(0, 300), frames: 8, note: '' }
  try {
    const raw = await runPlanner(
      `Decide how a pixel-art sprite that ALREADY EXISTS should be made to move, and write the ` +
        `motion words for it. Nothing is drawn from scratch: the sprite is there and this is only ` +
        `about what it does.\n\n` +
        `The sprite: ${shape}, called "${it.name}".\n` +
        `What was asked for, in the person's own words: "${ask}"\n\n` +
        `TWO MEDIUMS, and the only question is which one these words need.\n` +
        `redraw: the drawing itself changes where it stands. Breathing, a head turning, a rod ` +
        `casting and reeling in, cloth lifting, a wheel turning on the spot, weight shifting from ` +
        `foot to foot. The sprite is redrawn frame by frame and never leaves its own footprint.\n` +
        `move: the sprite has to TRAVEL, or trace a path over the ground, or scatter, circle, dart ` +
        `off and come back. Redrawing cannot do this at all. Asked to walk somewhere it gives a ` +
        `figure marching on the spot, which is the wrong picture and it costs money.\n\n` +
        `When the words are about the BODY, answer move false. When they are about where the thing ` +
        `GOES, answer move true. If both are asked for at once the body wins: the going is added ` +
        `separately, in the editor, and it is free.\n\n` +
        `motion: the ask rewritten as one plain present-tense line of what the body does. Under ` +
        `200 characters, no scenery, no place names, no other creatures. The animator draws every ` +
        `noun it hears, so name only this thing and what it does with itself.\n` +
        `frames: 4, 6, 8, 12 or 16. A small slow idle takes fewer, a whole gesture takes more.\n` +
        `note: one short lowercase line saying what it will look like.\n\n` +
        `Answer with ONLY this JSON, no prose.\n` +
        `{"move":false,"motion":"breathes slowly, shoulders rising and settling, head drifting",` +
        `"frames":8,"note":"a standing idle"}`,
      60000,
      job,
    )
    const o = planJSON(raw, 'motion')
    if (!o) return fb
    const motion = String(o.motion || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    return {
      move: o.move === true,
      motion: motion || fb.motion,
      frames: evenFrames(o.frames),
      note: String(o.note || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    }
  } catch (e) {
    // a stop is the person changing their mind and travels up; anything else is
    // the planner, and the raw words are a good enough answer to route on
    if (String((e && e.message) || e) === 'stopped') throw e
    return fb
  }
}

/* Which path, and what it costs, worked out before anything is spent.
 *
 * The motion words are asked for once. On the confirm press the client hands
 * back the plan it was shown and only the price is re-derived, from the item on
 * disk and the account, so a client cannot talk the price down and the router
 * cannot talk it up. */
async function animatePlan(it, ask, id, job, b) {
  const had = b.plan && typeof b.plan === 'object' ? b.plan : null
  const said = had
    ? {
        move: had.move === true,
        motion: String(had.motion || ask).replace(/\s+/g, ' ').trim().slice(0, 300) || ask.slice(0, 300),
        frames: evenFrames(had.frames),
        note: String(had.note || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      }
    : await animateAsk(it, ask, id, job)
  const base = { ...said, name: it.name, shape: it.shape }

  // travel is free and neither generator can do it, so it is named and handed
  // back rather than charged for. The client opens the effect box on this item
  // instead, with its own sprite in the recipe's hands.
  if (said.move)
    return {
      ...base,
      path: 'written',
      price: 0,
      sprite: true,
      note: said.note || 'this one has to travel, so it is a written recipe and costs nothing',
    }

  if (it.shape !== 'views') {
    const src = it.shape === 'still' ? it : pngSize(path.join(it.folder, it.frames[0]))
    const fit = padPlan(src.w || 0, src.h || 0, said.frames)
    return { ...base, path: 'sprite', price: priceOf(fit.w, fit.h, said.frames, IMG_BUDGET), pad: fit.pad }
  }

  /* REGISTRATION IS NOT NEGOTIABLE.
   *
   * The single-image animator would happily take each heading in turn, and the
   * eight loops that came back would drift against each other: the figure would
   * breathe on a different rhythm facing north than facing south. So a figure
   * with headings goes through the coordinated endpoint or it does not go, and
   * that endpoint needs the character id. */
  const who = await characterFor(it, b.characterId)
  if (!who.id) return { ...base, path: 'blocked', price: 0, why: who.why }
  noteCharacterId(it, who.id)
  const per = priceOf(who.w, who.h, said.frames, CHAR_BUDGET)
  /* WHICH HEADINGS TO PAY FOR.
   *
   * Every heading is drawn for free when the character is created; animation is
   * the thing priced per direction. A walker turns as it goes and needs all of
   * them. Someone standing at a stall is placed facing one way and never turns,
   * so paying for eight breathing loops buys seven nobody will ever see.
   *
   * A heading left out keeps its single still frame, and both renderers index a
   * heading's own list, so a set that is animated on three headings and still on
   * five is a legal thing rather than a broken one. */
  const want = Array.isArray(b.headings)
    ? it.heads.filter((k) => b.headings.map((h) => String(h).toLowerCase().trim()).includes(k))
    : it.heads
  const heads = want.length ? want : it.heads
  return {
    ...base,
    path: 'character',
    headings: heads,
    characterId: who.id,
    found: who.from,
    price: per * heads.length,
  }
}

/* WHICH CHARACTER ON THE ACCOUNT THIS FOLDER WAS DRAWN FROM.
 *
 * MAPVIS never wrote it down. dirs.json held dirs and fps and nothing else, so
 * every person in the hub library is art with no way back to the rig that drew
 * it, and the one endpoint that keeps eight headings in register takes an id.
 *
 * The account listing is free, so the id is recovered rather than regenerated.
 * What it CANNOT be recovered by is the folder name: the folder is a four-word
 * slug of the ask and the account row is named with the whole description,
 * because createCharacter sends no name at all. Measured 2026-08-23 against all
 * nine people in the hub library: not one folder name is a substring of any
 * account name, so name-to-name matching returns nothing every single time.
 *
 * The bridge is asks.json, which noteAsk writes at generation time and which
 * holds the folder name beside the exact description that was sent. That string
 * is byte-identical to the account row's name. Verified against all nine.
 *
 * It is a RESCUE, not a mechanism. asks.json keeps forty entries, so an old
 * item falls off the record and can never be matched again, and an imported
 * character was never in it. The id is written into dirs.json the moment it is
 * found, and every route that makes or imports a character writes it there now,
 * so this runs once per item and then never. */
async function characterFor(it, given) {
  const looksId = (s) => /^[a-f0-9-]{16,64}$/i.test(String(s || ''))
  let list
  try {
    list = await accountCharacters()
  } catch (e) {
    return { why: 'the account listing did not answer, so the character behind this one cannot be found · ' + String((e && e.message) || e).slice(0, 120) }
  }
  const sized = (row) => ({
    id: String(row.id),
    w: (row.size && Number(row.size.width)) || 48,
    h: (row.size && Number(row.size.height)) || 48,
  })
  // an id the client pinned, or one already written down beside the art
  const pinned = looksId(given) ? String(given) : it.meta && looksId(it.meta.characterId) ? String(it.meta.characterId) : ''
  if (pinned) {
    const row = list.find((c) => String(c.id) === pinned)
    // a character deleted on their side would 422 after the price had been
    // shown, and finding that out here costs nothing
    if (row) return { ...sized(row), from: looksId(given) ? 'asked' : 'dirs' }
    /* Absent from the listing is not the same as gone. The listing is a page of
     * what existed when it was read, so a character made a minute ago is not on
     * it yet, and three of the hub's people were called deleted while their art
     * sat on disk beside the id that drew it. Ask about the one id directly,
     * which is free and authoritative. */
    try {
      const d = await pixellab.characterDetail(pinned)
      const rot = (d && d.rotation_urls) || {}
      if (Object.keys(rot).length) {
        const s = (d && d.size) || {}
        return { id: pinned, w: Number(s.width) || 48, h: Number(s.height) || 48, from: 'detail' }
      }
    } catch {
      /* falls through to the honest answer below */
    }
    return { why: 'the character this was drawn from is no longer on the account' }
  }
  const asks = readAsks(it.id).filter((a) => a && a.kind === 'character' && a.prompt)
  const mine = asks.filter((a) => cleanName(a.name || '') === it.name)
  if (!mine.length)
    return { why: 'nothing on record says which character on the account drew this, so its headings cannot be animated together' }
  const want = String(mine[0].prompt)
  let hits = list.filter((c) => String(c.name || '') === want)
  // asks.json slices the description at 1200 characters and their side keeps it
  // whole, so a long one only ever agrees at its start
  if (!hits.length) hits = list.filter((c) => String(c.name || '').startsWith(want) || want.startsWith(String(c.name || '')))
  if (!hits.length) return { why: 'no character on the account matches what this one was asked for' }
  if (hits.length === 1) return { ...sized(hits[0]), from: 'asks' }
  /* Two takes of one description are two account rows with the same name, and
   * the name alone cannot tell them apart. Both lists run newest first, so the
   * nth folder made from these words is the nth row by age. */
  const same = asks.filter((a) => String(a.prompt) === want)
  const rank = same.findIndex((a) => cleanName(a.name || '') === it.name)
  const byAge = [...hits].sort((a, c) => String(c.created_at || '').localeCompare(String(a.created_at || '')))
  return { ...sized(byAge[rank > 0 ? Math.min(rank, byAge.length - 1) : 0]), from: 'asks' }
}

// the id, written down where the art lives, so the match above runs once. Free
// and idempotent, and it happens on the price read, before anything is spent.
function noteCharacterId(it, cid) {
  if (!it || it.shape !== 'views' || !cid || (it.meta && it.meta.characterId === cid)) return
  try {
    const meta = { ...(it.meta || {}), characterId: cid }
    fs.writeFileSync(path.join(it.folder, 'dirs.json'), JSON.stringify(meta, null, 2))
    it.meta = meta
  } catch {
    /* it is recoverable again next time; not worth failing a free read over */
  }
}

/* EVERY FRAME URL THE CHARACTER ALREADY CARRIES.
 *
 * This is how the motion just paid for is told from the one that was already
 * there, and it is urls rather than group names or ids because of what a live
 * read actually answers: measured 2026-08-23, an animation group comes back
 * with g.id undefined, display_name null and only animation_type carrying the
 * template's name. There is no id to compare and the position in the list moves
 * when a group is added. The frame urls are path-based, unsigned and identical
 * across two reads, so they are the one thing that means the same both times. */
const frameSet = (d) => {
  const out = new Set()
  for (const g of Array.isArray(d && d.animations) ? d.animations : [])
    for (const dd of Array.isArray(g.directions) ? g.directions : [])
      for (const u of Array.isArray(dd.frames) ? dd.frames : []) if (u) out.add(u)
  return out
}

/* EVERY HEADING IN ONE JOB.
 *
 * The two free reads around the spend are what make replacing an existing
 * motion safe. Before: every frame the character already carries. After: the
 * frames that were not there. Without the first read a walker re-animated a
 * second time reads back whichever group the api lists first, which is the old
 * walk, and the item gets overwritten with the motion it already had. */
async function runCharacterMotion(plan, seed, gate, halt) {
  halt()
  let d = await raceStop(gate, pixellab.characterDetail(plan.characterId))
  const before = frameSet(d)
  const rot = d.rotation_urls && typeof d.rotation_urls === 'object' ? d.rotation_urls : {}
  // only headings the character actually has: naming one it does not is a
  // generation asked for and thrown away
  /* Two different questions, and conflating them broke every stander.
   *
   * Whether the CHARACTER is usable is about how many rotations it has, and
   * under four it is not a view set at all. How many to ANIMATE is a separate
   * choice: someone standing at a stall is placed facing one way, so paying for
   * eight breathing loops buys seven nobody sees. Asking for three used to trip
   * the usability guard and fail the whole job. */
  const has = Object.keys(rot).filter((k) => typeof rot[k] === 'string' && rot[k])
  if (has.length < 4) throw new Error('the character on the account has fewer than four headings, so nothing was asked for')
  // only headings it actually has: naming one it does not is a generation asked
  // for and thrown away
  const heads = plan.headings.filter((k) => has.includes(k))
  if (!heads.length) throw new Error('none of the headings asked for are on this character')
  /* A name nothing else on it carries, so the frames that come back are
   * unmistakably the ones just paid for. Reusing a name leaves two groups
   * called the same thing and the reader takes whichever it meets first. */
  const group = 'motion-' + Date.now().toString(36)
  halt()
  const h = await pixellab.animateCharacterAction({
    characterId: plan.characterId,
    action: plan.motion,
    frameCount: plan.frames,
    directions: heads,
    name: group,
    seed,
  })
  // the wait is told what was already there for the same reason: without it, a
  // character that already moves reports finished on the first tick
  d = await raceStop(gate, pixellab.awaitAnimation(plan.characterId, h, { timeoutMs: WALK_WAIT, known: before }))
  let byDir = newGroupDirs(d, group, before, heads, rot)
  /* The job can report finished a moment before the detail lists the group it
   * made. That happened on the hub's two knights: the frames were on their side,
   * named and complete, and the reading taken at the same instant still showed
   * no groups at all, so a paid motion was thrown away as unrecognisable. Read
   * again a few times before believing it. The frames are already bought, so
   * the only thing patience costs here is seconds. */
  for (let tries = 0; !byDir && tries < 5; tries++) {
    await new Promise((r) => setTimeout(r, 4000))
    halt()
    d = await raceStop(gate, pixellab.characterDetail(plan.characterId))
    byDir = newGroupDirs(d, group, before, heads, rot)
  }
  /* And when the name-and-freshness reading still cannot see it, fall to the
   * one that can. Measured over eleven animations: the reading above failed
   * every single time and this lookup succeeded every single time, so leaving
   * the strict test in front as the error a person meets was making them press
   * twice for something already bought and sitting on the account.
   *
   * It is not a guess. It takes the newest group whose frames are not the
   * rotation stills, which is the motion just paid for, and refuses outright
   * when nothing on the character is moving. */
  if (!byDir) {
    const found = await recoverCharacterMotion(plan)
    if (found) return found.byDir
  }
  // refusing here costs the generations and keeps the item. Guessing would
  // write the OLD motion over it and call the result the new one.
  if (!byDir) throw new Error('the frames that came back could not be told from the motion it already had, so nothing was replaced')
  return withStills(byDir, rot)
}

/* A partial motion, put back into a whole set.
 *
 * stageViews rebuilds the folder from what it is handed, so handing it the three
 * headings that were animated would delete the five that were not. Every heading
 * the character has comes back, the animated ones as their new frames and the
 * rest as the single rotation still they already were. Both renderers index a
 * heading's own list, so eight frames on three of them and one on five is a
 * legal set rather than a broken one. */
function withStills(byDir, rot) {
  const out = { ...byDir }
  for (const [k, u] of Object.entries(rot || {})) {
    const key = String(k).toLowerCase()
    if (!out[key] && typeof u === 'string' && u) out[key] = [u]
  }
  return out
}

/* Frames already paid for, pulled without buying them again.
 *
 * A motion that landed on their side but could not be read back here is bought
 * and sitting there. Re-running the ask would charge for it twice, so this finds
 * the newest group that is not a rotation and hands back its frames. Free, and
 * the reason it exists is that the reading above was once wrong. */
async function recoverCharacterMotion(plan) {
  const d = await pixellab.characterDetail(plan.characterId)
  const rot = (d && d.rotation_urls) || {}
  const rotSet = new Set(Object.values(rot).filter((u) => typeof u === 'string'))
  const groups = Array.isArray(d && d.animations) ? d.animations : []
  const wanted = new Set(plan.headings || [])
  let best = null
  for (const g of groups) {
    const byDir = {}
    for (const dd of Array.isArray(g.directions) ? g.directions : []) {
      const k = String(dd.direction || '').toLowerCase()
      const frames = (Array.isArray(dd.frames) ? dd.frames : []).filter(Boolean)
      // a heading whose whole set is the rotation still is not a motion
      if (k && frames.length > 1 && !frames.every((u) => rotSet.has(u))) byDir[k] = frames
    }
    const hit = Object.keys(byDir).filter((k) => wanted.has(k)).length
    if (Object.keys(byDir).length && (!best || hit > best.hit))
      best = { byDir: withStills(byDir, rot), hit, moves: Object.keys(byDir).length, name: g.display_name || g.animation_type }
  }
  /* withStills fills every heading that did not move with its own still, so a
   * group that turned out to hold nothing but rotations comes back looking like
   * a complete set of eight. Recovering that writes stills over the art and
   * reports success, which is how the fishmonger lost his motion AND the id that
   * could have got it back. Nothing moving is a failure, not a result. */
  return best && best.moves ? best : null
}

/* The frames of the group just paid for, by heading.
 *
 * Two readings and both have to agree that the frames are new. The name is the
 * first try, for when the api echoes it back. Frames that were not on the
 * character before is the second, and it is the one that always works. A
 * heading whose every frame was already there is dropped whichever way it was
 * found, so an old motion can never be written back over a new one. */
function newGroupDirs(detail, group, before, heads, rot) {
  const groups = Array.isArray(detail && detail.animations) ? detail.animations : []
  const named = (s) => String(s || '').toLowerCase() === group.toLowerCase()
  const fresh = (dd) => (Array.isArray(dd.frames) ? dd.frames.filter(Boolean) : []).some((u) => !before.has(u))
  let pick = groups.filter((g) => named(g.animation_type) || named(g.display_name) || named(g.animation_name))
  if (!pick.some((g) => (g.directions || []).some(fresh))) pick = groups
  const byDir = {}
  for (const g of pick)
    for (const dd of Array.isArray(g.directions) ? g.directions : []) {
      const k = String(dd.direction || '').toLowerCase()
      const frames = Array.isArray(dd.frames) ? dd.frames.filter(Boolean) : []
      if (k && frames.length && fresh(dd) && !byDir[k]) byDir[k] = frames
    }
  /* Nothing new anywhere means the motion never landed, and this is the one
   * place that must not be forgiving. Falling through to the rotations below
   * would fill all eight headings with stills and write statues over a walk
   * cycle, and the reply would call it a success. */
  if (!Object.keys(byDir).length) return null
  // a heading the motion missed keeps its still rotation rather than vanishing.
  // It stands there facing the right way while the others move, which is what
  // the whole library looked like an hour ago.
  for (const k of heads) if (!byDir[k] && rot[k]) byDir[k] = [rot[k]]
  return Object.keys(byDir).length >= 4 ? byDir : null
}

/* THE NEW BYTES LAND SOMEWHERE ELSE FIRST.
 *
 * Eight headings of eight frames is sixty-four downloads and any one of them
 * can fail. Writing them straight into the library would leave a figure that is
 * half its old motion and half its new one, which is worse than either. So
 * everything is fetched, written and trimmed under work/<id>/.stage, and the
 * library folder is only touched once there is nothing left that can fail.
 *
 * .stage sits beside .prev, outside the library, so neither is ever listed as
 * an item. */
const stageDirOf = (id) => path.join(WORK, safeId(id), '.stage')

async function stageViews(id, name, byDir, fps) {
  const stage = path.join(stageDirOf(id), name)
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })
  const dirs = {}
  let w0 = 0
  let h0 = 0
  for (const [k, urls] of Object.entries(byDir)) {
    const rel = []
    for (let i = 0; i < urls.length; i++) {
      const buf = await pixellab.fetchPNG(urls[i])
      const sz = pngSizeBuf(buf)
      if (!(sz.w > 0)) continue
      // the same names writeRotations writes, so an item that gains frames per
      // heading renames none of the files it already had
      const f = `${k}-${i}.png`
      fs.writeFileSync(path.join(stage, f), buf)
      rel.push(`/work/${id}/library/${name}/${f}`)
      if (!w0) {
        w0 = sz.w
        h0 = sz.h
      }
    }
    if (rel.length) dirs[k] = rel
  }
  if (Object.keys(dirs).length < 4) {
    fs.rmSync(stage, { recursive: true, force: true })
    return null
  }
  // the same one-box trim a generation gets. pixellab pads the canvas about 40%
  // for the motion to swing through and that margin is what makes a figure
  // float above the ground.
  const box = trimSet(stage, dirs)
  return { stage, dirs, fps, w: box ? box.w : w0, h: box ? box.h : h0 }
}

function stageFrames(id, name, frames) {
  const stage = path.join(stageDirOf(id), name)
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })
  const rel = []
  for (let i = 0; i < frames.length; i++) {
    fs.writeFileSync(path.join(stage, i + '.png'), Buffer.from(frames[i], 'base64'))
    rel.push(`/work/${id}/library/${name}/${i}.png`)
  }
  // the padding put on for the swing comes back off, against ONE box for the
  // whole loop. A box per frame would move the sprite a pixel each frame and
  // the thing would jitter where it stands.
  const box = trimSet(stage, { all: rel })
  const sz = box || pngSize(path.join(stage, '0.png'))
  return { stage, frames: rel, w: sz.w, h: sz.h }
}

/* .PREV KEEPS THE ORIGINAL, NOT THE LAST THING THAT HAPPENED TO BE THERE.
 *
 * It used to be one slot per name, copied over on every edit. Two in-place
 * edits therefore rolled the backup forward: the first saved the original, the
 * second overwrote it with the first one's output, and the bytes a generation
 * was actually paid for were gone with nothing left pointing at them.
 *
 * That is not a hypothetical. work/hub/library/skiff-rowboat.png came back
 * 7x7 and 231 bytes after a base-trim ran on an already-cropped file, and the
 * .prev beside it held a 1291-byte middle step rather than the 13073-byte
 * original. Only git still had the real one, and the library is the one place
 * in this tool where "only git has it" is luck rather than design: a map that
 * is not a repo would simply have lost it.
 *
 * So the first slot is written once and never again, and every later edit
 * lands in a numbered one beside it. work/<id>/.prev/<name>.png is always the
 * thing as it was generated, the highest number is always the step just taken,
 * and no edit can reach back past the first. Slots stop at PREV_MAX so a
 * hundred trims cannot fill a disk; when they run out it is the most recent
 * step that rolls, never the original.
 *
 * .prev is not the library and is never listed, so none of this shows up as a
 * row. These bytes cost generations and an edit is not worth losing them over. */
const PREV_MAX = 8

// the path to write this backup to: the plain name while it is free, then
// -2, -3 and up. Answers null only if the folder itself cannot be made.
function prevPath(id, as, isDir) {
  const prev = path.join(WORK, safeId(id), '.prev')
  fs.mkdirSync(prev, { recursive: true })
  const first = path.join(prev, as)
  if (!fs.existsSync(first)) return first
  // a heading set is a folder and has no extension to keep the number out of
  const dot = isDir ? -1 : as.lastIndexOf('.')
  const stem = dot > 0 ? as.slice(0, dot) : as
  const ext = dot > 0 ? as.slice(dot) : ''
  for (let i = 2; i < PREV_MAX; i++) {
    const p = path.join(prev, `${stem}-${i}${ext}`)
    if (!fs.existsSync(p)) return p
  }
  return path.join(prev, `${stem}-${PREV_MAX}${ext}`)
}

function keepPrevFile(id, from, as) {
  try {
    fs.copyFileSync(from, prevPath(id, as, false))
  } catch {
    /* a backup that cannot be written is not a reason to block the edit */
  }
  keepVersion(id, as.replace(/\.png$/i, ''))
}

/* The same keep, in the store, so an undo works on a machine that never saw the
 * edit. Not awaited: the disk copy above is what this request depends on, and
 * blocking a generation on a bucket copy would make every edit slower for a
 * safety net that is allowed to be a moment behind. */
function keepVersion(id, name) {
  if (!platformOn()) return
  snapshotVersion(id, name).catch((e) => console.error(`[versions] could not keep ${id}/${name}:`, e.message))
}

// the folder half of the same law, for a heading set or an animation's frames
function keepPrevDir(id, from, as) {
  try {
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) return
    const to = prevPath(id, as, true)
    fs.mkdirSync(to, { recursive: true })
    for (const f of fs.readdirSync(from)) {
      const src = path.join(from, f)
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(to, f))
    }
  } catch {
    /* a backup that cannot be written is not a reason to block the edit */
  }
  keepVersion(id, as)
}

/* The old bytes out, the new bytes in, ONE library row either way.
 *
 * The item keeps its own name, so every placement of it picks the new pixels up
 * instead of pointing at art nothing links to any more. Files the new take does
 * not use are deleted: a shorter motion would otherwise leave the tail of a
 * longer one behind, and a set trimmed through asset-crop's heading branch
 * would leave flat <heading>.png files beside the indexed ones. */
async function swapFolder(id, name, stage, meta) {
  const folder = path.join(libDirOf(id), name)
  /* This used to rmSync the .prev folder before refilling it, which is the
   * rollover in its most direct form: re-animating a figure twice deleted the
   * original eight headings outright. It goes through the shared helper now,
   * so take one is kept and take two lands beside it. */
  keepPrevDir(id, folder, name)
  fs.mkdirSync(folder, { recursive: true })
  const keep = new Set()
  for (const f of fs.readdirSync(stage)) {
    fs.copyFileSync(path.join(stage, f), path.join(folder, f))
    keep.add(f)
  }
  if (meta) {
    fs.writeFileSync(path.join(folder, 'dirs.json'), JSON.stringify(meta, null, 2))
    keep.add('dirs.json')
  }
  for (const f of fs.readdirSync(folder)) if (!keep.has(f) && /\.png$/i.test(f)) fs.unlinkSync(path.join(folder, f))
  fs.rmSync(stage, { recursive: true, force: true })
  await pushLibrary(id, name)
}

// what he typed, on this map, newest first
function readAsks(id) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(WORK, safeId(id), 'asks.json'), 'utf8'))
    return Array.isArray(j) ? j : []
  } catch {
    return []
  }
}

/* Every heading a character can face, walking if it can walk.
 *
 * The walk is gathered across however many animation groups it is split over: a
 * character animated in two passes has its eight headings in two entries. want
 * is an animation_type to insist on, '' for any group with walk in its name, or
 * '*' for whatever it has, which is the right reading straight after a
 * generation, where the only animation on it is the one just paid for and its
 * name is the template's.
 *
 * Any heading the walk does not cover falls back to the still rotation, so a
 * character with no animation still faces where it is going without its legs
 * moving. */
function characterDirs(detail, want) {
  const d = detail && typeof detail === 'object' ? detail : {}
  const w = String(want || '').toLowerCase()
  const byDir = {}
  for (const an of Array.isArray(d.animations) ? d.animations : []) {
    const kind = String(an.animation_type || an.display_name || '').toLowerCase()
    if (w !== '*' && (w ? kind !== w : !/walk/.test(kind))) continue
    for (const dd of Array.isArray(an.directions) ? an.directions : []) {
      const k = String(dd.direction || '')
      const frames = Array.isArray(dd.frames) ? dd.frames.filter(Boolean) : []
      if (k && frames.length && !byDir[k]) byDir[k] = frames
    }
  }
  const rot = d.rotation_urls && typeof d.rotation_urls === 'object' ? d.rotation_urls : {}
  for (const [k, u] of Object.entries(rot)) if (u && !byDir[k]) byDir[k] = [u]
  return byDir
}

/* ---- what a stop leaves behind ------------------------------------------
 *
 * Stopping is not undoing. Every generation already asked for is already paid
 * for, so the rule everywhere is that whatever landed gets written and the run
 * ends there. What a stop buys is the NEXT generation, not the last one back.
 *
 * The animated routes are two spends: a base object, then the frames driven
 * off it. A stop between them, or during the second, saves one generation and
 * leaves a base nobody would otherwise see. It files as a still object instead
 * of being thrown away. */
const STOPPED_STILL = 'stopped before the motion, so it lands still'

// the second half of a two-spend route, or null if a stop landed. Anything
// other than a stop is a real fault and travels up.
async function stillOnStop(gate, start) {
  if (gate && gate.off) return null
  try {
    return await raceStop(gate, start())
  } catch (e) {
    if (String((e && e.message) || e) !== 'stopped') throw e
    return null
  }
}

/* one png into this map's library under a name nothing else has taken. Written
 * once because three paths land here: the still answer of both object routes,
 * and the base of an animated one whose motion half never happened. */

/* A NAME NOTHING ELSE IN THIS MAP IS USING, asked of both places.
 *
 * The suffix walk used to probe the folder alone, which is right when the
 * folder is the library. It is not any more: on a host, scratch is /tmp and
 * starts empty on every request, so every generation would pick the base name
 * and quietly overwrite the item already in the store under it.
 *
 * So disk answers for what is mid-request and the database answers for what
 * exists at all, and a name has to be free in both. */
async function freeLibraryName(id, base) {
  const dir = libDirOf(id)
  const onDisk = (n) => fs.existsSync(path.join(dir, n + '.png')) || fs.existsSync(path.join(dir, n))
  const known = new Set()
  if (platformOn()) {
    try {
      for (const it of await libraryOf(id)) known.add(it.name)
    } catch {
      /* the database being unreachable is not a reason to refuse to draw */
    }
  }
  if (!onDisk(base) && !known.has(base)) return base
  for (let i = 2; ; i++) {
    const n = `${base}-${i}`
    if (!onDisk(n) && !known.has(n)) return n
  }
}

async function saveStatic(id, b64, wantName, ask, prompt, objectId) {
  const dir = libDirOf(id)
  fs.mkdirSync(dir, { recursive: true })
  const file = (await freeLibraryName(id, cleanName(wantName))) + '.png'
  fs.writeFileSync(path.join(dir, file), Buffer.from(b64, 'base64'))
  const size = pngSize(path.join(dir, file))
  const name = file.replace(/\.png$/i, '')
  noteAsk(id, name, ask, prompt)
  // where these pixels came from, so this thing can be given another face
  // later without anybody guessing which of 769 account rows drew it
  if (objectId) noteOrigin(id, name, { objectId })
  // disk was the scratch pad; the store is the copy that survives this machine.
  // Awaited rather than fired off, so the response never claims a thing exists
  // before its bytes are durable.
  await pushLibrary(id, name)
  return { name, kind: 'static', src: `/work/${id}/library/${file}`, w: size.w, h: size.h }
}

// Every library write ends at one of four functions. This is what each of them
// calls when it is done, and it is why generation still appears in a listing
// that now comes from the database rather than from a directory walk.
async function pushLibrary(id, name) {
  try {
    await pushItem(id, name, path.join(WORK, safeId(id)))
  } catch (e) {
    // the bytes are on disk and import-work.mjs reconciles a whole map, so a
    // failure here is recoverable rather than lost work
    console.error(`[library] could not push ${id}/${name} to the store:`, e.message)
  }
}

/* ---- ORIGIN: what a library row was drawn from --------------------------
 *
 * One file per map, work/<id>/origin.json, mapping a library name to the
 * pixellab id that drew it and to the extra faces it has since been given.
 *
 * A separate file rather than a field on the art, because the library holds
 * three shapes — a flat png, a folder of frames, a folder of headings — and
 * only the last has anywhere to put metadata today (dirs.json). One file all
 * three can use beats three conventions.
 *
 * Why it has to exist: every state endpoint keys off the id of the thing being
 * edited, and until today that id was dropped the moment the bytes hit disk.
 * Recovering it afterwards is the guesswork characterFor already does — match
 * on the prompt, then rank by age, across 769 rows — and it is wrong often
 * enough that three of this hub's people were reported deleted while their art
 * sat on disk beside the id that drew it.
 *
 * A row with no entry keeps working exactly as it does now: an imported
 * account object, a hand-edited png, everything made before today. No origin,
 * no second face offered, nothing broken. */
const originPath = (id) => path.join(WORK, id, 'origin.json')

function readOrigin(id) {
  try {
    const j = JSON.parse(fs.readFileSync(originPath(id), 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch {
    return {}
  }
}

function noteOrigin(id, name, patch) {
  try {
    const all = readOrigin(id)
    all[name] = { ...(all[name] || {}), ...patch }
    fs.mkdirSync(path.dirname(originPath(id)), { recursive: true })
    fs.writeFileSync(originPath(id), JSON.stringify(all, null, 2))
    return all[name]
  } catch {
    /* a lost origin costs the second-face button on one row, never a spend */
    return null
  }
}

/* Where a state's art lives: work/<id>/states/<owner>/, OUTSIDE the library
 * folder on purpose. A face is not a thing, it belongs to the thing, and one
 * stray listing would undo the whole reason for the change — a library that
 * fills with boulder, boulder-2, sleeping-dragon, rows that mean nothing on
 * their own and that the sparkle's planner would then have to choose between. */
const stateDirOf = (id, owner) => path.join(WORK, id, 'states', cleanName(owner))

/* ---- the two fields that used to be four dropdowns ----------------------
 *
 * A client that has not been updated still posts bodyType, template and walk.
 * These turn that into the skeleton and the motion the route now works in, so
 * nothing that used to work stops working. Nothing sends these by choice.
 *
 * legacySkeleton answers '' for the one case the old route refused: bodyType
 * quadruped with no body named. */
function legacySkeleton(b) {
  if (String(b.bodyType) !== 'quadruped') return 'mannequin'
  return QUADRUPEDS.includes(String(b.template)) ? String(b.template) : ''
}

function legacyAnim(b) {
  const walk = String(b.walk || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40)
  return walk ? { how: 'template', template: walk } : { how: 'none' }
}

/* Which headings written motion has to name, and how many of them.
 *
 * Naming a heading the character does not have is a generation asked for and
 * thrown away, so rotation_urls gets read rather than assumed. But the read is
 * only trusted when it is COMPLETE: awaitCharacter answers the moment four
 * rotations are real, because that is a whole four-way character, so an
 * eight-way body is often read back half drawn. Believing a short read there
 * would buy motion for half the sprite after the button had said nine.
 *
 * n is the count that was ordered, and it is also the ceiling: what gets
 * animated can never be more than what was priced. */
function headingsOf(detail, n) {
  const rot = detail && typeof detail.rotation_urls === 'object' && detail.rotation_urls ? detail.rotation_urls : {}
  const got = Object.entries(rot)
    .filter(([, u]) => typeof u === 'string' && u)
    .map(([k]) => k.toLowerCase())
  return got.length >= n ? got.slice(0, n) : n === 4 ? DIRS4 : DIRS8
}

// the alpha a pixel needs to count as drawn. The same floor the client's own
// trim uses, src/core/debase.ts:29, so the two agree about where a sprite ends
const ALPHA_MIN = 20

/* THE PADDING COMES OFF, once, against ONE box.
 *
 * pixellab draws a character into a canvas about 40% bigger than the character
 * to leave animation headroom (a 48px character lands on a ~68px canvas), and
 * that empty margin is why an imported figure floats above the ground in the
 * game. So the set is cropped to the tightest box that holds every frame of
 * every heading. ONE box for all of them: a box per frame would move the feet a
 * pixel or two each frame and the walk would bob.
 *
 * The client's trim cannot be reached from here. It runs on a canvas and
 * /api/asset-crop only writes back the pixels it is handed. The png pair in
 * sheet.mjs is this project's decoder and encoder and this is what it is for.
 *
 * Answers the new size, or null when there was nothing to take off, in which
 * case the files on disk are exactly as they arrived. */
function trimSet(dir, dirs) {
  const files = []
  for (const list of Object.values(dirs || {}))
    for (const u of list) files.push(path.join(dir, String(u).split('/').pop()))
  if (!files.length) return null
  const imgs = []
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  for (const f of files) {
    let im
    try {
      im = decodePNG(fs.readFileSync(f))
    } catch {
      return null // an unreadable frame means no shared box, so leave the set alone
    }
    imgs.push([f, im])
    for (let y = 0; y < im.h; y++)
      for (let x = 0; x < im.w; x++)
        if (im.data[(y * im.w + x) * 4 + 3] > ALPHA_MIN) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
  }
  if (x1 < x0 || y1 < y0) return null
  const first = imgs[0][1]
  // frames of different sizes share no box, and a set already tight has nothing
  // to take; either way it is left as it is
  if (imgs.some(([, im]) => im.w !== first.w || im.h !== first.h)) return null
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  if (w >= first.w && h >= first.h) return null
  for (const [f, im] of imgs) {
    const out = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++)
      out.set(im.data.subarray(((y + y0) * im.w + x0) * 4, ((y + y0) * im.w + x0 + w) * 4), y * w * 4)
    fs.writeFileSync(f, encodePNG(w, h, out))
  }
  return { w, h }
}

function noteAsk(id, name, ask, prompt, kind = 'asset') {
  try {
    const f = path.join(WORK, safeId(id), 'asks.json')
    let list = []
    if (fs.existsSync(f)) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'))
        if (Array.isArray(j)) list = j
      } catch {
        list = []
      }
    }
    list.unshift({
      name,
      kind,
      ask: String(ask || '').slice(0, 500),
      prompt: String(prompt || '').slice(0, 1200),
      at: new Date().toISOString(),
    })
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(list.slice(0, 40), null, 2))
  } catch {
    /* a lost note is never worth failing a generation the person paid for */
  }
}

const slugName = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-') || 'asset'

// a caller-pinned library name: sanitized like slugName but not word-capped,
// so a batch suffix like -3 survives
const cleanName = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'asset'

// a caller-pinned seed; pixellab treats 0 as random, so only a positive
// integer is passed through
const seedOf = (b) => {
  const n = Math.floor(Number(b.seed))
  return isFinite(n) && n > 0 ? n : undefined
}

// ---- the ask interpreter ------------------------------------------------
// The image generator draws every noun it hears: "smoke for the volcano"
// paints a volcano, "a bird that isn't flying" paints flight. A language
// model understands the ask and rewrites it into generator-language: ONE
// drawable thing, destinations stripped, negations resolved into the state
// that remains, movement words separated for animation, a sane canvas size.
// It never places anything and never judges the map — that wider job was
// tried and killed; this is a sentence-level rewrite with a fixed rulebook.
// On any failure the raw ask passes through unchanged: generation never
// blocks on the interpreter.

// at or above this the map's style clause is appended and the palette lock
// opens strong; below it the ask goes out bare and the lock opens at zero
const BELONGS_MIN = 0.5

// the whole assembled prompt is what gets sent and what the button shows, so
// the cap is the endpoint's own (2000 chars) with room to spare
const PROMPT_MAX = 1200

/* How much of the person's OWN words reaches a planner.
 *
 * This was 600 and it silently ate the end of longer asks. Measured 2026-08-21:
 * a guiding prompt of 817 characters that said "i want one of the assets
 * generated for the beach to be a crab" at character 735 reached the model with
 * the word crab appearing ZERO times, and planned a crab 0 times out of 3. At
 * 1200 the same ask plans a crab 3 out of 3. Nothing else about the prompt
 * needed changing; an ablation of the surrounding wording scored the same, so
 * the cap WAS the bug.
 *
 * Nothing upstream bounds the box, so this is the only place a person's words
 * can go missing. If it ever needs raising again, raise it: a request that is
 * read in full and refused beats one that is quietly cut in half. */
const ASK_MAX = 1200

// how much of an object plan's one printed line survives. See planMake, where
// the measurement that moved it off 240 is written down.
const NOTE_MAX = 400

/* HOW LONG A ROUND CAN BE, and the one number every other cap is worked out
 * from.
 *
 * Four numbers used to say this and they said different things: cleanLife kept
 * six states, the art field clamped to 0..7, the export sliced looks to seven,
 * and the prompt below asked for two to six. A seven-state answer therefore
 * lost its last state on the way into the editor with nothing said to anybody,
 * which reads on screen as a round that just stops early.
 *
 * cleanLife owns the real ceiling (src/core/life.ts, the slice inside
 * cleanLife), so this side matches it rather than inventing a second one, and
 * everything else here is arithmetic on it:
 *   states in a round            STATES_MAX
 *   extra pictures a round needs STATES_MAX, since every state can name a
 *                                picture and none of them need be look 0
 *   highest art index            STATES_MAX, which sits inside life.ts's 0..7
 *                                clamp with one slot spare
 * If cleanLife's ceiling ever moves, move this and nothing else. */
const STATES_MAX = 6

/* HOW MUCH OF THE PICTURE LIST FITS IN A PROMPT, in characters rather than in
 * names.
 *
 * This was a count of 60 and the hub library is 63 items, so three pictures
 * were unnameable and which three was directory order. A count cannot bound a
 * prompt anyway: measured on the hub, names run 1 to 41 characters and average
 * 17.2, so sixty of them is anywhere between one line and a paragraph. The
 * clause is the thing that has to stay small, so the budget sits on the clause.
 *
 * 4000 characters is roughly a thousand tokens beside a prompt whose fixed body
 * is already several thousand. It holds the whole hub library three times over
 * (63 names, 1205 characters joined, measured), and about 230 names of average
 * length, so a 300-item library loses a tail instead of blowing the prompt. The
 * tail is counted and said out loud, which is the part that was actually wrong:
 * silence, not the number. */
const NAMES_CHARS = 4000

/* THE CAMERA, WHICH IS A DECISION ABOUT THE THING AND NOT A HOUSE CONSTANT.
 *
 * This used to read "the camera angle every object on this tool is drawn at ...
 * one constant, so the projection can never disagree with the words in the
 * prompt", and both halves were wrong. It did not stop the disagreement, it WAS
 * one half of it: the constant went out as the view parameter while the router
 * was separately ordered to open every style sentence with "Isometric pixel
 * art". Measured over 24 free reads on that text, 24 of 24 opened exactly
 * "Isometric pixel art": a boat, a well and a stall, which want it, and a
 * puddle, a rope coil, a lamp post and a big shady tree, which do not. The router already knew: asked for a puddle it wrote "it is
 * flat so the height is spent low" and then had to spend that knowledge on the
 * aspect ratio, because projection was the one thing it was forbidden to say.
 *
 * The map settles it. Open work/hub/.ask/map.png: the palm belt has dead
 * vertical trunks and symmetric fronds with no foreshortening anywhere, and the
 * houses forty pixels away have two roof faces and a wall receding at two to
 * one. One painting, one hand, projection chosen per object. A prompt that says
 * isometric for everything contradicts the map it claims to match.
 *
 * So the router answers view, once, and both channels are written from that one
 * value. See planMake's THE CAMERA and objectPrompt.
 *
 * OBJECT_VIEW stays exactly where it is and keeps its value. It is the
 * CHARACTER default at /api/character-gen and spriteRoute, and characters are
 * the one path on this tool that is reliable; an earlier session degraded them
 * by leaking object rules across. On the object side it is now the fallback for
 * an answer that is missing or unreadable, which lands silence on the value
 * that has evidence behind it rather than on the endpoint's own documented
 * default of high top-down. */
const OBJECT_VIEW = 'low top-down'

/* What /v2/map-objects will actually take, read off its own schema.
 *
 * Deliberately NOT CHAR_VIEWS. That list carries perspective, which the object
 * endpoint does not know, and a word the schema rejects is a 422 charged after
 * the draw. Three values, and they are not three tastes: high top-down is the
 * ground plane, side is the picture plane, low top-down is the raked corner
 * between them that shows a top and a side at once. The endpoint has had the
 * whole range all along and this tool fenced two thirds of it off as a bug. */
const OBJECT_VIEWS = ['low top-down', 'high top-down', 'side']

/* The one place a projection is written in English, keyed by the value that
 * goes on the wire. Nothing else in this file is allowed to name a camera.
 *
 * low top-down is byte for byte what the 47 objects he kept say, and that is
 * the point of it: every ask that routes to the common camera produces exactly
 * the prompt it produces today, so the path with evidence behind it is not
 * gambled on this change. The other two get the minimum, because there is no
 * measurement behind any wording for them yet.
 *
 * Two channels DO speak here, and that is not the old bug. The account settles
 * it: read 2026-08-25 over all 739 objects on it, 315 carry the word isometric
 * in their prompt while their view parameter says high top-down, and they were
 * made anyway. A parameter and a word are not what fights. What fights is a
 * word and a parameter that neither of them can change, so they drift apart.
 * Here they are the same variable read twice and cannot express two cameras.
 *
 * The same read says the other two values are not theoretical either: that
 * account holds 527 objects at high top-down and 30 at side. It is this tool
 * that has only ever sent one of the three. */
const CAMERA_WORDS = {
  'low top-down': 'Isometric pixel art',
  'high top-down': 'Pixel art seen from straight above',
  'side': 'Flat pixel art drawn straight on with no foreshortening',
}

const objectView = (v) => (OBJECT_VIEWS.includes(String(v)) ? String(v) : OBJECT_VIEW)

/* READING THE CAMERA BACK OFF THE FINISHED PROMPT, which is what makes this
 * survive the round trip through files this change does not own.
 *
 * The plan goes to the browser, the browser holds it, and the browser sends the
 * finished prompt back as `thing` when the person presses spend. If the view
 * had to travel as its own field it would have to be carried by MakePlan, two
 * option types, runGen and the fill path, and any one of those dropping it puts
 * the constant back silently while the prompt still says "drawn straight on
 * with no foreshortening". That is the same two-cameras-disagree bug, pointed the
 * other way, on a sprite that looks like the tool merely not being smart. That
 * hole is not hypothetical: `count` is documented in the client and read in the
 * ui and has never once been set by this server.
 *
 * So the camera is recovered from the bytes that carry it. The three openers
 * are code-owned strings, so this is not pattern-matching model prose, it is
 * looking for a phrase this file wrote. An older client, a hand-edited prompt
 * and a prompt from before this change all land on OBJECT_VIEW, which is what
 * they got yesterday. Two openers in one string is a prompt nobody here wrote,
 * so it falls back rather than guessing which was meant. */
function viewFor(prompt) {
  const t = String(prompt || '').toLowerCase()
  const hits = OBJECT_VIEWS.filter((v) => t.includes(CAMERA_WORDS[v].toLowerCase()))
  return hits.length === 1 ? hits[0] : OBJECT_VIEW
}

/* What /v2/characters will actually take, read off its own schema.
 *
 * standard is one generation and the only mode that honours a direction count.
 * pro is 20 to 40 for the character alone, so it is offered and never assumed.
 * v3 is 2 to 9 and the only one that takes a reference image.
 *
 * CHAR_VIEWS used to carry oblique. It is not in the live v2 openapi and never
 * was: read 2026-08-23, every create-character route describes its view as
 * "side, low top-down, high top-down, perspective". Sending oblique to the
 * standard route was sending a word the schema does not know. */
const CHAR_MODES = ['standard', 'pro', 'v3']
const CHAR_VIEWS = ['low top-down', 'high top-down', 'side', 'perspective']
const QUADRUPEDS = ['bear', 'cat', 'dog', 'horse', 'lion']

/* THE SIX RIGS, AND WHY THE LIST IS ALLOWED TO EXIST HERE.
 *
 * Every other list in the make panel died, because a list of kinds of thing is
 * always shorter than what a person can imagine. This one is different: it is
 * not a list of what can EXIST, it is the complete set of skeletons pixellab
 * has. There is no dragon rig, no robot rig, no bird, no serpent, and asking
 * for one is a 422 that costs the body it was hung on.
 *
 * So the list stays and the NARROWING goes somewhere else: the router picks
 * the nearest rig by body plan and the prompt carries what the thing actually
 * is. A patrol robot is a mannequin that reads as a machine. A dragon is a lion
 * rig that hovers. Nothing in the ui ever offers these six to anybody. */
const SKELETONS = ['mannequin', ...QUADRUPEDS]

/* The humanoid template animations, for the cheap path.
 *
 * A named template is one generation per direction and is exactly right for the
 * ordinary case, a two-legged thing putting one foot in front of the other.
 * Everything else is written motion instead, because a template list cannot say
 * "hovers with its wings beating" and v3 can.
 *
 * The four-legged templates are deliberately absent. They are named per body,
 * so the right id for a lion is not the right id for a horse and neither can be
 * known before the body exists. A quadruped always takes the written path.
 *
 * A name that is not on this list is demoted to written motion rather than
 * sent: an unknown template id comes back 422 AFTER the body is paid for. */
const WALK_TEMPLATES = [
  'walk', 'walk-1', 'walk-2', 'walking', 'walking-2', 'walking-3', 'walking-4', 'walking-5',
  'walking-6', 'walking-7', 'walking-8', 'walking-9', 'walking-10',
  'walking-4-frames', 'walking-6-frames', 'walking-8-frames',
  'running-4-frames', 'running-6-frames', 'running-8-frames',
  'sad-walk', 'scary-walk', 'crouched-walking',
  'breathing-idle', 'crouching', 'drinking', 'picking-up', 'pushing', 'pull-heavy-object',
  'jumping-1', 'jumping-2', 'two-footed-jump', 'getting-up', 'throw-object',
]

/* WHAT CANNOT WALK, and why a list is allowed to exist here.
 *
 * The template gate used to be two facts, both of them true on their own and
 * neither of them about the thing being made: the router said template, and the
 * rig is the upright one. A hovering wisp routed onto the mannequin satisfies
 * both, and got a walk cycle. That is the exact failure the written path was
 * built to end, so trusting the prompt not to ask for it is not enough.
 *
 * These are the words that say plainly the thing does not put one foot in front
 * of the other: no legs, airborne, or incorporeal, and the verbs for moving
 * without feet. It is not a taxonomy and does not need to be complete. A word
 * it misses leaves things exactly where they were, and a word it catches only
 * DEMOTES to written motion, which at these sizes is the same one generation
 * per direction. Being wrong here costs nothing, so it leans toward catching.
 *
 * What is deliberately NOT on it: cart, wagon, boat, balloon, bird, bat. Those
 * do not walk either, but they turn up in the hands of somebody who does, and a
 * farmer pushing a cart losing his walk cycle to the word cart is the list
 * grading the props instead of the subject. */
const NO_WALK = new RegExp(
  '\\b(' +
    [
      'dragon', 'wyvern', 'drake', 'wyrm', 'serpent', 'snake', 'eel',
      'slime', 'blob', 'ooze', 'jellyfish', 'squid', 'octopus', 'mermaid', 'siren',
      'ghost', 'spirit', 'wraith', 'phantom', 'spectre', 'specter', 'wisp', 'orb', 'drone',
      'fairy', 'pixie',
      'float', 'floats', 'floating', 'hover', 'hovers', 'hovering',
      'fly', 'flies', 'flying', 'soar', 'soars', 'soaring',
      'drift', 'drifts', 'drifting', 'glide', 'glides', 'gliding',
      'levitate', 'levitates', 'levitating', 'slither', 'slithers', 'slithering',
      'swim', 'swims', 'swimming',
    ].join('|') +
    ')\\b',
  'i',
)

// An empty ask is not evidence that it walks, so it does not get a walk. The
// only caller that could send one is an old client posting straight at
// character-gen, and written motion is the same price.
const walksOnFeet = (ask) => {
  const s = String(ask || '').trim()
  return !!s && !NO_WALK.test(s)
}

/* The words a demotion must not repeat back. A router that asked for a walk
 * template usually wrote walking beside it, so for something that does not walk
 * its own motion line is the one source that cannot be reused when the gate
 * turns the template down. Catching the template and then describing a walk in
 * words lands in the same place by a longer road. */
const WALK_WORDS = /\b(walk|walks|walking|stride|strides|striding|step|steps|stepping|march|marches|marching|jog|jogs|jogging|run|runs|running|foot|feet|legs?)\b/i

/* Eight headings, named out loud, and this is not decoration.
 *
 * Template mode defaults to every direction the character has. WRITTEN motion
 * defaults to SOUTH ONLY, which is in the live schema in those words. A written
 * animation that forgets this comes back facing one way, unusable on a map
 * where life.ts works out an eight-way facing, with the budget for the other
 * seven still sitting unspent. */
const DIRS8 = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west']
// the four a four-direction body has. Nothing in the ui asks for one, but the
// route accepts nDirections 4 and a written motion still has to name them.
const DIRS4 = ['south', 'east', 'north', 'west']

/* The sprite canvas ceiling, and it is a price not a taste.
 *
 * Written motion is billed ceil(w * h * frames / 65536) per direction, which is
 * one per direction at 96 and two above it. The cost line on the button says
 * nine and it has to mean nine, so nothing here draws bigger than this. A thing
 * that should look bigger on the map is scaled at its placement, which is free:
 * placements already carry sx/sy. */
const SPRITE_MIN = 32
const SPRITE_MAX = 96

// standard draws in two to five minutes and the motion is eight directions
// behind it, so these are long on purpose. The stop button is the way out, not
// a clock.
const CHAR_WAIT = 600000
const WALK_WAIT = 900000

/* THE HOUSE PROMPT.
 *
 * The measured diagnosis: short asks like "a palm tree, clean hand-painted
 * pixel art, isometric" come back as illustrations standing on invented stone
 * slabs. The 47 objects on this account judged good are 60 to 100 words
 * and every single one of them STATES the projection, the light direction, the
 * value count, the palette, that it is one piece, and that there is no ground.
 * Verbatim from the lighthouse: "in strict 2:1 isometric pixel art ... warm
 * golden-hour sunlight from the upper left, soft blue-tinted shadow on the
 * right side, painterly 6-8 value shading, muted warm palette, transparent
 * background, NO water, NO ground beyond the small stone footing".
 *
 * So the interpreter no longer writes the prompt. It writes only the two parts
 * that change per ask (the subject and its palette) and the fixed DNA is
 * assembled around them here, in code. That is deliberate: a model asked to
 * remember seven clauses forgets one, and the one it forgets is the refusal of
 * ground, which is the exact failure being fixed. Assembled this way the
 * refusal is on every object prompt whether or not the interpreter answered at
 * all. */
/* Ground words, out of an object's prompt.
 *
 * The style clause is read off the painting so a sprite looks like it came off
 * this island, and on THIS island the honest answer came back as "warm
 * sandy-tan and earthy-brown palette, cool grey stone". Which is true of the
 * map, and is also a shopping list of materials for building a plinth. It went
 * on every object prompt. His palms came back standing on discs of sand with
 * stone rims because the prompt asked for sand and stone (measured on
 * work/hub/style.json, 2026-08-19).
 *
 * The same goes for the subject. "island palm trees" reads to a generator as
 * island first, trees second, and it draws both.
 *
 * A colour word is not the problem: "sandy-tan" as a HUE is exactly what makes
 * a sprite belong. So this drops whole comma-clauses that name ground as a
 * MATERIAL and leaves everything else standing. Deterministic, because a model
 * told to remember a rule forgets it on the one ask that mattered. */
const GROUND = /\b(sand|sandy|stone|rock|rocky|earth|earthy|dirt|soil|gravel|grass|grassy|terrain|ground|paving|paved|cobble|cobblestone|beach|shore|shoreline|coast|coastal|seaside|island|terracotta|clay)\b/i

function groundless(s) {
  return String(s || '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c && !GROUND.test(c))
    .join(', ')
}

/* The subject is left alone on purpose. A regex that strips place words out of
 * it was written and thrown away the same hour: it missed the case that caused
 * this ("a cluster of tall ISLAND palm trees", where the word is buried mid
 * phrase) and it turned "a beach umbrella" into "a umbrella". Editing English
 * by pattern breaks more than it fixes. The subject is the interpreter's job
 * and the instruction names this exact failure; what gets through is caught by
 * the base trim, which reads pixels and cannot be talked around. */

/* THE SAME FENCE, FOR THE CAMERA, and it works for the same reason groundless
 * does: it drops whole comma-clauses out of the STYLE half only, where every
 * clause is one fact and losing one is survivable.
 *
 * It is a fence and not the mechanism. The mechanism is that code owns the join
 * in objectPrompt, so the router is never handed a sentence it could put a
 * camera into. This catches the case where it names one anyway inside the style
 * clauses it does write. Measured over 24 free reads after the change it had
 * nothing to do: 0 of 24 prompts carried a projection word anywhere outside
 * the phrase code itself put in. That is the state it
 * is supposed to be in, and it stays because the day it does fire is the day a
 * second camera would otherwise have gone out at full price.
 *
 * The subject is left alone here too, for the reason written above: a regex on
 * the subject was tried and thrown away the same hour. */
const PROJECTION =
  /\b(isometric|2:1|two[- ]to[- ]one|top[- ]?down|overhead|bird'?s[- ]?eye|three[- ]quarter|3\/4|side[- ]on|side view|side elevation|front elevation|orthographic|axonometric|oblique|perspective|foreshorten\w*|projection|vanishing point|(?:seen|viewed|drawn|looking)\s+(?:from|down|straight))/i

function projectionless(s) {
  return String(s || '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c && !PROJECTION.test(c))
    .join(', ')
}

/* THE ONE PLACE AN OBJECT PROMPT IS ASSEMBLED, so the camera in the words and
 * the camera on the wire are the same variable read twice.
 *
 * The router answers a subject and a style as two separate fields and never a
 * finished sentence, which is the whole trick: there is no string it writes
 * that a projection could hide in, so nothing has to remember a rule. Code puts
 * the camera in, between them, in the position the kept objects put it.
 *
 * At low top-down the output is byte for byte the shape of the one he kept that
 * is quoted in planMake: subject sentence, full stop, "Isometric pixel art",
 * then the style clauses. The common ask is therefore unchanged by this whole
 * change, which is deliberate. 47 objects say that wording works and none of
 * them says anything at all about the other two. */
function objectPrompt({ subject, style, view }) {
  const one = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const sub = one(subject).replace(/[.,;:\s]+$/, '')
  // the style can come back capitalised and full-stopped, because it was asked
  // for as its own field. It is a tail in the joined sentence, so it joins as
  // one rather than starting a second one.
  const sty = projectionless(one(style).replace(/^[.,;:\s]+/, '').replace(/[.\s]+$/, ''))
  const cam = CAMERA_WORDS[objectView(view)]
  const tail = sty ? `${cam}, ${sty.charAt(0).toLowerCase()}${sty.slice(1)}` : cam
  /* THE REFUSAL OF GROUND, PUT BACK, AND PUT BACK IN CODE.
   *
   * housePrompt has carried these two clauses since the palms came back standing
   * on discs of sand with stone rims. When the router started writing its own
   * prompts they were left behind, and housePrompt stopped being reachable from
   * the ui, so the live path has been asking for objects with nothing said about
   * ground or transparency at all. The only thing refusing a plinth since then
   * is the pixel base-trim, which reads bytes after the generation is paid for
   * and cannot stop one being drawn.
   *
   * It matters more now that the camera varies. A side elevation is exactly
   * where a generator volunteers a horizon line or a shadow disc, and side is
   * the value this tool has never once sent.
   *
   * Code appends it rather than the model, for the reason the old comment gives:
   * a model asked to hold seven clauses forgets one, and the one it forgets is
   * the refusal of ground, which is the failure being fixed. Assembled here it
   * rides every object prompt whether or not the interpreter answered well.
   *
   * And it says what IS there rather than what is not. The refusal used to read
   * "no ground, no terrain, no base, no plinth", which handed four ground nouns
   * to a generator that draws every noun it is given, and summoned the slab it
   * meant to forbid. */
  const alone =
    'the object alone as a cut-out sprite on a fully transparent background, ' +
    'the base of the object is where its own material ends'
  return `${sub ? sub + '. ' : ''}${tail}, ${alone}.`.slice(0, PROMPT_MAX)
}

/* A box answered by the router, made safe to index a png with. Anything that
 * does not read as four finite numbers with real area comes back null, which
 * every caller treats as "no crop" and falls through to the bare canvas. A
 * missing patch has to cost the old behaviour and never a crash. */
function cleanBox(v) {
  if (!v || typeof v !== 'object') return null
  const n = (k) => Math.round(Number(v[k]))
  const x = n('x'), y = n('y'), w = n('w'), h = n('h')
  if (![x, y, w, h].every(Number.isFinite) || w < 8 || h < 8) return null
  return { x: Math.max(0, x), y: Math.max(0, y), w, h }
}

function housePrompt({ subject, detail, palette, clause, view }) {
  const bits = [
    // the fallback path is not reachable from the ui: App.tsx always sends
    // the finished prompt as `thing`, so translateAsk never runs there. It still
    // reads its camera off the same table, because a constant left sitting in
    // the interpreter-down path is exactly how this bug comes back.
    subject + ' in ' + CAMERA_WORDS[objectView(view)].toLowerCase(),
    detail,
    'warm golden-hour sunlight from the upper left',
    'blue-tinted shadow on the right side',
    'painterly 6-8 value shading',
    groundless(palette),
    'one unified structure',
    groundless(clause),
    // The refusal used to read "no ground, no terrain, no base, no plinth",
    // which put FOUR ground nouns in the prompt of a generator that draws every
    // noun it is handed. It was summoning the slab it was meant to forbid, the
    // same way "no volcano, just smoke" painted a volcano. Say what IS there
    // instead: the object alone, cut out, ending where it ends.
    'the object alone as a cut-out sprite on a fully transparent background',
    'the base of the object is where its own material ends',
  ]
  return bits
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/[,\s]+$/, ''))
    .filter(Boolean)
    .join(', ')
    .slice(0, PROMPT_MAX)
}

/* ---- reading the ask WITH the map in front of you ------------------------
 *
 * This replaces five stages, and the five stages are worth naming because the
 * shape of that mistake is easy to repeat. The map used to be looked at once,
 * boiled down to eighteen words of text, and those words stapled onto every
 * prompt by code. When the words turned out to name the ground the map is made
 * of ("warm sandy-tan and earthy-brown palette, cool grey stone") a filter was
 * added to strip them. When sand arrived anyway a pixel trimmer was added to
 * cut it off. Five stages, four of them compensating for the lossiness of the
 * first, none of them necessary: the model can SEE.
 *
 * So it gets the painting itself. Not a summary of it, the file. And if a box
 * was drawn, the crop of that box too, at 2x, plus how many map pixels across
 * it is, which is the only reliable way to get scale right — a sprite is the
 * right size when it is the right size NEXT TO WHAT IS ALREADY THERE.
 *
 * It writes the whole prompt. There is no house style assembled around it,
 * because a prompt assembled in code cannot respond to what the map looks
 * like, and every clause that used to be bolted on is something a model
 * looking at the picture can decide better. */
async function planMake({ ask, what, kind, id, mapFile, boxFile, box, previous, job }) {
  const sprite = what === 'sprite'
  const lines = [
    `You are writing ONE prompt for a pixel-art sprite generator (PixelLab). Read the image file` +
      `s below ONCE EACH with the Read tool, then answer in your next message. Do not read them ` +
      `again to check yourself and do not open anything else: one look at each is all this needs.`,
    ``,
    `The whole map, absolute path:`,
    mapFile,
  ]
  if (boxFile && box)
    lines.push(
      ``,
      `The area the user boxed, where this sprite will stand, shown at 2x, absolute path:`,
      boxFile,
      `That box is ${box.w} by ${box.h} map pixels.`,
    )
  else
    lines.push(
      ``,
      `The user did not box an area, so judge scale from the map as a whole.`,
    )
  lines.push(
    ``,
    `The user asked for, in their words:`,
    `"${String(ask).slice(0, ASK_MAX)}"`,
    ``,
    `The generator draws every noun it is given. It cannot understand negation or context and it ` +
      `has no idea what map this is for. Any ground, place or setting word in the prompt gets ` +
      `drawn, and comes back as a disc of sand or stone under the object. "island palm trees" ` +
      `returns an island. Name the object and its own materials only.`,
    ``,
    `Write the prompt so the result looks painted by the same hand as that map: its light ` +
      `direction, its value range, its outline treatment, its saturation, how chunky its pixels ` +
      `are. You can see the map, so use what is actually in it rather than generic pixel-art ` +
      `words. If the user asked for a mood the map does not have, follow the user.`,
    ``,
  )
  if (sprite) lines.push(...spriteLines(kind))
  else {
    lines.push(
      /* THE SHAPE, taken off the 690 objects on this account rather than invented.
       *
       * Left to its own devices this router wrote things like "clean pixel art,
       * low top-down three quarter view, strong dark outline, saturated palette"
       * and got back a side elevation, a straight overhead and a rectangular
       * trough that was not a boat. The kept objects are all written one way, and
       * writing a rowboat that way instead produced a correct one first try at
       * the same price. MUTED saturation rather than saturated did much of it.
       *
       * The other half of that old fix was ordering every style sentence to open
       * with "Isometric pixel art", and that half was wrong. It is asked for as
       * a decision now and the two fields exist so that code can own the join.
       * See THE CAMERA below and objectPrompt. */
      `SHAPE. Every object he has kept is written the same way and you must match it, but you ` +
        `answer it as TWO FIELDS rather than as one finished sentence. subject: the thing and ` +
        `its own materials in physical detail, what it is made of, how it is worn, which parts ` +
        `show, what is cracked or coiled or missing. style: how it is drawn. Never blend the ` +
        `two and never write the joined sentence yourself. Code joins them.`,
      ``,
      `THE CAMERA. You choose it, and it is one of exactly three the generator takes: ` +
        `${OBJECT_VIEWS.join(', ')}. Decide it from THIS THING'S SHAPE and never from what the ` +
        `thing is called. There is no list of objects to look the answer up in and there is ` +
        `never going to be one, because the next person will ask for something neither of us ` +
        `has thought of.`,
      ``,
      /* THE PAINTING DECIDES, AND THE OBJECT ONLY CHOOSES WITHIN IT.
       *
       * This used to be two measurements on the object and nothing else, and it
       * produced a bookshelf drawn flat-on to stand in a town painted in strict
       * 2:1 isometric. The measurements were not wrong: a bookshelf really does
       * have no top worth seeing and really does stand taller than its footprint,
       * which is the rule that says side. What was wrong is that the rule was
       * asked in a vacuum. On THIS map a bookshelf is a solid box, and every
       * solid box in that town is drawn raked. On a map painted flat the same
       * bookshelf should be flat.
       *
       * Not every map is in the same view, and the
       * area is where the angle is understood relative to the whole map. So the
       * order is fixed here. Read what the painting does with things of this
       * FAMILY in this area, then use the object's shape to pick which family it
       * is in. A map is allowed to be drawn any way at all and this still holds;
       * nothing below names a projection this island happens to use. */
      `Look at the area first and the object second, in that order, because the painting is what ` +
        `is being joined and the object only picks which part of it to agree with. Different ` +
        `maps are painted at different angles and some are painted at more than one. Nothing ` +
        `here assumes the angle this map happens to use.`,
      ``,
      /* THE BOX TEST, and it exists because "no top worth seeing" is not the
       * same question as "has no volume" and the router kept answering the
       * second when it had been asked the first. A bookshelf has no top worth
       * seeing. A bookshelf is also a box, and every box in that town is drawn
       * raked, so it came back flat-on standing in an isometric street.
       *
       * Crating it separates the two and it can be run on anything anybody ever
       * asks for. A bookshelf packs solid. A tree is mostly air between its
       * branches. Nothing about this names a projection or a kind of map. */
      `Every painting draws things in three families and you can see them in the area this thing ` +
        `will stand in. Sort it by CRATING IT: imagine boxing the thing in cardboard, and ask ` +
        `how much of that box the thing actually fills.`,
      `- SOLID: the box comes out mostly full. It has real volume and faces you could lay a hand ` +
        `flat on. Houses, crates, carts, wells, boats, chests, furniture, machines, barrels. A ` +
        `bookshelf is a solid, it is a box full of books, whatever its top looks like.`,
      `- SILHOUETTE: the box comes out mostly air and what is in it is an outline rather than a ` +
        `body. Trees, masts, banners, webs, rigging, fences, reeds. Turning one shows you ` +
        `nothing you did not already have, and from overhead it collapses to a blob.`,
      `- FLAT: it lies in the ground and has almost no height, so its shape IS its footprint. ` +
        `Puddles, coiled rope, worn paths, spills, prints.`,
      ``,
      `Height does not decide this and neither does whether the top is interesting. A tall ` +
        `narrow solid is still a solid. Say the crating answer out loud in the note before you ` +
        `name the family, so a wrong one is visible.`,
      ``,
      `So: decide which family the thing is in, then find something of that same family already ` +
        `painted in that area and take the camera the painting gave it.`,
      `- the map's SOLIDS are raked so you see a top and a side at once: low top-down.`,
      `- the map's SOLIDS are drawn straight on with no top face showing: side.`,
      `- the map's SOLIDS are seen from directly overhead: high top-down.`,
      `- a SILHOUETTE takes whatever that painting gives its trees and masts, which is very ` +
        `often flat-on even where its solids are raked. The two families disagreeing inside one ` +
        `painting is normal and is not a mistake to correct.`,
      `- a FLAT takes high top-down unless the painting plainly rakes its ground markings too.`,
      `- when the thing's own parts disagree, the SOLID part wins: anything with a real top face ` +
        `you would look down into is a solid, whatever else is attached to it.`,
      ``,
      `Say in the note which family you put it in, what you found already painted in that area ` +
        `of that same family, and how that thing is drawn. If the area holds nothing of that ` +
        `family, widen to the whole map and say so. If the map holds nothing of it anywhere, say ` +
        `"nothing of that family in the map" and fall back to the object's own shape. Never ` +
        `report seeing something you did not see: a guess about the painting is worse here than ` +
        `no look at all.`,
      ``,
      /* The endpoint also takes outline, shading and detail as enums, and this
       * tool has never sent any of them. They were wired and then taken back
       * out the same hour: every object in this library that he has called good
       * was made on the endpoint's own defaults, and three unproven enums went
       * out in the same batch as a change that failed, so nothing could be
       * attributed to them. They are real channels and worth trying one at a
       * time against the defaults. They are not worth changing three at once
       * underneath a route that already works. */
      `THE STYLE FIELD. No projection and no camera in it, and none in the subject either. Not ` +
        `"isometric", not "top-down", not "seen from above", not "three quarter", not "side ` +
        `view". The projection is written in by code from the view you chose, in the one ` +
        `position it belongs, so a word for it here can only be a second camera fighting the ` +
        `first. Begin style at "chunky pixels", then a limited palette named by its real ` +
        `colours, a dark outline named by its colour, the light direction and the shaded side ` +
        `as separate facts, and MUTED saturation. Muted, never saturated. Saturated is what ` +
        `makes a thing sit on the map like a sticker.`,
      ``,
      `One he kept, split into the two fields so the shape is not in doubt.`,
      `subject: "A small wooden rowboat listing on its side, hull of overlapping planks in ` +
        `faded red-brown and bleached tan with peeling paint, one cracked oar laid across the ` +
        `gunwale, coil of frayed rope at the bow, a plank missing amidships"`,
      `style: "chunky pixels, limited warm palette, dark brown outline, lit from the upper ` +
        `left, shaded right, muted saturation"`,
    )
    lines.push(
      ``,
      `Choose the sprite's pixel size so it is in scale with things already there. Say what you ` +
        `measured it against. Both sides must be between 32 and 128: that is the generator's own ` +
        `ceiling, and a bigger number is not honoured, it is quietly cut down to 128. If the thing ` +
        `wants to be taller than it is wide, spend the height and narrow the width.`,
      ``,
      /* the kept ones are 32x32, 40x32, 56x34, 96x72. A bigger canvas does not
       * buy detail, it buys a finer pixel than the painting has, and a thing
       * drawn finer than its map is the exact look of something pasted on. The
       * 128 boat was unusable; the 64 one was right. */
      `Stay SMALL. The ones he kept are 32 to 96 a side and mostly under 72. A bigger canvas ` +
        `does not buy detail, it buys a pixel finer than the map's own, which is what makes a ` +
        `thing read as pasted on top of the painting rather than painted into it.`,
      ``,
      /* WHERE ON THE MAP THIS THING BELONGS, and why it is worth a field.
       *
       * The generator has a prior for every common noun and on the ones it holds
       * hardest the words lose. Measured 2026-08-25: a prompt naming "dusty
       * olive and deep moss green ... muted saturation" returned a cartoon
       * acid-green tree four times out of four, and a puddle prompt returned a
       * bleached sand ring nobody asked for. No wording tested has moved either.
       *
       * The endpoint has a second mode that does not argue with the prior, it
       * overrules it: hand /v2/map-objects a crop of the actual painting as
       * background_image and it paints the object INTO that crop's light,
       * palette and value range. That mode has been wired since the box gesture
       * existed and only ever fired when somebody drew a box, which is a gesture
       * the tool tells them to skip. So the ordinary ask has always landed on a
       * bare canvas with nothing but adjectives holding the line.
       *
       * This field is what turns it on for everything. The model is already
       * looking at the whole painting to write the prompt, so naming the patch
       * costs nothing and no new gesture appears in front of the user. A drawn
       * box still wins when there is one: it is the same answer, given by hand. */
      `WHERE IT BELONGS. Also point at the patch of the painting this thing will live in, as a ` +
        `box in map pixels with 0,0 at the top left. It is not where the user will place it and ` +
        `you are not choosing a spot for them. It is the piece of the painting whose LIGHT, ` +
        `surface and depth of shadow this object should have been painted under, so a boat wants ` +
        `water and a jetty, a market crate wants the town floor, a torch wants somewhere already ` +
        `lit. If a box was drawn, use it. If nothing on this map is right, take the nearest ` +
        `ground the thing could stand on and say so in the note.`,
      `Keep the box roughly two to three times the sprite you asked for and never past the edge ` +
        `of the map. It is read at 1:1, so a box far larger than the sprite hands over scenery ` +
        `instead of a surface.`,
    )
    if (kind === 'animated')
      lines.push(
        ``,
        `This one animates, so also give the motion as movement words alone, no subject: the ` +
          `animator is handed the finished sprite and those words.`,
      )
  }
  /* ONE ASK FOR THE WHOLE CREATURE, and it is the difference between this being
   * usable by a ninth grader and not.
   *
   * "a troll that curls into a boulder, rolls around, then gets up and walks"
   * is one sentence describing three separate jobs: a body, a second face, and
   * a round. Made the long way that is three boxes in three places, and the
   * order between them matters and is not written anywhere, so the first two
   * people to try it will describe the round before the boulder exists and be
   * told, after the fact, that something was missing.
   *
   * The model is already reading the whole sentence to write the prompt. Asking
   * it to split out the faces and the round costs nothing extra and moves the
   * ordering problem to the side that knows the rule, and keeps the whole thing
   * one sentence instead of a row of fields to click through.
   *
   * Both fields are allowed to be empty and usually are. A plain ask for a
   * fisherman is a body and nothing else. */
  if (sprite)
    lines.push(
      ``,
      `SPLIT THE ASK, if it is asking for more than a body.`,
      `Someone describing a creature often describes what it DOES in the same breath, and what it ` +
        `does can need pictures that do not exist yet. Answer those separately so the tool can ` +
        `make them in the right order.`,
      `- "faces": the other pictures this thing needs in order to do what was asked. Each one is a ` +
        `short name and an EDIT of the body you are describing, written as the change and not as a ` +
        `new subject. "curled tightly into a mossy grey boulder", never "a mossy grey boulder". It ` +
        `is drawn by editing the sprite itself, so anything written as a fresh subject throws away ` +
        `the reason it matches. Most asks need NONE and empty is the right answer. Never more than ` +
        `three: each one is a generation.`,
      `- "does": the whole round in plain words, the way somebody would say it out loud, naming ` +
        `the faces you just listed. Empty unless the ask really describes something happening over ` +
        `time. A thing that just stands there or just wanders does not need it.`,
      `A change of picture is not the same as a change of pose. A troll becoming a boulder is a ` +
        `face. A troll pausing, looking around, or walking slower is not, and asking for one wastes ` +
        `a generation on a picture the round will barely use.`,
    )
  if (previous)
    lines.push(
      ``,
      `The last attempt used this prompt and the user rejected it: "${String(previous).slice(0, ASK_MAX)}"`,
      `Work out what about it produced the wrong result and change that. Do not repeat it.`,
    )
  /* The one opinion the router is allowed to have about which mode is open.
   *
   * It never switches, because a switch changes the price and the price is
   * shown on a button the user is about to press. It says so in one line and
   * the plan card prints it. */
  lines.push(
    ``,
    /* THE STILL/MOVING TOGGLE IS ALSO A PRICE, so it gets the same treatment as
     * the mode: the router notices and says so, and never switches.
     *
     * Somebody typing "a troll that curls into a boulder and rolls around" has
     * described walking twice and may still have the toggle on still, because
     * the toggle was set before the sentence was. Left alone that returns a
     * troll with no walk cycle and nothing said about it, and the round then
     * slides a standing sprite around the map. It is exactly the kind of thing
     * the person should not have to know, and exactly the kind of thing that
     * cannot be silently corrected: still is one generation and moving is nine. */
    sprite && kind !== 'animated'
      ? `crossing: EMPTY unless one of two things is true. (a) This ask would clearly be better as ` +
        `a flat prop: a thing with no body that never turns to face anything is a prop, and a prop ` +
        `is one generation instead of nine. (b) The ask plainly describes the thing MOVING under ` +
        `its own power, walking, running, lumbering, prowling, and "still" is selected, so it will ` +
        `come back with no walk cycle. Say which in one short lower-case line, starting with the ` +
        `word "moving" for case (b), and leave the rest of the answer exactly as it is. Never ` +
        `switch either one yourself: both change the price on a button somebody is about to press.`
      : sprite
      ? `crossing: EMPTY unless this ask would clearly be better as a flat prop. A thing with no ` +
        `body that never turns to face anything is a prop, and a prop is one generation instead ` +
        `of nine. Say so in one short lower-case line and leave the rest of the answer as a sprite.`
      : `crossing: EMPTY unless this ask would clearly be better as a sprite. A sprite is drawn on ` +
        `a skeleton and comes back in eight rotations of the same body, which is what something ` +
        `that walks around and faces where it is going needs. A prop gives you one flat png. Say ` +
        `so in one short lower-case line and leave the rest of the answer as a prop.`,
    ``,
    `Answer with ONLY this JSON, no prose:`,
    sprite ? SPRITE_ANSWER : OBJECT_ANSWER,
  )
  const raw = await runPlanner(lines.join('\n'), 240000, job)
  // a sprite still answers one finished prompt; an object answers the two
  // halves and never the joined sentence, so the anchor moves with it
  const o = planJSON(raw, sprite ? 'prompt' : 'subject')
  if (!o || !(sprite ? o.prompt : o.subject)) throw new Error('the interpreter did not answer')
  const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n)
  const view = sprite ? '' : objectView(o.view)
  const plan = {
    kind: sprite ? 'sprite' : 'object',
    prompt: sprite ? clean(o.prompt, PROMPT_MAX) : objectPrompt({ subject: o.subject, style: o.style, view }),
    motion: clean(o.motion, 160),
    /* The note is the only line the plan card prints for an object, so it is
     * the whole of what a person reads before spending. It was 240 and the
     * camera reason pushed straight through it. Measured over 24 free reads
     * after this change, object notes ran 193 to 373 characters and 17 of 24
     * were over 240, and the part that fell off the end was the SIZING half,
     * which is the half someone can act on. 400 holds all 24 with room. The
     * same 24 reads on the old text ran 133 to 240 and never once needed more,
     * so this is the camera reason's own cost and not a general creep. A
     * sprite's note stays at 240: its routing reason has its own field. */
    note: clean(o.note, sprite ? 240 : NOTE_MAX),
    crossing: clean(o.crossing, 200),
    w: clampPx(o.w),
    h: clampPx(o.h),
  }
  // the decision, carried on the plan so the ui can print it. It is not how the
  // camera reaches the generator: see viewFor.
  if (!sprite) plan.view = view
  // the patch of painting this thing joins. A box the user drew by hand wins,
  // because it is the same answer given with more certainty behind it.
  if (!sprite) plan.where = box && box.x != null ? { ...box } : cleanBox(o.where)
  // both halves go to the walk gate: the ask names the thing, the prompt is
  // where a hovering, winged or legless one gets described at length
  if (sprite) plan.sprite = spriteRoute(o.sprite, kind, plan.motion, `${ask} ${plan.prompt}`)
  /* The extra pictures and the round, carried so ONE press can do all of it in
   * the order that works. Held to three because each is a generation and the
   * cost line has to be true. An edit with no words in it is dropped rather
   * than sent: a blank edit_description is a 422 charged after the queue. */
  if (sprite) {
    const faces = []
    for (const f of Array.isArray(o.faces) ? o.faces.slice(0, 3) : []) {
      const name = cleanName(f && f.name)
      const edit = clean(f && f.edit, 300)
      if (name && edit) faces.push({ name, edit })
    }
    if (faces.length) plan.faces = faces
    const does = clean(o.does, 400)
    if (does) plan.does = does
  }
  return plan
}

const OBJECT_ANSWER =
  `{"kind":"object","view":"one of ${OBJECT_VIEWS.join(' | ')}",` +
  `"subject":"the thing and its own materials, 30 to 70 words, no projection wording",` +
  `"style":"chunky pixels, ... , muted saturation, and no projection wording",` +
  `"w":96,"h":128,"where":{"x":0,"y":0,"w":0,"h":0},` +
  `"motion":"movement words only, or empty","crossing":"",` +
  `"note":"one short line, lower case: the camera you chose and why, and what you sized it against"}`

const SPRITE_ANSWER =
  `{"kind":"sprite","prompt":"the full character description, 30 to 70 words","w":48,"h":48,` +
  `"motion":"","note":"one short lower-case line on what you decided","crossing":"",` +
  `"faces":[{"name":"boulder","edit":"curled tightly into a mossy grey boulder"}],` +
  `"does":"the whole round in plain words, or empty",` +
  `"sprite":{"skeleton":"mannequin","view":"low top-down","size":48,` +
  `"anim":{"how":"action","action":"...","frames":8},"why":"one short lower-case line"}}`

/* THE SPRITE HALF OF THE PROMPT, which is where the narrowing used to live.
 *
 * It used to be four dropdowns: person or animal, which of five animals, walks
 * or stands, and a view. Every one of them was a list of what can exist, and a
 * list of what can exist is always shorter than what someone can imagine. A
 * dragon is not on it. Nor is a robot, a ghoul or a hooded figure.
 *
 * So the dropdowns are gone and this text is what replaced them. The user types
 * what they want and the model reads the map and works out the rig, the motion,
 * the size and the angle. The only enumeration left is the six skeletons, which
 * is not a taste, it is the complete set pixellab has. */
function spriteLines(kind) {
  return [
    ``,
    `This one is a SPRITE. Pixellab builds it as a character with a skeleton and eight rotations ` +
      `of the same body, not as a flat prop.`,
    ``,
    `There are exactly six skeletons and no others: mannequin (upright, two arms, two legs) and ` +
      `the four-legged bear, cat, dog, horse and lion. There is no dragon skeleton, no robot ` +
      `skeleton, no bird and no serpent. Pick the NEAREST one by BODY PLAN, never by species. ` +
      `Upright with arms is mannequin whether it is a person, a robot, a ghoul, a suit of armour ` +
      `or a hooded figure. Four legs under a horizontal spine picks the quadruped whose build is ` +
      `closest: a wolf is dog, a heavy-shouldered beast is bear, a big cat or a four-legged dragon ` +
      `is lion, a long-legged one is horse. Something with no legs at all still has to name one, ` +
      `so pick the closest posture and say which in why.`,
    ``,
    `The skeleton is only a rig. It does not decide what the thing looks like, the prompt does. If ` +
      `the nearest rig is a person and the ask is a machine, write the prompt so the result reads ` +
      `unmistakably as a machine: plated panels, exposed joints, a lens where a face would be. ` +
      `Never let the rig leak into the words.`,
    ``,
    kind === 'animated'
      ? `Motion. The user asked for it MOVING, so work out what moving MEANS for this thing.\n` +
        `- Two legs, mannequin, ordinary walking, one foot in front of the other: use a named ` +
        `template, {"how":"template","template":"walking-8-frames"}, and the template must be ` +
        `exactly one of: ${WALK_TEMPLATES.join(', ')}.\n` +
        `- ANYTHING ELSE uses a written action: ` +
        `{"how":"action","action":"hovering in place, wings beating slowly","frames":8}. A dragon ` +
        `does not walk, it hovers and beats its wings. A ghoul lurches. A robot that does not ` +
        `stride has its servos idle and its head pan. A four-legged skeleton ALWAYS uses a ` +
        `written action, because quadruped templates are named per body and cannot be known ` +
        `before the body exists.\n` +
        `- the action is movement words only, 4 to 14 words, no subject and no scenery, and it ` +
        `has to LOOP: whatever it does, it comes back to where it started.\n` +
        `- frames is 4 to 16 and even. 8 unless the movement needs more.`
      : `Motion. The user asked for it STILL, so answer {"how":"none"}. It still comes back in ` +
        `eight rotations and still faces where it is going; only its legs stay put.`,
    ``,
    `size is the character's own pixel height, ${SPRITE_MIN} to ${SPRITE_MAX}. Pixellab pads about ` +
      `40% past it for animation headroom. 40 to 56 for a person standing on this map, more only ` +
      `if the thing is genuinely bigger than a person there. w and h are the same number as size.`,
    ``,
    `view is one of ${CHAR_VIEWS.join(', ')}. Almost always low top-down, because that is the ` +
      `angle this map is painted at. Answer anything else only if the ask cannot work at that ` +
      `angle, and say why.`,
  ]
}

/* The routing decision, held to what the endpoint will actually take.
 *
 * Every clamp here is a generation. A skeleton that does not exist, a template
 * id that was invented, a quadruped handed a humanoid walk: each of those is a
 * 422 that arrives AFTER the body has been drawn and paid for. So a wrong
 * answer is corrected into the nearest honest one rather than sent.
 *
 * subject is the words this route is allowed to judge the motion against: what
 * the person asked for and what the router then wrote about it. The walk gate
 * reads it. */
function spriteRoute(raw, kind, motion, subject) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const skeleton = SKELETONS.includes(String(s.skeleton)) ? String(s.skeleton) : 'mannequin'
  const view = CHAR_VIEWS.includes(String(s.view)) ? String(s.view) : OBJECT_VIEW
  const n = Math.round(Number(s.size))
  const size = isFinite(n) && n > 0 ? Math.max(SPRITE_MIN, Math.min(SPRITE_MAX, n)) : 48
  return {
    skeleton,
    view,
    size,
    anim: spriteAnim(s.anim, kind, skeleton, motion, subject),
    why: String(s.why || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  }
}

/* how the thing moves, and the demotions that save a paid body.
 *
 * A template id off the list is the cheap, proven path and is left alone. A
 * name that is not on the list, or any template at all on a four-legged rig,
 * becomes written motion instead: v3 takes any words at all, so it is the
 * honest fallback rather than a refusal.
 *
 * A still ask that came back with motion anyway is left still, and a moving ask
 * that came back with none is left at none. Both are the router's call and the
 * price is recomputed from what it actually said, so the button never promises
 * nine and buys one.
 *
 * The last-resort words are deliberately not "walking". Nothing here knows what
 * the thing is, and a default that walks is the one assumption this whole path
 * exists to get rid of: it would put a dragon on its feet. Neutral words let v3
 * work it out from the body it was handed.
 *
 * ask is what the person typed plus what the router wrote about it, and it is
 * here so the walk can be checked against the thing rather than trusted to the
 * prompt. See NO_WALK. */
function spriteAnim(raw, kind, skeleton, motion, ask) {
  const a = raw && typeof raw === 'object' ? raw : {}
  const how = String(a.how || '')
  if (kind !== 'animated' || how === 'none') return { how: 'none' }
  const f = Math.round(Number(a.frames))
  const frames = isFinite(f) && f >= 4 ? Math.min(16, f % 2 ? f + 1 : f) : 8
  const written = (words) => ({ how: 'action', action: String(words).slice(0, 300), frames })
  const said = String(a.action || '').replace(/\s+/g, ' ').trim()
  /* WRITTEN MOTION IS TERMINAL, and this branch exists to make that structural.
   * The router said this thing does not walk, so a walk is the one thing it
   * cannot be handed from here, whatever else is wrong with the answer. An
   * action with no words in it is a broken answer and says so out loud: the
   * only other move is a guess, and the guess this whole path exists to stop is
   * a walk. The read is free, so what saying no costs is one more press. */
  if (how === 'action') {
    const words = said || motion
    if (!words) throw new Error('the router asked for written motion and wrote no motion words')
    return written(words)
  }
  /* THE TEMPLATE GATE, four facts now and not two. The router has to have asked
   * for a template out loud, the rig has to be the upright one, the id has to be
   * real, and the THING has to be something that walks. The last one is the new
   * one: without it a dragon on a mannequin rig walked, because every other
   * check was about the request rather than about the dragon. */
  const tpl = String(a.template || '').toLowerCase().trim()
  const onFeet = walksOnFeet(ask)
  if (how === 'template' && skeleton === 'mannequin' && WALK_TEMPLATES.includes(tpl) && onFeet)
    return { how: 'template', template: tpl }
  /* The demotion cannot hand the walk straight back in words. Refusing the
   * template and then writing "walking steadily" is the same answer spelled
   * differently, so for a thing that does not walk any candidate carrying walk
   * words is dropped and the neutral line stands instead. */
  const clean = (w) => (w && !(onFeet ? false : WALK_WORDS.test(w)) ? w : '')
  return written(clean(said) || clean(motion) || 'moving in place, ending where it began')
}

/* Fill a boxed area: one look, a whole scene's worth of things planned at once.
 *
 * Same principle as one asset — the model gets the painting and the boxed crop
 * rather than a description of them — but here it also decides WHAT BELONGS and
 * WHERE each one stands, which is the part a person would otherwise do by
 * placing forty sprites by hand.
 *
 * Positions come back in the box's own pixels so nothing has to be told the
 * map's coordinate system. Every item carries its own finished prompt, because
 * a set of things wants variety: three palms that are the same png three times
 * is a worse answer than three palms drawn differently. */
async function planScene({ ask, id, mapFile, boxFile, box, count, kind, job }) {
  const lines = [
    `You are filling one area of a hand-painted pixel-art game map with objects. Read the two ` +
      `image files below ONCE EACH with the Read tool, then answer in your next message. Do not ` +
      `read them again to check yourself and do not open anything else: one look at each is all ` +
      `this needs.`,
    ``,
    `The whole map, absolute path:`,
    mapFile,
    ``,
    `The area to fill, shown at 2x, absolute path:`,
    boxFile,
    `That area is ${box.w} by ${box.h} map pixels. Coordinates you give are inside it: x from 0 to ` +
      `${box.w}, y from 0 to ${box.h}, measured from its top-left.`,
    ``,
    ask
      ? `The person asked for: "${String(ask).slice(0, ASK_MAX)}". Follow it.`
      : `The person did not say what they want, so decide from what the area is and what the rest ` +
        `of the map already has.`,
    ``,
    `Plan exactly ${count} object${count === 1 ? '' : 's'}.`,
    ``,
    `Look at the area first. What is already painted there, what is empty, what is walkable ground ` +
      `and what is water, cliff or roof. Objects go on ground a person could stand on, they do not ` +
      `overlap each other, and they do not cover something the painting already put there. Where ` +
      `things already exist in that area, match their kind and spacing.`,
    ``,
    `Each object's y is where its FEET are, the point it stands on, not its middle.`,
    ``,
    `Vary them. A row of the same thing at the same size reads as a copy-paste. Change the ` +
      `species, the size, the lean, the age between them.`,
    ``,
    `Every prompt goes to a generator that draws every noun it is given and understands no ` +
      `negation or context. Any ground, place or setting word comes back as a disc of sand or ` +
      `stone under the object. Name the object and its own materials only, and write each one ` +
      `so the result looks painted by the same hand as this map: its light direction, its value ` +
      `range, its outline treatment, its saturation, its pixel chunkiness.`,
    ``,
    /* The fill path used to say nothing at all about projection while its items
     * went out on the same hardcoded camera as everything else, so it was the
     * worst of the three prompt writers: a free wording and a fixed parameter.
     * It answers the same field the single ask does, PER ITEM, because a stall
     * and the palm beside it do not want the same camera and the whole point of
     * this is that the answer is per thing. */
    `THE CAMERA, per object, one of exactly three: ${OBJECT_VIEWS.join(', ')}. Decide it from ` +
      `each THING'S SHAPE and never from what it is called. If its top is a different surface ` +
      `from its sides, a roof or a deck or a lid or a face you would look down into, that is ` +
      `low top-down. If it has no top worth seeing and stands taller than its footprint is ` +
      `wide, that is side, which is how the palm belt on this map is drawn. If it has no top ` +
      `worth seeing and lies in the ground, that is high top-down. When the parts of one thing ` +
      `answer differently the top wins. Two things side by side in this area can and often ` +
      `should answer differently.`,
    ``,
    `subject and style are TWO FIELDS and you never join them. subject is the thing and its own ` +
      `materials; style begins at "chunky pixels" and carries the palette, the outline colour, ` +
      `the light direction, the shaded side and MUTED saturation. Put NO projection or camera ` +
      `wording in either one: code writes the projection in from the view you chose, and a ` +
      `second wording for it can only fight the first.`,
    ``,
    `Sizes are in pixels, both sides between 24 and 128, and in scale with what is already in the ` +
      `area.`,
    kind === 'animated' ? `Each one animates, so give motion as movement words alone.` : ``,
    ``,
    `Answer with ONLY this JSON, no prose:`,
    `{"note":"one short lower-case line on what you decided","items":[{"what":"two or three words ` +
      `naming it","view":"one of ${OBJECT_VIEWS.join(' | ')}","subject":"the thing and its own ` +
      `materials, 25 to 60 words","style":"chunky pixels, ... , muted saturation","w":64,"h":80,` +
      `"x":0,"y":0,"motion":""}]}`,
  ].filter((l) => l !== null)
  const raw = await runPlanner(lines.join('\n'), 300000, job)
  const o = planJSON(raw, 'items')
  if (!o || !Array.isArray(o.items) || !o.items.length) throw new Error('the interpreter did not answer')
  const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n)
  const num = (v, lo, hi, d) => {
    const n = Math.round(Number(v))
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d
  }
  const items = o.items.slice(0, count).map((it) => ({
    what: clean(it.what, 60) || 'a thing',
    // one assembler for every object prompt this file writes, so a filled area
    // and a single ask cannot end up with two different ideas of the camera. An
    // older answer that still writes one finished prompt is taken as it comes
    // and lands on the fallback view, which is what it got before.
    prompt: it.subject
      ? objectPrompt({ subject: it.subject, style: it.style, view: it.view })
      : clean(it.prompt, PROMPT_MAX),
    view: objectView(it.view),
    motion: clean(it.motion, 160),
    w: num(it.w, 24, 128, 64),
    h: num(it.h, 24, 128, 80),
    x: num(it.x, 0, box.w, Math.round(box.w / 2)),
    y: num(it.y, 0, box.h, Math.round(box.h / 2)),
  }))
  return { note: clean(o.note, 240), items: items.filter((i) => i.prompt) }
}

async function translateAsk(ask, kind, styleClause, id, job) {
  // the style card's one line, riding INSIDE the assembled prompt rather than
  // hanging off the end of it, so the refusal of ground stays last where the
  // proven prompts put it.
  //
  // It does NOT go on everything. The clause says "look like you came off this
  // island", which is right for a palm and wrong for a magic rune, so the
  // interpreter also says how much the thing belongs here and the clause is
  // used only at or above BELONGS_MIN. Below it the prompt goes without and the
  // ui says so, so nobody spends a generation without knowing which happened.
  const clause = String(styleClause || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  // no interpreter means no judgement either, and the old behaviour was to
  // always match the map, so a fall-back belongs. The DNA still goes on: a
  // dead interpreter is not a reason to send a prompt that invents a plinth.
  const fallback = {
    thing: housePrompt({ subject: ask, detail: '', palette: 'muted natural palette', clause, view: OBJECT_VIEW }),
    motion: '',
    w: 96,
    h: 96,
    belongs: 1,
  }
  try {
    const raw = await runPlanner(
      `Write the two changing parts of a pixel-art object prompt. A fixed house style is added ` +
        `around them afterwards, so do NOT write anything about projection, light, shading, ` +
        `background or ground: those are already handled and repeating them wastes words.\n\n` +
        `Request: "${ask}"\n` +
        `Kind: ${kind} object for a hand-painted pixel-art game map.\n` +
        keepsHint(id, 'asset') +
        `\n` +
        `The generator draws every noun it is given and cannot understand negation, destination ` +
        `or context. "smoke for the volcano" painted a volcano; "a bird that isn't flying" painted ` +
        `flight.\n\n` +
        `- subject: the ONE object, as a short noun phrase, 3 to 8 words, ending WITHOUT a comma. ` +
        `Strip every destination or scene word (on the roof, for the volcano, at the dock). Strip ` +
        `every word naming the PLACE the object lives in, even used as an adjective: "island palm ` +
        `trees" is "palm trees", "beach hut" is "a small wooden hut". A place word makes the ` +
        `generator draw the place, and it comes back as a disc of sand under the object. Resolve ` +
        `negations into the remaining state (never write "no X" or "without X"). Example: ` +
        `"a tall whitewashed stone lighthouse tower".\n` +
        `- detail: 20 to 45 words of concrete material, colour and construction detail about that ` +
        `object and nothing else, as comma-separated clauses. Name what it is made of, what colour ` +
        `each part is, and two or three specific features a person would notice. No sentences, no ` +
        `adjectives of mood, no scene around it. Example: "slightly weathered white plaster over ` +
        `stone with visible stone blocks at the corners, a warm glowing amber lantern room at the ` +
        `top with small dark window frames, a bronze dome roof, one narrow arched window on the ` +
        `shaft and a small wooden door at the base".\n` +
        `- palette: one short phrase naming this object's colour family, 4 to 10 words, starting ` +
        `with the word "muted". Example: "muted palette of dark basalt, golden timber and teal".\n` +
        `- motion: only for animated — movement words alone (drifting upward, flickering gently). ` +
        `Nothing environmental. Empty for static.\n` +
        `- w,h: canvas in px, 32 to 128. Match the object's real proportions: a tree or a tower is ` +
        `taller than wide, a boat or a bench is wider than tall. 48-64 for small props and ` +
        `critters, 64-96 for ordinary props, 96-128 for anything a character could walk into.\n` +
        `- belongs: 0 to 1, how much this should look like it came from this map. Something that ` +
        `grew or was built there (a palm, a fishing net, a wooden fence) is 1. An everyday object ` +
        `that could sit anywhere (a crate, a barrel) is 0.8. Something with its own identity that ` +
        `arrived from elsewhere (an alien artifact, a magic item, a neon sign) is 0.2.\n` +
        // this path has no map in front of it, so it answers the camera from the
        // thing's shape alone. That is a weaker read than planMake's and it is
        // still the right question, and it is the same three words on the wire.
        `- view: the camera, one of ${OBJECT_VIEWS.join(' | ')}. If its top is a different ` +
        `surface from its sides (a roof, a deck, a lid) it is low top-down. If it has no top ` +
        `worth seeing and stands taller than its footprint is wide it is side. If it has no top ` +
        `worth seeing and lies in the ground it is high top-down. When the parts disagree the ` +
        `top wins. Never write the projection into subject or detail; it is added from this.\n\n` +
        `Answer immediately with ONLY this JSON, no prose:\n` +
        `{"subject":"...","detail":"...","palette":"...","view":"low top-down","motion":"",` +
        `"w":96,"h":128,"belongs":1}`,
      60000,
      job,
    )
    const o = planJSON(raw, 'subject')
    if (!o || !o.subject) return fallback
    const b = Number(o.belongs)
    const belongs = isFinite(b) ? Math.max(0, Math.min(1, b)) : 1
    return {
      thing: housePrompt({
        subject: String(o.subject).slice(0, 120),
        detail: String(o.detail || '').slice(0, 520),
        palette: String(o.palette || 'muted natural palette').slice(0, 120),
        clause: belongs >= BELONGS_MIN ? clause : '',
        view: o.view,
      }),
      motion: String(o.motion || '').slice(0, 120),
      w: clampPx(o.w),
      h: clampPx(o.h),
      belongs,
    }
  } catch (e) {
    /* THE FALL-THROUGH, and it is the whole degraded-routing rule in one place.
     *
     * With no claude there is nobody to rewrite the ask, so the author's own
     * words go to pixellab instead of the request failing. The rule: anything that
     * routes through the model routes straight to pixellab when the model
     * cannot be reached.
     *
     * The difference from the old behaviour is only that it says so. A silent
     * degrade spends a real generation on a worse prompt and leaves the author
     * wondering why the picture got worse. */
    return {
      ...fallback,
      degraded: e instanceof NoPlanner ? e.mode : 'error',
      why:
        e instanceof NoPlanner
          ? e.mode === 'relay'
            ? 'no linked machine answered · your words went straight to pixellab'
            : 'no claude key · your words went straight to pixellab'
          : 'the interpreter could not answer · your words went straight to pixellab',
    }
  }
}

/* ---- the chrome router: an author's sentence becomes a pixellab prompt ----
 *
 * /api/ui/generate posted the author's own words to pixellab unchanged. That is
 * the same mistake the asset stage made and undid: a four-word ask reaches a
 * generator that draws every noun it is given, knows nothing about the piece
 * being a nine-slice, has never seen the chrome the game already ships, and is
 * about to be paid for. 240 generations went on two pieces on 2026-08-30
 * because the prompts were being hand-written in a chat window with none of
 * that in front of whoever wrote them.
 *
 * So this is planMake for chrome, and it is deliberately the SAME architecture
 * rather than a second one:
 *
 *   the author writes a short description
 *   -> claude gets it plus everything the type knows plus the picture of the
 *      chrome the game already ships
 *   -> claude answers TWO FIELDS, subject and style, never a joined sentence
 *   -> code joins them, and code owns the clauses a model forgets
 *   -> pixellab draws it, with the same reference png as style_image
 *
 * WHY TWO FIELDS AGAIN. It is the trick that made the object prompts work: if
 * the model never writes the finished sentence, there is no string it can hide
 * a contradiction in, and the clause that matters most is added by code so it
 * rides every prompt whether the model wrote a good answer or a lazy one. On
 * objects the code-owned clause is the refusal of ground. Here it is the
 * nine-slice law, for exactly the same reason: a model asked to hold seven
 * rules forgets one, and the one it forgot both times was ornament on an edge.
 *
 * WHY THE REFERENCE GOES TO BOTH SIDES. style_image transfers material, the
 * palette, the outline weight, the wear, the motifs, and it transfers NO
 * layout. So it cannot be the thing that keeps ornament out of the middle of an
 * edge, and words cannot be the thing that matches a palette. Both levers, and
 * the model is shown the same picture pixellab will be shown so it is
 * describing a thing it has actually looked at.
 *
 * This is NOT the /v2/map-objects trap. There, background_image made the
 * endpoint continue a picture it was given and a bookshelf came back as roof
 * tiles. There is no subject in a style_image and nothing for it to continue,
 * which pixellab.mjs already says at the field.
 */
const CHROME_DIR = path.join(ROOT, 'public', 'chrome')

/* The picture of the chrome the game already ships, read off disk by TYPE.
 *
 * Missing is survivable and has to be said out loud rather than swallowed: the
 * router still runs, the prompt is still written with the type's constraints in
 * it, and the one lever that would have matched the palette is simply absent.
 * An author reading "no reference" knows why the colours drifted. */
export function chromeStyle(type) {
  const file = chromeRef(type)
  // the two types named so nobody generates them answer null rather than a
  // fallback, and path.join on a null is a throw rather than a missing reference
  if (!file) return null
  const full = path.join(CHROME_DIR, file)
  try {
    const buf = fs.readFileSync(full)
    if (buf.length < 24) return null
    return { file, path: full, base64: buf.toString('base64'), w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  } catch {
    return null
  }
}

/* The question, built and kept pure so it can be read without spending
 * anything. Every fact in it already existed in this process and none of it was
 * reaching the generator. */
export function chromePrompt({ ask, t, width, height, shelf, style }) {
  /* WHICH GENERATOR IS BEING WRITTEN FOR, said first, because the two behave
   * differently enough that a prompt good for one is wasted on the other. The
   * panel route scaffolds from a fixed list of interface element names and hands
   * back furniture whatever the words say. The image route draws the words and
   * nothing else, so on a sheet the composition is genuinely the model's to
   * decide and there is no scaffold underneath to catch a vague answer. */
  const lines = [
    t && t.tier === 'sheet'
      ? `You are writing ONE prompt for a pixel-art image generator (PixelLab). It paints whatever it is ` +
        `described, cut out on a transparent canvas. What it is drawing here is a SET OF SMALL MARKS on ` +
        `one canvas, the kind a game draws over a map: little icons and tokens, not a panel, not a ` +
        `window, not a scene, and there is no world in front of it.`
      : `You are writing ONE prompt for a pixel-art UI generator (PixelLab). It draws game interface ` +
        `furniture: a dialogue box, a panel, a button, a gauge. It is not drawing a scene and there ` +
        `is no world in front of it.`,
  ]
  if (style) {
    /* THE PATH LINE IS ONLY THERE WHEN THERE IS A FILE. The reference is
     * normally read off public/chrome and has one; a named map's painting comes
     * out of object storage and has none, and printing an empty line where an
     * absolute path belongs tells a model to go and read nothing. The picture
     * still reaches an account on a key, because it rides in the message. */
    lines.push(
      ``,
      style.path
        ? `The chrome this game ALREADY SHIPS and the look the new piece has to match, absolute path. ` +
          `Read it ONCE with the Read tool, then answer in your next message. Do not read it again to ` +
          `check yourself and do not open anything else: one look is all this needs.`
        : `The look the new piece has to match is attached to this message as an image. Look at it ` +
          `once, then answer.`,
    )
    if (style.path) lines.push(style.path)
    lines.push(
      `It is ${style.w} by ${style.h}. The same picture goes to the generator as a style reference, ` +
        `so you are describing something it will also be looking at. A style reference carries ` +
        `material only, its palette, its outline weight, its wear and its motifs, and carries NO ` +
        `layout at all. So the arrangement is entirely yours to write and none of it comes across ` +
        `on its own.`,
    )
  } else
    lines.push(
      ``,
      `There is no reference picture available on this machine, so describe the material from the ` +
        `words below alone and say so in the note.`,
    )
  lines.push(
    ``,
    `The author asked for, in their words:`,
    `"${String(ask).slice(0, ASK_MAX)}"`,
    ``,
    ...typeBrief(t, { width, height, shelf }),
    ``,
    /* The same shape the object router answers in, for the same reason. See the
     * section comment above: the model never writes the joined sentence, so the
     * nine-slice law cannot be dropped out of it. */
    t && t.tier === 'sheet'
      ? `SHAPE. Answer as TWO FIELDS rather than as one finished sentence. subject: the grid and every ` +
        `mark on it, said one by one and named, how they are laid out in rows, what each one is made ` +
        `of and how it is worn. Describe each mark by its SILHOUETTE, the outline shape a person reads ` +
        `it by, because that is the only thing that tells one from another at this size. style: how ` +
        `they are drawn. Never blend the two and never write the joined sentence yourself. Code joins ` +
        `them and code adds the constraint the picture cannot be drawn without.`
      : `SHAPE. Answer as TWO FIELDS rather than as one finished sentence. subject: the piece and its ` +
        `own materials in physical detail, what it is made of, how it is worn, what the frame is, ` +
        `where the ornament sits, what the middle surface is. style: how it is drawn. Never blend ` +
        `the two and never write the joined sentence yourself. Code joins them and code adds the ` +
        `constraint the piece cannot be drawn without.`,
    ``,
    `THE STYLE FIELD. Begin it at "chunky pixels", then a limited palette named by its real ` +
      `colours, a dark outline named by its colour, the light direction and the shaded side as ` +
      `separate facts, and MUTED saturation. Muted, never saturated. Saturated is what makes a ` +
      `surface sit on the game like a sticker. Name the colours off the reference rather than off ` +
      `a general idea of fantasy chrome.`,
    ``,
    /* THE ONE THING THE GENERATOR VOLUNTEERS UNASKED, and it is worse here than
     * on a map object. Chrome is cut out and laid over a painting, so a
     * background behind it is a rectangle of somebody's idea of a room painted
     * over the island. no_background is sent as well; words are one fence and
     * pixels have to be the other. */
    `THE PIECE ALONE. It is cut out and laid over a game map, so there is no room around it, no ` +
      `desk under it, no wall behind it and no shadow on any surface. Everything outside the piece ` +
      `is transparent. Do not write any word naming a place or a ground: the generator draws every ` +
      `noun it is handed.`,
    ``,
    `NO LETTERING ANYWHERE. Every word in this game is real text drawn by the engine into a marked ` +
      `rectangle. Painted letters are a picture of a word in one language at one length and they ` +
      `cannot be read, translated or changed, and they end up underneath the real sentence.`,
    ``,
    `palette: also answer the palette as its own short phrase, 4 to 10 words, because the ` +
      `generator takes it as a separate field.`,
    ``,
    `Answer with ONLY this JSON, no prose:`,
    t && t.tier === 'sheet' ? SHEET_ANSWER : CHROME_ANSWER,
  )
  return lines.join('\n')
}

const CHROME_ANSWER =
  `{"subject":"the piece and its materials, 30 to 70 words, no lettering and no ground",` +
  `"style":"chunky pixels, ... , muted saturation",` +
  `"palette":"muted ... ","note":"one short lower-case line: what you matched it against"}`

/* A SHEET NEEDS MORE WORDS THAN A PANEL AND FOR ONE REASON: a panel is one thing
 * and a sheet is eight, and every one of the eight has to be named or the
 * generator picks. Thirty to seventy words spread over eight marks is four words
 * each, which is how a compass and a coin come back as the same disc. The
 * ceiling is the same 2000 characters and the subject is the part that gets cut
 * if it overruns, so asking for length here costs nothing that matters. */
const SHEET_ANSWER =
  `{"subject":"the layout in rows, then every mark named one by one with its silhouette, 80 to 160 words, no lettering and no ground",` +
  `"style":"chunky pixels, ... , muted saturation",` +
  `"palette":"muted ... ","note":"one short lower-case line: what you matched it against"}`

/* THE JOIN, and the clause code owns.
 *
 * Kept separate from the ask so the whole assembly can be read and asserted
 * without a planner and without a generation. objectPrompt is the same idea and
 * the same reason. */
export function chromeFinal({ subject, style, t }) {
  const one = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const sub = one(subject).replace(/[.,;:\s]+$/, '')
  const sty = one(style).replace(/^[.,;:\s]+/, '').replace(/[.\s]+$/, '')
  /* THE LAW GOES IN FROM CODE, not from the model, and this is the whole of why
   * the two fields exist. Both failed rolls had the law in front of the person
   * writing the prompt and both dropped it, and a dropped nine-slice law is not
   * a slightly worse picture, it is a picture the game cannot cut. */
  /* THE MIDDLE SENTENCE IS DROPPED ON THE ONE PIECE THAT HAS NO MIDDLE. Reading
   * the twelve grounds side by side made it visible: highlight_edge is drawn
   * with its centre empty, fill:false, because the map shows through it, and the
   * code-owned law was telling it to paint one plain surface in there. Two
   * instructions that cannot both be obeyed is how a generator picks. */
  const law = t && t.tier === 'ground' ? ' ' + (t.fill === false ? RING_CLAUSE : GROUND_CLAUSE) : ''
  const alone = 'the piece alone as a cut-out on a fully transparent background, no lettering of any kind'
  /* THE CLAUSE THAT SEPARATED THE GOOD ROLL FROM THE UNUSABLE ONE, and it is
   * here rather than in the model's answer for the same reason the law is.
   *
   * dialogue_box_v3 came back a kit with the hero panel running off the top of
   * the canvas. v4 differed by an element list AND by a description saying one
   * single complete piece, centred, margin on every side, nothing touching the
   * edge. A model asked to hold seven rules drops one, and the one dropped twice
   * already was about the frame, so this is not left to it.
   *
   * Split in two, because a sheet is not one piece and telling it to be one
   * would refuse the grid that IS the deliverable. The half both tiers share is
   * the crop, which is the half v3 actually died of. */
  /* THE COUNT IS A CODE-OWNED CLAUSE ON A SHEET, and it is here for the reason
   * the nine-slice law is on a ground: it is the rule the picture is unusable
   * without, and the first roll proved a model will not carry it. Eight marks
   * were asked for in a routed prompt that said "two rows of four" and twelve
   * came back. The cut counts shapes and matches them against this same number,
   * so a picture that ignores it cannot be named and is owed a hand cut. */
  const whole =
    t && t.tier === 'sheet'
      ? ` Exactly ${t.faces.length} marks on the canvas, no more and no fewer, and no mark drawn twice.` +
        ' A grid of separate small marks with empty space between them, every mark drawn complete and entirely inside ' +
        'the image, evenly spaced with clear margin on every side, nothing touching the edge of the image and nothing ' +
        /* THE "unless" IS NOT SOFTENING. A chip sheet's marks ARE plates, so the
         * flat version of this clause and the family it was asked for cannot
         * both be obeyed, and two instructions that contradict is how a
         * generator picks. Same shape as the ring clause on highlight_edge. */
        'cut off by it. No frame, border, card or panel around the group, and nothing sits on a plate or inside a box ' +
        'unless the mark itself is a plate.'
      : ' One single complete piece, centred, with margin on every side, nothing touching the edge of the image and ' +
        'nothing cut off by it.'
  /* AND THE INTERIOR NAMED BY CODE. work/.kit/panel.png is the reason: its
   * prompt said parchment out loud, in a sentence a model wrote, and the picture
   * came back brown wood. On a noun pixellab holds a prior for, words lose, so
   * one more adjective in the subject is not the answer. What this buys is that
   * the phrase is in the same fixed place on every roll of the type, next to the
   * clauses that already survive truncation, rather than wherever an answer put
   * it. The reference png is the lever that actually carries material. */
  const inside = t && t.material ? ` The surface inside the frame is ${t.material}.` : ''
  const tail = `${alone}.${whole}${inside}${law}`
  /* THE SUBJECT IS WHAT GETS CUT, NEVER THE TAIL, and the ordinary slice at the
   * end had it backwards. The clauses code owns sit last, so on a long answer a
   * flat truncation takes off the nine-slice law and the transparency, which is
   * precisely the material this function exists to guarantee. The budget is the
   * endpoint's own 2000 rather than the 1200 the map objects use: chrome is
   * carrying a rule as well as a subject. */
  const room = Math.max(0, CHROME_PROMPT_MAX - tail.length - (sty ? sty.length + 2 : 0) - 2)
  const cut = sub.length > room ? sub.slice(0, room).replace(/[\s,;:]+\S*$/, '') : sub
  return `${cut ? cut + '. ' : ''}${sty ? sty + ', ' : ''}${tail}`
}

// the endpoint's own ceiling on `description`, and there is no reason to sit
// under it here: the whole point of this prompt is that it carries a rule the
// model is not trusted to repeat
const CHROME_PROMPT_MAX = 2000

/* The nine-slice law compressed to something that fits in a 2000 character
 * description beside a subject. The long form in ui.mjs is what the model
 * reads; this is what the generator reads, and the generator cannot follow
 * reasoning, only instructions. */
const GROUND_CLAUSE =
  'Ornament only in the four corners. The four edges are plain even runs of one material with ' +
  'nothing centred on them. The middle is one plain surface with nothing drawn in it.'

/* The same law for the one ground drawn round a hole. Its two halves about the
 * corners and the edges are unchanged, because a ring is nine-sliced like every
 * other ground; only the sentence about the middle is replaced, since the
 * middle is the game and anything painted there is paint over Ash's art. */
const RING_CLAUSE =
  'Ornament only in the four corners. The four edges are plain even runs of one material with ' +
  'nothing centred on them. The middle is completely empty and fully transparent, a hole right ' +
  'through the picture, with nothing drawn inside the frame at all.'

/* `think` is runPlanner, and it is a parameter for one reason: the fence in
 * verify-authoring.mjs has to prove this router writes the type's constraints
 * into the prompt, and it cannot prove that by reaching claude. With no account
 * resolved ask() spawns the local cli, which on a host does not exist and on a
 * laptop is a real model call sitting in the middle of a test suite. Same move
 * as localRelay() in planner.mjs: read through a function so a test can put
 * something else there. */
export async function chromePlan({ ask, t, width, height, shelf, style, job, think = runPlanner }) {
  /* WHAT HAPPENS IF THERE IS NO CLAUDE, and it is not a silent fall-through.
   *
   * The rule this repo already follows: anything that routes through the model
   * routes straight to pixellab when the model cannot be reached. The
   * difference from the old behaviour is only that it SAYS SO. A silent degrade
   * spends a real generation on a worse prompt and leaves the author wondering
   * why the piece came back looking like nothing else on the shelf. */
  const raw = String(ask || '').replace(/\s+/g, ' ').trim()
  try {
    /* THE REFERENCE GOES OVER TWICE, ONCE FOR EACH PROVIDER. The cli reads a
     * path with its Read tool and cannot take an attachment; an account with an
     * anthropic key takes the image in the message and has no filesystem to
     * read from. Both are live at once across the platform, so both are sent
     * and whichever one the account is on finds its own. */
    /* 120 SECONDS AND NOT THE 240 THE MAP ROUTERS TAKE, because this whole
     * request has to fit inside one serverless invocation and vercel.json caps
     * that at 300. The generation itself polls for up to 300, so a 240 second
     * think in front of it means the function is killed mid-draw and a paid
     * picture is lost. One small reference png is a much smaller read than a
     * whole map, and the map routers spend most of that budget looking. */
    const answer = await think(chromePrompt({ ask: raw, t, width, height, shelf, style }), 120000, job, null, style ? [style.base64] : [])
    const o = planJSON(answer, 'subject')
    if (!o || !o.subject) throw new Error('the interpreter did not answer')
    return {
      routed: true,
      description: chromeFinal({ subject: o.subject, style: o.style, t }),
      palette: String(o.palette || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      note: String(o.note || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX),
      styleFile: style ? style.file : '',
    }
  } catch (e) {
    return {
      routed: false,
      /* THE CODE-OWNED TAIL RIDES EVEN WITH NOBODY TO WRITE THE PROMPT, and it
       * used to be the bare `raw` string here.
       *
       * The whole reason the router answers two fields is so a model cannot
       * drop the clauses the picture is unusable without. A model being ABSENT
       * dropped all of them: the four words an author typed went out with no
       * nine-slice law, no transparency, no single-complete-piece and no
       * interior, which is a strictly worse prompt than the same four words
       * with a tail on them and costs exactly the same to send.
       *
       * The degrade is still honest and still says so. What it no longer does
       * is throw away the part that never needed claude in the first place. */
      description: chromeFinal({ subject: raw, style: '', t }),
      palette: '',
      note: '',
      styleFile: style ? style.file : '',
      degraded: e instanceof NoPlanner ? e.mode : 'error',
      why:
        e instanceof NoPlanner
          ? e.mode === 'relay'
            ? 'no linked machine answered, so nobody wrote this prompt · your own sentence went straight to pixellab with none of the type rules in it'
            : 'no claude key, so nobody wrote this prompt · your own sentence went straight to pixellab with none of the type rules in it'
          : 'the interpreter could not answer, so nobody wrote this prompt · your own sentence went straight to pixellab with none of the type rules in it',
    }
  }
}

/* A feature that is purely claude has nothing to fall through to, so it says so
 * instead of pretending. 402 rather than 401: the caller is who they say they
 * are, they simply cannot reach the thing this needs. */
function denyNoPlanner(res, what) {
  return send(res, 402, {
    error: `${what} needs claude · add a key in your account, or link a machine`,
    needs: 'claude',
  })
}

// ---- the style card -----------------------------------------------------
// One look at the painting, kept. Everything downstream of here is text, so
// the whole job is turning a picture into one phrase short enough to hang off
// the end of any sprite description. The planner is handed the file's absolute
// path and asked to read it: no crop, no spot, no click, and no image ever
// goes near the generator. Free, and cached, so a map is looked at once.
async function readStyleCard(file, job) {
  try {
    const raw = await runPlanner(
      `Look at this painting and describe ITS OWN look, so a sprite drawn later can be made to ` +
        `belong on it.\n\nThe file, an absolute path, read it first:\n${file}\n\n` +
        `It is one hand-painted pixel-art game map seen from above. Everything you answer has to ` +
        `come from what is actually in that image: its colours, its light, how its edges are ` +
        `drawn. Do not describe what the map is OF, and do not name anything standing on it.\n\n` +
        `palette: its dominant colours in plain words, warm or cool named.\n` +
        `light: the light and the time of day, and which way it falls.\n` +
        `outline: how edges are drawn (a dark outline, a hue-shifted one, none).\n` +
        `scale: how chunky the pixels and the forms are.\n` +
        `clause: ONE compact phrase, 18 words at most, that can be appended to any sprite ` +
        `description so the sprite belongs to this map. Comma-separated attributes only, no ` +
        `sentence, no nouns from the map itself. Shape it like this one: "warm amber golden-hour ` +
        `palette, muted olive foliage, soft 1px hue-shifted outline, chunky pixel forms".\n\n` +
        `Answer immediately with ONLY this JSON, no prose:\n` +
        `{"palette":"...","light":"...","outline":"...","scale":"...","clause":"..."}`,
      180000,
      job,
    )
    const o = planJSON(raw, 'clause')
    if (!o || !o.clause) return null
    const line = (v, n) =>
      String(v || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, n)
    return {
      palette: line(o.palette, 200),
      light: line(o.light, 200),
      outline: line(o.outline, 200),
      scale: line(o.scale, 200),
      clause: line(o.clause, 160),
    }
  } catch {
    return null
  }
}

// ---- the effect planner -------------------------------------------------
// The other half of the assets step, and the free half. Small animated effects
// come out of the generator as garbage every time, because an effect is a
// motion rule over colours, not a picture of a thing. So the renderer is a
// fixed piece of code in the client, and the only judgement left is WHICH rule
// and WHAT numbers. That judgement is one short language-model call with no
// image behind it, and when it is unavailable a keyword match answers instead,
// so the box never dead-ends. Zero pixellab calls live anywhere on this path.

const EFFECT_TYPES = ['flow', 'rise', 'spray', 'twinkle', 'sway', 'glow', 'swirl']

// where each rule starts, mirroring the client renderer's own defaults
const EFFECT_START = {
  flow: { width: 16, height: 64, frames: 8, speed: 1, size: 1, count: 12, direction: 180, spread: 1, intensity: 1 },
  rise: { width: 56, height: 96, frames: 8, speed: 1, size: 1, count: 4, direction: 0, spread: 1, intensity: 1 },
  spray: { width: 40, height: 28, frames: 8, speed: 1, size: 1, count: 12, direction: 0, spread: 1, intensity: 1, churn: true },
  twinkle: { width: 48, height: 32, frames: 8, speed: 1, size: 1, count: 14, direction: 0, spread: 1, intensity: 1 },
  sway: { width: 40, height: 40, frames: 8, speed: 1, size: 1, count: 1, direction: 0, spread: 1, intensity: 1 },
  glow: { width: 48, height: 48, frames: 8, speed: 1, size: 1, count: 1, direction: 0, spread: 1, intensity: 1 },
  swirl: { width: 64, height: 48, frames: 8, speed: 1, size: 1, count: 4, direction: 0, spread: 1, intensity: 1 },
}

// the same keyword list the client carries, so a server the client cannot
// reach and a planner the server cannot reach give the same answer
function guessEffectType(ask) {
  const s = String(ask).toLowerCase()
  if (/smoke|steam|vapou?r|bubble|plume|fume|mist|incense/.test(s)) return 'rise'
  // swirl sits after rise so swirling smoke is still smoke, and before the rest
  // because a vortex has no other word for itself
  if (/swirl|spiral|vortex|portal|whirl|twist|warp|gateway/.test(s)) return 'swirl'
  // twinkle goes before spray on purpose: a sparkle contains a spark
  if (/sparkle|glint|twinkle|shimmer|firefl|star|glitter/.test(s)) return 'twinkle'
  if (/splash|spray|spark|dust|ember|debris|foam|burst/.test(s)) return 'spray'
  if (/fall|river|stream|flow|lava|current|rapid|cascade|waterfall/.test(s)) return 'flow'
  if (/flag|leaf|leaves|sway|foliage|banner|branch|grass|wind|sign/.test(s)) return 'sway'
  if (/glow|lamp|fire|light|torch|lantern|halo|beacon/.test(s)) return 'glow'
  return 'rise'
}

// the same colour ramps the client carries. A plan used to leave the colours
// out entirely, so the renderer only ever saw what the click sampled off the
// painting and "swirling purple portal" came back brown. When the ask names a
// colour, that colour wins, planner or no planner.
const COLOR_RAMPS = {
  purple: ['#f3e6ff', '#c58cf5', '#8a3fd1', '#4a1b78'],
  violet: ['#f3e6ff', '#c58cf5', '#8a3fd1', '#4a1b78'],
  green: ['#eeffe8', '#8ce88a', '#35a83c', '#14501f'],
  blue: ['#e6f2ff', '#7ec4f5', '#2f6fd0', '#123a75'],
  red: ['#fff0e6', '#ff9a6b', '#d8342a', '#6e1410'],
  orange: ['#fff2df', '#ffbe6b', '#ef8419', '#7a3d07'],
  yellow: ['#fffbe0', '#ffe97a', '#e8c022', '#7d6208'],
  pink: ['#ffe9f4', '#ff9ecb', '#e34d92', '#7a1b47'],
  cyan: ['#e4ffff', '#86ecec', '#23aab4', '#0b5158'],
  teal: ['#e2fff7', '#79e0c2', '#1f9c7d', '#0a4a3c'],
  white: ['#ffffff', '#eef1f5', '#c3ccd6', '#7d8794'],
  black: ['#d7dbe0', '#8b929b', '#444a52', '#14171b'],
  gold: ['#fff6d8', '#ffd873', '#d99a1c', '#6d4508'],
}

function guessColors(ask) {
  const m = /\b(purple|violet|green|blue|red|orange|yellow|pink|cyan|teal|white|black|gold)\b/i.exec(String(ask))
  return m ? COLOR_RAMPS[m[1].toLowerCase()].slice() : []
}

// ---- the eighth answer: a written renderer ------------------------------
// The seven rules are a menu, and a menu has a ceiling: a portal was
// impossible until swirl was added by hand, in code, first. So when an ask
// fits none of them the planner writes the renderer, and it runs in a
// sandboxed worker on the client. Nothing here spends anything either.

// where a written recipe starts when the plan leaves a field out
const CUSTOM_START = { width: 64, height: 64, frames: 8, speed: 1, size: 1, count: 8, direction: 0, spread: 1, intensity: 1 }

// names a declared knob cannot take, because the renderer already has them
const CONTROL_TAKEN = new Set([
  'width', 'height', 'frames', 'speed', 'size', 'count',
  'direction', 'spread', 'intensity', 'seed', 'churn', 'custom',
])

/* The knobs a recipe ships for itself, sane. Anything malformed is dropped
 * rather than repaired: a slider with no range is worse than one less slider. */
function cleanControls(v) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(v) ? v : []) {
    if (!raw || typeof raw !== 'object') continue
    const key = String(raw.key || '').trim().toLowerCase()
    if (!/^[a-z][a-z0-9_]{0,15}$/.test(key) || CONTROL_TAKEN.has(key) || seen.has(key)) continue
    let lo = Number(raw.min)
    let hi = Number(raw.max)
    if (!isFinite(lo) || !isFinite(hi) || lo === hi) continue
    if (hi < lo) {
      const t = lo
      lo = hi
      hi = t
    }
    let step = Number(raw.step)
    if (!isFinite(step) || step <= 0) step = (hi - lo) / 100
    let value = Number(raw.value)
    if (!isFinite(value)) value = (lo + hi) / 2
    out.push({
      key,
      label: String(raw.label || key).replace(/\s+/g, ' ').trim().slice(0, 24) || key,
      min: lo,
      max: hi,
      step,
      value: Math.max(lo, Math.min(hi, value)),
    })
    seen.add(key)
    if (out.length >= 5) break
  }
  return out
}

/* Words a drawing recipe never needs, and every way out of the sandbox is
 * spelled with one of them. The worker takes the same doors off at runtime;
 * this is the cheap check in front of it. A recipe that trips it is dropped and
 * the closest built-in answers instead, so the box still never dead-ends. */
const CODE_BAN = /\b(import|require|importScripts|fetch|XMLHttpRequest|WebSocket|EventSource|eval|constructor|postMessage|localStorage|indexedDB|document|window|process|globalThis)\b/

function cleanCode(v) {
  const s = String(v == null ? '' : v)
  if (!s.trim() || s.length > 8000) return ''
  if (CODE_BAN.test(s)) return ''
  return s
}

// hex the planner wrote, sane: #abc is expanded, anything else is dropped
function cleanHexes(v) {
  const out = []
  for (const raw of Array.isArray(v) ? v : []) {
    const s = String(raw).trim().toLowerCase()
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
    if (!m) continue
    const h = m[1]
    out.push('#' + (h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h))
    if (out.length >= 6) break
  }
  return out
}

/* The whole drawing contract, written once. Two places hand it out: the plan
 * that writes a renderer, and the review that rewrites one. They have to agree
 * to the letter, because a revision is dropped into the same sandbox the first
 * draft ran in. */
const CUSTOM_BASE_DOC =
  `code is the BODY of a function with this exact signature, called once per frame:\n` +
  `  (p, colors, api) => void\n` +
  `p holds every number: p.width, p.height, p.frames, p.speed, p.intensity, p.seed, and ` +
  `every knob you declare in controls, under its own key.\n` +
  `colors is the ramp as hex strings, lightest first.\n` +
  `api is the ONLY way to draw. Nothing else exists in there: no document, no canvas, no ` +
  `network, no imports, no require. Math works.\n` +
  `  api.w, api.h                    the canvas in pixels\n` +
  `  api.t                           0 at the first frame, rising toward 1 at the end of the cycle\n` +
  `  api.frame, api.frames           the frame index and the count\n` +
  `  api.colors                      the same ramp\n` +
  `  api.rnd(n)                      a fixed number 0..1 for the whole number n. The same n ` +
  `gives the same number on every frame, so use it for per-particle randomness.\n` +
  `  api.px(x, y, c, a)              one pixel\n` +
  `  api.rect(x, y, w, h, c, a)      a filled rectangle\n` +
  `  api.circle(cx, cy, r, c, a)     a filled disc\n` +
  `  api.blob(cx, cy, r, c, a)       a lumpy disc, for smoke and organic shapes\n` +
  `  api.line(x0, y0, x1, y1, c, a)  a one-pixel line\n` +
  `c is either an index into colors (0 is the lightest) or a "#rrggbb" string. a is opacity ` +
  `0 to 1 and defaults to 1. Everything lands on whole pixels, is clipped to the canvas, and ` +
  `draws over what is already there. There is no smoothing and no gradient.\n\n` +
  `THE LOOP RULE, the one thing that has to be right: draw only from p, colors and api.t. ` +
  `api.t runs 0..1 across the cycle, and what you draw at t = 1 MUST be identical to what ` +
  `you draw at t = 0, so the last frame wraps onto the first with nothing popping. Wrap ` +
  `every position with % 1, or use Math.sin(2 * Math.PI * api.t). Do not place anything from ` +
  `api.frame or api.frames, and keep no state between frames.`

/* THE SPRITE HALF, handed over only when there is actually a sprite.
 *
 * Both pixellab animators redraw a sprite where it stands and neither can carry
 * it anywhere, so travel is not something that can be bought. A recipe that
 * stamps an existing sprite at a position it works out per frame does scatter,
 * circling and darting in one pass and costs nothing. That is the whole free
 * path, and this is the only place the planner is told it exists.
 *
 * It is conditional because a recipe that stamps a sprite that was never passed
 * in draws an empty frame, and most effects are not about a sprite at all. */
const CUSTOM_SPRITE_DOC =
  `\n\nAN EXISTING SPRITE HAS BEEN HANDED TO THE RECIPE, and for this request it is the point. ` +
  `Three more things on api:\n` +
  `  api.hasSprite                   true here, so the calls below draw something\n` +
  `  api.spriteW, api.spriteH        its size in pixels\n` +
  `  api.sprite(x, y, opts)          stamp it with its FEET at x, y. opts is optional: ` +
  `{frame: which of its own frames, defaults to this one, flip: true mirrors it, which is how a ` +
  `walker turns round, alpha: 0 to 1}\n` +
  `Draw the sprite. Do not invent one out of pixels: it is the thing the person already has and ` +
  `it is what they asked to see move. The canvas is the ground it travels over, so make it big ` +
  `enough for the whole path and put the sprite somewhere different on every frame. Everything ` +
  `else you draw is scenery around it, and usually there should be none.\n` +
  `The loop rule still holds and it binds the path: wherever the sprite is at t = 1 it must be ` +
  `exactly where it was at t = 0. A circuit, a there-and-back, or a wrap off one edge and on at ` +
  `the other all close; a one-way walk does not.`

// the two callers hand out the same contract, plus the sprite half when one was
// given. A revision has to read the same document the first draft did.
const customApiDoc = (withSprite) => CUSTOM_BASE_DOC + (withSprite ? CUSTOM_SPRITE_DOC : '')

function fallbackEffectPlan(ask) {
  const type = guessEffectType(ask)
  const own = guessColors(ask)
  return {
    type,
    name: slugName(ask),
    palette: own.length ? 'own' : 'map',
    colors: own,
    params: { ...EFFECT_START[type] },
  }
}

const EFFECT_RANGE = {
  width: [8, 512],
  height: [8, 512],
  frames: [2, 24],
  speed: [0.2, 4],
  size: [0.2, 3],
  count: [1, 64],
  direction: [0, 359],
  spread: [0.1, 3],
  intensity: [0.1, 2],
}

// only the numbers the renderer knows, each held inside its own range, with
// the rule's own start filling in anything the model left out
function cleanEffectParams(raw, start) {
  const out = { ...start }
  const o = raw && typeof raw === 'object' ? raw : {}
  for (const [k, [lo, hi]] of Object.entries(EFFECT_RANGE)) {
    const n = Number(o[k])
    if (!isFinite(n)) continue
    out[k] = Math.max(lo, Math.min(hi, k === 'direction' ? Math.round(((n % 360) + 360) % 360) : n))
  }
  if (o.churn !== undefined) out.churn = !!o.churn
  return out
}

async function effectPlan(ask, colors, id, job, sprite) {
  const fb = fallbackEffectPlan(ask)
  try {
    const raw = await runPlanner(
      `Pick the motion rule for a small looping pixel-art effect and set its numbers. Nothing is ` +
        `drawn and no image is generated: a fixed renderer composes the effect out of the colours below.

` +
        `Request: "${ask}"
` +
        `Colours sampled off the painting at that spot: ${colors.join(' ') || '(none)'}\n` +
        keepsHint(id, 'effect') +
        `\n` +
        `The seven rules:\n` +
        `flow: scrolling streaks in a direction (a waterfall, a river, lava, a rippling banner)\n` +
        `rise: particles climbing, growing and fading out (smoke, steam, bubbles)\n` +
        `spray: particles arcing outward from a source point (a splash, sparks, kicked-up dust)\n` +
        `twinkle: points fading in and out where they stand (sparkles on water, fireflies, glints)\n` +
        `sway: a bend cycle over the pixels already there (foliage, a flag, a hanging sign)\n` +
        `glow: a soft radial brightness pulse (a lamp, a fire, a torch)\n` +
        `swirl: a turning vortex, bands of arcs orbiting a centre (a portal, a whirlpool, a warp gate)\n\n` +
        `Whose colours it is made of:\n` +
        `palette "map": the effect is made OF the place it stands in, so it takes the sampled ` +
        `colours above. Smoke, dust, water spray, steam, falling leaves, kicked-up sand.\n` +
        `palette "own": the effect has its own identity and brings its own colours. A purple ` +
        `portal, green magic, red fire, blue lightning, a cyan hologram.\n` +
        `colors: 2 to 6 hex colours, light to dark, ONLY when palette is "own". If the request ` +
        `names a colour, that colour wins: answer "own" and build the ramp around it.\n\n` +
        `The params, all numbers:\n` +
        `width,height: the sprite canvas in px, 8 to 512. These sit on a small painted map, so keep ` +
        `them small: 12 to 40 wide for a fall, 40 to 90 for a plume, 24 to 64 for a splash.\n` +
        `frames: 8, 12 or 16.\n` +
        `speed: playback rate, 1 normal, 0.5 slow, 2 fast.\n` +
        `size: how big one streak, puff, particle or point is, 1 normal.\n` +
        `count: how many of them, 1 to 48.\n` +
        `direction: degrees, 0 up, 90 right, 180 down, 270 left.\n` +
        `spread: how wide it fans out, 1 normal.\n` +
        `intensity: opacity, 1 normal.\n` +
        `churn: spray only, true adds a sliding foam band where the particles are thrown from.\n` +
        `swirl reads count as how many bands, spread as how far they reach in from the rim, and ` +
        `direction as the tilt of the ellipse. It draws a squashed circle, wider than tall, so ` +
        `give it a landscape canvas near 4:3 and leave size at 1 or it runs off the edges.\n\n` +
        `name: two or three lowercase words joined by hyphens.\n\n` +
        `HOW TO CHOOSE, and this is the important part. The seven are SHORTHAND for vague asks, ` +
        `not a menu to squeeze a specific ask into. Ask yourself: could this rule, at its best ` +
        `numbers, actually look like the thing described?\n` +
        `- A vague ask with no picture behind it ("some smoke", "sparkles on the water", "a bit ` +
        `of spray") takes the matching rule. It is proven, tuned and instant.\n` +
        `- An ask that names a SPECIFIC look gets type "custom" and you WRITE the renderer. If ` +
        `the ask references something real ("like a minecraft nether portal", "like a campfire ` +
        `in stardew", "an eye that blinks"), or describes an arrangement, a shape or a structure ` +
        `("three clouds stacked", "a rectangular churning gateway", "fish darting together"), ` +
        `then no rule can be it, because a rule is one fixed idea with knobs. Write the thing ` +
        `they asked for.\n` +
        (sprite
          ? `- This request is about a sprite that ALREADY EXISTS and has been handed to you (see ` +
            `below). None of the seven can draw it, so the answer here is always "custom".\n`
          : ``) +
        `When in doubt, WRITE IT. A written renderer that misses can be discarded for free; a ` +
        `rule that quietly substitutes its own idea wastes the person's time and looks like the ` +
        `tool ignored them. A measured example: "swirling purple portal like a minecraft nether ` +
        `portal" was answered with the swirl rule and came back as concentric rings, a galaxy, ` +
        `nothing like a nether portal, which is a tall rectangular frame of churning violet with ` +
        `a dark core and brighter threads rising through it. That ask should have been custom.\n\n` +
        customApiDoc(sprite) +
        `\n\n` +
        `controls: 2 to 5 knobs a person can tune, each ` +
        `{"key":"...","label":"...","min":0,"max":10,"step":0.1,"value":3}. key is one short ` +
        `lowercase word the code reads as p.key. Do not use width, height, frames, speed, size, ` +
        `count, direction, spread, intensity or seed: those already exist.\n\n` +
        `Keep the code under about 40 lines. These sprites are small and sit on a painted map, so ` +
        `shapes are a few pixels across and the canvas stays under about 96 either way.\n\n` +
        `Answer immediately with ONLY this JSON, no prose:\n` +
        `{"type":"rise","name":"crater-smoke","palette":"map","colors":[],"params":{"width":56,` +
        `"height":96,"frames":8,"speed":1,"size":1,"count":4,"direction":0,"spread":1,"intensity":1}}\n` +
        `or, for a written one:\n` +
        `{"type":"custom","name":"...","palette":"own","colors":["#eef","#88a"],"params":` +
        `{"width":48,"height":32,"frames":8,"speed":1,"intensity":1},"controls":[{"key":"wobble",` +
        `"label":"wobble","min":0,"max":4,"step":0.1,"value":1}],"code":"for (let i = 0; i < 8; ` +
        `i++) { ... api.px(x, y, 1, 0.9) }"}`,
      60000,
      job,
    )
    const o = planJSON(raw, 'type')
    if (!o) return fb
    const type = String(o.type)
    if (type !== 'custom' && !EFFECT_TYPES.includes(type)) return fb
    // a written recipe that will not pass the front door is no recipe: the
    // closest built-in answers instead, which is the same fall-back a dead
    // planner gets
    const code = type === 'custom' ? cleanCode(o.code) : ''
    if (type === 'custom' && !code) return fb
    let palette = String(o.palette) === 'own' ? 'own' : 'map'
    let cols = palette === 'own' ? cleanHexes(o.colors) : []
    // the colour the ask named wins over a plan that came back without one, so
    // a purple portal is purple even when the planner forgets the field
    if (!cols.length) {
      const named = guessColors(ask)
      palette = named.length ? 'own' : 'map'
      cols = named
    }
    if (type === 'custom') {
      const controls = cleanControls(o.controls)
      const params = cleanEffectParams(o.params, CUSTOM_START)
      const rawP = o.params && typeof o.params === 'object' ? o.params : {}
      // a knob's number rides in params like every other; the control's own
      // value stands in when the plan left it out
      for (const c of controls) {
        const n = Number(rawP[c.key])
        params[c.key] = Math.max(c.min, Math.min(c.max, isFinite(n) ? n : c.value))
      }
      return { type, name: cleanName(o.name || fb.name), palette, colors: cols, params, code, controls }
    }
    return {
      type,
      name: cleanName(o.name || fb.name),
      palette,
      colors: cols,
      params: cleanEffectParams(o.params, EFFECT_START[type]),
    }
  } catch {
    return fb
  }
}

// ---- the review loop ----------------------------------------------------
/* The planner never used to see what it made. It wrote a renderer or a prompt,
 * the tool drew it, and the first pair of eyes on the result belonged to the
 * person being asked to judge it. That is the whole reason effects and objects
 * miss: not that the words were misread, but that nothing checked.
 *
 * Rendering an effect is free and instant, so the tool looks at its own frames
 * and fixes them before anybody is asked anything. Generating an object is not
 * free, so there the look is only a look: which of the ones already paid for is
 * best, and why. NOTHING on this path generates. */

// where the sheets go. Inside work/<id> so they are served and reachable, out
// of the library so they are never listed as assets.
const reviewDirOf = (id) => path.join(WORK, id, '.review')

// how many sheets of one kind stay on disk. They are a record of what was
// looked at, not an archive.
const SHEETS_KEPT = 20

/* The frames as one strip on disk, and its absolute path. The path is the whole
 * point: handing the planner an absolute file to read is the pattern the style
 * card already proved. */
function writeSheet(id, kind, buffers, label) {
  const dir = reviewDirOf(id)
  fs.mkdirSync(dir, { recursive: true })
  let n = 1
  for (const f of fs.readdirSync(dir)) {
    const m = new RegExp('^' + kind + '-(\\d+)\\.png$').exec(f)
    if (m) n = Math.max(n, Number(m[1]) + 1)
  }
  const file = path.join(dir, `${kind}-${n}.png`)
  fs.writeFileSync(file, sheetPNG(buffers, { label, zoom: 3 }))
  for (let old = n - SHEETS_KEPT; old > 0; old--) {
    const f = path.join(dir, `${kind}-${old}.png`)
    if (!fs.existsSync(f)) break
    fs.unlinkSync(f)
  }
  return file
}

// one short line, however the planner phrased it
const oneLine = (v, n = 160) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n)

// what a look answers, sane. Anything that is not a clean revise reads as good,
// because the loop's default has to be "stop", never "keep going".
function verdictOf(o) {
  return String(o && o.verdict) === 'revise' ? 'revise' : 'good'
}

/* A WRITTEN effect, looked at. The strip, the words that asked for it, and the
 * code that drew it all go in; a full replacement body comes back, or nothing
 * because it is already right. The knobs are NOT up for revision: a person may
 * already have turned them, and a body that reads a knob that no longer exists
 * draws an empty frame. */
async function reviewWritten(file, ask, frames, code, controls, params, job, sprite) {
  const knobs = (controls || []).map((c) => `p.${c.key} (${c.label}, ${c.min}..${c.max})`).join(', ')
  try {
    const raw = await runPlanner(
      `Look at what this renderer actually drew and say whether it is what was asked for.\n\n` +
        `The file, an absolute path, read it first:\n${file}\n\n` +
        `It is the ${frames} frames of one small looping pixel-art effect, left to right, blown up ` +
        `3x with no smoothing, on a flat grey field. The grey is the sheet, not the effect: every ` +
        `transparent pixel shows it. The frames play in a loop at about 6 to 12 fps and the sprite ` +
        `sits on a hand-painted game map at ${params && params.width ? params.width : '?'}x${
        params && params.height ? params.height : '?'
      } pixels, so it is small on screen.\n\n` +
        `What was asked for, in the person's own words: "${ask}"\n\n` +
        `The code that drew it, the body of (p, colors, api) => void:\n${code}\n\n` +
        `The knobs it has, which are FIXED and must keep working: ${knobs || '(none)'}\n\n` +
        customApiDoc(sprite) +
        `\n\n` +
        `Judge only what you can see. Does the strip read as the thing that was asked for, at a ` +
        `glance, small? Is anything obviously wrong: nothing drawn, one blob with no structure, ` +
        `the shape running off the canvas, frames that barely differ so it will look frozen, ` +
        `frames that jump so it will not loop, colours that fight the ask?\n` +
        `Be honest and be specific. "good" means you would ship it. If it is close but thin, ` +
        `sparse, too fast, too dark or the wrong shape, that is "revise" and you rewrite the whole ` +
        `body to fix exactly that. Do not rewrite what already works, and do not change the canvas ` +
        `size or the knob names.\n\n` +
        `why: one short line, lowercase, plain words, said as what you did or what you saw. Not a ` +
        `sentence about the code.\n\n` +
        `Answer immediately with ONLY this JSON, no prose:\n` +
        `{"verdict":"revise","why":"the threads were too sparse, made them denser","code":"<the whole new body>"}\n` +
        `or, when it is right:\n{"verdict":"good","why":"reads as what was asked for"}`,
      120000,
      job,
    )
    const o = planJSON(raw)
    if (!o) return null
    const verdict = verdictOf(o)
    return { verdict, why: oneLine(o.why), code: verdict === 'revise' ? cleanCode(o.code) : '' }
  } catch {
    return null
  }
}

/* One of the seven rules, looked at. There is no code to rewrite here, so the
 * answer is better numbers instead, which is the same free improvement without
 * writing a renderer. */
async function reviewRule(file, ask, frames, type, params, job) {
  const start = EFFECT_START[type] || EFFECT_START.rise
  const now = cleanEffectParams(params, start)
  try {
    const raw = await runPlanner(
      `Look at what this effect actually drew and say whether it is what was asked for.\n\n` +
        `The file, an absolute path, read it first:\n${file}\n\n` +
        `It is the ${frames} frames of one small looping pixel-art effect, left to right, blown up ` +
        `3x with no smoothing, on a flat grey field. The grey is the sheet, not the effect.\n\n` +
        `What was asked for, in the person's own words: "${ask}"\n` +
        `The motion rule that drew it: ${type}\n` +
        `Its numbers right now: ${JSON.stringify(now)}\n\n` +
        `The rule itself cannot change and nothing new can be drawn. The only thing you can ` +
        `improve is the numbers:\n` +
        `width,height: the sprite canvas in px, 8 to 512.\n` +
        `frames: 8, 12 or 16.\n` +
        `speed: playback rate, 1 normal.\n` +
        `size: how big one streak, puff, particle or point is, 1 normal.\n` +
        `count: how many of them, 1 to 48.\n` +
        `direction: degrees, 0 up, 90 right, 180 down, 270 left.\n` +
        `spread: how wide it fans out, 1 normal.\n` +
        `intensity: opacity, 1 normal.\n\n` +
        `Judge only what you can see, small and at a glance. Answer "good" if you would ship it. ` +
        `Answer "revise" only when a number would visibly fix it, and then send back the FULL set ` +
        `with the ones you changed changed.\n` +
        `why: one short line, lowercase, plain words, said as what you did or what you saw.\n\n` +
        `Answer immediately with ONLY this JSON, no prose:\n` +
        `{"verdict":"revise","why":"too few puffs, and they died out too low","params":${JSON.stringify(now)}}\n` +
        `or, when it is right:\n{"verdict":"good","why":"reads as what was asked for"}`,
      120000,
      job,
    )
    const o = planJSON(raw)
    if (!o) return null
    const verdict = verdictOf(o)
    return { verdict, why: oneLine(o.why), params: verdict === 'revise' ? cleanEffectParams(o.params, now) : null }
  } catch {
    return null
  }
}

/* WHAT CAME BACK, LOOKED AT. Already paid for, so nothing here generates and
 * nothing here can stop it being saved.
 *
 * It used to answer which one and why, and that was all. Which one is a number
 * between 1 and n, so it could not fail a batch: handed a single rectangular
 * trough it said "1" and wrote a confident line about it. A batch of three
 * broadside ships came back with a favourite ship. So there are two answers
 * now. best is which is closest. verdict is whether any of them will do, and it
 * runs through the same verdictOf the effect reviews use, so an unclear answer
 * reads as good and the loop's default stays "stop" in one place.
 *
 * THE PAINTING RIDES ALONG, and that is the other half. Half of what is wrong
 * with a generated sprite cannot be seen on a grey field: a broadside ship
 * looks like a fine ship until it sits next to a painting that looks down at
 * two to one, and a sprite drawn at a finer pixel than the map's own looks
 * sharper right up to the moment it is pasted on. Twenty generations of
 * broadside ships is the measured cost of not asking. The file is already on
 * disk from the plan that preceded the spend, so asking costs nothing.
 *
 * fix is a corrected prompt and only means anything on a revise. Spending it
 * stays behind the ui's armed confirm. */
/* THE FREE LOOK, and it has to move in the same commit as the camera or it
 * undoes the whole thing one press later.
 *
 * It used to be told the painting "is seen from a low top-down camera at two to
 * one", which is not true of a painting whose palm belt is dead flat; it was
 * told a side elevation is "the failure this question exists for"; and it was
 * then forbidden to write flatness back into the corrected prompt. Measured:
 * handed a legitimately flat fir standing on the hub painting it answered
 * revise 2 out of 2, named "a clean side-elevation fir" as the fault, and its
 * fix asked for the crown "seen mostly from above" with the trunk foreshortened
 * away. It did that even when the ask said to draw it flat like the palms.
 *
 * So the reviewer is handed the camera that was chosen and judges against THAT.
 * The ban on it writing a camera of its own stays, because its fix goes back
 * out as a prompt and the projection is code's to write. */
async function reviewObjects({ file, map, ask, prompt, view, n, what, size, job }) {
  const many = n !== 1
  const lines = [
    `Look at what a pixel-art generator just made and say whether it answers what was asked for.`,
    ``,
    /* two files means the two-file wording, not the one-file wording. A planner
     * handed two images without ONCE EACH re-reads to check itself and burns
     * the whole timeout: measured 300s down to 16s once the words were right. */
    map
      ? `Read the two image files below ONCE EACH with the Read tool, then answer in your next ` +
        `message. Do not read them again to check yourself and do not open anything else.`
      : `Read the image file below ONCE with the Read tool, then answer in your next message. Do ` +
        `not read it again to check yourself and do not open anything else.`,
    ``,
    `What came back, absolute path:`,
    file,
    `${
      many
        ? `It is ${n} candidates side by side, each with its index number drawn over it`
        : `It is one sprite with a 1 drawn over it`
    }, blown up 3x with no smoothing, on a flat grey field. The grey is the sheet, not the art: ` +
      `every transparent pixel shows it.` +
      (what === 'sprite'
        ? ` They came off one character sheet, the same body seen from different headings or part ` +
          `way through a walk, so they are MEANT to look alike. Judge the body, not which of them ` +
          `is prettiest.`
        : ``),
    size
      ? `Each one is really ${size.w} by ${size.h} pixels. That is the size it will be on the map; ` +
        `the 3x is only so you can see it at all.`
      : ``,
  ]
  if (map)
    lines.push(
      ``,
      `The map it has to stand on, absolute path:`,
      map,
      `That painting is the standard. It was painted by hand and a generated thing has to look ` +
        `painted INTO it rather than pasted on top of it. It does NOT have one camera: look at ` +
        `it and you will see its palm belt drawn dead flat with vertical trunks while its houses ` +
        `forty pixels away show two roof faces and a wall receding at two to one. One hand, the ` +
        `projection chosen per object. Judge each thing against the things in there that STAND ` +
        `the way it does, not against a house rule.`,
    )
  lines.push(
    ``,
    `What was asked for, in the person's own words: "${ask}"`,
    `The prompt that drew it: "${String(prompt).slice(0, 700)}"`,
    view
      ? `The camera it was drawn at, chosen for this thing and sent to the generator: ${view}. ` +
        `low top-down is the raked corner that shows a top and a side at once, side is drawn ` +
        `straight on with no foreshortening, high top-down looks straight down at it.`
      : ``,
    ``,
    `Judge only what you can see, and judge it small.`,
    `The sprite on its own: is it the thing that was asked for, does its silhouette read at a ` +
      `glance, is it one thing with nothing else drawn beside it, does it stand on nothing (no ` +
      `ground, no slab, no plinth, no shadow disc), is anything cut off at the edge of the ` +
      `canvas, and is the shading solid rather than muddy.`,
  )
  if (map)
    lines.push(
      `The sprite AGAINST THAT MAP, which is the half a grey field cannot show you. Is it drawn ` +
        `at the camera it was SENT at, and does it read as standing on the same plane as the ` +
        `things in the painting that stand the way it does? A flat thing among the flat things ` +
        `is right, and so is a raked one among the roofs; a raked one standing in the palm belt ` +
        `is not, and neither is a flat one among the houses. That mismatch is the failure this ` +
        `question exists for and it is the common one, because it looks like a perfectly good ` +
        `drawing until it is next to the painting. Is its pixel as chunky as the painting's own, ` +
        `or finer? A thing drawn finer than its map reads as pasted on however good it is. And ` +
        `its light: same direction, same shaded side, same value range, and muted rather than ` +
        `saturated.`,
    )
  lines.push(
    ``,
    `best: the index number of the one closest to the ask${
      many ? `` : `, which is 1 because there is only one`
    }. Naming one is not approving it. Say which is closest even when every one of them is wrong.`,
    `verdict: "good" if you would put the one you named on that map as it stands, and good is the ` +
      `NORMAL answer. A thing plainer or rougher than you would have drawn it yourself is still ` +
      `good, and so is a flat one when flat is the camera it was sent at. Say "revise" only for ` +
      `something a person would see on the map and call wrong: the wrong thing entirely, a ` +
      `camera that is not the one it was sent at, ground or a shadow disc drawn under it, a piece cut ` +
      `off at the canvas edge, or a pixel so much finer than the painting's that it reads as ` +
      `pasted on. Never revise over taste, and never over a detail nobody could see at that size. ` +
      `Both halves matter: a confident line about a rectangular trough is worse than no line at ` +
      `all, and so is nagging about art that would have been fine.`,
    `why: ONE short lowercase line of plain words saying what you saw. On a good, what makes that ` +
      `one the keeper. On a revise, what is wrong with them and what should be done about it. ` +
      `Never a score, never a mark out of anything, never "consider" or "could be improved". Name ` +
      `the thing.`,
    /* THE ONE THING THE REVIEWER MUST NOT DO, and the reason has changed.
     *
     * It is not that a camera in the prompt fights the parameter: 161 of the 739
     * objects on this account say "isometric" while their view parameter says
     * high top-down and they came back fine. It is that the projection is now
     * ONE decision written into the prompt by code, so a camera the reviewer
     * types is the one wording in the whole file that nothing else read. The
     * projection sentence at the front of that prompt is not the reviewer's to
     * edit; everything after it is. */
    `fix: on a revise, a corrected prompt to try instead, in the SAME SHAPE as the one above, ` +
      `changing only what went wrong. Leave the projection wording it opens with exactly as it ` +
      `is, and never write a camera or a projection of your own anywhere in it: no "top-down", ` +
      `no "two to one", no "seen from above", no "three quarter view". Code puts that phrase in ` +
      `from the camera above and nothing else in the tool reads a second one. If the angle is ` +
      `what is wrong, fix it by saying which parts of the thing should be visible and which ` +
      `should be foreshortened, not by naming a camera. EMPTY on a good.`,
    ``,
    `Answer immediately with ONLY this JSON, no prose:`,
    `{"best":1,"verdict":"good","why":"the only one whose shape reads small","fix":""}`,
    `or, when none of them will do:`,
    `{"best":2,"verdict":"revise","why":"all three are raked over onto a corner and the palms ` +
      `they stand among are flat","fix":"<the corrected prompt>"}`,
  )
  try {
    const raw = await runPlanner(lines.join('\n'), 120000, job)
    // anchored on best, because a model asked to look at a strip likes to warm
    // up by saying what it is looking at, and that first little object parses
    // fine while carrying none of the answer
    const o = planJSON(raw, 'best')
    if (!o) return null
    const best = Math.max(1, Math.min(n, Math.round(Number(o.best)) || 1))
    /* A spoken verdict wins, through the same verdictOf the effect reviews use,
     * so "anything unclear means stop" stays one law in one place. An answer
     * with no verdict at all is from before there was one, and back then fix
     * was the only "none of these are usable" channel there was, so a real
     * corrected prompt still has to be heard as a revise. A real corrected
     * prompt is forty to ninety words; anything shorter is the model writing
     * "none" in prose rather than a fix. */
    const fix = oneLine(o.fix, 1200)
    const spoke = typeof o.verdict === 'string' && o.verdict.trim() !== ''
    const verdict = spoke ? verdictOf(o) : fix.length > 40 ? 'revise' : 'good'
    return { best, verdict, why: oneLine(o.why), fix: verdict === 'revise' ? fix : '' }
  } catch {
    return null
  }
}

// ---- what he keeps ------------------------------------------------------
/* Per map, and only ever on a keep. A discard is not taste, it is a miss, and
 * feeding misses back in would teach the tool to repeat them. The list rides
 * into the next ask so a map's asks get more accurate the longer he works on
 * it, and it is capped, so the twentieth keep pushes the first one out. */

const KEEPS_MAX = 20
// how many ride into an ask. Five is enough to show a pattern and short enough
// that the ask in front of them still wins.
const KEEPS_FED = 5

const keepsFileOf = (id) => path.join(WORK, id, 'keeps.json')

function readKeeps(id) {
  try {
    const v = JSON.parse(fs.readFileSync(keepsFileOf(id), 'utf8'))
    return Array.isArray(v) ? v.filter((k) => k && typeof k === 'object' && k.ask) : []
  } catch {
    return []
  }
}

function addKeep(id, rec) {
  const dir = path.join(WORK, id)
  fs.mkdirSync(dir, { recursive: true })
  const list = readKeeps(id).filter((k) => k.name !== rec.name)
  list.push(rec)
  const out = list.slice(-KEEPS_MAX)
  fs.writeFileSync(keepsFileOf(id), JSON.stringify(out, null, 2))
  return out.length
}

// the last few keeps as a paragraph to hang on an ask, or nothing at all. kind
// filters to the half that is relevant: an object ask learns from objects.
function keepsHint(id, kind) {
  if (!id) return ''
  const list = readKeeps(id)
    .filter((k) => k.kind === kind)
    .slice(-KEEPS_FED)
  if (!list.length) return ''
  const lines = list
    .map((k) => `- asked "${oneLine(k.ask, 120)}" and kept ${oneLine(k.prompt, 200) || oneLine(k.name, 60)}`)
    .join('\n')
  return (
    `\nWhat this person has kept on this map, most recent last. It is what their taste actually ` +
    `is, so match it where the ask leaves room. Do not copy the subjects, only the way they land:\n` +
    lines +
    `\n`
  )
}

// ---- reading the planner's reply ----------------------------------------
// The cli's --output-format json wraps the reply in an envelope whose .result
// holds the model's own text, often inside ``` fences. Unwrap that first, then
// pull the first BALANCED { ... } out of whatever is left: an effect plan
// carries a nested params object, and a lazy regex stops at the wrong brace.
/* need names a key the answer must carry.
 *
 * Without it this took the FIRST balanced object in the reply, and a model
 * asked for a list will often warm up with a one-line object, say what it is
 * looking at, and then give the real answer. The first object parsed fine and
 * had none of the work in it, so a good reply read as a failure. With a key to
 * look for, the object that actually answers wins wherever it sits. */
function planJSON(raw, need) {
  const tries = []
  try {
    const wrap = JSON.parse(raw)
    if (wrap && typeof wrap === 'object') {
      const inner = String(wrap.result ?? wrap.text ?? '')
      if (inner) tries.push(inner)
      tries.push(wrap)
    }
  } catch {
    /* not an envelope: the raw text is the reply */
  }
  tries.push(String(raw))
  let loose = null
  for (const t of tries) {
    if (t && typeof t === 'object') {
      if (!need || t[need] !== undefined) return t
      if (!loose) loose = t
      continue
    }
    for (const o of allObjects(String(t))) {
      if (!need || o[need] !== undefined) return o
      if (!loose) loose = o
    }
  }
  return loose
}

/* every balanced JSON object in the text, in order, so the caller can pick the
 * one that actually carries the answer rather than the first one written */
function allObjects(text) {
  const out = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    let str = false
    let esc = false
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (str) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') str = false
        continue
      }
      if (c === '"') str = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        try {
          out.push(JSON.parse(text.slice(i, j + 1)))
          i = j
        } catch {
          /* not json, or truncated: keep looking from the next brace */
        }
        break
      }
    }
  }
  return out
}

// the headless planner call: prompt over stdin, one model for everything.
// Every route that thinks goes through here, so this constant is the whole
// answer to "which model is MAPVIS using".
const PLANNER_MODEL = 'opus' // resolves to claude-opus-5, checked 2026-08-19
/* Every planner process now running, by the job it belongs to, so a person who
 * changed their mind can end it. The interpreter can sit for half a minute
 * looking at a map; without this the only way out was to wait for a thing you
 * no longer want. Killed jobs reject like a timeout does. */
const LIVE = new Map()

/* Jobs that are WAITING ON PIXELLAB rather than on a planner, by the same job
 * id. There is no process to kill here: a generation already asked for is
 * already paid for and finishes on their side whatever we do. What a stop does
 * is end our wait, and, when it lands between the character and its walk, keep
 * the eight animation generations from ever being asked for. That is the whole
 * reason this route carries a job id. */
const WAITING = new Map()

// a wait a stop can end. The second promise never resolves on its own, so the
// only way out other than the work finishing is stopJob rejecting it.
function raceStop(gate, work) {
  if (!gate) return work
  // stopped while the call that started this was still in flight: nobody is
  // waiting on it any more, so swallow whatever it comes back with
  if (gate.off) {
    work.catch(() => {})
    return Promise.reject(new Error('stopped'))
  }
  return Promise.race([
    work,
    new Promise((_, rej) => {
      gate.reject = rej
    }),
  ])
}

/* One gate, for every route that waits on pixellab.
 *
 * There is nothing to kill on this side: a generation already asked for is
 * already paid for and finishes on their side whatever we do. What a stop buys
 * is the generation NOT YET ASKED FOR. So halt() sits immediately before every
 * spend and never after one, and whatever has already landed still gets
 * written to disk. Stopping is not undoing.
 *
 * A job id that is reused across a run of variants is fine: the requests are
 * sequential, so each one registers on the way in and clears on the way out. */
function gateFor(job) {
  const gate = job ? { off: false } : null
  if (gate) WAITING.set(job, gate)
  return {
    gate,
    halt: () => {
      if (gate && gate.off) throw new Error('stopped')
    },
    // only ours: a stop may already have cleared it and the next variant may
    // already have registered its own under the same id
    done: () => {
      if (gate && WAITING.get(job) === gate) WAITING.delete(job)
    },
  }
}

/* BOTH registries, not the first one that answers.
 *
 * One job id can hold a gate and a planner process at the same time: a spend
 * route registers its gate on the way in and then runs the interpreter inside
 * that same job when the client sent a bare ask. Ending only the gate left the
 * planner thinking for its whole timeout with nobody waiting on it. */
export function stopJob(job) {
  let hit = false
  const gate = WAITING.get(job)
  if (gate) {
    gate.off = true
    if (gate.reject) gate.reject(new Error('stopped'))
    WAITING.delete(job)
    hit = true
  }
  const ps = LIVE.get(job)
  if (ps) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(ps.pid), '/T', '/F'], { windowsHide: true })
      else ps.kill()
    } catch {
      /* already gone, which is the outcome asked for anyway */
    }
    LIVE.delete(job)
    hit = true
  }
  return hit
}

/* Ask the planner, whichever provider this account uses.
 *
 * Ten places call this and none of them should know or care whether the answer
 * came from a local cli, the account's own anthropic key, or a laptop that
 * claimed a job row. Keeping the signature is the point: the dispatch changed,
 * the callers did not.
 *
 * A NoPlanner thrown from here is not a fault. It means this account cannot
 * reach claude right now, and the caller decides between falling through to the
 * author's own words and denying a feature that is purely claude. */
async function runPlanner(prompt, timeoutMs, job, user, images) {
  return ask({
    /* THE ACCOUNT COMES FROM THE REQUEST, NOT FROM THE CALLER.
     *
     * user and images were added to this signature when dispatch grew from "run
     * the cli" to "key, relay or cli", and the comment above says keeping the
     * signature was the point because the callers did not change. They did not:
     * all ten pass exactly (prompt, timeoutMs, job). So user arrived undefined
     * every time, ask() took its `if (!user) return viaCli(...)` branch, and
     * every planner call spawned the local claude binary. On a laptop that is
     * invisible, because the binary is there. On Vercel there is no binary, so
     * translate, style-card, asset-plan, life-plan, effect-plan and the reviews
     * were all dead on the host, a stored key was never read, and a relay
     * polled an empty jobs table forever.
     *
     * serve() already resolved the account into the request context for exactly
     * this reason. Reading it here fixes all ten call sites at once and leaves
     * the explicit parameter working for anything that wants to override. */
    user: user || request().user || null,
    prompt,
    timeoutMs,
    images,
    jobKey: job || '',
    // the stop button still has to reach a local process, so the registry that
    // makes that possible is handed the child rather than owning the spawn
    onProcess: (ps) => {
      if (job) LIVE.set(job, ps)
    },
  })
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const ps = spawn(cmd, args, { windowsHide: true })
    let out = ''
    let err = ''
    ps.stdout.on('data', (d) => (out += d))
    ps.stderr.on('data', (d) => (err += d))
    ps.on('error', (e) => resolve({ code: -1, out, err: err + String(e) }))
    ps.on('close', (code) => resolve({ code, out, err }))
  })
}

/* Read once, hand back the same object after that.
 *
 * The ownership check at the door has to see the map id, which lives in the
 * body, and a request stream can only be drained once. Without this the check
 * would consume it and every route after it would wait forever for data that
 * had already arrived. */
function body(req) {
  if (req._body) return req._body
  return (req._body = readBody(req))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > 96 * 1024 * 1024) return reject(new Error('body too big'))
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

const stripDataURL = (s) => String(s).replace(/^data:[^,]+,/, '')
/* A DOT-ONLY ID IS NOT AN ID, it is a step up the tree.
 *
 * The dot is in the keep-set because real slugs carry one (hub-a2.1), but the
 * filter alone let ".." through untouched: measured with node, safeId('..')
 * returned '..' and safeId('.') returned '.'. Every route here builds
 * path.join(WORK, id), and path.join('<repo>/work', '..') is the repo itself,
 * so posting {"id":".."} to /api/export wrote scene.png and map.json into the
 * repo root and then ran fs.rmSync('<repo>/assets', {recursive:true,force:true}).
 *
 * Anything that is only dots becomes 'untitled'. That is one fence; the
 * insideWork assertion below each path is the other, because a fence made of
 * string rules alone has been wrong before. */
const safeId = (s) => {
  const cleaned = (String(s || 'untitled').replace(/[^a-z0-9._-]+/gi, '-') || 'untitled').slice(0, 60)
  return /^\.+$/.test(cleaned) ? 'untitled' : cleaned
}

/* The second fence: the built path really does sit under WORK.
 *
 * Same assertion serveWork makes before it reads a file, applied to the routes
 * that WRITE. WORK + path.sep rather than WORK alone, so a sibling directory
 * that merely starts with the same letters ('work-old') cannot pass. */
const insideWork = (abs) => path.resolve(abs).startsWith(WORK + path.sep)

function send(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj))
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Content-Length', b.length)
  res.end(b)
}
function notFound(res) {
  send(res, 404, { error: 'not found' })
}
