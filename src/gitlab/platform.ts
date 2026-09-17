import type { Io, Platform } from "../platform";
import { GitLabClient } from "./api";
import { readGitLabContext } from "./context";
import { GitLabIO } from "./io";

/** notmyfault in a GitLab CI/CD job. */
export function gitlabPlatform(env: NodeJS.ProcessEnv, io: Io = new GitLabIO(env)): Platform {
  const context = readGitLabContext(env);
  const isJobToken = (token: string) => token === env.CI_JOB_TOKEN;
  // Without NOTMYFAULT_TOKEN the job token is used, and hints say what it cannot do.
  const jobTokenOnly = io.input("token") === "";
  const apiDenied = jobTokenOnly
    ? "The job token cannot do this: set NOTMYFAULT_TOKEN to an access token with the api scope and at least the Reporter role."
    : "Does NOTMYFAULT_TOKEN have the api scope and at least the Reporter role?";
  return {
    name: "gitlab",
    context,
    io,
    forge: (token) => new GitLabClient(token, context.apiUrl, context.apiProject, isJobToken(token)),
    // Personal, project and group access tokens accept any user name, job tokens only this one.
    gitUser: (token) => (isJobToken(token) ? "gitlab-ci-token" : "oauth2"),
    gitAuthor: { name: "notmyfault", email: `notmyfault@noreply.${new URL(context.serverUrl).hostname || "gitlab.com"}` },
    // History pushes have no pipeline to run.
    pushOptions: ["ci.skip"],
    commitUrl: (sha) => `${context.serverUrl}/${context.repository}/-/commit/${sha}`,
    text: {
      pullRequest: "merge request",
      changePrefix: "!",
      runLink: "CI job",
      runName: "CI job",
      tokenMissing: "No token: set NOTMYFAULT_TOKEN, or run in a GitLab CI/CD job, which provides CI_JOB_TOKEN.",
      recordDenied: jobTokenOnly
        ? 'The job token can only push once "Allow Git push requests to the repository" is on in Settings > CI/CD > Job token permissions. Or set NOTMYFAULT_TOKEN to an access token with the write_repository scope and at least the Developer role.'
        : "Does NOTMYFAULT_TOKEN have the write_repository scope and at least the Developer role?",
      commentDenied: apiDenied,
      commentFromFork:
        "Pipelines of merge requests from forks cannot use the variables of the project; the summary file has the full report.",
      issuesDenied: apiDenied,
      checkDenied: "",
    },
    rerunNotice: false,
  };
}
