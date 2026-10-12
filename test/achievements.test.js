/**
 * Achievement rule tests.
 *
 * Streaks and "finished once" are the parts where a mistake is invisible in the
 * UI and wrong in the stored state, so they are tested directly, with the clock
 * supplied rather than waited for.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACHIEVEMENTS,
  achievementSummary,
  currentStreak,
  evaluateAchievements,
  localDayKey,
  longestStreak,
  normalizeAchievementState,
  recordActivity,
} from "../src/core/achievements.js";

const activity = (overrides = {}) => ({
  pathKey: "a.cbz",
  page: 2,
  total: 10,
  dayKey: "2026-03-01",
  hour: 12,
  at: "2026-03-01T12:00:00.000Z",
  ...overrides,
});

describe("day keys", () => {
  it("uses the local calendar day, not UTC", () => {
    // Constructed from local parts, so the key matches what the reader's clock says.
    assert.equal(localDayKey(new Date(2026, 2, 1, 23, 30)), "2026-03-01");
    assert.equal(localDayKey(new Date(2026, 0, 9, 0, 5)), "2026-01-09");
  });
});

describe("streaks", () => {
  it("counts consecutive days back from today", () => {
    const days = ["2026-03-01", "2026-03-02", "2026-03-03"];
    assert.equal(currentStreak(days, "2026-03-03"), 3);
  });

  it("does not break just because today has not been read yet", () => {
    const days = ["2026-03-01", "2026-03-02"];
    assert.equal(currentStreak(days, "2026-03-03"), 2, "a run ending yesterday is still current");
  });

  it("is zero when the last read was longer ago than yesterday", () => {
    assert.equal(currentStreak(["2026-02-20"], "2026-03-03"), 0);
  });

  it("finds the longest run, not just the last one", () => {
    assert.equal(longestStreak(["2026-01-01", "2026-01-02", "2026-01-03", "2026-02-01"]), 3);
    assert.equal(longestStreak([]), 0);
    assert.equal(longestStreak(["2026-01-01"]), 1);
  });

  it("crosses a month and a year boundary", () => {
    assert.equal(currentStreak(["2026-01-31", "2026-02-01"], "2026-02-01"), 2);
    assert.equal(currentStreak(["2025-12-31", "2026-01-01"], "2026-01-01"), 2);
  });

  it("ignores duplicate days", () => {
    assert.equal(longestStreak(["2026-01-01", "2026-01-01", "2026-01-02"]), 2);
  });
});

describe("recording activity", () => {
  it("counts a page turn", () => {
    const state = recordActivity(normalizeAchievementState(null), activity());
    assert.equal(state.pagesTurned, 1);
  });

  it("records the day once, however much is read", () => {
    let state = normalizeAchievementState(null);
    state = recordActivity(state, activity({ page: 1 }));
    state = recordActivity(state, activity({ page: 2 }));
    state = recordActivity(state, activity({ page: 3 }));
    assert.deepEqual(state.openDays, ["2026-03-01"]);
    assert.equal(state.pagesTurned, 3);
  });

  it("records a finished book once, however often the last page is reached", () => {
    let state = normalizeAchievementState(null);
    state = recordActivity(state, activity({ page: 10, total: 10 }));
    state = recordActivity(state, activity({ page: 10, total: 10 }));
    state = recordActivity(state, activity({ page: 10, total: 10 }));
    assert.equal(state.finished.length, 1);
    assert.equal(state.finished[0].pages, 10);
  });

  it("finishes each book separately", () => {
    let state = normalizeAchievementState(null);
    state = recordActivity(state, activity({ pathKey: "a.cbz", page: 10, total: 10 }));
    state = recordActivity(state, activity({ pathKey: "b.cbz", page: 5, total: 5 }));
    assert.equal(state.finished.length, 2);
  });

  it("does not call a one-page book finished, or a page short of the end", () => {
    let state = normalizeAchievementState(null);
    state = recordActivity(state, activity({ page: 1, total: 1 }));
    state = recordActivity(state, activity({ page: 9, total: 10 }));
    assert.equal(state.finished.length, 0);
  });

  it("notices reading in the small hours", () => {
    const state = recordActivity(normalizeAchievementState(null), activity({ hour: 2 }));
    assert.equal(state.nightReading, true);
    const daytime = recordActivity(normalizeAchievementState(null), activity({ hour: 14, page: 3 }));
    assert.equal(daytime.nightReading, false);
  });

  it("does not mutate the state it was given", () => {
    const before = normalizeAchievementState(null);
    const after = recordActivity(before, activity());
    assert.equal(before.pagesTurned, 0);
    assert.equal(after.pagesTurned, 1);
    assert.notEqual(before, after);
  });

  it("survives junk activity", () => {
    const state = recordActivity(normalizeAchievementState(null), {
      pathKey: undefined,
      page: "x",
      total: null,
      dayKey: 7,
      hour: -3,
    });
    assert.equal(state.pagesTurned, 1);
    assert.equal(state.finished.length, 0);
    assert.deepEqual(state.openDays, []);
  });
});

describe("unlocking", () => {
  it("unlocks the first page immediately and only announces it once", () => {
    const state = recordActivity(normalizeAchievementState(null), activity());
    const first = evaluateAchievements(state, { at: "2026-03-01T12:00:00.000Z" });
    assert.deepEqual(
      first.unlockedNow.map((entry) => entry.id),
      ["first-page"],
    );
    const second = evaluateAchievements(first.state, { at: "2026-03-01T12:05:00.000Z" });
    assert.deepEqual(second.unlockedNow, [], "an earned achievement is not announced twice");
    assert.equal(second.state.unlocked["first-page"], "2026-03-01T12:00:00.000Z");
  });

  it("unlocks page counts at their thresholds", () => {
    let state = normalizeAchievementState(null);
    for (let index = 0; index < 99; index += 1) state = recordActivity(state, activity());
    const atNinetyNine = evaluateAchievements(state, {});
    assert.equal(atNinetyNine.unlockedNow.some((entry) => entry.id === "bookworm"), false);
    state = recordActivity(state, activity());
    const atHundred = evaluateAchievements(state, {});
    assert.equal(atHundred.unlockedNow.some((entry) => entry.id === "bookworm"), true);
  });

  it("unlocks Marathon only for a long finished book", () => {
    const short = recordActivity(normalizeAchievementState(null), activity({ page: 20, total: 20 }));
    assert.equal(
      evaluateAchievements(short, {}).unlockedNow.some((entry) => entry.id === "marathon"),
      false,
    );
    const long = recordActivity(normalizeAchievementState(null), activity({ page: 120, total: 120 }));
    assert.equal(
      evaluateAchievements(long, {}).unlockedNow.some((entry) => entry.id === "marathon"),
      true,
    );
  });

  it("unlocks Explorer from the number of books opened", () => {
    const state = evaluateAchievements(normalizeAchievementState(null), { distinctBooks: 10 });
    assert.equal(state.unlockedNow.some((entry) => entry.id === "explorer"), true);
    const nine = evaluateAchievements(normalizeAchievementState(null), { distinctBooks: 9 });
    assert.equal(nine.unlockedNow.some((entry) => entry.id === "explorer"), false);
  });

  it("unlocks the streak achievements from consecutive days", () => {
    let state = normalizeAchievementState(null);
    for (const day of ["2026-03-01", "2026-03-02", "2026-03-03"]) {
      state = recordActivity(state, activity({ dayKey: day }));
    }
    const three = evaluateAchievements(state, { todayKey: "2026-03-03" });
    assert.equal(three.unlockedNow.some((entry) => entry.id === "streak-3"), true);
    assert.equal(three.unlockedNow.some((entry) => entry.id === "streak-7"), false, "seven days is not three");
  });

  it("unlocks Night Owl from the small hours", () => {
    const state = recordActivity(normalizeAchievementState(null), activity({ hour: 1 }));
    assert.equal(
      evaluateAchievements(state, {}).unlockedNow.some((entry) => entry.id === "night-owl"),
      true,
    );
  });

  it("has a unique id, a title and a description for every achievement", () => {
    const ids = ACHIEVEMENTS.map((achievement) => achievement.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const achievement of ACHIEVEMENTS) {
      assert.ok(achievement.title.length > 0, achievement.id);
      assert.ok(achievement.description.length > 0, achievement.id);
      assert.ok(achievement.goal > 0, achievement.id);
    }
  });

  it("can reach every achievement from some state", () => {
    // Guards against an achievement whose threshold no amount of reading reaches.
    let state = normalizeAchievementState(null);
    for (let index = 0; index < 1000; index += 1) {
      state = recordActivity(state, activity({ page: 120, total: 120, hour: 1 }));
    }
    for (let index = 0; index < 20; index += 1) {
      state = recordActivity(state, activity({ pathKey: `book-${index}.cbz`, page: 120, total: 120 }));
    }
    for (let day = 1; day <= 7; day += 1) {
      state = recordActivity(state, activity({ dayKey: `2026-03-0${day}` }));
    }
    const { state: unlocked } = evaluateAchievements(state, { distinctBooks: 20, todayKey: "2026-03-07" });
    assert.equal(Object.keys(unlocked.unlocked).length, ACHIEVEMENTS.length);
  });
});

describe("normalizing stored state", () => {
  it("ignores anything it does not understand", () => {
    const state = normalizeAchievementState({
      pagesTurned: -5,
      finished: [{ pathKey: 7 }, { pathKey: "ok.cbz", pages: 3 }],
      openDays: ["2026-03-01", "nonsense", 42, "2026-03-01"],
      unlocked: { "first-page": "2026-03-01", "not-an-achievement": "2026-03-01" },
      nightReading: "yes",
    });
    assert.equal(state.pagesTurned, 0, "a negative count is refused");
    assert.equal(state.finished.length, 1);
    assert.deepEqual(state.openDays, ["2026-03-01"]);
    assert.deepEqual(Object.keys(state.unlocked), ["first-page"]);
    assert.equal(state.nightReading, false);
  });

  it("returns a usable state for junk", () => {
    for (const junk of [null, undefined, 42, "text", []]) {
      const state = normalizeAchievementState(junk);
      assert.equal(state.pagesTurned, 0);
      assert.deepEqual(state.finished, []);
      assert.deepEqual(state.openDays, []);
    }
  });
});

describe("summary for the dialog", () => {
  it("reports progress towards each achievement without exceeding the goal", () => {
    let state = recordActivity(normalizeAchievementState(null), activity());
    state = recordActivity(state, activity({ page: 3 }));
    const summary = achievementSummary(state, { distinctBooks: 2, todayKey: "2026-03-01" });
    const bookworm = summary.entries.find((entry) => entry.id === "bookworm");
    assert.equal(bookworm.progress, 2);
    assert.equal(bookworm.goal, 100);
    assert.equal(bookworm.unlockedAt, null, "not earned yet");
    const first = summary.entries.find((entry) => entry.id === "first-page");
    assert.equal(first.progress, 1);
    assert.equal(summary.entries.length, ACHIEVEMENTS.length);
  });

  it("marks earned achievements with the date", () => {
    const state = recordActivity(normalizeAchievementState(null), activity());
    const { state: unlocked } = evaluateAchievements(state, { at: "2026-03-01T09:00:00.000Z" });
    const summary = achievementSummary(unlocked, {});
    assert.equal(
      summary.entries.find((entry) => entry.id === "first-page").unlockedAt,
      "2026-03-01T09:00:00.000Z",
    );
  });
});
