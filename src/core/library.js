/**
 * Library rules: how a book's saved position is resolved, how the recent list
 * is kept in order and bounded, and how paths become stable keys.
 *
 * Kept free of filesystem and Electron access so the rules can be tested
 * directly. The store in `src/main/store.js` owns persistence.
 */

import { normalizeAchievementState } from "./achievements.js";

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
  /** Step through detected panels one at a time instead of whole pages. */
  guidedView: false,
  /** How much of the viewport a guided panel should occupy, 0.5 to 1. */
  guidedFill: 0.92,
  /** Camera travel time between panels, in milliseconds. */
  guidedPanMs: 350,
  /** Easing for the guided camera. */
  guidedEasing: "ease-out",
  /** Dim everything outside the focused panel. */
  guidedSpotlight: true,
  /** Read as one continuous vertical column instead of page by page. */
  verticalScroll: false,
  /** In vertical mode, stack the page's panels rather than whole pages. */
  panelStrip: true,
  /** Brightness multiplier for the scan-enhancement stage. */
  brightness: 1,
  /** Contrast multiplier for the scan-enhancement stage. */
  contrast: 1,
  /** How much colour to remove, 0 to 1. */
  grayscale: 0,
  /** How much sepia to apply, 0 to 1. */
  sepia: 0,
  /** Sharpen scanned pages. */
  sharpen: false,
  /** Sharpen strength, 0 to 1. */
  sharpenAmount: 0.35,
  /** Remember reading mode and layout per book. */
  rememberPerBook: true,
  /** Send crash reports, off unless the reader opts in. */
  crashReporting: false,
  /** Where crash reports go; empty means there is nowhere to send them. */
  crashReportingDsn: "",
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
  guidedView: { type: "boolean" },
  guidedFill: { type: "number", min: 0.5, max: 1 },
  guidedPanMs: { type: "number", min: 0, max: 1500, integer: true },
  guidedEasing: { type: "enum", values: ["linear", "ease-in", "ease-out", "ease-in-out"] },
  guidedSpotlight: { type: "boolean" },
  verticalScroll: { type: "boolean" },
  panelStrip: { type: "boolean" },
  brightness: { type: "number", min: 0.5, max: 2 },
  contrast: { type: "number", min: 0.5, max: 2 },
  grayscale: { type: "number", min: 0, max: 1 },
  sepia: { type: "number", min: 0, max: 1 },
  sharpen: { type: "boolean" },
  sharpenAmount: { type: "number", min: 0, max: 1 },
  rememberPerBook: { type: "boolean" },
  crashReporting: { type: "boolean" },
  crashReportingDsn: { type: "string", maxLength: 512 },
};

/**
 * Coerce one value against a rule, or return undefined when it is unusable.
 * Numbers are clamped to their range and enums must be a known value.
 */
const coerceWithRule = (rule, value) => {
  if (rule === undefined) return undefined;
  if (rule.type === "boolean") return typeof value === "boolean" ? value : undefined;
  if (rule.type === "enum") return rule.values.includes(value) ? value : undefined;
  if (rule.type === "string") {
    if (typeof value !== "string") return undefined;
    return value.length > rule.maxLength ? value.slice(0, rule.maxLength) : value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const clamped = Math.min(rule.max, Math.max(rule.min, value));
  return rule.integer === true ? Math.round(clamped) : clamped;
};

/**
 * Coerce one preference value, or return undefined when it is unusable.
 * Numbers are clamped to their range and enums must be a known value, so a
 * hand-edited library file cannot put the reader into an invalid state.
 */
export const coercePreference = (key, value) => coerceWithRule(PREFERENCE_RULES[key], value);

/**
 * Layout the reader remembers *per book* rather than globally: a manga volume
 * should open right-to-left whatever the last book was.
 */
export const BOOK_SETTING_RULES = {
  doublePage: { type: "boolean" },
  rightToLeft: { type: "boolean" },
  guidedView: { type: "boolean" },
  verticalScroll: { type: "boolean" },
  fitMode: { type: "enum", values: ["screen", "width", "height", "original", "manual"] },
  rotation: { type: "number", min: 0, max: 359, integer: true },
};

/** Layout for one book, keeping only the fields that are usable. */
export const normalizeBookSettings = (value) => {
  const settings = {};
  if (value === null || typeof value !== "object") return settings;
  for (const [key, rule] of Object.entries(BOOK_SETTING_RULES)) {
    const coerced = coerceWithRule(rule, value[key]);
    if (coerced !== undefined) settings[key] = coerced;
  }
  return settings;
};

/** Per-book layout for books no longer remembered is dropped with them. */
export const pruneBookSettings = (bookSettings, history) => {
  const known = new Set(history.map((item) => item.pathKey));
  return Object.fromEntries(Object.entries(bookSettings).filter(([pathKey]) => known.has(pathKey)));
};

/** The shape this file writes, so an import can be recognised rather than guessed at. */
export const EXPORT_FORMAT = "pageforge-library";
export const EXPORT_VERSION = 1;

/** One history entry, keeping only what makes sense and never throwing. */
export const normalizeHistoryEntry = (value) => {
  if (value === null || typeof value !== "object") return null;
  if (typeof value.pathKey !== "string" || value.pathKey.length === 0) return null;
  const page = Number.isInteger(value.lastPage) && value.lastPage >= 1 ? value.lastPage : 1;
  const pages = Number.isInteger(value.pages) && value.pages >= 0 ? value.pages : 0;
  return {
    pathKey: value.pathKey,
    path: typeof value.path === "string" ? value.path : value.pathKey,
    displayName: typeof value.displayName === "string" ? value.displayName : value.pathKey,
    kind: typeof value.kind === "string" ? value.kind : "archive",
    pages,
    lastPage: page,
    openedAt: typeof value.openedAt === "string" ? value.openedAt : null,
    readAt: typeof value.readAt === "string" ? value.readAt : null,
    // Series metadata is what lets the recent list group books, so it is kept.
    series: typeof value.series === "string" && value.series.length > 0 ? value.series : null,
    number: typeof value.number === "string" && value.number.length > 0 ? value.number : null,
  };
};

/** The document written by Export. */
export const buildLibraryExport = ({ history, bookmarks = {}, bookSettings = {}, achievements = null, preferences = null }, { at, appVersion } = {}) => ({
  format: EXPORT_FORMAT,
  version: EXPORT_VERSION,
  exportedAt: typeof at === "string" ? at : new Date().toISOString(),
  app: typeof appVersion === "string" ? appVersion : null,
  history: (Array.isArray(history) ? history : []).map(normalizeHistoryEntry).filter(Boolean),
  bookmarks,
  bookSettings,
  achievements,
  // Carried for reference. Import deliberately does not apply these: silently
  // changing how someone's reader behaves is not what "import my books" means.
  preferences,
});

/** Later of two timestamps, treating a missing one as older than any real one. */
const newerStamp = (a, b) => {
  if (typeof a !== "string") return typeof b === "string" ? b : null;
  if (typeof b !== "string") return a;
  return a >= b ? a : b;
};

const bookmarkKey = (bookmark) => `${bookmark.page}\u0000${bookmark.name}`;

/**
 * Merge an imported library into the current one.
 *
 * The rules are chosen to be predictable and lossless where it matters:
 * a book keeps the position from whichever copy was read most recently; bookmarks
 * are unioned; per-book layout from the file only fills books that have none here
 * (the layout you are using now is the more relevant one); and achievement counters
 * take the larger value so importing can never reduce what has been earned.
 *
 * @returns {{library: object, report: object}} the merged values and what changed
 */
export const mergeLibraryImport = (current, imported) => {
  const report = {
    historyAdded: 0,
    historyUpdated: 0,
    bookmarksAdded: 0,
    booksFinishedAdded: 0,
    daysAdded: 0,
  };
  if (imported === null || typeof imported !== "object" || imported.format !== EXPORT_FORMAT) {
    return { library: null, report, unrecognised: true };
  }

  const byPathKey = new Map((current.history ?? []).map((entry) => [entry.pathKey, { ...entry }]));
  for (const raw of Array.isArray(imported.history) ? imported.history : []) {
    const entry = normalizeHistoryEntry(raw);
    if (entry === null) continue;
    const existing = byPathKey.get(entry.pathKey);
    if (existing === undefined) {
      byPathKey.set(entry.pathKey, entry);
      report.historyAdded += 1;
      continue;
    }
    const existingStamp = existing.readAt ?? existing.openedAt;
    const incomingStamp = entry.readAt ?? entry.openedAt;
    const merged = {
      ...existing,
      // Whichever was read most recently decides where the book opens.
      lastPage: newerStamp(existingStamp, incomingStamp) === incomingStamp ? entry.lastPage : existing.lastPage,
      pages: Math.max(existing.pages ?? 0, entry.pages ?? 0),
      series: existing.series ?? entry.series,
      number: existing.number ?? entry.number,
      openedAt: newerStamp(existing.openedAt, entry.openedAt),
      readAt: newerStamp(existing.readAt, entry.readAt),
    };
    if (JSON.stringify(merged) !== JSON.stringify(existing)) report.historyUpdated += 1;
    byPathKey.set(entry.pathKey, merged);
  }
  const history = [...byPathKey.values()].sort(
    (a, b) => (newerStamp(a.openedAt, b.openedAt) === a.openedAt ? -1 : 1),
  );

  const bookmarks = {};
  for (const [pathKey, list] of Object.entries(current.bookmarks ?? {})) {
    bookmarks[pathKey] = [...list];
  }
  for (const [pathKey, list] of Object.entries(imported.bookmarks ?? {})) {
    if (!Array.isArray(list)) continue;
    const existing = bookmarks[pathKey] ?? [];
    const seen = new Set(existing.map(bookmarkKey));
    for (const bookmark of list) {
      if (bookmark === null || typeof bookmark !== "object") continue;
      if (!Number.isInteger(bookmark.page) || typeof bookmark.id !== "string") continue;
      const name = typeof bookmark.name === "string" && bookmark.name.length > 0 ? bookmark.name : `Page ${bookmark.page}`;
      const candidate = { ...bookmark, name };
      if (seen.has(bookmarkKey(candidate))) continue;
      seen.add(bookmarkKey(candidate));
      existing.push(candidate);
      report.bookmarksAdded += 1;
    }
    if (existing.length > 0) bookmarks[pathKey] = existing;
  }

  // Layout already chosen on this machine wins; the file only fills the gaps.
  const bookSettings = { ...(imported.bookSettings ?? {}) };
  for (const [pathKey, settings] of Object.entries(current.bookSettings ?? {})) {
    bookSettings[pathKey] = settings;
  }

  const before = normalizeAchievementState(current.achievements);
  const incoming = normalizeAchievementState(imported.achievements);
  const finished = [...before.finished];
  const known = new Set(finished.map((entry) => entry.pathKey));
  for (const entry of incoming.finished) {
    if (known.has(entry.pathKey)) continue;
    known.add(entry.pathKey);
    finished.push(entry);
    report.booksFinishedAdded += 1;
  }
  const openDays = [...new Set([...before.openDays, ...incoming.openDays])].sort();
  report.daysAdded = openDays.length - before.openDays.length;
  const unlocked = { ...incoming.unlocked };
  for (const [id, at] of Object.entries(before.unlocked)) {
    // Keep the earliest date an achievement was earned.
    unlocked[id] = typeof unlocked[id] === "string" && unlocked[id] < at ? unlocked[id] : at;
  }
  const achievements = normalizeAchievementState({
    // Counters take the larger value so an import can never reduce what was earned.
    pagesTurned: Math.max(before.pagesTurned, incoming.pagesTurned),
    finished,
    openDays,
    nightReading: before.nightReading || incoming.nightReading,
    unlocked,
  });

  return { library: { history, bookmarks, bookSettings, achievements }, report, unrecognised: false };
};

/**
 * Group remembered books by the series their ComicInfo declared.
 *
 * Books without metadata stay in a separate loose list rather than being gathered
 * under a made-up heading.
 */
export const groupHistoryBySeries = (history) => {
  const series = new Map();
  const loose = [];
  for (const entry of history ?? []) {
    if (typeof entry?.series !== "string" || entry.series.length === 0) {
      loose.push(entry);
      continue;
    }
    if (!series.has(entry.series)) series.set(entry.series, []);
    series.get(entry.series).push(entry);
  }
  const groups = [...series.entries()].map(([name, entries]) => ({
    name,
    entries: [...entries].sort((a, b) => {
      const left = Number.parseFloat(a.number ?? "");
      const right = Number.parseFloat(b.number ?? "");
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
      return String(a.displayName).localeCompare(String(b.displayName));
    }),
  }));
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return { groups, loose };
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
