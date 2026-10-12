/**
 * The flags this application accepts.
 *
 * One source of truth, because a flag that does not exist failed *silently*: the
 * README documented `--capture-command` for months of edits, the argument was
 * passed to Electron, nothing used it, and nothing complained. A mistyped flag
 * should be visible the first time it is typed.
 *
 * Anything not listed here is still passed through to Electron and Chromium, which
 * have their own switches, so this warns rather than rejects.
 */

/** @type {Array<{flag: string, takesValue: boolean, what: string}>} */
const APP_FLAGS = [
  { flag: "--smoke", takesValue: false, what: "report what rendered, then exit" },
  { flag: "--capture", takesValue: true, what: "write a PNG and exit" },
  { flag: "--command", takesValue: true, what: "run viewer commands before capturing" },
  { flag: "--report", takesValue: true, what: "write the JSON report to a file" },
  { flag: "--settle", takesValue: true, what: "wait this many ms before capturing" },
];

/** Whether one argument is a flag this application handles. */
const isKnownFlag = (argument) =>
  APP_FLAGS.some(({ flag, takesValue }) =>
    takesValue ? argument === flag || argument.startsWith(`${flag}=`) : argument === flag,
  );

/** The `--flags` in an argument list that this application does not handle itself. */
const unknownFlags = (argv) =>
  (argv ?? []).filter((argument) => typeof argument === "string" && argument.startsWith("--") && !isKnownFlag(argument));

/** A line naming every accepted flag, for a warning or a usage message. */
const describeFlags = () =>
  APP_FLAGS.map(({ flag, takesValue }) => (takesValue ? `${flag}=…` : flag)).join("  ");

module.exports = { APP_FLAGS, describeFlags, isKnownFlag, unknownFlags };
