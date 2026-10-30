import type {
  AuthRequest,
  ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import skillDefinitions, {
  type SkillDefinition,
} from "@sentry/mcp-core/skillDefinitions";
import { logError, logIssue, logWarn } from "@sentry/mcp-core/telem/logging";
import { CODE_MODE_SKILLS } from "../../code-mode/definitions";
import { parseResourceMcpConstraints } from "../oauth/resource-scope";
import {
  type OAuthState,
  signState,
  verifyAndParseState,
} from "../oauth/state";
import { getUrlHost, sanitizeHrefUrl, sanitizeHtml } from "./html-utils";

const COOKIE_NAME = "mcp-approved-clients";
export const SKILL_PREFERENCES_COOKIE_NAME = "mcp-skill-preferences";
const ONE_YEAR_IN_SECONDS = 31536000;
const MAX_SKILL_PREFERENCE_CLIENTS = 10;
// Hosted OAuth approvals only mint active skills. Deprecated skills may still
// work for existing grants or explicit stdio use, but not through this form.
const APPROVABLE_SKILLS = (skillDefinitions as SkillDefinition[]).filter(
  (skill) => !skill.deprecated,
);
const APPROVABLE_SKILL_IDS = new Set(
  APPROVABLE_SKILLS.map((skill) => skill.id),
);

type SkillPreferencesCookie = {
  clients: Array<[clientId: string, skills: string[]]>;
};
/**
 * Imports a secret key string for HMAC-SHA256 signing.
 * @param secret - The raw secret key string.
 * @returns A promise resolving to the CryptoKey object.
 */
async function importKey(secret: string): Promise<CryptoKey> {
  if (!secret) {
    throw new Error(
      "COOKIE_SECRET is not defined. A secret key is required for signing cookies.",
    );
  }
  const enc = new TextEncoder();
  return await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, // not extractable
    ["sign", "verify"], // key usages
  );
}

/**
 * Signs data using HMAC-SHA256.
 * @param key - The CryptoKey for signing.
 * @param data - The string data to sign.
 * @returns A promise resolving to the signature as a hex string.
 */
async function signData(key: CryptoKey, data: string): Promise<string> {
  const enc = new TextEncoder();
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(data),
  );
  // Convert ArrayBuffer to hex string
  return [...new Uint8Array(signatureBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verifies an HMAC-SHA256 signature.
 * @param key - The CryptoKey for verification.
 * @param signatureHex - The signature to verify (hex string).
 * @param data - The original data that was signed.
 * @returns A promise resolving to true if the signature is valid, false otherwise.
 */
async function verifySignature(
  key: CryptoKey,
  signatureHex: string,
  data: string,
): Promise<boolean> {
  const enc = new TextEncoder();
  try {
    // Convert hex signature back to ArrayBuffer
    const signatureBytes = new Uint8Array(
      signatureHex.match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16)),
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes.buffer,
      enc.encode(data),
    );
  } catch (error) {
    logError(error, {
      loggerScope: ["cloudflare", "approval-dialog"],
      extra: {
        message: "Error verifying signature",
      },
    });
    return false;
  }
}

function getCookieValue(
  cookieHeader: string | null,
  cookieName: string,
): string | null {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const targetCookie = cookies.find((c) => c.startsWith(`${cookieName}=`));

  if (!targetCookie) return null;

  return targetCookie.substring(cookieName.length + 1);
}

async function getSignedCookiePayload(
  cookieHeader: string | null,
  cookieName: string,
  secret: string,
): Promise<string | null> {
  const cookieValue = getCookieValue(cookieHeader, cookieName);
  if (!cookieValue) return null;

  const parts = cookieValue.split(".");

  if (parts.length !== 2) {
    logWarn("Invalid signed cookie format", {
      loggerScope: ["cloudflare", "approval-dialog"],
      extra: { cookieName },
    });
    return null;
  }

  const [signatureHex, base64Payload] = parts;
  let payload: string;
  try {
    payload = atob(base64Payload);
  } catch {
    logWarn("Invalid signed cookie payload encoding", {
      loggerScope: ["cloudflare", "approval-dialog"],
      extra: { cookieName },
    });
    return null;
  }

  const key = await importKey(secret);
  const isValid = await verifySignature(key, signatureHex, payload);

  if (!isValid) {
    logWarn("Signed cookie signature verification failed", {
      loggerScope: ["cloudflare", "approval-dialog"],
      extra: { cookieName },
    });
    return null;
  }

  return payload;
}

async function createSignedCookieValue(
  payload: string,
  secret: string,
): Promise<string> {
  const key = await importKey(secret);
  const signature = await signData(key, payload);
  return `${signature}.${btoa(payload)}`;
}

/**
 * Parses the signed cookie and verifies its integrity.
 * @param cookieHeader - The value of the Cookie header from the request.
 * @param secret - The secret key used for signing.
 * @returns A promise resolving to the list of approved client IDs if the cookie is valid, otherwise null.
 */
async function getApprovedClientsFromCookie(
  cookieHeader: string | null,
  secret: string,
): Promise<string[] | null> {
  const payload = await getSignedCookiePayload(
    cookieHeader,
    COOKIE_NAME,
    secret,
  );
  if (!payload) return null;

  try {
    const approvedClients = JSON.parse(payload);
    if (!Array.isArray(approvedClients)) {
      logWarn("Approval cookie payload is not an array", {
        loggerScope: ["cloudflare", "approval-dialog"],
      });
      return null; // Payload isn't an array
    }
    // Ensure all elements are strings
    if (!approvedClients.every((item) => typeof item === "string")) {
      logWarn("Approval cookie payload contains non-string elements", {
        loggerScope: ["cloudflare", "approval-dialog"],
      });
      return null;
    }
    return approvedClients as string[];
  } catch (e) {
    logIssue(
      new Error(`Error parsing cookie payload: ${String(e)}`, { cause: e }),
    );
    return null; // JSON parsing failed
  }
}

function filterApprovableSkillIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  return [
    ...new Set(
      input.filter(
        (skill): skill is string =>
          typeof skill === "string" && APPROVABLE_SKILL_IDS.has(skill),
      ),
    ),
  ];
}

/**
 * Parses the signed skill preference cookie format and drops invalid entries.
 */
function parseSkillPreferencesPayload(
  payload: string,
): SkillPreferencesCookie | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { clients?: unknown }).clients)
    ) {
      return null;
    }

    const clients: SkillPreferencesCookie["clients"] = [];
    for (const entry of (parsed as { clients: unknown[] }).clients) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        continue;
      }
      const [clientId, skills] = entry;
      if (typeof clientId !== "string" || !clientId) {
        continue;
      }
      const filteredSkills = filterApprovableSkillIds(skills);
      if (filteredSkills.length === 0) {
        continue;
      }
      clients.push([clientId, filteredSkills]);
    }

    return { clients };
  } catch {
    return null;
  }
}

async function getSkillPreferencesFromCookie(
  cookieHeader: string | null,
  secret: string,
): Promise<SkillPreferencesCookie> {
  const payload = await getSignedCookiePayload(
    cookieHeader,
    SKILL_PREFERENCES_COOKIE_NAME,
    secret,
  );
  if (!payload) return { clients: [] };

  return parseSkillPreferencesPayload(payload) ?? { clients: [] };
}

/**
 * Returns signed remembered skills for preselecting the consent form only.
 */
export async function getRememberedSkillsForClient(
  cookieHeader: string | null,
  clientId: string,
  cookieSecret: string,
): Promise<string[] | undefined> {
  if (!clientId) return undefined;

  const preferences = await getSkillPreferencesFromCookie(
    cookieHeader,
    cookieSecret,
  );
  const entry = preferences.clients.find(([id]) => id === clientId);

  return entry?.[1];
}

/**
 * Updates the skill preference cookie as a newest-last, ten-client LRU.
 */
async function createSkillPreferencesSetCookie(
  request: Request,
  clientId: string,
  skills: string[],
  cookieSecret: string,
  resource?: string,
): Promise<string> {
  const preferences = await getSkillPreferencesFromCookie(
    request.headers.get("Cookie"),
    cookieSecret,
  );
  // Hidden project permissions retain their preferences, never their grant.
  const rememberedApiSkills = parseResourceMcpConstraints(resource)?.projectSlug
    ? (preferences.clients
        .find(([id]) => id === clientId)?.[1]
        .filter((skill) =>
          CODE_MODE_SKILLS.some((apiSkill) => apiSkill === skill),
        ) ?? [])
    : [];
  const filteredSkills = filterApprovableSkillIds([
    ...skills,
    ...rememberedApiSkills,
  ]);
  const clients = preferences.clients.filter(([id]) => id !== clientId);

  if (filteredSkills.length > 0) {
    clients.push([clientId, filteredSkills]);
  }

  const payload = JSON.stringify({
    clients: clients.slice(-MAX_SKILL_PREFERENCE_CLIENTS),
  } satisfies SkillPreferencesCookie);
  const cookieValue = await createSignedCookieValue(payload, cookieSecret);
  return `${SKILL_PREFERENCES_COOKIE_NAME}=${cookieValue}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${ONE_YEAR_IN_SECONDS}`;
}

/**
 * Checks if a given client ID has already been approved by the user,
 * based on a signed cookie.
 *
 * @param request - The incoming Request object to read cookies from.
 * @param clientId - The OAuth client ID to check approval for.
 * @param cookieSecret - The secret key used to sign/verify the approval cookie.
 * @returns A promise resolving to true if the client ID is in the list of approved clients in a valid cookie, false otherwise.
 */
export async function clientIdAlreadyApproved(
  request: Request,
  clientId: string,
  cookieSecret: string,
): Promise<boolean> {
  if (!clientId) return false;
  const cookieHeader = request.headers.get("Cookie");
  const approvedClients = await getApprovedClientsFromCookie(
    cookieHeader,
    cookieSecret,
  );

  return approvedClients?.includes(clientId) ?? false;
}

/**
 * Configuration for the approval dialog
 */
export interface ApprovalDialogOptions {
  /**
   * Client information to display in the approval dialog
   */
  client: ClientInfo | null;
  /**
   * Server information to display in the approval dialog
   */
  server: {
    name: string;
    logo?: string;
    description?: string;
  };
  /**
   * Optional organization/project constraints applied to this session.
   */
  scope?: {
    organizationSlug: string;
    projectSlug: string | null;
  } | null;
  /**
   * The specific redirect URI selected for this authorization request.
   */
  redirectUri?: string | null;
  /**
   * Arbitrary state data to pass through the approval flow
   * Will be encoded in the form and returned when approval is complete
   */
  state: Record<string, any>;
  /**
   * HMAC secret key for signing state parameters
   */
  cookieSecret: string;
  /**
   * Remembered skill IDs to preselect. New approvals select all approvable
   * skills except API Write, which requires an explicit choice.
   */
  defaultSkills?: string[];
}

/**
 * Encodes and signs arbitrary data to a HMAC-signed compact string.
 * @param data - The data to encode (will be stringified).
 * @param secret - HMAC secret key for signing.
 * @returns A HMAC-signed compact string (signature.base64payload).
 */
async function encodeState(data: any, secret: string): Promise<string> {
  try {
    const now = Date.now();
    const payload: OAuthState = {
      req: data as Record<string, unknown>,
      iat: now,
      exp: now + 10 * 60 * 1000, // 10 minute expiry
    };
    return await signState(payload, secret);
  } catch (error) {
    logError(error, {
      loggerScope: ["cloudflare", "approval-dialog"],
      extra: {
        message: "Error encoding approval dialog state",
      },
    });
    throw new Error("Could not encode state");
  }
}

/**
 * Decodes and verifies a HMAC-signed string back to its original data.
 * @param encoded - The HMAC-signed compact string.
 * @param secret - HMAC secret key for verification.
 * @returns The original data.
 * @throws Error if signature is invalid or state has expired.
 */
async function decodeState<T = any>(
  encoded: string,
  secret: string,
): Promise<T> {
  try {
    const parsed = await verifyAndParseState(encoded, secret);
    return parsed.req as T;
  } catch (error) {
    logError(error, {
      loggerScope: ["cloudflare", "approval-dialog"],
      extra: {
        message:
          "Error decoding approval dialog state - signature verification failed or expired",
      },
    });
    throw new Error("Could not decode state - invalid signature or expired");
  }
}

/**
 * Renders an approval dialog for OAuth authorization
 * The dialog displays information about the client and server
 * and includes a form to submit approval
 *
 * @param request - The HTTP request
 * @param options - Configuration for the approval dialog
 * @returns A Response containing the HTML approval dialog
 */
export async function renderApprovalDialog(
  request: Request,
  options: ApprovalDialogOptions,
): Promise<Response> {
  const {
    client,
    server,
    scope,
    redirectUri,
    state,
    cookieSecret,
    defaultSkills,
  } = options;
  const approvableSkills = APPROVABLE_SKILLS.filter(
    (skill) =>
      !scope?.projectSlug ||
      !CODE_MODE_SKILLS.some((codeModeSkill) => codeModeSkill === skill.id),
  );
  const defaultSkillIds =
    defaultSkills === undefined
      ? new Set(
          approvableSkills
            .filter((skill) => skill.id !== "api-write")
            .map((skill) => skill.id),
        )
      : new Set(filterApprovableSkillIds(defaultSkills));

  // Use static skill definitions bundled at build time
  // Generate HTML for all approvable skills.
  const skillsHtml = approvableSkills
    .map(
      (skill) => `
    <label class="permission-item">
      <input type="checkbox" name="skill" value="${sanitizeHtml(skill.id)}"${defaultSkillIds.has(skill.id) ? " checked" : ""} aria-labelledby="skill-name-${sanitizeHtml(skill.id)}" aria-describedby="skill-description-${sanitizeHtml(skill.id)}${skill.id === "api-write" ? " api-write-help" : ""}">
      <span class="permission-checkbox"></span>
      <div class="permission-content">
        <div class="permission-header">
          <span class="permission-name" id="skill-name-${sanitizeHtml(skill.id)}">${sanitizeHtml(skill.name)}</span>
          ${skill.toolCount !== undefined && !CODE_MODE_SKILLS.some((codeModeSkill) => codeModeSkill === skill.id) ? `<span class="permission-tool-count">${sanitizeHtml(String(skill.toolCount))} ${skill.toolCount === 1 ? "tool" : "tools"}</span>` : ""}
        </div>
        <div class="permission-description" id="skill-description-${sanitizeHtml(skill.id)}">${sanitizeHtml(skill.description)}</div>
        ${
          skill.id === "api-write"
            ? `<div class="permission-note" id="api-write-help">
          <strong>These permissions add up.</strong>
          <p>API Write allows issue changes even when <b>Triage Issues</b> is unchecked.</p>
          <p>It also allows project and team changes when <b>Manage Projects &amp; Teams</b> is unchecked. Your Sentry permissions and the organization scope above still apply.</p>
        </div>`
            : ""
        }
      </div>
    </label>
  `,
    )
    .join("");

  // Encode state for form submission (HMAC-signed to prevent tampering)
  const encodedState = await encodeState(state, cookieSecret);

  // Sanitize any untrusted content
  const clientName = client?.clientName
    ? sanitizeHtml(client.clientName)
    : "Unknown MCP Client";

  const clientUri = client?.clientUri
    ? sanitizeHtml(sanitizeHrefUrl(client.clientUri))
    : "";
  const policyUri = client?.policyUri
    ? sanitizeHtml(sanitizeHrefUrl(client.policyUri))
    : "";
  const tosUri = client?.tosUri
    ? sanitizeHtml(sanitizeHrefUrl(client.tosUri))
    : "";

  const rawRedirectUri =
    typeof redirectUri === "string" && redirectUri.length > 0
      ? redirectUri
      : client?.redirectUris?.length === 1
        ? client.redirectUris[0]
        : null;

  const redirectWarningUri = rawRedirectUri
    ? sanitizeHtml(rawRedirectUri)
    : null;
  const redirectHost = rawRedirectUri ? getUrlHost(rawRedirectUri) : "";
  const redirectDestination = redirectHost
    ? `<strong>${sanitizeHtml(redirectHost)}</strong>`
    : "this URL";

  const redirectWarningsHtml = redirectWarningUri
    ? `
        <div class="redirect-warning">
          <div class="redirect-uri-display">${redirectWarningUri}</div>
          <div class="redirect-warning-text">
            After approval, you will be redirected to ${redirectDestination}. Only approve if you recognize and trust this destination.
          </div>
        </div>
      `
    : "";

  const scopeHtml = scope?.projectSlug
    ? `
      <section class="scope-banner" role="note" aria-label="Session scope">
        <div class="scope-label">Session scope</div>
        <p class="scope-message">This session will be limited to the <strong class="scope-token">${sanitizeHtml(scope.projectSlug)}</strong> project in the <strong class="scope-token">${sanitizeHtml(scope.organizationSlug)}</strong> organization.</p>
        <p class="scope-help">The permissions below apply only within this scope. Your Sentry permissions still apply.</p>
      </section>
    `
    : `
      <section class="scope-banner" role="note" aria-label="Organization scope">
        <div class="scope-label">Organization scope</div>
        <p class="scope-message">${scope ? `Only <strong class="scope-token">${sanitizeHtml(scope.organizationSlug)}</strong>` : "<strong>All authorized organizations</strong>"}</p>
        <p class="scope-help">${scope ? "Every permission below, including API Write, is limited to this organization. Your Sentry permissions still apply." : "This connection can access any organization allowed by its Sentry token. The permissions below, including API Write, apply across those organizations."}</p>
      </section>
    `;

  // Generate HTML for the approval dialog
  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${clientName} | Authorization Request</title>
        <style>
          /* Modern, responsive styling with system fonts */
          :root {
            /* Color palette */
            --bg-gradient-start: oklch(0.13 0.028 261.692);
            --bg-gradient-mid: oklch(0.18 0.034 264.665);
            --bg-gradient-end: oklch(0.13 0.028 261.692);

            --card-bg: oklch(0.18 0.02 264);
            --card-bg-hover: oklch(0.20 0.02 264);

            --purple-primary: oklch(0.72 0.14 293);
            --purple-hover: oklch(0.76 0.14 293);
            --purple-light: oklch(0.82 0.11 293);

            --border-default: oklch(0.28 0.02 264);
            --border-hover: oklch(0.35 0.05 264);

            --text-primary: oklch(0.95 0 0);
            --text-secondary: oklch(0.75 0.01 264);
            --text-tertiary: oklch(0.60 0.01 264);

            /* Spacing scale */
            --space-xs: 0.25rem;
            --space-sm: 0.5rem;
            --space-md: 1rem;
            --space-lg: 1.5rem;
            --space-xl: 2rem;
            --space-2xl: 3rem;

            /* Border radius */
            --radius-sm: 6px;
            --radius-md: 10px;
            --radius-lg: 14px;

            /* Shadows */
            --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
            --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4), 0 2px 4px rgba(0, 0, 0, 0.3);
            --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5), 0 4px 8px rgba(0, 0, 0, 0.4);

            /* Transitions */
            --transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
            --transition-base: 200ms cubic-bezier(0.4, 0, 0.2, 1);
            --transition-slow: 300ms cubic-bezier(0.4, 0, 0.2, 1);
          }

          * {
            box-sizing: border-box;
          }

          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                         Helvetica, Arial, sans-serif, "Apple Color Emoji",
                         "Segoe UI Emoji", "Segoe UI Symbol";
            line-height: 1.6;
            color: var(--text-secondary);
            background: linear-gradient(180deg, var(--bg-gradient-start) 0%, var(--bg-gradient-mid) 50%, var(--bg-gradient-end) 100%);
            min-height: 100vh;
            margin: 0;
            padding: 0;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
          }

          .container {
            max-width: 600px;
            margin: var(--space-xl) auto;
            padding: var(--space-md);
          }

          /* Wider container for two-column layout */
          @media (min-width: 1024px) {
            .container {
              max-width: 1100px;
            }
          }

          .precard {
            text-align: center;
            margin-bottom: var(--space-lg);
          }

          .card {
            background: var(--card-bg);
            padding: var(--space-2xl);
            border-radius: var(--radius-lg);
            box-shadow: var(--shadow-lg);
            border: 1px solid var(--border-default);
          }

          .logo {
            width: 40px;
            height: 40px;
            color: var(--purple-light);
          }

          .alert {
            margin: 0 0 var(--space-xl) 0;
            font-size: 1.375rem;
            font-weight: 500;
            text-align: center;
            color: var(--text-primary);
            line-height: 1.4;
          }

          .scope-banner {
            margin: 0 0 var(--space-xl) 0;
            padding: var(--space-lg);
            border-radius: var(--radius-md);
            border: 1px solid rgba(171, 99, 232, 0.28);
            background:
              linear-gradient(180deg, rgba(171, 99, 232, 0.10), rgba(171, 99, 232, 0.03)),
              rgba(255, 255, 255, 0.02);
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
          }

          .scope-label {
            display: inline-flex;
            align-items: center;
            margin-bottom: var(--space-sm);
            padding: 0.2rem 0.6rem;
            border-radius: 999px;
            background: rgba(171, 99, 232, 0.14);
            color: var(--purple-light);
            font-size: 0.75rem;
            font-weight: 700;
            letter-spacing: 0.04em;
            text-transform: uppercase;
          }

          .scope-message {
            margin: 0 0 var(--space-sm) 0;
            color: var(--text-primary);
            font-size: 1rem;
            line-height: 1.6;
          }

          .scope-help {
            margin: 0;
            color: var(--text-secondary);
            font-size: 0.9375rem;
          }

          .scope-token {
            display: inline-block;
            padding: 0.0625rem 0.45rem;
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: var(--text-primary);
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            font-size: 0.95em;
            font-weight: 700;
            white-space: nowrap;
          }

          .policy-links {
            font-size: 0.8125rem;
            color: var(--text-tertiary);
            margin: var(--space-md) 0;
          }

          .actions {
            display: flex;
            justify-content: flex-end;
            gap: var(--space-md);
          }

          /* Keep Approve as the form's default submit while rendering Cancel first. */
          .actions .button-primary {
            order: 2;
          }

          .actions .button-secondary {
            order: 1;
          }

          a {
            color: var(--purple-primary);
            text-decoration: none;
            transition: color var(--transition-fast);
          }

          a:hover {
            color: var(--purple-hover);
            text-decoration: underline;
          }

          .button {
            padding: 0.75rem 1.75rem;
            font-weight: 600;
            cursor: pointer;
            border: none;
            font-size: 0.9375rem;
            border-radius: var(--radius-sm);
            transition: all var(--transition-base);
            font-family: inherit;
            min-height: 44px;
          }

          .button:focus-visible {
            outline: 2px solid var(--purple-primary);
            outline-offset: 2px;
          }

          .button-primary {
            background: var(--purple-primary);
            color: oklch(0.1 0 0);
            box-shadow: var(--shadow-sm);
          }

          .button-primary:hover {
            background: var(--purple-hover);
            transform: translateY(-1px);
            box-shadow: var(--shadow-md);
          }

          .button-primary:active {
            transform: translateY(0);
            box-shadow: var(--shadow-sm);
          }

          .button-secondary {
            background: transparent;
            border: 1.5px solid var(--border-default);
            color: var(--text-secondary);
          }

          .button-secondary:hover {
            border-color: var(--border-hover);
            background: rgba(255, 255, 255, 0.03);
            color: var(--text-primary);
          }

          .button-secondary:active {
            background: rgba(255, 255, 255, 0.05);
          }

          /* Permission items */
          .permission-item {
            display: flex;
            align-items: flex-start;
            gap: var(--space-md);
            padding: var(--space-sm) var(--space-md);
            background: transparent;
            border: none;
            border-left: 3px solid transparent;
            margin-bottom: var(--space-sm);
            cursor: pointer;
            transition: all var(--transition-base);
            position: relative;
          }

          .permission-item:last-child {
            margin-bottom: 0;
          }

          .permission-item:hover {
            background: rgba(255, 255, 255, 0.03);
          }

          .permission-item input[type="checkbox"] {
            position: absolute;
            opacity: 0;
            pointer-events: none;
          }

          .permission-checkbox {
            font-size: 1.5rem;
            color: var(--text-tertiary);
            transition: all var(--transition-fast);
            flex-shrink: 0;
            cursor: pointer;
            line-height: 1;
            user-select: none;
            width: 1.5rem;
            text-align: center;
          }

          /* Checkbox states */
          .permission-item input[type="checkbox"]:checked + .permission-checkbox {
            color: var(--purple-primary);
          }

          .permission-item input[type="checkbox"]:checked + .permission-checkbox::before {
            content: "☑";
          }

          .permission-item input[type="checkbox"]:not(:checked) + .permission-checkbox::before {
            content: "☐";
          }

          .permission-item:has(input[type="checkbox"]:checked) {
            border-left-color: var(--purple-primary);
            background: rgba(171, 99, 232, 0.05);
          }

          .permission-content {
            flex: 1;
            min-width: 0;
          }

          .permission-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: var(--space-md);
            margin-bottom: var(--space-xs);
          }

          .permission-name {
            font-weight: 600;
            color: var(--text-primary);
            font-size: 1rem;
            letter-spacing: -0.01em;
          }

          .permission-tool-count {
            font-size: 0.8125rem;
            color: var(--text-tertiary);
            font-weight: 500;
            white-space: nowrap;
            background: rgba(255, 255, 255, 0.05);
            padding: 0.125rem 0.5rem;
            border-radius: 12px;
            border: 1px solid var(--border-default);
          }

          .permission-description {
            color: var(--text-secondary);
            font-size: 0.875rem;
            line-height: 1.5;
          }

          .permission-note {
            margin-top: 12px;
            padding: 12px 14px;
            border: 1px solid rgba(242, 185, 94, 0.35);
            border-radius: var(--radius-sm);
            background: rgba(242, 185, 94, 0.06);
            font-size: 0.8125rem;
            line-height: 1.55;
            color: oklch(0.86 0.07 75);
          }

          .permission-note > strong {
            display: block;
            font-weight: 600;
            margin-bottom: 5px;
          }

          .permission-note p {
            margin: 0;
          }

          .permission-note p + p {
            margin-top: 5px;
          }

          .permission-item:has(input[value="api-write"]) {
            border: 1px solid var(--border-default);
            border-left-width: 3px;
            border-radius: var(--radius-sm);
            margin-top: var(--space-md);
            padding: var(--space-md);
          }

          .permission-item:has(input[value="api-write"]:checked) {
            border-color: var(--purple-primary);
          }

          .permission-item:has(input:focus-visible) {
            outline: 2px solid var(--purple-light);
            outline-offset: 3px;
          }

          /* Two-column layout for wider screens */
          .approval-grid {
            display: flex;
            flex-direction: column;
            gap: var(--space-xl);
            align-items: start;
          }

          .approval-column {
            display: flex;
            flex-direction: column;
            gap: var(--space-md);
          }

          /* Redirect URI warning styles */
          .redirect-warning {
            padding: var(--space-md);
            border-radius: var(--radius-md);
            background: rgba(251, 191, 36, 0.08);
            border: 1px solid oklch(0.75 0.15 85);
            border-left: 4px solid oklch(0.75 0.15 85);
          }

          .redirect-warning:not(:last-child) {
            margin-bottom: var(--space-md);
          }

          .redirect-uri-display {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            font-size: 0.875rem;
            font-weight: 600;
            color: var(--text-primary);
            word-break: break-all;
            padding: var(--space-sm);
            background: rgba(0, 0, 0, 0.3);
            border-radius: var(--radius-sm);
            margin-bottom: var(--space-sm);
          }

          .redirect-warning-text {
            font-size: 0.9375rem;
            color: oklch(0.85 0.12 85);
            line-height: 1.5;
            font-weight: 500;
          }

          /* Large screens and up: Two-column layout */
          @media (min-width: 1024px) {
            .approval-grid {
              flex-direction: row;
              gap: var(--space-2xl);
            }

            .approval-column {
              flex: 1 1 50%;
            }
          }

          /* Responsive adjustments */
          @media (max-width: 640px) {
            .container {
              margin: var(--space-md) auto;
              padding: var(--space-sm);
            }

            .card {
              padding: var(--space-lg);
              border-radius: var(--radius-md);
            }

            .alert {
              font-size: 1.125rem;
            }

            .actions {
              flex-direction: column-reverse;
              gap: var(--space-sm);
            }

            .button {
              width: 100%;
            }

            .permission-item {
              padding: var(--space-sm);
            }

            .permission-item:has(input[value="api-write"]) {
              padding: 12px;
            }

            .permission-header {
              flex-direction: column;
              align-items: flex-start;
              gap: var(--space-xs);
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <header class="precard">
            <svg class="logo" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M17.48 1.996c.45.26.823.633 1.082 1.083l13.043 22.622a2.962 2.962 0 0 1-2.562 4.44h-3.062c.043-.823.039-1.647 0-2.472h3.052a.488.488 0 0 0 .43-.734L16.418 4.315a.489.489 0 0 0-.845 0L12.582 9.51a23.16 23.16 0 0 1 7.703 8.362 23.19 23.19 0 0 1 2.8 11.024v1.234h-7.882v-1.236a15.284 15.284 0 0 0-6.571-12.543l-1.48 2.567a12.301 12.301 0 0 1 5.105 9.987v1.233h-9.3a2.954 2.954 0 0 1-2.56-1.48A2.963 2.963 0 0 1 .395 25.7l1.864-3.26a6.854 6.854 0 0 1 2.15 1.23l-1.883 3.266a.49.49 0 0 0 .43.734h6.758a9.985 9.985 0 0 0-4.83-7.272l-1.075-.618 3.927-6.835 1.075.615a17.728 17.728 0 0 1 6.164 5.956 17.752 17.752 0 0 1 2.653 8.154h2.959a20.714 20.714 0 0 0-3.05-9.627 20.686 20.686 0 0 0-7.236-7.036l-1.075-.618 4.215-7.309a2.958 2.958 0 0 1 4.038-1.083Z" fill="currentColor"></path></svg>
          </header>

          <main class="card">

            <p class="alert"><strong>${clientUri ? `<a href="${clientUri}" target="_blank" rel="noopener noreferrer">${clientName}</a>` : clientName}</strong> is requesting access to Sentry</p>

            ${scopeHtml}

            <form method="post" action="${new URL(request.url).pathname}" aria-label="Authorization form">
              <input type="hidden" name="state" value="${encodedState}">

              <div class="approval-grid">
                <!-- Left column: Skills selection -->
                <div class="approval-column">
                  <section class="permission-section">
                    <div role="group" aria-label="Select skills to grant access">
                      ${skillsHtml}
                    </div>
                  </section>
                </div>

                <!-- Right column: Actions -->
                <div class="approval-column">
                  ${redirectWarningsHtml}

                  ${
                    policyUri || tosUri
                      ? `<p class="policy-links">By approving, you agree to ${clientName}'s ${
                          policyUri && tosUri
                            ? `<a href="${policyUri}" target="_blank" rel="noopener noreferrer">Privacy Policy</a> and <a href="${tosUri}" target="_blank" rel="noopener noreferrer">Terms of Service</a>`
                            : policyUri
                              ? `<a href="${policyUri}" target="_blank" rel="noopener noreferrer">Privacy Policy</a>`
                              : `<a href="${tosUri}" target="_blank" rel="noopener noreferrer">Terms of Service</a>`
                        }.</p>`
                      : ""
                  }

                  <div class="actions">
                    <button type="submit" name="decision" value="approve" class="button button-primary" aria-label="Approve authorization request">Approve</button>
                    <button type="submit" name="decision" value="deny" class="button button-secondary" aria-label="Cancel authorization">Cancel</button>
                  </div>
                </div>
              </div>
            </form>
          </main>
        </div>
      </body>
    </html>
  `;

  return new Response(htmlContent, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Result of parsing an approval or denial from the consent form.
 */
export interface ParsedApprovalResult {
  /** The original state object passed through the form. */
  state: any;
  /** Headers to set on approval. Empty when authorization is denied. */
  headers: Headers;
  /** Selected skills. Empty when authorization is denied. */
  skills: string[];
  /** Whether the user approved or denied authorization. */
  decision: "approve" | "deny";
}

/**
 * Parses the consent form and signs approval cookies only when approved.
 *
 * @param request - The incoming POST Request object containing the form data.
 * @param cookieSecret - The secret key used to sign the approval cookie.
 * @returns The parsed consent decision, state, skills, and response headers.
 * @throws If the request method is not POST, form data is invalid, or state is missing.
 */
export async function parseRedirectApproval(
  request: Request,
  cookieSecret: string,
): Promise<ParsedApprovalResult> {
  if (request.method !== "POST") {
    throw new Error("Invalid request method. Expected POST.");
  }

  let state: any;
  let clientId: string | undefined;
  let skills: string[];
  let decision: "approve" | "deny";

  try {
    const formData = await request.formData();
    const encodedState = formData.get("state");
    const formDecision = formData.get("decision");

    if (typeof encodedState !== "string" || !encodedState) {
      throw new Error("Missing or invalid 'state' in form data.");
    }
    if (
      formDecision !== null &&
      formDecision !== "approve" &&
      formDecision !== "deny"
    ) {
      throw new Error("Invalid approval decision.");
    }

    state = await decodeState<{ oauthReqInfo?: AuthRequest }>(
      encodedState,
      cookieSecret,
    ); // Decode and verify the state
    clientId = state?.oauthReqInfo?.clientId; // Extract clientId from within the state

    if (!clientId) {
      throw new Error("Could not extract clientId from state object.");
    }

    // Extract skill selections from checkboxes - collect all 'skill' field values
    skills = filterApprovableSkillIds(formData.getAll("skill"));
    // Forms opened before this field existed submit no decision; those were
    // approval-only forms, so preserve their original behavior.
    decision = formDecision === "deny" ? "deny" : "approve";
  } catch (error) {
    logError(error, {
      loggerScope: ["cloudflare", "approval-dialog"],
      extra: {
        message: "Error processing approval form submission",
      },
    });
    throw new Error(
      `Failed to parse approval form: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (decision === "deny") {
    return { decision, state, headers: new Headers(), skills: [] };
  }

  // Get existing approved clients
  const cookieHeader = request.headers.get("Cookie");
  const existingApprovedClients =
    (await getApprovedClientsFromCookie(cookieHeader, cookieSecret)) || [];

  // Add the newly approved client ID (avoid duplicates)
  const updatedApprovedClients = [
    ...new Set([...existingApprovedClients, clientId]),
  ];

  // Sign the updated approval list
  const payload = JSON.stringify(updatedApprovedClients);
  const newCookieValue = await createSignedCookieValue(payload, cookieSecret);

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${newCookieValue}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${ONE_YEAR_IN_SECONDS}`,
  );
  headers.append(
    "Set-Cookie",
    await createSkillPreferencesSetCookie(
      request,
      clientId,
      skills,
      cookieSecret,
      state.oauthReqInfo.resource,
    ),
  );

  return { decision, state, headers, skills };
}

// sanitizeHtml function is now imported from "./html-utils"
