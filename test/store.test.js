/**
 * Store tests. Persistence is the part a reader cannot afford to get wrong, so
 * these use a real temporary directory rather than a mocked filesystem.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createStore as openStore } from "../src/main/store.js";
import { DEFAULT_PREFERENCES } from "../src/core/library.js";

let workspace = null;
const directoryFor = async (name) => {
  const directory = join(workspace, name);
  return directory;
};

/**
 * Every store a test opens, so they can all be closed before the temporary
 * directory is removed: a SQLite store holds its file open, and deleting the
 * directory out from under it fails.
 */
const opened = [];
const createStore = async (options) => {
  const store = await openStore(options);
  opened.push(store);
  return store;
};

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pageforge-store-"));
});

after(async () => {
  for (const store of opened) {
    try {
      store.close?.();
    } catch {
      /* closing is best effort */
    }
  }
  if (workspace !== null) await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

const BOOK = "C:\\Comics\\Saga.cbz";

describe("store", () => {
  it("starts empty with the default preferences", async () => {
    const store = await createStore({ directory: await directoryFor("empty") });
    assert.equal(store.loadProblem, null);
    assert.deepEqual(store.history(), []);
    assert.deepEqual(store.preferences(), DEFAULT_PREFERENCES);
  });

  it("remembers an opened book and its reading position", async () => {
    const directory = await directoryFor("progress");
    const store = await createStore({ directory });
    const entry = await store.recordOpen({ targetPath: BOOK, displayName: "Saga.cbz", kind: "archive", pages: 20 });
    assert.equal(entry.lastPage, 1);

    assert.equal(await store.recordProgress(BOOK, 6), true);
    assert.equal(await store.recordProgress(BOOK, 6), false, "an unchanged page writes nothing");
    assert.equal(await store.recordProgress("C:\\Comics\\Other.cbz", 3), false, "unknown books are ignored");

    const reopened = await createStore({ directory });
    assert.equal(reopened.history()[0].lastPage, 6);
  });

  it("keeps the reading position when a book is reopened", async () => {
    const directory = await directoryFor("reopen");
    const store = await createStore({ directory });
    await store.recordOpen({ targetPath: BOOK, displayName: "Saga.cbz", kind: "archive", pages: 20 });
    await store.recordProgress(BOOK, 9);
    const again = await store.recordOpen({ targetPath: BOOK, displayName: "Saga.cbz", kind: "archive", pages: 20 });
    assert.equal(again.lastPage, 9, "reopening must not reset the position");
    assert.equal(store.history().length, 1, "reopening must not duplicate the entry");
  });

  it("treats the same path written with different separators as one book", async () => {
    const directory = await directoryFor("keys");
    const store = await createStore({ directory });
    await store.recordOpen({ targetPath: "C:\\Comics\\Saga.cbz", displayName: "Saga.cbz", kind: "archive", pages: 20 });
    await store.recordOpen({ targetPath: "C:/Comics/SAGA.CBZ", displayName: "Saga.cbz", kind: "archive", pages: 20 });
    assert.equal(store.history().length, 1);
  });

  it("adds, lists and removes named bookmarks", async () => {
    const directory = await directoryFor("bookmarks");
    const store = await createStore({ directory });
    await store.recordOpen({ targetPath: BOOK, displayName: "Saga.cbz", kind: "archive", pages: 20 });

    const chapter = await store.addBookmark(BOOK, 7, "  Chapter 2  ");
    const unnamed = await store.addBookmark(BOOK, 3, "   ");
    assert.equal(chapter.name, "Chapter 2", "names are trimmed");
    assert.equal(unnamed.name, "Page 3", "an empty name falls back to the page");
    assert.deepEqual(
      store.bookmarks(BOOK).map((item) => item.page),
      [3, 7],
    );

    assert.equal(await store.removeBookmark(chapter.id), true);
    assert.equal(await store.removeBookmark(chapter.id), false, "removing twice is a no-op");
    assert.deepEqual(
      store.bookmarks(BOOK).map((item) => item.page),
      [3],
    );
  });

  it("drops bookmarks when history is cleared", async () => {
    const directory = await directoryFor("clear");
    const store = await createStore({ directory });
    await store.recordOpen({ targetPath: BOOK, displayName: "Saga.cbz", kind: "archive", pages: 20 });
    await store.addBookmark(BOOK, 4, "four");
    await store.clearHistory();
    assert.deepEqual(store.history(), []);
    assert.deepEqual(store.bookmarks(BOOK), []);
  });

  it("only accepts known preferences with usable values", async () => {
    const store = await createStore({ directory: await directoryFor("prefs") });
    assert.deepEqual(await store.setPreference("showThumbnails", true), {
      ...DEFAULT_PREFERENCES,
      showThumbnails: true,
    });
    assert.equal((await store.setPreference("gamma", 99)).gamma, 3, "out-of-range numbers are clamped");
    await assert.rejects(() => store.setPreference("somethingElse", true), /Unknown preference/);
    await assert.rejects(() => store.setPreference("resampling", "bicubic"), /Invalid value/);    await assert.rejects(() => store.setPreference("resumeLastPage", "yes"), /Invalid value/);
  });

  // These three test the mechanics of the JSON file itself: the corrupt-file
  // rename, the atomic temporary file and the write queue. They name that
  // backend explicitly so they keep testing it after SQLite became the default.
  it("preserves a corrupt library instead of discarding it", async () => {
    const directory = await directoryFor("corrupt");
    await createStore({ directory, storage: "json" });
    await writeFile(join(directory, "library.json"), "{ this is not json", "utf8");

    const store = await createStore({ directory, storage: "json" });
    assert.match(store.loadProblem ?? "", /could not be read/u);
    const files = await readdir(directory);
    assert.equal(files.some((name) => name.includes(".corrupt-")), true, "the old file is kept");
    assert.deepEqual(store.history(), [], "the store still works");
  });

  it("writes atomically and leaves no temporary files", async () => {
    const directory = await directoryFor("atomic");
    const store = await createStore({ directory, storage: "json" });
    await store.recordOpen({ targetPath: BOOK, displayName: "Saga.cbz", kind: "archive", pages: 20 });
    await store.addBookmark(BOOK, 2, "two");
    await store.flush();

    const files = await readdir(directory);
    assert.deepEqual(files, ["library.json"], "only the library file remains");
    const written = JSON.parse(await readFile(join(directory, "library.json"), "utf8"));
    assert.equal(written.version, 1);
    assert.equal(written.history.length, 1);
    assert.equal(Object.keys(written.bookmarks).length, 1);
  });

  it("stores, rebinds and resets keyboard shortcuts", async () => {
    const directory = await directoryFor("shortcuts");
    const store = await createStore({ directory });
    assert.equal(store.shortcuts()["next-page"].primary, "ArrowRight", "defaults are available");

    const rebound = await store.setShortcut("next-page", "primary", "F");
    assert.equal(rebound["next-page"].primary, "F");
    assert.equal(rebound["fit-screen"].primary, null, "the key is taken from its previous owner");
    await assert.rejects(() => store.setShortcut("not-a-command", "primary", "N"), /Unknown command/);
    await assert.rejects(() => store.setShortcut("next-page", "third", "N"), /Unknown slot/);

    const reopened = await createStore({ directory });
    assert.equal(reopened.shortcuts()["next-page"].primary, "F", "bindings survive a restart");

    const reset = await reopened.resetShortcuts();
    assert.equal(reset["next-page"].primary, "ArrowRight");
    assert.equal(reset["fit-screen"].primary, "F");
  });

  it("serialises overlapping writes", async () => {
    const directory = await directoryFor("overlap");
    const store = await createStore({ directory, storage: "json" });
    await store.recordOpen({ targetPath: BOOK, displayName: "Saga.cbz", kind: "archive", pages: 20 });
    await Promise.all([
      store.addBookmark(BOOK, 1, "one"),
      store.addBookmark(BOOK, 2, "two"),
      store.addBookmark(BOOK, 3, "three"),
    ]);
    await store.flush();
    const written = JSON.parse(await readFile(join(directory, "library.json"), "utf8"));
    assert.equal(Object.values(written.bookmarks)[0].length, 3, "no write is lost");
  });
});

describe("library export and import through the store", () => {
  it("carries positions, bookmarks and achievements between libraries", async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), "pageforge-export-src-"));
    const targetDirectory = await mkdtemp(join(tmpdir(), "pageforge-export-dst-"));
    try {
      const source = await createStore({ directory: sourceDirectory });
      await source.recordOpen({
        targetPath: "C:/comics/saga-01.cbz",
        displayName: "saga-01.cbz",
        kind: "archive",
        pages: 120,
        series: "Saga",
        number: "1",
      });
      await source.recordProgress("C:/comics/saga-01.cbz", 40);
      await source.addBookmark("C:/comics/saga-01.cbz", 12, "Chapter 2");
      await source.recordReading({ targetPath: "C:/comics/saga-01.cbz", page: 120, total: 120 });
      await source.flush();
      const document = source.exportLibrary({ appVersion: "0.1.0" });

      const target = await createStore({ directory: targetDirectory });
      assert.equal((await target.importLibrary(document)).ok, true);
      const entry = target.history().find((item) => item.pathKey.includes("saga-01"));
      assert.equal(entry.lastPage, 120, "the position came across");
      assert.equal(entry.series, "Saga", "and so did the series, so the list can group it");
      assert.equal(target.bookmarks("C:/comics/saga-01.cbz").length, 1);
      assert.equal(target.achievementSummary().measures.booksFinished, 1);
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true }).catch(() => {});
      await rm(targetDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("refuses a file that is not a PageForge library", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pageforge-import-bad-"));
    try {
      const store = await createStore({ directory });
      const result = await store.importLibrary({ hello: "world" });
      assert.equal(result.ok, false);
      assert.equal(result.unrecognised, true);
      assert.deepEqual(store.history(), [], "nothing was applied");
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("groups the remembered books by series", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pageforge-grouped-"));
    try {
      const store = await createStore({ directory });
      await store.recordOpen({ targetPath: "C:/a.cbz", displayName: "a", kind: "archive", series: "Saga", number: "2" });
      await store.recordOpen({ targetPath: "C:/b.cbz", displayName: "b", kind: "archive", series: "Saga", number: "1" });
      await store.recordOpen({ targetPath: "C:/c.cbz", displayName: "c", kind: "archive" });
      await store.flush();
      const grouped = store.historyBySeries();
      assert.equal(grouped.groups.length, 1);
      assert.equal(grouped.groups[0].name, "Saga");
      assert.deepEqual(
        grouped.groups[0].entries.map((entry) => entry.displayName),
        ["b", "a"],
        "issue 1 comes before issue 2",
      );
      assert.equal(grouped.loose.length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  });
});
