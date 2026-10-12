/**
 * Tests that the documentation matches the code.
 *
 * Two things drifted here that nothing caught:
 *
 *   - the README documented `--capture-command`, which does not exist. It was found
 *     by hand, after surviving several edits.
 *   - three files stated a test count. It was wrong four times in one session, in
 *     both directions, because tests were added and removed without updating it.
 *
 * A number nobody needs is a liability, so the counts are gone and this fails if one
 * comes back. Flags and npm scripts are checked against the code instead of against
 * a copy of the truth.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { isKnownFlag, describeFlags } = require(join(projectRoot, "src/main/flags.cjs"));
const pkg = require(join(projectRoot, "package.json"));

const DOCS = ["README.md", "CONTRIBUTING.md", "AGENTS.md"];

/**
 * Flags belonging to other tools, which the docs legitimately mention.
 *
 * Anything else must be a flag this application handles. Adding a name here is a
 * deliberate statement that it belongs to git, gh or npm.
 */
const OTHER_TOOLS = new Set([
  // git
  "allow-empty", "filter-branch", "force-with-lease", "hard", "no-verify", "no-git-tag-version", "prune", "tags",
  // gh
  "admin", "auto", "base", "body", "body-file", "delete-branch", "fill", "head", "input", "json", "limit", "repo",
  "squash", "state", "title", "watch", "workflow",
  // npm
  "save-dev", "no-save", "prefix",
]);

const readDoc = (file) => readFileSync(join(projectRoot, file), "utf8");

/** Every `--flag` mentioned in a set of documents. */
const flagsIn = (body) => new Set([...body.matchAll(/--([a-z][a-z0-9-]+)/gu)].map((match) => match[1]));

describe("documentation matches the code", () => {
  it("documents no flag the application does not handle", () => {
    for (const file of DOCS) {
      for (const flag of flagsIn(readDoc(file))) {
        if (OTHER_TOOLS.has(flag)) continue;
        assert.equal(
          isKnownFlag(`--${flag}`),
          true,
          `${file} documents --${flag}, which ${describeFlags()} does not accept. ` +
            `If it belongs to another tool, add it to OTHER_TOOLS in this test.`,
        );
      }
    }
  });

  it("documents the flags the application does handle", () => {
    // The other direction: a new flag should not be invisible to readers.
    // Substring checks rather than regexes, because escaping the leading hyphens
    // yields an invalid escape under the `u` flag.
    const readme = readDoc("README.md");
    for (const { flag } of require(join(projectRoot, "src/main/flags.cjs")).APP_FLAGS) {
      assert.ok(readme.includes(flag), `README does not mention ${flag}`);
    }
  });

  it("promises no npm script that does not exist", () => {
    for (const file of DOCS) {
      const body = readDoc(file);
      for (const match of body.matchAll(/npm run ([a-z][a-z0-9:-]*)/gu)) {
        assert.ok(
          Object.hasOwn(pkg.scripts, match[1]),
          `${file} says "npm run ${match[1]}", which is not a script`,
        );
      }
      for (const match of body.matchAll(/npm (test|start|ci|install|version)\b/gu)) {
        assert.ok(
          ["test", "start", "ci", "install", "version"].includes(match[1]),
          `${file} says "npm ${match[1]}"`,
        );
      }
      assert.ok(Object.hasOwn(pkg.scripts, "test") && Object.hasOwn(pkg.scripts, "start"), "package.json lost test/start");
    }
  });

  it("states no test count, because they drift", () => {
    for (const file of DOCS) {
      const body = readDoc(file);
      const claim = /\b\d{2,4}\s+(unit|tests?)\b/iu.exec(body);
      assert.equal(
        claim,
        null,
        `${file} claims "${claim?.[0]}". Counts here have been wrong four times; ` +
          `state the command instead and let the output speak.`,
      );
    }
  });

  it("names the default branch the repository actually uses", () => {
    // The hook hard-codes it, and so do the docs. `main` is the usual name and the
    // wrong one here, so a copy-paste from another project would go unnoticed.
    const hook = readFileSync(join(projectRoot, ".githooks/pre-push"), "utf8");
    const declared = /DEFAULT_BRANCH="([^"]+)"/u.exec(hook)?.[1];
    assert.equal(declared, "master", "the hook guards a different branch from the one in use");
    assert.match(readDoc("CONTRIBUTING.md"), new RegExp(`\\b${declared}\\b`, "u"));
  });
});
