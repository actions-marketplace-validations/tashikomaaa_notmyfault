/**
 * notmyfault outside of the GitHub Action, as a single file run with Node.js:
 * `node notmyfault.mjs` in a GitLab CI/CD job, or in GitHub Actions.
 */
import { runOn } from "./main";
import { detectPlatform } from "./platforms";

try {
  process.exitCode = await runOn(detectPlatform(process.env));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
