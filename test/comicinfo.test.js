/**
 * ComicInfo.xml reader tests.
 *
 * The interesting cases are the ones that decide whether a book is reversed or
 * whether its pages are reordered, so those are tested hard: a page order that is
 * not a strict permutation must be ignored rather than half-applied.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyPageOrder,
  comicInfoDirection,
  comicInfoLabel,
  comicInfoPageOrder,
  decodeXmlEntities,
  findElement,
  hasComicInfo,
  parseComicInfo,
  parseXml,
} from "../src/core/comicinfo.js";

const document = (body) => `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>${body}</ComicInfo>`;

describe("xml subset parsing", () => {
  it("reads elements, text and attributes", () => {
    const root = parseXml(document(`<Series>Fantastic Four</Series><Pages><Page Image="2"/></Pages>`));
    const comicInfo = findElement(root, "ComicInfo");
    assert.equal(findElement(comicInfo, "Series").text, "Fantastic Four");
    assert.equal(findElement(comicInfo, "Page").attributes.image, "2");
  });

  it("handles self-closing tags, comments and processing instructions", () => {
    const root = parseXml(
      `<?xml version="1.0"?><!-- a note --><ComicInfo><Title/><Number>7</Number></ComicInfo>`,
    );
    const comicInfo = findElement(root, "ComicInfo");
    assert.equal(findElement(comicInfo, "Title").text, "");
    assert.equal(findElement(comicInfo, "Number").text, "7");
  });

  it("does not treat a '>' inside an attribute as the end of the tag", () => {
    const root = parseXml(document(`<Summary note="a > b">fine</Summary>`));
    assert.equal(findElement(root, "Summary").text, "fine");
    assert.equal(findElement(root, "Summary").attributes.note, "a > b");
  });

  it("decodes the predefined entities and numeric references", () => {
    assert.equal(decodeXmlEntities("Tom &amp; Jerry"), "Tom & Jerry");
    assert.equal(decodeXmlEntities("&#65;&#x42;"), "AB");
    assert.equal(decodeXmlEntities("&lt;tag&gt;"), "<tag>");
  });

  it("leaves unknown entities alone rather than guessing", () => {
    assert.equal(decodeXmlEntities("&nbsp;"), "&nbsp;");
  });

  it("refuses to expand entity definitions", () => {
    // A DOCTYPE is skipped whole, so a defined entity is never resolved.
    const hostile = `<!DOCTYPE ComicInfo [<!ENTITY lol "haha">]><ComicInfo><Series>&lol;</Series></ComicInfo>`;
    assert.equal(parseComicInfo(hostile).series, "&lol;");
  });

  it("keeps CDATA as literal text", () => {
    const root = parseXml(document(`<Summary><![CDATA[a <b> c]]></Summary>`));
    assert.equal(findElement(root, "Summary").text, "a <b> c");
  });

  it("recovers from malformed markup instead of throwing", () => {
    assert.doesNotThrow(() => parseXml("<ComicInfo><Series>oops"));
    assert.equal(parseComicInfo("<ComicInfo><Series>oops").series, "oops");
    assert.equal(parseComicInfo("").series, null);
    assert.equal(parseComicInfo(null).series, null);
  });

  it("ignores a stray closing tag", () => {
    const info = parseComicInfo(document(`</Nope><Series>Kept</Series>`));
    assert.equal(info.series, "Kept");
  });
});

describe("reading direction", () => {
  it("reads the Manga convention found in the wild", () => {
    assert.equal(comicInfoDirection(parseXml(document("<Manga>YesAndRightToLeft</Manga>"))), "rtl");
    assert.equal(comicInfoDirection(parseXml(document("<Manga>No</Manga>"))), "ltr");
    assert.equal(comicInfoDirection(parseXml(document("<Manga>Unknown</Manga>"))), "ltr");
  });

  it("prefers an explicit ReadingDirection over Manga", () => {
    const xml = document("<Manga>YesAndRightToLeft</Manga><ReadingDirection>LeftToRight</ReadingDirection>");
    assert.equal(comicInfoDirection(parseXml(xml)), "ltr");
  });

  it("accepts the common spellings of each direction", () => {
    for (const value of ["RightToLeft", "rtl", "right-to-left"]) {
      assert.equal(comicInfoDirection(parseXml(document(`<ReadingDirection>${value}</ReadingDirection>`))), "rtl");
    }
    assert.equal(
      comicInfoDirection(parseXml(document("<ReadingDirection>lefttoright</ReadingDirection>"))),
      "ltr",
    );
  });

  it("reports no preference when the file says nothing useful", () => {
    assert.equal(comicInfoDirection(parseXml(document("<Series>x</Series>"))), null);
    assert.equal(comicInfoDirection(parseXml(document("<ReadingDirection>Sideways</ReadingDirection>"))), null);
  });
});

describe("explicit page order", () => {
  const pages = (...indices) =>
    parseXml(document(`<Pages>${indices.map((index) => `<Page Image="${index}"/>`).join("")}</Pages>`));

  it("reads a strict permutation", () => {
    assert.deepEqual(comicInfoPageOrder(pages(1, 0, 3, 2)), [1, 0, 3, 2]);
    assert.deepEqual(comicInfoPageOrder(pages(0, 1)), [0, 1]);
  });

  it("ignores a list that would hide or duplicate a page", () => {
    // Missing page 2: applying this would silently drop a page.
    assert.equal(comicInfoPageOrder(pages(0, 1, 3)), null);
    // Duplicate: applying this would show page 1 twice and never page 2.
    assert.equal(comicInfoPageOrder(pages(0, 1, 1, 2)), null);
    // Out of range for the number of entries.
    assert.equal(comicInfoPageOrder(pages(0, 5)), null);
  });

  it("ignores entries without an Image attribute or with junk in it", () => {
    assert.equal(comicInfoPageOrder(parseXml(document(`<Pages><Page/></Pages>`))), null);
    assert.equal(comicInfoPageOrder(parseXml(document(`<Pages><Page Image="x"/></Pages>`))), null);
    assert.equal(comicInfoPageOrder(parseXml(document(`<Pages><Page Image="-1"/></Pages>`))), null);
  });

  it("returns null when there are no pages at all", () => {
    assert.equal(comicInfoPageOrder(parseXml(document("<Series>x</Series>"))), null);
  });
});

describe("applying page order", () => {
  const pages = ["a", "b", "c", "d"];

  it("reorders when the list covers every page", () => {
    assert.deepEqual(applyPageOrder(pages, [1, 0, 3, 2]), ["b", "a", "d", "c"]);
  });

  it("leaves the pages alone when the list does not fit them", () => {
    assert.deepEqual(applyPageOrder(pages, [0, 1, 2]), pages, "a short list would drop a page");
    assert.deepEqual(applyPageOrder(pages, [0, 1, 2, 3, 4]), pages, "a long list needs a page that is not there");
  });

  it("passes odd input straight through", () => {
    assert.deepEqual(applyPageOrder(pages, null), pages);
    assert.deepEqual(applyPageOrder(null, [0]), null);
  });
});

describe("comic info", () => {
  it("reads the metadata a reader would show", () => {
    const info = parseComicInfo(
      document(
        `<Series>Fantastic Four</Series><Number>1</Number><Title>Midnight</Title>` +
          `<Volume>3</Volume><Year>2026</Year><Publisher>Marvel</Publisher>` +
          `<Writer>Percy</Writer><PageCount>41</PageCount>`,
      ),
    );
    assert.equal(info.series, "Fantastic Four");
    assert.equal(info.number, "1");
    assert.equal(info.title, "Midnight");
    assert.equal(info.volume, 3);
    assert.equal(info.year, 2026);
    assert.equal(info.publisher, "Marvel");
    assert.equal(info.writer, "Percy");
    assert.equal(info.pageCount, 41);
  });

  it("reports absent fields as null rather than empty strings", () => {
    const info = parseComicInfo(document("<Series>Only this</Series>"));
    assert.equal(info.number, null);
    assert.equal(info.title, null);
    assert.equal(info.pageCount, null);
    assert.equal(info.year, null);
    assert.equal(info.volume, null);
    assert.equal(info.direction, null);
    assert.equal(info.pageOrder, null);
  });

  it("rejects nonsense numbers", () => {
    const info = parseComicInfo(document("<PageCount>lots</PageCount><Year>abcd</Year><Volume>v2</Volume>"));
    assert.equal(info.pageCount, null);
    assert.equal(info.year, null);
    assert.equal(info.volume, null);
  });

  it("finds the root even when it is not the first element", () => {
    const info = parseComicInfo(`<foo/><ComicInfo><Series>Found</Series></ComicInfo>`);
    assert.equal(info.series, "Found");
  });

  it("builds a short label", () => {
    assert.equal(comicInfoLabel({ series: "Fantastic Four", number: "1" }), "Fantastic Four #1");
    assert.equal(comicInfoLabel({ series: "Saga", number: null }), "Saga");
    assert.equal(comicInfoLabel({ series: null, title: "Midnight" }), "Midnight");
    assert.equal(comicInfoLabel({ series: null, title: null }), null);
    assert.equal(comicInfoLabel(null), null);
  });

  it("knows when there is nothing worth showing", () => {
    assert.equal(hasComicInfo(parseComicInfo(document("<Series>x</Series>"))), true);
    assert.equal(hasComicInfo(parseComicInfo(document("<Publisher>x</Publisher>"))), false);
    assert.equal(hasComicInfo(null), false);
  });
});
