/**
 * A persistent index of what each archive contains.
 *
 * Opening a CBZ means decompressing every entry once, because a page's size has
 * to be read from its own image header. That is the expensive part of opening a
 * large comic, and it produces the same answer every time the file has not
 * changed, so it is worth keeping.
 *
 * Storage is SQLite through Node's built-in `node:sqlite` — no native module, no
 * rebuild step, and nothing to unpack from the asar. The module is marked
 * experimental upstream, so it is used behind this thin wrapper: if it is
 * unavailable or the database cannot be opened, the cache reports itself as
 * disabled and the reader probes as it always did. A cache that can break opening
 * a book would be worse than no cache.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { normalizePathKey } from "../core/library.js";

const FILE_NAME = "index.sqlite";

/** Columns that identify an archive's contents at a point in time. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS book_index (
     path_key TEXT PRIMARY KEY,
     size INTEGER NOT NULL,
     mtime_ms REAL NOT NULL,
     page_count INTEGER NOT NULL,
     cached_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS page_index (
     path_key TEXT NOT NULL,
     position INTEGER NOT NULL,
     name TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     width INTEGER NOT NULL,
     height INTEGER NOT NULL,
     format TEXT,
     PRIMARY KEY (path_key, position)
   )`,
  `CREATE TABLE IF NOT EXISTS meta_index (
     path_key TEXT NOT NULL,
     json TEXT NOT NULL,
     PRIMARY KEY (path_key)
   )`,
];

/**
 * @param {{directory: string}} options
 * @returns {Promise<object>} the cache API; `enabled` is false when unusable
 */
export const openIndexCache = async ({ directory }) => {
  let database = null;
  let reason = null;

  try {
    const { DatabaseSync } = await import("node:sqlite");
    await mkdirSafe(directory);
    database = new DatabaseSync(join(directory, FILE_NAME));
    // WAL keeps a reader from blocking the writer, and this file is only ever
    // touched by this process.
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    for (const statement of SCHEMA) database.exec(statement);
  } catch (error) {
    if (database !== null) {
      try {
        database.close();
      } catch {
        /* nothing useful to do if even closing fails */
      }
    }
    return {
      enabled: false,
      reason: error.message,
      lookup: () => null,
      store: () => false,
      forget: () => false,
      clear: () => 0,
      stats: () => ({ books: 0, pages: 0 }),
      close: () => {},
    };
  }

  const identify = (targetPath, stats) => ({
    pathKey: normalizePathKey(targetPath),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
  });

  return {
    enabled: true,
    reason: null,
    filePath: join(directory, FILE_NAME),

    /**
     * Cached contents for an archive, or null when it is unknown or the file has
     * changed since it was indexed.
     */
    lookup(targetPath, stats) {
      const { pathKey, size, mtimeMs } = identify(targetPath, stats);
      try {
        const book = database
          .prepare("SELECT size, mtime_ms, page_count FROM book_index WHERE path_key = ?")
          .get(pathKey);
        // Size and modification time are the whole invalidation rule: an archive
        // that changed in any way has a different one of them in practice.
        if (book === undefined || Number(book.size) !== size || Number(book.mtime_ms) !== mtimeMs) {
          return null;
        }
        const rows = database
          .prepare(
            "SELECT position, name, bytes, width, height, format FROM page_index WHERE path_key = ? ORDER BY position",
          )
          .all(pathKey);
        if (rows.length !== Number(book.page_count)) return null;
        const metaRow = database
          .prepare("SELECT json FROM meta_index WHERE path_key = ?")
          .get(pathKey);
        return {
          pages: rows.map((row) => ({
            name: row.name,
            bytes: Number(row.bytes),
            width: Number(row.width),
            height: Number(row.height),
            format: row.format ?? null,
          })),
          comicInfo: metaRow === undefined ? null : safeParse(metaRow.json),
        };
      } catch {
        // A cache that throws must behave like a cache that missed.
        return null;
      }
    },

    /** Replace what is known about an archive. */
    store(targetPath, stats, pages, comicInfo = null) {
      const { pathKey, size, mtimeMs } = identify(targetPath, stats);
      try {
        database.exec("BEGIN");
        database.prepare("DELETE FROM page_index WHERE path_key = ?").run(pathKey);
        database.prepare("DELETE FROM meta_index WHERE path_key = ?").run(pathKey);
        const insert = database.prepare(
          "INSERT INTO page_index (path_key, position, name, bytes, width, height, format) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        pages.forEach((page, position) => {
          insert.run(
            pathKey,
            position,
            String(page.name),
            Number(page.bytes ?? 0),
            Number(page.width ?? 0),
            Number(page.height ?? 0),
            page.format ?? null,
          );
        });
        if (comicInfo !== null && comicInfo !== undefined) {
          database
            .prepare("INSERT INTO meta_index (path_key, json) VALUES (?, ?)")
            .run(pathKey, JSON.stringify(comicInfo));
        }
        database
          .prepare(
            "INSERT INTO book_index (path_key, size, mtime_ms, page_count, cached_at) VALUES (?, ?, ?, ?, ?) " +
              "ON CONFLICT(path_key) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, " +
              "page_count = excluded.page_count, cached_at = excluded.cached_at",
          )
          .run(pathKey, size, mtimeMs, pages.length, new Date().toISOString());
        database.exec("COMMIT");
        return true;
      } catch {
        try {
          database.exec("ROLLBACK");
        } catch {
          /* the transaction may already be gone */
        }
        return false;
      }
    },

    /** Forget one archive, for when it turns out to be wrong. */
    forget(targetPath) {
      try {
        const pathKey = normalizePathKey(targetPath);
        database.exec("BEGIN");
        database.prepare("DELETE FROM page_index WHERE path_key = ?").run(pathKey);
        database.prepare("DELETE FROM meta_index WHERE path_key = ?").run(pathKey);
        database.prepare("DELETE FROM book_index WHERE path_key = ?").run(pathKey);
        database.exec("COMMIT");
        return true;
      } catch {
        return false;
      }
    },

    /** Forget everything, and reclaim the space. */
    clear() {
      try {
        const before = this.stats().pages;
        database.exec("DELETE FROM page_index");
        database.exec("DELETE FROM meta_index");
        database.exec("DELETE FROM book_index");
        database.exec("VACUUM");
        return before;
      } catch {
        return 0;
      }
    },

    stats() {
      try {
        const books = database.prepare("SELECT COUNT(*) AS n FROM book_index").get();
        const pages = database.prepare("SELECT COUNT(*) AS n FROM page_index").get();
        return { books: Number(books.n), pages: Number(pages.n) };
      } catch {
        return { books: 0, pages: 0 };
      }
    },

    close() {
      try {
        database.close();
      } catch {
        /* closing a cache is best effort */
      }
      database = null;
    },
  };
};

const mkdirSafe = async (directory) => {
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
};

const safeParse = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};
