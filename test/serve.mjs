#!/usr/bin/env node
/**
 * Standalone verification harness for the Zotero host half.
 *
 * Mounts the exact same `/zotero` router as the cordis plugin on a plain
 * `node:http` server, so the HTTP surface can be exercised without starting a
 * DSH profile:
 *
 *   node test/serve.mjs          # http://127.0.0.1:3301/zotero/api/status
 *
 * Environment overrides: PORT, HOST, ZOTERO_DATA_DIR, ZOTERO_CACHE_DIR,
 * ZOTERO_LOCAL_API. Keep it running as a managed background job during
 * verification; SIGINT/SIGTERM close it cleanly.
 */

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZoteroLibrary } from '../lib/zotero-data.mjs'
import { createRouter } from '../lib/routes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 3301)

const library = new ZoteroLibrary({
  dataDir: process.env.ZOTERO_DATA_DIR || undefined,
  cacheDir: process.env.ZOTERO_CACHE_DIR || undefined,
  localAPI: process.env.ZOTERO_LOCAL_API || undefined,
})

const handler = createRouter({
  library,
  assetsDir: path.join(PACKAGE_ROOT, 'assets'),
  pdfjsDir: path.join(PACKAGE_ROOT, 'vendor', 'node_modules', 'pdfjs-dist'),
  logger: console,
})

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    console.error('[zotero-harness] unhandled handler failure:', error)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { code: 'internal_error', message: 'harness failure' } }))
    } else {
      res.destroy()
    }
  })
})

server.on('error', (error) => {
  console.error(`[zotero-harness] cannot listen on ${HOST}:${PORT}:`, error.message)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`[zotero-harness] listening on http://${HOST}:${PORT}/zotero/api/status`)
  console.log(`[zotero-harness] dataDir=${library.dataDir}`)
})

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[zotero-harness] ${signal}: closing`)
  server.close(() => {
    library.close()
    process.exit(0)
  })
  setTimeout(() => {
    library.close()
    process.exit(0)
  }, 2000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
