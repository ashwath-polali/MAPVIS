// the transition screen a map is entered through: a cover belongs to a map, so the one in its bundle is shown on every door and sail into it with no python naming anything, and extras are called by enter(map, cover="<name>"). nothing here is bought, the prompt is printed and read clause by clause.
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

  /* the one hard rule: the game writes the place name on its own plaque over this picture, so words painted into it land under words drawn on top of them and the cover is unusable */
  const noWords = ['no text', 'no title', 'no lettering', 'no words', 'no logo']
  const missing = noWords.filter((w) => !built.prompt.includes(w))
  missing.length === 0
    ? ok('every way of saying "carry no words" is in it, which is the one rule a cover cannot bend')
    : no(`the no-words rule is thin: missing ${missing.join(', ')}`)
  built.prompt.lastIndexOf('no text') > built.prompt.indexOf('craft') || built.prompt.includes('no border, no frame')
    ? ok('and it is said last as well, where a generator is least likely to have dropped it')
    : no('the fence is not repeated at the end')

  /* the card's map clause is deliberately not here: a style card is read off a map, so its clause asks for an isometric projection and a desaturated muted palette, while all four covers the game ships look across a scene at eye level and are saturated, so the map clause returns a cover looking like a map */
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

  /* measured, not asserted: one cover drawn through this route with no card and no style reference came back a dusk harbour across the water at a low sun, foreground in shadow, three depth planes, no lettering, so the scaffold carries the look on its own and the card only improves it */
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

// a cover is not a map: the map scaffolds describe something to be walked on, transparent surrounds and a readable floor and a shoreline the cut can find, none of it right for a picture looked at for two seconds, and putting the cover in SCAFFOLDS would let kindOf guess it off the word cover in a subject

{
  const island = mapPrompt({ subject: 'a small island', card: HOUSE_CARD })
  island.kind === 'island' ? ok('a map still reads its kind off the words, untouched') : no(`a map subject now reads as ${island.kind}`)
  const covery = mapPrompt({ subject: 'the cover of the lab', card: HOUSE_CARD })
  covery.kind !== 'cover' ? ok('and the word "cover" in a map subject is not a map kind') : no('cover leaked into the map kinds')
  /* both say the word and they say opposite things with it, which is the distinction worth checking: an island is surrounded by transparency because the engine draws its ocean under the coast, and a cover is a full screen with none */
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

  /* the bundle is the contract: the game's vendor step copies whatever the manifest lists, nested paths included, so a cover reaching the player needs nothing on the game side to know these two names in advance */
  const api = read('server/api.mjs')
  api.includes("'cover.png': coverPng") ? ok('the export ships the default cover in the bundle') : no('the bundle carries no cover')
  api.includes('`covers/${n}.png`') ? ok('and every extra under covers/, which is the path the python name resolves against') : no('extras do not ship')
  api.includes('{ cover: true }') && api.includes('{ covers: extraNames }')
    ? ok('and map.json says so, so a reader can ask without fetching a png to find out')
    : no('map.json does not declare them')

  /* WHICH COVERS EXIST IS THE STORE'S ANSWER AND NEVER THE FOLDER'S. The folder is a local mirror,
   * and a remove that failed to unlink leaves a picture there the tool says is gone, so reading it
   * first ships a cover the author deleted. A deploy has no writable disk either, so a bundle
   * assembled from the folder alone would carry no cover at all on the one machine that matters. */
  api.includes('const held = platformOn() ? await coversOf(id)') && api.includes("held.covers.filter(isCoverName)")
    ? ok('the store says which covers exist, so a deleted one cannot come back off a stale folder')
    : no('the export reads the list of covers off the local folder')
  api.includes("(await readCover(id).catch(() => null)) || png('cover.png')")
    ? ok('while the folder still supplies bytes, because a deploy has no writable disk and a laptop with no platform has nothing else')
    : no('a cover kept where there is no store cannot reach a bundle')

  /* a cover is only ever written on a press, and only a press that came back */
  api.includes("if (!typed) return send(res, 400, { error: 'say what the screen should show' })")
    ? ok('nothing is generated without words to generate from')
    : no('the cover route can spend on an empty ask')
  // the router tidies before it builds, so a subject of punctuation alone clears the check above and reaches the endpoint as an empty prompt that still costs a generation
  api.includes('if (!built.prompt) return send(res, 400')
    ? ok('and a subject that tidies away to nothing is refused as well, since the router builds after the check')
    : no('a subject of punctuation alone can still buy an empty prompt')

  /* a transition screen and the code names beside it are an account's own work: everything meant to
   * be public is under /api/v1/, and these two routes never were. */
  api.includes('style|cover|covers')
    ? ok('and reading a cover or its code names by slug is checked against the map that owns it')
    : no("another account's cover art is readable by slug")

  // a check nothing runs is not a check, and this one is cheap enough to belong in the pass a fresh clone can run
  const pkg = read('package.json')
  pkg.includes('verify-cover.mjs') && read('.github/workflows/ci.yml').includes('verify:local')
    ? ok('and this check runs on every push, rather than only when somebody remembers it')
    : no('verify-cover is not in the pass the runner runs')

  /* what it was asked for and whose hand drew it, kept beside the picture because a png says neither: the sentence answers what was typed to get that, and the hand is the only way a file that has left the platform can be shown to be the same hand as the rest */
  keys.coverNotes('M1') === 'maps/M1/covers.json' ? ok('the record sits beside the pictures') : no(`the record key is ${keys.coverNotes('M1')}`)
  !keys.coverNotes('M1').startsWith(keys.coversPrefix('M1'))
    ? ok('and outside the covers/ prefix, so listing the extras never returns it as one')
    : no('the record would be listed as a cover')
  api.includes("'covers.json': notesJson") ? ok('and it ships in the bundle as its own file') : no('the record does not ship')
  api.includes('notes.cover = note') && api.includes('notes.named[name] = note')
    ? ok('with one entry for the map’s own and one per code name')
    : no('the record does not separate the default from the extras')
  api.includes("...(notesJson ? { 'covers.json': notesJson } : {})") && !api.includes('coverNotes: notes')
    ? ok("while map.json's own shape does not change, so nothing on the game side has to learn a new field")
    : no('map.json grew a field for this')
}

// ---- and the author sees the game's frame -----------------------------------

{
  /* its own editor, linked to a map by a dropdown: a cover is a kind of thing rather than a stage of finishing a map, so it is not a seventh step of the map editor and the page for making one is /ui */
  const cov = read('src/site/Covers.tsx')
  cov.includes("const KICKER = 'E N T E R I N G'") ? ok("the preview says the game's own word over the picture") : no('the preview has no kicker')
  cov.includes('cvr-band') && cov.includes('title.toUpperCase()')
    ? ok('and draws the title band over it, so a cover is judged with the title where the title lands')
    : no('the preview is a bare picture')
  /* the map is picked by its painting, because a dropdown of slugs is the one control that makes a visual tool feel like a form: the island is chosen by looking at it */
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

  /* the hand had to reach the press and did not: the server resolves a card from the key it is given and this editor sent none, so every cover was bought with no style card and no reference painting */
  cov.includes('.styles()') && cov.includes('api.coverGen(words, styleKey, forSlug)')
    ? ok('the hand reaches the press, which is the whole of what an author does not have to type')
    : no('a cover is still generated with no style card at all')
  cov.includes('setStyleKey(mapStyle || fallback')
    ? ok("and the map's own hand is the default, because a cover for an island should be drawn by whoever drew it")
    : no('the hand does not default to the map that is being covered')

  /* a job takes minutes and the strip is one click: a picture bought for the harbour was written onto whichever island happened to be selected when it landed, and the money was already gone */
  cov.includes('type Made = { src: string; slug: string') && cov.includes('api.coverSave(made.slug, made.src')
    ? ok('a picture is kept on the map it was pressed for, whatever the strip is showing when it lands')
    : no('a generation in flight can still be written onto another map')

  // the rule every other paid press in this tool follows: one press says what it costs and the second spends it
  cov.includes("armed !== 'draw'") && cov.includes('this spends 1 generation')
    ? ok('and the press that spends money is armed first, like every other paid press here')
    : no('a generation is one unguarded click')
  cov.includes("armed !== key") && cov.includes("'yes, remove it'")
    ? ok('while removing one takes two presses too, since nothing can bring it back')
    : no('remove is one click on a hard delete')

  /* the game reads the cover argument as one namespace holding two different things, an occasion it owns and a name a map carries, so a cover named for an occasion ships and can never be shown */
  cov.includes("RESERVED = new Set(['ceremony', 'passing'])")
    ? ok('the two words the game already spends on that argument are refused as code names')
    : no('a cover could be named for an occasion the game handles itself')

  // the record is shown where it was asked for, since the first question anybody asks a picture is what was typed to get it
  cov.includes('asked for: ') ? ok('and a kept cover says the sentence it came from') : no('a kept cover cannot say what it was asked for')

  /* a job takes minutes and the picture lived only in react state, so a reload between the money
   * leaving and the keep lost a generation that was already paid for */
  cov.includes("const PENDING = 'mapvis:cover-job'") && cov.includes('sessionStorage.setItem(PENDING') && cov.includes('collecting the cover this tab was already paying for')
    ? ok('and a generation already bought is collected after a reload rather than bought again')
    : no('a reload still throws away a paid generation')

  const app = read('src/App.tsx')
  !app.includes("{ id: 'cover'") && !app.includes('coverPanel')
    ? ok('and the map editor no longer carries a cover step, so there is one place to find it')
    : no('the cover is still a step of the map editor as well')
  // one place to make one is not the same as no way to find it: the screen that lists what ships has to say whether a cover is among it
  app.includes('<b>cover.png</b>') && app.includes('.coversOf(coverId)') && app.includes('href="/ui"')
    ? ok('while the export step still says whether one ships, and links to where it is drawn')
    : no('the map editor never mentions the screen it is entered through')

  /* the chooser, which is what the page was missing: it opened straight into the twenty-one game pieces, so the only thing it could make was the one thing it showed */
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
