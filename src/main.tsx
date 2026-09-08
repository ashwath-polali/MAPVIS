/* StrictMode is off: it double-invokes effects and the editor attaches canvases, pointer capture and loops to real DOM. tokens.css first because a later :root wins; app.css last so the editor's surface wins inside the editor. */
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
