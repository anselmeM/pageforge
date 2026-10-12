/**
 * Comic panel detection and the guided-view camera.
 *
 * Panels are found by recursive gutter splitting: a page of comic art is
 * separated by gutters — runs of rows or columns that are nearly uniform — so a
 * region is split at its widest gutter and each half is examined again. A region
 * with no gutter wide enough to be a gutter is a panel.
 *
 * The split is a pure function of pixel data, so it is tested directly against
 * synthesised pages rather than through the UI. `framePanel` turns a panel into
 * the scale and offset that brings it to the middle of the viewport, which is
 * the same transform the rest of the reader already uses.
 */

/** Standard luminance weights, so a coloured gutter still reads as flat. */
const luminance = (data, offset) => 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];

/** Negative zero compares unequal under Object.is; the reader avoids it. */
const settle = (value) => (Object.is(value, -0) ? 0 : value);

/** Treat trigonometric residue as the exact zero it is meant to be. */
const snap = (value) => {
  const settled = settle(value);
  return Math.abs(settled) < 1e-9 ? 0 : settled;
};

/** Variance of luminance over every pixel of a page. */
const pageVariance = (image) => {
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let at = 0; at < image.data.length; at += 4) {
    const value = luminance(image.data, at);
    sum += value;
    sumSquares += value * value;
    count += 1;
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSquares / count - mean * mean);
};

/** Variance of luminance over one rectangle of a page. */
const regionVariance = (image, region) => {
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    const rowStart = y * image.width;
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const value = luminance(image.data, (rowStart + x) * 4);
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSquares / count - mean * mean);
};

/** Defaults tuned for a page downsampled to roughly 800px on its long edge. */
export const PANEL_DEFAULTS = {
  /** A line flatter than this in luminance counts as gutter, not artwork. */
  threshold: 22,
  /** Panels smaller than this (in sampled pixels) are discarded. */
  minSize: 48,
  /** A gutter has to be at least this wide to split on. */
  gutter: 5,
  /**
   * A gutter is a *thin* separator. A flat band wider than this fraction of the
   * axis is background — a black cover, a night sky, a solid panel — and
   * splitting there is what turns a cover into a dozen fragments.
   */
  maxGutterFraction: 0.06,
  /** Recursion limit, so a noisy page cannot split forever. */
  maxDepth: 12,
};

/**
 * Variance of one row or column across a span.
 *
 * Variance rather than a range, because a gutter is uniformly light *or*
 * uniformly dark; a line of artwork almost always varies.
 */
const lineVariance = (image, axis, index, from, to) => {
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let position = from; position < to; position += 1) {
    const x = axis === "row" ? position : index;
    const y = axis === "row" ? index : position;
    const value = luminance(image.data, (y * image.width + x) * 4);
    sum += value;
    sumSquares += value * value;
    count += 1;
  }
  if (count === 0) return 0;
  const mean = sum / count;
  // Clamped because the two-pass-free formula can go slightly negative.
  return Math.max(0, sumSquares / count - mean * mean);
};

/**
 * The longest stretch of gutter inside a region, ignoring stretches that touch
 * an edge and stretches so wide they are background rather than a separator.
 *
 * A margin is not a gutter between two panels, and splitting on one would
 * produce a degenerate half; the same is true of a wide flat area.
 */
const widestInteriorGutter = (image, region, axis, threshold, maxGutterFraction) => {
  const along = axis === "row" ? region.height : region.width;
  const fixed = axis === "row" ? region.y : region.x;
  const spanFrom = axis === "row" ? region.x : region.y;
  const spanTo = axis === "row" ? region.x + region.width : region.y + region.height;
  const limit = Math.max(1, Math.round(along * maxGutterFraction));

  let best = { start: 0, length: 0 };
  let runStart = -1;
  for (let offset = 0; offset <= along; offset += 1) {
    const isGutter =
      offset < along && lineVariance(image, axis, fixed + offset, spanFrom, spanTo) < threshold;
    if (isGutter) {
      if (runStart === -1) runStart = offset;
      continue;
    }
    if (runStart !== -1) {
      const length = offset - runStart;
      const interior = runStart > 0 && offset < along;
      if (interior && length <= limit && length > best.length) best = { start: runStart, length };
      runStart = -1;
    }
  }
  return best;
};

/** Shrink a region's edges while they are flat, so a panel is not mostly margin. */
const trimToArtwork = (image, region, options) => {
  let { x, y, width, height } = region;
  const flat = (axis, index, from, to) => lineVariance(image, axis, index, from, to) < options.threshold;

  while (height > options.minSize && flat("row", y, x, x + width)) {
    y += 1;
    height -= 1;
  }
  while (height > options.minSize && flat("row", y + height - 1, x, x + width)) {
    height -= 1;
  }
  while (width > options.minSize && flat("column", x, y, y + height)) {
    x += 1;
    width -= 1;
  }
  while (width > options.minSize && flat("column", x + width - 1, y, y + height)) {
    width -= 1;
  }
  return { x, y, width, height };
};

/** Panels that are too small, or absurdly thin, are gutter artefacts. */
const isPlausiblePanel = (panel, minSize) => {
  if (panel.width < minSize || panel.height < minSize) return false;
  const aspect = panel.width / panel.height;
  return !((aspect > 8 || aspect < 0.125) && (panel.width < 100 || panel.height < 100));
};

/**
 * Panels in one page, in reading order (top to bottom, then left to right).
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image RGBA pixels.
 * @param {Partial<typeof PANEL_DEFAULTS> & {rightToLeft?: boolean}} [options]
 * @returns {Array<{x: number, y: number, width: number, height: number}>}
 */
export const detectPanels = (image, options = {}) => {
  const settings = { ...PANEL_DEFAULTS, ...options };
  if (!image?.data || image.width <= 0 || image.height <= 0) return [];
  const whole = { x: 0, y: 0, width: image.width, height: image.height };
  if (image.width < settings.minSize || image.height < settings.minSize) return [whole];
  // A page with no variation at all is blank: there is nothing to split, and
  // trimming would otherwise collapse it to a corner fragment.
  if (pageVariance(image) < settings.threshold) return [whole];

  const found = [];
  /** A region with no variation at all is background, not a panel. */
  const pushIfArtwork = (region) => {
    if (region.width < settings.minSize || region.height < settings.minSize) return;
    if (regionVariance(image, region) < settings.threshold) return;
    found.push(region);
  };

  const split = (region, depth) => {
    if (regionVariance(image, region) < settings.threshold) return;
    const roomToSplit = region.width >= settings.minSize * 2 && region.height >= settings.minSize * 2;
    if (depth >= settings.maxDepth || !roomToSplit) {
      pushIfArtwork(trimToArtwork(image, region, settings));
      return;
    }

    // A gutter has to be at least as wide as the minimum, but the minimum is
    // expressed in sampled pixels and the caller scales it with the page.
    const rows = widestInteriorGutter(image, region, "row", settings.threshold, settings.maxGutterFraction);
    const columns = widestInteriorGutter(
      image,
      region,
      "column",
      settings.threshold,
      settings.maxGutterFraction,
    );
    const significant = (run) => run.length >= settings.gutter;

    if (significant(rows) && rows.length >= columns.length) {
      const at = region.y + rows.start + Math.floor(rows.length / 2);
      // Both halves must have room to be a panel; a split that produces a
      // fragment is not a split between panels.
      if (at - region.y >= settings.minSize && region.y + region.height - at >= settings.minSize) {
        split({ ...region, height: at - region.y }, depth + 1);
        split({ ...region, y: at, height: region.y + region.height - at }, depth + 1);
        return;
      }
    } else if (significant(columns)) {
      const at = region.x + columns.start + Math.floor(columns.length / 2);
      if (at - region.x >= settings.minSize && region.x + region.width - at >= settings.minSize) {
        split({ ...region, width: at - region.x }, depth + 1);
        split({ ...region, x: at, width: region.x + region.width - at }, depth + 1);
        return;
      }
    }
    pushIfArtwork(trimToArtwork(image, region, settings));
  };
  split({ x: 0, y: 0, width: image.width, height: image.height }, 0);

  const panels = found.filter((panel) => isPlausiblePanel(panel, settings.minSize));

  // A page that is one panel, or nearly all of one, is a splash page: treating it
  // as a single panel keeps guided view from zooming into a fragment of it.
  if (panels.length === 0) return [whole];
  if (panels.length === 1) {
    const coverage = (panels[0].width * panels[0].height) / (image.width * image.height);
    if (coverage >= 0.88) return [whole];
  }
  return sortPanels(panels, options.rightToLeft === true);
};

/**
 * Reading order: panels are grouped into rows by vertical overlap, then ordered
 * within a row, reversed for right-to-left books.
 */
export const sortPanels = (panels, rightToLeft = false) => {
  const rows = [];
  for (const panel of [...panels].sort((a, b) => a.y - b.y)) {
    // Same row when the vertical centres are close relative to panel height.
    const tolerance = Math.min(panel.height, rows.at(-1)?.height ?? panel.height) * 0.5;
    const row = rows.at(-1);
    if (row !== undefined && Math.abs(panel.y - row[0].y) <= tolerance) row.push(panel);
    else rows.push([panel]);
  }
  return rows.flatMap((row) =>
    [...row].sort((a, b) => (rightToLeft ? b.x - a.x : a.x - b.x)),
  );
};

/**
 * Scale and offset that bring a panel to the middle of the viewport.
 *
 * `fill` is how much of the viewport the panel should occupy: 1 fills it exactly,
 * and slightly less leaves the surrounding artwork visible for context.
 */
export const framePanel = ({ panel, page, viewport, rotation = 0, fill = 0.92 }) => {
  const quarterTurned = rotation % 180 === 90;
  const displayedWidth = quarterTurned ? panel.height : panel.width;
  const displayedHeight = quarterTurned ? panel.width : panel.height;
  const normalizedFill = Math.min(1, Math.max(0.2, fill));
  const scale =
    Math.min(viewport.width / Math.max(1, displayedWidth), viewport.height / Math.max(1, displayedHeight)) *
    normalizedFill;

  // Panel centre relative to the page centre, rotated into display space so a
  // turned page still frames the right region. Quarter turns are the only
  // rotations this reader offers, and trigonometry leaves residues like 8e-15
  // where the answer is exactly zero, so near-zero components are snapped.
  const dx = panel.x + panel.width / 2 - page.width / 2;
  const dy = panel.y + panel.height / 2 - page.height / 2;
  const angle = (rotation * Math.PI) / 180;
  const displayX = snap(Math.cos(angle) * dx - Math.sin(angle) * dy);
  const displayY = snap(Math.sin(angle) * dx + Math.cos(angle) * dy);

  return { scale, offset: { x: settle(-displayX * scale), y: settle(-displayY * scale) } };
};

/** Panels below a whole-page threshold in coverage are not worth stepping into. */
export const isWorthGuiding = (panels) => panels.length > 1;

/**
 * Variance of luminance inside one panel, over every pixel of it.
 *
 * Every pixel rather than a sampled grid: a stride aliases against regular detail,
 * and a panel of evenly spaced stripes can sample to a single colour and read as
 * blank — which would drop real artwork. The image is already downscaled before
 * this is called, so the whole panel is cheap to walk.
 */
export const panelVariance = (image, panel) => {
  if (!image?.data) return 0;
  const right = Math.min(image.width, panel.x + panel.width);
  const bottom = Math.min(image.height, panel.y + panel.height);
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = Math.max(0, panel.y); y < bottom; y += 1) {
    for (let x = Math.max(0, panel.x); x < right; x += 1) {
      const value = luminance(image.data, (y * image.width + x) * 4);
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSquares / count - mean * mean);
};

/**
 * Drop panels that contain no artwork.
 *
 * Guided view frames one panel at a time, so a panel that is a flat band of
 * background is a screen the reader has to look at that shows nothing — the most
 * common way guided view "navigates to a blank space". The threshold is the same
 * one the detector uses to call a line flat, which keeps this conservative: only a
 * panel with essentially no variation at all is dropped, so a dark or quiet panel
 * with line art in it survives.
 */
export const keepPanelsWithArtwork = (image, panels, options = {}) => {
  const minimum = options.minimumVariance ?? PANEL_DEFAULTS.threshold;
  return (panels ?? []).filter((panel) => panelVariance(image, panel) >= minimum);
};

/**
 * Whether a page's detected panels are trustworthy enough to guide or stack.
 *
 * All or nothing, deliberately. Accepting the panels that survive shape filtering
 * and dropping the rest was tried, and measured: on a real book it recovered two
 * pages but let a misread cover back in. The cover's leftover boxes — a small
 * fragment and a full-height column — cover 44% of the page, while the least
 * convincing page that guides correctly covers 57%. Separating those two needs a
 * threshold fitted to three pages, which is not a rule, so a page with any
 * implausible box is shown whole instead.
 *
 * Guided view and the vertical strip share this because a wrong split is a wasted
 * screen in one and a visible seam in the other.
 */
export const panelsAreUsable = (panels, page) => {
  if (!Array.isArray(panels) || panels.length < 2) return false;
  if (panels.length > PANEL_LIMITS.maxPanels) return false;
  const area = page.width * page.height;
  if (area <= 0) return false;
  const covered = panels.reduce((sum, panel) => sum + panel.width * panel.height, 0) / area;
  if (covered < PANEL_LIMITS.minCoverage) return false;
  return panels.every((panel) => {
    const aspect = panel.width / Math.max(1, panel.height);
    return aspect <= PANEL_LIMITS.maxAspect && aspect >= 1 / PANEL_LIMITS.maxAspect;
  });
};

/** Limits for presenting a page as a set of panels. */
const PANEL_LIMITS = {
  /** More panels than this on one page usually means the page was cut to pieces. */
  maxPanels: 18,
  /** Panels must cover at least this much of the page to be worth stepping through. */
  minCoverage: 0.4,
  /** Panels thinner than this (either way) are slices, not panels. */
  maxAspect: 6,
};

/**
 * One row per panel, as CSS background-crop geometry at a given column width.
 *
 * The page is used as a background image rather than copied through a canvas:
 * one decoded bitmap then serves every panel on the page, and the crop is just a
 * background size and offset. Returns null when the page should be shown whole.
 */
export const panelStripRows = ({ panels, page, columnWidth }) => {
  if (!panelsAreUsable(panels, page)) return null;
  const width = Math.max(1, Math.round(columnWidth));
  return panels.map((panel) => {
    const scale = width / Math.max(1, panel.width);
    return {
      panel,
      width,
      height: Math.max(1, Math.round(panel.height * scale)),
      backgroundWidth: Math.round(page.width * scale),
      backgroundHeight: Math.round(page.height * scale),
      offsetX: settle(-Math.round(panel.x * scale)),
      offsetY: settle(-Math.round(panel.y * scale)),
    };
  });
};
