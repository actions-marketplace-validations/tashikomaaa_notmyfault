# Test runners

<p align="center">
  <img alt="The croissant mascot kicking a bug labeled &quot;Test&quot;." src="assets/sticker-bug.png" width="220">
</p>

notmyfault reads JUnit XML, the de facto standard format for test reports. This page shows how to produce it with common runners.

Runners marked **tested** have sample reports, following their output format, in the notmyfault test suite. The others write standard JUnit XML and should work. If a report from your runner is misread, please [open an issue](https://github.com/tashikomaaa/notmyfault/issues) and attach it: it will become a test case.

## JavaScript and TypeScript

### Vitest (tested)

```sh
npx vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml
```

### Jest (tested)

Install [jest-junit](https://github.com/jest-community/jest-junit):

```sh
npm install --save-dev jest-junit
JEST_JUNIT_OUTPUT_DIR=reports npx jest --ci --reporters=default --reporters=jest-junit
```

### Playwright (tested)

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [["list"], ["junit", { outputFile: "reports/junit.xml" }]],
});
```

When several projects (browsers) run the same test, notmyfault treats them as one test and keeps the worst outcome.

### Mocha

```sh
npm install --save-dev mocha-junit-reporter
npx mocha --reporter mocha-junit-reporter --reporter-options mochaFile=reports/junit.xml
```

### Cypress

Cypress uses Mocha reporters. Include `[hash]` in the file name, otherwise each spec overwrites the previous report:

```js
// cypress.config.js
module.exports = defineConfig({
  reporter: "junit",
  reporterOptions: { mochaFile: "reports/junit-[hash].xml" },
});
```

### Bun

```sh
bun test --reporter=junit --reporter-outfile=reports/junit.xml
```

### Deno

```sh
deno test --junit-path=reports/junit.xml
```

## Python

### pytest (tested)

```sh
pytest --junitxml=reports/junit.xml
```

Errors during setup or teardown are reported as failures of the test.

## Go

### gotestsum (tested)

```sh
go install gotest.tools/gotestsum@latest
gotestsum --junitfile reports/junit.xml -- ./...
```

With `--rerun-fails`, gotestsum runs failed tests again and writes every attempt to the report. notmyfault reads a failure followed by a success as a retry:

```sh
gotestsum --junitfile reports/junit.xml --rerun-fails --packages ./...
```

### go-junit-report (tested)

```sh
go install github.com/jstemmer/go-junit-report/v2@latest
go test -v ./... 2>&1 | go-junit-report -set-exit-code > reports/junit.xml
```

## JVM

### Maven Surefire and Failsafe (tested)

Reports are written by default:

```yaml
junit: |
  **/target/surefire-reports/*.xml
  **/target/failsafe-reports/*.xml
```

To retry failing tests and report the retries:

```sh
mvn test -Dsurefire.rerunFailingTestsCount=2
```

### Gradle

Reports are written to `build/test-results/`:

```yaml
junit: "**/build/test-results/**/*.xml"
```

To report retries from the [test-retry plugin](https://github.com/gradle/test-retry-gradle-plugin) in the format notmyfault understands, merge reruns in the XML report:

```kotlin
tasks.test {
    retry { maxRetries.set(2) }
    reports.junitXml.mergeReruns.set(true)
}
```

## Rust

### cargo-nextest (tested)

```toml
# .config/nextest.toml
[profile.ci]
retries = 2

[profile.ci.junit]
path = "junit.xml"
```

```sh
cargo nextest run --profile ci
```

The report is written to `target/nextest/ci/junit.xml`.

## Other languages

| Runner | Command |
|---|---|
| PHPUnit | `phpunit --log-junit reports/junit.xml` |
| RSpec | Add the `rspec_junit_formatter` gem, then `rspec --format progress --format RspecJunitFormatter --out reports/rspec.xml` |
| .NET | Add the `JunitXml.TestLogger` package, then `dotnet test --logger "junit;LogFilePath=reports/{assembly}.xml"` |

## Detecting retries

Retries within a run are the fastest way for notmyfault to prove a test flaky. It understands two ways of reporting them:

- **`<flakyFailure>` and `<flakyError>` elements** inside a passing test case. Maven Surefire and Failsafe, cargo-nextest and Gradle with `mergeReruns` use this format.
- **The same test case repeated** inside one `<testsuite>`, first failing, then passing. gotestsum `--rerun-fails` uses this format.

Runners that only report the final outcome of a retried test hide the retry from notmyfault. Flakiness is still detected through re-runs of the same commit and through the history.

## Durations

notmyfault reads the `time` attribute of each test case, in seconds, to spot [slower tests](verdicts.md#slower-tests) and rank the slowest ones. Nearly every runner writes it, and reports without it simply have no durations.

## Annotations

notmyfault [annotates failed tests](verdicts.md#annotations) when it can find their file in the repository. What it finds depends on the report:

| Runner | File | Line |
|---|---|---|
| Vitest | From the class name, the test file path | From the failure output |
| Jest | From paths of the repository in the stack trace | From the stack trace |
| Playwright | From the suite name, when `testDir` is the repository root | From the failure output |
| pytest | From the module name, or the `file` attribute with `-o junit_family=xunit1` | With `-o junit_family=xunit1` |
| Maven Surefire and Gradle | From the class name, under `src/test/java` or `src/test/kotlin` at the repository root | From the stack trace |
| Go, cargo-nextest | Usually not found: reports give package or crate names, and file names relative to the package | |
| Others | From `file` attributes, or paths of the repository in the failure output | From `line` attributes or the failure output |

## Tips for stable test names

notmyfault follows each test by its name: the suite, the class name and the test name. See [How it works](how-it-works.md#test-identity).

- **Avoid dynamic values in names**, such as timestamps, random seeds or generated IDs. A test whose name changes on every run never builds any history.
- **Keep parameterized test names unique.** Two cases with the same name are merged into one test, and inside one suite a failing case followed by a passing one looks like a retry.
- **Renaming a test resets its history.** That is expected: notmyfault has no way to know it is the same test.
