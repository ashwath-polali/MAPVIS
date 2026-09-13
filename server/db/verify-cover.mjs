// The transition screen a map is entered through: what is asked for, and what ships with the map.

//   node server/db/verify-cover.mjs

// A cover belongs to a MAP. The game already picks a cover by where the player is going, so one
// published inside a map's bundle is shown on every door and every sail into it with no python
// naming anything. A map may also carry extras that enter(map, cover="<name>") calls.
//
// Nothing is bought to prove any of this. The thing worth being sure about is the sentence the
// router writes, because the author never says how a cover should look: they say what it SHOWS, and
// everything else is assembled on the server out of their style card and the cover scaffold. So the
// prompt is printed here in full and read back clause by clause.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverPrompt, isCoverName, COVER_SCAFFOLD, HOUSE_CARD, AREA_CEILING, fitCanvas, mapPrompt } from '../store/style.mjs'
import { keys } from '../store/blobs.mjs'

let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// ---- THE PROMPT, SHOWN ------------------------------------------------------

const ASK = 'the ATC lab at dusk, the harbor below'
const built = coverPrompt({ subject: ASK, card: HOUSE_CARD })

console.log('\n  what the author typed:')
console.log(`    ${ASK}`)
console.log('\n  what the router sends:')
for (const p of built.parts) console.log(`    [${p.name}] ${p.text}`)
console.log('')

{
  built.parts.map((p) => p.name).join(',') === 'subject,structure,light,colour,hand,edge'
    ? ok('the sentence is the subject, the shape, the light, the colour, the hand, then the fence')
    : no(`the parts are ${built.parts.map((p) => p.name).join(',')}`)

  built.prompt.startsWith(ASK)
    ? ok('and the author leads it, because theirs is the only part they wrote')
    : no('the typed words are not first')

  /* THE ONE HARD RULE. The game writes the place name on its own plaque over this picture, so words
   * painted into it land under words drawn on top of them and the cover is unusable. */
  const noWords = ['no text', 'no title', 'no lettering', 'no words', 'no logo']
  const missing = noWords.filter((w) => !built.prompt.includes(w))
  missing.length === 0
    ? ok('every way of saying "carry no words" is in it, which is the one rule a cover cannot bend')
    : no(`the no-words rule is thin: missing ${missing.join(', ')}`)
  built.prompt.lastIndexOf('no text') > built.prompt.indexOf('craft') || built.prompt.includes('no border, no frame')
    ? ok('and it is said last as well, where a generator is least likely to have dropped it')
    : no('the fence is not repeated at the end')

  /* THE CARD'S MAP CLAUSE IS DELIBERATELY NOT HERE, and this is the check that says so on purpose
   * rather than by omission. A style card is read off a MAP, so its clause names an isometric
   * projection and a desaturated muted palette. Held against the four covers the game already ships
   * (public/art/ui/loading-port, -islands, -maw, -voyage), that contradicts every one of them twice:
   * all four look ACROSS a scene from eye level, and all four are saturated. A cover built with the
   * map clause would come back looking like a map. */
  !built.prompt.includes('isometric')
    ? ok('a cover is never asked for a map projection, because not one shipped cover has one')
    : no('the cover asks for isometric, which no cover the game ships is')
  !built.prompt.includes('desaturated') && built.prompt.includes('rich saturated colour')
    ? ok('and it asks for saturated colour, because a map is flat so placements read on it and nothing is placed on a cover')
    : no('the cover asks for a map palette')
  built.prompt.includes(HOUSE_CARD.craft.outline)
    ? ok('what does carry across from the card is the outline, which is what makes two pictures one hand')
    : no('the account hand is absent entirely')

  /* the author is never asked for a look, so nothing describing one may come from them */
  const bare = coverPrompt({ subject: ASK, card: null })
  !bare.prompt.includes(HOUSE_CARD.craft.outline) && bare.parts.map((p) => p.name).join(',') === 'subject,structure,light,colour,edge'
    ? ok('with no card the hand is simply absent rather than invented')
    : no(`a hand appeared with no card: ${bare.parts.map((p) => p.name).join(',')}`)

  /* MEASURED, not asserted. One cover was drawn through this route on 2026-09-13 with no card and no
   * style reference at all, and it came back a dusk harbour looking across the water at a low sun,
   * foreground in shadow, three depth planes, no lettering. So the scaffold carries the look on its
   * own and the card is an improvement on it rather than the thing holding it up. */
  built.prompt.includes('looking across') && built.prompt.includes('eye level')
    ? ok('the viewpoint is said in words, which is what a style image cannot carry')
    : no('the cover does not say where it is seen from')
  built.prompt.includes('one strong light source inside the frame')
    ? ok('and the light is in the frame, which is what every shipped cover has and no map does')
    : no('the cover asks for no light source')

  coverPrompt({ subject: '   ', card: HOUSE_CARD }).prompt === ''
    ? ok('and nothing typed asks for nothing, so an empty press cannot spend')
    : no('an empty subject still built a prompt')
}

// ---- the canvas -------------------------------------------------------------

{
  const box = fitCanvas(built.canvas)
  box.w === 688 && box.h === 384 ? ok('a cover is 688x384, the widest frame the game shows one in') : no(`the canvas is ${box.w}x${box.h}`)
  box.w * box.h <= AREA_CEILING
    ? ok(`and ${box.w * box.h} pixels sits under the ${AREA_CEILING} ceiling, so it is one generation`)
    : no(`${box.w * box.h} is over the ceiling`)
  box.w % 2 === 0 && box.h % 2 === 0 ? ok('with both sides even, which the endpoint refuses without') : no('a side is odd')
}

// ---- a cover is not a map ---------------------------------------------------
// The map scaffolds describe something to be WALKED on: transparent surrounds, a
// readable floor, a shoreline the cut can find. None of that belongs on a picture
// that is looked at for two seconds, and putting the cover in SCAFFOLDS would also
// let kindOf guess it off the word "cover" in somebody's subject.

{
  const island = mapPrompt({ subject: 'a small island', card: HOUSE_CARD })
  island.kind === 'island' ? ok('a map still reads its kind off the words, untouched') : no(`a map subject now reads as ${island.kind}`)
  const covery = mapPrompt({ subject: 'the cover of the lab', card: HOUSE_CARD })
  covery.kind !== 'cover' ? ok('and the word "cover" in a map subject is not a map kind') : no('cover leaked into the map kinds')
  /* both say the word and they say OPPOSITE things with it, which is the distinction worth checking
   * rather than the word: an island is surrounded by transparency because the engine draws its ocean
   * under the coast, and a cover is a full screen with none. */
  const isle = mapPrompt({ subject: 'a small island', card: HOUSE_CARD }).prompt
  isle.includes('surrounded by fully transparent') && built.prompt.includes('no transparent space')
    ? ok('a map asks to be surrounded by transparency and a cover asks for none, which is the difference')
    : no('the cover and the map no longer disagree about transparency')
  !built.prompt.includes('walkable') && !built.prompt.includes('shoreline')
    ? ok('and a cover is never asked to be walkable or to own a shoreline, being a picture and not a floor')
    : no('the cover carries a map instruction')
  COVER_SCAFFOLD.structure.includes('corner to corner') ? ok('and it fills the frame, because a cover is the whole screen') : no('the cover does not fill its frame')
}

// ---- the code name ----------------------------------------------------------

{
  isCoverName('atc_lab') && isCoverName('a') ? ok('a code name is a python identifier, the rule an anchor already follows') : no('a good name was refused')
  !isCoverName('ATC') && !isCoverName('1lab') && !isCoverName('') && !isCoverName('a-b')
    ? ok('and a capital, a leading digit, a dash and nothing at all are all refused')
    : no('a bad name was accepted')
}

// ---- where the bytes go -----------------------------------------------------

{
  keys.cover('M1') === 'maps/M1/cover.png' ? ok("the map's own cover is one file beside its masks") : no(`the key is ${keys.cover('M1')}`)
  keys.coverNamed('M1', 'lab') === 'maps/M1/covers/lab.png' ? ok('and an extra sits under its code name') : no(`the named key is ${keys.coverNamed('M1', 'lab')}`)

  /* THE BUNDLE IS THE CONTRACT. The game's vendor step copies whatever the manifest lists, nested
   * paths included, so a cover reaching the player needs nothing on the game side to know these two
   * names in advance. */
  const api = read('server/api.mjs')
  api.includes("'cover.png': coverPng") ? ok('the export ships the default cover in the bundle') : no('the bundle carries no cover')
  api.includes('`covers/${n}.png`') ? ok('and every extra under covers/, which is the path the python name resolves against') : no('extras do not ship')
  api.includes('{ cover: true }') && api.includes('{ covers: extraNames }')
    ? ok('and map.json says so, so a reader can ask without fetching a png to find out')
    : no('map.json does not declare them')

  /* a cover is only ever written on a press, and only a press that came back */
  api.includes("if (!typed) return send(res, 400, { error: 'say what the screen should show' })")
    ? ok('nothing is generated without words to generate from')
    : no('the cover route can spend on an empty ask')
}

// ---- and the author sees the game's frame -----------------------------------

{
  /* ITS OWN EDITOR, linked to a map by a dropdown. It was a seventh step of the map editor first, and
   * that was the wrong shelf: a cover is a kind of thing rather than a stage of finishing a map, and
   * the page a person goes to when they want to make one is /ui. Ruled by Ash 2026-09-13. */
  const cov = read('src/site/Covers.tsx')
  cov.includes("const KICKER = 'E N T E R I N G'") ? ok("the preview says the game's own word over the picture") : no('the preview has no kicker')
  cov.includes('cvr-band') && cov.includes('title.toUpperCase()')
    ? ok('and draws the title band over it, so a cover is judged with the title where the title lands')
    : no('the preview is a bare picture')
  /* THE MAP IS PICKED BY ITS PAINTING. It was a dropdown of slugs, and a dropdown is the one control
   * that makes a visual tool feel like a form: you choose the island by looking at it. */
  cov.includes('cvr-map-art') && cov.includes('shot(m)')
    ? ok('and the map it belongs to is picked by its painting rather than off a list of slugs')
    : no('there is no way to say which map it is for')
  cov.includes('cvr-dot')
    ? ok('with the ones already carrying a cover marked, so finding out does not cost ten clicks')
    : no('nothing says which maps already carry a cover')
  /* a reply for a map nobody is looking at any more must not land on the panel */
  cov.includes('if (!dead) setHas(c)')
    ? ok('and a stale answer cannot overwrite the current one, so the panel cannot contradict the strip')
    : no('a slow reply for the previous map can still overwrite the current one')

  const app = read('src/App.tsx')
  !app.includes("{ id: 'cover'") && !app.includes('coverPanel')
    ? ok('and the map editor no longer carries a cover step, so there is one place to find it')
    : no('the cover is still a step of the map editor as well')

  /* the chooser, which is what the page was missing: it opened straight into the twenty-one game
   * pieces, so the only thing it could make was the one thing it showed */
  const ui = read('src/site/Ui.tsx')
  ui.includes("const GROUPS:") && ui.includes("id: 'covers'") && ui.includes("id: 'pieces'")
    ? ok('/ui asks what you are making first, and transition screens is one of the answers')
    : no('/ui still opens straight into the game pieces')
  ui.includes('GROUPS.map') ? ok('and the groups are a list, so a third is a row rather than a redesign') : no('the groups are hardcoded into the markup')

  const css = read('src/site/covers.css')
  css.includes('.cvr-pic') && css.includes('aspect-ratio: 688 / 384')
    ? ok('shown at the shape it ships at, so nothing is judged in the wrong frame')
    : no('the preview is not the bundle shape')
  css.includes('container-type: inline-size')
    ? ok('and the title scales with the frame rather than the window, the way it will in the game')
    : no('the preview type does not scale with its frame')
}

console.log(bad ? `\n${bad} problem(s).` : '\na map carries the screen it is entered through, and the author only ever says what it shows.')
process.exit(bad ? 1 : 0)
