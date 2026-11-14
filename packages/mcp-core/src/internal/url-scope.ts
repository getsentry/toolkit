import { UserInputError } from "../errors";
import { isNumericId } from "../utils/slug-validation";

export function resolveScopedOrganizationSlug({
  resourceLabel,
  scopedOrganizationSlug,
  urlOrganizationSlug,
}: {
  resourceLabel: string;
  scopedOrganizationSlug?: string | null | undefined;
  urlOrganizationSlug: string;
}): string {
  if (!scopedOrganizationSlug) {
    return urlOrganizationSlug;
  }

  if (scopedOrganizationSlug !== urlOrganizationSlug) {
    throw new UserInputError(
      `${resourceLabel} URL is outside the active organization constraint. Expected organization "${scopedOrganizationSlug}" but got "${urlOrganizationSlug}".`,
    );
  }

  return scopedOrganizationSlug;
}

export function resolveScopedProjectSlug({
  resourceLabel,
  scopedProjectSlug,
  urlProjectSlug,
}: {
  resourceLabel: string;
  scopedProjectSlug?: string | null | undefined;
  urlProjectSlug: string;
}): string {
  if (!scopedProjectSlug) {
    return urlProjectSlug;
  }

  if (scopedProjectSlug !== urlProjectSlug) {
    throw new UserInputError(
      `${resourceLabel} URL is outside the active project constraint. Expected project "${scopedProjectSlug}" but got "${urlProjectSlug}".`,
    );
  }

  return scopedProjectSlug;
}

export function assertScopedProjectSlug({
  resourceLabel,
  scopedProjectSlug,
  actualProjectSlug,
}: {
  resourceLabel: string;
  scopedProjectSlug?: string | null | undefined;
  actualProjectSlug: string;
}): string {
  if (!scopedProjectSlug) {
    return actualProjectSlug;
  }

  if (scopedProjectSlug !== actualProjectSlug) {
    throw new UserInputError(
      `${resourceLabel} is outside the active project constraint. Expected project "${scopedProjectSlug}".`,
    );
  }

  return actualProjectSlug;
}

export function resolveScopedProjectSlugOrId({
  resourceLabel,
  scopedProjectSlugOrId,
  urlProjectSlug,
}: {
  resourceLabel: string;
  scopedProjectSlugOrId?: string | number | null | undefined;
  urlProjectSlug: string;
}): string | number {
  if (
    scopedProjectSlugOrId == null ||
    (typeof scopedProjectSlugOrId === "string" &&
      scopedProjectSlugOrId.trim() === "")
  ) {
    return urlProjectSlug;
  }

  // Project URLs encode slugs, not numeric IDs. When the scoped project is numeric,
  // prefer the URL slug and let the downstream project resolution path verify it.
  if (
    typeof scopedProjectSlugOrId === "number" ||
    isNumericId(String(scopedProjectSlugOrId))
  ) {
    return urlProjectSlug;
  }

  if (scopedProjectSlugOrId !== urlProjectSlug) {
    throw new UserInputError(
      `${resourceLabel} URL is outside the active project constraint. Expected project "${scopedProjectSlugOrId}" but got "${urlProjectSlug}".`,
    );
  }

  return scopedProjectSlugOrId;
}
