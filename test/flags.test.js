/**
 * Tests for the application's flag table.
 *
 * It exists because a flag that does not exist failed silently. The README
 * documented `--capture-command`; the argument went to Electron, nothing used it,
 * and nothing complained. A typo now warns on stderr the first time it is typed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { APP_FLAGS, describeFlags, isKnownFlag, unknownFlags } = require(join(projectRoot, "src/main/flags.cjs"));

describe("application flags", () => {
  it("accepts every flag it declares", () => {
    for (const { flag, takesValue } of APP_FLAGS) {
      assert.equal(isKnownFlag(flag), true, `${flag} should be recognised`);
      if (takesValue) assert.equal(isKnownFlag(`${flag}=value`), true, `${flag}=… should be recognised`);
    }
  });

  it("reports flags it does not handle", () => {
    assert.deepEqual(unknownFlags(["--bogus"]), ["--bogus"]);
    // The exact mistake that shipped: documented, plausible, and not real.
    assert.deepEqual(unknownFlags(["--capture-command=double-on"]), ["--capture-command=double-on"]);
    assert.deepEqual(unknownFlags(["--smoke", "--bogus", "book.cbz"]), ["--bogus"]);
  });

  it("ignores positionals and single-dash arguments", () => {
    assert.deepEqual(unknownFlags(["book.cbz", "-h", "C:/books/x.cbz"]), []);
    assert.deepEqual(unknownFlags([]), []);
    assert.deepEqual(unknownFlags(undefined), []);
  });

  it("does not treat a value-taking flag as a bare flag", () => {
    // `--capture` needs a file; `--capture` alone is not the same argument, but it
    // is still ours, so it must not be reported as unknown either.
    assert.equal(isKnownFlag("--capture"), true);
    assert.equal(isKnownFlag("--capture="), true);
    assert.equal(isKnownFlag("--capturex=1"), false);
  });

  it("names every flag in one line, for the warning", () => {
    // A plain substring check, not a regex: escaping the hyphens produces `\-`,
    // which is an invalid escape under the `u` flag and throws before asserting.
    const described = describeFlags();
    for (const { flag } of APP_FLAGS) {
      assert.ok(described.includes(flag), `${flag} is missing from "${described}"`);
    }
  });

  it("matches what the main process actually parses", () => {
    // The table is the source of truth for the warning, but the parsing is what
    // decides behaviour. If a flag is added to one and not the other, this fails
    // instead of the warning quietly becoming wrong.
    const main = readFileSync(join(projectRoot, "src/main/main.cjs"), "utf8");
    const parsed = new Set();
    for (const match of main.matchAll(/process\.argv\.includes\("(--[a-z-]+)"\)/gu)) parsed.add(match[1]);
    for (const match of main.matchAll(/argument\.startsWith\("(--[a-z-]+)=?"\)/gu)) parsed.add(match[1]);
    assert.ok(parsed.size >= 4, `expected several parsed flags, found ${[...parsed].join(", ")}`);
    for (const flag of parsed) {
      assert.equal(isKnownFlag(flag), true, `${flag} is parsed by main.cjs but missing from the flag table`);
    }
  });
});
