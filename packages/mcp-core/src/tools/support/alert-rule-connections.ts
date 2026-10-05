import type { SentryApiService } from "../../api-client";
import { UserInputError } from "../../errors";
import {
  assertProjectConstraintEvidence,
  assertProjectRefWithinConstraint,
} from "../catalog/support/project-constraints";

/** Shared Alerts can only be mutated from a session covering their entire scope. */
export async function validateAlertRuleProjectScope(
  api: SentryApiService,
  params: {
    organizationSlug: string;
    ruleId: string;
    projectSlug?: string | null;
    scopedProjectSlug?: string | null;
  },
): Promise<{ id: string; slug: string } | undefined> {
  if (params.projectSlug) {
    assertProjectRefWithinConstraint({
      resourceLabel: "Alert rule",
      scopedProjectSlug: params.scopedProjectSlug,
      project: { slug: params.projectSlug },
    });
  }
  const projectSlug = params.scopedProjectSlug ?? params.projectSlug;
  if (!projectSlug) return undefined;
  const [project, scope] = await Promise.all([
    api.getProject({
      organizationSlug: params.organizationSlug,
      projectSlugOrId: projectSlug,
    }),
    api.getAlertRuleProjectScope({
      organizationSlug: params.organizationSlug,
      ruleId: params.ruleId,
    }),
  ]);
  assertProjectConstraintEvidence({
    resourceLabel: "Alert rule",
    scopedProjectSlug: params.scopedProjectSlug,
    hasEvidence:
      !scope.includesAllProjects &&
      scope.projectIds.length > 0 &&
      scope.projectIds.every((id) => id === String(project.id)),
  });
  if (
    !scope.includesAllProjects &&
    !scope.projectIds.includes(String(project.id))
  ) {
    throw new UserInputError(`Alert rule is outside project "${projectSlug}".`);
  }
  return params.scopedProjectSlug
    ? { id: String(project.id), slug: project.slug }
    : undefined;
}

/** Apply connection changes after the caller has authorized the workflow's current scope. */
export async function resolveAlertRuleConnections(
  api: SentryApiService,
  params: {
    organizationSlug: string;
    currentDetectorIds: readonly (string | number)[];
    addProjectSlugs?: readonly string[];
    removeProjectSlugs?: readonly string[];
    addDetectorIds?: readonly string[];
    removeDetectorIds?: readonly string[];
    scopedProject?: { id: string; slug: string };
  },
): Promise<string[]> {
  const additions = new Set<string>();
  const removals = new Set<string>();
  const detectorIds = new Set(params.currentDetectorIds.map(String));
  for (const [projectSlugs, requestedDetectorIds, resolvedIds] of [
    [params.addProjectSlugs, params.addDetectorIds, additions],
    [params.removeProjectSlugs, params.removeDetectorIds, removals],
  ] as const) {
    for (const projectSlug of new Set(projectSlugs ?? [])) {
      const project = await api.getProject({
        organizationSlug: params.organizationSlug,
        projectSlugOrId: projectSlug,
      });
      const projectId = String(project.id);
      assertProjectConstraintEvidence({
        resourceLabel: "Alert source",
        scopedProjectSlug: params.scopedProject?.slug,
        hasEvidence: projectId === params.scopedProject?.id,
      });

      const matches = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await api.listDetectorsPage({
          organizationSlug: params.organizationSlug,
          projectId,
          types: ["issue_stream"],
          cursor,
          limit: 100,
        });
        for (const detector of page.detectors) {
          if (
            detector.type === "issue_stream" &&
            detector.projectId !== null &&
            String(detector.projectId) === projectId
          ) {
            matches.add(String(detector.id));
          }
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      const [detectorId] = matches;
      if (!detectorId) {
        throw new UserInputError(
          `No issue_stream monitor was found for project "${project.slug}". Sentry creates this source automatically; it must exist before its Alert connection can be changed.`,
        );
      }
      if (matches.size > 1) {
        throw new UserInputError(
          `Multiple issue_stream monitors were found for project "${project.slug}". The project's Alert source cannot be resolved unambiguously.`,
        );
      }
      resolvedIds.add(detectorId);
    }

    for (const detectorId of new Set(requestedDetectorIds ?? [])) {
      // An attached monitor can outlive access to its details; the PUT authorizes removal.
      if (resolvedIds === removals && detectorIds.has(detectorId)) {
        removals.add(detectorId);
        continue;
      }
      const detector = await api.getDetector({
        organizationSlug: params.organizationSlug,
        detectorId,
      });
      assertProjectConstraintEvidence({
        resourceLabel: "Alert source",
        scopedProjectSlug: params.scopedProject?.slug,
        hasEvidence:
          detector.projectId !== null &&
          String(detector.projectId) === params.scopedProject?.id,
      });
      resolvedIds.add(String(detector.id));
    }
  }

  if ([...additions].some((id) => removals.has(id))) {
    throw new UserInputError(
      "The same Alert source cannot be added and removed in one update.",
    );
  }

  for (const id of removals) {
    detectorIds.delete(id);
  }
  for (const id of additions) {
    detectorIds.add(id);
  }
  if (params.scopedProject && detectorIds.size === 0) {
    throw new UserInputError(
      "Disconnecting every Alert source requires an organization-wide session.",
    );
  }
  return [...detectorIds];
}
