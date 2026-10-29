import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SentryApiService } from "../api-client";
import type { AutofixRunState, Event, Issue } from "../api-client/types";
import {
  formatEventOutput,
  formatFrameHeader,
  formatIssueOutput,
  getSeerActionabilityLabel,
} from "./formatting";
import {
  EventBuilder,
  createExceptionValue,
  createFrame,
  createFrameWithContext,
  createStackTrace,
  createThread,
  frameFactories,
  testEvents,
} from "./test-fixtures";

// Helper functions to reduce duplication in event creation
function createPythonExceptionEvent(
  errorType: string,
  errorMessage: string,
  frames: any[],
): Event {
  return new EventBuilder("python")
    .withException(
      createExceptionValue({
        type: errorType,
        value: errorMessage,
        stacktrace: createStackTrace(frames),
      }),
    )
    .build();
}

function createSimpleExceptionEvent(
  platform: string,
  errorType: string,
  errorMessage: string,
  frame: any,
): Event {
  const builder = new EventBuilder(platform);
  // Remove the contexts property to avoid "Additional Context" section
  const event = builder
    .withException(
      createExceptionValue({
        type: errorType,
        value: errorMessage,
        stacktrace: createStackTrace([frame]),
      }),
    )
    .build();
  // Remove contexts to match original test expectations
  event.contexts = undefined;
  return event;
}

describe("getSeerActionabilityLabel", () => {
  it("returns correct labels for threshold boundaries", () => {
    expect(getSeerActionabilityLabel(0.77)).toBe("super_high");
    expect(getSeerActionabilityLabel(0.67)).toBe("high");
    expect(getSeerActionabilityLabel(0.41)).toBe("medium");
    expect(getSeerActionabilityLabel(0.26)).toBe("low");
    expect(getSeerActionabilityLabel(0.25)).toBe("super_low");
    expect(getSeerActionabilityLabel(0)).toBe("super_low");
  });

  it("returns super_high for scores above 0.76", () => {
    expect(getSeerActionabilityLabel(0.99)).toBe("super_high");
    expect(getSeerActionabilityLabel(0.8)).toBe("super_high");
    expect(getSeerActionabilityLabel(0.761)).toBe("super_high");
  });

  it("returns high for scores between 0.66 and 0.76", () => {
    expect(getSeerActionabilityLabel(0.76)).toBe("high");
    expect(getSeerActionabilityLabel(0.7)).toBe("high");
    expect(getSeerActionabilityLabel(0.661)).toBe("high");
  });

  it("returns medium for scores between 0.40 and 0.66", () => {
    expect(getSeerActionabilityLabel(0.66)).toBe("medium");
    expect(getSeerActionabilityLabel(0.5)).toBe("medium");
    expect(getSeerActionabilityLabel(0.401)).toBe("medium");
  });

  it("returns low for scores between 0.25 and 0.40", () => {
    expect(getSeerActionabilityLabel(0.4)).toBe("low");
    expect(getSeerActionabilityLabel(0.3)).toBe("low");
    expect(getSeerActionabilityLabel(0.251)).toBe("low");
  });

  it("returns super_low for scores at or below 0.25", () => {
    expect(getSeerActionabilityLabel(0.25)).toBe("super_low");
    expect(getSeerActionabilityLabel(0.1)).toBe("super_low");
    expect(getSeerActionabilityLabel(0)).toBe("super_low");
  });
});

describe("formatIssueOutput", () => {
  it("uses the issue URL for commit references when shortId is unavailable", () => {
    const output = formatIssueOutput({
      organizationSlug: "sentry-mcp-evals",
      issue: {
        id: "123456",
        shortId: "123456",
        title: "Retry job failed",
        count: "1",
        userCount: 1,
        status: "unresolved",
        project: {
          name: "cloudflare-mcp",
          slug: "cloudflare-mcp",
        },
      } as Issue,
      event: new EventBuilder("javascript").withId("event-1").build(),
      apiService: {
        getIssueUrl: () => "https://sentry.example/issues/123456",
      } as unknown as SentryApiService,
    });

    expect(output).toContain(
      "`Fixes https://sentry.example/issues/123456` automatically closes the issue",
    );
    expect(output).not.toContain("`Fixes 123456`");
  });

  it("does not throw and omits Occurred At when dateCreated is missing", () => {
    const output = formatIssueOutput({
      organizationSlug: "sentry-mcp-evals",
      issue: {
        id: "123456",
        shortId: "CLOUDFLARE-MCP-1",
        title: "Retry job failed",
        count: "1",
        userCount: 1,
        status: "unresolved",
        project: {
          name: "cloudflare-mcp",
          slug: "cloudflare-mcp",
        },
      } as Issue,
      event: new EventBuilder("javascript")
        .withId("event-1")
        .withDateCreated(undefined)
        .build(),
      apiService: {
        getIssueUrl: () => "https://sentry.example/issues/CLOUDFLARE-MCP-1",
      } as unknown as SentryApiService,
    });

    expect(output).not.toContain("**Occurred At**");
  });

  it("does not throw and omits Occurred At when dateCreated is an invalid date string", () => {
    const output = formatIssueOutput({
      organizationSlug: "sentry-mcp-evals",
      issue: {
        id: "123456",
        shortId: "CLOUDFLARE-MCP-2",
        title: "Retry job failed",
        count: "1",
        userCount: 1,
        status: "unresolved",
        project: {
          name: "cloudflare-mcp",
          slug: "cloudflare-mcp",
        },
      } as Issue,
      event: new EventBuilder("javascript")
        .withId("event-2")
        .withDateCreated("not-a-date")
        .build(),
      apiService: {
        getIssueUrl: () => "https://sentry.example/issues/CLOUDFLARE-MCP-2",
      } as unknown as SentryApiService,
    });

    expect(output).not.toContain("**Occurred At**");
  });

  it("does not use Seer provenance tags as fallback summary text", () => {
    const output = formatIssueOutput({
      organizationSlug: "sentry-mcp-evals",
      issue: {
        shortId: "CLOUDFLARE-MCP-42",
        title: "Retry job failed",
        count: "1",
        userCount: 1,
        status: "unresolved",
        project: {
          name: "cloudflare-mcp",
          slug: "cloudflare-mcp",
        },
      } as Issue,
      event: new EventBuilder("javascript").withId("event-1").build(),
      apiService: {
        getIssueUrl: () => "https://sentry.example/issues/CLOUDFLARE-MCP-42",
      } as unknown as SentryApiService,
      autofixState: {
        autofix: {
          run_id: 42,
          status: "completed",
          updated_at: "2025-04-09T22:39:50.778146",
          blocks: [
            {
              artifacts: [
                {
                  key: "solution",
                  reason: "Solution plan completed",
                  data: {
                    one_line_summary:
                      "Use the canonical issue identifier before retrying the analysis request so the summary remains readable.",
                    steps: [
                      {
                        title: "Normalize the issue identifier",
                        description:
                          "Use the canonical issue identifier before retrying.",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      } as AutofixRunState,
    });

    expect(output).toContain("**Summary:**");
    expect(output).toContain(
      "Use the canonical issue identifier before retrying the analysis request so the summary remains readable.",
    );
    expect(output).not.toContain("<seer_analysis");
  });

  it("does not show trace search tool calls when search_events is unavailable", () => {
    const output = formatIssueOutput({
      organizationSlug: "sentry-mcp-evals",
      issue: {
        shortId: "CLOUDFLARE-MCP-42",
        title: "Retry job failed",
        count: "1",
        userCount: 1,
        status: "unresolved",
        project: {
          name: "cloudflare-mcp",
          slug: "cloudflare-mcp",
        },
      } as Issue,
      event: new EventBuilder("javascript")
        .withId("event-1")
        .withContexts({
          trace: {
            trace_id: "3032af8bcdfe4423b937fc5c041d5d82",
          },
        })
        .build(),
      apiService: {
        getIssueUrl: () => "https://sentry.example/issues/CLOUDFLARE-MCP-42",
      } as unknown as SentryApiService,
      experimentalMode: true,
      availableToolNames: new Set([
        "get_sentry_resource",
        "get_issue_breadcrumbs",
        "search_issue_events",
      ]),
      directToolNames: new Set(["get_sentry_resource", "search_issue_events"]),
    });

    expect(output).toContain(
      "- Full distributed trace and span tree: Use the Sentry tool `get_sentry_resource`",
    );
    expect(output).toContain(
      "- Related span search: Related span search is not available in this session",
    );
    expect(output).toContain(
      "- Related log search: Related log search is not available in this session",
    );
    expect(output).not.toContain("search_events(");
  });
});

describe("formatFrameHeader", () => {
  it("uses platform as fallback when language detection fails", () => {
    // Frame with no clear language indicators
    const unknownFrame = {
      filename: "/path/to/file.unknown",
      function: "someFunction",
      lineNo: 42,
    };

    // Without platform - should use generic format
    expect(formatFrameHeader(unknownFrame)).toBe(
      "    at someFunction (/path/to/file.unknown:42)",
    );

    // With platform python - should use Python format
    expect(formatFrameHeader(unknownFrame, undefined, "python")).toBe(
      '  File "/path/to/file.unknown", line 42, in someFunction',
    );

    // With platform java - should use Java format
    expect(formatFrameHeader(unknownFrame, undefined, "java")).toBe(
      "at UnknownClass.someFunction(/path/to/file.unknown:42)",
    );
  });
  it("formats Java stack traces correctly", () => {
    // With module and filename
    const javaFrame1 = {
      module: "com.example.ClassName",
      function: "methodName",
      filename: "ClassName.java",
      lineNo: 123,
    };
    expect(formatFrameHeader(javaFrame1)).toBe(
      "at com.example.ClassName.methodName(ClassName.java:123)",
    );

    // Without filename (common in Java) - needs platform hint
    const javaFrame2 = {
      module: "com.example.ClassName",
      function: "methodName",
      lineNo: 123,
    };
    expect(formatFrameHeader(javaFrame2, undefined, "java")).toBe(
      "at com.example.ClassName.methodName(Unknown Source:123)",
    );
  });

  it("formats Python stack traces correctly", () => {
    const pythonFrame = {
      filename: "/path/to/file.py",
      function: "function_name",
      lineNo: 42,
    };
    expect(formatFrameHeader(pythonFrame)).toBe(
      '  File "/path/to/file.py", line 42, in function_name',
    );

    // Module only (no filename) - needs platform hint
    const pythonModuleFrame = {
      module: "mymodule",
      function: "function_name",
      lineNo: 42,
    };
    expect(formatFrameHeader(pythonModuleFrame, undefined, "python")).toBe(
      '  File "mymodule", line 42, in function_name',
    );
  });

  it("formats JavaScript stack traces correctly", () => {
    // With column number
    const jsFrame1 = {
      filename: "/path/to/file.js",
      function: "functionName",
      lineNo: 10,
      colNo: 15,
    };
    expect(formatFrameHeader(jsFrame1)).toBe(
      "/path/to/file.js:10:15 (functionName)",
    );

    // Without column number but .js extension
    const jsFrame2 = {
      filename: "/path/to/file.js",
      function: "functionName",
      lineNo: 10,
    };
    expect(formatFrameHeader(jsFrame2)).toBe(
      "/path/to/file.js:10 (functionName)",
    );

    // Anonymous function (no function name)
    const jsFrame3 = {
      filename: "/path/to/file.js",
      lineNo: 10,
      colNo: 15,
    };
    expect(formatFrameHeader(jsFrame3)).toBe("/path/to/file.js:10:15");
  });

  it("formats Ruby stack traces correctly", () => {
    const rubyFrame = {
      filename: "/path/to/file.rb",
      function: "method_name",
      lineNo: 42,
    };
    expect(formatFrameHeader(rubyFrame)).toBe(
      "    from /path/to/file.rb:42:in `method_name`",
    );

    // Without function name
    const rubyFrame2 = {
      filename: "/path/to/file.rb",
      lineNo: 42,
    };
    expect(formatFrameHeader(rubyFrame2)).toBe(
      "    from /path/to/file.rb:42:in",
    );
  });

  it("formats PHP stack traces correctly", () => {
    // With frame index
    const phpFrame1 = {
      filename: "/path/to/file.php",
      function: "functionName",
      lineNo: 42,
    };
    expect(formatFrameHeader(phpFrame1, 0)).toBe(
      "#0 /path/to/file.php(42): functionName()",
    );

    // Without frame index
    const phpFrame2 = {
      filename: "/path/to/file.php",
      function: "functionName",
      lineNo: 42,
    };
    expect(formatFrameHeader(phpFrame2)).toBe(
      "/path/to/file.php(42): functionName()",
    );
  });

  it("formats unknown languages with generic format", () => {
    const unknownFrame = {
      filename: "/path/to/file.unknown",
      function: "someFunction",
      lineNo: 42,
    };
    expect(formatFrameHeader(unknownFrame)).toBe(
      "    at someFunction (/path/to/file.unknown:42)",
    );
  });

  it("prioritizes duck typing over platform when clear indicators exist", () => {
    // Java file but platform says python - should use Java format
    const javaFrame = {
      filename: "Example.java",
      module: "com.example.Example",
      function: "doSomething",
      lineNo: 42,
    };
    expect(formatFrameHeader(javaFrame, undefined, "python")).toBe(
      "at com.example.Example.doSomething(Example.java:42)",
    );

    // Python file but platform says java - should use Python format
    const pythonFrame = {
      filename: "/app/example.py",
      function: "do_something",
      lineNo: 42,
    };
    expect(formatFrameHeader(pythonFrame, undefined, "java")).toBe(
      '  File "/app/example.py", line 42, in do_something',
    );
  });
});

describe("formatEventOutput", () => {
  it("formats Java thread stack traces correctly", () => {
    const event = testEvents.javaThreadError(
      "Cannot use this function, please use update(String sql, PreparedStatementSetter pss) instead",
    );

    const output = formatEventOutput(event);

    expect(output).toMatchInlineSnapshot(`
      "### Error

      \`\`\`
      Cannot use this function, please use update(String sql, PreparedStatementSetter pss) instead
      \`\`\`

      **Thread** (CONTRACT_WORKER)

      **Stacktrace:**
      \`\`\`
      at java.lang.Thread.run(Thread.java:833)
      at com.citics.eqd.mq.aeron.AeronServer.lambda$start$3(AeronServer.java:110)
      \`\`\`
      "
    `);
  });

  it("formats Python exception traces correctly", () => {
    const event = testEvents.pythonException("Invalid value");

    const output = formatEventOutput(event);

    expect(output).toMatchInlineSnapshot(`
      "### Error

      \`\`\`
      ValueError: Invalid value
      \`\`\`

      **Stacktrace:**
      \`\`\`
        File "/app/main.py", line 42, in process_data
        File "/app/utils.py", line 15, in validate
      \`\`\`

      "
    `);
  });

  it("should render enhanced in-app frame with context lines", () => {
    const event = new EventBuilder("python")
      .withException(
        createExceptionValue({
          type: "ValueError",
          value: "Something went wrong",
          stacktrace: createStackTrace([
            createFrame({
              filename: "/usr/lib/python3.8/json/__init__.py",
              function: "loads",
              lineNo: 357,
              inApp: false,
            }),
            createFrameWithContext(
              {
                filename: "/app/services/payment.py",
                function: "process_payment",
                lineNo: 42,
              },
              [
                [37, "    def process_payment(self, amount, user_id):"],
                [38, "        user = self.get_user(user_id)"],
                [39, "        if not user:"],
                [40, '            raise ValueError("User not found")'],
                [41, "        "],
                [42, "        balance = user.account.balance"],
                [43, "        if balance < amount:"],
                [44, "            raise InsufficientFundsError()"],
                [45, "        "],
                [46, "        transaction = Transaction(user, amount)"],
              ],
            ),
          ]),
        }),
      )
      .build();

    const output = formatEventOutput(event);

    expect(output).toMatchInlineSnapshot(`
      "### Error

      \`\`\`
      ValueError: Something went wrong
      \`\`\`

      **Most Relevant Frame:**
      ─────────────────────
        File "/app/services/payment.py", line 42, in process_payment

          39 │         if not user:
          40 │             raise ValueError("User not found")
          41 │         
        → 42 │         balance = user.account.balance
          43 │         if balance < amount:
          44 │             raise InsufficientFundsError()
          45 │         

      **Full Stacktrace:**
      ────────────────
      \`\`\`
        File "/usr/lib/python3.8/json/__init__.py", line 357, in loads
        File "/app/services/payment.py", line 42, in process_payment
              balance = user.account.balance
      \`\`\`

      "
    `);
  });

  it("should render enhanced in-app frame with variables", () => {
    const event = new EventBuilder("python")
      .withException(
        createExceptionValue({
          type: "ValueError",
          value: "Something went wrong",
          stacktrace: createStackTrace([
            createFrame({
              filename: "/app/services/payment.py",
              function: "process_payment",
              lineNo: 42,
              inApp: true,
              vars: {
                amount: 150.0,
                user_id: "usr_123456",
                user: null,
                self: { type: "PaymentService", id: 1234 },
              },
            }),
          ]),
        }),
      )
      .build();

    const output = formatEventOutput(event);

    expect(output).toMatchInlineSnapshot(`
      "### Error

      \`\`\`
      ValueError: Something went wrong
      \`\`\`

      **Most Relevant Frame:**
      ─────────────────────
        File "/app/services/payment.py", line 42, in process_payment

      Local Variables:
      ├─ amount: 150
      ├─ user_id: "usr_123456"
      ├─ user: null
      └─ self: {"type":"PaymentService","id":1234}

      **Full Stacktrace:**
      ────────────────
      \`\`\`
        File "/app/services/payment.py", line 42, in process_payment
      \`\`\`

      "
    `);
  });

  it("should handle frames without in-app or enhanced data", () => {
    const event = new EventBuilder("python")
      .withException(
        createExceptionValue({
          type: "ValueError",
          value: "Something went wrong",
          stacktrace: createStackTrace([
            frameFactories.python({ lineNo: 10, function: "main" }),
          ]),
        }),
      )
      .build();

    const output = formatEventOutput(event);

    expect(output).toMatchInlineSnapshot(`
      "### Error

      \`\`\`
      ValueError: Something went wrong
      \`\`\`

      **Stacktrace:**
      \`\`\`
        File "/app/main.py", line 10, in main
      \`\`\`

      "
    `);
  });

  it("should work with thread interface containing in-app frame", () => {
    const event = new EventBuilder("java")
      .withThread(
        createThread({
          id: 1,
          crashed: true,
          name: "main",
          stacktrace: createStackTrace([
            frameFactories.java({
              module: "java.lang.Thread",
              function: "run",
              filename: "Thread.java",
              lineNo: 748,
              inApp: false,
            }),
            createFrameWithContext(
              {
                module: "com.example.PaymentService",
                function: "processPayment",
                filename: "PaymentService.java",
                lineNo: 42,
              },
              [
                [40, "        User user = getUser(userId);"],
                [41, "        if (user == null) {"],
                [42, "            throw new UserNotFoundException(userId);"],
                [43, "        }"],
                [44, "        return user.getBalance();"],
              ],
              {
                userId: "12345",
                user: null,
              },
            ),
          ]),
        }),
      )
      .build();

    const output = formatEventOutput(event);

    expect(output).toMatchInlineSnapshot(`
      "**Thread** (main)

      **Most Relevant Frame:**
      ─────────────────────
      at com.example.PaymentService.processPayment(PaymentService.java:42)

          40 │         User user = getUser(userId);
          41 │         if (user == null) {
        → 42 │             throw new UserNotFoundException(userId);
          43 │         }
          44 │         return user.getBalance();

      Local Variables:
      ├─ userId: "12345"
      └─ user: null

      **Full Stacktrace:**
      ────────────────
      \`\`\`
      at java.lang.Thread.run(Thread.java:748)
      at com.example.PaymentService.processPayment(PaymentService.java:42)
                  throw new UserNotFoundException(userId);
      \`\`\`
      "
    `);
  });

  describe("Enhanced frame rendering variations", () => {
    it("should handle Python format with enhanced frame", () => {
      const event = createSimpleExceptionEvent(
        "python",
        "AttributeError",
        "'NoneType' object has no attribute 'balance'",
        createFrameWithContext(
          {
            filename: "/app/models/user.py",
            function: "get_balance",
            lineNo: 25,
          },
          [
            [23, "    def get_balance(self):"],
            [24, "        # This will fail if account is None"],
            [25, "        return self.account.balance"],
            [26, ""],
            [27, "    def set_balance(self, amount):"],
          ],
          {
            self: { id: 123, account: null },
          },
        ),
      );

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        AttributeError: 'NoneType' object has no attribute 'balance'
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
          File "/app/models/user.py", line 25, in get_balance

            23 │     def get_balance(self):
            24 │         # This will fail if account is None
          → 25 │         return self.account.balance
            26 │ 
            27 │     def set_balance(self, amount):

        Local Variables:
        └─ self: {"id":123,"account":null}

        **Full Stacktrace:**
        ────────────────
        \`\`\`
          File "/app/models/user.py", line 25, in get_balance
                return self.account.balance
        \`\`\`

        "
      `);
    });

    it("should handle JavaScript format with enhanced frame", () => {
      const event = createSimpleExceptionEvent(
        "javascript",
        "TypeError",
        "Cannot read property 'name' of undefined",
        createFrameWithContext(
          {
            filename: "/src/components/UserProfile.tsx",
            function: "UserProfile",
            lineNo: 15,
            colNo: 28,
          },
          [
            [
              13,
              "export const UserProfile: React.FC<Props> = ({ userId }) => {",
            ],
            [14, "  const user = useUser(userId);"],
            [15, "  const displayName = user.profile.name;"],
            [16, "  "],
            [17, "  return ("],
          ],
          {
            userId: "usr_123",
            user: undefined,
            displayName: undefined,
          },
        ),
      );

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        TypeError: Cannot read property 'name' of undefined
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
        /src/components/UserProfile.tsx:15:28 (UserProfile)

            13 │ export const UserProfile: React.FC<Props> = ({ userId }) => {
            14 │   const user = useUser(userId);
          → 15 │   const displayName = user.profile.name;
            16 │   
            17 │   return (

        Local Variables:
        ├─ userId: "usr_123"
        ├─ user: undefined
        └─ displayName: undefined

        **Full Stacktrace:**
        ────────────────
        \`\`\`
        /src/components/UserProfile.tsx:15:28 (UserProfile)
          const displayName = user.profile.name;
        \`\`\`

        "
      `);
    });

    it("should handle Ruby format with enhanced frame", () => {
      const event = new EventBuilder("ruby")
        .withException(
          createExceptionValue({
            type: "NoMethodError",
            value: "undefined method `charge' for nil:NilClass",
            stacktrace: createStackTrace([
              createFrameWithContext(
                {
                  filename: "/app/services/payment_service.rb",
                  function: "process_payment",
                  lineNo: 8,
                },
                [
                  [6, "  def process_payment(amount)"],
                  [7, "    payment_method = user.payment_method"],
                  [8, "    payment_method.charge(amount)"],
                  [9, "  rescue => e"],
                  [10, "    Rails.logger.error(e)"],
                ],
                {
                  amount: 99.99,
                  payment_method: null,
                },
              ),
            ]),
          }),
        )
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        NoMethodError: undefined method \`charge' for nil:NilClass
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
            from /app/services/payment_service.rb:8:in \`process_payment\`

             6 │   def process_payment(amount)
             7 │     payment_method = user.payment_method
          →  8 │     payment_method.charge(amount)
             9 │   rescue => e
            10 │     Rails.logger.error(e)

        Local Variables:
        ├─ amount: 99.99
        └─ payment_method: null

        **Full Stacktrace:**
        ────────────────
        \`\`\`
            from /app/services/payment_service.rb:8:in \`process_payment\`
            payment_method.charge(amount)
        \`\`\`

        "
      `);
    });

    it("should handle PHP format with enhanced frame", () => {
      const event = new EventBuilder("php")
        .withException(
          createExceptionValue({
            type: "Error",
            value: "Call to a member function getName() on null",
            stacktrace: createStackTrace([
              createFrameWithContext(
                {
                  filename: "/var/www/app/User.php",
                  function: "getDisplayName",
                  lineNo: 45,
                },
                [
                  [43, "    public function getDisplayName() {"],
                  [44, "        $profile = $this->getProfile();"],
                  [45, "        return $profile->getName();"],
                  [46, "    }"],
                ],
                {
                  profile: null,
                },
              ),
            ]),
          }),
        )
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        Error: Call to a member function getName() on null
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
        /var/www/app/User.php(45): getDisplayName()

            43 │     public function getDisplayName() {
            44 │         $profile = $this->getProfile();
          → 45 │         return $profile->getName();
            46 │     }

        Local Variables:
        └─ profile: null

        **Full Stacktrace:**
        ────────────────
        \`\`\`
        /var/www/app/User.php(45): getDisplayName()
                return $profile->getName();
        \`\`\`

        "
      `);
    });

    it("should handle frame with context but no vars", () => {
      const event = new EventBuilder("python")
        .withException(
          createExceptionValue({
            type: "ValueError",
            value: "Invalid configuration",
            stacktrace: createStackTrace([
              createFrameWithContext(
                {
                  filename: "/app/config.py",
                  function: "load_config",
                  lineNo: 12,
                },
                [
                  [10, "def load_config():"],
                  [11, "    if not os.path.exists(CONFIG_FILE):"],
                  [12, "        raise ValueError('Invalid configuration')"],
                  [13, "    with open(CONFIG_FILE) as f:"],
                  [14, "        return json.load(f)"],
                ],
              ),
            ]),
          }),
        )
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        ValueError: Invalid configuration
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
          File "/app/config.py", line 12, in load_config

            10 │ def load_config():
            11 │     if not os.path.exists(CONFIG_FILE):
          → 12 │         raise ValueError('Invalid configuration')
            13 │     with open(CONFIG_FILE) as f:
            14 │         return json.load(f)

        **Full Stacktrace:**
        ────────────────
        \`\`\`
          File "/app/config.py", line 12, in load_config
                raise ValueError('Invalid configuration')
        \`\`\`

        "
      `);
    });

    it("should handle frame with vars but no context", () => {
      const event = createSimpleExceptionEvent(
        "python",
        "TypeError",
        "unsupported operand type(s)",
        createFrame({
          filename: "/app/calculator.py",
          function: "divide",
          lineNo: 5,
          inApp: true,
          vars: {
            numerator: 10,
            denominator: "0",
            result: undefined,
          },
        }),
      );

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        TypeError: unsupported operand type(s)
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
          File "/app/calculator.py", line 5, in divide

        Local Variables:
        ├─ numerator: 10
        ├─ denominator: "0"
        └─ result: undefined

        **Full Stacktrace:**
        ────────────────
        \`\`\`
          File "/app/calculator.py", line 5, in divide
        \`\`\`

        "
      `);
    });

    it("should handle complex variable types", () => {
      const event = createSimpleExceptionEvent(
        "python",
        "KeyError",
        "'missing_key'",
        createFrame({
          filename: "/app/processor.py",
          function: "process_data",
          lineNo: 30,
          inApp: true,
          vars: {
            string_var: "hello world",
            number_var: 42,
            float_var: 3.14,
            bool_var: true,
            null_var: null,
            undefined_var: undefined,
            array_var: [1, 2, 3],
            object_var: { type: "User", id: 123 },
            nested_object: {
              user: { name: "John", age: 30 },
              settings: { theme: "dark" },
            },
            empty_string: "",
            zero: 0,
            false_bool: false,
            long_string:
              "This is a very long string that should be handled properly in the output",
          },
        }),
      );

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        KeyError: 'missing_key'
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
          File "/app/processor.py", line 30, in process_data

        Local Variables:
        ├─ string_var: "hello world"
        ├─ number_var: 42
        ├─ float_var: 3.14
        ├─ bool_var: true
        ├─ null_var: null
        ├─ undefined_var: undefined
        ├─ array_var: [1,2,3]
        ├─ object_var: {"type":"User","id":123}
        ├─ nested_object: {"user":{"name":"John","age":30},"settings":{"theme":"dark"}}
        ├─ empty_string: ""
        ├─ zero: 0
        ├─ false_bool: false
        └─ long_string: "This is a very long string that should be handled properly in the output"

        **Full Stacktrace:**
        ────────────────
        \`\`\`
          File "/app/processor.py", line 30, in process_data
        \`\`\`

        "
      `);
    });

    it("should truncate very long objects and arrays", () => {
      const event = new EventBuilder("python")
        .withException(
          createExceptionValue({
            type: "ValueError",
            value: "Data processing error",
            stacktrace: createStackTrace([
              createFrame({
                filename: "/app/processor.py",
                function: "process_batch",
                lineNo: 45,
                inApp: true,
                vars: {
                  small_array: [1, 2, 3],
                  large_array: Array(100)
                    .fill(0)
                    .map((_, i) => i),
                  small_object: { name: "test", value: 123 },
                  large_object: {
                    data: Array(50)
                      .fill(0)
                      .reduce(
                        (acc, _, i) => {
                          acc[`field${i}`] = `value${i}`;
                          return acc;
                        },
                        {} as Record<string, string>,
                      ),
                  },
                },
              }),
            ]),
          }),
        )
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        ValueError: Data processing error
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
          File "/app/processor.py", line 45, in process_batch

        Local Variables:
        ├─ small_array: [1,2,3]
        ├─ large_array: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26, ...]
        ├─ small_object: {"name":"test","value":123}
        └─ large_object: {"data":{"field0":"value0","field1":"value1","field2":"value2", ...}

        **Full Stacktrace:**
        ────────────────
        \`\`\`
          File "/app/processor.py", line 45, in process_batch
        \`\`\`

        "
      `);
    });

    it("should show proper truncation format", () => {
      const event = new EventBuilder("javascript")
        .withException(
          createExceptionValue({
            type: "Error",
            value: "Test error",
            stacktrace: createStackTrace([
              createFrame({
                filename: "/app/test.js",
                function: "test",
                lineNo: 1,
                inApp: true,
                vars: {
                  shortArray: [1, 2, 3],
                  // This will be over 80 chars when stringified
                  longArray: [
                    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
                    18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
                  ],
                  shortObject: { a: 1, b: 2 },
                  // This will be over 80 chars when stringified
                  longObject: {
                    field1: "value1",
                    field2: "value2",
                    field3: "value3",
                    field4: "value4",
                    field5: "value5",
                    field6: "value6",
                    field7: "value7",
                    field8: "value8",
                  },
                },
              }),
            ]),
          }),
        )
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        Error: Test error
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
        /app/test.js:1 (test)

        Local Variables:
        ├─ shortArray: [1,2,3]
        ├─ longArray: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27, ...]
        ├─ shortObject: {"a":1,"b":2}
        └─ longObject: {"field1":"value1","field2":"value2","field3":"value3","field4":"value4", ...}

        **Full Stacktrace:**
        ────────────────
        \`\`\`
        /app/test.js:1 (test)
        \`\`\`

        "
      `);
    });

    it("should handle circular references gracefully", () => {
      const circular: any = { name: "test" };
      circular.self = circular;

      const event = new EventBuilder("javascript")
        .withException(
          createExceptionValue({
            type: "TypeError",
            value: "Circular reference detected",
            stacktrace: createStackTrace([
              createFrame({
                filename: "/app/utils.js",
                function: "serialize",
                lineNo: 10,
                inApp: true,
                vars: {
                  normal: { a: 1, b: 2 },
                  circular: circular,
                },
              }),
            ]),
          }),
        )
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        TypeError: Circular reference detected
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
        /app/utils.js:10 (serialize)

        Local Variables:
        ├─ normal: {"a":1,"b":2}
        └─ circular: <object>

        **Full Stacktrace:**
        ────────────────
        \`\`\`
        /app/utils.js:10 (serialize)
        \`\`\`

        "
      `);
    });

    it("should handle empty vars object", () => {
      const event = createSimpleExceptionEvent(
        "python",
        "RuntimeError",
        "Something went wrong",
        createFrame({
          filename: "/app/main.py",
          function: "main",
          lineNo: 1,
          inApp: true,
          vars: {},
        }),
      );

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        RuntimeError: Something went wrong
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
          File "/app/main.py", line 1, in main

        **Full Stacktrace:**
        ────────────────
        \`\`\`
          File "/app/main.py", line 1, in main
        \`\`\`

        "
      `);
    });

    it("should handle large context with proper windowing", () => {
      const event = createSimpleExceptionEvent(
        "python",
        "IndexError",
        "list index out of range",
        createFrameWithContext(
          {
            filename: "/app/processor.py",
            function: "process_items",
            lineNo: 50,
          },
          [
            [45, "    # Setup phase"],
            [46, "    items = get_items()"],
            [47, "    results = []"],
            [48, "    "],
            [49, "    # This line causes the error"],
            [50, "    first_item = items[0]"],
            [51, "    "],
            [52, "    # Process items"],
            [53, "    for item in items:"],
            [54, "        results.append(process(item))"],
            [55, "    return results"],
          ],
          {
            items: [],
          },
        ),
      );

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        IndexError: list index out of range
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
          File "/app/processor.py", line 50, in process_items

            47 │     results = []
            48 │     
            49 │     # This line causes the error
          → 50 │     first_item = items[0]
            51 │     
            52 │     # Process items
            53 │     for item in items:

        Local Variables:
        └─ items: []

        **Full Stacktrace:**
        ────────────────
        \`\`\`
          File "/app/processor.py", line 50, in process_items
            first_item = items[0]
        \`\`\`

        "
      `);
    });

    it("should handle context at beginning of file", () => {
      const event = createSimpleExceptionEvent(
        "python",
        "ImportError",
        "No module named 'missing_module'",
        createFrameWithContext(
          {
            filename: "/app/startup.py",
            function: "<module>",
            lineNo: 2,
          },
          [
            [1, "import os"],
            [2, "import missing_module"],
            [3, "import json"],
            [4, ""],
            [5, "def main():"],
          ],
        ),
      );

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        ImportError: No module named 'missing_module'
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
          File "/app/startup.py", line 2, in <module>

            1 │ import os
          → 2 │ import missing_module
            3 │ import json
            4 │ 
            5 │ def main():

        **Full Stacktrace:**
        ────────────────
        \`\`\`
          File "/app/startup.py", line 2, in <module>
        import missing_module
        \`\`\`

        "
      `);
    });
  });

  describe("Chained exceptions", () => {
    it("should render multiple chained exceptions", () => {
      const event = new EventBuilder("python")
        .withChainedExceptions([
          createExceptionValue({
            type: "KeyError",
            value: "'user_id'",
            stacktrace: createStackTrace([
              createFrame({
                filename: "/app/database.py",
                function: "get_user",
                lineNo: 15,
                inApp: true,
              }),
            ]),
          }),
          createExceptionValue({
            type: "ValueError",
            value: "User not found",
            stacktrace: createStackTrace([
              createFrame({
                filename: "/app/services.py",
                function: "process_user",
                lineNo: 25,
                inApp: true,
              }),
            ]),
          }),
          createExceptionValue({
            type: "HTTPError",
            value: "500 Internal Server Error",
            stacktrace: createStackTrace([
              createFrame({
                filename: "/app/handlers.py",
                function: "handle_request",
                lineNo: 42,
                inApp: true,
              }),
            ]),
          }),
        ])
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        HTTPError: 500 Internal Server Error
        \`\`\`

        **Stacktrace:**
        \`\`\`
          File "/app/handlers.py", line 42, in handle_request
        \`\`\`

        **During handling of the above exception, another exception occurred:**

        ### ValueError: User not found

        **Stacktrace:**
        \`\`\`
          File "/app/services.py", line 25, in process_user
        \`\`\`

        **During handling of the above exception, another exception occurred:**

        ### KeyError: 'user_id'

        **Stacktrace:**
        \`\`\`
          File "/app/database.py", line 15, in get_user
        \`\`\`

        "
      `);
    });

    it("should render chained exceptions with enhanced frame on outermost exception", () => {
      const event = new EventBuilder("python")
        .withChainedExceptions([
          createExceptionValue({
            type: "KeyError",
            value: "'user_id'",
            stacktrace: createStackTrace([
              createFrameWithContext(
                {
                  filename: "/app/database.py",
                  function: "get_user",
                  lineNo: 15,
                  inApp: true,
                },
                [
                  [13, "def get_user(data):"],
                  [14, "    # This will fail if user_id is missing"],
                  [15, "    user_id = data['user_id']"],
                  [16, "    return db.find_user(user_id)"],
                ],
                {
                  data: {},
                },
              ),
            ]),
          }),
          createExceptionValue({
            type: "ValueError",
            value: "User not found",
            stacktrace: createStackTrace([
              createFrameWithContext(
                {
                  filename: "/app/services.py",
                  function: "process_user",
                  lineNo: 25,
                  inApp: true,
                },
                [
                  [23, "    try:"],
                  [24, "        user = get_user(request_data)"],
                  [25, "    except KeyError:"],
                  [26, "        raise ValueError('User not found')"],
                ],
                {
                  request_data: {},
                },
              ),
            ]),
          }),
        ])
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        ValueError: User not found
        \`\`\`

        **Most Relevant Frame:**
        ─────────────────────
          File "/app/services.py", line 25, in process_user

            23 │     try:
            24 │         user = get_user(request_data)
          → 25 │     except KeyError:
            26 │         raise ValueError('User not found')

        Local Variables:
        └─ request_data: {}

        **Full Stacktrace:**
        ────────────────
        \`\`\`
          File "/app/services.py", line 25, in process_user
            except KeyError:
        \`\`\`

        **During handling of the above exception, another exception occurred:**

        ### KeyError: 'user_id'

        **Stacktrace:**
        \`\`\`
          File "/app/database.py", line 15, in get_user
            user_id = data['user_id']
        \`\`\`

        "
      `);
    });

    it("should handle single exception in values array (not chained)", () => {
      const event = new EventBuilder("python")
        .withChainedExceptions([
          createExceptionValue({
            type: "RuntimeError",
            value: "Something went wrong",
            stacktrace: createStackTrace([
              createFrame({
                filename: "/app/main.py",
                function: "main",
                lineNo: 10,
                inApp: true,
              }),
            ]),
          }),
        ])
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        RuntimeError: Something went wrong
        \`\`\`

        **Stacktrace:**
        \`\`\`
          File "/app/main.py", line 10, in main
        \`\`\`

        "
      `);
    });

    it("should use Java-style 'Caused by' for Java platform", () => {
      const event = new EventBuilder("java")
        .withChainedExceptions([
          createExceptionValue({
            type: "SQLException",
            value: "Database connection failed",
            stacktrace: createStackTrace([
              frameFactories.java({
                module: "com.example.db.DatabaseConnector",
                function: "connect",
                filename: "DatabaseConnector.java",
                lineNo: 45,
              }),
            ]),
          }),
          createExceptionValue({
            type: "RuntimeException",
            value: "Failed to initialize service",
            stacktrace: createStackTrace([
              frameFactories.java({
                module: "com.example.service.UserService",
                function: "initialize",
                filename: "UserService.java",
                lineNo: 23,
              }),
            ]),
          }),
        ])
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        RuntimeException: Failed to initialize service
        \`\`\`

        **Stacktrace:**
        \`\`\`
        at com.example.service.UserService.initialize(UserService.java:23)
        \`\`\`

        **Caused by:**

        ### SQLException: Database connection failed

        **Stacktrace:**
        \`\`\`
        at com.example.db.DatabaseConnector.connect(DatabaseConnector.java:45)
        \`\`\`

        "
      `);
    });

    it("should use C#-style arrow notation for dotnet platform", () => {
      const event = new EventBuilder("csharp")
        .withChainedExceptions([
          createExceptionValue({
            type: "ArgumentNullException",
            value: "Value cannot be null. (Parameter 'userId')",
            stacktrace: createStackTrace([
              createFrame({
                filename: "UserRepository.cs",
                function: "GetUserById",
                lineNo: 15,
                inApp: true,
              }),
            ]),
          }),
          createExceptionValue({
            type: "ApplicationException",
            value: "Failed to load user profile",
            stacktrace: createStackTrace([
              createFrame({
                filename: "UserService.cs",
                function: "LoadProfile",
                lineNo: 42,
                inApp: true,
              }),
            ]),
          }),
        ])
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        ApplicationException: Failed to load user profile
        \`\`\`

        **Stacktrace:**
        \`\`\`
            at LoadProfile (UserService.cs:42)
        \`\`\`

        **---> Inner Exception:**

        ### ArgumentNullException: Value cannot be null. (Parameter 'userId')

        **Stacktrace:**
        \`\`\`
            at GetUserById (UserRepository.cs:15)
        \`\`\`

        "
      `);
    });

    it("should handle child exception without stacktrace", () => {
      const event = new EventBuilder("python")
        .withChainedExceptions([
          createExceptionValue({
            type: "KeyError",
            value: "'missing_key'",
            // No stacktrace for child exception
            stacktrace: undefined,
          }),
          createExceptionValue({
            type: "ValueError",
            value: "Data processing failed",
            stacktrace: createStackTrace([
              createFrame({
                filename: "/app/processor.py",
                function: "process_data",
                lineNo: 42,
                inApp: true,
              }),
            ]),
          }),
        ])
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "### Error

        \`\`\`
        ValueError: Data processing failed
        \`\`\`

        **Stacktrace:**
        \`\`\`
          File "/app/processor.py", line 42, in process_data
        \`\`\`

        **During handling of the above exception, another exception occurred:**

        ### KeyError: 'missing_key'

        **Stacktrace:**
        \`\`\`
        No stacktrace available
        \`\`\`

        "
      `);
    });
  });

  describe("Performance issue formatting", () => {
    it("should format N+1 query issue with evidence data", () => {
      const event = new EventBuilder("python")
        .withType("transaction")
        .withOccurrence({
          issueTitle: "N+1 Query",
          culprit: "SELECT * FROM users WHERE id = %s",
          type: 1006, // Performance issue type code
          issueType: "performance_n_plus_one_db_queries",
          evidenceData: {
            parentSpanIds: ["span_123"],
            parentSpan: "GET /api/users",
            repeatingSpansCompact: ["SELECT * FROM users WHERE id = %s"],
            numberRepeatingSpans: "5",
            offenderSpanIds: [
              "span_456",
              "span_457",
              "span_458",
              "span_459",
              "span_460",
            ],
            transactionName: "/api/users",
            op: "db",
          },
          evidenceDisplay: [
            {
              name: "Offending Spans",
              value: "UserService.get_users",
              important: true,
            },
          ],
        })
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "**Parent Operation:**
        GET /api/users

        ### Repeated Database Queries

        **Query executed 5 times:**
        \`\`\`sql
        SELECT * FROM users WHERE id = %s
        \`\`\`

        **Transaction:**
        /api/users

        **Offending Spans:**
        UserService.get_users

        "
      `);
    });

    it("should format N+1 query issue with spans data fallback", () => {
      const event = new EventBuilder("python")
        .withType("transaction")
        .withOccurrence({
          issueTitle: "N+1 Query detected",
          culprit: "database query",
        })
        .withEntry({
          type: "spans",
          data: [
            {
              op: "db.query",
              description: "SELECT * FROM posts WHERE user_id = 1",
              timestamp: 100.5,
              start_timestamp: 100.0,
            },
            {
              op: "db.query",
              description: "SELECT * FROM posts WHERE user_id = 2",
              timestamp: 101.0,
              start_timestamp: 100.5,
            },
            {
              op: "db.query",
              description: "SELECT * FROM posts WHERE user_id = 3",
              timestamp: 101.5,
              start_timestamp: 101.0,
            },
            {
              op: "http.client",
              description: "GET /api/external",
              timestamp: 102.0,
              start_timestamp: 101.5,
            },
          ],
        })
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`""`);
    });

    it("should format transaction event with non-repeated database queries", () => {
      const event = new EventBuilder("python")
        .withType("transaction")
        .withOccurrence({
          issueTitle: "Slow DB Query",
          culprit: "database",
        })
        .withEntry({
          type: "spans",
          data: [
            {
              op: "db.query",
              description: "SELECT COUNT(*) FROM users",
              timestamp: 100.5,
              start_timestamp: 100.0,
            },
            {
              op: "db.query",
              description: "SELECT * FROM settings WHERE key = 'theme'",
              timestamp: 101.0,
              start_timestamp: 100.5,
            },
          ],
        })
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`""`);
    });

    it("should format evidence with operation and offenderSpanIds", () => {
      const event = new EventBuilder("python")
        .withType("transaction")
        .withOccurrence({
          issueTitle: "N+1 Query",
          culprit: "database",
          issueType: "performance_n_plus_one_db_queries",
          evidenceData: {
            op: "db",
            offenderSpanIds: ["span_1", "span_2", "span_3", "span_4", "span_5"],
            numberRepeatingSpans: "5",
          },
        })
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`""`);
    });

    it("should render span tree for N+1 queries with evidence and spans data", () => {
      const event = new EventBuilder("python")
        .withType("transaction")
        .withOccurrence({
          issueTitle: "N+1 Query",
          culprit: "SELECT * FROM users WHERE id = %s",
          issueType: "performance_n_plus_one_db_queries",
          evidenceData: {
            parentSpanIds: ["parent123"],
            parentSpan: "GET /api/users",
            offenderSpanIds: ["span1", "span2", "span3"],
            repeatingSpansCompact: ["SELECT * FROM users WHERE id = %s"],
            numberRepeatingSpans: "3",
            op: "db",
          },
        })
        .withEntry({
          type: "spans",
          data: [
            {
              span_id: "parent123",
              op: "http.server",
              description: "GET /users",
              timestamp: 1722963600.25,
              start_timestamp: 1722963600.0,
            },
            {
              span_id: "span1",
              op: "db.query",
              description: "SELECT * FROM users WHERE id = 1",
              timestamp: 1722963600.013,
              start_timestamp: 1722963600.01,
            },
            {
              span_id: "span2",
              op: "db.query",
              description: "SELECT * FROM users WHERE id = 2",
              timestamp: 1722963600.018,
              start_timestamp: 1722963600.014,
            },
            {
              span_id: "span3",
              op: "db.query",
              description: "SELECT * FROM users WHERE id = 3",
              timestamp: 1722963600.027,
              start_timestamp: 1722963600.019,
            },
          ],
        })
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "**Parent Operation:**
        GET /api/users

        ### Repeated Database Queries

        **Query executed 3 times:**
        \`\`\`sql
        SELECT * FROM users WHERE id = %s
        \`\`\`

        ### Span Tree (Limited to 10 spans)

        \`\`\`
        GET /users [http.server · 250ms · parent123]
           ├─ SELECT * FROM users WHERE id = 1 [db.query · 3ms · span1] [N+1]
           ├─ SELECT * FROM users WHERE id = 2 [db.query · 4ms · span2] [N+1]
           └─ SELECT * FROM users WHERE id = 3 [db.query · 8ms · span3] [N+1]
        \`\`\`

        "
      `);
    });

    it("should render span tree using duration fields when timestamps are missing", () => {
      const event = new EventBuilder("python")
        .withType("transaction")
        .withOccurrence({
          issueTitle: "N+1 Query",
          issueType: "performance_n_plus_one_db_queries",
          evidenceData: {
            parentSpanIds: ["parentDur"],
            parentSpan: "GET /api/durations",
            offenderSpanIds: ["spanA", "spanB"],
            repeatingSpansCompact: [
              "SELECT * FROM durations WHERE bucket = %s",
            ],
            numberRepeatingSpans: "2",
          },
        })
        .withEntry({
          type: "spans",
          data: [
            {
              span_id: "parentDur",
              op: "http.server",
              description: "GET /durations",
              duration: 1250,
            },
            {
              span_id: "spanA",
              op: "db.query",
              description: "SELECT * FROM durations WHERE bucket = 'fast'",
              duration: 0.5,
            },
            {
              span_id: "spanB",
              op: "db.query",
              description: "SELECT * FROM durations WHERE bucket = 'slow'",
              duration: 1500,
            },
          ],
        })
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "**Parent Operation:**
        GET /api/durations

        ### Repeated Database Queries

        **Query executed 2 times:**
        \`\`\`sql
        SELECT * FROM durations WHERE bucket = %s
        \`\`\`

        ### Span Tree (Limited to 10 spans)

        \`\`\`
        GET /durations [http.server · 1250ms · parentDur]
           ├─ SELECT * FROM durations WHERE bucket = 'fast' [db.query · 1ms · spanA] [N+1]
           └─ SELECT * FROM durations WHERE bucket = 'slow' [db.query · 1500ms · spanB] [N+1]
        \`\`\`

        "
      `);
    });

    it("should handle transaction event without performance data", () => {
      const event = new EventBuilder("python")
        .withType("transaction")
        .withOccurrence({
          issueTitle: "Generic Performance Issue",
          culprit: "slow endpoint",
        })
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`""`);
    });

    it("should handle evidence data without repeating_spans", () => {
      const event = new EventBuilder("python")
        .withType("transaction")
        .withOccurrence({
          issueTitle: "Performance Issue",
          culprit: "database",
          issueType: "performance_slow_db_query", // A different type that we don't fully handle yet
          evidenceData: {
            parentSpan: "GET /api/data",
            transactionName: "/api/data",
          },
          evidenceDisplay: [
            {
              name: "Source Location",
              value: "DataService.fetch",
              important: true,
            },
          ],
        })
        .build();

      const output = formatEventOutput(event);

      expect(output).toMatchInlineSnapshot(`
        "**Parent Operation:**
        GET /api/data

        **Transaction:**
        /api/data

        **Source Location:**
        DataService.fetch

        "
      `);
    });
  });
});

/**
 * Mirrors a real metric issue event from `GET /issues/{id}/events/{id}/`: the
 * event serializer camelCases the occurrence payload, including nested
 * workflow-engine evidence and the serialized data source.
 */
function createMetricIssueEvent({
  evidenceData,
  dateCreated = "2026-10-28T11:39:52.000Z",
}: {
  evidenceData: Record<string, unknown>;
  dateCreated?: string;
}): Event {
  return {
    id: "4d6e1b607c564714a7de102a835fae54",
    type: "generic",
    title: "Error logs above 4000 over past 1 hour",
    message: null,
    platform: "python",
    dateCreated,
    entries: [],
    tags: [
      { key: "interface_type", value: "contexts" },
      { key: "level", value: "error" },
    ],
    contexts: {
      trace: {
        trace_id: "bfa06a9c589f4d4f89236378d2194adc",
        span_id: "bfa06a9c589f4d4f",
        status: "unknown",
        type: "trace",
      },
    },
    occurrence: {
      id: "occ-1",
      projectId: 1,
      eventId: "4d6e1b607c564714a7de102a835fae54",
      fingerprint: ["abc"],
      issueTitle: "Error logs above 4000 over past 1 hour",
      subtitle: "Critical: Number of error logs in the last hour above 4000",
      type: 8001,
      culprit: "",
      evidenceData,
      evidenceDisplay: [],
    },
  } as unknown as Event;
}

function createLogsMonitorEvidence(
  snubaQuery: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    value: 4988,
    detectorId: 1234567,
    dataPacketSourceId: "998877",
    conditions: [{ id: 1, type: "gt", comparison: 4000, conditionResult: 75 }],
    config: { detectionType: "static", thresholdPeriod: 1 },
    dataSources: [
      {
        id: "55",
        organizationId: "1",
        type: "snuba_query_subscription",
        sourceId: "998877",
        queryObj: {
          id: "998877",
          status: 0,
          subscription: "sub-1",
          snubaQuery: {
            id: "77",
            dataset: "events_analytics_platform",
            query: "severity:error",
            aggregate: "count(message)",
            timeWindow: 3600,
            environment: "prod",
            eventTypes: ["trace_item_log"],
            extrapolationMode: "unknown",
            ...snubaQuery,
          },
        },
      },
    ],
  };
}

describe("formatEventOutput metric alert details", () => {
  it("includes monitor query context from camelCased evidence", () => {
    const output = formatEventOutput(
      createMetricIssueEvent({ evidenceData: createLogsMonitorEvidence() }),
    );

    expect(output).toMatchInlineSnapshot(`
      "### Metric Alert Details

      **Monitor ID**: 1234567
      **Dataset**: Logs
      **Aggregate**: count(message)
      **Query**: \`severity:error\`
      **Interval**: 3600 second(s)
      **Environment**: prod
      **Evaluated Window**: 2026-10-28T10:39:52.000Z to 2026-10-28T11:39:52.000Z
      **Evaluated Value**: 4988
      **Threshold**: above 4000

      ### Tags

      **interface_type**: contexts
      **level**: error

      ### Additional Context

      These are additional context provided by the user when they're instrumenting their application.

      **trace**
      trace_id: "bfa06a9c589f4d4f89236378d2194adc"
      span_id: "bfa06a9c589f4d4f"
      status: "unknown"

      "
    `);
  });

  it("labels errors and spans datasets and keeps unknown datasets verbatim", () => {
    const datasetLabel = (snubaQuery: Record<string, unknown>) =>
      formatEventOutput(
        createMetricIssueEvent({
          evidenceData: createLogsMonitorEvidence(snubaQuery),
        }),
      ).match(/\*\*Dataset\*\*: (.+)/)?.[1];

    expect(datasetLabel({ dataset: "events", eventTypes: ["error"] })).toBe(
      "Errors",
    );
    expect(datasetLabel({ eventTypes: ["trace_item_span"] })).toBe("Spans");
    expect(datasetLabel({ eventTypes: ["trace_item_metric"] })).toBe(
      "Application metrics",
    );
    expect(
      datasetLabel({ dataset: "transactions", eventTypes: ["transaction"] }),
    ).toBe("transactions");
  });

  it("keeps performance regression formatting for regression evidence", () => {
    const event = {
      id: "regression-event-1",
      type: "generic",
      title: "Endpoint Regression",
      message: null,
      platform: "python",
      dateCreated: "2025-11-18T06:01:20.000Z",
      entries: [],
      occurrence: {
        id: "occ-2",
        projectId: 1,
        eventId: "regression-event-1",
        fingerprint: ["def"],
        issueTitle: "Endpoint Regression",
        type: 1018,
        culprit: "POST /oauth/token",
        evidenceData: {
          change: "regression",
          transaction: "POST /oauth/token",
        },
        evidenceDisplay: [
          {
            name: "Regression",
            value:
              "POST /oauth/token duration increased from 909.77ms to 1711.36ms (P95)",
            important: true,
          },
        ],
      },
    } as Event;

    const output = formatEventOutput(event);

    expect(output).toContain("### Performance Regression Details");
    expect(output).not.toContain("### Metric Alert Details");
    expect(output).toContain("POST /oauth/token duration increased");
  });

  it("formats below-threshold conditions and omits an empty environment", () => {
    const evidenceData = createLogsMonitorEvidence({ environment: null });
    evidenceData.conditions = [{ type: "lt", comparison: 10 }];

    const output = formatEventOutput(createMetricIssueEvent({ evidenceData }));

    expect(output).toContain("**Threshold**: below 10");
    expect(output).not.toContain("**Environment**:");
  });

  it("renders value, threshold and legacy alert rule ID without data sources", () => {
    const output = formatEventOutput(
      createMetricIssueEvent({
        evidenceData: {
          value: 42,
          alertId: 7,
          conditions: [
            { type: "gte", comparison: 40 },
            { type: "lte", comparison: 50 },
          ],
        },
      }),
    );

    expect(output).toContain("**Evaluated Value**: 42");
    expect(output).toContain("**Alert Rule ID**: 7");
    expect(output).toContain("**Threshold**: at or above 40, at or below 50");
    expect(output).not.toContain("**Dataset**:");
    expect(output).not.toContain("**Evaluated Window**:");
  });

  it("formats dynamic alert values without object placeholders", () => {
    const evidenceData = createLogsMonitorEvidence();
    evidenceData.value = {
      value: 12.5,
      source_id: "123",
      timestamp: 1780272000,
    };
    evidenceData.conditions = [
      {
        type: "anomaly_detection",
        comparison: {
          sensitivity: "medium",
          seasonality: "auto",
          thresholdType: 0,
        },
      },
    ];

    const output = formatEventOutput(createMetricIssueEvent({ evidenceData }));

    expect(output).toContain("**Evaluated Value**: 12.5");
    expect(output).not.toContain("[object Object]");
    expect(output).not.toContain("**Threshold**:");
  });
});

describe("formatIssueOutput metric issue response notes", () => {
  const metricIssue = {
    id: "7001",
    shortId: "SEER-A18",
    title: "Error logs above 4000 over past 1 hour",
    count: "2",
    userCount: 0,
    status: "resolved",
    issueType: "metric_issue",
    issueCategory: "metric",
    project: { name: "seer", slug: "seer" },
  } as Issue;
  const apiService = {
    getIssueUrl: () => "https://sentry.sentry.io/issues/SEER-A18",
  } as unknown as SentryApiService;

  function responseNotes(evidenceData: Record<string, unknown>): string {
    const output = formatIssueOutput({
      organizationSlug: "sentry",
      issue: metricIssue,
      event: createMetricIssueEvent({ evidenceData }),
      apiService,
    });
    return output.slice(output.indexOf("## Response Notes"));
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-29T02:30:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("points at the monitor and the data that breached it", () => {
    expect(responseNotes(createLogsMonitorEvidence())).toMatchInlineSnapshot(`
      "## Response Notes

      - Commit message issue reference: \`Fixes SEER-A18\` automatically closes the issue when the commit is merged.
      - Metric Monitor configuration and connected Alerts: Use the Sentry tool \`get_metric_monitor_details(organizationSlug='sentry', monitorId='1234567')\`
      - Logs matched by the monitor query: Use the Sentry tool \`search_logs(organizationSlug='sentry', projectSlug='seer', query='severity:error environment:prod', period='16h')\`, then focus on 2026-10-28T10:39:52.000Z to 2026-10-28T11:39:52.000Z
      - Issue event search: Use the Sentry tool \`search_issue_events\`
      "
    `);
  });

  it("uses the dataset-specific search tool", () => {
    expect(
      responseNotes(
        createLogsMonitorEvidence({
          dataset: "events",
          query: "",
          environment: "my env",
          eventTypes: ["error", "default"],
        }),
      ),
    ).toContain(
      "Use the Sentry tool `search_errors(organizationSlug='sentry', projectSlug='seer', query='environment:\"my env\"', period='16h')`",
    );
    expect(
      responseNotes(
        createLogsMonitorEvidence({ eventTypes: ["trace_item_span"] }),
      ),
    ).toContain(
      "Spans matched by the monitor query: Use the Sentry tool `search_traces(",
    );
  });

  it("omits the search call when the dataset has no matching search tool", () => {
    const notes = responseNotes(
      createLogsMonitorEvidence({
        dataset: "metrics",
        eventTypes: [],
      }),
    );

    expect(notes).toContain("get_metric_monitor_details(");
    expect(notes).not.toContain("matched by the monitor query");
  });

  it("drops stacktrace and evaluation trace hints", () => {
    const notes = responseNotes(createLogsMonitorEvidence());

    expect(notes).not.toContain("stacktrace");
    expect(notes).not.toContain("trace:bfa06a9c589f4d4f89236378d2194adc");
  });
});
