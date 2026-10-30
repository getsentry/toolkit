import { isPlainObject } from "./type-guards";

export { isPlainObject } from "./type-guards";

export function formatUserGeoSummary(value: unknown): string | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const parts = [
    value.country_code,
    value.city,
    value.region,
    value.country_name,
  ].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );

  if (parts.length === 0) {
    return null;
  }

  return [...new Set(parts)].join(", ");
}
