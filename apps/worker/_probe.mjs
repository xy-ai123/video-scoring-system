import fs from 'node:fs';
import path from 'node:path';

// Load env
const env = fs.readFileSync('.env','utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !line.startsWith('#')) process.env[m[1]] = m[2];
}

const nodemailer = await import('nodemailer');
const t = nodemailer.default.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_SMTP_USER,
    pass: (process.env.GMAIL_SMTP_PASSWORD || '').replace(/\s+/g, ''),
  },
  // Surface the SMTP conversation:
  logger: false,
  debug: false,
});

console.log("user =", JSON.stringify(process.env.GMAIL_SMTP_USER));
console.log("pass length =", (process.env.GMAIL_SMTP_PASSWORD || '').replace(/\s+/g, '').length);

try {
  const ok = await t.verify();
  console.log("verify() ->", ok);
} catch (e) {
  console.log("verify() FAILED:", e?.message || String(e));
  console.log("code:", e?.code);
  console.log("response:", e?.response);
  console.log("responseCode:", e?.responseCode);
}
process.exit(0);
