import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";

export interface GitStoreOptions {
  /** Repository URL, e.g. https://github.com/owner/repo.git or file:///path/to/bare.git */
  remoteUrl: string;
  branch: string;
  /** Token sent to HTTPS remotes. Passed through the environment, never on the command line. */
  token?: string;
  /** Where to create the scratch repository. Defaults to the OS temp dir. */
  tempDir?: string;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    /** stderr followed by stdout: push --porcelain reports rejections on stdout. */
    readonly output: string,
  ) {
    super(`git ${args[0]} failed: ${output.trim() || "unknown error"}`);
  }
}

const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const RETRYABLE_PUSH = /stale info|fetch first|non-fast-forward|cannot lock ref|failed to update ref/i;

/**
 * Stores files on a dedicated branch, in a scratch repository so the user's
 * checkout is never touched. The branch always holds one parentless commit,
 * so it does not grow over time; concurrent writers are serialized with
 * --force-with-lease and retried.
 */
export class GitStore {
  private dir: string | undefined;

  constructor(private readonly options: GitStoreOptions) {}

  async read(path: string): Promise<string | undefined> {
    const head = await this.fetchHead();
    return head ? this.readFile(head, path) : undefined;
  }

  /**
   * Rewrites `path` with the result of `update` (skipped when it returns
   * undefined). `update` may run several times, always on the latest content.
   * `derivedFiles` writes more files computed from that result and the paths
   * already on the branch, in the same commit.
   * Resolves to whether a commit was pushed.
   */
  async update(
    path: string,
    update: (current: string | undefined) => string | undefined,
    options: {
      message: string;
      extraFiles?: Record<string, string>;
      derivedFiles?: (content: string, existingPaths: string[]) => Record<string, string>;
      attempts?: number;
    },
  ): Promise<boolean> {
    const attempts = options.attempts ?? 6;
    for (let attempt = 1; ; attempt++) {
      const head = await this.fetchHead();
      const next = update(head ? await this.readFile(head, path) : undefined);
      if (next === undefined) return false;

      const existing = options.derivedFiles && head ? await this.listFiles(head) : [];
      const files = { ...options.extraFiles, ...options.derivedFiles?.(next, existing), [path]: next };
      const commit = await this.commit(head, files, options.message);
      let conflict: Error;
      try {
        const output = await this.git([
          "push",
          "--porcelain",
          `--force-with-lease=refs/heads/${this.options.branch}:${head ?? ""}`,
          this.options.remoteUrl,
          `${commit}:refs/heads/${this.options.branch}`,
        ]);
        // Another writer may have pushed the exact same commit (same content,
        // same second). git then reports "up to date" without applying ours.
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

  async dispose(): Promise<void> {
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
    this.dir = undefined;
  }

  private async fetchHead(): Promise<string | undefined> {
    try {
      await this.git([
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        this.options.remoteUrl,
        `refs/heads/${this.options.branch}`,
      ]);
    } catch (error) {
      if (error instanceof GitError && /couldn't find remote ref/i.test(error.output)) return undefined;
      throw error;
    }
    return (await this.git(["rev-parse", "FETCH_HEAD"])).trim();
  }

  private async listFiles(commit: string): Promise<string[]> {
    return (await this.git(["ls-tree", "-r", "--name-only", commit])).split("\n").filter(Boolean);
  }

  private async readFile(commit: string, path: string): Promise<string | undefined> {
    const listed = await this.git(["ls-tree", "--name-only", commit, "--", path]);
    if (listed.trim() === "") return undefined;
    return this.git(["cat-file", "blob", `${commit}:${path}`]);
  }

  private async commit(parent: string | undefined, files: Record<string, string>, message: string): Promise<string> {
    const dir = await this.repository();
    const env = { GIT_INDEX_FILE: join(dir, ".git", "notmyfault-index") };
    await this.git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], env);
    for (const [path, content] of Object.entries(files)) {
      const blob = (await this.git(["hash-object", "-w", "--stdin"], env, content)).trim();
      await this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
    }
    const tree = (await this.git(["write-tree"], env)).trim();
    return (
      await this.git(["commit-tree", tree, "-m", message], {
        GIT_AUTHOR_NAME: BOT_NAME,
        GIT_AUTHOR_EMAIL: BOT_EMAIL,
        GIT_COMMITTER_NAME: BOT_NAME,
        GIT_COMMITTER_EMAIL: BOT_EMAIL,
      })
    ).trim();
  }

  private async repository(): Promise<string> {
    if (!this.dir) {
      const dir = await mkdtemp(join(this.options.tempDir ?? tmpdir(), "notmyfault-"));
      await run(["init", "--quiet", dir], this.baseEnv());
      this.dir = dir;
    }
    return this.dir;
  }

  private async git(args: string[], env: Record<string, string> = {}, input?: string): Promise<string> {
    const dir = await this.repository();
    return run(["-C", dir, ...args], { ...this.baseEnv(), ...env }, input);
  }

  private baseEnv(): Record<string, string> {
    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: "0",
      // Ignore global/system config (credential helpers, hooks, signing...).
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
    };
    const { token, remoteUrl } = this.options;
    if (token && /^https?:\/\//.test(remoteUrl)) {
      const origin = new URL(remoteUrl).origin;
      const credentials = Buffer.from(`x-access-token:${token}`).toString("base64");
      Object.assign(env, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credentials}`,
      });
    }
    return env;
  }
}

function run(args: string[], env: Record<string, string>, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: { ...process.env, ...env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => reject(new Error(`Unable to run git: ${error.message}`)));
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      if (code === 0) resolve(out);
      else reject(new GitError(args[0] === "-C" ? args.slice(2) : args, Buffer.concat(stderr).toString("utf8") + out));
    });
    if (child.stdin) {
      // git may exit before reading everything; the exit code tells what happened.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
