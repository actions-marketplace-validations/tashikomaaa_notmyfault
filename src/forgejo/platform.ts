import { ActionIO } from "../github/io";
import { githubPlatform } from "../github/platform";
import type { Io, Platform } from "../platform";
import { ForgejoClient } from "./api";

/**
 * notmyfault as an action of Forgejo or Gitea Actions, which run GitHub
 * workflows with the same variables, but have their own API.
 */
export function forgejoPlatform(env: NodeJS.ProcessEnv, io: Io = new ActionIO(env)): Platform {
  const github = githubPlatform(env, io);
  const { context } = github;
  return {
    ...github,
    name: "forgejo",
    forge: (token) => new ForgejoClient(token, context.apiUrl, context.apiProject),
    gitAuthor: { name: "notmyfault", email: `notmyfault@noreply.${new URL(context.serverUrl).hostname || "localhost"}` },
    codeownersPaths: [".forgejo/CODEOWNERS", ".gitea/CODEOWNERS", "docs/CODEOWNERS", "CODEOWNERS"],
    text: {
      ...github.text,
      recordDenied: "Can the token push to the repository? Branch protection rules matching the history branch reject its pushes.",
      commentDenied: "Can the token comment on pull requests?",
      commentFromFork: "Tokens are read-only on pull requests from forks; the job summary has the full report.",
      issuesDenied: "Can the token write issues?",
    },
    // No workflow_run event to re-run jobs from.
    rerunNotice: false,
  };
}
