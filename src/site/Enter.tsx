/* Sign in and sign up. One page for both, because two nearly identical pages with a link between them is how a form ends up with two validation rules. */
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
    if (user) go('/', true)
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
      go('/')
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
        back
      </Link>

      <div className="enter-desk">
        <div className="desk-art">
          <img src="/site-art/desk.png" alt="" />
        </div>

        <div className="enter-sheet">
          <div className="sheet-head">
            {/* the eyebrow used to repeat the heading word for word, which is
                the shape of a template rather than a page saying something */}
            <h1 className="d3">{isNew ? 'Create an account' : 'Sign in'}</h1>
            <p className="aside">
              {isNew
                ? 'Your maps are saved to your account, so you can open them from any computer. Making maps is free.'
                : 'Welcome back. Your maps are where you left them.'}
            </p>
          </div>

          <form onSubmit={submit} className="sheet-form">
            {isNew && (
              <Field label="your name" hint="optional">
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
            <Field label="password" hint={isNew ? 'at least 8 characters' : undefined}>
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
              {busy ? 'one moment' : isNew ? 'create account' : 'sign in'}
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
              {isNew ? 'I already have an account' : "I don't have an account yet"}
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
