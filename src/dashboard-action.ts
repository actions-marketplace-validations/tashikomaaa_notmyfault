import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderDashboard, renderDashboardSummary, type DashboardRepository } from "./dashboard";
import { GitStore } from "./git-store";
import { ActionIO } from "./github/io";
import { parseHistory } from "./history";
import type { Io } from "./platform";

const EVIDENCE_TTL_DAYS = 30;

/** Runs the dashboard action and resolves to the process exit code. */
export async function runDashboard(env: NodeJS.ProcessEnv = process.env, io: Io = new ActionIO(env), now = new Date()): Promise<number> {
  try {
    const list = io
      .input("repositories")
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (list.length === 0) throw new Error(`${io.describeInput("repositories")} is required: one owner/repo, or git URL, per line.`);
    const token = io.input("token");
    if (token) io.mask(token);
    const branch = io.input("history-branch", "notmyfault-history");
    const serverUrl = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
    const output = resolve(env.GITHUB_WORKSPACE ?? process.cwd(), io.input("output", "notmyfault-dashboard"));
    const context = {
      title: io.input("title", "Unreliable tests"),
      limit: io.integerInput("limit", 100, 1),
      trackedBranches: [],
      now,
      evidenceTtlDays: EVIDENCE_TTL_DAYS,
    };

    const repositories: DashboardRepository[] = [];
    for (const entry of list) {
      const remoteUrl = /^https?:\/\/|^file:\/\//.test(entry) ? entry : `${serverUrl}/${entry}.git`;
      const repository: DashboardRepository = {
        // A URL keeps its host, to tell apart repositories of the same name on different servers.
        name: entry.replace(/^\w+:\/\//, "").replace(/\.git$/, ""),
        url: remoteUrl.replace(/\.git$/, ""),
        suites: [],
      };
      // The token only goes to the server of the workflow: repositories elsewhere are read anonymously.
      const sameServer = token !== "" && remoteUrl.startsWith(`${serverUrl}/`);
      const store = new GitStore({ remoteUrl, branch, ...(sameServer ? { token } : {}), ...(env.RUNNER_TEMP ? { tempDir: env.RUNNER_TEMP } : {}) });
      try {
        const files = await store.readAll("history/");
        for (const [path, content] of Object.entries(files)) {
          const key = /^history\/([^/]+)\.json$/.exec(path)?.[1];
          if (key) repository.suites.push({ key, history: parseHistory(content) });
        }
        if (repository.suites.length === 0) repository.error = `No history on branch "${branch}".`;
        io.info(`${repository.name}: ${repository.suites.length} suite(s).`);
      } catch (error) {
        repository.error = `Could not read branch "${branch}".`;
        io.warning(`Could not read the history of ${repository.name}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await store.dispose();
      }
      repositories.push(repository);
    }

    await mkdir(output, { recursive: true });
    await writeFile(join(output, "index.html"), renderDashboard(repositories, context));
    // GitHub Pages serves the page as it is.
    await writeFile(join(output, ".nojekyll"), "");
    io.appendSummary(renderDashboardSummary(repositories, context));
    io.setOutput("path", output);
    io.info(`Dashboard written to ${join(output, "index.html")}.`);
    // Nothing to show at all is worth failing: the list of repositories or the token is wrong.
    return repositories.every((repository) => repository.error) ? 1 : 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    io.finish();
  }
}
