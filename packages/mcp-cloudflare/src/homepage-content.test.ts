import { describe, expect, it } from "vitest";
import {
  PUBLIC_HOMEPAGE_BASE_URL,
  generateHomepageFallbackHtml,
  generateHomepageMarkdown,
} from "./homepage-content";

describe("homepage-content", () => {
  describe("generateHomepageMarkdown", () => {
    it("includes base URL endpoints and setup instructions", () => {
      const text = generateHomepageMarkdown("https://mcp.sentry.dev");

      expect(text).toContain("# Sentry MCP Server");
      expect(text).toContain("https://mcp.sentry.dev/mcp");
      expect(text).toContain("{organizationSlug}");
      expect(text).toContain("{projectSlug}");
      expect(text).toContain("claude mcp add");
      expect(text).toContain("?experimental=1");
    });
  });

  describe("generateHomepageFallbackHtml", () => {
    it("renders the markdown content as HTML for no-JS clients", () => {
      const html = generateHomepageFallbackHtml(PUBLIC_HOMEPAGE_BASE_URL);

      expect(html).toContain('<main id="static-home"');
      expect(html).toContain('class="static-home"');
      expect(html).toContain("<h1>Sentry MCP Server</h1>");
      expect(html).toContain("<h2>Connecting</h2>");
      expect(html).toContain("<code>https://mcp.sentry.dev/mcp</code>");
      expect(html).toContain("<h3>Claude Code</h3>");
      expect(html).toContain(
        "claude mcp add --transport http sentry https://mcp.sentry.dev/mcp/{organizationSlug}/{projectSlug}",
      );
      expect(html).toContain('href="/llms.txt"');
      // Ensure markdown special chars were escaped outside intentional tags.
      expect(html).not.toContain("<script>");
    });

    it("escapes HTML in generated content", () => {
      const html = generateHomepageFallbackHtml(
        'https://example.com/"onload="',
      );
      expect(html).toContain("&quot;");
      expect(html).not.toContain('onload="');
    });
  });
});
