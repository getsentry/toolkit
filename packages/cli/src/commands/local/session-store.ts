/**
 * In-memory lifecycle and isolation for Local control-plane sessions.
 *
 * Session metadata and envelopes intentionally disappear when the daemon exits.
 */

import { randomBytes } from "node:crypto";
import type { ReceiverBuffer } from "./receiver-ingest.js";
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
  readonly clientId?: string | undefined;
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
  buffer: ReceiverBuffer;
  retention: LocalRetentionBuffer;
  ingestCapability: string;
  streamCapability: string;
  /** Runs that joined the session through `acquire` and are still running. */
  leases: number;
  /** Created by `acquire`, so its last lease closes it. */
  closesWithLeases: boolean;
};

/** Session label, working directory, and optional retry idempotency key. */
export type CreateLocalSessionInput = {
  readonly clientId?: string | undefined;
  readonly label: string;
  readonly cwd: string;
  readonly maxEnvelopes?: number | undefined;
};

/** `code` of the control plane's 409 body for an ambiguous session name. */
export const AMBIGUOUS_SESSION_CODE = "ambiguous_session";

/**
 * Response header naming the session a shared name resolved to for a read,
 * as JSON `{ id, others: [{ id, createdAt }], more? }`. `others` lists at most
 * {@link SESSION_CHOICE_LIMIT} of the other open sessions and `more` counts
 * the rest, which keeps the header small however many runs were left open.
 */
export const SESSION_CHOICE_HEADER = "X-Sentry-Local-Session-Choice";

/** Most other open sessions that {@link SESSION_CHOICE_HEADER} names. */
export const SESSION_CHOICE_LIMIT = 5;

/**
 * The session a reference resolved to and the other open sessions that share
 * its name; `others` is empty for a session ID or a name with one open session.
 */
export type LocalSessionChoice = {
  readonly session: LocalSession;
  readonly others: LocalSession[];
};

/** In-memory session lifecycle and access to isolated telemetry buffers. */
export type LocalSessionStore = {
  create: (input: CreateLocalSessionInput) => LocalSession;
  /**
   * Join the newest open session with this label, or create one, and take a
   * lease on it. A session that `acquire` created closes when its last lease
   * is released; one made by `create` stays open until `close`.
   */
  acquire: (input: CreateLocalSessionInput) => {
    session: LocalSession;
    reused: boolean;
  };
  /**
   * Give back one lease. With `discardIfEmpty`, a session that closes here
   * and never received an envelope is removed instead of retained. Returns
   * undefined when the session was removed.
   */
  release: (
    id: string,
    options?: { discardIfEmpty?: boolean },
  ) => LocalSession | undefined;
  setMaxEnvelopes: (reference: string, value: number) => Promise<LocalSession>;
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
  getBuffer: (reference: string) => ReceiverBuffer;
  list: () => LocalSession[];
  pruneExpired: () => string[];
  recordActivity: (reference: string) => LocalSession;
  /** Resolve a session ID or name; see {@link LocalSessionChoice}. */
  choose: (reference: string) => LocalSessionChoice;
  resolve: (reference: string) => LocalSession;
};

/** Newest first; the ID breaks ties between sessions created together. */
function newestFirst(left: LocalSession, right: LocalSession): number {
  return right.createdAt - left.createdAt || (left.id < right.id ? 1 : -1);
}

function toPublicSession(session: StoredSession): LocalSession {
  const {
    buffer: _buffer,
    retention: _retention,
    ingestCapability: _ingestCapability,
    streamCapability: _streamCapability,
    leases: _leases,
    closesWithLeases: _closesWithLeases,
    ...publicSession
  } = session;
  return publicSession;
}

/**
 * Build a session store with injectable time for deterministic lifecycle tests.
 *
 * @param onChange - Called with every session after one is created, closed,
 *   or expires; not on activity, which every ingested envelope records
 */
export function createLocalSessionStore({
  now = Date.now,
  onChange,
}: {
  now?: () => number;
  onChange?: (sessions: LocalSession[]) => void;
} = {}): LocalSessionStore {
  const sessions = new Map<string, StoredSession>();
  const clientSessions = new Map<string, string>();
  const listeners = new Map<string, Set<(event: LocalSessionEvent) => void>>();
  const notify = (id: string, event: LocalSessionEvent) => {
    for (const listener of listeners.get(id) ?? []) listener(event);
  };

  const list = () =>
    Array.from(sessions.values(), toPublicSession).sort(
      (left, right) => right.lastActivityAt - left.lastActivityAt,
    );
  const changed = () => onChange?.(list());

  /**
   * Resolve a session ID, or a name to the newest of its open sessions, or to
   * its newest session when none is open. Names repeat because a run that
   * finds no open session with its name creates one.
   */
  const chooseStored = (
    reference: string,
  ): { session: StoredSession; others: StoredSession[] } => {
    const byId = sessions.get(reference);
    if (byId) {
      return { session: byId, others: [] };
    }
    const named = [...sessions.values()]
      .filter((session) => session.label === reference)
      .sort(newestFirst);
    const open = named.filter((session) => session.state === "open");
    const [session] = open.length > 0 ? open : named;
    if (!session) {
      throw new Error(`Local session "${reference}" was not found.`);
    }
    return { session, others: open.filter((other) => other !== session) };
  };
  const resolveStored = (reference: string): StoredSession =>
    chooseStored(reference).session;

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

  const createStored = (
    {
      clientId,
      label,
      cwd,
      maxEnvelopes = DEFAULT_MAX_ENVELOPES,
    }: CreateLocalSessionInput,
    leased: boolean,
  ): StoredSession => {
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
      leases: leased ? 1 : 0,
      closesWithLeases: leased,
    };
    sessions.set(session.id, session);
    if (clientId) {
      clientSessions.set(clientId, session.id);
    }
    changed();
    return session;
  };

  const closeStored = (session: StoredSession): StoredSession => {
    if (session.state === "retained") return session;
    const timestamp = now();
    const closed = update(session, {
      state: "retained",
      lastActivityAt: timestamp,
      expiresAt: timestamp + SESSION_RETENTION_MS,
    });
    notify(session.id, { state: "retained", expiresAt: closed.expiresAt });
    changed();
    return closed;
  };

  const removeStored = (id: string) => {
    const session = sessions.get(id);
    if (session?.clientId && clientSessions.get(session.clientId) === id) {
      clientSessions.delete(session.clientId);
    }
    sessions.delete(id);
    listeners.delete(id);
  };

  return {
    create(input) {
      validateMaxEnvelopes(input.maxEnvelopes ?? DEFAULT_MAX_ENVELOPES);
      const existingId = input.clientId
        ? clientSessions.get(input.clientId)
        : undefined;
      if (existingId) {
        return toPublicSession(resolveStored(existingId));
      }
      return toPublicSession(createStored(input, false));
    },
    acquire(input) {
      validateMaxEnvelopes(input.maxEnvelopes ?? DEFAULT_MAX_ENVELOPES);
      const [open] = [...sessions.values()]
        .filter(
          (session) =>
            session.label === input.label && session.state === "open",
        )
        .sort(newestFirst);
      if (open) {
        return {
          session: toPublicSession(update(open, { leases: open.leases + 1 })),
          reused: true,
        };
      }
      return {
        session: toPublicSession(createStored(input, true)),
        reused: false,
      };
    },
    release(id, { discardIfEmpty = false } = {}) {
      const session = resolveStored(id);
      if (session.state === "retained" || session.leases === 0) {
        return toPublicSession(session);
      }
      const released = update(session, { leases: session.leases - 1 });
      if (released.leases > 0 || !released.closesWithLeases) {
        return toPublicSession(released);
      }
      const closed = closeStored(released);
      if (discardIfEmpty && closed.buffer.read({ all: true }).length === 0) {
        removeStored(closed.id);
        changed();
        return undefined;
      }
      return toPublicSession(closed);
    },
    getRetention(reference) {
      return resolveStored(reference).retention;
    },
    async setMaxEnvelopes(reference, value) {
      const session = resolveStored(reference);
      await session.retention.resize(value);
      return toPublicSession(
        update(resolveStored(session.id), { maxEnvelopes: value }),
      );
    },
    close(reference) {
      return toPublicSession(closeStored(resolveStored(reference)));
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
    list,
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
      for (const id of expired) removeStored(id);
      if (expired.length > 0) {
        changed();
      }
      return expired;
    },
    recordActivity(reference) {
      const session = resolveStored(reference);
      if (session.state === "retained") return toPublicSession(session);
      return toPublicSession(update(session, { lastActivityAt: now() }));
    },
    choose(reference) {
      const { session, others } = chooseStored(reference);
      return {
        session: toPublicSession(session),
        others: others.map(toPublicSession),
      };
    },
    resolve(reference) {
      return toPublicSession(resolveStored(reference));
    },
  };
}
