/**
 * Launch PageForge.
 *
 * A parent Electron host (an agent harness, for example) may export
 * ELECTRON_RUN_AS_NODE so that its own helper processes run as plain Node.
 * Electron inherits that variable from us, starts as Node instead of as a
 * browser process, and every `require('electron')` member comes back undefined.
 * Clearing it here keeps `npm start` working regardless of the shell it runs in.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [".", ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: "inherit",
  env,
});

child.once("error", (error) => {
  process.stderr.write(`Could not start Electron: ${error.message}\n`);
  process.exit(1);
});

child.once("close", (code, signal) => {
  process.exit(code ?? (signal === null ? 0 : 1));
});
