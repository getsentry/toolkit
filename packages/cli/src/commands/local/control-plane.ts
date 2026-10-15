/**
 * HTTP control surface for the singleton Sentry Local daemon.
 *
 * The daemon owns all session metadata and telemetry buffers. CLI processes use
 * its bearer-protected API while SDKs receive only scoped ingestion URLs.
 */

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { pushToSpotlightBuffer } from "@spotlightjs/spotlight/sdk";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { SENTRY_CONTENT_TYPE } from "../../lib/formatters/local.js";
import { formatLocalServerUrl } from "./ui.js";
import { buildSSEHandler, isHostedUiOrigin, MAX_BODY_BYTES } from "./server.js";
import { logger } from "../../lib/logger.js";
import {
  createLocalSessionStore,
  AmbiguousLocalSessionError,
  type LocalSessionStore,
} from "./session-store.js";

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
const SESSION_INGEST_RE = /^\/_local\/v1\/sessions\/[^/]+\/ingest\/[^/]+$/;
const VIEWER_SESSIONS_PATH = "/_local/v1/ui/sessions";
const SESSION_STREAM_RE = /^\/_local\/v1\/sessions\/[^/]+\/stream$/;

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
  const id = (value as Record<string, unknown>).event_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

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
    const type = (item[0] as Record<string, unknown>).type;
    if (type !== "event" && type !== "transaction") {
      return [];
    }
    const id = eventIdFrom(item[0]) ?? eventIdFrom(item[1]);
    return id ? [id] : [];
  })[0];
  return {
    envelopeId: String(header.__spotlight_envelope_id ?? ""),
    eventId:
      eventIdFrom(header) ??
      itemEventId ??
      String(header.__spotlight_envelope_id ?? ""),
    itemTypes: items.map((item) =>
      Array.isArray(item) && typeof item[0] === "object" && item[0]
        ? String((item[0] as { type?: unknown }).type ?? "unknown")
        : "unknown",
    ),
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
  const sessionExists = (reference: string): boolean => {
    sessionStore.pruneExpired();
    try {
      sessionStore.resolve(reference);
      return true;
    } catch (error) {
      if (error instanceof AmbiguousLocalSessionError) {
        throw new HTTPException(409, {
          res: Response.json({ error: error.message }, { status: 409 }),
        });
      }
      logger.debug("Local session was not found", error);
      return false;
    }
  };

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
  app.use(
    `${CONTROL_PLANE_PREFIX}/sessions/:id/ingest/:cap`,
    async (c, next) => {
      if (!isLoopbackBrowserRequest(c.req.raw)) {
        return c.body(null, 403);
      }
      return loopbackCors(c, next);
    },
  );
  const hostedCors = cors({
    allowHeaders: ["Last-Event-ID"],
    allowMethods: ["GET", "OPTIONS"],
    origin: (origin) => (isHostedUiOrigin(origin) ? origin : null),
  });
  for (const path of [
    `${CONTROL_PLANE_PREFIX}/sessions/:id/stream`,
    VIEWER_SESSIONS_PATH,
  ])
    app.use(path, async (c, next) => {
      if (c.req.path === VIEWER_SESSIONS_PATH) {
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
        return loopbackCors(c, next);
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
      return hostedCors(c, next);
    });
  app.use(
    `${CONTROL_PLANE_PREFIX}/sessions/:id/ui/*`,
    cors({
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      origin: (origin) => (LOOPBACK_ORIGIN_RE.test(origin) ? origin : null),
    }),
  );

  app.get(VIEWER_SESSIONS_PATH, (c) => {
    if (c.req.query("cap") !== viewerCapability) return c.body(null, 401);
    sessionStore.pruneExpired();
    c.header("Cache-Control", "no-store");
    return c.json({
      sessions: sessionStore
        .list()
        .map(({ id, label, cwd, state, createdAt }) => ({
          id,
          label,
          cwd,
          state,
          createdAt,
          streamUrl: `${baseUrl}${CONTROL_PLANE_PREFIX}/sessions/${id}/stream?cap=${sessionStore.getCapabilities(id).stream}`,
        })),
    });
  });

  app.get(`${CONTROL_PLANE_PREFIX}/sessions`, (c) => {
    sessionStore.pruneExpired();
    return c.json({ sessions: sessionStore.list() });
  });

  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id`, (c) => {
    if (!sessionExists(c.req.param("id"))) {
      return c.body(null, 404);
    }
    const session = sessionStore.resolve(c.req.param("id"));
    const capabilities = sessionStore.getCapabilities(session.id);
    const path = `${CONTROL_PLANE_PREFIX}/sessions/${session.id}`;
    return c.json({
      ...session,
      directoryUrl,
      ingestUrl: `${baseUrl}${path}/ingest/${capabilities.ingest}`,
      streamUrl: `${baseUrl}${path}/stream?cap=${capabilities.stream}`,
    });
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
        typeof (input as { clientId?: unknown }).clientId !== "string")
    ) {
      return c.json({ error: "label and cwd are required." }, 400);
    }
    const { clientId, label, cwd, maxEnvelopes } = input as {
      clientId?: string;
      label: string;
      cwd: string;
      maxEnvelopes?: number;
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
    const session = sessionStore.create({ clientId, label, cwd, maxEnvelopes });
    const capabilities = sessionStore.getCapabilities(session.id);
    const path = `${CONTROL_PLANE_PREFIX}/sessions/${session.id}`;
    return c.json(
      {
        ...session,
        directoryUrl,
        ingestUrl: `${baseUrl}${path}/ingest/${capabilities.ingest}`,
        streamUrl: `${baseUrl}${path}/stream?cap=${capabilities.stream}`,
      },
      201,
    );
  });

  // Node SDK Spotlight transports send pathname only, so the ingest capability
  // must live in the path. Keep query-based ingestion for existing raw clients.
  const ingest = async (c: Context) => {
    const reference = c.req.param("id") ?? "";
    if (!sessionExists(reference)) {
      return c.body(null, 404);
    }
    const capabilities = sessionStore.getCapabilities(reference);
    if ((c.req.param("cap") ?? c.req.query("cap")) !== capabilities.ingest) {
      return c.body(null, 401);
    }

    if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) {
      return c.body(null, 413);
    }
    const arrayBuffer = await c.req.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_BODY_BYTES) {
      return c.body(null, 413);
    }
    const body = Buffer.from(arrayBuffer);
    const rawEncoding = c.req.header("content-encoding");
    const encoding =
      rawEncoding === "gzip" ||
      rawEncoding === "deflate" ||
      rawEncoding === "br"
        ? rawEncoding
        : undefined;
    const browserBeacon =
      c.req.query("sentry_client")?.startsWith("sentry.javascript.browser") &&
      c.req.header("origin");
    pushToSpotlightBuffer({
      spotlightBuffer: sessionStore.getBuffer(reference),
      body,
      contentType: browserBeacon
        ? SENTRY_CONTENT_TYPE
        : (c.req.header("content-type") ?? ""),
      encoding,
      userAgent: c.req.header("user-agent"),
    });
    sessionStore.recordActivity(reference);
    return c.body(null, 204);
  };
  app.post(`${CONTROL_PLANE_PREFIX}/sessions/:id/ingest/:cap`, ingest);
  app.post(`${CONTROL_PLANE_PREFIX}/sessions/:id/stream`, ingest);

  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id/stream`, (c) => {
    if (!sessionExists(c.req.param("id"))) {
      return c.body(null, 404);
    }
    const capabilities = sessionStore.getCapabilities(c.req.param("id"));
    const buffer = sessionStore.getBuffer(c.req.param("id"));
    if (c.req.query("cap") !== capabilities.stream) {
      return c.body(null, 401);
    }
    return streamSSE(c, async (stream) => {
      const retention = sessionStore.getRetention(c.req.param("id"));
      const sendSettings = (
        settings: ReturnType<typeof retention.getSettings>,
      ) => {
        void stream
          .writeSSE({
            event: LOCAL_RETENTION_EVENT,
            data: JSON.stringify(settings),
          })
          .catch((error) =>
            logger.debug("Local retention stream closed", error),
          );
      };
      const unsubscribeSettings =
        c.req.query("retention") === "1"
          ? retention.subscribeSettings(sendSettings)
          : () => {};
      if (c.req.query("retention") === "1")
        sendSettings(retention.getSettings());
      const readerId = buffer.subscribe(
        buildSSEHandler(stream, c.req.query("base64") !== undefined),
        c.req.header("Last-Event-ID"),
      );
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          buffer.unsubscribe(readerId);
          unsubscribeSettings();
          resolve();
        });
      });
    });
  });

  const updateRetention = async (c: Context) => {
    const input: unknown = await c.req.json().catch(() => undefined);
    const value =
      typeof input === "object" && input !== null && "maxEnvelopes" in input
        ? input.maxEnvelopes
        : undefined;
    try {
      validateMaxEnvelopes(value);
      sessionStore.setMaxEnvelopes(c.req.param("id") ?? "", value);
      return c.json(
        sessionStore.getRetention(c.req.param("id") ?? "").getSettings(),
      );
    } catch (error) {
      if (error instanceof RetentionLimitError)
        return c.json({ error: error.message }, error.status);
      throw error;
    }
  };
  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id/retention`, (c) =>
    sessionExists(c.req.param("id"))
      ? c.json(sessionStore.getRetention(c.req.param("id")).getSettings())
      : c.body(null, 404),
  );
  app.post(`${CONTROL_PLANE_PREFIX}/sessions/:id/retention`, (c) =>
    sessionExists(c.req.param("id")) ? updateRetention(c) : c.body(null, 404),
  );

  app.post(`${CONTROL_PLANE_PREFIX}/sessions/:id/reset`, (c) => {
    if (!sessionExists(c.req.param("id"))) {
      return c.body(null, 404);
    }
    sessionStore.getBuffer(c.req.param("id")).clear();
    return c.body(null, 204);
  });

  app.post(`${CONTROL_PLANE_PREFIX}/sessions/:id/close`, (c) => {
    if (!sessionExists(c.req.param("id"))) {
      return c.body(null, 404);
    }
    return c.json(sessionStore.close(c.req.param("id")));
  });

  app.post(`${CONTROL_PLANE_PREFIX}/sessions/:id/ui/:action`, async (c) => {
    if (!(isSessionUiAction(c.req.path) && sessionExists(c.req.param("id")))) {
      return c.body(null, 404);
    }
    if (!isLoopbackBrowserRequest(c.req.raw)) {
      return c.body(null, 403);
    }
    if (
      c.req.query("cap") !==
      sessionStore.getCapabilities(c.req.param("id")).stream
    ) {
      return c.body(null, 401);
    }
    if (c.req.param("action") === "retention") return updateRetention(c);
    if (c.req.param("action") === "reset") {
      sessionStore.getBuffer(c.req.param("id")).clear();
      return c.body(null, 204);
    }
    return c.json(sessionStore.close(c.req.param("id")));
  });

  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id/envelopes`, (c) => {
    if (!sessionExists(c.req.param("id"))) {
      return c.body(null, 404);
    }
    const envelopes = sessionStore
      .getBuffer(c.req.param("id"))
      .read({ all: true })
      .map((container) => {
        const parsed = container.getParsedEnvelope();
        const header = (parsed?.envelope[0] ?? {}) as {
          __spotlight_envelope_id?: unknown;
        };
        return {
          id: String(header.__spotlight_envelope_id ?? ""),
          contentType: container.getContentType(),
          itemTypes:
            parsed?.envelope[1]
              .map((item) =>
                Array.isArray(item) && typeof item[0] === "object" && item[0]
                  ? String((item[0] as { type?: unknown }).type ?? "unknown")
                  : "unknown",
              )
              .filter(Boolean) ?? [],
        };
      })
      .reverse();
    return c.json({ envelopes });
  });

  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id/events`, (c) => {
    if (!sessionExists(c.req.param("id"))) {
      return c.body(null, 404);
    }
    const events = sessionStore
      .getBuffer(c.req.param("id"))
      .read({ all: true })
      .flatMap((container) => {
        const parsed = container.getParsedEnvelope();
        if (!parsed) {
          return [];
        }
        return [
          {
            ...eventSummary(parsed),
          },
        ];
      })
      .reverse();
    return c.json({ events });
  });

  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id/events/:eventId`, (c) => {
    if (!sessionExists(c.req.param("id"))) {
      return c.body(null, 404);
    }
    const container = sessionStore
      .getBuffer(c.req.param("id"))
      .read({ all: true })
      .find((candidate) => {
        const parsed = candidate.getParsedEnvelope();
        return (
          parsed && eventSummary(parsed).eventId === c.req.param("eventId")
        );
      });
    const parsed = container?.getParsedEnvelope();
    if (!parsed) {
      return c.body(null, 404);
    }
    return c.json({
      ...eventSummary(parsed),
      envelope: parsed.envelope,
    });
  });

  app.get(`${CONTROL_PLANE_PREFIX}/sessions/:id/envelopes/:envelopeId`, (c) => {
    if (!sessionExists(c.req.param("id"))) {
      return c.body(null, 404);
    }
    const container = sessionStore
      .getBuffer(c.req.param("id"))
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
