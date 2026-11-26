// Imports the packed package as ES modules, as an npm consumer would.
import { strictEqual } from "node:assert";
import {
  type CacheStore,
  createMemoryStore,
  fetchWithCache,
  withRetry,
} from "@sentry/http";
import { createBodyCodec } from "@sentry/http/codec";

const store: CacheStore = createMemoryStore();
let requests = 0;
const read = () =>
  fetchWithCache({
    store,
    codec: createBodyCodec(),
    identity: "consumer",
    url: "https://api.example.com/items/",
    ttlMs: 60_000,
    send: async () => {
      requests++;
      const retrying = withRetry(
        async () => Response.json({ items: "x".repeat(1024) }),
        {
          policy: {
            maxRetries: 1,
            baseDelayMs: 1,
            maxDelayMs: 1,
            maxTotalDelayMs: 1,
          },
          retryableStatuses: new Map([[429, "any"]]),
        },
      );
      return await retrying("https://api.example.com/items/");
    },
  });

await read();
const cached = (await (await read()).json()) as { items: string };
strictEqual(cached.items.length, 1024);
strictEqual(requests, 1);
