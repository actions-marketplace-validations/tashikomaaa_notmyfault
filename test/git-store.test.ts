import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitStore, splitCredentials } from "../src/git-store";

let root: string;
let remoteUrl: string;
const stores: GitStore[] = [];

function store(): GitStore {
  const created = new GitStore({ remoteUrl, branch: "history", tempDir: root });
  stores.push(created);
  return created;
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", join(root, "remote.git"), ...args], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "notmyfault-store-"));
  execFileSync("git", ["init", "--quiet", "--bare", join(root, "remote.git")]);
  remoteUrl = `file://${join(root, "remote.git")}`;
});

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.dispose()));
  rmSync(root, { recursive: true, force: true });
});

describe("splitCredentials", () => {
  it("takes the user name and password out of a remote URL", () => {
    expect(splitCredentials("https://bot:glpat-secret@gitlab.test/acme/shop.git")).toEqual({
      url: "https://gitlab.test/acme/shop.git",
      user: "bot",
      password: "glpat-secret",
    });
    // A token given alone is the password git needs.
    expect(splitCredentials("https://ghp_token@github.com/acme/shop.git")).toEqual({
      url: "https://github.com/acme/shop.git",
      user: "ghp_token",
      password: "ghp_token",
    });
    expect(splitCredentials("https://github.com/acme/shop.git")).toEqual({ url: "https://github.com/acme/shop.git" });
    expect(splitCredentials("git@github.com:acme/shop.git")).toEqual({ url: "git@github.com:acme/shop.git" });
  });
});

describe("GitStore", () => {
  it("reads nothing when the branch does not exist", async () => {
    expect(await store().read("history/a.json")).toBeUndefined();
  });

  it("creates the branch as a single bot commit and reads it back", async () => {
    const writer = store();
    const pushed = await writer.update("history/a.json", () => "one", {
      message: "first",
      extraFiles: { "README.md": "hello" },
    });
    expect(pushed).toBe(true);
    await writer.update("history/a.json", (current) => `${current} two`, { message: "second" });

    expect(await store().read("history/a.json")).toBe("one two");
    expect(git("rev-list", "--count", "history")).toBe("1");
    expect(git("log", "-1", "--format=%an <%ae>|%s", "history")).toBe(
      "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|second",
    );
    expect(git("ls-tree", "-r", "--name-only", "history").split("\n")).toEqual(["README.md", "history/a.json"]);
  });

  it("writes files derived from the new content and the existing paths in the same commit", async () => {
    await store().update("history/b.json", () => "b", { message: "b" });
    await store().update("history/a.json", () => "42", {
      message: "derived",
      derivedFiles: (content, paths) => ({ "badges/a.json": `answer ${content}`, "index.txt": paths.join(",") }),
    });
    expect(git("rev-list", "--count", "history")).toBe("1");
    expect(git("show", "history:badges/a.json")).toBe("answer 42");
    expect(git("show", "history:index.txt")).toBe("history/b.json");
  });

  it("keeps files written by other keys", async () => {
    await store().update("history/a.json", () => "a", { message: "a" });
    await store().update("history/b.json", () => "b", { message: "b" });
    const reader = store();
    expect(await reader.read("history/a.json")).toBe("a");
    expect(await reader.read("history/b.json")).toBe("b");
  });

  it("skips the push when the update returns undefined", async () => {
    expect(await store().update("history/a.json", () => undefined, { message: "noop" })).toBe(false);
    expect(git("branch", "--list")).toBe("");
  });

  it("does not lose concurrent updates", async () => {
    const writers = Array.from({ length: 5 }, () => store());
    await Promise.all(
      writers.map((writer) =>
        writer.update("counter.json", (current) => String(Number(current ?? "0") + 1), {
          message: "increment",
          attempts: 30,
        }),
      ),
    );
    expect(await store().read("counter.json")).toBe("5");
  });

  it("fails fast on errors that retrying cannot fix", async () => {
    const broken = new GitStore({ remoteUrl: `file://${join(root, "missing.git")}`, branch: "history", tempDir: root });
    stores.push(broken);
    await expect(broken.update("a.json", () => "x", { message: "x" })).rejects.toThrow(/git fetch failed/);
  });
});
