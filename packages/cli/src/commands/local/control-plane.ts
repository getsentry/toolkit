/**
 * HTTP control surface for the singleton Sentry Local daemon.
 *
 * The daemon owns all session metadata and telemetry buffers. CLI processes use
 * its bearer-protected API while SDKs receive only scoped ingestion URLs.
 */

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  drainReceiver,
  ingestReceiverEnvelope,
  ingestResponse,
  onOversizedEnvelope,
  readReceiverBody,
  receiverEnvelopeId,
  receiverEnvelopeReceivedAt,
  reportIngestStatus,
  trackReceiverRequest,
  type ReceiverEnvelope,
} from "./receiver-ingest.js";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { stringifyUnknown } from "../../lib/errors.js";
import { SENTRY_CONTENT_TYPE } from "../../lib/formatters/local.js";
import { formatLocalServerUrl } from "./ui.js";
import { AMBIGUOUS_EVENT_CODE, matchEventIds } from "./event-lookup.js";
import { summarizeEnvelope } from "./event-summary.js";
import type { ParsedReceiverEnvelope } from "./envelope.js";
import { isLoopbackHost, normalizeLocalHostname } from "./loopback.js";
import {
  buildSSEHandler,
  MAX_BODY_BYTES,
  spotlightEnvelopeId,
} from "./server.js";
import { logger } from "../../lib/logger.js";
import {
  AMBIGUOUS_SESSION_CODE,
  createLocalSessionStore,
  type LocalSession,
  type LocalSessionChoice,
  type LocalSessionStore,
  SESSION_CHOICE_HEADER,
  SESSION_CHOICE_LIMIT,
} from "./session-store.js";

import {
  isHostedUiOrigin,
  LOCAL_DIRECTORY_EVENT,
  LOCAL_OVERSIZED_EVENT,
  LOCAL_SESSION_EVENT,
  type LocalSessionEvent,
} from "./viewer-protocol.js";
import { LOCAL_RETENTION_EVENT } from "./retention-limits.js";
import {
  RetentionLimitError,
  validateMaxEnvelopes,
} from "./retention-buffer.js";

export const CONTROL_PLANE_PREFIX = "/_local/v1";
const LOOPBACK_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const SESSION_UI_ACTION_RE =
  /^\/_local\/v1\/sessions\/[^/]+\/ui\/(reset|close|retention)$/;
/**
 * Paths that write to a session; each carries the ingest capability. SDKs
 * post to the ingest URL itself (Node, Python), add `/stream` to it (PHP's
 * Spotlight transport), or build `<path>/api/<project>/envelope/` from a DSN
 * under it (Go, Rust, PHP, Ruby).
 */
const SESSION_INGEST_PATHS = [
  "",
  "/stream",
  "/api/:projectId/envelope",
  "/api/:projectId/envelope/",
].map((suffix) => `${CONTROL_PLANE_PREFIX}/sessions/:id/ingest/:cap${suffix}`);
const SESSION_INGEST_RE = new RegExp(
  `^(?:${SESSION_INGEST_PATHS.map((path) => path.replace(/:\w+/g, "[^/]+")).join("|")})$`,
);
const VIEWER_SESSIONS_PATH = "/_local/v1/ui/sessions";
const SESSION_STREAM_RE = /^\/_local\/v1\/sessions\/[^/]+\/stream$/;

/**
 * Host and port for a session DSN. SDKs without Spotlight support (Go, Rust)
 * resolve `localhost` on their own and can pick the other IP family than the
 * daemon bound, so the DSN names the address the request arrived on. Requests
 * that carry no socket (tests) fall back to 127.0.0.1 for `localhost`.
 */
function dsnAuthority(c: Context, host: string, port: number): string {
  const env: unknown = c.env;
  const local =
    typeof env === "object" && env !== null && "incoming" in env
      ? (env as { incoming?: { socket?: { localAddress?: unknown } } }).incoming
          ?.socket?.localAddress
      : undefined;
  const address =
    typeof local === "string" && isLoopbackHost(local)
      ? local
      : normalizeLocalHostname(host) === "localhost"
        ? "127.0.0.1"
        : host;
  return new URL(formatLocalServerUrl(address, port)).host;
}

/** Authenticated HTTP application and its in-memory session registry. */
export type LocalControlPlane = {
  readonly app: Hono;
  readonly sessionStore: LocalSessionStore;
};

/** Listener identity, control capability, and optional lifecycle hooks. */
export type CreateLocalControlPlaneOptions = {
  readonly controlToken: string;
  readonly host?: string;
  readonly onStop?: () => void;
  readonly port?: number;
  readonly sessionStore?: LocalSessionStore;
};

function hasControlCapability(request: Request, controlToken: string): boolean {
  return request.headers.get("authorization") === `Bearer ${controlToken}`;
}

function isSessionUiAction(path: string): boolean {
  return SESSION_UI_ACTION_RE.test(path);
}

function isLoopbackBrowserRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || LOOPBACK_ORIGIN_RE.test(origin);
}

/** Only nonempty string IDs from event-bearing envelope fields are lookup keys. */
function eventIdFrom(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const id = (value as Record<string, unknown>)["event_id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * The segment number of a replay envelope. Replay SDKs send every segment of
 * a replay with the replay ID as the envelope `event_id`, so the segment is
 * what tells them apart.
 */
function replaySegmentId(items: unknown[]): number | undefined {
  for (const item of items) {
    if (!Array.isArray(item)) {
      continue;
    }
    const [itemHeader, payload] = item as [unknown, unknown];
    const segmentId =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)["segment_id"]
        : undefined;
    if (
      typeof itemHeader === "object" &&
      itemHeader !== null &&
      (itemHeader as Record<string, unknown>)["type"] === "replay_event" &&
      typeof segmentId === "number" &&
      Number.isInteger(segmentId)
    ) {
      return segmentId;
    }
  }
  return undefined;
}

/**
 * Identity of a retained envelope. `eventId` is the Sentry event ID, or
 * `<replay_id>:<segment_id>` for a replay segment, or the envelope ID when
 * the envelope has no event ID.
 */
function eventSummary(parsed: {
  envelope: [Record<string, unknown>, unknown[]];
}): { envelopeId: string; eventId: string; itemTypes: string[] } {
  const [header, items] = parsed.envelope;
  const itemEventId = items.flatMap((item) => {
    if (
      !Array.isArray(item) ||
      typeof item[0] !== "object" ||
      item[0] === null
    ) {
      return [];
    }
    const type = (item[0] as Record<string, unknown>)["type"];
    if (type !== "event" && type !== "transaction") {
      return [];
    }
    const id = eventIdFrom(item[0]) ?? eventIdFrom(item[1]);
    return id ? [id] : [];
  })[0];
  const envelopeId = spotlightEnvelopeId(header);
  const eventId = eventIdFrom(header) ?? itemEventId;
  const segmentId = replaySegmentId(items);
  return {
    envelopeId,
    eventId:
      eventId === undefined
        ? envelopeId
        : segmentId === undefined
          ? eventId
          : `${eventId}:${segmentId}`,
    itemTypes: items.map((item) =>
      Array.isArray(item) && typeof item[0] === "object" && item[0]
        ? stringifyUnknown((item[0] as { type?: unknown }).type ?? "unknown")
        : "unknown",
    ),
  };
}

/**
 * List and view entry for a retained envelope: its identity plus a decoded
 * summary and the time the receiver accepted it.
 */
function describeEvent(
  container: ReceiverEnvelope,
  parsed: ParsedReceiverEnvelope,
) {
  const receivedAt = receiverEnvelopeReceivedAt(container);
  return {
    ...eventSummary(parsed),
    ...summarizeEnvelope(parsed),
    ...(receivedAt === undefined
      ? {}
      : { receivedAt: new Date(receivedAt).toISOString() }),
  };
}

/** Create the in-process HTTP application hosted by the detached Local daemon. */
export function createLocalControlPlane({
  controlToken,
  host = "localhost",
  onStop,
  port = 8969,
  sessionStore = createLocalSessionStore(),
}: CreateLocalControlPlaneOptions): LocalControlPlane {
  const app = new Hono();
  const baseUrl = formatLocalServerUrl(host, port);
  // Separate opt-in capability: a scoped stream never grants sibling discovery.
  // This token dies with the daemon and never authorizes the control API.
  const viewerCapability = randomBytes(24).toString("base64url");
  const directoryUrl = `${baseUrl}${VIEWER_SESSIONS_PATH}?cap=${viewerCapability}`;
  /**
   * Resolve the route's session ID or name once per request, so a session
   * created or closed mid-request cannot switch the target. A name that
   * several open sessions share reads from the newest, which control clients
   * see in {@link SESSION_CHOICE_HEADER}. A `write` refuses it with a 409 that
   * lists them, so close, reset, and retention never act on a guess.
   */
  const routeSessionId = (
    c: Context,
    access: "read" | "write" = "read",
  ): string | undefined => {
    const reference = c.req.param("id") ?? "";
    sessionStore.pruneExpired();
    let choice: LocalSessionChoice;
    try {
      choice = sessionStore.choose(reference);
    } catch (error) {
      logger.debug("Local session was not found", error);
      return undefined;
    }
    const { session, others } = choice;
    if (others.length === 0) return session.id;
    // Capability-scoped stream, ingest, and UI requests never see sibling IDs.
    const control = hasControlCapability(c.req.raw, controlToken);
    if (access === "write") {
      const sessions = [session, ...others];
      throw new HTTPException(409, {
        res: Response.json(
          {
            error: `Local session name "${reference}" is ambiguous; use its session ID.`,
            code: AMBIGUOUS_SESSION_CODE,
            reference,
            ...(control && {
              sessionIds: sessions.map(({ id }) => id),
              sessions: sessions.map(({ id, state, createdAt }) => ({
                id,
                state,
                createdAt,
              })),
            }),
          },
          { status: 409 },
        ),
      });
    }
    if (control)
      c.header(
        SESSION_CHOICE_HEADER,
        JSON.stringify({
          id: session.id,
          others: others
            .slice(0, SESSION_CHOICE_LIMIT)
            .map(({ id, createdAt }) => ({ id, createdAt })),
          ...(others.length > SESSION_CHOICE_LIMIT && {
            more: others.length - SESSION_CHOICE_LIMIT,
          }),
        }),
      );
    return session.id;
  };

  app.use("*", async (c, next) => {
    // Same-origin browser GETs may omit Origin after DNS rebinding. The Node
    // adapter derives ordinary URLs from Host but accepts absolute targets too.
    const authority = c.req.header("host");
    if (
      !isLoopbackHost(new URL(c.req.url).hostname) ||
      (authority !== undefined &&
        !LOOPBACK_ORIGIN_RE.test(`http://${authority.toLowerCase()}`))
    )
      return c.body(null, 403);
    await next();
    return;
  });

  app.get("/health", (c) => {
    c.header("X-Sentry-Local-Mode", "daemon");
    return c.text("OK");
  });

  app.use(`${CONTROL_PLANE_PREFIX}/*`, async (c, next) => {
    if (
      c.req.path === VIEWER_SESSIONS_PATH ||
      SESSION_STREAM_RE.test(c.req.path) ||
      ((c.req.method === "POST" || c.req.method === "OPTIONS") &&
        SESSION_INGEST_RE.test(c.req.path)) ||
      isSessionUiAction(c.req.path)
    ) {
      await next();
      return;
    }
    if (!hasControlCapability(c.req.raw, controlToken)) {
      return c.body(null, 401);
    }
    await next();
    return;
  });
  const loopbackCors = cors({
    allowHeaders: [
      "Content-Type",
      "Content-Encoding",
      "User-Agent",
      "Last-Event-ID",
    ],
    allowMethods: ["GET", "POST", "OPTIONS"],
    origin: (origin) => (LOOPBACK_ORIGIN_RE.test(origin) ? origin : null),
  });
  for (const path of SESSION_INGEST_PATHS)
    app.use(path, async (c, next) => {
      if (!isLoopbackBrowserRequest(c.req.raw)) {
        return c.body(null, 403);
      }
      return await loopbackCors(c, next);
    });
  const hostedCors = cors({
    allowHeaders: ["Last-Event-ID"],
    allowMethods: ["GET", "OPTIONS"],
    origin: (origin) => (isHostedUiOrigin(origin) ? origin : null),
  });
  for (const path of [
    `${CONTROL_PLANE_PREFIX}/sessions/:id/stream`,
    VIEWER_SESSIONS_PATH,
    "/stream",
  ])
    app.use(path, async (c, next) => {
      if (c.req.path === VIEWER_SESSIONS_PATH || c.req.path === "/stream") {
        if (
          (c.req.method !== "GET" && c.req.method !== "OPTIONS") ||
          (c.req.method === "OPTIONS" &&
            c.req.header("access-control-request-method") !== "GET")
        )
          return c.body(null, 403);
        if (
          !isLoopbackBrowserRequest(c.req.raw) &&
          !isHostedUiOrigin(c.req.header("origin") ?? "")
        )
          return c.body(null, 403);
      }
      const origin = c.req.header("origin") ?? "";
      const isWrite =
        c.req.method === "POST" ||
        (c.req.method === "OPTIONS" &&
          c.req.header("access-control-request-method") !== "GET");
      if (isWrite && !isLoopbackBrowserRequest(c.req.raw)) {
        return c.body(null, 403);
      }
      if (!isHostedUiOrigin(origin)) {
        return await loopbackCors(c, next);
      }
      if (c.req.method === "OPTIONS") {
        if (c.req.header("access-control-request-method") !== "GET") {
          return c.body(null, 403);
        }
        c.header("Access-Control-Allow-Origin", origin);
        c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
        c.header("Access-Control-Allow-Headers", "Last-Event-ID");
        if (c.req.header("access-control-request-private-network") === "true") {
          c.header("Access-Control-Allow-Private-Network", "true");
        }
        c.header(
          "Vary",
          "Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
        );
        return c.body(null, 204);
      }
      if (c.req.method !== "GET") {
        return c.body(null, 403);
      }
      return await hostedCors(c, next);
    });
  const sessionUiCors = cors({
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    origin: (origin) =>
      LOOPBACK_ORIGIN_RE.test(origin) || isHostedUiOrigin(origin)
        ? origin
        : null,
  });
  app.use(`${CONTROL_PLANE_PREFIX}/sessions/:id/ui/*`, async (c, next) => {
    const hostedRetention =
      c.req.path.endsWith("/ui/retention") &&
      isHostedUiOrigin(c.req.header("origin"));
    if (!isLoopbackBrowserRequest(c.req.raw) && !hostedRetention)
      return c.body(null, 403);
    if (hostedRetention && c.req.method === "OPTIONS") {
      if (c.req.header("access-control-request-method") !== "POST")
        return c.body(null, 403);
      if (c.req.header("access-control-request-private-network") === "true") {
        c.header("Access-Control-Allow-Private-Network", "true");
        c.header("Vary", "Access-Control-Request-Private-Network");
      }
    }
    return await sessionUiCors(c, next);
  });

  // Choosing the daemon-wide entry point opts into discovering its sessions.
  // Browser origins remain restricted; scoped streams never emit this metadata.
  app.get("/stream", (c) => {
    const response = streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: LOCAL_DIRECTORY_EVENT,
        data: JSON.stringify({
          directoryUrl: new URL(
            `${VIEWER_SESSIONS_PATH}?cap=${viewerCapability}`,
            c.req.url,
          ).toString(),
        }),
      });
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    });
    c.header("Cache-Control", "no-store");
    response.headers.set("Cache-Control", "no-store");
    return response;
  });

  app.get(VIEWER_SESSIONS_PATH, (c) => {
    if (c.req.query("cap") !== viewerCapability) return c.body(null, 401);
    sessionStore.pruneExpired();
    c.header("Cache-Control", "no-store");
    // Stay on the exact loopback origin the viewer chose (localhost/127.0.0.1/::1).
    const viewerBaseUrl = new URL(c.req.url).origin;
    return c.json({
      sessions: sessionStore
        .list()
        .map(({ id, label, cwd, state, createdAt, expiresAt }) => ({
          id,
          label,
          cwd,
          state,
          createdAt,
          expiresAt,
          streamUrl: `${viewerBaseUrl}${CONTROL_PLANE_PREFIX}/sessions/${id}/stream?cap=${sessionStore.getCapabilities(id).stream}`,
        })),
    });
  });

  app.get(`${CONTROL_PLANE_PREFIX}/sessions`, (c) => {
    sessionStore.pruneExpired();
    return c.json({ sessions: sessionStore.list() });
  });

  /** A session with the capability URLs and DSN that its owner may hand out. */
  const sessionWithCapabilities = (c: Context, session: LocalSession) => {
    const capabilities = sessionStore.getCapabilities(session.id);
    const path = `${CONTROL_PLANE_PREFIX}/sessions/${session.id}`;
    const ingestPath = `${path}/ingest/${capabilities.ingest}`;
    return {
      ...session,
      directoryUrl,
      ingestUrl: `${baseUrl}${ingestPath}`,
      streamUrl: `${baseUrl}${path}/stream?cap=${capabilities.stream}`,
      dsn: `http://key@${dsnAuthority(c, host, port)}${ingestPath}/0`,
    };
  };

  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id`, (c) => {
    const id = routeSessionId(c);
    if (!id) {
      return c.body(null, 404);
    }
    return c.json(sessionWithCapabilities(c, sessionStore.resolve(id)));
  });

  app.post(`${CONTROL_PLANE_PREFIX}/sessions`, async (c) => {
    const input = await c.req.json<unknown>().catch((error: unknown) => {
      logger.debug("Invalid Local session request body", error);
      return;
    });
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      typeof (input as { label?: unknown }).label !== "string" ||
      typeof (input as { cwd?: unknown }).cwd !== "string" ||
      ("clientId" in input &&
        typeof (input as { clientId?: unknown }).clientId !== "string") ||
      ("reuse" in input &&
        typeof (input as { reuse?: unknown }).reuse !== "boolean")
    ) {
      return c.json({ error: "label and cwd are required." }, 400);
    }
    const { clientId, label, cwd, maxEnvelopes, reuse } = input as {
      clientId?: string;
      label: string;
      cwd: string;
      maxEnvelopes?: number;
      reuse?: boolean;
    };
    if (maxEnvelopes !== undefined) {
      try {
        validateMaxEnvelopes(maxEnvelopes);
      } catch (error) {
        if (error instanceof RetentionLimitError)
          return c.json({ error: error.message }, error.status);
        throw error;
      }
    }
    sessionStore.pruneExpired();
    // A run joins the open session with its name, so concurrent runs share
    // one session instead of creating look-alikes; it releases on exit.
    if (reuse) {
      const lease = sessionStore.acquire({ label, cwd, maxEnvelopes });
      return c.json(
        {
          ...sessionWithCapabilities(c, lease.session),
          reused: lease.reused,
          leaseId: lease.leaseId,
        },
        lease.reused ? 200 : 201,
      );
    }
    const session = sessionStore.create({ clientId, label, cwd, maxEnvelopes });
    return c.json(sessionWithCapabilities(c, session), 201);
  });

  // Node SDK Spotlight transports send pathname only, so the ingest capability
  // must live in the path. Keep query-based ingestion for existing raw clients.
  const ingest = async (c: Context) => {
    const id = routeSessionId(c);
    if (!id) {
      return c.body(null, 404);
    }
    const capabilities = sessionStore.getCapabilities(id);
    if ((c.req.param("cap") ?? c.req.query("cap")) !== capabilities.ingest) {
      return c.body(null, 401);
    }

    const isClosed = () => sessionStore.resolve(id).state === "retained";
    const closed = () =>
      c.json(
        { error: "Session is closed; create a new session to capture events." },
        410,
      );
    if (isClosed()) return closed();
    const buffer = sessionStore.getBuffer(id);
    const browserBeacon =
      c.req.query("sentry_client")?.startsWith("sentry.javascript.browser") &&
      c.req.header("origin");
    // Close can occur while the body is being read or decoded. Tracking the
    // request lets close drain it, so a 413 reaches readers before the closing
    // frame. Retention still stops at the close.
    const outcome = await trackReceiverRequest(buffer, async () => {
      const body = await readReceiverBody(c.req.raw, MAX_BODY_BYTES);
      const result =
        typeof body === "number"
          ? body
          : await ingestReceiverEnvelope(buffer, {
              body,
              contentType: browserBeacon
                ? SENTRY_CONTENT_TYPE
                : (c.req.header("content-type") ?? ""),
              encoding: c.req.header("content-encoding"),
              dropDsnHeader: true,
              receiverUrl: c.req.url,
              userAgent: c.req.header("user-agent"),
              // Bodies that arrived before close are kept, even if close
              // lands while they wait in the queue or decode.
              closed: isClosed(),
            });
      reportIngestStatus(buffer, result);
      return result;
    });
    if (outcome === 410) return closed();
    if (typeof outcome === "object" && outcome.status === 200)
      sessionStore.recordActivity(id);
    return ingestResponse(c, outcome);
  };
  for (const path of SESSION_INGEST_PATHS) app.post(path, ingest);
  app.post(`${CONTROL_PLANE_PREFIX}/sessions/:id/stream`, ingest);

  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id/stream`, (c) => {
    const id = routeSessionId(c);
    if (!id) {
      return c.body(null, 404);
    }
    const capabilities = sessionStore.getCapabilities(id);
    const buffer = sessionStore.getBuffer(id);
    if (c.req.query("cap") !== capabilities.stream) {
      return c.body(null, 401);
    }
    // A run's tail names its lease. Once the run has had no tail for a short
    // grace, the lease ends, so a run that is killed or loses its terminal
    // cannot keep the session open, while a tail that reconnects keeps it.
    const requestedLease = c.req.query("lease");
    const leaseId =
      requestedLease !== undefined &&
      sessionStore.attachLease(id, requestedLease)
        ? requestedLease
        : undefined;
    return streamSSE(c, async (stream) => {
      const retention = sessionStore.getRetention(id);
      // Serialize metadata and envelopes so a close notification is the final
      // message, after every envelope accepted before capture stopped.
      let pending = Promise.resolve();
      const writer = {
        writeSSE(message: { id?: string; event?: string; data: string }) {
          const write = pending.then(() => stream.writeSSE(message));
          pending = write.catch((error) =>
            logger.debug("Local session stream closed", error),
          );
          return pending;
        },
      };
      const sendSession = (event: LocalSessionEvent) =>
        writer.writeSSE({
          event: LOCAL_SESSION_EVENT,
          data: JSON.stringify(event),
        });
      const sendSettings = (
        settings: ReturnType<typeof retention.getSettings>,
      ) => {
        void writer.writeSSE({
          event: LOCAL_RETENTION_EVENT,
          data: JSON.stringify(settings),
        });
      };
      const unsubscribeSettings =
        c.req.query("retention") === "1"
          ? retention.subscribeSettings(sendSettings)
          : () => {};
      if (c.req.query("retention") === "1")
        sendSettings(retention.getSettings());
      const readerId = buffer.subscribe(
        buildSSEHandler(writer, c.req.query("base64") !== undefined),
        c.req.header("Last-Event-ID"),
      );
      const unsubscribeOversized = onOversizedEnvelope(buffer, () => {
        void writer.writeSSE({ event: LOCAL_OVERSIZED_EVENT, data: "{}" });
      });
      let finish: () => void = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const unsubscribeSession = sessionStore.subscribe(id, (event) => {
        if (event.state === "retained" && event.action !== "reset") {
          void drainReceiver(buffer)
            .then(async () => {
              buffer.stream(readerId);
              buffer.unsubscribe(readerId);
              await sendSession(event);
            })
            .finally(finish);
        } else {
          void sendSession(event);
        }
      });
      stream.onAbort(finish);
      try {
        const { state, expiresAt } = sessionStore.resolve(id);
        if (state === "retained") {
          await drainReceiver(buffer);
          buffer.stream(readerId);
          await sendSession({ state, expiresAt });
        } else {
          await sendSession({ state });
          await finished;
        }
        await pending;
      } finally {
        buffer.unsubscribe(readerId);
        unsubscribeSettings();
        unsubscribeOversized();
        unsubscribeSession();
        if (leaseId !== undefined) {
          sessionStore.detachLease(id, leaseId);
        }
      }
    });
  });

  const updateRetention = async (c: Context, id: string) => {
    const input: unknown = await c.req.json().catch(() => undefined);
    const value =
      typeof input === "object" && input !== null && "maxEnvelopes" in input
        ? input.maxEnvelopes
        : undefined;
    try {
      validateMaxEnvelopes(value);
      await sessionStore.setMaxEnvelopes(id, value);
      return c.json(sessionStore.getRetention(id).getSettings());
    } catch (error) {
      if (error instanceof RetentionLimitError)
        return c.json({ error: error.message }, error.status);
      throw error;
    }
  };
  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id/retention`, (c) => {
    const id = routeSessionId(c);
    return id
      ? c.json(sessionStore.getRetention(id).getSettings())
      : c.body(null, 404);
  });
  app.post(`${CONTROL_PLANE_PREFIX}/sessions/:id/retention`, async (c) => {
    const id = routeSessionId(c, "write");
    if (!id) {
      return c.body(null, 404);
    }
    return await updateRetention(c, id);
  });

  app.post(`${CONTROL_PLANE_PREFIX}/sessions/:id/reset`, (c) => {
    const id = routeSessionId(c, "write");
    if (!id) {
      return c.body(null, 404);
    }
    sessionStore.reset(id);
    return c.body(null, 204);
  });

  app.post(`${CONTROL_PLANE_PREFIX}/sessions/:id/release`, async (c) => {
    const id = routeSessionId(c, "write");
    if (!id) {
      return c.body(null, 404);
    }
    const input = await c.req.json<unknown>().catch(() => undefined);
    const { leaseId, discardIfEmpty } =
      typeof input === "object" && input !== null
        ? (input as { leaseId?: unknown; discardIfEmpty?: unknown })
        : {};
    if (typeof leaseId !== "string") {
      return c.json({ error: "leaseId is required." }, 400);
    }
    const session = sessionStore.release(id, leaseId, {
      discardIfEmpty: discardIfEmpty === true,
    });
    return session ? c.json(session) : c.body(null, 204);
  });

  app.post(`${CONTROL_PLANE_PREFIX}/sessions/:id/close`, (c) => {
    const id = routeSessionId(c, "write");
    if (!id) {
      return c.body(null, 404);
    }
    return c.json(sessionStore.close(id));
  });

  app.post(`${CONTROL_PLANE_PREFIX}/sessions/:id/ui/:action`, async (c) => {
    if (!isSessionUiAction(c.req.path)) {
      return c.body(null, 404);
    }
    const id = routeSessionId(c, "write");
    if (!id) {
      return c.body(null, 404);
    }
    if (c.req.query("cap") !== sessionStore.getCapabilities(id).stream) {
      return c.body(null, 401);
    }
    if (c.req.param("action") === "retention")
      return await updateRetention(c, id);
    if (c.req.param("action") === "reset") {
      sessionStore.reset(id);
      return c.body(null, 204);
    }
    return c.json(sessionStore.close(id));
  });

  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id/envelopes`, (c) => {
    const id = routeSessionId(c);
    if (!id) {
      return c.body(null, 404);
    }
    const envelopes = sessionStore
      .getBuffer(id)
      .read({ all: true })
      .map((container) => {
        const parsed = container.getParsedEnvelope();
        return {
          id: receiverEnvelopeId(container),
          contentType: container.getContentType(),
          itemTypes:
            parsed?.envelope[1]
              .map((item: unknown) =>
                Array.isArray(item) && typeof item[0] === "object" && item[0]
                  ? stringifyUnknown(
                      (item[0] as { type?: unknown }).type ?? "unknown",
                    )
                  : "unknown",
              )
              .filter(Boolean) ?? [],
        };
      })
      .reverse();
    return c.json({ envelopes });
  });

  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id/events`, (c) => {
    const id = routeSessionId(c);
    if (!id) {
      return c.body(null, 404);
    }
    const events = sessionStore
      .getBuffer(id)
      .read({ all: true })
      .flatMap((container) => {
        const parsed = container.getParsedEnvelope();
        if (!parsed) {
          return [];
        }
        return [describeEvent(container, parsed)];
      })
      .reverse();
    return c.json({ events });
  });

  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id/events/:eventId`, (c) => {
    const id = routeSessionId(c);
    if (!id) {
      return c.body(null, 404);
    }
    const reference = c.req.param("eventId");
    const events = sessionStore
      .getBuffer(id)
      .read({ all: true })
      .flatMap((container) => {
        const parsed = container.getParsedEnvelope();
        return parsed
          ? [{ container, parsed, eventId: eventSummary(parsed).eventId }]
          : [];
      });
    const eventIds = matchEventIds(
      events.map(({ eventId }) => eventId),
      reference,
    );
    if (eventIds.length > 1) {
      return c.json(
        {
          error: `Local event ID "${reference}" matches more than one event.`,
          code: AMBIGUOUS_EVENT_CODE,
          session: c.req.param("id"),
          reference,
          eventIds,
        },
        409,
      );
    }
    const match = events.find(({ eventId }) => eventId === eventIds[0]);
    if (!match) {
      return c.body(null, 404);
    }
    return c.json({
      ...describeEvent(match.container, match.parsed),
      envelope: match.parsed.envelope,
    });
  });

  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id/envelopes/:envelopeId`, (c) => {
    const id = routeSessionId(c);
    if (!id) {
      return c.body(null, 404);
    }
    const container = sessionStore
      .getBuffer(id)
      .read({ envelopeId: c.req.param("envelopeId") })[0];
    if (!container) {
      return c.body(null, 404);
    }
    return c.json({
      contentType: container.getContentType(),
      data: Buffer.from(container.getData()).toString("base64"),
      id: c.req.param("envelopeId"),
    });
  });

  app.post(`${CONTROL_PLANE_PREFIX}/daemon/stop`, (c) => {
    if (!onStop) {
      return c.body(null, 409);
    }
    setTimeout(onStop, 0);
    return c.body(null, 202);
  });

  return { app, sessionStore };
}
