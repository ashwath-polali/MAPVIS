/* Sign in and sign up, at the desk.
 *
 * This is the one place the site leaves the water and sits on paper, because
 * making an account is the moment you stop looking at charts and start being
 * the person who draws them. The switch is total: vellum, iron gall ink, a
 * lamp, and a real pen line under the field you are typing in.
 *
 * One page for both, because two nearly identical pages with a link between
 * them is how a form ends up with two slightly different validation rules.
 */
import { useEffect, useRef, useState } from 'react'
import { Link, go, useRoute } from './router'
import { useSession, signIn, signUp } from './session'
import { usePointer } from './motion'

export default function Enter() {
  const route = useRoute()
  const { user } = useSession()
  const [isNew, setNew] = useState(route.query.get('new') === '1')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [why, setWhy] = useState('')
  const first = useRef<HTMLInputElement>(null)
  const desk = usePointer<HTMLDivElement>(0.5)

  useEffect(() => {
    if (user) go('/maps', true)
  }, [user])
  useEffect(() => {
    first.current?.focus()
  }, [isNew])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setWhy('')
    try {
      if (isNew) await signUp(email, password, name)
      else await signIn(email, password)
      go('/maps')
    } catch (err) {
      setWhy(String((err as Error).message))
      setBusy(false)
    }
  }

  return (
    <div className="site paper grain enter" ref={desk}>
      {/* the lamp: one warm pool of light that follows the pointer slightly */}
      <div className="lamp par" style={{ ['--par' as string]: '30px' }} aria-hidden />

      <Link to="/" className="enter-back ul">
        back to open water
      </Link>

      <div className="enter-desk">
        {/* PLACEHOLDER. PixelLab paints the desk: an unrolled chart, dividers,
            an ink pot, a brass rule, all seen from above. */}
        <div className="desk-art">
          <span className="realm-await mono">painting: cartographer-desk</span>
        </div>

        <div className="enter-sheet">
          <div className="sheet-head">
            <div className="label">{isNew ? 'a new hand' : 'welcome back'}</div>
            <h1 className="d3">{isNew ? 'Sign the ledger.' : 'Take up the pen.'}</h1>
            <p className="aside">
              {isNew
                ? 'An account is what makes a map yours on any machine. The cut, the levels, the walk test and export never cost anything.'
                : 'Your maps are where you left them, on whichever machine you left them from.'}
            </p>
          </div>

          <form onSubmit={submit} className="sheet-form">
            {isNew && (
              <Field label="what to call you" hint="shown on nothing yet, and optional">
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" />
              </Field>
            )}
            <Field label="email">
              <input
                ref={first}
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </Field>
            <Field label="password" hint={isNew ? 'eight characters at the very least' : undefined}>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={isNew ? 'new-password' : 'current-password'}
              />
            </Field>

            {why && (
              <p className="wax" role="alert">
                {why}
              </p>
            )}

            <button className="plate" disabled={busy}>
              {busy ? 'a moment' : isNew ? 'sign the ledger' : 'enter'}
            </button>
          </form>

          <div className="sheet-foot">
            <button
              className="ul asbtn"
              onClick={() => {
                setNew(!isNew)
                setWhy('')
              }}
            >
              {isNew ? 'I have been here before' : 'I have never been here'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* A field is a label above a line, with the rule drawing itself as you focus
 * it. No boxes: a box is a form control, a line is a place to write. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="wfield">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="wfield-hint">{hint}</span> : null}
    </label>
  )
}
