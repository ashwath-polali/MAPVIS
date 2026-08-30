/* A PICTURE OF A PAGE IS NOT A PAGE.
 *
 * The generator will happily draw a dialogue box, a health bar or a card, and
 * what comes back is a png. A png is not usable chrome: the vine still has to
 * know that the speaker's name goes at 14,9, that the bar fills from 40,72 to
 * 210,84, that the button's hit box is the bottom right corner. Without those
 * marks, every drawn surface arrives with a second half typed by hand into vine
 * source, which is the same defect as a hand-typed camera number. It is a fact
 * about a picture stored somewhere the picture cannot correct it, and it goes
 * stale the moment the panel is regenerated one pixel wider.
 *
 * So a surface here is the png plus its named slots, and the slots are the
 * deliverable. The rule is the one anchors already settled: a name is the only
 * address there is, so a nameless slot is refused rather than given a number,
 * and a name that means two things is refused outright.
 *
 * OWNED BY AN ACCOUNT, not by a map. A dialogue box belongs to the game rather
 * than to the hub, and 013 says why the map-scoped library could not hold it.
 */
import { q, one, many } from '../db/pool.mjs'
import { store } from './blobs.mjs'

/* What a slot is FOR, which is what the reader needs to know before it can draw
 * anything into it. text and number differ because a number is right-aligned in
 * a box that must not reflow when it goes from 9 to 10; bar carries a fill;
 * button is the one that takes a click; icon and image are somebody else's png
 * dropped in. Nothing here is a widget, it is a rectangle with a job. */
export const SLOT_KINDS = ['text', 'number', 'bar', 'button', 'icon', 'image']

/* how the thing inside sits in the rectangle. Absent means "the reader's own
 * default for that kind", which is left rather than a fifth enum value, because
 * a slot that never said anything about alignment should not start saying it. */
export const SLOT_ALIGNS = ['left', 'center', 'right']

const isName = (s) => /^[a-z][a-z0-9_]{0,47}$/.test(String(s || ''))
const num = (v, d = 0) => (isFinite(Number(v)) ? Math.round(Number(v)) : d)

/* ONE NAMED PLACE INSIDE A SURFACE.
 *
 * Nothing here coerces a missing name into a made-up one, and that is
 * deliberate rather than strict. Every other field has an honest default: an
 * unknown kind reads as text, an absent align means the reader decides. A name
 * has no honest default, because the name IS the thing a grape holds, and a
 * slot silently called `slot_3` is a promise the author never made. Same
 * refusal cleanPlace makes for the same reason.
 *
 * The four numbers are checked before they are rounded. num() answers 0 for
 * anything unreadable, so a rect whose height arrived as undefined would have
 * become a zero-tall box that draws nothing and reports no error. */
export function cleanSlot(s) {
  if (!s || !isName(s.name)) return null
  for (const k of ['x', 'y', 'w', 'h']) if (!isFinite(Number(s[k]))) return null
  return {
    name: s.name,
    kind: SLOT_KINDS.includes(s.kind) ? s.kind : 'text',
    x: num(s.x),
    y: num(s.y),
    w: num(s.w),
    h: num(s.h),
    ...(SLOT_ALIGNS.includes(s.align) ? { align: s.align } : {}),
    // the author's own bag, the way an anchor carries one. A slot may need to
    // say which font, which colour, which key it reads; none of that belongs in
    // a column that would have to be invented once per idea.
    ...(s.meta && typeof s.meta === 'object' && !Array.isArray(s.meta) ? { meta: s.meta } : {}),
  }
}

/* WHAT A SURFACE IS NOT ALLOWED TO BE.
 *
 * The same split saveWorld draws. A problem is a thing that can never work and
 * is refused where it is written; a warning is a thing that is probably a
 * mistake and is somebody else's call.
 *
 * A slot off the edge of the picture is the fatal one, and it is fatal rather
 * than clamped: clamping would hand back a rectangle the author did not draw
 * and the panel would look wrong in the game with nothing anywhere saying so.
 * Overlap is only a warning because overlapping is legal and occasionally
 * meant, a value printed on top of the bar that measures it being the obvious
 * case.
 */
export function checkUi(asset) {
  const problems = []
  const warnings = []
  const slots = Array.isArray(asset?.slots) ? asset.slots : []
  const seen = new Set()
  for (const s of slots) {
    if (seen.has(s.name)) problems.push(`two slots are both called "${s.name}", and a name is the only address there is`)
    seen.add(s.name)
    if (s.x < 0 || s.y < 0 || s.x + s.w > asset.w || s.y + s.h > asset.h)
      problems.push(
        `"${s.name}" covers ${s.x},${s.y} to ${s.x + s.w},${s.y + s.h}, which is off a ${asset.w}x${asset.h} surface, so nothing can ever be drawn into it`,
      )
  }
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]
      const b = slots[j]
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        warnings.push(`"${a.name}" and "${b.name}" overlap, which is legal and is usually a mis-drag`)
    }
  }
  return { problems, warnings }
}

// ---- reading ---------------------------------------------------------------

/* NOTHING IN THE GAME READS A SURFACE OFF THIS API, and that is written down
 * here rather than left for the next session to work out from a grep.
 *
 * What the running game has instead is four CSS custom properties in
 * src/game/ui/tokens.css pointing at four static files under public/art/ui:
 * panel-square, dialogue-box, plank-button, chart-cover. Four surfaces, and the
 * NAME is a css property rather than a string in any data file. A test pins each
 * token to its path and its consumer, which is the closest thing to a contract
 * that side has.
 *
 * THE SHAPE MISMATCH THAT MATTERS IS THE SLOT RECT, and it is not a rename. A
 * slot here is four rounded pixels measured against the png. Over there the
 * surface is drawn with `center / 100% 100% no-repeat` into a box sized in vw
 * and vh, so the png's own pixel size is never used for anything and every mark
 * inside the frame is a percentage: `padding: 5% 8.5% 6% 8.5%` is that side's
 * version of a slot. An absolute pixel rect handed to that layout is correct at
 * exactly one window width.
 *
 * So a normalized rect (x/w, y/h, w/w, h/h off the same w and h setUiImage takes
 * from the real bytes) is what a reader would want. NOT emitted here, because
 * there is no reader to be right for and the four names on that side are fixed
 * where these are free-form, so a member's `dialogue_box` and the game's
 * `dialogue` would be two names for one job with nothing to join them. Build the
 * projection the day a surface is actually consumed, against the four reserved
 * names and whatever that reader asks for.
 *
 * Two more things that side already settled, so they are not rediscovered:
 * `status` of pending or failed is the study's plain arm, a legal answer and not
 * an error, because tokens.css blanks all four surfaces under the plain skin.
 * And `src` below is a path that only resolves on the MAPVIS origin, where the
 * game's four are same-origin files, which is the same cross-origin defect
 * already logged against reading a map from the platform. */
const shape = (r) => ({
  name: r.name,
  title: r.title,
  description: r.description,
  w: r.w,
  h: r.h,
  status: r.status,
  slots: Array.isArray(r.slots) ? r.slots : [],
  ...(r.blob_key ? { src: `/api/v1/ui/${r.name}/image` } : {}),
  ...(r.pixellab_id ? { pixellabId: r.pixellab_id } : {}),
  createdAt: r.created_at ? +new Date(r.created_at) : 0,
})

export async function listUi(ownerId) {
  if (!ownerId) return []
  const rows = await many('select * from ui_assets where owner_id = $1 order by name', [ownerId])
  return rows.map(shape)
}

export async function getUiByName(ownerId, name) {
  if (!ownerId || !isName(name)) return null
  const r = await one('select * from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  return r ? shape(r) : null
}

/* WHAT THE READ API SERVES, which has no account in its path.
 *
 * A name is unique per account, not globally, so two people can both call a
 * surface `dialogue_box` and this endpoint has nowhere to put the difference.
 * The oldest wins, said out loud here rather than left to whichever row the
 * planner happened to return. That is a real sharp edge and the reason it is
 * survivable is that the game reads chrome from one account: the club's.
 */
export async function readyUi() {
  return (await many(`select * from ui_assets where status = 'ready' order by name, created_at`)).map(shape)
}

export async function readyUiByName(name) {
  if (!isName(name)) return null
  const r = await one(`select * from ui_assets where status = 'ready' and name = $1 order by created_at limit 1`, [name])
  return r ? shape(r) : null
}

// the bytes, for the read api's image route. Separate from the row read so a
// listing never pays for a png.
export async function uiImage(name) {
  if (!isName(name)) return null
  const r = await one(`select blob_key from ui_assets where status = 'ready' and name = $1 order by created_at limit 1`, [name])
  if (!r?.blob_key) return null
  try {
    return await store().get(r.blob_key)
  } catch {
    return null
  }
}

// ---- writing ---------------------------------------------------------------

/* The row exists before the picture does, because generation takes a minute and
 * a half and something has to be poll-able for that minute and a half.
 *
 * Regenerating under a name that is already taken REPLACES that surface rather
 * than failing or inventing `dialogue_box-2`. Same rule the in-place edits
 * settled on: the library keeps one row per thing, and a second row that is the
 * same panel one shade darker is how a list becomes unreadable. The slots are
 * left alone on purpose, so redrawing a panel at the same size keeps the marks
 * that were made on it.
 */
export async function createUi({ ownerId, name, title = '', description = '', w, h, pixellabId = '' }) {
  if (!ownerId) throw new Error('a surface needs an account to belong to')
  if (!isName(name)) throw new Error(`"${name}" is not a legal surface name; it has to read as a python identifier`)
  return one(
    `insert into ui_assets (owner_id, name, title, description, w, h, pixellab_id, status)
     values ($1,$2,$3,$4,$5,$6,$7,'pending')
     on conflict (owner_id, name) do update set
       title = excluded.title, description = excluded.description,
       w = excluded.w, h = excluded.h,
       pixellab_id = case when excluded.pixellab_id <> '' then excluded.pixellab_id else ui_assets.pixellab_id end,
       status = 'pending'
     returning *`,
    [ownerId, name, String(title).slice(0, 120), String(description).slice(0, 1000), Math.max(1, num(w, 256)), Math.max(1, num(h, 256)), String(pixellabId || '')],
  )
}

/* The picture arriving is what makes a surface ready.
 *
 * w and h come off the png rather than off the ask, because the generator
 * answers with the canvas IT chose and a slot rect measured against a size the
 * picture does not have is a slot that draws in the wrong place. Same reason
 * styleRef reads the IHDR instead of trusting the document.
 */
export async function setUiImage(ownerId, name, buf, w, h) {
  if (!ownerId || !isName(name)) throw new Error('no surface to put a picture on')
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

/* THE SLOTS, REFUSED THE WAY saveWorld REFUSES A COMPOSITION.
 *
 * Written where it is wrong, naming what is wrong, rather than discovered by a
 * member whose number prints half off the panel. The clean pass runs first so
 * the check is looking at what would actually be stored, and a slot that
 * cleanSlot threw away is reported by count rather than silently dropped: a
 * nameless slot vanishing without a word is how somebody spends an afternoon
 * looking for a mark they are sure they made.
 */
export async function saveUi(ownerId, name, slots) {
  const row = await one('select * from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  if (!row) throw new Error(`there is no surface called "${name}" on this account`)
  const asked = Array.isArray(slots) ? slots : []
  const clean = asked.map(cleanSlot).filter(Boolean)
  const dropped = asked.length - clean.length
  const { problems, warnings } = checkUi({ w: row.w, h: row.h, slots: clean })
  if (dropped) problems.push(`${dropped} slot(s) had no usable name and four numbers, and a slot with no name has no address`)
  if (problems.length) {
    const e = new Error(`the slots were not saved · ${problems.join(' · ')}`)
    e.problems = problems
    throw e
  }
  const saved = await one(`update ui_assets set slots = $3::jsonb where owner_id = $1 and name = $2 returning *`, [
    ownerId,
    name,
    JSON.stringify(clean),
  ])
  return { ...shape(saved), warnings }
}

// the name the routes call it by. One implementation, because a second one is a
// second set of refusals that drift apart.
export const setUiSlots = saveUi

// a surface leaves both stores or it comes back on the next listing, the same
// rule dropItem holds a library row to
export async function removeUi(ownerId, name) {
  const r = await one('select blob_key from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  if (!r) return false
  if (r.blob_key) await store().del(r.blob_key).catch(() => {})
  await q('delete from ui_assets where owner_id = $1 and name = $2', [ownerId, name])
  return true
}
