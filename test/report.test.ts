import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyze, rankFlakyTests, type Verdict } from "../src/analyze";
import { emptyHistory, errorFingerprint } from "../src/history";
import type { TestResult } from "../src/junit";
import {
  commentMarker,
  duration,
  renderComment,
  renderSuitesComment,
  renderSuitesSummary,
  renderSummary,
  type ReportContext,
} from "../src/report";

const NOW = new Date("2026-09-16T12:00:00Z");

/** Matches a verdict badge image followed by `text`. */
function badge(image: string, emoji: string, text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<img src="https://\\S+/verdict-${image}\\.png" alt="${emoji}"[^>]*> ${escaped}`);
}

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
    expect(body).toMatch(badge("new", "🔴", "3 tests failed, 1 looks related to this change"));
    expect(body).toMatch(badge("new", "🔴", "**New failure.** Passed the last 8 runs on `main`."));
    expect(body).toMatch(badge("broken", "⚫", "**Already failing on `main`.** Failed the last 2 runs there."));
    expect(body).toMatch(
      badge(
        "flaky",
        "🟡",
        "**Known flaky.** Failed 2 of the last 10 runs on `main`; passed when the same commit was re-run on 2026-09-12.",
      ),
    );
    expect(body).toContain("🔁 Passed only after a retry: <code>api › ok</code>");
    expect(body).toContain("[Workflow run](https://github.com/o/r/actions/runs/1)");
  });

  it("escapes HTML and table separators coming from test output", () => {
    const { analysis } = scenario();
    const body = renderComment(analysis, context());
    expect(body).toContain("<pre>timeout &lt;5s&gt; &#124; retry</pre>");
  });

  it("renders test names and messages as plain text, without Markdown", () => {
    const title = "[Approve](https://evil.example) *bold* _it_ `tick` ~~s~~ \\ ![img](x)";
    const analysis = analyze(
      [{ id: "t", title, outcome: "failed", message: "see [here](https://evil.example)" }],
      emptyHistory(),
      NOW,
      30,
    );
    const body = renderComment(analysis, context());
    expect(body).not.toMatch(/\]\(https:\/\/evil|\*bold\*|_it_|`tick`|~~s~~|!\[img/);
    expect(body).toContain(
      "<code>&#91;Approve&#93;&#40;https://evil.example&#41; &#42;bold&#42; &#95;it&#95; &#96;tick&#96; &#126;&#126;s&#126;&#126; &#92; &#33;&#91;img&#93;&#40;x&#41;</code>",
    );
    expect(body).toContain("<pre>see &#91;here&#93;&#40;https://evil.example&#41;</pre>");
  });

  it("reassures when no failure looks related to the change", () => {
    const history = emptyHistory();
    history.tests.t = { outcomes: "pfpfpfp", lastSeen: "2026-09-16" };
    const analysis = analyze([{ id: "t", title: "t", outcome: "failed" }], history, NOW, 30);
    expect(renderComment(analysis, context())).toMatch(badge("passed", "🟢", "1 test failed, none of them look like your fault"));
  });

  it("explains failures that are new because of their error", () => {
    const history = emptyHistory();
    const errors = [errorFingerprint("timeout")];
    history.tests = {
      flaky: { outcomes: "pfppfpppfp", lastSeen: "2026-09-16", errors },
      broken: { outcomes: "ppff", lastSeen: "2026-09-16", errors },
    };
    const analysis = analyze(
      ["flaky", "broken"].map((id) => ({ id, title: id, outcome: "failed" as const, message: "expected 1 to be 2" })),
      history,
      NOW,
      30,
    );
    const body = renderComment(analysis, context());
    expect(body).toMatch(badge("new", "🔴", "2 tests failed, 2 look related to this change"));
    expect(body).toMatch(badge("new", "🔴", "**New failure.** Probably flaky on `main`, but this error was never seen there."));
    expect(body).toMatch(badge("new", "🔴", "**New failure.** Already failing on `main`, but this error was never seen there."));
  });

  it("explains why a flaky test counts as already failing", () => {
    const history = emptyHistory();
    history.tests = {
      flaky: { outcomes: "pfpfppfpfrffffff", lastSeen: "2026-09-16" },
      broken: { outcomes: "ppppff", lastSeen: "2026-09-16" },
    };
    const analysis = analyze(
      ["flaky", "broken"].map((id) => ({ id, title: id, outcome: "failed" as const })),
      history,
      NOW,
      30,
    );
    const body = renderComment(analysis, context());
    expect(body).toContain("**Already failing on `main`.** Failed the last 6 runs there, too many in a row to be flakiness.");
    expect(body).toContain("**Already failing on `main`.** Failed the last 2 runs there.");
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
    expect(body).toMatch(badge("flaky", "🟡", "**Probably flaky.** Failed 3 of the last 8 runs on `main`."));
    expect(body).toMatch(badge("suspect", "🟠", "**Suspect.** Failed in isolation twice in the last 8 runs on `main`."));
  });

  it("celebrates green runs", () => {
    const analysis = analyze([{ id: "t", title: "t", outcome: "passed" }], emptyHistory(), NOW, 30);
    expect(renderComment(analysis, context())).toMatch(badge("passed", "✅", "All 1 test passed"));
  });

  it("points badges at images of this repository", () => {
    const { analysis } = scenario();
    const green = analyze([{ id: "t", title: "t", outcome: "passed" }], emptyHistory(), NOW, 30);
    const body = [renderComment(analysis, context()), renderComment(green, context())].join("\n");
    const images = [...body.matchAll(/src="([^"]+)"/g)].map((match) => match[1]!);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      const path = image.replace("https://raw.githubusercontent.com/tashikomaaa/notmyfault/main/", "");
      expect(existsSync(join(import.meta.dirname, "..", path)), image).toBe(true);
    }
  });

  it("lists the tests the run fixes", () => {
    const history = emptyHistory();
    history.tests = { search: { outcomes: "ppffffffff", lastSeen: "2026-09-16" }, cart: { outcomes: "ppf", lastSeen: "2026-09-16" } };
    const analysis = analyze(
      [
        { id: "search", title: "search › accents", outcome: "passed" },
        { id: "cart", title: "cart › totals", outcome: "passed" },
      ],
      history,
      NOW,
      30,
    );
    const body = renderComment(analysis, context());
    expect(body).toMatch(badge("passed", "✅", "All 2 tests passed"));
    expect(body).toContain("🛠️ **Fixed:** 2 tests failing on `main` pass in this run.");
    expect(body).toContain("- <code>cart › totals</code>, failed the latest run there");
    expect(body).toContain("- <code>search › accents</code>, failed the last 8 runs there");
  });

  it("lists passing tests that got much slower", () => {
    const history = emptyHistory();
    history.tests = { "api › search": { outcomes: "ppppp", lastSeen: "2026-09-16", durations: [780, 800, 820, 790, 810] } };
    const analysis = analyze([{ id: "api › search", title: "api › search", outcome: "passed", duration: 2400 }], history, NOW, 30);
    const body = renderComment(analysis, context());
    expect(body).toContain("🐢 **Slower:** 1 passing test took much longer than usual on `main`.");
    expect(body).toContain("- <code>api › search</code>: 2.4 s, usually 800 ms");
  });

  it("formats durations in the unit that reads best", () => {
    expect([0, 999, 1000, 2450, 59_949, 60_000, 125_400].map(duration)).toEqual(["0 ms", "999 ms", "1.0 s", "2.5 s", "59.9 s", "1 min 0 s", "2 min 5 s"]);
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

describe("several suites", () => {
  it("share one headline, then get a section each", () => {
    const { history, analysis } = scenario();
    const green = analyze([{ id: "e2e › logs in", title: "e2e › logs in", outcome: "passed" }], emptyHistory(), NOW, 30);
    const suites = [
      { name: "unit", analysis, historyRuns: 40, ranking: rankFlakyTests(history, NOW, 30, 10) },
      { name: "e2e", analysis: green, historyRuns: 0 },
    ];
    const body = renderSuitesComment(suites, context({ key: "unit+e2e", mode: "quarantine", blocking: 1 }));
    expect(body.startsWith(commentMarker("unit+e2e"))).toBe(true);
    expect(body).toMatch(badge("new", "🔴", "3 tests failed, 1 looks related to this change"));
    expect(body).toContain("#### unit\n");
    expect(body).toContain("#### e2e\n\n");
    expect(body).toMatch(badge("passed", "✅", "All 1 test passed."));
    expect(body).toContain("No history on `main` yet for e2e.");
    expect(body.match(/Quarantine:/g)).toHaveLength(1);
    expect(body.match(/Reported by/g)).toHaveLength(1);
    expect(body.indexOf("#### unit")).toBeLessThan(body.indexOf("**New failure.**"));
    expect(body.indexOf("**New failure.**")).toBeLessThan(body.indexOf("#### e2e"));

    const summary = renderSuitesSummary(suites, context({ key: "unit+e2e" }));
    expect(summary).toContain("Most unreliable tests of unit on `main`");
  });
});

describe("renderSummary", () => {
  it("adds the ranking of unreliable tests", () => {
    const { history, analysis } = scenario();
    const summary = renderSummary(analysis, rankFlakyTests(history, NOW, 30, 10), context());
    expect(summary).not.toContain("<!-- notmyfault");
    expect(summary).toContain("Most unreliable tests on `main`");
    expect(summary).toContain("| <code>api › flaky</code> | 2 / 10 | 0 | yes |");
    const slowest = renderSummary(analysis, [], context());
    expect(slowest).not.toContain("Slowest tests");
  });

  it("lists the slowest tests in the summary", () => {
    const { analysis } = scenario();
    const summary = renderSuitesSummary(
      [{ name: "ci-test", analysis, historyRuns: 40, slowest: [{ id: "e2e › checkout", median: 12_300, fastest: 9800, slowest: 31_000, runs: 10 }] }],
      context(),
    );
    expect(summary).toContain("<details><summary>Slowest tests on `main`</summary>");
    expect(summary).toContain("| <code>e2e › checkout</code> | 12.3 s | 9.8 s | 31.0 s | 10 |");
  });
});
