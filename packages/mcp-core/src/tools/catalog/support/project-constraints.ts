import { UserInputError } from "../../../errors";

type ProjectRef = {
  slug?: string | null | undefined;
};

function projectConstraintError(resourceLabel: string, projectSlug: string) {
  return new UserInputError(
    `${resourceLabel} is outside the active project constraint. Expected project "${projectSlug}".`,
  );
}

function projectSlug(project: ProjectRef | null | undefined): string | null {
  return project?.slug ?? null;
}

export function assertProjectRefWithinConstraint({
  resourceLabel,
  scopedProjectSlug,
  project,
}: {
  resourceLabel: string;
  scopedProjectSlug?: string | null | undefined;
  project?: ProjectRef | null | undefined;
}): void {
  if (!scopedProjectSlug) {
    return;
  }

  if (projectSlug(project) !== scopedProjectSlug) {
    throw projectConstraintError(resourceLabel, scopedProjectSlug);
  }
}

export function assertProjectListContainsConstraint({
  resourceLabel,
  scopedProjectSlug,
  projects,
}: {
  resourceLabel: string;
  scopedProjectSlug?: string | null | undefined;
  projects?: ProjectRef[] | null | undefined;
}): void {
  if (!scopedProjectSlug) {
    return;
  }

  const hasMatchingProject =
    projects?.some((project) => projectSlug(project) === scopedProjectSlug) ??
    false;

  if (!hasMatchingProject) {
    throw projectConstraintError(resourceLabel, scopedProjectSlug);
  }
}

export function assertProjectConstraintEvidence({
  resourceLabel,
  scopedProjectSlug,
  hasEvidence,
}: {
  resourceLabel: string;
  scopedProjectSlug?: string | null | undefined;
  hasEvidence: boolean;
}): void {
  if (!scopedProjectSlug || hasEvidence) {
    return;
  }

  throw projectConstraintError(resourceLabel, scopedProjectSlug);
}
