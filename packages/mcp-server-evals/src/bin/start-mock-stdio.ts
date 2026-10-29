#!/usr/bin/env node

import { buildServer } from "@sentry/mcp-core/server";
import { startStdio } from "@sentry/mcp-core/transports/stdio";
import { mswServer } from "@sentry/mcp-server-mocks";
import { SKILLS, type Skill } from "@sentry/mcp-core/skills";
import type { ServerContext } from "@sentry/mcp-core/types";

mswServer.listen({
  onUnhandledRequest: (req, print) => {
    if (
      req.url.startsWith("https://api.openai.com/") ||
      req.url.startsWith("https://openrouter.ai/")
    ) {
      return;
    }

    print.warning();
    throw new Error(`Unhandled request: ${req.url}`);
  },
  // onUnhandledRequest: "error"
});

const accessToken = "mocked-access-token";

// Grant all available skills for evals to ensure MSW mocks apply broadly
const allSkills = Object.keys(SKILLS) as Skill[];

const context: ServerContext = {
  accessToken,
  sentryHost: process.env.SENTRY_HOST ?? "sentry.io",
  grantedSkills: new Set<Skill>(allSkills),
  constraints: {
    organizationSlug: null,
    projectSlug: null,
  },
};

const server = buildServer({ context, experimentalMode: true });

// Run in-process MCP with all skills so MSW mocks apply
startStdio(server, context).catch((err: unknown) => {
  console.error("Server error:", err);
  process.exit(1);
});
