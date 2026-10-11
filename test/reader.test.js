/**
 * Reader tests: open real generated archives and folders, and assert what the
 * viewer would receive. Nothing here is mocked — the fixture is a genuine ZIP
 * containing genuine PNG and BMP files.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { openTarget, ReaderError } from "../src/main/reader.js";
import { writeFixture } from "../scripts/make-fixture.mjs";

let workspace = null;
let fixture = null;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pageforge-test-"));
  fixture = await writeFixture(workspace);
});

after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true });
});

describe("archive reading", () => {
  it("lists real pages in natural order and ignores packaging noise", async () => {
    const reader = await openTarget(fixture.archive);
    try {
      assert.equal(reader.kind, "archive");
      assert.deepEqual(
        reader.pages.map((page) => page.name),
        ["page01.png", "page02.png", "page03.png", "page10.png"],
      );
    } finally {
      await reader.close();
    }
  });

  it("reports page dimensions read from the headers", async () => {
    const reader = await openTarget(fixture.archive);
    try {
      assert.deepEqual(
        reader.pages.map((page) => [page.format, page.width, page.height]),
        [
          ["png", 600, 900],
          ["png", 600, 900],
          ["png", 1200, 800],
          ["png", 600, 900],
        ],
      );
    } finally {
      await reader.close();
    }
  });

  it("returns the page bytes unchanged", async () => {
    const reader = await openTarget(fixture.archive);
    try {
      const bytes = await reader.readPage(0);
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.ok(bytes.length > 8);
    } finally {
      await reader.close();
    }
  });

  it("rejects a page index that does not exist", async () => {
    const reader = await openTarget(fixture.archive);
    try {
      await assert.rejects(() => reader.readPage(99), (error) => error.code === "page-out-of-range");
    } finally {
      await reader.close();
    }
  });

  it("names the archive in the payload", async () => {
    const reader = await openTarget(fixture.archive);
    try {
      assert.equal(reader.displayName, "sample.cbz");
      assert.equal(reader.targetPath, fixture.archive);
    } finally {
      await reader.close();
    }
  });
});

describe("folder reading", () => {
  it("reads images including nested folders", async () => {
    const reader = await openTarget(fixture.folder);
    try {
      assert.equal(reader.kind, "folder");
      assert.deepEqual(
        reader.pages.map((page) => page.name),
        ["nested/page20.bmp", "page01.png", "page02.png", "page03.png", "page10.png"],
      );
    } finally {
      await reader.close();
    }
  });

  it("reads BMP dimensions too", async () => {
    const reader = await openTarget(fixture.folder);
    try {
      const nested = reader.pages.find((page) => page.name.endsWith(".bmp"));
      assert.deepEqual([nested.format, nested.width, nested.height], ["bmp", 700, 500]);
    } finally {
      await reader.close();
    }
  });
});

describe("seven-zip (CB7) reading", () => {
  it("reads the same pages out of a 7z archive", async () => {
    const reader = await openTarget(fixture.sevenZip);
    try {
      assert.equal(reader.kind, "archive");
      assert.equal(reader.format, "7z");
      assert.equal(reader.displayName, "sample.cb7");
      assert.deepEqual(
        reader.pages.map((page) => [page.name, page.width, page.height]),
        [
          ["page01.png", 600, 900],
          ["page02.png", 600, 900],
          ["page03.png", 1200, 800],
          ["page10.png", 600, 900],
        ],
      );
    } finally {
      await reader.close();
    }
  });

  it("returns decodable page bytes", async () => {
    const reader = await openTarget(fixture.sevenZip);
    try {
      const bytes = await reader.readPage(2);
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.ok(bytes.length > 100);
    } finally {
      await reader.close();
    }
  });
});

describe("rar (CBR) reading", () => {
  it("reads a real RAR archive, or says why it cannot", async (context) => {
    if (fixture.rar === null) {
      context.skip(
        "no RAR compressor installed (WinRAR's Rar.exe or PAGEFORGE_RAR_EXE); CBR stays unverified",
      );
      return;
    }
    const reader = await openTarget(fixture.rar);
    try {
      assert.equal(reader.kind, "archive");
      assert.equal(reader.format, "rar");
      assert.deepEqual(
        reader.pages.map((page) => [page.name, page.width, page.height, page.format]),
        [
          ["page01.png", 600, 900, "png"],
          ["page02.png", 600, 900, "png"],
          ["page03.png", 1200, 800, "png"],
          ["page10.png", 600, 900, "png"],
        ],
      );
      const bytes = await reader.readPage(0);
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    } finally {
      await reader.close();
    }
  });
});

describe("staged archive ownership", () => {
  it("removes its extraction directory when closed", async () => {
    const stagingDirectories = async () =>
      (await readdir(tmpdir())).filter((name) => name.startsWith("pageforge-extract-"));
    const before = new Set(await stagingDirectories());

    const reader = await openTarget(fixture.sevenZip);
    const during = await stagingDirectories();
    const created = during.filter((name) => !before.has(name));
    assert.equal(created.length, 1, "expected one staging directory while open");
    await reader.close();

    const after = await stagingDirectories();
    for (const name of created) {
      assert.equal(after.includes(name), false, `staging directory ${name} outlived close()`);
    }
  });
});

describe("reader failures", () => {
  it("explains that other archive formats are not readable yet", async () => {
    const target = join(workspace, "volume.cbt");
    await writeFile(target, Buffer.from("not really a tar", "utf8"));
    await assert.rejects(
      () => openTarget(target),
      (error) => error instanceof ReaderError && error.code === "format-not-supported-yet",
    );
  });

  it("reports a folder with no pages", async () => {
    const empty = join(workspace, "empty");
    await mkdir(empty, { recursive: true });
    await writeFile(join(empty, "notes.txt"), "nothing to read", "utf8");
    await assert.rejects(
      () => openTarget(empty),
      (error) => error instanceof ReaderError && error.code === "no-pages",
    );
  });

  it("reports an archive that is not a zip", async () => {
    const target = join(workspace, "broken.cbz");
    await writeFile(target, Buffer.from("this is not a zip file at all", "utf8"));
    await assert.rejects(
      () => openTarget(target),
      (error) => error instanceof ReaderError && error.code === "archive-unreadable",
    );
  });
});
