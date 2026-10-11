/**
 * PageForge viewer.
 *
 * Holds the reading state (current spread, scale, pan, rotation, reading
 * direction) and renders it. All layout arithmetic lives in `../core/` so it can
 * be tested without a window; this file only translates that state into DOM.
 */

import { IDENTITY_GAINS, averageChannelMeans, colorFilterParameters, computeWhiteBalanceGains } from "../core/color.js";
import { clampScale, fitScale, zoomStep } from "../core/fit.js";
import { lensPosition, magnifierSample } from "../core/magnifier.js";
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
const zoomLabel = document.getElementById("zoom-label");
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
/** The three per-channel transfer functions inside the colour filter. */
const colorCurves = {
  r: document.querySelector("#pf-color feFuncR"),
  g: document.querySelector("#pf-color feFuncG"),
  b: document.querySelector("#pf-color feFuncB"),
};
const saturationMatrix = document.getElementById("pf-saturation");
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
  zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
  modeLabel.textContent = [
    state.doublePage ? "Double page" : "Single page",
    state.rightToLeft ? "Right to left" : "Left to right",
    state.fitMode === "manual" ? "Zoom" : `Fit ${state.fitMode}`,
    state.rotation === 0 ? null : `${state.rotation}°`,
  ]
    .filter(Boolean)
    .join(" · ");

  if (state.book === null || spread === null) {
    pageLabel.textContent = "No book open";
    bookLabel.textContent = "";
    return;
  }
  const first = spread.indices[0] + 1;
  const last = spread.indices[spread.indices.length - 1] + 1;
  const total = state.book.pages.length;
  pageLabel.textContent = first === last ? `Page ${first} / ${total}` : `Pages ${first}–${last} / ${total}`;
  bookLabel.textContent = state.book.displayName;
};

/** Push the current scale, rotation and offset onto the existing DOM nodes. */
const layoutSpread = () => {
  const spread = currentSpread();
  if (spread === null) {
    updateStatus();
    return;
  }
  const viewport = viewportSize();
  const content = contentSize();
  state.offset = clampPan(state.offset, content, viewport, panMargin());

  for (const node of state.nodes) {
    const base = pageSize(node.page);
    const oriented = orientedSize(base);
    node.wrapper.style.width = `${oriented.width * state.scale}px`;
    node.wrapper.style.height = `${oriented.height * state.scale}px`;
    node.element.style.width = `${base.width * state.scale}px`;
    node.element.style.height = `${base.height * state.scale}px`;
    node.element.style.transform = `translate(-50%, -50%) rotate(${state.rotation}deg)`;
  }
  spreadEl.style.transform = `translate(${state.offset.x}px, ${state.offset.y}px)`;
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
    if (state.nodes[0] === node) sampleSpreadColor();
  } catch (error) {
    // A cancelled render is expected whenever the user moves on quickly.
    if (node.renderToken === token && error?.name !== "RenderingCancelledException") {
      toast(`Page ${node.page.index + 1} could not be rendered.`);
    }
  }
};

/* Colour handling ---------------------------------------------------------- */

/** Push the current settings into the SVG filter and attach it to the spread. */
const applyColorFilter = () => {
  const parameters = colorFilterParameters(state.preferences, state.colorGains);
  for (const curve of Object.values(colorCurves)) {
    curve.setAttribute("exponent", String(parameters.exponent));
  }
  colorCurves.r.setAttribute("amplitude", String(parameters.r));
  colorCurves.g.setAttribute("amplitude", String(parameters.g));
  colorCurves.b.setAttribute("amplitude", String(parameters.b));
  saturationMatrix.setAttribute("values", String(parameters.saturation));
  spreadEl.style.filter = parameters.active ? "url(#pf-color)" : "";
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
    { doublePage: state.doublePage, coverAlone: false },
  );
  state.spreadIndex = Math.min(state.spreadIndex, Math.max(0, state.spreads.length - 1));
};

const applyFit = () => {
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

const reportReady = async () => {
  await waitForFirstPage();
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
    thumbnails: thumbnailsEl.hidden ? 0 : thumbnailsEl.querySelectorAll(".thumb").length,
    // Reading-quality facts, so the colour and scaling paths are assertable.
    colorMode: state.preferences.colorMode,
    colorGains: { ...state.colorGains },
    nodeKinds: state.nodes.map((node) => node.kind),
    magnifierVisible: state.preferences.magnifierVisible === true,
    slideshowRunning: state.slideshowRunning,
    nextPagePrimary: state.shortcuts["next-page"].primary,
  });
};

const applyBook = async (book) => {
  const token = (applyToken += 1);
  stopSlideshow();
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
    toast(`Resumed at page ${start}`);
  }
  buildThumbnails();
  emptyState.hidden = true;
  syncToolbar();

  // A command-line command is applied before readiness is reported, so an
  // automated run observes the state the command produced.
  if (!startupCommandApplied) {
    startupCommandApplied = true;
    const command = await api.getStartupCommand();
    if (token !== applyToken) return;
    if (command !== null && command !== undefined) await runCommand(command);
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
  syncPreferenceControls();
  syncToolbar();
};

const refreshLibrary = async () => {
  const library = await api.getLibrary();
  state.preferences = library.preferences;
  state.history = library.history;
  state.bookmarks = library.bookmarks;
  applyPreferences();
  if (library.loadProblem !== null && library.loadProblem !== undefined) toast(library.loadProblem);
  return library;
};

let progressTimer = null;
/** Remember the reading position, without writing on every page turn. */
const reportProgress = () => {
  const spread = currentSpread();
  if (state.book === null || spread === null) return;
  const page = spread.indices[0] + 1;
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    void api.setProgress(state.book.targetPath, page).catch(() => {});
  }, 400);
};

let thumbnailObserver = null;

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

const buildThumbnails = () => {
  thumbnailObserver?.disconnect();
  thumbnailObserver = null;
  thumbnailsEl.replaceChildren();
  if (!state.thumbnailsVisible || state.book === null) return;

  thumbnailObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbnailObserver.unobserve(entry.target);
        void fillThumbnail(entry.target);
      }
    },
    { root: thumbnailsEl, rootMargin: "300px" },
  );

  const fragment = document.createDocumentFragment();
  state.book.pages.forEach((page, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumb";
    button.dataset.page = String(index);
    button.title = `${index + 1} · ${page.name}`;
    button.addEventListener("click", () => goToPage(index + 1));
    const number = document.createElement("span");
    number.className = "thumb-number";
    number.textContent = String(index + 1);
    button.append(number);
    fragment.append(button);
  });
  thumbnailsEl.append(fragment);
  for (const button of thumbnailsEl.querySelectorAll(".thumb")) thumbnailObserver.observe(button);
  updateThumbnailHighlight();
};

const updateThumbnailHighlight = () => {
  if (state.thumbnailsVisible !== true) return;
  const active = new Set(currentSpread()?.indices ?? []);
  for (const button of thumbnailsEl.querySelectorAll(".thumb")) {
    const isCurrent = active.has(Number(button.dataset.page));
    button.classList.toggle("current", isCurrent);
    if (isCurrent) button.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
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

const renderRecentList = () => {
  recentList.replaceChildren();
  document.getElementById("recent-empty").hidden = state.history.length > 0;
  for (const entry of state.history) {
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
    recentList.append(item);
  }
};

const openRecentDialog = async () => {
  await refreshLibrary();
  renderRecentList();
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
};

const syncPreferenceControls = () => {
  const preferences = state.preferences;
  prefColorMode.value = preferences.colorMode;
  prefSensitivity.value = String(preferences.colorSensitivity);
  prefGamma.value = String(preferences.gamma);
  prefVibrance.value = String(preferences.vibrance);
  prefResampling.value = preferences.resampling;
  prefPrefetch.value = String(preferences.prefetchPages);
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
};

const wirePreferences = () => {
  prefColorMode.addEventListener("change", () => void writePreference("colorMode", prefColorMode.value));
  prefResampling.addEventListener("change", () => void writePreference("resampling", prefResampling.value));
  prefPrefetch.addEventListener("change", () =>
    void writePreference("prefetchPages", Number(prefPrefetch.value)),
  );
  for (const [element, key] of [
    [prefSensitivity, "colorSensitivity"],
    [prefGamma, "gamma"],
    [prefVibrance, "vibrance"],
  ]) {
    element.addEventListener("input", () => showPreferenceValues());
    element.addEventListener("change", () => void writePreference(key, Number(element.value)));
  }
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

/* Navigation --------------------------------------------------------------- */

const goToSpread = (index) => {
  if (state.book === null || state.spreads.length === 0) return;
  const clamped = Math.min(Math.max(index, 0), state.spreads.length - 1);
  state.spreadIndex = clamped;
  renderSpread();
  if (state.fitMode === "manual") layoutSpread();
  else applyFit();
  updateThumbnailHighlight();
  prefetchAround();
  reportProgress();
};

const nextSpread = () => goToSpread(state.spreadIndex + 1);
const previousSpread = () => goToSpread(state.spreadIndex - 1);

const goToPage = (pageNumber) => {
  if (state.book === null) return;
  const index = Math.min(Math.max(Math.floor(pageNumber) - 1, 0), state.book.pages.length - 1);
  goToSpread(spreadIndexForPage(state.spreads, index));
};

/* Zoom and fit ------------------------------------------------------------- */

const setScale = (nextScale, pointer = { x: 0, y: 0 }) => {
  const clamped = clampScale(nextScale);
  if (Math.abs(clamped - state.scale) < 1e-6) return;
  state.offset = zoomAtPoint(state.scale, state.offset, clamped, pointer);
  state.scale = clamped;
  state.fitMode = "manual";
  layoutSpread();
  syncToolbar();
};

const zoomIn = () => setScale(zoomStep(state.scale, 1));
const zoomOut = () => setScale(zoomStep(state.scale, -1));

const setFitMode = (mode) => {
  state.fitMode = mode;
  applyFit();
  syncToolbar();
};

const actualSize = () => {
  state.scale = 1;
  state.fitMode = "manual";
  state.offset = { x: 0, y: 0 };
  layoutSpread();
  syncToolbar();
};

const rotate = (degrees) => {
  state.rotation = (((state.rotation + degrees) % 360) + 360) % 360;
  if (state.fitMode === "manual") layoutSpread();
  else applyFit();
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
};

const toggleRightToLeft = () => {
  state.rightToLeft = !state.rightToLeft;
  renderSpread();
  syncToolbar();
};

/* Chrome ------------------------------------------------------------------- */

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
  applyBook(result.book);
};

const openGotoDialog = () => {
  if (state.book === null) return;
  gotoInput.value = String((currentSpread()?.indices[0] ?? 0) + 1);
  gotoDialog.showModal();
  gotoInput.select();
};

const setFullScreen = async (value) => {
  const current = await api.isFullscreen();
  if (value === undefined ? true : value !== current) await api.toggleFullscreen();
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
      return;
    case "fullscreen-on":
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
    const result = await api.openBook(targetPath);
    if (result.ok) applyBook(result.book);
    else toast(result.error.message);
  });
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

  api.onCommand(runCommand);
  api.on("app:book-opened", (book) => applyBookSafely(book));
  api.on("app:book-failed", (error) => {
    toast(error.message);
    api.reportError(error);
  });
  api.on("app:fullscreen", (value) => document.body.classList.toggle("fullscreen", Boolean(value)));
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
    document.body.classList.toggle("fullscreen", Boolean(await api.isFullscreen()));
  } catch {
    /* Non-fatal: the window simply starts windowed. */
  }
};

await init();
