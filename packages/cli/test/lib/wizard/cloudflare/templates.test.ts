import { describe, expect, it } from "vitest";
import { getCloudflareWorkerTemplate } from "../../../../src/lib/wizard/cloudflare/templates.js";

describe("Cloudflare code templates", () => {
  describe("getCloudflareWorkerTemplate", () => {
    it("generates worker template with performance monitoring enabled", () => {
      const template = getCloudflareWorkerTemplate(
        "my-dsn",
        {
          performance: true,
        },
        false,
      );

      expect(template).toMatchInlineSnapshot(`
        "import * as Sentry from '@sentry/cloudflare';

        export default Sentry.withSentry(
        	(env) => ({
        		dsn: 'my-dsn',
        		// Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
        		tracesSampleRate: 1,
        	}),
        	{
        		async fetch(request, env, ctx): Promise<Response> {
        			// Your worker logic here
        			return new Response('Hello World!');
        		},
        	} satisfies ExportedHandler<Env>,
        );
        "
      `);
    });

    it("generates worker template with performance monitoring disabled", () => {
      const template = getCloudflareWorkerTemplate(
        "my-dsn",
        {
          performance: false,
        },
        false,
      );

      expect(template).toMatchInlineSnapshot(`
        "import * as Sentry from '@sentry/cloudflare';

        export default Sentry.withSentry(
        	(env) => ({
        		dsn: 'my-dsn',
        	}),
        	{
        		async fetch(request, env, ctx): Promise<Response> {
        			// Your worker logic here
        			return new Response('Hello World!');
        		},
        	} satisfies ExportedHandler<Env>,
        );
        "
      `);
    });

    it("generates worker template with reduced data collection", () => {
      const template = getCloudflareWorkerTemplate(
        "my-dsn",
        {
          performance: true,
        },
        true,
      );

      expect(template).toContain("userInfo: false");
      expect(template).toContain(
        'httpHeaders: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] }',
      );

      expect(template).toMatchInlineSnapshot(`
        "import * as Sentry from '@sentry/cloudflare';

        export default Sentry.withSentry(
        	(env) => ({
        		dsn: 'my-dsn',
        		// Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
        		tracesSampleRate: 1,
        		// Turns off collection of data that could identify users. Adjust per category:
        		// https://docs.sentry.io/platforms/javascript/configuration/options/#dataCollection
        		dataCollection: {
        		  userInfo: false,
        		  graphQL: { document: false, variables: false },
        		  genAI: { inputs: false, outputs: false },
        		  databaseQueryData: false,
        		  queues: false,
        		  httpBodies: [],
        		  httpHeaders: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
        		  cookies: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
        		  urlQueryParams: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
        		},
        	}),
        	{
        		async fetch(request, env, ctx): Promise<Response> {
        			// Your worker logic here
        			return new Response('Hello World!');
        		},
        	} satisfies ExportedHandler<Env>,
        );
        "
      `);
    });

    it("includes the correct DSN", () => {
      const dsn = "https://example@sentry.io/123";
      const template = getCloudflareWorkerTemplate(
        dsn,
        {
          performance: true,
        },
        false,
      );

      expect(template).toContain(`dsn: '${dsn}'`);
    });

    it("wraps handler with Sentry.withSentry", () => {
      const template = getCloudflareWorkerTemplate(
        "my-dsn",
        {
          performance: false,
        },
        false,
      );

      expect(template).toContain("Sentry.withSentry");
      expect(template).toContain("async fetch(request, env, ctx)");
      expect(template).toContain("satisfies ExportedHandler<Env>");
    });
  });
});
