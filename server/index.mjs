/* the api on its own for a built app behind a static host, and unused in dev where vite mounts server/api.mjs directly */
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
