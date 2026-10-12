/**
 * What the status bar says.
 *
 * This was inside the renderer, mixed in with writing to elements, which is why
 * it managed to be wrong twice without any test noticing: it once claimed a page
 * the viewport was not showing, and once showed a zoom that contradicted the
 * reading mode. Composing the text is pure — only assigning it to elements needs
 * a document — so it lives here, where it can be checked directly.
 */

/**
 * @param {object} view everything the bar depends on
 * @param {boolean} view.hasBook
 * @param {string} [view.displayName]
 * @param {number} [view.firstPage] 1-based first page of the spread
 * @param {number} [view.lastPage] 1-based last page of the spread
 * @param {number} [view.totalPages]
 * @param {boolean} view.rightToLeft
 * @param {boolean} view.doublePage
 * @param {boolean} view.vertical
 * @param {boolean} view.strip
 * @param {boolean} view.guided
 * @param {string} view.fitMode
 * @param {number} view.rotation
 * @param {number} view.zoom pixels per page pixel
 * @param {number} view.verticalZoom column width multiplier
 * @param {number} [view.panelIndex]
 * @param {number} [view.panelCount]
 * @returns {{modeText: string, zoomText: string, pageText: string, bookText: string, progressText: string}}
 */
export const describeStatus = (view) => {
  const vertical = view.vertical === true;
  const guided = view.guided === true;
  const panelCount = Number(view.panelCount ?? 0);

  // In vertical mode the column width is the zoom, and the mode text already says
  // so. Showing the paged scale as well would contradict it.
  const zoomText = vertical ? "" : `${Math.round(Number(view.zoom ?? 0) * 100)}%`;

  const modeText = [
    vertical
      ? view.strip === true
        ? "Panel strip"
        : "Vertical scroll"
      : view.doublePage === true && guided !== true
        ? "Double page"
        : "Single page",
    view.rightToLeft === true ? "Right to left" : "Left to right",
    vertical
      ? `${Math.round(Number(view.verticalZoom ?? 0) * 100)}% wide`
      : view.fitMode === "manual"
        ? "Zoom"
        : `Fit ${view.fitMode}`,
    // A rotation is not shown while scrolling, because the column is not rotated.
    view.rotation === 0 || vertical ? null : `${view.rotation}°`,
    guided && panelCount > 1 ? `Panel ${Number(view.panelIndex ?? 0) + 1} / ${panelCount}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (view.hasBook !== true) {
    return { modeText, zoomText, pageText: "No book open", bookText: "", progressText: "" };
  }

  const first = Number(view.firstPage ?? 1);
  const last = Number(view.lastPage ?? first);
  const total = Number(view.totalPages ?? 0);
  return {
    modeText,
    zoomText,
    pageText: first === last ? `Page ${first} / ${total}` : `Pages ${first}\u2013${last} / ${total}`,
    bookText: view.displayName ?? "",
    progressText: total > 0 ? `${Math.round((last / total) * 100)}%` : "0%",
  };
};
