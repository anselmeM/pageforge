/**
 * Open a comic source: a ZIP-based archive (CBZ/ZIP) or a folder of images.
 *
 * The reader exposes pages in reading order with the header-derived pixel size
 * of each page, so the window can lay out spreads without decoding every image
 * up front. Page bytes are read on demand and never held open after close().
 */

import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";

import yauzl from "yauzl";

import { imageSize, mimeForFormat } from "../core/imageSize.js";
import { applyPageOrder, parseComicInfo } from "../core/comicinfo.js";
import { extensionOf, selectPages } from "../core/pages.js";

const INITIAL_PROBE_BYTES = 16 * 1024;
const MAX_PROBE_BYTES = 512 * 1024;
const MAX_FOLDER_DEPTH = 8;
const PROBE_CONCURRENCY = 8;
const ARCHIVE_EXTENSIONS = new Set([".cbz", ".zip", ".zipx"]);
const RAR_EXTENSIONS = new Set([".cbr", ".rar"]);
const SEVEN_ZIP_EXTENSIONS = new Set([".cb7", ".7z"]);

const EXTENSION_MIME = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".jpe", "image/jpeg"],
  [".jfif", "image/jpeg"],
  [".png", "image/png"],
  [".apng", "image/apng"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".dib", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".avif", "image/avif"],
]);

/** Failure with a stable code so callers can render a useful message. */
export class ReaderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ReaderError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Tracks in-flight page reads so a close can wait for them.
 *
 * Closing an archive releases the file descriptor, but a page read that is
 * already running still holds a reference to the stream that owns it. Deflated
 * entries are piped through zlib, which asks the underlying stream for more data
 * while a read is in flight; releasing the descriptor in that window makes the
 * queued read dereference a released stream inside an fs callback. That is not a
 * rejected promise a caller can handle — it is an uncaught exception in the main
 * process. So a close waits for reads to settle first, with a bound so a stuck
 * read cannot hold the app open forever.
 */
const createReadGate = (timeoutMs = 5000) => {
  let active = 0;
  let idleResolvers = [];
  let closed = false;
  return {
    get active() {
      return active;
    },
    begin() {
      if (closed) throw new ReaderError("reader-closed", "This book is already closed.");
      active += 1;
    },
    end() {
      active -= 1;
      if (active > 0) return;
      const resolvers = idleResolvers;
      idleResolvers = [];
      for (const resolve of resolvers) resolve(true);
    },
    async waitForIdle() {
      closed = true;
      if (active === 0) return true;
      let timer = null;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const settled = await Promise.race([
        new Promise((resolve) => idleResolvers.push(resolve)),
        timedOut,
      ]);
      if (timer !== null) clearTimeout(timer);
      return settled;
    },
  };
};

/** Content type to serve a page with, preferring the sniffed container. */
export const mimeForPage = (page) =>
  (page.format === null ? undefined : mimeForFormat(page.format)) ??
  EXTENSION_MIME.get(extensionOf(page.name)) ??
  "application/octet-stream";

/** Run `task` over `items` with bounded concurrency, preserving input order. */
const mapConcurrent = async (items, limit, task) => {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

const probeFromBuffer = async (readPrefix) => {
  let bytes = await readPrefix(INITIAL_PROBE_BYTES);
  let size = imageSize(bytes);
  if (size === null && bytes.length >= INITIAL_PROBE_BYTES) {
    bytes = await readPrefix(MAX_PROBE_BYTES);
    size = imageSize(bytes);
  }
  return size;
};
const readFilePrefix = async (filePath, maxBytes) => {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/** Collect image files under `root`, up to `MAX_FOLDER_DEPTH` levels deep. */
const collectFolderFiles = async (root) => {
  const found = [];
  const walk = async (directory, depth) => {
    if (depth > MAX_FOLDER_DEPTH) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (entry.isFile()) found.push(relative(root, full).split(sep).join("/"));
    }
  };
  await walk(root, 0);
  return found;
};

/** ComicInfo.xml is small by convention; anything larger is not trusted. */
const MAX_COMICINFO_BYTES = 1 << 20;

const COMICINFO_FILE = "comicinfo.xml";

/**
 * The metadata file among a set of names, preferring the shallowest.
 *
 * A copy buried in a subfolder must not win over one at the root.
 */
export const findComicInfoName = (names) => {
  const candidates = names.filter(
    (name) => name.split("/").pop().toLowerCase() === COMICINFO_FILE,
  );
  if (candidates.length === 0) return null;
  return candidates.sort(
    (a, b) => a.split("/").length - b.split("/").length || a.length - b.length,
  )[0];
};

/** Read and parse ComicInfo.xml, or null when there is none or it is unreadable. */
const readComicInfo = async (names, readBytes) => {
  const name = findComicInfoName(names);
  if (name === null) return null;
  try {
    return parseComicInfo((await readBytes(name)).toString("utf8"));
  } catch {
    // Metadata that cannot be read must never stop a book from opening.
    return null;
  }
};

const openFolder = async (targetPath) => {
  const all = await collectFolderFiles(targetPath);
  const names = selectPages(all);
  if (names.length === 0) {
    throw new ReaderError("no-pages", "No readable page images were found in this folder.", {
      targetPath,
      filesSeen: all.length,
    });
  }
  const pages = await mapConcurrent(names, PROBE_CONCURRENCY, async (name, index) => {
    const absolute = join(targetPath, name.split("/").join(sep));
    const info = await stat(absolute);
    const size = await probeFromBuffer((bytes) => readFilePrefix(absolute, bytes));
    return {
      index,
      name,
      absolutePath: absolute,
      bytes: info.size,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      format: size?.format ?? null,
    };
  });
  const gate = createReadGate();
  const comicInfo = await readComicInfo(all, (name) =>
    readFilePrefix(join(targetPath, name.split("/").join(sep)), MAX_COMICINFO_BYTES),
  );
  return {
    kind: "folder",
    targetPath,
    displayName: basename(targetPath),
    pages: applyPageOrder(pages, comicInfo?.pageOrder),
    comicInfo,
    async readPage(index) {
      const page = pages[index];
      if (page === undefined) throw new ReaderError("page-out-of-range", `No page at index ${index}.`);
      gate.begin();
      try {
        return await readFile(page.absolutePath);
      } finally {
        gate.end();
      }
    },
    async close() {
      // Staged archives delete this tree on close, so the wait also stops a read
      // from racing the deletion.
      await gate.waitForIdle();
    },
  };
};

const openZip = (targetPath) =>
  new Promise((resolve, reject) => {
    yauzl.open(targetPath, { lazyEntries: true, autoClose: false }, (error, zipfile) => {
      if (error) {
        reject(new ReaderError("archive-unreadable", `This archive could not be opened: ${error.message}`, { targetPath }));
        return;
      }
      resolve(zipfile);
    });
  });

/** Walk every central-directory entry once and index it by name. */
const indexZipEntries = (zipfile) =>
  new Promise((resolve, reject) => {
    const entries = new Map();
    zipfile.on("entry", (entry) => {
      entries.set(entry.fileName, entry);
      zipfile.readEntry();
    });
    zipfile.once("end", () => resolve(entries));
    zipfile.once("error", (error) => reject(new ReaderError("archive-unreadable", error.message, { targetPath: zipfile.path })));
    zipfile.readEntry();
  });

const readZipStream = (zipfile, entry) =>
  new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) {
        const encrypted = typeof entry.isEncrypted === "function" && entry.isEncrypted();
        reject(
          new ReaderError(
            encrypted ? "archive-encrypted" : "page-unreadable",
            encrypted
              ? "This archive is password protected."
              : `Page "${entry.fileName}" could not be read: ${error.message}`,
            { entry: entry.fileName },
          ),
        );
        return;
      }
      resolve(stream);
    });
  });

/**
 * Read at most `maxBytes` from a zip entry stream, letting it finish naturally.
 *
 * The stream must not be destroyed early. Deflated entries are piped through
 * zlib, which queues a read on the underlying file stream while one is already
 * running; destroying the stream in that window leaves the queued read using a
 * released context, and it fails inside an fs callback as an uncaught exception
 * rather than as a rejected promise. Draining the entry costs one decompression
 * pass and keeps the stream's own lifecycle intact.
 */
const readStreamPrefix = (stream, maxBytes) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on("data", (chunk) => {
      if (total >= maxBytes) return;
      const take = Math.min(chunk.length, maxBytes - total);
      chunks.push(chunk.subarray(0, take));
      total += take;
    });
    stream.once("end", () => resolve(Buffer.concat(chunks, total)));
    stream.once("error", reject);
  });

/** Probe a zip entry's image header. */
const probeZipEntry = async (zipfile, entry) => {
  const bytes = await readStreamPrefix(await readZipStream(zipfile, entry), MAX_PROBE_BYTES);
  return imageSize(bytes.subarray(0, Math.min(INITIAL_PROBE_BYTES, bytes.length))) ?? imageSize(bytes);
};

const openZipArchive = async (targetPath, onProgress, indexCache) => {
  const extension = extensionOf(targetPath);
  if (!ARCHIVE_EXTENSIONS.has(extension)) {
    throw new ReaderError(
      "format-not-supported-yet",
      `"${extension || "this file"}" archives are not readable yet; CBZ and ZIP are supported in this milestone.`,
      { targetPath, extension },
    );
  }
  const zipfile = await openZip(targetPath);
  const gate = createReadGate();
  try {
    const entries = await indexZipEntries(zipfile);
    const names = selectPages([...entries.keys()]);
    if (names.length === 0) {
      throw new ReaderError("no-pages", "This archive contains no readable page images.", { targetPath });
    }

    // Probing every page means decompressing every page, so a remembered index
    // for the same file at the same size and modification time is used instead.
    const stats = await stat(targetPath);
    const cached = indexCache?.lookup(targetPath, stats) ?? null;
    const reusable =
      cached !== null &&
      cached.pages.length === names.length &&
      cached.pages.every((page, position) => page.name === names[position] && entries.has(page.name));
    if (reusable) {
      onProgress?.({ phase: "Using saved index", done: names.length, total: names.length });
    }

    let pages;
    if (reusable) {
      pages = cached.pages.map((page, index) => ({
        index,
        name: page.name,
        bytes: page.bytes,
        width: page.width,
        height: page.height,
        format: page.format,
        entry: entries.get(page.name),
      }));
    } else {
      // Each page is opened once to read its dimensions, which is the slow part
      // of opening a large archive, so it is reported as it goes.
      let probed = 0;
      pages = await mapConcurrent(names, PROBE_CONCURRENCY, async (name, index) => {
        const entry = entries.get(name);
        const size = await probeZipEntry(zipfile, entry);
        probed += 1;
        onProgress?.({ phase: "Reading page index", done: probed, total: names.length });
        return {
          index,
          name,
          bytes: entry.uncompressedSize,
          width: size?.width ?? 0,
          height: size?.height ?? 0,
          format: size?.format ?? null,
          entry,
        };
      });
    }
    const comicInfo =
      reusable && cached.comicInfo !== undefined
        ? cached.comicInfo
        : await readComicInfo([...entries.keys()], async (name) =>
            readStreamPrefix(await readZipStream(zipfile, entries.get(name)), MAX_COMICINFO_BYTES),
          );
    if (!reusable) indexCache?.store(targetPath, stats, pages, comicInfo);
    return {
      kind: "archive",
      targetPath,
      displayName: basename(targetPath),
      indexCache: reusable ? "hit" : "miss",
      pages: applyPageOrder(pages, comicInfo?.pageOrder),
      comicInfo,
      async readPage(index) {
        const page = pages[index];
        if (page === undefined) throw new ReaderError("page-out-of-range", `No page at index ${index}.`);
        gate.begin();
        try {
          const stream = await readZipStream(zipfile, page.entry);
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          return Buffer.concat(chunks);
        } finally {
          gate.end();
        }
      },
      async close() {
        const settled = await gate.waitForIdle();
        zipfile.close();
        if (!settled) {
          // Reported rather than thrown: the descriptor must still be released,
          // and a caller mid-quit cannot act on a rejection.
          process.stderr.write(
            `PageForge: closed ${targetPath} while ${gate.active} page read(s) were still running.\n`,
          );
        }
      },
    };
  } catch (error) {
    zipfile.close();
    throw error;
  }
};

/**
 * RAR and 7z are extracted to a private staging directory when they are opened.
 *
 * Neither format offers the cheap random access a ZIP central directory does:
 * a solid RAR or 7z stream has to be decompressed in order, and their decoder
 * libraries expose whole-entry extraction only. Reading a few header bytes per
 * page would therefore mean re-decompressing most of the archive many times
 * over. Materialising once turns page reads into ordinary file reads, gives
 * every page a known size up front, and keeps one cleanup owner for the copy.
 */
const releaseStaging = async (staging) => {
  try {
    await rm(staging, { recursive: true, force: true });
  } catch (cause) {
    // Keep the failure visible: the directory outlives this session otherwise,
    // and the caller needs the path to clean it up.
    throw new ReaderError(
      "cleanup-failed",
      `Extracted files could not be removed: ${staging}`,
      { staging, reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
};

const extractRar = async (targetPath, destination) => {
  const { createExtractorFromFile } = await import("node-unrar-js");
  try {
    const extractor = await createExtractorFromFile({ filepath: targetPath, targetPath: destination });
    const headers = [...extractor.getFileList().fileHeaders];
    if (headers.some((header) => header.flags.encrypted)) {
      throw new ReaderError("archive-encrypted", "This archive is password protected.", { targetPath });
    }
    // node-unrar-js extracts lazily: nothing reaches the destination until the
    // `files` generator is consumed, so this loop performs the extraction.
    for (const _file of extractor.extract().files) {
      /* intentionally empty */
    }
  } catch (cause) {
    if (cause instanceof ReaderError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/password|encrypt/i.test(message)) {
      throw new ReaderError("archive-encrypted", "This archive is password protected.", { targetPath });
    }
    throw new ReaderError("archive-unreadable", `This RAR archive could not be read: ${message}`, { targetPath });
  }
};

/** Copy a tree out of 7z-wasm's in-memory filesystem onto the real disk. */
const copyEmscriptenTree = async (fs, source, destination) => {
  for (const name of fs.readdir(source)) {
    if (name === "." || name === "..") continue;
    const child = `${source}/${name}`;
    const target = join(destination, name);
    const info = fs.stat(child);
    if (fs.isDir(info.mode)) {
      await mkdir(target, { recursive: true });
      await copyEmscriptenTree(fs, child, target);
    } else {
      await writeFile(target, Buffer.from(fs.readFile(child)));
    }
  }
};

const extractSevenZip = async (targetPath, destination) => {
  const { default: SevenZip } = await import("7z-wasm");
  const sevenZip = await SevenZip({ print: () => {}, printErr: () => {} });
  const fs = sevenZip.FS;
  const archiveName = `input${extensionOf(targetPath) || ".7z"}`;
  fs.writeFile(archiveName, new Uint8Array(await readFile(targetPath)));
  fs.mkdir("/out");
  try {
    sevenZip.callMain(["x", archiveName, "-o/out", "-y"]);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/password|encrypt/i.test(message)) {
      throw new ReaderError("archive-encrypted", "This archive is password protected.", { targetPath });
    }
    throw new ReaderError("archive-unreadable", `This 7z archive could not be read: ${message}`, { targetPath });
  }
  await copyEmscriptenTree(fs, "/out", destination);
};

/** Open an archive by staging its contents, then reading it as a folder. */
const openStagedArchive = async (targetPath, extract, format) => {
  const staging = await mkdtemp(join(tmpdir(), "pageforge-extract-"));
  let staged = null;
  try {
    await extract(targetPath, staging);
    staged = await openFolder(staging);
  } catch (error) {
    await releaseStaging(staging).catch(() => {});
    throw error;
  }
  return {
    kind: "archive",
    format,
    targetPath,
    displayName: basename(targetPath),
    pages: staged.pages,
    comicInfo: staged.comicInfo,
    readPage: (index) => staged.readPage(index),
    async close() {
      await staged.close();
      await releaseStaging(staging);
    },
  };
};

/** Route an archive to the backend that owns its extension. */
const openArchive = async (targetPath, onProgress, indexCache) => {
  const extension = extensionOf(targetPath);
  if (ARCHIVE_EXTENSIONS.has(extension)) return openZipArchive(targetPath, onProgress, indexCache);
  // RAR and 7z are unpacked by a decoder with no progress feed, so the only
  // honest report is that the whole archive is being staged.
  if (RAR_EXTENSIONS.has(extension)) {
    onProgress?.({ phase: "Unpacking RAR archive", done: 0, total: 0 });
    return openStagedArchive(targetPath, extractRar, "rar");
  }
  if (SEVEN_ZIP_EXTENSIONS.has(extension)) {
    onProgress?.({ phase: "Unpacking 7z archive", done: 0, total: 0 });
    return openStagedArchive(targetPath, extractSevenZip, "7z");
  }
  throw new ReaderError(
    "format-not-supported-yet",
    `"${extension || "this file"}" archives are not readable yet; CBZ, ZIP, CBR, RAR, CB7 and 7Z are supported.`,
    { targetPath, extension },
  );
};

/** Open a folder of images or a supported comic archive. */
export const openTarget = async (targetPath, options = {}) => {
  const { onProgress, indexCache } = options;
  const info = await stat(targetPath);
  if (info.isDirectory()) return openFolder(targetPath);
  if (!info.isFile()) {
    throw new ReaderError("unsupported-target", "Only files and folders can be opened.", { targetPath });
  }
  return openArchive(targetPath, onProgress, indexCache);
};
