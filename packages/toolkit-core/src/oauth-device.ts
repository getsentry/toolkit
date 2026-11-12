/**
 * RFC 8628 device-authorization request bodies shared by CLI and MCP.
 *
 * `loginHint` is the email of the account expected to approve the request.
 * Sentry refuses approval from any other signed-in user; servers that predate
 * the parameter ignore it.
 */
export function deviceCodeRequestBody(
  clientId: string,
  scope: string,
  loginHint?: string,
): URLSearchParams {
  const body = new URLSearchParams({ client_id: clientId, scope });
  if (loginHint) {
    body.set("login_hint", loginHint);
  }
  return body;
}

export function deviceTokenRequestBody(
  clientId: string,
  deviceCode: string,
): URLSearchParams {
  return new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
}
