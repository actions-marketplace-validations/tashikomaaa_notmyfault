import { describe, expect, it } from "vitest";
import type { LocationHints, TestResult } from "../src/junit";
import { locate } from "../src/locate";

const WORKSPACE = "/home/runner/work/shop/shop";
const FILES = new Set([
  "test/cart.test.ts",
  "tests/test_api.py",
  "src/test/java/com/acme/OrderTest.java",
  "math.test.js",
  "node_modules/vitest/dist/index.js",
]);
const exists = (path: string) => FILES.has(path);
const failed = (hints: Partial<LocationHints>): TestResult => ({
  id: "t",
  title: "t",
  outcome: "failed",
  hints: { names: [], references: [], ...hints },
});

describe("locate", () => {
  it("uses the file and line attributes", () => {
    expect(locate(failed({ file: "tests/test_api.py", line: 12 }), WORKSPACE, exists)).toEqual({
      file: "tests/test_api.py",
      line: 12,
    });
    expect(locate(failed({ file: `${WORKSPACE}/tests/test_api.py` }), WORKSPACE, exists)).toEqual({ file: "tests/test_api.py" });
  });

  it("recognizes class and suite names that are files, modules or classes", () => {
    const vitest = failed({ names: ["test/cart.test.ts"], references: [{ file: "test/cart.test.ts", line: 14 }] });
    expect(locate(vitest, WORKSPACE, exists)).toEqual({ file: "test/cart.test.ts", line: 14 });
    expect(locate(failed({ names: ["tests.test_api", "pytest"] }), WORKSPACE, exists)).toEqual({ file: "tests/test_api.py" });
    const surefire = failed({ names: ["com.acme.OrderTest"], references: [{ file: "OrderTest.java", line: 42 }] });
    expect(locate(surefire, WORKSPACE, exists)).toEqual({ file: "src/test/java/com/acme/OrderTest.java", line: 42 });
  });

  it("falls back to the first reference to a file of the workspace", () => {
    const jest = failed({
      names: ["math divides by zero"],
      references: [
        { file: `${WORKSPACE}/node_modules/vitest/dist/index.js`, line: 3 },
        { file: `${WORKSPACE}/math.test.js`, line: 10 },
      ],
    });
    expect(locate(jest, WORKSPACE, exists)).toEqual({ file: "math.test.js", line: 10 });
  });

  it("ignores files outside the workspace, in node_modules or missing", () => {
    const nowhere = failed({
      names: ["missing.test.ts"],
      references: [
        { file: "/app/math.test.js", line: 10 },
        { file: "node_modules/vitest/dist/index.js", line: 3 },
        { file: "../shop/math.test.js", line: 1 },
      ],
    });
    expect(locate(nowhere, WORKSPACE, exists)).toBeUndefined();
    expect(locate({ id: "t", title: "t", outcome: "failed" }, WORKSPACE, exists)).toBeUndefined();
  });
});
