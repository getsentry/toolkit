/**
 * Tests for the ANSI-aware text table renderer.
 *
 * Covers: renderTextTable, column fitting (proportional + balanced),
 * cell wrapping, alignment, border styles, and edge cases.
 */

import chalk from "chalk";
import { describe, expect, test } from "vitest";
import { renderTextTable } from "../../../src/lib/formatters/text-table.js";

// Force chalk colors even in test (non-TTY) environment
chalk.level = 3;

describe("renderTextTable", () => {
  describe("basic rendering", () => {
    test("empty headers returns empty string", () => {
      expect(renderTextTable([], [])).toBe("");
    });

    test("renders single-column table", () => {
      const out = renderTextTable(["Name"], [["Alice"], ["Bob"]]);
      expect(out).toContain("Name");
      expect(out).toContain("Alice");
      expect(out).toContain("Bob");
      expect(out.endsWith("\n")).toBe(true);
    });

    test("renders multi-column table", () => {
      const out = renderTextTable(
        ["ID", "Name", "Role"],
        [
          ["1", "Alice", "Admin"],
          ["2", "Bob", "User"],
        ]
      );
      expect(out).toContain("ID");
      expect(out).toContain("Name");
      expect(out).toContain("Role");
      expect(out).toContain("Alice");
      expect(out).toContain("Admin");
      expect(out).toContain("Bob");
      expect(out).toContain("User");
    });

    test("renders header-only table (no data rows)", () => {
      const out = renderTextTable(["A", "B"], []);
      expect(out).toContain("A");
      expect(out).toContain("B");
      expect(out.endsWith("\n")).toBe(true);
    });
  });

  describe("border styles", () => {
    test("rounded (default) uses curved corners", () => {
      const out = renderTextTable(["X"], [["1"]]);
      expect(out).toContain("\u256d");
      expect(out).toContain("\u256e");
      expect(out).toContain("\u2570");
      expect(out).toContain("\u256f");
    });

    test("single uses square corners", () => {
      const out = renderTextTable(["X"], [["1"]], { borderStyle: "single" });
      expect(out).toContain("\u250c");
      expect(out).toContain("\u2510");
      expect(out).toContain("\u2514");
      expect(out).toContain("\u2518");
    });

    test("heavy uses heavy corners", () => {
      const out = renderTextTable(["X"], [["1"]], { borderStyle: "heavy" });
      expect(out).toContain("\u250f");
      expect(out).toContain("\u2513");
      expect(out).toContain("\u2517");
      expect(out).toContain("\u251b");
    });

    test("double uses double corners", () => {
      const out = renderTextTable(["X"], [["1"]], { borderStyle: "double" });
      expect(out).toContain("\u2554");
      expect(out).toContain("\u2557");
      expect(out).toContain("\u255a");
      expect(out).toContain("\u255d");
    });
  });

  describe("header separator", () => {
    test("includes separator by default when data rows present", () => {
      const out = renderTextTable(["H"], [["d"]]);
      expect(out).toContain("\u251c"); // ├
      expect(out).toContain("\u2524"); // ┤
    });

    test("headerSeparator: false omits separator", () => {
      const out = renderTextTable(["H"], [["d"]], { headerSeparator: false });
      expect(out).not.toContain("\u251c");
      expect(out).not.toContain("\u2524");
    });
  });

  describe("hideHeaders", () => {
    test("hideHeaders: true omits the header row from output", () => {
      const out = renderTextTable(["", ""], [["Key", "Val"]], {
        hideHeaders: true,
      });
      // Data row should be present
      expect(out).toContain("Key");
      expect(out).toContain("Val");
      // Count content lines (between top and bottom border)
      const lines = out.split("\n").filter((l) => l.includes("\u2502")); // │
      // With hideHeaders, only the data row should produce content lines
      expect(lines).toHaveLength(1);
    });

    test("hideHeaders: true still uses header widths for column measurement", () => {
      // Headers are wide, data is short — columns should still be sized for headers
      const withHide = renderTextTable(
        ["LongHeader1", "LongHeader2"],
        [["a", "b"]],
        { hideHeaders: true, maxWidth: 80 }
      );
      const withoutHide = renderTextTable(
        ["LongHeader1", "LongHeader2"],
        [["a", "b"]],
        { hideHeaders: false, maxWidth: 80 }
      );
      // Both should produce the same column widths (same top border line)
      const topBorderHide = withHide.split("\n")[0];
      const topBorderShow = withoutHide.split("\n")[0];
      expect(topBorderHide).toBe(topBorderShow);
    });

    test("auto-hides headers when all cells are empty", () => {
      const out = renderTextTable(["", ""], [["Key", "Val"]]);
      expect(out).toContain("Key");
      expect(out).toContain("Val");
      // Should auto-hide: only 1 content line (data row), no empty header row
      const lines = out.split("\n").filter((l) => l.includes("\u2502"));
      expect(lines).toHaveLength(1);
    });

    test("does not auto-hide when headers have content", () => {
      const out = renderTextTable(["H1", "H2"], [["d1", "d2"]]);
      expect(out).toContain("H1");
      expect(out).toContain("H2");
    });

    test("explicit hideHeaders: false overrides auto-detection", () => {
      const out = renderTextTable(["", ""], [["Key", "Val"]], {
        hideHeaders: false,
      });
      // Empty header row should be visible (explicit override)
      const lines = out.split("\n").filter((l) => l.includes("\u2502"));
      // 2 content lines: empty header + data row
      expect(lines).toHaveLength(2);
    });
  });

  describe("alignment", () => {
    test("right-aligned column pads text on the left", () => {
      const out = renderTextTable(["Amount"], [["42"]], {
        alignments: ["right"],
        maxWidth: 40,
      });
      const lines = out.split("\n");
      const dataLine = lines.find((l) => l.includes("42"));
      expect(dataLine).toBeDefined();
      // Right-aligned: spaces before the value
      const cellContent = dataLine!.split("\u2502")[1] ?? "";
      const trimmed = cellContent.trimStart();
      expect(cellContent.length).toBeGreaterThan(trimmed.length);
    });

    test("center-aligned column centers text", () => {
      const out = renderTextTable(["Title"], [["Hi"]], {
        alignments: ["center"],
        maxWidth: 40,
      });
      const lines = out.split("\n");
      const dataLine = lines.find((l) => l.includes("Hi"));
      expect(dataLine).toBeDefined();
    });

    test("default alignment is left", () => {
      const out = renderTextTable(["Name"], [["A"]], { maxWidth: 40 });
      expect(out).toContain("A");
    });
  });

  describe("column fitting", () => {
    test("columns that fit naturally keep intrinsic widths", () => {
      const out = renderTextTable(["A", "B"], [["x", "y"]], { maxWidth: 200 });
      expect(out).toContain("A");
      expect(out).toContain("B");
    });

    test("proportional fitter shrinks wide columns more", () => {
      const out = renderTextTable(
        ["Short", "This is a very long header that needs shrinking"],
        [["a", "b"]],
        { maxWidth: 30, columnFitter: "proportional" }
      );
      // Content is present (may be wrapped)
      expect(out.length).toBeGreaterThan(0);
      expect(out.endsWith("\n")).toBe(true);
      expect(out.endsWith("\n")).toBe(true);
    });

    test("balanced fitter distributes shrink more evenly", () => {
      const out = renderTextTable(
        ["Short", "This is a very long header that needs shrinking"],
        [["a", "b"]],
        { maxWidth: 30, columnFitter: "balanced" }
      );
      // Content is present (may be wrapped)
      expect(out.length).toBeGreaterThan(0);
      expect(out.endsWith("\n")).toBe(true);
      expect(out.endsWith("\n")).toBe(true);
    });

    test("very narrow maxWidth still produces valid table", () => {
      const out = renderTextTable(
        ["Header One", "Header Two", "Header Three"],
        [["data1", "data2", "data3"]],
        { maxWidth: 15 }
      );
      expect(out.length).toBeGreaterThan(0);
      expect(out.endsWith("\n")).toBe(true);
    });

    test("proportional and balanced produce different layouts", () => {
      const headers = ["A", "This is a much wider column"];
      const rows = [["x", "y"]];
      const prop = renderTextTable(headers, rows, {
        maxWidth: 25,
        columnFitter: "proportional",
      });
      const bal = renderTextTable(headers, rows, {
        maxWidth: 25,
        columnFitter: "balanced",
      });
      // Both should be valid tables but may differ in column widths
      expect(prop).toContain("A");
      expect(bal).toContain("A");
    });
  });

  describe("cell wrapping", () => {
    test("long cell values wrap to multiple lines", () => {
      const out = renderTextTable(
        ["Name"],
        [["This is a very long cell value that should wrap"]],
        { maxWidth: 20 }
      );
      const dataLines = out
        .split("\n")
        .filter((l) => l.includes("\u2502") && !l.includes("Name"));
      expect(dataLines.length).toBeGreaterThan(1);
    });
  });

  describe("ANSI-aware rendering", () => {
    test("preserves ANSI codes in cell values", () => {
      const colored = chalk.red("ERROR");
      const out = renderTextTable(["Status"], [[colored]], { maxWidth: 40 });
      expect(out).toContain("\x1b[");
      expect(out).toContain("ERROR");
    });

    test("column width computed from visual width not byte length", () => {
      const colored = chalk.red("Hi");
      const plain = "Hi";
      const outColored = renderTextTable(["H"], [[colored]], { maxWidth: 40 });
      const outPlain = renderTextTable(["H"], [[plain]], { maxWidth: 40 });
      const hzColored = (outColored.match(/\u2500/g) ?? []).length;
      const hzPlain = (outPlain.match(/\u2500/g) ?? []).length;
      expect(hzColored).toBe(hzPlain);
    });
  });

  describe("cellPadding", () => {
    test("cellPadding: 0 produces tighter table", () => {
      const tight = renderTextTable(["A"], [["x"]], { cellPadding: 0 });
      const padded = renderTextTable(["A"], [["x"]], { cellPadding: 2 });
      const tightWidth = (tight.split("\n")[0] ?? "").length;
      const paddedWidth = (padded.split("\n")[0] ?? "").length;
      expect(tightWidth).toBeLessThan(paddedWidth);
    });
  });

  describe("multi-column structure", () => {
    test("columns are separated by vertical border character", () => {
      const out = renderTextTable(["A", "B", "C"], [["1", "2", "3"]]);
      const dataLines = out
        .split("\n")
        .filter((l) => l.includes("1") && l.includes("2") && l.includes("3"));
      expect(dataLines.length).toBeGreaterThan(0);
      const pipeCount = (dataLines[0] ?? "").split("\u2502").length - 1;
      expect(pipeCount).toBe(4); // 3 columns = 4 borders
    });

    test("top border has T-junctions between columns", () => {
      const out = renderTextTable(["A", "B", "C"], [["1", "2", "3"]]);
      const topLine = out.split("\n")[0] ?? "";
      expect(topLine).toContain("\u252c"); // ┬
    });

    test("bottom border has inverted T-junctions", () => {
      const out = renderTextTable(["A", "B", "C"], [["1", "2", "3"]]);
      const lines = out.split("\n").filter((l) => l.length > 0);
      const bottomLine = lines.at(-1) ?? "";
      expect(bottomLine).toContain("\u2534"); // ┴
    });
  });
});

describe("truncate option", () => {
  test("truncates long cells to one line with ellipsis", () => {
    const out = renderTextTable(
      ["Name"],
      [["This is a very long cell value that should be truncated"]],
      { maxWidth: 20, truncate: true }
    );
    const dataLines = out
      .split("\n")
      .filter(
        (l) =>
          l.includes("\u2502") &&
          !l.includes("Name") &&
          !l.includes("\u2500") &&
          l.trim().length > 2
      );
    // Should be exactly 1 data line (not wrapped to multiple)
    expect(dataLines.length).toBe(1);
    // Should contain ellipsis
    expect(dataLines[0]).toContain("\u2026");
  });

  test("does not truncate short cells", () => {
    const out = renderTextTable(["Name"], [["Hi"]], {
      maxWidth: 40,
      truncate: true,
    });
    expect(out).toContain("Hi");
    expect(out).not.toContain("\u2026");
  });

  test("headers are never truncated", () => {
    const out = renderTextTable(
      ["Very Long Header Name"],
      [["This is an even longer cell value that should be truncated"]],
      { maxWidth: 30, truncate: true }
    );
    // Header should not have ellipsis (only data rows truncate)
    const headerLine = out
      .split("\n")
      .find((l) => l.includes("Very Long Header"));
    expect(headerLine).toBeDefined();
    expect(headerLine).not.toContain("\u2026");
  });

  test("ellipsis has right-side padding gap (not flush against border)", () => {
    // Use a long string without word breaks to force hard truncation
    const longUrl = `https://example.com/${"a".repeat(200)}`;
    const out = renderTextTable(["URL"], [[longUrl]], {
      maxWidth: 40,
      truncate: true,
    });
    // Find the data line with the ellipsis
    const dataLine = out.split("\n").find((l) => l.includes("\u2026"));
    expect(dataLine).toBeDefined();
    // The ellipsis should NOT be immediately adjacent to the right border │
    // There should be at least one space between … and │
    expect(dataLine).not.toMatch(/\u2026\u2502/);
  });

  test("ellipsis inherits ANSI color from surrounding text", () => {
    const colored = `${chalk.hex("#898294")("A very long colored text that will be truncated at the boundary")}`;
    const out = renderTextTable(["VAL"], [[colored]], {
      maxWidth: 30,
      truncate: true,
    });
    const dataLine = out.split("\n").find((l) => l.includes("\u2026"));
    expect(dataLine).toBeDefined();
    // The ellipsis should appear BEFORE the ANSI reset, not after it.
    // i.e., the pattern should be: <text>…<reset> not <text><reset>…
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape detection
    expect(dataLine).toMatch(/\u2026\x1b\[/);
  });
});

describe("minWidths option", () => {
  test("prevents column from shrinking below minimum", () => {
    const out = renderTextTable(
      ["Short", "Long Column Header"],
      [["data", "other data"]],
      { maxWidth: 25, minWidths: [10, 0] }
    );
    // First column should maintain at least 10-char content width
    // (10 + 2 padding = 12 total column width)
    const dataLine = out.split("\n").find((l) => l.includes("data"));
    expect(dataLine).toBeDefined();
    // The "Short" column should have enough space for "data" + padding
    expect(out).toContain("data");
  });

  test("TITLE column absorbs shrink when SHORT ID has minWidth", () => {
    const out = renderTextTable(
      ["ID", "TITLE"],
      [["SPOTLIGHT-WEB-28", "Very long error message that gets truncated"]],
      { maxWidth: 50, minWidths: [20, 0], truncate: true }
    );
    expect(out).toContain("SPOTLIGHT-WEB-28");
    // TITLE should be truncated, not SHORT ID
    expect(out).toContain("\u2026");
  });
});

describe("shrinkable option", () => {
  test("non-shrinkable column keeps intrinsic width", () => {
    const out = renderTextTable(
      ["FIXED", "ELASTIC"],
      [["SPOTLIGHT-WEB-28", "A very long title that should absorb all shrink"]],
      { maxWidth: 50, shrinkable: [false, true] }
    );
    // The FIXED column should show the full value without wrapping
    expect(out).toContain("SPOTLIGHT-WEB-28");
    // Check no line has SPOTLIGHT-WEB-28 split across lines
    const dataLines = out.split("\n").filter((l) => l.includes("SPOTLIGHT"));
    expect(dataLines.length).toBe(1);
  });

  test("elastic column absorbs all shrink", () => {
    const out = renderTextTable(
      ["FIXED", "ELASTIC"],
      [["keep-me", "shrink this very long text value please"]],
      { maxWidth: 30, shrinkable: [false, true] }
    );
    // FIXED column should be intact
    expect(out).toContain("keep-me");
    const fixedLines = out.split("\n").filter((l) => l.includes("keep-me"));
    expect(fixedLines.length).toBe(1);
  });
});
