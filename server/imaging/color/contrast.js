// Whether text on a colour can be read.
//
// Every panel this tool generates has words on it somewhere, and the one defect
// that survives a look at a thumbnail is a label that vanishes into its own
// background at a smaller size.

import { luminance } from './srgb.js'

/* WCAG 2, which is the ratio everything is specified against even though it is
 * known to be wrong about dark backgrounds. Ranges 1 to 21. */
export function contrastRatio(a, b) {
  const l1 = luminance(a)
  const l2 = luminance(b)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

export const passesAA = (fg, bg, large = false) => contrastRatio(fg, bg) >= (large ? 3 : 4.5)
export const passesAAA = (fg, bg, large = false) => contrastRatio(fg, bg) >= (large ? 4.5 : 7)

/* black or white, whichever can be read on this. The obvious version compares
 * luminance to 0.5 and gets mid-tones wrong; comparing the two ratios is one
 * more line and always right. */
export function readableInk(bg) {
  return contrastRatio([0, 0, 0], bg) >= contrastRatio([255, 255, 255], bg) ? [0, 0, 0] : [255, 255, 255]
}

/* the smallest lightness change that clears a ratio, found by bisection rather
 * than guessed at, so a generated panel can be nudged instead of rejected */
export function liftToContrast(fg, bg, target = 4.5, steps = 20) {
  if (contrastRatio(fg, bg) >= target) return fg.slice()
  const goal = readableInk(bg)
  let lo = 0
  let hi = 1
  for (let i = 0; i < steps; i++) {
    const t = (lo + hi) / 2
    const c = [
      Math.round(fg[0] + (goal[0] - fg[0]) * t),
      Math.round(fg[1] + (goal[1] - fg[1]) * t),
      Math.round(fg[2] + (goal[2] - fg[2]) * t),
    ]
    if (contrastRatio(c, bg) >= target) hi = t
    else lo = t
  }
  return [
    Math.round(fg[0] + (goal[0] - fg[0]) * hi),
    Math.round(fg[1] + (goal[1] - fg[1]) * hi),
    Math.round(fg[2] + (goal[2] - fg[2]) * hi),
  ]
}

/* the worst pair in a palette, which is the number worth reporting rather than
 * an average nobody can act on */
export function worstPair(palette) {
  let worst = Infinity
  let pair = null
  for (let i = 0; i < palette.length; i++) {
    for (let j = i + 1; j < palette.length; j++) {
      const r = contrastRatio(palette[i], palette[j])
      if (r < worst) {
        worst = r
        pair = [i, j]
      }
    }
  }
  return { ratio: worst, pair }
}
