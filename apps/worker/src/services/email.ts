/**
 * Email service for the worker.
 *
 * Three backends, tried in order:
 *   1. Gmail SMTP with an App Password (works with consumer @gmail.com
 *      accounts — requires the account owner to enable 2FA and create an
 *      App Password at https://myaccount.google.com/apppasswords).
 *   2. Gmail API via the Drive service-account JSON, impersonating
 *      `GMAIL_IMPERSONATE_USER` (Workspace domain-wide delegation only).
 *   3. Resend (RESEND_API_KEY + RESEND_FROM), as a final fallback.
 *
 * If none are configured and `RESEND_MOCK=true`, we just log the email
 * (dev-mode behaviour). Otherwise the worker job fails and BullMQ retries.
 */

import { google } from "googleapis";
import { JWT } from "google-auth-library";
import nodemailer, { type Transporter } from "nodemailer";
import { Resend } from "resend";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

function sanitizeHeader(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("invalid header value (contains CR/LF/NUL)");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export type EmailKind = "approval" | "rejection";

export type NotifyEmailInput = {
  kind: EmailKind;
  to: string;
  /** The submitter's display name. Often equals their email if no name field. */
  name: string;
  submissionId: string;
};

const PROJECT_NAME = "Head-Mounted Mobile Capture Project";
const ADMIN_SIGNATURE = `${PROJECT_NAME} Admin`;

// ---------------------------------------------------------------------------
// Template rendering — matches the screenshots exactly.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderApprovalText(input: NotifyEmailInput): string {
  return [
    `Dear ${input.to},`,
    ``,
    `Your submission has been reviewed and approved by the admin team.`,
    ``,
    `Thank you for your participation in the ${PROJECT_NAME}.`,
    ``,
    `Please do not reply to this email.`,
    ``,
    `Best regards,`,
    ADMIN_SIGNATURE,
  ].join("\n");
}

export function renderRejectionText(input: NotifyEmailInput): string {
  return [
    `Dear ${input.to},`,
    ``,
    `Your submission has been reviewed and was not approved by the admin team.`,
    ``,
    `Please review the submission requirements and resubmit if applicable.`,
    ``,
    `Please do not reply to this email.`,
    ``,
    `Best regards,`,
    ADMIN_SIGNATURE,
  ].join("\n");
}

function renderHtml(input: NotifyEmailInput, kind: EmailKind): string {
  const headline =
    kind === "approval" ? "Submission Approved" : "Submission Rejected";
  const bodyLines =
    kind === "approval"
      ? [
          "Your submission has been reviewed and approved by the admin team.",
          `Thank you for your participation in the ${PROJECT_NAME}.`,
          "Please do not reply to this email.",
        ]
      : [
          "Your submission has been reviewed and was not approved by the admin team.",
          "Please review the submission requirements and resubmit if applicable.",
          "Please do not reply to this email.",
        ];
  const paragraphs = bodyLines
    .map(
      (line) =>
        `<p style="margin:0 0 16px 0;font-size:14px;color:#334155;">${escapeHtml(
          line,
        )}</p>`,
    )
    .join("");

  return `<!doctype html>
<html><body style="margin:0;background:#f8fafc;padding:24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <tr><td style="padding:24px;font-family:Inter,system-ui,sans-serif;color:#0f172a;">
      <h1 style="margin:0 0 16px 0;font-size:18px;">${escapeHtml(headline)}</h1>
      <p style="margin:0 0 16px 0;font-size:14px;color:#334155;">Dear ${escapeHtml(
        input.to,
      )},</p>
      ${paragraphs}
      <p style="margin:24px 0 0 0;font-size:14px;color:#0f172a;">Best regards,<br/>${escapeHtml(
        ADMIN_SIGNATURE,
      )}</p>
    </td></tr>
  </table>
</body></html>`;
}

function subjectFor(kind: EmailKind): string {
  return kind === "approval" ? "Submission Approved" : "Submission Rejected";
}

// ---------------------------------------------------------------------------
// Gmail SMTP backend (App Password, supports consumer @gmail.com)
// ---------------------------------------------------------------------------

let cachedSmtpTransport: Transporter | undefined;

function getSmtpTransport(): Transporter {
  if (cachedSmtpTransport) return cachedSmtpTransport;
  cachedSmtpTransport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: env.GMAIL_SMTP_USER,
      // Gmail App Passwords are 16 chars and may include spaces when copied
      // from the dashboard. Strip spaces defensively.
      pass: env.GMAIL_SMTP_PASSWORD.replace(/\s+/g, ""),
    },
  });
  return cachedSmtpTransport;
}

async function sendViaSmtp(input: NotifyEmailInput): Promise<{
  backend: "smtp";
  id: string;
}> {
  const transport = getSmtpTransport();
  const text =
    input.kind === "approval"
      ? renderApprovalText(input)
      : renderRejectionText(input);
  const html = renderHtml(input, input.kind);
  const subject = subjectFor(input.kind);
  const fromAddress = env.GMAIL_SMTP_USER;
  const fromName = env.GMAIL_FROM_NAME || ADMIN_SIGNATURE;
  const info = await transport.sendMail({
    from: `${fromName} <${fromAddress}>`,
    to: input.to,
    subject,
    text,
    html,
  });
  return { backend: "smtp", id: info.messageId ?? "(unknown)" };
}

// ---------------------------------------------------------------------------
// Gmail backend (service account + Workspace DWD)
// ---------------------------------------------------------------------------

function decodeServiceAccount(): {
  client_email: string;
  private_key: string;
  project_id: string;
} {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let jsonText: string;
  try {
    jsonText = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid base64");
  }
  if (!jsonText.trim().startsWith("{")) {
    jsonText = raw;
  }
  const parsed = JSON.parse(jsonText) as {
    client_email: string;
    private_key: string;
    project_id: string;
  };
  return parsed;
}

let cachedGmailJwt: JWT | undefined;

function getGmailJwt(): JWT {
  if (cachedGmailJwt) return cachedGmailJwt;
  const sa = decodeServiceAccount();
  cachedGmailJwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    // Impersonate the Workspace user. This is the critical bit: without it,
    // service accounts cannot send Gmail. Requires DWD for this client_id.
    subject: env.GMAIL_IMPERSONATE_USER,
  });
  return cachedGmailJwt;
}

function buildRfc822(
  fromEmail: string,
  fromName: string,
  to: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): string {
  // Reject any CR/LF/NUL that could be used to inject extra headers.
  const safeFromEmail = sanitizeHeader(fromEmail);
  const safeFromName = sanitizeHeader(fromName);
  const safeTo = sanitizeHeader(to);
  // Encode subject as RFC 2047 utf-8 base64 to support non-ASCII safely.
  const encodedSubject = `=?utf-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const fromHeader = safeFromName
    ? `${safeFromName} <${safeFromEmail}>`
    : safeFromEmail;
  const boundary = `vss_${Math.random().toString(36).slice(2, 12)}_${Date.now()}`;

  // multipart/alternative — text first, then html.
  return [
    `From: ${fromHeader}`,
    `To: ${safeTo}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    encodeQuotedPrintable(textBody),
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    encodeQuotedPrintable(htmlBody),
    `--${boundary}--`,
    ``,
  ].join("\r\n");
}

function encodeQuotedPrintable(s: string): string {
  // Minimal quoted-printable: encode non-ASCII bytes and equals signs. Lines
  // longer than 76 chars get soft-broken. Good enough for short HTML/text.
  const bytes = Buffer.from(s, "utf8");
  const out: string[] = [];
  let lineLen = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    let token: string;
    if (b === 0x3d /* = */) {
      token = "=3D";
    } else if (b === 0x0a /* \n */) {
      out.push("\r\n");
      lineLen = 0;
      continue;
    } else if (b === 0x0d /* \r */) {
      continue;
    } else if (b >= 0x20 && b <= 0x7e) {
      token = String.fromCharCode(b);
    } else {
      token = `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    if (lineLen + token.length > 75) {
      out.push("=\r\n");
      lineLen = 0;
    }
    out.push(token);
    lineLen += token.length;
  }
  return out.join("");
}

async function sendViaGmail(input: NotifyEmailInput): Promise<{
  backend: "gmail";
  id: string;
}> {
  const fromEmail = env.GMAIL_IMPERSONATE_USER;
  if (!fromEmail) throw new Error("GMAIL_IMPERSONATE_USER not set");
  const auth = getGmailJwt();
  const gmail = google.gmail({ version: "v1", auth });
  const text =
    input.kind === "approval"
      ? renderApprovalText(input)
      : renderRejectionText(input);
  const html = renderHtml(input, input.kind);
  const subject = subjectFor(input.kind);
  const raw = buildRfc822(
    fromEmail,
    env.GMAIL_FROM_NAME || ADMIN_SIGNATURE,
    input.to,
    subject,
    text,
    html,
  );
  // Gmail API expects base64url-encoded RFC822 bytes.
  const encoded = Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });
  return { backend: "gmail", id: res.data.id ?? "(unknown)" };
}

// ---------------------------------------------------------------------------
// Resend backend (fallback)
// ---------------------------------------------------------------------------

let _resend: Resend | undefined;
function resendClient(): Resend {
  if (!_resend) _resend = new Resend(env.RESEND_API_KEY);
  return _resend;
}

async function sendViaResend(input: NotifyEmailInput): Promise<{
  backend: "resend";
  id: string;
}> {
  const text =
    input.kind === "approval"
      ? renderApprovalText(input)
      : renderRejectionText(input);
  const html = renderHtml(input, input.kind);
  const subject = subjectFor(input.kind);
  const result = await resendClient().emails.send({
    from: env.RESEND_FROM,
    to: input.to,
    subject,
    html,
    text,
  });
  if (result.error) {
    throw new Error(`resend: ${result.error.message ?? "unknown error"}`);
  }
  return { backend: "resend", id: result.data?.id ?? "(unknown)" };
}

// ---------------------------------------------------------------------------
// Public API: dispatch to backend based on env config.
// ---------------------------------------------------------------------------

async function sendEmail(input: NotifyEmailInput): Promise<void> {
  const subject = subjectFor(input.kind);

  const smtpConfigured = Boolean(
    env.GMAIL_SMTP_USER && env.GMAIL_SMTP_PASSWORD,
  );
  const dwdConfigured = Boolean(
    env.GMAIL_IMPERSONATE_USER && env.GOOGLE_SERVICE_ACCOUNT_JSON && !env.DRIVE_MOCK,
  );
  const resendConfigured = Boolean(
    !env.RESEND_MOCK && env.RESEND_API_KEY && env.RESEND_FROM,
  );

  // Always log which path we'll attempt — makes diagnosing "did the email
  // actually try to send?" trivial in the worker terminal.
  logger.info(
    {
      submissionId: input.submissionId,
      kind: input.kind,
      to: input.to,
      smtpConfigured,
      dwdConfigured,
      resendConfigured,
      mockEnabled: env.RESEND_MOCK,
    },
    "email dispatch — picking backend",
  );

  // 1. Gmail SMTP. Used first because it's the only backend that works for
  // consumer @gmail.com sender accounts. If configured AND it fails, we throw
  // — we do NOT silently fall through to mock. BullMQ retries the job up to
  // 5 times; persistent failure leaves the job in the "failed" set.
  if (smtpConfigured) {
    try {
      const out = await sendViaSmtp(input);
      logger.info(
        {
          ...out,
          to: input.to,
          from: env.GMAIL_SMTP_USER,
          subject,
          submissionId: input.submissionId,
        },
        "email sent via gmail smtp",
      );
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          errMessage: message,
          hint: "Common causes: (a) App Password wrong — re-generate at https://myaccount.google.com/apppasswords; (b) 2FA not enabled on the sender account; (c) network blocking outbound 465. Worker was not restarted after pasting GMAIL_SMTP_PASSWORD will also produce auth failures because env is read at startup.",
        },
        "gmail smtp send FAILED — not falling back to other backends",
      );
      throw err;
    }
  }

  // 2. Gmail API via DWD (Workspace only). Tried only if SMTP isn't configured.
  if (dwdConfigured) {
    try {
      const out = await sendViaGmail(input);
      logger.info(
        { ...out, to: input.to, subject, submissionId: input.submissionId },
        "email sent via gmail dwd",
      );
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          errMessage: message,
          hint: "Configure Workspace DWD with gmail.send scope for the service account, OR use GMAIL_SMTP_* with an App Password.",
        },
        "gmail dwd send FAILED — not falling back",
      );
      throw err;
    }
  }

  // 3. Resend.
  if (resendConfigured) {
    try {
      const out = await sendViaResend(input);
      logger.info(
        { ...out, to: input.to, subject, submissionId: input.submissionId },
        "email sent via resend",
      );
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ errMessage: message }, "resend send FAILED");
      throw err;
    }
  }

  // 4. Mock — only if literally no real backend is configured. Without this
  // gate, a misconfigured SMTP/DWD would silently look like success.
  if (env.RESEND_MOCK) {
    logger.warn(
      {
        mock: true,
        kind: input.kind,
        to: input.to,
        subject,
        submissionId: input.submissionId,
        hint: "RESEND_MOCK=true and no other backend configured. NO REAL EMAIL WAS SENT.",
      },
      "email mocked",
    );
    return;
  }

  throw new Error(
    "No email backend configured. Set GMAIL_SMTP_USER+GMAIL_SMTP_PASSWORD (App Password), GMAIL_IMPERSONATE_USER (Workspace DWD), or RESEND_API_KEY+RESEND_FROM. Or set RESEND_MOCK=true to skip sending in dev.",
  );
}

export async function sendApprovalEmail(input: Omit<NotifyEmailInput, "kind">): Promise<void> {
  return sendEmail({ ...input, kind: "approval" });
}

export async function sendRejectionEmail(input: Omit<NotifyEmailInput, "kind">): Promise<void> {
  return sendEmail({ ...input, kind: "rejection" });
}
