import { describe, expect, it } from "vitest";
import { readGenericContext, webUrl } from "../../src/generic/context";

const repository = (answers: Record<string, string>) => (args: string[]) => answers[args.join(" ")];
const clone = repository({
  "remote get-url origin": "git@github.com:acme/shop.git",
  "rev-parse HEAD": "c".repeat(40),
  "rev-parse --abbrev-ref HEAD": "main",
  "symbolic-ref --short refs/remotes/origin/HEAD": "origin/trunk",
});

describe("readGenericContext", () => {
  it("reads a Jenkins multibranch pull request build", () => {
    const context = readGenericContext(
      { JENKINS_URL: "https://ci.acme.test/", BRANCH_NAME: "PR-12", CHANGE_ID: "12", GIT_COMMIT: "a".repeat(40), BUILD_NUMBER: "7", BUILD_URL: "https://ci.acme.test/job/shop/7/", JOB_NAME: "shop/PR-12" },
      clone,
    );
    expect(context).toMatchObject({
      remoteUrl: "git@github.com:acme/shop.git",
      serverUrl: "https://github.com",
      repository: "acme/shop",
      sha: "a".repeat(40),
      branch: undefined,
      pullRequest: { number: 12, fromFork: false },
      runDescription: "build 7",
      runUrl: "https://ci.acme.test/job/shop/7/",
      defaultBranch: "trunk",
      defaultKey: "shop/PR-12",
      local: false,
    });
  });

  it("reads a CircleCI branch build, and Buildkite without a pull request", () => {
    expect(readGenericContext({ CIRCLECI: "true", CIRCLE_BRANCH: "main", CIRCLE_SHA1: "b".repeat(40), CIRCLE_JOB: "test" }, clone)).toMatchObject({
      branch: "main",
      sha: "b".repeat(40),
      pullRequest: undefined,
      defaultKey: "test",
    });
    expect(readGenericContext({ BUILDKITE: "true", BUILDKITE_BRANCH: "main", BUILDKITE_PULL_REQUEST: "false" }, clone).pullRequest).toBeUndefined();
  });

  it("falls back to git and NOTMYFAULT_ variables, and knows a developer's machine", () => {
    expect(readGenericContext({}, clone)).toMatchObject({ branch: "main", sha: "c".repeat(40), defaultKey: "tests", local: true });
    expect(
      readGenericContext({ NOTMYFAULT_REPOSITORY_URL: "https://gitlab.acme.test/team/api.git", NOTMYFAULT_BRANCH: "develop", NOTMYFAULT_CI: "true" }, clone),
    ).toMatchObject({ serverUrl: "https://gitlab.acme.test", repository: "team/api", branch: "develop", local: false });
    expect(() => readGenericContext({}, () => undefined)).toThrow("No repository to store the history in");
  });
});

describe("webUrl", () => {
  it("reads HTTPS and SSH remotes", () => {
    expect(webUrl("https://github.com/acme/shop.git")).toEqual({ origin: "https://github.com", path: "acme/shop" });
    expect(webUrl("ssh://git@gitlab.acme.test:2222/team/sub/api.git")).toEqual({ origin: "https://gitlab.acme.test", path: "team/sub/api" });
    expect(webUrl("git@bitbucket.org:acme/shop.git")).toEqual({ origin: "https://bitbucket.org", path: "acme/shop" });
    expect(webUrl("/srv/git/shop.git")).toBeUndefined();
  });
});
