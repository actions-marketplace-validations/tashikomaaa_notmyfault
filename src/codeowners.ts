import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CodeownersRule {
  /** Rules of different GitLab sections all apply; GitHub files are a single section. */
  section: number;
  pattern: RegExp;
  owners: string[];
}

/**
 * Parses a CODEOWNERS file: GitHub syntax, plus GitLab sections, whose default
 * owners apply to their patterns listed without owners. Only owners that can be
 * mentioned, starting with @, are kept.
 */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  let section = 0;
  let defaults: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\^?\[[^\]]+\](?:\[\d+\])?\s*(.*)$/.exec(line);
    if (header) {
      section++;
      defaults = mentions(header[1]!.split(/\s+/));
      continue;
    }
    const [pattern, ...owners] = line.split(/\s+/);
    const listed = mentions(owners);
    rules.push({ section, pattern: toRegExp(pattern!), owners: owners.length > 0 ? listed : defaults });
  }
  return rules;
}

/** The owners of a path, relative to the repository root: the last matching rule of each section. */
export function ownersOf(path: string, rules: CodeownersRule[]): string[] {
  const bySection = new Map<number, string[]>();
  for (const rule of rules) if (rule.pattern.test(path)) bySection.set(rule.section, rule.owners);
  return [...new Set([...bySection.values()].flat())];
}

/** The first CODEOWNERS file found among `paths`, relative to the workspace. */
export function readCodeowners(workspace: string, paths: string[]): { path: string; rules: CodeownersRule[] } | undefined {
  for (const path of paths) {
    try {
      return { path, rules: parseCodeowners(readFileSync(join(workspace, path), "utf8")) };
    } catch {
      // Not there: try the next location.
    }
  }
  return undefined;
}

function mentions(tokens: string[]): string[] {
  return tokens.filter((token) => /^@[\w.\-/]+$/.test(token));
}

/** Gitignore-style patterns, as CODEOWNERS uses them. */
function toRegExp(pattern: string): RegExp {
  // A pattern with a slash anywhere but at its end is relative to the root, otherwise it matches at any depth.
  const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
  const directory = pattern.endsWith("/");
  let body = pattern.replace(/^\//, "").replace(/\/$/, "");
  // "docs/*" owns the files directly in docs/, not the ones in its subdirectories.
  const shallow = /(^|\/)\*$/.test(body);
  let source = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
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
