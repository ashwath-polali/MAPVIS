// The whole api, as one vercel function.
//
// server/api.mjs is a plain node (req, res) handler and stays that way, so this
// file is nine lines rather than thirty separate functions. It is also the
// rule: no vercel-only primitive anywhere, so moving host is a deploy config
// and never a rewrite. If Hobby's ban on commercial use ever matters, this file
// is what gets deleted and nothing else changes.
//
// vercel.json routes every /api/* and /work/* path here; everything else is the
// static build in dist/.
import { api } from '../server/api.mjs'

export default function handler(req, res) {
  return api(req, res, () => {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'no such endpoint' }))
  })
}
