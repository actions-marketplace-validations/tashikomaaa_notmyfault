import { readFileSync } from "node:fs";
import type { RunContext } from "../platform";

interface EventPayload {
  repository?: { default_branch?: string };
  pull_request?: {
    number?: number;
    head?: { sha?: string; repo?: { full_name?: string } | null };
    base?: { repo?: { full_name?: string } };
  };
}

/** The run, from the default environment variables of GitHub Actions and the event payload. */
export function readContext(env: NodeJS.ProcessEnv): RunContext {
  const repository = required(env, "GITHUB_REPOSITORY");
  const payload = readPayload(env.GITHUB_EVENT_PATH);
  const pr = payload.pull_request;
  const serverUrl = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  const refName = env.GITHUB_REF_NAME ?? "";
  const runId = env.GITHUB_RUN_ID ?? "";
  const runAttempt = env.GITHUB_RUN_ATTEMPT ?? "1";
  const onBranch = !eventName.startsWith("pull_request") && env.GITHUB_REF === `refs/heads/${refName}`;

  return {
    repository,
    apiProject: repository,
    serverUrl,
    apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    sha: required(env, "GITHUB_SHA"),
    branch: onBranch ? refName : undefined,
    runDescription: `run ${runId || "local"}, attempt ${runAttempt}`,
    runUrl: runId
      ? `${serverUrl}/${repository}/actions/runs/${runId}${runAttempt !== "1" ? `/attempts/${runAttempt}` : ""}`
      : undefined,
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
    tempDir: env.RUNNER_TEMP,
    defaultBranch: payload.repository?.default_branch,
    defaultKey: `${env.GITHUB_WORKFLOW ?? "workflow"}-${env.GITHUB_JOB ?? "job"}`,
    pullRequest:
      typeof pr?.number === "number"
        ? {
            number: pr.number,
            fromFork: pr.head?.repo?.full_name !== (pr.base?.repo?.full_name ?? repository),
            // GITHUB_SHA is the merge commit GitHub creates for the run: checks show on the head of the pull request.
            ...(pr.head?.sha ? { headSha: pr.head.sha } : {}),
          }
        : undefined,
    defaultToken: undefined,
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set. notmyfault must run inside GitHub Actions.`);
  return value;
}

function readPayload(path: string | undefined): EventPayload {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EventPayload;
  } catch {
    return {};
  }
}
