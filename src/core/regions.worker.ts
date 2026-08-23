/* The region pass, off the main thread.
 *
 * Segments the painting into flat-ish contiguous colour regions so the levels
 * step can propose by acceptance: hover a region, see exactly what it covers,
 * click to take it. Nothing here guesses what is walkable; the human does.
 *
 * The law is the same one the cut flood uses: a flood grows 4-way from a seed
 * pixel and admits a neighbour when its Manhattan RGB distance to the SEED
 * colour is inside the tolerance. Never chained neighbour to neighbour, which
 * is how sea-navy once walked into volcano rock. After labelling, regions
 * smaller than a few dozen pixels are absorbed into their most common
 * neighbour so hover does not flicker over anti-aliasing residue.
 *
 * Cost: one flood visit per pixel plus two absorb passes, all O(w*h). A
 * 688x384 painting (264k px) labels in a few tens of milliseconds.
 */

interface RegionJob {
  w: number
  h: number
  tol: number
  minPx: number
  pix: ArrayBuffer
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<RegionJob>) => void) | null
  postMessage: (msg: unknown, transfer: Transferable[]) => void
}

ctx.onmessage = (e: MessageEvent<RegionJob>) => {
  const { w, h, tol, minPx } = e.data
  const pix = new Uint8ClampedArray(e.data.pix)
  const n = w * h
  const labels = new Int32Array(n).fill(-1)
  const queue = new Int32Array(n)
  const sizes: number[] = []
  let count = 0

  // ---- seed floods, scan order ----------------------------------------
  for (let s = 0; s < n; s++) {
    if (labels[s] !== -1 || pix[s * 4 + 3] === 0) continue
    const id = count++
    const sr = pix[s * 4]
    const sg = pix[s * 4 + 1]
    const sb = pix[s * 4 + 2]
    let head = 0
    let tail = 0
    let size = 0
    labels[s] = id
    queue[tail++] = s
    while (head < tail) {
      const i = queue[head++]
      size++
      const x = i % w
      // 4-way, admission measured against the seed colour only
      if (x > 0) tryAdmit(i - 1)
      if (x < w - 1) tryAdmit(i + 1)
      if (i >= w) tryAdmit(i - w)
      if (i < n - w) tryAdmit(i + w)
    }
    sizes.push(size)

    function tryAdmit(j: number) {
      if (labels[j] !== -1 || pix[j * 4 + 3] === 0) return
      const k = j * 4
      if (Math.abs(pix[k] - sr) + Math.abs(pix[k + 1] - sg) + Math.abs(pix[k + 2] - sb) > tol) return
      labels[j] = id
      queue[tail++] = j
    }
  }

  // ---- absorb the residue ----------------------------------------------
  // a region under minPx joins whichever neighbouring region it touches most.
  // Two passes so chains of specks settle into their surroundings.
  for (let pass = 0; pass < 2; pass++) {
    const votes = new Map<number, Map<number, number>>()
    for (let i = 0; i < n; i++) {
      const a = labels[i]
      if (a < 0 || sizes[a] >= minPx) continue
      const x = i % w
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]
      for (const j of nb) {
        if (j < 0) continue
        const b = labels[j]
        if (b < 0 || b === a) continue
        let m = votes.get(a)
        if (!m) votes.set(a, (m = new Map()))
        m.set(b, (m.get(b) || 0) + 1)
      }
    }
    if (!votes.size) break
    const remap = new Map<number, number>()
    for (const [a, m] of votes) {
      let best = -1
      let bn = 0
      for (const [b, c] of m)
        if (c > bn) {
          bn = c
          best = b
        }
      if (best >= 0) remap.set(a, best)
    }
    if (!remap.size) break
    for (let i = 0; i < n; i++) {
      let a = labels[i]
      if (a < 0) continue
      // follow at most a short chain: a speck absorbed into a speck
      for (let d = 0; d < 4; d++) {
        const t = remap.get(a)
        if (t === undefined) break
        a = t
      }
      if (a !== labels[i]) {
        sizes[labels[i]]--
        sizes[a]++
        labels[i] = a
      }
    }
  }

  // the surviving distinct regions, for the "read N regions" note
  let live = 0
  const seen = new Uint8Array(count)
  for (let i = 0; i < n; i++) {
    const a = labels[i]
    if (a >= 0 && !seen[a]) {
      seen[a] = 1
      live++
    }
  }

  ctx.postMessage({ labels: labels.buffer, count: live }, [labels.buffer])
}
