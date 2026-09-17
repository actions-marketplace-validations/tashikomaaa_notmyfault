import { execFileSync } from "node:child_process";
import type { RunContext } from "../platform";

/** Runs git in the workspace, or resolves to undefined when it fails. */
export type Git = (args: string[]) => string | undefined;

/**
 * The run, in any CI system: NOTMYFAULT_* variables first, then the variables
 * of common CI systems, then the git repository of the workspace itself.
 */
export function readGenericContext(env: NodeJS.ProcessEnv, git: Git = gitIn(env.NOTMYFAULT_WORKSPACE ?? process.cwd())): RunContext {
  const first = (...values: (string | undefined)[]) => values.map((value) => value?.trim()).find((value) => value) || undefined;

  const remoteUrl = first(env.NOTMYFAULT_REPOSITORY_URL, git(["remote", "get-url", "origin"]));
  if (!remoteUrl) throw new Error("No repository to store the history in: set NOTMYFAULT_REPOSITORY_URL, or run in a git clone with an origin remote.");
  const sha = first(
    env.NOTMYFAULT_SHA,
    env.GIT_COMMIT, // Jenkins
    env.CIRCLE_SHA1,
    env.BUILDKITE_COMMIT,
    env.BITBUCKET_COMMIT,
    env.BUILD_SOURCEVERSION, // Azure Pipelines
    env.TRAVIS_COMMIT,
    env.DRONE_COMMIT_SHA,
    git(["rev-parse", "HEAD"]),
  );
  if (!sha) throw new Error("No commit: set NOTMYFAULT_SHA, or run in a git clone.");

  const pullRequest = pullRequestNumber(
    first(
      env.NOTMYFAULT_PULL_REQUEST,
      env.CHANGE_ID, // Jenkins multibranch pipelines
      env.CIRCLE_PULL_REQUEST?.match(/\/(\d+)$/)?.[1],
      env.BUILDKITE_PULL_REQUEST,
      env.BITBUCKET_PR_ID,
      env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER, // Azure Pipelines
      env.TRAVIS_PULL_REQUEST,
      env.DRONE_PULL_REQUEST,
    ),
  );
  const branch = first(
    env.NOTMYFAULT_BRANCH,
    env.BRANCH_NAME, // Jenkins multibranch pipelines
    env.GIT_BRANCH?.replace(/^origin\//, ""), // Jenkins
    env.CIRCLE_BRANCH,
    env.BUILDKITE_BRANCH,
    env.BITBUCKET_BRANCH,
    env.BUILD_SOURCEBRANCH?.replace(/^refs\/heads\//, ""), // Azure Pipelines
    env.TRAVIS_BRANCH,
    env.DRONE_BRANCH,
    git(["rev-parse", "--abbrev-ref", "HEAD"])?.replace(/^HEAD$/, ""),
  );
  const web = webUrl(remoteUrl);
  const runId = first(env.BUILD_NUMBER, env.CIRCLE_BUILD_NUM, env.BUILDKITE_BUILD_NUMBER, env.BITBUCKET_BUILD_NUMBER, env.BUILD_BUILDNUMBER, env.TRAVIS_BUILD_NUMBER, env.DRONE_BUILD_NUMBER);
  const runUrl = first(env.NOTMYFAULT_RUN_URL, env.BUILD_URL, env.CIRCLE_BUILD_URL, env.BUILDKITE_BUILD_URL, env.TRAVIS_BUILD_WEB_URL, env.DRONE_BUILD_LINK);
  return {
    repository: web?.path ?? remoteUrl,
    apiProject: web?.path ?? remoteUrl,
    serverUrl: web?.origin ?? "",
    apiUrl: "",
    remoteUrl,
    sha,
    // A pull request run is compared with the history of the tracked branches, whatever the branch it builds.
    branch: pullRequest ? undefined : branch,
    runDescription: runId ? `build ${runId}` : `commit ${sha.slice(0, 7)}`,
    runUrl,
    workspace: env.NOTMYFAULT_WORKSPACE ?? process.cwd(),
    tempDir: undefined,
    defaultBranch: first(env.NOTMYFAULT_DEFAULT_BRANCH, git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.replace(/^origin\//, "")),
    defaultKey: first(env.JOB_NAME, env.CIRCLE_JOB, env.BUILDKITE_LABEL, env.SYSTEM_JOBNAME, env.DRONE_STEP_NAME) ?? "tests",
    pullRequest: pullRequest ? { number: pullRequest, fromFork: false } : undefined,
    defaultToken: undefined,
    local: !CI_VARIABLES.some((name) => env[name]?.trim() && env[name]?.trim().toLowerCase() !== "false"),
  };
}

/** Set by CI systems, and by none of them on a developer's machine. */
const CI_VARIABLES = ["CI", "NOTMYFAULT_CI", "JENKINS_URL", "BUILDKITE", "CIRCLECI", "TF_BUILD", "BITBUCKET_BUILD_NUMBER", "TEAMCITY_VERSION", "DRONE", "TRAVIS"];

function pullRequestNumber(value: string | undefined): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** The web address of a repository from its git URL, over HTTPS or SSH: `https://host` and `owner/repo`. */
export function webUrl(remoteUrl: string): { origin: string; path: string } | undefined {
  const ssh = /^(?:ssh:\/\/)?[\w.-]+@([\w.-]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(remoteUrl);
  if (ssh && !remoteUrl.startsWith("http")) return { origin: `https://${ssh[1]}`, path: ssh[2]! };
  try {
    const url = new URL(remoteUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return { origin: url.origin, path: url.pathname.replace(/^\/+/, "").replace(/\.git\/?$/, "") };
  } catch {
    return undefined;
  }
}

function gitIn(directory: string): Git {
  return (args) => {
    try {
      return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return undefined;
    }
  };
}
