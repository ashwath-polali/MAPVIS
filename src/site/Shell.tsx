/* The shell: which page is on screen and how one becomes the next. The editor is lazy and is the only route on the old stylesheet, because the tool and the platform are different software sharing a domain. */
import { Component, Suspense, lazy, useEffect, type ReactNode } from 'react'
import { useRoute, match, useScrollReset } from './router'
import { useScrollProgress, installGrain } from './motion'
import { useSession } from './session'
import Landing from './Landing'

/* A DEPLOY IS NOT A BROKEN PANEL, and without this it looks like one: a tab left open across a deploy still holds the previous index.html, asks for a chunk that no longer exists, and the boundary renders an error page in that build's UI. */
const RELOADED = 'mapvis:stale-chunk-reloaded'
const STALE = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i

function fresh<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().then(
      (m) => {
        try {
          sessionStorage.removeItem(RELOADED)
        } catch {
          /* private mode; nothing here is worth failing a route over */
        }
        return m
      },
      (e: unknown) => {
        let already = true
        try {
          already = sessionStorage.getItem(RELOADED) === '1'
          if (!already) sessionStorage.setItem(RELOADED, '1')
        } catch {
          /* no storage means no loop guard, so do not reload at all */
        }
        if (!already && STALE.test(String((e as Error)?.message || e))) {
          window.location.reload()
          // the reload owns the page from here; resolving would render into a
          // document that is on its way out
          return new Promise<T>(() => {})
        }
        throw e
      },
    )
}

const Editor = lazy(fresh(() => import('../App')))
const Enter = lazy(fresh(() => import('./Enter')))
const Home = lazy(fresh(() => import('./Home')))
const MapPage = lazy(fresh(() => import('./MapPage')))
const World = lazy(fresh(() => import('./World')))
const Ui = lazy(fresh(() => import('./Ui')))

/* One loading mark for the whole app: four squares walking a ring on the pixel
 * grid. The bleeding ink blot it replaced was slow, soft and the wrong shape for
 * a tool made of hard pixels. */
export function Ink({ what = '' }: { what?: string }) {
  return (
    <div className="inkwait" role="status" aria-live="polite">
      <div className="pixload" aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </div>
      {what ? <span>{what}</span> : null}
    </div>
  )
}

/* ONE BROKEN PANEL MUST NOT TAKE THE PAGE WITH IT. React unmounts the whole tree on an uncaught render error, so a bug in the walk preview white-screened the app, navigation included. */
class Boundary extends Component<{ children: ReactNode; what: string }, { err: Error | null }> {
  state: { err: Error | null } = { err: null }
  static getDerivedStateFromError(err: Error) {
    return { err }
  }
  componentDidCatch(err: Error) {
    console.error('[mapvis] a panel failed:', err)
  }
  render() {
    if (!this.state.err) return this.props.children
    return (
      <div className="broke">
        <div className="label tick">{this.props.what} could not be drawn</div>
        <p className="aside">{String(this.state.err.message || this.state.err)}</p>
        <button className="ul asbtn label" onClick={() => this.setState({ err: null })}>
          try again
        </button>
      </div>
    )
  }
}

export default function Shell() {
  const route = useRoute()
  const session = useSession()
  useScrollProgress()
  useScrollReset(route.path)

  useEffect(() => {
    installGrain()
  }, [])

  /* THE TWO TOOLS OWN THE WHOLE VIEWPORT AND LOCK SCROLLING; the site does not. One stylesheet for both, because /ui was drawn twice as a landing page and the only cure for a second page inventing a second look is having no stylesheet to invent one in. */
  const editing = route.path === '/edit'
  const making = route.path === '/ui'
  const tool = editing || making
  useEffect(() => {
    document.body.style.overflow = tool ? 'hidden' : ''
    document.body.dataset.view = tool ? 'editor' : 'site'
  }, [tool])

  if (editing) {
    return (
      <Suspense fallback={<Ink what="opening the map" />}>
        <Editor />
      </Suspense>
    )
  }

  /* Outside the page-in wrapper, because .app is height:100% and an automatic-height wrapper collapses it. Inside a boundary, because a broken panel here should say so rather than white out the tab. */
  if (making) {
    return (
      <Boundary what="the ui generator">
        <Suspense fallback={<Ink what="opening the ui generator" />}>
          <Ui />
        </Suspense>
      </Boundary>
    )
  }

  const mapMatch = match('/maps/:slug', route.path)

  /* ONE ADDRESS, TWO SCREENS: signed out / is the landing, signed in / is your work. Nobody with maps should be shown an advertisement for the thing they already use. */
  let page: React.ReactNode = null
  if (route.path === '/') page = session.loading ? <Ink /> : session.user ? <Home /> : <Landing />
  else if (route.path === '/enter') page = <Enter />
  // the one page that is not about a single map: where every map sits on the
  // one ocean, which is a document the platform holds exactly one of
  else if (route.path === '/world') page = <World />
  else if (mapMatch) page = <MapPage slug={mapMatch.slug} />
  else page = <Lost path={route.path} />

  return (
    <Boundary what={route.path === '/' ? 'this page' : route.path}>
      <Suspense fallback={<Ink />}>
        {/* keyed on the path so the arrival animation replays per page */}
        <div key={route.path} className="page-in">
          {page}
        </div>
      </Suspense>
    </Boundary>
  )
}

/* Not a 404 with a sad face. A place that is not on the chart. */
function Lost({ path }: { path: string }) {
  return (
    <div className="site grain">
      <div className="wrap lost">
        <div className="label tick">uncharted</div>
        <h1 className="d1">Here be nothing.</h1>
        <p className="lede">
          Nothing is drawn at <span className="mono">{path}</span>. Either it was never surveyed, or it
          has sunk since the last printing.
        </p>
        <a href="/" className="plate">
          back to open water
        </a>
      </div>
    </div>
  )
}
