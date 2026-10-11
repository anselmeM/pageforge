/**
 * PageForge viewer.
 *
 * Holds the reading state (current spread, scale, pan, rotation, reading
 * direction) and renders it. All layout arithmetic lives in `../core/` so it can
 * be tested without a window; this file only translates that state into DOM.
 */

import { clampScale, fitScale, zoomStep } from "../core/fit.js";
import { DEFAULT_PREFERENCES, describeHistoryEntry, resolveStartPage } from "../core/library.js";
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

/** Fallback size for pages whose header could not be parsed. */
const UNKNOWN_PAGE_SIZE = { width: 1000, height: 1500 };

/** Set once the command-line startup command has been applied. */
let startupCommandApplied = false;

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
  schedulePdfRenders();
  updateStatus();
};

/**
 * Render PDF canvases at a resolution that matches what is on screen, and again
 * when zooming makes the current bitmap too coarse. Archives need none of this:
 * their images are decoded by Chromium at display resolution.
 */
const schedulePdfRenders = () => {
  if (state.pdf === null) return;
  for (const node of state.nodes) {
    if (node.kind !== "pdf") continue;
    const resolution = Math.min(3, Math.max(1, (window.devicePixelRatio || 1) * state.scale));
    const previous = node.renderedScale;
    if (previous > 0 && Math.abs(resolution - previous) / previous <= 0.25) continue;
    void renderPdfNode(node, resolution);
  }
};

const renderPdfNode = async (node, resolution) => {
  node.currentTask?.cancel?.();
  const token = Symbol("render");
  node.renderToken = token;
  try {
    const { task, scale } = await startPdfRender(state.pdf, node.page.index, node.element, resolution);
    if (node.renderToken !== token) {
      task.cancel();
      return;
    }
    node.currentTask = task;
    await task.promise;
    if (node.renderToken === token) node.renderedScale = scale;
  } catch (error) {
    // A cancelled render is expected whenever the user moves on quickly.
    if (node.renderToken === token && error?.name !== "RenderingCancelledException") {
      toast(`Page ${node.page.index + 1} could not be rendered.`);
    }
  }
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
  for (const pageIndex of visualOrder(spread, state.rightToLeft)) {
    const page = state.book.pages[pageIndex];
    const wrapper = document.createElement("div");
    wrapper.className = "page";
    const isPdf = page.kind === "pdf";
    const element = isPdf ? document.createElement("canvas") : document.createElement("img");
    if (isPdf) {
      element.className = "page-canvas";
    } else {
      element.src = page.url;
      element.alt = page.name;
      element.draggable = false;
      element.addEventListener("load", () => learnDimensions(page, element));
      element.addEventListener("error", () => toast(`Could not display ${page.name}`));
    }
    wrapper.append(element);
    spreadEl.append(wrapper);
    state.nodes.push({
      page,
      wrapper,
      element,
      kind: isPdf ? "pdf" : "image",
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
  });
};

const applyBook = async (book) => {
  state.pdf = null;
  state.preferences = book.preferences ?? state.preferences;
  if (book.kind === "pdf") {
    try {
      const { document: pdfDocument, pages } = await openPdfDocument(book.documentUrl);
      state.pdf = pdfDocument;
      state.book = { ...book, pages };
    } catch (error) {
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
  rebuildSpreads();
  renderSpread();
  applyFit();

  // Pick up this book's bookmarks, then resume where the reader left off.
  await refreshLibrary();

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
    if (command !== null && command !== undefined) await runCommand(command);
  }
  void reportReady();
};

/* Library: preferences, thumbnails, bookmarks, recents ---------------------- */

const applyPreferences = () => {
  state.thumbnailsVisible = state.preferences.showThumbnails === true;
  thumbnailsEl.hidden = !state.thumbnailsVisible;
  if (state.thumbnailsVisible) buildThumbnails();
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

/* Navigation --------------------------------------------------------------- */

const goToSpread = (index) => {
  if (state.book === null || state.spreads.length === 0) return;
  const clamped = Math.min(Math.max(index, 0), state.spreads.length - 1);
  state.spreadIndex = clamped;
  renderSpread();
  if (state.fitMode === "manual") layoutSpread();
  else applyFit();
  updateThumbnailHighlight();
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
      helpDialog.showModal();
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
    case "clear-history":
      void api.clearHistory().then(() => refreshLibrary());
      return;
    default:
  }
};

/* Input -------------------------------------------------------------------- */

const wireKeyboard = () => {
  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.key === "g" || event.key === "G") {
        event.preventDefault();
        openGotoDialog();
      }
      return;
    }
    switch (event.key) {
      case "ArrowRight":
      case "PageDown":
      case " ":
        nextSpread();
        break;
      case "ArrowLeft":
      case "PageUp":
        previousSpread();
        break;
      case "Home":
        goToPage(1);
        break;
      case "End":
        goToPage(state.book === null ? 1 : state.book.pages.length);
        break;
      case "+":
      case "=":
        zoomIn();
        break;
      case "-":
      case "_":
        zoomOut();
        break;
      case "0":
        actualSize();
        break;
      case "f":
      case "F":
        setFitMode("screen");
        break;
      case "w":
      case "W":
        setFitMode("width");
        break;
      case "h":
      case "H":
        setFitMode("height");
        break;
      case "d":
      case "D":
        toggleDoublePage();
        break;
      case "j":
      case "J":
        toggleRightToLeft();
        break;
      case "r":
        rotate(90);
        break;
      case "R":
        rotate(-90);
        break;
      default:
        return;
    }
    event.preventDefault();
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
  wireZones();
  wireDialogs();
  wireToolbar();
  wireDrop();
  wireResize();

  api.onCommand(runCommand);
  api.on("app:book-opened", (book) => void applyBook(book));
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

  const book = await api.getBook();
  if (book !== null) await applyBook(book);

  try {
    document.body.classList.toggle("fullscreen", Boolean(await api.isFullscreen()));
  } catch {
    /* Non-fatal: the window simply starts windowed. */
  }
};

await init();
