// A* over a walkable plane.
//
// The elevation is not a cost, it is a gate: a step is legal when the level
// difference is inside a tolerance and illegal otherwise. That is the same rule
// the editor walks by, and a search that used elevation as a weight instead
// would happily route a character up a cliff slowly.

import { IndexHeap } from './heap.js'

const N8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]]
const N4 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1]]

/* octile, which is the exact cost of a diagonal-allowed grid walk with no
 * obstacles. Euclidean underestimates and makes the search open far more nodes
 * than it needs; manhattan overestimates on a diagonal grid and stops being
 * admissible, so the path it finds is not the shortest. */
export function octile(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx)
  const dy = Math.abs(ay - by)
  return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)
}

export function astar(levels, w, h, start, goal, { tolerance = 10, diagonal = true, maxNodes = 400000 } = {}) {
  const nb = diagonal ? N8 : N4
  const size = w * h
  const g = new Float64Array(size).fill(Infinity)
  const f = new Float64Array(size).fill(Infinity)
  const from = new Int32Array(size).fill(-1)
  const closed = new Uint8Array(size)

  const si = start[1] * w + start[0]
  const gi = goal[1] * w + goal[0]
  if (levels[si] === 0 || levels[gi] === 0) return null

  g[si] = 0
  f[si] = octile(start[0], start[1], goal[0], goal[1])
  const open = new IndexHeap(f)
  open.push(si)
  let expanded = 0

  while (open.size) {
    const cur = open.pop()
    if (cur === gi) return trace(from, gi, w)
    if (closed[cur]) continue
    closed[cur] = 1
    if (++expanded > maxNodes) return null

    const cx = cur % w
    const cy = (cur / w) | 0
    const cl = levels[cur]

    for (const [dx, dy, cost] of nb) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const ni = ny * w + nx
      if (closed[ni]) continue
      const nl = levels[ni]
      if (nl === 0) continue
      if (Math.abs(nl - cl) > tolerance) continue
      // a diagonal that cuts a corner passes through two blocked pixels the
      // walk law would have stopped at, so both orthogonals have to be open
      if (dx !== 0 && dy !== 0) {
        if (levels[cy * w + nx] === 0 || levels[ny * w + cx] === 0) continue
      }
      const tentative = g[cur] + cost
      if (tentative >= g[ni]) continue
      g[ni] = tentative
      f[ni] = tentative + octile(nx, ny, goal[0], goal[1])
      from[ni] = cur
      open.push(ni)
    }
  }
  return null
}

function trace(from, goal, w) {
  const out = []
  let cur = goal
  while (cur >= 0) {
    out.push([cur % w, (cur / w) | 0])
    cur = from[cur]
  }
  return out.reverse()
}

/* a path with every point that lies on the straight line between its neighbours
 * dropped, which is what makes a route readable rather than a pixel list */
export function straighten(path) {
  if (path.length < 3) return path.slice()
  const out = [path[0]]
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1]
    const b = path[i]
    const c = path[i + 1]
    if ((b[0] - a[0]) * (c[1] - b[1]) !== (c[0] - b[0]) * (b[1] - a[1])) out.push(b)
  }
  out.push(path[path.length - 1])
  return out
}
