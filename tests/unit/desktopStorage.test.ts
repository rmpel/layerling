import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { documentNameFromPath } from "@/lib/desktopHost";

const { PROJECTS_KEY, persistable, decodeValue, encodeValue } = createRequire(import.meta.url)("../../apps/desktop/storageCodec.cjs") as {
  PROJECTS_KEY: string;
  persistable: (key: unknown) => boolean;
  decodeValue: (raw: string) => unknown;
  encodeValue: (stored: unknown) => string;
};

describe("desktop settings file", () => {
  it("gives every stored string back exactly as the page wrote it", () => {
    const values = ["dark", "5", "true", "null", "", "1.50", '"quoted"', '{"a":1,"b":[true,null]}', '{ "spaced": 1 }', "[1,2]", "01"];
    for (const raw of values) {
      expect(encodeValue(decodeValue(raw))).toBe(raw);
    }
  });

  it("keeps JSON readable in the file instead of as a string inside a string", () => {
    expect(decodeValue('{"timestamp":5,"name":"x"}')).toEqual({ timestamp: 5, name: "x" });
    expect(decodeValue("5")).toBe(5);
    expect(decodeValue("dark")).toBe("dark");
    // Text that only looks like JSON once reformatted stays text.
    expect(decodeValue('{ "spaced": 1 }')).toBe('{ "spaced": 1 }');
  });

  it("stores the app's own keys and leaves scratch values out", () => {
    expect(persistable("layerling.theme")).toBe(true);
    expect(persistable(PROJECTS_KEY)).toBe(true);
    expect(persistable("layerling.clipboard")).toBe(false);
    expect(persistable("somebody.else")).toBe(false);
    expect(persistable(undefined)).toBe(false);
  });

  it("names a design after its file", () => {
    expect(documentNameFromPath("/Users/me/Designs/Hinge v2.lyl")).toBe("Hinge v2");
    expect(documentNameFromPath("C:\\Designs\\Bracket.final.lyl")).toBe("Bracket.final");
    expect(documentNameFromPath("plain")).toBe("plain");
  });
});
