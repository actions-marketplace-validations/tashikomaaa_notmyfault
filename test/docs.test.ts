import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const markdownFiles = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "brand/README.md",
  ...readdirSync(join(root, "docs"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => `docs/${file}`),
];

/** Markdown without fenced code blocks. */
function prose(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .filter((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return false;
      }
      return !fenced;
    })
    .join("\n");
}

/** Markdown link targets, and src, srcset and href attributes of HTML tags. */
function links(markdown: string): string[] {
  const text = prose(markdown).replace(/`[^`\n]*`/g, "");
  return [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\b(?:src|srcset|href)="([^"\s]+)"/g)].map(
    (match) => (match[1] ?? match[2])!,
  );
}

/** Heading anchors, generated the way GitHub does. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const match of prose(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = match[1]!
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    result.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return result;
}

describe("documentation links", () => {
  for (const file of markdownFiles) {
    it(`resolves every relative link in ${file}`, () => {
      const broken: string[] = [];
      for (const link of links(read(file))) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
        const [path = "", anchor] = link.split("#", 2);
        const target = path === "" ? join(root, file) : join(root, dirname(file), path);
        if (!existsSync(target)) {
          broken.push(`${link} (missing ${relative(root, target)})`);
        } else if (anchor && statSync(target).isFile() && target.endsWith(".md")) {
          if (!anchors(readFileSync(target, "utf8")).has(anchor)) broken.push(`${link} (missing anchor)`);
        }
      }
      expect(broken).toEqual([]);
    });
  }

  it("lists every docs page in the documentation index", () => {
    const index = links(read("docs/README.md"));
    const pages = readdirSync(join(root, "docs")).filter((file) => file.endsWith(".md") && file !== "README.md");
    expect(pages.filter((page) => !index.includes(page))).toEqual([]);
  });
});

describe("action.yml", () => {
  const action = read("action.yml");
  const section = (name: string, next: string) =>
    action.slice(action.indexOf(`\n${name}:\n`), action.indexOf(`\n${next}:\n`));
  const names = (text: string) => [...text.matchAll(/^ {2}([\w-]+):$/gm)].map((match) => match[1]!);

  const inputs = section("inputs", "outputs");
  const outputs = section("outputs", "runs");
  const configuration = read("docs/configuration.md");
  const main = read("src/main.ts");

  it.each(names(inputs))("reads and documents the %s input", (input) => {
    expect(main).toMatch(new RegExp(`(input|booleanInput|integerInput)\\("${input}"`));
    const row = configuration.split("\n").find((line) => line.startsWith(`| [\`${input}\`](#${input}) |`));
    expect(row, `configuration.md has no row for ${input}`).toBeDefined();
    const block = inputs.slice(inputs.indexOf(`\n  ${input}:\n`) + 1).split(/\n {2}[\w-]+:\n/)[0]!;
    const fallback = block.match(/^ {4}default: "?(.*?)"?$/m)?.[1];
    if (fallback !== undefined) expect(row).toContain(`\`${fallback}\``);
    expect(configuration).toContain(`### \`${input}\``);
  });

  it.each(names(outputs))("sets and documents the %s output", (output) => {
    expect(main).toContain(`setOutput("${output}"`);
    expect(configuration).toContain(`| \`${output}\` |`);
  });
});

describe("templates/notmyfault.gitlab-ci.yml", () => {
  it("downloads the bundle committed in dist/", () => {
    const template = read("templates/notmyfault.gitlab-ci.yml");
    const path = template.match(/raw\.githubusercontent\.com\/tashikomaaa\/notmyfault\/\$\{NOTMYFAULT_REF\}\/([\w./-]+)"/)?.[1];
    expect(path).toBe("dist/notmyfault.mjs");
    expect(existsSync(join(root, path!))).toBe(true);
  });
});
