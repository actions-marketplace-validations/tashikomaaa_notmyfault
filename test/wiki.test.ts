import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWiki, pageName, rewriteLinks } from "../scripts/wiki";

const REPO = "acme/shop";
const PAGES = new Map([
  ["README.md", "Home"],
  ["configuration.md", "Configuration"],
  ["faq.md", "FAQ"],
]);

describe("pageName", () => {
  it("turns the index into Home and names other pages after their title", () => {
    expect(pageName("README.md", "# Documentation")).toBe("Home");
    expect(pageName("verdicts.md", "# Reading the report\n")).toBe("Reading-the-report");
    expect(pageName("security.md", "# Permissions & security?\n")).toBe("Permissions-security");
    expect(pageName("untitled.md", "no heading")).toBe("untitled");
  });
});

describe("rewriteLinks", () => {
  it("points links to other docs pages at wiki pages, keeping anchors", () => {
    expect(rewriteLinks("See [inputs](configuration.md#inputs) and [FAQ](./faq.md).", PAGES, REPO)).toBe(
      "See [inputs](Configuration#inputs) and [FAQ](FAQ).",
    );
  });

  it("points links leaving docs/ at the repository, and images at their raw file", () => {
    expect(rewriteLinks("[guide](../CONTRIBUTING.md#releasing) ![pic](images/a.png)", PAGES, REPO)).toBe(
      "[guide](https://github.com/acme/shop/blob/main/CONTRIBUTING.md#releasing) " +
        "![pic](https://github.com/acme/shop/raw/main/docs/images/a.png)",
    );
  });

  it("rewrites src, srcset and href attributes of HTML tags", () => {
    const html = '<a href="faq.md#why"><img alt="" src="assets/a.png" width="90"></a><source srcset="./assets/b.JPG">';
    expect(rewriteLinks(html, PAGES, REPO)).toBe(
      '<a href="FAQ#why"><img alt="" src="https://github.com/acme/shop/raw/main/docs/assets/a.png" width="90"></a>' +
        '<source srcset="https://github.com/acme/shop/raw/main/docs/assets/b.JPG">',
    );
  });

  it("leaves absolute links, anchors, titles and code blocks alone", () => {
    const markdown = [
      '[site](https://example.com "Site") [here](#local) [t](faq.md "FAQ")',
      "```md",
      "[not a link](configuration.md)",
      "```",
    ].join("\n");
    expect(rewriteLinks(markdown, PAGES, REPO)).toBe(
      [
        '[site](https://example.com "Site") [here](#local) [t](FAQ "FAQ")',
        "```md",
        "[not a link](configuration.md)",
        "```",
      ].join("\n"),
    );
  });
});

describe("buildWiki", () => {
  it("names pages after their title, drops the duplicate heading, adds a sidebar and a footer", () => {
    const pages = buildWiki(
      {
        "README.md": "# Docs\n\n- [FAQ](faq.md)\n- [Config](configuration.md#inputs)\n- [FAQ again](faq.md)",
        "configuration.md": "# Configuration\n\nEvery input.\n",
        "faq.md": "# FAQ\n",
      },
      REPO,
    );
    const byName = Object.fromEntries(pages.map((page) => [page.name, page.content]));
    expect(Object.keys(byName).sort()).toEqual(["Configuration.md", "FAQ.md", "Home.md", "_Footer.md", "_Sidebar.md"]);
    expect(byName["Configuration.md"]).toBe("Every input.\n");
    expect(byName["Home.md"]).toContain("# Docs");
    expect(byName["_Sidebar.md"]).toBe("**[Home](Home)**\n\n- [FAQ](FAQ)\n- [Configuration](Configuration)\n");
    expect(byName["_Footer.md"]).toContain("https://github.com/acme/shop/tree/main/docs");
  });

  it("converts the real documentation without leaving relative .md links", () => {
    const docsDir = join(import.meta.dirname, "..", "docs");
    const files = Object.fromEntries(
      readdirSync(docsDir)
        .filter((file) => file.endsWith(".md"))
        .map((file) => [file, readFileSync(join(docsDir, file), "utf8")]),
    );
    const pages = buildWiki(files, "tashikomaaa/notmyfault");
    const names = new Set(pages.map((page) => page.name.replace(/\.md$/, "")));
    for (const page of pages) {
      let fenced = false;
      for (const line of page.content.split("\n")) {
        if (/^\s*```/.test(line)) fenced = !fenced;
        if (fenced) continue;
        for (const [, markdown, html] of line.matchAll(/\]\(([^)\s]+)|\b(?:src|srcset|href)="([^"\s]+)"/g)) {
          const target = (markdown ?? html)!;
          if (/^https?:|^#/.test(target)) continue;
          expect(names, `${page.name} links to ${target}`).toContain(target.split("#")[0]);
        }
      }
    }
  });
});
