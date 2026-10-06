/**
 * Legacy Layout Migration E2E Tests
 *
 * Spawns the real CLI to verify that `sentry cli setup` migrates an existing
 * `~/.sentry` layout — the SQLite config DB and a curl-installed binary — into
 * the XDG-compliant locations. Exercises the full startup + migration path
 * (DB open, close, file moves) as a user would hit it, not just the unit-level
 * helpers.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getBinaryFilename } from "../../src/lib/binary.js";
import { runCli } from "../fixture.js";

const binName = getBinaryFilename();

let home: string;

/** Env that isolates a spawned CLI to a throwaway home directory. */
function homeEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    // Drop any config-dir pin from the parent (preload sets it) so the CLI
    // resolves paths from HOME like a real install.
    SENTRY_CONFIG_DIR: "",
    XDG_CONFIG_HOME: "",
    XDG_BIN_HOME: "",
    SENTRY_CLI_NO_TELEMETRY: "1",
    ...extra,
  };
}

/** Args that keep setup non-interactive and side-effect free beyond migration. */
const setupArgs = [
  "cli",
  "setup",
  "--quiet",
  "--no-modify-path",
  "--no-completions",
  "--no-agent-skills",
];

describe("e2e: legacy ~/.sentry migration", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sentry-migrate-e2e-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test(
    "migrates the config DB from ~/.sentry to ~/.config/sentry",
    { timeout: 60_000 },
    async () => {
      // Seed a real SQLite config DB in the legacy location by running the CLI
      // once pinned at ~/.sentry (this creates cli.db via getDatabase()).
      const legacyDir = join(home, ".sentry");
      mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
      // `auth status` opens (and thus creates) cli.db; a non-zero "not logged
      // in" exit is fine — we only need the DB file to exist.
      await runCli(["auth", "status"], {
        env: homeEnv({ SENTRY_CONFIG_DIR: legacyDir }),
      });
      expect(existsSync(join(legacyDir, "cli.db"))).toBe(true);

      // Now run setup with no config pin — it should migrate ~/.sentry/cli.db
      // into the XDG config dir (~/.config/sentry).
      const result = await runCli(setupArgs, { env: homeEnv() });
      expect(result.exitCode).toBe(0);

      const xdgDb = join(home, ".config", "sentry", "cli.db");
      expect(existsSync(xdgDb)).toBe(true);
      expect(existsSync(join(legacyDir, "cli.db"))).toBe(false);
    }
  );

  test(
    "migrates a legacy ~/.sentry/bin binary onto the XDG install dir",
    { timeout: 60_000 },
    async () => {
      // Legacy curl layout: binary under ~/.sentry/bin, and ~/.local/bin on PATH
      // so the resolved install dir is the XDG location.
      const legacyBinDir = join(home, ".sentry", "bin");
      mkdirSync(legacyBinDir, { recursive: true });
      const legacyBin = join(legacyBinDir, binName);
      writeFileSync(legacyBin, "#!/bin/sh\necho legacy\n", { mode: 0o755 });

      const xdgBinDir = join(home, ".local", "bin");
      mkdirSync(xdgBinDir, { recursive: true });

      const result = await runCli(setupArgs, {
        env: homeEnv({
          PATH: `${xdgBinDir}:${process.env.PATH ?? ""}`,
        }),
      });
      expect(result.exitCode).toBe(0);

      const movedBin = join(xdgBinDir, binName);
      expect(existsSync(movedBin)).toBe(true);
      expect(await readFile(movedBin, "utf8")).toBe("#!/bin/sh\necho legacy\n");
      expect(existsSync(legacyBin)).toBe(false);
    }
  );
});
