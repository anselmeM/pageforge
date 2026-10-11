/**
 * Group pages into the units the reader displays at once.
 *
 * A "spread" holds one or two page indices in reading order. Wide pages get a
 * spread to themselves because they are already a two-page scan.
 *
 * Reading direction (right-to-left for Japanese mode) is deliberately *not*
 * applied here: direction changes where a page sits on screen, not the order in
 * which pages are read. Renderers call `visualOrder` for placement.
 */

/** True when a page is wider than it is tall. */
export const isLandscape = (page) => page.width > 0 && page.height > 0 && page.width > page.height;

/**
 * @param {Array<{width: number, height: number}>} pages
 * @param {{doublePage?: boolean, coverAlone?: boolean}} [options]
 *   `coverAlone` shows page 1 by itself before pairing begins, which some
 *   readers do for a cover. The observed CDisplayEx default is unverified, so
 *   it defaults to false.
 * @returns {Array<{indices: number[]}>}
 */
export const buildSpreads = (pages, options = {}) => {
  const doublePage = options.doublePage === true;
  const coverAlone = options.coverAlone === true;
  if (!doublePage) return pages.map((_, index) => ({ indices: [index] }));

  const spreads = [];
  let pending = null;
  const flush = () => {
    if (pending === null) return;
    spreads.push({ indices: [pending] });
    pending = null;
  };

  pages.forEach((page, index) => {
    const standsAlone = isLandscape(page) || (coverAlone && index === 0);
    if (standsAlone) {
      flush();
      spreads.push({ indices: [index] });
      return;
    }
    if (pending === null) {
      pending = index;
      return;
    }
    spreads.push({ indices: [pending, index] });
    pending = null;
  });
  flush();
  return spreads;
};

/** Index of the spread that contains a page, or -1 when it is absent. */
export const spreadIndexForPage = (spreads, pageIndex) =>
  spreads.findIndex((spread) => spread.indices.includes(pageIndex));

/** Spread indices in on-screen left-to-right order for the chosen reading direction. */
export const visualOrder = (spread, rightToLeft) =>
  rightToLeft ? [...spread.indices].reverse() : [...spread.indices];
