import { errorFingerprint, FAIL, RETRY, type FlakyEvidence, type History, type TestHistory } from "./history";
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
}

export interface FixedTest extends TestStats {
  test: TestResult;
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
}

export interface RankedTest extends TestStats {
  id: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Isolated failures needed to call a test flaky without direct evidence. */
const LIKELY_FLAKY_ISOLATED_FAILURES = 3;
const VERDICT_ORDER: Record<Verdict, number> = { new: 0, suspect: 1, broken: 2, flaky: 3 };

export function analyze(results: TestResult[], history: History, now: Date, evidenceTtlDays: number): Analysis {
  const analysis: Analysis = { total: results.length, passed: 0, skipped: 0, failures: [], retried: [], fixed: [] };
  const checkFixed = (test: TestResult) => {
    const tested = history.tests[test.id];
    if (!tested?.outcomes.endsWith(FAIL)) return;
    const stats = computeStats(tested, now, evidenceTtlDays);
    // Had it failed, it would have been already failing: passing now is a fix, not luck.
    if (verdictFor(stats) === "broken") analysis.fixed.push({ test, ...stats });
  };
  for (const test of results) {
    switch (test.outcome) {
      case "passed":
        analysis.passed++;
        checkFixed(test);
        break;
      case "skipped":
        analysis.skipped++;
        break;
      case "flaky":
        analysis.passed++;
        analysis.retried.push(test);
        checkFixed(test);
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
  return analysis;
}

export function computeStats(history: TestHistory | undefined, now: Date, evidenceTtlDays: number): TestStats {
  const outcomes = history?.outcomes ?? "";
  const cutoff = now.getTime() - evidenceTtlDays * DAY_MS;
  const evidence = (history?.evidence ?? []).filter((e) => Date.parse(e.at) >= cutoff);
  const retries = count(outcomes, RETRY);
  const stats: TestStats = {
    runs: outcomes.length,
    failures: count(outcomes, FAIL),
    retries,
    trailingFailures: trailingFailures(outcomes),
    trailingPasses: outcomes.length - outcomes.lastIndexOf(FAIL) - 1,
    isolatedFailures: isolatedFailures(outcomes),
    confirmed: evidence.length > 0 || retries > 0,
  };
  const latest = evidence[evidence.length - 1];
  if (latest) stats.latestEvidence = latest;
  return stats;
}

function verdictFor(stats: TestStats): Verdict {
  // A long failure streak means the test is really broken, even if it used to be flaky.
  if (stats.trailingFailures >= 3) return "broken";
  if (stats.confirmed) return "flaky";
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
  return analysis.failures.filter((failure) => !tolerated.has(failure.verdict));
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
