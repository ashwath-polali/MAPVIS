// Which of two overlapping things is drawn in front, and what it costs the one that moves.

//   node server/db/verify-order.mjs

// Nothing bought, no database, no browser. The whole of this feature is arithmetic and a contract:
// an author presses move forward, the thing they picked draws over what it covers, and it is still
// standing exactly where they put it.
//
// The old version of the button moved the placement DOWN THE MAP to get it in front, because the
// draw order is where a thing stands and there was nothing else to change. That is right on screen
// and wrong about the world: a barrel does not slide two feet south in order to sit over a puddle.
// So there is a nudge now, added to the sort key and never to the position, and it has to mean the
// same thing on all five surfaces that draw a map: the editor, the three previews on the site, and
// the game. Those five are checked against each other at the end, by reading them.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* the rules themselves, cut out of the editor and run. They are pure and import nothing, which is
 * why they were pulled up out of the class in the first place. */
const ts = (await import('typescript')).default
const src = read('src/core/editor.ts')
const cut = src.slice(src.indexOf('export function boxesOverlap'), src.indexOf('export class Editor'))
const js = ts.transpileModule(cut, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { boxesOverlap, orderDelta, assetDepth } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
)

// ---- depth is where it stands, until somebody says otherwise ----------------

{
  assetDepth({ y: 400 }) === 400 ? ok('a placement nobody reordered sorts on exactly its own y') : no('a plain placement moved')
  assetDepth({ y: 400, z: 0 }) === 400 ? ok('and a nudge of nothing is nothing') : no('a zero nudge changed the depth')
  assetDepth({ y: 400, z: 12 }) === 412 ? ok('a nudge forward sorts it later, so it draws over what it covers') : no('a forward nudge did not sort later')
  assetDepth({ y: 400, z: -12 }) === 388 ? ok('and back sorts it earlier') : no('a back nudge did not sort earlier')
  /* every bundle published before this existed carries no z at all, and a reader that treats a
   * missing field as anything but zero would redraw every map that already shipped */
  assetDepth({ y: 400, z: undefined }) === 400 && assetDepth({ y: 400, z: NaN }) === 400
    ? ok('and a missing or unreadable nudge is zero, so no map published before this redraws')
    : no('an absent nudge was not read as zero')
}

// ---- the step clears what is in the way, once --------------------------------

{
  /* the reported case: one thing covers another and the author wants the other one on top */
  orderDelta('front', [400], [420]) === 21
    ? ok('forward lands one past the thing it is behind, so a single press clears it')
    : no(`forward gave ${orderDelta('front', [400], [420])}, expected 21`)
  orderDelta('back', [420], [400]) === -21
    ? ok('and back lands one before it')
    : no(`back gave ${orderDelta('back', [420], [400])}, expected -21`)

  /* ALREADY CLEAR IS NOT A NUDGE OF ZERO, IT IS NO NUDGE. A press that keeps adding to a bias
   * doing nothing is how a placement ends up sorting a thousand deep, and then dragging it two
   * pixels never changes anything again because y is buried under the bias. */
  orderDelta('front', [500], [400]) === null ? ok('a thing already in front of what it covers is left alone') : no('an already-front press still wrote a nudge')
  orderDelta('back', [300], [400]) === null ? ok('and so is one already behind') : no('an already-back press still wrote a nudge')

  /* pressing forward twice must not keep climbing: the second press sees the first one's answer */
  const first = orderDelta('front', [400], [420])
  orderDelta('front', [400 + first], [420]) === null
    ? ok('so pressing forward twice does nothing the second time')
    : no('forward kept inflating on a second press')

  /* many at once move as one, and the far edge of the group is what has to clear */
  orderDelta('front', [380, 400, 410], [420]) === 11
    ? ok('a group is measured on the one nearest the front, so the whole group clears together')
    : no(`a group gave ${orderDelta('front', [380, 400, 410], [420])}, expected 11`)
  orderDelta('back', [380, 400, 410], [370]) === -11
    ? ok('and on the one nearest the back going the other way')
    : no(`a group going back gave ${orderDelta('back', [380, 400, 410], [370])}, expected -11`)

  /* the far end of a crowd, not the near one: clearing the nearest and staying under three others
   * is the press reading as broken */
  orderDelta('front', [400], [405, 420, 412]) === 21 ? ok('and it clears the furthest forward of a crowd, not the nearest') : no('forward cleared only the nearest')

  /* nothing to be in front of is not an error and not a nudge */
  orderDelta('front', [400], []) === null && orderDelta('front', [], [400]) === null
    ? ok('with nothing overlapping, there is nothing to be in front of and nothing is written')
    : no('an empty side produced a nudge')

  /* an exact tie is the case the whole feature exists for: two things at the same depth draw in
   * whatever order the list happens to hold, which is the bug an author is looking at */
  orderDelta('front', [400], [400]) === 1 && orderDelta('back', [400], [400]) === -1
    ? ok('two things at the same depth are separated by one either way, which is the tie it exists for')
    : no('a tie was not separated')
}

// ---- overlap, because ordering two things that never touch is noise ---------

{
  const A = { x0: 0, x1: 10, y0: 0, y1: 10 }
  boxesOverlap(A, { x0: 5, x1: 15, y0: 5, y1: 15 }) ? ok('two boxes sharing pixels overlap') : no('an overlap was missed')
  !boxesOverlap(A, { x0: 20, x1: 30, y0: 0, y1: 10 }) ? ok('and two side by side do not') : no('separate boxes overlapped')
  /* TOUCHING EDGES DO NOT COUNT. Two barrels standing flush are not covering each other, and
   * offering to reorder them is offering a press that changes no pixels. */
  !boxesOverlap(A, { x0: 10, x1: 20, y0: 0, y1: 10 }) ? ok('and neither do two that only touch along an edge') : no('a shared edge counted as covering')
  !boxesOverlap(A, { x0: 0, x1: 10, y0: 10, y1: 20 }) ? ok('above or below, the same') : no('a shared horizontal edge counted as covering')
  boxesOverlap(A, { x0: 2, x1: 4, y0: 2, y1: 4 }) ? ok('and one wholly inside the other overlaps') : no('a contained box did not overlap')
  /* the test has to be symmetric or which of two things you happened to click would decide whether
   * the button worked */
  const B = { x0: 5, x1: 15, y0: 5, y1: 15 }
  boxesOverlap(A, B) === boxesOverlap(B, A) ? ok('and it answers the same whichever one you clicked') : no('the overlap test is not symmetric')
}

// ---- THE THING THAT MOVES IS NOTHING: the five surfaces, read ---------------

// A nudge is worth nothing if the editor honours it and the game does not, or the other way about:
// the preview would lie about the map, which is the one thing this tool cannot do. So every place a
// depth is written is named here, and a new one appearing is meant to break this.
{
  /* the editor sorts on the rule rather than on y */
  read('src/core/editor.ts').includes('.sort((p, q) => assetDepth(p) - assetDepth(q))')
    ? ok('the editor draws in depth order and not in y order')
    : no('the editor still sorts placements on y alone')

  /* and order() writes the nudge and never the position. A y in there is the old behaviour back. */
  const fn = read('src/core/editor.ts')
  const body = fn.slice(fn.indexOf("  order(dir: 'front' | 'back') {"), fn.indexOf('  orderReset() {'))
  body.includes('a.z = lim') && !body.includes('a.y =')
    ? ok('and move forward writes the nudge and never touches y, so the thing does not move')
    : no('order() is still assigning y, which moves the placement down the map')

  /* the bundle carries it, and leaves it out when it is nothing, so a reader that has never heard
   * of it sees exactly the file it saw before */
  const api = read('server/api.mjs')
  api.includes("? { z: Math.round(Number(a.z)) } : {}")
    ? ok('the bundle carries the nudge, and omits it entirely when there is none')
    : no('assets.json does not publish the nudge')

  /* the three previews on the site. Each sorts its own way, so each is named. */
  for (const f of ['LivingMap', 'Tour']) {
    const s = read(`src/site/${f}.tsx`)
    s.includes('frame.sort((a, b) => a.d - b.d)') && s.includes('zOf(r.p)')
      ? ok(`the ${f} preview sorts on depth, which is a second number beside the drawn y`)
      : no(`${f} still sorts on the y it draws at`)
  }
  {
    const s = read('src/site/Walk.tsx')
    s.includes('y: pts[i].y + zOf(s.v.p)') ? ok('and the walk preview folds it into its sort key') : no('Walk ignores the nudge')
  }

  /* THE GAME, which is the only one that matters to a player. Four sites: a standing placement, an
   * airborne one, one with a behaviour walking it, and one a script has taken over. A y left in any
   * of them is a placement that jumps back behind on the frame it starts moving. */
  const g = read(path.join('..', 'AdventureGame', 'src/game/pmap/PmapScene.tsx'))
  const sites = [
    ['a standing placement', 'sp.zIndex = depthOf(a)'],
    ['an airborne one', 'sp.zIndex = 99000 + (depthOf(a) | 0)'],
    ['one a behaviour is walking', 'q.sp.zIndex = biased(q.sp, q.home.y + at.dy)'],
    ['one a script has taken over', 'sp.zIndex = biased(sp, d.y)'],
  ]
  for (const [what, line] of sites) {
    g.includes(line) ? ok(`the game reads it for ${what}`) : no(`the game ignores the nudge for ${what}`)
  }
  /* and the arithmetic is the same arithmetic. Two readers that disagree by a sign or by a missing
   * field is a map that draws one way in the editor and another in the game. */
  g.includes('return a.y + (Number.isFinite(z) ? z : 0)') && cut.includes('return a.y + (Number.isFinite(z) ? z : 0)')
    ? ok('and reads it with the same arithmetic the editor uses, down to the missing-field case')
    : no('the game and the editor compute depth differently')
}

console.log(bad ? `\n${bad} problem(s).` : '\nmove forward changes what is drawn over what, and moves nothing.')
process.exit(bad ? 1 : 0)
