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

/* A SEQUENCE: one placement, several states, on a round.
 *
 * A troll rolls around the rocks, goes still as a boulder, then rolls off
 * again. That is not a fifth kind of movement. It is the SAME placement wearing
 * a different picture and following a different behaviour for a stretch of the
 * round, and then the round starts over.
 *
 * The only new idea is the clock. A state keeps its OWN time, which is the time
 * it has been live, not the time on the wall. So a wander that stops to be a
 * boulder for fifteen seconds resumes exactly where it froze rather than
 * fifteen seconds further down a walk nobody saw. That is what makes the change
 * back look like the same creature and not a teleport, and it is arithmetic
 * rather than something remembered between frames.
 */
export interface LifeState {
  /* seconds this state is live, once round */
  secs: number
  /* which picture to draw, as an INDEX and never a name. 0 is the art the
   * placement already carries; 1 and up are the extra looks it was given, so 1
   * is looks[0]. A caller that knows nothing about looks draws 0 and is right
   * about a placement that never changes.
   *
   * The planner answers in names, because a name is the only thing a model can
   * write about a picture. The SERVER turns that name into this number, since
   * the server is the side that can see the map's library and can refuse a name
   * that has no row. By the time a Life reaches here the name is gone, and
   * anything that is not a number lands on 0, which is always the placement's
   * own picture and so is always safe. */
  art?: number
  /* seconds of fade at each end, so a change of picture dissolves rather than
   * cuts. One sprite per placement means the seam dips through nothing for an
   * instant; at these sizes that reads as a puff, which is what a
   * transformation looks like anyway. */
  fade?: number
  /* how it moves while this state is live. Absent means it does not move at
   * all: it stands exactly where the sequence left it, which is what a creature
   * freezing in place looks like. A state's own move may not carry states of
   * its own. */
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

  /* ---- rock: a tilt, on any behaviour --------------------------------------
   *
   * A boat at its mooring does not travel and does not change shape, it LEANS.
   * That is a rotation over time, and baking a rotation into frames is what
   * turns a gentle rock into a generic wobble that loops wrong: the animator is
   * handed a still and asked to invent motion it has no physics for.
   *
   * So it lives here with the rest of the movement-as-data. Degrees either side
   * of upright, and how many leans a second. It rides on top of whatever the
   * placement is already doing, so a moored boat drifting an inch can tilt while
   * it does it, and a hanging sign can tilt while standing perfectly still. */
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

  /* Read last, because the flat fields above ARE the first state's behaviour
   * when the first state does not name one of its own. One level only: a
   * state's move may not carry states, so working out which state is live stays
   * a division and a walk of at most six numbers.
   *
   * A PASS IS NOT A STATE, so a cross never gets a round.
   *
   * Every other kind answers with an offset from where the thing lives, which is
   * what lets a round add its states up. A cross does not: it is an absolute
   * scripted line from fx,fy to tx,ty across the whole painting, and for most of
   * its cycle it is not on the map at all, where it answers dx 0 dy 0 meaning
   * absent rather than meaning here. A round cannot add absent to anything. On a
   * 688px map, a two state round of a wander then a cross measured max |dx| 737px
   * and a single frame step of 404px: the placement walks clean off the island.
   *
   * It is not a wording problem and it is not fixable by holding the sum inside
   * the box, because the thing being summed is not a displacement. A gull that
   * crosses the cove and a crab that wanders the sand are two placements, and
   * asking for one that does both is asking for two. So this is refused here,
   * which is the same kind of validity rule as a state not being allowed states
   * of its own, and refusing it costs nothing anybody has: no exported bundle
   * carries a sequence at all.
   *
   * A cross carrying states loses the states and stays the pass it always was.
   * That covers the flat-field path as well, which is the one that hides: the
   * first state is BUILT from the fields around here when it does not name a
   * move of its own, so a cross placement with a round would have had a cross
   * quietly installed as state one. That path measured 356px on its own. */
  if (depth === 0 && kind !== 'cross' && Array.isArray(r.states)) {
    const st: LifeState[] = []
    for (const s of (r.states as unknown[]).slice(0, 6)) {
      if (!s || typeof s !== 'object') continue
      const q = s as Record<string, unknown>
      const secs = clamp(num(q.secs, 12), 0.2, 3600)
      const state: LifeState = {
        secs,
        /* an index into the placement's pictures, never a name: the server has
         * already turned the planner's name into this number. A name that got
         * this far is not a number, so it lands on the default 0, which is the
         * placement's own picture. The top is 7 because a placement carries at
         * most 7 extra looks, so 0..7 is every picture there can be. */
        art: clamp(Math.round(num(q.art, 0)), 0, 7),
        /* no fade unless the state asked for one. A fade here is a dip through
         * nothing, because one placement is one sprite: alpha runs to 0 and back
         * at BOTH ends of every state it is set on. Measured with the old 0.15
         * default on a three-state round where nothing asked to fade: alpha 0.00
         * at t=0, so the thing is invisible on the first frame it is ever drawn,
         * and it blanks again at every state change, three times a round. A
         * state that wants the puff still says so. */
        fade: clamp(num(q.fade, 0), 0, Math.min(2, secs / 2)),
      }
      const mv = q.move ? cleanLife(q.move, 1) : null
      // a state that asked to be a pass keeps its seconds and its picture and
      // simply does not move, which is a state the round already knows how to
      // draw, rather than the placement leaving the map
      if (mv && mv.kind !== 'cross') {
        /* A STATE MAY NOT NAME A BOX OF ITS OWN, which is the third rule of the
         * same kind as the two above and it is refused for the same reason.
         *
         * A box is a place on the painting: "this one stays over THERE". A round
         * cannot honour that, because the round is a sum of displacements and a
         * place is not one, and `share` below turns whatever box a state carries
         * into a reach around where the placement stands. So a state that named
         * a corner of the map got a box the size of that corner drawn around
         * home instead, somewhere else entirely, and nothing said so. Silently
         * moving a fence a person drew is worse than not letting them draw it.
         *
         * So the placement's fence and the placement's floor are the only ones,
         * and a state keeps its seconds, its picture, its speed and its pauses. */
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
  /* Whether it is travelling right now, as opposed to standing through a pause.
   *
   * A walk cycle is a GAIT: it is what the legs do while the thing is moving,
   * and a wander is mostly pauses. Without this the caller ran the cycle from
   * the clock alone and a figure standing at the end of a leg marched on the
   * spot until the next one. The frames are right, the question is when to run
   * them. A caller with a single-frame sprite can ignore it. */
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

/* PERSONAL SPACE, without giving up the pure function.
 *
 * Two figures wandering the same quay walked straight through each other, which
 * reads as broken however good the art is. Avoidance sounds like it needs a
 * simulation, and a simulation would end the property everything here rests on:
 * that the editor and the game compute the same answer from the same numbers
 * with no state carried between frames.
 *
 * It does not need one. Every mover's position at t is already a pure function
 * of t, so EVERY mover's position at t is knowable at once. Resolve them all,
 * then push apart whatever overlaps. Still pure, still reproducible, as long as
 * both sides pass the same list.
 *
 * One pass, not settled to convergence. Two figures shoving each other back and
 * forth over several rounds is where this would start to jitter, and one push is
 * enough to keep bodies out of each other at these sizes.
 *
 * y is measured squashed because the ground is: two figures a pixel apart up the
 * screen are much further apart in the world than two a pixel apart across it,
 * and separating in screen space would shove them into a vertical line.
 */
/* A BODY IS PART OF THE FLOOR, WHICH IS THE FIX separate() ASKS FOR BELOW.
 *
 * The note under PASSES says it outright: a walker crosses straight through a
 * stander because nothing in the floor knows the stander is there, it ends up
 * 87 percent inside, and only then does the push try to eject it. Ejecting a
 * body from the middle of another body is violent whatever the numbers are, and
 * the direction flips as it crosses the centre. Three shapes of fix were tried
 * inside the push and all three measured worse.
 *
 * So the floor learns about bodies instead. Wrap the ground test in this and a
 * leg search will not choose a step that lands in somebody, a walker turns aside
 * a body-width out rather than tunnelling, and the push goes back to being the
 * rare small correction it was designed as.
 *
 * Everyone is in one list, the player included, so one rule decides walker
 * against walker, walker against stander, and player against either. `skip` is
 * how a body avoids blocking itself: pass the index it occupies.
 *
 * y is divided by yScale for the same reason it is in separate(): the ground is
 * squashed, so a circle on screen is an ellipse in the world.
 */
export type Body = { x: number; y: number; r: number }

export function bodyAt(bodies: Body[], yScale = 0.72) {
  return (x: number, y: number, skip = -1): boolean => {
    for (let i = 0; i < bodies.length; i++) {
      if (i === skip) continue
      const b = bodies[i]
      const dx = x - b.x
      const dy = (y - b.y) / (yScale || 1)
      if (dx * dx + dy * dy < b.r * b.r) return true
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
  /* the same floor the behaviours are fenced by. Shoving someone out of a
   * neighbour and into a wall is not an improvement, so a push that lands
   * somewhere it could not stand is dropped and the overlap is kept. Being
   * inside another figure for a moment looks better than standing in stone. */
  stands?: (x: number, y: number) => boolean,
): { dx: number; dy: number }[] {
  const out = pts.map(() => ({ dx: 0, dy: 0 }))
  /* RELAXATION, not one shot, and this is what stopped the shoves reading as
   * spasms.
   *
   * Every pair used to be measured against the ORIGINAL positions and every
   * answer added up, so a figure caught between three others was handed the sum
   * of three separate full-depth corrections, none of which knew about the
   * others. Measured on nine figures walking a 40px path, 30000 frames: the
   * worst single-frame shift was 21.39px on bodies 11px across, which is not a
   * shove, it is a teleport, and 125 frames moved somebody more than 4px.
   *
   * Passing over the pairs several times and re-measuring each time fixes that
   * by construction: the second pass sees the gap the first one already opened,
   * so nobody is corrected twice for the same overlap. The total is then bounded
   * by the real geometry instead of by how many neighbours happen to be close.
   *
   * Two passes at half strength, swept rather than picked. Same nine figures,
   * 30000 frames, against the single full-strength pass that shipped:
   *
   *   passes   >4px shifts   worst shift   deepest overlap
   *   1 (old)          171       31.93px           15.69px
   *   2                 97       25.80px           12.45px
   *   4                195       33.95px            9.10px
   *   8                379       40.07px           17.78px
   *
   * Two is better than one on all three. Four buys less overlap and pays for it
   * in exactly the thing being complained about, and eight is worse at both.
   *
   * This is an improvement and NOT a fix, and the number that says so is the
   * 25.80px worst shift, which is still more than a body width. See the note
   * under it. */
  const PASSES = 2
  const step = strength * 0.5
  /* WHAT IS STILL WRONG HERE, so nobody spends another session tuning numbers.
   *
   * Traced frame by frame: a walker crosses straight THROUGH a stander, because
   * nothing in the floor knows the stander is there. lifeAt's leg search samples
   * every 2px and refuses a leg over ground it cannot stand on, and a person
   * standing on that ground is not part of that test. So the walker gets 87%
   * inside, and only then does this pass try to eject it. Ejecting something
   * from the middle of something else is violent whatever the numbers are, and
   * the direction flips as it passes the centre: measured -8.46px one frame and
   * +11.20px the next while the walker's own position moved a third of a pixel.
   *
   * Three shapes of fix were measured and all three made it worse or nothing:
   * blending the direction toward a fixed per-pair angle, anchoring it to where
   * the two figures belong (32.61px worst, worse than doing nothing), and more
   * relaxation passes.
   *
   * The fix is not in here. Standing figures belong in the FLOOR, so the leg
   * search routes around them and penetration never happens, and this pass goes
   * back to being the rare small correction it was designed as. That is a change
   * to what canStand means and it has not been made. */
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
        /* THE DIRECTION HAS TO BE STEADY WHERE THE PUSH IS STRONGEST, and it
         * was the exact opposite, which is where the spasm came from.
         *
         * The shove is (want - d) / 2, so it is biggest when two bodies are
         * nearly on the same spot. That is also where dx / d is worthless: a
         * tenth of a pixel of drift swings the direction right round, and the
         * biggest push in the pass swings with it. Measured on nine figures on
         * a 40px path: 20.07px of movement in a single frame on bodies 11px
         * across, while the same figures with no push at all never moved more
         * than 1.75px. It was never the pile-up and never the floor guard;
         * both were measured with the same harness and neither changed it.
         *
         * So near the middle the geometry is faded out and a direction that
         * cannot swing is faded in. The fallback is fixed for a given pair, so
         * a pass that lands deep inside pushes the same way this frame and the
         * next, and the blend keeps it continuous instead of switching over.
         * The angle is arbitrary and only has to be stable and to differ
         * between pairs, so neighbours do not all shove along one axis. */
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

/* WHICH STATE IS LIVE AT t: the division, then a walk of at most six numbers.
 *
 * Exported because the editor has to draw the fence that is in force right now,
 * and a second copy of this walk somewhere else would be a second law. c is how
 * many whole rounds have gone by, which is what gives each state its own clock:
 * a state has been live for c of its own durations plus however far into it we
 * are. into is that remainder. */
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

/* A BOX IS A PLACE, AND A PLACE IS NOT A TERM IN A SUM.
 *
 * A round is the sum of what every state has travelled on its own clock, and
 * that sum only closes if each term is a DISPLACEMENT: a fixed function of that
 * state's clock and of nothing else. A behaviour with no box is one, because it
 * moves by offset from wherever it stands. A behaviour fenced to a box is not.
 * The box is a rectangle on the painting, so the walk lands inside it whatever
 * it was handed, and the term stops meaning "how far this state carried the
 * thing" and starts meaning "where this state is", which REPLACES the sum
 * instead of adding to it. The last state carrying a move overwrites every
 * earlier one. Measured on a three state round in a 200x200 box: the drawn
 * position was the last moving state's own position on 55.8% of 20000 frames, a
 * state asking 12-24 px/s drew 3.9, and the placement stood still with its walk
 * cycle running on 27.8% of 187499 frames, up to 8.30s unbroken.
 *
 * Anchoring each state where the round has left it looks like the fix and is
 * not. It makes every term a function of the anchor as well as the clock, and
 * with the floor in force a walk's legs are a step function of where it starts,
 * so the term jumps the moment the anchor moves. Measured two ways. Anchoring
 * every state walked the worst single frame step from 0.71px to 128.56px by
 * t=300000s, and it grew with the session because the error multiplies by
 * completed rounds. Anchoring only the live state instead put a 76 to 95px jump
 * at every state change, on 200 of 200 seeds of a fenced round. Neither ships.
 *
 * So a state inherits the fence's ROOM and not its position, and this is what
 * the box MEANS inside a round: the box is the room the WHOLE ROUND has, and the
 * states that move divide it. The live state decides everything anyone can watch
 * happen, the speed and the gait and the facing and the picture, at full asking.
 * A state that is not live decides one thing only, how far it has already
 * carried the thing, which is the memory that lets a state resume where it
 * froze. What no state gets is the whole box to itself, because n bounded walks
 * summed inside one rectangle cannot each have all of it. That is arithmetic
 * rather than a policy, and it is the price of the sum.
 *
 * The room is measured FROM WHERE THE PLACEMENT STANDS and on each side
 * separately, so the n offsets add up to exactly the box and the hold below
 * never has to bite. A rectangle of the right size centred on the placement is
 * not the same thing and it was what shipped: a placement standing in the corner
 * of its own box had the same reach in both directions, so the sum ran out of
 * the box on the short side and the hold took the difference. Measured with a
 * two state round in a 100x100 box, the placement 5px in from the corner: 60.5%
 * of 60000 frames were held against the fence and 8.6% of the moving frames
 * covered no ground at all, which is marching on the spot, back again on any
 * placement not dropped dead centre.
 *
 * Nor is the room flattened. It used to be held to 0.35 of its own width, on the
 * reasoning that a wander's reach is already flattened by the map's
 * foreshortening. That reasoning belongs to a wander with NO box, which spreads
 * range by range*0.35; one with a box uses the box's own height and always has.
 * So the flattening made a state move differently from the identical behaviour
 * outside a round, and it took most of the vertical room: the same 100x100 box
 * gave the round 32px of dy against 95 for the same walk with no round.
 *
 * Measured after, on the same fixture: 0.0% of 60000 frames outside the box from
 * the centre and from the corner alike, reach 96x95 and 95x91 of 100x100, and
 * each state still draws the speed it asked for. Sharing less strictly was tried
 * for the extra reach and is not worth it: box/n^0.75 bought 107x108 and put
 * 5.5% of frames outside the box, and box/sqrt(n) bought 129x125 and put 23.3%
 * outside, which is the hold biting again for reach the sum already has. */
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
  /* WHICH STATE IS LIVE, AND WHERE THE ROUND LEFT IT, AS ARITHMETIC.
   *
   * The round is the sum of the durations, so t modulo that sum says where in
   * the round it is and walking the durations says which state that lands in.
   *
   * The part that matters is the clock each state keeps. A state's own time is
   * the time it has been LIVE: the number of completed rounds times its
   * duration, plus however far into it we are now. A state that finished earlier
   * this round has one more whole run behind it; one still to come this round
   * has one fewer. So a wander that stops to be a boulder resumes at exactly the
   * second it froze, and there is nothing to remember between frames.
   *
   * The position is the SUM of what every state has travelled on that clock.
   * State zero is the placement's own behaviour drawn as it stands, which is why
   * a reader that knows nothing about states sees the same creature. Every later
   * state adds only its displacement since it first went live, so one that has
   * not run yet this round adds nothing and one that has adds exactly what it
   * covered.
   *
   * That sum is what closes the round. Anchoring each state where the walk of
   * the states before it left off looks like the same thing and is not: state
   * zero is then anchored at home every round with no memory of the round
   * before, so the wrap throws away everything states one and up travelled.
   * Measured on the check file's troll, five rounds of a 63s sequence with a
   * rolling state at 40-45 px/s: wrap jumps of 58.37 / 22.27 / 28.99 / 117.47 /
   * 166.76px and a worst single-frame step of 166.69px. A travelling state also
   * arrived carrying its own offset for the round, which is the seam the old
   * comment here called half a pixel for a drift: 58.39px for a wander.
   *
   * A state's live clock is continuous in t, since it only ever stops and starts
   * again where it stopped, and each behaviour is continuous in its own clock.
   * So the sum is continuous everywhere, at a state change and at the wrap
   * alike. Same measurement after: worst wrap jump 0.019px, worst state change
   * 0.044px, worst step 1.31px. That 1.31 is not a seam, it is the hop a wander
   * rides while dashing dropping to nothing when the dash ends, which every
   * wander has always done: the plain beach crab measures 2.86px the same way.
   *
   * The price is that every state is worked out from the placement's own home
   * rather than from wherever the sequence has wandered to, because a sum only
   * telescopes when each term is a fixed function of its own clock. The note on
   * `share` above has the two measurements that killed the alternative. What it
   * costs is that a state's floor test is taken in the placement's frame and not
   * in the drawn one, so it is right to within the reach the other states have,
   * and sharing the fence between the movers is what bounds that reach. On the
   * 35% law's own case, a 40px path down a 100px box, that measures 0 frames off
   * the path in 20000, and on an L of two 40px arms 0 in 40000. On a box that is
   * mostly NOT walkable, a 12px corridor down a 300x40 box, it measures 9384 of
   * 40000 frames and 6px out, which is the case the 35% law says to hold by the
   * box alone rather than by the floor.
   */
  if (life.states && life.states.length > 1) {
    const st = life.states
    const { k, c, into } = liveState(st, t)
    /* how many states actually move, because they are the ones that share the
     * fence. A state that only changes the picture takes none of it. */
    let movers = 0
    for (let j = 0; j < st.length; j++) if (st[j].move) movers++
    /* THE FLOOR IS SHARED FOR THE SAME REASON THE BOX IS.
     *
     * Every state is worked out from the placement's own home, so its floor test
     * is taken there and not where the sprite is drawn. One state held to a 40px
     * path is on the path; two of them, each held to it around the same point,
     * add their offsets and the SUM is off it by as much as the path is wide.
     * Measured on the 35% law's own case, a 40px path down a 100px box with a
     * four state round: 1190 of 20000 frames off the path, 14.11px out.
     *
     * That used to be hidden rather than solved. The share held a state's height
     * to 0.35 of its width, which on this fixture came to 8.75px against the
     * path's 20, so the sum squeaked inside by 2.5px. It is luck and it is
     * orientation, because the flattening only ever squeezed y: the same fixture
     * turned on its side, a 40px corridor running up the box instead of across
     * it, measures 1360 of 20000 frames and 9.40px out on the code that passes
     * the flat one.
     *
     * So the floor is divided the same way the box is: a state may stand where
     * the placement could stand if its step from home were multiplied by the
     * number of movers. That gives each state a walkable region 1/n as wide
     * about home, so n of them still sum to the region the placement really has,
     * and it is the identity when only one state moves. Same fixture after: 0 of
     * 20000 frames off the path both ways up, and it uses more of the path than
     * the flattening allowed, 34.4px of the 40 across and 32.2 up, against 28.5
     * across and 56.6 up-and-off-it before. */
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
      /* THE FLOOR REACHES THE STATES HERE, and it has to be done at read time
       * rather than trusted to construction.
       *
       * A state's move only takes the floor as a second fence when it carries
       * walkOnly of its own, and cleanLife copies the parent's down into them.
       * But the editor learns walkOnly from the box the person drew, which is
       * AFTER the plan has already been cleaned, so it stamps the flag on the
       * finished object and every state inside it keeps the false it was built
       * with. Measured 2026-08-25 on the troll's own four-state round over a
       * 40px path: 20.4% of 36000 frames off the floor and 20.2px out at worst,
       * against 0.2% and 1.2px for the identical walk with no round. Nothing
       * without a round was ever affected, which is why nineteen hub people
       * behaved and the first thing with a sequence did not.
       *
       * Fixing only the caller would leave every doc.json already written on
       * disk carrying stateless states, so the parent's flag is applied here
       * too. A state that asks for the floor itself still gets it. */
      /* THE PLACEMENT'S OWN FENCE, BOTH HALVES OF IT, applied here rather than
       * trusted to whoever built the round.
       *
       * cleanLife hands a state the parent's box and the parent's floor flag,
       * and it reads both off `out` at the moment it runs. The editor learns
       * both from the box the person drew, which is AFTER the plan has already
       * been cleaned, so it stamped them on the finished object and every state
       * inside kept the null and the false it was built with. One line,
       * `mv.bounds = out.bounds ? ... : null`, and both halves went missing
       * together.
       *
       * Measured on the troll actually placed on the hub, its saved life against
       * the map's own mask: 16.5% of 36000 frames off the walkable ground and
       * 16px from anything standable, with a box that is 47.9% standable and
       * walkOnly true at the top. Fixing the caller alone cannot help it,
       * because that life is already on disk with `bounds: null` in every state,
       * and so is every other round anybody has already made.
       *
       * A state that carries its own is left alone: cleanLife refuses to let one
       * name a box, so anything that has one got it from a parent already. */
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
        // only what it has travelled since it first went live. Without this a
        // state arrives already displaced by wherever its own behaviour sits at
        // second zero, which is the second seam: a pixel for a drift, the whole
        // radius for an orbit, the length of a leg for a wander.
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
    /* the fence, on the sum rather than on any one state. Every behaviour holds
     * itself inside the box already, so this only bites when several states each
     * walk a box and their distances from home pile up. Held rather than wrapped
     * or bounced, because holding is the one that stays continuous. */
    const box = life.bounds
    if (box) {
      dx = clamp(home.x + dx, box.x, box.x + box.w) - home.x
      dy = clamp(home.y + dy, box.y, box.y + box.h) - home.y
    }
    /* THE FLOOR, ON THE SUM, and nothing above this line could do it.
     *
     * Every state is worked out as a displacement from HOME and the states are
     * added up, so each one can be fenced only around home, never around where
     * the round has actually carried the thing. `near` scales that test by the
     * number of movers to keep the sum inside the room, which is sound for a
     * rectangle and cannot be sound for a walkable mask: ground is an arbitrary
     * shape, so a point tested three times as far from home is a different
     * point, not a smaller version of the same one. Measured on the troll
     * actually standing on the hub, its own saved life against the map's own
     * mask: 16.5% of 36000 frames off the walkable ground, 16px from anything
     * standable. Taking the scaling out makes it 51.1%, so the proxy is helping
     * and is still not a fence.
     *
     * So the sum is tested where the sum lands. Home is standable by
     * construction, the thing was put there, and the offset shrinks toward it
     * until the feet are back on ground. Direction is kept and only distance
     * gives way, so it reads as coming up short of somewhere rather than being
     * dragged sideways.
     *
     * Sixteen steps is a sixteenth of the offset, well under a pixel at these
     * ranges, and it is a fixed loop so the editor and the game land on the
     * same answer for the same second.
     *
     * WHAT IT COSTS, measured on the same troll and the same mask: off-mask
     * frames 5936 of 36000 to 0, and in exchange 4 frames of 36000 move more
     * than 4px in one tick, worst 11.78px, where before the worst was 1.75px.
     * That is the fence biting when the line back to home crosses a hole in the
     * ground, so the pull-back skips to the near side of it. Once every two and
     * a half minutes against being 16px inside a market stall, which is the
     * trade taken. Anything better than this wants the walk itself to know
     * where the round has carried it, and that is a bigger change than a
     * fence. */
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
    /* the opening of the very first round has nothing to dissolve out of. The
     * placement has not been drawn yet, so a fade in there is a fade in from
     * nothing and the game draws no sprite at all while it lasts, because it
     * drops anything at 0.01 alpha or under (PmapScene.tsx:918). Measured on the
     * example the planner prompt itself hands over, whose first state asks for
     * 0.25s: alpha 0.00 at t=0, so the thing was invisible on the first frame it
     * ever had. The round opens at full and only the seams inside it melt. */
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
  /* THE PATH, not only where it ends.
   *
   * The floor test used to ask whether the far end of a leg was standable and
   * nothing about the line to it, so a walker cut the corner off a quay and
   * crossed stone it could never step on. On a map whose walkable ground is thin
   * paths that reads as walking through a wall.
   *
   * Sampled every two pixels, which is finer than a foot is wide here, and it
   * runs on the same fixed candidate sequence as before, so the editor and the
   * game still choose the identical leg. */
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
    /* THE CAP IS A ROUND, NOT A CLIFF.
     *
     * 512 legs bounds the cost, and it has to: this walk is the whole per-call
     * price, the hub has 94 placements, and it runs on school Chromebooks. But
     * the walk used to fall off the end of those legs and answer `still`, which
     * put the thing back on its anchor at dx 0 dy 0 and left it standing there
     * for the rest of the session. Measured on the beach crab: moving at
     * t=1800s, frozen from t=1932.92s, 32.2 minutes. An advisory session is 30
     * to 45 minutes, so every wandering placement in every bundle already
     * exported reaches that during real play.
     *
     * So the legs close into a round instead. Leg 512 walks back to the anchor,
     * which is where leg 0 starts, so the last position of the round is the
     * first position of the next one and the walk simply carries on. The round's
     * length is not known until the legs have been walked, so a t past the end
     * costs a second walk: one to learn the round, one to place the thing inside
     * it. That is bounded and it never grows again, which is the property that
     * matters. Measured on the crab: 0.07us at t=0 either way, 14.1us at t=3600s
     * before, 21.9us after, and flat from there to any t.
     *
     * Legs 0 to 511 are untouched, so nothing that has ever been exported moves
     * by a rounding error before the 32 minute mark. */
    let tw = t
    for (let pass = 0; pass < 2; pass++) {
      px = home.x
      py = home.y
      clock = 0
      for (let k = 0; k <= 512; k++) {
        /* the leg home. It is not offered to the floor test the way the others
         * are, because a leg that got refused would end somewhere else and the
         * round would not close: the wrap would be a teleport again. The anchor
         * is the pixel a person dropped the placement on, so it is ground it can
         * stand on, and this line is walked once every 32 minutes. */
        const homing = k === 512
        let tx = homing ? home.x : cx + (rnd(k * 2 + 1, seed) * 2 - 1) * halfW
        let ty = homing ? home.y : cy + (rnd(k * 2 + 2, seed) * 2 - 1) * halfH
        /* the second fence. Candidates are drawn from the same fixed sequence and
         * the first standable one wins, so this stays reproducible: the editor
         * and the game pick the identical target as long as they agree about the
         * floor, which they do, it is the same mask. If none of the tries land on
         * floor the thing simply stays put for that leg, which is what a creature
         * boxed into a wall would do anyway. */
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
          /* Blocked everywhere, so it stays put for that leg, which is what a
           * creature boxed into a wall would do anyway.
           *
           * Sliding along x and then y instead, the rule Thor walks by, was
           * tried here and taken back out. It only fires when all twelve
           * candidates are refused, which is a thin path rather than a plaza, so
           * it was measured on the two worst: a 12px corridor 300 long and an L
           * of two 20px arms, 20000 frames each, walkOnly on. Sliding covered
           * the same 284px of the corridor and the same 186px of the L, left the
           * same 36 frames off the floor on the L and twice as many on the
           * corridor, and shrank the L's vertical coverage from 181px to 140px.
           * The one thing it bought was walking 77% of the time instead of 72%.
           * Against that it moved 19298 of 20000 frames of an ordinary fenced
           * walk, by up to 264.6px, and four bundles are already exported. The
           * fence bug it was suggested for is the anchor above, and that is
           * fixed: this fixture goes from 19.7px off the path to 0.2px without
           * any of this. */
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
      /* past the end of the round, so `clock` is now the length of the whole
       * round and the second pass lands inside it. A round of no length means a
       * thing that neither travels nor pauses, and there is nowhere for that to
       * be but its anchor, so stop rather than divide by zero. */
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
