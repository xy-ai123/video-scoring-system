/**
 * Read-only mirror of apps/web/src/lib/session.ts — verifies the signed
 * cookie that apps/web sets at login, so this dashboard can require the
 * same admin session without its own /login page.
 *
 * If you change the cookie format on the other side, mirror it here.
 */

export const COOKIE_NAME = "vss-session";

export type SessionPayload = {
  sub: string;
  iat: number;
  exp: number;
};

function getSecret(): string {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error("NEXTAUTH_SECRET must be set (>=16 chars)");
  }
  return s;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

export async function verifySessionToken(
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(sigB64)) return null;
  let ok = false;
  try {
    const key = await importKey(getSecret());
    // Cast Uint8Array → BufferSource: the lib.dom.d.ts in newer TS rejects
    // Uint8Array<ArrayBufferLike> because it could be backed by a
    // SharedArrayBuffer. Web Crypto accepts either fine at runtime.
    ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlToBytes(sigB64) as BufferSource,
      new TextEncoder().encode(payloadB64),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const json = new TextDecoder().decode(b64urlToBytes(payloadB64));
    const parsed = JSON.parse(json) as SessionPayload;
    if (
      typeof parsed.sub !== "string" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    if (Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}
