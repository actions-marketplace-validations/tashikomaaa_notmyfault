# Recipes

## Several test suites in one job

List them in [`suites`](configuration.md#suites). Each suite keeps its own history, and the pull request gets one comment with a section per suite:

```yaml
      - run: npm run test:unit    # writes reports/unit/*.xml
        continue-on-error: true
      - run: npm run test:e2e     # writes reports/e2e/*.xml
        continue-on-error: true

      - uses: tashikomaaa/notmyfault@v1
        if: ${{ !cancelled() }}
        with:
          suites: |
            unit: reports/unit/*.xml
            e2e: reports/e2e/*.xml
          mode: quarantine
```

To get a comment per suite instead, use one step per suite, each with its own `junit` and `key`.

## Monorepos

For a single comment covering every package, match all the reports in one step:

```yaml
      - uses: tashikomaaa/notmyfault@v1
        if: ${{ !cancelled() }}
        with:
          junit: packages/*/reports/*.xml
```

If each package is tested in its own job, the default key (`<workflow>-<job>`) already keeps them apart.

## Sharded tests

When a matrix splits one test suite across several jobs, each job only sees part of the tests. Run notmyfault once, in a job that collects every shard's reports, so that pull requests get one comment covering all of them:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v7
      - run: npx vitest run --shard=${{ matrix.shard }}/4 --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml
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

The reporting job does not need a checkout: notmyfault reads the history from the repository on its own.

## The same tests in several environments

When a matrix runs the **same** tests on different operating systems or runtime versions, give each environment its own history. A test that only fails on Windows then builds its own history instead of looking flaky on Linux.

For a single comment, upload each environment's reports and report them together with [`suites`](configuration.md#suites), one suite per environment:

```yaml
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      # ...
      - uses: actions/upload-artifact@v7
        if: ${{ !cancelled() }}
        with:
          name: junit-${{ matrix.os }}
          path: reports/

  notmyfault:
    needs: test
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v8
        with:
          path: reports/   # one directory per artifact: reports/junit-ubuntu-latest/, …
      - uses: tashikomaaa/notmyfault@v1
        with:
          suites: |
            test-ubuntu-latest: reports/junit-ubuntu-latest/**/*.xml
            test-windows-latest: reports/junit-windows-latest/**/*.xml
            test-macos-latest: reports/junit-macos-latest/**/*.xml
```

For a comment per environment instead, run notmyfault in each matrix job with `key: test-${{ matrix.os }}`. Both setups use the same keys, so switching from one to the other keeps the history.

## Build the history faster with scheduled runs

History only grows when tests run on a tracked branch. Scheduled runs happen on the default branch, so they count. Running the suite a few times a day surfaces flaky tests much sooner, especially in quiet repositories:

```yaml
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "17 */6 * * *"   # every 6 hours
```

## Maintenance branches

To compare pull requests against the branch they target, track each long-lived branch under its own key:

```yaml
      - uses: tashikomaaa/notmyfault@v1
        if: ${{ !cancelled() }}
        with:
          junit: reports/**/*.xml
          track-branches: main, release/2.x
          key: test-${{ github.base_ref || github.ref_name }}
```

`github.base_ref` is the target branch of a pull request, and `github.ref_name` the branch of a push. Without a key per branch, `main` and `release/2.x` would share one history.

## Merge queues

Runs triggered by `merge_group` are compared with the history like pull requests. They record failures and proof of flakiness, but have no pull request to comment on: the report is in the job summary. Add the event to your workflow as usual:

```yaml
on:
  pull_request:
  merge_group:
```

## Summary only, no comments

```yaml
      - uses: tashikomaaa/notmyfault@v1
        if: ${{ !cancelled() }}
        with:
          junit: reports/**/*.xml
          comment: false
```

The job then only needs `contents: write`.

## Act on the results

The outputs make it possible to react to flaky tests, for example by labeling the pull request:

```yaml
      - uses: tashikomaaa/notmyfault@v1
        id: notmyfault
        if: ${{ !cancelled() }}
        with:
          junit: reports/**/*.xml

      - name: Label pull requests hit by flaky tests
        if: ${{ !cancelled() && github.event_name == 'pull_request' && steps.notmyfault.outputs.flaky-failures > 0 }}
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh pr edit ${{ github.event.pull_request.number }} --repo ${{ github.repository }} --add-label flaky-tests
```

The label must already exist in the repository, and the job needs `pull-requests: write`.

## Reset the history

Delete the branch. It is recreated on the next run:

```sh
git push origin --delete notmyfault-history
```

To reset a single key, remove its file with a regular commit on top of the history branch. notmyfault builds on whatever the branch contains:

```sh
git fetch origin notmyfault-history
git worktree add --detach ../notmyfault-history FETCH_HEAD
git -C ../notmyfault-history rm history/ci-e2e.json
git -C ../notmyfault-history commit -m "Reset the e2e history"
git -C ../notmyfault-history push origin HEAD:notmyfault-history
git worktree remove ../notmyfault-history
```

## Pin to a commit

For the strictest supply chain policies, pin the action to a full commit SHA and keep the version as a comment:

```yaml
      - uses: tashikomaaa/notmyfault@<full commit sha> # v1.0.0
```

Find the SHA of each release on the [releases page](https://github.com/tashikomaaa/notmyfault/releases).
