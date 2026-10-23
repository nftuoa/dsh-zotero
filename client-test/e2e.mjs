// End-to-end driver for the Zotero panel in a real DSH Web GUI.
//
// Covers the paper-chat design:
//   1. open the panel, list and folder rail;
//   2. open a paper, confirm the PDF reader and the right-hand chat pane;
//   3. select text in the PDF and confirm the selection survives re-renders
//      (the old floating composer rebuilt the text layer and lost it);
//   4. ask a question in the paper's own session, wait for the answer, and
//      confirm the main DSH conversation was not used or switched;
//   5. create another session for the same paper and switch between them;
//   6. open a different paper and confirm it gets its own session.
//
// Usage:
//   CDP_PORT=9223 node client-test/e2e.mjs "http://127.0.0.1:3302/?token=..."
//   SHOTS_DIR=$HOME/zotero-shots CDP_PORT=9223 node client-test/e2e.mjs <url>
//
// The GUI must be reachable and the test profile needs model credentials for
// the answer step; without them the turn fails and the test reports it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const url = process.argv[2]
const port = process.env.CDP_PORT || '9223'
const shotsDir = process.env.SHOTS_DIR || path.join(os.homedir(), 'zotero-shots')
if (!url) {
  console.error('usage: node client-test/e2e.mjs <gui-url-with-token>')
  process.exit(2)
}
fs.mkdirSync(shotsDir, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- tiny CDP client --------------------------------------------------------

const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error('no page target on port ' + port)
  process.exit(2)
}
const socket = new WebSocket(page.webSocketDebuggerUrl)
let messageId = 0
const pending = new Map()
const consoleLog = []
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    consoleLog.push('[' + message.params.type + '] ' + message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 400))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleLog.push('[exception] ' + JSON.stringify(message.params.exceptionDetails).slice(0, 400))
  }
}
await new Promise((resolve) => { socket.onopen = resolve })

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++messageId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails
    throw new Error('evaluate failed: ' + ((detail.exception && detail.exception.description) || detail.text || 'unknown'))
  }
  return result.result?.value
}

async function waitFor(expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error('timeout waiting for: ' + label + (lastError ? ' (' + lastError.message + ')' : ''))
}

async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(shotsDir, name), Buffer.from(result.data, 'base64'))
  console.log('  screenshot ' + name)
}

const checks = []
function expect(name, condition, detail) {
  checks.push({ name, ok: !!condition, detail: detail === undefined ? null : detail })
  console.log((condition ? '  ✓ ' : '  ✗ ') + name + (condition || detail === undefined ? '' : ' — ' + String(detail).slice(0, 240)))
  return !!condition
}

// --- flow -------------------------------------------------------------------

console.log('E2E against ' + url)
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url })
await waitFor("[...document.querySelectorAll('button')].some(function(b){return b.getAttribute('aria-label')==='Zotero'})", 30000, 'Zotero sidebar button')
await sleep(1000)
await evaluate("localStorage.removeItem('dsh.zotero.paperChats.v1'); localStorage.removeItem('dsh.zotero.v1')")
await evaluate("(function(){var b=[...document.querySelectorAll('button')].find(function(x){return x.getAttribute('aria-label')==='Zotero'});b.click();return true})()")
await waitFor("!!document.querySelector('.zot-root')", 10000, 'zotero panel')
await waitFor("document.querySelectorAll('.zot-item').length > 0", 20000, 'library list')
await sleep(500)

const listInfo = await evaluate(`(function(){
  var rows=[...document.querySelectorAll('.zot-item')];
  return { count: rows.length, firstPdf: rows.some(function(r){return !!r.querySelector('.zot-pdf-dot')}) }
})()`)
expect('library list renders rows', listInfo.count > 0, listInfo.count)
expect('folder rail renders', await evaluate("!!document.querySelector('.zot-folders') && document.querySelectorAll('.zot-folder-row').length > 2"))
await shot('10-panel-list.png')

// Open the first paper that has a PDF.
await evaluate(`(function(){
  var row=[...document.querySelectorAll('.zot-item')].find(function(r){return !!r.querySelector('.zot-pdf-dot')});
  if(row) row.click();
  return !!row
})()`)
await waitFor("!!document.querySelector('.zot-paper-title')", 20000, 'paper header')
await waitFor(`(function(){var f=document.querySelector('.zot-frame');try{return !!f && f.contentDocument.querySelectorAll('.textLayer span').length>100}catch(e){return false}})()`, 40000, 'pdf.js viewer')
await waitFor("!!document.querySelector('.zot-chat-pane')", 20000, 'paper chat pane')
await sleep(800)
const chatInfo = await evaluate(`(function(){
  var pane=document.querySelector('.zot-chat-pane');
  return {
    pane: !!pane,
    empty: !!document.querySelector('.zot-chat-empty'),
    placeholder: (document.querySelector('.zot-chat-composer textarea')||{}).placeholder || '',
    hasSelect: !!document.querySelector('.zot-chat-select'),
    paperKey: (function(){try{var m=JSON.parse(localStorage.getItem('dsh.zotero.paperChats.v1')||'{}');return Object.keys(m)[0]||null}catch(e){return null}})()
  }
})()`)
expect('chat pane is docked right of the paper', chatInfo.pane, chatInfo.pane)
expect('new paper starts with an empty dedicated chat', chatInfo.empty, chatInfo.empty)
expect('composer invites a whole-paper question', chatInfo.placeholder.indexOf('问这篇论文') >= 0, chatInfo.placeholder)
expect('one paper session is registered', !!chatInfo.paperKey, chatInfo.paperKey)
await shot('12-reader-chat.png')

// Select text and make sure the selection survives at least 2s (the old
// implementation re-rendered the text layer and cleared it immediately).
await evaluate(`(function(){
  var f=document.querySelector('.zot-frame');
  var d=f.contentDocument, w=f.contentWindow;
  var spans=[...d.querySelectorAll('.textLayer span')].filter(function(s){return (s.textContent||'').trim().length>12});
  if(!spans.length) return false;
  var start=Math.min(3, spans.length-2);
  var end=Math.min(start+3, spans.length-1);
  var range=d.createRange();
  range.setStart(spans[start].firstChild,0);
  range.setEnd(spans[end].firstChild,spans[end].textContent.length);
  var sel=w.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  return sel.toString().length>0
})()`)
await waitFor("!!document.querySelector('.zot-sel-chip')", 8000, 'selection chip')
await sleep(2200)
const selectionInfo = await evaluate(`(function(){
  var f=document.querySelector('.zot-frame');
  var inFrame=f.contentWindow.getSelection().toString();
  return { chip:(document.querySelector('.zot-sel-chip')||{}).textContent||'', inFrame:inFrame.length, scale:(function(){var t=f.contentDocument.querySelector('.textLayer');return t?getComputedStyle(t).getPropertyValue('--total-scale-factor'):null})() }
})()`)
expect('selection chip reports the selected text', /已选\s*\d+\s*字/.test(selectionInfo.chip), selectionInfo.chip)
expect('selection is still alive after 2s', selectionInfo.inFrame > 0, selectionInfo.inFrame)
expect('text layer has a scale factor (alignment fix)', Number(selectionInfo.scale) > 0, selectionInfo.scale)
await shot('13-selection-chat.png')

// Ask in the paper's own session.
const question = '这篇论文的核心贡献是什么？请用两点概括。'
const mainSessionBefore = await evaluate("(JSON.parse(localStorage.getItem('dsh.sessions.current')||'null')||{}).sessionId || null")
await evaluate(`(function(){
  var t=document.querySelector('.zot-chat-composer textarea');
  var set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
  set.call(t, ${JSON.stringify(question)});
  t.dispatchEvent(new Event('input',{bubbles:true}));
  return t.value
})()`)
await evaluate("[...document.querySelectorAll('.zot-chat-composer button')].find(function(b){return b.innerText.trim()==='发送'}).click()")
await waitFor("document.querySelectorAll('.zot-msg-user').length > 0", 20000, 'user message in paper chat')
const userShown = await evaluate(`(function(){
  var row=document.querySelector('.zot-msg-user');
  return { text:(row||{}).innerText||'', chip:(row&&row.querySelector('.zot-msg-context')||{}).innerText||'' }
})()`)
expect('user bubble shows the question, not the whole prompt', userShown.text.indexOf('这篇论文的核心贡献') >= 0 && userShown.text.indexOf('【论文信息】') < 0, userShown.text.slice(0, 120))
expect('user bubble shows the selection context badge', /框选\s*\d+\s*字/.test(userShown.chip), userShown.chip)

// Wait for the answer (or an explicit turn error).
await waitFor(`(function(){
  var t=document.body.innerText;
  if(t.indexOf('MISSING_CREDENTIAL')>=0 || t.indexOf('This turn failed')>=0) return true;
  var rows=[...document.querySelectorAll('.zot-msg-assistant')];
  return rows.some(function(r){var x=r.innerText.trim();return x.length>40 && x.indexOf('正在')<0});
})()`, 180000, 'assistant answer')
const answerInfo = await evaluate(`(function(){
  var rows=[...document.querySelectorAll('.zot-msg-assistant')];
  var last=rows[rows.length-1];
  return { text:(last||{}).innerText||'', failed:document.body.innerText.indexOf('MISSING_CREDENTIAL')>=0 }
})()`)
expect('assistant answer arrives in the paper chat', answerInfo.text.trim().length > 20 && !answerInfo.failed, answerInfo.text.slice(0, 120))
const mainSessionAfter = await evaluate("(JSON.parse(localStorage.getItem('dsh.sessions.current')||'null')||{}).sessionId || null")
expect('asking does not switch the main DSH session', mainSessionBefore === mainSessionAfter, mainSessionBefore + ' -> ' + mainSessionAfter)
const afterAnswer = await evaluate(`(function(){
  var m=JSON.parse(localStorage.getItem('dsh.zotero.paperChats.v1')||'{}');
  var key=Object.keys(m)[0];
  return { sessions:m[key].sessions.length, active:m[key].active }
})()`)
expect('paper keeps one session after the first ask', afterAnswer.sessions === 1, JSON.stringify(afterAnswer))
await shot('14-chat-answer.png')

// LaTeX formulas must render through the vendored KaTeX, not as raw TeX.
await evaluate(`(function(){
  var t=document.querySelector('.zot-chat-composer textarea');
  var set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
  set.call(t, '请只回复这个公式，不要代码块、不要解释：$E=mc^2$');
  t.dispatchEvent(new Event('input',{bubbles:true}));
  return true
})()`)
await evaluate("[...document.querySelectorAll('.zot-chat-composer button')].find(function(b){return b.innerText.trim()==='发送'}).click()")
await waitFor("document.querySelectorAll('.zot-chat-pane .katex').length > 0", 120000, 'KaTeX formula')
const mathInfo = await evaluate(`(function(){
  var pane=document.querySelector('.zot-chat-pane');
  return {
    katex: pane.querySelectorAll('.katex').length,
    loaded: !!(window.katex && window.katex.renderToString),
    css: !!document.querySelector('link[data-zotero-katex]'),
    pending: pane.querySelectorAll('.zot-math-pending').length
  }
})()`)
expect('LaTeX formulas render with KaTeX', mathInfo.katex > 0 && mathInfo.loaded && mathInfo.pending === 0, JSON.stringify(mathInfo))
await shot('14b-math.png')

// A second session for the same paper must start empty and keep both histories.
await evaluate("[...document.querySelectorAll('.zot-chat-head button')].find(function(b){return b.getAttribute('title')==='新建这篇论文的对话'}).click()")
await waitFor("!!document.querySelector('.zot-chat-empty')", 15000, 'fresh paper chat')
const second = await evaluate(`(function(){
  var m=JSON.parse(localStorage.getItem('dsh.zotero.paperChats.v1')||'{}');
  var key=Object.keys(m)[0];
  return { sessions:m[key].sessions.length, messages:document.querySelectorAll('.zot-msg').length, options:document.querySelectorAll('.zot-chat-select option').length }
})()`)
expect('new conversation adds a second session for the same paper', second.sessions === 2 && second.messages === 0, JSON.stringify(second))
expect('session dropdown lists both sessions', second.options === 2, second.options)
await shot('15-second-session.png')

// Switch back to the first session: its history must return.
await evaluate(`(function(){
  var s=document.querySelector('.zot-chat-select');
  var set=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
  set.call(s, s.options[0].value);
  s.dispatchEvent(new Event('change',{bubbles:true}));
  return true
})()`)
await waitFor("document.querySelectorAll('.zot-msg').length > 0", 15000, 'restored first session')
const restored = await evaluate("({messages:document.querySelectorAll('.zot-msg').length, empty:!!document.querySelector('.zot-chat-empty')})")
expect('switching sessions restores the previous transcript', restored.messages > 0 && !restored.empty, JSON.stringify(restored))
await shot('16-switch-back.png')

// Another paper gets its own session, not the previous one.
await evaluate(`(function(){
  var rows=[...document.querySelectorAll('.zot-item')];
  var current=document.querySelector('.zot-paper-title').innerText;
  var other=rows.find(function(r){return r.querySelector('.zot-pdf-dot') && r.innerText.indexOf(current.slice(0,20))<0});
  if(other) other.click();
  return !!other
})()`)
await waitFor("!!document.querySelector('.zot-chat-pane')", 20000, 'second paper chat')
await waitFor("!!document.querySelector('.zot-chat-empty')", 20000, 'second paper empty chat')
const secondPaper = await evaluate(`(function(){
  var m=JSON.parse(localStorage.getItem('dsh.zotero.paperChats.v1')||'{}');
  return { keys:Object.keys(m).length, empty:!!document.querySelector('.zot-chat-empty') }
})()`)
expect('a different paper gets its own empty session', secondPaper.keys >= 2 && secondPaper.empty, JSON.stringify(secondPaper))
await shot('17-other-paper.png')

console.log('E2E summary: ' + checks.filter((check) => check.ok).length + '/' + checks.length + ' checks passed')
fs.writeFileSync(path.join(shotsDir, 'e2e-report.json'), JSON.stringify({
  checks: checks.length,
  failed: checks.filter((check) => !check.ok),
  listInfo,
  chatInfo,
  selectionInfo,
  userShown,
  answerInfo,
  mainSessionBefore,
  mainSessionAfter,
  afterAnswer,
  second,
  restored,
  secondPaper,
  consoleErrors: consoleLog.filter((line) => line.indexOf('[error]') >= 0 || line.indexOf('exception') >= 0),
}, null, 2))
socket.close()
process.exit(checks.some((check) => !check.ok) ? 1 : 0)
