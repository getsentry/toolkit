/**
 * Property-Based Tests for Shell Completions
 *
 * Verifies invariants of the completion generation system:
 * - Cross-shell consistency (every command appears in all three scripts)
 * - Binary name parametrization
 * - Structural invariants of the command tree
 *
 * Also includes integration tests using Stricli's proposeCompletions API
 * and a real bash simulation of the generated completion script.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { proposeCompletions } from "@stricli/core";
import { constantFrom, assert as fcAssert, property } from "fast-check";
import { describe, expect, test } from "vitest";
import { app, routes } from "../../src/app.js";
import {
  ORG_ONLY_COMMANDS,
  ORG_PROJECT_COMMANDS,
} from "../../src/lib/complete.js";
import {
  extractCommandTree,
  generateBashCompletion,
  generateFishCompletion,
  generateZshCompletion,
} from "../../src/lib/completions.js";
import {
  isCommand,
  isRouteMap,
  type RouteMap,
} from "../../src/lib/introspect.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// -- Arbitraries --

/** Generate valid binary names (lowercase alphanumeric + hyphens) */
const binaryNameArb = constantFrom(
  "sentry",
  "my-cli",
  "test-tool",
  "acme",
  "dev-helper",
  "s"
);

// -- Helpers --

/** Minimal context for proposeCompletions */
const completionContext = {
  process: {
    stdout: {
      write: () => true,
    },
    stderr: {
      write: () => true,
    },
    stdin: process.stdin,
  },
  forCommand: () => ({}),
};

// -- Tests --

describe("property: extractCommandTree invariants", () => {
  const tree = extractCommandTree();

  test("every group has at least one subcommand", () => {
    for (const group of tree.groups) {
      expect(group.subcommands.length).toBeGreaterThan(0);
    }
  });

  test("no duplicate group names", () => {
    const names = tree.groups.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("no duplicate subcommand names within a group", () => {
    for (const group of tree.groups) {
      const names = group.subcommands.map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("all names are non-empty strings", () => {
    for (const group of tree.groups) {
      expect(group.name.length).toBeGreaterThan(0);
      expect(group.brief.length).toBeGreaterThan(0);
      for (const sub of group.subcommands) {
        expect(sub.name.length).toBeGreaterThan(0);
        expect(sub.brief.length).toBeGreaterThan(0);
      }
    }
    for (const cmd of tree.standalone) {
      expect(cmd.name.length).toBeGreaterThan(0);
      expect(cmd.brief.length).toBeGreaterThan(0);
    }
  });
});

describe("property: cross-shell consistency", () => {
  const tree = extractCommandTree();

  test("every group name appears in all three shell scripts", () => {
    fcAssert(
      property(binaryNameArb, (name) => {
        const bash = generateBashCompletion(name);
        const zsh = generateZshCompletion(name);
        const fish = generateFishCompletion(name);

        for (const group of tree.groups) {
          expect(bash).toContain(group.name);
          expect(zsh).toContain(group.name);
          expect(fish).toContain(group.name);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("every subcommand name appears in all three shell scripts", () => {
    fcAssert(
      property(binaryNameArb, (name) => {
        const bash = generateBashCompletion(name);
        const zsh = generateZshCompletion(name);
        const fish = generateFishCompletion(name);

        for (const group of tree.groups) {
          for (const sub of group.subcommands) {
            expect(bash).toContain(sub.name);
            expect(zsh).toContain(sub.name);
            expect(fish).toContain(sub.name);
          }
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("every standalone command appears in all three shell scripts", () => {
    fcAssert(
      property(binaryNameArb, (name) => {
        const bash = generateBashCompletion(name);
        const zsh = generateZshCompletion(name);
        const fish = generateFishCompletion(name);

        for (const cmd of tree.standalone) {
          expect(bash).toContain(cmd.name);
          expect(zsh).toContain(cmd.name);
          expect(fish).toContain(cmd.name);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: binary name parametrization", () => {
  test("generated scripts reference the given binary name", () => {
    fcAssert(
      property(binaryNameArb, (name) => {
        const bash = generateBashCompletion(name);
        const zsh = generateZshCompletion(name);
        const fish = generateFishCompletion(name);

        // Each script should reference the binary name
        expect(bash).toContain(`_${name}_completions`);
        expect(zsh).toContain(`_${name}()`);
        expect(fish).toContain(`complete -c ${name}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("proposeCompletions: Stricli integration", () => {
  const tree = extractCommandTree();

  // Route groups with defaultCommand set don't propose subcommand names
  // through proposeCompletions — Stricli treats the empty string as a
  // potential positional arg for the default command and proposes flags
  // instead. These groups are tested separately below.
  const groupsWithDefaultCommand = new Set([
    "auth",
    "agent-conversation",
    "issue",
    "event",
    "org",
    "project",
    "replay",
    "dashboard",
    "docs",
    "trace",
    "span",
    "status",
    "log",
    "local",
    "monitor",
    "feedback",
  ]);

  test("subcommands match extractCommandTree for each group without defaultCommand", async () => {
    for (const group of tree.groups) {
      if (groupsWithDefaultCommand.has(group.name)) {
        continue;
      }
      const completions = await proposeCompletions(
        app,
        [group.name, ""],
        completionContext
      );
      const actual = completions.map((c) => c.completion).sort();
      const expected = group.subcommands.map((s) => s.name).sort();
      expect(actual).toEqual(expected);
    }
  });

  test("groups with defaultCommand propose flags for the default view command", async () => {
    for (const group of tree.groups) {
      if (!groupsWithDefaultCommand.has(group.name)) {
        continue;
      }
      const completions = await proposeCompletions(
        app,
        [group.name, ""],
        completionContext
      );
      const actual = completions.map((c) => c.completion);
      // With defaultCommand: "view", Stricli proposes flags for the view
      // command rather than subcommand names. Verify it returns flags.
      for (const completion of actual) {
        expect(completion.startsWith("--")).toBe(true);
      }
    }
  });

  test("partial prefix filters subcommands correctly", async () => {
    for (const group of tree.groups) {
      if (
        group.subcommands.length === 0 ||
        groupsWithDefaultCommand.has(group.name)
      ) {
        continue;
      }
      // Pick the first subcommand's first character as prefix
      const prefix = group.subcommands[0].name[0];
      const completions = await proposeCompletions(
        app,
        [group.name, prefix],
        completionContext
      );

      // Every returned completion should start with the prefix
      for (const c of completions) {
        expect(c.completion.startsWith(prefix)).toBe(true);
      }

      // Every expected subcommand starting with the prefix should be returned
      const expected = group.subcommands
        .filter((s) => s.name.startsWith(prefix))
        .map((s) => s.name)
        .sort();
      const actual = completions.map((c) => c.completion).sort();
      expect(actual).toEqual(expected);
    }
  });
});

describe("property: flag extraction", () => {
  const tree = extractCommandTree();

  test("flags are non-empty arrays of objects with name and brief", () => {
    for (const group of tree.groups) {
      for (const sub of group.subcommands) {
        for (const flag of sub.flags) {
          expect(flag.name.length).toBeGreaterThan(0);
          expect(typeof flag.brief).toBe("string");
        }
      }
    }
  });

  test("no duplicate flag names within a command", () => {
    for (const group of tree.groups) {
      for (const sub of group.subcommands) {
        const names = sub.flags.map((f) => f.name);
        expect(new Set(names).size).toBe(names.length);
      }
    }
  });

  test("hidden flags are excluded", () => {
    for (const group of tree.groups) {
      for (const sub of group.subcommands) {
        // log-level and verbose are hidden — should not appear
        const names = sub.flags.map((f) => f.name);
        expect(names).not.toContain("log-level");
        expect(names).not.toContain("verbose");
      }
    }
  });
});

describe("property: dynamic completion callback", () => {
  test("all three shell scripts contain __complete callback", () => {
    fcAssert(
      property(binaryNameArb, (name) => {
        const bash = generateBashCompletion(name);
        const zsh = generateZshCompletion(name);
        const fish = generateFishCompletion(name);

        expect(bash).toContain("__complete");
        expect(zsh).toContain("__complete");
        expect(fish).toContain("__complete");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("bash completion: real shell simulation", () => {
  test("top-level completion returns all known commands", async () => {
    const tree = extractCommandTree();
    const script = generateBashCompletion("sentry");

    const tmpScript = join("/tmp", `completion-test-${Date.now()}.bash`);
    writeFileSync(tmpScript, script);

    const result = spawnSync(
      "bash",
      [
        "-c",
        `
# Stub _init_completion (not available outside bash-completion package)
_init_completion() {
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  return 0
}
source "${tmpScript}"

COMP_WORDS=(sentry "")
COMP_CWORD=1
_sentry_completions
echo "\${COMPREPLY[*]}"
`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const output = result.stdout.toString().trim();
    const completions = output.split(/\s+/);

    // Verify all groups and standalone commands appear
    for (const group of tree.groups) {
      expect(completions).toContain(group.name);
    }
    for (const cmd of tree.standalone) {
      expect(completions).toContain(cmd.name);
    }
  });

  test("subcommand completion returns correct subcommands", async () => {
    const tree = extractCommandTree();
    const script = generateBashCompletion("sentry");

    const tmpScript = join("/tmp", `completion-test-${Date.now()}.bash`);
    writeFileSync(tmpScript, script);

    // Test a few representative groups
    for (const group of tree.groups) {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
_init_completion() {
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  return 0
}
source "${tmpScript}"

COMP_WORDS=(sentry "${group.name}" "")
COMP_CWORD=2
_sentry_completions
echo "\${COMPREPLY[*]}"
`,
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      const output = result.stdout.toString().trim();
      const completions = output.split(/\s+/);

      const expected = group.subcommands.map((s) => s.name).sort();
      expect(completions.sort()).toEqual(expected);
    }
  });
});

describe("complete.ts: command set drift detection", () => {
  /**
   * Walk the Stricli route tree and collect all "group subcommand" paths
   * that have any positional parameter with an org-related placeholder.
   */
  function collectOrgCommands(routeMap: RouteMap): Set<string> {
    const orgCommands = new Set<string>();

    for (const entry of routeMap.getAllEntries()) {
      if (entry.hidden) continue;
      const name = entry.name.original;

      if (isRouteMap(entry.target)) {
        for (const sub of entry.target.getAllEntries()) {
          if (sub.hidden || !isCommand(sub.target)) continue;

          const pos = sub.target.parameters.positional;
          if (!pos) continue;

          const placeholder =
            pos.kind === "tuple"
              ? pos.parameters.map((p) => p.placeholder ?? "").join(" ")
              : (pos.parameter?.placeholder ?? "");

          // Any placeholder mentioning "org" suggests the command accepts
          // an org target — it should be in one of the completion sets.
          if (/\borg\b/i.test(placeholder) || placeholder === "issue") {
            orgCommands.add(`${name} ${sub.name.original}`);
          }
        }
      }
    }

    return orgCommands;
  }

  // Use the ESM import (routes) instead of require() which fails under
  // vitest because Node's CJS require can't resolve .js→.ts for transitive imports.
  const appRoutes = routes as unknown as RouteMap;

  test("every command in ORG_PROJECT_COMMANDS exists in the route tree", () => {
    const tree = extractCommandTree();
    const allPaths = new Set<string>();
    for (const g of tree.groups) {
      for (const s of g.subcommands) {
        allPaths.add(`${g.name} ${s.name}`);
      }
    }
    for (const cmd of ORG_PROJECT_COMMANDS) {
      expect(allPaths.has(cmd)).toBe(true);
    }
  });

  test("every command in ORG_ONLY_COMMANDS exists in the route tree", () => {
    const tree = extractCommandTree();
    const allPaths = new Set<string>();
    for (const g of tree.groups) {
      for (const s of g.subcommands) {
        allPaths.add(`${g.name} ${s.name}`);
      }
    }
    for (const cmd of ORG_ONLY_COMMANDS) {
      expect(allPaths.has(cmd)).toBe(true);
    }
  });

  test("org-positional commands are in at least one set", () => {
    const orgCommands = collectOrgCommands(appRoutes);
    const combined = new Set([...ORG_PROJECT_COMMANDS, ...ORG_ONLY_COMMANDS]);
    for (const cmd of orgCommands) {
      expect(combined.has(cmd)).toBe(true);
    }
  });

  test("no commands are in both sets", () => {
    for (const cmd of ORG_PROJECT_COMMANDS) {
      expect(ORG_ONLY_COMMANDS.has(cmd)).toBe(false);
    }
  });
});
