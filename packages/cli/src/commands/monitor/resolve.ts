import {
  getMetricMonitor,
  listMetricMonitorsPaginated,
  type MetricMonitor,
} from "../../lib/api/detectors.js";
import {
  API_MAX_PER_PAGE,
  MAX_PAGINATION_PAGES,
} from "../../lib/api/infrastructure.js";
import {
  parseOrgProjectInput,
  type ParsedOrgProject,
} from "../../lib/arg-parsing.js";
import { ORG_TARGET } from "../../lib/completion-target.js";
import { ResolutionError, ValidationError } from "../../lib/errors.js";
import {
  boundPositional,
  type BoundPositional,
} from "../../lib/positional-parse.js";
import { resolveOrgOnlyTarget } from "../../lib/resolve-target.js";
import {
  applySentryUrlContext,
  parseSentryUrl,
} from "../../lib/sentry-url-parser.js";

type MonitorRef = { ref: string; target: ParsedOrgProject; baseUrl?: string };
export type MonitorArgument = BoundPositional<MonitorRef, MonitorRef>;

export function monitorParameter(command: string) {
  return {
    placeholder: "org/monitor-id-or-name",
    brief: "Monitor ID or exact name, optionally prefixed with org/",
    parse: boundPositional(
      ORG_TARGET,
      (raw): MonitorRef => {
        const value = (raw ?? "").trim();
        if (/^https?:\/\//i.test(value)) {
          const url = new URL(value);
          const parsed = parseSentryUrl(value) ?? parseSentryUrl(url.origin);
          const match =
            /^\/(?:organizations\/[^/]+\/)?monitors\/(\d+)\/?$/.exec(
              url.pathname,
            );
          if (!parsed?.org || !match?.[1])
            throw new ValidationError("Expected a Sentry /monitors/<id>/ URL.");
          return {
            ref: match[1],
            target: { type: "org-all", org: parsed.org },
            baseUrl: parsed.baseUrl,
          };
        }
        const parts = value.split("/").map((part) => part.trim());
        if (
          !value ||
          parts.length > 2 ||
          !parts.at(-1) ||
          (parts.length === 2 && !parts[0])
        ) {
          throw new ValidationError(
            `Use: sentry monitor ${command} <org>/<monitor-id-or-name>`,
          );
        }
        const ref = parts.at(-1) as string;
        const input = parseOrgProjectInput(
          parts.length === 2 ? `${parts[0]}/` : undefined,
        );
        return { ref, target: input.parsed };
      },
      async (value) => {
        if (value.baseUrl) applySentryUrlContext(value.baseUrl);
        return value;
      },
    ),
  } as const;
}

/** Name lookups exhaust pagination and reject duplicates even within one org. */
export async function resolveMonitor(
  argument: MonitorArgument,
  cwd: string,
  command: string,
): Promise<{ org: string; monitor: MetricMonitor }> {
  const { ref, target } = await argument.resolved;
  const org = await resolveOrgOnlyTarget(target, cwd, `monitor ${command}`);
  if (/^\d+$/.test(ref))
    return { org, monitor: await getMetricMonitor(org, ref) };
  const hits: MetricMonitor[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    const result = await listMetricMonitorsPaginated(org, {
      perPage: API_MAX_PER_PAGE,
      cursor,
    });
    hits.push(
      ...result.data.filter((m) => m.name.toLowerCase() === ref.toLowerCase()),
    );
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  if (cursor)
    throw new ValidationError(
      "Monitor name search exceeded the pagination limit. Use an explicit monitor ID.",
    );
  if (hits.length > 1) {
    throw new ValidationError(
      `Monitor name '${ref}' is ambiguous in ${org}. Use an ID: ${hits.map((m) => `${org}/${m.id}`).join(", ")}`,
    );
  }
  const hit = hits[0];
  if (!hit)
    throw new ResolutionError(
      `Monitor '${ref}'`,
      "not found",
      `sentry monitor ${command} <org>/<monitor-id>`,
    );
  // A detail read protects mutations against an unrelated detector type and
  // provides the complete source/config baseline, independent of list projection.
  return { org, monitor: await getMetricMonitor(org, hit.id) };
}
