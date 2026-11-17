import { describe, expect, test, vi } from "vitest";
import {
  CONTROL_PLANE_PREFIX,
  createLocalControlPlane,
} from "../../../src/commands/local/control-plane.js";
import { sessionRoute } from "../../../src/commands/local/management.js";
import { classifySilenced } from "../../../src/lib/error-reporting.js";
import { ResolutionError } from "../../../src/lib/errors.js";

const CONTROL_TOKEN = "control-token";
const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });

// Send control requests to an in-memory control plane instead of a daemon.
vi.mock("../../../src/commands/local/daemon.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureLocalDaemon: () => Promise.resolve({ token: CONTROL_TOKEN }),
  requestLocalDaemon: (_state: unknown, path: string, init: RequestInit = {}) =>
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

describe("local session view", () => {
  test("reports a shared session name as a user error that lists the IDs", async () => {
    const one = plane.sessionStore.create({ label: "spike", cwd: "/one" });
    const two = plane.sessionStore.create({ label: "spike", cwd: "/two" });
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

    const error: unknown = await func.call(context, {}, "spike").then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

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
});
