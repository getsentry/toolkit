import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

export const defaultFixtures = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);
export type ReplayOptions = {
  endpoint: string;
  fixtures?: string;
  compression?: "none" | "gzip" | "br";
  interval?: number;
  repeat?: number;
  onSent?: (file: string, index: number) => void;
};
async function envelopeFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await envelopeFiles(child)));
    else if (
      entry.isFile() &&
      [".txt", ".bin", ".envelope"].includes(extname(entry.name))
    )
      files.push(child);
  }
  return files;
}
/** Replay raw bytes through the public receiver endpoint; never bypass ingestion. */
export async function replayEnvelopes({
  endpoint,
  fixtures = defaultFixtures,
  compression = "none",
  interval = 0,
  repeat = 1,
  onSent,
}: ReplayOptions): Promise<number> {
  const target = new URL(endpoint);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.hash
  )
    throw new Error(
      "Endpoint must be an HTTP(S) receiver URL without user information or a fragment.",
    );
  if (
    !Number.isSafeInteger(repeat) ||
    repeat < 1 ||
    !Number.isSafeInteger(interval) ||
    interval < 0
  )
    throw new Error(
      "Repeat must be a positive integer and interval a non-negative integer in milliseconds.",
    );
  if (!["none", "gzip", "br"].includes(compression))
    throw new Error("Compression must be none, gzip, or br.");
  const files = await envelopeFiles(resolve(fixtures));
  if (!files.length)
    throw new Error("No envelope files found (.txt, .bin, .envelope).");
  let sent = 0;
  for (let cycle = 0; cycle < repeat; cycle++)
    for (const file of files) {
      if (sent && interval) await delay(interval);
      const raw = await readFile(file);
      const body =
        compression === "gzip"
          ? gzipSync(raw)
          : compression === "br"
            ? brotliCompressSync(raw)
            : raw;
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          ...(compression === "none"
            ? {}
            : { "Content-Encoding": compression }),
        },
        body: new Uint8Array(body),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(`Receiver rejected ${file}: HTTP ${response.status}`);
      sent++;
      onSent?.(file, sent);
    }
  return sent;
}
async function main() {
  const { values, positionals } = parseArgs({
    options: {
      endpoint: { type: "string" },
      fixtures: { type: "string" },
      compression: { type: "string", default: "none" },
      interval: { type: "string", default: "0" },
      repeat: { type: "string", default: "1" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(
      "Replay envelopes: pnpm --filter local sample [directory-or-file] [--endpoint http://localhost:8969/stream] [--compression none|gzip|br] [--interval 200] [--repeat 3]\nDefaults to bundled examples. SENTRY_SPOTLIGHT may also select the endpoint.",
    );
    return;
  }
  const compression = values.compression;
  if (compression !== "none" && compression !== "gzip" && compression !== "br")
    throw new Error("Compression must be none, gzip, or br.");
  if (positionals.length > 1)
    throw new Error("Supply at most one fixture directory or file.");
  const spotlight = process.env.SENTRY_SPOTLIGHT;
  const endpoint =
    values.endpoint ??
    (spotlight && !/^(1|true|yes|on|enabled)$/i.test(spotlight)
      ? spotlight
      : "http://localhost:8969/stream");
  const target = new URL(endpoint);
  console.log(`Replaying envelopes to ${target.origin}${target.pathname}`);
  const count = await replayEnvelopes({
    endpoint,
    fixtures: values.fixtures ?? positionals[0],
    compression,
    interval: Number(values.interval),
    repeat: Number(values.repeat),
    onSent: (file, index) =>
      console.log(
        `${index}. ${file.slice(dirname(resolve(values.fixtures ?? positionals[0] ?? defaultFixtures)).length + 1)}`,
      ),
  });
  console.log(`Sent ${count} envelope${count === 1 ? "" : "s"}.`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Replay failed");
    process.exitCode = 1;
  });
}
