import { MAX_EVIDENCE, MAX_FAILED_ON, type History } from "./history";
import type { TestResult } from "./junit";

export interface Rename {
  from: string;
  to: string;
}

/** Names at least this similar, on their last part, can be the same test renamed. */
const MIN_SIMILARITY = 0.6;
const SEPARATOR = " › ";

/**
 * Tests renamed in a run on a tracked branch: within a file or suite, exactly
 * one test ran in the previous run and not in this one, exactly one test is
 * new, and their names are similar. Anything less certain is left alone: a
 * deleted test must not pass its flakiness on to an unrelated new one.
 */
export function detectRenames(history: History, results: TestResult[]): Rename[] {
  const previousRun = history.runs;
  if (previousRun === 0) return [];
  const present = new Set(results.map((result) => result.id));
  const groups = new Map<string, { missing: string[]; added: string[] }>();
  const group = (id: string) => {
    const key = prefix(id);
    let entry = groups.get(key);
    if (!entry) groups.set(key, (entry = { missing: [], added: [] }));
    return entry;
  };
  for (const [id, test] of Object.entries(history.tests)) {
    if (test.lastRun === previousRun && !present.has(id)) group(id).missing.push(id);
  }
  for (const result of results) {
    // Pull requests remember failures of tests that never ran on a tracked branch: those are new too.
    const known = history.tests[result.id]?.outcomes;
    if (result.outcome !== "skipped" && !known) group(result.id).added.push(result.id);
  }

  const renames: Rename[] = [];
  for (const { missing, added } of groups.values()) {
    if (missing.length !== 1 || added.length !== 1) continue;
    const [from, to] = [missing[0]!, added[0]!];
    if (similarity(lastPart(from), lastPart(to)) >= MIN_SIMILARITY) renames.push({ from, to });
  }
  return renames.sort((a, b) => a.to.localeCompare(b.to));
}

/** Moves the history of each renamed test to its new name, with what pull requests remembered about the new name. */
export function applyRenames(history: History, renames: Rename[]): void {
  for (const { from, to } of renames) {
    const test = history.tests[from];
    const target = history.tests[to];
    if (!test || target?.outcomes) continue;
    if (target) {
      const failedOn = [...new Set([...(test.failedOn ?? []), ...(target.failedOn ?? [])])].slice(-MAX_FAILED_ON);
      const evidence = [...(test.evidence ?? []), ...(target.evidence ?? [])]
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(-MAX_EVIDENCE);
      if (failedOn.length > 0) test.failedOn = failedOn;
      if (evidence.length > 0) test.evidence = evidence;
      if (target.lastSeen > test.lastSeen) test.lastSeen = target.lastSeen;
    }
    history.tests[to] = test;
    delete history.tests[from];
  }
}

function prefix(id: string): string {
  const index = id.lastIndexOf(SEPARATOR);
  return index === -1 ? "" : id.slice(0, index);
}

function lastPart(id: string): string {
  const index = id.lastIndexOf(SEPARATOR);
  return index === -1 ? id : id.slice(index + SEPARATOR.length);
}

/** 1 for equal strings, 0 for nothing in common: one minus the edit distance over the longest length. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return 1 - previous[b.length]! / Math.max(a.length, b.length);
}
