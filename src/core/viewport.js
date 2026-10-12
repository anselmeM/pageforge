/**
 * Pan clamping and zoom-to-cursor arithmetic.
 *
 * Offsets are pixels of translation away from the centred position, so a zero
 * offset always means "centred". When the scaled page is smaller than the
 * viewport on an axis it stays centred on that axis and cannot be dragged away.
 */

/**
 * Largest offset allowed on each axis before the page would leave the viewport.
 * `margin` allows deliberate overscroll, which the reader uses so a page edge
 * can be pulled slightly past the centre while panning.
 */
export const panBounds = (content, viewport, margin = 0) => ({
  maxX: Math.max(0, (content.width - viewport.width) / 2) + Math.max(0, margin),
  maxY: Math.max(0, (content.height - viewport.height) / 2) + Math.max(0, margin),
});

const clampAxis = (value, limit) => settle(Math.min(limit, Math.max(-limit, value)));

/** Clamp a pan offset so the scaled page stays within reach of the viewport. */
export const clampPan = (offset, content, viewport, margin = 0) => {
  const bounds = panBounds(content, viewport, margin);
  return {
    x: clampAxis(offset.x, bounds.maxX),
    y: clampAxis(offset.y, bounds.maxY),
  };
};

/** Avoid negative zero, which would make equivalent results compare unequal. */
const settle = (value) => (Object.is(value, -0) ? 0 : value);

/**
 * Offset that keeps the content point under the pointer fixed while the scale
 * changes, which is what makes wheel zoom feel anchored rather than jumping.
 *
 * Positions are relative to the viewport centre.
 */
export const zoomAtPoint = (scale, offset, nextScale, pointer) => {
  if (!Number.isFinite(scale) || scale <= 0) return { x: offset.x, y: offset.y };
  const ratio = nextScale / scale;
  return {
    x: settle(pointer.x - (pointer.x - offset.x) * ratio),
    y: settle(pointer.y - (pointer.y - offset.y) * ratio),
  };
};
