import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchSegments } from "./glob";

const MAX_PATTERN_LENGTH = 256;
const MAX_RULES = 2000;
const MAX_PATH_LENGTH = 1024;

export interface CodeownersRule {
  /** Rules of different GitLab sections all apply; GitHub files are a single section. */
  section: number;
  /** The pattern as path segments, "**" standing for any number of them. */
  pattern: string[];
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
    const segments = toSegments(pattern!);
    if (!segments || rules.length >= MAX_RULES) continue;
    const listed = mentions(owners);
    rules.push({ section, pattern: segments, owners: owners.length > 0 ? listed : defaults });
  }
  return rules;
}

/** The owners of a path, relative to the repository root: the last matching rule of each section. */
export function ownersOf(path: string, rules: CodeownersRule[]): string[] {
  if (path.length > MAX_PATH_LENGTH) return [];
  const segments = path.split("/").filter((segment) => segment !== "");
  const bySection = new Map<number, string[]>();
  for (const rule of rules) if (matchSegments(rule.pattern, segments)) bySection.set(rule.section, rule.owners);
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

/** Gitignore-style patterns, as CODEOWNERS uses them, as the segments a path is matched against. */
function toSegments(pattern: string): string[] | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) return undefined;
  // A pattern with a slash anywhere but at its end is relative to the root, otherwise it matches at any depth.
  const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
  const directory = pattern.endsWith("/");
  const body = pattern.replace(/^\//, "").replace(/\/$/, "");
  // "docs/*" owns the files directly in docs/, not the ones in its subdirectories.
  const shallow = /(^|\/)\*$/.test(body);
  const segments = body.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return undefined;
  // What may follow: a directory needs at least one more segment, a shallow pattern nothing, anything else a path under it.
  const under = directory ? ["*", "**"] : shallow ? [] : ["**"];
  return [...(anchored ? [] : ["**"]), ...segments, ...under];
}
