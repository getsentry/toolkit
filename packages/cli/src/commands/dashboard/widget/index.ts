import { buildRouteMap } from "../../../lib/route-map.js";
import { addCommand } from "./add.js";
import { deleteCommand } from "./delete.js";
import { editCommand } from "./edit.js";

export const widgetRoute = buildRouteMap({
  routes: {
    add: addCommand,
    edit: editCommand,
    delete: deleteCommand,
  },
  docs: {
    brief: "Manage dashboard widgets",
    fullDescription:
      "Add, edit, or delete widgets in a Sentry dashboard.\n\n" +
      "Dashboards use a 6-column grid. Widget widths should sum to 6 per row.\n\n" +
      "Display types (width × height):\n" +
      "  common:      big_number (2×1), line (3×2), area (3×2), bar (3×2), table (6×2)\n" +
      "  specialized: stacked_area (3×2), top_n (3×2), categorical_bar (3×2), text (3×2)\n" +
      "  internal:    details (3×2), wheel (3×2), rage_and_dead_clicks (3×2),\n" +
      "               server_tree (3×2), agents_traces_table (3×2)\n\n" +
      "Datasets (canonical name — accepted aliases):\n" +
      "  spans (default)               Span-based queries: span.duration, span.op,\n" +
      "                                transaction, span attributes, cache.hit, etc.\n" +
      "                                Covers most use cases.\n" +
      "  tracemetrics — metrics,       Custom metrics from Sentry.metrics.distribution/\n" +
      "    metricsEnhanced             gauge/count. Query format:\n" +
      "                                aggregation(value,metric_name,metric_type,unit)\n" +
      "                                Example: p50(value,completion.duration_ms,distribution,none)\n" +
      "                                Supported displays: line, area, bar, big_number,\n" +
      "                                categorical_bar\n" +
      "  issue                         Issue-based queries\n" +
      "  error-events — errors, error  Error event queries\n" +
      "  logs — log                    Log queries\n\n" +
      "Dataset values are case-insensitive; the Sentry UI/API name 'errors'\n" +
      "is accepted in addition to the canonical form.\n\n" +
      "Aggregates (spans): count, count_unique, sum, avg, percentile, p50, p75,\n" +
      "  p90, p95, p99, p100, eps, epm, any, min, max\n" +
      "Aggregates (error-events adds): count_if, count_at_least, last_seen,\n" +
      "  latest_event, var, stddev, cov, corr\n" +
      "Aliases: spm → epm, sps → eps, tpm → epm, tps → eps\n\n" +
      "tracemetrics query format:\n" +
      "  aggregation(value,metric_name,metric_type,unit)\n" +
      "    - metric_name: name passed to Sentry.metrics.distribution/gauge/count\n" +
      "    - metric_type: distribution, gauge, counter, set\n" +
      "    - unit: none (if unspecified), byte, second, millisecond, ratio, etc.\n\n" +
      "Row-filling examples:\n" +
      "  # 3 KPIs (2+2+2 = 6)\n" +
      '  sentry dashboard widget add <d> "Error Count" --display big_number --query count\n' +
      '  sentry dashboard widget add <d> "P95" --display big_number --query p95:span.duration\n' +
      '  sentry dashboard widget add <d> "Throughput" --display big_number --query epm\n\n' +
      "  # 2 charts (3+3 = 6)\n" +
      '  sentry dashboard widget add <d> "Errors" --display line --query count\n' +
      '  sentry dashboard widget add <d> "Latency" --display line --query p95:span.duration\n\n' +
      "  # Full-width table (6 = 6)\n" +
      '  sentry dashboard widget add <d> "Top Endpoints" --display table \\\n' +
      "    --query count --query p95:span.duration --group-by transaction \\\n" +
      "    --sort -count --limit 10\n\n" +
      "  # Custom metrics (tracemetrics dataset)\n" +
      '  sentry dashboard widget add <d> "Latency" --display line \\\n' +
      "    --dataset tracemetrics \\\n" +
      '    --query "p50(value,completion.duration_ms,distribution,none)" \\\n' +
      '    --query "p90(value,completion.duration_ms,distribution,none)"\n\n' +
      "Commands:\n" +
      "  add    Add a widget to a dashboard\n" +
      "  edit   Edit a widget in a dashboard\n" +
      "  delete Delete a widget from a dashboard",
    hideRoute: {},
  },
});
