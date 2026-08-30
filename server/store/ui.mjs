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
import crypto from 'node:crypto'
import { q, one, many } from '../db/pool.mjs'
import { store } from './blobs.mjs'
import { decodePNG, encodePNG } from '../sheet.mjs'
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
 * sequence would be arguing with him.
 *
 * ---- THE RECIPE, MEASURED OVER FIVE ROLLS ON 2026-08-30 ------------------
 *
 * Four pictures sit in work/.kit/ and they are the whole of the evidence:
 *
 *   dialogue_box_v2  elements ['window'], NO style image
 *                    -> one clean centred panel, wrong material, generic brown
 *   dialogue_box_v3  style image, NO elements
 *                    -> right material, but it came back a KIT of loose parts
 *                       with the hero panel CROPPED off the top of the canvas
 *   dialogue_box_v4  style image AND elements ['window'] AND a description
 *                    saying one single complete piece, centred, margin on every
 *                    side, nothing touching the edge
 *                    -> the good one
 *   panel            routed through claude, prompt excellent and naming
 *                    parchment out loud, but the CALL dropped `elements` and
 *                    sent the wrong reference art
 *                    -> a brown kit with no parchment in it anywhere
 *
 * SO: `elements` is the lever that decides SHAPE, one complete piece versus a
 * cropped kit. `style_image` is the lever that decides MATERIAL. WORDS DECIDE
 * NEITHER. The panel roll proves that half on its own: the word "parchment" was
 * in the prompt and the picture has none.
 *
 * This repo already carries the same law written down for maps: on a noun
 * pixellab holds a strong prior for, words lose. Levers beat adjectives. The
 * three fields below are the levers, so they live on the TYPE where no caller
 * can drop one, rather than in a body a page fills in.
 *
 *   elements   what forces the shape. ['window'] is the measured one for a
 *              ground and every ground takes it unless the endpoint has a name
 *              for that exact piece.
 *   styleRef   which shipped file in public/chrome is this type's MATERIAL, by
 *              filename, matched on what the picture is made of rather than on
 *              what it is shaped like.
 *   material   what the INTERIOR is made of when it differs from the frame.
 *              Appended by code, because "parchment" written by a model into a
 *              subject is exactly what panel.png had. */
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
    /* IT WAS `panel` AND THAT IS THE ROLL THAT FAILED. work/.kit/panel.png is a
     * brown kit with no parchment: the call dropped the list entirely, so that
     * picture does not clear the endpoint's own element name either way, and
     * `panel` in a ui generator's vocabulary is a flat sub-plate rather than a
     * framed thing you open. `window` is the one value measured to return a
     * single complete centred piece, so the piece that is literally a window on
     * the game takes it. */
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
    elementsWhy: 'measured on dialogue_box_v4, the roll that worked',
    styleRef: 'dialogue-box.png',
    material: 'aged cream parchment, lightly mottled',
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
    /* IT CARRIED NO ELEMENTS AND THE REASON HAS BEEN OVERTAKEN. The old caution
     * said the named parts would scaffold furniture onto a band, which was a
     * theory. The kit that came back from dialogue_box_v3 is a measurement, and
     * it says the alternative to a scaffolded band is not a plain band, it is
     * eighteen loose plates with the band cropped off the top. */
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
    /* NOT `button`, even though the press area is required on it. A plaque is a
     * name plate the world hangs on something and a button is a control that
     * moves when pressed, and the endpoint's `button` element draws the second
     * one. `window` gives the framed plate with a plain middle a label prints
     * into. */
    elements: ['window'],
    elementsWhy: 'a name plate is a framed plate rather than a control that depresses, so window and not button',
    // matched at CONTROL SCALE. button-wood.png is a small walnut plate with a
    // beaded inner line and a parchment face, which is the plaque's material and
    // its size at once. The two big panels are a room's worth of frame at this
    // size.
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
    /* WINDOW, NOT THE WIDGET'S OWN NAME. Measured: elements:['button'] came back as a
     * small button with the word BUTTON painted into it, straight through the
     * code-appended no-lettering clause, one face instead of three, parked in a
     * corner of an otherwise empty canvas. The named widgets carry their own idea
     * of what that control looks like, lettering included, and a lever beats every
     * adjective in the prompt. 'window' is the only value that means draw me one
     * clean framed thing and let the words say what it is. */
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
    /* THE RISKIEST ROW IN THE TABLE AND IT IS SAID OUT LOUD. `window` forces ONE
     * complete piece and this type owes TWO faces in one drawing, so the lever
     * and the type pull against each other. The list stays, because the failure
     * without one is a kit with the hero cropped and that loses both faces
     * rather than one. If a socket comes back with only the empty face on it,
     * this line is why and the answer is a sheet tier, not a longer sentence. */
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
    /* WINDOW, NOT THE WIDGET'S OWN NAME. Measured: elements:['button'] came back as a
     * small button with the word BUTTON painted into it, straight through the
     * code-appended no-lettering clause, one face instead of three, parked in a
     * corner of an otherwise empty canvas. The named widgets carry their own idea
     * of what that control looks like, lettering included, and a lever beats every
     * adjective in the prompt. 'window' is the only value that means draw me one
     * clean framed thing and let the words say what it is. */
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
    /* WINDOW, NOT THE WIDGET'S OWN NAME. Measured: elements:['button'] came back as a
     * small button with the word BUTTON painted into it, straight through the
     * code-appended no-lettering clause, one face instead of three, parked in a
     * corner of an otherwise empty canvas. The named widgets carry their own idea
     * of what that control looks like, lettering included, and a lever beats every
     * adjective in the prompt. 'window' is the only value that means draw me one
     * clean framed thing and let the words say what it is. */
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
    /* WINDOW, NOT THE WIDGET'S OWN NAME. Measured: elements:['button'] came back as a
     * small button with the word BUTTON painted into it, straight through the
     * code-appended no-lettering clause, one face instead of three, parked in a
     * corner of an otherwise empty canvas. The named widgets carry their own idea
     * of what that control looks like, lettering included, and a lever beats every
     * adjective in the prompt. 'window' is the only value that means draw me one
     * clean framed thing and let the words say what it is. */
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
    /* WINDOW, NOT THE WIDGET'S OWN NAME. Measured: elements:['button'] came back as a
     * small button with the word BUTTON painted into it, straight through the
     * code-appended no-lettering clause, one face instead of three, parked in a
     * corner of an otherwise empty canvas. The named widgets carry their own idea
     * of what that control looks like, lettering included, and a lever beats every
     * adjective in the prompt. 'window' is the only value that means draw me one
     * clean framed thing and let the words say what it is. */
    elements: ['window'],
    elementsWhy: 'the endpoint has a name for this exact piece',
    styleRef: 'panel-square.png',
    /* NO INTERIOR PHRASE, and this one would actively hurt. The middle is an
     * aperture a drawn person is composited into, so parchment behind them is a
     * sheet of paper the game then covers, and whatever shows round the edges is
     * wrong. */
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
    // its middle is the map. Anything named here is paint over Ash's art.
    material: null,
    // THE ONE PIECE DRAWN WITH ITS CENTRE EMPTY. The painting dims and one
    // anchor's region stays lit; the dim is engine geometry and only the lit
    // region's edge is drawn. A filled centre here would paint over the art.
    fill: false,
    what: 'A ring around a rectangle an author drew, with nothing in the middle.',
    why: 'Ash\'s own moment at 4.7, pointing at the things at the central platform, and an island host introducing their space is the same beat reskinned.',
    caution: 'It has no regions. It is a ring, and it is the only piece whose slice record sets fill to false.',
    regions: [],
  }),

  /* ---- the six sheets, WHERE THE FAILURE MODE IS THE DELIVERABLE ----------
   *
   * Every sheet below sends NO elements, and that is the one place in this file
   * where dropping the lever is right rather than the bug it is everywhere else.
   *
   * dialogue_box_v3 asked with no list and came back a KIT: a grid of loose
   * parts, evenly spaced, all at one weight, on transparent. That is a defect
   * when one complete panel was wanted and it is the exact definition of a
   * sheet. So the endpoint's own no-elements behaviour is what these six are
   * for, and asking for `icon_button` on a chip would force ONE complete icon
   * button out of a type whose whole job is a plate family drawn in one job.
   *
   * The half of v3 that stays a danger is the CROP: its hero panel ran off the
   * top of the canvas. A sheet has no hero, so nothing here is oversized on its
   * own, and the tail clause code appends refuses the edge in words as well. */
  T({
    name: 'chip',
    label: 'Chip sheet',
    tier: 'sheet',
    order: 6,
    stretch: 'none',
    w: 384,
    h: 384,
    // it WAS ['icon_button'], which forces one complete control out of a type
    // that exists to draw a family of them at one weight
    elements: null,
    elementsWhy: 'a sheet wants the endpoint\'s own no-elements behaviour, which is a grid of matched loose parts',
    // control scale, and the plate this sheet is drawing a family of
    styleRef: 'button-wood.png',
    material: null,
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
    elements: null,
    elementsWhy: 'a sheet wants the endpoint\'s own no-elements behaviour, which is a grid of matched loose parts',
    /* THE ONLY SELF-CONTAINED MARK ON THE SHELF. crest-panther.png is 128x128
     * with no frame, no wood and no paper on it, so it is the one reference that
     * carries a mark's material without handing a small token a panel's frame to
     * copy. All five mark sheets take it for that one reason. */
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
    w: 512,
    h: 512,
    elements: null,
    elementsWhy: 'a sheet wants the endpoint\'s own no-elements behaviour, which is a grid of matched loose parts',
    styleRef: 'crest-panther.png',
    material: null,
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
    elements: null,
    elementsWhy: 'a sheet wants the endpoint\'s own no-elements behaviour, which is a grid of matched loose parts',
    styleRef: 'crest-panther.png',
    material: null,
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
    elements: null,
    elementsWhy: 'a sheet wants the endpoint\'s own no-elements behaviour, which is a grid of matched loose parts',
    styleRef: 'crest-panther.png',
    material: null,
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
    elements: null,
    elementsWhy: 'a sheet wants the endpoint\'s own no-elements behaviour, which is a grid of matched loose parts',
    styleRef: 'crest-panther.png',
    material: null,
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
    /* A PAINTING STILL NEEDS THE SHAPE LEVER. It is not nine-sliced, so nothing
     * here is about corners, but the alternative to a list is still a kit and a
     * kit is not a cover plate. chart-cover.png is itself one complete framed
     * illustration with rollers down its two sides, so `window` is describing
     * what the shipped one already is. */
    elements: ['window'],
    elementsWhy: 'the alternative to a list is a kit, and a kit is not a painting',
    // the one painted whole that ships: a chart on parchment between two wooden
    // rollers, sage sea, compass rose
    styleRef: 'chart-cover.png',
    // its middle IS the illustration, so naming a surface there would flatten
    // the one type whose centre is meant to be busy
    material: null,
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

  /* ---- the two named so nobody generates them -----------------------------
   * No levers on either, and that is not an omission. createUi refuses tier
   * `none` before anything is spent, so a list and a reference on these two
   * would be three fields nothing can ever read, which is the half-plumbed
   * shape docs/AUTHORING.md names. */
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

/* ---- WHAT THE ROUTER IS TOLD, and why any of it is written down here ------
 *
 * The generate route used to post the author's own sentence straight to
 * pixellab. Everything below this comment already existed on the type and none
 * of it left the process: an author typed "a wooden dialogue box", and the
 * tier, the stretch axis, the legal canvas, the region vocabulary and the
 * caution the record spent a sweep writing all sat here unread while a
 * four-word sentence went out to be paid for.
 *
 * 240 generations went on two pieces on 2026-08-30 because the prompts were
 * hand-written in a chat window with none of this in front of whoever wrote
 * them. The asset stage settled the fix two months earlier and it is the same
 * fix: the description goes to CLAUDE with the context, claude writes the
 * pixellab prompt, pixellab draws it. This file's job in that chain is to hand
 * over what it knows about the type, in words a model can act on.
 *
 * It lives in the store rather than in the route because the store is what owns
 * the twenty-one types. A second copy of the tier rules in api.mjs is two lists
 * that disagree the first time one is edited. */

/* THE HARD CONSTRAINT ON EVERY GROUND, AND THE ONE THAT HAS ACTUALLY FAILED.
 *
 * A ground is nine-sliced: four corners held at fixed size, four edges repeated
 * along their axis, one middle stretched under the text. That is not a
 * preference about how it looks, it is what the consumer does with the bytes,
 * so a painting that cannot survive it is a painting the game cannot use.
 *
 * Two rolls died on exactly this and both died the same way: an anchor motif
 * landed at TOP CENTRE and BOTTOM CENTRE. Centre-of-an-edge is the one place
 * ornament must never go, because that is the pixel band the widening box
 * repeats, so the anchor smeared into a rhythm of half anchors the moment the
 * box was wider than the canvas it was drawn on. The corners are the only place
 * a motif is safe, because the corners are the only part that is never
 * repeated and never stretched.
 *
 * The middle is the second half and it fails quieter: a grain, a crest or a
 * knot painted in the centre is what the text prints on top of, and the text is
 * the thing the player is there to read. */
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
  sheet:
    'THIS PIECE IS A SHEET: one canvas holding a grid of separate faces, cut apart afterwards by marked rectangles. ' +
    'Draw the faces evenly spaced on transparent, all at one weight and one scale, with clear empty space between them so a rectangle can be drawn round each without touching its neighbour. ' +
    'It is a sheet because BOTH SIDES OF A GENERATION START AT 192 pixels and these marks are far smaller than that, so they cannot be asked for at their own size. ' +
    'Drawing the family in one job is also the only way the faces come back matching: a second job returns a different weight and a different palette.',
  painted:
    'THIS PIECE IS A PAINTED WHOLE: one full-bleed illustration, not a frame and not a nine-slice. ' +
    'It never stretches and it takes no edge numbers, so the composition is fixed. ' +
    'Leave the areas the regions name legible enough to print words over, and keep the busy part of the picture away from them.',
}

/* WHICH DRAWN THING A NEW PIECE HAS TO MATCH.
 *
 * The game already ships chrome Ash accepted, in AdventureGame/public/art/ui,
 * and those files are the look. Copied into public/chrome here rather than
 * reached across two repos, because the host has no AdventureGame checkout on
 * it and a path into a sibling working copy is a thing that works on exactly
 * one laptop.
 *
 * Chosen BY TYPE and sent by the server. An author pasting a reference is the
 * same defect as an author pasting a prompt: it works when the person doing it
 * already knows the answer, which is the one case that never needed the tool.
 *
 * The mapping is by what the piece is MADE OF, not by what it is called and not
 * by what it is shaped like. A style image transfers material and no layout at
 * all, so shape is the one thing it cannot carry and matching on it is matching
 * on the field that does not travel.
 *
 * IT LIVES ON THE TYPE NOW, as `styleRef`, and it was a second table keyed by
 * type name beside the twenty-one types. Two lists about the same rows are two
 * lists that disagree the first time one is edited, and eight of the twelve
 * grounds were not in the old one at all: they fell through a default and
 * nobody had looked at the file they were getting.
 *
 * What each of the six actually is, read off the pixels rather than off its
 * filename, because the names are not descriptions:
 *
 *   dialogue-box.png     dark walnut, carved scrollwork, twisted rope, turquoise
 *                        cabochons and copper rivets in the corners, anchors,
 *                        aged mottled parchment. The most ornate thing shipped.
 *   panel-paper-wood.png honey oak planks, rope curls at the corners, a big
 *                        clean cream parchment field. The calm one.
 *   panel-square.png     dark walnut rounded square, brass rivets, a thin rope
 *                        line, cream parchment. NOT bare wood: the old comment
 *                        here said "no paper in it" and the picture has paper.
 *   button-wood.png      a small walnut plate with a beaded inner line and a
 *                        parchment face, at control scale. Carries painted
 *                        lettering, which nothing in pixels refuses.
 *   crest-panther.png    a 128x128 black panther head. The only self-contained
 *                        mark: no frame, no wood, no paper.
 *   chart-cover.png      a sea chart on parchment between two wooden rollers.
 *                        The only painted whole.
 *
 * The fallback is for a row whose type is blank, which is a member's untyped
 * piece and nothing in the twenty-one. Every one of the twenty-one answers from
 * its own row. */
const CHROME_FALLBACK = 'panel-square.png'

export const chromeRef = (type) => {
  const t = pieceType(type)
  // a type that deliberately has none answers null rather than the fallback, so
  // the caller can say "no reference" out loud instead of quietly sending the
  // wrong wood. Only the two ungenerated types are in that case.
  if (t) return t.styleRef
  return CHROME_FALLBACK
}

/* THE TYPE, WRITTEN OUT FOR A READER THAT IS NOT THE PAGE.
 *
 * `what` and `why` are already the record's own sentences about the piece and
 * `caution` is the trap somebody already fell into, so none of it is invented
 * here. The router gets them verbatim: a paraphrase of a caution is a caution
 * with the specific thing filed off it, and the specific thing is the whole
 * value ("a panel with a painted heading in it is a panel that can hold exactly
 * one thing").
 *
 * `shelf` is what this account has already drawn. It is here because the second
 * piece has to match the first, and the only way a router can match something
 * is to be told it exists. */
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
    `THE CANVAS IS ${w} BY ${h} AND IT IS NOT NEGOTIABLE. It is aspect-gated by the generator and both sides start at 192, so it is decided before you are asked and nothing you write can change it. Compose for that shape.`,
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
  if (Array.isArray(t.faces) && t.faces.length)
    lines.push(
      ``,
      `IT NEEDS THESE FACES, ALL IN THIS ONE DRAWING: ${t.faces.join(', ')}. They are the same object wearing different states, so they must be identical in size, weight and palette and differ only in the thing that changed.${
        t.facesFree ? ' More faces of the same family are welcome beside those, at the same weight.' : ''
      }`,
    )
  /* THE REGIONS ARE THE SECOND HALF OF THE PIECE AND THE GENERATOR NEVER SEES
   * THEM, which is exactly why the router has to. A rectangle is dragged onto
   * this picture afterwards and a sentence prints inside it; if the painting put
   * a carved crest where `body` goes, the mark is drawn over art and the author
   * finds out with a paragraph on top of a knot of wood. */
  const marks = Array.isArray(t.regions) ? t.regions : []
  if (marks.length)
    lines.push(
      ``,
      `RECTANGLES GET MARKED ON THIS PICTURE AFTERWARDS AND THE GAME DRAWS INTO THEM. Leave room for them and leave those areas plain:`,
      ...marks.map((r) => `- ${r.name} (${r.kind}${r.required ? ', required' : ''})`),
      `Nothing in your description draws the contents of those: no lettering, no numbers, no portrait, no icons. The picture is the empty furniture and the game fills it.`,
    )
  else lines.push(``, `No rectangles are marked on this one, so it is the whole picture and nothing is drawn into it.`)
  /* THE TWO LEVERS, SAID TO THE MODEL AS LEVERS. The router keeps writing
   * "parchment" into a subject and getting brown wood back, because on a noun
   * pixellab holds a prior for, words lose. So the model is told which parts of
   * this it is NOT responsible for: the shape is already forced by the element
   * list and the material is already carried by the reference png, and a
   * sentence spent re-asking for either is a sentence not spent on the piece. */
  if (Array.isArray(t.elements) && t.elements.length)
    lines.push(
      ``,
      `THE SHAPE IS ALREADY FORCED, so do not spend words on it. The generator is being told to scaffold this from its own "${t.elements.join('", "')}" element, and that is what returns ONE complete centred piece instead of a sheet of loose parts with the piece cropped off the top. Measured over five rolls: sending that list is the only thing that decides it, and no wording does.`,
    )
  else if (t.tier === 'sheet')
    lines.push(
      ``,
      `NO ELEMENT LIST GOES OUT WITH THIS ONE, and that is deliberate. Left to itself the generator returns a grid of evenly spaced loose parts at one weight on transparent, which is a defect on a panel and is exactly what a sheet is. Write for that grid.`,
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
/* WHAT THE GAME ALREADY CALLS THE PIECE IT MOUNTS.
 *
 * Three of the grounds have a mount in the game today and two of them lined up
 * by luck: `panel` is --kit-art-panel and .kit-surface-panel, `plank` is
 * --kit-art-plank and .kit-surface-plank. The reserved core name here is
 * `dialogue_box` and the game's shipped handle is `dialogue`: --kit-art-dialogue
 * in tokens.css, .kit-surface-dialogue on DialogueBox, pinned by a passing test
 * over there. --kit-art-dialogue_box and .kit-surface-dialogue_box exist nowhere
 * in the game.
 *
 * It is worse than cosmetic because dialogue_box is order 1, the first piece Ash
 * generates, so the very first paste produced a selector matching no element and
 * a var() nothing defines: invalid at computed-value time, and border-image
 * drops silently to none. MAPVIS emits X, the game reads Y, and nothing says so.
 * Every other piece keeps its own name, because no class exists for it yet and
 * the emitted name is the one the game would create. */
const CSS_HANDLE = { dialogue_box: 'dialogue' }

export function sliceCss(name, rec, ver = '') {
  if (!hasSlices(rec)) return ''
  const h = CSS_HANDLE[name] || name
  /* A CHANGED PICTURE HAS TO BE A CHANGED URL, because the route under it
   * answers `public, max-age=31536000, immutable`. That header is deliberate
   * and it is worth its trade, but it means a browser that already holds the
   * old art will not see a redraw for a year, and the note on that route says
   * the workaround is to rename the piece. Renaming a piece to force art
   * through is not a workaround, it is a broken address. The sha of the bytes
   * in the url means the address changes exactly when the picture does, and
   * this string is re-emitted on every save, so the author's paste is always
   * pointing at what they are looking at. */
  const url = `/api/v1/ui/${name}/image${ver ? `?v=${String(ver).slice(0, 12)}` : ''}`
  const { top, right, bottom, left } = rec.slice
  const k = rec.scale
  const px = [top, right, bottom, left].map((n) => `${n * k}px`).join(' ')
  const rep = rec.repeat.x === rec.repeat.y ? rec.repeat.x : `${rec.repeat.x} ${rec.repeat.y}`
  /* THE CUSTOM PROPERTIES LIVE IN A BLOCK, and without one this whole string
   * parsed to ZERO rules.
   *
   * Three declarations at the top level of a stylesheet are not declarations,
   * they are the start of a malformed qualified rule, and CSS error recovery
   * swallows them and the rule that follows them as one. Pasted into a live
   * style element and read back: cssRules.length 0, --kit-slice-panel undefined
   * on :root, a .kit-surface-panel div computing border-width 0px and
   * border-image-source none. This string is the only artefact the library
   * produces for the consumer, it sits behind a copy button under "what the game
   * takes", and every correct number in it arrived dead. Wrapped, the same
   * content gives two rules and a 49px border-image.
   *
   * THE IMAGE FALLS BACK TO THE PIECE'S OWN BYTES. var(--kit-art-x) with nothing
   * defining it makes the whole border-image invalid, and the export gave a
   * consumer no way to discover which token it was meant to point at, so even a
   * hand fix was a guess. The fallback stands the rule up unaided and a
   * game-side token still overrides it.
   *
   * AND THE BORDER IS TRANSPARENT. border-style: solid with no colour inherits
   * currentColor, and the study's plain arm sets --kit-art-*: none precisely so
   * a drawn surface blanks. Measured with the art off: a 49 pixel solid black
   * ring round every panel, in the control condition, out of the CSS the author
   * is told to paste. border-image paints over the border box, so the colour is
   * never seen while the art is there. */
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

/* WHAT COUNTS AS A CUT, WRITTEN ONCE.
 *
 * There were two definitions and they disagreed. The validator that tells an
 * author a face has been cut counted a `fill` region as well; the `faces`
 * projection on the wire counted only `face`. A gauge declares faces ['track']
 * and its region vocabulary is a fill kind, so an author who cut the track as a
 * fill satisfied checkUi with no warning and then shipped a cut list missing
 * that cut: the piece reported itself fully cut and the consumer got nothing.
 *
 * Narrowed to `face` rather than widened, because a fill is a rectangle a
 * consumer stretches or tiles inside the piece and a face is a rectangle it cuts
 * OUT of the sheet, and calling both a face would put fill_unit into the cut
 * list of every gauge. Names are unique per piece, so a gauge carries both. */
const isCut = (r) => r.kind === 'face'

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
      const cut = new Set(regions.filter(isCut).map((r) => r.name))
      for (const f of type.faces) if (!cut.has(f)) warnings.push(`the "${f}" face has not been cut yet`)
    }
  }
  const sl = checkSlices(asset?.slices, asset.w, asset.h, type)
  return { problems: problems.concat(sl.problems), warnings: warnings.concat(sl.warnings) }
}

// ---- cutting the hero out of a family --------------------------------------

/* PIXELLAB ANSWERS WITH A FAMILY AND A FAMILY CANNOT BE SLICED.
 *
 * /v2/create-ui-asset returns one png holding the hero piece at the top and a
 * tray of matching buttons, chips and rules underneath it. The slice record is
 * `{src, w, h, slice, scale, fill, repeat}` and the four numbers in `slice` are
 * insets measured from the edges of the WHOLE image. There is no source rect
 * anywhere in that shape, because CSS border-image-slice has none and Pixi
 * NineSliceSprite has none, so with a family in one png those four numbers
 * point at the tray and the piece cannot be sliced at all. That is the blocker
 * and cutting the hero out at import is the whole of the fix.
 *
 * THIS IS A SCAN AND ARITHMETIC. IT IS NOT A JUDGEMENT.
 *
 * Ash's concern, which is the reason everything below refuses instead of trying
 * harder: "if its AI or something just guessing, cropping can have problems".
 * Nothing here looks at what the picture is of, asks a model anything, or
 * scores a candidate. It reads the alpha channel, groups touching opaque pixels
 * into regions, takes the bounding box of the region with the most pixels, and
 * then puts that box through three checks that can each fail. When one fails
 * the whole image is kept, the row records which check failed in the sentence
 * the author reads, and the card says the piece needs a hand crop. A silently
 * wrong crop is the one outcome that must not happen: the four numbers measured
 * against it would then be wrong everywhere the piece is mounted, and nothing
 * anywhere would say a word.
 */

/* THE ALPHA THRESHOLD IS THE REPO'S AND NOT A NEW ONE.
 *
 * publish.mjs's FOOT_ALPHA is 40 and Walk.tsx's trimToFeet uses the same 40.
 * World.tsx's opaque-extent scan uses 8 instead, and says why: generated
 * coastline has a soft edge that a high threshold would eat. Chrome is neither
 * case. Measured on both families on disk, every pixel is either alpha 0 or
 * alpha 224 and up, with nothing at all in between, so any threshold between
 * those gives the identical answer and 40 is the one already written down. */
const PIECE_ALPHA = 40

/* ONLY A GROUND PIECE IS ONE PIECE.
 *
 * A sheet is a grid of cuts and cropping it to its largest cut throws the other
 * twenty away. A cover plate is one whole painting keyed to a destination, so
 * its canvas IS the picture. Neither is a nine-slice and neither has a hero, so
 * neither is scanned, and the row says nothing about a crop rather than
 * recording a refusal for a question that was never asked. */
export const cropsToHero = (type) => !!type && type.tier === 'ground'

/* EVERY GROUP OF TOUCHING OPAQUE PIXELS, WITH ITS BOX AND ITS COUNT.
 *
 * An iterative flood fill with an explicit stack, because a family is up to
 * 264,192 pixels and recursion at that depth is a stack overflow rather than an
 * answer. Eight-connected rather than four: two parts of one drawn frame that
 * meet only at a corner must not come back as two pieces. Measured on both
 * families on disk, four and eight agree exactly, twelve regions for
 * dialogue_box_v4 and sixteen for panel, so the choice costs nothing on the art
 * that exists and only guards the case where a hairline joins diagonally.
 *
 * Sorted by pixel count, most first, so `regions[0]` is the hero candidate. */
export function opaqueRegions(w, h, data) {
  const label = new Int32Array(w * h).fill(-1)
  const stack = new Int32Array(w * h)
  const out = []
  /* THE EIGHT NEIGHBOURS AS dx,dy AND NOT AS A FLAT OFFSET. An offset of -1 on
   * column zero lands on the far end of the row above, which joins the left
   * edge of the canvas to the right edge and reads a whole family as one
   * region. Carrying the column explicitly is what makes that impossible. */
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

/* THE HERO'S BOX, OR THE REASON THERE IS NOT ONE.
 *
 * Three checks, each of which can refuse, and the refusal names which one it
 * was. The numbers below are read off the two real families rather than picked:
 *
 *   dialogue_box_v4  688x384  hero 518x182 at 85,17   box is 35.7% of canvas
 *   panel            448x448  hero 403x150 at 22,22   box is 30.1% of canvas
 *
 * ONE · AT LEAST A QUARTER OF THE CANVAS. The BOX rather than the pixel count,
 * because the box is what gets cut and because a highlight edge is drawn with
 * its centre empty, so counting its pixels would refuse the one type whose
 * whole point is a hollow middle. A tray button in either family is under four
 * percent, so a quarter is a wide gap on both sides of the real answer and it
 * is what stops a stray chip being crowned when the hero fails to be found.
 *
 * TWO · NOTHING ELSE INSIDE THE BOX. If the hero's box overlaps another
 * region's box then the cut would carry a piece of its neighbour, or the two
 * were really one thing that the scan split. Either way the arithmetic does not
 * know which, so it stops. This is the check that catches a tray drawn beside
 * the hero rather than under it.
 *
 * THREE · THE SHAPE IS IN THE RIGHT COUNTRY. The hero is normally wider than
 * its canvas is, because the canvas has to be tall enough to hold the tray
 * underneath: measured, the hero's aspect is 1.59 times the canvas ratio for
 * the dialogue box and 2.69 times it for the panel. The band is 0.5 to 6, which
 * clears both measurements with room and still refuses a hero shaped ten times
 * its canvas either way. It is the coarsest of the three on purpose; one and
 * two are the ones carrying the weight.
 */
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

/* THE SAME ARITHMETIC, WITH THE BYTES CUT OUT AT THE END OF IT.
 *
 * Decoded once and handed to both halves, because a family is a quarter of a
 * million pixels and inflating it twice to answer one question is a cost paid
 * on every import for nothing. */
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
 * `status` IS ALWAYS 'ready' ON THE /api/v1 ROUTES, and the note here used to
 * say the opposite: that pending and failed are not an error to a reader, and
 * that a blank surface is the study's plain arm. The second half is true of the
 * game, whose tokens.css sets --kit-art-*: none and falls back to a colour. The
 * first half was false about this file's own routes twenty lines below, which
 * both filter on status = 'ready', so a published reader can never see any other
 * value. Corrected rather than left, because a comment describing behaviour the
 * code does not have is how the next session designs against a promise nothing
 * made. The authoring routes, listUi and getUiByName, do serve pending and
 * failed, and that is where the value means something.
 *
 * `src` resolves on the MAPVIS origin only, where the game's own four are
 * same-origin files. That is the same cross-origin case already logged against
 * reading a map from the platform and it is not new here.
 */
/* HOW LONG A ROW IS ALLOWED TO CLAIM A SPEND IS IN FLIGHT. The same window
 * pendingUi uses, because there is one truth about staleness and two copies of a
 * number is how they drift. */
const PENDING_MS = 10 * 60 * 1000

/* THE PICTURE COMES OFF THE ROUTE THE CALLER IS ON.
 *
 * `src` was hard-coded to the account-less /api/v1 route for every row,
 * including the owner-scoped authoring list, and uiImage has no owner_id in its
 * query at all. Names are unique per ACCOUNT, so two people with a piece called
 * `binder` were both served ONE picture: the core one, otherwise the oldest.
 * The authoring page then stretched that png to the other row's w by h and
 * measured rectangles against art the author never saw, and saved them. Cross
 * account bleed on the one surface whose entire job is measuring a specific
 * picture. So the base is an argument: the authoring reads pass their own
 * scoped route and the published reads keep the public one.
 */
/* WHERE THE AUTHOR'S OWN ROUTES LIVE, said once. The family a crop came out of
 * is the author's working material and the game has no use for it, so `full` is
 * only offered on the scoped base, where a route for it exists. Emitting it on
 * /api/v1 would be a url that 404s. */
const OWN_BASE = '/api/ui'

const shape = (r, base = '/api/v1/ui') => {
  const regions = Array.isArray(r.regions) ? r.regions : []
  const crop = r.crop && typeof r.crop === 'object' && r.crop.w > 0 ? r.crop : null
  const slices = r.slices && typeof r.slices === 'object' && r.slices.slice ? r.slices : null
  /* A GENERATION THAT DIED OUTSIDE THE HANDLER LEFT THE ROW PENDING FOR EVER.
   * failUi is only reachable from the two catches in the generate route, so a
   * process restart, which the dev server does on every server file save,
   * stranded the row: its card read "still drawing" permanently while the poller
   * gave up after ten minutes, so it claimed a spend was in flight that was not.
   * Aged out on read rather than with a sweeper, so there is one expression and
   * one truth about it. */
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
    /* THE CONTENT HASH RIDES ON THE ROW, so anything holding a picture can ask
     * whether it is still the picture without downloading it. The authoring
     * page busts its own <img> with a stamp already; what this is for is the
     * emitted CSS, whose url the game mounts and whose route answers immutable
     * for a year. */
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

/* THE SHA OF SOME BYTES, IN THE ONE PLACE THE ROW AND THE READ BOTH USE IT.
 * sha1 rather than anything longer for the same reason blob_shas uses it: this
 * is a change detector and not a signature, and base64url keeps it short enough
 * to put in a url. */
const shaOf = (buf) => crypto.createHash('sha1').update(buf).digest('base64url')

/* BYTES THE ROW AGREES WITH, WHICH IS NOT THE SAME AS BYTES THE CACHE HAS.
 *
 * blobs.mjs memoises reads and only evicts a key when a write goes through the
 * SAME process. A write from anywhere else is invisible to it. Measured
 * 2026-08-30: a CLI script wrote 67035 bytes for `panel`, the row and the
 * bucket both took it, and the dev server went on serving the 56644 bytes it
 * had cached on BOTH image routes until it was restarted. So an author who
 * redrew a piece kept being shown the old picture, which is the engine lying to
 * the person measuring it.
 *
 * The row is the truth about which bytes belong to this piece, and it is
 * already being read here to find the key, so the check is free of any extra
 * query: hash what came back, and if it is not what the row recorded then the
 * cache is stale, drop the key and read again. One extra hash of a png that is
 * tens of kilobytes, against a class of bug whose symptom is silence.
 *
 * The family is dropped with it. Both keys are written in the same call, so if
 * the hero is stale the family is stale too, and it has no sha of its own to
 * catch it with.
 */
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

// the bytes for one account's own piece. The published route below cannot answer
// this question: it has no account in its path and picks core-then-oldest across
// every account, which is a member's rectangles measured against somebody else's
// chrome.
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
  /* DEDUPED, BECAUSE THE LIST CONTRADICTED THE BY-NAME READ.
   *
   * This was a plain select with no dedupe, so a name owned by two accounts came
   * back twice with the identical `src`, and the ordinary way to consume a flat
   * list is to fold it into a map by name, where the LAST row wins. Under
   * `order by name, core desc, created_at` the last row is the newest MEMBER
   * one, so a consumer ended up with the core png drawn to a member's slice
   * numbers, regions and faces. That inverts the ruling the two lines below it
   * implement correctly, and it breaks "core chrome is never overridable"
   * silently and across accounts. DISTINCT ON keeps the first row per name under
   * exactly the ordering the comment already states, and the index written for
   * this tie already exists. */
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
export async function setUiImage(ownerId, name, buf, w, h, pixellabId = '', { crop = true } = {}) {
  if (!ownerId || !isName(name)) throw new Error('no piece to put a picture on')
  const key = `ui/${ownerId}/${name}.png`
  const fullKey = `ui/${ownerId}/${name}.full.png`

  /* THE HERO IS CUT OUT HERE, WHICH IS THE MOMENT THE FAMILY ARRIVES.
   *
   * Not later on a page, because a piece that spends any time in the library
   * un-cropped is a piece somebody can measure four edge numbers against, and
   * those numbers would be insets from the edge of a picture that is about to
   * be replaced by a smaller one. Cropping at import means the row is never
   * once in a state where the marks and the picture disagree.
   *
   * `crop: false` is for a restore rather than an import. verify-authoring
   * snapshots the author's real dialogue box and writes it back at the end, and
   * putting bytes back exactly as they were is not the same act as taking
   * delivery of a new family. Cropping a restore would shrink the piece a
   * little more on every verify run.
   */
  const row = await one('select type from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
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
  /* AND THE CACHE IS TOLD, BY NAME.
   *
   * store().put already evicts the key it wrote. This says so out loud at the
   * one call site in this file that replaces a picture an author is looking at,
   * because the whole class of bug here was a read handing back bytes a write
   * had already replaced, and a line that is obvious is a line the next person
   * does not delete. */
  store().forget(key)
  store().forget(fullKey)

  /* A REDRAW THAT CHANGED SIZE LOSES THE EDGE NUMBERS.
   *
   * createUi keeps regions and slices through a redraw on purpose, so redrawing
   * a panel at the same size keeps the marks. That promise is only true for the
   * same-size case and nothing checked the size: this writes w and h off the new
   * png, deliberately, because the generator answers with the canvas IT chose,
   * and the form lets a piece be redrawn under a different type entirely, which
   * moves both by hundreds of pixels in one press. So `top + bottom >= h`, the
   * exact condition checkSlices exists to refuse, could end up stored, and the
   * read API serves ready-but-unpublished rows, so it reached a consumer with
   * border-image drawing nothing and saying nothing.
   *
   * The slices go and the regions stay. Four numbers are a minute's work and the
   * rectangles are the expensive hand pass, and publishUi re-runs checkUi over
   * them, which catches one that now falls off the sheet.
   *
   * The pixellab id lands here too. It has never been non-empty on any row,
   * because the generate route never passed it, so a spend on chrome could not
   * be traced back to what it bought. */
  return one(
    `update ui_assets set blob_key = $3, w = $4, h = $5, status = 'ready',
       pixellab_id = case when $6 <> '' then $6 else ui_assets.pixellab_id end,
       full_key = $7, crop = $8::jsonb, crop_note = $9, img_sha = $10,
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
    ],
  )
}

/* PUTTING A BAD CROP BACK, WHICH IS WHY THE FAMILY IS KEPT AT ALL.
 *
 * The scan refuses rather than guesses, so a wrong crop should not happen. It
 * still has to be undoable, because "should not happen" is not a thing an
 * author can act on at eleven at night with a piece that came out a third of
 * the size it should be. This writes the family back as the piece's own picture
 * and stops the row claiming any crop, which puts it in exactly the state a
 * refusal would have left it in: the whole image, and a hand crop owed.
 *
 * It goes through setUiImage with the cut turned off rather than writing the
 * columns itself, so the size change drops the slices by the same rule
 * everything else does. Four edge numbers measured on a 518x182 hero mean
 * nothing on the 688x384 family they came out of.
 */
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
  /* THE OWNER'S OWN BASE, BECAUSE THIS IS ONLY EVER REACHED FROM /api/ui.
   *
   * It defaulted to the account-less base, which is the same defect listUi and
   * getUiByName were fixed for: a member who saved their marks got back a `src`
   * pointing at whichever account's row won the name across the platform, so
   * the page they were measuring on could swap under them at the moment of a
   * save. It also dropped the link to the family a crop came out of, which is
   * only offered on the scoped base. */
  return { ...shape(saved, OWN_BASE), warnings }
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
