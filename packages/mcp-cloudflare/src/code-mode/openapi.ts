import { configuredUrl, readBoundedBody } from "./http";

export const SENTRY_OPENAPI_URL =
  "https://raw.githubusercontent.com/getsentry/sentry-api-schema/803d6de98c9156c15e9ddc1bf9accbac6e24cebc/openapi-derefed.json";

let cachedSpec: { url: string; promise: Promise<object> } | undefined;

/** Share the trusted schema between discovery and authorization; retry failed loads. */
export async function getSpec(url: string): Promise<object> {
  configuredUrl(url);
  if (cachedSpec?.url === url) return await cachedSpec.promise;
  const promise = (async () => {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`OpenAPI could not be loaded (HTTP ${response.status}).`);
    const body = await readBoundedBody(response.body, 30_000_000);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== "object" || !("paths" in parsed)) {
      throw new Error("The configured OpenAPI document has no paths object.");
    }
    return parsed;
  })();
  cachedSpec = { url, promise };
  try {
    return await promise;
  } catch (error) {
    cachedSpec = undefined;
    throw error;
  }
}
