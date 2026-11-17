import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CONTROL_PLANE_PREFIX,
  createLocalControlPlane,
} from "../../../src/commands/local/control-plane.js";
import { sessionRoute } from "../../../src/commands/local/management.js";
import { classifySilenced } from "../../../src/lib/error-reporting.js";
import { CliError, ResolutionError } from "../../../src/lib/errors.js";

const CONTROL_TOKEN = "control-token";
const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
/** Replaces the control plane's answer, as a daemon from an older CLI would. */
let daemonResponse: Response | undefined;

// Send control requests to an in-memory control plane instead of a daemon.
vi.mock("../../../src/commands/local/daemon.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureLocalDaemon: () => Promise.resolve({ token: CONTROL_TOKEN }),
  requestLocalDaemon: (_state: unknown, path: string, init: RequestInit = {}) =>
    daemonResponse ??
    plane.app.request(`${CONTROL_PLANE_PREFIX}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
    }),
}));

type ViewFunc = (
  this: unknown,
  flags: object,
  ...parts: string[]
) => Promise<void>;

/** Run `local session view` and return what it throws. */
async function viewError(reference: string): Promise<unknown> {
  const view = sessionRoute.getRoutingTargetForInput("view");
  if (!view || !("loader" in view)) {
    throw new Error("expected the session view command");
  }
  const func = (await view.loader()) as unknown as ViewFunc;
  const context = {
    stdout: { write: vi.fn(() => true) },
    stderr: { write: vi.fn(() => true) },
    cwd: "/tmp",
  };
  return await func.call(context, {}, reference).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

const OLD_DAEMON_MESSAGE =
  'Local session name "spike" is ambiguous; use its session ID.';

describe("local session view", () => {
  afterEach(() => {
    daemonResponse = undefined;
  });

  test("reports a shared session name as a user error that lists the IDs", async () => {
    const one = plane.sessionStore.create({ label: "spike", cwd: "/one" });
    const two = plane.sessionStore.create({ label: "spike", cwd: "/two" });

    const error = await viewError("spike");

    expect(error).toBeInstanceOf(ResolutionError);
    const { message } = error as ResolutionError;
    expect(message).toMatch(
      /^Local session name "spike" matches more than one session\./,
    );
    expect(message).not.toContain("HTTP 409");
    expect(message).toContain(`Use session ID ${one.id}`);
    expect(message).toContain(`Use session ID ${two.id}`);
    expect(classifySilenced(error)).toBe("user_input_error");
  });

  test.each([
    ["an older daemon's 409", { error: OLD_DAEMON_MESSAGE }],
    [
      "a 409 whose reference is not a string",
      {
        error: OLD_DAEMON_MESSAGE,
        code: "ambiguous_session",
        reference: 42,
        sessionIds: ["one"],
      },
    ],
  ])("keeps reporting %s as a CLI error", async (_label, body) => {
    daemonResponse = Response.json(body, { status: 409 });

    const error = await viewError("spike");

    expect(error).toBeInstanceOf(CliError);
    expect(error).not.toBeInstanceOf(ResolutionError);
    expect((error as CliError).exitCode).toBe(1);
    expect((error as CliError).message).toContain("HTTP 409");
    expect(classifySilenced(error)).toBeNull();
  });
});
