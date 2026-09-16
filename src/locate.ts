import { posix } from "node:path";
import type { TestResult } from "./junit";

export interface Location {
  /** Path relative to the workspace, with forward slashes. */
  file: string;
  line?: number;
}

/**
 * Finds the file, and the line when possible, of a failed test in the
 * workspace. Candidates come from the report: file attributes, class and
 * suite names that are paths or module names, and file:line references in the
 * failure output. Only files that exist in the workspace are kept.
 */
export function locate(test: TestResult, workspace: string, exists: (path: string) => boolean): Location | undefined {
  const hints = test.hints;
  if (!hints) return undefined;
  const found = (path: string) => {
    const relative = toRelative(path, workspace);
    return relative !== undefined && exists(relative) ? relative : undefined;
  };

  const candidates = [...(hints.file ? [hints.file] : []), ...hints.names.flatMap(fileNames)];
  for (const candidate of candidates) {
    const file = found(candidate);
    if (!file) continue;
    const line =
      candidate === hints.file && hints.line
        ? hints.line
        : hints.references.find((reference) => sameFile(reference.file, file, workspace))?.line;
    return line ? { file, line } : { file };
  }
  // Nothing names the test file: the first reference to a file of the workspace is the best guess.
  for (const reference of hints.references) {
    const file = found(reference.file);
    if (file) return { file, line: reference.line };
  }
  return undefined;
}

/** A name itself, and the files a dotted module or class name maps to (pytest, JUnit on the JVM). */
function fileNames(name: string): string[] {
  if (!/^[\w$]+(\.[\w$]+)+$/.test(name)) return [name];
  const path = name.replace(/\./g, "/");
  return [name, `${path}.py`, `src/test/java/${path}.java`, `src/test/kotlin/${path}.kt`];
}

function toRelative(path: string, workspace: string): string | undefined {
  let relative = path.replace(/\\/g, "/");
  if (relative.startsWith("/")) {
    const root = `${workspace.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
    if (!relative.startsWith(root)) return undefined;
    relative = relative.slice(root.length);
  }
  relative = posix.normalize(relative);
  const parts = relative.split("/");
  if (relative === "." || parts[0] === ".." || parts.includes("node_modules") || /^[a-z]:/i.test(relative)) return undefined;
  return relative;
}

/** Stack traces often name only the file, like "OrderServiceTest.java:42". */
function sameFile(reference: string, file: string, workspace: string): boolean {
  const relative = toRelative(reference, workspace);
  return relative !== undefined && (relative === file || file.endsWith(`/${relative}`));
}
