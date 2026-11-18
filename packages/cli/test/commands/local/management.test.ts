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

/** Run a `local` subcommand and return what it printed or threw. */
async function runCommand(
  route: typeof sessionRoute,
  name: string,
  json: boolean,
  ...parts: string[]
): Promise<{ stdout: string; error: unknown }> {
  const command = route.getRoutingTargetForInput(name);
  if (!command || !("loader" in command)) {
    throw new Error(`expected the ${name} command`);
  }
  const func = (await command.loader()) as unknown as ViewFunc;
  let stdout = "";
  const context = {
    stdout: {
      write: vi.fn((chunk: string) => {
        stdout += chunk;
        return true;
      }),
    },
    stderr: { write: vi.fn(() => true) },
    cwd: "/tmp",
  };
  const error = await func.call(context, { json }, ...parts).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  return { stdout, error };
}

/** Run a `local` subcommand with `--json` and return what it throws. */
async function commandError(
  route: typeof sessionRoute,
  name: string,
  ...parts: string[]
): Promise<unknown> {
  return (await runCommand(route, name, true, ...parts)).error;
}

/** Send an event envelope with this event ID into a session. */
async function ingestEvent(
  sessionId: string,
  eventId: string,
  message: string,
): Promise<void> {
  const { ingest } = plane.sessionStore.getCapabilities(sessionId);
  const response = await plane.app.request(
    `${CONTROL_PLANE_PREFIX}/sessions/${sessionId}/ingest/${ingest}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: `${JSON.stringify({ event_id: eventId })}\n{"type":"event"}\n${JSON.stringify({ event_id: eventId, level: "error", message })}`,
    },
  );
  expect(response.status).toBe(204);
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

/** Matches a table row that starts with these cells, padded to column width. */
function tableRow(...cells: string[]): RegExp {
  const escaped = cells.map((cell) =>
    cell.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`│ ${escaped.join(" +│ ")} +│`);
}

describe("local list commands", () => {
  test("print tables for people and leave --json output unchanged", async () => {
    const session = plane.sessionStore.create({
      label: "tables",
      cwd: "/work/tables",
    });
    const eventId = "0123456789abcdef0123456789abcdef";
    await ingestEvent(session.id, eventId, "table event");

    const sessions = await runCommand(sessionRoute, "list", false);
    expect(sessions.error).toBeUndefined();
    expect(sessions.stdout).not.toContain("{");
    expect(sessions.stdout).toMatch(tableRow("ID", "NAME", "STATE"));
    expect(sessions.stdout).toMatch(tableRow(session.id, "tables", "open"));
    expect(sessions.stdout).toContain("DIRECTORY");

    const events = await runCommand(eventRoute, "list", false, "tables");
    expect(events.error).toBeUndefined();
    expect(events.stdout).not.toContain("{");
    expect(events.stdout).toMatch(tableRow("ID", "TYPE", "LEVEL", "TITLE"));
    expect(events.stdout).toMatch(tableRow("01234567", "message", "error"));
    expect(events.stdout).toContain("table event");
    expect(events.stdout).not.toContain(eventId);

    const envelopes = await runCommand(envelopeRoute, "list", false, "tables");
    expect(envelopes.error).toBeUndefined();
    expect(envelopes.stdout).not.toContain("{");
    expect(envelopes.stdout).toMatch(tableRow("ID", "ITEMS"));
    expect(envelopes.stdout).toMatch(/│ event +│/);

    for (const [route, parts, path] of [
      [sessionRoute, [], "/sessions"],
      [eventRoute, ["tables"], `/sessions/${session.id}/events`],
      [envelopeRoute, ["tables"], `/sessions/${session.id}/envelopes`],
    ] as const) {
      const json = await runCommand(route, "list", true, ...parts);
      const direct = await plane.app.request(`${CONTROL_PLANE_PREFIX}${path}`, {
        headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
      });
      expect(JSON.parse(json.stdout)).toEqual(await direct.json());
    }
  });

  test("say when a session has nothing to list", async () => {
    plane.sessionStore.create({ label: "empty-list", cwd: "/work/empty" });

    expect(
      (await runCommand(eventRoute, "list", false, "empty-list")).stdout,
    ).toBe("No events found.\n");
    expect(
      (await runCommand(envelopeRoute, "list", false, "empty-list")).stdout,
    ).toBe("No envelopes found.\n");
  });
});

describe("local event view with an event ID prefix", () => {
  const first = "aaaaaaaa1111111111111111111111a1";
  const second = "aaaaaaaa2222222222222222222222a2";
  const third = "bbbbbbbb3333333333333333333333b3";

  test("opens the one event an 8+ character prefix matches", async () => {
    const session = plane.sessionStore.create({
      label: "prefix-one",
      cwd: "/work/prefix",
    });
    await ingestEvent(session.id, first, "first event");
    await ingestEvent(session.id, second, "second event");
    await ingestEvent(session.id, third, "third event");

    for (const [reference, eventId] of [
      ["bbbbbbbb", third],
      ["aaaaaaaa1", first],
      [second, second],
    ]) {
      const viewed = await runCommand(
        eventRoute,
        "view",
        true,
        "prefix-one",
        reference,
      );
      expect(viewed.error).toBeUndefined();
      expect(JSON.parse(viewed.stdout)).toMatchObject({ eventId });
    }

    const listed = await runCommand(eventRoute, "list", false, "prefix-one");
    expect(listed.stdout).toMatch(tableRow("aaaaaaaa1", "message"));
    expect(listed.stdout).toMatch(tableRow("aaaaaaaa2", "message"));
    expect(listed.stdout).toMatch(tableRow("bbbbbbbb", "message"));
  });

  test("names every match when a prefix fits more than one event", async () => {
    const session = plane.sessionStore.create({
      label: "prefix-many",
      cwd: "/work/prefix",
    });
    await ingestEvent(session.id, first, "first event");
    await ingestEvent(session.id, second, "second event");

    const error = await commandError(
      eventRoute,
      "view",
      "prefix-many",
      "aaaaaaaa",
    );

    expect(error).toBeInstanceOf(ResolutionError);
    const { message } = error as ResolutionError;
    expect(message.split("\n")[0]).toBe(
      'Local event ID "aaaaaaaa" matches more than one event in session "prefix-many".',
    );
    expect(message).toContain("local event list prefix-many");
    expect(message).toContain(`Use event ID ${first}`);
    expect(message).toContain(`Use event ID ${second}`);
    expect(message).not.toContain("HTTP 409");
    expect(classifySilenced(error)).toBe("user_input_error");
  });

  test("keeps replay segment keys whole next to prefix lookup", async () => {
    const session = plane.sessionStore.create({
      label: "prefix-replay",
      cwd: "/work/prefix",
    });
    const replayId = "cccccccc4444444444444444444444c4";
    const { ingest } = plane.sessionStore.getCapabilities(session.id);
    for (const segmentId of [0, 1]) {
      const response = await plane.app.request(
        `${CONTROL_PLANE_PREFIX}/sessions/${session.id}/ingest/${ingest}`,
        {
          method: "POST",
          body: [
            { event_id: replayId },
            { type: "replay_event" },
            {
              type: "replay_event",
              replay_id: replayId,
              event_id: replayId,
              segment_id: segmentId,
            },
          ]
            .map((line) => JSON.stringify(line))
            .join("\n"),
        },
      );
      expect(response.status).toBe(204);
    }

    const listed = await runCommand(eventRoute, "list", false, "prefix-replay");
    expect(listed.stdout).toContain(`${replayId}:0`);
    expect(listed.stdout).toContain(`${replayId}:1`);

    const viewed = await runCommand(
      eventRoute,
      "view",
      true,
      "prefix-replay",
      `${replayId}:1`,
    );
    expect(viewed.error).toBeUndefined();
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      eventId: `${replayId}:1`,
    });

    const error = await commandError(
      eventRoute,
      "view",
      "prefix-replay",
      "cccccccc",
    );
    expect(error).toBeInstanceOf(ResolutionError);
    expect((error as ResolutionError).message).toContain(
      `Use event ID ${replayId}:0`,
    );
    expect((error as ResolutionError).message).toContain(
      `Use event ID ${replayId}:1`,
    );
  });

  test("says a prefix needs 8 characters when a shorter one matches nothing", async () => {
    const session = plane.sessionStore.create({
      label: "prefix-short",
      cwd: "/work/prefix",
    });
    await ingestEvent(session.id, third, "third event");

    const error = await commandError(
      eventRoute,
      "view",
      "prefix-short",
      "bbbb",
    );

    expect(error).toBeInstanceOf(ResolutionError);
    const { message } = error as ResolutionError;
    expect(message.split("\n")[0]).toBe(
      'Local event "bbbb" not found in session "prefix-short".',
    );
    expect(message).toContain("at least 8 characters");
  });
});
