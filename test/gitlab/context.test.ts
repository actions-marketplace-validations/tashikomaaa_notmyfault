import { describe, expect, it } from "vitest";
import { readGitLabContext } from "../../src/gitlab/context";
import { detectPlatform } from "../../src/platforms";

const base = {
  CI_PROJECT_PATH: "acme/shop",
  CI_PROJECT_ID: "42",
  CI_COMMIT_SHA: "c".repeat(40),
  CI_SERVER_URL: "https://gitlab.example.com/",
  CI_API_V4_URL: "https://gitlab.example.com/api/v4",
  CI_PROJECT_DIR: "/builds/acme/shop",
  CI_DEFAULT_BRANCH: "trunk",
  CI_JOB_NAME: "unit",
  CI_PIPELINE_ID: "900",
  CI_JOB_ID: "1234",
  CI_JOB_URL: "https://gitlab.example.com/acme/shop/-/jobs/1234",
  CI_JOB_TOKEN: "job-token",
};

describe("readGitLabContext", () => {
  it("reads a branch pipeline", () => {
    expect(readGitLabContext({ ...base, CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "trunk" })).toEqual({
      repository: "acme/shop",
      apiProject: "42",
      serverUrl: "https://gitlab.example.com",
      apiUrl: "https://gitlab.example.com/api/v4",
      sha: "c".repeat(40),
      branch: "trunk",
      runDescription: "pipeline 900, job 1234",
      runUrl: "https://gitlab.example.com/acme/shop/-/jobs/1234",
      workspace: "/builds/acme/shop",
      tempDir: undefined,
      defaultBranch: "trunk",
      defaultKey: "unit",
      pullRequest: undefined,
      defaultToken: "job-token",
    });
  });

  it("reads a merge request pipeline, from the project or a fork", () => {
    const mergeRequest = {
      ...base,
      CI_PIPELINE_SOURCE: "merge_request_event",
      CI_MERGE_REQUEST_IID: "3",
      CI_MERGE_REQUEST_PROJECT_ID: "42",
      CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "42",
    };
    expect(readGitLabContext(mergeRequest)).toMatchObject({ branch: undefined, pullRequest: { number: 3, fromFork: false } });
    // Run in the fork: the target project still holds the history and the merge request.
    const inFork = {
      ...mergeRequest,
      CI_PROJECT_PATH: "someone/shop",
      CI_PROJECT_ID: "77",
      CI_MERGE_REQUEST_PROJECT_PATH: "acme/shop",
      CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "77",
    };
    expect(readGitLabContext(inFork)).toMatchObject({ repository: "acme/shop", apiProject: "42", pullRequest: { number: 3, fromFork: true } });
  });

  it("has no branch on tag pipelines", () => {
    expect(readGitLabContext({ ...base, CI_PIPELINE_SOURCE: "push", CI_COMMIT_TAG: "v1" }).branch).toBeUndefined();
  });

  it("needs the variables of a job", () => {
    expect(() => readGitLabContext({})).toThrow("CI_PROJECT_PATH is not set. notmyfault must run inside GitLab CI/CD.");
  });
});

describe("detectPlatform", () => {
  it("recognizes GitLab and GitHub, and nothing else", () => {
    expect(detectPlatform({ ...base, GITLAB_CI: "true" }).name).toBe("gitlab");
    expect(() => detectPlatform({})).toThrow("neither GITHUB_ACTIONS nor GITLAB_CI is set");
  });
});
