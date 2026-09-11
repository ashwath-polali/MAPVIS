// Flood fill and connected components.
//
// Both walk the same way and both are iterative on purpose. A recursive fill
// over a 264,192 pixel plane blows the stack somewhere around the twelfth
// thousand pixel, and it does it on the largest region rather than the smallest,
// so it always fails on the one that mattered.

import { Plane } from './plane.js'

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

/* a scanline fill: it takes whole runs at a time rather than one pixel, which
 * on a painting of large flat areas is an order of magnitude fewer pushes */
export function floodFill(plane, sx, sy, value, { tolerance = 0 } = {}) {
  const target = plane.get(sx, sy)
  if (Math.abs(target - value) <= tolerance) return { filled: 0, plane }
  const out = plane.clone()
  const match = (x, y) => x >= 0 && x < out.w && y >= 0 && y < out.h && Math.abs(out.data[y * out.w + x] - target) <= tolerance
  const stack = [[sx, sy]]
  let filled = 0

  while (stack.length) {
    const [px, py] = stack.pop()
    if (!match(px, py)) continue
    let x0 = px
    while (match(x0 - 1, py)) x0--
    let x1 = px
    while (match(x1 + 1, py)) x1++
    for (let x = x0; x <= x1; x++) {
      out.data[py * out.w + x] = value
      filled++
    }
    for (const dy of [-1, 1]) {
      let spanning = false
      for (let x = x0; x <= x1; x++) {
        const ok = match(x, py + dy)
        if (ok && !spanning) {
          stack.push([x, py + dy])
          spanning = true
        } else if (!ok) spanning = false
      }
    }
  }
  return { filled, plane: out }
}

/* every distinct region, labelled. Two passes with union-find rather than one
 * pass with a relabel, because relabelling on a spiral shape means walking the
 * whole plane again per merge. */
export function components(plane, { connectivity = 8, threshold = 1 } = {}) {
  const nb = connectivity === 4 ? N4 : N8
  const labels = new Int32Array(plane.w * plane.h).fill(-1)
  const parent = []

  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]
      a = parent[a]
    }
    return a
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }

  for (let y = 0; y < plane.h; y++) {
    for (let x = 0; x < plane.w; x++) {
      if (plane.data[y * plane.w + x] < threshold) continue
      let best = -1
      for (const [dx, dy] of nb) {
        if (dy > 0 || (dy === 0 && dx > 0)) continue
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= plane.w || ny >= plane.h) continue
        const l = labels[ny * plane.w + nx]
        if (l < 0) continue
        if (best < 0) best = l
        else union(best, l)
      }
      if (best < 0) {
        best = parent.length
        parent.push(best)
      }
      labels[y * plane.w + x] = best
    }
  }

  const remap = new Map()
  const sizes = []
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] < 0) continue
    const root = find(labels[i])
    let id = remap.get(root)
    if (id === undefined) {
      id = sizes.length
      remap.set(root, id)
      sizes.push(0)
    }
    labels[i] = id
    sizes[id]++
  }
  return { labels, count: sizes.length, sizes }
}

/* everything but the biggest region removed, which is how a mask with stray
 * specks becomes one island */
export function largestOnly(plane, opts) {
  const { labels, sizes } = components(plane, opts)
  if (!sizes.length) return plane.clone()
  let best = 0
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i
  const out = new Plane(plane.w, plane.h)
  for (let i = 0; i < labels.length; i++) if (labels[i] === best) out.data[i] = plane.data[i]
  return out
}

/* holes filled: flood from outside, and anything the flood did not reach that
 * is also empty was enclosed */
export function fillHoles(plane, threshold = 1) {
  const outside = new Plane(plane.w, plane.h)
  const stack = []
  for (let x = 0; x < plane.w; x++) {
    stack.push([x, 0], [x, plane.h - 1])
  }
  for (let y = 0; y < plane.h; y++) {
    stack.push([0, y], [plane.w - 1, y])
  }
  while (stack.length) {
    const [x, y] = stack.pop()
    if (x < 0 || y < 0 || x >= plane.w || y >= plane.h) continue
    const i = y * plane.w + x
    if (outside.data[i] || plane.data[i] >= threshold) continue
    outside.data[i] = 255
    for (const [dx, dy] of N4) stack.push([x + dx, y + dy])
  }
  const out = plane.clone()
  for (let i = 0; i < out.data.length; i++) if (!outside.data[i] && plane.data[i] < threshold) out.data[i] = 255
  return out
}
