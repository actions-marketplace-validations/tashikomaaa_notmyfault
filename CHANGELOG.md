# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [1.10.0] - 2026-09-17

### Added

- notmyfault is a component of the GitLab CI/CD Catalog, with inputs, published from the repository by a release job when a GitLab mirror gets a release tag. The template gets a `.notmyfault-pages` job, which publishes the history pages with GitLab Pages ([#24](https://github.com/tashikomaaa/notmyfault/issues/24)).

## [1.9.0] - 2026-09-17

### Added

- `notmyfault.mjs` runs in any other CI system, like Jenkins, CircleCI or Buildkite: it reads its configuration from `NOTMYFAULT_*` variables, the variables of common CI systems and git, pushes the history over HTTPS with a token or over SSH, and reports in the log, a Markdown summary, a dotenv file and its exit code. Outside CI systems, it records nothing unless told to ([#22](https://github.com/tashikomaaa/notmyfault/issues/22)).
- A dashboard action, `tashikomaaa/notmyfault/dashboard`, reads the history branches of several repositories and ranks their unreliable tests together, the costliest first, in a static page ready for GitHub Pages ([#25](https://github.com/tashikomaaa/notmyfault/issues/25)).

## [1.8.0] - 2026-09-17

### Added

- notmyfault runs in Forgejo and Gitea Actions: the same action detects them, uses their API for comments, flaky test issues and the pull request of a commit, looks for CODEOWNERS where they do, and leaves out checks, which they do not have ([#21](https://github.com/tashikomaaa/notmyfault/issues/21)).
- The job summary and the history pages estimate the test time each unreliable test cost over its remembered runs, a re-run of the suite per failure and another run of the test per retry, rank tests by it and add it up. The history records the total test time of the last runs as `runDurations` ([#20](https://github.com/tashikomaaa/notmyfault/issues/20)).

## [1.7.0] - 2026-09-17

### Added

- `check: true` reports each run as a check of its own, named by `check-name`, failing only on failures not covered by `tolerate`: branch protection can require it instead of the job, without quarantine mode or `continue-on-error`. It needs the `checks: write` permission ([#19](https://github.com/tashikomaaa/notmyfault/issues/19)).
- On GitLab, `NOTMYFAULT_RERUN_FLAKY: "true"` starts a new pipeline for the commit when only flaky tests stand in the way, once per commit, and says so in the comment ([#18](https://github.com/tashikomaaa/notmyfault/issues/18)).
- `mention-owners: true` mentions the owners of each flaky test, from CODEOWNERS, GitLab sections included, in its issue ([#17](https://github.com/tashikomaaa/notmyfault/issues/17)).

## [1.6.0] - 2026-09-17

### Added

- Tests already failing on the tracked branch say since when: the commit of the first failed run of the streak and the pull or merge request it came from, both linked, in the comment, the logs, the annotations, the flaky test issues and the history pages. The history records it as `failingSince` ([#15](https://github.com/tashikomaaa/notmyfault/issues/15)).
- Tests that ran in the latest run on the tracked branch but are missing from a run are listed as missing, a whole file or suite on one line: deleted, renamed or no longer found by the test runner. They make notmyfault comment on pull requests, never fail the step, and are counted by the `missing` output. Turn it off with `missing-tests: false` ([#16](https://github.com/tashikomaaa/notmyfault/issues/16)).
- Releases attest the build provenance of `dist/index.js` and `dist/notmyfault.mjs`, rebuilt from the tag, and attach `notmyfault.mjs.sha256`. The GitLab template checks `NOTMYFAULT_SHA256`, when set, before running the file ([#23](https://github.com/tashikomaaa/notmyfault/issues/23)).

## [1.5.0] - 2026-09-17

### Added

- notmyfault runs in GitLab CI/CD. `dist/notmyfault.mjs`, the same code bundled in one file, reads `NOTMYFAULT_*` variables, comments on merge requests, lists failed tests in the Code Quality widget, writes its outputs as dotenv variables and its summary as an artifact, and manages flaky test issues. A template runs it in a job of its own, whatever the language of the tests ([#14](https://github.com/tashikomaaa/notmyfault/issues/14)).
- Each release attaches `notmyfault.mjs`.

## [1.4.0] - 2026-09-16

### Added

- Runs on tracked branches follow renamed tests when it is unambiguous: one test gone and one added in the same file, with similar names. The history and the flaky test issue follow the new name, and the job summary lists the renames ([#13](https://github.com/tashikomaaa/notmyfault/issues/13)).
- When every failed test is flaky, notmyfault adds a notice titled `notmyfault: only flaky tests failed`, and the recipes document a companion workflow re-running the failed jobs once when it sees it ([#12](https://github.com/tashikomaaa/notmyfault/issues/12)).
- Each update of the history writes web pages on the history branch, a page per key listing its unreliable tests with a timeline of their runs, ready to publish with GitHub Pages ([#11](https://github.com/tashikomaaa/notmyfault/issues/11)).
- Each update of the history writes `badges/<key>.json`, a shields.io endpoint badge counting the flaky tests of that key, to show in a README ([#10](https://github.com/tashikomaaa/notmyfault/issues/10)).
- The job summary charts how the failure rate of the 3 most unreliable tests evolved over the remembered runs ([#9](https://github.com/tashikomaaa/notmyfault/issues/9)).
- The `quarantine` input tolerates tests by hand until a date, with a reason: their failures are marked in the report and never block, and expired entries raise a warning. The `quarantined` output counts them ([#8](https://github.com/tashikomaaa/notmyfault/issues/8)).
- Test durations: passing tests that take much longer than usual on the tracked branch are listed as slower in the report, with a `slower` output, and the job summary ranks the slowest tests ([#7](https://github.com/tashikomaaa/notmyfault/issues/7)).
- `flaky-issues: true` opens an issue for each flaky test on runs on tracked branches, updates it when the test fails again and closes it after 30 days without a failure. It needs the `issues: write` permission ([#6](https://github.com/tashikomaaa/notmyfault/issues/6)).

## [1.3.0] - 2026-09-16

### Added

- The `suites` input reports several test suites in one step and one pull request comment, each with its own history: suites of one job, or the same tests run in several environments ([#5](https://github.com/tashikomaaa/notmyfault/issues/5)).
- Failed tests are annotated next to their code with their verdict, when the report tells where they live: an error for new and suspect failures, a notice for flaky and already failing tests. Turn it off with `annotations: false` ([#4](https://github.com/tashikomaaa/notmyfault/issues/4)).

### Changed

- A test proven flaky counts as already failing only once it fails too many runs in a row on the tracked branch to be bad luck: from 3 failures for a test that rarely fails to 10 for one failing most of the time, instead of always 3 ([#3](https://github.com/tashikomaaa/notmyfault/issues/3)).
- A flaky, suspect or already failing test that fails with an error never seen on the tracked branch is reported as a new failure. The history remembers fingerprints of the failure messages seen there, never the messages themselves ([#2](https://github.com/tashikomaaa/notmyfault/issues/2)).

## [1.2.0] - 2026-09-16

### Added

- Tests that pass while failing on the tracked branch are listed as fixed in the report, with a `fixed` output. A pull request that fixes a test gets a comment even when nothing failed ([#1](https://github.com/tashikomaaa/notmyfault/issues/1)).
- Website at [notmyfault.aldwin.fr](https://notmyfault.aldwin.fr).

## [1.1.0] - 2026-09-16

### Added

- [Demo repository](https://github.com/tashikomaaa/notmyfault-demo) with pull requests showing every verdict, and a screenshot of a real comment in the README.
- A mascot, a banner, verdict badges and illustrations throughout the README, the documentation, the wiki and the issue forms.

### Changed

- The pull request comment and the job summary show verdict badges instead of emoji. The emoji remain as fallback where images do not load.

### Fixed

- Images in the documentation are displayed in the wiki.

## [1.0.1] - 2026-09-16

### Added

- Complete documentation in `docs/`, mirrored to the GitHub wiki.
- Contributing guide, code of conduct, security policy, issue and pull request templates, and this changelog.

### Changed

- The action is listed as "notmyfault flaky test detector", because GitHub Marketplace names cannot match an existing GitHub account. Usage is unchanged: `uses: tashikomaaa/notmyfault@v1`.

### Fixed

- Markdown in test names and failure messages (links, emphasis, images) is now escaped in pull request comments and job summaries, so reports always render as plain text.

## [1.0.0] - 2026-09-16

### Added

- Reads JUnit XML reports from any test runner, with retries detected from `flakyFailure` elements and repeated test cases.
- Keeps the recent history of every test on a `notmyfault-history` branch, as a single commit that never grows.
- Classifies each failure as new, suspect, already failing or flaky, with proof from retries and re-runs of the same commit.
- Pull request comment kept up to date, job summary with the most unreliable tests, and step outputs.
- Quarantine mode, so that known flaky tests stop blocking merges.

[Unreleased]: https://github.com/tashikomaaa/notmyfault/compare/v1.10.0...HEAD
[1.10.0]: https://github.com/tashikomaaa/notmyfault/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/tashikomaaa/notmyfault/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/tashikomaaa/notmyfault/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/tashikomaaa/notmyfault/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/tashikomaaa/notmyfault/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/tashikomaaa/notmyfault/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/tashikomaaa/notmyfault/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/tashikomaaa/notmyfault/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/tashikomaaa/notmyfault/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/tashikomaaa/notmyfault/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/tashikomaaa/notmyfault/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/tashikomaaa/notmyfault/releases/tag/v1.0.0
