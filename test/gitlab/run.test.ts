import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitLabIO } from "../../src/gitlab/io";
import { gitlabPlatform } from "../../src/gitlab/platform";
import { runOn } from "../../src/main";

interface Note {
  id: number;
  body: string;
  system: boolean;
}

interface FakeIssue {
  iid: number;
  title: string;
  description: string;
  state: "opened" | "closed";
  labels: string[];
  notes: string[];
}

const PROJECT = 42;
const MERGE_REQUEST = 3;

/** In-memory stand-in for the notes, issues and labels API of project 42. */
class FakeGitLab {
  notes: Note[] = [{ id: 1, body: "added 1 commit", system: true }];
  issues: FakeIssue[] = [];
  labels: string[] = [];
  /** Method, path and the header carrying the token. */
  requests: string[] = [];
  status = 200;
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const header = req.headers["private-token"] ? "PRIVATE-TOKEN" : req.headers["job-token"] ? "JOB-TOKEN" : "none";
        this.requests.push(`${req.method} ${req.url} ${header}`);
        if (this.status !== 200) {
          res.writeHead(this.status).end(JSON.stringify({ message: "403 Forbidden" }));
          return;
        }
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const url = new URL(req.url ?? "/", "http://api");
        const path = url.pathname.replace(`/api/v4/projects/${PROJECT}`, "");
        const reply = (status: number, value: unknown) =>
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
        const route = (method: string, pattern: RegExp) => (req.method === method ? pattern.exec(path) : null);
        const issue = (iid: string) => this.issues.find((i) => i.iid === Number(iid));
        let match: RegExpExecArray | null;

        if (route("GET", new RegExp(`^/merge_requests/${MERGE_REQUEST}/notes$`))) {
          reply(200, this.notes);
        } else if (route("POST", new RegExp(`^/merge_requests/${MERGE_REQUEST}/notes$`))) {
          const note = { id: this.notes.length + 1, body: String(body.body), system: false };
          this.notes.push(note);
          reply(201, note);
        } else if ((match = route("PUT", new RegExp(`^/merge_requests/${MERGE_REQUEST}/notes/(\\d+)$`)))) {
          const note = this.notes.find((n) => n.id === Number(match![1]));
          if (note) note.body = String(body.body);
          reply(200, note);
        } else if ((match = route("POST", /^\/issues\/(\d+)\/notes$/))) {
          issue(match[1]!)?.notes.push(String(body.body));
          reply(201, {});
        } else if (route("GET", /^\/issues$/)) {
          const label = url.searchParams.get("labels");
          reply(200, this.issues.filter((i) => !label || i.labels.includes(label)));
        } else if (route("POST", /^\/issues$/)) {
          const created: FakeIssue = {
            iid: this.issues.length + 1,
            title: String(body.title),
            description: String(body.description),
            state: "opened",
            labels: String(body.labels).split(","),
            notes: [],
          };
          this.issues.push(created);
          reply(201, created);
        } else if ((match = route("PUT", /^\/issues\/(\d+)$/))) {
          const updated = issue(match[1]!);
          if (updated) {
            if (body.title !== undefined) updated.title = String(body.title);
            if (body.description !== undefined) updated.description = String(body.description);
            if (body.state_event) updated.state = body.state_event === "close" ? "closed" : "opened";
          }
          reply(200, updated);
        } else if ((match = route("GET", /^\/labels\/(.+)$/))) {
          if (this.labels.includes(decodeURIComponent(match[1]!))) reply(200, {});
          else reply(404, { message: "404 Label Not Found" });
        } else if (route("POST", /^\/labels$/)) {
          this.labels.push(`${String(body.name)} ${String(body.color)}`);
          reply(201, body);
        } else {
          reply(404, { message: "404 Not Found" });
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/api/v4`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }
}

let root: string;
let api: FakeGitLab;
let apiUrl: string;
let clock: number;

const bare = () => join(root, "remote", "acme", "shop.git");
const workspace = () => join(root, "workspace");

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "notmyfault-gitlab-"));
  mkdirSync(join(root, "remote", "acme"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--bare", bare()]);
  execFileSync("git", ["-C", bare(), "config", "receive.advertisePushOptions", "true"]);
  // Keeps the push options of the last push, as GitLab reads them.
  const hook = join(bare(), "hooks", "pre-receive");
  writeFileSync(hook, `#!/bin/sh\nenv | grep '^GIT_PUSH_OPTION_[0-9]' | sort > "${join(root, "push-options")}"\ncat > /dev/null\n`);
  chmodSync(hook, 0o755);
  mkdirSync(join(workspace(), "reports"), { recursive: true });
  mkdirSync(join(workspace(), "spec"));
  writeFileSync(join(workspace(), "spec", "checkout.spec.ts"), "");
  api = new FakeGitLab();
  apiUrl = await api.start();
  clock = Date.parse("2026-09-01T10:00:00Z");
});

afterEach(async () => {
  await api.stop();
  rmSync(root, { recursive: true, force: true });
});

type Outcomes = Record<string, "pass" | `fail: ${string}`>;

interface RunOptions {
  mergeRequest?: boolean;
  fork?: boolean;
  sha?: string;
  /** NOTMYFAULT_* variables, by input name. */
  variables?: Record<string, string>;
  jobTokenOnly?: boolean;
}

async function simulate(outcomes: Outcomes, options: RunOptions = {}) {
  const cases = Object.entries(outcomes)
    .map(([name, outcome]) =>
      outcome === "pass"
        ? `<testcase classname="checkout" name="${name}" file="spec/checkout.spec.ts"/>`
        : `<testcase classname="checkout" name="${name}" file="spec/checkout.spec.ts"><failure message="${outcome.slice(6)}"/></testcase>`,
    )
    .join("");
  writeFileSync(join(workspace(), "reports", "junit.xml"), `<testsuites><testsuite name="unit">${cases}</testsuite></testsuites>`);
  for (const file of ["notmyfault.env", "notmyfault-summary.md", "gl-code-quality-report.json"]) rmSync(join(workspace(), file), { force: true });

  const job = String(clock / 1000);
  const env: NodeJS.ProcessEnv = {
    GITLAB_CI: "true",
    NOTMYFAULT_JUNIT: "reports/*.xml",
    ...(options.jobTokenOnly ? {} : { NOTMYFAULT_TOKEN: "project-token" }),
    ...Object.fromEntries(Object.entries(options.variables ?? {}).map(([k, v]) => [`NOTMYFAULT_${k.toUpperCase().replace(/-/g, "_")}`, v])),
    CI_JOB_TOKEN: "job-token",
    CI_SERVER_URL: `file://${join(root, "remote")}`,
    CI_API_V4_URL: apiUrl,
    CI_PROJECT_ID: String(PROJECT),
    CI_PROJECT_PATH: "acme/shop",
    CI_PROJECT_DIR: workspace(),
    CI_DEFAULT_BRANCH: "main",
    CI_COMMIT_SHA: options.sha ?? String(clock).padEnd(40, "0"),
    CI_PIPELINE_ID: "900",
    CI_JOB_ID: job,
    CI_JOB_NAME: "unit tests",
    CI_JOB_URL: `https://gitlab.example.com/acme/shop/-/jobs/${job}`,
    ...(options.mergeRequest
      ? {
          CI_PIPELINE_SOURCE: "merge_request_event",
          CI_MERGE_REQUEST_IID: String(MERGE_REQUEST),
          CI_MERGE_REQUEST_PROJECT_ID: String(PROJECT),
          CI_MERGE_REQUEST_SOURCE_PROJECT_ID: options.fork ? "77" : String(PROJECT),
        }
      : { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "main" }),
  };
  const logs: string[] = [];
  const now = new Date(clock);
  clock += 60 * 60 * 1000;
  const code = await runOn(gitlabPlatform(env, new GitLabIO(env, (line) => logs.push(line))), now);
  const read = (file: string) => (existsSync(join(workspace(), file)) ? readFileSync(join(workspace(), file), "utf8") : undefined);
  return {
    code,
    logs: logs.join("\n"),
    summary: read("notmyfault-summary.md"),
    dotenv: read("notmyfault.env"),
    codeQuality: JSON.parse(read("gl-code-quality-report.json") ?? "null") as unknown,
  };
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", bare(), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

describe("runOn GitLab", () => {
  it("learns from the default branch, then tells a merge request which failures are its fault", async () => {
    for (const pays of ["pass", "fail: bank timeout", "pass", "fail: bank timeout", "pass", "pass", "fail: bank timeout", "pass"] as const) {
      expect((await simulate({ pays, totals: "pass" })).code).toBe(0);
    }
    expect(JSON.parse(git("show", "notmyfault-history:history/unit-tests.json")).tests).toMatchObject({
      "unit › checkout › pays": { outcomes: "pfpfppfp" },
    });
    expect(git("log", "-1", "--format=%an <%ae>|%s", "notmyfault-history").trim()).toMatch(
      /^notmyfault <notmyfault@noreply\.gitlab\.com>\|Record unit-tests \(pipeline 900, job \d+\)$/,
    );
    // History pushes start no pipeline.
    expect(readFileSync(join(root, "push-options"), "utf8")).toBe("GIT_PUSH_OPTION_0=ci.skip\n");
    expect(git("show", "notmyfault-history:README.md")).toContain("maintained by [notmyfault]");

    const mr = await simulate(
      { pays: "fail: bank timeout", totals: "fail: expected 3 to be 4" },
      { mergeRequest: true, sha: "a".repeat(40), variables: { mode: "quarantine" } },
    );
    expect(mr.code).toBe(1);
    expect(mr.dotenv).toContain("NOTMYFAULT_NEW_FAILURES=1\n");
    expect(mr.dotenv).toContain("NOTMYFAULT_FLAKY_FAILURES=1\n");
    expect(mr.dotenv).toContain("NOTMYFAULT_BLOCKING=1\n");
    expect(mr.logs).toContain("Merge request comment created.");
    expect(mr.logs).toContain("\u001b[31mError: 1 failing test(s) are not tolerated in quarantine mode: checkout › totals\u001b[0m");
    expect(mr.logs).toMatch(/\u001b\[0Ksection_start:\d+:notmyfault_1\[collapsed=true\]\r\u001b\[0K/);
    expect(mr.logs).not.toContain("project-token");
    expect(mr.logs).not.toContain("only flaky tests failed");

    const notes = api.notes.filter((note) => !note.system);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body.startsWith("<!-- notmyfault:unit-tests -->")).toBe(true);
    expect(notes[0]!.body).toContain("**New failure.** Passed the last 8 runs on `main`.");
    expect(notes[0]!.body).toContain(`[CI job](https://gitlab.example.com/acme/shop/-/jobs/`);
    expect(mr.summary).toContain("1 looks related to this change");
    expect(mr.codeQuality).toMatchObject([
      { check_name: "notmyfault", severity: "major", location: { path: "spec/checkout.spec.ts", lines: { begin: 1 } } },
      { check_name: "notmyfault", severity: "info", location: { path: "spec/checkout.spec.ts", lines: { begin: 1 } } },
    ]);
    expect(api.requests.filter((request) => request.includes("/notes")).every((request) => request.endsWith("PRIVATE-TOKEN"))).toBe(true);
    // Merge request pipelines never record history.
    expect(JSON.parse(git("show", "notmyfault-history:history/unit-tests.json")).runs).toBe(8);

    const fixed = await simulate({ pays: "pass", totals: "pass" }, { mergeRequest: true, sha: "b".repeat(40) });
    expect(fixed.code).toBe(0);
    expect(api.notes.filter((note) => !note.system)).toHaveLength(1);
    expect(api.notes.at(-1)!.body).toMatch(/All 2 tests passed/);
    expect(fixed.codeQuality).toEqual([]);
  });

  it("opens and closes an issue per flaky test", async () => {
    const variables = { "flaky-issues": "true" };
    await simulate({ pays: "fail: socket hang up" }, { sha: "c".repeat(40) });
    const rerun = await simulate({ pays: "pass" }, { sha: "c".repeat(40), variables });
    expect(rerun.logs).toContain("Flaky test issues: 1 created, 0 updated, 0 closed.");
    expect(api.labels).toEqual(["flaky-test #fcbd34"]);
    expect(api.issues).toMatchObject([{ iid: 1, title: "Flaky test: checkout › pays", state: "opened", labels: ["flaky-test"] }]);
    expect(api.issues[0]!.description).toContain("<!-- notmyfault:flaky:unit-tests:");

    clock += 31 * 24 * 60 * 60 * 1000;
    const quiet = await simulate({ pays: "pass" }, { variables });
    expect(quiet.logs).toContain("Flaky test issues: 0 created, 0 updated, 1 closed.");
    expect(api.issues[0]).toMatchObject({ state: "closed" });
    expect(api.issues[0]!.notes).toHaveLength(1);
  });

  it("falls back to the job token, and explains what it cannot do", async () => {
    api.status = 403;
    const mr = await simulate({ totals: "fail: boom" }, { mergeRequest: true, jobTokenOnly: true });
    expect(mr.code).toBe(0);
    expect(api.requests.at(-1)).toMatch(/JOB-TOKEN$/);
    expect(mr.logs).toContain("Warning: Could not comment on the merge request. Does NOTMYFAULT_TOKEN have the api scope");
  });

  it("does not record merge requests from forks", async () => {
    const mr = await simulate({ totals: "fail: boom" }, { mergeRequest: true, fork: true });
    expect(mr.logs).toContain("Merge request from a fork: the token is read-only, history is not recorded.");
    expect(() => git("show", "notmyfault-history:history/unit-tests.json")).toThrow();
  });

  it("names variables in errors", async () => {
    const result = await simulate({ ok: "pass" }, { variables: { mode: "strict" } });
    expect(result.code).toBe(1);
    expect(result.logs).toContain('Error: Variable NOTMYFAULT_MODE must be "report" or "quarantine", got "strict"');
    const mixed = await simulate({ ok: "pass" }, { variables: { suites: "unit: reports/*.xml" } });
    expect(mixed.logs).toContain(
      "Error: Variables NOTMYFAULT_JUNIT and NOTMYFAULT_KEY cannot be used with NOTMYFAULT_SUITES: name each suite and its reports in NOTMYFAULT_SUITES.",
    );
    // The Code Quality report is written even when the run fails, so the artifact always exists.
    expect(mixed.codeQuality).toEqual([]);
  });
});
