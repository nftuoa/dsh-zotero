# client-test — browser half verification

`lib/client.js` is a hand-written lazy-CJS bundle with no build step. These two
scripts exercise it without the DSH shell and against a real DSH Web GUI.

```
cd ~/dsh-zotero
node client-test/smoke.mjs        # offline: fake loader/DOM + React SSR + paper-chat helpers (33 checks)
node client-test/e2e.mjs <url>    # live: drives headless Chrome over CDP
```

`react`/`react-dom` 18 live in `client-test/node_modules` (installed from this
folder's `package.json`); the smoke test needs nothing else.

## smoke.mjs

- Reproduces `window.__ModuleLoader__.load({ id, factory })` with a fake
  `window`, `document`, `localStorage` and a stubbed `fetch`.
- Asserts the factory requires only `react` and returns `name/inject/apply`.
- Runs `apply()` against a mock slots context: exactly one `sidebar.panellist`
  entry (`id: 'zotero'`, `order: 30`, label `Zotero`) and one `main` entry
  (`key: 'zotero'`, lazy `pluginCtx` inject); services must not be resolved at
  apply time.
- Server-renders the panel with `react-dom/server` (loading list, empty reader)
  and with restored `localStorage` state; checks the injected stylesheet is
  idempotent and has no external URLs.
- Asserts the prompt templates (first turn vs follow-up, with and without a
  selection), the folder-tree builder, author/type/page helpers, the per-paper
  session map, transcript node mapping (`user` / `assistant-step` / `turn-error`)
  and the tiny markdown renderer.

## e2e.mjs

Starts from a running test GUI and a headless Chrome with remote debugging:

```
# terminal 1 — test GUI (prints a token URL)
DSH_HOME="$HOME/.dsh-zotero-test" dsh --profile zotero-test --port 3302 --no-open

# terminal 2 — headless Chrome
google-chrome-stable --headless=new --no-sandbox --user-data-dir=/tmp/cdp-client \
  --remote-debugging-port=9223 about:blank

# terminal 3 — drive it
CDP_PORT=9223 node client-test/e2e.mjs "http://127.0.0.1:3302/?token=…"
```

The driver saves screenshots and `e2e-report.json` under `SHOTS_DIR`
(default `$HOME/zotero-shots`) and exits non-zero when a check fails:

| file | phase |
| --- | --- |
| `10-panel-list.png` | library list + folder rail |
| `12-reader-chat.png` | paper reader with the chat pane docked right |
| `13-selection-chat.png` | selection chip + highlighted selection, still alive after 2s |
| `14-chat-answer.png` | question in the paper's own chat and the assistant answer |
| `14b-math.png` | LaTeX answer rendered through KaTeX |
| `15-second-session.png` | second session for the same paper (empty) |
| `16-switch-back.png` | switching back restores the first transcript |
| `17-other-paper.png` | another paper gets its own empty session |

The run also verifies the main DSH session id is unchanged by asking, the paper
map keeps one session after the first ask, the session dropdown lists both
sessions, and a requested `$E=mc^2$` answer renders as KaTeX (not raw TeX).

The answer check needs model credentials in the test profile (a `.credentials.yaml`
in its DSH home); without them the turn ends in `MISSING_CREDENTIAL` and the run
reports the failure instead of passing.

Notes:

- Same-origin reader access is guaranteed because `/zotero/viewer.html` is
  served by the plugin host; the driver synthesizes a DOM range inside the
  iframe's TextLayer and checks the selection survives a 2s wait.
- The run starts from a clean panel state (`dsh.zotero.v1` and
  `dsh.zotero.paperChats.v1` are cleared) and sets a 1440×900 viewport.
