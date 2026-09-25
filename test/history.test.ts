import { describe, expect, it } from "vitest";
import {
  emptyHistory,
  errorFingerprint,
  MAX_TESTS,
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
  it("treats a test named __proto__ as a test, not as the prototype of every object", () => {
    const history = emptyHistory();
    recordRun(history, [test("__proto__", "failed"), test("checkout › pays", "passed")], options({ tracked: false }));
    // Nothing leaks onto Object.prototype, and no passing test inherits a failure of it.
    expect(({} as { failedOn?: unknown }).failedOn).toBeUndefined();
    expect(({} as { outcomes?: unknown }).outcomes).toBeUndefined();
    expect(history.tests["checkout › pays"]).toBeUndefined();
    expect(history.tests.__proto__).toMatchObject({ failedOn: ["aaaaaaaaaaaa"] });

    // And on a tracked branch, where every test is recorded, the others keep their own history.
    const tracked = emptyHistory();
    recordRun(tracked, [test("__proto__", "passed"), test("checkout › pays", "passed")], options());
    recordRun(tracked, [test("__proto__", "failed"), test("checkout › pays", "passed")], options({ sha: "b".repeat(40) }));
    expect(tracked.tests["checkout › pays"]!.outcomes).toBe("pp");
    expect(tracked.tests["checkout › pays"]!.evidence).toBeUndefined();
    expect(JSON.parse(serializeHistory(tracked)).tests.__proto__.outcomes).toBe("pf");
  });

  it("remembers where a failure streak on tracked branches started, until the test passes", () => {
    const history = emptyHistory();
    const commit = { url: "https://github.com/o/r/commit/bbb", change: { ref: "#42", url: "https://github.com/o/r/pull/42" } };
    recordRun(history, [test("t", "passed")], options({ commit }));
    expect(history.tests.t!.failingSince).toBeUndefined();

    recordRun(history, [test("t", "failed")], options({ sha: "b".repeat(40), commit, now: new Date("2026-09-17T08:00:00Z") }));
    const since = { sha: "bbbbbbbbbbbb", at: "2026-09-17T08:00:00.000Z", ...commit };
    expect(history.tests.t!.failingSince).toEqual(since);

    // The streak goes on: its start does not move, and pull request runs never touch it.
    recordRun(history, [test("t", "failed")], options({ sha: "c".repeat(40), commit: { url: "https://github.com/o/r/commit/ccc" } }));
    recordRun(history, [test("t", "failed")], options({ sha: "d".repeat(40), tracked: false }));
    expect(history.tests.t!.failingSince).toEqual(since);

    recordRun(history, [test("t", "flaky")], options());
    expect(history.tests.t!.failingSince).toBeUndefined();
  });

  it("remembers the total test time of the last tracked runs", () => {
    const history = emptyHistory();
    const timed = (id: string, outcome: Outcome, duration: number): TestResult => ({ ...test(id, outcome), duration });
    recordRun(history, [timed("a", "passed", 1200), timed("b", "failed", 300), { ...timed("c", "skipped", 99) }], options());
    recordRun(history, [test("a", "passed")], options());
    recordRun(history, [timed("a", "passed", 1000)], options({ tracked: false }));
    expect(history.runDurations).toEqual([1500]);
    expect(parseHistory(serializeHistory(history)).runDurations).toEqual([1500]);
  });

  it("does not guess where a streak recorded before failingSince started", () => {
    const history = emptyHistory();
    history.tests.t = { outcomes: "pff", lastSeen: "2026-09-16" };
    recordRun(history, [test("t", "failed")], options());
    expect(history.tests.t!.failingSince).toBeUndefined();
    // A test failing on its very first tracked run starts a streak.
    recordRun(history, [test("u", "failed")], options());
    expect(history.tests.u!.failingSince).toMatchObject({ sha: "aaaaaaaaaaaa" });
  });

  it("appends outcomes on tracked branches and keeps a bounded window", () => {
    const history = emptyHistory();
    for (const outcome of ["passed", "failed", "flaky", "passed", "passed", "passed"] as Outcome[]) {
      recordRun(history, [test("t", outcome)], options());
    }
    expect(history.tests.t!.outcomes).toBe("frppp");
    expect(history.tests.t!.lastRun).toBe(6);
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

  it("keeps the durations of the last 10 runs on tracked branches", () => {
    const history = emptyHistory();
    for (let run = 1; run <= 12; run++) {
      recordRun(history, [{ id: "t", title: "t", outcome: "passed", duration: run * 100 }], options());
    }
    recordRun(history, [{ id: "t", title: "t", outcome: "passed", duration: 9999 }], options({ tracked: false }));
    recordRun(history, [{ id: "t", title: "t", outcome: "passed" }], options());
    expect(history.tests.t!.durations).toEqual([300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]);
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

  it("keeps of a stored test only the fields it writes itself", () => {
    const stored = {
      version: 1,
      updatedAt: "2026-09-16T12:00:00.000Z",
      runs: "many",
      tests: {
        crafted: {
          outcomes: "pf<b>",
          lastSeen: "2026-09-16",
          lastFailure: "yesterday",
          failedOn: ["a41c07e9b2f3", "../../etc/passwd"],
          evidence: [{ at: "2026-09-10T08:00:00Z", sha: "3f2a1b9c0d4e", kind: "retry" }, { at: "soon", sha: "x", kind: "wish" }],
          durations: [12, Number.NaN, -1, "slow"],
          lastRun: 1.5,
          failingSince: { sha: "a41c07e9b2f3", at: "2026-09-10T08:00:00Z", url: "javascript:alert(1)" },
          note: "dropped",
        },
        broken: "not a test",
      },
    };
    const history = parseHistory(JSON.stringify(stored));
    expect(history.runs).toBe(0);
    expect(Object.keys(history.tests)).toEqual(["crafted"]);
    const crafted = history.tests.crafted!;
    expect(crafted).not.toHaveProperty("note");
    expect(crafted.outcomes).toBe("pf");
    expect(crafted.lastFailure).toBeUndefined();
    expect(crafted.failedOn).toEqual(["a41c07e9b2f3"]);
    expect(crafted.evidence).toEqual([{ at: "2026-09-10T08:00:00Z", sha: "3f2a1b9c0d4e", kind: "retry" }]);
    expect(crafted.durations).toEqual([12]);
    expect(crafted.lastRun).toBeUndefined();
    // A link a browser would run as code is not a link.
    expect(crafted.failingSince).toEqual({ sha: "a41c07e9b2f3", at: "2026-09-10T08:00:00Z" });
  });

  it("reads a test named __proto__ as a test, and leaves every other object alone", () => {
    // Written by hand: in an object literal, __proto__ would set the prototype instead of a key.
    const history = parseHistory('{"version":1,"tests":{"__proto__":{"outcomes":"f","lastSeen":"2026-09-16"}}}');
    expect(({} as { outcomes?: unknown }).outcomes).toBeUndefined();
    expect(history.tests["__proto__"]?.outcomes).toBe("f");
  });
});

describe("the size of the history", () => {
  it("forgets the tests seen longest ago past the cap", () => {
    const history = emptyHistory();
    const flood = Array.from({ length: MAX_TESTS + 10 }, (_, i) => test(`generated ${i}`, "failed"));
    recordRun(history, [test("real", "failed")], options({ now: new Date("2026-09-10T12:00:00Z") }));
    recordRun(history, flood, options());
    expect(Object.keys(history.tests)).toHaveLength(MAX_TESTS);
    // The oldest go first, so a flood of made-up names cannot push out what ran today.
    expect(history.tests.real).toBeUndefined();
    expect(history.tests["generated 9999"]).toBeDefined();
  });
});
