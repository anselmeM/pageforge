/**
 * Unit tests for the pure layout and format logic.
 *
 * These are the parts that decide page order, spread grouping and zoom bounds,
 * so they are tested directly rather than through the window.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clampScale, fitScale, zoomStep } from "../src/core/fit.js";
import { imageSize, mimeForFormat, sniffImageFormat } from "../src/core/imageSize.js";
import { compareNatural, sortNatural } from "../src/core/naturalSort.js";
import { extensionOf, isPageCandidate, selectPages } from "../src/core/pages.js";
import { buildSpreads, isLandscape, spreadIndexForPage, visualOrder } from "../src/core/spread.js";
import { clampPan, panBounds, zoomAtPoint } from "../src/core/viewport.js";
import { bmpBytes, pngBytes } from "../scripts/make-fixture.mjs";

describe("natural sort", () => {
  it("orders digit runs numerically", () => {
    assert.deepEqual(sortNatural(["page10.png", "page2.png", "page1.png"]), [
      "page1.png",
      "page2.png",
      "page10.png",
    ]);
  });

  it("compares letters case-insensitively", () => {
    assert.equal(compareNatural("Chapter.png", "chapter.png"), 0);
    assert.ok(compareNatural("a.png", "B.png") < 0);
  });

  it("breaks equal numeric runs deterministically", () => {
    assert.ok(compareNatural("page1.png", "page01.png") < 0);
    assert.ok(compareNatural("page01.png", "page1.png") > 0);
  });

  it("does not mutate the input array", () => {
    const input = ["b2", "b1"];
    sortNatural(input);
    assert.deepEqual(input, ["b2", "b1"]);
  });
});

describe("page selection", () => {
  it("keeps images in natural order and drops packaging noise", () => {
    const entries = [
      "page10.png",
      "readme.txt",
      ".DS_Store",
      "__MACOSX/._page01.png",
      "page2.jpg",
      "page1.PNG",
    ];
    assert.deepEqual(selectPages(entries), ["page1.PNG", "page2.jpg", "page10.png"]);
  });

  it("rejects directories and unknown extensions", () => {
    assert.equal(isPageCandidate("pages/"), false);
    assert.equal(isPageCandidate("cover.psd"), false);
    assert.equal(isPageCandidate("thumbs.db"), false);
    assert.equal(extensionOf("a/b/c.JPEG"), ".jpeg");
    assert.equal(extensionOf("noextension"), "");
  });
});

describe("image header parsing", () => {
  it("reads PNG dimensions", () => {
    const parsed = imageSize(pngBytes(600, 900));
    assert.deepEqual(parsed, { format: "png", width: 600, height: 900 });
  });

  it("reads BMP dimensions", () => {
    const parsed = imageSize(bmpBytes(700, 500));
    assert.deepEqual(parsed, { format: "bmp", width: 700, height: 500 });
  });

  it("reads GIF dimensions", () => {
    const header = Buffer.alloc(13);
    header.write("GIF89a", 0, "latin1");
    header.writeUInt16LE(320, 6);
    header.writeUInt16LE(240, 8);
    assert.deepEqual(imageSize(header), { format: "gif", width: 320, height: 240 });
  });

  it("reads JPEG frame dimensions", () => {
    const segment = Buffer.alloc(19);
    segment.writeUInt16BE(0xffd8, 0); // SOI
    segment.writeUInt16BE(0xffc0, 2); // SOF0
    segment.writeUInt16BE(17, 4); // segment length
    segment[6] = 8; // precision
    segment.writeUInt16BE(1080, 7); // height
    segment.writeUInt16BE(1920, 9); // width
    segment[11] = 3; // components
    assert.deepEqual(imageSize(segment), { format: "jpeg", width: 1920, height: 1080 });
  });

  it("reads extended WebP canvas dimensions", () => {
    const header = Buffer.alloc(30);
    header.write("RIFF", 0, "latin1");
    header.write("WEBP", 8, "latin1");
    header.write("VP8X", 12, "latin1");
    const width = 1600 - 1;
    const height = 2400 - 1;
    header[24] = width & 0xff;
    header[25] = (width >> 8) & 0xff;
    header[26] = (width >> 16) & 0xff;
    header[27] = height & 0xff;
    header[28] = (height >> 8) & 0xff;
    header[29] = (height >> 16) & 0xff;
    assert.deepEqual(imageSize(header), { format: "webp", width: 1600, height: 2400 });
  });

  it("reports an unknown format instead of guessing", () => {
    assert.equal(sniffImageFormat(Buffer.from("not an image at all")), null);
    assert.equal(imageSize(Buffer.from("not an image at all")), null);
  });

  it("reports a truncated header as unknown", () => {
    const full = pngBytes(600, 900);
    assert.equal(imageSize(full.subarray(0, 12)), null);
  });

  it("maps formats to content types", () => {
    assert.equal(mimeForFormat("jpeg"), "image/jpeg");
    assert.equal(mimeForFormat("png"), "image/png");
    assert.equal(mimeForFormat("unknown"), "application/octet-stream");
  });
});

describe("spread layout", () => {
  const portrait = { width: 600, height: 900 };
  const landscape = { width: 1200, height: 800 };
  const pages = [portrait, portrait, landscape, portrait, portrait, portrait];

  it("uses one page per spread in single-page mode", () => {
    const spreads = buildSpreads(pages, { doublePage: false });
    assert.equal(spreads.length, 6);
    assert.deepEqual(spreads[0], { indices: [0] });
  });

  it("pairs consecutive portrait pages in double-page mode", () => {
    const spreads = buildSpreads([portrait, portrait, portrait, portrait], { doublePage: true });
    assert.deepEqual(spreads, [{ indices: [0, 1] }, { indices: [2, 3] }]);
  });

  it("gives a landscape page a spread of its own", () => {
    const spreads = buildSpreads(pages, { doublePage: true });
    assert.deepEqual(spreads, [
      { indices: [0, 1] },
      { indices: [2] },
      { indices: [3, 4] },
      { indices: [5] },
    ]);
  });

  it("can show the first page alone before pairing", () => {
    const spreads = buildSpreads([portrait, portrait, portrait], { doublePage: true, coverAlone: true });
    assert.deepEqual(spreads, [{ indices: [0] }, { indices: [1, 2] }]);
  });

  it("does not join across a landscape break", () => {
    const spreads = buildSpreads([landscape, portrait, portrait], { doublePage: true });
    assert.deepEqual(spreads, [{ indices: [0] }, { indices: [1, 2] }]);
  });

  it("locates the spread holding a page", () => {
    const spreads = buildSpreads(pages, { doublePage: true });
    assert.equal(spreadIndexForPage(spreads, 3), 2);
    assert.equal(spreadIndexForPage(spreads, 99), -1);
  });

  it("reverses placement for right-to-left reading", () => {
    assert.deepEqual(visualOrder({ indices: [4, 5] }, false), [4, 5]);
    assert.deepEqual(visualOrder({ indices: [4, 5] }, true), [5, 4]);
  });

  it("treats an unknown size as portrait rather than landscape", () => {
    assert.equal(isLandscape({ width: 0, height: 0 }), false);
  });
});

describe("fit and zoom", () => {
  const viewport = { width: 1000, height: 800 };

  it("contains the whole page when fitting the screen", () => {
    assert.equal(fitScale("screen", { width: 2000, height: 1000 }, viewport), 0.5);
  });

  it("fits a single axis on request", () => {
    assert.equal(fitScale("width", { width: 2000, height: 1000 }, viewport), 0.5);
    assert.equal(fitScale("height", { width: 2000, height: 1000 }, viewport), 0.8);
  });

  it("falls back to actual size for a degenerate page or viewport", () => {
    assert.equal(fitScale("screen", { width: 0, height: 0 }, viewport), 1);
    assert.equal(fitScale("screen", { width: 100, height: 100 }, { width: 0, height: 0 }), 1);
  });

  it("honours actual size", () => {
    assert.equal(fitScale("original", { width: 4000, height: 6000 }, viewport), 1);
  });

  it("clamps to the supported zoom range", () => {
    assert.equal(clampScale(100), 8);
    assert.equal(clampScale(0.0001), 0.05);
    assert.equal(clampScale(1.5), 1.5);
    assert.ok(zoomStep(1, 1) > 1);
    assert.ok(zoomStep(1, -1) < 1);
  });
});

describe("pan and zoom bounds", () => {
  it("keeps a page smaller than the viewport centred", () => {
    const bounds = panBounds({ width: 400, height: 300 }, { width: 1000, height: 800 });
    assert.deepEqual(bounds, { maxX: 0, maxY: 0 });
    assert.deepEqual(clampPan({ x: 500, y: -500 }, { width: 400, height: 300 }, { width: 1000, height: 800 }), {
      x: 0,
      y: 0,
    });
  });

  it("allows panning up to half the overflow", () => {
    const content = { width: 1400, height: 1200 };
    const viewport = { width: 1000, height: 800 };
    assert.deepEqual(panBounds(content, viewport), { maxX: 200, maxY: 200 });
    assert.deepEqual(clampPan({ x: 999, y: -999 }, content, viewport), { x: 200, y: -200 });
  });

  it("adds the overscroll margin", () => {
    assert.deepEqual(panBounds({ width: 1000, height: 800 }, { width: 1000, height: 800 }, 50), {
      maxX: 50,
      maxY: 50,
    });
  });

  it("keeps the point under the cursor fixed while zooming", () => {
    const next = zoomAtPoint(1, { x: 0, y: 0 }, 2, { x: 100, y: 0 });
    assert.deepEqual(next, { x: -100, y: 0 });
    const unchanged = zoomAtPoint(2, { x: -100, y: 0 }, 1, { x: 100, y: 0 });
    assert.deepEqual(unchanged, { x: 0, y: 0 });
  });

  it("ignores a degenerate current scale", () => {
    assert.deepEqual(zoomAtPoint(0, { x: 5, y: 7 }, 2, { x: 1, y: 1 }), { x: 5, y: 7 });
  });
});
