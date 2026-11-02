/** A concrete API path matched against an OpenAPI path template. */
export type ApiPathTemplateMatch = {
  /** Path parameter values by name, as they appear in the path. */
  parameters: Record<string, string>;
  /** Segments that matched the template literally, for ranking overlaps. */
  literalSegments: number;
};

const TEMPLATE_SEGMENT = /^\{([^{}]+)\}$/;

/**
 * Matches a concrete API path against an OpenAPI path template such as
 * `/api/0/organizations/{organization_id_or_slug}/issues/`.
 *
 * Each `{name}` matches one non-empty segment; every other segment must be
 * equal, and the segment counts must match, trailing slash included. Callers
 * own decoding and validating segments first and choosing among overlapping
 * templates, for which `literalSegments` ranks the most specific.
 */
export function matchApiPathTemplate(
  template: string,
  path: string,
): ApiPathTemplateMatch | undefined {
  const templateSegments = template.split("/");
  const segments = path.split("/");
  if (templateSegments.length !== segments.length) return;

  const parameters: Record<string, string> = {};
  let literalSegments = 0;
  for (const [index, templateSegment] of templateSegments.entries()) {
    const segment = segments[index] ?? "";
    const name = TEMPLATE_SEGMENT.exec(templateSegment)?.[1];
    if (name === undefined) {
      if (templateSegment !== segment) return;
      literalSegments++;
    } else {
      if (!segment || Object.hasOwn(parameters, name)) return;
      parameters[name] = segment;
    }
  }
  return { parameters, literalSegments };
}
