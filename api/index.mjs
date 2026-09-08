// the whole api as one vercel function, and no vercel-only primitive anywhere, so moving host is a deploy config and this file is what gets deleted
import { api } from '../server/api.mjs'

export default function handler(req, res) {
  return api(req, res, () => {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'no such endpoint' }))
  })
}
