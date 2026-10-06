import { exec } from "node:child_process";
import * as fs from "node:fs";
import { LIB_VERSION } from "@sentry/mcp-core/version";
import {
  deviceCodeRequestBody,
  deviceTokenRequestBody,
} from "@sentry/toolkit-core/oauth-device";
import {
  DEVICE_CODE_ENDPOINT,
  DEVICE_CODE_SCOPES,
  SLOW_DOWN_INCREMENT_SEC,
  TOKEN_ENDPOINT,
} from "./constants";
import {
  DeviceCodeErrorSchema,
  type DeviceCodeResponse,
  DeviceCodeResponseSchema,
  getTokenUserLabel,
  type TokenResponse,
  TokenResponseSchema,
} from "./types";

const USER_AGENT = `sentry-mcp-server/${LIB_VERSION}`;

export class DeviceCodeError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "DeviceCodeError";
  }
}

export async function requestDeviceCode(
  clientId: string,
  host: string,
  scopes: string = DEVICE_CODE_SCOPES,
): Promise<DeviceCodeResponse> {
  const url = `https://${host}${DEVICE_CODE_ENDPOINT}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: deviceCodeRequestBody(clientId, scopes),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new DeviceCodeError(
      `Failed to request device code (HTTP ${resp.status}): ${text}`,
    );
  }

  const body = await resp.json();
  return DeviceCodeResponseSchema.parse(body);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollForToken({
  deviceCode,
  clientId,
  host,
  interval,
  expiresIn,
}: {
  deviceCode: string;
  clientId: string;
  host: string;
  interval: number;
  expiresIn: number;
}): Promise<TokenResponse> {
  const url = `https://${host}${TOKEN_ENDPOINT}`;
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval;

  while (Date.now() < deadline) {
    await sleep(pollInterval * 1000);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: deviceTokenRequestBody(clientId, deviceCode),
    });

    if (resp.ok) {
      const body = await resp.json();
      return TokenResponseSchema.parse(body);
    }

    const errorBody = await resp.json().catch(() => null);
    const parsed = DeviceCodeErrorSchema.safeParse(errorBody);
    const errorCode = parsed.success ? parsed.data.error : undefined;

    switch (errorCode) {
      case "authorization_pending":
        // Keep polling at current interval
        continue;
      case "slow_down":
        pollInterval += SLOW_DOWN_INCREMENT_SEC;
        continue;
      case "access_denied":
        throw new DeviceCodeError(
          "Authorization was denied. Please try again or provide --access-token.",
          errorCode,
        );
      case "expired_token":
        throw new DeviceCodeError(
          "Device code expired before authorization was completed.",
          errorCode,
        );
      default:
        throw new DeviceCodeError(
          `Unexpected error during device code polling: ${errorCode ?? resp.statusText}`,
          errorCode,
        );
    }
  }

  throw new DeviceCodeError(
    "Device code expired before authorization was completed.",
    "expired_token",
  );
}

/**
 * Write directly to stderr, bypassing console.warn which may be
 * intercepted by the MCP transport layer.
 */
function stderr(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function isWSL(): boolean {
  try {
    return fs
      .readFileSync("/proc/version", "utf-8")
      .toLowerCase()
      .includes("microsoft");
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  try {
    const { platform } = process;
    if (platform === "darwin") {
      exec(`open ${JSON.stringify(url)}`);
    } else if (platform === "win32") {
      exec(`start "" ${JSON.stringify(url)}`);
    } else if (isWSL()) {
      // WSL: invoke cmd.exe to open the default browser.
      exec(`cmd.exe /c start "" ${JSON.stringify(url)}`);
    } else {
      exec(`xdg-open ${JSON.stringify(url)}`);
    }
  } catch {
    // Best-effort — ignore errors (headless, etc.)
  }
}

export function displayDeviceCode(response: DeviceCodeResponse): void {
  stderr("");
  stderr(`To authorize, visit: ${response.verification_uri_complete}`);
  stderr(`  and enter code: ${response.user_code}`);
  stderr("");
  stderr("Waiting for authorization...");

  openBrowser(response.verification_uri_complete);
}

export async function authenticate({
  clientId,
  host,
}: {
  clientId: string;
  host: string;
}): Promise<TokenResponse> {
  stderr("No access token provided. Starting device authorization...");

  const deviceCodeResponse = await requestDeviceCode(clientId, host);
  displayDeviceCode(deviceCodeResponse);

  const tokenResponse = await pollForToken({
    deviceCode: deviceCodeResponse.device_code,
    clientId,
    host,
    interval: deviceCodeResponse.interval,
    expiresIn: deviceCodeResponse.expires_in,
  });

  stderr(`Successfully authenticated as ${getTokenUserLabel(tokenResponse)}`);
  return tokenResponse;
}
