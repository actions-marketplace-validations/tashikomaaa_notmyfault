import { githubPlatform } from "./github/platform";
import { gitlabPlatform } from "./gitlab/platform";
import type { Platform } from "./platform";

/** The platform the process runs on, from the variables CI systems set. */
export function detectPlatform(env: NodeJS.ProcessEnv): Platform {
  if (env.GITLAB_CI === "true") return gitlabPlatform(env);
  if (env.GITHUB_ACTIONS === "true") return githubPlatform(env);
  throw new Error("notmyfault runs in GitHub Actions or GitLab CI/CD: neither GITHUB_ACTIONS nor GITLAB_CI is set.");
}
