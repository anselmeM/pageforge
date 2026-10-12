/** Unit tests for the library rules: position resolution, recents, bookmarks. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_PREFERENCES,
  bookmarksFor,
  buildLibraryExport,
  describeHistoryEntry,
  findBookmarkAtPage,
  groupHistoryBySeries,
  mergeLibraryImport,
  normalizeBookSettings,
  normalizePathKey,
  pruneBookSettings,
  pruneBookmarks,
  resolveStartPage,
  upsertHistory,
} from "../src/core/library.js";

describe("path keys", () => {
  it("folds case and separators on Windows", () => {
    assert.equal(normalizePathKey("C:\\Comics\\Book.CBZ", "win32"), "c:/comics/book.cbz");
    assert.equal(normalizePathKey("C:/Comics/Book.CBZ", "win32"), "c:/comics/book.cbz");
  });

  it("keeps case on case-sensitive platforms", () => {
    assert.equal(normalizePathKey("/Comics/Book.cbz", "linux"), "/Comics/Book.cbz");
  });
});

describe("resuming a book", () => {
  it("returns to the recorded page", () => {
    assert.equal(resolveStartPage({ lastPage: 7 }, 20), 7);
  });

  it("honours the preference being off", () => {
    assert.equal(resolveStartPage({ lastPage: 7 }, 20, { resumeLastPage: false }), 1);
  });

  it("clamps a page beyond the end of a shortened book", () => {
    assert.equal(resolveStartPage({ lastPage: 500 }, 12), 12);
  });

  it("falls back to the first page when there is nothing usable", () => {
    assert.equal(resolveStartPage(undefined, 10), 1);
    assert.equal(resolveStartPage({ lastPage: 0 }, 10), 1);
    assert.equal(resolveStartPage({ lastPage: -3 }, 10), 1);
    assert.equal(resolveStartPage({ lastPage: 2.5 }, 10), 1);
    assert.equal(resolveStartPage({ lastPage: "4" }, 10), 1);
  });

  it("never returns zero for an empty book", () => {
    assert.equal(resolveStartPage({ lastPage: 3 }, 0), 1);
  });
});

describe("recent list", () => {
  const entry = (pathKey) => ({ pathKey, displayName: pathKey, pages: 1 });

  it("moves a reopened book to the front without duplicating it", () => {
    const history = [entry("a"), entry("b"), entry("c")];
    assert.deepEqual(
      upsertHistory(history, entry("b")).map((item) => item.pathKey),
      ["b", "a", "c"],
    );
  });

  it("keeps the list bounded", () => {
    let history = [];
    for (let index = 0; index < 8; index += 1) history = upsertHistory(history, entry(`book-${index}`), 5);
    assert.equal(history.length, 5);
    assert.equal(history[0].pathKey, "book-7");
  });

  it("does not mutate the list it is given", () => {
    const history = [entry("a")];
    upsertHistory(history, entry("b"));
    assert.deepEqual(history.map((item) => item.pathKey), ["a"]);
  });

  it("describes an unread entry honestly", () => {
    assert.equal(describeHistoryEntry({ pages: 0 }), "unread");
    assert.equal(describeHistoryEntry({ pages: 1 }), "1 page");
    assert.equal(describeHistoryEntry({ pages: 12 }), "12 pages");
  });
});

describe("bookmarks", () => {
  const bookmark = (id, page, name) => ({ id, page, name, createdAt: "2026-01-01T00:00:00.000Z" });

  it("drops bookmarks for books no longer remembered", () => {
    const bookmarks = { a: [bookmark("1", 2, "two")], b: [bookmark("2", 3, "three")] };
    assert.deepEqual(Object.keys(pruneBookmarks(bookmarks, [{ pathKey: "b" }])), ["b"]);
  });

  it("returns bookmarks in page order", () => {
    const bookmarks = { a: [bookmark("2", 9, "nine"), bookmark("1", 2, "two")] };
    assert.deepEqual(
      bookmarksFor(bookmarks, "a").map((item) => item.page),
      [2, 9],
    );
  });

  it("finds a bookmark at a page", () => {
    const bookmarks = { a: [bookmark("1", 2, "two")] };
    assert.equal(findBookmarkAtPage(bookmarks, "a", 2)?.name, "two");
    assert.equal(findBookmarkAtPage(bookmarks, "a", 5), undefined);
    assert.equal(findBookmarkAtPage(bookmarks, "missing", 2), undefined);
  });
});

describe("export and import", () => {
  const entry = (overrides) => ({
    pathKey: "a.cbz",
    path: "a.cbz",
    displayName: "A",
    kind: "archive",
    pages: 10,
    lastPage: 5,
    openedAt: "2026-01-01T00:00:00.000Z",
    readAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  });
  const current = () => ({
    history: [entry()],
    bookmarks: { "a.cbz": [{ id: "1", page: 2, name: "Chapter 1" }] },
    bookSettings: { "a.cbz": { doublePage: true } },
    achievements: { pagesTurned: 10, finished: [], openDays: ["2026-01-01"], nightReading: false, unlocked: {} },
  });

  it("writes a recognisable document", () => {
    const exported = buildLibraryExport({ history: [entry()] }, { at: "2026-03-01T00:00:00.000Z", appVersion: "0.1.0" });
    assert.equal(exported.format, "pageforge-library");
    assert.equal(exported.version, 1);
    assert.equal(exported.exportedAt, "2026-03-01T00:00:00.000Z");
    assert.equal(exported.history.length, 1);
  });

  it("normalises what it writes, so a hand-edited file cannot poison an import", () => {
    const exported = buildLibraryExport(
      { history: [{ pathKey: "x", lastPage: -4, pages: "many", junk: true }, { noPathKey: 1 }, null] },
      {},
    );
    assert.equal(exported.history.length, 1);
    assert.equal(exported.history[0].lastPage, 1);
    assert.equal(exported.history[0].pages, 0);
  });

  it("refuses a document that is not ours", () => {
    const result = mergeLibraryImport(current(), { format: "something-else", history: [] });
    assert.equal(result.unrecognised, true);
    assert.equal(result.library, null);
    assert.equal(mergeLibraryImport(current(), null).unrecognised, true);
    assert.equal(mergeLibraryImport(current(), "text").unrecognised, true);
  });

  it("adds books it has not seen and counts them", () => {
    const result = mergeLibraryImport(current(), {
      format: "pageforge-library",
      history: [entry({ pathKey: "b.cbz", path: "b.cbz", displayName: "B" })],
    });
    assert.equal(result.report.historyAdded, 1);
    assert.equal(result.library.history.length, 2);
  });

  it("keeps the position from whichever copy was read most recently", () => {
    const newer = mergeLibraryImport(current(), {
      format: "pageforge-library",
      history: [entry({ lastPage: 9, readAt: "2026-02-01T00:00:00.000Z" })],
    });
    assert.equal(newer.library.history[0].lastPage, 9, "the newer read wins");

    const older = mergeLibraryImport(current(), {
      format: "pageforge-library",
      history: [entry({ lastPage: 9, readAt: "2025-12-01T00:00:00.000Z" })],
    });
    assert.equal(older.library.history[0].lastPage, 5, "an older file must not move the bookmark back");
  });

  it("unions bookmarks and does not duplicate one already present", () => {
    const result = mergeLibraryImport(current(), {
      format: "pageforge-library",
      history: [],
      bookmarks: {
        "a.cbz": [
          { id: "1", page: 2, name: "Chapter 1" },
          { id: "2", page: 7, name: "Chapter 2" },
        ],
        "c.cbz": [{ id: "3", page: 1, name: "Page 1" }, { id: "4", page: "x", name: "bad" }],
      },
    });
    assert.equal(result.report.bookmarksAdded, 2, "the duplicate and the malformed one are not added");
    assert.equal(result.library.bookmarks["a.cbz"].length, 2);
    assert.equal(result.library.bookmarks["c.cbz"].length, 1);
  });

  it("keeps the layout in use here and only fills books that have none", () => {
    const result = mergeLibraryImport(current(), {
      format: "pageforge-library",
      history: [],
      bookSettings: { "a.cbz": { doublePage: false }, "b.cbz": { rightToLeft: true } },
    });
    assert.equal(result.library.bookSettings["a.cbz"].doublePage, true, "the current layout wins");
    assert.equal(result.library.bookSettings["b.cbz"].rightToLeft, true, "a gap is filled");
  });

  it("never reduces what has been earned", () => {
    const result = mergeLibraryImport(current(), {
      format: "pageforge-library",
      history: [],
      achievements: {
        pagesTurned: 3,
        finished: [{ pathKey: "z.cbz", pages: 100 }],
        openDays: ["2026-01-01", "2026-01-02"],
        nightReading: true,
        unlocked: { "first-page": "2025-01-01T00:00:00.000Z" },
      },
    });
    assert.equal(result.library.achievements.pagesTurned, 10, "the larger count is kept");
    assert.equal(result.library.achievements.finished.length, 1);
    assert.equal(result.report.booksFinishedAdded, 1);
    assert.deepEqual(result.library.achievements.openDays, ["2026-01-01", "2026-01-02"]);
    assert.equal(result.library.achievements.nightReading, true);
    assert.equal(
      result.library.achievements.unlocked["first-page"],
      "2025-01-01T00:00:00.000Z",
      "the earliest date an achievement was earned is kept",
    );
  });

  it("survives a hostile import without corrupting the library", () => {
    const result = mergeLibraryImport(current(), {
      format: "pageforge-library",
      history: [{ pathKey: "ok.cbz", lastPage: 1e9, pages: -5 }, { pathKey: 42 }, "nope"],
      bookmarks: { "a.cbz": "not a list" },
      bookSettings: { "a.cbz": { doublePage: "yes please" } },
      achievements: { pagesTurned: -99, openDays: ["not-a-day"] },
    });
    assert.equal(result.library.history.length, 2);
    assert.equal(result.library.bookmarks["a.cbz"].length, 1, "a bad bookmark list is ignored");
    assert.deepEqual(result.library.achievements.openDays, ["2026-01-01"]);
    assert.equal(result.library.achievements.pagesTurned, 10);
  });
});

describe("grouping books by series", () => {
  const book = (series, number, displayName) => ({ series, number, displayName, pathKey: displayName });
  it("groups by series and orders by issue number", () => {
    const { groups, loose } = groupHistoryBySeries([
      book("Saga", "10", "saga-10"),
      book("Saga", "2", "saga-2"),
      book("Saga", "1", "saga-1"),
      book("Akira", null, "akira"),
    ]);
    assert.equal(loose.length, 0);
    assert.deepEqual(groups.map((g) => g.name), ["Akira", "Saga"]);
    assert.deepEqual(groups[1].entries.map((e) => e.displayName), ["saga-1", "saga-2", "saga-10"]);
  });

  it("keeps books without metadata out of a made-up group", () => {
    const { groups, loose } = groupHistoryBySeries([
      { displayName: "unknown.cbz", pathKey: "unknown" },
      { displayName: "empty", series: "", pathKey: "empty" },
    ]);
    assert.equal(groups.length, 0);
    assert.equal(loose.length, 2);
  });

  it("handles an empty or missing history", () => {
    assert.deepEqual(groupHistoryBySeries([]), { groups: [], loose: [] });
    assert.deepEqual(groupHistoryBySeries(undefined), { groups: [], loose: [] });
  });
});

describe("default preferences", () => {
  it("resumes by default and keeps the thumbnail strip hidden", () => {
    assert.equal(DEFAULT_PREFERENCES.resumeLastPage, true);
    assert.equal(DEFAULT_PREFERENCES.showThumbnails, false);
  });

  it("starts with neutral scan filters and no vertical scroll", () => {
    assert.equal(DEFAULT_PREFERENCES.verticalScroll, false);
    assert.equal(DEFAULT_PREFERENCES.brightness, 1);
    assert.equal(DEFAULT_PREFERENCES.contrast, 1);
    assert.equal(DEFAULT_PREFERENCES.grayscale, 0);
    assert.equal(DEFAULT_PREFERENCES.sepia, 0);
    assert.equal(DEFAULT_PREFERENCES.sharpen, false);
    assert.equal(DEFAULT_PREFERENCES.rememberPerBook, true);
  });
});

describe("per-book layout", () => {
  it("keeps only recognised fields", () => {
    const settings = normalizeBookSettings({
      doublePage: true,
      rightToLeft: true,
      fitMode: "width",
      rotation: 90,
      nonsense: "ignored",
      guidedView: "yes",
    });
    assert.deepEqual(settings, {
      doublePage: true,
      rightToLeft: true,
      fitMode: "width",
      rotation: 90,
    });
  });

  it("rejects an unknown fit mode and clamps rotation", () => {
    assert.equal(normalizeBookSettings({ fitMode: "diagonal" }).fitMode, undefined);
    assert.equal(normalizeBookSettings({ rotation: 1000 }).rotation, 359);
    assert.equal(normalizeBookSettings({ rotation: -5 }).rotation, 0);
  });

  it("returns nothing usable for junk input", () => {
    assert.deepEqual(normalizeBookSettings(null), {});
    assert.deepEqual(normalizeBookSettings("nope"), {});
    assert.deepEqual(normalizeBookSettings({}), {});
  });

  it("drops layout for books that are no longer remembered", () => {
    const kept = pruneBookSettings(
      { "a.cbz": { doublePage: true }, "b.cbz": { rightToLeft: true } },
      [{ pathKey: "a.cbz" }],
    );
    assert.deepEqual(Object.keys(kept), ["a.cbz"]);
  });
});
