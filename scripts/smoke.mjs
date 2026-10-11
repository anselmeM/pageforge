/**
 * End-to-end smoke test.
 *
 * Builds every fixture, launches the real Electron app against each format, and
 * asserts that the window reported a loaded book and a decoded first page. This
 * is the only check that exercises the main process, the page and document
 * protocols, the preload bridge and the viewer together, so it is what proves
 * the app actually runs.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { writeFixture } from "./make-fixture.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electronPath = require("electron");

const runElectron = (args, { timeoutMs = 90_000, env: extraEnv = {} } = {}) =>
  new Promise((resolve) => {
    // See scripts/launch.mjs: an inherited ELECTRON_RUN_AS_NODE would start
    // Electron as plain Node, where the electron module has no API.
    const env = { ...process.env, ...extraEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });

const parseReport = (stdout) => {
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed);
      if (typeof value === "object" && value !== null && "smoke" in value) return value;
    } catch {
      /* Electron and Chromium also write non-JSON lines to stdout. */
    }
  }
  return null;
};

const workspace = await mkdtemp(join(tmpdir(), "pageforge-smoke-"));
/** Keeps the run away from the real library. */
const stateDirectory = join(workspace, "state");
const failures = [];
const skipped = [];

/** Read `a.b.c` out of the report, so expectations can name nested fields. */
const valueAt = (object, path) =>
  path.split(".").reduce((value, key) => (value === null || value === undefined ? value : value[key]), object);

const check = (label, report, expectations) => {
  assert.equal(report.smoke, "ok", `${label}: app reported ${JSON.stringify(report)}`);
  for (const [key, expected] of Object.entries(expectations)) {
    assert.deepEqual(valueAt(report, key), expected, `${label}: ${key}`);
  }
};

try {
  const fixture = await writeFixture(workspace);
  const env = { PAGEFORGE_STATE_DIR: stateDirectory };

  const cases = [
    {
      label: "CBZ",
      target: fixture.archive,
      args: ["--command=toggle-thumbnails"],
      expected: { pages: 4, format: "png", width: 600, height: 900, thumbnails: 4, startPage: 1 },
    },
    {
      label: "CB7",
      target: fixture.sevenZip,
      expected: { pages: 4, format: "png", width: 600, height: 900 },
    },
    {
      label: "CBR",
      target: fixture.rar,
      expected: { pages: 4, format: "png", width: 600, height: 900 },
    },
    {
      label: "PDF",
      target: fixture.pdf,
      expected: { pages: 3, format: "pdf", width: 612, height: 792 },
    },
  ];

  for (const testCase of cases) {
    if (testCase.target === null) {
      skipped.push(`${testCase.label}: no RAR compressor installed, so CBR stays unverified`);
      continue;
    }
    process.stdout.write(`smoke: launching electron against ${testCase.label}\n`);
    const result = await runElectron([".", "--smoke", ...(testCase.args ?? []), testCase.target], { env });
    const report = parseReport(result.stdout);

    try {
      if (report === null) {
        throw new Error(
          `no report (exit=${result.code} signal=${result.signal})\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        );
      }
      check(testCase.label, report, {
        pages: testCase.expected.pages,
        spreads: testCase.expected.pages,
        spreadPages: 1,
        renderedPages: 1,
        firstPageRendered: true,
        firstPageFormat: testCase.expected.format,
        "firstPageProbe.width": testCase.expected.width,
        "firstPageProbe.height": testCase.expected.height,
        ...(testCase.expected.thumbnails === undefined ? {} : { thumbnails: testCase.expected.thumbnails }),
        ...(testCase.expected.startPage === undefined ? {} : { startPage: testCase.expected.startPage }),
      });
      process.stdout.write(
        `smoke: ${testCase.label} OK — ${report.pages} pages, first page ${report.firstPageFormat} ${report.firstPageProbe.width}x${report.firstPageProbe.height} rendered\n`,
      );
    } catch (error) {
      failures.push(`${testCase.label}: ${error.message}`);
    }
  }

  /* Library persistence: seed a position and a bookmark, then reopen. */
  process.stdout.write("smoke: checking resume, bookmarks and history across restarts\n");
  try {
    const { createStore } = await import("../src/main/store.js");
    const store = await createStore({ directory: stateDirectory });
    await store.recordOpen({
      targetPath: fixture.archive,
      displayName: "sample.cbz",
      kind: "archive",
      pages: 4,
    });
    await store.recordProgress(fixture.archive, 3);
    await store.addBookmark(fixture.archive, 2, "Chapter 1");
    await store.flush();

    const result = await runElectron([".", "--smoke", fixture.archive], { env });
    const report = parseReport(result.stdout);
    if (report === null) {
      throw new Error(`no report on reopen (exit=${result.code})\n${result.stdout}\n${result.stderr}`);
    }
    check("REOPEN", report, { pages: 4, startPage: 3, bookmarkCount: 1 });
    assert.equal(report.historyCount >= 1, true, "REOPEN: history was not kept");
    process.stdout.write(`smoke: REOPEN OK — resumed at page ${report.startPage} with ${report.bookmarkCount} bookmark\n`);
  } catch (error) {
    failures.push(`REOPEN: ${error.message}`);
  }

  /* Reading quality: colour correction and high-quality scaling. */
  process.stdout.write("smoke: checking colour correction and scaling quality\n");
  try {
    const { createStore } = await import("../src/main/store.js");
    const store = await createStore({ directory: stateDirectory });
    await store.setPreference("colorMode", "auto");
    await store.setPreference("colorSensitivity", 1);
    await store.setPreference("resampling", "high");
    await store.flush();

    const result = await runElectron([".", "--smoke", fixture.cast], { env });
    const report = parseReport(result.stdout);
    if (report === null) {
      throw new Error(`no report for the colour case (exit=${result.code})\n${result.stdout}\n${result.stderr}`);
    }
    assert.equal(report.smoke, "ok", `app reported ${JSON.stringify(report)}`);
    assert.equal(report.colorMode, "auto");
    // The fixture page is a warm 200/150/120 wash, so grey-world white balance
    // must pull red down and push blue up.
    assert.ok(report.colorGains.r < 0.95, `expected red to be reduced, got ${report.colorGains.r}`);
    assert.ok(report.colorGains.b > 1.05, `expected blue to be raised, got ${report.colorGains.b}`);
    assert.ok(Math.abs(report.colorGains.g - 1) < 0.1, `green should barely move, got ${report.colorGains.g}`);
    // High-quality scaling means the page is drawn through a canvas.
    assert.deepEqual(report.nodeKinds, ["resample"], "expected the page to be resampled through a canvas");
    process.stdout.write(
      `smoke: QUALITY OK — white balance r=${report.colorGains.r.toFixed(3)} g=${report.colorGains.g.toFixed(3)} b=${report.colorGains.b.toFixed(3)}, page drawn via ${report.nodeKinds[0]}\n`,
    );
  } catch (error) {
    failures.push(`QUALITY: ${error.message}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await rm(workspace, { recursive: true, force: true });
}

for (const note of skipped) process.stdout.write(`smoke: SKIPPED — ${note}\n`);
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`smoke: FAILED — ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`smoke: all ${failures.length === 0 ? "checked" : ""} formats passed\n`);
