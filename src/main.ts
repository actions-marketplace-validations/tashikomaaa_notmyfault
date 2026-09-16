import { statSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ActionIO } from "./actions";
import {
  analyze,
  blockingFailures,
  rankFlakyTests,
  rankSlowTests,
  type Analysis,
  type FailureVerdict,
  type Verdict,
} from "./analyze";
import { readContext, runUrl, type RunContext } from "./context";
import { GitStore } from "./git-store";
import { FLAKY_LABEL, planFlakyIssues } from "./flaky-issues";
import { GitHubApiError, GitHubClient } from "./github";
import { emptyHistory, parseHistory, recordRun, serializeHistory, type History } from "./history";
import { combineReports, parseJUnit, type TestResult } from "./junit";
import { locate } from "./locate";
import {
  commentMarker,
  duration,
  plainExplanation,
  renderSuitesComment,
  renderSuitesSummary,
  type Mode,
  type ReportContext,
  type SuiteReport,
} from "./report";

const EVIDENCE_TTL_DAYS = 30;
const RETENTION_DAYS = 90;
const RANKING_SIZE = 10;
/** GitHub shows 10 annotations of each level per step. */
const MAX_ANNOTATIONS_PER_LEVEL = 10;
const VERDICTS: readonly Verdict[] = ["new", "suspect", "broken", "flaky"];

const BRANCH_README = `# notmyfault history

This branch is maintained by the [notmyfault](https://github.com/tashikomaaa/notmyfault) GitHub Action.
It stores the recent outcome of each test, so failures can be told apart: new, flaky or already broken.

The branch is rewritten as a single commit on every update. Deleting it simply resets the history.
`;

export interface SuiteSettings {
  /** Name of the suite in the history. */
  key: string;
  patterns: string[];
}

export interface Settings {
  suites: SuiteSettings[];
  mode: Mode;
  tolerated: Set<Verdict>;
  token: string;
  branch: string;
  trackedBranches: string[];
  /** Identifies the pull request comment: the key of the suite, or of every suite joined with "+". */
  commentKey: string;
  comment: boolean;
  annotations: boolean;
  flakyIssues: boolean;
  record: boolean;
  window: number;
}

/** Runs the action and resolves to the process exit code. */
export async function run(env: NodeJS.ProcessEnv = process.env, io = new ActionIO(env), now = new Date()): Promise<number> {
  try {
    const context = readContext(env);
    const settings = readSettings(io, context);
    io.mask(settings.token);

    const loaded: LoadedSuite[] = [];
    for (const suite of settings.suites) {
      const results = await loadResults(suite, settings.suites.length > 1, context.workspace, io);
      if (!results) return 1;
      loaded.push({ ...suite, results });
    }

    const store = new GitStore({
      remoteUrl: `${context.serverUrl}/${context.repository}.git`,
      branch: settings.branch,
      token: settings.token,
      tempDir: context.tempDir,
    });
    try {
      return await evaluate(loaded, context, settings, store, io, now);
    } finally {
      await store.dispose();
    }
  } catch (error) {
    io.error(errorMessage(error));
    return 1;
  }
}

interface LoadedSuite extends SuiteSettings {
  results: TestResult[];
}

interface Suite extends LoadedSuite {
  history: History;
  analysis: Analysis;
}

async function evaluate(
  loaded: LoadedSuite[],
  context: RunContext,
  settings: Settings,
  store: GitStore,
  io: ActionIO,
  now: Date,
): Promise<number> {
  const suites: Suite[] = [];
  for (const suite of loaded) {
    const history = await loadHistory(store, historyPath(suite.key), settings, io);
    suites.push({ ...suite, history, analysis: analyze(suite.results, history, now, EVIDENCE_TTL_DAYS) });
  }
  const named = suites.length > 1;
  const sum = (count: (analysis: Analysis) => number) => suites.reduce((total, suite) => total + count(suite.analysis), 0);
  const failures = suites.flatMap((suite) => suite.analysis.failures);
  const blocking = suites.flatMap((suite) => blockingFailures(suite.analysis, settings.tolerated));
  const reportContext: ReportContext = {
    key: settings.commentKey,
    trackedBranches: settings.trackedBranches,
    historyRuns: suites[0]!.history.runs,
    mode: settings.mode,
    tolerated: settings.tolerated,
    blocking: blocking.length,
  };
  const url = runUrl(context);
  if (url) reportContext.runUrl = url;

  for (const { key, analysis } of suites) {
    io.group(
      `notmyfault${named ? ` ${key}` : ""}: ${analysis.failures.length} failed, ${analysis.retried.length} retried, ${analysis.fixed.length} fixed, ${analysis.total} total`,
    );
    for (const failure of analysis.failures) {
      const reason = failure.usually ? ` (${failure.usually} on ${settings.trackedBranches.join(", ")}, but with a new error)` : "";
      io.info(`${failure.verdict.padEnd(8)} ${failure.test.title}${reason}`);
    }
    for (const test of analysis.retried) io.info(`retried  ${test.title}`);
    for (const fixed of analysis.fixed) io.info(`fixed    ${fixed.test.title}`);
    for (const slow of analysis.slower) io.info(`slower   ${slow.test.title} (${duration(slow.duration)}, usually ${duration(slow.usual)})`);
    io.endGroup();
  }

  if (settings.annotations) annotate(failures, reportContext, context.workspace, io);
  if (settings.record) {
    for (const suite of suites) await recordHistory(store, suite.key, suite.results, context, settings, io, now);
  }
  if (settings.flakyIssues && isTracked(context, settings) && !context.pullRequest?.fromFork) {
    await manageFlakyIssues(suites, context, settings, reportContext.runUrl, io, now);
  }

  const reports: SuiteReport[] = suites.map((suite) => ({
    name: suite.key,
    analysis: suite.analysis,
    historyRuns: suite.history.runs,
    ranking: rankFlakyTests(suite.history, now, EVIDENCE_TTL_DAYS, RANKING_SIZE),
    slowest: rankSlowTests(suite.history, RANKING_SIZE),
  }));
  io.appendSummary(renderSuitesSummary(reports, reportContext));
  if (settings.comment && context.pullRequest) {
    const noteworthy = sum((a) => a.failures.length + a.retried.length + a.fixed.length) > 0;
    await comment(context, settings, renderSuitesComment(reports, reportContext), noteworthy, io);
  }

  const count = (verdicts: Verdict[]) => failures.filter((f) => verdicts.includes(f.verdict)).length;
  io.setOutput("total", sum((a) => a.total));
  io.setOutput("failed", failures.length);
  io.setOutput("new-failures", count(["new", "suspect"]));
  io.setOutput("flaky-failures", count(["flaky"]));
  io.setOutput("broken-failures", count(["broken"]));
  io.setOutput("retried", sum((a) => a.retried.length));
  io.setOutput("fixed", sum((a) => a.fixed.length));
  io.setOutput("slower", sum((a) => a.slower.length));
  io.setOutput("blocking", blocking.length);

  if (settings.mode === "quarantine" && blocking.length > 0) {
    const names = blocking.slice(0, 5).map((f) => f.test.title).join(", ");
    io.error(`${blocking.length} failing test(s) are not tolerated in quarantine mode: ${names}`);
    return 1;
  }
  return 0;
}

export function readSettings(io: ActionIO, context: RunContext): Settings {
  const suites = readSuites(io, `${context.workflow}-${context.job}`);

  const mode = io.input("mode", "report");
  if (mode !== "report" && mode !== "quarantine") {
    throw new Error(`Input "mode" must be "report" or "quarantine", got "${mode}"`);
  }

  const tolerated = new Set<Verdict>();
  for (const value of splitList(io.input("tolerate", "flaky"))) {
    if (!VERDICTS.includes(value as Verdict)) {
      throw new Error(`Input "tolerate" accepts ${VERDICTS.join(", ")}; got "${value}"`);
    }
    tolerated.add(value as Verdict);
  }

  const token = io.input("token");
  if (!token) throw new Error('Input "token" is empty. Pass `token: ${{ github.token }}`.');

  return {
    suites,
    mode,
    tolerated,
    token,
    branch: io.input("history-branch", "notmyfault-history"),
    trackedBranches: splitList(io.input("track-branches", context.defaultBranch ?? "main")),
    commentKey: suites.map((suite) => suite.key).join("+"),
    comment: io.booleanInput("comment", true),
    annotations: io.booleanInput("annotations", true),
    flakyIssues: io.booleanInput("flaky-issues", false),
    record: io.booleanInput("record", true),
    window: io.integerInput("window", 50, 5),
  };
}

/** Either one suite from "junit" and "key", or several, one "name: glob" per line of "suites". */
function readSuites(io: ActionIO, defaultKey: string): SuiteSettings[] {
  const list = io.input("suites");
  if (!list) {
    const patterns = splitList(io.input("junit"));
    if (patterns.length === 0) {
      throw new Error('Input "junit" is required: a glob matching your JUnit XML reports. Or list several suites in "suites".');
    }
    return [{ key: sanitizeKey(io.input("key", defaultKey)), patterns }];
  }
  if (io.input("junit") || io.input("key")) {
    throw new Error('Inputs "junit" and "key" cannot be used with "suites": name each suite and its reports in "suites".');
  }
  const suites: SuiteSettings[] = [];
  for (const line of list.split("\n").map((part) => part.trim()).filter(Boolean)) {
    const match = /^([^:]+):(.*)$/.exec(line);
    const patterns = splitList(match?.[2] ?? "");
    if (!match || patterns.length === 0) throw new Error(`Input "suites" expects one "name: glob" per line, got "${line}"`);
    const key = sanitizeKey(match[1]!);
    if (suites.some((suite) => suite.key === key)) throw new Error(`Input "suites" names the suite "${key}" twice.`);
    suites.push({ key, patterns });
  }
  return suites;
}

export function sanitizeKey(key: string): string {
  return (
    key
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "default"
  );
}

async function loadResults(
  suite: SuiteSettings,
  named: boolean,
  workspace: string,
  io: ActionIO,
): Promise<TestResult[] | undefined> {
  const of = named ? ` for ${suite.key}` : "";
  const files = await findFiles(suite.patterns, workspace);
  if (files.length === 0) {
    io.error(`No JUnit report matched ${suite.patterns.map((p) => `"${p}"`).join(", ")}${of} in ${workspace}.`);
    return undefined;
  }

  const reports: TestResult[][] = [];
  for (const file of files) {
    try {
      reports.push(parseJUnit(await readFile(file, "utf8")));
    } catch (error) {
      io.warning(`Skipping ${relative(workspace, file)}: ${errorMessage(error)}`);
    }
  }
  const results = combineReports(reports);
  if (results.length === 0) {
    io.error(`The ${files.length} matched report(s)${of} contain no test cases.`);
    return undefined;
  }
  io.info(`Read ${results.length} tests from ${files.length} report(s)${of}.`);
  return results;
}

export async function findFiles(patterns: string[], workspace: string): Promise<string[]> {
  const found = new Set<string>();
  for (const pattern of patterns) {
    const cwd = isAbsolute(pattern) ? undefined : workspace;
    for await (const entry of glob(pattern, {
      ...(cwd ? { cwd } : {}),
      exclude: (path: string) => /(^|[\\/])(node_modules|\.git)$/.test(path),
    })) {
      found.add(cwd ? resolve(cwd, entry) : entry);
    }
  }
  return [...found].sort();
}

/** Annotates each failed test the report locates in the workspace, most actionable verdicts first. */
function annotate(failures: FailureVerdict[], context: ReportContext, workspace: string, io: ActionIO): void {
  const isFile = (path: string) => statSync(join(workspace, path), { throwIfNoEntry: false })?.isFile() ?? false;
  const emitted = { error: 0, notice: 0 };
  for (const failure of failures) {
    const level = failure.verdict === "new" || failure.verdict === "suspect" ? "error" : "notice";
    if (emitted[level] === MAX_ANNOTATIONS_PER_LEVEL) continue;
    const location = locate(failure.test, workspace, isFile);
    if (!location) continue;
    const message = [plainExplanation(failure, context), failure.test.message].filter(Boolean).join("\n");
    io.annotation(level, message, { file: location.file, line: location.line, title: failure.test.title });
    emitted[level]++;
  }
}

async function loadHistory(store: GitStore, path: string, settings: Settings, io: ActionIO): Promise<History> {
  try {
    return parseHistory(await store.read(path));
  } catch (error) {
    io.warning(`Could not read history from branch "${settings.branch}", continuing without it. ${errorMessage(error)}`);
    return emptyHistory();
  }
}

function historyPath(key: string): string {
  return `history/${key}.json`;
}

async function recordHistory(
  store: GitStore,
  key: string,
  results: TestResult[],
  context: RunContext,
  settings: Settings,
  io: ActionIO,
  now: Date,
): Promise<void> {
  if (context.pullRequest?.fromFork) {
    io.info("Pull request from a fork: the token is read-only, history is not recorded.");
    return;
  }
  const tracked = isTracked(context, settings);

  try {
    const pushed = await store.update(
      historyPath(key),
      (current) => {
        const history = parseHistory(current);
        const changed = recordRun(history, results, {
          sha: context.sha,
          tracked,
          now,
          window: settings.window,
          retentionDays: RETENTION_DAYS,
        });
        return changed ? serializeHistory(history) : undefined;
      },
      {
        message: `Record ${key} (run ${context.runId || "local"}, attempt ${context.runAttempt})`,
        extraFiles: { "README.md": BRANCH_README },
      },
    );
    io.info(pushed ? `History updated on branch "${settings.branch}".` : "Nothing new to record.");
  } catch (error) {
    io.warning(
      `Could not record history on branch "${settings.branch}". Does the job have "contents: write" permission? ${errorMessage(error)}`,
    );
  }
}

/** Whether the run happened on a tracked branch, whose runs build the history. */
function isTracked(context: RunContext, settings: Settings): boolean {
  return (
    !context.eventName.startsWith("pull_request") &&
    context.ref === `refs/heads/${context.refName}` &&
    settings.trackedBranches.includes(context.refName)
  );
}

/** Opens, updates and closes an issue per flaky test, from the history including this run. */
async function manageFlakyIssues(
  suites: Suite[],
  context: RunContext,
  settings: Settings,
  runUrl: string | undefined,
  io: ActionIO,
  now: Date,
): Promise<void> {
  const client = new GitHubClient(settings.token, context.apiUrl, context.repository);
  try {
    const after = suites.map((suite) => {
      const history = structuredClone(suite.history);
      recordRun(history, suite.results, { sha: context.sha, tracked: true, now, window: settings.window, retentionDays: RETENTION_DAYS });
      return { key: suite.key, history, results: suite.results };
    });
    const { actions, postponed } = planFlakyIssues(after, await client.listIssues(FLAKY_LABEL.name), {
      trackedBranches: settings.trackedBranches,
      now,
      evidenceTtlDays: EVIDENCE_TTL_DAYS,
      sha: context.sha,
      ...(runUrl ? { runUrl } : {}),
    });
    if (actions.some((action) => action.kind === "create")) {
      await client.ensureLabel(FLAKY_LABEL.name, FLAKY_LABEL.color, FLAKY_LABEL.description);
    }
    const done = { created: 0, updated: 0, closed: 0 };
    for (const action of actions) {
      if (action.kind === "create") {
        await client.createIssue(action.title, action.body, [FLAKY_LABEL.name]);
        done.created++;
      } else if (action.kind === "update") {
        await client.updateIssue(action.issue, { body: action.body, ...(action.reopen ? { state: "open" as const } : {}) });
        done.updated++;
      } else {
        await client.addComment(action.issue, action.comment);
        await client.updateIssue(action.issue, { state: "closed" });
        done.closed++;
      }
    }
    const later = postponed > 0 ? ` ${postponed} more flaky test(s) will get an issue on the next runs.` : "";
    io.info(`Flaky test issues: ${done.created} created, ${done.updated} updated, ${done.closed} closed.${later}`);
  } catch (error) {
    const hint = error instanceof GitHubApiError && error.status === 403 ? ' Does the job have "issues: write" permission?' : "";
    io.warning(`Could not update flaky test issues.${hint} ${errorMessage(error)}`);
  }
}

async function comment(context: RunContext, settings: Settings, body: string, create: boolean, io: ActionIO): Promise<void> {
  const pullRequest = context.pullRequest;
  if (!pullRequest) return;
  const client = new GitHubClient(settings.token, context.apiUrl, context.repository);
  try {
    const result = await client.upsertComment(pullRequest.number, commentMarker(settings.commentKey), body, create);
    if (result !== "skipped") io.info(`Pull request comment ${result}.`);
  } catch (error) {
    const hint =
      error instanceof GitHubApiError && error.status === 403
        ? pullRequest.fromFork
          ? " Tokens are read-only on pull requests from forks; the job summary has the full report."
          : ' Does the job have "pull-requests: write" permission?'
        : "";
    io.warning(`Could not comment on the pull request.${hint} ${errorMessage(error)}`);
  }
}

function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
