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
 *   POST /api/effect-plan      { ask, colors } -> { plan } which rule, what numbers, whose colours, or a WRITTEN renderer. FREE
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
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import * as pixellab from './pixellab.mjs'
import { decodePNG, encodePNG, sheetPNG } from './sheet.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WORK = path.join(ROOT, 'work')
const PUBLIB = path.join(ROOT, 'public', 'library')

const PYTHON =
  process.env.MAPVIS_PYTHON || 'C:\\Users\\ashcy\\ComfyUI_windows_portable\\python_embeded\\python.exe'
const SAM_CKPT =
  process.env.MAPVIS_SAM_CKPT || 'C:\\Users\\ashcy\\AdventureGame\\.tmp_extract\\sam_vit_b_01ec64.pth'

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' }

export function api(req, res, next) {
  const url = new URL(req.url, 'http://local')
  const p = url.pathname
  if (!p.startsWith('/api/') && !p.startsWith('/work/')) return next ? next() : notFound(res)
  Promise.resolve(route(req, res, p, url)).catch((e) => send(res, 500, { error: String(e.message || e) }))
}

async function route(req, res, p, url) {
  if (p.startsWith('/work/')) return serveWork(res, p.slice('/work/'.length))
  if (p === '/api/balance') return send(res, 200, await pixellab.balance())

  if (p === '/api/generate' && req.method === 'POST') {
    const b = await body(req)
    const prompt = String(b.prompt || '').trim()
    if (!prompt) return send(res, 400, { error: 'no prompt' })
    const n = Math.max(1, Math.min(6, b.n || 4))
    const w = b.w || 688
    const h = b.h || 384
    const jobs = []
    for (let i = 0; i < n; i++) {
      const seed = Math.floor(Math.random() * 1e9)
      try {
        jobs.push({ id: await pixellab.submit({ prompt, w, h, seed }), seed })
      } catch (e) {
        jobs.push({ error: String(e.message || e).slice(0, 200) })
      }
    }
    return send(res, 200, { jobs, w, h })
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
    const rotPlan = saveRotations(id, d, base)
    if (rotPlan) {
      const item = await writeRotations(id, rotPlan)
      if (item) return send(res, 200, { item })
    }

    const src = objectImageURL(d)
    if (!src) return send(res, 404, { error: 'that one has no image yet' })
    const buf = await pixellab.fetchPNG(src)
    const size = pngSizeBuf(buf)
    if (!(size.w > 0 && size.h > 0)) return send(res, 502, { error: 'what came back was not a png' })
    let file = base + '.png'
    for (let i = 2; fs.existsSync(path.join(dir, file)); i++) file = `${base}-${i}.png`
    fs.writeFileSync(path.join(dir, file), buf)
    return send(res, 200, {
      item: { name: file.replace(/\.png$/i, ''), kind: 'static', src: `/work/${id}/library/${file}`, w: size.w, h: size.h },
    })
  }

  // ONE pixellab spend, gated in the ui behind an explicit confirm: a small
  // transparent object, saved into this map's own library. The batch mode
  // passes name (<slug>-1/-2/-3) and a distinct seed per run.
  //
  // It goes through the OBJECT endpoint, not pixflux. pixflux draws freeform
  // illustrations, so it stands things on invented plinths: a palm came back
  // on a stone slab, twice. The 47 objects on this account that he rates as
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
    const box = b.box && Number(b.box.w) > 0 ? { w: Math.round(b.box.w), h: Math.round(b.box.h) } : null
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
   * the boxed area, if one was drawn, is the fence it stays inside. */
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
          `Judge it against the map. A creature that scuttles wants short fast dashes and long ` +
            `stillness, not a steady glide. Something in the air wants a long cycle and a lot of ` +
            `absence, or it turns into traffic. Slow is usually righter than fast: this sits in the ` +
            `background of a scene, and a thing that never settles pulls the eye off everything else.`,
          ``,
          `Answer with ONLY this JSON, no prose. Include only the fields your chosen kind uses.`,
          `{"kind":"wander","note":"one short lower-case line on what it will do","seed":1,` +
            `"range":40,"speedMin":14,"speedMax":26,"pauseMin":1.2,"pauseMax":4.7,"bob":1.5,` +
            `"bobRate":3.5,"faceMotion":true}`,
        ].join('\n'),
        180000,
        String(b.job || ''),
      )
      const o = planJSON(raw, 'kind')
      if (!o || !o.kind) throw new Error('no answer')
      const note = String(o.note || '').replace(/\s+/g, ' ').trim().slice(0, 240)
      return send(res, 200, { life: o, note })
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
      const list = await pixellab.allCharacters()
      const items = list
        .filter((c) => String(c.status || '').toLowerCase() !== 'failed')
        .map((c) => ({
          id: c.id,
          name: String(c.name || c.state_name || c.prompt || 'character').slice(0, 90),
          directions: Number(c.directions) || 0,
          animations: Number(c.animation_count) || 0,
          size: c.size && c.size.width ? `${c.size.width}x${c.size.height}` : '',
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
    const plan = saveFrames(id, characterDirs(d, b.animation), b.name || d.name || d.state_name || 'someone', 8)
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
     * one generation, not nine. */
    const want = b.anim && typeof b.anim === 'object' ? b.anim : legacyAnim(b)
    const moving = want.how === 'template' || want.how === 'action'
    const anim = spriteAnim(want, moving ? 'animated' : 'static', skeleton, '')
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
      const plan = saveFrames(id, characterDirs(d, '*'), b.name ? cleanName(b.name) : slugName(description), 8)
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
      const w = clampPx(b.w || t.w)
      const h = clampPx(b.h || t.h)
      // The boxed area rides along as background when there is one. This is
      // pixellab's own cohesion tool and it was sitting on a side route nobody
      // reached: bare-canvas generation turns small props to mush and has no way
      // to know what light or palette they are joining. The client sends it
      // already inside the endpoint's 32..192 per side.
      const bg = stripDataURL(String(b.background || ''))
      const bgSize = bg ? pngSizeBuf(Buffer.from(bg, 'base64')) : null
      const useBg = !!(bgSize && bgSize.w >= 32 && bgSize.h >= 32 && bgSize.w * bgSize.h <= 192 * 192)
      // the last free moment. Past this line the png is bought whatever happens
      // next, so everything below still writes it to disk.
      halt()
      // the confirmed prompt rides through verbatim: what the button showed is
      // the whole of what is sent, with nothing appended behind it
      const b64 = await raceStop(
        gate,
        pixellab.mapObject({
          description: t.thing,
          w: useBg ? bgSize.w : w,
          h: useBg ? bgSize.h : h,
          view: OBJECT_VIEW,
          ...(useBg
            ? {
                background: bg,
                // the sprite's intended footprint as a share of the crop, held so
                // the surrounding art always frames it
                fraction: Math.max(0.15, Math.min(0.8, (w * h) / (bgSize.w * bgSize.h))),
              }
            : {}),
          seed: seedOf(b),
        }),
      )
      const item = saveStatic(id, b64, b.name ? cleanName(b.name) : 'gen-' + slugName(prompt), prompt, t.thing)
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
      const b64 = await raceStop(
        gate,
        pixellab.mapObject({
          description: t.thing,
          w: cs.w,
          h: cs.h,
          view: OBJECT_VIEW,
          background: crop,
          fraction,
          seed: seedOf(b),
        }),
      )
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
        if (!frames) return send(res, 200, { item: saveStatic(id, b64, wantName, prompt, t.thing), note: STOPPED_STILL })
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
        return send(res, 200, {
          item: { name: aname, kind: 'animated', frames: rel, fps: 6, w: fsize.w, h: fsize.h },
        })
      }
      return send(res, 200, { item: saveStatic(id, b64, wantName, prompt, t.thing) })
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
      const b64 = await raceStop(
        gate,
        pixellab.mapObject({
          description: t.thing,
          w: aw,
          h: ah,
          view: OBJECT_VIEW,
          seed,
        }),
      )
      // the base is bought. A stop between the two halves saves the second
      // generation, and the first one still lands, as a still object.
      const frames = await stillOnStop(gate, () => pixellab.animate({ base64: b64, action: motion, frameCount: 8, seed }))
      if (!frames) return send(res, 200, { item: saveStatic(id, b64, wantName, prompt, t.thing), note: STOPPED_STILL })
      const dir = libDirOf(id)
      let name = wantName
      for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${wantName}-${i}`
      const fdir = path.join(dir, name)
      fs.mkdirSync(fdir, { recursive: true })
      const rel = []
      for (let i = 0; i < frames.length; i++) {
        fs.writeFileSync(path.join(fdir, i + '.png'), Buffer.from(frames[i], 'base64'))
        rel.push(`/work/${id}/library/${name}/${i}.png`)
      }
      const size = pngSize(path.join(fdir, '0.png'))
      noteAsk(id, name, prompt, t.thing)
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

  // What he typed, back to him. The library only ever kept a four-word slug of
  // the ask, so "what did I write to get that tree?" had no answer anywhere in
  // the app. Newest first.
  if (p.startsWith('/api/asks/')) {
    const id = safeId(decodeURIComponent(p.slice('/api/asks/'.length)))
    const f = path.join(WORK, id, 'asks.json')
    let list = []
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (Array.isArray(j)) list = j
    } catch {
      list = []
    }
    return send(res, 200, { asks: list })
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
    return send(res, 200, { plan: await effectPlan(ask, colors, b.id ? safeId(b.id) : '', String(b.job || '')) })
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
    if (frames.length > 64) return send(res, 400, { error: 'too many frames' })
    const dir = libDirOf(id)
    fs.mkdirSync(dir, { recursive: true })
    const base = cleanName(b.name || 'effect')
    let name = base
    if (b.overwrite) {
      const target = path.resolve(dir, name)
      if (!target.startsWith(path.resolve(dir) + path.sep)) return send(res, 400, { error: 'bad name' })
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory())
        return send(res, 404, { error: 'not in the library' })
    } else {
      for (let i = 2; fs.existsSync(path.join(dir, name)) || fs.existsSync(path.join(dir, name + '.png')); i++)
        name = `${base}-${i}`
    }
    const fdir = path.join(dir, name)
    fs.mkdirSync(fdir, { recursive: true })
    const rel = []
    for (let i = 0; i < frames.length; i++) {
      fs.writeFileSync(path.join(fdir, i + '.png'), Buffer.from(stripDataURL(String(frames[i])), 'base64'))
      rel.push(`/work/${id}/library/${name}/${i}.png`)
    }
    for (let i = frames.length; fs.existsSync(path.join(fdir, i + '.png')); i++) fs.unlinkSync(path.join(fdir, i + '.png'))
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
      ? await reviewWritten(file, ask, frames.length, cleanCode(b.code), cleanControls(b.controls), b.params, job)
      : await reviewRule(file, ask, frames.length, type, b.params, job)
    if (!v) return send(res, 502, { error: 'the planner did not answer', strip: file })
    return send(res, 200, { strip: file, ...v })
  }

  // The same look, over generated objects instead of rendered frames: the
  // candidates side by side with an index number over each, and an answer of
  // which one and why. Looking costs nothing; only regenerating spends, and
  // that stays behind the ui's own armed confirm.
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
    const v = await reviewObjects(file, ask, String(b.prompt || ''), frames.length, String(b.job || ''))
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
  if (p === '/api/asset-crop' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const frames = Array.isArray(b.frames) ? b.frames : []
    if (!frames.length) return send(res, 400, { error: 'no pixels' })
    if (frames.length > 64) return send(res, 400, { error: 'too many frames' })
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
      const prev = path.join(WORK, id, '.prev')
      try {
        fs.mkdirSync(prev, { recursive: true })
        const png = path.join(dir, name + '.png')
        const fdir = path.join(dir, name)
        if (fs.existsSync(png)) fs.copyFileSync(png, path.join(prev, name + '.png'))
        else if (fs.existsSync(fdir) && fs.statSync(fdir).isDirectory()) {
          const pd = path.join(prev, name)
          fs.mkdirSync(pd, { recursive: true })
          for (const f of fs.readdirSync(fdir)) fs.copyFileSync(path.join(fdir, f), path.join(pd, f))
        }
      } catch {
        /* a backup that cannot be written is not a reason to block the edit */
      }
    }
    /* a set of VIEWS goes back under its own names, not as 0.png, 1.png.
     * Without this an edit on eight-sided art wrote frame files beside the
     * views it was supposed to replace and the item ended up as neither. */
    const dirKeys = Array.isArray(b.dirKeys) ? b.dirKeys.map((k) => cleanName(String(k))) : null
    if (dirKeys && dirKeys.length === frames.length) {
      const fdir = path.join(dir, name)
      fs.mkdirSync(fdir, { recursive: true })
      const dirs = {}
      for (let i = 0; i < frames.length; i++) {
        fs.writeFileSync(path.join(fdir, dirKeys[i] + '.png'), Buffer.from(stripDataURL(String(frames[i])), 'base64'))
        dirs[dirKeys[i]] = [`/work/${id}/library/${name}/${dirKeys[i]}.png`]
      }
      fs.writeFileSync(path.join(fdir, 'dirs.json'), JSON.stringify({ dirs }, null, 2))
      const size = pngSize(path.join(fdir, dirKeys[0] + '.png'))
      return send(res, 200, {
        item: {
          name,
          kind: 'static',
          dirs,
          src: dirs.south ? dirs.south[0] : dirs[dirKeys[0]][0],
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
      return send(res, 200, { item: { name, kind: 'animated', frames: rel, fps, w: size.w, h: size.h } })
    }
    const file = name + '.png'
    fs.writeFileSync(path.join(dir, file), Buffer.from(stripDataURL(String(frames[0])), 'base64'))
    const size = pngSize(path.join(dir, file))
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
    if (inside(png) && fs.existsSync(png) && fs.statSync(png).isFile()) {
      fs.unlinkSync(png)
      return send(res, 200, { removed: 'static' })
    }
    if (inside(fdir) && fs.existsSync(fdir) && fs.statSync(fdir).isDirectory()) {
      fs.rmSync(fdir, { recursive: true, force: true })
      return send(res, 200, { removed: 'animated' })
    }
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

  if (p === '/api/export' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const dir = path.join(WORK, id)
    fs.mkdirSync(dir, { recursive: true })
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
    // the placed assets: assets.json per the loader contract, and every used
    // png copied into assets/ so the bundle stands on its own. Sources can be
    // the per-map library, the old shared library, or a reopened bundle's own
    // assets/ folder, so every source byte is read into memory BEFORE the
    // folder is rebuilt; otherwise a re-export would delete its own sources.
    const assetsDir = path.join(dir, 'assets')
    const outAssets = []
    const writes = new Map() // rel path inside assets/ -> png buffer
    for (const a of Array.isArray(b.assets) ? b.assets : []) {
      if (!a || typeof a !== 'object') continue
      const x = Number(a.x)
      const y = Number(a.y)
      const scale = Number(a.scale)
      if (!isFinite(x) || !isFinite(y) || !(scale > 0)) continue
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
      // no extra pixels and nothing to load.
      const life = a.life && typeof a.life === 'object' ? a.life : null
      const tf = { scale: scaleX, scaleX, scaleY, rot, flipX, flipY, ...(life ? { life } : {}) }
      /* a placement with VIEWS: every rotation goes into the bundle under one
       * folder, keyed by the heading it faces. The game picks by where the
       * thing is walking, which is what stops a figure moon-walking. */
      if (a.dirs && typeof a.dirs === 'object' && Object.keys(a.dirs).length) {
        // read into the same buffer map everything else uses: the folder is
        // rebuilt further down, so anything written straight to disk here would
        // be deleted by its own export
        const outDirs = {}
        let metaFile = ''
        for (const [k, arr] of Object.entries(a.dirs)) {
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
            const rel = path.basename(path.dirname(abs)) + '/' + path.basename(abs)
            writes.set(rel, fs.readFileSync(abs))
            out.push('assets/' + rel)
            if (!metaFile) metaFile = path.join(path.dirname(abs), 'dirs.json')
          }
          if (out.length) outDirs[k] = out
        }
        if (Object.keys(outDirs).length) {
          // the rate those frames play at, off the item's own dirs.json the way
          // an animated item carries its fps. A set of single views has nothing
          // to cycle, so the number only ever matters to a walker.
          let fps = Number(a.fps) > 0 ? Math.round(Number(a.fps)) : 8
          try {
            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
            if (Number(meta.fps) > 0) fps = Math.round(Number(meta.fps))
          } catch {
            /* no dirs.json beside the views, or unreadable: the default stands */
          }
          outAssets.push({
            id: String(a.id),
            group: String(a.group || 'props'),
            dirs: outDirs,
            // frame 0 of the front view: a reader that knows nothing about
            // headings still gets a picture rather than a blank
            src: outDirs.south ? outDirs.south[0] : Object.values(outDirs)[0][0],
            fps,
            x,
            y,
            ...tf,
          })
          continue
        }
      }
      if (Array.isArray(a.frames) && a.frames.length) {
        // an animated placement: the frames live together in one folder
        const first = resolveAssetFile(a.frames[0], dir)
        if (!first) continue
        const srcDir = path.dirname(first)
        const dirName = path.basename(srcDir)
        const frames = []
        for (let i = 0; i < a.frames.length; i++) {
          const from = path.join(srcDir, i + '.png')
          if (!fs.existsSync(from)) break
          writes.set(path.join(dirName, i + '.png'), fs.readFileSync(from))
          frames.push(`assets/${dirName}/${i}.png`)
        }
        if (frames.length)
          outAssets.push({ id: String(a.id), group: String(a.group || 'props'), frames, fps: Number(a.fps) > 0 ? Number(a.fps) : 6, x, y, ...tf })
      } else if (a.src) {
        const from = resolveAssetFile(a.src, dir)
        if (!from) continue
        const file = path.basename(from)
        writes.set(file, fs.readFileSync(from))
        outAssets.push({ id: String(a.id), group: String(a.group || 'props'), src: 'assets/' + file, x, y, ...tf })
      }
    }
    fs.rmSync(assetsDir, { recursive: true, force: true })
    for (const [rel, buf] of writes) {
      const to = path.join(assetsDir, rel)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.writeFileSync(to, buf)
    }
    const copied = writes.size
    fs.writeFileSync(path.join(dir, 'assets.json'), JSON.stringify({ assets: outAssets }, null, 2))
    files.push(copied ? `assets.json (+${copied} png${copied > 1 ? 's' : ''})` : 'assets.json')
    return send(res, 200, { dir, files })
  }

  if (p === '/api/save' && req.method === 'POST') {
    const b = await body(req)
    const id = safeId(b.id)
    const dir = path.join(WORK, id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'scene.png'), Buffer.from(stripDataURL(b.image), 'base64'))
    return send(res, 200, { url: `/work/${id}/scene.png` })
  }

  // the cut-applied painting alone, staged before any mechanics exist:
  // scene-cut.png is the deliverable, cut.png is the mask so reopening the
  // scene picks the cut back up
  if (p === '/api/savecut' && req.method === 'POST') {
    const b = await body(req)
    if (!b.image) return send(res, 400, { error: 'no image' })
    const id = safeId(b.id)
    const dir = path.join(WORK, id)
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
    const dir = path.join(WORK, id)
    fs.mkdirSync(dir, { recursive: true })
    // written beside and renamed, because a write killed halfway through leaves
    // a truncated doc that reads as valid until the moment it is needed
    const tmp = path.join(dir, 'doc.json.tmp')
    fs.writeFileSync(tmp, b.doc)
    fs.renameSync(tmp, path.join(dir, 'doc.json'))
    return send(res, 200, { bytes: b.doc.length })
  }

  if (p.startsWith('/api/doc/') && req.method === 'GET') {
    const id = safeId(decodeURIComponent(p.slice('/api/doc/'.length)))
    const f = path.join(WORK, id, 'doc.json')
    if (!f.startsWith(WORK) || !fs.existsSync(f)) return send(res, 200, { doc: '' })
    return send(res, 200, { doc: fs.readFileSync(f, 'utf8') })
  }

  return notFound(res)
}

function serveWork(res, rel) {
  const f = path.join(WORK, rel.split('/').map(decodeURIComponent).join(path.sep))
  if (!f.startsWith(WORK) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return notFound(res)
  res.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream')
  res.setHeader('Cache-Control', 'no-store')
  res.end(fs.readFileSync(f))
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
            items.push({ name: ent.name, kind: 'static', dirs, fps, src: first[0], w, h })
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
function saveRotations(id, detail, wantName) {
  const rot = detail && detail.rotation_urls && typeof detail.rotation_urls === 'object' ? detail.rotation_urls : null
  const DIRS = ['south', 'north', 'east', 'west', 'south-east', 'north-east', 'north-west', 'south-west']
  const got = rot ? DIRS.filter((k) => typeof rot[k] === 'string' && rot[k]) : []
  if (got.length < 4) return null
  const dir = libDirOf(id)
  fs.mkdirSync(dir, { recursive: true })
  const base = cleanName(wantName || detail.name || detail.prompt || 'object')
  let name = base
  for (let i = 2; fs.existsSync(path.join(dir, name)) || fs.existsSync(path.join(dir, name + '.png')); i++)
    name = `${base}-${i}`
  return { name, dir: path.join(dir, name), urls: got.map((k) => [k, rot[k]]) }
}

/* The same plan for a set that has FRAMES INSIDE each heading, which is what a
 * walk cycle is. byDir is heading -> urls in play order.
 *
 * The folder is made here rather than in the writer, so the name is reserved the
 * moment it is picked: two of these running at once could otherwise both look,
 * both see nothing, and both choose it. */
function saveFrames(id, byDir, wantName, fps) {
  const keys = Object.keys(byDir || {}).filter((k) => k && Array.isArray(byDir[k]) && byDir[k].length)
  if (keys.length < 4) return null
  const dir = libDirOf(id)
  fs.mkdirSync(dir, { recursive: true })
  const base = cleanName(wantName || 'someone')
  let name = base
  for (let i = 2; fs.existsSync(path.join(dir, name)) || fs.existsSync(path.join(dir, name + '.png')); i++)
    name = `${base}-${i}`
  const plan = { name, dir: path.join(dir, name), urls: keys.map((k) => [k, byDir[k]]), frames: true, fps }
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
function saveStatic(id, b64, wantName, ask, prompt) {
  const dir = libDirOf(id)
  fs.mkdirSync(dir, { recursive: true })
  const base = cleanName(wantName)
  let file = base + '.png'
  for (let i = 2; fs.existsSync(path.join(dir, file)); i++) file = `${base}-${i}.png`
  fs.writeFileSync(path.join(dir, file), Buffer.from(b64, 'base64'))
  const size = pngSize(path.join(dir, file))
  const name = file.replace(/\.png$/i, '')
  noteAsk(id, name, ask, prompt)
  return { name, kind: 'static', src: `/work/${id}/library/${file}`, w: size.w, h: size.h }
}

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

// the camera angle every object on this tool is drawn at. The maps are 2:1
// isometric paintings, so a standing thing has to show its sides; "high
// top-down" looks down on a lid. One constant, so the projection can never
// disagree with the words in the prompt.
const OBJECT_VIEW = 'low top-down'

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
 * slabs. The 47 objects on this account he rates as good are 60 to 100 words
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

function housePrompt({ subject, detail, palette, clause }) {
  const bits = [
    subject + ' in strict 2:1 isometric pixel art',
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
  )
  if (sprite) lines.push(...spriteLines(kind))
  else {
    lines.push(
      ``,
      `Choose the sprite's pixel size so it is in scale with things already there. Say what you ` +
        `measured it against. Both sides must be between 32 and 128: that is the generator's own ` +
        `ceiling, and a bigger number is not honoured, it is quietly cut down to 128. If the thing ` +
        `wants to be taller than it is wide, spend the height and narrow the width.`,
    )
    if (kind === 'animated')
      lines.push(
        ``,
        `This one animates, so also give the motion as movement words alone, no subject: the ` +
          `animator is handed the finished sprite and those words.`,
      )
  }
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
    sprite
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
  const o = planJSON(raw, 'prompt')
  if (!o || !o.prompt) throw new Error('the interpreter did not answer')
  const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n)
  const plan = {
    kind: sprite ? 'sprite' : 'object',
    prompt: clean(o.prompt, PROMPT_MAX),
    motion: clean(o.motion, 160),
    note: clean(o.note, 240),
    crossing: clean(o.crossing, 200),
    w: clampPx(o.w),
    h: clampPx(o.h),
  }
  if (sprite) plan.sprite = spriteRoute(o.sprite, kind, plan.motion)
  return plan
}

const OBJECT_ANSWER =
  `{"kind":"object","prompt":"the full generator prompt, 40 to 90 words","w":96,"h":128,` +
  `"motion":"movement words only, or empty","crossing":"",` +
  `"note":"one short line, lower case, telling the user what you decided and what you sized it against"}`

const SPRITE_ANSWER =
  `{"kind":"sprite","prompt":"the full character description, 30 to 70 words","w":48,"h":48,` +
  `"motion":"","note":"one short lower-case line on what you decided","crossing":"",` +
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
 * answer is corrected into the nearest honest one rather than sent. */
function spriteRoute(raw, kind, motion) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const skeleton = SKELETONS.includes(String(s.skeleton)) ? String(s.skeleton) : 'mannequin'
  const view = CHAR_VIEWS.includes(String(s.view)) ? String(s.view) : OBJECT_VIEW
  const n = Math.round(Number(s.size))
  const size = isFinite(n) && n > 0 ? Math.max(SPRITE_MIN, Math.min(SPRITE_MAX, n)) : 48
  return {
    skeleton,
    view,
    size,
    anim: spriteAnim(s.anim, kind, skeleton, motion),
    why: String(s.why || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  }
}

/* how the thing moves, and the two demotions that save a paid body.
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
 * work it out from the body it was handed. */
function spriteAnim(raw, kind, skeleton, motion) {
  const a = raw && typeof raw === 'object' ? raw : {}
  const how = String(a.how || '')
  if (kind !== 'animated' || how === 'none') return { how: 'none' }
  const tpl = String(a.template || '').toLowerCase().trim()
  if (how === 'template' && skeleton === 'mannequin' && WALK_TEMPLATES.includes(tpl))
    return { how: 'template', template: tpl }
  const words =
    String(a.action || '').replace(/\s+/g, ' ').trim() || motion || 'moving in place, ending where it began'
  const f = Math.round(Number(a.frames))
  const frames = isFinite(f) && f >= 4 ? Math.min(16, f % 2 ? f + 1 : f) : 8
  return { how: 'action', action: words.slice(0, 300), frames }
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
      `stone under the object. Name the object and its own materials only, and write each prompt ` +
      `so the result looks painted by the same hand as this map: its light direction, its value ` +
      `range, its outline treatment, its saturation, its pixel chunkiness.`,
    ``,
    `Sizes are in pixels, both sides between 24 and 128, and in scale with what is already in the ` +
      `area.`,
    kind === 'animated' ? `Each one animates, so give motion as movement words alone.` : ``,
    ``,
    `Answer with ONLY this JSON, no prose:`,
    `{"note":"one short lower-case line on what you decided","items":[{"what":"two or three words ` +
      `naming it","prompt":"the full generator prompt, 30 to 70 words","w":64,"h":80,"x":0,"y":0,` +
      `"motion":""}]}`,
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
    prompt: clean(it.prompt, PROMPT_MAX),
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
    thing: housePrompt({ subject: ask, detail: '', palette: 'muted natural palette', clause }),
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
        `Kind: ${kind} object for a 2:1 isometric pixel-art game map.\n` +
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
        `arrived from elsewhere (an alien artifact, a magic item, a neon sign) is 0.2.\n\n` +
        `Answer immediately with ONLY this JSON, no prose:\n` +
        `{"subject":"...","detail":"...","palette":"...","motion":"","w":96,"h":128,"belongs":1}`,
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
      }),
      motion: String(o.motion || '').slice(0, 120),
      w: clampPx(o.w),
      h: clampPx(o.h),
      belongs,
    }
  } catch {
    return fallback
  }
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
const CUSTOM_API_DOC =
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

async function effectPlan(ask, colors, id, job) {
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
        `When in doubt, WRITE IT. A written renderer that misses can be discarded for free; a ` +
        `rule that quietly substitutes its own idea wastes the person's time and looks like the ` +
        `tool ignored them. A measured example: "swirling purple portal like a minecraft nether ` +
        `portal" was answered with the swirl rule and came back as concentric rings, a galaxy, ` +
        `nothing like a nether portal, which is a tall rectangular frame of churning violet with ` +
        `a dark core and brighter threads rising through it. That ask should have been custom.\n\n` +
        CUSTOM_API_DOC +
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
async function reviewWritten(file, ask, frames, code, controls, params, job) {
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
        CUSTOM_API_DOC +
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

/* The objects, looked at. They are already paid for, so this only decides which
 * one and says why, and the ui opens on that one with all of them still on
 * screen. fix is the escape hatch when none of them are usable: a corrected
 * prompt, which costs generations and so stays behind the armed confirm. */
async function reviewObjects(file, ask, prompt, n, job) {
  try {
    const raw = await runPlanner(
      `Look at these ${n} sprite${n === 1 ? '' : 's'} and say whether the ask was answered.\n\n` +
        `The file, an absolute path, read it first:\n${file}\n\n` +
        `${
          n === 1
            ? `It is one pixel-art sprite with a 1 drawn over it, blown up 3x with no smoothing, on a flat grey field.`
            : `It is ${n} pixel-art sprites side by side, each with its index number drawn over it, blown up 3x with no smoothing, on a flat grey field.`
        } The grey is the sheet, not the art: every transparent pixel shows it.\n\n` +
        `What was asked for, in the person's own words: "${ask}"\n` +
        `The prompt that drew them: "${String(prompt).slice(0, 700)}"\n\n` +
        `These stand on a hand-painted 2:1 isometric game map at a small size, so what matters is: ` +
        `is it the thing that was asked for, does its silhouette read at a glance, is it one object ` +
        `with nothing else drawn beside it, does it stand on nothing (no ground, no slab, no ` +
        `plinth, no shadow disc), is anything cut off at the edge of the canvas, and is the ` +
        `shading solid rather than muddy.\n\n` +
        `best: the index number of the one you would keep${n === 1 ? ', which is 1' : ''}.\n` +
        `why: one short line, lowercase, plain words, saying what makes that one the keeper.\n` +
        `fix: EMPTY unless none of them are usable. Only when none are, write a corrected prompt ` +
        `to try instead, in the same shape as the one above, changing only what went wrong.\n\n` +
        `Answer immediately with ONLY this JSON, no prose:\n` +
        `{"best":1,"why":"the only one whose shape reads small","fix":""}`,
      120000,
      job,
    )
    const o = planJSON(raw)
    if (!o) return null
    const best = Math.max(1, Math.min(n, Math.round(Number(o.best)) || 1))
    return { best, why: oneLine(o.why), fix: oneLine(o.fix, 1200) }
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

function runPlanner(prompt, timeoutMs, job) {
  return new Promise((resolve, reject) => {
    let ps
    try {
      // the strong model, never a fast one: the rewrite IS the product, and a
      // small model's decorations cost real generations ("crystalline" turned a
      // water sparkle into an ice cube, 2026-08-16)
      /* Bounded on purpose.
       *
       * A planner handed two images and asked for a list went into a tool loop:
       * read the map, read the crop, then read them AGAIN to check itself, and
       * never finish. Measured 2026-08-20: it burned the full five-minute
       * timeout and came back with nothing, while the same words answered in
       * fifteen seconds once it was told to look once.
       *
       * Read is the only tool any of these need and now the only one they get,
       * and the turn cap makes an unproductive loop fail in a minute rather
       * than hang for five. The real fix is in the prompts, which say to read
       * once and answer; these two are the fence behind it. */
      ps = spawn(
        'claude',
        ['-p', '--output-format', 'json', '--model', PLANNER_MODEL, '--max-turns', '6', '--allowedTools', 'Read'],
        { windowsHide: true, shell: true },
      )
    } catch (e) {
      return reject(e)
    }
    if (job) LIVE.set(job, ps)
    let out = ''
    let err = ''
    let done = false
    const finish = () => {
      if (job && LIVE.get(job) === ps) LIVE.delete(job)
    }
    const t = setTimeout(() => {
      if (done) return
      done = true
      finish()
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(ps.pid), '/T', '/F'], { windowsHide: true })
        else ps.kill()
      } catch {
        /* already gone */
      }
      reject(new Error('the interpreter timed out'))
    }, timeoutMs)
    ps.stdout.on('data', (d) => (out += d))
    ps.stderr.on('data', (d) => (err += d))
    ps.on('error', (e) => {
      if (done) return
      done = true
      finish()
      clearTimeout(t)
      reject(e)
    })
    ps.on('close', (code) => {
      if (done) return
      done = true
      const killed = job && !LIVE.has(job)
      finish()
      clearTimeout(t)
      if (killed) reject(new Error('stopped'))
      else if (code === 0) resolve(out)
      else reject(new Error((err || 'the interpreter exited ' + code).slice(-300)))
    })
    ps.stdin.on('error', () => {})
    ps.stdin.write(prompt)
    ps.stdin.end()
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

function body(req) {
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
const safeId = (s) => (String(s || 'untitled').replace(/[^a-z0-9._-]+/gi, '-') || 'untitled').slice(0, 60)

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
