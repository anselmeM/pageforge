/**
 * Reading achievements.
 *
 * These are derived entirely from what the reader has done on this machine: pages
 * turned, books finished, days read. Nothing is sent anywhere, and nothing here
 * touches the filesystem, so the rules are testable on their own.
 *
 * Every input that depends on the clock is passed in — the day key and the hour —
 * rather than read here. A module that reads the clock can only be tested by
 * waiting, and streaks are exactly the kind of thing that needs testing.
 */

/** A page turn is counted per navigation, so re-opening a book does not inflate it. */
const DEFAULT_ACHIEVEMENT_STATE = {
  pagesTurned: 0,
  /** Books read to their last page, once each. */
  finished: [],
  /** Local days on which anything was read, as YYYY-MM-DD, oldest first. */
  openDays: [],
  /** Set once the reader has read between midnight and 4am. */
  nightReading: false,
  /** Achievement id to the date it was earned. */
  unlocked: {},
};

const MAX_FINISHED = 500;
const MAX_DAY_KEYS = 730;
/** Reading between midnight and this hour counts as the small hours. */
const NIGHT_OWL_UNTIL_HOUR = 4;

/** Local calendar day for a date, as YYYY-MM-DD. */
export const localDayKey = (date) => {
  const value = date instanceof Date ? date : new Date(date);
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
};

/** Day arithmetic on a key, through UTC so a daylight-saving change cannot skew it. */
const shiftDayKey = (dayKey, days) => {
  const [year, month, day] = dayKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86400000);
  const shiftedMonth = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const shiftedDay = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${shiftedMonth}-${shiftedDay}`;
};

/**
 * Consecutive days read, counting back from today.
 *
 * A run that ends yesterday is still current: it should not break at midnight
 * before the reader has had a chance to read.
 */
export const currentStreak = (openDays, todayKey) => {
  const days = new Set(openDays ?? []);
  let cursor = days.has(todayKey) ? todayKey : shiftDayKey(todayKey, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = shiftDayKey(cursor, -1);
  }
  return streak;
};

/** The longest run of consecutive days ever read. */
export const longestStreak = (openDays) => {
  const sorted = [...new Set(openDays ?? [])].sort();
  let best = 0;
  let run = 0;
  let previous = null;
  for (const day of sorted) {
    run = previous !== null && shiftDayKey(previous, 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  return best;
};

/**
 * The achievements, as data.
 *
 * `measure` returns the number to compare and `goal` the number to reach, so the
 * dialog can show real progress rather than a bare locked/unlocked state.
 */
export const ACHIEVEMENTS = [
  {
    id: "first-page",
    title: "First Page",
    description: "Turn a single page.",
    measure: (s) => s.pagesTurned,
    goal: 1,
  },
  {
    id: "bookworm",
    title: "Bookworm",
    description: "Turn 100 pages.",
    measure: (s) => s.pagesTurned,
    goal: 100,
  },
  {
    id: "page-turner",
    title: "Page Turner",
    description: "Turn 1,000 pages.",
    measure: (s) => s.pagesTurned,
    goal: 1000,
  },
  {
    id: "finisher",
    title: "Finisher",
    description: "Read a book to its last page.",
    measure: (s) => s.booksFinished,
    goal: 1,
  },
  {
    id: "marathon",
    title: "Marathon",
    description: "Finish a book of 100 pages or more.",
    measure: (s) => s.longestFinished,
    goal: 100,
  },
  {
    id: "completionist",
    title: "Completionist",
    description: "Finish ten books.",
    measure: (s) => s.booksFinished,
    goal: 10,
  },
  {
    id: "explorer",
    title: "Explorer",
    description: "Open ten different books.",
    measure: (s) => s.distinctBooks,
    goal: 10,
  },
  {
    id: "streak-3",
    title: "Three in a Row",
    description: "Read on three consecutive days.",
    measure: (s) => s.longestStreak,
    goal: 3,
  },
  {
    id: "streak-7",
    title: "A Full Week",
    description: "Read on seven consecutive days.",
    measure: (s) => s.longestStreak,
    goal: 7,
  },
  {
    id: "night-owl",
    title: "Night Owl",
    description: "Read between midnight and 4am.",
    measure: (s) => (s.nightReading ? 1 : 0),
    goal: 1,
  },
];

/** Keep only the state this module understands, whatever was on disk. */
export const normalizeAchievementState = (value) => {
  const state = { ...DEFAULT_ACHIEVEMENT_STATE, finished: [], openDays: [], unlocked: {} };
  if (value === null || typeof value !== "object") return state;
  if (Number.isInteger(value.pagesTurned) && value.pagesTurned >= 0) {
    state.pagesTurned = value.pagesTurned;
  }
  if (Array.isArray(value.finished)) {
    state.finished = value.finished
      .filter((entry) => entry !== null && typeof entry === "object" && typeof entry.pathKey === "string")
      .map((entry) => ({
        pathKey: entry.pathKey,
        pages: Number.isInteger(entry.pages) ? entry.pages : 0,
        at: typeof entry.at === "string" ? entry.at : null,
      }))
      .slice(-MAX_FINISHED);
  }
  if (Array.isArray(value.openDays)) {
    state.openDays = [...new Set(value.openDays.filter((day) => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(day)))]
      .sort()
      .slice(-MAX_DAY_KEYS);
  }
  state.nightReading = value.nightReading === true;
  if (value.unlocked !== null && typeof value.unlocked === "object") {
    for (const [id, at] of Object.entries(value.unlocked)) {
      if (ACHIEVEMENTS.some((achievement) => achievement.id === id) && typeof at === "string") {
        state.unlocked[id] = at;
      }
    }
  }
  return state;
};

/**
 * Fold one page turn into the state.
 *
 * @param {object} state normalized achievement state
 * @param {{pathKey: string, page: number, total: number, dayKey: string, hour: number, at: string}} activity
 */
export const recordActivity = (state, activity) => {
  const current = normalizeAchievementState(state);
  const next = {
    ...current,
    finished: [...current.finished],
    openDays: [...current.openDays],
    unlocked: { ...current.unlocked },
  };
  next.pagesTurned += 1;

  // Finished once per book: reaching the last page again should not count twice.
  const total = Number(activity.total);
  const page = Number(activity.page);
  if (
    Number.isInteger(total) &&
    total > 1 &&
    Number.isInteger(page) &&
    page >= total &&
    typeof activity.pathKey === "string" &&
    !next.finished.some((entry) => entry.pathKey === activity.pathKey)
  ) {
    next.finished.push({ pathKey: activity.pathKey, pages: total, at: activity.at ?? null });
    if (next.finished.length > MAX_FINISHED) next.finished = next.finished.slice(-MAX_FINISHED);
  }

  if (typeof activity.dayKey === "string" && !next.openDays.includes(activity.dayKey)) {
    next.openDays.push(activity.dayKey);
    next.openDays.sort();
    if (next.openDays.length > MAX_DAY_KEYS) next.openDays = next.openDays.slice(-MAX_DAY_KEYS);
  }

  if (Number.isInteger(activity.hour) && activity.hour >= 0 && activity.hour < NIGHT_OWL_UNTIL_HOUR) {
    next.nightReading = true;
  }
  return next;
};

/** What the achievements are measured against. */
const achievementMeasures = (state, { distinctBooks = 0, todayKey = "" } = {}) => {
  const current = normalizeAchievementState(state);
  return {
    pagesTurned: current.pagesTurned,
    booksFinished: current.finished.length,
    longestFinished: current.finished.reduce((longest, entry) => Math.max(longest, entry.pages ?? 0), 0),
    distinctBooks,
    longestStreak: longestStreak(current.openDays),
    currentStreak: todayKey === "" ? 0 : currentStreak(current.openDays, todayKey),
    nightReading: current.nightReading,
  };
};

/**
 * Unlock whatever has just been earned.
 *
 * Returns the state with the new unlocks recorded and the achievements that were
 * earned *this time*, so the caller can announce them exactly once.
 */
export const evaluateAchievements = (state, { distinctBooks = 0, todayKey = "", at = "" } = {}) => {
  const current = normalizeAchievementState(state);
  const measures = achievementMeasures(current, { distinctBooks, todayKey });
  const unlockedNow = [];
  const unlocked = { ...current.unlocked };
  for (const achievement of ACHIEVEMENTS) {
    if (unlocked[achievement.id] !== undefined) continue;
    if (achievement.measure(measures) >= achievement.goal) {
      unlocked[achievement.id] = at;
      unlockedNow.push({
        id: achievement.id,
        title: achievement.title,
        description: achievement.description,
      });
    }
  }
  return { state: { ...current, unlocked }, unlockedNow };
};

/** Everything the dialog needs: each achievement, whether it is earned, and progress. */
export const achievementSummary = (state, { distinctBooks = 0, todayKey = "" } = {}) => {
  const current = normalizeAchievementState(state);
  const measures = achievementMeasures(current, { distinctBooks, todayKey });
  return {
    measures,
    entries: ACHIEVEMENTS.map((achievement) => {
      const progress = achievement.measure(measures);
      return {
        id: achievement.id,
        title: achievement.title,
        description: achievement.description,
        unlockedAt: current.unlocked[achievement.id] ?? null,
        progress: Math.min(progress, achievement.goal),
        goal: achievement.goal,
      };
    }),
  };
};
