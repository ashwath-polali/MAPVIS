/* The furniture every page carries. The compass needle points to how far down the page you are and is the only scroll indicator. */
import { Link, go } from './router'
import { useSession, signOut } from './session'

export function Compass({ dark = true }: { dark?: boolean }) {
  const { user } = useSession()
  return (
    <header className={'compass' + (dark ? '' : ' on-paper')}>
      <Link to="/" className="mark" aria-label="MAPVIS, home">
        {/* the needle rotates with --scroll, written by useScrollProgress */}
        <svg viewBox="0 0 40 40" width="34" height="34" aria-hidden>
          <circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" strokeOpacity=".35" />
          <circle cx="20" cy="20" r="13.5" fill="none" stroke="currentColor" strokeOpacity=".18" />
          {[0, 90, 180, 270].map((a) => (
            <line
              key={a}
              x1="20"
              y1="2.5"
              x2="20"
              y2="7"
              stroke="currentColor"
              strokeOpacity=".5"
              transform={`rotate(${a} 20 20)`}
            />
          ))}
          <g className="needle">
            <path d="M20 6 L23 20 L20 34 L17 20 Z" fill="currentColor" opacity=".9" />
          </g>
          <circle cx="20" cy="20" r="1.6" fill="var(--gold-lit)" />
        </svg>
        <span className="wordmark">MAPVIS</span>
      </Link>

      <nav className="ways">
        <Link to="/atlas" className="ul">
          atlas
        </Link>
        {user ? (
          <>
            <Link to="/maps" className="ul">
              my maps
            </Link>
            <Link to="/account" className="ul">
              account
            </Link>
            <button
              className="ul asbtn"
              onClick={() => {
                void signOut().then(() => go('/'))
              }}
            >
              sign out
            </button>
          </>
        ) : (
          <>
            <Link to="/enter" className="ul">
              sign in
            </Link>
            <Link to="/enter?new=1" className="plate small">
              start a chart
            </Link>
          </>
        )}
      </nav>
    </header>
  )
}

export function Foot() {
  return (
    <footer className="foot">
      <hr className="hair" />
      <div className="foot-in">
        <div>
          <p className="aside" style={{ maxWidth: '34ch', margin: 0 }}>
            Built for the Algorithmic Thinking Club at Bonney Lake High School, so that a map somebody
            painted can become a place somebody else can walk.
          </p>
        </div>
        <div className="foot-cols">
          <div>
            <div className="label">the tool</div>
            <Link to="/atlas" className="ul">
              atlas
            </Link>
            <Link to="/maps" className="ul">
              my maps
            </Link>
          </div>
          <div>
            <div className="label">for code</div>
            <a className="ul" href="/api/v1/maps">
              the read api
            </a>
            <a className="ul" href="https://github.com/ashwath-polali/MAPVIS-next">
              source
            </a>
          </div>
        </div>
      </div>
      <div className="foot-rule mono">
        <span>MAPVIS</span>
        <span>every map is one painting</span>
      </div>
    </footer>
  )
}
