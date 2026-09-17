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

  it("runs in any other CI system, from git and NOTMYFAULT_ variables", () => {
    const bare = join(root, "remote", "shop.git");
    mkdirSync(join(root, "remote"));
    execFileSync("git", ["init", "--quiet", "--bare", bare]);
    const workspace = join(root, "workspace");
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", workspace]);
    execFileSync("git", ["-C", workspace, "remote", "add", "origin", `file://${bare}`]);
    execFileSync("git", ["-C", workspace, "-c", "user.name=a", "-c", "user.email=a@b", "commit", "--quiet", "--allow-empty", "-m", "start"]);
    writeFileSync(join(workspace, "junit.xml"), `<testsuite name="s"><testcase name="a"><failure message="boom"/></testcase></testsuite>`);

    const env = { PATH: process.env.PATH, TMPDIR: root, JENKINS_URL: "https://ci.acme.test/", BRANCH_NAME: "main", NOTMYFAULT_JUNIT: "*.xml" };
    const result = spawnSync(process.execPath, [cli], { encoding: "utf8", cwd: workspace, env });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('History updated on branch "notmyfault-history".');
    expect(readFileSync(join(workspace, "notmyfault.env"), "utf8")).toContain("NOTMYFAULT_NEW_FAILURES=1\n");
    expect(execFileSync("git", ["-C", bare, "show", "notmyfault-history:history/tests.json"], { encoding: "utf8" })).toContain('"s › a"');

    // On a developer's machine, nothing is recorded unless asked.
    const local = spawnSync(process.execPath, [cli], { encoding: "utf8", cwd: workspace, env: { PATH: process.env.PATH, TMPDIR: root, NOTMYFAULT_JUNIT: "*.xml" } });
    expect(local.status).toBe(0);
    expect(local.stdout).not.toContain("History updated");
    expect(local.stdout).toContain("Not in a CI system: the history is read, not recorded. Set NOTMYFAULT_RECORD=true to record this run.");
  });

  it("explains what it needs outside of a git clone", () => {
    const result = spawnSync(process.execPath, [cli], { encoding: "utf8", cwd: root, env: { PATH: process.env.PATH } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No repository to store the history in: set NOTMYFAULT_REPOSITORY_URL");
  });
});
