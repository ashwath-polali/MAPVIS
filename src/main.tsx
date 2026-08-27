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
 */
import { createRoot } from 'react-dom/client'
import Shell from './site/Shell'
import './site/site.css'
import './site/arrive.css'
import './site/landing.css'
import './site/pages.css'
import './site/panels.css'
import './app.css'

createRoot(document.getElementById('root') as HTMLElement).render(<Shell />)
