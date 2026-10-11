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

const isSmokeRun = process.argv.includes("--smoke");
let smokeReported = false;

/** `--capture=<file>` writes a PNG of the rendered window and exits. */
const captureArgument = process.argv.find((argument) => argument.startsWith("--capture="));
const capturePath = captureArgument === undefined ? null : captureArgument.slice("--capture=".length);
const captureCommandArgument = process.argv.find((argument) => argument.startsWith("--capture-command="));
const captureCommand =
  captureCommandArgument === undefined ? null : captureCommandArgument.slice("--capture-command=".length);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const takeCapture = async () => {
  if (captureCommand !== null) {
    send("app:command", captureCommand);
    await delay(600);
  }
  // One extra frame after the last layout so the capture is not taken mid-paint.
  await delay(700);
  const image = await mainWindow.webContents.capturePage();
  await writeFile(capturePath, image.toPNG());
  process.stdout.write(`${JSON.stringify({ capture: capturePath, command: captureCommand })}\n`);
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
    url: `pageforge://page/${index}`,
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
  if (PDF_EXTENSIONS.has(extname(targetPath).toLowerCase())) return loadDocument(targetPath);
  const { openTarget } = await reader();
  const opened = await openTarget(targetPath);
  session = opened;
  return bookPayload(opened);
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
 * and the F11 accelerator all funnel through here, so the checkbox and the
 * window can never disagree.
 */
const setFullScreen = (value) => {
  if (mainWindow === null || mainWindow.isDestroyed()) return false;
  mainWindow.setFullScreen(value);
  const item = Menu.getApplicationMenu()?.getMenuItemById("full-screen");
  if (item !== undefined && item !== null) item.checked = value;
  send("app:fullscreen", value);
  return value;
};

const buildMenu = () =>
  Menu.buildFromTemplate([
    {
      label: "&File",
      submenu: [
        { label: "Open Comic…", accelerator: "CmdOrCtrl+O", click: () => send("app:command", "open-file") },
        { label: "Open Folder…", accelerator: "CmdOrCtrl+Shift+O", click: () => send("app:command", "open-folder") },
        { type: "separator" },
        { label: "Close Book", accelerator: "CmdOrCtrl+W", click: () => send("app:command", "close-book") },
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
      label: "&View",
      submenu: [
        {
          id: "full-screen",
          label: "Full Screen",
          type: "checkbox",
          accelerator: "F11",
          click: (item) => setFullScreen(item.checked),
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
      ],
    },
    {
      label: "&Help",
      submenu: [
        { label: "Keyboard Shortcuts", click: () => send("app:command", "show-help") },
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
  mainWindow.once("ready-to-show", () => mainWindow.show());
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

    if (url.hostname !== "page") return new Response("Unknown PageForge resource", { status: 404 });
    const index = Number(url.pathname.replace(/^\//u, ""));
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
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return new Response(`Page could not be read: ${error.message}`, { status: 500 });
    }
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
  ipcMain.handle(
    "window:is-fullscreen",
    () => mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFullScreen(),
  );
  ipcMain.handle("shell:open-external", (_event, url) => shell.openExternal(url));
  ipcMain.on("app:ready", async (_event, payload) => {
    if (smokeReported) return;
    if (isSmokeRun) {
      smokeReported = true;
      process.stdout.write(`${JSON.stringify({ smoke: "ok", ...payload })}\n`);
      app.exit(0);
      return;
    }
    if (capturePath !== null) {
      smokeReported = true;
      try {
        await takeCapture();
        app.exit(0);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ capture: capturePath, error: friendlyError(error) })}\n`);
        app.exit(1);
      }
    }
  });
  ipcMain.on("app:renderer-error", (_event, payload) => {
    if (!isSmokeRun) return;
    process.stdout.write(`${JSON.stringify({ smoke: "error", ...payload })}\n`);
    app.exit(1);
  });
};

app.whenReady().then(async () => {
  handleProtocol();
  registerIpc();
  Menu.setApplicationMenu(buildMenu());
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
  void closeSession();
});

if (isSmokeRun) {
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ smoke: "timeout" })}\n`);
    app.exit(2);
  }, 30_000);
}
