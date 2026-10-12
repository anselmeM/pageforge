/**
 * Tests for the pre-push hook.
 *
 * The hook is the only thing standing between this repository and a direct push to
 * `master` — branch protection is unavailable on a private repository on a free
 * GitHub plan — so it is worth checking rather than assuming. A hook that silently
 * fails open is worse than no hook, because it looks like protection.
 *
 * The cases below are the ones that matter: block the default branch, and do not
 * block anything else. Releases are published by pushing a tag, so a hook that
 * blocked tags would break releasing.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

/**
 * Run the hook with pre-push stdin.
 *
 * Git passes one *line* per ref: `<local ref> <local sha> <remote ref> <remote sha>`.
 * Multiple refs in one push are multiple lines, so each argument here is a line.
 */
const runHook = (...lines) => {
  const result = spawnSync(shell, [hook], { input: `${lines.join("\n")}\n`, encoding: "utf8" });
  return { code: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
};

const SHA = "1111111111111111111111111111111111111111";
const ZERO = "0000000000000000000000000000000000000000";

describe("pre-push hook", { skip: shell === null ? "no shell available to run the hook" : false }, () => {
  it("exists and is where git expects it", () => {
    assert.equal(existsSync(hook), true, ".githooks/pre-push is missing");
  });

  it("blocks a direct push to the default branch", () => {
    const { code, stderr } = runHook(`refs/heads/master ${SHA} refs/heads/master ${ZERO}`);
    assert.equal(code, 1, "pushing to master must fail");
    assert.match(stderr, /direct push to 'master' is blocked/u);
    // The message has to say how to comply, or it is just an obstacle.
    assert.match(stderr, /gh pr create/u);
  });

  it("allows a feature branch", () => {
    const { code } = runHook(`refs/heads/fix/guided-view ${SHA} refs/heads/fix/guided-view ${ZERO}`);
    assert.equal(code, 0);
  });

  it("allows a tag, because that is how releases are published", () => {
    const { code } = runHook(`refs/tags/v0.1.2 ${SHA} refs/tags/v0.1.2 ${ZERO}`);
    assert.equal(code, 0, "blocking tags would break the release workflow");
  });

  it("allows deleting a branch", () => {
    const { code } = runHook(`(delete) ${ZERO} refs/heads/master ${SHA}`);
    assert.equal(code, 0);
  });

  it("blocks master even when other refs are pushed in the same command", () => {
    // Git sends one line per ref, so a push of a branch and master together is two
    // lines. The hook must refuse the whole push, not just the line it read first.
    const { code } = runHook(
      `refs/heads/feat/x ${SHA} refs/heads/feat/x ${ZERO}`,
      `refs/heads/master ${SHA} refs/heads/master ${ZERO}`,
    );
    assert.equal(code, 1, "a mixed push that includes master must still be refused");
  });

  it("allows push options and other unrelated refs", () => {
    const { code } = runHook(`refs/heads/docs/readme ${SHA} refs/heads/docs/readme ${ZERO}`);
    assert.equal(code, 0);
  });
});
