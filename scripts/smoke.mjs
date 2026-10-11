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

const runElectron = (args, timeoutMs = 90_000) =>
  new Promise((resolve) => {
    // See scripts/launch.mjs: an inherited ELECTRON_RUN_AS_NODE would start
    // Electron as plain Node, where the electron module has no API.
    const env = { ...process.env };
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
const failures = [];
const skipped = [];

try {
  const fixture = await writeFixture(workspace);

  const cases = [
    {
      label: "CBZ",
      target: fixture.archive,
      expected: { pages: 4, format: "png", width: 600, height: 900 },
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
    const result = await runElectron([".", "--smoke", testCase.target]);
    const report = parseReport(result.stdout);

    try {
      if (report === null) {
        throw new Error(
          `no report (exit=${result.code} signal=${result.signal})\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        );
      }
      assert.equal(report.smoke, "ok", `app reported ${JSON.stringify(report)}`);
      assert.equal(report.pages, testCase.expected.pages, `${testCase.label} page count`);
      assert.equal(report.spreads, testCase.expected.pages, `${testCase.label} spread count`);
      assert.equal(report.spreadPages, 1, `${testCase.label} first spread size`);
      assert.equal(report.renderedPages, 1, `${testCase.label} rendered page count`);
      assert.equal(report.firstPageRendered, true, `${testCase.label} first page rendered`);
      assert.equal(report.firstPageFormat, testCase.expected.format, `${testCase.label} first page format`);
      assert.equal(report.firstPageProbe.width, testCase.expected.width, `${testCase.label} first page width`);
      assert.equal(report.firstPageProbe.height, testCase.expected.height, `${testCase.label} first page height`);
      process.stdout.write(
        `smoke: ${testCase.label} OK — ${report.pages} pages, first page ${report.firstPageFormat} ${report.firstPageProbe.width}x${report.firstPageProbe.height} rendered\n`,
      );
    } catch (error) {
      failures.push(`${testCase.label}: ${error.message}`);
    }
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
