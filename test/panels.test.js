/**
 * Panel detection and guided-view camera tests.
 *
 * Pages are synthesised as raw RGBA so the detector is tested directly. Panels
 * are drawn with a checkerboard texture rather than a flat colour, because a
 * flat region has no variance and would read as a gutter — which is the whole
 * basis of the detection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PANEL_DEFAULTS, detectPanels, framePanel, isWorthGuiding, panelStripRows, panelsFormStrip, sortPanels } from "../src/core/panels.js";

const WHITE = 255;
const BLACK = 0;

/** A page of flat white with textured rectangles drawn on it. */
const page = (width, height) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let at = 0; at < data.length; at += 4) {
    data[at] = WHITE;
    data[at + 1] = WHITE;
    data[at + 2] = WHITE;
    data[at + 3] = 255;
  }
  const artwork = (x, y, w, h) => {
    for (let row = y; row < y + h; row += 1) {
      for (let column = x; column < x + w; column += 1) {
        const value = (row + column) % 2 === 0 ? BLACK : WHITE;
        const at = (row * width + column) * 4;
        data[at] = value;
        data[at + 1] = value;
        data[at + 2] = value;
      }
    }
  };
  return { data, width, height, artwork };
};

const closeTo = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not within ${tolerance} of ${expected}`,
  );

const matchesBox = (panel, box, tolerance = 4) => {
  closeTo(panel.x, box.x, tolerance, "x");
  closeTo(panel.y, box.y, tolerance, "y");
  closeTo(panel.width, box.width, tolerance, "width");
  closeTo(panel.height, box.height, tolerance, "height");
};

describe("panel detection", () => {
  it("finds a two by two grid and returns it in reading order", () => {
    const image = page(420, 420);
    for (const [x, y] of [
      [0, 0],
      [220, 0],
      [0, 220],
      [220, 220],
    ]) {
      image.artwork(x, y, 200, 200);
    }
    const panels = detectPanels(image);
    assert.equal(panels.length, 4);
    matchesBox(panels[0], { x: 0, y: 0, width: 200, height: 200 });
    matchesBox(panels[1], { x: 220, y: 0, width: 200, height: 200 });
    matchesBox(panels[2], { x: 0, y: 220, width: 200, height: 200 });
    matchesBox(panels[3], { x: 220, y: 220, width: 200, height: 200 });
  });

  it("finds horizontal strips top to bottom", () => {
    const image = page(300, 640);
    image.artwork(0, 0, 300, 200);
    image.artwork(0, 220, 300, 200);
    image.artwork(0, 440, 300, 200);
    const panels = detectPanels(image);
    assert.equal(panels.length, 3);
    assert.deepEqual(
      panels.map((panel) => Math.round(panel.y)),
      [0, 220, 440],
    );
  });

  it("orders columns left to right, and the other way for a right-to-left book", () => {
    const image = page(420, 300);
    image.artwork(0, 0, 200, 300);
    image.artwork(220, 0, 200, 300);
    const leftToRight = detectPanels(image);
    assert.deepEqual(
      leftToRight.map((panel) => Math.round(panel.x)),
      [0, 220],
    );
    const rightToLeft = detectPanels(image, { rightToLeft: true });
    assert.deepEqual(
      rightToLeft.map((panel) => Math.round(panel.x)),
      [220, 0],
    );
  });

  it("treats a page that is one panel as a splash page", () => {
    const image = page(400, 600);
    image.artwork(10, 10, 380, 580);
    const panels = detectPanels(image);
    assert.equal(panels.length, 1);
    matchesBox(panels[0], { x: 0, y: 0, width: 400, height: 600 }, 0);
  });

  it("returns the whole page for a blank or unreadable page", () => {
    const blank = page(400, 600);
    const panels = detectPanels(blank);
    assert.deepEqual(panels, [{ x: 0, y: 0, width: 400, height: 600 }]);
    assert.deepEqual(detectPanels({ data: blank.data, width: 0, height: 0 }), []);
    assert.deepEqual(detectPanels(null), []);
  });

  it("refuses to split a page smaller than a panel", () => {
    const tiny = page(PANEL_DEFAULTS.minSize - 4, PANEL_DEFAULTS.minSize - 4);
    tiny.artwork(0, 0, PANEL_DEFAULTS.minSize - 4, PANEL_DEFAULTS.minSize - 4);
    const panels = detectPanels(tiny);
    assert.equal(panels.length, 1);
    assert.equal(panels[0].width, PANEL_DEFAULTS.minSize - 4);
  });

  it("does not split on a flat margin at the page edge", () => {
    // One panel centred in a wide white margin: the margin is not a gutter
    // between two panels, so the result must be a single panel.
    const image = page(600, 600);
    image.artwork(150, 150, 300, 300);
    const panels = detectPanels(image);
    assert.equal(panels.length, 1);
    matchesBox(panels[0], { x: 150, y: 150, width: 300, height: 300 });
  });

  it("finds a mixed layout of a wide row above two columns", () => {
    const image = page(420, 420);
    image.artwork(0, 0, 420, 180);
    image.artwork(0, 200, 200, 220);
    image.artwork(220, 200, 200, 220);
    const panels = detectPanels(image);
    assert.equal(panels.length, 3);
    matchesBox(panels[0], { x: 0, y: 0, width: 420, height: 180 });
    matchesBox(panels[1], { x: 0, y: 200, width: 200, height: 220 });
    matchesBox(panels[2], { x: 220, y: 200, width: 200, height: 220 });
  });
});

describe("panel ordering", () => {
  const panel = (x, y, width = 100, height = 100) => ({ x, y, width, height });

  it("groups panels into rows before ordering within them", () => {
    const ordered = sortPanels([panel(200, 10), panel(0, 0), panel(0, 300)]);
    assert.deepEqual(
      ordered.map((item) => [item.x, item.y]),
      [
        [0, 0],
        [200, 10],
        [0, 300],
      ],
    );
  });

  it("reverses order within a row for right-to-left books", () => {
    const ordered = sortPanels([panel(0, 0), panel(200, 0)], true);
    assert.deepEqual(
      ordered.map((item) => item.x),
      [200, 0],
    );
  });
});

describe("guided-view camera", () => {
  const page600 = { width: 600, height: 900 };
  const viewport = { width: 800, height: 600 };

  it("fits the panel on its limiting axis", () => {
    // A 300x900 panel in an 800x600 viewport is limited by height, not width.
    const camera = framePanel({
      panel: { x: 0, y: 0, width: 300, height: 900 },
      page: page600,
      viewport,
      fill: 1,
    });
    assert.equal(camera.scale, 600 / 900);
  });

  it("centres a panel that sits off the page centre", () => {
    // Left half of the page: the content must move right to bring it to centre.
    const camera = framePanel({
      panel: { x: 0, y: 0, width: 300, height: 900 },
      page: page600,
      viewport,
      fill: 1,
    });
    assert.equal(camera.offset.x, 150 * camera.scale);
    assert.equal(camera.offset.y, 0);
  });

  it("keeps the requested fill fraction", () => {
    const camera = framePanel({
      panel: { x: 0, y: 0, width: 300, height: 900 },
      page: page600,
      viewport,
      fill: 0.8,
    });
    assert.equal(camera.scale, (600 / 900) * 0.8);
  });

  it("frames a turned page on the same panel", () => {
    // A quarter turn swaps the axes: the page's left half becomes the top half
    // of a 900x600 display, so the panel must be brought down to the centre.
    const camera = framePanel({
      panel: { x: 0, y: 0, width: 300, height: 900 },
      page: page600,
      viewport,
      rotation: 90,
      fill: 1,
    });
    assert.equal(camera.scale, 800 / 900, "the displayed panel is 900 wide by 300 tall");
    assert.equal(camera.offset.x, 0);
    assert.equal(camera.offset.y, 150 * camera.scale);
  });

  it("never inverts or explodes on a degenerate panel", () => {
    const camera = framePanel({
      panel: { x: 0, y: 0, width: 0, height: 0 },
      page: page600,
      viewport,
      fill: 0,
    });
    assert.ok(Number.isFinite(camera.scale) && camera.scale > 0);
    assert.ok(Number.isFinite(camera.offset.x) && Number.isFinite(camera.offset.y));
  });
});

describe("panel strip", () => {
  const page400 = { width: 400, height: 600 };
  const grid = [
    { x: 0, y: 0, width: 190, height: 290 },
    { x: 210, y: 0, width: 190, height: 290 },
    { x: 0, y: 310, width: 190, height: 290 },
    { x: 210, y: 310, width: 190, height: 290 },
  ];

  it("is worth stacking only for a plausible multi-panel page", () => {
    assert.equal(panelsFormStrip(grid, page400), true);
    assert.equal(panelsFormStrip([], page400), false);
    assert.equal(panelsFormStrip(null, page400), false);
    // A splash page is one panel covering everything: shown whole, not stacked.
    assert.equal(panelsFormStrip([{ x: 0, y: 0, width: 400, height: 600 }], page400), false);
  });

  it("refuses a page whose detected panels are small and scattered", () => {
    // This is the shape of the real failure: a cover whose flat areas were read
    // as gutters, leaving small pieces that together cover little of the page.
    const fragments = Array.from({ length: 13 }, (_, index) => ({
      x: (index % 4) * 100,
      y: Math.floor(index / 4) * 100,
      width: 60,
      height: 60,
    }));
    assert.equal(panelsFormStrip(fragments, page400), false, "coverage is under 20%");
  });

  it("refuses a page cut into more pieces than a page plausibly has", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      x: (index % 5) * 80,
      y: Math.floor(index / 5) * 150,
      width: 80,
      height: 80,
    }));
    assert.equal(panelsFormStrip(many, page400), false, "20 panels is fragmentation");
  });

  it("refuses panels that cover too little of the page", () => {
    const sparse = [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 200, y: 0, width: 100, height: 100 },
    ];
    assert.equal(panelsFormStrip(sparse, page400), false, "coverage is 8% of the page");
  });

  it("refuses a slice, which is a gutter artefact rather than a panel", () => {
    const withSlice = [...grid, { x: 0, y: 590, width: 400, height: 8 }];
    assert.equal(panelsFormStrip(withSlice, page400), false);
  });

  it("gives one row per panel, cropping the page by background geometry", () => {
    const rows = panelStripRows({ panels: grid, page: page400, columnWidth: 400 });
    assert.equal(rows.length, 4);
    const scale = 400 / 190;
    for (const row of rows) {
      assert.equal(row.width, 400);
      assert.equal(row.height, Math.round(290 * scale));
      assert.equal(row.backgroundWidth, Math.round(400 * scale));
      assert.equal(row.backgroundHeight, Math.round(600 * scale));
    }
    assert.equal(rows[0].offsetX, 0);
    assert.equal(rows[0].offsetY, 0);
    assert.equal(rows[1].offsetX, -Math.round(210 * scale), "second column crops from x=210");
    assert.equal(rows[2].offsetY, -Math.round(310 * scale), "second row crops from y=310");
  });

  it("returns null rather than rows for a page it will not stack", () => {
    assert.equal(panelStripRows({ panels: [grid[0]], page: page400, columnWidth: 400 }), null);
  });

  it("keeps rows at a floor of one pixel and a width of at least one", () => {
    const thin = [
      { x: 0, y: 0, width: 200, height: 300 },
      { x: 0, y: 300, width: 200, height: 300 },
    ];
    const rows = panelStripRows({ panels: thin, page: page400, columnWidth: 0 });
    assert.equal(rows[0].width, 1);
    assert.ok(rows[0].height >= 1);
  });
});

describe("guided view worthiness", () => {
  it("is only worth stepping into when there is more than one panel", () => {
    assert.equal(isWorthGuiding([{ x: 0, y: 0, width: 10, height: 10 }]), false);
    assert.equal(
      isWorthGuiding([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 20, y: 0, width: 10, height: 10 },
      ]),
      true,
    );
  });
});
