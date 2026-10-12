/**
 * The library, in SQLite.
 *
 * Why this exists rather than one JSON file: the old store held everything in
 * memory and rewrote the whole file on every change, so a page turn cost a
 * rewrite proportional to the library, and two running copies of the app would
 * each save their own version and silently discard the other's progress. A
 * database gives an O(1) update per page turn and a real lock.
 *
 * This module is written to be behaviourally identical to the JSON store: the
 * same methods, returning the same shapes, so the rules in `core/library.js`
 * remain the single source of truth and the existing store tests are the
 * regression net.
 *
 * Storage engine is Node's built-in `node:sqlite`, so there is no native module
 * and no rebuild step. It is marked experimental upstream, which is why the JSON
 * store is kept as a fallback and the JSON *reader* is kept forever: migration
 * and import both need it.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  DEFAULT_PREFERENCES,
  HISTORY_LIMIT,
  bookmarksFor,
  buildLibraryExport,
  coercePreference,
  groupHistoryBySeries,
  mergeLibraryImport,
  normalizeBookSettings,
  normalizePathKey,
  normalizePreferences,
} from "../core/library.js";
import {
  achievementSummary as buildAchievementSummary,
  evaluateAchievements,
  localDayKey,
  normalizeAchievementState,
  recordActivity as foldActivity,
} from "../core/achievements.js";
import {
  DEFAULT_SHORTCUTS,
  REBINDABLE_COMMANDS,
  normalizeShortcuts,
  withShortcut,
} from "../core/shortcuts.js";

const FILE_NAME = "pageforge.sqlite";
const MIGRATED_SUFFIX = ".migrated";
/** Two instances should wait for each other rather than fail. */
const BUSY_TIMEOUT_MS = 5000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shortcuts (
     command TEXT NOT NULL,
     slot TEXT NOT NULL,
     key TEXT,
     PRIMARY KEY (command, slot)
   )`,
  `CREATE TABLE IF NOT EXISTS books (
     path_key TEXT PRIMARY KEY,
     path TEXT NOT NULL,
     display_name TEXT NOT NULL,
     kind TEXT NOT NULL,
     pages INTEGER NOT NULL DEFAULT 0,
     last_page INTEGER NOT NULL DEFAULT 1,
     opened_at TEXT,
     read_at TEXT,
     series TEXT,
     number TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS books_recent ON books (opened_at DESC)`,
  // Deleting a book drops its bookmarks, which is exactly what pruning did.
  `CREATE TABLE IF NOT EXISTS bookmarks (
     id TEXT PRIMARY KEY,
     path_key TEXT NOT NULL REFERENCES books(path_key) ON DELETE CASCADE,
     page INTEGER NOT NULL,
     name TEXT NOT NULL,
     created_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS bookmarks_by_book ON bookmarks (path_key, page)`,
  `CREATE TABLE IF NOT EXISTS book_settings (path_key TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  // Deliberately not referenced by books: achievements must outlive a history clear.
  `CREATE TABLE IF NOT EXISTS finished_books (path_key TEXT PRIMARY KEY, pages INTEGER NOT NULL, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS reading_days (day TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS achievements (id TEXT PRIMARY KEY, unlocked_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS achievement_stats (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

const SCHEMA_VERSION = "1";

/** node:sqlite takes numbers, strings, null and bytes — never booleans. */
const asFlag = (value) => (value === true ? 1 : 0);
const asBool = (value) => value === 1 || value === true;
const text = (value) => (value === undefined || value === null ? null : String(value));

const openDatabase = (path) => {
  if (sqliteModule === null) throw new Error("node:sqlite is not available");
  const database = new sqliteModule.DatabaseSync(path);
  database.exec(`PRAGMA journal_mode = WAL`);
  database.exec(`PRAGMA synchronous = NORMAL`);
  database.exec(`PRAGMA foreign_keys = ON`);
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return database;
};

/**
 * `node:sqlite` is loaded with a real dynamic import; this is checked once so the
 * caller can fall back to the JSON store rather than failing to start.
 */
let sqliteModule = null;

export const sqliteIsAvailable = async () => {
  if (sqliteModule !== null) return true;
  try {
    const module = await import("node:sqlite");
    if (typeof module.DatabaseSync !== "function") return false;
    sqliteModule = module;
    return true;
  } catch {
    return false;
  }
};

const createSchema = (database) => {
  for (const statement of SCHEMA) database.exec(statement);
  database
    .prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)")
    .run(SCHEMA_VERSION);
};

/** Write a sanitised JSON library into an open database, inside one transaction. */
const writeLibrary = (database, library) => {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of [
      "DELETE FROM bookmarks",
      "DELETE FROM books",
      "DELETE FROM book_settings",
      "DELETE FROM finished_books",
      "DELETE FROM reading_days",
      "DELETE FROM achievements",
      "DELETE FROM achievement_stats",
      "DELETE FROM preferences",
      "DELETE FROM shortcuts",
    ]) {
      database.exec(statement);
    }

    const insertBook = database.prepare(
      "INSERT INTO books (path_key, path, display_name, kind, pages, last_page, opened_at, read_at, series, number) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const entry of library.history ?? []) {
      insertBook.run(
        entry.pathKey,
        entry.path ?? entry.pathKey,
        entry.displayName ?? entry.pathKey,
        entry.kind ?? "archive",
        Number(entry.pages ?? 0),
        Number(entry.lastPage ?? 1),
        text(entry.openedAt),
        text(entry.readAt),
        text(entry.series),
        text(entry.number),
      );
    }

    const insertBookmark = database.prepare(
      "INSERT INTO bookmarks (id, path_key, page, name, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const [pathKey, list] of Object.entries(library.bookmarks ?? {})) {
      for (const bookmark of list ?? []) {
        insertBookmark.run(
          String(bookmark.id),
          pathKey,
          Number(bookmark.page),
          String(bookmark.name),
          text(bookmark.createdAt),
        );
      }
    }

    const insertSettings = database.prepare(
      "INSERT OR REPLACE INTO book_settings (path_key, json) VALUES (?, ?)",
    );
    for (const [pathKey, settings] of Object.entries(library.bookSettings ?? {})) {
      insertSettings.run(pathKey, JSON.stringify(settings));
    }

    const achievements = normalizeAchievementState(library.achievements);
    for (const entry of achievements.finished) {
      database
        .prepare("INSERT OR REPLACE INTO finished_books (path_key, pages, at) VALUES (?, ?, ?)")
        .run(entry.pathKey, Number(entry.pages ?? 0), text(entry.at));
    }
    for (const day of achievements.openDays) {
      database.prepare("INSERT OR IGNORE INTO reading_days (day) VALUES (?)").run(day);
    }
    for (const [id, at] of Object.entries(achievements.unlocked)) {
      database.prepare("INSERT OR REPLACE INTO achievements (id, unlocked_at) VALUES (?, ?)").run(id, text(at));
    }
    for (const [key, value] of Object.entries({
      pages_turned: achievements.pagesTurned,
      night_reading: asFlag(achievements.nightReading),
    })) {
      database
        .prepare("INSERT OR REPLACE INTO achievement_stats (key, value) VALUES (?, ?)")
        .run(key, JSON.stringify(value));
    }

    const insertPreference = database.prepare(
      "INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)",
    );
    for (const [key, value] of Object.entries(library.preferences ?? {})) {
      insertPreference.run(key, JSON.stringify(value));
    }

    const shortcuts = normalizeShortcuts(library.shortcuts);
    const insertShortcut = database.prepare(
      "INSERT OR REPLACE INTO shortcuts (command, slot, key) VALUES (?, ?, ?)",
    );
    for (const [command, slots] of Object.entries(shortcuts)) {
      insertShortcut.run(command, "primary", text(slots.primary));
      insertShortcut.run(command, "secondary", text(slots.secondary));
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* the transaction may already be gone */
    }
    throw error;
  }
};

/** Counts read straight out of a database, for proving a migration was faithful. */
const countDatabase = (database) => ({
  books: Number(database.prepare("SELECT COUNT(*) AS n FROM books").get().n),
  bookmarks: Number(database.prepare("SELECT COUNT(*) AS n FROM bookmarks").get().n),
  finished: Number(database.prepare("SELECT COUNT(*) AS n FROM finished_books").get().n),
  unlocked: Number(database.prepare("SELECT COUNT(*) AS n FROM achievements").get().n),
});

const countLibrary = (library) => ({
  books: (library.history ?? []).length,
  bookmarks: Object.values(library.bookmarks ?? {}).reduce((total, list) => total + (list?.length ?? 0), 0),
  finished: normalizeAchievementState(library.achievements).finished.length,
  unlocked: Object.keys(normalizeAchievementState(library.achievements).unlocked).length,
});

/**
 * Bring a JSON library across, without ever risking it.
 *
 * The new database is built beside the old file and filled in a single
 * transaction, then read back and compared against the source. Only when the
 * contents match is it moved into place, and only after that is the JSON renamed
 * aside. Any failure leaves the JSON untouched and is reported, so the worst case
 * is that the migration did not happen — never that the library is gone.
 *
 * @returns {{migrated: boolean, problem: string|null}}
 */
export const migrateFromJson = async (directory, { jsonFileName = "library.json", sanitize }) => {
  const jsonPath = join(directory, jsonFileName);
  if (!existsSync(jsonPath)) return { migrated: false, problem: null };

  const finalPath = join(directory, FILE_NAME);
  if (existsSync(finalPath)) return { migrated: false, problem: null };
  if (!(await sqliteIsAvailable())) return { migrated: false, problem: null };

  let source;
  try {
    source = sanitize(JSON.parse(readFileSync(jsonPath, "utf8")));
  } catch (error) {
    // A file that cannot be read is left exactly where it is for the reader to
    // find; the corrupt-file path in the caller already reports it.
    return { migrated: false, problem: `The library file could not be read for migration: ${error.message}` };
  }

  const temporary = `${finalPath}.migrating-${process.pid}`;
  let database = null;
  try {
    rmSync(temporary, { force: true });
    database = openDatabase(temporary);
    createSchema(database);
    writeLibrary(database, source);

    const before = countLibrary(source);
    const after = countDatabase(database);
    for (const key of Object.keys(before)) {
      if (before[key] !== after[key]) {
        throw new Error(`migration verification failed: ${key} ${before[key]} became ${after[key]}`);
      }
    }
    // Spot-check every book's position, which is the value a reader would notice.
    const rows = database.prepare("SELECT path_key, last_page FROM books").all();
    const expected = new Map((source.history ?? []).map((entry) => [entry.pathKey, entry.lastPage ?? 1]));
    for (const row of rows) {
      if (Number(row.last_page) !== Number(expected.get(row.path_key))) {
        throw new Error(`migration verification failed: ${row.path_key} position`);
      }
    }
    database.close();
    database = null;

    renameSync(temporary, finalPath);
    // Only now is it safe to set the old file aside.
    try {
      renameSync(jsonPath, `${jsonPath}${MIGRATED_SUFFIX}-${Date.now()}`);
    } catch {
      /* The database is already the source of truth; leaving the JSON is harmless. */
    }
    return { migrated: true, problem: null };
  } catch (error) {
    if (database !== null) {
      try {
        database.close();
      } catch {
        /* nothing useful to do */
      }
    }
    rmSync(temporary, { force: true });
    return { migrated: false, problem: error.message };
  }
};

/**
 * @param {{directory: string, now?: () => Date}} options
 */
export const createLibraryDatabase = async ({ directory, now = () => new Date() }) => {
  if (!(await sqliteIsAvailable())) return null;
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, FILE_NAME);
  let database = null;
  let loadProblem = null;

  try {
    database = openDatabase(filePath);
    createSchema(database);
  } catch (error) {
    if (database !== null) {
      try {
        database.close();
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  const timestamp = () => now().toISOString();

  const readBooks = () =>
    database
      .prepare(
        "SELECT path_key, path, display_name, kind, pages, last_page, opened_at, read_at, series, number " +
          `FROM books ORDER BY opened_at DESC LIMIT ${HISTORY_LIMIT}`,
      )
      .all()
      .map((row) => ({
        pathKey: row.path_key,
        path: row.path,
        displayName: row.display_name,
        kind: row.kind,
        pages: Number(row.pages),
        lastPage: Number(row.last_page),
        openedAt: row.opened_at,
        readAt: row.read_at,
        series: row.series,
        number: row.number,
      }));

  const readBookmarks = () => {
    const grouped = {};
    for (const row of database
      .prepare("SELECT id, path_key, page, name, created_at FROM bookmarks ORDER BY page")
      .all()) {
      if (grouped[row.path_key] === undefined) grouped[row.path_key] = [];
      grouped[row.path_key].push({
        id: row.id,
        page: Number(row.page),
        name: row.name,
        createdAt: row.created_at,
      });
    }
    return grouped;
  };

  const readPreferences = () => {
    const stored = {};
    for (const row of database.prepare("SELECT key, value FROM preferences").all()) {
      try {
        stored[row.key] = JSON.parse(row.value);
      } catch {
        /* a value we cannot read falls back to its default */
      }
    }
    return normalizePreferences(stored);
  };

  const readShortcuts = () => {
    const stored = {};
    for (const row of database.prepare("SELECT command, slot, key FROM shortcuts").all()) {
      if (!REBINDABLE_COMMANDS.includes(row.command)) continue;
      if (stored[row.command] === undefined) stored[row.command] = {};
      stored[row.command][row.slot] = row.key === null || row.key === undefined ? null : row.key;
    }
    return normalizeShortcuts(Object.keys(stored).length === 0 ? DEFAULT_SHORTCUTS : stored);
  };

  const readAchievements = () => {
    const stats = {};
    for (const row of database.prepare("SELECT key, value FROM achievement_stats").all()) {
      try {
        stats[row.key] = JSON.parse(row.value);
      } catch {
        /* ignore a value we cannot read */
      }
    }
    return normalizeAchievementState({
      pagesTurned: stats.pages_turned,
      nightReading: asBool(stats.night_reading),
      finished: database
        .prepare("SELECT path_key, pages, at FROM finished_books")
        .all()
        .map((row) => ({ pathKey: row.path_key, pages: Number(row.pages), at: row.at })),
      openDays: database.prepare("SELECT day FROM reading_days ORDER BY day").all().map((row) => row.day),
      unlocked: Object.fromEntries(
        database.prepare("SELECT id, unlocked_at FROM achievements").all().map((row) => [row.id, row.unlocked_at]),
      ),
    });
  };

  const readBookSettings = () => {
    const settings = {};
    for (const row of database.prepare("SELECT path_key, json FROM book_settings").all()) {
      try {
        settings[row.path_key] = normalizeBookSettings(JSON.parse(row.json));
      } catch {
        /* a row we cannot read is treated as absent */
      }
    }
    return settings;
  };

  /** Everything the export and import rules work from. */
  const asLibrary = () => {
    const bookSettings = readBookSettings();
    return {
      history: readBooks(),
      bookmarks: readBookmarks(),
      bookSettings,
      achievements: readAchievements(),
      preferences: readPreferences(),
      shortcuts: readShortcuts(),
    };
  };

  /** Drop books past the recent limit, and bookmarks and layout with them. */
  const prune = () => {
    const keep = database
      .prepare(`SELECT path_key FROM books ORDER BY opened_at DESC LIMIT ${HISTORY_LIMIT}`)
      .all()
      .map((row) => row.path_key);
    if (keep.length === 0) {
      database.exec("DELETE FROM books");
      database.exec("DELETE FROM bookmarks");
      database.exec("DELETE FROM book_settings");
      return;
    }
    const placeholders = keep.map(() => "?").join(", ");
    database.prepare(`DELETE FROM books WHERE path_key NOT IN (${placeholders})`).run(...keep);
    database.prepare(`DELETE FROM bookmarks WHERE path_key NOT IN (${placeholders})`).run(...keep);
    database.prepare(`DELETE FROM book_settings WHERE path_key NOT IN (${placeholders})`).run(...keep);
  };

  const transaction = (work) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw error;
    }
  };

  const entryRow = (pathKey) =>
    database.prepare("SELECT last_page FROM books WHERE path_key = ?").get(pathKey);

  const applyProgress = (targetPath, page) => {
    const pathKey = normalizePathKey(targetPath);
    const row = entryRow(pathKey);
    if (row === undefined || !Number.isInteger(page) || page < 1) return false;
    if (Number(row.last_page) === page) return false;
    database
      .prepare("UPDATE books SET last_page = ?, read_at = ? WHERE path_key = ?")
      .run(page, timestamp(), pathKey);
    return true;
  };

  return {
    backend: "sqlite",
    loadProblem,
    filePath,

    snapshot() {
      return asLibrary();
    },
    preferences: readPreferences,
    history: readBooks,
    bookmarks: (targetPath) => bookmarksFor(readBookmarks(), normalizePathKey(targetPath)),
    bookSettings(targetPath) {
      return { ...(readBookSettings()[normalizePathKey(targetPath)] ?? {}) };
    },

    async recordOpen({ targetPath, displayName, kind, pages = 0, series = null, number = null }) {
      const pathKey = normalizePathKey(targetPath);
      return transaction(() => {
        const previous = entryRow(pathKey);
        database
          .prepare(
            "INSERT INTO books (path_key, path, display_name, kind, pages, last_page, opened_at, series, number) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
              "ON CONFLICT(path_key) DO UPDATE SET path = excluded.path, display_name = excluded.display_name, " +
              "kind = excluded.kind, pages = excluded.pages, opened_at = excluded.opened_at, " +
              "series = COALESCE(excluded.series, books.series), number = COALESCE(excluded.number, books.number)",
          )
          .run(
            pathKey,
            targetPath,
            displayName,
            kind,
            Number(pages),
            // Never lose where the reader had got to.
            previous === undefined ? 1 : Number(previous.last_page),
            timestamp(),
            text(series),
            text(number),
          );
        prune();
        return readBooks().find((book) => book.pathKey === pathKey) ?? null;
      });
    },

    async recordProgress(targetPath, page) {
      const changed = transaction(() => applyProgress(targetPath, page));
      return changed;
    },

    async setBookSettings(targetPath, settings) {
      const pathKey = normalizePathKey(targetPath);
      const merged = normalizeBookSettings({ ...(readBookSettings()[pathKey] ?? {}), ...settings });
      transaction(() => {
        if (Object.keys(merged).length === 0) {
          database.prepare("DELETE FROM book_settings WHERE path_key = ?").run(pathKey);
        } else {
          database
            .prepare("INSERT OR REPLACE INTO book_settings (path_key, json) VALUES (?, ?)")
            .run(pathKey, JSON.stringify(merged));
        }
      });
      return { ...merged };
    },

    async recordReading({ targetPath, page, total = 0, at = timestamp() }) {
      const pathKey = normalizePathKey(targetPath);
      const changed = transaction(() => {
        const moved = applyProgress(targetPath, page);
        const folded = foldActivity(readAchievements(), {
          pathKey,
          page,
          total,
          dayKey: localDayKey(new Date(at)),
          hour: new Date(at).getHours(),
          at,
        });
        const evaluated = evaluateAchievements(folded, {
          distinctBooks: Number(database.prepare("SELECT COUNT(*) AS n FROM books").get().n),
          todayKey: localDayKey(new Date(at)),
          at,
        });
        const state = evaluated.state;
        database
          .prepare("INSERT OR REPLACE INTO achievement_stats (key, value) VALUES ('pages_turned', ?)")
          .run(JSON.stringify(state.pagesTurned));
        if (state.nightReading) {
          database
            .prepare("INSERT OR REPLACE INTO achievement_stats (key, value) VALUES ('night_reading', '1')")
            .run();
        }
        for (const day of state.openDays) {
          database.prepare("INSERT OR IGNORE INTO reading_days (day) VALUES (?)").run(day);
        }
        for (const entry of state.finished) {
          database
            .prepare("INSERT OR IGNORE INTO finished_books (path_key, pages, at) VALUES (?, ?, ?)")
            .run(entry.pathKey, Number(entry.pages ?? 0), text(entry.at));
        }
        for (const [id, date] of Object.entries(evaluated.state.unlocked)) {
          database.prepare("INSERT OR IGNORE INTO achievements (id, unlocked_at) VALUES (?, ?)").run(id, text(date));
        }
        return { changed: moved, unlocked: evaluated.unlockedNow };
      });
      return changed;
    },

    achievementSummary() {
      return buildAchievementSummary(readAchievements(), {
        distinctBooks: Number(database.prepare("SELECT COUNT(*) AS n FROM books").get().n),
        todayKey: localDayKey(now()),
      });
    },

    async resetAchievements() {
      transaction(() => {
        database.exec("DELETE FROM achievements");
        database.exec("DELETE FROM achievement_stats");
        database.exec("DELETE FROM finished_books");
        database.exec("DELETE FROM reading_days");
      });
      return true;
    },

    exportLibrary({ appVersion = null } = {}) {
      return buildLibraryExport(asLibrary(), { at: timestamp(), appVersion });
    },

    async importLibrary(document) {
      const library = asLibrary();
      const result = mergeLibraryImport(library, document);
      if (result.unrecognised) return { ok: false, unrecognised: true };
      // writeLibrary opens its own transaction, so it is not wrapped in another.
      writeLibrary(database, { ...library, ...result.library });
      return { ok: true, report: result.report };
    },

    historyBySeries() {
      return groupHistoryBySeries(readBooks());
    },

    async addBookmark(targetPath, page, name) {
      const pathKey = normalizePathKey(targetPath);
      const bookmark = {
        id: randomUUID(),
        page,
        name: name?.trim() === "" || name === undefined ? `Page ${page}` : name.trim(),
        createdAt: timestamp(),
      };
      transaction(() => {
        database
          .prepare("INSERT INTO bookmarks (id, path_key, page, name, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(bookmark.id, pathKey, Number(page), bookmark.name, bookmark.createdAt);
      });
      return bookmark;
    },

    async removeBookmark(id) {
      const removed = transaction(() => {
        const result = database.prepare("DELETE FROM bookmarks WHERE id = ?").run(String(id));
        return Number(result.changes) > 0;
      });
      return removed;
    },

    async clearHistory() {
      transaction(() => {
        database.exec("DELETE FROM books");
        database.exec("DELETE FROM bookmarks");
        database.exec("DELETE FROM book_settings");
      });
    },

    async setPreference(key, value) {
      if (!(key in DEFAULT_PREFERENCES)) throw new Error(`Unknown preference: ${key}`);
      const coerced = coercePreference(key, value);
      if (coerced === undefined) {
        throw new Error(`Invalid value for preference ${key}: ${JSON.stringify(value)}`);
      }
      transaction(() => {
        database
          .prepare("INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)")
          .run(key, JSON.stringify(coerced));
      });
      return readPreferences();
    },

    shortcuts: readShortcuts,

    async setShortcut(command, slot, keyString) {
      if (!REBINDABLE_COMMANDS.includes(command)) throw new Error(`Unknown command: ${command}`);
      if (slot !== "primary" && slot !== "secondary") throw new Error(`Unknown slot: ${slot}`);
      const updated = withShortcut(readShortcuts(), command, slot, keyString);
      transaction(() => {
        for (const [name, slots] of Object.entries(updated)) {
          database
            .prepare("INSERT OR REPLACE INTO shortcuts (command, slot, key) VALUES (?, 'primary', ?)")
            .run(name, text(slots.primary));
          database
            .prepare("INSERT OR REPLACE INTO shortcuts (command, slot, key) VALUES (?, 'secondary', ?)")
            .run(name, text(slots.secondary));
        }
      });
      return readShortcuts();
    },

    async resetShortcuts() {
      transaction(() => database.exec("DELETE FROM shortcuts"));
      return readShortcuts();
    },

    /** Writes are durable when they return, so there is nothing to drain. */
    async flush() {},

    close() {
      try {
        database.close();
      } catch {
        /* closing a store is best effort */
      }
    },
  };
};

export const libraryDatabaseFile = FILE_NAME;
