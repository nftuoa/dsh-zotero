# dsh-zotero — Zotero for DeepSeek Harness

[![GitHub](https://img.shields.io/badge/GitHub-nftuoa%2Fdsh--zotero-181717?logo=github)](https://github.com/nftuoa/dsh-zotero)


A local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for reading a
[Zotero](https://www.zotero.org/) library inside the DSH Web GUI:

- **Zotero panel** — browse and search the local Zotero library (items, creators, year, type,
  collections, tags), see which entries have a PDF.
- **Folder rail** — Zotero collections as a folder tree (全部文献 / 未分类 / nested collections with
  counts); picking one filters the item list. It collapses into a **分类** drawer on narrow panels.
- **Paper reader** — open the attached PDF in a same-origin PDF.js reader embedded in the panel
  (continuous pages, real text layer, selection).
- **Paper chat, docked right** — every paper has its own conversation pane on the right of the
  reader. It never touches the user's main DSH conversation: the first question creates (or reuses) a
  session for that paper, and asking sends into that session only. Merely opening a paper does not
  create an empty session.
- **Multiple sessions per paper** — **新对话** creates another session for the same paper and the
  header dropdown switches between them; each keeps its own transcript.
- **Markdown + formulas** — assistant answers render headings, lists, code blocks and inline/display
  LaTeX through a vendored KaTeX (no external CDN); `$…$`, `$$…$$`, `\(…\)` and `\[…\]` all work.
- **Reading progress** — every PDF remembers its last page and position; reopening the paper (or
  restarting DSH) returns to where you stopped.
- **Native Zotero annotations & notes** — the **标注与笔记** tab lists Zotero highlights and notes by
  page. You can save the current PDF selection as a native Zotero highlight, edit highlight comments,
  and create/edit Zotero child notes. Writes go through Zotero's local API (no direct DB edits).
- **Selection → chat** — select any passage and the chat composer shows *已选 N 字 · 第 P 页*; type
  (or skip) a question and press **发送**. The first prompt carries the selection, paper metadata,
  Zotero item key and PDF path; follow-ups stay lean. Without a selection the 【框选内容】 block is
  omitted and the default question becomes a whole-paper summary. The agent answers immediately and
  can read the full paper through the `zotero_paper` tool or the PDF path.
- **Open full conversation** — the ↗ button opens the paper's session in the regular DSH chat if you
  need the full transcript, tools, or attachments.

### Model tools

The host half also registers two model-facing tools (when the profile has a tool registry):

- `zotero_search(query)` — search the local library, returns item keys.
- `zotero_paper(itemKey)` — title/authors/year plus the first ~40 pages of the PDF as text
  (`pdftotext`), so follow-up questions can go beyond the selection.

## Requirements

- A DSH Web profile (`dsh web`). Tested with **dsh 0.2.1-rc.2** (the client relies on the
  `uiConversation` ChatSnapshot API, see [Compatibility](#compatibility)).
- **Node ≥ 22.13 / 23.4 / 24** (the host uses `node:sqlite`; on older Node the plugin still loads and
  falls back to Zotero's local HTTP API while Zotero is running).
- Zotero desktop with a local library (default `~/Zotero`, or `C:\Users\<you>\Zotero` on Windows).
  Zotero does **not** need to stay open: the host reads a snapshot copy of `zotero.sqlite`.
- `pdftotext` (poppler) optional — enables the `zotero_paper` model tool for full-text access.
- To create/edit annotations and notes, Zotero must be running with **Settings → Advanced → Allow
  other applications on this computer to communicate with Zotero** enabled. The first write opens
  Zotero's authorization dialog; choose **Always Allow**. Reading annotations/notes never needs it.
- No network access at runtime: pdf.js and KaTeX are vendored in the package.

## Install on another DSH

The package is self-contained: `lib/`, `assets/`, `vendor/` (pdf.js + KaTeX + fonts),
`cordis.patch.yml`, icon and README. It declares `dsh.bundle.patch`, so the DSH Plugin Manager can
install and enable it like any official bundle.

### A. From the Web UI (recommended for end users)

1. Download the tarball from [GitHub Releases](https://github.com/nftuoa/dsh-zotero/releases) or
   build one (see [Packaging](#packaging)):
   ```
   npm pack          # → dsh-zotero-1.0.1.tgz
   ```
2. In DSH: **Plugins → Add plugin** → choose *Install a third-party plugin* → enter the absolute
   tarball path (or a Git URL / package name).
3. After installation click **Enable now** (or switch the bundle on), then **refresh the GUI**.
   The **Zotero** entry appears in the sidebar.

### B. From the CLI / profile

```bash
dsh plugin --profile web add /absolute/path/dsh-zotero-1.0.1.tgz
```

Then add the bundle to the profile manifest (this is what the UI's *Enable now* does):

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": { "@local/dsh-zotero": "file:/absolute/path/dsh-zotero-1.0.1.tgz" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "...", "@local/dsh-zotero"] } }
}
```

`dsh plugin add` only adds the dependency; the bundle list (or the UI toggle) is what activates it.
Restart `dsh web` (or let HMR recompose) and refresh the page.

### C. From Git / GitHub

```bash
dsh plugin --profile web add github:nftuoa/dsh-zotero
# then add "@local/dsh-zotero" to dsh.profile.bundles as above
```

`vendor/` is committed in the repository, so no install or build step is required at the consumer
side. Prebuilt tarballs are attached to
[GitHub Releases](https://github.com/nftuoa/dsh-zotero/releases).

### D. Publish to npm (optional)

The local package name `@local/dsh-zotero` is intentionally not publishable. To publish:

1. rename `"name"` in `package.json` to your scope (e.g. `@yourname/dsh-zotero`);
2. update `name:` in `cordis.patch.yml` and the profile bundle string to match;
3. `npm publish --access public`.

Users can then install it through **Plugins → Add plugin** by package name.

## Configuration

Defaults require no configuration: `dataDir` is detected from `$ZOTERO_DATA_DIR` or `~/Zotero`, and
the local API defaults to `http://127.0.0.1:23119`. Override them in the profile patch layer
(`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: zotero
  config:
    dataDir: /home/you/Zotero        # Zotero data directory
    localAPI: http://127.0.0.1:23119 # only while Zotero runs
    cacheDir: ~/.cache/dsh-zotero    # snapshot cache (optional)
```

For the local-API fallback (only needed on old Node or when the DB is unreadable while Zotero runs),
enable Zotero → Settings → Advanced → **Allow other applications on this computer to communicate
with Zotero**.

## Compatibility

- Tested on DSH **0.2.1-rc.2**. The browser half uses public `/client` exports
  (`uiConversation.binding(...).target('chat')`, ChatSnapshot) to render the paper transcript.
  If a future DSH changes those internals, the PDF reader still works and the chat pane shows a
  retryable error; **↗** still opens the session in the native DSH conversation.
- Host APIs used: `ctx.webServer.register`, optional `ctx.tools` plus plain-object tool definitions.
  No DSH package imports, so no npm dependency resolution is needed at runtime.
- The plugin serves `/zotero/*` on the same origin as the DSH Web UI (no extra port, no CORS). It is
  local-only like the rest of the DSH server; do not expose the DSH Web UI publicly without putting
  authentication in front of it.

## Troubleshooting

| symptom | fix |
| --- | --- |
| Zotero entry missing | profile bundle not enabled, or the GUI page not refreshed |
| “未找到 Zotero 数据” | open Zotero once to create `zotero.sqlite`, or set `dataDir` |
| `node:sqlite` error | run DSH on Node ≥ 22.13/24, or keep Zotero open with local API enabled |
| 本地 API 403 | enable *Allow other applications…* in Zotero Advanced settings |
| formulas stay as TeX | check `/zotero/katex/katex.min.css` loads (network panel); reload the page |
| `zotero_paper` fails | install `pdftotext` (poppler), or let the model read the PDF path directly |
| 标注 tab says writes need local API | enable *Allow other applications…* in Zotero → Settings → Advanced, keep Zotero running |
| first “保存高亮” hangs | Zotero is showing an authorization dialog; choose **Always Allow** |

Uninstall: remove `@local/dsh-zotero` from the profile dependencies and the `dsh.profile.bundles`
list (or use **Plugins → Remove**), then refresh. The Zotero library is never modified.

## Packaging

```bash
npm pack                 # tarball includes lib, assets, vendor, patch, README, LICENSE, icon
tar -tzf dsh-zotero-1.0.1.tgz | head
```

`vendor/` lives **outside** `node_modules` (`vendor/pdfjs`, `vendor/katex`) because npm always
excludes `node_modules` from tarballs. Third-party licenses: pdf.js is Apache-2.0, KaTeX is MIT;
both LICENSE files stay in `vendor/`.

## Architecture

| half | file | role |
| --- | --- | --- |
| host | `lib/index.js` | cordis plugin: registers the `/zotero` route prefix and optional model tools |
| host | `lib/zotero-data.mjs` | read-only SQLite snapshot reader, local-API fallback, PDF resolution |
| host | `lib/routes.mjs` | JSON API, PDF streaming (Range/HEAD), static viewer + pdf.js assets |
| host | `assets/viewer.{html,js}` | self-contained PDF.js reader page (canvas + selectable text layer) |
| host | `vendor/pdfjs`, `vendor/katex` | vendored pdf.js and KaTeX runtime (JS/CSS/fonts, no CDN) |
| host | `lib/tool.mjs` | `zotero_paper` / `zotero_search` model tools (optional) |
| host | `lib/local-api.mjs` | Zotero local-API write client (authorization, server id, item CRUD) |
| client | `lib/client.js` | hand-written lazy-CJS browser plugin: sidebar entry + main panel |

### HTTP surface

```
GET /zotero/api/status                     library source, counts, diagnostics
GET /zotero/api/items?q=&limit=&offset=    item list (searchable)
GET /zotero/api/items?collection=<KEY>     papers directly in one folder
GET /zotero/api/items?unfiled=1            papers in no folder
GET /zotero/api/item/:itemKey              item detail + PDF metadata (absolute path)
GET /zotero/api/collections                folder tree (parentKey, count/totalCount) + unfiledCount
GET /zotero/api/annotations/:itemKey       native annotations + notes + `writable`
POST /zotero/api/annotations               create highlight / update comment+color
POST /zotero/api/notes                     create / update a Zotero child note
GET /zotero/file/:attachmentKey            PDF bytes (Range + HEAD)
GET /zotero/viewer.html?file=/zotero/file/…  the reader page
GET /zotero/pdfjs/*                        vendored pdf.js runtime
GET /zotero/katex/*                        vendored KaTeX (JS/CSS/fonts)
```

### Why the SQLite snapshot

Zotero holds an exclusive lock while it runs and its local HTTP API only exists while Zotero is
open. A read-only copy of `zotero.sqlite` (plus `-wal`/`-shm`) refreshed on demand gives the panel a
stable, offline library view; the local API is used only as a metadata fallback when the DB is
missing.

## Development

```bash
cd ~/dsh-zotero
node test/host.test.mjs        # host data layer + routes (16 tests)
node --test test/local-api.test.mjs test/write-routes.test.mjs
                               # local-API auth/writes + annotation/note routes (4 tests)
node client-test/smoke.mjs     # client bundle + helpers + note sanitizer + progress (38 checks)
node client-test/e2e.mjs <url> # live GUI: reader, chat, sessions, math (20 checks)
```

Build/debug against an isolated profile instead of the live GUI:

```bash
DSH_HOME="$HOME/.dsh-zotero-test" \
  dsh --profile zotero-test --port 3302 --no-open
```

`CONTRACT.md` documents the pack between the host and browser halves.
