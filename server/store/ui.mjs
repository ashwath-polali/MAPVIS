/* A PICTURE OF A PAGE IS NOT A PAGE.
 *
 * The generator will happily draw a dialogue box, a health bar or a card, and
 * what comes back is a png. A png is not usable chrome: the vine still has to
 * know that the speaker's name goes at 14,9, that the bar fills from 40,72 to
 * 210,84, that the frame's top edge is 49 pixels deep so the corners do not
 * deform when the panel is stretched. Without those marks, every drawn surface
 * arrives with a second half typed by hand into game source, which is a fact
 * about a picture stored somewhere the picture cannot correct it.
 *
 * That is not a guess about the future. It is the shipped state: nineteen call
 * sites in the game say `background: <a png> center / 100% 100% no-repeat`, and
 * `src/game/cutscene/ui-kit.css:34` carries `padding: 5% 8.5% 6% 8.5%` under a
 * comment reading "measured off the asset". The measurement was done by hand
 * and it lives in the wrong repo.
 *
 * docs/UI-KIT.md is the authority for everything below. It read the game's own
 * record, found twenty-one distinct kinds of drawn surface, and decided the
 * export shape against what the game can actually consume rather than against
 * what is convenient to publish. Nothing here re-derives it.
 *
 * ONE KIT, PER ACCOUNT, ADDITIVE (Ash, 2026-08-30). Core chrome is never
 * overridable and a member's piece may only add. The shelf is scoped by owner
 * because a dialogue box belongs to the game rather than to the hub, and
 * 013_library_kit.sql says why the map-scoped library could not hold it.
 */
import { q, one, many } from '../db/pool.mjs'
import { store } from './blobs.mjs'
import { UI_GATES, fitUi } from '../pixellab.mjs'

// ---- the vocabulary --------------------------------------------------------

/* WHAT A REGION IS FOR, which is what a reader needs to know before it can draw
 * anything into one. Six kinds, taken from the marks the record's surfaces
 * actually carry rather than from a general theory of widgets.
 *
 * The word `slot` is not available. A WorldSlot is an island's berth on the
 * sea, in src/game/world/composition.ts, and PmapScene reads it about thirty
 * times as slotOfMap, seaSlots, residentSlots and s.berth. A UI rectangle
 * called a slot costs a session the first time somebody greps for one.
 *
 * The 012 set was close and three of its six were wrong. `bar` becomes `fill`
 * because it needs a direction and a tile rule: a rope that stretches is a
 * smear and a rope that tiles is a rope. `icon` and `image` collapse into
 * `picture`, because they differed only in what resolved the id and having both
 * invites an author to guess. `button` becomes `press`, because it names a hit
 * area rather than a drawn control, and the drawn control is a piece type.
 * `face` is new and exists because of the generator's 192 pixel floor. */
export const REGION_KINDS = ['text', 'number', 'picture', 'fill', 'face', 'press']

export const REGION_ALIGNS = ['left', 'center', 'right']

/* THE VERTICAL IS REQUIRED ON A PICTURE AND NOTHING ELSE.
 *
 * ui-kit.css:59-68 has the shipped portrait at `object-position: bottom center;
 * align-self: flex-end`, because a person stands on the bottom of their box. A
 * picture region that centres its content puts every character in the game
 * floating, and the defect is invisible until somebody looks at a short
 * character beside a tall one. So a picture with no vertical is refused rather
 * than defaulted, and every other kind leaves it alone. */
export const REGION_VALIGNS = ['top', 'middle', 'bottom']
export const PICTURE_FITS = ['contain', 'cover', 'none']

// which way a gauge grows, and whether its unit repeats or is scaled
export const FILL_AXES = ['right', 'left', 'up', 'down']
export const FILL_MODES = ['tile', 'scale']

// what CSS border-image-repeat takes. Pixel art wants `round`; `stretch` on a
// drawn edge is a smear, so it saves with a word rather than being refused.
export const REPEAT_MODES = ['stretch', 'repeat', 'round', 'space']

// how text behaves when a member writes four sentences into an option, which
// 40.13 records as having no behaviour at all today: "a member writing four
// sentences into an option finds out in a classroom"
export const TEXT_WRAPS = ['wrap', 'nowrap']
export const TEXT_OVERFLOWS = ['ellipsis', 'clip', 'grow']

const isName = (s) => /^[a-z][a-z0-9_]{0,47}$/.test(String(s || ''))
const num = (v, d = 0) => (isFinite(Number(v)) ? Math.round(Number(v)) : d)
const int = (v, d) => (isFinite(Number(v)) ? Math.max(1, Math.round(Number(v))) : d)

// ---- the twenty-one types --------------------------------------------------

/* THE LIST IS THE PRODUCT.
 *
 * The old page's whole model was a blank rectangle, a description and a canvas
 * to drag rectangles on, which assumes the author already knows what a dialogue
 * box is made of. The record has that written down in twenty-one places, so an
 * author picks a type and describes the piece, and the preset supplies the
 * plumbing.
 *
 * Four tiers, and the tier decides what a piece owes at publish.
 *
 *   ground   nine-sliced and stretchable. Owes four edge numbers, because those
 *            four numbers are the entire thing the game can consume today.
 *   sheet    one legal canvas holding a grid of faces, cut by marked
 *            rectangles. Every piece under 192 pixels is one of these, because
 *            BOTH SIDES OF A GENERATION START AT 192 and a season token is
 *            about 24 across. Drawing a family in one job is also the only way
 *            the faces come back the same weight, which is the law the asset
 *            stage already settled for character headings.
 *   painted  a full-bleed illustration keyed to a destination. Not a
 *            nine-slice, so four numbers on one would be a fact nothing reads.
 *   none     named here so that nobody generates them. Both cost a spend and
 *            neither can work: a sign is world art at map scale from the asset
 *            stage, and a row is typography.
 *
 * `order` is Ash's generation order from 2026-08-30 and it is data rather than
 * a gate, because he judges between each one and a queue that enforced a
 * sequence would be arguing with him. */
const T = (t) => ({ elements: null, faces: [], facesFree: false, regions: [], fill: true, order: 99, ...t })

export const PIECE_TYPES = [
  // ---- the twelve grounds --------------------------------------------------
  T({
    name: 'panel',
    label: 'Panel',
    tier: 'ground',
    order: 2,
    stretch: 'both',
    w: 448,
    h: 448,
    elements: ['panel'],
    what: 'The frame that holds everything the player opens.',
    why:
      'Eleven surfaces in the record are this one piece with different things inside it: the Handbook binder, the year sheet, the pause sheet, settings, the wardrobe, the yearbook spread, the graded frame, the result and review cards, the crash card, the ceremony card and the chart. The diploma is folded in as a painted variant because it stretches the same way and takes the same slice record.',
    // one painting has to hold three aspect ratios without the corners
    // deforming: the Handbook is min(720px, 94vw) by min(520px, 86vh), the year
    // sheet is min(880px, 96vw), and the yearbook grows downward for four years
    caution: 'The description says the material, the trim and that the middle is empty paper. A panel with a painted heading in it is a panel that can hold exactly one thing.',
    regions: [
      { name: 'header', kind: 'text', required: false },
      { name: 'body', kind: 'text', required: true },
      { name: 'close', kind: 'press', required: false },
    ],
  }),
  T({
    name: 'dialogue_box',
    label: 'Dialogue box',
    tier: 'ground',
    order: 1,
    stretch: 'both',
    w: 688,
    h: 384,
    elements: ['window'],
    what: 'Every line from every source, said by anybody.',
    why:
      'Ash ruled on 2026-08-28 that the cutscene overlay and the HUD dialogue collapse into one component, and the record names three more renderers that must become this piece rather than a fourth: the year-start card, the beat say card and the graduation advance card.',
    // 688x384 and deliberately not the shipped 512x192. A 192 tall image cannot
    // carry a top and a bottom slice deep enough to hold a drawn frame edge and
    // still have a middle, which is exactly why the box in the game today is a
    // hard height: min(190px, 26vh), and at text size L a 44px line at 1.4
    // leading fills it with nothing to spare.
    caution: 'Its height is a variable, not a number. It reports its own height so the camera can lift the painting clear of it.',
    regions: [
      { name: 'body', kind: 'text', required: true },
      { name: 'plaque_hang', kind: 'picture', required: false },
      { name: 'portrait', kind: 'picture', required: false },
      { name: 'emote', kind: 'picture', required: false },
      { name: 'advance_cue', kind: 'picture', required: false },
      { name: 'caret', kind: 'picture', required: false },
    ],
  }),
  T({
    name: 'band',
    label: 'Cover band',
    tier: 'ground',
    order: 3,
    stretch: 'x',
    w: 688,
    h: 192,
    what: 'A strip along the bottom edge that spans the window, reports its height and dismisses itself.',
    why:
      'The objective line and the place card are one surface with two consumers, and neither may be a dialogue box: a box is a person talking, and nothing is talking. The strip chrome of a scored frame is the same piece.',
    caution: 'No generator elements. This is a painted band and the named parts would scaffold furniture onto it.',
    regions: [
      { name: 'title', kind: 'text', required: true },
      { name: 'subtitle', kind: 'text', required: false },
    ],
  }),
  T({
    name: 'plaque',
    label: 'Plaque',
    tier: 'ground',
    order: 5,
    stretch: 'x',
    w: 384,
    h: 192,
    what: 'A label ground with fixed ends and a middle that repeats.',
    why:
      'Six surfaces are this one piece: the world prompt, the name plaque on the dialogue box, the cutscene gate prompt, the beat place strip, the class bay name plate and the verification code plaque.',
    // the label is an author's string from a MAPVIS anchor and can be anything
    // from "E - cast off" to a whole refusal sentence, so the ends are fixed
    caution:
      'The press area is not optional. A grep for pointerdown|click|hitTest|interactive in PmapScene returns zero hits, so every interaction on a painted map is proximity plus E today, and input parity is the most load-bearing rule in the kit.',
    regions: [
      { name: 'label', kind: 'text', required: true },
      { name: 'key_cap', kind: 'text', required: false },
      { name: 'press', kind: 'press', required: true },
    ],
  }),
  T({
    name: 'plank',
    label: 'Plank button',
    tier: 'ground',
    order: 4,
    stretch: 'x',
    w: 512,
    h: 384,
    elements: ['button'],
    // three faces stacked, because 12.13 specifies the pressed state moves 2px
    // down and loses its shadow, and a disabled state has to read as not-yet
    // rather than as refused
    faces: ['raised', 'pressed', 'disabled'],
    what: 'The wide button, whose label is often a sentence rather than a verb.',
    why:
      'The choice planks under the dialogue box are the entire decision-making vocabulary an ATC member has, because `choose` is one of only two words vine.py exposes. The widest button in the game carries "Under a B-. The Universal Retake Policy is real here: review, then run it back".',
    caution: 'The key cap is drawn on the plank so a keyboard player can see the number rather than guess it.',
    regions: [
      { name: 'label', kind: 'text', required: true },
      { name: 'key_cap', kind: 'text', required: false },
      { name: 'press', kind: 'press', required: true },
    ],
  }),
  T({
    name: 'field',
    label: 'Field',
    tier: 'ground',
    order: 8,
    stretch: 'x',
    w: 384,
    h: 192,
    what: 'An inset well that takes typed characters.',
    why:
      'A hole rather than a raised thing, and it carries an error line. The handle box, the six-box verification code, the number field and the one item in a beat where a student writes rather than picks are all this piece.',
    caution: 'The segmented version is six instances of this one well side by side, not a second piece.',
    regions: [
      { name: 'typed', kind: 'text', required: true },
      { name: 'unit', kind: 'text', required: false },
      { name: 'error', kind: 'text', required: false },
    ],
  }),
  T({
    name: 'socket',
    label: 'Socket',
    tier: 'ground',
    order: 10,
    stretch: 'both',
    w: 448,
    h: 600,
    faces: ['empty', 'filled'],
    what: 'An empty place that says something goes here, and the thing that lands in it.',
    why: 'The season column on the year sheet, the sticker page, the drop target of the shared drag, and the match target that is consumed when used. 5.5 is the reason this is a type at all: the current one is a menu and the intended one is an object.',
    caution: 'Both faces are drawn in one job or the filled one comes back a different weight from the empty one.',
    regions: [{ name: 'caption', kind: 'text', required: false }],
  }),
  T({
    name: 'gauge',
    label: 'Gauge',
    tier: 'ground',
    order: 11,
    stretch: 'x',
    w: 688,
    h: 192,
    elements: ['health_bar'],
    faces: ['track'],
    what: 'A track and a fill that must be separable.',
    why:
      'The cord thread bar is named in the record as art rather than as a rectangle, "a fraying thread that becomes rope as progress fills". The drive bar, the timing bar, the skip plaque fill and the loading bar are the same piece.',
    caution: 'The fill scales or tiles along its own axis while the track ends stay put, which is why the two are cut separately.',
    regions: [
      { name: 'fill_unit', kind: 'fill', required: true },
      { name: 'reading', kind: 'number', required: false },
    ],
  }),
  T({
    name: 'rail',
    label: 'Rail',
    tier: 'ground',
    order: 12,
    stretch: 'y',
    w: 384,
    h: 688,
    elements: ['toolbar'],
    what: 'A track holding a run of entries that changes length as entries arrive and leave.',
    why:
      'A HUD complete before the player has earned any of it is a prototype tell, so this has to read as finished at two entries and at three. The HUD corner stack, the planner token rail, the sticker strip and the trophy wall are all this.',
    caution: 'It grows by entry count and never by scaling one fixed plate.',
    regions: [
      { name: 'entry_pitch', kind: 'picture', required: true },
      { name: 'mounts', kind: 'picture', required: false },
    ],
  }),
  T({
    name: 'tab',
    label: 'Tab',
    tier: 'ground',
    order: 13,
    stretch: 'x',
    w: 512,
    h: 192,
    elements: ['tab'],
    faces: ['on', 'off'],
    what: 'A two-state selectable repeated along an edge.',
    why: 'The Handbook tab row, the yearbook year spine with a trailing dot on a turned year, and the settings tabs.',
    caution: 'The strip wraps rather than shrinking the tabs.',
    regions: [
      { name: 'label', kind: 'text', required: true },
      { name: 'press', kind: 'press', required: true },
    ],
  }),
  T({
    name: 'portrait_frame',
    label: 'Portrait frame',
    tier: 'ground',
    order: 14,
    stretch: 'none',
    w: 448,
    h: 600,
    elements: ['avatar'],
    what: 'A fixed aperture with a picture in it, bottom-anchored rather than centred.',
    why:
      'The portrait is a field on DialogueLine, on the say step, on ui.dialogue, on the say intent, in IntentWorld.say and twice in contract.ts, carried by eight files and drawn by none until recently. The wardrobe preview, the yearbook photo mount, the showdown opponent, the clip poster and the YOU pin circle are the same hole.',
    caution: 'A person stands on the bottom of their box, so the vertical is required on the picture region and there is no default.',
    regions: [
      { name: 'picture', kind: 'picture', required: true, valign: 'bottom', fit: 'contain' },
      { name: 'caption', kind: 'text', required: false },
    ],
  }),
  T({
    name: 'highlight_edge',
    label: 'Highlight edge',
    tier: 'ground',
    order: 15,
    stretch: 'both',
    w: 512,
    h: 512,
    // THE ONE PIECE DRAWN WITH ITS CENTRE EMPTY. The painting dims and one
    // anchor's region stays lit; the dim is engine geometry and only the lit
    // region's edge is drawn. A filled centre here would paint over the art.
    fill: false,
    what: 'A ring around a rectangle an author drew, with nothing in the middle.',
    why: 'Ash\'s own moment at 4.7, pointing at the things at the central platform, and an island host introducing their space is the same beat reskinned.',
    caution: 'It has no regions. It is a ring, and it is the only piece whose slice record sets fill to false.',
    regions: [],
  }),

  // ---- the six sheets ------------------------------------------------------
  T({
    name: 'chip',
    label: 'Chip sheet',
    tier: 'sheet',
    order: 6,
    stretch: 'none',
    w: 384,
    h: 384,
    elements: ['icon_button'],
    faces: ['plate'],
    facesFree: true,
    what: 'The small fixed control, plate and icon drawn separately.',
    why:
      'The 46px compass and Handbook spine are the first two pieces of UI a student sees after the intro and they are emoji today. The POWER sort is five rows by five buckets, which is twenty-five touch targets off one plate.',
    caution: 'The plate and the icon are separable, so one plate face carries any icon.',
  }),
  T({
    name: 'pip',
    label: 'Pip sheet',
    tier: 'sheet',
    order: 16,
    stretch: 'none',
    w: 384,
    h: 384,
    faces: ['fall', 'winter', 'spring', 'spent', 'ghost'],
    what: 'The season token, one face per season plus spent and the ghost that draws at zero.',
    why:
      'Today there are three visually identical pips whose only distinguishing mark is a title attribute reading "the Fall token". A token that cannot be told apart from another token is not a token, it is a counter.',
    caution: 'The same faces appear at two sizes, on the HUD stack and in the planner rail.',
  }),
  T({
    name: 'icon_set',
    label: 'Icon set',
    tier: 'sheet',
    order: 7,
    stretch: 'none',
    w: 512,
    h: 512,
    facesFree: true,
    what: 'A family of marks told apart by silhouette rather than by hue.',
    why:
      'The seven dock and chart state marks, the six badge chips, the stickers, the ten letter marks, the reveal marks and the emote set are one family under one law, because a student with a colour vision deficiency has to read this world.',
    caution: 'The discriminator is a thing present or absent at a known place, never a change of appearance on a thing that is always there.',
  }),
  T({
    name: 'cue',
    label: 'Cue strip',
    tier: 'sheet',
    order: 17,
    stretch: 'none',
    w: 384,
    h: 192,
    facesFree: true,
    what: 'The small animated mark that says the surface wants a press, as a strip of frames.',
    why:
      'Three ship today and all three are the paw emoji. The most visible instance is on the last screen of the run, on the surface a teacher reads over a shoulder.',
    caution: 'It stops animating under reduced motion rather than shortening, because a static caret is a bug and it is also how a player knows the line has not finished.',
  }),
  T({
    name: 'stamp',
    label: 'Stamp',
    tier: 'sheet',
    order: 18,
    stretch: 'none',
    w: 384,
    h: 384,
    faces: ['mark'],
    facesFree: true,
    what: 'An applied mark that lands on top of something.',
    why:
      'The wax stamp on the year sheet should be the loudest thing that has happened so far and today it is a CSS gradient with an emoji in it. The EARNED mark on a cord row wants a wax or foil mark rather than a coloured word.',
    caution: 'It marks the sheet itself and not only the control that was pressed, and it is unrepeatable: there is no unstamp function anywhere in the codebase.',
  }),
  T({
    name: 'pointer',
    label: 'Pointer set',
    tier: 'sheet',
    order: 19,
    stretch: 'none',
    w: 384,
    h: 192,
    faces: ['chevron', 'trail_dot', 'bearing', 'pin_tail', 'pin_plate'],
    facesFree: true,
    what: 'The world-space marker family.',
    why:
      'One objective chevron live at a time, because a home base with six glowing stations is a menu. The trail dot repeats along a computed path and is consumed from the near end as the player walks it.',
    caution:
      'The engine annotates beside the art and never over it, and these draw at screen scale 1 regardless of zoom, so nothing here ever stretches.',
  }),

  // ---- the one painted whole -----------------------------------------------
  T({
    name: 'cover_plate',
    label: 'Cover plate',
    tier: 'painted',
    order: 9,
    stretch: 'none',
    w: 688,
    h: 384,
    what: 'A full-bleed illustration with a title over a place name, a filling bar and one real BLHS fact under it.',
    why:
      'It is the first one that gets made twenty times by twenty people, which is exactly why it is a type with a fixed region layout rather than twenty freehand pictures.',
    caution:
      'It is not a nine-slice and it does not stretch, so it takes no edge numbers. The fact pool is 18 cards against roughly 154 sourced assertions, so the sentence length is not bounded.',
    regions: [
      { name: 'title', kind: 'text', required: true },
      { name: 'fact', kind: 'text', required: false },
      { name: 'gauge_track', kind: 'fill', required: false },
    ],
  }),

  // ---- the two named so nobody generates them ------------------------------
  T({
    name: 'sign',
    label: 'Sign',
    tier: 'none',
    order: 20,
    stretch: 'none',
    w: 0,
    h: 0,
    what: 'The world-scale text ground: a boat name on a stern, a signpost, a scoreboard, a room number plate.',
    why: 'Six sweeps of the record put a signpost in the UI kit and it is not one. A signpost is world art at map scale in the island\'s own palette, which makes it a map object out of the asset stage.',
    caution:
      'What this library owes it is only the text region on it, and that region is measured in ART pixels rather than screen pixels, which is a different unit from every other type here.',
  }),
  T({
    name: 'row',
    label: 'Row',
    tier: 'none',
    order: 21,
    stretch: 'none',
    w: 0,
    h: 0,
    what: 'The repeating list line: a title on the left, a meta column on the right, a rule under it.',
    why: 'Its drawn parts are a rule, a stamp and an icon, and all three are types above. A row is typography and spacing.',
    caution: 'Asking the generator for one produces a picture of a list that cannot then hold a list. Naming it prevents a spend.',
  }),
]

const BY_TYPE = new Map(PIECE_TYPES.map((t) => [t.name, t]))
export const pieceType = (name) => BY_TYPE.get(String(name || '')) || null

/* THE NAMES A MEMBER MAY NOT TAKE, standing before any row exists.
 *
 * Ash's ruling is that core chrome is never overridable and a member piece may
 * only add. A flag on a row cannot enforce that on its own, because the fence
 * has to hold on an empty shelf: the first member to sign up and generate
 * something called `dialogue_box` would own the name that every island in the
 * game speaks through. So the generated type names are reserved, and only a
 * write that says it is core may use one. */
export const CORE_NAMES = PIECE_TYPES.filter((t) => t.tier !== 'none').map((t) => t.name)
const CORE = new Set(CORE_NAMES)

/* WHAT THE GENERATOR WILL ACTUALLY DRAW, checked before the press rather than
 * after it, which is the one thing worth keeping from the old page.
 *
 * The size is aspect-gated and the maxima do not combine: a request reading as
 * one ratio gets that ratio's ceiling, so 688x512 comes back refused after the
 * money is already committed. Both sides also start at 192, and that floor is
 * why six of the twenty-one types are sheets. */
export function legalCanvas(w, h) {
  const want = { w: Math.max(1, num(w, 0)), h: Math.max(1, num(h, 0)) }
  const got = fitUi(want.w, want.h)
  return {
    ...got,
    ok: got.width === want.w && got.height === want.h,
    gates: UI_GATES.map(([, gw, gh]) => ({ w: gw, h: gh })),
    floor: 192,
  }
}

// ---- regions ---------------------------------------------------------------

/* ONE NAMED PLACE INSIDE A PIECE.
 *
 * Nothing here coerces a missing name into a made-up one, and that is
 * deliberate rather than strict. Every other field has an honest default: an
 * unknown kind reads as text, an absent alignment means the reader decides. A
 * name has no honest default, because the name IS the address a grape holds,
 * and a region silently called `region_3` is a promise the author never made.
 *
 * The four numbers are checked before they are rounded. num() answers 0 for
 * anything unreadable, so a rect whose height arrived as undefined would have
 * become a zero-tall box that draws nothing and reports no error. */
export function cleanRegion(s) {
  if (!s || !isName(s.name)) return null
  for (const k of ['x', 'y', 'w', 'h']) if (!isFinite(Number(s[k]))) return null
  const kind = REGION_KINDS.includes(s.kind) ? s.kind : 'text'
  const out = {
    name: s.name,
    kind,
    x: num(s.x),
    y: num(s.y),
    w: num(s.w),
    h: num(s.h),
    ...(REGION_ALIGNS.includes(s.align) ? { align: s.align } : {}),
    // the author's own bag, the way an anchor carries one. A region may need to
    // say which font, which ink, which key it reads, and none of that belongs
    // in a column that would have to be invented once per idea.
    ...(s.meta && typeof s.meta === 'object' && !Array.isArray(s.meta) ? { meta: s.meta } : {}),
  }
  // a picture's vertical is carried but never invented: checkUi refuses the
  // absence rather than quietly centring somebody
  if (kind === 'picture') {
    if (REGION_VALIGNS.includes(s.valign)) out.valign = s.valign
    if (PICTURE_FITS.includes(s.fit)) out.fit = s.fit
  }
  if (kind === 'fill') {
    out.axis = FILL_AXES.includes(s.axis) ? s.axis : 'right'
    out.mode = FILL_MODES.includes(s.mode) ? s.mode : 'tile'
  }
  if (kind === 'text') {
    if (TEXT_WRAPS.includes(s.wrap)) out.wrap = s.wrap
    if (TEXT_OVERFLOWS.includes(s.overflow)) out.overflow = s.overflow
  }
  return out
}

// ---- the nine-slice record -------------------------------------------------

/* FOUR NUMBERS PLUS THREE QUALIFIERS, and the shape is decided by what has to
 * read it rather than by what is easy to write.
 *
 * CSS border-image is the first consumer and Pixi NineSliceSprite is the
 * second, and the unit is the only thing they agree on. So the slice is in
 * SOURCE pixels, unitless, which is what border-image-slice means without a
 * percent sign and what NineSliceSprite takes as leftWidth, topHeight,
 * rightWidth and bottomHeight.
 *
 * `scale` exists because border-image-width is a separate number from the
 * slice. If only four insets ship, the game has to invent the draw thickness
 * and will get it wrong: panel-square.png is 448 wide and the planner sheet
 * draws it into min(880px, 96vw). With scale, border-width is slice * scale and
 * nothing is guessed.
 *
 * `repeat` takes exactly two values because CSS takes at most two, so four
 * independent edge modes could not be expressed even if somebody authored them.
 */
export function cleanSlices(s) {
  if (!s || typeof s !== 'object') return {}
  const e = s.slice && typeof s.slice === 'object' ? s.slice : s
  const four = ['top', 'right', 'bottom', 'left']
  if (four.some((k) => !isFinite(Number(e[k])))) return {}
  const rep = s.repeat && typeof s.repeat === 'object' ? s.repeat : {}
  const x = REPEAT_MODES.includes(rep.x) ? rep.x : 'round'
  return {
    slice: { top: num(e.top), right: num(e.right), bottom: num(e.bottom), left: num(e.left) },
    scale: int(s.scale, 1),
    fill: s.fill !== false,
    repeat: { x, y: REPEAT_MODES.includes(rep.y) ? rep.y : x },
  }
}

const hasSlices = (s) => !!(s && s.slice && isFinite(Number(s.slice.top)))

/* THE CONSTRAINT THAT BREAKS SILENTLY, and it is the reason this is checked at
 * all rather than trusted.
 *
 * If slice.top + slice.bottom is not under h, CSS drops to no border image with
 * no error anywhere: the panel simply renders as though the rule was never
 * written, and the author is looking at the wrong stylesheet for an hour. The
 * same for left and right against w. Refused where it is typed, naming both
 * numbers and the size they have to fit inside.
 */
export function checkSlices(rec, w, h, type) {
  const problems = []
  const warnings = []
  if (!hasSlices(rec)) return { problems, warnings }
  const s = rec.slice
  for (const [k, limit] of [['top', h], ['bottom', h], ['left', w], ['right', w]]) {
    if (s[k] < 0) problems.push(`the ${k} edge is ${s[k]}, and an edge cannot be negative`)
    else if (s[k] >= limit) problems.push(`the ${k} edge is ${s[k]} on a picture only ${limit} that way, so the edge is outside its own image`)
  }
  if (s.top + s.bottom >= h)
    problems.push(`the top and bottom edges are ${s.top} and ${s.bottom} on a ${h} tall picture, which leaves no middle, and CSS answers that by drawing no border image at all and saying nothing`)
  if (s.left + s.right >= w)
    problems.push(`the left and right edges are ${s.left} and ${s.right} on a ${w} wide picture, which leaves no middle, and CSS answers that by drawing no border image at all and saying nothing`)
  /* A PANEL WITHOUT fill RENDERS AS A RING AROUND A HOLE, because border-image
   * defaults it off. Only the highlight edge wants that, and it wants it on
   * purpose: its centre is the painting, and filling it would put the engine's
   * pixels on top of Ash's art. */
  if (type && type.fill && rec.fill === false)
    problems.push(`a ${type.label.toLowerCase()} has to fill its middle, or border-image draws a ring around a hole and the paper inside the frame is missing`)
  if (type && !type.fill && rec.fill === true)
    problems.push(`a ${type.label.toLowerCase()} is drawn with its centre empty, so filling it would paint over the map underneath`)
  for (const axis of ['x', 'y'])
    if (rec.repeat[axis] === 'stretch')
      warnings.push(`the ${axis === 'x' ? 'horizontal' : 'vertical'} edge is set to stretch, and a stretched pixel-art edge is a smear · round is what pixel art wants`)
  if (rec.scale > 8) warnings.push(`one source pixel is drawn ${rec.scale} css pixels wide, which is a very heavy panel`)
  return { problems, warnings }
}

/* WHAT THE MEASUREMENT LOOKS LIKE WHEN IT REACHES THE GAME.
 *
 * Written here rather than on the page, because the shape is a decision and a
 * page that re-derives it is a second copy that drifts. Six lines added and
 * nineteen edited on the game side, no new file, no fetch, no parse: the four
 * numbers come from measuring the png once, which is exactly what was already
 * done by hand for `padding: 11% 13% 11.5%`.
 */
export function sliceCss(name, rec) {
  if (!hasSlices(rec)) return ''
  const { top, right, bottom, left } = rec.slice
  const k = rec.scale
  const px = [top, right, bottom, left].map((n) => `${n * k}px`).join(' ')
  const rep = rec.repeat.x === rec.repeat.y ? rec.repeat.x : `${rec.repeat.x} ${rec.repeat.y}`
  return [
    `--kit-slice-${name}: ${top} ${right} ${bottom} ${left};`,
    `--kit-slice-w-${name}: ${px};`,
    `--kit-repeat-${name}: ${rep};`,
    ``,
    `.kit-surface-${name} {`,
    `  border-style: solid;`,
    `  border-width: var(--kit-slice-w-${name});`,
    `  border-image: var(--kit-art-${name}) var(--kit-slice-${name})${rec.fill ? ' fill' : ''} / 1 / 0 var(--kit-repeat-${name});`,
    `}`,
  ].join('\n')
}

// ---- what a piece is not allowed to be -------------------------------------

/* The same split saveWorld draws. A problem is a thing that can never work and
 * is refused where it is written; a warning is a thing that is probably a
 * mistake and is somebody else's call.
 *
 * A region off the edge of the picture is the fatal one, and it is fatal rather
 * than clamped: clamping hands back a rectangle the author did not draw, and
 * the panel then looks wrong in the game with nothing anywhere saying so.
 * Overlap is only a warning because overlapping is legal and occasionally
 * meant, a value printed on top of the bar that measures it being the case
 * everyone has. Two FACES overlapping is a different matter and gets its own
 * sentence, because faces are cuts of one canvas and two cuts sharing pixels
 * means one of the two comes out with a corner of its neighbour in it.
 */
export function checkUi(asset) {
  const problems = []
  const warnings = []
  const regions = Array.isArray(asset?.regions) ? asset.regions : []
  const type = asset?.type ? pieceType(asset.type) : null
  const seen = new Set()
  for (const s of regions) {
    if (seen.has(s.name)) problems.push(`two regions are both called "${s.name}", and a name is the only address there is`)
    seen.add(s.name)
    if (s.x < 0 || s.y < 0 || s.x + s.w > asset.w || s.y + s.h > asset.h)
      problems.push(
        `"${s.name}" covers ${s.x},${s.y} to ${s.x + s.w},${s.y + s.h}, which is off a ${asset.w}x${asset.h} picture, so nothing can ever be drawn into it`,
      )
    if (s.w <= 0 || s.h <= 0) problems.push(`"${s.name}" has no area, and a rectangle nothing fits in cannot hold anything`)
    /* THE VERTICAL IS REQUIRED ON A PICTURE. The shipped portrait is
     * bottom-anchored because a person stands on the bottom of their box, and a
     * region that centres its content puts every character floating. */
    if (s.kind === 'picture' && !s.valign)
      problems.push(`"${s.name}" is a picture with no vertical · say top, middle or bottom, because a frame that centres a standing character leaves them floating`)
  }
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i]
      const b = regions[j]
      if (!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)) continue
      if (a.kind === 'face' && b.kind === 'face')
        problems.push(`the faces "${a.name}" and "${b.name}" share pixels, and a cut that overlaps another cut comes out with a corner of its neighbour in it`)
      else warnings.push(`"${a.name}" and "${b.name}" overlap, which is legal and is usually a mis-drag`)
    }
  }
  if (type) {
    for (const want of type.regions)
      if (want.required && !seen.has(want.name))
        warnings.push(`a ${type.label.toLowerCase()} normally carries a region called "${want.name}" and this one has none`)
    if (type.faces.length) {
      const cut = new Set(regions.filter((r) => r.kind === 'face' || r.kind === 'fill').map((r) => r.name))
      for (const f of type.faces) if (!cut.has(f)) warnings.push(`the "${f}" face has not been cut yet`)
    }
  }
  const sl = checkSlices(asset?.slices, asset.w, asset.h, type)
  return { problems: problems.concat(sl.problems), warnings: warnings.concat(sl.warnings) }
}

// ---- reading ---------------------------------------------------------------

/* WHAT THE GAME AND A MEMBER'S PYTHON GET, and the whole of it.
 *
 * The record's export decision is that tier one, the game's own chrome, ships
 * as files in the game repo and what crosses the wire is the measurement. So
 * this shape is the slice record from docs/UI-KIT.md section 3 verbatim,
 * `{ src, w, h, slice, scale, fill, repeat }`, with the regions and the faces
 * beside it.
 *
 * `faces` is a projection of the regions and not a second list. A face is a cut
 * on a sheet, so it is a region with a kind, and keeping a separate array of
 * them would be two truths about the same rectangles that disagree the first
 * time one is dragged. The projection is here because a consumer cutting a
 * sheet wants the cuts without filtering, and because a name collision between
 * a face and a text region on one piece is a real ambiguity that the shared
 * namespace refuses.
 *
 * `status` of pending or failed is not an error to a reader. It is the study's
 * plain arm, which blanks every surface, and the game's tokens.css already
 * treats a missing image that way.
 *
 * `src` resolves on the MAPVIS origin only, where the game's own four are
 * same-origin files. That is the same cross-origin case already logged against
 * reading a map from the platform and it is not new here.
 */
const shape = (r) => {
  const regions = Array.isArray(r.regions) ? r.regions : []
  const slices = r.slices && typeof r.slices === 'object' && r.slices.slice ? r.slices : null
  return {
    name: r.name,
    type: r.type || '',
    title: r.title,
    description: r.description,
    w: r.w,
    h: r.h,
    status: r.status,
    core: !!r.core,
    published: !!r.published,
    regions,
    faces: regions.filter((s) => s.kind === 'face').map(({ name, x, y, w, h }) => ({ name, x, y, w, h })),
    ...(slices ? { ...slices, css: sliceCss(r.name, slices) } : {}),
    ...(r.blob_key ? { src: `/api/v1/ui/${r.name}/image` } : {}),
    ...(r.pixellab_id ? { pixellabId: r.pixellab_id } : {}),
    createdAt: r.created_at ? +new Date(r.created_at) : 0,
  }
}

export async function listUi(ownerId) {
  if (!ownerId) return []
  const rows = await many('select * from ui_assets where owner_id = $1 order by core desc, name', [ownerId])
  return rows.map(shape)
}

export async function getUiByName(ownerId, name) {
  if (!ownerId || !isName(name)) return null
  const r = await one('select * from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  return r ? shape(r) : null
}

/* WHAT THE READ API SERVES, which has no account in its path.
 *
 * A name is unique per account rather than globally, so two people can both
 * call a piece `dialogue_box` and this endpoint has nowhere to put the
 * difference. CORE WINS THAT TIE, and then the oldest, which is the only
 * ordering consistent with the ruling that core chrome is never overridable.
 * Survivable because the game reads chrome from one account, the club's, and
 * said out loud here rather than left to whichever row the planner returned.
 */
export async function readyUi() {
  return (await many(`select * from ui_assets where status = 'ready' order by name, core desc, created_at`)).map(shape)
}

export async function readyUiByName(name) {
  if (!isName(name)) return null
  const r = await one(`select * from ui_assets where status = 'ready' and name = $1 order by core desc, created_at limit 1`, [name])
  return r ? shape(r) : null
}

// the bytes, for the read api's image route. Separate from the row read so a
// listing never pays for a png.
export async function uiImage(name) {
  if (!isName(name)) return null
  const r = await one(`select blob_key from ui_assets where status = 'ready' and name = $1 order by core desc, created_at limit 1`, [name])
  if (!r?.blob_key) return null
  try {
    return await store().get(r.blob_key)
  } catch {
    return null
  }
}

/* IS ANYTHING ALREADY DRAWING FOR THIS ACCOUNT.
 *
 * One at a time is Ash's ruling and it is enforced by asking rather than by
 * trusting the caller to press once. A row exists in `pending` for the whole
 * minute and a half a generation takes, so this is the honest answer to "is a
 * spend in flight". Age-limited because a process that died mid-call leaves a
 * pending row behind forever, and a stuck row must not lock the account out of
 * ever generating again.
 */
export async function pendingUi(ownerId) {
  if (!ownerId) return null
  const r = await one(
    `select name, created_at from ui_assets
     where owner_id = $1 and status = 'pending' and created_at > now() - interval '10 minutes'
     order by created_at desc limit 1`,
    [ownerId],
  )
  return r ? { name: r.name, since: +new Date(r.created_at) } : null
}

// ---- writing ---------------------------------------------------------------

/* CORE CHROME IS NEVER OVERRIDABLE, and a member piece may only ADD.
 *
 * Two fences, because one is not enough. The row flag holds once a core piece
 * exists. The reserved name list holds before it does, which is the case that
 * actually bites: on an empty shelf the first member to generate something
 * called `dialogue_box` would own the name every island in the game speaks
 * through, and nothing would have said a word.
 *
 * Refused with the reason rather than with a code, because the person reading
 * it is a fifteen year old who has just lost a generation.
 */
async function guardCore(ownerId, name, core) {
  if (core) return
  if (CORE.has(name))
    throw new Error(
      `"${name}" is core chrome and belongs to the whole game, so a member piece cannot take that name · pick a name of your own and it will be added beside it`,
    )
  const had = await one('select core from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  if (had?.core)
    throw new Error(`"${name}" is a core piece and core chrome is never overridable · a member piece may only add, so give this one a name of its own`)
}

/* The row exists before the picture does, because generation takes a minute and
 * a half and something has to be poll-able for that minute and a half.
 *
 * Regenerating under a name already taken REPLACES that piece rather than
 * failing or inventing `dialogue_box-2`. Same rule the in-place edits settled
 * on: the library keeps one row per thing, and a second row that is the same
 * panel one shade darker is how a list becomes unreadable. The regions and the
 * slices are left alone on purpose, so redrawing a panel at the same size keeps
 * the marks that were made on it.
 */
export async function createUi({ ownerId, name, type = '', title = '', description = '', w, h, pixellabId = '', core = false }) {
  if (!ownerId) throw new Error('a piece needs an account to belong to')
  if (!isName(name)) throw new Error(`"${name}" is not a legal piece name; it has to read as a python identifier`)
  const t = type ? pieceType(type) : null
  if (type && !t)
    throw new Error(`there is no piece type called "${type}" · the kit has ${PIECE_TYPES.length} of them and a piece has to be one`)
  /* THE TWO NAMED SO NOBODY GENERATES THEM. A sign is world art at map scale
   * and comes out of the asset stage; a row is typography whose drawn parts are
   * already three other types. Both would come back a picture that cannot do
   * the job, and refusing here is what saves the spend. */
  if (t && t.tier === 'none') throw new Error(`a ${t.label.toLowerCase()} is not generated · ${t.why}`)
  await guardCore(ownerId, name, core)
  return one(
    `insert into ui_assets (owner_id, name, type, title, description, w, h, pixellab_id, core, status, published, published_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',false,null)
     on conflict (owner_id, name) do update set
       type = excluded.type, title = excluded.title, description = excluded.description,
       w = excluded.w, h = excluded.h,
       pixellab_id = case when excluded.pixellab_id <> '' then excluded.pixellab_id else ui_assets.pixellab_id end,
       core = excluded.core,
       -- a redraw un-publishes: the four numbers were measured against the
       -- picture that is being thrown away, and a slice record pointing at a
       -- picture that no longer exists is worse than none
       status = 'pending', published = false, published_at = null
     returning *`,
    [
      ownerId,
      name,
      t ? t.name : '',
      String(title).slice(0, 120),
      String(description).slice(0, 1000),
      Math.max(1, num(w, t?.w || 256)),
      Math.max(1, num(h, t?.h || 256)),
      String(pixellabId || ''),
      !!core,
    ],
  )
}

/* The picture arriving is what makes a piece ready.
 *
 * w and h come off the png rather than off the ask, because the generator
 * answers with the canvas IT chose and a region rect measured against a size
 * the picture does not have is a region that draws in the wrong place. Same
 * reason styleRef reads the IHDR instead of trusting the document.
 */
export async function setUiImage(ownerId, name, buf, w, h) {
  if (!ownerId || !isName(name)) throw new Error('no piece to put a picture on')
  const key = `ui/${ownerId}/${name}.png`
  await store().put(key, buf, 'image/png')
  return one(
    `update ui_assets set blob_key = $3, w = $4, h = $5, status = 'ready'
     where owner_id = $1 and name = $2 returning *`,
    [ownerId, name, key, Math.max(1, num(w, 256)), Math.max(1, num(h, 256))],
  )
}

// a spend that produced nothing still has to be visible, so the row stays and
// says what happened rather than disappearing as though it was never asked for
export const failUi = (ownerId, name) =>
  q(`update ui_assets set status = 'failed' where owner_id = $1 and name = $2`, [ownerId, name])

/* THE MARKS, REFUSED THE WAY saveWorld REFUSES A COMPOSITION.
 *
 * Written where it is wrong, naming what is wrong, rather than discovered by a
 * member whose number prints half off the panel. The clean pass runs first so
 * the check is looking at what would actually be stored, and a region that
 * cleanRegion threw away is reported by count rather than silently dropped: a
 * nameless region vanishing without a word is how somebody spends an afternoon
 * looking for a mark they are sure they made.
 *
 * Takes both halves in one call because they are checked against each other:
 * an edge number is only legal against the picture the regions sit on, and
 * saving one without the other would let the pair go inconsistent between two
 * requests.
 */
export async function saveUi(ownerId, name, regions, slices) {
  const row = await one('select * from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  if (!row) throw new Error(`there is no piece called "${name}" on this account`)
  const asked = Array.isArray(regions) ? regions : []
  const clean = asked.map(cleanRegion).filter(Boolean)
  const dropped = asked.length - clean.length
  /* SLICES ARE ONLY MEANINGFUL ON A GROUND. A cover plate is a painting keyed
   * to a destination and a sheet is a grid of cuts, so four edge numbers on
   * either is a field nothing will ever read, which is the half-plumbed pattern
   * this project keeps rediscovering. */
  const t = row.type ? pieceType(row.type) : null
  const rec = slices === undefined ? (row.slices?.slice ? row.slices : {}) : cleanSlices(slices)
  const { problems, warnings } = checkUi({ w: row.w, h: row.h, type: row.type, regions: clean, slices: rec })
  if (dropped) problems.push(`${dropped} region(s) had no usable name and four numbers, and a region with no name has no address`)
  if (hasSlices(rec) && t && t.tier !== 'ground')
    problems.push(`a ${t.label.toLowerCase()} does not stretch, so four edge numbers on it are a measurement nothing will ever read`)
  if (problems.length) {
    const e = new Error(`nothing was saved · ${problems.join(' · ')}`)
    e.problems = problems
    throw e
  }
  const saved = await one(
    `update ui_assets set regions = $3::jsonb, slices = $4::jsonb, published = false, published_at = null
     where owner_id = $1 and name = $2 returning *`,
    [ownerId, name, JSON.stringify(clean), JSON.stringify(rec)],
  )
  return { ...shape(saved), warnings }
}

// the name the routes call it by. One implementation, because a second one is a
// second set of refusals that drift apart.
export const setUiRegions = saveUi

/* SAYING A PIECE IS FINISHED, which is a different fact from the picture having
 * arrived.
 *
 * `status` says the generator answered. This says the measurement was made and
 * survives its own check. A ground piece with no edge numbers cannot get here,
 * because those four numbers are the entire thing the game can consume: without
 * them the consumer falls back to `center / 100% 100% no-repeat`, which is the
 * squash this whole library exists to end.
 */
export async function publishUi(ownerId, name) {
  const row = await one('select * from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  if (!row) throw new Error(`there is no piece called "${name}" on this account`)
  const t = row.type ? pieceType(row.type) : null
  const problems = []
  if (row.status !== 'ready') problems.push(`its picture is ${row.status}, and there is nothing yet to measure`)
  if (t && t.tier === 'ground' && !hasSlices(row.slices))
    problems.push(
      `a ${t.label.toLowerCase()} stretches, so it needs its four edge numbers · without them the game falls back to squashing the whole painting into the box, which is the thing this library exists to end`,
    )
  const { problems: bad, warnings } = checkUi({ w: row.w, h: row.h, type: row.type, regions: row.regions || [], slices: row.slices })
  problems.push(...bad)
  if (problems.length) {
    const e = new Error(`"${name}" is not ready to publish · ${problems.join(' · ')}`)
    e.problems = problems
    throw e
  }
  const saved = await one(
    `update ui_assets set published = true, published_at = now() where owner_id = $1 and name = $2 returning *`,
    [ownerId, name],
  )
  return { ...shape(saved), warnings }
}

// a piece leaves both stores or it comes back on the next listing, the same
// rule dropItem holds a library row to. Core is guarded here too, because
// deleting the dialogue box is the loudest way to override it.
export async function removeUi(ownerId, name, { core = false } = {}) {
  const r = await one('select blob_key, core from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  if (!r) return false
  if (r.core && !core)
    throw new Error(`"${name}" is core chrome and core chrome is never overridable, so it cannot be removed from a member's side`)
  if (r.blob_key) await store().del(r.blob_key).catch(() => {})
  await q('delete from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  return true
}
