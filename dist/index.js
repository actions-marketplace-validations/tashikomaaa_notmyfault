// src/main.ts
import { statSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { isAbsolute, join as join3, relative, resolve } from "node:path";

// src/github/io.ts
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EOL } from "node:os";
var ActionIO = class {
  constructor(env = process.env, write = (line) => process.stdout.write(line + EOL)) {
    this.env = env;
    this.write = write;
  }
  env;
  write;
  input(name, fallback = "") {
    const value = this.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
    return value === void 0 || value.trim() === "" ? fallback : value.trim();
  }
  booleanInput(name, fallback) {
    const value = this.input(name).toLowerCase();
    if (value === "") return fallback;
    if (["true", "yes", "on", "1"].includes(value)) return true;
    if (["false", "no", "off", "0"].includes(value)) return false;
    throw new Error(`Input "${name}" must be a boolean, got "${value}"`);
  }
  integerInput(name, fallback, min) {
    const value = this.input(name);
    if (value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min) {
      throw new Error(`Input "${name}" must be an integer >= ${min}, got "${value}"`);
    }
    return parsed;
  }
  inputName(name) {
    return `"${name}"`;
  }
  describeInput(name) {
    return `Input "${name}"`;
  }
  describeInputs(names) {
    return `Inputs ${names.map((name) => `"${name}"`).join(" and ")}`;
  }
  setOutput(name, value) {
    const file = this.env.GITHUB_OUTPUT;
    if (!file) return;
    const delimiter = `notmyfault_${randomUUID()}`;
    appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
  }
  appendSummary(markdown) {
    const file = this.env.GITHUB_STEP_SUMMARY;
    if (file) appendFileSync(file, markdown + EOL);
  }
  mask(secret) {
    if (secret) this.command("add-mask", secret);
  }
  info(message) {
    this.write(message);
  }
  warning(message) {
    this.command("warning", message);
  }
  error(message) {
    this.command("error", message);
  }
  /** A workflow annotation on a file, shown in the run summary and next to the code of pull requests. */
  annotation(level, message, properties) {
    const escapeProperty = (value) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
    const list = Object.entries(properties).filter(([, value]) => value !== void 0).map(([key, value]) => `${key}=${escapeProperty(String(value))}`).join(",");
    this.command(`${level} ${list}`, message);
  }
  group(title) {
    this.command("group", title);
  }
  endGroup() {
    this.write("::endgroup::");
  }
  /** Workflow commands are written as they come: nothing to write at the end. */
  finish() {
  }
  command(name, message) {
    const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    this.write(`::${name}::${escaped}`);
  }
};

// src/platform.ts
var ApiError = class extends Error {
  constructor(status, path, body, platform) {
    super(`${platform} API ${status} on ${path}: ${body.slice(0, 200)}`);
    this.status = status;
    this.path = path;
  }
  status;
  path;
  /** The token is missing a permission, a scope or a role. */
  get denied() {
    return this.status === 401 || this.status === 403;
  }
};

// src/github/api.ts
var GitHubClient = class {
  constructor(token, apiUrl, repository) {
    this.token = token;
    this.apiUrl = apiUrl;
    this.repository = repository;
  }
  token;
  apiUrl;
  repository;
  /**
   * Updates the comment carrying `marker`, or creates one when `create` is true.
   * Resolves to what happened.
   */
  async upsertComment(issue, marker, body, create) {
    const existing = await this.findComment(issue, marker);
    if (existing) {
      await this.request("PATCH", `/repos/${this.repository}/issues/comments/${existing.id}`, { body });
      return "updated";
    }
    if (!create) return "skipped";
    await this.addComment(issue, body);
    return "created";
  }
  async addComment(issue, body) {
    await this.request("POST", `/repos/${this.repository}/issues/${issue}/comments`, { body });
  }
  /** Issues, open or closed, carrying `label`. Pull requests are left out. */
  async listIssues(label) {
    const issues = [];
    let path = `/repos/${this.repository}/issues?labels=${encodeURIComponent(label)}&state=all&per_page=100`;
    while (path) {
      const response = await this.request("GET", path);
      for (const item of await response.json()) {
        if (!item.pull_request) issues.push({ number: item.number, state: item.state, body: item.body ?? "" });
      }
      path = nextPage(response.headers.get("link"), this.apiUrl);
    }
    return issues;
  }
  async createIssue(title, body, labels) {
    const response = await this.request("POST", `/repos/${this.repository}/issues`, { title, body, labels });
    return (await response.json()).number;
  }
  async updateIssue(issue, changes) {
    await this.request("PATCH", `/repos/${this.repository}/issues/${issue}`, changes);
  }
  /** Creates the label unless it exists. */
  async ensureLabel(name, color, description) {
    try {
      await this.request("GET", `/repos/${this.repository}/labels/${encodeURIComponent(name)}`);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      await this.request("POST", `/repos/${this.repository}/labels`, { name, color, description });
    }
  }
  async changeOf(sha) {
    const response = await this.request("GET", `/repos/${this.repository}/commits/${sha}/pulls?per_page=100`);
    const pulls = await response.json();
    const merged = pulls.filter((pull2) => pull2.merged_at !== null);
    const pull = merged.find((candidate) => candidate.merge_commit_sha === sha) ?? merged[0];
    return pull && { number: pull.number, url: pull.html_url };
  }
  async createCheck(check) {
    const response = await this.request("POST", `/repos/${this.repository}/check-runs`, {
      name: check.name,
      head_sha: check.sha,
      status: "completed",
      conclusion: check.success ? "success" : "failure",
      completed_at: (/* @__PURE__ */ new Date()).toISOString(),
      ...check.detailsUrl ? { details_url: check.detailsUrl } : {},
      output: { title: check.title, summary: check.summary }
    });
    return (await response.json()).html_url;
  }
  async findComment(issue, marker) {
    let path = `/repos/${this.repository}/issues/${issue}/comments?per_page=100`;
    while (path) {
      const response = await this.request("GET", path);
      const comments = await response.json();
      const match = comments.find((comment2) => comment2.body?.startsWith(marker));
      if (match) return match;
      path = nextPage(response.headers.get("link"), this.apiUrl);
    }
    return void 0;
  }
  async request(method, path, body) {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "notmyfault",
        "X-GitHub-Api-Version": "2022-11-28",
        ...body === void 0 ? {} : { "Content-Type": "application/json" }
      },
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    });
    if (!response.ok) throw new ApiError(response.status, path, await response.text(), "GitHub");
    return response;
  }
};
function nextPage(link, apiUrl) {
  const match = link?.match(/<([^>]+)>;\s*rel="next"/);
  if (!match?.[1]) return void 0;
  return match[1].startsWith(apiUrl) ? match[1].slice(apiUrl.length) : void 0;
}

// src/github/context.ts
import { readFileSync } from "node:fs";
function readContext(env) {
  const repository = required(env, "GITHUB_REPOSITORY");
  const payload = readPayload(env.GITHUB_EVENT_PATH);
  const pr = payload.pull_request;
  const serverUrl = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  const refName = env.GITHUB_REF_NAME ?? "";
  const runId = env.GITHUB_RUN_ID ?? "";
  const runAttempt = env.GITHUB_RUN_ATTEMPT ?? "1";
  const onBranch = !eventName.startsWith("pull_request") && env.GITHUB_REF === `refs/heads/${refName}`;
  return {
    repository,
    apiProject: repository,
    serverUrl,
    apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    sha: required(env, "GITHUB_SHA"),
    branch: onBranch ? refName : void 0,
    runDescription: `run ${runId || "local"}, attempt ${runAttempt}`,
    runUrl: runId ? `${serverUrl}/${repository}/actions/runs/${runId}${runAttempt !== "1" ? `/attempts/${runAttempt}` : ""}` : void 0,
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
    tempDir: env.RUNNER_TEMP,
    defaultBranch: payload.repository?.default_branch,
    defaultKey: `${env.GITHUB_WORKFLOW ?? "workflow"}-${env.GITHUB_JOB ?? "job"}`,
    pullRequest: typeof pr?.number === "number" ? {
      number: pr.number,
      fromFork: pr.head?.repo?.full_name !== (pr.base?.repo?.full_name ?? repository),
      // GITHUB_SHA is the merge commit GitHub creates for the run: checks show on the head of the pull request.
      ...pr.head?.sha ? { headSha: pr.head.sha } : {}
    } : void 0,
    defaultToken: void 0
  };
}
function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set. notmyfault must run inside GitHub Actions.`);
  return value;
}
function readPayload(path) {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// src/github/platform.ts
function githubPlatform(env, io = new ActionIO(env)) {
  const context = readContext(env);
  return {
    name: "github",
    context,
    io,
    forge: (token) => new GitHubClient(token, context.apiUrl, context.apiProject),
    gitUser: () => "x-access-token",
    gitAuthor: { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
    pushOptions: [],
    codeownersPaths: [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"],
    commitUrl: (sha) => `${context.serverUrl}/${context.repository}/commit/${sha}`,
    text: {
      pullRequest: "pull request",
      changePrefix: "#",
      runLink: "Workflow run",
      runName: "workflow run",
      tokenMissing: 'Input "token" is empty. Pass `token: ${{ github.token }}`.',
      recordDenied: 'Does the job have "contents: write" permission?',
      commentDenied: 'Does the job have "pull-requests: write" permission?',
      commentFromFork: "Tokens are read-only on pull requests from forks; the job summary has the full report.",
      checkDenied: 'Does the job have "checks: write" permission?',
      rerunDenied: "",
      issuesDenied: 'Does the job have "issues: write" permission?'
    },
    rerunNotice: true
  };
}

// src/forgejo/api.ts
var ForgejoClient = class {
  constructor(token, apiUrl, repository) {
    this.token = token;
    this.apiUrl = apiUrl;
    this.repository = repository;
  }
  token;
  apiUrl;
  repository;
  async upsertComment(issue, marker, body, create) {
    const comments = await this.list(`/repos/${this.repository}/issues/${issue}/comments?limit=50`);
    const existing = comments.find((comment2) => comment2.body?.startsWith(marker));
    if (existing) {
      await this.request("PATCH", `/repos/${this.repository}/issues/comments/${existing.id}`, { body });
      return "updated";
    }
    if (!create) return "skipped";
    await this.addComment(issue, body);
    return "created";
  }
  async addComment(issue, body) {
    await this.request("POST", `/repos/${this.repository}/issues/${issue}/comments`, { body });
  }
  async listIssues(label) {
    const items = await this.list(`/repos/${this.repository}/issues?labels=${encodeURIComponent(label)}&state=all&type=issues&limit=50`);
    return items.map((item) => ({ number: item.number, state: item.state, body: item.body ?? "" }));
  }
  async createIssue(title, body, labels) {
    const known = await this.labels();
    const ids = labels.map((name) => known.find((label) => label.name === name)?.id).filter((id) => id !== void 0);
    const response = await this.request("POST", `/repos/${this.repository}/issues`, { title, body, labels: ids });
    return (await response.json()).number;
  }
  async updateIssue(issue, changes) {
    await this.request("PATCH", `/repos/${this.repository}/issues/${issue}`, changes);
  }
  async ensureLabel(name, color, description) {
    if ((await this.labels()).some((label) => label.name === name)) return;
    await this.request("POST", `/repos/${this.repository}/labels`, { name, color: `#${color}`, description });
  }
  async changeOf(sha) {
    try {
      const response = await this.request("GET", `/repos/${this.repository}/commits/${sha}/pull`);
      const pull = await response.json();
      return pull.merged ? { number: pull.number, url: pull.html_url } : void 0;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return void 0;
      throw error;
    }
  }
  async labels() {
    return this.list(`/repos/${this.repository}/labels?limit=50`);
  }
  async list(path) {
    const items = [];
    let next = path;
    while (next) {
      const response = await this.request("GET", next);
      items.push(...await response.json());
      const link = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      next = link?.startsWith(this.apiUrl) ? link.slice(this.apiUrl.length) : void 0;
    }
    return items;
  }
  async request(method, path, body) {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `token ${this.token}`,
        "User-Agent": "notmyfault",
        ...body === void 0 ? {} : { "Content-Type": "application/json" }
      },
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    });
    if (!response.ok) throw new ApiError(response.status, path, await response.text(), "Forgejo");
    return response;
  }
};

// src/forgejo/platform.ts
function forgejoPlatform(env, io = new ActionIO(env)) {
  const github = githubPlatform(env, io);
  const { context } = github;
  return {
    ...github,
    name: "forgejo",
    forge: (token) => new ForgejoClient(token, context.apiUrl, context.apiProject),
    gitAuthor: { name: "notmyfault", email: `notmyfault@noreply.${new URL(context.serverUrl).hostname || "localhost"}` },
    codeownersPaths: [".forgejo/CODEOWNERS", ".gitea/CODEOWNERS", "docs/CODEOWNERS", "CODEOWNERS"],
    text: {
      ...github.text,
      recordDenied: "Can the token push to the repository? Branch protection rules matching the history branch reject its pushes.",
      commentDenied: "Can the token comment on pull requests?",
      commentFromFork: "Tokens are read-only on pull requests from forks; the job summary has the full report.",
      issuesDenied: "Can the token write issues?"
    },
    // No workflow_run event to re-run jobs from.
    rerunNotice: false
  };
}

// src/history.ts
import { createHash } from "node:crypto";
var HISTORY_VERSION = 1;
var PASS = "p";
var FAIL = "f";
var RETRY = "r";
var MAX_FAILED_ON = 20;
var MAX_EVIDENCE = 10;
var MAX_ERRORS = 10;
var MAX_DURATIONS = 10;
var MAX_FINGERPRINTED_LENGTH = 200;
var DAY_MS = 24 * 60 * 60 * 1e3;
function emptyHistory() {
  return { version: HISTORY_VERSION, updatedAt: (/* @__PURE__ */ new Date(0)).toISOString(), runs: 0, tests: {} };
}
function errorFingerprint(message) {
  const normalized = message.toLowerCase().replace(/\b(?=[0-9a-f-]*\d)[0-9a-f]{7,}(?:-[0-9a-f]{4,})*\b/g, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, MAX_FINGERPRINTED_LENGTH);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}
function parseHistory(json) {
  if (!json) return emptyHistory();
  try {
    const data = JSON.parse(json);
    if (data.version !== HISTORY_VERSION || typeof data.tests !== "object" || data.tests === null) {
      return emptyHistory();
    }
    return {
      version: HISTORY_VERSION,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : emptyHistory().updatedAt,
      runs: typeof data.runs === "number" ? data.runs : 0,
      ...Array.isArray(data.runDurations) ? { runDurations: data.runDurations.filter((ms) => typeof ms === "number") } : {},
      tests: data.tests
    };
  } catch {
    return emptyHistory();
  }
}
function serializeHistory(history) {
  return `${JSON.stringify(history, null, 1)}
`;
}
function recordRun(history, results, options) {
  const sha = options.sha.slice(0, 12);
  const today = options.now.toISOString().slice(0, 10);
  let changed = false;
  for (const result of results) {
    if (result.outcome === "skipped") continue;
    let test = history.tests[result.id];
    let testChanged = false;
    if (!test) {
      if (!options.tracked && result.outcome === "passed") continue;
      test = { outcomes: "", lastSeen: today };
      history.tests[result.id] = test;
      testChanged = true;
    }
    if (options.tracked) {
      const code2 = result.outcome === "failed" ? FAIL : result.outcome === "flaky" ? RETRY : PASS;
      if (code2 !== FAIL) {
        delete test.failingSince;
      } else if (!test.outcomes.endsWith(FAIL)) {
        test.failingSince = {
          sha,
          at: options.now.toISOString(),
          ...options.commit?.url ? { url: options.commit.url } : {},
          ...options.commit?.change ? { change: options.commit.change } : {}
        };
      }
      test.outcomes = (test.outcomes + code2).slice(-options.window);
      test.lastRun = history.runs + 1;
      testChanged = true;
      if (result.duration !== void 0) test.durations = [...test.durations ?? [], result.duration].slice(-MAX_DURATIONS);
      if (result.outcome !== "passed") {
        test.lastFailure = today;
        if (result.message) addError(test, errorFingerprint(result.message));
      }
    }
    if (result.outcome === "failed") {
      if (!test.failedOn?.includes(sha)) {
        test.failedOn = [...test.failedOn ?? [], sha].slice(-MAX_FAILED_ON);
        testChanged = true;
      }
    } else if (result.outcome === "flaky") {
      testChanged = addEvidence(test, { at: options.now.toISOString(), sha, kind: "retry" }) || testChanged;
    } else if (test.failedOn?.includes(sha)) {
      testChanged = addEvidence(test, { at: options.now.toISOString(), sha, kind: "rerun" }) || testChanged;
    }
    if (testChanged) {
      test.lastSeen = today;
      changed = true;
    }
  }
  if (options.tracked) {
    history.runs += 1;
    const timed = results.filter((result) => result.outcome !== "skipped" && result.duration !== void 0);
    if (timed.length > 0) {
      const total = timed.reduce((sum, result) => sum + result.duration, 0);
      history.runDurations = [...history.runDurations ?? [], total].slice(-MAX_DURATIONS);
    }
  }
  changed = prune(history, options) || changed;
  if (changed) history.updatedAt = options.now.toISOString();
  return changed;
}
function addEvidence(test, evidence) {
  const existing = test.evidence ?? [];
  if (existing.some((e) => e.sha === evidence.sha && e.kind === evidence.kind)) return false;
  test.evidence = [...existing, evidence].slice(-MAX_EVIDENCE);
  return true;
}
function addError(test, fingerprint) {
  test.errors = [...(test.errors ?? []).filter((e) => e !== fingerprint), fingerprint].slice(-MAX_ERRORS);
}
function prune(history, options) {
  const cutoff = options.now.getTime() - options.retentionDays * DAY_MS;
  let changed = false;
  for (const [id, test] of Object.entries(history.tests)) {
    if (Date.parse(test.lastSeen) < cutoff) {
      delete history.tests[id];
      changed = true;
      continue;
    }
    if (test.evidence?.some((e) => Date.parse(e.at) < cutoff)) {
      test.evidence = test.evidence.filter((e) => Date.parse(e.at) >= cutoff);
      if (test.evidence.length === 0) delete test.evidence;
      changed = true;
    }
  }
  return changed;
}

// src/analyze.ts
var DAY_MS2 = 24 * 60 * 60 * 1e3;
var SEPARATOR = " \u203A ";
var LIKELY_FLAKY_ISOLATED_FAILURES = 3;
var UNLIKELY_STREAK_CHANCE = 0.01;
var MIN_BROKEN_STREAK = 3;
var MAX_BROKEN_STREAK = 10;
var SLOWER_RATIO = 2;
var SLOWER_MIN_DIFFERENCE_MS = 500;
var SLOWER_MIN_RUNS = 5;
var VERDICT_ORDER = { new: 0, suspect: 1, broken: 2, flaky: 3 };
function analyze(results, history, now, evidenceTtlDays) {
  const analysis = {
    total: results.length,
    passed: 0,
    skipped: 0,
    failures: [],
    retried: [],
    fixed: [],
    slower: [],
    missing: missingTests(results, history)
  };
  const checkFixed = (test) => {
    const tested = history.tests[test.id];
    if (!tested?.outcomes.endsWith(FAIL)) return;
    const stats = computeStats(tested, now, evidenceTtlDays);
    if (verdictFor(stats) === "broken") analysis.fixed.push({ test, ...stats });
  };
  const checkSlower = (test) => {
    const durations = history.tests[test.id]?.durations ?? [];
    if (test.duration === void 0 || durations.length < SLOWER_MIN_RUNS) return;
    const usual = median(durations);
    if (test.duration >= usual * SLOWER_RATIO && test.duration - usual >= SLOWER_MIN_DIFFERENCE_MS) {
      analysis.slower.push({ test, duration: test.duration, usual });
    }
  };
  for (const test of results) {
    switch (test.outcome) {
      case "passed":
        analysis.passed++;
        checkFixed(test);
        checkSlower(test);
        break;
      case "skipped":
        analysis.skipped++;
        break;
      case "flaky":
        analysis.passed++;
        analysis.retried.push(test);
        checkFixed(test);
        checkSlower(test);
        break;
      case "failed": {
        const tested = history.tests[test.id];
        const stats = computeStats(tested, now, evidenceTtlDays);
        const failure = { test, verdict: verdictFor(stats), ...stats };
        if (failure.verdict !== "new" && hasNewError(tested, test)) {
          failure.usually = failure.verdict;
          failure.verdict = "new";
        }
        analysis.failures.push(failure);
        break;
      }
    }
  }
  analysis.failures.sort(
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.test.title.localeCompare(b.test.title)
  );
  analysis.retried.sort((a, b) => a.title.localeCompare(b.title));
  analysis.fixed.sort((a, b) => a.test.title.localeCompare(b.test.title));
  analysis.slower.sort((a, b) => b.duration / b.usual - a.duration / a.usual || a.test.title.localeCompare(b.test.title));
  return analysis;
}
function missingTests(results, history) {
  const present = new Set(results.map((result) => result.id));
  const groups = /* @__PURE__ */ new Map();
  for (const [id, test] of Object.entries(history.tests)) {
    if (history.runs === 0 || test.lastRun !== history.runs) continue;
    const index = id.lastIndexOf(SEPARATOR);
    const name = index === -1 ? "" : id.slice(0, index);
    const group = groups.get(name) ?? { ids: [], latest: 0 };
    group.latest++;
    if (!present.has(id)) group.ids.push(id);
    groups.set(name, group);
  }
  return [...groups].filter(([, group]) => group.ids.length > 0).map(([name, group]) => ({ group: name, ids: group.ids.sort(), whole: group.ids.length === group.latest })).sort((a, b) => a.group.localeCompare(b.group));
}
function computeStats(history, now, evidenceTtlDays) {
  const outcomes = history?.outcomes ?? "";
  const cutoff = now.getTime() - evidenceTtlDays * DAY_MS2;
  const evidence = (history?.evidence ?? []).filter((e) => Date.parse(e.at) >= cutoff);
  const retries = count(outcomes, RETRY);
  const trailing = trailingFailures(outcomes);
  const before = outcomes.slice(0, outcomes.length - trailing);
  const failureRate = before.length === 0 ? 0 : count(before, FAIL) / before.length;
  const stats = {
    runs: outcomes.length,
    failures: count(outcomes, FAIL),
    retries,
    trailingFailures: trailing,
    failureRate,
    brokenStreak: brokenStreak(failureRate),
    trailingPasses: outcomes.length - outcomes.lastIndexOf(FAIL) - 1,
    isolatedFailures: isolatedFailures(outcomes),
    confirmed: evidence.length > 0 || retries > 0
  };
  const latest = evidence[evidence.length - 1];
  if (latest) stats.latestEvidence = latest;
  if (trailing > 0 && history?.failingSince) stats.failingSince = history.failingSince;
  return stats;
}
function verdictFor(stats) {
  if (stats.confirmed) return stats.trailingFailures >= stats.brokenStreak ? "broken" : "flaky";
  if (stats.trailingFailures >= 1) return "broken";
  if (stats.isolatedFailures >= LIKELY_FLAKY_ISOLATED_FAILURES) return "flaky";
  if (stats.isolatedFailures >= 1) return "suspect";
  return "new";
}
function hasNewError(history, test) {
  const known = history?.errors ?? [];
  return known.length > 0 && test.message !== void 0 && !known.includes(errorFingerprint(test.message));
}
function blockingFailures(analysis, tolerated) {
  return analysis.failures.filter((failure) => !failure.quarantined && !tolerated.has(failure.verdict));
}
function countFlakyTests(history, now, evidenceTtlDays) {
  return rankFlakyTests(history, now, evidenceTtlDays, Number.POSITIVE_INFINITY).length;
}
function rankFlakyTests(history, now, evidenceTtlDays, limit) {
  const ranked = [];
  for (const [id, test] of Object.entries(history.tests)) {
    const stats = computeStats(test, now, evidenceTtlDays);
    if (!stats.confirmed && stats.isolatedFailures < LIKELY_FLAKY_ISOLATED_FAILURES) continue;
    const cost = estimateCost(test, history);
    ranked.push(cost === void 0 ? { id, ...stats } : { id, ...stats, cost });
  }
  const score2 = (t) => (t.failures + t.retries) / Math.max(t.runs, 1) + (t.confirmed ? 1 : 0);
  return ranked.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || score2(b) - score2(a) || a.id.localeCompare(b.id)).slice(0, limit);
}
function estimateCost(test, history) {
  const failures = count(test.outcomes, FAIL);
  const retries = count(test.outcomes, RETRY);
  const suite = history.runDurations?.length ? median(history.runDurations) : void 0;
  const own = test.durations?.length ? median(test.durations) : void 0;
  if (failures > 0 && suite === void 0 || retries > 0 && own === void 0) return void 0;
  return failures * (suite ?? 0) + retries * (own ?? 0);
}
function brokenStreak(failureRate) {
  let streak = MIN_BROKEN_STREAK;
  while (streak < MAX_BROKEN_STREAK && failureRate ** streak >= UNLIKELY_STREAK_CHANCE) streak++;
  return streak;
}
var TREND_WINDOW = 10;
var TREND_MIN_RUNS = 15;
function failureTrends(history, ids) {
  const trends = [];
  for (const id of ids) {
    const outcomes = history.tests[id]?.outcomes ?? "";
    if (outcomes.length < TREND_MIN_RUNS) continue;
    const rates = [];
    for (let end = TREND_WINDOW; end <= outcomes.length; end++) {
      rates.push(Math.round(count(outcomes.slice(end - TREND_WINDOW, end), FAIL) / TREND_WINDOW * 100));
    }
    trends.push({ id, rates, firstRun: TREND_WINDOW });
  }
  return trends;
}
function rankSlowTests(history, limit) {
  const ranked = [];
  for (const [id, test] of Object.entries(history.tests)) {
    const durations = test.durations ?? [];
    if (durations.length === 0) continue;
    ranked.push({ id, median: median(durations), fastest: Math.min(...durations), slowest: Math.max(...durations), runs: durations.length });
  }
  return ranked.filter((test) => test.median > 0).sort((a, b) => b.median - a.median || a.id.localeCompare(b.id)).slice(0, limit);
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
function isolatedFailures(outcomes) {
  let isolated = 0;
  for (let i = 1; i < outcomes.length - 1; i++) {
    if (outcomes[i] === FAIL && outcomes[i - 1] !== FAIL && outcomes[i + 1] !== FAIL) isolated++;
  }
  return isolated;
}
function trailingFailures(outcomes) {
  let streak = 0;
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i] === FAIL; i--) streak++;
  return streak;
}
function count(value, char) {
  let n = 0;
  for (const c of value) if (c === char) n++;
  return n;
}

// src/git-store.ts
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
var GitError = class extends Error {
  constructor(args, output) {
    super(`git ${args[0]} failed: ${output.trim() || "unknown error"}`);
    this.args = args;
    this.output = output;
  }
  args;
  output;
};
var BOT_NAME = "github-actions[bot]";
var BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
var RETRYABLE_PUSH = /stale info|fetch first|non-fast-forward|cannot lock ref|failed to update ref/i;
var GitStore = class {
  constructor(options) {
    this.options = options;
  }
  options;
  dir;
  async read(path) {
    const head = await this.fetchHead();
    return head ? this.readFile(head, path) : void 0;
  }
  /**
   * Rewrites `path` with the result of `update` (skipped when it returns
   * undefined). `update` may run several times, always on the latest content.
   * `derivedFiles` writes more files computed from that result and the paths
   * already on the branch, in the same commit.
   * Resolves to whether a commit was pushed.
   */
  async update(path, update, options) {
    const attempts = options.attempts ?? 6;
    for (let attempt = 1; ; attempt++) {
      const head = await this.fetchHead();
      const next = update(head ? await this.readFile(head, path) : void 0);
      if (next === void 0) return false;
      const existing = options.derivedFiles && head ? await this.listFiles(head) : [];
      const files = { ...options.extraFiles, ...options.derivedFiles?.(next, existing), [path]: next };
      const commit = await this.commit(head, files, options.message);
      let conflict;
      try {
        const output = await this.git([
          "push",
          "--porcelain",
          ...(this.options.pushOptions ?? []).map((option) => `--push-option=${option}`),
          `--force-with-lease=refs/heads/${this.options.branch}:${head ?? ""}`,
          this.options.remoteUrl,
          `${commit}:refs/heads/${this.options.branch}`
        ]);
        if (commit === head || !/^=\t/m.test(output)) return true;
        conflict = new Error("git push was a no-op: a concurrent writer pushed identical content");
      } catch (error) {
        const retryable = error instanceof GitError && RETRYABLE_PUSH.test(error.output);
        if (!retryable) throw error;
        conflict = error;
      }
      if (attempt >= attempts) throw conflict;
      await sleep(150 * attempt + Math.random() * 350);
    }
  }
  async dispose() {
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
    this.dir = void 0;
  }
  async fetchHead() {
    try {
      await this.git([
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        this.options.remoteUrl,
        `refs/heads/${this.options.branch}`
      ]);
    } catch (error) {
      if (error instanceof GitError && /couldn't find remote ref/i.test(error.output)) return void 0;
      throw error;
    }
    return (await this.git(["rev-parse", "FETCH_HEAD"])).trim();
  }
  async listFiles(commit) {
    return (await this.git(["ls-tree", "-r", "--name-only", commit])).split("\n").filter(Boolean);
  }
  async readFile(commit, path) {
    const listed = await this.git(["ls-tree", "--name-only", commit, "--", path]);
    if (listed.trim() === "") return void 0;
    return this.git(["cat-file", "blob", `${commit}:${path}`]);
  }
  async commit(parent, files, message) {
    const dir = await this.repository();
    const env = { GIT_INDEX_FILE: join(dir, ".git", "notmyfault-index") };
    await this.git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], env);
    for (const [path, content] of Object.entries(files)) {
      const blob = (await this.git(["hash-object", "-w", "--stdin"], env, content)).trim();
      await this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
    }
    const tree = (await this.git(["write-tree"], env)).trim();
    return (await this.git(["commit-tree", tree, "-m", message], {
      GIT_AUTHOR_NAME: this.options.author?.name ?? BOT_NAME,
      GIT_AUTHOR_EMAIL: this.options.author?.email ?? BOT_EMAIL,
      GIT_COMMITTER_NAME: this.options.author?.name ?? BOT_NAME,
      GIT_COMMITTER_EMAIL: this.options.author?.email ?? BOT_EMAIL
    })).trim();
  }
  async repository() {
    if (!this.dir) {
      const dir = await mkdtemp(join(this.options.tempDir ?? tmpdir(), "notmyfault-"));
      await run(["init", "--quiet", dir], this.baseEnv());
      this.dir = dir;
    }
    return this.dir;
  }
  async git(args, env = {}, input) {
    const dir = await this.repository();
    return run(["-C", dir, ...args], { ...this.baseEnv(), ...env }, input);
  }
  baseEnv() {
    const env = {
      GIT_TERMINAL_PROMPT: "0",
      // Ignore global/system config (credential helpers, hooks, signing...).
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull
    };
    const { token, remoteUrl } = this.options;
    if (token && /^https?:\/\//.test(remoteUrl)) {
      const origin = new URL(remoteUrl).origin;
      const credentials = Buffer.from(`${this.options.username ?? "x-access-token"}:${token}`).toString("base64");
      Object.assign(env, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credentials}`
      });
    }
    return env;
  }
};
function run(args, env, input) {
  return new Promise((resolve2, reject) => {
    const child = spawn("git", args, {
      env: { ...process.env, ...env },
      stdio: [input === void 0 ? "ignore" : "pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => reject(new Error(`Unable to run git: ${error.message}`)));
    child.on("close", (code2) => {
      const out = Buffer.concat(stdout).toString("utf8");
      if (code2 === 0) resolve2(out);
      else reject(new GitError(args[0] === "-C" ? args.slice(2) : args, Buffer.concat(stderr).toString("utf8") + out));
    });
    if (child.stdin) {
      child.stdin.on("error", () => {
      });
      child.stdin.end(input);
    }
  });
}
function sleep(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}

// src/badge.ts
function badgePath(key) {
  return `badges/${key}.json`;
}
function renderBadge(history, now, evidenceTtlDays) {
  const flaky = countFlakyTests(history, now, evidenceTtlDays);
  const badge2 = { schemaVersion: 1, label: "flaky tests", message: String(flaky), color: flaky === 0 ? "19a08e" : "fcbd34" };
  return `${JSON.stringify(badge2, null, 1)}
`;
}

// src/report.ts
var MAX_CHECK_SUMMARY = 65535;
var MAX_ROWS = 30;
var MAX_MESSAGES = 10;
var MAX_FIXED = 10;
var MAX_SLOWER = 10;
var MAX_MISSING = 10;
var MAX_CHART_TITLE = 60;
var PROJECT_URL = "https://github.com/tashikomaaa/notmyfault";
var BADGES_URL = "https://raw.githubusercontent.com/tashikomaaa/notmyfault/main/docs/assets";
var EMOJI = { new: "\u{1F534}", suspect: "\u{1F7E0}", broken: "\u26AB", flaky: "\u{1F7E1}" };
function badge(image, emoji, size) {
  return `<img src="${BADGES_URL}/verdict-${image}.png" alt="${emoji}" width="${size}" height="${size}" align="absmiddle">`;
}
function commentMarker(key) {
  return `<!-- notmyfault:${key} -->`;
}
function renderSuitesComment(suites, context) {
  return [commentMarker(context.key), ...renderBody(suites, context)].join("\n");
}
function renderCheck(suites, context) {
  const lines = renderBody(suites, { ...context, mode: "quarantine" }, "Check");
  const title = lines[0].replace(/^### (<img [^>]*> )?/, "");
  const summary = lines.slice(2).join("\n");
  return {
    title,
    summary: summary.length > MAX_CHECK_SUMMARY ? `${summary.slice(0, MAX_CHECK_SUMMARY - 30)}

_\u2026report truncated_` : summary
  };
}
function renderSuitesSummary(suites, context) {
  const lines = renderBody(suites, context);
  for (const suite of suites) {
    const of = suites.length > 1 ? ` of ${suite.name}` : "";
    if (suite.renames?.length) {
      lines.push(
        "",
        `\u270F\uFE0F **Renamed:** the history of ${plural(suite.renames.length, "test")}${of} followed ${suite.renames.length === 1 ? "its" : "their"} new name. If a rename is wrong, the new test inherited the history of another one: see [Test identity](${PROJECT_URL}/blob/main/docs/how-it-works.md#test-identity).`,
        "",
        ...suite.renames.map(({ from, to }) => `- ${code(from)} \u2192 ${code(to)}`)
      );
    }
    if (suite.slowest?.length) {
      lines.push(
        "",
        `<details><summary>Slowest tests${of} on ${branches(context)}</summary>`,
        "",
        "| Test | Median | Fastest | Slowest | Runs |",
        "|---|--:|--:|--:|--:|",
        ...suite.slowest.map(
          (t) => `| ${code(t.id)} | ${duration(t.median)} | ${duration(t.fastest)} | ${duration(t.slowest)} | ${t.runs} |`
        ),
        "",
        "</details>"
      );
    }
    if (suite.ranking?.length) {
      const costs = suite.ranking.some((t) => t.cost !== void 0);
      const total = suite.ranking.reduce((sum, t) => sum + (t.cost ?? 0), 0);
      const costing = total > 0 ? `, costing about ${duration(total)} of test time` : "";
      lines.push(
        "",
        `<details><summary>Most unreliable tests${of} on ${branches(context)}${costing}</summary>`,
        "",
        `| Test | Failed runs | Passed on retry | Proven flaky |${costs ? " Estimated cost |" : ""}`,
        `|---|--:|--:|:-:|${costs ? "--:|" : ""}`,
        ...suite.ranking.map(
          (t) => `| ${code(t.id)} | ${t.failures} / ${t.runs} | ${t.retries} | ${t.confirmed ? "yes" : "probably"} |${costs ? ` ${t.cost === void 0 ? "" : duration(t.cost)} |` : ""}`
        ),
        "",
        ...costs ? [
          `_Each failure counts as a re-run of the suite, each retry as another run of the test, at their median durations. See [Cost of unreliable tests](${PROJECT_URL}/blob/main/docs/verdicts.md#cost-of-unreliable-tests)._`,
          ""
        ] : [],
        "</details>"
      );
    }
    if (suite.trends?.length) lines.push("", ...renderTrends(suite.trends, of, context));
  }
  return lines.join("\n");
}
function chartTitle(id) {
  const title = id.replace(/["\\]/g, "'");
  return title.length > MAX_CHART_TITLE ? `\u2026${title.slice(-(MAX_CHART_TITLE - 1))}` : title;
}
function renderTrends(trends, of, context) {
  const lines = [`<details><summary>Failure rate of the most unreliable tests${of} on ${branches(context)}</summary>`, ""];
  for (const trend of trends) {
    const last = trend.firstRun + trend.rates.length - 1;
    lines.push(
      "```mermaid",
      "xychart-beta",
      `  title "${chartTitle(trend.id)}"`,
      `  x-axis "Runs on ${context.trackedBranches.join(", ")}, oldest first" ${trend.firstRun} --> ${last}`,
      `  y-axis "Failed, of the last ${TREND_WINDOW} runs (%)" 0 --> 100`,
      `  line [${trend.rates.join(", ")}]`,
      "```",
      ""
    );
  }
  lines.push("</details>");
  return lines;
}
function renderBody(suites, context, decision = "Quarantine") {
  const all = combine(suites.map((suite) => suite.analysis));
  const lines = [`### ${headline(all)}`, ""];
  for (const suite of suites) {
    if (suites.length > 1) {
      lines.push(`#### ${escapeHtml(suite.name)}`, "");
      const { analysis } = suite;
      if (analysis.failures.length === 0 && analysis.fixed.length === 0) {
        lines.push(`${badge("passed", "\u2705", 20)} All ${plural(analysis.total - analysis.skipped, "test")} passed.`, "");
      }
    }
    lines.push(...renderSuite(suite.analysis, context));
  }
  if (context.mode === "quarantine" && all.failures.length > 0) {
    const verdicts = [...context.tolerated].map((v) => `\`${v}\``).join(", ") || "nothing";
    const byHand = context.quarantined ? `, and ${plural(context.quarantined, "failure")} quarantined by hand` : "";
    const tolerated = `${verdicts}${byHand}`;
    lines.push(
      context.blocking === 0 ? `\u{1F6E1}\uFE0F **${decision}:** every failure is tolerated (${tolerated}), so this check passes.` : `\u274C **${decision}:** ${plural(context.blocking, "failure")} not tolerated (${tolerated}), so this check fails.`,
      ""
    );
  }
  if (context.rerunUrl) {
    lines.push(
      `\u{1F501} **Re-run:** only flaky tests stand in the way, so notmyfault started [a new pipeline](${context.rerunUrl}) for this commit. Passing there proves them flaky.`,
      ""
    );
  }
  const withoutHistory = suites.filter((suite) => suite.historyRuns === 0);
  if (withoutHistory.length > 0) {
    const which = suites.length > 1 ? ` for ${withoutHistory.map((suite) => escapeHtml(suite.name)).join(", ")}` : "";
    lines.push(
      `\u2139\uFE0F No history on ${branches(context)} yet${which}. Verdicts get sharper once a few runs have been recorded there.`,
      ""
    );
  }
  lines.push(footer(all.retried, context));
  return lines;
}
function combine(analyses) {
  return {
    total: analyses.reduce((sum, a) => sum + a.total, 0),
    passed: analyses.reduce((sum, a) => sum + a.passed, 0),
    skipped: analyses.reduce((sum, a) => sum + a.skipped, 0),
    failures: analyses.flatMap((a) => a.failures),
    retried: analyses.flatMap((a) => a.retried),
    fixed: analyses.flatMap((a) => a.fixed),
    slower: analyses.flatMap((a) => a.slower),
    missing: analyses.flatMap((a) => a.missing)
  };
}
function renderSuite(analysis, context) {
  const lines = [];
  if (analysis.failures.length > 0) {
    lines.push("| Test | Why |", "|---|---|");
    for (const failure of analysis.failures.slice(0, MAX_ROWS)) {
      const icon = badge(failure.verdict, EMOJI[failure.verdict], 24);
      const byHand = failure.quarantined ? ` ${quarantineNote(failure.quarantined)}` : "";
      lines.push(`| ${code(failure.test.title)} | ${icon} ${explain(failure, context)}${byHand} |`);
    }
    if (analysis.failures.length > MAX_ROWS) {
      lines.push(`| _\u2026and ${analysis.failures.length - MAX_ROWS} more_ | |`);
    }
    lines.push("");
    lines.push(...renderMessages(analysis.failures));
  }
  if (analysis.fixed.length > 0) lines.push(...renderFixed(analysis.fixed, context));
  if (analysis.slower.length > 0) lines.push(...renderSlower(analysis.slower, context));
  if (analysis.missing.length > 0) lines.push(...renderMissing(analysis.missing, context));
  return lines;
}
function renderMissing(missing, context) {
  const count2 = missing.reduce((sum, group) => sum + group.ids.length, 0);
  const items = missing.flatMap(
    (group) => group.whole && group.group && group.ids.length > 1 ? [`- ${code(group.group)}: all ${group.ids.length} tests`] : group.ids.map((id) => `- ${code(id)}`)
  );
  const lines = [
    `\u{1F47B} **Missing:** ${plural(count2, "test")} of the latest run on ${branches(context)} did not run here. Deleted or renamed on purpose? Nothing to do. Otherwise, check that the test runner still finds ${count2 === 1 ? "it" : "them"}.`,
    "",
    ...items.slice(0, MAX_MISSING)
  ];
  if (items.length > MAX_MISSING) lines.push(`- _\u2026and ${items.length - MAX_MISSING} more_`);
  lines.push("");
  return lines;
}
function headline(analysis) {
  const failed = analysis.failures.length;
  if (failed === 0) {
    const retried = analysis.retried.length;
    const suffix = retried > 0 ? ` (${retried} only after a retry)` : "";
    return `${badge("passed", "\u2705", 32)} All ${plural(analysis.total - analysis.skipped, "test")} passed${suffix}`;
  }
  const yours = analysis.failures.filter((f) => f.verdict === "new" || f.verdict === "suspect").length;
  if (yours === 0) return `${badge("passed", "\u{1F7E2}", 32)} ${plural(failed, "test")} failed, none of them look like your fault`;
  return `${badge("new", "\u{1F534}", 32)} ${plural(failed, "test")} failed, ${yours} ${yours === 1 ? "looks" : "look"} related to this change`;
}
function quarantineNote(quarantined, markdown = true) {
  const reason = quarantined.reason ? `: ${markdown ? escapeHtml(quarantined.reason) : quarantined.reason}` : "";
  const note = `Quarantined by hand until ${quarantined.until}${reason}.`;
  return markdown ? `_${note}_` : note;
}
function plainExplanation(failure, context) {
  return explain(failure, context).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "");
}
function sinceCommit(since2) {
  const sha = `\`${since2.sha.slice(0, 7)}\``;
  const commit = since2.url ? `[${sha}](${since2.url})` : sha;
  return since2.change ? `${commit} from [${since2.change.ref}](${since2.change.url})` : commit;
}
function explain(failure, context) {
  const where = branches(context);
  switch (failure.verdict) {
    case "new":
      if (failure.usually) return `**New failure.** ${usualBehavior(failure, where)}, but this error was never seen there.`;
      return failure.trailingPasses > 0 ? `**New failure.** Passed the last ${plural(failure.trailingPasses, "run")} on ${where}.` : `**New failure.** No history for this test on ${where}.`;
    case "suspect":
      return `**Suspect.** Failed in isolation ${times(failure.isolatedFailures)} in the last ${plural(failure.runs, "run")} on ${where}.`;
    case "broken": {
      const since2 = failure.failingSince;
      if (failure.trailingFailures === 1) {
        return `**Already failing on ${where}.** The latest run there failed too${since2 ? `, on ${sinceCommit(since2)}` : ""}.`;
      }
      const streak = `**Already failing on ${where}.** Failed the last ${failure.trailingFailures} runs there${failure.confirmed ? ", too many in a row to be flakiness" : ""}.`;
      return since2 ? `${streak} Failing since ${sinceCommit(since2)}, on ${since2.at.slice(0, 10)}.` : streak;
    }
    case "flaky": {
      const parts = [];
      if (failure.failures > 0) parts.push(`failed ${failure.failures} of the last ${plural(failure.runs, "run")} on ${where}`);
      if (failure.retries > 0) parts.push(`passed only after a retry ${plural(failure.retries, "time")}`);
      if (failure.latestEvidence) {
        const day = failure.latestEvidence.at.slice(0, 10);
        parts.push(
          failure.latestEvidence.kind === "rerun" ? `passed when the same commit was re-run on ${day}` : `passed after a retry on ${day}`
        );
      }
      const detail = parts.length > 0 ? ` ${capitalize(parts.join("; "))}.` : "";
      return failure.confirmed ? `**Known flaky.**${detail}` : `**Probably flaky.**${detail}`;
    }
  }
}
function usualBehavior(failure, where) {
  switch (failure.usually) {
    case "flaky":
      return `${failure.confirmed ? "Known" : "Probably"} flaky on ${where}`;
    case "broken":
      return `Already failing on ${where}`;
    default:
      return `Failed in isolation ${times(failure.isolatedFailures)} on ${where}`;
  }
}
function renderMessages(failures) {
  const withMessages = failures.filter((f) => f.test.message).slice(0, MAX_MESSAGES);
  if (withMessages.length === 0) return [];
  return [
    "<details><summary>Failure messages</summary>",
    "",
    ...withMessages.flatMap((f) => [`${code(f.test.title)}`, `<pre>${escapeHtml(f.test.message ?? "")}</pre>`]),
    "</details>",
    ""
  ];
}
function renderFixed(fixed, context) {
  const lines = [
    `\u{1F6E0}\uFE0F **Fixed:** ${plural(fixed.length, "test")} failing on ${branches(context)} ${fixed.length === 1 ? "passes" : "pass"} in this run.`,
    "",
    ...fixed.slice(0, MAX_FIXED).map(
      (f) => `- ${code(f.test.title)}, ${f.trailingFailures === 1 ? "failed the latest run" : `failed the last ${f.trailingFailures} runs`} there${f.failingSince ? `, since ${sinceCommit(f.failingSince)}` : ""}`
    )
  ];
  if (fixed.length > MAX_FIXED) lines.push(`- _\u2026and ${fixed.length - MAX_FIXED} more_`);
  lines.push("");
  return lines;
}
function renderSlower(slower, context) {
  const lines = [
    `\u{1F422} **Slower:** ${plural(slower.length, "passing test")} took much longer than usual on ${branches(context)}.`,
    "",
    ...slower.slice(0, MAX_SLOWER).map((s) => `- ${code(s.test.title)}: ${duration(s.duration)}, usually ${duration(s.usual)}`)
  ];
  if (slower.length > MAX_SLOWER) lines.push(`- _\u2026and ${slower.length - MAX_SLOWER} more_`);
  lines.push("");
  return lines;
}
function duration(ms) {
  if (ms < 1e3) return `${ms} ms`;
  if (ms < 6e4) return `${(ms / 1e3).toFixed(1)} s`;
  const seconds = Math.round(ms / 1e3);
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  const minutes = Math.round(ms / 6e4);
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
function footer(retried, context) {
  const parts = [];
  if (retried.length > 0) {
    const names = retried.slice(0, 5).map((t) => code(t.title)).join(", ");
    const more = retried.length > 5 ? ` and ${retried.length - 5} more` : "";
    parts.push(`\u{1F501} Passed only after a retry: ${names}${more}`);
  }
  if (context.runUrl) parts.push(`[${context.runLink ?? "Workflow run"}](${context.runUrl})`);
  parts.push(`Reported by [notmyfault](${PROJECT_URL})`);
  return `<sub>${parts.join(" \xB7 ")}</sub>`;
}
function branches(context) {
  return context.trackedBranches.map((b) => `\`${b}\``).join(", ");
}
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
function times(n) {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}
function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
function code(value) {
  return `<code>${escapeHtml(value)}</code>`;
}
var ESCAPED = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "|": "&#124;",
  "[": "&#91;",
  "]": "&#93;",
  "(": "&#40;",
  ")": "&#41;",
  "*": "&#42;",
  _: "&#95;",
  "`": "&#96;",
  "~": "&#126;",
  "\\": "&#92;",
  "!": "&#33;"
};
function escapeHtml(value) {
  return value.replace(/[&<>"|[\]()*_`~\\!]/g, (char) => ESCAPED[char] ?? char);
}

// src/html-report.ts
var PROJECT_URL2 = "https://github.com/tashikomaaa/notmyfault";
function reportPath(key) {
  return `reports/${key}.html`;
}
function renderSuitePage(key, history, context) {
  const rows = Object.entries(history.tests).map(([id, test]) => ({ id, test, stats: computeStats(test, context.now, context.evidenceTtlDays), cost: estimateCost(test, history) })).filter(({ test, stats }) => test.outcomes.includes(FAIL) || test.outcomes.includes(RETRY) || stats.confirmed);
  rows.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || score(b.stats) - score(a.stats) || a.id.localeCompare(b.id));
  const total = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const costing = total > 0 ? ` Their failures and retries cost about ${duration(total)} of test time.` : "";
  const stable = Object.keys(history.tests).length - rows.length;
  const where = context.trackedBranches.map((branch) => `<code>${escapeHtml(branch)}</code>`).join(", ");
  const body = [
    `<p class="back"><a href="../index.html">All test suites</a></p>`,
    `<h1>${escapeHtml(key)}</h1>`,
    `<p class="lede">${history.runs} runs recorded on ${where}, last updated ${formatTime(history.updatedAt)}. ${plural2(rows.length, "unreliable test")} listed, ${plural2(stable, "stable test")} not listed.${costing}</p>`
  ];
  if (rows.length === 0) {
    body.push(`<p class="empty">No test failed or needed a retry in the remembered runs.</p>`);
  } else {
    body.push(
      `<div class="scroll"><table>`,
      `<thead><tr><th>Test</th><th>Verdict</th><th>Remembered runs, oldest first</th><th>Failed</th><th>Retried</th><th>Last failure</th><th>Proof of flakiness</th><th>Median duration</th><th>Estimated cost</th></tr></thead>`,
      `<tbody>`,
      ...rows.map(({ id, test, stats, cost }) => renderRow(id, test, stats, cost)),
      `</tbody></table></div>`,
      `<p class="legend"><i class="p"></i> passed <i class="r"></i> passed after a retry <i class="f"></i> failed</p>`
    );
  }
  return page(`notmyfault: ${key}`, body);
}
function renderIndexPage(keys, context) {
  const items = keys.map((key) => `<li><a href="${escapeAttribute(reportPath(key))}">${escapeHtml(key)}</a></li>`);
  return page("notmyfault: test history", [
    `<h1>Test history</h1>`,
    `<p class="lede">The tests notmyfault remembers on ${context.trackedBranches.map((branch) => `<code>${escapeHtml(branch)}</code>`).join(", ")}, one page per test suite.</p>`,
    `<ul class="suites">`,
    ...items,
    `</ul>`
  ]);
}
function renderRow(id, test, stats, cost) {
  const [label, tone] = verdict(stats);
  const outcomes = [...test.outcomes];
  const failed = outcomes.filter((outcome) => outcome === FAIL).length;
  const retried = outcomes.filter((outcome) => outcome === RETRY).length;
  const summary = `${outcomes.length - failed - retried} passed, ${retried} passed after a retry, ${failed} failed`;
  const timeline = outcomes.map((outcome) => `<i class="${outcome === FAIL ? "f" : outcome === RETRY ? "r" : "p"}"></i>`).join("");
  const proof = stats.latestEvidence ? `${stats.latestEvidence.kind === "rerun" ? "Passed on re-run" : "Passed after a retry"}, ${stats.latestEvidence.at.slice(0, 10)}` : "";
  const durations = test.durations ?? [];
  return [
    `<tr>`,
    `<td class="test"><code>${escapeHtml(id)}</code></td>`,
    `<td><span class="verdict ${tone}">${label}</span>${tone === "broken" && stats.failingSince ? since(stats.failingSince) : ""}</td>`,
    `<td><span class="timeline" role="img" aria-label="${summary}">${timeline}</span></td>`,
    `<td class="number">${failed}</td>`,
    `<td class="number">${retried}</td>`,
    `<td>${lastFailure(test) ?? ""}</td>`,
    `<td>${proof}</td>`,
    `<td class="number">${durations.length > 0 ? duration(median2(durations)) : ""}</td>`,
    `<td class="number">${cost === void 0 ? "" : duration(cost)}</td>`,
    `</tr>`
  ].join("");
}
function since(failing) {
  const sha = `<code>${escapeHtml(failing.sha.slice(0, 7))}</code>`;
  const commit = failing.url ? `<a href="${escapeAttribute(failing.url)}">${sha}</a>` : sha;
  const change = failing.change ? ` from <a href="${escapeAttribute(failing.change.url)}">${escapeHtml(failing.change.ref)}</a>` : "";
  return `<span class="since">since ${commit}${change}, ${failing.at.slice(0, 10)}</span>`;
}
function verdict(stats) {
  switch (verdictFor(stats)) {
    case "broken":
      return ["Already failing", "broken"];
    case "flaky":
      return stats.confirmed ? ["Known flaky", "flaky"] : ["Probably flaky", "flaky"];
    case "suspect":
      return ["Suspect", "suspect"];
    default:
      return ["Passing again", "passed"];
  }
}
function score(stats) {
  const unreliable = (stats.failures + stats.retries) / Math.max(stats.runs, 1);
  return unreliable + (stats.confirmed || stats.trailingFailures > 0 ? 1 : 0);
}
function lastFailure(test) {
  const days = [test.lastFailure, ...(test.evidence ?? []).map((evidence) => evidence.at.slice(0, 10))];
  return days.filter((day) => day !== void 0).sort().at(-1);
}
function median2(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
function formatTime(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
function plural2(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --page: #ffffff; --ink: #1f2328; --muted: #59636e; --line: #d1d9e0; --code: rgb(129 139 152 / 0.12);
  --new: #dc4444; --suspect: #f26514; --broken: #2d3137; --on-broken: #fff; --flaky: #fcbd34; --passed: #19a08e; --link: #0a665c; }
@media (prefers-color-scheme: dark) { :root { --page: #0d1117; --ink: #f0f6fc; --muted: #9198a1; --line: #3d444d; --code: rgb(101 108 118 / 0.3); --broken: #9198a1; --on-broken: #1f2328; --link: #5ed6c7; } }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 90rem; margin: 0 auto; padding: 2rem 1rem 3rem; }
h1 { margin: 0.5rem 0; font-size: 1.75rem; }
a { color: var(--link); }
code { font: 0.85em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 0.1em 0.3em; border-radius: 0.3em; background: var(--code); }
.lede, .back, .legend, footer { color: var(--muted); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin-top: 1.5rem; }
th, td { padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; white-space: nowrap; }
th { font-size: 0.8rem; color: var(--muted); }
td.test { white-space: normal; min-width: 18rem; }
.number { text-align: right; font-variant-numeric: tabular-nums; }
/* Text colors keep every chip at a contrast of 4.5:1 or more. */
.verdict { display: inline-block; padding: 0.1rem 0.55rem; border-radius: 1rem; color: #1f2328; font-size: 0.8rem; font-weight: 600; }
.verdict.new { background: #c93c3c; color: #fff; } .verdict.broken { background: var(--broken); color: var(--on-broken); }
.since { display: block; margin-top: 0.25rem; color: var(--muted); font-size: 0.8rem; }
.verdict.suspect { background: var(--suspect); } .verdict.flaky { background: var(--flaky); } .verdict.passed { background: var(--passed); }
.timeline { display: inline-flex; gap: 1px; }
i { display: inline-block; width: 5px; height: 16px; border-radius: 1px; }
i.p { background: var(--passed); opacity: 0.45; } i.r { background: var(--flaky); } i.f { background: var(--new); }
.legend i { vertical-align: middle; margin-left: 0.75rem; }
.suites { font-size: 1.1rem; }
footer { margin-top: 2rem; font-size: 0.85rem; }
</style>
</head>
<body>
<main>
${body.join("\n")}
<footer>Generated by <a href="${PROJECT_URL2}">notmyfault</a>, rewritten on every update of the history.</footer>
</main>
</body>
</html>
`;
}

// src/flaky-issues.ts
import { createHash as createHash2 } from "node:crypto";
var FLAKY_LABEL = { name: "flaky-test", color: "fcbd34", description: "A test notmyfault found flaky" };
var QUIET_DAYS = 30;
var MAX_CREATED_PER_RUN = 5;
var DAY_MS3 = 24 * 60 * 60 * 1e3;
var MAX_TITLE_LENGTH = 200;
var QUARANTINE_URL = "https://github.com/tashikomaaa/notmyfault/blob/main/docs/quarantine.md";
function flakyMarker(key, id) {
  const hash = createHash2("sha256").update(id).digest("hex").slice(0, 12);
  return `<!-- notmyfault:flaky:${key}:${hash} -->`;
}
function planFlakyIssues(suites, issues, context) {
  const byMarker = /* @__PURE__ */ new Map();
  for (const issue of issues) {
    const marker = /<!-- notmyfault:flaky:\S+ -->/.exec(issue.body)?.[0];
    if (marker && !byMarker.has(marker)) byMarker.set(marker, issue);
  }
  const renamed = /* @__PURE__ */ new Set();
  for (const suite of suites) {
    for (const { from, to } of suite.renames ?? []) {
      const issue = byMarker.get(flakyMarker(suite.key, from));
      if (!issue || byMarker.has(flakyMarker(suite.key, to))) continue;
      byMarker.delete(flakyMarker(suite.key, from));
      byMarker.set(flakyMarker(suite.key, to), issue);
      renamed.add(flakyMarker(suite.key, to));
    }
  }
  const actions = [];
  const seen = /* @__PURE__ */ new Set();
  let created = 0;
  let postponed = 0;
  for (const suite of suites) {
    const results = new Map(suite.results.map((result) => [result.id, result]));
    for (const [id, test] of Object.entries(suite.history.tests)) {
      const marker = flakyMarker(suite.key, id);
      seen.add(marker);
      const issue = byMarker.get(marker);
      const lastFailure2 = lastFailureDay(test);
      const recent = lastFailure2 !== void 0 && context.now.getTime() - Date.parse(lastFailure2) < QUIET_DAYS * DAY_MS3;
      const result = results.get(id);
      const failedNow = result?.outcome === "failed" || result?.outcome === "flaky";
      const stats = computeStats(test, context.now, context.evidenceTtlDays);
      const body = () => renderFlakyIssue(suite.key, id, test, stats, result, context);
      const moved = renamed.has(marker);
      const retitle = moved ? { title: issueTitle(result?.title ?? id) } : {};
      if (issue?.state === "open") {
        if (!recent) actions.push({ kind: "close", issue: issue.number, comment: quietComment(lastFailure2, context) });
        else if (failedNow || moved) actions.push({ kind: "update", issue: issue.number, body: body(), reopen: false, ...retitle });
        continue;
      }
      if (issue) {
        const reopen = stats.confirmed && recent && failedNow;
        if (reopen || moved) actions.push({ kind: "update", issue: issue.number, body: body(), reopen, ...retitle });
        continue;
      }
      if (!stats.confirmed || !recent) continue;
      if (created === MAX_CREATED_PER_RUN) {
        postponed++;
      } else {
        created++;
        actions.push({ kind: "create", title: issueTitle(result?.title ?? id), body: body() });
      }
    }
  }
  for (const [marker, issue] of byMarker) {
    const key = marker.slice("<!-- notmyfault:flaky:".length).split(":")[0];
    if (issue.state !== "open" || seen.has(marker) || !suites.some((suite) => suite.key === key)) continue;
    actions.push({
      kind: "close",
      issue: issue.number,
      comment: `This test is no longer in the history of ${branches2(context)}: it was renamed, removed, or not run for 90 days. Closing this issue.`
    });
  }
  return { actions, postponed };
}
function renderFlakyIssue(key, id, test, stats, result, context) {
  const where = branches2(context);
  const retries = stats.retries > 0 ? `, and passed only after a retry ${times2(stats.retries)}` : "";
  const lines = [
    flakyMarker(key, id),
    `notmyfault found this test flaky on ${where}. It keeps this issue up to date, and closes it after ${QUIET_DAYS} days without a failure there.`,
    "",
    `- **Test:** ${code(result?.title ?? id)}`,
    `- **Suite:** \`${key}\``,
    ...owners(result, context),
    `- **Verdict on ${where}:** ${verdict2(stats)}`,
    `- **Runs on ${where}:** failed ${stats.failures} of the last ${plural3(stats.runs, "run")}${retries}`,
    `- **Last failure:** ${lastFailureDay(test) ?? "unknown"}`
  ];
  if (stats.latestEvidence) {
    const day = stats.latestEvidence.at.slice(0, 10);
    lines.push(
      `- **Proof:** ${stats.latestEvidence.kind === "rerun" ? "passed when the same commit was re-run" : "passed after a retry"} on ${day}`
    );
  }
  if (result?.outcome === "failed" || result?.outcome === "flaky") lines.push("", latestFailure(result, context));
  lines.push("", `Until it is fixed, [quarantine mode](${QUARANTINE_URL}) keeps it from blocking ${context.pullRequest ?? "pull request"}s.`);
  return lines.join("\n");
}
function owners(result, context) {
  const found = result && context.owners ? context.owners(result) : [];
  return found.length > 0 ? [`- **Owners:** ${found.join(" ")}`] : [];
}
function latestFailure(result, context) {
  const run3 = context.runUrl ? `, in [this ${context.runName ?? "workflow run"}](${context.runUrl})` : "";
  const what = result.outcome === "flaky" ? "Latest retry" : "Latest failure";
  const message = result.message ? `<pre>${escapeHtml(result.message)}</pre>` : "_The report has no failure message._";
  return [`**${what}**, on commit \`${context.sha.slice(0, 12)}\`${run3}:`, "", message].join("\n");
}
function verdict2(stats) {
  switch (verdictFor(stats)) {
    case "broken":
      return `already failing, failed the last ${plural3(stats.trailingFailures, "run")}${stats.failingSince ? ` since ${sinceCommit(stats.failingSince)}` : ""}`;
    case "flaky":
      return stats.confirmed ? "known flaky" : "probably flaky";
    case "suspect":
      return "suspect";
    default:
      return "passing again";
  }
}
function lastFailureDay(test) {
  const days = [test.lastFailure, ...(test.evidence ?? []).map((evidence) => evidence.at.slice(0, 10))];
  return days.filter((day) => day !== void 0).sort().at(-1);
}
function quietComment(lastFailure2, context) {
  const since2 = lastFailure2 ? ` since ${lastFailure2}` : "";
  return `No failure on ${branches2(context)}${since2}, for more than ${QUIET_DAYS} days: closing this issue. notmyfault reopens it if the test fails again.`;
}
function issueTitle(title) {
  const short = title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}\u2026` : title;
  return `Flaky test: ${short}`;
}
function branches2(context) {
  return context.trackedBranches.map((branch) => `\`${branch}\``).join(", ");
}
function plural3(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
function times2(n) {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

// src/quarantine.ts
var LINE = /^(\d{4}-\d{2}-\d{2})\s+(.+?)(?:\s+#\s+(.*))?$/;
function parseQuarantine(input, label = 'Input "quarantine"') {
  const entries = [];
  for (const line of input.split("\n").map((part) => part.trim()).filter(Boolean)) {
    const match = LINE.exec(line);
    const until = match?.[1];
    if (!match || !until || Number.isNaN(Date.parse(`${until}T00:00:00Z`)) || (/* @__PURE__ */ new Date(`${until}T00:00:00Z`)).toISOString().slice(0, 10) !== until) {
      throw new Error(`${label} expects "YYYY-MM-DD test name # reason" per line, got "${line}"`);
    }
    const entry = { pattern: match[2].trim(), until };
    if (match[3]?.trim()) entry.reason = match[3].trim();
    entries.push(entry);
  }
  return entries;
}
function isActive(entry, now) {
  return now.toISOString().slice(0, 10) <= entry.until;
}
function matches(entry, test) {
  const escaped = entry.pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?:^|\\s\u203A\\s)${escaped.join(".*")}$`);
  return pattern.test(test.title) || pattern.test(test.id);
}
function applyQuarantine(analysis, entries, now) {
  const active = entries.filter((entry) => isActive(entry, now));
  let quarantined = 0;
  for (const failure of analysis.failures) {
    const entry = active.find((candidate) => matches(candidate, failure.test));
    if (!entry) continue;
    failure.quarantined = entry.reason ? { until: entry.until, reason: entry.reason } : { until: entry.until };
    quarantined++;
  }
  return quarantined;
}

// src/renames.ts
var MIN_SIMILARITY = 0.6;
var SEPARATOR2 = " \u203A ";
function detectRenames(history, results) {
  const previousRun = history.runs;
  if (previousRun === 0) return [];
  const present = new Set(results.map((result) => result.id));
  const groups = /* @__PURE__ */ new Map();
  const group = (id) => {
    const key = prefix(id);
    let entry = groups.get(key);
    if (!entry) groups.set(key, entry = { missing: [], added: [] });
    return entry;
  };
  for (const [id, test] of Object.entries(history.tests)) {
    if (test.lastRun === previousRun && !present.has(id)) group(id).missing.push(id);
  }
  for (const result of results) {
    const known = history.tests[result.id]?.outcomes;
    if (result.outcome !== "skipped" && !known) group(result.id).added.push(result.id);
  }
  const renames = [];
  for (const { missing, added } of groups.values()) {
    if (missing.length !== 1 || added.length !== 1) continue;
    const [from, to] = [missing[0], added[0]];
    if (similarity(lastPart(from), lastPart(to)) >= MIN_SIMILARITY) renames.push({ from, to });
  }
  return renames.sort((a, b) => a.to.localeCompare(b.to));
}
function applyRenames(history, renames) {
  for (const { from, to } of renames) {
    const test = history.tests[from];
    const target = history.tests[to];
    if (!test || target?.outcomes) continue;
    if (target) {
      const failedOn = [.../* @__PURE__ */ new Set([...test.failedOn ?? [], ...target.failedOn ?? []])].slice(-MAX_FAILED_ON);
      const evidence = [...test.evidence ?? [], ...target.evidence ?? []].sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_EVIDENCE);
      if (failedOn.length > 0) test.failedOn = failedOn;
      if (evidence.length > 0) test.evidence = evidence;
      if (target.lastSeen > test.lastSeen) test.lastSeen = target.lastSeen;
    }
    history.tests[to] = test;
    delete history.tests[from];
  }
}
function prefix(id) {
  const index = id.lastIndexOf(SEPARATOR2);
  return index === -1 ? "" : id.slice(0, index);
}
function lastPart(id) {
  const index = id.lastIndexOf(SEPARATOR2);
  return index === -1 ? id : id.slice(index + SEPARATOR2.length);
}
function similarity(a, b) {
  if (a === b) return 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

// src/xml.ts
var MAX_TEXT_LENGTH = 64 * 1024;
var NAMED_ENTITIES = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'"
};
var ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;
function decodeEntities(value) {
  if (!value.includes("&")) return value;
  return value.replace(ENTITY_RE, (match, body) => {
    if (body.startsWith("#")) {
      const code2 = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code2) && code2 >= 0 && code2 <= 1114111 ? String.fromCodePoint(code2) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}
function parseXml(input) {
  const root = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  const length = input.length;
  let i = input.charCodeAt(0) === 65279 ? 1 : 0;
  while (i < length) {
    const current = stack[stack.length - 1];
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      appendText(current, decodeEntities(input.slice(i)));
      break;
    }
    if (lt > i) appendText(current, decodeEntities(input.slice(i, lt)));
    if (input.startsWith("<!--", lt)) {
      i = skipPast(input, "-->", lt + 4);
    } else if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      appendText(current, input.slice(lt + 9, end === -1 ? length : end));
      i = end === -1 ? length : end + 3;
    } else if (input.startsWith("<?", lt)) {
      i = skipPast(input, "?>", lt + 2);
    } else if (input.startsWith("<!", lt)) {
      i = skipDeclaration(input, lt);
    } else if (input[lt + 1] === "/") {
      const end = input.indexOf(">", lt + 2);
      const name = input.slice(lt + 2, end === -1 ? length : end).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = end === -1 ? length : end + 1;
    } else {
      i = parseStartTag(input, lt, stack);
    }
  }
  return root;
}
function appendText(element, text) {
  if (element.text.length >= MAX_TEXT_LENGTH) return;
  element.text += text.slice(0, MAX_TEXT_LENGTH - element.text.length);
}
function skipPast(input, terminator, from) {
  const end = input.indexOf(terminator, from);
  return end === -1 ? input.length : end + terminator.length;
}
function skipDeclaration(input, lt) {
  let depth = 0;
  for (let j = lt + 2; j < input.length; j++) {
    const c = input[j];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ">" && depth <= 0) return j + 1;
  }
  return input.length;
}
function isSpace(c) {
  return c === " " || c === "\n" || c === "	" || c === "\r";
}
function parseStartTag(input, lt, stack) {
  const length = input.length;
  let j = lt + 1;
  while (j < length && !isSpace(input[j]) && input[j] !== ">" && input[j] !== "/") j++;
  const element = { name: input.slice(lt + 1, j), attrs: {}, children: [], text: "" };
  let selfClosing = false;
  while (j < length) {
    const c = input[j];
    if (c === ">") {
      j++;
      break;
    }
    if (c === "/" && input[j + 1] === ">") {
      selfClosing = true;
      j += 2;
      break;
    }
    if (isSpace(c)) {
      j++;
      continue;
    }
    const nameStart = j;
    while (j < length && input[j] !== "=" && input[j] !== ">" && !isSpace(input[j]) && !(input[j] === "/" && input[j + 1] === ">")) {
      j++;
    }
    const attrName = input.slice(nameStart, j);
    while (j < length && isSpace(input[j])) j++;
    if (input[j] !== "=") {
      if (attrName) element.attrs[attrName] = "";
      continue;
    }
    j++;
    while (j < length && isSpace(input[j])) j++;
    const quote = input[j];
    if (quote === '"' || quote === "'") {
      const end = input.indexOf(quote, j + 1);
      const stop = end === -1 ? length : end;
      element.attrs[attrName] = decodeEntities(input.slice(j + 1, stop));
      j = stop + 1;
    } else {
      const valueStart = j;
      while (j < length && !isSpace(input[j]) && input[j] !== ">") j++;
      element.attrs[attrName] = decodeEntities(input.slice(valueStart, j));
    }
  }
  stack[stack.length - 1].children.push(element);
  if (!selfClosing) stack.push(element);
  return j;
}

// src/junit.ts
var MAX_MESSAGE_LENGTH = 300;
var MAX_REFERENCES = 20;
var REFERENCE = /(?:^|[\s(['"])((?:[\w@.-]+\/|\/)*[\w@-][\w@.-]*\.[a-z][a-z0-9]{0,5}):(\d+)/gi;
function parseJUnit(xml) {
  const root = [];
  const groups = [root];
  collect(parseXml(xml), { name: "" }, root, groups);
  return combineReports(groups.map(mergeAttempts));
}
function combineReports(reports) {
  const byId = /* @__PURE__ */ new Map();
  for (const report of reports) {
    for (const result of report) {
      const previous = byId.get(result.id);
      if (!previous || severity(result.outcome) > severity(previous.outcome)) {
        byId.set(result.id, result);
      }
    }
  }
  return [...byId.values()];
}
function severity(outcome) {
  return { skipped: 0, passed: 1, flaky: 2, failed: 3 }[outcome];
}
function collect(element, suite, group, groups) {
  for (const child of element.children) {
    if (child.name === "testsuite") {
      const suiteGroup = [];
      groups.push(suiteGroup);
      const file = child.attrs.file ?? suite.file;
      collect(child, { name: child.attrs.name ?? suite.name, ...file ? { file } : {} }, suiteGroup, groups);
    } else if (child.name === "testcase") {
      const result = toResult(child, suite);
      if (result) group.push(result);
    } else {
      collect(child, suite, group, groups);
    }
  }
}
function toResult(testcase, suite) {
  const name = normalize(testcase.attrs.name ?? "");
  if (!name) return void 0;
  const classname = normalize(testcase.attrs.classname ?? "");
  const failures = [];
  const flakyAttempts = [];
  let skipped = false;
  for (const child of testcase.children) {
    switch (child.name) {
      case "failure":
      case "error":
        failures.push(child);
        break;
      // Maven Surefire and cargo-nextest report retried tests this way.
      case "flakyFailure":
      case "flakyError":
        flakyAttempts.push(child);
        break;
      case "skipped":
        skipped = true;
        break;
    }
  }
  let outcome;
  if (failures.length > 0) outcome = "failed";
  else if (skipped) outcome = "skipped";
  else if (flakyAttempts.length > 0) outcome = "flaky";
  else outcome = "passed";
  const result = {
    id: joinDistinct([normalize(suite.name), classname, name]),
    title: joinDistinct([classname || normalize(suite.name), name]),
    outcome
  };
  const message = firstMessage(failures[0] ?? flakyAttempts[0]);
  if (message) result.message = message;
  const seconds = Number(testcase.attrs.time);
  if (testcase.attrs.time?.trim() && Number.isFinite(seconds) && seconds >= 0) result.duration = Math.round(seconds * 1e3);
  if (outcome !== "skipped") {
    const hints = locationHints(testcase, suite, failures);
    if (hints.file || hints.names.length > 0 || hints.references.length > 0) result.hints = hints;
  }
  return result;
}
function locationHints(testcase, suite, failures) {
  const hints = {
    names: [...new Set([testcase.attrs.classname ?? "", suite.name].map(normalize).filter(Boolean))],
    references: []
  };
  const file = testcase.attrs.file ?? suite.file;
  if (file) hints.file = file;
  const line = Number(testcase.attrs.line);
  if (Number.isInteger(line) && line > 0) hints.line = line;
  for (const failure of failures) {
    for (const match of `${failure.attrs.message ?? ""}
${failure.text}`.matchAll(REFERENCE)) {
      if (hints.references.length === MAX_REFERENCES) return hints;
      hints.references.push({ file: match[1], line: Number(match[2]) });
    }
  }
  return hints;
}
function mergeAttempts(results) {
  const byId = /* @__PURE__ */ new Map();
  for (const result of results) {
    const previous = byId.get(result.id);
    byId.set(result.id, previous ? mergeAttempt(previous, result) : result);
  }
  return [...byId.values()];
}
function mergeAttempt(previous, next) {
  if (next.outcome === "skipped") return previous;
  if (previous.outcome === "skipped" || next.outcome === "failed") return next;
  if (previous.outcome === "failed" || previous.outcome === "flaky" || next.outcome === "flaky") {
    const merged = { ...next, outcome: "flaky" };
    const message = next.message ?? previous.message;
    if (message) merged.message = message;
    return merged;
  }
  return next;
}
function firstMessage(element) {
  if (!element) return void 0;
  const raw = element.attrs.message || element.text;
  const line = raw.split("\n").map((part) => part.trim()).find((part) => part.length > 0);
  if (!line) return void 0;
  return line.length > MAX_MESSAGE_LENGTH ? `${line.slice(0, MAX_MESSAGE_LENGTH - 1)}\u2026` : line;
}
function normalize(value) {
  return value.replace(/\s+/g, " ").trim();
}
function joinDistinct(parts) {
  const kept = [];
  for (const part of parts) {
    if (part && part !== kept[kept.length - 1]) kept.push(part);
  }
  return kept.join(" \u203A ");
}

// src/locate.ts
import { posix } from "node:path";
function locate(test, workspace, exists) {
  const hints = test.hints;
  if (!hints) return void 0;
  const found = (path) => {
    const relative2 = toRelative(path, workspace);
    return relative2 !== void 0 && exists(relative2) ? relative2 : void 0;
  };
  const candidates = [...hints.file ? [hints.file] : [], ...hints.names.flatMap(fileNames)];
  for (const candidate of candidates) {
    const file = found(candidate);
    if (!file) continue;
    const line = candidate === hints.file && hints.line ? hints.line : hints.references.find((reference) => sameFile(reference.file, file, workspace))?.line;
    return line ? { file, line } : { file };
  }
  for (const reference of hints.references) {
    const file = found(reference.file);
    if (file) return { file, line: reference.line };
  }
  return void 0;
}
function fileNames(name) {
  if (!/^[\w$]+(\.[\w$]+)+$/.test(name)) return [name];
  const path = name.replace(/\./g, "/");
  return [name, `${path}.py`, `src/test/java/${path}.java`, `src/test/kotlin/${path}.kt`];
}
function toRelative(path, workspace) {
  let relative2 = path.replace(/\\/g, "/");
  if (relative2.startsWith("/")) {
    const root = `${workspace.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
    if (!relative2.startsWith(root)) return void 0;
    relative2 = relative2.slice(root.length);
  }
  relative2 = posix.normalize(relative2);
  const parts = relative2.split("/");
  if (relative2 === "." || parts[0] === ".." || parts.includes("node_modules") || /^[a-z]:/i.test(relative2)) return void 0;
  return relative2;
}
function sameFile(reference, file, workspace) {
  const relative2 = toRelative(reference, workspace);
  return relative2 !== void 0 && (relative2 === file || file.endsWith(`/${relative2}`));
}

// src/codeowners.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
function parseCodeowners(text) {
  const rules = [];
  let section = 0;
  let defaults = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\^?\[[^\]]+\](?:\[\d+\])?\s*(.*)$/.exec(line);
    if (header) {
      section++;
      defaults = mentions(header[1].split(/\s+/));
      continue;
    }
    const [pattern, ...owners2] = line.split(/\s+/);
    const listed = mentions(owners2);
    rules.push({ section, pattern: toRegExp(pattern), owners: owners2.length > 0 ? listed : defaults });
  }
  return rules;
}
function ownersOf(path, rules) {
  const bySection = /* @__PURE__ */ new Map();
  for (const rule of rules) if (rule.pattern.test(path)) bySection.set(rule.section, rule.owners);
  return [...new Set([...bySection.values()].flat())];
}
function readCodeowners(workspace, paths) {
  for (const path of paths) {
    try {
      return { path, rules: parseCodeowners(readFileSync2(join2(workspace, path), "utf8")) };
    } catch {
    }
  }
  return void 0;
}
function mentions(tokens) {
  return tokens.filter((token) => /^@[\w.\-/]+$/.test(token));
}
function toRegExp(pattern) {
  const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
  const directory = pattern.endsWith("/");
  let body = pattern.replace(/^\//, "").replace(/\/$/, "");
  const shallow = /(^|\/)\*$/.test(body);
  let source = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "*" && body[i + 1] === "*") {
      if (body[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i++;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  body = source;
  const end = directory ? "/" : shallow ? "$" : "(?:$|/)";
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}${end}`);
}

// src/main.ts
var EVIDENCE_TTL_DAYS = 30;
var RETENTION_DAYS = 90;
var RANKING_SIZE = 10;
var TRENDS = 3;
var MAX_ANNOTATIONS_PER_LEVEL = 10;
var RERUN_MARKER = "notmyfault: only flaky tests failed";
var VERDICTS = ["new", "suspect", "broken", "flaky"];
var BRANCH_README = `# notmyfault history

This branch is maintained by [notmyfault](https://github.com/tashikomaaa/notmyfault).
It stores the recent outcome of each test, so failures can be told apart: new, flaky or already broken.

- \`history/<key>.json\`: the history of a test suite.
- \`badges/<key>.json\`: a [shields.io endpoint](https://shields.io/badges/endpoint-badge) counting its flaky tests.
- \`reports/<key>.html\` and \`index.html\`: pages listing its unreliable tests, to publish as a static site.

The branch is rewritten as a single commit on every update. Deleting it simply resets the history.
`;
async function run2(env = process.env, io = new ActionIO(env), now = /* @__PURE__ */ new Date()) {
  let platform;
  try {
    platform = env.FORGEJO_ACTIONS === "true" || env.GITEA_ACTIONS === "true" ? forgejoPlatform(env, io) : githubPlatform(env, io);
  } catch (error) {
    io.error(errorMessage(error));
    return 1;
  }
  return runOn(platform, now);
}
async function runOn(platform, now = /* @__PURE__ */ new Date()) {
  const { context, io } = platform;
  try {
    const settings = readSettings(platform);
    io.mask(settings.token);
    const loaded = [];
    for (const suite of settings.suites) {
      const results = await loadResults(suite, settings.suites.length > 1, context.workspace, io);
      if (!results) return 1;
      loaded.push({ ...suite, results });
    }
    const store = new GitStore({
      remoteUrl: `${context.serverUrl}/${context.repository}.git`,
      branch: settings.branch,
      token: settings.token,
      username: platform.gitUser(settings.token),
      author: platform.gitAuthor,
      pushOptions: platform.pushOptions,
      ...context.tempDir ? { tempDir: context.tempDir } : {}
    });
    try {
      return await evaluate(loaded, platform, settings, store, now);
    } finally {
      await store.dispose();
    }
  } catch (error) {
    io.error(errorMessage(error));
    return 1;
  } finally {
    io.finish();
  }
}
async function evaluate(loaded, platform, settings, store, now) {
  const { context, io } = platform;
  const suites = [];
  const tracked = isTracked(context, settings);
  for (const suite of loaded) {
    const history = await loadHistory(store, historyPath(suite.key), settings, io);
    const renames = tracked ? detectRenames(history, suite.results) : [];
    applyRenames(history, renames);
    const analysis = analyze(suite.results, history, now, EVIDENCE_TTL_DAYS);
    if (!settings.missingTests) analysis.missing = [];
    suites.push({ ...suite, history, renames, analysis });
  }
  const named = suites.length > 1;
  for (const entry of settings.quarantine.filter((candidate) => !isActive(candidate, now))) {
    io.warning(
      `The quarantine of "${entry.pattern}" expired on ${entry.until}: remove it, or push the date back if the test is still unreliable.`
    );
  }
  const quarantined = suites.reduce((total, suite) => total + applyQuarantine(suite.analysis, settings.quarantine, now), 0);
  const sum = (count3) => suites.reduce((total, suite) => total + count3(suite.analysis), 0);
  const failures = suites.flatMap((suite) => suite.analysis.failures);
  const blocking = suites.flatMap((suite) => blockingFailures(suite.analysis, settings.tolerated));
  const reportContext = {
    key: settings.commentKey,
    trackedBranches: settings.trackedBranches,
    historyRuns: suites[0].history.runs,
    mode: settings.mode,
    tolerated: settings.tolerated,
    blocking: blocking.length,
    quarantined,
    runLink: platform.text.runLink,
    ...context.runUrl ? { runUrl: context.runUrl } : {}
  };
  for (const { key, analysis } of suites) {
    io.group(
      `notmyfault${named ? ` ${key}` : ""}: ${analysis.failures.length} failed, ${analysis.retried.length} retried, ${analysis.fixed.length} fixed, ${analysis.total} total`
    );
    for (const failure of analysis.failures) {
      const reason = failure.usually ? ` (${failure.usually} on ${settings.trackedBranches.join(", ")}, but with a new error)` : "";
      const byHand = failure.quarantined ? ` (quarantined until ${failure.quarantined.until})` : "";
      const since2 = failure.verdict === "broken" && failure.failingSince ? ` (failing since ${failure.failingSince.sha.slice(0, 7)})` : "";
      io.info(`${failure.verdict.padEnd(8)} ${failure.test.title}${since2}${reason}${byHand}`);
    }
    for (const test of analysis.retried) io.info(`retried  ${test.title}`);
    for (const fixed of analysis.fixed) io.info(`fixed    ${fixed.test.title}`);
    for (const slow of analysis.slower) io.info(`slower   ${slow.test.title} (${duration(slow.duration)}, usually ${duration(slow.usual)})`);
    for (const group of analysis.missing) {
      if (group.whole && group.group && group.ids.length > 1) io.info(`missing  ${group.group} (all ${group.ids.length} tests)`);
      else for (const id of group.ids) io.info(`missing  ${id}`);
    }
    io.endGroup();
  }
  const onlyFlaky = platform.rerunNotice && failures.length > 0 && failures.every((failure) => failure.verdict === "flaky");
  if (onlyFlaky) {
    io.annotation(
      "notice",
      "Every failed test is known or probably flaky: re-running the failed jobs can prove it and unblock this run.",
      { title: RERUN_MARKER }
    );
  }
  if (settings.annotations) annotate(failures, reportContext, context.workspace, io, onlyFlaky ? 1 : 0);
  if (settings.record) {
    const commit = tracked && !context.pullRequest?.fromFork ? await describeCommit(suites, platform, settings) : void 0;
    for (const suite of suites) await recordHistory(store, suite.key, suite.results, platform, settings, now, commit);
  }
  for (const { renames } of suites) for (const { from, to } of renames) io.info(`renamed  ${from} \u2192 ${to}`);
  if (settings.flakyIssues && isTracked(context, settings) && !context.pullRequest?.fromFork) {
    await manageFlakyIssues(suites, platform, settings, now);
  }
  if (settings.rerunFlaky && rerunWorthIt(failures, blocking, settings)) {
    const url = await rerun(platform, settings);
    if (url) reportContext.rerunUrl = url;
  }
  const reports = suites.map((suite) => {
    const ranking = rankFlakyTests(suite.history, now, EVIDENCE_TTL_DAYS, RANKING_SIZE);
    return {
      name: suite.key,
      analysis: suite.analysis,
      historyRuns: suite.history.runs,
      ranking,
      slowest: rankSlowTests(suite.history, RANKING_SIZE),
      trends: failureTrends(suite.history, ranking.slice(0, TRENDS).map((test) => test.id)),
      renames: suite.renames
    };
  });
  io.appendSummary(renderSuitesSummary(reports, reportContext));
  if (settings.comment && context.pullRequest) {
    const noteworthy = sum((a) => a.failures.length + a.retried.length + a.fixed.length + a.missing.length) > 0;
    await comment(platform, settings, renderSuitesComment(reports, reportContext), noteworthy);
  }
  if (settings.check) await reportCheck(settings.check, platform, settings, renderCheck(reports, reportContext), blocking.length === 0);
  const count2 = (verdicts) => failures.filter((f) => verdicts.includes(f.verdict)).length;
  io.setOutput("total", sum((a) => a.total));
  io.setOutput("failed", failures.length);
  io.setOutput("new-failures", count2(["new", "suspect"]));
  io.setOutput("flaky-failures", count2(["flaky"]));
  io.setOutput("broken-failures", count2(["broken"]));
  io.setOutput("retried", sum((a) => a.retried.length));
  io.setOutput("fixed", sum((a) => a.fixed.length));
  io.setOutput("slower", sum((a) => a.slower.length));
  io.setOutput("missing", sum((a) => a.missing.reduce((total, group) => total + group.ids.length, 0)));
  io.setOutput("quarantined", quarantined);
  io.setOutput("blocking", blocking.length);
  if (settings.mode === "quarantine" && blocking.length > 0) {
    const names = blocking.slice(0, 5).map((f) => f.test.title).join(", ");
    io.error(`${blocking.length} failing test(s) are not tolerated in quarantine mode: ${names}`);
    return 1;
  }
  return 0;
}
function readSettings(platform) {
  const { context, io } = platform;
  const suites = readSuites(io, context.defaultKey);
  const mode = io.input("mode", "report");
  if (mode !== "report" && mode !== "quarantine") {
    throw new Error(`${io.describeInput("mode")} must be "report" or "quarantine", got "${mode}"`);
  }
  const tolerated = /* @__PURE__ */ new Set();
  for (const value of splitList(io.input("tolerate", "flaky"))) {
    if (!VERDICTS.includes(value)) {
      throw new Error(`${io.describeInput("tolerate")} accepts ${VERDICTS.join(", ")}; got "${value}"`);
    }
    tolerated.add(value);
  }
  const quarantine = parseQuarantine(io.input("quarantine"), io.describeInput("quarantine"));
  const token = io.input("token") || context.defaultToken;
  if (!token) throw new Error(platform.text.tokenMissing);
  return {
    suites,
    mode,
    tolerated,
    quarantine,
    token,
    branch: io.input("history-branch", "notmyfault-history"),
    trackedBranches: splitList(io.input("track-branches", context.defaultBranch ?? "main")),
    commentKey: suites.map((suite) => suite.key).join("+"),
    comment: io.booleanInput("comment", true),
    annotations: io.booleanInput("annotations", true),
    flakyIssues: io.booleanInput("flaky-issues", false),
    missingTests: io.booleanInput("missing-tests", true),
    ...io.booleanInput("check", false) ? { check: io.input("check-name", "notmyfault") } : {},
    rerunFlaky: io.booleanInput("rerun-flaky", false),
    mentionOwners: io.booleanInput("mention-owners", false),
    record: io.booleanInput("record", true),
    window: io.integerInput("window", 50, 5)
  };
}
function readSuites(io, defaultKey) {
  const list = io.input("suites");
  if (!list) {
    const patterns = splitList(io.input("junit"));
    if (patterns.length === 0) {
      throw new Error(
        `${io.describeInput("junit")} is required: a glob matching your JUnit XML reports. Or list several suites in ${io.inputName("suites")}.`
      );
    }
    return [{ key: sanitizeKey(io.input("key", defaultKey)), patterns }];
  }
  if (io.input("junit") || io.input("key")) {
    throw new Error(
      `${io.describeInputs(["junit", "key"])} cannot be used with ${io.inputName("suites")}: name each suite and its reports in ${io.inputName("suites")}.`
    );
  }
  const suites = [];
  for (const line of list.split("\n").map((part) => part.trim()).filter(Boolean)) {
    const match = /^([^:]+):(.*)$/.exec(line);
    const patterns = splitList(match?.[2] ?? "");
    if (!match || patterns.length === 0) throw new Error(`${io.describeInput("suites")} expects one "name: glob" per line, got "${line}"`);
    const key = sanitizeKey(match[1]);
    if (suites.some((suite) => suite.key === key)) throw new Error(`${io.describeInput("suites")} names the suite "${key}" twice.`);
    suites.push({ key, patterns });
  }
  return suites;
}
function sanitizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "default";
}
async function loadResults(suite, named, workspace, io) {
  const of = named ? ` for ${suite.key}` : "";
  const files = await findFiles(suite.patterns, workspace);
  if (files.length === 0) {
    io.error(`No JUnit report matched ${suite.patterns.map((p) => `"${p}"`).join(", ")}${of} in ${workspace}.`);
    return void 0;
  }
  const reports = [];
  for (const file of files) {
    try {
      reports.push(parseJUnit(await readFile(file, "utf8")));
    } catch (error) {
      io.warning(`Skipping ${relative(workspace, file)}: ${errorMessage(error)}`);
    }
  }
  const results = combineReports(reports);
  if (results.length === 0) {
    io.error(`The ${files.length} matched report(s)${of} contain no test cases.`);
    return void 0;
  }
  io.info(`Read ${results.length} tests from ${files.length} report(s)${of}.`);
  return results;
}
async function findFiles(patterns, workspace) {
  const found = /* @__PURE__ */ new Set();
  for (const pattern of patterns) {
    const cwd = isAbsolute(pattern) ? void 0 : workspace;
    for await (const entry of glob(pattern, {
      ...cwd ? { cwd } : {},
      exclude: (path) => /(^|[\\/])(node_modules|\.git)$/.test(path)
    })) {
      found.add(cwd ? resolve(cwd, entry) : entry);
    }
  }
  return [...found].sort();
}
function annotate(failures, context, workspace, io, noticesAlready) {
  const isFile = (path) => statSync(join3(workspace, path), { throwIfNoEntry: false })?.isFile() ?? false;
  const emitted = { error: 0, notice: noticesAlready };
  for (const failure of failures) {
    const level = (failure.verdict === "new" || failure.verdict === "suspect") && !failure.quarantined ? "error" : "notice";
    if (emitted[level] === MAX_ANNOTATIONS_PER_LEVEL) continue;
    const location = locate(failure.test, workspace, isFile);
    if (!location) continue;
    const explanation = [plainExplanation(failure, context), failure.quarantined && quarantineNote(failure.quarantined, false)];
    const message = [explanation.filter(Boolean).join(" "), failure.test.message].filter(Boolean).join("\n");
    io.annotation(level, message, { file: location.file, line: location.line, title: failure.test.title });
    emitted[level]++;
  }
}
async function loadHistory(store, path, settings, io) {
  try {
    return parseHistory(await store.read(path));
  } catch (error) {
    io.warning(`Could not read history from branch "${settings.branch}", continuing without it. ${errorMessage(error)}`);
    return emptyHistory();
  }
}
function historyPath(key) {
  return `history/${key}.json`;
}
async function recordHistory(store, key, results, platform, settings, now, commit) {
  const { context, io } = platform;
  if (context.pullRequest?.fromFork) {
    io.info(`${capitalize2(platform.text.pullRequest)} from a fork: the token is read-only, history is not recorded.`);
    return;
  }
  const tracked = isTracked(context, settings);
  try {
    const pushed = await store.update(
      historyPath(key),
      (current) => {
        const history = parseHistory(current);
        if (tracked) applyRenames(history, detectRenames(history, results));
        const changed = recordRun(history, results, {
          sha: context.sha,
          tracked,
          now,
          window: settings.window,
          retentionDays: RETENTION_DAYS,
          ...commit ? { commit } : {}
        });
        return changed ? serializeHistory(history) : void 0;
      },
      {
        message: `Record ${key} (${context.runDescription})`,
        extraFiles: { "README.md": BRANCH_README, ".nojekyll": "" },
        derivedFiles: (content, existingPaths) => {
          const history = parseHistory(content);
          const keys = new Set(existingPaths.flatMap((path) => /^history\/([^/]+)\.json$/.exec(path)?.slice(1) ?? []));
          keys.add(key);
          const pages = { trackedBranches: settings.trackedBranches, now, evidenceTtlDays: EVIDENCE_TTL_DAYS };
          return {
            [badgePath(key)]: renderBadge(history, now, EVIDENCE_TTL_DAYS),
            [reportPath(key)]: renderSuitePage(key, history, pages),
            "index.html": renderIndexPage([...keys].sort(), pages)
          };
        }
      }
    );
    io.info(pushed ? `History updated on branch "${settings.branch}".` : "Nothing new to record.");
  } catch (error) {
    io.warning(`Could not record history on branch "${settings.branch}". ${platform.text.recordDenied} ${errorMessage(error)}`);
  }
}
async function describeCommit(suites, platform, settings) {
  const { context, io, text } = platform;
  const startsFailing = suites.some(
    (suite) => suite.results.some((result) => result.outcome === "failed" && !suite.history.tests[result.id]?.outcomes.endsWith(FAIL))
  );
  if (!startsFailing) return void 0;
  const commit = { url: platform.commitUrl(context.sha) };
  try {
    const change = await platform.forge(settings.token).changeOf(context.sha);
    if (change) commit.change = { ref: `${text.changePrefix}${change.number}`, url: change.url };
  } catch (error) {
    io.info(`Could not tell which ${text.pullRequest} commit ${context.sha.slice(0, 7)} came from: ${errorMessage(error)}`);
  }
  return commit;
}
function isTracked(context, settings) {
  return context.branch !== void 0 && settings.trackedBranches.includes(context.branch);
}
async function manageFlakyIssues(suites, platform, settings, now) {
  const { context, io } = platform;
  const runUrl = context.runUrl;
  const client = platform.forge(settings.token);
  try {
    const after = suites.map((suite) => {
      const history = structuredClone(suite.history);
      recordRun(history, suite.results, { sha: context.sha, tracked: true, now, window: settings.window, retentionDays: RETENTION_DAYS });
      return { key: suite.key, history, results: suite.results, renames: suite.renames };
    });
    const { actions, postponed } = planFlakyIssues(after, await client.listIssues(FLAKY_LABEL.name), {
      trackedBranches: settings.trackedBranches,
      now,
      evidenceTtlDays: EVIDENCE_TTL_DAYS,
      sha: context.sha,
      ...runUrl ? { runUrl } : {},
      runName: platform.text.runName,
      pullRequest: platform.text.pullRequest,
      ...settings.mentionOwners ? codeOwners(platform) : {}
    });
    if (actions.some((action) => action.kind === "create")) {
      await client.ensureLabel(FLAKY_LABEL.name, FLAKY_LABEL.color, FLAKY_LABEL.description);
    }
    const done = { created: 0, updated: 0, closed: 0 };
    for (const action of actions) {
      if (action.kind === "create") {
        await client.createIssue(action.title, action.body, [FLAKY_LABEL.name]);
        done.created++;
      } else if (action.kind === "update") {
        await client.updateIssue(action.issue, {
          body: action.body,
          ...action.title ? { title: action.title } : {},
          ...action.reopen ? { state: "open" } : {}
        });
        done.updated++;
      } else {
        await client.addComment(action.issue, action.comment);
        await client.updateIssue(action.issue, { state: "closed" });
        done.closed++;
      }
    }
    const later = postponed > 0 ? ` ${postponed} more flaky test(s) will get an issue on the next runs.` : "";
    io.info(`Flaky test issues: ${done.created} created, ${done.updated} updated, ${done.closed} closed.${later}`);
  } catch (error) {
    const hint = error instanceof ApiError && error.denied ? ` ${platform.text.issuesDenied}` : "";
    io.warning(`Could not update flaky test issues.${hint} ${errorMessage(error)}`);
  }
}
function codeOwners(platform) {
  const { context, io } = platform;
  const codeowners = readCodeowners(context.workspace, platform.codeownersPaths);
  if (!codeowners) {
    io.info(`No CODEOWNERS file in ${platform.codeownersPaths.join(", ")}: flaky test issues mention no owners.`);
    return {};
  }
  const isFile = (path) => statSync(join3(context.workspace, path), { throwIfNoEntry: false })?.isFile() ?? false;
  return {
    owners: (result) => {
      const location = locate(result, context.workspace, isFile);
      return location ? ownersOf(location.file, codeowners.rules) : [];
    }
  };
}
async function comment(platform, settings, body, create) {
  const { context, io, text } = platform;
  const pullRequest = context.pullRequest;
  if (!pullRequest) return;
  try {
    const result = await platform.forge(settings.token).upsertComment(pullRequest.number, commentMarker(settings.commentKey), body, create);
    if (result !== "skipped") io.info(`${capitalize2(text.pullRequest)} comment ${result}.`);
  } catch (error) {
    const hint = error instanceof ApiError && error.denied ? ` ${pullRequest.fromFork ? text.commentFromFork : text.commentDenied}` : "";
    io.warning(`Could not comment on the ${text.pullRequest}.${hint} ${errorMessage(error)}`);
  }
}
function rerunWorthIt(failures, blocking, settings) {
  const flaky = (failure) => failure.verdict === "flaky";
  if (settings.mode === "report") return failures.length > 0 && failures.every(flaky);
  return blocking.length > 0 && blocking.every(flaky);
}
async function rerun(platform, settings) {
  const { context, io, text } = platform;
  const forge = platform.forge(settings.token);
  if (!forge.rerun) {
    io.warning(
      `${io.describeInput("rerun-flaky")} is ignored: only GitLab lets a job start its pipeline again. On GitHub, use a companion workflow instead: https://github.com/tashikomaaa/notmyfault/blob/main/docs/recipes.md#re-run-flaky-failures-automatically`
    );
    return void 0;
  }
  try {
    const url = await forge.rerun({
      sha: context.sha,
      ...context.pullRequest ? { mergeRequest: context.pullRequest.number } : context.branch ? { branch: context.branch } : {}
    });
    io.info(
      url ? `Only flaky tests failed: started a new pipeline for this commit, ${url}` : "Only flaky tests failed, but this commit already had another pipeline, or moved on: not re-running."
    );
    return url;
  } catch (error) {
    const hint = error instanceof ApiError && error.denied ? ` ${text.rerunDenied}` : "";
    io.warning(`Could not start a new pipeline.${hint} ${errorMessage(error)}`);
    return void 0;
  }
}
async function reportCheck(name, platform, settings, output, success) {
  const { context, io, text } = platform;
  const forge = platform.forge(settings.token);
  if (!forge.createCheck) {
    io.warning(`${io.describeInput("check")} is ignored: checks only exist on GitHub. The notmyfault job or step is the check here.`);
    return;
  }
  if (context.pullRequest?.fromFork) {
    io.info(`${capitalize2(text.pullRequest)} from a fork: the token is read-only, no check is created.`);
    return;
  }
  try {
    const url = await forge.createCheck({
      name,
      sha: context.pullRequest?.headSha ?? context.sha,
      success,
      ...output,
      ...context.runUrl ? { detailsUrl: context.runUrl } : {}
    });
    io.info(`Check "${name}" ${success ? "passed" : "failed"}: ${url}`);
  } catch (error) {
    const hint = error instanceof ApiError && error.denied ? ` ${text.checkDenied}` : "";
    io.warning(`Could not create the check "${name}".${hint} ${errorMessage(error)}`);
  }
}
function capitalize2(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
function splitList(value) {
  return value.split(/[\n,]/).map((part) => part.trim()).filter((part) => part.length > 0);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/index.ts
process.exitCode = await run2();
