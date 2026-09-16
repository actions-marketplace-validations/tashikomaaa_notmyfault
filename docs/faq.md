# FAQ

### Does notmyfault replace retries in my test runner?

No, it complements them. Retries hide flaky failures from the build status; notmyfault makes them visible, remembers them, and tells failures that are real from failures that are not. Retries reported in JUnit XML even help notmyfault prove that a test is flaky.

### Why store the history in a branch?

Because it is the only storage every repository already has that is durable, versioned and readable by anyone with access to the repository:

- the Actions cache is evicted after a week without use and is scoped per branch;
- artifacts expire and must be downloaded run by run through the API;
- an external service means an account, a bill and your data somewhere else.

The branch holds a single commit rewritten on each update, so it does not grow.

### Will the history branch get in my way?

It is one more branch, with its own `README.md` explaining what it is. It is never merged anywhere and contains no code. Pushes to it by the `GITHUB_TOKEN` do not trigger workflows.

### How long before verdicts are useful?

Failures on the tracked branch are recognized immediately. Proof of flakiness comes from retries and re-runs, whenever they happen. Detecting flakiness from the history alone takes at least three isolated failures. [Scheduled runs](recipes.md#build-the-history-faster-with-scheduled-runs) speed this up.

### Does it work with private repositories?

Yes. The history branch is as private as the repository.

### Does it work with GitHub Enterprise Server, self-hosted runners, macOS or Windows?

notmyfault only needs `git`, the `node24` Actions runtime and the default GitHub Actions variables. It is tested on Linux runners with github.com. Other setups should work but are not covered by the test suite yet: feedback is welcome.

### Does it work with GitLab CI, Jenkins or CircleCI?

No. notmyfault is a GitHub Action.

### Can several workflows share one history?

Yes: use the same `key` in each of them. By default the key includes the workflow and job names, so each job has its own history.

### How do I look at the raw data?

```sh
git fetch origin notmyfault-history
git show FETCH_HEAD:history/ci-test.json
```

The format is described in [How it works](how-it-works.md#what-a-history-file-contains).

### How do I start over?

Delete the `notmyfault-history` branch. See [Reset the history](recipes.md#reset-the-history).

### Why does it say "new failure" when the test is obviously flaky?

notmyfault only excuses a test with evidence: a retry, a successful re-run of the same commit, or three isolated failures on the tracked branch. Use **Re-run failed jobs**: if the test passes, the proof is recorded and the next failure is recognized.

### Does it slow down CI?

It parses the reports, fetches and pushes one small commit and calls the API once or twice. That usually takes a couple of seconds.

### Is it free?

Yes. notmyfault is MIT licensed, runs in your own workflows and calls no paid service.

### Why the name?

Because that is what you want to know when a pull request turns red.
