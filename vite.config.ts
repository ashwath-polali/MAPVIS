import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { api } from './server/api.mjs'

// The api runs inside the dev server so `npm run dev` is one command on one
// port, and so the pixellab token is only ever read in node.
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'mapvis-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => api(req, res, next))
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => api(req, res, next))
      },
    },
  ],
  // 5275 for the platform worktree, so the tool Ash is editing on 5274 keeps
  // running untouched while this branch is built and tested. A private dep
  // cache so two dev servers never share node_modules/.vite through the junction.
  cacheDir: '.vite-cache',
  server: { port: 5275, strictPort: true },
})
