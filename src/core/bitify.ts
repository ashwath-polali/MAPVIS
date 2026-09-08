/* Drop a sprite to the map's own pixel size, so one of its pixels is one of the map's. Resampled by DOMINANT colour per block, not by averaging: averaging invents colours that were never in the sprite and reads as mud. */

export interface BitResult {
  data: Uint8ClampedArray
  width: number
  height: number
  note: string
}

/* near-identical shades group together for the vote, so a block of one colour
 * in six dithered tones does not split its vote six ways and lose to a stray */
const KEY = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)

const A_MIN = 20

/* How much finer than the map this sprite is. Only decides whether there is anything to do; the resample works from the target size. */
export function bitFactor(natW: number, natH: number, drawnW: number, drawnH: number): number {
  if (drawnW < 1 || drawnH < 1) return 1
  return Math.max(1, Math.min(natW / drawnW, natH / drawnH))
}

/* Resampled to an exact TARGET SIZE, not by a whole-number factor: a rounded factor made a palm 11 percent bigger the moment the key was pressed. Sizes must not move. */
export function bitify(data: Uint8ClampedArray, w: number, h: number, tw: number, th: number): BitResult {
  const ow = Math.max(1, Math.round(tw))
  const oh = Math.max(1, Math.round(th))
  if (ow >= w && oh >= h) return { data, width: w, height: h, note: 'already at the map’s size' }
  const out = new Uint8ClampedArray(ow * oh * 4)
  const counts = new Map<number, number>()
  const pick = new Map<number, number>()
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      counts.clear()
      pick.clear()
      let opaque = 0
      let total = 0
      let aSum = 0
      // the slice of source this output pixel stands for, worked out from the
      // ratio rather than a fixed block, so nothing is skipped or counted twice
      const x0 = Math.floor((ox * w) / ow)
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * w) / ow))
      const y0 = Math.floor((oy * h) / oh)
      const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * h) / oh))
      for (let y = y0; y < Math.min(y1, h); y++) {
        for (let x = x0; x < Math.min(x1, w); x++) {
          const i = (y * w + x) * 4
          total++
          const a = data[i + 3]
          if (a <= A_MIN) continue
          opaque++
          aSum += a
          const k = KEY(data[i], data[i + 1], data[i + 2])
          counts.set(k, (counts.get(k) || 0) + 1)
          // the first exact colour seen for this group is what gets written, so
          // the output only ever contains colours the sprite already had
          if (!pick.has(k)) pick.set(k, i)
        }
      }
      const o = (oy * ow + ox) * 4
      // a block that is mostly air becomes air: this is what keeps the outline
      // crisp instead of growing a halo of half-transparent fringe
      if (!opaque || opaque * 2 < total) {
        out[o] = 0
        out[o + 1] = 0
        out[o + 2] = 0
        out[o + 3] = 0
        continue
      }
      let best = -1
      let bestN = -1
      for (const [k, n] of counts)
        if (n > bestN) {
          bestN = n
          best = k
        }
      const src = pick.get(best) as number
      out[o] = data[src]
      out[o + 1] = data[src + 1]
      out[o + 2] = data[src + 2]
      // one alpha for the whole sprite edge: pixel art is on or off, and the
      // averaged alpha is what makes a downsample look smudged
      out[o + 3] = aSum / opaque > 200 ? 255 : Math.round(aSum / opaque)
    }
  }
  return { data: out, width: ow, height: oh, note: `${w}×${h} → ${ow}×${oh}` }
}
