# notmyfault documentation

<p align="center">
  <img alt="notmyfault: it's not your fault. The croissant mascot holds a verdict sheet reading &quot;Not your fault&quot;." src="assets/banner.jpg">
</p>

notmyfault is a GitHub Action that remembers how every test behaves on your default branch, then tells each pull request whether a failing test is **new**, **known to be flaky** or **already broken**.

<p align="center">
  <img alt="Three-panel comic. A developer panics in front of a red build. The croissant mascot rushes in with the test's history in a notebook. The croissant points out &quot;flaky&quot; and the developer relaxes with a coffee." src="assets/comic-strip.jpg">
</p>

## Start here

- [Live demo](https://github.com/tashikomaaa/notmyfault-demo/pulls): real pull requests showing every verdict, see [Live examples](verdicts.md#live-examples).
- [Getting started](getting-started.md): add notmyfault to a workflow in five minutes.
- [Reading the report](verdicts.md): what each verdict means and what to do about it.

<p align="center">
  <a href="verdicts.md#new-failure"><img alt="New failure" src="assets/verdict-new.png" width="88"></a>
  <a href="verdicts.md#suspect"><img alt="Suspect" src="assets/verdict-suspect.png" width="88"></a>
  <a href="verdicts.md#already-failing"><img alt="Already failing" src="assets/verdict-broken.png" width="88"></a>
  <a href="verdicts.md#known-flaky--probably-flaky"><img alt="Known flaky or probably flaky" src="assets/verdict-flaky.png" width="88"></a>
  <a href="verdicts.md#the-headline"><img alt="All tests passed" src="assets/verdict-passed.png" width="88"></a>
</p>

## Guides

- [Quarantine flaky tests](quarantine.md): stop known flaky tests from blocking merges.
- [Test runners](test-runners.md): produce JUnit XML with Vitest, Jest, pytest, Go, Maven, Gradle, Rust, Playwright and more.
- [Recipes](recipes.md): several suites, monorepos, sharding, matrices, nightly runs, merge queues.

## Reference

- [Configuration](configuration.md): every input and output, and when the step fails.
- [How it works](how-it-works.md): test identity, the history branch, the classification rules and the limits.
- [Permissions and security](security.md): tokens, stored data, pull requests from forks.
- [Troubleshooting](troubleshooting.md): every warning and error, explained.
- [FAQ](faq.md)

## Contributing

Bug reports, sample JUnit files from runners that misbehave, and pull requests are welcome. See [CONTRIBUTING.md](../CONTRIBUTING.md).
