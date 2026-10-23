/**
 * Host-half acceptance tests for the DSH Zotero plugin (`node:test`).
 *
 * Run: node test/host.test.mjs
 *
 * Covers the contract §1 data layer (listItems/getItem/listCollections/PDF
 * resolution), Range parsing, static-path traversal protection, the HTTP
 * surface (JSON, PDF HEAD/Range, vendored pdf.js, malformed keys), and cordis
 * wiring via a mock context (route + optional tools).
 *
 * Tests read the user's real Zotero library, so they verify the actual
 * integration rather than a fixture. The snapshot cache is redirected to a
 * throw-away temp directory so tests never race the standalone harness.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  closeSnapshot,
  getItem,
  getStatus,
  isValidKey,
  listCollections,
  listItems,
  openSnapshot,
  readAttachment,
  sourceSignature,
} from '../lib/zotero-data.mjs'
import { createRouter, parseRange, resolveStaticPath } from '../lib/routes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const PDFJS_DIR = path.join(PACKAGE_ROOT, 'vendor', 'pdfjs')
const KATEX_DIR = path.join(PACKAGE_ROOT, 'vendor', 'katex')
const DATA_DIR = path.resolve(process.env.ZOTERO_DATA_DIR || path.join(os.homedir(), 'Zotero'))
const SAMPLE_ATTACHMENT_KEY = 'JF3BKJPS'
const SAMPLE_ITEM_KEY = 'WKTAY774' // He et al. 2015 — has the sample PDF.

let library
let server
let serverPort
let baseUrl
let tempCacheDir

before(async () => {
  tempCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zotero-test-'))
  library = openSnapshot({ dataDir: DATA_DIR, cacheDir: tempCacheDir, refreshMs: 60_000 })
  const handler = createRouter({
    library,
    assetsDir: path.join(PACKAGE_ROOT, 'assets'),
    pdfjsDir: PDFJS_DIR,
    katexDir: KATEX_DIR,
    logger: { error() {} },
  })
  server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`test harness failure: ${error && error.message}`)
      } else {
        res.destroy()
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  serverPort = server.address().port
  baseUrl = `http://127.0.0.1:${serverPort}`
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (library) closeSnapshot(library)
  if (tempCacheDir) fs.rmSync(tempCacheDir, { recursive: true, force: true })
})

/** One fetch with parsed JSON/body/headers. */
async function request(pathAndQuery, { method = 'GET', headers = {} } = {}) {
  const response = await fetch(baseUrl + pathAndQuery, { method, headers })
  const buffer = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') || ''
  let json = null
  if (contentType.includes('application/json') && buffer.length > 0) {
    try {
      json = JSON.parse(buffer.toString('utf8'))
    } catch {
      json = null
    }
  }
  return { status: response.status, headers: response.headers, buffer, json }
}

/** Raw request that bypasses WHATWG URL normalization (traversal tests). */
function rawRequest(pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: serverPort, path: pathname, method }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Data layer
// ---------------------------------------------------------------------------

test('snapshot cache is populated from the live Zotero database', async () => {
  await library.ensureFresh()
  assert.ok(library.model, `snapshot unavailable: ${library.error && library.error.message}`)
  assert.ok(fs.existsSync(library.snapshotPath), `missing snapshot ${library.snapshotPath}`)
  assert.match(path.basename(library.snapshotPath), /^zotero-[0-9a-f]{8}\.sqlite$/)
  assert.ok(sourceSignature(DATA_DIR).includes(':'))
})

test('getStatus reports a readable Zotero SQLite snapshot', async () => {
  const status = await getStatus(library)
  assert.equal(status.ok, true)
  assert.equal(status.source, 'zotero-sqlite')
  assert.equal(status.dataDir, DATA_DIR)
  assert.ok(status.itemCount >= 90, `itemCount=${status.itemCount}`)
  assert.ok(status.pdfCount > 0, `pdfCount=${status.pdfCount}`)
  assert.equal(status.message, null)
  assert.equal(typeof status.zoteroRunning, 'boolean')
  assert.ok(status.paperCount >= 40, `paperCount=${status.paperCount}`)
})

test('listItems returns normalized paper entries', async () => {
  const result = await listItems(library, { limit: 5 })
  assert.ok(result.total >= 40, `total=${result.total}`)
  assert.equal(result.items.length, 5)
  for (const item of result.items) {
    assert.equal(typeof item.key, 'string')
    assert.ok(isValidKey(item.key), `bad key ${item.key}`)
    assert.equal(typeof item.title, 'string')
    assert.ok(Array.isArray(item.creators))
    for (const creator of item.creators) {
      assert.equal(typeof creator.name, 'string')
      assert.ok(creator.name.length > 0)
    }
    assert.equal(typeof item.year, 'string')
    if (item.year) assert.match(item.year, /^\d{4}$/)
    assert.ok(['journalArticle', 'conferencePaper', 'preprint'].includes(item.itemType))
    assert.equal(typeof item.hasPDF, 'boolean')
    assert.ok(Array.isArray(item.collections))
    assert.ok(Array.isArray(item.tags))
    assert.equal(typeof item.dateAdded, 'string')
  }

  const all = await listItems(library, { limit: 500 })
  const withPdf = all.items.filter((item) => item.hasPDF)
  assert.ok(withPdf.length > 0)
  for (const item of withPdf) {
    assert.ok(isValidKey(item.attachmentKey), `bad attachmentKey ${item.attachmentKey}`)
  }
})

test('listItems searches, paginates and filters by collection', async () => {
  const firstPage = await listItems(library, { limit: 3, offset: 0 })
  const secondPage = await listItems(library, { limit: 3, offset: 3 })
  const firstKeys = new Set(firstPage.items.map((item) => item.key))
  assert.equal(secondPage.items.filter((item) => firstKeys.has(item.key)).length, 0)

  const search = await listItems(library, { q: 'Rectifiers' })
  assert.ok(search.total >= 1, 'expected the He et al. paper in search results')
  assert.ok(search.items.some((item) => /rectifier/i.test(item.title)))

  const empty = await listItems(library, { q: 'zzzz-no-such-paper-zzzz' })
  assert.equal(empty.total, 0)
  assert.deepEqual(empty.items, [])

  const { collections } = await listCollections(library)
  const withItems = collections.find((collection) => collection.count > 0)
  if (withItems) {
    const filtered = await listItems(library, { collection: withItems.key, limit: 500 })
    assert.equal(filtered.total, withItems.count)
  }
})

test('listCollections returns keys with item counts', async () => {
  const { collections } = await listCollections(library)
  assert.ok(Array.isArray(collections))
  for (const collection of collections) {
    assert.ok(isValidKey(collection.key), `bad collection key ${collection.key}`)
    assert.equal(typeof collection.name, 'string')
    assert.ok(Number.isInteger(collection.count) && collection.count >= 0)
  }
})

test('collections expose a parent tree, rolled-up totals and unfiled papers', async () => {
  const { collections, unfiledCount } = await listCollections(library)
  const byKey = new Map(collections.map((collection) => [collection.key, collection]))

  for (const collection of collections) {
    assert.ok(Number.isInteger(collection.totalCount), 'totalCount must be an integer')
    assert.ok(collection.totalCount >= collection.count, 'totalCount must include direct items')
    if (collection.parentKey !== null) {
      assert.ok(isValidKey(collection.parentKey), `bad parentKey ${collection.parentKey}`)
      assert.ok(byKey.has(collection.parentKey), 'parentKey must name a listed collection')
    }
    const children = collections.filter((entry) => entry.parentKey === collection.key)
    const childTotal = children.reduce((sum, child) => sum + child.totalCount, 0)
    assert.equal(collection.totalCount, collection.count + childTotal, `nested total mismatch for ${collection.key}`)
  }

  assert.ok(Number.isInteger(unfiledCount) && unfiledCount >= 0)
  const unfiled = await listItems(library, { unfiled: true, limit: 500 })
  assert.equal(unfiled.total, unfiledCount)
  for (const item of unfiled.items) assert.equal(item.collections.length, 0, 'unfiled items carry no collection')

  const all = await listItems(library, { limit: 500 })
  assert.equal(unfiledCount + all.items.filter((item) => item.collections.length > 0).length, all.total)

  const withItems = collections.find((collection) => collection.count > 0)
  if (withItems) {
    const filtered = await listItems(library, { collection: withItems.key, limit: 500 })
    assert.equal(filtered.total, withItems.count)
    for (const item of filtered.items) {
      assert.ok(item.collections.some((entry) => entry.key === withItems.key))
    }
  }
})

test('getItem resolves a readable PDF path on disk', async () => {
  const all = await listItems(library, { limit: 500 })
  const candidate = all.items.find((item) => item.hasPDF)
  assert.ok(candidate, 'expected at least one paper with a PDF')

  const detail = await getItem(library, candidate.key)
  assert.ok(detail)
  assert.equal(detail.key, candidate.key)
  assert.ok(detail.pdf, 'expected pdf object')
  assert.equal(detail.pdf.key, candidate.attachmentKey)
  assert.equal(detail.pdf.url, `/zotero/file/${detail.pdf.key}`)
  assert.ok(path.isAbsolute(detail.pdf.path), `pdf.path not absolute: ${detail.pdf.path}`)
  assert.ok(fs.existsSync(detail.pdf.path), `pdf.path missing: ${detail.pdf.path}`)
  const stat = fs.statSync(detail.pdf.path)
  assert.equal(detail.pdf.size, stat.size)
  assert.ok(detail.pdf.filename.toLowerCase().endsWith('.pdf'))
  assert.ok(Array.isArray(detail.attachments))
  assert.ok(detail.attachments.some((attachment) => attachment.key === detail.pdf.key))
  assert.equal(typeof detail.abstractNote, 'string')
  assert.equal(typeof detail.doi, 'string')
  assert.equal(typeof detail.url, 'string')

  assert.equal(await getItem(library, 'ZZZZZZZZ'), null)
  assert.equal(await getItem(library, 'not a key'), null)
})

test('readAttachment only resolves DB-verified PDF files', async () => {
  const attachment = await readAttachment(library, SAMPLE_ATTACHMENT_KEY)
  assert.ok(attachment)
  assert.equal(attachment.key, SAMPLE_ATTACHMENT_KEY)
  assert.equal(attachment.contentType, 'application/pdf')
  assert.ok(path.isAbsolute(attachment.path))
  assert.ok(fs.existsSync(attachment.path))
  assert.ok(attachment.size > 1000)
  assert.ok(attachment.filename.toLowerCase().endsWith('.pdf'))

  assert.equal(await readAttachment(library, 'ZZZZZZZZ'), null)
  assert.equal(await readAttachment(library, '../etc/passwd'), null)
  assert.equal(await readAttachment(library, 'not/a/key'), null)
  assert.equal(await readAttachment(library, ''), null)
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('parseRange handles single, open and suffix ranges', () => {
  assert.deepEqual(parseRange('bytes=0-1023', 5000), { start: 0, end: 1023 })
  assert.deepEqual(parseRange('bytes=1000-', 5000), { start: 1000, end: 4999 })
  assert.deepEqual(parseRange('bytes=-500', 5000), { start: 4500, end: 4999 })
  assert.deepEqual(parseRange('bytes=0-999999', 5000), { start: 0, end: 4999 })
  assert.deepEqual(parseRange('bytes=0-0', 5000), { start: 0, end: 0 })
  assert.deepEqual(parseRange('bytes=4999-', 5000), { start: 4999, end: 4999 })
  assert.deepEqual(parseRange('bytes=5000-', 5000), { unsatisfiable: true })
  assert.deepEqual(parseRange('bytes=10-5', 5000), { unsatisfiable: true })
  assert.deepEqual(parseRange('bytes=-0', 5000), { unsatisfiable: true })
  assert.equal(parseRange('bytes=abc', 5000), undefined)
  assert.equal(parseRange('items=0-10', 5000), undefined)
  assert.equal(parseRange('bytes=0-1,4-5', 5000), undefined)
  assert.equal(parseRange(undefined, 5000), undefined)
  assert.deepEqual(parseRange('bytes=0-1', 0), { unsatisfiable: true })
})

test('resolveStaticPath resolves inside the root and rejects traversal', () => {
  assert.equal(resolveStaticPath(PDFJS_DIR, 'build/pdf.worker.mjs'), path.join(PDFJS_DIR, 'build', 'pdf.worker.mjs'))
  for (const attempt of [
    '../etc/passwd',
    '%2e%2e/etc/passwd',
    'build/%2e%2e/%2e%2e/etc/passwd',
    'build/../build/pdf.mjs',
    '..%2fetc%2fpasswd',
    'build%2f..%2f..%2fetc%2fpasswd',
    'build/pdf.worker.mjs%00',
    '',
  ]) {
    assert.equal(resolveStaticPath(PDFJS_DIR, attempt), null, `expected null for ${JSON.stringify(attempt)}`)
  }
  // A leading slash is not traversal: it is still rooted below pdfjsDir.
  assert.equal(resolveStaticPath(PDFJS_DIR, '/build/pdf.mjs'), path.join(PDFJS_DIR, 'build', 'pdf.mjs'))
})

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

test('HTTP API: status/items/item/collections', async () => {
  const status = await request('/zotero/api/status')
  assert.equal(status.status, 200)
  assert.equal(status.headers.get('cache-control'), 'no-store')
  assert.match(status.headers.get('content-type') || '', /^application\/json/)
  assert.equal(status.json.ok, true)
  assert.equal(status.json.source, 'zotero-sqlite')
  assert.ok(status.json.itemCount >= 90)

  const items = await request('/zotero/api/items?limit=5')
  assert.equal(items.status, 200)
  assert.equal(items.headers.get('cache-control'), 'no-store')
  assert.equal(items.json.items.length, 5)
  assert.ok(items.json.total >= 40)
  const withPdf = items.json.items.find((item) => item.hasPDF)
  assert.ok(withPdf)

  const detail = await request(`/zotero/api/item/${encodeURIComponent(withPdf.key)}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.json.key, withPdf.key)
  assert.ok(detail.json.pdf)
  assert.ok(fs.existsSync(detail.json.pdf.path))

  const collections = await request('/zotero/api/collections')
  assert.equal(collections.status, 200)
  assert.ok(Array.isArray(collections.json.collections))
  assert.ok(Number.isInteger(collections.json.unfiledCount))
  assert.ok(collections.json.collections.every((entry) => 'parentKey' in entry && 'totalCount' in entry))

  const unfiled = await request('/zotero/api/items?unfiled=1&limit=500')
  assert.equal(unfiled.status, 200)
  assert.equal(unfiled.json.total, collections.json.unfiledCount)
  assert.ok(unfiled.json.items.every((item) => item.collections.length === 0))

  const conflicting = await request('/zotero/api/items?unfiled=1&collection=ABCD1234')
  assert.equal(conflicting.status, 400)
  assert.equal(conflicting.json.error.code, 'invalid_filter')

  const annotations = await request('/zotero/api/annotations/3FJ3CCDD')
  assert.equal(annotations.status, 200)
  assert.ok(Array.isArray(annotations.json.annotations))
  assert.ok(annotations.json.notes.some((note) => note.key === '2ITGL2ZD'))

  const missing = await request('/zotero/api/item/ZZZZZZZZ')
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'item_not_found')
})

test('HTTP PDF endpoint streams bytes with HEAD and Range support', async () => {
  const full = await request(`/zotero/file/${SAMPLE_ATTACHMENT_KEY}`)
  assert.equal(full.status, 200)
  assert.match(full.headers.get('content-type') || '', /^application\/pdf/)
  assert.equal(full.headers.get('accept-ranges'), 'bytes')
  assert.ok(full.buffer.length > 1000)
  assert.equal(Number(full.headers.get('content-length')), full.buffer.length)
  const disposition = full.headers.get('content-disposition') || ''
  assert.match(disposition, /^inline;/)
  assert.match(disposition, /filename\*=UTF-8''/)
  assert.match(disposition, /filename="/)

  const head = await request(`/zotero/file/${SAMPLE_ATTACHMENT_KEY}`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.buffer.length, 0)
  assert.equal(Number(head.headers.get('content-length')), full.buffer.length)

  const range = await request(`/zotero/file/${SAMPLE_ATTACHMENT_KEY}`, { headers: { Range: 'bytes=0-1023' } })
  assert.equal(range.status, 206)
  assert.equal(range.buffer.length, 1024)
  assert.equal(Number(range.headers.get('content-length')), 1024)
  assert.match(range.headers.get('content-range') || '', /^bytes 0-1023\/\d+$/)
  assert.equal(range.headers.get('accept-ranges'), 'bytes')

  const openRange = await request(`/zotero/file/${SAMPLE_ATTACHMENT_KEY}`, { headers: { Range: 'bytes=1000-' } })
  assert.equal(openRange.status, 206)
  assert.equal(openRange.buffer.length, full.buffer.length - 1000)

  const unsatisfiable = await request(`/zotero/file/${SAMPLE_ATTACHMENT_KEY}`, {
    headers: { Range: `bytes=${full.buffer.length + 10}-` },
  })
  assert.equal(unsatisfiable.status, 416)
  assert.match(unsatisfiable.headers.get('content-range') || '', /^bytes \*\/\d+$/)

  const malformedKey = await request('/zotero/file/BAD!KEY')
  assert.equal(malformedKey.status, 400)
  const unknown = await request('/zotero/file/ZZZZZZZZ')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.error.code, 'attachment_not_found')
})

test('HTTP static assets: viewer page and vendored pdf.js', async () => {
  const html = await request('/zotero/viewer.html')
  assert.equal(html.status, 200)
  assert.match(html.headers.get('content-type') || '', /^text\/html/)
  assert.match(html.headers.get('cache-control') || '', /no-cache/)
  const htmlText = html.buffer.toString('utf8')
  assert.match(htmlText, /viewer\.js/)
  assert.match(htmlText, /pdfjs\/web\/pdf_viewer\.css/)

  const viewerJs = await request('/zotero/viewer.js')
  assert.equal(viewerJs.status, 200)
  assert.match(viewerJs.headers.get('content-type') || '', /^text\/javascript/)
  assert.match(viewerJs.buffer.toString('utf8'), /getOrInsertComputed/)

  const workerShim = await request('/zotero/pdf.worker.polyfill.mjs')
  assert.equal(workerShim.status, 200)
  assert.match(workerShim.headers.get('content-type') || '', /^text\/javascript/)
  assert.match(workerShim.buffer.toString('utf8'), /getOrInsertComputed/)
  assert.match(workerShim.buffer.toString('utf8'), /pdf\.worker\.mjs/)

  const worker = await request('/zotero/pdfjs/build/pdf.worker.mjs')
  assert.equal(worker.status, 200)
  assert.match(worker.headers.get('content-type') || '', /^text\/javascript/)
  assert.match(worker.headers.get('cache-control') || '', /immutable/)
  assert.ok(worker.buffer.length > 100_000)
  const workerHead = await request('/zotero/pdfjs/build/pdf.worker.mjs', { method: 'HEAD' })
  assert.equal(workerHead.status, 200)
  assert.equal(workerHead.buffer.length, 0)

  const pdfModule = await request('/zotero/pdfjs/build/pdf.mjs')
  assert.equal(pdfModule.status, 200)
  assert.match(pdfModule.headers.get('content-type') || '', /^text\/javascript/)

  const css = await request('/zotero/pdfjs/web/pdf_viewer.css')
  assert.equal(css.status, 200)
  assert.match(css.headers.get('content-type') || '', /^text\/css/)

  const cmap = await request('/zotero/pdfjs/cmaps/UniJIS-UCS2-H.bcmap')
  assert.equal(cmap.status, 200)
  assert.match(cmap.headers.get('content-type') || '', /octet-stream/)

  const katexCss = await request('/zotero/katex/katex.min.css')
  assert.equal(katexCss.status, 200)
  assert.match(katexCss.headers.get('content-type') || '', /^text\/css/)
  assert.match(katexCss.headers.get('cache-control') || '', /immutable/)

  const katexJs = await request('/zotero/katex/katex.min.js')
  assert.equal(katexJs.status, 200)
  assert.match(katexJs.headers.get('content-type') || '', /^text\/javascript/)
  assert.ok(katexJs.buffer.length > 10_000)

  const katexFont = await request('/zotero/katex/fonts/KaTeX_Main-Regular.woff2')
  assert.equal(katexFont.status, 200)
  assert.match(katexFont.headers.get('content-type') || '', /^font\/woff2/)
})

test('HTTP traversal, malformed keys and unsupported methods are rejected', async () => {
  const traversalPaths = [
    '/zotero/pdfjs/../../etc/passwd',
    '/zotero/pdfjs/%2e%2e/%2e%2e/etc/passwd',
    '/zotero/pdfjs/build/../../etc/passwd',
    '/zotero/pdfjs/..%2f..%2f..%2fetc%2fpasswd',
    '/zotero/pdfjs/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  ]
  for (const pathname of traversalPaths) {
    const response = await rawRequest(pathname)
    assert.equal(response.status, 404, `${pathname} -> ${response.status}`)
    assert.doesNotMatch(response.body, /root:x:0:0/)
  }

  const outsidePrefix = await rawRequest('/etc/passwd')
  assert.equal(outsidePrefix.status, 404)

  for (const key of ['BAD!KEY', '..', '%2e%2e', 'x'.repeat(80)]) {
    const response = await rawRequest(`/zotero/api/item/${key}`)
    assert.ok([400, 404].includes(response.status), `${key} -> ${response.status}`)
    assert.match(response.body, /"error"/)
  }

  const unknown = await request('/zotero/nope')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.error.code, 'not_found')

  const post = await request('/zotero/api/status', { method: 'POST' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')
  assert.equal(post.json.error.code, 'method_not_allowed')

  const badLimit = await request('/zotero/api/items?limit=not-a-number')
  assert.equal(badLimit.status, 200)
  assert.ok(badLimit.json.items.length > 0)

  const badCollection = await request('/zotero/api/items?collection=not%20a%20key')
  assert.equal(badCollection.status, 400)
  assert.equal(badCollection.json.error.code, 'invalid_collection')

  // Lowercase item keys resolve (Zotero stores uppercase keys).
  const lowerKey = await request('/zotero/api/item/wktay774')
  assert.equal(lowerKey.status, 200)
  assert.equal(lowerKey.json.key, 'WKTAY774')

  // Encoded search text is accepted and filters.
  const search = await request('/zotero/api/items?q=rectifiers&limit=2')
  assert.equal(search.status, 200)
  assert.ok(search.json.total >= 1)
  assert.ok(search.json.items.every((item) => /rectifier/i.test(item.title)))

  // Malformed percent-encoding in a key is a JSON 400, never a crash.
  const brokenKey = await rawRequest('/zotero/api/item/%E0%A4%A')
  assert.equal(brokenKey.status, 400)
  assert.match(brokenKey.body, /invalid_item_key/)
})

// ---------------------------------------------------------------------------
// Cordis wiring
// ---------------------------------------------------------------------------

test('cordis apply registers the /zotero prefix route and the model tools', async () => {
  const { name, inject, apply } = await import('../lib/index.js')
  assert.equal(name, 'zotero')
  assert.deepEqual(inject, ['webServer'])

  const routes = []
  const tools = []
  const disposers = []
  const record = (value) => {
    if (Array.isArray(value)) for (const item of value) record(item)
    else if (typeof value === 'function') disposers.push(value)
  }
  const applyCacheDir = path.join(tempCacheDir, 'apply-cordis')
  const ctx = {
    effect(setup) {
      record(setup())
      return () => {}
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['tools'])
      callback({
        effect(setup) {
          record(setup())
          return () => {}
        },
        tools: {
          register(tool) {
            tools.push(tool)
            return () => {}
          },
        },
      })
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx, { dataDir: DATA_DIR, cacheDir: applyCacheDir })

  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/zotero')
  assert.equal(typeof routes[0].handler, 'function')

  assert.equal(tools.length, 2)
  assert.ok(tools.some((tool) => tool.name === 'zotero_search'))
  assert.ok(tools.some((tool) => tool.name === 'zotero_paper'))
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }

  // Exercise the tools through the real data layer (real PDF + pdftotext).
  const search = tools.find((tool) => tool.name === 'zotero_search')
  const searchResult = await search.execute({ query: 'Rectifiers' }, {})
  assert.ok(Array.isArray(searchResult.results))
  assert.ok(searchResult.results.length >= 1)
  assert.ok(searchResult.results.every((result) => isValidKey(result.itemKey)))
  const rendered = search.output.render({ query: 'Rectifiers' }, searchResult)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /Rectifiers/i)

  const paper = tools.find((tool) => tool.name === 'zotero_paper')
  const paperResult = await paper.execute({ itemKey: SAMPLE_ITEM_KEY }, {})
  assert.equal(paperResult.title.length > 0, true)
  assert.ok(paperResult.text.length > 500, `extracted text length=${paperResult.text.length}`)
  assert.match(paperResult.text, /rectifier|imagenet|relu/i)
  const paperRendered = paper.output.render({ itemKey: SAMPLE_ITEM_KEY }, paperResult)
  assert.match(paperRendered[0].text, /pdf|Rectifiers/i)

  const missing = await paper.execute({ itemKey: 'ZZZZZZZZ' }, {}).catch((error) => error)
  assert.ok(missing instanceof Error)

  // Disposal must close the library and not throw.
  for (const dispose of disposers) dispose()
})

test('cordis apply degrades on a minimal context without effect/inject', async () => {
  const { apply } = await import('../lib/index.js')
  const routes = []
  apply(
    { webServer: { register(route) { routes.push(route); return () => {} } } },
    { dataDir: DATA_DIR, cacheDir: path.join(tempCacheDir, 'apply-minimal') },
  )
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/zotero')
})
