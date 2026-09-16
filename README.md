# notmyfault

[![CI](https://github.com/tashikomaaa/notmyfault/actions/workflows/ci.yml/badge.svg)](https://github.com/tashikomaaa/notmyfault/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Is this failing test your fault?**

notmyfault is a GitHub Action that remembers how every test behaves on `main` and tells each pull request which failures are **new**, which tests are **known to be flaky** and which ones were **already broken**.

- **No server, no account, no SaaS.** The history lives in a branch of your own repository.
- **Zero runtime dependencies.** One 40 KB file, nothing to audit but this repository.
- **Works with any test runner** that writes JUnit XML: Jest, Vitest, pytest, Go, Maven, Gradle, cargo-nextest, Playwright…

## What your pull requests get

---

### 🔴 3 tests failed, 1 looks related to this change

| | Test | Why |
|:-:|---|---|
| 🔴 | <code>checkout › applies discount codes</code> | **New failure.** Passed the last 50 runs on `main`. |
| ⚫ | <code>search › indexes new products</code> | **Already failing on `main`.** Failed the last 2 runs there. |
| 🟡 | <code>payments › retries declined cards</code> | **Known flaky.** Failed 4 of the last 50 runs on `main`; passed when the same commit was re-run on 2026-09-14. |

<details><summary>Failure messages</summary>

<code>checkout › applies discount codes</code>
<pre>expected 90 to be 81 // Object.is equality</pre>
<code>search › indexes new products</code>
<pre>ECONNREFUSED 127.0.0.1:9200</pre>
<code>payments › retries declined cards</code>
<pre>Timed out after 5000ms</pre>
</details>

<sub>🔁 Passed only after a retry: <code>cart › merges guest cart</code> · [Workflow run](#) · Reported by [notmyfault](#)</sub>

---

The comment is updated in place on every push, and the same report is added to the job summary along with the most unreliable tests of the project.

## Quick start

Make your test runner write JUnit XML, then add notmyfault right after the test step:

```yaml
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: write        # store the history on the notmyfault-history branch
  pull-requests: write   # comment on pull requests

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npm ci
      - run: npx vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml

      - uses: tashikomaaa/notmyfault@v1
        if: ${{ !cancelled() }}   # also run when tests fail
        with:
          junit: reports/**/*.xml
```

The history has to be built on `main` first: the first pull requests will mostly see "new failure" verdicts, and they get sharper as runs accumulate.

## Stop flaky tests from blocking merges

In `quarantine` mode, notmyfault decides whether the job fails. Let the test step continue on error, and the check only fails for failures that are not known to be flaky:

```yaml
      - run: npm test
        continue-on-error: true

      - uses: tashikomaaa/notmyfault@v1
        with:
          junit: reports/**/*.xml
          mode: quarantine
          tolerate: flaky          # or: flaky, broken
```

If no report is found (for example because the build failed before the tests ran), notmyfault fails the job, so `continue-on-error` cannot hide a broken build.

## How it works

Every run on a tracked branch (the default branch unless `track-branches` says otherwise) appends each test's outcome to a small JSON file stored on the `notmyfault-history` branch. Each failure is then compared with that history:

| Verdict | Meaning | Decided when |
|---|---|---|
| 🔴 **New failure** | Probably caused by the change | Nothing in the history explains it |
| 🟠 **Suspect** | Maybe flaky, maybe not | The test failed in isolation once or twice on the tracked branch |
| ⚫ **Already failing** | Not your fault, the branch is broken | The latest runs on the tracked branch failed too |
| 🟡 **Known flaky** | Not your fault, the test is unreliable | See the evidence below |

A test is considered flaky when there is evidence of it:

1. **It passed after a retry within the same run.** Maven Surefire/Failsafe (`rerunFailingTestsCount`), cargo-nextest retries and `gotestsum --rerun-fails` report this, as does any runner that writes `flakyFailure` elements or repeats the test case in the report.
2. **It failed, then passed when the same commit was re-run.** "Re-run failed jobs" is the most reliable proof there is, and notmyfault records it on any branch, pull requests included.
3. **It keeps failing in isolation on the tracked branch**, at least three times, surrounded by successful runs. Without direct proof, the verdict reads *probably flaky*: once or twice could just be a commit that broke the test and the next one that fixed it.

Evidence expires after 30 days, so a fixed test stops being excused.

The history branch always holds a single commit that is rewritten on each update, so it never grows. Concurrent jobs are handled with `git push --force-with-lease` and retries. Delete the branch at any time to start over.

## Inputs

| Input | Default | Description |
|---|---|---|
| `junit` | **required** | Glob(s) matching the JUnit XML reports, one per line or comma-separated. `node_modules` and `.git` are ignored. |
| `mode` | `report` | `report` never fails the step. `quarantine` fails it when a failure is not tolerated. |
| `tolerate` | `flaky` | Verdicts allowed in quarantine mode: any of `new`, `suspect`, `broken`, `flaky`. |
| `token` | `${{ github.token }}` | Token used to store the history and comment. |
| `history-branch` | `notmyfault-history` | Branch holding the history. |
| `track-branches` | default branch | Branches whose runs build the reference history, comma-separated. |
| `key` | `<workflow>-<job>` | Name of the test suite in the history. Use distinct keys for distinct suites. |
| `comment` | `true` | Comment on pull requests. A comment is only created when something failed or needed a retry, and is kept up to date afterwards. |
| `record` | `true` | Record the run in the history. |
| `window` | `50` | Number of recent runs remembered per test. |

## Outputs

| Output | Description |
|---|---|
| `total` | Tests found in the reports |
| `failed` | Failed tests |
| `new-failures` | Failures that look caused by the change (new or suspect) |
| `flaky-failures` | Failures of known flaky tests |
| `broken-failures` | Failures of tests already failing on a tracked branch |
| `retried` | Tests that passed only after a retry |
| `blocking` | Failures not covered by `tolerate` |

## Producing JUnit XML

| Runner | How |
|---|---|
| Vitest | `vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml` |
| Jest | [`jest-junit`](https://github.com/jest-community/jest-junit): `jest --reporters=default --reporters=jest-junit` |
| pytest | `pytest --junitxml=reports/junit.xml` |
| Go | [`gotestsum`](https://github.com/gotestyourself/gotestsum) `--junitfile reports/junit.xml` (add `--rerun-fails` to detect flakiness within a run) |
| Maven | Surefire/Failsafe write `target/surefire-reports/*.xml` by default |
| Gradle | Reports land in `build/test-results/**/*.xml` |
| Rust | [cargo-nextest](https://nexte.st/) with a `[profile.ci.junit]` section |
| Playwright | `reporter: [["junit", { outputFile: "reports/junit.xml" }]]` |

Anything else that writes JUnit XML should work too. If it does not, please open an issue with a sample report.

## Sharded and matrix test suites

Each notmyfault step records under its `key`. For a matrix where each job runs a **different** set of tests (sharding), prefer a single reporting job so pull requests get one comment:

```yaml
  test:
    strategy:
      matrix:
        shard: [1, 2, 3]
    steps:
      # ... run shard ${{ matrix.shard }} ...
      - uses: actions/upload-artifact@v7
        if: ${{ !cancelled() }}
        with:
          name: junit-${{ matrix.shard }}
          path: reports/

  notmyfault:
    needs: test
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v8
        with:
          path: reports/
      - uses: tashikomaaa/notmyfault@v1
        with:
          junit: reports/**/*.xml
```

For a matrix that runs the **same** tests in different environments (Node versions, operating systems), give each job its own `key`, for example `key: test-${{ matrix.os }}`.

## FAQ

**Where is my data stored?**
In your repository only, on the `notmyfault-history` branch: one JSON file per `key` with test names, recent outcomes and short commit SHAs. Nothing is sent anywhere else.

**What about pull requests from forks?**
GitHub gives them a read-only token. notmyfault still analyzes the failures and writes the job summary, but it cannot comment or record the run.

**My repository protects all branches.**
Allow the GitHub Actions bot to push to `notmyfault-history`, or exclude that branch from your ruleset.

**Does it slow down CI?**
It fetches and pushes a single small commit. Expect a second or two.

## Development

```sh
npm ci
npm run check   # typecheck, build dist/ and run the tests
```

`dist/` is committed because GitHub Actions runs it directly: rebuild it before committing changes to `src/`.

## License

[MIT](LICENSE)
