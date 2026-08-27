/* The walk test: the character, the step law, and the reach check.
 *
 * Ported from tools/maskdraw/app.js, which transcribed it from
 * src/game/painted/PaintedScene.tsx in the game repo (the step test at lines
 * 96-117 and the ticker at 262-295). Feet plus two hip probes, a level
 * tolerance, axis slide, and the escape clause for a character who is already
 * standing on a blocked pixel. Refused moves paint the hits layer.
 *
 * Constants that are measured in painting pixels stay configurable, because
 * they have to scale with the map's resolution.
 */
import type { MaskDoc } from './mask'

export interface WalkCfg {
  speed: number
  hip: number
  hipDY: number
  near: number
  charH: number
  yScale: number
}

export const defaultCfg = (): WalkCfg => ({
  speed: 34,
  hip: 2,
  hipDY: 1,
  near: 10,
  charH: 18,
  yScale: 0.72,
})

// test-stage feel only: the exported map.json speed stays
// the contract value; the tool's walk test just moves at this multiple of it
export const TEST_SPEED = 1.9

export const near = (cfg: WalkCfg, a: number, b: number) => Math.abs(a - b) <= cfg.near

export function canStandFrom(doc: MaskDoc, cfg: WalkCfg, x: number, y: number, fromLvl: number) {
  const f = doc.lvlAt(x, y)
  if (f === 0 || !near(cfg, f, fromLvl)) return false
  const h1 = doc.lvlAt(x - cfg.hip, y - cfg.hipDY)
  const h2 = doc.lvlAt(x + cfg.hip, y - cfg.hipDY)
  return h1 > 0 && h2 > 0 && near(cfg, h1, f) && near(cfg, h2, f)
}

export const canStand = (doc: MaskDoc, cfg: WalkCfg, x: number, y: number) =>
  canStandFrom(doc, cfg, x, y, doc.lvlAt(x, y))

export class Walker {
  x = 0
  y = 0
  facing = 'south'
  animT = 0
  blocked = false
  /* the hop. Same arc as the beach: 520ms, 44px of rise on a sine, with a
   * slight stretch at the top so he does not read as a rigid cut-out sliding
   * upward. It changes nothing about where he stands: the feet keep testing
   * the same pixel, so a jump cannot carry him over a wall. */
  jumpT = -1

  jump() {
    if (this.jumpT < 0) this.jumpT = 0
  }
  /* how far off the ground he is drawn right now, and how much he is stretched */
  hop(): { rise: number; stretch: number } {
    if (this.jumpT < 0) return { rise: 0, stretch: 1 }
    const k = this.jumpT / 520
    if (k >= 1) return { rise: 0, stretch: 1 }
    return { rise: 44 * Math.sin(Math.PI * k), stretch: 1 + 0.14 * Math.sin(Math.PI * k) }
  }

  constructor(spawn: [number, number]) {
    this.x = spawn[0]
    this.y = spawn[1]
  }

  step(doc: MaskDoc, cfg: WalkCfg, keys: Record<string, boolean>, dt: number) {
    if (this.jumpT >= 0) {
      this.jumpT += dt * 1000
      if (this.jumpT / 520 >= 1) this.jumpT = -1
    }
    let dx = 0
    let dy = 0
    if (keys['arrowup'] || keys['w']) dy -= 1
    if (keys['arrowdown'] || keys['s']) dy += 1
    if (keys['arrowleft'] || keys['a']) dx -= 1
    if (keys['arrowright'] || keys['d']) dx += 1
    const moving = dx !== 0 || dy !== 0
    this.blocked = false
    if (!moving) {
      this.animT = 0
      return false
    }
    const m = Math.hypot(dx, dy)
    dx /= m
    dy /= m
    const nx = this.x + dx * cfg.speed * TEST_SPEED * dt
    const ny = this.y + dy * cfg.speed * TEST_SPEED * dt * cfg.yScale
    const cur = doc.lvlAt(this.x, this.y)
    const stuck = cur === 0
    if (canStandFrom(doc, cfg, nx, ny, cur) || stuck) {
      this.x = nx
      this.y = ny
    } else if (canStandFrom(doc, cfg, nx, this.y, cur)) {
      this.x = nx
      doc.markHit(nx, ny)
      this.blocked = true
    } else if (canStandFrom(doc, cfg, this.x, ny, cur)) {
      this.y = ny
      doc.markHit(nx, ny)
      this.blocked = true
    } else {
      doc.markHit(nx, ny)
      this.blocked = true
    }
    this.facing = dirFrom(dx, dy * cfg.yScale)
    this.animT += dt * 9
    return this.blocked
  }
}

export function dirFrom(dx: number, dy: number) {
  const a = (Math.atan2(dy, dx) * 180) / Math.PI
  if (a >= -22.5 && a < 22.5) return 'east'
  if (a >= 22.5 && a < 67.5) return 'south-east'
  if (a >= 67.5 && a < 112.5) return 'south'
  if (a >= 112.5 && a < 157.5) return 'south-west'
  if (a >= -67.5 && a < -22.5) return 'north-east'
  if (a >= -112.5 && a < -67.5) return 'north'
  if (a >= -157.5 && a < -112.5) return 'north-west'
  return 'west'
}

export interface ReachResult {
  reached: number
  orphans: { px: number; rect: [number, number, number, number]; level: number }[]
}

/* Walk-flood from the spawn using the engine's own legality test, then list
 * every walkable island the player can never get to. This is the check that
 * would have caught the 1px breakwater seam before a person noticed it. */
export function checkReach(doc: MaskDoc, cfg: WalkCfg, sx?: number, sy?: number): ReachResult {
  const x0 = sx == null ? doc.spawn[0] : sx
  const y0 = sy == null ? doc.spawn[1] : sy
  const seen = new Uint8Array(doc.W * doc.H)
  const q: [number, number][] = [[x0, y0]]
  const D: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]
  if (doc.inB(x0, y0)) seen[doc.idx(x0, y0)] = 1
  for (let h = 0; h < q.length; h++) {
    const [x, y] = q[h]
    const cur = doc.lvlAt(x, y)
    for (const [dx, dy] of D) {
      const nx = x + dx
      const ny = y + dy
      if (!doc.inB(nx, ny) || seen[doc.idx(nx, ny)]) continue
      if (!canStandFrom(doc, cfg, nx, ny, cur)) continue
      seen[doc.idx(nx, ny)] = 1
      q.push([nx, ny])
    }
  }
  // orphan islands: walkable pixels a body could stand on but never reach
  const orphan = new Uint8Array(doc.W * doc.H)
  const out: ReachResult['orphans'] = []
  for (let y = 0; y < doc.H; y++)
    for (let x = 0; x < doc.W; x++) {
      const i = doc.idx(x, y)
      if (seen[i] || orphan[i] || !doc.lvl[i] || !canStand(doc, cfg, x, y)) continue
      let n = 0
      let minx = x
      let maxx = x
      let miny = y
      let maxy = y
      const s: [number, number][] = [[x, y]]
      orphan[i] = 1
      for (let h = 0; h < s.length; h++) {
        const [cx, cy] = s[h]
        n++
        minx = Math.min(minx, cx)
        maxx = Math.max(maxx, cx)
        miny = Math.min(miny, cy)
        maxy = Math.max(maxy, cy)
        for (const [dx, dy] of D) {
          const nx = cx + dx
          const ny = cy + dy
          if (
            !doc.inB(nx, ny) ||
            orphan[doc.idx(nx, ny)] ||
            seen[doc.idx(nx, ny)] ||
            !doc.lvl[doc.idx(nx, ny)] ||
            !canStand(doc, cfg, nx, ny)
          )
            continue
          orphan[doc.idx(nx, ny)] = 1
          s.push([nx, ny])
        }
      }
      if (n > 12) out.push({ px: n, rect: [minx, miny, maxx, maxy], level: doc.lvl[i] })
    }
  // paint the orphans into the hits layer so they are visible on the map
  doc.hits.fill(0)
  for (let i = 0; i < orphan.length; i++) if (orphan[i]) doc.hits[i] = 8
  return { reached: q.length, orphans: out.sort((a, b) => b.px - a.px).slice(0, 20) }
}
