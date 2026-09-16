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
  /** Last day (YYYY-MM-DD) the test was recorded. */
  lastSeen: string;
}

export interface History {
  version: typeof HISTORY_VERSION;
  updatedAt: string;
  /** Number of tracked-branch runs recorded so far. */
  runs: number;
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
}

const MAX_FAILED_ON = 20;
const MAX_EVIDENCE = 10;
const MAX_ERRORS = 10;
const MAX_FINGERPRINTED_LENGTH = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyHistory(): History {
  return { version: HISTORY_VERSION, updatedAt: new Date(0).toISOString(), runs: 0, tests: {} };
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
    return {
      version: HISTORY_VERSION,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : emptyHistory().updatedAt,
      runs: typeof data.runs === "number" ? data.runs : 0,
      tests: data.tests,
    };
  } catch {
    return emptyHistory();
  }
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
      test.outcomes = (test.outcomes + code).slice(-options.window);
      testChanged = true;
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

  if (options.tracked) history.runs += 1;
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
  return changed;
}
