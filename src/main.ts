import { statSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ActionIO } from "./github/io";
import { githubPlatform } from "./github/platform";
import {
  analyze,
  blockingFailures,
  rankFlakyTests,
  rankSlowTests,
  failureTrends,
  type Analysis,
  type FailureVerdict,
  type Verdict,
} from "./analyze";
import { ApiError, type Io, type Platform, type RunContext } from "./platform";
import { GitStore } from "./git-store";
import { badgePath, renderBadge } from "./badge";
import { renderIndexPage, renderSuitePage, reportPath } from "./html-report";
import { FLAKY_LABEL, planFlakyIssues } from "./flaky-issues";
import { applyQuarantine, isActive, parseQuarantine, type QuarantineEntry } from "./quarantine";
import { applyRenames, detectRenames, type Rename } from "./renames";
import { emptyHistory, FAIL, parseHistory, recordRun, serializeHistory, type History, type RecordOptions } from "./history";
import { combineReports, parseJUnit, type TestResult } from "./junit";
import { locate } from "./locate";
import {
  commentMarker,
  duration,
  plainExplanation,
  quarantineNote,
  renderCheck,
  renderSuitesComment,
  renderSuitesSummary,
  type Mode,
  type ReportContext,
  type SuiteReport,
} from "./report";

const EVIDENCE_TTL_DAYS = 30;
const RETENTION_DAYS = 90;
const RANKING_SIZE = 10;
/** Unreliable tests charted in the job summary. */
const TRENDS = 3;
/** GitHub shows 10 annotations of each level per step. */
const MAX_ANNOTATIONS_PER_LEVEL = 10;
/** Title of the notice telling a companion workflow that re-running the failed jobs is worth it. */
export const RERUN_MARKER = "notmyfault: only flaky tests failed";
const VERDICTS: readonly Verdict[] = ["new", "suspect", "broken", "flaky"];

const BRANCH_README = `# notmyfault history

This branch is maintained by [notmyfault](https://github.com/tashikomaaa/notmyfault).
It stores the recent outcome of each test, so failures can be told apart: new, flaky or already broken.

- \`history/<key>.json\`: the history of a test suite.
- \`badges/<key>.json\`: a [shields.io endpoint](https://shields.io/badges/endpoint-badge) counting its flaky tests.
- \`reports/<key>.html\` and \`index.html\`: pages listing its unreliable tests, to publish as a static site.

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
  /** Tests quarantined by hand, expired entries included. */
  quarantine: QuarantineEntry[];
  token: string;
  branch: string;
  trackedBranches: string[];
  /** Identifies the pull request comment: the key of the suite, or of every suite joined with "+". */
  commentKey: string;
  comment: boolean;
  annotations: boolean;
  flakyIssues: boolean;
  missingTests: boolean;
  /** Name of the check to report the run as, if any. */
  check?: string;
  rerunFlaky: boolean;
  record: boolean;
  window: number;
}

/** Runs the GitHub Action and resolves to the process exit code. */
export async function run(env: NodeJS.ProcessEnv = process.env, io: Io = new ActionIO(env), now = new Date()): Promise<number> {
  let platform: Platform;
  try {
    platform = githubPlatform(env, io);
  } catch (error) {
    io.error(errorMessage(error));
    return 1;
  }
  return runOn(platform, now);
}

/** Runs notmyfault on a platform and resolves to the process exit code. */
export async function runOn(platform: Platform, now = new Date()): Promise<number> {
  const { context, io } = platform;
  try {
    const settings = readSettings(platform);
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
      username: platform.gitUser(settings.token),
      author: platform.gitAuthor,
      pushOptions: platform.pushOptions,
      ...(context.tempDir ? { tempDir: context.tempDir } : {}),
    });
    try {
      return await evaluate(loaded, platform, settings, store, now);
    } finally {
      await store.dispose();
    }
  } catch (error) {
    io.error(errorMessage(error));
    return 1;
  } finally {
    io.finish();
  }
}

interface LoadedSuite extends SuiteSettings {
  results: TestResult[];
}

interface Suite extends LoadedSuite {
  history: History;
  analysis: Analysis;
  /** Tests renamed in this run, already applied to the history. */
  renames: Rename[];
}

async function evaluate(loaded: LoadedSuite[], platform: Platform, settings: Settings, store: GitStore, now: Date): Promise<number> {
  const { context, io } = platform;
  const suites: Suite[] = [];
  const tracked = isTracked(context, settings);
  for (const suite of loaded) {
    const history = await loadHistory(store, historyPath(suite.key), settings, io);
    // On tracked branches, a renamed test keeps its history in this very run, or its failure would look new.
    const renames = tracked ? detectRenames(history, suite.results) : [];
    applyRenames(history, renames);
    const analysis = analyze(suite.results, history, now, EVIDENCE_TTL_DAYS);
    if (!settings.missingTests) analysis.missing = [];
    suites.push({ ...suite, history, renames, analysis });
  }
  const named = suites.length > 1;
  for (const entry of settings.quarantine.filter((candidate) => !isActive(candidate, now))) {
    io.warning(
      `The quarantine of "${entry.pattern}" expired on ${entry.until}: remove it, or push the date back if the test is still unreliable.`,
    );
  }
  const quarantined = suites.reduce((total, suite) => total + applyQuarantine(suite.analysis, settings.quarantine, now), 0);
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
    quarantined,
    runLink: platform.text.runLink,
    ...(context.runUrl ? { runUrl: context.runUrl } : {}),
  };

  for (const { key, analysis } of suites) {
    io.group(
      `notmyfault${named ? ` ${key}` : ""}: ${analysis.failures.length} failed, ${analysis.retried.length} retried, ${analysis.fixed.length} fixed, ${analysis.total} total`,
    );
    for (const failure of analysis.failures) {
      const reason = failure.usually ? ` (${failure.usually} on ${settings.trackedBranches.join(", ")}, but with a new error)` : "";
      const byHand = failure.quarantined ? ` (quarantined until ${failure.quarantined.until})` : "";
      const since =
        failure.verdict === "broken" && failure.failingSince ? ` (failing since ${failure.failingSince.sha.slice(0, 7)})` : "";
      io.info(`${failure.verdict.padEnd(8)} ${failure.test.title}${since}${reason}${byHand}`);
    }
    for (const test of analysis.retried) io.info(`retried  ${test.title}`);
    for (const fixed of analysis.fixed) io.info(`fixed    ${fixed.test.title}`);
    for (const slow of analysis.slower) io.info(`slower   ${slow.test.title} (${duration(slow.duration)}, usually ${duration(slow.usual)})`);
    for (const group of analysis.missing) {
      if (group.whole && group.group && group.ids.length > 1) io.info(`missing  ${group.group} (all ${group.ids.length} tests)`);
      else for (const id of group.ids) io.info(`missing  ${id}`);
    }
    io.endGroup();
  }

  // Emitted first, so that the limit on notices never drops it.
  const onlyFlaky = platform.rerunNotice && failures.length > 0 && failures.every((failure) => failure.verdict === "flaky");
  if (onlyFlaky) {
    io.annotation(
      "notice",
      "Every failed test is known or probably flaky: re-running the failed jobs can prove it and unblock this run.",
      { title: RERUN_MARKER },
    );
  }
  if (settings.annotations) annotate(failures, reportContext, context.workspace, io, onlyFlaky ? 1 : 0);
  if (settings.record) {
    const commit = tracked && !context.pullRequest?.fromFork ? await describeCommit(suites, platform, settings) : undefined;
    for (const suite of suites) await recordHistory(store, suite.key, suite.results, platform, settings, now, commit);
  }
  for (const { renames } of suites) for (const { from, to } of renames) io.info(`renamed  ${from} → ${to}`);
  if (settings.flakyIssues && isTracked(context, settings) && !context.pullRequest?.fromFork) {
    await manageFlakyIssues(suites, platform, settings, now);
  }

  if (settings.rerunFlaky && rerunWorthIt(failures, blocking, settings)) {
    const url = await rerun(platform, settings);
    if (url) reportContext.rerunUrl = url;
  }

  const reports: SuiteReport[] = suites.map((suite) => {
    const ranking = rankFlakyTests(suite.history, now, EVIDENCE_TTL_DAYS, RANKING_SIZE);
    return {
      name: suite.key,
      analysis: suite.analysis,
      historyRuns: suite.history.runs,
      ranking,
      slowest: rankSlowTests(suite.history, RANKING_SIZE),
      trends: failureTrends(suite.history, ranking.slice(0, TRENDS).map((test) => test.id)),
      renames: suite.renames,
    };
  });
  io.appendSummary(renderSuitesSummary(reports, reportContext));
  if (settings.comment && context.pullRequest) {
    const noteworthy = sum((a) => a.failures.length + a.retried.length + a.fixed.length + a.missing.length) > 0;
    await comment(platform, settings, renderSuitesComment(reports, reportContext), noteworthy);
  }
  if (settings.check) await reportCheck(settings.check, platform, settings, renderCheck(reports, reportContext), blocking.length === 0);

  const count = (verdicts: Verdict[]) => failures.filter((f) => verdicts.includes(f.verdict)).length;
  io.setOutput("total", sum((a) => a.total));
  io.setOutput("failed", failures.length);
  io.setOutput("new-failures", count(["new", "suspect"]));
  io.setOutput("flaky-failures", count(["flaky"]));
  io.setOutput("broken-failures", count(["broken"]));
  io.setOutput("retried", sum((a) => a.retried.length));
  io.setOutput("fixed", sum((a) => a.fixed.length));
  io.setOutput("slower", sum((a) => a.slower.length));
  io.setOutput("missing", sum((a) => a.missing.reduce((total, group) => total + group.ids.length, 0)));
  io.setOutput("quarantined", quarantined);
  io.setOutput("blocking", blocking.length);

  if (settings.mode === "quarantine" && blocking.length > 0) {
    const names = blocking.slice(0, 5).map((f) => f.test.title).join(", ");
    io.error(`${blocking.length} failing test(s) are not tolerated in quarantine mode: ${names}`);
    return 1;
  }
  return 0;
}

export function readSettings(platform: Platform): Settings {
  const { context, io } = platform;
  const suites = readSuites(io, context.defaultKey);

  const mode = io.input("mode", "report");
  if (mode !== "report" && mode !== "quarantine") {
    throw new Error(`${io.describeInput("mode")} must be "report" or "quarantine", got "${mode}"`);
  }

  const tolerated = new Set<Verdict>();
  for (const value of splitList(io.input("tolerate", "flaky"))) {
    if (!VERDICTS.includes(value as Verdict)) {
      throw new Error(`${io.describeInput("tolerate")} accepts ${VERDICTS.join(", ")}; got "${value}"`);
    }
    tolerated.add(value as Verdict);
  }
  const quarantine = parseQuarantine(io.input("quarantine"), io.describeInput("quarantine"));

  const token = io.input("token") || context.defaultToken;
  if (!token) throw new Error(platform.text.tokenMissing);

  return {
    suites,
    mode,
    tolerated,
    quarantine,
    token,
    branch: io.input("history-branch", "notmyfault-history"),
    trackedBranches: splitList(io.input("track-branches", context.defaultBranch ?? "main")),
    commentKey: suites.map((suite) => suite.key).join("+"),
    comment: io.booleanInput("comment", true),
    annotations: io.booleanInput("annotations", true),
    flakyIssues: io.booleanInput("flaky-issues", false),
    missingTests: io.booleanInput("missing-tests", true),
    ...(io.booleanInput("check", false) ? { check: io.input("check-name", "notmyfault") } : {}),
    rerunFlaky: io.booleanInput("rerun-flaky", false),
    record: io.booleanInput("record", true),
    window: io.integerInput("window", 50, 5),
  };
}

/** Either one suite from "junit" and "key", or several, one "name: glob" per line of "suites". */
function readSuites(io: Io, defaultKey: string): SuiteSettings[] {
  const list = io.input("suites");
  if (!list) {
    const patterns = splitList(io.input("junit"));
    if (patterns.length === 0) {
      throw new Error(
        `${io.describeInput("junit")} is required: a glob matching your JUnit XML reports. Or list several suites in ${io.inputName("suites")}.`,
      );
    }
    return [{ key: sanitizeKey(io.input("key", defaultKey)), patterns }];
  }
  if (io.input("junit") || io.input("key")) {
    throw new Error(
      `${io.describeInputs(["junit", "key"])} cannot be used with ${io.inputName("suites")}: name each suite and its reports in ${io.inputName("suites")}.`,
    );
  }
  const suites: SuiteSettings[] = [];
  for (const line of list.split("\n").map((part) => part.trim()).filter(Boolean)) {
    const match = /^([^:]+):(.*)$/.exec(line);
    const patterns = splitList(match?.[2] ?? "");
    if (!match || patterns.length === 0) throw new Error(`${io.describeInput("suites")} expects one "name: glob" per line, got "${line}"`);
    const key = sanitizeKey(match[1]!);
    if (suites.some((suite) => suite.key === key)) throw new Error(`${io.describeInput("suites")} names the suite "${key}" twice.`);
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
  io: Io,
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
function annotate(failures: FailureVerdict[], context: ReportContext, workspace: string, io: Io, noticesAlready: number): void {
  const isFile = (path: string) => statSync(join(workspace, path), { throwIfNoEntry: false })?.isFile() ?? false;
  const emitted = { error: 0, notice: noticesAlready };
  for (const failure of failures) {
    const level = (failure.verdict === "new" || failure.verdict === "suspect") && !failure.quarantined ? "error" : "notice";
    if (emitted[level] === MAX_ANNOTATIONS_PER_LEVEL) continue;
    const location = locate(failure.test, workspace, isFile);
    if (!location) continue;
    const explanation = [plainExplanation(failure, context), failure.quarantined && quarantineNote(failure.quarantined, false)];
    const message = [explanation.filter(Boolean).join(" "), failure.test.message].filter(Boolean).join("\n");
    io.annotation(level, message, { file: location.file, line: location.line, title: failure.test.title });
    emitted[level]++;
  }
}

async function loadHistory(store: GitStore, path: string, settings: Settings, io: Io): Promise<History> {
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
  platform: Platform,
  settings: Settings,
  now: Date,
  commit?: RecordOptions["commit"],
): Promise<void> {
  const { context, io } = platform;
  if (context.pullRequest?.fromFork) {
    io.info(`${capitalize(platform.text.pullRequest)} from a fork: the token is read-only, history is not recorded.`);
    return;
  }
  const tracked = isTracked(context, settings);

  try {
    const pushed = await store.update(
      historyPath(key),
      (current) => {
        const history = parseHistory(current);
        // Only runs on tracked branches follow renames: a pull request must not pass a history on to a new test.
        // Detected again on the latest content, in case another writer changed it since it was read.
        if (tracked) applyRenames(history, detectRenames(history, results));
        const changed = recordRun(history, results, {
          sha: context.sha,
          tracked,
          now,
          window: settings.window,
          retentionDays: RETENTION_DAYS,
          ...(commit ? { commit } : {}),
        });
        return changed ? serializeHistory(history) : undefined;
      },
      {
        message: `Record ${key} (${context.runDescription})`,
        extraFiles: { "README.md": BRANCH_README, ".nojekyll": "" },
        derivedFiles: (content, existingPaths) => {
          const history = parseHistory(content);
          const keys = new Set(existingPaths.flatMap((path) => /^history\/([^/]+)\.json$/.exec(path)?.slice(1) ?? []));
          keys.add(key);
          const pages = { trackedBranches: settings.trackedBranches, now, evidenceTtlDays: EVIDENCE_TTL_DAYS };
          return {
            [badgePath(key)]: renderBadge(history, now, EVIDENCE_TTL_DAYS),
            [reportPath(key)]: renderSuitePage(key, history, pages),
            "index.html": renderIndexPage([...keys].sort(), pages),
          };
        },
      },
    );
    io.info(pushed ? `History updated on branch "${settings.branch}".` : "Nothing new to record.");
  } catch (error) {
    io.warning(`Could not record history on branch "${settings.branch}". ${platform.text.recordDenied} ${errorMessage(error)}`);
  }
}

/** Whether the run happened on a tracked branch, whose runs build the history. */
/**
 * Links to the commit of a tracked run, and to the pull or merge request it came from, remembered by tests that
 * start failing in this run. The API is only asked when one does.
 */
async function describeCommit(suites: Suite[], platform: Platform, settings: Settings): Promise<RecordOptions["commit"]> {
  const { context, io, text } = platform;
  const startsFailing = suites.some((suite) =>
    suite.results.some((result) => result.outcome === "failed" && !suite.history.tests[result.id]?.outcomes.endsWith(FAIL)),
  );
  if (!startsFailing) return undefined;
  const commit: NonNullable<RecordOptions["commit"]> = { url: platform.commitUrl(context.sha) };
  try {
    const change = await platform.forge(settings.token).changeOf(context.sha);
    if (change) commit.change = { ref: `${text.changePrefix}${change.number}`, url: change.url };
  } catch (error) {
    io.info(`Could not tell which ${text.pullRequest} commit ${context.sha.slice(0, 7)} came from: ${errorMessage(error)}`);
  }
  return commit;
}

function isTracked(context: RunContext, settings: Settings): boolean {
  return context.branch !== undefined && settings.trackedBranches.includes(context.branch);
}

/** Opens, updates and closes an issue per flaky test, from the history including this run. */
async function manageFlakyIssues(suites: Suite[], platform: Platform, settings: Settings, now: Date): Promise<void> {
  const { context, io } = platform;
  const runUrl = context.runUrl;
  const client = platform.forge(settings.token);
  try {
    const after = suites.map((suite) => {
      const history = structuredClone(suite.history);
      recordRun(history, suite.results, { sha: context.sha, tracked: true, now, window: settings.window, retentionDays: RETENTION_DAYS });
      return { key: suite.key, history, results: suite.results, renames: suite.renames };
    });
    const { actions, postponed } = planFlakyIssues(after, await client.listIssues(FLAKY_LABEL.name), {
      trackedBranches: settings.trackedBranches,
      now,
      evidenceTtlDays: EVIDENCE_TTL_DAYS,
      sha: context.sha,
      ...(runUrl ? { runUrl } : {}),
      runName: platform.text.runName,
      pullRequest: platform.text.pullRequest,
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
        await client.updateIssue(action.issue, {
          body: action.body,
          ...(action.title ? { title: action.title } : {}),
          ...(action.reopen ? { state: "open" as const } : {}),
        });
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
    const hint = error instanceof ApiError && error.denied ? ` ${platform.text.issuesDenied}` : "";
    io.warning(`Could not update flaky test issues.${hint} ${errorMessage(error)}`);
  }
}

async function comment(platform: Platform, settings: Settings, body: string, create: boolean): Promise<void> {
  const { context, io, text } = platform;
  const pullRequest = context.pullRequest;
  if (!pullRequest) return;
  try {
    const result = await platform.forge(settings.token).upsertComment(pullRequest.number, commentMarker(settings.commentKey), body, create);
    if (result !== "skipped") io.info(`${capitalize(text.pullRequest)} comment ${result}.`);
  } catch (error) {
    const hint =
      error instanceof ApiError && error.denied ? ` ${pullRequest.fromFork ? text.commentFromFork : text.commentDenied}` : "";
    io.warning(`Could not comment on the ${text.pullRequest}.${hint} ${errorMessage(error)}`);
  }
}

/**
 * Whether a new pipeline could turn this one green: flaky tests failed, and nothing else stands in the way. In report
 * mode, the tests fail the pipeline, so every failure must be flaky. In quarantine mode, every failure that blocks.
 */
function rerunWorthIt(failures: FailureVerdict[], blocking: FailureVerdict[], settings: Settings): boolean {
  const flaky = (failure: FailureVerdict) => failure.verdict === "flaky";
  if (settings.mode === "report") return failures.length > 0 && failures.every(flaky);
  return blocking.length > 0 && blocking.every(flaky);
}

async function rerun(platform: Platform, settings: Settings): Promise<string | undefined> {
  const { context, io, text } = platform;
  const forge = platform.forge(settings.token);
  if (!forge.rerun) {
    io.warning(
      `${io.describeInput("rerun-flaky")} is ignored: a job cannot re-run its own workflow run on GitHub. Use a companion workflow instead: https://github.com/tashikomaaa/notmyfault/blob/main/docs/recipes.md#re-run-flaky-failures-automatically`,
    );
    return undefined;
  }
  try {
    const url = await forge.rerun({
      sha: context.sha,
      ...(context.pullRequest ? { mergeRequest: context.pullRequest.number } : context.branch ? { branch: context.branch } : {}),
    });
    io.info(
      url
        ? `Only flaky tests failed: started a new pipeline for this commit, ${url}`
        : "Only flaky tests failed, but this commit already had another pipeline, or moved on: not re-running.",
    );
    return url;
  } catch (error) {
    const hint = error instanceof ApiError && error.denied ? ` ${text.rerunDenied}` : "";
    io.warning(`Could not start a new pipeline.${hint} ${errorMessage(error)}`);
    return undefined;
  }
}

async function reportCheck(
  name: string,
  platform: Platform,
  settings: Settings,
  output: { title: string; summary: string },
  success: boolean,
): Promise<void> {
  const { context, io, text } = platform;
  const forge = platform.forge(settings.token);
  if (!forge.createCheck) {
    io.warning(`${io.describeInput("check")} is ignored: checks only exist on GitHub. The notmyfault job is the check here.`);
    return;
  }
  if (context.pullRequest?.fromFork) {
    io.info(`${capitalize(text.pullRequest)} from a fork: the token is read-only, no check is created.`);
    return;
  }
  try {
    const url = await forge.createCheck({
      name,
      sha: context.pullRequest?.headSha ?? context.sha,
      success,
      ...output,
      ...(context.runUrl ? { detailsUrl: context.runUrl } : {}),
    });
    io.info(`Check "${name}" ${success ? "passed" : "failed"}: ${url}`);
  } catch (error) {
    const hint = error instanceof ApiError && error.denied ? ` ${text.checkDenied}` : "";
    io.warning(`Could not create the check "${name}".${hint} ${errorMessage(error)}`);
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
