import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitLabIO } from "../../src/gitlab/io";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notmyfault-gitlab-io-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("GitLabIO", () => {
  it("reads inputs from NOTMYFAULT_ variables", () => {
    const io = new GitLabIO({ NOTMYFAULT_HISTORY_BRANCH: " history ", NOTMYFAULT_COMMENT: "no", NOTMYFAULT_WINDOW: "x" });
    expect(io.input("history-branch")).toBe("history");
    expect(io.input("mode", "report")).toBe("report");
    expect(io.booleanInput("comment", true)).toBe(false);
    expect(() => io.integerInput("window", 50, 5)).toThrow('Variable NOTMYFAULT_WINDOW must be an integer >= 5, got "x"');
  });

  it("writes outputs as dotenv, the summary as Markdown and annotations as Code Quality issues", () => {
    const io = new GitLabIO({ CI_PROJECT_DIR: dir, NOTMYFAULT_OUTPUT_FILE: join(dir, "out.env") }, () => {});
    io.setOutput("new-failures", 2);
    io.setOutput("blocking", 0);
    io.appendSummary("# One");
    io.appendSummary("# Two");
    io.annotation("error", "New failure.\nexpected 1 to be 2", { file: "src/a.test.ts", line: 7, title: "a › b" });
    io.annotation("notice", "Only in the log", { title: "no file" });
    io.finish();

    expect(readFileSync(join(dir, "out.env"), "utf8")).toBe("NOTMYFAULT_NEW_FAILURES=2\nNOTMYFAULT_BLOCKING=0\n");
    expect(readFileSync(join(dir, "notmyfault-summary.md"), "utf8")).toBe("# One\n# Two\n");
    expect(JSON.parse(readFileSync(join(dir, "gl-code-quality-report.json"), "utf8"))).toEqual([
      {
        description: "a › b: New failure. — expected 1 to be 2",
        check_name: "notmyfault",
        fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
        severity: "major",
        location: { path: "src/a.test.ts", lines: { begin: 7 } },
      },
    ]);
  });

  it("replaces masked secrets in everything it writes", () => {
    const lines: string[] = [];
    const io = new GitLabIO({ CI_PROJECT_DIR: dir }, (line) => lines.push(line));
    io.mask("glpat-supersecret");
    io.mask("x");  // Too short to replace safely: it would blank out the report.
    io.info("pushing with glpat-supersecret");
    io.warning("Could not push with glpat-supersecret");
    io.appendSummary("the log said glpat-supersecret");
    io.setOutput("blocking", "glpat-supersecret");
    io.annotation("error", "failed with glpat-supersecret", { file: "a.test.ts", title: "a" });
    io.finish();

    expect(lines.join("\n")).not.toContain("glpat-supersecret");
    expect(lines[0]).toBe("pushing with ***");
    expect(readFileSync(join(dir, "notmyfault-summary.md"), "utf8")).toBe("the log said ***\n");
    expect(readFileSync(join(dir, "notmyfault.env"), "utf8")).toBe("NOTMYFAULT_BLOCKING=***\n");
    expect(readFileSync(join(dir, "gl-code-quality-report.json"), "utf8")).toContain("failed with ***");
  });

  it("starts a new summary on each run", () => {
    const first = new GitLabIO({ CI_PROJECT_DIR: dir }, () => {});
    first.appendSummary("old");
    const second = new GitLabIO({ CI_PROJECT_DIR: dir }, () => {});
    second.appendSummary("new");
    expect(readFileSync(join(dir, "notmyfault-summary.md"), "utf8")).toBe("new\n");
  });

  it("colors warnings and errors and folds groups into collapsed sections", () => {
    const lines: string[] = [];
    const io = new GitLabIO({}, (line) => lines.push(line));
    io.warning("careful");
    io.group("Details");
    io.info("inside");
    io.endGroup();
    io.endGroup();
    expect(lines[0]).toBe("\u001b[33mWarning: careful\u001b[0m");
    expect(lines[1]).toMatch(/^\u001b\[0Ksection_start:\d+:notmyfault_1\[collapsed=true\]\r\u001b\[0KDetails$/);
    expect(lines[2]).toBe("inside");
    expect(lines[3]).toMatch(/^\u001b\[0Ksection_end:\d+:notmyfault_1\r\u001b\[0K$/);
    expect(lines).toHaveLength(4);
  });
});
