import { describe, expect, it } from "vitest";
import { ActionIO } from "../../src/github/io";

describe("ActionIO", () => {
  it("escapes the properties and the message of annotations", () => {
    const lines: string[] = [];
    new ActionIO({}, (line) => lines.push(line)).annotation("error", "New failure.\n100% sure", {
      file: "a,b:c.ts",
      line: 3,
      title: undefined,
    });
    expect(lines).toEqual(["::error file=a%2Cb%3Ac.ts,line=3::New failure.%0A100%25 sure"]);
  });
});
