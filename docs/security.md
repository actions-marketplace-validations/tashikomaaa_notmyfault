# Permissions and security

## Permissions

| Permission | Used for | Without it |
|---|---|---|
| `contents: write` | Pushing the `notmyfault-history` branch | The history is never recorded: every failure is reported as new, with a warning |
| `pull-requests: write` | Creating and updating the pull request comment, finding the pull request a commit came from when a test starts failing on a tracked branch, and reading the files a pull request deletes | No comment, with a warning. The job summary still has the report. Reports name the commit that broke a test, not its pull request |
| `checks: write` | Only with [`check`](configuration.md#check): creating the `notmyfault` check | No check, with a warning |
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

A suite remembers at most 20 000 tests: past that, the tests seen longest ago are forgotten first, so a report full of made-up names cannot grow the branch without end. Test names are cut at 500 characters per part.

## Network access

notmyfault talks to your GitHub or GitLab server only:

- git over HTTPS, to read and push the history branch;
- the REST API, to list, create and update pull request comments, and flaky test issues.

There is no telemetry and no third-party service. On GitLab, the job running it first downloads notmyfault itself, see [GitLab](#gitlab).

## Token handling

- The token is masked in the logs as soon as the action starts. Outside GitHub Actions, where no runner masks anything, notmyfault replaces it itself in everything it prints, writes to `notmyfault-summary.md`, `notmyfault.env` and the Code Quality report.
- A test that fails while printing its configuration can put the token in a report. It is replaced by `***` in test names, identities and failure messages before anything is published or recorded.
- git receives it through `GIT_CONFIG_*` environment variables, never as a command-line argument, so it does not show up in process listings, and the credential is scoped to the origin of the remote: a redirect to another host is never given the token.
- A repository URL that carries a user name and a password, as `https://user:token@host/org/repo.git` does, is split before use: the password becomes the credential, and the URL published in the dashboard and written in the log carries neither.
- The REST clients follow the pages of a listing only on the host and path of the API they were given, and never follow a redirect off that host.
- git runs in a temporary repository created in `RUNNER_TEMP`, with your global and system git configuration ignored, so credential helpers and hooks are not involved.

## What comes from outside

The JUnit reports, the CODEOWNERS file and the quarantine file are read from the branch under test, which a pull request from a fork can change. The history branch is written by every run that records. notmyfault treats all of them as written by someone else:

- **Names and messages** lose control characters and terminal escape sequences, so a test name cannot rewrite a log line, and are cut to a length a report can show.
- **Names, messages and links are escaped** where they are rendered: comments, job summaries, issues and the history pages. A link is only a link when it is an `http` or `https` address, so a stored `javascript:` address is shown as text.
- **Patterns** in CODEOWNERS and in the quarantine file are matched without regular expressions, in time proportional to the text: a crafted pattern cannot hold a job for ever. Patterns longer than 256 characters are ignored.
- **The XML** is parsed with a bounded depth and bounded attributes, and unmatched closing tags do not slow it down.
- **The history** is checked field by field when it is read: outcomes, dates, commit prefixes, durations and links must have the shape notmyfault writes, and anything else is dropped. Its test names are keys of a map without a prototype, so a test named `__proto__` is a test like any other.

## Pull requests from forks

GitHub gives workflows triggered by pull requests from forks a read-only token. notmyfault detects these pull requests, analyzes the failures against the history, writes the job summary and skips recording. Commenting fails with a warning.

Do not switch to `pull_request_target` to work around it. That event runs with a write token in the context of your repository; checking out and running the code of a fork in it gives that code your token. This is a well-known way to compromise a repository.

## Branch protection and rulesets

If a ruleset targets all branches, pushes to `notmyfault-history` are rejected and a warning is logged on every run. Exclude the branch from the ruleset, or allow GitHub Actions to bypass it. The history branch needs no protection: it is rewritten on every run by design, and deleting it only resets the history.

## Supply chain

- **No runtime dependencies.** The action is a single bundled file, `dist/index.js`, built from `src/` with no third-party code.
- **Verifiable build.** CI rebuilds `dist/` and fails if it differs from the committed file, so the code that runs is the code you can read.
- **Pinning.** Use a full commit SHA for the strictest policies, see [Recipes](recipes.md#pin-to-a-commit).
- **Build provenance.** For each release, a workflow rebuilds `dist/index.js`, `dist/notmyfault.mjs` and `dist/dashboard.js` from the tag, checks that they are the committed files, and attests their provenance with [GitHub artifact attestations](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations). The npm package is published from the same workflow with `--provenance`, so npm shows where and from which commit it was built. It attaches `notmyfault.mjs` and `notmyfault.mjs.sha256` to the release, and adds the checksum to its notes. Check that a file was built by this repository:

  ```sh
  gh attestation verify notmyfault.mjs --repo tashikomaaa/notmyfault
  ```

  Releases up to 1.5.0 have no attestation.

## GitLab

- **The token.** `NOTMYFAULT_TOKEN` needs the Developer role, the `write_repository` scope to push the history branch and the `api` scope to comment and manage issues. A project access token is limited to one project and expires: prefer it to a personal access token. See [Create a token](gitlab.md#2-create-a-token).
- **Who can read it.** Merge request pipelines only get variables that are not protected, and every pipeline of the project can read those, including pipelines of branches any Developer pushes. The token gives nothing a Developer does not already have. If that is still too much, mark it **Protected**: pipelines of protected branches keep building the history, merge requests are still compared with it but get no comment.
- **Masking.** Mark the variable **Masked**. notmyfault never prints the token and gives it to git through environment variables, like on GitHub.
- **The downloaded code.** The template downloads `dist/notmyfault.mjs` from GitHub, from the release it was published with, and refuses to run it unless it matches the checksum it carries, see [Pin another release](gitlab.md#pin-another-release). The `remote:` include of the template itself has no checksum, so include it from a tag or a commit rather than from `v1`, or use the [component](gitlab.md#cicd-catalog-component), which GitLab resolves to a commit. Or keep a copy of the file in your repository, see [Without the template](gitlab.md#without-the-template). When the image lacks git, the template also installs it with `apk`.
- **Merge requests from forks** are never recorded. Their pipelines run in the fork, without your variables, unless a maintainer runs them in the parent project: review the changes first, as that pipeline gets your token.

## Reporting a vulnerability

Please do not open a public issue. Follow [SECURITY.md](../SECURITY.md).
