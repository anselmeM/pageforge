/**
 * Refuse to start a package build while the packaged app is running.
 *
 * Windows holds the executable open while it runs, so electron-builder cannot
 * replace it and the build stalls instead of reporting anything useful. Failing
 * immediately with the reason is kinder than a twenty-minute hang.
 *
 * Non-Windows platforms are skipped: replacing a running binary there is either
 * fine or a prompt error from the packaging tool.
 */

import { execFileSync } from "node:child_process";

if (process.platform === "win32") {
  let listing = "";
  try {
    listing = execFileSync("tasklist", ["/NH", "/FO", "CSV"], { encoding: "utf8" });
  } catch {
    // If the process list cannot be read, do not block a build over it.
    process.exit(0);
  }
  const running = [...listing.matchAll(/"([^"]+\.exe)"/giu)]
    .map((match) => match[1])
    .filter((name) => name.toLowerCase().startsWith("pageforge"));

  if (running.length > 0) {
    process.stderr.write(
      `PageForge is running (${[...new Set(running)].join(", ")}).\n` +
        "Windows keeps the executable locked while it runs, so packaging would stall.\n" +
        "Close the app and run the build again.\n",
    );
    process.exit(1);
  }
}
