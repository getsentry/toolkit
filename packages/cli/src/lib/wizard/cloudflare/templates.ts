/**
 * Worker source the Cloudflare wizard writes or shows: a worker wrapped with
 * `Sentry.withSentry()`, and a starter worker.
 */

import { getDataCollectionSnippet } from "../utils/data-collection.js";

export function getCloudflareWorkerTemplate(
  dsn: string,
  selectedFeatures: {
    performance: boolean;
  },
  reduceDataCollection: boolean,
): string {
  let performanceOptions = "";
  if (selectedFeatures.performance) {
    performanceOptions = `
		// Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
		tracesSampleRate: 1,`;
  }

  const dataCollectionOptions = reduceDataCollection
    ? `\n${getDataCollectionSnippet("\t\t")}`
    : "";

  return `import * as Sentry from '@sentry/cloudflare';

export default Sentry.withSentry(
	(env) => ({
		dsn: '${dsn}',${performanceOptions}${dataCollectionOptions}
	}),
	{
		async fetch(request, env, ctx): Promise<Response> {
			// Your worker logic here
			return new Response('Hello World!');
		},
	} satisfies ExportedHandler<Env>,
);
`;
}

export function getCloudflareWorkerTemplateWithHandler(): string {
  return `export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case '/message':
				return new Response('Hello, World!');
			case '/random':
				return new Response(crypto.randomUUID());
			default:
				return new Response('Not Found', { status: 404 });
		}
	},
} satisfies ExportedHandler<Env>;
`;
}
