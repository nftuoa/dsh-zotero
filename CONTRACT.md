# Zotero DSH plugin — build contract (shared by host + client halves)

Package: `~/dsh-zotero`, installed into the DSH web profile as the bundle
`@local/dsh-zotero`. Two halves:

| half | file | runtime |
| --- | --- | --- |
| host (Node/cordis) | `lib/index.js` (+ helper `lib/*.mjs`) | DSH process, sees `ctx.webServer`, `ctx.tools` |
| client (browser/cordis) | `lib/client.js` | DSH web page, lazy-CJS module loader |

The package manifest, `cordis.patch.yml` and this contract are owned by the
Lead and are already final. Do not edit `package.json` / `cordis.patch.yml`.

Verified environment facts (do not re-derive):

- Node 26 (`node:sqlite` works), pnpm/npm available, network to npm works.
- Zotero desktop is installed but **not running**. Data lives in
  `~/Zotero/zotero.sqlite` (WAL mode, 92 items, 42 PDF attachments,
  storage under `~/Zotero/storage/<ATTACHMENT_KEY>/<file>.pdf`).
  The live DB may be locked for read; copy the DB (plus `-wal`/`-shm` when
  present) into a cache dir and read the copy with `node:sqlite` read-only.
- Zotero local API (`http://127.0.0.1:23119/api/users/0/...`) only exists while
  Zotero runs; treat it as an optional metadata fallback, never a hard
  dependency.
- pdf.js 6.3.289 is vendored at `~/dsh-zotero/vendor/pdfjs`.
  **It requires `Map.prototype.getOrInsertComputed` (missing in Chrome 143) —
  the viewer must ship the polyfill** (verified working with it):
  ```js
  if (!Map.prototype.getOrInsert) Map.prototype.getOrInsert = function (k, v) { if (!this.has(k)) this.set(k, v); return this.get(k) }
  if (!Map.prototype.getOrInsertComputed) Map.prototype.getOrInsertComputed = function (k, fn) { if (!this.has(k)) this.set(k, fn(k)); return this.get(k) }
  if (!WeakMap.prototype.getOrInsertComputed) WeakMap.prototype.getOrInsertComputed = function (k, fn) { if (!this.has(k)) this.set(k, fn(k)); return this.get(k) }
  ```
  A working prototype (renders canvas pages + selectable `TextLayer`, selection
  read via `iframe.contentWindow.getSelection()`) lives at
  `~/zotero-tools/viewer-test/{viewer.html,viewer.js}` — copy and adapt it.
  Use `new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport })`
  and set `--scale-factor` on the text layer container.
- The DSH web app is running live on `127.0.0.1:3080` (do NOT touch it).
  Isolated test servers are available (see Verification).
- The plugin **loads today** with the Lead's hello-world halves: sidebar entry
  + panel render + host prefix route all confirmed in a real page. Keep the
  module format unchanged.

## 1. Host half: HTTP surface

Register one prefix route `/zotero` on `ctx.webServer` (signature:
`ctx.webServer.register({ kind: 'prefix', path: '/zotero', handler(req,res) })`,
handler owns the response). All JSON under `/zotero/api/...`, `cache-control:
no-store`. Errors are JSON `{ error: { code, message } }` with 4xx/5xx, never an
uncaught throw. All paths are local-only (loopback server).

### Data shapes

`GET /zotero/api/status`
```json
{ "ok": true, "source": "zotero-sqlite" | "local-api" | "unavailable",
  "dataDir": "~/Zotero", "itemCount": 92, "pdfCount": 42,
  "zoteroRunning": false, "message": null }
```

`GET /zotero/api/items?q=&limit=200&offset=0&collection=<KEY>&unfiled=1`
```json
{ "total": 92,
  "items": [{
    "key": "ABCD1234", "title": "Delving Deep into Rectifiers", "itemType": "journalArticle",
    "creators": [{ "name": "Kaiming He", "firstName": "Kaiming", "lastName": "He" }],
    "year": "2015", "date": "2015-02-06 2015-02-06",
    "publication": "arXiv", "doi": "10.1109/ICCV.2015.123",
    "abstractNote": "…", "dateAdded": "2025-01-01 00:00:00",
    "collections": [{ "key": "COLL0001", "name": "Deep Learning" }],
    "tags": ["CNN", "ReLU"], "hasPDF": true, "attachmentKey": "JF3BKJPS"
  }] }
```

`GET /zotero/api/item/:itemKey`
```json
{ "key": "ABCD1234", "title": "…", "creators": [...], "year": "2015",
  "itemType": "journalArticle", "publication": "…", "doi": "…", "url": "…",
  "abstractNote": "…", "date": "…", "dateAdded": "…",
  "collections": [...], "tags": [...],
  "pdf": { "key": "JF3BKJPS", "filename": "He et al. - 2015 - ….pdf",
           "path": "~/Zotero/storage/JF3BKJPS/He et al. - ….pdf",
           "size": 2290070,
           "url": "/zotero/file/JF3BKJPS" },
  "attachments": [{ "key": "JF3BKJPS", "title": "Full Text PDF",
                    "contentType": "application/pdf", "size": 2290070 }] }
```
`pdf` is `null` when no readable PDF file exists. The absolute `path` matters:
the client includes it in the chat prompt so the agent can `pdftotext` the full
paper.

`GET /zotero/api/collections` — the folder tree (collections may nest):
```json
{ "collections": [
    { "key": "COLL0001", "name": "Deep Learning", "parentKey": null, "count": 12, "totalCount": 15 },
    { "key": "COLL0002", "name": "CNN", "parentKey": "COLL0001", "count": 3, "totalCount": 3 }
  ],
  "unfiledCount": 8 }
```
`count` = top-level papers directly in that collection; `totalCount` = papers in it
and all its subcollections; `unfiledCount` = top-level papers in no collection.
`items` filtering: `collection=<KEY>` returns the papers directly in that
collection (not subcollections); `unfiled=1` returns the papers in no collection.
The local-API fallback maps `data.parentCollection` and uses `meta.numItems` for
both counts.

`GET /zotero/file/:attachmentKey` → stream the PDF. Must support `Range`
(206 partial content, `accept-ranges: bytes`, correct `content-range`), `HEAD`,
`content-type: application/pdf`, `content-disposition: inline; filename*=UTF-8''…`.
Bytes come from a DB-verified attachment row only (no arbitrary path from the
request) — never serve a path the client names.

`GET /zotero/viewer.html`, `GET /zotero/viewer.js` → the plugin's own viewer
page in `assets/` (server-side static read, same-origin).
`GET /zotero/pdfjs/*` → static from
`vendor/pdfjs/*` with correct MIME (`.mjs/.js` →
`text/javascript; charset=utf-8`, `.css`, `.bcmap`, `.pfb/.ttf/.otf` →
`application/octet-stream` or font MIME, `.json`, `.wasm`). Support GET/HEAD,
prevent `..` traversal, set long cache for immutable assets.

### SQLite data layer (recommended)

Cache snapshot: `~/.cache/dsh-zotero/zotero-<hash>.sqlite`; re-copy when source
mtime/size changes or snapshot older than ~15 s. Open with
`new DatabaseSync(path, { readOnly: true })`. Collapse the DB to the shapes
above with these tables:
`items(itemID, key, itemTypeID, dateAdded, dateModified)`, `itemTypes`,
`itemData` + `fields(fieldName)` + `itemDataValues(value)`,
`creators` + `itemCreators` + `creatorTypes`, `itemAttachments(itemID,
parentItemID, path, contentType)`, `collections` + `collectionItems`,
`tags` + `itemTags`, `deletedItems`. Top-level rows only (`parentItemID IS
NULL`, type not attachment/note/annotation, not deleted). Field names in Zotero
are `title`, `date`, `abstractNote`, `publicationTitle`, `DOI`, `url`,
`language`, `volume`, `issue`, `pages`. Creator names: `fieldMode = 1` means
single-field (`lastName` holds the whole name). Attachment `path` values:
`storage:<filename>` → `<dataDir>/storage/<attachmentKey>/<filename>`, plain
absolute paths are linked files.

Export testable pure functions (e.g. `openSnapshot`, `listItems`, `getItem`,
`listCollections`, `readAttachment`) from `lib/zotero-data.mjs`; `lib/index.js`
does only cordis wiring. Use `node:test` for unit tests in `test/`.

### Optional model tool (do it if straightforward)

Register with `ctx.inject(['tools'], (tctx) => tctx.effect(() => tctx.tools.register(toolDef)))`
so profiles without a tool registry still load the plugin. Plain object
definitions are fine (no imports needed):
`{ name, description, parameters: <raw JSON Schema object>, output: { schema:
<raw JSON Schema>, render(args, value) { return [{ type: 'text', text }] } },
async execute(args) {…} }`.
- `zotero_paper(itemKey)` → `{ title, authors, year, text }` where `text` is
  `pdftotext -layout -l 40 <path> -` capped at ~60k chars (execFile with
  timeout, `exec.signal` honored). Error message if no PDF/pdftotext.
- `zotero_search(query)` → `{ results: [{ itemKey, title, authors, year }] }` (≤10).

## 2. Client half: `lib/client.js`

Hand-written lazy-CJS bundle, exactly this envelope (verified loading in the
live page):
```js
window.__ModuleLoader__.load({
  id: '@local/dsh-zotero',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')            // React 18, shared shell instance
    // ...component + plugin...
    exports.name = 'zotero'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
```
Use `react.createElement` (no JSX, no build step). Do not import anything else
except optionally `@deepseek-ai/dsh-client-ui-primitives` (prefer self-contained
markup + CSS instead). Register:

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: 'zotero', order: 30, label: () => 'Zotero',
}, ZoteroIcon))
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main', key: 'zotero', inject: () => ({ pluginCtx: ctx }),
}, ZoteroPanel))
```
`ZoteroIcon` is a 16px inline SVG (book / “Z” glyph). `ZoteroPanel` is a
global-scope component receiving the injected `pluginCtx`. It may also receive
global standard props (`useSessions`, `useWorkspaces`, `t`, …) — do not rely on
them; use `pluginCtx.get('sessions' | 'uiWorkspace' | 'layout' | 'conversation')`
lazily at action time.

### UI (Chinese copy; match DSH visual language)

Full-bleed three-column layout inside the main panel:
- Header row: title “Zotero”, item count, refresh button, search input
  (debounced 250 ms → `/zotero/api/items?q=`).
- **Folder rail (176–208 px)** built from `/zotero/api/collections`: 全部文献
  (total), 未分类 (unfiledCount), then the collection tree with indentation,
  per-row counts, collapse chevrons for parents and an active highlight.
  Selecting a row filters the middle list (`collection=<KEY>` or `unfiled=1`)
  and persists the choice. Below ~940 px of panel width the rail collapses and
  a “分类” toggle in the header opens it as an overlay (Esc closes).
- Middle column (280–320 px, scroll): item rows → title (2-line clamp), authors
  (first 3), year, type badge, PDF dot. Selected row highlighted.
  Empty/error states: “未找到 Zotero 数据” + the host `status.message` +
  guidance (打开 Zotero 生成数据库，或检查 `dataDir` 配置).
- Right column: paper header (title, authors·year, publication/DOI) then the
  reader iframe filling the rest, `src = /zotero/viewer.html?file=` +
  `encodeURIComponent('/zotero/file/' + attachmentKey)`. No PDF → placeholder
  (“该条目没有可读取的 PDF”) with abstract text.
- Style with CSS injected once into `document.head` (unique `zot-` prefix),
  theme-aware: use `var(--dsh-…)` tokens when present with sensible fallbacks,
  and support `body[data-ds-dark-theme]` dark colors. No external fonts/assets.

### Paper chat: one paper, its own session(s), docked right

The main panel is a three-column layout: folders | item list | **paper + chat**.
The chat pane is a fixed right column (≈384px, min 330px) inside the panel, with
the paper reader on its left. It never reuses the user's main DSH conversation:
opening a paper resolves/creates a session for that paper and the pane renders
that session's transcript and composer in place.

**Session mapping** lives in `localStorage['dsh.zotero.paperChats.v1']`:

```json
{ "3FJ3CCDD": { "active": "session-…", "sessions": [
  { "id": "session-…", "title": "Diffusion Policy… · 对话 1", "createdAt": 0 }
] } }
```

- On paper open: validate the mapped sessions against
  `sessions.list.getSnapshot().byId`; reuse the active one, or create a session
  with `sessions.create({})`, rename it to `shortTitle(paper.title) + ' · 对话 N'`
  through a temporary retain + `binding.session.rename(title)`, and persist the
  mapping. Multiple sessions per paper are allowed; **新对话** creates another
  one and switches to it. Never append to the DSH main conversation and never
  call `layout.selectPanel(null)` on send.
- Bind the session for the transcript:
  ```js
  const ref = sessions.retain(sessionId, { source: 'zotero-chat' })
  await ref.ready
  const view = ctx.uiConversation.binding(sessionId)
  view.activate('chat')
  const target = view.target('chat')       // ObservableSnapshot<ChatSnapshot>
  target.subscribe(update)                 // render on every publication
  // send:
  await ref.binding.ctx.get('conversation').send(prompt)
  // release the ref when leaving the paper/unmounting
  ```
  Render rows from `snapshot.order` + `snapshot.nodes.get(key)`:
  `user` / `steering` → user bubble (extract `我的问题：` from our envelope so
  the bubble shows the question, plus a “第 P 页 · 框选 N 字” badge);
  `assistant-step` → text blocks + tool-name chips, `status === 'running'` shows
  a typing row; `turn-error` → inline error. Hide settled rows with no text
  (tool-only intermediate steps). Ignore `turn-process`, `turn-tail`, `command`,
  `context`, `system-prompt`.
- The composer sits at the bottom of the chat pane, **always visible** for an
  open paper: selection chip + 复制/清除 only while a selection exists; textarea
  and 发送 always. Empty selection + empty question is allowed. Keyboard: Enter
  sends, Shift+Enter newline, Esc clears the selection. `新对话` lives in the
  pane header; a session dropdown appears when a paper has more than one.
- The first prompt in a session uses the full template below. Follow-ups in the
  same session send only the selection block (when present) and
  `我的问题：…`; the paper metadata stays in session history.

Bind selection in the iframe after `load` (debounce ~120 ms; same-origin access
is guaranteed because the viewer is served by this plugin):
```js
const win = iframe.contentWindow, doc = win.document
const update = () => setSelection(win.getSelection()?.toString() ?? '')
doc.addEventListener('selectionchange', update)
doc.addEventListener('mouseup', update); doc.addEventListener('keyup', update)
```
Page number: walk `getSelection().anchorNode` ancestors to the nearest
`[data-page]` written by the viewer.

Build the first prompt (Chinese, keep exact structure). With a selection:
```
我在阅读论文《{title}》（{authors joined '、'}；{year}）。

【框选内容 · 第{page}页】
{selectedText trimmed to 4000 chars}

【论文信息】
- 标题：{title}
- 作者：{authors}
- 年份：{year}
- 出版物：{publication or '—'}
- DOI：{doi or '—'}
- PDF 路径：{pdf.path or '—'}
- Zotero Key：{item.key}

我的问题：{question || '请解释我框选的这段内容，并指出它在论文论证中的作用。'}

（如需更多上下文，优先调用 zotero_paper 工具，参数 itemKey 为上面的 Zotero Key；也可以直接读取上面的 PDF 路径获取全文。）
```
Without a selection the 【框选内容】 block is omitted and the default question
becomes `请总结这篇论文的核心贡献、方法要点与主要结论。`.

### Math rendering

The chat pane is not the shipped Chat renderer, so it must render LaTeX itself.
The host serves a vendored KaTeX from `vendor/katex` under
`/zotero/katex/*` (JS, CSS and fonts). The client loads `katex.min.css` and
`katex.min.js` lazily on the first transcript that contains math, then renders
segments split from `$…$`, `$$…$$`, `\(…\)` and `\[…\]` with
`katex.renderToString(tex, { displayMode, throwOnError: false, strict: 'ignore',
trust: false, output: 'html' })`. Escaped `\$` stays literal; a lone `$` without
a same-line closing delimiter stays text (streaming answers must never lose
content). KaTeX's output is injected through React `dangerouslySetInnerHTML`;
`trust: false` keeps links/HTML commands inert.

### Reading progress

The viewer exposes `getProgress()` / `goTo(page, ratio)` and scrolls its `#pages`
container (not `window`). The client stores `{page, ratio}` per PDF attachment key
in `localStorage['dsh.zotero.progress.v1']`, saves debounced on scroll and again
when the frame unbinds, then restores only after `window.__zoteroViewerReady`
(all pages rendered) so scrollTop is not clamped by a partial page list.

### Native annotations and notes

Reads come from the same SQLite snapshot: `itemAnnotations` joined through the
attachment to the paper, and `itemNotes` whose parent is the paper, an
attachment, or an annotation. `GET /zotero/api/annotations/:itemKey` returns
`{annotations, notes, writable}`; `writable` is true only when Zotero's local API
answers (Zotero running and enabled).

Writes use Zotero's local Web API (`http://127.0.0.1:23119/api/...`), never the
live SQLite file:
- `GET /api/users/0/items?limit=1` → `Zotero-Server-ID`.
- `POST /api/local/authorize {appName:'DSH Zotero'}` → key (Zotero modal; user
  should pick **Always Allow**). The key is cached at
  `<cacheDir>/local-api-auth.json`; a remembered key is also discovered in
  Zotero's profile `localAPIKeys.json`.
- Create highlight: `POST /api/users/0/items` with one item:
  `{itemType:'annotation', parentItem:<attachmentKey>, annotationType:'highlight',
    annotationText, annotationComment, annotationColor, annotationPageLabel,
    annotationSortIndex, annotationPosition: JSON.stringify({pageIndex, rects})}`.
  `rects` are PDF user-space `[x1,y1,x2,y2]` from the viewer's
  `selectionRects()` (origin bottom-left).
- Update annotation: merge-patch with `key` + `version` (array POST), e.g.
  `annotationComment`, `annotationColor`.
- Notes: `{itemType:'note', parentItem:<paperKey>, note:<HTML>}`; updates use the
  same version-fenced merge patch.
- After every write the host calls `library.refresh()` so the next read reflects
  the new state.
- Writes require `httpServer.localAPI.enabled` in Zotero; otherwise the route
  returns the setup guidance. Reads remain available while Zotero is closed.

### Viewer requirements for selection

- Set **`--total-scale-factor`** (pdf.js ≥ 6) as well as `--scale-factor` on each
  `.textLayer`; without it span font sizes are wrong and pointer hit-testing
  selects different text from the glyphs under the cursor.
- Re-render on **width** changes only. A height-only resize (the composer row
  appearing) must not rebuild the text layer, or the current selection is
  destroyed immediately after the user makes it.

## 3. Verification

Do not touch `~/.dsh/profiles/web` (live) or restart the live GUI. Use:

- Host unit tests: `cd ~/dsh-zotero && node test/host.test.mjs` (node:test).
  Also a standalone harness is welcome (`node test/serve.mjs` on port 3301)
  mounting the same routes over a plain `node:http` server.
- Test DSH profile already exists: `~/.dsh-zotero-test/profiles/zotero-test`
  with `~/.dsh/profiles/zotero-test` (symlinks the plugin). Start a test GUI on
  another port:
  `DSH_HOME=$HOME/.dsh-zotero-test dsh --profile zotero-test --port 3302 --no-open`
  (prints its token URL; keep it running as a background job).
- Client smoke test: `node client-test/smoke.mjs` (fake module loader, real
  React via a local `client-test/node_modules` install if you want SSR; must
  prove the factory returns `name/inject/apply`, `apply` registers the two
  slots against a mock ctx, and the panel renders without throwing).
- Headless Chrome + CDP helper: `~/zotero-tools/cdp.mjs`
  (`CDP_PORT=9223 node ~/zotero-tools/cdp.mjs <url> <out.png> "<js>" <waitMs>`).
  A Chrome instance can be started headless with
  `google-chrome-stable --headless=new --no-sandbox --user-data-dir=/tmp/cdp-<you> --remote-debugging-port=9223 about:blank`.
  Use `.textLayer span` inside the iframe document to create a selection and
  verify the question bar appears; screenshot it.
- Sample PDFs: any `~/Zotero/storage/*/*.pdf`; e.g.
  `~/Zotero/storage/JF3BKJPS/He et al. - 2015 - …pdf`.

## 4. Write scopes (do not cross)

- host-bridge: `dsh-zotero/lib/index.js`, `dsh-zotero/lib/*.mjs`,
  `dsh-zotero/assets/**`, `dsh-zotero/test/**`.
- client-ui: `dsh-zotero/lib/client.js`, `dsh-zotero/client-test/**`.
- Lead: `package.json`, `cordis.patch.yml`, `README.md`, profile installs,
  E2E, screenshots.
