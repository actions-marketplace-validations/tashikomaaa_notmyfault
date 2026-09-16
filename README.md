<div align="center">

# notmyfault

**A test just failed on your pull request. Is it your fault?**

[![CI](https://github.com/tashikomaaa/notmyfault/actions/workflows/ci.yml/badge.svg)](https://github.com/tashikomaaa/notmyfault/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/tashikomaaa/notmyfault?sort=semver)](https://github.com/tashikomaaa/notmyfault/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[Getting started](docs/getting-started.md) · [Documentation](docs/README.md) · [Wiki](https://github.com/tashikomaaa/notmyfault/wiki) · [Changelog](CHANGELOG.md)

</div>

notmyfault is a GitHub Action that remembers how every test behaves on your default branch. When a pull request turns red, it tells you which failures are **new**, which tests are **known to be flaky** and which were **already broken** before you touched anything.

---

### 🔴 3 tests failed, 1 looks related to this change

| | Test | Why |
|:-:|---|---|
| 🔴 | <code>checkout › applies discount codes</code> | **New failure.** Passed the last 50 runs on `main`. |
| ⚫ | <code>search › indexes new products</code> | **Already failing on `main`.** Failed the last 2 runs there. |
| 🟡 | <code>payments › retries declined cards</code> | **Known flaky.** Failed 4 of the last 50 runs on `main`; passed when the same commit was re-run on 2026-09-14. |

<sub>🔁 Passed only after a retry: <code>cart › merges guest cart</code> · Reported by notmyfault</sub>

---

## Why notmyfault

- **Stop re-running builds blindly.** Every failure comes with a verdict and the evidence behind it.
- **Stop flaky tests from blocking merges.** [Quarantine mode](docs/quarantine.md) fails the check only for failures that look real.
- **Nothing to host.** No server, no account, no SaaS: the history lives on a branch of your own repository.
- **Nothing to audit but this repository.** Zero runtime dependencies, one bundled file, rebuilt and verified by CI.
- **Any test runner.** Everything that writes JUnit XML: Vitest, Jest, pytest, Go, Maven, Gradle, cargo-nextest, Playwright, PHPUnit, RSpec, .NET…

## Quick start

Make your tests write JUnit XML, then add notmyfault after the test step:

```yaml
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
      - run: npm ci
      - run: npx vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml

      - uses: tashikomaaa/notmyfault@v1
        if: ${{ !cancelled() }}
        with:
          junit: reports/**/*.xml
```

Runs on `main` build the history, pull requests are compared with it. The [getting started guide](docs/getting-started.md) walks through it, and [Test runners](docs/test-runners.md) shows how to produce JUnit XML with other runners.

## How it decides

| Verdict | Meaning |
|---|---|
| 🔴 **New failure** | Nothing in the history explains it. Probably caused by the change. |
| 🟠 **Suspect** | Failed in isolation once or twice on `main`. Re-run to find out. |
| ⚫ **Already failing** | The latest runs on `main` failed too. Not your fault. |
| 🟡 **Flaky** | *Known flaky* when a retry or a re-run of the same commit proved it, *probably flaky* when it keeps failing in isolation. Not your fault. |

Every rule and threshold is documented in [Reading the report](docs/verdicts.md) and [How it works](docs/how-it-works.md).

## Documentation

| | |
|---|---|
| **Guides** | [Getting started](docs/getting-started.md) · [Quarantine flaky tests](docs/quarantine.md) · [Test runners](docs/test-runners.md) · [Recipes](docs/recipes.md) |
| **Reference** | [Reading the report](docs/verdicts.md) · [Configuration](docs/configuration.md) · [How it works](docs/how-it-works.md) · [Permissions and security](docs/security.md) |
| **Help** | [Troubleshooting](docs/troubleshooting.md) · [FAQ](docs/faq.md) |

## Contributing

Issues and pull requests are welcome, and JUnit reports that notmyfault misreads are especially valuable. See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
