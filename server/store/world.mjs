/* THE WATER BETWEEN THE ISLANDS, WHICH NOTHING COULD AUTHOR.
 *
 * A MAPVIS document cannot exist without a painting. The id comes from a
 * dropped filename, every later step operates on its pixels, and anchor
 * creation refuses a click outside the canvas because armDoor tests inB(x, y).
 * The canvas only grows by transparent margin, and growing it changes w/h,
 * which the game fits its camera from, so buying room for a mooring anchor
 * zooms the whole island out.
 *
 * So the one surface the entire crossing happens on was the one surface with no
 * author, and everything about it lived as constants in the other repo. This is
 * that surface. It is not a map and it has no painting: it is a coordinate
 * space with maps placed on it, and a place can be marked before anything has
 * been painted for it.
 *
 * ONE ROW, because there is one ocean. Two accounts holding two compositions
 * would be two worlds that cannot both be sailed, and a berth is a position
 * relative to every other island rather than a private note.
 */
import { q, one } from '../db/pool.mjs'

/* the seven states the overworld reads and nothing authored. `rumoured` is the
 * one that belongs to an empty slot: a reserved position holding no map, where
 * the rise happens where the rumour was. */
export const ISLAND_STATES = [
  'rumoured',
  'misty',
  'discovered',
  'available',
  'active',
  'completed',
  'in_season',
]

/* what the water is, where it is not an island. Same vocabulary the walkable
 * mask cannot answer, because the mask answers a question about feet and a
 * ship is not a walker. */
export const SEA_KINDS = ['sailable', 'shallow', 'forbidden', 'mist', 'ambience']

const isName = (s) => /^[a-z][a-z0-9_]{0,47}$/.test(String(s || ''))
const num = (v, d = 0) => (isFinite(Number(v)) ? Math.round(Number(v)) : d)

/* A POINT OUT ON THE WATER, which is the shape §12 asks for six times under six
 * names. Absent rather than zeroed, because (0,0) is a real position on the
 * ocean and "no berth" has to be distinguishable from "berth at the origin". */
const point = (p) => {
  if (!p || !isFinite(Number(p.x)) || !isFinite(Number(p.y))) return null
  return { x: num(p.x), y: num(p.y), ...(p.facing ? { facing: String(p.facing).slice(0, 16) } : {}) }
}

/* One entry in the composition. `map` empty is deliberate and is the whole of
 * the empty-slot ask: a position that exists, carries a state and reads as a
 * rumour, with no bundle behind it yet. */
export function cleanPlace(p) {
  if (!p || !isName(p.name)) return null
  const berth = point(p.berth)
  const approach = point(p.approach)
  return {
    name: p.name,
    map: typeof p.map === 'string' ? p.map.slice(0, 60) : '',
    title: typeof p.title === 'string' ? p.title.slice(0, 120) : '',
    x: num(p.x),
    y: num(p.y),
    w: Math.max(1, num(p.w, 64)),
    h: Math.max(1, num(p.h, 64)),
    state: ISLAND_STATES.includes(p.state) ? p.state : 'misty',
    /* how close the hull comes before this counts as discovered or its dock is
     * offered. `trigger` is an anchor kind, it lives inside a painting and its
     * radius caps at 64, so it could never answer this. */
    release: Math.max(0, num(p.release, 160)),
    ...(berth ? { berth } : {}),
    ...(approach ? { approach } : {}),
    ...(p.meta && typeof p.meta === 'object' && !Array.isArray(p.meta) ? { meta: p.meta } : {}),
  }
}

export function cleanRegion(r) {
  if (!r || !isName(r.name)) return null
  const rect = Array.isArray(r.rect) && r.rect.length === 4 && r.rect.every((n) => isFinite(Number(n)))
  if (!rect) return null
  return {
    name: r.name,
    kind: SEA_KINDS.includes(r.kind) ? r.kind : 'sailable',
    // two opposite corners, the same order and the same min/max tolerance the
    // anchor rect settled on, so one reader shape serves both
    rect: r.rect.map((n) => num(n)),
    ...(r.label ? { label: String(r.label).slice(0, 120) } : {}),
  }
}

export async function getWorld() {
  const w = await one('select w, h, places, regions, updated_at from world where id = 1')
  if (!w) return { w: 4096, h: 4096, places: [], regions: [] }
  return {
    w: w.w,
    h: w.h,
    places: Array.isArray(w.places) ? w.places : [],
    regions: Array.isArray(w.regions) ? w.regions : [],
    updatedAt: w.updated_at ? new Date(w.updated_at).getTime() : 0,
  }
}

/* WHAT A COMPOSITION IS NOT ALLOWED TO BE.
 *
 * The same argument as the publish gate: a world that cannot work should be
 * refused where it is written, naming the thing that is wrong, rather than
 * discovered by a student sailing into a berth that is not there. Names are the
 * addressing system, so a duplicate name is fatal; a map id nobody has
 * published is a warning rather than a refusal, because a slot is allowed to
 * name the island that is going to be painted next week.
 */
export function checkWorld(doc, slugs = []) {
  const problems = []
  const warnings = []
  const seen = new Set()
  for (const p of doc.places) {
    if (seen.has(p.name)) problems.push(`two places are both called "${p.name}", and a name is the only address there is`)
    seen.add(p.name)
    if (p.x < 0 || p.y < 0 || p.x > doc.w || p.y > doc.h)
      problems.push(`"${p.name}" sits at (${p.x},${p.y}), which is off a ${doc.w}x${doc.h} ocean`)
    if (p.map && slugs.length && !slugs.includes(p.map))
      warnings.push(`"${p.name}" names the map "${p.map}", which nothing has published yet`)
    if (!p.map && p.state !== 'rumoured')
      warnings.push(`"${p.name}" has no map, so only the state "rumoured" reads honestly; it says "${p.state}"`)
    /* A BERTH YOU CANNOT REACH IS WORSE THAN NO BERTH, because the ship sails
     * to it and stops. It has to be within the release radius or the island is
     * never discovered at the point the dock is offered. */
    if (p.berth) {
      const d = Math.hypot(p.berth.x - p.x, p.berth.y - p.y)
      if (d > p.release)
        warnings.push(
          `"${p.name}" berths ${Math.round(d)} out but is only released at ${p.release}, so the dock is offered before the island is discovered`,
        )
    }
  }
  const rseen = new Set()
  for (const r of doc.regions) {
    if (rseen.has(r.name)) problems.push(`two sea regions are both called "${r.name}"`)
    rseen.add(r.name)
  }
  return { problems, warnings }
}

export async function saveWorld(input) {
  const doc = {
    w: Math.max(1, num(input?.w, 4096)),
    h: Math.max(1, num(input?.h, 4096)),
    places: (Array.isArray(input?.places) ? input.places : []).map(cleanPlace).filter(Boolean),
    regions: (Array.isArray(input?.regions) ? input.regions : []).map(cleanRegion).filter(Boolean),
  }
  const slugs = (await q('select slug from maps')).rows.map((r) => r.slug)
  const { problems, warnings } = checkWorld(doc, slugs)
  if (problems.length) {
    const e = new Error(`the world was not saved · ${problems.join(' · ')}`)
    e.problems = problems
    throw e
  }
  await q(
    `insert into world (id, w, h, places, regions, updated_at)
     values (1, $1, $2, $3::jsonb, $4::jsonb, now())
     on conflict (id) do update set w = $1, h = $2, places = $3::jsonb, regions = $4::jsonb, updated_at = now()`,
    [doc.w, doc.h, JSON.stringify(doc.places), JSON.stringify(doc.regions)],
  )
  return { ...doc, warnings }
}
