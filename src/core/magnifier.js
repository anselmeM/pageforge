/**
 * Magnifier geometry.
 *
 * The lens shows a region of the page's underlying bitmap magnified by a
 * factor. Working out *which* region needs the display rotation undone, because
 * a pointer offset measured on screen is not a bitmap offset once the page is
 * rotated. Keeping that arithmetic here makes it testable without a window.
 */

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/** Smallest sampled region, so a deep zoom cannot ask for a sub-pixel window. */
const MIN_REGION = 8;

/**
 * @param {{x: number, y: number}} pointer Screen coordinates of the pointer.
 * @param {{left: number, top: number, width: number, height: number}} rect
 *   The page element's bounding box, which for the quarter-turns this reader
 *   supports is exactly its oriented box.
 * @param {{width: number, height: number}} natural Bitmap size of the page.
 * @param {number} rotation Display rotation in degrees.
 * @param {number} size Lens size in pixels.
 * @param {number} factor Magnification.
 * @returns {{scale: number, region: number, sourceX: number, sourceY: number}|null}
 */
export const magnifierSample = ({ pointer, rect, natural, rotation, size, factor }) => {
  const quarterTurned = rotation % 180 === 90;
  const displayedWidth = quarterTurned ? natural.height : natural.width;
  const scale = rect.width / displayedWidth;
  if (!(scale > 0) || !(natural.width > 0) || !(natural.height > 0)) return null;

  // Offset from the page centre, then rotated back into bitmap space.
  const dx = pointer.x - (rect.left + rect.width / 2);
  const dy = pointer.y - (rect.top + rect.height / 2);
  const angle = (rotation * Math.PI) / 180;
  const bitmapX = Math.cos(-angle) * dx - Math.sin(-angle) * dy;
  const bitmapY = Math.sin(-angle) * dx + Math.cos(-angle) * dy;

  const region = clamp(
    size / Math.max(factor, 1) / scale,
    MIN_REGION,
    Math.min(natural.width, natural.height),
  );
  const centreX = natural.width / 2 + bitmapX / scale;
  const centreY = natural.height / 2 + bitmapY / scale;
  return {
    scale,
    region,
    // Keep the window inside the page, so the lens never shows empty edges.
    sourceX: clamp(centreX - region / 2, 0, Math.max(0, natural.width - region)),
    sourceY: clamp(centreY - region / 2, 0, Math.max(0, natural.height - region)),
  };
};

/** Top-left corner that keeps a square lens inside the reading area. */
export const lensPosition = ({ pointer, stageRect, size }) => ({
  left: clamp(pointer.x - stageRect.left - size / 2, 0, Math.max(0, stageRect.width - size)),
  top: clamp(pointer.y - stageRect.top - size / 2, 0, Math.max(0, stageRect.height - size)),
});
