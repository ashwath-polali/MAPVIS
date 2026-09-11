// A single channel plane, which is what every mask in this tool actually is.
//
// The editor's cut, its levels and its occluders are all one byte per pixel over
// the same grid. Carrying them as rgba quadruples wastes three quarters of the
// memory and makes every loop below four times longer than it has to be.

export class Plane {
  constructor(w, h, fill = 0) {
    this.w = w
    this.h = h
    this.data = new Uint8ClampedArray(w * h)
    if (fill) this.data.fill(fill)
  }

  static from(data, w, h) {
    const p = new Plane(w, h)
    p.data.set(data.subarray ? data.subarray(0, w * h) : data.slice(0, w * h))
    return p
  }

  /* out of bounds reads answer 0 rather than undefined, because every kernel
   * below runs off the edge and a branch per tap costs more than the clamp */
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0
    return this.data[y * this.w + x]
  }

  set(x, y, v) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    this.data[y * this.w + x] = v
  }

  clone() {
    return Plane.from(this.data, this.w, this.h)
  }

  fill(v) {
    this.data.fill(v)
    return this
  }

  count(pred) {
    let n = 0
    for (let i = 0; i < this.data.length; i++) if (pred(this.data[i])) n++
    return n
  }

  /* the tightest box holding anything non-zero, which is what a trim needs and
   * what a footprint is measured from */
  bounds(threshold = 1) {
    let x0 = this.w
    let y0 = this.h
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.data[y * this.w + x] < threshold) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
  }

  map(fn) {
    const out = new Plane(this.w, this.h)
    for (let i = 0; i < this.data.length; i++) out.data[i] = fn(this.data[i], i % this.w, (i / this.w) | 0)
    return out
  }

  /* the alpha channel of an rgba buffer, lifted out. Collision read from a
   * sprite's own alpha is the cheapest mask there is and it is always in
   * register with the picture. */
  static alphaOf(rgba, w, h) {
    const p = new Plane(w, h)
    for (let i = 0, j = 0; i < rgba.length; i += 4, j++) p.data[j] = rgba[i + 3]
    return p
  }

  toRGBA(color = [255, 255, 255]) {
    const out = new Uint8ClampedArray(this.w * this.h * 4)
    for (let i = 0, j = 0; i < this.data.length; i++, j += 4) {
      out[j] = color[0]
      out[j + 1] = color[1]
      out[j + 2] = color[2]
      out[j + 3] = this.data[i]
    }
    return out
  }
}
