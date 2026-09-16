import { describe, expect, it } from "vitest";
import { emptyHistory } from "../src/history";
import { renderIndexPage, renderSuitePage, reportPath } from "../src/html-report";

const CONTEXT = { trackedBranches: ["main"], now: new Date("2026-09-16T12:00:00Z"), evidenceTtlDays: 30 };

function history() {
  const history = emptyHistory();
  history.runs = 42;
  history.updatedAt = "2026-09-16T10:04:12.000Z";
  history.tests = {
    "unit › stable": { outcomes: "pppppp", lastSeen: "2026-09-16" },
    "unit › <script>alert(1)</script>": { outcomes: "pppfpp", lastSeen: "2026-09-16", lastFailure: "2026-09-12" },
    "unit › pays": {
      outcomes: "pfpprf",
      lastSeen: "2026-09-16",
      lastFailure: "2026-09-16",
      evidence: [{ at: "2026-09-14T08:00:00Z", sha: "abc", kind: "rerun" }],
      durations: [800, 1200, 900],
    },
  };
  return history;
}

describe("renderSuitePage", () => {
  it("lists unreliable tests, most unreliable first, and only counts stable ones", () => {
    const page = renderSuitePage("ci-test", history(), CONTEXT);
    expect(page).toContain("<title>notmyfault: ci-test</title>");
    expect(page).toContain("42 runs recorded on <code>main</code>, last updated 2026-09-16 10:04 UTC. 2 unreliable tests listed, 1 stable test not listed.");
    expect(page).not.toContain("unit › stable");
    expect(page.indexOf("unit › pays")).toBeLessThan(page.indexOf("unit › &lt;script&gt;"));
    expect(page).not.toContain("<script>");
    expect(page).toContain('<span class="verdict flaky">Known flaky</span>');
    expect(page).toContain('aria-label="3 passed, 1 passed after a retry, 2 failed"');
    expect(page).toContain('<i class="p"></i><i class="f"></i><i class="p"></i><i class="p"></i><i class="r"></i><i class="f"></i>');
    expect(page).toContain("<td>Passed on re-run, 2026-09-14</td>");
    expect(page).toContain('<td class="number">900 ms</td>');
  });

  it("says when no test failed", () => {
    const quiet = emptyHistory();
    quiet.tests = { stable: { outcomes: "ppp", lastSeen: "2026-09-16" } };
    expect(renderSuitePage("ci-test", quiet, CONTEXT)).toContain("No test failed or needed a retry in the remembered runs.");
  });
});

describe("renderIndexPage", () => {
  it("links to the page of each key", () => {
    const page = renderIndexPage(["ci-e2e", "ci-test"], CONTEXT);
    expect(page).toContain('<li><a href="reports/ci-e2e.html">ci-e2e</a></li>');
    expect(page).toContain('<li><a href="reports/ci-test.html">ci-test</a></li>');
    expect(reportPath("ci-test")).toBe("reports/ci-test.html");
  });
});
