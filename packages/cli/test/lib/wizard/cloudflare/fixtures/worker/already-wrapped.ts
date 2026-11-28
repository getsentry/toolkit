import * as Sentry from '@sentry/cloudflare';

export default Sentry.withSentry(
  (env) => ({
    dsn: 'existing-dsn',
  }),
  {
    async fetch(request, env, ctx): Promise<Response> {
      return new Response('Already wrapped');
    },
  },
);
