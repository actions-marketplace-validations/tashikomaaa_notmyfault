import { forgejoPlatform } from "./forgejo/platform";
import { genericPlatform } from "./generic/platform";
import { githubPlatform } from "./github/platform";
import { gitlabPlatform } from "./gitlab/platform";
import type { Platform } from "./platform";

/** The platform the process runs on, from the variables CI systems set. */
export function detectPlatform(env: NodeJS.ProcessEnv): Platform {
  if (env.GITLAB_CI === "true") return gitlabPlatform(env);
  // Forgejo and Gitea Actions also set GITHUB_ACTIONS.
  if (env.FORGEJO_ACTIONS === "true" || env.GITEA_ACTIONS === "true") return forgejoPlatform(env);
  if (env.GITHUB_ACTIONS === "true") return githubPlatform(env);
  // Anywhere else, notmyfault reads its configuration from NOTMYFAULT_* variables and git.
  return genericPlatform(env);
}
