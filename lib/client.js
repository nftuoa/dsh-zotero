// @local/dsh-zotero — browser half.
//
// Hand-written lazy-CJS client bundle for the DSH Web GUI. The factory body is
// deliberately plain (no JSX, no build step) and only React 18 is imported.
//
// What this file contributes:
//   * a "Zotero" sidebar panellist entry (book/Z icon);
//   * a global main-panel component ("two columns": searchable library list on
//     the left, paper metadata + same-origin pdf.js reader on the right);
//   * selection capture inside the reader iframe and a floating ask bar that
//     composes a Chinese prompt and sends it into a fresh DSH chat session.
//
// The host half (lib/index.js + assets/viewer.*) owns the HTTP surface:
//   GET /zotero/api/status | /api/items?q=&collection= | /api/item/:key | /api/collections
//   GET /zotero/viewer.html?file=/zotero/file/<attachmentKey>
window.__ModuleLoader__.load({
  id: '@local/dsh-zotero',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')
    const h = react.createElement

    // --- Constants ---------------------------------------------------------

    const PANEL_ID = 'zotero'
    const API = '/zotero/api'
    const LS_KEY = 'dsh.zotero.v1'
    const SEARCH_DEBOUNCE_MS = 250
    const SELECTION_DEBOUNCE_MS = 120
    const MAX_SELECTION_CHARS = 4000
    const MAX_LIST_ITEMS = 200
    const DEFAULT_QUESTION = '请解释我框选的这段内容，并指出它在论文论证中的作用。'
    const DEFAULT_PAPER_QUESTION = '请总结这篇论文的核心贡献、方法要点与主要结论。'
    const COLLECTION_ALL = ''
    const COLLECTION_UNFILED = '__unfiled__'
    const PAPER_CHATS_KEY = 'dsh.zotero.paperChats.v1'
    const PROGRESS_KEY = 'dsh.zotero.progress.v1'
    const CHAT_MAX_INPUT = 2000
    const KATEX_BASE = '/zotero/katex'
    const STYLE_ID = 'dsh-zotero-styles'
    const EMPTY_SELECTION = { text: '', page: null }

    // --- Small utilities ---------------------------------------------------

    function cxs() {
      const out = []
      for (let i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i])
      return out.join(' ')
    }

    function isAbortError(error) {
      return !!error && (error.name === 'AbortError' || error.code === 20)
    }

    function errorMessage(error) {
      if (!error) return '未知错误'
      if (typeof error === 'string') return error
      return error.message || String(error)
    }

    function isFiniteNumber(value) {
      return typeof value === 'number' && isFinite(value)
    }

    /** Translate low-level fetch failures into copy the user can act on. */
    function describeFetchError(error) {
      const message = errorMessage(error)
      if (/failed to fetch|networkerror|load failed|fetch failed/i.test(message)) {
        return '无法连接到 Zotero 插件主机，请确认插件已加载后重试。'
      }
      return message
    }

    /** Read persisted UI state, tolerating private mode / corrupted values. */
    function readPersisted() {
      const out = { q: '', collection: '', itemKey: null }
      try {
        const store = typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
        if (!store) return out
        const raw = store.getItem(LS_KEY)
        if (!raw) return out
        const value = JSON.parse(raw)
        if (value && typeof value.q === 'string') out.q = value.q
        if (value && typeof value.collection === 'string') out.collection = value.collection
        if (value && typeof value.itemKey === 'string' && value.itemKey) out.itemKey = value.itemKey
      } catch (error) {
        /* corrupted entry or storage disabled — start fresh */
      }
      return out
    }

    function persistUiState(state) {
      try {
        const store = typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
        if (!store) return
        store.setItem(LS_KEY, JSON.stringify({
          q: state.q || '',
          collection: state.collection || '',
          itemKey: state.itemKey || null,
        }))
      } catch (error) {
        /* storage may be full or disabled; persistence is a nicety */
      }
    }

    /** Injected services only exist once their feature plugins are up, so all
     *  lookups happen lazily at action time and never throw during apply(). */
    function getService(ctx, name) {
      if (!ctx || typeof ctx.get !== 'function') return undefined
      try {
        return ctx.get(name)
      } catch (error) {
        return undefined
      }
    }

    async function fetchJSON(url, signal) {
      const response = await fetch(url, {
        signal: signal,
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (!response.ok) {
        const detail = payload && payload.error && payload.error.message
        const failure = new Error(detail || 'HTTP ' + response.status)
        failure.status = response.status
        throw failure
      }
      return payload || {}
    }

    async function postJSON(url, body, signal) {
      const response = await fetch(url, {
        method: 'POST',
        signal: signal,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body || {}),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (!response.ok) {
        const detail = payload && payload.error && payload.error.message
        const failure = new Error(detail || 'HTTP ' + response.status)
        failure.status = response.status
        throw failure
      }
      return payload || {}
    }

    // --- Zotero data presentation helpers ----------------------------------

    function creatorName(creator) {
      if (!creator) return ''
      // The host already collapses single-field creators into `name`.
      if (creator.name) return String(creator.name).trim()
      const parts = []
      if (creator.firstName) parts.push(String(creator.firstName).trim())
      if (creator.lastName) parts.push(String(creator.lastName).trim())
      return parts.join(' ')
    }

    /** "A、B、C" with an optional "等" suffix for over-long author lists. */
    function authorLine(creators, max) {
      if (!Array.isArray(creators) || creators.length === 0) return ''
      const names = creators.map(creatorName).filter(Boolean)
      if (names.length === 0) return ''
      if (max && names.length > max) return names.slice(0, max).join('、') + ' 等'
      return names.join('、')
    }

    function itemYear(item) {
      if (!item) return ''
      if (item.year) return String(item.year)
      if (item.date) {
        const match = String(item.date).match(/(\d{4})/)
        return match ? match[1] : ''
      }
      return ''
    }

    const TYPE_LABELS = {
      journalArticle: '期刊论文',
      conferencePaper: '会议论文',
      book: '图书',
      bookSection: '图书章节',
      thesis: '学位论文',
      preprint: '预印本',
      report: '报告',
      manuscript: '手稿',
      dataset: '数据集',
      magazineArticle: '杂志文章',
      newspaperArticle: '报纸文章',
      webpage: '网页',
      blogPost: '博客',
      forumPost: '论坛帖',
      document: '文档',
      note: '笔记',
      attachment: '附件',
      patent: '专利',
      presentation: '演示文稿',
      computerProgram: '软件',
      artwork: '艺术作品',
      audioRecording: '音频',
      videoRecording: '视频',
      film: '影片',
      interview: '访谈',
      letter: '信件',
      memo: '备忘录',
      email: '邮件',
      map: '地图',
      podcast: '播客',
    }

    function typeLabel(itemType) {
      if (!itemType) return ''
      return TYPE_LABELS[itemType] || String(itemType)
    }

    function publicationOf(paper) {
      if (!paper) return ''
      return paper.publication || paper.publicationTitle || ''
    }

    function pdfPathOf(paper) {
      if (!paper) return ''
      if (paper.pdf && paper.pdf.path) return String(paper.pdf.path)
      return ''
    }

    /** The reader iframe URL for an attachment key (same-origin viewer). */
    function viewerUrl(attachmentKey) {
      return '/zotero/viewer.html?file=' + encodeURIComponent('/zotero/file/' + attachmentKey)
    }

    /** Nearest [data-page] ancestor of a DOM node, written by the viewer page. */
    function pageOfNode(node) {
      let current = node
      while (current) {
        if (current.nodeType === 1 && current.hasAttribute && current.hasAttribute('data-page')) {
          const page = Number(current.getAttribute('data-page'))
          return isFiniteNumber(page) && page > 0 ? page : null
        }
        current = current.parentNode
      }
      return null
    }

    /** Page number behind a Selection (anchor first, range start as fallback). */
    function pageOfSelection(selection) {
      if (!selection) return null
      let page = pageOfNode(selection.anchorNode)
      if (page !== null) return page
      try {
        if (selection.rangeCount > 0) page = pageOfNode(selection.getRangeAt(0).startContainer)
      } catch (error) {
        page = null
      }
      return page
    }

    /**
     * Compose the chat prompt. Structure is fixed by CONTRACT.md §2 — keep the
     * blank lines, labels and the trailing PDF hint byte-for-byte stable.
     */
    function buildPrompt(paper, selectedText, page, question) {
      const source = paper || {}
      const title = source.title ? String(source.title).trim() : '未命名文献'
      const authors = authorLine(source.creators) || '未知作者'
      const year = itemYear(source) || '—'
      const publication = publicationOf(source) || '—'
      const doi = source.doi ? String(source.doi).trim() : '—'
      const pdfPath = pdfPathOf(source) || '—'
      const itemKey = source.key ? String(source.key).trim() : '—'
      const selection = String(selectedText || '').trim().slice(0, MAX_SELECTION_CHARS)
      const asked = String(question || '').trim() || (selection ? DEFAULT_QUESTION : DEFAULT_PAPER_QUESTION)
      const pageNumber = page == null ? 1 : page
      const lines = ['我在阅读论文《' + title + '》（' + authors + '；' + year + '）。']
      if (selection) lines.push('', '【框选内容 · 第' + pageNumber + '页】', selection)
      lines.push(
        '',
        '【论文信息】',
        '- 标题：' + title,
        '- 作者：' + authors,
        '- 年份：' + year,
        '- 出版物：' + publication,
        '- DOI：' + doi,
        '- PDF 路径：' + pdfPath,
        '- Zotero Key：' + itemKey,
        '',
        '我的问题：' + asked,
        '',
        '（如需更多上下文，优先调用 zotero_paper 工具，参数 itemKey 为上面的 Zotero Key；也可以直接读取上面的 PDF 路径获取全文。）',
      )
      return lines.join('\n')
    }

    /**
     * Turn the flat collection rows from `/zotero/api/collections` into a
     * stable folder tree. Unknown parents become roots; cycles cannot loop.
     * @param {Array<object>} source - collection rows.
     * @returns {Array<object>} root nodes, each with a `children` array.
     */
    function buildCollectionTree(source) {
      const rows = Array.isArray(source)
        ? source.filter((row) => row && typeof row.key === 'string' && row.key.length > 0)
        : []
      const byKey = new Map(rows.map((row) => [row.key, Object.assign({}, row, { children: [] })]))
      const roots = []
      for (const node of byKey.values()) {
        const parent = node.parentKey && node.parentKey !== node.key ? byKey.get(node.parentKey) : undefined
        if (parent) parent.children.push(node)
        else roots.push(node)
      }
      const sortLevel = (nodes) => {
        nodes.sort((a, b) => String(a.name || a.key).localeCompare(String(b.name || b.key), 'zh-Hans'))
        for (const node of nodes) sortLevel(node.children)
      }
      sortLevel(roots)
      return roots
    }

    /** Read the paper -> chat-session map from localStorage. */
    function readPaperChats() {
      try {
        const store = typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
        if (!store) return {}
        const raw = store.getItem(PAPER_CHATS_KEY)
        if (!raw) return {}
        const value = JSON.parse(raw)
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
        const out = {}
        for (const key of Object.keys(value)) {
          const entry = value[key]
          if (!entry || typeof entry !== 'object' || !Array.isArray(entry.sessions)) continue
          const sessions = entry.sessions
            .filter((session) => session && typeof session.id === 'string' && session.id)
            .map((session) => ({
              id: session.id,
              title: typeof session.title === 'string' ? session.title : '',
              createdAt: isFiniteNumber(session.createdAt) ? session.createdAt : 0,
            }))
          if (sessions.length === 0) continue
          const active = sessions.some((session) => session.id === entry.active) ? entry.active : sessions[0].id
          out[key] = { active, sessions }
        }
        return out
      } catch (error) {
        return {}
      }
    }

    function writePaperChats(value) {
      try {
        const store = typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
        if (!store) return
        store.setItem(PAPER_CHATS_KEY, JSON.stringify(value || {}))
      } catch (error) {
        /* storage may be full or disabled; chat still works this session */
      }
    }

    /** Read per-PDF reading progress from localStorage. */
    function readProgress() {
      try {
        const store = typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
        if (!store) return {}
        const value = JSON.parse(store.getItem(PROGRESS_KEY) || '{}')
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      } catch (error) {
        return {}
      }
    }

    function writeProgress(attachmentKey, progress) {
      if (!attachmentKey || !progress || !isFiniteNumber(progress.page)) return
      try {
        const store = typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
        if (!store) return
        const map = readProgress()
        map[attachmentKey] = {
          page: Math.max(1, Math.round(progress.page)),
          ratio: Math.min(1, Math.max(0, Number(progress.ratio) || 0)),
          updatedAt: Date.now(),
        }
        store.setItem(PROGRESS_KEY, JSON.stringify(map))
      } catch (error) { /* storage full/disabled */ }
    }

    /** Escape plain text for safe HTML embedding. */
    function escapeHtml(text) {
      return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    /** Turn a plain-text note draft into Zotero note HTML; keep authored HTML. */
    function noteHtmlFromText(text) {
      const raw = String(text || '')
      if (/<\s*[a-z][\s\S]*>/i.test(raw)) return raw
      const paragraphs = raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
      const body = paragraphs.length > 0
        ? paragraphs.map((part) => '<p>' + escapeHtml(part).replace(/\n/g, '<br>') + '</p>').join('')
        : '<p></p>'
      return '<div class="zotero-note znv1">' + body + '</div>'
    }

    /**
     * Whitelist-sanitize Zotero note HTML before it is injected into the page.
     * Notes are user-authored HTML; scripts, event handlers, and unsafe links
     * never reach the DOM.
     */
    function sanitizeNoteHtml(html) {
      const source = String(html || '')
      if (typeof DOMParser === 'undefined' || typeof document === 'undefined') {
        return escapeHtml(source).replace(/\n/g, '<br>')
      }
      const allowed = new Set([
        'DIV', 'P', 'SPAN', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL',
        'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'CODE', 'PRE', 'A', 'IMG', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
      ])
      const allowedAttributes = new Set(['class', 'title', 'alt', 'href', 'src', 'colspan', 'rowspan'])
      const doc = new DOMParser().parseFromString(source, 'text/html')
      const walk = (node) => {
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === 8) { child.remove(); continue }
          if (child.nodeType !== 1) continue
          if (!allowed.has(child.tagName)) {
            child.replaceWith(document.createTextNode(child.textContent || ''))
            continue
          }
          for (const attribute of Array.from(child.attributes)) {
            const name = attribute.name.toLowerCase()
            if (name.startsWith('on')) { child.removeAttribute(attribute.name); continue }
            if (name === 'href' && !/^https?:\/\//i.test(attribute.value)) { child.removeAttribute(attribute.name); continue }
            if (name === 'src' && !/^(?:data:image\/|https?:\/\/)/i.test(attribute.value)) { child.removeAttribute(attribute.name); continue }
            if (!allowedAttributes.has(name)) child.removeAttribute(attribute.name)
          }
          if (child.tagName === 'A') {
            child.setAttribute('target', '_blank')
            child.setAttribute('rel', 'noreferrer noopener')
          }
          walk(child)
        }
      }
      walk(doc.body)
      return doc.body.innerHTML
    }

    /** Compact paper title for session names and the chat header. */
    function shortTitle(title, max = 30) {
      const text = String(title || '未命名文献').replace(/\s+/g, ' ').trim()
      return text.length > max ? text.slice(0, max - 1) + '…' : text
    }

    /** Extract text from a user-message content block array. */
    function contentText(content) {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (!block) continue
        if (typeof block === 'string') parts.push(block)
        else if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.join('')
    }

    /**
     * Extract the human question / selection from a stored prompt so the chat
     * bubble shows the question instead of the full context envelope.
     */
    function parsePromptForDisplay(text) {
      const raw = String(text || '')
      const selectionMatch = /【框选内容 · 第(\d+)页】\n([\s\S]*?)(?:\n\n【论文信息】|\n\n我的问题：|$)/.exec(raw)
      const questionMatch = /我的问题：([\s\S]*?)(?:\n\n（如需|$)/.exec(raw)
      return {
        page: selectionMatch ? selectionMatch[1] : null,
        selection: selectionMatch ? selectionMatch[2].trim() : '',
        question: questionMatch ? questionMatch[1].trim() : raw.trim(),
      }
    }

    /** Follow-up prompt inside an existing paper session (context is in history). */
    function buildFollowupPrompt(paper, selectedText, page, question) {
      const selection = String(selectedText || '').trim().slice(0, MAX_SELECTION_CHARS)
      const asked = String(question || '').trim() || (selection ? DEFAULT_QUESTION : DEFAULT_PAPER_QUESTION)
      const lines = []
      if (selection) {
        lines.push('【框选内容 · 第' + (page == null ? 1 : page) + '页】', selection, '')
      }
      lines.push('我的问题：' + asked)
      return lines.join('\n')
    }

    /** Map one Chat conversation node to a compact transcript row. */
    function chatMessageOf(node) {
      if (!node || node.visibility !== 'visible') return null
      const data = node.data || {}
      if (node.kind === 'user' || node.kind === 'steering') {
        const text = contentText(data.content)
        return text ? { role: 'user', text } : null
      }
      if (node.kind === 'assistant-step') {
        const blocks = Array.isArray(data.blocks) ? data.blocks : []
        const text = blocks
          .filter((block) => block && block.kind === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
        const tools = blocks
          .filter((block) => block && block.kind === 'tool-call' && typeof block.name === 'string')
          .map((block) => block.name)
        const running = data.status === 'running'
        if (!text && !running) return null
        return { role: 'assistant', text, tools, running }
      }
      if (node.kind === 'turn-error') {
        return { role: 'error', text: String(data.message || (data.error && data.error.message) || '本轮执行失败') }
      }
      if (node.kind === 'turn-max-tokens') {
        return { role: 'error', text: '回答达到长度上限，可以继续提问。' }
      }
      return null
    }

    /** Load KaTeX (JS + CSS) once from the plugin host. Resolves null on failure. */
    let katexPromise = null
    function loadKatex() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(null)
      if (window.katex && typeof window.katex.renderToString === 'function') return Promise.resolve(window.katex)
      if (katexPromise) return katexPromise
      katexPromise = new Promise((resolve) => {
        try {
          if (!document.querySelector('link[data-zotero-katex]')) {
            const link = document.createElement('link')
            link.rel = 'stylesheet'
            link.href = KATEX_BASE + '/katex.min.css'
            link.setAttribute('data-zotero-katex', '1')
            ;(document.head || document.documentElement).appendChild(link)
          }
          const script = document.createElement('script')
          script.src = KATEX_BASE + '/katex.min.js'
          script.async = true
          script.onload = () => resolve(window.katex && window.katex.renderToString ? window.katex : null)
          script.onerror = () => resolve(null)
          ;(document.head || document.documentElement).appendChild(script)
        } catch (error) {
          resolve(null)
        }
      })
      return katexPromise
    }

    /**
     * Split text into plain and math segments. Supports $$…$$, \[…\], \(…\)
     * and inline $…$; escaped \$ stays literal. Unbalanced delimiters are left
     * as plain text so a streaming answer never loses content.
     */
    function splitMathSegments(source) {
      const text = String(source || '')
      const out = []
      let plain = ''
      let i = 0
      const flush = () => {
        if (plain) out.push({ type: 'text', text: plain })
        plain = ''
      }
      while (i < text.length) {
        const char = text[i]
        if (char === '\\' && (text[i + 1] === '$' || text[i + 1] === '\\')) {
          if (text[i + 1] === '$') { plain += '$'; i += 2; continue }
          plain += '\\'; i += 1; continue
        }
        if (char === '$' && text[i + 1] === '$') {
          const end = text.indexOf('$$', i + 2)
          if (end > i + 2) {
            flush()
            out.push({ type: 'display', tex: text.slice(i + 2, end).trim() })
            i = end + 2
            continue
          }
        } else if (char === '$' && text[i + 1] !== '$') {
          let end = i + 1
          while (end < text.length) {
            if (text[end] === '$' && text[end - 1] !== '\\') break
            end += 1
          }
          const tex = text.slice(i + 1, end)
          // Require TeX-like delimiters (no space just inside) so prices such as
          // "$100 and $200" are not turned into math.
          if (end < text.length && tex.trim() && !tex.includes('\n') && !/^\s/.test(tex) && !/\s$/.test(tex)) {
            flush()
            out.push({ type: 'inline', tex: tex.trim() })
            i = end + 1
            continue
          }
        } else if (char === '\\' && (text[i + 1] === '(' || text[i + 1] === '[')) {
          const close = text[i + 1] === '(' ? '\\)' : '\\]'
          const end = text.indexOf(close, i + 2)
          if (end > i + 2) {
            flush()
            out.push({ type: text[i + 1] === '(' ? 'inline' : 'display', tex: text.slice(i + 2, end).trim() })
            i = end + 2
            continue
          }
        }
        plain += char
        i += 1
      }
      flush()
      return out
    }

    /** Render one TeX segment with KaTeX, or fall back to a readable code chip. */
    function renderMath(tex, display, key) {
      const katex = typeof window !== 'undefined' ? window.katex : null
      if (katex && typeof katex.renderToString === 'function') {
        try {
          const html = katex.renderToString(tex, {
            displayMode: !!display,
            throwOnError: false,
            strict: 'ignore',
            trust: false,
            output: 'html',
          })
          if (html) {
            return h('span', {
              key,
              className: display ? 'zot-math zot-math-display' : 'zot-math',
              dangerouslySetInnerHTML: { __html: html },
            })
          }
        } catch (error) { /* fall through to raw TeX */ }
      }
      return h('code', { key, className: display ? 'zot-math-pending zot-math-display' : 'zot-math-pending' }, tex)
    }

    /** Inline formatting for chat markdown: bold, inline code, links, emphasis. */
    function renderTextInline(text, keyPrefix) {
      const nodes = []
      const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|\*[^*\n]+\*)/g
      const source = String(text || '')
      let last = 0
      let match
      let index = 0
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > last) nodes.push(source.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) {
          nodes.push(h('strong', { key: keyPrefix + ':b' + index++ }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          nodes.push(h('code', { key: keyPrefix + ':c' + index++, className: 'zot-md-inline' }, token.slice(1, -1)))
        } else if (token.startsWith('[')) {
          const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token)
          if (link) nodes.push(h('a', { key: keyPrefix + ':a' + index++, href: link[2], target: '_blank', rel: 'noreferrer noopener' }, link[1]))
          else nodes.push(token)
        } else {
          nodes.push(h('em', { key: keyPrefix + ':i' + index++ }, token.slice(1, -1)))
        }
        last = match.index + token.length
      }
      if (last < source.length) nodes.push(source.slice(last))
      return nodes
    }

    function renderInline(text, keyPrefix) {
      const nodes = []
      splitMathSegments(text).forEach((part, index) => {
        if (part.type === 'text') nodes.push(...renderTextInline(part.text, keyPrefix + ':t' + index))
        else nodes.push(renderMath(part.tex, part.type === 'display', keyPrefix + ':m' + index))
      })
      return nodes
    }

    /** Tiny markdown renderer: fenced code, headings, lists, quotes, tables. */
    function renderRichText(text) {
      const source = String(text || '')
      if (!source.trim()) return []
      const blocks = []
      const segments = source.split(/```(\w*)\n?([\s\S]*?)```/)
      let blockIndex = 0
      for (let i = 0; i < segments.length; i += 3) {
        const plain = segments[i]
        const lang = segments[i + 1]
        const code = segments[i + 2]
        if (plain && plain.trim()) blocks.push(...renderMarkdownPlain(plain, 'md' + blockIndex++))
        if (code !== undefined) {
          blocks.push(h('pre', { key: 'code' + blockIndex++, className: 'zot-md-code' }, [
            lang ? h('span', { key: 'lang', className: 'zot-md-lang' }, lang) : null,
            h('code', { key: 'body' }, code.replace(/\n$/, '')),
          ]))
        }
      }
      return blocks
    }

    function renderMarkdownPlain(text, prefix) {
      const lines = String(text).replace(/\r\n/g, '\n').split('\n')
      const out = []
      let i = 0
      let seq = 0
      while (i < lines.length) {
        const line = lines[i]
        if (!line.trim()) { i += 1; continue }
        const fence = /^```/.test(line)
        if (fence) break
        const trimmed = line.trim()
        if (trimmed.startsWith('$$')) {
          if (trimmed.endsWith('$$') && trimmed.length > 4) {
            out.push(renderMath(trimmed.slice(2, -2), true, prefix + ':dm' + seq++))
            i += 1
            continue
          }
          const body = [trimmed.slice(2)]
          i += 1
          while (i < lines.length && !lines[i].trim().endsWith('$$')) { body.push(lines[i]); i += 1 }
          if (i < lines.length) { body.push(lines[i].trim().slice(0, -2)); i += 1 }
          out.push(renderMath(body.join('\n').trim(), true, prefix + ':dm' + seq++))
          continue
        }
        if (trimmed.startsWith('\\[')) {
          const body = [trimmed.slice(2)]
          i += 1
          while (i < lines.length && !lines[i].includes('\\]')) { body.push(lines[i]); i += 1 }
          if (i < lines.length) { body.push(lines[i].replace('\\]', '')); i += 1 }
          out.push(renderMath(body.join('\n').trim(), true, prefix + ':dm' + seq++))
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          out.push(h('div', { key: prefix + ':h' + seq++, className: 'zot-md-h zot-md-h' + heading[1].length }, renderInline(heading[2], prefix + ':h' + seq)))
          i += 1
          continue
        }
        if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && line.trim().replace(/[-*_\s]/g, '') === '') {
          out.push(h('hr', { key: prefix + ':hr' + seq++, className: 'zot-md-hr' }))
          i += 1
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const quote = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i += 1 }
          out.push(h('blockquote', { key: prefix + ':q' + seq++, className: 'zot-md-quote' }, renderInline(quote.join('\n'), prefix + ':q' + seq)))
          continue
        }
        if (/^\s*\|.*\|\s*$/.test(line)) {
          const table = []
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { table.push(lines[i].trim()); i += 1 }
          out.push(h('pre', { key: prefix + ':t' + seq++, className: 'zot-md-table' }, table.join('\n')))
          continue
        }
        if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
          const items = []
          const ordered = /^\s*\d+\.\s+/.test(line)
          while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
            const item = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')
            items.push(h('li', { key: prefix + ':li' + seq++ }, renderInline(item, prefix + ':li' + seq)))
            i += 1
          }
          out.push(h(ordered ? 'ol' : 'ul', { key: prefix + ':l' + seq++, className: 'zot-md-list' }, items))
          continue
        }
        const paragraph = [line]
        i += 1
        while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) && !/^\s*>/.test(lines[i]) && !/^\s*\|/.test(lines[i]) && !/^```/.test(lines[i])) {
          paragraph.push(lines[i])
          i += 1
        }
        out.push(h('p', { key: prefix + ':p' + seq++, className: 'zot-md-p' }, renderInline(paragraph.join('\n'), prefix + ':p' + seq)))
      }
      return out
    }


    // --- Paper chat plumbing (lazy services; never captured at apply time) ---

    /** Retain one session and resolve its chat target (activates the view). */
    async function openChatBinding(ctx, sessionId) {
      const sessions = getService(ctx, 'sessions')
      const uiConversation = getService(ctx, 'uiConversation')
      if (!sessions || typeof sessions.retain !== 'function') throw new Error('会话服务不可用')
      if (!uiConversation || typeof uiConversation.binding !== 'function') throw new Error('对话视图不可用')
      const reference = sessions.retain(sessionId, { source: 'zotero-chat' })
      await reference.ready
      const binding = uiConversation.binding(sessionId)
      binding.activate('chat')
      return { reference, binding, target: binding.target('chat') }
    }

    /** Human-facing session title from the session catalog, with fallback. */
    function sessionTitleOf(sessions, sessionId, fallback) {
      try {
        const summary = sessions && sessions.list.getSnapshot().byId[sessionId]
        if (summary && summary.displayTitle) return summary.displayTitle
      } catch (error) { /* list may not be ready */ }
      return fallback || '论文对话'
    }

    async function copyTextToClipboard(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch (error) {
        /* fall through to execCommand */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', 'readonly')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const copied = document.execCommand('copy')
        document.body.removeChild(area)
        return copied
      } catch (error) {
        return false
      }
    }

    // --- Inline SVG icons (16px grid, currentColor; no external assets) ----

    function icon(size, children, extra) {
      return h('svg', Object.assign({
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, extra || {}), children)
    }

    function ZoteroIcon(props) {
      const size = (props && props.size) || 16
      return icon(size, [
        h('path', { key: 'cover', d: 'M4.2 2.1h7.9c.7 0 1.2.5 1.2 1.2v9.6c0 .7-.5 1.2-1.2 1.2H4.2c-1.1 0-1.9-.8-1.9-1.9V4c0-1.1.8-1.9 1.9-1.9Z' }),
        h('path', { key: 'spine', d: 'M3.1 12.3h10.2' }),
        h('path', { key: 'z', d: 'M6.2 5.2h3.9L6.2 9h3.9' }),
      ])
    }

    function SearchIcon(props) {
      return icon((props && props.size) || 16, [
        h('circle', { key: 'c', cx: 7, cy: 7, r: 4.2 }),
        h('path', { key: 'l', d: 'm10.2 10.2 3.1 3.1' }),
      ])
    }

    function CloseIcon(props) {
      return icon((props && props.size) || 16, [
        h('path', { key: 'x', d: 'M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2' }),
      ])
    }

    function RefreshIcon(props) {
      return icon((props && props.size) || 16, [
        h('path', { key: 'arc', d: 'M13.1 7.2A5.2 5.2 0 1 0 13 9.6' }),
        h('path', { key: 'head', d: 'M13.2 3.4v3.3H9.9' }),
      ], props && props.className ? { className: props.className } : null)
    }

    function CopyIcon(props) {
      return icon((props && props.size) || 16, [
        h('rect', { key: 'a', x: 5.4, y: 5.4, width: 7.4, height: 8, rx: 1.5 }),
        h('path', { key: 'b', d: 'M3.2 10.4V4.1c0-.8.6-1.4 1.4-1.4h6.2' }),
      ])
    }

    function CheckIcon(props) {
      return icon((props && props.size) || 16, [
        h('path', { key: 't', d: 'm3.4 8.3 2.9 2.9 6.3-6.4' }),
      ])
    }

    function DocumentIcon(props) {
      return icon((props && props.size) || 16, [
        h('path', { key: 'a', d: 'M4 1.9h4.9l3.1 3.1v9.1H4Z' }),
        h('path', { key: 'b', d: 'M8.8 2v3.1H12' }),
      ])
    }

    function DatabaseIcon(props) {
      return icon((props && props.size) || 16, [
        h('ellipse', { key: 'a', cx: 8, cy: 3.9, rx: 4.6, ry: 1.8 }),
        h('path', { key: 'b', d: 'M3.4 3.9v8.2c0 1 2.1 1.8 4.6 1.8s4.6-.8 4.6-1.8V3.9' }),
        h('path', { key: 'c', d: 'M3.4 8c0 1 2.1 1.8 4.6 1.8S12.6 9 12.6 8' }),
      ])
    }

    function AlertIcon(props) {
      return icon((props && props.size) || 16, [
        h('circle', { key: 'c', cx: 8, cy: 8, r: 5.9 }),
        h('path', { key: 'a', d: 'M8 4.9v3.6' }),
        h('path', { key: 'b', d: 'M8 11.2h.01' }),
      ])
    }

    function ArrowUpIcon(props) {
      return icon((props && props.size) || 16, [
        h('path', { key: 'a', d: 'M8 12.4V3.9' }),
        h('path', { key: 'b', d: 'm4.4 7.5 3.6-3.6 3.6 3.6' }),
      ])
    }

    function PlusIcon(props) {
      return icon((props && props.size) || 16, [
        h('path', { key: 'a', d: 'M8 3.2v9.6' }),
        h('path', { key: 'b', d: 'M3.2 8h9.6' }),
      ])
    }

    function StopIcon(props) {
      return icon((props && props.size) || 14, [
        h('rect', { key: 'a', x: 4, y: 4, width: 8, height: 8, rx: 1.5, fill: 'currentColor', stroke: 'none' }),
      ])
    }

    function ExternalIcon(props) {
      return icon((props && props.size) || 16, [
        h('path', { key: 'a', d: 'M9.2 2.6h4.2v4.2' }),
        h('path', { key: 'b', d: 'M13.4 2.6 7.6 8.4' }),
        h('path', { key: 'c', d: 'M12.6 9.4v3.2c0 .7-.5 1.2-1.2 1.2H3.8c-.7 0-1.2-.5-1.2-1.2V5c0-.7.5-1.2 1.2-1.2h3.2' }),
      ])
    }

    function FolderIcon(props) {
      const extra = props && props.className ? { className: props.className } : undefined
      return icon((props && props.size) || 16, [
        h('path', { key: 'a', d: 'M1.8 4.4c0-.7.5-1.2 1.2-1.2h3.3l1.4 1.6h5.5c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.4Z' }),
      ], extra)
    }

    function ChevronIcon(props) {
      const expanded = !!(props && props.expanded)
      const extra = props && props.className ? { className: props.className } : undefined
      return icon((props && props.size) || 12, [
        h('path', { key: 'a', d: expanded ? 'm4.5 6 3.5 3.5L11.5 6' : 'm6 4.5 3.5 3.5L6 11.5' }),
      ], extra)
    }

    // --- Styles (injected once; every selector is scoped under .zot-root) ---

    const CSS = [
      /* ---- theme-aware variables and base layout ---- */
      '.zot-root{--zot-font:var(--dsh-font-family-text,var(--dsh-font-family-text-default,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif));--zot-mono:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace));display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);font-family:var(--zot-font);font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased;container-type:inline-size}',
      '.zot-root *,.zot-root *::before,.zot-root *::after{box-sizing:border-box}',
      '.zot-root button,.zot-root input,.zot-root textarea,.zot-root select{font-family:inherit;color:inherit}',

      /* ---- header ---- */
      '.zot-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;min-height:52px;padding:10px 14px 10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04))}',
      '.zot-brand{display:flex;align-items:center;gap:7px;flex:0 0 auto;font-weight:650;font-size:14px;letter-spacing:.01em;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.zot-brand svg{color:var(--dsw-alias-state-business-primary,#2d66e8)}',
      '.zot-count{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary,#61666b);background:var(--dsw-alias-bg-layer-2,#f5f6f7);border-radius:999px;padding:1px 7px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.zot-head-spacer{flex:1 1 auto;min-width:8px}',
      '.zot-search{display:flex;align-items:center;gap:6px;height:30px;width:238px;max-width:36vw;padding:0 9px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,#f5f6f7);transition:background-color .15s ease,border-color .15s ease}',
      '.zot-search:focus-within{background:var(--dsw-alias-bg-base,#fff);border-color:var(--dsw-alias-state-business-primary,#2d66e8)}',
      '.zot-search>svg{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#61666b)}',
      '.zot-search input{flex:1 1 auto;min-width:0;border:0;outline:0;background:transparent;font-size:12.5px;padding:0}',
      '.zot-search input::placeholder{color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.zot-search-clear{display:flex;align-items:center;justify-content:center;flex:0 0 auto;width:18px;height:18px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,#61666b);cursor:pointer;padding:0}',
      '.zot-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.zot-select{height:30px;max-width:150px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-label-secondary,#353638);font-size:12px;cursor:pointer;outline:0}',
      '.zot-select:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
      '.zot-select:focus-visible{border-color:var(--dsw-alias-state-business-primary,#2d66e8)}',
      '.zot-iconbtn{display:grid;place-items:center;flex:0 0 auto;width:30px;height:30px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,#353638);cursor:pointer;transition:background-color .12s ease,color .12s ease}',
      '.zot-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.zot-iconbtn:disabled{opacity:.45;cursor:default}',
      '.zot-iconbtn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2d66e8));outline-offset:1px}',

      /* ---- three columns: folders | list | reader ---- */
      '.zot-body{position:relative;display:flex;flex:1 1 auto;min-height:0}',
      '.zot-folders{display:flex;flex-direction:column;flex:0 0 190px;width:190px;min-height:0;border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));background:var(--dsw-alias-bg-layer-1,#fbfbfc)}',
      '.zot-folders-title{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:11px 10px 7px 14px;font-size:11px;font-weight:650;letter-spacing:.03em;color:var(--dsw-alias-label-secondary,#353638)}',
      '.zot-folders-hint{font-weight:500;font-size:9.5px;color:var(--dsw-alias-label-caption,#adb2b8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.zot-folders-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 6px 12px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l4,rgba(0,0,0,.16)) transparent}',
      '.zot-folders-scroll::-webkit-scrollbar{width:8px}',
      '.zot-folders-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:999px;border:2px solid transparent;background-clip:padding-box}',
      '.zot-folder-row{display:flex;align-items:center;gap:5px;width:100%;min-height:28px;padding:3px 7px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#353638);font-size:12px;line-height:1.35;text-align:left;cursor:pointer;user-select:none;outline:0}',
      '.zot-folder-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
      '.zot-folder-row.zot-active{background:var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.1));color:var(--dsw-alias-label-primary,#0f1115);font-weight:600}',
      '.zot-folder-row:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2d66e8));outline-offset:-2px}',
      '.zot-folder-chev{display:inline-flex;align-items:center;justify-content:center;flex:0 0 14px;width:14px;height:18px;border-radius:4px;color:var(--dsw-alias-label-caption,#adb2b8);cursor:pointer}',
      '.zot-folder-chev:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.08));color:var(--dsw-alias-label-secondary,#353638)}',
      '.zot-folder-chev:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2d66e8));outline-offset:0}',
      '.zot-folder-chev-empty{pointer-events:none;cursor:default}',
      '.zot-folder-icon{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#61666b)}',
      '.zot-folder-row.zot-active .zot-folder-icon{color:var(--dsw-alias-state-business-primary,#2d66e8)}',
      '.zot-folder-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.zot-folder-count{flex:0 0 auto;padding-left:2px;font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.zot-folder-row.zot-active .zot-folder-count{color:var(--dsw-alias-label-tertiary,#61666b)}',
      '.zot-folders-sep{height:1px;margin:6px 8px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.04))}',
      '.zot-list{display:flex;flex-direction:column;flex:0 0 296px;width:296px;min-width:264px;min-height:0;border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));background:var(--dsw-alias-bg-base,#fff)}',
      '.zot-foot-folder{overflow:hidden;text-overflow:ellipsis}',
      '.zot-filter-chip{display:inline-flex;align-items:center;gap:4px;max-width:190px;padding:1px 5px 1px 7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-label-secondary,#353638);font-size:10.5px;font-weight:500;cursor:pointer;outline:0}',
      '.zot-filter-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.zot-filter-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.zot-filter-chip:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2d66e8));outline-offset:1px}',
      '.zot-folder-toggle{display:none}',
      '.zot-list-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px 8px 14px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l4,rgba(0,0,0,.16)) transparent}',
      '.zot-list-scroll::-webkit-scrollbar{width:8px}',
      '.zot-list-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:999px;border:2px solid transparent;background-clip:padding-box}',
      '.zot-list-scroll::-webkit-scrollbar-track{background:transparent}',

      /* ---- list rows ---- */
      '.zot-item{display:flex;flex-direction:column;gap:3px;width:100%;padding:9px 10px 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;text-align:left;cursor:pointer;transition:background-color .12s ease}',
      '.zot-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
      '.zot-item.zot-selected{background:var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.1))}',
      '.zot-item:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2d66e8));outline-offset:-2px}',
      '.zot-item-head{display:flex;align-items:flex-start;gap:6px}',
      '.zot-item-title{flex:1 1 auto;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12.5px;font-weight:550;line-height:1.42;color:var(--dsw-alias-label-primary,#0f1115);word-break:break-word}',
      '.zot-pdf-dot{flex:0 0 auto;width:6px;height:6px;margin-top:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#2ea44f)}',
      '.zot-item-sub{display:flex;align-items:center;gap:5px;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#61666b)}',
      '.zot-item-authors{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.zot-item-year{flex:0 0 auto;font-variant-numeric:tabular-nums}',
      '.zot-item-type{flex:0 0 auto;max-width:82px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:4px;padding:0 4px;line-height:14px;font-size:10px;color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.zot-list-foot{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:7px 15px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));font-size:10.5px;color:var(--dsw-alias-label-caption,#adb2b8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.zot-db-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#2ea44f)}',
      '.zot-db-dot.zot-warn{background:var(--dsw-alias-state-warn-primary,#e0a000)}',
      '.zot-db-dot.zot-bad{background:var(--dsw-alias-state-error-primary,#d33)}',

      /* ---- state blocks (loading / empty / error) ---- */
      '.zot-state{display:flex;flex:1 1 auto;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:30px 22px;text-align:center;min-height:170px}',
      '.zot-state-icon{display:grid;place-items:center;width:44px;height:44px;margin-bottom:2px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.zot-state-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#353638)}',
      '.zot-state-desc{max-width:290px;font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-tertiary,#61666b);word-break:break-word}',
      '.zot-state-code{display:inline-block;max-width:100%;padding:2px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);font-family:var(--zot-mono);font-size:10.5px;color:var(--dsw-alias-label-secondary,#353638);word-break:break-all}',
      '.zot-textbtn{margin-top:2px;padding:4px 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-state-business-primary,#2d66e8);font-size:11.5px;cursor:pointer}',
      '.zot-textbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
      '.zot-textbtn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2d66e8));outline-offset:1px}',
      '.zot-skel{height:58px;margin:2px 0;border-radius:var(--dsw-radius-sm,8px);background:linear-gradient(90deg,var(--dsw-alias-bg-layer-2,#f5f6f7) 25%,var(--dsw-alias-bg-layer-3,#ebeef2) 37%,var(--dsw-alias-bg-layer-2,#f5f6f7) 63%);background-size:400% 100%;animation:zot-shimmer 1.6s ease infinite}',
      '@keyframes zot-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}',

      /* ---- right column ---- */
      '.zot-main{display:flex;flex:1 1 auto;flex-direction:row;min-width:0;min-height:0;background:var(--dsw-alias-bg-base,#fff)}',
      '.zot-main>.zot-state{flex:1 1 100%}',
      '.zot-paper-pane{display:flex;flex:1 1 auto;flex-direction:column;min-width:0;min-height:0}',
      '.zot-chat-pane{display:flex;flex:0 0 384px;flex-direction:column;width:384px;min-width:330px;min-height:0;border-left:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));background:var(--dsw-alias-bg-base,#fff)}',
      '.zot-chat-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;min-height:46px;padding:8px 10px 8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04))}',
      '.zot-chat-head-main{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0}',
      '.zot-chat-kicker{flex:0 0 auto;font-size:10px;font-weight:650;letter-spacing:.05em;color:var(--dsw-alias-label-caption,#adb2b8);text-transform:uppercase}',
      '.zot-chat-session{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-secondary,#353638)}',
      '.zot-chat-select{min-width:0;max-width:190px;height:26px;padding:0 4px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-label-secondary,#353638);font-size:11.5px;outline:0;cursor:pointer}',
      '.zot-chat-select:focus-visible{border-color:var(--dsw-alias-state-business-primary,#2d66e8)}',
      '.zot-chat-actions{display:flex;align-items:center;gap:1px;flex:0 0 auto}',
      '.zot-chat-actions .zot-iconbtn{width:26px;height:26px}',
      '.zot-iconbtn.zot-stop{color:var(--dsw-alias-state-error-primary,#d33)}',
      '.zot-iconbtn.zot-stop:hover{background:rgba(211,51,51,.08);color:var(--dsw-alias-state-error-primary,#d33)}',
      '.zot-chat-tabs{display:flex;align-items:center;gap:2px;flex:0 0 auto;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));background:var(--dsw-alias-bg-base,#fff)}',
      '.zot-chat-tab{position:relative;display:inline-flex;align-items:center;gap:5px;padding:7px 10px 6px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary,#61666b);font-size:11.5px;font-weight:550;cursor:pointer;outline:0}',
      '.zot-chat-tab:hover{color:var(--dsw-alias-label-primary,#0f1115)}',
      '.zot-chat-tab.zot-active{color:var(--dsw-alias-label-primary,#0f1115);border-bottom-color:var(--dsw-alias-state-business-primary,#2d66e8)}',
      '.zot-chat-tab:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2d66e8));outline-offset:-2px}',
      '.zot-tab-count{padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);font-size:9.5px;color:var(--dsw-alias-label-tertiary,#61666b);font-variant-numeric:tabular-nums}',
      '.zot-ann{display:flex;flex:1 1 auto;flex-direction:column;min-height:0}',
      '.zot-ann-toolbar{display:flex;flex-direction:column;gap:6px;flex:0 0 auto;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));background:var(--dsw-alias-bg-layer-1,#fbfbfc)}',
      '.zot-ann-sel{display:flex;align-items:center;gap:6px;min-height:18px;min-width:0}',
      '.zot-ann-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.zot-ann-color-select{height:26px;padding:0 4px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:var(--dsw-alias-bg-base,#fff);font-size:11px;color:var(--dsw-alias-label-secondary,#353638);outline:0;cursor:pointer}',
      '.zot-ann-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:10px 12px 16px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l4,rgba(0,0,0,.16)) transparent}',
      '.zot-ann-section-title{margin:10px 0 6px;font-size:10px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.zot-ann-section-title:first-child{margin-top:0}',
      '.zot-ann-item{display:flex;flex-direction:column;gap:5px;padding:8px 9px;margin-bottom:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));border-radius:8px;background:var(--dsw-alias-bg-base,#fff)}',
      '.zot-ann-meta{display:flex;align-items:center;gap:5px;min-height:18px;min-width:0}',
      '.zot-ann-color{width:8px;height:8px;border-radius:50%;flex:0 0 auto}',
      '.zot-ann-page{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#61666b);white-space:nowrap}',
      '.zot-ann-quote{margin:0;padding-left:7px;border-left:2px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#353638);white-space:pre-wrap;word-break:break-word;max-height:90px;overflow:hidden}',
      '.zot-ann-comment{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#0f1115);white-space:pre-wrap;word-break:break-word}',
      '.zot-ann-empty{font-size:10.5px;color:var(--dsw-alias-label-caption,#adb2b8);line-height:1.6}',
      '.zot-ann-input{width:100%;resize:vertical;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:var(--dsw-alias-bg-base,#fff);font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary,#0f1115);outline:0}',
      '.zot-ann-input:focus{border-color:var(--dsw-alias-state-business-primary,#2d66e8)}',
      '.zot-ann-error{display:flex;align-items:flex-start;gap:6px;padding:7px 9px;margin-bottom:8px;border-radius:8px;background:rgba(211,51,51,.08);color:var(--dsw-alias-state-error-primary,#d33);font-size:11px;line-height:1.55}',
      '.zot-ann-setup{padding:7px 9px;margin-bottom:8px;border-radius:8px;background:rgba(45,102,232,.07);color:var(--dsw-alias-label-secondary,#353638);font-size:10.5px;line-height:1.6}',
      '.zot-note-item{display:flex;flex-direction:column;gap:5px;padding:8px 9px;margin-bottom:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));border-radius:8px;background:var(--dsw-alias-bg-base,#fff)}',
      '.zot-note-label{font-size:10.5px;font-weight:650;color:var(--dsw-alias-label-secondary,#353638)}',
      '.zot-note-date{font-size:9.5px;color:var(--dsw-alias-label-caption,#adb2b8);white-space:nowrap}',
      '.zot-note-body{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#0f1115);word-break:break-word}',
      '.zot-note-body p{margin:0 0 5px}.zot-note-body p:last-child{margin-bottom:0}',
      '.zot-note-body ul,.zot-note-body ol{margin:4px 0;padding-left:18px}',
      '.zot-note-body blockquote{margin:4px 0;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));color:var(--dsw-alias-label-secondary,#353638)}',
      '.zot-note-body a{color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary,#2d66e8))}',
      '.zot-note-body img{max-width:100%;height:auto;border-radius:4px}',
      '.zot-note-editor{display:flex;flex-direction:column;gap:6px;padding:8px 0 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));margin-top:10px}',
      '.zot-note-editor-actions{display:flex;justify-content:flex-end;gap:6px}',
      '.zot-chat-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:14px 14px 18px;display:flex;flex-direction:column;gap:12px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l4,rgba(0,0,0,.16)) transparent}',
      '.zot-chat-scroll::-webkit-scrollbar{width:8px}',
      '.zot-chat-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:999px;border:2px solid transparent;background-clip:padding-box}',
      '.zot-chat-state{display:flex;flex:1 1 auto;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:28px 20px;text-align:center}',
      '.zot-chat-state>.zot-state-icon{margin-bottom:2px}',
      '.zot-chat-empty>.zot-state-icon{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.zot-chat-empty>div:nth-child(2){font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#353638)}',
      '.zot-chat-empty>div:nth-child(3){max-width:280px;font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-tertiary,#61666b)}',
      '.zot-msg{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.zot-msg-user{align-self:flex-end;align-items:flex-end;max-width:88%}',
      '.zot-msg-context{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 3px;font-size:10px;color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.zot-msg-bubble{padding:8px 11px;border-radius:12px 12px 3px 12px;background:rgba(45,102,232,.1);color:var(--dsw-alias-label-primary,#0f1115);font-size:12.5px;line-height:1.55;word-break:break-word;white-space:normal}',
      '.zot-msg-assistant{align-self:stretch;max-width:100%}',
      '.zot-msg-body{font-size:12.5px;line-height:1.62;color:var(--dsw-alias-label-primary,#0f1115);word-break:break-word;overflow-wrap:anywhere}',
      '.zot-msg-tools{display:flex;flex-wrap:wrap;gap:4px}',
      '.zot-tool-chip{padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);font-size:10px;color:var(--dsw-alias-label-tertiary,#61666b)}',
      '.zot-msg-error{flex-direction:row;align-items:flex-start;gap:6px;padding:7px 9px;border-radius:8px;background:rgba(211,51,51,.08);font-size:11.5px;line-height:1.55;color:var(--dsw-alias-state-error-primary,#d33)}',
      '.zot-msg-typing{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#61666b)}',
      '.zot-typing-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#2d66e8);animation:zot-pulse 1s ease-in-out infinite}',
      '@keyframes zot-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}',
      '.zot-msg-caret{display:inline-block;width:2px;height:12px;margin-top:4px;background:var(--dsw-alias-state-business-primary,#2d66e8);animation:zot-pulse 1s ease-in-out infinite}',
      '.zot-sel-hint{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.zot-math{display:inline-block;max-width:100%;vertical-align:baseline}',
      '.zot-math-display{display:block;margin:8px 0;overflow-x:auto;overflow-y:hidden;padding:2px 0}',
      '.zot-math .katex{font-size:1.05em}',
      '.zot-math-display .katex{font-size:1.08em}',
      '.zot-math-pending{display:inline-block;max-width:100%;overflow-x:auto;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);font-family:var(--zot-mono);font-size:11px;white-space:pre}',
      '.zot-math-pending.zot-math-display{display:block;margin:8px 0;padding:6px 8px}',
      '.zot-md-p{margin:0 0 8px;white-space:pre-wrap}',
      '.zot-md-p:last-child,.zot-md-list:last-child,.zot-md-code:last-child{margin-bottom:0}',
      '.zot-md-h{margin:10px 0 5px;font-weight:650;line-height:1.35}',
      '.zot-md-h:first-child{margin-top:0}',
      '.zot-md-h1{font-size:15px}',
      '.zot-md-h2{font-size:14px}',
      '.zot-md-h3{font-size:13.5px}',
      '.zot-md-h4,.zot-md-h5,.zot-md-h6{font-size:12.5px;color:var(--dsw-alias-label-secondary,#353638)}',
      '.zot-md-list{margin:4px 0 8px;padding-left:18px}',
      '.zot-md-list>li{margin:2px 0}',
      '.zot-md-code{position:relative;margin:8px 0;padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);font-family:var(--zot-mono);font-size:11px;line-height:1.5;overflow:auto;white-space:pre}',
      '.zot-md-lang{position:absolute;top:4px;right:8px;font-size:9px;color:var(--dsw-alias-label-caption,#adb2b8);text-transform:uppercase}',
      '.zot-md-inline{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);font-family:var(--zot-mono);font-size:11px}',
      '.zot-md-quote{margin:6px 0;padding:4px 9px;border-left:2px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14));color:var(--dsw-alias-label-secondary,#353638);white-space:pre-wrap}',
      '.zot-md-table{margin:6px 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);font-family:var(--zot-mono);font-size:10.5px;line-height:1.5;white-space:pre;overflow:auto}',
      '.zot-md-hr{border:0;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));margin:8px 0}',
      '.zot-paper-head{flex:0 0 auto;padding:13px 20px 11px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04))}',
      '.zot-paper-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:14.5px;font-weight:650;line-height:1.4;color:var(--dsw-alias-label-primary,#0f1115);word-break:break-word}',
      '.zot-paper-meta{display:flex;flex-wrap:wrap;align-items:center;gap:3px 7px;margin-top:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#353638)}',
      '.zot-paper-meta .zot-sep{color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.zot-paper-publication{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:42ch}',
      '.zot-paper-doi{color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary,#2d66e8));text-decoration:none;white-space:nowrap}',
      '.zot-paper-doi:hover{text-decoration:underline}',
      '.zot-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}',
      '.zot-tag{max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);font-size:10px;color:var(--dsw-alias-label-tertiary,#61666b)}',

      /* ---- reader ---- */
      '.zot-reader{position:relative;flex:1 1 auto;min-height:0;background:var(--dsw-alias-bg-layer-2,#f5f6f7)}',
      '.zot-frame{position:absolute;inset:0;display:block;width:100%;height:100%;border:0;background:#f4f4f5}',
      '.zot-frame-overlay{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:24px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-label-tertiary,#61666b);font-size:12px;text-align:center}',
      '.zot-spinner{width:20px;height:20px;border:2px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-top-color:var(--dsw-alias-state-business-primary,#2d66e8);border-radius:50%;animation:zot-spin .8s linear infinite}',
      '@keyframes zot-spin{to{transform:rotate(360deg)}}',
      '.zot-frame-error-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#353638)}',
      '.zot-frame-error-desc{max-width:300px;font-size:11.5px;line-height:1.6}',

      /* ---- no-PDF placeholder ---- */
      '.zot-nopdf{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px 22px;overflow:auto}',
      '.zot-nopdf-card{display:flex;flex-direction:column;align-items:flex-start;gap:9px;width:100%;max-width:600px;max-height:100%;overflow:auto;padding:18px 20px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.zot-nopdf-title{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#353638)}',
      '.zot-abstract{width:100%;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#353638);white-space:pre-wrap;word-break:break-word}',
      '.zot-abstract-label{font-size:10.5px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-caption,#adb2b8);text-transform:uppercase}',

      /* ---- folder drawer (narrow panels) ---- */
      '.zot-drawer-mask{position:absolute;inset:0;z-index:30;display:flex;background:rgba(15,17,21,.22)}',
      '.zot-drawer{display:flex;flex-direction:column;width:244px;max-width:82%;height:100%;border-right:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-shadow-lv3,0 10px 30px rgba(15,17,21,.2));animation:zot-slide .16s ease-out}',
      '@keyframes zot-slide{from{opacity:.5;transform:translateX(-14px)}to{opacity:1;transform:none}}',

      /* ---- persistent question composer ---- */
      '.zot-composer{flex:0 0 auto;display:flex;flex-direction:column;gap:7px;padding:9px 14px 11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));background:var(--dsw-alias-bg-base,#fff)}',
      '.zot-chat-composer{padding:8px 12px 10px}',
      '.zot-chat-composer .zot-ask-input{min-height:38px;max-height:96px}',
      '.zot-composer-sel{display:flex;align-items:center;gap:6px;min-height:20px}',
      '.zot-ask-head{display:flex;align-items:center;gap:6px;min-height:20px}',
      '.zot-sel-chip{display:inline-flex;align-items:center;gap:5px;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);font-size:11px;font-weight:550;color:var(--dsw-alias-state-business-primary,#2d66e8)}',
      '.zot-ask-head-spacer{flex:1 1 auto}',
      '.zot-ask-input{width:100%;min-height:40px;max-height:104px;resize:none;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,#f8f9fa);font-size:12.5px;line-height:1.5;outline:0;transition:border-color .15s ease,background-color .15s ease}',
      '.zot-ask-input:focus{border-color:var(--dsw-alias-state-business-primary,#2d66e8)}',
      '.zot-ask-input::placeholder{color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.zot-ask-foot{display:flex;align-items:center;gap:8px;min-height:24px}',
      '.zot-ask-hint{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.zot-ask-error{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-state-error-primary,#d33)}',
      '.zot-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:6px 13px;border:0;border-radius:var(--dsw-radius-sm,8px);font-size:12px;font-weight:550;cursor:pointer;transition:background-color .12s ease,opacity .12s ease,filter .12s ease}',
      '.zot-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2d66e8));outline-offset:1px}',
      '.zot-btn-ghost{padding:5px 8px;background:transparent;color:var(--dsw-alias-label-secondary,#353638);font-weight:500}',
      '.zot-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}',
      '.zot-btn-primary{margin-left:auto;background:var(--dsw-alias-state-business-primary,#2d66e8);color:#fff}',
      '.zot-btn-primary:hover{filter:brightness(1.06)}',
      '.zot-btn-primary:disabled{opacity:.55;cursor:default;filter:none}',
      '.zot-btn svg{flex:0 0 auto}',

      /* ---- responsive: keep columns usable in a narrow panel ---- */
      '@container (max-width:1300px){.zot-root.zot-has-paper .zot-folders{display:none}.zot-root.zot-has-paper .zot-folder-toggle{display:grid}}',
      '@container (max-width:1240px){.zot-chat-pane{flex-basis:360px;width:360px}}',
      '@container (max-width:1120px){.zot-root.zot-has-paper .zot-list{flex-basis:264px;width:264px;min-width:240px}.zot-chat-pane{flex-basis:340px;width:340px;min-width:310px}}',
      '@container (max-width:980px){.zot-main{flex-direction:column}.zot-chat-pane{flex:0 0 46%;width:auto;min-width:0;border-left:0;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}.zot-paper-pane{flex:1 1 54%}}',
      '@container (max-width:820px){.zot-root.zot-has-paper .zot-list{flex-basis:248px;width:248px;min-width:226px}}',
      '@container (max-width:940px){.zot-folders{display:none}.zot-folder-toggle{display:grid}}',
      '@container (max-width:820px){.zot-list{flex-basis:272px;width:272px;min-width:244px}.zot-filter-chip{max-width:120px}}',
      '@container (max-width:700px){.zot-search{width:180px}}',
      '@container (max-width:600px){.zot-brand>span:not(.zot-count):not(.zot-filter-chip){display:none}.zot-ask-hint{display:none}.zot-composer{padding-left:10px;padding-right:10px}}',
      '@media (prefers-reduced-motion:reduce){.zot-root *{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:0s !important}}',
    ].join('\n')

    function ensureStyles() {
      if (typeof document === 'undefined') return
      try {
        if (document.getElementById(STYLE_ID)) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.setAttribute('data-plugin', '@local/dsh-zotero')
        style.textContent = CSS
        const head = document.head || document.documentElement
        if (head) head.appendChild(style)
      } catch (error) {
        console.warn('[zotero] failed to inject styles:', error)
      }
    }

    // --- Leaf render helpers -----------------------------------------------

    function renderState(options) {
      const Icon = options.icon
      const children = []
      if (Icon) children.push(h('div', { key: 'icon', className: 'zot-state-icon' }, h(Icon, { size: 20 })))
      if (options.title) children.push(h('div', { key: 'title', className: 'zot-state-title' }, options.title))
      if (options.desc) children.push(h('div', { key: 'desc', className: 'zot-state-desc' }, options.desc))
      if (options.code) children.push(h('div', { key: 'code', className: 'zot-state-desc' }, h('code', { className: 'zot-state-code' }, options.code)))
      if (options.hint) children.push(h('div', { key: 'hint', className: 'zot-state-desc' }, options.hint))
      if (options.actionLabel) {
        children.push(h('button', {
          key: 'action',
          type: 'button',
          className: 'zot-textbtn',
          onClick: options.onAction,
        }, options.actionLabel))
      }
      return h('div', { className: 'zot-state' }, children)
    }

    function renderLoadingState(label) {
      return h('div', { className: 'zot-state' }, [
        h('div', { key: 'icon', className: 'zot-state-icon' }, h('span', { className: 'zot-spinner' })),
        h('div', { key: 'label', className: 'zot-state-desc' }, label),
      ])
    }

    function renderSkeletonList() {
      const rows = []
      for (let i = 0; i < 6; i++) rows.push(h('div', { key: i, className: 'zot-skel' }))
      return rows
    }

    // --- Main panel component ----------------------------------------------

    function ZoteroPanel(props) {
      const pluginCtx = props && props.pluginCtx
      const [boot] = react.useState(readPersisted)

      const [query, setQuery] = react.useState(boot.q || '')
      const [collection, setCollection] = react.useState(boot.collection || '')

      const [items, setItems] = react.useState([])
      const [total, setTotal] = react.useState(0)
      const [listLoading, setListLoading] = react.useState(true)
      const [listError, setListError] = react.useState(null)

      const [status, setStatus] = react.useState(null)
      const [statusError, setStatusError] = react.useState(null)
      const [collections, setCollections] = react.useState([])
      const [unfiledCount, setUnfiledCount] = react.useState(0)
      const [foldersOpen, setFoldersOpen] = react.useState(false)
      const [collapsedFolders, setCollapsedFolders] = react.useState(() => new Set())

      const [selectedKey, setSelectedKey] = react.useState(boot.itemKey || null)
      const [detail, setDetail] = react.useState(null)
      const [detailLoading, setDetailLoading] = react.useState(false)
      const [detailError, setDetailError] = react.useState(null)
      const [detailRetry, setDetailRetry] = react.useState(0)

      const [selection, setSelection] = react.useState(EMPTY_SELECTION)
      const [copied, setCopied] = react.useState(false)

      // Per-paper chat: one session per paper, multiple sessions allowed, all
      // rendered inside this panel. Nothing is ever appended to the DSH main
      // conversation.
      const [chatInput, setChatInput] = react.useState('')
      const [chatSending, setChatSending] = react.useState(false)
      const [chatError, setChatError] = react.useState(null)
      const [chatState, setChatState] = react.useState({ loading: false, error: null, active: null, sessions: [] })
      const [chatSnapshot, setChatSnapshot] = react.useState(null)
      const [chatRunning, setChatRunning] = react.useState(false)
      const [chatRetry, setChatRetry] = react.useState(0)
      const [mathVersion, setMathVersion] = react.useState(0)
      const mathLoadStartedRef = react.useRef(false)

      // Native Zotero annotations and notes.
      const [chatTab, setChatTab] = react.useState('chat')
      const [annotationData, setAnnotationData] = react.useState(null)
      const [annotationsLoading, setAnnotationsLoading] = react.useState(false)
      const [annotationsError, setAnnotationsError] = react.useState(null)
      const [annotationBusy, setAnnotationBusy] = react.useState(false)
      const [annotationColor, setAnnotationColor] = react.useState('#ffd400')
      const [editingAnnotationKey, setEditingAnnotationKey] = react.useState(null)
      const [annotationDraft, setAnnotationDraft] = react.useState('')
      const [noteEditor, setNoteEditor] = react.useState(null)

      const [frameLoading, setFrameLoading] = react.useState(false)
      const [frameError, setFrameError] = react.useState(null)
      const [frameKey, setFrameKey] = react.useState(0)

      const iframeRef = react.useRef(null)
      const chatRef = react.useRef(null)
      const chatGenRef = react.useRef(0)
      const chatMapRef = react.useRef(null)
      const chatScrollRef = react.useRef(null)
      const pdfKeyRef = react.useRef(null)
      const progressTimerRef = react.useRef(null)
      const progressRestoreRef = react.useRef(false)
      const progressRestoredRef = react.useRef(false)
      const listScrollRef = react.useRef(null)
      const aliveRef = react.useRef(true)
      const listAbortRef = react.useRef(null)
      const statusAbortRef = react.useRef(null)
      const collectionsAbortRef = react.useRef(null)
      const frameBindRef = react.useRef(null)
      const frameReadyTimerRef = react.useRef(null)
      const selectionTimerRef = react.useRef(null)
      const copyTimerRef = react.useRef(null)

      // ---- data loading ---------------------------------------------------

      const loadStatus = react.useCallback(async () => {
        try {
          if (statusAbortRef.current) statusAbortRef.current.abort()
        } catch (error) { /* noop */ }
        const controller = new AbortController()
        statusAbortRef.current = controller
        try {
          const value = await fetchJSON(API + '/status', controller.signal)
          if (controller.signal.aborted || !aliveRef.current) return
          setStatus(value)
          setStatusError(null)
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error) || !aliveRef.current) return
          setStatusError(describeFetchError(error))
          setStatus((previous) => previous || { ok: false, source: 'unavailable', message: describeFetchError(error) })
        }
      }, [])

      const loadCollections = react.useCallback(async () => {
        try {
          if (collectionsAbortRef.current) collectionsAbortRef.current.abort()
        } catch (error) { /* noop */ }
        const controller = new AbortController()
        collectionsAbortRef.current = controller
        try {
          const value = await fetchJSON(API + '/collections', controller.signal)
          if (controller.signal.aborted || !aliveRef.current) return
          setCollections(Array.isArray(value.collections) ? value.collections : [])
          setUnfiledCount(isFiniteNumber(value.unfiledCount) ? value.unfiledCount : 0)
        } catch (error) {
          /* collection filtering is optional — the list stays usable */
        }
      }, [])

      const loadItems = react.useCallback(async (search, collectionKey) => {
        try {
          if (listAbortRef.current) listAbortRef.current.abort()
        } catch (error) { /* noop */ }
        const controller = new AbortController()
        listAbortRef.current = controller
        if (aliveRef.current) {
          setListLoading(true)
          setListError(null)
        }
        try {
          const params = new URLSearchParams()
          params.set('limit', String(MAX_LIST_ITEMS))
          params.set('offset', '0')
          if (search && search.trim()) params.set('q', search.trim())
          if (collectionKey === COLLECTION_UNFILED) params.set('unfiled', '1')
          else if (collectionKey) params.set('collection', collectionKey)
          const value = await fetchJSON(API + '/items?' + params.toString(), controller.signal)
          if (controller.signal.aborted || !aliveRef.current) return
          const list = Array.isArray(value.items) ? value.items : []
          setItems(list)
          setTotal(isFiniteNumber(value.total) ? value.total : list.length)
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error) || !aliveRef.current) return
          setItems([])
          setTotal(0)
          setListError(describeFetchError(error))
        } finally {
          if (!controller.signal.aborted && aliveRef.current) setListLoading(false)
        }
      }, [])

      const refreshAll = react.useCallback(() => {
        loadStatus()
        loadCollections()
        loadItems(query, collection)
      }, [loadStatus, loadCollections, loadItems, query, collection])

      // ---- effects --------------------------------------------------------

      react.useEffect(() => {
        aliveRef.current = true
        ensureStyles()
        loadStatus()
        loadCollections()
        return () => {
          aliveRef.current = false
          try { if (listAbortRef.current) listAbortRef.current.abort() } catch (error) { /* noop */ }
          try { if (statusAbortRef.current) statusAbortRef.current.abort() } catch (error) { /* noop */ }
          try { if (collectionsAbortRef.current) collectionsAbortRef.current.abort() } catch (error) { /* noop */ }
          try { if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current) } catch (error) { /* noop */ }
          try { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) } catch (error) { /* noop */ }
        }
      }, [loadStatus, loadCollections])

      // Debounced search + collection filter.
      react.useEffect(() => {
        const timer = setTimeout(() => {
          loadItems(query, collection)
        }, SEARCH_DEBOUNCE_MS)
        return () => clearTimeout(timer)
      }, [query, collection, loadItems])

      // Persist list/reader preferences for the next mount.
      react.useEffect(() => {
        persistUiState({ q: query, collection: collection, itemKey: selectedKey })
      }, [query, collection, selectedKey])

      // Escape closes the narrow-panel folder drawer.
      react.useEffect(() => {
        if (!foldersOpen) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setFoldersOpen(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [foldersOpen])

      // Item detail.
      react.useEffect(() => {
        if (!selectedKey) {
          setDetail(null)
          setDetailError(null)
          setDetailLoading(false)
          return undefined
        }
        const controller = new AbortController()
        setDetailLoading(true)
        setDetailError(null)
        setDetail(null)
        fetchJSON(API + '/item/' + encodeURIComponent(selectedKey), controller.signal)
          .then((value) => {
            if (controller.signal.aborted || !aliveRef.current) return
            setDetail(value)
          })
          .catch((error) => {
            if (controller.signal.aborted || isAbortError(error) || !aliveRef.current) return
            setDetailError(describeFetchError(error))
          })
          .finally(() => {
            if (!controller.signal.aborted && aliveRef.current) setDetailLoading(false)
          })
        return () => controller.abort()
      }, [selectedKey, detailRetry])

      // Paper switch: drop any selection, draft and transient state.
      react.useEffect(() => {
        setSelection(EMPTY_SELECTION)
        setChatInput('')
        setChatError(null)
        setCopied(false)
        setFrameKey(0)
      }, [selectedKey])

      // Keep the selected row visible when the list or the selection changes.
      react.useEffect(() => {
        const container = listScrollRef.current
        if (!container || !selectedKey) return
        const row = container.querySelector('.zot-selected')
        if (row && row.scrollIntoView) {
          try {
            row.scrollIntoView({ block: 'nearest' })
          } catch (error) { /* jsdom / old engines */ }
        }
      }, [selectedKey, items])

      // ---- selection capture inside the same-origin viewer iframe ---------

      const readFrameSelection = react.useCallback(() => {
        const iframe = iframeRef.current
        if (!iframe) return
        let win = null
        try {
          win = iframe.contentWindow
        } catch (error) {
          return
        }
        if (!win) return
        let sel = null
        try {
          sel = win.getSelection()
        } catch (error) {
          return
        }
        const text = sel ? String(sel.toString() || '').trim() : ''
        if (!text) {
          setSelection((previous) => (previous.text ? EMPTY_SELECTION : previous))
          return
        }
        const page = pageOfSelection(sel)
        setSelection((previous) => (previous.text === text && previous.page === page ? previous : { text: text, page: page }))
      }, [])

      const clearSelection = react.useCallback(() => {
        setSelection(EMPTY_SELECTION)
        setCopied(false)
        try {
          const iframe = iframeRef.current
          const win = iframe && iframe.contentWindow
          if (win && win.getSelection) win.getSelection().removeAllRanges()
        } catch (error) { /* cross-origin refused — impossible for our viewer */ }
      }, [])

      const saveProgress = react.useCallback(() => {
        const binding = frameBindRef.current
        const key = pdfKeyRef.current
        if (!binding || !key || progressRestoreRef.current) return
        try {
          const viewer = binding.win && binding.win.__zoteroViewer
          if (viewer && typeof viewer.getProgress === 'function') {
            const progress = viewer.getProgress()
            if (progress) writeProgress(key, progress)
          }
        } catch (error) { /* iframe gone */ }
      }, [])

      const unbindFrame = react.useCallback(() => {
        saveProgress()
        if (progressTimerRef.current) {
          clearTimeout(progressTimerRef.current)
          progressTimerRef.current = null
        }
        if (selectionTimerRef.current) {
          clearTimeout(selectionTimerRef.current)
          selectionTimerRef.current = null
        }
        if (frameReadyTimerRef.current) {
          clearInterval(frameReadyTimerRef.current)
          frameReadyTimerRef.current = null
        }
        const binding = frameBindRef.current
        frameBindRef.current = null
        if (!binding) return
        try {
          binding.doc.removeEventListener('selectionchange', binding.schedule)
          binding.doc.removeEventListener('mouseup', binding.schedule)
          binding.doc.removeEventListener('keyup', binding.onKey)
          binding.doc.removeEventListener('keydown', binding.onKey)
          if (binding.onScroll) binding.win.removeEventListener('scroll', binding.onScroll)
          if (binding.onScroll && binding.scroller) binding.scroller.removeEventListener('scroll', binding.onScroll)
        } catch (error) { /* iframe navigated away */ }
      }, [])

      const bindFrame = react.useCallback(() => {
        unbindFrame()
        const iframe = iframeRef.current
        if (!iframe) return
        let win = null
        let doc = null
        try {
          win = iframe.contentWindow
          doc = iframe.contentDocument
        } catch (error) {
          setFrameLoading(false)
          setFrameError('无法访问 PDF 阅读器（跨域限制）')
          return
        }
        if (!win || !doc) {
          setFrameLoading(false)
          setFrameError('PDF 阅读器不可用')
          return
        }
        const schedule = () => {
          if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current)
          selectionTimerRef.current = setTimeout(readFrameSelection, SELECTION_DEBOUNCE_MS)
        }
        const onKey = (event) => {
          if (event && event.key === 'Escape') clearSelection()
          schedule()
        }
        const onScroll = () => {
          if (progressRestoreRef.current) return
          if (progressTimerRef.current) clearTimeout(progressTimerRef.current)
          progressTimerRef.current = setTimeout(saveProgress, 450)
        }
        const scroller = doc.getElementById('pages')
        try {
          doc.addEventListener('selectionchange', schedule)
          doc.addEventListener('mouseup', schedule)
          doc.addEventListener('keyup', onKey)
          doc.addEventListener('keydown', onKey)
          win.addEventListener('scroll', onScroll, { passive: true })
          if (scroller) scroller.addEventListener('scroll', onScroll, { passive: true })
        } catch (error) { /* noop */ }
        frameBindRef.current = { win: win, doc: doc, schedule: schedule, onKey: onKey, onScroll: onScroll, scroller }

        // Keep the loading veil until the viewer has painted its first page.
        let tries = 0
        const timer = setInterval(() => {
          tries += 1
          let hasPage = false
          try {
            hasPage = !!doc.querySelector('[data-page]')
          } catch (error) {
            hasPage = false
          }
          if (hasPage) {
            clearInterval(timer)
            frameReadyTimerRef.current = null
            if (!aliveRef.current) return
            setFrameLoading(false)
            setFrameError(null)
            const key = pdfKeyRef.current
            const saved = key ? readProgress()[key] : null
            if (saved && win.__zoteroViewer && typeof win.__zoteroViewer.goTo === 'function') {
              progressRestoreRef.current = true
              let attempts = 0
              const tryRestore = () => {
                attempts += 1
                if (!aliveRef.current) return
                // Wait for the whole document: restoring before later pages
                // render clamps scrollTop to the short current page list.
                if (win.__zoteroViewerReady !== true && attempts < 120) {
                  setTimeout(tryRestore, 250)
                  return
                }
                let placed = false
                try { placed = win.__zoteroViewer.goTo(saved.page, saved.ratio) } catch (error) { placed = false }
                if (!placed && attempts < 120) {
                  setTimeout(tryRestore, 250)
                  return
                }
                progressRestoredRef.current = true
                setTimeout(() => { progressRestoreRef.current = false }, 700)
              }
              tryRestore()
            }
            return
          }
          if (tries >= 30) {
            clearInterval(timer)
            frameReadyTimerRef.current = null
            if (!aliveRef.current) return
            setFrameLoading(false)
            setFrameError('PDF 页面未能渲染，请重试')
          }
        }, 500)
        frameReadyTimerRef.current = timer
      }, [unbindFrame, readFrameSelection, clearSelection, saveProgress])

      // Reset the reader state whenever the paper (pdf URL) or retry counter changes.
      const pdfKey = (detail && detail.pdf && detail.pdf.key) || (detail && detail.attachmentKey) || null
      const pdfUrl = pdfKey ? viewerUrl(pdfKey) : null
      pdfKeyRef.current = pdfKey

      react.useEffect(() => {
        setFrameLoading(!!pdfUrl)
        setFrameError(null)
        unbindFrame()
        return () => unbindFrame()
      }, [pdfUrl, frameKey, unbindFrame])

      // Safety net: a viewer that never fires `load` must not spin forever.
      react.useEffect(() => {
        if (!frameLoading || !pdfUrl) return undefined
        const timer = setTimeout(() => {
          if (!aliveRef.current) return
          setFrameLoading(false)
          setFrameError((previous) => previous || 'PDF 载入超时，请检查阅读器资源后重试')
        }, 25000)
        return () => clearTimeout(timer)
      }, [frameLoading, pdfUrl, frameKey])

      // ---- ask flow -------------------------------------------------------

      const selectedItem = react.useMemo(() => {
        if (!selectedKey) return null
        for (let i = 0; i < items.length; i++) {
          if (items[i] && items[i].key === selectedKey) return items[i]
        }
        return null
      }, [items, selectedKey])

      const paper = detail || selectedItem
      const collectionTree = react.useMemo(() => buildCollectionTree(collections), [collections])
      const activeFolderName = react.useMemo(() => {
        if (collection === COLLECTION_UNFILED) return '未分类'
        if (!collection) return '全部文献'
        const found = collections.find((entry) => entry && entry.key === collection)
        return found && found.name ? String(found.name) : '分类'
      }, [collection, collections])

      const chatBusy = react.useMemo(() => {
        if (chatRunning) return true
        if (!chatSnapshot) return false
        for (const key of chatSnapshot.order) {
          const node = chatSnapshot.nodes.get(key)
          if (node && node.kind === 'assistant-step' && node.data && node.data.status === 'running') return true
        }
        return false
      }, [chatRunning, chatSnapshot])

      const chatMessages = react.useMemo(() => {
        if (!chatSnapshot) return []
        const rows = []
        for (const key of chatSnapshot.order) {
          const row = chatMessageOf(chatSnapshot.nodes.get(key))
          if (row) rows.push({ key, ...row })
        }
        return rows
      }, [chatSnapshot])

      // KaTeX is loaded on demand, only once a transcript actually contains math.
      react.useEffect(() => {
        if (mathLoadStartedRef.current) return
        const hasMath = chatMessages.some((row) => /\$\$|\$[^$\n]+\$|\\\(|\\\[/.test(row.text || ''))
        if (!hasMath) return
        mathLoadStartedRef.current = true
        loadKatex().then((katex) => {
          if (katex && aliveRef.current) setMathVersion((value) => value + 1)
        })
      }, [chatMessages, mathVersion])

      function chatMap() {
        if (!chatMapRef.current) chatMapRef.current = readPaperChats()
        return chatMapRef.current
      }

      function releaseChat() {
        const current = chatRef.current
        chatRef.current = null
        if (!current) return
        try { current.unsubscribe() } catch (error) { /* already disposed */ }
        try { current.reference.release() } catch (error) { /* already released */ }
      }

      async function activatePaperChat(paperKey, sessionId, sessionsList, generation) {
        const opened = await openChatBinding(pluginCtx, sessionId)
        if (!aliveRef.current || generation !== chatGenRef.current) {
          try { opened.reference.release() } catch (error) { /* superseded */ }
          return
        }
        const update = () => {
          if (!aliveRef.current || generation !== chatGenRef.current) return
          try { setChatSnapshot(opened.target.getSnapshot() || null) } catch (error) { /* disposed */ }
        }
        const unsubscribe = opened.target.subscribe(update)
        update()
        chatRef.current = { reference: opened.reference, binding: opened.binding, sessionId, unsubscribe }
        setChatState({ loading: false, error: null, active: sessionId, sessions: sessionsList })
        setChatRunning(!!getService(pluginCtx, 'sessions').list.getSnapshot().byId[sessionId]?.running)
      }

      async function ensurePaperChat(paperInfo) {
        const sessions = getService(pluginCtx, 'sessions')
        if (!sessions || typeof sessions.create !== 'function') throw new Error('会话服务不可用')
        const map = chatMap()
        const key = paperInfo.key
        const entry = map[key]
        const list = sessions.list.getSnapshot()
        const exists = (sessionId) => !!list.byId[sessionId]
        if (entry && entry.sessions.length > 0) {
          const alive = entry.sessions.filter((session) => exists(session.id))
          if (alive.length > 0) {
            const active = alive.some((session) => session.id === entry.active) ? entry.active : alive[0].id
            map[key] = { active, sessions: alive }
            writePaperChats(map)
            return { sessionId: active, sessions: alive }
          }
        }
        const sessionId = await sessions.create({})
        if (!sessionId) throw new Error('未能创建论文对话')
        const baseTitle = shortTitle(paperInfo.title || '论文')
        const title = baseTitle + ' · 对话 ' + (((entry && entry.sessions.length) || 0) + 1)
        try {
          const reference = sessions.retain(sessionId, { source: 'zotero-chat-name' })
          await reference.ready
          await reference.binding.session.rename(title)
          reference.release()
        } catch (error) {
          /* renaming is cosmetic */
        }
        const sessionsList = ((entry && entry.sessions) || [])
          .filter((session) => exists(session.id))
          .concat([{ id: sessionId, title, createdAt: Date.now() }])
        map[key] = { active: sessionId, sessions: sessionsList }
        writePaperChats(map)
        return { sessionId, sessions: sessionsList }
      }

      async function newPaperChat() {
        if (!paper || !paper.key) return
        const sessions = getService(pluginCtx, 'sessions')
        if (!sessions || typeof sessions.create !== 'function') {
          setChatError('会话服务不可用')
          return
        }
        setChatError(null)
        try {
          const map = chatMap()
          const entry = map[paper.key]
          const sessionId = await sessions.create({})
          const title = shortTitle(paper.title || '论文') + ' · 对话 ' + (((entry && entry.sessions.length) || 0) + 1)
          try {
            const reference = sessions.retain(sessionId, { source: 'zotero-chat-name' })
            await reference.ready
            await reference.binding.session.rename(title)
            reference.release()
          } catch (error) { /* cosmetic */ }
          const sessionsList = ((entry && entry.sessions) || []).concat([{ id: sessionId, title, createdAt: Date.now() }])
          map[paper.key] = { active: sessionId, sessions: sessionsList }
          writePaperChats(map)
          const generation = ++chatGenRef.current
          releaseChat()
          setChatSnapshot(null)
          await activatePaperChat(paper.key, sessionId, sessionsList, generation)
        } catch (error) {
          if (aliveRef.current) setChatError('新建对话失败：' + describeFetchError(error))
        }
      }

      async function switchPaperChat(sessionId) {
        if (!paper || !paper.key || !sessionId) return
        const map = chatMap()
        const entry = map[paper.key]
        if (!entry) return
        entry.active = sessionId
        writePaperChats(map)
        const generation = ++chatGenRef.current
        releaseChat()
        setChatSnapshot(null)
        setChatState({ loading: true, error: null, active: sessionId, sessions: entry.sessions })
        try {
          await activatePaperChat(paper.key, sessionId, entry.sessions, generation)
        } catch (error) {
          if (aliveRef.current && generation === chatGenRef.current) {
            setChatState({ loading: false, error: describeFetchError(error), active: null, sessions: entry.sessions })
          }
        }
      }

      // Bind the selected paper to its own chat session.
      react.useEffect(() => {
        const generation = ++chatGenRef.current
        releaseChat()
        setChatSnapshot(null)
        setChatError(null)
        setChatRunning(false)
        setChatState({ loading: false, error: null, active: null, sessions: [] })
        if (!selectedKey || !paper || !paper.key) return undefined
        let cancelled = false
        setChatState((previous) => ({ ...previous, loading: true }))
        ;(async () => {
          try {
            const info = await ensurePaperChat(paper)
            if (cancelled || generation !== chatGenRef.current || !aliveRef.current) return
            await activatePaperChat(paper.key, info.sessionId, info.sessions, generation)
          } catch (error) {
            if (!cancelled && generation === chatGenRef.current && aliveRef.current) {
              setChatState({ loading: false, error: describeFetchError(error), active: null, sessions: [] })
            }
          }
        })()
        return () => { cancelled = true }
      }, [selectedKey, paper && paper.key, chatRetry])

      // Session running state feeds the stop button.
      react.useEffect(() => {
        const sessions = getService(pluginCtx, 'sessions')
        if (!sessions || !sessions.list || typeof sessions.list.subscribe !== 'function') return undefined
        const update = () => {
          const current = chatRef.current
          if (!current || !aliveRef.current) return
          try { setChatRunning(!!sessions.list.getSnapshot().byId[current.sessionId]?.running) } catch (error) { /* disposed */ }
        }
        const unsubscribe = sessions.list.subscribe(update)
        update()
        return unsubscribe
      }, [pluginCtx])

      // Keep the transcript pinned to the newest content.
      react.useEffect(() => {
        const element = chatScrollRef.current
        if (!element) return
        const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 160
        if (nearBottom) element.scrollTop = element.scrollHeight
      }, [chatSnapshot])

      // Release the retained paper session with the panel.
      react.useEffect(() => () => {
        chatGenRef.current += 1
        releaseChat()
      }, [])

      const copySelection = react.useCallback(async () => {
        const text = selection.text
        if (!text) return
        const ok = await copyTextToClipboard(text)
        if (!aliveRef.current) return
        if (ok) {
          setCopied(true)
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
          copyTimerRef.current = setTimeout(() => {
            if (aliveRef.current) setCopied(false)
          }, 1600)
        } else {
          setChatError('复制失败，请手动选择文本复制')
        }
      }, [selection.text])

      const sendChat = react.useCallback(async () => {
        if (chatSending) return
        const current = paper
        const opened = chatRef.current
        if (!current) {
          setChatError('文献信息尚未载入，请稍后重试')
          return
        }
        if (!opened) {
          setChatError('论文对话尚未就绪，请稍候')
          return
        }
        const questionText = chatInput.trim().slice(0, CHAT_MAX_INPUT)
        const firstTurn = !chatSnapshot || !chatSnapshot.order.some((key) => {
          const node = chatSnapshot.nodes.get(key)
          return !!node && (node.kind === 'user' || node.kind === 'steering')
        })
        const prompt = firstTurn
          ? buildPrompt(current, selection.text, selection.page, questionText)
          : buildFollowupPrompt(current, selection.text, selection.page, questionText)
        setChatSending(true)
        setChatError(null)
        try {
          const conversation = getService(opened.reference.binding.ctx, 'conversation')
          if (!conversation || typeof conversation.send !== 'function') throw new Error('会话消息通道不可用')
          await conversation.send(prompt)
          if (!aliveRef.current) return
          setChatInput('')
          clearSelection()
        } catch (error) {
          if (aliveRef.current) setChatError('发送失败：' + describeFetchError(error) + '（内容已保留）')
        } finally {
          if (aliveRef.current) setChatSending(false)
        }
      }, [chatSending, paper, chatInput, selection, chatSnapshot, clearSelection])

      const stopChat = react.useCallback(async () => {
        const opened = chatRef.current
        if (!opened) return
        try {
          await opened.reference.binding.session.cancel()
        } catch (error) {
          if (aliveRef.current) setChatError('停止失败：' + describeFetchError(error))
        }
      }, [])

      function openFullChat() {
        const opened = chatRef.current
        if (!opened) return
        try {
          const workspace = getService(pluginCtx, 'uiWorkspace')
          const layout = getService(pluginCtx, 'layout')
          if (workspace && typeof workspace.openSession === 'function') workspace.openSession(opened.sessionId)
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
        } catch (error) {
          setChatError('无法打开完整对话：' + describeFetchError(error))
        }
      }

      // ---- native Zotero annotations / notes -----------------------------

      function annotationWriteError(error) {
        if (error && error.status === 403) {
          if (error.message && /本地 API/.test(error.message)) return error.message
          return 'Zotero 未授权写入：请在 Zotero 弹窗中选择“始终允许”，或检查本地 API 是否启用。'
        }
        if (error && error.status === 503) {
          return '写入标注/笔记需要 Zotero 正在运行，并在 设置 → 高级 中启用本地 API。'
        }
        return describeFetchError(error)
      }

      const loadAnnotations = react.useCallback(async (itemKeyValue) => {
        if (!itemKeyValue) return
        setAnnotationsLoading(true)
        setAnnotationsError(null)
        try {
          const value = await fetchJSON(API + '/annotations/' + encodeURIComponent(itemKeyValue))
          if (!aliveRef.current) return
          setAnnotationData(value)
        } catch (error) {
          if (aliveRef.current) setAnnotationsError(describeFetchError(error))
        } finally {
          if (aliveRef.current) setAnnotationsLoading(false)
        }
      }, [])

      const createHighlight = react.useCallback(async () => {
        const current = paper
        if (!current) return
        const iframe = iframeRef.current
        let position = null
        try {
          position = iframe && iframe.contentWindow && iframe.contentWindow.__zoteroViewer
            ? iframe.contentWindow.__zoteroViewer.selectionRects()
            : null
        } catch (error) {
          position = null
        }
        if (!position || !Array.isArray(position.rects) || position.rects.length === 0) {
          setAnnotationsError('请先在左侧论文中框选一段文字，再保存为高亮。')
          return
        }
        const attachmentKey = (detail && detail.pdf && detail.pdf.key) || (detail && detail.attachmentKey) || null
        if (!attachmentKey) {
          setAnnotationsError('该文献没有可写入的 PDF 附件。')
          return
        }
        setAnnotationBusy(true)
        setAnnotationsError(null)
        try {
          await postJSON(API + '/annotations', {
            action: 'create',
            itemKey: current.key,
            attachmentKey,
            annotation: {
              text: position.text,
              pageIndex: position.pageIndex,
              pageLabel: position.pageLabel,
              rects: position.rects,
              color: annotationColor,
              comment: '',
            },
          })
          clearSelection()
          await loadAnnotations(current.key)
        } catch (error) {
          if (aliveRef.current) setAnnotationsError(annotationWriteError(error))
        } finally {
          if (aliveRef.current) setAnnotationBusy(false)
        }
      }, [paper, detail, annotationColor, clearSelection, loadAnnotations])

      const saveAnnotationComment = react.useCallback(async (annotation) => {
        if (!paper || !annotation) return
        setAnnotationBusy(true)
        setAnnotationsError(null)
        try {
          await postJSON(API + '/annotations', {
            action: 'update',
            itemKey: paper.key,
            annotationKey: annotation.key,
            comment: annotationDraft,
          })
          setEditingAnnotationKey(null)
          await loadAnnotations(paper.key)
        } catch (error) {
          if (aliveRef.current) setAnnotationsError(annotationWriteError(error))
        } finally {
          if (aliveRef.current) setAnnotationBusy(false)
        }
      }, [paper, annotationDraft, loadAnnotations])

      const saveNote = react.useCallback(async () => {
        if (!paper || !noteEditor) return
        const html = noteHtmlFromText(noteEditor.draft)
        if (!html.trim()) {
          setAnnotationsError('笔记内容为空。')
          return
        }
        setAnnotationBusy(true)
        setAnnotationsError(null)
        try {
          const payload = noteEditor.key
            ? { action: 'update', itemKey: paper.key, noteKey: noteEditor.key, note: html }
            : { action: 'create', itemKey: paper.key, note: html }
          await postJSON(API + '/notes', payload)
          setNoteEditor(null)
          await loadAnnotations(paper.key)
        } catch (error) {
          if (aliveRef.current) setAnnotationsError(annotationWriteError(error))
        } finally {
          if (aliveRef.current) setAnnotationBusy(false)
        }
      }, [paper, noteEditor, loadAnnotations])

      react.useEffect(() => {
        if (chatTab !== 'annotations' || !paper || !paper.key) return
        loadAnnotations(paper.key)
      }, [chatTab, paper && paper.key, loadAnnotations])

      react.useEffect(() => {
        setAnnotationData(null)
        setAnnotationsError(null)
        setEditingAnnotationKey(null)
        setNoteEditor(null)
        setChatTab('chat')
      }, [selectedKey])

      // ---- rendering: left column ----------------------------------------

      const statusUnavailable = !!status && (status.source === 'unavailable' || status.ok === false)
      const sourceLabels = {
        'zotero-sqlite': 'Zotero 本地数据库',
        'local-api': 'Zotero API',
        unavailable: '数据库不可用',
      }

      function renderListBody() {
        if (listError) {
          return renderState({
            icon: AlertIcon,
            title: '无法读取文献列表',
            desc: listError,
            hint: '请确认插件主机端已加载，或稍后重试。',
            actionLabel: '重试',
            onAction: () => loadItems(query, collection),
          })
        }
        if (listLoading && items.length === 0) return renderSkeletonList()
        if (statusUnavailable && items.length === 0) {
          return renderState({
            icon: DatabaseIcon,
            title: '未找到 Zotero 数据',
            desc: (status && status.message) || statusError || '无法读取本地 Zotero 数据库。',
            code: status && status.dataDir ? status.dataDir : undefined,
            hint: '请先在 Zotero 中打开一次资料库以生成数据库文件，或检查插件配置中的 dataDir 路径。',
            actionLabel: '重新检测',
            onAction: refreshAll,
          })
        }
        if (items.length === 0) {
          if (!query.trim() && collection) {
            return renderState({
              icon: FolderIcon,
              title: '「' + activeFolderName + '」下没有文献',
              desc: collection === COLLECTION_UNFILED
                ? '所有文献都已经归类到文件夹中了。'
                : '这个文件夹里还没有文献，试试其他分类或查看全部。',
              actionLabel: '查看全部文献',
              onAction: () => selectCollection(COLLECTION_ALL),
            })
          }
          return renderState({
            icon: query.trim() ? SearchIcon : DatabaseIcon,
            title: query.trim() ? '没有匹配的文献' : '资料库为空',
            desc: query.trim() ? '没有找到与「' + query.trim() + '」匹配的条目，试试其他关键词。' : 'Zotero 资料库中还没有可显示的文献条目。',
            actionLabel: query.trim() ? '清除搜索' : '刷新',
            onAction: query.trim() ? () => setQuery('') : refreshAll,
          })
        }
        const rows = []
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          if (!item || !item.key) continue
          const authors = authorLine(item.creators, 3)
          const year = itemYear(item)
          const selected = item.key === selectedKey
          rows.push(h('button', {
            key: item.key,
            type: 'button',
            className: cxs('zot-item', selected && 'zot-selected'),
            onClick: () => { if (item.key !== selectedKey) setSelectedKey(item.key) },
            title: item.title || '',
            'aria-current': selected ? 'true' : undefined,
          }, [
            h('span', { key: 'head', className: 'zot-item-head' }, [
              h('span', { key: 'title', className: 'zot-item-title' }, item.title || '未命名文献'),
              item.hasPDF ? h('span', { key: 'pdf', className: 'zot-pdf-dot', title: '含 PDF 全文' }) : null,
            ]),
            h('span', { key: 'sub', className: 'zot-item-sub' }, [
              h('span', { key: 'authors', className: 'zot-item-authors' }, authors || '未知作者'),
              year ? h('span', { key: 'year', className: 'zot-item-year' }, year) : null,
              item.itemType ? h('span', { key: 'type', className: 'zot-item-type' }, typeLabel(item.itemType)) : null,
            ]),
          ]))
        }
        return rows
      }

      function renderFooter() {
        if (!status && !statusError) return null
        const source = status && status.source
        const bad = statusUnavailable || statusError
        const label = bad ? '主机数据不可用' : (sourceLabels[source] || source || 'Zotero')
        const pdfCount = status && isFiniteNumber(status.pdfCount) ? status.pdfCount : null
        return h('div', { className: 'zot-list-foot', title: statusError || (status && status.message) || '' }, [
          h('span', { key: 'dot', className: cxs('zot-db-dot', bad && 'zot-bad') }),
          h('span', { key: 'label' }, label),
          pdfCount !== null ? h('span', { key: 'count' }, '· ' + pdfCount + ' 份 PDF') : null,
          collection ? h('span', { key: 'folder', className: 'zot-foot-folder', title: '当前分类：' + activeFolderName }, '· ' + activeFolderName) : null,
        ])
      }

      // ---- rendering: right column ---------------------------------------

      function renderPaperHead(current) {
        const authors = authorLine(current.creators, 6)
        const year = itemYear(current)
        const publication = publicationOf(current)
        const doi = current.doi ? String(current.doi).trim() : ''
        const tags = Array.isArray(current.tags) ? current.tags.filter(Boolean) : []
        const meta = []
        if (authors) meta.push(h('span', { key: 'authors' }, authors))
        if (year) meta.push(h('span', { key: 'year' }, year))
        if (current.itemType) meta.push(h('span', { key: 'type' }, typeLabel(current.itemType)))
        const metaLine = []
        meta.forEach((node, index) => {
          if (index > 0) metaLine.push(h('span', { key: 'sep' + index, className: 'zot-sep' }, '·'))
          metaLine.push(node)
        })
        const secondLine = []
        if (publication) secondLine.push(h('span', { key: 'pub', className: 'zot-paper-publication', title: publication }, publication))
        if (doi) {
          if (secondLine.length) secondLine.push(h('span', { key: 'sep', className: 'zot-sep' }, '·'))
          secondLine.push(h('a', {
            key: 'doi',
            className: 'zot-paper-doi',
            href: 'https://doi.org/' + doi,
            target: '_blank',
            rel: 'noreferrer noopener',
            title: '在浏览器中打开 DOI',
          }, 'DOI: ' + doi))
        }
        return h('div', { key: 'head', className: 'zot-paper-head' }, [
          h('div', { key: 'title', className: 'zot-paper-title', title: current.title || '' }, current.title || '未命名文献'),
          metaLine.length ? h('div', { key: 'meta', className: 'zot-paper-meta' }, metaLine) : null,
          secondLine.length ? h('div', { key: 'meta2', className: 'zot-paper-meta' }, secondLine) : null,
          tags.length ? h('div', { key: 'tags', className: 'zot-tags' }, tags.slice(0, 6).map((tag, index) =>
            h('span', { key: 'tag' + index, className: 'zot-tag', title: String(tag) }, String(tag)))) : null,
        ])
      }

      function renderNoPdf(current) {
        const abstract = current.abstractNote ? String(current.abstractNote).trim() : ''
        return h('div', { key: 'nopdf', className: 'zot-nopdf' },
          h('div', { className: 'zot-nopdf-card' }, [
            h('div', { key: 'title', className: 'zot-nopdf-title' }, [
              h(DocumentIcon, { key: 'icon', size: 16 }),
              h('span', { key: 'label' }, '该条目没有可读取的 PDF'),
            ]),
            h('div', { key: 'hint', className: 'zot-state-desc' }, '若 Zotero 中该条目带有 PDF 附件，请确认文件仍在 storage 目录下并重新同步。'),
            abstract
              ? h('div', { key: 'abstract', className: 'zot-abstract' }, [
                h('div', { key: 'label', className: 'zot-abstract-label' }, '摘要'),
                h('div', { key: 'text' }, abstract),
              ])
              : h('div', { key: 'abstract', className: 'zot-abstract' }, '（无摘要）'),
          ]))
      }

      // ---- rendering: folder rail -----------------------------------------

      function toggleFolder(key) {
        setCollapsedFolders((previous) => {
          const next = new Set(previous)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      function selectCollection(value) {
        setCollection(value)
        setFoldersOpen(false)
        try {
          if (listScrollRef.current) listScrollRef.current.scrollTop = 0
        } catch (error) { /* detached scroll container */ }
      }

      function renderFolderRows(nodes, depth) {
        const rows = []
        for (const node of nodes) {
          const hasChildren = node.children.length > 0
          const collapsed = collapsedFolders.has(node.key)
          const active = collection === node.key
          const count = isFiniteNumber(node.totalCount) ? node.totalCount : (isFiniteNumber(node.count) ? node.count : null)
          const nested = isFiniteNumber(node.count) && isFiniteNumber(node.totalCount) && node.totalCount !== node.count
          rows.push(h('div', {
            key: node.key,
            className: cxs('zot-folder-row', active && 'zot-active'),
            style: { paddingLeft: (8 + depth * 14) + 'px' },
            role: 'treeitem',
            tabIndex: 0,
            'aria-selected': active ? 'true' : undefined,
            title: (node.name || node.key) + (nested ? '（直属 ' + node.count + ' 篇 / 含子分类 ' + node.totalCount + ' 篇）' : ''),
            onClick: () => selectCollection(node.key),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                selectCollection(node.key)
              }
            },
          }, [
            hasChildren ? h('span', {
              key: 'chev',
              className: cxs('zot-folder-chev', collapsed && 'zot-folded'),
              role: 'button',
              tabIndex: 0,
              'aria-label': collapsed ? '展开子分类' : '折叠子分类',
              'aria-expanded': collapsed ? 'false' : 'true',
              onClick: (event) => { event.stopPropagation(); toggleFolder(node.key) },
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  toggleFolder(node.key)
                }
              },
            }, h(ChevronIcon, { size: 12, expanded: !collapsed })) : h('span', { key: 'chev', className: 'zot-folder-chev zot-folder-chev-empty' }),
            h(FolderIcon, { key: 'icon', size: 14, className: 'zot-folder-icon' }),
            h('span', { key: 'name', className: 'zot-folder-name' }, node.name || node.key),
            count !== null ? h('span', { key: 'count', className: 'zot-folder-count' }, String(count)) : null,
          ]))
          if (hasChildren && !collapsed) rows.push(...renderFolderRows(node.children, depth + 1))
        }
        return rows
      }

      function renderFolderList() {
        const totalPapers = status && isFiniteNumber(status.paperCount) ? status.paperCount : null
        const allActive = !collection
        const unfiledActive = collection === COLLECTION_UNFILED
        return [
          h('div', { key: 'title', className: 'zot-folders-title' }, [
            h('span', { key: 'label' }, '分类'),
            h('span', { key: 'hint', className: 'zot-folders-hint' }, collections.length > 0 ? collections.length + ' 个文件夹' : '本地资料库'),
          ]),
          h('div', { key: 'scroll', className: 'zot-folders-scroll', role: 'tree', 'aria-label': 'Zotero 分类' }, [
            h('div', {
              key: 'all',
              className: cxs('zot-folder-row', allActive && 'zot-active'),
              role: 'treeitem',
              tabIndex: 0,
              'aria-selected': allActive ? 'true' : undefined,
              title: '全部文献',
              onClick: () => selectCollection(COLLECTION_ALL),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  selectCollection(COLLECTION_ALL)
                }
              },
            }, [
              h('span', { key: 'chev', className: 'zot-folder-chev zot-folder-chev-empty' }),
              h(DatabaseIcon, { key: 'icon', size: 14, className: 'zot-folder-icon' }),
              h('span', { key: 'name', className: 'zot-folder-name' }, '全部文献'),
              totalPapers !== null ? h('span', { key: 'count', className: 'zot-folder-count' }, String(totalPapers)) : null,
            ]),
            h('div', {
              key: 'unfiled',
              className: cxs('zot-folder-row', unfiledActive && 'zot-active'),
              role: 'treeitem',
              tabIndex: 0,
              'aria-selected': unfiledActive ? 'true' : undefined,
              title: '未归入任何文件夹的文献',
              onClick: () => selectCollection(COLLECTION_UNFILED),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  selectCollection(COLLECTION_UNFILED)
                }
              },
            }, [
              h('span', { key: 'chev', className: 'zot-folder-chev zot-folder-chev-empty' }),
              h(FolderIcon, { key: 'icon', size: 14, className: 'zot-folder-icon' }),
              h('span', { key: 'name', className: 'zot-folder-name' }, '未分类'),
              h('span', { key: 'count', className: 'zot-folder-count' }, String(unfiledCount)),
            ]),
            collectionTree.length > 0 ? h('div', { key: 'sep', className: 'zot-folders-sep' }) : null,
            ...renderFolderRows(collectionTree, 0),
          ]),
        ]
      }

      function renderFolders() {
        return h('aside', { key: 'folders', className: 'zot-folders', 'aria-label': 'Zotero 分类' }, renderFolderList())
      }

      function renderFolderDrawer() {
        if (!foldersOpen) return null
        return h('div', {
          key: 'drawer',
          className: 'zot-drawer-mask',
          onMouseDown: () => setFoldersOpen(false),
        }, h('aside', {
          key: 'panel',
          className: 'zot-drawer',
          'aria-label': 'Zotero 分类',
          onMouseDown: (event) => event.stopPropagation(),
        }, renderFolderList()))
      }

      // ---- rendering: per-paper chat pane ---------------------------------

      function renderChatMessage(row) {
        if (row.role === 'user') {
          const parsed = parsePromptForDisplay(row.text)
          return h('div', { key: row.key, className: 'zot-msg zot-msg-user' }, [
            parsed.selection
              ? h('div', {
                key: 'ctx',
                className: 'zot-msg-context',
                title: parsed.selection,
              }, (parsed.page ? '第 ' + parsed.page + ' 页 · ' : '') + '框选 ' + parsed.selection.length + ' 字')
              : null,
            h('div', { key: 'bubble', className: 'zot-msg-bubble' }, renderRichText(parsed.question)),
          ])
        }
        if (row.role === 'error') {
          return h('div', { key: row.key, className: 'zot-msg zot-msg-error' }, [
            h(AlertIcon, { key: 'icon', size: 14 }),
            h('span', { key: 'text' }, row.text),
          ])
        }
        return h('div', { key: row.key, className: 'zot-msg zot-msg-assistant' }, [
          row.tools && row.tools.length > 0 ? h('div', { key: 'tools', className: 'zot-msg-tools' },
            row.tools.map((name, index) => h('span', { key: 'tool' + index, className: 'zot-tool-chip' }, name))) : null,
          row.text
            ? h('div', { key: 'body', className: 'zot-msg-body' }, renderRichText(row.text))
            : h('div', { key: 'typing', className: 'zot-msg-typing' }, [
              h('span', { key: 'dot', className: 'zot-typing-dot' }),
              h('span', { key: 'label' }, row.tools && row.tools.length > 0
                ? '正在调用 ' + row.tools.slice(0, 2).join('、') + '…'
                : '正在思考…'),
            ]),
          row.running && row.text ? h('span', { key: 'caret', className: 'zot-msg-caret' }) : null,
        ])
      }

      function renderChatBody() {
        if (chatState.loading) {
          return h('div', { key: 'loading', className: 'zot-chat-state' }, [
            h('span', { key: 'spin', className: 'zot-spinner' }),
            h('span', { key: 'label' }, '正在载入论文对话…'),
          ])
        }
        if (chatState.error) {
          return h('div', { key: 'error', className: 'zot-chat-state' }, [
            h(AlertIcon, { key: 'icon', size: 20 }),
            h('div', { key: 'title' }, '论文对话不可用'),
            h('div', { key: 'desc' }, chatState.error),
            h('button', {
              key: 'retry',
              type: 'button',
              className: 'zot-btn zot-btn-primary',
              onClick: () => setChatRetry((value) => value + 1),
            }, '重试'),
          ])
        }
        if (chatMessages.length === 0) {
          return h('div', { key: 'empty', className: 'zot-chat-state zot-chat-empty' }, [
            h('div', { key: 'icon', className: 'zot-state-icon' }, h(ZoteroIcon, { size: 20 })),
            h('div', { key: 'title' }, '这篇论文还没有对话'),
            h('div', { key: 'desc' }, '在左侧论文中框选一段文字，或直接在下方提问。对话只属于这篇论文，不会进入其他会话。'),
          ])
        }
        const rows = chatMessages.map(renderChatMessage)
        const last = chatMessages[chatMessages.length - 1]
        if (chatBusy && (!last || last.role !== 'assistant')) {
          rows.push(h('div', { key: 'busy', className: 'zot-msg zot-msg-assistant' }, h('div', { className: 'zot-msg-typing' }, [
            h('span', { key: 'dot', className: 'zot-typing-dot' }),
            h('span', { key: 'label' }, '正在思考…'),
          ])))
        }
        return rows
      }

      function renderAnnotationRow(annotation) {
        const editing = editingAnnotationKey === annotation.key
        const color = /^#[0-9a-f]{6}$/i.test(annotation.color || '') ? annotation.color : '#ffd400'
        return h('div', { key: 'ann-' + annotation.key, className: 'zot-ann-item' }, [
          h('div', { key: 'meta', className: 'zot-ann-meta' }, [
            h('span', { key: 'dot', className: 'zot-ann-color', style: { backgroundColor: color } }),
            h('span', { key: 'page', className: 'zot-ann-page' }, annotation.pageLabel ? '第 ' + annotation.pageLabel + ' 页' : '标注'),
            h('span', { key: 'spacer', className: 'zot-ask-head-spacer' }),
            editing ? h('button', {
              key: 'save',
              type: 'button',
              className: 'zot-textbtn',
              disabled: annotationBusy,
              onClick: () => saveAnnotationComment(annotation),
            }, '保存') : h('button', {
              key: 'edit',
              type: 'button',
              className: 'zot-textbtn',
              onClick: () => {
                setEditingAnnotationKey(annotation.key)
                setAnnotationDraft(annotation.comment || '')
              },
            }, '编辑批注'),
            editing ? h('button', {
              key: 'cancel',
              type: 'button',
              className: 'zot-textbtn',
              onClick: () => setEditingAnnotationKey(null),
            }, '取消') : null,
          ]),
          annotation.text ? h('div', { key: 'quote', className: 'zot-ann-quote' }, '“' + annotation.text + '”') : null,
          editing
            ? h('textarea', {
              key: 'editor',
              className: 'zot-ann-input',
              rows: 3,
              value: annotationDraft,
              placeholder: '给这条高亮写批注…',
              onChange: (event) => setAnnotationDraft(event.target.value),
            })
            : (annotation.comment
              ? h('div', { key: 'comment', className: 'zot-ann-comment' }, annotation.comment)
              : h('div', { key: 'empty', className: 'zot-ann-empty' }, '（暂无批注）')),
        ])
      }

      function renderNoteEditor() {
        if (!noteEditor) return null
        return h('div', { key: 'note-editor', className: 'zot-note-editor' }, [
          h('div', { key: 'title', className: 'zot-ann-section-title' }, noteEditor.key ? '编辑笔记' : '新建笔记'),
          h('textarea', {
            key: 'input',
            className: 'zot-ann-input',
            rows: 5,
            value: noteEditor.draft,
            spellCheck: false,
            placeholder: '支持纯文本或 Zotero 笔记 HTML，例如 <div class="zotero-note znv1"><p>想法…</p></div>',
            onChange: (event) => setNoteEditor((previous) => previous ? { ...previous, draft: event.target.value } : previous),
          }),
          h('div', { key: 'actions', className: 'zot-note-editor-actions' }, [
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'zot-btn zot-btn-ghost',
              onClick: () => setNoteEditor(null),
            }, '取消'),
            h('button', {
              key: 'save',
              type: 'button',
              className: 'zot-btn zot-btn-primary',
              disabled: annotationBusy,
              onClick: saveNote,
            }, annotationBusy ? '保存中…' : '保存笔记'),
          ]),
        ])
      }

      function renderAnnotationNote(note) {
        return h('div', { key: 'note-' + note.key, className: 'zot-note-item' }, [
          h('div', { key: 'meta', className: 'zot-ann-meta' }, [
            h('span', { key: 'label', className: 'zot-note-label' }, '笔记'),
            h('span', { key: 'date', className: 'zot-note-date' }, String(note.dateModified || '').slice(0, 16)),
            h('span', { key: 'spacer', className: 'zot-ask-head-spacer' }),
            h('button', {
              key: 'edit',
              type: 'button',
              className: 'zot-textbtn',
              onClick: () => setNoteEditor({ key: note.key, draft: note.note || '' }),
            }, '编辑'),
          ]),
          h('div', {
            key: 'body',
            className: 'zot-note-body',
            dangerouslySetInnerHTML: { __html: sanitizeNoteHtml(note.note) },
          }),
        ])
      }

      function renderAnnotations() {
        const data = annotationData || { annotations: [], notes: [] }
        const annotations = Array.isArray(data.annotations) ? data.annotations : []
        const notes = Array.isArray(data.notes) ? data.notes : []
        const hasSelection = !!selection.text
        const pageLabel = selection.page ? ' · 第 ' + selection.page + ' 页' : ''
        const colors = [
          ['#ffd400', '黄'],
          ['#ff6666', '红'],
          ['#5fb236', '绿'],
          ['#2ea8e5', '蓝'],
          ['#a28ae5', '紫'],
        ]
        const toolbar = h('div', { key: 'toolbar', className: 'zot-ann-toolbar' }, [
          h('div', { key: 'sel', className: 'zot-ann-sel' }, hasSelection
            ? [
              h('span', { key: 'chip', className: 'zot-sel-chip', title: selection.text }, '已选 ' + selection.text.length + ' 字' + pageLabel),
              h('button', {
                key: 'clear',
                type: 'button',
                className: 'zot-textbtn',
                onClick: clearSelection,
              }, '清除'),
            ]
            : h('span', { key: 'hint', className: 'zot-sel-hint' }, '在左侧论文中框选文字，然后保存为高亮')),
          h('div', { key: 'actions', className: 'zot-ann-actions' }, [
            h('select', {
              key: 'color',
              className: 'zot-ann-color-select',
              value: annotationColor,
              title: '高亮颜色',
              'aria-label': '高亮颜色',
              onChange: (event) => setAnnotationColor(event.target.value),
            }, colors.map(([value, label]) => h('option', { key: value, value }, label))),
            h('button', {
              key: 'highlight',
              type: 'button',
              className: 'zot-btn zot-btn-primary',
              disabled: !hasSelection || annotationBusy,
              onClick: createHighlight,
              title: hasSelection ? '把当前框选保存为 Zotero 高亮' : '请先框选文字',
            }, annotationBusy ? '保存中…' : '保存高亮'),
            h('button', {
              key: 'note',
              type: 'button',
              className: 'zot-btn zot-btn-ghost',
              onClick: () => setNoteEditor({ key: null, draft: '' }),
            }, '新建笔记'),
          ]),
        ])

        const body = []
        if (annotationData && annotationData.writable === false) {
          body.push(h('div', { key: 'setup', className: 'zot-ann-setup' }, [
            h('span', { key: 'text' }, '写入标注/笔记需要 Zotero 正在运行，并在 Zotero → 设置 → 高级 中勾选“允许本机其他应用与 Zotero 通信”。'),
          ]))
        }
        if (annotationsError) {
          body.push(h('div', { key: 'error', className: 'zot-ann-error' }, [
            h(AlertIcon, { key: 'icon', size: 14 }),
            h('span', { key: 'text' }, annotationsError),
            h('button', {
              key: 'retry',
              type: 'button',
              className: 'zot-textbtn',
              onClick: () => loadAnnotations(paper.key),
            }, '重试'),
          ]))
        }
        body.push(h('div', { key: 'ann-title', className: 'zot-ann-section-title' }, '高亮与标注（' + annotations.length + '）'))
        if (annotationsLoading && annotations.length === 0) {
          body.push(h('div', { key: 'ann-loading', className: 'zot-ann-empty' }, '正在读取标注…'))
        } else if (annotations.length === 0) {
          body.push(h('div', { key: 'ann-empty', className: 'zot-ann-empty' },
            '还没有标注。框选正文后点“保存高亮”，或直接在 Zotero 中标注后刷新。'))
        } else {
          for (const annotation of annotations) body.push(renderAnnotationRow(annotation))
        }
        body.push(h('div', { key: 'notes-title', className: 'zot-ann-section-title' }, '笔记（' + notes.length + '）'))
        if (notes.length === 0) {
          body.push(h('div', { key: 'notes-empty', className: 'zot-ann-empty' }, '还没有笔记。点“新建笔记”写一条。'))
        } else {
          for (const note of notes) body.push(renderAnnotationNote(note))
        }
        body.push(renderNoteEditor())

        return h('div', { key: 'annotations', className: 'zot-ann' }, [
          toolbar,
          h('div', { key: 'scroll', className: 'zot-ann-scroll' }, body),
        ])
      }

      function renderChatPane() {
        const sessionsList = chatState.sessions || []
        const active = chatState.active
        const activeEntry = sessionsList.find((session) => session.id === active)
        const title = activeEntry && activeEntry.title ? activeEntry.title : '论文对话'
        const header = h('div', { key: 'head', className: 'zot-chat-head' }, [
          h('div', { key: 'title', className: 'zot-chat-head-main' }, [
            h('span', { key: 'kicker', className: 'zot-chat-kicker' }, '论文对话'),
            sessionsList.length > 1 ? h('select', {
              key: 'select',
              className: 'zot-chat-select',
              value: active || '',
              title: '切换这篇论文的对话',
              'aria-label': '切换这篇论文的对话',
              onChange: (event) => { switchPaperChat(event.target.value) },
            }, sessionsList.map((session) => {
              const label = String(session.title || '')
              const suffix = label.includes('·') ? label.slice(label.lastIndexOf('·') + 1).trim() : shortTitle(label, 18)
              return h('option', {
                key: session.id,
                value: session.id,
                title: label,
              }, suffix || '对话')
            })) : h('span', { key: 'session', className: 'zot-chat-session', title }, shortTitle(title, 28)),
          ]),
          h('div', { key: 'actions', className: 'zot-chat-actions' }, [
            h('button', {
              key: 'new',
              type: 'button',
              className: 'zot-iconbtn',
              title: '新建这篇论文的对话',
              'aria-label': '新建这篇论文的对话',
              onClick: () => newPaperChat(),
            }, h(PlusIcon, { size: 15 })),
            h('button', {
              key: 'open',
              type: 'button',
              className: 'zot-iconbtn',
              title: '在 DSH 完整对话中打开',
              'aria-label': '在 DSH 完整对话中打开',
              disabled: !active,
              onClick: openFullChat,
            }, h(ExternalIcon, { size: 15 })),
            chatBusy ? h('button', {
              key: 'stop',
              type: 'button',
              className: 'zot-iconbtn zot-stop',
              title: '停止生成',
              'aria-label': '停止生成',
              onClick: stopChat,
            }, h(StopIcon, { size: 13 })) : null,
          ]),
        ])

        const hasSelection = !!selection.text
        const pageLabel = selection.page ? ' · 第 ' + selection.page + ' 页' : ''
        const composer = h('div', {
          key: 'composer',
          className: 'zot-composer zot-chat-composer',
          onKeyDown: (event) => {
            if (event.key === 'Escape' && selection.text) {
              event.preventDefault()
              clearSelection()
            }
          },
        }, [
          h('div', { key: 'sel', className: 'zot-composer-sel' }, [
            hasSelection
              ? h('span', { key: 'chip', className: 'zot-sel-chip', title: selection.text }, '已选 ' + selection.text.length + ' 字' + pageLabel)
              : h('span', { key: 'hint', className: 'zot-sel-hint' }, '可直接提问；在论文中框选会自动带上引用'),
            h('span', { key: 'spacer', className: 'zot-ask-head-spacer' }),
            hasSelection ? h('button', {
              key: 'copy',
              type: 'button',
              className: 'zot-btn zot-btn-ghost',
              onClick: copySelection,
              title: '复制框选文字',
            }, [
              copied ? h(CheckIcon, { key: 'i', size: 13 }) : h(CopyIcon, { key: 'i', size: 13 }),
              h('span', { key: 't' }, copied ? '已复制' : '复制'),
            ]) : null,
            hasSelection ? h('button', {
              key: 'clear',
              type: 'button',
              className: 'zot-btn zot-btn-ghost',
              onClick: clearSelection,
              title: '清除框选（Esc）',
            }, '清除') : null,
          ]),
          h('textarea', {
            key: 'input',
            className: 'zot-ask-input',
            rows: 2,
            value: chatInput,
            placeholder: hasSelection ? '针对框选内容提问（可留空）' : '问这篇论文，例如：核心贡献是什么？（可留空）',
            spellCheck: false,
            'aria-label': '向这篇论文提问',
            onChange: (event) => setChatInput(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              if (event.nativeEvent && event.nativeEvent.isComposing) return
              if (event.shiftKey) return
              event.preventDefault()
              sendChat()
            },
          }),
          h('div', { key: 'foot', className: 'zot-ask-foot' }, [
            h('span', { key: 'hint', className: 'zot-ask-hint' }, 'Enter 发送 · Shift+Enter 换行'),
            chatError ? h('span', { key: 'error', className: 'zot-ask-error', title: chatError }, chatError) : null,
            h('button', {
              key: 'send',
              type: 'button',
              className: 'zot-btn zot-btn-primary',
              onClick: sendChat,
              disabled: chatSending || !chatState.active,
              title: '发送到这篇论文的对话',
            }, [
              h(ArrowUpIcon, { key: 'i', size: 13 }),
              h('span', { key: 't' }, chatSending ? '发送中…' : '发送'),
            ]),
          ]),
        ])

        const annotationCount = annotationData
          ? (Array.isArray(annotationData.annotations) ? annotationData.annotations.length : 0) +
            (Array.isArray(annotationData.notes) ? annotationData.notes.length : 0)
          : 0
        const tabs = h('div', { key: 'tabs', className: 'zot-chat-tabs', role: 'tablist' }, [
          h('button', {
            key: 'chat',
            type: 'button',
            role: 'tab',
            'aria-selected': chatTab === 'chat' ? 'true' : 'false',
            className: cxs('zot-chat-tab', chatTab === 'chat' && 'zot-active'),
            onClick: () => setChatTab('chat'),
          }, '对话'),
          h('button', {
            key: 'annotations',
            type: 'button',
            role: 'tab',
            'aria-selected': chatTab === 'annotations' ? 'true' : 'false',
            className: cxs('zot-chat-tab', chatTab === 'annotations' && 'zot-active'),
            onClick: () => {
              setChatTab('annotations')
              if (paper && paper.key && !annotationData) loadAnnotations(paper.key)
            },
          }, [
            h('span', { key: 'label' }, '标注与笔记'),
            annotationCount > 0 ? h('span', { key: 'count', className: 'zot-tab-count' }, String(annotationCount)) : null,
          ]),
        ])

        return h('section', { key: 'chat', className: 'zot-chat-pane', 'aria-label': '论文对话' }, [
          header,
          tabs,
          chatTab === 'annotations'
            ? renderAnnotations()
            : h('div', { key: 'scroll', ref: chatScrollRef, className: 'zot-chat-scroll' }, renderChatBody()),
          chatTab === 'annotations' ? null : composer,
        ])
      }

      function renderReader(current) {
        const children = []
        if (pdfUrl) {
          children.push(h('iframe', {
            key: 'frame',
            ref: iframeRef,
            className: 'zot-frame',
            src: pdfUrl,
            title: 'PDF 阅读器',
            onLoad: bindFrame,
          }))
        } else {
          children.push(renderNoPdf(current))
        }
        if (frameLoading) {
          children.push(h('div', { key: 'loading', className: 'zot-frame-overlay' }, [
            h('span', { key: 'spin', className: 'zot-spinner' }),
            h('span', { key: 'label' }, '正在解析 PDF…'),
          ]))
        } else if (frameError) {
          children.push(h('div', { key: 'error', className: 'zot-frame-overlay' }, [
            h(AlertIcon, { key: 'icon', size: 20 }),
            h('div', { key: 'title', className: 'zot-frame-error-title' }, 'PDF 阅读器加载失败'),
            h('div', { key: 'desc', className: 'zot-frame-error-desc' }, frameError),
            h('button', {
              key: 'retry',
              type: 'button',
              className: 'zot-btn zot-btn-primary',
              onClick: () => setFrameKey((value) => value + 1),
            }, '重试'),
          ]))
        }
        return h('div', { key: 'reader', className: 'zot-reader' }, children)
      }

      function renderMain() {
        if (!selectedKey) {
          return h('div', { key: 'main', className: 'zot-main' }, renderState({
            icon: ZoteroIcon,
            title: '选择一篇文献开始阅读',
            desc: '从左侧列表选择文献即可在右侧阅读全文；在正文中框选文字，就能向 AI 提问。',
          }))
        }
        if (detailError) {
          return h('div', { key: 'main', className: 'zot-main' }, renderState({
            icon: AlertIcon,
            title: '无法读取该文献',
            desc: detailError,
            actionLabel: '重试',
            onAction: () => setDetailRetry((value) => value + 1),
          }))
        }
        if (!paper) return h('div', { key: 'main', className: 'zot-main' }, renderLoadingState('正在载入文献…'))
        return h('div', { key: 'main', className: 'zot-main' }, [
          h('div', { key: 'paper', className: 'zot-paper-pane' }, [
            renderPaperHead(paper),
            renderReader(paper),
          ]),
          renderChatPane(),
        ])
      }

      // ---- render ---------------------------------------------------------

      return h('div', { className: cxs('zot-root', paper && 'zot-has-paper') }, [
        h('div', { key: 'head', className: 'zot-head' }, [
          h('div', { key: 'brand', className: 'zot-brand' }, [
            h(ZoteroIcon, { key: 'icon', size: 17 }),
            h('span', { key: 'text' }, 'Zotero'),
            h('span', { key: 'count', className: 'zot-count' }, String(listLoading && total === 0 ? '…' : total) + ' 篇'),
            collection ? h('button', {
              key: 'filter',
              type: 'button',
              className: 'zot-filter-chip',
              title: '当前分类：' + activeFolderName + '（点击查看全部文献）',
              onClick: () => selectCollection(COLLECTION_ALL),
            }, [
              h(FolderIcon, { key: 'icon', size: 12 }),
              h('span', { key: 'name' }, activeFolderName),
              h(CloseIcon, { key: 'x', size: 10 }),
            ]) : null,
          ]),
          h('span', { key: 'spacer', className: 'zot-head-spacer' }),
          h('label', { key: 'search', className: 'zot-search' }, [
            h(SearchIcon, { key: 'icon', size: 14 }),
            h('input', {
              key: 'input',
              type: 'text',
              value: query,
              placeholder: '搜索标题、作者…',
              spellCheck: false,
              onChange: (event) => setQuery(event.target.value),
              'aria-label': '搜索 Zotero 文献',
            }),
            query ? h('button', {
              key: 'clear',
              type: 'button',
              className: 'zot-search-clear',
              title: '清除搜索',
              'aria-label': '清除搜索',
              onClick: () => setQuery(''),
            }, h(CloseIcon, { size: 12 })) : null,
          ]),
          h('button', {
            key: 'folders',
            type: 'button',
            className: 'zot-iconbtn zot-folder-toggle',
            title: '分类',
            'aria-label': '打开分类',
            'aria-expanded': foldersOpen ? 'true' : 'false',
            onClick: () => setFoldersOpen((value) => !value),
          }, h(FolderIcon, { size: 15 })),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'zot-iconbtn',
            title: '刷新文献库',
            'aria-label': '刷新文献库',
            onClick: refreshAll,
            disabled: listLoading,
          }, h(RefreshIcon, { size: 15, className: listLoading ? 'zot-spin' : undefined })),
        ]),
        h('div', { key: 'body', className: 'zot-body' }, [
          renderFolders(),
          h('div', { key: 'left', className: 'zot-list' }, [
            h('div', {
              key: 'scroll',
              ref: listScrollRef,
              className: 'zot-list-scroll',
              role: 'list',
              'aria-label': 'Zotero 文献列表',
              'aria-busy': listLoading ? 'true' : 'false',
            }, renderListBody()),
            renderFooter(),
          ]),
          renderMain(),
          renderFolderDrawer(),
        ]),
      ])
    }

    // --- Plugin definition -------------------------------------------------

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        label: () => 'Zotero',
      }, ZoteroIcon))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ pluginCtx: ctx }),
      }, ZoteroPanel))
    }

    const inject = ['slots']

    exports.name = 'zotero'
    exports.inject = inject
    exports.apply = apply
    // Exposed for the offline smoke test only; the shell ignores extra exports.
    exports.__test = {
      buildPrompt: buildPrompt,
      buildCollectionTree: buildCollectionTree,
      authorLine: authorLine,
      typeLabel: typeLabel,
      pageOfSelection: pageOfSelection,
      viewerUrl: viewerUrl,
      readPersisted: readPersisted,
      buildFollowupPrompt: buildFollowupPrompt,
      renderRichText: renderRichText,
      sanitizeNoteHtml: sanitizeNoteHtml,
      noteHtmlFromText: noteHtmlFromText,
      splitMathSegments: splitMathSegments,
      parsePromptForDisplay: parsePromptForDisplay,
      chatMessageOf: chatMessageOf,
      contentText: contentText,
      shortTitle: shortTitle,
      readProgress: readProgress,
      writeProgress: writeProgress,
      readPaperChats: readPaperChats,
      writePaperChats: writePaperChats,
      PAPER_CHATS_KEY: PAPER_CHATS_KEY,
      ensureStyles: ensureStyles,
      CSS: CSS,
      LS_KEY: LS_KEY,
      DEFAULT_QUESTION: DEFAULT_QUESTION,
      DEFAULT_PAPER_QUESTION: DEFAULT_PAPER_QUESTION,
      COLLECTION_UNFILED: COLLECTION_UNFILED,
      MAX_SELECTION_CHARS: MAX_SELECTION_CHARS,
    }
    return module.exports
  },
})
