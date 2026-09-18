/**
 * Glob matching without a regular expression: patterns come from files of the
 * repository, which a pull request can change, and a crafted pattern must not
 * be able to hold a job for ever. This runs in time proportional to the text
 * times the pattern, where backtracking in a regular expression would not.
 */
export function matchGlob(pattern: string, text: string, singleChar = false): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (pattern[p] === "*") {
      star = p++;
      mark = t;
      // "**" inside a segment is just as wide as "*".
      while (pattern[p] === "*") p++;
    } else if (p < pattern.length && (pattern[p] === text[t] || (singleChar && pattern[p] === "?"))) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Matches a path against pattern segments, where "**" stands for any number of segments. */
export function matchSegments(pattern: string[], path: string[]): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < path.length) {
    if (pattern[p] === "**") {
      star = p++;
      mark = t;
    } else if (p < pattern.length && matchGlob(pattern[p]!, path[t]!, true)) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === "**") p++;
  return p === pattern.length;
}
