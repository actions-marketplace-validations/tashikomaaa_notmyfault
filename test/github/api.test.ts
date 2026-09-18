import { describe, expect, it } from "vitest";
import { samePage } from "../../src/github/api";

describe("samePage", () => {
  it("keeps pagination on the API host", () => {
    expect(samePage("https://api.github.com/repos/acme/shop/issues?page=2", "https://api.github.com")).toBe(
      "/repos/acme/shop/issues?page=2",
    );
    expect(samePage("https://gitlab.test/api/v4/projects/1/issues?page=2", "https://gitlab.test/api/v4")).toBe(
      "/projects/1/issues?page=2",
    );
  });

  it("refuses a host that only looks like the API host", () => {
    // The Link header comes from the server: a lookalike host would receive the token.
    expect(samePage("https://api.github.com.evil.com/x", "https://api.github.com")).toBeUndefined();
    expect(samePage("https://api.github.com@evil.com/x", "https://api.github.com")).toBeUndefined();
    expect(samePage("http://api.github.com/x", "https://api.github.com")).toBeUndefined();
    expect(samePage("https://gitlab.test/api/v5/projects", "https://gitlab.test/api/v4")).toBeUndefined();
    expect(samePage("not a url", "https://api.github.com")).toBeUndefined();
  });
});
