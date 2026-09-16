import type { Analysis } from "./analyze";
import type { TestResult } from "./junit";

export interface QuarantineEntry {
  /** Test title or identity, where `*` matches anything. */
  pattern: string;
  /** Last day (YYYY-MM-DD, UTC) the entry applies. */
  until: string;
  reason?: string;
}

const LINE = /^(\d{4}-\d{2}-\d{2})\s+(.+?)(?:\s+#\s+(.*))?$/;

/** Reads the quarantine input: one "YYYY-MM-DD test name # reason" per line, the reason being optional. */
export function parseQuarantine(input: string): QuarantineEntry[] {
  const entries: QuarantineEntry[] = [];
  for (const line of input.split("\n").map((part) => part.trim()).filter(Boolean)) {
    const match = LINE.exec(line);
    const until = match?.[1];
    if (!match || !until || Number.isNaN(Date.parse(`${until}T00:00:00Z`)) || new Date(`${until}T00:00:00Z`).toISOString().slice(0, 10) !== until) {
      throw new Error(`Input "quarantine" expects "YYYY-MM-DD test name # reason" per line, got "${line}"`);
    }
    const entry: QuarantineEntry = { pattern: match[2]!.trim(), until };
    if (match[3]?.trim()) entry.reason = match[3].trim();
    entries.push(entry);
  }
  return entries;
}

/** Whether the entry still applies: up to the end of its last day, in UTC. */
export function isActive(entry: QuarantineEntry, now: Date): boolean {
  return now.toISOString().slice(0, 10) <= entry.until;
}

export function matches(entry: QuarantineEntry, test: TestResult): boolean {
  const escaped = entry.pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`^${escaped.join(".*")}$`);
  return pattern.test(test.title) || pattern.test(test.id);
}

/** Marks the failures of the analysis covered by an active entry, and resolves to how many. */
export function applyQuarantine(analysis: Analysis, entries: QuarantineEntry[], now: Date): number {
  const active = entries.filter((entry) => isActive(entry, now));
  let quarantined = 0;
  for (const failure of analysis.failures) {
    const entry = active.find((candidate) => matches(candidate, failure.test));
    if (!entry) continue;
    failure.quarantined = entry.reason ? { until: entry.until, reason: entry.reason } : { until: entry.until };
    quarantined++;
  }
  return quarantined;
}
