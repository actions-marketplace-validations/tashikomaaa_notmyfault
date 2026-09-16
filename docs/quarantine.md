# Quarantine flaky tests

<p align="center">
  <img alt="The croissant mascot in sunglasses, above the words &quot;Works on main (sometimes)&quot;." src="assets/sticker-works-on-main.png" width="220">
</p>

A flaky test that fails on an unrelated pull request blocks the merge, costs a re-run and teaches everyone to ignore red builds. In `quarantine` mode, notmyfault decides whether the job fails: known flaky tests no longer block, real failures still do.

## Setup

```yaml
      - name: Test
        run: npm test
        continue-on-error: true

      - uses: tashikomaaa/notmyfault@v1
        with:
          junit: reports/**/*.xml
          mode: quarantine
```

- `continue-on-error: true` lets the job continue when tests fail, so notmyfault gets to decide.
- `mode: quarantine` makes the notmyfault step fail when at least one failure is **not tolerated**.
- By default only the `flaky` verdict is tolerated, which covers both *known flaky* and *probably flaky* tests.

If branch protection requires this job's check, the requirement now means "no failure that looks real".

## Choosing what to tolerate

`tolerate` takes a comma-separated list of verdicts:

| `tolerate` | Effect |
|---|---|
| `flaky` (default)<br><img alt="" src="assets/verdict-flaky.png" width="28"> | Known and probably flaky tests do not block. Recommended. |
| `flaky, broken`<br><img alt="" src="assets/verdict-flaky.png" width="28"><img alt="" src="assets/verdict-broken.png" width="28"> | Tests already failing on the tracked branch do not block either. Useful when a broken `main` should not freeze every pull request, at the risk of merging more changes on top of a broken test. |
| `flaky, broken, suspect`<br><img alt="" src="assets/verdict-flaky.png" width="28"><img alt="" src="assets/verdict-broken.png" width="28"><img alt="" src="assets/verdict-suspect.png" width="28"> | Tests that failed in isolation once or twice do not block. Not recommended: a suspect failure is as likely to be real as not. |

Tolerating `new` defeats the purpose and is never a good idea.

## Quarantine tests by hand

Sometimes you know a test is unreliable before notmyfault can prove it: a new test, a repository that just adopted notmyfault, a third-party sandbox having an outage. List it in [`quarantine`](configuration.md#quarantine), with the last day it should be tolerated:

```yaml
      - uses: tashikomaaa/notmyfault@v1
        with:
          junit: reports/**/*.xml
          mode: quarantine
          quarantine: |
            2026-10-01 e2e › checkout › pays with PayPal # PayPal sandbox outage
```

Until that day, its failures keep their verdict, are marked *quarantined by hand until 2026-10-01: PayPal sandbox outage* in the report, and never block. After that day, notmyfault warns on every run so that the entry does not outlive its reason: remove it, or push the date back.

Unlike skipping the test, it keeps running, so the history keeps learning, and it comes back on its own.

## Safety nets

Quarantine mode is built to fail closed:

- **No report found, or reports without any test case:** the step fails. If the build breaks before the tests run, `continue-on-error` cannot hide it.
- **History unavailable:** every failure is classified as new, so every failure blocks.
- **Expired proof:** proof of flakiness from retries and re-runs only counts for 30 days. A fixed test stops being tolerated once its proof expires and the runs remembered on the tracked branch no longer look flaky.

One blind spot remains: two test cases with the **same name in the same suite** are read as attempts of one test. If the first fails and the second passes, notmyfault sees a test that passed after a retry and does not block. Keep test names unique, see [Test runners](test-runners.md#tips-for-stable-test-names).

## What quarantine does not do

- **It does not fix tests.** Flaky tests stay listed in the pull request comment and in the ranking of the job summary. To make sure they get fixed, set [`flaky-issues: true`](configuration.md#flaky-issues): each one gets an issue, closed once it stops failing.
- **It does not hide failures.** The test step still shows as failed in the logs, and the comment explains every failure.
- **It does not skip or retry tests.** Your test runner still runs everything. Retries configured in the runner keep working and give notmyfault more proof, see [Test runners](test-runners.md#detecting-retries).

## Using the outputs instead

If you would rather write your own rule, keep `continue-on-error: true` on the test step, leave `mode` to `report` and decide with the step outputs:

```yaml
      - uses: tashikomaaa/notmyfault@v1
        id: notmyfault
        if: ${{ !cancelled() }}
        with:
          junit: reports/**/*.xml

      - name: Fail on failures related to the change
        if: ${{ !cancelled() && steps.notmyfault.outputs.new-failures != '0' }}
        run: exit 1
```

All outputs are listed in [Configuration](configuration.md#outputs).
