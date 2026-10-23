/**
 * Zotero plugin PDF viewer (same-origin, served by the plugin host).
 *
 * Adapted from the verified prototype at `~/zotero-tools/viewer-test/`:
 * continuous pages, `<canvas>` rendering plus a pdf.js `TextLayer` for
 * selection, `data-page` attributes on each page element, fit-to-width default
 * and manual zoom. The browser half embeds this page in an iframe and reads
 * `contentWindow.getSelection()`; a page number is found by walking selection
 * ancestors up to the nearest `[data-page]`.
 *
 * pdf.js 6.3.289 needs the `Map.prototype.getOrInsert*` polyfills in Chrome
 * 143; they are installed before the dynamic import evaluates pdf.js.
 */

// --- pdf.js 6.x Map polyfills (Chrome 143 is missing these) ------------------
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

// Dynamic import so the polyfills above are guaranteed to be in place before
// pdf.js module initialization runs.
const pdfjs = await import('./pdfjs/build/pdf.mjs')
// The worker needs the same polyfills; this shim installs them first.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.polyfill.mjs', import.meta.url).href

const CMAP_URL = new URL('./pdfjs/cmaps/', import.meta.url).href
const STANDARD_FONTS_URL = new URL('./pdfjs/standard_fonts/', import.meta.url).href

const pagesEl = document.getElementById('pages')
const infoEl = document.getElementById('info')
const errorEl = document.getElementById('error')
const zoomInButton = document.getElementById('zoom-in')
const zoomOutButton = document.getElementById('zoom-out')
const zoomFitButton = document.getElementById('zoom-fit')

const params = new URLSearchParams(location.search)
const state = { doc: null, scale: 1, fit: true }

let renderGeneration = 0
let renderChain = Promise.resolve()
let resizeTimer = null

/** Only allow the plugin's own PDF endpoint as the document source. */
function resolveFileUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const url = new URL(raw, location.href)
    if (url.origin !== location.origin) return null
    if (!/^\/zotero\/file\/[A-Za-z0-9]{1,32}$/.test(url.pathname)) return null
    return url.pathname + url.search
  } catch {
    return null
  }
}

function showError(message) {
  window.__viewerError = String(message)
  errorEl.textContent = String(message)
  errorEl.classList.add('show')
  infoEl.textContent = '加载失败'
}

function clearError() {
  window.__viewerError = null
  errorEl.textContent = ''
  errorEl.classList.remove('show')
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function fitScaleFor(baseWidth) {
  const available = Math.max(300, Math.min(window.innerWidth - 24, 1400))
  if (!baseWidth) return 1
  return clamp(available / baseWidth, 0.4, 3)
}

function updateInfo() {
  if (!state.doc) return
  infoEl.textContent = `${state.doc.numPages} 页 · ${Math.round(state.scale * 100)}%`
}

/**
 * Queue a (re)render. Rendering is serialized so zoom/resize cannot interleave
 * two render loops over the same DOM; a new generation cancels the old one at
 * its next checkpoint.
 */
function requestRender() {
  const generation = ++renderGeneration
  renderChain = renderChain
    .then(() => renderAll(generation))
    .catch((error) => {
      showError(`渲染 PDF 失败：${error && error.message ? error.message : error}`)
    })
  return renderChain
}

async function renderAll(generation) {
  if (!state.doc) return
  const doc = state.doc
  const firstPage = await doc.getPage(1)
  const baseViewport = firstPage.getViewport({ scale: 1 })
  if (generation !== renderGeneration) return

  if (state.fit) state.scale = fitScaleFor(baseViewport.width)
  const devicePixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
  pagesEl.replaceChildren()
  updateInfo()

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    if (generation !== renderGeneration) return
    const page = await doc.getPage(pageNumber)
    if (generation !== renderGeneration) return

    const cssViewport = page.getViewport({ scale: state.scale })
    const renderViewport = page.getViewport({ scale: state.scale * devicePixelRatio })

    const pageDiv = document.createElement('div')
    pageDiv.className = 'page'
    pageDiv.dataset.page = String(pageNumber)
    pageDiv.style.width = `${Math.floor(cssViewport.width)}px`
    pageDiv.style.height = `${Math.floor(cssViewport.height)}px`

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(renderViewport.width))
    canvas.height = Math.max(1, Math.floor(renderViewport.height))
    canvas.style.width = `${Math.floor(cssViewport.width)}px`
    canvas.style.height = `${Math.floor(cssViewport.height)}px`
    pageDiv.appendChild(canvas)

    const textDiv = document.createElement('div')
    textDiv.className = 'textLayer'
    // pdf.js >= 6 computes every span's font size from --total-scale-factor
    // (older versions used --scale-factor). Keep both: a missing total factor
    // makes the text layer font sizes wrong, so pointer hit-testing selects
    // different text from the glyphs under the cursor.
    textDiv.style.setProperty('--total-scale-factor', String(state.scale))
    textDiv.style.setProperty('--scale-factor', String(state.scale))
    textDiv.style.width = `${Math.floor(cssViewport.width)}px`
    textDiv.style.height = `${Math.floor(cssViewport.height)}px`
    pageDiv.appendChild(textDiv)

    pagesEl.appendChild(pageDiv)

    const canvasContext = canvas.getContext('2d', { alpha: false })
    await page.render({ canvasContext, viewport: renderViewport }).promise
    if (generation !== renderGeneration) return

    const textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textDiv,
      viewport: cssViewport,
    })
    await textLayer.render()
  }

  if (generation === renderGeneration) {
    window.__ready = true
    window.__zoteroViewerReady = true
  }
}

function setScale(nextScale, fit) {
  state.fit = !!fit
  state.scale = clamp(nextScale, 0.25, 4)
  requestRender()
}

zoomInButton.addEventListener('click', () => setScale(state.scale * 1.2, false))
zoomOutButton.addEventListener('click', () => setScale(state.scale / 1.2, false))
zoomFitButton.addEventListener('click', () => {
  state.fit = true
  requestRender()
})

// Height-only resizes (the surrounding chat/composer changing size) must not
// rebuild the pages: replacing the text layer destroys the user's selection
// and makes it look like it was cancelled right after selecting. Fit-width
// only depends on the available width, so track that instead of any resize.
let lastFitWidth = window.innerWidth
window.addEventListener('resize', () => {
  if (!state.fit) return
  if (window.innerWidth === lastFitWidth) return
  lastFitWidth = window.innerWidth
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => requestRender(), 200)
})

/** Select text across TextLayer spans (used by the headless verification). */
function selectText(startIndex = 0, endIndex = 5) {
  const spans = Array.from(document.querySelectorAll('.textLayer span')).filter(
    (span) => (span.textContent || '').length > 0,
  )
  if (spans.length === 0) return { text: '', spanCount: 0, page: null }
  const start = clamp(Math.trunc(Number(startIndex) || 0), 0, spans.length - 1)
  const end = clamp(Math.trunc(Number(endIndex) || 0), start, spans.length - 1)
  const startNode = spans[start].firstChild || spans[start]
  const endNode = spans[end].firstChild || spans[end]
  const range = document.createRange()
  range.setStart(startNode, 0)
  range.setEnd(
    endNode,
    start === end ? Math.min((endNode.textContent || '').length, 20) : (endNode.textContent || '').length,
  )
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  let node = selection.anchorNode
  let page = null
  while (node) {
    if (node.nodeType === 1 && node.dataset && node.dataset.page) {
      page = node.dataset.page
      break
    }
    node = node.parentNode
  }
  return { text: selection.toString(), spanCount: spans.length, page }
}

/** The pages live in a scrollable #pages column, not the window itself. */
function scrollContainer() {
  return document.getElementById('pages')
}

/** Current reading progress: page number and 0..1 offset within that page. */
function getProgress() {
  const scroller = scrollContainer()
  const pages = Array.from(document.querySelectorAll('.page'))
  if (!scroller || pages.length === 0) return { page: 1, ratio: 0 }
  const y = scroller.scrollTop
  let current = pages[0]
  for (const page of pages) {
    if (page.offsetTop <= y + 1) current = page
  }
  const height = current.offsetHeight || 1
  const ratio = Math.max(0, Math.min(1, (y - current.offsetTop) / height))
  return { page: Number(current.dataset.page) || 1, ratio: Number(ratio.toFixed(4)) }
}

/** Restore a saved progress point (after the pages have rendered). */
function goTo(pageNumber, ratio = 0) {
  const scroller = scrollContainer()
  const page = document.querySelector('.page[data-page="' + (Number(pageNumber) || 1) + '"]')
  if (!scroller || !page) return false
  const offset = Math.max(0, Math.min(1, Number(ratio) || 0)) * (page.offsetHeight || 0)
  scroller.scrollTop = page.offsetTop + offset
  return true
}

/**
 * Convert the current DOM selection into a Zotero annotation position:
 * `{ pageIndex, pageLabel, rects: [[x1,y1,x2,y2], ...], text }`, with PDF user
 * space coordinates (origin bottom-left). Multi-page selections keep the first
 * page's rectangles.
 */
function selectionRects() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const text = selection.toString().trim()
  if (!text) return null
  const range = selection.getRangeAt(0)
  const pages = Array.from(document.querySelectorAll('.page'))
  const groups = new Map()
  const scale = state.scale || 1
  for (const rect of range.getClientRects()) {
    if (!rect || rect.width <= 0 || rect.height <= 0) continue
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const page = pages.find((element) => {
      const box = element.getBoundingClientRect()
      return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom
    })
    if (!page) continue
    const box = page.getBoundingClientRect()
    const pageIndex = Number(page.dataset.page)
    const pageHeight = box.height / scale
    const x1 = (rect.left - box.left) / scale
    const x2 = (rect.right - box.left) / scale
    const yTop = (rect.top - box.top) / scale
    const yBottom = (rect.bottom - box.top) / scale
    const round = (value) => Math.round(value * 100) / 100
    const entry = groups.get(pageIndex) || { pageIndex, pageLabel: String(pageIndex), rects: [] }
    entry.rects.push([round(x1), round(pageHeight - yBottom), round(x2), round(pageHeight - yTop)])
    groups.set(pageIndex, entry)
  }
  const first = groups.values().next().value
  if (!first || first.rects.length === 0) return null
  first.pageIndex = first.pageIndex - 1
  first.text = text
  return first
}

window.__zoteroViewer = {
  get ready() {
    return window.__zoteroViewerReady === true
  },
  get scale() {
    return state.scale
  },
  get doc() {
    return state.doc
  },
  selectText,
  getProgress,
  goTo,
  selectionRects,
}
window.__selectText = selectText

async function boot() {
  const fileUrl = resolveFileUrl(params.get('file'))
  if (!fileUrl) {
    showError('缺少有效的 file 参数：应为 /zotero/file/<attachmentKey>。')
    return
  }
  try {
    const doc = await pdfjs.getDocument({
      url: fileUrl,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONTS_URL,
    }).promise
    clearError()
    state.doc = doc
    window.__pdf = doc
    await requestRender()
  } catch (error) {
    showError(`无法加载 PDF：${error && error.message ? error.message : error}`)
  }
}

boot()
