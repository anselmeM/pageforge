/**
 * Opt-in crash reporting.
 *
 * The problem this solves: a crash on someone else's machine is invisible. The
 * error log PageForge already writes only exists where the app was run.
 *
 * Reporting is **off unless the reader turns it on and supplies a destination**.
 * Nothing here sends anything by itself; this module only builds the request, so
 * the decision to send stays in one place and is testable.
 *
 * The wire format is Sentry's documented ingest contract: a JSON event posted to
 * `…/api/<project>/store/` with a `X-Sentry-Auth` header. Speaking the documented
 * protocol rather than bundling a large SDK is a deliberate trade — it keeps an
 * opt-in feature from becoming a permanent dependency, at the cost of the SDK
 * extras (breadcrumbs, sessions, source maps). The preferences dialog can send a
 * test report, so a reader can confirm their own destination accepts it.
 */

/**
 * Split a DSN into the endpoint to post to and the key to authenticate with.
 *
 * `https://<key>@host[:port]/[prefix/]<projectId>`
 *
 * @returns {{endpoint: string, publicKey: string, projectId: string, protocol: string} | null}
 *   null when the string is not usable, which is not an error: it just means
 *   reporting stays off.
 */
export const parseDsn = (dsn) => {
  if (typeof dsn !== "string" || dsn.trim() === "") return null;
  let url;
  try {
    url = new URL(dsn.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const publicKey = url.username;
  if (publicKey === "") return null;
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const projectId = segments.pop();
  if (projectId === undefined || !/^\d+$/u.test(projectId)) return null;
  const prefix = segments.length === 0 ? "" : `/${segments.join("/")}`;
  return {
    protocol: url.protocol,
    publicKey,
    projectId,
    endpoint: `${url.protocol}//${url.host}${prefix}/api/${projectId}/store/`,
  };
};

/** The `X-Sentry-Auth` header the ingest endpoint expects. */
export const sentryAuthHeader = (publicKey) =>
  `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=pageforge/1.0`;

/**
 * Replace the reader's home directory with a placeholder.
 *
 * Stack traces carry absolute paths, and a path contains a person's account name.
 * Someone who opted into crash reports did not thereby agree to send their name.
 */
export const scrubPaths = (text, homeDirectory) => {
  if (typeof text !== "string" || text.length === 0) return text;
  let scrubbed = text;
  if (typeof homeDirectory === "string" && homeDirectory.length > 0) {
    scrubbed = scrubbed.split(homeDirectory).join("%USERPROFILE%");
    // The separators may appear the other way round in a stack trace.
    scrubbed = scrubbed.split(homeDirectory.split("\\").join("/")).join("%USERPROFILE%");
  }
  return scrubbed
    .replaceAll(/\b[A-Za-z]:\\Users\\[^\\\s]+/gu, "%USERPROFILE%")
    .replaceAll(/\/(?:Users|home)\/[^/\s]+/gu, "%USERPROFILE%");
};

/** Turn a stack string into the frames the ingest format expects, oldest first. */
export const parseStackFrames = (stack, homeDirectory) => {
  if (typeof stack !== "string") return [];
  const frames = [];
  for (const line of stack.split("\n")) {
    const match = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/u.exec(line);
    if (match === null) continue;
    frames.push({
      function: match[1] ?? "<anonymous>",
      filename: scrubPaths(match[2], homeDirectory),
      lineno: Number(match[3]),
      colno: Number(match[4]),
    });
  }
  // Sentry expects oldest frame first; a stack trace is printed newest first.
  return frames.reverse();
};

/**
 * Build the event body.
 *
 * @param {object} options
 * @param {{code?: string, message: string, stack?: string, context?: object}} options.record
 * @param {string} options.eventId 32 hex characters, supplied by the caller
 * @param {string} options.release
 * @param {string} options.environment
 * @param {string} [options.homeDirectory]
 * @param {string} [options.timestamp] ISO 8601, supplied by the caller
 */
export const buildEvent = ({
  record,
  eventId,
  release,
  environment,
  homeDirectory = "",
  timestamp,
}) => {
  const message = scrubPaths(String(record?.message ?? "Unknown failure"), homeDirectory);
  const frames = parseStackFrames(record?.stack, homeDirectory);
  const type = /^([A-Za-z]*Error)\b/u.exec(message)?.[1] ?? "Error";
  return {
    event_id: eventId,
    timestamp,
    platform: "node",
    level: "error",
    release,
    environment,
    logger: "pageforge",
    // `message` is the older spelling and `exception` is the structured one; both
    // are sent so the event reads well in any view.
    message,
    exception: {
      values: [
        {
          type,
          value: message,
          ...(frames.length === 0 ? {} : { stacktrace: { frames } }),
        },
      ],
    },
    tags: {
      ...(record?.code === undefined ? {} : { code: String(record.code) }),
      origin: "main-process",
    },
    extra: record?.context === undefined ? {} : record.context,
  };
};

/** Validation, so a preference cannot hold something that only fails later. */
export const dsnIsUsable = (dsn) => parseDsn(dsn) !== null;
