import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionIO } from "../../src/github/io";
import { run } from "../../src/main";
import { detectPlatform } from "../../src/platforms";

const PULL_REQUEST = 4;

/** In-memory stand-in for the Forgejo API of acme/shop: comments, issues, labels by id, and the pull request of a commit. */
class FakeForgejo {
  comments: { id: number; body: string }[] = [];
  issues: { number: number; title: string; body: string; state: string; labels: number[]; comments: string[] }[] = [];
  labels: { id: number; name: string; color: string }[] = [];
  pulls: Record<string, unknown> = {};
  requests: string[] = [];
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        this.requests.push(`${req.method} ${req.url} ${req.headers.authorization?.split(" ")[0]}`);
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const url = new URL(req.url ?? "/", "http://api");
        const path = url.pathname.replace("/api/v1/repos/acme/shop", "");
        const reply = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
        const route = (method: string, pattern: RegExp) => (req.method === method ? pattern.exec(path) : null);
        let match: RegExpExecArray | null;
        if ((match = route("GET", /^\/commits\/(\w+)\/pull$/))) {
          const pull = this.pulls[match[1]!];
          if (pull) reply(200, pull);
          else reply(404, { message: "pull request does not exist" });
        } else if ((match = route("GET", /^\/issues\/(\d+)\/comments$/))) {
          reply(200, Number(match[1]) === PULL_REQUEST ? this.comments : []);
        } else if ((match = route("POST", /^\/issues\/(\d+)\/comments$/))) {
          if (Number(match[1]) === PULL_REQUEST) this.comments.push({ id: this.comments.length + 1, body: String(body.body) });
          else this.issues.find((issue) => issue.number === Number(match![1]))?.comments.push(String(body.body));
          reply(201, {});
        } else if ((match = route("PATCH", /^\/issues\/comments\/(\d+)$/))) {
          this.comments.find((comment) => comment.id === Number(match![1]))!.body = String(body.body);
          reply(200, {});
        } else if (route("GET", /^\/issues$/)) {
          const label = this.labels.find((candidate) => candidate.name === url.searchParams.get("labels"));
          reply(200, this.issues.filter((issue) => label && issue.labels.includes(label.id)));
        } else if (route("POST", /^\/issues$/)) {
          if (!(body.labels as unknown[]).every((id) => typeof id === "number")) {
            reply(422, { message: "cannot unmarshal string into Go struct field CreateIssueOption.labels of type int64" });
            return;
          }
          const issue = { number: 10 + this.issues.length, title: String(body.title), body: String(body.body), state: "open", labels: body.labels as number[], comments: [] };
          this.issues.push(issue);
          reply(201, issue);
        } else if ((match = route("PATCH", /^\/issues\/(\d+)$/))) {
          Object.assign(this.issues.find((issue) => issue.number === Number(match![1]))!, body);
          reply(201, {});
        } else if (route("GET", /^\/labels$/)) {
          reply(200, this.labels);
        } else if (route("POST", /^\/labels$/)) {
          this.labels.push({ id: 100 + this.labels.length, name: String(body.name), color: String(body.color) });
          reply(201, {});
        } else {
          reply(404, { message: "not found" });
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/api/v1`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }
}

let root: string;
let api: FakeForgejo;
let apiUrl: string;
let clock: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "notmyfault-forgejo-"));
  mkdirSync(join(root, "remote", "acme"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--bare", join(root, "remote", "acme", "shop.git")]);
  mkdirSync(join(root, "workspace", "reports"), { recursive: true });
  api = new FakeForgejo();
  apiUrl = await api.start();
  clock = Date.parse("2026-09-01T10:00:00Z");
});

afterEach(async () => {
  await api.stop();
  rmSync(root, { recursive: true, force: true });
});

async function simulate(outcomes: Record<string, "pass" | "fail">, options: { pullRequest?: boolean; sha?: string; inputs?: Record<string, string> } = {}) {
  const cases = Object.entries(outcomes)
    .map(([name, outcome]) =>
      outcome === "pass" ? `<testcase classname="checkout" name="${name}"/>` : `<testcase classname="checkout" name="${name}"><failure message="${name} broke"/></testcase>`,
    )
    .join("");
  writeFileSync(join(root, "workspace", "reports", "junit.xml"), `<testsuite name="unit">${cases}</testsuite>`);
  const event = options.pullRequest ? "pull_request" : "push";
  writeFileSync(
    join(root, "event.json"),
    JSON.stringify({
      repository: { default_branch: "main" },
      ...(options.pullRequest
        ? { pull_request: { number: PULL_REQUEST, head: { sha: "f".repeat(40), repo: { full_name: "acme/shop" } }, base: { repo: { full_name: "acme/shop" } } } }
        : {}),
    }),
  );
  const env: NodeJS.ProcessEnv = {
    FORGEJO_ACTIONS: "true",
    GITHUB_ACTIONS: "true",
    INPUT_JUNIT: "reports/*.xml",
    INPUT_TOKEN: "forgejo-token",
    ...Object.fromEntries(Object.entries(options.inputs ?? {}).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
    GITHUB_REPOSITORY: "acme/shop",
    GITHUB_SERVER_URL: `file://${join(root, "remote")}`,
    GITHUB_API_URL: apiUrl,
    GITHUB_SHA: options.sha ?? String(clock).padEnd(40, "0"),
    GITHUB_REF: options.pullRequest ? `refs/pull/${PULL_REQUEST}/head` : "refs/heads/main",
    GITHUB_REF_NAME: options.pullRequest ? `${PULL_REQUEST}/head` : "main",
    GITHUB_EVENT_NAME: event,
    GITHUB_EVENT_PATH: join(root, "event.json"),
    GITHUB_RUN_ID: "8",
    GITHUB_WORKFLOW: "CI",
    GITHUB_JOB: "test",
    GITHUB_WORKSPACE: join(root, "workspace"),
    RUNNER_TEMP: root,
  };
  const logs: string[] = [];
  const now = new Date(clock);
  clock += 60 * 60 * 1000;
  const code = await run(env, new ActionIO(env, (line) => logs.push(line)), now);
  return { code, logs: logs.join("\n") };
}

describe("run on Forgejo Actions", () => {
  it("comments, opens issues with label ids, and finds the pull request of a commit", async () => {
    await simulate({ pays: "pass" });
    const breaking = "b".repeat(40);
    api.pulls[breaking] = { number: 3, html_url: "http://forgejo/acme/shop/pulls/3", merged: true };
    await simulate({ pays: "fail" }, { sha: breaking });
    const rerun = await simulate({ pays: "pass" }, { sha: breaking, inputs: { "flaky-issues": "true", check: "true" } });
    expect(rerun.logs).toContain("Flaky test issues: 1 created, 0 updated, 0 closed.");
    expect(api.labels).toEqual([{ id: 100, name: "flaky-test", color: "#fcbd34" }]);
    expect(api.issues).toMatchObject([{ title: "Flaky test: checkout › pays", labels: [100] }]);
    expect(rerun.logs).toContain('::warning::Input "check" is ignored: checks only exist on GitHub.');
    expect(execFileSync("git", ["-C", join(root, "remote", "acme", "shop.git"), "log", "-1", "--format=%an", "notmyfault-history"], { encoding: "utf8" }).trim()).toBe(
      "notmyfault",
    );

    await simulate({ totals: "pass" });
    await simulate({ totals: "fail" }, { sha: "c".repeat(40) });
    const pr = await simulate({ totals: "fail" }, { pullRequest: true });
    expect(pr.logs).toContain("Pull request comment created.");
    // The rig serves the repository from a file:// path: a link only points at a commit when it is a web address.
    expect(api.comments[0]!.body).toContain("**Already failing on `main`.** The latest run there failed too, on `ccccccc`.");
    expect(api.requests.every((request) => request.endsWith(" token"))).toBe(true);
    expect(api.requests).toContain(`GET /api/v1/repos/acme/shop/commits/${breaking}/pull token`);
  });

  it("is detected before GitHub Actions, whose variables Forgejo and Gitea also set", () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/shop", GITHUB_SHA: "a".repeat(40) };
    expect(detectPlatform({ ...env, FORGEJO_ACTIONS: "true" }).name).toBe("forgejo");
    expect(detectPlatform({ ...env, GITEA_ACTIONS: "true" }).name).toBe("forgejo");
    expect(detectPlatform(env).name).toBe("github");
  });
});
