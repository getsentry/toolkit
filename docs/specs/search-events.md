# Dataset Search Tools Specification

## Overview

Natural-language event search is exposed as one tool per dataset:

| Tool | Dataset | Seer strategy |
| --- | --- | --- |
| `search_errors` | `errors` | `Errors` |
| `search_logs` | `logs` | `Logs` |
| `search_traces` | `spans` | `Traces` |
| `search_metrics` | `metrics` | `Metrics` |
| `search_profiles` | `profiles` | — |
| `search_replays` | `replays` | — |

All six share one handler (`tools/support/search-events/search.ts`). Each tool
fixes its dataset, so the caller never chooses a `dataset` parameter and the
embedded agent is told it cannot switch datasets (`lockDataset`). This removes
the most common routing mistake from the old multi-dataset `search_events` tool,
where clients omitted `dataset`, silently got `errors`, and skipped Seer.

`search_events` stays in the catalog as a deprecated alias for backward
compatibility (reachable via `execute_sentry_tool`). It is no longer on the
direct MCP surface and is excluded from skill definitions.

## Motivation

- **Before**: One `search_events` tool with an optional `dataset` enum; agents
  often omitted or mis-picked it.
- **After**: Tool selection picks the dataset. Each description only documents
  its own dataset, so descriptions are shorter and more specific.
- **Cross-event**: same-trace co-occurrence questions ("slow checkout requests
  that also logged an error") route to `search_traces`, the only Seer strategy
  that supports cross-event filters.

## Interface

```typescript
// search_errors / search_logs / search_traces / search_metrics / search_profiles
interface DatasetSearchParams {
  organizationSlug: string;
  query?: string;                // Natural language (preferred) or Sentry search syntax
  projectSlug?: string;
  fields?: string[];
  sort?: string;
  period?: string;               // e.g. "24h", "7d"
  limit?: number;                // Default: 10, Max: 100
  includeExplanation?: boolean;
  regionUrl?: string;
}

// search_replays drops `fields` and adds a separate `environment` parameter.
```

### Examples

```typescript
search_errors({
  organizationSlug: "my-org",
  query: "database timeouts in checkout flow from last hour"
})

search_traces({
  organizationSlug: "my-org",
  query: "API calls taking over 5 seconds",
  projectSlug: "backend"
})

search_logs({
  organizationSlug: "my-org",
  query: "warning logs about memory usage"
})

search_metrics({
  organizationSlug: "my-org",
  query: "p95 request duration by transaction this week"
})
```

## Architecture

1. **Tool receives** natural language query and dataset selection
2. **Fetches searchable attributes** based on dataset:
   - For `spans`/`logs`/`metrics`: Uses `/organizations/{org}/trace-items/attributes/` endpoint with parallel calls for string and number attribute types
   - For `errors`: Uses `/organizations/{org}/tags/` endpoint (legacy, will migrate when new API supports errors)
3. **Configured LLM provider translates** natural language to Sentry query syntax using:
   - Comprehensive system prompt with Sentry query syntax rules
   - Dataset-specific field mappings and query patterns
   - Organization's custom attributes (fetched in step 2)
4. **Executes** discover endpoint: `/organizations/{org}/events/` with:
   - Translated query string
   - Dataset-specific field selection
   - Default error field selection includes `user.email` and `user.id`
   - Numeric project ID (converted from slug if provided)
   - Public dataset normalization (`metrics` maps to the current API dataset `tracemetrics`)
5. **Returns** formatted results with:
   - Dataset-specific rendering (console format for logs, cards for errors, timeline for spans, and table/sample formatting for metrics)
   - Prominent rendering directives for AI agents
   - Shareable Sentry Explorer URL

## Key Implementation Details

### Embedded Agent Provider

- **Default model**: GPT-5 for natural language to Sentry query translation
- **System prompt**: Contains comprehensive Sentry query syntax, dataset-specific rules, and available fields
- **Environment**: Requires a configured embedded agent provider, such as `OPENAI_API_KEY` or `OPENROUTER_API_KEY`
- **Custom attributes**: Automatically fetched and included in system prompt for each organization

### Dataset-Specific Translation

The AI produces different query patterns based on the selected dataset:

- **Spans dataset**: Focus on `span.op`, `span.description`, `span.duration`, `transaction`, supports timestamp filters
- **Errors dataset**: Focus on `message`, `level`, `error.type`, `error.handled`, supports timestamp filters  
- **Logs dataset**: Focus on `message`, `severity`, `severity_number`, **NO timestamp filters** (uses statsPeriod instead)
- **Tracemetrics dataset**: Focus on `metric.name`, `metric.type`, `metric.unit`, `value`, and metric-aware aggregates like `p95(value,http.request.duration,distribution,millisecond)`

### Environment Filters

The embedded agent receives known visible environment names as context. It must
only add an environment filter when requested; a single available environment or
grouping by environment does not imply a filter. These instructions also apply
when discovery fails or the list is too large to include in the prompt.

For non-replay datasets, environment filters belong in `query`; the agent leaves
its separate `environment` output null. The internal `validateSearch` tool accepts
the candidate query without a separate environment argument. Replays retain the
separate environment parameter and do not use this validation tool.

The discovered list is not an exhaustive allowlist: hidden environments can be
absent. Existing final validation and unknown-environment notices remain in place.

### Time Series

Requests for a metric over time ("per hour", "per day", "trend", "over time") return a bucketed series via the `events-stats` endpoint instead of failing.

- The embedded agent sets `timeSeries: { yAxis, interval }` on its output. `yAxis` is the aggregate to plot (e.g. `count()`); the query, environment, and time range are reused from the normal translation.
- **Interval is agent-decided, never a required input.** It is set only when the user names a granularity ("per hour" → `1h`); otherwise it is left `null` so Sentry picks a sensible bucket for the range (mirrors `get_interval_from_range`). Sentry rejects an interval that would produce too many buckets.
- The handler routes `timeSeries` to `SentryApiService.getEventsTimeSeries` and renders the buckets (with total and peak) via `formatTimeSeriesResults`.

### Key Technical Constraints

- **Logs timestamp handling**: Logs don't support query-based timestamp filters like `timestamp:-1h`. Instead, use `statsPeriod=24h` parameter
- **Project ID mapping**: API requires numeric project IDs, not slugs. Tool automatically converts project slugs to IDs
- **Seer opt-in**: Seer translation runs only in experimental sessions (`--experimental` for stdio or `/mcp?experimental=1` for HTTP), when the organization has the required Seer features. Default sessions use the configured embedded agent for natural-language translation; if Seer is unavailable in an experimental session, the tool falls back to that agent.
- **Seer cross-event filters**: Time series results do not apply cross-event filters. When Seer returns those filters for a time series, the response always begins with a warning identifying the omitted filters and the broader results, even when `includeExplanation` is false.
- **Seer project scope**: For a successful Seer translation without `projectSlug`, search and Explorer links use `project=-1` to match the all-accessible-project scope sent to Seer. Other unscoped searches retain their existing default scope.
- **Parallel attribute fetching**: For spans/logs/metrics, fetches both string and number attribute types in parallel for better performance
- **itemType specification**: Must use `logs` and `tracemetrics` exactly for the trace-items attributes API
- **Tracemetrics sort handling**: Aggregate sort expressions like `-p95(value,...)` must be sent to the API unchanged
- **Tracemetrics URL generation**: Explorer links must point at `/explore/metrics/` with JSON-encoded `metric=` parameters, not the traces or logs Explore pages

### Tool Removal

- **Must remove** `find_errors` and `find_transactions` in same PR ✓
  - Removed from tool exports
  - Files still exist but are no longer used
- **Migration required** for existing usage
  - Updated `find_errors_in_file` prompt to use `search_events`
- **Documentation** updates needed

## Migration Examples

```typescript
// Before
find_errors({
  organizationSlug: "sentry",
  filename: "checkout.js",
  query: "is:unresolved"
})

// After
search_errors({
  organizationSlug: "sentry",
  query: "unresolved errors in checkout.js"
})
```

## Implementation Status

### Completed Features

1. **Custom attributes API integration**: 
   - ✅ `/organizations/{org}/trace-items/attributes/` for spans/logs/metrics with parallel string/number fetching
   - ✅ `/organizations/{org}/tags/` for errors (legacy API)

2. **Dataset mapping**:
   - ✅ User specifies `errors` → API uses `errors`
   - ✅ User specifies `spans` → API uses `spans`
   - ✅ User specifies `logs` → API uses `logs`
   - ✅ User specifies `metrics` → API uses `tracemetrics`

3. **URL Generation**:
   - ✅ Uses appropriate explore path based on dataset (`/discover/results/`, `/explore/traces/`, `/explore/logs/`, `/explore/metrics/`)
   - ✅ Query and project parameters properly encoded with numeric project IDs

4. **Error Handling**:
   - ✅ Enhanced error messages with Sentry event IDs for debugging
   - ✅ Graceful handling of missing projects, API failures
   - ✅ Clear error messages for missing embedded agent provider key

5. **Output Formatting**:
   - ✅ Dataset-specific rendering instructions for AI agents
   - ✅ Console format for logs with severity emojis
   - ✅ Alert cards for errors with color-coded levels
   - ✅ Performance timeline for spans with duration bars
   - ✅ Aggregate-table and sample formatting for metrics

## Success Criteria - All Complete ✅

- ✅ **Accurate translation of common query patterns** - GPT-5 with comprehensive system prompts
- ✅ **Proper handling of org-specific custom attributes** - Parallel fetching and integration
- ✅ **Seamless migration from old tools** - find_errors, find_transactions removed from exports
- ✅ **Maintains performance** - Parallel API calls, efficient caching, translation overhead minimal
- ✅ **Supports multiple datasets** - spans, errors, logs, and metrics with dataset-specific handling
- ✅ **Generates shareable Sentry Explorer URLs** - Proper encoding with numeric project IDs
- ✅ **Clear output indicating URL should be shared** - Prominent sharing instructions
- ✅ **Comprehensive test coverage** - Unit tests, integration tests, and AI evaluations
- ✅ **Production ready** - Error handling, logging, graceful degradation

## Dependencies

- **Runtime**: Embedded agent provider key required, such as `OPENAI_API_KEY` or `OPENROUTER_API_KEY`
- **Build**: @ai-sdk/openai, ai packages added to dependencies
- **Testing**: Comprehensive mocks for LLM provider and Sentry APIs
