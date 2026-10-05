/**
 * Tests for the shared mutate-command building blocks.
 *
 * Tests Level A flag constants, Level B utilities (isConfirmationBypassed,
 * guardNonInteractive, requireExplicitTarget), and Level C buildDeleteCommand
 * flag/alias injection.
 */

import { describe, expect, test } from "vitest";
import {
  DESTRUCTIVE_ALIASES,
  DESTRUCTIVE_FLAGS,
  DRY_RUN_ALIASES,
  DRY_RUN_FLAG,
  FORCE_FLAG,
  guardNonInteractive,
  isConfirmationBypassed,
  requireExplicitTarget,
  YES_FLAG,
} from "../../src/lib/mutate-command.js";

// ---------------------------------------------------------------------------
// Level A: flag constant shapes
// ---------------------------------------------------------------------------

describe("flag constants", () => {
  test("DRY_RUN_FLAG has correct shape", () => {
    expect(DRY_RUN_FLAG.kind).toBe("boolean");
    expect(DRY_RUN_FLAG.default).toBe(false);
    expect(DRY_RUN_FLAG.brief).toBeString();
  });

  test("YES_FLAG has correct shape", () => {
    expect(YES_FLAG.kind).toBe("boolean");
    expect(YES_FLAG.default).toBe(false);
    expect(YES_FLAG.brief).toBeString();
  });

  test("FORCE_FLAG has correct shape", () => {
    expect(FORCE_FLAG.kind).toBe("boolean");
    expect(FORCE_FLAG.default).toBe(false);
    expect(FORCE_FLAG.brief).toBeString();
  });

  test("DESTRUCTIVE_FLAGS bundles all three flags", () => {
    expect(DESTRUCTIVE_FLAGS.yes).toBe(YES_FLAG);
    expect(DESTRUCTIVE_FLAGS.force).toBe(FORCE_FLAG);
    expect(DESTRUCTIVE_FLAGS["dry-run"]).toBe(DRY_RUN_FLAG);
  });

  test("DESTRUCTIVE_ALIASES maps correct shorthand keys", () => {
    expect(DESTRUCTIVE_ALIASES.y).toBe("yes");
    expect(DESTRUCTIVE_ALIASES.f).toBe("force");
    expect(DESTRUCTIVE_ALIASES.n).toBe("dry-run");
  });

  test("DRY_RUN_ALIASES maps -n to dry-run", () => {
    expect(DRY_RUN_ALIASES.n).toBe("dry-run");
  });
});

// ---------------------------------------------------------------------------
// Level B: isConfirmationBypassed
// ---------------------------------------------------------------------------

describe("isConfirmationBypassed", () => {
  test("returns false when both yes and force are false", () => {
    expect(isConfirmationBypassed({ yes: false, force: false })).toBe(false);
  });

  test("returns false when both are undefined", () => {
    expect(isConfirmationBypassed({})).toBe(false);
  });

  test("returns true when yes is true", () => {
    expect(isConfirmationBypassed({ yes: true })).toBe(true);
  });

  test("returns true when force is true", () => {
    expect(isConfirmationBypassed({ force: true })).toBe(true);
  });

  test("returns true when both are true", () => {
    expect(isConfirmationBypassed({ yes: true, force: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Level B: guardNonInteractive
// ---------------------------------------------------------------------------

describe("guardNonInteractive", () => {
  // Note: These tests validate the logic paths. The isatty(0) check can't
  // be easily tested without mocking node:tty, but the bypass paths can.

  test("does not throw when dry-run is set", () => {
    // Even if we're not in a TTY, dry-run should pass
    expect(() =>
      guardNonInteractive({
        yes: false,
        force: false,
        "dry-run": true,
      })
    ).not.toThrow();
  });

  test("does not throw when yes is set", () => {
    expect(() =>
      guardNonInteractive({
        yes: true,
        force: false,
        "dry-run": false,
      })
    ).not.toThrow();
  });

  test("does not throw when force is set", () => {
    expect(() =>
      guardNonInteractive({
        yes: false,
        force: true,
        "dry-run": false,
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Level B: requireExplicitTarget
// ---------------------------------------------------------------------------

describe("requireExplicitTarget", () => {
  test("throws ContextError for auto-detect type", () => {
    expect(() =>
      requireExplicitTarget(
        { type: "auto-detect" },
        "Project target",
        "sentry project delete <org>/<project>"
      )
    ).toThrow("Project target");
  });

  test("does not throw for explicit type", () => {
    expect(() =>
      requireExplicitTarget(
        { type: "explicit", org: "acme", project: "my-app" },
        "Project target",
        "sentry project delete <org>/<project>"
      )
    ).not.toThrow();
  });

  test("does not throw for project-search type", () => {
    expect(() =>
      requireExplicitTarget(
        { type: "project-search", projectSlug: "my-app" },
        "Project target",
        "sentry project delete <org>/<project>"
      )
    ).not.toThrow();
  });

  test("does not throw for org-all type", () => {
    expect(() =>
      requireExplicitTarget(
        { type: "org-all", org: "acme" },
        "Project target",
        "sentry project delete <org>/<project>"
      )
    ).not.toThrow();
  });

  test("error message includes the auto-detection note", () => {
    try {
      requireExplicitTarget(
        { type: "auto-detect" },
        "Project target",
        "sentry project delete <org>/<project>"
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain(
        "Auto-detection is disabled for destructive operations"
      );
    }
  });
});
