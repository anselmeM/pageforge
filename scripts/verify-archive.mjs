/**
 * Open an archive or folder and read every page.
 *
 * A reader that opens a book and shows page one can still fail on page
 * seventeen, and a packaged app can fail where the source build does not. This
 * walks the whole book through the same reader the app uses, so a real comic can
 * be checked in a few seconds without clicking through it.
 *
 * Usage: node scripts/verify-archive.mjs "<path to comic>"
 */

import { sniffImageFormat } from "../src/core/imageSize.js";
import { openTarget } from "../src/main/reader.js";

const target = process.argv[2];

if (target === undefined) {
  process.stderr.write('verify-archive: give a path, e.g. node scripts/verify-archive.mjs "D:\\comics\\book.cbz"\n');
  process.exit(2);
}

const started = Date.now();
let reader = null;
const problems = [];

try {
  reader = await openTarget(target);
  process.stdout.write(
    `verify-archive: ${reader.displayName}\n` +
      `  kind=${reader.kind}${reader.format === undefined ? "" : ` format=${reader.format}`}\n` +
      `  pages=${reader.pages.length}\n`,
  );

  const unsized = reader.pages.filter((page) => page.width === 0 || page.height === 0);
  if (unsized.length > 0) {
    process.stdout.write(`  ${unsized.length} page(s) have no readable image header\n`);
  }

  let bytes = 0;
  const mismatches = [];
  for (const page of reader.pages) {
    const data = await reader.readPage(page.index);
    bytes += data.length;
    if (data.length === 0) {
      problems.push(`page ${page.index + 1} came back empty`);
      continue;
    }
    const sniffed = sniffImageFormat(data);
    if (page.format !== null && sniffed !== null && sniffed !== page.format) {
      mismatches.push(`page ${page.index + 1}: header says ${sniffed}, probe said ${page.format}`);
    }
  }

  const seconds = (Date.now() - started) / 1000;
  process.stdout.write(
    `  read ${reader.pages.length} pages, ${(bytes / 1024 / 1024).toFixed(1)} MB in ${seconds.toFixed(1)}s\n`,
  );
  if (mismatches.length > 0) {
    process.stdout.write(`  ${mismatches.length} header mismatch(es), first: ${mismatches[0]}\n`);
    problems.push(...mismatches);
  }
} catch (error) {
  problems.push(`${error.name ?? "Error"}: ${error.message}`);
} finally {
  if (reader !== null) {
    try {
      await reader.close();
    } catch (error) {
      problems.push(`close: ${error.message}`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems.slice(0, 10)) process.stderr.write(`verify-archive: FAILED — ${problem}\n`);
  process.stderr.write(`verify-archive: ${problems.length} problem(s)\n`);
  process.exit(1);
}
process.stdout.write("verify-archive: OK — every page read cleanly\n");
