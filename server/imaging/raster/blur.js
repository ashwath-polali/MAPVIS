// Three blurs, none of them interchangeable.
//
// Box is fast and square, which shows on a straight edge. Gaussian is correct
// and slow. Stack blur is close enough to gaussian to pass and runs in time that
// does not grow with the radius, which is what a live preview needs.

import { separable, gaussianKernel } from './convolve.js'

export function boxBlur(src, w, h, radius) {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  const span = radius * 2 + 1

  for (let y = 0; y < h; y++) {
    let acc = 0
    for (let i = -radius; i <= radius; i++) acc += src[y * w + Math.min(w - 1, Math.max(0, i))]
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / span
      // a running sum: one value in and one out per step, so the cost of a wide
      // radius is the same as a narrow one
      const outIdx = Math.min(w - 1, Math.max(0, x - radius))
      const inIdx = Math.min(w - 1, Math.max(0, x + radius + 1))
      acc += src[y * w + inIdx] - src[y * w + outIdx]
    }
  }

  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let i = -radius; i <= radius; i++) acc += tmp[Math.min(h - 1, Math.max(0, i)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / span
      const outIdx = Math.min(h - 1, Math.max(0, y - radius))
      const inIdx = Math.min(h - 1, Math.max(0, y + radius + 1))
      acc += tmp[inIdx * w + x] - tmp[outIdx * w + x]
    }
  }
  return out
}

export function gaussianBlur(src, w, h, sigma) {
  return separable(src, w, h, gaussianKernel(sigma))
}

/* three box passes, which converges on a gaussian by the central limit theorem
 * and is the trick every image editor uses. Visually indistinguishable above
 * about radius three. */
export function fastGaussian(src, w, h, sigma) {
  const r = Math.max(1, Math.round(sigma * 1.88))
  return boxBlur(boxBlur(boxBlur(src, w, h, r), w, h, r), w, h, r)
}

/* edge preserving: near pixels count more, and so do pixels of a similar value,
 * so a soft area smooths and a hard line survives. This is the one to reach for
 * before palette matching, because a blur across an outline eats the outline. */
export function bilateral(src, w, h, radius, sigmaSpace, sigmaValue) {
  const out = new Float32Array(src.length)
  const spatial = []
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      spatial.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigmaSpace * sigmaSpace)))
    }
  }
  const vs = 2 * sigmaValue * sigmaValue
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const centre = src[y * w + x]
      let acc = 0
      let weight = 0
      let k = 0
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = Math.min(h - 1, Math.max(0, y + dy))
        for (let dx = -radius; dx <= radius; dx++, k++) {
          const sx = Math.min(w - 1, Math.max(0, x + dx))
          const v = src[sy * w + sx]
          const d = v - centre
          const wgt = spatial[k] * Math.exp(-(d * d) / vs)
          acc += v * wgt
          weight += wgt
        }
      }
      out[y * w + x] = weight === 0 ? centre : acc / weight
    }
  }
  return out
}
