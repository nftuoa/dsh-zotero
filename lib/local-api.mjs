/**
 * Minimal Zotero local-API client for writes (annotations, notes).
 *
 * Zotero 7.1's local API implements the web API's item endpoints. Reads are
 * unauthenticated; writes need a local API key (Zotero-API-Key), the
 * Zotero-Server-ID header, and `httpServer.localAPI.enabled` in Zotero.
 * The first write asks Zotero to show its authorization dialog via
 * POST /api/local/authorize. "Always Allow" yields a reusable key; "Allow"
 * yields a single-use key, so this client prefers a cached remembered key.
 *
 * The key is cached at `<cacheDir>/local-api-auth.json` (0600). If the cache is
 * missing, a remembered key for this app name is also looked up in Zotero's
 * profile (`<profile>/localAPIKeys.json`), which avoids a modal after a cache
 * reset but never bypasses Zotero's own authorization record.
 *
 * @module @local/dsh-zotero/local-api
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_APP_NAME = 'DSH Zotero'
const API_VERSION = '3'

export class ZoteroLocalAPIError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'ZoteroLocalAPIError'
    this.status = options.status || 0
    this.code = options.code || 'zotero_local_api_error'
  }
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch (error) { /* existing/denied */ }
}

export class ZoteroLocalAPI {
  /**
   * @param {object} options
   * @param {string} options.baseURL - e.g. http://127.0.0.1:23119
   * @param {string} options.cacheDir - plugin cache directory
   * @param {string} [options.appName] - shown in Zotero's authorization dialog
   */
  constructor({ baseURL, cacheDir, appName = DEFAULT_APP_NAME } = {}) {
    this.baseURL = String(baseURL || 'http://127.0.0.1:23119').replace(/\/+$/, '')
    this.cacheDir = cacheDir
    this.appName = appName
    this.authPath = path.join(cacheDir || os.tmpdir(), 'local-api-auth.json')
    this.serverId = null
    this.auth = null
  }

  /** Cached or freshly fetched Zotero-Server-ID (required for writes). */
  async getServerId(force = false) {
    if (this.serverId && !force) return this.serverId
    const response = await fetch(`${this.baseURL}/api/users/0/items?limit=1&format=json`, {
      headers: { accept: 'application/json', 'Zotero-API-Version': API_VERSION },
      signal: AbortSignal.timeout(5000),
    })
    if (response.status === 403) {
      throw new ZoteroLocalAPIError(
        'Zotero 本地 API 未启用：请在 Zotero → 设置 → 高级 中勾选“允许本机其他应用与 Zotero 通信”，然后重试。',
        { status: 403, code: 'local_api_disabled' },
      )
    }
    if (!response.ok) {
      throw new ZoteroLocalAPIError(`Zotero 本地 API 读取失败（HTTP ${response.status}）。`, { status: response.status })
    }
    const id = response.headers.get('zotero-server-id')
    if (!id) throw new ZoteroLocalAPIError('Zotero 未返回 Zotero-Server-ID，无法写入。')
    this.serverId = id
    return id
  }

  loadCachedAuth() {
    try {
      const data = JSON.parse(fs.readFileSync(this.authPath, 'utf8'))
      if (data && typeof data.key === 'string' && data.key) return data
    } catch (error) { /* no cache */ }
    return null
  }

  saveAuth(auth) {
    try {
      ensureDir(this.cacheDir)
      fs.writeFileSync(this.authPath, JSON.stringify(auth, null, 2), { mode: 0o600 })
    } catch (error) { /* cache is optional */ }
  }

  /** Look for a remembered key in Zotero's profile-local authorization file. */
  findProfileKey() {
    try {
      const root = path.join(os.homedir(), '.zotero', 'zotero')
      for (const entry of fs.readdirSync(root)) {
        const file = path.join(root, entry, 'localAPIKeys.json')
        if (!fs.existsSync(file)) continue
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        const keys = Array.isArray(data.keys) ? data.keys : []
        const match = keys.find((item) => item && item.remember && item.appName === this.appName)
        if (match && typeof match.key === 'string') return match
      }
    } catch (error) { /* profile not readable */ }
    return null
  }

  async getAuth() {
    if (this.auth && this.auth.key) return this.auth
    const serverId = await this.getServerId()
    const cached = this.loadCachedAuth()
    if (cached && cached.key && (!cached.serverId || cached.serverId === serverId)) {
      this.auth = cached
      return cached
    }
    const fromProfile = this.findProfileKey()
    if (fromProfile) {
      this.auth = { key: fromProfile.key, serverId, appName: this.appName, remember: true }
      this.saveAuth(this.auth)
      return this.auth
    }
    return this.authorize(serverId)
  }

  async authorize(serverId = null) {
    const response = await fetch(`${this.baseURL}/api/local/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Zotero-API-Version': API_VERSION },
      body: JSON.stringify({ appName: this.appName }),
      // The user has to click Allow/Always Allow in Zotero.
      signal: AbortSignal.timeout(180000),
    })
    const text = await response.text()
    if (response.status === 403) {
      throw new ZoteroLocalAPIError(`Zotero 拒绝了本插件的写入授权。${text ? ' ' + text : ''}`, {
        status: 403,
        code: 'authorization_denied',
      })
    }
    if (response.status === 429) {
      throw new ZoteroLocalAPIError('Zotero 授权请求过于频繁，请稍后重试。', { status: 429, code: 'authorization_rate_limited' })
    }
    if (!response.ok) {
      throw new ZoteroLocalAPIError(`Zotero 授权失败（HTTP ${response.status}）。${text ? ' ' + text.slice(0, 200) : ''}`, { status: response.status })
    }
    let payload = null
    try { payload = JSON.parse(text) } catch (error) { payload = null }
    if (!payload || typeof payload.key !== 'string') {
      throw new ZoteroLocalAPIError('Zotero 授权响应缺少 API key。')
    }
    this.auth = {
      key: payload.key,
      serverId: serverId || (await this.getServerId(true)),
      appName: this.appName,
      remember: !!payload.remember,
      createdAt: new Date().toISOString(),
    }
    this.saveAuth(this.auth)
    return this.auth
  }

  /**
   * One authenticated request. Re-authorizes once on 401 and refreshes the
   * server id once on 428/412.
   */
  async request(method, urlPath, { body, authenticated = true, retry = true } = {}) {
    const headers = { accept: 'application/json', 'Zotero-API-Version': API_VERSION }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (authenticated) {
      const serverId = await this.getServerId()
      const auth = await this.getAuth()
      headers['Zotero-API-Key'] = auth.key
      headers['Zotero-Server-ID'] = serverId
    }
    const response = await fetch(`${this.baseURL}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch (error) { json = null }

    if (authenticated && retry && (response.status === 401 || response.status === 428 || response.status === 412)) {
      if (response.status === 401) {
        this.auth = null
        await this.authorize()
      } else {
        await this.getServerId(true)
      }
      return this.request(method, urlPath, { body, authenticated, retry: false })
    }
    if (!response.ok) {
      const message = (json && (json.message || json.error)) || text.slice(0, 300) || `HTTP ${response.status}`
      throw new ZoteroLocalAPIError(`Zotero 写入失败（HTTP ${response.status}）：${message}`, { status: response.status })
    }
    return { status: response.status, headers: response.headers, json, text }
  }

  /** Read one item JSON (includes `version`, fields, `key`). */
  async getItem(key) {
    const result = await this.request('GET', `/api/users/0/items/${encodeURIComponent(key)}?format=json`, {
      authenticated: false,
    })
    return result.json
  }

  /** Create one item; returns the created item JSON. */
  async createItem(item) {
    const result = await this.request('POST', '/api/users/0/items', { body: [item] })
    const payload = result.json || {}
    const success = payload.successful && (payload.successful['0'] || payload.successful[0])
    if (success) return success
    const failure = payload.failed && (payload.failed['0'] || payload.failed[0])
    const message = failure && (failure.message || failure.code) || 'Zotero 没有确认创建结果'
    throw new ZoteroLocalAPIError(`Zotero 创建失败：${message}`)
  }

  /** Merge-patch one existing item (version-fenced array write). */
  async updateItem(key, patch) {
    const current = await this.getItem(key)
    if (!current || current.key !== key) throw new ZoteroLocalAPIError(`Zotero 条目不存在：${key}`)
    const body = [{ ...patch, key, version: current.version }]
    const result = await this.request('POST', '/api/users/0/items', { body })
    const payload = result.json || {}
    const success = payload.successful && (payload.successful['0'] || payload.successful[0])
    if (success) return success
    const failure = payload.failed && (payload.failed['0'] || payload.failed[0])
    const message = failure && (failure.message || failure.code) || 'Zotero 没有确认更新结果'
    throw new ZoteroLocalAPIError(`Zotero 更新失败：${message}`)
  }
}
