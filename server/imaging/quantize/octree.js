// Octree quantisation.
//
// Median cut has to hold every distinct colour in memory before it can split
// anything. An octree folds as it reads, so it takes one pass and a bounded
// amount of memory, which is what a batch of forty sprites wants.

const MAX_DEPTH = 8

class OctNode {
  constructor(depth) {
    this.depth = depth
    this.leaf = depth === MAX_DEPTH
    this.count = 0
    this.r = 0
    this.g = 0
    this.b = 0
    this.children = new Array(8).fill(null)
  }
}

/* the index at a depth is one bit from each channel, most significant first, so
 * walking down the tree narrows the colour a bit at a time */
const indexAt = (r, g, b, depth) => {
  const shift = 7 - depth
  return (((r >> shift) & 1) << 2) | (((g >> shift) & 1) << 1) | ((b >> shift) & 1)
}

export class Octree {
  constructor() {
    this.root = new OctNode(0)
    this.levels = Array.from({ length: MAX_DEPTH }, () => [])
    this.leaves = 0
  }

  add(r, g, b) {
    this._add(this.root, r, g, b)
  }

  _add(node, r, g, b) {
    if (node.leaf) {
      if (node.count === 0) this.leaves++
      node.count++
      node.r += r
      node.g += g
      node.b += b
      return
    }
    const i = indexAt(r, g, b, node.depth)
    if (!node.children[i]) {
      const child = new OctNode(node.depth + 1)
      node.children[i] = child
      if (!child.leaf) this.levels[node.depth + 1].push(child)
      else this.leaves++
    }
    this._add(node.children[i], r, g, b)
  }

  /* fold the deepest inner node back into a leaf, deepest first, because those
   * are the splits describing the smallest colour differences */
  reduce() {
    for (let d = MAX_DEPTH - 1; d >= 0; d--) {
      const level = this.levels[d]
      while (level.length) {
        const node = level.pop()
        let folded = 0
        for (let i = 0; i < 8; i++) {
          const c = node.children[i]
          if (!c) continue
          node.r += c.r
          node.g += c.g
          node.b += c.b
          node.count += c.count
          node.children[i] = null
          folded++
        }
        if (folded === 0) continue
        node.leaf = true
        this.leaves -= folded - 1
        return true
      }
    }
    return false
  }

  palette() {
    const out = []
    const walk = (node) => {
      if (!node) return
      if (node.leaf) {
        if (node.count > 0) out.push([Math.round(node.r / node.count), Math.round(node.g / node.count), Math.round(node.b / node.count)])
        return
      }
      for (const c of node.children) walk(c)
    }
    walk(this.root)
    return out
  }
}

export function octreeQuantize(rgba, want = 16) {
  const tree = new Octree()
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue
    tree.add(rgba[i], rgba[i + 1], rgba[i + 2])
  }
  while (tree.leaves > want && tree.reduce());
  return tree.palette().slice(0, want)
}
