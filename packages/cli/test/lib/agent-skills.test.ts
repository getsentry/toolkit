/**
 * Agent Skills Tests
 *
 * Unit tests for Claude Code detection, shared path construction, and
 * embedded skill installation across detected agent roots.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  detectClaudeCode,
  getSkillInstallPath,
  installAgentSkills,
} from "../../src/lib/agent-skills.js";

// Wrap node:fs/promises so individual functions can be observed (to prove the
// atomic temp-file + rename mechanism is actually used) and selectively made to
// fail (to exercise the cleanup/rollback path). Every function delegates to the
// real implementation by default, so the rest of the suite hits the real FS.
// `mockReset: false` (vitest.config.ts) keeps these delegating implementations
// across tests; only the `*Once` overrides below are transient.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
  };
});

describe("agent-skills", () => {
  describe("detectClaudeCode", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(
        "/tmp",
        `agent-skills-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    test("returns true when ~/.claude directory exists", () => {
      mkdirSync(join(testDir, ".claude"), { recursive: true });
      expect(detectClaudeCode(testDir)).toBe(true);
    });

    test("returns false when ~/.claude directory does not exist", () => {
      expect(detectClaudeCode(testDir)).toBe(false);
    });
  });

  describe("getSkillInstallPath", () => {
    test("defaults to the Claude Code path", () => {
      const path = getSkillInstallPath("/home/user");
      expect(path).toBe("/home/user/.claude/skills/sentry-cli/SKILL.md");
    });

    test("returns correct path under ~/.agents/skills", () => {
      const path = getSkillInstallPath("/home/user", ".agents");
      expect(path).toBe("/home/user/.agents/skills/sentry-cli/SKILL.md");
    });
  });

  describe("installAgentSkills", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(
        "/tmp",
        `agent-skills-install-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      // Clear recorded calls (and any leftover `*Once` overrides) between tests
      // without dropping the delegating implementations set in the factory.
      vi.clearAllMocks();
      for (const dir of [
        testDir,
        join(testDir, ".agents"),
        join(testDir, ".claude"),
      ]) {
        try {
          if (existsSync(dir)) {
            chmodSync(dir, 0o755);
          }
        } catch {
          // Ignore cleanup races for directories that never existed.
        }
      }
      rmSync(testDir, { recursive: true, force: true });
    });

    test("returns null when no supported agent root is detected", async () => {
      const result = await installAgentSkills(testDir);
      expect(result).toBeNull();
    });

    test("installs to ~/.agents/ when the shared agent root exists", async () => {
      mkdirSync(join(testDir, ".agents"), { recursive: true });

      const result = await installAgentSkills(testDir);

      expect(result).not.toBeNull();
      expect(result!.created).toBe(true);
      expect(result!.path).toBe(
        join(testDir, ".agents", "skills", "sentry-cli", "SKILL.md")
      );
      expect(existsSync(result!.path)).toBe(true);

      const content = await readFile(result!.path, "utf-8");
      expect(content).toContain("sentry-cli");

      expect(result!.referenceCount).toBeGreaterThan(0);
      const refsDir = join(
        testDir,
        ".agents",
        "skills",
        "sentry-cli",
        "references"
      );
      expect(existsSync(refsDir)).toBe(true);
      expect(existsSync(join(refsDir, "issue.md"))).toBe(true);

      expect(
        existsSync(join(testDir, ".claude", "skills", "sentry-cli", "SKILL.md"))
      ).toBe(false);
    });

    test("publishes every file via rename from a temp path (atomic write guard)", async () => {
      mkdirSync(join(testDir, ".agents"), { recursive: true });

      const result = await installAgentSkills(testDir);
      expect(result).not.toBeNull();

      // The whole point of the change: content is staged to a hidden `.tmp`
      // file and then atomically renamed into place. If this regresses to a
      // direct in-place `writeFile`, both assertions below fail — which is what
      // makes this a real guard rather than a tautology.
      const writeTargets = vi
        .mocked(writeFile)
        .mock.calls.map((call) => String(call[0]));
      expect(writeTargets.length).toBeGreaterThan(0);
      expect(writeTargets.every((target) => target.endsWith(".tmp"))).toBe(
        true
      );

      const renameDestinations = vi
        .mocked(rename)
        .mock.calls.map((call) => String(call[1]));
      expect(renameDestinations).toContain(result!.path);
    });

    test("leaves no temp files behind on success", async () => {
      mkdirSync(join(testDir, ".agents"), { recursive: true });

      const result = await installAgentSkills(testDir);
      expect(result).not.toBeNull();

      // A leftover `.tmp` would mean the rename/cleanup regressed.
      const skillDir = join(testDir, ".agents", "skills", "sentry-cli");
      const leftovers = [
        ...readdirSync(skillDir),
        ...readdirSync(join(skillDir, "references")),
      ].filter((name) => name.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    });

    test("rolls back cleanly when rename fails (no partial dest, no temp orphan)", async () => {
      mkdirSync(join(testDir, ".agents"), { recursive: true });

      // Force the first publish to fail at the rename step. The temp file has
      // already been written at this point, so this exercises the catch/cleanup
      // branch in atomicWriteFile (rm of the temp) and the null-returning
      // failure handler in writeSkillFiles.
      vi.mocked(rename).mockRejectedValueOnce(
        new Error("simulated rename failure")
      );

      const result = await installAgentSkills(testDir);

      // A non-atomic in-place writer never calls rename, so forcing rename to
      // fail would have no effect and the install would still succeed — this
      // assertion only holds because the rename is on the critical path.
      expect(result).toBeNull();

      const skillDir = join(testDir, ".agents", "skills", "sentry-cli");
      const leftovers = readdirSync(skillDir).filter((name) =>
        name.endsWith(".tmp")
      );
      expect(leftovers).toEqual([]);
      expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
    });

    test("still fails to null when temp cleanup also fails after a rename error", async () => {
      mkdirSync(join(testDir, ".agents"), { recursive: true });

      // Both the rename and the subsequent best-effort `rm` of the temp file
      // fail. The cleanup error must be swallowed (captured, not thrown) so the
      // original rename error is what propagates — exercising the inner
      // catch of atomicWriteFile.
      vi.mocked(rename).mockRejectedValueOnce(new Error("rename failed"));
      vi.mocked(rm).mockRejectedValueOnce(new Error("cleanup failed"));

      const result = await installAgentSkills(testDir);

      expect(result).toBeNull();
      expect(vi.mocked(rm)).toHaveBeenCalled();
    });

    test("installs to both ~/.agents/ and ~/.claude/ when both roots exist", async () => {
      mkdirSync(join(testDir, ".agents"), { recursive: true });
      mkdirSync(join(testDir, ".claude"), { recursive: true });

      const result = await installAgentSkills(testDir);

      expect(result).not.toBeNull();
      expect(result!.path).toBe(
        join(testDir, ".agents", "skills", "sentry-cli", "SKILL.md")
      );
      expect(
        existsSync(join(testDir, ".agents", "skills", "sentry-cli", "SKILL.md"))
      ).toBe(true);
      expect(
        existsSync(join(testDir, ".claude", "skills", "sentry-cli", "SKILL.md"))
      ).toBe(true);
      expect(
        existsSync(
          join(
            testDir,
            ".agents",
            "skills",
            "sentry-cli",
            "references",
            "issue.md"
          )
        )
      ).toBe(true);
      expect(
        existsSync(
          join(
            testDir,
            ".claude",
            "skills",
            "sentry-cli",
            "references",
            "issue.md"
          )
        )
      ).toBe(true);
    });

    test("reports created: false when updating existing file", async () => {
      mkdirSync(join(testDir, ".agents"), { recursive: true });

      const first = await installAgentSkills(testDir);
      expect(first!.created).toBe(true);

      const second = await installAgentSkills(testDir);
      expect(second!.created).toBe(false);
      expect(second!.path).toBe(first!.path);
    });

    test("reports the fresh claude path when shared skills already exist", async () => {
      mkdirSync(join(testDir, ".agents"), { recursive: true });

      const first = await installAgentSkills(testDir);
      expect(first!.created).toBe(true);
      expect(first!.path).toBe(
        join(testDir, ".agents", "skills", "sentry-cli", "SKILL.md")
      );

      mkdirSync(join(testDir, ".claude"), { recursive: true });

      const second = await installAgentSkills(testDir);
      expect(second).not.toBeNull();
      expect(second!.created).toBe(true);
      expect(second!.path).toBe(
        join(testDir, ".claude", "skills", "sentry-cli", "SKILL.md")
      );
    });

    test("claude install succeeds even if ~/.agents is not writable", async () => {
      mkdirSync(join(testDir, ".agents"), { recursive: true });
      chmodSync(join(testDir, ".agents"), 0o444);
      mkdirSync(join(testDir, ".claude"), { recursive: true });

      const result = await installAgentSkills(testDir);
      expect(result).not.toBeNull();
      expect(result!.path).toBe(
        join(testDir, ".claude", "skills", "sentry-cli", "SKILL.md")
      );
      expect(existsSync(result!.path)).toBe(true);
      expect(
        existsSync(join(testDir, ".agents", "skills", "sentry-cli", "SKILL.md"))
      ).toBe(false);
    });

    test("agents install succeeds even if ~/.claude is not writable", async () => {
      mkdirSync(join(testDir, ".agents"), { recursive: true });
      mkdirSync(join(testDir, ".claude"), { recursive: true });
      chmodSync(join(testDir, ".claude"), 0o444);

      const result = await installAgentSkills(testDir);
      expect(result).not.toBeNull();
      expect(result!.path).toBe(
        join(testDir, ".agents", "skills", "sentry-cli", "SKILL.md")
      );
      expect(existsSync(result!.path)).toBe(true);
      expect(
        existsSync(join(testDir, ".claude", "skills", "sentry-cli", "SKILL.md"))
      ).toBe(false);
    });

    test("returns null when all detected targets are not writable", async () => {
      mkdirSync(join(testDir, ".agents"), { recursive: true });
      mkdirSync(join(testDir, ".claude"), { recursive: true });
      chmodSync(join(testDir, ".agents"), 0o444);
      chmodSync(join(testDir, ".claude"), 0o444);

      const result = await installAgentSkills(testDir);
      expect(result).toBeNull();
    });
  });
});
