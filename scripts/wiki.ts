/**
 * Converts docs/*.md into GitHub wiki pages.
 *
 * Usage: node scripts/wiki.ts <docs-dir> <wiki-dir> <owner/repo>
 *
 * - docs/README.md becomes Home.md, other pages are named after their title,
 *   which the wiki displays, so the title heading itself is removed.
 * - Links to other docs pages are rewritten to wiki page names.
 * - Links leaving docs/ point to the repository on github.com.
 * - _Sidebar.md follows the order of the links in docs/README.md.
 * - Existing wiki pages are removed first, so renamed docs leave nothing behind.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

export interface WikiPage {
  name: string;
  content: string;
}

export function pageName(file: string, content: string): string {
  if (file === "README.md") return "Home";
  const title = content.match(/^# (.+)$/m)?.[1] ?? file.replace(/\.md$/, "");
  return title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

/** Rewrites Markdown link targets outside fenced code blocks. `pages` maps docs files to wiki page names. */
export function rewriteLinks(markdown: string, pages: ReadonlyMap<string, string>, repo: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (_match, target: string, title = "") => {
        return `](${rewriteTarget(target, pages, repo)}${title})`;
      });
    })
    .join("\n");
}

function rewriteTarget(target: string, pages: ReadonlyMap<string, string>, repo: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return target;
  const [path = "", anchor] = target.split("#", 2);
  const suffix = anchor === undefined ? "" : `#${anchor}`;
  const normalized = posix.normalize(path.replace(/^\.\//, ""));
  const page = pages.get(normalized);
  if (page) return `${page}${suffix}`;
  const fromRoot = posix.normalize(posix.join("docs", normalized));
  return `https://github.com/${repo}/blob/main/${fromRoot}${suffix}`;
}

export function buildWiki(files: Record<string, string>, repo: string): WikiPage[] {
  const names = new Map(Object.entries(files).map(([file, content]) => [file, pageName(file, content)]));
  const pages: WikiPage[] = Object.entries(files).map(([file, content]) => ({
    name: `${names.get(file)}.md`,
    content: rewriteLinks(file === "README.md" ? content : content.replace(/^# .+\n+/, ""), names, repo),
  }));

  const order = [...(files["README.md"] ?? "").matchAll(/\]\(([\w.-]+\.md)(?:#[^)]*)?\)/g)]
    .map((match) => match[1]!)
    .filter((file, index, all) => names.has(file) && all.indexOf(file) === index);
  const sidebar = ["**[Home](Home)**", "", ...order.map((file) => `- [${title(files[file]!, file)}](${names.get(file)})`)];
  pages.push({ name: "_Sidebar.md", content: `${sidebar.join("\n")}\n` });
  pages.push({
    name: "_Footer.md",
    content:
      `This wiki is generated from [docs/](https://github.com/${repo}/tree/main/docs). ` +
      "Edit the files there: changes made in the wiki are overwritten.\n",
  });
  return pages;
}

function title(content: string, file: string): string {
  return content.match(/^# (.+)$/m)?.[1]?.trim() ?? file.replace(/\.md$/, "");
}

function main(argv: string[]): void {
  const [docsDir, wikiDir, repo] = argv;
  if (!docsDir || !wikiDir || !repo) {
    console.error("Usage: node scripts/wiki.ts <docs-dir> <wiki-dir> <owner/repo>");
    process.exit(2);
  }
  const files: Record<string, string> = {};
  for (const file of readdirSync(docsDir).filter((f) => f.endsWith(".md"))) {
    files[file] = readFileSync(join(docsDir, file), "utf8");
  }
  for (const existing of readdirSync(wikiDir).filter((f) => f.endsWith(".md"))) {
    rmSync(join(wikiDir, existing));
  }
  const pages = buildWiki(files, repo);
  for (const page of pages) writeFileSync(join(wikiDir, page.name), page.content);
  console.log(`Wrote ${pages.length} wiki pages to ${wikiDir}.`);
}

if (import.meta.filename === process.argv[1]) main(process.argv.slice(2));
