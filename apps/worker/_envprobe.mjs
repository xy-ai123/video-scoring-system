import { config as loadDotenv } from "dotenv";
loadDotenv();
loadDotenv({ path: "../../.env", override: false });

const fields = [
  "DATABASE_URL", "REDIS_URL", "WEBHOOK_SECRET",
  "GMAIL_SMTP_USER", "GMAIL_SMTP_PASSWORD",
  "GMAIL_IMPERSONATE_USER", "RESEND_MOCK", "DRIVE_MOCK",
];
for (const f of fields) {
  const v = process.env[f];
  if (v == null) console.log(`  ${f}: <MISSING>`);
  else if (f.includes("PASSWORD") || f.includes("SECRET") || f.includes("JSON"))
    console.log(`  ${f}: <set, length ${v.length}>`);
  else console.log(`  ${f}: ${v}`);
}
