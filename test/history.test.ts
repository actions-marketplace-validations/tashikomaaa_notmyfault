import { describe, expect, it } from "vitest";
import {
  emptyHistory,
  errorFingerprint,
  parseHistory,
  recordRun,
  serializeHistory,
  type RecordOptions,
} from "../src/history";
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

describe("errorFingerprint", () => {
  it("ignores case, spacing, numbers and hexadecimal ids", () => {
    expect(errorFingerprint("Bank did not answer within 100ms")).toBe(errorFingerprint("bank did not  answer within 2500ms"));
    expect(errorFingerprint("Request 3f2a1b9c0d4e failed")).toBe(errorFingerprint("Request 9e8d7c6b5a41 failed"));
    expect(errorFingerprint("User 123e4567-e89b-12d3-a456-426614174000 not found")).toBe(
      errorFingerprint("User 00000000-0000-0000-0000-000000000000 not found"),
    );
  });

  it("tells different errors apart", () => {
    expect(errorFingerprint("Bank did not answer within 100ms")).not.toBe(errorFingerprint("expected 3758 to be 3422"));
    expect(errorFingerprint("expected true to be false")).not.toBe(errorFingerprint("expected false to be true"));
    // Words made of hexadecimal letters are words, not ids.
    expect(errorFingerprint("decade faded")).not.toBe(errorFingerprint("facade faded"));
  });

  it("is a short hash, not the message", () => {
    expect(errorFingerprint("password=hunter2 rejected")).toMatch(/^[0-9a-f]{12}$/);
  });
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

  it("remembers the errors of failures and retries on tracked branches only", () => {
    const history = emptyHistory();
    const run = (outcome: Outcome, message: string, tracked = true) =>
      recordRun(history, [{ id: "t", title: "t", outcome, message }], options({ tracked }));
    run("failed", "timeout after 100ms");
    run("flaky", "socket hang up");
    run("failed", "timeout after 250ms");
    run("failed", "expected 1 to be 2", false);
    expect(history.tests.t!.errors).toEqual([errorFingerprint("socket hang up"), errorFingerprint("timeout after 1ms")]);
  });

  it("remembers the last day a test failed or needed a retry on a tracked branch", () => {
    const history = emptyHistory();
    recordRun(history, [test("t", "flaky")], options({ now: new Date("2026-09-01T10:00:00Z") }));
    expect(history.tests.t!.lastFailure).toBe("2026-09-01");
    recordRun(history, [test("t", "failed")], options({ now: new Date("2026-09-10T10:00:00Z"), tracked: false }));
    recordRun(history, [test("t", "passed")], options({ now: new Date("2026-09-12T10:00:00Z") }));
    expect(history.tests.t!.lastFailure).toBe("2026-09-01");
  });

  it("keeps the 10 most recent errors", () => {
    const history = emptyHistory();
    for (const letter of "abcdefghijkl") {
      recordRun(history, [{ id: "t", title: "t", outcome: "failed", message: `error ${letter}` }], options());
    }
    expect(history.tests.t!.errors).toHaveLength(10);
    expect(history.tests.t!.errors!.at(-1)).toBe(errorFingerprint("error l"));
    expect(history.tests.t!.errors).not.toContain(errorFingerprint("error a"));
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
