/**
 * Model-Based Testing for DSN and Project Cache
 *
 * Uses fast-check to generate random sequences of cache operations
 * and verify the system behaves correctly against a simplified model.
 */

// biome-ignore-all lint/suspicious/noMisplacedAssertion: Model-based testing uses expect() inside command classes

import {
  type AsyncCommand,
  asyncModelRun,
  asyncProperty,
  commands,
  constant,
  constantFrom,
  assert as fcAssert,
  option,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  clearDsnCache,
  getCachedDsn,
  setCachedDsn,
  updateCachedResolution,
} from "../../../src/lib/db/dsn-cache.js";
import {
  clearProjectCache,
  getCachedProject,
  getCachedProjectByDsnKey,
  setCachedProject,
  setCachedProjectByDsnKey,
} from "../../../src/lib/db/project-cache.js";
import type { CachedDsnEntry } from "../../../src/lib/dsn/types.js";
import {
  createIsolatedDbContext,
  DEFAULT_NUM_RUNS,
} from "../../model-based/helpers.js";

/**
 * Model for DSN cache state
 */
type DsnCacheModel = {
  entries: Map<
    string,
    {
      dsn: string;
      projectId: string;
      orgId?: string;
      source: CachedDsnEntry["source"];
      sourcePath?: string;
      resolved?: {
        orgSlug: string;
        orgName: string;
        projectSlug: string;
        projectName: string;
      };
    }
  >;
};

/**
 * Model for project cache state
 */
type ProjectCacheModel = {
  entries: Map<
    string,
    {
      orgSlug: string;
      orgName: string;
      projectSlug: string;
      projectName: string;
    }
  >;
};

type CacheModel = {
  dsnCache: DsnCacheModel;
  projectCache: ProjectCacheModel;
};

type RealCache = Record<string, never>;

function createEmptyModel(): CacheModel {
  return {
    dsnCache: { entries: new Map() },
    projectCache: { entries: new Map() },
  };
}

type ResolvedInfo = {
  orgSlug: string;
  orgName: string;
  projectSlug: string;
  projectName: string;
};

type DsnEntryInput = {
  directory: string;
  dsn: string;
  projectId: string;
  orgId: string | undefined;
  source: CachedDsnEntry["source"];
  sourcePath: string | undefined;
};

// Arbitraries

const directoryArb = constantFrom(
  "/home/user/project1",
  "/home/user/project2",
  "/tmp/test",
  "/var/app"
);

const dsnArb = tuple(
  constantFrom("abc123", "def456", "xyz789"),
  constantFrom("12345", "67890", "11111"),
  constantFrom("sentry.io", "us.sentry.io", "de.sentry.io")
).map(([key, projectId, host]) => `https://${key}@${host}/${projectId}`);

const sourceArb = constantFrom(
  "env" as CachedDsnEntry["source"],
  "env_file" as CachedDsnEntry["source"],
  "code" as CachedDsnEntry["source"]
);

const slugArb = constantFrom(
  "my-org",
  "acme-corp",
  "test-org",
  "my-project",
  "backend",
  "frontend"
);

const projectIdArb = constantFrom("12345", "67890", "11111", "22222");
const orgIdArb = constantFrom("100", "200", "300");
const publicKeyArb = constantFrom("abc123", "def456", "xyz789", "key111");

const resolvedInfoArb = tuple(slugArb, slugArb, slugArb, slugArb).map(
  ([orgSlug, orgName, projectSlug, projectName]) => ({
    orgSlug,
    orgName,
    projectSlug,
    projectName,
  })
);

// DSN Cache Commands

class SetCachedDsnCommand implements AsyncCommand<CacheModel, RealCache> {
  private readonly entry: DsnEntryInput;

  constructor(entry: DsnEntryInput) {
    this.entry = entry;
  }

  check = () => true;

  async run(model: CacheModel, _real: RealCache): Promise<void> {
    const { directory, dsn, projectId, orgId, source, sourcePath } = this.entry;

    setCachedDsn(directory, {
      dsn,
      projectId,
      orgId,
      source,
      sourcePath,
    });

    model.dsnCache.entries.set(directory, {
      dsn,
      projectId,
      orgId,
      source,
      sourcePath,
    });
  }

  toString(): string {
    return `setCachedDsn("${this.entry.directory}", {dsn: "${this.entry.dsn}", ...})`;
  }
}

class GetCachedDsnCommand implements AsyncCommand<CacheModel, RealCache> {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  check = () => true;

  async run(model: CacheModel, _real: RealCache): Promise<void> {
    const realEntry = getCachedDsn(this.directory);
    const modelEntry = model.dsnCache.entries.get(this.directory);

    if (modelEntry) {
      expect(realEntry).toBeDefined();
      expect(realEntry?.dsn).toBe(modelEntry.dsn);
      expect(realEntry?.projectId).toBe(modelEntry.projectId);
      expect(realEntry?.orgId).toBe(modelEntry.orgId);
      expect(realEntry?.source).toBe(modelEntry.source);
      expect(realEntry?.sourcePath).toBe(modelEntry.sourcePath);
      expect(realEntry?.resolved).toEqual(modelEntry.resolved);
    } else {
      expect(realEntry).toBeUndefined();
    }
  }

  toString(): string {
    return `getCachedDsn("${this.directory}")`;
  }
}

class UpdateCachedResolutionCommand
  implements AsyncCommand<CacheModel, RealCache>
{
  private readonly directory: string;
  private readonly resolved: ResolvedInfo;

  constructor(directory: string, resolved: ResolvedInfo) {
    this.directory = directory;
    this.resolved = resolved;
  }

  check = () => true;

  async run(model: CacheModel, _real: RealCache): Promise<void> {
    updateCachedResolution(this.directory, this.resolved);

    // Only updates if entry exists
    const existing = model.dsnCache.entries.get(this.directory);
    if (existing) {
      existing.resolved = this.resolved;
    }
  }

  toString(): string {
    return `updateCachedResolution("${this.directory}", {orgSlug: "${this.resolved.orgSlug}", ...})`;
  }
}

class ClearDsnCacheCommand implements AsyncCommand<CacheModel, RealCache> {
  private readonly directory: string | undefined;

  constructor(directory: string | undefined) {
    this.directory = directory;
  }

  check = () => true;

  async run(model: CacheModel, _real: RealCache): Promise<void> {
    clearDsnCache(this.directory);

    if (this.directory) {
      model.dsnCache.entries.delete(this.directory);
    } else {
      model.dsnCache.entries.clear();
    }
  }

  toString(): string {
    return this.directory
      ? `clearDsnCache("${this.directory}")`
      : "clearDsnCache()";
  }
}

// Project Cache Commands

type ProjectCacheInput = {
  orgId: string;
  projectId: string;
  info: ResolvedInfo;
};

class SetCachedProjectCommand implements AsyncCommand<CacheModel, RealCache> {
  private readonly input: ProjectCacheInput;

  constructor(input: ProjectCacheInput) {
    this.input = input;
  }

  check = () => true;

  async run(model: CacheModel, _real: RealCache): Promise<void> {
    const { orgId, projectId, info } = this.input;
    setCachedProject(orgId, projectId, info);

    const key = `${orgId}:${projectId}`;
    model.projectCache.entries.set(key, info);
  }

  toString(): string {
    return `setCachedProject("${this.input.orgId}", "${this.input.projectId}", {...})`;
  }
}

type ProjectLookup = {
  orgId: string;
  projectId: string;
};

class GetCachedProjectCommand implements AsyncCommand<CacheModel, RealCache> {
  private readonly lookup: ProjectLookup;

  constructor(lookup: ProjectLookup) {
    this.lookup = lookup;
  }

  check = () => true;

  async run(model: CacheModel, _real: RealCache): Promise<void> {
    const { orgId, projectId } = this.lookup;
    const realEntry = getCachedProject(orgId, projectId);
    const key = `${orgId}:${projectId}`;
    const modelEntry = model.projectCache.entries.get(key);

    if (modelEntry) {
      expect(realEntry).toBeDefined();
      expect(realEntry?.orgSlug).toBe(modelEntry.orgSlug);
      expect(realEntry?.orgName).toBe(modelEntry.orgName);
      expect(realEntry?.projectSlug).toBe(modelEntry.projectSlug);
      expect(realEntry?.projectName).toBe(modelEntry.projectName);
    } else {
      expect(realEntry).toBeUndefined();
    }
  }

  toString(): string {
    return `getCachedProject("${this.lookup.orgId}", "${this.lookup.projectId}")`;
  }
}

type DsnKeyInput = {
  publicKey: string;
  info: ResolvedInfo;
};

class SetCachedProjectByDsnKeyCommand
  implements AsyncCommand<CacheModel, RealCache>
{
  private readonly input: DsnKeyInput;

  constructor(input: DsnKeyInput) {
    this.input = input;
  }

  check = () => true;

  async run(model: CacheModel, _real: RealCache): Promise<void> {
    const { publicKey, info } = this.input;
    setCachedProjectByDsnKey(publicKey, info);

    const key = `dsn:${publicKey}`;
    model.projectCache.entries.set(key, info);
  }

  toString(): string {
    return `setCachedProjectByDsnKey("${this.input.publicKey}", {...})`;
  }
}

class GetCachedProjectByDsnKeyCommand
  implements AsyncCommand<CacheModel, RealCache>
{
  private readonly publicKey: string;

  constructor(publicKey: string) {
    this.publicKey = publicKey;
  }

  check = () => true;

  async run(model: CacheModel, _real: RealCache): Promise<void> {
    const realEntry = getCachedProjectByDsnKey(this.publicKey);
    const key = `dsn:${this.publicKey}`;
    const modelEntry = model.projectCache.entries.get(key);

    if (modelEntry) {
      expect(realEntry).toBeDefined();
      expect(realEntry?.orgSlug).toBe(modelEntry.orgSlug);
      expect(realEntry?.orgName).toBe(modelEntry.orgName);
      expect(realEntry?.projectSlug).toBe(modelEntry.projectSlug);
      expect(realEntry?.projectName).toBe(modelEntry.projectName);
    } else {
      expect(realEntry).toBeUndefined();
    }
  }

  toString(): string {
    return `getCachedProjectByDsnKey("${this.publicKey}")`;
  }
}

class ClearProjectCacheCommand implements AsyncCommand<CacheModel, RealCache> {
  check = () => true;

  async run(model: CacheModel, _real: RealCache): Promise<void> {
    clearProjectCache();
    model.projectCache.entries.clear();
  }

  toString = () => "clearProjectCache()";
}

// Command Arbitraries

const dsnEntryArb = tuple(
  directoryArb,
  dsnArb,
  projectIdArb,
  option(orgIdArb, { nil: undefined }),
  sourceArb,
  option(constantFrom(".env", "src/index.ts", "config.py"), { nil: undefined })
).map(([directory, dsn, projectId, orgId, source, sourcePath]) => ({
  directory,
  dsn,
  projectId,
  orgId,
  source,
  sourcePath,
}));

const setCachedDsnCmdArb = dsnEntryArb.map(
  (entry) => new SetCachedDsnCommand(entry)
);

const getCachedDsnCmdArb = directoryArb.map(
  (dir) => new GetCachedDsnCommand(dir)
);

const updateResolutionCmdArb = tuple(directoryArb, resolvedInfoArb).map(
  ([dir, resolved]) => new UpdateCachedResolutionCommand(dir, resolved)
);

const clearDsnCacheCmdArb = option(directoryArb, { nil: undefined }).map(
  (dir) => new ClearDsnCacheCommand(dir)
);

const setCachedProjectCmdArb = tuple(
  orgIdArb,
  projectIdArb,
  resolvedInfoArb
).map(
  ([orgId, projectId, info]) =>
    new SetCachedProjectCommand({ orgId, projectId, info })
);

const getCachedProjectCmdArb = tuple(orgIdArb, projectIdArb).map(
  ([orgId, projectId]) => new GetCachedProjectCommand({ orgId, projectId })
);

const setCachedProjectByDsnKeyCmdArb = tuple(publicKeyArb, resolvedInfoArb).map(
  ([publicKey, info]) =>
    new SetCachedProjectByDsnKeyCommand({ publicKey, info })
);

const getCachedProjectByDsnKeyCmdArb = publicKeyArb.map(
  (key) => new GetCachedProjectByDsnKeyCommand(key)
);

const clearProjectCacheCmdArb = constant(new ClearProjectCacheCommand());

// All Commands

const allCommands = [
  // DSN cache commands
  setCachedDsnCmdArb,
  getCachedDsnCmdArb,
  updateResolutionCmdArb,
  clearDsnCacheCmdArb,
  // Project cache commands
  setCachedProjectCmdArb,
  getCachedProjectCmdArb,
  setCachedProjectByDsnKeyCmdArb,
  getCachedProjectByDsnKeyCmdArb,
  clearProjectCacheCmdArb,
];

// Tests

describe("model-based: DSN and project cache", () => {
  test("random sequences of cache operations maintain consistency", async () => {
    await fcAssert(
      asyncProperty(commands(allCommands, { size: "+1" }), async (cmds) => {
        const cleanup = createIsolatedDbContext();
        try {
          const setup = () => ({
            model: createEmptyModel(),
            real: {} as RealCache,
          });

          await asyncModelRun(setup, cmds);
        } finally {
          cleanup();
        }
      }),
      {
        numRuns: DEFAULT_NUM_RUNS,
        verbose: false,
      }
    );
  });

  test("updateCachedResolution only updates existing entries", async () => {
    await fcAssert(
      asyncProperty(
        tuple(directoryArb, resolvedInfoArb),
        async ([directory, resolved]) => {
          const cleanup = createIsolatedDbContext();
          try {
            // Try to update resolution for non-existent entry
            updateCachedResolution(directory, resolved);

            // Entry should still not exist
            const entry = getCachedDsn(directory);
            expect(entry).toBeUndefined();
          } finally {
            cleanup();
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("clearDsnCache with directory only clears that entry", async () => {
    await fcAssert(
      asyncProperty(
        tuple(directoryArb, directoryArb, dsnArb, projectIdArb, sourceArb),
        async ([dir1, dir2, dsn, projectId, source]) => {
          // Skip if directories are the same
          if (dir1 === dir2) return;

          const cleanup = createIsolatedDbContext();
          try {
            // Set up two entries
            setCachedDsn(dir1, { dsn, projectId, source });
            setCachedDsn(dir2, { dsn, projectId, source });

            // Clear only dir1
            clearDsnCache(dir1);

            // dir1 should be gone, dir2 should still exist
            expect(getCachedDsn(dir1)).toBeUndefined();
            expect(getCachedDsn(dir2)).toBeDefined();
          } finally {
            cleanup();
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("project cache by DSN key is separate from org:project key", async () => {
    await fcAssert(
      asyncProperty(
        tuple(orgIdArb, projectIdArb, publicKeyArb, resolvedInfoArb),
        async ([orgId, projectId, publicKey, info]) => {
          const cleanup = createIsolatedDbContext();
          try {
            // Set by org:project
            setCachedProject(orgId, projectId, info);

            // Getting by DSN key should return undefined
            const byDsnKey = getCachedProjectByDsnKey(publicKey);
            expect(byDsnKey).toBeUndefined();

            // Getting by org:project should return the entry
            const byOrgProject = getCachedProject(orgId, projectId);
            expect(byOrgProject).toBeDefined();
          } finally {
            cleanup();
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
