/* The shell: which page is on screen, and how one becomes the next.
 *
 * The editor is 5,700 lines and a WebGL-adjacent canvas app, so it is lazy and
 * it is the only route that gets the old stylesheet. Everything else is the
 * site. That split is deliberate: the tool and the platform are different
 * pieces of software that happen to share a domain.
 */
import { Component, Suspense, lazy, useEffect, type ReactNode } from 'react'
import { useRoute, match, useScrollReset } from './router'
import { useScrollProgress, installGrain } from './motion'
import { useSession } from './session'
import Landing from './Landing'

const Editor = lazy(() => import('../App'))
const Enter = lazy(() => import('./Enter'))
const Home = lazy(() => import('./Home'))
const MapPage = lazy(() => import('./MapPage'))

/* Ink spreading into paper. Every wait in this app is this, never a spinner,
 * because a spinner is the single most template-shaped thing a page can do. */
export function Ink({ what = 'loading' }: { what?: string }) {
  return (
    <div className="inkwait" role="status" aria-live="polite">
      <div className="inkblot" aria-hidden />
      <span className="label">{what}</span>
    </div>
  )
}

/* ONE BROKEN PANEL MUST NOT TAKE THE PAGE WITH IT.
 *
 * React unmounts the entire tree on an uncaught render error, so a bug in the
 * walk preview white-screened the whole app, navigation included. That is the
 * worst possible failure: nothing on screen and nothing to click.
 *
 * With a boundary, the broken thing says so and everything around it keeps
 * working, which also means a stack trace instead of a blank page. */
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

  // the editor owns the whole viewport and locks scrolling; the site does not
  const editing = route.path === '/edit'
  useEffect(() => {
    document.body.style.overflow = editing ? 'hidden' : ''
    document.body.dataset.view = editing ? 'editor' : 'site'
  }, [editing])

  if (editing) {
    return (
      <Suspense fallback={<Ink what="opening the map" />}>
        <Editor />
      </Suspense>
    )
  }

  const mapMatch = match('/maps/:slug', route.path)

  /* ONE ADDRESS, TWO DIFFERENT SCREENS.
   *
   * Signed out, / is the landing: a place, a camera, and a reason to make an
   * account. Signed in, / is your work. Nobody who already has maps should ever
   * be shown an advertisement for the thing they are already using, and nobody
   * should have to know a second url to get to their own stuff. */
  let page: React.ReactNode = null
  if (route.path === '/') page = session.loading ? <Ink /> : session.user ? <Home /> : <Landing />
  else if (route.path === '/enter') page = <Enter />
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
