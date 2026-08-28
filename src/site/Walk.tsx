/* Walking a published map, properly.
 *
 * The first version drew the painting and a yellow stick, which was a test
 * harness with a play button on it. This draws the map: every placement, moving
 * on its real life data, y-sorted against you, with Thor as Thor.
 *
 * It reads the ATLAS when there is one, so the hub costs six requests instead
 * of eight hundred. Frames come out of one sheet by rectangle, which is the
 * same drawImage the loose files needed, minus 794 downloads.
 *
 * THE WALK LAW IS IMPORTED, NOT REWRITTEN.
 *
 * This file used to carry its own copy of the step test, and it had drifted
 * four ways from the one the editor runs: it probed the hip band at y + hipDY
 * where the real law probes y - hipDY, it demanded every pixel across the band
 * be legal where the real law checks exactly the two hip points, it compared
 * heights against the destination instead of against the level being stepped
 * off, and it had none of the escape clause that lets a character standing on a
 * blocked pixel move at all. The result was invisible walls, a character who
 * could walk off the quay, and a walk test that disagreed with the tool that
 * drew the mask, which makes it worse than no walk test.
 *
 * So canStandFrom and Walker come from src/core/walk.ts, the same functions the
 * levels step uses, driven through a tiny adapter over the published levels png.
 * They cannot disagree now, because there is only one of them.
 */
import { useEffect, useRef, useState } from 'react'
import { bodyAt, cleanLife, lifeAt, separate, type Body, type Life } from '../core/life'
import { Walker, canStand, defaultCfg, type WalkCfg } from '../core/walk'
import type { MaskDoc } from '../core/mask'

type Rect = [number, number, number, number]
type Placed = {
  x: number
  y: number
  group?: string
  scale?: number
  scaleX?: number
  scaleY?: number
  rot?: number
  flipX?: boolean
  flipY?: boolean
  src?: string
  srcAt?: Rect
  frames?: string[]
  framesAt?: Rect[]
  dirs?: Record<string, string[]>
  dirsAt?: Record<string, Rect[]>
  fps?: number
  life?: unknown
  /* [ox, oy, rx, ry]: the ellipse this thing's base covers, in painting pixels
   * relative to its anchor, measured off its own art at publish. Optional, and
   * a bundle published before footprints existed simply has none. See
   * server/store/publish.mjs for how it is measured and why. */
  foot?: number[]
}
/* one drawable: either a rectangle in the sheet, or its own image */
type Cell = { img: HTMLImageElement; r: Rect }
type Live = { p: Placed; life: Life | null; still?: Cell; frames: Cell[]; dirs: Record<string, Cell[]>; fps: number }

const HEADINGS = ['south', 'south-west', 'west', 'north-west', 'north', 'north-east', 'east', 'south-east']

const load = (src: string) =>
  new Promise<HTMLImageElement | null>((res) => {
    const i = new Image()
    i.crossOrigin = 'anonymous'
    i.onload = () => res(i)
    i.onerror = () => res(null)
    i.src = src
  })

export function Walk({ slug, version }: { slug: string; version: number }) {
  const mount = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'playing' | 'failed'>('loading')
  const [near, setNear] = useState('')
  const [why, setWhy] = useState('')
  const [where, setAt] = useState('')
  /* The camera, in a ref beside the state.
   *
   * The draw loop is inside an effect that must not restart when the camera
   * changes, because restarting it reloads the atlas and puts Thor back at the
   * spawn. The ref is what the loop reads; the state is only what the button
   * renders itself from. */
  const [mode, setMode] = useState<'island' | 'pov'>('island')
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [showMask, setShowMask] = useState(false)
  const maskRef = useRef(showMask)
  maskRef.current = showMask

  useEffect(() => {
    let dead = false
    let raf = 0
    const keys = new Set<string>()
    const down = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault()
      keys.add(e.key.toLowerCase())
    }
    const up = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase())

    ;(async () => {
      try {
        const base = `/api/v1/maps/${slug}/file/${version}/`
        const meta = await (await fetch(`${base}map.json`)).json()
        const [scene, levels] = await Promise.all([load(`${base}scene.png`), load(`${base}levels.png`)])
        if (dead) return
        if (!scene) throw new Error('the painting would not load')

        // the levels plane, read once. A canvas readback per frame is a stall
        // on every step.
        let lv: Uint8ClampedArray | null = null
        if (levels) {
          const lc = document.createElement('canvas')
          lc.width = meta.w
          lc.height = meta.h
          const lg = lc.getContext('2d', { willReadFrequently: true })!
          lg.drawImage(levels, 0, 0)
          lv = lg.getImageData(0, 0, meta.w, meta.h).data
        }
        /* lvlAt, TO THE LETTER. See MaskDoc.lvlAt in src/core/mask.ts.
         *
         * Two differences hid here and both changed where the walls are.
         *
         * It ROUNDS. This read the level with `| 0`, which truncates, so every
         * fractional position, and a walking character is never on an integer,
         * tested a different pixel than the editor tests. That is a systematic
         * half-pixel shift between the ground you see and the ground you may
         * stand on, and at the pov zoom it is several screen pixels.
         *
         * Off the map is BLOCKED, not ground. This returned 40, which is L0,
         * the encoding for ordinary walkable floor. So the entire outside of the
         * canvas read as standable and a character who reached an edge kept
         * going into nothing. lvlAt returns 0 there, which is blocked. */
        const at = (x: number, y: number) => {
          const xi = Math.round(x)
          const yi = Math.round(y)
          if (!lv || xi < 0 || yi < 0 || xi >= meta.w || yi >= meta.h) return 0
          return lv[(yi * meta.w + xi) * 4]
        }

        // ---- the placements ------------------------------------------------
        const aj = await (await fetch(`${base}assets.json`)).json().catch(() => ({ assets: [] }))
        const list: Placed[] = aj.assets || []
        let sheet: HTMLImageElement | null = null
        if (aj.atlas) sheet = await load(base + aj.atlas)

        const cellOf = async (url?: string, rect?: Rect): Promise<Cell | undefined> => {
          if (rect && sheet) return { img: sheet, r: rect }
          if (!url) return undefined
          const i = await load(base + url)
          return i ? { img: i, r: [0, 0, i.width, i.height] } : undefined
        }

        const live: Live[] = []
        for (const p of list) {
          if (dead) return
          const v: Live = { p, life: cleanLife(p.life), frames: [], dirs: {}, fps: p.fps || 6 }
          v.still = await cellOf(p.src, p.srcAt)
          if (p.frames)
            for (let i = 0; i < p.frames.length; i++) {
              const c = await cellOf(p.frames[i], p.framesAt?.[i])
              if (c) v.frames.push(c)
            }
          const dirs = p.dirsAt || p.dirs
          if (dirs)
            for (const [k, arr] of Object.entries(dirs)) {
              const out: Cell[] = []
              for (let i = 0; i < arr.length; i++) {
                const c = await cellOf(p.dirs?.[k]?.[i], p.dirsAt?.[k]?.[i])
                if (c) out.push(c)
              }
              if (out.length) v.dirs[k] = out
            }
          if (v.still || v.frames.length || Object.keys(v.dirs).length) live.push(v)
        }

        // ---- Thor ----------------------------------------------------------
        /* THOR'S FEET, NOT THOR'S FILE.
         *
         * The frames are 144x144 and the panther stands in the middle of that:
         * measured, rows 39 to 105, which leaves 38 rows of empty pixels BELOW
         * his feet. Drawing the whole frame with its bottom edge on the walk
         * position therefore hangs him almost five painting pixels above the
         * ground he is actually standing on, and scales him to half the height
         * map.json asks for, because 144 is mostly padding.
         *
         * That single offset is every symptom at once. His feet look like they
         * are over the water while his collision point is still on the quay, so
         * he "walks off the harbour". He looks like he is in open street while
         * his collision point is already against a wall, so he "gets stuck on
         * nothing". And the whole character reads as sitting slightly up and
         * left of where he is, which is the shifted feeling.
         *
         * So each frame is measured once, and from here on only the drawn
         * pixels exist: the crop is the sprite, its height is what charH scales,
         * and the bottom of the CONTENT is what lands on the walk position.
         *
         * editor.ts:4693 solved this already and says so: "the canvas padding
         * under the feet is what floats a character above the mask". This is
         * that same trimToFeet, to the letter, because the third copy of a rule
         * is how the first two started.
         *
         * Two details that are not optional. The crop keeps rows 0..feet: the
         * padding ABOVE the head stays and is taken out of the scale instead, by
         * measuring from the first drawn row. And the scale uses ONE height, the
         * standing south frame's, for every frame: a per-frame height makes him
         * pulse as he walks, because east is drawn 75 rows tall and south 67. */
        const A_MIN = 40 // the repo-wide alpha threshold
        type Frame = { img: HTMLImageElement; feet: number; top: number }
        const trimToFeet = (im: HTMLImageElement): Frame | null => {
          try {
            const c = document.createElement('canvas')
            c.width = im.width
            c.height = im.height
            const tg = c.getContext('2d', { willReadFrequently: true })!
            tg.drawImage(im, 0, 0)
            const d = tg.getImageData(0, 0, im.width, im.height).data
            let top = -1
            let feet = -1
            for (let y = 0; y < im.height; y++) {
              let hit = false
              for (let x = 0; x < im.width && !hit; x++) if (d[(y * im.width + x) * 4 + 3] > A_MIN) hit = true
              if (hit) {
                if (top < 0) top = y
                feet = y
              }
            }
            return feet < 0 ? null : { img: im, feet, top }
          } catch {
            return null
          }
        }
        const thor: Record<string, Frame[]> = {}
        await Promise.all(
          HEADINGS.map(async (h) => {
            const set: Frame[] = []
            for (let i = 0; i < 6; i++) {
              const im = await load(`/thor/${h}/${i}.png`)
              const t = im && trimToFeet(im)
              if (t) set.push(t)
            }
            if (set.length) thor[h] = set
          }),
        )
        // the standing south frame is the one charH measures, exactly as the rig does
        // 1 is never used: with no frames at all the draw takes its capsule
        // fallback and never reaches the scale.
        const stand = thor.south?.[0] || Object.values(thor)[0]?.[0]
        const drawnH = stand ? stand.feet - stand.top + 1 : 1

        if (dead) return
        const el = mount.current!
        const cv = document.createElement('canvas')
        cv.className = 'walk-canvas'
        el.replaceChildren(cv)
        const g = cv.getContext('2d')!

        let px = meta.spawn?.[0] ?? meta.w / 2
        let py = meta.spawn?.[1] ?? meta.h / 2
        let facing = 'south'
        let stepT = 0
        const tol = meta.encoding?.stepTolerance ?? 10
        const speed = meta.speed || 34
        const yScale = meta.yScale ?? 0.72
        const hip = meta.character?.hip ?? 2
        const charH = meta.character?.heightPx ?? 18

        /* The game's walk law, including hipDY.
         *
         * The band is tested at y + hipDY, not at y: feet sit a pixel or two
         * below the point the collision is meant to read, and dropping that
         * offset shifts every test by that much. Close enough to look right and
         * wrong enough that Thor walks a pixel past a wall and jams against the
         * next one. */
        const hipDY = meta.character?.hipDY ?? 0

        /* The map's own numbers, in the shape the shared law expects. near is
         * stepTolerance under its editor name: how much height a step may cross.
         * Anything the bundle does not carry falls back to the same defaults the
         * exporter writes, so an older bundle walks the way it always did. */
        const cfg: WalkCfg = { ...defaultCfg(), speed, hip, hipDY, near: tol, charH, yScale }

        /* canStandFrom only ever asks a document for one thing, the level under
         * a pixel, and markHit is the editor painting its refused-move layer,
         * which a published map has nowhere to put. So the whole document
         * interface a published bundle needs is these two. */
        /* WHO ACTUALLY STOPS YOU: a stander, not a walker.
         *
         * Blocking the player against everybody is real and unplayable: the
         * pier is a two pixel strip with people on it, so the crowd becomes a
         * wall and he gets 9px along the harbour instead of 235. Blocking
         * against nobody is what he complained about, walking through people
         * like fog.
         *
         * The distinction that makes both true is the one already in the data.
         * Something with life can step aside, and does, because the push below
         * treats the player as immovable and ejects the crowd from him. Some-
         * thing without life is a statue, a crate, a market stall: it has no way
         * to move and it should stop you dead. So the hard test is against the
         * still ones only, and the living ones give way.
         *
         * Rebuilt at the end of each frame and read by the next one. The one
         * frame of lag is 16ms and it is what keeps this acyclic: the floor a
         * figure walks on cannot depend on where that figure ends up this frame. */
        const solids: Body[] = []
        /* THE BODY OF ONE PLACEMENT, footprint first.
         *
         * A published bundle now carries `foot`, the ellipse its base actually
         * covers, measured off its own art. Where there is one it is the body,
         * offset from the anchor because the anchor is the front of the base
         * rather than its middle.
         *
         * Where there is none, the circle of radius 3 at the anchor that shipped
         * before footprints existed. That fallback is not a nicety, it is the
         * whole of the backward compatibility promise: every bundle published up
         * to v5 of the hub has no foot and has to walk the way it always did.
         *
         * AN EFFECT IS NEVER SOLID, whether or not it carries a footprint. Smoke,
         * a waterfall, the wash across the sand and the glow over a door are
         * drawn over the ground rather than standing on it, and there are 19 of
         * them on the hub. The publisher already writes them a zero footprint,
         * but the same refusal is here as well and not only there, because the
         * bundles already published carry no footprint at all and one of those
         * effects sits on the Panther's Maw door: with only the anchor circle to
         * go on it put a body in the doorway. This is cheap and it makes an old
         * bundle better instead of merely no worse. */
        const bodyOf = (p: Placed, x: number, y: number, r: number): Body | null => {
          if (p.group === 'effects') return null
          const f = p.foot
          if (!f) return { x, y, r }
          if (!(f[2] > 0) || !(f[3] > 0)) return null
          // r is kept sane rather than zero so anything that reads it without
          // knowing about rx and ry still gets a circle roughly the right size
          return { x: x + f[0], y: y + f[1], r: f[2], rx: f[2], ry: f[3] }
        }

        /* The floor is TERRAIN, for the player and for the mask overlay alike.
         *
         * Folding bodies into lvlAt was tried and it walls him in: the hip
         * probes read two pixels either side, so a body blocks a five pixel
         * band, and a crowded quay becomes a fence. Measured, he got 18px along
         * the harbour instead of 235. Bodies are handled after the step instead,
         * where they can stop him without narrowing the ground.
         *
         * The 18 and the 235 are from that experiment and from the bundle it ran
         * against; neither reproduces now. What survives is the reason, which is
         * geometric and does not depend on a map: whatever goes into lvlAt is
         * read three times per step, once at the feet and once at each hip. */
        const docLike = { lvlAt: (x: number, y: number) => at(x, y), markHit: () => {} } as unknown as MaskDoc
        const standable = (x: number, y: number) => canStand(docLike, cfg, x, y)
        const bareStand = standable
        // "is somebody already there", read after a step rather than folded into
        // the floor: the floor has to stay still or lifeAt stops being pure
        const occupied = bodyAt(solids, yScale)
        /* Where the ground actually is, measured once off the levels plane.
         * Everything on screen is framed against this rather than against the
         * canvas the ground happens to sit inside. */
        /* A SPAWN THAT IS NOT STANDABLE IS A CHARACTER WHO CANNOT MOVE.
         *
         * Movement only commits a step the collision test accepts, so starting
         * on a pixel that fails the test leaves every direction refused and Thor
         * frozen on the spot with no way to tell why. The hub spawns at 557,508
         * and hip is 2, so the test reads five pixels across and one of them is
         * off the edge of the walkable band. The nearest pixel that does pass is
         * 556,507, one across and one up.
         *
         * A whole map is not broken by one pixel. The spawn is a hint, so it is
         * treated as one: search outward for the closest standable pixel and
         * start there. Nothing is written back, because the document belongs to
         * the author and the editor is where a spawn gets moved on purpose. */
        const roomy = (x: number, y: number) =>
          standable(x, y) &&
          standable(x - 1, y) &&
          standable(x + 1, y) &&
          standable(x, y - 1) &&
          standable(x, y + 1)
        const settle = (x: number, y: number, reach = 96) => {
          if (roomy(x, y)) return { x, y }
          // two passes outward: somewhere with elbow room first, then anywhere
          // standable at all. Landing hard against a wall is technically legal
          // and reads as being stuck, because half the directions refuse.
          let any: { x: number; y: number } | null = null
          for (let r = 1; r <= reach; r++)
            for (let a = 0; a < 360; a += 5) {
              const nx = Math.round(x + Math.cos((a * Math.PI) / 180) * r)
              const ny = Math.round(y + Math.sin((a * Math.PI) / 180) * r)
              if (roomy(nx, ny)) return { x: nx, y: ny }
              if (!any && standable(nx, ny)) any = { x: nx, y: ny }
            }
          // nothing within reach is standable, so leave the hint alone rather
          // than teleporting somebody to a corner of the canvas
          return any || { x, y }
        }
        ;({ x: px, y: py } = settle(px, py))
        const walker = new Walker([px, py])

        /* Built once, at map resolution, from the same lvlAt the law uses.
         * Green is a pixel the mask marks; yellow is a pixel a body can actually
         * stand on, which is the stricter thing and the one that decides whether
         * you move. Seeing both at once is how you tell "I did not paint here"
         * apart from "I painted a strip too narrow to stand in". */
        const maskCv = (() => {
          try {
            const c = document.createElement('canvas')
            c.width = meta.w
            c.height = meta.h
            const mg = c.getContext('2d')!
            const im = mg.createImageData(meta.w, meta.h)
            for (let y = 0; y < meta.h; y++)
              for (let x = 0; x < meta.w; x++) {
                const i = (y * meta.w + x) * 4
                if (at(x, y) <= 0) continue
                const ok = standable(x, y)
                im.data[i] = ok ? 250 : 40
                im.data[i + 1] = ok ? 240 : 200
                im.data[i + 2] = ok ? 60 : 90
                im.data[i + 3] = 130
              }
            mg.putImageData(im, 0, 0)
            return c
          } catch {
            return null
          }
        })()

        /* A WALKER STANDING OFF THE GROUND CANNOT WALK.
         *
         * lifeAt is handed the collision test so a wandering figure stays on the
         * floor, which means a figure whose own position fails that test has
         * nowhere legal to step and holds still forever. Seven of the hub's
         * twenty-two moving placements are in exactly that state, sitting a
         * pixel or two off the walkable band, and they read on screen as people
         * frozen mid-street while the ones beside them move.
         *
         * A PLACEMENT IS NEVER MOVED. This used to nudge any life-bearing
         * placement up to eight pixels onto the nearest walkable pixel, on the
         * theory that a figure standing just off the floor had slipped. That was
         * wrong, and visibly so: the hub's three rowboats carry life "drift",
         * they float on water, water is not walkable, and the nudge hauled two
         * of them out of the harbour and parked them on the quay.
         *
         * Not everything that moves walks. drift, bob, airborne and rock are all
         * movement that has no business touching the floor, and only walkOnly
         * and the wandering figures ever ask. Deciding here which is which means
         * re-implementing life's own rules, badly, for the second time in one
         * file. So the reader stops guessing and stops moving people's art.
         *
         * A walker that genuinely cannot move is a hole in the mask, which is a
         * fact about the map and belongs in front of the author rather than
         * hidden by a fudge. Named below, with coordinates, and left where the
         * author put it. */
        /* walkPct IS DERIVED DATA, SO DERIVE IT RATHER THAN TRUST IT.
         *
         * It is the 35% law's input: at or above the threshold a figure is held
         * to the walkable pixels inside its box and told the area is open;
         * below it, the box alone fences it. The editor measured it once when
         * the box was drawn and then carried the number through every drag and
         * every duplicate, so on this map 8 of 17 walkOnly placements carry a
         * fraction measured somewhere they no longer stand: 63.2 percent stored
         * against 20.3 percent real. Fenced to a box with almost no floor in
         * it, life falls back to holding still for a whole leg, which is the
         * figures that stop for no visible reason and then start again.
         *
         * Fixing the editor stops it happening to boxes moved from now on. It
         * does nothing for the bundles already published, and this page reads a
         * published bundle. The mask is right here, so the honest thing is to
         * measure it now instead of believing a number from a previous position.
         * Same sampling as editor.ts walkFraction, so the two agree. */
        const walkFraction = (r: { x: number; y: number; w: number; h: number }) => {
          const step = Math.max(1, Math.floor(Math.min(r.w, r.h) / 40))
          let seen = 0
          let walk = 0
          for (let y = r.y; y < r.y + r.h; y += step)
            for (let x = r.x; x < r.x + r.w; x += step) {
              if (x < 0 || y < 0 || x >= meta.w || y >= meta.h) continue
              seen++
              if (at(x, y) > 0) walk++
            }
          return seen ? walk / seen : 0
        }
        let restated = 0
        for (const v of live) {
          const life = v.life as { bounds?: { x: number; y: number; w: number; h: number }; walkPct?: number } | null
          if (!life?.bounds || typeof life.walkPct !== 'number') continue
          const now = walkFraction(life.bounds)
          if (Math.abs(now - life.walkPct) > 0.01) restated++
          life.walkPct = now
        }
        if (restated) console.warn(`[walk] ${restated} placement(s) carried a stale walkPct; re-measured from the mask`)

        const stuckWalkers = live
          .filter((v) => v.life && !standable(v.p.x, v.p.y))
          .map((v) => `${(v.p as { id?: string }).id ?? '?'} at ${v.p.x},${v.p.y}`)
        if (stuckWalkers.length)
          console.warn(
            `[walk] ${stuckWalkers.length} moving placement(s) are not on walkable ground: ` +
              `${stuckWalkers.join('; ')}. If one of them is meant to walk, the mask under it needs ` +
              `widening in the levels step. If it floats or bobs, this is expected.`,
          )

        const land = (() => {
          let x0 = meta.w
          let y0 = meta.h
          let x1 = 0
          let y1 = 0
          for (let y = 0; y < meta.h; y++)
            for (let x = 0; x < meta.w; x++)
              if (at(x, y) > (meta.encoding?.blocked ?? 0)) {
                if (x < x0) x0 = x
                if (y < y0) y0 = y
                if (x > x1) x1 = x
                if (y > y1) y1 = y
              }
          return x1 > x0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w: meta.w, h: meta.h }
        })()

        /* WHAT TO FRAME IS THE PICTURE, NOT THE WALKABLE STRIP.
         *
         * Zoom used to fit `land`, the bounding box of standable pixels. On the
         * hub that box is 534x185 while the painting is 688x640, because the
         * ground people can stand on is a band across the middle and the volcano,
         * the cliffs and the rooftops are all above it. Fitting the band picked
         * zoom 3 and drew the scene at 2064x1920 inside an 880-tall window, so
         * the island was enormous and cut off at the top and bottom. Fitting the
         * bare canvas is the other failure the old comment describes: a painting
         * carries transparent margin, so that leaves the island a stamp in a
         * field of black.
         *
         * The thing that is neither is the painting's own visible extent: the
         * alpha bounding box. Read once, off the image already loaded. Unioned
         * with land so no standable pixel can ever fall outside the view, and
         * falling back to land if the readback is refused. */
        const view = (() => {
          try {
            const c = document.createElement('canvas')
            c.width = meta.w
            c.height = meta.h
            const cg = c.getContext('2d', { willReadFrequently: true })!
            cg.drawImage(scene, 0, 0, meta.w, meta.h)
            const d = cg.getImageData(0, 0, meta.w, meta.h).data
            let x0 = meta.w
            let y0 = meta.h
            let x1 = -1
            let y1 = -1
            for (let y = 0; y < meta.h; y++)
              for (let x = 0; x < meta.w; x++)
                if (d[(y * meta.w + x) * 4 + 3] > 8) {
                  if (x < x0) x0 = x
                  if (y < y0) y0 = y
                  if (x > x1) x1 = x
                  if (y > y1) y1 = y
                }
            if (x1 < x0) return land
            const ax = Math.min(x0, land.x)
            const ay = Math.min(y0, land.y)
            const bx = Math.max(x1, land.x + land.w - 1)
            const by = Math.max(y1, land.y + land.h - 1)
            return { x: ax, y: ay, w: bx - ax + 1, h: by - ay + 1 }
          } catch {
            return land
          }
        })()

        // Which way Thor faces is now Walker's own dirFrom, off the same squash,
        // so the picked view matches the editor's walk test rather than a second
        // rounding of the same angle.

        let last = performance.now()
        const draw = (now: number) => {
          if (dead) return
          const dt = Math.min(0.05, (now - last) / 1000)
          last = now
          const t = now / 1000

          /* The editor's own Walker, stepped with the editor's own keys map, so
           * the axis slide, the height rule and the escape clause for standing
           * on a blocked pixel are all the ones the levels step demonstrates
           * rather than a second interpretation of them. */
          const held: Record<string, boolean> = {}
          for (const k of keys) held[k] = true
          const moving = !!(
            held.w ||
            held.a ||
            held.s ||
            held.d ||
            held.arrowup ||
            held.arrowdown ||
            held.arrowleft ||
            held.arrowright
          )
          /* A WALKER GIVES WAY; A STANDER DOES NOT. TWO CONTACTS, ON PURPOSE.
           *
           * Something with life can step aside and does, because the push below
           * treats the player as an immovable body and ejects the crowd from
           * him: walk into a fishwife and she moves. Blocking him against her as
           * well ends the game at the pier, where the standable strip is about
           * two pixels across with people standing on it and the crowd becomes a
           * fence.
           *
           * Something with no life has no way to step aside, so it stops him.
           * That is the test below, and what it measures him against is that
           * thing's footprint rather than a dot at its anchor. */
          const bx = walker.x
          const by = walker.y
          walker.step(docLike, cfg, held, dt)
          /* A THING IS SOMETHING YOU BUMP INTO, AND SLIDE ALONG.
           *
           * Terrain first, then the result is tested against the solids.
           * Refusing the whole move makes a body feel like glue, so each axis is
           * kept when it alone is clear: walk into a crate head on and you stop,
           * catch it on the corner and you slip past. Exactly the slide
           * Walker.step already does against walls, for the same reason. */
          /* ON, AND THE REASON IS MEASURED RATHER THAN GUESSED.
           *
           * This was held off because the bodies were wrong: 72 of the hub's 94
           * placements have no life, each was a circle of radius 3 at its own
           * anchor whatever it was, and on a walkway two or three pixels across
           * that is a fence. It is off by the same amount in the other
           * direction, which is the half that was never written down: a market
           * stall 26 pixels wide blocked a 3 pixel dot and you walked through
           * the rest of it.
           *
           * A placement now carries the footprint its own art measures, so both
           * halves are answered by the same change. Measured on the hub's
           * published v5 by flooding the floor from the spawn with the same step
           * test this walk runs, which is the honest question because it asks
           * what is CUT OFF rather than how far one held key gets:
           *
           *   bodies                        reachable   under a body   cut off
           *   none                            21050px              0         0
           *   r=3 at every anchor, which
           *     is what was switched off      20724px          326px         0
           *   the same with effects refused,
           *     an old bundle on this code    20727px          323px         0
           *   measured footprints, once the
           *     map is exported again         20877px          173px         0
           *
           * So the footprints stop more of what should stop you while standing
           * on LESS of the floor than the old dots did, and nothing anywhere on
           * the map is walled off behind them: every pixel lost is a pixel under
           * an object, not a pixel stranded behind one.
           *
           * Holding up-left from the spawn is 92px with this on and 92px with it
           * off, in all three rows, because what ends that walk is the top edge
           * of the quay and not a body at all. The 9px against 235px this
           * comment used to quote does not reproduce against the published hub
           * in any of them; it was measured when every body, the moving crowd
           * included, was folded into lvlAt, where the hip probes widen each one
           * into a five pixel band.
           *
           * Bodies still push apart in separate() below, so nobody is drawn
           * inside anybody, which is the visible half of what was asked for. */
          const HARD_BODIES = true
          if (HARD_BODIES && occupied(walker.x, walker.y)) {
            if (!occupied(walker.x, by)) walker.y = by
            else if (!occupied(bx, walker.y)) walker.x = bx
            else {
              walker.x = bx
              walker.y = by
            }
          }
          px = walker.x
          py = walker.y
          facing = walker.facing
          stepT = moving ? stepT + dt : 0

          const box = el.getBoundingClientRect()
          const dpr = Math.min(2, window.devicePixelRatio || 1)
          if (cv.width !== Math.round(box.width * dpr)) {
            cv.width = Math.round(box.width * dpr)
            cv.height = Math.round(box.height * dpr)
            cv.style.width = box.width + 'px'
            cv.style.height = box.height + 'px'
          }
          /* FIT THE LAND, NOT THE CANVAS.
           *
           * A painting is grown with transparent margin so the map can spread,
           * so the hub is 688x640 with ground only in the middle 400 rows.
           * Fitting the canvas picked zoom 1 and left the island a stamp in a
           * field of black. Fitting the ground it actually has picks 2, and the
           * empty margin is cropped rather than framed. */
          /* TWO WAYS TO WATCH THE SAME MAP.
           *
           * ISLAND frames the whole painting and holds still, which is what you
           * want when the question is whether the map reads. POV picks a zoom
           * close enough to see a character's feet against the ground and keeps
           * him in the middle, which is what you want when the question is
           * whether he walks. They differ only in zoom and in what the view is
           * centred on, so nothing below this needs to know which is on.
           *
           * The camera is clamped to the painting in POV so walking to an edge
           * shows the edge rather than sliding the island off into black. */
          const pov = modeRef.current === 'pov'
          const fit = Math.min(box.width / view.w, box.height / view.h)
          const zoom = pov
            ? Math.max(2, Math.min(8, Math.round(fit * 2.5)))
            : Math.max(1, Math.min(8, Math.floor(fit)))
          const w = meta.w * zoom
          const h = meta.h * zoom
          let cx = view.x + view.w / 2
          let cy = view.y + view.h / 2
          if (pov) {
            const halfW = box.width / 2 / zoom
            const halfH = box.height / 2 / zoom
            // follow him, but never past the edge of the painting
            cx = Math.min(Math.max(px, view.x + halfW), view.x + view.w - halfW)
            cy = Math.min(Math.max(py, view.y + halfH), view.y + view.h - halfH)
            // a painting narrower than the window simply centres
            if (view.w < halfW * 2) cx = view.x + view.w / 2
            if (view.h < halfH * 2) cy = view.y + view.h / 2
          }
          const ox = Math.round(box.width / 2 - cx * zoom)
          const oy = Math.round(box.height / 2 - cy * zoom)

          g.setTransform(dpr, 0, 0, dpr, 0, 0)
          g.imageSmoothingEnabled = false
          g.clearRect(0, 0, box.width, box.height)
          g.drawImage(scene, ox, oy, w, h)
          /* THE MASK, ON TOP OF THE PAINTING, WHILE YOU WALK IT.
           *
           * "it stops me somewhere that looks like floor" is unanswerable while
           * the floor is invisible. Painted once into an offscreen canvas at map
           * resolution and blitted with the same transform as the scene, so what
           * you see under your feet is literally the plane the step test reads:
           * if they ever disagree, the disagreement is on screen instead of in
           * an argument. */
          if (maskRef.current && maskCv) g.drawImage(maskCv, ox, oy, w, h)

          /* Where everything is this frame.
           *
           * A placement with no life is FURNITURE and must not move: houses,
           * stalls and sea walls were being fed through separate() along with
           * the walkers, so the whole island drifted a few pixels every frame
           * and read as a map that would not sit still. Only the things that
           * are actually walking push each other apart.
           *
           * A standing figure also has no direction to derive, so its resting
           * view is the facing the exporter now records rather than south. */
          const pts = live.map((v) => ({ x: v.p.x, y: v.p.y, r: 3 }))
          const shown = live.map((v, i) => {
            let alpha = 1
            let face = (v.p as { facing?: string }).facing || 'south'
            let flip = false
            // something with no life is a stander and never runs a gait
            let gait = false
            if (v.life) {
              /* canStand is what keeps a walkOnly figure on the ground. Leaving
               * it out is why the fishwives were strolling across the sea wall:
               * lifeAt has nothing to test against and happily walks a wander
               * straight over anything. The game passes it; so must this. */
              /* THE FLOOR HANDED TO lifeAt MUST NOT CHANGE FROM FRAME TO FRAME.
               *
               * Bodies were folded in here and it detonated: figures teleported
               * across the map many times a second. lifeAt is pure in t, and the
               * whole design depends on that. It re-derives a leg from scratch
               * every frame and picks a target by searching the floor it is
               * given, so a floor that moves because everybody else moved makes
               * it choose a different answer every frame, and the figure snaps
               * between them. It was never drift; it was a deterministic
               * function being asked a different question sixty times a second.
               *
               * So the terrain, and only the terrain, decides where a leg may
               * go. Bodies are resolved after the fact in separate(), which is
               * allowed to be frame-dependent because it is a correction rather
               * than a decision. */
              const s = lifeAt(v.life, t, { x: v.p.x, y: v.p.y }, bareStand)
              pts[i] = { x: v.p.x + s.dx, y: v.p.y + s.dy, r: 3 }
              alpha = s.alpha
              face = s.facing
              flip = s.flip
              // whether the legs should be going THIS instant, which is not the
              // same as whether this thing is capable of moving at all
              gait = s.moving
            }
            return { v, alpha, face, flip, gait, moves: !!v.life }
          })
          /* STANDERS AND THE PLAYER ARE BODIES TOO, THE WAY THE EDITOR DOES IT.
           *
           * This separated only the figures that move, so a walker crossed
           * straight through anything standing still and straight through Thor.
           * editor.ts:4231 has had the answer for a while and this is that same
           * shape, deliberately, because a fourth opinion about how bodies touch
           * is how the walk law ended up wrong in the first place.
           *
           * Immovable rows are LISTED TWICE. separate() splits a pair's
           * correction down the middle, so a body that discards its half leaves
           * the other one still half inside it; paying the discarded half a
           * second time is the whole correction rather than an approximation of
           * one. Their positions are then read back from the movers only, so a
           * stall holder never drifts and the player is never shoved by a
           * passer-by: the crowd goes round him. */
          const still = [
            ...live.filter((v) => !v.life).map((v) => ({ x: v.p.x, y: v.p.y, r: 3 })),
            { x: px, y: py, r: Math.max(3, hip) },
          ]
          const crowd = [...pts, ...still, ...still]
          /* separate RETURNS the corrections, it does not apply them.
           *
           * This called it and threw the answer away, then reassigned
           * pts[i] = crowd[i], which is the object it already was. So the push
           * has been doing precisely nothing on this page, and the comment
           * above claiming nobody is drawn inside anybody was false the whole
           * time. editor.ts:4277 has the correct shape: take the deltas, add
           * them.
           *
           * Only the movers take theirs. Immovable rows are listed twice so a
           * pair's half-correction is paid twice over, which is what makes a
           * stander stand still while the walker takes the whole gap. */
          const push = separate(crowd, yScale, 1, bareStand)
          for (let i = 0; i < pts.length; i++)
            if (shown[i].moves) pts[i] = { ...pts[i], x: pts[i].x + push[i].dx, y: pts[i].y + push[i].dy }

          const order: Array<{ y: number; go: () => void }> = shown.map((s, i) => ({
            y: pts[i].y,
            go: () => {
              const v = s.v
              const set = v.dirs[s.face] || v.dirs.south
              /* A WALK CYCLE IS A GAIT: IT IS WHAT THE LEGS DO WHILE MOVING.
               *
               * life.ts says exactly that above its `moving` flag, and this
               * ignored it and cycled off the wall clock, so a figure that had
               * stopped at the end of a leg kept striding on the spot. Standing
               * still is frame 0, which is the resting pose every direction set
               * is built with, and it is what Thor has always done a few lines
               * down. lifeAt already knows; it only had to be asked.
               *
               * Only DIRECTION sets rest. A frames-only item is an effect, a
               * waterfall or a plume of smoke, and it has no idle to fall back
               * to: it plays whether or not it is travelling. */
              const cell = set?.length
                ? s.gait
                  ? set[Math.floor(t * v.fps) % set.length]
                  : set[0]
                : v.frames.length
                  ? v.frames[Math.floor(t * v.fps) % v.frames.length]
                  : v.still
              if (!cell) return
              const sx = (v.p.scaleX ?? v.p.scale ?? 1) * zoom
              const sy = (v.p.scaleY ?? v.p.scale ?? 1) * zoom
              g.save()
              g.globalAlpha = s.alpha
              g.translate(ox + pts[i].x * zoom, oy + pts[i].y * zoom)
              if (v.p.rot) g.rotate(v.p.rot)
              g.scale((v.p.flipX ? -1 : 1) * (set ? 1 : s.flip ? -1 : 1), v.p.flipY ? -1 : 1)
              const [rx, ry, rw, rh] = cell.r
              g.drawImage(cell.img, rx, ry, rw, rh, (-rw * sx) / 2, -rh * sy, rw * sx, rh * sy)
              g.restore()
            },
          }))

          order.push({
            y: py,
            go: () => {
              const set = thor[facing] || thor.south
              if (!set?.length) {
                g.fillStyle = '#ffd66e'
                g.fillRect(ox + px * zoom - zoom, oy + py * zoom - charH * zoom, zoom * 2, charH * zoom)
                return
              }
              const f = moving ? 1 + (Math.floor(stepT * 9) % (set.length - 1)) : 0
              const fr = set[Math.min(f, set.length - 1)]
              /* THE SAME ts THE EDITOR USES, 0.7 INCLUDED.
               *
               * editor.ts:4662 is (cfg.charH * 0.7) / rig.drawnH, and the 0.7 is
               * not a rounding: its comment calls it "drawn slightly smaller
               * than the contract height, test-stage feel only". Scaling by a
               * bare charH here made him 1/0.7, about 1.43 times, larger than
               * the editor draws him, which is why he towered over the knights
               * he is supposed to be shorter than. charH stays the contract
               * height for collision; only the picture is nudged. */
              const ts = (charH * 0.7) / drawnH
              const rows = fr.feet + 1
              const dw = fr.img.width * ts * zoom
              const dh = rows * ts * zoom
              // the editor's contact shadow, which is most of what sells him as
              // standing on the ground rather than hovering over it
              g.save()
              g.fillStyle = 'rgba(6,10,14,0.35)'
              g.beginPath()
              g.ellipse(ox + (px + 1) * zoom, oy + (py - 2) * zoom, 15 * ts * zoom, 5.5 * ts * zoom, 0, 0, 6.284)
              g.fill()
              g.restore()
              g.drawImage(fr.img, 0, 0, fr.img.width, rows, ox + px * zoom - dw / 2, oy + py * zoom - dh, dw, dh)
            },
          })
          order.sort((a, b) => a.y - b.y).forEach((o) => o.go())

          // named places, and the nearest one announced
          let closest = ''
          let best = 1e9
          for (const a of meta.anchors || []) {
            const r = a.r || 14
            const d = Math.hypot(a.x - px, (a.y - py) / yScale)
            if (d < r && d < best) {
              best = d
              closest = a.label || a.name
            }
          }
          setNear(closest)
          /* WHERE HE IS AND WHAT IS UNDER HIM.
           *
           * Walkability arguments are unanswerable without this. "it stops me
           * here" and "it lets me walk there" are both about one pixel, and
           * until the page says which pixel and what level it holds, the only
           * way to settle it is to guess. Reads straight off the same lvlAt the
           * step test uses, so what it prints is what the law saw. */
          setAt(`${Math.round(px)},${Math.round(py)} lv ${at(px, py)}${walker.blocked ? ' blocked' : ''}`)
          /* the body list the NEXT frame's floor reads. Written last, after
           * everything has settled, so what a figure walks into is where people
           * actually ended up rather than where they were heading.
           *
           * Only the ones that cannot step aside are in it. There used to be a
           * second list holding everybody, player included, which was rebuilt
           * every frame and read by nothing; it is gone rather than kept as a
           * contract nothing implements. */
          solids.length = 0
          for (let i = 0; i < live.length; i++) {
            if (live[i].life) continue
            const b = bodyOf(live[i].p, pts[i].x, pts[i].y, pts[i].r)
            if (b) solids.push(b)
          }
          raf = requestAnimationFrame(draw)
        }
        raf = requestAnimationFrame(draw)
        window.addEventListener('keydown', down)
        window.addEventListener('keyup', up)
        el.focus()
        setState('playing')
      } catch (e) {
        setWhy(String((e as Error).message))
        setState('failed')
      }
    })()

    return () => {
      dead = true
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [slug, version])

  return (
    <div className="walk">
      <div className="walk-stage" tabIndex={0}>
        <div className="walk-mount" ref={mount} />
        {state === 'loading' && (
          <div className="walk-over">
            <Loading />
            <span>waking the island</span>
          </div>
        )}
        {state === 'failed' && <div className="walk-over bad">{why}</div>}
      </div>
      <div className="walk-hint">
        <span>WASD or arrows to move</span>
        <div className="walk-cam" role="group" aria-label="camera">
          <button
            type="button"
            className={mode === 'island' ? 'on' : ''}
            onClick={() => setMode('island')}
            aria-pressed={mode === 'island'}
          >
            island
          </button>
          <button
            type="button"
            className={mode === 'pov' ? 'on' : ''}
            onClick={() => setMode('pov')}
            aria-pressed={mode === 'pov'}
          >
            pov
          </button>
        </div>
        <div className="walk-cam">
          <button
            type="button"
            className={showMask ? 'on' : ''}
            onClick={() => setShowMask((v) => !v)}
            aria-pressed={showMask}
            title="show the ground the step test reads: green is painted, yellow is where a body fits"
          >
            mask
          </button>
        </div>
        <span className={near ? 'on' : ''}>{near || where}</span>
      </div>
    </div>
  )
}

/* Four squares walking a ring, on the pixel grid. It belongs to this app in a
 * way a spinning arc does not, and it is the same mark used everywhere else
 * something is loading. */
export function Loading() {
  return (
    <div className="pixload" aria-hidden>
      <i />
      <i />
      <i />
      <i />
    </div>
  )
}
