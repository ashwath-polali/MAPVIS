/* THE PUBLISH GATE: the checks that already existed, run at the moment they
 * matter instead of by hand afterwards.
 *
 * Second most demanded item in the authoring sweep after the two map
 * properties. check-anchors.mjs already did the hip-band standability test off
 * a published levels.png, and its own header says "this is the test that should
 * have existed before the first door was placed" — and it is a CLI somebody has
 * to remember to run, against a version that has already shipped. The editor's
 * walk test, heal seams and reach check are buttons that write nothing into the
 * bundle and do not run at export. Nothing checked connectivity from the spawn,
 * nothing tested map.spawn at all, and nothing validated `to` or `toAnchor`
 * against the registry that is one query away.
 *
 * Meanwhile the requirement was already written down twice in the game repo, in
 * stations.ts and objective.ts, in a repo a member never opens. So a member
 * found out in a browser rather than in the tool, and a hall missing an anchor
 * published cleanly and failed when a student walked in.
 *
 * A version is immutable, so refusing costs a retry and publishing costs a
 * version number nobody can correct. It refuses.
 *
 * WHERE THE CONTRACT LIVES: here, in MAPVIS, per map class. That is a ruling
 * and it is reversible: a grape may want to extend it later with anchors its
 * own code needs, and the shape below is a list to add to rather than replace.
 */

/* what a map of each class has to carry before it is worth publishing. Kept
 * small on purpose: every line here is a thing an author cannot ship without,
 * and a gate that refuses for taste is a gate people learn to route around. */
const NEEDS = {
  island: [],
  // you have to be able to leave a place you can only be inside of
  room: ['a door out'],
  hall: ['a door out'],
}

/* one edit distance, capped, for naming the nearest thing to a misspelt slug.
 * Bounded rather than clever: the registry is tens of maps, not thousands. */
function near(want, options) {
  let best = null
  let bestD = Infinity
  for (const o of options) {
    const d = dist(String(want), String(o))
    if (d < bestD) {
      bestD = d
      best = o
    }
  }
  return bestD <= Math.max(2, Math.floor(String(want).length / 3)) ? best : null
}

function dist(a, b) {
  const m = a.length
  const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const row = [i]
    for (let j = 1; j <= n; j++)
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[n]
}

/* The game's own standability test, transcribed from check-anchors.mjs, which
 * transcribed it from the walk law: the hip band either side of the feet, so
 * nobody balances on a single legal pixel. */
function standTest(levels, mapJson) {
  const enc = mapJson.encoding || {}
  const tol = enc.stepTolerance ?? 10
  const hip = mapJson.character?.hip ?? 2
  const blocked = enc.blocked ?? 0
  const { w, h, data } = levels
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[((y | 0) * w + (x | 0)) * 4])
  const standable = (x, y) => {
    const here = at(x, y)
    if (here <= blocked) return false
    for (let dx = -hip; dx <= hip; dx++) {
      const v = at(x + dx, y)
      if (v <= 0 || Math.abs(v - here) > tol) return false
    }
    return true
  }
  return { w, h, tol, at, standable }
}

/* WHERE A BODY ACTUALLY HAS TO BE ABLE TO GET TO. An anchor with standable
 * ground under it that no walk from the spawn can reach is exactly as dead as
 * one on a wall, and it is the failure a 1px seam produces: invisible below 6x,
 * and the reach button in the editor writes nothing into the bundle. */
function reachableFrom(sx, sy, t) {
  const { w, h, standable, at, tol } = t
  const seen = new Uint8Array(w * h)
  const qx = [sx | 0]
  const qy = [sy | 0]
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return seen
  seen[(sy | 0) * w + (sx | 0)] = 1
  const D = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ]
  for (let i = 0; i < qx.length; i++) {
    const x = qx[i]
    const y = qy[i]
    const cur = at(x, y)
    for (const [dx, dy] of D) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const k = ny * w + nx
      if (seen[k]) continue
      if (!standable(nx, ny)) continue
      // the same legal-step rule the walker uses, or the flood walks up a cliff
      if (Math.abs(at(nx, ny) - cur) > tol) continue
      seen[k] = 1
      qx.push(nx)
      qy.push(ny)
    }
  }
  return seen
}

/* Is any pixel inside this anchor's ring both standable and in the reached set.
 * The ring rather than the centre, because a door's centre is legitimately the
 * painted archway and the walkable pixels are the mat in front of it. */
function ringOk(a, t, reached) {
  const r = a.r || 14
  const { w, standable } = t
  let stand = 0
  let got = 0
  for (let y = a.y - r; y <= a.y + r; y++)
    for (let x = a.x - r; x <= a.x + r; x++) {
      if ((x - a.x) ** 2 + (y - a.y) ** 2 > r * r) continue
      if (!standable(x, y)) continue
      stand++
      if (reached && reached[y * w + x]) got++
    }
  return { stand, got }
}

/* the kinds a body has to be able to walk up to. A region and a trigger fire by
 * being entered and a spawn is where you begin, so all three are checked for
 * standable ground and not for a reachable ring. */
const INTERACTIVE = new Set(['door', 'post', 'point'])

/* THE GATE. Two lists of sentences, each naming the thing and what to do about
 * it. A PROBLEM is something that can never work and it stops the publish; a
 * WARNING is a fact the author should know and is said in the log. No problems
 * means publish. Nothing here throws: the caller decides what a problem costs,
 * and it costs the version. */
export function gateMap({ mapJson, anchors, levels, slugs }) {
  const problems = []
  const warnings = []
  const cls = mapJson.class || 'island'

  /* ---- the map graph, checked against a registry nothing had ever consulted.
   *
   * The hub's one door has pointed at `panther-maw`, a map that does not
   * exist, since the day it was placed, and nothing anywhere said so.
   *
   * BUT A DOOR TO A MAP THAT IS NOT PAINTED YET IS A DESIGN, NOT A MISTAKE.
   * The Maw's two side tunnels end at real named doors pointing at rooms
   * nobody has painted, deliberately, so the place reads as having more of
   * itself past the walls, and the game already renders "<label> · the way is
   * barred" for exactly that. Refusing it would make the tool refuse the
   * thing the design asks for.
   *
   * So the two cases are told apart by whether there is something close by. A
   * target one edit away from a real map is a typo and stops the publish; a
   * target nothing resembles is a room that has not been built and is said out
   * loud instead. */
  const known = new Set(slugs || [])
  for (const a of anchors) {
    if (!a.to || known.has(a.to)) continue
    const guess = near(a.to, [...known])
    if (guess)
      problems.push(`the door "${a.name}" leads to "${a.to}", and no map has that id. Did you mean "${guess}"?`)
    else
      warnings.push(
        `"${a.name}" leads to "${a.to}", which is not published yet, so the game will say the way is barred.`,
      )
  }
  // toAnchor is checked by the caller, which is the only side that can ask
  // another map what it is called. Anything it found comes in as a problem.

  // ---- what this class of map has to carry --------------------------------
  const doorsOut = anchors.filter((a) => a.kind === 'door' && a.to)
  for (const need of NEEDS[cls] || []) {
    if (need === 'a door out' && !doorsOut.length)
      problems.push(
        `a ${cls} needs at least one door leading somewhere, or a player who walks in can never walk out.`,
      )
  }

  // ---- the ground ----------------------------------------------------------
  if (!levels) {
    problems.push('there is no levels plane in this bundle, so nothing about the ground could be checked.')
    return { problems, warnings }
  }
  const t = standTest(levels, mapJson)

  /* WHERE THE PLAYER BEGINS, tested at all for the first time. A spawn anchor
   * silently wins over map.spawn in the game's own arrival(), so that is the
   * order it is resolved in here too. */
  const spawnAnchor = anchors.find((a) => a.kind === 'spawn')
  const sx = spawnAnchor ? spawnAnchor.x : mapJson.spawn?.[0]
  const sy = spawnAnchor ? spawnAnchor.y : mapJson.spawn?.[1]
  if (!isFinite(sx) || !isFinite(sy)) {
    problems.push('this map has no start point, so a player arriving has nowhere to stand.')
    return { problems, warnings }
  }
  if (!t.standable(sx, sy)) {
    // walk out from the start looking for the nearest pixel that does work, so
    // the fix is a direction rather than a hunt
    let best = null
    let bestD = Infinity
    for (let y = 0; y < t.h; y++)
      for (let x = 0; x < t.w; x++) {
        if (!t.standable(x, y)) continue
        const d = Math.hypot(x - sx, y - sy)
        if (d < bestD) {
          bestD = d
          best = [x, y]
        }
      }
    problems.push(
      `the start point (${sx},${sy}) is not somewhere a body can stand` +
        (best ? `. The nearest ground is ${bestD.toFixed(0)}px away at (${best[0]},${best[1]}).` : '.'),
    )
    return { problems, warnings }
  }

  const reached = reachableFrom(sx, sy, t)
  for (const a of anchors) {
    if (!INTERACTIVE.has(a.kind)) continue
    const { stand, got } = ringOk(a, t, reached)
    if (!stand) {
      problems.push(
        `"${a.name}" at (${a.x},${a.y}) has nothing standable inside its ${a.r || 14}px reach, ` +
          `so the game will never offer it. Move it onto the floor, widen its reach, or paint ground under it.`,
      )
    } else if (!got) {
      problems.push(
        `"${a.name}" at (${a.x},${a.y}) stands on ground a player cannot walk to from the start point. ` +
          `Something is fencing it off: try fix gaps, then check reach.`,
      )
    }
    /* the stand-at point is where a body actually ends up, so it is the pixel
     * that has to work. A ring with floor in it and a stand-at on the tabletop
     * is a station that walks the player into the furniture. */
    if (a.stand && !t.standable(a.stand[0], a.stand[1]))
      problems.push(
        `"${a.name}" is used from (${a.stand[0]},${a.stand[1]}), which is not somewhere a body can stand.`,
      )
  }
  return { problems, warnings }
}
