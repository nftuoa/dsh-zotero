/**
 * Optional model-facing Zotero tools (`zotero_search`, `zotero_paper`).
 *
 * These are plain object tool definitions (no imports from `@deepseek-ai/dsh-tools`
 * needed): `parameters` and `output.schema` are raw JSON Schema objects, and
 * `render` projects the canonical value into model content. They are registered
 * through `ctx.inject(['tools'], …)` so profiles without a tool registry still
 * load the plugin.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Cap for extracted paper text returned to the model. */
const MAX_PAPER_TEXT = 60_000

/** Pages fed to `pdftotext` (first N pages is enough context for Q&A). */
const PDFTOTEXT_MAX_PAGES = 40

const SEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          itemKey: { type: 'string' },
          title: { type: 'string' },
          authors: { type: 'string' },
          year: { type: 'string' },
        },
        required: ['itemKey', 'title', 'authors', 'year'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
}

const PAPER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    authors: { type: 'string' },
    year: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['title', 'authors', 'year', 'text'],
  additionalProperties: false,
}

function authorsOf(item) {
  return item.creators.map((creator) => creator.name).filter(Boolean).join(', ')
}

/**
 * Describe why `pdftotext` did not produce text, for the model to act on.
 * @param {unknown} error - execFile rejection.
 * @returns {Error}
 */
function pdfToTextError(error) {
  const err = /** @type {NodeJS.ErrnoException & { killed?: boolean }} */ (error)
  if (err && err.code === 'ENOENT') {
    return new Error('pdftotext 未安装或不在 PATH 中，无法提取 PDF 文本。')
  }
  if (err && err.killed) {
    return new Error('pdftotext 超时，未能提取 PDF 文本。')
  }
  const stderr = err && typeof err.stderr === 'string' ? err.stderr.trim() : ''
  return new Error(`pdftotext 提取失败${stderr ? `：${stderr.slice(0, 300)}` : '。'}`)
}

/**
 * Build the Zotero tool definitions bound to one library handle.
 *
 * @param {{library: import('./zotero-data.mjs').ZoteroLibrary}} options
 * @returns {object[]} registrable tool definitions.
 */
export function createZoteroTools({ library }) {
  const searchTool = {
    name: 'zotero_search',
    description:
      'Search the local Zotero library by title, author, publication, DOI or tag. Returns up to 10 matching papers with their Zotero item key; use zotero_paper with an itemKey to read the paper text.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text, for example a title fragment, author name, DOI or topic keyword.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: SEARCH_OUTPUT_SCHEMA,
      render(args, value) {
        const results = Array.isArray(value.results) ? value.results : []
        if (results.length === 0) {
          return [{ type: 'text', text: `No Zotero papers matched ${JSON.stringify(String(args.query ?? ''))}.` }]
        }
        const lines = results.map(
          (result) =>
            `- ${result.title} — ${result.authors || 'unknown authors'}${result.year ? ` (${result.year})` : ''} [itemKey: ${result.itemKey}]`,
        )
        return [{ type: 'text', text: `Zotero search results for ${JSON.stringify(String(args.query ?? ''))}:\n${lines.join('\n')}` }]
      },
    },
    async execute(args) {
      const query = String((args && args.query) || '').trim()
      if (query.length === 0) throw new Error('query must be a non-empty string')
      const { items } = await library.listItems({ q: query, limit: 10 })
      return {
        results: items.map((item) => ({
          itemKey: item.key,
          title: item.title,
          authors: authorsOf(item),
          year: item.year,
        })),
      }
    },
  }

  const paperTool = {
    name: 'zotero_paper',
    description:
      'Read one Zotero paper by its item key: title, authors, year, and the first ~40 pages of text extracted from the attached PDF with pdftotext. Use zotero_search to find an item key first.',
    parameters: {
      type: 'object',
      properties: {
        itemKey: {
          type: 'string',
          description: 'Zotero item key (the 8-character key returned by zotero_search or /zotero/api/items).',
        },
      },
      required: ['itemKey'],
      additionalProperties: false,
    },
    output: {
      schema: PAPER_OUTPUT_SCHEMA,
      render(args, value) {
        const header = `${value.title} — ${value.authors || 'unknown authors'}${value.year ? ` (${value.year})` : ''}`
        const body = value.text && value.text.trim().length > 0 ? value.text : '(没有提取到文本。)'
        return [{ type: 'text', text: `${header}\n\n${body}` }]
      },
    },
    async execute(args, exec) {
      const itemKey = String((args && args.itemKey) || '').trim()
      if (itemKey.length === 0) throw new Error('itemKey must be a non-empty string')
      const item = await library.getItem(itemKey)
      if (!item) throw new Error(`未找到 Zotero 条目：${itemKey}`)
      if (!item.pdf || !item.pdf.path) throw new Error(`条目 ${itemKey} 没有可读取的 PDF 附件。`)
      let text = ''
      try {
        const { stdout } = await execFileAsync(
          'pdftotext',
          ['-layout', '-l', String(PDFTOTEXT_MAX_PAGES), item.pdf.path, '-'],
          {
            timeout: 45_000,
            maxBuffer: 32 * 1024 * 1024,
            signal: exec && exec.signal ? exec.signal : undefined,
          },
        )
        text = String(stdout || '').slice(0, MAX_PAPER_TEXT)
      } catch (error) {
        throw pdfToTextError(error)
      }
      return {
        title: item.title,
        authors: authorsOf(item),
        year: item.year,
        text,
      }
    },
  }

  return [searchTool, paperTool]
}
