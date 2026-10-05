/**
 * Completion Utilities Tests
 *
 * Unit tests for completion dispatch logic, path resolution, and file
 * installation. Command tree invariants, cross-shell consistency, and
 * bash simulation are in completions.property.test.ts.
 */

import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  extractCommandTree,
  getCompletionPath,
  getCompletionScript,
  installCompletions,
} from "../../src/lib/completions.js";

describe("completions", () => {
  describe("getCompletionScript", () => {
    test("returns bash script for bash", () => {
      const script = getCompletionScript("bash");
      expect(script).toContain("_sentry_completions");
    });

    test("returns zsh script for zsh", () => {
      const script = getCompletionScript("zsh");
      expect(script).toContain("#compdef sentry");
    });

    test("returns fish script for fish", () => {
      const script = getCompletionScript("fish");
      expect(script).toContain("complete -c sentry");
    });

    test("returns null for unsupported shells", () => {
      expect(getCompletionScript("sh")).toBeNull();
      expect(getCompletionScript("ash")).toBeNull();
      expect(getCompletionScript("unknown")).toBeNull();
    });

    test("bash script includes __complete callback", () => {
      const script = getCompletionScript("bash");
      expect(script).toContain("__complete");
    });

    test("zsh script includes __complete callback", () => {
      const script = getCompletionScript("zsh");
      expect(script).toContain("__complete");
    });

    test("zsh script escapes colons in dynamic completion values", () => {
      const script = getCompletionScript("zsh");
      expect(script).toContain(`escaped_value="\${value//:/\\\\:}"`);
    });

    test("fish script includes __complete callback", () => {
      const script = getCompletionScript("fish");
      expect(script).toContain("__complete");
    });

    test("bash script includes flag completion variables", () => {
      const script = getCompletionScript("bash");
      // Should contain flag variables for at least some commands
      expect(script).toContain("_flags=");
    });
  });

  describe("extractCommandTree", () => {
    test("includes flags for subcommands", () => {
      const tree = extractCommandTree();
      // At least one group should have subcommands with flags
      const hasFlags = tree.groups.some((g) =>
        g.subcommands.some((s) => s.flags.length > 0)
      );
      expect(hasFlags).toBe(true);
    });

    test("standalone commands include flags", () => {
      const tree = extractCommandTree();
      const hasFlags = tree.standalone.some((s) => s.flags.length > 0);
      expect(hasFlags).toBe(true);
    });
  });

  describe("getCompletionPath", () => {
    const homeDir = "/home/user";

    test("returns bash completion path", () => {
      const path = getCompletionPath("bash", homeDir);
      expect(path).toBe(
        "/home/user/.local/share/bash-completion/completions/sentry"
      );
    });

    test("returns zsh completion path", () => {
      const path = getCompletionPath("zsh", homeDir);
      expect(path).toBe("/home/user/.local/share/zsh/site-functions/_sentry");
    });

    test("returns fish completion path", () => {
      const path = getCompletionPath("fish", homeDir);
      expect(path).toBe("/home/user/.config/fish/completions/sentry.fish");
    });

    test("uses custom XDG_DATA_HOME", () => {
      const path = getCompletionPath("bash", homeDir, "/custom/data");
      expect(path).toBe("/custom/data/bash-completion/completions/sentry");
    });

    test("returns null for unsupported shells", () => {
      expect(getCompletionPath("sh", homeDir)).toBeNull();
      expect(getCompletionPath("unknown", homeDir)).toBeNull();
    });
  });

  describe("installCompletions", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(
        "/tmp",
        `completions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    test("installs bash completions", async () => {
      const result = await installCompletions("bash", testDir);

      expect(result).not.toBeNull();
      expect(result!.created).toBe(true);
      expect(result!.path).toContain("bash-completion");
      expect(existsSync(result!.path)).toBe(true);

      const content = await readFile(result!.path, "utf-8");
      expect(content).toContain("_sentry_completions");
    });

    test("installs zsh completions", async () => {
      const result = await installCompletions("zsh", testDir);

      expect(result).not.toBeNull();
      expect(result!.path).toContain("_sentry");
      expect(existsSync(result!.path)).toBe(true);
    });

    test("installs fish completions", async () => {
      const fishDir = join(testDir, ".config", "fish", "completions");
      mkdirSync(fishDir, { recursive: true });

      const result = await installCompletions("fish", testDir);

      expect(result).not.toBeNull();
      expect(result!.path).toContain("sentry.fish");
    });

    test("returns null for unsupported shells", async () => {
      const result = await installCompletions("sh", testDir);
      expect(result).toBeNull();
    });

    test("reports update when file already exists", async () => {
      const first = await installCompletions("bash", testDir);
      expect(first!.created).toBe(true);

      const second = await installCompletions("bash", testDir);
      expect(second!.created).toBe(false);
      expect(second!.path).toBe(first!.path);
    });

    test("returns null when directory creation fails with EACCES", async () => {
      // Create a read-only parent directory so mkdir inside it fails
      const restrictedDir = join(testDir, "restricted");
      mkdirSync(restrictedDir, { recursive: true, mode: 0o755 });
      // Make it non-writable so child directory creation fails
      chmodSync(restrictedDir, 0o444);

      try {
        // XDG_DATA_HOME points into the restricted directory
        const result = await installCompletions(
          "bash",
          "/nonexistent",
          join(restrictedDir, "subdir")
        );
        expect(result).toBeNull();
      } finally {
        // Restore write permission for cleanup
        chmodSync(restrictedDir, 0o755);
      }
    });

    test("returns null when parent directory is read-only (EPERM scenario)", async () => {
      // Simulate the macOS EPERM scenario: a parent directory exists but
      // we can't create subdirectories inside it
      const lockedParent = join(testDir, "locked");
      mkdirSync(lockedParent, { recursive: true });
      chmodSync(lockedParent, 0o555);

      try {
        const result = await installCompletions(
          "zsh",
          "/nonexistent",
          join(lockedParent, "deep", "nested")
        );
        expect(result).toBeNull();
      } finally {
        chmodSync(lockedParent, 0o755);
      }
    });
  });
});
