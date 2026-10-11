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
  /** The currently open book, or null. */
  getBook: () => ipcRenderer.invoke("book:get"),
  /** Close the open book and release its file handle. */
  closeBook: () => ipcRenderer.invoke("book:close"),
  /** Toggle window full screen; resolves with the resulting state. */
  toggleFullscreen: () => ipcRenderer.invoke("window:toggle-fullscreen"),
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
    const allowed = ["app:book-opened", "app:book-failed", "app:fullscreen"];
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
