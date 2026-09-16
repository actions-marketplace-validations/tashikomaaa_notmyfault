import { describe, expect, it } from "vitest";
import { badgePath, renderBadge } from "../src/badge";
import { emptyHistory } from "../src/history";

const NOW = new Date("2026-09-16T12:00:00Z");

describe("badge", () => {
  it("counts known and probably flaky tests, in the shields.io endpoint format", () => {
    const history = emptyHistory();
    history.tests = {
      known: { outcomes: "ppppr", lastSeen: "2026-09-16" },
      probably: { outcomes: "pfpfpfp", lastSeen: "2026-09-16" },
      stable: { outcomes: "ppppp", lastSeen: "2026-09-16" },
    };
    expect(JSON.parse(renderBadge(history, NOW, 30))).toEqual({
      schemaVersion: 1,
      label: "flaky tests",
      message: "2",
      color: "fcbd34",
    });
    expect(JSON.parse(renderBadge(emptyHistory(), NOW, 30))).toMatchObject({ message: "0", color: "19a08e" });
    expect(badgePath("ci-test")).toBe("badges/ci-test.json");
  });
});
