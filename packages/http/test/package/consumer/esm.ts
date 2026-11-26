// Imports the packed package as ES modules, as an npm consumer would.
import { strictEqual } from "node:assert";
import {
  type CacheStore,
  createMemoryStore,
  fetchWithCache,
  fetchWithRetry,
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
      return await fetchWithRetry(
        async () => Response.json({ items: "x".repeat(1024) }),
        {
          policy: {
            maxRetries: 1,
            baseDelayMs: 1,
            maxDelayMs: 1,
            maxTotalDelayMs: 1,
          },
          method: "GET",
        },
      );
    },
  });

await read();
const cached = (await (await read()).json()) as { items: string };
strictEqual(cached.items.length, 1024);
strictEqual(requests, 1);
