// The assets shown as a reference on the levels step: faint, still, and untouchable.

//   node server/db/verify-ghost.mjs

// What is walkable is decided by where the things on the map stand, and the levels step draws the
// bare painting, so the floor around a well was being traced from memory. The art comes up faint
// there now. Two properties carry the whole feature and both are easy to lose later:
//
//   it must not be editable, because the pointer on that step belongs to the mask, and
//   it must not animate, because the repaint loop does not run itself for a step that does not own
//   the placements, so a moving reference jumps on every brush stroke.
//
// Read off the source rather than a browser, because the thing being checked is which branch owns
// which behaviour, and that is a property of the code and not of one frame.
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
const ed = read('src/core/editor.ts')
const app = read('src/App.tsx')

/* the region of drawAssets, so a claim about the loop is about that loop */
const draw = ed.slice(ed.indexOf('  private drawAssets('), ed.indexOf('  private drawTransformBox('))

// ---- it draws, and only where the step does not already own the art --------

{
  ed.includes('else if (this.assetGhost) this.drawAssets(g, z, true)')
    ? ok('the reference pass runs, and as an else, so the assets step never draws them twice')
    : no('the reference pass is not wired into the draw')

  draw.includes('private drawAssets(g: CanvasRenderingContext2D, z: number, faint = false)')
    ? ok('and it is the same function, told to be faint, rather than a second copy that can drift')
    : no('drawAssets does not take a faint pass')
}

// ---- IT CANNOT BE EDITED ---------------------------------------------------
// Everything that picks, drags, places or crops a placement is gated on
// assetMode. The reference flag is deliberately NOT that flag, so if any of
// those gates ever starts reading assetGhost the art becomes editable on a step
// whose pointer belongs to the mask, and a stroke would move a barrel instead.

{
  const gates = ed.split(/\r?\n/).filter((l) => l.includes('assetGhost'))
  const declares = gates.filter((l) => /assetGhost = |assetGhost: |assetGhost = !|this\.assetGhost$/.test(l.trim()))
  gates.length > 0 ? ok(`the reference flag is named in ${gates.length} places`) : no('assetGhost does not exist')

  /* the only places it may be read are the draw, the toggle, the status and its own declaration.
   * A read anywhere else is what would make it editable. */
  const bad2 = gates.filter(
    (l) =>
      !/^\s*(\/\/|\*|\/\*)/.test(l) &&
      !l.includes('assetGhost = false') &&
      !l.includes('assetGhost: boolean') &&
      !l.includes('assetGhost: this.assetGhost') &&
      !l.includes('this.assetGhost = !this.assetGhost') &&
      !l.includes('return this.assetGhost') &&
      !l.includes('else if (this.assetGhost) this.drawAssets'),
  )
  bad2.length === 0
    ? ok('and it is read only by the draw, the toggle and the status, so no gesture can reach a placement through it')
    : no(`it is read somewhere that could act on a placement: ${bad2.map((l) => l.trim()).join(' | ')}`)
  void declares

  /* and the real gates still say assetMode, which is what actually keeps the pointer on the mask */
  const picks = ed.split(/\r?\n/).filter((l) => l.includes('if (this.assetMode)')).length
  picks >= 3
    ? ok(`the ${picks} pointer gates still read assetMode, which the levels step leaves off`)
    : no('the pointer gates no longer read assetMode, so what keeps this uneditable is unclear')
}

// ---- AND IT HOLDS STILL ----------------------------------------------------

{
  draw.includes('const movers = faint ? [] : this.doc.assets.filter')
    ? ok('nothing travels in a faint pass, so a walker cannot jump between brush strokes')
    : no('the faint pass still resolves movers, so the reference moves while the floor is painted')

  draw.includes('this.assetFrame(a, faint ? 0 : now')
    ? ok('and nothing cycles, so a breathing figure is drawn on the frame it was drawn from')
    : no('the faint pass still animates its frames')

  /* the repaint loop is what makes the difference matter, and it is gated on the OTHER flag: if it
   * ever starts running for the reference pass, the frozen frame becomes a stutter instead */
  ed.includes('      this.assetMode &&') ? ok('and the repaint loop still belongs to the assets step alone') : no('the repaint gate moved')
}

// ---- the alpha, which is the whole of "translucent" ------------------------
// Every alpha in the loop is absolute, so one globalAlpha set around the call
// would be wiped by the first placement that fades or rides ghosted. The base
// has to be multiplied through instead.

{
  draw.includes('const base = faint ? 0.38 : 1') ? ok('the faint pass has one base alpha') : no('no base alpha')
  /* ONLY THE PART A FAINT PASS ACTUALLY RUNS, which is the sprite loop up to where it returns. Past
   * that sits the placing preview, whose own alpha is absolute and correctly so: it is the ghost under
   * the cursor on the assets step, and a faint pass never reaches it. Scanning the whole function
   * reported those two as faults when the code was right. */
  const ran = draw.slice(0, draw.indexOf('    if (faint) {'))
  const absolutes = ran.split(/\r?\n/).filter((l) => /globalAlpha = (0\.\d+|1)(\s|$)/.test(l) && !l.includes('base'))
  absolutes.length === 0
    ? ok('and every alpha in the loop is multiplied through it, so a fading behaviour and a faint pass both hold')
    : no(`${absolutes.length} alpha(s) are still absolute and would wipe the base: ${absolutes.map((l) => l.trim()).join(' | ')}`)
  draw.includes('if (faint) {') && draw.includes('      g.globalAlpha = 1') ? ok('and the canvas is handed back opaque') : no('the faint pass leaks its alpha')
}

// ---- no chrome, because none of it can be acted on from here ---------------

{
  const chromeAt = draw.indexOf('const picked = this.selAssets()')
  const returnAt = draw.indexOf('if (faint) {')
  chromeAt > 0 && returnAt > 0 && returnAt < chromeAt
    ? ok('a faint pass returns before the selection box, the handles and the group frame')
    : no('the faint pass draws selection chrome that nothing on this step can grab')
}

// ---- and the author can reach it ------------------------------------------

{
  app.includes("label=\"show the assets\"") ? ok('the levels panel offers it') : no('there is no toggle in the levels panel')
  app.includes('ed?.toggleAssetGhost()') ? ok('and it is wired to the toggle') : no('the button calls nothing')
  app.includes("icon={st?.assetGhost ? 'eye' : 'eyeoff'}") ? ok('and the icon says which way it is') : no('the toggle does not show its state')
  /* it is a toggle and not a tool: picking it must not disarm the brush the author is painting with */
  !app.includes("setTool('ghost')") ? ok('and it is not a tool, so the brush in hand survives pressing it') : no('the toggle takes the tool')
}

console.log(bad ? `\n${bad} problem(s).` : '\nthe art can be seen while the floor is painted, and it cannot be touched or moved.')
process.exit(bad ? 1 : 0)
