// A binary heap, because every search in this folder needs one.
//
// The obvious open set is an array with a linear scan for the minimum, which is
// O(n) per pop against O(log n) here. On a 264,192 pixel plane that difference
// is the whole running time.

export class MinHeap {
  constructor(scoreOf) {
    this.items = []
    this.score = scoreOf || ((x) => x)
  }

  get size() {
    return this.items.length
  }

  push(item) {
    this.items.push(item)
    let i = this.items.length - 1
    const s = this.score(item)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.score(this.items[parent]) <= s) break
      this.items[i] = this.items[parent]
      i = parent
    }
    this.items[i] = item
  }

  pop() {
    if (this.items.length === 0) return undefined
    const top = this.items[0]
    const last = this.items.pop()
    if (this.items.length === 0) return top
    this.items[0] = last
    let i = 0
    const s = this.score(last)
    for (;;) {
      const l = i * 2 + 1
      const r = l + 1
      let smallest = i
      let smallestScore = s
      if (l < this.items.length) {
        const ls = this.score(this.items[l])
        if (ls < smallestScore) {
          smallest = l
          smallestScore = ls
        }
      }
      if (r < this.items.length) {
        const rs = this.score(this.items[r])
        if (rs < smallestScore) {
          smallest = r
          smallestScore = rs
        }
      }
      if (smallest === i) break
      this.items[i] = this.items[smallest]
      this.items[smallest] = last
      i = smallest
    }
    return top
  }

  peek() {
    return this.items[0]
  }

  clear() {
    this.items.length = 0
  }
}

/* a heap over integer keys with a flat score array beside it, which is what the
 * grid searches use: no object per node and no closure call per comparison */
export class IndexHeap {
  constructor(scores) {
    this.scores = scores
    this.heap = []
  }

  get size() {
    return this.heap.length
  }

  push(index) {
    this.heap.push(index)
    let i = this.heap.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.scores[this.heap[parent]] <= this.scores[this.heap[i]]) break
      const t = this.heap[i]
      this.heap[i] = this.heap[parent]
      this.heap[parent] = t
      i = parent
    }
  }

  pop() {
    const top = this.heap[0]
    const last = this.heap.pop()
    if (this.heap.length === 0) return top
    this.heap[0] = last
    let i = 0
    for (;;) {
      const l = i * 2 + 1
      const r = l + 1
      let smallest = i
      if (l < this.heap.length && this.scores[this.heap[l]] < this.scores[this.heap[smallest]]) smallest = l
      if (r < this.heap.length && this.scores[this.heap[r]] < this.scores[this.heap[smallest]]) smallest = r
      if (smallest === i) break
      const t = this.heap[i]
      this.heap[i] = this.heap[smallest]
      this.heap[smallest] = t
      i = smallest
    }
    return top
  }
}
