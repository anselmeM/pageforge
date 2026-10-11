/**
 * Reader lifecycle tests.
 *
 * A page read and a close can overlap: the viewer prefetches pages, and the
 * thumbnails request many at once, so closing a book while requests are in
 * flight is normal. The underlying file handle must not be released underneath a
 * read, or the failure surfaces as an unhandled exception inside an fs callback
 * rather than as a rejected promise the caller can report.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { openTarget } from "../src/main/reader.js";
import { pngBytes, writeFixture, zipBytes } from "../scripts/make-fixture.mjs";

let workspace = null;
let fixture = null;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pageforge-lifecycle-"));
  fixture = await writeFixture(workspace);
});

after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true });
});

/** A bigger archive, so reads stay in flight long enough to overlap a close. */
const bigArchive = async () => {
  const entries = [];
  for (let index = 0; index < 24; index += 1) {
    entries.push({
      name: `page${String(index).padStart(2, "0")}.png`,
      data: pngBytes(1200, 1800, [index * 7, 90, 200 - index * 5]),
    });
  }
  const path = join(workspace, "big.cbz");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, zipBytes(entries));
  return path;
};

/**
 * Entries far larger than the probe reads.
 *
 * The reader learns a page's size by reading the first few kilobytes of its
 * entry. Ending that read early is what used to leave a queued read pointing at
 * a released stream context, which surfaced as an uncaught exception inside an
 * fs callback rather than as a rejected promise.
 */
const wideArchive = async () => {
  const { writeFile } = await import("node:fs/promises");
  const entries = [];
  for (let index = 0; index < 10; index += 1) {
    const data = Buffer.alloc(3 * 1024 * 1024);
    for (let at = 0; at < data.length; at += 1) data[at] = (at * 31 + index * 17) & 0xff;
    entries.push({ name: `page${String(index).padStart(2, "0")}.png`, data });
  }
  const path = join(workspace, "wide.cbz");
  await writeFile(path, zipBytes(entries));
  return path;
};

describe("closing while reads are in flight", () => {
  it("settles in-flight reads instead of failing inside a file callback", async () => {
    const reader = await openTarget(fixture.archive);
    const reads = reader.pages.map((_, index) => reader.readPage(index));
    const closing = reader.close();
    const settled = await Promise.allSettled(reads);
    await closing;

    for (const [index, result] of settled.entries()) {
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof Error, `read ${index} rejected with a non-Error`);
      }
    }
  });

  it("survives many overlapping reads racing a close", async () => {
    const reader = await openTarget(await bigArchive());
    const reads = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      reads.push(reader.readPage(attempt % reader.pages.length));
    }
    const closing = reader.close();
    const settled = await Promise.allSettled(reads);
    await closing;
    assert.equal(settled.length, 60);
  });

  it("reports a read after close as a normal rejection", async () => {
    const reader = await openTarget(fixture.archive);
    await reader.close();
    await assert.rejects(() => reader.readPage(0), (error) => error instanceof Error);
  });

  it("keeps working when reads finish before the close", async () => {
    const reader = await openTarget(fixture.archive);
    const bytes = await reader.readPage(0);
    await reader.close();
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  });
});

/**
 * A deflated archive of noisy pages, which is what a real CBZ looks like.
 *
 * Deflate entries are piped through zlib by the reader, so the underlying file
 * read can be asked for more data while a read is already in flight. That is the
 * shape of archive that exposes a stream released underneath a pending read.
 */
const noisyArchive = async (pages = 12, bytes = 900 * 1024) => {
  const { writeFile } = await import("node:fs/promises");
  const entries = [];
  for (let index = 0; index < pages; index += 1) {
    const data = Buffer.alloc(bytes);
    let value = index * 7919 + 13;
    for (let at = 0; at < data.length; at += 1) {
      value = (value * 1103515245 + 12345) & 0x7fffffff;
      data[at] = value & 0xff;
    }
    entries.push({ name: `page${String(index).padStart(3, "0")}.png`, data });
  }
  const path = join(workspace, "noisy.cbz");
  // Noisy data barely compresses, so the entries stay large and multi-chunk.
  await writeFile(path, zipBytes(entries, { deflate: true }));
  return path;
};

describe("deflated archives", () => {
  it("reads every page of a deflated archive", async () => {
    const reader = await openTarget(await noisyArchive(6, 256 * 1024));
    try {
      assert.equal(reader.pages.length, 6);
      for (const page of reader.pages) {
        const bytes = await reader.readPage(page.index);
        assert.equal(bytes.length >= 256 * 1024, true, `page ${page.index} came back short`);
      }
    } finally {
      await reader.close();
    }
  });

  it("closes a deflated archive while reads are still in flight", async () => {
    const reader = await openTarget(await noisyArchive());
    const reads = reader.pages.map((page) => reader.readPage(page.index));
    const closing = reader.close();
    const settled = await Promise.allSettled(reads);
    await closing;
    assert.equal(settled.length, reader.pages.length);
  });

  it("does not crash when a deflated archive is closed mid-probe", async () => {
    // Opening starts header probes; closing immediately once the pages are
    // listed leaves those probes overlapping the close.
    const path = await noisyArchive(10, 400 * 1024);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reader = await openTarget(path);
      const reads = reader.pages.slice(0, 4).map((page) => reader.readPage(page.index));
      await reader.close();
      await Promise.allSettled(reads);
    }
  });
});

describe("probing entries larger than the probe read", () => {
  it("opens an archive whose pages dwarf the header probe without crashing", async () => {
    const reader = await openTarget(await wideArchive());
    try {
      assert.equal(reader.pages.length, 10, "every page is listed");
      // The probe cannot identify random bytes as an image, which is fine: the
      // point is that ending the read early must not break the stream machinery.
      assert.equal(reader.pages.every((page) => page.format === null), true);
      const bytes = await reader.readPage(0);
      assert.equal(bytes.length, 3 * 1024 * 1024, "and pages are still fully readable");
    } finally {
      await reader.close();
    }
  });
});
