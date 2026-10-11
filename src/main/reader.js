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
  return {
    kind: "folder",
    targetPath,
    displayName: basename(targetPath),
    pages,
    async readPage(index) {
      const page = pages[index];
      if (page === undefined) throw new ReaderError("page-out-of-range", `No page at index ${index}.`);
      return readFile(page.absolutePath);
    },
    async close() {},
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

/** Read at most `maxBytes` from a zip entry stream, then release it. */
const readStreamPrefix = (stream, maxBytes) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      stream.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, total));
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) finish();
    };
    const onEnd = () => finish();
    const onError = (error) => finish(error);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });

const openZipArchive = async (targetPath) => {
  const extension = extensionOf(targetPath);
  if (!ARCHIVE_EXTENSIONS.has(extension)) {
    throw new ReaderError(
      "format-not-supported-yet",
      `"${extension || "this file"}" archives are not readable yet; CBZ and ZIP are supported in this milestone.`,
      { targetPath, extension },
    );
  }
  const zipfile = await openZip(targetPath);
  try {
    const entries = await indexZipEntries(zipfile);
    const names = selectPages([...entries.keys()]);
    if (names.length === 0) {
      throw new ReaderError("no-pages", "This archive contains no readable page images.", { targetPath });
    }
    const pages = await mapConcurrent(names, PROBE_CONCURRENCY, async (name, index) => {
      const entry = entries.get(name);
      const size = await probeFromBuffer(async (bytes) =>
        readStreamPrefix(await readZipStream(zipfile, entry), bytes),
      );
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
    return {
      kind: "archive",
      targetPath,
      displayName: basename(targetPath),
      pages,
      async readPage(index) {
        const page = pages[index];
        if (page === undefined) throw new ReaderError("page-out-of-range", `No page at index ${index}.`);
        const stream = await readZipStream(zipfile, page.entry);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks);
      },
      async close() {
        zipfile.close();
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
    readPage: (index) => staged.readPage(index),
    async close() {
      await staged.close();
      await releaseStaging(staging);
    },
  };
};

/** Route an archive to the backend that owns its extension. */
const openArchive = async (targetPath) => {
  const extension = extensionOf(targetPath);
  if (ARCHIVE_EXTENSIONS.has(extension)) return openZipArchive(targetPath);
  if (RAR_EXTENSIONS.has(extension)) return openStagedArchive(targetPath, extractRar, "rar");
  if (SEVEN_ZIP_EXTENSIONS.has(extension)) return openStagedArchive(targetPath, extractSevenZip, "7z");
  throw new ReaderError(
    "format-not-supported-yet",
    `"${extension || "this file"}" archives are not readable yet; CBZ, ZIP, CBR, RAR, CB7 and 7Z are supported.`,
    { targetPath, extension },
  );
};

/** Open a folder of images or a supported comic archive. */
export const openTarget = async (targetPath) => {
  const info = await stat(targetPath);
  if (info.isDirectory()) return openFolder(targetPath);
  if (!info.isFile()) {
    throw new ReaderError("unsupported-target", "Only files and folders can be opened.", { targetPath });
  }
  return openArchive(targetPath);
};
