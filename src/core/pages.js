/**
 * Decide which archive entries or folder files are readable pages, and in what
 * order they should be read.
 */

import { compareNatural } from "./naturalSort.js";

/** Extensions this reader treats as page images. */
const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".jpe",
  ".jfif",
  ".png",
  ".apng",
  ".gif",
  ".webp",
  ".bmp",
  ".dib",
  ".tif",
  ".tiff",
  ".avif",
]);

/** Path segments that are packaging noise rather than page content. */
const METADATA_SEGMENTS = new Set([".ds_store", "thumbs.db", "desktop.ini", ".git", ".svn"]);

const segmentsOf = (name) => name.toLowerCase().split(/[\\/]+/u);

const isPackagingNoise = (name) =>
  segmentsOf(name).some(
    (segment) => segment.length > 0 && (METADATA_SEGMENTS.has(segment) || segment.startsWith("._")),
  );

/** True for entries that name a directory rather than a file. */
const isDirectoryEntry = (name) => /[\\/]$/u.test(name);

/** Lower-case extension including the dot, or an empty string when there is none. */
export const extensionOf = (name) => {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
};

/**
 * True when an entry looks like a page: a file, not packaging noise, and
 * carrying an extension this reader decodes.
 *
 * Note: CDisplayEx also displays images whose extension is wrong or missing by
 * sniffing their content. That needs the entry bytes, so it is intentionally
 * not decided here; see the reader's deferred-features notes.
 */
export const isPageCandidate = (name) =>
  !isDirectoryEntry(name) && !isPackagingNoise(name) && IMAGE_EXTENSIONS.has(extensionOf(name));

/** Page entries in reading order, which is natural filename order. */
export const selectPages = (names) => names.filter(isPageCandidate).sort(compareNatural);
