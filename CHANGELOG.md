# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/tashikomaaa/notmyfault/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/tashikomaaa/notmyfault/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/tashikomaaa/notmyfault/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/tashikomaaa/notmyfault/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/tashikomaaa/notmyfault/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/tashikomaaa/notmyfault/releases/tag/v1.0.0
