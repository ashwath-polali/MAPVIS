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

/* A DEPLOY IS NOT A BROKEN PANEL, AND IT USED TO LOOK LIKE ONE.
 *
 * Every route below is its own chunk with its hash in the filename, and a deploy
 * replaces all of them. A tab that was already open still holds the previous
 * index.html, so the moment it navigates it asks for a chunk that no longer
 * exists, the dynamic import rejects, and the boundary catches it and renders an
 * error page carrying whatever the old build said. From the outside that is "I
 * clicked sign in and got an error with old UI in it", and it happens only to a
 * tab left open across a deploy, which is why it is rare.
 *
 * A missing chunk cannot be recovered in place and does not need to be: the fix
 * is the newest index.html, one reload away. Guarded by a session flag so a
 * genuinely missing file cannot put the tab in a reload loop; a second failure
 * falls through to the boundary and shows the real error. */
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

  /* THE TWO TOOLS OWN THE WHOLE VIEWPORT AND LOCK SCROLLING; the site does not.
   *
   * The map editor and the UI generator are one piece of software wearing one
   * set of chrome, so they take the same body flag and therefore the same
   * stylesheet. That is not a shortcut: /ui was drawn twice as a landing page
   * with its own hero and its own greys, and the only reliable cure for a second
   * page inventing a second look is for it to have no stylesheet of its own to
   * invent one in. */
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

  /* Outside the page-in wrapper, because .app is height:100% and a wrapper with
   * automatic height collapses it. Inside a boundary, because this one is not
   * the canvas app and a broken panel here should say so rather than white out
   * the tab. */
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

  /* ONE ADDRESS, TWO DIFFERENT SCREENS.
   *
   * Signed out, / is the landing: a place, a camera, and a reason to make an
   * account. Signed in, / is your work. Nobody who already has maps should ever
   * be shown an advertisement for the thing they are already using, and nobody
   * should have to know a second url to get to their own stuff. */
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
