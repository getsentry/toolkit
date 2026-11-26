import { ApiPermissionError } from "../../api-client";

// Sentry's object-level checks for Alert (workflow) and Metric Monitor
// (detector) writes raise a bare 403 with DRF's generic detail for ordinary
// tokens; only Seer agent tokens get an insufficient_scope challenge. See
// enforce_workflow_edit_permissions, enforce_detector_workflow_connection_permissions,
// and can_edit_detector in sentry/workflow_engine/endpoints/validators/utils.py.
const HINTS = {
  Alert:
    "Changing an Alert needs the alerts:write scope and permission to edit alerts in every project it connects to. An Alert that uses the all-projects source also needs org:write.",
  "Metric Monitor":
    "Changing a Metric Monitor needs the alerts:write scope and permission to edit alerts in its project.",
} as const;

/**
 * Run an Alert or Metric Monitor write and explain a permission denial.
 *
 * Keeps the original `ApiPermissionError`, so it stays an expected 4xx and
 * keeps its status. A 403 that names the missing scopes is left alone:
 * `formatErrorForUser` already reports it as a missing permission.
 */
export async function withAlertWritePermissionHint<T>(
  resource: keyof typeof HINTS,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (
      error instanceof ApiPermissionError &&
      !error.isInsufficientScopeError()
    ) {
      error.message += `\n${HINTS[resource]} Retrying with the same token will not help: reconnect Sentry with these scopes, or ask an organization Owner or Manager to make the change.`;
    }
    throw error;
  }
}
