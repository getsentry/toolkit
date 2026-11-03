/**
 * Tests for the shared list-command building blocks.
 *
 * Tests `buildOrgListCommand` delegation to `dispatchOrgScopedList`.
 */

import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  advancePaginationState,
  buildPaginationContextKey,
  resolveCursor,
} from "../../src/lib/db/pagination.js";
import {
  appendQueryHint,
  buildOrgListCommand,
  type OrgListCommandDocs,
} from "../../src/lib/list-command.js";
import type { OrgListConfig } from "../../src/lib/org-list.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as orgListModule from "../../src/lib/org-list.js";
import { useTestConfigDir } from "../helpers.js";

describe("query pagination hints", () => {
  useTestConfigDir("query-pagination-hints-");

  test
    .runIf(process.platform !== "win32")
    .each([
      'transaction:"GET /checkout"',
      'message:"can\'t open file"',
      'message:"can’t open ‘quoted’ ‚file‛"',
      'message:"$SENTRY_HINT_TEST $(printf expanded) `printf expanded` C:\\\\tmp"',
    ])("preserves %s through the shell and cursor lookup", (query) => {
    const key = buildPaginationContextKey("test-list", "test-org/", {
      q: query,
    });
    advancePaginationState("test-list", key, "first", "page-2");

    const parts: string[] = [];
    appendQueryHint(parts, query);
    const args = execFileSync(
      "/bin/sh",
      ["-c", `printf '%s\\0' ${parts.join(" ")}`],
      {
        encoding: "utf8",
        env: { ...process.env, SENTRY_HINT_TEST: "expanded" },
      },
    )
      .split("\0")
      .slice(0, -1);
    expect(args).toEqual([`--query=${query}`]);

    const resumedKey = buildPaginationContextKey("test-list", "test-org/", {
      q: args[0]?.slice("--query=".length),
    });
    expect(resolveCursor("next", "test-list", resumedKey)).toEqual({
      cursor: "page-2",
      direction: "next",
    });
    advancePaginationState("test-list", resumedKey, "next", undefined);
    expect(resolveCursor("prev", "test-list", resumedKey)).toEqual({
      cursor: undefined,
      direction: "prev",
    });
  });

  test("omits an absent query", () => {
    const parts: string[] = [];
    appendQueryHint(parts, undefined);
    appendQueryHint(parts, "");
    expect(parts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildOrgListCommand: integration with dispatchOrgScopedList
// ---------------------------------------------------------------------------

type FakeEntity = { id: string; name: string };
type FakeWithOrg = FakeEntity & { orgSlug: string };

function makeFakeConfig(
  overrides?: Partial<OrgListConfig<FakeEntity, FakeWithOrg>>,
): OrgListConfig<FakeEntity, FakeWithOrg> {
  return {
    paginationKey: "fake-list",
    entityPlural: "widgets",
    commandPrefix: "sentry widget list",
    listForOrg: vi.fn(() => Promise.resolve([])),
    listPaginated: vi.fn(() =>
      Promise.resolve({ data: [] as FakeEntity[], nextCursor: undefined }),
    ),
    withOrg: (entity, orgSlug) => ({ ...entity, orgSlug }),
    displayTable: vi.fn(() => ""),
    ...overrides,
  };
}

function createContext() {
  const write = vi.fn((_chunk: string) => true);
  return {
    context: {
      stdout: { write },
      stderr: { write: vi.fn((_chunk: string) => true) },
      cwd: "/tmp",
    },
    write,
  };
}

describe("buildOrgListCommand", () => {
  let dispatchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    dispatchSpy?.mockRestore();
  });

  test("returns a command object with a loader", () => {
    const config = makeFakeConfig();
    const docs: OrgListCommandDocs = { brief: "List widgets" };
    const cmd = buildOrgListCommand(config, docs, "widget");
    expect(typeof cmd.loader).toBe("function");
  });

  test("calls dispatchOrgScopedList with correct config and flags", async () => {
    dispatchSpy = vi
      .spyOn(orgListModule, "dispatchOrgScopedList")
      .mockResolvedValue({ items: [] });

    const config = makeFakeConfig();
    const docs: OrgListCommandDocs = { brief: "List widgets" };
    const cmd = buildOrgListCommand(config, docs, "widget");
    const func = await cmd.loader();
    const { context } = createContext();

    // Stricli loader returns CommandModule | CommandFunction union;
    // .call() exists on the function variant used at runtime.
    await (func as any).call(context, {
      limit: 5,
      json: true,
      cursor: undefined,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const callArgs = dispatchSpy.mock.calls[0]?.[0];
    expect(callArgs?.config).toBe(config);
    expect(callArgs?.flags).toEqual({
      limit: 5,
      json: true,
      cursor: undefined,
    });
  });

  test("passes parsed target to dispatchOrgScopedList", async () => {
    dispatchSpy = vi
      .spyOn(orgListModule, "dispatchOrgScopedList")
      .mockResolvedValue({ items: [] });

    const config = makeFakeConfig();
    const cmd = buildOrgListCommand(
      config,
      { brief: "List widgets" },
      "widget",
    );
    const func = await cmd.loader();
    const { context } = createContext();

    await (func as any).call(context, { limit: 30, json: false }, "my-org/");

    const callArgs = dispatchSpy.mock.calls[0]?.[0];
    expect(callArgs?.parsed).toMatchObject({ type: "org-all", org: "my-org" });
  });

  test("passes undefined parsed target when no positional arg given", async () => {
    dispatchSpy = vi
      .spyOn(orgListModule, "dispatchOrgScopedList")
      .mockResolvedValue({ items: [] });

    const config = makeFakeConfig();
    const cmd = buildOrgListCommand(
      config,
      { brief: "List widgets" },
      "widget",
    );
    const func = await cmd.loader();
    const { context } = createContext();

    await (func as any).call(context, { limit: 30, json: false });

    const callArgs = dispatchSpy.mock.calls[0]?.[0];
    expect(callArgs?.parsed).toMatchObject({ type: "auto-detect" });
  });
});
