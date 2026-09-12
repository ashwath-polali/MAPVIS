// Which hands an account may draw with.
//
// The words live in style.mjs. This is only storage and permission: whose card
// it is, who has been granted the house one, and which card a map was drawn by.
//
// Everything here degrades to the house card alone with no database, because the
// editor runs off one machine with nothing configured and the first step still
// has to offer a choice there.

import { q, one, many } from '../db/pool.mjs'
import { env } from '../db/env.mjs'
import { platformOn } from './platform.mjs'
import { HOUSE_CARD, HOUSE_KEY, cardFrom } from './style.mjs'

/* WHO OWNS THE HOUSE CARD. One account, named in the environment the same way
 * the ocean's owner is, so the hand is a deployment fact and not a row somebody
 * can grant themselves by signing up. With nothing set, no account owns it and
 * it is offered to whoever is signed in on this machine, which is the one-laptop
 * case the whole tool falls back to. */
export const houseOwner = () => {
  /* env() and not process.env: .env is read into a merged object and never
   * exported into the process, so process.env finds nothing here and an unset
   * owner reads as "nothing is configured", which opens the house hand to
   * everybody. That is the one failure this whole file exists to prevent. */
  const E = env()
  const e = E.HOUSE_STYLE_OWNER || E.OCEAN_OWNER || E.BOOTSTRAP_EMAIL || ''
  return String(e).trim().toLowerCase()
}

/* the house card as a row would look, so every caller downstream sees one shape
 * whether it came from the database or from the file */
const houseCard = (ref = '') => ({ ...HOUSE_CARD, ref, house: true })

/* MAY THIS ACCOUNT DRAW IN THE HOUSE HAND. The owner always may. Anybody else
 * may only if the owner has granted it, and a signed-out visitor never may: the
 * hub's hand is the one thing on this platform that is not public. */
export async function mayUseHouse(user) {
  const owner = houseOwner()
  // nothing configured is one person on one laptop, and the choice is theirs
  if (!owner) return true
  if (!user) return false
  if (String(user.email || '').toLowerCase() === owner) return true
  if (!platformOn()) return false
  try {
    const row = await one(
      `select 1 from style_grants g
         join style_cards c on c.id = g.card_id
        where g.user_id = $1 and c.house = true and c.key = $2
        limit 1`,
      [user.id, HOUSE_KEY],
    )
    return !!row
  } catch {
    return false
  }
}

/* the account's own card, if it has made one */
export async function ownCard(user) {
  if (!user || !platformOn()) return null
  try {
    const row = await one(
      `select key, title, craft, ref_slug, house from style_cards
        where owner_id = $1 and house = false order by created_at desc limit 1`,
      [user.id],
    )
    return cardFrom(row)
  } catch {
    return null
  }
}

/* EVERY HAND THIS ACCOUNT MAY CHOOSE ON THE FIRST STEP, in the order they are
 * offered. The house card first when it is theirs to use, because it is the
 * default for the people it was granted to; "Other" is not in this list, it is
 * the absence of a choice from it. */
export async function cardsFor(user) {
  const out = []
  if (await mayUseHouse(user)) {
    /* the row is made on first sight rather than by the migration, because the
     * words live in a file a person edits and sql is the wrong place to keep a
     * second copy of them. Without a row there is nothing for a grant to point
     * at, so the owner opening the editor once is what makes granting possible. */
    if (user && houseOwner() === String(user.email || '').toLowerCase()) {
      await ensureHouseCard(user.id, await houseRef()).catch(() => null)
    }
    out.push(houseCard(await houseRef()))
  }
  const mine = await ownCard(user)
  if (mine) out.push(mine)
  return out
}

/* the published map whose picture the house card passes as its style image.
 * Empty is fine and common: the craft sentence carries the hand on its own. */
async function houseRef() {
  if (!platformOn()) return env().HOUSE_STYLE_REF || ''
  try {
    const row = await one(`select ref_slug from style_cards where house = true and key = $1 limit 1`, [HOUSE_KEY])
    return String((row && row.ref_slug) || env().HOUSE_STYLE_REF || '')
  } catch {
    return String(env().HOUSE_STYLE_REF || '')
  }
}

/* one card by the key a map stored, checked against what this account may
 * reach. A map drawn by a hand the reader is not granted still SAYS which hand,
 * because the stamp travels in the bundle; it just cannot be chosen again here. */
export async function cardFor(user, key) {
  if (!key) return null
  const list = await cardsFor(user)
  return list.find((c) => c.key === key) || null
}

/* AN ACCOUNT'S OWN HAND, TAKEN OFF ONE OF ITS OWN PUBLISHED MAPS. The craft is
 * read from that map's style card, which is the same reading the asset stage
 * already does, so a person is choosing a hand they have already seen work. */
export async function setOwnCard(user, { key, title, craft, ref }) {
  if (!user) throw new Error('sign in first')
  if (!platformOn()) throw new Error('this needs a database')
  if (!craft || !craft.clause) throw new Error('that map has no style card to take a hand from')
  const k = String(key || 'my-hand').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64) || 'my-hand'
  if (k === HOUSE_KEY) throw new Error('that key is the house hand')
  const row = await one(
    `insert into style_cards (owner_id, key, title, craft, ref_slug, house)
     values ($1,$2,$3,$4::jsonb,$5,false)
     on conflict (owner_id, key) do update
       set title = excluded.title, craft = excluded.craft, ref_slug = excluded.ref_slug
     returning key, title, craft, ref_slug, house`,
    [user.id, k, String(title || 'my hand').slice(0, 80), JSON.stringify(craft), String(ref || '').slice(0, 80)],
  )
  return cardFrom(row)
}

/* the house card as a row, made once so it has an id for grants to point at.
 * Idempotent, because the migration cannot write it: the words are in a file
 * that a person edits and sql is the wrong place to keep a copy of them. */
export async function ensureHouseCard(ownerId, ref = '') {
  if (!platformOn() || !ownerId) return null
  const row = await one(
    `insert into style_cards (owner_id, key, title, craft, ref_slug, house)
     values ($1,$2,$3,$4::jsonb,$5,true)
     on conflict (owner_id, key) do update set title = excluded.title, craft = excluded.craft
     returning id, key, title, craft, ref_slug, house`,
    [ownerId, HOUSE_KEY, HOUSE_CARD.title, JSON.stringify(HOUSE_CARD.craft), String(ref || '')],
  )
  return row
}

/* GRANTING IS THE OWNER'S ALONE. Checked here rather than at the route, because
 * a second caller is how a permission gets granted by whoever asks. */
export async function grantHouse(owner, email) {
  if (!platformOn()) throw new Error('this needs a database')
  const who = houseOwner()
  if (!owner || (who && String(owner.email || '').toLowerCase() !== who)) throw new Error('the house hand is not yours to grant')
  const to = await one('select id, email from users where email = $1', [String(email || '').trim().toLowerCase()])
  if (!to) throw new Error('no account with that email')
  const card = await ensureHouseCard(owner.id, await houseRef())
  if (!card) throw new Error('the house hand has no row to grant')
  await q(`insert into style_grants (card_id, user_id) values ($1,$2) on conflict do nothing`, [card.id, to.id])
  return { email: to.email }
}

export async function revokeHouse(owner, email) {
  if (!platformOn()) throw new Error('this needs a database')
  const who = houseOwner()
  if (!owner || (who && String(owner.email || '').toLowerCase() !== who)) throw new Error('the house hand is not yours to grant')
  const to = await one('select id from users where email = $1', [String(email || '').trim().toLowerCase()])
  if (!to) return { email: null }
  await q(
    `delete from style_grants g using style_cards c
      where g.card_id = c.id and c.house = true and c.key = $1 and g.user_id = $2`,
    [HOUSE_KEY, to.id],
  )
  return { email: String(email || '').trim().toLowerCase() }
}

export async function grantedTo(owner) {
  if (!platformOn() || !owner) return []
  try {
    return (
      await many(
        `select u.email from style_grants g
           join style_cards c on c.id = g.card_id
           join users u on u.id = g.user_id
          where c.house = true and c.key = $1 and c.owner_id = $2
          order by u.email`,
        [HOUSE_KEY, owner.id],
      )
    ).map((r) => r.email)
  } catch {
    return []
  }
}

// ---- what a map remembers --------------------------------------------------

/* the hand a map was drawn by, read back for publish and for the dashboard.
 * Never filtered by who is asking: the map knows what drew it. */
export async function mapCard(slug) {
  if (!platformOn() || !slug) return null
  try {
    const row = await one(
      `select c.key, c.title, c.craft, c.ref_slug, c.house, m.style_kind
         from maps m left join style_cards c on c.id = m.style_card_id
        where m.slug = $1`,
      [slug],
    )
    if (!row) return null
    return { card: cardFrom(row), kind: String(row.style_kind || '') }
  } catch {
    return null
  }
}

export async function setMapStyle(slug, { cardKey, kind, user }) {
  if (!platformOn()) return null
  const card = cardKey ? await cardFor(user, cardKey) : null
  /* the key is resolved against what this account may use, so a map cannot be
   * stamped with a hand its author was never granted by posting the key */
  if (cardKey && !card) throw new Error('that hand is not one this account may draw with')
  const row = card
    ? await one(`select id from style_cards where key = $1 order by house desc limit 1`, [card.key])
    : null
  await q(`update maps set style_card_id = $2, style_kind = $3 where slug = $1`, [slug, row ? row.id : null, String(kind || '')])
  return { card, kind: String(kind || '') }
}
