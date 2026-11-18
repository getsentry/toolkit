/**
 * Per-call cancellation. The MCP SDK gives each tool call an `AbortSignal`
 * that fires when the client cancels the call. The server context is shared
 * by every call on a session, so the signal goes on a per-call copy instead,
 * and caches keyed by context look through that copy to the session context.
 */
import type { ServerContext } from "../../types";

/** The context each per-call copy was derived from. */
const sessionContexts = new WeakMap<ServerContext, ServerContext>();

/**
 * `context` for one tool call that `signal` cancels. Without a signal the
 * context is returned as is.
 */
export function withCallSignal(
  context: ServerContext,
  signal: AbortSignal | undefined,
): ServerContext {
  if (!signal) {
    return context;
  }
  const callContext = { ...context, signal };
  sessionContexts.set(callContext, getSessionContext(context));
  return callContext;
}

/**
 * The context `context` was derived from by {@link withCallSignal}, or
 * `context` itself. Key state shared across calls, such as caches, on this,
 * and run shared lookups with it so one call's cancellation never fails
 * another call that waits on the same lookup.
 */
export function getSessionContext(context: ServerContext): ServerContext {
  return sessionContexts.get(context) ?? context;
}
