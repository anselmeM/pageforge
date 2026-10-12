/**
 * PageForge main process.
 *
 * Owns the window, the open comic source, and the `pageforge://page/<n>`
 * protocol the viewer uses to fetch page bytes. Page images are served by the
 * protocol rather than pushed over IPC so Chromium caches and decodes them the
 * same way it would any other image.
 *
 * This file is CommonJS on purpose. Electron's main-process `electron` module is
 * a CommonJS built-in: an ES-module entry cannot import its members, and
 * requiring it through `createRequire` from an ES module resolves to the npm
 * shim instead. The reader stays an ES module and is loaded with `import()`.
 */

const { appendFileSync } = require("node:fs");
const { readFile, stat, writeFile } = require("node:fs/promises");
const { basename, extname, isAbsolute, join, relative, resolve } = require("node:path");

const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } = require("electron");

// When ELECTRON_RUN_AS_NODE is inherited, electron.exe runs as plain Node: the
// electron module resolves to the npm shim and every member below is undefined.
// Fail with the actual reason instead of an obscure TypeError.
if (typeof protocol === "undefined" || typeof app === "undefined") {
  process.stderr.write(
    "PageForge must run as an Electron app, but the electron module has no API here.\n" +
      "This happens when ELECTRON_RUN_AS_NODE is set in the environment, which makes\n" +
      "electron.exe start as plain Node. Run `npm start` (which clears it), or unset it.\n",
  );
  process.exit(1);
}

const here = __dirname;
/** Application assets are served from `src/` so `renderer/` can import `core/`. */
const appRoot = resolve(here, "..");

/**
 * Record a failure that escaped its caller, and keep running.
 *
 * Electron's default for an uncaught main-process exception is a modal crash
 * dialog. For a reader that is the wrong trade: a fault in one page read should
 * not end the session, and a truncated dialog stack is not something a user can
 * act on. The full stack goes to stderr and to a log beside the library.
 */
const recordFailure = (kind, error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`PageForge ${kind}: ${detail}\n`);
  try {
    const directory = process.env.PAGEFORGE_STATE_DIR ?? (app.isReady() ? app.getPath("userData") : null);
    if (directory === null) return;
    appendFileSync(join(directory, "pageforge-errors.log"), `[${new Date().toISOString()}] ${kind}: ${detail}\n`);
  } catch {
    /* stderr already has it. */
  }
};

process.on("uncaughtException", (error) => recordFailure("uncaughtException", error));
process.on("unhandledRejection", (reason) => recordFailure("unhandledRejection", reason));

const STATIC_MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".svg", "image/svg+xml"],
]);

/**
 * Vendored browser assets (pdf.js) are served under the same origin as the
 * viewer, because a cross-origin ES-module import would need CORS headers that
 * a custom scheme does not negotiate.
 */
const VENDOR_PREFIX = "vendor/";
const vendorRoot = resolve(appRoot, "..", "node_modules");

const PDF_EXTENSIONS = new Set([".pdf"]);

/** The reader is an ES module, loaded once on first use. */
let readerModule = null;
const reader = async () => {
  readerModule ??= await import("./reader.js");
  return readerModule;
};

/** Scheme must be declared privileged before the app becomes ready. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: "pageforge",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/** The single open source for this window, and the open PDF when there is one. */
let session = null;
let documentPath = null;
let mainWindow = null;
/** True once the app has started quitting, so a hide is not fought. */
let quitting = false;
/** The persistent library, created once the app is ready. */
let library = null;

const ensureLibrary = async () => {
  if (library !== null) return library;
  const { createStore } = await import("./store.js");
  // PAGEFORGE_STATE_DIR keeps tests and smoke runs away from the real library.
  const directory = process.env.PAGEFORGE_STATE_DIR ?? app.getPath("userData");
  library = await createStore({ directory });
  return library;
};

/** Path of whatever is open, for per-book lookups. */
const currentTargetPath = () => session?.targetPath ?? documentPath;

const isSmokeRun = process.argv.includes("--smoke");
let smokeReported = false;

/** `--capture=<file>` writes a PNG of the rendered window and exits. */
const captureArgument = process.argv.find((argument) => argument.startsWith("--capture="));
const capturePath = captureArgument === undefined ? null : captureArgument.slice("--capture=".length);
/** `--command=<cmd>[,<cmd>]` runs viewer commands once the first book is open. */
const commandArgument = process.argv.find((argument) => argument.startsWith("--command="));
const startupCommands =
  commandArgument === undefined
    ? []
    : commandArgument
        .slice("--command=".length)
        .split(",")
        .map((command) => command.trim())
        .filter((command) => command.length > 0);
/**
 * `--report=<file>` also writes the run report to a file.
 *
 * The NSIS portable launcher starts the app without attaching its stdout, so a
 * scripted run of a packaged build cannot read the report from the pipe. Writing
 * it to a file works however the process was started.
 */
const reportArgument = process.argv.find((argument) => argument.startsWith("--report="));
const reportPath = reportArgument === undefined ? null : reportArgument.slice("--report=".length);
/** `--settle=<ms>` waits before capturing, for lazy content to finish loading. */
const settleArgument = process.argv.find((argument) => argument.startsWith("--settle="));
const settleMs = settleArgument === undefined ? 700 : Number(settleArgument.slice("--settle=".length)) || 700;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const emitReport = async (payload) => {
  const line = `${JSON.stringify(payload)}\n`;
  process.stdout.write(line);
  if (reportPath === null) return;
  try {
    await writeFile(reportPath, line, "utf8");
  } catch {
    /* The stream already carried it; a report file is a convenience. */
  }
};

/**
 * Exit without leaking resources.
 *
 * `app.exit()` settles immediately and does not fire `before-quit`, so the
 * staged extraction directory of an open RAR or 7z archive would be left behind.
 * Every automated exit goes through here instead.
 */
const exitCleanly = async (code) => {
  try {
    await closeSession();
  } catch {
    /* Nothing useful to do: the process is leaving either way. */
  }
  if (library !== null) {
    try {
      await library.flush();
    } catch {
      /* A queued write that cannot land is reported by the store itself. */
    }
  }
  app.exit(code);
};

const takeCapture = async () => {
  // Let lazy content (thumbnails, deferred renders) settle before the shot.
  await delay(settleMs);
  const image = await mainWindow.webContents.capturePage();
  await writeFile(capturePath, image.toPNG());
  process.stdout.write(`${JSON.stringify({ capture: capturePath, command: startupCommands })}\n`);
};

const positionalTarget = () =>
  process.argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((argument) => !argument.startsWith("--"))
    .at(0);

const bookPayload = (opened) => ({
  targetPath: opened.targetPath,
  displayName: opened.displayName,
  kind: opened.kind,
  pages: opened.pages.map((page, index) => ({
    index,
    name: page.name,
    width: page.width,
    height: page.height,
    format: page.format,
    bytes: page.bytes,
    // Served from the viewer's own origin: page bytes are drawn into a canvas
    // to estimate white balance, and a cross-origin image would taint it.
    url: `pageforge://app/page/${index}`,
  })),
});

const closeSession = async () => {
  documentPath = null;
  if (session === null) return;
  const closing = session;
  session = null;
  await closing.close();
};

/**
 * A PDF is not read here: the viewer loads it with pdf.js. The main process only
 * checks that it is a readable file and serves its bytes to that origin.
 */
const loadDocument = async (targetPath) => {
  const info = await stat(targetPath);
  if (!info.isFile()) {
    throw Object.assign(new Error("Only files can be opened."), { code: "unsupported-target" });
  }
  documentPath = targetPath;
  return {
    kind: "pdf",
    targetPath,
    displayName: basename(targetPath),
    documentUrl: "pageforge://app/document",
    pages: [],
  };
};

const loadTarget = async (targetPath) => {
  await closeSession();
  const store = await ensureLibrary();
  if (PDF_EXTENSIONS.has(extname(targetPath).toLowerCase())) {
    const book = await loadDocument(targetPath);
    const entry = await store.recordOpen({
      targetPath,
      displayName: book.displayName,
      kind: book.kind,
      pages: 0,
    });
    // A PDF's page count is only known once the viewer has parsed it, so the
    // recorded page is passed through unclamped and the viewer clamps it.
    return {
      ...book,
      resumePage: entry.lastPage,
      preferences: store.preferences(),
      bookSettings: store.bookSettings(targetPath),
    };
  }
  const { openTarget } = await reader();
  // Opening a large archive can take a while, so the viewer is told how far it
  // has got rather than left on a blank screen.
  let lastReported = 0;
  const opened = await openTarget(targetPath, {
    onProgress: (progress) => {
      const now = Date.now();
      if (now - lastReported < 80 && progress.total > 0 && progress.done < progress.total) return;
      lastReported = now;
      send("app:open-progress", progress);
    },
  });
  session = opened;
  const book = bookPayload(opened);
  const entry = await store.recordOpen({
    targetPath,
    displayName: book.displayName,
    kind: book.kind,
    pages: book.pages.length,
  });
  return {
    ...book,
    resumePage: entry.lastPage,
    preferences: store.preferences(),
    bookSettings: store.bookSettings(targetPath),
  };
};

/** Render a failure for the viewer without leaking a stack trace. */
const friendlyError = (error) => ({
  code: typeof error?.code === "string" && error.code.length > 0 ? error.code : "unexpected",
  message: error instanceof Error ? error.message : String(error),
});

const openWithDialog = async (kind) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: kind === "folder" ? "Open folder of images" : "Open comic",
    properties: kind === "folder" ? ["openDirectory"] : ["openFile"],
    filters:
      kind === "folder"
        ? []
        : [
            { name: "Comics and documents", extensions: ["cbz", "zip", "zipx", "cbr", "rar", "cb7", "7z", "pdf"] },
            { name: "All files", extensions: ["*"] },
          ],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  try {
    const book = await loadTarget(result.filePaths[0]);
    return { canceled: false, book };
  } catch (error) {
    return { canceled: false, error: friendlyError(error) };
  }
};

const send = (channel, payload) => {
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

/**
 * Full screen is owned by the main process: the menu item, the toolbar button
 * and the F11 accelerator all funnel through here.
 *
 * The window's own state is the only source of truth. Reporting back the value
 * that was *requested* would let the menu checkbox and the viewer's chrome
 * disagree with the window, which leaves a user with a hidden toolbar and no
 * working way out.
 */
const syncFullScreenState = () => {
  const value = mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFullScreen();
  const item = Menu.getApplicationMenu()?.getMenuItemById("full-screen");
  if (item !== undefined && item !== null) item.checked = value;
  send("app:fullscreen", value);
  return value;
};

const setFullScreen = (value) => {
  if (mainWindow === null || mainWindow.isDestroyed()) return false;
  // A hidden window cannot be revealed by entering full screen, so make sure it
  // is on screen first.
  if (value && !mainWindow.isVisible()) mainWindow.show();
  mainWindow.setFullScreen(value);
  return syncFullScreenState();
};

/** Preferences that have a menu checkbox, so the two can never disagree. */
const MENU_ITEM_FOR_PREFERENCE = {
  showThumbnails: "show-thumbnails",
  resumeLastPage: "resume-last-page",
  magnifierVisible: "magnifier",
};

/**
 * Change a preference and keep the menu checkbox, the store and the viewer in
 * step. The viewer is told rather than being asked to remember.
 */
const applyPreference = async (key, value) => {
  const store = await ensureLibrary();
  const preferences = await store.setPreference(key, value);
  const item = Menu.getApplicationMenu()?.getMenuItemById(MENU_ITEM_FOR_PREFERENCE[key]);
  if (item !== undefined && item !== null) item.checked = value;
  send("app:preferences", preferences);
  return preferences;
};

const buildMenu = (preferences) =>
  Menu.buildFromTemplate([    {
      label: "&File",
      submenu: [
        { label: "Open Comic…", accelerator: "CmdOrCtrl+O", click: () => send("app:command", "open-file") },
        { label: "Open Folder…", accelerator: "CmdOrCtrl+Shift+O", click: () => send("app:command", "open-folder") },
        { type: "separator" },
        { label: "Close Book", accelerator: "CmdOrCtrl+W", click: () => send("app:command", "close-book") },
        { type: "separator" },
        { label: "Reading Quality…", accelerator: "CmdOrCtrl+,", click: () => send("app:command", "show-preferences") },
        { type: "separator" },
        { label: "Exit", accelerator: "CmdOrCtrl+Q", role: "quit" },
      ],
    },
    {
      label: "&Go",
      submenu: [
        { label: "First Page", click: () => send("app:command", "first-page") },
        { label: "Previous Page", click: () => send("app:command", "previous-page") },
        { label: "Next Page", click: () => send("app:command", "next-page") },
        { label: "Last Page", click: () => send("app:command", "last-page") },
        { type: "separator" },
        { label: "Go To Page…", accelerator: "CmdOrCtrl+G", click: () => send("app:command", "go-to-page") },
      ],
    },
    {
      label: "&Library",
      submenu: [
        { label: "Add Bookmark…", accelerator: "CmdOrCtrl+B", click: () => send("app:command", "add-bookmark") },
        { label: "Bookmarks…", accelerator: "CmdOrCtrl+Shift+B", click: () => send("app:command", "show-bookmarks") },
        { type: "separator" },
        { label: "Recent Books…", accelerator: "CmdOrCtrl+R", click: () => send("app:command", "show-recent") },
        { type: "separator" },
        {
          id: "resume-last-page",
          label: "Resume Last Page",
          type: "checkbox",
          checked: preferences.resumeLastPage,
          click: (item) => void applyPreference("resumeLastPage", item.checked),
        },
      ],
    },
    {
      label: "&View",
      submenu: [
        {
          id: "full-screen",
          label: "Full Screen",
          type: "checkbox",
          accelerator: "F11",
          click: (item) => setFullScreen(item.checked),
        },
        {
          id: "show-thumbnails",
          label: "Page Thumbnails",
          type: "checkbox",
          accelerator: "CmdOrCtrl+T",
          checked: preferences.showThumbnails,
          click: (item) => void applyPreference("showThumbnails", item.checked),
        },
        { type: "separator" },
        {
          label: "Double Page",
          type: "checkbox",
          click: (item) => send("app:command", item.checked ? "double-on" : "double-off"),
        },
        {
          label: "Japanese Reading (right to left)",
          type: "checkbox",
          click: (item) => send("app:command", item.checked ? "rtl-on" : "rtl-off"),
        },
        { type: "separator" },
        { label: "Zoom In", click: () => send("app:command", "zoom-in") },
        { label: "Zoom Out", click: () => send("app:command", "zoom-out") },
        { label: "Actual Size", click: () => send("app:command", "zoom-reset") },
        { type: "separator" },
        { label: "Fit to Screen", click: () => send("app:command", "fit-screen") },
        { label: "Fit Width", click: () => send("app:command", "fit-width") },
        { label: "Fit Height", click: () => send("app:command", "fit-height") },
        { type: "separator" },
        { label: "Rotate Right", click: () => send("app:command", "rotate-cw") },
        { label: "Rotate Left", click: () => send("app:command", "rotate-ccw") },
        { type: "separator" },
        {
          id: "magnifier",
          label: "Magnifier",
          type: "checkbox",
          checked: preferences.magnifierVisible,
          click: (item) => void applyPreference("magnifierVisible", item.checked),
        },
        { label: "Slideshow", click: () => send("app:command", "toggle-slideshow") },
      ],
    },
    {
      label: "&Help",
      submenu: [
        { label: "Keyboard Shortcuts…", click: () => send("app:command", "show-help") },
        {
          label: "About PageForge",
          click: () =>
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "About PageForge",
              message: `PageForge ${app.getVersion()}`,
              detail:
                "A local comic-book reader for CBZ/ZIP archives and image folders.\n\n" +
                "An independent implementation built from the observed feature set of CDisplayEx 1.10.33. " +
                "It shares no code, assets, or branding with that product.",
              buttons: ["OK"],
            }),
        },
      ],
    },
  ]);

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#101014",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await mainWindow.loadURL("pageforge://app/renderer/index.html");
  // Ctrl+wheel is reserved for the viewer's own zoom, so Chromium's page zoom
  // must not also react to it.
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);

  // The window's own events are the source of truth, so a change made by the OS
  // or a shortcut keeps the menu and the viewer in step.
  mainWindow.on("enter-full-screen", syncFullScreenState);
  mainWindow.on("leave-full-screen", syncFullScreenState);
  mainWindow.on("maximize", syncFullScreenState);
  mainWindow.on("unmaximize", syncFullScreenState);

  const reveal = () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    syncFullScreenState();
  };
  mainWindow.once("ready-to-show", reveal);
  // A page that never paints must not leave the app running with no window.
  setTimeout(reveal, 3000);

  // Nothing in this app hides the window, so a hide means something went wrong;
  // an invisible running app is worse than a surprising one.
  mainWindow.on("hide", () => {
    if (quitting) return;
    process.stderr.write("PageForge: the window was hidden unexpectedly; showing it again.\n");
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

const handleProtocol = () => {
  protocol.handle("pageforge", async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "app") {
      const requested = decodeURIComponent(url.pathname).replace(/^\/+/u, "");

      // The open PDF is served from this origin rather than its own host: a
      // cross-origin fetch would need CORS headers that a custom scheme does
      // not negotiate, and pdf.js fetches the document URL directly.
      if (requested === "document") {
        if (documentPath === null) return new Response("No document is open", { status: 404 });
        try {
          const bytes = await readFile(documentPath);
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-length": String(bytes.length),
              "cache-control": "no-store",
            },
          });
        } catch (error) {
          return new Response(`Document could not be read: ${error.message}`, { status: 500 });
        }
      }

      // Page bytes live on this origin too, for the reason given in bookPayload.
      if (requested.startsWith("page/")) {
        const index = Number(requested.slice("page/".length));
        if (!Number.isInteger(index) || index < 0) return new Response("Bad page index", { status: 400 });
        if (session === null) return new Response("No book is open", { status: 404 });
        const page = session.pages[index];
        if (page === undefined) return new Response("Page out of range", { status: 404 });
        try {
          const { mimeForPage } = await reader();
          const bytes = await session.readPage(index);
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-type": mimeForPage(page),
              "content-length": String(bytes.length),
              // Re-reading a page should not mean re-reading the archive.
              "cache-control": "private, max-age=300",
            },
          });
        } catch (error) {
          return new Response(`Page could not be read: ${error.message}`, { status: 500 });
        }
      }

      const vendored = requested.startsWith(VENDOR_PREFIX);
      const root = vendored ? vendorRoot : appRoot;
      const absolute = resolve(root, vendored ? requested.slice(VENDOR_PREFIX.length) : requested);
      const withinRoot = relative(root, absolute);
      if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const bytes = await readFile(absolute);
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": STATIC_MIME.get(extname(absolute).toLowerCase()) ?? "application/octet-stream",
            "cache-control": "no-cache",
          },
        });
      } catch {
        return new Response(`Not found: ${requested}`, { status: 404 });
      }
    }

    // Everything the viewer loads lives on one origin.
    return new Response(`Unknown PageForge resource: ${url.hostname}`, { status: 404 });
  });
};

const registerIpc = () => {
  ipcMain.handle("dialog:open-files", () => openWithDialog("file"));
  ipcMain.handle("dialog:open-folder", () => openWithDialog("folder"));
  ipcMain.handle("book:open", async (_event, targetPath) => {
    try {
      return { ok: true, book: await loadTarget(targetPath) };
    } catch (error) {
      return { ok: false, error: friendlyError(error) };
    }
  });
  ipcMain.handle("book:get", () => (session === null ? null : bookPayload(session)));
  ipcMain.handle("book:close", async () => {
    await closeSession();
    return true;
  });
  ipcMain.handle("window:toggle-fullscreen", () =>
    setFullScreen(mainWindow !== null && !mainWindow.isFullScreen()),
  );
  /**
   * Set an explicit state rather than inferring it.
   *
   * Windows applies a full-screen change asynchronously, so `isFullScreen()`
   * immediately after a request still reports the old value. A caller that
   * decides whether to act by reading it back can therefore do nothing and
   * leave the window in the state it was trying to leave.
   */
  ipcMain.handle("window:set-fullscreen", (_event, value) => setFullScreen(value === true));
  ipcMain.handle(
    "window:is-fullscreen",
    () => mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFullScreen(),
  );
  ipcMain.handle("shell:open-external", (_event, url) => shell.openExternal(url));
  // The viewer applies this itself, before it reports readiness, so an
  // automated run measures the state after the command rather than before it.
  ipcMain.handle("app:startup-command", () => startupCommands);

  ipcMain.handle("library:get", async () => {
    const store = await ensureLibrary();
    const targetPath = currentTargetPath();
    return {
      preferences: store.preferences(),
      history: store.history(),
      bookmarks: targetPath === null || targetPath === undefined ? [] : store.bookmarks(targetPath),
      bookSettings:
        targetPath === null || targetPath === undefined ? {} : store.bookSettings(targetPath),
      loadProblem: store.loadProblem,
    };
  });
  ipcMain.handle("library:book-settings:set", async (_event, targetPath, settings) => {
    const store = await ensureLibrary();
    return store.setBookSettings(targetPath, settings);
  });
  ipcMain.handle("library:progress", async (_event, targetPath, page) => {
    const store = await ensureLibrary();
    return store.recordProgress(targetPath, page);
  });
  ipcMain.handle("library:bookmark:add", async (_event, targetPath, page, name) => {
    const store = await ensureLibrary();
    return store.addBookmark(targetPath, page, name);
  });
  ipcMain.handle("library:bookmark:remove", async (_event, id) => {
    const store = await ensureLibrary();
    return store.removeBookmark(id);
  });
  ipcMain.handle("shortcuts:get", async () => {
    const store = await ensureLibrary();
    return store.shortcuts();
  });
  ipcMain.handle("shortcuts:set", async (_event, command, slot, keyString) => {
    const store = await ensureLibrary();
    return store.setShortcut(command, slot, keyString);
  });
  ipcMain.handle("shortcuts:reset", async () => {
    const store = await ensureLibrary();
    return store.resetShortcuts();
  });
  ipcMain.handle("library:history:clear", async () => {
    const store = await ensureLibrary();
    await store.clearHistory();
    return true;
  });
  ipcMain.handle("library:preference:set", async (_event, key, value) => {
    const preferences = await applyPreference(key, value);
    return preferences;
  });
  ipcMain.handle("library:open", async (_event, targetPath) => {
    try {
      return { ok: true, book: await loadTarget(targetPath) };
    } catch (error) {
      return { ok: false, error: friendlyError(error) };
    }
  });
  ipcMain.on("app:ready", async (_event, payload) => {
    if (smokeReported) return;
    if (isSmokeRun) {
      smokeReported = true;
      await emitReport({ smoke: "ok", ...payload });
      await exitCleanly(0);
      return;
    }
    if (capturePath !== null) {
      smokeReported = true;
      try {
        await takeCapture();
        await exitCleanly(0);
      } catch (error) {
        await emitReport({ capture: capturePath, error: friendlyError(error) });
        await exitCleanly(1);
      }
    }
  });
  ipcMain.on("app:renderer-error", async (_event, payload) => {
    if (!isSmokeRun) return;
    await emitReport({ smoke: "error", ...payload });
    await exitCleanly(1);
  });
};

app.whenReady().then(async () => {
  handleProtocol();
  registerIpc();
  const store = await ensureLibrary();
  Menu.setApplicationMenu(buildMenu(store.preferences()));
  await createWindow();

  const target = positionalTarget();
  if (target !== undefined) {
    try {
      const book = await loadTarget(target);
      send("app:book-opened", book);
    } catch (error) {
      send("app:book-failed", friendlyError(error));
    }
  } else if (isSmokeRun) {
    send("app:renderer-error", { message: "A smoke run needs a target path." });
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  void closeSession();
  // Library writes are queued; give the last one a chance to land.
  if (library !== null) app.once("will-quit", () => void library.flush());
});

if (isSmokeRun) {
  setTimeout(async () => {
    await emitReport({ smoke: "timeout" });
    await exitCleanly(2);
  }, 30_000);
}
