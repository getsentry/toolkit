# Search Events API Patterns

## Overview

The `search_events` tool provides a unified interface for searching Sentry events across different datasets (`errors`, `logs`, `spans`, and `metrics`). This document covers the API patterns, query structures, and best practices for both individual event queries and aggregate queries.

## API Architecture

### Discover-Style API vs Modern EAP API

Sentry uses two different query-building patterns depending on the dataset, even though they share the same `/events/` endpoint:

1. **Discover-style events queries** (`errors`, `metrics`)
   - Use repeated `field` parameters
   - Use raw aggregate expressions in both `field` and `sort`
   - Generate Discover-style URLs for `errors` and Metrics page URLs for `metrics`

2. **Modern EAP (Event Analytics Platform) queries** (`spans`, `logs`)
   - Use the same `/events/` endpoint with EAP-oriented field conventions
   - Support richer span/log search semantics
   - Generate Explore URLs for traces and logs

### API Endpoint

All queries use the same base endpoint:
```
/api/0/organizations/{organizationSlug}/events/
```

### Dataset Mapping

The tool forwards the dataset name directly to the API:
- User specifies `errors` → API uses `errors`
- User specifies `spans` → API uses `spans`
- User specifies `logs` → API uses `logs`
- User specifies `metrics` → API uses `tracemetrics`

## Query Modes

### 1. Individual Events (Samples)

Returns raw event data with full details. This is the default mode when no aggregate functions are used.

**Key Characteristics:**
- Returns actual event occurrences
- Includes default fields plus any user-requested fields
- Sorted by timestamp (newest first) by default
- Limited to a specific number of results (default: 10, max: 100)

**Example API URL:**
```
https://us.sentry.io/api/0/organizations/sentry/events/?dataset=spans&field=id&field=span.op&field=span.description&field=span.duration&field=transaction&field=timestamp&field=ai.model.id&field=ai.model.provider&field=project&field=trace&per_page=50&query=&sort=-timestamp&statsPeriod=24h
```

**Default Fields by Dataset:**

- **Spans**: `id`, `span.op`, `span.description`, `span.duration`, `transaction`, `timestamp`, `project`, `trace`
- **Errors**: `issue`, `title`, `project`, `timestamp`, `level`, `message`, `error.type`, `culprit`
- **Logs**: `timestamp`, `project`, `message`, `severity`, `trace`
- **Tracemetrics**: `id`, `timestamp`, `project`, `trace`, `metric.name`, `metric.type`, `metric.unit`, `value`

### 2. Aggregate Queries (Statistics)

Returns grouped and aggregated data, similar to SQL GROUP BY queries.

**Key Characteristics:**
- Activated when ANY field contains a function (e.g., `count()`, `avg()`)
- Fields should ONLY include aggregate functions and groupBy fields
- Do NOT include default fields (id, timestamp, etc.)
- Automatically groups by all non-function fields

**Example API URLs:**

Single groupBy field:
```
https://us.sentry.io/api/0/organizations/sentry/events/?dataset=spans&field=ai.model.id&field=count()&per_page=50&query=&sort=-count()&statsPeriod=24h
```

Multiple groupBy fields:
```
https://us.sentry.io/api/0/organizations/sentry/events/?dataset=spans&field=ai.model.id&field=ai.model.provider&field=sum(span.duration)&per_page=50&query=&sort=-sum(span.duration)&statsPeriod=24h
```

## Query Parameters

### Common Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `dataset` | Which dataset to query | `spans`, `errors`, `logs`, `metrics` |
| `field` | Fields to return (repeated for each field) | `field=span.op&field=count()` |
| `query` | Sentry query syntax filter | `has:db.statement AND span.duration:>1000` |
| `sort` | Sort order (prefix with `-` for descending) | `-timestamp`, `-count()` |
| `per_page` | Results per page | `50` |
| `statsPeriod` | Relative time window filter | `1h`, `24h`, `7d`, `14d`, `30d` |
| `start` | Absolute start time (ISO 8601) | `2025-06-19T07:00:00` |
| `end` | Absolute end time (ISO 8601) | `2025-06-20T06:59:59` |
| `project` | Project ID (numeric, not slug) | `4509062593708032` |


### Dataset-Specific Considerations

#### Spans Dataset
- Supports timestamp filters in query (e.g., `timestamp:-1h`)
- Rich performance metrics available
- Common aggregate functions: `count()`, `avg(span.duration)`, `p95(span.duration)`

#### Errors Dataset  
- Supports timestamp filters in query
- Issue grouping available via `issue` field
- Common aggregate functions: `count()`, `count_unique(user.id)`, `last_seen()`

#### Logs Dataset
- Does NOT support timestamp filters in query (use `statsPeriod` instead)
- Severity levels: fatal, error, warning, info, debug, trace
- Common aggregate functions: `count()`, `epm()`
- Regex filters on string and array attributes: `message://timeout after \d+ms//` (RE2, unquoted, max 64 characters); prefer wildcards for plain substrings, prefixes, and suffixes

#### Metrics Dataset
- Represents newer span metrics, including counters, gauges, and distributions
- Uses the same `/events/` endpoint with `dataset=tracemetrics`
- Attribute discovery uses `/trace-items/attributes/?itemType=tracemetrics`
- Aggregate fields must encode the target metric directly: `fn(value,metric.name,metric.type,metric.unit)`
- Sort fields for aggregate results must stay raw, for example `-p95(value,http.request.duration,distribution,millisecond)`

## Query Syntax

### Basic Filters
- Exact match: `field:value`
- Wildcards: `field:*pattern*`
- Comparison: `field:>100`, `field:<500`
- Boolean: `AND`, `OR`, `NOT`
- Phrases: `message:"database connection failed"`
- Attribute existence: `has:field` (recommended for spans)

### Attribute-Based Queries (Recommended for Spans)
Instead of using `span.op` patterns, use `has:` queries for more flexible attribute-based filtering:
- HTTP requests: `has:request.url` instead of `span.op:http*`
- Database queries: `has:db.statement` or `has:db.system` instead of `span.op:db*`
- AI/LLM calls: `has:ai.model.id`
- MCP tool calls: `has:gen_ai.tool.name`

### Aggregate Functions

#### Universal Functions (all datasets)
- `count()` - Count of events
- `count_unique(field)` - Count of unique values
- `epm()` - Events per minute rate

#### Numeric Field Functions (spans, logs)
- `avg(field)` - Average value
- `sum(field)` - Sum of values
- `min(field)` - Minimum value
- `max(field)` - Maximum value
- `p50(field)`, `p75(field)`, `p90(field)`, `p95(field)`, `p99(field)` - Percentiles

#### Tracemetrics Aggregate Functions
- Use the metric-aware form `fn(value,metric.name,metric.type,metric.unit)`
- Counter examples: `sum(value,http.server.request.count,counter,-)`, `per_minute(value,http.server.request.count,counter,-)`
- Gauge examples: `avg(value,cpu.usage,gauge,percent)`, `max(value,cpu.usage,gauge,percent)`
- Distribution examples: `p75(value,http.request.duration,distribution,millisecond)`, `p95(value,http.request.duration,distribution,millisecond)`

#### Errors-Specific Functions
- `count_if(field,equals,value)` - Conditional count
- `last_seen()` - Most recent timestamp
- `eps()` - Events per second rate

## Examples

### Find Database Queries (Individual Events)
```
Query: has:db.statement
Fields: ["id", "span.op", "span.description", "span.duration", "transaction", "timestamp", "project", "trace", "db.system", "db.statement"]
Sort: -span.duration
Dataset: spans
```

### Top 10 Slowest API Endpoints (Aggregate)
```
Query: is_transaction:true
Fields: ["transaction", "count()", "avg(span.duration)", "p95(span.duration)"]
Sort: -avg(span.duration)
Dataset: spans
```

### Error Count by Type (Aggregate)
```
Query: level:error
Fields: ["error.type", "count()"]
Sort: -count()
Dataset: errors
```

### Logs by Severity (Aggregate)
```
Query: (empty)
Fields: ["severity", "count()", "epm()"]
Sort: -count()
Dataset: logs
```

### Request Duration Percentiles by Route (Trace Metrics Aggregate)
```
Query: metric.name:http.request.duration AND metric.type:distribution
Fields: ["transaction", "p75(value,http.request.duration,distribution,millisecond)", "p95(value,http.request.duration,distribution,millisecond)", "count(value,http.request.duration,distribution,millisecond)"]
Sort: -p95(value,http.request.duration,distribution,millisecond)
Dataset: metrics
```

### Tool Calls by Model (Aggregate)
```
Query: has:gen_ai.tool.name
Fields: ["ai.model.id", "gen_ai.tool.name", "count()"]
Sort: -count()
Dataset: spans
```

### HTTP Requests (Individual Events)
```
Query: has:request.url
Fields: ["id", "span.op", "span.description", "span.duration", "transaction", "timestamp", "project", "trace", "request.url", "request.method"]
Sort: -timestamp
Dataset: spans
```

## Common Pitfalls

1. **Mixing aggregate and non-aggregate fields**: Don't include fields like `timestamp` or `id` in aggregate queries
2. **Wrong sort field**: The field you sort by must be included in the fields array
3. **Timestamp filters on logs**: Use `statsPeriod` parameter instead of query filters
4. **Using project slugs**: API requires numeric project IDs, not slugs

## Web UI URL Generation

The tool automatically generates shareable Sentry web UI URLs after making API calls. These URLs allow users to view results in the Sentry interface:

- **Errors dataset**: `/organizations/{org}/discover/results/`
- **Spans dataset**: `/organizations/{org}/explore/traces/`
- **Logs dataset**: `/organizations/{org}/explore/logs/`
- **Tracemetrics dataset**: `/organizations/{org}/explore/metrics/`

Note: The web UI URLs use different parameter formats than the API:
- Legacy Discover uses simple field parameters
- Modern Explore uses dataset-specific parameter formats
- The Metrics page uses one or more JSON-encoded `metric=` parameters
- The tool handles this transformation automatically in `buildDiscoverUrl()` and `buildEapUrl()`

### Web URL Generation Parameters

The `getEventsExplorerUrl()` method accepts these parameters to determine URL format:

1. **organizationSlug**: Organization identifier
2. **query**: The Sentry query string
3. **projectSlug**: Numeric project ID (optional)
4. **dataset**: "spans", "errors", or "logs"
5. **fields**: Array of fields (used to detect if it's an aggregate query)
6. **sort**: Sort parameter
7. **aggregateFunctions**: Array of aggregate functions (e.g., `["count()", "avg(span.duration)"]`)
8. **groupByFields**: Array of fields to group by (e.g., `["span.op", "ai.model.id"]`)

Based on these parameters:
- If `aggregateFunctions` has items → generates aggregate query URL
- For errors dataset → routes to Legacy Discover URL format
- For spans/logs datasets → routes to Modern Explore URL format with JSON-encoded `aggregateField` parameters

## API vs Web UI URLs

### Important Distinction

The API and Web UI use different parameter formats:

**API (Backend)**: Always uses the same format regardless of dataset
- Endpoint: `/api/0/organizations/{org}/events/`
- Parameters: `field`, `query`, `sort`, `dataset`, etc.
- Example: `?dataset=spans&field=span.op&field=count()&sort=-count()`

**Web UI (Frontend)**: Different formats for different pages
- Legacy Discover: `/organizations/{org}/discover/results/`
- Modern Explore: `/organizations/{org}/explore/{dataset}/`
- Uses different parameter encoding (e.g., `aggregateField` with JSON for explore pages)

### API Parameter Format

The API **always** uses this format for all datasets:

**Individual Events:**
```
?dataset=spans
&field=id
&field=span.op
&field=span.description
&query=span.op:db
&sort=-timestamp
&statsPeriod=24h
```

**Aggregate Queries:**
```
?dataset=spans
&field=span.op
&field=count()
&query=span.op:db*
&sort=-count()
&statsPeriod=24h
```

The only difference between datasets is the `dataset` parameter value and available fields.

## Time Range Filtering

All API endpoints support time range filtering using either relative or absolute time parameters:

**Relative Time** (`statsPeriod`):
- Format: number + unit (e.g., `1h`, `24h`, `7d`, `30d`)
- Default: `14d` (last 14 days)
- Example: `?statsPeriod=7d`

**Absolute Time** (`start` and `end`):
- Format: ISO 8601 timestamps
- Both parameters must be provided together
- Example: `?start=2025-06-19T07:00:00&end=2025-06-20T06:59:59`

**Important**: Cannot use both `statsPeriod` and `start`/`end` parameters in the same request.

**Applies to**:
- Events API: `/organizations/{org}/events/`
- Tags API: `/organizations/{org}/tags/`
- Trace Items Attributes API: `/organizations/{org}/trace-items/attributes/`

## Attribute Lookup Endpoints

### Overview

Before translating queries, the tool fetches available attributes/fields for the organization. This ensures the AI knows about custom attributes specific to the organization.

### Tags Endpoint (Errors Dataset)

**Endpoint**: `/api/0/organizations/{org}/tags/`

**Parameters**:
- `dataset`: Always `events` for error data
- `project`: Numeric project ID (optional)
- `statsPeriod`: Time range (e.g., `24h`)
- `useCache`: Set to `1` for performance
- `useFlagsBackend`: Set to `1` for latest features

**Example**:
```
https://us.sentry.io/api/0/organizations/sentry/tags/?dataset=events&project=4509062593708032&statsPeriod=24h&useCache=1&useFlagsBackend=1
```

**Response Format**:
```json
[
  {
    "key": "browser.name",
    "name": "Browser Name"
  },
  {
    "key": "custom.payment_method",
    "name": "Payment Method"
  }
]
```

**Processing**:
- Filters out `sentry:` prefixed tags (internal tags)
- Maps to key-value pairs for the AI prompt

### Trace Items Attributes Endpoint (Spans/Logs Datasets)

**Endpoint**: `/api/0/organizations/{org}/trace-items/attributes/`

**Parameters**:
- `itemType`: Either `spans` or `logs` (plural!)
- `attributeType`: Optional filter for `string`, `number`, or `boolean`. Omit to return all types.
- `project`: Numeric project ID (optional)
- `statsPeriod`: Time range

**Examples**:

Spans string attributes:
```
https://us.sentry.io/api/0/organizations/sentry/trace-items/attributes/?attributeType=string&itemType=spans&project=4509062593708032&statsPeriod=24h
```

Spans number attributes:
```
https://us.sentry.io/api/0/organizations/sentry/trace-items/attributes/?attributeType=number&itemType=spans&project=4509062593708032&statsPeriod=24h
```

Logs string attributes:
```
https://us.sentry.io/api/0/organizations/sentry/trace-items/attributes/?attributeType=string&itemType=logs&project=4509062593708032&statsPeriod=24h
```

**Response Format**:
```json
[
  {
    "key": "span.duration",
    "name": "Span Duration",
    "type": "number"
  },
  {
    "key": "ai.model.id",
    "name": "AI Model ID",
    "type": "string"
  }
]
```

### Implementation Strategy

The tool fetches attributes with a single request per dataset:

1. **For errors**: Single request to tags endpoint with optimized parameters
2. **For spans/logs/metrics**: Single request to trace-items attributes without `attributeType` (Sentry returns all types)

```typescript
// For errors dataset
const tagsResponse = await apiService.listTags({
  organizationSlug,
  dataset: "events",
  statsPeriod: "14d",
  useCache: true,
  useFlagsBackend: true
});

// For spans/logs datasets
const attributesResponse = await apiService.listTraceItemAttributes({
  organizationSlug,
  itemType: "spans", // or "logs"
  statsPeriod: "14d"
});
```

When callers pass `attributeTypes`, `listTraceItemAttributes` filters the combined response client-side.

### Custom Attributes Integration

After fetching, custom attributes are merged with base fields:

```typescript
const allFields = {
  ...BASE_COMMON_FIELDS,      // Common fields across datasets
  ...DATASET_FIELDS[dataset], // Dataset-specific fields
  ...customAttributes         // Organization-specific fields
};
```

This ensures the AI knows about all available fields when translating queries.

### Error Handling

If attribute fetching fails:
- The tool continues with just the base fields
- Logs the error for debugging
- Does not fail the entire query

This graceful degradation ensures queries still work even if custom attributes can't be fetched.

## Best Practices

1. **Be specific with fields**: Only request fields you need
2. **Use appropriate limits**: Default 10, max 100 per page
3. **Leverage aggregate functions**: For summaries and statistics
4. **Include context fields**: Add fields like `project`, `environment` when grouping
5. **Sort meaningfully**: Use `-count()` for popularity, `-timestamp` for recency
6. **Handle custom attributes**: Tool automatically fetches org-specific attributes
7. **Understand dataset differences**: Each dataset has different capabilities and constraints

## Implementation Details

### Code Architecture

The search_events tool handles the complexity of multiple API patterns:

1. **AI Translation Layer**
   - Uses OpenAI GPT-5 to translate natural language to Sentry query syntax
   - Maintains dataset-specific system prompts with examples
   - Aggregate functions and groupBy fields are derived from the fields array

2. **Field Handling**
   - Aggregate queries: Only includes aggregate functions and groupBy fields
   - Non-aggregate queries: Uses default fields or AI-specified fields
   - Validates that sort fields are included in the field list
   - Detects aggregate queries by checking for function syntax in fields

3. **Field Type Validation**
   - Validates numeric aggregate functions (avg, sum, min, max, percentiles) are only used with numeric fields
   - Tracks field types from both known fields and custom attributes
   - Returns error messages when invalid combinations are attempted

4. **Web UI URL Generation** (for shareable links)
   - `buildDiscoverUrl()` for errors dataset → creates Discover page URLs
   - `buildEapUrl()` for spans/logs datasets → creates Explore page URLs
   - Transforms API response format to web UI parameter format
   - Note: These methods generate web URLs, not API URLs

### Response Format Differences

**Legacy Discover Response (errors):**
```json
{
  "data": [
    {
      "error.type": "TypeError",
      "count()": 150,
      "last_seen()": "2025-01-16T12:00:00Z"
    }
  ]
}
```

**EAP Response (spans/logs):**
```json
{
  "data": [
    {
      "span.op": "db.query",
      "count()": 1250,
      "avg(span.duration)": 45.3
    }
  ]
}
```

## Troubleshooting

### "Ordered by columns not selected" Error
This occurs when sorting by a field not included in the field list. Ensure your sort field is in the fields array.

### Empty Results
- Check query syntax is valid
- Verify time range (`statsPeriod`)
- Ensure project has data for the selected dataset
- Try broadening the query

### API Errors
- 400: Invalid query syntax or parameters (often due to field mismatch in aggregates)
- 404: Project or organization not found
- 500: Internal error (check Sentry status)
