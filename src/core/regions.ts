/* the main-thread side of the region pass: pixels go to the worker and one label per pixel comes back, all local, no network and no model */

export interface RegionResult {
  labels: Int32Array
  count: number
}

// tolerance 40 is the same fixed value the auto sea uses so there is one behaviour, and minPx 24 absorbs anti-aliasing specks without eating real detail
export function computeRegions(
  pix: Uint8ClampedArray,
  w: number,
  h: number,
  tol = 40,
  minPx = 24,
): Promise<RegionResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./regions.worker.ts', import.meta.url), { type: 'module' })
    const copy = pix.slice()
    worker.onmessage = (e: MessageEvent<{ labels: ArrayBuffer; count: number }>) => {
      worker.terminate()
      resolve({ labels: new Int32Array(e.data.labels), count: e.data.count })
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'the region pass failed'))
    }
    worker.postMessage({ w, h, tol, minPx, pix: copy.buffer }, [copy.buffer])
  })
}
