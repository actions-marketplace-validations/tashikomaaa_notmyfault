import { createHash } from "node:crypto";
import type { TestResult } from "./junit";

export const HISTORY_VERSION = 1;

/** Outcome codes stored in {@link TestHistory.outcomes}. */
export const PASS = "p";
export const FAIL = "f";
export const RETRY = "r";

export interface FlakyEvidence {
  /** ISO timestamp. */
  at: string;
  /** Commit the evidence was observed on (12-char prefix). */
  sha: string;
  /** retry: passed after a retry within a run. rerun: failed then passed on the same commit. */
  kind: "retry" | "rerun";
}

/** Where the current failure streak of a test on tracked branches started. */
export interface FailingSince {
  /** Commit of the first failed run of the streak (12-char prefix). */
  sha: string;
  /** ISO timestamp of that run. */
  at: string;
  /** Link to the commit. */
  url?: string;
  /** The pull or merge request the commit came from, e.g. { ref: "#42", url }. */
  change?: { ref: string; url: string };
}

export interface TestHistory {
  /** Outcomes on tracked branches, oldest first, one char per run (p, f or r). */
  outcomes: string;
  /** Recent commits (12-char prefixes) the test failed on, on any branch. */
  failedOn?: string[];
  /** Proof that the test is flaky, newest last. */
  evidence?: FlakyEvidence[];
  /** Fingerprints of the failure messages seen on tracked branches, newest last. */
  errors?: string[];
  /** Last day (YYYY-MM-DD) the test failed, or passed only after a retry, on a tracked branch. */
  lastFailure?: string;
  /** Set while the test keeps failing on tracked branches: where the streak started. */
  failingSince?: FailingSince;
  /** Durations in milliseconds of the last runs on tracked branches, oldest first. */
  durations?: number[];
  /** Number of the last run on a tracked branch the test was part of, see {@link History.runs}. */
  lastRun?: number;
  /** Last day (YYYY-MM-DD) the test was recorded. */
  lastSeen: string;
}

export interface History {
  version: typeof HISTORY_VERSION;
  updatedAt: string;
  /** Number of tracked-branch runs recorded so far. */
  runs: number;
  /** Total duration in milliseconds of the tests of the last runs on tracked branches, oldest first. */
  runDurations?: number[];
  tests: Record<string, TestHistory>;
}

export interface RecordOptions {
  /** Commit the tests ran on. */
  sha: string;
  /** Whether the run happened on a tracked branch (e.g. main). */
  tracked: boolean;
  now: Date;
  /** Number of outcomes kept per test. */
  window: number;
  /** Tests not seen for this many days are forgotten. */
  retentionDays: number;
  /** Links to the commit and to the change it came from, kept when a test starts failing. */
  commit?: { url?: string; change?: { ref: string; url: string } };
}

export const MAX_FAILED_ON = 20;
export const MAX_EVIDENCE = 10;
const MAX_ERRORS = 10;
const MAX_OUTCOMES = 500;
const MAX_REF_LENGTH = 40;
const MAX_URL_LENGTH = 2048;
/** Tests remembered per suite: a crafted report must not grow the branch without bound. */
export const MAX_TESTS = 20_000;
export const MAX_DURATIONS = 10;
const MAX_FINGERPRINTED_LENGTH = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyHistory(): History {
  // Without a prototype, a test named __proto__ or constructor is a key like any other.
  return { version: HISTORY_VERSION, updatedAt: new Date(0).toISOString(), runs: 0, tests: Object.create(null) as History["tests"] };
}

/**
 * Identifies a failure message regardless of what changes from run to run:
 * case, spacing, numbers (durations, counts, ports, line numbers) and
 * hexadecimal ids. Only this short hash is stored, never the message.
 */
export function errorFingerprint(message: string): string {
  const normalized = message
    .toLowerCase()
    .replace(/\b(?=[0-9a-f-]*\d)[0-9a-f]{7,}(?:-[0-9a-f]{4,})*\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FINGERPRINTED_LENGTH);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/** Parses stored history, starting fresh when it is missing, corrupt or from another format version. */
export function parseHistory(json: string | undefined): History {
  if (!json) return emptyHistory();
  try {
    const data = JSON.parse(json) as Partial<History>;
    if (data.version !== HISTORY_VERSION || typeof data.tests !== "object" || data.tests === null) {
      return emptyHistory();
    }
    const tests: History["tests"] = Object.create(null);
    // The file comes from a branch other runs write: every field is checked before it is used or rendered.
    for (const [id, test] of Object.entries(data.tests as Record<string, unknown>)) {
      const parsed = parseTest(test);
      if (parsed) tests[id] = parsed;
    }
    return {
      version: HISTORY_VERSION,
      updatedAt: isoDate(data.updatedAt) ?? emptyHistory().updatedAt,
      runs: count(data.runs),
      ...(Array.isArray(data.runDurations) ? { runDurations: data.runDurations.filter(isDuration).slice(-MAX_DURATIONS) } : {}),
      tests,
    };
  } catch {
    return emptyHistory();
  }
}

/** Keeps of a stored test only what has the shape notmyfault writes, so nothing else reaches the analysis or a page. */
function parseTest(value: unknown): TestHistory | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const outcomes = typeof raw.outcomes === "string" ? raw.outcomes.replace(/[^pfr]/g, "").slice(-MAX_OUTCOMES) : "";
  const test: TestHistory = { outcomes, lastSeen: day(raw.lastSeen) ?? new Date(0).toISOString().slice(0, 10) };
  const failedOn = list(raw.failedOn, (sha) => hex(sha)).slice(-MAX_FAILED_ON);
  if (failedOn.length > 0) test.failedOn = failedOn;
  const evidence = list(raw.evidence, parseEvidence).slice(-MAX_EVIDENCE);
  if (evidence.length > 0) test.evidence = evidence;
  const errors = list(raw.errors, (value) => hex(value)).slice(-MAX_ERRORS);
  if (errors.length > 0) test.errors = errors;
  const lastFailure = day(raw.lastFailure);
  if (lastFailure) test.lastFailure = lastFailure;
  const durations = list(raw.durations, (ms) => (isDuration(ms) ? ms : undefined)).slice(-MAX_DURATIONS);
  if (durations.length > 0) test.durations = durations;
  if (typeof raw.lastRun === "number" && Number.isInteger(raw.lastRun) && raw.lastRun >= 0) test.lastRun = raw.lastRun;
  const failingSince = parseFailingSince(raw.failingSince);
  if (failingSince) test.failingSince = failingSince;
  return test;
}

function parseEvidence(value: unknown): FlakyEvidence | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const at = isoDate(raw.at);
  const sha = hex(raw.sha);
  if (!at || !sha || (raw.kind !== "retry" && raw.kind !== "rerun")) return undefined;
  return { at, sha, kind: raw.kind };
}

function parseFailingSince(value: unknown): FailingSince | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const at = isoDate(raw.at);
  const sha = hex(raw.sha);
  if (!at || !sha) return undefined;
  const since: FailingSince = { sha, at };
  const url = webUrl(raw.url);
  if (url) since.url = url;
  const change = raw.change as Record<string, unknown> | undefined;
  const changeUrl = change ? webUrl(change.url) : undefined;
  if (change && changeUrl && typeof change.ref === "string" && change.ref.length <= MAX_REF_LENGTH) {
    since.change = { ref: change.ref, url: changeUrl };
  }
  return since;
}

function list<T>(value: unknown, parse: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  const parsed: T[] = [];
  for (const item of value.slice(-MAX_FAILED_ON * 2)) {
    const kept = parse(item);
    if (kept !== undefined) parsed.push(kept);
  }
  return parsed;
}

function hex(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{1,64}$/.test(value) ? value : undefined;
}

function day(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function isoDate(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(value) ? value : undefined;
}

/** Links rendered in pages and comments: only addresses a browser can safely follow. */
function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function serializeHistory(history: History): string {
  return `${JSON.stringify(history, null, 1)}\n`;
}

/**
 * Records the results of one run. Returns whether anything worth persisting
 * changed, so runs that learn nothing new can skip the write.
 */
export function recordRun(history: History, results: TestResult[], options: RecordOptions): boolean {
  const sha = options.sha.slice(0, 12);
  const today = options.now.toISOString().slice(0, 10);
  let changed = false;

  for (const result of results) {
    if (result.outcome === "skipped") continue;

    let test = history.tests[result.id];
    let testChanged = false;
    if (!test) {
      // Off tracked branches, only failures and flakiness are worth remembering.
      if (!options.tracked && result.outcome === "passed") continue;
      test = { outcomes: "", lastSeen: today };
      history.tests[result.id] = test;
      testChanged = true;
    }

    if (options.tracked) {
      const code = result.outcome === "failed" ? FAIL : result.outcome === "flaky" ? RETRY : PASS;
      if (code !== FAIL) {
        delete test.failingSince;
      } else if (!test.outcomes.endsWith(FAIL)) {
        // A streak recorded before failingSince existed stays without one: its start is unknown.
        test.failingSince = {
          sha,
          at: options.now.toISOString(),
          ...(options.commit?.url ? { url: options.commit.url } : {}),
          ...(options.commit?.change ? { change: options.commit.change } : {}),
        };
      }
      test.outcomes = (test.outcomes + code).slice(-options.window);
      test.lastRun = history.runs + 1;
      testChanged = true;
      if (result.duration !== undefined) test.durations = [...(test.durations ?? []), result.duration].slice(-MAX_DURATIONS);
      if (result.outcome !== "passed") {
        test.lastFailure = today;
        // Only errors seen on tracked branches are known: a pull request must not excuse its own.
        if (result.message) addError(test, errorFingerprint(result.message));
      }
    }

    if (result.outcome === "failed") {
      if (!test.failedOn?.includes(sha)) {
        test.failedOn = [...(test.failedOn ?? []), sha].slice(-MAX_FAILED_ON);
        testChanged = true;
      }
    } else if (result.outcome === "flaky") {
      testChanged = addEvidence(test, { at: options.now.toISOString(), sha, kind: "retry" }) || testChanged;
    } else if (test.failedOn?.includes(sha)) {
      testChanged = addEvidence(test, { at: options.now.toISOString(), sha, kind: "rerun" }) || testChanged;
    }

    if (testChanged) {
      test.lastSeen = today;
      changed = true;
    }
  }

  if (options.tracked) {
    history.runs += 1;
    const timed = results.filter((result) => result.outcome !== "skipped" && result.duration !== undefined);
    if (timed.length > 0) {
      const total = timed.reduce((sum, result) => sum + result.duration!, 0);
      history.runDurations = [...(history.runDurations ?? []), total].slice(-MAX_DURATIONS);
    }
  }
  changed = prune(history, options) || changed;
  if (changed) history.updatedAt = options.now.toISOString();
  return changed;
}

function addEvidence(test: TestHistory, evidence: FlakyEvidence): boolean {
  const existing = test.evidence ?? [];
  if (existing.some((e) => e.sha === evidence.sha && e.kind === evidence.kind)) return false;
  test.evidence = [...existing, evidence].slice(-MAX_EVIDENCE);
  return true;
}

function addError(test: TestHistory, fingerprint: string): void {
  test.errors = [...(test.errors ?? []).filter((e) => e !== fingerprint), fingerprint].slice(-MAX_ERRORS);
}

function prune(history: History, options: RecordOptions): boolean {
  const cutoff = options.now.getTime() - options.retentionDays * DAY_MS;
  let changed = false;
  for (const [id, test] of Object.entries(history.tests)) {
    if (Date.parse(test.lastSeen) < cutoff) {
      delete history.tests[id];
      changed = true;
      continue;
    }
    if (test.evidence?.some((e) => Date.parse(e.at) < cutoff)) {
      test.evidence = test.evidence.filter((e) => Date.parse(e.at) >= cutoff);
      if (test.evidence.length === 0) delete test.evidence;
      changed = true;
    }
  }
  return forget(history) || changed;
}

/** Past MAX_TESTS, the tests seen longest ago go: a report full of made-up names cannot grow the branch for ever. */
function forget(history: History): boolean {
  const ids = Object.keys(history.tests);
  if (ids.length <= MAX_TESTS) return false;
  const oldest = ids
    .sort((a, b) => history.tests[a]!.lastSeen.localeCompare(history.tests[b]!.lastSeen) || a.localeCompare(b))
    .slice(0, ids.length - MAX_TESTS);
  for (const id of oldest) delete history.tests[id];
  return true;
}
