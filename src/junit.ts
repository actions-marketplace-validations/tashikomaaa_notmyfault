import { parseXml, type XmlElement } from "./xml";

/**
 * - passed: ran and passed on the first attempt
 * - failed: failed (including errors), after any retries
 * - flaky: failed at least once, then passed within the same run
 * - skipped: did not run
 */
export type Outcome = "passed" | "failed" | "flaky" | "skipped";

export interface TestResult {
  /** Stable identity used to track the test across runs. */
  id: string;
  /** Human-friendly name for reports. */
  title: string;
  outcome: Outcome;
  /** First line of the first failure message, if any. */
  message?: string;
  /** What the report tells about where a failed test lives, to annotate it. */
  hints?: LocationHints;
}

export interface LocationHints {
  /** The file and line attributes of the test case, or the file attribute of its suite. */
  file?: string;
  line?: number;
  /** Class and suite names, which some runners set to the test file. */
  names: string[];
  /** file:line references found in the failure output, in order. */
  references: { file: string; line: number }[];
}

const MAX_MESSAGE_LENGTH = 300;
const MAX_REFERENCES = 20;
// A path ending with an extension, then a line number: "test/cart.test.ts:14:25", "(OrderTest.java:42)".
const REFERENCE = /(?:^|[\s(['"])((?:[\w@.-]+\/|\/)*[\w@-][\w@.-]*\.[a-z][a-z0-9]{0,5}):(\d+)/gi;

/**
 * Parses one JUnit XML document. Repeated test cases inside the same
 * <testsuite> are retries and get merged; the same test in different suites
 * (e.g. one per Playwright project) is combined like separate reports.
 */
export function parseJUnit(xml: string): TestResult[] {
  const root: TestResult[] = [];
  const groups: TestResult[][] = [root];
  collect(parseXml(xml), { name: "" }, root, groups);
  return combineReports(groups.map(mergeAttempts));
}

/**
 * Combines results coming from several reports. The same test appearing in
 * different reports (matrix jobs, shards, browsers) is not a retry, so the
 * worst outcome wins instead of being reported as flaky.
 */
export function combineReports(reports: TestResult[][]): TestResult[] {
  const byId = new Map<string, TestResult>();
  for (const report of reports) {
    for (const result of report) {
      const previous = byId.get(result.id);
      if (!previous || severity(result.outcome) > severity(previous.outcome)) {
        byId.set(result.id, result);
      }
    }
  }
  return [...byId.values()];
}

function severity(outcome: Outcome): number {
  return { skipped: 0, passed: 1, flaky: 2, failed: 3 }[outcome];
}

interface Suite {
  name: string;
  file?: string;
}

function collect(element: XmlElement, suite: Suite, group: TestResult[], groups: TestResult[][]): void {
  for (const child of element.children) {
    if (child.name === "testsuite") {
      const suiteGroup: TestResult[] = [];
      groups.push(suiteGroup);
      const file = child.attrs.file ?? suite.file;
      collect(child, { name: child.attrs.name ?? suite.name, ...(file ? { file } : {}) }, suiteGroup, groups);
    } else if (child.name === "testcase") {
      const result = toResult(child, suite);
      if (result) group.push(result);
    } else {
      collect(child, suite, group, groups);
    }
  }
}

function toResult(testcase: XmlElement, suite: Suite): TestResult | undefined {
  const name = normalize(testcase.attrs.name ?? "");
  if (!name) return undefined;
  const classname = normalize(testcase.attrs.classname ?? "");

  const failures: XmlElement[] = [];
  const flakyAttempts: XmlElement[] = [];
  let skipped = false;
  for (const child of testcase.children) {
    switch (child.name) {
      case "failure":
      case "error":
        failures.push(child);
        break;
      // Maven Surefire and cargo-nextest report retried tests this way.
      case "flakyFailure":
      case "flakyError":
        flakyAttempts.push(child);
        break;
      case "skipped":
        skipped = true;
        break;
    }
  }

  let outcome: Outcome;
  if (failures.length > 0) outcome = "failed";
  else if (skipped) outcome = "skipped";
  else if (flakyAttempts.length > 0) outcome = "flaky";
  else outcome = "passed";

  const result: TestResult = {
    id: joinDistinct([normalize(suite.name), classname, name]),
    title: joinDistinct([classname || normalize(suite.name), name]),
    outcome,
  };
  const message = firstMessage(failures[0] ?? flakyAttempts[0]);
  if (message) result.message = message;
  if (outcome === "failed") result.hints = locationHints(testcase, suite, failures);
  return result;
}

function locationHints(testcase: XmlElement, suite: Suite, failures: XmlElement[]): LocationHints {
  const hints: LocationHints = {
    names: [...new Set([testcase.attrs.classname ?? "", suite.name].map(normalize).filter(Boolean))],
    references: [],
  };
  const file = testcase.attrs.file ?? suite.file;
  if (file) hints.file = file;
  const line = Number(testcase.attrs.line);
  if (Number.isInteger(line) && line > 0) hints.line = line;
  for (const failure of failures) {
    for (const match of `${failure.attrs.message ?? ""}\n${failure.text}`.matchAll(REFERENCE)) {
      if (hints.references.length === MAX_REFERENCES) return hints;
      hints.references.push({ file: match[1]!, line: Number(match[2]) });
    }
  }
  return hints;
}

/**
 * Some runners (gotestsum --rerun-fails, pytest plugins, custom retries) emit
 * one <testcase> per attempt. A failure followed by a pass is a flaky test.
 */
function mergeAttempts(results: TestResult[]): TestResult[] {
  const byId = new Map<string, TestResult>();
  for (const result of results) {
    const previous = byId.get(result.id);
    byId.set(result.id, previous ? mergeAttempt(previous, result) : result);
  }
  return [...byId.values()];
}

function mergeAttempt(previous: TestResult, next: TestResult): TestResult {
  if (next.outcome === "skipped") return previous;
  if (previous.outcome === "skipped" || next.outcome === "failed") return next;
  if (previous.outcome === "failed" || previous.outcome === "flaky" || next.outcome === "flaky") {
    const merged: TestResult = { ...next, outcome: "flaky" };
    const message = next.message ?? previous.message;
    if (message) merged.message = message;
    return merged;
  }
  return next;
}

function firstMessage(element: XmlElement | undefined): string | undefined {
  if (!element) return undefined;
  const raw = element.attrs.message || element.text;
  const line = raw
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return undefined;
  return line.length > MAX_MESSAGE_LENGTH ? `${line.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : line;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function joinDistinct(parts: string[]): string {
  const kept: string[] = [];
  for (const part of parts) {
    if (part && part !== kept[kept.length - 1]) kept.push(part);
  }
  return kept.join(" › ");
}
