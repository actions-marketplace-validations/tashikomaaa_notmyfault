import type { Analysis, FailureVerdict, RankedTest, Verdict } from "./analyze";
import type { TestResult } from "./junit";

export type Mode = "report" | "quarantine";

export interface ReportContext {
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

const MAX_ROWS = 30;
const MAX_MESSAGES = 10;
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
  return [commentMarker(context.key), ...renderBody(analysis, context)].join("\n");
}

export function renderSummary(analysis: Analysis, ranking: RankedTest[], context: ReportContext): string {
  const lines = renderBody(analysis, context);
  if (ranking.length > 0) {
    lines.push(
      "",
      `<details><summary>Most unreliable tests on ${branches(context)}</summary>`,
      "",
      "| Test | Failed runs | Passed on retry | Proven flaky |",
      "|---|--:|--:|:-:|",
      ...ranking.map(
        (t) => `| ${code(t.id)} | ${t.failures} / ${t.runs} | ${t.retries} | ${t.confirmed ? "yes" : "probably"} |`,
      ),
      "",
      "</details>",
    );
  }
  return lines.join("\n");
}

function renderBody(analysis: Analysis, context: ReportContext): string[] {
  const lines = [`### ${headline(analysis)}`, ""];

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

  if (context.mode === "quarantine" && analysis.failures.length > 0) {
    const tolerated = [...context.tolerated].map((v) => `\`${v}\``).join(", ") || "nothing";
    lines.push(
      context.blocking === 0
        ? `🛡️ **Quarantine:** every failure is tolerated (${tolerated}), so this check passes.`
        : `❌ **Quarantine:** ${plural(context.blocking, "failure")} not tolerated (${tolerated}), so this check fails.`,
      "",
    );
  }

  if (context.historyRuns === 0) {
    lines.push(
      `ℹ️ No history on ${branches(context)} yet. Verdicts get sharper once a few runs have been recorded there.`,
      "",
    );
  }

  lines.push(footer(analysis.retried, context));
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

function explain(failure: FailureVerdict, context: ReportContext): string {
  const where = branches(context);
  switch (failure.verdict) {
    case "new":
      return failure.trailingPasses > 0
        ? `**New failure.** Passed the last ${plural(failure.trailingPasses, "run")} on ${where}.`
        : `**New failure.** No history for this test on ${where}.`;
    case "suspect":
      return `**Suspect.** Failed in isolation ${times(failure.isolatedFailures)} in the last ${plural(failure.runs, "run")} on ${where}.`;
    case "broken":
      return failure.trailingFailures === 1
        ? `**Already failing on ${where}.** The latest run there failed too.`
        : `**Already failing on ${where}.** Failed the last ${failure.trailingFailures} runs there.`;
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

function code(value: string): string {
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"|[\]()*_`~\\!]/g, (char) => ESCAPED[char] ?? char);
}
