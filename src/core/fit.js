/**
 * Fit and zoom arithmetic.
 *
 * The reader scales a page so it fits the viewport according to the selected
 * mode, then lets the user zoom on top of that. Keeping the arithmetic here, as
 * pure functions over plain numbers, is what makes the behaviour testable
 * without starting a window.
 */

/** Zoom limits, expressed as a multiplier over the page's natural pixel size. */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

/**
 * Scale that fits `content` into `viewport` for the given mode.
 *
 * `screen` contains the whole page (the "fit to screen" behaviour), `width` and
 * `height` fit one axis, and `original` is 1:1. CDisplayEx also exposes "Fit
 * Landscape" and "Fit Portrait"; their exact behaviour has not been observed, so
 * they are not guessed here.
 */
export const fitScale = (mode, content, viewport) => {
  // Degenerate input (an unmeasured viewport, or a page whose header was
  // unreadable) has no meaningful fit; actual size is the safe answer.
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  const viewportWidth = viewport.width;
  const viewportHeight = viewport.height;
  const contentWidth = content.width;
  const contentHeight = content.height;
  switch (mode) {
    case "width":
      return viewportWidth / contentWidth;
    case "height":
      return viewportHeight / contentHeight;
    case "original":
      return 1;
    case "screen":
    default:
      return Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight);
  }
};

/** Constrain a scale to the supported zoom range. */
export const clampScale = (scale, min = MIN_ZOOM, max = MAX_ZOOM) =>
  Math.min(max, Math.max(min, scale));

/**
 * The scale a user gets by zooming one step from `scale`, so that repeated
 * presses travel the whole range in a predictable number of steps.
 */
export const zoomStep = (scale, direction, step = 1.25) =>
  clampScale(direction >= 0 ? scale * step : scale / step);
