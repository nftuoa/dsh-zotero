/**
 * PDF.js worker entry shim for the Zotero plugin.
 *
 * pdf.js 6.3.289 assumes `Map.prototype.getOrInsertComputed` (and friends)
 * which Chrome 143 does not ship. The polyfills must exist in the *worker*
 * realm too: in this pdf.js version the chunked data transport runs inside
 * `pdf.worker.mjs`, so a main-thread-only polyfill fails at getDocument time.
 *
 * This file is served as `/zotero/pdf.worker.polyfill.mjs` and used as
 * `GlobalWorkerOptions.workerSrc`. It installs the polyfills, then loads the
 * vendored worker module (which self-initializes on import).
 */

if (!Map.prototype.getOrInsert) {
  Map.prototype.getOrInsert = function getOrInsert(key, value) {
    if (!this.has(key)) this.set(key, value)
    return this.get(key)
  }
}
if (!Map.prototype.getOrInsertComputed) {
  Map.prototype.getOrInsertComputed = function getOrInsertComputed(key, compute) {
    if (!this.has(key)) this.set(key, compute(key))
    return this.get(key)
  }
}
if (!WeakMap.prototype.getOrInsertComputed) {
  WeakMap.prototype.getOrInsertComputed = function getOrInsertComputed(key, compute) {
    if (!this.has(key)) this.set(key, compute(key))
    return this.get(key)
  }
}

await import('./pdfjs/build/pdf.worker.mjs')
