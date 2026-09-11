// One field, every source, every destination.
//
// A* answers one question per run. When many things are heading for the same
// place, a single backwards pass from that place answers for all of them at
// once, and every one of them then walks downhill with no search at all.

import { IndexHeap } from './heap.js'

export function flowField(levels, w, h, goal, { tolerance = 10 } = {}) {
  const size = w * h
  const cost = new Float64Array(size).fill(Infinity)
  const gi = goal[1] * w + goal[0]
  if (levels[gi] === 0) return null
  cost[gi] = 0

  const open = new IndexHeap(cost)
  open.push(gi)
  const done = new Uint8Array(size)

  while (open.size) {
    const cur = open.pop()
    if (done[cur]) continue
    done[cur] = 1
    const cx = cur % w
    const cy = (cur / w) | 0
    const cl = levels[cur]

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nx = cx + dx
        const ny = cy + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const ni = ny * w + nx
        if (levels[ni] === 0 || Math.abs(levels[ni] - cl) > tolerance) continue
        if (dx !== 0 && dy !== 0 && (levels[cy * w + nx] === 0 || levels[ny * w + cx] === 0)) continue
        const step = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1
        if (cost[cur] + step < cost[ni]) {
          cost[ni] = cost[cur] + step
          open.push(ni)
        }
      }
    }
  }
  return cost
}

/* the direction of steepest descent at every pixel, as a pair of signed bytes.
 * Cheaper to store and to read than a float vector, and a walk only ever needs
 * eight directions anyway. */
export function toDirections(cost, w, h) {
  const dirs = new Int8Array(w * h * 2)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!isFinite(cost[i])) continue
      let best = cost[i]
      let bx = 0
      let by = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const c = cost[ny * w + nx]
          if (c < best) {
            best = c
            bx = dx
            by = dy
          }
        }
      }
      dirs[i * 2] = bx
      dirs[i * 2 + 1] = by
    }
  }
  return dirs
}

export function walkDown(dirs, w, h, from, limit = 4096) {
  const out = [from.slice()]
  let [x, y] = from
  for (let n = 0; n < limit; n++) {
    const i = y * w + x
    const dx = dirs[i * 2]
    const dy = dirs[i * 2 + 1]
    if (dx === 0 && dy === 0) break
    x += dx
    y += dy
    out.push([x, y])
  }
  return out
}
