(async () => {
  const started = Date.now()
  while (!window.__zoteroViewerReady && Date.now() - started < 30000) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const canvases = Array.from(document.querySelectorAll('.page canvas'))
  let paintedCanvases = 0
  let inkPixels = 0
  for (const canvas of canvases) {
    try {
      const context = canvas.getContext('2d')
      const width = Math.min(canvas.width, 300)
      const height = Math.min(canvas.height, 300)
      const data = context.getImageData(0, 0, width, height).data
      let ink = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) ink += 1
      }
      if (ink > 0) paintedCanvases += 1
      inkPixels += ink
    } catch (error) {
      /* tainted canvas cannot be read; same-origin here, so ignore */
    }
  }
  const spans = Array.from(document.querySelectorAll('.textLayer span'))
  const textSpans = spans.filter((span) => (span.textContent || '').trim().length > 0)
  let selection = { text: '', page: null, spanCount: spans.length }
  if (typeof window.__selectText === 'function' && textSpans.length >= 2) {
    selection = window.__selectText(1, Math.min(7, textSpans.length - 1))
  }
  const current = window.getSelection()
  let page = selection.page
  let node = current && current.anchorNode
  while (node) {
    if (node.nodeType === 1 && node.dataset && node.dataset.page) {
      page = node.dataset.page
      break
    }
    node = node.parentNode
  }
  return {
    ready: window.__zoteroViewerReady === true,
    viewerError: window.__viewerError || null,
    pdfPages: window.__pdf ? window.__pdf.numPages : 0,
    renderedPageDivs: document.querySelectorAll('.page[data-page]').length,
    canvases: canvases.length,
    paintedCanvases,
    inkPixels,
    spanCount: spans.length,
    nonEmptySpans: textSpans.length,
    scale: window.__zoteroViewer ? window.__zoteroViewer.scale : null,
    toolbarText: (document.getElementById('info') || {}).textContent || '',
    selectionText: selection.text,
    selectionLength: selection.text.length,
    selectionPage: page,
  }
})()
