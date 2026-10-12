/**
 * Status bar tests.
 *
 * These exist because the bar was wrong twice and nothing caught it: once it
 * named a page the viewport was not showing, and once it displayed a zoom that
 * contradicted the reading mode. Both are text, so both are checkable here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeStatus } from "../src/core/status.js";

/** A single-page book in the middle of reading, as a baseline. */
const base = {
  hasBook: true,
  displayName: "saga-01.cbz",
  firstPage: 8,
  lastPage: 8,
  totalPages: 41,
  rightToLeft: false,
  doublePage: false,
  vertical: false,
  strip: false,
  guided: false,
  fitMode: "screen",
  rotation: 0,
  zoom: 0.2,
  verticalZoom: 1,
  panelIndex: 0,
  panelCount: 0,
};

describe("status text", () => {
  it("names the page, the book and how far through it is", () => {
    const status = describeStatus(base);
    assert.equal(status.pageText, "Page 8 / 41");
    assert.equal(status.bookText, "saga-01.cbz");
    assert.equal(status.progressText, "20%");
  });

  it("names a range when a spread shows two pages", () => {
    const status = describeStatus({ ...base, doublePage: true, firstPage: 8, lastPage: 9 });
    assert.equal(status.pageText, "Pages 8\u20139 / 41");
    assert.equal(status.progressText, "22%", "progress follows the last page shown");
  });

  it("offers nothing but a mode when no book is open", () => {
    const status = describeStatus({ ...base, hasBook: false });
    assert.equal(status.pageText, "No book open");
    assert.equal(status.bookText, "");
    assert.equal(status.progressText, "");
    assert.match(status.modeText, /Single page/u, "the reading mode is still meaningful");
  });

  it("describes the reading mode and direction", () => {
    assert.match(describeStatus(base).modeText, /^Single page · Left to right · Fit screen$/u);
    assert.match(describeStatus({ ...base, rightToLeft: true }).modeText, /Right to left/u);
    assert.match(describeStatus({ ...base, doublePage: true }).modeText, /^Double page/u);
    assert.match(describeStatus({ ...base, fitMode: "manual" }).modeText, /Zoom/u);
    assert.match(describeStatus({ ...base, fitMode: "width" }).modeText, /Fit width/u);
  });

  it("shows the rotation only when a page is actually turned", () => {
    assert.match(describeStatus({ ...base, rotation: 90 }).modeText, /90°/u);
    assert.doesNotMatch(describeStatus(base).modeText, /°/u, "no rotation means no rotation label");
  });

  it("shows the zoom as a percentage", () => {
    assert.equal(describeStatus({ ...base, zoom: 0.16 }).zoomText, "16%");
    assert.equal(describeStatus({ ...base, zoom: 1 }).zoomText, "100%");
  });

  it("reports the panel being read when guiding", () => {
    const status = describeStatus({ ...base, guided: true, panelIndex: 1, panelCount: 4 });
    assert.match(status.modeText, /Panel 2 \/ 4/u);
  });

  it("does not claim a panel when the page has only one", () => {
    const status = describeStatus({ ...base, guided: true, panelIndex: 0, panelCount: 1 });
    assert.doesNotMatch(status.modeText, /Panel/u);
  });

  it("describes the vertical column, and hides the paged zoom while scrolling", () => {
    const status = describeStatus({ ...base, vertical: true, verticalZoom: 1.5, zoom: 0.2 });
    assert.match(status.modeText, /^Vertical scroll/u);
    assert.match(status.modeText, /150% wide/u);
    // The paged scale would contradict the column width, which is the zoom here.
    assert.equal(status.zoomText, "", "no paged zoom in vertical mode");
    assert.doesNotMatch(status.modeText, /Fit screen/u);
  });

  it("describes the panel strip in vertical mode", () => {
    const status = describeStatus({ ...base, vertical: true, strip: true });
    assert.match(status.modeText, /^Panel strip · Left to right/u);
  });

  it("hides the rotation label while scrolling", () => {
    const status = describeStatus({ ...base, vertical: true, rotation: 90 });
    assert.doesNotMatch(status.modeText, /90°/u, "a scrolling column is not rotated");
  });

  it("never shows both the column width and a fit mode", () => {
    const vertical = describeStatus({ ...base, vertical: true, fitMode: "width" });
    assert.doesNotMatch(vertical.modeText, /Fit/u);
  });

  it("copes with a deck of missing values", () => {
    const status = describeStatus({ hasBook: true });
    assert.equal(status.pageText, "Page 1 / 0");
    assert.equal(status.zoomText, "0%");
    assert.match(status.modeText, /Single page/u);
  });
});
