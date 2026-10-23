// Offline smoke test for the browser half of @local/dsh-zotero.
//
// It reproduces the lazy-CJS module contract without the DSH shell:
//   * fake `window.__ModuleLoader__`, `document` and `localStorage`;
//   * the real factory from lib/client.js is executed and its exports checked;
//   * `apply()` is run against a mock slots context (services must stay lazy);
//   * the main panel is server-rendered with react-dom/server and stubbed
//     fetch, so a broken component tree fails here instead of in the browser;
//   * pure helpers (prompt template, authors, page lookup) are asserted.
//
// Run: node client-test/smoke.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const localRequire = createRequire(path.join(here, 'package.json'))
const react = localRequire('react')
const { renderToStaticMarkup } = localRequire('react-dom/server')

let checks = 0
function check(label, fn) {
  fn()
  checks += 1
  console.log('  ✓ ' + label)
}

// ---------------------------------------------------------------------------
// Fake DOM: just enough for style injection + SSR initial render
// ---------------------------------------------------------------------------

function createElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    id: '',
    className: '',
    textContent: '',
    style: {},
    children: [],
    attributes: Object.create(null),
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    },
    removeChild(child) {
      const index = this.children.indexOf(child)
      if (index !== -1) this.children.splice(index, 1)
      return child
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null
    },
    hasAttribute(name) {
      return name in this.attributes
    },
    querySelector() {
      return null
    },
    addEventListener() {},
    removeEventListener() {},
  }
  return element
}

const documentStub = {
  head: createElement('head'),
  body: createElement('body'),
  documentElement: createElement('html'),
  createElement: createElement,
  getElementById(id) {
    const walk = (node) => {
      if (!node) return null
      if (node.id === id) return node
      for (const child of node.children) {
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    return walk(this.head) || walk(this.body)
  },
  querySelector() {
    return null
  },
}

const storage = new Map()
const localStorageStub = {
  getItem(key) {
    return storage.has(String(key)) ? storage.get(String(key)) : null
  },
  setItem(key, value) {
    storage.set(String(key), String(value))
  },
  removeItem(key) {
    storage.delete(String(key))
  },
}

let registration = null
const windowStub = {
  __ModuleLoader__: {
    load(entry) {
      registration = entry
    },
  },
  localStorage: localStorageStub,
  addEventListener() {},
  removeEventListener() {},
}

// Stubbed host: the panel's initial render must not need it, but any accidental
// render-time fetch would 404 here instead of hitting a real network.
const fetchCalls = []
function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload
    },
  }
}
const fetchStub = async (url) => {
  fetchCalls.push(String(url))
  const target = String(url)
  if (target.includes('/zotero/api/status')) {
    return jsonResponse({
      ok: true,
      source: 'zotero-sqlite',
      dataDir: '/home/user/Zotero',
      itemCount: 2,
      pdfCount: 1,
      zoteroRunning: false,
      message: null,
    })
  }
  if (target.includes('/zotero/api/collections')) {
    return jsonResponse({ collections: [{ key: 'COLL0001', name: 'Deep Learning', count: 2 }] })
  }
  if (target.includes('/zotero/api/items')) {
    return jsonResponse({ total: 2, items: sampleItems() })
  }
  if (target.includes('/zotero/api/item/')) {
    return jsonResponse(sampleDetail())
  }
  return {
    ok: false,
    status: 404,
    async json() {
      return { error: { code: 'not_found', message: 'not found' } }
    },
  }
}

function sampleItems() {
  return [
    {
      key: 'ITEM0001',
      title: 'Delving Deep into Rectifiers: Surpassing Human-Level Performance',
      itemType: 'journalArticle',
      creators: [
        { firstName: 'Kaiming', lastName: 'He' },
        { firstName: 'Xiangyu', lastName: 'Zhang' },
        { firstName: 'Shaoqing', lastName: 'Ren' },
        { firstName: 'Jian', lastName: 'Sun' },
      ],
      year: '2015',
      publication: 'arXiv',
      hasPDF: true,
      attachmentKey: 'JF3BKJPS',
    },
    {
      key: 'ITEM0002',
      title: 'Attention Is All You Need',
      itemType: 'conferencePaper',
      creators: [
        { firstName: 'Ashish', lastName: 'Vaswani' },
        { firstName: 'Noam', lastName: 'Shazeer' },
      ],
      year: '2017',
      publication: 'NeurIPS',
      hasPDF: false,
      attachmentKey: null,
    },
  ]
}

function sampleDetail() {
  const item = sampleItems()[0]
  return Object.assign({}, item, {
    doi: '10.1109/ICCV.2015.123',
    abstractNote: 'Rectified activation units are essential…',
    tags: ['CNN', 'ReLU'],
    pdf: {
      key: 'JF3BKJPS',
      filename: 'He et al. - 2015 - Delving Deep into Rectifiers.pdf',
      path: '/home/user/Zotero/storage/JF3BKJPS/He et al. - 2015 - Delving Deep into Rectifiers.pdf',
      size: 2290070,
      url: '/zotero/file/JF3BKJPS',
    },
  })
}

globalThis.window = windowStub
globalThis.document = documentStub
globalThis.localStorage = localStorageStub
globalThis.fetch = fetchStub

// ---------------------------------------------------------------------------
// 1. Module envelope + factory exports
// ---------------------------------------------------------------------------

const clientPath = path.join(root, 'lib', 'client.js')
assert.ok(fs.existsSync(clientPath), 'lib/client.js exists')
await import(pathToFileURL(clientPath).href + '?smoke=' + Date.now())

console.log('module envelope')
check('loader receives one registration', () => {
  assert.ok(registration, 'window.__ModuleLoader__.load was not called')
  assert.equal(registration.id, '@local/dsh-zotero')
  assert.equal(typeof registration.factory, 'function')
})

const requiredModules = []
const factory = registration.factory
const plugin = factory((name) => {
  requiredModules.push(name)
  if (name === 'react') return react
  throw new Error('unexpected require(' + name + ')')
})

check('factory requires only react', () => {
  assert.deepEqual(requiredModules, ['react'])
})
check('exports name/inject/apply', () => {
  assert.equal(plugin.name, 'zotero')
  assert.ok(Array.isArray(plugin.inject))
  assert.deepEqual(plugin.inject, ['slots'])
  assert.equal(typeof plugin.apply, 'function')
})
check('exports test helpers', () => {
  assert.equal(typeof plugin.__test, 'object')
  for (const key of ['buildPrompt', 'authorLine', 'typeLabel', 'pageOfSelection', 'viewerUrl', 'ensureStyles']) {
    assert.equal(typeof plugin.__test[key], 'function', key + ' missing')
  }
  assert.ok(plugin.__test.CSS.length > 2000, 'injected CSS is suspiciously small')
})

// ---------------------------------------------------------------------------
// 2. Slot registration against a mock ctx (services intentionally absent)
// ---------------------------------------------------------------------------

const registrations = []
const injections = []
const mockCtx = {
  // apply() must not touch services: this getter throws if it does.
  get(name) {
    throw new Error('service "' + name + '" was resolved during apply()')
  },
  slots: {
    inject(name, callback) {
      injections.push(name)
      callback()
    },
    register(entry, component) {
      registrations.push({ entry, component })
      return { dispose() {} }
    },
  },
}

console.log('slot registration')
plugin.apply(mockCtx)

check('registers the sidebar panellist first', () => {
  assert.deepEqual(injections, ['sidebar.panellist', 'main'])
  assert.equal(registrations.length, 2)
  const sidebar = registrations[0]
  assert.equal(sidebar.entry.name, 'sidebar.panellist')
  assert.equal(sidebar.entry.id, 'zotero')
  assert.equal(sidebar.entry.order, 30)
  assert.equal(typeof sidebar.entry.label, 'function')
  assert.equal(sidebar.entry.label(), 'Zotero')
  assert.equal(typeof sidebar.component, 'function')
})
check('registers the main panel with a lazy pluginCtx inject', () => {
  const main = registrations[1]
  assert.equal(main.entry.name, 'main')
  assert.equal(main.entry.key, 'zotero')
  assert.equal(typeof main.entry.inject, 'function')
  assert.equal(main.entry.inject().pluginCtx, mockCtx)
})
check('apply() resolved no services', () => {
  assert.equal(registrations.length, 2)
})

// ---------------------------------------------------------------------------
// 3. SSR of the panel (effects do not run; only the initial tree is rendered)
// ---------------------------------------------------------------------------

const panel = registrations[1].component
const panelCtx = {
  get() {
    return undefined
  },
  slots: {},
}

console.log('panel SSR')
let html = ''
check('panel renders without throwing', () => {
  html = renderToStaticMarkup(react.createElement(panel, { pluginCtx: panelCtx }))
  assert.equal(typeof html, 'string')
  assert.ok(html.length > 500)
})
check('initial tree shows the shell, search and empty reader state', () => {
  assert.match(html, /Zotero/)
  assert.match(html, /搜索标题、作者/)
  assert.match(html, /篇/)
  assert.match(html, /选择一篇文献开始阅读/)
})
check('folder rail renders 全部文献 and 未分类', () => {
  assert.match(html, /zot-folders/)
  assert.match(html, /全部文献/)
  assert.match(html, /未分类/)
  assert.match(html, /分类/)
})

// Restored UI state is read from localStorage on mount.
storage.set(plugin.__test.LS_KEY, JSON.stringify({ q: 'attention', collection: '', itemKey: 'ITEM0002' }))
check('restores persisted search query and item key', () => {
  const restored = renderToStaticMarkup(react.createElement(panel, { pluginCtx: panelCtx }))
  assert.match(restored, /value="attention"/)
  assert.match(restored, /正在载入文献/)
})
storage.delete(plugin.__test.LS_KEY)

check('injects one scoped stylesheet', () => {
  plugin.__test.ensureStyles()
  plugin.__test.ensureStyles() // idempotent
  const styles = documentStub.head.children.filter((node) => node.id === 'dsh-zotero-styles')
  assert.equal(styles.length, 1)
  assert.ok(styles[0].textContent.includes('.zot-root'))
  assert.ok(styles[0].textContent.includes('@container'))
  assert.ok(!/https?:\/\//.test(styles[0].textContent), 'CSS must not reference external URLs')
})
check('data fetches were not attempted during apply/SSR', () => {
  assert.deepEqual(fetchCalls, [])
})

// ---------------------------------------------------------------------------
// 4. Pure helpers: prompt template must match CONTRACT.md §2 exactly
// ---------------------------------------------------------------------------

const test = plugin.__test

console.log('pure helpers')
check('prompt template matches the contract byte-for-byte', () => {
  const paper = sampleDetail()
  const prompt = test.buildPrompt(paper, '  We propose PReLU…  ', 3, '')
  const expected = [
    '我在阅读论文《Delving Deep into Rectifiers: Surpassing Human-Level Performance》（Kaiming He、Xiangyu Zhang、Shaoqing Ren、Jian Sun；2015）。',
    '',
    '【框选内容 · 第3页】',
    'We propose PReLU…',
    '',
    '【论文信息】',
    '- 标题：Delving Deep into Rectifiers: Surpassing Human-Level Performance',
    '- 作者：Kaiming He、Xiangyu Zhang、Shaoqing Ren、Jian Sun',
    '- 年份：2015',
    '- 出版物：arXiv',
    '- DOI：10.1109/ICCV.2015.123',
    '- PDF 路径：/home/user/Zotero/storage/JF3BKJPS/He et al. - 2015 - Delving Deep into Rectifiers.pdf',
    '- Zotero Key：ITEM0001',
    '',
    '我的问题：请解释我框选的这段内容，并指出它在论文论证中的作用。',
    '',
    '（如需更多上下文，优先调用 zotero_paper 工具，参数 itemKey 为上面的 Zotero Key；也可以直接读取上面的 PDF 路径获取全文。）',
  ].join('\n')
  assert.equal(prompt, expected)
})
check('prompt uses the typed question and falls back to page 1', () => {
  const prompt = test.buildPrompt(sampleDetail(), 'text', null, '这篇的贡献是什么？')
  assert.match(prompt, /【框选内容 · 第1页】/)
  assert.match(prompt, /我的问题：这篇的贡献是什么？/)
  assert.ok(!prompt.includes('请解释我框选的这段内容'))
})
check('prompt always carries a Zotero Key line for the tool pointer', () => {
  assert.match(test.buildPrompt(sampleDetail(), 'text', 1, ''), /- Zotero Key：ITEM0001/)
  assert.match(test.buildPrompt({ title: '无 key 的条目' }, 'text', 1, ''), /- Zotero Key：—/)
  assert.match(test.buildPrompt(sampleDetail(), 'text', 1, ''), /优先调用 zotero_paper 工具/)
})
check('prompt without a selection omits the selection block and uses the paper default', () => {
  const prompt = test.buildPrompt(sampleDetail(), '', null, '')
  assert.ok(!prompt.includes('【框选内容'), 'no selection block without a selection')
  assert.match(prompt, /我的问题：请总结这篇论文的核心贡献、方法要点与主要结论。/)
  assert.match(prompt, /- Zotero Key：ITEM0001/)
  assert.match(prompt, /【论文信息】/)
})
check('prompt without a selection keeps a typed question verbatim', () => {
  const prompt = test.buildPrompt(sampleDetail(), '   ', 4, '这篇的实验设置是什么？')
  assert.ok(!prompt.includes('【框选内容'))
  assert.match(prompt, /我的问题：这篇的实验设置是什么？/)
})
check('collection tree nests children, sorts by name and drops cycles to roots', () => {
  const tree = test.buildCollectionTree([
    { key: 'B', name: 'Beta', parentKey: 'A', count: 2, totalCount: 2 },
    { key: 'A', name: 'Alpha', parentKey: null, count: 1, totalCount: 3 },
    { key: 'C', name: 'Gamma', parentKey: 'MISSING', count: 0, totalCount: 0 },
    { key: 'D', name: 'Delta', parentKey: 'D', count: 1, totalCount: 1 },
  ])
  assert.deepEqual(tree.map((node) => node.key), ['A', 'D', 'C'])
  assert.equal(tree[0].children.length, 1)
  assert.equal(tree[0].children[0].key, 'B')
  assert.deepEqual(test.buildCollectionTree(null), [])
})
check('unfiled sentinel is exported for requests and persistence', () => {
  assert.equal(test.COLLECTION_UNFILED, '__unfiled__')
  assert.equal(test.DEFAULT_PAPER_QUESTION, '请总结这篇论文的核心贡献、方法要点与主要结论。')
})
check('prompt truncates selections to 4000 characters', () => {
  const long = 'x'.repeat(5000)
  const prompt = test.buildPrompt(sampleDetail(), long, 2, '')
  assert.ok(prompt.includes('x'.repeat(4000)))
  assert.ok(!prompt.includes('x'.repeat(4001)))
})
check('author lists format and ellipsize correctly', () => {
  assert.equal(test.authorLine([{ firstName: 'A', lastName: 'B' }, { name: 'C' }]), 'A B、C')
  assert.equal(test.authorLine([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], 3), 'A、B、C 等')
  assert.equal(test.authorLine([]), '')
  assert.equal(test.authorLine(null), '')
})
check('item type labels and viewer URLs', () => {
  assert.equal(test.typeLabel('journalArticle'), '期刊论文')
  assert.equal(test.typeLabel('conferencePaper'), '会议论文')
  assert.equal(test.typeLabel('unknownType'), 'unknownType')
  assert.equal(
    test.viewerUrl('JF3BKJPS'),
    '/zotero/viewer.html?file=' + encodeURIComponent('/zotero/file/JF3BKJPS'),
  )
})
check('pageOfSelection walks ancestors for [data-page]', () => {
  const page = { nodeType: 1, parentNode: null, hasAttribute: (n) => n === 'data-page', getAttribute: () => '7' }
  const textLayer = { nodeType: 1, parentNode: page, hasAttribute: () => false }
  const span = { nodeType: 1, parentNode: textLayer, hasAttribute: () => false }
  assert.equal(test.pageOfSelection({ anchorNode: span, rangeCount: 0 }), 7)
  assert.equal(test.pageOfSelection({ anchorNode: null, rangeCount: 0 }), null)
  assert.equal(test.pageOfSelection(null), null)
})
check('persisted state reader tolerates garbage', () => {
  storage.set(test.LS_KEY, '{not json')
  assert.deepEqual(test.readPersisted(), { q: '', collection: '', itemKey: null })
  storage.set(test.LS_KEY, JSON.stringify({ q: 'relu', collection: 'COLL0001', itemKey: 'ITEM0001' }))
  assert.deepEqual(test.readPersisted(), { q: 'relu', collection: 'COLL0001', itemKey: 'ITEM0001' })
  storage.delete(test.LS_KEY)
})

// ---------------------------------------------------------------------------
// 5. Per-paper chat helpers: prompt variants, transcript rows, session map
// ---------------------------------------------------------------------------

console.log('paper chat helpers')
check('follow-up prompt keeps the selection and asks the question', () => {
  const prompt = test.buildFollowupPrompt(sampleDetail(), '  rectifier units  ', 2, '它为什么重要？')
  assert.equal(prompt, [
    '【框选内容 · 第2页】',
    'rectifier units',
    '',
    '我的问题：它为什么重要？',
  ].join('\n'))
})
check('follow-up prompt without selection or question uses the paper default', () => {
  const prompt = test.buildFollowupPrompt(sampleDetail(), '', null, '')
  assert.equal(prompt, '我的问题：请总结这篇论文的核心贡献、方法要点与主要结论。')
  assert.ok(!prompt.includes('【框选内容'))
})
check('parsePromptForDisplay recovers the question, page and selection', () => {
  const full = test.buildPrompt(sampleDetail(), 'Selected paragraph.', 3, '核心贡献？')
  const parsed = test.parsePromptForDisplay(full)
  assert.equal(parsed.page, '3')
  assert.equal(parsed.selection, 'Selected paragraph.')
  assert.equal(parsed.question, '核心贡献？')
  const follow = test.buildFollowupPrompt(sampleDetail(), 'More text.', 4, '继续解释')
  const parsedFollow = test.parsePromptForDisplay(follow)
  assert.equal(parsedFollow.page, '4')
  assert.equal(parsedFollow.selection, 'More text.')
  assert.equal(parsedFollow.question, '继续解释')
  assert.equal(test.parsePromptForDisplay('plain question').question, 'plain question')
})
check('contentText joins text blocks and ignores non-text content', () => {
  assert.equal(test.contentText('abc'), 'abc')
  assert.equal(test.contentText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(test.contentText(null), '')
})
check('chatMessageOf maps user, assistant and error nodes', () => {
  const user = test.chatMessageOf({ kind: 'user', visibility: 'visible', data: { content: [{ type: 'text', text: 'hi' }] } })
  assert.deepEqual(user, { role: 'user', text: 'hi' })
  const assistant = test.chatMessageOf({
    kind: 'assistant-step',
    visibility: 'visible',
    data: { status: 'settled', blocks: [{ kind: 'text', text: 'answer' }, { kind: 'tool-call', name: 'zotero_paper' }] },
  })
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.text, 'answer')
  assert.deepEqual(assistant.tools, ['zotero_paper'])
  assert.equal(assistant.running, false)
  const running = test.chatMessageOf({ kind: 'assistant-step', visibility: 'visible', data: { status: 'running', blocks: [] } })
  assert.equal(running.running, true)
  const error = test.chatMessageOf({ kind: 'turn-error', visibility: 'visible', data: { message: 'boom' } })
  assert.deepEqual(error, { role: 'error', text: 'boom' })
  assert.equal(test.chatMessageOf({ kind: 'turn-tail', visibility: 'visible', data: {} }), null)
  assert.equal(test.chatMessageOf({ kind: 'user', visibility: 'hidden', data: { content: 'x' } }), null)
})
check('paper chat map round-trips through localStorage and drops garbage', () => {
  const key = test.PAPER_CHATS_KEY
  storage.set(key, JSON.stringify({
    PAPER1: { active: 's2', sessions: [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }] },
    BAD: { active: 'x', sessions: 'nope' },
  }))
  const map = test.readPaperChats()
  assert.deepEqual(map.PAPER1, { active: 's2', sessions: [{ id: 's1', title: 'A', createdAt: 0 }, { id: 's2', title: 'B', createdAt: 0 }] })
  assert.equal(map.BAD, undefined)
  test.writePaperChats({ PAPER2: { active: 's3', sessions: [{ id: 's3', title: 'C', createdAt: 1 }] } })
  assert.deepEqual(test.readPaperChats().PAPER2, { active: 's3', sessions: [{ id: 's3', title: 'C', createdAt: 1 }] })
  storage.set(key, '{not json')
  assert.deepEqual(test.readPaperChats(), {})
  storage.delete(key)
})
check('note HTML conversion and sanitizer fallback', () => {
  const plain = test.noteHtmlFromText('line one\n\nline two')
  assert.match(plain, /^<div class="zotero-note znv1"><p>line one<\/p><p>line two<\/p><\/div>$/)
  assert.equal(test.noteHtmlFromText('<p>kept</p>'), '<p>kept</p>')
  const sanitized = test.sanitizeNoteHtml('<script>alert(1)</script><p onclick="x">ok</p>')
  assert.ok(!/<script/i.test(sanitized))
  assert.ok(sanitized.includes('&lt;') || !/<p\s/i.test(sanitized))
})
check('reading progress round-trips per attachment', () => {
  const key = 'JF3BKJPS'
  test.writeProgress(key, { page: 7, ratio: 0.42 })
  const map = test.readProgress()
  assert.equal(map[key].page, 7)
  assert.ok(Math.abs(map[key].ratio - 0.42) < 1e-6)
  test.writeProgress(key, { page: 'bad', ratio: 0 })
  assert.equal(test.readProgress()[key].page, 7)
})
check('shortTitle compacts long paper titles', () => {
  assert.equal(test.shortTitle('  Diffusion   Policy  '), 'Diffusion Policy')
  const long = test.shortTitle('x'.repeat(80), 20)
  assert.equal(long.length, 20)
  assert.ok(long.endsWith('…'))
})
check('math splitter separates inline/display TeX and keeps escaped dollars', () => {
  const parts = test.splitMathSegments('a $x+y$ b $$z^2$$ c \\$5')
  assert.deepEqual(parts, [
    { type: 'text', text: 'a ' },
    { type: 'inline', tex: 'x+y' },
    { type: 'text', text: ' b ' },
    { type: 'display', tex: 'z^2' },
    { type: 'text', text: ' c $5' },
  ])
  assert.deepEqual(test.splitMathSegments('no math here'), [{ type: 'text', text: 'no math here' }])
  assert.deepEqual(test.splitMathSegments('\\[x^2\\]'), [{ type: 'display', tex: 'x^2' }])
})
check('markdown renderer renders KaTeX once the library is available', () => {
  const previous = globalThis.window.katex
  globalThis.window.katex = {
    renderToString: (tex, options) => '<span class="katex' + (options.displayMode ? ' display' : '') + '">' + tex + '</span>',
  }
  const Markup = () => react.createElement('div', null, test.renderRichText('Equation $E=mc^2$ and $$x^2$$'))
  const markup = renderToStaticMarkup(react.createElement(Markup))
  assert.match(markup, /class="katex"/)
  assert.match(markup, /E=mc\^2/)
  assert.match(markup, /katex display/)
  assert.match(markup, /zot-math-display/)
  if (previous === undefined) delete globalThis.window.katex
  else globalThis.window.katex = previous
})
check('block display math and currency text are distinguished', () => {
  const previous = globalThis.window.katex
  globalThis.window.katex = { renderToString: (tex, options) => '<span class="katex' + (options.displayMode ? ' display' : '') + '">' + tex + '</span>' }
  const Block = () => react.createElement('div', null, test.renderRichText('before\n\n$$\na^2 + b^2 = c^2\n$$\n\nafter'))
  const blockMarkup = renderToStaticMarkup(react.createElement(Block))
  assert.match(blockMarkup, /zot-math-display/)
  assert.match(blockMarkup, /a\^2 \+ b\^2 = c\^2/)
  const currency = test.splitMathSegments('costs $100 and $200 total')
  assert.deepEqual(currency, [{ type: 'text', text: 'costs $100 and $200 total' }])
  if (previous === undefined) delete globalThis.window.katex
  else globalThis.window.katex = previous
})
check('markdown renderer handles headings, lists and fenced code', () => {
  const Markdown = () => react.createElement('div', null, test.renderRichText('# Title\n\n- one\n- two\n\n```js\nconst a = 1\n```\n\n**bold** and `code`'))
  const markup = renderToStaticMarkup(react.createElement(Markdown))
  assert.match(markup, /zot-md-h1/)
  assert.match(markup, /<li>one<\/li>/)
  assert.match(markup, /zot-md-code/)
  assert.match(markup, /<strong>bold<\/strong>/)
  assert.match(markup, /zot-md-inline/)
})

console.log('\nclient-test/smoke.mjs: ' + checks + ' checks passed')
