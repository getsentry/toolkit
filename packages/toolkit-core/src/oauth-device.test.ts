import { expect, it } from "vitest";
import { deviceCodeRequestBody, deviceTokenRequestBody } from "./oauth-device";

it("encodes the client, scope, and device code as form fields", () => {
  const clientId = "client & id";
  const scope = "project:read org:read";
  const deviceCode = "device + / code";
  const code = deviceCodeRequestBody(clientId, scope);
  const token = deviceTokenRequestBody(clientId, deviceCode);

  expect([...code]).toEqual([
    ["client_id", clientId],
    ["scope", scope],
  ]);
  expect([...token]).toEqual([
    ["client_id", clientId],
    ["device_code", deviceCode],
    ["grant_type", "urn:ietf:params:oauth:grant-type:device_code"],
  ]);
});

it("sends the login hint only when one is given", () => {
  expect(
    deviceCodeRequestBody("client", "org:read", "jane@example.com").get(
      "login_hint",
    ),
  ).toBe("jane@example.com");
  expect(deviceCodeRequestBody("client", "org:read").has("login_hint")).toBe(
    false,
  );
});
