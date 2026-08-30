/* The whole thing starts here.
 *
 * StrictMode is off on purpose. It double-invokes effects in development, and
 * the editor's effects attach canvases, pointer capture and animation loops to
 * real DOM; running those twice was never what the tool was written against.
 * The site pages are pure enough not to care either way, so the tool decides.
 *
 * app.css comes LAST so the editor's own surface wins inside the editor. The
 * two stylesheets share almost no selectors, and the ones they do share are
 * scoped: the site lives under .site, the tool does not.
 *
 * tokens.css comes FIRST and is the only file allowed to decide what a size, a
 * grey or an edge is. Everything after it aliases those names. First rather
 * than last on purpose: a later :root wins, so a sheet below that redeclares
 * --ink with its own hex silently turns the layer off, and the fix is to notice
 * it in this list.
 */
import { createRoot } from 'react-dom/client'
import Shell from './site/Shell'
import './site/tokens.css'
import './site/site.css'
import './site/arrive.css'
import './site/landing.css'
import './site/pages.css'
import './site/panels.css'
import './app.css'

createRoot(document.getElementById('root') as HTMLElement).render(<Shell />)
