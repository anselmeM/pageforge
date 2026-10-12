/**
 * Keyboard shortcut binding.
 *
 * Commands that a menu already owns (open, bookmarks, thumbnails, recents,
 * fullscreen, go-to-page, preferences) keep their menu accelerators and are not
 * rebindable here: two owners for one key combination is how a shortcut ends up
 * firing twice.
 */

/** Commands the reader itself owns, and therefore lets the user rebind. */
export const REBINDABLE_COMMANDS = [
  "next-page",
  "previous-page",
  "first-page",
  "last-page",
  "zoom-in",
  "zoom-out",
  "actual-size",
  "fit-screen",
  "fit-width",
  "fit-height",
  "toggle-double",
  "toggle-rtl",
  "rotate-cw",
  "rotate-ccw",
  "toggle-magnifier",
  "toggle-slideshow",
  "toggle-guided",
];

/** Human labels for the shortcuts dialog. */
export const COMMAND_LABELS = {
  "next-page": "Next page",
  "previous-page": "Previous page",
  "first-page": "First page",
  "last-page": "Last page",
  "zoom-in": "Zoom in",
  "zoom-out": "Zoom out",
  "actual-size": "Actual size",
  "fit-screen": "Fit to screen",
  "fit-width": "Fit width",
  "fit-height": "Fit height",
  "toggle-double": "Double page",
  "toggle-rtl": "Japanese reading",
  "rotate-cw": "Rotate right",
  "rotate-ccw": "Rotate left",
  "toggle-magnifier": "Magnifier",
  "toggle-slideshow": "Slideshow",
  "toggle-guided": "Guided view",
};

/** A command is bound to a primary key and optionally a second one. */
export const DEFAULT_SHORTCUTS = {
  "next-page": { primary: "ArrowRight", secondary: "Space" },
  "previous-page": { primary: "ArrowLeft", secondary: "PageUp" },
  "first-page": { primary: "Home", secondary: null },
  "last-page": { primary: "End", secondary: null },
  "zoom-in": { primary: "+", secondary: null },
  "zoom-out": { primary: "-", secondary: null },
  "actual-size": { primary: "0", secondary: null },
  "fit-screen": { primary: "F", secondary: null },
  "fit-width": { primary: "W", secondary: null },
  "fit-height": { primary: "H", secondary: null },
  "toggle-double": { primary: "D", secondary: null },
  "toggle-rtl": { primary: "J", secondary: null },
  "rotate-cw": { primary: "R", secondary: null },
  "rotate-ccw": { primary: "Shift+R", secondary: null },
  "toggle-magnifier": { primary: "M", secondary: null },
  "toggle-slideshow": { primary: "S", secondary: null },
  "toggle-guided": { primary: "G", secondary: null },
};

const NAMED_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Space",
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
]);

/**
 * Canonical name for the key combination an event represents, such as
 * `ArrowRight`, `Space`, `+`, `Shift+R` or `Ctrl+B`.
 *
 * Shift is listed only when it changes what the key means: `Shift+R` stays
 * distinct from `R`, while the shifted `=` that produces `+` is just `+`, so
 * punctuation stays bindable on layouts where it needs Shift.
 */
export const keyFromEvent = (event) => {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  const isCharacter = typeof event.key === "string" && event.key.length === 1;
  if (event.shiftKey && (!isCharacter || /[a-z]/iu.test(event.key))) parts.push("Shift");

  let key = event.key;
  if (key === " " || key === "Spacebar") key = "Space";
  else if (isCharacter) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
};

/** True when a string could have come from `keyFromEvent`. */
export const isKeyString = (value) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) return false;
  // Strip known modifiers from the front rather than splitting on "+", because
  // the key itself may be "+".
  const modifiers = /^(?:Ctrl\+|Alt\+|Shift\+)*/u.exec(value)[0];
  const key = value.slice(modifiers.length);
  if (key.length === 0) return false;
  if (key.length === 1) return true;
  return NAMED_KEYS.has(key);
};

const normalizeSlot = (value) => {
  if (value === null || value === undefined || value === "") return null;
  return isKeyString(value) ? value : null;
};

/** Every command with a binding, falling back to the defaults. */
export const normalizeShortcuts = (value) => {
  const shortcuts = {};
  for (const command of REBINDABLE_COMMANDS) {
    const fallback = DEFAULT_SHORTCUTS[command];
    const candidate = value !== null && typeof value === "object" ? value[command] : undefined;
    if (candidate === null || typeof candidate !== "object") {
      shortcuts[command] = { ...fallback };
      continue;
    }
    // An absent slot means "not customised, use the default"; an explicit null
    // means "deliberately unbound" and must not be filled back in.
    shortcuts[command] = {
      primary: candidate.primary === undefined ? fallback.primary : normalizeSlot(candidate.primary),
      secondary:
        candidate.secondary === undefined ? fallback.secondary : normalizeSlot(candidate.secondary),
    };
  }
  return shortcuts;
};

/** The command bound to a key combination, or null. */
export const resolveCommand = (shortcuts, keyString) => {
  if (typeof keyString !== "string") return null;
  const wanted = keyString.toLowerCase();
  for (const [command, binding] of Object.entries(shortcuts)) {
    if (binding.primary !== null && binding.primary.toLowerCase() === wanted) return command;
    if (binding.secondary !== null && binding.secondary.toLowerCase() === wanted) return command;
  }
  return null;
};

/** Assign one slot, or clear it with `null`. Returns the updated map. */
export const withShortcut = (shortcuts, command, slot, keyString) => {
  if (!REBINDABLE_COMMANDS.includes(command)) return shortcuts;
  if (slot !== "primary" && slot !== "secondary") return shortcuts;
  const next = normalizeShortcuts(shortcuts);
  const normalized = normalizeSlot(keyString);
  next[command] = { ...next[command], [slot]: normalized };
  // A key cannot mean two things: clear it from every other slot first.
  if (normalized !== null) {
    for (const other of REBINDABLE_COMMANDS) {
      if (other === command) continue;
      for (const otherSlot of ["primary", "secondary"]) {
        if (next[other][otherSlot]?.toLowerCase() === normalized.toLowerCase()) {
          next[other] = { ...next[other], [otherSlot]: null };
        }
      }
    }
  }
  return next;
};
