import type {
  EventsValidationResult,
  SentryApiService,
} from "../../../api-client";
import { logWarn } from "../../../telem/logging";
import type { PublicEventsDataset } from "../../../utils/events-datasets";
import { fetchCustomAttributes } from "./utils";

// Sentry's events/validate endpoint reports this for keys it can't resolve.
const UNKNOWN_ATTRIBUTE_ERROR = "Unknown attribute";
const MAX_LOOKUPS = 3;
const MAX_SUGGESTIONS = 10;

/**
 * The part of an attribute key to look up similar keys by: the inner key of
 * `tags[key,type]`, then the text before the first dot, so `error.message`
 * finds `error` and `error.type`.
 */
function attributeStem(name: string): string {
  const tagKey = /^tags\[([^,\]]+)/.exec(name)?.[1] ?? name;
  return tagKey.split(".")[0] ?? tagKey;
}

/**
 * Lists attributes that exist when validation rejects a key as unknown.
 *
 * The validate endpoint only says "Unknown attribute", so a caller that
 * passed explicit fields has no way to find the right key. Looks up keys
 * that share the rejected key's stem, in the same dataset, project, and time
 * range. Lookup failures leave the validation error unchanged.
 */
export async function getUnknownAttributeHints({
  apiService,
  organizationSlug,
  dataset,
  projectId,
  timeParams,
  validation,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  dataset: PublicEventsDataset;
  projectId?: string;
  timeParams: { statsPeriod?: string; start?: string; end?: string };
  validation: EventsValidationResult;
}): Promise<string[]> {
  if (dataset !== "logs" && dataset !== "spans" && dataset !== "metrics") {
    return [];
  }

  const unknownNames = new Set(
    [...validation.field, ...validation.query.fields, ...validation.orderby]
      .filter((item) => !item.valid && item.error === UNKNOWN_ATTRIBUTE_ERROR)
      .map((item) => item.name)
      .filter((name) => name.length > 0),
  );
  if (unknownNames.size === 0) {
    return [];
  }

  const stems = [...new Set([...unknownNames].map(attributeStem))]
    .filter((stem) => stem.length > 0)
    .slice(0, MAX_LOOKUPS);

  const lines = await Promise.all(
    stems.map(async (stem) => {
      try {
        const { attributes } = await fetchCustomAttributes(
          apiService,
          organizationSlug,
          dataset,
          projectId,
          timeParams,
          { substringMatch: stem },
        );
        const keys = Object.keys(attributes)
          .filter((key) => !unknownNames.has(key))
          .sort()
          .slice(0, MAX_SUGGESTIONS);
        return keys.length > 0
          ? `- matching \`${stem}\`: ${keys.map((key) => `\`${key}\``).join(", ")}`
          : `- matching \`${stem}\`: none`;
      } catch (error) {
        logWarn("Unknown-attribute lookup failed; omitting suggestions", {
          loggerScope: ["mcp", "search", "unknown-attribute-hints"],
          extra: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return null;
      }
    }),
  );

  const found = lines.filter((line): line is string => line !== null);
  if (found.length === 0) {
    return [];
  }
  return [
    `Attributes that exist on ${dataset} in this time range:`,
    ...found,
    "Use one of these keys, or drop the unknown field.",
  ];
}
