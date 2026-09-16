# Getting started

<p align="center">
  <img alt="The croissant mascot hugging a big green check mark." src="assets/sticker-passed.png" width="220">
</p>

This guide adds notmyfault to an existing workflow. It takes about five minutes.

## Requirements

- A GitHub Actions workflow that runs your tests.
- A test runner that writes **JUnit XML**. Almost all of them can, see [Test runners](test-runners.md).
- `git` on the runner. It is preinstalled on GitHub-hosted runners. notmyfault is tested on `ubuntu-latest`.

## 1. Make your tests write JUnit XML

With Vitest, for example:

```sh
npx vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml
```

Other runners are covered in [Test runners](test-runners.md). Check the file locally once: it should contain `<testcase>` elements.

## 2. Add notmyfault after the test step

```yaml
name: CI

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
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm ci
      - run: npx vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml

      - uses: tashikomaaa/notmyfault@v1
        if: ${{ !cancelled() }}
        with:
          junit: reports/**/*.xml
```

Three details matter:

- **`if: ${{ !cancelled() }}`** runs notmyfault when the test step failed, which is exactly when you need it.
- **The workflow must run on `push` to your default branch.** That is where the history is built. Pull request runs read it.
- **`permissions`** lets notmyfault store its history and comment. Organizations often default to a read-only token, so declare them explicitly. See [Permissions and security](security.md).

## 3. Merge it to your default branch

The first run on `main` creates a branch named `notmyfault-history` holding one file, `history/<workflow>-<job>.json`. The job summary shows the test results and a note saying there is no history yet.

You can look at the stored data at any time:

```sh
git fetch origin notmyfault-history
git show FETCH_HEAD:history/ci-test.json
```

## 4. Open a pull request

When a test fails, passes only after a retry, or passes while it is failing on `main`, notmyfault comments on the pull request. It updates the same comment on every push, including to say that everything passes again. When nothing ever fails, it stays silent. The job summary always contains the full report.

## What to expect in the first days

<img align="right" alt="The croissant mascot pressing a red &quot;Re-run&quot; button." src="assets/sticker-rerun.png" width="200">

notmyfault only knows what it has seen. At first, most failures are reported as **new failures**, because there is nothing to compare them with. Verdicts improve as runs accumulate on `main`:

- A test that fails on `main` makes pull requests see it as **already failing**.
- A test that fails, then passes when the **same commit is re-run**, is proven flaky. Prefer "Re-run failed jobs" over pushing an empty commit: it gives notmyfault that proof.
- A test that fails in isolation three times on `main` is reported as **probably flaky**.

To build history faster, run the suite on a schedule. See [Recipes](recipes.md#build-the-history-faster-with-scheduled-runs).

## Next steps

- [Reading the report](verdicts.md)
- [Quarantine flaky tests](quarantine.md) so they stop blocking merges
- [Recipes](recipes.md) for several suites, sharding and matrices
