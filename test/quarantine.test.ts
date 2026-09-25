import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyze";
import { emptyHistory } from "../src/history";
import type { TestResult } from "../src/junit";
import { applyQuarantine, isActive, matches, parseQuarantine } from "../src/quarantine";

const NOW = new Date("2026-09-16T23:30:00Z");
const test = (title: string, id = `unit › ${title}`): TestResult => ({ id, title, outcome: "failed" });

describe("parseQuarantine", () => {
  it("reads a date, a test name and an optional reason per line", () => {
    expect(
      parseQuarantine(`
        2026-10-01 e2e › checkout › pays with PayPal # PayPal sandbox outage
        2026-09-30   cart › *discount*
      `),
    ).toEqual([
      { until: "2026-10-01", pattern: "e2e › checkout › pays with PayPal", reason: "PayPal sandbox outage" },
      { until: "2026-09-30", pattern: "cart › *discount*" },
    ]);
    expect(parseQuarantine("")).toEqual([]);
  });

  it("rejects lines without a valid date or a test name", () => {
    for (const line of ["cart › totals", "2026-13-01 cart › totals", "2026-02-30 cart › totals", "01/10/2026 cart", "2026-10-01"]) {
      expect(() => parseQuarantine(line), line).toThrow(`Input "quarantine" expects "YYYY-MM-DD test name # reason" per line, got "${line}"`);
    }
  });
});

describe("quarantine entries", () => {
  it("apply until the end of their last day, in UTC", () => {
    expect(isActive({ pattern: "t", until: "2026-09-16" }, NOW)).toBe(true);
    expect(isActive({ pattern: "t", until: "2026-09-15" }, NOW)).toBe(false);
  });

  it("match a test title or identity, or their end, with * as a wildcard", () => {
    expect(matches({ pattern: "cart › totals", until: "2026-10-01" }, test("cart › totals"))).toBe(true);
    const vitest = test("test/cart.test.ts › checkout > applies discount codes", "test/cart.test.ts › checkout > applies discount codes");
    expect(matches({ pattern: "checkout > applies discount codes", until: "2026-10-01" }, vitest)).toBe(true);
    expect(matches({ pattern: "applies discount codes", until: "2026-10-01" }, vitest)).toBe(false);
    expect(matches({ pattern: "totals", until: "2026-10-01" }, test("cart › totals"))).toBe(true);
    expect(matches({ pattern: "otals", until: "2026-10-01" }, test("cart › totals"))).toBe(false);
    expect(matches({ pattern: "unit › cart › totals", until: "2026-10-01" }, test("cart › totals"))).toBe(true);
    expect(matches({ pattern: "cart › *discount*", until: "2026-10-01" }, test("cart › applies discount codes"))).toBe(true);
    expect(matches({ pattern: "cart", until: "2026-10-01" }, test("cart › totals"))).toBe(false);
    expect(matches({ pattern: "pays (EUR) [x]", until: "2026-10-01" }, test("pays (EUR) [x]"))).toBe(true);
  });

  it("mark the failures they cover, only while active", () => {
    const analysis = analyze([test("cart › totals"), test("cart › pays"), test("search")], emptyHistory(), NOW, 30);
    const count = applyQuarantine(
      analysis,
      [
        { pattern: "cart › *", until: "2026-10-01", reason: "sandbox outage" },
        { pattern: "search", until: "2026-09-01" },
      ],
      NOW,
    );
    expect(count).toBe(2);
    expect(Object.fromEntries(analysis.failures.map((f) => [f.test.title, f.quarantined]))).toEqual({
      "cart › pays": { until: "2026-10-01", reason: "sandbox outage" },
      "cart › totals": { until: "2026-10-01", reason: "sandbox outage" },
      search: undefined,
    });
  });

  it("matches a crafted pattern from the repository without stalling the job", () => {
    const entry = { pattern: `${"*a".repeat(40)}*b`, until: "2026-10-01" };
    const test = { id: "x", title: `checkout › ${"a".repeat(300)}`, outcome: "failed" as const };
    const started = Date.now();
    expect(matches(entry, test)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
