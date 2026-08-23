/* Drop a sprite to the map's own pixel size.
 *
 * A generated sprite is 96 or 128 pixels across and gets drawn onto the map at
 * a quarter of that, so four of its pixels land inside one map pixel. The
 * browser resamples them on the way down, and the result carries detail finer
 * than anything the painting has: soft gradients and half-tone edges sitting on
 * top of chunky hand-painted pixel art. It reads as a sticker.
 *
 * The fix is not a "pixelate amount" to fiddle with. The placement already
 * knows the answer: a sprite drawn at scale 0.25 should BE four times smaller,
 * and then sit at scale 1, so one of its pixels is one of the map's.
 *
 * The resample matters as much as the size. Averaging a block invents colours
 * that were never in the sprite, which is how you get mud. Pixel art wants the
 * DOMINANT colour of each block instead: the palette comes out unchanged, edges
 * stay hard, and what you get looks drawn rather than blurred.
 */

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

/* How much finer than the map this sprite currently is. Only used to decide
 * whether there is anything to do and what to tell the person; the resample
 * itself works from the target size, not from this. 1 means it is already at or
 * below the map's fidelity. */
export function bitFactor(natW: number, natH: number, drawnW: number, drawnH: number): number {
  if (drawnW < 1 || drawnH < 1) return 1
  return Math.max(1, Math.min(natW / drawnW, natH / drawnH))
}

/* Resample to an exact TARGET SIZE, not by a whole-number factor.
 *
 * The first version divided by a rounded factor, which meant a palm drawn at
 * 0.3 got a factor of 3 and came out 32px wide where it had been drawing 28.8 —
 * eleven percent bigger the moment you pressed the key. Sizes must not move.
 *
 * So the output is exactly the size the placement was already drawing, and the
 * source block for each output pixel is worked out per pixel. The blocks are
 * not all the same size when the ratio is not whole, which is fine: what has to
 * be true is that ONE OUTPUT PIXEL IS ONE MAP PIXEL, and that is now exact.
 */
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
