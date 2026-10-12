/**
 * ComicInfo.xml — the de-facto metadata file inside a comic archive.
 *
 * It carries the things a filename cannot: which way the book reads, an explicit
 * page order, and the series and issue it belongs to. This module is a pure
 * reader for it, so the rules are testable without an archive.
 *
 * The XML here is a small, flat, machine-written document, so a focused subset
 * parser is used rather than a full XML library. What is *not* supported is
 * deliberate: no DTD or entity definitions (so no external entity resolution and
 * no entity expansion blow-up), no namespaces, no attribute-value normalisation.
 * Unknown entities are left as written rather than guessed at.
 */

/** The five predefined XML entities; nothing else is expanded. */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const MAX_DEPTH = 64;
const MAX_NODES = 4096;
const MAX_TEXT = 1 << 20;

/** Decode the predefined entities and numeric character references. */
export const decodeXmlEntities = (text) =>
  String(text ?? "").replaceAll(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // Reject surrogates and out-of-range values rather than emitting garbage.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return match;
      }
      return String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });

/** Index of the `>` that closes a tag, ignoring `>` inside quoted attributes. */
const findTagEnd = (source, from) => {
  let quote = null;
  for (let index = from + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
};

const parseAttributes = (source) => {
  const attributes = {};
  for (const match of source.matchAll(/([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attributes[match[1].toLowerCase()] = decodeXmlEntities(match[3] ?? match[4] ?? "");
  }
  return attributes;
};

/**
 * Parse a document into a tree of `{name, attributes, children, text}`.
 *
 * Malformed markup is recovered from rather than thrown on: a comic with a
 * slightly broken metadata file should still open.
 */
export const parseXml = (xml) => {
  const root = { name: "#document", attributes: {}, children: [], text: "" };
  const stack = [root];
  const source = String(xml ?? "");
  let index = 0;
  let nodes = 0;

  const appendText = (raw) => {
    if (raw.length === 0) return;
    const element = stack[stack.length - 1];
    if (element.text.length < MAX_TEXT) element.text += decodeXmlEntities(raw);
  };

  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open === -1) {
      appendText(source.slice(index));
      break;
    }
    appendText(source.slice(index, open));

    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open);
      const raw = source.slice(open + 9, end === -1 ? source.length : end);
      const element = stack[stack.length - 1];
      if (element.text.length < MAX_TEXT) element.text += raw;
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    // A DOCTYPE or any other declaration is skipped whole, so no entity can be
    // defined and later expanded.
    if (source.startsWith("<!", open)) {
      const end = source.indexOf(">", open);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    const close = findTagEnd(source, open);
    if (close === -1) {
      appendText(source.slice(open));
      break;
    }
    const inner = source.slice(open + 1, close);

    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim().toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].name === name) {
          stack.length = depth;
          break;
        }
      }
      index = close + 1;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const name = /^([^\s/>]+)/.exec(body)?.[1]?.toLowerCase();
    if (name === undefined || name.length === 0) {
      index = close + 1;
      continue;
    }
    const element = {
      name,
      attributes: parseAttributes(body.slice(name.length)),
      children: [],
      text: "",
    };
    nodes += 1;
    if (nodes <= MAX_NODES && stack.length < MAX_DEPTH) {
      stack[stack.length - 1].children.push(element);
      if (!selfClosing) stack.push(element);
    }
    index = close + 1;
  }

  return root;
};

/** Depth-first search for the first element with a name. */
export const findElement = (node, name) => {
  const wanted = name.toLowerCase();
  for (const child of node.children ?? []) {
    if (child.name === wanted) return child;
    const found = findElement(child, wanted);
    if (found !== null) return found;
  }
  return null;
};

/** Every element with a name, anywhere in the document. */
const findAllElements = (node, name) => {
  const wanted = name.toLowerCase();
  const found = [];
  for (const child of node.children ?? []) {
    if (child.name === wanted) found.push(child);
    found.push(...findAllElements(child, wanted));
  }
  return found;
};

const text = (document, name) => {
  const element = findElement(document, name);
  if (element === null) return null;
  const value = element.text.trim();
  return value.length === 0 ? null : value;
};

/**
 * Reading direction, which is the field worth reading carefully.
 *
 * `Manga` is the ComicRack convention and the one found in the wild:
 * `YesAndRightToLeft` means right-to-left. `ReadingDirection` is explicit, so it
 * wins when present and understood.
 */
export const comicInfoDirection = (document) => {
  const explicit = text(document, "ReadingDirection");
  if (explicit !== null) {
    const value = explicit.toLowerCase();
    if (value === "righttoleft" || value === "rtl" || value === "right-to-left") return "rtl";
    if (value === "lefttoright" || value === "ltr" || value === "left-to-right") return "ltr";
  }
  const manga = text(document, "Manga");
  if (manga !== null) {
    const value = manga.toLowerCase();
    if (value === "yesandrighttoleft" || value === "yesandright-to-left") return "rtl";
    if (value === "yes" || value === "no" || value === "unknown") return "ltr";
  }
  return null;
};

/**
 * Explicit page order from `<Pages><Page Image="n"/>…`.
 *
 * Only trusted when it is a strict permutation of every page, because a partial
 * or out-of-range list would silently hide or duplicate pages. A list that does
 * not satisfy that is ignored, not repaired.
 */
export const comicInfoPageOrder = (document) => {
  const entries = findAllElements(document, "page");
  if (entries.length === 0) return null;
  const order = [];
  for (const entry of entries) {
    const raw = entry.attributes.image;
    if (raw === undefined) return null;
    const index = Number.parseInt(raw, 10);
    if (!Number.isInteger(index) || index < 0) return null;
    order.push(index);
  }
  const unique = new Set(order);
  if (unique.size !== order.length) return null;
  const highest = Math.max(...order);
  if (highest !== order.length - 1) return null;
  for (let index = 0; index < order.length; index += 1) {
    if (!unique.has(index)) return null;
  }
  return order;
};

/** The finite piece of ComicInfo this reader uses. */
export const parseComicInfo = (xml) => {
  const document = parseXml(xml);
  const root = findElement(document, "comicinfo") ?? document;
  const pageCount = Number.parseInt(text(root, "PageCount") ?? "", 10);
  const year = Number.parseInt(text(root, "Year") ?? "", 10);
  return {
    series: text(root, "Series"),
    number: text(root, "Number"),
    title: text(root, "Title"),
    volume: Number.isInteger(Number.parseInt(text(root, "Volume") ?? "", 10))
      ? Number.parseInt(text(root, "Volume"), 10)
      : null,
    year: Number.isInteger(year) ? year : null,
    publisher: text(root, "Publisher"),
    summary: text(root, "Summary"),
    writer: text(root, "Writer"),
    pageCount: Number.isInteger(pageCount) && pageCount > 0 ? pageCount : null,
    manga: text(root, "Manga"),
    direction: comicInfoDirection(root),
    pageOrder: comicInfoPageOrder(root),
  };
};

/** Short label for the status bar, e.g. "Fantastic Four #1". */
export const comicInfoLabel = (info) => {
  if (info === null || info === undefined) return null;
  const parts = [];
  if (info.series !== null && info.series !== undefined && info.series.length > 0) {
    parts.push(info.number ? `${info.series} #${info.number}` : info.series);
  } else if (info.title) {
    parts.push(info.title);
  }
  if (parts.length === 0) return null;
  return parts.join(" — ");
};

/** Whether the metadata carries anything worth showing. */
export const hasComicInfo = (info) =>
  info !== null &&
  info !== undefined &&
  [info.series, info.number, info.title, info.direction, info.pageOrder].some(
    (value) => value !== null && value !== undefined,
  );

/**
 * Reorder pages by an explicit `<Pages>` list.
 *
 * Applied only when the order covers exactly the pages that exist: a shorter list
 * would drop pages and a longer one would need pages that are not there, and
 * either would be worse than ignoring the file.
 */
export const applyPageOrder = (pages, order) => {
  if (!Array.isArray(pages) || !Array.isArray(order)) return pages;
  if (order.length !== pages.length) return pages;
  return order.map((index) => pages[index]);
};
