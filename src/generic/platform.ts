import type { Forge, Io, Platform } from "../platform";
import { readGenericContext, type Git } from "./context";
import { GenericIO } from "./io";

const WITHOUT_API = "needs the API of GitHub, GitLab, Forgejo or Gitea, and is not available in this CI system.";

/** No API to comment or open issues with: pull request comments are skipped, issues fail with a warning. */
const noForge: Forge = {
  upsertComment: async () => "skipped",
  addComment: async () => {
    throw new Error(`Commenting ${WITHOUT_API}`);
  },
  listIssues: async () => {
    throw new Error(`Managing flaky test issues ${WITHOUT_API}`);
  },
  createIssue: async () => {
    throw new Error(`Managing flaky test issues ${WITHOUT_API}`);
  },
  updateIssue: async () => {
    throw new Error(`Managing flaky test issues ${WITHOUT_API}`);
  },
  ensureLabel: async () => {
    throw new Error(`Managing flaky test issues ${WITHOUT_API}`);
  },
  changeOf: async () => undefined,
};

/** notmyfault in any other CI system, with git as its only dependency. */
export function genericPlatform(env: NodeJS.ProcessEnv, io: Io = new GenericIO(env), git?: Git): Platform {
  const context = readGenericContext(env, git);
  const host = context.serverUrl ? new URL(context.serverUrl).hostname : "localhost";
  return {
    name: "generic",
    context,
    io,
    forge: () => noForge,
    // GitHub accepts any user name with a token, GitLab wants oauth2 with personal and project tokens.
    gitUser: () => env.NOTMYFAULT_GIT_USER?.trim() || (/gitlab/.test(host) ? "oauth2" : "x-access-token"),
    gitAuthor: { name: "notmyfault", email: `notmyfault@noreply.${host}` },
    pushOptions: [],
    codeownersPaths: [".github/CODEOWNERS", ".gitlab/CODEOWNERS", "docs/CODEOWNERS", "CODEOWNERS"],
    commitUrl: (sha) => (context.serverUrl ? `${context.serverUrl}/${context.repository}/commit/${sha}` : sha),
    text: {
      pullRequest: "pull request",
      changePrefix: "#",
      runLink: "Build",
      runName: "build",
      tokenMissing: "No token: set NOTMYFAULT_TOKEN to a token that can push to the repository, or use an SSH remote with a key that can.",
      recordDenied: "Can NOTMYFAULT_TOKEN, or the SSH key of the job, push to the repository? NOTMYFAULT_GIT_USER sets the user name sent with the token.",
      commentDenied: "",
      commentFromFork: "",
      issuesDenied: "",
      checkDenied: "",
      rerunDenied: "",
    },
    rerunNotice: false,
  };
}
