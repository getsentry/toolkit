/**
 * Regression tests for the MCP path traversal class (VULN-2159, VULN-2174,
 * VULN-2450, VULN-2482).
 *
 * Unvalidated, unencoded Sentry resource IDs were interpolated into upstream REST
 * paths. Because `fetch` resolves `../` dot segments during URL parsing, an ID could
 * rewrite the path above the organization and project the server injects from the
 * session constraints, reaching other tenants with the granting user's credential.
 *
 * These drive tools through the same pipeline the server uses (constrained keys
 * stripped from the client-visible schema, Zod parse, constraints injected) and assert
 * on the outbound request URL, since the defect was only ever observable in the path
 * that actually left the process.
 *
 * The full bypass matrix lives in `api-client/api-path.test.ts`, against the function
 * that does the containment. These tests cover the wiring: that each reported sink
 * reaches that function.
 */
import { mswServer } from "@sentry/mcp-server-mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SentryApiService } from "../../api-client";
import { UserInputError } from "../../errors";
import { getServerContext } from "../../test-setup.js";
import type { ServerContext } from "../../types";
import {
  getFilteredInputSchema,
  injectConstraintParams,
} from "../catalog-runtime/availability";
import type { ToolConfig } from "../types";
import getEventAttachment from "./get-event-attachment";
import getEventStacktrace from "./get-event-stacktrace";
import getIssueDetails from "./get-issue-details";
import getProfileDetails from "./get-profile-details";
import getReplayDetails from "./get-replay-details";
import updateDsn from "./update-dsn";

const SCOPED_ORG = "sentry-mcp-evals";
const SCOPED_PROJECT = "cloudflare-mcp";
const VICTIM_ORG = "bbtest-victimorg";
const VICTIM_PROJECT = "victim-proj";

/** The payload from VULN-2450 step 3, which reached another organization. */
const CROSS_ORG = `../../../${VICTIM_ORG}/${VICTIM_PROJECT}/events/abc123`;

let requestedUrls: string[] = [];

function recordRequest({ request }: { request: Request }) {
  requestedUrls.push(request.url);
}

beforeEach(() => {
  requestedUrls = [];
  mswServer.events.on("request:start", recordRequest);
});

afterEach(() => {
  mswServer.events.removeListener("request:start", recordRequest);
});

/**
 * Mirrors how the server handles a tool call. Swallows handler errors because an
 * upstream 404 is irrelevant here; the assertion that matters is which URL was
 * requested, which is captured either way.
 */
async function callToolAsClient(
  // getFilteredInputSchema and injectConstraintParams take ToolConfig so they
  // can accept tools with heterogeneous schemas.
  tool: ToolConfig,
  clientParams: Record<string, unknown>,
  context: ServerContext,
): Promise<void> {
  const parsed = z
    .object(getFilteredInputSchema(tool, context))
    .safeParse(clientParams);
  if (!parsed.success) return;

  await tool
    .handler(injectConstraintParams(parsed.data, tool, context), context)
    .catch(() => {});
}

/**
 * Asserts on decoded path *segments* rather than substrings, since an encoded payload
 * legitimately still contains the victim slug as literal text.
 */
function expectAllRequestsInScope() {
  for (const url of requestedUrls) {
    // Sentry API paths are /api/0/{projects|organizations}/{org}/...
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const anchor = segments.findIndex(
      (segment) => segment === "projects" || segment === "organizations",
    );

    expect(anchor).not.toBe(-1);
    expect(segments[anchor + 1]).toBe(SCOPED_ORG);
    expect(segments).not.toContain(VICTIM_ORG);
    expect(segments).not.toContain(VICTIM_PROJECT);
  }
}

describe("path traversal containment", () => {
  const scopedContext = () =>
    getServerContext({
      constraints: {
        organizationSlug: SCOPED_ORG,
        projectSlug: SCOPED_PROJECT,
      },
    });

  /** Every ID parameter named across the four reports. */
  const sinks: [
    string,
    ToolConfig,
    (payload: string) => Record<string, unknown>,
  ][] = [
    [
      "get_event_attachment eventId",
      getEventAttachment,
      (p) => ({ eventId: p }),
    ],
    [
      "get_event_attachment attachmentId",
      getEventAttachment,
      (p) => ({
        eventId: "99be789ee5555abf1ad81bd47c2c2e36",
        attachmentId: p,
      }),
    ],
    [
      "get_issue_details eventId",
      getIssueDetails,
      (p) => ({ issueId: "CLOUDFLARE-MCP-41", eventId: p }),
    ],
    [
      "get_event_stacktrace eventId",
      getEventStacktrace,
      (p) => ({ issueId: "CLOUDFLARE-MCP-41", eventId: p }),
    ],
    ["get_replay_details replayId", getReplayDetails, (p) => ({ replayId: p })],
    [
      "get_profile_details profileId",
      getProfileDetails,
      (p) => ({ profileId: p }),
    ],
    // The write half of VULN-2450: a confined token renamed and disabled DSNs in
    // another organization.
    [
      "update_dsn keyId",
      updateDsn,
      (p) => ({ keyId: p, name: "XORG-PWN", isActive: false }),
    ],
  ];

  it.each(sinks)(
    "%s cannot escape the scoped project",
    async (_label, tool, params) => {
      await callToolAsClient(tool, params(CROSS_ORG), scopedContext());
      expectAllRequestsInScope();
    },
  );

  /**
   * VULN-2450 emphasised org-only sessions, where the project-slug ownership guards
   * in project-constraints.ts early-return and the path encoding is all that remains.
   */
  it("cannot escape an org-only session", async () => {
    await callToolAsClient(
      updateDsn,
      { projectSlug: SCOPED_PROJECT, keyId: CROSS_ORG, name: "XORG-PWN" },
      getServerContext({
        constraints: { organizationSlug: SCOPED_ORG, projectSlug: null },
      }),
    );

    expectAllRequestsInScope();
  });

  /**
   * The schema refinements reject the payloads above, so the tests above never reach
   * the API client. This block drives the client directly, standing in for a parameter
   * that a future tool forgets to validate. It is the evidence that the client layer
   * holds on its own, which is why this class recurred after the slug-only VULN-848 fix.
   */
  describe("the API client contains traversal with no validation layer", () => {
    const updateKey = (keyId: string) =>
      new SentryApiService({
        accessToken: "access-token",
        host: "sentry.io",
      }).updateClientKey({
        organizationSlug: SCOPED_ORG,
        projectSlug: SCOPED_PROJECT,
        keyId,
        name: "XORG-PWN",
      });

    it("issues one in-scope request for a traversal payload", async () => {
      await updateKey(CROSS_ORG).catch(() => {});

      expect(requestedUrls).toHaveLength(1);
      expectAllRequestsInScope();
    });

    it("issues no request at all for a bare dot segment", async () => {
      await expect(updateKey("..")).rejects.toThrow(UserInputError);

      expect(requestedUrls).toEqual([]);
    });
  });
});
