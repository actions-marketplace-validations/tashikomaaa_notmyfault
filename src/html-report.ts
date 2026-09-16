import { computeStats, verdictFor, type TestStats } from "./analyze";
import { FAIL, RETRY, type History, type TestHistory } from "./history";
import { duration, escapeHtml } from "./report";

export interface PageContext {
  trackedBranches: string[];
  now: Date;
  evidenceTtlDays: number;
}

const PROJECT_URL = "https://github.com/tashikomaaa/notmyfault";

/** Where the page of a key lives on the history branch. */
export function reportPath(key: string): string {
  return `reports/${key}.html`;
}

/**
 * A page listing every test of the history that failed or needed a retry in
 * its remembered runs, most unreliable first. Stable tests are only counted:
 * listing thousands of them would bury the ones worth fixing.
 */
export function renderSuitePage(key: string, history: History, context: PageContext): string {
  const rows = Object.entries(history.tests)
    .map(([id, test]) => ({ id, test, stats: computeStats(test, context.now, context.evidenceTtlDays) }))
    .filter(({ test, stats }) => test.outcomes.includes(FAIL) || test.outcomes.includes(RETRY) || stats.confirmed);
  rows.sort((a, b) => score(b.stats) - score(a.stats) || a.id.localeCompare(b.id));
  const stable = Object.keys(history.tests).length - rows.length;
  const where = context.trackedBranches.map((branch) => `<code>${escapeHtml(branch)}</code>`).join(", ");

  const body = [
    `<p class="back"><a href="../index.html">All test suites</a></p>`,
    `<h1>${escapeHtml(key)}</h1>`,
    `<p class="lede">${history.runs} runs recorded on ${where}, last updated ${formatTime(history.updatedAt)}. ${plural(rows.length, "unreliable test")} listed, ${plural(stable, "stable test")} not listed.</p>`,
  ];
  if (rows.length === 0) {
    body.push(`<p class="empty">No test failed or needed a retry in the remembered runs.</p>`);
  } else {
    body.push(
      `<div class="scroll"><table>`,
      `<thead><tr><th>Test</th><th>Verdict</th><th>Remembered runs, oldest first</th><th>Failed</th><th>Retried</th><th>Last failure</th><th>Proof of flakiness</th><th>Median duration</th></tr></thead>`,
      `<tbody>`,
      ...rows.map(({ id, test, stats }) => renderRow(id, test, stats)),
      `</tbody></table></div>`,
      `<p class="legend"><i class="p"></i> passed <i class="r"></i> passed after a retry <i class="f"></i> failed</p>`,
    );
  }
  return page(`notmyfault: ${key}`, body);
}

/** The home page of the history branch, linking to the page of each key. */
export function renderIndexPage(keys: string[], context: PageContext): string {
  const items = keys.map((key) => `<li><a href="${escapeAttribute(reportPath(key))}">${escapeHtml(key)}</a></li>`);
  return page("notmyfault: test history", [
    `<h1>Test history</h1>`,
    `<p class="lede">The tests notmyfault remembers on ${context.trackedBranches.map((branch) => `<code>${escapeHtml(branch)}</code>`).join(", ")}, one page per test suite.</p>`,
    `<ul class="suites">`,
    ...items,
    `</ul>`,
  ]);
}

function renderRow(id: string, test: TestHistory, stats: TestStats): string {
  const [label, tone] = verdict(stats);
  const outcomes = [...test.outcomes];
  const failed = outcomes.filter((outcome) => outcome === FAIL).length;
  const retried = outcomes.filter((outcome) => outcome === RETRY).length;
  const summary = `${outcomes.length - failed - retried} passed, ${retried} passed after a retry, ${failed} failed`;
  const timeline = outcomes.map((outcome) => `<i class="${outcome === FAIL ? "f" : outcome === RETRY ? "r" : "p"}"></i>`).join("");
  const proof = stats.latestEvidence
    ? `${stats.latestEvidence.kind === "rerun" ? "Passed on re-run" : "Passed after a retry"}, ${stats.latestEvidence.at.slice(0, 10)}`
    : "";
  const durations = test.durations ?? [];
  return [
    `<tr>`,
    `<td class="test"><code>${escapeHtml(id)}</code></td>`,
    `<td><span class="verdict ${tone}">${label}</span></td>`,
    `<td><span class="timeline" role="img" aria-label="${summary}">${timeline}</span></td>`,
    `<td class="number">${failed}</td>`,
    `<td class="number">${retried}</td>`,
    `<td>${lastFailure(test) ?? ""}</td>`,
    `<td>${proof}</td>`,
    `<td class="number">${durations.length > 0 ? duration(median(durations)) : ""}</td>`,
    `</tr>`,
  ].join("");
}

function verdict(stats: TestStats): [string, string] {
  switch (verdictFor(stats)) {
    case "broken":
      return ["Already failing", "broken"];
    case "flaky":
      return stats.confirmed ? ["Known flaky", "flaky"] : ["Probably flaky", "flaky"];
    case "suspect":
      return ["Suspect", "suspect"];
    default:
      return ["Passing again", "passed"];
  }
}

/** Most unreliable first: proven flaky or failing, then by share of failed and retried runs. */
function score(stats: TestStats): number {
  const unreliable = (stats.failures + stats.retries) / Math.max(stats.runs, 1);
  return unreliable + (stats.confirmed || stats.trailingFailures > 0 ? 1 : 0);
}

function lastFailure(test: TestHistory): string | undefined {
  const days = [test.lastFailure, ...(test.evidence ?? []).map((evidence) => evidence.at.slice(0, 10))];
  return days.filter((day): day is string => day !== undefined).sort().at(-1);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function formatTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function page(title: string, body: string[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --page: #ffffff; --ink: #1f2328; --muted: #59636e; --line: #d1d9e0; --code: rgb(129 139 152 / 0.12);
  --new: #dc4444; --suspect: #f26514; --broken: #2d3137; --on-broken: #fff; --flaky: #fcbd34; --passed: #19a08e; --link: #0a665c; }
@media (prefers-color-scheme: dark) { :root { --page: #0d1117; --ink: #f0f6fc; --muted: #9198a1; --line: #3d444d; --code: rgb(101 108 118 / 0.3); --broken: #9198a1; --on-broken: #1f2328; --link: #5ed6c7; } }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 90rem; margin: 0 auto; padding: 2rem 1rem 3rem; }
h1 { margin: 0.5rem 0; font-size: 1.75rem; }
a { color: var(--link); }
code { font: 0.85em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 0.1em 0.3em; border-radius: 0.3em; background: var(--code); }
.lede, .back, .legend, footer { color: var(--muted); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin-top: 1.5rem; }
th, td { padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; white-space: nowrap; }
th { font-size: 0.8rem; color: var(--muted); }
td.test { white-space: normal; min-width: 18rem; }
.number { text-align: right; font-variant-numeric: tabular-nums; }
/* Text colors keep every chip at a contrast of 4.5:1 or more. */
.verdict { display: inline-block; padding: 0.1rem 0.55rem; border-radius: 1rem; color: #1f2328; font-size: 0.8rem; font-weight: 600; }
.verdict.new { background: #c93c3c; color: #fff; } .verdict.broken { background: var(--broken); color: var(--on-broken); }
.verdict.suspect { background: var(--suspect); } .verdict.flaky { background: var(--flaky); } .verdict.passed { background: var(--passed); }
.timeline { display: inline-flex; gap: 1px; }
i { display: inline-block; width: 5px; height: 16px; border-radius: 1px; }
i.p { background: var(--passed); opacity: 0.45; } i.r { background: var(--flaky); } i.f { background: var(--new); }
.legend i { vertical-align: middle; margin-left: 0.75rem; }
.suites { font-size: 1.1rem; }
footer { margin-top: 2rem; font-size: 0.85rem; }
</style>
</head>
<body>
<main>
${body.join("\n")}
<footer>Generated by <a href="${PROJECT_URL}">notmyfault</a>, rewritten on every update of the history.</footer>
</main>
</body>
</html>
`;
}
