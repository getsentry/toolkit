/** Read the issuing Sentry instance from a private setup code. */

import { looseObject, safeParse, string } from "valibot";
import { ValidationError } from "./errors.js";
import { normalizeHttpOrigin } from "./sentry-urls.js";

const setupCodePattern = /^sntryc_([A-Za-z0-9+/=]+)_([A-Za-z0-9+/]{43})$/;
const claimSchema = looseObject({ url: string() });

/** Resolve the issuing instance from the code's unsigned routing claim. */
export function getSetupCodeHost(code: string): string {
  const encodedClaim = setupCodePattern.exec(code)?.[1];

  if (!encodedClaim) {
    throw new ValidationError("Invalid Sentry setup code.", "setup-code");
  }

  let claim: unknown;

  try {
    claim = JSON.parse(Buffer.from(encodedClaim, "base64").toString("utf8"));
  } catch {
    throw new ValidationError("Invalid Sentry setup code.", "setup-code");
  }

  const parsed = safeParse(claimSchema, claim);
  const host = parsed.success
    ? normalizeHttpOrigin(parsed.output.url)
    : undefined;

  if (!host) {
    throw new ValidationError("Invalid setup-code instance URL.", "setup-code");
  }

  return host;
}
