/* LIFE: a placement that moves, as DATA and never a script, because a map file that can execute code in front of students is not a door worth opening. Baking travel into frames cannot work: every effect has to loop, and a wander that returns to its exact start each cycle is a dance. The position is a function of t, so it never repeats and runs for an hour with no seam. */

export type LifeKind = 'wander' | 'cross' | 'orbit' | 'drift'

export interface LifeBounds {
  x: number
  y: number
  w: number
  h: number
}

/* A SEQUENCE: one placement, several states, on a round. The only new idea is the clock: a state keeps its OWN time, the time it has been live, so a wander that stops to be a boulder resumes where it froze rather than fifteen seconds further down a walk nobody saw. */
export interface LifeState {
  /* seconds this state is live, once round */
  secs: number
  /* which picture to draw, as an INDEX and never a name: 0 is the placement's own art, 1 is looks[0]. The planner answers in names and the SERVER turns them into numbers, because the server can see the library and refuse a name with no row. Anything that is not a number lands on 0, which is always safe. */
  art?: number
  /* seconds of fade at each end, because one sprite per placement means the seam dips through nothing for an instant. At these sizes that reads as a puff, which is what a transformation looks like anyway. */
  fade?: number
  /* how it moves while this state is live. Absent means it does not move at all, which is what a creature freezing in place looks like. A state's move may not carry states of its own. */
  move?: Life | null
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

  /* ---- rock: a tilt on any behaviour. A boat at its mooring does not travel, it LEANS, and baking a rotation into frames turns a gentle rock into a wobble that loops wrong. Rides on top of whatever the placement is already doing. */
  rock?: number
  rockRate?: number

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

  /* Stay on ground a person could stand on, INSIDE the box as well. Set when the drawn box is mostly walkable, which says they fenced a path or a plaza; a box that is mostly unwalkable means the opposite, so the box alone holds. */
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

  /* the round, if this thing changes over time. Two to six states. Absent on
   * almost everything, and absent means the fields above are the whole story. */
  states?: LifeState[]
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
export function cleanLife(raw: unknown, depth = 0): Life | null {
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
  // the tilt rides on every kind, so it is read before the kind is branched on
  if (isFinite(Number(r.rock))) out.rock = clamp(num(r.rock, 0), 0, 45)
  if (isFinite(Number(r.rockRate))) out.rockRate = clamp(num(r.rockRate, 0.35), 0.01, 8)

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

  /* Read last, because the flat fields above ARE the first state's behaviour. One level only. A PASS IS NOT A STATE: every other kind answers an offset from home, but a cross is an absolute scripted line and answers dx 0 dy 0 meaning absent, which a round cannot add. Measured: a two state round of a wander then a cross gave max dx 737px on a 688px map and a single frame step of 404px. */
  if (depth === 0 && kind !== 'cross' && Array.isArray(r.states)) {
    const st: LifeState[] = []
    for (const s of (r.states as unknown[]).slice(0, 6)) {
      if (!s || typeof s !== 'object') continue
      const q = s as Record<string, unknown>
      const secs = clamp(num(q.secs, 12), 0.2, 3600)
      const state: LifeState = {
        secs,
        /* an index into the placement's pictures, never a name: the server already turned the planner's name into this number. The top is 7, because a placement carries at most 7 extra looks. */
        art: clamp(Math.round(num(q.art, 0)), 0, 7),
        /* no fade unless the state asked for one: a fade is a dip through nothing at BOTH ends of every state it is set on. With the old 0.15 default a three-state round where nothing asked to fade drew alpha 0.00 at t=0 and blanked three times a round. */
        fade: clamp(num(q.fade, 0), 0, Math.min(2, secs / 2)),
      }
      const mv = q.move ? cleanLife(q.move, 1) : null
      // a state that asked to be a pass keeps its seconds and its picture and
      // simply does not move, which is a state the round already knows how to
      // draw, rather than the placement leaving the map
      if (mv && mv.kind !== 'cross') {
        /* A STATE MAY NOT NAME A BOX OF ITS OWN. A box is a place and a round is a sum of displacements, so share() turns a state's box into a reach around where the placement stands: a state naming a corner of the map got that corner's size drawn around home instead. Silently moving a fence a person drew is worse than not letting them draw it. */
        mv.bounds = out.bounds ? { ...out.bounds } : null
        if (out.walkOnly) mv.walkOnly = true
        // the phase is added to t before any of this, so a state carrying one
        // of its own would count it twice
        delete mv.phase
        state.move = mv
      }
      st.push(state)
    }
    // one state is not a sequence, and the fields above already say what it does
    if (st.length > 1) {
      if (!st[0].move) st[0].move = { ...out, bounds: out.bounds ? { ...out.bounds } : null }
      delete (st[0].move as Life).phase
      /* the lean is a rider on the whole placement, added to every state below,
       * so the copy that becomes the first state must not carry it as well or
       * the thing tilts twice as far while state one is live and normally after */
      delete (st[0].move as Life).rock
      delete (st[0].move as Life).rockRate
      out.states = st
    }
  }
  return out
}

/* Where a placement is at time t. Pure and stateless, so the editor preview and the game agree without sharing anything but this file. dx and dy come back as an OFFSET from home. */
export interface LifeAt {
  dx: number
  dy: number
  /* face left: the caller mirrors the sprite */
  flip: boolean
  /* 0 to 1, for the fade at the ends of a pass */
  alpha: number
  /* Which way it is heading, as one of the eight names Thor's frames use. A flip gives two apparent directions, which is all a crab needs; a person walking a plaza needs eight or they moon-walk across it. */
  facing: LifeFacing
  /* Whether it is travelling right now. A walk cycle is a GAIT, and a wander is mostly pauses: run from the clock alone, a figure standing at the end of a leg marched on the spot until the next one. */
  moving: boolean
  /* Extra tilt in radians, added to whatever rotation the placement already
   * carries. Zero unless the behaviour asked to rock. */
  rot: number
  /* which picture to draw, an index the caller resolves against the placement's
   * own list. Always 0 when there is no sequence, so a caller that ignores it
   * is right about everything that ships today. */
  art: number
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

/* the same mapping the walk test uses, so a walking figure and Thor pick the same frame. The deltas are painting pixels with the foreshortening already inside them, so squashing again here would pick a different frame for the same heading. */
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

/* PERSONAL SPACE, without giving up the pure function. Every mover's position at t is already knowable, so resolve them all and push apart what overlaps; still reproducible as long as both sides pass the same list. One pass, not settled to convergence. y is measured squashed because the ground is, or separating would shove everyone into a vertical line. */
/* A BODY IS PART OF THE FLOOR, which is the fix separate() asks for below: a walker tunnels 87 percent into a stander before the push tries to eject it, and ejecting from the middle is violent whatever the numbers are. Wrap the ground test in this and a leg search will not choose a step that lands in somebody. skip is how a body avoids blocking itself. */
/* rx and ry are the FOOTPRINT and are optional: a figure is a circle on squashed ground, a 26x19 market stall is not, and a circle at its anchor either misses most of it or swallows the walkway. Given neither, the answer is r across and r*yScale up, which is what the old code computed. separate() does NOT read them: its two passes and 0.6 body radius were tuned over 30000 frames on circles. */
export type Body = { x: number; y: number; r: number; rx?: number; ry?: number }

export function bodyAt(bodies: Body[], yScale = 0.72) {
  return (x: number, y: number, skip = -1): boolean => {
    for (let i = 0; i < bodies.length; i++) {
      if (i === skip) continue
      const b = bodies[i]
      const ax = b.rx ?? b.r
      const ay = b.ry ?? b.r * (yScale || 1)
      // a body of no width is nothing to walk into, and dividing by it is worse
      if (!(ax > 0) || !(ay > 0)) continue
      const dx = (x - b.x) / ax
      const dy = (y - b.y) / ay
      if (dx * dx + dy * dy < 1) return true
    }
    return false
  }
}

/* The ground test a figure should be given: real floor, and nobody already
 * standing on it. Composed rather than baked in, so a caller that wants the bare
 * terrain (drawing the mask, checking reach) still gets it. */
export function floorWithBodies(
  stands: (x: number, y: number) => boolean,
  bodies: Body[],
  self: number,
  yScale = 0.72,
): (x: number, y: number) => boolean {
  const taken = bodyAt(bodies, yScale)
  return (x, y) => stands(x, y) && !taken(x, y, self)
}

export function separate(
  pts: { x: number; y: number; r: number }[],
  yScale = 0.55,
  // full strength, because half of one resolves half of nothing: at 0.6 a pair
  // ends the pass still inside each other and the whole point was that they
  // stop overlapping. Measured: 0.6 removed 2% of overlaps, 1 removes them.
  strength = 1,
  /* the same floor the behaviours are fenced by. A push that lands somewhere it could not stand is dropped and the overlap kept: being inside another figure for a moment looks better than standing in stone. */
  stands?: (x: number, y: number) => boolean,
): { dx: number; dy: number }[] {
  const out = pts.map(() => ({ dx: 0, dy: 0 }))
  /* RELAXATION, not one shot. Measuring every pair against the ORIGINAL positions hands a figure caught between three others the sum of three full-depth corrections: worst single-frame shift 21.39px on bodies 11px across. Two passes at half strength measure 97 shifts over 4px against 171, worst 25.80px against 31.93, deepest overlap 12.45px against 15.69. Four passes and eight are worse. An improvement and NOT a fix; see the note under it. */
  const PASSES = 2
  const step = strength * 0.5
  /* WHAT IS STILL WRONG HERE, so nobody spends time tuning these numbers. A walker crosses THROUGH a stander because nothing in the floor knows the stander is there, gets 87% inside, and the ejection direction flips as it passes the centre: -8.46px one frame and +11.20px the next. No constant in this function reaches it. The answer is putting standing figures in the FLOOR, and that is not built. */
  for (let pass = 0; pass < PASSES; pass++) {
    let moved = false
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i]
        const b = pts[j]
        // where they are now, this pass, including what earlier passes did
        const dx = b.x + out[j].dx - (a.x + out[i].dx)
        const dy = (b.y + out[j].dy - (a.y + out[i].dy)) / (yScale || 1)
        const want = a.r + b.r
        const d2 = dx * dx + dy * dy
        if (d2 >= want * want) continue
        const d = Math.sqrt(d2)
        /* THE DIRECTION HAS TO BE STEADY WHERE THE PUSH IS STRONGEST and it was the opposite: the shove is biggest when two bodies are nearly on one spot, which is exactly where dx/d swings right round on a tenth of a pixel. Measured 20.07px in one frame on bodies 11px across, against 1.75px with no push at all. Near the middle the geometry fades out and a per-pair fixed direction fades in. */
        // dead centre on each other: shove along x by index so the answer is the
        // same every time rather than depending on which arrived first
        const ux = d > 0.001 ? dx / d : i < j ? -1 : 1
        const uy = d > 0.001 ? dy / d : 0
        const push = ((want - d) / 2) * step
        out[i].dx -= ux * push
        out[i].dy -= uy * push * (yScale || 1)
        out[j].dx += ux * push
        out[j].dy += uy * push * (yScale || 1)
        moved = true
      }
    }
    // nothing left overlapping: the remaining passes have nothing to do
    if (!moved) break
  }
  if (stands)
    for (let i = 0; i < pts.length; i++) {
      const o = out[i]
      if (!o.dx && !o.dy) continue
      if (!stands(pts[i].x + o.dx, pts[i].y + o.dy)) {
        o.dx = 0
        o.dy = 0
      }
    }
  return out
}

/* WHICH STATE IS LIVE AT t: the division, then a walk of at most six numbers. Exported because the editor has to draw the fence in force right now, and a second copy of this walk would be a second law. */
export function liveState(states: LifeState[], t: number): { k: number; c: number; into: number } {
  let T = 0
  for (let i = 0; i < states.length; i++) T += states[i].secs
  const c = Math.floor(t / T)
  const p = t - c * T
  let k = 0
  let start = 0
  while (k < states.length - 1 && p >= start + states[k].secs) {
    start += states[k].secs
    k++
  }
  return { k, c, into: p - start }
}

/* A BOX IS A PLACE, AND A PLACE IS NOT A TERM IN A SUM. A round only closes if each term is a displacement; a fenced behaviour lands inside its box whatever it was handed, so the term starts meaning where this state IS and the last moving state overwrites every earlier one (the drawn position was the last mover's own on 55.8% of 20000 frames, and a state asking 12-24 px/s drew 3.9). Anchoring each state to where the round left it is not the fix: it walked the worst frame step to 128.56px by t=300000s. So a state inherits the fence's ROOM and not its position, measured FROM WHERE THE PLACEMENT STANDS and on each side separately, because a centred rectangle held a corner placement against the fence on 60.5% of 60000 frames. Not flattened either: that took a 100x100 box down to 32px of dy against 95. After: 0.0% of 60000 frames outside the box. */
function share(m: Life, home: { x: number; y: number }, n: number): Life {
  const b = m.bounds
  if (!b) return m
  // where it stands, held inside its own box, because a placement dropped
  // outside the box it was given has no room at all on one side and the
  // subtraction below would hand back a negative one
  const hx = clamp(home.x, b.x, b.x + b.w)
  const hy = clamp(home.y, b.y, b.y + b.h)
  return { ...m, bounds: { x: home.x - (hx - b.x) / n, y: home.y - (hy - b.y) / n, w: b.w / n, h: b.h / n } }
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
  /* the tilt, worked out once and added to every answer below. It is on top of
   * the behaviour rather than one of them, so a moored boat can drift an inch
   * and lean at the same time, and a sign can lean while standing still. */
  const rock = life.rock ? (life.rock * Math.PI) / 180 : 0
  const rot = rock ? rock * Math.sin(t * Math.PI * 2 * (life.rockRate ?? 0.35)) : 0
  const still: LifeAt = { dx: 0, dy: 0, flip: false, alpha: 1, facing: 'south', moving: false, rot, art: 0 }
  if (!life) return still
  /* WHICH STATE IS LIVE AND WHERE THE ROUND LEFT IT, AS ARITHMETIC. t modulo the sum of the durations says where in the round we are; each state's own clock is completed rounds times its duration plus however far in we are, so a wander that stopped to be a boulder resumes at the second it froze with nothing remembered between frames. The position is the SUM of what every state has travelled on that clock, and state zero is the placement's own behaviour, which is why a reader that knows nothing about states sees the same creature. */
  if (life.states && life.states.length > 1) {
    const st = life.states
    const { k, c, into } = liveState(st, t)
    /* how many states actually move, because they are the ones that share the
     * fence. A state that only changes the picture takes none of it. */
    let movers = 0
    for (let j = 0; j < st.length; j++) if (st[j].move) movers++
    /* THE FLOOR IS SHARED FOR THE SAME REASON THE BOX IS. Every state is tested at home, so two states each held to a 40px path add their offsets and the SUM is off it by the path's width: 1190 of 20000 frames off, 14.11px out. The old flattening hid that by luck and by orientation, and the same fixture on its side measured 1360 of 20000. So the floor is divided the way the box is, by the number of movers. After: 0 of 20000 both ways up. */
    const near =
      movers > 1 && canStand
        ? (x: number, y: number) => canStand(home.x + (x - home.x) * movers, home.y + (y - home.y) * movers)
        : canStand
    let ax = home.x
    let ay = home.y
    let heldFlip = false
    let heldFace: LifeFacing = 'south'
    let cur: LifeAt | null = null
    for (let j = 0; j < st.length; j++) {
      const raw = st[j].move
      if (!raw) continue
      /* THE FLOOR REACHES THE STATES HERE, at read time rather than at construction: the editor learns walkOnly from the drawn box AFTER cleanLife has run, so every state kept the false it was built with. Measured on the troll's four-state round over a 40px path: 20.4% of 36000 frames off the floor, against 0.2% for the identical walk with no round. Applied here too, because every doc.json already on disk carries stateless states. */
      /* THE PLACEMENT'S OWN FENCE, BOTH HALVES, applied here rather than trusted to whoever built the round: one line, and the box and the floor flag went missing together. Measured on the troll actually on the hub: 16.5% of 36000 frames off walkable ground, 16px from anything standable. Fixing the caller alone cannot help a life already on disk with a null box in every state. */
      const eff =
        (life.bounds && !raw.bounds) || (life.walkOnly && !raw.walkOnly)
          ? {
              ...raw,
              ...(life.bounds && !raw.bounds ? { bounds: { ...life.bounds } } : {}),
              ...(life.walkOnly && !raw.walkOnly ? { walkOnly: true } : {}),
            }
          : raw
      const m = share(eff, home, movers)
      // seconds this state has been live: a whole run for every round behind us,
      // plus this round's share, which is all of it for one already finished,
      // part of it for the live one and none of it for one still to come
      const own = (j < k ? c + 1 : c) * st[j].secs + (j === k ? into : 0)
      const a = lifeAt(m, own, home, near)
      ax += a.dx
      ay += a.dy
      if (j > 0) {
        // only what it has travelled since it first went live, or a state arrives already displaced by wherever its own behaviour sits at second zero: a pixel for a drift, the whole radius for an orbit.
        const z = lifeAt(m, 0, home, near)
        ax -= z.dx
        ay -= z.dy
      }
      if (j === k) cur = a
      else if (j < k) {
        // the way it was facing when it stopped, so a state that holds keeps it.
        // Only states already finished this round count: a state still to come
        // has not faced anywhere yet.
        heldFlip = a.flip
        heldFace = a.facing
      }
    }
    let dx = ax - home.x
    let dy = ay - home.y
    /* the fence, on the sum rather than on any one state, so it only bites when several states each walk a box and their distances from home pile up. Held rather than wrapped, because holding stays continuous. */
    const box = life.bounds
    if (box) {
      dx = clamp(home.x + dx, box.x, box.x + box.w) - home.x
      dy = clamp(home.y + dy, box.y, box.y + box.h) - home.y
    }
    /* THE FLOOR, ON THE SUM, and nothing above this line could do it: every state is fenced around HOME, and near() scales that test by the number of movers, which is sound for a rectangle and cannot be for an arbitrary mask. Measured on the hub's troll: 16.5% of 36000 frames off the ground with the scaling, 51.1% without, so the proxy helps and is still not a fence. So the sum is tested where the sum lands and the offset shrinks toward home in sixteen fixed steps, keeping direction and giving up only distance. It costs 5936 off-mask frames going to 0, in exchange for 4 frames of 36000 moving over 4px, worst 11.78px. */
    if (life.walkOnly && canStand && (dx || dy) && !canStand(home.x + dx, home.y + dy)) {
      let lo = 0
      for (let s = 15; s >= 1; s--) {
        const k = s / 16
        if (canStand(home.x + dx * k, home.y + dy * k)) {
          lo = k
          break
        }
      }
      dx *= lo
      dy *= lo
    }
    const f = st[k].fade || 0
    /* the opening of the very first round has nothing to dissolve out of, and the game drops any sprite at 0.01 alpha or under, so a fade in there is a first frame with nothing drawn. Measured on the planner prompt's own example, whose first state asks 0.25s: alpha 0.00 at t=0. */
    const opening = k === 0 && c === 0
    const fa = f > 0 ? Math.max(0, Math.min(1, Math.min(opening ? f : into, st[k].secs - into) / f)) : 1
    const art = st[k].art || 0
    if (cur) {
      return {
        dx,
        dy,
        flip: cur.flip,
        alpha: cur.alpha * fa,
        facing: cur.facing,
        moving: cur.moving,
        // the placement's own lean rides on every state, on top of whatever the
        // state's own behaviour is leaning through
        rot: cur.rot + rot,
        art,
      }
    }
    // no behaviour of its own: it stands where the round left it, facing the way
    // it was facing when it stopped
    return { dx, dy, flip: heldFlip, alpha: fa, facing: heldFace, moving: false, rot, art }
  }
  /* THE PATH, not only where it ends. Asking only whether the far end of a leg was standable let a walker cut the corner off a quay and cross stone it could never step on. Sampled every two pixels, finer than a foot is wide, on the same fixed candidate sequence, so the editor and the game still choose the identical leg. */
  const clearPath = (ax: number, ay: number, bx: number, by: number) => {
    if (!floor) return true
    const d = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.ceil(d / 2))
    for (let i = 1; i <= n; i++) {
      const u = i / n
      if (!floor(ax + (bx - ax) * u, ay + (by - ay) * u)) return false
    }
    return true
  }

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
    /* THE CAP IS A ROUND, NOT A CLIFF. 512 legs bounds the cost. A cap that simply ends the walk answers still from then on, teleporting the thing back to its anchor to stand there visible: measured at 32.2 minutes in, from t=1932.92s, which is inside a single sitting. Leg 512 walks back to the anchor, so the round closes instead. Costs a second walk past the end, 21.9us against 14.1us at t=3600s, flat from there. Legs 0 to 511 are untouched. */
    let tw = t
    for (let pass = 0; pass < 2; pass++) {
      px = home.x
      py = home.y
      clock = 0
      for (let k = 0; k <= 512; k++) {
        /* the leg home, not offered to the floor test: a refused leg would end somewhere else and the wrap would be a teleport again. The anchor is the pixel a person dropped the placement on, so it is standable. */
        const homing = k === 512
        let tx = homing ? home.x : cx + (rnd(k * 2 + 1, seed) * 2 - 1) * halfW
        let ty = homing ? home.y : cy + (rnd(k * 2 + 2, seed) * 2 - 1) * halfH
        /* the second fence. Candidates come from the same fixed sequence and the first standable one wins, so the editor and the game pick the identical target. If none land on floor the thing stays put for that leg. */
        if (!homing && floor && (!floor(tx, ty) || !clearPath(px, py, tx, ty))) {
          let found = false
          for (let try_ = 0; try_ < 12; try_++) {
            const ax = cx + (rnd(k * 40 + try_ * 2 + 3001, seed) * 2 - 1) * halfW
            const ay = cy + (rnd(k * 40 + try_ * 2 + 3002, seed) * 2 - 1) * halfH
            if (floor(ax, ay) && clearPath(px, py, ax, ay)) {
              tx = ax
              ty = ay
              found = true
              break
            }
          }
          /* Blocked everywhere, so it stays put for that leg. Sliding along x then y, the rule Thor walks by, was tried and taken back out: on a 12px corridor and an L of two 20px arms it covered the same ground, left twice as many off-floor frames on the corridor and shrank the L's vertical coverage from 181px to 140px, while moving 19298 of 20000 frames of an ordinary fenced walk by up to 264.6px. */
          if (!found) {
            tx = px
            ty = py
          }
        }
        const dist = Math.hypot(tx - px, ty - py)
        const sp = (life.speedMin ?? 14) + rnd(k + 977, seed) * ((life.speedMax ?? 26) - (life.speedMin ?? 14))
        const moveT = dist / Math.max(sp, 0.5)
        const pause = (life.pauseMin ?? 1.2) + rnd(k + 5501, seed) * ((life.pauseMax ?? 4.7) - (life.pauseMin ?? 1.2))
        if (tw < clock + moveT) {
          const u = moveT > 0 ? (tw - clock) / moveT : 1
          const x = px + (tx - px) * u
          const y = py + (ty - py) * u
          flip = tx < px
          const hop = (life.bob ?? 1.5) * Math.abs(Math.sin(tw * Math.PI * (life.bobRate ?? 3.5)))
          return {
            dx: x - home.x,
            dy: y - home.y - hop,
            flip: (life.faceMotion ?? true) && flip,
            alpha: 1,
            facing: facingFrom(tx - px, ty - py),
            moving: true,
            rot,
            art: 0,
          }
        }
        clock += moveT
        if (tw < clock + pause) {
          flip = tx < px
          // stood still, still facing wherever the last dash pointed
          return {
            dx: tx - home.x,
            dy: ty - home.y,
            flip: (life.faceMotion ?? true) && flip,
            alpha: 1,
            facing: facingFrom(tx - px, ty - py),
            moving: false,
            rot,
            art: 0,
          }
        }
        clock += pause
        px = tx
        py = ty
      }
      /* past the end of the round, so clock is the round's length and the second pass lands inside it. A round of no length is a thing that neither travels nor pauses, so stop rather than divide by zero. */
      if (!(clock > 0)) break
      tw = tw % clock
    }
    return still
  }

  if (life.kind === 'cross') {
    const cycle = life.cycle ?? 35
    const travel = Math.min(life.travel ?? 9, cycle)
    const u = (t % cycle) / travel
    if (u > 1) return { dx: 0, dy: 0, flip: false, alpha: 0, facing: 'south', moving: false, rot, art: 0 }
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
      // a pass is travel end to end; there is no standing about in it
      moving: true,
      rot,
      art: 0,
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
      // an orbit never stops going round
      moving: true,
      rot,
      art: 0,
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
    // a drift is a sway that never settles, so its frames keep running
    moving: true,
    rot,
    art: 0,
  }
}
