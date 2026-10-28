/**
 * Global type declarations for APIs not yet in @types/node or lib ESNext.
 *
 * These were previously provided by @types/bun. Now that the project runs
 * on Node.js, we declare only the minimal types we need.
 */

// Web Worker API — used by src/lib/scan/worker-pool.ts
// Node 22+ supports the standard Web Worker API for Blob-URL workers.

type WorkerEventMap = {
  message: MessageEvent;
  messageerror: MessageEvent;
  error: ErrorEvent;
};

declare class Worker {
  constructor(url: string | URL, options?: { type?: string });
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  addEventListener<K extends keyof WorkerEventMap>(
    type: K,
    listener: (event: WorkerEventMap[K]) => void,
  ): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener<K extends keyof WorkerEventMap>(
    type: K,
    listener: (event: WorkerEventMap[K]) => void,
  ): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  ref(): void;
  unref(): void;
}

// RegExp.escape — ES2025 proposal, available in Node 23.6+
// Used by src/lib/api/projects.ts with a runtime feature-detection guard.
// interface augmentation requires `interface`, not `type`
interface RegExpConstructor {
  escape?(s: string): string;
}

// Typechecking does not need the generated OpenAPI data; builds generate it.
// This declaration also supports a fresh checkout without src/generated/.
declare module "*/generated/api-schema.json" {
  const endpoints: unknown;
  export default endpoints;
}
