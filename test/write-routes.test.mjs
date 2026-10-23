// Route-level tests for annotation/note writes with a stub local API.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRouter } from '../lib/routes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')

async function start() {
  const calls = []
  const library = {
    async getItem(key) {
      if (key !== 'PAPER001') return null
      return {
        key,
        title: 'Paper',
        pdf: { key: 'ATT00001' },
        attachments: [{ key: 'ATT00001', contentType: 'application/pdf' }],
      }
    },
    async getAnnotations(key) {
      return {
        annotations: [{ key: 'ANN00001', comment: 'old' }],
        notes: [{ key: 'NOTE0001', note: '<p>old</p>' }],
      }
    },
    async refresh() {},
  }
  const localAPI = {
    async createItem(item) { calls.push({ kind: 'createItem', item }); return { key: 'NEW00001', version: 1 } },
    async updateItem(key, patch) { calls.push({ kind: 'updateItem', key, patch }); return { key, version: 2 } },
  }
  const handler = createRouter({
    library,
    assetsDir: path.join(PACKAGE_ROOT, 'assets'),
    pdfjsDir: path.join(PACKAGE_ROOT, 'vendor', 'pdfjs'),
    katexDir: path.join(PACKAGE_ROOT, 'vendor', 'katex'),
    localAPI,
    logger: { error() {} },
  })
  const server = http.createServer((req, res) => { handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, calls, baseURL: `http://127.0.0.1:${server.address().port}` }
}

async function post(baseURL, pathname, body) {
  const response = await fetch(baseURL + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

test('create annotation validates the paper and sends Zotero item JSON', async () => {
  const { server, calls, baseURL } = await start()
  try {
    const result = await post(baseURL, '/zotero/api/annotations', {
      action: 'create',
      itemKey: 'PAPER001',
      attachmentKey: 'ATT00001',
      annotation: {
        text: 'selected text',
        pageIndex: 3,
        pageLabel: '4',
        rects: [[10, 20, 100, 40]],
        color: '#ffd400',
      },
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.equal(calls.length, 1)
    const item = calls[0].item
    assert.equal(item.itemType, 'annotation')
    assert.equal(item.parentItem, 'ATT00001')
    assert.equal(item.annotationType, 'highlight')
    assert.equal(item.annotationText, 'selected text')
    assert.deepEqual(JSON.parse(item.annotationPosition), { pageIndex: 3, rects: [[10, 20, 100, 40]] })
    assert.equal(calls[0].kind, 'createItem')
  } finally { server.close() }
})

test('update annotation comment / note and reject foreign keys', async () => {
  const { server, calls, baseURL } = await start()
  try {
    const annotation = await post(baseURL, '/zotero/api/annotations', {
      action: 'update', itemKey: 'PAPER001', annotationKey: 'ANN00001', comment: 'new comment',
    })
    assert.equal(annotation.status, 200)
    assert.deepEqual(calls[0], { kind: 'updateItem', key: 'ANN00001', patch: { annotationComment: 'new comment' } })

    const note = await post(baseURL, '/zotero/api/notes', {
      action: 'update', itemKey: 'PAPER001', noteKey: 'NOTE0001', note: '<div class="zotero-note znv1"><p>new</p></div>',
    })
    assert.equal(note.status, 200)
    assert.equal(calls[1].kind, 'updateItem')

    const foreign = await post(baseURL, '/zotero/api/annotations', {
      action: 'update', itemKey: 'PAPER001', annotationKey: 'FOREIGN1', comment: 'x',
    })
    assert.equal(foreign.status, 404)
  } finally { server.close() }
})
