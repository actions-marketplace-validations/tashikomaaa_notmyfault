import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bundle = join(import.meta.dirname, "..", "dist", "index.js");
const cli = join(import.meta.dirname, "..", "dist", "notmyfault.mjs");
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

describe.skipIf(!existsSync(cli))("dist/notmyfault.mjs", () => {
  it("runs in a GitLab CI/CD job", () => {
    mkdirSync(join(root, "remote", "acme"), { recursive: true });
    execFileSync("git", ["init", "--quiet", "--bare", join(root, "remote", "acme", "shop.git")]);
    // GitLab accepts push options, which skip the pipeline of the history branch.
    execFileSync("git", ["-C", join(root, "remote", "acme", "shop.git"), "config", "receive.advertisePushOptions", "true"]);
    mkdirSync(join(root, "workspace"));
    writeFileSync(join(root, "workspace", "junit.xml"), `<testsuite name="s"><testcase name="a"><failure message="boom"/></testcase></testsuite>`);

    const result = spawnSync(process.execPath, [cli], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        TMPDIR: root,
        GITLAB_CI: "true",
        NOTMYFAULT_JUNIT: "*.xml",
        CI_JOB_TOKEN: "t",
        CI_SERVER_URL: `file://${join(root, "remote")}`,
        CI_API_V4_URL: "http://127.0.0.1:9/api/v4",
        CI_PROJECT_ID: "42",
        CI_PROJECT_PATH: "acme/shop",
        CI_PROJECT_DIR: join(root, "workspace"),
        CI_COMMIT_SHA: "c".repeat(40),
        CI_COMMIT_BRANCH: "main",
        CI_DEFAULT_BRANCH: "main",
        CI_PIPELINE_SOURCE: "push",
        CI_JOB_NAME: "test",
      },
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('History updated on branch "notmyfault-history".');
    expect(readFileSync(join(root, "workspace", "notmyfault.env"), "utf8")).toContain("NOTMYFAULT_NEW_FAILURES=1\n");
    expect(readFileSync(join(root, "workspace", "notmyfault-summary.md"), "utf8")).toContain("1 test failed");
  });

  it("refuses to run outside of a CI system it knows", () => {
    const result = spawnSync(process.execPath, [cli], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("neither GITHUB_ACTIONS nor GITLAB_CI is set");
  });
});
