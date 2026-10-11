/**
 * PDF support.
 *
 * A PDF page has no image bytes to serve, so unlike CBZ/CBR/CB7 a PDF is not
 * read by the main process. The document is handed to the viewer as a URL and
 * rendered here with pdf.js onto a canvas, which the existing layout code then
 * positions exactly like an image.
 */

const PDF_MODULE_URL = "pageforge://app/vendor/pdfjs-dist/build/pdf.mjs";
const PDF_WORKER_URL = "pageforge://app/vendor/pdfjs-dist/build/pdf.worker.mjs";

/** pdf.js is loaded once and its worker pointed at our own origin. */
let pdfjsPromise = null;
const loadPdfjs = () => {
  pdfjsPromise ??= import(PDF_MODULE_URL).then((module) => {
    module.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
    return module;
  });
  return pdfjsPromise;
};

/**
 * Open a PDF and describe its pages the same way the archive reader does, so
 * spreads, fitting and navigation need no PDF-specific branches.
 */
export const openPdfDocument = async (url) => {
  const pdfjs = await loadPdfjs();
  const document_ = await pdfjs.getDocument({ url, isEvalSupported: false }).promise;
  const pages = [];
  for (let number = 1; number <= document_.numPages; number += 1) {
    const page = await document_.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    pages.push({
      index: number - 1,
      name: `Page ${number}`,
      width: Math.max(1, Math.round(viewport.width)),
      height: Math.max(1, Math.round(viewport.height)),
      format: "pdf",
      kind: "pdf",
      url: null,
    });
  }
  return { document: document_, pages };
};

/** Cap on a rendered page's backing store, so a deep zoom cannot exhaust memory. */
const MAX_CANVAS_PIXELS = 24_000_000;

/**
 * Start rendering one page into a canvas at `scale` (device pixels per PDF
 * point). Returns the pdf.js render task unresolved so the caller can cancel a
 * render that a newer one has superseded.
 */
export const startPdfRender = async (document_, pageIndex, canvas, scale) => {
  const page = await document_.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const requested = base.width * base.height * scale * scale;
  const limited = requested > MAX_CANVAS_PIXELS ? scale * Math.sqrt(MAX_CANVAS_PIXELS / requested) : scale;
  const viewport = page.getViewport({ scale: limited });
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext("2d", { alpha: false });
  const task = page.render({ canvasContext: context, viewport, canvas });
  return { task, scale: limited };
};
