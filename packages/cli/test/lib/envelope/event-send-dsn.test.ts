/**
 * Tests for DSN resolution used by `sentry event send`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn
import * as projectsApi from "../../../src/lib/api/projects.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn
import * as auth from "../../../src/lib/db/auth.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn
import * as dsnIndex from "../../../src/lib/dsn/index.js";
import {
  EVENT_SEND_NO_DSN_MESSAGE,
  peelEventSendTarget,
  resolveEventSendDsn,
} from "../../../src/lib/envelope/event-send-dsn.js";
import { ConfigError } from "../../../src/lib/errors.js";
import type { ProjectKey } from "../../../src/types/sentry.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [
      key,
      typeof value === "function" ? vi.fn(value) : value,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for mocked access
import * as resolveTarget from "../../../src/lib/resolve-target.js";

useTestConfigDir("event-send-dsn-");
useEnvSandbox(["SENTRY_DSN"]);

const SAAS_DSN = "https://abc123@o1.ingest.us.sentry.io/999";
const OTHER_DSN = "https://def456@o2.ingest.us.sentry.io/111";

const ACTIVE_KEY = {
  id: "key-1",
  name: "Default",
  isActive: true,
  dsn: { public: SAAS_DSN, secret: "" },
} as ProjectKey;

const OTHER_ACTIVE_KEY = {
  id: "key-2",
  name: "Other",
  isActive: true,
  dsn: { public: OTHER_DSN, secret: "" },
} as ProjectKey;

const INACTIVE_KEY = {
  id: "key-3",
  name: "Inactive",
  isActive: false,
  dsn: { public: OTHER_DSN, secret: "" },
} as ProjectKey;

const OAUTH_SESSION = {
  token: "sntrys_access",
  source: "oauth" as const,
  refreshToken: "refresh_xyz",
  expiresAt: Date.now() + 3_600_000,
};

const REFRESHABLE_EXPIRED_OAUTH_SESSION = {
  token: "sntrys_expired_access",
  source: "oauth" as const,
  refreshToken: "refresh_xyz",
  expiresAt: Date.now() - 60_000,
};

function detectedDsn(raw: string) {
  return {
    raw,
    protocol: "https",
    publicKey: "abc123",
    host: "o1.ingest.us.sentry.io",
    projectId: "999",
    source: "env_file" as const,
  };
}

describe("peelEventSendTarget", () => {
  test("peels a leading org/project target", () => {
    const result = peelEventSendTarget(["example-org/javascript-react"]);
    expect(result.target).toEqual({
      kind: "project",
      target: "example-org/javascript-react",
    });
    expect(result.files).toEqual([]);
  });

  test("peels a leading bare project target", () => {
    const result = peelEventSendTarget(["javascript-react"]);
    expect(result.target).toEqual({
      kind: "project",
      target: "javascript-react",
    });
    expect(result.files).toEqual([]);
  });

  test("peels a leading DSN target", () => {
    const result = peelEventSendTarget([SAAS_DSN]);
    expect(result.target).toEqual({ kind: "dsn", dsn: SAAS_DSN });
    expect(result.files).toEqual([]);
  });

  test("leaves remaining file args after the target", () => {
    const result = peelEventSendTarget(["sentry/cli", "./event.json"]);
    expect(result.target).toEqual({
      kind: "project",
      target: "sentry/cli",
    });
    expect(result.files).toEqual(["./event.json"]);
  });

  test("requires ./ for a target-shaped relative file", () => {
    const result = peelEventSendTarget(["./acme/web"]);
    expect(result.target).toBeUndefined();
    expect(result.files).toEqual(["./acme/web"]);
  });

  test("does not peel a JSON path with a slash", () => {
    const result = peelEventSendTarget(["events/crash.json"]);
    expect(result.target).toBeUndefined();
    expect(result.files).toEqual(["events/crash.json"]);
  });

  test("does not peel a bare JSON filename", () => {
    const result = peelEventSendTarget(["event.json"]);
    expect(result.target).toBeUndefined();
    expect(result.files).toEqual(["event.json"]);
  });

  test("does not peel relative or absolute paths", () => {
    expect(peelEventSendTarget(["./sentry/cli"]).target).toBeUndefined();
    expect(peelEventSendTarget(["/tmp/sentry/cli"]).target).toBeUndefined();
  });
});

describe("resolveEventSendDsn", () => {
  let detectSpy: ReturnType<typeof vi.spyOn>;
  let keysSpy: ReturnType<typeof vi.spyOn>;
  let authSpy: ReturnType<typeof vi.spyOn>;
  const resolveProjectMock = vi.mocked(
    resolveTarget.resolveProjectBoundFromArg,
  );

  beforeEach(() => {
    detectSpy = vi.spyOn(dsnIndex, "detectDsn").mockResolvedValue(null);
    keysSpy = vi.spyOn(projectsApi, "getProjectKeys").mockResolvedValue([]);
    authSpy = vi.spyOn(auth, "getAuthConfig").mockReturnValue(undefined);
    resolveProjectMock.mockReset();
    resolveProjectMock.mockResolvedValue({
      org: "acme",
      project: "web",
    });
  });

  afterEach(() => {
    detectSpy.mockRestore();
    keysSpy.mockRestore();
    authSpy.mockRestore();
    resolveProjectMock.mockReset();
  });

  test("positional DSN wins over SENTRY_DSN and project scan", async () => {
    process.env.SENTRY_DSN = OTHER_DSN;
    detectSpy.mockResolvedValue(detectedDsn(OTHER_DSN));

    const dsn = await resolveEventSendDsn("/tmp", {
      kind: "dsn",
      dsn: SAAS_DSN,
    });
    expect(dsn).toBe(SAAS_DSN);
    expect(resolveProjectMock).not.toHaveBeenCalled();
    expect(keysSpy).not.toHaveBeenCalled();
    expect(detectSpy).not.toHaveBeenCalled();
  });

  test("project target wins over SENTRY_DSN and project scan", async () => {
    process.env.SENTRY_DSN = OTHER_DSN;
    authSpy.mockReturnValue(OAUTH_SESSION);
    keysSpy.mockResolvedValue([ACTIVE_KEY]);

    const dsn = await resolveEventSendDsn("/tmp", {
      kind: "project",
      target: "acme/web",
    });
    expect(dsn).toBe(SAAS_DSN);
    expect(resolveProjectMock).toHaveBeenCalledWith(
      "acme/web",
      "/tmp",
      "event send",
    );
    expect(keysSpy).toHaveBeenCalledWith("acme", "web", {
      status: "active",
    });
    expect(detectSpy).not.toHaveBeenCalled();
  });

  test("bare project uses shared project resolution", async () => {
    authSpy.mockReturnValue(OAUTH_SESSION);
    keysSpy.mockResolvedValue([ACTIVE_KEY]);

    const dsn = await resolveEventSendDsn("/tmp", {
      kind: "project",
      target: "web",
    });
    expect(dsn).toBe(SAAS_DSN);
    expect(resolveProjectMock).toHaveBeenCalledWith(
      "web",
      "/tmp",
      "event send",
    );
    expect(keysSpy).toHaveBeenCalledWith("acme", "web", {
      status: "active",
    });
  });

  test("project target without login throws ConfigError", async () => {
    process.env.SENTRY_DSN = OTHER_DSN;
    await expect(
      resolveEventSendDsn("/tmp", {
        kind: "project",
        target: "acme/web",
      }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(resolveProjectMock).not.toHaveBeenCalled();
    expect(keysSpy).not.toHaveBeenCalled();
  });

  test("project target works with a refreshable expired session", async () => {
    authSpy.mockReturnValue(REFRESHABLE_EXPIRED_OAUTH_SESSION);
    keysSpy.mockResolvedValue([ACTIVE_KEY]);

    const dsn = await resolveEventSendDsn("/tmp", {
      kind: "project",
      target: "acme/web",
    });
    expect(dsn).toBe(SAAS_DSN);
    expect(keysSpy).toHaveBeenCalledWith("acme", "web", {
      status: "active",
    });
  });

  test("project without an active client key throws ConfigError", async () => {
    authSpy.mockReturnValue(OAUTH_SESSION);
    keysSpy.mockResolvedValue([INACTIVE_KEY]);

    await expect(
      resolveEventSendDsn("/tmp", {
        kind: "project",
        target: "acme/web",
      }),
    ).rejects.toMatchObject({
      name: "ConfigError",
      message:
        "No active DSN found for acme/web. Pass a DSN as the first argument.",
    });
  });

  test("project with multiple active DSNs requires an explicit DSN", async () => {
    authSpy.mockReturnValue(OAUTH_SESSION);
    keysSpy.mockResolvedValue([ACTIVE_KEY, OTHER_ACTIVE_KEY]);

    await expect(
      resolveEventSendDsn("/tmp", {
        kind: "project",
        target: "acme/web",
      }),
    ).rejects.toMatchObject({
      name: "ConfigError",
      message:
        "Project acme/web has multiple active DSNs. Pass the desired DSN as the first argument.",
    });
  });

  test("uses SENTRY_DSN when no positional target is provided", async () => {
    process.env.SENTRY_DSN = SAAS_DSN;
    const dsn = await resolveEventSendDsn("/tmp", undefined);
    expect(dsn).toBe(SAAS_DSN);
  });

  test("falls back to project scan without a positional target or env", async () => {
    detectSpy.mockResolvedValue(detectedDsn(OTHER_DSN));
    const dsn = await resolveEventSendDsn("/tmp", undefined);
    expect(dsn).toBe(OTHER_DSN);
  });

  test("throws ConfigError listing every source when nothing resolves", async () => {
    const err = await resolveEventSendDsn("/tmp", undefined).catch(
      (error) => error,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toBe(EVENT_SEND_NO_DSN_MESSAGE);
  });
});
