import { glob, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ActionIO } from "./actions";
import { analyze, blockingFailures, rankFlakyTests, type Verdict } from "./analyze";
import { readContext, runUrl, type RunContext } from "./context";
import { GitStore } from "./git-store";
import { GitHubApiError, GitHubClient } from "./github";
import { emptyHistory, parseHistory, recordRun, serializeHistory, type History } from "./history";
import { combineReports, parseJUnit, type TestResult } from "./junit";
import { commentMarker, renderComment, renderSummary, type Mode, type ReportContext } from "./report";

const EVIDENCE_TTL_DAYS = 30;
const RETENTION_DAYS = 90;
const RANKING_SIZE = 10;
const VERDICTS: readonly Verdict[] = ["new", "suspect", "broken", "flaky"];

const BRANCH_README = `# notmyfault history

This branch is maintained by the [notmyfault](https://github.com/tashikomaaa/notmyfault) GitHub Action.
It stores the recent outcome of each test, so failures can be told apart: new, flaky or already broken.

The branch is rewritten as a single commit on every update. Deleting it simply resets the history.
`;

export interface Settings {
  patterns: string[];
  mode: Mode;
  tolerated: Set<Verdict>;
  token: string;
  branch: string;
  trackedBranches: string[];
  key: string;
  comment: boolean;
  record: boolean;
  window: number;
}

/** Runs the action and resolves to the process exit code. */
export async function run(env: NodeJS.ProcessEnv = process.env, io = new ActionIO(env), now = new Date()): Promise<number> {
  try {
    const context = readContext(env);
    const settings = readSettings(io, context);
    io.mask(settings.token);

    const results = await loadResults(settings.patterns, context.workspace, io);
    if (!results) return 1;

    const store = new GitStore({
      remoteUrl: `${context.serverUrl}/${context.repository}.git`,
      branch: settings.branch,
      token: settings.token,
      tempDir: context.tempDir,
    });
    try {
      return await evaluate(results, context, settings, store, io, now);
    } finally {
      await store.dispose();
    }
  } catch (error) {
    io.error(errorMessage(error));
    return 1;
  }
}

async function evaluate(
  results: TestResult[],
  context: RunContext,
  settings: Settings,
  store: GitStore,
  io: ActionIO,
  now: Date,
): Promise<number> {
  const historyPath = `history/${settings.key}.json`;
  const history = await loadHistory(store, historyPath, settings, io);

  const analysis = analyze(results, history, now, EVIDENCE_TTL_DAYS);
  const blocking = blockingFailures(analysis, settings.tolerated);
  const reportContext: ReportContext = {
    key: settings.key,
    trackedBranches: settings.trackedBranches,
    historyRuns: history.runs,
    mode: settings.mode,
    tolerated: settings.tolerated,
    blocking: blocking.length,
  };
  const url = runUrl(context);
  if (url) reportContext.runUrl = url;

  io.group(`notmyfault: ${analysis.failures.length} failed, ${analysis.retried.length} retried, ${analysis.total} total`);
  for (const failure of analysis.failures) io.info(`${failure.verdict.padEnd(8)} ${failure.test.title}`);
  for (const test of analysis.retried) io.info(`retried  ${test.title}`);
  io.endGroup();

  if (settings.record) await recordHistory(store, historyPath, results, context, settings, io, now);

  io.appendSummary(renderSummary(analysis, rankFlakyTests(history, now, EVIDENCE_TTL_DAYS, RANKING_SIZE), reportContext));
  if (settings.comment && context.pullRequest) {
    await comment(context, settings, renderComment(analysis, reportContext), analysis.failures.length + analysis.retried.length > 0, io);
  }

  const count = (verdicts: Verdict[]) => analysis.failures.filter((f) => verdicts.includes(f.verdict)).length;
  io.setOutput("total", analysis.total);
  io.setOutput("failed", analysis.failures.length);
  io.setOutput("new-failures", count(["new", "suspect"]));
  io.setOutput("flaky-failures", count(["flaky"]));
  io.setOutput("broken-failures", count(["broken"]));
  io.setOutput("retried", analysis.retried.length);
  io.setOutput("blocking", blocking.length);

  if (settings.mode === "quarantine" && blocking.length > 0) {
    const names = blocking.slice(0, 5).map((f) => f.test.title).join(", ");
    io.error(`${blocking.length} failing test(s) are not tolerated in quarantine mode: ${names}`);
    return 1;
  }
  return 0;
}

export function readSettings(io: ActionIO, context: RunContext): Settings {
  const patterns = splitList(io.input("junit"));
  if (patterns.length === 0) throw new Error('Input "junit" is required: a glob matching your JUnit XML reports.');

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
    patterns,
    mode,
    tolerated,
    token,
    branch: io.input("history-branch", "notmyfault-history"),
    trackedBranches: splitList(io.input("track-branches", context.defaultBranch ?? "main")),
    key: sanitizeKey(io.input("key", `${context.workflow}-${context.job}`)),
    comment: io.booleanInput("comment", true),
    record: io.booleanInput("record", true),
    window: io.integerInput("window", 50, 5),
  };
}

export function sanitizeKey(key: string): string {
  return (
    key
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "default"
  );
}

async function loadResults(patterns: string[], workspace: string, io: ActionIO): Promise<TestResult[] | undefined> {
  const files = await findFiles(patterns, workspace);
  if (files.length === 0) {
    io.error(`No JUnit report matched ${patterns.map((p) => `"${p}"`).join(", ")} in ${workspace}.`);
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
    io.error(`The ${files.length} matched report(s) contain no test cases.`);
    return undefined;
  }
  io.info(`Read ${results.length} tests from ${files.length} report(s).`);
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

async function loadHistory(store: GitStore, path: string, settings: Settings, io: ActionIO): Promise<History> {
  try {
    return parseHistory(await store.read(path));
  } catch (error) {
    io.warning(`Could not read history from branch "${settings.branch}", continuing without it. ${errorMessage(error)}`);
    return emptyHistory();
  }
}

async function recordHistory(
  store: GitStore,
  path: string,
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
  const tracked =
    !context.eventName.startsWith("pull_request") &&
    context.ref === `refs/heads/${context.refName}` &&
    settings.trackedBranches.includes(context.refName);

  try {
    const pushed = await store.update(
      path,
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
        message: `Record ${settings.key} (run ${context.runId || "local"}, attempt ${context.runAttempt})`,
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

async function comment(context: RunContext, settings: Settings, body: string, create: boolean, io: ActionIO): Promise<void> {
  const pullRequest = context.pullRequest;
  if (!pullRequest) return;
  const client = new GitHubClient(settings.token, context.apiUrl, context.repository);
  try {
    const result = await client.upsertComment(pullRequest.number, commentMarker(settings.key), body, create);
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
