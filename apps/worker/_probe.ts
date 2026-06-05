console.log("REDIS_URL:", process.env.REDIS_URL ? "SET" : "<undefined>");
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "SET" : "<undefined>");
console.log("GMAIL_SMTP_USER:", JSON.stringify(process.env.GMAIL_SMTP_USER));
console.log("GMAIL_SMTP_PASSWORD length:", (process.env.GMAIL_SMTP_PASSWORD || "").length);
console.log("WEBHOOK_SECRET:", process.env.WEBHOOK_SECRET ? `length=${process.env.WEBHOOK_SECRET.length}` : "<undefined>");
