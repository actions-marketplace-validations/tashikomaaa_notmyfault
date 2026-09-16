import { createHash } from "node:crypto";
import { computeStats, verdictFor, type TestStats } from "./analyze";
import type { Issue } from "./github";
import type { History, TestHistory } from "./history";
import type { TestResult } from "./junit";
import { code, escapeHtml } from "./report";

export const FLAKY_LABEL = { name: "flaky-test", color: "fcbd34", description: "A test notmyfault found flaky" };
/** An issue is closed after this many days without a failure on the tracked branch. */
export const QUIET_DAYS = 30;
/** Issues opened per run, so that turning the feature on does not flood the repository. */
export const MAX_CREATED_PER_RUN = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TITLE_LENGTH = 200;
const QUARANTINE_URL = "https://github.com/tashikomaaa/notmyfault/blob/main/docs/quarantine.md";

export interface FlakySuite {
  key: string;
  /** The history of the suite, including this run. */
  history: History;
  results: TestResult[];
}

export interface IssueContext {
  trackedBranches: string[];
  now: Date;
  evidenceTtlDays: number;
  sha: string;
  runUrl?: string;
}

export type IssueAction =
  | { kind: "create"; title: string; body: string }
  | { kind: "update"; issue: number; body: string; reopen: boolean }
  | { kind: "close"; issue: number; comment: string };

/** Identifies the issue of a test, hidden at the top of its body. */
export function flakyMarker(key: string, id: string): string {
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `<!-- notmyfault:flaky:${key}:${hash} -->`;
}

/**
 * Decides what to do with the issue of each test, from the history of a run
 * on a tracked branch:
 *
 * - a test proven flaky that failed in the last 30 days gets an issue;
 * - an open issue is updated when its test fails, or passes only after a retry;
 * - a closed issue is reopened when its test, still flaky, fails again;
 * - an open issue is closed after 30 days without a failure, or when its test left the history.
 */
export function planFlakyIssues(
  suites: FlakySuite[],
  issues: Issue[],
  context: IssueContext,
): { actions: IssueAction[]; postponed: number } {
  const byMarker = new Map<string, Issue>();
  for (const issue of issues) {
    const marker = /<!-- notmyfault:flaky:\S+ -->/.exec(issue.body)?.[0];
    if (marker && !byMarker.has(marker)) byMarker.set(marker, issue);
  }

  const actions: IssueAction[] = [];
  const seen = new Set<string>();
  let created = 0;
  let postponed = 0;
  for (const suite of suites) {
    const results = new Map(suite.results.map((result) => [result.id, result]));
    for (const [id, test] of Object.entries(suite.history.tests)) {
      const marker = flakyMarker(suite.key, id);
      seen.add(marker);
      const issue = byMarker.get(marker);
      const lastFailure = lastFailureDay(test);
      const recent = lastFailure !== undefined && context.now.getTime() - Date.parse(lastFailure) < QUIET_DAYS * DAY_MS;
      const result = results.get(id);
      const failedNow = result?.outcome === "failed" || result?.outcome === "flaky";
      const stats = computeStats(test, context.now, context.evidenceTtlDays);
      const body = () => renderFlakyIssue(suite.key, id, test, stats, result, context);

      if (issue?.state === "open") {
        if (!recent) actions.push({ kind: "close", issue: issue.number, comment: quietComment(lastFailure, context) });
        else if (failedNow) actions.push({ kind: "update", issue: issue.number, body: body(), reopen: false });
        continue;
      }
      if (!stats.confirmed || !recent) continue;
      if (issue) {
        if (failedNow) actions.push({ kind: "update", issue: issue.number, body: body(), reopen: true });
      } else if (created === MAX_CREATED_PER_RUN) {
        postponed++;
      } else {
        created++;
        actions.push({ kind: "create", title: issueTitle(result?.title ?? id), body: body() });
      }
    }
  }

  for (const [marker, issue] of byMarker) {
    const key = marker.slice("<!-- notmyfault:flaky:".length).split(":")[0];
    if (issue.state !== "open" || seen.has(marker) || !suites.some((suite) => suite.key === key)) continue;
    actions.push({
      kind: "close",
      issue: issue.number,
      comment: `This test is no longer in the history of ${branches(context)}: it was renamed, removed, or not run for 90 days. Closing this issue.`,
    });
  }
  return { actions, postponed };
}

function renderFlakyIssue(
  key: string,
  id: string,
  test: TestHistory,
  stats: TestStats,
  result: TestResult | undefined,
  context: IssueContext,
): string {
  const where = branches(context);
  const retries = stats.retries > 0 ? `, and passed only after a retry ${times(stats.retries)}` : "";
  const lines = [
    flakyMarker(key, id),
    `notmyfault found this test flaky on ${where}. It keeps this issue up to date, and closes it after ${QUIET_DAYS} days without a failure there.`,
    "",
    `- **Test:** ${code(result?.title ?? id)}`,
    `- **Suite:** \`${key}\``,
    `- **Verdict on ${where}:** ${verdict(stats)}`,
    `- **Runs on ${where}:** failed ${stats.failures} of the last ${plural(stats.runs, "run")}${retries}`,
    `- **Last failure:** ${lastFailureDay(test) ?? "unknown"}`,
  ];
  if (stats.latestEvidence) {
    const day = stats.latestEvidence.at.slice(0, 10);
    lines.push(
      `- **Proof:** ${stats.latestEvidence.kind === "rerun" ? "passed when the same commit was re-run" : "passed after a retry"} on ${day}`,
    );
  }

  // Issues are only updated when their test fails, which gives the latest failure.
  if (result?.outcome === "failed" || result?.outcome === "flaky") lines.push("", latestFailure(result, context));
  lines.push("", `Until it is fixed, [quarantine mode](${QUARANTINE_URL}) keeps it from blocking pull requests.`);
  return lines.join("\n");
}

function latestFailure(result: TestResult, context: IssueContext): string {
  const run = context.runUrl ? `, in [this workflow run](${context.runUrl})` : "";
  const what = result.outcome === "flaky" ? "Latest retry" : "Latest failure";
  const message = result.message ? `<pre>${escapeHtml(result.message)}</pre>` : "_The report has no failure message._";
  return [`**${what}**, on commit \`${context.sha.slice(0, 12)}\`${run}:`, "", message].join("\n");
}

function verdict(stats: TestStats): string {
  switch (verdictFor(stats)) {
    case "broken":
      return `already failing, failed the last ${plural(stats.trailingFailures, "run")}`;
    case "flaky":
      return stats.confirmed ? "known flaky" : "probably flaky";
    case "suspect":
      return "suspect";
    default:
      return "passing again";
  }
}

function lastFailureDay(test: TestHistory): string | undefined {
  const days = [test.lastFailure, ...(test.evidence ?? []).map((evidence) => evidence.at.slice(0, 10))];
  return days.filter((day): day is string => day !== undefined).sort().at(-1);
}

function quietComment(lastFailure: string | undefined, context: IssueContext): string {
  const since = lastFailure ? ` since ${lastFailure}` : "";
  return `No failure on ${branches(context)}${since}, for more than ${QUIET_DAYS} days: closing this issue. notmyfault reopens it if the test fails again.`;
}

function issueTitle(title: string): string {
  const short = title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
  return `Flaky test: ${short}`;
}

function branches(context: IssueContext): string {
  return context.trackedBranches.map((branch) => `\`${branch}\``).join(", ");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}
