# Troubleshooting

<p align="center">
  <img alt="The croissant mascot asleep on a pile of failed test reports." src="assets/sticker-asleep.png" width="220">
</p>

Messages are listed as they appear in the logs. **Errors** fail the step, **warnings** do not.

On GitLab, messages name variables instead of inputs, `Variable NOTMYFAULT_MODE` instead of `Input "mode"`, and say merge request instead of pull request. The messages only GitLab shows are in [GitLab CI/CD](gitlab.md#troubleshooting).

## No comment on my pull request

Check, in order:

1. **Did anything fail?** notmyfault only creates a comment when a test failed, passed after a retry, or passed while failing on the tracked branch. The job summary always has the report.
2. **Is the step running?** Without `if: ${{ !cancelled() }}`, the step is skipped when the test step fails.
3. **Is the event `pull_request`?** Runs triggered by `push`, `merge_group` or `schedule` have no pull request to comment on.
4. **Is there a warning** starting with `Could not comment on the pull request`? See below.

## Errors

### `No JUnit report matched "…" in …`

No file matched the `junit` patterns, or the patterns of one of the `suites`, which the message then names. Patterns are relative to the workspace, and `node_modules` and `.git` directories are skipped.

- Check the path your test runner writes to, for example with `- run: find . -name "*.xml" -not -path "*/node_modules/*"` before the notmyfault step.
- If the tests did not run at all (build error, dependency install failure), this error is expected: fix the earlier step.
- In a separate reporting job, make sure the artifacts were downloaded where the pattern looks.

### `The N matched report(s) contain no test cases.`

The files exist, but none of them contains a `<testcase>` element. The pattern may match unrelated XML files, or the test runner may have crashed before writing results. Narrow the pattern and open the file to check its content.

### `Input "quarantine" expects "YYYY-MM-DD test name # reason" per line, got "…"`

A line of [`quarantine`](configuration.md#quarantine) does not start with a valid date followed by a test name. Dates are written `2026-10-01`.

### `N failing test(s) are not tolerated in quarantine mode: …`

Quarantine mode worked as intended: these failures are not covered by `tolerate`. The pull request comment and the job summary explain each verdict. See [Reading the report](verdicts.md).

### `Input "mode" must be "report" or "quarantine", got "…"`

### `Input "tolerate" accepts new, suspect, broken, flaky; got "…"`

### `Input "…" must be a boolean, got "…"` or `must be an integer >= 5, got "…"`

An input has an invalid value. Boolean inputs accept `true`, `false`, `yes`, `no`, `on`, `off`, `1` and `0`. See [Configuration](configuration.md).

### `Input "junit" is required: a glob matching your JUnit XML reports. Or list several suites in "suites".`

Add the `junit` input, or [`suites`](configuration.md#suites).

### `Inputs "junit" and "key" cannot be used with "suites": …`

`suites` replaces `junit` and `key`: name each suite and its reports in it, and remove the other two inputs.

### `Input "suites" expects one "name: glob" per line, got "…"` or `names the suite "…" twice`

Each line of `suites` needs a name, a colon, then one or more glob patterns separated by commas, and each name can only appear once. Names are compared after being turned into keys, so `Unit` and `unit` are the same suite.

### `Input "token" is empty.`

The `token` input was set to an empty value, often a secret that does not exist in this context. Remove the input to use the default token.

### `GITHUB_REPOSITORY is not set. notmyfault must run inside GitHub Actions.`

The action was started outside GitHub Actions, or in an environment that does not set the default variables.

## Warnings

### `Could not read history from branch "notmyfault-history", continuing without it.`

notmyfault could not fetch the history branch, so every failure is reported as new. The end of the message contains the git error:

- `Repository not found` or `403`: the token cannot read the repository. Check `permissions` and the `token` input.
- `unable to access`: a network issue, or a self-hosted runner that cannot reach GitHub.
- `Unable to run git`: `git` is not installed on the runner.

A missing branch is not an error: on the very first run, notmyfault starts with an empty history silently.

### `Could not record history on branch "notmyfault-history". Does the job have "contents: write" permission?`

The run was analyzed but not recorded. The end of the message contains the git error:

- `403` or `Permission … denied`: add `contents: write` to the job permissions, see [Permissions and security](security.md). For jobs that should not write, set `record: false`.
- `protected branch`, `rule violations` or `GH013`: a ruleset protects the history branch. Exclude it, see [Branch protection and rulesets](security.md#branch-protection-and-rulesets).
- `stale info` or `concurrent writer`: many jobs wrote at the same moment and 6 attempts were not enough. The next run records normally. If it happens often, give jobs distinct keys.

### `Could not create the check "…". Does the job have "checks: write" permission?`

[`check`](configuration.md#check) is on, but the token cannot create checks. Add `checks: write` to the job permissions. If branch protection requires the check, pull requests wait until it reports.

### `Input "rerun-flaky" is ignored: only GitLab lets a job start its pipeline again.`

[`rerun-flaky`](configuration.md#rerun-flaky) only works on GitLab. On GitHub, remove it and add the [companion workflow](recipes.md#re-run-flaky-failures-automatically).

### `Could not update flaky test issues. Does the job have "issues: write" permission?`

[`flaky-issues`](configuration.md#flaky-issues) is on, but the token cannot write issues. Add `issues: write` to the job permissions, or turn `flaky-issues` off. Issues are never managed from pull requests, so this warning only appears on tracked branches.

### `Could not comment on the pull request. Does the job have "pull-requests: write" permission?`

Add `pull-requests: write` to the job permissions, or set `comment: false`.

### `Could not comment on the pull request. Tokens are read-only on pull requests from forks; the job summary has the full report.`

Expected for pull requests from forks. See [Pull requests from forks](security.md#pull-requests-from-forks).

### `The quarantine of "…" expired on …: remove it, or push the date back if the test is still unreliable.`

A [`quarantine`](configuration.md#quarantine) entry is past its date and no longer applies: failures of that test block again. Remove the line once the test is fixed, or set a later date.

### `Skipping <file>: …`

A matched file could not be read. The other reports are still used.

## Informational messages

| Message | Meaning |
|---|---|
| `Read N tests from M report(s).` | Reports were parsed. |
| `new`, `suspect`, `broken`, `flaky`, `retried`, `fixed`, `slower`, `missing`, `deleted` followed by a test name | The verdict of each failure, the tests that passed after a retry, the tests the run fixes, the slower tests and the [missing tests](verdicts.md#missing-tests), in a collapsible group. |
| `History updated on branch "…".` | The run was recorded. |
| `Nothing new to record.` | The run taught nothing new, so nothing was written. |
| `Pull request from a fork: the token is read-only, history is not recorded.` | Expected for pull requests from forks. |
| `Pull request comment created.` / `updated.` | The comment was posted. |

## Verdicts look wrong

- **Tests are reported missing, but they ran.** They ran in another job sharing the same `key`, or the latest run on the tracked branch ran more tests than pull requests do. Give each job its own key, or set [`missing-tests: false`](configuration.md#missing-tests).
- **Everything is a new failure.** The history is empty or unreadable. Check the warnings above, and that the workflow runs on `push` to a branch listed in `track-branches`.
- **A test is reported as flaky, but it fails for real.** It had proof of flakiness in the last 30 days, or failed in isolation 3 times. Once it fails too many runs in a row on the tracked branch to be bad luck, from 3 to 10 depending on how often it failed before, it becomes *already failing*. You can also [reset the history](recipes.md#reset-the-history).
- **A flaky test is reported as a new failure on every run.** Its error was never seen on the tracked branch. If its message contains values that change on every run other than numbers and hexadecimal ids, like random names, every failure looks new: please [open an issue](https://github.com/tashikomaaa/notmyfault/issues) with a few of its messages. See [Errors](how-it-works.md#errors).
- **Two different tests share one history.** They have the same identity. See [Test identity](how-it-works.md#test-identity).
- **A new test inherited the history of a deleted one.** The job summary of the run said so under *Renamed*: both were in the same file, the only test gone and the only test added, with similar names. [Reset the history](recipes.md#reset-the-history) if the verdicts of that test are wrong.
- **A renamed test lost its history.** The rename was not unambiguous: several tests changed in the same file at once, or the names differ too much. See [Renamed tests](how-it-works.md#renamed-and-moved-tests).
- **Tests of different environments mix.** Use a key per environment, see [Recipes](recipes.md#the-same-tests-in-several-environments).

Still stuck? [Open an issue](https://github.com/tashikomaaa/notmyfault/issues) with the notmyfault step logs and, if possible, the JUnit report.
