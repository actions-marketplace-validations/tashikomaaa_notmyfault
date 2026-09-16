import { describe, expect, it } from "vitest";
import { emptyHistory, parseHistory, recordRun, serializeHistory, type RecordOptions } from "../src/history";
import type { Outcome, TestResult } from "../src/junit";

const NOW = new Date("2026-09-16T12:00:00Z");
const test = (id: string, outcome: Outcome): TestResult => ({ id, title: id, outcome });
const options = (overrides: Partial<RecordOptions> = {}): RecordOptions => ({
  sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  tracked: true,
  now: NOW,
  window: 5,
  retentionDays: 90,
  ...overrides,
});

describe("recordRun", () => {
  it("appends outcomes on tracked branches and keeps a bounded window", () => {
    const history = emptyHistory();
    for (const outcome of ["passed", "failed", "flaky", "passed", "passed", "passed"] as Outcome[]) {
      recordRun(history, [test("t", outcome)], options());
    }
    expect(history.tests.t!.outcomes).toBe("frppp");
    expect(history.runs).toBe(6);
  });

  it("ignores skipped tests", () => {
    const history = emptyHistory();
    recordRun(history, [test("s", "skipped")], options());
    expect(history.tests).toEqual({});
  });

  it("only remembers failures and flakiness off tracked branches", () => {
    const history = emptyHistory();
    const changed = recordRun(history, [test("ok", "passed"), test("ko", "failed")], options({ tracked: false }));
    expect(changed).toBe(true);
    expect(Object.keys(history.tests)).toEqual(["ko"]);
    expect(history.tests.ko).toMatchObject({ outcomes: "", failedOn: ["aaaaaaaaaaaa"] });
    expect(history.runs).toBe(0);
  });

  it("reports no change when an untracked run teaches nothing", () => {
    const history = emptyHistory();
    recordRun(history, [test("ok", "passed")], options());
    expect(recordRun(history, [test("ok", "passed")], options({ tracked: false }))).toBe(false);
  });

  it("records a failure then a pass on the same commit as rerun evidence, once", () => {
    const history = emptyHistory();
    recordRun(history, [test("t", "failed")], options({ tracked: false }));
    recordRun(history, [test("t", "passed")], options({ tracked: false }));
    recordRun(history, [test("t", "passed")], options({ tracked: false }));
    expect(history.tests.t!.evidence).toEqual([{ at: NOW.toISOString(), sha: "aaaaaaaaaaaa", kind: "rerun" }]);
  });

  it("does not treat a pass on another commit as evidence", () => {
    const history = emptyHistory();
    recordRun(history, [test("t", "failed")], options({ tracked: false }));
    recordRun(history, [test("t", "passed")], options({ tracked: false, sha: "bbbbbbbbbbbbbbbb" }));
    expect(history.tests.t!.evidence).toBeUndefined();
  });

  it("records in-run retries as evidence", () => {
    const history = emptyHistory();
    recordRun(history, [test("t", "flaky")], options({ tracked: false }));
    expect(history.tests.t!.evidence?.[0]?.kind).toBe("retry");
  });

  it("forgets tests and evidence older than the retention period", () => {
    const history = emptyHistory();
    const old = new Date("2026-05-01T00:00:00Z");
    recordRun(history, [test("gone", "passed"), test("kept", "flaky")], options({ now: old }));
    recordRun(history, [test("kept", "passed")], options({ sha: "c".repeat(40) }));
    expect(Object.keys(history.tests)).toEqual(["kept"]);
    expect(history.tests.kept!.evidence).toBeUndefined();
  });
});

describe("parseHistory", () => {
  it("round-trips serialized history", () => {
    const history = emptyHistory();
    recordRun(history, [test("t", "failed")], options());
    expect(parseHistory(serializeHistory(history))).toEqual(history);
  });

  it("starts fresh on missing, corrupt or incompatible data", () => {
    expect(parseHistory(undefined)).toEqual(emptyHistory());
    expect(parseHistory("{not json")).toEqual(emptyHistory());
    expect(parseHistory(JSON.stringify({ version: 99, tests: {} }))).toEqual(emptyHistory());
  });
});
