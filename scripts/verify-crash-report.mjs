/**
 * End-to-end check that opt-in crash reporting really posts what it claims.
 *
 * A local server plays the part of the destination, so the request the app makes
 * is inspected rather than assumed: the URL, the auth header, and the event body.
 * That is a stronger check than "the reporter initialised", and it is the part
 * that cannot be verified any other way without a Sentry account.
 *
 * Reporting stays off unless it is switched on, which is asserted here too.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFixture } from "./make-fixture.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = await writeFixture(join(projectRoot, "fixtures"));
const workspace = await mkdtemp(join(tmpdir(), "pageforge-crash-"));
const failures = [];

/** A server that records what it is sent and always accepts. */
const startServer = () =>
  new Promise((resolve) => {
    const received = [];
    const server = createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          method: request.method,
          url: request.url,
          auth: request.headers["x-sentry-auth"] ?? null,
          contentType: request.headers["content-type"] ?? null,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"id":"ok"}');
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, received, port: server.address().port }));
  });

const runElectron = (args, env) =>
  new Promise((resolve) => {
    const child = spawn(join(projectRoot, "node_modules", "electron", "dist", "electron.exe"), [".", ...args], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. With reporting off, a test report must be refused and nothing must be sent.
{
  const { server, received, port } = await startServer();
  const stateDirectory = join(workspace, "off");
  const { createStore } = await import("../src/main/store.js");
  const store = await createStore({ directory: stateDirectory });
  await store.setPreference("crashReporting", false);
  await store.flush();

  const env = {
    ...process.env,
    PAGEFORGE_STATE_DIR: stateDirectory,
    PAGEFORGE_SENTRY_DSN: `http://testkey@127.0.0.1:${port}/1`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await runElectron(["--smoke", `--report=${join(workspace, "off.json")}`, "--command=send-test-report", fixtures.archive], env);
  await sleep(500);
  server.close();
  try {
    assert.equal(result.code, 0, `exit ${result.code}: ${result.stderr.slice(-400)}`);
    const report = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(workspace, "off.json"), "utf8")));
    assert.equal(report.crashReport.ok, false, "reporting off must refuse to send");
    assert.equal(received.length, 0, `reporting off sent ${received.length} request(s)`);
    process.stdout.write("crash-report: OFF OK — nothing was sent and the test refused\n");
  } catch (error) {
    failures.push(`off: ${error.message}`);
  }
}

// 2. With reporting on, the request must arrive, well formed.
{
  const { server, received, port } = await startServer();
  const stateDirectory = join(workspace, "on");
  const { createStore } = await import("../src/main/store.js");
  const store = await createStore({ directory: stateDirectory });
  await store.setPreference("crashReporting", true);
  await store.flush();

  const env = {
    ...process.env,
    PAGEFORGE_STATE_DIR: stateDirectory,
    PAGEFORGE_SENTRY_DSN: `http://testkey@127.0.0.1:${port}/1`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await runElectron(["--smoke", `--report=${join(workspace, "on.json")}`, "--command=send-test-report", fixtures.archive], env);

  // The report is written before the request settles, so give it a moment.
  for (let attempt = 0; attempt < 40 && received.length === 0; attempt += 1) await sleep(100);
  server.close();
  try {
    assert.equal(result.code, 0, `exit ${result.code}: ${result.stderr.slice(-400)}`);
    const fs = await import("node:fs/promises");
    const report = JSON.parse(await fs.readFile(join(workspace, "on.json"), "utf8"));
    assert.equal(report.crashReport.ok, true, `the app reported ${JSON.stringify(report.crashReport)}`);
    assert.equal(received.length, 1, `expected one request, got ${received.length}`);
    const sent = received[0];
    assert.equal(sent.method, "POST");
    assert.equal(sent.url, "/api/1/store/", "the documented ingest path");
    assert.match(sent.auth ?? "", /sentry_key=testkey/u);
    assert.match(sent.contentType ?? "", /application\/json/u);
    const event = JSON.parse(sent.body);
    assert.equal(event.platform, "node");
    assert.equal(event.level, "error");
    assert.match(event.event_id, /^[0-9a-f]{32}$/u);
    assert.match(event.release, /^pageforge@\d+\.\d+\.\d+$/u, `release was ${event.release}`);
    assert.ok(event.timestamp, "the event carries a timestamp");
    assert.match(event.message, /test crash report/iu);
    assert.equal(event.tags.origin, "main-process");
    assert.ok(Array.isArray(event.exception.values), "the structured exception is present");
    // The reader's account name must not be in the payload.
    assert.ok(!sent.body.includes(process.env.USERNAME ?? "\u0000"), "the account name leaked");
    process.stdout.write(
      `crash-report: ON OK — POST ${sent.url} with ${event.event_id}, ${sent.body.length} bytes, no account name\n`,
    );
  } catch (error) {
    failures.push(`on: ${error.message}`);
  }
}

await rm(workspace, { recursive: true, force: true }).catch(() => {});

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`crash-report: FAILED — ${failure}\n`);
  process.exit(1);
}
process.stdout.write("crash-report: opt-in reporting verified\n");
