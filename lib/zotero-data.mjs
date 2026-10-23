/**
 * Zotero data access layer for the DSH Zotero plugin.
 *
 * Why a SQLite snapshot instead of reading the live library: Zotero desktop
 * keeps `zotero.sqlite` in WAL mode and may hold locks and write continuously
 * while it runs. This plugin only needs read-only metadata, so it copies the
 * database (plus `-wal`/`-shm` siblings) into `~/.cache/dsh-zotero/` and opens
 * the copy with `node:sqlite` (`DatabaseSync`, `readOnly: true`). The cache is
 * refreshed whenever the source files change or the snapshot is older than
 * ~15 s, so a running Zotero never blocks the GUI.
 *
 * Fallback: while Zotero is running it exposes a read-only local HTTP API at
 * `http://127.0.0.1:23119/api/users/0/...`. If the SQLite file is missing or
 * unreadable, the same query helpers answer from that API instead. It is a
 * best-effort fallback only — the plugin loads and lists nothing when neither
 * source is available, reporting `source: 'unavailable'` plus a message.
 *
 * All exported query helpers are pure with respect to the plugin's HTTP layer;
 * `lib/index.js` only performs cordis wiring.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// `node:sqlite` is available (unflagged) on Node >= 22.13 / 23.4 / 24.
// Load it lazily so an older Node still loads the plugin and can fall back to
// Zotero's local API instead of failing the whole profile.
let DatabaseSync = null
let sqliteLoadError = null
try {
  ({ DatabaseSync } = await import('node:sqlite'))
} catch (error) {
  sqliteLoadError = error
}

/** Re-copy the Zotero database when the snapshot is older than this. */
export const SNAPSHOT_REFRESH_MS = 15_000

/** Default Zotero local API origin (only reachable while Zotero runs). */
export const DEFAULT_LOCAL_API = 'http://127.0.0.1:23119'

/** Zotero item/attachment keys are short uppercase alphanumeric strings. */
const KEY_RE = /^[A-Za-z0-9]{1,32}$/

/** Top-level library items are papers; these types are children/metadata. */
const NON_PAPER_TYPES = new Set(['attachment', 'note', 'annotation'])

/** Item types whose `date` field usually carries the publication year. */
const PUBLICATION_FIELDS = [
  'publicationTitle',
  'proceedingsTitle',
  'bookTitle',
  'repository',
  'websiteTitle',
  'blogTitle',
  'forumTitle',
  'encyclopediaTitle',
  'dictionaryTitle',
  'seriesTitle',
]

/** Raised when neither the SQLite snapshot nor the local API is usable. */
export class ZoteroUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ZoteroUnavailableError'
    this.code = 'zotero_unavailable'
  }
}

// ---------------------------------------------------------------------------
// Paths, keys and small helpers
// ---------------------------------------------------------------------------

function expandHome(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

function statOrNull(target) {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

function removeQuiet(target) {
  try {
    fs.unlinkSync(target)
  } catch {
    /* missing is fine */
  }
}

/** True for a syntactically valid Zotero item/attachment key. */
export function isValidKey(key) {
  return typeof key === 'string' && KEY_RE.test(key)
}

/** Default Zotero data directory for this platform. */
export function detectDataDir() {
  const fromEnv = process.env.ZOTERO_DATA_DIR
  if (fromEnv && fromEnv.length > 0) return expandHome(fromEnv)
  return path.join(os.homedir(), 'Zotero')
}

/** Default cache directory holding database snapshots. */
export function defaultCacheDir() {
  return path.join(os.homedir(), '.cache', 'dsh-zotero')
}

/** Deterministic snapshot filename per data directory (avoids collisions). */
export function snapshotFileName(dataDir) {
  const hash = createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 8)
  return `zotero-${hash}.sqlite`
}

/**
 * Cheap change detector for the live database: size + mtime of the main file
 * and its WAL siblings. Zotero writes to `-wal`, so the main file alone is not
 * enough to notice new items.
 */
export function sourceSignature(dataDir) {
  const base = path.join(dataDir, 'zotero.sqlite')
  const parts = []
  for (const suffix of ['', '-wal', '-shm']) {
    const stat = statOrNull(base + suffix)
    parts.push(stat ? `${stat.size}:${Math.round(stat.mtimeMs)}` : '-')
  }
  return parts.join('|')
}

/**
 * Copy the live Zotero database (and WAL siblings when present) to
 * `snapshotPath`. Previous snapshot files are removed first so a stale `-wal`
 * can never be applied to a freshly copied main file.
 *
 * @param {string} dataDir - Zotero data directory.
 * @param {string} snapshotPath - destination `.sqlite` path.
 * @param {{ includeShm?: boolean }} [options] - pass `false` for a retry that
 *   rebuilds shared memory instead of trusting a possibly torn `-shm` copy.
 */
export function copySnapshot(dataDir, snapshotPath, options = {}) {
  const includeShm = options.includeShm !== false
  const source = path.join(dataDir, 'zotero.sqlite')
  const sourceStat = statOrNull(source)
  if (!sourceStat || !sourceStat.isFile()) {
    throw new ZoteroUnavailableError(`Zotero 数据库不存在：${source}`)
  }
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) removeQuiet(snapshotPath + suffix)
  fs.copyFileSync(source, snapshotPath)
  for (const suffix of includeShm ? ['-wal', '-shm'] : ['-wal']) {
    const sibling = source + suffix
    if (fs.existsSync(sibling)) fs.copyFileSync(sibling, snapshotPath + suffix)
  }
  return snapshotPath
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Extract a four-digit year from a Zotero `date` value ("2015-12-00 12/2015"). */
export function extractYear(value) {
  if (value == null) return ''
  const match = /(1[5-9]\d{2}|20\d{2}|21\d{2})/.exec(String(value))
  return match ? match[1] : ''
}

/** Normalize a dateAdded value to Zotero's `YYYY-MM-DD HH:MM:SS` text form. */
export function normalizeDateAdded(value) {
  if (value == null) return ''
  const text = String(value)
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(text)
  if (iso) return `${iso[1]} ${iso[2]}`
  return text
}

function creatorName(creator) {
  const first = (creator.firstName || '').trim()
  const last = (creator.lastName || '').trim()
  if (Number(creator.fieldMode) === 1) return last
  if (first && last) return `${first} ${last}`
  return first || last
}

function pickPublication(fields) {
  for (const name of PUBLICATION_FIELDS) {
    const value = fields[name]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

/** Basename of an attachment path (`storage:<filename>` or linked absolute path). */
export function attachmentFilename(storedPath) {
  if (typeof storedPath !== 'string' || storedPath.length === 0) return ''
  if (storedPath.startsWith('storage:')) return storedPath.slice('storage:'.length)
  return path.basename(storedPath)
}

/**
 * Resolve an `itemAttachments.path` value to an absolute filesystem path.
 * `storage:...` lives under `<dataDir>/storage/<attachmentKey>/...`; plain
 * absolute paths are linked files. Anything else is not resolved.
 */
export function resolveAttachmentPath(dataDir, attachmentKey, storedPath) {
  if (typeof storedPath !== 'string' || storedPath.length === 0) return null
  if (!isValidKey(attachmentKey)) return null
  if (storedPath.startsWith('storage:')) {
    const filename = storedPath.slice('storage:'.length)
    if (filename.length === 0 || filename.includes('\0')) return null
    if (filename.includes('/') || filename.includes('\\')) return null
    if (filename === '.' || filename === '..') return null
    return path.join(dataDir, 'storage', attachmentKey, filename)
  }
  if (path.isAbsolute(storedPath)) return storedPath
  return null
}

/** Find a PDF inside `<dataDir>/storage/<attachmentKey>/` (local API fallback). */
function findStoredPdf(dataDir, attachmentKey, filenameHint) {
  if (!isValidKey(attachmentKey)) return null
  const dir = path.join(dataDir, 'storage', attachmentKey)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  const candidates = []
  if (typeof filenameHint === 'string' && /\.pdf$/i.test(filenameHint) && names.includes(filenameHint)) {
    candidates.push(filenameHint)
  }
  for (const name of names) {
    if (/\.pdf$/i.test(name) && !candidates.includes(name)) candidates.push(name)
  }
  for (const name of candidates) {
    const filePath = path.join(dir, name)
    const stat = statOrNull(filePath)
    if (stat && stat.isFile()) return { filename: name, path: filePath, size: stat.size }
  }
  return null
}

function clampInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

// ---------------------------------------------------------------------------
// SQLite model
// ---------------------------------------------------------------------------

function tableExists(db, name) {
  try {
    const row = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1")
      .get(name)
    return !!row
  } catch {
    return false
  }
}

function fieldsSource(db) {
  return tableExists(db, 'fieldsCombined') ? 'fieldsCombined' : 'fields'
}

/**
 * Collapse the Zotero schema into the plugin's JSON shapes. The whole library
 * is tiny (a few hundred rows), so one materialization per snapshot is simpler
 * and faster than per-request SQL.
 *
 * @param {DatabaseSync} db - read-only snapshot database.
 * @param {string} dataDir - Zotero data directory used for storage resolution.
 * @returns {object} in-memory library model.
 */
export function buildModel(db, dataDir) {
  const allItems = db
    .prepare(
      `SELECT i.itemID, i.key, i.dateAdded, i.libraryID, it.typeName AS itemType
         FROM items i
         JOIN itemTypes it ON it.itemTypeID = i.itemTypeID`,
    )
    .all()
  const metadataById = new Map(allItems.map((row) => [row.itemID, row]))

  const deleted = new Set(db.prepare('SELECT itemID FROM deletedItems').all().map((row) => row.itemID))
  const attachmentRows = db
    .prepare('SELECT itemID, parentItemID, path AS storedPath, contentType FROM itemAttachments')
    .all()
  const attachmentIds = new Set(attachmentRows.map((row) => row.itemID))
  const noteIds = new Set(db.prepare('SELECT itemID FROM itemNotes').all().map((row) => row.itemID))
  const annotationIds = new Set(
    tableExists(db, 'itemAnnotations')
      ? db.prepare('SELECT itemID FROM itemAnnotations').all().map((row) => row.itemID)
      : [],
  )

  const excluded = new Set([...deleted, ...attachmentIds, ...noteIds, ...annotationIds])
  const topRows = allItems.filter(
    (row) => !excluded.has(row.itemID) && !NON_PAPER_TYPES.has(String(row.itemType)),
  )
  const topIds = new Set(topRows.map((row) => row.itemID))

  // Field values for every item (papers and attachments) in one pass.
  const fieldRows = db
    .prepare(
      `SELECT d.itemID, f.fieldName, v.value
         FROM itemData d
         JOIN ${fieldsSource(db)} f ON f.fieldID = d.fieldID
         JOIN itemDataValues v ON v.valueID = d.valueID`,
    )
    .all()
  const fieldsByItem = new Map()
  for (const row of fieldRows) {
    let fields = fieldsByItem.get(row.itemID)
    if (!fields) {
      fields = Object.create(null)
      fieldsByItem.set(row.itemID, fields)
    }
    fields[row.fieldName] = row.value == null ? '' : String(row.value)
  }

  const creatorsByItem = new Map()
  const creatorRows = db
    .prepare(
      `SELECT ic.itemID, c.firstName, c.lastName, c.fieldMode
         FROM itemCreators ic
         JOIN creators c ON c.creatorID = ic.creatorID
        ORDER BY ic.itemID, ic.orderIndex`,
    )
    .all()
  for (const row of creatorRows) {
    let creators = creatorsByItem.get(row.itemID)
    if (!creators) {
      creators = []
      creatorsByItem.set(row.itemID, creators)
    }
    creators.push({
      name: creatorName(row),
      firstName: row.firstName || '',
      lastName: row.lastName || '',
    })
  }

  const tagsByItem = new Map()
  for (const row of db
    .prepare('SELECT it.itemID, t.name FROM itemTags it JOIN tags t ON t.tagID = it.tagID ORDER BY it.itemID, t.name')
    .all()) {
    let tags = tagsByItem.get(row.itemID)
    if (!tags) {
      tags = []
      tagsByItem.set(row.itemID, tags)
    }
    tags.push(String(row.name))
  }

  // Collections plus their top-level item counts.
  const collectionById = new Map()
  for (const row of db
    .prepare(
      'SELECT collectionID, key, collectionName, parentCollectionID FROM collections ORDER BY collectionName, collectionID',
    )
    .all()) {
    collectionById.set(row.collectionID, {
      key: row.key,
      name: row.collectionName,
      parentCollectionID: row.parentCollectionID ?? null,
      count: 0,
    })
  }
  const collectionsByItem = new Map()
  for (const row of db.prepare('SELECT collectionID, itemID FROM collectionItems').all()) {
    const collection = collectionById.get(row.collectionID)
    if (!collection) continue
    if (topIds.has(row.itemID)) collection.count += 1
    let list = collectionsByItem.get(row.itemID)
    if (!list) {
      list = []
      collectionsByItem.set(row.itemID, list)
    }
    list.push({ key: collection.key, name: collection.name })
  }

  // Attachment rows -> readable files. Only PDFs inside a top-level paper are
  // exposed for streaming; every readable attachment is reported in detail.
  const attachmentByItemId = new Map()
  for (const row of attachmentRows) {
    if (deleted.has(row.itemID)) continue
    const meta = metadataById.get(row.itemID)
    if (!meta) continue
    const filename = attachmentFilename(row.storedPath)
    const absolutePath = resolveAttachmentPath(dataDir, meta.key, row.storedPath)
    const fileStat = absolutePath ? statOrNull(absolutePath) : null
    const exists = !!(fileStat && fileStat.isFile())
    const isPdf =
      String(row.contentType || '').toLowerCase() === 'application/pdf' ||
      /\.pdf$/i.test(filename) ||
      (!filename && /\.pdf$/i.test(String(row.storedPath || '')))
    const title = (fieldsByItem.get(row.itemID) || {}).title || filename || '附件'
    attachmentByItemId.set(row.itemID, {
      itemID: row.itemID,
      parentItemID: row.parentItemID ?? null,
      key: meta.key,
      title,
      filename: filename || (exists ? path.basename(absolutePath) : ''),
      contentType: String(row.contentType || ''),
      size: exists ? fileStat.size : 0,
      path: exists ? absolutePath : null,
      exists,
      isPdf,
    })
  }

  const attachmentsByParent = new Map()
  const readableAttachmentByKey = new Map()
  for (const attachment of attachmentByItemId.values()) {
    if (!attachment.exists || !attachment.parentItemID) continue
    let list = attachmentsByParent.get(attachment.parentItemID)
    if (!list) {
      list = []
      attachmentsByParent.set(attachment.parentItemID, list)
    }
    list.push(attachment)
    readableAttachmentByKey.set(attachment.key, attachment)
  }
  for (const list of attachmentsByParent.values()) list.sort((a, b) => a.key.localeCompare(b.key))

  const items = topRows.map((row) => {
    const fields = fieldsByItem.get(row.itemID) || Object.create(null)
    const creators = creatorsByItem.get(row.itemID) || []
    const tags = tagsByItem.get(row.itemID) || []
    const collections = collectionsByItem.get(row.itemID) || []
    const attachments = attachmentsByParent.get(row.itemID) || []
    const pdf = attachments.find((attachment) => attachment.isPdf && attachment.exists) || null
    const title = fields.title || fields.shortTitle || ''
    const date = fields.date || ''
    const publication = pickPublication(fields)
    const year = extractYear(date)
    const doi = fields.DOI || ''
    const abstractNote = fields.abstractNote || ''
    const item = {
      itemID: row.itemID,
      key: row.key,
      title,
      itemType: String(row.itemType),
      creators,
      year,
      date,
      publication,
      doi,
      url: fields.url || '',
      abstractNote,
      dateAdded: normalizeDateAdded(row.dateAdded),
      collections,
      tags,
      attachments,
      pdf,
      hasPDF: !!pdf,
      attachmentKey: pdf ? pdf.key : null,
    }
    item.searchText = [
      item.title,
      ...creators.map((creator) => creator.name),
      publication,
      doi,
      year,
      ...tags,
      abstractNote,
    ]
      .filter((part) => part && String(part).length > 0)
      .join('\n')
      .toLowerCase()
    return item
  })
  items.sort((a, b) => {
    const byTitle = a.title.localeCompare(b.title, 'en', { sensitivity: 'base' })
    if (byTitle !== 0) return byTitle
    if (a.year !== b.year) return String(b.year).localeCompare(String(a.year))
    return a.key.localeCompare(b.key)
  })

  const byKey = new Map(items.map((item) => [item.key, item]))
  const itemCountRow = db.prepare('SELECT COUNT(*) AS count FROM items').get()
  const pdfCount = items.filter((item) => item.hasPDF).length

  // Folder tree: resolve parentCollectionID to the parent's API key and roll
  // direct paper counts up into `totalCount` (a parent includes its children).
  // Cycles in a damaged database terminate instead of recursing forever.
  const keyById = new Map([...collectionById].map(([id, collection]) => [id, collection.key]))
  const collections = [...collectionById.values()].map((collection) => ({
    key: collection.key,
    name: collection.name,
    parentKey: collection.parentCollectionID == null ? null : (keyById.get(collection.parentCollectionID) ?? null),
    count: collection.count,
    totalCount: collection.count,
  }))
  const collectionByKey = new Map(collections.map((collection) => [collection.key, collection]))
  const childrenByParent = new Map()
  const roots = []
  for (const collection of collections) {
    if (collection.parentKey && collectionByKey.has(collection.parentKey)) {
      const siblings = childrenByParent.get(collection.parentKey)
      if (siblings) siblings.push(collection)
      else childrenByParent.set(collection.parentKey, [collection])
    } else {
      roots.push(collection)
    }
  }
  const sumTotals = (collection, seen) => {
    if (seen.has(collection.key)) return collection.count
    seen.add(collection.key)
    let total = collection.count
    for (const child of childrenByParent.get(collection.key) || []) total += sumTotals(child, seen)
    collection.totalCount = total
    return total
  }
  for (const root of roots) sumTotals(root, new Set())
  const unfiledCount = items.filter((item) => item.collections.length === 0).length

  // Native Zotero annotations (on attachments) and notes (child items), grouped
  // by their top-level paper key. Both are ordinary items in Zotero's DB.
  const paperKeyByItemId = new Map(items.map((item) => [item.itemID, item.key]))
  const paperIdByAttachment = new Map()
  for (const attachment of attachmentByItemId.values()) {
    if (attachment.parentItemID) paperIdByAttachment.set(attachment.itemID, attachment.parentItemID)
  }
  const annotationPaperKey = new Map()
  const annotationsByPaperKey = new Map()
  for (const row of db
    .prepare(
      `SELECT a.itemID, a.parentItemID, a.type, a.authorName, a.text, a.comment, a.color,
              a.pageLabel, a.sortIndex, a.position, i.key, i.dateAdded, i.dateModified
         FROM itemAnnotations a JOIN items i ON i.itemID = a.itemID`,
    )
    .all()) {
    const paperItemID = paperIdByAttachment.get(row.parentItemID)
    const paperKey = paperItemID ? paperKeyByItemId.get(paperItemID) : null
    if (!paperKey) continue
    let position = null
    try { position = JSON.parse(row.position) } catch (error) { position = null }
    const annotation = {
      key: row.key,
      type: Number(row.type),
      typeName: ({ 1: 'highlight', 2: 'note', 3: 'image', 4: 'ink', 5: 'underline', 6: 'text' })[Number(row.type)] || 'highlight',
      authorName: row.authorName || '',
      text: row.text || '',
      comment: row.comment || '',
      color: row.color || '',
      pageLabel: row.pageLabel || '',
      sortIndex: row.sortIndex || '',
      position,
      dateAdded: normalizeDateAdded(row.dateAdded),
      dateModified: normalizeDateAdded(row.dateModified),
    }
    annotationPaperKey.set(row.itemID, paperKey)
    let list = annotationsByPaperKey.get(paperKey)
    if (!list) { list = []; annotationsByPaperKey.set(paperKey, list) }
    list.push(annotation)
  }
  for (const list of annotationsByPaperKey.values()) {
    list.sort((a, b) => String(a.sortIndex).localeCompare(String(b.sortIndex)))
  }

  const notesByPaperKey = new Map()
  for (const row of db
    .prepare(
      `SELECT n.itemID, n.parentItemID, n.note, n.title, i.key, i.dateAdded, i.dateModified
         FROM itemNotes n JOIN items i ON i.itemID = n.itemID`,
    )
    .all()) {
    let paperKey = null
    if (row.parentItemID) {
      paperKey = paperKeyByItemId.get(row.parentItemID)
        || (paperIdByAttachment.has(row.parentItemID) ? paperKeyByItemId.get(paperIdByAttachment.get(row.parentItemID)) : null)
        || annotationPaperKey.get(row.parentItemID)
        || null
    }
    if (!paperKey) continue
    const note = {
      key: row.key,
      title: row.title || '',
      note: row.note || '',
      dateAdded: normalizeDateAdded(row.dateAdded),
      dateModified: normalizeDateAdded(row.dateModified),
    }
    let list = notesByPaperKey.get(paperKey)
    if (!list) { list = []; notesByPaperKey.set(paperKey, list) }
    list.push(note)
  }
  for (const list of notesByPaperKey.values()) {
    list.sort((a, b) => String(b.dateModified || '').localeCompare(String(a.dateModified || '')))
  }

  return {
    dataDir,
    items,
    byKey,
    readableAttachmentByKey,
    collections,
    unfiledCount,
    annotationsByPaperKey,
    notesByPaperKey,
    itemCount: Number(itemCountRow?.count || 0),
    paperCount: items.length,
    pdfCount,
    attachmentCount: attachmentRows.length,
    builtAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Local API fallback helpers
// ---------------------------------------------------------------------------

/** Probe whether Zotero is running and its local API answers. Never throws. */
export async function probeLocalApi(localAPI, timeoutMs = 600) {
  if (typeof localAPI !== 'string' || localAPI.length === 0) return false
  try {
    const response = await fetch(`${localAPI.replace(/\/+$/, '')}/api/users/0/items?limit=1&format=json`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

function apiEntryToItem(entry, collectionsByKey) {
  const data = (entry && entry.data) || {}
  const itemType = String(data.itemType || '')
  if (!itemType || NON_PAPER_TYPES.has(itemType)) return null
  const creators = Array.isArray(data.creators)
    ? data.creators.map((creator) => {
        const first = creator.firstName || ''
        const last = creator.lastName || ''
        const name = creator.name || (creator.fieldMode === 1 ? last : [first, last].filter(Boolean).join(' '))
        return { name, firstName: first, lastName: last }
      })
    : []
  const date = data.date || ''
  const year = extractYear(date)
  const publication = [
    data.publicationTitle,
    data.proceedingsTitle,
    data.bookTitle,
    data.repository,
    data.websiteTitle,
    data.blogTitle,
  ].find((value) => typeof value === 'string' && value.trim().length > 0) || ''
  const collections = Array.isArray(data.collections)
    ? data.collections
        .map((key) => collectionsByKey.get(key))
        .filter(Boolean)
        .map((collection) => ({ key: collection.key, name: collection.name }))
    : []
  const tags = Array.isArray(data.tags) ? data.tags.map((tag) => String(tag.tag || tag)).filter(Boolean) : []
  return {
    key: entry.key,
    title: data.title || '',
    itemType,
    creators,
    year,
    date,
    publication: publication.trim(),
    doi: data.DOI || '',
    url: data.url || '',
    abstractNote: data.abstractNote || '',
    dateAdded: normalizeDateAdded(data.dateAdded),
    collections,
    tags,
    attachments: [],
    pdf: null,
    hasPDF: false,
    attachmentKey: null,
  }
}

// ---------------------------------------------------------------------------
// Library facade
// ---------------------------------------------------------------------------

/**
 * Read-only view over one Zotero library: SQLite snapshot first, local HTTP
 * API as a fallback. Instances are cheap; one is shared by the plugin routes.
 */
export class ZoteroLibrary {
  constructor(options = {}) {
    this.dataDir = path.resolve(expandHome(options.dataDir || detectDataDir()))
    this.cacheDir = path.resolve(expandHome(options.cacheDir || defaultCacheDir()))
    this.localAPI = String(options.localAPI || DEFAULT_LOCAL_API).replace(/\/+$/, '')
    this.refreshMs = Number.isFinite(options.refreshMs) ? options.refreshMs : SNAPSHOT_REFRESH_MS
    this.snapshotPath = path.join(this.cacheDir, snapshotFileName(this.dataDir))
    this._db = null
    this._model = null
    this._error = null
    this._signature = null
    this._openedAt = 0
    this._apiCollections = null
    this._apiCollectionsAt = 0
  }

  /** `'zotero-sqlite' | 'local-api' | 'unavailable'` as of the last refresh. */
  get source() {
    return this._db ? 'zotero-sqlite' : 'unavailable'
  }

  /** Last SQLite error, for status/reporting. */
  get error() {
    return this._error
  }

  /** In-memory model of the current snapshot (`null` when unavailable). */
  get model() {
    return this._model
  }

  /** Close the SQLite handle. Idempotent. */
  close() {
    this._closeDb()
  }

  _closeDb() {
    if (this._db) {
      try {
        this._db.close()
      } catch {
        /* already closed */
      }
      this._db = null
    }
    this._model = null
  }

  /**
   * Refresh the snapshot when the source changed or the copy is older than
   * `refreshMs`. Synchronous SQLite work keeps per-request state consistent.
   */
  async ensureFresh() {
    const now = Date.now()
    const signature = sourceSignature(this.dataDir)
    const stale = !this._db || signature !== this._signature || now - this._openedAt > this.refreshMs
    if (stale) this._refresh(signature, now)
  }

  _refresh(signature, now) {
    this._closeDb()
    this._error = null
    if (!DatabaseSync) {
      const reason = sqliteLoadError ? sqliteLoadError.message : 'node:sqlite is unavailable'
      this._error = new Error(`当前 Node 运行时没有可用的 node:sqlite（需要 Node ≥ 22.13 或 24+）：${reason}`)
      return
    }
    let lastError = null
    // First try with -shm copied; a torn shared-memory copy can make SQLite
    // refuse the file, so retry once letting SQLite rebuild it from main+WAL.
    for (const includeShm of [true, false]) {
      try {
        copySnapshot(this.dataDir, this.snapshotPath, { includeShm })
        const db = new DatabaseSync(this.snapshotPath, { readOnly: true })
        try {
          const model = buildModel(db, this.dataDir)
          this._db = db
          this._model = model
          this._signature = signature
          this._openedAt = now
          return
        } catch (error) {
          try {
            db.close()
          } catch {
            /* ignore */
          }
          throw error
        }
      } catch (error) {
        lastError = error
      }
    }
    this._error = lastError
  }

  _unavailableMessage() {
    if (this._error) {
      return `无法读取 Zotero 数据库：${this._error.message}。请打开 Zotero 生成数据库，或检查 dataDir 配置。`
    }
    return `未找到 Zotero 数据库：${path.join(this.dataDir, 'zotero.sqlite')}。请先打开 Zotero，或检查 dataDir 配置。`
  }

  async _ensureOrThrow() {
    await this.ensureFresh()
    if (this._db) return true
    if (await probeLocalApi(this.localAPI)) return false
    throw new ZoteroUnavailableError(this._unavailableMessage())
  }

  // -- status ---------------------------------------------------------------

  async getStatus() {
    await this.ensureFresh()
    const zoteroRunning = await probeLocalApi(this.localAPI)
    if (this._db && this._model) {
      return {
        ok: true,
        source: 'zotero-sqlite',
        dataDir: this.dataDir,
        itemCount: this._model.itemCount,
        pdfCount: this._model.pdfCount,
        zoteroRunning,
        message: null,
        paperCount: this._model.paperCount,
        attachmentCount: this._model.attachmentCount,
        collectionCount: this._model.collections.length,
      }
    }
    if (zoteroRunning) {
      let itemCount = 0
      try {
        itemCount = await this._apiItemCount()
      } catch {
        /* count is advisory only */
      }
      return {
        ok: true,
        source: 'local-api',
        dataDir: this.dataDir,
        itemCount,
        pdfCount: 0,
        zoteroRunning: true,
        message: 'Zotero 数据库暂不可读，已回退到 Zotero 本地 API。',
      }
    }
    return {
      ok: false,
      source: 'unavailable',
      dataDir: this.dataDir,
      itemCount: 0,
      pdfCount: 0,
      zoteroRunning: false,
      message: this._unavailableMessage(),
    }
  }

  // -- list -----------------------------------------------------------------

  async listItems(params = {}) {
    const limit = clampInt(params.limit, 200, 1, 500)
    const offset = clampInt(params.offset, 0, 0, 1_000_000)
    const q = typeof params.q === 'string' ? params.q.trim() : ''
    const collection = typeof params.collection === 'string' ? params.collection.trim() : ''
    const unfiled = params.unfiled === true || params.unfiled === 1 || params.unfiled === '1' || params.unfiled === 'true'
    const useSqlite = await this._ensureOrThrow()
    if (!useSqlite) return this._apiListItems({ q, limit, offset, collection, unfiled })

    let items = this._model.items
    if (unfiled) {
      items = items.filter((item) => item.collections.length === 0)
    } else if (collection) {
      const collectionKey = collection.toUpperCase()
      items = items.filter((item) => item.collections.some((entry) => entry.key.toUpperCase() === collectionKey))
    }
    if (q.length > 0) {
      const needle = q.toLowerCase()
      items = items.filter((item) => item.searchText.includes(needle))
    }
    const total = items.length
    return {
      total,
      items: items.slice(offset, offset + limit).map(publicListItem),
    }
  }

  // -- detail ---------------------------------------------------------------

  async getItem(itemKey) {
    const key = typeof itemKey === 'string' ? itemKey.trim() : ''
    if (!isValidKey(key)) return null
    const useSqlite = await this._ensureOrThrow()
    if (!useSqlite) return this._apiGetItem(key)
    const item = this._model.byKey.get(key) || this._model.byKey.get(key.toUpperCase())
    if (!item) return null
    return publicItemDetail(item)
  }

  // -- annotations / notes --------------------------------------------------

  /**
   * Native annotations (highlights/notes on attachments) and child notes for
   * one paper. Reads the same SQLite snapshot as the rest of the panel.
   * @param {string} itemKey - top-level paper key.
   */
  async getAnnotations(itemKey) {
    const key = typeof itemKey === 'string' ? itemKey.trim() : ''
    if (!isValidKey(key)) return null
    const useSqlite = await this._ensureOrThrow()
    if (!useSqlite) {
      // The local API can read annotations too, but the DB snapshot is the
      // single source used by the panel; without it, report empty lists.
      return { annotations: [], notes: [], source: 'local-api' }
    }
    const item = this._model.byKey.get(key) || this._model.byKey.get(key.toUpperCase())
    if (!item) return null
    const annotations = (this._model.annotationsByPaperKey.get(item.key) || []).map((annotation) => ({ ...annotation }))
    const notes = (this._model.notesByPaperKey.get(item.key) || []).map((note) => ({ ...note }))
    return { annotations, notes, source: 'zotero-sqlite' }
  }

  /** Force the next query to re-copy the Zotero database (after a write). */
  async refresh() {
    this._openedAt = 0
    this._signature = null
    await this.ensureFresh()
  }

  // -- collections ----------------------------------------------------------

  async listCollections() {
    const useSqlite = await this._ensureOrThrow()
    if (!useSqlite) {
      const collections = await this._apiCollections()
      return { collections, unfiledCount: 0 }
    }
    return {
      collections: this._model.collections.map((collection) => ({
        key: collection.key,
        name: collection.name,
        parentKey: collection.parentKey,
        count: collection.count,
        totalCount: collection.totalCount,
      })),
      unfiledCount: this._model.unfiledCount,
    }
  }

  // -- PDF bytes ------------------------------------------------------------

  async readAttachment(attachmentKey) {
    const key = typeof attachmentKey === 'string' ? attachmentKey.trim() : ''
    if (!isValidKey(key)) return null
    const useSqlite = await this._ensureOrThrow()
    if (!useSqlite) return this._apiReadAttachment(key)
    const attachment =
      this._model.readableAttachmentByKey.get(key) ||
      this._model.readableAttachmentByKey.get(key.toUpperCase())
    if (!attachment || !attachment.isPdf || !attachment.path) return null
    const stat = statOrNull(attachment.path)
    if (!stat || !stat.isFile()) return null
    return {
      key: attachment.key,
      title: attachment.title,
      filename: attachment.filename || path.basename(attachment.path),
      path: attachment.path,
      size: stat.size,
      contentType: 'application/pdf',
      parentItemID: attachment.parentItemID,
    }
  }

  // -- local API fallback ---------------------------------------------------

  async _apiFetch(pathAndQuery, timeoutMs = 2500) {
    if (!this.localAPI) throw new ZoteroUnavailableError('Zotero 本地 API 地址未配置。')
    const response = await fetch(this.localAPI + pathAndQuery, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`Zotero 本地 API 返回 HTTP ${response.status}`)
    const data = await response.json()
    const totalHeader = response.headers.get('total-results')
    const total = totalHeader != null && /^\d+$/.test(totalHeader) ? Number(totalHeader) : null
    return { data, total }
  }

  async _apiItemCount() {
    const { data, total } = await this._apiFetch('/api/users/0/items?limit=1&format=json&itemType=-attachment')
    if (total != null) return total
    return Array.isArray(data) ? data.length : 0
  }

  async _apiCollections() {
    if (this._apiCollections && Date.now() - this._apiCollectionsAt < 30_000) return this._apiCollections
    const { data } = await this._apiFetch('/api/users/0/collections?format=json&limit=100')
    const collections = (Array.isArray(data) ? data : []).map((entry) => {
      const parent = entry.data && entry.data.parentCollection
      const count = Number((entry.meta && entry.meta.numItems) || 0)
      return {
        key: entry.key,
        name: (entry.data && entry.data.name) || '',
        parentKey: typeof parent === 'string' ? parent : null,
        count,
        totalCount: count,
      }
    })
    this._apiCollections = collections
    this._apiCollectionsAt = Date.now()
    return collections
  }

  async _apiCollectionsByKey() {
    const collections = await this._apiCollections()
    return new Map(collections.map((collection) => [collection.key, collection]))
  }

  async _apiListItems({ q, limit, offset, collection, unfiled = false }) {
    const query = new URLSearchParams({
      format: 'json',
      limit: String(limit),
      start: String(offset),
      itemType: '-attachment',
    })
    if (q) query.set('q', q)
    const base = collection
      ? `/api/users/0/collections/${encodeURIComponent(collection)}/items`
      : '/api/users/0/items'
    const { data, total } = await this._apiFetch(`${base}?${query.toString()}`)
    const collectionsByKey = await this._apiCollectionsByKey()
    const entries = Array.isArray(data) ? data : []
    const items = entries
      .map((entry) => apiEntryToItem(entry, collectionsByKey))
      .filter(Boolean)
    if (unfiled) {
      const visible = items.filter((item) => item.collections.length === 0)
      return { total: visible.length, items: visible }
    }
    return { total: total != null ? total : items.length, items }
  }

  async _apiGetItem(itemKey) {
    const { data: entry } = await this._apiFetch(`/api/users/0/items/${encodeURIComponent(itemKey)}?format=json`)
    if (!entry || !entry.key) return null
    const collectionsByKey = await this._apiCollectionsByKey()
    const item = apiEntryToItem(entry, collectionsByKey)
    if (!item) return null
    let children = []
    try {
      const result = await this._apiFetch(`/api/users/0/items/${encodeURIComponent(itemKey)}/children?format=json`)
      children = Array.isArray(result.data) ? result.data : []
    } catch {
      children = []
    }
    const attachments = []
    let pdf = null
    for (const child of children) {
      const data = (child && child.data) || {}
      if (data.itemType !== 'attachment') continue
      const resolved = findStoredPdf(this.dataDir, child.key, data.filename || '')
      const filename = resolved ? resolved.filename : data.filename || ''
      attachments.push({
        key: child.key,
        title: data.title || filename || '附件',
        contentType: data.contentType || '',
        size: resolved ? resolved.size : 0,
      })
      const looksPdf = String(data.contentType || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(filename)
      if (!pdf && resolved && looksPdf) {
        pdf = {
          key: child.key,
          filename: resolved.filename,
          path: resolved.path,
          size: resolved.size,
          url: `/zotero/file/${child.key}`,
        }
      }
    }
    item.attachments = attachments
    item.pdf = pdf
    item.hasPDF = !!pdf
    item.attachmentKey = pdf ? pdf.key : null
    return publicItemDetail(item)
  }

  async _apiReadAttachment(attachmentKey) {
    const resolved = findStoredPdf(this.dataDir, attachmentKey)
    if (!resolved) return null
    return {
      key: attachmentKey,
      title: resolved.filename,
      filename: resolved.filename,
      path: resolved.path,
      size: resolved.size,
      contentType: 'application/pdf',
      parentItemID: null,
    }
  }
}

// ---------------------------------------------------------------------------
// Public projections (stable JSON shapes shared with the browser half)
// ---------------------------------------------------------------------------

function publicListItem(item) {
  return {
    key: item.key,
    title: item.title,
    itemType: item.itemType,
    creators: item.creators.map((creator) => ({
      name: creator.name,
      firstName: creator.firstName,
      lastName: creator.lastName,
    })),
    year: item.year,
    date: item.date,
    publication: item.publication,
    doi: item.doi,
    abstractNote: item.abstractNote,
    dateAdded: item.dateAdded,
    collections: item.collections.map((collection) => ({ key: collection.key, name: collection.name })),
    tags: [...item.tags],
    hasPDF: item.hasPDF,
    attachmentKey: item.attachmentKey,
  }
}

function publicItemDetail(item) {
  return {
    key: item.key,
    title: item.title,
    creators: item.creators.map((creator) => ({
      name: creator.name,
      firstName: creator.firstName,
      lastName: creator.lastName,
    })),
    year: item.year,
    itemType: item.itemType,
    publication: item.publication,
    doi: item.doi,
    url: item.url,
    abstractNote: item.abstractNote,
    date: item.date,
    dateAdded: item.dateAdded,
    collections: item.collections.map((collection) => ({ key: collection.key, name: collection.name })),
    tags: [...item.tags],
    pdf: item.pdf
      ? {
          key: item.pdf.key,
          filename: item.pdf.filename,
          path: item.pdf.path,
          size: item.pdf.size,
          url: `/zotero/file/${item.pdf.key}`,
        }
      : null,
    attachments: item.attachments.map((attachment) => ({
      key: attachment.key,
      title: attachment.title,
      contentType: attachment.contentType,
      size: attachment.size,
    })),
  }
}

// ---------------------------------------------------------------------------
// Testable free-function facade (contract §1: openSnapshot/listItems/...)
// ---------------------------------------------------------------------------

/** Open a library handle over a data directory. */
export function openSnapshot(options = {}) {
  return new ZoteroLibrary(options)
}

/** @returns {Promise<object>} status payload for `/zotero/api/status`. */
export async function getStatus(library) {
  return library.getStatus()
}

/** @returns {Promise<{total: number, items: object[]}>} */
export async function listItems(library, params = {}) {
  return library.listItems(params)
}

/** @returns {Promise<object|null>} */
export async function getItem(library, itemKey) {
  return library.getItem(itemKey)
}

/** @returns {Promise<{collections: object[]}>} */
export async function getAnnotations(library, itemKey) {
  return library.getAnnotations(itemKey)
}

export async function refreshLibrary(library) {
  return library.refresh()
}

export async function listCollections(library) {
  return library.listCollections()
}

/** @returns {Promise<object|null>} attachment descriptor when a PDF is readable. */
export async function readAttachment(library, attachmentKey) {
  return library.readAttachment(attachmentKey)
}

/** Close a library handle opened by {@link openSnapshot}. */
export function closeSnapshot(library) {
  library.close()
}
