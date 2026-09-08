// NEEDS WIRING: api.mjs has to call foldersApi() from route(), see the note at the bottom; every path here may fail and leave the dashboard correct, and the only delete names folders and folder_maps
import { q, one, many, tx } from '../db/pool.mjs'
import { currentUser } from './auth.mjs'
import { platformOn } from './platform.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// checked here because a non-uuid is a 22P02 thrown inside the driver rather than a 400 the page can read
const uuid = (s) => (UUID.test(String(s || '')) ? String(s) : null)

const slug = (s) => String(s || '').slice(0, 60)

const name = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 48)

// ---- reading ---------------------------------------------------------------

/* one query per table and not one joined query, because a join returns a slug once per folder it is in and the page has to undo that */
export async function listFolders(ownerId) {
  const folders = await many(
    'select id, name, sort from folders where owner_id = $1 order by sort, created_at',
    [ownerId],
  )
  const rows = await many(
    `select fm.folder_id, m.slug
     from folder_maps fm
     join folders f on f.id = fm.folder_id
     join maps m on m.id = fm.map_id
     where f.owner_id = $1
     order by fm.sort, fm.added_at`,
    [ownerId],
  )
  const inside = new Map()
  for (const r of rows) {
    const list = inside.get(r.folder_id)
    if (list) list.push(r.slug)
    else inside.set(r.folder_id, [r.slug])
  }
  const order = await many(
    `select m.slug from map_order o join maps m on m.id = o.map_id
     where o.owner_id = $1 order by o.sort`,
    [ownerId],
  )
  return {
    folders: folders.map((f) => ({ id: f.id, name: f.name, maps: inside.get(f.id) || [] })),
    order: order.map((r) => r.slug),
  }
}

// ---- the folders themselves ------------------------------------------------

// A new folder goes on the end of the rail. sort is sparse and set once here;
// the rail is otherwise in creation order, which is what somebody who has made
// three folders expects to see.
export async function createFolder(ownerId, wanted) {
  const clean = name(wanted) || 'untitled'
  const last = await one('select coalesce(max(sort), 0) as s from folders where owner_id = $1', [ownerId])
  const f = await one(
    'insert into folders (owner_id, name, sort) values ($1,$2,$3) returning id, name, sort',
    [ownerId, clean, (last?.s || 0) + 10],
  )
  return { id: f.id, name: f.name, maps: [] }
}

// owner_id is in the where clause of every write below, not checked first and
// then written. A check and a write are two statements and the id in between
// them is whatever the browser sent.
export async function renameFolder(ownerId, id, wanted) {
  const fid = uuid(id)
  if (!fid) return false
  const r = await q('update folders set name = $3 where id = $1 and owner_id = $2', [fid, ownerId, name(wanted) || 'untitled'])
  return r.rowCount > 0
}

/* no two-step confirm, because the maps are untouched and reappear on the all-maps list the moment the page reloads */
export async function removeFolder(ownerId, id) {
  const fid = uuid(id)
  if (!fid) return false
  const r = await q('delete from folders where id = $1 and owner_id = $2', [fid, ownerId])
  return r.rowCount > 0
}

// ---- what a map belongs to -------------------------------------------------

// The checkbox list saves as one call carrying the full answer rather than an
// add and a remove per box, so a picker that is closed halfway through cannot
// leave a map in a state nobody chose.
export async function setMapFolders(ownerId, mapSlug, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(uuid).filter(Boolean))]
  return tx(async (c) => {
    const m = await c.query('select id from maps where slug = $1 and owner_id = $2', [slug(mapSlug), ownerId])
    const mapId = m.rows[0]?.id
    if (!mapId) return false

    // only this account's folders, so a wrong id is dropped rather than
    // silently filing somebody else's map
    const mine = wanted.length
      ? (await c.query('select id from folders where owner_id = $1 and id = any($2::uuid[])', [ownerId, wanted])).rows.map((r) => r.id)
      : []

    await c.query(
      mine.length
        ? 'delete from folder_maps fm using folders f where f.id = fm.folder_id and f.owner_id = $1 and fm.map_id = $2 and fm.folder_id <> all($3::uuid[])'
        : 'delete from folder_maps fm using folders f where f.id = fm.folder_id and f.owner_id = $1 and fm.map_id = $2',
      mine.length ? [ownerId, mapId, mine] : [ownerId, mapId],
    )

    for (const fid of mine) {
      // a map dropped into a folder lands at the end of it, which is where the
      // hand that dropped it is looking
      await c.query(
        `insert into folder_maps (folder_id, map_id, sort)
         values ($1, $2, coalesce((select max(sort) from folder_maps where folder_id = $1), 0) + 10)
         on conflict (folder_id, map_id) do nothing`,
        [fid, mapId],
      )
    }
    return true
  })
}

// ---- the order things are listed in ----------------------------------------

/* the client sends the whole sequence and not one moved id, because reindexing neighbours leaves two rows on the same rank when two drags overlap */
export async function orderMaps(ownerId, folderId, slugs) {
  const seq = (Array.isArray(slugs) ? slugs : []).map(slug).filter(Boolean).slice(0, 500)
  if (!seq.length) return false
  const fid = folderId == null ? null : uuid(folderId)
  if (folderId != null && !fid) return false

  return tx(async (c) => {
    // slug -> id, restricted to this account, so an id that is not theirs never
    // makes it into an update
    const rows = (await c.query('select id, slug from maps where owner_id = $1 and slug = any($2::text[])', [ownerId, seq])).rows
    const byslug = new Map(rows.map((r) => [r.slug, r.id]))
    if (!byslug.size) return false

    if (fid) {
      const owns = await c.query('select id from folders where id = $1 and owner_id = $2', [fid, ownerId])
      if (!owns.rows.length) return false
    }

    let i = 0
    for (const s of seq) {
      const mapId = byslug.get(s)
      if (!mapId) continue
      const sort = (i += 10)
      if (fid) {
        await c.query('update folder_maps set sort = $3 where folder_id = $1 and map_id = $2', [fid, mapId, sort])
      } else {
        await c.query(
          `insert into map_order (owner_id, map_id, sort) values ($1,$2,$3)
           on conflict (owner_id, map_id) do update set sort = excluded.sort`,
          [ownerId, mapId, sort],
        )
      }
    }
    return true
  })
}

// ---- the http side ---------------------------------------------------------

/* one handler for every folders path, returning true when it answered, so api.mjs keeps one line and the feature is removed by deleting it */
export async function foldersApi(req, res, p) {
  if (p !== '/api/folders' && !p.startsWith('/api/folders/')) return false

  // no database means no folders, and the page is built to render without them.
  // 501 rather than 500 so an unconfigured install is not logged as a fault.
  if (!platformOn()) {
    send(res, 501, { error: 'folders need the database' })
    return true
  }

  const user = await currentUser(req)
  if (!user) {
    send(res, 401, { error: 'sign in first' })
    return true
  }

  if (p === '/api/folders') {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'read only' })
      return true
    }
    send(res, 200, await listFolders(user.id))
    return true
  }

  if (req.method !== 'POST') {
    send(res, 405, { error: 'post only' })
    return true
  }
  const b = await body(req)

  if (p === '/api/folders/create') {
    const folder = await createFolder(user.id, b.name)
    // "new folder for this map" is one gesture in the picker, so it is one
    // request here as well; a create that succeeds and a set that does not
    // would leave a folder nobody asked for
    if (b.map) await setMapFolders(user.id, b.map, [...(Array.isArray(b.folders) ? b.folders : []), folder.id])
    send(res, 200, { folder })
    return true
  }

  if (p === '/api/folders/rename') {
    send(res, 200, { ok: await renameFolder(user.id, b.folder, b.name) })
    return true
  }

  if (p === '/api/folders/remove') {
    send(res, 200, { ok: await removeFolder(user.id, b.folder) })
    return true
  }

  if (p === '/api/folders/set') {
    send(res, 200, { ok: await setMapFolders(user.id, b.map, b.folders) })
    return true
  }

  if (p === '/api/folders/order') {
    send(res, 200, { ok: await orderMaps(user.id, b.folder ?? null, b.maps) })
    return true
  }

  send(res, 404, { error: 'no such endpoint' })
  return true
}

/* body() reuses the same req._body slot on purpose, because the ownership gate drains the stream and a second reader ignoring the cached promise waits forever */
function send(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj))
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Content-Length', b.length)
  res.end(b)
}

function body(req) {
  if (req._body) return req._body
  return (req._body = new Promise((resolve, reject) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > 1024 * 1024) return reject(new Error('body too big'))
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  }))
}

/* to wire this up, call `if (await foldersApi(req, res, p)) return` in api.mjs route() BEFORE the POST ownership gate, which reads no map name out of these bodies anyway */
