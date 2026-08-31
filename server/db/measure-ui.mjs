// The half of a drawn piece that is not the png: four edge numbers per ground
// and a named rectangle per region.
//
//   node server/db/measure-ui.mjs            measures and prints, writes nothing
//   node server/db/measure-ui.mjs --write    saves them through the store
//   node server/db/measure-ui.mjs --write --publish   and marks each one finished
//
// Every number below is MEASURED OFF THE PIXELS. Nothing is a fraction of the
// canvas and nothing was read off a picture by eye, because a slice got by eye
// is the same hand measurement the game already carries in six stylesheets,
// moved one repo sideways. The method is written out at THE SCAN below.
import { many, one, closeDb } from './pool.mjs'
import { store } from '../store/blobs.mjs'
import { decodePNG } from '../sheet.mjs'
import { pieceType, saveUi, publishUi, checkSlices, opaqueRegions } from '../store/ui.mjs'

const write = process.argv.includes('--write')
const publish = process.argv.includes('--publish')
const only = process.argv.find((a) => !a.startsWith('-') && !a.endsWith('.mjs') && !a.endsWith('node.exe') && !a.endsWith('node'))

// ---- THE SCAN ---------------------------------------------------------------

/* HOW THE FOUR NUMBERS ARE GOT, in two passes, because a nine-slice can fail in
 * two different places and only one of them is about the middle.
 *
 * PASS ONE, THE MIDDLE. The centre of every ground in this kit is one plain
 * material: cream parchment on eleven of them and nothing at all on the
 * highlight edge, which is drawn as a hole. What the middle never has is INK.
 * Every line in this kit, the frame's edge, the rope, the beading, the ragged
 * bite along the paper's own edge, is drawn dark, so the question "where does
 * the frame end" is asked as "where does the drawn line stop".
 *
 * Dark is not a number somebody picked. The luminance of every opaque pixel goes
 * into a histogram and Otsu's threshold splits it, which is the cut that leaves
 * the two sides tightest about their own means: wood at about 85 on one side,
 * paper at about 215 and a tan blotch on it at about 170 on the other. A fully
 * transparent pixel is not dark, because a hole is a middle and the highlight
 * edge is drawn as one.
 *
 * THE SIDES ARE READ ONE LINE AT A TIME AND THE CORNERS ARE GROWN. A side is
 * where that line stops being ink, taken as the median down the middle sixty
 * percent of the edge, because where the paper starts is a fact about one line
 * and a bite out of its edge is one line's problem. Then each corner of the
 * middle is probed with a small square and pushed in until no drawn line crosses
 * it, because the parchment inside these frames is a ROUNDED rectangle: an inset
 * measured halfway down the left edge is right about the frame and still leaves
 * the paper's own curved corner inside the middle, and the middle is the part
 * that tiles. Measured on the dialogue box: mid-edge readings alone gave
 * 35/39/31/39, and at two and a half times the width that drew the paper's
 * rounded corner six times over, once per tile.
 *
 * TWO OTHER READINGS WERE TRIED AND BOTH LOSE ON REAL ART. Walking in until row
 * y and row y+1 stop differing finds the boundary on a flat interior and loses
 * it on a mottled one: the dialogue box's blotched parchment moved its own left
 * inset between 44 and 157 depending on where the tolerance went, because a
 * blotch reads as structure. Distance from the middle's own colour is no better,
 * because the light mat outside the paper's edge is CLOSER to the paper's median
 * than the paper's own tan blotches are, so no colour tolerance separates them.
 * The dark line between them does.
 *
 * PASS TWO, THE CORNERS. Pass one only says where the paper starts. It says
 * nothing about the thing that actually smears, which is an ornament sitting on
 * an edge: the edge cells are the part CSS repeats along their length, so a rope
 * curl or a brass corner block inside one of them is repeated across the whole
 * width of a widened box. Two pieces in this repo's own record died exactly
 * there.
 *
 * So each edge band is walked in from both ends. For a band, the plain run is
 * the part where every column (or row) looks like the band's own typical
 * cross-section, and the ornament is where it does not. Walking in from the
 * outside, the first place where a stretch of columns all sit close to that
 * cross-section is where the repeatable run begins, and everything outside it
 * has to be inside the corner. Stopping at the FIRST such stretch is what makes
 * a plank seam or a knot further along the rail harmless: the scan has already
 * stopped by then.
 *
 * The two passes are then maxed, per side, and the bands are re-cut and rescanned
 * until nothing moves, because a deeper top band can reveal a taller corner.
 */

const at = (im, x, y) => (y * im.w + x) * 4

const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1]

/* THE SPLIT BETWEEN TWO CLUSTERS, WITHOUT ANYBODY CHOOSING IT. Otsu walks every
 * possible threshold over a histogram and keeps the one where the two sides are
 * tightest about their own means. It is the standard answer to "these are two
 * materials, where does one stop" and it is four lines. */
function otsu(hist) {
  const total = hist.reduce((a, b) => a + b, 0)
  if (!total) return 0
  let sum = 0
  for (let i = 0; i < hist.length; i++) sum += i * hist[i]
  let back = 0
  let sumB = 0
  let best = 0
  let cut = 0
  for (let t = 0; t < hist.length; t++) {
    back += hist[t]
    if (!back) continue
    const fore = total - back
    if (!fore) break
    sumB += t * hist[t]
    const between = (back * fore * (sumB / back - (sum - sumB) / fore) ** 2) / (total * total)
    if (between > best) {
      best = between
      cut = t
    }
  }
  return cut
}

/* WHICH PIXELS ARE INK. Luminance, split by Otsu over the opaque pixels only. A
 * transparent pixel is not ink, because nothing was drawn there, and the
 * highlight edge's middle is exactly that. */
function inkMap(im) {
  const hist = new Array(256).fill(0)
  const lum = new Uint8Array(im.w * im.h)
  const solid = new Uint8Array(im.w * im.h)
  for (let i = 0; i < im.w * im.h; i++) {
    const p = i * 4
    lum[i] = Math.round(0.299 * im.data[p] + 0.587 * im.data[p + 1] + 0.114 * im.data[p + 2])
    solid[i] = im.data[p + 3] >= 40 ? 1 : 0
    if (solid[i]) hist[lum[i]]++
  }
  const cut = otsu(hist)
  return (x, y) => {
    const i = y * im.w + x
    return solid[i] === 1 && lum[i] < cut
  }
}

/* A SPECK IS NOT A LINE, and this is the number that says so.
 *
 * Refusing every ink pixel was tried and it stops on the flecks in the paper:
 * a rectangle grown until nothing at all crosses it read the cover band's left
 * inset as 211, on a frame 27 deep, because there is one dark chip in the
 * parchment there. What a rim, a rope or a rounded corner puts across a line is
 * a RUN of ink, and what a fleck puts there is a pixel or three. */
const SPECK = 3

/* WHERE THE FRAME ENDS ON EACH SIDE, read one line at a time.
 *
 * A line has arrived at the middle when eight pixels in a row carry no ink, so
 * a lit pixel on the frame's own bevel is not mistaken for the paper, and the
 * side is the median of what every line says. Median rather than the deepest,
 * because the dialogue box's parchment is bitten along its edge and one bite
 * would otherwise decide the whole inset: reading the deepest gave 147 on a
 * frame 39 deep. */
function sideBox(im, ink) {
  const hold = 8
  const enters = (n, isInk) => {
    for (let i = 0; i <= n - hold; i++) {
      let ok = true
      for (let k = 0; k < hold; k++) if (isInk(i + k)) ok = false
      if (ok) return i
    }
    return -1
  }
  const side = (lines, n, isAt) => {
    const got = []
    for (const l of lines) {
      const e = enters(n, (i) => isAt(l, i))
      if (e > 0) got.push(e)
    }
    /* HALF THE LINES HAVE TO FIND A FRAME AT ALL. Under that the picture is not
     * a frame round a plain middle, which is the one shape a nine-slice can
     * describe, and answering anyway would be four numbers about a picture that
     * cannot take them. */
    return got.length < lines.length / 2 ? -1 : median(got)
  }
  // read off the middle sixty percent of each axis, because a line near a corner
  // is looking at the corner rather than at the rail
  const ys = []
  for (let y = Math.floor(im.h * 0.2); y < Math.ceil(im.h * 0.8); y++) ys.push(y)
  const xs = []
  for (let x = Math.floor(im.w * 0.2); x < Math.ceil(im.w * 0.8); x++) xs.push(x)
  const left = side(ys, im.w, (y, i) => ink(i, y))
  const right = side(ys, im.w, (y, i) => ink(im.w - 1 - i, y))
  const top = side(xs, im.h, (x, i) => ink(x, i))
  const bottom = side(xs, im.h, (x, i) => ink(x, im.h - 1 - i))
  if (left < 0 || right < 0 || top < 0 || bottom < 0) return null
  return { top, right, bottom, left }
}

/* THE PAPER INSIDE THESE FRAMES IS A ROUNDED RECTANGLE, and its curve is the
 * thing that tiles. The four insets above are right about the frame and still
 * leave the paper's own corner arc inside the middle, and the middle is what a
 * widened box repeats: measured on the dialogue box at two and a half times its
 * width, that arc was drawn six times over, once per tile.
 *
 * So each corner of the middle is probed with a small square and both insets
 * meeting there are pushed in until no drawn line crosses that square.
 */
function clearCorners(im, ink, box) {
  const s = { ...box }
  const probe = Math.max(8, Math.round(Math.min(im.w, im.h) * 0.06))
  const dirty = (x0, y0) => {
    for (let y = y0; y < y0 + probe && y < im.h; y++) {
      let run = 0
      for (let x = x0; x < x0 + probe && x < im.w; x++) {
        if (ink(x, y)) {
          if (++run > SPECK) return true
        } else run = 0
      }
    }
    for (let x = x0; x < x0 + probe && x < im.w; x++) {
      let run = 0
      for (let y = y0; y < y0 + probe && y < im.h; y++) {
        if (ink(x, y)) {
          if (++run > SPECK) return true
        } else run = 0
      }
    }
    return false
  }
  // a corner arc is a fraction of the frame's own depth, so a runaway here means
  // the picture is not a rounded frame and the sides keep what they measured
  const cap = Math.max(box.top, box.right, box.bottom, box.left)
  for (let i = 0; i < cap; i++) {
    const tl = dirty(s.left, s.top)
    const tr = dirty(im.w - s.right - probe, s.top)
    const bl = dirty(s.left, im.h - s.bottom - probe)
    const br = dirty(im.w - s.right - probe, im.h - s.bottom - probe)
    if (!tl && !tr && !bl && !br) break
    if (tl || bl) s.left++
    if (tr || br) s.right++
    if (tl || tr) s.top++
    if (bl || br) s.bottom++
  }
  return s
}

function interiorBox(im) {
  const ink = inkMap(im)
  const box = sideBox(im, ink)
  return box ? clearCorners(im, ink, box) : null
}

/* WHERE A BAND STOPS BEING ORNAMENT AND STARTS BEING A RAIL.
 *
 * `sample(i, d)` hands back one pixel of the band, `i` along its length from the
 * near end and `d` down into it from the outside. `n` is the band's length.
 * Answers how many lines at the near end are ornament, and whether the band has
 * a plain run at all.
 *
 * A CORNER IS A CORNER. If the first quiet stretch does not turn up within a
 * quarter of the band's length then what is on that rail is not a corner
 * ornament, it is the rail's own pattern, and no inset anywhere can put a
 * pattern into a corner cell. Two of these pieces are in that case: the dialogue
 * box's top rail is carved scrollwork end to end, and the plank's side rails are
 * mostly one long metal bracket. Both answer 0 here and repeat, which is what
 * `round` is for, rather than growing an inset that eats the middle.
 */
function ornament(n, depth, sample) {
  if (depth <= 0) return { orn: 0, plain: true }
  /* THE BAND'S TYPICAL CROSS-SECTION, TAKEN OVER ITS WHOLE LENGTH. It was the
   * middle third, which is right for a rail with ornament only at its ends and
   * wrong for the plank, whose left rail is a bracket down the middle: the
   * typical line was then the bracket, and every plain stretch of wood read as
   * the ornament. The median over the whole length is the best single guess at
   * what the rail is made of without assuming where the ornament sits. */
  const typical = []
  for (let d = 0; d < depth; d++) {
    const vals = [[], [], [], []]
    for (let i = 0; i < n; i++) {
      const p = sample(i, d)
      for (let c = 0; c < 4; c++) vals[c].push(p[c])
    }
    typical.push(vals.map(median))
  }
  const off = []
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let d = 0; d < depth; d++) {
      const p = sample(i, d)
      const t = typical[d]
      s += (Math.abs(p[0] - t[0]) + Math.abs(p[1] - t[1]) + Math.abs(p[2] - t[2]) + Math.abs(p[3] - t[3])) / 4
    }
    off.push(s / depth)
  }
  /* A BAND WITH NOTHING ON IT MUST ANSWER ZERO. Otsu splits noise as happily as
   * it splits a rivet, so a band whose worst line is barely off its own typical
   * one has no ornament at all and the scan says so instead of inventing one. */
  const worst = Math.max(...off)
  if (worst < 20) return { orn: 0, plain: true }
  /* THE RAIL'S OWN SCATTER IS THE TOLERANCE, NOT OTSU'S SPLIT.
   *
   * Otsu is right for the middle, where two materials are being told apart and
   * both are most of a picture. It is wrong here, because a band is nearly all
   * rail with an ornament at one end, so the split it finds sits far above the
   * rail's own grain and lets a fading ornament through. Measured on the cover
   * band: the corner rope curl runs out to x=44 and Otsu called the run plain at
   * x=13, which put the tail of the curl inside the repeating edge cell and drew
   * a half curl at every tile seam, which is the exact failure the nine-slice
   * law is written about.
   *
   * The median deviation IS the rail's grain, because most of the band is rail.
   * Three times it is the line between grain and something drawn on top. */
  const tol = Math.max(8, 3 * median(off))
  // the first stretch of quiet lines is the start of the repeatable run. Long
  // enough that a single quiet line inside a carving does not end the ornament.
  const run = Math.max(4, Math.round(n * 0.02))
  const corner = Math.floor(n * 0.25)
  for (let i = 0; i <= n - run; i++) {
    let ok = true
    for (let k = 0; k < run; k++) if (off[i + k] > tol) ok = false
    if (ok) return i <= corner ? { orn: i, plain: true } : { orn: 0, plain: false }
  }
  return { orn: 0, plain: false }
}

function measure(im) {
  const inner = interiorBox(im)
  if (!inner) return null
  const s = { ...inner }
  const rails = []
  for (let pass = 0; pass < 4; pass++) {
    const px = (x, y) => {
      const i = at(im, x, y)
      return [im.data[i], im.data[i + 1], im.data[i + 2], im.data[i + 3]]
    }
    // the top and bottom bands, walked along x, which is what says how wide a
    // corner is
    const topL = ornament(im.w, s.top, (i, d) => px(i, d))
    const topR = ornament(im.w, s.top, (i, d) => px(im.w - 1 - i, d))
    const botL = ornament(im.w, s.bottom, (i, d) => px(i, im.h - 1 - d))
    const botR = ornament(im.w, s.bottom, (i, d) => px(im.w - 1 - i, im.h - 1 - d))
    // the left and right bands, walked along y, which is what says how tall one is
    const leftT = ornament(im.h, s.left, (i, d) => px(d, i))
    const leftB = ornament(im.h, s.left, (i, d) => px(d, im.h - 1 - i))
    const rightT = ornament(im.h, s.right, (i, d) => px(im.w - 1 - d, i))
    const rightB = ornament(im.h, s.right, (i, d) => px(im.w - 1 - d, im.h - 1 - i))
    rails.length = 0
    for (const [side, a, b] of [
      ['top', topL, topR],
      ['bottom', botL, botR],
      ['left', leftT, leftB],
      ['right', rightT, rightB],
    ])
      if (!a.plain || !b.plain) rails.push(side)
    const next = {
      top: Math.max(inner.top, leftT.orn, rightT.orn),
      bottom: Math.max(inner.bottom, leftB.orn, rightB.orn),
      left: Math.max(inner.left, topL.orn, botL.orn),
      right: Math.max(inner.right, topR.orn, botR.orn),
    }
    /* AND NO SIDE MAY EAT THE MIDDLE. top + bottom has to stay under h or CSS
     * drops the whole border image and says nothing, so a runaway corner scan is
     * capped here rather than discovered by checkSlices after a save. */
    const capY = Math.floor((im.h - 1) / 2)
    const capX = Math.floor((im.w - 1) / 2)
    next.top = Math.min(next.top, capY)
    next.bottom = Math.min(next.bottom, capY)
    next.left = Math.min(next.left, capX)
    next.right = Math.min(next.right, capX)
    const same = ['top', 'right', 'bottom', 'left'].every((k) => next[k] === s[k])
    Object.assign(s, next)
    if (same) break
  }
  return { slice: s, inner, rails: rails.slice() }
}

// ---- the named rectangles ---------------------------------------------------

const R = (name, kind, x, y, w, h, extra = {}) => ({
  name,
  kind,
  x: Math.round(x),
  y: Math.round(y),
  w: Math.round(w),
  h: Math.round(h),
  ...extra,
})

/* WHERE EACH NAMED WELL GOES.
 *
 * The vocabulary is not invented here: every name below is on the type in
 * server/store/ui.mjs, which took it from the record. What this adds is the
 * rectangle, and the geometry it is built from is the MEASURED middle rather
 * than a fraction of the canvas, so a well sits on the paper the piece actually
 * has rather than a percentage somebody liked.
 *
 * `in` is that middle. A well inside it survives a stretch, because the middle
 * is the part that stretches; a well on the frame is in a corner cell on
 * purpose, which is the only part of a nine-slice that never moves relative to
 * its own corner.
 */
const LAYOUT = {
  /* A HEADER STRIP, A BODY, AND THE CLOSE OUT OF THE HEADER'S WAY. The close is
   * cut out of the header rather than laid over it, because a title that runs
   * under the close control is the one layout bug every panel in every game has
   * had at least once. */
  panel: (m) => {
    const i = m.in
    const head = Math.max(16, Math.round(i.h * 0.22))
    const close = Math.min(head, Math.round(i.w * 0.12))
    return [
      R('header', 'text', i.x, i.y, i.w - close - 6, head),
      R('close', 'press', i.x + i.w - close, i.y, close, close),
      R('body', 'text', i.x, i.y + head + 4, i.w, i.h - head - 4),
    ]
  },

  /* THE SPEAKER'S FURNITURE HANGS OFF THE EDGES AND THE TEXT KEEPS THE PAPER.
   *
   * The plaque is a sibling of the text column and not a child of it, so it sits
   * ON the top edge at the left rather than inside the paper, which is what
   * ui-kit.css:104 already does in the game. The portrait takes the left of the
   * paper and is bottom-anchored, because a person stands on the bottom of their
   * box. The advance cue is on the bottom-right corner, which is the one cell a
   * nine-slice never stretches, so it stays the same size at every box width.
   */
  dialogue_box: (m) => {
    const i = m.in
    const plaqueW = Math.round(m.w * 0.34)
    const plaqueH = Math.max(18, m.slice.top)
    const port = Math.min(Math.round(i.h * 0.9), Math.round(i.w * 0.3))
    const cue = Math.max(14, Math.round(Math.min(m.slice.bottom, m.slice.right) * 0.8))
    const caret = Math.max(8, Math.round(i.h * 0.12))
    const bodyX = i.x + port + 10
    return [
      R('plaque_hang', 'picture', i.x, 0, plaqueW, plaqueH, { valign: 'top', fit: 'contain' }),
      R('emote', 'picture', i.x + plaqueW - plaqueH, 0, plaqueH, plaqueH, { valign: 'middle', fit: 'contain' }),
      R('portrait', 'picture', i.x, i.y + i.h - port, port, port, { valign: 'bottom', fit: 'contain' }),
      R('body', 'text', bodyX, i.y, i.x + i.w - bodyX - caret - 4, i.h - caret, { wrap: 'wrap', overflow: 'grow' }),
      R('caret', 'picture', i.x + i.w - caret, i.y + i.h - caret, caret, caret, { valign: 'bottom', fit: 'none' }),
      R('advance_cue', 'picture', m.w - cue - 2, m.h - cue - 2, cue, cue, { valign: 'bottom', fit: 'none' }),
    ]
  },

  // a place name over a line about it, and nothing else: a band is not a person
  // talking, so it carries no speaker furniture at all
  band: (m) => {
    const i = m.in
    const title = Math.round(i.h * 0.58)
    return [R('title', 'text', i.x, i.y, i.w, title), R('subtitle', 'text', i.x, i.y + title, i.w, i.h - title)]
  },

  /* THE TYPED LINE, THE UNIT BESIDE IT, AND THE ERROR UNDER IT. The error line
   * lives inside the well rather than under the picture, because a region has to
   * be inside the picture it is measured against and there is nothing under this
   * one but the frame. */
  field: (m) => {
    const i = m.in
    const err = Math.max(12, Math.round(i.h * 0.26))
    const unit = Math.round(i.w * 0.2)
    return [
      R('typed', 'text', i.x, i.y, i.w - unit - 4, i.h - err - 4, { wrap: 'nowrap', overflow: 'clip' }),
      R('unit', 'text', i.x + i.w - unit, i.y, unit, i.h - err - 4),
      R('error', 'text', i.x, i.y + i.h - err, i.w, err, { wrap: 'wrap', overflow: 'clip' }),
    ]
  },

  // what goes here, said under the empty face rather than across it, so the
  // thing that lands in the socket does not land on the words
  socket: (m) => {
    const i = m.in
    const cap = Math.max(12, Math.round(i.h * 0.34))
    return [R('caption', 'text', i.x, i.y + i.h - cap, i.w, cap, { wrap: 'wrap', overflow: 'clip' })]
  },

  /* THE CHANNEL IS THE FILL AND THE READING SITS ON IT. Those two overlap and it
   * is meant: the drive bar carries its remaining yards printed on the bar that
   * measures them, which is the case checkUi's overlap warning names out loud. */
  gauge: (m) => {
    const i = m.in
    const read = Math.min(Math.round(i.w * 0.22), 120)
    return [
      R('fill_unit', 'fill', i.x, i.y, i.w, i.h, { axis: 'right', mode: 'tile' }),
      R('reading', 'number', i.x + (i.w - read) / 2, i.y, read, i.h),
    ]
  },

  /* ONE ENTRY'S WORTH OF RAIL, AND THE RUN IT REPEATS DOWN. The pitch is square
   * on the rail's short side, because an entry on this rail is a token and a
   * spine rather than a row of text, and the run is the whole middle because
   * that is the part that grows as entries arrive. */
  rail: (m) => {
    const i = m.in
    const pitch = Math.min(i.w, Math.round(i.h / 3))
    return [
      R('entry_pitch', 'picture', i.x, i.y, i.w, pitch, { valign: 'middle', fit: 'contain' }),
      R('mounts', 'picture', i.x, i.y, i.w, i.h, { valign: 'top', fit: 'none' }),
    ]
  },

  // the label takes the whole face and the press area is the whole tab, frame
  // included: a tab that only answers a click on its paper is a tab with a dead
  // border, and input parity is the most load-bearing rule in the kit
  tab: (m) => {
    const i = m.in
    return [R('label', 'text', i.x, i.y, i.w, i.h, { wrap: 'nowrap', overflow: 'ellipsis' }), R('press', 'press', 0, 0, m.w, m.h)]
  },

  // the key cap is drawn on the plank at the left end so a keyboard player can
  // see the number rather than guess it, and the label takes what is left
  plank: (m) => {
    const i = m.in
    const cap = Math.min(Math.round(i.h * 0.7), Math.round(i.w * 0.14))
    return [
      R('key_cap', 'text', i.x + 4, i.y + (i.h - cap) / 2, cap, cap),
      R('label', 'text', i.x + cap + 10, i.y, i.w - cap - 14, i.h, { wrap: 'wrap', overflow: 'grow' }),
      R('press', 'press', 0, 0, m.w, m.h),
    ]
  },

  /* THE APERTURE IS THE WHOLE MIDDLE AND THE CAPTION IS ON THE MOUNT. Bottom
   * anchored, because the shipped portrait in the game is object-position:
   * bottom center for a reason: a person stands on the bottom of their box and a
   * frame that centres them leaves every character floating. */
  portrait_frame: (m) => {
    const i = m.in
    const cap = Math.max(10, m.slice.bottom - 6)
    return [
      R('picture', 'picture', i.x, i.y, i.w, i.h, { valign: 'bottom', fit: 'contain' }),
      R('caption', 'text', i.x, m.h - cap - 2, i.w, cap, { wrap: 'nowrap', overflow: 'ellipsis' }),
    ]
  },

  // it is a ring. Its middle is the map, and a rectangle marked on it would be a
  // place the engine draws over Ash's art.
  highlight_edge: () => [],

  /* A COVER PLATE IS NOT MEASURED THE WAY THE GROUNDS ARE, because it has no
   * frame and no plain middle: it is one full-bleed painting. A title band
   * across the upper middle, the fact under it and the loading bar low is the
   * composition 10.4 describes.
   *
   * AND THE PICTURE ON THE SHELF IS NOT ONE PAINTING. It came back as a kit of
   * eleven loose plates, which the crop never caught because only a ground is
   * cropped to its hero. So the wells are laid on the largest plate in that kit,
   * measured, rather than stretched across the whole canvas over four unrelated
   * plates, and the piece is reported as owing a redraw. */
  cover_plate: (m) => {
    const inner = m.in || { x: Math.round(m.w * 0.06), y: Math.round(m.h * 0.06), w: Math.round(m.w * 0.88), h: Math.round(m.h * 0.88) }
    const title = Math.round(inner.h * 0.24)
    const bar = Math.max(12, Math.round(inner.h * 0.1))
    const fact = Math.round(inner.h * 0.28)
    return [
      R('title', 'text', inner.x, inner.y + Math.round(inner.h * 0.1), inner.w, title, { wrap: 'nowrap', overflow: 'ellipsis' }),
      R('fact', 'text', inner.x, inner.y + inner.h - fact - bar - 8, inner.w, fact, { wrap: 'wrap', overflow: 'clip' }),
      R('gauge_track', 'fill', inner.x, inner.y + inner.h - bar, inner.w, bar, { axis: 'right', mode: 'tile' }),
    ]
  },
}

// ---- run --------------------------------------------------------------------

const owner = await one('select id from users order by created_at limit 1')
if (!owner) throw new Error('no account to read a shelf from')

const rows = await many(
  `select name, type, w, h, blob_key, regions, slices from ui_assets where owner_id = $1 and status = 'ready' order by name`,
  [owner.id],
)

let bad = 0
console.log(`${rows.length} pieces on the shelf\n`)
console.log('piece            size        top right bottom left   regions')

for (const r of rows) {
  if (only && r.name !== only) continue
  const t = pieceType(r.type)
  if (!t) {
    console.log(`${r.name.padEnd(16)} no type, so nothing here knows what it owes`)
    continue
  }
  const im = decodePNG(await store().get(r.blob_key))
  if (im.w !== r.w || im.h !== r.h) {
    console.log(`${r.name.padEnd(16)} the row says ${r.w}x${r.h} and the png is ${im.w}x${im.h}`)
    bad++
    continue
  }

  let slices
  let note = ''
  let m = { w: im.w, h: im.h, in: null, slice: null }
  if (t.tier === 'ground') {
    const got = measure(im)
    if (!got) {
      console.log(`${r.name.padEnd(16)} ${`${im.w}x${im.h}`.padEnd(11)} no plain middle at the centre of the picture, so it cannot be nine-sliced`)
      bad++
      continue
    }
    m = { w: im.w, h: im.h, in: { x: got.slice.left, y: got.slice.top, w: im.w - got.slice.left - got.slice.right, h: im.h - got.slice.top - got.slice.bottom }, slice: got.slice }
    if (got.rails.length) note = `  ornament runs along the ${got.rails.join(' and ')} rail, so that edge repeats`
    const grew = ['top', 'right', 'bottom', 'left'].filter((k) => got.slice[k] !== got.inner[k])
    if (grew.length) note += `  ${grew.map((k) => `${k} ${got.inner[k]}->${got.slice[k]} for the corner`).join(', ')}`
    slices = { slice: got.slice, scale: 1, fill: t.fill, repeat: { x: 'round', y: 'round' } }
    const { problems } = checkSlices(slices, im.w, im.h, t)
    if (problems.length) {
      console.log(`${r.name.padEnd(16)} ${problems[0]}`)
      bad++
      continue
    }
  } else {
    /* A SHEET AND A PAINTING TAKE NO EDGE NUMBERS, and saveUi refuses them:
     * four insets on something that never stretches is a field nothing will
     * ever read, which is the half-plumbed shape this project keeps
     * rediscovering. */
    slices = {}
    /* A PAINTING STILL NEEDS SOMEWHERE LEGIBLE TO PRINT A TITLE, and on a
     * painting that is the largest thing drawn on it. Measured with the same
     * scan the crop uses, so a cover that came back as a kit of loose plates has
     * its wells laid on one plate rather than stretched across four of them. */
    if (t.tier === 'painted') {
      const big = opaqueRegions(im.w, im.h, im.data)[0]
      if (big) {
        const share = (big.w * big.h) / (im.w * im.h)
        const pad = Math.round(Math.min(big.w, big.h) * 0.1)
        m.in = { x: big.x + pad, y: big.y + pad, w: big.w - pad * 2, h: big.h - pad * 2 }
        if (share < 0.6)
          note = `  the picture is ${opaqueRegions(im.w, im.h, im.data).length} loose plates rather than one painting, so the wells are on the largest of them and this piece owes a redraw`
      }
    }
  }

  const lay = LAYOUT[r.name] || LAYOUT[t.name]
  const cut = (r.regions || []).filter((s) => s.kind === 'face')
  const marks = lay ? [...cut, ...lay(m)] : cut
  const four = m.slice ? `${m.slice.top} ${m.slice.right} ${m.slice.bottom} ${m.slice.left}` : '- - - -'
  console.log(`${r.name.padEnd(16)} ${`${im.w}x${im.h}`.padEnd(11)} ${four.padEnd(22)} ${marks.map((s) => s.name).join(' ') || '(none)'}`)
  if (note) console.log(`                ${note}`)

  if (!write) continue
  try {
    const saved = await saveUi(owner.id, r.name, marks, t.tier === 'ground' ? slices : undefined)
    for (const w of saved.warnings) console.log(`                 warn  ${w}`)
    if (publish) await publishUi(owner.id, r.name)
  } catch (e) {
    console.log(`                 FAIL  ${e.message}`)
    bad++
  }
}

console.log(bad ? `\n${bad} piece(s) could not be measured` : write ? '\nsaved' : '\nnothing written, run with --write')
await closeDb()
