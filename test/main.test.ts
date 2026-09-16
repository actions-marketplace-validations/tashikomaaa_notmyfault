import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionIO } from "../src/actions";
import { findFiles, run, sanitizeKey } from "../src/main";

interface Comment {
  id: number;
  body: string;
}

/** In-memory stand-in for the issue comments API. */
class FakeGitHub {
  comments: Comment[] = [];
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
        const body = raw ? (JSON.parse(raw) as { body: string }) : undefined;
        if (req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(this.comments));
        } else if (req.method === "POST" && body) {
          const comment = { id: this.comments.length + 1, body: body.body };
          this.comments.push(comment);
          res.writeHead(201).end(JSON.stringify(comment));
        } else if (req.method === "PATCH" && body) {
          const id = Number(req.url?.split("/").pop());
          const comment = this.comments.find((c) => c.id === id);
          if (comment) comment.body = body.body;
          res.writeHead(200).end(JSON.stringify(comment));
        } else {
          res.writeHead(404).end("{}");
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

type Outcomes = Record<string, "pass" | "fail">;

function writeReport(outcomes: Outcomes): void {
  const cases = Object.entries(outcomes)
    .map(([name, outcome]) =>
      outcome === "pass"
        ? `<testcase classname="checkout" name="${name}"/>`
        : `<testcase classname="checkout" name="${name}"><failure message="${name} broke"/></testcase>`,
    )
    .join("");
  writeFileSync(join(root, "workspace", "reports", "junit.xml"), `<testsuites><testsuite name="unit">${cases}</testsuite></testsuites>`);
}

interface RunOptions {
  event?: "push" | "pull_request";
  sha?: string;
  attempt?: number;
  fork?: boolean;
  inputs?: Record<string, string>;
}

async function simulate(outcomes: Outcomes, options: RunOptions = {}) {
  writeReport(outcomes);
  const event = options.event ?? "push";
  const eventPath = join(root, "event.json");
  const payload =
    event === "pull_request"
      ? {
          repository: { default_branch: "main" },
          pull_request: {
            number: 7,
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

function storedHistory(): { runs: number; tests: Record<string, { outcomes: string; evidence?: unknown[] }> } {
  const bare = join(root, "remote", "acme", "shop.git");
  return JSON.parse(
    execFileSync("git", ["-C", bare, "show", "notmyfault-history:history/ci-test.json"], {
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
    expect(comment).toMatch(/checkout › totals<\/code> \| \*\*New failure\.\*\* Passed the last 8 runs on `main`/);
    expect(comment).toMatch(/checkout › pays<\/code> \| \*\*Probably flaky\.\*\* Failed 3 of the last 8 runs/);
    expect(pr.summary).toContain("Most unreliable tests on `main`");
    expect(pr.logs).toContain("::error::1 failing test(s) are not tolerated in quarantine mode: checkout › totals");
    // The token only ever appears in the masking command.
    expect(pr.logs.replace("::add-mask::secret-token", "")).not.toContain("secret-token");

    // Re-running the same commit: "totals" now passes, which proves it flaky.
    const rerun = await simulate({ pays: "pass", totals: "pass" }, { event: "pull_request", sha: "a".repeat(40), attempt: 2 });
    expect(rerun.code).toBe(0);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toContain("### ✅ All 2 tests passed");
    expect(storedHistory().tests["unit › checkout › totals"]!.evidence).toHaveLength(1);

    // Next time "totals" fails anywhere, it is recognized as flaky.
    const later = await simulate({ pays: "pass", totals: "fail" }, { event: "pull_request", sha: "b".repeat(40) });
    expect(later.outputs).toMatchObject({ "new-failures": "0", "flaky-failures": "1" });
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
