/**
 * Tests for the shared list-command building blocks.
 *
 * Tests `parseCursorFlag` validation and `buildOrgListCommand` delegation
 * to `dispatchOrgScopedList`.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildOrgListCommand,
  type OrgListCommandDocs,
  parseCursorFlag,
} from "../../src/lib/list-command.js";
import type { OrgListConfig } from "../../src/lib/org-list.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as orgListModule from "../../src/lib/org-list.js";

describe("parseCursorFlag", () => {
  test("passes through 'last' keyword", () => {
    expect(parseCursorFlag("last")).toBe("last");
  });

  test("passes through valid cursor strings", () => {
    expect(parseCursorFlag("1735689600:0:0")).toBe("1735689600:0:0");
    expect(parseCursorFlag("abc:def:0")).toBe("abc:def:0");
  });

  test("rejects bare integer strings", () => {
    expect(() => parseCursorFlag("12345")).toThrow("not a valid cursor");
    expect(() => parseCursorFlag("0")).toThrow("not a valid cursor");
    expect(() => parseCursorFlag("999999999")).toThrow("not a valid cursor");
  });

  test("accepts strings with digits and other characters", () => {
    expect(parseCursorFlag("123abc")).toBe("123abc");
    expect(parseCursorFlag("abc123")).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// buildOrgListCommand: integration with dispatchOrgScopedList
// ---------------------------------------------------------------------------

type FakeEntity = { id: string; name: string };
type FakeWithOrg = FakeEntity & { orgSlug: string };

function makeFakeConfig(
  overrides?: Partial<OrgListConfig<FakeEntity, FakeWithOrg>>
): OrgListConfig<FakeEntity, FakeWithOrg> {
  return {
    paginationKey: "fake-list",
    entityPlural: "widgets",
    commandPrefix: "sentry widget list",
    listForOrg: vi.fn(() => Promise.resolve([])),
    listPaginated: vi.fn(() =>
      Promise.resolve({ data: [] as FakeEntity[], nextCursor: undefined })
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
      "widget"
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
      "widget"
    );
    const func = await cmd.loader();
    const { context } = createContext();

    await (func as any).call(context, { limit: 30, json: false });

    const callArgs = dispatchSpy.mock.calls[0]?.[0];
    expect(callArgs?.parsed).toMatchObject({ type: "auto-detect" });
  });
});
