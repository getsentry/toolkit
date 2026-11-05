/** Organization-scoped alert references: [<org>/]<id-or-name>. */
import { ORG_TARGET } from "../../lib/completion-target.js";
import { ValidationError } from "../../lib/errors.js";
import {
  type BoundPositional,
  boundPositional,
} from "../../lib/positional-parse.js";
import { parseSentryUrl } from "../../lib/sentry-url-parser.js";
import { parseOrgInput, resolveOrgInput } from "../../lib/target-positional.js";
import type { OrgInput } from "../../lib/target-positional.js";
import { getAlert, listAlertsPaginated } from "../../lib/api/alerts.js";
import { MAX_PAGINATION_PAGES } from "../../lib/api/infrastructure.js";
import type { Alert } from "../../lib/api/alerts.js";

export type AlertRef = { ref: string; target: OrgInput };
export type AlertArgument = BoundPositional<
  AlertRef,
  { org: string; ref: string }
>;

function parseAlertRef(raw: string | undefined): AlertRef {
  const text = raw?.trim() ?? "";
  const url = parseSentryUrl(text);
  if (url) {
    const match = new URL(text).pathname.match(/\/monitors\/alerts\/(\d+)\/?$/);
    if (!url.org || !match?.[1]) {
      throw new ValidationError(
        "Expected an alert detail URL or [<org>/]<id-or-name>.",
        "alert",
      );
    }
    return { ref: match[1], target: { org: url.org, baseUrl: url.baseUrl } };
  }
  const slash = text.indexOf("/");
  const ref = (slash < 0 ? text : text.slice(slash + 1)).trim();
  if (
    !ref ||
    ref.includes("/") ||
    (slash >= 0 && !text.slice(0, slash).trim())
  ) {
    throw new ValidationError("Expected [<org>/]<id-or-name>.", "alert");
  }
  return { ref, target: slash < 0 ? {} : parseOrgInput(text.slice(0, slash)) };
}

export function alertParameter(usageHint: string) {
  return {
    placeholder: "alert",
    brief: "[<org>/]<id-or-name> or alert URL",
    parse: boundPositional(
      ORG_TARGET,
      parseAlertRef,
      async ({ ref, target }, context: { cwd: string }) => {
        const { org } = await resolveOrgInput(target, context.cwd, usageHint);
        return { org, ref };
      },
      ({ target }) => {
        if (!target.org) {
          throw new ValidationError(
            `Delete requires an explicit <org>/<id-or-name>.\nUsage: ${usageHint}`,
            "alert",
          );
        }
      },
    ),
  } as const;
}

/** Resolve names across every page, never silently choosing an ambiguous match. */
export async function resolveAlert(org: string, ref: string): Promise<Alert> {
  if (/^\d+$/.test(ref)) {
    return await getAlert(org, ref);
  }
  const matches: Alert[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < MAX_PAGINATION_PAGES; index += 1) {
    const page = await listAlertsPaginated(org, { perPage: 100, cursor });
    matches.push(
      ...page.data.filter(
        (alert) => alert.name.toLowerCase() === ref.toLowerCase(),
      ),
    );
    cursor = page.nextCursor;
    if (!cursor) {
      break;
    }
    if (seen.has(cursor)) {
      throw new ValidationError(
        `Alert pagination repeated a cursor in '${org}'; use an ID.`,
        "alert",
      );
    }
    seen.add(cursor);
  }
  if (cursor) {
    throw new ValidationError(
      `Alert search exceeded ${MAX_PAGINATION_PAGES} pages in '${org}'; use an ID.`,
      "alert",
    );
  }
  const [alert] = matches;
  if (!alert) {
    throw new ValidationError(
      `Alert '${ref}' not found in '${org}'. Use 'sentry alert list ${org}/'.`,
      "alert",
    );
  }
  if (matches.length > 1) {
    throw new ValidationError(
      `Alert name '${ref}' is ambiguous in '${org}'; use an ID: ${matches.map((match) => match.id).join(", ")}.`,
      "alert",
    );
  }
  // Detail is authoritative for edits, including all condition groups and config.
  return await getAlert(org, alert.id);
}
