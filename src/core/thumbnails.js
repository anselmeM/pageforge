/**
 * Thumbnail strip geometry.
 *
 * The strip mounts only the thumbnails near the visible window, so the two
 * calculations it depends on — which indices to mount, and how far to scroll to
 * bring one into view — decide whether it works at all. They were inside the
 * renderer, where testing them meant a browser; they are arithmetic, so they live
 * here instead.
 */

/** Thumbnail box, gap and the resulting slot pitch, in CSS pixels. */
export const THUMB_WIDTH = 74;
export const THUMB_GAP = 6;
export const THUMB_SLOT = THUMB_WIDTH + THUMB_GAP;
/** How many thumbnails to keep mounted either side of the visible window. */
export const THUMB_OVERSCAN = 4;

/**
 * The range of thumbnails to mount.
 *
 * Returns `{ first: 0, last: -1 }` for an empty book, so a caller looping from
 * `first` to `last` mounts nothing rather than one wrong element.
 *
 * The scroll position is clamped to what the rail actually allows. A browser
 * clamps its own `scrollLeft` when the content shrinks, but relying on that left
 * this returning a range that ran backwards — `first` past `last` — if it was ever
 * called between a large book shrinking to a small one and the rail being rebuilt.
 */
export const thumbnailWindow = ({
  count,
  scrollLeft,
  viewportWidth,
  slot = THUMB_SLOT,
  gap = THUMB_GAP,
  overscan = THUMB_OVERSCAN,
}) => {
  const total = Number(count ?? 0);
  if (!Number.isFinite(total) || total <= 0) return { first: 0, last: -1 };
  const width = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const furthest = Math.max(0, railWidth(total, slot, gap) - width);
  const from = Math.min(Number.isFinite(scrollLeft) ? Math.max(0, scrollLeft) : 0, furthest);
  const first = Math.max(0, Math.floor(from / slot) - overscan);
  const last = Math.min(total - 1, Math.ceil((from + width) / slot) + overscan);
  return { first, last };
};

/** Horizontal position of one thumbnail in the rail. */
export const thumbnailOffset = (index, slot = THUMB_SLOT) => index * slot;

/** Rail width for a book: the last thumbnail needs no trailing gap. */
export const railWidth = (count, slot = THUMB_SLOT, gap = THUMB_GAP) =>
  Math.max(0, Number(count ?? 0) * slot - gap);

/**
 * Scroll position that brings a thumbnail into view.
 *
 * Returns null when it is already visible, so the caller can leave the scroll
 * position alone rather than assigning the same value back.
 */
export const revealScrollLeft = ({
  index,
  scrollLeft,
  viewportWidth,
  slot = THUMB_SLOT,
  width = THUMB_WIDTH,
}) => {
  const left = index * slot;
  const right = left + width;
  if (left < scrollLeft) return left;
  if (right > scrollLeft + viewportWidth) return right - viewportWidth;
  return null;
};
