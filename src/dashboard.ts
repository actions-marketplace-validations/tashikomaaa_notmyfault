import { rankFlakyTests } from "./analyze";
import type { History } from "./history";
import {
  escapeAttribute,
  formatTime,
  page,
  plural,
  renderRow,
  sortByCost,
  tableHeader,
  unreliableTests,
  type PageContext,
  type UnreliableTest,
} from "./html-report";
import { code, duration, escapeHtml, linkable } from "./report";

/** The history branch of one repository, as read by the dashboard. */
export interface DashboardRepository {
  /** `owner/repo`, or the URL it was given as. */
  name: string;
  /** Link to the repository. */
  url: string;
  /** Its suites, by key. */
  suites: { key: string; history: History }[];
  /** Why its history could not be read. */
  error?: string;
}

export interface DashboardRow extends UnreliableTest {
  repository: DashboardRepository;
  key: string;
}

export interface DashboardContext extends PageContext {
  title: string;
  /** Rows listed on the page, the costliest first. */
  limit: number;
}

/** Every unreliable test of every repository, the costliest first. */
export function dashboardRows(repositories: DashboardRepository[], context: PageContext): DashboardRow[] {
  const rows = repositories.flatMap((repository) =>
    repository.suites.flatMap(({ key, history }) => unreliableTests(history, context).map((row) => ({ ...row, repository, key }))),
  );
  return sortByCost(rows);
}

/** A page ranking the unreliable tests of several repositories together, with a table of repositories. */
export function renderDashboard(repositories: DashboardRepository[], context: DashboardContext): string {
  const rows = dashboardRows(repositories, context);
  const total = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const flaky = repositories.reduce(
    (sum, repository) => sum + repository.suites.reduce((count, suite) => count + rankFlakyTests(suite.history, context.now, context.evidenceTtlDays, Infinity).length, 0),
    0,
  );
  const costing = total > 0 ? ` Their failures and retries cost about ${duration(total)} of test time.` : "";
  const body = [
    `<h1>${escapeHtml(context.title)}</h1>`,
    `<p class="lede">${countRepositories(repositories.length)}, ${plural(rows.length, "unreliable test")}, ${plural(flaky, "known or probably flaky test")}.${costing} Updated ${formatTime(context.now.toISOString())}.</p>`,
    `<div class="scroll"><table>`,
    `<thead><tr><th>Repository</th><th>Suites</th><th>Remembered runs</th><th>Unreliable tests</th><th>Estimated cost</th></tr></thead>`,
    `<tbody>`,
    ...repositories.map((repository) => repositoryRow(repository, rows)),
    `</tbody></table></div>`,
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
      ...listed.map((row) =>
        renderRow(row.id, row.test, row.stats, row.cost, [
          `<a href="${escapeAttribute(row.repository.url)}">${escapeHtml(row.repository.name)}</a>`,
          `<code>${escapeHtml(row.key)}</code>`,
        ]),
      ),
      `</tbody></table></div>`,
      `<p class="legend"><i class="p"></i> passed <i class="r"></i> passed after a retry <i class="f"></i> failed</p>`,
    );
  }
  return page(context.title, body, "rewritten on every run of the dashboard");
}

/** Links a repository in Markdown, as text when its address is not one a browser opens as a page. */
function mdLink(url: string, text: string): string {
  const safe = linkable(url);
  return safe ? `[${text}](${safe})` : text;
}

/** The costliest unreliable tests as Markdown, for the job summary. */
export function renderDashboardSummary(repositories: DashboardRepository[], context: DashboardContext, limit = 10): string {
  const rows = dashboardRows(repositories, context);
  const lines = [`### ${escapeHtml(context.title)}`, "", `${plural(rows.length, "unreliable test")} in ${countRepositories(repositories.length)}.`, ""];
  for (const repository of repositories.filter((candidate) => candidate.error)) {
    lines.push(`⚠️ **${escapeHtml(repository.name)}:** ${escapeHtml(repository.error!)}`, "");
  }
  if (rows.length > 0) {
    lines.push("| Repository | Test | Failed runs | Passed on retry | Estimated cost |", "|---|---|--:|--:|--:|");
    for (const row of rows.slice(0, limit)) {
      lines.push(
        `| ${mdLink(row.repository.url, escapeHtml(row.repository.name))} | ${code(row.id)} | ${row.stats.failures} / ${row.stats.runs} | ${row.stats.retries} | ${row.cost === undefined ? "" : duration(row.cost)} |`,
      );
    }
  }
  return lines.join("\n");
}

function repositoryRow(repository: DashboardRepository, rows: DashboardRow[]): string {
  const link = `<a href="${escapeAttribute(repository.url)}">${escapeHtml(repository.name)}</a>`;
  if (repository.error) return `<tr><td>${link}</td><td colspan="4">${escapeHtml(repository.error)}</td></tr>`;
  const own = rows.filter((row) => row.repository === repository);
  const cost = own.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const runs = Math.max(0, ...repository.suites.map((suite) => suite.history.runs));
  return [
    `<tr><td>${link}</td>`,
    `<td>${repository.suites.map((suite) => `<code>${escapeHtml(suite.key)}</code>`).join(" ")}</td>`,
    `<td class="number">${runs}</td>`,
    `<td class="number">${own.length}</td>`,
    `<td class="number">${cost > 0 ? duration(cost) : ""}</td></tr>`,
  ].join("");
}

function countRepositories(n: number): string {
  return `${n} ${n === 1 ? "repository" : "repositories"}`;
}
