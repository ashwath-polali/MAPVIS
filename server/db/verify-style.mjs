// The prompt a map is drawn from, for every kind and both choices, with nothing bought.

//   node server/db/verify-style.mjs

// The brief's own proof: the hand is not something to be judged by looking at a generation, it is the
// words the router writes, and those can be read here for free. Everything below is string work.
//
// What it holds to: the subject the person typed comes first and survives whole; a kind adds what the
// engine needs and never a noun the person would have typed; the craft sentence appears only when a
// card was chosen; and two people typing the same kind get the same scaffold around different words.
import { mapPrompt, kindOf, SCAFFOLDS, KINDS, HOUSE_CARD, styleStamp, fitCanvas, AREA_CEILING, STYLE_OPTIONS } from '../store/style.mjs'

let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}

const OTHER = null

// ---- the two choices, over every kind --------------------------------------

for (const kind of KINDS) {
  const subject = `a weathered ${kind} of grey stone`
  const house = mapPrompt({ subject, card: HOUSE_CARD })
  const other = mapPrompt({ subject, card: OTHER })

  house.kind === kind ? ok(`"${subject}" reads as a ${kind}`) : no(`a ${kind} was read as "${house.kind}"`)

  // the subject is the only part the person typed, so it opens the prompt and
  // is not paraphrased on the way through
  house.prompt.startsWith(subject) ? ok(`  the ${kind}'s own words open the prompt`) : no(`the ${kind} prompt does not open with the subject`)
  other.prompt.startsWith(subject) ? ok(`  and open it under Other too`) : no(`Other moved the subject on a ${kind}`)

  // the scaffold is structural and belongs to the engine, so it is on both
  const struct = SCAFFOLDS[kind].structure.slice(0, 40)
  house.prompt.includes(struct) && other.prompt.includes(struct)
    ? ok(`  the ${kind} scaffold is there whichever hand is chosen`)
    : no(`the ${kind} scaffold is missing from one of the two`)

  // the craft sentence is the hand, and it is the whole of the difference
  house.prompt.includes(HOUSE_CARD.craft.clause)
    ? ok(`  the Adventure Game hand is written in`)
    : no(`the ${kind} lost the house craft sentence`)
  other.prompt.includes(HOUSE_CARD.craft.clause)
    ? no(`Other carried the house hand on a ${kind}, which is the leak this exists to stop`)
    : ok(`  and Other carries none of it`)

  // and nothing else differs: strip the clause from one and they are the same
  house.prompt.replace(HOUSE_CARD.craft.clause + '. ', '') === other.prompt
    ? ok(`  the hand is the only difference between the two`)
    : no(`a ${kind} differs between the choices by more than the craft sentence`)
}

// ---- a kind is a scaffold and never a copy ---------------------------------

{
  const a = mapPrompt({ subject: 'a quiet fishing island with a lighthouse', card: HOUSE_CARD })
  const b = mapPrompt({ subject: 'a volcanic island of black rock', card: HOUSE_CARD })
  a.prompt !== b.prompt ? ok('two islands typed differently are two different prompts') : no('two islands came out identical')
  a.prompt.includes('lighthouse') && b.prompt.includes('volcanic')
    ? ok('and each keeps the words its author typed')
    : no('a subject was lost between the two')

  const shared = SCAFFOLDS.island.structure
  a.prompt.includes(shared) && b.prompt.includes(shared) ? ok('while both stand on the one island scaffold') : no('the scaffold differed')
}

/* THE SCAFFOLD MUST NOT DESCRIBE A PLACE. A noun in it is how every island comes
 * back as the same island, which is the exact failure the brief names. */
{
  const SUBJECTS = ['lighthouse', 'palm', 'harbour', 'village', 'temple', 'market', 'tavern', 'castle', 'forest', 'volcano', 'hut', 'ship']
  const leaks = []
  for (const kind of KINDS) {
    const text = (SCAFFOLDS[kind].structure + ' ' + (SCAFFOLDS[kind].extra || '')).toLowerCase()
    for (const n of SUBJECTS) if (text.includes(n)) leaks.push(`${kind}: ${n}`)
  }
  leaks.length === 0 ? ok('no scaffold names a thing a person would have typed themselves') : no(`a scaffold describes a subject: ${leaks.join(', ')}`)
}

/* and it must not carry a palette either, or Other stops being the prompt as
 * typed and quietly becomes a second hand */
{
  const COLOURS = ['warm', 'desaturated', 'muted', 'sandy', 'terracotta', 'olive', 'golden', 'amber']
  const leaks = []
  for (const kind of KINDS) {
    const text = (SCAFFOLDS[kind].structure + ' ' + (SCAFFOLDS[kind].extra || '')).toLowerCase()
    for (const c of COLOURS) if (text.includes(c)) leaks.push(`${kind}: ${c}`)
  }
  leaks.length === 0 ? ok('and no scaffold carries a palette, so Other really is the words as typed') : no(`a scaffold names colour: ${leaks.join(', ')}`)
}

// ---- what the engine needs of each class -----------------------------------

{
  const isl = mapPrompt({ subject: 'an island', card: HOUSE_CARD }).prompt
  const asks = (text, what) => text.includes(what)
  /* the coast has to be transparent or the engine has nowhere to draw its own
   * ocean, and a painted sea sits dead beside a moving one */
  asks(isl, 'transparent') ? ok('an island asks for a transparent surround') : no('an island did not ask for transparency')
  asks(isl, 'shallow water') ? ok('and for the shallows that only the painting can hold') : no('an island lost its shallows')
  asks(isl, 'dock') || asks(isl, 'jetty') ? ok('and for somewhere to arrive') : no('an island has nowhere to land')

  for (const k of ['room', 'hall']) {
    const t = mapPrompt({ subject: `a ${k}`, card: HOUSE_CARD }).prompt
    asks(t, 'character scale') ? ok(`a ${k} is drawn at character scale`) : no(`a ${k} did not ask for character scale`)
    asks(t, 'no sky') ? ok(`  and has no sky in it`) : no(`a ${k} has a sky`)
  }
}

// ---- reading the kind off the words ----------------------------------------

{
  const cases = [
    ['a small island', 'island'],
    ['THE GREAT HALL', 'hall'],
    ['a store room at the back', 'room'],
    ['two islands', 'island'],
    ['a windmill on a hill', ''],
    ['', ''],
  ]
  let wrong = 0
  for (const [text, want] of cases) if (kindOf(text) !== want) wrong++
  wrong === 0 ? ok('the kind is read off the words, and an unrecognised one stays unrecognised') : no(`${wrong} of ${cases.length} kinds read wrong`)
  kindOf('a windmill', 'room') === 'room' ? ok('and a kind said out loud beats one guessed at') : no('an explicit kind was ignored')
  kindOf('an island', 'nonsense') === 'island' ? ok('while a kind nothing recognises falls back to the words') : no('a bad explicit kind won')
}

// ---- the refusal that must survive truncation ------------------------------

{
  const long = mapPrompt({ subject: 'an island '.repeat(200), card: HOUSE_CARD })
  long.prompt.length <= 1401 ? ok('a runaway subject is cut to the ceiling') : no(`a long prompt came out at ${long.prompt.length}`)
}

// ---- the canvas ------------------------------------------------------------

{
  for (const kind of KINDS) {
    const c = fitCanvas(SCAFFOLDS[kind].canvas)
    c.w % 2 === 0 && c.h % 2 === 0 ? ok(`the ${kind} canvas has both sides even`) : no(`the ${kind} canvas has an odd side`)
    c.w * c.h <= AREA_CEILING ? ok(`  and fits under the ${AREA_CEILING.toLocaleString()} pixel ceiling`) : no(`the ${kind} canvas is over the ceiling`)
  }
  const big = fitCanvas({ w: 1200, h: 900 })
  big.w * big.h <= AREA_CEILING && big.w % 2 === 0 && big.h % 2 === 0
    ? ok('an oversized canvas is brought under the ceiling with both sides still even')
    : no(`an oversized canvas came back ${big.w}x${big.h}`)
  fitCanvas({ w: 101, h: 101 }).w === 102 ? ok('and an odd side is raised rather than refused after the fact') : no('an odd side survived')
}

// ---- the reference painting ------------------------------------------------

STYLE_OPTIONS.color_palette === false
  ? ok('the reference painting is passed with its own colour switched off')
  : no('the style image would carry its palette, so every map comes back the same colours')
STYLE_OPTIONS.outline && STYLE_OPTIONS.detail && STYLE_OPTIONS.shading
  ? ok('and carries the outline, the detail and the shading, which is all it can carry')
  : no('the style image is not carrying the craft it exists to carry')

// ---- what the bundle says --------------------------------------------------

{
  const stamp = styleStamp(HOUSE_CARD, 'island')
  stamp && stamp.style === HOUSE_CARD.key && stamp.house === true && stamp.kind === 'island'
    ? ok('a published map says which hand drew it and which scaffold it stood on')
    : no(`the bundle stamp is wrong: ${JSON.stringify(stamp)}`)
  const none = styleStamp(null, 'room')
  none && none.kind === 'room' && !none.style ? ok('and a map drawn under Other claims no hand') : no('a map under Other claimed a hand')
  styleStamp(null, '') === null ? ok('while a map that chose nothing at all stamps nothing') : no('an empty stamp was written')
}

console.log(bad ? `\n${bad} problem(s).` : '\nevery kind stands on its own scaffold, and the hand is the only thing the choice changes.')
process.exit(bad ? 1 : 0)
