# Permissions and security

## Permissions

| Permission | Used for | Without it |
|---|---|---|
| `contents: write` | Pushing the `notmyfault-history` branch | The history is never recorded: every failure is reported as new, with a warning |
| `pull-requests: write` | Creating and updating the pull request comment | No comment, with a warning. The job summary still has the report |
| `issues: write` | Only with [`flaky-issues`](configuration.md#flaky-issues): opening, updating and closing flaky test issues, and creating the `flaky-test` label | No issues, with a warning |

Declare them in the workflow, at the top level or on the job:

```yaml
permissions:
  contents: write
  pull-requests: write
```

When you declare `permissions`, every permission you omit is set to none. If other steps of the job need more (packages, id-token…), list them too.

### Least privilege

The history is built by runs on tracked branches. If granting `contents: write` to pull request runs is not acceptable, grant it only where it matters. Pull request runs then read the history without writing to it, and only lose the ability to prove flakiness through re-runs.

`permissions` cannot depend on the event, so split the workflow in two, and keep the same `key` in both so they share one history:

```yaml
# .github/workflows/main.yml
on:
  push:
    branches: [main]
permissions:
  contents: write
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      # ...
      - uses: tashikomaaa/notmyfault@v1
        if: ${{ !cancelled() }}
        with:
          junit: reports/**/*.xml
          key: test
```

```yaml
# .github/workflows/pull-requests.yml
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      # ...
      - uses: tashikomaaa/notmyfault@v1
        if: ${{ !cancelled() }}
        with:
          junit: reports/**/*.xml
          key: test
          record: false
```

`record: false` avoids a warning on every pull request run.

## What notmyfault stores

The history branch contains, for each test: its name, a string of outcome letters, up to 20 short commit SHAs, up to 10 dated proofs of flakiness, up to 10 fingerprints of failure messages seen on tracked branches, the durations of its last 10 runs there, and the last days it failed and was seen. It never stores failure messages, logs, environment variables or source code.

A fingerprint is a 12-character hash of a normalized message, see [Errors](how-it-works.md#errors). It does not contain the message, but a short and common message could be recognized by hashing candidates.

The branch has the same visibility as your repository. In a public repository, test names are public, as they already are in your source code.

## Network access

notmyfault talks to your GitHub or GitLab server only:

- git over HTTPS, to read and push the history branch;
- the REST API, to list, create and update pull request comments, and flaky test issues.

There is no telemetry and no third-party service. On GitLab, the job running it first downloads notmyfault itself, see [GitLab](#gitlab).

## Token handling

- The token is masked in the logs as soon as the action starts.
- git receives it through `GIT_CONFIG_*` environment variables, never as a command-line argument, so it does not show up in process listings.
- git runs in a temporary repository created in `RUNNER_TEMP`, with your global and system git configuration ignored, so credential helpers and hooks are not involved.

## Pull requests from forks

GitHub gives workflows triggered by pull requests from forks a read-only token. notmyfault detects these pull requests, analyzes the failures against the history, writes the job summary and skips recording. Commenting fails with a warning.

Do not switch to `pull_request_target` to work around it. That event runs with a write token in the context of your repository; checking out and running the code of a fork in it gives that code your token. This is a well-known way to compromise a repository.

## Branch protection and rulesets

If a ruleset targets all branches, pushes to `notmyfault-history` are rejected and a warning is logged on every run. Exclude the branch from the ruleset, or allow GitHub Actions to bypass it. The history branch needs no protection: it is rewritten on every run by design, and deleting it only resets the history.

## Supply chain

- **No runtime dependencies.** The action is a single bundled file, `dist/index.js`, built from `src/` with no third-party code.
- **Verifiable build.** CI rebuilds `dist/` and fails if it differs from the committed file, so the code that runs is the code you can read.
- **Pinning.** Use a full commit SHA for the strictest policies, see [Recipes](recipes.md#pin-to-a-commit).

## GitLab

- **The token.** `NOTMYFAULT_TOKEN` needs the Developer role, the `write_repository` scope to push the history branch and the `api` scope to comment and manage issues. A project access token is limited to one project and expires: prefer it to a personal access token. See [Create a token](gitlab.md#2-create-a-token).
- **Who can read it.** Merge request pipelines only get variables that are not protected, and every pipeline of the project can read those, including pipelines of branches any Developer pushes. The token gives nothing a Developer does not already have. If that is still too much, mark it **Protected**: pipelines of protected branches keep building the history, merge requests are still compared with it but get no comment.
- **Masking.** Mark the variable **Masked**. notmyfault never prints the token and gives it to git through environment variables, like on GitHub.
- **The downloaded code.** The template downloads `dist/notmyfault.mjs` from GitHub at the tag in `NOTMYFAULT_REF`. Set it to a full commit SHA for the strictest policies, or keep a copy of the file in your repository, see [Without the template](gitlab.md#without-the-template). When the image lacks git, the template also installs it with `apk`.
- **Merge requests from forks** are never recorded. Their pipelines run in the fork, without your variables, unless a maintainer runs them in the parent project: review the changes first, as that pipeline gets your token.

## Reporting a vulnerability

Please do not open a public issue. Follow [SECURITY.md](../SECURITY.md).
