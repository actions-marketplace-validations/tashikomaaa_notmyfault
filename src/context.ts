import { readFileSync } from "node:fs";

export interface RunContext {
  repository: string;
  serverUrl: string;
  apiUrl: string;
  sha: string;
  ref: string;
  refName: string;
  eventName: string;
  runId: string;
  runAttempt: string;
  workflow: string;
  job: string;
  workspace: string;
  tempDir: string | undefined;
  defaultBranch: string | undefined;
  pullRequest: { number: number; fromFork: boolean } | undefined;
}

interface EventPayload {
  repository?: { default_branch?: string };
  pull_request?: {
    number?: number;
    head?: { repo?: { full_name?: string } | null };
    base?: { repo?: { full_name?: string } };
  };
}

export function readContext(env: NodeJS.ProcessEnv): RunContext {
  const repository = required(env, "GITHUB_REPOSITORY");
  const payload = readPayload(env.GITHUB_EVENT_PATH);
  const pr = payload.pull_request;

  return {
    repository,
    serverUrl: (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, ""),
    apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    sha: required(env, "GITHUB_SHA"),
    ref: env.GITHUB_REF ?? "",
    refName: env.GITHUB_REF_NAME ?? "",
    eventName: env.GITHUB_EVENT_NAME ?? "",
    runId: env.GITHUB_RUN_ID ?? "",
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? "1",
    workflow: env.GITHUB_WORKFLOW ?? "workflow",
    job: env.GITHUB_JOB ?? "job",
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
    tempDir: env.RUNNER_TEMP,
    defaultBranch: payload.repository?.default_branch,
    pullRequest:
      typeof pr?.number === "number"
        ? { number: pr.number, fromFork: pr.head?.repo?.full_name !== (pr.base?.repo?.full_name ?? repository) }
        : undefined,
  };
}

export function runUrl(context: RunContext): string | undefined {
  if (!context.runId) return undefined;
  const attempt = context.runAttempt && context.runAttempt !== "1" ? `/attempts/${context.runAttempt}` : "";
  return `${context.serverUrl}/${context.repository}/actions/runs/${context.runId}${attempt}`;
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
