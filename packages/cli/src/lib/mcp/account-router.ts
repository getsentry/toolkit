/**
 * Per-call account routing for the stdio MCP server.
 *
 * The CLI stores several logins and picks the one that knows each command's
 * organization (`selectAccountForOrg`). This router applies the same rule
 * (`findAccountForOrg`) to MCP tool calls: mcp-core asks it for the
 * credential of the organization a call targets
 * (`ServerContext.credentialRouter`), and every request of that call uses
 * it. The account the server started with plays the CLI's current account,
 * for calls that target no organization or one no stored account knows.
 *
 * What the CLI does not need, this adds: each account is pinned to its user,
 * tokens resolve per call, and an org no account is known to reach lists
 * every account's orgs once, since a server outlives the org cache a single
 * command reads.
 *
 * Only accounts on the server the MCP server targets are candidates:
 * mcp-core sends every request to that one server.
 */

import { ConfigurationError } from "@sentry/api/client";
import type {
  CredentialRouter,
  RoutedCredential,
} from "@sentry/mcp-core/types";
import {
  type AccountRow,
  hasCachedOrgList,
  isAccountOnServer,
} from "../db/accounts.js";
import {
  findAccountForOrg,
  listUsableAccountsInScope,
  type StoredAccountRef,
} from "../db/auth.js";
import { AuthError } from "../errors.js";
import type { McpCredentialPin } from "../mcp.js";
import { logger } from "../logger.js";

const log = logger.withTag("mcp.accounts");

/** A stored account a credential is pinned to. */
export type StoredAccountPin = Extract<McpCredentialPin, { kind: "stored" }>;

export type McpAccountRouterOptions = {
  /** The server the MCP server sends requests to. */
  targetUrl: string;
  /** The account the server started with. */
  defaultPin: StoredAccountPin;
  /**
   * Run `fn` under a fresh copy of the server's credential environment, so
   * overlapping calls never share an account selection.
   */
  withCredentialEnv: <T>(fn: () => T) => T;
  /**
   * The pinned account's token. With `force`, refresh it past the usual
   * threshold (after an upstream 401). Fails when the account is gone or
   * now belongs to another user.
   */
  resolvePin: (
    pin: StoredAccountPin,
    options: { force?: boolean },
  ) => Promise<string>;
  /**
   * Cache the account's organization list, so its organizations route to
   * it. Runs for accounts without a fresh cached list when a call targets
   * an organization no candidate is known to reach.
   */
  cacheOrgList: (account: StoredAccountRef) => Promise<void>;
};

/** How long to wait before listing a failed or empty account's orgs again. */
const ORG_LIST_RETRY_MS = 5 * 60 * 1000;

/** Sentry org slugs are never entirely numeric, so digits are an org id. */
const NUMERIC_ORG_ID = /^\d+$/;

/**
 * Create the router. Each account is pinned to the user it had the first
 * time a call used it, the same protection the startup account gets: a
 * login that replaces the account's credentials in place is refused.
 */
export function createMcpAccountRouter(
  options: McpAccountRouterOptions,
): CredentialRouter {
  const { defaultPin, targetUrl } = options;
  const pins = new Map<string, StoredAccountPin>([
    [defaultPin.accountId, defaultPin],
  ]);
  const orgListAttempts = new Map<string, number>();
  const orgListsInFlight = new Map<string, Promise<void>>();

  /** Usable stored accounts on the target server, most recently used first. */
  function listCandidates(): AccountRow[] {
    return options
      .withCredentialEnv(() => listUsableAccountsInScope())
      .filter((row) => isAccountOnServer(row, targetUrl));
  }

  function pinFor(row: AccountRow): StoredAccountPin {
    let pin = pins.get(row.account_id);
    if (!pin) {
      pin = { kind: "stored", accountId: row.account_id, userId: row.user_id };
      pins.set(row.account_id, pin);
    }
    return pin;
  }

  async function credentialFor(
    pin: StoredAccountPin,
  ): Promise<RoutedCredential> {
    return {
      id: pin.accountId,
      accessToken: await resolveToken(pin, {}),
      refresh: () => resolveToken(pin, { force: true }),
    };
  }

  /**
   * The CLI's auth errors are not mcp-core errors; report them as
   * configuration errors so the client sees the message (which login to
   * run) instead of an internal error.
   */
  async function resolveToken(
    pin: StoredAccountPin,
    resolveOptions: { force?: boolean },
  ): Promise<string> {
    try {
      return await options.resolvePin(pin, resolveOptions);
    } catch (error) {
      if (error instanceof AuthError) {
        throw new ConfigurationError(error.message, { cause: error });
      }
      throw error;
    }
  }

  /** The account for the org under the CLI's rule, the default as current. */
  function findOwner(
    organizationSlug: string,
    candidates: AccountRow[],
  ): AccountRow | undefined {
    const orgId = NUMERIC_ORG_ID.test(organizationSlug)
      ? organizationSlug
      : undefined;
    return findAccountForOrg(organizationSlug, orgId, {
      current: candidates.find(
        (row) => row.account_id === defaultPin.accountId,
      ),
      host: targetUrl,
      // The startup account's orgs are listed before this runs, so a
      // missing list means the listing failed or it has no orgs.
      keepUnlistedActive: false,
    });
  }

  /** List the orgs of candidates without a fresh cached list, once at a time. */
  async function cacheOrgLists(candidates: AccountRow[]): Promise<void> {
    const now = Date.now();
    const pending = candidates.flatMap((row) => {
      const inFlight = orgListsInFlight.get(row.account_id);
      if (inFlight) {
        return [inFlight];
      }
      const lastAttempt = orgListAttempts.get(row.account_id);
      if (
        !row.host ||
        hasCachedOrgList(row.account_id) ||
        (lastAttempt !== undefined && now - lastAttempt < ORG_LIST_RETRY_MS)
      ) {
        return [];
      }
      orgListAttempts.set(row.account_id, now);
      const listing = options
        .cacheOrgList({ id: row.account_id, host: row.host })
        .catch((error: unknown) => {
          // Best-effort: the call falls back to the default account.
          log.debug(
            `Could not list organizations for account ${row.account_id}`,
            error,
          );
        })
        .finally(() => orgListsInFlight.delete(row.account_id));
      orgListsInFlight.set(row.account_id, listing);
      return [listing];
    });
    await Promise.all(pending);
  }

  async function pickAccount(
    organizationSlug: string,
  ): Promise<AccountRow | undefined> {
    const candidates = listCandidates();
    if (
      candidates.length === 0 ||
      (candidates.length === 1 &&
        candidates[0]?.account_id === defaultPin.accountId)
    ) {
      return;
    }
    // List the startup account's orgs first, so it keeps the orgs it can
    // reach instead of yielding to another account that has seen them.
    await cacheOrgLists(
      candidates.filter((row) => row.account_id === defaultPin.accountId),
    );
    const owner = findOwner(organizationSlug, candidates);
    if (owner) {
      return owner;
    }
    await cacheOrgLists(candidates);
    return findOwner(organizationSlug, candidates);
  }

  return {
    async resolve({ organizationSlug }) {
      const owner = organizationSlug
        ? await pickAccount(organizationSlug)
        : undefined;
      if (owner && owner.account_id !== defaultPin.accountId) {
        log.debug(
          `Using stored account ${owner.account_id} for organization '${organizationSlug}'`,
        );
        return await credentialFor(pinFor(owner));
      }
      return await credentialFor(defaultPin);
    },

    async list() {
      const others = listCandidates().filter(
        (row) => row.account_id !== defaultPin.accountId,
      );
      const resolved = await Promise.allSettled(
        others.map((row) => credentialFor(pinFor(row))),
      );
      const credentials = [await credentialFor(defaultPin)];
      for (const [index, result] of resolved.entries()) {
        if (result.status === "fulfilled") {
          credentials.push(result.value);
          continue;
        }
        // An account that can no longer sign in is left out; the others
        // still answer.
        log.debug(
          `Skipped stored account ${others[index]?.account_id ?? "unknown"}`,
          result.reason,
        );
      }
      return credentials;
    },
  };
}
