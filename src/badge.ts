import { countFlakyTests } from "./analyze";
import type { History } from "./history";

/** Where the badge of a key lives on the history branch. */
export function badgePath(key: string): string {
  return `badges/${key}.json`;
}

/** A shields.io endpoint badge counting the flaky tests of the history: https://shields.io/badges/endpoint-badge */
export function renderBadge(history: History, now: Date, evidenceTtlDays: number): string {
  const flaky = countFlakyTests(history, now, evidenceTtlDays);
  const badge = { schemaVersion: 1, label: "flaky tests", message: String(flaky), color: flaky === 0 ? "19a08e" : "fcbd34" };
  return `${JSON.stringify(badge, null, 1)}\n`;
}
