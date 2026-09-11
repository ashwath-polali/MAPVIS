// Convolution, separable where the kernel allows it.
//
// A 9x9 kernel over a 688x384 painting is 21 million multiplies. The same blur
// done as one horizontal pass and one vertical pass is 4.7 million, and the two
// give the same answer for any kernel that is the outer product of a 1D one.

export function convolve1D(src, w, h, kernel, horizontal) {
  const out = new Float32Array(src.length)
  const r = (kernel.length - 1) >> 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = 0; k < kernel.length; k++) {
        const d = k - r
        // the edge is clamped rather than wrapped or zeroed: wrapping bleeds
        // the far side of a sprite into it, and zeroing darkens the border
        const sx = horizontal ? Math.min(w - 1, Math.max(0, x + d)) : x
        const sy = horizontal ? y : Math.min(h - 1, Math.max(0, y + d))
        acc += src[sy * w + sx] * kernel[k]
      }
      out[y * w + x] = acc
    }
  }
  return out
}

export function separable(src, w, h, kernel) {
  return convolve1D(convolve1D(src, w, h, kernel, true), w, h, kernel, false)
}

export function convolve2D(src, w, h, kernel, kw) {
  const kh = kernel.length / kw
  const rx = (kw - 1) >> 1
  const ry = (kh - 1) >> 1
  const out = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let ky = 0; ky < kh; ky++) {
        const sy = Math.min(h - 1, Math.max(0, y + ky - ry))
        for (let kx = 0; kx < kw; kx++) {
          const sx = Math.min(w - 1, Math.max(0, x + kx - rx))
          acc += src[sy * w + sx] * kernel[ky * kw + kx]
        }
      }
      out[y * w + x] = acc
    }
  }
  return out
}

export function gaussianKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float32Array(r * 2 + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    k[i + r] = v
    sum += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  return k
}

export const SOBEL_X = [-1, 0, 1, -2, 0, 2, -1, 0, 1]
export const SOBEL_Y = [-1, -2, -1, 0, 0, 0, 1, 2, 1]
export const LAPLACIAN = [0, 1, 0, 1, -4, 1, 0, 1, 0]
export const SHARPEN = [0, -1, 0, -1, 5, -1, 0, -1, 0]

/* gradient magnitude, which is where an outline is. Used to find the edge of a
 * painted region before anybody traces it by hand. */
export function sobel(src, w, h) {
  const gx = convolve2D(src, w, h, SOBEL_X, 3)
  const gy = convolve2D(src, w, h, SOBEL_Y, 3)
  const out = new Float32Array(src.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(gx[i], gy[i])
  return out
}
