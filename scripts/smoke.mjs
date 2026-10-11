/**
 * End-to-end smoke test.
 *
 * Builds the fixture, launches the real Electron app against it, and asserts
 * that the window reported a loaded book and a decoded first page. This is the
 * only check that exercises the page protocol, the preload bridge and the
 * viewer together, so it is what proves the app actually runs.
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

const runElectron = (args, timeoutMs = 60_000) =>
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
let failure = null;

try {
  const fixture = await writeFixture(workspace);
  process.stdout.write(`smoke: launching electron against ${fixture.archive}\n`);
  const result = await runElectron([".", "--smoke", fixture.archive]);
  const report = parseReport(result.stdout);

  if (report === null) {
    failure = `The app produced no report.\nexit=${result.code} signal=${result.signal}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
  } else if (report.smoke !== "ok") {
    failure = `The app reported a failure: ${JSON.stringify(report)}`;
  } else {
    assert.equal(report.pages, 4, "expected the four fixture pages");
    assert.equal(report.spreads, 4, "expected one spread per page in single-page mode");
    assert.equal(report.spreadPages, 1, "expected the first spread to hold one page");
    assert.equal(report.renderedImages, 1, "expected one image element for the first spread");
    assert.equal(report.firstPageProbe.width, 600, "expected the header probe to report page width");
    assert.equal(report.firstPageProbe.height, 900, "expected the header probe to report page height");
    assert.equal(report.firstImageLoaded, true, "expected the first page image to decode");
    assert.equal(report.firstImageNaturalWidth, 600, "expected the decoded image width");
    process.stdout.write(
      `smoke: OK — ${report.pages} pages, ${report.spreads} spreads, first page decoded at ${report.firstImageNaturalWidth}px, file ${report.displayName}\n`,
    );
  }
} catch (error) {
  failure = error instanceof Error ? `${error.message}` : String(error);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

if (failure !== null) {
  process.stderr.write(`smoke: FAILED — ${failure}\n`);
  process.exit(1);
}
