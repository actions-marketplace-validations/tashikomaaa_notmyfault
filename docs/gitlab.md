# GitLab CI/CD

<p align="center">
  <img alt="The croissant mascot holding a sign reading &quot;Not my fault&quot;." src="assets/sticker-not-my-fault.png" width="220">
</p>

notmyfault runs in GitLab CI/CD with the same history, the same verdicts and the same reports as on GitHub. It comments on merge requests, fills the Code Quality widget, and can keep an issue open for each flaky test.

It is the same code as the GitHub Action, bundled in one file with no dependencies, [`dist/notmyfault.mjs`](../dist/notmyfault.mjs), and run with Node.js in a job of its own. It is tested on self-managed GitLab CE 19.3 and runs the same on gitlab.com.

## Requirements

- A job that runs your tests and writes **JUnit XML**, see [Test runners](test-runners.md).
- A runner that can start the `node:24-alpine` image, like the gitlab.com shared runners or any Docker runner. The notmyfault job needs Node.js 24 and git, whatever language your tests are written in.
- An access token that can push a branch and comment, see [the token](#2-create-a-token). The job token alone cannot comment, see [Without a token](#without-a-token).

## Setup

### 1. Keep the JUnit reports as artifacts

The notmyfault job reads the reports of your test job, so list them in `artifacts:paths`. `artifacts:reports:junit` alone does not pass them to later jobs.

```yaml
test:
  image: node:24
  script:
    - npm ci
    - npx vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml
  artifacts:
    when: always          # failed tests are what notmyfault explains
    paths: [reports/]
    reports:
      junit: reports/junit.xml
```

### 2. Create a token

notmyfault pushes its history to a branch and comments through the API, which the job token cannot do. Create a **project access token** in **Settings > Access tokens**:

- **Role:** Developer, to push the history branch.
- **Scopes:** `api` and `write_repository`.

Then add it in **Settings > CI/CD > Variables** as `NOTMYFAULT_TOKEN`, with **Masked** checked and **Protected** unchecked, so that merge request pipelines can use it.

On gitlab.com, project access tokens need the Premium or Ultimate tier. On the Free tier, use a personal access token with the same scopes, ideally from a dedicated account that is a Developer of the project. Self-managed GitLab has project access tokens on every tier.

Every pipeline of the project can read an unprotected variable, including pipelines of branches pushed by any Developer. The token gives nothing more than a Developer already has, but keep its role and scopes to what is listed here. See [Permissions and security](security.md#gitlab).

### 3. Add the notmyfault job

Include the template, then extend it in a job that needs your test job:

```yaml
include:
  - remote: https://raw.githubusercontent.com/tashikomaaa/notmyfault/v1/templates/notmyfault.gitlab-ci.yml

notmyfault:
  extends: .notmyfault
  needs: [test]
  variables:
    NOTMYFAULT_JUNIT: reports/junit.xml
    NOTMYFAULT_KEY: test
```

The [template](../templates/notmyfault.gitlab-ci.yml) defines a hidden job, `.notmyfault`, which:

- runs in the `.post` stage and `when: always`, so it runs after failed tests too;
- downloads `dist/notmyfault.mjs` from the tag in `NOTMYFAULT_REF`, `v1` by default, which follows every 1.x release;
- keeps the summary, the Code Quality report and the outputs as artifacts, and links the summary from merge requests as *notmyfault report*.

Set `NOTMYFAULT_KEY` to name the history of the suite. It defaults to the name of the job running notmyfault, `notmyfault` here, which would not tell several suites apart.

### 4. Run pipelines for merge requests

notmyfault compares merge requests with the history of the default branch, so pipelines must run on both. With [`workflow:rules`](https://docs.gitlab.com/ci/yaml/workflow/), avoid running two pipelines for each push to a branch with a merge request:

```yaml
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS
      when: never
    - if: $CI_COMMIT_BRANCH
```

Merge it. The first pipeline on the default branch creates the `notmyfault-history` branch. History pushes carry the `ci.skip` push option, so they never start a pipeline.

## A complete example

This is the configuration of the [GitLab demo project](https://gitlab.aldwin.fr/notmyfault/notmyfault-demo), in quarantine mode:

```yaml
include:
  - remote: https://raw.githubusercontent.com/tashikomaaa/notmyfault/v1/templates/notmyfault.gitlab-ci.yml

workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS
      when: never
    - if: $CI_COMMIT_BRANCH

test:
  image: node:24
  allow_failure: true     # in quarantine mode, the notmyfault job decides
  script:
    - npm ci
    - npx vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml
  artifacts:
    when: always
    paths: [reports/]
    reports:
      junit: reports/junit.xml

notmyfault:
  extends: .notmyfault
  needs: [test]
  variables:
    NOTMYFAULT_JUNIT: reports/junit.xml
    NOTMYFAULT_KEY: test
    NOTMYFAULT_MODE: quarantine
    NOTMYFAULT_TOLERATE: flaky, broken
    NOTMYFAULT_FLAKY_ISSUES: "true"
```

## Quarantine mode

In [quarantine mode](quarantine.md), the notmyfault job fails when a failure is not tolerated. Add `allow_failure: true` to the test job: the pipeline then passes with a warning when every failure is tolerated, and fails on a real one.

If merge requests require a successful pipeline, the requirement now means "no failure that looks real".

## Without the template

When the test job already runs Node.js 24 and has git, like the `node:24` image, notmyfault can run in the same job:

```yaml
test:
  image: node:24
  variables:
    NOTMYFAULT_JUNIT: reports/junit.xml
  script:
    - npm ci
    - npx vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml
  after_script:
    # Runs even when the tests failed. Its exit code never changes the job status.
    - curl -fsSL -o /tmp/notmyfault.mjs https://raw.githubusercontent.com/tashikomaaa/notmyfault/v1/dist/notmyfault.mjs
    - node /tmp/notmyfault.mjs
  artifacts:
    when: always
    paths: [notmyfault-summary.md]
    reports:
      junit: reports/junit.xml
      codequality: gl-code-quality-report.json
      dotenv: notmyfault.env
```

This is report mode: the tests decide whether the job fails. For quarantine mode, move the two lines from `after_script` to the end of `script`, and let the tests fail without stopping the script: `npx vitest run … || true`.

Each release also attaches `notmyfault.mjs` to its [GitHub release](https://github.com/tashikomaaa/notmyfault/releases), to download it from there or to keep a copy in your own repository.

## Variables

Every [input](configuration.md#inputs) of the GitHub Action is a variable: its name in upper case, with `-` replaced by `_`, prefixed with `NOTMYFAULT_`. Their meaning and their defaults are the same, except for these:

| Variable | Default on GitLab | Description |
|---|---|---|
| `NOTMYFAULT_JUNIT` | required, unless `NOTMYFAULT_SUITES` | Glob(s) matching the JUnit XML reports, relative to the project directory |
| `NOTMYFAULT_TOKEN` | `CI_JOB_TOKEN` | Access token used to push the history, comment and manage issues |
| `NOTMYFAULT_KEY` | the job name | Name of the test suite in the history |
| `NOTMYFAULT_TRACK_BRANCHES` | the default branch | Branches whose pipelines build the history |
| `NOTMYFAULT_REF` | `v1` | Tag or commit of notmyfault downloaded by the template |
| `NOTMYFAULT_SUMMARY_FILE` | `notmyfault-summary.md` | Where the summary is written |
| `NOTMYFAULT_CODE_QUALITY_FILE` | `gl-code-quality-report.json` | Where the Code Quality report is written |
| `NOTMYFAULT_OUTPUT_FILE` | `notmyfault.env` | Where the outputs are written, as a dotenv file |

The others: `NOTMYFAULT_SUITES`, `NOTMYFAULT_MODE`, `NOTMYFAULT_TOLERATE`, `NOTMYFAULT_QUARANTINE`, `NOTMYFAULT_HISTORY_BRANCH`, `NOTMYFAULT_COMMENT`, `NOTMYFAULT_ANNOTATIONS`, `NOTMYFAULT_FLAKY_ISSUES`, `NOTMYFAULT_RECORD` and `NOTMYFAULT_WINDOW`. Multi-line values, like several suites, work in YAML:

```yaml
  variables:
    NOTMYFAULT_SUITES: |
      unit: reports/unit/*.xml
      e2e: reports/e2e/*.xml
```

A pipeline is **tracked**, and builds the history, when it runs for a branch listed in `NOTMYFAULT_TRACK_BRANCHES`. Merge request pipelines and tag pipelines are compared with the history without building it.

## What you get

- **A merge request comment**, the same as on GitHub, created when a test failed, needed a retry or was fixed, then kept up to date. It links to the CI job.
- **The Code Quality widget** of the merge request lists the failed tests notmyfault finds in the repository, with their verdict: *major* for new and suspect failures, *info* for flaky and already failing tests. This replaces the annotations of GitHub.
- **The summary**, with the rankings and the trend charts, in the *notmyfault report* artifact linked from the merge request.
- **The job log**, with each verdict in a collapsible section.
- **Outputs** as variables for later jobs that `needs` the notmyfault job: `NOTMYFAULT_TOTAL`, `NOTMYFAULT_FAILED`, `NOTMYFAULT_NEW_FAILURES`, `NOTMYFAULT_FLAKY_FAILURES`, `NOTMYFAULT_BROKEN_FAILURES`, `NOTMYFAULT_RETRIED`, `NOTMYFAULT_FIXED`, `NOTMYFAULT_SLOWER`, `NOTMYFAULT_QUARANTINED` and `NOTMYFAULT_BLOCKING`. See [Outputs](configuration.md#outputs).
- **Flaky test issues** with `NOTMYFAULT_FLAKY_ISSUES: "true"`, labeled `flaky-test`, see [`flaky-issues`](configuration.md#flaky-issues).

The history branch is the same as on GitHub, with its badges and pages, see [How it works](how-it-works.md#the-history). A project badge (**Settings > General > Badges**) can show the number of flaky tests of a public project:

```
https://img.shields.io/endpoint?url=https://gitlab.example.com/<group>/<project>/-/raw/notmyfault-history/badges/<key>.json
```

## Without a token

Without `NOTMYFAULT_TOKEN`, notmyfault uses the job token. It reads the history, writes the summary, the Code Quality report and the outputs, but:

- it can only push the history once **Allow Git push requests to the repository** is on in **Settings > CI/CD > Job token permissions**;
- it cannot comment on merge requests or manage issues, and logs a warning instead.

## Differences with GitHub

- **No re-run notice.** GitHub workflows can re-run failed jobs when only flaky tests failed. On GitLab, [`retry`](https://docs.gitlab.com/ci/yaml/#retry) on the test job retries every failure.
- **No annotations next to the code.** The Code Quality widget takes their place. Showing its findings in the diff needs GitLab Ultimate.
- **Merge requests from forks** are compared with the history of the target project, but never recorded. Their pipelines run in the fork by default, without the variables of your project: the comment is missing and the job log explains why. A maintainer can run the pipeline in the parent project instead.
- **Retrying the test job** does not retry the notmyfault job, which already ran. Retry it too, or run a new pipeline: a test failing then passing on the same commit is proven flaky either way.

## Troubleshooting

### `Could not record history on branch "notmyfault-history". Does NOTMYFAULT_TOKEN have the write_repository scope and at least the Developer role?`

The token cannot push. Check its role and scopes. When a protected branch pattern like `*` matches `notmyfault-history`, allow the token's role to push and to force push, or rename the history branch with `NOTMYFAULT_HISTORY_BRANCH`.

### `The job token can only push once "Allow Git push requests to the repository" is on …`

`NOTMYFAULT_TOKEN` is not set, or not available in this pipeline: variables marked **Protected** only reach pipelines of protected branches and tags. See [Without a token](#without-a-token).

### `Could not comment on the merge request. …`

With `NOTMYFAULT_TOKEN`, the token lacks the `api` scope or the Reporter role. Without it, set it: the job token cannot comment.

### `CI_PROJECT_PATH is not set. notmyfault must run inside GitLab CI/CD.`

`GITLAB_CI` is set but not the other predefined variables, which happens when running `notmyfault.mjs` by hand. It only runs in GitLab CI/CD jobs and GitHub Actions.

### `No JUnit report matched "…"`

The notmyfault job did not get the reports: check that the test job lists them in `artifacts:paths`, with `when: always`, and that the notmyfault job `needs` it. See [Troubleshooting](troubleshooting.md) for every other message.
