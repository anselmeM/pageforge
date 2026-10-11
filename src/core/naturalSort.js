/**
 * Deterministic natural-order comparison for page file names.
 *
 * Digit runs compare numerically ("page2" before "page10"), letter runs compare
 * case-insensitively by code unit, and equal numeric runs fall back to a
 * shorter-then-lexicographic tie-break. The result depends only on the input
 * strings, never on the host locale or on the order an archive happened to
 * report its entries.
 */

const CHUNK_PATTERN = /(\d+)|(\D+)/gu;

const chunkify = (value) => {
  const result = [];
  CHUNK_PATTERN.lastIndex = 0;
  let match = CHUNK_PATTERN.exec(value);
  while (match !== null) {
    result.push(
      match[1] === undefined
        ? { numeric: null, text: match[2].toLowerCase() }
        : { numeric: Number(match[1]), digits: match[1] },
    );
    match = CHUNK_PATTERN.exec(value);
  }
  return result;
};

const compareNumericChunks = (a, b) => {
  if (a.numeric !== b.numeric) return a.numeric < b.numeric ? -1 : 1;
  if (a.digits.length !== b.digits.length) return a.digits.length < b.digits.length ? -1 : 1;
  if (a.digits === b.digits) return 0;
  return a.digits < b.digits ? -1 : 1;
};

/** Compare two names in natural order. Returns a negative, zero, or positive number. */
export const compareNatural = (a, b) => {
  const left = chunkify(a);
  const right = chunkify(b);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x.numeric !== null && y.numeric !== null) {
      const order = compareNumericChunks(x, y);
      if (order !== 0) return order;
      continue;
    }
    if (x.numeric === null && y.numeric === null) {
      if (x.text !== y.text) return x.text < y.text ? -1 : 1;
      continue;
    }
    // One name has a digit where the other has letters ("1a" versus "a1").
    // Keep a content-based order so the result stays deterministic.
    return x.numeric === null ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
};

/** Sort a copy of `names` in natural order. */
export const sortNatural = (names) => [...names].sort(compareNatural);
