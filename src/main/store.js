/**
 * Persistent library: recent books, per-book bookmarks, and preferences.
 *
 * One JSON document under the app's user-data directory. Writes are atomic
 * (temp file plus rename) and serialised, so a crash mid-write cannot leave a
 * half-written library behind. A corrupt file is preserved under a new name and
 * reported rather than silently discarded, because it is the only copy of the
 * user's bookmarks.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_PREFERENCES,
  bookmarksFor,
  coercePreference,
  normalizeBookSettings,
  normalizePreferences,
  normalizePathKey,
  pruneBookSettings,
  pruneBookmarks,
  upsertHistory,
} from "../core/library.js";
import {
  achievementSummary as buildAchievementSummary,
  evaluateAchievements,
  localDayKey,
  normalizeAchievementState,
  recordActivity as foldActivity,
} from "../core/achievements.js";
import { DEFAULT_SHORTCUTS, REBINDABLE_COMMANDS, normalizeShortcuts, withShortcut } from "../core/shortcuts.js";

const FILE_NAME = "library.json";

const emptyLibrary = () => ({
  version: 1,
  preferences: { ...DEFAULT_PREFERENCES },
  shortcuts: { ...DEFAULT_SHORTCUTS },
  history: [],
  bookmarks: {},
  bookSettings: {},
  achievements: normalizeAchievementState(null),
});

/** Accept only the shapes this module writes; anything else falls back. */
const sanitize = (value) => {
  const library = emptyLibrary();
  if (value === null || typeof value !== "object") return library;
  if (value.preferences !== null && typeof value.preferences === "object") {
    library.preferences = normalizePreferences(value.preferences);
  }
  if (value.shortcuts !== null && typeof value.shortcuts === "object") {
    library.shortcuts = normalizeShortcuts(value.shortcuts);
  }
  if (Array.isArray(value.history)) {
    library.history = value.history.filter(
      (item) => item !== null && typeof item === "object" && typeof item.pathKey === "string",
    );
  }
  if (value.bookmarks !== null && typeof value.bookmarks === "object") {
    for (const [pathKey, list] of Object.entries(value.bookmarks)) {
      if (!Array.isArray(list)) continue;
      const bookmarks = list.filter(
        (bookmark) =>
          bookmark !== null &&
          typeof bookmark === "object" &&
          typeof bookmark.id === "string" &&
          Number.isInteger(bookmark.page),
      );
      if (bookmarks.length > 0) library.bookmarks[pathKey] = bookmarks;
    }
  }
  if (value.bookSettings !== null && typeof value.bookSettings === "object") {
    for (const [pathKey, settings] of Object.entries(value.bookSettings)) {
      const normalized = normalizeBookSettings(settings);
      if (Object.keys(normalized).length > 0) library.bookSettings[pathKey] = normalized;
    }
  }
  library.achievements = normalizeAchievementState(value.achievements);
  return library;
};

/**
 * @param {{directory: string}} options
 * @returns {Promise<object>} the store API
 */
export const createStore = async ({ directory }) => {
  const file = join(directory, FILE_NAME);
  await mkdir(directory, { recursive: true });

  let library = emptyLibrary();
  /** Set when the previous contents could not be read, so callers can report it. */
  let loadProblem = null;

  try {
    library = sanitize(JSON.parse(await readFile(file, "utf8")));
  } catch (cause) {
    if (cause?.code !== "ENOENT") {
      const preserved = `${file}.corrupt-${Date.now()}`;
      try {
        await rename(file, preserved);
        loadProblem = `Library file could not be read (${cause.message}); the previous file was kept at ${preserved}.`;
      } catch (renameError) {
        loadProblem = `Library file could not be read (${cause.message}) and could not be preserved: ${renameError.message}.`;
      }
    }
  }

  let queue = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(library, null, 2);
    queue = queue.then(async () => {
      const temporary = `${file}.tmp-${process.pid}`;
      await writeFile(temporary, snapshot, "utf8");
      await rename(temporary, file);
    });
    return queue;
  };

  const entryFor = (pathKey) => library.history.find((item) => item.pathKey === pathKey);

  /** Update the stored position in memory, without writing. Returns whether it moved. */
  const applyProgress = (targetPath, page) => {
    const pathKey = normalizePathKey(targetPath);
    const entry = entryFor(pathKey);
    if (entry === undefined || !Number.isInteger(page) || page < 1) return false;
    if (entry.lastPage === page) return false;
    entry.lastPage = page;
    entry.readAt = new Date().toISOString();
    return true;
  };

  return {
    loadProblem,
    filePath: file,

    snapshot() {
      return structuredClone(library);
    },

    preferences() {
      return { ...library.preferences };
    },

    history() {
      return structuredClone(library.history);
    },

    /**
     * Bookmarks for a book, in page order. Takes a path like every other
     * method and normalises it, so callers never have to know the key format.
     */
    bookmarks(targetPath) {
      return bookmarksFor(library.bookmarks, normalizePathKey(targetPath));
    },

    /** Remember an opened book without losing where the reader had got to. */
    async recordOpen({ targetPath, displayName, kind, pages = 0 }) {
      const pathKey = normalizePathKey(targetPath);
      const previous = entryFor(pathKey);
      const entry = {
        pathKey,
        path: targetPath,
        displayName,
        kind,
        pages,
        lastPage: previous?.lastPage ?? 1,
        openedAt: new Date().toISOString(),
      };
      library.history = upsertHistory(library.history, entry);
      library.bookmarks = pruneBookmarks(library.bookmarks, library.history);
      library.bookSettings = pruneBookSettings(library.bookSettings, library.history);
      await persist();
      return structuredClone(entry);
    },

    /** Record reading position. The page is clamped when the book is reopened. */
    async recordProgress(targetPath, page) {
      const changed = applyProgress(targetPath, page);
      if (changed) await persist();
      return changed;
    },

    /**
     * Layout remembered for a book, or {} when it has none.
     *
     * A manga volume should open right-to-left whatever the last book was, so
     * this is per book rather than part of the global preferences.
     */
    bookSettings(targetPath) {
      return { ...(library.bookSettings[normalizePathKey(targetPath)] ?? {}) };
    },

    /** Merge layout for a book, dropping anything unrecognised. */
    async setBookSettings(targetPath, settings) {
      const pathKey = normalizePathKey(targetPath);
      const merged = normalizeBookSettings({ ...library.bookSettings[pathKey], ...settings });
      if (Object.keys(merged).length === 0) delete library.bookSettings[pathKey];
      else library.bookSettings[pathKey] = merged;
      await persist();
      return { ...merged };
    },

    /**
     * Record a page turn and fold it into the achievements, in one write.
     *
     * The two belong together: every page turn is what the achievements are made
     * of, so persisting them separately would mean two atomic rewrites of the
     * same file for every page the reader turns.
     *
     * @returns {{changed: boolean, unlocked: Array<{id: string, title: string, description: string}>}}
     */
    async recordReading({ targetPath, page, total = 0, at = new Date().toISOString() }) {
      const changed = applyProgress(targetPath, page);
      const next = foldActivity(library.achievements, {
        pathKey: normalizePathKey(targetPath),
        page,
        total,
        dayKey: localDayKey(new Date(at)),
        hour: new Date(at).getHours(),
        at,
      });
      const evaluated = evaluateAchievements(next, {
        distinctBooks: library.history.length,
        todayKey: localDayKey(new Date(at)),
        at,
      });
      library.achievements = evaluated.state;
      await persist();
      return { changed, unlocked: evaluated.unlockedNow };
    },

    /** Everything the achievements dialog needs. */
    achievementSummary() {
      return buildAchievementSummary(library.achievements, {
        distinctBooks: library.history.length,
        todayKey: localDayKey(new Date()),
      });
    },

    /** Start the achievements over. Reading history is left alone. */
    async resetAchievements() {
      library.achievements = normalizeAchievementState(null);
      await persist();
      return true;
    },

    async addBookmark(targetPath, page, name) {
      const pathKey = normalizePathKey(targetPath);
      const bookmark = {
        id: randomUUID(),
        page,
        name: name?.trim() === "" || name === undefined ? `Page ${page}` : name.trim(),
        createdAt: new Date().toISOString(),
      };
      library.bookmarks[pathKey] = [...(library.bookmarks[pathKey] ?? []), bookmark];
      await persist();
      return structuredClone(bookmark);
    },

    async removeBookmark(id) {
      let removed = false;
      for (const [pathKey, list] of Object.entries(library.bookmarks)) {
        const remaining = list.filter((bookmark) => bookmark.id !== id);
        if (remaining.length === list.length) continue;
        removed = true;
        if (remaining.length === 0) delete library.bookmarks[pathKey];
        else library.bookmarks[pathKey] = remaining;
      }
      if (removed) await persist();
      return removed;
    },

    async clearHistory() {
      library.history = [];
      library.bookmarks = {};
      await persist();
    },

    async setPreference(key, value) {
      if (!(key in DEFAULT_PREFERENCES)) throw new Error(`Unknown preference: ${key}`);
      const coerced = coercePreference(key, value);
      if (coerced === undefined) {
        throw new Error(`Invalid value for preference ${key}: ${JSON.stringify(value)}`);
      }
      library.preferences[key] = coerced;
      await persist();
      return { ...library.preferences };
    },

    /** Current key bindings, with defaults filled in for anything unset. */
    shortcuts() {
      return normalizeShortcuts(library.shortcuts);
    },

    /** Bind one slot of one command; a null key clears it. */
    async setShortcut(command, slot, keyString) {
      if (!REBINDABLE_COMMANDS.includes(command)) throw new Error(`Unknown command: ${command}`);
      if (slot !== "primary" && slot !== "secondary") throw new Error(`Unknown slot: ${slot}`);
      library.shortcuts = withShortcut(normalizeShortcuts(library.shortcuts), command, slot, keyString);
      await persist();
      return normalizeShortcuts(library.shortcuts);
    },

    async resetShortcuts() {
      library.shortcuts = { ...DEFAULT_SHORTCUTS };
      await persist();
      return normalizeShortcuts(library.shortcuts);
    },

    async flush() {
      await queue;
    },
  };
};
