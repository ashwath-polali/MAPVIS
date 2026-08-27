import http from 'node:http'
import { store } from './server/store/blobs.mjs'
const s = store()
let hits = 0
const real = s.get.bind(s)
s.get = async (k) => { hits++; return real(k) }
const mod = await import('./server/api.mjs')
const srv = http.createServer(mod.default)
await new Promise((r) => srv.listen(0, r))
const port = srv.address().port
const ask = (p, h = {}) =>
  new Promise((res, rej) => {
    const q = http.get({ port, path: p, headers: h }, (r) => {
      const c = []
      r.on('data', (d) => c.push(d))
      r.on('end', () => res({ s: r.statusCode, etag: r.headers.etag, n: Buffer.concat(c).length }))
    })
    q.on('error', rej)
  })
for (const f of ['/work/hub/library/child-barefoot/east-0.png', '/work/hub/scene.png', '/work/hub/doc.json']) {
  const r = await ask(f)
  console.log(r.s + '  ' + String(r.n).padStart(7) + ' B  ' + f)
}
console.log('bucket reads: ' + hits + ' (want 0)')
const a = await ask('/work/hub/library/child-barefoot/east-0.png')
const b = await ask('/work/hub/library/child-barefoot/east-0.png', { 'if-none-match': a.etag })
console.log('revalidate -> ' + b.s + ' (want 304), body ' + b.n + ' B; bucket reads still ' + hits)
srv.close()
process.exit(0)
