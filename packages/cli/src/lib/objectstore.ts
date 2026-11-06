/**
 * Minimal Objectstore HTTP client for snapshot image uploads.
 *
 * Replicates the subset of the `objectstore-client` protocol (getsentry/objectstore)
 * that `snapshots upload` needs: check which objects already exist (dedup) and
 * upload the missing ones. The service URL, scopes, auth token, and expiration
 * policy all come from the Sentry `snapshots/upload-options/` endpoint — this
 * client never signs tokens itself (the token is a pre-signed JWT).
 *
 * Object path layout: `{serviceUrl}/v1/objects/{usecase}/{scope}/{key}` where
 * `scope` is a `;`-joined list of ordered `key=value` pairs. Auth is carried in
 * the `x-os-auth: Bearer <token>` header (not the standard `Authorization`).
 *
 * Like the Rust client's `Session::many()`, HEADs and small PUTs are grouped
 * into multipart requests to `{serviceUrl}/v1/objects:batch/{usecase}/{scope}/`.
 * The Sentry proxy in front of Objectstore rate-limits per HTTP request, so one
 * request per image quickly trips it (HTTP 429) on larger snapshot suites.
 */

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import pLimit from "p-limit";
import { customFetch } from "./custom-ca.js";
import { ApiError } from "./errors.js";

/** Header carrying the Objectstore bearer token. */
const AUTH_HEADER = "x-os-auth";
/** Header carrying an object's expiration policy (e.g. `ttl:30d`). */
const EXPIRATION_HEADER = "x-sn-expiration";

/** Matches one or more trailing slashes (for base-URL normalization). */
const TRAILING_SLASHES = /\/+$/;

/** Timeout for uploading a single object. */
const PUT_TIMEOUT_MS = 120_000;
/** Timeout for one batch request (up to {@link MAX_BATCH_BODY_SIZE} bytes). */
const BATCH_TIMEOUT_MS = 300_000;

/** Per-part headers of the batch protocol. */
const BATCH_KIND_HEADER = "x-sn-batch-operation-kind";
const BATCH_KEY_HEADER = "x-sn-batch-operation-key";
const BATCH_INDEX_HEADER = "x-sn-batch-operation-index";
const BATCH_STATUS_HEADER = "x-sn-batch-operation-status";

/** Server-enforced maximum number of operations per batch request. */
const MAX_BATCH_OPS = 1000;
/** Server-enforced maximum body size of one batch part; larger objects are PUT individually. */
const MAX_BATCH_PART_SIZE = 1024 * 1024;
/**
 * Maximum total body size of one batch request. With {@link BATCH_CONCURRENCY}
 * batches in flight, upload bodies held in memory stay around 100 MB.
 */
const MAX_BATCH_BODY_SIZE = 25 * 1024 * 1024;
/**
 * Batch requests in flight at once. Each batch is one request to the Sentry
 * proxy, so this stays far below its per-request rate limit.
 */
const BATCH_CONCURRENCY = 4;
/** Concurrency for objects too large to batch (matches the Rust client). */
const INDIVIDUAL_CONCURRENCY = 5;

/** Matches the `boundary` parameter of a multipart `Content-Type`. */
const BOUNDARY_PARAM = /boundary=(?:"([^"]+)"|([^;\s]+))/i;
/** Matches the CRLF that terminates a multipart part body. */
const TRAILING_CRLF = /\r\n$/;

/**
 * Objectstore upload configuration, as returned (camelCase) by the Sentry
 * `snapshots/upload-options/` endpoint.
 */
export type ObjectstoreConfig = {
  /** Base service URL (may include a path prefix). */
  url: string;
  usecase: string;
  /** Ordered scope pairs (e.g. `[["org","1"],["project","2"]]`). */
  scopes: [string, string][];
  /** Pre-signed bearer token, or null/absent for unauthenticated stores. */
  authToken?: string | null;
  /** Expiration policy string applied to uploaded objects. */
  expirationPolicy: string;
};

/** Render scope pairs into the `k=v;k=v` path segment. */
function scopeSegment(scopes: [string, string][]): string {
  return scopes.map(([key, value]) => `${key}=${value}`).join(";");
}

/**
 * Build the full URL for an object key within the configured usecase + scope.
 *
 * @param config - The objectstore configuration.
 * @param key - The object key (e.g. `<orgId>/<projectId>/<sha256>`).
 */
export function buildObjectUrl(config: ObjectstoreConfig, key: string): string {
  const base = config.url.replace(TRAILING_SLASHES, "");
  return `${base}/v1/objects/${config.usecase}/${scopeSegment(
    config.scopes,
  )}/${key}`;
}

/** Build the batch endpoint URL for the configured usecase + scope. */
function buildBatchUrl(config: ObjectstoreConfig): string {
  const base = config.url.replace(TRAILING_SLASHES, "");
  return `${base}/v1/objects:batch/${config.usecase}/${scopeSegment(
    config.scopes,
  )}/`;
}

/**
 * Escape a value for an Objectstore header, matching `encode_header_value` in
 * `objectstore-types`: percent-encode control bytes, DEL, `%`, and non-ASCII.
 */
export function encodeHeaderValue(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    if (byte < 0x20 || byte >= 0x7f || byte === 0x25) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return out;
}

/** Auth headers for an objectstore request, if a token is configured. */
function authHeaders(config: ObjectstoreConfig): Record<string, string> {
  return config.authToken
    ? { [AUTH_HEADER]: `Bearer ${config.authToken}` }
    : {};
}

/**
 * Upload an object's bytes (raw — no content encoding).
 *
 * The key is derived from the original file's SHA-256, so dedup via
 * {@link findExistingObjects} is independent of any upload compression; images are
 * already-compressed formats, so storing them raw avoids pointless CPU.
 *
 * @throws {ApiError} On a non-2xx response.
 */
export async function putObject(
  config: ObjectstoreConfig,
  key: string,
  body: Uint8Array,
): Promise<void> {
  const url = buildObjectUrl(config, key);
  const response = await customFetch(url, {
    method: "PUT",
    headers: {
      ...authHeaders(config),
      [EXPIRATION_HEADER]: config.expirationPolicy,
    },
    body,
    signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ApiError(
      "Objectstore upload failed",
      response.status,
      response.statusText || "PUT failed",
      url,
    );
  }
}

/** One operation within a batch request. */
type BatchOperation =
  | { kind: "head"; key: string }
  | { kind: "insert"; key: string; body: Uint8Array };

/** Outcome of one batch operation, as reported in its response part. */
type BatchOperationResult = {
  /** HTTP status of this operation (e.g. 200, 201, 404, 429). */
  status: number;
  /** Response part body (an error description for failed operations). */
  message: string;
};

/** Serialize batch operations into a `multipart/form-data` request body. */
function encodeBatchBody(
  config: ObjectstoreConfig,
  operations: BatchOperation[],
  boundary: string,
): Buffer {
  const chunks: Uint8Array[] = [];
  for (const op of operations) {
    let head =
      `--${boundary}\r\n` +
      'content-disposition: form-data; name="part"\r\n' +
      `${BATCH_KIND_HEADER}: ${op.kind}\r\n` +
      `${BATCH_KEY_HEADER}: ${encodeHeaderValue(op.key)}\r\n`;
    if (op.kind === "insert") {
      head += `${EXPIRATION_HEADER}: ${config.expirationPolicy}\r\n`;
    }
    chunks.push(Buffer.from(`${head}\r\n`));
    if (op.kind === "insert") {
      chunks.push(op.body);
    }
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

/** Parse the header block of one multipart part into a lowercase-keyed map. */
function parsePartHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.set(
        line.slice(0, colon).trim().toLowerCase(),
        line.slice(colon + 1).trim(),
      );
    }
  }
  return headers;
}

/**
 * Parse a batch `multipart/form-data` response into per-operation results,
 * keyed by the operation index the server echoes on each part.
 *
 * Response parts only carry status headers and small error bodies, so the
 * whole response is buffered and split on the boundary.
 */
function parseBatchResponse(
  contentType: string,
  body: Buffer,
  url: string,
): Map<number, BatchOperationResult> {
  const match = BOUNDARY_PARAM.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) {
    throw new ApiError(
      "Objectstore batch response is not multipart",
      502,
      `Unexpected Content-Type: ${contentType || "(none)"}`,
      url,
    );
  }

  const results = new Map<number, BatchOperationResult>();
  // latin1 maps bytes 1:1, so offsets stay valid for binary-safe splitting.
  const segments = body.toString("latin1").split(`--${boundary}`);
  for (const segment of segments.slice(1)) {
    if (segment.startsWith("--")) {
      break; // closing delimiter
    }
    const part = segment.startsWith("\r\n") ? segment.slice(2) : segment;
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) {
      continue;
    }
    const headers = parsePartHeaders(part.slice(0, split));
    const index = Number.parseInt(headers.get(BATCH_INDEX_HEADER) ?? "", 10);
    const status = Number.parseInt(headers.get(BATCH_STATUS_HEADER) ?? "", 10);
    if (Number.isNaN(index) || Number.isNaN(status)) {
      continue;
    }
    const rawBody = part.slice(split + 4).replace(TRAILING_CRLF, "");
    results.set(index, {
      status,
      message: Buffer.from(rawBody, "latin1").toString("utf8"),
    });
  }
  return results;
}

/**
 * Send operations as one batch request.
 *
 * @returns Results aligned with `operations` by index.
 * @throws {ApiError} When the batch request itself fails or the response is
 *   missing a result for any operation.
 */
async function sendBatch(
  config: ObjectstoreConfig,
  operations: BatchOperation[],
): Promise<BatchOperationResult[]> {
  const url = buildBatchUrl(config);
  const boundary = `sentry-cli-${randomUUID()}`;
  const response = await customFetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(config),
      "content-type": `multipart/form-data; boundary="${boundary}"`,
    },
    body: encodeBatchBody(config, operations, boundary),
    signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ApiError(
      "Objectstore batch request failed",
      response.status,
      response.statusText || "batch request failed",
      url,
    );
  }

  const parsed = parseBatchResponse(
    response.headers.get("content-type") ?? "",
    Buffer.from(await response.arrayBuffer()),
    url,
  );
  return operations.map((op, index) => {
    const result = parsed.get(index);
    if (!result) {
      throw new ApiError(
        "Objectstore batch response is incomplete",
        502,
        `No result for ${op.kind} of ${op.key}`,
        url,
      );
    }
    return result;
  });
}

/** Throw an {@link ApiError} for a failed operation inside a batch. */
function throwOperationError(
  config: ObjectstoreConfig,
  message: string,
  key: string,
  result: BatchOperationResult,
): never {
  throw new ApiError(
    message,
    result.status,
    result.message || `HTTP ${result.status}`,
    buildObjectUrl(config, key),
  );
}

/** Split `items` into consecutive chunks of at most `size` items. */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Find which keys already exist, using batched HEAD operations (one request
 * per {@link MAX_BATCH_OPS} keys, up to {@link BATCH_CONCURRENCY} at once).
 *
 * @returns The subset of `keys` that exist.
 * @throws {ApiError} On a failed batch, or any HEAD result other than 2xx/404.
 */
export async function findExistingObjects(
  config: ObjectstoreConfig,
  keys: string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  const limit = pLimit(BATCH_CONCURRENCY);
  await Promise.all(
    chunk(keys, MAX_BATCH_OPS).map((batch) =>
      limit(async () => {
        const results = await sendBatch(
          config,
          batch.map((key) => ({ kind: "head", key })),
        );
        results.forEach((result, i) => {
          const key = batch[i] as string;
          if (result.status === 404) {
            return;
          }
          if (result.status >= 400) {
            throwOperationError(config, "Objectstore HEAD failed", key, result);
          }
          existing.add(key);
        });
      }),
    ),
  );
  return existing;
}

/** A file to upload under an object key. */
export type ObjectUpload = { key: string; path: string };

/** Group sized uploads into batches within the op-count and body-size limits. */
function groupBatches(
  uploads: (ObjectUpload & { size: number })[],
): ObjectUpload[][] {
  const batches: ObjectUpload[][] = [];
  let current: ObjectUpload[] = [];
  let currentSize = 0;
  for (const upload of uploads) {
    if (
      current.length >= MAX_BATCH_OPS ||
      (current.length > 0 && currentSize + upload.size > MAX_BATCH_BODY_SIZE)
    ) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(upload);
    currentSize += upload.size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/**
 * Upload files as objects. Files up to {@link MAX_BATCH_PART_SIZE} are sent in
 * batch requests, up to {@link BATCH_CONCURRENCY} at once; larger files are PUT
 * individually, up to {@link INDIVIDUAL_CONCURRENCY} at once. Both run in
 * parallel. A file is read only when its request starts.
 *
 * @throws {ApiError} On a failed batch, or any failed insert.
 */
export async function putObjects(
  config: ObjectstoreConfig,
  uploads: ObjectUpload[],
): Promise<void> {
  const sized = await Promise.all(
    uploads.map(async (upload) => ({
      ...upload,
      size: (await stat(upload.path)).size,
    })),
  );
  const batchable = sized.filter((u) => u.size <= MAX_BATCH_PART_SIZE);
  const individual = sized.filter((u) => u.size > MAX_BATCH_PART_SIZE);

  const batchLimit = pLimit(BATCH_CONCURRENCY);
  const individualLimit = pLimit(INDIVIDUAL_CONCURRENCY);
  await Promise.all([
    ...groupBatches(batchable).map((batch) =>
      batchLimit(async () => {
        const operations = await Promise.all(
          batch.map(async (upload): Promise<BatchOperation> => ({
            kind: "insert",
            key: upload.key,
            body: await readFile(upload.path),
          })),
        );
        const results = await sendBatch(config, operations);
        results.forEach((result, i) => {
          if (result.status >= 400) {
            const key = (batch[i] as ObjectUpload).key;
            throwOperationError(
              config,
              "Objectstore upload failed",
              key,
              result,
            );
          }
        });
      }),
    ),
    ...individual.map((upload) =>
      individualLimit(async () => {
        await putObject(config, upload.key, await readFile(upload.path));
      }),
    ),
  ]);
}
