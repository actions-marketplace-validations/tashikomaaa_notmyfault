# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- Complete documentation in `docs/`, mirrored to the GitHub wiki.
- Contributing guide, security policy and this changelog.

### Fixed

- Markdown in test names and failure messages (links, emphasis, images) is now escaped in pull request comments and job summaries, so reports always render as plain text.

## [1.0.0] - 2026-09-16

### Added

- Reads JUnit XML reports from any test runner, with retries detected from `flakyFailure` elements and repeated test cases.
- Keeps the recent history of every test on a `notmyfault-history` branch, as a single commit that never grows.
- Classifies each failure as new, suspect, already failing or flaky, with proof from retries and re-runs of the same commit.
- Pull request comment kept up to date, job summary with the most unreliable tests, and step outputs.
- Quarantine mode, so that known flaky tests stop blocking merges.

[Unreleased]: https://github.com/tashikomaaa/notmyfault/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tashikomaaa/notmyfault/releases/tag/v1.0.0
