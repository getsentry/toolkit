import { describe, it, expect, vi } from "vitest";
import { UserInputError } from "../../errors";
import getDoc from "./get-doc.js";

describe("get_doc", () => {
  it("returns document content", async () => {
    const result = await getDoc.handler(
      {
        path: "/product/rate-limiting.md",
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
        mcpUrl: "https://mcp.sentry.dev",
      },
    );
    expect(result).toMatchInlineSnapshot(`
      "# Documentation Content

      **Path**: /product/rate-limiting.md

      ---

      # Project Rate Limits and Quotas

      Rate limiting allows you to control the volume of events that Sentry accepts from your applications. This helps you manage costs and ensures that a sudden spike in errors doesn't consume your entire quota.

      ## Why Use Rate Limiting?

      - **Cost Control**: Prevent unexpected charges from error spikes
      - **Noise Reduction**: Filter out repetitive or low-value events
      - **Resource Management**: Ensure critical projects have quota available
      - **Performance**: Reduce load on your Sentry organization

      ## Types of Rate Limits

      ### 1. Organization Rate Limits

      Set a maximum number of events per hour across your entire organization:

      \`\`\`python
      # In your organization settings
      rate_limit = 1000  # events per hour
      \`\`\`

      ### 2. Project Rate Limits

      Configure limits for specific projects:

      \`\`\`javascript
      // Project settings
      {
        "rateLimit": {
          "window": 3600,  // 1 hour in seconds
          "limit": 500     // max events
        }
      }
      \`\`\`

      ### 3. Key-Based Rate Limiting

      Rate limit by specific attributes:

      - **By Release**: Limit events from specific releases
      - **By User**: Prevent single users from consuming quota
      - **By Transaction**: Control high-volume transactions

      ## Configuration Examples

      ### SDK Configuration

      Configure client-side sampling to reduce events before they're sent:

      \`\`\`javascript
      Sentry.init({
        dsn: "your-dsn",
        tracesSampleRate: 0.1,  // Sample 10% of transactions
        beforeSend(event) {
          // Custom filtering logic
          if (event.exception?.values?.[0]?.value?.includes("NetworkError")) {
            return null;  // Drop network errors
          }
          return event;
        }
      });
      \`\`\`

      ### Inbound Filters

      Use Sentry's inbound filters to drop events server-side:

      1. Go to **Project Settings** → **Inbound Filters**
      2. Enable filters for:
         - Legacy browsers
         - Web crawlers
         - Specific error messages
         - IP addresses

      ### Spike Protection

      Enable spike protection to automatically limit events during traffic spikes:

      \`\`\`python
      # Project settings
      spike_protection = {
        "enabled": True,
        "max_events_per_hour": 10000,
        "detection_window": 300  # 5 minutes
      }
      \`\`\`

      ## Best Practices

      1. **Start Conservative**: Begin with lower limits and increase as needed
      2. **Monitor Usage**: Regularly review your quota consumption
      3. **Use Sampling**: Implement transaction sampling for high-volume apps
      4. **Filter Noise**: Drop known low-value events at the SDK level
      5. **Set Alerts**: Configure notifications for quota thresholds

      ## Rate Limit Headers

      Sentry returns rate limit information in response headers:

      \`\`\`
      X-Sentry-Rate-Limit: 60
      X-Sentry-Rate-Limit-Remaining: 42
      X-Sentry-Rate-Limit-Reset: 1634567890
      \`\`\`

      ## Quota Management

      ### Viewing Quota Usage

      1. Navigate to **Settings** → **Subscription**
      2. View usage by:
         - Project
         - Event type
         - Time period

      ### On-Demand Budgets

      Purchase additional events when approaching limits:

      \`\`\`bash
      # Via API
      curl -X POST https://sentry.io/api/0/organizations/{org}/quotas/ \\
        -H 'Authorization: Bearer <token>' \\
        -d '{"events": 100000}'
      \`\`\`

      ## Troubleshooting

      ### Events Being Dropped?

      Check:
      1. Organization and project rate limits
      2. Spike protection status
      3. SDK sampling configuration
      4. Inbound filter settings

      ### Rate Limit Errors

      If you see 429 errors:
      - Review your rate limit configuration
      - Implement exponential backoff
      - Consider event buffering

      ## Related Documentation

      - [SDK Configuration Guide](/platforms/javascript/configuration)
      - [Quotas and Billing](/product/quotas)
      - [Filtering Events](/product/data-management/filtering)

      ---

      ## Using this documentation

      - This is the raw markdown content from Sentry's documentation
      - Code examples and configuration snippets can be copied directly
      - Links in the documentation are relative to https://docs.sentry.io
      - For more related topics, use \`search_docs()\` to find additional pages
      "
    `);
  });

  it("handles invalid path format", async () => {
    await expect(
      getDoc.handler(
        {
          path: "/product/rate-limiting", // Missing .md extension
        },
        {
          constraints: {
            organizationSlug: null,
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow(
      "Invalid documentation path. Path must end with .md extension.",
    );
  });

  it("rejects a missing page", async () => {
    await expect(
      getDoc.handler(
        {
          path: "/product/does-not-exist.md",
        },
        {
          constraints: {
            organizationSlug: null,
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow(UserInputError);
  });

  it("rejects the docs site's soft 404 page", async () => {
    await expect(
      getDoc.handler(
        {
          path: "ai/mcp.md",
        },
        {
          constraints: {
            organizationSlug: null,
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow(
      new UserInputError(
        "Documentation not found at this path. The page may have been moved or removed. Use `search_docs()` to find the current path, and pass the `path` from its results exactly.",
      ),
    );
  });

  it("handles API errors", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);

    await expect(
      getDoc.handler(
        {
          path: "/product/test.md",
        },
        {
          constraints: {
            organizationSlug: null,
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow();
  });

  it("validates domain whitelist", async () => {
    // Test with absolute URL that would resolve to a different domain
    await expect(
      getDoc.handler(
        {
          path: "https://malicious.com/test.md",
        },
        {
          constraints: {
            organizationSlug: null,
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow(
      "Invalid domain. Documentation can only be fetched from allowed domains: docs.sentry.io, develop.sentry.io",
    );
  });

  it("handles timeout errors", async () => {
    // Mock fetch to simulate a timeout by throwing an AbortError
    vi.spyOn(global, "fetch").mockImplementationOnce(() => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    });

    await expect(
      getDoc.handler(
        {
          path: "/product/test.md",
        },
        {
          constraints: {
            organizationSlug: null,
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow("Request timeout after 15000ms");
  });
});
