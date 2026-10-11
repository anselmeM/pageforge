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
  /** Colour handling: off, estimated from each page, or the manual settings. */
  colorMode: "off",
  /** How strongly an estimated white balance is applied, 0 to 1. */
  colorSensitivity: 1,
  /** Gamma applied to every channel. */
  gamma: 1,
  /** Saturation boost, 0 to 1. */
  vibrance: 0,
  /** How pages are scaled down to the window. */
  resampling: "linear",  /** Neighbouring pages decoded ahead of the reader; 0 disables prefetching. */
  prefetchPages: 4,
  /** Show the magnifier lens while the pointer is over a page. */
  magnifierVisible: false,
  /** Lens size in pixels. */
  magnifierSize: 180,
  /** How much the lens magnifies. */
  magnifierFactor: 3,
  /** Seconds each page is shown during a slideshow. */
  slideshowSeconds: 5,
  /** Keep the toolbar on screen while in full screen. */
  toolbarInFullscreen: false,
};

/**
 * Accepted values for each preference. Used both when loading a file that may
 * have been edited by hand and when a caller sets a value, so there is one
 * definition of what a preference may be.
 */
export const PREFERENCE_RULES = {
  resumeLastPage: { type: "boolean" },
  showThumbnails: { type: "boolean" },
  colorMode: { type: "enum", values: ["off", "auto", "manual"] },
  colorSensitivity: { type: "number", min: 0, max: 1 },
  gamma: { type: "number", min: 0.3, max: 3 },
  vibrance: { type: "number", min: 0, max: 1 },
  // "high" is the browser's high-quality downscale. It is not a Lanczos kernel,
  // so it is not named after one.
  resampling: { type: "enum", values: ["nearest", "linear", "high"] },
  prefetchPages: { type: "number", min: 0, max: 16, integer: true },
  magnifierVisible: { type: "boolean" },
  magnifierSize: { type: "number", min: 60, max: 320, integer: true },
  magnifierFactor: { type: "number", min: 1.5, max: 6 },
  slideshowSeconds: { type: "number", min: 1, max: 120, integer: true },
  toolbarInFullscreen: { type: "boolean" },
};

/**
 * Coerce one preference value, or return undefined when it is unusable.
 * Numbers are clamped to their range and enums must be a known value, so a
 * hand-edited library file cannot put the reader into an invalid state.
 */
export const coercePreference = (key, value) => {
  const rule = PREFERENCE_RULES[key];
  if (rule === undefined) return undefined;
  if (rule.type === "boolean") return typeof value === "boolean" ? value : undefined;
  if (rule.type === "enum") return rule.values.includes(value) ? value : undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const clamped = Math.min(rule.max, Math.max(rule.min, value));
  return rule.integer === true ? Math.round(clamped) : clamped;
};

/** Defaults with every usable value from `value` layered on top. */
export const normalizePreferences = (value) => {
  const preferences = { ...DEFAULT_PREFERENCES };
  if (value === null || typeof value !== "object") return preferences;
  for (const key of Object.keys(DEFAULT_PREFERENCES)) {
    const coerced = coercePreference(key, value[key]);
    if (coerced !== undefined) preferences[key] = coerced;
  }
  return preferences;
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
