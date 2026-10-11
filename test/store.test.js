/**
 * Store tests. Persistence is the part a reader cannot afford to get wrong, so
 * these use a real temporary directory rather than a mocked filesystem.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createStore } from "../src/main/store.js";

let workspace = null;
const directoryFor = async (name) => {
  const directory = join(workspace, name);
  return directory;
};

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pageforge-store-"));
});

after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true });
});

const BOOK = "C:\\Comics\\Saga.cbz";

describe("store", () => {
  it("starts empty with the default preferences", async () => {
    const store = await createStore({ directory: await directoryFor("empty") });
    assert.equal(store.loadProblem, null);
    assert.deepEqual(store.history(), []);
    assert.deepEqual(store.preferences(), { resumeLastPage: true, showThumbnails: false });
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

  it("only accepts known preferences", async () => {
    const store = await createStore({ directory: await directoryFor("prefs") });
    assert.deepEqual(await store.setPreference("showThumbnails", true), {
      resumeLastPage: true,
      showThumbnails: true,
    });
    await assert.rejects(() => store.setPreference("somethingElse", true), /Unknown preference/);
  });

  it("preserves a corrupt library instead of discarding it", async () => {
    const directory = await directoryFor("corrupt");
    await createStore({ directory });
    await writeFile(join(directory, "library.json"), "{ this is not json", "utf8");

    const store = await createStore({ directory });
    assert.match(store.loadProblem ?? "", /could not be read/u);
    const files = await readdir(directory);
    assert.equal(files.some((name) => name.includes(".corrupt-")), true, "the old file is kept");
    assert.deepEqual(store.history(), [], "the store still works");
  });

  it("writes atomically and leaves no temporary files", async () => {
    const directory = await directoryFor("atomic");
    const store = await createStore({ directory });
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

  it("serialises overlapping writes", async () => {
    const directory = await directoryFor("overlap");
    const store = await createStore({ directory });
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
