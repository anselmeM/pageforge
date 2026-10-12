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
  //
  // Each check gets its own state directory. Sharing one let a check that turns a
  // mode on leave it on for the next check, so a later "toggle" turned it off
  // again and the failure looked like a product bug rather than test coupling.
  const envFor = (name) => {
    const env = { ...process.env, PAGEFORGE_STATE_DIR: join(workspace, `state-${name}`) };
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  };
  const env = envFor("formats");

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
    const result = await run(
      ["--smoke", `--report=${reportFile}`, testCase.target],
      envFor(`format-${testCase.label}`),
    );
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

  // Full screen must be enterable and leavable, and the window must come back.
  // A user stuck in full screen with no visible toolbar has no way out, so this
  // is a correctness check rather than a nicety.
  for (const [label, command, expected] of [
    ["full screen on", "toggle-fullscreen", true],
    ["full screen on then off", "toggle-fullscreen,fullscreen-off", false],
  ]) {
    const reportFile = join(workspace, `report-${label.replaceAll(/\s+/gu, "-")}.json`);
    const result = await run(
      ["--smoke", `--report=${reportFile}`, `--command=${command}`, fixture.archive],
      envFor(`fullscreen-${label.replaceAll(/\s+/gu, "-")}`),
    );
    let report = null;
    try {
      report = JSON.parse(await readFile(reportFile, "utf8"));
    } catch {
      report = parseReport(result.stdout);
    }
    try {
      if (report === null) {
        throw new Error(`no report (exit=${result.code})\n${result.stdout}\n${result.stderr}`);
      }
      assert.equal(report.smoke, "ok", `app reported ${JSON.stringify(report)}`);
      assert.equal(report.fullscreen, expected, `${label}: window state`);
      process.stdout.write(`verify-dist: ${label} OK — fullscreen=${report.fullscreen}\n`);
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  }

  // Guided view must find the panels of a panelled page and frame the first one.
  {
    const reportFile = join(workspace, "report-guided.json");
    const result = await run(
      ["--smoke", `--report=${reportFile}`, "--command=toggle-guided", fixture.panels],
      envFor("guided"),
    );
    let report = null;
    try {
      report = JSON.parse(await readFile(reportFile, "utf8"));
    } catch {
      report = parseReport(result.stdout);
    }
    try {
      if (report === null) {
        throw new Error(`no report (exit=${result.code})\n${result.stdout}\n${result.stderr}`);
      }
      assert.equal(report.smoke, "ok", `app reported ${JSON.stringify(report)}`);
      assert.equal(report.guidedView, true, "guided view is on");
      assert.equal(report.guidedPanels, 4, "a two-by-two page has four panels");
      assert.equal(report.guidedStep, 0, "the camera starts on the first panel");
      process.stdout.write(`verify-dist: guided view OK — ${report.guidedPanels} panels detected\n`);
    } catch (error) {
      failures.push(`guided: ${error.message}`);
    }
  }

  // Vertical scrolling builds a column with one row per page.
  {
    const reportFile = join(workspace, "report-vertical.json");
    const result = await run(
      ["--smoke", `--report=${reportFile}`, "--command=toggle-vertical", fixture.archive],
      envFor("vertical"),
    );
    let report = null;
    try {
      report = JSON.parse(await readFile(reportFile, "utf8"));
    } catch {
      report = parseReport(result.stdout);
    }
    try {
      if (report === null) {
        throw new Error(`no report (exit=${result.code})\n${result.stdout}\n${result.stderr}`);
      }
      assert.equal(report.smoke, "ok", `app reported ${JSON.stringify(report)}`);
      assert.equal(report.verticalScroll, true, "vertical scroll is on");
      assert.equal(report.verticalPages, 4, "a four-page book gets a four-row column");
      process.stdout.write(
        `verify-dist: vertical scroll OK — ${report.verticalPages} pages in the column\n`,
      );
    } catch (error) {
      failures.push(`vertical: ${error.message}`);
    }
  }

  // The panel strip stacks a page's panels as rows; the solid-colour archive used
  // above has no panels, so it stays whole-page rows and this fixture is needed.
  {
    const reportFile = join(workspace, "report-strip.json");
    const result = await run(
      ["--smoke", `--report=${reportFile}`, "--command=toggle-vertical", fixture.panels],
      envFor("panel-strip"),
    );
    let report = null;
    try {
      report = JSON.parse(await readFile(reportFile, "utf8"));
    } catch {
      report = parseReport(result.stdout);
    }
    try {
      if (report === null) {
        throw new Error(`no report (exit=${result.code})\n${result.stdout}\n${result.stderr}`);
      }
      assert.equal(report.smoke, "ok", `app reported ${JSON.stringify(report)}`);
      assert.equal(report.stripActive, true, "the strip is on");
      assert.equal(report.stripPanelTitle, 4, "the page was read as four panels");
      assert.equal(report.verticalPages, 4, "so the column has four rows, not one");
      process.stdout.write(`verify-dist: panel strip OK — ${report.verticalPages} panel rows\n`);
    } catch (error) {
      failures.push(`panel strip: ${error.message}`);
    }
  }

  // A book that describes itself: ComicInfo.xml must decide the reading direction
  // and the page order. The fixture's <Pages> order is the reverse of the file
  // names, so an ignored file shows page01 first and this fails.
  {
    const reportFile = join(workspace, "report-comicinfo.json");
    const result = await run(["--smoke", `--report=${reportFile}`, fixture.manga], envFor("comicinfo"));
    let report = null;
    try {
      report = JSON.parse(await readFile(reportFile, "utf8"));
    } catch {
      report = parseReport(result.stdout);
    }
    try {
      if (report === null) {
        throw new Error(`no report (exit=${result.code})\n${result.stdout}\n${result.stderr}`);
      }
      assert.equal(report.smoke, "ok", `app reported ${JSON.stringify(report)}`);
      assert.equal(report.comicInfoDirection, "rtl", "the book says right-to-left");
      assert.equal(report.rightToLeft, true, "so the reader is right-to-left");
      assert.equal(report.firstPageName, "page03.png", "and starts on the page the file put first");
      assert.equal(report.comicInfoLabel, "Test Manga #3", "series and number are read");
      process.stdout.write(`verify-dist: ComicInfo OK — ${report.comicInfoLabel}, rtl, pages reordered\n`);
    } catch (error) {
      failures.push(`comicinfo: ${error.message}`);
    }
  }

  // The saved index must skip re-reading every page on the second open, and
  // must not change what the pages are.
  {
    const state = join(workspace, "state-index-cache");
    const shared = { ...process.env, PAGEFORGE_STATE_DIR: state };
    delete shared.ELECTRON_RUN_AS_NODE;
    const firstFile = join(workspace, "report-cache-first.json");
    const secondFile = join(workspace, "report-cache-second.json");
    try {
      await run(["--smoke", `--report=${firstFile}`, fixture.archive], shared);
      await run(["--smoke", `--report=${secondFile}`, fixture.archive], shared);
      const first = JSON.parse(await readFile(firstFile, "utf8"));
      const second = JSON.parse(await readFile(secondFile, "utf8"));
      assert.equal(first.indexCache, "miss", "the first open has nothing saved yet");
      assert.equal(second.indexCache, "hit", "the second open should use the saved index");
      assert.deepEqual(
        second.firstPageProbe,
        first.firstPageProbe,
        "a cached index reports the same page dimensions",
      );
      assert.equal(second.pages, first.pages, "and the same page count");
      process.stdout.write(
        `verify-dist: index cache OK — ${first.openMs}ms then ${second.openMs}ms\n`,
      );
    } catch (error) {
      failures.push(`index cache: ${error.message}`);
    }
  }

  // The thumbnail strip must mount a window, not a page per element: a 240-page
  // book should not be 240 nodes with an image each.
  {
    const reportFile = join(workspace, "report-thumbnails.json");
    const result = await run(
      ["--smoke", `--report=${reportFile}`, "--command=toggle-thumbnails", fixture.many],
      envFor("thumbnails"),
    );
    let report = null;
    try {
      report = JSON.parse(await readFile(reportFile, "utf8"));
    } catch {
      report = parseReport(result.stdout);
    }
    try {
      if (report === null) {
        throw new Error(`no report (exit=${result.code})\n${result.stdout}\n${result.stderr}`);
      }
      assert.equal(report.smoke, "ok", `app reported ${JSON.stringify(report)}`);
      assert.equal(report.thumbnailPages, 240, "the book has 240 pages");
      assert.ok(report.thumbnails > 0, "some thumbnails are mounted");
      assert.ok(
        report.thumbnails < 60,
        `240 pages mounted ${report.thumbnails} thumbnails; the strip is not virtualising`,
      );
      assert.equal(
        report.thumbnailsFilled,
        report.thumbnails,
        "every mounted thumbnail should have its preview",
      );
      process.stdout.write(
        `verify-dist: thumbnails OK — ${report.thumbnails} of ${report.thumbnailPages} pages mounted\n`,
      );
    } catch (error) {
      failures.push(`thumbnails: ${error.message}`);
    }
  }

  // Page turns must be counted, and finishing a book recorded once.
  {
    const reportFile = join(workspace, "report-achievements.json");
    const result = await run(
      [
        "--smoke",
        `--report=${reportFile}`,
        "--command=next-page,next-page,next-page",
        fixture.archive,
      ],
      envFor("achievements"),
    );
    let report = null;
    try {
      report = JSON.parse(await readFile(reportFile, "utf8"));
    } catch {
      report = parseReport(result.stdout);
    }
    try {
      if (report === null) {
        throw new Error(`no report (exit=${result.code})\n${result.stdout}\n${result.stderr}`);
      }
      assert.equal(report.smoke, "ok", `app reported ${JSON.stringify(report)}`);
      assert.equal(report.achievements?.pagesTurned, 3, "three page turns were made");
      assert.equal(report.achievements?.booksFinished, 1, "the four-page book was finished");
      assert.ok((report.achievements?.earned ?? 0) >= 2, "First Page and Finisher were earned");
      process.stdout.write(
        `verify-dist: achievements OK — ${report.achievements.earned} earned, ` +
          `${report.achievements.pagesTurned} pages turned\n`,
      );
    } catch (error) {
      failures.push(`achievements: ${error.message}`);
    }
  }

  // The library must run on the database, and a second launch must read it rather
  // than start again.
  {
    const state = join(workspace, "state-library");
    const env = { ...process.env, PAGEFORGE_STATE_DIR: state };
    delete env.ELECTRON_RUN_AS_NODE;
    const firstFile = join(workspace, "report-library-first.json");
    const secondFile = join(workspace, "report-library-second.json");
    try {
      await run(
        ["--smoke", `--report=${firstFile}`, "--command=next-page,next-page", fixture.archive],
        env,
      );
      await run(["--smoke", `--report=${secondFile}`, fixture.archive], env);
      const first = JSON.parse(await readFile(firstFile, "utf8"));
      const second = JSON.parse(await readFile(secondFile, "utf8"));
      assert.equal(first.storage, "sqlite", `the library is on the database, not ${first.storage}`);
      assert.equal(second.storage, "sqlite", "and still is on the next launch");
      // The second launch resumed, which proves it read the stored position.
      assert.equal(second.startPage, first.startPage, "the position survived the restart");
      assert.equal(second.startPage, 3, "and it is the page the first run stopped on");
      process.stdout.write(
        `verify-dist: library storage OK — ${second.storage}, resumed at page ${second.startPage}\n`,
      );
    } catch (error) {
      failures.push(`library storage: ${error.message}`);
    }
  }

  // The capture path exercises the full render pipeline, not just the loader.
  const screenshot = join(workspace, "packaged.png");
  const captured = await run([`--capture=${screenshot}`, fixture.archive], envFor("capture"));
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
