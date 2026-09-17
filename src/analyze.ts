import { errorFingerprint, FAIL, RETRY, type FailingSince, type FlakyEvidence, type History, type TestHistory } from "./history";
import type { TestResult } from "./junit";

/**
 * - new: nothing in the history explains the failure, probably caused by the change
 * - suspect: failed in isolation once or twice on the tracked branch
 * - broken: also failing on the tracked branch right now
 * - flaky: proven or very likely flaky
 */
export type Verdict = "new" | "suspect" | "broken" | "flaky";

export interface TestStats {
  /** Runs recorded on tracked branches. */
  runs: number;
  /** Failed runs on tracked branches. */
  failures: number;
  /** Runs on tracked branches that passed only after a retry. */
  retries: number;
  /** Consecutive failures at the end of the tracked history. */
  trailingFailures: number;
  /** Where those trailing failures started, when known. */
  failingSince?: FailingSince;
  /** Share of failed runs on tracked branches before those trailing failures. */
  failureRate: number;
  /** Failures in a row after which a test proven flaky counts as broken: a streak too unlikely to be bad luck. */
  brokenStreak: number;
  /** Consecutive successes (including retries) at the end of the tracked history. */
  trailingPasses: number;
  /** Single failures surrounded by successes on tracked branches. */
  isolatedFailures: number;
  /** Whether a retry or a re-run on the same commit proved the test flaky. */
  confirmed: boolean;
  latestEvidence?: FlakyEvidence;
}

export interface FailureVerdict extends TestStats {
  test: TestResult;
  verdict: Verdict;
  /** The verdict the history gives, when the failure is new only because its error was never seen on the tracked branch. */
  usually?: Exclude<Verdict, "new">;
  /** Set when the test is quarantined by hand: its failure never blocks. */
  quarantined?: { until: string; reason?: string };
}

export interface FixedTest extends TestStats {
  test: TestResult;
}

export interface SlowerTest {
  test: TestResult;
  /** Duration in this run, in milliseconds. */
  duration: number;
  /** Median duration on tracked branches, in milliseconds. */
  usual: number;
}

/** Tests of the latest run on the tracked branch that are not in this run, by file or suite. */
export interface MissingTests {
  /** The file or suite: the identity of the tests before their last "›". */
  group: string;
  /** Identities of the missing tests. */
  ids: string[];
  /** Whether every test of the group in the latest run on the tracked branch is missing. */
  whole: boolean;
}

export interface FailureTrend {
  id: string;
  /** Share of failed runs, in percent, among the TREND_WINDOW runs ending at each run, oldest first. */
  rates: number[];
  /** Number, among the remembered runs, of the first run each rate ends at. */
  firstRun: number;
}

export interface SlowTest {
  id: string;
  /** Median, fastest and slowest durations on tracked branches, in milliseconds. */
  median: number;
  fastest: number;
  slowest: number;
  runs: number;
}

export interface Analysis {
  total: number;
  passed: number;
  skipped: number;
  /** Failed tests, most actionable first. */
  failures: FailureVerdict[];
  /** Tests that passed only after a retry in this run. */
  retried: TestResult[];
  /** Tests that pass in this run while they are failing on the tracked branch. */
  fixed: FixedTest[];
  /** Passing tests that took much longer than usual on the tracked branch. */
  slower: SlowerTest[];
  /** Tests that ran in the latest run on the tracked branch but are not in this run. */
  missing: MissingTests[];
}

export interface RankedTest extends TestStats {
  id: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SEPARATOR = " › ";
/** Isolated failures needed to call a test flaky without direct evidence. */
const LIKELY_FLAKY_ISOLATED_FAILURES = 3;
/** A flaky test is broken once its failure streak had less than this chance to happen by bad luck. */
const UNLIKELY_STREAK_CHANCE = 0.01;
const MIN_BROKEN_STREAK = 3;
const MAX_BROKEN_STREAK = 10;
/** A passing test is slower when it takes at least twice its median duration, and 500 ms more, over at least 5 runs. */
const SLOWER_RATIO = 2;
const SLOWER_MIN_DIFFERENCE_MS = 500;
const SLOWER_MIN_RUNS = 5;
const VERDICT_ORDER: Record<Verdict, number> = { new: 0, suspect: 1, broken: 2, flaky: 3 };

export function analyze(results: TestResult[], history: History, now: Date, evidenceTtlDays: number): Analysis {
  const analysis: Analysis = {
    total: results.length,
    passed: 0,
    skipped: 0,
    failures: [],
    retried: [],
    fixed: [],
    slower: [],
    missing: missingTests(results, history),
  };
  const checkFixed = (test: TestResult) => {
    const tested = history.tests[test.id];
    if (!tested?.outcomes.endsWith(FAIL)) return;
    const stats = computeStats(tested, now, evidenceTtlDays);
    // Had it failed, it would have been already failing: passing now is a fix, not luck.
    if (verdictFor(stats) === "broken") analysis.fixed.push({ test, ...stats });
  };
  const checkSlower = (test: TestResult) => {
    const durations = history.tests[test.id]?.durations ?? [];
    if (test.duration === undefined || durations.length < SLOWER_MIN_RUNS) return;
    const usual = median(durations);
    if (test.duration >= usual * SLOWER_RATIO && test.duration - usual >= SLOWER_MIN_DIFFERENCE_MS) {
      analysis.slower.push({ test, duration: test.duration, usual });
    }
  };
  for (const test of results) {
    switch (test.outcome) {
      case "passed":
        analysis.passed++;
        checkFixed(test);
        checkSlower(test);
        break;
      case "skipped":
        analysis.skipped++;
        break;
      case "flaky":
        analysis.passed++;
        analysis.retried.push(test);
        checkFixed(test);
        checkSlower(test);
        break;
      case "failed": {
        const tested = history.tests[test.id];
        const stats = computeStats(tested, now, evidenceTtlDays);
        const failure: FailureVerdict = { test, verdict: verdictFor(stats), ...stats };
        // Flakiness or a breakage on the tracked branch only explains the errors seen there.
        if (failure.verdict !== "new" && hasNewError(tested, test)) {
          failure.usually = failure.verdict;
          failure.verdict = "new";
        }
        analysis.failures.push(failure);
        break;
      }
    }
  }
  analysis.failures.sort(
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.test.title.localeCompare(b.test.title),
  );
  analysis.retried.sort((a, b) => a.title.localeCompare(b.title));
  analysis.fixed.sort((a, b) => a.test.title.localeCompare(b.test.title));
  analysis.slower.sort((a, b) => b.duration / b.usual - a.duration / a.usual || a.test.title.localeCompare(b.test.title));
  return analysis;
}

/**
 * Tests that were part of the latest run on the tracked branch and are not in these results, not even skipped:
 * deleted, renamed, or no longer discovered. Histories written before lastRun existed tell nothing.
 */
export function missingTests(results: TestResult[], history: History): MissingTests[] {
  const present = new Set(results.map((result) => result.id));
  const groups = new Map<string, { ids: string[]; latest: number }>();
  for (const [id, test] of Object.entries(history.tests)) {
    if (history.runs === 0 || test.lastRun !== history.runs) continue;
    const index = id.lastIndexOf(SEPARATOR);
    const name = index === -1 ? "" : id.slice(0, index);
    const group = groups.get(name) ?? { ids: [], latest: 0 };
    group.latest++;
    if (!present.has(id)) group.ids.push(id);
    groups.set(name, group);
  }
  return [...groups]
    .filter(([, group]) => group.ids.length > 0)
    .map(([name, group]) => ({ group: name, ids: group.ids.sort(), whole: group.ids.length === group.latest }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

export function computeStats(history: TestHistory | undefined, now: Date, evidenceTtlDays: number): TestStats {
  const outcomes = history?.outcomes ?? "";
  const cutoff = now.getTime() - evidenceTtlDays * DAY_MS;
  const evidence = (history?.evidence ?? []).filter((e) => Date.parse(e.at) >= cutoff);
  const retries = count(outcomes, RETRY);
  const trailing = trailingFailures(outcomes);
  const before = outcomes.slice(0, outcomes.length - trailing);
  const failureRate = before.length === 0 ? 0 : count(before, FAIL) / before.length;
  const stats: TestStats = {
    runs: outcomes.length,
    failures: count(outcomes, FAIL),
    retries,
    trailingFailures: trailing,
    failureRate,
    brokenStreak: brokenStreak(failureRate),
    trailingPasses: outcomes.length - outcomes.lastIndexOf(FAIL) - 1,
    isolatedFailures: isolatedFailures(outcomes),
    confirmed: evidence.length > 0 || retries > 0,
  };
  const latest = evidence[evidence.length - 1];
  if (latest) stats.latestEvidence = latest;
  if (trailing > 0 && history?.failingSince) stats.failingSince = history.failingSince;
  return stats;
}

/** The verdict a failure would get with these statistics. */
export function verdictFor(stats: TestStats): Verdict {
  // A flaky test fails in a row now and then: only a streak too long to be bad luck means it is broken.
  if (stats.confirmed) return stats.trailingFailures >= stats.brokenStreak ? "broken" : "flaky";
  if (stats.trailingFailures >= 1) return "broken";
  // A commit that breaks a test and the next one that fixes it look like an
  // isolated failure too, so a couple of them is not enough to excuse a test.
  if (stats.isolatedFailures >= LIKELY_FLAKY_ISOLATED_FAILURES) return "flaky";
  if (stats.isolatedFailures >= 1) return "suspect";
  return "new";
}

/** Whether the test failed with an error never seen on the tracked branch. Without any error recorded, nothing can be told. */
function hasNewError(history: TestHistory | undefined, test: TestResult): boolean {
  const known = history?.errors ?? [];
  return known.length > 0 && test.message !== undefined && !known.includes(errorFingerprint(test.message));
}

/** Failures that are not covered by the tolerated verdicts. */
export function blockingFailures(analysis: Analysis, tolerated: ReadonlySet<Verdict>): FailureVerdict[] {
  return analysis.failures.filter((failure) => !failure.quarantined && !tolerated.has(failure.verdict));
}

/** Tests known or probably flaky in the history, for the badge. */
export function countFlakyTests(history: History, now: Date, evidenceTtlDays: number): number {
  return rankFlakyTests(history, now, evidenceTtlDays, Number.POSITIVE_INFINITY).length;
}

/** Most unreliable tests in the history, for the job summary. */
export function rankFlakyTests(history: History, now: Date, evidenceTtlDays: number, limit: number): RankedTest[] {
  const ranked: RankedTest[] = [];
  for (const [id, test] of Object.entries(history.tests)) {
    const stats = computeStats(test, now, evidenceTtlDays);
    if (stats.confirmed || stats.isolatedFailures >= LIKELY_FLAKY_ISOLATED_FAILURES) ranked.push({ id, ...stats });
  }
  const score = (t: RankedTest) => (t.failures + t.retries) / Math.max(t.runs, 1) + (t.confirmed ? 1 : 0);
  return ranked.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id)).slice(0, limit);
}

/**
 * Shortest streak of failures, between 3 and 10, that a test failing at
 * `failureRate` has less than a 1% chance to produce by bad luck.
 */
export function brokenStreak(failureRate: number): number {
  let streak = MIN_BROKEN_STREAK;
  while (streak < MAX_BROKEN_STREAK && failureRate ** streak >= UNLIKELY_STREAK_CHANCE) streak++;
  return streak;
}

/** Runs each point of a trend covers. */
export const TREND_WINDOW = 10;
/** Runs a test needs before its trend says anything. */
const TREND_MIN_RUNS = 15;

/** How the failure rate of the given tests evolved over their remembered runs, for the job summary. */
export function failureTrends(history: History, ids: string[]): FailureTrend[] {
  const trends: FailureTrend[] = [];
  for (const id of ids) {
    const outcomes = history.tests[id]?.outcomes ?? "";
    if (outcomes.length < TREND_MIN_RUNS) continue;
    const rates: number[] = [];
    for (let end = TREND_WINDOW; end <= outcomes.length; end++) {
      rates.push(Math.round((count(outcomes.slice(end - TREND_WINDOW, end), FAIL) / TREND_WINDOW) * 100));
    }
    trends.push({ id, rates, firstRun: TREND_WINDOW });
  }
  return trends;
}

/** Slowest tests on tracked branches, by median duration, for the job summary. */
export function rankSlowTests(history: History, limit: number): SlowTest[] {
  const ranked: SlowTest[] = [];
  for (const [id, test] of Object.entries(history.tests)) {
    const durations = test.durations ?? [];
    if (durations.length === 0) continue;
    ranked.push({ id, median: median(durations), fastest: Math.min(...durations), slowest: Math.max(...durations), runs: durations.length });
  }
  return ranked.filter((test) => test.median > 0).sort((a, b) => b.median - a.median || a.id.localeCompare(b.id)).slice(0, limit);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** Single failures surrounded by successes: the typical flaky signature. */
export function isolatedFailures(outcomes: string): number {
  let isolated = 0;
  for (let i = 1; i < outcomes.length - 1; i++) {
    if (outcomes[i] === FAIL && outcomes[i - 1] !== FAIL && outcomes[i + 1] !== FAIL) isolated++;
  }
  return isolated;
}

export function trailingFailures(outcomes: string): number {
  let streak = 0;
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i] === FAIL; i--) streak++;
  return streak;
}

function count(value: string, char: string): number {
  let n = 0;
  for (const c of value) if (c === char) n++;
  return n;
}
