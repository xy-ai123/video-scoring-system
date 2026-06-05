/**
 * Synthetic webhook trigger for local development.
 *
 * Fakes an Apps Script -> /api/webhooks/google-form POST. Reads
 * WEBHOOK_SECRET from env, builds a payload, computes the HMAC-SHA256
 * signature, and POSTs to the local web server.
 *
 * Usage:
 *   pnpm tsx scripts/test-webhook.ts \
 *     --email=demo-admin@example.com \
 *     --name="Demo User" \
 *     --category=cooking \
 *     --files=1
 *
 * Make sure mocks are enabled (DRIVE_MOCK, ALGO_ENGINE_MOCK, RESEND_MOCK)
 * if you don't have credentials for the real services.
 */

import crypto from "node:crypto";

// Best-effort dotenv load. If the package isn't installed we just rely on
// process.env (CI/Railway flows already provide it).
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dotenv = require("dotenv") as typeof import("dotenv");
  dotenv.config();
} catch {
  // dotenv not installed; ignore.
}

type Args = {
  email: string;
  name: string;
  category: string;
  files: number;
  url: string;
};

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (const a of argv.slice(2)) {
    if (!a.startsWith("--")) continue;
    const [k, v] = a.replace(/^--/, "").split("=");
    out[k] = v ?? "true";
  }
  const filesNum = Number(out.files ?? "1");
  return {
    email: out.email ?? "demo-admin@example.com",
    name: out.name ?? "Demo User",
    category: out.category ?? "general",
    files: Number.isFinite(filesNum) && filesNum > 0 ? filesNum : 1,
    url:
      out.url ?? "http://localhost:3000/api/webhooks/google-form",
  };
}

function rand(n = 8): string {
  return crypto.randomBytes(n).toString("hex");
}

async function main() {
  const args = parseArgs(process.argv);

  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    // eslint-disable-next-line no-console
    console.error(
      "WEBHOOK_SECRET is not set. Export it or add it to .env before running.",
    );
    process.exit(1);
  }

  const files = Array.from({ length: args.files }, (_, i) => ({
    driveFileId: `MOCK_FILE_${i + 1}_${rand(4)}`,
    name: `demo-${i + 1}.mp4`,
    mimeType: "video/mp4",
  }));

  const payload = {
    responseId: `TEST_${rand(6).toUpperCase()}`,
    submitterEmail: args.email,
    submitterName: args.name,
    category: args.category,
    files,
  };

  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  // eslint-disable-next-line no-console
  console.log("POST", args.url);
  // eslint-disable-next-line no-console
  console.log("payload:", payload);

  const res = await fetch(args.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature": signature,
    },
    body,
  });

  const text = await res.text();
  // eslint-disable-next-line no-console
  console.log("status:", res.status);
  // eslint-disable-next-line no-console
  console.log("response:", text);

  if (!res.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("test-webhook failed:", err);
  process.exit(1);
});
