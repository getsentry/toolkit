/**
 * In-memory lifecycle and isolation for Local control-plane sessions.
 *
 * Session metadata and envelopes intentionally disappear when the daemon exits.
 */

import { randomBytes } from "node:crypto";
import { createSpotlightBuffer } from "@spotlightjs/spotlight/sdk";
import {
  createLocalRetentionBuffer,
  type LocalRetentionBuffer,
  validateMaxEnvelopes,
} from "./retention-buffer.js";
import { DEFAULT_MAX_ENVELOPES } from "./retention-limits.js";
import { uuidv7 } from "uuidv7";
import type { LocalSessionEvent } from "./viewer-protocol.js";

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
  readonly maxEnvelopes: number;
};

type StoredSession = LocalSession & {
  buffer: ReturnType<typeof createSpotlightBuffer>;
  retention: LocalRetentionBuffer;
  ingestCapability: string;
  streamCapability: string;
};

/** Session label, working directory, and optional retry idempotency key. */
export type CreateLocalSessionInput = {
  readonly clientId?: string;
  readonly label: string;
  readonly cwd: string;
  readonly maxEnvelopes?: number;
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
  setMaxEnvelopes: (reference: string, value: number) => LocalSession;
  getRetention: (reference: string) => LocalRetentionBuffer;
  close: (reference: string) => LocalSession;
  reset: (reference: string) => void;
  subscribe: (
    reference: string,
    listener: (event: LocalSessionEvent) => void,
  ) => () => void;
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
    retention: _retention,
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
  const listeners = new Map<string, Set<(event: LocalSessionEvent) => void>>();
  const notify = (id: string, event: LocalSessionEvent) => {
    for (const listener of listeners.get(id) ?? []) listener(event);
  };

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
    create({ clientId, label, cwd, maxEnvelopes = DEFAULT_MAX_ENVELOPES }) {
      validateMaxEnvelopes(maxEnvelopes);
      const existingId = clientId ? clientSessions.get(clientId) : undefined;
      if (existingId) {
        return toPublicSession(resolveStored(existingId));
      }
      const timestamp = now();
      const retention = createLocalRetentionBuffer(maxEnvelopes);
      const session: StoredSession = {
        id: uuidv7(),
        clientId,
        label,
        cwd,
        createdAt: timestamp,
        lastActivityAt: timestamp,
        state: "open",
        buffer: retention.buffer,
        retention,
        maxEnvelopes,
        ingestCapability: randomBytes(24).toString("base64url"),
        streamCapability: randomBytes(24).toString("base64url"),
      };
      sessions.set(session.id, session);
      if (clientId) {
        clientSessions.set(clientId, session.id);
      }
      return toPublicSession(session);
    },
    getRetention(reference) {
      return resolveStored(reference).retention;
    },
    setMaxEnvelopes(reference, value) {
      const session = resolveStored(reference);
      session.retention.resize(value);
      return toPublicSession(update(session, { maxEnvelopes: value }));
    },
    close(reference) {
      const session = resolveStored(reference);
      if (session.state === "retained") return toPublicSession(session);
      const timestamp = now();
      const closed = update(session, {
        state: "retained",
        lastActivityAt: timestamp,
        expiresAt: timestamp + SESSION_RETENTION_MS,
      });
      notify(session.id, { state: "retained", expiresAt: closed.expiresAt });
      return toPublicSession(closed);
    },
    reset(reference) {
      const session = resolveStored(reference);
      session.buffer.clear();
      notify(session.id, {
        state: session.state,
        action: "reset",
        ...(session.expiresAt !== undefined && {
          expiresAt: session.expiresAt,
        }),
      });
    },
    subscribe(reference, listener) {
      const session = resolveStored(reference);
      let subscriptions = listeners.get(session.id);
      if (!subscriptions)
        listeners.set(session.id, (subscriptions = new Set()));
      subscriptions.add(listener);
      return () => {
        subscriptions.delete(listener);
        if (subscriptions.size === 0) listeners.delete(session.id);
      };
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
        listeners.delete(id);
      }
      return expired;
    },
    recordActivity(reference) {
      const session = resolveStored(reference);
      if (session.state === "retained") return toPublicSession(session);
      return toPublicSession(update(session, { lastActivityAt: now() }));
    },
    resolve(reference) {
      return toPublicSession(resolveStored(reference));
    },
  };
}
