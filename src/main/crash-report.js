/**
 * Sending opt-in crash reports.
 *
 * This is the only place in PageForge that talks to the network, and it only ever
 * does so when the reader has switched reporting on *and* supplied a destination.
 * Everything about *what* is sent lives in `src/core/crash-report.js`; this module
 * is the transport.
 *
 * Sending must never affect the reader: a report that cannot be delivered is
 * dropped, not surfaced, and never retried in a loop.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import { buildEvent, parseDsn, sentryAuthHeader } from "../core/crash-report.js";

const TIMEOUT_MS = 5000;

/**
 * @param {object} options
 * @param {boolean} options.enabled whether the reader opted in
 * @param {string} options.dsn destination, or "" for none
 * @param {string} options.release
 * @param {string} options.environment
 * @returns {object} a reporter; `enabled` is false whenever it will not send
 */
export const createCrashReporter = ({ enabled, dsn, release, environment }) => {
  const target = enabled === true ? parseDsn(dsn) : null;
  const homeDirectory = homedir();

  const post = async (record) => {
    if (target === null) {
      return { ok: false, status: 0, error: "Reporting is off or has no destination." };
    }
    const event = buildEvent({
      record,
      eventId: randomUUID().replaceAll("-", ""),
      release,
      environment,
      homeDirectory,
      timestamp: new Date().toISOString(),
    });
    try {
      const response = await fetch(target.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sentry-auth": sentryAuthHeader(target.publicKey),
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        return { ok: false, status: response.status, error: `The destination answered ${response.status}.` };
      }
      return { ok: true, status: response.status, error: null, eventId: event.event_id };
    } catch (error) {
      // Offline, DNS failure, timeout: all the same to a reader mid-book.
      return { ok: false, status: 0, error: error?.message ?? String(error) };
    }
  };

  return {
    enabled: target !== null,
    /** The endpoint reports would go to, without the key. */
    endpoint: target === null ? null : target.endpoint,

    /** Report a failure. Never throws, and never blocks the caller. */
    send(record) {
      return post(record);
    },

    /**
     * Send a report the reader asked for, so they can confirm their destination
     * accepts what this app sends. Returns what happened, because a person who
     * pressed a button is waiting for an answer.
     */
    sendTest() {
      return post({
        code: "test-report",
        message: "PageForge test crash report — nothing is wrong; this was requested.",
        stack: "Error: PageForge test crash report\n    at sendTest (pageforge/main/crash-report.js:1:1)",
        context: { requestedBy: "preferences" },
      });
    },
  };
};
