// The error diffusion kernels, by name.
//
// Each one is a list of [dx, dy, weight] and a divisor. They differ in how far
// the error travels and how much of it goes straight down: a kernel that pushes
// a lot downward smooths gradients and smears edges, and one that keeps it close
// keeps edges and leaves visible texture.

export const FLOYD_STEINBERG = {
  name: 'floyd-steinberg',
  divisor: 16,
  points: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]],
}

/* only three quarters of the error is diffused at all, which is what gives it
 * the clean flat areas it is known for and also what makes it lose the darkest
 * and lightest ends of a ramp */
export const ATKINSON = {
  name: 'atkinson',
  divisor: 8,
  points: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]],
}

export const JARVIS = {
  name: 'jarvis',
  divisor: 48,
  points: [
    [1, 0, 7], [2, 0, 5],
    [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
    [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1],
  ],
}

export const STUCKI = {
  name: 'stucki',
  divisor: 42,
  points: [
    [1, 0, 8], [2, 0, 4],
    [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
    [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1],
  ],
}

export const BURKES = {
  name: 'burkes',
  divisor: 32,
  points: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]],
}

export const SIERRA = {
  name: 'sierra',
  divisor: 32,
  points: [
    [1, 0, 5], [2, 0, 3],
    [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2],
    [-1, 2, 2], [0, 2, 3], [1, 2, 2],
  ],
}

export const SIERRA_TWO = {
  name: 'sierra-two',
  divisor: 16,
  points: [[1, 0, 4], [2, 0, 3], [-2, 1, 1], [-1, 1, 2], [0, 1, 3], [1, 1, 2], [2, 1, 1]],
}

export const SIERRA_LITE = {
  name: 'sierra-lite',
  divisor: 4,
  points: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]],
}

/* one row of error and nothing downward at all, so vertical edges stay exactly
 * where they were. The one to use on a sprite whose silhouette matters. */
export const FALSE_FLOYD = {
  name: 'false-floyd',
  divisor: 8,
  points: [[1, 0, 3], [0, 1, 3], [1, 1, 2]],
}

export const KERNELS = {
  'floyd-steinberg': FLOYD_STEINBERG,
  atkinson: ATKINSON,
  jarvis: JARVIS,
  stucki: STUCKI,
  burkes: BURKES,
  sierra: SIERRA,
  'sierra-two': SIERRA_TWO,
  'sierra-lite': SIERRA_LITE,
  'false-floyd': FALSE_FLOYD,
}

export const kernelNames = () => Object.keys(KERNELS)
