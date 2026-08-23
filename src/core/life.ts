/* LIFE: a placement that moves, as data.
 *
 * The beach map's crab is a 27x18 png with no animation frames at all. Every
 * bit of its life is code running each tick: pick a target within a few tiles
 * of home, dash there at a random speed, freeze for a second or four, face the
 * way it went, bob while moving. The gull is one still png too, on a 35 second
 * cycle with 9 seconds of glide.
 *
 * That is why baking travel into animation frames cannot work, and it was tried
 * here first. Every effect in this tool has to loop: frame N must equal frame 0
 * or it pops on the wrap. A wander that must return to its exact starting spot
 * every cycle IS a dance, and no prompt fixes that, because the loop rule is
 * load-bearing for everything else.
 *
 * So the motion is not pixels. It is a few numbers on the placement, and the
 * game works out where the thing is each frame. That means it never repeats, it
 * costs nothing to store, it can be told to stay inside a boundary, and it can
 * run for an hour without a seam.
 *
 * It is DATA on purpose, not a script. These bundles run in front of students,
 * and a map file that can execute code in the game is not a door worth opening.
 * The liberty lives in the numbers instead, and there are enough of them: the
 * two behaviours below reproduce the beach crab and the beach gull exactly.
 */

export type LifeKind = 'wander' | 'cross' | 'orbit' | 'drift'

export interface LifeBounds {
  x: number
  y: number
  w: number
  h: number
}

export interface Life {
  kind: LifeKind
  /* Where it is allowed to be, in painting pixels. Absent means it stays near
   * where it was placed, using range instead. This is the box drawn in the
   * editor, and skipping that box is a real answer. */
  bounds?: LifeBounds | null

  // ---- wander: bursts and pauses, the crab -------------------------------
  /* how far from home it will stray when there are no bounds, in pixels */
  range?: number
  /* pixels per second, low and high; each dash picks between them */
  speedMin?: number
  speedMax?: number
  /* seconds of stillness between dashes, low and high */
  pauseMin?: number
  pauseMax?: number
  /* how far one dash carries it, as a share of range */
  stepMin?: number
  stepMax?: number
  /* pixels of vertical hop while moving. The crab's scuttle is 1.5 */
  bob?: number
  /* how fast that hop cycles, in hops per second */
  bobRate?: number
  /* mirror the sprite to face the way it is travelling */
  faceMotion?: boolean

  // ---- cross: a pass and a rest, the gull --------------------------------
  /* seconds for the whole cycle, most of which it is absent */
  cycle?: number
  /* seconds of that cycle spent travelling */
  travel?: number
  /* the pass, in painting pixels. Absent ends are derived from bounds. */
  fromX?: number
  fromY?: number
  toX?: number
  toY?: number
  /* a sine over the pass: how many pixels of rise and fall, and how many waves */
  swayAmp?: number
  swayWaves?: number
  /* fade in and out at the ends of the pass instead of appearing */
  fade?: boolean
  /* draw over everything rather than y-sorted into the map: for anything in
   * the air, which is not standing on the ground it is drawn over */
  airborne?: boolean

  // ---- orbit: a circuit ---------------------------------------------------
  /* seconds for one lap */
  period?: number
  /* the ellipse, in pixels */
  radiusX?: number
  radiusY?: number

  // ---- drift: barely moving, for something moored or idling ---------------
  /* pixels of sway, and seconds per sway */
  driftX?: number
  driftY?: number

  /* Stay on ground a person could stand on, INSIDE the box as well.
   *
   * Set when the box the person drew is mostly walkable, because that says
   * something: they fenced a path, a plaza, a stretch of sand. Two barriers
   * then, the box and the floor, and the thing stops walking through walls and
   * out over water. A box that is mostly not walkable means the opposite, that
   * they fenced a region regardless of the ground, so the box alone holds. */
  walkOnly?: boolean
  /* how much of the boxed area was walkable when it was drawn, 0..1. Kept for
   * the panel to explain itself, and for the planner to judge with. */
  walkPct?: number

  /* seconds added to this one's clock, so two copies of the same behaviour are
   * not in step. Duplicating a placement gives the copy a fresh seed AND a
   * fresh offset, which is what stops a pasted crowd marching as one. */
  phase?: number

  /* every behaviour is driven from this, so two crabs side by side do not move
   * as one. Any integer. */
  seed?: number
}

const num = (v: unknown, d: number) => {
  const n = Number(v)
  return isFinite(n) ? n : d
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

export const LIFE_KINDS: LifeKind[] = ['wander', 'cross', 'orbit', 'drift']

/* Whatever came off the wire, held inside what the evaluator can actually do.
 * Anything missing takes the beach map's own numbers, because those are the
 * ones that have been looked at and liked. */
export function cleanLife(raw: unknown): Life | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = LIFE_KINDS.includes(r.kind as LifeKind) ? (r.kind as LifeKind) : null
  if (!kind) return null
  const b = r.bounds as Record<string, unknown> | undefined
  const bounds: LifeBounds | null =
    b && num(b.w, 0) > 1 && num(b.h, 0) > 1
      ? { x: Math.round(num(b.x, 0)), y: Math.round(num(b.y, 0)), w: Math.round(num(b.w, 0)), h: Math.round(num(b.h, 0)) }
      : null
  const out: Life = { kind, bounds, seed: Math.round(clamp(num(r.seed, 1), 1, 2147483647)) }
  if (r.walkOnly) out.walkOnly = true
  if (isFinite(Number(r.walkPct))) out.walkPct = clamp(num(r.walkPct, 0), 0, 1)
  if (isFinite(Number(r.phase))) out.phase = clamp(num(r.phase, 0), 0, 100000)

  if (kind === 'wander') {
    out.range = clamp(num(r.range, 40), 4, 4000)
    out.speedMin = clamp(num(r.speedMin, 14), 0.5, 400)
    out.speedMax = clamp(num(r.speedMax, Math.max(out.speedMin, 26)), out.speedMin, 400)
    out.pauseMin = clamp(num(r.pauseMin, 1.2), 0, 60)
    out.pauseMax = clamp(num(r.pauseMax, Math.max(out.pauseMin, 4.7)), out.pauseMin, 120)
    out.stepMin = clamp(num(r.stepMin, 0.25), 0.02, 1)
    out.stepMax = clamp(num(r.stepMax, Math.max(out.stepMin, 0.8)), out.stepMin, 1)
    out.bob = clamp(num(r.bob, 1.5), 0, 24)
    out.bobRate = clamp(num(r.bobRate, 3.5), 0, 30)
    out.faceMotion = r.faceMotion !== false
  } else if (kind === 'cross') {
    out.cycle = clamp(num(r.cycle, 35), 2, 600)
    out.travel = clamp(num(r.travel, Math.min(9, out.cycle)), 0.5, out.cycle)
    if (isFinite(Number(r.fromX))) out.fromX = num(r.fromX, 0)
    if (isFinite(Number(r.fromY))) out.fromY = num(r.fromY, 0)
    if (isFinite(Number(r.toX))) out.toX = num(r.toX, 0)
    if (isFinite(Number(r.toY))) out.toY = num(r.toY, 0)
    out.swayAmp = clamp(num(r.swayAmp, 18), 0, 400)
    out.swayWaves = clamp(num(r.swayWaves, 1.4), 0, 20)
    out.fade = r.fade !== false
    out.airborne = !!r.airborne
    out.faceMotion = r.faceMotion !== false
  } else if (kind === 'orbit') {
    out.period = clamp(num(r.period, 12), 0.5, 600)
    out.radiusX = clamp(num(r.radiusX, 24), 1, 2000)
    out.radiusY = clamp(num(r.radiusY, Math.max(1, (out.radiusX as number) * 0.4)), 1, 2000)
    out.bob = clamp(num(r.bob, 0), 0, 24)
    out.bobRate = clamp(num(r.bobRate, 3), 0, 30)
    out.faceMotion = r.faceMotion !== false
  } else {
    out.driftX = clamp(num(r.driftX, 2), 0, 200)
    out.driftY = clamp(num(r.driftY, 1), 0, 200)
    out.period = clamp(num(r.period, 4), 0.2, 600)
    out.faceMotion = !!r.faceMotion
  }
  return out
}

/* Where a placement is at time t, given where it was put.
 *
 * Pure and stateless: the same t always gives the same answer, so the editor
 * preview and the game agree without sharing anything but this file, and a
 * paused frame is a real frame rather than wherever a simulation happened to
 * get to.
 *
 * home is the placement's own x,y. dx and dy come back as an OFFSET from it, so
 * a caller that knows nothing about this can just add them.
 */
export interface LifeAt {
  dx: number
  dy: number
  /* face left: the caller mirrors the sprite */
  flip: boolean
  /* 0 to 1, for the fade at the ends of a pass */
  alpha: number
  /* Which way it is heading, as one of the eight names Thor's own frames use.
   *
   * A flip gives a thing two apparent directions, which is all a crab needs. A
   * person walking a plaza needs eight, or they moon-walk across it. An asset
   * that carries directional frames is drawn with this; one that does not
   * ignores it and keeps flipping, so nothing had to change to gain it. */
  facing: LifeFacing
}
export type LifeFacing =
  | 'east'
  | 'south-east'
  | 'south'
  | 'south-west'
  | 'west'
  | 'north-west'
  | 'north'
  | 'north-east'

/* the same mapping the walk test uses (core/walk.ts dirFrom), so a walking
 * figure and Thor pick the same frame for the same heading. The deltas coming
 * in are painting pixels, and the map's foreshortening is already inside them:
 * Thor's facing is read off the pixels he MOVED, dirFrom(dx, dy * yScale), so
 * squashing again here would pick a different frame for the same heading. That
 * is what a yScale of 1 means; 0.72 or 2 would both be that second squash. */
export function facingFrom(dx: number, dy: number, yScale = 1): LifeFacing {
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return 'south'
  const a = (Math.atan2(dy * yScale, dx) * 180) / Math.PI
  if (a >= -22.5 && a < 22.5) return 'east'
  if (a >= 22.5 && a < 67.5) return 'south-east'
  if (a >= 67.5 && a < 112.5) return 'south'
  if (a >= 112.5 && a < 157.5) return 'south-west'
  if (a >= -67.5 && a < -22.5) return 'north-east'
  if (a >= -112.5 && a < -67.5) return 'north'
  if (a >= -157.5 && a < -112.5) return 'north-west'
  return 'west'
}

/* a fixed 0..1 for a whole number, so a behaviour is random but repeatable */
function rnd(n: number, seed: number): number {
  let x = (Math.imul(n ^ seed, 2246822519) ^ Math.imul(n + seed, 3266489917)) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 2246822519) >>> 0
  x ^= x >>> 13
  return (x >>> 0) / 4294967296
}

/* canStand is how the floor becomes the second fence. Both sides already have
 * one: the editor reads its own level mask, the game reads the bundle's. It is
 * optional, so a caller without one still gets the box. */
export function lifeAt(
  life: Life,
  t0: number,
  home: { x: number; y: number },
  canStand?: (x: number, y: number) => boolean,
): LifeAt {
  const seed = life.seed || 1
  // the phase is what keeps two copies of one behaviour out of step
  const t = t0 + (life.phase || 0)
  const floor = life.walkOnly && canStand ? canStand : null
  const still: LifeAt = { dx: 0, dy: 0, flip: false, alpha: 1, facing: 'south' }
  if (!life) return still

  if (life.kind === 'wander') {
    /* Walk the legs from the start rather than simulating: leg k has a fixed
     * duration and a fixed destination for a given seed, so summing them says
     * exactly where it is at any t. That is what makes this replayable. */
    const b = life.bounds
    const range = life.range ?? 40
    const halfW = b ? b.w / 2 : range
    const halfH = b ? b.h / 2 : range * 0.35
    const cx = b ? b.x + b.w / 2 : home.x
    const cy = b ? b.y + b.h / 2 : home.y
    let px = home.x
    let py = home.y
    let clock = 0
    let flip = false
    // a cap, so a huge t cannot spin here: after this many legs it wraps, which
    // is far longer than anyone watches one crab
    for (let k = 0; k < 512; k++) {
      let tx = cx + (rnd(k * 2 + 1, seed) * 2 - 1) * halfW
      let ty = cy + (rnd(k * 2 + 2, seed) * 2 - 1) * halfH
      /* the second fence. Candidates are drawn from the same fixed sequence and
       * the first standable one wins, so this stays reproducible: the editor
       * and the game pick the identical target as long as they agree about the
       * floor, which they do, it is the same mask. If none of the tries land on
       * floor the thing simply stays put for that leg, which is what a creature
       * boxed into a wall would do anyway. */
      if (floor && !floor(tx, ty)) {
        let found = false
        for (let try_ = 0; try_ < 12; try_++) {
          const ax = cx + (rnd(k * 40 + try_ * 2 + 3001, seed) * 2 - 1) * halfW
          const ay = cy + (rnd(k * 40 + try_ * 2 + 3002, seed) * 2 - 1) * halfH
          if (floor(ax, ay)) {
            tx = ax
            ty = ay
            found = true
            break
          }
        }
        if (!found) {
          tx = px
          ty = py
        }
      }
      const dist = Math.hypot(tx - px, ty - py)
      const sp = (life.speedMin ?? 14) + rnd(k + 977, seed) * ((life.speedMax ?? 26) - (life.speedMin ?? 14))
      const moveT = dist / Math.max(sp, 0.5)
      const pause = (life.pauseMin ?? 1.2) + rnd(k + 5501, seed) * ((life.pauseMax ?? 4.7) - (life.pauseMin ?? 1.2))
      if (t < clock + moveT) {
        const u = moveT > 0 ? (t - clock) / moveT : 1
        const x = px + (tx - px) * u
        const y = py + (ty - py) * u
        flip = tx < px
        const hop = (life.bob ?? 1.5) * Math.abs(Math.sin(t * Math.PI * (life.bobRate ?? 3.5)))
        return {
          dx: x - home.x,
          dy: y - home.y - hop,
          flip: (life.faceMotion ?? true) && flip,
          alpha: 1,
          facing: facingFrom(tx - px, ty - py),
        }
      }
      clock += moveT
      if (t < clock + pause) {
        flip = tx < px
        // stood still, still facing wherever the last dash pointed
        return {
          dx: tx - home.x,
          dy: ty - home.y,
          flip: (life.faceMotion ?? true) && flip,
          alpha: 1,
          facing: facingFrom(tx - px, ty - py),
        }
      }
      clock += pause
      px = tx
      py = ty
    }
    return still
  }

  if (life.kind === 'cross') {
    const cycle = life.cycle ?? 35
    const travel = Math.min(life.travel ?? 9, cycle)
    const u = (t % cycle) / travel
    if (u > 1) return { dx: 0, dy: 0, flip: false, alpha: 0, facing: 'south' }
    const b = life.bounds
    const fx = life.fromX ?? (b ? b.x - 20 : home.x - 200)
    const fy = life.fromY ?? (b ? b.y + b.h * 0.3 : home.y)
    const tx = life.toX ?? (b ? b.x + b.w + 20 : home.x + 200)
    const ty = life.toY ?? (b ? b.y + b.h * 0.6 : home.y)
    const x = fx + (tx - fx) * u
    const y = fy + (ty - fy) * u + (life.swayAmp ?? 18) * Math.sin(u * Math.PI * 2 * (life.swayWaves ?? 1.4))
    // in and out over the first and last tenth, so it does not pop
    const a = life.fade === false ? 1 : Math.min(1, Math.min(u, 1 - u) / 0.1)
    return {
      dx: x - home.x,
      dy: y - home.y,
      flip: (life.faceMotion ?? true) && tx < fx,
      alpha: Math.max(0, a),
      facing: facingFrom(tx - fx, ty - fy),
    }
  }

  if (life.kind === 'orbit') {
    const p = life.period ?? 12
    const a = (t / p) * Math.PI * 2
    const rx = life.radiusX ?? 24
    const ry = life.radiusY ?? rx * 0.4
    const hop = (life.bob ?? 0) * Math.abs(Math.sin(t * Math.PI * (life.bobRate ?? 3)))
    return {
      dx: Math.cos(a) * rx,
      dy: Math.sin(a) * ry - hop,
      flip: (life.faceMotion ?? true) && Math.sin(a) < 0,
      alpha: 1,
      // the tangent of the circle is where it is heading
      facing: facingFrom(-Math.sin(a) * rx, Math.cos(a) * ry),
    }
  }

  const p = life.period ?? 4
  const a = (t / p) * Math.PI * 2
  return {
    dx: Math.sin(a) * (life.driftX ?? 2),
    dy: Math.cos(a * 0.7) * (life.driftY ?? 1),
    flip: false,
    alpha: 1,
    facing: 'south',
  }
}
