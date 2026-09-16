// src/main.ts
import { statSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { isAbsolute, join as join2, relative, resolve } from "node:path";

// src/actions.ts
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
  command(name, message) {
    const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    this.write(`::${name}::${escaped}`);
  }
};

// src/history.ts
import { createHash } from "node:crypto";
var HISTORY_VERSION = 1;
var PASS = "p";
var FAIL = "f";
var RETRY = "r";
var MAX_FAILED_ON = 20;
var MAX_EVIDENCE = 10;
var MAX_ERRORS = 10;
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
      test.outcomes = (test.outcomes + code2).slice(-options.window);
      testChanged = true;
      if (result.outcome !== "passed" && result.message) addError(test, errorFingerprint(result.message));
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
  if (options.tracked) history.runs += 1;
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
var LIKELY_FLAKY_ISOLATED_FAILURES = 3;
var UNLIKELY_STREAK_CHANCE = 0.01;
var MIN_BROKEN_STREAK = 3;
var MAX_BROKEN_STREAK = 10;
var VERDICT_ORDER = { new: 0, suspect: 1, broken: 2, flaky: 3 };
function analyze(results, history, now, evidenceTtlDays) {
  const analysis = { total: results.length, passed: 0, skipped: 0, failures: [], retried: [], fixed: [] };
  const checkFixed = (test) => {
    const tested = history.tests[test.id];
    if (!tested?.outcomes.endsWith(FAIL)) return;
    const stats = computeStats(tested, now, evidenceTtlDays);
    if (verdictFor(stats) === "broken") analysis.fixed.push({ test, ...stats });
  };
  for (const test of results) {
    switch (test.outcome) {
      case "passed":
        analysis.passed++;
        checkFixed(test);
        break;
      case "skipped":
        analysis.skipped++;
        break;
      case "flaky":
        analysis.passed++;
        analysis.retried.push(test);
        checkFixed(test);
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
  return analysis;
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
  return analysis.failures.filter((failure) => !tolerated.has(failure.verdict));
}
function rankFlakyTests(history, now, evidenceTtlDays, limit) {
  const ranked = [];
  for (const [id, test] of Object.entries(history.tests)) {
    const stats = computeStats(test, now, evidenceTtlDays);
    if (stats.confirmed || stats.isolatedFailures >= LIKELY_FLAKY_ISOLATED_FAILURES) ranked.push({ id, ...stats });
  }
  const score = (t) => (t.failures + t.retries) / Math.max(t.runs, 1) + (t.confirmed ? 1 : 0);
  return ranked.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id)).slice(0, limit);
}
function brokenStreak(failureRate) {
  let streak = MIN_BROKEN_STREAK;
  while (streak < MAX_BROKEN_STREAK && failureRate ** streak >= UNLIKELY_STREAK_CHANCE) streak++;
  return streak;
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

// src/context.ts
import { readFileSync } from "node:fs";
function readContext(env) {
  const repository = required(env, "GITHUB_REPOSITORY");
  const payload = readPayload(env.GITHUB_EVENT_PATH);
  const pr = payload.pull_request;
  return {
    repository,
    serverUrl: (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, ""),
    apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    sha: required(env, "GITHUB_SHA"),
    ref: env.GITHUB_REF ?? "",
    refName: env.GITHUB_REF_NAME ?? "",
    eventName: env.GITHUB_EVENT_NAME ?? "",
    runId: env.GITHUB_RUN_ID ?? "",
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? "1",
    workflow: env.GITHUB_WORKFLOW ?? "workflow",
    job: env.GITHUB_JOB ?? "job",
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
    tempDir: env.RUNNER_TEMP,
    defaultBranch: payload.repository?.default_branch,
    pullRequest: typeof pr?.number === "number" ? { number: pr.number, fromFork: pr.head?.repo?.full_name !== (pr.base?.repo?.full_name ?? repository) } : void 0
  };
}
function runUrl(context) {
  if (!context.runId) return void 0;
  const attempt = context.runAttempt && context.runAttempt !== "1" ? `/attempts/${context.runAttempt}` : "";
  return `${context.serverUrl}/${context.repository}/actions/runs/${context.runId}${attempt}`;
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
   * Resolves to whether a commit was pushed.
   */
  async update(path, update, options) {
    const attempts = options.attempts ?? 6;
    for (let attempt = 1; ; attempt++) {
      const head = await this.fetchHead();
      const next = update(head ? await this.readFile(head, path) : void 0);
      if (next === void 0) return false;
      const commit = await this.commit(head, { ...options.extraFiles, [path]: next }, options.message);
      let conflict;
      try {
        const output = await this.git([
          "push",
          "--porcelain",
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
      GIT_AUTHOR_NAME: BOT_NAME,
      GIT_AUTHOR_EMAIL: BOT_EMAIL,
      GIT_COMMITTER_NAME: BOT_NAME,
      GIT_COMMITTER_EMAIL: BOT_EMAIL
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
      const credentials = Buffer.from(`x-access-token:${token}`).toString("base64");
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

// src/github.ts
var GitHubApiError = class extends Error {
  constructor(status, path, body) {
    super(`GitHub API ${status} on ${path}: ${body.slice(0, 200)}`);
    this.status = status;
    this.path = path;
  }
  status;
  path;
};
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
    await this.request("POST", `/repos/${this.repository}/issues/${issue}/comments`, { body });
    return "created";
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
    if (!response.ok) throw new GitHubApiError(response.status, path, await response.text());
    return response;
  }
};
function nextPage(link, apiUrl) {
  const match = link?.match(/<([^>]+)>;\s*rel="next"/);
  if (!match?.[1]) return void 0;
  return match[1].startsWith(apiUrl) ? match[1].slice(apiUrl.length) : void 0;
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
  if (outcome === "failed") result.hints = locationHints(testcase, suite, failures);
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

// src/report.ts
var MAX_ROWS = 30;
var MAX_MESSAGES = 10;
var MAX_FIXED = 10;
var PROJECT_URL = "https://github.com/tashikomaaa/notmyfault";
var BADGES_URL = "https://raw.githubusercontent.com/tashikomaaa/notmyfault/main/docs/assets";
var EMOJI = { new: "\u{1F534}", suspect: "\u{1F7E0}", broken: "\u26AB", flaky: "\u{1F7E1}" };
function badge(image, emoji, size) {
  return `<img src="${BADGES_URL}/verdict-${image}.png" alt="${emoji}" width="${size}" height="${size}" align="absmiddle">`;
}
function commentMarker(key) {
  return `<!-- notmyfault:${key} -->`;
}
function renderComment(analysis, context) {
  return [commentMarker(context.key), ...renderBody(analysis, context)].join("\n");
}
function renderSummary(analysis, ranking, context) {
  const lines = renderBody(analysis, context);
  if (ranking.length > 0) {
    lines.push(
      "",
      `<details><summary>Most unreliable tests on ${branches(context)}</summary>`,
      "",
      "| Test | Failed runs | Passed on retry | Proven flaky |",
      "|---|--:|--:|:-:|",
      ...ranking.map(
        (t) => `| ${code(t.id)} | ${t.failures} / ${t.runs} | ${t.retries} | ${t.confirmed ? "yes" : "probably"} |`
      ),
      "",
      "</details>"
    );
  }
  return lines.join("\n");
}
function renderBody(analysis, context) {
  const lines = [`### ${headline(analysis)}`, ""];
  if (analysis.failures.length > 0) {
    lines.push("| Test | Why |", "|---|---|");
    for (const failure of analysis.failures.slice(0, MAX_ROWS)) {
      const icon = badge(failure.verdict, EMOJI[failure.verdict], 24);
      lines.push(`| ${code(failure.test.title)} | ${icon} ${explain(failure, context)} |`);
    }
    if (analysis.failures.length > MAX_ROWS) {
      lines.push(`| _\u2026and ${analysis.failures.length - MAX_ROWS} more_ | |`);
    }
    lines.push("");
    lines.push(...renderMessages(analysis.failures));
  }
  if (analysis.fixed.length > 0) lines.push(...renderFixed(analysis.fixed, context));
  if (context.mode === "quarantine" && analysis.failures.length > 0) {
    const tolerated = [...context.tolerated].map((v) => `\`${v}\``).join(", ") || "nothing";
    lines.push(
      context.blocking === 0 ? `\u{1F6E1}\uFE0F **Quarantine:** every failure is tolerated (${tolerated}), so this check passes.` : `\u274C **Quarantine:** ${plural(context.blocking, "failure")} not tolerated (${tolerated}), so this check fails.`,
      ""
    );
  }
  if (context.historyRuns === 0) {
    lines.push(
      `\u2139\uFE0F No history on ${branches(context)} yet. Verdicts get sharper once a few runs have been recorded there.`,
      ""
    );
  }
  lines.push(footer(analysis.retried, context));
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
function plainExplanation(failure, context) {
  return explain(failure, context).replace(/\*\*|`/g, "");
}
function explain(failure, context) {
  const where = branches(context);
  switch (failure.verdict) {
    case "new":
      if (failure.usually) return `**New failure.** ${usualBehavior(failure, where)}, but this error was never seen there.`;
      return failure.trailingPasses > 0 ? `**New failure.** Passed the last ${plural(failure.trailingPasses, "run")} on ${where}.` : `**New failure.** No history for this test on ${where}.`;
    case "suspect":
      return `**Suspect.** Failed in isolation ${times(failure.isolatedFailures)} in the last ${plural(failure.runs, "run")} on ${where}.`;
    case "broken":
      return failure.trailingFailures === 1 ? `**Already failing on ${where}.** The latest run there failed too.` : `**Already failing on ${where}.** Failed the last ${failure.trailingFailures} runs there${failure.confirmed ? ", too many in a row to be flakiness" : ""}.`;
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
      (f) => `- ${code(f.test.title)}, ${f.trailingFailures === 1 ? "failed the latest run" : `failed the last ${f.trailingFailures} runs`} there`
    )
  ];
  if (fixed.length > MAX_FIXED) lines.push(`- _\u2026and ${fixed.length - MAX_FIXED} more_`);
  lines.push("");
  return lines;
}
function footer(retried, context) {
  const parts = [];
  if (retried.length > 0) {
    const names = retried.slice(0, 5).map((t) => code(t.title)).join(", ");
    const more = retried.length > 5 ? ` and ${retried.length - 5} more` : "";
    parts.push(`\u{1F501} Passed only after a retry: ${names}${more}`);
  }
  if (context.runUrl) parts.push(`[Workflow run](${context.runUrl})`);
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

// src/main.ts
var EVIDENCE_TTL_DAYS = 30;
var RETENTION_DAYS = 90;
var RANKING_SIZE = 10;
var MAX_ANNOTATIONS_PER_LEVEL = 10;
var VERDICTS = ["new", "suspect", "broken", "flaky"];
var BRANCH_README = `# notmyfault history

This branch is maintained by the [notmyfault](https://github.com/tashikomaaa/notmyfault) GitHub Action.
It stores the recent outcome of each test, so failures can be told apart: new, flaky or already broken.

The branch is rewritten as a single commit on every update. Deleting it simply resets the history.
`;
async function run2(env = process.env, io = new ActionIO(env), now = /* @__PURE__ */ new Date()) {
  try {
    const context = readContext(env);
    const settings = readSettings(io, context);
    io.mask(settings.token);
    const results = await loadResults(settings.patterns, context.workspace, io);
    if (!results) return 1;
    const store = new GitStore({
      remoteUrl: `${context.serverUrl}/${context.repository}.git`,
      branch: settings.branch,
      token: settings.token,
      tempDir: context.tempDir
    });
    try {
      return await evaluate(results, context, settings, store, io, now);
    } finally {
      await store.dispose();
    }
  } catch (error) {
    io.error(errorMessage(error));
    return 1;
  }
}
async function evaluate(results, context, settings, store, io, now) {
  const historyPath = `history/${settings.key}.json`;
  const history = await loadHistory(store, historyPath, settings, io);
  const analysis = analyze(results, history, now, EVIDENCE_TTL_DAYS);
  const blocking = blockingFailures(analysis, settings.tolerated);
  const reportContext = {
    key: settings.key,
    trackedBranches: settings.trackedBranches,
    historyRuns: history.runs,
    mode: settings.mode,
    tolerated: settings.tolerated,
    blocking: blocking.length
  };
  const url = runUrl(context);
  if (url) reportContext.runUrl = url;
  io.group(
    `notmyfault: ${analysis.failures.length} failed, ${analysis.retried.length} retried, ${analysis.fixed.length} fixed, ${analysis.total} total`
  );
  for (const failure of analysis.failures) {
    const reason = failure.usually ? ` (${failure.usually} on ${settings.trackedBranches.join(", ")}, but with a new error)` : "";
    io.info(`${failure.verdict.padEnd(8)} ${failure.test.title}${reason}`);
  }
  for (const test of analysis.retried) io.info(`retried  ${test.title}`);
  for (const fixed of analysis.fixed) io.info(`fixed    ${fixed.test.title}`);
  io.endGroup();
  if (settings.annotations) annotate(analysis, reportContext, context.workspace, io);
  if (settings.record) await recordHistory(store, historyPath, results, context, settings, io, now);
  io.appendSummary(renderSummary(analysis, rankFlakyTests(history, now, EVIDENCE_TTL_DAYS, RANKING_SIZE), reportContext));
  if (settings.comment && context.pullRequest) {
    const noteworthy = analysis.failures.length + analysis.retried.length + analysis.fixed.length > 0;
    await comment(context, settings, renderComment(analysis, reportContext), noteworthy, io);
  }
  const count2 = (verdicts) => analysis.failures.filter((f) => verdicts.includes(f.verdict)).length;
  io.setOutput("total", analysis.total);
  io.setOutput("failed", analysis.failures.length);
  io.setOutput("new-failures", count2(["new", "suspect"]));
  io.setOutput("flaky-failures", count2(["flaky"]));
  io.setOutput("broken-failures", count2(["broken"]));
  io.setOutput("retried", analysis.retried.length);
  io.setOutput("fixed", analysis.fixed.length);
  io.setOutput("blocking", blocking.length);
  if (settings.mode === "quarantine" && blocking.length > 0) {
    const names = blocking.slice(0, 5).map((f) => f.test.title).join(", ");
    io.error(`${blocking.length} failing test(s) are not tolerated in quarantine mode: ${names}`);
    return 1;
  }
  return 0;
}
function readSettings(io, context) {
  const patterns = splitList(io.input("junit"));
  if (patterns.length === 0) throw new Error('Input "junit" is required: a glob matching your JUnit XML reports.');
  const mode = io.input("mode", "report");
  if (mode !== "report" && mode !== "quarantine") {
    throw new Error(`Input "mode" must be "report" or "quarantine", got "${mode}"`);
  }
  const tolerated = /* @__PURE__ */ new Set();
  for (const value of splitList(io.input("tolerate", "flaky"))) {
    if (!VERDICTS.includes(value)) {
      throw new Error(`Input "tolerate" accepts ${VERDICTS.join(", ")}; got "${value}"`);
    }
    tolerated.add(value);
  }
  const token = io.input("token");
  if (!token) throw new Error('Input "token" is empty. Pass `token: ${{ github.token }}`.');
  return {
    patterns,
    mode,
    tolerated,
    token,
    branch: io.input("history-branch", "notmyfault-history"),
    trackedBranches: splitList(io.input("track-branches", context.defaultBranch ?? "main")),
    key: sanitizeKey(io.input("key", `${context.workflow}-${context.job}`)),
    comment: io.booleanInput("comment", true),
    annotations: io.booleanInput("annotations", true),
    record: io.booleanInput("record", true),
    window: io.integerInput("window", 50, 5)
  };
}
function sanitizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "default";
}
async function loadResults(patterns, workspace, io) {
  const files = await findFiles(patterns, workspace);
  if (files.length === 0) {
    io.error(`No JUnit report matched ${patterns.map((p) => `"${p}"`).join(", ")} in ${workspace}.`);
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
    io.error(`The ${files.length} matched report(s) contain no test cases.`);
    return void 0;
  }
  io.info(`Read ${results.length} tests from ${files.length} report(s).`);
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
function annotate(analysis, context, workspace, io) {
  const isFile = (path) => statSync(join2(workspace, path), { throwIfNoEntry: false })?.isFile() ?? false;
  const emitted = { error: 0, notice: 0 };
  for (const failure of analysis.failures) {
    const level = failure.verdict === "new" || failure.verdict === "suspect" ? "error" : "notice";
    if (emitted[level] === MAX_ANNOTATIONS_PER_LEVEL) continue;
    const location = locate(failure.test, workspace, isFile);
    if (!location) continue;
    const message = [plainExplanation(failure, context), failure.test.message].filter(Boolean).join("\n");
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
async function recordHistory(store, path, results, context, settings, io, now) {
  if (context.pullRequest?.fromFork) {
    io.info("Pull request from a fork: the token is read-only, history is not recorded.");
    return;
  }
  const tracked = !context.eventName.startsWith("pull_request") && context.ref === `refs/heads/${context.refName}` && settings.trackedBranches.includes(context.refName);
  try {
    const pushed = await store.update(
      path,
      (current) => {
        const history = parseHistory(current);
        const changed = recordRun(history, results, {
          sha: context.sha,
          tracked,
          now,
          window: settings.window,
          retentionDays: RETENTION_DAYS
        });
        return changed ? serializeHistory(history) : void 0;
      },
      {
        message: `Record ${settings.key} (run ${context.runId || "local"}, attempt ${context.runAttempt})`,
        extraFiles: { "README.md": BRANCH_README }
      }
    );
    io.info(pushed ? `History updated on branch "${settings.branch}".` : "Nothing new to record.");
  } catch (error) {
    io.warning(
      `Could not record history on branch "${settings.branch}". Does the job have "contents: write" permission? ${errorMessage(error)}`
    );
  }
}
async function comment(context, settings, body, create, io) {
  const pullRequest = context.pullRequest;
  if (!pullRequest) return;
  const client = new GitHubClient(settings.token, context.apiUrl, context.repository);
  try {
    const result = await client.upsertComment(pullRequest.number, commentMarker(settings.key), body, create);
    if (result !== "skipped") io.info(`Pull request comment ${result}.`);
  } catch (error) {
    const hint = error instanceof GitHubApiError && error.status === 403 ? pullRequest.fromFork ? " Tokens are read-only on pull requests from forks; the job summary has the full report." : ' Does the job have "pull-requests: write" permission?' : "";
    io.warning(`Could not comment on the pull request.${hint} ${errorMessage(error)}`);
  }
}
function splitList(value) {
  return value.split(/[\n,]/).map((part) => part.trim()).filter((part) => part.length > 0);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/index.ts
process.exitCode = await run2();
