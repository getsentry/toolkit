import * as Sentry from '@sentry/cloudflare';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    Sentry.captureMessage('test');
    return new Response('Test');
  },
};
