/**
 * Starts one mock Sentry API for every wizard e2e test, so a wizard run can
 * log in, read its preselected org and project, and mint an org auth token
 * without a Sentry account. Tests read its URL with `inject("sentryUrl")`.
 */

import type { TestProject } from "vitest/node";
import { apiRoutes } from "../mocks/routes.js";
import { createMockServer } from "../mocks/server.js";
import { TEST_ARGS } from "./constants.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** Origin of the mock Sentry API, for `SENTRY_URL`. */
    sentryUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  const server = createMockServer(
    [
      ...apiRoutes,
      {
        method: "POST",
        path: "/api/0/organizations/:orgSlug/org-auth-tokens/",
        status: 201,
        response: {
          id: "1",
          name: "Sentry Wizard",
          scopes: ["org:ci"],
          tokenLastCharacters: TEST_ARGS.AUTH_TOKEN.slice(-4),
          dateCreated: "2024-01-01T00:00:00.000Z",
          dateLastUsed: null,
          token: TEST_ARGS.AUTH_TOKEN,
        },
      },
    ],
    { validTokens: [TEST_ARGS.LOGIN_TOKEN] },
  );
  await server.start();
  project.provide("sentryUrl", server.url);
  return () => server.stop();
}
