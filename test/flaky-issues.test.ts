import { describe, expect, it } from "vitest";
import { flakyMarker, planFlakyIssues, type FlakySuite } from "../src/flaky-issues";
import type { Issue } from "../src/platform";
import { emptyHistory, type TestHistory } from "../src/history";
import type { TestResult } from "../src/junit";

const NOW = new Date("2026-09-16T12:00:00Z");
const CONTEXT = {
  trackedBranches: ["main"],
  now: NOW,
  evidenceTtlDays: 30,
  sha: "a41c07e9b2f3d5e6f7a8b9c0d1e2f3a4b5c6d7e8",
  runUrl: "https://github.com/acme/shop/actions/runs/1",
};
const PROOF = [{ at: "2026-09-10T08:00:00Z", sha: "3f2a1b9c0d4e", kind: "rerun" as const }];
const FLAKY: Partial<TestHistory> = { outcomes: "ppfpprpfp", evidence: PROOF, lastFailure: "2026-09-10" };

function suite(tests: Record<string, Partial<TestHistory>>, results: TestResult[] = [], key = "ci-test"): FlakySuite {
  const history = emptyHistory();
  for (const [id, test] of Object.entries(tests)) history.tests[id] = { outcomes: "", lastSeen: "2026-09-16", ...test };
  return { key, history, results };
}

const issue = (number: number, id: string, state: Issue["state"] = "open", key = "ci-test"): Issue => ({
  number,
  state,
  body: `${flakyMarker(key, id)}\nnotmyfault found this test flaky.`,
});
const failing = (id: string, message?: string): TestResult => ({ id, title: id, outcome: "failed", ...(message ? { message } : {}) });

describe("planFlakyIssues", () => {
  it("opens an issue for each test proven flaky that failed in the last 30 days", () => {
    const suites = [
      suite({
        "checkout › pays": FLAKY,
        "checkout › totals": { outcomes: "ppppp" },
        "checkout › old": { outcomes: "pfpp", evidence: [{ ...PROOF[0]!, at: "2026-07-01T00:00:00Z" }], lastFailure: "2026-07-01" },
        "checkout › unproven": { outcomes: "pfpfp", lastFailure: "2026-09-15" },
      }),
    ];
    const { actions, postponed } = planFlakyIssues(suites, [], CONTEXT);
    expect(postponed).toBe(0);
    expect(actions).toHaveLength(1);
    const [create] = actions;
    expect(create).toMatchObject({ kind: "create", title: "Flaky test: checkout › pays" });
    if (create?.kind !== "create") throw new Error("expected a created issue");
    expect(create.body.startsWith(flakyMarker("ci-test", "checkout › pays"))).toBe(true);
    expect(create.body).toContain("- **Verdict on `main`:** known flaky");
    expect(create.body).toContain("- **Runs on `main`:** failed 2 of the last 9 runs, and passed only after a retry once");
    expect(create.body).toContain("- **Last failure:** 2026-09-10");
    expect(create.body).toContain("- **Proof:** passed when the same commit was re-run on 2026-09-10");
    expect(create.body).not.toContain("Latest failure");
  });

  it("opens at most 5 issues per run", () => {
    const tests = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`t${i}`, FLAKY]));
    const { actions, postponed } = planFlakyIssues([suite(tests)], [], CONTEXT);
    expect(actions.filter((action) => action.kind === "create")).toHaveLength(5);
    expect(postponed).toBe(2);
  });

  it("updates an open issue only when its test fails, with the latest failure", () => {
    const quiet = planFlakyIssues([suite({ pays: FLAKY })], [issue(12, "pays")], CONTEXT);
    expect(quiet.actions).toEqual([]);

    const failed = planFlakyIssues([suite({ pays: FLAKY }, [failing("pays", "Bank did not answer <100ms>")])], [issue(12, "pays")], CONTEXT);
    expect(failed.actions).toMatchObject([{ kind: "update", issue: 12, reopen: false }]);
    const [update] = failed.actions;
    if (update?.kind !== "update") throw new Error("expected an update");
    expect(update.body).toContain("**Latest failure**, on commit `a41c07e9b2f3`, in [this workflow run](https://github.com/acme/shop/actions/runs/1):");
    expect(update.body).toContain("<pre>Bank did not answer &lt;100ms&gt;</pre>");
  });

  it("reopens a closed issue when its test fails again, and leaves it closed otherwise", () => {
    const closed = [issue(12, "pays", "closed")];
    expect(planFlakyIssues([suite({ pays: FLAKY })], closed, CONTEXT).actions).toEqual([]);
    expect(planFlakyIssues([suite({ pays: FLAKY }, [failing("pays")])], closed, CONTEXT).actions).toMatchObject([
      { kind: "update", issue: 12, reopen: true },
    ]);
  });

  it("closes an issue after 30 days without a failure", () => {
    const { actions } = planFlakyIssues([suite({ pays: { ...FLAKY, lastFailure: "2026-08-10", evidence: [] } })], [issue(12, "pays")], CONTEXT);
    expect(actions).toEqual([
      {
        kind: "close",
        issue: 12,
        comment: "No failure on `main` since 2026-08-10, for more than 30 days: closing this issue. notmyfault reopens it if the test fails again.",
      },
    ]);
  });

  it("closes the issue of a test that left the history, only for the suites of the run", () => {
    const issues = [issue(12, "renamed"), issue(13, "login", "open", "e2e"), issue(14, "gone", "closed")];
    const { actions } = planFlakyIssues([suite({ pays: { outcomes: "ppp" } })], issues, CONTEXT);
    expect(actions).toMatchObject([{ kind: "close", issue: 12 }]);
  });

  it("moves the issue of a renamed test to its new name", () => {
    const renamed = { ...suite({ "pays by card": FLAKY }), renames: [{ from: "pays", to: "pays by card" }] };
    const { actions } = planFlakyIssues([renamed], [issue(12, "pays")], CONTEXT);
    expect(actions).toHaveLength(1);
    const [update] = actions;
    if (update?.kind !== "update") throw new Error("expected an update");
    expect(update).toMatchObject({ issue: 12, reopen: false, title: "Flaky test: pays by card" });
    expect(update.body.startsWith(flakyMarker("ci-test", "pays by card"))).toBe(true);
  });

  it("says when a flaky test fails too many runs in a row", () => {
    const broken = { outcomes: "pppppfff", evidence: PROOF, lastFailure: "2026-09-16" };
    const { actions } = planFlakyIssues([suite({ pays: broken }, [failing("pays")])], [issue(12, "pays")], CONTEXT);
    const [update] = actions;
    if (update?.kind !== "update") throw new Error("expected an update");
    expect(update.body).toContain("- **Verdict on `main`:** already failing, failed the last 3 runs");
    expect(update.body).toContain("_The report has no failure message._");
  });
});
