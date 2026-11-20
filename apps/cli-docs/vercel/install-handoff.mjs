// Serves cli.sentry.dev/install/<handoff code> and /install.ps1/<handoff code>:
// the install script with SENTRY_HANDOFF set, so
//   curl -fsSL https://cli.sentry.dev/install/<code> | bash
//   irm https://cli.sentry.dev/install.ps1/<code> | iex
// claim the Sentry agent handoff during `sentry cli setup`. build-output.mjs
// bundles this module with both install scripts as a Vercel Edge Function.

// Matches the codes Sentry issues (`sntryh_` + 32 random bytes, base64url).
// The code is written into a script, so nothing outside this character set
// may ever reach the response.
export const HANDOFF_CODE = /^sntryh_[A-Za-z0-9_-]{43}$/;

const HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  // The response carries a credential: never cache or index it.
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
};

// bash runs the piped script in its own process, so an export after the
// shebang is enough.
function withBashHandoff(script) {
  const firstLineEnd = script.indexOf("\n") + 1;
  if (!script.startsWith("#!") || firstLineEnd === 0) {
    throw new Error("install script must start with a shebang line");
  }
  const shebang = script.slice(0, firstLineEnd);
  const body = script.slice(firstLineEnd);
  return (code) => `${shebang}export SENTRY_HANDOFF='${code}'\n${body}`;
}

// iex runs the script in the caller's session, where $env: changes outlive
// the install. Remove the variable afterwards, even when the install throws,
// so the code does not stay in the user's session.
function withPowerShellHandoff(script) {
  return (code) =>
    `$env:SENTRY_HANDOFF = '${code}'\ntry {\n${script}\n} finally {\n  Remove-Item Env:SENTRY_HANDOFF -ErrorAction SilentlyContinue\n}\n`;
}

// `scripts` holds the raw `install` (bash) and `install.ps1` scripts.
export function createHandler(scripts) {
  const render = {
    install: withBashHandoff(scripts.install),
    "install.ps1": withPowerShellHandoff(scripts["install.ps1"]),
  };

  return function handler(request) {
    const url = new URL(request.url);
    // The route rewrites /<script>/<code> to ?script=<script>&code=<code>.
    // Read the original path too, in case the function sees the URL before
    // the rewrite.
    const path = url.pathname.match(/^\/(install(?:\.ps1)?)\/([^/]+)$/);
    const script = url.searchParams.get("script") ?? path?.[1] ?? "";
    const code = url.searchParams.get("code") ?? path?.[2] ?? "";
    if (!Object.hasOwn(render, script) || !HANDOFF_CODE.test(code)) {
      return new Response("Not found\n", { status: 404, headers: HEADERS });
    }
    return new Response(render[script](code), { headers: HEADERS });
  };
}
