/** A request body stream of at least `size` bytes, sent in 16 KiB chunks. */
export function streamOf(size: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(16 * 1024).fill(0x20);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
}
