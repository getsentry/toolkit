/**
 * Metric alert API responses may omit the status for active rules.
 * Only the explicit disabled value should render as disabled.
 */
export function metricAlertStatusLabel(status: unknown): "active" | "disabled" {
  return status === 1 || status === "1" ? "disabled" : "active";
}
