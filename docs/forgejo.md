# Forgejo and Gitea Actions

<p align="center">
  <img alt="The croissant mascot hugging a big green check mark." src="assets/sticker-passed.png" width="220">
</p>

Forgejo and Gitea run workflows written for GitHub Actions, and notmyfault is one of the actions they can run. It keeps the same history, gives the same verdicts and comments on pull requests. Only what their API does not have is left out.

It is tested on Forgejo 16 with Forgejo Runner 13. Gitea Actions set the same variables and share the same API, and should work the same, but are not covered by the tests yet.

## Setup

The workflow is the one of the [getting started guide](getting-started.md), in `.forgejo/workflows/` or `.gitea/workflows/`, with the full URL of the action:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml

      - uses: https://github.com/tashikomaaa/notmyfault@v1
        if: ${{ !cancelled() }}
        with:
          junit: reports/**/*.xml
```

- **The full URL.** Forgejo looks for actions on its own mirror by default, which does not have notmyfault. With `DEFAULT_ACTIONS_URL = https://github.com` in the `[actions]` section of the server configuration, `tashikomaaa/notmyfault@v1` works too.
- **Node.js 24.** notmyfault runs on the `node24` runtime: the image of the job must have Node.js 24, like `node:24`. The runner label `ubuntu-latest:docker://node:24` gives one.
- **The token.** The token Forgejo gives each job can push to the repository and comment, except on pull requests from forks.

Every input and output works as on GitHub, see [Configuration](configuration.md).

## What works

- **The history** is stored on the `notmyfault-history` branch, pushed with the token of the job, and authored by `notmyfault`.
- **Pull request comments**, created and kept up to date.
- **Flaky test issues** with `flaky-issues: true`, labeled `flaky-test`.
- **Since when a test fails**, with the pull request its first failing commit came from.
- **Owners** of flaky tests with `mention-owners: true`, from `.forgejo/CODEOWNERS`, `.gitea/CODEOWNERS`, `docs/CODEOWNERS` or `CODEOWNERS`, and `assign-owners: true` to assign them.
- **Outputs**, missing tests, quarantine mode, badges and history pages.

## Differences with GitHub

- **No checks.** Forgejo and Gitea have no checks API: `check: true` is ignored, with a warning. In quarantine mode, the notmyfault step already fails only on failures that are not tolerated.
- **No annotations next to the code.** The runner prints them in the log, as `::error file=…` lines.
- **No re-run notice.** Without the `workflow_run` event, no companion workflow can re-run failed jobs. Re-run them from the web interface.

The platform is detected from `FORGEJO_ACTIONS` or `GITEA_ACTIONS`, which the runners set along with the GitHub variables.
