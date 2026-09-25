import { describe, expect, it } from "vitest";
import { emptyHistory, type TestHistory } from "../src/history";
import type { Outcome, TestResult } from "../src/junit";
import { applyRenames, detectRenames, similarity } from "../src/renames";

const result = (id: string, outcome: Outcome = "passed"): TestResult => ({ id, title: id, outcome });

/** A history whose last tracked run was run 5, with the given tests in it unless told otherwise. */
function history(tests: Record<string, Partial<TestHistory>>) {
  const h = emptyHistory();
  h.runs = 5;
  for (const [id, test] of Object.entries(tests)) h.tests[id] = { outcomes: "ppppp", lastSeen: "2026-09-15", lastRun: 5, ...test };
  return h;
}

describe("detectRenames", () => {
  it("follows one test replaced by a similar one in the same file", () => {
    const h = history({ "cart.test.ts › applies discount codes": {}, "cart.test.ts › adds up": {} });
    const results = [result("cart.test.ts › applies the discount codes", "failed"), result("cart.test.ts › adds up")];
    expect(detectRenames(h, results)).toEqual([
      { from: "cart.test.ts › applies discount codes", to: "cart.test.ts › applies the discount codes" },
    ]);
  });

  it("follows tests moved to another file, keeping their name", () => {
    const h = history({
      "cart.test.ts › adds up the basket": {},
      "cart.test.ts › applies discount codes": {},
      "cart.test.ts › computes the total": {},
    });
    // The suite is split: two tests move to a file of their own, one stays.
    const results = [
      result("cart.test.ts › adds up the basket"),
      result("discounts.test.ts › applies discount codes"),
      result("totals.test.ts › computes the total"),
    ];
    expect(detectRenames(h, results)).toEqual([
      { from: "cart.test.ts › applies discount codes", to: "discounts.test.ts › applies discount codes", moved: true },
      { from: "cart.test.ts › computes the total", to: "totals.test.ts › computes the total", moved: true },
    ]);
  });

  it("leaves a move alone when the name is not the only clue", () => {
    // Two tests of the same name leave, one appears: which one moved cannot be told.
    const twice = history({ "cart.test.ts › totals": {}, "checkout.test.ts › totals": {} });
    expect(detectRenames(twice, [result("orders.test.ts › totals")])).toEqual([]);

    // The file that lost the test also gained one: it reads as a rename in place, not as a move.
    const mixed = history({ "cart.test.ts › totals": {}, "cart.test.ts › adds up": {} });
    expect(detectRenames(mixed, [result("cart.test.ts › adds up"), result("cart.test.ts › sums up"), result("orders.test.ts › totals")])).toEqual(
      [],
    );
  });

  it("leaves alone dissimilar names, several candidates, other files and older tests", () => {
    const h = history({
      "cart.test.ts › applies discount codes": {},
      "search.test.ts › finds products": {},
      "search.test.ts › splits words": {},
      "payments.test.ts › charges cards": { lastRun: 3 },
    });
    const results = [
      result("cart.test.ts › rejects expired cards"),
      result("search.test.ts › finds all products"),
      result("search.test.ts › splits all words"),
      result("payments.test.ts › charges the cards"),
      result("orders.test.ts › finds products"),
    ];
    expect(detectRenames(h, results)).toEqual([]);
  });

  it("does nothing on the first run, and ignores skipped tests", () => {
    const first = history({ "a › slow test": {} });
    first.runs = 0;
    expect(detectRenames(first, [result("a › slow tests")])).toEqual([]);
    expect(detectRenames(history({ "a › slow test": {} }), [result("a › slow tests", "skipped")])).toEqual([]);
  });

  it("treats a test only remembered from pull requests as new", () => {
    const h = history({ "a › computes totals": {}, "a › computes the totals": { outcomes: "", failedOn: ["abc"], lastRun: undefined } });
    expect(detectRenames(h, [result("a › computes the totals")])).toEqual([{ from: "a › computes totals", to: "a › computes the totals" }]);
  });
});

describe("applyRenames", () => {
  it("moves the history, merging what pull requests remembered about the new name", () => {
    const h = history({
      "a › computes totals": { outcomes: "pfp", failedOn: ["old"], evidence: [{ at: "2026-09-10T00:00:00Z", sha: "old", kind: "rerun" }] },
      "a › computes the totals": { outcomes: "", failedOn: ["new"], evidence: [{ at: "2026-09-14T00:00:00Z", sha: "new", kind: "retry" }], lastSeen: "2026-09-16" },
    });
    applyRenames(h, [{ from: "a › computes totals", to: "a › computes the totals" }]);
    expect(Object.keys(h.tests)).toEqual(["a › computes the totals"]);
    expect(h.tests["a › computes the totals"]).toMatchObject({
      outcomes: "pfp",
      failedOn: ["old", "new"],
      evidence: [{ sha: "old" }, { sha: "new" }],
      lastSeen: "2026-09-16",
    });
  });
});

describe("similarity", () => {
  it("goes from 0 to 1 with the edit distance", () => {
    expect(similarity("abc", "abc")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
    expect(similarity("computes totals", "computes the totals")).toBeCloseTo(0.79, 2);
  });
});
