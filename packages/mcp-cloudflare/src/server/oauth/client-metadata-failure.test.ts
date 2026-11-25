import { CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import { classifyClientMetadataFailure } from "./client-metadata-failure";

function classify(detail: string) {
  return classifyClientMetadataFailure(
    new CimdFetchError(
      "https://client.example.com/client.json",
      new Error(detail),
    ),
  );
}

describe("classifyClientMetadataFailure", () => {
  // Representative failure messages from the provider.
  it.each([
    ["Failed to fetch client metadata: HTTP 404", "terminal", "http_status"],
    ["Failed to fetch client metadata: HTTP 403", "terminal", "http_status"],
    ["Failed to fetch client metadata: HTTP 429", "transient", "http_status"],
    ["Failed to fetch client metadata: HTTP 530", "transient", "http_status"],
    ["Client metadata fetch timed out after 10000ms", "transient", "timeout"],
    ["Response exceeded size limit of 5120 bytes", "terminal", "too_large"],
    [
      "Client metadata exceeds size limit: 6000 bytes (max 5120)",
      "terminal",
      "too_large",
    ],
    [
      "Client metadata response is not valid JSON",
      "terminal",
      "invalid_document",
    ],
    [
      'client_id "undefined" does not match metadata URL "https://client.example.com/client.json"',
      "terminal",
      "invalid_metadata",
    ],
    [
      "Invalid redirect_uris: expected array, got string",
      "terminal",
      "invalid_metadata",
    ],
    [
      "Client Identifier URL contains invalid whitespace or characters",
      "terminal",
      "invalid_client_id",
    ],
  ])("classifies %j", (detail, failureClass, reason) => {
    expect(classify(detail)).toMatchObject({ failureClass, reason });
  });

  it("does not classify fetch runtime errors", () => {
    expect(classify("Network connection lost.")).toBeUndefined();
  });
});
