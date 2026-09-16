import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSite } from "../scripts/site";

const out = mkdtempSync(join(tmpdir(), "notmyfault-site-"));
buildSite(join(import.meta.dirname, ".."), out);
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** Local files a page or stylesheet points at. */
function references(file: string): string[] {
  const text = readFileSync(join(out, file), "utf8");
  const found = [
    ...text.matchAll(/\b(?:src|srcset|href)="([^"]+)"/g),
    ...text.matchAll(/url\("([^"]+)"\)/g),
  ].map((match) => match[1]!);
  return found.filter((target) => !/^(?:[a-z]+:|#|\.\/$|\/$)/.test(target)).map((target) => target.replace(/^\//, ""));
}

describe("site", () => {
  it.each(["index.html", "404.html", "style.css"])("resolves every local file used by %s", (file) => {
    const missing = references(file).filter((target) => !existsSync(join(out, target)));
    expect(references(file).length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("links to anchors that exist", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
    expect(anchors.filter((anchor) => !ids.has(anchor))).toEqual([]);
  });

  it("uses no inline style or script, which the content security policy blocks", () => {
    for (const file of ["index.html", "404.html"]) {
      const html = readFileSync(join(out, file), "utf8");
      expect(html).not.toMatch(/\sstyle="|<style|<script(?![^>]*\bsrc=)/);
    }
  });
});
