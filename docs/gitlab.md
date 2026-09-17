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

## CI/CD Catalog component

notmyfault is also a component of the [CI/CD Catalog](https://docs.gitlab.com/ci/components/), with inputs instead of variables:

```yaml
include:
  - component: $CI_SERVER_FQDN/notmyfault/notmyfault/notmyfault@1.10.0
    inputs:
      needs: [test]
      junit: reports/junit.xml
      key: test
      mode: quarantine
      tolerate: flaky, broken

# The other variables go in a job of the same name.
notmyfault:
  variables:
    NOTMYFAULT_FLAKY_ISSUES: "true"
```

| Input | Default | Description |
|---|---|---|
| `job-name` | `notmyfault` | Name of the job |
| `stage` | `.post` | Stage of the job, which runs even when earlier jobs failed |
| `needs` | `[]` | The jobs writing the JUnit reports, which must keep them in `artifacts:paths` |
| `junit` | `**/junit*.xml` | Glob(s) matching the JUnit XML reports |
| `key` | the job name | Name of the test suite in the history |
| `mode` | `report` | `report` or `quarantine` |
| `tolerate` | `flaky` | Verdicts that do not fail the job in quarantine mode |
| `flaky-issues` | `false` | Keep an issue open for each flaky test |
| `image` | `node:24-alpine` | Image with Node.js 24 |

Each version of the component runs the `notmyfault.mjs` of the commit it was released from, so `@1.10.0` never changes. The catalog also lists `notmyfault.gitlab-ci`, the [template](#3-add-the-notmyfault-job) with its hidden jobs to extend.

**Where it is published.** A component can only be included from the GitLab instance that publishes it. It is published on [gitlab.aldwin.fr](https://gitlab.aldwin.fr/explore/catalog), where the demo runs. On another self-managed instance, mirror [the repository](https://github.com/tashikomaaa/notmyfault) into a project, turn on **Settings > General > Visibility > CI/CD Catalog project**, and push a release tag like `v1.10.0`: the `.gitlab-ci.yml` of the repository creates the release, which publishes the version.

## Publish the history pages

The pages notmyfault writes on the history branch, a page per suite listing its unreliable tests, can be published with GitLab Pages. The template has a job for it, to run after notmyfault on the default branch:

```yaml
pages:
  extends: .notmyfault-pages
  needs: [notmyfault]
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

It fetches the history branch with the job token, and publishes its `index.html`, `reports/` and `badges/`. The badges then have an address of their own, for a project badge:

```
https://img.shields.io/endpoint?url=https://<namespace>.gitlab.io/<project>/badges/<key>.json
```

See the pages of the [GitLab demo](https://pages.aldwin.fr/notmyfault/notmyfault-demo/).

## Pin a release

`v1` follows every 1.x release. To run an exact file, pin the release and its checksum, published in the notes of each [GitHub release](https://github.com/tashikomaaa/notmyfault/releases) and in its `notmyfault.mjs.sha256` asset:

```yaml
notmyfault:
  extends: .notmyfault
  needs: [test]
  variables:
    NOTMYFAULT_REF: v1.6.0
    NOTMYFAULT_SHA256: <the SHA-256 of notmyfault.mjs in the v1.6.0 release>
    NOTMYFAULT_JUNIT: reports/junit.xml
```

The job then fails before running anything if the downloaded file is different. The build provenance of the file can be checked too, see [Supply chain](security.md#supply-chain). Include the template from the same tag, so that it cannot change either.

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
| `NOTMYFAULT_SHA256` | none | SHA-256 of `notmyfault.mjs` at `NOTMYFAULT_REF`: the template fails on any other file |
| `NOTMYFAULT_SUMMARY_FILE` | `notmyfault-summary.md` | Where the summary is written |
| `NOTMYFAULT_CODE_QUALITY_FILE` | `gl-code-quality-report.json` | Where the Code Quality report is written |
| `NOTMYFAULT_OUTPUT_FILE` | `notmyfault.env` | Where the outputs are written, as a dotenv file |

The others: `NOTMYFAULT_SUITES`, `NOTMYFAULT_MODE`, `NOTMYFAULT_TOLERATE`, `NOTMYFAULT_QUARANTINE`, `NOTMYFAULT_HISTORY_BRANCH`, `NOTMYFAULT_COMMENT`, `NOTMYFAULT_ANNOTATIONS`, `NOTMYFAULT_FLAKY_ISSUES`, `NOTMYFAULT_MENTION_OWNERS`, `NOTMYFAULT_MISSING_TESTS`, `NOTMYFAULT_RERUN_FLAKY`, `NOTMYFAULT_RECORD` and `NOTMYFAULT_WINDOW`. Multi-line values, like several suites, work in YAML:

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
- **Outputs** as variables for later jobs that `needs` the notmyfault job: `NOTMYFAULT_TOTAL`, `NOTMYFAULT_FAILED`, `NOTMYFAULT_NEW_FAILURES`, `NOTMYFAULT_FLAKY_FAILURES`, `NOTMYFAULT_BROKEN_FAILURES`, `NOTMYFAULT_RETRIED`, `NOTMYFAULT_FIXED`, `NOTMYFAULT_SLOWER`, `NOTMYFAULT_MISSING`, `NOTMYFAULT_QUARANTINED` and `NOTMYFAULT_BLOCKING`. See [Outputs](configuration.md#outputs).
- **Flaky test issues** with `NOTMYFAULT_FLAKY_ISSUES: "true"`, labeled `flaky-test`, see [`flaky-issues`](configuration.md#flaky-issues).

The history branch is the same as on GitHub, with its badges and pages, see [How it works](how-it-works.md#the-history). A project badge (**Settings > General > Badges**) can show the number of flaky tests of a public project:

```
https://img.shields.io/endpoint?url=https://gitlab.example.com/<group>/<project>/-/raw/notmyfault-history/badges/<key>.json
```

## Without a token

Without `NOTMYFAULT_TOKEN`, notmyfault uses the job token. It reads the history, writes the summary, the Code Quality report and the outputs, but:

- it can only push the history once **Allow Git push requests to the repository** is on in **Settings > CI/CD > Job token permissions**;
- it cannot comment on merge requests or manage issues, and logs a warning instead.

## Re-run flaky failures

Passing when the same commit runs again proves a test flaky, and unblocks the merge request. With `NOTMYFAULT_RERUN_FLAKY: "true"`, notmyfault starts a new pipeline for the commit when only flaky tests stand in the way:

- in report mode, when every failure is flaky, as the test job then fails the pipeline;
- in quarantine mode, when every failure that is not tolerated is flaky, which needs `flaky` left out of `NOTMYFAULT_TOLERATE`.

For a merge request, the new pipeline runs for the merge request. For a tracked branch, it runs for the branch, unless a newer commit was pushed since. It happens **once per commit**: a commit that already has another pipeline of the same kind is never re-run, whatever the outcome. The comment says so, and the next pipeline updates it:

> 🔁 **Re-run:** only flaky tests stand in the way, so notmyfault started [a new pipeline](#re-run-flaky-failures) for this commit. Passing there proves them flaky.

It needs `NOTMYFAULT_TOKEN` with the `api` scope and the Developer role; the job token cannot start pipelines.

## Differences with GitHub

- **Re-runs.** On GitHub, a companion workflow re-runs failed jobs when only flaky tests failed. On GitLab, notmyfault starts the new pipeline itself, see [Re-run flaky failures](#re-run-flaky-failures). Unlike [`retry`](https://docs.gitlab.com/ci/yaml/#retry), it leaves real failures alone.
- **No separate check.** GitLab has no checks: `NOTMYFAULT_CHECK` is ignored, with a warning. In quarantine mode, the notmyfault job already fails only on failures that are not tolerated.
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

### `Could not start a new pipeline. …`

[`NOTMYFAULT_RERUN_FLAKY`](#re-run-flaky-failures) is on, but the token cannot create pipelines: it needs the `api` scope and the Developer role. On a protected branch, the role must also be allowed to merge or push to it.

### `CI_PROJECT_PATH is not set. notmyfault must run inside GitLab CI/CD.`

`GITLAB_CI` is set but not the other predefined variables, which happens when running `notmyfault.mjs` by hand. It only runs in GitLab CI/CD jobs and GitHub Actions.

### `No JUnit report matched "…"`

The notmyfault job did not get the reports: check that the test job lists them in `artifacts:paths`, with `when: always`, and that the notmyfault job `needs` it. See [Troubleshooting](troubleshooting.md) for every other message.
