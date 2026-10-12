/**
 * IPC wiring tests.
 *
 * These read the main process and the preload as text, because the failure they
 * guard against is invisible at runtime until it happens: registering the same
 * channel twice throws at startup, and the symptom is the whole app hanging
 * rather than an error where the mistake is.
 *
 * That is not hypothetical — a careless edit during a refactor duplicated one
 * handler and every smoke case timed out until it was found.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mainSource = await readFile(join(projectRoot, "src/main/main.cjs"), "utf8");
const preloadSource = await readFile(join(projectRoot, "src/main/preload.cjs"), "utf8");

/** Channels registered with `ipcMain.handle` in the main process. */
const handlerChannels = [...mainSource.matchAll(/ipcMain\.handle\(\s*["']([^"']+)["']/gu)].map(
  (match) => match[1],
);

/** Channels the preload calls through `invoke`. */
const invokedChannels = [...preloadSource.matchAll(/ipcRenderer\.invoke\(\s*["']([^"']+)["']/gu)].map(
  (match) => match[1],
);

/** Channels the preload forwards with `send`. */
const sentChannels = [...preloadSource.matchAll(/ipcRenderer\.send\(\s*["']([^"']+)["']/gu)].map(
  (match) => match[1],
);

describe("IPC wiring", () => {
  it("registers each channel exactly once", () => {
    const counts = new Map();
    for (const channel of handlerChannels) counts.set(channel, (counts.get(channel) ?? 0) + 1);
    const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([channel]) => channel);
    // Registering a channel twice throws at startup and hangs the app, so this is
    // worth failing the suite over.
    assert.deepEqual(duplicates, [], `duplicated ipcMain.handle registration: ${duplicates.join(", ")}`);
  });

  it("has a handler for every channel the preload invokes", () => {
    const registered = new Set(handlerChannels);
    const missing = [...new Set(invokedChannels)].filter((channel) => !registered.has(channel));
    assert.deepEqual(missing, [], `the preload calls channels nothing handles: ${missing.join(", ")}`);
  });

  it("has a handler for every channel the preload sends", () => {
    const listeners = [...mainSource.matchAll(/ipcMain\.on\(\s*["']([^"']+)["']/gu)].map((match) => match[1]);
    const missing = [...new Set(sentChannels)].filter((channel) => !listeners.includes(channel));
    assert.deepEqual(missing, [], `the preload sends channels nothing listens for: ${missing.join(", ")}`);
  });

  it("exposes nothing that opens external programs", () => {
    // There is no link in the interface that needs one, so the capability should
    // not exist. An unvalidated openExternal is an arbitrary-protocol launcher.
    assert.equal(/openExternal/u.test(mainSource), false, "shell.openExternal is reachable again");
    assert.equal(
      /openExternal|open-external/u.test(preloadSource),
      false,
      "the preload exposes an external opener",
    );
  });

  it("keeps the viewer sandboxed and isolated", () => {
    assert.match(mainSource, /contextIsolation:\s*true/u);
    assert.match(mainSource, /nodeIntegration:\s*false/u);
    assert.match(mainSource, /sandbox:\s*true/u, "the renderer should run sandboxed");
  });

  it("only requires electron in the preload, which is all a sandboxed preload has", () => {
    const requires = [...preloadSource.matchAll(/require\(\s*["']([^"']+)["']/gu)].map((match) => match[1]);
    assert.deepEqual([...new Set(requires)], ["electron"]);
  });
});
