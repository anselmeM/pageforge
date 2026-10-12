/**
 * Preload bridge. The renderer runs with context isolation and no Node access;
 * everything it can do to the host is listed here.
 */

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("pageforge", {
  /** Ask for a comic archive. Returns { canceled } or { book } or { error }. */
  openFileDialog: () => ipcRenderer.invoke("dialog:open-files"),
  /** Ask for a folder of images. Returns { canceled } or { book } or { error }. */
  openFolderDialog: () => ipcRenderer.invoke("dialog:open-folder"),
  /** Open a known absolute path. Returns { ok, book } or { ok: false, error }. */
  openBook: (targetPath) => ipcRenderer.invoke("book:open", targetPath),

  /** Preferences, recent books, and this book's bookmarks. */
  getLibrary: () => ipcRenderer.invoke("library:get"),
  /** Record the reading position. Resolves false when nothing changed. */
  setProgress: (targetPath, page) => ipcRenderer.invoke("library:progress", targetPath, page),
  /** Add a named bookmark for a page. */
  addBookmark: (targetPath, page, name) => ipcRenderer.invoke("library:bookmark:add", targetPath, page, name),
  /** Remove a bookmark by id. */
  removeBookmark: (id) => ipcRenderer.invoke("library:bookmark:remove", id),
  /** Forget every recent book and its bookmarks. */
  clearHistory: () => ipcRenderer.invoke("library:history:clear"),
  /** Remember layout for a book (reading mode, direction, fit, rotation). */
  setBookSettings: (targetPath, settings) =>
    ipcRenderer.invoke("library:book-settings:set", targetPath, settings),
  /** What the saved archive index holds. */
  cacheStats: () => ipcRenderer.invoke("cache:stats"),
  /** Forget the saved archive index; returns how many pages were dropped. */
  clearCache: () => ipcRenderer.invoke("cache:clear"),
  /** Change a preference; the main process echoes the result back. */
  setPreference: (key, value) => ipcRenderer.invoke("library:preference:set", key, value),
  /** Open a recent book by path. Returns { ok, book } or { ok: false, error }. */
  openRecent: (targetPath) => ipcRenderer.invoke("library:open", targetPath),
  /** The one-off command requested on the command line, or null. */
  getStartupCommand: () => ipcRenderer.invoke("app:startup-command"),

  /** Current key bindings. */
  getShortcuts: () => ipcRenderer.invoke("shortcuts:get"),
  /** Bind one slot of one command; a null key clears it. */
  setShortcut: (command, slot, keyString) => ipcRenderer.invoke("shortcuts:set", command, slot, keyString),
  /** Restore the default key bindings. */
  resetShortcuts: () => ipcRenderer.invoke("shortcuts:reset"),
  /** The currently open book, or null. */
  getBook: () => ipcRenderer.invoke("book:get"),
  /** Close the open book and release its file handle. */
  closeBook: () => ipcRenderer.invoke("book:close"),
  /** Toggle window full screen; resolves with the resulting state. */
  toggleFullscreen: () => ipcRenderer.invoke("window:toggle-fullscreen"),
  /** Set an exact full screen state; resolves with the resulting state. */
  setFullScreen: (value) => ipcRenderer.invoke("window:set-fullscreen", value),
  /** Current full screen state. */
  isFullscreen: () => ipcRenderer.invoke("window:is-fullscreen"),
  /** Absolute path of a File from a drop event, or "" when unavailable. */
  getPathForFile: (file) => webUtils.getPathForFile(file),
  /** Subscribe to menu commands. Returns an unsubscribe function. */
  onCommand: (handler) => {
    const listener = (_event, command) => handler(command);
    ipcRenderer.on("app:command", listener);
    return () => ipcRenderer.removeListener("app:command", listener);
  },
  /** Subscribe to a main-process push. Returns an unsubscribe function. */
  on: (channel, handler) => {
    const allowed = ["app:book-opened", "app:book-failed", "app:fullscreen", "app:preferences", "app:open-progress"];
    if (!allowed.includes(channel)) throw new Error(`Unsupported channel: ${channel}`);
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /** Tell the main process the viewer has finished its first paint. */
  reportReady: (payload) => ipcRenderer.send("app:ready", payload),
  /** Report a fatal renderer failure to the main process. */
  reportError: (payload) => ipcRenderer.send("app:renderer-error", payload),
});
