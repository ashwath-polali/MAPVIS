/* THE LANDING PAGE IS A CHART YOU TRAVEL ACROSS.
 *
 * Not a page with maps on it. You arrive on open water at dusk, and scrolling
 * is the voyage: territory resolves out of the fog, each realm demonstrates one
 * thing the tool does, and the compass needle in the corner is your position.
 *
 * The realms are painted by PixelLab and are the only art on the page. Every
 * frame here is a placeholder until Ash approves the composition, which is why
 * Plate draws a labelled void rather than a grey box: an empty rectangle tells
 * you nothing about whether the layout works, and a labelled one tells you
 * exactly what is going to be standing there.
 */
import { useEffect, useState } from 'react'
import { Link } from './router'
import { useReveal, usePointer, useTyped } from './motion'
import { Compass, Foot } from './Chrome'
import { useSession } from './session'

/* One painted realm. Three layers deep so the pointer moves them apart:
 * the sky sits still, the land leads, the foreground overshoots. */
function Realm({
  name,
  note,
  tone,
  depth = 1,
}: {
  name: string
  note: string
  tone: string
  depth?: number
}) {
  return (
    <figure className="realm" style={{ ['--tone' as string]: tone }}>
      <div className="realm-frame">
        <div className="realm-sky par" style={{ ['--par' as string]: `${5 * depth}px` }} />
        <div className="realm-land par" style={{ ['--par' as string]: `${14 * depth}px` }}>
          {/* PLACEHOLDER. A PixelLab painting of this realm goes here. */}
          <span className="realm-await mono">painting: {name.toLowerCase().replace(/\s+/g, '-')}</span>
        </div>
        <div className="realm-fog par" style={{ ['--par' as string]: `${26 * depth}px` }} />
        <div className="realm-grid" aria-hidden />
      </div>
      <figcaption>
        <span className="label">{name}</span>
        <span className="aside">{note}</span>
      </figcaption>
    </figure>
  )
}

/* A section of the voyage. Odd ones sit left, even ones right, and nothing is
 * ever centred, because a centre column with a picture above the text is the
 * loudest tell there is. */
function Leg({
  n,
  eyebrow,
  title,
  body,
  realm,
  flip,
  children,
}: {
  n: string
  eyebrow: string
  title: string
  body: string
  realm: React.ReactNode
  flip?: boolean
  children?: React.ReactNode
}) {
  const ref = useReveal<HTMLElement>()
  return (
    <section className={'leg sec' + (flip ? ' flip' : '')} ref={ref}>
      <div className="wrap field">
        <div className="leg-art">{realm}</div>
        <div className="leg-say">
          <div className="leg-n mono">{n}</div>
          <div className="tick label rise" style={{ ['--i' as string]: 0 }}>
            {eyebrow}
          </div>
          <h2 className="d2 rise" style={{ ['--i' as string]: 1 }}>
            {title}
          </h2>
          <p className="lede rise" style={{ ['--i' as string]: 2 }}>
            {body}
          </p>
          {children ? (
            <div className="rise" style={{ ['--i' as string]: 3 }}>
              {children}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

export default function Landing() {
  const hero = usePointer<HTMLDivElement>(1)
  const [lit, setLit] = useState(false)
  const typed = useTyped('you paint it. it becomes a place.', lit, 28)
  const { user } = useSession()

  // hold the hero back for a beat so the type lands after the paper settles,
  // rather than everything arriving at once and reading as a page load
  useEffect(() => {
    const t = setTimeout(() => setLit(true), 620)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="site grain">
      <Compass />

      {/* ---- arrival ---------------------------------------------------- */}
      <div className={'hero' + (lit ? ' lit' : '')} ref={hero}>
        <div className="hero-sea" aria-hidden />
        <div className="hero-stars par" style={{ ['--par' as string]: '6px' }} aria-hidden />

        <div className="hero-chart par" style={{ ['--par' as string]: '18px' }}>
          {/* PLACEHOLDER. The hero painting: an unrolled chart, corners
              curling, one island half-drawn and the rest still blank. */}
          <span className="realm-await mono">painting: hero-chart</span>
          <div className="hero-chart-edge" aria-hidden />
        </div>

        <div className="wrap hero-say">
          <div className="hero-eyebrow label">
            <span className="tick">a map making platform</span>
          </div>
          <h1 className="d1">
            MAPVIS
            <em className="hero-sub">{typed}</em>
          </h1>
          <div className="hero-acts">
            <Link to={user ? '/maps' : '/enter?new=1'} className="plate">
              {user ? 'open my maps' : 'start a chart'}
            </Link>
            <Link to="/atlas" className="ul hero-alt">
              or wander the atlas
            </Link>
          </div>
        </div>

        <div className="hero-foot mono" aria-hidden>
          <span>48&deg;50&prime;N&nbsp;&nbsp;122&deg;12&prime;W</span>
          <span className="hero-scroll">scroll to sail</span>
        </div>
      </div>

      {/* ---- the voyage -------------------------------------------------- */}

      <Leg
        n="I"
        eyebrow="one painting, cut by hand"
        title="A map is not a grid. It is a picture somebody painted."
        body="Nothing here is tiled, assembled from parts, or grown in 3D. You bring one whole painting and cut the walkable ground out of it by hand, per pixel, with elevation and ramps and things that stand in front of you. The hand-drawn mask measures 0.69 pixels of boundary error. The AI-derived one measures 4.18."
        realm={<Realm name="Twilight Reach" note="a dark-fantasy coast at dusk" tone="#2b3a52" depth={1.1} />}
      />

      <Leg
        n="II"
        eyebrow="it becomes a place"
        title="Walk it before anyone else has to."
        body="Press play and you are standing on it, at character scale, on the exact collision the game will use. Doors open into other maps. If it feels wrong here it will feel wrong there, and you find that out in a second rather than after an export."
        flip
        realm={<Realm name="The Drowned Terrace" note="Atlantis, still lit under the water" tone="#17414a" depth={0.9} />}
      >
        <Link to="/atlas" className="plate quiet small">
          see one running
        </Link>
      </Leg>

      <Leg
        n="III"
        eyebrow="names, not coordinates"
        title="You name a place. Somebody's code can find it."
        body="Every door, post and landmark carries a name you typed. A member writes guide_to(&quot;maw_entrance&quot;) and never an x and a y, so moving the thing later does not break their island. That name is created here, because here is the only place it can be."
        realm={<Realm name="The White Tower" note="seven walls, one road up" tone="#4a4a52" depth={1.2} />}
      >
        <pre className="codelet mono" aria-label="what a member writes">
          <span className="c-dim"># their island, in real python</span>
          {'\n'}
          <span className="c-key">@on_talk</span>(<span className="c-str">"harbor_master"</span>)
          {'\n'}
          <span className="c-key">def</span> <span className="c-fn">stamp_the_sheet</span>(self):
          {'\n  '}
          <span className="c-key">yield</span> self.guide_to(<span className="c-str">"chart_table"</span>)
        </pre>
      </Leg>

      <Leg
        n="IV"
        eyebrow="export is a save, not a finish line"
        title="Publish it. It is in the game. Publish again, it is still there."
        body="Every publish is a version that never changes, so re-exporting cannot break a class that is halfway through a session, and a build can pin the exact version it was tested against. Nothing is copied by hand and nothing lives on one laptop."
        flip
        realm={<Realm name="Númenor, before" note="a coastline that has a date on it" tone="#3d3226" depth={1} />}
      />

      {/* ---- the close ---------------------------------------------------- */}
      <Close />
      <Foot />
    </div>
  )
}

/* The last thing on the page. A single line, a rule that draws itself, and one
 * door out. No feature grid, no testimonial, no newsletter. */
function Close() {
  const ref = useReveal<HTMLElement>()
  const { user } = useSession()
  return (
    <section className="sec close" ref={ref}>
      <div className="wrap">
        <div className="draw hair" />
        <div className="close-in">
          <h2 className="d2 rise">
            Bring a painting.
            <br />
            Leave with a place.
          </h2>
          <div className="rise" style={{ ['--i' as string]: 1 }}>
            <Link to={user ? '/maps' : '/enter?new=1'} className="plate">
              {user ? 'open my maps' : 'start a chart'}
            </Link>
            <p className="aside close-note">
              The cut, the levels, the walk test and export are free forever and always will be. A key
              only buys the parts that cost somebody money.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
