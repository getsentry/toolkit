/**
 * In-memory lifecycle and isolation for Local control-plane sessions.
 *
 * Session metadata and envelopes intentionally disappear when the daemon exits.
 */

import { randomBytes } from "node:crypto";
import { createSpotlightBuffer } from "@spotlightjs/spotlight/sdk";
import { uuidv7 } from "uuidv7";

/** Maximum number of envelopes retained by an individual Local session. */
export const SESSION_BUFFER_SIZE = 500;

/** Retained sessions remain queryable for three hours after closing. */
export const SESSION_RETENTION_MS = 3 * 60 * 60 * 1000;

/** Open lease or a closed session retained for later queries. */
export type LocalSessionState = "open" | "retained";

/** Public session metadata, excluding telemetry buffers and secret capabilities. */
export type LocalSession = {
  readonly clientId?: string;
  readonly id: string;
  readonly label: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly state: LocalSessionState;
  readonly expiresAt?: number;
};

type StoredSession = LocalSession & {
  buffer: ReturnType<typeof createSpotlightBuffer>;
  ingestCapability: string;
  streamCapability: string;
};

/** Session label, working directory, and optional retry idempotency key. */
export type CreateLocalSessionInput = {
  readonly clientId?: string;
  readonly label: string;
  readonly cwd: string;
};

/** A label matches multiple sessions; callers must select an explicit ID. */
export class AmbiguousLocalSessionError extends Error {
  constructor(reference: string) {
    super(
      `Local session name "${reference}" is ambiguous; use its session ID.`,
    );
    this.name = "AmbiguousLocalSessionError";
  }
}

/** In-memory session lifecycle and access to isolated telemetry buffers. */
export type LocalSessionStore = {
  create: (input: CreateLocalSessionInput) => LocalSession;
  close: (reference: string) => LocalSession;
  getCapabilities: (reference: string) => {
    ingest: string;
    stream: string;
  };
  getBuffer: (reference: string) => ReturnType<typeof createSpotlightBuffer>;
  list: () => LocalSession[];
  pruneExpired: () => string[];
  recordActivity: (reference: string) => LocalSession;
  resolve: (reference: string) => LocalSession;
};

function toPublicSession(session: StoredSession): LocalSession {
  const {
    buffer: _buffer,
    ingestCapability: _ingestCapability,
    streamCapability: _streamCapability,
    ...publicSession
  } = session;
  return publicSession;
}

/** Build a session store with injectable time for deterministic lifecycle tests. */
export function createLocalSessionStore({
  now = Date.now,
}: {
  now?: () => number;
} = {}): LocalSessionStore {
  const sessions = new Map<string, StoredSession>();
  const clientSessions = new Map<string, string>();

  const resolveStored = (reference: string): StoredSession => {
    const byId = sessions.get(reference);
    if (byId) {
      return byId;
    }
    const matches = [...sessions.values()].filter(
      (session) => session.label === reference,
    );
    if (matches.length === 0) {
      throw new Error(`Local session "${reference}" was not found.`);
    }
    if (matches.length > 1) {
      throw new AmbiguousLocalSessionError(reference);
    }
    const [match] = matches;
    if (!match) {
      throw new Error(`Local session "${reference}" was not found.`);
    }
    return match;
  };

  const update = (
    session: StoredSession,
    changes: Partial<
      Omit<StoredSession, "id" | "label" | "cwd" | "createdAt" | "buffer">
    >,
  ): StoredSession => {
    const next = { ...session, ...changes };
    sessions.set(next.id, next);
    return next;
  };

  return {
    create({ clientId, label, cwd }) {
      const existingId = clientId ? clientSessions.get(clientId) : undefined;
      if (existingId) {
        return toPublicSession(resolveStored(existingId));
      }
      const timestamp = now();
      const session: StoredSession = {
        id: uuidv7(),
        clientId,
        label,
        cwd,
        createdAt: timestamp,
        lastActivityAt: timestamp,
        state: "open",
        buffer: createSpotlightBuffer(SESSION_BUFFER_SIZE),
        ingestCapability: randomBytes(24).toString("base64url"),
        streamCapability: randomBytes(24).toString("base64url"),
      };
      sessions.set(session.id, session);
      if (clientId) {
        clientSessions.set(clientId, session.id);
      }
      return toPublicSession(session);
    },
    close(reference) {
      const timestamp = now();
      const session = resolveStored(reference);
      return toPublicSession(
        update(session, {
          state: "retained",
          lastActivityAt: timestamp,
          expiresAt: timestamp + SESSION_RETENTION_MS,
        }),
      );
    },
    getBuffer(reference) {
      return resolveStored(reference).buffer;
    },
    getCapabilities(reference) {
      const session = resolveStored(reference);
      return {
        ingest: session.ingestCapability,
        stream: session.streamCapability,
      };
    },
    list() {
      return [...sessions.values()]
        .map(toPublicSession)
        .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
    },
    pruneExpired() {
      const timestamp = now();
      const expired = [...sessions.values()]
        .filter(
          (session) =>
            session.state === "retained" &&
            session.expiresAt !== undefined &&
            session.expiresAt <= timestamp,
        )
        .map((session) => session.id);
      for (const id of expired) {
        const session = sessions.get(id);
        if (session?.clientId && clientSessions.get(session.clientId) === id) {
          clientSessions.delete(session.clientId);
        }
        sessions.delete(id);
      }
      return expired;
    },
    recordActivity(reference) {
      const timestamp = now();
      const session = resolveStored(reference);
      return toPublicSession(
        update(session, {
          lastActivityAt: timestamp,
          expiresAt:
            session.state === "retained"
              ? timestamp + SESSION_RETENTION_MS
              : undefined,
        }),
      );
    },
    resolve(reference) {
      return toPublicSession(resolveStored(reference));
    },
  };
}
