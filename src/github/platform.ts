import type { Io, Platform } from "../platform";
import { GitHubClient } from "./api";
import { readContext } from "./context";
import { ActionIO } from "./io";

/** notmyfault as a GitHub Action. */
export function githubPlatform(env: NodeJS.ProcessEnv, io: Io = new ActionIO(env)): Platform {
  const context = readContext(env);
  return {
    name: "github",
    context,
    io,
    forge: (token) => new GitHubClient(token, context.apiUrl, context.apiProject),
    gitUser: () => "x-access-token",
    gitAuthor: { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
    pushOptions: [],
    commitUrl: (sha) => `${context.serverUrl}/${context.repository}/commit/${sha}`,
    text: {
      pullRequest: "pull request",
      changePrefix: "#",
      runLink: "Workflow run",
      runName: "workflow run",
      tokenMissing: 'Input "token" is empty. Pass `token: ${{ github.token }}`.',
      recordDenied: 'Does the job have "contents: write" permission?',
      commentDenied: 'Does the job have "pull-requests: write" permission?',
      commentFromFork: "Tokens are read-only on pull requests from forks; the job summary has the full report.",
      checkDenied: 'Does the job have "checks: write" permission?',
      rerunDenied: "",
      issuesDenied: 'Does the job have "issues: write" permission?',
    },
    rerunNotice: true,
  };
}
