/* a png alone is not chrome, the marks ship with it or the game hand-types them; one kit per account, additive; docs/UI-KIT.md is the authority */
import crypto from 'node:crypto'
import { q, one, many } from '../db/pool.mjs'
import { store } from './blobs.mjs'
import { decodePNG, encodePNG } from '../sheet.mjs'
import { UI_GATES, fitUi, fitSheet, SHEET_ONE_IMAGE } from '../pixellab.mjs'

// ---- the vocabulary --------------------------------------------------------

/* never call a region a slot: WorldSlot already means an island's berth and PmapScene reads it about thirty times */
export const REGION_KINDS = ['text', 'number', 'picture', 'fill', 'face', 'press']

export const REGION_ALIGNS = ['left', 'center', 'right']

/* a picture with no vertical is refused rather than defaulted, because a centred portrait floats instead of standing */
export const REGION_VALIGNS = ['top', 'middle', 'bottom']
export const PICTURE_FITS = ['contain', 'cover', 'none']

// which way a gauge grows, and whether its unit repeats or is scaled
export const FILL_AXES = ['right', 'left', 'up', 'down']
export const FILL_MODES = ['tile', 'scale']

// what CSS border-image-repeat takes. Pixel art wants `round`; `stretch` on a
// drawn edge is a smear, so it saves with a word rather than being refused.
export const REPEAT_MODES = ['stretch', 'repeat', 'round', 'space']

// how text behaves when somebody writes four sentences into an option. With no
// answer here the first person to find out is whoever is reading the screen.
export const TEXT_WRAPS = ['wrap', 'nowrap']
export const TEXT_OVERFLOWS = ['ellipsis', 'clip', 'grow']

const isName = (s) => /^[a-z][a-z0-9_]{0,47}$/.test(String(s || ''))
const num = (v, d = 0) => (isFinite(Number(v)) ? Math.round(Number(v)) : d)
const int = (v, d) => (isFinite(Number(v)) ? Math.max(1, Math.round(Number(v))) : d)

// ---- the twenty-one types --------------------------------------------------

/* measured over five rolls: elements decides shape, styleRef decides material, words decide neither, so both live on the type where no caller can drop one */
const T = (t) => ({
  elements: null,
  elementsWhy: '',
  styleRef: null,
  material: null,
  faces: [],
  facesFree: false,
  regions: [],
  fill: true,
  order: 99,
  ...t,
})

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
    /* window and not panel: panel means a flat sub-plate, and only window came back as one complete centred piece */
    elements: ['window'],
    elementsWhy: 'a panel is a framed thing the player opens, which is what window returns as one complete piece',
    // the honey plank frame round a big clean paper field, which is this type's
    // own caution said in a picture: the middle is empty paper. Not the dialogue
    // box, whose anchors and cabochons are a speaker's furniture.
    styleRef: 'panel-paper-wood.png',
    material: 'plain cream parchment',
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
    // the pair that drew v4, unchanged. This is the only row in the table whose
    // three levers are measured on a picture rather than reasoned from one.
    elements: ['window'],
    elementsWhy: 'measured on a returned dialogue box rather than reasoned about',
    styleRef: 'dialogue-box.png',
    material: 'aged cream parchment, lightly mottled',
    what: 'Every line from every source, said by anybody.',
    why:
      'The cutscene overlay and the HUD dialogue are one component, and three more renderers become this piece rather than a fourth: the year-start card, the beat say card and the graduation advance card.',
    // 688x384 and not the shipped 512x192, because 192 tall cannot hold a top slice, a bottom slice and a middle
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
    /* with no elements the endpoint returns eighteen loose plates with the band cropped off the top, measured on v3 */
    elements: ['window'],
    elementsWhy: 'without a list the endpoint returns a kit, which was measured on v3, and a cropped band is worse than a framed one',
    // the calm honey plank, deliberately NOT dialogue-box.png. A band exists
    // because nothing is talking, and handing it the speaker's own material is
    // how it comes back reading as a dialogue box.
    styleRef: 'panel-paper-wood.png',
    material: 'plain cream parchment',
    what: 'A strip along the bottom edge that spans the window, reports its height and dismisses itself.',
    why:
      'The objective line and the place card are one surface with two consumers, and neither may be a dialogue box: a box is a person talking, and nothing is talking. The strip chrome of a scored frame is the same piece.',
    caution: 'It must not read as a dialogue box. Nothing is talking, so no speaker furniture: no name plate, no portrait hole and no advance cue on it.',
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
    /* not button even though a press area is required, because the endpoint's button element draws a control that depresses */
    elements: ['window'],
    elementsWhy: 'a name plate is a framed plate rather than a control that depresses, so window and not button',
    // matched at control scale, because the two big panels read as a room's worth of frame at plaque size
    styleRef: 'button-wood.png',
    material: 'plain cream parchment',
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
    // the one type the endpoint has an exact name for, so the name wins over the
    // measured default: this piece IS a button
    /* window and not button: elements:['button'] came back with the word BUTTON painted in and one face instead of three */
    elements: ['window'],
    elementsWhy: 'the endpoint has a name for this exact piece',
    // its own shipped art. button-wood.png carries painted lettering, which the
    // prompt refuses in words and nothing refuses in pixels, so a plank that
    // comes back with letters on it is this reference and not a bad prompt.
    styleRef: 'button-wood.png',
    material: 'plain cream parchment',
    // three faces stacked, because 12.13 specifies the pressed state moves 2px
    // down and loses its shadow, and a disabled state has to read as not-yet
    // rather than as refused
    faces: ['raised', 'pressed', 'disabled'],
    what: 'The wide button, whose label is often a sentence rather than a verb.',
    why:
      'The choice planks under the dialogue box are the whole decision-making vocabulary a module author has. Their labels are sentences, not verbs: size this for something like "Take the long way round the headland and lose the light".',
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
    elements: ['window'],
    elementsWhy: 'a well is a frame with a middle, and window is the measured value that returns one complete piece',
    // the dark walnut rounded square with a thin rope line and a paper field
    // inside it. Nearest thing on the shelf to a hole rather than a raised plate.
    styleRef: 'panel-square.png',
    material: 'sunken cream parchment',
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
    /* window forces one complete piece and this type owes two faces, so a socket that returns only the empty face wants a sheet tier */
    elements: ['window'],
    elementsWhy: 'window forces one complete piece and this type owes two faces, so it is the one ground where the lever and the type disagree',
    styleRef: 'panel-square.png',
    material: 'plain cream parchment',
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
    /* window and not the widget's own name: elements:['button'] came back with BUTTON painted in and one face instead of three */
    elements: ['window'],
    elementsWhy: 'the endpoint has a name for this exact piece',
    // the walnut and brass of panel-square.png, which is the only shipped
    // material with rivets and a rope line on it. No bar art ships, so this is
    // the nearest material rather than a match.
    styleRef: 'panel-square.png',
    /* NO INTERIOR PHRASE. A gauge's middle is a channel a fill runs along, not a
     * surface a sentence prints on, so naming parchment here would paper over
     * the one part of the piece that has to read as empty. */
    material: null,
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
    /* window and not the widget's own name: elements:['button'] came back with BUTTON painted in and one face instead of three */
    elements: ['window'],
    elementsWhy: 'a toolbar is the endpoint\'s word for a track holding a run of entries',
    styleRef: 'panel-square.png',
    // a rail's middle is where entries mount, so it stays bare wood
    material: null,
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
    /* window and not the widget's own name: elements:['button'] came back with BUTTON painted in and one face instead of three */
    elements: ['window'],
    elementsWhy: 'the endpoint has a name for this exact piece',
    // same family and same scale as the plank, and a tab that does not match the
    // plank beside it in the Handbook is the thing a shelf exists to prevent
    styleRef: 'button-wood.png',
    material: 'plain cream parchment',
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
    /* window and not the widget's own name: elements:['button'] came back with BUTTON painted in and one face instead of three */
    elements: ['window'],
    elementsWhy: 'the endpoint has a name for this exact piece',
    styleRef: 'panel-square.png',
    /* no interior phrase: the middle is an aperture a drawn person is composited into, so any material shows round their edges */
    material: null,
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
    // a window is literally a frame you see through, which is the one element
    // name that agrees with fill:false instead of fighting it
    elements: ['window'],
    elementsWhy: 'a window is a frame seen through, which is the only element name that agrees with an empty centre',
    styleRef: 'panel-square.png',
    // its middle is the map. Anything named here is paint over the map's own art.
    material: null,
    // THE ONE PIECE DRAWN WITH ITS CENTRE EMPTY. The painting dims and one
    // anchor's region stays lit; the dim is engine geometry and only the lit
    // region's edge is drawn. A filled centre here would paint over the art.
    fill: false,
    what: 'A ring around a rectangle an author drew, with nothing in the middle.',
    why: 'A host introducing their space, pointing at the things in it. One beat, reskinned for every island that has one.',
    caution: 'It has no regions. It is a ring, and it is the only piece whose slice record sets fill to false.',
    regions: [],
  }),

  /* the six sheets go to generate-image-v2 which has no element list, and each canvas is cut to its family because eight marks asked on 512x512 came back twelve */
  T({
    name: 'chip',
    label: 'Chip sheet',
    tier: 'sheet',
    order: 6,
    stretch: 'none',
    // one row of three tokens
    w: 384,
    h: 160,
    // it WAS ['icon_button'], which forces one complete control out of a type
    // that exists to draw a family of them at one weight
    elements: null,
    elementsWhy: 'a sheet is painted on /v2/generate-image-v2, which has no element list at all, because the ui route draws panels even when it is asked for marks',
    // control scale, and the plate this sheet is drawing a family of
    styleRef: 'button-wood.png',
    material: null,
    /* the three faces are named rather than left open, because an open family lets the cut accept whatever came back */
    faces: ['plate', 'plate_lit', 'plate_spent'],
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
    // one row of five tokens
    w: 512,
    h: 160,
    elements: null,
    elementsWhy: 'a sheet is painted on /v2/generate-image-v2, which has no element list at all, because the ui route draws panels even when it is asked for marks',
    /* crest-panther.png is the only reference with no frame on it, so a small token cannot copy a panel's frame */
    styleRef: 'crest-panther.png',
    material: null,
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
    // two rows of four marks
    w: 512,
    h: 256,
    elements: null,
    elementsWhy: 'a sheet is painted on /v2/generate-image-v2, which has no element list at all, because the ui route draws panels even when it is asked for marks',
    styleRef: 'crest-panther.png',
    material: null,
    /* named rather than left open, because an open family cannot be cut: one big blob and a correct sheet look the same to the count */
    faces: ['compass', 'key', 'star', 'lock', 'tick', 'cross', 'arrow', 'coin'],
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
    // one row of four frames
    w: 384,
    h: 160,
    elements: null,
    elementsWhy: 'a sheet is painted on /v2/generate-image-v2, which has no element list at all, because the ui route draws panels even when it is asked for marks',
    styleRef: 'crest-panther.png',
    material: null,
    /* frames and not states, numbered rather than described, because nobody has drawn the loop yet */
    faces: ['frame_1', 'frame_2', 'frame_3', 'frame_4'],
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
    // one row of three marks, which are chunkier than an icon
    w: 512,
    h: 192,
    elements: null,
    elementsWhy: 'a sheet is painted on /v2/generate-image-v2, which has no element list at all, because the ui route draws panels even when it is asked for marks',
    styleRef: 'crest-panther.png',
    material: null,
    // the three the record actually asks for, and it was one face called `mark`
    // with the family left open. A stamp says a specific word without lettering:
    // approved on a form, sealed on a year sheet, awarded on a cord row.
    faces: ['approved', 'sealed', 'awarded'],
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
    // two rows of three markers
    w: 384,
    h: 256,
    elements: null,
    elementsWhy: 'a sheet is painted on /v2/generate-image-v2, which has no element list at all, because the ui route draws panels even when it is asked for marks',
    styleRef: 'crest-panther.png',
    material: null,
    // the record's five plus the hand, which is the one the record left out: a
    // pointer set is an arrow and a hand cursor, and the five below are all
    // arrows of one kind or another
    faces: ['chevron', 'hand', 'trail_dot', 'bearing', 'pin_tail', 'pin_plate'],
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
    /* a painting still needs the shape lever, because the alternative to a list is a kit and a kit is not a cover plate */
    elements: ['window'],
    elementsWhy: 'the alternative to a list is a kit, and a kit is not a painting',
    // the one painted whole that ships: a chart on parchment between two wooden
    // rollers, sage sea, compass rose
    styleRef: 'chart-cover.png',
    // its middle IS the illustration, so naming a surface there would flatten
    // the one type whose centre is meant to be busy
    material: null,
    what: 'A full-bleed illustration with a title over a place name, a filling bar and one fact under it.',
    why:
      'It is the first one that gets made twenty times by twenty people, which is exactly why it is a type with a fixed region layout rather than twenty freehand pictures.',
    caution:
      'It is not a nine-slice and it does not stretch, so it takes no edge numbers. The fact under it is drawn from a pool the game owns, so the sentence length is not bounded.',
    regions: [
      { name: 'title', kind: 'text', required: true },
      { name: 'fact', kind: 'text', required: false },
      { name: 'gauge_track', kind: 'fill', required: false },
    ],
  }),

  /* the two named so nobody generates them, with no levers because createUi refuses tier none before anything is spent */
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

/* the type names are reserved before any row exists, because a flag on a row cannot hold the fence on an empty shelf */
export const CORE_NAMES = PIECE_TYPES.filter((t) => t.tier !== 'none').map((t) => t.name)
const CORE = new Set(CORE_NAMES)

/* the size is aspect-gated and the maxima do not combine, so 688x512 is refused after the money is committed */
/* the tier picks the route: create-ui-asset returned panels when asked for icons and chips, so sheets go to generate-image-v2 */
export const usesImageEndpoint = (t) => !!t && t.tier === 'sheet'

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

/* the sheet route's floor is 171 and not 192, because under 171 on the long side the endpoint returns a grid of variants of one mark */
export function sheetCanvas(w, h) {
  const want = { w: Math.max(1, num(w, 0)), h: Math.max(1, num(h, 0)) }
  const got = fitSheet(want.w, want.h)
  return {
    ...got,
    ok: got.width === want.w && got.height === want.h,
    gates: UI_GATES.map(([, gw, gh]) => ({ w: gw, h: gh })),
    floor: SHEET_ONE_IMAGE,
  }
}

// one call site in the route, so it cannot check a sheet against the panel
// route's limits, which is what a second `if` on the tier over there would
// eventually do
export const canvasFor = (t, w, h) => (usesImageEndpoint(t) ? sheetCanvas(w, h) : legalCanvas(w, h))

/* the description goes to the planner with the type's context and the planner writes the pixellab prompt: hand-prompting two pieces without it costs about 240 generations */

/* ornament only in the corners: an anchor at top and bottom centre smeared into a row of half anchors as soon as the box widened */
export const NINE_SLICE_LAW = [
  'THIS PIECE IS NINE-SLICED, so the picture has to survive being cut into nine and stretched.',
  '- ORNAMENT GOES IN THE CORNERS. The four corners are the only part that is never repeated and never stretched, so they are the only place a motif, a rivet, a carving or an emblem can live.',
  '- THE EDGES REPEAT, so each edge has to be a plain even run of one material along its whole length. Nothing centred on an edge and nothing that reads as a middle. Two pieces already failed here: an anchor drawn at top centre and bottom centre smeared into a row of half anchors as soon as the box was widened.',
  '- THE MIDDLE HOLDS TEXT, so it is plain: one flat or softly grained surface with no crest, no knot, no seam and no illustration in it. Whatever is painted there is what a sentence prints on top of.',
].join('\n')

/* WHAT EACH TIER OWES, in the words the router needs rather than the words the
 * publish gate needs. The publish gate's version is checkUi and checkSlices;
 * this one is the same three rules said forward, before the picture exists. */
const TIER_LAW = {
  ground: NINE_SLICE_LAW,
  /* the sheet brief names its three failures as refusals, because on this route with no element list the model reaches for a frame, a panel under each mark, and one big object */
  sheet:
    'THIS PIECE IS A SHEET: one canvas holding a GRID OF SEPARATE SMALL MARKS, cut apart afterwards by rectangles measured off the picture. ' +
    'Draw the marks evenly spaced in rows on a fully transparent canvas, all at one weight and one scale, each one whole and complete, with clear empty space between them so a rectangle can be drawn round each without touching its neighbour. ' +
    'THERE IS NO FRAME AROUND THE WHOLE THING. No border, no card, no sheet of paper, no wooden surround and no background behind the group: the transparent canvas is the only thing holding them together. ' +
    'THERE IS NO PANEL UNDER ANY MARK. Each one is the bare silhouette of the thing itself, not a thing sitting on a plate, in a button or inside a box, unless the mark IS a plate. ' +
    'THEY ARE SMALL AND THERE ARE MANY. This is not one large object filling the canvas; it is a set of small ones with air around each. ' +
    'THE CANVAS IS ALREADY CUT TO FIT THIS FAMILY, so there is no leftover space to fill and no mark is ever drawn twice. Measured on the first roll: eight marks asked for on a canvas with an empty bottom third came back as twelve, the last four a repeat of the row above them. ' +
    'No lettering anywhere on it. ' +
    'THE WHOLE FAMILY IS DRAWN IN THIS ONE JOB, and that is the reason it is a sheet at all rather than one generation per mark: this repo measured it on character headings and on states, and a family split across jobs comes back at different weights, different sizes and a drifted palette. Everything on this canvas has to look like it was cut from the same die.',
  painted:
    'THIS PIECE IS A PAINTED WHOLE: one full-bleed illustration, not a frame and not a nine-slice. ' +
    'It never stretches and it takes no edge numbers, so the composition is fixed. ' +
    'Leave the areas the regions name legible enough to print words over, and keep the busy part of the picture away from them.',
}

/* the reference is matched on what a piece is MADE OF, because a style image transfers material and carries no layout at all */
const CHROME_FALLBACK = 'panel-square.png'

export const chromeRef = (type) => {
  const t = pieceType(type)
  // a type that deliberately has none answers null rather than the fallback, so
  // the caller can say "no reference" out loud instead of quietly sending the
  // wrong wood. Only the two ungenerated types are in that case.
  if (t) return t.styleRef
  return CHROME_FALLBACK
}

/* the router gets what, why and caution verbatim, because a paraphrased caution is a caution with the specific thing filed off */
export function typeBrief(t, { width, height, shelf = [] } = {}) {
  if (!t) return []
  const w = num(width, t.w) || t.w
  const h = num(height, t.h) || t.h
  const lines = [
    `THE PIECE TYPE IS "${t.name}" (${t.label}).`,
    `What it is for: ${t.what}`,
    `Where it is used, which is what its shape has to survive: ${t.why}`,
    `The trap on this type, in the record's own words: ${t.caution}`,
    ``,
    TIER_LAW[t.tier] || '',
    ``,
    /* the floor differs by route, so saying 192 to a sheet would be a lie: the panel route starts at 192 and the image route at 16 */
    t.tier === 'sheet'
      ? `THE CANVAS IS ${w} BY ${h} AND IT IS NOT NEGOTIABLE. It is big enough to hold the whole family with air around every mark, and it is decided before you are asked. Compose for that shape: think about how many rows and how many per row, not about how big to make the canvas.`
      : `THE CANVAS IS ${w} BY ${h} AND IT IS NOT NEGOTIABLE. It is aspect-gated by the generator and both sides start at 192, so it is decided before you are asked and nothing you write can change it. Compose for that shape.`,
  ]
  const STRETCH = {
    both: 'It stretches on BOTH axes: it is drawn once and appears at several widths AND several heights.',
    x: 'It stretches HORIZONTALLY only: its height is what it is drawn at, and its width changes with what it is holding.',
    y: 'It stretches VERTICALLY only: its width is what it is drawn at, and its height changes with how many entries it holds.',
    none: 'It does NOT stretch. It draws at one size, so nothing in it has to survive being pulled.',
  }
  lines.push(STRETCH[t.stretch] || STRETCH.none)
  if (t.fill === false)
    lines.push(
      `ITS MIDDLE IS EMPTY. This one is a ring drawn round a hole: the map shows through the centre, so anything painted in the middle is paint over the game.`,
    )
  /* the count is exact because the cut counts shapes against this list, so an extra flourish and a dropped mark both refuse the cut */
  if (Array.isArray(t.faces) && t.faces.length)
    lines.push(
      ``,
      `IT NEEDS EXACTLY THESE ${t.faces.length}, ALL IN THIS ONE DRAWING: ${t.faces.join(', ')}.`,
      `EXACTLY ${t.faces.length}, no more and no fewer, and nothing else on the canvas. The picture is cut apart afterwards by counting the separate shapes on it and handing them these names in reading order, so one extra flourish and one missing mark are the same failure.`,
      /* keep face names out of the prompt entirely: a name written beside a mark came back painted under it, straight through the no-lettering clause */
      `DO NOT WRITE THESE NAMES INTO YOUR ANSWER. They are addresses for the cut that happens afterwards, not part of the picture. Say WHERE each mark goes instead, by its place in the grid, in the same reading order as the list above: left to right along the top row, then the next row. A name written beside a mark reads as a caption and comes back painted under it, which has already happened once.`,
      `Any of them that are the same object in a different state must be identical in size, weight and palette and differ only in the thing that changed. The ones that are different objects still share one weight, one scale and one palette, because they were drawn together.`,
    )
  /* the generator never sees the regions, so the router names them or a sentence ends up printing over a carved crest */
  const marks = Array.isArray(t.regions) ? t.regions : []
  if (marks.length)
    lines.push(
      ``,
      `RECTANGLES GET MARKED ON THIS PICTURE AFTERWARDS AND THE GAME DRAWS INTO THEM. Leave room for them and leave those areas plain:`,
      ...marks.map((r) => `- ${r.name} (${r.kind}${r.required ? ', required' : ''})`),
      `Nothing in your description draws the contents of those: no lettering, no numbers, no portrait, no icons. The picture is the empty furniture and the game fills it.`,
    )
  else lines.push(``, `No rectangles are marked on this one, so it is the whole picture and nothing is drawn into it.`)
  /* the model is told what it is NOT responsible for, because re-asking in words for shape or material loses to the two levers */
  if (Array.isArray(t.elements) && t.elements.length)
    lines.push(
      ``,
      `THE SHAPE IS ALREADY FORCED, so do not spend words on it. The generator is being told to scaffold this from its own "${t.elements.join('", "')}" element, and that is what returns ONE complete centred piece instead of a sheet of loose parts with the piece cropped off the top. Measured over five rolls: sending that list is the only thing that decides it, and no wording does.`,
    )
  else if (t.tier === 'sheet')
    lines.push(
      ``,
      `THIS ONE GOES TO A DIFFERENT GENERATOR AND THAT CHANGES WHAT YOUR WORDS DO. The panel endpoint scaffolds from a list of twelve interface element names and draws a panel whatever it is asked for: measured, an icon set came back as panels and round chip tokens came back as panels. So a sheet is painted on the plain image endpoint instead, which has no element list, no shape template and no camera. Nothing forces the composition except what you write, so the arrangement is entirely yours and the failure is entirely yours too.`,
    )
  if (t.material)
    lines.push(
      ``,
      `ITS INSIDE SURFACE IS ${String(t.material).toUpperCase()}, and code appends that to the prompt whatever you write, so it does not need saying twice. What it needs from you is the FRAME: the material round the outside, how it is worn, and where the ornament sits.`,
    )
  const drawn = shelf.filter((u) => u && u.status === 'ready' && u.description)
  if (drawn.length)
    lines.push(
      ``,
      `ALREADY ON THIS SHELF, and the new piece has to look like it came out of the same workshop:`,
      ...drawn.slice(0, 12).map((u) => `- ${u.name}${u.type ? ` (${u.type})` : ''}: ${String(u.description).slice(0, 160)}`),
    )
  return lines.filter((s) => s !== null && s !== undefined)
}

// ---- regions ---------------------------------------------------------------

/* a missing name is refused rather than invented because the name is the address a grape holds, and the four numbers are checked before num() rounds an unreadable one to 0 */
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

/* the slice is in source pixels because that is the one unit border-image and NineSliceSprite agree on, and scale exists so the game never invents the draw thickness */
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

/* slice.top plus slice.bottom must stay under h, or CSS drops the whole border image with no error anywhere */
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
  /* border-image defaults fill off, so a panel without it renders as a ring around a hole, and only the highlight edge wants that */
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

/* the css shape is decided here rather than on the page, because a page that re-derives it is a second copy that drifts */
/* dialogue_box mounts in the game as `dialogue`, and emitting the store's own name gives a selector matching no element and a var() nothing defines */
const CSS_HANDLE = { dialogue_box: 'dialogue' }

export function sliceCss(name, rec, ver = '') {
  if (!hasSlices(rec)) return ''
  const h = CSS_HANDLE[name] || name
  /* the sha goes in the url because the image route answers immutable for a year, and renaming a piece to force art through is a broken address */
  const url = `/api/v1/ui/${name}/image${ver ? `?v=${String(ver).slice(0, 12)}` : ''}`
  const { top, right, bottom, left } = rec.slice
  const k = rec.scale
  const px = [top, right, bottom, left].map((n) => `${n * k}px`).join(' ')
  const rep = rec.repeat.x === rec.repeat.y ? rec.repeat.x : `${rec.repeat.x} ${rec.repeat.y}`
  /* the properties must sit in a :root block or css error recovery eats them and the whole string parses to zero rules; the url fallback and the transparent border colour are both load-bearing when a game token is absent */
  return [
    `:root {`,
    `  --kit-slice-${h}: ${top} ${right} ${bottom} ${left};`,
    `  --kit-slice-w-${h}: ${px};`,
    `  --kit-repeat-${h}: ${rep};`,
    `}`,
    ``,
    `.kit-surface-${h} {`,
    `  border-style: solid;`,
    `  border-color: transparent;`,
    `  border-width: var(--kit-slice-w-${h});`,
    `  border-image: var(--kit-art-${h}, url('${url}')) var(--kit-slice-${h})${rec.fill ? ' fill' : ''} / 1 / 0 var(--kit-repeat-${h});`,
    `}`,
  ].join('\n')
}

/* one definition of a cut, narrowed to `face`: two definitions disagreed and a gauge reported itself fully cut while the consumer got nothing */
const isCut = (r) => r.kind === 'face'

// ---- what a piece is not allowed to be -------------------------------------

/* a region off the picture is refused rather than clamped, because clamping hands back a rectangle the author never drew */
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
      const cut = new Set(regions.filter(isCut).map((r) => r.name))
      for (const f of type.faces) if (!cut.has(f)) warnings.push(`the "${f}" face has not been cut yet`)
    }
  }
  const sl = checkSlices(asset?.slices, asset.w, asset.h, type)
  return { problems: problems.concat(sl.problems), warnings: warnings.concat(sl.warnings) }
}

// ---- cutting the hero out of a family --------------------------------------

/* the endpoint returns the hero in a tray of offcuts and border-image has no source rect, so the hero is cut out at import or the four slice numbers point at the tray; this is a scan and arithmetic that refuses rather than guessing */

/* alpha 40, the same threshold publish.mjs and trimToFeet use, and chrome pixels measure as either 0 or 224 up with nothing between */
const PIECE_ALPHA = 40

/* only a ground has a hero: cropping a sheet to its largest cut throws the other twenty away, and a cover plate's canvas is the picture */
export const cropsToHero = (type) => !!type && type.tier === 'ground'

/* an explicit stack because recursion over 264,192 pixels overflows, eight-connected so a frame joined at a corner is one piece, sorted biggest first */
export function opaqueRegions(w, h, data) {
  const label = new Int32Array(w * h).fill(-1)
  const stack = new Int32Array(w * h)
  const out = []
  /* dx,dy and not a flat offset, because -1 on column zero wraps to the row above and reads a whole family as one region */
  const DX = [-1, 0, 1, -1, 1, -1, 0, 1]
  const DY = [-1, -1, -1, 0, 0, 1, 1, 1]
  for (let seed = 0; seed < w * h; seed++) {
    if (label[seed] >= 0 || data[seed * 4 + 3] <= PIECE_ALPHA) continue
    const id = out.length
    let sp = 0
    stack[sp++] = seed
    label[seed] = id
    let x0 = seed % w
    let x1 = x0
    let y0 = (seed / w) | 0
    let y1 = y0
    let area = 0
    while (sp) {
      const at = stack[--sp]
      const px = at % w
      const py = (at / w) | 0
      area++
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      for (let n = 0; n < 8; n++) {
        const nx = px + DX[n]
        const ny = py + DY[n]
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const to = ny * w + nx
        if (label[to] >= 0 || data[to * 4 + 3] <= PIECE_ALPHA) continue
        label[to] = id
        stack[sp++] = to
      }
    }
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, pixels: area })
  }
  return out.sort((a, b) => b.pixels - a.pixels)
}

/* three checks off two measured families: the hero box is 30 to 36 percent of its canvas against under 4 for a tray button, nothing else may sit inside it, and its aspect runs 1.59 to 2.69 times the canvas ratio */
const ASPECT_BAND = [0.5, 6]

export function heroBox(w, h, data, type) {
  const regions = opaqueRegions(w, h, data)
  const say = (why) => ({ box: null, regions, why })
  if (!regions.length) return say('every pixel in it is transparent, so there is no piece in there to find')
  const box = { x: regions[0].x, y: regions[0].y, w: regions[0].w, h: regions[0].h }
  const share = (box.w * box.h) / (w * h)
  if (share < 0.25)
    return say(
      `the largest shape in it is ${box.w}x${box.h}, only ${Math.round(share * 100)}% of a ${w}x${h} picture, and a hero piece is never that small a part of its own canvas`,
    )
  const inside = regions
    .slice(1)
    .find((r) => box.x < r.x + r.w && r.x < box.x + box.w && box.y < r.y + r.h && r.y < box.y + box.h)
  if (inside)
    return say(
      `the largest shape runs ${box.x},${box.y} to ${box.x + box.w},${box.y + box.h} and another shape at ${inside.x},${inside.y} sits inside that, so a cut there would carry part of its neighbour`,
    )
  const want = type && type.w > 0 && type.h > 0 ? type.w / type.h : w / h
  const got = box.w / box.h
  if (got < want * ASPECT_BAND[0] || got > want * ASPECT_BAND[1])
    return say(
      `the largest shape is ${box.w}x${box.h}, a ratio of ${got.toFixed(2)} against the ${want.toFixed(2)} this kind of piece is drawn at, which is too far off to be the piece`,
    )
  return { box, regions, why: '' }
}

/* decoded once and handed to both halves, because inflating a quarter of a million pixels twice is paid on every import */
export function cropHero(png, type) {
  const { w, h, data } = decodePNG(png)
  const found = heroBox(w, h, data, type)
  const out = { canvas: { w, h }, box: found.box, regions: found.regions.length, why: found.why, png: null }
  if (!found.box) return out
  const { x, y, w: bw, h: bh } = found.box
  const cut = new Uint8ClampedArray(bw * bh * 4)
  for (let row = 0; row < bh; row++) {
    const from = ((y + row) * w + x) * 4
    cut.set(data.subarray(from, from + bw * 4), row * bw * 4)
  }
  out.png = encodePNG(bw, bh, cut)
  return out
}

// ---- cutting the faces out of a sheet --------------------------------------

/* a sheet has no hero, so the answer is every shape over a floor in reading order, and a failed check stores nothing rather than handing `lock` to whatever shape came fourth */

/* the speck floor is relative to the biggest mark, because an absolute pixel count is wrong on the next canvas size */
const FACE_SPECK = 0.01

/* AND A TWO PIXEL SHAPE IS NEVER A MARK whatever the biggest one is, because on
 * a sheet that came back as one big object the biggest is the whole canvas and
 * the relative floor would let every crumb through. */
const FACE_MIN_SIDE = 4

/* half to triple is loose on purpose, because names are only handed out on an exact count and this only has to catch 1-against-8 or dozens of crumbs */
const FACE_BAND = [0.5, 3]

/* a band sort and not a sort on y, because marks in one row do not share a y and a plain y sort interleaves the rows */
function readingOrder(boxes) {
  const left = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows = []
  for (const b of left) {
    const row = rows.find((r) => b.y < r.bottom && r.top < b.y + b.h)
    if (row) {
      row.items.push(b)
      row.top = Math.min(row.top, b.y)
      row.bottom = Math.max(row.bottom, b.y + b.h)
    } else rows.push({ top: b.y, bottom: b.y + b.h, items: [b] })
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x))
}

/* a non-empty `why` means the cut refused and nothing is stored; a non-empty `note` means it kept positional face_1 names because the count was inside the band but not exact */
export function cutFaces(png, type) {
  const { w, h, data } = decodePNG(png)
  const want = Array.isArray(type?.faces) ? type.faces : []
  const out = { canvas: { w, h }, faces: [], found: 0, want: want.length, why: '', note: '' }
  const no = (why) => ({ ...out, why })
  if (!want.length) return no('this type names no faces, so there is no list to cut against')

  const all = opaqueRegions(w, h, data)
  if (!all.length) return no('every pixel in it is transparent, so there are no marks on it to cut')
  const biggest = all[0].w * all[0].h
  const marks = all.filter((r) => r.w >= FACE_MIN_SIDE && r.h >= FACE_MIN_SIDE && (r.w * r.h) / biggest >= FACE_SPECK)
  out.found = marks.length

  /* overlapping boxes merge because no pair of rectangles can separate them, and a paw print is five shapes a person sees as one; repeated until nothing moves */
  for (let again = true; again; ) {
    again = false
    outer: for (let i = 0; i < marks.length; i++)
      for (let j = i + 1; j < marks.length; j++) {
        const a = marks[i]
        const b = marks[j]
        if (!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)) continue
        const x = Math.min(a.x, b.x)
        const y = Math.min(a.y, b.y)
        marks[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y, pixels: a.pixels + b.pixels }
        marks.splice(j, 1)
        again = true
        break outer
      }
  }
  // the count the checks below work on is the count AFTER merging, because a
  // paw reported as five pads is not five marks
  out.found = marks.length

  /* TWO · THE COUNT IS IN THE RIGHT COUNTRY. One shape against a want of eight
   * is the sheet coming back as one big object, which is the failure this whole
   * second path exists to get past. */
  const low = Math.max(1, Math.floor(want.length * FACE_BAND[0]))
  const high = Math.ceil(want.length * FACE_BAND[1])
  if (marks.length < low)
    return no(
      `${want.length} marks were asked for and only ${marks.length} separate shape${marks.length === 1 ? '' : 's'} came back, which is what a sheet drawn as one big object looks like`,
    )
  if (marks.length > high)
    return no(`${want.length} marks were asked for and ${marks.length} separate shapes came back, so this is not a grid of ${want.length} things`)

  /* names are only handed out on an exact count, because nine shapes where eight were asked for makes the fourth one not `lock` */
  const order = readingOrder(marks)
  const exact = marks.length === want.length
  if (!exact)
    out.note =
      `${marks.length} marks came back where ${want.length} were asked for, so the cuts are numbered rather than named: ` +
      `handing out ${want.join(', ')} in this order would give at least one of them the wrong shape`
  out.faces = order.map((r, i) => ({
    name: exact ? want[i] : `face_${i + 1}`,
    kind: 'face',
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
  }))
  return out
}

// ---- reading ---------------------------------------------------------------

/* the wire shape is the slice record verbatim, and `faces` is a projection of the regions rather than a second list that would disagree the first time one is dragged */
/* the same staleness window pendingUi uses, because two copies of the number drift */
const PENDING_MS = 10 * 60 * 1000

/* the base is an argument because names are unique per account, and a hard-coded /api/v1 src served two people's `binder` one picture to measure against */
/* `full` is only emitted on the scoped base, because /api/v1 has no route for it and the url would 404 */
const OWN_BASE = '/api/ui'

const shape = (r, base = '/api/v1/ui') => {
  const regions = Array.isArray(r.regions) ? r.regions : []
  const crop = r.crop && typeof r.crop === 'object' && r.crop.w > 0 ? r.crop : null
  const slices = r.slices && typeof r.slices === 'object' && r.slices.slice ? r.slices : null
  /* aged out on read rather than by a sweeper, because failUi only runs in the route's catches and a process restart stranded the row as pending forever */
  const status = r.status === 'pending' && r.created_at && Date.now() - +new Date(r.created_at) > PENDING_MS ? 'failed' : r.status
  return {
    name: r.name,
    type: r.type || '',
    title: r.title,
    description: r.description,
    w: r.w,
    h: r.h,
    status,
    core: !!r.core,
    published: !!r.published,
    regions,
    faces: regions.filter(isCut).map(({ name, x, y, w, h }) => ({ name, x, y, w, h })),
    ...(slices ? { ...slices, css: sliceCss(r.name, slices, r.img_sha) } : {}),
    ...(r.blob_key ? { src: `${base}/${r.name}/image` } : {}),
    /* the content hash rides on the row so the emitted css url changes when the picture does, since the image route answers immutable for a year */
    ...(r.img_sha ? { sha: r.img_sha } : {}),
    /* WHAT WAS CUT, AND THE FAMILY IT WAS CUT OUT OF, so a bad crop is visible
     * and undoable rather than a picture that quietly got smaller. */
    ...(crop ? { crop, ...(base === OWN_BASE ? { full: `${base}/${r.name}/full` } : {}) } : {}),
    /* AND A REFUSAL SAYS SO ON THE ROW. The scan could not prove which shape
     * was the hero, kept the whole image, and this is the sentence saying which
     * check stopped it and that a hand crop is owed. */
    ...(r.crop_note ? { cropNote: r.crop_note, needsCrop: true } : {}),
    ...(r.pixellab_id ? { pixellabId: r.pixellab_id } : {}),
    createdAt: r.created_at ? +new Date(r.created_at) : 0,
  }
}

// the owner's own shelf, so every picture on this page is that account's row and
// not whichever row across the platform happened to share the name
export async function listUi(ownerId) {
  if (!ownerId) return []
  const rows = await many('select * from ui_assets where owner_id = $1 order by core desc, name', [ownerId])
  return rows.map((r) => shape(r, OWN_BASE))
}

export async function getUiByName(ownerId, name) {
  if (!ownerId || !isName(name)) return null
  const r = await one('select * from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  return r ? shape(r, OWN_BASE) : null
}

/* sha1 and base64url because this is a change detector rather than a signature, and it has to fit in a url */
const shaOf = (buf) => crypto.createHash('sha1').update(buf).digest('base64url')

/* the row's sha is checked against the bytes because blobs.mjs only evicts on a write through the same process, so a CLI write leaves a running dev server serving stale bytes */
async function currentBytes(key, sha, alsoForget = '') {
  if (!key) return null
  try {
    const buf = await store().get(key)
    if (!buf || !sha || shaOf(buf) === sha) return buf
    store().forget(key)
    if (alsoForget) store().forget(alsoForget)
    return await store().get(key)
  } catch {
    return null
  }
}

// one account's own bytes, because the published route has no account in its path and picks core-then-oldest across all of them
export async function ownedUiImage(ownerId, name) {
  if (!ownerId || !isName(name)) return null
  const r = await one('select blob_key, full_key, img_sha from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  if (!r?.blob_key) return null
  return currentBytes(r.blob_key, r.img_sha, r.full_key)
}

/* THE FAMILY THE HERO WAS CUT OUT OF, kept so a crop can be looked at and
 * undone. Owner-scoped only: this is working material and the game consumes the
 * piece rather than the sheet it arrived on. */
export async function ownedUiFull(ownerId, name) {
  if (!ownerId || !isName(name)) return null
  const r = await one('select full_key from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  if (!r?.full_key) return null
  try {
    return await store().get(r.full_key)
  } catch {
    return null
  }
}

/* the read api has no account in its path, so a name owned twice is settled core first then oldest, the only order consistent with core chrome never being overridable */
export async function readyUi() {
  /* distinct on, because a duplicate name folded into a map by name lets the newest member row win and overrides core silently */
  return (await many(`select distinct on (name) * from ui_assets where status = 'ready' order by name, core desc, created_at`)).map((r) =>
    shape(r),
  )
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
  const r = await one(
    `select blob_key, full_key, img_sha from ui_assets where status = 'ready' and name = $1 order by core desc, created_at limit 1`,
    [name],
  )
  if (!r?.blob_key) return null
  return currentBytes(r.blob_key, r.img_sha, r.full_key)
}

/* one generation at a time, asked rather than trusted, and age-limited so a row stranded by a dead process cannot lock the account out for good */
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

/* two fences, because the row flag only holds once a core piece exists and the reserved name list is what holds on an empty shelf */
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

/* the row exists before the picture so it is poll-able, and a regenerate replaces in place keeping the regions and slices already measured on it */
export async function createUi({ ownerId, name, type = '', title = '', description = '', w, h, pixellabId = '', core = false }) {
  if (!ownerId) throw new Error('a piece needs an account to belong to')
  if (!isName(name)) throw new Error(`"${name}" is not a legal piece name; it has to read as a python identifier`)
  const t = type ? pieceType(type) : null
  if (type && !t)
    throw new Error(`there is no piece type called "${type}" · the kit has ${PIECE_TYPES.length} of them and a piece has to be one`)
  /* tier none is refused here because a sign is map-scale world art and a row is typography, so both come back unusable and the spend is wasted */
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

/* w and h come off the png and not off the ask, because the generator answers with the canvas it chose and a rect measured against the wrong size draws in the wrong place */
export async function setUiImage(ownerId, name, buf, w, h, pixellabId = '', { crop = true } = {}) {
  if (!ownerId || !isName(name)) throw new Error('no piece to put a picture on')
  const key = `ui/${ownerId}/${name}.png`
  const fullKey = `ui/${ownerId}/${name}.full.png`

  /* the hero is cut at import so the row is never in a state where the marks and the picture disagree, and crop:false is for a restore, which cropping would shrink again on every run */
  const row = await one('select type, regions from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  const t = row?.type ? pieceType(row.type) : null
  let img = buf
  let box = null
  let note = ''
  if (crop && cropsToHero(t)) {
    try {
      const cut = cropHero(buf, t)
      note = cut.why
      // a picture that is already one piece needs no cut, and cutting it would
      // write a second copy of the same bytes under .full for nothing
      if (cut.box && !(cut.box.w === cut.canvas.w && cut.box.h === cut.canvas.h)) {
        img = cut.png
        box = cut.box
      }
    } catch (e) {
      note = `the picture could not be read to find the piece in it (${String(e.message || e)}), so the whole image is kept`
    }
  }

  /* a sheet is cut at the same moment, and the new faces replace the old ones because a face is a cut of one specific picture; regions of other kinds survive */
  let faces = null
  if (crop && usesImageEndpoint(t)) {
    try {
      const cut = cutFaces(buf, t)
      // one column, because there is one scan asked two questions and a second
      // column saying the same thing about the other half is a column nobody
      // reads. 024 widens what the comment on it claims.
      note = cut.why || cut.note
      if (!cut.why) faces = cut.faces
    } catch (e) {
      note = `the sheet could not be read to find the marks on it (${String(e.message || e)}), so nothing was cut`
    }
  }

  if (box) {
    // the family first: if the second write fails, the row still points at the
    // old picture and the family is an orphan, which is recoverable. The other
    // order leaves the row pointing at a hero with no family behind it.
    await store().put(fullKey, buf, 'image/png')
    await store().put(key, img, 'image/png')
    w = box.w
    h = box.h
  } else {
    await store().put(key, buf, 'image/png')
    /* A REDRAW THAT DOES NOT CROP MUST NOT LEAVE THE LAST ONE'S FAMILY BEHIND.
     * The row is about to stop claiming a crop, so a `.full` from an earlier
     * import would sit under the undo route as a picture of something else. */
    await store().del(fullKey).catch(() => {})
  }
  /* said out loud even though put() already evicts, because the bug class here is a read handing back bytes a write replaced */
  store().forget(key)
  store().forget(fullKey)

  /* a redraw that changed size drops the slices, because top+bottom >= h would otherwise be stored and reach a consumer with border-image drawing nothing */
  /* the cuts go in with the picture they were measured on, in one statement, so the rectangles and the bytes are never from two drawings */
  const kept = faces ? (Array.isArray(row?.regions) ? row.regions : []).filter((r) => r && r.kind !== 'face') : []
  return one(
    `update ui_assets set blob_key = $3, w = $4, h = $5, status = 'ready',
       pixellab_id = case when $6 <> '' then $6 else ui_assets.pixellab_id end,
       full_key = $7, crop = $8::jsonb, crop_note = $9, img_sha = $10,
       regions = case when $11::boolean then $12::jsonb else ui_assets.regions end,
       slices = case when ui_assets.w = $4 and ui_assets.h = $5 then ui_assets.slices else '{}'::jsonb end
     where owner_id = $1 and name = $2 returning *`,
    [
      ownerId,
      name,
      key,
      Math.max(1, num(w, 256)),
      Math.max(1, num(h, 256)),
      String(pixellabId || ''),
      box ? fullKey : '',
      JSON.stringify(box || {}),
      note,
      shaOf(img),
      !!faces,
      JSON.stringify(faces ? kept.concat(faces) : []),
    ],
  )
}

/* it goes back through setUiImage with the cut off rather than writing the columns itself, so the size change drops the slices by the same rule everything else uses */
export async function uncropUi(ownerId, name) {
  if (!ownerId || !isName(name)) throw new Error('no piece to put back')
  const r = await one('select full_key from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  if (!r) throw new Error(`there is no piece called "${name}" on this account`)
  if (!r.full_key) throw new Error(`"${name}" was never cropped, so there is nothing to put back`)
  const full = await store().get(r.full_key)
  if (!full || full.length < 24) throw new Error(`the picture "${name}" was cut out of is no longer in storage`)
  // the IHDR sits at a fixed offset in every png, the same read styleRef does,
  // because the row's own w and h are the CROP's and are about to be replaced
  const saved = await setUiImage(ownerId, name, full, full.readUInt32BE(16), full.readUInt32BE(20), '', { crop: false })
  return shape(saved, OWN_BASE)
}

// a spend that produced nothing still has to be visible, so the row stays and
// says what happened rather than disappearing as though it was never asked for
export const failUi = (ownerId, name) =>
  q(`update ui_assets set status = 'failed' where owner_id = $1 and name = $2`, [ownerId, name])

/* regions and slices save in one call because they are checked against each other, and a dropped region is reported by count rather than vanishing */
export async function saveUi(ownerId, name, regions, slices) {
  const row = await one('select * from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  if (!row) throw new Error(`there is no piece called "${name}" on this account`)
  const asked = Array.isArray(regions) ? regions : []
  const clean = asked.map(cleanRegion).filter(Boolean)
  const dropped = asked.length - clean.length
  /* slices are only meaningful on a ground, because four edge numbers on a painting or a sheet is a field nothing will ever read */
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
  /* the owner's own base, because the account-less one hands back a src for whichever account won the name and swaps the page under a save */
  return { ...shape(saved, OWN_BASE), warnings }
}

// the name the routes call it by. One implementation, because a second one is a
// second set of refusals that drift apart.
export const setUiRegions = saveUi

/* published is a different fact from the picture arriving: a ground with no edge numbers cannot get here, because the consumer then falls back to squashing the painting into the box */
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
  return { ...shape(saved, OWN_BASE), warnings }
}

// a piece leaves both stores or it comes back on the next listing, the same
// rule dropItem holds a library row to. Core is guarded here too, because
// deleting the dialogue box is the loudest way to override it.
export async function removeUi(ownerId, name, { core = false } = {}) {
  const r = await one('select blob_key, full_key, core from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  if (!r) return false
  if (r.core && !core)
    throw new Error(`"${name}" is core chrome and core chrome is never overridable, so it cannot be removed from a member's side`)
  // the family goes with the hero. A `.full` left behind after the row is gone
  // is object storage nobody can reach and nothing will ever delete, and the
  // next piece to take the name would inherit it as its undo.
  for (const k of [r.blob_key, r.full_key]) if (k) await store().del(k).catch(() => {})
  await q('delete from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  return true
}
