import type { EmailSender, EmailAttachment } from "../ports";
import { upstreamFailed } from "./errors";

// Transactional email providers. Each entry maps the common (from, to, subject, html, attachments) shape onto
// the provider's own HTTP contract. Add a provider by dropping another entry here - nothing else changes.
//
// `console` is the exception: it sends nothing and writes a line to the log instead. It exists because every
// other entry here reaches a real vendor with a real key and mails a real person, which is wrong for a
// preview deployment and wrong for the browser suite - `e2e/e2e.vars` selects it so a test run that walks the
// invite/announcement/automation paths end to end still puts no mail on the wire. It is refused for a
// production deploy (`scripts/preflight.ts`); anywhere else it is the safe default to develop against.
export type EmailProvider = "resend" | "brevo" | "sendgrid" | "postmark" | "mailgun" | "console";

// How long one send may hold the invocation. Generous for a vendor accepting a message with attachments, and
// far short of a Worker's own ceiling - see the note in `send` for why this is not optional on the cron path.
const VENDOR_TIMEOUT_MS = 15_000;

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

const providers: Record<Exclude<EmailProvider, "console">, ProviderConfig> = {
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
  /**
   * Divert EVERY message to this one address instead of its real recipient (EMAIL_REDIRECT_TO).
   *
   * For a staging or rehearsal deploy, where `console` is too blunt and a real provider is too sharp. Staging
   * exists to rehearse a release, and the nightly cron is part of what gets rehearsed - so a staging stack
   * pointed at a real vendor with a real verified sender mails real employees, from a real company address,
   * about probation dates and expiring documents in a copy of the database. `console` would prove nothing
   * about whether email works; this proves the whole path (vendor, key, sender, template, attachment) and
   * lands all of it in one inbox.
   *
   * Never set in production: preflight makes that a blocking error, because silently diverting every offer
   * letter and payslip notification to one mailbox is the same failure as `console` wearing a working vendor.
   */
  redirectTo?: string,
): EmailSender {
  // The sink. Nothing leaves the Worker, so nothing needs a key or a verified sender.
  if (provider === "console") {
    return {
      async send(to, subject, _html, attachments) {
        const atts = attachments?.length ? ` +${attachments.length} attachment(s)` : "";
        console.log(`[email:console] would send to ${to}: ${subject}${atts}`);
      },
    };
  }
  const cfg = providers[provider];
  if (!cfg) throw new Error(`unknown email provider: ${provider}`);
  const divert = redirectTo?.trim();
  return {
    async send(to, subject, html, attachments) {
      // The intended recipient rides in the subject rather than being dropped: the whole value of a rehearsal
      // is being able to tell WHO each message would have gone to, and a mailbox of forty identical subjects
      // answers that for nobody.
      const recipient = divert || to;
      const line = divert ? `[to: ${to}] ${subject}` : subject;
      const req = cfg.request(apiKey, from, region, recipient, line, html, attachments ?? []);
      // URLSearchParams / FormData ride as-is (fetch sets the right Content-Type); everything else is JSON.
      const body = req.body instanceof URLSearchParams || req.body instanceof FormData ? req.body : JSON.stringify(req.body);
      // A vendor that is down, rate-limiting us, or holding a rotated key is not this app malfunctioning, and
      // reporting it as one costs an "unhandled error" with a stack in the log and a 500 the caller cannot act
      // on. `upstreamFailed` says which hop failed and carries the vendor's own words, so the operator reads
      // "the mail vendor rejected the key" rather than going looking for a bug here.
      //
      // BOUNDED, like every other outbound call in the app (services/esign/cashfree.ts#vendorFetch, the OAuth
      // code exchange in routes/authRoutes.ts). This was the one that was not, and it is the one on the path
      // that can least afford it: the nightly tick's reminder subtasks and services/emailFanOut.ts send in
      // SEQUENCE, so a provider that accepts the connection and then says nothing holds the whole invocation
      // until the platform kills it - and takes every subtask that had not run yet with it. A timeout turns
      // that into one failed message the existing branch below reports by name.
      let res: Response;
      try {
        res = await fetch(req.url, { method: "POST", headers: req.headers, body, signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS) });
      } catch (e) {
        throw upstreamFailed(`the email provider (${provider}) could not be reached: ${(e as Error).message}`);
      }
      if (!res.ok) throw upstreamFailed(`the email provider (${provider}) refused the message: ${res.status} ${await res.text().catch(() => "")}`);
    },
  };
}

export const EMAIL_PROVIDERS = [...Object.keys(providers), "console"] as EmailProvider[];
