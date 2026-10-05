/**
 * Agent skill installation for AI coding assistants.
 *
 * Detects supported AI coding agents (currently Claude Code and agents that
 * use the shared `~/.agents` root) and installs the Sentry CLI skill files
 * so the agent can use CLI commands effectively.
 *
 * Skill file contents are embedded at build time (via a generated module
 * produced by script/generate-skill.ts), so no network fetch is needed.
 */

import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { captureException } from "@sentry/node-core/light";
import { SKILL_FILES } from "../generated/skill-content.js";

/** Where skills are installed */
export type AgentSkillLocation = {
  /** Path where the main skill file was installed */
  path: string;
  /** Whether the file was created or already existed */
  created: boolean;
  /** Number of reference files installed */
  referenceCount: number;
};

/**
 * Check if Claude Code is installed by looking for the ~/.claude directory.
 *
 * Claude Code creates this directory on first use for settings, skills,
 * and other configuration. Its presence is a reliable indicator.
 */
export function detectClaudeCode(homeDir: string): boolean {
  return existsSync(join(homeDir, ".claude"));
}

/**
 * Get the installation path for the Sentry CLI skill under a supported AI
 * coding assistant root.
 *
 * `~/.claude` remains the default to preserve the existing helper behavior,
 * while callers can also pass `".agents"` for the shared Agent Skills path.
 */
export function getSkillInstallPath(
  homeDir: string,
  rootDir: ".agents" | ".claude" = ".claude"
): string {
  return join(homeDir, rootDir, "skills", "sentry-cli", "SKILL.md");
}

/**
 * Atomically write `content` to `destPath`.
 *
 * Writes to a uniquely-named temp file in the same directory, then `rename()`s
 * it over the destination. Because the temp file shares the destination's
 * directory (and therefore filesystem), the rename is atomic on POSIX, so a
 * concurrent reader never observes a truncated or partially-written file.
 *
 * This matters because AI coding agents (e.g. Claude Code, OpenCode) discover
 * skills by globbing the skills tree for `SKILL.md` files and parsing their
 * frontmatter. A plain in-place `writeFile` truncates the file before
 * rewriting it; an agent scanning during that window reads empty frontmatter
 * and silently drops the skill. On POSIX the rename eliminates that race.
 * (On Windows the replace still works, but can fail with a sharing violation
 * if a reader holds the destination open — a transient, best-effort outcome.)
 *
 * The temp file is named `.<basename>.<pid>.<rand>.tmp` (e.g.
 * `.SKILL.md.1234.ab12.tmp`) so it never matches the `SKILL.md`/`*.md` globs
 * agents look for, even while it exists.
 *
 * Precondition: `dirname(destPath)` must already exist; callers create the
 * directory before invoking this helper. On failure the temp file is removed
 * (best-effort) and the original error is re-thrown for the caller to handle.
 */
async function atomicWriteFile(
  destPath: string,
  content: string
): Promise<void> {
  const dir = dirname(destPath);
  const tempPath = join(
    dir,
    `.${basename(destPath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  );
  try {
    await writeFile(tempPath, content, "utf-8");
    await rename(tempPath, destPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch((cleanupError) => {
      captureException(cleanupError, {
        level: "debug",
        tags: { "setup.step": "agent-skills-cleanup" },
      });
    });
    throw error;
  }
}

/**
 * Write embedded skill files beneath an already-detected agent root.
 *
 * Callers must ensure the target root exists and is writable before invoking
 * this helper. Returns null on any filesystem failure.
 */
async function writeSkillFiles(
  skillPath: string
): Promise<AgentSkillLocation | null> {
  try {
    const skillDir = dirname(skillPath);
    const alreadyExists = existsSync(skillPath);
    let referenceCount = 0;

    for (const [relativePath, content] of SKILL_FILES) {
      const fullPath = join(skillDir, relativePath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o755 });
      }
      await atomicWriteFile(fullPath, content);
      if (relativePath.startsWith("references/")) {
        referenceCount += 1;
      }
    }

    return {
      path: skillPath,
      created: !alreadyExists,
      referenceCount,
    };
  } catch (error) {
    captureException(error, {
      level: "warning",
      tags: { "setup.step": "agent-skills" },
    });
    return null;
  }
}

/**
 * Install the Sentry CLI agent skill for detected AI coding assistants.
 *
 * Checks supported roots and writes the embedded skill files to each detected
 * location. The installer never creates top-level agent roots. Their presence
 * is the detection signal that the user already has a compatible agent installed.
 *
 * If any target is freshly created, the returned `path` points to that new
 * installation so setup output matches the file that was actually added.
 *
 * @param homeDir - User's home directory
 * @returns Location info if installed to at least one detected target, null otherwise
 */
export async function installAgentSkills(
  homeDir: string
): Promise<AgentSkillLocation | null> {
  const installTargets = [
    {
      detected: existsSync(join(homeDir, ".agents")),
      rootDir: ".agents" as const,
    },
    {
      detected: detectClaudeCode(homeDir),
      rootDir: ".claude" as const,
    },
  ];
  const results: AgentSkillLocation[] = [];

  for (const target of installTargets) {
    if (!target.detected) {
      continue;
    }

    const parentDir = join(homeDir, target.rootDir);

    // In sandboxed environments, the agent root may exist but be read-only.
    // Some sandboxes terminate the process on write attempts, bypassing
    // JavaScript error handling — so we must check before writing.
    try {
      accessSync(parentDir, constants.W_OK);
    } catch {
      continue;
    }

    const location = await writeSkillFiles(
      getSkillInstallPath(homeDir, target.rootDir)
    );
    if (location) {
      results.push(location);
    }
  }

  if (results.length === 0) {
    return null;
  }

  return results.find((location) => location.created) ?? results[0] ?? null;
}
