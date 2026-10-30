import { beforeEach, describe, expect, it, vi } from "vitest";
import { signState } from "../oauth/state";
import {
  getRememberedSkillsForClient,
  parseRedirectApproval,
  renderApprovalDialog,
  SKILL_PREFERENCES_COOKIE_NAME,
} from "./approval-dialog";

function skillInputAttributes(html: string, skillId: string): string {
  const match = html.match(
    new RegExp(
      `<input type="checkbox" name="skill" value="${skillId}"([^>]*)>`,
    ),
  );
  expect(match, `Missing skill checkbox: ${skillId}`).not.toBeNull();
  return match![1];
}

function expectSkillChecked(html: string, skillId: string): void {
  expect(skillInputAttributes(html, skillId)).toContain("checked");
}

function expectSkillUnchecked(html: string, skillId: string): void {
  expect(skillInputAttributes(html, skillId)).not.toContain("checked");
}

function extractCookiePair(setCookie: string, cookieName: string): string {
  const marker = `${cookieName}=`;
  const start = setCookie.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = setCookie.slice(start);
  const end = rest.indexOf(";");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("approval-dialog", () => {
  const TEST_SECRET = "test-cookie-secret-32-chars-long";

  const mockClient = {
    clientId: "test-client-id",
    clientName: "Test Client",
    redirectUris: ["https://example.com/callback"],
    tokenEndpointAuthMethod: "client_secret_basic",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("renderApprovalDialog", () => {
    it("renders the consent form with signed state and a cancel decision", async () => {
      const mockRequest = new Request("https://example.com/oauth/authorize", {
        method: "GET",
      });

      const response = await renderApprovalDialog(mockRequest, {
        client: mockClient,
        server: { name: "Test Server" },
        state: { oauthReqInfo: { clientId: "test-client" } },
        cookieSecret: TEST_SECRET,
      });
      const html = await response.text();

      // Check that state is included in the form
      expect(html).toContain('name="state"');
      expect(html).toContain('value="');
      const approveIndex = html.indexOf('name="decision" value="approve"');
      const denyIndex = html.indexOf('name="decision" value="deny"');
      expect(approveIndex).toBeGreaterThan(-1);
      expect(denyIndex).toBeGreaterThan(approveIndex);
      expect(html).not.toContain("history.back");
    });

    it("leaves API Write unchecked for new approvals and explains its independent authority", async () => {
      const response = await renderApprovalDialog(
        new Request("https://example.com/oauth/authorize"),
        {
          client: mockClient,
          server: { name: "Test Server" },
          state: { oauthReqInfo: { clientId: "test-client" } },
          cookieSecret: TEST_SECRET,
        },
      );
      const html = await response.text();

      expectSkillChecked(html, "inspect");
      expectSkillChecked(html, "seer");
      expectSkillChecked(html, "triage");
      expectSkillChecked(html, "project-management");
      expectSkillChecked(html, "api-read");
      expectSkillUnchecked(html, "api-write");
      expect(html).toContain('id="skill-name-api-write">API Write</span>');
      expect(skillInputAttributes(html, "api-write")).toContain(
        'aria-describedby="skill-description-api-write api-write-help"',
      );
      expect(html).toContain(
        "API Write allows issue changes even when <b>Triage Issues</b> is unchecked.",
      );
      expect(html).toContain(
        "It also allows project and team changes when <b>Manage Projects &amp; Teams</b> is unchecked.",
      );
    });

    it("preserves an explicit remembered API Write selection without selecting Triage", async () => {
      const response = await renderApprovalDialog(
        new Request("https://example.com/oauth/authorize"),
        {
          client: mockClient,
          server: { name: "Test Server" },
          state: { oauthReqInfo: { clientId: "test-client" } },
          cookieSecret: TEST_SECRET,
          defaultSkills: ["api-write"],
        },
      );
      const html = await response.text();

      expectSkillChecked(html, "api-write");
      expectSkillUnchecked(html, "triage");
      expectSkillUnchecked(html, "project-management");
      expect(html).toContain("Includes API Read.");
    });

    it("uses remembered skill defaults when provided", async () => {
      const response = await renderApprovalDialog(
        new Request("https://example.com/oauth/authorize"),
        {
          client: mockClient,
          server: { name: "Test Server" },
          state: { oauthReqInfo: { clientId: "test-client" } },
          cookieSecret: TEST_SECRET,
          defaultSkills: ["triage", "project-management"],
        },
      );
      const html = await response.text();

      expectSkillUnchecked(html, "inspect");
      expectSkillUnchecked(html, "seer");
      expectSkillChecked(html, "triage");
      expectSkillChecked(html, "project-management");
      expect(html).toContain('value="api-read"');
      expect(html).toContain('value="api-write"');
      expectSkillUnchecked(html, "api-read");
      expectSkillUnchecked(html, "api-write");
    });

    it("ignores unknown and deprecated remembered skill defaults", async () => {
      const response = await renderApprovalDialog(
        new Request("https://example.com/oauth/authorize"),
        {
          client: mockClient,
          server: { name: "Test Server" },
          state: { oauthReqInfo: { clientId: "test-client" } },
          cookieSecret: TEST_SECRET,
          defaultSkills: ["docs", "unknown", "triage"],
        },
      );
      const html = await response.text();

      expectSkillChecked(html, "triage");
      expect(html).not.toContain('value="docs"');
      expect(html).not.toContain('value="unknown"');
    });

    it("does not render deprecated skill checkboxes", async () => {
      const response = await renderApprovalDialog(
        new Request("https://example.com/oauth/authorize"),
        {
          client: mockClient,
          server: { name: "Test Server" },
          state: { oauthReqInfo: { clientId: "test-client" } },
          cookieSecret: TEST_SECRET,
        },
      );
      const html = await response.text();

      expect(html).not.toContain('value="docs"');
      expect(html).not.toContain("Deprecated legacy docs-only grant");
    });

    it("should sanitize HTML content", async () => {
      const mockRequest = new Request("https://example.com/oauth/authorize", {
        method: "GET",
      });

      const response = await renderApprovalDialog(mockRequest, {
        client: {
          clientId: "test-client-id",
          clientName: "<script>alert('xss')</script>",
          redirectUris: ["https://example.com/callback"],
          tokenEndpointAuthMethod: "client_secret_basic",
        },
        server: { name: "Test Server" },
        state: { test: "data" },
        cookieSecret: TEST_SECRET,
      });
      const html = await response.text();

      // Check that script tags in client name are escaped and no script tags are present
      expect(html).not.toContain("<script>alert('xss')</script>");
      expect(html).toContain(
        "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;",
      );
      // Should not contain any script tags (JavaScript-free implementation)
      expect(html).not.toContain("<script>");
    });

    it("should render organization scope summary when provided", async () => {
      const response = await renderApprovalDialog(
        new Request("https://example.com/oauth/authorize"),
        {
          client: mockClient,
          server: { name: "Sentry MCP" },
          scope: { organizationSlug: "sentry", projectSlug: null },
          state: { oauthReqInfo: { clientId: "test-client" } },
          cookieSecret: TEST_SECRET,
        },
      );

      const html = await response.text();

      expect(html).toContain('aria-label="Organization scope"');
      expect(html).toContain(
        'Only <strong class="scope-token">sentry</strong>',
      );
      expect(html).toContain(
        "Every permission below, including API Write, is limited to this organization.",
      );
      expect(html).toContain("Your Sentry permissions still apply.");
      expect(html).toContain('value="api-read"');
      expect(html).toContain('value="api-write"');
    });

    it("explains that an unconstrained connection can access every organization authorized by its token", async () => {
      const response = await renderApprovalDialog(
        new Request("https://example.com/oauth/authorize"),
        {
          client: mockClient,
          server: { name: "Sentry MCP" },
          state: { oauthReqInfo: { clientId: "test-client" } },
          cookieSecret: TEST_SECRET,
        },
      );
      const html = await response.text();

      expect(html).toContain("All authorized organizations");
      expect(html).toContain(
        "This connection can access any organization allowed by its Sentry token.",
      );
      expect(html).toContain(
        "The permissions below, including API Write, apply across those organizations.",
      );
    });

    it("should render project scope summary when provided", async () => {
      const response = await renderApprovalDialog(
        new Request("https://example.com/oauth/authorize"),
        {
          client: mockClient,
          server: { name: "Sentry MCP" },
          scope: {
            organizationSlug: "sentry",
            projectSlug: "javascript",
          },
          state: { oauthReqInfo: { clientId: "test-client" } },
          cookieSecret: TEST_SECRET,
        },
      );

      const html = await response.text();

      expect(html).toContain(">javascript</strong> project");
      expect(html).toContain(">sentry</strong> organization");
      expect(html).not.toContain('name="skill" value="api-read"');
      expect(html).not.toContain('name="skill" value="api-write"');
    });
  });

  describe("CSRF protection with HMAC-signed state", () => {
    it("should reject tampered state in form submission", async () => {
      const originalOauthReqInfo = {
        clientId: "legitimate-client",
        redirectUri: "https://legitimate.com/callback",
        scope: ["read"],
      };

      // Step 1: Render the approval dialog
      const response = await renderApprovalDialog(
        new Request("https://example.com/oauth/authorize"),
        {
          client: mockClient,
          server: { name: "Sentry MCP" },
          state: { oauthReqInfo: originalOauthReqInfo },
          cookieSecret: TEST_SECRET,
        },
      );

      const html = await response.text();

      // Extract the signed state from the HTML form
      const stateMatch = html.match(/name="state" value="([^"]+)"/);
      expect(stateMatch).toBeTruthy();
      const signedState = stateMatch![1];

      // Step 2: Tamper with the state (try to change clientId)
      const [sig, b64] = signedState.split(".");
      const payload = JSON.parse(atob(b64));

      // Modify the clientId to a malicious one
      payload.req.oauthReqInfo.clientId = "evil-client";

      // Create tampered state with original signature (signature won't match)
      const tamperedState = `${sig}.${btoa(JSON.stringify(payload))}`;

      // Step 3: Try to submit the tampered form
      const formData = new FormData();
      formData.append("state", tamperedState);
      formData.append("skill", "inspect");

      const tamperedRequest = new Request(
        "https://example.com/oauth/authorize",
        {
          method: "POST",
          body: formData,
        },
      );

      // Should throw because signature verification fails
      await expect(
        parseRedirectApproval(tamperedRequest, TEST_SECRET),
      ).rejects.toThrow(/invalid signature|expired/i);
    });

    it("should reject expired state", async () => {
      const oauthReqInfo = {
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        scope: ["read"],
      };

      // Create a state that's already expired (exp in the past)
      const now = Date.now();
      const expiredPayload = {
        req: { oauthReqInfo },
        iat: now - 15 * 60 * 1000, // 15 minutes ago
        exp: now - 5 * 60 * 1000, // Expired 5 minutes ago
      };

      const expiredState = await signState(expiredPayload, TEST_SECRET);

      // Try to submit with expired state
      const formData = new FormData();
      formData.append("state", expiredState);
      formData.append("skill", "inspect");

      const request = new Request("https://example.com/oauth/authorize", {
        method: "POST",
        body: formData,
      });

      await expect(parseRedirectApproval(request, TEST_SECRET)).rejects.toThrow(
        /expired/i,
      );
    });

    it("should accept valid signed state and ignore deprecated skill submissions", async () => {
      const oauthReqInfo = {
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        scope: ["read"],
      };

      // Step 1: Render approval dialog to get valid signed state
      const response = await renderApprovalDialog(
        new Request("https://example.com/oauth/authorize"),
        {
          client: mockClient,
          server: { name: "Sentry MCP" },
          state: { oauthReqInfo },
          cookieSecret: TEST_SECRET,
        },
      );

      const html = await response.text();
      const stateMatch = html.match(/name="state" value="([^"]+)"/);
      const encodedState = stateMatch![1];

      // Step 2: Submit valid form
      const formData = new FormData();
      formData.append("state", encodedState);
      formData.append("skill", "inspect");
      formData.append("skill", "docs");

      const request = new Request("https://example.com/oauth/authorize", {
        method: "POST",
        headers: {
          Cookie: "mcp-approved-clients=test",
        },
        body: formData,
      });

      // Should succeed with valid state
      const result = await parseRedirectApproval(request, TEST_SECRET);

      expect(result.state).toBeDefined();
      expect(result.state.oauthReqInfo).toEqual(oauthReqInfo);
      expect(result.skills).toEqual(["inspect"]);
    });

    it("should write approval and skill preference cookies", async () => {
      const oauthReqInfo = {
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        scope: ["read"],
      };
      const response = await renderApprovalDialog(
        new Request("https://example.com/oauth/authorize"),
        {
          client: mockClient,
          server: { name: "Sentry MCP" },
          state: { oauthReqInfo },
          cookieSecret: TEST_SECRET,
        },
      );
      const html = await response.text();
      const stateMatch = html.match(/name="state" value="([^"]+)"/);
      const encodedState = stateMatch![1];

      const formData = new FormData();
      formData.append("state", encodedState);
      formData.append("skill", "triage");
      formData.append("skill", "project-management");

      const result = await parseRedirectApproval(
        new Request("https://example.com/oauth/authorize", {
          method: "POST",
          body: formData,
        }),
        TEST_SECRET,
      );

      const setCookie = result.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toContain("mcp-approved-clients=");
      expect(setCookie).toContain(`${SKILL_PREFERENCES_COOKIE_NAME}=`);

      const preferenceCookie = extractCookiePair(
        setCookie,
        SKILL_PREFERENCES_COOKIE_NAME,
      );
      const remembered = await getRememberedSkillsForClient(
        preferenceCookie,
        "test-client",
        TEST_SECRET,
      );
      expect(remembered).toEqual(["triage", "project-management"]);
    });

    it.each([{ apiSkills: ["api-read", "api-write"] }, { apiSkills: [] }])(
      "preserves hidden API preferences through project consent ($apiSkills)",
      async ({ apiSkills }) => {
        let preferenceCookie = "";
        const clientId = "test-client";
        const render = async (projectSlug: string | null = null) => {
          const defaultSkills = await getRememberedSkillsForClient(
            preferenceCookie,
            clientId,
            TEST_SECRET,
          );
          const response = await renderApprovalDialog(
            new Request("https://example.com/oauth/authorize"),
            {
              client: mockClient,
              server: { name: "Sentry MCP" },
              scope: { organizationSlug: "example", projectSlug },
              state: {
                oauthReqInfo: {
                  clientId,
                  resource: `https://example.com/mcp/example${projectSlug ? `/${projectSlug}` : ""}`,
                },
              },
              cookieSecret: TEST_SECRET,
              defaultSkills,
            },
          );
          return await response.text();
        };
        const approve = async (html: string, skills: string[]) => {
          const formData = new FormData();
          formData.append(
            "state",
            html.match(/name="state" value="([^"]+)"/)![1],
          );
          formData.append("decision", "approve");
          for (const skill of skills) formData.append("skill", skill);
          const result = await parseRedirectApproval(
            new Request("https://example.com/oauth/authorize", {
              method: "POST",
              headers: { Cookie: preferenceCookie },
              body: formData,
            }),
            TEST_SECRET,
          );
          preferenceCookie = extractCookiePair(
            result.headers.get("Set-Cookie") ?? "",
            SKILL_PREFERENCES_COOKIE_NAME,
          );
          return result;
        };

        await approve(await render(), ["inspect", "triage", ...apiSkills]);
        const projectHtml = await render("backend");
        expect(projectHtml).not.toContain('name="skill" value="api-read"');
        expect(projectHtml).not.toContain('name="skill" value="api-write"');

        const projectApproval = await approve(projectHtml, ["inspect"]);
        expect(projectApproval.skills).toEqual(["inspect"]);
        expect(
          await getRememberedSkillsForClient(
            preferenceCookie,
            clientId,
            TEST_SECRET,
          ),
        ).toEqual(["inspect", ...apiSkills]);

        const organizationHtml = await render();
        expectSkillChecked(organizationHtml, "inspect");
        expectSkillUnchecked(organizationHtml, "triage");
        for (const skill of ["api-read", "api-write"]) {
          if (apiSkills.includes(skill))
            expectSkillChecked(organizationHtml, skill);
          else expectSkillUnchecked(organizationHtml, skill);
        }

        await approve(organizationHtml, ["inspect"]);
        const afterUnchecking = await render();
        expectSkillUnchecked(afterUnchecking, "api-read");
        expectSkillUnchecked(afterUnchecking, "api-write");
      },
    );

    it("should keep only the ten newest skill preference clients", async () => {
      let preferenceCookie = "";

      for (let index = 0; index < 12; index++) {
        const oauthReqInfo = {
          clientId: `client-${index}`,
          redirectUri: "https://example.com/callback",
          scope: ["read"],
        };
        const encodedState = await signState(
          {
            req: { oauthReqInfo },
            iat: Date.now(),
            exp: Date.now() + 10 * 60 * 1000,
          },
          TEST_SECRET,
        );
        const formData = new FormData();
        formData.append("state", encodedState);
        formData.append("skill", "triage");

        const result = await parseRedirectApproval(
          new Request("https://example.com/oauth/authorize", {
            method: "POST",
            headers: preferenceCookie ? { Cookie: preferenceCookie } : {},
            body: formData,
          }),
          TEST_SECRET,
        );
        preferenceCookie = extractCookiePair(
          result.headers.get("Set-Cookie") ?? "",
          SKILL_PREFERENCES_COOKIE_NAME,
        );
      }

      expect(
        await getRememberedSkillsForClient(
          preferenceCookie,
          "client-0",
          TEST_SECRET,
        ),
      ).toBeUndefined();
      expect(
        await getRememberedSkillsForClient(
          preferenceCookie,
          "client-1",
          TEST_SECRET,
        ),
      ).toBeUndefined();
      expect(
        await getRememberedSkillsForClient(
          preferenceCookie,
          "client-2",
          TEST_SECRET,
        ),
      ).toEqual(["triage"]);
      expect(
        await getRememberedSkillsForClient(
          preferenceCookie,
          "client-11",
          TEST_SECRET,
        ),
      ).toEqual(["triage"]);
    });

    it("should refresh an existing skill preference client as newest", async () => {
      let preferenceCookie = "";

      for (const clientId of [
        "client-0",
        "client-1",
        "client-2",
        "client-3",
        "client-4",
        "client-5",
        "client-6",
        "client-7",
        "client-8",
        "client-9",
        "client-0",
        "client-10",
      ]) {
        const encodedState = await signState(
          {
            req: {
              oauthReqInfo: {
                clientId,
                redirectUri: "https://example.com/callback",
                scope: ["read"],
              },
            },
            iat: Date.now(),
            exp: Date.now() + 10 * 60 * 1000,
          },
          TEST_SECRET,
        );
        const formData = new FormData();
        formData.append("state", encodedState);
        formData.append("skill", "triage");

        const result = await parseRedirectApproval(
          new Request("https://example.com/oauth/authorize", {
            method: "POST",
            headers: preferenceCookie ? { Cookie: preferenceCookie } : {},
            body: formData,
          }),
          TEST_SECRET,
        );
        preferenceCookie = extractCookiePair(
          result.headers.get("Set-Cookie") ?? "",
          SKILL_PREFERENCES_COOKIE_NAME,
        );
      }

      expect(
        await getRememberedSkillsForClient(
          preferenceCookie,
          "client-0",
          TEST_SECRET,
        ),
      ).toEqual(["triage"]);
      expect(
        await getRememberedSkillsForClient(
          preferenceCookie,
          "client-1",
          TEST_SECRET,
        ),
      ).toBeUndefined();
    });

    it("should reject state with wrong secret", async () => {
      const oauthReqInfo = {
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        scope: ["read"],
      };

      // Sign with one secret
      const response = await renderApprovalDialog(
        new Request("https://example.com/oauth/authorize"),
        {
          client: mockClient,
          server: { name: "Sentry MCP" },
          state: { oauthReqInfo },
          cookieSecret: "secret-1",
        },
      );

      const html = await response.text();
      const stateMatch = html.match(/name="state" value="([^"]+)"/);
      const signedState = stateMatch![1];

      // Try to verify with different secret
      const formData = new FormData();
      formData.append("state", signedState);
      formData.append("skill", "inspect");

      const request = new Request("https://example.com/oauth/authorize", {
        method: "POST",
        body: formData,
      });

      await expect(parseRedirectApproval(request, "secret-2")).rejects.toThrow(
        /invalid signature/i,
      );
    });
  });

  describe("XSS prevention for URI fields", () => {
    const renderDialog = async (clientOverrides: Record<string, unknown>) => {
      const response = await renderApprovalDialog(
        new Request("https://example.com/oauth/authorize"),
        {
          client: { ...mockClient, ...clientOverrides },
          server: { name: "Sentry MCP" },
          state: { oauthReqInfo: { clientId: "test-client" } },
          cookieSecret: TEST_SECRET,
        },
      );
      return await response.text();
    };

    it("should strip javascript: clientUri and render name as plain text", async () => {
      const html = await renderDialog({
        clientUri: "javascript:alert(document.domain)",
      });

      expect(html).not.toContain('href="javascript:');
      expect(html).toContain("Test Client");
      // Name should NOT be wrapped in an anchor tag
      expect(html).not.toMatch(/<a [^>]*>Test Client<\/a>/);
    });

    it("should strip javascript: policyUri and omit policy link", async () => {
      const html = await renderDialog({
        policyUri: "javascript:alert(1)",
      });

      expect(html).not.toContain('href="javascript:');
      expect(html).not.toContain("Privacy Policy");
    });

    it("should strip javascript: tosUri and omit ToS link", async () => {
      const html = await renderDialog({
        tosUri: "javascript:alert(1)",
      });

      expect(html).not.toContain('href="javascript:');
      expect(html).not.toContain("Terms of Service");
    });

    it("should strip data: URI from clientUri", async () => {
      const html = await renderDialog({
        clientUri: "data:text/html,<script>alert(1)</script>",
      });

      expect(html).not.toContain('href="data:');
    });

    it("should render valid https clientUri as a link", async () => {
      const html = await renderDialog({
        clientUri: "https://github.com/getsentry/sentry-mcp",
      });

      expect(html).toContain('href="https://github.com/getsentry/sentry-mcp"');
      expect(html).toContain("Test Client</a>");
    });

    it("should render valid https policyUri and tosUri as links", async () => {
      const html = await renderDialog({
        policyUri: "https://example.com/privacy",
        tosUri: "https://example.com/tos",
      });

      expect(html).toContain('href="https://example.com/privacy"');
      expect(html).toContain("Privacy Policy");
      expect(html).toContain('href="https://example.com/tos"');
      expect(html).toContain("Terms of Service");
    });
  });
});
