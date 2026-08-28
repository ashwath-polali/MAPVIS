/* Home, once you are signed in.
 *
 * Not a room, not a desk, not a bookshelf with maps in it. Skeuomorphism is
 * where this goes wrong: a fake wooden shelf is a costume over a list, and it
 * gets in the way the moment you have twenty maps.
 *
 * So it is an interface, and what stops it being a blank list is that the newest
 * map runs across the top at full width as a real banner, and every card below
 * is a big unfiltered painting. The only colour on the page comes out of the
 * work. Chrome stays out of the way.
 *
 * Folders sit on top of that and are allowed to be absent. Everything to do
 * with them hangs off one GET, and when that GET does not answer the rail, the
 * per-card picker and the dragging all disappear and this is the page it has
 * always been with every map in one list. Organising is never what decides
 * whether you can see your own work.
 */
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link, go } from './router'
import { useSession, signOut } from './session'
import { Settings } from './Settings'

type MapRow = {
  id: string
  slug: string
  title: string
  w: number
  h: number
  updated_at: string
  anchors: number
  library: number
  placements: number
  published: number | null
}

// A map may be in more than one of these at once, which is why the control on
// a card is a checkbox list rather than a dropdown. maps holds slugs, in the
// order they were dragged into this folder.
type Folder = { id: string; name: string; maps: string[] }

const when = (iso: string) => {
  const s = (Date.now() - +new Date(iso)) / 1000
  if (s < 120) return 'just now'
  if (s < 5400) return Math.round(s / 60) + ' min ago'
  if (s < 172800) return Math.round(s / 3600) + ' hr ago'
  const d = Math.round(s / 86400)
  return d < 30 ? d + ' days ago' : new Date(iso).toLocaleDateString()
}
/* A MAP THAT HAS NEVER BEEN EXPORTED STILL HAS A PICTURE.
 *
 * This only ever pointed at a published bundle, so a map you had painted but
 * not yet exported showed "no painting yet", and every card on the page was a
 * read out of object storage. The working scene is the better source for a
 * thumbnail on both counts: it is what the map looks like right now rather than
 * at the last export, and /work/ is served from local disk when this machine
 * has it, so a page of cards costs nothing.
 *
 * The published copy stays the first choice, because on a host it is the only
 * one that exists. */
const shot = (m: MapRow) => `/work/${m.slug}/scene.png`

/* THE ORDER SOMEBODY DRAGGED THINGS INTO, APPLIED TO THE LIST THE SERVER SENT.
 *
 * A map that is not in the sequence sorts to the top rather than the bottom,
 * and that is the whole rule: a map with no place in a hand-made order is a map
 * made after that order was made, so it is the newest thing here. Sinking new
 * work under a list sorted a month ago is how a dashboard starts hiding things.
 *
 * The incoming list is already newest-first and sort is stable, so everything
 * unplaced keeps that order among itself. */
const inOrder = (list: MapRow[], seq: string[]) => {
  if (!seq.length) return list
  const at = new Map(seq.map((s, i) => [s, i]))
  return [...list].sort((a, b) => (at.get(a.slug) ?? -1) - (at.get(b.slug) ?? -1))
}

export default function Home() {
  const { user, loading } = useSession()
  const [maps, setMaps] = useState<MapRow[] | null>(null)
  const [q, setQ] = useState('')
  const [settings, setSettings] = useState(false)
  const [doomed, setDoomed] = useState<MapRow | null>(null)

  // null means the folders api did not answer, and the page renders without any
  // of it. Every read below has to survive that, so nothing dereferences this
  // without checking.
  const [folders, setFolders] = useState<Folder[] | null>(null)
  const [order, setOrder] = useState<string[]>([])
  const [sel, setSel] = useState<string>('')
  const [picking, setPicking] = useState('')
  // the drag in progress: which map is in the hand, and what it is hovering
  const [lift, setLift] = useState('')
  const [overF, setOverF] = useState('')
  const [overM, setOverM] = useState('')

  const pull = () =>
    fetch('/api/folders')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { folders?: Folder[]; order?: string[] }) => {
        setFolders(j.folders || [])
        setOrder(j.order || [])
      })
      .catch(() => {})

  /* Organising is optimistic: the card moves under the hand and the request
   * follows it. A write that fails re-reads the whole thing rather than trying
   * to undo one step of a list that has been dragged three more times since, so
   * the page ends up agreeing with the database instead of with a guess. */
  const post = (path: string, b: unknown) =>
    fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .catch(() => {
        void pull()
        return null
      })

  useEffect(() => {
    if (loading) return
    if (!user) {
      go('/', true)
      return
    }
    /* A FAILED REFETCH MUST NOT LOOK LIKE AN EMPTY ACCOUNT.
     *
     * This set the list to [] on any error, and [] is not "we could not ask",
     * it is "you have no maps", which renders the first-run screen. So a blip
     * while a panel was open wiped a page full of work off the screen and a
     * refresh brought it all back, because nothing was ever wrong with the data.
     *
     * A refetch that fails now leaves what is already on screen alone, and only
     * an answer the server actually gave can empty the page. */
    let dead = false
    fetch('/api/my-maps')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        if (!dead) setMaps(j.maps || [])
      })
      .catch(() => {
        if (!dead) setMaps((prev) => prev ?? [])
      })
    return () => {
      dead = true
    }
  }, [user, loading])

  // Folders are their own request on purpose. Hanging them off /api/my-maps
  // would mean an error in a preference takes the list of somebody's work down
  // with it, and the list of work is the entire point of this page.
  useEffect(() => {
    if (loading || !user) return
    void pull()
  }, [user, loading])

  const memberOf = (slug: string) => (folders || []).filter((f) => f.maps.includes(slug)).map((f) => f.id)

  const setIn = (slug: string, id: string, on: boolean) => {
    const now = folders || []
    if (on === now.find((f) => f.id === id)?.maps.includes(slug)) return
    const next = on ? [...memberOf(slug), id] : memberOf(slug).filter((x) => x !== id)
    setFolders(now.map((f) => (f.id === id ? { ...f, maps: on ? [...f.maps, slug] : f.maps.filter((s) => s !== slug) } : f)))
    void post('/api/folders/set', { map: slug, folders: next })
  }

  // one gesture in the picker is one request here, so a create that lands and a
  // set that does not can never leave a folder nobody asked for
  const make = async (name: string, slug?: string) => {
    const clean = name.trim()
    if (!clean) return
    const j = await post('/api/folders/create', { name: clean, map: slug || null, folders: slug ? memberOf(slug) : [] })
    if (!j?.folder) return
    setFolders((fs) => [...(fs || []), { id: j.folder.id, name: String(j.folder.name || clean), maps: slug ? [slug] : [] }])
  }

  const rename = (id: string, name: string) => {
    const clean = name.trim()
    if (!clean) return
    setFolders((fs) => (fs || []).map((f) => (f.id === id ? { ...f, name: clean } : f)))
    void post('/api/folders/rename', { folder: id, name: clean })
  }

  // the folder goes, the maps in it do not. They are back on the all-maps list
  // the moment this returns, which is why it does not ask twice the way
  // deleting a map does: there is nothing here to lose.
  const scrap = (id: string) => {
    setFolders((fs) => (fs || []).filter((f) => f.id !== id))
    if (sel === id) setSel('')
    void post('/api/folders/remove', { folder: id })
  }

  const found = useMemo(
    () => (maps || []).filter((m) => !q || (m.title + m.slug).toLowerCase().includes(q.toLowerCase())),
    [maps, q],
  )
  const folder = (folders || []).find((f) => f.id === sel) || null
  const shown = useMemo(() => {
    const list = folder ? found.filter((m) => folder.maps.includes(m.slug)) : found
    return inOrder(list, folder ? folder.maps : order)
  }, [found, folder, order])

  // the most recently touched map that has something to show leads the page.
  // Inside a folder there is no lead: you came to look at a set, not at one of
  // them blown up over the rest.
  const lead = !q && !folder ? shown.find((m) => shot(m)) : undefined
  const rest = lead ? shown.filter((m) => m.id !== lead.id) : shown

  /* REORDERING WRITES THE WHOLE VISIBLE SEQUENCE, so it is only offered when
   * the whole list is visible. With a search term on, the sequence sent would
   * cover the matches and nothing else, and every map filtered out would keep
   * a rank from before, which is not a rearrangement of anything anybody can
   * see. Dropping onto a folder still works while searching, because that
   * writes one membership and not an order. */
  const sortable = !!folders && !q
  const move = (from: string, to: string, before: boolean) => {
    if (!sortable || from === to) return
    const seq = shown.map((m) => m.slug)
    const i = seq.indexOf(from)
    if (i < 0) return
    seq.splice(i, 1)
    let j = seq.indexOf(to)
    if (j < 0) return
    if (!before) j++
    seq.splice(j, 0, from)
    if (folder) setFolders((fs) => (fs || []).map((f) => (f.id === folder.id ? { ...f, maps: seq } : f)))
    else setOrder(seq)
    void post('/api/folders/order', { folder: folder ? folder.id : null, maps: seq })
  }

  const org = (m: MapRow): Org | undefined =>
    folders
      ? {
          folders,
          mine: memberOf(m.slug),
          open: picking === m.slug,
          onOpen: (v: boolean) => setPicking(v ? m.slug : ''),
          onSet: (id, on) => setIn(m.slug, id, on),
          onNew: (name) => void make(name, m.slug),
          lifted: lift === m.slug,
          mark: overM === m.slug + ':b' ? 'before' : overM === m.slug + ':a' ? 'after' : '',
          onLift: () => setLift(m.slug),
          onHover: (before) => sortable && lift && lift !== m.slug && setOverM(m.slug + (before ? ':b' : ':a')),
          onLeave: () => setOverM((v) => (v.startsWith(m.slug + ':') ? '' : v)),
          onDrop: (before) => {
            if (lift) move(lift, m.slug, before)
            setLift('')
            setOverM('')
          },
          onDone: () => {
            setLift('')
            setOverM('')
            setOverF('')
          },
        }
      : undefined

  return (
    <div className="home">
      <header className="home-bar">
        <button className="home-mark" onClick={() => go('/')} aria-label="home">
            MAPVIS
          </button>
        <div className="home-bar-r">
          <input
            className="home-find"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="find a map"
            spellCheck={false}
          />
          <button className="home-icon" aria-label="settings" title="settings" onClick={() => setSettings(true)}>
            <Gear />
          </button>
          <button
            className="home-icon"
            aria-label="sign out"
            title="sign out"
            onClick={() => void signOut().then(() => go('/'))}
          >
            <Out />
          </button>
        </div>
      </header>

      <main className="home-body">
        {maps === null ? (
          <div className="home-wait" />
        ) : maps.length === 0 ? (
          <Blank />
        ) : (
          <>
            {lead && <Lead m={lead} onDelete={() => setDoomed(lead)} />}
            <div className={folders ? 'home-split' : ''}>
              {folders && (
                <Rail
                  folders={folders}
                  all={maps.length}
                  sel={sel}
                  onPick={setSel}
                  onNew={(name) => void make(name)}
                  onRename={rename}
                  onScrap={scrap}
                  lift={lift}
                  over={overF}
                  onOver={setOverF}
                  onDrop={(id) => {
                    if (lift) setIn(lift, id, true)
                    setLift('')
                    setOverF('')
                  }}
                />
              )}
              <div>
                <div className="grid">
                  <button className="card new" onClick={() => go('/edit')}>
                    <span className="new-plus" aria-hidden>
                      +
                    </span>
                    <span className="new-say">new map</span>
                    <span className="new-sub">start from a painting</span>
                  </button>
                  {rest.map((m) => (
                    <Card key={m.id} m={m} onDelete={() => setDoomed(m)} org={org(m)} />
                  ))}
                </div>
                {folder && !shown.length && (
                  <p className="fold-empty">nothing in this folder yet · drag a map onto it, or tick it on a card</p>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {settings && <Settings onClose={() => setSettings(false)} />}
      {doomed && (
        <DeleteMap
          m={doomed}
          onClose={() => setDoomed(null)}
          onGone={() => {
            // dropped from the list here rather than refetched, so the card
            // cannot flash back while the request settles
            setMaps((all) => (all || []).filter((x) => x.id !== doomed.id))
            // the membership row went with it in the database; this keeps the
            // counts in the rail honest without another round trip
            setFolders((fs) => (fs || []).map((f) => ({ ...f, maps: f.maps.filter((s) => s !== doomed.slug) })))
            setDoomed(null)
          }}
        />
      )}
    </div>
  )
}

/* The newest map, across the whole width. It is the one thing on this page that
 * is allowed to be big, and it is what stops the screen reading as a list. */
function Lead({ m, onDelete }: { m: MapRow; onDelete: () => void }) {
  return (
    <div className="lead">
      <a className="lead-hit" href={`/edit?id=${encodeURIComponent(m.slug)}`} aria-label={`edit ${m.slug}`} />
      {/* above the full-bleed hit area, or the link swallows the click */}
      <button className="card-bin lead-bin" title={`delete ${m.slug}`} aria-label={`delete ${m.slug}`} onClick={onDelete}>
        <Trash />
      </button>
      <img src={shot(m) as string} alt="" />
      <div className="lead-say">
        <span className="lead-when">last opened {when(m.updated_at)}</span>
        <h1>{m.title || m.slug}</h1>
        <div className="lead-nums">
          <span>
            {m.w}&times;{m.h}
          </span>
          <span>{m.placements} placed</span>
          <span>{m.anchors} named</span>
          {m.published != null && <span>v{m.published}</span>}
        </div>
        {/* two ways in, because the newest map is the one you are most likely
            to want to either carry on with OR go and stand in */}
        <div className="lead-acts">
          <a className="lead-go" href={`/edit?id=${encodeURIComponent(m.slug)}`}>
            keep working
          </a>
          {m.published != null && (
            <Link to={`/maps/${m.slug}`} className="lead-go alt">
              walk it
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

/* Everything a card needs to take part in organising, in one optional prop.
 * Absent means the folders api did not answer, and every branch that reads it
 * falls back to the card this page has always had. */
type Org = {
  folders: Folder[]
  mine: string[]
  open: boolean
  onOpen: (v: boolean) => void
  onSet: (id: string, on: boolean) => void
  onNew: (name: string) => void
  lifted: boolean
  mark: '' | 'before' | 'after'
  onLift: () => void
  onHover: (before: boolean) => void
  onLeave: () => void
  onDrop: (before: boolean) => void
  onDone: () => void
}

function Card({ m, onDelete, org }: { m: MapRow; onDelete: () => void; org?: Org }) {
  const src = shot(m)
  // which half of the card the pointer is on decides which side of it the
  // dragged map lands, which is the only way a drop between two cards can be
  // aimed without a separate gap to hit
  const half = (e: DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientX < r.left + r.width / 2
  }
  return (
    <article
      className={'card' + (org?.mark ? ' drop-' + org.mark : '') + (org?.lifted ? ' lifted' : '')}
      /* not while the picker is open: a draggable ancestor swallows the mouse
         down that would otherwise be a caret landing in the name field */
      draggable={!!org && !org.open}
      onDragStart={(e) => {
        if (!org) return
        e.dataTransfer.effectAllowed = 'move'
        // a payload as well as our own state, because a drag carrying nothing
        // is one some browsers refuse to start
        e.dataTransfer.setData('text/plain', m.slug)
        org.onLift()
      }}
      onDragEnd={() => org?.onDone()}
      onDragOver={(e) => {
        if (!org) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        org.onHover(half(e))
      }}
      onDragLeave={(e) => {
        // crossing onto the painting inside this card is not leaving the card,
        // and without this the marker blinks off and back on every time the
        // pointer passes over a child
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        org?.onLeave()
      }}
      onDrop={(e) => {
        if (!org) return
        e.preventDefault()
        org.onDrop(half(e))
      }}
    >
      <button className="card-bin" title={`delete ${m.slug}`} aria-label={`delete ${m.slug}`} onClick={onDelete}>
        <Trash />
      </button>
      {/* the link and the image are draggable by default, and a link drag is
          not the drag this card means, so both hand it up to the article */}
      <a className="card-art" href={`/edit?id=${encodeURIComponent(m.slug)}`} draggable={false}>
        {src ? (
          <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <span className="card-none">no painting yet</span>
        )}
      </a>
      <div className="card-say">
        <div className="card-top">
          <h2>{m.title || m.slug}</h2>
          <span className="card-when">{when(m.updated_at)}</span>
        </div>
        <div className="card-nums">
          <span>
            {m.w}&times;{m.h}
          </span>
          <span>{m.placements} placed</span>
          <span className={m.anchors ? 'lit' : ''}>{m.anchors} named</span>
          {m.published != null ? <span className="lit">v{m.published}</span> : null}
        </div>
        <div className="card-do">
          <a href={`/edit?id=${encodeURIComponent(m.slug)}`} draggable={false}>
            edit
          </a>
          {m.published != null ? <Link to={`/maps/${m.slug}`}>walk</Link> : null}
          {org && (
            <button
              className={'card-fold' + (org.mine.length ? ' on' : '')}
              title={org.mine.length ? `in ${org.mine.length} folder${org.mine.length === 1 ? '' : 's'}` : 'put in a folder'}
              aria-label={`folders for ${m.slug}`}
              aria-expanded={org.open}
              onClick={() => org.onOpen(!org.open)}
            >
              <FolderIcon />
              {org.mine.length > 1 && <span className="card-foldn">{org.mine.length}</span>}
            </button>
          )}
          {org?.open && (
            <Pick folders={org.folders} mine={org.mine} onSet={org.onSet} onNew={org.onNew} onClose={() => org.onOpen(false)} />
          )}
        </div>
      </div>
    </article>
  )
}

/* WHICH FOLDERS THIS MAP IS IN, as checkboxes, because it can be in several.
 *
 * A dropdown would be the smaller control and it would be the wrong one: it
 * says pick one, and the hub is both "the island" and "what I am working on
 * this week". Ticking is also the only place a map leaves a folder, so the same
 * list has to read as the answer rather than as a menu of moves.
 *
 * It closes on a click anywhere else and on escape. Nothing in it is
 * destructive, so nothing in it confirms. */
function Pick({
  folders,
  mine,
  onSet,
  onNew,
  onClose,
}: {
  folders: Folder[]
  mine: string[]
  onSet: (id: string, on: boolean) => void
  onNew: (name: string) => void
  onClose: () => void
}) {
  const [making, setMaking] = useState(!folders.length)
  const [name, setName] = useState('')

  useEffect(() => {
    const off = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.('.pick')) onClose()
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    // on the next frame, or the click that opened this closes it again
    const t = window.setTimeout(() => window.addEventListener('mousedown', off), 0)
    window.addEventListener('keydown', esc)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('mousedown', off)
      window.removeEventListener('keydown', esc)
    }
  }, [onClose])

  const add = () => {
    if (!name.trim()) return
    onNew(name)
    setName('')
    setMaking(false)
    onClose()
  }

  return (
    <div className="pick" role="group" aria-label="folders">
      {folders.length > 0 && (
        <ul className="pick-list">
          {folders.map((f) => (
            <li key={f.id}>
              <label>
                <input type="checkbox" checked={mine.includes(f.id)} onChange={(e) => onSet(f.id, e.target.checked)} />
                <span>{f.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {making ? (
        <input
          className="pick-name"
          autoFocus
          value={name}
          spellCheck={false}
          placeholder="folder name"
          maxLength={48}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
            if (e.key === 'Escape') setMaking(false)
          }}
          onBlur={add}
        />
      ) : (
        <button className="pick-new" onClick={() => setMaking(true)}>
          + new folder
        </button>
      )}
    </div>
  )
}

/* The rail. Folders are a filter, not a place a map is moved to, so "all maps"
 * is a row like any other and it is where the page starts.
 *
 * A folder row is the drop target that makes dragging worth having: pick a card
 * up anywhere in the grid and let go on a name. The counts are there so an
 * empty folder is visibly empty rather than looking like a filter that broke. */
function Rail({
  folders,
  all,
  sel,
  onPick,
  onNew,
  onRename,
  onScrap,
  lift,
  over,
  onOver,
  onDrop,
}: {
  folders: Folder[]
  all: number
  sel: string
  onPick: (id: string) => void
  onNew: (name: string) => void
  onRename: (id: string, name: string) => void
  onScrap: (id: string) => void
  lift: string
  over: string
  onOver: (id: string) => void
  onDrop: (id: string) => void
}) {
  const [making, setMaking] = useState(false)
  const [name, setName] = useState('')

  const add = () => {
    if (name.trim()) onNew(name)
    setName('')
    setMaking(false)
  }

  return (
    <aside className="rail" aria-label="folders">
      <button className={'rail-row rail-hit' + (sel ? '' : ' on')} onClick={() => onPick('')}>
        <span className="rail-name">all maps</span>
        <span className="rail-n">{all}</span>
      </button>
      {folders.map((f) => (
        <RailRow
          key={f.id}
          f={f}
          on={sel === f.id}
          over={over === f.id}
          taking={!!lift}
          onPick={() => onPick(f.id)}
          onRename={(n) => onRename(f.id, n)}
          onScrap={() => onScrap(f.id)}
          onOver={() => onOver(f.id)}
          onOut={() => onOver('')}
          onDrop={() => onDrop(f.id)}
        />
      ))}
      {making ? (
        <input
          className="rail-name-in"
          autoFocus
          value={name}
          spellCheck={false}
          placeholder="folder name"
          maxLength={48}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
            if (e.key === 'Escape') {
              setName('')
              setMaking(false)
            }
          }}
          onBlur={add}
        />
      ) : (
        <button className="rail-new" onClick={() => setMaking(true)}>
          + new folder
        </button>
      )}
    </aside>
  )
}

function RailRow({
  f,
  on,
  over,
  taking,
  onPick,
  onRename,
  onScrap,
  onOver,
  onOut,
  onDrop,
}: {
  f: Folder
  on: boolean
  over: boolean
  taking: boolean
  onPick: () => void
  onRename: (name: string) => void
  onScrap: () => void
  onOver: () => void
  onOut: () => void
  onDrop: () => void
}) {
  const [edit, setEdit] = useState(false)
  const [name, setName] = useState(f.name)
  const [sure, setSure] = useState(false)

  const done = () => {
    setEdit(false)
    if (name.trim() && name.trim() !== f.name) onRename(name)
    else setName(f.name)
  }

  return (
    <div
      className={'rail-row' + (on ? ' on' : '') + (over ? ' over' : '')}
      onDragOver={(e) => {
        if (!taking) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        onOver()
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        onOut()
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
    >
      {edit ? (
        <input
          className="rail-name-in"
          autoFocus
          value={name}
          spellCheck={false}
          maxLength={48}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') done()
            if (e.key === 'Escape') {
              setName(f.name)
              setEdit(false)
            }
          }}
          onBlur={done}
        />
      ) : (
        <button className="rail-hit" onClick={onPick} onDoubleClick={() => setEdit(true)} title="double click to rename">
          <span className="rail-name">{f.name}</span>
          <span className="rail-n">{f.maps.length}</span>
        </button>
      )}
      {!edit &&
        (sure ? (
          <span className="rail-sure">
            <button onClick={onScrap}>remove</button>
            <button onClick={() => setSure(false)}>keep</button>
          </span>
        ) : (
          <button className="rail-x" title={`remove the folder ${f.name}`} aria-label={`remove the folder ${f.name}`} onClick={() => setSure(true)}>
            ×
          </button>
        ))}
    </div>
  )
}

function Blank() {
  return (
    <div className="blank">
      <h1>Nothing here yet.</h1>
      <p>A map starts as one painting. Bring one in and cut the parts you can walk on out of it.</p>
      <button className="sheet-btn" onClick={() => go('/edit')}>
        Make your first map
      </button>
    </div>
  )
}

/* Drawn on a pixel grid rather than lifted from an icon set. */
function Out() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" shapeRendering="crispEdges" aria-hidden>
      <path fill="currentColor" d="M2 2h7v2H4v8h5v2H2zM10 5h2v2h-2zM12 7h3v2h-3zM10 9h2v2h-2z" />
    </svg>
  )
}

function Trash() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" shapeRendering="crispEdges" aria-hidden>
      <path
        fill="currentColor"
        d="M6 1h4v1H6zM3 3h10v1H3zM4 5h1v9H4zM11 5h1v9h-1zM5 14h6v1H5zM6 6h1v7H6zM9 6h1v7H9z"
      />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" shapeRendering="crispEdges" aria-hidden>
      <path fill="currentColor" d="M1 3h6v1H1zM1 4h14v1H1zM1 5h1v8H1zM14 5h1v8h-1zM2 13h13v1H2z" />
    </svg>
  )
}

/* DELETING A MAP, IN TWO DELIBERATE STEPS.
 *
 * A map is months of painting and hand-drawn mask, and one of these was once
 * destroyed by a test that pointed at a real slug. So this asks twice, and the
 * two questions are different on purpose: the first confirms WHICH map, spelling
 * out its slug and what goes with it, and the second proves WHO you are. A
 * double confirm that asks the same question twice trains you to click through
 * both.
 *
 * The destructive button is never focused when a step opens, so a stray return
 * key lands on nothing. Escape and the backdrop both cancel. The password is
 * only ever sent to /api/maps/delete, which checks the session, the ownership
 * and the password again on the server; nothing here is the security. */
function DeleteMap({ m, onClose, onGone }: { m: MapRow; onClose: () => void; onGone: () => void }) {
  const [step, setStep] = useState<'confirm' | 'password'>('confirm')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose, busy])

  const remove = async () => {
    if (busy || !pw) return
    setBusy(true)
    setErr('')
    try {
      const r = await fetch('/api/maps/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: m.slug, password: pw }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setErr(j.error || `could not delete (${r.status})`)
        setBusy(false)
        return
      }
      onGone()
    } catch (e) {
      setErr(String((e as Error).message || e))
      setBusy(false)
    }
  }

  /* PORTALLED TO THE BODY, NOT LEFT INSIDE THE PAGE.
   *
   * .home and its cards carry transforms, and a transformed ancestor becomes the
   * containing block for position:fixed, so a panel rendered inside the grid is
   * fixed to the grid rather than to the window. That is how a dialog ends up
   * dragging the page behind it around and leaving it looking like a different
   * screen. At the body it is fixed to the viewport, which is the only thing it
   * was ever meant to be fixed to. */
  return createPortal(
    <div className="sheet-wrap" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="sheet danger" role="dialog" aria-modal="true" aria-label={`delete ${m.slug}`}>
        {step === 'confirm' ? (
          <>
            <h2>
              delete <b>{m.slug}</b>?
            </h2>
            <p>
              The painting, the mask you drew by hand, all {m.placements} placement{m.placements === 1 ? '' : 's'} and
              every published version go with it. This cannot be undone.
            </p>
            <div className="sheet-acts">
              <button className="sheet-no" onClick={onClose} autoFocus>
                keep it
              </button>
              <button className="sheet-yes" onClick={() => setStep('password')}>
                yes, delete
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>type your password</h2>
            <p>
              This proves the account, not the map. <b>{m.slug}</b> is removed the moment it matches.
            </p>
            <input
              className="sheet-pw"
              type="password"
              value={pw}
              autoFocus
              disabled={busy}
              placeholder="account password"
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void remove()}
            />
            {err && <p className="sheet-err">{err}</p>}
            <div className="sheet-acts">
              <button className="sheet-no" onClick={onClose} disabled={busy}>
                cancel
              </button>
              <button className="sheet-yes" onClick={() => void remove()} disabled={busy || !pw}>
                {busy ? 'deleting…' : 'delete for good'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

function Gear() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" shapeRendering="crispEdges" aria-hidden>
      <path
        fill="currentColor"
        d="M7 1h2v2H7zM7 13h2v2H7zM1 7h2v2H1zM13 7h2v2h-2zM3 3h2v2H3zM11 3h2v2h-2zM3 11h2v2H3zM11 11h2v2h-2zM6 6h4v4H6z"
      />
    </svg>
  )
}
