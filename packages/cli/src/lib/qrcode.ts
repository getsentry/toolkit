/**
 * QR Code Utilities
 *
 * Terminal QR code generation for authentication flows.
 * Uses qrcode-terminal for rendering QR codes in the terminal.
 */

import qrcodeTerminal from "qrcode-terminal";
import { boolean, type InferOutput, object, optional, parse } from "valibot";

// Schema & Types

/**
 * QR code generation options schema
 */
export const QRCodeOptionsSchema = object({
  /**
   * Use compact (small) QR code rendering.
   * Recommended for terminal display.
   */
  small: optional(boolean(), true),
});

export type QRCodeOptions = InferOutput<typeof QRCodeOptionsSchema>;

// Public API

/**
 * Generate a QR code string for terminal display
 *
 * @param data - The data to encode in the QR code (typically a URL)
 * @param options - QR code generation options
 * @returns The QR code as a string suitable for terminal output
 *
 * @example
 * ```ts
 * const qr = await generateQRCode("https://example.com/auth?code=ABC123");
 * process.stdout.write(qr);
 * ```
 */
export function generateQRCode(
  data: string,
  options?: Partial<QRCodeOptions>
): Promise<string> {
  const opts = parse(QRCodeOptionsSchema, options ?? {});

  return new Promise((resolve) => {
    qrcodeTerminal.generate(data, { small: opts.small }, (qrcode) => {
      resolve(qrcode);
    });
  });
}
