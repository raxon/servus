import { describe, expect, it } from "vitest";
import {
  combineEnvironment,
  formatEnvironment,
  parseEnvironment,
} from "../../src/web/environment.js";

describe("environment editor", () => {
  it("round-trips escaped multiline and quoted values without creating extra variable rows", () => {
    const entries = [
      { name: "MESSAGE", value: "first line\nPASSWORD=literal text" },
      { name: "QUOTED", value: '"a quote" and \\path' },
      { name: "SPACES", value: "  preserved  " },
    ];
    const text = formatEnvironment(entries);
    expect(text.split("\n")).toHaveLength(3);
    expect(
      parseEnvironment(text).map(({ name, value }) => ({ name, value })),
    ).toEqual(entries);
    expect(() => parseEnvironment('MESSAGE="first\nsecond"')).toThrow(
      "close the quoted value",
    );
  });
  it("handles comments, empty values, quotes and equals signs without expansion", () => {
    expect(
      parseEnvironment(
        '# local settings\nMODE=production\nEMPTY=\nURL="a=b"\nTOKEN=$UNCHANGED',
      ),
    ).toEqual([
      { name: "MODE", value: "production", secret: false },
      { name: "EMPTY", value: "", secret: false },
      { name: "URL", value: "a=b", secret: false },
      { name: "TOKEN", value: "$UNCHANGED", secret: false },
    ]);
  });
  it("rejects duplicate variables and collisions with preserved secrets", () => {
    expect(() => parseEnvironment("KEY=one\nKEY=two")).toThrow(
      "more than once",
    );
    expect(() =>
      combineEnvironment("KEY=plain", [
        { name: "KEY", secretRef: "stored-key", secret: true },
      ]),
    ).toThrow("more than once");
  });
  it("preserves an unchanged secret reference without putting it in the text editor", () => {
    const stored = {
      name: "PASSWORD",
      secret: true,
      secretRef: "stored-reference",
    };
    expect(
      formatEnvironment([{ name: "MODE", value: "production" }, stored]),
    ).toBe("MODE=production");
    expect(combineEnvironment("MODE=production", [stored])[1]).toEqual(stored);
  });
  it("rejects malformed lines and secret values that were never supplied", () => {
    expect(() => parseEnvironment("export KEY=value")).toThrow("Line 1");
    expect(() => parseEnvironment('KEY="unfinished')).toThrow(
      "close the quoted",
    );
    expect(() =>
      combineEnvironment("", [{ name: "PASSWORD", secret: true }]),
    ).toThrow("Enter a value");
  });
});
