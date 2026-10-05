/**
 * Telemetry Session Tests
 *
 * Tests for session lifecycle management:
 * - beforeExit handler (createBeforeExitHandler)
 * - Session crash marking (markSessionCrashed)
 *
 * These tests are in a separate file because they mock Sentry's scope methods
 * (getCurrentScope, getIsolationScope) which conflicts with the SDK's internal
 * scope machinery. Running in a separate Bun test worker prevents interference
 * with other telemetry tests.
 */

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as Sentry from "@sentry/node-core/light";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createBeforeExitHandler,
  markSessionCrashed,
} from "../../src/lib/telemetry.js";

describe("createBeforeExitHandler", () => {
  /**
   * Create a minimal mock LightNodeClient for testing the beforeExit handler.
   * Only needs flush() since that's all the handler uses from the client.
   */
  function createMockClient(): Sentry.LightNodeClient {
    return {
      flush: () => Promise.resolve(true),
    } as unknown as Sentry.LightNodeClient;
  }

  test("ends OK session on beforeExit", () => {
    const handler = createBeforeExitHandler(createMockClient());

    const mockSession = { status: "ok", errors: 0 };
    const getIsolationScopeSpy = vi
      .spyOn(Sentry, "getIsolationScope")
      .mockReturnValue({
        getSession: () => mockSession,
      } as unknown as Sentry.Scope);
    // Mock endSession to prevent it from calling through to real SDK internals
    const endSessionSpy = vi
      .spyOn(Sentry, "endSession")
      .mockImplementation(() => null);

    handler();

    expect(endSessionSpy).toHaveBeenCalled();

    getIsolationScopeSpy.mockRestore();
    endSessionSpy.mockRestore();
  });

  test("does not end non-OK session on beforeExit (SDK handles it)", () => {
    const handler = createBeforeExitHandler(createMockClient());

    const mockSession = { status: "crashed", errors: 1 };
    const getIsolationScopeSpy = vi
      .spyOn(Sentry, "getIsolationScope")
      .mockReturnValue({
        getSession: () => mockSession,
      } as unknown as Sentry.Scope);
    const endSessionSpy = vi
      .spyOn(Sentry, "endSession")
      .mockImplementation(() => null);

    handler();

    expect(endSessionSpy).not.toHaveBeenCalled();

    getIsolationScopeSpy.mockRestore();
    endSessionSpy.mockRestore();
  });

  test("does not end session when no session exists", () => {
    const handler = createBeforeExitHandler(createMockClient());

    const getIsolationScopeSpy = vi
      .spyOn(Sentry, "getIsolationScope")
      .mockReturnValue({
        getSession: () => null,
      } as unknown as Sentry.Scope);
    const endSessionSpy = vi
      .spyOn(Sentry, "endSession")
      .mockImplementation(() => null);

    handler();

    expect(endSessionSpy).not.toHaveBeenCalled();

    getIsolationScopeSpy.mockRestore();
    endSessionSpy.mockRestore();
  });

  test("re-entry guard prevents double flush", () => {
    const handler = createBeforeExitHandler(createMockClient());

    const mockSession = { status: "ok", errors: 0 };
    const getIsolationScopeSpy = vi
      .spyOn(Sentry, "getIsolationScope")
      .mockReturnValue({
        getSession: () => mockSession,
      } as unknown as Sentry.Scope);
    const endSessionSpy = vi
      .spyOn(Sentry, "endSession")
      .mockImplementation(() => null);

    // Call twice
    handler();
    handler();

    // endSession should only be called once due to re-entry guard
    expect(endSessionSpy).toHaveBeenCalledTimes(1);

    getIsolationScopeSpy.mockRestore();
    endSessionSpy.mockRestore();
  });

  test("flushes client on beforeExit", () => {
    const mockClient = createMockClient();
    const flushSpy = vi.spyOn(mockClient, "flush");
    const handler = createBeforeExitHandler(mockClient);

    const getIsolationScopeSpy = vi
      .spyOn(Sentry, "getIsolationScope")
      .mockReturnValue({
        getSession: () => null,
      } as unknown as Sentry.Scope);

    handler();

    expect(flushSpy).toHaveBeenCalledWith(3000);

    getIsolationScopeSpy.mockRestore();
    flushSpy.mockRestore();
  });
});

describe("markSessionCrashed", () => {
  let getCurrentScopeSpy: ReturnType<typeof spyOn>;
  let getIsolationScopeSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    getCurrentScopeSpy?.mockRestore();
    getIsolationScopeSpy?.mockRestore();
  });

  test("marks session as crashed from current scope", () => {
    const mockSession = { status: "ok", errors: 0 };

    getCurrentScopeSpy = vi.spyOn(Sentry, "getCurrentScope").mockReturnValue({
      getSession: () => mockSession,
    } as unknown as Sentry.Scope);
    getIsolationScopeSpy = vi
      .spyOn(Sentry, "getIsolationScope")
      .mockReturnValue({
        getSession: () => null,
      } as unknown as Sentry.Scope);

    markSessionCrashed();

    expect(mockSession.status).toBe("crashed");
  });

  test("marks session as crashed from isolation scope when current scope has none", () => {
    const mockSession = { status: "ok", errors: 0 };

    getCurrentScopeSpy = vi.spyOn(Sentry, "getCurrentScope").mockReturnValue({
      getSession: () => null,
    } as unknown as Sentry.Scope);
    getIsolationScopeSpy = vi
      .spyOn(Sentry, "getIsolationScope")
      .mockReturnValue({
        getSession: () => mockSession,
      } as unknown as Sentry.Scope);

    markSessionCrashed();

    expect(mockSession.status).toBe("crashed");
  });

  test("does nothing when no session exists on either scope", () => {
    getCurrentScopeSpy = vi.spyOn(Sentry, "getCurrentScope").mockReturnValue({
      getSession: () => null,
    } as unknown as Sentry.Scope);
    getIsolationScopeSpy = vi
      .spyOn(Sentry, "getIsolationScope")
      .mockReturnValue({
        getSession: () => null,
      } as unknown as Sentry.Scope);

    // Should not throw
    expect(() => markSessionCrashed()).not.toThrow();
  });

  test("prefers current scope session over isolation scope", () => {
    const currentSession = { status: "ok", errors: 0 };
    const isolationSession = { status: "ok", errors: 0 };

    getCurrentScopeSpy = vi.spyOn(Sentry, "getCurrentScope").mockReturnValue({
      getSession: () => currentSession,
    } as unknown as Sentry.Scope);
    getIsolationScopeSpy = vi
      .spyOn(Sentry, "getIsolationScope")
      .mockReturnValue({
        getSession: () => isolationSession,
      } as unknown as Sentry.Scope);

    markSessionCrashed();

    // Current scope session should be marked, isolation scope left unchanged
    expect(currentSession.status).toBe("crashed");
    expect(isolationSession.status).toBe("ok");
  });
});
