/**
 * PageForge viewer.
 *
 * Holds the reading state (current spread, scale, pan, rotation, reading
 * direction) and renders it. All layout arithmetic lives in `../core/` so it can
 * be tested without a window; this file only translates that state into DOM.
 */

import {
  IDENTITY_GAINS,
  averageChannelMeans,
  colorFilterParameters,
  computeWhiteBalanceGains,
  scanFilterParameters,
  sepiaMatrix,
  sharpenKernel,
} from "../core/color.js";
import { clampScale, fitScale, zoomStep } from "../core/fit.js";
import { comicInfoLabel } from "../core/comicinfo.js";
import { lensPosition, magnifierSample } from "../core/magnifier.js";
import {
  detectPanels,
  framePanel,
  keepPanelsWithArtwork,
  panelStripRows,
  panelsAreUsable,
  panelsFormStrip,
} from "../core/panels.js";
import { describeStatus } from "../core/status.js";
import {
  railWidth,
  revealScrollLeft,
  thumbnailOffset,
  thumbnailWindow,
} from "../core/thumbnails.js";
import { DEFAULT_PREFERENCES, describeHistoryEntry, resolveStartPage } from "../core/library.js";
import {
  COMMAND_LABELS,
  REBINDABLE_COMMANDS,
  DEFAULT_SHORTCUTS,
  keyFromEvent,
  normalizeShortcuts,
  resolveCommand,
} from "../core/shortcuts.js";
import { buildSpreads, spreadIndexForPage, visualOrder } from "../core/spread.js";
import { clampPan, panBounds, zoomAtPoint } from "../core/viewport.js";
import { openPdfDocument, startPdfRender } from "./pdf.js";

const api = window.pageforge;

const stage = document.getElementById("stage");
const spreadEl = document.getElementById("spread");
const emptyState = document.getElementById("empty-state");
const pageLabel = document.getElementById("page-label");
const bookLabel = document.getElementById("book-label");
const infoLabel = document.getElementById("info-label");
const zoomLabel = document.getElementById("zoom-label");
const progressLabel = document.getElementById("progress-label");
const modeLabel = document.getElementById("mode-label");
const toastEl = document.getElementById("toast");
const gotoDialog = document.getElementById("goto-dialog");
const gotoInput = document.getElementById("goto-input");
const helpDialog = document.getElementById("help-dialog");
const thumbnailsEl = document.getElementById("thumbnails");
const bookmarkList = document.getElementById("bookmark-list");
const bookmarkName = document.getElementById("bookmark-name");
const bookmarksDialog = document.getElementById("bookmarks-dialog");
const recentList = document.getElementById("recent-list");
const recentDialog = document.getElementById("recent-dialog");
const preferencesDialog = document.getElementById("preferences-dialog");
const prefColorMode = document.getElementById("pref-color-mode");
const prefSensitivity = document.getElementById("pref-sensitivity");
const prefGamma = document.getElementById("pref-gamma");
const prefVibrance = document.getElementById("pref-vibrance");
const prefResampling = document.getElementById("pref-resampling");
const prefPrefetch = document.getElementById("pref-prefetch");
const prefToolbarFullscreen = document.getElementById("pref-toolbar-fullscreen");
const prefGuided = document.getElementById("pref-guided");
const prefGuidedFill = document.getElementById("pref-guided-fill");
const prefGuidedPan = document.getElementById("pref-guided-pan");
const prefGuidedEasing = document.getElementById("pref-guided-easing");
const prefGuidedSpotlight = document.getElementById("pref-guided-spotlight");
const prefVertical = document.getElementById("pref-vertical");
const prefPanelStrip = document.getElementById("pref-panel-strip");
const prefBrightness = document.getElementById("pref-brightness");
const prefContrast = document.getElementById("pref-contrast");
const prefGrayscale = document.getElementById("pref-grayscale");
const prefSepia = document.getElementById("pref-sepia");
const prefSharpen = document.getElementById("pref-sharpen");
const prefRemember = document.getElementById("pref-remember");
const prefCrash = document.getElementById("pref-crash");
const prefCrashDsn = document.getElementById("pref-crash-dsn");
/** The three per-channel transfer functions inside each transfer stage. */
const toneCurves = {
  r: document.querySelector("#pf-tone feFuncR"),
  g: document.querySelector("#pf-tone feFuncG"),
  b: document.querySelector("#pf-tone feFuncB"),
};
const gammaCurves = {
  r: document.querySelector("#pf-gamma feFuncR"),
  g: document.querySelector("#pf-gamma feFuncG"),
  b: document.querySelector("#pf-gamma feFuncB"),
};
const grayscaleMatrix = document.getElementById("pf-grayscale");
const saturationMatrix = document.getElementById("pf-saturation");
const sepiaMatrixElement = document.getElementById("pf-sepia");
const sharpenKernelElement = document.getElementById("pf-sharpen");
const magnifierEl = document.getElementById("magnifier");
const magnifierContext = magnifierEl.getContext("2d");
const shortcutList = document.getElementById("shortcut-list");

/** Fallback size for pages whose header could not be parsed. */
const UNKNOWN_PAGE_SIZE = { width: 1000, height: 1500 };

/** Set once the command-line startup command has been applied. */
let startupCommandApplied = false;

/**
 * Every apply gets a token, and only the newest one is allowed to finish its
 * work. Startup can deliver the same book twice (the push from the main process
 * and the getBook() call race), and interleaved applies would otherwise fight
 * over the DOM and report readiness twice.
 */
let applyToken = 0;

const state = {
  book: null,
  /** Open pdf.js document when the book is a PDF, otherwise null. */
  pdf: null,
  spreads: [],
  spreadIndex: 0,
  scale: 1,
  offset: { x: 0, y: 0 },
  fitMode: "screen",
  rotation: 0,
  doublePage: false,
  rightToLeft: false,
  /** DOM nodes for the current spread: [{ page, wrapper, element }]. */
  nodes: [],
  drag: null,
  lastDragMoved: false,
  /** Library state, refreshed from the main process. */
  preferences: { ...DEFAULT_PREFERENCES },
  history: [],
  bookmarks: [],
  thumbnailsVisible: false,
  /** White balance currently applied to the spread. */
  colorGains: { ...IDENTITY_GAINS },
  /** Per-page white balance results, so scrolling back does not resample. */
  colorGainsByPage: new Map(),
  /** Page URLs already decoded ahead of the reader. */
  prefetched: new Set(),
  /** Key bindings, refreshed from the main process. */
  shortcuts: normalizeShortcuts(DEFAULT_SHORTCUTS),
  /** Slot awaiting a key press in the shortcuts dialog, or null. */
  capturing: null,
  /** True while the window really is full screen. */
  fullscreen: false,
  /** True while a panel camera, rather than a fit mode, drives the transform. */
  guidedCamera: false,
  /** Zoom multiplier for the vertical column. */
  verticalZoom: 1,
  /** Which vertical pages currently hold a rendered PDF bitmap. */
  verticalRendered: new Map(),
  /** Panels detected per page for the vertical strip, or null when unusable. */
  stripPanels: new Map(),
  /** Bumped when strip panels arrive, to trigger a rebuild. */
  stripVersion: 0,
  /** Lazily loads row backgrounds as they approach the viewport. */
  stripObserver: null,
  /** Counts pages whose panel sample could not be read. */
  stripSampleFailures: 0,
  /** Panels detected for a page, by page index. */
  guidedPanels: new Map(),
  /** Which panel of the current page the camera is on. */
  guidedStep: 0,
  /** True while the slideshow is advancing pages. */
  slideshowRunning: false,
};

/* Sizing ------------------------------------------------------------------- */

const pageSize = (page) =>
  page.width > 0 && page.height > 0 ? { width: page.width, height: page.height } : UNKNOWN_PAGE_SIZE;

const orientedSize = (size) =>
  state.rotation % 180 === 90 ? { width: size.height, height: size.width } : size;

const viewportSize = () => ({ width: stage.clientWidth, height: stage.clientHeight });

const currentSpread = () => state.spreads[state.spreadIndex] ?? null;

/** Natural (unscaled) size of a spread once rotation is applied. */
const spreadNaturalSize = (spread) => {
  const sizes = spread.indices.map((index) => orientedSize(pageSize(state.book.pages[index])));
  return {
    width: sizes.reduce((total, size) => total + size.width, 0),
    height: Math.max(...sizes.map((size) => size.height)),
  };
};

const contentSize = () => {
  const spread = currentSpread();
  if (spread === null) return { width: 0, height: 0 };
  const natural = spreadNaturalSize(spread);
  return { width: natural.width * state.scale, height: natural.height * state.scale };
};

const panMargin = () => Math.min(120, viewportSize().height * 0.2);

/* Rendering ---------------------------------------------------------------- */

const updateStatus = () => {
  const spread = currentSpread();
  // The panels the reader actually steps through, which excludes any the detector
  // proposed but were refused.
  const panels = guidedPanelList();
  const status = describeStatus({
    hasBook: state.book !== null && spread !== null,
    displayName: state.book?.displayName,
    firstPage: spread === null ? 1 : spread.indices[0] + 1,
    lastPage: spread === null ? 1 : spread.indices[spread.indices.length - 1] + 1,
    totalPages: state.book?.pages.length ?? 0,
    rightToLeft: state.rightToLeft,
    doublePage: state.doublePage,
    vertical: verticalActive(),
    strip: stripActive(),
    guided: guidedActive(),
    fitMode: state.fitMode,
    rotation: state.rotation,
    zoom: state.scale,
    verticalZoom: state.verticalZoom,
    panelIndex: state.guidedStep,
    panelCount: panels?.length ?? 0,
  });
  modeLabel.textContent = status.modeText;
  zoomLabel.textContent = status.zoomText;
  pageLabel.textContent = status.pageText;
  bookLabel.textContent = status.bookText;
  progressLabel.textContent = status.progressText;
};

/** Push the current scale, rotation and offset onto the existing DOM nodes. */
const layoutSpread = (options = {}) => {
  const spread = currentSpread();
  if (spread === null) {
    updateStatus();
    return;
  }
  const viewport = viewportSize();
  const content = contentSize();
  // A panel camera places the view deliberately, so it is not clamped back to
  // the page bounds the way a fit or a drag is.
  if (!state.guidedCamera) state.offset = clampPan(state.offset, content, viewport, panMargin());

  for (const node of state.nodes) {
    const base = pageSize(node.page);
    const oriented = orientedSize(base);
    node.wrapper.style.width = `${oriented.width * state.scale}px`;
    node.wrapper.style.height = `${oriented.height * state.scale}px`;
    node.element.style.width = `${base.width * state.scale}px`;
    node.element.style.height = `${base.height * state.scale}px`;
    node.element.style.transform = `translate(-50%, -50%) rotate(${state.rotation}deg)`;
  }

  // Page changes should be instant; moving between panels should glide.
  const pan = state.preferences.guidedPanMs ?? 0;
  spreadEl.style.transition =
    options.animate === true && pan > 0
      ? `transform ${pan}ms ${state.preferences.guidedEasing ?? "ease-out"}`
      : "";
  spreadEl.style.transform = `translate(${state.offset.x}px, ${state.offset.y}px)`;
  positionSpotlight();
  scheduleCanvasRenders();
  sampleSpreadColor();
  updateStatus();
};

/**
 * PDF pages and high-quality resampling both go through a canvas, rendered at a
 * resolution that matches what is on screen and re-rendered when zooming makes
 * the current bitmap too coarse. Ordinary image pages need none of this:
 * Chromium decodes them at display resolution itself.
 */
const scheduleCanvasRenders = () => {
  if (state.book === null) return;
  for (const node of state.nodes) {
    if (node.kind === "image") continue;
    if (node.kind === "pdf" && state.pdf === null) continue;
    const resolution = Math.min(3, Math.max(1, (window.devicePixelRatio || 1) * state.scale));
    const previous = node.renderedScale;
    if (previous > 0 && Math.abs(resolution - previous) / previous <= 0.25) continue;
    void renderCanvasNode(node, resolution);
  }
};

const renderCanvasNode = async (node, resolution) => {
  node.currentTask?.cancel?.();
  const token = Symbol("render");
  node.renderToken = token;
  try {
    if (node.kind === "pdf") {
      const { task, scale } = await startPdfRender(state.pdf, node.page.index, node.element, resolution);
      if (node.renderToken !== token) {
        task.cancel();
        return;
      }
      node.currentTask = task;
      await task.promise;
      if (node.renderToken === token) node.renderedScale = scale;
    } else {
      // High-quality resampling: draw the decoded page into a canvas at the
      // resolution it will be shown at, using the browser's best downscale.
      const source = node.source;
      if (source === undefined || !source.complete || source.naturalWidth === 0) return;
      const base = pageSize(node.page);
      const width = Math.max(1, Math.round(base.width * resolution));
      const height = Math.max(1, Math.round(base.height * resolution));
      node.element.width = width;
      node.element.height = height;
      const context = node.element.getContext("2d", { alpha: false });
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(source, 0, 0, width, height);
      if (node.renderToken === token) node.renderedScale = resolution;
    }
    if (state.nodes[0] === node) {
      sampleSpreadColor();
      ensureGuidedCamera();
    }
  } catch (error) {
    // A cancelled render is expected whenever the user moves on quickly.
    if (node.renderToken === token && error?.name !== "RenderingCancelledException") {
      toast(`Page ${node.page.index + 1} could not be rendered.`);
    }
  }
};

/* Colour handling ---------------------------------------------------------- */

/** Push the current colour and scan settings into the SVG filter. */
const applyColorFilter = () => {
  const color = colorFilterParameters(state.preferences, state.colorGains);
  const scan = scanFilterParameters(state.preferences);

  // Colour correction: white balance gain and gamma per channel.
  for (const curve of Object.values(gammaCurves)) {
    curve.setAttribute("exponent", String(color.exponent));
  }
  gammaCurves.r.setAttribute("amplitude", String(color.r));
  gammaCurves.g.setAttribute("amplitude", String(color.g));
  gammaCurves.b.setAttribute("amplitude", String(color.b));
  saturationMatrix.setAttribute("values", String(color.saturation));

  // Scan enhancement: brightness and contrast share one linear stage.
  for (const curve of Object.values(toneCurves)) {
    curve.setAttribute("slope", String(scan.slope));
    curve.setAttribute("intercept", String(scan.intercept));
  }
  grayscaleMatrix.setAttribute("values", String(scan.saturation));
  sepiaMatrixElement.setAttribute("values", sepiaMatrix(scan.sepia).join(" "));
  sharpenKernelElement.setAttribute(
    "kernelMatrix",
    scan.sharpen ? sharpenKernel(scan.sharpenAmount).join(" ") : "0 0 0 0 1 0 0 0 0",
  );

  spreadEl.style.filter = color.active || scan.active ? "url(#pf-color)" : "";
};

const colorSampleCanvas = document.createElement("canvas");
colorSampleCanvas.width = 64;
colorSampleCanvas.height = 64;
const colorSampleContext = colorSampleCanvas.getContext("2d", { willReadFrequently: true });

/**
 * Estimate a white balance from the first page of the spread.
 *
 * Drawing a page into a small canvas and reading it back requires the page to
 * be same-origin, which is why page bytes are served from the viewer's own
 * origin. A page that cannot be sampled is left uncorrected.
 */
const sampleSpreadColor = () => {
  if (state.preferences.colorMode !== "auto") return;
  const node = state.nodes[0];
  if (node === undefined) return;
  const cached = state.colorGainsByPage.get(node.page.index);
  if (cached !== undefined) {
    state.colorGains = cached;
    applyColorFilter();
    return;
  }
  const source = node.element;
  const ready =
    node.kind === "image"
      ? source.complete && source.naturalWidth > 0
      : node.renderedScale > 0 && source.width > 0;
  if (!ready) return;
  try {
    colorSampleContext.clearRect(0, 0, 64, 64);
    colorSampleContext.drawImage(source, 0, 0, 64, 64);
    const means = averageChannelMeans(colorSampleContext.getImageData(0, 0, 64, 64).data);
    if (means === null) return;
    const gains = computeWhiteBalanceGains(means, state.preferences.colorSensitivity);
    state.colorGainsByPage.set(node.page.index, gains);
    state.colorGains = gains;
    applyColorFilter();
  } catch {
    /* An unsampleable page stays uncorrected rather than failing the render. */
  }
};

/** Decode pages near the reader so turning a page does not wait on the disk. */
const prefetchAround = () => {
  const limit = state.preferences.prefetchPages ?? 0;
  if (limit <= 0 || state.book === null) return;
  for (let offset = 1; offset <= limit; offset += 1) {
    for (const index of [state.spreadIndex + offset, state.spreadIndex - offset]) {
      const spread = state.spreads[index];
      if (spread === undefined) continue;
      for (const pageIndex of spread.indices) {
        const page = state.book.pages[pageIndex];
        // PDF pages are cached by pdf.js itself; rendering ahead would cost CPU.
        if (page === undefined || page.kind === "pdf" || state.prefetched.has(page.url)) continue;
        state.prefetched.add(page.url);
        const image = new Image();
        image.src = page.url;
      }
    }
  }
  // Keep the remembered set bounded on a long book.
  if (state.prefetched.size > 96) state.prefetched.clear();
};

/** A page whose header was unreadable reports its real size once decoded. */
const learnDimensions = (page, image) => {
  if (page.width > 0 && page.height > 0) return;
  if (image.naturalWidth === 0 || image.naturalHeight === 0) return;
  page.width = image.naturalWidth;
  page.height = image.naturalHeight;
  rebuildSpreads();
  renderSpread();
};

const renderSpread = () => {
  if (verticalActive()) {
    // The column owns the stage; the paged DOM is left empty.
    spreadEl.replaceChildren();
    for (const node of state.nodes) node.currentTask?.cancel?.();
    state.nodes = [];
    spreadEl.hidden = true;
    renderVertical();
    updateStatus();
    return;
  }
  spreadEl.hidden = false;
  const spread = currentSpread();
  for (const node of state.nodes) node.currentTask?.cancel?.();
  state.nodes = [];
  spreadEl.replaceChildren();
  if (spread === null) {
    updateStatus();
    return;
  }
  const resampling = state.preferences.resampling ?? "linear";
  for (const pageIndex of visualOrder(spread, state.rightToLeft)) {
    const page = state.book.pages[pageIndex];
    const wrapper = document.createElement("div");
    wrapper.className = "page";

    // A PDF page always needs a canvas. A page image only does when the reader
    // asked for high-quality downscaling; otherwise Chromium decodes it better
    // and more cheaply than we can.
    const asCanvas = page.kind === "pdf" || resampling === "high";
    const element = asCanvas ? document.createElement("canvas") : document.createElement("img");
    let source;
    if (page.kind === "pdf") {
      element.className = "page-canvas";
    } else if (asCanvas) {
      element.className = "page-canvas";
      source = new Image();
      source.addEventListener("load", () => scheduleCanvasRenders());
      source.addEventListener("error", () => toast(`Could not display ${page.name}`));
      source.src = page.url;
    } else {
      element.src = page.url;
      element.alt = page.name;
      element.draggable = false;
      if (resampling === "nearest") element.classList.add("pixelated");
      element.addEventListener("load", () => {
        learnDimensions(page, element);
        sampleSpreadColor();
        ensureGuidedCamera();
      });
      element.addEventListener("error", () => toast(`Could not display ${page.name}`));
    }

    wrapper.append(element);
    spreadEl.append(wrapper);
    state.nodes.push({
      page,
      wrapper,
      element,
      source,
      kind: page.kind === "pdf" ? "pdf" : asCanvas ? "resample" : "image",
      renderedScale: 0,
      renderToken: null,
      currentTask: null,
    });
  }
  layoutSpread();
};

/* Book lifecycle ----------------------------------------------------------- */

const rebuildSpreads = () => {
  state.spreads = buildSpreads(
    state.book.pages.map((page) => pageSize(page)),
    // Guided view frames one page at a time and the vertical column is one page
    // per row, so pairing is suspended for both; the double-page preference is
    // kept for when they are turned off.
    {
      doublePage:
        state.doublePage &&
        state.preferences.guidedView !== true &&
        state.preferences.verticalScroll !== true,
      coverAlone: false,
    },
  );
  state.spreadIndex = Math.min(state.spreadIndex, Math.max(0, state.spreads.length - 1));
};

const applyFit = () => {
  // In vertical mode there is no page-shaped viewport to fit; the column width
  // is the zoom, so a fit simply re-lays the column.
  if (verticalActive()) {
    renderVertical();
    updateStatus();
    return;
  }
  const spread = currentSpread();
  if (spread === null) return;
  state.scale = clampScale(fitScale(state.fitMode === "manual" ? "screen" : state.fitMode, spreadNaturalSize(spread), viewportSize()));
  state.offset = { x: 0, y: 0 };
  layoutSpread();
};

/** Wait until the first page of the spread has something on screen. */
const waitForFirstPage = async () => {
  const node = state.nodes[0];
  if (node === undefined) return;
  if (node.kind === "image") {
    if (node.element.complete) return;
    await new Promise((resolve) => {
      node.element.addEventListener("load", resolve, { once: true });
      node.element.addEventListener("error", resolve, { once: true });
      setTimeout(resolve, 5000);
    });
    return;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && node.renderedScale === 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** Wait until the current page's panels have been detected, for either mode. */
const waitForPanels = async (timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs;
  const stillWaiting = () => {
    if (guidedActive() && currentPanels() === null) return true;
    if (stripActive() && !state.stripPanels.has(state.spreadIndex)) return true;
    return false;
  };
  while (Date.now() < deadline && stillWaiting()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const reportReady = async () => {
  await waitForFirstPage();
  await waitForPanels();
  const node = state.nodes[0];
  const spread = currentSpread();
  const rendered =
    node !== undefined &&
    (node.kind === "image"
      ? Boolean(node.element.complete && node.element.naturalWidth > 0)
      : node.renderedScale > 0 && node.element.width > 0);
  api.reportReady({
    displayName: state.book.displayName,
    kind: state.book.kind,
    pages: state.book.pages.length,
    spreads: state.spreads.length,
    spreadPages: spread === null ? 0 : spread.indices.length,
    renderedPages: state.nodes.length,
    firstPageRendered: rendered,
    firstPageFormat: node === undefined ? null : node.page.format,
    firstPageProbe: node === undefined ? null : { width: node.page.width, height: node.page.height },
    // Library facts, so a smoke run can prove resume and bookmarks end to end.
    startPage: (spread?.indices[0] ?? 0) + 1,
    bookmarkCount: state.bookmarks.length,
    historyCount: state.history.length,
    thumbnails: thumbnailsEl.hidden ? 0 : mountedThumbs.size,
    thumbnailPages: state.book?.pages.length ?? 0,
    // Mounted thumbnails that have their preview, so a virtualised strip cannot
    // silently stop filling the ones it keeps.
    thumbnailsFilled: [...mountedThumbs.values()].filter(
      (button) => button.firstElementChild?.tagName === "IMG" || button.firstElementChild?.tagName === "CANVAS",
    ).length,
    // Reading-quality facts, so the colour and scaling paths are assertable.
    colorMode: state.preferences.colorMode,
    colorGains: { ...state.colorGains },
    nodeKinds: state.nodes.map((node) => node.kind),
    magnifierVisible: state.preferences.magnifierVisible === true,
    slideshowRunning: state.slideshowRunning,
    nextPagePrimary: state.shortcuts["next-page"].primary,
    // The window's real state, not what the viewer thinks it asked for.
    fullscreen: await api.isFullscreen().catch(() => state.fullscreen),
    guidedView: state.preferences.guidedView === true,
    verticalScroll: state.preferences.verticalScroll === true,
    verticalPages: scrollEl.hidden ? 0 : scrollEl.childElementCount,
    stripPanelPages: state.stripPanels.size,
    stripPanelTitle: state.stripPanels.get(state.spreadIndex)?.length ?? 0,
    stripActive: stripActive(),
    resumeBannerVisible: !resumeBanner.hidden,
    resumeText: resumeText.textContent,
    comicInfoLabel: comicInfoLabel(state.book?.comicInfo ?? null) ?? "",
    comicInfoDirection: state.book?.comicInfo?.direction ?? null,
    comicInfoPagesReordered: Array.isArray(state.book?.comicInfo?.pageOrder),
    indexCache: state.book?.indexCache ?? null,
    openMs: state.book?.openMs ?? null,
    crashReport: lastCrashReportResult,
    storage: state.storageBackend ?? null,
    // Read from the store, not from the dialog: the report must not depend on
    // whether anyone opened it.
    achievements: await api
      .getAchievements()
      .then((summary) => ({
        earned: summary.entries.filter((entry) => entry.unlockedAt !== null).length,
        total: summary.entries.length,
        pagesTurned: summary.measures.pagesTurned,
        booksFinished: summary.measures.booksFinished,
        currentStreak: summary.measures.currentStreak,
      }))
      .catch(() => null),
    firstPageName: state.book?.pages?.[0]?.name ?? null,
    lastPageName: state.book?.pages?.[state.book.pages.length - 1]?.name ?? null,
    rightToLeft: state.rightToLeft === true,
    stripQueue: stripQueue.length,
    stripPending: stripPending.size,
    stripInFlight,
    stripSampleFailures: state.stripSampleFailures,
    progress: progressLabel.textContent,
    pageText: pageLabel.textContent,
    zoomText: zoomLabel.textContent,
    guidedPanels: guidedPanelList()?.length ?? 0,
    guidedDetected: currentPanels()?.length ?? 0,
    guidedStep: state.guidedStep,
    // Whether guided view is actually framing a panel. The detected count alone is
    // misleading: panels can be detected and then refused as untrustworthy, in
    // which case the page is shown whole and no camera is engaged.
    guidedUsable:
      currentPanels() !== null &&
      state.nodes[0] !== undefined &&
      panelsAreUsable(currentPanels(), pageSize(state.nodes[0].page)),
    guidedCamera: state.guidedCamera === true,
    // Diagnostic: the boxes themselves, in page coordinates.
    guidedBoxes: (guidedPanelList() ?? []).slice(0, 4).map((panel) => ({
      x: Math.round(panel.x),
      y: Math.round(panel.y),
      w: Math.round(panel.width),
      h: Math.round(panel.height),
    })),
  });
};

/** Layout for the open book, as the reader has arranged it. */
const currentBookSettings = () => ({
  doublePage: state.doublePage,
  rightToLeft: state.rightToLeft,
  verticalScroll: state.preferences.verticalScroll === true,
  guidedView: state.preferences.guidedView === true,
  fitMode: state.fitMode,
  rotation: state.rotation,
});

/** Persist the current layout for this book, if the reader wants that. */
const persistBookSettings = () => {
  const target = state.book?.targetPath;
  if (target === null || target === undefined) return;
  if (state.preferences.rememberPerBook === false) return;
  void api.setBookSettings(target, currentBookSettings());
};

const applyBook = async (book) => {
  const token = (applyToken += 1);
  stopSlideshow();
  hideOpening();
  state.pdf = null;
  state.preferences = book.preferences ?? state.preferences;
  if (book.kind === "pdf") {
    try {
      const { document: pdfDocument, pages } = await openPdfDocument(book.documentUrl);
      if (token !== applyToken) return;
      state.pdf = pdfDocument;
      state.book = { ...book, pages };
    } catch (error) {
      if (token !== applyToken) return;
      const message = error instanceof Error ? error.message : String(error);
      toast(`This PDF could not be opened: ${message}`);
      api.reportError({ code: "document-unreadable", message });
      return;
    }
  } else {
    state.book = book;
  }
  state.spreadIndex = 0;
  state.offset = { x: 0, y: 0 };
  state.rotation = 0;
  state.colorGains = { ...IDENTITY_GAINS };
  state.colorGainsByPage.clear();
  state.prefetched.clear();
  state.guidedPanels.clear();
  state.guidedStep = 0;
  state.guidedCamera = false;

  // Layout remembered for this book wins over the global defaults, so a manga
  // volume opens right-to-left whatever the last book was.
  const remembered = book.bookSettings ?? {};
  const info = book.comicInfo ?? null;
  if (state.preferences.rememberPerBook !== false) {
    if (typeof remembered.doublePage === "boolean") state.doublePage = remembered.doublePage;
    if (typeof remembered.verticalScroll === "boolean") {
      state.preferences = { ...state.preferences, verticalScroll: remembered.verticalScroll };
    }
    if (typeof remembered.guidedView === "boolean") {
      state.preferences = { ...state.preferences, guidedView: remembered.guidedView };
    }
    if (typeof remembered.rotation === "number") state.rotation = remembered.rotation;
    if (typeof remembered.fitMode === "string") state.fitMode = remembered.fitMode;
  }
  // Reading direction: a layout the reader chose for this book wins, then the
  // book's own metadata, then whatever the global default was.
  if (state.preferences.rememberPerBook !== false && typeof remembered.rightToLeft === "boolean") {
    state.rightToLeft = remembered.rightToLeft;
  } else if (info?.direction === "rtl") {
    state.rightToLeft = true;
  } else if (info?.direction === "ltr") {
    state.rightToLeft = false;
  }
  infoLabel.textContent = comicInfoLabel(info) ?? "";

  state.stripPanels.clear();
  state.stripVersion = 0;
  stripQueue = [];
  stripPending.clear();
  lastReportedPage = -1;

  rebuildSpreads();
  renderSpread();
  applyFit();
  applyColorFilter();
  prefetchAround();

  // Pick up this book's bookmarks, then resume where the reader left off.
  await refreshLibrary();
  if (token !== applyToken) return;

  const start = resolveStartPage(
    { lastPage: book.resumePage },
    state.book.pages.length,
    state.preferences,
  );
  if (start > 1) {
    goToPage(start);
    showResumeBanner(start, state.book.pages.length);
  }
  buildThumbnails();
  emptyState.hidden = true;
  syncToolbar();

  // A command-line command is applied before readiness is reported, so an
  // automated run observes the state the command produced.
  if (!startupCommandApplied) {
    startupCommandApplied = true;
    const commands = await api.getStartupCommand();
    if (token !== applyToken) return;
    for (const command of Array.isArray(commands) ? commands : [commands]) {
      if (typeof command === "string" && command.length > 0) await runCommand(command);
    }
  }
  if (token !== applyToken) return;
  void reportReady();
};

/** Apply a book from an event, surfacing a failure instead of losing it. */
const applyBookSafely = (book) => {
  applyBook(book).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    toast(`Could not open ${book.displayName}: ${message}`);
    api.reportError({ code: "apply-failed", message });
  });
};

/* Library: preferences, thumbnails, bookmarks, recents ---------------------- */

const applyPreferences = () => {
  state.thumbnailsVisible = state.preferences.showThumbnails === true;
  thumbnailsEl.hidden = !state.thumbnailsVisible;
  if (state.thumbnailsVisible) buildThumbnails();
  applyColorFilter();
  applyChrome();
  syncPreferenceControls();
  syncToolbar();
};

const refreshLibrary = async () => {
  const library = await api.getLibrary();
  state.preferences = library.preferences;
  state.history = library.history;
  state.bookmarks = library.bookmarks;
  state.storageBackend = library.backend ?? null;
  applyPreferences();
  if (library.loadProblem !== null && library.loadProblem !== undefined) toast(library.loadProblem);
  return library;
};

/** Last page sent to the store, so a repeat navigation is not re-sent. */
let lastReportedPage = -1;
/** Remember the reading position, without writing on every page turn. */
/**
 * Record the reading position.
 *
 * Sent as soon as the page changes rather than debounced: the app can be closed
 * at any moment, and a debounced update that has not been sent yet cannot be
 * flushed on the way out, so the page would be lost. Turning a page is human
 * paced, and the main process coalesces the disk write.
 */
const reportProgress = () => {
  const spread = currentSpread();
  if (state.book === null || spread === null) return;
  const page = spread.indices[0] + 1;
  if (page === lastReportedPage) return;
  lastReportedPage = page;
  api.setProgress(state.book.targetPath, page, state.book.pages.length).catch(() => {
    // Allow a retry on the next navigation if this one did not reach the store.
    if (lastReportedPage === page) lastReportedPage = -1;
  });
};

const fillThumbnail = async (button) => {
  const index = Number(button.dataset.page);
  const page = state.book === null ? undefined : state.book.pages[index];
  if (page === undefined) return;
  if (page.kind === "pdf") {
    if (state.pdf === null) return;
    const canvas = document.createElement("canvas");
    try {
      const { task } = await startPdfRender(state.pdf, index, canvas, 0.3);
      await task.promise;
      button.replaceChildren(canvas);
    } catch {
      /* A thumbnail that was scrolled past is not worth reporting. */
    }
    return;
  }
  const image = document.createElement("img");
  image.src = page.url;
  image.alt = "";
  button.replaceChildren(image);
};

/**
 * The thumbnail strip mounts only the thumbnails near the visible window.
 *
 * A page per element is fine for a thirty-page book and wrong for a thousand-page
 * one: every thumbnail would be a node with an image, laid out and painted even
 * though almost none of them can be seen. The rail takes the full scroll width so
 * the scrollbar still means the whole book, and the window slides as it scrolls.
 */
let thumbRail = null;
/** Mounted thumbnails, by page index. */
const mountedThumbs = new Map();

const thumbRange = () =>
  thumbnailWindow({
    count: state.book?.pages.length ?? 0,
    scrollLeft: thumbnailsEl.scrollLeft,
    viewportWidth: thumbnailsEl.clientWidth,
  });

const mountThumb = (index) => {
  const page = state.book.pages[index];
  const button = document.createElement("button");
  button.type = "button";
  button.className = "thumb";
  button.dataset.page = String(index);
  button.title = `${index + 1} · ${page.name}`;
  button.style.left = `${thumbnailOffset(index)}px`;
  button.addEventListener("click", () => goToPage(index + 1));
  const number = document.createElement("span");
  number.className = "thumb-number";
  number.textContent = String(index + 1);
  button.append(number);
  // Mounted means close to visible, so the preview can be fetched straight away.
  void fillThumbnail(button);
  thumbRail.append(button);
  mountedThumbs.set(index, button);
  return button;
};

const syncThumbnails = () => {
  if (state.thumbnailsVisible !== true || state.book === null || thumbRail === null) return;
  const { first, last } = thumbRange();
  for (const [index, button] of mountedThumbs) {
    if (index < first || index > last) {
      button.remove();
      mountedThumbs.delete(index);
    }
  }
  for (let index = first; index <= last; index += 1) {
    if (!mountedThumbs.has(index)) mountThumb(index);
  }
};

const buildThumbnails = () => {
  thumbnailsEl.replaceChildren();
  mountedThumbs.clear();
  thumbRail = null;
  if (!state.thumbnailsVisible || state.book === null) return;

  const count = state.book.pages.length;
  thumbRail = document.createElement("div");
  thumbRail.id = "thumb-rail";
  thumbRail.style.width = `${railWidth(count)}px`;
  thumbnailsEl.append(thumbRail);
  syncThumbnails();
  updateThumbnailHighlight();
};

/** Scroll the strip just far enough to show a page. */
const revealThumbnail = (index) => {
  const scrollLeft = revealScrollLeft({
    index,
    scrollLeft: thumbnailsEl.scrollLeft,
    viewportWidth: thumbnailsEl.clientWidth,
  });
  if (scrollLeft !== null) thumbnailsEl.scrollLeft = scrollLeft;
};

const updateThumbnailHighlight = () => {
  if (state.thumbnailsVisible !== true || state.book === null) return;
  const active = new Set(currentSpread()?.indices ?? []);
  const first = Math.min(...active);
  // The current page may not be mounted yet, so bring it into view first.
  if (Number.isFinite(first)) revealThumbnail(first);
  syncThumbnails();
  for (const [index, button] of mountedThumbs) {
    button.classList.toggle("current", active.has(index));
  }
};

let thumbnailScrollScheduled = false;
const wireThumbnailScroll = () => {
  thumbnailsEl.addEventListener(
    "scroll",
    () => {
      if (thumbnailScrollScheduled) return;
      thumbnailScrollScheduled = true;
      requestAnimationFrame(() => {
        thumbnailScrollScheduled = false;
        syncThumbnails();
      });
    },
    { passive: true },
  );
};

const renderBookmarkList = () => {
  bookmarkList.replaceChildren();
  document.getElementById("bookmark-empty").hidden = state.bookmarks.length > 0;
  for (const bookmark of state.bookmarks) {
    const item = document.createElement("li");
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "jump";
    jump.textContent = bookmark.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = ` — page ${bookmark.page}`;
    jump.append(meta);
    jump.addEventListener("click", () => {
      bookmarksDialog.close();
      goToPage(bookmark.page);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      await api.removeBookmark(bookmark.id);
      await refreshLibrary();
      renderBookmarkList();
    });
    item.append(jump, remove);
    bookmarkList.append(item);
  }
};

const openBookmarksDialog = async () => {
  const spread = currentSpread();
  if (state.book === null || spread === null) return;
  await refreshLibrary();
  document.getElementById("bookmark-page").textContent = String(spread.indices[0] + 1);
  bookmarkName.value = "";
  renderBookmarkList();
  bookmarksDialog.showModal();
  bookmarkName.focus();
};

/** One clickable row for a remembered book. */
const buildHistoryRow = (entry) => {
  const item = document.createElement("li");
  const open = document.createElement("button");
  open.type = "button";
  open.className = "jump";
  open.textContent = entry.displayName;
  open.title = entry.path;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = ` — ${describeHistoryEntry(entry)}, last page ${entry.lastPage ?? 1}`;
  open.append(meta);
  open.addEventListener("click", async () => {
    recentDialog.close();
    const result = await api.openRecent(entry.path);
    if (result.ok) await applyBook(result.book);
    else toast(result.error.message);
  });
  item.append(open);
  return item;
};

/**
 * The recent list, grouped by series when the books declared one.
 *
 * Books that carry no metadata stay in a plain list underneath rather than being
 * gathered under a heading the app invented.
 */
const renderRecentList = (grouped = null) => {
  recentList.replaceChildren();
  const total = state.history.length;
  document.getElementById("recent-empty").hidden = total > 0;
  if (total === 0) return;

  const loose = grouped === null ? state.history : grouped.loose;
  for (const group of grouped?.groups ?? []) {
    const heading = document.createElement("li");
    heading.className = "recent-group";
    heading.textContent = `${group.name} — ${group.entries.length} book${group.entries.length === 1 ? "" : "s"}`;
    recentList.append(heading);
    for (const entry of group.entries) recentList.append(buildHistoryRow(entry));
  }
  if (grouped !== null && grouped.groups.length > 0 && loose.length > 0) {
    const heading = document.createElement("li");
    heading.className = "recent-group";
    heading.textContent = "Other books";
    recentList.append(heading);
  }
  for (const entry of loose) recentList.append(buildHistoryRow(entry));
};

const exportLibrary = async () => {
  const result = await api.exportLibrary();
  if (result.canceled) return;
  if (!result.ok) {
    toast(result.error ?? "The library could not be exported");
    return;
  }
  toast(`Exported ${result.counts.books} books to ${result.path}`);
};

const importLibrary = async () => {
  const result = await api.importLibrary();
  if (result.canceled) return;
  if (!result.ok) {
    toast(result.error ?? "The library could not be imported");
    return;
  }
  await refreshLibrary();
  renderRecentList(await api.groupedHistory().catch(() => null));
  const { historyAdded, historyUpdated, bookmarksAdded, booksFinishedAdded } = result.report;
  toast(
    `Imported: ${historyAdded} new book${historyAdded === 1 ? "" : "s"}, ` +
      `${historyUpdated} updated, ${bookmarksAdded} bookmark${bookmarksAdded === 1 ? "" : "s"}, ` +
      `${booksFinishedAdded} finished`,
  );
};

const openRecentDialog = async () => {
  await refreshLibrary();
  renderRecentList(await api.groupedHistory().catch(() => null));
  recentDialog.showModal();
};

const addBookmarkAtCurrentPage = async () => {
  const spread = currentSpread();
  if (state.book === null || spread === null) return;
  const page = spread.indices[0] + 1;
  await api.addBookmark(state.book.targetPath, page, bookmarkName.value);
  bookmarkName.value = "";
  await refreshLibrary();
  renderBookmarkList();
  toast(`Bookmark added on page ${page}`);
};

/* Reading quality preferences ---------------------------------------------- */

const showPreferenceValues = () => {
  document.getElementById("pref-sensitivity-value").textContent = Number(prefSensitivity.value).toFixed(2);
  document.getElementById("pref-gamma-value").textContent = Number(prefGamma.value).toFixed(2);
  document.getElementById("pref-vibrance-value").textContent = Number(prefVibrance.value).toFixed(2);
  document.getElementById("pref-brightness-value").textContent = Number(prefBrightness.value).toFixed(2);
  document.getElementById("pref-contrast-value").textContent = Number(prefContrast.value).toFixed(2);
  document.getElementById("pref-grayscale-value").textContent = Number(prefGrayscale.value).toFixed(2);
  document.getElementById("pref-sepia-value").textContent = Number(prefSepia.value).toFixed(2);
};

const syncPreferenceControls = () => {
  const preferences = state.preferences;
  prefColorMode.value = preferences.colorMode;
  prefSensitivity.value = String(preferences.colorSensitivity);
  prefGamma.value = String(preferences.gamma);
  prefVibrance.value = String(preferences.vibrance);
  prefResampling.value = preferences.resampling;
  prefPrefetch.value = String(preferences.prefetchPages);
  prefToolbarFullscreen.checked = preferences.toolbarInFullscreen === true;
  prefGuided.checked = preferences.guidedView === true;
  prefGuidedFill.value = String(preferences.guidedFill);
  prefGuidedPan.value = String(preferences.guidedPanMs);
  prefGuidedEasing.value = preferences.guidedEasing;
  prefGuidedSpotlight.checked = preferences.guidedSpotlight === true;
  document.getElementById("pref-guided-fill-value").textContent = Number(prefGuidedFill.value).toFixed(2);
  prefVertical.checked = preferences.verticalScroll === true;
  prefPanelStrip.checked = preferences.panelStrip !== false;
  prefBrightness.value = String(preferences.brightness);
  prefContrast.value = String(preferences.contrast);
  prefGrayscale.value = String(preferences.grayscale);
  prefSepia.value = String(preferences.sepia);
  prefSharpen.checked = preferences.sharpen === true;
  prefRemember.checked = preferences.rememberPerBook !== false;
  prefCrash.checked = preferences.crashReporting === true;
  prefCrashDsn.value = preferences.crashReportingDsn ?? "";
  showPreferenceValues();
};

/**
 * Persist one preference and apply its consequences. Changing the scaling mode
 * rebuilds the spread, because it decides whether pages are images or canvases.
 */
const writePreference = async (key, value) => {
  const preferences = await api.setPreference(key, value);
  if (preferences === null || typeof preferences !== "object") return;
  const resamplingChanged = preferences.resampling !== state.preferences.resampling;
  state.preferences = preferences;
  syncPreferenceControls();
  applyColorFilter();

  if (key === "colorMode" || key === "colorSensitivity") state.colorGainsByPage.clear();
  if (key === "prefetchPages") {
    state.prefetched.clear();
    prefetchAround();
  }
  if (resamplingChanged && state.book !== null) {
    renderSpread();
    if (state.fitMode === "manual") layoutSpread();
    else applyFit();
  }
  if (key === "colorMode" || key === "colorSensitivity") sampleSpreadColor();
  if (
    key === "guidedView" ||
    key === "guidedFill" ||
    key === "guidedPanMs" ||
    key === "guidedEasing" ||
    key === "guidedSpotlight"
  ) {
    state.guidedCamera = false;
    if (!ensureGuidedCamera()) applyFit();
    positionSpotlight();
    updateStatus();
  }
  if (key === "verticalScroll" || key === "panelStrip") {
    state.verticalZoom = 1;
    state.stripPanels.clear();
    state.stripVersion += 1;
    stripQueue = [];
    stripPending.clear();
    rebuildSpreads();
    renderSpread();
    applyFit();
    syncToolbar();
    persistBookSettings();
  }
};

const wirePreferences = () => {
  prefColorMode.addEventListener("change", () => void writePreference("colorMode", prefColorMode.value));
  prefResampling.addEventListener("change", () => void writePreference("resampling", prefResampling.value));
  prefPrefetch.addEventListener("change", () =>
    void writePreference("prefetchPages", Number(prefPrefetch.value)),
  );
  prefToolbarFullscreen.addEventListener("change", () =>
    void writePreference("toolbarInFullscreen", prefToolbarFullscreen.checked),
  );
  prefGuided.addEventListener("change", () => void writePreference("guidedView", prefGuided.checked));
  prefGuidedFill.addEventListener("input", () => {
    document.getElementById("pref-guided-fill-value").textContent = Number(prefGuidedFill.value).toFixed(2);
  });
  prefGuidedFill.addEventListener("change", () =>
    void writePreference("guidedFill", Number(prefGuidedFill.value)),
  );
  prefGuidedPan.addEventListener("change", () =>
    void writePreference("guidedPanMs", Number(prefGuidedPan.value)),
  );
  prefGuidedEasing.addEventListener("change", () =>
    void writePreference("guidedEasing", prefGuidedEasing.value),
  );
  prefGuidedSpotlight.addEventListener("change", () =>
    void writePreference("guidedSpotlight", prefGuidedSpotlight.checked),
  );
  for (const [element, key] of [
    [prefSensitivity, "colorSensitivity"],
    [prefGamma, "gamma"],
    [prefVibrance, "vibrance"],
    [prefBrightness, "brightness"],
    [prefContrast, "contrast"],
    [prefGrayscale, "grayscale"],
    [prefSepia, "sepia"],
  ]) {
    element.addEventListener("input", () => showPreferenceValues());
    element.addEventListener("change", () => void writePreference(key, Number(element.value)));
  }
  prefSharpen.addEventListener("change", () => void writePreference("sharpen", prefSharpen.checked));
  prefVertical.addEventListener("change", () => void writePreference("verticalScroll", prefVertical.checked));
  prefPanelStrip.addEventListener("change", () =>
    void writePreference("panelStrip", prefPanelStrip.checked),
  );
  prefRemember.addEventListener("change", () =>
    void writePreference("rememberPerBook", prefRemember.checked),
  );
  document.getElementById("pref-clear-cache").addEventListener("click", () => {
    void api.clearCache().then((result) => {
      const cleared = result?.cleared ?? 0;
      toast(cleared === 0 ? "The saved index was already empty" : `Forgot ${cleared} indexed pages`);
    });
  });
  prefCrash.addEventListener("change", () => void writePreference("crashReporting", prefCrash.checked));
  prefCrashDsn.addEventListener("change", () =>
    void writePreference("crashReportingDsn", prefCrashDsn.value.trim()),
  );
  document.getElementById("pref-crash-test").addEventListener("click", () => {
    void sendTestCrashReport();
  });
  document.getElementById("pref-close").addEventListener("click", () => preferencesDialog.close());
  document.getElementById("shortcut-reset").addEventListener("click", async () => {
    const shortcuts = await api.resetShortcuts();
    if (shortcuts !== null && typeof shortcuts === "object") state.shortcuts = shortcuts;
    renderShortcutList();
    toast("Shortcuts reset to defaults");
  });
  document.getElementById("pref-reset").addEventListener("click", async () => {
    for (const [key, value] of Object.entries(DEFAULT_PREFERENCES)) {
      await writePreference(key, value);
    }
    state.colorGainsByPage.clear();
    state.prefetched.clear();
    if (state.book !== null) {
      renderSpread();
      applyFit();
      prefetchAround();
    }
    toast("Reading quality reset to defaults");
  });
};

/* Magnifier ---------------------------------------------------------------- */

const hideMagnifier = () => {
  if (!magnifierEl.hidden) magnifierEl.hidden = true;
};

/**
 * Draw the region under the pointer into a lens.
 *
 * The source region is taken in bitmap space: the pointer offset is rotated
 * back out of the display rotation, and the lens itself is rotated so the
 * magnified content reads the same way as the page.
 */
const updateMagnifier = (pointer) => {
  if (state.preferences.magnifierVisible !== true || state.book === null) {
    hideMagnifier();
    return;
  }
  const size = state.preferences.magnifierSize ?? 180;
  const factor = state.preferences.magnifierFactor ?? 3;
  const chosen = state.nodes.find((node) => {
    const rect = node.element.getBoundingClientRect();
    return (
      pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom
    );
  });
  if (chosen === undefined) {
    hideMagnifier();
    return;
  }

  const rect = chosen.element.getBoundingClientRect();
  const natural = pageSize(chosen.page);
  const sample = magnifierSample({
    pointer,
    rect,
    natural,
    rotation: state.rotation,
    size,
    factor,
  });
  if (sample === null) {
    hideMagnifier();
    return;
  }

  magnifierEl.width = size;
  magnifierEl.height = size;
  magnifierContext.clearRect(0, 0, size, size);
  try {
    magnifierContext.drawImage(
      chosen.source ?? chosen.element,
      sample.sourceX,
      sample.sourceY,
      sample.region,
      sample.region,
      0,
      0,
      size,
      size,
    );
  } catch {
    hideMagnifier();
    return;
  }

  const { left, top } = lensPosition({ pointer, stageRect: stage.getBoundingClientRect(), size });
  magnifierEl.style.left = `${left}px`;
  magnifierEl.style.top = `${top}px`;
  magnifierEl.style.transform = `rotate(${state.rotation}deg)`;
  magnifierEl.hidden = false;
};

/** Show the lens at the middle of the reading area, until the pointer moves. */
const showMagnifierAtCentre = () => {
  const stageRect = stage.getBoundingClientRect();
  updateMagnifier({
    x: stageRect.left + stageRect.width / 2,
    y: stageRect.top + stageRect.height / 2,
  });
};

/* Slideshow ---------------------------------------------------------------- */

let slideshowTimer = null;

const stopSlideshow = () => {
  if (slideshowTimer === null) return;
  clearInterval(slideshowTimer);
  slideshowTimer = null;
  state.slideshowRunning = false;
};

const toggleSlideshow = () => {
  if (state.slideshowRunning) {
    stopSlideshow();
    toast("Slideshow stopped");
    return;
  }
  if (state.book === null) return;
  const seconds = state.preferences.slideshowSeconds ?? 5;
  stopSlideshow();
  state.slideshowRunning = true;
  slideshowTimer = setInterval(() => {
    if (state.book === null || state.spreadIndex >= state.spreads.length - 1) {
      stopSlideshow();
      toast("Reached the end of the book");
      return;
    }
    nextSpread();
  }, seconds * 1000);
  toast(`Slideshow: a page every ${seconds}s`);
};

/* Shortcuts dialog --------------------------------------------------------- */

const renderShortcutList = () => {
  shortcutList.replaceChildren();
  for (const command of REBINDABLE_COMMANDS) {
    const binding = state.shortcuts[command];
    const item = document.createElement("li");
    item.className = "shortcut-row";
    const label = document.createElement("span");
    label.className = "shortcut-label";
    label.textContent = COMMAND_LABELS[command];
    item.append(label);
    for (const slot of ["primary", "secondary"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "shortcut-key";
      const capturing = state.capturing?.command === command && state.capturing?.slot === slot;
      if (capturing) button.classList.add("capturing");
      button.textContent = capturing ? "Press a key…" : (binding[slot] ?? "unbound");
      button.addEventListener("click", () => {
        state.capturing = { command, slot };
        renderShortcutList();
      });
      item.append(button);
    }
    shortcutList.append(item);
  }
};

/* Guided view -------------------------------------------------------------- */

const spotlightEl = document.getElementById("spotlight");
const PANEL_SAMPLE_MAX = 800;
const panelSampleCanvas = document.createElement("canvas");
const panelSampleContext = panelSampleCanvas.getContext("2d", { willReadFrequently: true });

const guidedActive = () => state.preferences.guidedView === true && state.book !== null;

/** Page that guided view is framing: the leading page of the spread. */
const guidedPageIndex = () => {
  const spread = currentSpread();
  return spread === null ? null : spread.indices[0];
};

const currentPanels = () => {
  const index = guidedPageIndex();
  if (index === null) return null;
  const panels = state.guidedPanels.get(index);
  return panels === undefined ? null : panels;
};

/**
 * The panels guided view will step through, or null when the page is shown whole.
 *
 * One place decides this so the camera, the spotlight and the status line cannot
 * disagree about which panel is being read.
 */
const guidedPanelList = () => {
  const panels = currentPanels();
  const node = state.nodes[0];
  if (panels === null || node === undefined) return null;
  return panelsAreUsable(panels, pageSize(node.page)) ? panels : null;
};

/** Sample a page element and detect its panels, in the page's own coordinates. */
const detectPanelsInElement = (element, base, options = {}) => {
  const scale = Math.min(PANEL_SAMPLE_MAX / base.width, PANEL_SAMPLE_MAX / base.height, 1);
  const width = Math.max(1, Math.round(base.width * scale));
  const height = Math.max(1, Math.round(base.height * scale));
  panelSampleCanvas.width = width;
  panelSampleCanvas.height = height;
  panelSampleContext.clearRect(0, 0, width, height);
  panelSampleContext.drawImage(element, 0, 0, width, height);
  const image = panelSampleContext.getImageData(0, 0, width, height);
  const detected = detectPanels(image, {
    rightToLeft: state.rightToLeft === true,
    gutter: Math.max(1, Math.round(PAGE_GUTTER_PX * scale)),
    minSize: Math.max(12, Math.round(Math.min(base.width, base.height) * PAGE_MIN_PANEL_PX * scale)),
    ...options,
  });
  // A panel with no variation in it is a band of background. Framing one shows the
  // reader nothing, which is the commonest way guided view lands on a blank screen.
  const panels = keepPanelsWithArtwork(image, detected);
  return panels.map((panel) => ({
    x: panel.x / scale,
    y: panel.y / scale,
    width: panel.width / scale,
    height: panel.height / scale,
  }));
};

/**
 * Detect the panels of the page on screen.
 *
 * The page is sampled at a reduced size, because the detector's cost is
 * proportional to pixel count and gutters survive downscaling. The parameters
 * are expressed in *page* pixels and converted, since a gutter that is 8px on
 * the page is under 2px in a quarter-scale sample and would otherwise be
 * dismissed as noise.
 */
const PAGE_GUTTER_PX = 5;
const PAGE_MIN_PANEL_PX = 0.09;
const detectPagePanels = (node) => detectPanelsInElement(node.element, pageSize(node.page));

const nodeReadyForCapture = (node) =>
  node.kind === "image" ? node.element.complete && node.element.naturalWidth > 0 : node.renderedScale > 0;

/** Detect once per page, then frame the current panel. */
const ensureGuidedCamera = (options = {}) => {
  if (!guidedActive()) {
    state.guidedCamera = false;
    spotlightEl.hidden = true;
    return false;
  }
  const node = state.nodes[0];
  const index = guidedPageIndex();
  if (node === undefined || index === null) return false;

  if (!state.guidedPanels.has(index)) {
    if (!nodeReadyForCapture(node)) return false;
    try {
      state.guidedPanels.set(index, detectPagePanels(node));
    } catch {
      // A page that cannot be sampled is read whole rather than failing.
      state.guidedPanels.set(index, [{ x: 0, y: 0, width: pageSize(node.page).width, height: pageSize(node.page).height }]);
    }
  }
  const panels = state.guidedPanels.get(index);
  if (!panelsAreUsable(panels, pageSize(node.page))) {
    // A splash page, a single-panel page, or a page the detector could not read
    // convincingly is shown whole, which is what the normal fit does.
    state.guidedCamera = false;
    spotlightEl.hidden = true;
    updateStatus();
    // The panels are known now, so a step that was waiting can be answered: this
    // page has nothing to step through, so the reader goes where they asked.
    dischargePendingSteps();
    return false;
  }

  state.guidedStep = Math.min(Math.max(state.guidedStep, 0), panels.length - 1);
  const camera = framePanel({
    panel: panels[state.guidedStep],
    page: pageSize(node.page),
    viewport: viewportSize(),
    rotation: state.rotation,
    fill: state.preferences.guidedFill ?? 0.92,
  });
  state.scale = camera.scale;
  state.offset = camera.offset;
  state.guidedCamera = true;
  layoutSpread({ animate: options.animate === true });
  // The panels are known now, so a step that was waiting can be taken.
  dischargePendingSteps();
  return true;
};

/** Move the spotlight over the focused panel, in viewport coordinates. */
const positionSpotlight = () => {
  const node = state.nodes[0];
  // Must be the same list the camera frames, or with a rejected panel the
  // spotlight would sit somewhere other than the panel being shown.
  const panels = guidedPanelList();
  if (!state.guidedCamera || node === undefined || panels === null || state.preferences.guidedSpotlight !== true) {
    spotlightEl.hidden = true;
    return;
  }
  const panel = panels[state.guidedStep];
  const quarterTurned = state.rotation % 180 === 90;
  const width = (quarterTurned ? panel.height : panel.width) * state.scale;
  const height = (quarterTurned ? panel.width : panel.height) * state.scale;
  const viewport = viewportSize();
  spotlightEl.style.width = `${width}px`;
  spotlightEl.style.height = `${height}px`;
  spotlightEl.style.left = `${(viewport.width - width) / 2}px`;
  spotlightEl.style.top = `${(viewport.height - height) / 2}px`;
  spotlightEl.hidden = false;
};

/**
 * Steps requested before the page's panels were known, as a signed count.
 *
 * A page's panels cannot be read until its image has decoded, and a key pressed in
 * that window used to fall through to a page turn — so pressing forward on a large
 * page skipped the panels entirely, which is what "guided view misses pages" looked
 * like. Presses are counted rather than collapsed, because pressing twice and moving
 * once is its own kind of wrong.
 */
let pendingSteps = 0;

/**
 * Step within the page's panels.
 *
 * @returns {"stepped"|"waiting"|"no-panels"} `waiting` means the page is still
 *   loading and the request has been queued; `no-panels` means the page has
 *   nothing to step through, so the caller should turn the page.
 */
const stepPanel = (direction) => {
  if (!guidedActive()) return "no-panels";
  // Detection is synchronous once the page is on screen, so try now.
  if (currentPanels() === null) ensureGuidedCamera();

  const panels = guidedPanelList();
  // Still nothing detected at all: the page is still loading, so queue the press
  // rather than turning the page and skipping panels the reader asked for.
  if (panels === null && currentPanels() === null) {
    pendingSteps += direction;
    return "waiting";
  }
  if (panels === null) return "no-panels";

  const next = state.guidedStep + direction;
  if (next < 0 || next >= panels.length) return "no-panels";
  state.guidedStep = next;
  state.guidedCamera = false;
  ensureGuidedCamera({ animate: true });
  updateStatus();
  return "stepped";
};

/**
 * Answer the steps that were queued while the page was loading.
 *
 * Each queued press either steps a panel or, once the page is exhausted, turns a
 * page. Presses left over after a turn are carried to the next page rather than
 * dropped, so pressing forward three times moves forward three times.
 */
const dischargePendingSteps = () => {
  if (pendingSteps === 0) return;
  const moves = pendingSteps;
  pendingSteps = 0;
  const direction = moves > 0 ? 1 : -1;
  for (let taken = 0; taken < Math.abs(moves); taken += 1) {
    if (stepPanel(direction) !== "no-panels") continue;
    const remaining = Math.abs(moves) - taken - 1;
    goToSpread(state.spreadIndex + direction);
    // Set after the move: going to a spread clears the queue, and the remainder
    // belongs to the page we just arrived on.
    pendingSteps = direction * remaining;
    return;
  }
};

/* Navigation --------------------------------------------------------------- */

const goToSpread = (index) => {
  if (state.book === null || state.spreads.length === 0) return;
  // Moving off the resumed page makes the banner stale.
  hideResumeBanner();
  // A step waiting for the previous page must not fire against this one.
  pendingSteps = 0;
  const clamped = Math.min(Math.max(index, 0), state.spreads.length - 1);
  state.spreadIndex = clamped;
  // A new page starts at its first panel.
  state.guidedStep = 0;
  state.guidedCamera = false;
  if (verticalActive()) {
    scrollToVerticalPage(clamped);
    renderVerticalPdfWindow(clamped);
    updateStatus();
    updateThumbnailHighlight();
    reportProgress();
    return;
  }
  renderSpread();
  if (state.fitMode === "manual") layoutSpread();
  else applyFit();
  ensureGuidedCamera();
  updateThumbnailHighlight();
  prefetchAround();
  reportProgress();
};

const nextSpread = () => {
  if (stepPanel(1) !== "no-panels") return;
  goToSpread(state.spreadIndex + 1);
};
const previousSpread = () => {
  if (stepPanel(-1) !== "no-panels") return;
  goToSpread(state.spreadIndex - 1);
};

const goToPage = (pageNumber) => {
  if (state.book === null) return;
  const index = Math.min(Math.max(Math.floor(pageNumber) - 1, 0), state.book.pages.length - 1);
  goToSpread(spreadIndexForPage(state.spreads, index));
};

/* Zoom and fit ------------------------------------------------------------- */

const setScale = (nextScale, pointer = { x: 0, y: 0 }) => {
  const clamped = clampScale(nextScale);
  if (Math.abs(clamped - state.scale) < 1e-6) return;
  // Zooming by hand takes over from the panel camera until the next step.
  state.guidedCamera = false;
  spotlightEl.hidden = true;
  state.offset = zoomAtPoint(state.scale, state.offset, clamped, pointer);
  state.scale = clamped;
  state.fitMode = "manual";
  layoutSpread();
  syncToolbar();
};

const zoomIn = () => {
  if (verticalActive()) {
    state.verticalZoom = Math.min(4, state.verticalZoom * 1.25);
    renderVertical();
    updateStatus();
    return;
  }
  setScale(zoomStep(state.scale, 1));
};
const zoomOut = () => {
  if (verticalActive()) {
    state.verticalZoom = Math.max(0.25, state.verticalZoom / 1.25);
    renderVertical();
    updateStatus();
    return;
  }
  setScale(zoomStep(state.scale, -1));
};

const setFitMode = (mode) => {
  state.fitMode = mode;
  applyFit();
  syncToolbar();
  persistBookSettings();
};

const actualSize = () => {
  state.scale = 1;
  state.fitMode = "manual";
  state.offset = { x: 0, y: 0 };
  layoutSpread();
  syncToolbar();
  persistBookSettings();
};

const rotate = (degrees) => {
  state.rotation = (((state.rotation + degrees) % 360) + 360) % 360;
  if (state.fitMode === "manual") layoutSpread();
  else applyFit();
  persistBookSettings();
};

const toggleDoublePage = () => {
  const anchor = currentSpread()?.indices[0] ?? 0;
  state.doublePage = !state.doublePage;
  rebuildSpreads();
  state.spreadIndex = Math.max(0, spreadIndexForPage(state.spreads, anchor));
  renderSpread();
  if (state.fitMode === "manual") layoutSpread();
  else applyFit();
  syncToolbar();
  persistBookSettings();
};

const toggleRightToLeft = () => {
  state.rightToLeft = !state.rightToLeft;
  renderSpread();
  syncToolbar();
  persistBookSettings();
};

/* Vertical scrolling ------------------------------------------------------- */

const scrollEl = document.getElementById("scroll");
/** Pages kept rendered either side of the reader when scrolling a PDF. */
const VERTICAL_PDF_WINDOW = 2;

const verticalActive = () => state.preferences.verticalScroll === true && state.book !== null;

/** Column width for the current zoom: fit the widest page to the stage. */
const verticalColumnWidth = () => {
  if (state.book === null) return 0;
  const viewport = viewportSize();
  const widest = state.book.pages.reduce((max, page) => Math.max(max, pageSize(page).width), 1);
  return Math.max(80, Math.round(widest * ((viewport.width - 32) / widest) * state.verticalZoom));
};

const clearVertical = () => {
  if (state.stripObserver !== null) {
    state.stripObserver.disconnect();
    state.stripObserver = null;
  }
  scrollEl.replaceChildren();
  scrollEl.dataset.signature = "";
  state.verticalRendered.clear();
};

const stripActive = () =>
  verticalActive() && state.preferences.panelStrip !== false && state.pdf === null;

/** Rows for one page: one per panel when the strip can be trusted, else one row. */
const appendRowsForPage = (index, columnWidth) => {
  const page = state.book.pages[index];
  const base = pageSize(page);
  const panelRows = stripActive()
    ? panelStripRows({ panels: state.stripPanels.get(index), page: base, columnWidth })
    : null;

  if (panelRows === null) {
    const holder = document.createElement("div");
    holder.className = "strip-row";
    holder.dataset.index = String(index);
    const height = Math.max(1, Math.round((base.height * columnWidth) / Math.max(1, base.width)));
    holder.style.width = `${columnWidth}px`;
    holder.style.height = `${height}px`;
    if (page.kind === "pdf") {
      const canvas = document.createElement("canvas");
      canvas.className = "page-canvas";
      holder.append(canvas);
    } else {
      // Nothing is fetched until a row approaches the viewport: a long comic
      // must not decode every page up front.
      holder.dataset.src = page.url;
      holder.style.backgroundSize = `${columnWidth}px ${height}px`;
      holder.style.backgroundPosition = "0 0";
      state.stripObserver?.observe(holder);
    }
    scrollEl.append(holder);
    return;
  }

  for (const [panelIndex, row] of panelRows.entries()) {
    const holder = document.createElement("div");
    holder.className = "strip-row";
    holder.dataset.index = String(index);
    holder.dataset.panel = String(panelIndex);
    holder.style.width = `${row.width}px`;
    holder.style.height = `${row.height}px`;
    holder.dataset.src = page.url;
    holder.style.backgroundSize = `${row.backgroundWidth}px ${row.backgroundHeight}px`;
    holder.style.backgroundPosition = `${row.offsetX}px ${row.offsetY}px`;
    state.stripObserver?.observe(holder);
    scrollEl.append(holder);
  }
};

const buildVerticalRows = (columnWidth) => {
  scrollEl.replaceChildren();
  state.verticalRendered.clear();
  state.stripObserver?.disconnect();
  state.stripObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const holder = entry.target;
        if (holder.dataset.src !== undefined && holder.style.backgroundImage === "") {
          holder.style.backgroundImage = `url("${holder.dataset.src}")`;
        }
        state.stripObserver?.unobserve(holder);
      }
    },
    { root: scrollEl, rootMargin: "150% 0px" },
  );

  for (let index = 0; index < state.book.pages.length; index += 1) {
    appendRowsForPage(index, columnWidth);
  }
};

/** Total height of the rows belonging to one page. */
const pageBlockHeight = (index) => {
  let top = null;
  let bottom = 0;
  for (const holder of scrollEl.children) {
    if (Number(holder.dataset.index) !== index) continue;
    if (top === null) top = holder.offsetTop;
    bottom = holder.offsetTop + holder.offsetHeight;
  }
  return top === null ? 0 : bottom - top;
};

const rowTopForPage = (index) => {
  for (const holder of scrollEl.children) {
    if (Number(holder.dataset.index) >= index) return holder.offsetTop;
  }
  return 0;
};

/**
 * Rebuild the column after panels arrive.
 *
 * Detection completes while the reader is looking at the column, so the position
 * within the current page is preserved as a fraction of that page's height:
 * rebuilding must not yank the reading position.
 */
const rebuildStripPreservingPosition = () => {
  const anchor = state.spreadIndex;
  const topBefore = rowTopForPage(anchor);
  const heightBefore = pageBlockHeight(anchor);
  const within = scrollEl.scrollTop - topBefore;
  renderVertical();
  const topAfter = rowTopForPage(anchor);
  const heightAfter = pageBlockHeight(anchor);
  if (heightBefore > 0 && heightAfter > 0 && within > 0) {
    scrollEl.scrollTop = Math.max(0, topAfter + (within / heightBefore) * heightAfter);
  }
};

/** Detect panels for a page from its URL, without needing it on screen. */
const detectPanelsForUrl = (page) =>
  new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => {
      try {
        resolve(detectPanelsInElement(image, pageSize(page)));
      } catch {
        // A page that cannot be sampled is shown whole rather than failing.
        state.stripSampleFailures += 1;
        resolve(null);
      }
    });
    image.addEventListener("error", () => {
      state.stripSampleFailures += 1;
      resolve(null);
    });
    image.src = page.url;
  });

let stripQueue = [];
const stripPending = new Set();
let stripInFlight = 0;

/**
 * Work through the pages near the reader, a couple at a time, so the column
 * gains panels as it is read rather than blocking on the whole book.
 */
const pumpStripQueue = () => {
  while (stripInFlight < 2 && stripQueue.length > 0) {
    const index = stripQueue.shift();
    stripInFlight += 1;
    void detectPanelsForUrl(state.book.pages[index])
      .then((panels) => {
        const usable = Array.isArray(panels) && panelsFormStrip(panels, pageSize(state.book.pages[index]));
        state.stripPanels.set(index, usable ? panels : null);
      })
      .catch(() => state.stripPanels.set(index, null))
      .finally(() => {
        stripInFlight -= 1;
        stripPending.delete(index);
        // The column's shape changed, so the next render must rebuild it.
        state.stripVersion += 1;
        if (verticalActive()) rebuildStripPreservingPosition();
        if (stripQueue.length > 0) pumpStripQueue();
      });
  }
};

const scheduleStripDetection = () => {
  if (!stripActive()) return;
  const last = state.book.pages.length - 1;
  for (const index of [state.spreadIndex, state.spreadIndex + 1, state.spreadIndex + 2]) {
    if (index < 0 || index > last) continue;
    // Only PDF pages carry a `kind`; an image book's pages do not.
    if (state.book.pages[index].kind === "pdf") continue;
    if (state.stripPanels.has(index) || stripPending.has(index)) continue;
    stripPending.add(index);
    stripQueue.push(index);
  }
  pumpStripQueue();
};

/** Render the PDF pages around the reader, and clear the rest. */
const renderVerticalPdfWindow = (current) => {
  if (state.pdf === null) return;
  const first = Math.max(0, current - VERTICAL_PDF_WINDOW);
  const last = Math.min(state.book.pages.length - 1, current + VERTICAL_PDF_WINDOW);
  for (const holder of scrollEl.children) {
    const index = Number(holder.dataset.index);
    const canvas = holder.firstElementChild;
    if (canvas === null || canvas.tagName !== "CANVAS") continue;
    if (index < first || index > last) {
      if (state.verticalRendered.has(index)) {
        canvas.width = 0;
        canvas.height = 0;
        state.verticalRendered.delete(index);
      }
      continue;
    }
    if (state.verticalRendered.get(index) === canvas.width) continue;
    const page = state.book.pages[index];
    void startPdfRender(state.pdf, page.index ?? index, canvas, verticalColumnWidth() / pageSize(page).width);
    state.verticalRendered.set(index, canvas.width);
  }
};

const renderVertical = () => {
  if (!verticalActive()) {
    scrollEl.hidden = true;
    clearVertical();
    return;
  }
  scrollEl.hidden = false;
  const columnWidth = verticalColumnWidth();
  // Rebuilding preserves nothing on its own, so it only happens when the shape
  // of the column actually changed.
  const signature = `${columnWidth}:${state.stripVersion}:${state.book.pages.length}`;
  if (scrollEl.dataset.signature !== signature) {
    buildVerticalRows(columnWidth);
    scrollEl.dataset.signature = signature;
    // A rebuilt column starts at the top, which would leave the scroll position
    // and the page the reader is on disagreeing — switching mode mid-book would
    // silently jump back to page one.
    scrollToVerticalPage(state.spreadIndex);
  }
  for (const holder of scrollEl.children) {
    const page = state.book.pages[Number(holder.dataset.index)];
    const base = pageSize(page);
    if (holder.dataset.panel === undefined) {
      const height = Math.max(1, Math.round((base.height * columnWidth) / Math.max(1, base.width)));
      holder.style.width = `${columnWidth}px`;
      holder.style.height = `${height}px`;
      const element = holder.firstElementChild;
      if (element !== null && element.tagName === "CANVAS") {
        element.style.width = `${columnWidth}px`;
        element.style.height = `${height}px`;
      }
    }
  }
  scheduleStripDetection();
  if (state.pdf !== null) renderVerticalPdfWindow(state.spreadIndex);
};

/** Which page sits in the middle of the viewport. */
const verticalPageAtCentre = () => {
  const middle = scrollEl.scrollTop + scrollEl.clientHeight / 2;
  let index = 0;
  for (const holder of scrollEl.children) {
    if (holder.offsetTop <= middle) index = Number(holder.dataset.index);
    else break;
  }
  return index;
};

const scrollToVerticalPage = (index) => {
  for (const holder of scrollEl.children) {
    if (Number(holder.dataset.index) >= index) {
      scrollEl.scrollTop = holder.offsetTop;
      return;
    }
  }
};

/* Resume ------------------------------------------------------------------- */

const resumeBanner = document.getElementById("resume-banner");
const resumeText = document.getElementById("resume-text");
let resumeTimer = null;

/**
 * Say where reading resumed, and offer to start over.
 *
 * A toast disappears before a reader who was not expecting it has read it, and it
 * cannot be acted on; resuming is the one moment where the position is a surprise
 * and the reader may want the beginning instead.
 */
const showResumeBanner = (page, total) => {
  resumeText.textContent = `Resumed at page ${page} of ${total}`;
  resumeBanner.hidden = false;
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    resumeBanner.hidden = true;
  }, 12000);
};

const hideResumeBanner = () => {
  clearTimeout(resumeTimer);
  resumeBanner.hidden = true;
};

const wireResumeBanner = () => {
  document.getElementById("resume-start").addEventListener("click", () => {
    hideResumeBanner();
    goToPage(1);
  });
  document.getElementById("resume-dismiss").addEventListener("click", hideResumeBanner);
};

/* Crash reporting ---------------------------------------------------------- */

let lastCrashReportResult = null;

/**
 * Send the test report and say what actually happened.
 *
 * "Reporting is on" is not the same as "reports arrive", and only the reader can
 * check the destination they configured — so this tells them the answer rather
 * than leaving them to assume it works.
 */
const sendTestCrashReport = async () => {
  try {
    const result = await api.testCrashReport();
    lastCrashReportResult = result;
    if (result?.ok) toast(`Test report accepted (${result.status})`);
    else toast(`Test report failed: ${result?.error ?? "no answer"}`);
    return result;
  } catch (error) {
    lastCrashReportResult = { ok: false, error: String(error) };
    return lastCrashReportResult;
  }
};

/* Achievements ------------------------------------------------------------- */

const achievementsDialog = document.getElementById("achievements-dialog");
const achievementList = document.getElementById("achievement-list");

const renderAchievementList = (summary) => {
  achievementList.replaceChildren();
  const earned = summary.entries.filter((entry) => entry.unlockedAt !== null).length;
  document.getElementById("achievements-summary").textContent =
    `${earned} of ${summary.entries.length} earned · ${summary.measures.pagesTurned} pages turned · ` +
    `${summary.measures.booksFinished} finished · ${summary.measures.currentStreak} day streak`;
  for (const entry of summary.entries) {
    const item = document.createElement("li");
    item.className = entry.unlockedAt === null ? "achievement locked" : "achievement earned";
    const title = document.createElement("strong");
    title.textContent = entry.unlockedAt === null ? entry.title : `★ ${entry.title}`;
    const description = document.createElement("span");
    description.className = "meta";
    // Progress rather than a bare locked state: "40 of 100 pages" is a goal.
    description.textContent =
      entry.unlockedAt === null
        ? ` — ${entry.description} (${entry.progress} of ${entry.goal})`
        : ` — ${entry.description}`;
    item.append(title, description);
    achievementList.append(item);
  }
};

const openAchievementsDialog = async () => {
  try {
    renderAchievementList(await api.getAchievements());
  } catch {
    toast("Achievements could not be read");
    return;
  }
  achievementsDialog.showModal();
};

const announceAchievement = (achievement) => {
  if (achievement === null || achievement === undefined) return;
  toast(`Achievement unlocked — ${achievement.title}`);
};

/* Chrome ------------------------------------------------------------------- */

const openingEl = document.getElementById("opening");
const openingText = document.getElementById("opening-text");
const openingBar = document.getElementById("opening-bar");

/** Show how far an open has got, or that one is starting. */
const showOpening = (progress = null) => {
  if (progress === null) {
    openingText.textContent = "Opening…";
    openingBar.removeAttribute("value");
    openingBar.textContent = "";
  } else {
    const determinate = progress.total > 0;
    openingText.textContent = determinate
      ? `${progress.phase} — ${progress.done} / ${progress.total}`
      : `${progress.phase}…`;
    if (determinate) openingBar.value = Math.round((progress.done / progress.total) * 100);
    else openingBar.removeAttribute("value");
  }
  openingEl.hidden = false;
};

const hideOpening = () => {
  openingEl.hidden = true;
};

let toastTimer = null;
const toast = (message) => {
  toastEl.textContent = message;
  toastEl.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 4500);
};

const syncToolbar = () => {
  for (const button of document.querySelectorAll("#toolbar button[data-command]")) {
    const pressed =
      (button.dataset.command === "toggle-double" && state.doublePage) ||
      (button.dataset.command === "toggle-rtl" && state.rightToLeft) ||
      (button.dataset.command === "toggle-thumbnails" && state.thumbnailsVisible) ||
      (button.dataset.command === "toggle-guided" && guidedActive()) ||
      (button.dataset.command === "toggle-vertical" && verticalActive()) ||
      (button.dataset.command === "fit-screen" && state.fitMode === "screen");
    button.setAttribute("aria-pressed", String(Boolean(pressed)));
  }
};

const openViaDialog = async (folder) => {
  const result = folder ? await api.openFolderDialog() : await api.openFileDialog();
  if (result.canceled) return;
  if (result.error) {
    toast(result.error.message);
    return;
  }
  showOpening();
  applyBook(result.book);
};

const openGotoDialog = () => {
  if (state.book === null) return;
  gotoInput.value = String((currentSpread()?.indices[0] ?? 0) + 1);
  gotoDialog.showModal();
  gotoInput.select();
};

/**
 * Chrome for the current window state.
 *
 * In full screen the toolbar is hidden for immersion, but that must never be the
 * only way out: Escape and F11 both leave full screen, and entering it says so.
 */
const applyChrome = () => {
  document.body.classList.toggle("fullscreen", state.fullscreen);
  document.body.classList.toggle(
    "hide-toolbar",
    state.fullscreen && state.preferences.toolbarInFullscreen !== true,
  );
};

/**
 * `undefined` toggles; a value requests that exact state. The value is sent
 * unconditionally rather than compared against a read-back, because the window's
 * reported state lags the request on Windows.
 */
const setFullScreen = async (value) => {
  if (value === undefined) await api.toggleFullscreen();
  else await api.setFullScreen(value);
};

const runCommand = async (command) => {
  switch (command) {
    case "open-file":
      void openViaDialog(false);
      return;
    case "open-folder":
      void openViaDialog(true);
      return;
    case "close-book":
      void api.closeBook().then(() => {
        state.book = null;
        state.spreads = [];
        state.nodes = [];
        spreadEl.replaceChildren();
        emptyState.hidden = false;
        updateStatus();
      });
      return;
    case "first-page":
      goToPage(1);
      return;
    case "last-page":
      goToPage(state.book?.pages.length ?? 1);
      return;
    case "next-page":
      nextSpread();
      return;
    case "previous-page":
      previousSpread();
      return;
    case "go-to-page":
      openGotoDialog();
      return;
    case "zoom-in":
      zoomIn();
      return;
    case "zoom-out":
      zoomOut();
      return;
    case "zoom-reset":
      actualSize();
      return;
    case "fit-screen":
      setFitMode("screen");
      return;
    case "fit-width":
      setFitMode("width");
      return;
    case "fit-height":
      setFitMode("height");
      return;
    case "rotate-cw":
      rotate(90);
      return;
    case "rotate-ccw":
      rotate(-90);
      return;
    case "toggle-double":
    case "double-on":
    case "double-off":
      if (command === "double-on" ? !state.doublePage : command === "double-off" ? state.doublePage : true) {
        toggleDoublePage();
      }
      return;
    case "toggle-rtl":
    case "rtl-on":
    case "rtl-off":
      if (command === "rtl-on" ? !state.rightToLeft : command === "rtl-off" ? state.rightToLeft : true) {
        toggleRightToLeft();
      }
      return;
    case "toggle-fullscreen":
      void setFullScreen();
      return;    case "fullscreen-on":
      void setFullScreen(true);
      return;
    case "fullscreen-off":
      void setFullScreen(false);
      return;
    case "show-help":
      renderShortcutList();
      helpDialog.showModal();
      return;
    case "toggle-magnifier":
      await writePreference("magnifierVisible", !state.preferences.magnifierVisible);
      if (state.preferences.magnifierVisible === true) showMagnifierAtCentre();
      else hideMagnifier();
      return;
    case "toggle-vertical": {
      const next = state.preferences.verticalScroll !== true;
      let preferences = await api.setPreference("verticalScroll", next);
      if (preferences !== null && typeof preferences === "object") state.preferences = preferences;
      // Scrolling a column and stepping through panels are two ways to read the
      // same page, so turning one on turns the other off.
      if (next && state.preferences.guidedView === true) {
        preferences = await api.setPreference("guidedView", false);
        if (preferences !== null && typeof preferences === "object") state.preferences = preferences;
        state.guidedCamera = false;
        spotlightEl.hidden = true;
      }
      state.verticalZoom = 1;
      rebuildSpreads();
      renderSpread();
      applyFit();
      syncToolbar();
      persistBookSettings();
      toast(next ? "Vertical scroll" : "Page by page");
      return;
    }
    case "toggle-guided": {
      const preferences = await api.setPreference("guidedView", !state.preferences.guidedView);
      if (preferences !== null && typeof preferences === "object") state.preferences = preferences;
      // The column and the panel camera are mutually exclusive.
      if (state.preferences.guidedView === true && state.preferences.verticalScroll === true) {
        const updated = await api.setPreference("verticalScroll", false);
        if (updated !== null && typeof updated === "object") state.preferences = updated;
        clearVertical();
      }
      state.guidedPanels.clear();
      state.guidedStep = 0;
      state.guidedCamera = false;
      rebuildSpreads();
      renderSpread();
      applyFit();
      syncToolbar();
      if (state.preferences.guidedView !== true) {
        spotlightEl.hidden = true;
        toast("Guided view off");
      } else if (ensureGuidedCamera()) {
        toast("Guided view — page keys step through panels");
      } else if (state.nodes[0] !== undefined && nodeReadyForCapture(state.nodes[0])) {
        toast("Guided view on; this page has a single panel");
      } else {
        // The page is still loading; the camera applies when it arrives.
        toast("Guided view on");
      }
      persistBookSettings();
      return;
    }
    case "send-test-report":
      lastCrashReportResult = await sendTestCrashReport();
      return;
    case "toggle-slideshow":
      toggleSlideshow();
      return;
    case "toggle-thumbnails": {
      // The main process echoes the new preferences back, so the strip and the
      // menu checkbox always agree.
      const preferences = await api.setPreference("showThumbnails", !state.thumbnailsVisible);
      if (preferences !== null && typeof preferences === "object") {
        state.preferences = preferences;
        applyPreferences();
      }
      return;
    }
    case "add-bookmark":
      void openBookmarksDialog();
      return;
    case "show-achievements":
      await openAchievementsDialog();
      return;
    case "show-bookmarks":
      void openBookmarksDialog();
      return;
    case "show-recent":
      void openRecentDialog();
      return;
    case "show-preferences":
      syncPreferenceControls();
      preferencesDialog.showModal();
      return;
    case "clear-history":
      void api.clearHistory().then(() => refreshLibrary());
      return;
    default:
  }
};

/* Input -------------------------------------------------------------------- */

const wireKeyboard = () => {
  window.addEventListener("keydown", async (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;

    // Escape is the expected way out of full screen, and it is handled here
    // rather than as a binding so it cannot be reassigned away.
    if (event.key === "Escape" && state.fullscreen) {
      event.preventDefault();
      await runCommand("fullscreen-off");
      return;
    }

    // Rebinding captures the next key, whatever it is.
    if (state.capturing !== null) {
      event.preventDefault();
      const { command, slot } = state.capturing;
      state.capturing = null;
      const keyString = event.key === "Escape" ? null : keyFromEvent(event);
      const shortcuts = await api.setShortcut(command, slot, keyString);
      if (shortcuts !== null && typeof shortcuts === "object") state.shortcuts = shortcuts;
      renderShortcutList();
      return;
    }

    const command = resolveCommand(state.shortcuts, keyFromEvent(event));
    if (command === null) {
      // Menu-owned accelerators arrive as commands rather than through here.
      if ((event.ctrlKey || event.metaKey) && (event.key === "g" || event.key === "G")) {
        event.preventDefault();
        openGotoDialog();
      }
      return;
    }
    event.preventDefault();
    await runCommand(command);
  });
};

const wireWheel = () => {
  stage.addEventListener(
    "wheel",
    (event) => {
      if (state.book === null) return;
      event.preventDefault();
      if (event.ctrlKey) {
        const rect = stage.getBoundingClientRect();
        setScale(zoomStep(state.scale, event.deltaY < 0 ? 1 : -1), {
          x: event.clientX - rect.left - rect.width / 2,
          y: event.clientY - rect.top - rect.height / 2,
        });
        return;
      }
      const viewport = viewportSize();
      const content = contentSize();
      const direction = Math.sign(event.deltaY) || 1;
      if (content.height > viewport.height + 1) {
        const bounds = panBounds(content, viewport, panMargin());
        const target = state.offset.y - direction * Math.max(40, Math.abs(event.deltaY));
        if (Math.abs(target) <= bounds.maxY) {
          state.offset = clampPan({ x: state.offset.x, y: target }, content, viewport, panMargin());
          layoutSpread();
          return;
        }
      }
      if (direction > 0) nextSpread();
      else previousSpread();
    },
    { passive: false },
  );
};

const wirePointer = () => {
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.book === null) return;
    state.drag = { x: event.clientX, y: event.clientY, offset: { ...state.offset }, moved: false };
    stage.setPointerCapture?.(event.pointerId);
  });

  stage.addEventListener("pointermove", (event) => {
    const drag = state.drag;
    if (drag === null) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    const content = contentSize();
    state.offset = clampPan(
      { x: drag.offset.x + dx, y: drag.offset.y + dy },
      content,
      viewportSize(),
      panMargin(),
    );
    layoutSpread();
  });

  stage.addEventListener("pointerup", (event) => {
    const drag = state.drag;
    state.drag = null;
    if (drag === null) return;
    state.lastDragMoved = drag.moved;
    stage.releasePointerCapture?.(event.pointerId);
  });
};

const wireMagnifier = () => {
  let frame = null;
  let last = null;
  stage.addEventListener("pointermove", (event) => {
    last = { x: event.clientX, y: event.clientY };
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (last !== null) updateMagnifier(last);
    });
  });
  stage.addEventListener("pointerleave", () => hideMagnifier());
};

const wireZones = () => {
  document.getElementById("zones").addEventListener("click", (event) => {
    if (state.lastDragMoved) {
      state.lastDragMoved = false;
      return;
    }
    const zone = event.target.closest(".zone");
    if (zone === null) return;
    const isRightZone = zone.dataset.zone === "next";
    const goForward = state.rightToLeft ? !isRightZone : isRightZone;
    if (goForward) nextSpread();
    else previousSpread();
  });
};

const wireDialogs = () => {
  document.getElementById("goto-cancel").addEventListener("click", () => gotoDialog.close());
  document.getElementById("help-close").addEventListener("click", () => helpDialog.close());
  document.querySelector("#goto-dialog form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = Number(gotoInput.value);
    gotoDialog.close();
    if (Number.isFinite(value) && value >= 1) goToPage(value);
  });

  document.getElementById("bookmark-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void addBookmarkAtCurrentPage();
  });
  document.getElementById("bookmarks-close").addEventListener("click", () => bookmarksDialog.close());
  document.getElementById("recent-close").addEventListener("click", () => recentDialog.close());
  document.getElementById("recent-export").addEventListener("click", () => void exportLibrary());
  document.getElementById("recent-import").addEventListener("click", () => void importLibrary());
  document.getElementById("achievements-close").addEventListener("click", () => achievementsDialog.close());
  document.getElementById("achievements-reset").addEventListener("click", async () => {
    await api.resetAchievements();
    try {
      renderAchievementList(await api.getAchievements());
    } catch {
      /* the dialog simply keeps what it showed */
    }
    toast("Achievements reset");
  });
  document.getElementById("recent-clear").addEventListener("click", async () => {
    await api.clearHistory();
    await refreshLibrary();
    renderRecentList();
    toast("History cleared");
  });
};

const wireToolbar = () => {
  document.getElementById("toolbar").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-command]");
    if (button !== null) runCommand(button.dataset.command);
  });
};

const wireDrop = () => {
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", async (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file === undefined) return;
    let targetPath = null;
    try {
      targetPath = api.getPathForFile(file);
    } catch {
      targetPath = null;
    }
    if (targetPath === null || targetPath === "") {
      toast("Could not resolve the dropped path.");
      return;
    }
    showOpening();
    const result = await api.openBook(targetPath);
    if (result.ok) applyBook(result.book);
    else {
      hideOpening();
      toast(result.error.message);
    }
  });
};

/** Track which page the reader has scrolled to in the vertical column. */
const wireVerticalScroll = () => {
  let scheduled = false;
  scrollEl.addEventListener(
    "scroll",
    () => {
      if (scheduled || !verticalActive()) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const index = verticalPageAtCentre();
        if (index === state.spreadIndex) return;
        state.spreadIndex = index;
        renderVerticalPdfWindow(index);
        scheduleStripDetection();
        updateStatus();
        updateThumbnailHighlight();
        reportProgress();
      });
    },
    { passive: true },
  );
};

const wireResize = () => {
  const observer = new ResizeObserver(() => {
    if (state.book === null) return;
    if (state.fitMode === "manual") layoutSpread();
    else applyFit();
  });
  observer.observe(stage);
};

/* Start-up ----------------------------------------------------------------- */

const init = async () => {
  wireKeyboard();
  wireWheel();
  wirePointer();
  wireMagnifier();
  wireZones();
  wireDialogs();
  wirePreferences();
  wireToolbar();
  wireDrop();
  wireResize();
  wireVerticalScroll();
  wireResumeBanner();
  wireThumbnailScroll();

  api.onCommand(runCommand);
  api.on("app:book-opened", (book) => applyBookSafely(book));
  api.on("app:book-failed", (error) => {
    toast(error.message);
    api.reportError(error);
  });
  api.on("app:achievement", (achievement) => announceAchievement(achievement));
  api.on("app:open-progress", (progress) => showOpening(progress));
  api.on("app:fullscreen", (value) => {
    const wasFullscreen = state.fullscreen;
    state.fullscreen = Boolean(value);
    applyChrome();
    if (state.fullscreen && !wasFullscreen) toast("Full screen — press Esc or F11 to leave");
  });
  api.on("app:preferences", (preferences) => {
    state.preferences = preferences;
    applyPreferences();
  });

  await refreshLibrary();
  state.shortcuts = normalizeShortcuts(await api.getShortcuts());
  renderShortcutList();

  const book = await api.getBook();
  if (book !== null) await applyBook(book);
  try {
    state.fullscreen = Boolean(await api.isFullscreen());
  } catch {
    /* Non-fatal: the window simply starts windowed. */
  }
  applyChrome();
};

await init();
