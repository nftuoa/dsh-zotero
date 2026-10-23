/**
 * HTTP surface for the DSH Zotero plugin — everything under `/zotero`.
 *
 * The router is transport-agnostic: `lib/index.js` mounts it on the cordis
 * `webServer` prefix route, and `test/serve.mjs` mounts the same function on a
 * plain `node:http` server for standalone verification. The handler always owns
 * the response and never throws: unexpected failures become JSON 5xx errors.
 *
 * Routes (contract §1):
 *   GET  /zotero/api/status
 *   GET  /zotero/api/items?q=&limit=&offset=&collection=&unfiled=
 *   GET  /zotero/api/item/:itemKey
 *   GET  /zotero/api/collections
 *   GET  /zotero/file/:attachmentKey          (PDF, HEAD + Range)
 *   GET  /zotero/viewer.html, /zotero/viewer.js
 *   GET  /zotero/pdfjs/*                       (vendored pdf.js, immutable)
 */

import fs from 'node:fs'
import path from 'node:path'
import { ZoteroUnavailableError, isValidKey } from './zotero-data.mjs'
import { ZoteroLocalAPIError } from './local-api.mjs'

const ROUTE_PREFIX = '/zotero'

/** Extension → Content-Type map for assets and the vendored pdf.js tree. */
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.icc': 'application/vnd.iccprofile',
  '.pdf': 'application/pdf',
})

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
})

const STATIC_COMMON_HEADERS = Object.freeze({ 'x-content-type-options': 'nosniff' })

const PDF_HEADERS = Object.freeze({
  'content-type': 'application/pdf',
  'cache-control': 'private, max-age=0, must-revalidate',
  'x-content-type-options': 'nosniff',
})

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
const VIEWER_CACHE = 'no-cache'

/** Content-Type for a file path, defaulting to octet-stream. */
export function mimeTypeFor(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

/**
 * Resolve a URL-relative path below `rootDir`, rejecting traversal. Both raw
 * and percent-encoded `.`/`..` segments, encoded separators, NUL bytes, and
 * symlink-free escape paths are refused.
 *
 * @param {string} rootDir - directory that bounds the read.
 * @param {string} relativePath - slash-separated path from the URL (may be
 *   percent-encoded).
 * @returns {string|null} absolute path, or null when unsafe/empty.
 */
export function resolveStaticPath(rootDir, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null
  if (relativePath.includes('\0')) return null
  const segments = relativePath.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return null
  const decoded = []
  for (const segment of segments) {
    let value
    try {
      value = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (value.length === 0) return null
    if (value === '.' || value === '..') return null
    if (value.includes('/') || value.includes('\\') || value.includes('\0')) return null
    decoded.push(value)
  }
  const resolvedRoot = path.resolve(rootDir)
  const target = path.resolve(resolvedRoot, ...decoded)
  const relative = path.relative(resolvedRoot, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  // Defense in depth: never follow a symlink out of the root directory.
  try {
    const realRoot = fs.realpathSync(resolvedRoot)
    const realTarget = fs.realpathSync(target)
    const realRelative = path.relative(realRoot, realTarget)
    if (realRelative === '' || realRelative.startsWith('..') || path.isAbsolute(realRelative)) return null
  } catch {
    // Missing target is reported by the caller as 404; the lexical check above
    // already proves it stays inside the root.
  }
  return target
}

/**
 * Parse a single-range `Range: bytes=...` header.
 *
 * @param {string|undefined} header - raw Range header.
 * @param {number} size - total resource length in bytes.
 * @returns {{start: number, end: number}|{unsatisfiable: true}|undefined} an
 *   inclusive range, an unsatisfiable marker (HTTP 416), or `undefined` when
 *   the header is absent/unsupported and the full representation should be
 *   served (RFC 9110 allows ignoring malformed or multi-range requests).
 */
export function parseRange(header, size) {
  if (typeof header !== 'string' || header.length === 0) return undefined
  if (!Number.isFinite(size) || size < 0) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return undefined
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return undefined
  if (size === 0) return { unsatisfiable: true }
  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { unsatisfiable: true }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    if (!Number.isSafeInteger(start) || start < 0) return undefined
    if (start >= size) return { unsatisfiable: true }
    if (rawEnd === '') {
      end = size - 1
    } else {
      end = Number(rawEnd)
      if (!Number.isSafeInteger(end) || end < start) return { unsatisfiable: true }
      end = Math.min(end, size - 1)
    }
  }
  return { start, end }
}

/**
 * Build an RFC 5987 `content-disposition` value for an inline PDF. ASCII
 * filename fallback for old clients plus the UTF-8 filename* form.
 */
export function contentDisposition(filename) {
  const name = typeof filename === 'string' && filename.length > 0 ? filename : 'document.pdf'
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 120)
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    ...JSON_HEADERS,
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  })
  res.end(text)
}

function sendError(res, status, code, message, extraHeaders = {}) {
  sendJson(res, status, { error: { code, message } }, extraHeaders)
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/**
 * Stream a file with HEAD and single-Range support. `headers` are the
 * cache/content headers that identify the resource; length headers are owned
 * here so they always agree with the bytes on disk.
 */
function serveFile(req, res, { filePath, headers }) {
  const stat = (() => {
    try {
      return fs.statSync(filePath)
    } catch {
      return null
    }
  })()
  if (!stat || !stat.isFile()) {
    return sendError(res, 404, 'not_found', '请求的文件不存在。')
  }
  const total = stat.size
  const baseHeaders = { ...STATIC_COMMON_HEADERS, 'accept-ranges': 'bytes', ...headers }
  const range = parseRange(req.headers.range, total)

  if (range && range.unsatisfiable) {
    res.writeHead(416, {
      ...baseHeaders,
      'content-range': `bytes */${total}`,
      'content-length': 0,
    })
    return res.end()
  }
  if (range) {
    const length = range.end - range.start + 1
    res.writeHead(206, {
      ...baseHeaders,
      'content-range': `bytes ${range.start}-${range.end}/${total}`,
      'content-length': length,
    })
    if (req.method === 'HEAD') return res.end()
    return streamBody(req, res, filePath, { start: range.start, end: range.end })
  }
  res.writeHead(200, {
    ...baseHeaders,
    'content-length': total,
  })
  if (req.method === 'HEAD') return res.end()
  return streamBody(req, res, filePath, undefined)
}

function streamBody(req, res, filePath, range) {
  const stream = fs.createReadStream(filePath, range)
  stream.on('error', (error) => {
    if (!res.headersSent) {
      sendError(res, 500, 'read_error', '读取文件失败。')
    } else {
      res.destroy(error)
    }
  })
  // Client aborted (seek/refresh): stop reading the file promptly.
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the `/zotero` request handler.
 *
 * @param {object} options
 * @param {import('./zotero-data.mjs').ZoteroLibrary} options.library - data facade.
 * @param {string} options.assetsDir - plugin `assets/` directory (viewer files).
 * @param {string} options.pdfjsDir - vendored `pdfjs-dist` directory.
 * @param {{error?: Function, warn?: Function}} [options.logger] - console-like sink.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRouter({ library, assetsDir, pdfjsDir, katexDir, localAPI, logger = console }) {
  const log = logger || {}

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  return async function zoteroHandler(req, res) {
    try {
      await dispatch(req, res)
    } catch (error) {
      if (res.headersSent) {
        try {
          res.destroy()
        } catch {
          /* socket already gone */
        }
        return
      }
      if (error instanceof ZoteroUnavailableError) {
        sendError(res, 503, 'zotero_unavailable', error.message)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      if (typeof log.error === 'function') log.error('[zotero] request failed:', message)
      sendError(res, 500, 'internal_error', 'Zotero 服务内部错误。')
    }

    async function dispatch(request, response) {
      const method = String(request.method || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
        sendError(response, 405, 'method_not_allowed', `不支持的方法：${method}`, { allow: 'GET, HEAD, POST' })
        return
      }

      let url
      try {
        url = new URL(request.url || '/', 'http://127.0.0.1')
      } catch {
        sendError(response, 400, 'invalid_request', '无法解析请求 URL。')
        return
      }

      const pathname = url.pathname
      if (!pathname.startsWith(ROUTE_PREFIX)) {
        // Also covers lexical traversal normalized out of the prefix by URL.
        sendError(response, 404, 'not_found', '未知的 Zotero 路由。')
        return
      }

      const rest = pathname.slice(ROUTE_PREFIX.length)
      const segments = rest.split('/').filter((segment) => segment.length > 0)

      if (segments.length === 0) {
        sendError(response, 404, 'not_found', '未知的 Zotero 路由。')
        return
      }

      if (method === 'POST' && !(segments[0] === 'api' && (segments[1] === 'annotations' || segments[1] === 'notes'))) {
        sendError(response, 405, 'method_not_allowed', `不支持的方法：${method}`, { allow: 'GET, HEAD' })
        return
      }

      if (segments[0] === 'api') {
        await handleApi(segments.slice(1), url.searchParams, request, response, method)
        return
      }

      if (segments[0] === 'file') {
        if (segments.length !== 2) {
          sendError(response, 404, 'not_found', '未知的 Zotero 路由。')
          return
        }
        const key = decodeSegment(segments[1])
        if (!key || !isValidKey(key)) {
          sendError(response, 400, 'invalid_attachment_key', '附件 key 格式无效。')
          return
        }
        const attachment = await library.readAttachment(key)
        if (!attachment) {
          sendError(response, 404, 'attachment_not_found', '附件不存在或没有可读取的 PDF。')
          return
        }
        serveFile(request, response, {
          filePath: attachment.path,
          headers: {
            ...PDF_HEADERS,
            'content-disposition': contentDisposition(attachment.filename),
          },
        })
        return
      }

      if (
        segments.length === 1 &&
        (segments[0] === 'viewer.html' ||
          segments[0] === 'viewer.js' ||
          segments[0] === 'pdf.worker.polyfill.mjs')
      ) {
        const fileName = segments[0]
        const filePath = path.join(assetsDir, fileName)
        serveFile(request, response, {
          filePath,
          headers: {
            'content-type': mimeTypeFor(filePath),
            'cache-control': VIEWER_CACHE,
          },
        })
        return
      }

      if (segments[0] === 'pdfjs' && segments.length >= 2) {
        const relativePath = segments.slice(1).join('/')
        const filePath = resolveStaticPath(pdfjsDir, relativePath)
        if (!filePath) {
          sendError(response, 404, 'not_found', 'pdf.js 资源不存在。')
          return
        }
        serveFile(request, response, {
          filePath,
          headers: {
            'content-type': mimeTypeFor(filePath),
            'cache-control': IMMUTABLE_CACHE,
          },
        })
        return
      }

      if (segments[0] === 'katex' && segments.length >= 2 && katexDir) {
        const relativePath = segments.slice(1).join('/')
        const filePath = resolveStaticPath(katexDir, relativePath)
        if (!filePath) {
          sendError(response, 404, 'not_found', 'KaTeX 资源不存在。')
          return
        }
        serveFile(request, response, {
          filePath,
          headers: {
            'content-type': mimeTypeFor(filePath),
            'cache-control': IMMUTABLE_CACHE,
          },
        })
        return
      }

      sendError(response, 404, 'not_found', '未知的 Zotero 路由。')
    }

    async function handleApi(segments, searchParams, request, response, method = 'GET') {
      const route = segments[0]
      const sub = segments.slice(1)

      if (route === 'status' && sub.length === 0) {
        const status = await library.getStatus()
        sendJson(response, 200, status)
        return
      }

      if (route === 'items' && sub.length === 0) {
        const q = (searchParams.get('q') || '').slice(0, 500)
        const limit = searchParams.get('limit')
        const offset = searchParams.get('offset')
        const collection = (searchParams.get('collection') || '').trim()
        const unfiledRaw = (searchParams.get('unfiled') || '').trim().toLowerCase()
        const unfiled = unfiledRaw === '1' || unfiledRaw === 'true'
        if (collection && !isValidKey(collection)) {
          sendError(response, 400, 'invalid_collection', 'collection key 格式无效。')
          return
        }
        if (unfiled && collection) {
          sendError(response, 400, 'invalid_filter', 'collection 与 unfiled 不能同时使用。')
          return
        }
        const result = await library.listItems({
          q,
          limit: limit == null || limit === '' ? 200 : Number.parseInt(limit, 10),
          offset: offset == null || offset === '' ? 0 : Number.parseInt(offset, 10),
          collection,
          unfiled,
        })
        sendJson(response, 200, result)
        return
      }

      if (route === 'collections' && sub.length === 0) {
        const result = await library.listCollections()
        sendJson(response, 200, result)
        return
      }

      if (route === 'annotations' && sub.length === 1 && method === 'GET') {
        const key = decodeSegment(sub[0])
        if (!key || !isValidKey(key)) {
          sendError(response, 400, 'invalid_item_key', '条目 key 格式无效。')
          return
        }
        const value = await library.getAnnotations(key)
        if (!value) {
          sendError(response, 404, 'item_not_found', '未找到该 Zotero 条目。')
          return
        }
        let writable = false
        if (localAPI) {
          try {
            await localAPI.getServerId()
            writable = true
          } catch (error) {
            writable = false
          }
        }
        sendJson(response, 200, { ...value, writable })
        return
      }

      if (route === 'annotations' && sub.length === 0 && method === 'POST') {
        await handleAnnotationWrite(request, response)
        return
      }

      if (route === 'notes' && sub.length === 0 && method === 'POST') {
        await handleNoteWrite(request, response)
        return
      }

      if (route === 'item' && sub.length === 1) {
        const key = decodeSegment(sub[0])
        if (!key || !isValidKey(key)) {
          sendError(response, 400, 'invalid_item_key', '条目 key 格式无效。')
          return
        }
        const item = await library.getItem(key)
        if (!item) {
          sendError(response, 404, 'item_not_found', '未找到该 Zotero 条目。')
          return
        }
        sendJson(response, 200, item)
        return
      }

      sendError(response, 404, 'not_found', '未知的 Zotero API 路由。')
    }

    async function readJsonBody(request, limit = 512 * 1024) {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > limit) throw new Error('请求体过大。')
        chunks.push(chunk)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return {}
      try {
        return JSON.parse(text)
      } catch {
        throw new Error('请求体不是合法 JSON。')
      }
    }

    function writeFailure(response, error) {
      if (error instanceof ZoteroLocalAPIError) {
        sendError(response, error.status === 403 ? 403 : 502, error.code || 'zotero_write_failed', error.message)
        return
      }
      sendError(response, 502, 'zotero_write_failed', error && error.message ? error.message : String(error))
    }

    async function handleAnnotationWrite(request, response) {
      if (!localAPI) {
        sendError(response, 503, 'zotero_not_running', '写入 Zotero 需要 Zotero 正在运行并启用本地 API。')
        return
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendError(response, 400, 'invalid_body', error.message)
        return
      }
      const action = body.action === 'update' ? 'update' : body.action === 'create' ? 'create' : null
      const itemKey = typeof body.itemKey === 'string' ? body.itemKey.trim() : ''
      if (!action || !isValidKey(itemKey)) {
        sendError(response, 400, 'invalid_request', 'action 和 itemKey 是必填项。')
        return
      }
      try {
        if (action === 'update') {
          const annotationKey = typeof body.annotationKey === 'string' ? body.annotationKey.trim() : ''
          if (!isValidKey(annotationKey)) {
            sendError(response, 400, 'invalid_annotation_key', 'annotationKey 格式无效。')
            return
          }
          const existing = await library.getAnnotations(itemKey)
          if (!existing || !existing.annotations.some((annotation) => annotation.key === annotationKey)) {
            sendError(response, 404, 'annotation_not_found', '未找到该标注。')
            return
          }
          const patch = {}
          if (typeof body.comment === 'string') patch.annotationComment = body.comment.slice(0, 5000)
          if (typeof body.color === 'string') {
            if (!/^#[0-9a-f]{6}$/i.test(body.color)) {
              sendError(response, 400, 'invalid_color', '颜色必须是 #RRGGBB。')
              return
            }
            patch.annotationColor = body.color
          }
          if (Object.keys(patch).length === 0) {
            sendError(response, 400, 'empty_patch', '没有需要更新的字段。')
            return
          }
          const updated = await localAPI.updateItem(annotationKey, patch)
          await library.refresh()
          sendJson(response, 200, { ok: true, annotation: updated })
          return
        }

        const detail = await library.getItem(itemKey)
        if (!detail) {
          sendError(response, 404, 'item_not_found', '未找到该 Zotero 条目。')
          return
        }
        const attachmentKey = typeof body.attachmentKey === 'string' ? body.attachmentKey.trim() : (detail.pdf && detail.pdf.key)
        if (!attachmentKey || !isValidKey(attachmentKey)) {
          sendError(response, 400, 'missing_attachment', '该文献没有可写入的 PDF 附件。')
          return
        }
        if (!detail.attachments.some((attachment) => attachment.key === attachmentKey)) {
          sendError(response, 400, 'invalid_attachment', '附件不属于该文献。')
          return
        }
        const annotation = body.annotation || {}
        const text = typeof annotation.text === 'string' ? annotation.text.trim().slice(0, 20000) : ''
        if (!text) {
          sendError(response, 400, 'empty_selection', '框选内容为空。')
          return
        }
        const pageIndex = Number.isInteger(annotation.pageIndex) ? annotation.pageIndex : 0
        const pageLabel = typeof annotation.pageLabel === 'string' ? annotation.pageLabel.slice(0, 50) : String(pageIndex + 1)
        const rects = Array.isArray(annotation.rects) ? annotation.rects.slice(0, 500) : []
        const normalizedRects = rects
          .map((rect) => Array.isArray(rect) ? rect.slice(0, 4).map(Number) : null)
          .filter((rect) => rect && rect.length === 4 && rect.every((value) => Number.isFinite(value)))
        if (normalizedRects.length === 0) {
          sendError(response, 400, 'missing_rects', '缺少有效的框选位置。')
          return
        }
        const color = typeof annotation.color === 'string' && /^#[0-9a-f]{6}$/i.test(annotation.color)
          ? annotation.color
          : '#ffd400'
        const sortIndex = typeof annotation.sortIndex === 'string'
          ? annotation.sortIndex.slice(0, 50)
          : String(pageIndex + 1).padStart(5, '0') + '|' + String(Math.round(normalizedRects[0][3] * 1000)).padStart(8, '0')
        const created = await localAPI.createItem({
          itemType: 'annotation',
          parentItem: attachmentKey,
          annotationType: 'highlight',
          annotationText: text,
          annotationComment: typeof annotation.comment === 'string' ? annotation.comment.slice(0, 5000) : '',
          annotationColor: color,
          annotationPageLabel: pageLabel,
          annotationSortIndex: sortIndex,
          annotationPosition: JSON.stringify({ pageIndex, rects: normalizedRects }),
        })
        await library.refresh()
        sendJson(response, 200, { ok: true, annotation: created })
      } catch (error) {
        writeFailure(response, error)
      }
    }

    async function handleNoteWrite(request, response) {
      if (!localAPI) {
        sendError(response, 503, 'zotero_not_running', '写入 Zotero 需要 Zotero 正在运行并启用本地 API。')
        return
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendError(response, 400, 'invalid_body', error.message)
        return
      }
      const action = body.action === 'update' ? 'update' : body.action === 'create' ? 'create' : null
      const itemKey = typeof body.itemKey === 'string' ? body.itemKey.trim() : ''
      if (!action || !isValidKey(itemKey)) {
        sendError(response, 400, 'invalid_request', 'action 和 itemKey 是必填项。')
        return
      }
      const note = typeof body.note === 'string' ? body.note.slice(0, 300000) : ''
      if (!note.trim()) {
        sendError(response, 400, 'empty_note', '笔记内容为空。')
        return
      }
      try {
        if (action === 'update') {
          const noteKey = typeof body.noteKey === 'string' ? body.noteKey.trim() : ''
          if (!isValidKey(noteKey)) {
            sendError(response, 400, 'invalid_note_key', 'noteKey 格式无效。')
            return
          }
          const existing = await library.getAnnotations(itemKey)
          if (!existing || !existing.notes.some((row) => row.key === noteKey)) {
            sendError(response, 404, 'note_not_found', '未找到该笔记。')
            return
          }
          const updated = await localAPI.updateItem(noteKey, { note })
          await library.refresh()
          sendJson(response, 200, { ok: true, note: updated })
          return
        }
        const created = await localAPI.createItem({
          itemType: 'note',
          parentItem: itemKey,
          note,
        })
        await library.refresh()
        sendJson(response, 200, { ok: true, note: created })
      } catch (error) {
        writeFailure(response, error)
      }
    }
  }
}
