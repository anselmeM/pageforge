/** Unit tests for the library rules: position resolution, recents, bookmarks. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_PREFERENCES,
  bookmarksFor,
  describeHistoryEntry,
  findBookmarkAtPage,
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
