/**
 * Index cache tests.
 *
 * The cache exists to skip re-reading every page of an archive, so the tests that
 * matter are the ones about knowing when it may be trusted: a changed file must
 * miss, and a cache that cannot work at all must not stop the reader.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { openIndexCache } from "../src/main/index-cache.js";

let workspace = null;
let directory = null;
let cache = null;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pageforge-cache-"));
  directory = join(workspace, "state");
  cache = await openIndexCache({ directory });
});

after(async () => {
  cache?.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

const stats = (size, mtimeMs) => ({ size, mtimeMs });
const pages = [
  { name: "page01.jpg", bytes: 1000, width: 800, height: 1200, format: "jpg" },
  { name: "page02.jpg", bytes: 2000, width: 900, height: 1300, format: "jpg" },
];

describe("index cache", () => {
  it("is enabled where node:sqlite is available", () => {
    assert.equal(cache.enabled, true, `cache disabled: ${cache.reason}`);
  });

  it("misses on an archive it has never seen", () => {
    assert.equal(cache.lookup("/comics/unknown.cbz", stats(10, 20)), null);
  });

  it("returns what was stored, in order", () => {
    const target = "/comics/one.cbz";
    assert.equal(cache.store(target, stats(500, 1000), pages), true);
    const hit = cache.lookup(target, stats(500, 1000));
    assert.notEqual(hit, null);
    assert.deepEqual(hit.pages, pages);
    assert.equal(hit.pages[0].name, "page01.jpg");
    assert.equal(hit.pages[1].name, "page02.jpg");
  });

  it("misses when the archive changed size", () => {
    const target = "/comics/one.cbz";
    assert.equal(cache.lookup(target, stats(501, 1000)), null);
  });

  it("misses when the archive changed modification time", () => {
    const target = "/comics/one.cbz";
    assert.equal(cache.lookup(target, stats(500, 1001)), null);
  });

  it("replaces the entry rather than adding a second one", () => {
    const target = "/comics/two.cbz";
    cache.store(target, stats(10, 10), pages);
    const replacement = [{ name: "only.jpg", bytes: 5, width: 10, height: 20, format: "jpg" }];
    cache.store(target, stats(11, 11), replacement);
    const hit = cache.lookup(target, stats(11, 11));
    assert.equal(hit.pages.length, 1);
    assert.equal(hit.pages[0].name, "only.jpg");
    assert.equal(cache.lookup(target, stats(10, 10)), null, "the replaced entry is gone");
  });

  it("keeps the book's metadata alongside its pages", () => {
    const target = "/comics/manga.cbz";
    const comicInfo = { series: "Test Manga", number: "3", direction: "rtl" };
    cache.store(target, stats(9, 9), pages, comicInfo);
    assert.deepEqual(cache.lookup(target, stats(9, 9)).comicInfo, comicInfo);
  });

  it("reports null metadata when the archive had none", () => {
    const target = "/comics/plain.cbz";
    cache.store(target, stats(8, 8), pages, null);
    assert.equal(cache.lookup(target, stats(8, 8)).comicInfo, null);
  });

  it("forgets a single archive", () => {
    const target = "/comics/forget.cbz";
    cache.store(target, stats(7, 7), pages);
    assert.notEqual(cache.lookup(target, stats(7, 7)), null);
    assert.equal(cache.forget(target), true);
    assert.equal(cache.lookup(target, stats(7, 7)), null);
  });

  it("counts what it holds", () => {
    const before = cache.stats();
    assert.ok(before.books >= 1);
    assert.ok(before.pages >= 1);
  });

  it("clears everything", () => {
    const cleared = cache.clear();
    assert.ok(cleared >= 1, `expected pages to be cleared, got ${cleared}`);
    const after = cache.stats();
    assert.deepEqual(after, { books: 0, pages: 0 });
    assert.equal(cache.lookup("/comics/one.cbz", stats(500, 1000)), null);
  });

  it("survives being closed twice", () => {
    const second = join(workspace, "state-2");
    return openIndexCache({ directory: second }).then((other) => {
      other.close();
      other.close();
      assert.equal(other.enabled, true);
    });
  });

  it("stays usable when the database file cannot be created", async () => {
    // A path that is a file, not a directory: sqlite cannot open inside it.
    const blocker = join(workspace, "not-a-directory");
    await writeFile(blocker, "x");
    const broken = await openIndexCache({ directory: join(blocker, "nested") });
    assert.equal(broken.enabled, false);
    // Every method must still answer, so the reader probes as usual.
    assert.equal(broken.lookup("/a.cbz", stats(1, 1)), null);
    assert.equal(broken.store("/a.cbz", stats(1, 1), pages), false);
    assert.equal(broken.forget("/a.cbz"), false);
    assert.equal(broken.clear(), 0);
    assert.deepEqual(broken.stats(), { books: 0, pages: 0 });
    assert.doesNotThrow(() => broken.close());
  });
});
