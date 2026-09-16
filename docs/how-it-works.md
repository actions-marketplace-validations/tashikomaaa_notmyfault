# How it works

This page describes exactly what notmyfault does, for those who want to trust it before relying on it. All numbers below are fixed in the code.

```
JUnit XML reports ──► parse ──► compare with the history ──► verdicts ──► comment, summary, outputs
                                        ▲                                      │
                                        └──── notmyfault-history branch ◄──────┘ record this run
```

## Reading reports

notmyfault expands the `junit` globs in the workspace, skipping `node_modules` and `.git`, and parses every matched file with a small built-in XML parser that tolerates the imperfect XML some reporters write. Each `<testcase>` gets an outcome:

| The `<testcase>` contains | Outcome |
|---|---|
| `<failure>` or `<error>` | failed |
| `<skipped>` | skipped (ignored from then on) |
| `<flakyFailure>` or `<flakyError>`, and no failure | passed after a retry |
| nothing of the above | passed |

When the same test appears more than once:

- **Inside one `<testsuite>`**, the occurrences are attempts of the same test, in order. A failure followed by a pass means the test passed after a retry. A pass followed by a failure means it failed.
- **In different suites or files**, the occurrences come from different environments, browsers or shards. The worst outcome wins: failed, then passed after a retry, then passed, then skipped.

A file without any test case is not an error in itself, but if no test case is found at all, the step fails.

## Test identity

A test is identified by its suite name, class name and test name, joined with ` › `. Empty parts and parts equal to the previous one are dropped, and whitespace is collapsed.

| Runner | `<testsuite name>` | `<testcase classname>` | `<testcase name>` | Identity |
|---|---|---|---|---|
| Vitest | `test/cart.test.ts` | `test/cart.test.ts` | `cart > empties` | `test/cart.test.ts › cart > empties` |
| pytest | `pytest` | `tests.test_api` | `test_delete_user` | `pytest › tests.test_api › test_delete_user` |
| Go | `github.com/acme/app/cache` | `github.com/acme/app/cache` | `TestExpire` | `github.com/acme/app/cache › TestExpire` |

Reports show a shorter title, the class name (or suite name) and the test name.

Because identity is based on names, renaming a test or moving it to another suite starts a new history, and tests with names that change on every run cannot be followed.

## The history

### Where it lives

The history is stored in your repository, on the branch named by `history-branch` (default `notmyfault-history`):

```
notmyfault-history
├── README.md            explains what the branch is
├── history/
│   ├── ci-test.json     one file per key
│   └── ci-e2e.json
└── badges/
    ├── ci-test.json     a badge counting the flaky tests of each key
    └── ci-e2e.json
```

Each badge file is a [shields.io endpoint](https://shields.io/badges/endpoint-badge), written in the same commit as its history: the number of known and probably flaky tests, see [Recipes](recipes.md#show-a-flaky-tests-badge).

The branch always holds **a single commit without parent**, authored by `github-actions[bot]`. Each update replaces it, so the branch never grows. Deleting the branch resets the history.

### What a history file contains

```json
{
 "version": 1,
 "updatedAt": "2026-09-16T10:04:12.000Z",
 "runs": 128,
 "tests": {
  "unit › checkout › pays": {
   "outcomes": "pppfpppppprpppfppp",
   "failedOn": ["3f2a1b9c0d4e", "a41c07e9b2f3"],
   "evidence": [{ "at": "2026-09-12T08:31:02.000Z", "sha": "a41c07e9b2f3", "kind": "rerun" }],
   "lastSeen": "2026-09-16",
   "errors": ["7c1e0a9b54d2"],
   "lastFailure": "2026-09-15",
   "durations": [812, 790, 845, 3120, 801]
  }
 }
}
```

| Field | Meaning |
|---|---|
| `runs` | Runs recorded on tracked branches |
| `outcomes` | One letter per run on a tracked branch, oldest first: `p` passed, `f` failed, `r` passed after a retry. Only the last `window` runs are kept (50 by default). |
| `failedOn` | The last 20 commits the test failed on, on any branch, as 12-character SHA prefixes |
| `evidence` | Up to 10 proofs of flakiness: `retry` (passed after a retry in the same run) or `rerun` (passed on a commit it had failed on) |
| `lastSeen` | Last day the test was recorded |
| `errors` | Fingerprints of the last 10 distinct failure messages seen on tracked branches, see [Errors](#errors) |
| `lastFailure` | Last day the test failed, or passed only after a retry, on a tracked branch |
| `durations` | Durations of the last 10 runs on tracked branches, in milliseconds, when reports give them |

The file contains test names, outcomes, short commit SHAs, dates, durations and fingerprints of failure messages. It contains no failure message, log or source code.

### What each run records

| | Run on a tracked branch | Any other run (pull request, other branch, merge queue) |
|---|---|---|
| Appends the outcome of every test to `outcomes` | yes | no |
| Adds the commit to `failedOn` for failed tests | yes | yes |
| Records `retry` evidence for tests that passed after a retry | yes | yes |
| Records `rerun` evidence for tests that pass on a commit listed in `failedOn` | yes | yes |
| Adds the fingerprint of each failure message to `errors` | yes | no |
| Sets `lastFailure` for tests that failed or passed after a retry | yes | no |
| Appends the duration of every test to `durations` | yes | no |
| Creates an entry for a test that only passed | yes | no |

Runs that teach nothing new do not write anything. Pull requests from forks never write, because their token is read-only.

The commit is `GITHUB_SHA`. For `pull_request` events, that is the merge commit GitHub creates for the run. Re-running the workflow run keeps the same commit, which is how re-runs prove flakiness. Pushing a new commit does not.

### Forgetting

- Tests not seen for **90 days** are removed from the history.
- Evidence older than **90 days** is removed, and evidence older than **30 days** is ignored when classifying.
- Outcomes beyond the last `window` runs are dropped.

## Classification

Only failed tests get a verdict. notmyfault first computes, from the history read at the start of the run:

- **trailing failures**: failed runs at the end of `outcomes`;
- **isolated failures**: `f` letters with a successful run on both sides;
- **proof**: evidence from the last 30 days, or an `r` in `outcomes`;
- **failure rate**: the share of `f` letters in `outcomes` before the trailing failures;
- **unlikely streak**: the shortest streak of failures, from 3 to 10, that a test with that failure rate has less than a 1% chance to produce by bad luck.

Then the first matching rule decides:

| # | Condition | Verdict |
|---|---|---|
| 1 | proof, and at least an unlikely streak of trailing failures | <img alt="" src="assets/verdict-broken.png" width="28"> already failing |
| 2 | proof | <img alt="" src="assets/verdict-flaky.png" width="28"> known flaky |
| 3 | 1 or more trailing failures | <img alt="" src="assets/verdict-broken.png" width="28"> already failing |
| 4 | 3 or more isolated failures | <img alt="" src="assets/verdict-flaky.png" width="28"> probably flaky |
| 5 | 1 or 2 isolated failures | <img alt="" src="assets/verdict-suspect.png" width="28"> suspect |
| 6 | anything else | <img alt="" src="assets/verdict-new.png" width="28"> new |

Why these numbers:

- **Rule 1 before rule 2.** A flaky test failing again and again is broken, and excusing it would hide a real problem. But flaky tests do fail several runs in a row now and then: a test failing 40% of the time has a 6% chance to fail any 3 runs in a row. The unlikely streak is 3 failures for a test failing up to 20% of the time, 4 at 30%, 6 at 40%, 7 at 50% and 10, the most, from 60%. The rate is measured before the streak, so the streak does not make itself look normal.
- **3 isolated failures for "probably flaky".** A commit that breaks a test followed by a commit that fixes it produces an isolated failure too. Requiring three keeps occasional breakages from excusing a test.
- **30 days of proof.** A fixed flaky test should stop being excused on its own.

The run being analyzed is recorded **after** classification, so a failure never explains itself.

### Errors

Rules 1 to 5 excuse a failure because of how the test behaved on the tracked branch, and that behavior only explains the errors seen there. When the test has errors recorded and fails with an error whose fingerprint is not among them, the verdict is **new failure**, and the comment says which verdict the history alone would have given.

The fingerprint of an error is the first 12 characters of the SHA-256 hash of the first line of its message, after:

- lowercasing it and collapsing whitespace;
- replacing every hexadecimal id of 7 characters or more, UUIDs included, and every number with `#`;
- keeping the first 200 characters.

`Bank did not answer within 100ms` and `bank did not answer within 2500ms` share a fingerprint, `expected 3758 to be 3422` does not.

Only runs on tracked branches record fingerprints: an error seen in pull requests only stays unknown, so a pull request never excuses its own error. Tests without any error recorded, and failures without a message, are classified by the rules alone. Some runners write the same message for every failure, like `Failed` for Go: errors of those tests cannot be told apart.

## Writing safely

notmyfault never touches your checkout. To read and write the history, it:

1. creates a scratch repository in `RUNNER_TEMP`, ignoring your global and system git configuration;
2. fetches only the tip of the history branch (`--depth=1`);
3. builds the new commit directly from git objects, without a working tree;
4. pushes with `--force-with-lease`, so the push fails if another job updated the branch in between;
5. on conflict, starts over from the latest version and applies the run again, up to 6 attempts with a random delay.

A push reported as "up to date" is treated as a conflict too: it means another job pushed an identical commit, and this run's update would otherwise be lost.

The token reaches git through environment variables, never on the command line, and is masked in the logs.

## Pull request comments

Each comment starts with a hidden marker, `<!-- notmyfault:<key> -->`. notmyfault looks for its marker among the pull request comments and updates that comment instead of adding a new one. It creates a comment only when a test failed, passed after a retry, or passed while it would have been classified already failing had it failed. One key means one comment. With [`suites`](configuration.md#suites), the marker holds the names of every suite joined with `+`, and one comment covers them all.

## Flaky test issues

With [`flaky-issues`](configuration.md#flaky-issues), each run on a tracked branch compares the history, including that run, with the issues labeled `flaky-test`. Each issue starts with a hidden marker, `<!-- notmyfault:flaky:<key>:<hash> -->`, the hash identifying the test. Then, for each test:

| The test | Its issue |
|---|---|
| Has proof of flakiness and failed in the last 30 days | Opened if missing, at most 5 per run |
| Failed or passed after a retry in this run | Updated with the latest failure, and reopened if it was closed and the test is still proven flaky |
| Has not failed for 30 days, or left the history | Closed with a comment |

The last failure is `lastFailure`, or the date of the latest proof of flakiness for histories recorded before `lastFailure` existed. A run only manages the issues of its own keys, so jobs with different keys do not close each other's issues.

## Limits

- **Only GitHub Actions** is supported.
- **Names are identities**: renamed tests start over, tests with dynamic names are not followed, and two test cases sharing a name inside one suite are read as attempts of the same test.
- **Retries** are only visible when the runner reports them, see [Test runners](test-runners.md#detecting-retries).
- **One comment per step.** Jobs sharing a key overwrite each other's comment. Collect their reports in one job instead, with [`suites`](configuration.md#suites) when they need separate histories, see [Recipes](recipes.md#sharded-tests).
- **Tested on Linux runners.** macOS and Windows runners have `git` and should work, but are not covered by the test suite yet.
- **GitHub Enterprise Server** should work through `GITHUB_SERVER_URL` and `GITHUB_API_URL`, provided the runner supports the `node24` runtime, but is untested.
