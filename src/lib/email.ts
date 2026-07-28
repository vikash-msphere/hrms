import type { EmailSender, EmailAttachment } from "../ports";

// Transactional email providers. Each entry maps the common (from, to, subject, html, attachments) shape onto
// the provider's own HTTP contract. Add a provider by dropping another entry here - nothing else changes.
export type EmailProvider = "resend" | "brevo" | "sendgrid" | "postmark" | "mailgun";

type ProviderRequest = { url: string; headers: Record<string, string>; body: unknown };
type ProviderConfig = {
  // apiKey: the provider secret. from: verified sender ("Name <addr>" or bare address). region: provider-specific
  // (Mailgun sending domain; ignored by the rest). atts: files to attach (may be empty). Builds one request.
  request(apiKey: string, from: string, region: string | undefined, to: string, subject: string, html: string, atts: EmailAttachment[]): ProviderRequest;
};

// Base64-encode bytes without blowing the call stack on large PDFs (btoa over one big binary string can
// overflow the argument list). Chunk the String.fromCharCode calls.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const providers: Record<EmailProvider, ProviderConfig> = {
  resend: {
    request(apiKey, from, _region, to, subject, html, atts) {
      const body: Record<string, unknown> = { from, to, subject, html };
      if (atts.length) body.attachments = atts.map((a) => ({ filename: a.filename, content: toBase64(a.content), content_type: a.contentType }));
      return {
        url: "https://api.resend.com/emails",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
      };
    },
  },
  brevo: {
    request(apiKey, from, _region, to, subject, html, atts) {
      const body: Record<string, unknown> = { sender: parseAddress(from), to: [{ email: to }], subject, htmlContent: html };
      if (atts.length) body.attachment = atts.map((a) => ({ name: a.filename, content: toBase64(a.content) }));
      return {
        url: "https://api.brevo.com/v3/smtp/email",
        headers: { "api-key": apiKey, "Content-Type": "application/json" },
        body,
      };
    },
  },
  sendgrid: {
    request(apiKey, from, _region, to, subject, html, atts) {
      const body: Record<string, unknown> = {
        personalizations: [{ to: [{ email: to }] }],
        from: parseAddress(from),
        subject,
        content: [{ type: "text/html", value: html }],
      };
      if (atts.length) body.attachments = atts.map((a) => ({ filename: a.filename, type: a.contentType, content: toBase64(a.content), disposition: "attachment" }));
      return {
        url: "https://api.sendgrid.com/v3/mail/send",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
      };
    },
  },
  postmark: {
    request(apiKey, from, _region, to, subject, html, atts) {
      const body: Record<string, unknown> = { From: from, To: to, Subject: subject, HtmlBody: html };
      if (atts.length) body.Attachments = atts.map((a) => ({ Name: a.filename, Content: toBase64(a.content), ContentType: a.contentType }));
      return {
        url: "https://api.postmarkapp.com/email",
        headers: { "X-Postmark-Server-Token": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body,
      };
    },
  },
  mailgun: {
    request(apiKey, from, region, to, subject, html, atts) {
      // region here doubles as the Mailgun sending domain; base host is US by default.
      const domain = region || senderDomain(from);
      const headers: Record<string, string> = { Authorization: `Basic ${btoa(`api:${apiKey}`)}` };
      // Attachments need multipart/form-data (a file part); without them keep the simpler urlencoded body.
      // For FormData we must NOT set Content-Type by hand - fetch derives the multipart boundary.
      let body: URLSearchParams | FormData;
      if (atts.length) {
        const form = new FormData();
        form.set("from", from); form.set("to", to); form.set("subject", subject); form.set("html", html);
        for (const a of atts) form.append("attachment", new Blob([a.content as BlobPart], { type: a.contentType }), a.filename);
        body = form;
      } else {
        body = new URLSearchParams({ from, to, subject, html });
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
      return { url: `https://api.mailgun.net/v3/${domain}/messages`, headers, body };
    },
  },
};

// "Display Name <addr@x.com>" -> { name, email }; bare "addr@x.com" -> { email }.
function parseAddress(from: string): { name?: string; email: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || undefined, email: m[2]! };
  return { email: from.trim() };
}

function senderDomain(from: string): string {
  return parseAddress(from).email.split("@")[1] ?? "";
}

export function makeEmailSender(
  provider: EmailProvider,
  apiKey: string,
  from: string,
  region?: string,
): EmailSender {
  const cfg = providers[provider];
  if (!cfg) throw new Error(`unknown email provider: ${provider}`);
  return {
    async send(to, subject, html, attachments) {
      const req = cfg.request(apiKey, from, region, to, subject, html, attachments ?? []);
      // URLSearchParams / FormData ride as-is (fetch sets the right Content-Type); everything else is JSON.
      const body = req.body instanceof URLSearchParams || req.body instanceof FormData ? req.body : JSON.stringify(req.body);
      const res = await fetch(req.url, { method: "POST", headers: req.headers, body });
      if (!res.ok) throw new Error(`email send failed (${provider}): ${res.status} ${await res.text().catch(() => "")}`);
    },
  };
}

export const EMAIL_PROVIDERS = Object.keys(providers) as EmailProvider[];
