/**
 * Mastra's local workspace can launch processes through execa, which is not
 * available in Workers. Keep that unsupported path out of the Worker bundle.
 */
export function execa(): never {
  throw new Error("Local process execution is unavailable in this Worker");
}
