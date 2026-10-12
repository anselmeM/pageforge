/**
 * Library database tests.
 *
 * The migration is the dangerous part of this change: it moves the only copy of a
 * reader's history, so these tests are about what happens when things go wrong as
 * much as what happens when they go right.
 *
 * Every store opened here is closed, because SQLite holds its file open and
 * deleting the directory underneath it fails.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createStore } from "../src/main/store.js";

let workspace = null;
const opened = [];

const store = async (options) => {
  const created = await createStore(options);
  opened.push(created);
  return created;
};

/** A realistic JSON library: every table the migration has to carry. */
const writeSampleJsonLibrary = async (directory) => {
  await mkdir(directory, { recursive: true });
  const library = {
    version: 1,
    preferences: { colorMode: "auto", prefetchPages: 4, showThumbnails: true },
    shortcuts: { "next-page": { primary: "N", secondary: null } },
    history: [
      {
        pathKey: "c:/comics/saga-01.cbz",
        path: "C:/comics/saga-01.cbz",
        displayName: "saga-01.cbz",
        kind: "archive",
        pages: 120,
        lastPage: 47,
        openedAt: "2026-01-01T00:00:00.000Z",
        readAt: "2026-01-02T00:00:00.000Z",
        series: "Saga",
        number: "1",
      },
      {
        pathKey: "c:/comics/loose.cbz",
        path: "C:/comics/loose.cbz",
        displayName: "loose.cbz",
        kind: "archive",
        pages: 8,
        lastPage: 8,
        openedAt: "2026-01-03T00:00:00.000Z",
        readAt: "2026-01-03T00:00:00.000Z",
        series: null,
        number: null,
      },
    ],
    bookmarks: {
      "c:/comics/saga-01.cbz": [
        { id: "11111111-1111-1111-1111-111111111111", page: 12, name: "Chapter 2", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    },
    bookSettings: { "c:/comics/saga-01.cbz": { doublePage: true, fitMode: "width", rotation: 90 } },
    achievements: {
      pagesTurned: 55,
      finished: [{ pathKey: "c:/comics/loose.cbz", pages: 8, at: "2026-01-03T00:00:00.000Z" }],
      openDays: ["2026-01-01", "2026-01-02"],
      nightReading: true,
      unlocked: { "first-page": "2026-01-01T00:00:00.000Z" },
    },
  };
  await writeFile(join(directory, "library.json"), JSON.stringify(library, null, 2), "utf8");
  return library;
};

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pageforge-db-"));
});

after(async () => {
  for (const created of opened) {
    try {
      created.close?.();
    } catch {
      /* best effort */
    }
  }
  if (workspace !== null) await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

describe("migrating from the JSON library", () => {
  it("carries every part of the library across, and proves it before swapping", async () => {
    const directory = join(workspace, "migrate");
    const source = await writeSampleJsonLibrary(directory);

    const store1 = await store({ directory: directory, storage: "sqlite" });
    assert.equal(store1.backend, "sqlite");

    const history = store1.history();
    assert.equal(history.length, 2, "both books came across");
    const saga = history.find((entry) => entry.displayName === "saga-01.cbz");
    assert.equal(saga.lastPage, 47, "the reading position is exact");
    assert.equal(saga.series, "Saga");
    assert.equal(saga.number, "1");
    assert.equal(saga.pages, 120);

    assert.equal(store1.bookmarks("C:/comics/saga-01.cbz").length, 1);
    assert.equal(store1.bookmarks("C:/comics/saga-01.cbz")[0].name, "Chapter 2");
    assert.deepEqual(store1.bookSettings("C:/comics/saga-01.cbz"), {
      doublePage: true,
      fitMode: "width",
      rotation: 90,
    });
    assert.equal(store1.preferences().colorMode, "auto");
    assert.equal(store1.preferences().prefetchPages, 4);
    assert.equal(store1.shortcuts()["next-page"].primary, "N", "a rebound shortcut survived");

    const summary = store1.achievementSummary();
    assert.equal(summary.measures.pagesTurned, 55);
    assert.equal(summary.measures.booksFinished, 1);
    assert.equal(
      summary.entries.find((entry) => entry.id === "first-page").unlockedAt,
      "2026-01-01T00:00:00.000Z",
    );

    // Read back through the database directly, so the check does not depend on
    // the accessors that were just used to write it.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(directory, "pageforge.sqlite"));
    assert.equal(Number(raw.prepare("SELECT COUNT(*) AS n FROM books").get().n), source.history.length);
    assert.equal(Number(raw.prepare("SELECT COUNT(*) AS n FROM bookmarks").get().n), 1);
    assert.equal(Number(raw.prepare("SELECT COUNT(*) AS n FROM reading_days").get().n), 2);
    raw.close();
  });

  it("sets the old file aside rather than deleting it", async () => {
    const directory = join(workspace, "aside");
    await writeSampleJsonLibrary(directory);
    await store({ directory: directory, storage: "sqlite" });

    const files = await readdir(directory);
    assert.equal(files.includes("pageforge.sqlite"), true, "the database is in place");
    assert.equal(
      files.some((name) => name.startsWith("library.json.migrated-")),
      true,
      "the original was kept, not removed",
    );
    const kept = JSON.parse(await readFile(join(directory, files.find((n) => n.startsWith("library.json.migrated-"))), "utf8"));
    assert.equal(kept.history.length, 2, "and it is intact");
  });

  it("is a no-op the second time, and loses nothing", async () => {
    const directory = join(workspace, "twice");
    await writeSampleJsonLibrary(directory);
    const first = await store({ directory: directory, storage: "sqlite" });
    await first.recordProgress("C:/comics/saga-01.cbz", 60);
    first.close();

    const second = await store({ directory: directory, storage: "sqlite" });
    assert.equal(second.history().length, 2, "no duplicate books from a second migration");
    const saga = second.history().find((entry) => entry.displayName === "saga-01.cbz");
    assert.equal(saga.lastPage, 60, "and the newer position is intact");
  });

  it("leaves a corrupt library file alone and says so", async () => {
    const directory = join(workspace, "corrupt");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "library.json"), "{ not json at all", "utf8");

    const store1 = await store({ directory: directory, storage: "sqlite" });
    assert.match(store1.loadProblem ?? "", /could not be read/u);
    const files = await readdir(directory);
    assert.equal(files.includes("library.json"), true, "the unreadable file is not swallowed");
    assert.deepEqual(store1.history(), [], "and the store still works");
  });
});

describe("falling back when the database cannot be used", () => {
  it("keeps working on the JSON store, with the data intact", async () => {
    const directory = join(workspace, "blocked");
    await writeSampleJsonLibrary(directory);
    // A directory where the database file should go: the database cannot be
    // created, so the store must fall back rather than fail to start.
    await mkdir(join(directory, "pageforge.sqlite"), { recursive: true });

    const store1 = await store({ directory });
    assert.equal(store1.backend, "json", "it fell back to the JSON store");
    assert.equal(store1.history().length, 2, "and the library is still readable");
    const files = await readdir(directory);
    assert.equal(
      files.some((name) => name.startsWith("pageforge.sqlite.migrating-")),
      false,
      "no half-built database was left behind",
    );
  });

  it("honours an explicit request for the JSON store", async () => {
    const directory = join(workspace, "forced-json");
    const store1 = await store({ directory, storage: "json" });
    assert.equal(store1.backend, "json");
    await store1.recordOpen({ targetPath: "C:/x.cbz", displayName: "x", kind: "archive", pages: 5 });
    await store1.flush();
    assert.equal(store1.history().length, 1);
  });

  it("says so when SQLite is demanded but cannot be opened", async () => {
    const directory = join(workspace, "demanded");
    await mkdir(directory, { recursive: true });
    await mkdir(join(directory, "pageforge.sqlite"), { recursive: true });
    await assert.rejects(() => store({ directory, storage: "sqlite" }));
  });
});

describe("concurrent use", () => {
  it("does not lose a write when two stores touch the same library", async () => {
    const directory = join(workspace, "concurrent");
    const first = await store({ directory, storage: "sqlite" });
    await first.recordOpen({ targetPath: "C:/a.cbz", displayName: "a", kind: "archive", pages: 10 });

    // A second running copy of the app, which with the JSON store would each hold
    // its own copy in memory and overwrite the other's work.
    const second = await store({ directory, storage: "sqlite" });
    await second.recordOpen({ targetPath: "C:/b.cbz", displayName: "b", kind: "archive", pages: 10 });
    await first.addBookmark("C:/a.cbz", 3, "from the first");
    await second.addBookmark("C:/b.cbz", 5, "from the second");

    const names = first.history().map((entry) => entry.displayName).sort();
    assert.deepEqual(names, ["a", "b"], "both books are remembered");
    assert.equal(first.bookmarks("C:/a.cbz").length, 1);
    assert.equal(second.bookmarks("C:/b.cbz").length, 1, "the second store's bookmark survived the first's write");
  });
});

describe("behaviour that must match the JSON store", () => {
  it("enforces the same preference rules", async () => {
    const directory = join(workspace, "prefs");
    const store1 = await store({ directory, storage: "sqlite" });
    await assert.rejects(() => store1.setPreference("nonsense", true), /Unknown preference/u);
    await assert.rejects(() => store1.setPreference("prefetchPages", "lots"), /Invalid value/u);
    const updated = await store1.setPreference("prefetchPages", 3);
    assert.equal(updated.prefetchPages, 3);
    assert.equal(store1.preferences().prefetchPages, 3, "and it is remembered");
  });

  it("caps the recent list and drops the bookmarks of books it forgets", async () => {
    const directory = join(workspace, "capped");
    const store1 = await store({ directory, storage: "sqlite" });
    for (let index = 0; index < 55; index += 1) {
      await store1.recordOpen({
        targetPath: `C:/book-${index}.cbz`,
        displayName: `book-${index}`,
        kind: "archive",
        pages: 4,
      });
    }
    const history = store1.history();
    assert.equal(history.length, 50, "the recent list is capped like the JSON store");
    assert.equal(
      history.some((entry) => entry.displayName === "book-0"),
      false,
      "the oldest book was dropped",
    );
    assert.deepEqual(store1.bookmarks("C:/book-0.cbz"), [], "and its bookmarks went with it");
  });

  it("keeps achievements when history is cleared", async () => {
    const directory = join(workspace, "achievements-survive");
    const store1 = await store({ directory, storage: "sqlite" });
    await store1.recordOpen({ targetPath: "C:/a.cbz", displayName: "a", kind: "archive", pages: 4 });
    await store1.recordReading({ targetPath: "C:/a.cbz", page: 4, total: 4 });
    await store1.clearHistory();
    assert.deepEqual(store1.history(), [], "history is gone");
    assert.equal(store1.achievementSummary().measures.booksFinished, 1, "but what was earned remains");
  });
});
