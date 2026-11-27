import type { AppLoadContext, EntryContext } from 'react-router';
import { ServerRouter } from 'react-router';
import { renderToString } from 'react-dom/server';

// handleError declared as variable and exported directly
export const handleError = async (
  error: unknown,
  { request }: { request: Request }
): Promise<Response> => {
  console.error('Unhandled error:', error);
  return new Response('Internal Server Error', { status: 500 });
};

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: AppLoadContext
) {
  const html = renderToString(
    <ServerRouter context={routerContext} url={request.url} />
  );

  responseHeaders.set('Content-Type', 'text/html');

  return new Response(`<!DOCTYPE html>${html}`, {
    status: responseStatusCode,
    headers: responseHeaders,
  });
}
