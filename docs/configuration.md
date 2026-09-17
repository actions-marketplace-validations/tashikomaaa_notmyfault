# Configuration

```yaml
- uses: tashikomaaa/notmyfault@v1
  with:
    junit: reports/**/*.xml
```

`junit` is the only required input, unless you list several suites with `suites`.

## Inputs

| Input | Default | Description |
|---|---|---|
| [`junit`](#junit) | required, unless `suites` | Glob(s) matching the JUnit XML reports |
| [`suites`](#suites) | none | Several suites, each with its own history, in one comment |
| [`mode`](#mode) | `report` | `report` or `quarantine` |
| [`tolerate`](#tolerate) | `flaky` | Verdicts that do not fail the step in quarantine mode |
| [`quarantine`](#quarantine) | none | Tests quarantined by hand, until a date |
| [`token`](#token) | `${{ github.token }}` | Token used to store the history and comment |
| [`history-branch`](#history-branch) | `notmyfault-history` | Branch holding the history |
| [`track-branches`](#track-branches) | the default branch | Branches whose runs build the history |
| [`key`](#key) | `<workflow>-<job>` | Name of the test suite in the history |
| [`comment`](#comment) | `true` | Comment on pull requests |
| [`annotations`](#annotations) | `true` | Annotate failed tests next to their code |
| [`flaky-issues`](#flaky-issues) | `false` | Open an issue for each flaky test |
| [`record`](#record) | `true` | Record the run in the history |
| [`window`](#window) | `50` | Runs remembered per test |

### `junit`

One or more glob patterns, separated by newlines or commas, relative to the workspace. Absolute paths work too. Directories named `node_modules` or `.git` are never searched.

```yaml
junit: |
  packages/*/reports/*.xml
  e2e/results/junit.xml
```

When the same test appears in several matched files, the worst outcome wins: failed, then passed after a retry, then passed, then skipped.

### `suites`

Several test suites reported in a single step and a single pull request comment, each with its own history. One suite per line: its name, a colon, then its glob patterns separated by commas.

```yaml
suites: |
  unit: reports/unit/*.xml
  e2e: reports/e2e/*.xml, reports/smoke/*.xml
```

- Each name is used as a [`key`](#key): the suite keeps the history file of that key. Use it **instead of** `junit` and `key`, setting them together is an error.
- The comment and the job summary start with a headline counting every suite, then have a section per suite.
- Outputs count the tests of every suite. In quarantine mode, the step fails when any suite has a failure that is not tolerated.
- Every suite needs at least one matching report with test cases, like `junit`.
- The comment is identified by the names of the suites, joined with `+`. Adding, removing or renaming a suite starts a new comment.

See [Recipes](recipes.md#several-test-suites-in-one-job) for suites in one job, and for the same tests run in several environments.

### `mode`

- `report` never fails the step because of test results. Your test step decides whether the job fails.
- `quarantine` fails the step when a failure is not covered by `tolerate`. Combine it with `continue-on-error: true` on the test step. See [Quarantine flaky tests](quarantine.md).

### `tolerate`

Comma-separated verdicts that do not fail the step in quarantine mode: any of `new`, `suspect`, `broken` and `flaky`. Ignored in report mode. The verdicts are described in [Reading the report](verdicts.md).

| <img alt="" src="assets/verdict-new.png" width="64"> | <img alt="" src="assets/verdict-suspect.png" width="64"> | <img alt="" src="assets/verdict-broken.png" width="64"> | <img alt="" src="assets/verdict-flaky.png" width="64"> |
|:---:|:---:|:---:|:---:|
| `new` | `suspect` | `broken` | `flaky` |
| New failure | Suspect | Already failing | Known or probably flaky |

### `quarantine`

Tests whose failures never block, until a date. One test per line: the last day the quarantine applies, the test, then optionally `#` and a reason.

```yaml
quarantine: |
  2026-10-01 e2e › checkout › pays with PayPal # PayPal sandbox outage
  2026-09-30 cart › *discount*
```

- The test is matched by the title shown in the report or by its full identity, or by their end after a `›`: `checkout > pays` matches `test/cart.test.ts › checkout > pays`. `*` matches anything.
- Until the end of that day, in UTC, a failure of the test keeps its verdict but is marked *quarantined by hand* in the report, never blocks in quarantine mode, and is annotated as a notice.
- After that day, the entry no longer applies and each run warns about it.

Use it when you know a test is unreliable before the history can prove it. See [Quarantine tests by hand](quarantine.md#quarantine-tests-by-hand).

### `token`

Used to push the history branch and to comment on pull requests. The default token is enough when the job has the right permissions, see [Permissions and security](security.md). The token is masked in logs and never passed on a command line.

### `history-branch`

The branch that stores the history. It is created on the first recorded run and always holds a single commit. Change it if the default name clashes with an existing branch.

### `track-branches`

Comma-separated branch names. Runs on these branches build the reference history that failures are compared with. Defaults to the repository's default branch.

A run is tracked when it is not a `pull_request` or `pull_request_target` event and runs on one of these branches. Runs on other branches, pull requests and merge queues are compared with the history, but they only record their failures and any proof of flakiness.

### `key`

Identifies the test suite in the history. Each key has its own file on the history branch and its own pull request comment. Defaults to `<workflow name>-<job id>`, lowercased with every character outside `a-z`, `0-9`, `.`, `_` and `-` replaced by `-`: a workflow named `CI` with a job `test` gives `ci-test`.

Set it when one job runs several suites, or when matrix jobs run the same tests in different environments. To report several suites in one comment, use [`suites`](#suites) instead. See [Recipes](recipes.md).

### `comment`

When `true`, notmyfault comments on pull requests. A comment is created only when a test failed, needed a retry or was fixed. Once it exists, it is updated on every run, including when everything passes again. Set `comment: false` to rely on the job summary only.

### `annotations`

When `true`, each failed test the report lets notmyfault find in the repository gets an annotation with its verdict: an error for new and suspect failures, a notice for flaky and already failing tests. Annotations appear in the workflow run and, on pull requests, next to the code in the Files changed tab. See [Annotations](verdicts.md#annotations). Set `annotations: false` if your test runner already annotates failures and you prefer fewer of them.

### `flaky-issues`

When `true`, runs on tracked branches keep an issue open for each flaky test, labeled `flaky-test`, so that flaky tests get fixed instead of only tolerated. It needs the `issues: write` permission:

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: write
```

- A test **proven flaky** that failed on a tracked branch in the last 30 days gets an issue, with its verdict, its runs and its proof of flakiness. At most 5 issues are opened per run, the others on the next runs.
- When the test fails again on a tracked branch, or passes only after a retry, the issue is updated with the latest failure message and a link to the run. A closed issue is reopened.
- After 30 days without a failure on a tracked branch, or when the test leaves the history, the issue is closed with a comment.

Pull request runs never touch issues. Assign, discuss and label the issues as you like: notmyfault only rewrites their description. See [How it works](how-it-works.md#flaky-test-issues).

### `record`

When `true`, the run is recorded in the history. Pull requests from forks are never recorded, because their token is read-only. Set `record: false` for jobs that should read the history without influencing it, for example experimental runs.

### `window`

How many recent runs on tracked branches are remembered for each test. Minimum 5. A larger window detects rare flakiness better but takes longer to forget a test that was fixed.

## Outputs

| Output | Description |
|---|---|
| `total` | Tests found in the reports, including skipped ones |
| `failed` | Failed tests |
| `new-failures` | Failures classified as new or suspect |
| `flaky-failures` | Failures of known or probably flaky tests |
| `broken-failures` | Failures of tests already failing on a tracked branch |
| `retried` | Tests that passed only after a retry |
| `fixed` | Tests failing on a tracked branch that pass in this run |
| `quarantined` | Failures of tests quarantined by hand |
| `slower` | Passing tests that took much longer than usual on a tracked branch |
| `blocking` | Failures not covered by `tolerate` |

Outputs are numbers written as strings. Give the step an `id` to use them:

```yaml
      - uses: tashikomaaa/notmyfault@v1
        id: notmyfault
        if: ${{ !cancelled() }}
        with:
          junit: reports/**/*.xml

      - if: ${{ !cancelled() && steps.notmyfault.outputs.flaky-failures > 0 }}
        run: echo "::notice::${{ steps.notmyfault.outputs.flaky-failures }} flaky test(s) failed in this run"
```

Outputs are not set when the step fails before analyzing the reports.

## When the step fails

The notmyfault step fails when:

- an input is invalid;
- no file matches `junit`, or the matched files contain no test case;
- in quarantine mode, at least one failure is not tolerated.

It never fails because of its own infrastructure. If the history cannot be read or written, or the comment cannot be posted, notmyfault logs a warning and carries on. Without history, every failure is reported as new. [Troubleshooting](troubleshooting.md) lists every message.

## Environment

notmyfault runs on the `node24` runtime and needs `git` on the runner. It uses the default variables set by GitHub Actions, notably `GITHUB_SERVER_URL`, `GITHUB_API_URL`, `GITHUB_SHA` and `RUNNER_TEMP`, and needs no other configuration.

On GitLab CI/CD, every input is a `NOTMYFAULT_*` variable and the outputs are dotenv variables, see [GitLab CI/CD](gitlab.md#variables).
