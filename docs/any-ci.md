# Any other CI system

<p align="center">
  <img alt="The croissant mascot pressing a red &quot;Re-run&quot; button." src="assets/sticker-rerun.png" width="200">
</p>

Jenkins, CircleCI, Buildkite, Bitbucket Pipelines, Azure Pipelines, Travis CI, Drone and others have flaky tests too. notmyfault runs in any of them with Node.js 24 and git: it keeps the same history on a branch of the repository, gives the same verdicts, and reports them in the log, a Markdown file and the exit code.

What needs the API of a code host is left out: comments on pull requests, flaky test issues and checks. On GitHub, GitLab, Forgejo and Gitea, use their integration instead: [GitHub Actions](getting-started.md), [GitLab CI/CD](gitlab.md), [Forgejo and Gitea Actions](forgejo.md).

## Running it

After the tests, in the same job, run `notmyfault.mjs` from the repository clone, with the JUnit reports:

```sh
curl -fsSL -o /tmp/notmyfault.mjs https://github.com/tashikomaaa/notmyfault/releases/download/v1.9.0/notmyfault.mjs
NOTMYFAULT_JUNIT="reports/*.xml" node /tmp/notmyfault.mjs
```

Each [release](https://github.com/tashikomaaa/notmyfault/releases) attaches the file, with its SHA-256 and its build provenance, see [Supply chain](security.md#supply-chain). Keep a copy in your repository to avoid downloading it.

### Jenkins

```groovy
pipeline {
  agent { docker { image 'node:24' } }
  environment {
    NOTMYFAULT_JUNIT = 'reports/*.xml'
    NOTMYFAULT_TOKEN = credentials('notmyfault-token')
  }
  stages {
    stage('Test') {
      steps {
        sh 'npm ci'
        sh 'npx vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml || true'
        sh 'curl -fsSL -o notmyfault.mjs https://github.com/tashikomaaa/notmyfault/releases/download/v1.9.0/notmyfault.mjs'
        sh 'NOTMYFAULT_MODE=quarantine node notmyfault.mjs'
      }
    }
  }
  post {
    always {
      junit 'reports/*.xml'
      archiveArtifacts artifacts: 'notmyfault-summary.md', allowEmptyArchive: true
    }
  }
}
```

### CircleCI

```yaml
jobs:
  test:
    docker:
      - image: cimg/node:24.0
    environment:
      NOTMYFAULT_JUNIT: reports/*.xml
    steps:
      - checkout
      - run: npm ci
      - run: npx vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml
      - run:
          when: always
          command: |
            curl -fsSL -o /tmp/notmyfault.mjs https://github.com/tashikomaaa/notmyfault/releases/download/v1.9.0/notmyfault.mjs
            node /tmp/notmyfault.mjs
      - store_test_results:
          path: reports
      - store_artifacts:
          path: notmyfault-summary.md
```

`NOTMYFAULT_TOKEN` is set in the project settings, as an environment variable.

## Storing the history

notmyfault pushes the history to the `notmyfault-history` branch of the `origin` remote of the clone, or of `NOTMYFAULT_REPOSITORY_URL`:

- **Over HTTPS**, it needs `NOTMYFAULT_TOKEN`, a token that can push to the repository, sent with the user name in `NOTMYFAULT_GIT_USER`: `x-access-token` by default, `oauth2` for hosts named like GitLab, `x-token-auth` for Bitbucket access tokens.
- **Over SSH**, git uses the key of the job, and no token is needed: a deploy key with write access, for example.

The history is recorded by runs on a tracked branch, the default branch unless `NOTMYFAULT_TRACK_BRANCHES` says otherwise. Pull request builds are compared with it.

**On a developer's machine**, where none of the variables CI systems set is present, the history is read but not recorded: a local run on `main` does not change it. Set `NOTMYFAULT_RECORD=true` to record anyway, or `NOTMYFAULT_CI=true` to be treated as a CI system.

## What it reads from the environment

Each value comes from the first place that has it:

| Value | Variable | Then | Then |
|---|---|---|---|
| Repository | `NOTMYFAULT_REPOSITORY_URL` | | the `origin` remote |
| Commit | `NOTMYFAULT_SHA` | `GIT_COMMIT`, `CIRCLE_SHA1`, `BUILDKITE_COMMIT`, `BITBUCKET_COMMIT`, `BUILD_SOURCEVERSION`, `TRAVIS_COMMIT`, `DRONE_COMMIT_SHA` | `git rev-parse HEAD` |
| Branch | `NOTMYFAULT_BRANCH` | `BRANCH_NAME`, `GIT_BRANCH`, `CIRCLE_BRANCH`, `BUILDKITE_BRANCH`, `BITBUCKET_BRANCH`, `BUILD_SOURCEBRANCH`, `TRAVIS_BRANCH`, `DRONE_BRANCH` | the checked out branch |
| Pull request | `NOTMYFAULT_PULL_REQUEST` | `CHANGE_ID`, `CIRCLE_PULL_REQUEST`, `BUILDKITE_PULL_REQUEST`, `BITBUCKET_PR_ID`, `SYSTEM_PULLREQUEST_PULLREQUESTNUMBER`, `TRAVIS_PULL_REQUEST`, `DRONE_PULL_REQUEST` | none |
| Default branch | `NOTMYFAULT_DEFAULT_BRANCH` | | `origin/HEAD` |
| Link to the build | `NOTMYFAULT_RUN_URL` | `BUILD_URL`, `CIRCLE_BUILD_URL`, `BUILDKITE_BUILD_URL`, `TRAVIS_BUILD_WEB_URL`, `DRONE_BUILD_LINK` | none |
| Key of the suite | `NOTMYFAULT_KEY` | `JOB_NAME`, `CIRCLE_JOB`, `BUILDKITE_LABEL`, `SYSTEM_JOBNAME`, `DRONE_STEP_NAME` | `tests` |

Every [input](configuration.md#inputs) of the action is a variable too, as on GitLab: `NOTMYFAULT_MODE`, `NOTMYFAULT_TOLERATE`, `NOTMYFAULT_SUITES` and the others, see [Variables](gitlab.md#variables).

## What you get

- **The log**, with the verdict of each failure, the tests the run fixes, the slower and the missing ones.
- **`notmyfault-summary.md`**, the full report with the rankings, as on GitHub. Keep it as an artifact.
- **`notmyfault.env`**, the outputs as `NOTMYFAULT_*` variables, in dotenv format.
- **The exit code**: in quarantine mode, 1 when a failure is not tolerated. Let the tests fail without stopping the job, for example with `|| true`, so that notmyfault decides.
- **The history branch**, with its badges and pages, see [How it works](how-it-works.md#the-history).
