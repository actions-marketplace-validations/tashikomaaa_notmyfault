import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDashboard } from "../src/dashboard-action";
import { GitStore } from "../src/git-store";
import { ActionIO } from "../src/github/io";
import { emptyHistory, serializeHistory, type History } from "../src/history";

const NOW = new Date("2026-09-16T12:00:00Z");
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "notmyfault-dashboard-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function repository(name: string, histories: Record<string, History>): Promise<void> {
  const bare = join(root, "remote", `${name}.git`);
  mkdirSync(join(root, "remote", name.split("/")[0]!), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--bare", bare]);
  const store = new GitStore({ remoteUrl: `file://${bare}`, branch: "notmyfault-history" });
  const [first, ...others] = Object.entries(histories);
  await store.update(`history/${first![0]}.json`, () => serializeHistory(first![1]), {
    message: "Record",
    extraFiles: { "README.md": "history", ...Object.fromEntries(others.map(([key, history]) => [`history/${key}.json`, serializeHistory(history)])) },
  });
  await store.dispose();
}

function history(runs: number, tests: History["tests"], runDurations?: number[]): History {
  return { ...emptyHistory(), runs, tests, ...(runDurations ? { runDurations } : {}) };
}

describe("runDashboard", () => {
  it("ranks the unreliable tests of several repositories together", async () => {
    await repository("acme/shop", {
      "ci-test": history(10, {
        "cart › totals": { outcomes: "pppppppppp", lastSeen: "2026-09-16" },
        "payments › charges": {
          outcomes: "pfppfppfpp",
          lastSeen: "2026-09-16",
          evidence: [{ at: "2026-09-15T08:00:00Z", sha: "a", kind: "rerun" }],
        },
      }, [60_000]),
    });
    await repository("acme/api", {
      unit: history(8, { "users › signs up": { outcomes: "ppppppff", lastSeen: "2026-09-16" } }, [600_000]),
      e2e: history(8, { "login › works": { outcomes: "pppppppp", lastSeen: "2026-09-16" } }),
    });

    const env: NodeJS.ProcessEnv = {
      "INPUT_REPOSITORIES": "acme/shop, acme/api\nacme/gone",
      "INPUT_TITLE": "Acme flaky tests",
      GITHUB_SERVER_URL: `file://${join(root, "remote")}`,
      GITHUB_WORKSPACE: root,
      GITHUB_STEP_SUMMARY: join(root, "summary.md"),
      GITHUB_OUTPUT: join(root, "output.txt"),
    };
    writeFileSync(env.GITHUB_STEP_SUMMARY!, "");
    writeFileSync(env.GITHUB_OUTPUT!, "");
    const logs: string[] = [];
    const code = await runDashboard(env, new ActionIO(env, (line) => logs.push(line)), NOW);

    expect(code).toBe(0);
    expect(logs).toContain("acme/api: 2 suite(s).");
    expect(logs.some((line) => line.startsWith("::warning::Could not read the history of acme/gone"))).toBe(true);
    const page = readFileSync(join(root, "notmyfault-dashboard", "index.html"), "utf8");
    expect(existsSync(join(root, "notmyfault-dashboard", ".nojekyll"))).toBe(true);
    expect(page).toContain("<title>Acme flaky tests</title>");
    expect(page).toContain("3 repositories, 2 unreliable tests, 1 known or probably flaky test. Their failures and retries cost about 23 min 0 s of test time.");
    // Two failures of a 10 min suite cost more than three of a 1 min one.
    expect(page.indexOf("users › signs up")).toBeLessThan(page.indexOf("payments › charges"));
    expect(page).toContain(`<td><a href="file://${join(root, "remote")}/acme/api">acme/api</a></td><td><code>unit</code></td>`);
    expect(page).toMatch(/<td>acme\/gone<\/a><\/td><td colspan="4">Could not read branch .notmyfault-history.\.<\/td>|acme\/gone<\/a><\/td><td colspan="4">Could not read branch/);
    expect(page).not.toContain("cart › totals");
    const summary = readFileSync(env.GITHUB_STEP_SUMMARY!, "utf8");
    expect(summary).toContain("2 unreliable tests in 3 repositories.");
    expect(summary).toContain("⚠️ **acme/gone:** Could not read branch");
    expect(summary).toMatch(/\| \[acme\/api\]\(file:\/\/\S+\/acme\/api\) \| <code>users › signs up<\/code> \| 2 \/ 8 \| 0 \| 20 min 0 s \|/);
  });

  it("fails when no repository could be read, or none is given", async () => {
    const env: NodeJS.ProcessEnv = { "INPUT_REPOSITORIES": "acme/gone", GITHUB_SERVER_URL: `file://${join(root, "remote")}`, GITHUB_WORKSPACE: root };
    const logs: string[] = [];
    expect(await runDashboard(env, new ActionIO(env, (line) => logs.push(line)), NOW)).toBe(1);
    expect(await runDashboard({ GITHUB_WORKSPACE: root }, new ActionIO({}, (line) => logs.push(line)), NOW)).toBe(1);
    expect(logs).toContain('::error::Input "repositories" is required: one owner/repo, or git URL, per line.');
  });
});
