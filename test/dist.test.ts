import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bundle = join(import.meta.dirname, "..", "dist", "index.js");
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "notmyfault-dist-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!existsSync(bundle))("dist/index.js", () => {
  it("runs as a standalone action and records history", () => {
    mkdirSync(join(root, "remote", "acme"), { recursive: true });
    execFileSync("git", ["init", "--quiet", "--bare", join(root, "remote", "acme", "shop.git")]);
    mkdirSync(join(root, "workspace"));
    writeFileSync(
      join(root, "workspace", "junit.xml"),
      `<testsuite name="s"><testcase name="a"/><testcase name="b"><failure message="boom"/></testcase></testsuite>`,
    );
    writeFileSync(join(root, "event.json"), JSON.stringify({ repository: { default_branch: "main" } }));
    writeFileSync(join(root, "summary.md"), "");

    const result = spawnSync(process.execPath, [bundle], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        "INPUT_JUNIT": "*.xml",
        "INPUT_TOKEN": "t",
        "INPUT_HISTORY-BRANCH": "custom-history",
        GITHUB_REPOSITORY: "acme/shop",
        GITHUB_SERVER_URL: `file://${join(root, "remote")}`,
        GITHUB_API_URL: "http://127.0.0.1:9",
        GITHUB_SHA: "c".repeat(40),
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_NAME: "main",
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: join(root, "event.json"),
        GITHUB_WORKFLOW: "CI",
        GITHUB_JOB: "test",
        GITHUB_WORKSPACE: join(root, "workspace"),
        RUNNER_TEMP: root,
        GITHUB_STEP_SUMMARY: join(root, "summary.md"),
      },
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('History updated on branch "custom-history".');
    expect(readFileSync(join(root, "summary.md"), "utf8")).toContain("1 test failed, 1 looks related to this change");
    const stored = execFileSync(
      "git",
      ["-C", join(root, "remote", "acme", "shop.git"), "show", "custom-history:history/ci-test.json"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(stored).tests).toMatchObject({ "s › a": { outcomes: "p" }, "s › b": { outcomes: "f" } });
  });
});
