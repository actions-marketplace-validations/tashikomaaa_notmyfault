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

describe("durations", () => {
  it("are read from the time attribute, in milliseconds", () => {
    const results = fixture("vitest.xml");
    expect(results.map((r) => r.duration)).toEqual([1, 3, 1]);
    const [none, empty, invalid, long] = parseJUnit(
      `<testsuite><testcase name="a"/><testcase name="b" time=""/><testcase name="c" time="fast"/><testcase name="d" time="12.3456"/></testsuite>`,
    );
    expect([none!.duration, empty!.duration, invalid!.duration, long!.duration]).toEqual([undefined, undefined, undefined, 12346]);
  });
});

describe("location hints", () => {
  it("are collected for tests that ran, with file references for failures only", () => {
    const results = fixture("vitest.xml");
    expect(results.find((r) => r.outcome === "passed")!.hints).toEqual({ names: ["test/cart.test.ts"], references: [] });
    expect(results.find((r) => r.outcome === "failed")!.hints).toEqual({
      names: ["test/cart.test.ts"],
      references: [{ file: "test/cart.test.ts", line: 14 }],
    });
  });

  it("read the file and line attributes of the test case, or the file of its suite", () => {
    const [withLine, fromSuite] = parseJUnit(
      `<testsuite name="Cart" file="tests/Unit/CartTest.php">` +
        `<testcase name="a" classname="Cart" file="tests/test_cart.py" line="12"><failure/></testcase>` +
        `<testcase name="b" classname="Cart" line="nope"><failure/></testcase>` +
        `</testsuite>`,
    );
    expect(withLine!.hints).toMatchObject({ file: "tests/test_cart.py", line: 12, names: ["Cart"] });
    expect(fromSuite!.hints).toEqual({ file: "tests/Unit/CartTest.php", names: ["Cart"], references: [] });
  });

  it("find file:line references in the failure output", () => {
    const jest = fixture("jest.xml").find((r) => r.outcome === "failed")!;
    expect(jest.hints!.references).toEqual([{ file: "/app/math.test.js", line: 10 }]);
    const pytest = fixture("pytest.xml").find((r) => r.title === "tests.test_db › test_migration")!;
    expect(pytest.hints).toEqual({ names: ["tests.test_db", "pytest"], references: [{ file: "conftest.py", line: 8 }] });
    const [surefire] = parseJUnit(
      `<testcase name="pays" classname="com.acme.OrderTest"><failure message="boom">java.lang.AssertionError: boom
	at com.acme.OrderTest.pays(OrderTest.java:42)</failure></testcase>`,
    );
    expect(surefire!.hints!.references).toEqual([{ file: "OrderTest.java", line: 42 }]);
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
