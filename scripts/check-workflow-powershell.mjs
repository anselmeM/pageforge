/**
 * One-off check: does the PowerShell inside a workflow actually parse?
 *
 * GitHub substitutes `${{ ... }}` before the shell sees the script, so the raw text
 * is not valid PowerShell. Substituting a plausible literal first turns this into a
 * real syntax check, which is worth having because a broken step costs a CI cycle to
 * discover.
 *
 * Usage: node scripts/check-workflow-powershell.mjs <workflow.yml>
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let yaml = null;
try {
  yaml = require("js-yaml");
} catch {
  process.stdout.write("js-yaml is not available; skipping\n");
  process.exit(0);
}

const file = process.argv[2];
const document = yaml.load(readFileSync(file, "utf8"));
const jobs = Object.entries(document.jobs ?? {});
let checked = 0;
let failed = 0;

/**
 * A PowerShell to parse with.
 *
 * CI uses `shell: pwsh`, which is PowerShell 7. A machine may only have Windows
 * PowerShell 5.1, so that is used as a fallback — the scripts here avoid constructs
 * where the two differ, and the fallback is reported rather than hidden.
 */
const findShell = () => {
  const { spawnSync } = require("node:child_process");
  const candidates = [
    "pwsh",
    "pwsh.exe",
    `${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`,
    `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
};

const shell = findShell();
if (shell === null) {
  process.stdout.write("no PowerShell found; skipping\n");
  process.exit(0);
}
process.stdout.write(`parsing with ${shell}\n`);

/** Stand in for a GitHub expression so the result is still valid PowerShell. */
const substitute = (script) =>
  script
    .replaceAll(/\$\{\{\s*github\.ref_name\s*\}\}/gu, "v0.0.0-test")
    .replaceAll(/\$\{\{\s*github\.event_name\s*\}\}/gu, "push")
    .replaceAll(/\$\{\{[^}]*\}\}/gu, "test-value");

const { spawnSync } = await import("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");

const scratch = mkdtempSync(join(tmpdir(), "pageforge-workflow-"));

for (const [jobName, job] of jobs) {
  for (const [index, step] of (job.steps ?? []).entries()) {
    if (step.shell !== "pwsh" || typeof step.run !== "string") continue;
    checked += 1;
    const label = `${jobName} step ${index} (${step.name ?? "unnamed"})`;
    // The script is written to a file and parsed from there. Passing it as a
    // -Command argument needs escaping that mangled the script and reported
    // failures that did not exist; a file has no quoting to get wrong.
    const scriptPath = join(scratch, `step-${index}.ps1`);
    writeFileSync(scriptPath, substitute(step.run), "utf8");
    const probe = `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replaceAll("'", "''")}', [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output ("line " + $_.Extent.StartLineNumber + ": " + $_.Message) }; exit 1 }`;
    const result = spawnSync(shell, ["-NoProfile", "-Command", probe], { encoding: "utf8" });
    if (result.error) {
      failed += 1;
      process.stdout.write(`  FAIL ${label}: could not run ${shell}: ${result.error.message}\n`);
    } else if (result.status === 0) {
      process.stdout.write(`  ok   ${label}\n`);
    } else {
      failed += 1;
      process.stdout.write(`  FAIL ${label}\n    ${(result.stdout ?? "").trim()}\n`);
    }
  }
}

rmSync(scratch, { recursive: true, force: true });
process.stdout.write(`${checked} pwsh step(s) checked, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
