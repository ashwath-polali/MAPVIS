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
  // 5274, one above the live MAPVIS instance, and a private dep cache so two
  // dev servers never share node_modules/.vite through the junction
  cacheDir: '.vite-cache',
  server: { port: 5274 },
})
