import { z } from "zod";

// Minimal, stateless HMAC-signed OAuth state utilities
// Format: `${signatureHex}.${base64(payloadJson)}`

// Safe envelope: keep the full downstream AuthRequest (+permissions) under `req`
// and include only iat/exp metadata at top-level to avoid collisions.
export const OAuthStateSchema = z.object({
  req: z.record(z.string(), z.unknown()),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type OAuthState = z.infer<typeof OAuthStateSchema> & {
  req: Record<string, unknown>;
};

async function importKey(secret: string): Promise<CryptoKey> {
  if (!secret) {
    throw new Error(
      "COOKIE_SECRET is not defined. A secret key is required for signing state.",
    );
  }
  const enc = new TextEncoder();
  return await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

async function signHex(key: CryptoKey, data: string): Promise<string> {
  const enc = new TextEncoder();
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(data),
  );
  return Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyHex(
  key: CryptoKey,
  signatureHex: string,
  data: string,
): Promise<boolean> {
  try {
    const enc = new TextEncoder();
    const signatureBytes = new Uint8Array(
      signatureHex.match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16)),
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes.buffer,
      enc.encode(data),
    );
  } catch {
    return false;
  }
}

export async function signState(
  payload: OAuthState,
  secret: string,
): Promise<string> {
  const key = await importKey(secret);
  const json = JSON.stringify(payload);
  const sig = await signHex(key, json);
  // Using UTF-8 safe base64 encoding to handle non-Latin1 characters
  const b64 = utf8ToBase64(json);
  return `${sig}.${b64}`;
}

export async function verifyAndParseState(
  compact: string,
  secret: string,
): Promise<OAuthState> {
  const [sig, b64] = compact.split(".");
  if (!sig || !b64) {
    throw new Error("Invalid state format");
  }
  const json = base64ToUtf8(b64);
  const key = await importKey(secret);
  const ok = await verifyHex(key, sig, json);
  if (!ok) {
    throw new Error("Invalid state signature");
  }
  const parsed = OAuthStateSchema.parse(JSON.parse(json));
  const now = Date.now();
  if (parsed.exp <= now) {
    throw new Error("State expired");
  }
  return parsed;
}
