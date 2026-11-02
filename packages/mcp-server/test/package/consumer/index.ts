import {
  startStdio,
  type StdioServerContext,
} from "@sentry/mcp-server/transports/stdio";

declare const server: Parameters<typeof startStdio>[0];

const telemetryContext: StdioServerContext = {
  experimentalMode: false,
  mcpUrl: "https://example.com/mcp",
  sentryHost: "sentry.io",
};

void startStdio(server, telemetryContext);
void startStdio(server, {
  accessToken: "token",
  constraints: {},
  sentryHost: "sentry.io",
});
