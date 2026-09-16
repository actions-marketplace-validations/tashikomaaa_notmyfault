import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionIO } from "../src/actions";
import { findFiles, run, sanitizeKey } from "../src/main";

interface Comment {
  id: number;
  body: string;
}

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  comments: string[];
}

const PULL_REQUEST = 7;

/** In-memory stand-in for the issues, comments and labels API of acme/shop. */
class FakeGitHub {
  /** Comments on the pull request. */
  comments: Comment[] = [];
  issues: FakeIssue[] = [];
  labels: string[] = [];
  requests: string[] = [];
  status = 200;
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        this.requests.push(`${req.method} ${req.url}`);
        if (this.status !== 200) {
          res.writeHead(this.status).end(JSON.stringify({ message: "Resource not accessible by integration" }));
          return;
        }
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const url = new URL(req.url ?? "/", "http://api");
        const path = url.pathname.replace("/repos/acme/shop", "");
        const reply = (status: number, value: unknown) =>
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
        const route = (method: string, pattern: RegExp) => (req.method === method ? pattern.exec(path) : null);
        let match: RegExpExecArray | null;

        if ((match = route("GET", /^\/issues\/(\d+)\/comments$/))) {
          reply(200, Number(match[1]) === PULL_REQUEST ? this.comments : []);
        } else if ((match = route("POST", /^\/issues\/(\d+)\/comments$/))) {
          if (Number(match[1]) === PULL_REQUEST) {
            const comment = { id: this.comments.length + 1, body: String(body.body) };
            this.comments.push(comment);
            reply(201, comment);
          } else {
            this.issues.find((issue) => issue.number === Number(match![1]))?.comments.push(String(body.body));
            reply(201, {});
          }
        } else if ((match = route("PATCH", /^\/issues\/comments\/(\d+)$/))) {
          const comment = this.comments.find((c) => c.id === Number(match![1]));
          if (comment) comment.body = String(body.body);
          reply(200, comment);
        } else if (route("GET", /^\/issues$/)) {
          const label = url.searchParams.get("labels");
          reply(200, this.issues.filter((issue) => !label || issue.labels.includes(label)));
        } else if (route("POST", /^\/issues$/)) {
          const issue: FakeIssue = {
            number: 100 + this.issues.length,
            title: String(body.title),
            body: String(body.body),
            state: "open",
            labels: body.labels as string[],
            comments: [],
          };
          this.issues.push(issue);
          reply(201, issue);
        } else if ((match = route("PATCH", /^\/issues\/(\d+)$/))) {
          const issue = this.issues.find((i) => i.number === Number(match![1]));
          if (issue) Object.assign(issue, body);
          reply(200, issue);
        } else if ((match = route("GET", /^\/labels\/(.+)$/))) {
          if (this.labels.includes(decodeURIComponent(match[1]!))) reply(200, {});
          else reply(404, { message: "Not Found" });
        } else if (route("POST", /^\/labels$/)) {
          this.labels.push(String(body.name));
          reply(201, body);
        } else {
          reply(404, { message: "Not Found" });
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }
}

let root: string;
let api: FakeGitHub;
let apiUrl: string;
let clock: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "notmyfault-e2e-"));
  mkdirSync(join(root, "remote", "acme"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--bare", join(root, "remote", "acme", "shop.git")]);
  mkdirSync(join(root, "workspace", "reports"), { recursive: true });
  api = new FakeGitHub();
  apiUrl = await api.start();
  clock = Date.parse("2026-09-01T10:00:00Z");
});

afterEach(async () => {
  await api.stop();
  rmSync(root, { recursive: true, force: true });
});

/** "fail" fails with a message of its own, "fail: message" with the given one. */
type Outcomes = Record<string, "pass" | "fail" | `fail: ${string}`>;

function writeReport(outcomes: Outcomes, path = "reports/junit.xml"): void {
  const cases = Object.entries(outcomes)
    .map(([name, outcome]) =>
      outcome === "pass"
        ? `<testcase classname="checkout" name="${name}"/>`
        : `<testcase classname="checkout" name="${name}"><failure message="${outcome === "fail" ? `${name} broke` : outcome.slice(6)}"/></testcase>`,
    )
    .join("");
  mkdirSync(dirname(join(root, "workspace", path)), { recursive: true });
  writeFileSync(join(root, "workspace", path), `<testsuites><testsuite name="unit">${cases}</testsuite></testsuites>`);
}

interface RunOptions {
  event?: "push" | "pull_request";
  sha?: string;
  attempt?: number;
  fork?: boolean;
  inputs?: Record<string, string>;
  /** Reports to write instead of reports/junit.xml, by path. */
  reports?: Record<string, Outcomes>;
}

async function simulate(outcomes: Outcomes, options: RunOptions = {}) {
  if (options.reports) for (const [path, report] of Object.entries(options.reports)) writeReport(report, path);
  else writeReport(outcomes);
  const event = options.event ?? "push";
  const eventPath = join(root, "event.json");
  const payload =
    event === "pull_request"
      ? {
          repository: { default_branch: "main" },
          pull_request: {
            number: PULL_REQUEST,
            head: { repo: { full_name: options.fork ? "someone/shop" : "acme/shop" } },
            base: { repo: { full_name: "acme/shop" } },
          },
        }
      : { repository: { default_branch: "main" } };
  writeFileSync(eventPath, JSON.stringify(payload));
  const outputFile = join(root, "output.txt");
  const summaryFile = join(root, "summary.md");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");

  const env: NodeJS.ProcessEnv = {
    INPUT_JUNIT: "reports/**/*.xml",
    INPUT_TOKEN: "secret-token",
    ...Object.fromEntries(Object.entries(options.inputs ?? {}).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
    GITHUB_REPOSITORY: "acme/shop",
    GITHUB_SERVER_URL: `file://${join(root, "remote")}`,
    GITHUB_API_URL: apiUrl,
    GITHUB_SHA: options.sha ?? String(clock).padEnd(40, "0"),
    GITHUB_REF: event === "pull_request" ? "refs/pull/7/merge" : "refs/heads/main",
    GITHUB_REF_NAME: event === "pull_request" ? "7/merge" : "main",
    GITHUB_EVENT_NAME: event,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_RUN_ID: String(clock),
    GITHUB_RUN_ATTEMPT: String(options.attempt ?? 1),
    GITHUB_WORKFLOW: "CI",
    GITHUB_JOB: "test",
    GITHUB_WORKSPACE: join(root, "workspace"),
    RUNNER_TEMP: root,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
  };
  const logs: string[] = [];
  const now = new Date(clock);
  clock += 60 * 60 * 1000;
  const code = await run(env, new ActionIO(env, (line) => logs.push(line)), now);
  return {
    code,
    logs: logs.join("\n"),
    summary: readFileSync(summaryFile, "utf8"),
    outputs: parseOutputs(readFileSync(outputFile, "utf8")),
  };
}

function parseOutputs(raw: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const re = /^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;
  for (const match of raw.matchAll(re)) outputs[match[1]!] = match[3]!;
  return outputs;
}

function storedHistory(key = "ci-test"): { runs: number; tests: Record<string, { outcomes: string; evidence?: unknown[] }> } {
  const bare = join(root, "remote", "acme", "shop.git");
  return JSON.parse(
    execFileSync("git", ["-C", bare, "show", `notmyfault-history:history/${key}.json`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

describe("run", () => {
  it("learns from main, then tells a pull request which failures are its fault", async () => {
    // Build some history on main: "pays" keeps failing in isolation, "totals" is stable.
    for (const pays of ["pass", "fail", "pass", "fail", "pass", "pass", "fail", "pass"] as const) {
      const result = await simulate({ pays, totals: "pass" });
      expect(result.code).toBe(0);
    }
    const badge = execFileSync("git", ["-C", join(root, "remote", "acme", "shop.git"), "show", "notmyfault-history:badges/ci-test.json"], {
      encoding: "utf8",
    });
    expect(JSON.parse(badge)).toMatchObject({ label: "flaky tests", message: "1" });
    const branchFiles = execFileSync("git", ["-C", join(root, "remote", "acme", "shop.git"), "ls-tree", "-r", "--name-only", "notmyfault-history"], {
      encoding: "utf8",
    });
    expect(branchFiles.trim().split("\n")).toEqual([
      ".nojekyll",
      "README.md",
      "badges/ci-test.json",
      "history/ci-test.json",
      "index.html",
      "reports/ci-test.html",
    ]);
    expect(storedHistory()).toMatchObject({
      runs: 8,
      tests: { "unit › checkout › pays": { outcomes: "pfpfppfp" }, "unit › checkout › totals": { outcomes: "pppppppp" } },
    });

    // A pull request breaks both tests.
    const pr = await simulate(
      { pays: "fail", totals: "fail" },
      { event: "pull_request", sha: "a".repeat(40), inputs: { mode: "quarantine" } },
    );
    expect(pr.code).toBe(1);
    expect(pr.outputs).toMatchObject({ failed: "2", "new-failures": "1", "flaky-failures": "1", blocking: "1" });
    expect(api.comments).toHaveLength(1);
    const comment = api.comments[0]!.body;
    expect(comment.startsWith("<!-- notmyfault:ci-test -->")).toBe(true);
    expect(comment).toContain("1 looks related to this change");
    expect(comment).toMatch(/checkout › totals<\/code> \| <img [^>]+> \*\*New failure\.\*\* Passed the last 8 runs on `main`/);
    expect(comment).toMatch(/checkout › pays<\/code> \| <img [^>]+> \*\*Probably flaky\.\*\* Failed 3 of the last 8 runs/);
    expect(pr.summary).toContain("Most unreliable tests on `main`");
    expect(pr.logs).toContain("::error::1 failing test(s) are not tolerated in quarantine mode: checkout › totals");
    // The token only ever appears in the masking command.
    expect(pr.logs.replace("::add-mask::secret-token", "")).not.toContain("secret-token");

    // Re-running the same commit: "totals" now passes, which proves it flaky.
    const rerun = await simulate({ pays: "pass", totals: "pass" }, { event: "pull_request", sha: "a".repeat(40), attempt: 2 });
    expect(rerun.code).toBe(0);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toMatch(/^### <img [^>]+> All 2 tests passed$/m);
    expect(storedHistory().tests["unit › checkout › totals"]!.evidence).toHaveLength(1);

    // Next time "totals" fails anywhere, it is recognized as flaky.
    const later = await simulate({ pays: "pass", totals: "fail" }, { event: "pull_request", sha: "b".repeat(40) });
    expect(later.outputs).toMatchObject({ "new-failures": "0", "flaky-failures": "1" });
  });

  it("does not excuse a flaky test failing with an error never seen on main", async () => {
    const main = ["pass", "fail: timeout after 100ms", "pass", "fail: timeout after 250ms", "pass", "pass", "fail: timeout after 90ms", "pass"] as const;
    for (const pays of main) await simulate({ pays });

    const known = await simulate({ pays: "fail: timeout after 120ms" }, { event: "pull_request", sha: "a".repeat(40), inputs: { mode: "quarantine" } });
    expect(known.code).toBe(0);
    expect(known.outputs).toMatchObject({ "flaky-failures": "1", "new-failures": "0" });

    const other = await simulate({ pays: "fail: expected 3758 to be 3422" }, { event: "pull_request", sha: "b".repeat(40), inputs: { mode: "quarantine" } });
    expect(other.code).toBe(1);
    expect(other.outputs).toMatchObject({ "flaky-failures": "0", "new-failures": "1", blocking: "1" });
    expect(other.logs).toContain("new      checkout › pays (flaky on main, but with a new error)");
    expect(api.comments[0]!.body).toContain("**New failure.** Probably flaky on `main`, but this error was never seen there.");
    // The error of a pull request is never learned: it stays new.
    expect(storedHistory().tests["unit › checkout › pays"]).toMatchObject({ outcomes: "pfpfppfp" });
    expect((storedHistory().tests["unit › checkout › pays"] as { errors?: string[] }).errors).toHaveLength(1);
  });

  it("comments on a pull request that fixes a test failing on main", async () => {
    for (const search of ["pass", "fail", "fail"] as const) await simulate({ search, cart: "pass" });

    const pr = await simulate({ search: "pass", cart: "pass" }, { event: "pull_request" });
    expect(pr.code).toBe(0);
    expect(pr.outputs).toMatchObject({ failed: "0", fixed: "1" });
    expect(pr.logs).toContain("fixed    checkout › search");
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toMatch(/^### <img [^>]+> All 2 tests passed$/m);
    expect(api.comments[0]!.body).toContain("- <code>checkout › search</code>, failed the last 2 runs there");
  });

  it("stays quiet on green pull requests without a previous comment", async () => {
    const result = await simulate({ ok: "pass" }, { event: "pull_request" });
    expect(result.code).toBe(0);
    expect(api.comments).toHaveLength(0);
    expect(api.requests.every((r) => r.startsWith("GET"))).toBe(true);
    expect(result.summary).toContain("All 1 test passed");
  });

  it("does not record or fail the job on pull requests from forks", async () => {
    api.status = 403;
    const result = await simulate({ broken: "fail" }, { event: "pull_request", fork: true });
    expect(result.code).toBe(0);
    expect(result.logs).toContain("Pull request from a fork");
    expect(result.logs).toContain("::warning::Could not comment on the pull request. Tokens are read-only");
    expect(() => storedHistory()).toThrow();
  });

  it("fails when no report matches", async () => {
    const result = await simulate({}, { inputs: { junit: "nothing/*.xml" } });
    expect(result.code).toBe(1);
    expect(result.logs).toContain('::error::No JUnit report matched "nothing/*.xml"');
  });

  it("rejects invalid inputs", async () => {
    const result = await simulate({ ok: "pass" }, { inputs: { mode: "strict" } });
    expect(result.code).toBe(1);
    expect(result.logs).toContain('::error::Input "mode" must be "report" or "quarantine", got "strict"');
  });

  it("annotates failed tests it finds in the workspace, unless told not to", async () => {
    writeFileSync(join(root, "workspace", "checkout.test.ts"), "");
    for (let run = 0; run < 2; run++) await simulate({ totals: "pass" });

    const pr = await simulate({ totals: "fail: expected 1 to be 2 at checkout.test.ts:7:3" }, { event: "pull_request" });
    expect(pr.logs).toContain(
      "::error file=checkout.test.ts,line=7,title=checkout › totals::New failure. Passed the last 2 runs on main.%0Aexpected 1 to be 2 at checkout.test.ts:7:3",
    );

    const quiet = await simulate({ totals: "fail: at checkout.test.ts:7:3" }, { event: "pull_request", inputs: { annotations: "false" } });
    expect(quiet.logs).not.toContain("::error file=");
  });

  it("reports several suites, each with its own history, in one comment", async () => {
    const suites = "unit: reports/unit/*.xml\ne2e: reports/e2e/*.xml";
    const both = (unit: Outcomes, e2e: Outcomes) => ({ "reports/unit/junit.xml": unit, "reports/e2e/junit.xml": e2e });
    for (let run = 0; run < 2; run++) await simulate({}, { inputs: { junit: "", suites }, reports: both({ totals: "pass" }, { login: "pass" }) });
    await simulate({}, { inputs: { junit: "", suites }, reports: both({ totals: "pass" }, { login: "fail" }) });
    expect(storedHistory("unit")).toMatchObject({ runs: 3, tests: { "unit › checkout › totals": { outcomes: "ppp" } } });
    expect(storedHistory("e2e")).toMatchObject({ runs: 3, tests: { "unit › checkout › login": { outcomes: "ppf" } } });

    const pr = await simulate(
      {},
      {
        event: "pull_request",
        inputs: { junit: "", suites, mode: "quarantine", tolerate: "flaky, broken" },
        reports: both({ totals: "fail" }, { login: "fail" }),
      },
    );
    expect(pr.code).toBe(1);
    expect(pr.outputs).toMatchObject({ total: "2", failed: "2", "new-failures": "1", "broken-failures": "1", blocking: "1" });
    expect(pr.logs).toContain("Read 1 tests from 1 report(s) for e2e.");
    expect(api.comments).toHaveLength(1);
    const comment = api.comments[0]!.body;
    expect(comment.startsWith("<!-- notmyfault:unit+e2e -->")).toBe(true);
    expect(comment).toMatch(/#### unit\n[\s\S]*\*\*New failure\.\*\*[\s\S]*#### e2e\n[\s\S]*\*\*Already failing on `main`\.\*\*/);
  });

  it("rejects suites that are malformed or mixed with junit and key", async () => {
    const malformed = await simulate({ ok: "pass" }, { inputs: { junit: "", suites: "unit reports/*.xml" } });
    expect(malformed.logs).toContain('::error::Input "suites" expects one "name: glob" per line, got "unit reports/*.xml"');
    const twice = await simulate({ ok: "pass" }, { inputs: { junit: "", suites: "unit: a.xml\nUnit: b.xml" } });
    expect(twice.logs).toContain('::error::Input "suites" names the suite "unit" twice.');
    const mixed = await simulate({ ok: "pass" }, { inputs: { suites: "unit: reports/*.xml" } });
    expect(mixed.code).toBe(1);
    expect(mixed.logs).toContain('::error::Inputs "junit" and "key" cannot be used with "suites"');
  });

  it("opens, updates and closes an issue per flaky test when asked", async () => {
    await simulate({ pays: "fail: Bank did not answer within 100ms" }, { sha: "c".repeat(40) });
    expect(api.requests.some((request) => request.includes("/issues?labels"))).toBe(false);

    // Passing on the same commit proves the test flaky: it gets an issue.
    const inputs = { "flaky-issues": "true" };
    const rerun = await simulate({ pays: "pass" }, { sha: "c".repeat(40), attempt: 2, inputs });
    expect(rerun.logs).toContain("Flaky test issues: 1 created, 0 updated, 0 closed.");
    expect(api.labels).toEqual(["flaky-test"]);
    expect(api.issues).toMatchObject([{ number: 100, title: "Flaky test: checkout › pays", state: "open", labels: ["flaky-test"] }]);
    expect(api.issues[0]!.body).toContain("- **Proof:** passed when the same commit was re-run on 2026-09-01");

    // A new failure on main updates it, pull requests never touch it.
    await simulate({ pays: "fail: socket hang up" }, { inputs });
    expect(api.issues[0]!.body).toContain("<pre>socket hang up</pre>");
    await simulate({ pays: "fail: from a pull request" }, { event: "pull_request", inputs });
    expect(api.issues[0]!.body).not.toContain("from a pull request");

    // A month without failure closes it.
    clock += 31 * 24 * 60 * 60 * 1000;
    const quiet = await simulate({ pays: "pass" }, { inputs });
    expect(quiet.logs).toContain("Flaky test issues: 0 created, 0 updated, 1 closed.");
    expect(api.issues[0]).toMatchObject({ state: "closed" });
    expect(api.issues[0]!.comments).toEqual([
      "No failure on `main` since 2026-09-01, for more than 30 days: closing this issue. notmyfault reopens it if the test fails again.",
    ]);
  });

  it("warns and carries on when issues cannot be written", async () => {
    await simulate({ pays: "fail" }, { sha: "d".repeat(40) });
    api.status = 403;
    const result = await simulate({ pays: "pass" }, { sha: "d".repeat(40), attempt: 2, inputs: { "flaky-issues": "true" } });
    expect(result.code).toBe(0);
    expect(result.logs).toContain('::warning::Could not update flaky test issues. Does the job have "issues: write" permission?');
  });

  it("never blocks on tests quarantined by hand, until their date", async () => {
    await simulate({ totals: "pass", pays: "pass" });
    const quarantine = "2099-01-01 checkout › totals # sandbox outage\n2020-01-01 checkout › pays";
    const pr = await simulate(
      { totals: "fail", pays: "fail" },
      { event: "pull_request", inputs: { mode: "quarantine", quarantine } },
    );
    expect(pr.code).toBe(1);
    expect(pr.outputs).toMatchObject({ failed: "2", "new-failures": "2", quarantined: "1", blocking: "1" });
    expect(pr.logs).toContain('::warning::The quarantine of "checkout › pays" expired on 2020-01-01');
    expect(pr.logs).toContain("new      checkout › totals (quarantined until 2099-01-01)");
    expect(pr.logs).toContain("::error::1 failing test(s) are not tolerated in quarantine mode: checkout › pays");
    expect(api.comments[0]!.body).toContain("_Quarantined by hand until 2099-01-01: sandbox outage._");

    const invalid = await simulate({ totals: "pass" }, { inputs: { quarantine: "soon checkout › totals" } });
    expect(invalid.code).toBe(1);
    expect(invalid.logs).toContain('::error::Input "quarantine" expects "YYYY-MM-DD test name # reason" per line');
  });

  it("flags runs where only flaky tests failed, for a workflow re-running them", async () => {
    for (const pays of ["pass", "fail", "pass", "fail", "pass", "fail", "pass"] as const) await simulate({ pays, totals: "pass" });
    const marker = "::notice title=notmyfault%3A only flaky tests failed::Every failed test is known or probably flaky";

    const flaky = await simulate({ pays: "fail", totals: "pass" }, { event: "pull_request" });
    expect(flaky.logs).toContain(marker);
    const mixed = await simulate({ pays: "fail", totals: "fail" }, { event: "pull_request" });
    expect(mixed.logs).not.toContain("only flaky tests failed");
    const green = await simulate({ pays: "pass", totals: "pass" }, { event: "pull_request" });
    expect(green.logs).not.toContain("only flaky tests failed");
  });

  it("follows a renamed test on the tracked branch only", async () => {
    for (let run = 0; run < 2; run++) await simulate({ "computes totals": "pass", pays: "pass" });

    // A pull request renaming it gets no history: nothing is guessed there.
    const pr = await simulate({ "computes the totals": "fail", pays: "pass" }, { event: "pull_request" });
    expect(api.comments[0]!.body).toContain("**New failure.** No history for this test on `main`.");
    expect(pr.logs).not.toContain("renamed");

    const merged = await simulate({ "computes the totals": "fail", pays: "pass" });
    expect(merged.logs).toContain("renamed  unit › checkout › computes totals → unit › checkout › computes the totals");
    expect(merged.summary).toContain("✏️ **Renamed:** the history of 1 test followed its new name.");
    // The rename applies in that very run: the failure is compared with the history of the old name.
    expect(merged.summary).toContain("**New failure.** Passed the last 2 runs on `main`.");
    expect(storedHistory().tests).toMatchObject({ "unit › checkout › computes the totals": { outcomes: "ppf" } });
    expect(storedHistory().tests["unit › checkout › computes totals"]).toBeUndefined();
  });

  it("keeps working when the history cannot be read", async () => {
    rmSync(join(root, "remote"), { recursive: true, force: true });
    const result = await simulate({ ok: "fail" });
    expect(result.code).toBe(0);
    expect(result.logs).toContain('::warning::Could not read history from branch "notmyfault-history"');
    expect(result.logs).toContain('::warning::Could not record history on branch "notmyfault-history"');
    expect(result.summary).toContain("**New failure.**");
  });
});

describe("findFiles", () => {
  it("expands globs and skips node_modules and .git", async () => {
    const workspace = join(root, "workspace");
    for (const dir of ["reports/unit", "node_modules/pkg", ".git/x"]) mkdirSync(join(workspace, dir), { recursive: true });
    for (const file of ["reports/unit/a.xml", "reports/b.xml", "node_modules/pkg/c.xml", ".git/x/d.xml", "e.xml"]) {
      writeFileSync(join(workspace, file), "");
    }
    expect(await findFiles(["**/*.xml"], workspace)).toEqual(
      ["e.xml", "reports/b.xml", "reports/unit/a.xml"].map((f) => join(workspace, f)),
    );
    expect(await findFiles(["reports/*.xml", `${workspace}/e.xml`, "reports/b.xml"], workspace)).toEqual(
      ["e.xml", "reports/b.xml"].map((f) => join(workspace, f)),
    );
  });
});

describe("sanitizeKey", () => {
  it("produces safe file names", () => {
    expect(sanitizeKey("CI / Unit tests (Node 24)")).toBe("ci-unit-tests-node-24");
    expect(sanitizeKey("../..")).toBe("default");
  });
});
