/* the local api: the pixellab token stays in node, sam runs on the gpu, and it mounts into the vite dev server so dev is one command and one port */
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
import { keyFor, lendKey } from './store/auth.mjs'
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

/* scratch for the length of a request; on serverless everything but /tmp is read-only, so writing to ROOT/work would throw */
const WORK =
  process.env.MAPVIS_WORK ||
  (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? path.join(os.tmpdir(), 'mapvis-work') : path.join(ROOT, 'work'))
const PUBLIB = path.join(ROOT, 'public', 'library')

const PYTHON =
  process.env.MAPVIS_PYTHON || 'C:\\Users\\ashcy\\ComfyUI_windows_portable\\python_embeded\\python.exe'
const SAM_CKPT =
  process.env.MAPVIS_SAM_CKPT || 'C:\\Users\\ashcy\\AdventureGame\\.tmp_extract\\sam_vit_b_01ec64.pth'

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' }

/* style ref for the next map: working scene before published, and the size comes off the png header because the generator rejects a mismatch */
async function styleRef(slug) {
  const id = safeId(slug)
  let buf = null
  const local = path.join(WORK, id, 'scene.png')
  /* the local copy is never there on the host, so hydrate: a map saved and never published is still a good reference */
  if (!fs.existsSync(local)) {
    try {
      await hydrateMap(id, path.join(WORK, id))
    } catch (e) {
      console.error('[styleRef] could not hydrate from object storage:', e.message)
    }
  }
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

/* posts whose id is not a map anybody owns, so the ownership gate must not stand in front of them */
/* the import routes are not exempt: sceneId is the target map, and exempting them let a stranger overwrite another account's library */
/* /api/world carries no map id and the gate resolves a missing one to untitled, a real map somebody may own, so it guards itself instead */
/* the ui routes are the same case: a surface belongs to an account, not a map, so they guard themselves with a signed-in check */
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

/* who authors row 1, the ocean /api/v1/world serves, and who may mint or remove core chrome: OCEAN_OWNER then BOOTSTRAP_EMAIL, and with neither set the gate opens */
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

/* which world row this request authors: row 1 for the ocean owner and for an unconfigured laptop, anybody else gets their own on first use */
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

/* resolved once here: a dozen calls deep in pixellab.mjs need the key, and threading it through every signature is how one bills the wrong person */
async function serve(req, res, p, url) {
  /* r2 bills overage and has no spend cap to set, so refusing is correct: a tool that stops working is recoverable and a bill is not */
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
  /* http:true lets mapIdFor tell an anonymous browser from a maintenance script: the script may create maps as bootstrap, the browser must not */
  let ctx = { http: true }
  try {
    const user = await currentUser(req)
    if (user) {
      const how = await keyFor(user.id, 'pixellab')
      // a pasted key or one a linked machine lent: either way the host can call
      ctx = { http: true, user, pixellabKey: how?.key || null }
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

/* a token bucket per address, sized so a real map open never trips it: the hub asks for about 250 pngs at once and /work/ is served before any auth */
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
  /* the post gate below is post-only and slugs are enumerable, so gets that name a map are checked here too; an ownerless map stays open on purpose */
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

  /* ownership is checked once at the door: every write below takes a map id out of its own body, and anonymous still works until a map has an owner */
  if (req.method === 'POST' && !OPEN_POSTS.has(p)) {
    const b = await body(req)
    /* resolved the way the handlers resolve it: b.id alone missed sceneId, and a post with no id let anyone write the map actually called untitled */
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
    /* nothing ever passed generateImage a style ref, so every map went out with none; style is a slug, and styleOptions takes craft with color_palette off */
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

  // free: the confirmed translation is passed into asset-gen verbatim, styleClause and all, so what was shown on the button is what runs
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

  // the painting is read once into a card at work/<id>/style.json, because words alone never carry a look: palms came back bright green. free
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
    const card = await readStyleCard(file, String(b.job || ''), [stripDataURL(b.image)])
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

  // free, nothing here generates. the list endpoint has no search, so all 700 are walked once, held a few minutes and filtered here; a page is 24
  if (p === '/api/account-objects') {
    const all = await accountObjects(url.searchParams.get('refresh') === '1')
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
    // pixellab cuts a name at 30 characters, so the prompt is searched too, but name hits come first or the search reads as broken
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

  // free: a 1-direction object keeps its png under the storage key "unknown" with every rotation url null, so the url is looked for in that order
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

    /* rotations come over as the whole set: a crab survives a left-right flip and a person moon-walks, and the account already holds all eight */
    const rotPlan = await saveRotations(id, d, base)
    if (rotPlan) {
      const item = await writeRotations(id, rotPlan)
      if (item) {
        // on a host the disk is a tmp dir that dies with the request, so an import that ended at disk vanished; push it like any other library write
        await pushLibrary(id, item.name)
        return send(res, 200, { item })
      }
    }

    const src = objectImageURL(d)
    if (!src) return send(res, 404, { error: 'that one has no image yet' })
    const buf = await pixellab.fetchPNG(src)
    const size = pngSizeBuf(buf)
    if (!(size.w > 0 && size.h > 0)) return send(res, 502, { error: 'what came back was not a png' })
    /* the database answers too: libDirOf starts empty every request on a host, so a disk-only walk picks the base name and overwrites the row under it */
    const file = (await freeLibraryName(id, base)) + '.png'
    fs.writeFileSync(path.join(dir, file), buf)
    const name = file.replace(/\.png$/i, '')
    await pushLibrary(id, name)
    return send(res, 200, {
      item: { name, kind: 'static', src: `/work/${id}/library/${file}`, w: size.w, h: size.h },
    })
  }

  // one spend, through the object endpoint not pixflux, which put a palm on a plinth; the ask is interpreted first because "smoke for the volcano" painted a volcano
  /* free and never touches pixellab; it is also the router: for a sprite the plan picks skeleton, camera, size and motion. nothing generates here */
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
    // x and y pin the patch the cohesion crop is taken from; w and h alone still work, the router just picks the spot
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
        // the bytes the files above were written from, so a planner with no
        // disk sees the same pictures the cli reads off it
        images: [mapB64, ...(boxFile ? [boxB64] : [])],
        paths: [mapFile, ...(boxFile ? [boxFile] : [])],
        previous: String(b.previous || ''),
        job: String(b.job || ''),
      })
      return send(res, 200, { plan })
    } catch (e) {
      const m = String((e && e.message) || e)
      return send(res, m === 'stopped' ? 499 : 502, { error: m })
    }
  }

  /* a whole area planned at once, free: it needs a boxed area, because "fill this" has no meaning without a this */
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
        images: [mapB64, boxB64],
        paths: [mapFile, boxFile],
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


  /* free: numbers, never frames, because a wander that returns to its exact start each cycle is a dance. looks[0] is the placement's own picture */
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
    // the same bytes, for a planner that cannot read this disk
    const images = [mapB64]
    const paths = [mapFile]
    const box = b.bounds && Number(b.bounds.w) > 1 ? b.bounds : null
    const walkPct = Math.max(0, Math.min(1, Number(b.walkPct) || 0))
    const walkOnly = !!b.walkOnly
    const thing = String(b.name || 'it').slice(0, 80)
    const at = b.at && isFinite(Number(b.at.x)) ? { x: Math.round(b.at.x), y: Math.round(b.at.y) } : null
    const size = b.size && Number(b.size.w) > 0 ? { w: Math.round(b.size.w), h: Math.round(b.size.h) } : null
    /* the pictures this map holds by name: a name leaves as an index, so one nobody drew has nothing to become; a client sending none still works */
    const fold = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase()
    const sent = new Set((Array.isArray(b.names) ? b.names : []).map(fold).filter(Boolean))
    /* a thing's own faces, not the whole library, so "which boulder" cannot be asked; the library is the fallback for a row with no faces of its own */
    const owner = cleanName(b.owner || '')
    /* the store's listing: libraryItems walks a tmp folder empty every request on the host, so a round was planned with no faces and never changed picture */
    const lib = platformOn() ? await libraryOf(id) : libraryItems(id)
    const mine = owner ? (lib.find((x) => x.name === owner) || {}).states || [] : []
    const onDisk = mine.length
      ? mine.map((f) => String(f.name || '').trim()).filter(Boolean)
      : lib.map((it) => String(it.name || '').trim()).filter(Boolean)
    /* bounded by characters because the prompt is characters; what is cut is counted and named, instead of dropping whatever was last in the directory */
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
          /* a box mostly over walkable floor means a floor, and floors call for unhurried movement: a crab darts, a person crossing a plaza cannot */
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
          /* rock is not a fifth kind: it was in Life and never named here, so a boat asked to rock came back drifting sideways */
          `AND SEPARATELY, on any of the four: rock and rockRate. A tilt, in degrees either side ` +
            `of upright and leans per second. This is how something LEANS rather than travels: a ` +
            `boat at its mooring, a hanging sign, a lantern on a bracket. It rides on top of the ` +
            `kind you chose, so a moored boat is drift with a small rock, and a sign that never ` +
            `moves at all is drift with driftX and driftY at zero and a rock on top. Gentle is ` +
            `right: 2 to 5 degrees and about a third of a lean a second reads as water. Ten ` +
            `degrees reads as a storm.`,
          ``,
          /* a sequence is not a fifth kind either: it rides on whatever kind was chosen, and the flat fields above are the first state */
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
          /* cleanLife refuses a cross inside a state: it is absolute rather than an offset, and measured it put the placement 430px away on a 688px painting */
          `A move inside a state may NOT be a cross. A cross is a one-off pass across the whole ` +
            `painting, which is a thing that appears and leaves rather than a thing that is doing ` +
            `something for a while, so it cannot be one stage of a round. If the ask really is a ` +
            `bird that crosses now and then, that is a cross placement on its own with NO states, ` +
            `not a state inside one.`,
          /* the list is a fence: art leaves as an index, so an invented name has none and that state keeps its picture, which read as a round that never changed */
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
          /* an example that named "mossy boulder" taught it to invent whatever the words said, so with no library to draw from it names nothing */
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
        undefined,
        images,
        paths,
      )
      const o = planJSON(raw, 'kind')
      if (!o || !o.kind) throw new Error('no answer')
      /* a name on the wire, an index in the data: lifeAt runs every frame, so an index is a lookup and a name a search, and looks[0] always draws */
      /* cut to STATES_MAX here where there is somebody to tell: cleanLife cuts it silently, so a seventh state reached the editor and vanished */
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
          // one extra picture per state is the ceiling: looks[0] is the placement itself, so the list is full at STATES_MAX + 1 and past it 0 is the honest answer
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

  /* the characters on the account, free: a character has a skeleton, 4 or 8 directions and walk cycles, where an object is only a prop */
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
          // a pro-mode style reference drags the new sprite to its angle, so a caller has to send the same view or pay for a figure at the wrong pitch
          view: String(c.view || ''),
          thumb: (c.rotation_urls && (c.rotation_urls.south || Object.values(c.rotation_urls)[0])) || '',
        }))
      return send(res, 200, { items, total: items.length })
    } catch (e) {
      return send(res, 502, { error: String((e && e.message) || e).slice(0, 200) })
    }
  }

  /* one character copied in with its walk if it has one, free: one entry per heading, and with no animation it faces where it walks without moving its legs */
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

  /* one for the body plus one per direction, so moving is nine and still is one; the set is trimmed because pixellab's 40% headroom leaves a figure in the air */
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
    /* mannequin and five four-legged bodies are all that exist; the router picks the nearest by body plan, so a robot is a mannequin that reads as a machine */
    const skeleton = SKELETONS.includes(String(b.skeleton)) ? String(b.skeleton) : legacySkeleton(b)
    if (!skeleton) return send(res, 400, { error: 'an animal needs a body: ' + QUADRUPEDS.join(', ') })
    const bodyType = skeleton === 'mannequin' ? 'humanoid' : 'quadruped'
    // written motion is priced by pixel budget per direction, and at or under
    // this it is one generation per direction, which is what the button said
    const size = Math.max(SPRITE_MIN, Math.min(SPRITE_MAX, Math.round(Number(b.size) || 48)))
    /* clamped again because this route is reachable without the router: an invented template id is a 422 after the body is paid for, and a garbled anim lands standing */
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
        /* the body is already paid for, so a motion failure lands standing rather than binning it: a humanoid template id on a quadruped rig is a straight 422 */
        try {
          /* custom mode defaults to south only, so the headings are named out loud or seven of the eight never happen, and they are read off the body that landed */
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
      // every animation on it is the one just paid for, and unnamed the row is the first few words of the ask the way a generated object is named
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
      /* the canvas is settled here alone and both sides even: 150x95 came back "must both be divisible by 2" after the router had spent thirteen seconds choosing it */
      const even = (n) => Math.max(32, Math.floor(clampPx(n) / 2) * 2)
      const w = even(b.w || t.w)
      const h = even(b.h || t.h)
      /* the cohesion crop is dead over 22 generations: handed a picture of somewhere, this endpoint continues it instead of drawing the subject. do not rebuild */
      // the last free moment. Past this line the png is bought whatever happens
      // next, so everything below still writes it to disk.
      halt()

      /* only /v2/map-objects has a view; generate-image-v2 has no camera at all, and a style image carries palette, outline, detail and shading, none of them the angle */
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

  // one spend behind the armed confirm, with a crop for context: bare-canvas pixflux turns small props into mush, and it bills as a static generation
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
      // the cutout becomes the first frame; animate caps first_frame at 256 and the budget at w*h*8 <= 524288, and a 192-cap crop fits both
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
        /* the name is chosen against the store: on the host the folder is empty, so a second take took the same name and replaced the first row */
        const aname = await freeLibraryName(id, wantName)
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

  // two spends: the base is an object because pixflux put the thing on a plinth that then animated with it, and at 128 or less the 8 frames stay one generation
  /* a face is an edit of the row that owns it, so it cannot drift in palette or size and there is no "which boulder"; a character's headings go in one job */
  if (p === '/api/asset-state' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const owner = cleanName(b.name || '')
    const ask = String(b.ask || '').trim()
    if (!owner) return send(res, 400, { error: 'no item' })
    if (!ask) return send(res, 400, { error: 'say what it turns into' })
    /* the item may exist only in the store: readLibItem reads the disk, and on the host work/ is empty, so a listed sprite came back "not in the library" */
    try {
      await hydrateMap(id, path.join(WORK, id))
    } catch (e) {
      console.error('[library] could not hydrate from object storage:', e.message)
    }
    await ensureSidecars(id, owner)
    const it = readLibItem(id, owner)
    if (!it) return send(res, 404, { error: 'that is not in this library' })
    /* origin.json first, then dirs.json's characterId; neither present means imported or hand-made, and the honest answer is no rather than a guess at one of 769 rows */
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
      // the motion rides separately: one merged prompt let a smoke ask that mentioned its volcano generate a volcano, twice
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
      // both spends are bought and WORK is a fresh tmp dir per request on a host, so telling disk alone lost the item with the instance
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

  /* a character's headings go in one job because eight calls come back as eight rhythms; the written path is the only one that travels, and it is free */
  if (p === '/api/asset-animate' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const name = cleanName(b.name || '')
    const ask = String(b.ask || '').replace(/\s+/g, ' ').trim().slice(0, PROMPT_MAX)
    if (!b.name) return send(res, 400, { error: 'no item' })
    if (!ask) return send(res, 400, { error: 'say what it should do' })
    /* the item may exist only in the store: readLibItem reads the disk, and on the host work/ is empty, so a listed sprite came back "not in the library" */
    try {
      await hydrateMap(id, path.join(WORK, id))
    } catch (e) {
      console.error('[library] could not hydrate from object storage:', e.message)
    }
    await ensureSidecars(id, name)
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
        /* frames an earlier attempt bought but could not read back: recovery is offered before the spend rather than as a repair after it */
        let byDir = null
        if (b.recover) {
          // a named group is one this client started and is waiting on; a bare
          // true is the old repair, whatever complete motion is on the account
          const found = await recoverCharacterMotion(plan, typeof b.recover === 'string' ? b.recover : '')
          if (!found) return send(res, 409, { error: 'nothing already paid for was found on this one' })
          byDir = found.byDir
        } else {
          try {
            byDir = await runCharacterMotion(plan, seed, gate, halt)
          } catch (e) {
            if (!(e instanceof Pending)) throw e
            return send(res, 200, {
              pending: true,
              group: e.group,
              plan,
              note: 'pixellab is still drawing · the frames are paid for and will be collected when they are done',
            })
          }
        }
        // past here every generation is bought and every frame is theirs, so
        // the download runs to the end whatever a stop says. Stopping is not
        // undoing.
        const st = await stageViews(id, name, byDir, it.fps || 8)
        if (!st) throw new Error('the headings did not save')
        /* the character id is the only way back to the rig, so never write undefined over one that was there or the motion can never be replaced */
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
      /* a still becomes a frame folder under the same name, and the png goes only once the folder is whole, so a crash leaves the original standing */
      if (it.shape === 'still') await keepPrevFile(id, it.file, name + '.png')
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

  // free either way: when none of the seven rules fits, the answer is a renderer written for the words, and a failure falls back to a keyword match
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

  // frames plus effect.json so it reopens, and overwrite rewrites in place: the urls do not change, and leftover frames are deleted or the folder plays two renders
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
    /* the host's work/ is empty, so pull what the store holds before reading the disk; costs nothing on a laptop */
    try {
      await hydrateMap(id, path.join(WORK, id))
    } catch (e) {
      console.error('[effect-save] could not hydrate from object storage:', e.message)
    }
      await ensureSidecars(id, name)
      const target = path.resolve(dir, name)
      if (!target.startsWith(path.resolve(dir) + path.sep)) return send(res, 400, { error: 'bad name' })
      const asDir = fs.existsSync(target) && fs.statSync(target).isDirectory()
      if (!asDir && fs.existsSync(target + '.png')) wasStill = target + '.png'
      else if (!asDir) return send(res, 404, { error: 'not in the library' })
    } else {
      /* disk for what is mid-request, the database for what exists at all: libDirOf starts empty on a host, so every keep would pick the base name */
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
      await keepPrevFile(id, wasStill, name + '.png')
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
    // a kept effect ending at disk was gone with the request on a host; pushItem carries effect.json across with the frames
    await pushLibrary(id, name)
    return send(res, 200, { item: { name, kind: 'animated', effect: true, frames: rel, fps, w: size.w, h: size.h } })
  }

  // The rule, the numbers and the colours a saved effect was built from, so the
  // tuning panel reopens on exactly what is on disk. Free, and read-only.
  if (p === '/api/effect-read' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const name = cleanName(b.name || '')
    /* the host's work/ is empty, so pull what the store holds before reading the disk; costs nothing on a laptop */
    try {
      await hydrateMap(id, path.join(WORK, id))
    } catch (e) {
      console.error('[effect-read] could not hydrate from object storage:', e.message)
    }
    await ensureSidecars(id, name)
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

  // free: the frames go to disk as one strip and the planner is asked to look, which can run three times before a person judges anything
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
    // the strip's own bytes, for a planner with no disk to read it from
    const sheetB64 = fs.readFileSync(file).toString('base64')
    const custom = String(b.kind || '') === 'custom'
    const type = String(b.type || '')
    const job = String(b.job || '')
    const v = custom
      ? await reviewWritten(file, ask, frames.length, cleanCode(b.code), cleanControls(b.controls), b.params, job, !!b.sprite, [sheetB64])
      : await reviewRule(file, ask, frames.length, type, b.params, job, [sheetB64])
    if (!v) return send(res, 502, { error: 'the planner did not answer', strip: file })
    return send(res, 200, { strip: file, ...v })
  }

  /* free, and it cannot block a save: the item is in the library before this is called, so do not move it in front of the write */
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
    /* the painting the plan already wrote, never box.png: that one is only written when a box was drawn, so it goes stale. missing is fine */
    const mapFile = path.join(WORK, id, '.ask', 'map.png')
    const hasMap = fs.existsSync(mapFile)
    const v = await reviewObjects({
      file,
      map: hasMap ? mapFile : '',
      // the strip and the map as bytes, in the order the prompt names them
      images: [fs.readFileSync(file).toString('base64'), ...(hasMap ? [fs.readFileSync(mapFile).toString('base64')] : [])],
      paths: [file, ...(hasMap ? [mapFile] : [])],
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

  // a crop lands as a new <name>-<suffix> item, so the original is never touched, and every frame arrives at the same rect so the loop stays in register
  /* put the old pixels back from .prev, newest first: undoing only the placement half left nineteen trees looking like they had slid down the map */
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
        await keepPrevDir(id, to, name)
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
        if (fs.existsSync(to)) await keepPrevFile(id, to, name + '.png')
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
    /* the host's work/ is empty, so pull what the store holds before reading the disk; costs nothing on a laptop */
    try {
      await hydrateMap(id, path.join(WORK, id))
    } catch (e) {
      console.error('[asset-crop] could not hydrate from object storage:', e.message)
    }
    await ensureSidecars(id, cleanName(src))
    const taken = (n) => fs.existsSync(path.join(dir, n)) || fs.existsSync(path.join(dir, n + '.png'))
    /* in place by default: an edit that leaves palm, palm-trimmed, palm-trimmed-bit2 is worse than the problem it solved, and the old bytes go to .prev, never listed */
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
      if (fs.existsSync(png)) await keepPrevFile(id, png, name + '.png')
      else await keepPrevDir(id, path.join(dir, name), name)
    }
    /* a set of VIEWS goes back under its own names, not as 0.png, 1.png.
     * Without this an edit on eight-sided art wrote frame files beside the
     * views it was supposed to replace and the item ended up as neither. */
    /* dirKeys runs parallel to frames, so assuming one picture per heading turned dock-porter's east-0..east-7 into one east.png and stopped it walking */
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
      /* an edit is a library write: on a host the disk dies with the request, so awaited, and the response never says it landed before the bytes are durable */
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

  // one item out of the library, held inside work/<id>/library; the delete is final and the ui clears its placements separately
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
    /* not on this disk is not not in the library: on the host every delete of a listed row said "not in the library" while the row was dropped */
    let known = false
    if (platformOn()) {
      try {
        known = (await libraryOf(id)).some((x) => x.name === name)
      } catch (e) {
        console.error('[library-remove] could not read the store listing:', e.message)
      }
    }
    await dropItem(id, name)
    if (known) return send(res, 200, { removed: 'store' })
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

  /* the authoring view of this account's ocean: mine means yours to edit, game means it is the one the ship sails, and /api/v1/world stays open on row 1 */
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
  /* one boolean the home page asks before anything else, kept because a 404 here is a blank card; everybody signed in has an ocean */
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
      /* only a real refusal is a 400: catching everything turned a dropped neon connection into "your composition was rejected", so no problems means 500 */
      if (!e.problems) throw e
      return send(res, 400, { error: String(e.message || e), problems: e.problems })
    }
  }

  /* the ui shelf, keyed to an account and not a map. the word on the wire is region and never slot: a WorldSlot is an island's berth. docs/UI-KIT.md is the authority */
  if (p === '/api/ui' && req.method === 'GET') {
    const me = await currentUser(req)
    /* the type list rides with the shelf, so the page fills the marks in rather than making somebody rediscover them by dragging unlabelled rectangles */
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

    /* a dry run posts nothing and takes no lock: 280 generations went on rediscovering one recipe whose defect was a dropped elements field in the body */
    const dry = b.dry === true || b.dry === 'true'

    /* one press draws one piece: a batch turns one bad prompt into five bad pictures with nobody having looked at the first */
    const asked = [b.pieces, b.names, b.batch].find(Array.isArray)
    if (asked && asked.length > 1)
      return send(res, 400, {
        error: `one press draws one piece, and this asked for ${asked.length} · they get judged one at a time, so the next one starts after this one is looked at`,
      })
    /* any pending row refuses: the same-name exemption let re-arming run two concurrent spends on one row, and pendingUi only sees rows younger than ten minutes */
    const busy = dry ? null : await pendingUi(me.id)
    if (busy)
      return send(res, 409, { error: `"${busy.name}" is still drawing · one at a time, so wait for it and then look at it`, pending: busy })

    /* the type supplies the canvas, the element list and the region vocabulary, and an unknown one is refused inside createUi before anything is spent */
    const t = pieceType(b.type)
    if (b.type && !t) return send(res, 400, { error: `there is no piece type called "${b.type}"` })
    const width = Number(b.width) || t?.w || 0
    const height = Number(b.height) || t?.h || 0

    /* checked before the press: 688x512 reads as 4:3 and is refused with the money committed, and the panel route floors at 192 where the image route floors at 16 */
    const gate = canvasFor(t, width, height)
    if (!gate.ok)
      return send(res, 400, {
        error: `${width}x${height} is not a size this can be drawn at · the nearest legal canvas is ${gate.width}x${gate.height}`,
        canvas: gate,
      })

    /* core is not a flag anybody can set on their own shelf: it belongs to the one account the game reads chrome from, and everyone else adds */
    const core = !!b.core && (await ownsOcean(req))

    /* the reference comes from the type out of public/chrome: it was a slug with no field on the page, so every piece ever drawn here went out with none */
    let style = chromeStyle(t ? t.name : '')
    if (b.style) {
      try {
        const m = await styleRef(String(b.style))
        style = { file: String(b.style), path: '', base64: m.base64, w: m.w, h: m.h }
      } catch (e) {
        return send(res, 400, { error: `style "${b.style}": ${String(e.message || e).slice(0, 160)}` })
      }
    }

    /* elements decides shape and style_image decides material, words decide neither, so a body may turn neither off; a type that sends none says so */
    const elements = t?.elements || null
    /* create-ui-asset is a panel kit generator only: icon sets and chip tokens came back as panels, so sheets go to generate-image-v2, which has no element list */
    const viaImage = usesImageEndpoint(t)
    const levers = {
      route: viaImage ? '/v2/generate-image-v2' : '/v2/create-ui-asset',
      elements,
      elementsWhy: t?.elementsWhy || '',
      styleRef: style ? style.file : '',
      ...(elements ? {} : { noElements: t ? t.elementsWhy || 'this type sends no element list' : 'no type, so no element list' }),
      ...(style ? {} : { noStyleRef: 'no reference art for this type, so nothing carries the material and only the words do' }),
    }

    /* claude writes the prompt with the type, the shelf and the shipped chrome in front of it; it is not a gate, and a bare ask says so on the answer */
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
      /* only pieces is a shape template: forwarding names or batch got every entry refused as "not a valid dictionary" with nothing the author could act on */
      pieces: Array.isArray(b.pieces) && b.pieces.length === 1 ? b.pieces : null,
      // the same picture the router looked at. Two levers and they do
      // different jobs: this one carries material and no layout, the words
      // carry layout and cannot carry a palette.
      styleImageBase64: style ? style.base64 : undefined,
      name: pieceName,
    })

    /* a different set of fields: the image route takes a ReferenceImage with its size where the panel route takes a bare Base64Image, and crossing them is a 422 */
    const sheetAsk = (plan) => ({
      description: plan.description,
      width,
      height,
      styleImage: style ? { base64: style.base64, w: style.w, h: style.h } : null,
    })

    if (dry) {
      const plan = await chromePlan({ ask: description, t, width, height, shelf, style, job: `ui:dry:${name || t?.name || 'piece'}` })
      const wire = viaImage ? pixellab.sheetBody(sheetAsk(plan)) : pixellab.uiAssetBody(askFor(plan, name || t?.name || 'piece'))
      /* the picture is shown as its length: 60 to 200 KB of one line buries the fields, and what matters is that it is there and in its own route's shape */
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

    /* the row exists before the picture: the call takes a minute and a half and a spend that produced nothing has to be visible afterwards */
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
      /* the pixellab id is kept: this used only b64, width and height, so pixellab_id was empty on every row ever produced and no chrome traced to its spend */
      /* whichever id the route that drew it hands back: a ui_asset_id from the panel route, a job id from the image route */
      const saved = await setUiImage(me.id, row.name, buf, size.w || out.width, size.h || out.height, out.uiAssetId || out.jobId || '')
      /* what came back, not what it cost: the price under the button read as a bill, where faces and size are what an author needs */
      const cutFaces = (saved.regions || []).filter((r) => r && r.kind === 'face')
      return send(res, 200, {
        ui: { name: saved.name, type: saved.type, w: saved.w, h: saved.h, status: saved.status },
        cut: t ? { tier: t.tier, faces: t.faces, regions: t.regions } : null,
        /* the rectangles are already stored, so this is a report and not an offer: cutNote says which check failed and the piece is owed a hand cut */
        ...(viaImage
          ? { faces: cutFaces.map((r) => ({ name: r.name, x: r.x, y: r.y, w: r.w, h: r.h })), cutNote: saved.crop_note || '' }
          : {}),
        /* who wrote the prompt, on every answer: a silent degrade looks exactly like the router writing a bad one, and they want opposite next moves */
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

  /* marks and measurement save together: an edge number is only legal against the picture its regions sit on, and two requests would let the pair drift apart */
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

  /* finished is not the same fact as the picture arriving: with no edge numbers the consumer squashes the whole painting into whatever box it gets */
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

  /* the shape has no source rect, so a family cannot be sliced and the hero is alpha-scanned out; a crop that passed and is still wrong undoes in one press */
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

  /* names are unique per account only, and the v1 image route resolves core-then-oldest platform-wide, so two people with a piece called binder saw one picture */
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

  /* the family is kept because the tray under the hero is the rest of the kit, paid for in the same spend; discarding it means paying again */
  if (p.startsWith('/api/ui/') && p.endsWith('/full') && req.method === 'GET') {
    const me = await currentUser(req)
    if (!me) return send(res, 401, { error: 'sign in to see a piece' })
    const buf = await ownedUiFull(me.id, p.slice('/api/ui/'.length, -'/full'.length))
    if (!buf) return notFound(res)
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'no-store')
    return res.end(buf)
  }

  /* the shared kit is a copy: duplicated bytes cost storage and no generation, and 013_library_kit.sql says why a genuinely shared row was not worth it */
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
    /* the gate only looks at one map, so the source is checked here: otherwise a stranger's library could be pulled into a map you do own */
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
    /* an export that takes minutes has to say where it is: it said nothing until it finished, and three hours went on narrowing down a stall by hand */
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
      /* a file that did not arrive stops the export: a missing one is quiet all the way down and would publish a holed island as an immutable version */
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
    // every source byte is read into memory before assets/ is rebuilt, or a re-export would delete its own sources
    const assetsDir = path.join(dir, 'assets')
    const outAssets = []
    const writes = new Map() // rel path inside assets/ -> png buffer
    /* one name per distinct source: assets/ is flat, so keying by filename let a second tree.png silently overwrite the first and both placements drew it */
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
    /* one appearance packed: views, frames or a bare src, and it runs for each extra look too, so no reader learns a second shape. null drops the entry */
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
        /* compound headings first: the game's endsWith scan matches 'south-west-0.png' against 'west-0.png' and 17 of the hub's 38 sets faced the wrong way */
        for (const k of orderedHeadings(Object.keys(s.dirs))) {
          const arr = s.dirs[k]
          if (!Array.isArray(arr) || !arr[0]) continue
          /* every frame of the heading: keeping frame 0 handed the game a statue that slid across the ground, and a stop at the first gap keeps the run contiguous */
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
          /* the heading the author picked, not south: handing back outDirs.south turned 21 south, 8 south-west and 9 south-east into 38 south on the hub */
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
    /* counted apart, with ids: both continues reach one guard, so a bad x, y or scale was reported as missing art and sent a person hunting for a png that was there */
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
      // how it moves, as the numbers the editor holds: no extra pixels and nothing to load, and life.states rides the same spread untouched
      const life = a.life && typeof a.life === 'object' ? a.life : null
      const tf = { scale: scaleX, scaleX, scaleY, rot, flipX, flipY, ...(life ? { life } : {}) }
      /* look 0 is the entry itself in the shape every reader knows, and the extras ride under one optional key an older reader ignores */
      const look0 = packLook(a)
      if (!look0) {
        noArt.push(pid)
        continue
      }
      /* a look whose png has gone keeps its slot: art is an index, so dropping one shifted every later look down and both states drew something never asked for */
      const looks = []
      // STATES_MAX extras, because a round is at most that many states and each
      // of them can name one picture that is not look 0. See STATES_MAX.
      for (const L of Array.isArray(a.looks) ? a.looks.slice(0, STATES_MAX) : []) looks.push(packLook(L) || look0)
      /* face names in one array indexed the way art is, never inside look0, whose spread would overwrite the placement's own name; an unnamed face holds its slot */
      const names = [
        isAnchorName(a.lookName) ? String(a.lookName) : '',
        ...(Array.isArray(a.looks) ? a.looks.slice(0, STATES_MAX) : []).map((L) =>
          L && isAnchorName(L.name) ? String(L.name) : '',
        ),
      ]
      outAssets.push({
        id: String(a.id),
        /* the author's own name, which is what an anchor binds to and what python addresses; the id beside it is a counter nobody chose */
        ...(isPlacementName(a.name) ? { name: String(a.name) } : {}),
        group: String(a.group || 'props'),
        /* already resolved by editor.ts bundle(), and mapvis never reads inside it: it declares the condition and python decides what it means */
        ...(typeof a.when === 'string' && a.when.trim() ? { when: a.when.trim().slice(0, 240) } : {}),
        ...look0,
        x,
        y,
        ...tf,
        ...(looks.length ? { looks } : {}),
        ...(names.some((n) => n) ? { lookNames: names } : {}),
      })
    }
    /* the same count out as in, or no bundle: counts taken after the drop meant a bundle missing 19 of 75 placements read exactly like one missing none */
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

    // the publish is an immutable version, so re-exporting cannot break a class mid-session, and map.json picks up anchors[] from the database on the way
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

  /* the doc as the editor holds it, stored verbatim so there is no second format: one localStorage key behind a silent quota failure was the only copy */
  if (p === '/api/doc' && req.method === 'POST') {
    const b = await body(req)
    if (typeof b.doc !== 'string' || !b.doc) return send(res, 400, { error: 'no doc' })
    const id = safeId(b.id)
    // masks become a png and placements a row, each skipped when unchanged: at an autosave every four seconds that is a free database living or dying
    if (platformOn()) {
      try {
        const r = await saveDocument(id, b.doc)
        return send(res, 200, { bytes: b.doc.length, wrote: r.wrote, savedAt: r.savedAt })
      } catch (e) {
        /* not signed in is an answer, not an outage: falling through would write a stranger's map into scratch, report success and lose it */
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

  /* the slug is the publish key, every door's target and the save key, so the doors move with a rename; published versions keep their old prefix and are untouched */
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
    // savedAt travels because the browser holds a copy too: without it the editor prefers localStorage forever and the map lives in one browser
    if (platformOn()) {
      try {
        const r = await loadDocument(id)
        if (r?.doc) {
          /* opening a map counts as working on it: the dashboard orders by updated_at, which only a save used to touch */
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

/* a relay authenticates with its own hashed token, claims only its account's jobs, and never sees a map or a key */
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
    /* the machine lends its pixellab key: the host has none and cannot proxy minutes-long generations through this queue */
    if (caps.includes('pixellab') && typeof b.pixellab === 'string' && b.pixellab.trim()) {
      try {
        await lendKey(link.user_id, 'pixellab', b.pixellab)
      } catch (e) {
        console.error('[relay] could not take the lent pixellab key:', e.message)
      }
    }
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

/* the club shares one login on purpose, so no team model; signed out still cuts, levels, walks, places and exports, and always will */
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

  /* the password is asked again because a session proves the browser was left open, not that the person meant this; every failure returns before a byte is touched */
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

/* /api/v1, read only and served by slug: versioned in the path so code written against it keeps working, and nothing that mutates is ever added here */
async function readApi(req, res, p, url) {
  /* cors: the manifest is the first call the game makes and had no header, so it fell back to the copied folder every time. all of /api/v1 is public and read-only */
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
    /* ?with=anchors: a door graph over twelve islands cost thirteen requests, paid by a whole class at once on a 4 GB chromebook. opt-in, so the listing stays cheap */
    if (url.searchParams.get('with') === 'anchors' && maps.length) {
      /* the area comes with it: without it every region drew as a circle of its radius, and the shape mode is lifted off the meta bag the way readEvents does */
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

/* the ocean, live from row 1 and public because a freshman on a chromebook has no account; the game gates on Array.isArray(slots), so places discarded a real one */
  if (kind === 'world' && !slugRaw) return send(res, 200, await composition(GAME_WORLD))

/* berths flat, keyed by the name the author typed: mapvis authors where and python authors what happens, so do not add a routes key until something reads it */
  const flatMarks = async (id) => {
    const w = await getWorld(undefined, id)
    const out = {}
    const say = (m) => ({
      kind: m.kind,
      x: m.x,
      y: m.y,
      facing: m.facing || '',
      /* the label rides along: without it a grape had the address and no words, so an island printed north_passage at somebody */
      label: m.label || '',
      /* which island it belongs to, or a grape can sail there and has to fetch the whole composition to say what it arrived at */
      island: m.island || '',
      // and where the hull puts somebody down once they are ashore, which is an
      // anchor name inside that island rather than a point on the ocean
      at: m.at || '',
      /* how close counts as arrived: a hull moves in floats, so an exact-pixel test never fires and dropping r made every island invent its own tolerance */
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

  /* worlds is plural because /api/v1/world already spends its second segment on marks; the address is the row's pub_id, never the owner's uuid, so it can be rotated */
  if (kind === 'worlds') {
    const id = slugRaw ? await worldByPubId(slugRaw) : 0
    if (!id) return send(res, 404, { error: 'no ocean at that address' })
    if (!sub) return send(res, 200, await composition(id))
    if (sub === 'marks') return send(res, 200, { marks: await flatMarks(id) })
    return send(res, 404, { error: 'an ocean answers with itself or with its marks' })
  }

  /* docs/UI-KIT.md section 3, in source pixels because that is all border-image and NineSliceSprite agree on; names collide here, so core wins then oldest */
  if (kind === 'ui') {
    if (!slugRaw) return send(res, 200, { ui: await readyUi() })
    const surface = await readyUiByName(slugRaw)
    if (!surface) return send(res, 404, { error: `no piece ${slugRaw}` })
    if (!sub) return send(res, 200, surface)
    if (sub === 'image') {
      const buf = await uiImage(slugRaw)
      if (!buf) return notFound(res)
      res.setHeader('Content-Type', 'image/png')
      /* immutable and no version in the key, so a redraw needs a rename; what it buys is thirty chromebooks fetching the chrome once between them */
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

  /* named collections flat, keyed by the author's name: sets and racks share one namespace, so a grape asks by name without saying which list */
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
    /* a map that exists and a store that will not answer are different: 503 says come back, 404 says it is not here */
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

// where the bytes come from moved and the address did not, which is why 17,000 lines of client did not have to change
/* disk first: bucket first spent 3,244 downloads in a day against a free allowance of 2,500 to read files already on the drive, and a host has no work dir anyway */
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
/* a face is stored the three ways a row is, because a walking character's state is eight headings or the troll faces south the moment it becomes a boulder */
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
            /* a face nests one folder deeper than the library, so the size is read off the url's whole tail: the last segment alone came back 0x0 */
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
      // an effect folder carries its own rate so a tuned speed survives a reload, and its presence is the reopenable flag; anything else plays at 6
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
  /* faces and origin hang off the row, so a state never lists as a row of its own and the second-face button knows before spend time */
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

// seven calls for 700 objects is too many per keystroke, and the list only changes on a generation, so five minutes and a refresh flag
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

/* kept raw because the re-animate router needs the untouched name and the size: motion is priced by pixel budget, so 68px at sixteen frames is not 48px at eight */
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

/* what the person actually typed, kept beside the map: the raw ask used to become a four-word slug and be thrown away. newest first, last 40 */
/* rotations as one folder keyed by heading, shared by the import and the eight-direction generation because both land the same set of views */
async function saveRotations(id, detail, wantName) {
  const rot = detail && detail.rotation_urls && typeof detail.rotation_urls === 'object' ? detail.rotation_urls : null
  const DIRS = ['south', 'north', 'east', 'west', 'south-east', 'north-east', 'north-west', 'south-west']
  const got = rot ? DIRS.filter((k) => typeof rot[k] === 'string' && rot[k]) : []
  if (got.length < 4) return null
  const dir = libDirOf(id)
  fs.mkdirSync(dir, { recursive: true })
  const base = cleanName(wantName || detail.name || detail.prompt || 'object')
  /* the database answers too: a disk-only suffix walk starts empty on a host, so every import took the base name and wrote over the row under it */
  const name = await freeLibraryName(id, base)
  const folder = path.join(dir, name)
  // the folder is claimed the moment the name is picked, the way saveFrames has
  // always claimed its own. Two of these running at once could otherwise both
  // look, both find nothing, and both take it.
  fs.mkdirSync(folder, { recursive: true })
  return { name, dir: folder, urls: got.map((k) => [k, rot[k]]) }
}

/* the same plan for headings with frames inside; the folder is made here so the name is reserved the moment it is picked and two runs cannot both take it */
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
  /* which character drew this, or the only way back to the rig is matching a four-word folder name, and only that rig keeps motion in register across headings */
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

/* everything below serves /api/asset-animate: it never makes a new row, it replaces the pixels of one already there */

/* one library row off disk, keeping what only a re-animate wants: where the files are and what dirs.json says beyond dirs and fps */
/* older pushes went up as frames only, so a hydrated folder has no dirs.json and reads as nothing; the row still knows the headings, rate and recipe */
async function ensureSidecars(id, name) {
  if (!platformOn()) return
  const folder = path.join(libDirOf(id), name)
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return
  const dj = path.join(folder, 'dirs.json')
  const ej = path.join(folder, 'effect.json')
  if (fs.existsSync(dj) && fs.existsSync(ej)) return
  let it = null
  try {
    it = (await libraryOf(id)).find((x) => x.name === name) || null
  } catch (e) {
    console.error('[sidecars] could not read the store listing:', e.message)
    return
  }
  if (!it) return
  if (!fs.existsSync(dj) && it.dirs) {
    const meta = { dirs: it.dirs, fps: it.fps || 8 }
    if (it.origin && it.origin.characterId) meta.characterId = it.origin.characterId
    fs.writeFileSync(dj, JSON.stringify(meta, null, 2))
  }
  if (!fs.existsSync(ej) && it.effectJson) fs.writeFileSync(ej, JSON.stringify(it.effectJson, null, 2))
}

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

// what the two animators bill: 524288 pixels a generation across the whole take, against 65536 per direction for the character animator
const IMG_BUDGET = 524288
const CHAR_BUDGET = 65536
const priceOf = (w, h, frames, budget) => Math.max(1, Math.ceil((w * h * frames) / budget))

/* trimmed art has no margin, so a rod being cast comes back clipped at the frame edge; 40 percent is pixellab's own headroom, a 48px character on a 68px canvas */
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

/* both animators redraw a sprite where it stands, so the only question is whether the words need the drawing to change or the thing to move; a failure redraws */
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

/* the motion words are asked once and only the price is re-derived on confirm, so neither the client nor the router can talk it up or down */
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

  /* registration is not negotiable: eight separate loops drift, so a figure would breathe on a different rhythm facing north, and the coordinated endpoint needs an id */
  const who = await characterFor(it, b.characterId)
  if (!who.id) return { ...base, path: 'blocked', price: 0, why: who.why }
  noteCharacterId(it, who.id)
  const per = priceOf(who.w, who.h, said.frames, CHAR_BUDGET)
  /* animation is priced per direction, so a figure that never turns would buy seven loops nobody sees; a heading left out keeps its still frame */
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

/* the folder name never matches the account row: measured on all nine hub people, none is a substring, so asks.json is the bridge and it is a rescue, not a mechanism */
async function characterFor(it, given) {
  const looksId = (s) => /^[a-f0-9-]{16,64}$/i.test(String(s || ''))
  // an id the client pinned, or one already written down beside the art
  const pinned = looksId(given) ? String(given) : it.meta && looksId(it.meta.characterId) ? String(it.meta.characterId) : ''
  /* the pinned id first: reading dirs.json after the listing made a sprite that knew its character pay for 700 rows and fail when that listing failed */
  if (pinned) {
    try {
      const d = await pixellab.characterDetail(pinned)
      const rot = (d && d.rotation_urls) || {}
      if (Object.keys(rot).length) {
        const s = (d && d.size) || {}
        return { id: pinned, w: Number(s.width) || 48, h: Number(s.height) || 48, from: looksId(given) ? 'asked' : 'dirs' }
      }
    } catch {
    }
  }
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
  if (pinned) {
    // a character deleted on their side would 422 after the price had been
    // shown, and finding that out here costs nothing
    const row = list.find((c) => String(c.id) === pinned)
    if (row) return { ...sized(row), from: looksId(given) ? 'asked' : 'dirs' }
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

/* urls, not ids: a group comes back with g.id undefined and display_name null, and the frame urls are the one thing identical across two reads */
const frameSet = (d) => {
  const out = new Set()
  for (const g of Array.isArray(d && d.animations) ? d.animations : [])
    for (const dd of Array.isArray(g.directions) ? g.directions : [])
      for (const u of Array.isArray(dd.frames) ? dd.frames : []) if (u) out.add(u)
  return out
}

/* the read before the spend is what makes a replacement safe: without it a second re-animate reads back the old walk and overwrites the item with it */
async function runCharacterMotion(plan, seed, gate, halt) {
  halt()
  let d = await raceStop(gate, pixellab.characterDetail(plan.characterId))
  const before = frameSet(d)
  const rot = d.rotation_urls && typeof d.rotation_urls === 'object' ? d.rotation_urls : {}
  // only headings the character actually has: naming one it does not is a
  // generation asked for and thrown away
  /* usable and how many to animate are different questions: asking for three headings used to trip the four-rotation guard and fail the whole job */
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
  try {
    d = await raceStop(
      gate,
      pixellab.awaitAnimation(plan.characterId, h, { timeoutMs: onHost() ? HOST_WAIT : WALK_WAIT, known: before }),
    )
  } catch (e) {
    // out of budget on the host is pending, not failure: the frames are paid
    // for and will be there when the client asks again for this group
    if (onHost() && /timed out/.test(String((e && e.message) || e))) throw new Pending(group)
    throw e
  }
  let byDir = newGroupDirs(d, group, before, heads, rot)
  /* the job reports finished before the detail lists the group, which threw away a paid motion on the hub's knights; the frames are bought, so read again */
  for (let tries = 0; !byDir && tries < 5; tries++) {
    await new Promise((r) => setTimeout(r, 4000))
    halt()
    d = await raceStop(gate, pixellab.characterDetail(plan.characterId))
    byDir = newGroupDirs(d, group, before, heads, rot)
  }
  /* measured over eleven animations the strict reading failed every time and this fallback succeeded every time, so it takes the newest non-rotation group */
  if (!byDir) {
    const found = await recoverCharacterMotion(plan)
    if (found) return found.byDir
  }
  // refusing here costs the generations and keeps the item. Guessing would
  // write the OLD motion over it and call the result the new one.
  if (!byDir) throw new Error('the frames that came back could not be told from the motion it already had, so nothing was replaced')
  return withStills(byDir, rot)
}

/* stageViews rebuilds from what it is handed, so three animated headings alone would delete the other five; the rest come back as their rotation still */
function withStills(byDir, rot) {
  const out = { ...byDir }
  for (const [k, u] of Object.entries(rot || {})) {
    const key = String(k).toLowerCase()
    if (!out[key] && typeof u === 'string' && u) out[key] = [u]
  }
  return out
}

/* frames already paid for, pulled without buying them again: it takes the newest group that is not a rotation, and it is free */
async function recoverCharacterMotion(plan, group = '') {
  const d = await pixellab.characterDetail(plan.characterId)
  const rot = (d && d.rotation_urls) || {}
  const rotSet = new Set(Object.values(rot).filter((u) => typeof u === 'string'))
  const groups = Array.isArray(d && d.animations) ? d.animations : []
  const wanted = new Set(plan.headings || [])
  /* the group that was asked for, when one was: best would hand back a motion the character already had and leave the one just paid for unread */
  const named = (g) =>
    [g.display_name, g.animation_type, g.animation_name].some((n) => String(n || '').toLowerCase() === group.toLowerCase())
  const pool = group ? groups.filter(named) : groups
  let best = null
  for (const g of pool) {
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
  /* withStills makes a rotations-only group look like a complete eight, and recovering that wrote stills over the fishmonger's art and called it success */
  if (group && best && best.hit < wanted.size) return null
  return best && best.moves ? best : null
}

/* the name is the first try and frames that were not there before is the one that always works, so an old motion can never be written back over a new one */
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
  /* nothing new anywhere means the motion never landed: falling through to the rotations would write statues over a walk cycle and call it a success */
  if (!Object.keys(byDir).length) return null
  // a heading the motion missed keeps its still rotation rather than vanishing.
  // It stands there facing the right way while the others move, which is what
  // the whole library looked like an hour ago.
  for (const k of heads) if (!byDir[k] && rot[k]) byDir[k] = [rot[k]]
  return Object.keys(byDir).length >= 4 ? byDir : null
}

/* sixty-four downloads and any one can fail, so everything lands in .stage first and the library folder is touched only when nothing can fail; .stage is never listed */
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

/* the first slot is written once and never again: rolling one slot forward left .prev holding a 1291-byte middle step instead of the 13073-byte original */
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

async function keepPrevFile(id, from, as) {
  try {
    fs.copyFileSync(from, prevPath(id, as, false))
  } catch {
    /* a backup that cannot be written is not a reason to block the edit */
  }
  await keepVersion(id, as.replace(/\.png$/i, ''))
}

/* the same keep in the store, so an undo works on a machine that never saw the edit */
async function keepVersion(id, name) {
  if (!platformOn()) return
  /* awaited: the host freezes the instance when the response goes out, so fire-and-forget landed no version and every deployed edit was destructive */
  try {
    await snapshotVersion(id, name)
  } catch (e) {
    console.error(`[versions] could not keep ${id}/${name}:`, e.message)
  }
}

// the folder half of the same law, for a heading set or an animation's frames
async function keepPrevDir(id, from, as) {
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
  await keepVersion(id, as)
}

/* one row either way: the item keeps its name so placements pick the new pixels up, and unused files go or a shorter motion leaves a longer one's tail */
async function swapFolder(id, name, stage, meta) {
  const folder = path.join(libDirOf(id), name)
  /* this used to rmSync .prev before refilling it, so re-animating a figure twice deleted the original eight headings outright */
  await keepPrevDir(id, folder, name)
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

/* the walk is gathered across every group it is split over, and a heading the walk misses falls back to its still rotation. '*' means whatever it has */
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

/* stopping is not undoing: what is asked for is paid for, so whatever landed is written and a stop buys the next generation, never the last one back */
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

/* a name free in both places: on a host scratch starts empty every request, so a folder-only walk picked the base name and overwrote the stored item */
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

/* origin.json maps a library name to the id that drew it: the library has three shapes and only one can hold metadata, and guessing across 769 rows was wrong often */
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

/* a face lives outside the library folder on purpose: one stray listing fills it with boulder, boulder-2, rows that mean nothing on their own */
const stateDirOf = (id, owner) => path.join(WORK, id, 'states', cleanName(owner))

/* an older client still posts bodyType, template and walk; legacySkeleton answers '' for the one case the old route refused, quadruped with no body */
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

/* rotation_urls is read, not assumed, but only trusted when complete: awaitCharacter answers at four, so an eight-way body reads back half drawn. n is the ceiling */
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

/* one box for the whole set, because a box per frame moves the feet and the walk bobs; the 40 percent pixellab margin is why an imported figure floats */
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

// the generator draws every noun it hears, so the ask becomes one drawable thing; the wider judging job was tried and killed, and a failure passes the ask through

// at or above this the map's style clause is appended and the palette lock
// opens strong; below it the ask goes out bare and the lock opens at zero
const BELONGS_MIN = 0.5

// the whole assembled prompt is what gets sent and what the button shows, so
// the cap is the endpoint's own (2000 chars) with room to spare
const PROMPT_MAX = 1200

/* at 600 an 817-character ask naming a crab at character 735 reached the model with the word missing and planned one 0 times of 3; at 1200 it is 3 of 3 */
const ASK_MAX = 1200

// how much of an object plan's one printed line survives. See planMake, where
// the measurement that moved it off 240 is written down.
const NOTE_MAX = 400

/* cleanLife owns the ceiling and this matches it: four numbers used to disagree, so a seventh state vanished on the way into the editor with nobody told */
const STATES_MAX = 6

/* characters, not names: a count of 60 against a 63-item library left three unnameable in directory order, and names run 1 to 41 characters. the tail is said out loud */
const NAMES_CHARS = 4000

/* the camera is per object, not a house constant: 24 of 24 reads opened "Isometric pixel art", puddles included, so the router answers view once */
const OBJECT_VIEW = 'low top-down'

/* not CHAR_VIEWS: it carries perspective the object endpoint does not know, and a word the schema rejects is a 422 charged after the draw */
const OBJECT_VIEWS = ['low top-down', 'high top-down', 'side']

/* one variable read twice, so it cannot express two cameras: 315 of 739 account objects say isometric while their view says high top-down and were made anyway */
const CAMERA_WORDS = {
  'low top-down': 'Isometric pixel art',
  'high top-down': 'Pixel art seen from straight above',
  'side': 'Flat pixel art drawn straight on with no foreshortening',
}

const objectView = (v) => (OBJECT_VIEWS.includes(String(v)) ? String(v) : OBJECT_VIEW)

/* the camera is read back off the finished prompt, because a field would be dropped by one of five carriers and put the constant back silently */
function viewFor(prompt) {
  const t = String(prompt || '').toLowerCase()
  const hits = OBJECT_VIEWS.filter((v) => t.includes(CAMERA_WORDS[v].toLowerCase()))
  return hits.length === 1 ? hits[0] : OBJECT_VIEW
}

/* standard is one generation, pro is 20 to 40, v3 is 2 to 9 and the only one taking a reference; oblique was never in the live schema */
const CHAR_MODES = ['standard', 'pro', 'v3']
const CHAR_VIEWS = ['low top-down', 'high top-down', 'side', 'perspective']
const QUADRUPEDS = ['bear', 'cat', 'dog', 'horse', 'lion']

/* the complete set of skeletons pixellab has, not a list of what can exist: asking for a dragon rig is a 422 that costs the body it hung on */
const SKELETONS = ['mannequin', ...QUADRUPEDS]

/* four-legged templates are absent because they are named per body, and a name not on this list is demoted: an unknown id is a 422 after the body is paid for */
const WALK_TEMPLATES = [
  'walk', 'walk-1', 'walk-2', 'walking', 'walking-2', 'walking-3', 'walking-4', 'walking-5',
  'walking-6', 'walking-7', 'walking-8', 'walking-9', 'walking-10',
  'walking-4-frames', 'walking-6-frames', 'walking-8-frames',
  'running-4-frames', 'running-6-frames', 'running-8-frames',
  'sad-walk', 'scary-walk', 'crouched-walking',
  'breathing-idle', 'crouching', 'drinking', 'picking-up', 'pushing', 'pull-heavy-object',
  'jumping-1', 'jumping-2', 'two-footed-jump', 'getting-up', 'throw-object',
]

/* a hovering wisp on the mannequin rig got a walk cycle, and catching a word only demotes to written motion at the same price; cart and boat stay off, they are props */
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

/* a router that asked for a walk template wrote walking beside it, so its own motion line cannot be reused when the gate turns the template down */
const WALK_WORDS = /\b(walk|walks|walking|stride|strides|striding|step|steps|stepping|march|marches|marching|jog|jogs|jogging|run|runs|running|foot|feet|legs?)\b/i

/* written motion defaults to south only in the live schema, so forgetting to name the headings comes back facing one way with seven budgets unspent */
const DIRS8 = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west']
// the four a four-direction body has. Nothing in the ui asks for one, but the
// route accepts nDirections 4 and a written motion still has to name them.
const DIRS4 = ['south', 'east', 'north', 'west']

/* a price, not a taste: written motion is one generation per direction at 96 and two above it, and a placement's sx/sy scales for free */
const SPRITE_MIN = 32
const SPRITE_MAX = 96

// standard draws in two to five minutes and the motion is eight directions
// behind it, so these are long on purpose. The stop button is the way out, not
// a clock.
const CHAR_WAIT = 600000
const WALK_WAIT = 900000
/* vercel cuts a function at 300s and an eight-way animation takes five to fifteen minutes: waiting inside the request lost 55 generations to a press that did nothing */
const HOST_WAIT = 230000
const onHost = () => !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
class Pending extends Error {
  constructor(group) {
    super('still drawing')
    this.name = 'Pending'
    this.group = String(group || '')
  }
}

/* the 47 kept objects all state projection, light, values, palette and no ground; code assembles it, because a model asked for seven clauses forgets one */
/* whole comma-clauses that name ground as a material go: a style clause saying sandy-tan and grey stone put palms on discs of sand with stone rims */
const GROUND = /\b(sand|sandy|stone|rock|rocky|earth|earthy|dirt|soil|gravel|grass|grassy|terrain|ground|paving|paved|cobble|cobblestone|beach|shore|shoreline|coast|coastal|seaside|island|terracotta|clay)\b/i

function groundless(s) {
  return String(s || '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c && !GROUND.test(c))
    .join(', ')
}

/* the subject is left alone: a regex on it turned "a beach umbrella" into "a umbrella" and still missed the buried word, so it was thrown away the same hour */

/* a fence on the style half only: the mechanism is that code owns the join, and measured over 24 reads this caught 0, which is the state it should be in */
const PROJECTION =
  /\b(isometric|2:1|two[- ]to[- ]one|top[- ]?down|overhead|bird'?s[- ]?eye|three[- ]quarter|3\/4|side[- ]on|side view|side elevation|front elevation|orthographic|axonometric|oblique|perspective|foreshorten\w*|projection|vanishing point|(?:seen|viewed|drawn|looking)\s+(?:from|down|straight))/i

function projectionless(s) {
  return String(s || '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c && !PROJECTION.test(c))
    .join(', ')
}

/* subject and style come back as separate fields, so no string the router writes can hide a camera; code puts it between them where the kept objects put it */
function objectPrompt({ subject, style, view }) {
  const one = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const sub = one(subject).replace(/[.,;:\s]+$/, '')
  // the style can come back capitalised and full-stopped, because it was asked
  // for as its own field. It is a tail in the joined sentence, so it joins as
  // one rather than starting a second one.
  const sty = projectionless(one(style).replace(/^[.,;:\s]+/, '').replace(/[.\s]+$/, ''))
  const cam = CAMERA_WORDS[objectView(view)]
  const tail = sty ? `${cam}, ${sty.charAt(0).toLowerCase()}${sty.slice(1)}` : cam
  /* the refusal says what is there: "no ground, no terrain, no base, no plinth" handed four ground nouns to a generator that draws every noun and summoned the slab */
  const alone =
    'the object alone as a cut-out sprite on a fully transparent background, ' +
    'the base of the object is where its own material ends'
  return `${sub ? sub + '. ' : ''}${tail}, ${alone}.`.slice(0, PROMPT_MAX)
}

/* anything that is not four finite numbers with real area comes back null, which every caller treats as no crop rather than crashing */
function cleanBox(v) {
  if (!v || typeof v !== 'object') return null
  const n = (k) => Math.round(Number(v[k]))
  const x = n('x'), y = n('y'), w = n('w'), h = n('h')
  if (![x, y, w, h].every(Number.isFinite) || w < 8 || h < 8) return null
  return { x: Math.max(0, x), y: Math.max(0, y), w, h }
}

function housePrompt({ subject, detail, palette, clause, view }) {
  const bits = [
    // not reachable from the ui, but it reads the same table, because a constant left in the interpreter-down path is how this bug comes back
    subject + ' in ' + CAMERA_WORDS[objectView(view)].toLowerCase(),
    detail,
    'warm golden-hour sunlight from the upper left',
    'blue-tinted shadow on the right side',
    'painterly 6-8 value shading',
    groundless(palette),
    'one unified structure',
    groundless(clause),
    // "no ground, no terrain, no base, no plinth" put four ground nouns in and summoned the slab it was meant to forbid, so say what is there
    'the object alone as a cut-out sprite on a fully transparent background',
    'the base of the object is where its own material ends',
  ]
  return bits
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/[,\s]+$/, ''))
    .filter(Boolean)
    .join(', ')
    .slice(0, PROMPT_MAX)
}

/* the model gets the painting itself, not a summary: five stages of filters and trims were all compensating for boiling it down to eighteen words */
async function planMake({ ask, what, kind, id, mapFile, boxFile, box, previous, job, images = [], paths = [] }) {
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
      /* the shape is taken off the kept objects: left to itself the router asked for a saturated palette and got a trough that was not a boat. muted did much of it */
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
      /* the painting decides and the object only chooses within it: asking the object's shape in a vacuum drew a bookshelf flat-on in a town painted isometric */
      `Look at the area first and the object second, in that order, because the painting is what ` +
        `is being joined and the object only picks which part of it to agree with. Different ` +
        `maps are painted at different angles and some are painted at more than one. Nothing ` +
        `here assumes the angle this map happens to use.`,
      ``,
      /* the box test: no top worth seeing is not the same question as has no volume, and answering the second drew a bookshelf flat-on in a raked street */
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
      /* outline, shading and detail are real enums this tool has never sent: worth trying one at a time against the defaults, never three at once */
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
      /* the kept ones are 32 to 96 a side: a bigger canvas buys a pixel finer than the map's, and the 128 boat was unusable where the 64 was right */
      `Stay SMALL. The ones he kept are 32 to 96 a side and mostly under 72. A bigger canvas ` +
        `does not buy detail, it buys a pixel finer than the map's own, which is what makes a ` +
        `thing read as pasted on top of the painting rather than painted into it.`,
      ``,
      /* on a noun the generator holds hard the words lose: dusty olive and muted returned an acid-green tree 4 of 4 and a puddle returned a bleached sand ring */
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
  /* one ask for the whole creature: the long way is three boxes whose order is written nowhere, so a round gets described before the face it names exists */
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
  /* the router may say the mode is wrong and never switch it: a switch changes the price on a button somebody is about to press */
  lines.push(
    ``,
    /* the still/moving toggle is a price too, so it is noticed and never switched: still is one generation and moving is nine */
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
  const raw = await runPlanner(lines.join('\n'), 240000, job, undefined, images, paths)
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
    /* at 240 the sizing half fell off the end: measured over 24 reads object notes ran 193 to 373 and 17 were over 240, so 400 for an object and 240 for a sprite */
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
  /* held to three because each is a generation, and an edit with no words is dropped: a blank edit_description is a 422 charged after the queue */
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

/* four dropdowns became this text: the only enumeration left is the six skeletons, which is the complete set pixellab has rather than a taste */
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

/* every clamp here is a generation: an invented skeleton or template id is a 422 after the body is paid for, so a wrong answer is corrected rather than sent */
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

/* the last-resort words are deliberately not walking, because a default that walks puts a dragon on its feet, and the price is recomputed from what was said */
function spriteAnim(raw, kind, skeleton, motion, ask) {
  const a = raw && typeof raw === 'object' ? raw : {}
  const how = String(a.how || '')
  if (kind !== 'animated' || how === 'none') return { how: 'none' }
  const f = Math.round(Number(a.frames))
  const frames = isFinite(f) && f >= 4 ? Math.min(16, f % 2 ? f + 1 : f) : 8
  const written = (words) => ({ how: 'action', action: String(words).slice(0, 300), frames })
  const said = String(a.action || '').replace(/\s+/g, ' ').trim()
  /* written motion is terminal: an action with no words refuses out loud, because the only other move is a guess and the guess to stop is a walk */
  if (how === 'action') {
    const words = said || motion
    if (!words) throw new Error('the router asked for written motion and wrote no motion words')
    return written(words)
  }
  /* four facts, not two: without checking the thing itself a dragon on a mannequin rig walked, because every other check was about the request */
  const tpl = String(a.template || '').toLowerCase().trim()
  const onFeet = walksOnFeet(ask)
  if (how === 'template' && skeleton === 'mannequin' && WALK_TEMPLATES.includes(tpl) && onFeet)
    return { how: 'template', template: tpl }
  /* refusing the template and then writing "walking steadily" is the same answer spelled differently, so walk words are dropped from the demotion */
  const clean = (w) => (w && !(onFeet ? false : WALK_WORDS.test(w)) ? w : '')
  return written(clean(said) || clean(motion) || 'moving in place, ending where it began')
}

/* positions come back in the box's own pixels, and every item gets its own prompt because three palms that are one png three times is a worse answer */
async function planScene({ ask, id, mapFile, boxFile, box, count, kind, job, images = [], paths = [] }) {
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
    /* the fill path had free wording and a fixed camera, the worst of the three writers, so it answers view per item: a stall and a palm differ */
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
  const raw = await runPlanner(lines.join('\n'), 300000, job, undefined, images, paths)
  const o = planJSON(raw, 'items')
  if (!o || !Array.isArray(o.items) || !o.items.length) throw new Error('the interpreter did not answer')
  const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n)
  const num = (v, lo, hi, d) => {
    const n = Math.round(Number(v))
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d
  }
  const items = o.items.slice(0, count).map((it) => ({
    what: clean(it.what, 60) || 'a thing',
    // one assembler for every object prompt, so a fill and a single ask cannot hold two ideas of the camera; an older finished prompt takes the fallback view
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
  // the clause rides inside the prompt so the refusal of ground stays last, and only at or above BELONGS_MIN: it is wrong for a magic rune
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
    /* with no model the author's words go straight to pixellab, and it says so: a silent degrade spends a real generation on a worse prompt */
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

/* planMake for chrome: two fields so code owns the nine-slice law, and the reference goes to both sides because style_image carries material and no layout */
const CHROME_DIR = path.join(ROOT, 'public', 'chrome')

/* the reference is read off disk by type: missing is survivable and said out loud, so an author knows why the colours drifted */
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
  /* which generator is being written for, said first: the panel route scaffolds furniture whatever the words say, the image route draws only the words */
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
    /* the path line only when there is a file: an empty line where an absolute path belongs tells a model to go and read nothing */
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
    /* a background behind chrome is a rectangle of somebody's room painted over the island; no_background is sent too, words are only one fence */
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

/* a sheet is eight things: 30 to 70 words over eight marks is four words each, which is how a compass and a coin come back as the same disc */
const SHEET_ANSWER =
  `{"subject":"the layout in rows, then every mark named one by one with its silhouette, 80 to 160 words, no lettering and no ground",` +
  `"style":"chunky pixels, ... , muted saturation",` +
  `"palette":"muted ... ","note":"one short lower-case line: what you matched it against"}`

/* kept apart from the ask so the whole assembly can be read and asserted without a planner and without a generation */
export function chromeFinal({ subject, style, t }) {
  const one = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const sub = one(subject).replace(/[.,;:\s]+$/, '')
  const sty = one(style).replace(/^[.,;:\s]+/, '').replace(/[.\s]+$/, '')
  /* the law goes in from code: both failed rolls had it in front of them and dropped it, and a dropped nine-slice law is a picture the game cannot cut */
  /* the middle sentence is dropped on the one ground with no middle: two instructions that cannot both be obeyed is how a generator picks */
  const law = t && t.tier === 'ground' ? ' ' + (t.fill === false ? RING_CLAUSE : GROUND_CLAUSE) : ''
  const alone = 'the piece alone as a cut-out on a fully transparent background, no lettering of any kind'
  /* v3 came back with the hero panel running off the top of the canvas, so the crop clause is code's; split in two, a sheet is not one piece */
  /* the count is code's on a sheet: a routed prompt saying two rows of four came back with twelve, and the cut counts shapes against this number */
  const whole =
    t && t.tier === 'sheet'
      ? ` Exactly ${t.faces.length} marks on the canvas, no more and no fewer, and no mark drawn twice.` +
        ' A grid of separate small marks with empty space between them, every mark drawn complete and entirely inside ' +
        'the image, evenly spaced with clear margin on every side, nothing touching the edge of the image and nothing ' +
        /* the unless is not softening: a chip sheet's marks are plates, and two instructions that contradict is how a generator picks */
        'cut off by it. No frame, border, card or panel around the group, and nothing sits on a plate or inside a box ' +
        'unless the mark itself is a plate.'
      : ' One single complete piece, centred, with margin on every side, nothing touching the edge of the image and ' +
        'nothing cut off by it.'
  /* the interior is named by code: a prompt saying parchment came back brown wood, so this buys a fixed position beside the clauses that survive truncation */
  const inside = t && t.material ? ` The surface inside the frame is ${t.material}.` : ''
  const tail = `${alone}.${whole}${inside}${law}`
  /* the subject is what gets cut, never the tail: a flat truncation took off the nine-slice law and the transparency it exists to guarantee */
  const room = Math.max(0, CHROME_PROMPT_MAX - tail.length - (sty ? sty.length + 2 : 0) - 2)
  const cut = sub.length > room ? sub.slice(0, room).replace(/[\s,;:]+\S*$/, '') : sub
  return `${cut ? cut + '. ' : ''}${sty ? sty + ', ' : ''}${tail}`
}

// the endpoint's own ceiling on `description`, and there is no reason to sit
// under it here: the whole point of this prompt is that it carries a rule the
// model is not trusted to repeat
const CHROME_PROMPT_MAX = 2000

/* the long form in ui.mjs is what the model reads; the generator cannot follow reasoning, only instructions, so it gets this */
const GROUND_CLAUSE =
  'Ornament only in the four corners. The four edges are plain even runs of one material with ' +
  'nothing centred on them. The middle is one plain surface with nothing drawn in it.'

/* the same law round a hole: only the middle sentence changes, because anything painted there is paint over the map */
const RING_CLAUSE =
  'Ornament only in the four corners. The four edges are plain even runs of one material with ' +
  'nothing centred on them. The middle is completely empty and fully transparent, a hole right ' +
  'through the picture, with nothing drawn inside the frame at all.'

/* think is a parameter so verify-authoring.mjs can prove the constraints reach the prompt without spawning a real model call in a test */
export async function chromePlan({ ask, t, width, height, shelf, style, job, think = runPlanner }) {
  /* no claude is not a silent fall-through: the words go straight to pixellab and the answer says so */
  const raw = String(ask || '').replace(/\s+/g, ' ').trim()
  try {
    /* the reference goes over twice: the cli reads a path and an api account takes an attachment, and both are live across the platform */
    /* 120 seconds, not 240: vercel caps the invocation at 300 and the draw polls for up to 300, so a longer think kills the function mid-draw */
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
      /* the code-owned tail rides even with nobody to write the prompt: the bare four words went out with no law, no transparency and no interior, for the same price */
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

// the style card: one look becomes one phrase short enough to hang off any sprite description, and no image ever goes near the generator. free and cached
async function readStyleCard(file, job, images = []) {
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
      undefined,
      images,
      paths,
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

// the effect planner, free: a generator returns garbage every time because an effect is a motion rule over colours and not a picture of a thing

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

// a plan that left colours out let "swirling purple portal" come back brown, so a colour named in the ask wins, planner or no planner
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

// the seven rules are a menu with a ceiling: a portal was impossible until swirl was added by hand, so an unfitting ask gets a written renderer

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

/* every way out of the sandbox is spelled with one of these; the worker takes the same doors off, this is the cheap check in front */
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

/* two places hand this out and they must agree to the letter: a revision drops into the same sandbox the first draft ran in */
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

/* the free travel path, and the only place the planner is told it exists; conditional, because stamping a sprite that was never passed in draws an empty frame */
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
/* rendering is free, so the tool looks at its own frames before anybody is asked; on an object the look is only a look and nothing here generates */

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

/* the knobs are not up for revision: a person may have turned them, and a body reading one that no longer exists draws an empty frame */
async function reviewWritten(file, ask, frames, code, controls, params, job, sprite, images = []) {
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
      undefined,
      images,
      paths,
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
async function reviewRule(file, ask, frames, type, params, job, images = []) {
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
      undefined,
      images,
      paths,
    )
    const o = planJSON(raw)
    if (!o) return null
    const verdict = verdictOf(o)
    return { verdict, why: oneLine(o.why), params: verdict === 'revise' ? cleanEffectParams(o.params, now) : null }
  } catch {
    return null
  }
}

/* two answers, because which one is a number 1..n and could not fail a batch; the painting rides along, and twenty broadside ships is the cost of not asking */
/* the reviewer judges against the camera that was chosen: told the map was two to one it answered revise 2 of 2 on a legitimately flat fir */
async function reviewObjects({ file, map, ask, prompt, view, n, what, size, job, images = [], paths = [] }) {
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
    /* the projection is one decision written by code, so a camera the reviewer types is the one wording nothing else reads; 161 of 739 mismatched and came back fine */
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
    const raw = await runPlanner(lines.join('\n'), 120000, job, undefined, images, paths)
    // anchored on best, because a model asked to look at a strip likes to warm
    // up by saying what it is looking at, and that first little object parses
    // fine while carrying none of the answer
    const o = planJSON(raw, 'best')
    if (!o) return null
    const best = Math.max(1, Math.min(n, Math.round(Number(o.best)) || 1))
    /* a spoken verdict wins, and an older answer with none is read off fix: a real corrected prompt is forty to ninety words, shorter is prose */
    const fix = oneLine(o.fix, 1200)
    const spoke = typeof o.verdict === 'string' && o.verdict.trim() !== ''
    const verdict = spoke ? verdictOf(o) : fix.length > 40 ? 'revise' : 'good'
    return { best, verdict, why: oneLine(o.why), fix: verdict === 'revise' ? fix : '' }
  } catch {
    return null
  }
}

// ---- what he keeps ------------------------------------------------------
/* only on a keep: a discard is a miss, and feeding misses back would teach the tool to repeat them. capped, so the twentieth pushes the first out */

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

// unwrap the cli's json envelope, then pull the first BALANCED object: a nested params object stops a lazy regex at the wrong brace
/* need names a key the answer must carry: without it the model's warm-up object parsed fine and a good reply read as a failure */
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
/* every planner process by job, so a change of mind can end one; a killed job rejects the way a timeout does */
const LIVE = new Map()

/* jobs waiting on pixellab: nothing to kill, but a stop between the character and its walk keeps the eight animation generations from being asked for */
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

/* halt() sits immediately before every spend and never after one, because a stop buys the generation not yet asked for and never undoes a paid one */
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

/* both registries: one job can hold a gate and a planner process, and ending only the gate left the planner thinking out its whole timeout */
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

/* ten callers, one signature, whichever provider answers; a NoPlanner is not a fault, it means this account cannot reach claude right now */
async function runPlanner(prompt, timeoutMs, job, user, images, paths) {
  return ask({
    /* the account comes from the request: all ten callers pass three arguments, so user was undefined and ask() spawned a local cli that does not exist on the host */
    user: user || request().user || null,
    prompt,
    timeoutMs,
    images,
    // where the caller wrote those images, in the same order, so a relay can
    // recreate them where the prompt says they are
    paths,
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

/* a request stream drains once, and the ownership check at the door reads the body, so without this every route after it waited forever */
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
/* a dot-only id is a step up the tree: safeId('..') returned '..', so {"id":".."} wrote into the repo root and rmSync'd its assets folder */
const safeId = (s) => {
  const cleaned = (String(s || 'untitled').replace(/[^a-z0-9._-]+/gi, '-') || 'untitled').slice(0, 60)
  return /^\.+$/.test(cleaned) ? 'untitled' : cleaned
}

/* the second fence, on the routes that write: WORK + path.sep, so a sibling like work-old cannot pass */
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
