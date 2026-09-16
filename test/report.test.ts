import { describe, expect, it } from "vitest";
import { analyze, rankFlakyTests, type Verdict } from "../src/analyze";
import { emptyHistory } from "../src/history";
import type { TestResult } from "../src/junit";
import { commentMarker, renderComment, renderSummary, type ReportContext } from "../src/report";

const NOW = new Date("2026-09-16T12:00:00Z");

function context(overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    key: "ci-test",
    trackedBranches: ["main"],
    historyRuns: 40,
    mode: "report",
    tolerated: new Set<Verdict>(["flaky"]),
    blocking: 0,
    runUrl: "https://github.com/o/r/actions/runs/1",
    ...overrides,
  };
}

function scenario() {
  const history = emptyHistory();
  history.runs = 40;
  history.tests = {
    "api › flaky": {
      outcomes: "ppfpppfppp",
      lastSeen: "2026-09-16",
      evidence: [{ at: "2026-09-12T08:00:00Z", sha: "abc", kind: "rerun" }],
    },
    "api › broken": { outcomes: "pppff", lastSeen: "2026-09-16" },
    "api › new": { outcomes: "pppppppp", lastSeen: "2026-09-16" },
  };
  const results: TestResult[] = [
    { id: "api › flaky", title: "api › flaky", outcome: "failed", message: "timeout <5s> | retry" },
    { id: "api › broken", title: "api › broken", outcome: "failed" },
    { id: "api › new", title: "api › new", outcome: "failed", message: "expected 201, got 500" },
    { id: "api › ok", title: "api › ok", outcome: "flaky" },
  ];
  return { history, analysis: analyze(results, history, NOW, 30) };
}

describe("renderComment", () => {
  it("starts with the marker and explains every verdict", () => {
    const { analysis } = scenario();
    const body = renderComment(analysis, context());
    expect(body.startsWith(commentMarker("ci-test"))).toBe(true);
    expect(body).toContain("### 🔴 3 tests failed, 1 looks related to this change");
    expect(body).toContain("**New failure.** Passed the last 8 runs on `main`.");
    expect(body).toContain("**Already failing on `main`.** Failed the last 2 runs there.");
    expect(body).toContain(
      "**Known flaky.** Failed 2 of the last 10 runs on `main`; passed when the same commit was re-run on 2026-09-12.",
    );
    expect(body).toContain("🔁 Passed only after a retry: <code>api › ok</code>");
    expect(body).toContain("[Workflow run](https://github.com/o/r/actions/runs/1)");
  });

  it("escapes HTML and table separators coming from test output", () => {
    const { analysis } = scenario();
    const body = renderComment(analysis, context());
    expect(body).toContain("<pre>timeout &lt;5s&gt; &#124; retry</pre>");
  });

  it("reassures when no failure looks related to the change", () => {
    const history = emptyHistory();
    history.tests.t = { outcomes: "pfpfpfp", lastSeen: "2026-09-16" };
    const analysis = analyze([{ id: "t", title: "t", outcome: "failed" }], history, NOW, 30);
    expect(renderComment(analysis, context())).toContain("### 🟢 1 test failed, none of them look like your fault");
  });

  it("tells proven flakiness apart from a probable one", () => {
    const history = emptyHistory();
    history.tests = {
      probable: { outcomes: "pfpfpfpp", lastSeen: "2026-09-16" },
      suspect: { outcomes: "ppfppfpp", lastSeen: "2026-09-16" },
    };
    const analysis = analyze(
      [
        { id: "probable", title: "probable", outcome: "failed" },
        { id: "suspect", title: "suspect", outcome: "failed" },
      ],
      history,
      NOW,
      30,
    );
    const body = renderComment(analysis, context());
    expect(body).toContain("**Probably flaky.** Failed 3 of the last 8 runs on `main`.");
    expect(body).toContain("**Suspect.** Failed in isolation twice in the last 8 runs on `main`.");
  });

  it("celebrates green runs", () => {
    const analysis = analyze([{ id: "t", title: "t", outcome: "passed" }], emptyHistory(), NOW, 30);
    expect(renderComment(analysis, context())).toContain("### ✅ All 1 test passed");
  });

  it("explains the quarantine decision", () => {
    const { analysis } = scenario();
    expect(renderComment(analysis, context({ mode: "quarantine", blocking: 2 }))).toContain(
      "❌ **Quarantine:** 2 failures not tolerated (`flaky`), so this check fails.",
    );
    expect(renderComment(analysis, context({ mode: "quarantine", blocking: 0 }))).toContain(
      "🛡️ **Quarantine:** every failure is tolerated (`flaky`), so this check passes.",
    );
  });

  it("mentions an empty history", () => {
    const analysis = analyze([{ id: "t", title: "t", outcome: "failed" }], emptyHistory(), NOW, 30);
    const body = renderComment(analysis, context({ historyRuns: 0 }));
    expect(body).toContain("**New failure.** No history for this test on `main`.");
    expect(body).toContain("No history on `main` yet.");
  });
});

describe("renderSummary", () => {
  it("adds the ranking of unreliable tests", () => {
    const { history, analysis } = scenario();
    const summary = renderSummary(analysis, rankFlakyTests(history, NOW, 30, 10), context());
    expect(summary).not.toContain("<!-- notmyfault");
    expect(summary).toContain("Most unreliable tests on `main`");
    expect(summary).toContain("| <code>api › flaky</code> | 2 / 10 | 0 | yes |");
  });
});
