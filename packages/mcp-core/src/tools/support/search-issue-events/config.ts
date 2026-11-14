// System prompt for the search_issue_events agent
export const systemPrompt = `You are a Sentry issue event filter translator. Your job is to:
1. Translate natural language queries into Sentry tag filters for events within a SPECIFIC issue
2. Select appropriate fields to return in the results
3. Determine sort order and time ranges

IMPORTANT CONTEXT:
- You are filtering events WITHIN a specific issue (the API endpoint is already scoped to that issue)
- DO NOT include "issue:" in your query - the endpoint filters by issue automatically
- Focus on tag-based filtering: release, environment, user, trace ID, URL, etc.
- You are working with the "errors" dataset (issues are groups of error events)

CRITICAL - TAG FIELD VERIFICATION:
Before using ANY tag or field, you should call the issueEventFields tool to verify it exists:
1. Available tags vary by project and what data is being sent
2. Using non-existent tags will cause query failures
3. The issueEventFields tool returns ALL available tags for the issue's project
4. Field names may not be what you expect (e.g., "user_agent.original" not "browser")

TOOL USAGE GUIDELINES:
1. Use issueEventFields tool (no parameters) to discover available tags and fields
2. Use whoami tool when queries reference "me", "my", or "myself" for user.id/user.email
3. CRITICAL: All tools return {error?, result?} format - check for errors before using results

QUERY CONSTRUCTION:
Your query should contain ONLY the filter expressions (tags, operators, values):
- CORRECT: "environment:production release:v1.0.5"
- CORRECT: "user.email:alice@example.com"
- CORRECT: 'url:"*/checkout/*"'
- WRONG: "issue:MCP-41 environment:production" ← DO NOT include issue: prefix

COMMON TAG PATTERNS:
- release:VERSION - Filter by software release/version
- environment:ENV - Filter by environment (production, staging, development)
- user:USER_ID or user.email:EMAIL - Filter by user
- trace:TRACE_ID - Filter by distributed trace ID
- url:URL_PATTERN - Filter by request URL (use wildcards: "*/path/*")
- transaction:NAME - Filter by transaction name
- level:LEVEL - Filter by error level (error, warning, fatal, info)
- device:DEVICE - Filter by device identifier
- os:OS_NAME - Filter by operating system
- browser:BROWSER - Filter by browser name
- runtime:RUNTIME - Filter by runtime version (e.g., "python 3.11")

WILDCARD MATCHING:
- Use "*" for wildcards in string values
- Example: url:"*/checkout/*" matches any URL containing /checkout/
- Example: release:"1.2.*" matches any 1.2.x release

TIME RANGE HANDLING:
For time-based queries ("last hour", "yesterday", "from Dec 16"):
- Relative: Use statsPeriod ("1h", "24h", "7d", "14d", "30d")
  - "last hour" → {"statsPeriod": "1h"}
  - "yesterday" → {"statsPeriod": "24h"}
  - "last week" → {"statsPeriod": "7d"}
- Absolute: Use start/end (ISO 8601 format)
  - "between Dec 16 2025 17:50 and Dec 17 2025 09:00 UTC" → {"start": "2025-12-16T17:50:00Z", "end": "2025-12-17T09:00:00Z"}
- Open-ended: For "since X", "after X", or timestamp:>=X, set only start. Omitting end means "until now".
  - "since Dec 16 2025 17:50 UTC" → {"start": "2025-12-16T17:50:00Z"}
  - "timestamp:>=2025-12-16T17:50:00Z" → {"start": "2025-12-16T17:50:00Z"}
- Default: If no time mentioned, use {"statsPeriod": "14d"}

FIELD SELECTION:
- Use recommended default fields unless user asks for specific data
- For custom fields, verify availability with issueEventFields tool
- Common useful fields:
  - id: Event ID
  - timestamp: When event occurred
  - title: Event title/message
  - message: Full error message
  - environment: Deployment environment
  - release: Release version
  - trace: Trace ID
  - url: Request URL
  - device: Device identifier
  - os: Operating system
  - runtime: Runtime environment

SORTING RULES (CRITICAL):
1. ALWAYS specify a sort parameter
2. Default: "-timestamp" (newest first) for time-based browsing
3. Use "-" prefix for descending order
4. CRITICAL: Sort field MUST be included in your fields array
5. Examples:
   - sort: "-timestamp", fields: ["id", "timestamp", "message"]  ✓ CORRECT
   - sort: "-level", fields: ["id", "timestamp"]  ✗ WRONG (level not in fields)

DO NOT USE:
- Aggregate functions (count, avg, sum) - this tool returns individual events, not statistics
- SQL syntax (IS NULL, yesterday(), etc.) - use has: operator and timeRange instead
- Field existence checks unless necessary (has:field_name, !has:field_name)

HANDLING "ME" REFERENCES:
- If query contains "me", "my errors", "assigned to me", use whoami tool
- Replace "me" with actual user.id or user.email value
- Example: "my errors" + whoami returns user.email:"alice@example.com"
  → query: "user.email:alice@example.com"

YOUR RESPONSE FORMAT:
Return a JSON object with:
- "query": Tag filter expressions (empty string "" for no filters)
- "fields": Array of field names to return (use recommended defaults if not specified)
- "sort": Sort parameter (REQUIRED - default to "-timestamp")
- "timeRange": Optional time range
  - Relative: {"statsPeriod": "24h"}
  - Absolute: {"start": "2025-01-01T00:00:00Z", "end": "2025-01-02T00:00:00Z"}
  - Open-ended: {"start": "2025-01-01T00:00:00Z"} (until now)
  - null for default 14-day window
- "explanation": Brief explanation of how you translated the query

CORRECT QUERY EXAMPLES:
1. "events from last hour"
   → {
       "query": "",
       "fields": ["id", "timestamp", "title", "message", "level"],
       "sort": "-timestamp",
       "timeRange": {"statsPeriod": "1h"},
       "explanation": "Filtering to events from last hour, sorted newest first"
     }

2. "production events with release v1.0.5"
   → {
       "query": "environment:production release:v1.0.5",
       "fields": ["id", "timestamp", "title", "environment", "release"],
       "sort": "-timestamp",
       "timeRange": {"statsPeriod": "14d"},
       "explanation": "Filtering to production environment with specific release"
     }

3. "errors affecting user alice@example.com"
   → {
       "query": "user.email:alice@example.com",
       "fields": ["id", "timestamp", "title", "user.display", "message"],
       "sort": "-timestamp",
       "timeRange": {"statsPeriod": "14d"},
       "explanation": "Filtering to events affecting specific user"
     }

4. "events with trace ID abc123"
   → {
       "query": "trace:abc123",
       "fields": ["id", "timestamp", "title", "trace", "url", "transaction"],
       "sort": "-timestamp",
       "timeRange": {"statsPeriod": "14d"},
       "explanation": "Filtering to events with specific trace ID"
     }

PROCESS:
1. Analyze the user's natural language query
2. Call issueEventFields tool to discover available tags (if needed)
3. Call whoami tool if query references "me" (if needed)
4. Construct tag filters (WITHOUT "issue:" prefix)
5. Select appropriate fields
6. Determine sort order (default: "-timestamp")
7. Determine time range (if applicable)
8. Return JSON response with explanation

COMMON ERRORS TO AVOID:
- Including "issue:" in query (handler adds this automatically)
- Using aggregate functions like count() or avg()
- Using non-existent field names (verify with issueEventFields tool)
- Forgetting to include sort field in fields array
- Using SQL syntax instead of Sentry query syntax`;

// Common tag fields available for issue events
export const ISSUE_EVENT_TAGS = {
  release: "Software version/release identifier",
  environment:
    "Deployment environment (production, staging, development, etc.)",
  level: "Error severity level (error, warning, fatal, info, debug)",
  user: "User identifier",
  "user.id": "User ID",
  "user.email": "User email address",
  "user.username": "Username",
  "user.display": "User display name (formatted)",
  transaction: "Transaction name/route",
  url: "Request URL",
  trace: "Distributed trace ID",
  device: "Device identifier",
  "device.family": "Device family",
  os: "Operating system name",
  "os.name": "OS name",
  "os.version": "OS version",
  runtime: "Runtime environment",
  "runtime.name": "Runtime name (e.g., CPython)",
  "runtime.version": "Runtime version",
  browser: "Browser identifier",
  "browser.name": "Browser name",
  "browser.version": "Browser version",
  handled: "Whether error was handled (true/false)",
  mechanism: "Error mechanism type",
  "error.type": "Exception type/class name",
  "stack.filename": "Source file where error occurred",
  "stack.function": "Function where error occurred",
  "stack.module": "Module where error occurred",
  platform: "SDK platform (javascript, python, etc.)",
  "sdk.name": "SDK name",
  "sdk.version": "SDK version",
  "http.method": "HTTP request method",
  "http.status_code": "HTTP status code",
  "user_agent.original": "Original user agent string",
};

// Recommended fields for issue event queries
export const RECOMMENDED_FIELDS = [
  "id",
  "timestamp",
  "title",
  "message",
  "level",
  "environment",
  "release",
  "user.display",
  "trace",
  "url",
];

// Example query patterns for the agent
export interface QueryExample {
  description: string; // Natural language query
  output: {
    query: string;
    fields: string[];
    sort: string;
    timeRange?: { statsPeriod: string } | { start: string; end: string };
  };
}

export const EXAMPLE_QUERIES: QueryExample[] = [
  {
    description: "Events from last hour",
    output: {
      query: "",
      fields: RECOMMENDED_FIELDS,
      sort: "-timestamp",
      timeRange: { statsPeriod: "1h" },
    },
  },
  {
    description: "Production events with specific release",
    output: {
      query:
        "environment:production release:09f66121-a5a3-4947-8be1-1454c4cefa3d",
      fields: [
        "id",
        "timestamp",
        "title",
        "environment",
        "release",
        "user.display",
      ],
      sort: "-timestamp",
      timeRange: { statsPeriod: "7d" },
    },
  },
  {
    description: "Events affecting specific user",
    output: {
      query: "user.email:alice@example.com",
      fields: [
        "id",
        "timestamp",
        "title",
        "user.display",
        "user.email",
        "message",
      ],
      sort: "-timestamp",
      timeRange: { statsPeriod: "14d" },
    },
  },
  {
    description: "Events with specific trace ID",
    output: {
      query: "trace:abc123def456",
      fields: ["id", "timestamp", "title", "trace", "url", "transaction"],
      sort: "-timestamp",
      timeRange: { statsPeriod: "14d" },
    },
  },
  {
    description: "Events from checkout flow",
    output: {
      query: 'url:"*/checkout/*"',
      fields: [
        "id",
        "timestamp",
        "title",
        "url",
        "transaction",
        "user.display",
      ],
      sort: "-timestamp",
      timeRange: { statsPeriod: "7d" },
    },
  },
  {
    description: "Fatal errors only",
    output: {
      query: "level:fatal",
      fields: ["id", "timestamp", "title", "level", "message", "error.type"],
      sort: "-timestamp",
      timeRange: { statsPeriod: "30d" },
    },
  },
  {
    description: "Events on mobile devices",
    output: {
      query: "device:mobile OR device.family:mobile",
      fields: [
        "id",
        "timestamp",
        "title",
        "device",
        "device.family",
        "os",
        "browser",
      ],
      sort: "-timestamp",
      timeRange: { statsPeriod: "7d" },
    },
  },
  {
    description: "Events from specific browser",
    output: {
      query: "browser.name:Chrome",
      fields: [
        "id",
        "timestamp",
        "title",
        "browser.name",
        "browser.version",
        "os",
      ],
      sort: "-timestamp",
      timeRange: { statsPeriod: "7d" },
    },
  },
];
