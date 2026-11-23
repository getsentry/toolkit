// Serves cli.sentry.dev/install/<handoff code>: the install script with
// SENTRY_HANDOFF set, so `curl -fsSL https://cli.sentry.dev/install/<code> | bash`
// claims the Sentry agent handoff during `sentry cli setup`. build-output.mjs
// bundles this module with the install script as a Vercel Edge Function.

// Matches the codes Sentry issues (`sntryh_` + 32 random bytes, base64url).
// The code is written into a shell script, so nothing outside this character
// set may ever reach the response.
export const HANDOFF_CODE = /^sntryh_[A-Za-z0-9_-]{43}$/;

const HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  // The response carries a credential: never cache or index it.
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
};

export function createHandler(installScript) {
  const firstLineEnd = installScript.indexOf("\n") + 1;
  if (!installScript.startsWith("#!") || firstLineEnd === 0) {
    throw new Error("install script must start with a shebang line");
  }
  const shebang = installScript.slice(0, firstLineEnd);
  const body = installScript.slice(firstLineEnd);

  return function handler(request) {
    const url = new URL(request.url);
    // The route rewrites /install/<code> to ?code=<code>. Read the original
    // path too, in case the function sees the URL before the rewrite.
    const code =
      url.searchParams.get("code") ??
      url.pathname.match(/^\/install\/([^/]+)$/)?.[1] ??
      "";
    if (!HANDOFF_CODE.test(code)) {
      return new Response("Not found\n", { status: 404, headers: HEADERS });
    }
    return new Response(`${shebang}export SENTRY_HANDOFF='${code}'\n${body}`, {
      headers: HEADERS,
    });
  };
}
