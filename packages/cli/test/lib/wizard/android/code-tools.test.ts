import { describe, expect, it } from "vitest";
import { getLastImportLineLocation } from "../../../../src/lib/wizard/android/code-tools.js";

describe("code-tools", () => {
  describe("getLastImportLineLocation", () => {
    it("returns proper line index", () => {
      const code = `import a.b.c;\n` + `//<insert-location>\n` + `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns proper line index when static import is used", () => {
      const code =
        `import static a.b.c;\n` + `//<insert-location>\n` + `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns proper line index when wildcard import is used", () => {
      const code = `import a.b.*\n` + `//<insert-location>\n` + `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns proper line index when alias import is used", () => {
      const code =
        `import static a.b.c as d\n` + `//<insert-location>\n` + `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns proper line index when multiple imports are present", () => {
      const code =
        `import static a.b.c as d\n` +
        `import a.b.*\n` +
        `import static a.b.c;\n` +
        `import a.b.c;\n` +
        `//<insert-location>\n` +
        `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });
  });
});
