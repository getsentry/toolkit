import { describe, expect, test } from "vitest";
import {
  blankCodeBlocks,
  demoteHeadings,
  markdownCodeBlocks,
  markdownHeadings,
  markdownSection,
} from "../../script/markdown.js";

const DOC = [
  "## Usage",
  "",
  "```bash",
  "# not a heading",
  "sentry yarn add",
  "```",
  "",
  "### Examples",
  "Text after.",
  "",
].join("\n");

describe("markdownHeadings", () => {
  test("returns headings and skips comments inside code blocks", () => {
    expect(markdownHeadings(DOC)).toEqual([
      { depth: 2, text: "Usage" },
      { depth: 3, text: "Examples" },
    ]);
  });
});

describe("blankCodeBlocks", () => {
  test("removes code block content while keeping line numbers", () => {
    const blanked = blankCodeBlocks(DOC);
    expect(blanked).not.toContain("yarn add");
    expect(blanked.split("\n")).toHaveLength(DOC.split("\n").length);
    expect(blanked.split("\n")[8]).toBe("Text after.");
  });
});

describe("markdownSection", () => {
  test("keeps code comments inside the section instead of ending it", () => {
    const doc =
      "## Install\n\n```bash\n# pin a version\nrun\n```\n\n## Next\n\nAfter.\n";
    const section = markdownSection(doc, "Install");
    expect(section).toContain("# pin a version");
    expect(section).toContain("run");
    expect(section).not.toContain("After.");
  });

  test("returns null for a missing heading", () => {
    expect(markdownSection(DOC, "Missing")).toBeNull();
  });
});

describe("markdownCodeBlocks", () => {
  test("returns code with its language", () => {
    expect(markdownCodeBlocks(DOC)).toEqual([
      { code: "# not a heading\nsentry yarn add", lang: "bash" },
    ]);
  });
});

describe("demoteHeadings", () => {
  test("demotes level 2+ headings and leaves code comments alone", () => {
    const demoted = demoteHeadings(DOC);
    expect(demoted).toContain("### Usage");
    expect(demoted).toContain("#### Examples");
    expect(demoted).toContain("\n# not a heading\n");
  });
});
