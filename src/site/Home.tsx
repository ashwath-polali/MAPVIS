/* home. every folder feature hangs off one GET, and a failed GET falls back to every map in one list. */
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link, go } from './router'
import { useSession, signOut } from './session'
import { Settings } from './Settings'
import { Icon } from '../ui/icons'
/* untitled maps showed their kebab-case slug as a name; the slug stays the link address, not the words. */
import { displayName } from '../core/naming'

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
  /* whose hand drew it. Empty on every map made before there was a choice, and
   * on every map drawn under Other, which is not a fault and is not marked. */
  style?: string | null
  style_title?: string | null
  kind?: string | null
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
/* The working copy first, because it is the live one, and the published bundle
 * behind it. The comment that stood here promised that pair and the line under it
 * only ever asked for /work/, so a map whose painting never reached the store read
 * "no painting yet" with nothing behind it and no way to find out why. A published
 * map always carries its own painting in its bundle, so that is the second chance. */
const shot = (m: MapRow) => `/work/${m.slug}/scene.png`

const published = (m: MapRow): string | null =>
  m.published ? `/api/v1/maps/${encodeURIComponent(m.slug)}/file/${m.published}/scene.png` : null

/* Wired as onError rather than as a chain, because an <img> src has to be one
 * synchronous string. Once only: without the guard a missing bundle swaps the src
 * back and forth for ever and every swap is another request. */
const fallBack = (m: MapRow) => (e: { currentTarget: HTMLImageElement }) => {
  const next = published(m)
  if (!next || e.currentTarget.dataset.fell) return
  e.currentTarget.dataset.fell = '1'
  e.currentTarget.src = next
}

/* a map missing from the hand order sorts to the top, not the bottom: unplaced means newer than the order. */
const inOrder = (list: MapRow[], seq: string[]) => {
  if (!seq.length) return list
  const at = new Map(seq.map((s, i) => [s, i]))
  return [...list].sort((a, b) => (at.get(a.slug) ?? -1) - (at.get(b.slug) ?? -1))
}

/* nothing writes folders.sort after creation, so hand order lives here and an unplaced folder sorts last. */
const FORDER = 'mapvis:folder-order'
const readOrder = (): string[] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FORDER) || '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
const writeOrder = (ids: string[]) => {
  try {
    localStorage.setItem(FORDER, JSON.stringify(ids))
  } catch {
    // private browsing has no storage. The order is then whatever the server
    // sent, which is a worse answer and not a broken one.
  }
}
const inFolderOrder = (list: Folder[], seq: string[]) => {
  if (!seq.length) return list
  const at = new Map(seq.map((s, i) => [s, i]))
  return [...list].sort((a, b) => (at.get(a.id) ?? 1e9) - (at.get(b.id) ?? 1e9))
}

// which half of a tile the pointer is on decides which side of it the dragged
// thing lands, which is the only way a drop between two tiles can be aimed
// without a separate gap to hit
const half = (e: DragEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect()
  return e.clientX < r.left + r.width / 2
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
  const [fOrder, setFOrder] = useState<string[]>(readOrder)
  const [sel, setSel] = useState<string>('')
  const [picking, setPicking] = useState('')
  const [naming, setNaming] = useState(false)
  // the drag in progress. A map and a folder are different things to be holding
  // and only one of them can be in the hand, so they are separate: it is what
  // decides which targets light up and what a drop means when it lands.
  /* THE GAME'S OCEAN IS ONE ACCOUNT'S. It was shown to everybody signed in, and behind it row 1 was
     handed out to them as well, so a stranger's first session opened the chart on the hub and the ATC
     island. The flag is ownership now and not "are you signed in", and a request that does not answer
     leaves it OFF: not knowing is not a reason to offer somebody else's water. */
  const [sea, setSea] = useState(false)

  const [lift, setLift] = useState('')
  const [liftF, setLiftF] = useState('')
  const [overR, setOverR] = useState('')
  const [overF, setOverF] = useState('')
  const [overT, setOverT] = useState('')
  const [overM, setOverM] = useState('')

  const drop = () => {
    setLift('')
    setLiftF('')
    setOverR('')
    setOverF('')
    setOverT('')
    setOverM('')
  }

  const pull = () =>
    fetch('/api/folders')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { folders?: Folder[]; order?: string[] }) => {
        setFolders(j.folders || [])
        setOrder(j.order || [])
      })
      .catch(() => {})

  /* optimistic, and a failed write refetches everything rather than undoing one step of a dragged list. */
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
    /* a failed refetch leaves the screen alone: an empty list reads as no maps and shows first-run. */
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
    fetch('/api/world/mine')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { mine?: boolean; game?: boolean }) => setSea(j.game === true))
      .catch(() => setSea(false))
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

  // the folder goes, the maps in it do not. They are back on the top level the
  // moment this returns, which is why it does not ask twice the way deleting a
  // map does: there is nothing here to lose.
  const scrap = (id: string) => {
    setFolders((fs) => (fs || []).filter((f) => f.id !== id))
    if (sel === id) setSel('')
    void post('/api/folders/remove', { folder: id })
  }

  const found = useMemo(
    () => (maps || []).filter((m) => !q || (m.title + m.slug).toLowerCase().includes(q.toLowerCase())),
    [maps, q],
  )
  const ranked = useMemo(() => inFolderOrder(folders || [], fOrder), [folders, fOrder])
  const folder = ranked.find((f) => f.id === sel) || null
  // every slug that lives in at least one folder, so the top level can leave it
  // out. A map in two folders is filed once as far as this is concerned.
  const filed = useMemo(() => new Set((folders || []).flatMap((f) => f.maps)), [folders])

  const shown = useMemo(() => {
    if (folder) return inOrder(found.filter((m) => folder.maps.includes(m.slug)), folder.maps)
    // a search reaches into folders, because you typed a name and not a place,
    // and a map you cannot find because you filed it is the failure this page
    // exists to avoid
    if (q) return inOrder(found, order)
    return inOrder(found.filter((m) => !filed.has(m.slug)), order)
  }, [found, folder, filed, order, q])

  /* the lead map stays in the grid too, since pulling it out left it missing from its own list. */
  const lead = !q && !folder ? shown[0] : undefined

  // the tiles, at the top level only. Inside a folder there is nothing to show:
  // folders do not nest, so the grid there is maps and only maps.
  const tiles = folders && !q && !folder ? ranked : []

  /* reorder writes the whole visible sequence, so it is off while searching; a folder drop is one write. */
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

  // folders move among folders and nothing else, so this cannot produce a
  // sequence with a map in it and the folders-first rule holds by construction
  // rather than by being checked afterwards
  const moveFolder = (from: string, to: string, before: boolean) => {
    if (from === to) return
    const seq = ranked.map((f) => f.id)
    const i = seq.indexOf(from)
    if (i < 0) return
    seq.splice(i, 1)
    let j = seq.indexOf(to)
    if (j < 0) return
    if (!before) j++
    seq.splice(j, 0, from)
    setFOrder(seq)
    writeOrder(seq)
  }

  const org = (m: MapRow): Org | undefined =>
    folders
      ? {
          folders: ranked,
          mine: memberOf(m.slug),
          open: picking === m.slug,
          onOpen: (v: boolean) => setPicking(v ? m.slug : ''),
          onSet: (id, on) => setIn(m.slug, id, on),
          onNew: (name) => void make(name, m.slug),
          taking: !!lift,
          lifted: lift === m.slug,
          mark: overM === m.slug + ':b' ? 'before' : overM === m.slug + ':a' ? 'after' : '',
          onLift: () => setLift(m.slug),
          onHover: (before) => sortable && lift && lift !== m.slug && setOverM(m.slug + (before ? ':b' : ':a')),
          onLeave: () => setOverM((v) => (v.startsWith(m.slug + ':') ? '' : v)),
          onDrop: (before) => {
            if (lift) move(lift, m.slug, before)
            drop()
          },
          onDone: drop,
        }
      : undefined

  return (
    <div className="home">
      <header className="home-bar">
        <button className="home-mark" onClick={() => go('/')} aria-label="home">
            MAPVIS
          </button>
        <div className="home-bar-r">
          {/* a 30px mark, because two spelt-out links read as leftover text in a bar of icons */}
          {sea && (
            <Link to="/world" className="home-icon" aria-label="the ocean" title="the ocean">
              <Icon name="ocean" />
            </Link>
          )}
          {/* the engine's interface art; it was two links, /surfaces and /kit, neither guessable */}
          <Link to="/ui" className="home-icon" aria-label="generate the game's UI" title="generate the game's UI">
            <KitIcon />
          </Link>
          <input
            className="home-find"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="find a map"
            spellCheck={false}
          />
          {/* the empty way in, for deciding a folder exists before deciding what goes in it */}
          {folders && (
            <div className="bar-fold">
              <button
                className={'home-icon' + (naming ? ' on' : '')}
                aria-label="new folder"
                title="new folder"
                aria-expanded={naming}
                onClick={() => setNaming((v) => !v)}
              >
                <FolderIcon s={16} />
              </button>
              {naming && <NewFolder onMake={(n) => void make(n)} onClose={() => setNaming(false)} />}
            </div>
          )}
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
                  folders={ranked}
                  all={maps.length}
                  sel={sel}
                  onPick={setSel}
                  onNew={(name) => void make(name)}
                  onRename={rename}
                  onScrap={scrap}
                  lift={lift}
                  over={overR}
                  onOver={setOverR}
                  onDrop={(id) => {
                    if (lift) setIn(lift, id, true)
                    drop()
                  }}
                />
              )}
              <div>
                {folder && (
                  <div className="fold-head">
                    <button className="fold-back" onClick={() => setSel('')}>
                      &larr; all maps
                    </button>
                    <h2>{folder.name}</h2>
                    <span>{folder.maps.length === 1 ? '1 map' : folder.maps.length + ' maps'}</span>
                  </div>
                )}
                <div className="grid">
                  {/* only a paint order: neither kind takes the other as a neighbour */}
                  {!folder && (
                    <button className="card new" onClick={() => go('/edit')}>
                      <span className="new-plus" aria-hidden>
                        +
                      </span>
                      <span className="new-say">new map</span>
                      <span className="new-sub">start from a painting</span>
                    </button>
                  )}
                  {tiles.map((f) => (
                    <FolderTile
                      key={f.id}
                      f={f}
                      over={overF === f.id}
                      mark={overT === f.id + ':b' ? 'before' : overT === f.id + ':a' ? 'after' : ''}
                      lifted={liftF === f.id}
                      taking={!!lift}
                      holding={!!liftF && liftF !== f.id}
                      onOpen={() => setSel(f.id)}
                      onRename={(n) => rename(f.id, n)}
                      onScrap={() => scrap(f.id)}
                      onLift={() => setLiftF(f.id)}
                      onOver={() => setOverF(f.id)}
                      onHover={(before) => setOverT(f.id + (before ? ':b' : ':a'))}
                      onLeave={() => {
                        setOverF((v) => (v === f.id ? '' : v))
                        setOverT((v) => (v.startsWith(f.id + ':') ? '' : v))
                      }}
                      onDropMap={() => {
                        if (lift) setIn(lift, f.id, true)
                        drop()
                      }}
                      onDropFolder={(before) => {
                        if (liftF) moveFolder(liftF, f.id, before)
                        drop()
                      }}
                      onDone={drop}
                    />
                  ))}
                  {shown.map((m) => (
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

/* the newest map at full width, and the first tile in the grid below: the same map twice on purpose. */
function Lead({ m, onDelete }: { m: MapRow; onDelete: () => void }) {
  return (
    <div className="lead">
      <a className="lead-hit" href={`/edit?id=${encodeURIComponent(m.slug)}`} aria-label={`edit ${m.slug}`} />
      {/* above the full-bleed hit area, or the link swallows the click */}
      <button className="card-bin lead-bin" title={`delete ${m.slug}`} aria-label={`delete ${m.slug}`} onClick={onDelete}>
        <Trash />
      </button>
      <img src={shot(m) as string} alt="" onError={fallBack(m)} />
      <div className="lead-say">
        <span className="lead-when">last opened {when(m.updated_at)}</span>
        <h1>{displayName({ name: m.slug, title: m.title }).text}</h1>
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
  taking: boolean
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
  return (
    <article
      className={'card' + (org?.mark ? ' drop-' + org.mark : '') + (org?.lifted ? ' lifted' : '')}
      /* not while the picker is open: a draggable ancestor swallows the mouse
         down that would otherwise be a caret landing in the name field */
      draggable={!!org && !org.open}
      onDragStart={(e) => {
        if (!org) return
        e.dataTransfer.effectAllowed = 'move'
        // a payload as well as the component's own state, because a drag carrying
        // nothing is one some browsers refuse to start
        e.dataTransfer.setData('text/plain', m.slug)
        org.onLift()
      }}
      onDragEnd={() => org?.onDone()}
      /* only a map lands between two maps. A folder in the hand is refused here
         by never calling preventDefault, which is the same mechanism that keeps
         a file dragged in off the desktop from looking droppable. */
      onDragOver={(e) => {
        if (!org?.taking) return
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
        if (!org?.taking) return
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
          <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={fallBack(m)} />
        ) : (
          <span className="card-none">no painting yet</span>
        )}
      </a>
      <div className="card-say">
        <div className="card-top">
          <h2>{displayName({ name: m.slug, title: m.title }).text}</h2>
          <span className="card-when">{when(m.updated_at)}</span>
        </div>
        <div className="card-nums">
          <span>
            {m.w}&times;{m.h}
          </span>
          <span>{m.placements} placed</span>
          <span className={m.anchors ? 'lit' : ''}>{m.anchors} named</span>
          {m.published != null ? <span className="lit">v{m.published}</span> : null}
          {/* the hand, only when there was one: a map drawn as typed says
              nothing rather than saying "none", which would read as missing */}
          {m.style ? <span className="card-hand">{m.style_title || m.style}</span> : null}
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

/* a folder tile takes a map into it and a folder beside it, never a map as a neighbour. */
function FolderTile({
  f,
  over,
  mark,
  lifted,
  taking,
  holding,
  onOpen,
  onRename,
  onScrap,
  onLift,
  onOver,
  onHover,
  onLeave,
  onDropMap,
  onDropFolder,
  onDone,
}: {
  f: Folder
  over: boolean
  mark: '' | 'before' | 'after'
  lifted: boolean
  taking: boolean
  holding: boolean
  onOpen: () => void
  onRename: (name: string) => void
  onScrap: () => void
  onLift: () => void
  onOver: () => void
  onHover: (before: boolean) => void
  onLeave: () => void
  onDropMap: () => void
  onDropFolder: (before: boolean) => void
  onDone: () => void
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
    <article
      className={'card fold' + (over ? ' over' : '') + (mark ? ' drop-' + mark : '') + (lifted ? ' lifted' : '')}
      // a draggable ancestor swallows the mouse down that would put a caret in
      // the name field, the same reason a card stops being draggable while its
      // picker is open
      draggable={!edit}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', f.name)
        onLift()
      }}
      onDragEnd={onDone}
      onDragOver={(e) => {
        if (!taking && !holding) return
        e.preventDefault()
        /* dropEffect must be 'move': (move, copy) is no drag operation and drop never fires. */
        e.dataTransfer.dropEffect = 'move'
        if (taking) onOver()
        else onHover(half(e))
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        onLeave()
      }}
      onDrop={(e) => {
        if (!taking && !holding) return
        e.preventDefault()
        if (taking) onDropMap()
        else onDropFolder(half(e))
      }}
    >
      {sure ? (
        <span className="fold-sure">
          <button onClick={onScrap}>remove</button>
          <button onClick={() => setSure(false)}>keep</button>
        </span>
      ) : (
        <button
          className="card-bin"
          title={`remove the folder ${f.name}`}
          aria-label={`remove the folder ${f.name}`}
          onClick={() => setSure(true)}
        >
          <Trash />
        </button>
      )}
      <button className="fold-face" onClick={onOpen} aria-label={`open ${f.name}`}>
        <FolderBig />
      </button>
      <div className="card-say">
        <div className="card-top">
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
            <h2 onDoubleClick={() => setEdit(true)} title="double click to rename">
              {f.name}
            </h2>
          )}
          <span className="card-when">{f.maps.length === 1 ? '1 map' : f.maps.length + ' maps'}</span>
        </div>
        <div className="card-do">
          <button className="fold-in" onClick={onOpen}>
            open
          </button>
        </div>
      </div>
    </article>
  )
}

/* checkboxes and not a dropdown, since a map can be in several folders and only leaves one here. */
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

/* no blur-to-save here, unlike the rail: blur fires on the way to the create button and saves twice. */
function NewFolder({ onMake, onClose }: { onMake: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState('')

  useEffect(() => {
    const off = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.('.bar-fold')) onClose()
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
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
    onMake(name)
    setName('')
    onClose()
  }

  return (
    <div className="fold-new" role="group" aria-label="new folder">
      <input
        className="fold-in-name"
        autoFocus
        value={name}
        spellCheck={false}
        placeholder="folder name"
        maxLength={48}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add()
          if (e.key === 'Escape') onClose()
        }}
      />
      <button className="fold-make" onClick={add} disabled={!name.trim()}>
        create
      </button>
    </div>
  )
}

/* the rail is where you are, the tiles where you go, and each row takes a drop without scrolling up. */
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
        /* 'move' and not 'copy': against effectAllowed 'move' a copy is no drag operation at all, and drop never fires. */
        e.dataTransfer.dropEffect = 'move'
        onOver()
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        onOut()
      }}
      onDrop={(e) => {
        if (!taking) return
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

/* THE UI GENERATOR: pieces of three different shapes on one shelf, because the
 * page makes panels, sheets of faces and bands, not one kind of thing. Stroked
 * rather than filled, to sit beside the ocean mark. */
function KitIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2.2" y="2.8" width="5.4" height="4.4" rx="0.8" />
      <rect x="9.2" y="2.8" width="4.6" height="4.4" rx="0.8" />
      <rect x="2.2" y="9.2" width="11.6" height="3.8" rx="0.8" />
    </svg>
  )
}

function FolderIcon({ s = 13 }: { s?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={s} height={s} shapeRendering="crispEdges" aria-hidden>
      <path fill="currentColor" d="M1 3h6v1H1zM1 4h14v1H1zM1 5h1v8H1zM14 5h1v8h-1zM2 13h13v1H2z" />
    </svg>
  )
}

/* filled, not outlined: an outline this big reads as a rectangle with a step in it. two flat tones. */
function FolderBig() {
  return (
    <svg viewBox="0 0 30 22" width="86" height="63" shapeRendering="crispEdges" aria-hidden>
      <path fill="currentColor" opacity="0.4" d="M0 0h12v2H0zM0 2h30v4H0z" />
      <path fill="currentColor" d="M0 6h30v16H0z" />
    </svg>
  )
}

/* a map was once destroyed by a test aimed at a real slug, so deleting asks which map, then who you are. */
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

  /* portalled to body, because a transformed ancestor is the containing block for position:fixed. */
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
