import { describe, expect, it } from "vitest";
import { ownersOf, parseCodeowners } from "../src/codeowners";

describe("CODEOWNERS", () => {
  it("follows the GitHub syntax: the last matching pattern wins", () => {
    const rules = parseCodeowners(`
# Everyone reviews everything by default.
*       @acme/everyone
*.js    @js-owner  someone@example.com
/build/logs/ @doctocat
docs/*  docs@example.com @docs-team
apps/   @octocat
**/logs @logs-team
/scripts/ 
`);
    expect(ownersOf("README.md", rules)).toEqual(["@acme/everyone"]);
    expect(ownersOf("src/cart.js", rules)).toEqual(["@js-owner"]);
    expect(ownersOf("build/logs/today.txt", rules)).toEqual(["@logs-team"]);
    expect(ownersOf("docs/getting-started.md", rules)).toEqual(["@docs-team"]);
    // docs/* owns the files directly in docs/ only.
    expect(ownersOf("docs/build-app/troubleshooting.md", rules)).toEqual(["@acme/everyone"]);
    expect(ownersOf("web/apps/github/test.ts", rules)).toEqual(["@octocat"]);
    expect(ownersOf("deep/down/logs/x.txt", rules)).toEqual(["@logs-team"]);
    // A pattern without owners leaves its files without any.
    expect(ownersOf("scripts/release.sh", rules)).toEqual([]);
  });

  it("combines the GitLab sections, with their default owners", () => {
    const rules = parseCodeowners(`
* @admins

[Tests][2] @qa-team
test/
test/payments/ @payments-team

^[Docs] @writers
*.md
`);
    expect(ownersOf("test/cart.test.ts", rules)).toEqual(["@admins", "@qa-team"]);
    expect(ownersOf("test/payments/card.test.ts", rules)).toEqual(["@admins", "@payments-team"]);
    expect(ownersOf("test/README.md", rules)).toEqual(["@admins", "@qa-team", "@writers"]);
  });

  it("matches a crafted pattern from a pull request without stalling the job", () => {
    // A CODEOWNERS file comes from the branch under test: a pattern must not be able to hold the run.
    const rules = parseCodeowners(`${"**/a".repeat(40)}/*.ts @owners\n`);
    const path = `${"a/".repeat(60)}b.js`;
    const started = Date.now();
    expect(ownersOf(path, rules)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("leaves out patterns and paths too long to be real", () => {
    const rules = parseCodeowners(`${"a".repeat(300)} @owners\n* @admins\n`);
    expect(rules).toHaveLength(1);
    expect(ownersOf(`${"a/".repeat(600)}b.ts`, rules)).toEqual([]);
  });
});
