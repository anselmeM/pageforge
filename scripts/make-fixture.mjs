/**
 * Build a real comic fixture: PNG and BMP pages written byte by byte, packed
 * into a stored-entry ZIP, plus the packaging noise a real CBZ usually carries.
 *
 * Generating the bytes here keeps the tests honest — they open a genuine ZIP
 * with genuine image headers instead of mocking the reader — and keeps the
 * project free of binary fixtures that cannot be reviewed in a diff.
 */

import { deflateSync } from "node:zlib";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/* CRC-32, needed by both the PNG chunks and the ZIP records. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
};

/** Solid-colour 8-bit RGB PNG. */
export const pngBytes = (width, height, [red, green, blue] = [32, 64, 128]) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      raw[at] = red;
      raw[at + 1] = green;
      raw[at + 2] = blue;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/** 24-bit uncompressed BMP, bottom-up as the format requires. */
export const bmpBytes = (width, height, [red, green, blue] = [128, 32, 32]) => {
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const header = Buffer.alloc(54);
  header.write("BM", 0, "latin1");
  header.writeUInt32LE(54 + pixelBytes, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(0, 30);
  header.writeUInt32LE(pixelBytes, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  const pixels = Buffer.alloc(pixelBytes);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * rowStride + x * 3;
      pixels[at] = blue;
      pixels[at + 1] = green;
      pixels[at + 2] = red;
    }
  }
  return Buffer.concat([header, pixels]);
};

/** ZIP archive using stored (uncompressed) entries. */
export const zipBytes = (entries) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // Offset of this entry's own local header. Every entry needs its real
    // offset, otherwise a reader resolves them all to the first one.
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
};

/** Page set used by the tests: three portrait pages and one landscape. */
export const FIXTURE_PAGES = [
  { name: "page01.png", width: 600, height: 900, colour: [200, 40, 40] },
  { name: "page02.png", width: 600, height: 900, colour: [40, 200, 40] },
  { name: "page03.png", width: 1200, height: 800, colour: [40, 40, 200] },
  { name: "page10.png", width: 600, height: 900, colour: [200, 200, 40] },
];

const NOISE = [
  { name: "__MACOSX/._page01.png", data: Buffer.from("apple-double", "utf8") },
  { name: ".DS_Store", data: Buffer.from("junk", "utf8") },
  { name: "readme.txt", data: Buffer.from("not a page", "utf8") },
];

/** A 7z archive (CB7) built with the same wasm decoder the reader uses. */
export const sevenZipBytes = async (entries) => {
  const { default: SevenZip } = await import("7z-wasm");
  const sevenZip = await SevenZip({ print: () => {}, printErr: () => {} });
  const fs = sevenZip.FS;
  for (const { name, data } of entries) {
    const parts = name.split("/");
    let directory = "";
    for (const part of parts.slice(0, -1)) {
      directory = `${directory}/${part}`;
      if (!fs.analyzePath(directory).exists) fs.mkdir(directory);
    }
    fs.writeFile(name, new Uint8Array(data));
  }
  sevenZip.callMain(["a", "archive.cb7", ...entries.map((entry) => entry.name), "-y"]);
  return Buffer.from(fs.readFile("archive.cb7"));
};

const RAR_CANDIDATES = [
  "C:\\Program Files\\WinRAR\\Rar.exe",
  "C:\\Program Files (x86)\\WinRAR\\Rar.exe",
];

/**
 * A RAR archive (CBR). RAR compression is proprietary: only WinRAR's own
 * `Rar.exe` writes the format, so this returns null when no compressor is
 * installed and the CBR tests are skipped rather than silently passing.
 */
export const rarBytes = async (entries) => {
  const compressor = process.env.PAGEFORGE_RAR_EXE ?? RAR_CANDIDATES.find((path) => existsSync(path));
  if (compressor === undefined) return null;
  const workspace = await mkdtemp(join(tmpdir(), "pageforge-rar-"));
  try {
    for (const { name, data } of entries) {
      const target = join(workspace, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    await run(compressor, ["a", "-ep1", "-idq", "archive.cbr", ...entries.map((entry) => entry.name)], {
      cwd: workspace,
    });
    return await readFile(join(workspace, "archive.cbr"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

/**
 * A minimal but valid PDF: one filled page per size, with a real cross-reference
 * table so strict parsers accept it.
 */
export const pdfBytes = (pages) => {
  const pageCount = pages.length;
  const firstPageObject = 3;
  const firstContentObject = firstPageObject + pageCount;
  const objects = new Map();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${firstPageObject + index} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  );
  pages.forEach((page, index) => {
    const [red, green, blue] = page.colour ?? [40, 40, 40];
    const content = `${(red / 255).toFixed(3)} ${(green / 255).toFixed(3)} ${(blue / 255).toFixed(3)} rg 0 0 ${page.width} ${page.height} re f`;
    objects.set(
      firstPageObject + index,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Contents ${firstContentObject + index} 0 R >>`,
    );
    objects.set(
      firstContentObject + index,
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    );
  });

  const chunks = [];
  let offset = 0;
  const push = (text) => {
    const buffer = Buffer.from(text, "latin1");
    chunks.push(buffer);
    offset += buffer.length;
  };
  push("%PDF-1.4\n");
  const offsets = new Map();
  const totalObjects = 2 + pageCount * 2;
  for (let number = 1; number <= totalObjects; number += 1) {
    offsets.set(number, offset);
    push(`${number} 0 obj\n${objects.get(number)}\nendobj\n`);
  }
  const xrefOffset = offset;
  push(`xref\n0 ${totalObjects + 1}\n`);
  push("0000000000 65535 f \n");
  for (let number = 1; number <= totalObjects; number += 1) {
    push(`${String(offsets.get(number)).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
};

/** PDF page sizes: three portrait pages and one landscape, like the archives. */
export const FIXTURE_PDF_PAGES = [
  { width: 612, height: 792, colour: [220, 60, 60] },
  { width: 612, height: 792, colour: [60, 220, 60] },
  { width: 792, height: 612, colour: [60, 60, 220] },
];

const FIXTURE_ENTRIES = [
  ...FIXTURE_PAGES.map((page) => ({
    name: page.name,
    data: pngBytes(page.width, page.height, page.colour),
  })),
  ...NOISE,
];

/**
 * Write every fixture under `directory`. `rar` is null when no RAR compressor
 * is installed, which callers must treat as "unverified", not "passing".
 */
export const writeFixture = async (directory) => {
  await mkdir(join(directory, "folder", "nested"), { recursive: true });

  for (const page of FIXTURE_PAGES) {
    await writeFile(join(directory, "folder", page.name), pngBytes(page.width, page.height, page.colour));
  }
  await writeFile(join(directory, "folder", "nested", "page20.bmp"), bmpBytes(700, 500, [90, 90, 140]));
  await writeFile(join(directory, "folder", "notes.txt"), "ignored\n", "utf8");

  const archive = join(directory, "sample.cbz");
  await writeFile(archive, zipBytes(FIXTURE_ENTRIES));

  const sevenZip = join(directory, "sample.cb7");
  await writeFile(sevenZip, await sevenZipBytes(FIXTURE_ENTRIES));

  const pdf = join(directory, "sample.pdf");
  await writeFile(pdf, pdfBytes(FIXTURE_PDF_PAGES));

  const rarBytesResult = await rarBytes(FIXTURE_ENTRIES);
  const rar = rarBytesResult === null ? null : join(directory, "sample.cbr");
  if (rar !== null) await writeFile(rar, rarBytesResult);

  return { archive, folder: join(directory, "folder"), sevenZip, rar, pdf };
};

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const target = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
  const written = await writeFixture(target);
  process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
}
