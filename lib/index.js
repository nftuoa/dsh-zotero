/**
 * DSH Zotero plugin — host half (cordis/Node).
 *
 * The browser half (`lib/client.js`) renders the library sidebar/panel and the
 * same-origin PDF.js reader; this half owns the data. It registers one prefix
 * route `/zotero` on `ctx.webServer` and serves:
 *
 *   /zotero/api/status|items|item/:key|collections   — library JSON
 *   /zotero/file/:attachmentKey                      — PDF bytes (HEAD/Range)
 *   /zotero/viewer.html|viewer.js                    — the plugin's PDF viewer
 *   /zotero/pdfjs/*                                  — vendored pdf.js assets
 *
 * Zotero's database is read through a cache snapshot because Zotero keeps it
 * locked in WAL mode while running (see `lib/zotero-data.mjs` for the full
 * rationale and the local-API fallback). `apply` only wires things; all logic
 * lives in the helper modules and is unit-tested in `test/host.test.mjs`.
 *
 * Configuration (from `cordis.patch.yml`):
 *   dataDir  — Zotero data directory (default: `~/Zotero` or $ZOTERO_DATA_DIR)
 *   localAPI — Zotero local API origin (default: http://127.0.0.1:23119)
 *   cacheDir — snapshot cache dir (default: ~/.cache/dsh-zotero)
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZoteroLibrary } from './zotero-data.mjs'
import { createRouter } from './routes.mjs'
import { createZoteroTools } from './tools.mjs'
import { ZoteroLocalAPI } from './local-api.mjs'

export const name = 'zotero'
export const inject = ['webServer']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')

/** Pick only the string config values this plugin understands. */
function normalizeConfig(config) {
  const source = config && typeof config === 'object' ? config : {}
  const pick = (key) => (typeof source[key] === 'string' && source[key].trim().length > 0 ? source[key].trim() : undefined)
  return {
    dataDir: pick('dataDir'),
    localAPI: pick('localAPI'),
    cacheDir: pick('cacheDir'),
  }
}

/**
 * Run a setup function as a cordis effect when the context supports it, so the
 * registered route/tools are disposed with the plugin. Falls back to a plain
 * call for minimal/mocked contexts.
 */
function runEffect(context, setup) {
  if (context && typeof context.effect === 'function') return context.effect(setup)
  return setup()
}

/**
 * Cordis plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - plugin config from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config)
  const library = new ZoteroLibrary(options)
  const assetsDir = path.join(PACKAGE_ROOT, 'assets')
  const pdfjsDir = path.join(PACKAGE_ROOT, 'vendor', 'pdfjs')
  const katexDir = path.join(PACKAGE_ROOT, 'vendor', 'katex')
  const localAPI = new ZoteroLocalAPI({ baseURL: library.localAPI, cacheDir: library.cacheDir })
  const handler = createRouter({ library, assetsDir, pdfjsDir, katexDir, localAPI, logger: console })

  runEffect(ctx, () => {
    const removeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: '/zotero',
      handler,
    })
    return () => {
      try {
        if (typeof removeRoute === 'function') removeRoute()
      } finally {
        library.close()
      }
    }
  })

  // Optional: expose the library to the model as tools. Profiles without a
  // tool registry simply never run this callback.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolCtx) => {
      runEffect(toolCtx, () => createZoteroTools({ library }).map((tool) => toolCtx.tools.register(tool)))
    })
  }
}
