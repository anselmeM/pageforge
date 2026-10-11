/** Unit tests for shortcut key naming, resolution and rebinding. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMMAND_LABELS,
  DEFAULT_SHORTCUTS,
  REBINDABLE_COMMANDS,
  isKeyString,
  keyFromEvent,
  normalizeShortcuts,
  resolveCommand,
  withShortcut,
} from "../src/core/shortcuts.js";

const event = (key, modifiers = {}) => ({ key, shiftKey: false, ctrlKey: false, altKey: false, ...modifiers });

describe("key naming", () => {
  it("names a plain character by its upper-case form", () => {
    assert.equal(keyFromEvent(event("r")), "R");
    assert.equal(keyFromEvent(event("0")), "0");
  });

  it("names named keys as they are", () => {
    assert.equal(keyFromEvent(event("ArrowRight")), "ArrowRight");
    assert.equal(keyFromEvent(event("PageDown")), "PageDown");
    assert.equal(keyFromEvent(event(" ")), "Space");
  });

  it("keeps a shifted letter distinct from the bare letter", () => {
    assert.equal(keyFromEvent(event("R", { shiftKey: true })), "Shift+R");
    assert.notEqual(keyFromEvent(event("R", { shiftKey: true })), keyFromEvent(event("r")));
  });

  it("does not add Shift when the character already is the shifted one", () => {
    // On a US layout "+" is Shift+"=", and must stay bindable as "+".
    assert.equal(keyFromEvent(event("+", { shiftKey: true })), "+");
  });

  it("lists modifiers in a stable order", () => {
    assert.equal(keyFromEvent(event("b", { ctrlKey: true, shiftKey: true })), "Ctrl+Shift+B");
    assert.equal(keyFromEvent(event("ArrowRight", { shiftKey: true })), "Shift+ArrowRight");
  });

  it("accepts only shapes it could have produced", () => {
    assert.equal(isKeyString("ArrowRight"), true);
    assert.equal(isKeyString("Shift+R"), true);
    assert.equal(isKeyString("+"), true);
    assert.equal(isKeyString("Nonsense"), false);
    assert.equal(isKeyString(""), false);
    assert.equal(isKeyString(null), false);
  });
});

describe("resolution", () => {
  it("finds the command for a bound key", () => {
    const shortcuts = normalizeShortcuts(null);
    assert.equal(resolveCommand(shortcuts, "ArrowRight"), "next-page");
    assert.equal(resolveCommand(shortcuts, "Space"), "next-page");
    assert.equal(resolveCommand(shortcuts, "PageUp"), "previous-page");
    assert.equal(resolveCommand(shortcuts, "q"), null);
  });

  it("is case-insensitive about the key", () => {
    const shortcuts = normalizeShortcuts(null);
    assert.equal(resolveCommand(shortcuts, "f"), "fit-screen");
    assert.equal(resolveCommand(shortcuts, "F"), "fit-screen");
  });

  it("keeps Shift+R distinct from R", () => {
    const shortcuts = normalizeShortcuts(null);
    assert.equal(resolveCommand(shortcuts, "R"), "rotate-cw");
    assert.equal(resolveCommand(shortcuts, "Shift+R"), "rotate-ccw");
  });
});

describe("normalisation", () => {
  it("supplies every command from the defaults", () => {
    const shortcuts = normalizeShortcuts(null);
    for (const command of REBINDABLE_COMMANDS) {
      assert.equal(shortcuts[command].primary, DEFAULT_SHORTCUTS[command].primary, command);
    }
  });

  it("keeps a deliberately cleared slot cleared", () => {
    const shortcuts = normalizeShortcuts({ "first-page": { primary: null, secondary: null } });
    assert.equal(shortcuts["first-page"].primary, null);
    assert.equal(shortcuts["first-page"].secondary, null);
    assert.equal(normalizeShortcuts(shortcuts)["first-page"].primary, null, "and it stays cleared");
  });

  it("ignores unknown commands and unusable keys", () => {
    const shortcuts = normalizeShortcuts({
      "next-page": { primary: "N", secondary: "Nonsense" },
      "not-a-command": { primary: "X" },
    });
    assert.equal(shortcuts["next-page"].primary, "N");
    assert.equal(shortcuts["next-page"].secondary, null, "an unusable key is dropped");
    assert.equal(shortcuts["not-a-command"], undefined);
  });

  it("labels every rebindable command", () => {
    for (const command of REBINDABLE_COMMANDS) {
      assert.ok(COMMAND_LABELS[command], `missing label for ${command}`);
    }
  });
});

describe("rebinding", () => {
  it("assigns a slot", () => {
    const next = withShortcut(normalizeShortcuts(null), "next-page", "primary", "N");
    assert.equal(next["next-page"].primary, "N");
  });

  it("clears a slot with null", () => {
    const next = withShortcut(normalizeShortcuts(null), "next-page", "secondary", null);
    assert.equal(next["next-page"].secondary, null);
  });

  it("takes a key away from whatever else held it", () => {
    const next = withShortcut(normalizeShortcuts(null), "next-page", "primary", "F");
    assert.equal(next["next-page"].primary, "F");
    assert.equal(next["fit-screen"].primary, null, "the previous owner loses the key");
  });

  it("does not react to an unknown command or slot", () => {
    const shortcuts = normalizeShortcuts(null);
    assert.deepEqual(withShortcut(shortcuts, "nope", "primary", "N"), shortcuts);
    assert.deepEqual(withShortcut(shortcuts, "next-page", "third", "N"), shortcuts);
  });

  it("does not mutate the map it is given", () => {
    const shortcuts = normalizeShortcuts(null);
    withShortcut(shortcuts, "next-page", "primary", "N");
    assert.equal(shortcuts["next-page"].primary, "ArrowRight");
  });
});
