// AsyncLocalStorage rather than a threaded token, because a call site that missed one would silently bill the wrong account and here it just gets nothing
import { AsyncLocalStorage } from 'node:async_hooks'

const store = new AsyncLocalStorage()

export const withRequest = (value, fn) => store.run(value, fn)

export const request = () => store.getStore() || {}

export const currentPixellabKey = () => request().pixellabKey || null

export const currentUserId = () => request().user?.id || null
