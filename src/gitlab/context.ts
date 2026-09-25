import type { RunContext } from "../platform";

/** The run, from the predefined variables of GitLab CI/CD. */
export function readGitLabContext(env: NodeJS.ProcessEnv): RunContext {
  // The pipeline of a merge request from a fork may run in the fork: the history
  // and the merge request belong to the target project.
  const repository = env.CI_MERGE_REQUEST_PROJECT_PATH || required(env, "CI_PROJECT_PATH");
  const serverUrl = (env.CI_SERVER_URL ?? "https://gitlab.com").replace(/\/+$/, "");
  const mergeRequest = Number(env.CI_MERGE_REQUEST_IID);
  const sourceProject = env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID;
  return {
    repository,
    apiProject: env.CI_MERGE_REQUEST_PROJECT_ID || env.CI_PROJECT_ID || encodeURIComponent(repository),
    serverUrl,
    apiUrl: (env.CI_API_V4_URL ?? `${serverUrl}/api/v4`).replace(/\/+$/, ""),
    sha: required(env, "CI_COMMIT_SHA"),
    // Merge request pipelines have no CI_COMMIT_BRANCH, tag pipelines neither.
    branch: env.CI_PIPELINE_SOURCE === "merge_request_event" ? undefined : env.CI_COMMIT_BRANCH || undefined,
    runDescription: `pipeline ${env.CI_PIPELINE_ID || "local"}, job ${env.CI_JOB_ID || "local"}`,
    runUrl: env.CI_JOB_URL || undefined,
    workspace: env.CI_PROJECT_DIR ?? process.cwd(),
    tempDir: undefined,
    defaultBranch: env.CI_DEFAULT_BRANCH,
    defaultKey: env.CI_JOB_NAME ?? "job",
    pullRequest:
      Number.isInteger(mergeRequest) && mergeRequest > 0
        ? { number: mergeRequest, fromFork: sourceProject !== undefined && sourceProject !== env.CI_MERGE_REQUEST_PROJECT_ID }
        : undefined,
    defaultToken: env.CI_JOB_TOKEN || undefined,
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set. notmyfault must run inside GitLab CI/CD.`);
  return value;
}
