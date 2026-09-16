import { describe, expect, it } from "vitest";
import {
  analyze,
  blockingFailures,
  brokenStreak,
  rankSlowTests,
  isolatedFailures,
  rankFlakyTests,
  trailingFailures,
  type Verdict,
} from "../src/analyze";
import { emptyHistory, errorFingerprint, type History, type TestHistory } from "../src/history";
import type { TestResult } from "../src/junit";

const NOW = new Date("2026-09-16T12:00:00Z");
const failing = (id: string): TestResult => ({ id, title: id, outcome: "failed" });

function historyWith(tests: Record<string, Partial<TestHistory>>): History {
  const history = emptyHistory();
  history.runs = 50;
  for (const [id, test] of Object.entries(tests)) {
    history.tests[id] = { outcomes: "", lastSeen: "2026-09-16", ...test };
  }
  return history;
}

function verdictOf(test: Partial<TestHistory> | undefined): Verdict {
  const history = test ? historyWith({ t: test }) : emptyHistory();
  return analyze([failing("t")], history, NOW, 30).failures[0]!.verdict;
}

describe("verdicts", () => {
  it("flags failures without history as new", () => {
    expect(verdictOf(undefined)).toBe("new");
    expect(verdictOf({ outcomes: "pppppppp" })).toBe("new");
  });

  it("does not blame flakiness for an old, fixed breakage", () => {
    expect(verdictOf({ outcomes: "pppffffppppp" })).toBe("new");
  });

  it("flags one or two isolated failures as suspect", () => {
    expect(verdictOf({ outcomes: "pppfpppp" })).toBe("suspect");
    // Could be a commit breaking the test and the next one fixing it, twice.
    expect(verdictOf({ outcomes: "ppfpppfpp" })).toBe("suspect");
  });

  it("flags repeated isolated failures as flaky", () => {
    expect(verdictOf({ outcomes: "pfppfpppfp" })).toBe("flaky");
  });

  it("flags tests passing after retries or re-runs as flaky", () => {
    expect(verdictOf({ outcomes: "ppprpp" })).toBe("flaky");
    expect(verdictOf({ outcomes: "pppp", evidence: [{ at: "2026-09-10T00:00:00Z", sha: "abc", kind: "rerun" }] })).toBe(
      "flaky",
    );
  });

  it("ignores expired evidence", () => {
    expect(verdictOf({ outcomes: "pppp", evidence: [{ at: "2026-07-01T00:00:00Z", sha: "abc", kind: "rerun" }] })).toBe(
      "new",
    );
  });

  it("flags tests failing on the tracked branch as broken", () => {
    expect(verdictOf({ outcomes: "ppppf" })).toBe("broken");
    // A long streak wins over past flakiness: the test is really broken now.
    expect(verdictOf({ outcomes: "prpfff" })).toBe("broken");
    // A short streak on a known flaky test is still flakiness.
    expect(verdictOf({ outcomes: "prppff" })).toBe("flaky");
  });
});

describe("slower tests", () => {
  const passing = (id: string, duration: number): TestResult => ({ id, title: id, outcome: "passed", duration });
  const durations = [800, 750, 900, 820, 780];

  it("take at least twice their median duration, and 500 ms more", () => {
    const history = historyWith({ slow: { durations }, quick: { durations: [100, 120, 90, 110, 100] }, few: { durations: [800, 800] } });
    const analysis = analyze(
      [passing("slow", 1700), passing("quick", 400), passing("few", 5000), { ...passing("broken", 9000), outcome: "failed" }],
      historyWith({ ...history.tests, broken: { durations } }),
      NOW,
      30,
    );
    // quick is 4x slower but only 300 ms, few has too few runs, broken fails.
    expect(analysis.slower).toEqual([{ test: passing("slow", 1700), duration: 1700, usual: 800 }]);
    expect(analyze([passing("slow", 1500)], history, NOW, 30).slower).toEqual([]);
  });

  it("are ranked by median duration for the summary", () => {
    const history = historyWith({ a: { durations: [100, 300, 200] }, b: { durations: [1000, 3000] }, c: {}, zero: { durations: [0, 0] } });
    expect(rankSlowTests(history, 10)).toEqual([
      { id: "b", median: 2000, fastest: 1000, slowest: 3000, runs: 2 },
      { id: "a", median: 200, fastest: 100, slowest: 300, runs: 3 },
    ]);
  });
});

describe("failure streaks of flaky tests", () => {
  it("need to be too long to be bad luck", () => {
    // Failed 4 of its 10 runs before the streak, and passed after a retry once.
    const history = "pfpfppfpfr";
    expect(verdictOf({ outcomes: `${history}fffff` })).toBe("flaky");
    expect(verdictOf({ outcomes: `${history}ffffff` })).toBe("broken");
  });

  it("need 3 failures for a flaky test that rarely fails on the tracked branch", () => {
    const evidence = [{ at: "2026-09-10T00:00:00Z", sha: "abc", kind: "rerun" as const }];
    expect(verdictOf({ outcomes: "ppppppff", evidence })).toBe("flaky");
    expect(verdictOf({ outcomes: "pppppfff", evidence })).toBe("broken");
  });

  it("never need more than 10 failures", () => {
    expect(verdictOf({ outcomes: `ffffpfffpr${"f".repeat(9)}` })).toBe("flaky");
    expect(verdictOf({ outcomes: `ffffpfffpr${"f".repeat(10)}` })).toBe("broken");
  });

  it("have a length that grows with the failure rate", () => {
    expect([0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.9].map(brokenStreak)).toEqual([3, 3, 4, 6, 7, 10, 10]);
  });
});

describe("errors never seen on the tracked branch", () => {
  const known = [errorFingerprint("Bank did not answer within 100ms")];
  const judge = (test: Partial<TestHistory>, message?: string) =>
    analyze([{ id: "t", title: "t", outcome: "failed", ...(message ? { message } : {}) }], historyWith({ t: test }), NOW, 30)
      .failures[0]!;

  it("keep excusing a test failing with a known error", () => {
    const failure = judge({ outcomes: "ppprpp", errors: known }, "Bank did not answer within 180ms");
    expect(failure.verdict).toBe("flaky");
    expect(failure.usually).toBeUndefined();
  });

  it("turn a flaky, suspect or already failing test into a new failure", () => {
    const message = "expected 3758 to be 3422";
    expect(judge({ outcomes: "ppprpp", errors: known }, message)).toMatchObject({ verdict: "new", usually: "flaky" });
    expect(judge({ outcomes: "pppfpp", errors: known }, message)).toMatchObject({ verdict: "new", usually: "suspect" });
    expect(judge({ outcomes: "ppppff", errors: known }, message)).toMatchObject({ verdict: "new", usually: "broken" });
  });

  it("cannot be told without recorded errors or a message", () => {
    expect(judge({ outcomes: "ppprpp" }, "expected 3758 to be 3422").verdict).toBe("flaky");
    expect(judge({ outcomes: "ppprpp", errors: known }).verdict).toBe("flaky");
  });
});

describe("analyze", () => {
  it("counts outcomes and sorts failures by how actionable they are", () => {
    const history = historyWith({ flaky: { outcomes: "pfpfpfp" }, broken: { outcomes: "pf" } });
    const analysis = analyze(
      [
        failing("flaky"),
        failing("broken"),
        failing("zzz-new"),
        { id: "ok", title: "ok", outcome: "passed" },
        { id: "retried", title: "retried", outcome: "flaky" },
        { id: "skip", title: "skip", outcome: "skipped" },
      ],
      history,
      NOW,
      30,
    );
    expect(analysis.failures.map((f) => [f.test.id, f.verdict])).toEqual([
      ["zzz-new", "new"],
      ["broken", "broken"],
      ["flaky", "flaky"],
    ]);
    expect(analysis).toMatchObject({ total: 6, passed: 2, skipped: 1 });
    expect(analysis.retried.map((t) => t.id)).toEqual(["retried"]);
  });

  it("reports passing tests that are failing on the tracked branch as fixed", () => {
    const history = historyWith({
      broken: { outcomes: "ppfff" },
      "just-broken": { outcomes: "pppf" },
      "retried-fix": { outcomes: "pff" },
      "flaky-again": { outcomes: "prppf" },
      "long-flaky-streak": { outcomes: "prpfff" },
      stable: { outcomes: "pppp" },
      "old-breakage": { outcomes: "pffp" },
    });
    const passing = (id: string): TestResult => ({ id, title: id, outcome: "passed" });
    const analysis = analyze(
      [
        passing("broken"),
        passing("just-broken"),
        { id: "retried-fix", title: "retried-fix", outcome: "flaky" },
        passing("flaky-again"),
        passing("long-flaky-streak"),
        passing("stable"),
        passing("old-breakage"),
        passing("unknown"),
        failing("broken-elsewhere"),
      ],
      historyWith({ ...history.tests, "broken-elsewhere": { outcomes: "pff" } }),
      NOW,
      30,
    );
    // A known flaky test passing after a short streak is luck, not a fix.
    expect(analysis.fixed.map((f) => [f.test.id, f.trailingFailures])).toEqual([
      ["broken", 3],
      ["just-broken", 1],
      ["long-flaky-streak", 3],
      ["retried-fix", 2],
    ]);
  });

  it("filters tolerated verdicts", () => {
    const history = historyWith({ flaky: { outcomes: "pfpfpfp" } });
    const analysis = analyze([failing("flaky"), failing("new")], history, NOW, 30);
    expect(blockingFailures(analysis, new Set(["flaky"])).map((f) => f.test.id)).toEqual(["new"]);
    expect(blockingFailures(analysis, new Set(["flaky", "new"]))).toEqual([]);
  });
});

describe("helpers", () => {
  it("counts isolated failures only when surrounded by passes", () => {
    expect(isolatedFailures("fpfpf")).toBe(1);
    expect(isolatedFailures("pffp")).toBe(0);
    expect(isolatedFailures("rfp")).toBe(1);
    expect(isolatedFailures("")).toBe(0);
  });

  it("counts trailing failures", () => {
    expect(trailingFailures("pfff")).toBe(3);
    expect(trailingFailures("ffp")).toBe(0);
  });

  it("ranks the most unreliable tests", () => {
    const history = historyWith({
      stable: { outcomes: "pppppppppp" },
      twice: { outcomes: "ppfppppfpp" },
      often: { outcomes: "pfpfpfpfpp" },
      proven: { outcomes: "pppppppppp", evidence: [{ at: "2026-09-15T00:00:00Z", sha: "x", kind: "retry" }] },
    });
    expect(rankFlakyTests(history, NOW, 30, 10).map((t) => t.id)).toEqual(["proven", "often"]);
  });
});
