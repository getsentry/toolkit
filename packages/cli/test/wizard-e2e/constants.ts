/**
 * The org, project, and tokens of the mock Sentry API that the wizard e2e
 * tests run against. No vitest imports, so `global-setup.ts` can load it.
 */

import {
  TEST_DSN,
  TEST_ORG,
  TEST_PROJECT,
  TEST_TOKEN,
} from "../mocks/routes.js";

/** The org, project, and tokens the mock Sentry API serves. */
export const TEST_ARGS = {
  /** The CLI's login token, which the mock API accepts. */
  LOGIN_TOKEN: TEST_TOKEN,
  /** The org auth token the mock API mints for source map uploads. */
  AUTH_TOKEN: "sntrys_wizard-e2e-org-auth-token",
  PROJECT_DSN: TEST_DSN,
  ORG_SLUG: TEST_ORG,
  PROJECT_SLUG: TEST_PROJECT,
} as const;
