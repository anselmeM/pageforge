/**
 * Tests for the pre-push hook.
 *
 * The hook does two things, and both are worth checking rather than assuming: it
 * refuses a direct push to the default branch, and it refuses a push whose tree
 * fails the test suite. It cannot lean on branch protection for either, because
 * branch protection is a paid feature for a private repository.
 *
 * Two ways of writing it were found here that made it allow the push it exists to
 * refuse: piping stdin through `cat`, absent from a minimal shell, and
 * `IFS= read -r a b c d`, which disables field splitting so the ref never matched.
 * A hook that fails open is worse than no hook, because it is trusted.
 *
 * The gate is never actually run. It is replaced through the environment, which the
 * hook supports for exactly this reason -- running it would start the test suite
 * from inside the test suite.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = join(projectRoot, ".githooks", "pre-push");

/** Git for Windows bundles a shell; on other platforms `sh` is on PATH. */
const findShell = () => {
  const candidates = [
    "sh",
    "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
    "C:\\Program Files\\Git\\bin\\sh.exe",
    "/bin/sh",
  ];
  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const probe = spawnSync(candidate, ["-c", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
};

const shell = findShell();
const SHA = "1111111111111111111111111111111111111111";
const ZERO = "0000000000000000000000000000000000000000";

/**
 * Run the hook with pre-push stdin. Git sends one line per ref.
 *
 * `gate` replaces the test command; the default passes, so no test can start the
 * real suite by accident.
 */
const runHook = (lines, { gate = "true", skipTests = false } = {}) => {
  const result = spawnSync(shell, [hook], {
    input: `${[].concat(lines).join("\n")}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      PAGEFORGE_TEST_CMD: gate,
      ...(skipTests ? { PAGEFORGE_SKIP_TESTS: "1" } : {}),
    },
  });
  return { code: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
};

describe("pre-push hook", { skip: shell === null ? "no shell available to run the hook" : false }, () => {
  it("exists and is where git expects it", () => {
    assert.equal(existsSync(hook), true, ".githooks/pre-push is missing");
  });

  it("refuses a direct push to the default branch", () => {
    const { code, stderr } = runHook(`refs/heads/master ${SHA} refs/heads/master ${ZERO}`);
    assert.equal(code, 1, "pushing to master must fail");
    assert.match(stderr, /direct push to 'master' is blocked/u);
    // The message has to say how to comply, or it is just an obstacle.
    assert.match(stderr, /gh pr create/u);
  });

  it("refuses master even when other refs are pushed in the same command", () => {
    const { code } = runHook([
      `refs/heads/feat/x ${SHA} refs/heads/feat/x ${ZERO}`,
      `refs/heads/master ${SHA} refs/heads/master ${ZERO}`,
    ]);
    assert.equal(code, 1, "a mixed push including master must still be refused");
  });

  it("keeps refusing master when the test gate is skipped", () => {
    const { code } = runHook(`refs/heads/master ${SHA} refs/heads/master ${ZERO}`, { skipTests: true });
    assert.equal(code, 1, "skipping the tests must not excuse a direct push to master");
  });

  it("allows a feature branch", () => {
    assert.equal(runHook(`refs/heads/fix/x ${SHA} refs/heads/fix/x ${ZERO}`).code, 0);
  });

  it("allows a tag, because that is how releases are published", () => {
    const { code } = runHook(`refs/tags/v0.1.2 ${SHA} refs/tags/v0.1.2 ${ZERO}`);
    assert.equal(code, 0, "blocking tags would break the release workflow");
  });

  it("allows deleting a branch", () => {
    assert.equal(runHook(`(delete) ${ZERO} refs/heads/master ${SHA}`, { skipTests: true }).code, 0);
  });

  it("refuses a push whose tests fail", () => {
    const { code, stderr } = runHook(`refs/heads/fix/x ${SHA} refs/heads/fix/x ${ZERO}`, { gate: "false" });
    assert.equal(code, 1, "a failing tree must not leave the machine");
    assert.match(stderr, /failed, so this push is refused/u);
  });

  it("allows a push whose tests pass", () => {
    const { code, stdout, stderr } = runHook(`refs/heads/fix/x ${SHA} refs/heads/fix/x ${ZERO}`, { gate: "true" });
    assert.equal(code, 0);
    assert.match(`${stdout}${stderr}`, /tests pass/u);
  });

  it("checks the tests on a tag push too, since a release is what gets published", () => {
    const { code } = runHook(`refs/tags/v0.1.2 ${SHA} refs/tags/v0.1.2 ${ZERO}`, { gate: "false" });
    assert.equal(code, 1);
  });

  it("skips the gate on request, for a deliberate work in progress", () => {
    const { code, stderr } = runHook(`refs/heads/wip/x ${SHA} refs/heads/wip/x ${ZERO}`, {
      gate: "false",
      skipTests: true,
    });
    assert.equal(code, 0);
    assert.match(stderr, /gate skipped/u);
  });

  it("guards the default branch without any command that may be missing", () => {
    // The first version read stdin through `cat`. Where `cat` was absent the ref
    // list was empty, nothing matched, and a direct push to master was allowed.
    // The check must therefore be shell built-ins only.
    const policy = readFileSync(hook, "utf8").split("Job 2")[0];
    for (const utility of ["cat", "grep", "sed", "awk", "cut", "tr"]) {
      assert.equal(
        new RegExp(`\\b${utility}\\s`, "u").test(policy.replace(/^#.*$/gmu, "")),
        false,
        `the default-branch check must not run ${utility}`,
      );
    }
  });
});
