/**
 * Thumbnail strip geometry tests.
 *
 * The strip exists so a thousand-page book is not a thousand elements, so the
 * window calculation is the whole feature. It was previously unreachable without a
 * browser, which is why it went in untested.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  THUMB_OVERSCAN,
  THUMB_SLOT,
  THUMB_WIDTH,
  railWidth,
  revealScrollLeft,
  thumbnailOffset,
  thumbnailWindow,
} from "../src/core/thumbnails.js";

/** A viewport wide enough for exactly ten thumbnails. */
const viewportWidth = THUMB_SLOT * 10;

describe("thumbnail window", () => {
  it("mounts the visible thumbnails plus the overscan", () => {
    const { first, last } = thumbnailWindow({ count: 240, scrollLeft: 0, viewportWidth });
    assert.equal(first, 0, "nothing before the start");
    assert.equal(last, 10 + THUMB_OVERSCAN, "ten visible and the overscan after");
  });

  it("mounts a bounded number for a very large book", () => {
    const { first, last } = thumbnailWindow({ count: 5000, scrollLeft: 0, viewportWidth });
    assert.ok(last - first < 20, `mounted ${last - first + 1} elements for a 5000-page book`);
  });

  it("follows the scroll position", () => {
    const { first, last } = thumbnailWindow({ count: 240, scrollLeft: THUMB_SLOT * 100, viewportWidth });
    assert.equal(first, 100 - THUMB_OVERSCAN);
    assert.equal(last, 110 + THUMB_OVERSCAN);
  });

  it("never runs past the end of the book", () => {
    const { first, last } = thumbnailWindow({ count: 12, scrollLeft: THUMB_SLOT * 100, viewportWidth });
    assert.equal(last, 11, "the last page is the last element");
    assert.ok(first <= last);
  });

  it("mounts nothing for an empty book", () => {
    const { first, last } = thumbnailWindow({ count: 0, scrollLeft: 0, viewportWidth });
    assert.equal(last, first - 1, "last is before first, so a loop mounts nothing");
    assert.equal(thumbnailWindow({ count: 0, scrollLeft: 0, viewportWidth }).first, 0);
  });

  it("survives nonsense inputs rather than mounting the wrong range", () => {
    assert.deepEqual(thumbnailWindow({ count: 5, scrollLeft: Number.NaN, viewportWidth }).first, 0);
    assert.deepEqual(thumbnailWindow({ count: 5, scrollLeft: -500, viewportWidth }).first, 0);
    assert.equal(thumbnailWindow({ count: 5, scrollLeft: 0, viewportWidth: Number.NaN }).last, THUMB_OVERSCAN);
    assert.equal(thumbnailWindow({}).last, -1);
  });

  it("keeps the overscan on both sides of the visible window", () => {
    const { first, last } = thumbnailWindow({ count: 240, scrollLeft: THUMB_SLOT * 50, viewportWidth });
    assert.ok(first < 50, "mounts behind the visible window too, so scrolling up is smooth");
    assert.ok(last > 60);
  });
});

describe("rail geometry", () => {
  it("places each thumbnail one slot apart", () => {
    assert.equal(thumbnailOffset(0), 0);
    assert.equal(thumbnailOffset(3), THUMB_SLOT * 3);
  });

  it("does not leave a trailing gap after the last thumbnail", () => {
    assert.equal(railWidth(1), THUMB_WIDTH);
    assert.equal(railWidth(10), THUMB_SLOT * 10 - (THUMB_SLOT - THUMB_WIDTH));
  });

  it("is zero wide for an empty book", () => {
    assert.equal(railWidth(0), 0);
  });
});

describe("revealing a thumbnail", () => {
  it("leaves the scroll alone when it is already visible", () => {
    const scrollLeft = revealScrollLeft({ index: 3, scrollLeft: 0, viewportWidth });
    assert.equal(scrollLeft, null, "null means nothing to do");
  });

  it("scrolls back when the thumbnail is before the window", () => {
    const scrollLeft = revealScrollLeft({ index: 2, scrollLeft: THUMB_SLOT * 20, viewportWidth });
    assert.equal(scrollLeft, THUMB_SLOT * 2, "it moves to the very left");
  });

  it("scrolls forward just far enough when it is after the window", () => {
    const scrollLeft = revealScrollLeft({ index: 40, scrollLeft: 0, viewportWidth });
    assert.equal(scrollLeft, THUMB_SLOT * 40 + THUMB_WIDTH - viewportWidth, "it moves to the very right");
  });

  it("knows the difference between visible and not", () => {
    const viewport = THUMB_SLOT * 10;
    assert.equal(revealScrollLeft({ index: 9, scrollLeft: 0, viewportWidth: viewport }), null);
    assert.notEqual(revealScrollLeft({ index: 10, scrollLeft: 0, viewportWidth: viewport }), null);
  });
});
