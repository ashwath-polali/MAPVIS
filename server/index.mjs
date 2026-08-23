/* The api on its own, for when the built app is served instead of the dev
 * server: `node server/index.mjs` then open dist/ behind any static host.
 * In dev it is not used, vite mounts server/api.mjs directly.
 */
import http from 'node:http'
import { api } from './api.mjs'

const port = Number(process.env.MAPVIS_API_PORT || 5275)
http
  .createServer((req, res) =>
    api(req, res, () => {
      res.statusCode = 404
      res.end('not found')
    }),
  )
  .listen(port, () => console.log(`mapvis api on http://localhost:${port}`))
