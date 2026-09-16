import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { combineReports, parseJUnit, type TestResult } from "../src/junit";

const fixture = (name: string) => parseJUnit(readFileSync(join(import.meta.dirname, "fixtures/junit", name), "utf8"));
const byTitle = (results: TestResult[]) => Object.fromEntries(results.map((r) => [r.title, r.outcome]));

describe("parseJUnit", () => {
  it("reads jest-junit reports", () => {
    const results = fixture("jest.xml");
    expect(byTitle(results)).toEqual({
      "math adds numbers": "passed",
      "math divides by zero": "failed",
      "math skipped one": "skipped",
    });
    expect(results.find((r) => r.outcome === "failed")?.message).toBe("Error: expect(received).toThrow()");
  });

  it("reads pytest reports, treating errors as failures", () => {
    const results = fixture("pytest.xml");
    expect(byTitle(results)).toEqual({
      "tests.test_api › test_create_user": "passed",
      "tests.test_api › test_delete_user": "failed",
      "tests.test_db › test_migration": "failed",
      "tests.test_db › test_slow": "skipped",
    });
    expect(results[1]!.id).toBe("pytest › tests.test_api › test_delete_user");
    expect(results[2]!.message).toBe('failed on setup with "ConnectionError: db down"');
  });

  it("reads go-junit-report output without duplicating the package name", () => {
    const results = fixture("go-junit-report.xml");
    expect(results.map((r) => r.id)).toEqual([
      "github.com/acme/app/cache › TestGet",
      "github.com/acme/app/cache › TestExpire",
      "github.com/acme/app/cache › TestExpire/short_ttl",
    ]);
    expect(results[1]!.message).toBe("Failed");
  });

  it("detects retries reported as repeated test cases (gotestsum --rerun-fails)", () => {
    expect(byTitle(fixture("gotestsum-rerun.xml"))).toEqual({
      "github.com/acme/app/queue › TestPublish": "flaky",
      // Passing first then failing is a failure, not flakiness.
      "github.com/acme/app/queue › TestConsume": "failed",
    });
  });

  it("detects Maven Surefire flakyFailure and keeps rerunFailure as failed", () => {
    const results = fixture("surefire-rerun.xml");
    expect(byTitle(results)).toEqual({
      "com.acme.OrderServiceTest › placesOrder": "flaky",
      "com.acme.OrderServiceTest › cancelsOrder": "passed",
      "com.acme.OrderServiceTest › refundsOrder": "failed",
    });
    expect(results[0]!.message).toBe("expected: <PAID> but was: <PENDING>");
  });

  it("detects cargo-nextest retries", () => {
    expect(byTitle(fixture("nextest.xml"))).toEqual({
      "acme-core › parser::tests::parses_header": "passed",
      "acme-core › net::tests::reconnects": "flaky",
      "acme-core › io::tests::writes_file": "failed",
    });
  });

  it("does not mistake Playwright projects for retries", () => {
    expect(byTitle(fixture("playwright.xml"))).toEqual({
      "login.spec.ts › login › shows error on bad password": "passed",
      "login.spec.ts › login › redirects after sign in": "failed",
    });
  });

  it("reads vitest reports", () => {
    const results = fixture("vitest.xml");
    expect(byTitle(results)).toEqual({
      "test/cart.test.ts › cart > adds an item": "passed",
      "test/cart.test.ts › cart > applies discount": "failed",
      "test/cart.test.ts › cart > empties": "passed",
    });
    expect(results[1]!.message).toBe("expected 90 to be 81 // Object.is equality");
  });

  it("ignores test cases without a name and handles a bare testcase root", () => {
    expect(parseJUnit(`<testcase classname="x"/><testcase name="ok"/>`)).toEqual([
      { id: "ok", title: "ok", outcome: "passed" },
    ]);
  });

  it("truncates very long messages", () => {
    const long = "x".repeat(1000);
    const [result] = parseJUnit(`<testcase name="t"><failure message="${long}"/></testcase>`);
    expect(result!.message).toHaveLength(300);
    expect(result!.message!.endsWith("…")).toBe(true);
  });
});

describe("combineReports", () => {
  it("keeps the worst outcome when a test appears in several reports", () => {
    const a: TestResult[] = [
      { id: "t1", title: "t1", outcome: "failed" },
      { id: "t2", title: "t2", outcome: "passed" },
    ];
    const b: TestResult[] = [
      { id: "t1", title: "t1", outcome: "passed" },
      { id: "t2", title: "t2", outcome: "skipped" },
      { id: "t3", title: "t3", outcome: "flaky" },
    ];
    expect(byTitle(combineReports([a, b]))).toEqual({ t1: "failed", t2: "passed", t3: "flaky" });
  });
});
