import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { updateWranglerConfig } from "../../../../src/lib/wizard/cloudflare/wrangler/update-wrangler-config.js";
import { showCopyPasteInstructions } from "../../../../src/lib/wizard/utils/clack/index.js";

const { clackMocks } = vi.hoisted(() => {
  return {
    clackMocks: {
      log: {
        success: vi.fn(),
        info: vi.fn(),
        step: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
  };
});

vi.mock("@clack/prompts", () => clackMocks);
vi.mock("../../../../src/lib/wizard/utils/clack/index.js", async () => ({
  ...(await vi.importActual("../../../../src/lib/wizard/utils/clack/index.js")),
  showCopyPasteInstructions: vi.fn(),
}));

describe("updateWranglerConfig", () => {
  const fixturesDir = path.join(__dirname, "fixtures", "wrangler");
  let tmpDir: string;

  function copyFixture(fixtureName: string, targetName: string): void {
    const content = fs.readFileSync(
      path.join(fixturesDir, fixtureName),
      "utf-8",
    );
    fs.writeFileSync(path.join(tmpDir, targetName), content);
  }

  function readResult(fileName: string): string {
    return fs.readFileSync(path.join(tmpDir, fileName), "utf-8");
  }

  beforeEach(() => {
    vi.clearAllMocks();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-wrangler-config-"));

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }

    vi.restoreAllMocks();
  });

  describe("JSON/JSONC format", () => {
    it("adds new fields to JSON config", async () => {
      copyFixture("wrangler-basic.json", "wrangler.json");

      const result = await updateWranglerConfig({
        compatibility_flags: ["nodejs_als"],
        version_metadata: { binding: "CF_VERSION_METADATA" },
      });

      const writtenContent = readResult("wrangler.json");
      const parsed = JSON.parse(writtenContent) as Record<string, unknown>;

      expect(result).toBe(true);
      expect(parsed["compatibility_flags"]).toEqual(["nodejs_als"]);
      expect(parsed["version_metadata"]).toEqual({
        binding: "CF_VERSION_METADATA",
      });
      expect(parsed["name"]).toBe("my-worker");
    });

    it("overrides existing fields in JSON config", async () => {
      copyFixture("wrangler-basic.json", "wrangler.json");

      const initialContent = readResult("wrangler.json");
      const initialParsed = JSON.parse(initialContent) as Record<
        string,
        unknown
      >;

      const result = await updateWranglerConfig({
        compatibility_date: "1337-01-01",
      });

      const writtenContent = readResult("wrangler.json");
      const parsed = JSON.parse(writtenContent) as Record<string, unknown>;

      expect(result).toBe(true);
      expect(parsed["compatibility_date"]).not.toEqual(
        initialParsed["compatibility_date"],
      );
      expect(parsed["compatibility_date"]).toEqual("1337-01-01");
    });

    it("merges array fields in JSON config", async () => {
      copyFixture("wrangler-with-flags.json", "wrangler.json");

      const result = await updateWranglerConfig({
        compatibility_flags: ["nodejs_als", "nodejs_compat"],
      });

      const writtenContent = readResult("wrangler.json");
      const parsed = JSON.parse(writtenContent) as Record<string, unknown>;

      expect(result).toBe(true);
      expect(parsed["compatibility_flags"]).toEqual([
        "old_flag",
        "nodejs_als",
        "nodejs_compat",
      ]);
    });

    it("drops superseded compatibility flags when asked to", async () => {
      copyFixture("wrangler-with-duplicate-flags.json", "wrangler.json");

      const result = await updateWranglerConfig(
        { compatibility_flags: ["nodejs_compat"] },
        { removeCompatibilityFlags: ["nodejs_als"] },
      );

      const writtenContent = readResult("wrangler.json");
      const parsed = JSON.parse(writtenContent) as Record<string, unknown>;

      expect(result).toBe(true);
      expect(parsed["compatibility_flags"]).toEqual([
        "old_flag",
        "nodejs_compat",
      ]);
    });

    it("only removes flags from compatibility_flags, not from other arrays", async () => {
      copyFixture("wrangler-with-duplicate-flags.json", "wrangler.json");

      const result = await updateWranglerConfig(
        { other_list: ["nodejs_als"] },
        { removeCompatibilityFlags: ["nodejs_als"] },
      );

      const writtenContent = readResult("wrangler.json");
      const parsed = JSON.parse(writtenContent) as Record<string, unknown>;

      expect(result).toBe(true);
      expect(parsed["other_list"]).toEqual(["nodejs_als"]);
      expect(parsed["compatibility_flags"]).toEqual(["nodejs_als", "old_flag"]);
    });

    it("deduplicates array values in JSON", async () => {
      copyFixture("wrangler-with-duplicate-flags.json", "wrangler.json");

      const result = await updateWranglerConfig({
        compatibility_flags: ["nodejs_als", "new_flag"],
      });

      const writtenContent = readResult("wrangler.json");
      const parsed = JSON.parse(writtenContent) as Record<string, unknown>;

      expect(result).toBe(true);
      expect(parsed["compatibility_flags"]).toEqual([
        "nodejs_als",
        "old_flag",
        "new_flag",
      ]);
    });

    it("preserves comments in JSONC config", async () => {
      copyFixture("wrangler-with-comment.jsonc", "wrangler.jsonc");

      const result = await updateWranglerConfig({
        compatibility_flags: ["nodejs_als"],
      });

      const writtenContent = readResult("wrangler.jsonc");

      expect(result).toBe(true);
      expect(writtenContent).toMatchSnapshot();
    });

    it("merges multi-line array fields in JSON config", async () => {
      copyFixture("wrangler-multi-line-array.json", "wrangler.json");

      const result = await updateWranglerConfig({
        compatibility_flags: ["nodejs_als"],
      });

      const writtenContent = readResult("wrangler.json");
      const parsed = JSON.parse(writtenContent) as Record<string, unknown>;

      expect(result).toBe(true);
      expect(parsed["compatibility_flags"]).toEqual([
        "global_fetch_strictly_public",
        "nodejs_als",
      ]);
    });

    it("adds new fields to JSONC in object", async () => {
      copyFixture("wrangler-with-metadata.jsonc", "wrangler.jsonc");

      const result = await updateWranglerConfig({
        version_metadata: { binding: "CF_VERSION_METADATA" },
      });

      const writtenContent = readResult("wrangler.jsonc");

      expect(result).toBe(true);
      expect(writtenContent).toMatchSnapshot();
    });

    it("preserves all comment types in JSONC", async () => {
      copyFixture("wrangler-all-comment-types.jsonc", "wrangler.jsonc");

      await updateWranglerConfig({
        version_metadata: { binding: "CF_VERSION_METADATA" },
      });

      const writtenContent = readResult("wrangler.jsonc");

      expect(writtenContent).toMatchSnapshot();
    });

    it("handles empty JSON object", async () => {
      copyFixture("wrangler-empty.json", "wrangler.json");

      const result = await updateWranglerConfig({
        compatibility_flags: ["nodejs_als"],
      });

      const writtenContent = readResult("wrangler.json");
      const parsed = JSON.parse(writtenContent) as Record<string, unknown>;

      expect(result).toBe(true);
      expect(parsed["compatibility_flags"]).toEqual(["nodejs_als"]);
    });

    it("adds nested objects to JSON", async () => {
      copyFixture("wrangler-minimal.json", "wrangler.json");

      const result = await updateWranglerConfig({
        version_metadata: { binding: "CF_VERSION_METADATA" },
      });

      const writtenContent = readResult("wrangler.json");
      const parsed = JSON.parse(writtenContent) as Record<string, unknown>;

      expect(result).toBe(true);
      expect(parsed["version_metadata"]).toEqual({
        binding: "CF_VERSION_METADATA",
      });
    });

    it("handles JSONC with trailing comma", async () => {
      copyFixture("wrangler-trailing-comma.jsonc", "wrangler.jsonc");

      const result = await updateWranglerConfig({
        compatibility_flags: ["nodejs_als"],
      });

      const writtenContent = readResult("wrangler.jsonc");

      expect(result).toBe(true);
      expect(writtenContent).toContain("compatibility_flags");
    });
  });

  describe("error handling", () => {
    it("returns false when no config file exists", async () => {
      const result = await updateWranglerConfig({
        compatibility_flags: ["nodejs_als"],
      });

      expect(result).toBe(false);
      expect(clackMocks.log.warn).toHaveBeenCalledWith(
        "No wrangler config file found.",
      );
    });
  });

  describe("TOML format", () => {
    function shownSnippet(): string {
      const [args] = vi.mocked(showCopyPasteInstructions).mock.calls[0] ?? [];
      return args?.codeSnippet ?? "";
    }

    it("tells the user to set main when the update includes it", async () => {
      fs.writeFileSync(path.join(tmpDir, "wrangler.toml"), 'name = "w"\n');

      await updateWranglerConfig({
        main: "src/index.ts",
        compatibility_flags: ["nodejs_compat"],
      });

      expect(shownSnippet()).toContain('main = "src/index.ts"');
    });

    it("leaves main out when the update doesn't include it", async () => {
      fs.writeFileSync(path.join(tmpDir, "wrangler.toml"), 'name = "w"\n');

      await updateWranglerConfig({ compatibility_flags: ["nodejs_compat"] });

      expect(shownSnippet()).not.toContain("main =");
      expect(shownSnippet()).toContain("compatibility_flags");
    });
  });
});
