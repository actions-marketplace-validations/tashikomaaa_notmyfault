import type { Io, Platform } from "../platform";
import { GitLabClient } from "./api";
import { readGitLabContext } from "./context";
import { GitLabIO } from "./io";

/** notmyfault in a GitLab CI/CD job. */
export function gitlabPlatform(env: NodeJS.ProcessEnv, io: Io = new GitLabIO(env)): Platform {
  const context = readGitLabContext(env);
  const isJobToken = (token: string) => token === env.CI_JOB_TOKEN;
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
    text: {
      pullRequest: "merge request",
      runLink: "CI job",
      tokenMissing: "No token: set NOTMYFAULT_TOKEN, or run in a GitLab CI/CD job, which provides CI_JOB_TOKEN.",
      recordDenied:
        "Does NOTMYFAULT_TOKEN have the write_repository scope and at least the Developer role? CI_JOB_TOKEN cannot push.",
      commentDenied: "Does NOTMYFAULT_TOKEN have the api scope and at least the Reporter role? CI_JOB_TOKEN cannot comment.",
      commentFromFork:
        "Pipelines of merge requests from forks cannot use the variables of the project; the summary file has the full report.",
      issuesDenied: "Does NOTMYFAULT_TOKEN have the api scope and at least the Reporter role?",
    },
    rerunNotice: false,
  };
}
