// src/dashboard-action.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join as join2, relative, resolve } from "node:path";

// src/history.ts
var HISTORY_VERSION = 1;
var FAIL = "f";
var RETRY = "r";
var MAX_FAILED_ON = 20;
var MAX_EVIDENCE = 10;
var MAX_ERRORS = 10;
var MAX_OUTCOMES = 500;
var MAX_REF_LENGTH = 40;
var MAX_URL_LENGTH = 2048;
var MAX_DURATIONS = 10;
var DAY_MS = 24 * 60 * 60 * 1e3;
function emptyHistory() {
  return { version: HISTORY_VERSION, updatedAt: (/* @__PURE__ */ new Date(0)).toISOString(), runs: 0, tests: /* @__PURE__ */ Object.create(null) };
}
function parseHistory(json) {
  if (!json) return emptyHistory();
  try {
    const data = JSON.parse(json);
    if (data.version !== HISTORY_VERSION || typeof data.tests !== "object" || data.tests === null) {
      return emptyHistory();
    }
    const tests = /* @__PURE__ */ Object.create(null);
    for (const [id, test] of Object.entries(data.tests)) {
      const parsed = parseTest(test);
      if (parsed) tests[id] = parsed;
    }
    return {
      version: HISTORY_VERSION,
      updatedAt: isoDate(data.updatedAt) ?? emptyHistory().updatedAt,
      runs: count(data.runs),
      ...Array.isArray(data.runDurations) ? { runDurations: data.runDurations.filter(isDuration).slice(-MAX_DURATIONS) } : {},
      tests
    };
  } catch {
    return emptyHistory();
  }
}
function parseTest(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const raw = value;
  const outcomes = typeof raw.outcomes === "string" ? raw.outcomes.replace(/[^pfr]/g, "").slice(-MAX_OUTCOMES) : "";
  const test = { outcomes, lastSeen: day(raw.lastSeen) ?? (/* @__PURE__ */ new Date(0)).toISOString().slice(0, 10) };
  const failedOn = list(raw.failedOn, (sha) => hex(sha)).slice(-MAX_FAILED_ON);
  if (failedOn.length > 0) test.failedOn = failedOn;
  const evidence = list(raw.evidence, parseEvidence).slice(-MAX_EVIDENCE);
  if (evidence.length > 0) test.evidence = evidence;
  const errors = list(raw.errors, (value2) => hex(value2)).slice(-MAX_ERRORS);
  if (errors.length > 0) test.errors = errors;
  const lastFailure2 = day(raw.lastFailure);
  if (lastFailure2) test.lastFailure = lastFailure2;
  const durations = list(raw.durations, (ms) => isDuration(ms) ? ms : void 0).slice(-MAX_DURATIONS);
  if (durations.length > 0) test.durations = durations;
  if (typeof raw.lastRun === "number" && Number.isInteger(raw.lastRun) && raw.lastRun >= 0) test.lastRun = raw.lastRun;
  const failingSince = parseFailingSince(raw.failingSince);
  if (failingSince) test.failingSince = failingSince;
  return test;
}
function parseEvidence(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const raw = value;
  const at = isoDate(raw.at);
  const sha = hex(raw.sha);
  if (!at || !sha || raw.kind !== "retry" && raw.kind !== "rerun") return void 0;
  return { at, sha, kind: raw.kind };
}
function parseFailingSince(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const raw = value;
  const at = isoDate(raw.at);
  const sha = hex(raw.sha);
  if (!at || !sha) return void 0;
  const since2 = { sha, at };
  const url = webUrl(raw.url);
  if (url) since2.url = url;
  const change = raw.change;
  const changeUrl = change ? webUrl(change.url) : void 0;
  if (change && changeUrl && typeof change.ref === "string" && change.ref.length <= MAX_REF_LENGTH) {
    since2.change = { ref: change.ref, url: changeUrl };
  }
  return since2;
}
function list(value, parse) {
  if (!Array.isArray(value)) return [];
  const parsed = [];
  for (const item of value.slice(-MAX_FAILED_ON * 2)) {
    const kept = parse(item);
    if (kept !== void 0) parsed.push(kept);
  }
  return parsed;
}
function hex(value) {
  return typeof value === "string" && /^[0-9a-f]{1,64}$/.test(value) ? value : void 0;
}
function day(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : void 0;
}
function isoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(value) ? value : void 0;
}
function webUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return void 0;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : void 0;
  } catch {
    return void 0;
  }
}
function isDuration(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function count(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

// src/analyze.ts
var DAY_MS2 = 24 * 60 * 60 * 1e3;
var LIKELY_FLAKY_ISOLATED_FAILURES = 3;
var UNLIKELY_STREAK_CHANCE = 0.01;
var MIN_BROKEN_STREAK = 3;
var MAX_BROKEN_STREAK = 10;
function computeStats(history, now, evidenceTtlDays) {
  const outcomes = history?.outcomes ?? "";
  const cutoff = now.getTime() - evidenceTtlDays * DAY_MS2;
  const evidence = (history?.evidence ?? []).filter((e) => Date.parse(e.at) >= cutoff);
  const retries = count2(outcomes, RETRY);
  const trailing = trailingFailures(outcomes);
  const before = outcomes.slice(0, outcomes.length - trailing);
  const failureRate = before.length === 0 ? 0 : count2(before, FAIL) / before.length;
  const stats = {
    runs: outcomes.length,
    failures: count2(outcomes, FAIL),
    retries,
    trailingFailures: trailing,
    failureRate,
    brokenStreak: brokenStreak(failureRate),
    trailingPasses: outcomes.length - outcomes.lastIndexOf(FAIL) - 1,
    isolatedFailures: isolatedFailures(outcomes),
    confirmed: evidence.length > 0 || retries > 0
  };
  const latest = evidence[evidence.length - 1];
  if (latest) stats.latestEvidence = latest;
  if (trailing > 0 && history?.failingSince) stats.failingSince = history.failingSince;
  return stats;
}
function verdictFor(stats) {
  if (stats.confirmed) return stats.trailingFailures >= stats.brokenStreak ? "broken" : "flaky";
  if (stats.trailingFailures >= 1) return "broken";
  if (stats.isolatedFailures >= LIKELY_FLAKY_ISOLATED_FAILURES) return "flaky";
  if (stats.isolatedFailures >= 1) return "suspect";
  return "new";
}
function rankFlakyTests(history, now, evidenceTtlDays, limit) {
  const ranked = [];
  for (const [id, test] of Object.entries(history.tests)) {
    const stats = computeStats(test, now, evidenceTtlDays);
    if (!stats.confirmed && stats.isolatedFailures < LIKELY_FLAKY_ISOLATED_FAILURES) continue;
    const cost = estimateCost(test, history);
    ranked.push(cost === void 0 ? { id, ...stats } : { id, ...stats, cost });
  }
  const score2 = (t) => (t.failures + t.retries) / Math.max(t.runs, 1) + (t.confirmed ? 1 : 0);
  return ranked.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || score2(b) - score2(a) || a.id.localeCompare(b.id)).slice(0, limit);
}
function estimateCost(test, history) {
  const failures = count2(test.outcomes, FAIL);
  const retries = count2(test.outcomes, RETRY);
  const suite = history.runDurations?.length ? median(history.runDurations) : void 0;
  const own = test.durations?.length ? median(test.durations) : void 0;
  if (failures > 0 && suite === void 0 || retries > 0 && own === void 0) return void 0;
  return failures * (suite ?? 0) + retries * (own ?? 0);
}
function brokenStreak(failureRate) {
  let streak = MIN_BROKEN_STREAK;
  while (streak < MAX_BROKEN_STREAK && failureRate ** streak >= UNLIKELY_STREAK_CHANCE) streak++;
  return streak;
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
function isolatedFailures(outcomes) {
  let isolated = 0;
  for (let i = 1; i < outcomes.length - 1; i++) {
    if (outcomes[i] === FAIL && outcomes[i - 1] !== FAIL && outcomes[i + 1] !== FAIL) isolated++;
  }
  return isolated;
}
function trailingFailures(outcomes) {
  let streak = 0;
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i] === FAIL; i--) streak++;
  return streak;
}
function count2(value, char) {
  let n = 0;
  for (const c of value) if (c === char) n++;
  return n;
}

// src/report.ts
function linkable(url) {
  return url !== void 0 && /^https?:\/\/[^\s<>"'`()\\]+$/i.test(url) ? url : void 0;
}
function duration(ms) {
  if (ms < 1e3) return `${ms} ms`;
  if (ms < 6e4) return `${(ms / 1e3).toFixed(1)} s`;
  const seconds = Math.round(ms / 1e3);
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  const minutes = Math.round(ms / 6e4);
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
function code(value) {
  return `<code>${escapeHtml(value)}</code>`;
}
var ESCAPED = {
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
  "!": "&#33;"
};
function escapeHtml(value) {
  return value.replace(/[&<>"|[\]()*_`~\\!]/g, (char) => ESCAPED[char] ?? char);
}

// src/html-report.ts
var PROJECT_URL = "https://github.com/tashikomaaa/notmyfault";
function unreliableTests(history, context) {
  return Object.entries(history.tests).map(([id, test]) => ({ id, test, stats: computeStats(test, context.now, context.evidenceTtlDays), cost: estimateCost(test, history) })).filter(({ test, stats }) => test.outcomes.includes(FAIL) || test.outcomes.includes(RETRY) || stats.confirmed);
}
function sortByCost(rows) {
  return rows.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || score(b.stats) - score(a.stats) || a.id.localeCompare(b.id));
}
function tableHeader(leading = []) {
  const columns = [...leading, "Test", "Verdict", "Remembered runs, oldest first", "Failed", "Retried", "Last failure", "Proof of flakiness", "Median duration", "Estimated cost"];
  return `<thead><tr>${columns.map((column) => `<th>${column}</th>`).join("")}</tr></thead>`;
}
function renderRow(id, test, stats, cost, leading = []) {
  const [label, tone] = verdict(stats);
  const outcomes = [...test.outcomes];
  const failed = outcomes.filter((outcome) => outcome === FAIL).length;
  const retried = outcomes.filter((outcome) => outcome === RETRY).length;
  const summary = `${outcomes.length - failed - retried} passed, ${retried} passed after a retry, ${failed} failed`;
  const timeline = outcomes.map((outcome) => `<i class="${outcome === FAIL ? "f" : outcome === RETRY ? "r" : "p"}"></i>`).join("");
  const proof = stats.latestEvidence ? `${stats.latestEvidence.kind === "rerun" ? "Passed on re-run" : "Passed after a retry"}, ${escapeHtml(stats.latestEvidence.at.slice(0, 10))}` : "";
  const durations = test.durations ?? [];
  return [
    `<tr>`,
    ...leading.map((cell) => `<td>${cell}</td>`),
    `<td class="test"><code>${escapeHtml(id)}</code></td>`,
    `<td><span class="verdict ${tone}">${label}</span>${tone === "broken" && stats.failingSince ? since(stats.failingSince) : ""}</td>`,
    `<td><span class="timeline" role="img" aria-label="${summary}">${timeline}</span></td>`,
    `<td class="number">${failed}</td>`,
    `<td class="number">${retried}</td>`,
    `<td>${escapeHtml(lastFailure(test) ?? "")}</td>`,
    `<td>${proof}</td>`,
    `<td class="number">${durations.length > 0 ? duration(median2(durations)) : ""}</td>`,
    `<td class="number">${cost === void 0 ? "" : duration(cost)}</td>`,
    `</tr>`
  ].join("");
}
function since(failing) {
  const commit = link(failing.url, `<code>${escapeHtml(failing.sha.slice(0, 7))}</code>`);
  const change = failing.change ? ` from ${link(failing.change.url, escapeHtml(failing.change.ref))}` : "";
  return `<span class="since">since ${commit}${change}, ${escapeHtml(failing.at.slice(0, 10))}</span>`;
}
function link(url, text) {
  const safe = linkable(url);
  return safe ? `<a href="${escapeAttribute(safe)}">${text}</a>` : text;
}
function verdict(stats) {
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
function score(stats) {
  const unreliable = (stats.failures + stats.retries) / Math.max(stats.runs, 1);
  return unreliable + (stats.confirmed || stats.trailingFailures > 0 ? 1 : 0);
}
function lastFailure(test) {
  const days = [test.lastFailure, ...(test.evidence ?? []).map((evidence) => evidence.at.slice(0, 10))];
  return days.filter((day2) => day2 !== void 0).sort().at(-1);
}
function median2(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
function formatTime(iso) {
  return escapeHtml(`${iso.slice(0, 10)} ${iso.slice(11, 16)}`) + " UTC";
}
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function page(title, body, footer = "rewritten on every update of the history") {
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
.since { display: block; margin-top: 0.25rem; color: var(--muted); font-size: 0.8rem; }
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
<footer>Generated by <a href="${PROJECT_URL}">notmyfault</a>, ${footer}.</footer>
</main>
</body>
</html>
`;
}

// src/dashboard.ts
function dashboardRows(repositories, context) {
  const rows = repositories.flatMap(
    (repository) => repository.suites.flatMap(({ key, history }) => unreliableTests(history, context).map((row) => ({ ...row, repository, key })))
  );
  return sortByCost(rows);
}
function renderDashboard(repositories, context) {
  const rows = dashboardRows(repositories, context);
  const total = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const flaky = repositories.reduce(
    (sum, repository) => sum + repository.suites.reduce((count3, suite) => count3 + rankFlakyTests(suite.history, context.now, context.evidenceTtlDays, Infinity).length, 0),
    0
  );
  const costing = total > 0 ? ` Their failures and retries cost about ${duration(total)} of test time.` : "";
  const body = [
    `<h1>${escapeHtml(context.title)}</h1>`,
    `<p class="lede">${countRepositories(repositories.length)}, ${plural(rows.length, "unreliable test")}, ${plural(flaky, "known or probably flaky test")}.${costing} Updated ${formatTime(context.now.toISOString())}.</p>`,
    `<div class="scroll"><table>`,
    `<thead><tr><th>Repository</th><th>Suites</th><th>Remembered runs</th><th>Unreliable tests</th><th>Estimated cost</th></tr></thead>`,
    `<tbody>`,
    ...repositories.map((repository) => repositoryRow(repository, rows)),
    `</tbody></table></div>`
  ];
  if (rows.length === 0) {
    body.push(`<p class="empty">No test failed or needed a retry in the remembered runs.</p>`);
  } else {
    const listed = rows.slice(0, context.limit);
    body.push(
      `<h2>${rows.length > listed.length ? `The ${listed.length} costliest of ${rows.length} unreliable tests` : "Unreliable tests"}</h2>`,
      `<div class="scroll"><table>`,
      tableHeader(["Repository", "Suite"]),
      `<tbody>`,
      ...listed.map(
        (row) => renderRow(row.id, row.test, row.stats, row.cost, [
          `<a href="${escapeAttribute(row.repository.url)}">${escapeHtml(row.repository.name)}</a>`,
          `<code>${escapeHtml(row.key)}</code>`
        ])
      ),
      `</tbody></table></div>`,
      `<p class="legend"><i class="p"></i> passed <i class="r"></i> passed after a retry <i class="f"></i> failed</p>`
    );
  }
  return page(context.title, body, "rewritten on every run of the dashboard");
}
function mdLink(url, text) {
  const safe = linkable(url);
  return safe ? `[${text}](${safe})` : text;
}
function renderDashboardSummary(repositories, context, limit = 10) {
  const rows = dashboardRows(repositories, context);
  const lines = [`### ${escapeHtml(context.title)}`, "", `${plural(rows.length, "unreliable test")} in ${countRepositories(repositories.length)}.`, ""];
  for (const repository of repositories.filter((candidate) => candidate.error)) {
    lines.push(`\u26A0\uFE0F **${escapeHtml(repository.name)}:** ${escapeHtml(repository.error)}`, "");
  }
  if (rows.length > 0) {
    lines.push("| Repository | Test | Failed runs | Passed on retry | Estimated cost |", "|---|---|--:|--:|--:|");
    for (const row of rows.slice(0, limit)) {
      lines.push(
        `| ${mdLink(row.repository.url, escapeHtml(row.repository.name))} | ${code(row.id)} | ${row.stats.failures} / ${row.stats.runs} | ${row.stats.retries} | ${row.cost === void 0 ? "" : duration(row.cost)} |`
      );
    }
  }
  return lines.join("\n");
}
function repositoryRow(repository, rows) {
  const link2 = `<a href="${escapeAttribute(repository.url)}">${escapeHtml(repository.name)}</a>`;
  if (repository.error) return `<tr><td>${link2}</td><td colspan="4">${escapeHtml(repository.error)}</td></tr>`;
  const own = rows.filter((row) => row.repository === repository);
  const cost = own.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const runs = Math.max(0, ...repository.suites.map((suite) => suite.history.runs));
  return [
    `<tr><td>${link2}</td>`,
    `<td>${repository.suites.map((suite) => `<code>${escapeHtml(suite.key)}</code>`).join(" ")}</td>`,
    `<td class="number">${runs}</td>`,
    `<td class="number">${own.length}</td>`,
    `<td class="number">${cost > 0 ? duration(cost) : ""}</td></tr>`
  ].join("");
}
function countRepositories(n) {
  return `${n} ${n === 1 ? "repository" : "repositories"}`;
}

// src/git-store.ts
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
var GitError = class extends Error {
  constructor(args, output) {
    super(`git ${args[0]} failed: ${output.trim() || "unknown error"}`);
    this.args = args;
    this.output = output;
  }
  args;
  output;
};
var BOT_NAME = "github-actions[bot]";
var BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
var RETRYABLE_PUSH = /stale info|fetch first|non-fast-forward|cannot lock ref|failed to update ref/i;
var GitStore = class {
  constructor(options) {
    this.options = options;
    const { url, user, password } = splitCredentials(options.remoteUrl);
    this.remoteUrl = url;
    this.urlToken = password;
    if (password && !options.token) this.options = { ...options, token: password, username: user || options.username };
  }
  options;
  dir;
  /** The remote without its user name and password, which git would show in the process list. */
  remoteUrl;
  urlToken;
  async read(path) {
    const head = await this.fetchHead();
    return head ? this.readFile(head, path) : void 0;
  }
  /** Every file of the branch whose path starts with `prefix`, by path. Empty when the branch does not exist. */
  async readAll(prefix) {
    const head = await this.fetchHead();
    if (!head) return {};
    const files = {};
    for (const path of await this.listFiles(head)) {
      if (path.startsWith(prefix)) files[path] = await this.git(["cat-file", "blob", `${head}:${path}`]);
    }
    return files;
  }
  /**
   * Rewrites `path` with the result of `update` (skipped when it returns
   * undefined). `update` may run several times, always on the latest content.
   * `derivedFiles` writes more files computed from that result and the paths
   * already on the branch, in the same commit.
   * Resolves to whether a commit was pushed.
   */
  async update(path, update, options) {
    const attempts = options.attempts ?? 6;
    for (let attempt = 1; ; attempt++) {
      const head = await this.fetchHead();
      const next = update(head ? await this.readFile(head, path) : void 0);
      if (next === void 0) return false;
      const existing = options.derivedFiles && head ? await this.listFiles(head) : [];
      const files = { ...options.extraFiles, ...options.derivedFiles?.(next, existing), [path]: next };
      const commit = await this.commit(head, files, options.message);
      let conflict;
      try {
        const output = await this.git([
          "push",
          "--porcelain",
          ...(this.options.pushOptions ?? []).map((option) => `--push-option=${option}`),
          `--force-with-lease=refs/heads/${this.options.branch}:${head ?? ""}`,
          this.remoteUrl,
          `${commit}:refs/heads/${this.options.branch}`
        ]);
        if (commit === head || !/^=\t/m.test(output)) return true;
        conflict = new Error("git push was a no-op: a concurrent writer pushed identical content");
      } catch (error) {
        const retryable = error instanceof GitError && RETRYABLE_PUSH.test(error.output);
        if (!retryable) throw error;
        conflict = error;
      }
      if (attempt >= attempts) throw conflict;
      await sleep(150 * attempt + Math.random() * 350);
    }
  }
  async dispose() {
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
    this.dir = void 0;
  }
  async fetchHead() {
    try {
      await this.git([
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        this.remoteUrl,
        `refs/heads/${this.options.branch}`
      ]);
    } catch (error) {
      if (error instanceof GitError && /couldn't find remote ref/i.test(error.output)) return void 0;
      throw error;
    }
    return (await this.git(["rev-parse", "FETCH_HEAD"])).trim();
  }
  async listFiles(commit) {
    return (await this.git(["ls-tree", "-r", "--name-only", commit])).split("\n").filter(Boolean);
  }
  async readFile(commit, path) {
    const listed = await this.git(["ls-tree", "--name-only", commit, "--", path]);
    if (listed.trim() === "") return void 0;
    return this.git(["cat-file", "blob", `${commit}:${path}`]);
  }
  async commit(parent, files, message) {
    const dir = await this.repository();
    const env = { GIT_INDEX_FILE: join(dir, ".git", "notmyfault-index") };
    await this.git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], env);
    for (const [path, content] of Object.entries(files)) {
      const blob = (await this.git(["hash-object", "-w", "--stdin"], env, content)).trim();
      await this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
    }
    const tree = (await this.git(["write-tree"], env)).trim();
    return (await this.git(["commit-tree", tree, "-m", message], {
      GIT_AUTHOR_NAME: this.options.author?.name ?? BOT_NAME,
      GIT_AUTHOR_EMAIL: this.options.author?.email ?? BOT_EMAIL,
      GIT_COMMITTER_NAME: this.options.author?.name ?? BOT_NAME,
      GIT_COMMITTER_EMAIL: this.options.author?.email ?? BOT_EMAIL
    })).trim();
  }
  async repository() {
    if (!this.dir) {
      const dir = await mkdtemp(join(this.options.tempDir ?? tmpdir(), "notmyfault-"));
      await run(["init", "--quiet", dir], this.baseEnv());
      this.dir = dir;
    }
    return this.dir;
  }
  async git(args, env = {}, input) {
    const dir = await this.repository();
    return run(["-C", dir, ...args], { ...this.baseEnv(), ...env }, input);
  }
  baseEnv() {
    const env = {
      GIT_TERMINAL_PROMPT: "0",
      // Ignore global/system config (credential helpers, hooks, signing...).
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull
    };
    const token = this.options.token ?? this.urlToken;
    const remoteUrl = this.remoteUrl;
    if (token && /^https?:\/\//.test(remoteUrl)) {
      const origin = new URL(remoteUrl).origin;
      const credentials = Buffer.from(`${this.options.username ?? "x-access-token"}:${token}`).toString("base64");
      Object.assign(env, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credentials}`
      });
    }
    return env;
  }
};
function splitCredentials(remoteUrl) {
  if (!/^https?:\/\//.test(remoteUrl)) return { url: remoteUrl };
  try {
    const url = new URL(remoteUrl);
    if (!url.username && !url.password) return { url: remoteUrl };
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    url.username = "";
    url.password = "";
    return { url: url.href, ...user ? { user } : {}, ...password ? { password } : { password: user } };
  } catch {
    return { url: remoteUrl };
  }
}
function run(args, env, input) {
  return new Promise((resolve2, reject) => {
    const child = spawn("git", args, {
      env: { ...process.env, ...env },
      stdio: [input === void 0 ? "ignore" : "pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => reject(new Error(`Unable to run git: ${error.message}`)));
    child.on("close", (code2) => {
      const out = Buffer.concat(stdout).toString("utf8");
      if (code2 === 0) resolve2(out);
      else reject(new GitError(args[0] === "-C" ? args.slice(2) : args, Buffer.concat(stderr).toString("utf8") + out));
    });
    if (child.stdin) {
      child.stdin.on("error", () => {
      });
      child.stdin.end(input);
    }
  });
}
function sleep(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}

// src/github/io.ts
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EOL } from "node:os";
var ActionIO = class {
  constructor(env = process.env, write = (line) => process.stdout.write(line + EOL)) {
    this.env = env;
    this.write = write;
  }
  env;
  write;
  input(name, fallback = "") {
    const value = this.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
    return value === void 0 || value.trim() === "" ? fallback : value.trim();
  }
  booleanInput(name, fallback) {
    const value = this.input(name).toLowerCase();
    if (value === "") return fallback;
    if (["true", "yes", "on", "1"].includes(value)) return true;
    if (["false", "no", "off", "0"].includes(value)) return false;
    throw new Error(`Input "${name}" must be a boolean, got "${value}"`);
  }
  integerInput(name, fallback, min) {
    const value = this.input(name);
    if (value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min) {
      throw new Error(`Input "${name}" must be an integer >= ${min}, got "${value}"`);
    }
    return parsed;
  }
  inputName(name) {
    return `"${name}"`;
  }
  describeInput(name) {
    return `Input "${name}"`;
  }
  describeInputs(names) {
    return `Inputs ${names.map((name) => `"${name}"`).join(" and ")}`;
  }
  setOutput(name, value) {
    const file = this.env.GITHUB_OUTPUT;
    if (!file) return;
    const delimiter = `notmyfault_${randomUUID()}`;
    appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
  }
  appendSummary(markdown) {
    const file = this.env.GITHUB_STEP_SUMMARY;
    if (file) appendFileSync(file, markdown + EOL);
  }
  mask(secret) {
    if (secret) this.command("add-mask", secret);
  }
  info(message) {
    this.write(message);
  }
  warning(message) {
    this.command("warning", message);
  }
  error(message) {
    this.command("error", message);
  }
  /** A workflow annotation on a file, shown in the run summary and next to the code of pull requests. */
  annotation(level, message, properties) {
    const escapeProperty = (value) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
    const list2 = Object.entries(properties).filter(([, value]) => value !== void 0).map(([key, value]) => `${key}=${escapeProperty(String(value))}`).join(",");
    this.command(`${level} ${list2}`, message);
  }
  group(title) {
    this.command("group", title);
  }
  endGroup() {
    this.write("::endgroup::");
  }
  /** Workflow commands are written as they come: nothing to write at the end. */
  finish() {
  }
  command(name, message) {
    const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    this.write(`::${name}::${escaped}`);
  }
};

// src/dashboard-action.ts
var EVIDENCE_TTL_DAYS = 30;
async function runDashboard(env = process.env, io = new ActionIO(env), now = /* @__PURE__ */ new Date()) {
  try {
    const list2 = io.input("repositories").split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
    if (list2.length === 0) throw new Error(`${io.describeInput("repositories")} is required: one owner/repo, or git URL, per line.`);
    const token = io.input("token");
    if (token) io.mask(token);
    const branch = io.input("history-branch", "notmyfault-history");
    const serverUrl = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
    const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
    const output = resolve(workspace, io.input("output", "notmyfault-dashboard"));
    if (relative(workspace, output).startsWith("..")) {
      throw new Error(`${io.describeInput("output")} must stay in the workspace, got "${io.input("output")}"`);
    }
    const context = {
      title: io.input("title", "Unreliable tests"),
      limit: io.integerInput("limit", 100, 1),
      trackedBranches: [],
      now,
      evidenceTtlDays: EVIDENCE_TTL_DAYS
    };
    const repositories = [];
    for (const entry of list2) {
      const isUrl = /^https?:\/\/|^file:\/\//.test(entry);
      const remoteUrl = isUrl ? entry : `${serverUrl}/${entry}.git`;
      const { url: withoutCredentials, password } = splitCredentials(remoteUrl);
      if (password) io.mask(password);
      const shown = isUrl ? withoutCredentials : entry;
      const repository = {
        // A URL keeps its host, to tell apart repositories of the same name on different servers.
        name: shown.replace(/^\w+:\/\//, "").replace(/\.git$/, ""),
        url: withoutCredentials.replace(/\.git$/, ""),
        suites: []
      };
      const sameServer = token !== "" && remoteUrl.startsWith(`${serverUrl}/`);
      const store = new GitStore({ remoteUrl, branch, ...sameServer ? { token } : {}, ...env.RUNNER_TEMP ? { tempDir: env.RUNNER_TEMP } : {} });
      try {
        const files = await store.readAll("history/");
        for (const [path, content] of Object.entries(files)) {
          const key = /^history\/([^/]+)\.json$/.exec(path)?.[1];
          if (key) repository.suites.push({ key, history: parseHistory(content) });
        }
        if (repository.suites.length === 0) repository.error = `No history on branch "${branch}".`;
        io.info(`${repository.name}: ${repository.suites.length} suite(s).`);
      } catch (error) {
        repository.error = `Could not read branch "${branch}".`;
        io.warning(`Could not read the history of ${repository.name}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await store.dispose();
      }
      repositories.push(repository);
    }
    await mkdir(output, { recursive: true });
    await writeFile(join2(output, "index.html"), renderDashboard(repositories, context));
    await writeFile(join2(output, ".nojekyll"), "");
    io.appendSummary(renderDashboardSummary(repositories, context));
    io.setOutput("path", output);
    io.info(`Dashboard written to ${join2(output, "index.html")}.`);
    return repositories.every((repository) => repository.error) ? 1 : 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    io.finish();
  }
}

// src/dashboard-index.ts
process.exitCode = await runDashboard();
