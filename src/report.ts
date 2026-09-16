import type { Analysis, FailureVerdict, FixedTest, RankedTest, Verdict } from "./analyze";
import type { TestResult } from "./junit";

export type Mode = "report" | "quarantine";

export interface ReportContext {
  /** Identifies the pull request comment. */
  key: string;
  trackedBranches: string[];
  /** Tracked-branch runs recorded before this one. */
  historyRuns: number;
  mode: Mode;
  tolerated: ReadonlySet<Verdict>;
  /** Failures not covered by the tolerated verdicts. */
  blocking: number;
  runUrl?: string;
}

/** The analysis of one test suite, with its own history. */
export interface SuiteReport {
  name: string;
  analysis: Analysis;
  /** Tracked-branch runs recorded before this one. */
  historyRuns: number;
  /** Most unreliable tests, for the job summary. */
  ranking?: RankedTest[];
}

const MAX_ROWS = 30;
const MAX_MESSAGES = 10;
const MAX_FIXED = 10;
const PROJECT_URL = "https://github.com/tashikomaaa/notmyfault";
// Comments already posted keep pointing at these images: never rename or remove them.
const BADGES_URL = "https://raw.githubusercontent.com/tashikomaaa/notmyfault/main/docs/assets";

const EMOJI: Record<Verdict, string> = { new: "🔴", suspect: "🟠", broken: "⚫", flaky: "🟡" };

/** A verdict badge, with its emoji as fallback where images do not load. */
function badge(image: Verdict | "passed", emoji: string, size: number): string {
  return `<img src="${BADGES_URL}/verdict-${image}.png" alt="${emoji}" width="${size}" height="${size}" align="absmiddle">`;
}

export function commentMarker(key: string): string {
  return `<!-- notmyfault:${key} -->`;
}

export function renderComment(analysis: Analysis, context: ReportContext): string {
  return renderSuitesComment([{ name: context.key, analysis, historyRuns: context.historyRuns }], context);
}

export function renderSummary(analysis: Analysis, ranking: RankedTest[], context: ReportContext): string {
  return renderSuitesSummary([{ name: context.key, analysis, historyRuns: context.historyRuns, ranking }], context);
}

/** One comment for every suite: a headline counting them all, then a section per suite when there are several. */
export function renderSuitesComment(suites: SuiteReport[], context: ReportContext): string {
  return [commentMarker(context.key), ...renderBody(suites, context)].join("\n");
}

export function renderSuitesSummary(suites: SuiteReport[], context: ReportContext): string {
  const lines = renderBody(suites, context);
  for (const suite of suites) {
    if (!suite.ranking?.length) continue;
    const of = suites.length > 1 ? ` of ${suite.name}` : "";
    lines.push(
      "",
      `<details><summary>Most unreliable tests${of} on ${branches(context)}</summary>`,
      "",
      "| Test | Failed runs | Passed on retry | Proven flaky |",
      "|---|--:|--:|:-:|",
      ...suite.ranking.map(
        (t) => `| ${code(t.id)} | ${t.failures} / ${t.runs} | ${t.retries} | ${t.confirmed ? "yes" : "probably"} |`,
      ),
      "",
      "</details>",
    );
  }
  return lines.join("\n");
}

function renderBody(suites: SuiteReport[], context: ReportContext): string[] {
  const all = combine(suites.map((suite) => suite.analysis));
  const lines = [`### ${headline(all)}`, ""];

  for (const suite of suites) {
    if (suites.length > 1) {
      lines.push(`#### ${escapeHtml(suite.name)}`, "");
      const { analysis } = suite;
      if (analysis.failures.length === 0 && analysis.fixed.length === 0) {
        lines.push(`${badge("passed", "✅", 20)} All ${plural(analysis.total - analysis.skipped, "test")} passed.`, "");
      }
    }
    lines.push(...renderSuite(suite.analysis, context));
  }

  if (context.mode === "quarantine" && all.failures.length > 0) {
    const tolerated = [...context.tolerated].map((v) => `\`${v}\``).join(", ") || "nothing";
    lines.push(
      context.blocking === 0
        ? `🛡️ **Quarantine:** every failure is tolerated (${tolerated}), so this check passes.`
        : `❌ **Quarantine:** ${plural(context.blocking, "failure")} not tolerated (${tolerated}), so this check fails.`,
      "",
    );
  }

  const withoutHistory = suites.filter((suite) => suite.historyRuns === 0);
  if (withoutHistory.length > 0) {
    const which = suites.length > 1 ? ` for ${withoutHistory.map((suite) => escapeHtml(suite.name)).join(", ")}` : "";
    lines.push(
      `ℹ️ No history on ${branches(context)} yet${which}. Verdicts get sharper once a few runs have been recorded there.`,
      "",
    );
  }

  lines.push(footer(all.retried, context));
  return lines;
}

function combine(analyses: Analysis[]): Analysis {
  return {
    total: analyses.reduce((sum, a) => sum + a.total, 0),
    passed: analyses.reduce((sum, a) => sum + a.passed, 0),
    skipped: analyses.reduce((sum, a) => sum + a.skipped, 0),
    failures: analyses.flatMap((a) => a.failures),
    retried: analyses.flatMap((a) => a.retried),
    fixed: analyses.flatMap((a) => a.fixed),
  };
}

function renderSuite(analysis: Analysis, context: ReportContext): string[] {
  const lines: string[] = [];
  if (analysis.failures.length > 0) {
    lines.push("| Test | Why |", "|---|---|");
    for (const failure of analysis.failures.slice(0, MAX_ROWS)) {
      // In a column of its own, GitHub shrinks the badge to a dot: it sits next to the explanation instead.
      const icon = badge(failure.verdict, EMOJI[failure.verdict], 24);
      lines.push(`| ${code(failure.test.title)} | ${icon} ${explain(failure, context)} |`);
    }
    if (analysis.failures.length > MAX_ROWS) {
      lines.push(`| _…and ${analysis.failures.length - MAX_ROWS} more_ | |`);
    }
    lines.push("");
    lines.push(...renderMessages(analysis.failures));
  }

  if (analysis.fixed.length > 0) lines.push(...renderFixed(analysis.fixed, context));
  return lines;
}

function headline(analysis: Analysis): string {
  const failed = analysis.failures.length;
  if (failed === 0) {
    const retried = analysis.retried.length;
    const suffix = retried > 0 ? ` (${retried} only after a retry)` : "";
    return `${badge("passed", "✅", 32)} All ${plural(analysis.total - analysis.skipped, "test")} passed${suffix}`;
  }
  const yours = analysis.failures.filter((f) => f.verdict === "new" || f.verdict === "suspect").length;
  if (yours === 0) return `${badge("passed", "🟢", 32)} ${plural(failed, "test")} failed, none of them look like your fault`;
  return `${badge("new", "🔴", 32)} ${plural(failed, "test")} failed, ${yours} ${yours === 1 ? "looks" : "look"} related to this change`;
}

/** The explanation of a verdict without Markdown, for annotations. */
export function plainExplanation(failure: FailureVerdict, context: ReportContext): string {
  return explain(failure, context).replace(/\*\*|`/g, "");
}

function explain(failure: FailureVerdict, context: ReportContext): string {
  const where = branches(context);
  switch (failure.verdict) {
    case "new":
      if (failure.usually) return `**New failure.** ${usualBehavior(failure, where)}, but this error was never seen there.`;
      return failure.trailingPasses > 0
        ? `**New failure.** Passed the last ${plural(failure.trailingPasses, "run")} on ${where}.`
        : `**New failure.** No history for this test on ${where}.`;
    case "suspect":
      return `**Suspect.** Failed in isolation ${times(failure.isolatedFailures)} in the last ${plural(failure.runs, "run")} on ${where}.`;
    case "broken":
      return failure.trailingFailures === 1
        ? `**Already failing on ${where}.** The latest run there failed too.`
        : `**Already failing on ${where}.** Failed the last ${failure.trailingFailures} runs there${failure.confirmed ? ", too many in a row to be flakiness" : ""}.`;
    case "flaky": {
      const parts: string[] = [];
      if (failure.failures > 0) parts.push(`failed ${failure.failures} of the last ${plural(failure.runs, "run")} on ${where}`);
      if (failure.retries > 0) parts.push(`passed only after a retry ${plural(failure.retries, "time")}`);
      if (failure.latestEvidence) {
        const day = failure.latestEvidence.at.slice(0, 10);
        parts.push(
          failure.latestEvidence.kind === "rerun"
            ? `passed when the same commit was re-run on ${day}`
            : `passed after a retry on ${day}`,
        );
      }
      const detail = parts.length > 0 ? ` ${capitalize(parts.join("; "))}.` : "";
      return failure.confirmed ? `**Known flaky.**${detail}` : `**Probably flaky.**${detail}`;
    }
  }
}

function usualBehavior(failure: FailureVerdict, where: string): string {
  switch (failure.usually) {
    case "flaky":
      return `${failure.confirmed ? "Known" : "Probably"} flaky on ${where}`;
    case "broken":
      return `Already failing on ${where}`;
    default:
      return `Failed in isolation ${times(failure.isolatedFailures)} on ${where}`;
  }
}

function renderMessages(failures: FailureVerdict[]): string[] {
  const withMessages = failures.filter((f) => f.test.message).slice(0, MAX_MESSAGES);
  if (withMessages.length === 0) return [];
  return [
    "<details><summary>Failure messages</summary>",
    "",
    ...withMessages.flatMap((f) => [`${code(f.test.title)}`, `<pre>${escapeHtml(f.test.message ?? "")}</pre>`]),
    "</details>",
    "",
  ];
}

function renderFixed(fixed: FixedTest[], context: ReportContext): string[] {
  const lines = [
    `🛠️ **Fixed:** ${plural(fixed.length, "test")} failing on ${branches(context)} ${fixed.length === 1 ? "passes" : "pass"} in this run.`,
    "",
    ...fixed
      .slice(0, MAX_FIXED)
      .map(
        (f) =>
          `- ${code(f.test.title)}, ${f.trailingFailures === 1 ? "failed the latest run" : `failed the last ${f.trailingFailures} runs`} there`,
      ),
  ];
  if (fixed.length > MAX_FIXED) lines.push(`- _…and ${fixed.length - MAX_FIXED} more_`);
  lines.push("");
  return lines;
}

function footer(retried: TestResult[], context: ReportContext): string {
  const parts: string[] = [];
  if (retried.length > 0) {
    const names = retried.slice(0, 5).map((t) => code(t.title)).join(", ");
    const more = retried.length > 5 ? ` and ${retried.length - 5} more` : "";
    parts.push(`🔁 Passed only after a retry: ${names}${more}`);
  }
  if (context.runUrl) parts.push(`[Workflow run](${context.runUrl})`);
  parts.push(`Reported by [notmyfault](${PROJECT_URL})`);
  return `<sub>${parts.join(" · ")}</sub>`;
}

function branches(context: ReportContext): string {
  return context.trackedBranches.map((b) => `\`${b}\``).join(", ");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`;
}

// Test names and messages come from reports, so they must render as plain
// text: no HTML, no table breakage, and no Markdown links or emphasis, which
// GitHub still parses between inline HTML tags.
const ESCAPED: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "|": "&#124;",
  "[": "&#91;",
  "]": "&#93;",
  "(": "&#40;",
  ")": "&#41;",
  "*": "&#42;",
  _: "&#95;",
  "`": "&#96;",
  "~": "&#126;",
  "\\": "&#92;",
  "!": "&#33;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"|[\]()*_`~\\!]/g, (char) => ESCAPED[char] ?? char);
}
