import type { CloudflareOptions } from "@sentry/cloudflare";
import * as Sentry from "@sentry/cloudflare";
import { sentryBeforeSend } from "@sentry/mcp-core/telem/sentry";
import { LIB_VERSION } from "@sentry/mcp-core/version";
import type { Env } from "./types";

export default function getSentryConfig(env: Env): CloudflareOptions {
  const versionId = env.CF_VERSION_METADATA?.id;
  const scopeContext = {
    "app.server.version": LIB_VERSION,
    "app.upstream.host": env.SENTRY_HOST,
  };

  return {
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0.3,
    beforeSend: sentryBeforeSend,
    initialScope: {
      tags: scopeContext,
      // SDK v11 does not copy scope tags onto streamed spans.
      attributes: scopeContext,
    },
    ...(versionId ? { release: versionId } : {}),
    environment:
      env.SENTRY_ENVIRONMENT ??
      (process.env.NODE_ENV !== "production" ? "development" : "production"),
    integrations: [Sentry.zodErrorsIntegration()],
  };
}

getSentryConfig.partial = (config: Partial<CloudflareOptions>) => {
  return (env: Env) => {
    const defaultConfig = getSentryConfig(env);
    return {
      ...defaultConfig,
      ...config,
      initialScope: {
        ...defaultConfig.initialScope,
        ...config.initialScope,
        tags: {
          // idk I can't typescript
          ...((defaultConfig.initialScope ?? {}) as any).tags,
          ...((config.initialScope ?? {}) as any).tags,
        },
        attributes: {
          ...((defaultConfig.initialScope ?? {}) as any).attributes,
          ...((config.initialScope ?? {}) as any).attributes,
        },
      },
    };
  };
};
