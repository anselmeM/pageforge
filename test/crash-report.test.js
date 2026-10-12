/**
 * Crash-report tests.
 *
 * Reporting is off by default and sends personal data when on, so the rules that
 * matter are: refuse a destination that is not usable, and never send the
 * reader's account name.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildEvent,
  dsnIsUsable,
  parseDsn,
  parseStackFrames,
  scrubPaths,
  sentryAuthHeader,
} from "../src/core/crash-report.js";

describe("dsn parsing", () => {
  it("reads the hosted form", () => {
    const parsed = parseDsn("https://abc123@o4507.ingest.sentry.io/4507123456");
    assert.equal(parsed.endpoint, "https://o4507.ingest.sentry.io/api/4507123456/store/");
    assert.equal(parsed.publicKey, "abc123");
    assert.equal(parsed.projectId, "4507123456");
  });

  it("keeps a path prefix for a self-hosted install", () => {
    const parsed = parseDsn("https://key@sentry.example.com/sentry/42");
    assert.equal(parsed.endpoint, "https://sentry.example.com/sentry/api/42/store/");
  });

  it("keeps a port, and accepts plain http for a local destination", () => {
    const parsed = parseDsn("http://secret@127.0.0.1:8123/7");
    assert.equal(parsed.endpoint, "http://127.0.0.1:8123/api/7/store/");
    assert.equal(parsed.protocol, "http:");
  });

  it("refuses anything it cannot use, without throwing", () => {
    for (const bad of [
      "",
      null,
      undefined,
      42,
      "not a url",
      "ftp://key@host/1",
      "https://host/1", // no key
      "https://key@host/", // no project
      "https://key@host/notanumber",
    ]) {
      assert.equal(parseDsn(bad), null, `expected null for ${JSON.stringify(bad)}`);
      assert.equal(dsnIsUsable(bad), false);
    }
  });
});

describe("path scrubbing", () => {
  it("removes the reader's account name from a Windows path", () => {
    const scrubbed = scrubPaths(
      "at open (C:\\Users\\amotc\\Documents\\GitHub\\pageforge\\src\\main\\reader.js:1:2)",
      "C:\\Users\\amotc",
    );
    assert.ok(!scrubbed.includes("amotc"), `account name survived: ${scrubbed}`);
    assert.ok(scrubbed.includes("%USERPROFILE%"));
  });

  it("removes it even when the trace uses forward slashes", () => {
    const scrubbed = scrubPaths("at x (/home/someone/comics/a.js:3:4)", "/home/someone");
    assert.ok(!scrubbed.includes("someone"), scrubbed);
  });

  it("catches a profile path it was not told about", () => {
    const scrubbed = scrubPaths("C:\\Users\\other\\AppData\\Local\\Temp\\x.js");
    assert.ok(!scrubbed.includes("other"), scrubbed);
  });

  it("leaves text with nothing personal alone", () => {
    assert.equal(scrubPaths("nothing to hide", "/home/x"), "nothing to hide");
    assert.equal(scrubPaths("", "/home/x"), "");
    assert.equal(scrubPaths(null, "/home/x"), null);
  });
});

describe("stack frames", () => {
  it("parses frames and reverses them to oldest first", () => {
    const stack = [
      "TypeError: boom",
      "    at inner (/app/b.js:10:5)",
      "    at outer (/app/a.js:3:1)",
    ].join("\n");
    const frames = parseStackFrames(stack, "");
    assert.equal(frames.length, 2);
    assert.equal(frames[0].function, "outer", "the oldest call comes first");
    assert.equal(frames[1].filename, "/app/b.js");
    assert.equal(frames[1].lineno, 10);
  });

  it("survives a stack with no frames at all", () => {
    assert.deepEqual(parseStackFrames("just a message", ""), []);
    assert.deepEqual(parseStackFrames(undefined, ""), []);
  });
});

describe("event body", () => {
  const event = buildEvent({
    record: { code: "archive-unreadable", message: "boom at C:\\Users\\amotc\\x.js", context: { pages: 3 } },
    eventId: "a".repeat(32),
    release: "pageforge@0.1.0",
    environment: "test",
    homeDirectory: "C:\\Users\\amotc",
    timestamp: "2026-01-01T00:00:00.000Z",
  });

  it("carries the identity and release", () => {
    assert.equal(event.event_id, "a".repeat(32));
    assert.equal(event.release, "pageforge@0.1.0");
    assert.equal(event.environment, "test");
    assert.equal(event.platform, "node");
    assert.equal(event.level, "error");
  });

  it("carries the failure and its code", () => {
    assert.equal(event.tags.code, "archive-unreadable");
    assert.equal(event.exception.values[0].type, "Error");
    assert.deepEqual(event.extra, { pages: 3 });
  });

  it("does not leak the account name", () => {
    assert.ok(!JSON.stringify(event).includes("amotc"), JSON.stringify(event));
  });

  it("copes with a record that has almost nothing in it", () => {
    const bare = buildEvent({
      record: {},
      eventId: "b".repeat(32),
      release: "r",
      environment: "test",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(bare.message, "Unknown failure");
    assert.equal(bare.exception.values[0].stacktrace, undefined);
    assert.equal(bare.tags.code, undefined);
  });
});

describe("auth header", () => {
  it("names the key and the client", () => {
    const header = sentryAuthHeader("abc123");
    assert.match(header, /sentry_version=7/u);
    assert.match(header, /sentry_key=abc123/u);
    assert.match(header, /sentry_client=pageforge/u);
  });
});
