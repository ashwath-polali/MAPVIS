// Who this request belongs to, reachable from anywhere inside it.
//
// pixellab.mjs has a dozen exported calls and every one of them needs to spend
// on the RIGHT account's subscription. Threading a token through all of them
// would touch every signature in the file and every call site in api.mjs, and
// the one that got missed would silently bill the wrong person.
//
// AsyncLocalStorage carries it instead: the route sets it once, anything deeper
// asks for it, and a call that forgets simply gets nothing rather than getting
// somebody else's key.
import { AsyncLocalStorage } from 'node:async_hooks'

const store = new AsyncLocalStorage()

export const withRequest = (value, fn) => store.run(value, fn)

export const request = () => store.getStore() || {}

export const currentPixellabKey = () => request().pixellabKey || null

export const currentUserId = () => request().user?.id || null
