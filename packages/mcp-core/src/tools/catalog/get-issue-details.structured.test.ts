import { issueFixture, mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { getStructuredContent } from "../../test-utils/structured-content";
import getIssueDetails, {
  getIssueDetailsOutputSchema,
} from "./get-issue-details.js";

// A Django error as the event api returns it: the chained exception, frames with
// ±5 context lines and local variables, a request with headers and cookies, the
// user, tags with their search queries, contexts and the extra data.
const ORG = "sentry-mcp-evals";
const GROUP_ID = "6823019447";
const EVENT_ID = "0f6c5d7e1b2a4c3d9e8f7a6b5c4d3e2f";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

function frame(overrides: Record<string, unknown>) {
  return {
    filename: null,
    absPath: null,
    module: null,
    package: null,
    platform: null,
    instructionAddr: null,
    symbolAddr: null,
    function: null,
    rawFunction: null,
    symbol: null,
    context: [],
    lineNo: null,
    colNo: null,
    inApp: false,
    trust: null,
    errors: null,
    lock: null,
    sourceLink: null,
    vars: null,
    ...overrides,
  };
}

function context(start: number, lines: string[]): Array<[number, string]> {
  return lines.map((line, index) => [start + index, line]);
}

const djangoFrame = frame({
  filename: "django/core/handlers/base.py",
  absPath:
    "/usr/local/lib/python3.12/site-packages/django/core/handlers/base.py",
  module: "django.core.handlers.base",
  function: "_get_response",
  lineNo: 197,
  context: context(191, [
    "        if response is None:",
    "            wrapped_callback = self.make_view_atomic(callback)",
    "            # If it is an asynchronous view, run it in a subthread.",
    "            if iscoroutinefunction(wrapped_callback):",
    "                wrapped_callback = async_to_sync(wrapped_callback)",
    "            try:",
    "                response = wrapped_callback(request, *callback_args, **callback_kwargs)",
    "            except Exception as e:",
    "                response = self.process_exception_by_middleware(e, request)",
    "                if response is None:",
    "                    raise",
  ]),
  vars: {
    callback: "<function checkout at 0x7f3c2a1b9d30>",
    request: "<WSGIRequest: POST '/api/orders/'>",
  },
});

const viewFrame = frame({
  filename: "shop/views.py",
  absPath: "/app/shop/views.py",
  module: "shop.views",
  function: "checkout",
  lineNo: 42,
  inApp: true,
  context: context(37, [
    "@require_POST",
    "def checkout(request):",
    "    cart = Cart.objects.get(user=request.user)",
    "    payload = json.loads(request.body)",
    "    with transaction.atomic():",
    "        order = OrderService(cart).place(payload['order_id'])",
    "    return JsonResponse({'id': order.pk})",
    "",
    "",
    "@require_GET",
    "def order_status(request, order_id):",
  ]),
  vars: {
    cart: "<Cart: 1182>",
    payload: { order_id: "ord_8812" },
    request: "<WSGIRequest: POST '/api/orders/'>",
  },
  sourceLink: "https://github.com/acme/shop/blob/9c1e2f/shop/views.py#L42",
});

const serviceFrame = frame({
  filename: "shop/services.py",
  absPath: "/app/shop/services.py",
  module: "shop.services",
  function: "OrderService.place",
  lineNo: 88,
  inApp: true,
  context: context(83, [
    "    def place(self, order_id):",
    '        """Turn the cart into an order."""',
    "        if self.cart.is_empty():",
    "            raise EmptyCart(self.cart.pk)",
    "        total = self.cart.total()",
    "        return Order.objects.create(external_id=order_id, total=total)",
    "",
    "    def cancel(self, order):",
    "        order.status = Order.CANCELLED",
    "        order.save(update_fields=['status'])",
    "",
  ]),
  vars: {
    order_id: "'ord_8812'",
    self: "<shop.services.OrderService object at 0x7f3c29f8a2d0>",
    total: "Decimal('129.00')",
  },
});

const psycopgFrame = frame({
  filename: "django/db/backends/utils.py",
  absPath:
    "/usr/local/lib/python3.12/site-packages/django/db/backends/utils.py",
  module: "django.db.backends.utils",
  function: "_execute",
  lineNo: 105,
  context: context(100, [
    "        with self.db.wrap_database_errors:",
    "            if params is None:",
    "                # params default might be backend specific.",
    "                return self.cursor.execute(sql)",
    "            else:",
    "                return self.cursor.execute(sql, params)",
    "",
    "    def _executemany(self, sql, param_list, *ignored_wrapper_args):",
    "        # Raise a warning during app initialization (stored_app_configs is only",
    "        # non-empty during checks).",
    "        if self.db.apps.ready and self.db.apps.stored_app_configs:",
  ]),
  vars: {
    params: "('ord_8812', Decimal('129.00'))",
    sql: '\'INSERT INTO "shop_order" ("external_id", "total") VALUES (%s, %s)\'',
  },
});

const djangoErrorEvent = {
  id: EVENT_ID,
  groupID: GROUP_ID,
  eventID: EVENT_ID,
  projectID: "4509062593708032",
  size: 14823,
  type: "error",
  platform: "python",
  title:
    'IntegrityError: duplicate key value violates unique constraint "shop_order_external_id_key"',
  message: "",
  culprit: "shop.services in OrderService.place",
  location: "shop/services.py",
  dateCreated: "2026-11-05T21:14:03.118000Z",
  dateReceived: "2026-11-05T21:14:03.902131Z",
  dist: null,
  crashFile: null,
  fingerprints: ["f3b0c2d1e4a59687a1b2c3d4e5f60718"],
  groupingConfig: {
    id: "newstyle:2023-01-11",
    enhancements: "KLUv_SAYwQAAkwKRs25ld3N0eWxlOjIwMjMtMDEtMTGQ",
  },
  release: null,
  userReport: null,
  sdkUpdates: [],
  resolvedWith: [],
  nextEventID: null,
  previousEventID: "9a8b7c6d5e4f30211a2b3c4d5e6f7081",
  occurrence: null,
  entries: [
    {
      type: "exception",
      data: {
        // the chain cause comes first and the exception that was raised last
        values: [
          {
            type: "UniqueViolation",
            value:
              'duplicate key value violates unique constraint "shop_order_external_id_key"\nDETAIL:  Key (external_id)=(ord_8812) already exists.',
            module: "psycopg2.errors",
            mechanism: {
              type: "chained",
              handled: true,
              source: "__cause__",
              exception_id: 1,
              parent_id: 0,
            },
            threadId: null,
            stacktrace: {
              frames: [psycopgFrame],
              framesOmitted: null,
              registers: null,
              hasSystemFrames: true,
            },
            rawStacktrace: null,
          },
          {
            type: "IntegrityError",
            value:
              'duplicate key value violates unique constraint "shop_order_external_id_key"\nDETAIL:  Key (external_id)=(ord_8812) already exists.',
            module: "django.db.utils",
            mechanism: {
              type: "django",
              handled: false,
              exception_id: 0,
              is_exception_group: false,
            },
            threadId: null,
            stacktrace: {
              frames: [djangoFrame, viewFrame, serviceFrame],
              framesOmitted: null,
              registers: null,
              hasSystemFrames: true,
            },
            rawStacktrace: null,
          },
        ],
        hasSystemFrames: true,
        excOmitted: null,
      },
    },
    {
      type: "request",
      data: {
        apiTarget: null,
        method: "POST",
        url: "https://shop.example.com/api/orders/",
        query: [["source", "cart"]],
        fragment: "",
        data: { order_id: "ord_8812" },
        headers: [
          ["Authorization", "Bearer sk_live_must_not_leak"],
          ["Content-Type", "application/json"],
          ["User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)"],
        ],
        cookies: [["sessionid", "session-cookie-must-not-leak"]],
        env: { SERVER_NAME: "web-7f9c", SERVER_PORT: "8000" },
        inferredContentType: "application/json",
      },
    },
  ],
  user: {
    id: "1182",
    email: "jane@example.com",
    username: "jane",
    ip_address: "203.0.113.24",
    name: null,
    geo: { country_code: "US", city: "San Francisco", region: "CA" },
    data: { plan: "business", is_staff: false },
  },
  tags: [
    { key: "browser", value: "Chrome 130.0.0" },
    { key: "environment", value: "production" },
    { key: "handled", value: "no" },
    { key: "level", value: "error" },
    { key: "mechanism", value: "django" },
    { key: "release", value: "shop@2026.11.5" },
    { key: "server_name", value: "web-7f9c" },
    { key: "transaction", value: "/api/orders/" },
    { key: "url", value: "https://shop.example.com/api/orders/" },
    { key: "user", value: "id:1182", query: 'user.id:"1182"' },
  ],
  contexts: {
    browser: { name: "Chrome", version: "130.0.0", type: "browser" },
    runtime: {
      name: "CPython",
      version: "3.12.4",
      build: "3.12.4 (main, Jun 13 2024, 04:22:31) [GCC 12.2.0]",
      type: "runtime",
    },
    trace: {
      trace_id: TRACE_ID,
      span_id: "a1b2c3d4e5f60718",
      parent_span_id: null,
      op: "http.server",
      status: "internal_error",
      origin: "auto.http.django",
      type: "trace",
    },
  },
  context: {
    "sys.argv": ["/usr/local/bin/gunicorn", "shop.wsgi", "--workers", "4"],
  },
  sdk: { name: "sentry.python.django", version: "2.18.0" },
  packages: { django: "5.0.6", psycopg2: "2.9.9" },
  errors: [],
  metadata: {
    type: "IntegrityError",
    value:
      'duplicate key value violates unique constraint "shop_order_external_id_key"',
    filename: "shop/services.py",
    function: "OrderService.place",
  },
  _meta: { user: { ip_address: { "": { rem: [["@ip", "s"]] } } } },
};

const djangoIssue = {
  ...issueFixture,
  id: GROUP_ID,
  shortId: "SHOP-4F2",
  title: djangoErrorEvent.title,
  culprit: djangoErrorEvent.culprit,
  permalink: `https://${ORG}.sentry.io/issues/${GROUP_ID}/`,
  platform: "python",
  project: {
    id: "4509062593708032",
    name: "shop",
    slug: "shop",
    platform: "python-django",
  },
  metadata: djangoErrorEvent.metadata,
  shareId: "share-token-must-not-leak",
  count: "312",
  userCount: 41,
  firstSeen: "2026-11-01T08:02:11.000000Z",
  lastSeen: "2026-11-05T21:14:03.118000Z",
};

function mockDjangoIssue(event: Record<string, unknown> = djangoErrorEvent) {
  mswServer.use(
    http.get(
      `https://sentry.io/api/0/organizations/${ORG}/issues/SHOP-4F2/`,
      () => HttpResponse.json(djangoIssue),
    ),
    http.get(
      `https://sentry.io/api/0/organizations/${ORG}/issues/${GROUP_ID}/events/latest/`,
      () => HttpResponse.json(event),
    ),
    http.get(
      `https://sentry.io/api/0/organizations/${ORG}/issues/${GROUP_ID}/external-issues/`,
      () =>
        HttpResponse.json([
          {
            id: "88112",
            issueId: GROUP_ID,
            serviceType: "github",
            displayName: "acme/shop#311",
            webUrl: "https://github.com/acme/shop/issues/311",
            integrationId: "integration-id-must-not-leak",
          },
        ]),
    ),
    http.get(`https://sentry.io/api/0/organizations/${ORG}/replay-count/`, () =>
      HttpResponse.json({}),
    ),
    http.get(`https://sentry.io/api/0/organizations/${ORG}/events/`, () =>
      HttpResponse.json({ data: [], meta: { fields: {} } }),
    ),
    http.get(
      `https://sentry.io/api/0/projects/${ORG}/shop/stacktrace-link/`,
      () =>
        HttpResponse.json({
          config: null,
          sourceUrl: null,
          error: "no_code_mappings_for_project",
        }),
    ),
    http.get(
      `https://sentry.io/api/0/projects/${ORG}/shop/events/${EVENT_ID}/committers/`,
      () => HttpResponse.json({ committers: [] }),
    ),
    http.get(
      `https://sentry.io/api/0/organizations/${ORG}/issues/SHOP-4F2/autofix/`,
      () => HttpResponse.json({ autofix: null }),
    ),
  );
}

const params = {
  organizationSlug: ORG,
  issueId: "SHOP-4F2",
  eventId: undefined,
  issueUrl: undefined,
  regionUrl: null,
};

const experimentalContext = {
  constraints: { organizationSlug: undefined },
  accessToken: "access-token",
  userId: "1",
  experimentalMode: true,
};

describe("get_issue_details structuredContent for a realistic error", () => {
  it("maps the whole event and satisfies the schema", async () => {
    mockDjangoIssue();

    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = getStructuredContent(result);

    expect(getIssueDetailsOutputSchema.parse(payload)).toEqual(payload);
    expect(payload).toMatchInlineSnapshot(`
      {
        "aiConversations": null,
        "codeLocation": null,
        "concerns": [],
        "event": {
          "contexts": {
            "browser": {
              "name": "Chrome",
              "version": "130.0.0",
            },
            "runtime": {
              "build": "3.12.4 (main, Jun 13 2024, 04:22:31) [GCC 12.2.0]",
              "name": "CPython",
              "version": "3.12.4",
            },
            "trace": {
              "op": "http.server",
              "origin": "auto.http.django",
              "span_id": "a1b2c3d4e5f60718",
              "status": "internal_error",
              "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
            },
          },
          "crashedThread": null,
          "csp": null,
          "evidence": null,
          "exceptions": [
            {
              "mechanism": {
                "handled": false,
                "type": "django",
              },
              "module": "django.db.utils",
              "stacktrace": {
                "frames": [
                  {
                    "absPath": "/usr/local/lib/python3.12/site-packages/django/core/handlers/base.py",
                    "contextLine": "                response = wrapped_callback(request, *callback_args, **callback_kwargs)",
                    "filename": "django/core/handlers/base.py",
                    "function": "_get_response",
                    "lineNo": 197,
                    "module": "django.core.handlers.base",
                  },
                  {
                    "absPath": "/app/shop/views.py",
                    "contextLine": "        order = OrderService(cart).place(payload['order_id'])",
                    "filename": "shop/views.py",
                    "function": "checkout",
                    "inApp": true,
                    "lineNo": 42,
                    "module": "shop.views",
                  },
                  {
                    "absPath": "/app/shop/services.py",
                    "contextLine": "        return Order.objects.create(external_id=order_id, total=total)",
                    "filename": "shop/services.py",
                    "function": "OrderService.place",
                    "inApp": true,
                    "lineNo": 88,
                    "module": "shop.services",
                    "postContext": [
                      "",
                      "    def cancel(self, order):",
                      "        order.status = Order.CANCELLED",
                    ],
                    "preContext": [
                      "        if self.cart.is_empty():",
                      "            raise EmptyCart(self.cart.pk)",
                      "        total = self.cart.total()",
                    ],
                    "vars": {
                      "order_id": "'ord_8812'",
                      "self": "<shop.services.OrderService object at 0x7f3c29f8a2d0>",
                      "total": "Decimal('129.00')",
                    },
                  },
                ],
                "framesOmitted": null,
              },
              "type": "IntegrityError",
              "value": "duplicate key value violates unique constraint "shop_order_external_id_key"
      DETAIL:  Key (external_id)=(ord_8812) already exists.",
            },
            {
              "mechanism": {
                "handled": true,
                "type": "chained",
              },
              "module": "psycopg2.errors",
              "stacktrace": {
                "frames": [
                  {
                    "absPath": "/usr/local/lib/python3.12/site-packages/django/db/backends/utils.py",
                    "contextLine": "                return self.cursor.execute(sql, params)",
                    "filename": "django/db/backends/utils.py",
                    "function": "_execute",
                    "lineNo": 105,
                    "module": "django.db.backends.utils",
                  },
                ],
                "framesOmitted": null,
              },
              "type": "UniqueViolation",
              "value": "duplicate key value violates unique constraint "shop_order_external_id_key"
      DETAIL:  Key (external_id)=(ord_8812) already exists.",
            },
          ],
          "extra": {
            "sys.argv": [
              "/usr/local/bin/gunicorn",
              "shop.wsgi",
              "--workers",
              "4",
            ],
          },
          "id": "0f6c5d7e1b2a4c3d9e8f7a6b5c4d3e2f",
          "message": null,
          "metricAlert": null,
          "occurredAt": "2026-11-05T21:14:03.118Z",
          "performance": null,
          "platform": "python",
          "request": {
            "method": "POST",
            "url": "https://shop.example.com/api/orders/",
          },
          "tags": [
            {
              "key": "browser",
              "value": "Chrome 130.0.0",
            },
            {
              "key": "environment",
              "value": "production",
            },
            {
              "key": "handled",
              "value": "no",
            },
            {
              "key": "level",
              "value": "error",
            },
            {
              "key": "mechanism",
              "value": "django",
            },
            {
              "key": "release",
              "value": "shop@2026.11.5",
            },
            {
              "key": "server_name",
              "value": "web-7f9c",
            },
            {
              "key": "transaction",
              "value": "/api/orders/",
            },
            {
              "key": "url",
              "value": "https://shop.example.com/api/orders/",
            },
            {
              "key": "user",
              "value": "id:1182",
            },
          ],
          "threadCount": 0,
          "threads": null,
          "type": "error",
          "user": {
            "data": {
              "is_staff": false,
              "plan": "business",
            },
            "email": "jane@example.com",
            "geo": {
              "city": "San Francisco",
              "countryCode": "US",
              "region": "CA",
            },
            "id": "1182",
            "ipAddress": "203.0.113.24",
            "name": null,
            "username": "jane",
          },
        },
        "externalIssues": [
          {
            "displayName": "acme/shop#311",
            "serviceType": "github",
            "webUrl": "https://github.com/acme/shop/issues/311",
          },
        ],
        "issue": {
          "assignedTo": "Jane Developer",
          "culprit": "shop.services in OrderService.place",
          "firstSeen": "2026-11-01T08:02:11.000000Z",
          "issueCategory": "error",
          "issueType": "error",
          "lastSeen": "2026-11-05T21:14:03.118000Z",
          "location": null,
          "occurrences": 312,
          "platform": "python",
          "project": "shop",
          "queryPattern": null,
          "seerActionability": null,
          "shortId": "SHOP-4F2",
          "status": "unresolved",
          "substatus": "ongoing",
          "title": "IntegrityError: duplicate key value violates unique constraint "shop_order_external_id_key"",
          "url": "https://sentry-mcp-evals.sentry.io/issues/SHOP-4F2",
          "usersImpacted": 41,
        },
        "replays": null,
        "seer": null,
        "suggestedActions": [
          {
            "arguments": {
              "organizationSlug": "sentry-mcp-evals",
              "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
            },
            "reason": "Inspect the distributed trace this event belongs to.",
            "toolName": "get_trace_details",
            "type": "tool_call",
          },
          {
            "arguments": {
              "issueUrl": "https://sentry-mcp-evals.sentry.io/issues/SHOP-4F2",
            },
            "reason": "Read the breadcrumb trail leading up to this event.",
            "toolName": "get_issue_breadcrumbs",
            "type": "tool_call",
          },
        ],
        "suspectCommit": null,
      }
    `);
  });

  it("keeps internal ids, secrets and raw blobs out", async () => {
    mockDjangoIssue();

    const result = await getIssueDetails.handler(params, experimentalContext);
    const serialized = JSON.stringify(getStructuredContent(result));

    for (const leak of [
      // request plumbing the payload does not surface
      "sk_live_must_not_leak",
      "session-cookie-must-not-leak",
      "SERVER_PORT",
      // integration and sharing plumbing
      "share-token-must-not-leak",
      "integration-id-must-not-leak",
      "88112",
      // frame and event internals
      "sourceLink",
      "github.com/acme/shop/blob",
      "instructionAddr",
      "rawStacktrace",
      "hasSystemFrames",
      "exception_id",
      "groupingConfig",
      "KLUv_SAYwQAAkwKRs25ld3N0eWxlOjIwMjMtMDEtMTGQ",
      "f3b0c2d1e4a59687a1b2c3d4e5f60718",
      "_meta",
      "4509062593708032",
      // a tag's search query is ui plumbing
      'user.id:\\"1182\\"',
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("returns the stored user data", async () => {
    mockDjangoIssue();

    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = getStructuredContent<Record<string, any>>(result);

    expect(payload.event.user).toEqual({
      id: "1182",
      email: "jane@example.com",
      username: "jane",
      ipAddress: "203.0.113.24",
      name: null,
      geo: { countryCode: "US", city: "San Francisco", region: "CA" },
      data: { plan: "business", is_staff: false },
    });
  });

  it("puts the raised exception first and keeps context on the most relevant frame", async () => {
    mockDjangoIssue();

    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = getStructuredContent<Record<string, any>>(result);
    const [raised, cause] = payload.event.exceptions;

    expect(raised.type).toBe("IntegrityError");
    expect(cause.type).toBe("UniqueViolation");
    const frames = raised.stacktrace.frames;
    // oldest call first, the raising frame last
    expect(frames.map((f: { function: string }) => f.function)).toEqual([
      "_get_response",
      "checkout",
      "OrderService.place",
    ]);
    // a library frame keeps only its own line and no locals
    expect(frames[0]).toMatchObject({
      contextLine:
        "                response = wrapped_callback(request, *callback_args, **callback_kwargs)",
    });
    expect(frames[0]).not.toHaveProperty("preContext");
    expect(frames[0]).not.toHaveProperty("vars");
    // an earlier in-app frame keeps only its own line too
    expect(frames[1]).toHaveProperty("inApp", true);
    expect(frames[1]).not.toHaveProperty("preContext");
    expect(frames[1]).not.toHaveProperty("vars");
    // the most relevant (last in-app) frame keeps 3 lines either side and its locals
    expect(frames[2]).toMatchObject({
      contextLine:
        "        return Order.objects.create(external_id=order_id, total=total)",
      preContext: [
        "        if self.cart.is_empty():",
        "            raise EmptyCart(self.cart.pk)",
        "        total = self.cart.total()",
      ],
      postContext: [
        "",
        "    def cancel(self, order):",
        "        order.status = Order.CANCELLED",
      ],
    });
    expect(frames[2].vars).toHaveProperty("order_id", "'ord_8812'");
  });

  it("lists the first 20 threads and counts them all", async () => {
    const threads = Array.from({ length: 25 }, (_, index) => ({
      id: index + 1,
      name: `worker-${index + 1}`,
      state: "WAITING",
      crashed: false,
      current: false,
      heldLocks: null,
      stacktrace: null,
      rawStacktrace: null,
    }));
    mockDjangoIssue({
      ...djangoErrorEvent,
      entries: [
        ...djangoErrorEvent.entries,
        { type: "threads", data: { values: threads } },
      ],
    });

    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = getStructuredContent<Record<string, any>>(result);

    expect(payload.event.threadCount).toBe(25);
    expect(payload.event.threads).toHaveLength(20);
    expect(payload.event.threads.at(-1).name).toBe("worker-20");
  });

  it("falls back to the ip and display_name user aliases", async () => {
    mockDjangoIssue({
      ...djangoErrorEvent,
      user: {
        id: "1182",
        email: "jane@example.com",
        ip: "203.0.113.24",
        display_name: "Jane Doe",
      },
    });

    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = getStructuredContent<Record<string, any>>(result);

    expect(payload.event.user).toMatchObject({
      ipAddress: "203.0.113.24",
      name: "Jane Doe",
    });
  });

  it("turns empty strings into null", async () => {
    mockDjangoIssue({
      ...djangoErrorEvent,
      tags: [...djangoErrorEvent.tags, { key: "device", value: "" }],
      contexts: {
        ...djangoErrorEvent.contexts,
        os: { name: "", version: "", type: "os" },
      },
    });

    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = getStructuredContent<Record<string, any>>(result);

    // the top level message is an empty string on an error event
    expect(payload.event.message).toBeNull();
    expect(payload.event.tags).toContainEqual({ key: "device", value: null });
    // a context with nothing left is dropped
    expect(payload.event.contexts).not.toHaveProperty("os");
  });

  it("lists the threads and maps the crashed one when there is no exception", async () => {
    // a watchdog termination: threads, but no exception entry
    mockDjangoIssue({
      ...djangoErrorEvent,
      type: "default",
      platform: "native",
      entries: [
        {
          type: "threads",
          data: {
            values: [
              {
                id: 0,
                current: false,
                crashed: true,
                name: "main",
                state: "BLOCKED",
                heldLocks: null,
                stacktrace: {
                  frames: [
                    frame({
                      filename: "main.c",
                      function: "main",
                      lineNo: 12,
                      inApp: true,
                    }),
                    frame({
                      filename: "render.c",
                      function: "draw_frame",
                      lineNo: 220,
                      inApp: true,
                      instructionAddr: "0x0000000100f3c2a8",
                    }),
                  ],
                  framesOmitted: null,
                  registers: { pc: "0x0000000100f3c2a8" },
                  hasSystemFrames: false,
                },
              },
              {
                id: 7,
                current: false,
                crashed: false,
                name: "",
                state: null,
                heldLocks: null,
                stacktrace: null,
              },
            ],
          },
        },
      ],
    });

    const result = await getIssueDetails.handler(params, experimentalContext);
    const payload = getIssueDetailsOutputSchema.parse(
      getStructuredContent(result),
    );

    expect(payload.event.exceptions).toBeNull();
    expect(payload.event.threads).toEqual([
      {
        id: 0,
        name: "main",
        state: "BLOCKED",
        crashed: true,
        current: false,
        frameCount: 2,
      },
      {
        id: 7,
        name: null,
        state: null,
        crashed: false,
        current: false,
        frameCount: 0,
      },
    ]);
    expect(
      payload.event.crashedThread?.stacktrace?.frames.map((f) => f.function),
    ).toEqual(["main", "draw_frame"]);
    expect(JSON.stringify(payload)).not.toContain("0x0000000100f3c2a8");
  });
});
