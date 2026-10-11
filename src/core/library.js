/**
 * Library rules: how a book's saved position is resolved, how the recent list
 * is kept in order and bounded, and how paths become stable keys.
 *
 * Kept free of filesystem and Electron access so the rules can be tested
 * directly. The store in `src/main/store.js` owns persistence.
 */

/** How many books the recent list remembers. */
export const HISTORY_LIMIT = 50;

/** Default preferences, and the full set of keys the app understands. */
export const DEFAULT_PREFERENCES = {
  /** Reopen a book at the page it was last left on. */
  resumeLastPage: true,
  /** Show the page thumbnail strip. */
  showThumbnails: false,
};

/**
 * Stable key for a book, from an absolute path.
 *
 * Windows paths are case-insensitive and may arrive with either separator, so
 * they are folded to lower case with forward slashes. A book that is moved or
 * renamed is treated as a new book, which is the honest outcome: the store
 * cannot tell a move from a different file without hashing every book on open.
 */
export const normalizePathKey = (targetPath, platform = process.platform) => {
  const unified = targetPath.replace(/[\\/]+/gu, "/");
  return platform === "win32" ? unified.toLowerCase() : unified;
};

/** The page a book should open at, given its history entry and preferences. */
export const resolveStartPage = (entry, pageCount, preferences = DEFAULT_PREFERENCES) => {
  const total = Math.max(1, Math.floor(pageCount));
  if (preferences?.resumeLastPage !== true) return 1;
  const last = entry?.lastPage;
  if (!Number.isInteger(last) || last < 1) return 1;
  return Math.min(last, total);
};

/** Move a book to the front of the recent list, dropping any previous entry. */
export const upsertHistory = (history, entry, limit = HISTORY_LIMIT) => [
  entry,
  ...history.filter((item) => item.pathKey !== entry.pathKey),
].slice(0, limit);

/** Bookmarks for books that are no longer remembered are dropped with them. */
export const pruneBookmarks = (bookmarks, history) => {
  const known = new Set(history.map((item) => item.pathKey));
  return Object.fromEntries(Object.entries(bookmarks).filter(([pathKey]) => known.has(pathKey)));
};

/** Newest bookmark for a book at a page, or undefined. */
export const findBookmarkAtPage = (bookmarks, pathKey, page) =>
  (bookmarks[pathKey] ?? []).find((bookmark) => bookmark.page === page);

/** Bookmarks for one book, in page order. */
export const bookmarksFor = (bookmarks, pathKey) =>
  [...(bookmarks[pathKey] ?? [])].sort((a, b) => a.page - b.page);

/** One-line description of a history entry, for the recent list. */
export const describeHistoryEntry = (entry) =>
  entry.pages > 0 ? `${entry.pages} page${entry.pages === 1 ? "" : "s"}` : "unread";
