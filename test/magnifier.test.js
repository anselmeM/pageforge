/** Unit tests for the magnifier geometry. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { lensPosition, magnifierSample } from "../src/core/magnifier.js";

const natural = { width: 600, height: 900 };

/** The arithmetic can land a hair off due to trigonometry; compare with slack. */
const closeTo = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? "value"}: ${actual} !== ${expected}`);
};

describe("magnifier sampling", () => {
  it("samples the centre when the pointer is at the centre", () => {
    // The element box spans x 200..800 and y 100..1000, so its centre is
    // (500, 550) and the page centre in bitmap space is (300, 450).
    const sample = magnifierSample({
      pointer: { x: 500, y: 550 },
      rect: { left: 200, top: 100, width: 600, height: 900 },
      natural,
      rotation: 0,
      size: 180,
      factor: 3,
    });
    assert.equal(sample.region, 60, "180 / 3 at 1:1");
    closeTo(sample.sourceX, 270, "centred horizontally");
    closeTo(sample.sourceY, 420, "centred vertically");
  });

  it("keeps the window inside the page at the edges", () => {
    const sample = magnifierSample({
      pointer: { x: 200, y: 100 },
      rect: { left: 200, top: 100, width: 600, height: 900 },
      natural,
      rotation: 0,
      size: 180,
      factor: 3,
    });
    assert.equal(sample.sourceX, 0, "clamped at the left edge");
    assert.equal(sample.sourceY, 0, "clamped at the top edge");

    const bottomRight = magnifierSample({
      pointer: { x: 800, y: 1000 },
      rect: { left: 200, top: 100, width: 600, height: 900 },
      natural,
      rotation: 0,
      size: 180,
      factor: 3,
    });
    assert.equal(bottomRight.sourceX, 540, "600 - 60");
    assert.equal(bottomRight.sourceY, 840, "900 - 60");
  });

  it("scales the sampled region with the page", () => {
    const sample = magnifierSample({
      pointer: { x: 500, y: 400 },
      rect: { left: 200, top: 100, width: 300, height: 450 },
      natural,
      rotation: 0,
      size: 180,
      factor: 3,
    });
    assert.equal(sample.scale, 0.5);
    assert.equal(sample.region, 120, "half the on-screen scale means twice the region");
  });

  it("undoes a quarter turn", () => {
    // A 90 degree turn swaps which bitmap axis the pointer's horizontal motion
    // maps onto. The box centre is (650, 400), so the pointer is 50px right of
    // it, which in bitmap space is 50px up.
    const sample = magnifierSample({
      pointer: { x: 700, y: 400 },
      rect: { left: 200, top: 100, width: 900, height: 600 },
      natural,
      rotation: 90,
      size: 180,
      factor: 3,
    });
    assert.equal(sample.scale, 1, "displayed width comes from the rotated height");
    closeTo(sample.sourceX, 270, "horizontal movement left the bitmap x alone");
    closeTo(sample.sourceY, 370, "it moved the bitmap y instead: 450 - 50 - 30");
  });

  it("treats a half turn as unrotated but mirrored", () => {
    // Pointer at the top-left of the box is the bottom-right of the bitmap.
    const sample = magnifierSample({
      pointer: { x: 100, y: 100 },
      rect: { left: 0, top: 0, width: 600, height: 900 },
      natural,
      rotation: 180,
      size: 180,
      factor: 3,
    });
    closeTo(sample.sourceX, 470, "the far side of the page");
    closeTo(sample.sourceY, 770);
  });

  it("refuses to sample an unmeasurable page", () => {
    assert.equal(
      magnifierSample({
        pointer: { x: 0, y: 0 },
        rect: { left: 0, top: 0, width: 0, height: 0 },
        natural,
        rotation: 0,
        size: 180,
        factor: 3,
      }),
      null,
    );
    assert.equal(
      magnifierSample({
        pointer: { x: 0, y: 0 },
        rect: { left: 0, top: 0, width: 100, height: 100 },
        natural: { width: 0, height: 0 },
        rotation: 0,
        size: 180,
        factor: 3,
      }),
      null,
    );
  });

  it("never asks for a sub-pixel window", () => {
    const sample = magnifierSample({
      pointer: { x: 0, y: 0 },
      rect: { left: 0, top: 0, width: 6000, height: 9000 },
      natural,
      rotation: 0,
      size: 180,
      factor: 6,
    });
    assert.equal(sample.region, 8);
  });
});

describe("lens placement", () => {
  const stageRect = { left: 0, top: 0, width: 1000, height: 800 };

  it("centres on the pointer", () => {
    assert.deepEqual(lensPosition({ pointer: { x: 500, y: 400 }, stageRect, size: 180 }), {
      left: 410,
      top: 310,
    });
  });

  it("stays inside the reading area at the corners", () => {
    assert.deepEqual(lensPosition({ pointer: { x: 0, y: 0 }, stageRect, size: 180 }), {
      left: 0,
      top: 0,
    });
    assert.deepEqual(lensPosition({ pointer: { x: 1000, y: 800 }, stageRect, size: 180 }), {
      left: 820,
      top: 620,
    });
  });

  it("pins to the corner when the lens is larger than the area", () => {
    assert.deepEqual(lensPosition({ pointer: { x: 50, y: 50 }, stageRect, size: 1200 }), {
      left: 0,
      top: 0,
    });
  });
});
