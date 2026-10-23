// Unit tests for the Zotero local API write client, against a fake HTTP server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZoteroLocalAPI } from '../lib/local-api.mjs'

async function startServer() {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      if (req.url.startsWith('/api/users/0/items?limit=1')) {
        res.writeHead(200, { 'content-type': 'application/json', 'zotero-server-id': 'SERVER123' })
        res.end('[]')
        return
      }
      if (req.url === '/api/local/authorize' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ key: 'KEY123', remember: true }))
        return
      }
      if (req.url === '/api/users/0/items' && req.method === 'POST') {
        if ((req.headers['zotero-api-key'] || '') !== 'KEY123') {
          res.writeHead(401, { 'content-type': 'text/plain' })
          res.end('bad key')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ successful: { '0': { key: 'ANN00001', version: 1 } } }))
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, requests, baseURL: `http://127.0.0.1:${server.address().port}` }
}

test('authorizes once, caches the key and writes with the server id', async () => {
  const { server, requests, baseURL } = await startServer()
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-local-api-'))
  try {
    const api = new ZoteroLocalAPI({ baseURL, cacheDir, appName: 'DSH Zotero' })
    const created = await api.createItem({ itemType: 'note', parentItem: 'ABCD1234', note: '<p>hi</p>' })
    assert.equal(created.key, 'ANN00001')
    assert.equal(requests.filter((request) => request.url === '/api/local/authorize').length, 1)
    const write = requests.find((request) => request.method === 'POST' && request.url === '/api/users/0/items')
    assert.equal(write.headers['zotero-api-key'], 'KEY123')
    assert.equal(write.headers['zotero-server-id'], 'SERVER123')
    assert.match(write.body, /"itemType":"note"/)
    const cached = JSON.parse(fs.readFileSync(path.join(cacheDir, 'local-api-auth.json'), 'utf8'))
    assert.equal(cached.key, 'KEY123')
    assert.equal(cached.serverId, 'SERVER123')

    // A second write reuses the cached key and does not authorize again.
    await api.createItem({ itemType: 'note', parentItem: 'ABCD1234', note: '<p>again</p>' })
    assert.equal(requests.filter((request) => request.url === '/api/local/authorize').length, 1)
  } finally {
    server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('re-authorizes after a 401 and refreshes the server id after 412', async () => {
  const events = []
  let serverId = 'SERVER-A'
  let writes = 0
  let authorizeCount = 0
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (req.url.startsWith('/api/users/0/items?limit=1')) {
        res.writeHead(200, { 'content-type': 'application/json', 'zotero-server-id': serverId })
        res.end('[]')
        return
      }
      if (req.url === '/api/local/authorize') {
        authorizeCount += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ key: 'KEY-' + authorizeCount, remember: true }))
        return
      }
      if (req.method === 'POST' && req.url === '/api/users/0/items') {
        writes += 1
        events.push(req.headers['zotero-api-key'])
        if (writes === 1) {
          res.writeHead(401, { 'content-type': 'text/plain' })
          res.end('expired')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ successful: { '0': { key: 'NOTE0001', version: 1 } } }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-local-api-'))
  try {
    const api = new ZoteroLocalAPI({ baseURL: `http://127.0.0.1:${server.address().port}`, cacheDir, appName: 'DSH Zotero' })
    const created = await api.createItem({ itemType: 'note', parentItem: 'ABCD1234', note: '<p>x</p>' })
    assert.equal(created.key, 'NOTE0001')
    assert.equal(authorizeCount, 2)
    assert.deepEqual(events, ['KEY-1', 'KEY-2'])
    assert.equal(serverId, 'SERVER-A')
  } finally {
    server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})
