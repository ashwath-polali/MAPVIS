// Nearest colour in a palette, without asking every entry every time.
//
// A 688x384 painting is 264,192 pixels. Against a 64 colour palette that is 16.9
// million distance calls for one pass, and a palette match runs several passes.
// A three dimensional tree takes it to about eight comparisons a pixel.

import { rgbToOklab } from '../color/oklab.js'

class Node {
  constructor(axis, point, index, left, right) {
    this.axis = axis
    this.point = point
    this.index = index
    this.left = left
    this.right = right
  }
}

/* built over OKLab and not rgb, because the tree has to split on the same axes
 * the distance is measured in or the pruning is unsound and quietly returns the
 * second nearest colour */
export class ColorTree {
  constructor(palette) {
    this.palette = palette.map((c) => c.slice())
    this.points = palette.map(rgbToOklab)
    this.root = build(this.points.map((p, i) => i), this.points, 0)
  }

  nearest(rgb) {
    const q = rgbToOklab(rgb)
    const best = { index: -1, dist: Infinity }
    search(this.root, q, this.points, best)
    return best.index
  }

  nearestColor(rgb) {
    const i = this.nearest(rgb)
    return i < 0 ? rgb.slice() : this.palette[i].slice()
  }

  /* the k nearest, for a dither that wants a second choice to trade against */
  knearest(rgb, k) {
    const q = rgbToOklab(rgb)
    const heap = []
    searchK(this.root, q, this.points, heap, k)
    return heap.sort((a, b) => a.dist - b.dist).map((h) => h.index)
  }
}

function build(indices, points, depth) {
  if (indices.length === 0) return null
  const axis = depth % 3
  indices.sort((a, b) => points[a][axis] - points[b][axis])
  const mid = indices.length >> 1
  return new Node(
    axis,
    points[indices[mid]],
    indices[mid],
    build(indices.slice(0, mid), points, depth + 1),
    build(indices.slice(mid + 1), points, depth + 1),
  )
}

function dist2(a, b) {
  const d0 = a[0] - b[0]
  const d1 = a[1] - b[1]
  const d2 = a[2] - b[2]
  return d0 * d0 + d1 * d1 + d2 * d2
}

function search(node, q, points, best) {
  if (!node) return
  const d = dist2(q, node.point)
  if (d < best.dist) {
    best.dist = d
    best.index = node.index
  }
  const delta = q[node.axis] - node.point[node.axis]
  const near = delta < 0 ? node.left : node.right
  const far = delta < 0 ? node.right : node.left
  search(near, q, points, best)
  // the only interesting line: the far side is worth opening only when the
  // splitting plane itself is closer than the best found so far
  if (delta * delta < best.dist) search(far, q, points, best)
}

function searchK(node, q, points, heap, k) {
  if (!node) return
  const d = dist2(q, node.point)
  if (heap.length < k) heap.push({ index: node.index, dist: d })
  else {
    let worst = 0
    for (let i = 1; i < heap.length; i++) if (heap[i].dist > heap[worst].dist) worst = i
    if (d < heap[worst].dist) heap[worst] = { index: node.index, dist: d }
  }
  const delta = q[node.axis] - node.point[node.axis]
  const near = delta < 0 ? node.left : node.right
  const far = delta < 0 ? node.right : node.left
  searchK(near, q, points, heap, k)
  let worst = 0
  for (let i = 1; i < heap.length; i++) if (heap[i].dist > heap[worst].dist) worst = i
  if (heap.length < k || delta * delta < heap[worst].dist) searchK(far, q, points, heap, k)
}

/* a flat cache in front of the tree. A painting has far fewer distinct colours
 * than pixels, so most lookups after the first thousand are repeats. */
export function cachedMatcher(palette) {
  const tree = new ColorTree(palette)
  const cache = new Map()
  return (rgb) => {
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]
    let hit = cache.get(key)
    if (hit === undefined) {
      hit = tree.nearest(rgb)
      cache.set(key, hit)
    }
    return hit
  }
}
