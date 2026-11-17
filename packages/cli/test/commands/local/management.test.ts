import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CONTROL_PLANE_PREFIX,
  createLocalControlPlane,
} from "../../../src/commands/local/control-plane.js";
import {
  envelopeRoute,
  eventRoute,
  sessionRoute,
} from "../../../src/commands/local/management.js";
import { classifySilenced } from "../../../src/lib/error-reporting.js";
import { CliError, EXIT, ResolutionError } from "../../../src/lib/errors.js";

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

/** Run a `local` subcommand with `--json` and return what it throws. */
async function commandError(
  route: typeof sessionRoute,
  name: string,
  ...parts: string[]
): Promise<unknown> {
  const command = route.getRoutingTargetForInput(name);
  if (!command || !("loader" in command)) {
    throw new Error(`expected the ${name} command`);
  }
  const func = (await command.loader()) as unknown as ViewFunc;
  const context = {
    stdout: { write: vi.fn(() => true) },
    stderr: { write: vi.fn(() => true) },
    cwd: "/tmp",
  };
  return await func.call(context, { json: true }, ...parts).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

/** Run `local session view` and return what it throws. */
function viewError(reference: string): Promise<unknown> {
  return commandError(sessionRoute, "view", reference);
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

describe("missing Local sessions and telemetry", () => {
  /** Assert a not-found user error that suggests a follow-up command. */
  function expectNotFound(error: unknown, headline: string, hint: string) {
    expect(error).toBeInstanceOf(ResolutionError);
    const { message, exitCode } = error as ResolutionError;
    expect(message.split("\n")[0]).toBe(headline);
    expect(message).toContain(hint);
    expect(message).not.toContain("HTTP 404");
    expect(exitCode).toBe(EXIT.RESOLUTION);
    expect(classifySilenced(error)).toBe("user_input_error");
  }

  test("an evicted or unknown event ID is not found in its session", async () => {
    plane.sessionStore.create({ label: "web", cwd: "/web" });

    expectNotFound(
      await commandError(eventRoute, "view", "web", "deadbeef"),
      'Local event "deadbeef" not found in session "web".',
      "local event list web",
    );
    expectNotFound(
      await commandError(envelopeRoute, "view", "web", "deadbeef"),
      'Local envelope "deadbeef" not found in session "web".',
      "local envelope list web",
    );
  });

  test("an unknown session is reported before the event ID", async () => {
    expectNotFound(
      await commandError(eventRoute, "view", "ghost", "deadbeef"),
      'Local session "ghost" not found.',
      "local session list",
    );
    expectNotFound(
      await commandError(eventRoute, "list", "ghost"),
      'Local session "ghost" not found.',
      "local session list",
    );
    expectNotFound(
      await viewError("ghost"),
      'Local session "ghost" not found.',
      "local session list",
    );
  });
});
