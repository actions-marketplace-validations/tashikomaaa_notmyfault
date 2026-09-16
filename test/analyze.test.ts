import { describe, expect, it } from "vitest";
import {
  analyze,
  blockingFailures,
  isolatedFailures,
  rankFlakyTests,
  trailingFailures,
  type Verdict,
} from "../src/analyze";
import { emptyHistory, type History, type TestHistory } from "../src/history";
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
