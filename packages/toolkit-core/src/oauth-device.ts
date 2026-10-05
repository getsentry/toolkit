/** RFC 8628 device-authorization request bodies shared by CLI and MCP. */
export function deviceCodeRequestBody(
  clientId: string,
  scope: string,
): URLSearchParams {
  return new URLSearchParams({ client_id: clientId, scope });
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
