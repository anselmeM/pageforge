/**
 * Verify a packaged PageForge build by running it.
 *
 * Packaging changes the environment the reader runs in: the app lives inside an
 * asar archive, and the WASM decoders (7z, unrar) sit outside it in
 * `app.asar.unpacked`. A build can package cleanly and still fail to open a
 * CB7 or CBR, so every format is opened through the real executable here.
 *
 * Usage: node scripts/verify-dist.mjs [path-to-exe]
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFixture } from "./make-fixture.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const candidates = [
  process.argv[2],
  join(projectRoot, "release", "win-unpacked", "PageForge.exe"),
  ...["0.1.0"].map((version) => join(projectRoot, "release", `PageForge-${version}-portable.exe`)),
].filter((candidate) => typeof candidate === "string");

const executable = candidates.find((candidate) => existsSync(candidate));
if (executable === undefined) {
  process.stderr.write(
    `verify-dist: no packaged executable found. Run \`npm run dist\` first.\nChecked:\n${candidates.map((c) => `  ${c}`).join("\n")}\n`,
  );
  process.exit(1);
}

const run = (args, env, timeoutMs = 120_000) =>
  new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
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
      /* Chromium writes non-JSON lines to stdout too. */
    }
  }
  return null;
};

const workspace = await mkdtemp(join(tmpdir(), "pageforge-dist-"));
const failures = [];

try {
  const fixture = await writeFixture(workspace);
  // A packaged parent may have exported ELECTRON_RUN_AS_NODE; without clearing
  // it, the executable would start as plain Node.
  const env = { ...process.env, PAGEFORGE_STATE_DIR: join(workspace, "state") };
  delete env.ELECTRON_RUN_AS_NODE;

  const size = (await stat(executable)).size;
  process.stdout.write(`verify-dist: ${executable} (${(size / 1024 / 1024).toFixed(1)} MB)\n`);

  const stagingDirectories = async () =>
    (await readdir(tmpdir())).filter((name) => name.startsWith("pageforge-extract-"));
  const stagingBefore = new Set(await stagingDirectories());

  const cases = [
    { label: "CBZ", target: fixture.archive, pages: 4, format: "png" },
    { label: "CB7 (wasm, unpacked)", target: fixture.sevenZip, pages: 4, format: "png" },
    { label: "CBR (wasm, unpacked)", target: fixture.rar, pages: 4, format: "png" },
    { label: "PDF (pdf.js from asar)", target: fixture.pdf, pages: 3, format: "pdf" },
  ];

  for (const testCase of cases) {
    if (testCase.target === null) {
      process.stdout.write(`verify-dist: ${testCase.label} skipped (no RAR compressor)\n`);
      continue;
    }
    // Read the report from a file, not the pipe: the portable launcher does not
    // attach the app's stdout.
    const reportFile = join(workspace, `report-${testCase.label.replaceAll(/[^a-z0-9]/giu, "")}.json`);
    const result = await run(["--smoke", `--report=${reportFile}`, testCase.target], env);
    let report = null;
    try {
      report = JSON.parse(await readFile(reportFile, "utf8"));
    } catch {
      report = parseReport(result.stdout);
    }
    try {
      if (report === null) {
        throw new Error(
          `no report (exit=${result.code} signal=${result.signal})\n${result.stdout}\n${result.stderr}`,
        );
      }
      assert.equal(report.smoke, "ok", `app reported ${JSON.stringify(report)}`);
      assert.equal(report.pages, testCase.pages, "page count");
      assert.equal(report.firstPageRendered, true, "first page rendered");
      assert.equal(report.firstPageFormat, testCase.format, "first page format");
      process.stdout.write(`verify-dist: ${testCase.label} OK — ${report.pages} pages\n`);
    } catch (error) {
      failures.push(`${testCase.label}: ${error.message}`);
    }
  }

  // The capture path exercises the full render pipeline, not just the loader.
  const screenshot = join(workspace, "packaged.png");
  const captured = await run([`--capture=${screenshot}`, fixture.archive], env);
  try {
    const info = await stat(screenshot);
    assert.ok(info.size > 5_000, `screenshot is suspiciously small (${info.size} bytes)`);
    assert.equal(captured.code, 0, `capture exited ${captured.code}`);
    process.stdout.write(`verify-dist: capture OK — ${(info.size / 1024).toFixed(0)} KB PNG\n`);
  } catch (error) {
    failures.push(`capture: ${error.message}\n${captured.stdout}\n${captured.stderr}`);
  }

  // Extracting a RAR or 7z stages a directory; the packaged app must remove it
  // before it exits, including on the automated exit paths.
  try {
    const stagingAfter = await stagingDirectories();
    const leaked = stagingAfter.filter((name) => !stagingBefore.has(name));
    assert.deepEqual(leaked, [], `staged extraction directories were left behind`);
    process.stdout.write("verify-dist: cleanup OK — no staged directories left behind\n");
  } catch (error) {
    failures.push(`cleanup: ${error.message}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await rm(workspace, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`verify-dist: FAILED — ${failure}\n`);
  process.exit(1);
}
process.stdout.write("verify-dist: packaged build passed\n");
