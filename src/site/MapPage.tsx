/* Walking a published map.
 *
 * This was a long page with a code sample, a version filmstrip, an anchor list
 * and a share button, dressed in a design that got rejected. Almost all of it
 * was explaining rather than doing.
 *
 * What is left is the thing: the map, standing up, playable, filling the
 * screen. Everything else is one bar of small type that gets out of the way.
 */
import { useEffect, useState } from 'react'
import { go } from './router'
import { displayName } from '../core/naming'
import { Walk } from './Walk'

type Manifest = { slug: string; version: number; map: { w: number; h: number } }

export default function MapPage({ slug }: { slug: string }) {
  const [man, setMan] = useState<Manifest | null>(null)
  const [gone, setGone] = useState(false)

  const [why, setWhy] = useState('')

  useEffect(() => {
    fetch(`/api/v1/maps/${slug}`)
      .then(async (r) => {
        if (r.ok) return r.json()
        // 503 means it IS published and storage would not answer, which is a
        // completely different thing to say to somebody than "not exported"
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || (r.status === 503 ? 'storage is not answering' : 'unpublished'))
      })
      .then(setMan)
      .catch((e) => {
        setWhy(String((e as Error).message))
        setGone(true)
      })
  }, [slug])

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && go('/')
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  if (gone)
    return (
      <div className="playing">
        <div className="play-empty">
          <h1>{displayName(slug).text} will not open.</h1>
          <p>{why || 'Open it in the editor and export it, then it can be walked.'}</p>
          <button className="sheet-btn" onClick={() => go('/')}>
            Back
          </button>
        </div>
      </div>
    )

  return (
    <div className="playing">
      <div className="play-bar">
        <button className="play-back" onClick={() => go('/')}>
          ← back
        </button>
        {/* the slug is the address in the url and in every link on this page; it is
            not the map's name, and this bar was printing it as though it were */}
        <span className="play-name" title={slug}>
          {displayName(slug).text}
        </span>
        {man && (
          <span className="play-meta">
            {man.map.w}&times;{man.map.h} · v{man.version}
          </span>
        )}
        <a className="play-edit" href={`/edit?id=${encodeURIComponent(slug)}`}>
          edit
        </a>
      </div>
      {man && <Walk slug={slug} version={man.version} />}
    </div>
  )
}
