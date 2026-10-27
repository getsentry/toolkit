/** Trusted harness; model code is loaded after the private API broker is set. */
export function sandboxSource(apiBase?: string): string {
  return `
import { WorkerEntrypoint } from "cloudflare:workers";
${apiBase ? "" : 'import spec from "spec.json";'}
${apiBase ? "" : 'Object.defineProperty(globalThis, "spec", { value: spec });'}
const apiBase = ${JSON.stringify(apiBase ?? null)};
let deadline = 0;
let apiCalls = 0;
let writesAttempted = 0;
let pendingApiCalls = 0;
let apiBroker;
async function request({ method = "GET", path, query, body }) {
    if (!apiBase) throw new Error("API access is unavailable during search.");
    if (!apiBroker) throw new Error("Code execution has finished.");
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
      throw new Error("path must start with / and contain an API path, not a URL.");
    }
    const base = new URL(apiBase);
    const prefix = base.pathname.replace(/\\/$/, "");
    const url = new URL(path === prefix || path.startsWith(prefix + "/")
      ? path : prefix + path, base.origin);
    if (query) for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    }
    const request = new Request(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    if (++apiCalls > 20) throw new Error("API call budget exhausted (20 calls per execution).");
    if (Date.now() >= deadline) throw new Error("Execution deadline exceeded.");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) writesAttempted++;
    const response = await apiBroker.fetch(request);
    const text = await response.text();
    let data = text;
    if (text && (response.headers.get("content-type") || "").toLowerCase().includes("json")) {
      try { data = JSON.parse(text); } catch { throw new Error("API response was not valid JSON."); }
    } else if (!text) data = null;
    if (!response.ok) {
      const error = new Error("Sentry API error: " + method.toUpperCase() + " " + url.pathname +
        " returned HTTP " + response.status + ": " + JSON.stringify(data).slice(0, 2_000));
      error.status = response.status;
      error.method = method.toUpperCase();
      error.path = url.pathname;
      error.headers = Object.fromEntries(response.headers);
      error.data = data;
      throw error;
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), body: data };
}
const sentry = {
  request(options) {
    pendingApiCalls++;
    const pending = request(options).finally(() => pendingApiCalls--);
    // A forgotten await must become the execution error below, not an unhandled rejection.
    pending.catch(() => {});
    return pending;
  },
};
Object.defineProperty(globalThis, "sentry", { value: sentry });
export default class extends WorkerEntrypoint {
  async run(broker, executionDeadline) {
    apiBroker = broker;
    deadline = executionDeadline;
    try {
      const { default: run } = await import("./user.js");
      const result = await run();
      const serialized = JSON.stringify({ result: result ?? null, stats: { apiCalls, writesAttempted } });
      if (pendingApiCalls > 0) {
        throw new Error("Await every sentry.request() before returning. API calls are still pending.");
      }
      if (new TextEncoder().encode(serialized).byteLength > 50_000) {
        throw new Error("Result exceeds 50,000 bytes. Return selected fields or a smaller page.");
      }
      return new Response(serialized, { headers: { "content-type": "application/json" } });
    } catch (error) {
      const hasHttpDetails = Number.isFinite(error?.status) &&
        typeof error.method === "string" && typeof error.path === "string" &&
        error.headers !== null && typeof error.headers === "object" &&
        !Array.isArray(error.headers) && Object.values(error.headers).every(value => typeof value === "string");
      return Response.json({ error: String(error?.message || error).slice(0, 4_000),
        ...(hasHttpDetails ? { httpError: {
          status: error.status, method: error.method, path: error.path, headers: error.headers,
        } } : {}),
        stats: { apiCalls, writesAttempted } }, { status: 400 });
    } finally {
      apiBroker = undefined;
    }
  }
}
`;
}
