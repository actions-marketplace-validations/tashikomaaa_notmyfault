# Reading the report

notmyfault reports in two places: a comment on the pull request and the job summary. Both have the same structure. It also [annotates failed tests](#annotations) next to their code.

## The headline

| Headline | Meaning |
|---|---|
| <img alt="" src="assets/verdict-passed.png" width="24" align="absmiddle"> All *N* tests passed | Nothing failed. When some tests needed a retry, the headline says how many. |
| <img alt="" src="assets/verdict-passed.png" width="24" align="absmiddle"> *N* tests failed, none of them look like your fault | Every failure is known flaky or already failing on the tracked branch. |
| <img alt="" src="assets/verdict-new.png" width="24" align="absmiddle"> *N* tests failed, *M* look related to this change | *M* failures are new or suspect. |

With [`suites`](configuration.md#suites), the headline counts the tests of every suite, and each suite then gets its own section.

## The verdicts

Each failed test gets one verdict, shown by its badge. Where images do not load, an emoji stands in: 🔴 new failure, 🟠 suspect, ⚫ already failing, 🟡 flaky. The verdicts are listed from the most actionable one.

### New failure

<img align="right" alt="New failure" src="assets/verdict-new.png" width="104">

> **New failure.** Passed the last 48 runs on `main`.

Nothing in the history explains this failure. Either the test passes consistently on the tracked branch, or notmyfault has no history for it yet, in which case the comment says *No history for this test on `main`*.

A test the history would excuse is a new failure too when it fails with an error never seen on the tracked branch:

> **New failure.** Known flaky on `main`, but this error was never seen there.

Flakiness or a breakage on the tracked branch only explains the errors it produced. A known flaky test failing with a timeout is flaky; the same test failing with `expected 3758 to be 3422` may well be broken by your change.

**What to do:** assume your change caused it and reproduce it locally.

### Suspect

<img align="right" alt="Suspect" src="assets/verdict-suspect.png" width="104">

> **Suspect.** Failed in isolation once in the last 50 runs on `main`.

The test failed once or twice on the tracked branch, each time between two successful runs. That is what flakiness looks like, but it is also what a commit breaking the test followed by a commit fixing it looks like, so notmyfault does not excuse it yet.

**What to do:** read the failure message. If it looks unrelated to your change, use **Re-run failed jobs**. If the test then passes on the same commit, it becomes **known flaky**.

### Already failing

<img align="right" alt="Already failing" src="assets/verdict-broken.png" width="104">

> **Already failing on `main`.** Failed the last 3 runs there.

The most recent runs on the tracked branch failed too, so the problem predates your pull request.

**What to do:** nothing in your pull request. Once the tracked branch is fixed, update your branch.

### Known flaky / Probably flaky

<img align="right" alt="Flaky" src="assets/verdict-flaky.png" width="104">

> **Known flaky.** Failed 4 of the last 50 runs on `main`; passed when the same commit was re-run on 2026-09-14.

The test is unreliable. The wording tells how sure notmyfault is:

- **Known flaky**: there is proof. Either, within the last 30 days, the test passed after a retry in the same run or passed when a commit it had failed on was run again, on any branch. Or one of the runs remembered on the tracked branch passed only after a retry.
- **Probably flaky**: no proof, but the test failed in isolation at least three times on the tracked branch.

**What to do:** re-run the job if the failure blocks you, and fix the test. To keep flaky tests from blocking merges, see [Quarantine flaky tests](quarantine.md).

## When several rules apply

The verdict is the first rule that matches:

1. There is proof of flakiness, but the test failed **too many runs in a row** on the tracked branch to be bad luck: **already failing**. How many depends on how often it failed before, from 3 to 10, see [How it works](how-it-works.md#classification).
2. There is proof of flakiness: **known flaky**.
3. The last run on the tracked branch failed: **already failing**.
4. The test failed in isolation **3 or more** times: **probably flaky**.
5. The test failed in isolation once or twice: **suspect**.
6. Otherwise: **new failure**.

When rules 1 to 5 match but the test fails with an error never seen on the tracked branch, the verdict is **new failure** instead. [How it works](how-it-works.md#errors) explains how errors are compared.

"In isolation" means one failed run with successful runs on both sides. [How it works](how-it-works.md#classification) explains where each number comes from.

## Failure messages

The comment includes the first line of the failure message of up to 10 failed tests, truncated to 300 characters. The full output stays in your test logs.

## Tests quarantined by hand

A failure of a test listed in [`quarantine`](configuration.md#quarantine) keeps its verdict, followed by *Quarantined by hand until 2026-10-01: PayPal sandbox outage*. It never blocks in quarantine mode, and the quarantine line of the report counts it.

## Tests that passed only after a retry

A test that failed and then passed within the same run did not fail the build, but it is still worth knowing about. Such tests are listed at the bottom of the comment, and each occurrence is recorded as proof of flakiness.

## Tests fixed by the change

A test that passes while it is failing on the tracked branch is listed as **fixed**, with the number of runs it had been failing there:

> 🛠️ **Fixed:** 1 test failing on `main` passes in this run.
>
> - `search › finds products regardless of accents`, failed the last 8 runs there

The rule is the one of *already failing*: 1 or more failed runs in a row on the tracked branch for a test without proof of flakiness, or a streak too long to be bad luck for a flaky one. A known flaky test passing after a few failures is not a fix, just flakiness.

A fix is worth knowing about, so notmyfault comments on a pull request that fixes a test even when nothing failed.

## Slower tests

A test that passes, but takes much longer than usual, is listed as **slower**:

> 🐢 **Slower:** 1 passing test took much longer than usual on `main`.
>
> - `api › search`: 2.4 s, usually 800 ms

"Much longer" means at least twice its median duration over its last runs on the tracked branch, and at least 500 ms more, with at least 5 runs to compare with. Durations come from the `time` attribute of the report. Tests that fail are not listed: their failure explains more than their duration.

A test getting slower is often a test about to time out, or a change that made the code slower. It does not make notmyfault comment on its own, and it never fails the step: the `slower` output counts them if you want to act on it.

## Annotations

When the report tells where a failed test lives, notmyfault annotates it with its verdict and the first line of its failure message. Annotations appear in the workflow run and, on pull requests, next to the code in the **Files changed** tab when the annotated file is part of the change.

| Verdict | Annotation |
|---|---|
| New failure, suspect | error |
| Already failing, known or probably flaky | notice |

GitHub shows up to 10 annotations of each kind per step, and the most actionable verdicts come first.

When every failed test is known or probably flaky, a notice titled `notmyfault: only flaky tests failed` comes first, even with `annotations: false`: a workflow can read it to [re-run the failed jobs automatically](recipes.md#re-run-flaky-failures-automatically).

notmyfault only annotates files that exist in the repository. To find them, it looks, in order, at:

1. the `file` and `line` attributes of the test case, or the `file` attribute of its suite;
2. class and suite names that are paths, like the ones Vitest writes, or module and class names: `tests.test_api` for `tests/test_api.py`, `com.acme.OrderTest` for `src/test/java/com/acme/OrderTest.java`;
3. `file:line` references in the failure output, which give the line of the file found above, or the first file of the repository they mention.

[Test runners](test-runners.md#annotations) details what each runner provides. Set [`annotations: false`](configuration.md#annotations) to turn them off.

## Live examples

The [demo repository](https://github.com/tashikomaaa/notmyfault-demo) runs notmyfault in quarantine mode, tolerating `flaky` and `broken`, on open pull requests. Its flaky payment test also has a [tracking issue](https://github.com/tashikomaaa/notmyfault-demo/issues/5), opened by `flaky-issues`.

| Pull request | What the comment shows |
|---|---|
| [#1 Support fixed-amount discount codes](https://github.com/tashikomaaa/notmyfault-demo/pull/1) | <img alt="" src="assets/verdict-new.png" width="24" align="absmiddle"> A new failure caused by the change, next to a test already failing on `main` and a known flaky test. Quarantine blocks the merge. |
| [#2 Charge the reduced VAT rate on coffee beans, again](https://github.com/tashikomaaa/notmyfault-demo/pull/2) | <img alt="" src="assets/verdict-suspect.png" width="24" align="absmiddle"> A suspect failure: the test failed once on `main`, when the same change landed and was reverted. Quarantine blocks the merge. |
| [#3 Explain how to run the tests](https://github.com/tashikomaaa/notmyfault-demo/pull/3) | <img alt="" src="assets/verdict-passed.png" width="24" align="absmiddle"> Failures, none of them related to a README change. Quarantine lets the check pass. |
| [#4 Find products regardless of accents again](https://github.com/tashikomaaa/notmyfault-demo/pull/4) | <img alt="" src="assets/verdict-passed.png" width="24" align="absmiddle"> A fix for the test broken on `main`, listed as fixed. The flaky test failed, then passed on a re-run: all tests passed. |
| [#6 Load search synonyms on every query](https://github.com/tashikomaaa/notmyfault-demo/pull/6) | <img alt="" src="assets/verdict-passed.png" width="24" align="absmiddle"> Tests still pass, but one is listed as slower: 1.2 s, usually 1 ms. |
| [#7 Round discounts down to the ten cents](https://github.com/tashikomaaa/notmyfault-demo/pull/7) | <img alt="" src="assets/verdict-new.png" width="24" align="absmiddle"> A new failure, quarantined by hand until 2026-10-15 in the workflow of the pull request: the check passes. |

## The job summary

The job summary contains the same report, plus two rankings of the tests of the tracked branch.

The **slowest tests**, up to 10, by median duration over their last 10 runs, with their fastest and slowest runs. A wide range often means a test depends on timing.

The **most unreliable tests**, up to 10, known flaky tests first, then by share of failed runs. For the first 3 of them with at least 15 remembered runs, a chart shows how their failure rate evolved: each point is the share of failed runs among the 10 runs ending there, so you can see whether a test is getting worse, or whether a fix worked.

| Column | Meaning |
|---|---|
| Failed runs | Failed runs out of the runs remembered for this test |
| Passed on retry | Runs that passed only after a retry |
| Proven flaky | `yes` for known flaky tests, `probably` otherwise |

GitHub draws the charts from Mermaid blocks. Where Mermaid is not rendered, the summary shows their source, which still lists the rates.
