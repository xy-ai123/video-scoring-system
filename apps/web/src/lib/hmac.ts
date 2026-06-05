import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an HMAC-SHA256 signature header against a raw request body.
 *
 * Expected header format: `sha256=<hex>` (case-insensitive `sha256` prefix).
 * Bare hex is also accepted for resilience.
 */
export function verifyHmac(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const trimmed = signatureHeader.trim();
  const provided = trimmed.toLowerCase().startsWith("sha256=")
    ? trimmed.slice("sha256=".length)
    : trimmed;
  // SHA-256 hex is exactly 64 hex chars. Enforce length BEFORE any byte work
  // so odd-length hex (e.g. attacker-crafted) doesn't silently truncate via
  // Buffer.from(.., "hex") and bypass timing-safe comparison.
  if (provided.length !== 64) return false;
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Compute an HMAC-SHA256 hex signature. Useful for tests and Apps Script parity. */
export function signHmac(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}
