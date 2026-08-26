/* One map: walk it, read the code that reaches it, scrub its history, share it.
 *
 * The code view is the piece that matters most in the whole platform. It takes
 * the anchors somebody typed and shows the actual python a club member would
 * write against them. That turns "the map connects to the API" from a claim in
 * a document into something you can look at, and it is the one screen that
 * explains vine-and-grape to somebody who has never heard of it.
 */
import { useEffect, useState } from 'react'
import { Link } from './router'
import { Compass, Foot } from './Chrome'
import { Ink } from './Shell'
import { Walk } from './Walk'
import { useSession } from './session'

type Anchor = { name: string; kind: string; to?: string; toAnchor?: string; label?: string; derived?: boolean }
type Version = { version: number; bytes: number; published_at: string }
type Manifest = {
  slug: string
  version: number
  publishedAt: string
  map: { w: number; h: number; anchors?: Anchor[]; stairs?: unknown[] }
  files: Record<string, { bytes: number; url: string }>
}

export default function MapPage({ slug }: { slug: string }) {
  const { user } = useSession()
  const [man, setMan] = useState<Manifest | null>(null)
  const [versions, setVersions] = useState<Version[]>([])
  const [anchors, setAnchors] = useState<Anchor[] | null>(null)
  const [showing, setShowing] = useState<number | null>(null)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    setGone(false)
    fetch(`/api/v1/maps/${slug}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('unpublished'))))
      .then((j) => {
        setMan(j)
        setShowing(j.version)
      })
      .catch(() => setGone(true))
    fetch(`/api/v1/maps/${slug}/versions`)
      .then((r) => r.json())
      .then((j) => setVersions(j.versions || []))
      .catch(() => {})
    fetch(`/api/v1/maps/${slug}/anchors`)
      .then((r) => (r.ok ? r.json() : { anchors: [] }))
      .then((j) => setAnchors(j.anchors || []))
      .catch(() => setAnchors([]))
  }, [slug])

  if (gone) return <Unpublished slug={slug} />
  if (!man) return <Ink what={`finding ${slug}`} />

  const bytes = Object.values(man.files).reduce((a, f) => a + f.bytes, 0)

  return (
    <div className="site grain">
      <Compass />
      <div className="wrap sec mapsec">
        <header className="map-head">
          <div>
            <div className="label tick">a published chart</div>
            <h1 className="d2">{slug}</h1>
            <div className="map-meta mono">
              {man.map.w}×{man.map.h} · v{man.version} · {(bytes / 1024 / 1024).toFixed(2)} MB ·{' '}
              {Object.keys(man.files).length} files
            </div>
          </div>
          <div className="map-acts">
            <Share slug={slug} />
            {user ? (
              <a href={`/edit?id=${encodeURIComponent(slug)}`} className="plate">
                open in the tool
              </a>
            ) : null}
          </div>
        </header>
        <hr className="hair" />

        <Walk slug={slug} version={showing ?? man.version} />

        <div className="map-cols">
          <Anchors anchors={anchors} />
          <CodeView slug={slug} anchors={anchors} />
        </div>

        <Filmstrip slug={slug} versions={versions} showing={showing} onPick={setShowing} live={man.version} />
      </div>
      <Foot />
    </div>
  )
}

/* Every named place, and whether anybody actually chose the name. A derived one
 * came from an old door's label rather than an author, and code written against
 * it is code written against a guess. */
function Anchors({ anchors }: { anchors: Anchor[] | null }) {
  return (
    <section className="anchbox">
      <div className="label tick">what code can reach</div>
      {!anchors ? (
        <Ink what="reading names" />
      ) : anchors.length === 0 ? (
        <p className="aside">
          Nothing here is named yet, so there is nothing for python to address. Open it in the tool and
          name a door.
        </p>
      ) : (
        <ul className="anchlist">
          {anchors.map((a) => (
            <li key={a.name}>
              <span className={'anchname mono' + (a.derived ? ' guessed' : '')}>{a.name}</span>
              <span className="anchkind label">{a.kind}</span>
              {a.to ? (
                <span className="anchto mono">
                  → {a.to}
                  {a.toAnchor ? `·${a.toAnchor}` : ''}
                </span>
              ) : null}
              {a.derived ? <span className="anchwarn2 label">guessed</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* THE CODE VIEW. Generated from the real anchors, so it is never out of date
 * and never aspirational. If a name changes here, this changes. */
function CodeView({ slug, anchors }: { slug: string; anchors: Anchor[] | null }) {
  const [copied, setCopied] = useState(false)
  if (!anchors) return <section className="codebox" />

  const cls = slug.replace(/[^a-z0-9]+/gi, ' ').replace(/(^|\s)\w/g, (m) => m.toUpperCase()).replace(/\s+/g, '')
  const doors = anchors.filter((a) => a.kind === 'door')
  const posts = anchors.filter((a) => a.kind === 'post')
  const points = anchors.filter((a) => a.kind === 'point' || a.kind === 'trigger')

  const lines = [
    `from vine import Island, on_enter, on_talk`,
    ``,
    ``,
    `class ${cls || 'MyIsland'}(Island):`,
    `    map = ${JSON.stringify(slug)}`,
    ``,
  ]
  if (points.length || doors.length) {
    lines.push(
      `    @on_enter`,
      `    def arrive(self):`,
      `        yield self.say("Thor", "So this is ${slug}.")`,
      `        yield self.guide_to(${JSON.stringify((points[0] || doors[0]).name)})`,
      ``,
    )
  }
  for (const p of posts.slice(0, 2)) {
    lines.push(
      `    @on_talk(${JSON.stringify(p.name)})`,
      `    def ${p.name}(self):`,
      `        yield self.say(${JSON.stringify(p.label || p.name)}, "Not much doing today.")`,
      ``,
    )
  }
  for (const d of doors.slice(0, 1)) {
    lines.push(
      `    @on_enter(${JSON.stringify(d.name)})`,
      `    def ${d.name}(self):`,
      `        yield self.travel(${JSON.stringify(d.to || '')}${d.toAnchor ? `, arrive=${JSON.stringify(d.toAnchor)}` : ''})`,
      ``,
    )
  }
  const code = lines.join('\n').replace(/\n{3,}$/, '\n')

  return (
    <section className="codebox">
      <div className="codebox-head">
        <div className="label tick">what a member writes</div>
        <button
          className="ul asbtn label"
          onClick={() => {
            void navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="codelet mono big">{colour(code)}</pre>
      <p className="aside codebox-note">
        Written from this map&rsquo;s real names. Nobody types an x and a y, so moving the thing later
        does not break the island built on it.
      </p>
    </section>
  )
}

/* A very small python colouriser. Enough to read, not enough to pretend to be
 * an editor: the code view is a document, not a workspace. */
function colour(src: string) {
  return src.split('\n').map((line, i) => {
    const m = line.match(/^(\s*)(#.*)$/)
    if (m)
      return (
        <span key={i}>
          {m[1]}
          <span className="c-dim">{m[2]}</span>
          {'\n'}
        </span>
      )
    const parts = line.split(/("(?:[^"\\]|\\.)*")/g)
    return (
      <span key={i}>
        {parts.map((p, j) =>
          p.startsWith('"') ? (
            <span key={j} className="c-str">
              {p}
            </span>
          ) : (
            <span key={j}>
              {p.split(/\b(class|def|yield|from|import|self)\b/g).map((w, k) =>
                ['class', 'def', 'yield', 'from', 'import', 'self'].includes(w) ? (
                  <span key={k} className="c-key">
                    {w}
                  </span>
                ) : (
                  <span key={k}>{w}</span>
                ),
              )}
            </span>
          ),
        )}
        {'\n'}
      </span>
    )
  })
}

/* Every version, as a strip you can scrub. Because a publish is immutable, an
 * old one is still standing and still playable, which is what makes this more
 * than a changelog. */
function Filmstrip({
  slug,
  versions,
  showing,
  onPick,
  live,
}: {
  slug: string
  versions: Version[]
  showing: number | null
  onPick: (v: number) => void
  live: number
}) {
  if (versions.length === 0) return null
  return (
    <section className="strip">
      <div className="label tick">every version is still standing</div>
      <div className="strip-rail">
        {versions.map((v) => (
          <button
            key={v.version}
            className={'strip-cell' + (showing === v.version ? ' on' : '')}
            onClick={() => onPick(v.version)}
          >
            <img src={`/api/v1/maps/${slug}/file/${v.version}/scene.png`} alt="" loading="lazy" />
            <span className="mono">v{v.version}</span>
            {v.version === live ? <span className="pip live">live</span> : null}
          </button>
        ))}
      </div>
      <p className="aside">
        Publishing again never rewrites what is already out there, so a class halfway through a session
        keeps the map it started on.
      </p>
    </section>
  )
}

function Share({ slug }: { slug: string }) {
  const [said, setSaid] = useState(false)
  return (
    <button
      className="plate quiet"
      onClick={() => {
        void navigator.clipboard.writeText(`${location.origin}/maps/${slug}`)
        setSaid(true)
        setTimeout(() => setSaid(false), 1600)
      }}
    >
      {said ? 'link copied' : 'share'}
    </button>
  )
}

function Unpublished({ slug }: { slug: string }) {
  return (
    <div className="site grain">
      <Compass />
      <div className="wrap lost">
        <div className="label tick">drawn, but not printed</div>
        <h1 className="d2">{slug} has never been published.</h1>
        <p className="lede">
          It may exist in somebody&rsquo;s tool, half cut, with the sea still on it. Nothing is public
          until an export puts a version out.
        </p>
        <Link to="/atlas" className="plate">
          see what is published
        </Link>
      </div>
      <Foot />
    </div>
  )
}
