import * as Sentry from '@sentry/react-router';
import type { AppLoadContext, EntryContext } from 'react-router';

async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: AppLoadContext
) {
  return new Response('Already instrumented', {
    status: responseStatusCode,
    headers: responseHeaders,
  });
}

export async function handleError(
  error: unknown,
  { request }: { request: Request }
): Promise<Response> {
  if (!request.signal.aborted) {
    Sentry.captureException(error);
  }
  console.error(error);
  return new Response('Internal Server Error', { status: 500 });
}

export default Sentry.wrapSentryHandleRequest(handleRequest);
