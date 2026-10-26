// @vitest-environment node
import { createServer, type Server, type RequestListener } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { replayEnvelopes } from "./replay.ts";
const servers: Server[] = [],
  dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function endpoint(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}/stream`;
}
async function fixtures() {
  const dir = await mkdtemp(join(tmpdir(), "local-replay-"));
  dirs.push(dir);
  return dir;
}
test.each(["none", "gzip", "br"] as const)(
  "recursively replays binary fixtures with %s compression and repeat",
  async (compression) => {
    const dir = await fixtures();
    await mkdir(join(dir, "nested"));
    const bytes = Buffer.from([0, 255, 10, 42]);
    await writeFile(join(dir, "nested", "test.bin"), bytes);
    await writeFile(join(dir, "README.md"), "not an envelope");
    const received: Buffer[] = [];
    const target = await endpoint((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        received.push(
          compression === "gzip"
            ? gunzipSync(body)
            : compression === "br"
              ? brotliDecompressSync(body)
              : body,
        );
        response.writeHead(204).end();
      });
    });
    expect(
      await replayEnvelopes({
        endpoint: target,
        fixtures: dir,
        repeat: 2,
        compression,
      }),
    ).toBe(2);
    expect(received).toEqual([bytes, bytes]);
  },
);
test("reports rejected envelopes and empty fixture directories", async () => {
  const dir = await fixtures();
  await expect(
    replayEnvelopes({ endpoint: "http://localhost:1/stream", fixtures: dir }),
  ).rejects.toThrow("No envelope files");
  await writeFile(join(dir, "test.txt"), "{}");
  const target = await endpoint((_request, response) =>
    response.writeHead(422).end(),
  );
  await expect(
    replayEnvelopes({ endpoint: target, fixtures: dir }),
  ).rejects.toThrow("HTTP 422");
});
